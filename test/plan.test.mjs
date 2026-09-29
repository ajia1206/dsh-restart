/** Unit tests for the restart plan decision. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlan, usesGracefulExit } from '../lib/plan.js'

const command = { execPath: '/node', execArgv: [], scriptPath: '/app/bin.ts', args: ['web'] }
const base = { pid: 12006, ppid: 11997, command, cwd: '/app', port: 28000 }

test('a KeepAlive launchd job means a graceful exit is enough', () => {
  const plan = buildPlan({ ...base, job: { pid: 11997, label: 'com.dsh.web-alpha2' }, keepAlive: true })
  assert.equal(plan.strategy, 'launchd')
  assert.equal(plan.restartable, true)
  assert.equal(plan.label, 'com.dsh.web-alpha2')
  assert.deepEqual(plan.warnings, [])
  assert.match(plan.summary, /launchd/)
  assert.equal(usesGracefulExit(plan.strategy), true)
})

test('an unsupervised process falls back to the detached supervisor', () => {
  const plan = buildPlan({ ...base, job: null, keepAlive: null })
  assert.equal(plan.strategy, 'supervisor')
  assert.equal(plan.restartable, true)
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0], /没有 launchd 任务托管/)
})

test('a launchd job without KeepAlive warns but still uses the supervisor', () => {
  const plan = buildPlan({ ...base, job: { pid: 1, label: 'com.dsh.no-keepalive' }, keepAlive: false })
  assert.equal(plan.strategy, 'supervisor')
  assert.match(plan.warnings[0], /未开启 KeepAlive/)
})

test('an uninspectable KeepAlive property still warns', () => {
  const plan = buildPlan({ ...base, job: { pid: 1, label: 'com.dsh.unknown' }, keepAlive: null })
  assert.equal(plan.strategy, 'supervisor')
  assert.match(plan.warnings[0], /无法确认/)
})

test('superviseFallback=false refuses to exit an unsupervised process', () => {
  const plan = buildPlan({ ...base, job: null, keepAlive: null, superviseFallback: false })
  assert.equal(plan.strategy, 'none')
  assert.equal(plan.restartable, false)
  assert.equal(usesGracefulExit(plan.strategy), false)
  assert.match(plan.summary, /拒绝重启/)
})

test('an unsupervised process with the fallback disabled never restarts', () => {
  const plan = buildPlan({ ...base, job: { pid: 1, label: 'x' }, keepAlive: false, superviseFallback: false })
  assert.equal(plan.restartable, false)
  assert.equal(plan.warnings.length, 1)
})

test('desktop never uses the detached Node Host fallback', () => {
  const desktop = { appPath: '/Applications/DSH.app', shellPid: 42 }
  assert.equal(buildPlan({ ...base, desktop }).strategy, 'desktop')
  assert.equal(buildPlan({ ...base, desktop: null }).restartable, false)
  assert.equal(buildPlan({ ...base, desktop: null, job: { pid: 1, label: 'x' }, keepAlive: true }).restartable, false)
})
