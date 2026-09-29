import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopTarget, restartDesktop, desktopExecutable } from '../lib/desktop.js'
import { setCommandRunner } from '../lib/proc.js'
test('desktop executable inspection excludes argv', () => {
  setCommandRunner((cmd, args) => { assert.deepEqual(args, ['-o', 'comm=', '-p', '42']); return '/Applications/DSH.app/Contents/MacOS/DSH\n' })
  try { assert.equal(desktopExecutable(42), '/Applications/DSH.app/Contents/MacOS/DSH') } finally { setCommandRunner() }
})
const base = { platform: 'darwin', execPath: '/Applications/DSH.app/Contents/MacOS/DSH', scriptPath: '/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', ppid: 42, connected: true, parentExecutable: '/Applications/DSH.app/Contents/MacOS/DSH' }
test('desktop detection requires its actual IPC shell; ordinary web is unaffected', () => {
  assert.deepEqual(desktopTarget(base), { appPath: '/Applications/DSH.app', shellPid: 42 })
  for (const override of [{ connected: false }, { ppid: 1 }, { parentExecutable: '/node' }, { platform: 'linux' }]) assert.equal(desktopTarget({ ...base, ...override }), null)
  assert.equal(desktopTarget({ ...base, scriptPath: '/cli.js' }), undefined)
})
const spec = { desktop: { appPath: '/Applications/DSH.app', shellPid: 42 }, oldPid: 43, exitTimeoutMs: 100 }
test('relaunch waits for both shell and Host, then requires connected boot', async () => {
  const calls = []
  await restartDesktop(spec, { quit: async p => calls.push(['quit', p]), wait: async p => { calls.push(['wait', p]); return true }, open: async p => calls.push(['open', p]), ready: async () => { calls.push(['ready']); return true } })
  assert.deepEqual(calls.map(c => c[0]), ['quit', 'wait', 'wait', 'open', 'ready'])
})
test('cancelled quit never launches another Host', async () => {
  await assert.rejects(restartDesktop(spec, { quit: async () => {}, wait: async () => false, open: async () => assert.fail('must not open') }), /取消或超时/)
})
test('failed quit and missing IPC boot are failures', async () => {
  await assert.rejects(restartDesktop(spec, { quit: async () => { throw Error('denied') } }), /denied/)
  await assert.rejects(restartDesktop(spec, { quit: async () => {}, wait: async () => true, open: async () => {}, ready: async () => false }), /IPC/)
})
