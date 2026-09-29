/** Unit tests for the restart log and its history view. */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendRecord, buildHistory, readRecords } from '../lib/log.js'

test('appendRecord and readRecords round-trip JSONL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-'))
  try {
    const logPath = join(dir, 'nested', 'restart.log')
    await appendRecord(logPath, { kind: 'boot', at: 1, pid: 10 })
    await appendRecord(logPath, { kind: 'armed', at: 2, pid: 10, reason: '装了插件' })
    const records = await readRecords(logPath)
    assert.equal(records.length, 2)
    assert.equal(records[1].reason, '装了插件')
    assert.deepEqual(await readRecords(join(dir, 'missing.log')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readRecords skips a torn trailing line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-'))
  try {
    const logPath = join(dir, 'restart.log')
    await writeFile(logPath, '{"kind":"boot","at":1}\n{"kind":"armed","at":2}\n{"kind":"exi', 'utf8')
    const records = await readRecords(logPath)
    assert.deepEqual(records.map(record => record.kind), ['boot', 'armed'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an armed then exiting then boot sequence is one completed restart', () => {
  const history = buildHistory([
    { kind: 'boot', at: 1000, pid: 10, mode: 'launchd' },
    { kind: 'armed', at: 5000, pid: 10, reason: '装 dsh-restart' },
    { kind: 'exiting', at: 15000, pid: 10 },
    { kind: 'boot', at: 18300, pid: 20, mode: 'launchd' },
  ])
  assert.equal(history.restarts.length, 1)
  assert.equal(history.restarts[0].pid, 20)
  assert.equal(history.restarts[0].downtimeMs, 3300)
  assert.equal(history.restarts[0].restartedFrom.reason, '装 dsh-restart')
  assert.equal(history.lastBoot.pid, 20)
  assert.equal(history.previousBoot.pid, 10)
})

test('a crash without an armed record is not reported as a restart', () => {
  const history = buildHistory([
    { kind: 'boot', at: 1000, pid: 10 },
    { kind: 'boot', at: 2000, pid: 20 },
  ])
  assert.deepEqual(history.restarts, [])
  assert.equal(history.lastBoot.pid, 20)
})

test('an armed restart that never exited is not reported as completed', () => {
  const history = buildHistory([
    { kind: 'boot', at: 1000, pid: 10 },
    { kind: 'armed', at: 2000, pid: 10, reason: 'x' },
    { kind: 'boot', at: 3000, pid: 20 },
  ])
  assert.deepEqual(history.restarts, [])
})

test('a cancelled arm is cleared and cannot be counted later', () => {
  const history = buildHistory([
    { kind: 'armed', at: 2000, pid: 10, reason: 'x' },
    { kind: 'cancelled', at: 2500, pid: 10 },
    { kind: 'exiting', at: 3000, pid: 10 },
    { kind: 'boot', at: 3500, pid: 20 },
  ])
  assert.deepEqual(history.restarts, [])
  assert.equal(history.lastAbort.kind, 'cancelled')
})

test('history keeps the last N restarts and the newest abort', () => {
  const records = []
  for (let index = 0; index < 8; index += 1) {
    records.push({ kind: 'armed', at: index * 100 + 1, pid: 1, reason: 'r' + index })
    records.push({ kind: 'exiting', at: index * 100 + 2, pid: 1 })
    records.push({ kind: 'boot', at: index * 100 + 10, pid: index + 2 })
  }
  records.push({ kind: 'aborted', at: 9999, reason: '握手失败' })
  const history = buildHistory(records, 3)
  assert.equal(history.restarts.length, 3)
  assert.equal(history.restarts[2].restartedFrom.reason, 'r7')
  assert.equal(history.lastAbort.reason, '握手失败')
})

test('records from another arm or another profile are never paired together', () => {
  // A profile shares the default log with every other profile: arm A, exit B
  // and a stranger's boot must not be stitched into a "completed restart".
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web', reason: 'x' },
    { kind: 'exiting', at: 2000, armId: 'B', pid: 99, profile: 'cli' },
    { kind: 'boot', at: 3000, pid: 20, profile: 'some-other-profile' },
  ])
  assert.deepEqual(history.restarts, [])
  assert.equal(history.lastBoot.pid, 20)
  assert.equal(history.lastBoot.restartedFrom, null)
})

test('a boot in the same process does not complete a restart', () => {
  // A hot-mounted plugin writes a boot from the running process; the pid did
  // not change, so nothing actually came back.
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10 },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10 },
    { kind: 'boot', at: 2500, pid: 10 },
  ])
  assert.deepEqual(history.restarts, [])
})

test('a matching armId with a new pid is still a completed restart', () => {
  // launchd has no outcome record, so the boot itself is the completion.
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, reason: 'ok', strategy: 'launchd' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10 },
    { kind: 'boot', at: 3200, pid: 20, profile: 'web' },
  ])
  assert.equal(history.restarts.length, 1)
  assert.equal(history.restarts[0].restartedFrom.armId, 'A')
  assert.equal(history.restarts[0].restartedFrom.strategy, 'launchd')
  assert.equal(history.restarts[0].downtimeMs, 1200)
})

test('a failed supervised record is not reported as a completed restart', () => {
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10 },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10 },
    { kind: 'supervised', at: 4000, armId: 'A', ok: false, error: '新进程没起来' },
    { kind: 'boot', at: 5000, pid: 20 },
  ])
  assert.deepEqual(history.restarts, [])
  assert.equal(history.lastBoot.supervisedFailed, true)
  assert.equal(history.lastSupervised.ok, false)
})

test('an aborted arm belonging to another armId does not clear this one', () => {
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10 },
    { kind: 'aborted', at: 1500, armId: 'B', reason: '别人的握手失败' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10 },
    { kind: 'boot', at: 3000, pid: 20 },
  ])
  assert.equal(history.restarts.length, 1)
})

test('appendRecord closes a torn final line instead of swallowing the next record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-'))
  try {
    const logPath = join(dir, 'restart.log')
    // A crash left the last record half-written, with no trailing newline.
    await writeFile(logPath, '{"kind":"boot","at":1}\n{"kind":"exi', 'utf8')
    await appendRecord(logPath, { kind: 'armed', at: 2, pid: 10 })
    const records = await readRecords(logPath)
    // The torn line is still unreadable, but the new record survives.
    assert.deepEqual(records.map(record => record.kind), ['boot', 'armed'])
    assert.equal(records[1].at, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readRecords ignores valid JSON that is not a record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-'))
  try {
    const logPath = join(dir, 'restart.log')
    await writeFile(logPath, 'null\n42\n[]\n{"kind":"boot","at":1}\n', 'utf8')
    const records = await readRecords(logPath)
    assert.deepEqual(records.map(record => record.kind), ['boot'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readRecords still finds recent records in a log larger than the read window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-'))
  try {
    const logPath = join(dir, 'restart.log')
    const filler = 'x'.repeat(1024)
    const lines = []
    for (let index = 0; index < 700; index += 1) {
      lines.push(JSON.stringify({ kind: 'noise', at: index, pad: filler }))
    }
    lines.push(JSON.stringify({ kind: 'boot', at: 999999, pid: 20 }))
    await writeFile(logPath, lines.join('\n') + '\n', 'utf8')
    const records = await readRecords(logPath, 10)
    assert.equal(records[records.length - 1].kind, 'boot')
    assert.equal(records[records.length - 1].pid, 20)
    assert.ok(records.length <= 10)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a supervised record pins the replacement pid and rejects other boots', () => {
  // The supervisor recorded that IT started pid 12. A boot from pid 11 is not
  // this restart's replacement, however plausible it looks.
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'boot', at: 2500, pid: 11, profile: 'web' },
    { kind: 'supervised', at: 3000, armId: 'A', ok: true, newPid: 12 },
    { kind: 'boot', at: 3500, pid: 12, profile: 'web' },
  ])
  assert.equal(history.restarts.length, 1)
  assert.equal(history.restarts[0].pid, 12)
})

test('an exiting record for a different pid does not complete the arm', () => {
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web' },
    // Same armId, but this is some other process's exit.
    { kind: 'exiting', at: 2000, armId: 'A', pid: 77, profile: 'web' },
    { kind: 'boot', at: 3000, pid: 20, profile: 'web' },
  ])
  assert.deepEqual(history.restarts, [])
})

test('a foreign-profile boot neither completes the arm nor erases it', () => {
  // Another profile shares this log and boots between our exit and our real
  // replacement. That must not cost us the real restart.
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'boot', at: 2500, pid: 30, profile: 'cli' },
    { kind: 'boot', at: 4000, pid: 20, profile: 'web' },
  ])
  assert.equal(history.restarts.length, 1)
  assert.equal(history.restarts[0].pid, 20)
  assert.equal(history.restarts[0].restartedFrom.armId, 'A')
})

test('a supervisor-strategy arm needs the supervisor outcome before it counts', () => {
  // No supervised record: a same-profile boot from something else must not be
  // credited as this restart.
  const withoutOutcome = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web', strategy: 'supervisor' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'boot', at: 3000, pid: 11, profile: 'web' },
  ])
  assert.deepEqual(withoutOutcome.restarts, [])

  // The same sequence WITH a successful outcome is a real restart.
  const withOutcome = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web', strategy: 'supervisor' },
    { kind: 'exiting', at: 2000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'boot', at: 3000, pid: 11, profile: 'web' },
    { kind: 'supervised', at: 3500, armId: 'A', ok: true, newPid: 11 },
  ])
  assert.equal(withOutcome.restarts.length, 1)
  assert.equal(withOutcome.restarts[0].pid, 11)
})

test('a boot dated before the exit is not this restart', () => {
  const history = buildHistory([
    { kind: 'armed', at: 1000, armId: 'A', pid: 10, profile: 'web', strategy: 'launchd' },
    { kind: 'exiting', at: 5000, armId: 'A', pid: 10, profile: 'web' },
    { kind: 'boot', at: 4000, pid: 11, profile: 'web' },
  ])
  assert.deepEqual(history.restarts, [])
})
