/** Unit tests for host-process facts. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  findListeningPort, findSupervisorJob, formatCommand, parseKeepAlive,
  parseLaunchctlList, parsePort, probeHealth, processAlive, readAncestors,
  readJobKeepAlive, readProcess,
} from '../lib/proc.js'

const TAB = String.fromCharCode(9)
const LIST = [
  'PID' + TAB + 'Status' + TAB + 'Label',
  '11997' + TAB + '0' + TAB + 'com.dsh.web-alpha2',
  '-' + TAB + '0' + TAB + 'com.apple.unloaded',
  '12006' + TAB + '-2' + TAB + 'local.dsh.tunnel',
].join('\n')

// Real shape of a RunningBoard-submitted desktop app job: there is no
// properties block at all, and nothing here describes a KeepAlive policy.
const RUNNINGBOARD = [
  'gui/501/application.com.deepseek.dsh.519595170.519595176 = {',
  TAB + 'active count = 6',
  TAB + 'state = running',
  TAB + 'program = /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  TAB + 'inherited environment = {',
  TAB + TAB + 'NO_PROXY => localhost,127.0.0.1,::1',
  TAB + TAB + 'PATH => /usr/bin:/bin:/usr/sbin:/sbin',
  TAB + '}',
  TAB + 'pid = 21646',
  TAB + '}',
].join('\n')

// LaunchAgent shape: the policy lives inside the properties block, rendered
// with lower-case, space-stripped keys.
const AGENT_KEEPALIVE_ON = [
  'gui/501/com.dsh.web-alpha2 = {',
  TAB + 'active count = 1',
  TAB + 'state = running',
  TAB + 'program = /opt/homebrew/bin/node',
  TAB + 'arguments = {',
  TAB + TAB + '/opt/homebrew/bin/node',
  TAB + TAB + 'dsh',
  TAB + TAB + 'web',
  TAB + '}',
  TAB + 'inherited environment = {',
  TAB + TAB + 'DSH_KEEPALIVE_HINT => keepalive',
  TAB + '}',
  TAB + 'properties = {',
  TAB + TAB + 'keepalive = 1',
  TAB + TAB + 'runatload = 1',
  TAB + '}',
  TAB + 'pid = 11997',
  TAB + '}',
].join('\n')

test('findSupervisorJob prefers the job whose main process is this process', () => {
  const jobs = parseLaunchctlList(LIST)
  // Ambiguous on purpose: this process (12006) is itself the main process of
  // local.dsh.tunnel AND the direct child of com.dsh.web-alpha2 (11997). The
  // self-match wins — only that job is restarted by launchd when we exit, so
  // reporting the parent job instead would let the plan trust a relaunch that
  // may never come.
  assert.equal(findSupervisorJob(12006, 11997, jobs).label, 'local.dsh.tunnel')
  // With no self-match, the parent job is still reported.
  assert.equal(findSupervisorJob(99999, 11997, jobs).label, 'com.dsh.web-alpha2')
  // We are the job's main process itself.
  assert.equal(findSupervisorJob(11997, 1, jobs).label, 'com.dsh.web-alpha2')
  // A distant descendant must NOT be treated as owned: nothing would restart it.
  assert.equal(findSupervisorJob(63577, 63576, jobs), null)
  assert.equal(findSupervisorJob(999, 998, jobs), null)
})

test('parseKeepAlive finds no properties block in a RunningBoard app job', () => {
  assert.equal(parseKeepAlive(RUNNINGBOARD), null)
  assert.equal(parseKeepAlive(''), null)
  assert.equal(parseKeepAlive('gui/501/com.dsh.x = {\n' + TAB + 'pid = 1\n}'), null)
})

test('parseKeepAlive reads the properties block of a LaunchAgent job', () => {
  assert.equal(parseKeepAlive(AGENT_KEEPALIVE_ON), true)
})

test('parseKeepAlive understands every boolean rendering', () => {
  const withValue = value => [
    'gui/501/com.dsh.x = {',
    TAB + 'properties = {',
    TAB + TAB + 'keepalive = ' + value,
    TAB + '}',
    '}',
  ].join('\n')
  assert.equal(parseKeepAlive(withValue('1')), true)
  assert.equal(parseKeepAlive(withValue('true')), true)
  assert.equal(parseKeepAlive(withValue('TRUE')), true)
  assert.equal(parseKeepAlive(withValue('Yes')), true)
  assert.equal(parseKeepAlive(withValue('0')), false)
  assert.equal(parseKeepAlive(withValue('false')), false)
  assert.equal(parseKeepAlive(withValue('No')), false)
  // A nested dict is still a configured KeepAlive policy.
  assert.equal(parseKeepAlive([
    'gui/501/com.dsh.x = {',
    TAB + 'properties = {',
    TAB + TAB + 'keepalive = {',
    TAB + TAB + TAB + 'pathstate = {',
    TAB + TAB + TAB + TAB + '/tmp/watch => true',
    TAB + TAB + TAB + '}',
    TAB + TAB + '}',
    TAB + '}',
    '}',
  ].join('\n')), true)
  // An empty value asserts nothing.
  assert.equal(parseKeepAlive(withValue('')), null)
})

test('parseKeepAlive never mistakes a label, environment or endpoint for a policy', () => {
  const lines = [
    'gui/501/com.dsh.keepalive-proxy = {',
    TAB + 'active count = 1',
    TAB + 'inherited environment = {',
    TAB + TAB + 'DSH_ENDPOINT => http://127.0.0.1:28000/keepalive',
    TAB + TAB + 'KEEPALIVE = true',
    TAB + '}',
    TAB + 'dynamic endpoints = {',
    TAB + TAB + '0x7f00 => com.dsh.keepalive.service',
    TAB + '}',
    TAB + 'properties = {',
    TAB + TAB + 'runatload = 1',
    TAB + '}',
    TAB + 'pid = 21646',
    '}',
  ].join('\n')
  // The properties block exists but says nothing about KeepAlive: never true.
  assert.equal(parseKeepAlive(lines), null)
  // Without a properties block the same text is still never true.
  assert.notEqual(parseKeepAlive(lines.replace(TAB + 'properties = {\n', '').replace(TAB + 'runatload = 1\n', '').replace(TAB + '}\n', '')), true)
  assert.equal(parseKeepAlive('gui/501/keepalive = {\n' + TAB + 'pid = 1\n}'), null)
})

test('parseKeepAlive stays inside the properties block when it nests braces', () => {
  const nested = [
    'gui/501/com.dsh.x = {',
    TAB + 'properties = {',
    TAB + TAB + 'keepalive = 1',
    TAB + TAB + 'environment = {',
    TAB + TAB + TAB + 'keepalive = 0',
    TAB + TAB + '}',
    TAB + '}',
    TAB + '}',
  ].join('\n')
  assert.equal(parseKeepAlive(nested), true)
  // keepalive only appears after the properties block closed: not our business.
  const afterBlock = [
    'gui/501/com.dsh.x = {',
    TAB + 'properties = {',
    TAB + TAB + 'runatload = 1',
    TAB + '}',
    TAB + 'environment = {',
    TAB + TAB + 'HINT => keepalive = 1',
    TAB + '}',
    '}',
  ].join('\n')
  assert.equal(parseKeepAlive(afterBlock), null)
})

test('readJobKeepAlive returns null when the job cannot be inspected', () => {
  assert.equal(readJobKeepAlive('com.dsh.gone', 501, () => ''), null)
  assert.equal(readJobKeepAlive('com.dsh.gone', 501, () => '   \n'), null)
  assert.equal(readJobKeepAlive('com.dsh.app', 501, () => RUNNINGBOARD), null)
  assert.equal(readJobKeepAlive('com.dsh.web-alpha2', 501, () => AGENT_KEEPALIVE_ON), true)
  const seen = []
  readJobKeepAlive('com.dsh.web-alpha2', 501, (command, args) => {
    seen.push([command, ...args].join(' '))
    return ''
  })
  assert.deepEqual(seen, ['launchctl print gui/501/com.dsh.web-alpha2'])
})

test('parsePort understands both --port forms and stops at the first hit', () => {
  assert.equal(parsePort(['web', '--host', '127.0.0.1', '--port', '28000', '--no-open']), 28000)
  assert.equal(parsePort(['web', '--port=3080']), 3080)
  assert.equal(parsePort(['web', '-p', '9000']), 9000)
  assert.equal(parsePort(['web']), null)
  assert.equal(parsePort([]), null)
  assert.equal(parsePort(undefined), null)
})

test('readAncestors walks up and stops at launchd', () => {
  const rows = {
    12006: '11997  node --import tsx/esm apps/cli/src/bin.ts web --port 28000',
    11997: '1  node /opt/homebrew/opt/node@22/bin/pnpm dsh web',
  }
  const runner = (_command, args) => {
    const pid = Number.parseInt(args[args.length - 1], 10)
    return rows[pid] === undefined ? '' : rows[pid]
  }
  const chain = readAncestors(12006, runner)
  assert.deepEqual(chain.map(item => item.pid), [11997])
  assert.match(chain[0].command, /pnpm dsh web/)
})

test('readProcess returns null for a missing process', () => {
  assert.equal(readProcess(999999, () => ''), null)
  assert.deepEqual(
    readProcess(1, () => '1 /sbin/launchd'),
    { pid: 1, ppid: 1, command: '/sbin/launchd' },
  )
})

test('findListeningPort picks the lowest listening port', () => {
  const output = [
    'node 12006 getui 17u IPv4 0x1 0t0 TCP 127.0.0.1:28000 (LISTEN)',
    'node 12006 getui 18u IPv4 0x2 0t0 TCP 127.0.0.1:9000 (LISTEN)',
  ].join('\n')
  assert.equal(findListeningPort(12006, () => output), 9000)
  assert.equal(findListeningPort(12006, () => ''), null)
})

test('formatCommand keeps execArgv before the script', () => {
  const text = formatCommand({
    execPath: '/node',
    execArgv: ['--import', 'tsx/esm'],
    scriptPath: '/app/bin.ts',
    args: ['web', '--port', '28000'],
  })
  assert.equal(text, '/node --import tsx/esm /app/bin.ts web --port 28000')
})

test('formatCommand omits an absent script path', () => {
  assert.equal(
    formatCommand({ execPath: '/node', execArgv: [], scriptPath: '', args: ['-e', 'x'] }),
    '/node -e x',
  )
})

test('processAlive is true for this process and false for a dead pid', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(999999), false)
})

test('probeHealth treats 4xx as up and a closed port as down', async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 401
    response.end('token required')
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  const up = await probeHealth('http://127.0.0.1:' + port + '/', {
    timeoutMs: 4000, intervalMs: 100, requestTimeoutMs: 1500,
  })
  assert.equal(up.ok, true)
  assert.equal(up.statusCode, 401)
  await new Promise(resolve => { server.close(resolve) })
  const down = await probeHealth('http://127.0.0.1:' + port + '/', {
    timeoutMs: 1200, intervalMs: 200, requestTimeoutMs: 300,
  })
  assert.equal(down.ok, false)
})
