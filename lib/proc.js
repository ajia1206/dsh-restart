/**
 * Host-process facts for dsh-restart.
 *
 * Everything here is read-only observation of the machine this plugin runs on:
 * the ancestor chain, whether a launchd job owns the process, the port it
 * listens on, and whether that port answers HTTP yet. No DSH imports, so it
 * unit-tests without booting a profile.
 */

import { execFileSync } from 'node:child_process'

/** Default bound for every observation command. */
export const PROBE_TIMEOUT_MS = 5000

const defaultRunner = (command, args, timeout) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

let runCommand = defaultRunner

/**
 * Run one bounded read-only command.
 * @param command - executable.
 * @param args - arguments.
 * @param timeout - milliseconds before the command is killed.
 * @returns stdout, or an empty string when the command failed.
 */
export function run(command, args, timeout = PROBE_TIMEOUT_MS) {
  return runCommand(command, args, timeout)
}

/**
 * Replace the command runner (tests only).
 * @param next - replacement runner, or undefined to restore the default.
 */
export function setCommandRunner(next) {
  runCommand = next ?? defaultRunner
}

/**
 * Milliseconds to wait.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
export function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Human-readable message for a thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one process row.
 * @param pid - process id.
 * @param runner - command runner.
 * @returns the row, or null when the process is gone.
 */
export function readProcess(pid, runner = run) {
  const text = runner('ps', ['-o', 'ppid=,command=', '-p', String(pid)])
  const line = text.trim()
  if (line === '') return null
  const match = /^(\d+)\s+([\s\S]+)$/.exec(line)
  if (match === null) return null
  return { pid, ppid: Number.parseInt(match[1], 10), command: match[2] }
}

/**
 * Walk the ancestor chain, nearest parent first, stopping at launchd.
 * @param pid - starting process id.
 * @param runner - command runner.
 * @returns ancestor rows, nearest first, excluding pid 1.
 */
export function readAncestors(pid, runner = run) {
  const chain = []
  let cursor = pid
  for (let hop = 0; hop < 16; hop += 1) {
    const row = readProcess(cursor, runner)
    if (row === null || row.ppid <= 1) break
    const parent = readProcess(row.ppid, runner)
    chain.push({
      pid: row.ppid,
      ppid: parent === null ? 0 : parent.ppid,
      command: parent === null ? '' : parent.command,
    })
    cursor = row.ppid
  }
  return chain
}

/**
 * Parse launchctl list output.
 * @param text - command output.
 * @returns one row per job, with a null pid for unloaded jobs.
 */
export function parseLaunchctlList(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [rawPid, rawStatus, ...rest] = parts
    if (rawPid !== '-' && !/^\d+$/.test(rawPid)) continue
    rows.push({
      pid: rawPid === '-' ? null : Number.parseInt(rawPid, 10),
      status: /^-?\d+$/.test(rawStatus) ? Number.parseInt(rawStatus, 10) : null,
      label: rest.join(' '),
    })
  }
  return rows
}

/**
 * Which launchd job, if any, actually owns this process.
 *
 * Only this process or its direct parent counts. launchd restarts the job's
 * MAIN process, so being a distant descendant of a running job proves nothing:
 * a process started from inside a DSH session has the DSH launchd job in its
 * ancestor chain, yet exiting it would leave nothing to bring it back. A false
 * "launchd" answer is therefore dangerous, while a false "unsupervised" answer
 * only costs the slower supervisor path.
 * @param pid - this process id.
 * @param ppid - this process direct parent id.
 * @param jobs - parsed launchctl rows.
 * @returns the owning job, or null.
 */
export function findSupervisorJob(pid, ppid, jobs) {
  for (const job of jobs) {
    if (job.pid === null) continue
    if (job.pid === pid || job.pid === ppid) return job
  }
  return null
}

/**
 * Read a launchd job's KeepAlive property.
 * @param label - job label.
 * @param uid - numeric user id.
 * @param runner - command runner.
 * @returns true, false, or null when the job cannot be inspected.
 */
export function readJobKeepAlive(label, uid, runner = run) {
  const text = runner('launchctl', ['print', 'gui/' + uid + '/' + label])
  if (text.trim() === '') return null
  return /keepalive/i.test(text)
}

/**
 * The command line needed to start this process again.
 * --import tsx/esm and friends live in execArgv, not argv.
 * @returns the re-executable command.
 */
export function readCommand() {
  return {
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    scriptPath: process.argv[1] ?? '',
    args: process.argv.slice(2),
  }
}

/**
 * Render a command for display.
 * @param command - structured command.
 * @returns a single display line.
 */
export function formatCommand(command) {
  const parts = [command.execPath, ...command.execArgv]
  if (command.scriptPath !== '') parts.push(command.scriptPath)
  parts.push(...command.args)
  return parts.join(' ')
}

/**
 * Read --port from the app's own inner command line.
 * @param argv - inner arguments from ctx.cmdlineArgs.get().
 * @returns the port, or null.
 */
export function parsePort(argv) {
  const args = [...(argv ?? [])]
  for (let index = 0; index < args.length; index += 1) {
    const inline = /^--port=(.+)$/.exec(args[index])
    if (inline !== null) {
      const value = Number.parseInt(inline[1], 10)
      if (Number.isFinite(value)) return value
    }
    if (args[index] === '--port' || args[index] === '-p') {
      const value = Number.parseInt(args[index + 1], 10)
      if (Number.isFinite(value)) return value
    }
  }
  return null
}

/**
 * Port a pid is listening on, discovered through lsof.
 * @param pid - process id.
 * @param runner - command runner.
 * @returns the lowest listening port, or null.
 */
export function findListeningPort(pid, runner = run) {
  const text = runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)])
  const ports = new Set()
  for (const match of text.matchAll(/:(\d{2,5}) \(LISTEN\)/g)) ports.add(Number.parseInt(match[1], 10))
  if (ports.size === 0) return null
  return [...ports].sort((a, b) => a - b)[0]
}

/**
 * Whether a pid is still alive.
 * @param pid - process id.
 * @returns true when the process exists (or exists but is not signalable).
 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Poll an HTTP endpoint until it answers or the deadline passes.
 * A 4xx counts as up: the web app answers 401 until it is given its token.
 * @param url - health URL.
 * @param options - timeout, interval and per-request timeout.
 * @returns the probe result.
 */
export async function probeHealth(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45000
  const intervalMs = options.intervalMs ?? 500
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastError = ''
  let lastStatus = null
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) })
      lastStatus = response.status
      if (response.status < 500) {
        return { ok: true, statusCode: response.status, attempts, lastError: '' }
      }
      lastError = 'HTTP ' + response.status
    } catch (error) {
      lastError = errorMessage(error)
    }
    await sleep(intervalMs)
  }
  return { ok: false, statusCode: lastStatus, attempts, lastError }
}

/**
 * Poll until a pid disappears.
 * @param pid - process id.
 * @param options - timeout and interval.
 * @returns whether the process exited in time.
 */
export async function waitForExit(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await sleep(intervalMs)
  }
  return !processAlive(pid)
}
