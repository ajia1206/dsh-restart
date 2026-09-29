/**
 * Detached restart supervisor for dsh-restart.
 *
 * Used only when no KeepAlive launchd job owns the DSH process. It is spawned
 * by the plugin, unref'd, and then survives the plugin's own exit:
 *
 *   1. read the spec, delete it, then record a handshake so the plugin can
 *      prove a supervisor is really up; preflight the recovery resources
 *      before the host is allowed to leave
 *   2. wait for the host's own `exiting` commitment for this arm (gate)
 *   3. wait for the old pid to exit (gate; report honestly when it does not)
 *   4. observe the old endpoint at the socket layer (evidence, never a gate)
 *   5. spawn the replacement and only continue once the spawn really succeeded
 *   6. confirm the replacement's own boot record, then record the outcome
 *
 * Secrets are never written to disk: the supervisor inherits the plugin's
 * environment, so only the command line and paths go into the spec file, and
 * that file is unlinked as soon as it has been read.
 *
 * The whole point of this process is to bring the service back, so the host
 * has already committed to exit by the time it acts. Exactly two facts may
 * stop the relaunch: the host never wrote `exiting` for this arm, and the old
 * pid did not exit in time (launching then would create a duplicate). Every
 * other observation is EVIDENCE ONLY — a missing or unparseable health URL, a
 * port that keeps accepting connections, a failing HTTP probe — and still
 * leads to the relaunch; it only changes how the outcome is reported.
 *
 * Success rule: `ok` needs the replacement's own boot record and, when an
 * endpoint is observable, an observed socket-level release:
 *
 *   ok = bootMatched === true && (portReleased === null || portReleased === true)
 *
 * `portReleased: null` means "there is no observable endpoint", never "not
 * released"; `false` means an endpoint was observable and still accepted
 * connections. A live listener is therefore never turned into a fake release,
 * and a headless host degrades to boot-record evidence instead of a recorded
 * failure. The record carries `portReleased` / `bootMatched` / `notes` and the
 * reason spells whichever downgrade happened out.
 */

import { spawn, execFile } from 'node:child_process'
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { restartDesktop, desktopExecutable } from './desktop.js'
import { appendRecord, readRecords } from './log.js'
import { errorMessage, probeHealth, readProcess, waitForExit } from './proc.js'

const DOWN_TIMEOUT_MS = 15000
const SPEC_DELETE_ATTEMPTS = 3
/** Bound for the host's own `exiting` commitment, matching the desktop path. */
const EXIT_COMMIT_TIMEOUT_MS = 10000
const COMMIT_POLL_MS = 100

/**
 * Where a thrown failure must be reported once the spec is gone. `main` fills
 * this in as soon as it has parsed the spec, because the spec is deleted right
 * after that and a filename convention is not a trustworthy substitute.
 */
let reporting = null

/** Error carrying the machine-stable kind of a fatal supervisor failure. */
class SupervisorError extends Error {
  /**
   * @param kind - stable failure kind recorded in the outcome.
   * @param message - human-readable Chinese explanation.
   */
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

/**
 * Milliseconds to wait.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Delete the spec file once it has been read and parsed.
 *
 * The spec holds the host command line, which can contain credential-style
 * arguments, so it must not stay on disk. Cleanup is best-effort: a failure
 * never changes the restart outcome. The spec directory is the restart log
 * directory, and the plugin overwrites the same armId-keyed path on the next
 * attempt, so a leftover is bounded rather than permanent; the failure is
 * still recorded as its own `spec-cleanup-failed` line.
 * @param specPath - spec file path.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @returns true when the file is gone.
 */
async function unlinkSpec(specPath, logPath, armId) {
  for (let attempt = 1; attempt <= SPEC_DELETE_ATTEMPTS; attempt += 1) {
    try {
      await unlink(specPath)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      if (attempt === SPEC_DELETE_ATTEMPTS) {
        await appendRecord(logPath, {
          kind: 'spec-cleanup-failed',
          at: Date.now(),
          armId,
          error: errorMessage(error),
        }).catch(() => {})
        return false
      }
      await sleep(50)
    }
  }
  return false
}

/**
 * Make sure the replacement's log destination can be written.
 *
 * Called BEFORE the old process is awaited: the plugin has already completed
 * its handshake and is still running, so a failure here can still abort the
 * exit. Discovering an unusable directory after shutdown would leave the host
 * down for good.
 * @param outLogPath - child stdout/stderr path.
 * @param logPath - restart log path.
 * @param armId - the arm this preflight belongs to, so the plugin can match it.
 * @returns nothing; throws a SupervisorError when the path is unusable.
 */
async function preflightOutLog(outLogPath, logPath, armId) {
  if (typeof outLogPath !== 'string' || outLogPath === '') {
    throw new SupervisorError('no-out-log', '没有配置子进程日志路径，无法保证新进程的输出有地方可写')
  }
  const parent = dirname(outLogPath)
  try {
    // recursive mkdir is a no-op when the directory already exists.
    await mkdir(parent, { recursive: true })
  } catch (error) {
    throw new SupervisorError('out-log-unwritable', '子进程日志目录不可用：' + parent + '（' + errorMessage(error) + '）')
  }
  // Probe with a real append instead of access(): appending is exactly what
  // the child's stdio needs, and it uses this process's own credentials.
  try {
    await appendFile(outLogPath, '', 'utf8')
  } catch (error) {
    throw new SupervisorError('out-log-unwritable', '子进程日志不可写：' + outLogPath + '（' + errorMessage(error) + '）')
  }
  // The plugin polls the handshake for this arm, so a failure that happens
  // after this marker stops it from committing its exit. The marker is added
  // last on purpose: it promises exactly "the preflight below already ran".
  await appendRecord(logPath, { kind: 'supervisor-ready', at: Date.now(), armId })
}

/**
 * Resolve the socket host and port a health URL names.
 *
 * Parsing is a reportable event, not a throw: a URL that cannot be parsed
 * means "no observable endpoint", which is evidence (`portReleased: null`)
 * rather than a reason to stop the relaunch.
 * @param url - health URL from the spec.
 * @returns `{ ok: true, kind: 'observable', host, port }`, or
 *   `{ ok: false, kind: 'missing' | 'invalid', error, host: '', port: 0 }`.
 */
export function parseHealthEndpoint(url) {
  if (typeof url !== 'string' || url === '') {
    return { ok: false, kind: 'missing', error: '', host: '', port: 0 }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch (error) {
    return { ok: false, kind: 'invalid', error: errorMessage(error), host: '', port: 0 }
  }
  // URL.hostname keeps the brackets around an IPv6 literal; net.connect wants
  // the bare address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  let port = Number.parseInt(parsed.port, 10)
  if (!Number.isInteger(port) || port <= 0) {
    if (parsed.protocol === 'http:') port = 80
    else if (parsed.protocol === 'https:') port = 443
    else return { ok: false, kind: 'invalid', error: '无法从该 URL 得出端口：' + url, host: '', port: 0 }
  }
  if (host === '' || port > 65535) {
    return { ok: false, kind: 'invalid', error: 'URL 缺少可连接的主机名或端口：' + url, host: '', port: 0 }
  }
  return { ok: true, kind: 'observable', host, port }
}

/**
 * Whether nothing is listening on a TCP endpoint any more.
 *
 * This is a socket-level test, not an HTTP one: a listener that answers 503 or
 * times out over HTTP still holds the port. Only a failed connection counts as
 * released; a timeout is uncertain and is conservatively reported as still
 * listening, because "still listening" can never fake a successful release.
 * @param host - host to connect to.
 * @param port - port to connect to.
 * @param options - `timeoutMs` bound for one connection attempt.
 * @returns true when the connection was refused or otherwise failed.
 */
export async function isPortClosed(host, port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000
  return new Promise(resolve => {
    let settled = false
    let timer = null
    let socket
    const settle = closed => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      socket?.destroy()
      resolve(closed)
    }
    try {
      socket = connect({ host, port })
    } catch {
      // A synchronous throw means we could not even attempt the connection, so
      // nothing was observed. That is uncertainty, never proof of release.
      resolve(false)
      return
    }
    timer = setTimeout(() => settle(false), timeoutMs)
    socket.once('connect', () => settle(false))
    // A persistent listener, not `once`: a late error after destroy() must
    // never become an unhandled 'error' event in the supervisor.
    //
    // Only ECONNREFUSED proves there is no listener. ENOTFOUND, EACCES,
    // ENETUNREACH, EHOSTDOWN and a timeout all mean "could not observe the
    // port", which must not be reported as a release: otherwise a matching
    // boot record could turn an unobserved endpoint into a claimed success.
    socket.on('error', error => settle(error?.code === 'ECONNREFUSED'))
  })
}

/**
 * Wait until the endpoint stops accepting TCP connections.
 *
 * "Port released" is decided at the socket layer: a listener that keeps
 * answering — including with HTTP 5xx — still holds the port, and so does a
 * connection that only times out. The result is evidence for the record; the
 * caller relaunches either way.
 * @param host - host to probe.
 * @param port - port to probe.
 * @param timeoutMs - bound.
 * @param options - per-probe timeout and poll interval.
 * @returns true when the port was observed closed.
 */
export async function waitForDown(host, port, timeoutMs = DOWN_TIMEOUT_MS, options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const closed = await isPortClosed(host, port, { timeoutMs: Math.min(probeTimeoutMs, remaining) })
    if (closed) return true
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}

/**
 * Wait for the host's own exit commitment for this arm.
 *
 * `exiting` is the host saying "I am about to leave"; `aborted` / `cancelled`
 * mean the opposite — it gave up on the exit, or the user cancelled it — so
 * the supervisor must not relaunch next to a host that is still running.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @param options - timeout and poll interval.
 * @returns the deciding record kind, or null when nothing was written in time.
 */
export async function waitForExitCommit(logPath, armId, options = {}) {
  const timeoutMs = options.timeoutMs ?? EXIT_COMMIT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? COMMIT_POLL_MS
  const deadline = Date.now() + timeoutMs
  while (true) {
    const mine = (await readRecords(logPath, 200)).filter(record => record.armId === armId)
    // A commitment wins: nothing the plugin writes afterwards cancels it.
    if (mine.some(record => record.kind === 'exiting')) return 'exiting'
    const stopped = mine.findLast(record => record.kind === 'aborted' || record.kind === 'cancelled')
    if (stopped) return stopped.kind
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

/**
 * Readable message for a failed launch.
 * @param error - thrown value.
 * @returns the message.
 */
function spawnMessage(error) {
  return '拉起失败：' + errorMessage(error)
}

/**
 * Start the replacement process.
 *
 * A bad execPath, cwd or stdio target is reported asynchronously through the
 * child's `error` event, which the surrounding try/catch cannot see: the
 * promise settles on whichever of `spawn` / `error` arrives first, so the
 * caller waits for a real start instead of assuming one.
 * @param command - recorded command line.
 * @param options - cwd and the child log descriptor.
 * @returns the replacement pid, or null when the platform reported none.
 */
function startReplacement(command, { cwd, fd }) {
  return new Promise((resolve, reject) => {
    // A script path is absent for inline (-e) invocations; pushing the empty
    // string would make Node try to run a file named ''.
    const argv = [...command.execArgv]
    if (command.scriptPath !== '') argv.push(command.scriptPath)
    argv.push(...command.args)

    let child
    try {
      child = spawn(command.execPath, argv, {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      })
    } catch (error) {
      reject(new SupervisorError('spawn-failed', spawnMessage(error)))
      return
    }
    const onError = error => { reject(new SupervisorError('spawn-failed', spawnMessage(error))) }
    child.once('error', onError)
    child.once('spawn', () => {
      child.removeListener('error', onError)
      // Post-start errors must not become an uncaught exception: the pid and
      // the boot record are what decide the outcome from here on.
      child.on('error', () => {})
      child.unref()
      resolve(child.pid ?? null)
    })
  })
}

/**
 * Build the predicate that recognises this replacement's own boot record.
 *
 * Identity is pid plus cwd: the plugin writes the replacement's cwd into its
 * boot record, so it survives a shared log file. Records without a cwd (other
 * writers) are accepted on pid alone rather than treated as a mismatch.
 * @param cwd - the replacement's working directory.
 * @returns a predicate over a log record.
 */
export function buildBootMatcher(cwd) {
  return record => record !== null && typeof record === 'object'
    && record.kind === 'boot'
    && Number.isInteger(record.pid)
    && (record.cwd === undefined || record.cwd === cwd)
}

/**
 * The boot record that actually proves THIS replacement came up.
 *
 * `buildBootMatcher` alone is not enough: the working directory is identical
 * across restarts, so any boot record left by an earlier run satisfies it on
 * the very first scan and `bootMatched` would be true before the replacement
 * has done anything. Two things close that: the replacement's own pid, and a
 * lower time bound, because the OS reuses pids and a historical boot can carry
 * the very pid we just started.
 * @param cwd - the replacement's working directory.
 * @param newPid - the pid of the process this supervisor just started.
 * @param notBefore - epoch ms; records older than this cannot be this launch.
 * @returns a predicate over a log record.
 */
export function buildReplacementBootMatcher(cwd, newPid, notBefore = 0) {
  const shape = buildBootMatcher(cwd)
  return record => shape(record) && record.pid === newPid
    && (typeof record.at !== 'number' || record.at >= notBefore)
}

/**
 * Confirm the replacement published its own boot record.
 *
 * The record is matched on identity, not on time: zero-delay restarts can
 * record the new boot before the supervisor reaches this point, so the log is
 * rescanned from the start of a generous tail instead of only looking at
 * freshly appended lines. Each scan is bounded, so the poll still ends within
 * roughly `timeoutMs` even when the log has grown large.
 * @param logPath - restart log path.
 * @param matcher - boot predicate.
 * @param options - timeout, interval and the pids that must not win.
 * @returns true when such a record exists.
 */
export async function waitForBootRecord(logPath, matcher, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45000
  const intervalMs = options.intervalMs ?? 500
  const excluded = new Set(options.excluded ?? [])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // The log grows with every restart; read a generous tail so a record is
    // never missed behind the old host's own progress writes.
    const records = await readRecords(logPath, 2000)
    if (records.some(record => matcher(record) && !excluded.has(record.pid))) return true
    await sleep(intervalMs)
  }
  return false
}

/**
 * Write the single authoritative outcome record, then exit.
 *
 * `ok` derives from the replacement's identity evidence: its own boot record,
 * plus an observed socket-level port release whenever an endpoint exists to
 * observe. `portReleased` keeps three states so the record never conflates
 * "no endpoint" with "the port never closed". Writing `ok:true` with the hard
 * evidence missing would be a lie, so each fact is also reported on its own.
 * @param logPath - restart log path.
 * @param context - arm id and start time.
 * @param outcome - collected fields.
 * @returns nothing; the process exits.
 */
async function finish(logPath, context, outcome) {
  await appendRecord(logPath, {
    kind: 'supervised',
    at: Date.now(),
    armId: context.armId,
    ok: outcome.ok === true,
    newPid: outcome.newPid ?? null,
    statusCode: outcome.statusCode ?? null,
    attempts: outcome.attempts ?? 0,
    error: outcome.error ?? '',
    notes: outcome.notes ?? '',
    portReleased: outcome.portReleased === true ? true : (outcome.portReleased === false ? false : null),
    bootMatched: outcome.bootMatched === true,
    elapsedMs: Date.now() - context.startedAt,
  })
  process.exit(outcome.ok === true ? 0 : 1)
}

/**
 * Record `ok:false` and exit, leading the reason with the stable failure kind.
 *
 * The kind prefix keeps `error` greppable for the tools that read this log
 * while the Chinese text after it stays the human explanation.
 * @param logPath - restart log path.
 * @param context - arm id and start time.
 * @param kind - stable failure kind.
 * @param error - cause.
 * @param portReleased - endpoint evidence gathered so far, if any.
 * @returns nothing; the process exits through finish().
 */
function exitFailed(logPath, context, kind, error, portReleased = null) {
  const cause = errorMessage(error)
  return finish(logPath, context, {
    ok: false,
    error: kind + '：' + cause,
    portReleased,
    bootMatched: false,
  })
}


/**
 * The macOS desktop path: quit the shell, reopen it, require the new Host.
 * @param spec - full spec.
 * @param logPath - restart log path.
 * @param context - arm id and start time.
 * @returns nothing; the process exits when the outcome is recorded.
 */
async function runDesktop(spec, logPath, context) {
  const {
    oldPid, cwd, command, healthTimeoutMs = 60000, healthIntervalMs = 500, exitTimeoutMs = 45000,
  } = spec
  // Wait until the plugin has recorded its exit intent after our handshake.
  const deadline = Date.now() + 10000
  let committed = false
  while (Date.now() < deadline) {
    committed = (await readRecords(logPath, 100)).some(row => row.armId === context.armId && row.kind === 'exiting')
    if (committed) break
    await sleep(100)
  }
  if (!committed) throw new Error('桌面重启未提交，保留运行中的应用')
  const exec = promisify(execFile)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  let boot
  await restartDesktop(spec, {
    quit: async appPath => {
      if (desktopExecutable(spec.desktop.shellPid) !== command.execPath) throw new Error('桌面主进程身份已变化')
      // argv carries the path; never interpolate a path into AppleScript source.
      await exec('/usr/bin/osascript', ['-e', 'on run argv\n tell application (item 1 of argv) to quit\nend run', appPath], { timeout: exitTimeoutMs, env })
    },
    wait: (pid, timeoutMs) => waitForExit(pid, { timeoutMs, intervalMs: 250 }),
    open: appPath => exec('/usr/bin/open', ['-a', appPath], { timeout: 10000, env }),
    ready: async () => {
      const until = Date.now() + healthTimeoutMs
      while (Date.now() < until) {
        boot = (await readRecords(logPath, 100)).findLast(row => row.kind === 'boot'
          && row.at > context.startedAt && row.pid !== oldPid && row.desktopConnected === true
          && row.ppid !== spec.desktop.shellPid
          && row.cwd === cwd && row.profile === 'desktop')
        if (boot && desktopExecutable(boot.ppid) === command.execPath && readProcess(boot.pid)?.ppid === boot.ppid) return true
        await sleep(healthIntervalMs)
      }
      return false
    },
  })
  await appendRecord(logPath, { kind: 'supervised', at: Date.now(), armId: context.armId, ok: true,
    newPid: boot.pid, shellPid: boot.ppid, desktopConnected: true, elapsedMs: Date.now() - context.startedAt })
  process.exit(0)
}

/**
 * Run the supervised restart described by a spec file.
 * @param specPath - path to the JSON spec.
 * @returns nothing; the process exits when the outcome is recorded.
 */
async function main(specPath) {
  let spec
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'))
  } catch (error) {
    throw new Error('无法读取 spec 文件：' + errorMessage(error))
  }
  const {
    armId, oldPid, cwd, command, healthUrl,
    healthTimeoutMs = 60000, healthIntervalMs = 500,
    exitTimeoutMs = 45000, exitCommitTimeoutMs = EXIT_COMMIT_TIMEOUT_MS,
    downTimeoutMs = DOWN_TIMEOUT_MS, outLogPath, logPath,
  } = spec
  const startedAt = Date.now()
  const context = { armId, startedAt }

  // Publish where a later crash must report to. The spec is deleted moments
  // from now, and guessing the log file from a filename convention would put
  // the outcome next to the wrong log whenever the plugin configures another
  // path — the plugin polls *this* log for the handshake, so the real path is
  // the only acceptable target.
  reporting = { armId, logPath }

  // Handshake first: the plugin refuses to exit until this record exists, so a
  // failure here leaves the running server untouched.
  await appendRecord(logPath, { kind: 'supervisor', at: startedAt, armId, oldPid, supervisorPid: process.pid })

  // The spec carries the host command line, so it is removed as soon as it has
  // been parsed. Cleanup never blocks the restart, and the command is already
  // in memory, so even a failed unlink costs nothing but a note in the log.
  await unlinkSpec(specPath, logPath, armId)

  // Resources the replacement needs are validated while the host is still up.
  try {
    await preflightOutLog(outLogPath, logPath, armId)
  } catch (error) {
    await exitFailed(logPath, context, error instanceof SupervisorError ? error.kind : 'preflight-failed', error)
    return
  }

  if (spec.desktop) {
    await runDesktop(spec, logPath, context)
    return
  }

  // Endpoint evidence is only gathered when there really is something to
  // observe. A missing or unparseable URL becomes `portReleased: null` instead
  // of a fabricated "not released" or a probe of the empty string.
  const endpoint = parseHealthEndpoint(healthUrl)

  // Gate 1: the host must have committed its own exit for THIS arm. Without
  // that record the host is still running (or the user cancelled), and
  // relaunching would put a duplicate instance next to a live one.
  const commitment = await waitForExitCommit(logPath, armId, {
    timeoutMs: exitCommitTimeoutMs,
    intervalMs: COMMIT_POLL_MS,
  })
  if (commitment !== 'exiting') {
    const reason = commitment === null
      ? '未观测到宿主的 exiting 提交：' + armId + ' 在 ' + exitCommitTimeoutMs
        + 'ms 内没有写下退出记录，宿主应当仍在运行，本次不予拉起'
      : '宿主未提交退出（同一 armId 已记录 ' + commitment + '）：退出已被取消，本次不予拉起'
    await finish(logPath, context, {
      ok: false,
      error: reason,
      portReleased: endpoint.ok ? false : null,
      bootMatched: false,
    })
    return
  }

  // Gate 2: the old pid must really be gone. Launching while it still runs
  // would create exactly the duplicate process this supervisor exists to avoid.
  const exited = await waitForExit(oldPid, { timeoutMs: exitTimeoutMs, intervalMs: 250 })
  if (!exited) {
    // No forced termination here: SIGTERM/SIGKILL escalation is not
    // implemented, so the record states only what happened.
    await finish(logPath, context, {
      ok: false,
      error: '旧进程未在期限内退出（本版本不做强制终止，超时即如实报告失败；此时拉起会造出重复实例）',
      portReleased: endpoint.ok ? false : null,
      bootMatched: false,
    })
    return
  }

  // Evidence only from here on. The host has already exited, so declining to
  // launch is the one outcome that is guaranteed to leave the service down:
  // neither a missing endpoint nor a port that never closes may stop it.
  let portReleased = null
  if (endpoint.ok) {
    portReleased = await waitForDown(endpoint.host, endpoint.port, downTimeoutMs, {
      probeTimeoutMs: 1000,
      intervalMs: 250,
    })
  }

  let fd
  try {
    fd = await open(outLogPath, 'a')
  } catch (error) {
    await exitFailed(logPath, context, 'out-log-unwritable', error, portReleased)
    return
  }

  let newPid = null
  // Anything the replacement writes is written after this instant; a boot
  // record older than it cannot belong to this launch even if the OS handed
  // the same pid to something else.
  const launchedAt = Date.now()
  try {
    newPid = await startReplacement(command, { cwd, fd })
  } catch (error) {
    await exitFailed(logPath, context, error instanceof SupervisorError ? error.kind : 'spawn-failed', error, portReleased)
    return
  }

  // The boot record is the identity proof and the only thing that can make
  // `ok` true. The HTTP probe runs alongside it purely to fill in the reported
  // status code; it never decides the outcome.
  const bootMatchedPromise = waitForBootRecord(logPath, buildReplacementBootMatcher(cwd, newPid, launchedAt), {
    timeoutMs: healthTimeoutMs,
    intervalMs: healthIntervalMs,
    excluded: [oldPid, process.pid],
  })
  const probePromise = endpoint.ok
    ? probeHealth(healthUrl, { timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs })
    : Promise.resolve({ ok: false, statusCode: null, attempts: 0, lastError: '' })
  const [bootMatched, probe] = await Promise.all([bootMatchedPromise, probePromise])

  const ok = bootMatched === true && (portReleased === null || portReleased === true)
  const reasons = []
  let notes = ''
  if (!endpoint.ok) {
    const why = endpoint.kind === 'missing'
      ? 'healthUrl 为空'
      : 'healthUrl 无法解析（' + endpoint.error + '）'
    notes = '没有可观测端点：' + why + '，本次只以新进程自己的 boot 记录做身份确认'
    if (!ok) reasons.push('没有可观测端点（' + why + '）')
  } else if (portReleased === false) {
    // The relaunch really happened, so the reason says so instead of reading
    // like "nothing was attempted".
    reasons.push('端口始终有响应但仍已拉起：' + endpoint.host + ':' + endpoint.port
      + ' 在 ' + downTimeoutMs + 'ms 内 socket 层一直可连接，可能是无关监听者占着该端口，端口证据不支持成功判定')
  }
  if (!bootMatched) {
    reasons.push('新进程未写 boot 记录：日志里没有 pid=' + String(newPid) + ' 的 boot 记录，无法确认服务由本次拉起的新进程提供'
      + '（若该宿主不写 boot 记录，本版本按不可核实处理，不会报成功）')
  }

  await finish(logPath, context, {
    ok,
    newPid,
    statusCode: probe.statusCode,
    attempts: probe.attempts,
    error: ok ? '' : reasons.join('；'),
    notes,
    portReleased,
    bootMatched,
  })
}

/**
 * Locate where a thrown failure must be reported.
 *
 * `main` publishes the real target as soon as the spec is parsed, so anything
 * that fails after that point reports to the plugin's own log. Only a failure
 * before parsing needs the spec re-read, and a spec that cannot be read is
 * still deleted: it may hold a command line the restart never used.
 * @param specPath - spec file path.
 * @returns the reporting target, or null when there is nothing to report to.
 */
async function reportingTarget(specPath) {
  if (reporting !== null) return { ...reporting, specPath, cleanupSpec: false }
  try {
    const spec = JSON.parse(await readFile(specPath, 'utf8'))
    return {
      armId: spec?.armId,
      logPath: typeof spec?.logPath === 'string' ? spec.logPath : '',
      specPath,
      cleanupSpec: true,
    }
  } catch {
    // A torn or missing spec: nothing identifies a log file, but the file
    // itself may still carry a command line, so it is removed regardless.
    return { armId: null, logPath: '', specPath, cleanupSpec: true }
  }
}

// Only run when this file IS the program. Without this guard, importing the
// module (for its exported helpers, in tests) would execute main() and exit
// the importing process with the supervisor's exit code.
const invokedDirectly = typeof process.argv[1] === 'string'
  && process.argv[1] !== ''
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) main(process.argv[2]).catch(async error => {
  let target = null
  try {
    target = await reportingTarget(process.argv[2])
  } catch {
    target = null
  }
  if (target === null) process.exit(1)
  try {
    if (target.cleanupSpec) await unlink(target.specPath).catch(() => {})
    if (target.logPath !== '') {
      await appendRecord(target.logPath, {
        kind: 'supervised',
        at: Date.now(),
        armId: target.armId,
        ok: false,
        error: errorMessage(error),
        notes: '',
        // Nothing gathered any endpoint evidence on this unexpected path.
        portReleased: null,
        bootMatched: false,
      })
    }
  } catch {
    // Nothing left to report to.
  }
  process.exit(1)
});
