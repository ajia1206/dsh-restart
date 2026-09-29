/** Integration test for the detached supervisor: it really restarts a process. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readRecords } from '../lib/log.js'
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
      command: { execPath: EXEC, execArgv: [], scriptPath: '', args: ['-e', source] },
      healthUrl: 'http://127.0.0.1:' + port + '/',
      healthTimeoutMs: 15000,
      healthIntervalMs: 200,
      exitTimeoutMs: 10000,
      outLogPath,
      logPath,
    }), 'utf8')

    const supervisor = spawn(EXEC, [SUPERVISOR, specPath], { stdio: 'ignore' })

    // The supervisor must be waiting on the old pid before we stop it.
    const handshakeDeadline = Date.now() + 8000
    let handshake = false
    while (Date.now() < handshakeDeadline && !handshake) {
      const records = await readRecords(logPath)
      handshake = records.some(record => record.kind === 'supervisor' && record.armId === 'test-arm')
      if (!handshake) await sleep(100)
    }
    assert.equal(handshake, true, 'the supervisor should record its handshake first')

    old.kill('SIGTERM')
    const supervisorExit = await waitForExit(supervisor.pid, { timeoutMs: 25000, intervalMs: 200 })
    assert.equal(supervisorExit, true, 'the supervisor should finish on its own')
    assert.equal(processAlive(old.pid), false, 'the old process should be gone')

    const records = await readRecords(logPath)
    const outcome = records.filter(record => record.kind === 'supervised').pop()
    assert.ok(outcome, 'the supervisor should record an outcome')
    assert.equal(outcome.ok, true, 'outcome should be ok: ' + JSON.stringify(outcome))
    assert.equal(outcome.armId, 'test-arm')
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

    const records = await readRecords(logPath)
    const outcome = records.filter(record => record.kind === 'supervised').pop()
    assert.ok(outcome)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.armId, 'test-fail')
    assert.ok(outcome.error.length > 0, 'a failure must carry a reason')
  } finally {
    if (old !== null && processAlive(old.pid)) old.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
