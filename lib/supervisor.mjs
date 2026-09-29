/**
 * Detached restart supervisor for dsh-restart.
 *
 * Used only when no KeepAlive launchd job owns the DSH process. It is spawned
 * by the plugin, unref'd, and then survives the plugin's own exit:
 *
 *   1. record a handshake so the plugin can prove a supervisor is really up
 *   2. wait for the old pid to exit (escalating SIGTERM -> SIGKILL)
 *   3. wait for the health endpoint to go down (port released)
 *   4. re-execute the recorded command line with the same cwd and env
 *   5. poll the health endpoint and record the outcome
 *
 * Secrets are never written to disk: the supervisor inherits the plugin's
 * environment, so only the command line and paths go into the spec file.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { restartDesktop, desktopExecutable } from './desktop.js'
import { openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { appendRecord, readRecords } from './log.js'
import { errorMessage, probeHealth, processAlive, readProcess, sleep, waitForExit } from './proc.js'

const EXIT_GRACE_MS = 10000
const DOWN_TIMEOUT_MS = 15000

/**
 * Poll until the health endpoint stops answering.
 * @param url - health URL.
 * @param timeoutMs - bound.
 * @returns true when the endpoint went down.
 */
async function waitForDown(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeHealth(url, { timeoutMs: 800, intervalMs: 200, requestTimeoutMs: 600 })
    if (!probe.ok) return true
    await sleep(250)
  }
  return false
}

/**
 * Stop a pid that outlived its exit deadline.
 * @param pid - process id.
 * @returns true when the process is gone.
 */
async function forceStop(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return true
  }
  if (await waitForExit(pid, { timeoutMs: EXIT_GRACE_MS, intervalMs: 250 })) return true;
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return true
  }
  return waitForExit(pid, { timeoutMs: EXIT_GRACE_MS, intervalMs: 250 })
}

/**
 * Run the supervised restart described by a spec file.
 * @param specPath - path to the JSON spec.
 * @returns nothing; the process exits when the outcome is recorded.
 */
async function main(specPath) {
  const spec = JSON.parse(await readFile(specPath, 'utf8'))
  const {
    armId, oldPid, cwd, command, healthUrl,
    healthTimeoutMs = 60000, healthIntervalMs = 500,
    exitTimeoutMs = 45000, outLogPath, logPath,
  } = spec
  const startedAt = Date.now()

  // Handshake first: the plugin refuses to exit until this record exists, so a
  // failure here leaves the running server untouched.
  await appendRecord(logPath, { kind: 'supervisor', at: startedAt, armId, oldPid, supervisorPid: process.pid })

  if (spec.desktop) {
    // Wait until the plugin has recorded its exit intent after our handshake.
    const deadline = Date.now() + 10000
    let committed = false
    while (Date.now() < deadline) {
      committed = (await readRecords(logPath, 100)).some(row => row.armId === armId && row.kind === 'exiting')
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
            && row.at > startedAt && row.pid !== oldPid && row.desktopConnected === true
            && row.ppid !== spec.desktop.shellPid
            && row.cwd === cwd && row.profile === 'desktop')
          if (boot && desktopExecutable(boot.ppid) === command.execPath && readProcess(boot.pid)?.ppid === boot.ppid) return true
          await sleep(healthIntervalMs)
        }
        return false
      },
    })
    await appendRecord(logPath, { kind: 'supervised', at: Date.now(), armId, ok: true,
      newPid: boot.pid, shellPid: boot.ppid, desktopConnected: true, elapsedMs: Date.now() - startedAt })
    process.exit(0)
  }

  const exited = await waitForExit(oldPid, { timeoutMs: exitTimeoutMs, intervalMs: 250 })
  if (!exited) {
    await appendRecord(logPath, { kind: 'supervised', at: Date.now(), armId, ok: false, error: '旧进程未在期限内退出', forced: true })
    process.exit(1)
  }

  await waitForDown(healthUrl, DOWN_TIMEOUT_MS)

  let fd
  try {
    fd = openSync(outLogPath, 'a')
  } catch (error) {
    await appendRecord(logPath, { kind: 'supervised', at: Date.now(), armId, ok: false, error: '无法打开子进程日志：' + errorMessage(error) })
    process.exit(1)
  }

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
    child.unref()
  } catch (error) {
    await appendRecord(logPath, { kind: 'supervised', at: Date.now(), armId, ok: false, error: '拉起失败：' + errorMessage(error) })
    process.exit(1)
  }

  const probe = await probeHealth(healthUrl, { timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs })
  await appendRecord(logPath, {
    kind: 'supervised',
    at: Date.now(),
    armId,
    ok: probe.ok,
    newPid: child.pid ?? null,
    statusCode: probe.statusCode,
    attempts: probe.attempts,
    error: probe.ok ? '' : probe.lastError,
    elapsedMs: Date.now() - startedAt,
  })
  process.exit(probe.ok ? 0 : 1)
}

main(process.argv[2]).catch(async error => {
  try {
    const spec = JSON.parse(await readFile(process.argv[2], 'utf8'))
    await appendRecord(spec.logPath, { kind: 'supervised', at: Date.now(), armId: spec.armId, ok: false, error: errorMessage(error) })
  } catch {
    // Nothing left to report to.
  }
  process.exit(1)
});
