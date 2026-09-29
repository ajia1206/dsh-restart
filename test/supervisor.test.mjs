/** Integration test for the detached supervisor: it really restarts a process. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { appendRecord, readRecords } from '../lib/log.js'
import { probeHealth, processAlive, sleep, waitForExit } from '../lib/proc.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUPERVISOR = join(HERE, '..', 'lib', 'supervisor.mjs')
const EXEC = process.execPath

/** Ask the kernel for a free port, then release it. */
async function freePort() {
  const server = createServer()
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => { server.close(resolve) })
  return port
}

/** A tiny HTTP server whose only job is to hold a port. */
function serverCommand(port) {
  return "require('node:http').createServer((_q,s)=>s.end('ok')).listen(" + port + ",'127.0.0.1')"
}

/**
 * A replacement that serves the port and then reports its own boot record, the
 * way the plugin's host does. It deliberately writes nothing before the port is
 * up, so a boot record always means "this process really is serving".
 * @param port - port to hold.
 * @param logPath - restart log it appends its boot record to.
 * @param cwd - working directory recorded in the boot record.
 */
function bootingServerCommand(port, logPath, cwd) {
  return [
    "const http=require('node:http'),fs=require('node:fs')",
    "http.createServer((_q,s)=>s.end('ok')).listen(" + port + ",'127.0.0.1',()=>{",
    "  fs.appendFileSync(" + JSON.stringify(logPath) + ", JSON.stringify({kind:'boot',at:Date.now(),pid:process.pid,ppid:process.ppid,cwd:" + JSON.stringify(cwd) + "})+'\\n')",
    '})',
  ].join('\n')
}

/** The outcome record of one arm, or null. */
async function outcomeOf(logPath, armId) {
  const records = await readRecords(logPath)
  return records.filter(record => record.kind === 'supervised' && record.armId === armId).pop() ?? null
}

/**
 * Run a supervisor to completion and return its exit code plus its outcome.
 * @param specPath - spec file path.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @param before - optional hook run after the handshake.
 */
async function runSupervisor(specPath, logPath, armId, before) {
  const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
  if (before) await before()
  const exited = await waitForExit(supervisor.pid, { timeoutMs: 60000, intervalMs: 100 })
  assert.equal(exited, true, 'the supervisor should finish on its own')
  return outcomeOf(logPath, armId)
}

/**
 * Wait for a record of the given kind and arm.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @param kind - record kind.
 * @param timeoutMs - bound.
 */
async function waitForRecord(logPath, armId, kind, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = await readRecords(logPath)
    if (records.some(record => record.kind === kind && record.armId === armId)) return true
    await sleep(100)
  }
  return false
}

/**
 * Wait for a boot record of the given kind (the supervisor-ready marker has no
 * arm id of its own).
 * @param logPath - restart log path.
 * @param kind - record kind.
 * @param timeoutMs - bound.
 */
async function waitForKind(logPath, kind, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = await readRecords(logPath)
    if (records.some(record => record.kind === kind)) return true
    await sleep(100)
  }
  return false
}

/**
 * Wait for a file to disappear.
 * @param path - file path.
 * @param timeoutMs - bound.
 */
async function waitForRemoval(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
    } catch {
      return true
    }
    await sleep(100)
  }
  return false
}

test('the supervisor waits for the old pid, restarts it and health-checks it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  const outLogPath = join(dir, 'child.log')
  let replacementPid = null
  let old = null
  try {
    const source = serverCommand(port)
    old = spawn(EXEC, ['-e', source], { stdio: 'ignore' })
    const up = await probeHealth('http://127.0.0.1:' + port + '/', {
      timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500,
    })
    assert.equal(up.ok, true, 'the first server should come up')

    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-arm',
      oldPid: old.pid,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', bootingServerCommand(port, logPath, dir)] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 15000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath,
      logPath,
    }), 'utf8')

    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })

    // The supervisor must be waiting on the old pid before we stop it.
    assert.equal(await waitForRecord(logPath, 'test-arm', 'supervisor'), true,
      'the supervisor should record its handshake first')
    // Recovery resources are preflighted before the host is allowed to leave.
    assert.equal(await waitForKind(logPath, 'supervisor-ready'), true,
      'the supervisor should preflight the child log before waiting for the exit')
    // The spec is consumed, not kept: it can carry credential-style arguments.
    assert.equal(await waitForRemoval(specPath), true, 'the spec file should be deleted after being read')

    old.kill('SIGTERM')
    const supervisorExit = await waitForExit(supervisor.pid, { timeoutMs: 25000, intervalMs: 200 })
    assert.equal(supervisorExit, true, 'the supervisor should finish on its own')
    assert.equal(processAlive(old.pid), false, 'the old process should be gone')

    const outcome = await outcomeOf(logPath, 'test-arm')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.ok, true, 'outcome should be ok: ' + JSON.stringify(outcome))
    assert.equal(outcome.armId, 'test-arm')
    assert.equal(outcome.portReleased, true, 'the old port must have been observed released')
    assert.equal(outcome.bootMatched, true, 'the replacement boot record must have been matched')
    replacementPid = outcome.newPid
    assert.ok(replacementPid && replacementPid !== old.pid, 'the replacement should be a new pid')
    assert.equal(processAlive(replacementPid), true, 'the replacement should be alive')

    const back = await probeHealth('http://127.0.0.1:' + port + '/', {
      timeoutMs: 5000, intervalMs: 100, requestTimeoutMs: 500,
    })
    assert.equal(back.ok, true, 'the replacement should serve the port again')
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('the supervisor records a failure when the replacement never serves the port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  let old = null
  try {
    old = spawn(EXEC, ['-e', serverCommand(port)], { stdio: 'ignore' })
    await probeHealth('http://127.0.0.1:' + port + '/', { timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500 })

    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-fail',
      oldPid: old.pid,
      cwd: dir,
      // The replacement starts and exits immediately, so the port never returns.
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'process.exit(0)'] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 3000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
    old.kill('SIGTERM')
    await waitForExit(supervisor.pid, { timeoutMs: 25000, intervalMs: 200 })

    const outcome = await outcomeOf(logPath, 'test-fail')
    assert.ok(outcome)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.armId, 'test-fail')
    assert.ok(outcome.error.length > 0, 'a failure must carry a reason')
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a replacement that never writes its boot record is not reported as a success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  let old = null
  let replacementPid = null
  try {
    old = spawn(EXEC, ['-e', serverCommand(port)], { stdio: 'ignore' })
    await probeHealth('http://127.0.0.1:' + port + '/', { timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500 })

    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-noboot',
      oldPid: old.pid,
      cwd: dir,
      // This one serves the port but never announces itself in the log.
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', serverCommand(port)] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 3000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    old.kill('SIGTERM')
    const outcome = await runSupervisor(specPath, logPath, 'test-noboot')

    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.portReleased, true, 'the port was genuinely released')
    assert.equal(outcome.bootMatched, false, 'no boot record carried the replacement pid')
    assert.equal(outcome.ok, false, 'an unverifiable replacement must not be ok: ' + JSON.stringify(outcome))
    assert.match(outcome.error, /boot/, 'the reason must name the missing boot record')
    assert.ok(outcome.error.length > 0)
    replacementPid = outcome.newPid
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unhandled spawn error is recorded instead of crashing the supervisor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  let old = null
  try {
    old = spawn(EXEC, ['-e', serverCommand(port)], { stdio: 'ignore' })
    await probeHealth('http://127.0.0.1:' + port + '/', { timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500 })

    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-spawn',
      oldPid: old.pid,
      cwd: dir,
      // The executable does not exist: spawn reports that asynchronously.
      command: { execPath: join(dir, 'no-such-executable'), execArgv: [], scriptPath: '', args: [] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 2000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    old.kill('SIGTERM')
    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
    const supervisorExit = await waitForExit(supervisor.pid, { timeoutMs: 25000, intervalMs: 100 })

    assert.equal(supervisorExit, true, 'the supervisor must never hang or crash on a spawn error')
    assert.equal(supervisor.exitCode, 1, 'the supervisor must exit with a non-zero code')
    const outcome = await outcomeOf(logPath, 'test-spawn')
    assert.ok(outcome, 'a spawn failure must still be recorded')
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /无法|失败/, 'the reason must be readable: ' + outcome.error)
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unusable child-log directory is preflighted before the host is allowed to exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  // A file where the child log's parent directory should be: mkdir fails with
  // ENOTDIR/EEXIST, which is exactly the "host would go down for nothing" case.
  const blocker = join(dir, 'blocked')
  await writeFile(blocker, 'not a directory', 'utf8')
  const old = spawn(EXEC, ['-e', serverCommand(port)], { stdio: 'ignore' })
  try {
    await probeHealth('http://127.0.0.1:' + port + '/', { timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500 })

    // Named the way the plugin names it, so the failure can be reported even
    // if the spec itself becomes unreadable.
    const specPath = join(dir, 'dsh-restart-spec-test-preflight.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-preflight',
      oldPid: old.pid,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', serverCommand(port)] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 2000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath: join(blocker, 'child.log'),
      logPath,
    }), 'utf8')

    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
    const supervisorExit = await waitForExit(supervisor.pid, { timeoutMs: 25000, intervalMs: 100 })
    assert.equal(supervisorExit, true, 'the supervisor should finish on its own')
    assert.equal(supervisor.exitCode, 1)

    const outcome = await outcomeOf(logPath, 'test-preflight')
    assert.ok(outcome, 'the preflight failure must be recorded')
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /out-log-unwritable/, 'the reason must name the unusable resource: ' + outcome.error)
    // The host is still running: a usable-exit abort is still possible.
    assert.equal(processAlive(old.pid), true, 'the host must be spared when recovery resources are unusable')
  } finally {
    if (processAlive(old.pid)) old.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a replacement that never lets go of the port cannot be called a success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const port = await freePort()
  const logPath = join(dir, 'restart.log')
  const outLogPath = join(dir, 'child.log')
  let old = null
  let replacementPid = null
  try {
    old = spawn(EXEC, ['-e', serverCommand(port)], { stdio: 'ignore' })
    await probeHealth('http://127.0.0.1:' + port + '/', { timeoutMs: 8000, intervalMs: 100, requestTimeoutMs: 500 })

    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-held',
      // A pid that does not exist: the supervisor does not wait, and the port
      // is still held when it starts looking for a release.
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', serverCommand(port)] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 2000,
      healthIntervalMs: 200,
      exitTimeoutMs: 500,
      outLogPath,
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'test-held')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.portReleased, false, 'the port never stopped answering')
    assert.equal(outcome.bootMatched, false)
    assert.equal(outcome.ok, false, 'a port that never went down must not be reported as success: ' + JSON.stringify(outcome))
    assert.match(outcome.error, /端口/, 'the reason must explain the port: ' + outcome.error)
    replacementPid = outcome.newPid
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty health URL is reported as "nothing to probe" rather than a silent failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const specPath = join(dir, 'spec.json')
  try {
    await writeFile(specPath, JSON.stringify({
      armId: 'test-nourl',
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'process.exit(0)'] },
      healthUrl: '',
      healthTimeoutMs: 1000,
      healthIntervalMs: 100,
      exitTimeoutMs: 500,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'test-nourl')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.portReleased, false)
    assert.match(outcome.error, /端点/, 'the reason must say there is no endpoint: ' + outcome.error)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('spawn 的异步错误不会以未捕获异常终止 supervisor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  let old = null
  try {
    await appendRecord(logPath, { kind: 'supervisor', at: Date.now(), armId: 'test-crash', oldPid: 0x7ffffff0 })
    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify({
      armId: 'test-crash',
      oldPid: 0x7ffffff0,
      cwd: dir,
      // The cwd does not exist: the error is emitted asynchronously.
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'process.exit(0)'] },
      healthUrl: 'http://127.0.0.1:1/',
      healthTimeoutMs: 500,
      healthIntervalMs: 100,
      exitTimeoutMs: 500,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')
    old = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
    assert.equal(await waitForExit(old.pid, { timeoutMs: 25000, intervalMs: 100 }), true)
    assert.equal(old.exitCode, 1, 'a fatal failure must exit non-zero, not crash with a signal')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a writable child-log directory is created when it does not exist yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const specPath = join(dir, 'spec.json')
  try {
    await writeFile(specPath, JSON.stringify({
      armId: 'test-mkdir',
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'process.exit(0)'] },
      healthUrl: 'http://127.0.0.1:1/',
      healthTimeoutMs: 300,
      healthIntervalMs: 100,
      exitTimeoutMs: 300,
      outLogPath: join(dir, 'nested', 'deeper', 'child.log'),
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'test-mkdir')
    assert.ok(outcome, 'the supervisor should record an outcome')
    // The preflight succeeded, so the failure that follows is about the port.
    assert.equal(outcome.portReleased, true, 'nothing answers on port 1, so the port counts as released')
    await access(join(dir, 'nested', 'deeper', 'child.log'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a torn spec is removed and never reported against a guessed log file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  // Named the way the plugin names it, so a wrong "next to the spec" fallback
  // would have a file to land in and the test could not tell the difference.
  const specPath = join(dir, 'dsh-restart-spec-arm-torn.json')
  const logPath = join(dir, 'dsh-restart.log')
  try {
    await writeFile(specPath, '{ this is not json', 'utf8')
    await chmod(specPath, 0o600)
    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })
    assert.equal(await waitForExit(supervisor.pid, { timeoutMs: 20000, intervalMs: 100 }), true)
    assert.equal(supervisor.exitCode, 1)
    await assert.rejects(access(specPath), 'the unreadable spec must still be removed')
    // Nothing identified a log, so nothing may be invented: an outcome written
    // next to the spec would be invisible to the plugin polling its own log.
    await assert.rejects(access(logPath), 'no log may be guessed from the spec filename')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a post-handshake failure is reported to the configured log, not a guessed one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'custom-restart.log')
  const specPath = join(dir, 'dsh-restart-spec-arm-custom.json')
  try {
    // A cwd that cannot exist makes the spawn fail only after the handshake,
    // i.e. after the spec has been deleted.
    await writeFile(specPath, JSON.stringify({
      armId: 'arm-custom',
      oldPid: 0x7ffffff0,
      cwd: join(dir, 'gone'),
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'process.exit(0)'] },
      healthUrl: 'http://127.0.0.1:1/',
      healthTimeoutMs: 500,
      healthIntervalMs: 100,
      exitTimeoutMs: 500,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'arm-custom')
    assert.ok(outcome, 'the failure must land in the configured log')
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /spawn-failed/, 'the reason must name the failed launch: ' + outcome.error)
    // The fallback name must stay empty: reporting to it would hide the failure.
    await assert.rejects(access(join(dir, 'dsh-restart.log')), 'no log may be guessed from the spec filename')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
