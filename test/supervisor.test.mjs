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
 * A replacement for a headless host: it writes its own boot record and then
 * stays alive. No port is involved, so that record is the only hard evidence.
 * @param logPath - restart log it appends its boot record to.
 * @param cwd - working directory recorded in the boot record.
 */
function bootingHeadlessCommand(logPath, cwd) {
  return [
    "const fs=require('node:fs')",
    'fs.appendFileSync(' + JSON.stringify(logPath) + ", JSON.stringify({kind:'boot',at:Date.now(),pid:process.pid,ppid:process.ppid,cwd:" + JSON.stringify(cwd) + "})+'\\n')",
    'setInterval(()=>{},1000)',
  ].join('\n')
}

/**
 * A replacement whose only job is to prove whether it was started at all.
 * @param markerPath - file it creates on start.
 */
function markerCommand(markerPath) {
  return "require('node:fs').writeFileSync(" + JSON.stringify(markerPath) + ",'started')"
}

/**
 * Record the host's own exit commitment, the way the plugin does after the
 * handshake. The supervisor refuses to relaunch without it.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @param pid - the host pid.
 */
async function commitExit(logPath, armId, pid) {
  await appendRecord(logPath, { kind: 'exiting', at: Date.now(), armId, pid })
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

    // The host commits its exit only after the handshake and the preflight.
    await commitExit(logPath, 'test-arm', old.pid)
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
    await commitExit(logPath, 'test-fail', old.pid)
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

    await commitExit(logPath, 'test-noboot', old.pid)
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
    await commitExit(logPath, 'test-spawn', old.pid)
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

test('a port that keeps answering is recorded honestly but must not stop the relaunch', async () => {
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
      downTimeoutMs: 800,
      outLogPath,
      logPath,
    }), 'utf8')

    await commitExit(logPath, 'test-held', 0x7ffffff0)
    const outcome = await runSupervisor(specPath, logPath, 'test-held')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.portReleased, false, 'the port never stopped accepting connections')
    assert.equal(outcome.bootMatched, false)
    assert.equal(outcome.ok, false, 'a port that never went down must not be reported as success: ' + JSON.stringify(outcome))
    assert.match(outcome.error, /端口/, 'the reason must explain the port: ' + outcome.error)
    assert.match(outcome.error, /拉起/, 'the reason must admit the relaunch was attempted: ' + outcome.error)
    // The relaunch really happened even though the evidence was bad.
    replacementPid = outcome.newPid
    assert.ok(Number.isInteger(replacementPid), 'the replacement must have been started: ' + JSON.stringify(outcome))
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty health URL still relaunches the host and is judged on the boot record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const outLogPath = join(dir, 'child.log')
  const specPath = join(dir, 'spec.json')
  let replacementPid = null
  try {
    await writeFile(specPath, JSON.stringify({
      armId: 'test-nourl',
      // The host is already gone; headless means there is no endpoint at all.
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', bootingHeadlessCommand(logPath, dir)] },
      healthUrl: '',
      healthTimeoutMs: 6000,
      healthIntervalMs: 100,
      exitTimeoutMs: 500,
      outLogPath,
      logPath,
    }), 'utf8')

    await commitExit(logPath, 'test-nourl', 0x7ffffff0)
    const outcome = await runSupervisor(specPath, logPath, 'test-nourl')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.portReleased, null, 'no endpoint means null, never "not released": ' + JSON.stringify(outcome))
    assert.equal(outcome.bootMatched, true, 'the headless replacement did write its own boot record')
    assert.equal(outcome.ok, true, 'a headless host must not be a recorded failure when the replacement boots: ' + JSON.stringify(outcome))
    replacementPid = outcome.newPid
    assert.ok(Number.isInteger(replacementPid), 'the replacement must have been started: ' + JSON.stringify(outcome))
    assert.equal(processAlive(replacementPid), true, 'the headless replacement should still be running')
    const records = await readRecords(logPath)
    assert.ok(records.some(record => record.kind === 'boot' && record.pid === replacementPid),
      'the log must carry the replacement own boot record')
    assert.match(outcome.notes, /没有可观测端点/, 'the record must say there was nothing to observe: ' + outcome.notes)
  } finally {
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a headless replacement that writes no boot record is reported as unverifiable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const specPath = join(dir, 'spec.json')
  let replacementPid = null
  try {
    await writeFile(specPath, JSON.stringify({
      armId: 'test-nourl-noboot',
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', 'setInterval(()=>{},1000)'] },
      healthUrl: '',
      healthTimeoutMs: 600,
      healthIntervalMs: 100,
      exitTimeoutMs: 500,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    await commitExit(logPath, 'test-nourl-noboot', 0x7ffffff0)
    const outcome = await runSupervisor(specPath, logPath, 'test-nourl-noboot')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.portReleased, null, 'no endpoint means null: ' + JSON.stringify(outcome))
    assert.equal(outcome.bootMatched, false)
    assert.equal(outcome.ok, false, 'without any hard evidence this must not be a success')
    assert.match(outcome.error, /没有可观测端点/, 'the reason must say there was no endpoint: ' + outcome.error)
    assert.match(outcome.error, /boot/, 'the reason must name the missing boot record: ' + outcome.error)
    replacementPid = outcome.newPid
    assert.ok(Number.isInteger(replacementPid), 'the replacement was still started: ' + JSON.stringify(outcome))
  } finally {
    if (replacementPid !== null && processAlive(replacementPid)) process.kill(replacementPid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('spawn 的异步错误不会以未捕获异常终止 supervisor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  let old = null
  try {
    await appendRecord(logPath, { kind: 'supervisor', at: Date.now(), armId: 'test-crash', oldPid: 0x7ffffff0 })
    await commitExit(logPath, 'test-crash', 0x7ffffff0)
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

    await commitExit(logPath, 'test-mkdir', 0x7ffffff0)
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

    await commitExit(logPath, 'arm-custom', 0x7ffffff0)
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

test('the boot matcher requires the replacement own pid, not just any boot', async () => {
  const { buildBootMatcher, buildReplacementBootMatcher } = await import('../lib/supervisor.mjs')
  const stale = { kind: 'boot', pid: 111, cwd: '/w' }
  const fresh = { kind: 'boot', pid: 222, cwd: '/w' }
  // The shape matcher alone accepts both — which is exactly why the pid must
  // be part of the predicate: cwd is identical across restarts.
  assert.equal(buildBootMatcher('/w')(stale), true)
  assert.equal(buildBootMatcher('/w')(fresh), true)
  assert.equal(buildReplacementBootMatcher('/w', 222)(stale), false)
  assert.equal(buildReplacementBootMatcher('/w', 222)(fresh), true)
  // A record from another working directory is never this replacement.
  assert.equal(buildReplacementBootMatcher('/w', 222)({ kind: 'boot', pid: 222, cwd: '/other' }), false)
})

test('a stale boot record from an earlier run cannot satisfy bootMatched', async () => {
  const { buildReplacementBootMatcher, waitForBootRecord } = await import('../lib/supervisor.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'dsr-stale-'))
  try {
    const logPath = join(dir, 'restart.log')
    // An earlier restart already left a boot record with the same cwd in this
    // log. The new replacement (pid 999) never writes one.
    await appendRecord(logPath, { kind: 'boot', at: 1000, pid: 111, cwd: dir, profile: 'web' })
    await appendRecord(logPath, { kind: 'armed', at: 2000, armId: 'A', pid: 111 })
    await appendRecord(logPath, { kind: 'exiting', at: 3000, armId: 'A', pid: 111 })
    const matched = await waitForBootRecord(logPath, buildReplacementBootMatcher(dir, 999), {
      timeoutMs: 600, intervalMs: 50, excluded: [111, process.pid],
    })
    assert.equal(matched, false, '旧运行的 boot 记录不得当成新进程已就绪')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without an exiting commitment the supervisor must not relaunch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const marker = join(dir, 'started.marker')
  const specPath = join(dir, 'spec.json')
  try {
    await writeFile(specPath, JSON.stringify({
      armId: 'test-nocommit',
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', markerCommand(marker)] },
      healthUrl: '',
      healthTimeoutMs: 600,
      healthIntervalMs: 100,
      exitTimeoutMs: 300,
      exitCommitTimeoutMs: 700,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'test-nocommit')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.ok, false, 'the host never committed an exit')
    assert.equal(outcome.newPid, null, 'nothing may be started: ' + JSON.stringify(outcome))
    assert.equal(outcome.portReleased, null, 'there was no endpoint to observe')
    assert.match(outcome.error, /exiting/, 'the reason must name the missing commitment: ' + outcome.error)
    await assert.rejects(access(marker), 'the replacement must never have been started')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an aborted arm is recorded as cancelled and never relaunched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-sup-'))
  const logPath = join(dir, 'restart.log')
  const marker = join(dir, 'started.marker')
  const specPath = join(dir, 'spec.json')
  try {
    // The host gave up on the exit after the handshake timed out, and it is
    // still running: relaunching would only add a duplicate instance.
    await appendRecord(logPath, { kind: 'armed', at: Date.now(), armId: 'test-aborted', pid: 0x7ffffff0 })
    await appendRecord(logPath, { kind: 'aborted', at: Date.now(), armId: 'test-aborted', reason: 'handshake timeout' })
    await writeFile(specPath, JSON.stringify({
      armId: 'test-aborted',
      oldPid: 0x7ffffff0,
      cwd: dir,
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', markerCommand(marker)] },
      healthUrl: 'http://127.0.0.1:1/',
      healthTimeoutMs: 600,
      healthIntervalMs: 100,
      exitTimeoutMs: 300,
      exitCommitTimeoutMs: 700,
      outLogPath: join(dir, 'child.log'),
      logPath,
    }), 'utf8')

    const outcome = await runSupervisor(specPath, logPath, 'test-aborted')
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.newPid, null, 'nothing may be started: ' + JSON.stringify(outcome))
    assert.match(outcome.error, /aborted/, 'the reason must name the cancellation: ' + outcome.error)
    await assert.rejects(access(marker), 'the replacement must never have been started')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('waitForExitCommit reads this arm commitment and nothing else', async () => {
  const { waitForExitCommit } = await import('../lib/supervisor.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'dsr-commit-'))
  try {
    const logPath = join(dir, 'restart.log')
    assert.equal(await waitForExitCommit(logPath, 'A', { timeoutMs: 150, intervalMs: 50 }), null,
      'an empty log is not a commitment')
    await appendRecord(logPath, { kind: 'cancelled', at: Date.now(), armId: 'B' })
    assert.equal(await waitForExitCommit(logPath, 'A', { timeoutMs: 150, intervalMs: 50 }), null,
      'another arm record must not count')
    await appendRecord(logPath, { kind: 'aborted', at: Date.now(), armId: 'A' })
    assert.equal(await waitForExitCommit(logPath, 'A', { timeoutMs: 300, intervalMs: 50 }), 'aborted')
    await appendRecord(logPath, { kind: 'exiting', at: Date.now(), armId: 'A' })
    assert.equal(await waitForExitCommit(logPath, 'A', { timeoutMs: 300, intervalMs: 50 }), 'exiting',
      'a real commitment wins even after an earlier abort')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isPortClosed decides port release at the socket layer', async () => {
  const { isPortClosed, parseHealthEndpoint } = await import('../lib/supervisor.mjs')
  // A listener that only fails still holds the port: HTTP 5xx is not a release.
  const server = createServer((_request, response) => { response.statusCode = 503; response.end('down') })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  try {
    assert.equal(await isPortClosed('127.0.0.1', port, { timeoutMs: 500 }), false,
      'a live 503 listener must never be read as a released port')
    assert.equal(await isPortClosed('127.0.0.1', await freePort(), { timeoutMs: 500 }), true,
      'a refused connection means the port is free')
  } finally {
    await new Promise(resolve => { server.close(resolve) })
  }
  assert.equal(await isPortClosed('127.0.0.1', port, { timeoutMs: 500 }), true,
    'the port must count as released once the listener is gone')

  assert.deepEqual(parseHealthEndpoint(''), { ok: false, kind: 'missing', error: '', host: '', port: 0 })
  const invalid = parseHealthEndpoint('definitely not a url')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.kind, 'invalid')
  assert.ok(invalid.error.length > 0, 'an unparseable URL must carry an explanation instead of throwing')
  assert.deepEqual(parseHealthEndpoint('http://127.0.0.1:3799/health'),
    { ok: true, kind: 'observable', host: '127.0.0.1', port: 3799 })
  assert.deepEqual(parseHealthEndpoint('http://127.0.0.1/'),
    { ok: true, kind: 'observable', host: '127.0.0.1', port: 80 })
})
