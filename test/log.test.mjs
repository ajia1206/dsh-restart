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
