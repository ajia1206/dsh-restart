/** Unit tests for host-process facts. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  findListeningPort, findSupervisorJob, formatCommand, parseLaunchctlList,
  parsePort, probeHealth, processAlive, readAncestors, readProcess,
} from '../lib/proc.js'

const TAB = String.fromCharCode(9)
const LIST = [
  'PID' + TAB + 'Status' + TAB + 'Label',
  '11997' + TAB + '0' + TAB + 'com.dsh.web-alpha2',
  '-' + TAB + '0' + TAB + 'com.apple.unloaded',
  '12006' + TAB + '-2' + TAB + 'local.dsh.tunnel',
].join('\n')

test('parseLaunchctlList reads pids, statuses and labels', () => {
  const jobs = parseLaunchctlList(LIST)
  assert.equal(jobs.length, 3)
  assert.deepEqual(jobs[0], { pid: 11997, status: 0, label: 'com.dsh.web-alpha2' })
  assert.deepEqual(jobs[1], { pid: null, status: 0, label: 'com.apple.unloaded' })
  assert.deepEqual(jobs[2], { pid: 12006, status: -2, label: 'local.dsh.tunnel' })
  assert.deepEqual(parseLaunchctlList(''), [])
})

test('findSupervisorJob matches this process or its direct parent only', () => {
  const jobs = parseLaunchctlList(LIST)
  // pid 11997 is the job's main process and the direct parent: launchd owns us
  // because our exit propagates to it.
  assert.equal(findSupervisorJob(12006, 11997, jobs).label, 'com.dsh.web-alpha2')
  // We are the job's main process itself.
  assert.equal(findSupervisorJob(11997, 1, jobs).label, 'com.dsh.web-alpha2')
  // A distant descendant must NOT be treated as owned: nothing would restart it.
  assert.equal(findSupervisorJob(63577, 63576, jobs), null)
  assert.equal(findSupervisorJob(999, 998, jobs), null)
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
