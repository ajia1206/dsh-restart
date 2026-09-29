/**
 * Detached restart supervisor for dsh-restart.
 *
 * Used only when no KeepAlive launchd job owns the DSH process. It is spawned
 * by the plugin, unref'd, and then survives the plugin's own exit:
 *
 *   1. read the spec, delete it, then record a handshake so the plugin can
 *      prove a supervisor is really up; preflight the recovery resources
 *      before the host is allowed to leave
 *   2. wait for the old pid to exit (report honestly when it does not)
 *   3. wait for the old endpoint to stop answering (port released)
 *   4. spawn the replacement and only continue once the spawn really succeeded
 *   5. confirm the replacement's own boot record, then record the outcome
 *
 * Secrets are never written to disk: the supervisor inherits the plugin's
 * environment, so only the command line and paths go into the spec file, and
 * that file is unlinked as soon as it has been read.
 *
 * Success rule: `ok` needs an observed port release AND a boot record whose
 * `pid` is the replacement we started. Port release alone proves only that
 * nothing answers any more; the boot record is the replacement's own "I am
 * ready" evidence and rules out an unrelated listener that happened to take
 * the port. Hosts that write no boot record therefore degrade to a recorded
 * failure instead of an unverifiable success; the record carries
 * `portReleased` / `bootMatched` and the reason spells the downgrade out.
 */

import { spawn, execFile } from 'node:child_process'
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { restartDesktop, desktopExecutable } from './desktop.js'
import { appendRecord, readRecords } from './log.js'
import { errorMessage, probeHealth, readProcess, waitForExit } from './proc.js'

const DOWN_TIMEOUT_MS = 15000
const SPEC_DELETE_ATTEMPTS = 3

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
 * Poll until the health endpoint stops answering.
 *
 * "Stopped answering" is the observable proxy for "the port is released" that
 * this process can obtain without guessing: a listener that keeps replying —
 * including with HTTP 5xx — still holds the port, since the reference web
 * server answers 401/404 while 5xx means something is listening and failing.
 * @param url - health URL.
 * @param timeoutMs - bound.
 * @returns true when the endpoint went down.
 */
async function waitForDown(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeHealth(url, { timeoutMs: 1000, intervalMs: 200, requestTimeoutMs: 800 })
    if (!probe.ok) return true
    await sleep(250)
  }
  return false
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
 * `ok` derives from both facts of a verifiable replacement: the port was
 * observed released, and the replacement published its own boot record.
 * Writing `ok:true` with either missing would be a lie, so both are also
 * reported as their own booleans for downstream consumers.
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
    portReleased: outcome.portReleased === true,
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
 * @returns nothing; the process exits through finish().
 */
function exitFailed(logPath, context, kind, error) {
  const cause = errorMessage(error)
  return finish(logPath, context, {
    ok: false,
    error: kind + '：' + cause,
    portReleased: false,
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
    exitTimeoutMs = 45000, outLogPath, logPath,
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

  const exited = await waitForExit(oldPid, { timeoutMs: exitTimeoutMs, intervalMs: 250 })
  if (!exited) {
    // No forced termination here: SIGTERM/SIGKILL escalation is not
    // implemented, so the record states only what happened.
    await finish(logPath, context, {
      ok: false,
      error: '旧进程未在期限内退出（本版本不做强制终止，超时即如实报告失败）',
      portReleased: false,
      bootMatched: false,
    })
  }

  if (typeof healthUrl !== 'string' || healthUrl === '') {
    // The plugin passes an empty URL when it could neither read --port nor get
    // a configured healthUrl. Probing '' would fail for an unrelated reason,
    // so say plainly that there is nothing to probe.
    await finish(logPath, context, {
      ok: false,
      error: '没有可探测的端点：healthUrl 为空，且未能从 --port 推导出端口，无法验证新进程已就绪',
      portReleased: false,
      bootMatched: false,
    })
  }

  // `portReleased` is a precondition, not advice: without it, anything that
  // answers the probe may be an unrelated listener and the restart cannot be
  // called verifiable.
  const portReleased = await waitForDown(healthUrl, DOWN_TIMEOUT_MS)

  if (!portReleased) {
    const probe = await probeHealth(healthUrl, { timeoutMs: 1000, intervalMs: 200, requestTimeoutMs: 800 })
    const cause = probe.lastError === '' ? '' : '（最后响应：' + probe.lastError + '）'
    await finish(logPath, context, {
      ok: false,
      statusCode: probe.statusCode,
      attempts: probe.attempts,
      error: '未观测到旧端口释放：' + healthUrl + ' 在 ' + DOWN_TIMEOUT_MS + 'ms 内始终有响应'
        + cause + '，可能仍有别的监听者占着该端口，本次重启不予采信',
      portReleased: false,
      bootMatched: false,
    })
  }

  let fd
  try {
    fd = await open(outLogPath, 'a')
  } catch (error) {
    await exitFailed(logPath, context, 'out-log-unwritable', error)
    return
  }

  let newPid = null
  try {
    newPid = await startReplacement(command, { cwd, fd })
  } catch (error) {
    await exitFailed(logPath, context, error instanceof SupervisorError ? error.kind : 'spawn-failed', error)
    return
  }

  const probe = await probeHealth(healthUrl, { timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs })
  // Identity check: the replacement's own boot record, never a boot of the old
  // host nor of an unrelated process that merely took the port.
  const bootMatched = await waitForBootRecord(logPath, buildBootMatcher(cwd), {
    timeoutMs: healthTimeoutMs,
    intervalMs: healthIntervalMs,
    excluded: [oldPid, process.pid],
  })

  if (!probe.ok) {
    await finish(logPath, context, {
      ok: false,
      newPid,
      statusCode: probe.statusCode,
      attempts: probe.attempts,
      error: probe.lastError,
      portReleased,
      bootMatched: false,
    })
    return
  }

  if (!bootMatched) {
    await finish(logPath, context, {
      ok: false,
      newPid,
      statusCode: probe.statusCode,
      attempts: probe.attempts,
      error: '端口已重新响应，但日志里没有 pid=' + String(newPid) + ' 的 boot 记录：无法确认服务由本次拉起的新进程提供'
        + '（若该宿主不写 boot 记录，本版本按不可核实处理，不会报成功）',
      portReleased,
      bootMatched: false,
    })
    return
  }

  await finish(logPath, context, {
    ok: true,
    newPid,
    statusCode: probe.statusCode,
    attempts: probe.attempts,
    error: '',
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

main(process.argv[2]).catch(async error => {
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
        portReleased: false,
        bootMatched: false,
      })
    }
  } catch {
    // Nothing left to report to.
  }
  process.exit(1)
});
