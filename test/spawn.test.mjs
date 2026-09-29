/** Unit tests for the recovery preflight and the supervisor launch. */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { preflightRecovery, startSupervisor } from '../lib/spawn.js'

test('preflightRecovery accepts a creatable child log path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-spawn-'))
  try {
    // The directory does not exist yet: preflight must create it, because the
    // supervisor only opens the file after the old process is already gone.
    const target = join(dir, 'nested', 'logs', 'child.log')
    assert.equal(await preflightRecovery(target), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('preflightRecovery rejects an unwritable directory instead of failing later', async () => {
  if (process.getuid?.() === 0) return // root ignores the permission bits
  const dir = await mkdtemp(join(tmpdir(), 'dsr-spawn-'))
  try {
    const locked = join(dir, 'locked')
    await preflightRecovery(join(locked, 'child.log'))
    await chmod(locked, 0o500)
    const reason = await preflightRecovery(join(locked, 'child.log'))
    assert.ok(typeof reason === 'string' && reason.length > 0, '应当给出拒绝原因')
  } finally {
    await chmod(join(dir, 'locked'), 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('startSupervisor reports success and unrefs the child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-spawn-'))
  try {
    const specPath = join(dir, 'spec.json')
    const started = await startSupervisor({
      execPath: process.execPath,
      supervisorPath: '--version',
      specPath,
      cwd: dir,
    })
    assert.equal(started, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startSupervisor reports failure for an executable that cannot be spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-spawn-'))
  try {
    const started = await startSupervisor({
      execPath: join(dir, 'definitely-not-here'),
      supervisorPath: 'x.mjs',
      specPath: join(dir, 'spec.json'),
      cwd: dir,
    })
    assert.equal(started, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startSupervisor reports failure for a working directory that does not exist', async () => {
  const started = await startSupervisor({
    execPath: process.execPath,
    supervisorPath: '-e',
    specPath: '/tmp/never-written.json',
    cwd: '/definitely/not/a/directory',
  })
  assert.equal(started, false)
})
