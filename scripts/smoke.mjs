/**
 * Read-only smoke: print the supervision facts and restart plan for a pid.
 *
 *   node scripts/smoke.mjs [pid]     # defaults to this process
 *
 * Never restarts anything.
 */

import { buildPlan } from '../lib/plan.js'
import {
  findListeningPort, findSupervisorJob, formatCommand, parseLaunchctlList,
  parsePort, readAncestors, readCommand, readJobKeepAlive, readProcess, run,
} from '../lib/proc.js'

const pid = Number(process.argv[2] ?? process.pid)
const self = readProcess(pid)
if (self === null) {
  console.log('pid ' + pid + ' 不存在')
  process.exit(1)
}
const ancestors = readAncestors(pid)
const jobs = parseLaunchctlList(run('launchctl', ['list']))
const job = findSupervisorJob(pid, self.ppid, jobs)
const keepAlive = job === null ? null : readJobKeepAlive(job.label, process.getuid())
const command = pid === process.pid ? readCommand() : { execPath: '', execArgv: [], scriptPath: '', args: [] }
const port = parsePort(command.args) ?? findListeningPort(pid)

console.log('pid        :', pid)
console.log('command    :', self.command)
console.log('ancestors  :', ancestors.map(item => item.pid + ' (' + item.command.slice(0, 60) + ')').join(' <- '))
console.log('launchd job:', job === null ? '(none)' : job.label + ' pid=' + job.pid + ' keepAlive=' + String(keepAlive))
console.log('port       :', port)
if (command.execPath !== '') console.log('re-exec    :', formatCommand(command))

const plan = buildPlan({
  pid,
  ppid: self.ppid,
  command,
  cwd: process.cwd(),
  port,
  job,
  keepAlive,
})
console.log('')
console.log('strategy   :', plan.strategy)
console.log('restartable:', plan.restartable)
console.log('summary    :', plan.summary)
for (const warning of plan.warnings) console.log('warning    :', warning)
