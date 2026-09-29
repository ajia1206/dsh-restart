/**
 * dsh-restart - one-call restart for the running DSH process.
 *
 * Three tools:
 *   dsh_restart         arm a restart (launchd relaunch, or a detached supervisor)
 *   dsh_restart_status  supervision facts, armed state and the restart history
 *   dsh_restart_cancel  cancel an armed restart before it fires
 *
 * The restart is deliberately not a bare signal. DSH exposes ctx.appExit, which
 * disposes the plugin tree and then lets the process end naturally; launchd
 * (KeepAlive) brings it back. When nothing supervises the process, a detached
 * supervisor is spawned and must complete a handshake BEFORE this process is
 * allowed to exit, so a failed handshake leaves the server running.
 */

import { rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { desktopTarget, desktopExecutable } from './lib/desktop.js'
import { registerRestartRoutes } from './lib/http.js'
import { appendRecord, buildHistory, readRecords } from './lib/log.js'
import { buildPlan } from './lib/plan.js'
import { preflightRecovery, startSupervisor } from './lib/spawn.js'
import {
  errorMessage, findListeningPort, findSupervisorJob, formatCommand,
  parseLaunchctlList, parsePort, probeHealth, readCommand,
  readJobKeepAlive, run, sleep,
} from './lib/proc.js'

/** Cordis plugin name. */
export const name = 'dsh-restart'

/** The tool registry must be ready before tools can be registered. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_PATH = join(HERE, 'lib', 'supervisor.mjs')
const LOG_DIR = join(homedir(), '.dsh', 'logs')

/** Deployment knobs; none of these are inlined in the tool bodies. */
export const Config = Schema.object({
  logPath: Schema.string().default(join(LOG_DIR, 'dsh-restart.log'))
    .description('重启记录（JSONL）：armed -> exiting -> boot 串起来就是一次可核验的重启。'),
  childLogPath: Schema.string().default(join(LOG_DIR, 'dsh-restart-child.log'))
    .description('supervisor 兜底拉起新进程时，子进程 stdout/stderr 的落盘位置。'),
  defaultDelaySeconds: Schema.number().default(10)
    .description('默认延迟秒数：留出时间让工具结果与最终回复送达浏览器，并让会话落盘。'),
  maxDelaySeconds: Schema.number().default(600)
    .description('delaySeconds 的上限，防止误传巨大值。'),
  superviseFallback: Schema.boolean().default(true)
    .description('没有 KeepAlive launchd 托管时，是否派发 detached supervisor 兜底拉起。'),
  healthUrl: Schema.string().default('')
    .description('健康检查 URL；留空则用 --port 推导 http://127.0.0.1:<port>/。'),
  healthTimeoutMs: Schema.number().default(60000)
    .description('supervisor 拉起后等待端口恢复的上限毫秒数。'),
  healthIntervalMs: Schema.number().default(500)
    .description('健康检查轮询间隔毫秒数。'),
  exitTimeoutMs: Schema.number().default(45000)
    .description('supervisor 等待旧进程退出的上限毫秒数；超时不强制终止任何进程，直接如实报告失败。'),
  trustParentJob: Schema.boolean().default(false)
    .description('只有当本进程本身是 launchd 任务的主进程时才走 launchd 直退；'
      + '若该任务的主进程只是本进程的父进程，默认不信它会随本进程退出，改用 supervisor 兜底。'
      + '明确知道自己父进程会随子进程退出时，才把这项打开。'),
  bootHistoryLimit: Schema.number().default(5)
    .description('状态里保留的最近重启次数。'),
})

const stringArray = { type: 'array', required: true, items: { type: 'string' } }

/**
 * Read a service without hard-failing on an inactive context.
 * @param ctx - plugin context.
 * @param key - service key.
 * @returns the service value, or undefined.
 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

/**
 * The invocation inner arguments, from the launcher-owned cmdlineArgs service.
 * @param ctx - plugin context.
 * @returns inner arguments, or an empty list.
 */
function innerArgsOf(ctx) {
  const service = serviceOf(ctx, 'cmdlineArgs')
  const args = service?.get?.()
  return Array.isArray(args) ? [...args] : []
}

/**
 * The launcher's bounded exit request: dispose the tree, then end the process.
 * @param ctx - plugin context.
 * @returns the exit function, or undefined when the launcher provided none.
 */
function appExitOf(ctx) {
  const exit = serviceOf(ctx, 'appExit')
  return typeof exit === 'function' ? exit : undefined
}

/**
 * Collect every host fact the plan and the tools need.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @returns the facts.
 */
async function gatherFacts(ctx, config) {
  const pid = process.pid
  const ppid = process.ppid
  const jobs = parseLaunchctlList(run('launchctl', ['list']))
  const job = findSupervisorJob(pid, ppid, jobs)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const keepAlive = job === null ? null : readJobKeepAlive(job.label, uid)
  const command = readCommand()
  const desktop = desktopTarget({ platform: process.platform, execPath: process.execPath,
    scriptPath: command.scriptPath, ppid, connected: process.connected === true,
    parentExecutable: desktopExecutable(ppid) })
  const cwd = process.cwd()
  const innerArgs = innerArgsOf(ctx)
  const port = parsePort(innerArgs) ?? findListeningPort(pid)
  const healthUrl = config.healthUrl !== ''
    ? config.healthUrl
    : (port === null ? '' : 'http://127.0.0.1:' + port + '/')
  return {
    pid, ppid, jobs, job, keepAlive,
    command, cwd, innerArgs, port, healthUrl, uid, desktop,
    trustParentJob: config.trustParentJob === true,
  }
}

/**
 * Format a timestamp as Beijing time.
 * @param ms - epoch milliseconds.
 * @returns YYYY-MM-DD HH:mm:ss.
 */
function stamp(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Render a millisecond duration compactly.
 * @param ms - duration, or null.
 * @returns a display string.
 */
function duration(ms) {
  if (ms === null || !Number.isFinite(ms)) return '未知'
  if (ms < 1000) return String(ms) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

/**
 * Render the plan as the dsh_restart result shape.
 * @param plan - plan from buildPlan.
 * @param facts - host facts.
 * @param extra - fields that override the defaults.
 * @returns the tool result.
 */
function planResult(plan, facts, extra) {
  return {
    strategy: plan.strategy,
    restartable: plan.restartable,
    pid: facts.pid,
    ppid: facts.ppid,
    label: plan.label ?? '',
    port: facts.port ?? 0,
    healthUrl: facts.healthUrl ?? '',
    command: formatCommand(facts.command),
    cwd: facts.cwd,
    delaySeconds: 0,
    fireAt: '',
    logPath: extra.logPath,
    armed: false,
    dryRun: false,
    warnings: [...plan.warnings],
    notes: [],
    summary: plan.summary,
    ...extra,
  }
}

/**
 * Wait until the supervisor has both handshaken and passed its preflight.
 *
 * The handshake alone is not enough to justify exiting: the supervisor still
 * has to prove that the replacement's log destination is writable, and it
 * publishes that as a separate `supervisor-ready` record for this arm. Waiting
 * for both is what makes a failed preflight keep the service up instead of
 * letting the plugin commit its exit anyway.
 * @param logPath - restart log path.
 * @param armId - arm identifier.
 * @param timeoutMs - bound.
 * @returns true when this arm's supervisor is confirmed ready.
 */
async function waitForSupervisor(logPath, armId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = await readRecords(logPath, 200)
    const forArm = records.filter(record => record.armId === armId)
    // A recorded failure means the exit must not happen at all; stop waiting.
    if (forArm.some(record => record.kind === 'supervised' && record.ok === false)) return false
    const handshake = forArm.some(record => record.kind === 'supervisor')
    const ready = forArm.some(record => record.kind === 'supervisor-ready')
    if (handshake && ready) return true
    await sleep(200)
  }
  return false
}

/**
 * Register the three restart tools.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  const logPath = config.logPath
  let armed = null
  // Distinguishes two arms that reach Date.now() in the same millisecond for the
  // same pid; armId is the correlation key for the whole handshake, so it must
  // not be guessable-by-construction or collide.
  let armSerial = 0

  const profileName = () => {
    const profile = serviceOf(ctx, 'profileContext')
    return typeof profile?.name === 'string' ? profile.name : ''
  }

  const recordBoot = async () => {
    try {
      const facts = await gatherFacts(ctx, config)
      const plan = buildPlan({ ...facts, superviseFallback: config.superviseFallback })
      await appendRecord(logPath, {
        kind: 'boot',
        at: Date.now(),
        pid: facts.pid,
        ppid: facts.ppid,
        mode: plan.strategy,
        label: plan.label,
        profile: profileName(),
        desktopConnected: facts.desktop != null,
        cwd: facts.cwd,
        port: facts.port,
        command: formatCommand(facts.command),
      })
    } catch {
      // A missing boot record must never break startup.
    }
  }

  // The launcher owns the readiness signal; record immediately when absent.
  const ready = serviceOf(ctx, 'appReady')
  if (ready !== undefined && typeof ready.onReady === 'function') {
    try {
      ready.onReady(() => { void recordBoot() })
    } catch {
      void recordBoot()
    }
  } else {
    void recordBoot()
  }

  const fire = async state => {
    if (state.cancelled) return
    state.started = true
    const { plan, facts, armId } = state
    try {
      if (plan.strategy === 'supervisor' || plan.strategy === 'desktop') {
        const specPath = join(dirname(logPath), 'dsh-restart-spec-' + armId + '.json')
        // 0600: the spec carries this process's argv, which can hold tokens.
        await writeFile(specPath, JSON.stringify({
          armId,
          oldPid: facts.pid,
          desktop: facts.desktop,
          cwd: facts.cwd,
          command: facts.command,
          healthUrl: facts.healthUrl,
          healthTimeoutMs: config.healthTimeoutMs,
          healthIntervalMs: config.healthIntervalMs,
          exitTimeoutMs: config.exitTimeoutMs,
          outLogPath: config.childLogPath,
          logPath,
        }, null, 2), { encoding: 'utf8', mode: 0o600 })
        const started = await startSupervisor({
          execPath: process.execPath,
          supervisorPath: SUPERVISOR_PATH,
          specPath,
          cwd: facts.cwd,
          desktop: plan.strategy === 'desktop',
        })
        if (!started) {
          // The supervisor never ran, so nothing else will remove the spec it
          // would have read — and that file carries this process's argv.
          await rm(specPath, { force: true }).catch(() => {})
          await appendRecord(logPath, {
            kind: 'aborted',
            at: Date.now(),
            armId,
            reason: 'supervisor 进程未能启动，已取消退出以保住运行中的服务',
          })
          if (armed === state) armed = null
          return
        }
        const handshake = await waitForSupervisor(logPath, armId, 8000)
        if (!handshake) {
          await appendRecord(logPath, {
            kind: 'aborted',
            at: Date.now(),
            armId,
            reason: 'supervisor 未在 8s 内确认就绪（握手或恢复资源预检未通过），已取消退出以保住运行中的服务',
          })
          if (armed === state) armed = null
          return
        }
      }
      // A cancel that landed while we were waiting must still win: without this
      // recheck the host would commit its exit for a restart the caller revoked.
      if (state.cancelled) {
        if (armed === state) armed = null
        return
      }
      await appendRecord(logPath, {
        kind: 'exiting',
        at: Date.now(),
        armId,
        pid: facts.pid,
        strategy: plan.strategy,
      })
      if (plan.strategy === 'desktop') {
        // The supervisor owns the shell quit; never dispose just its Host.
        const deadline = Date.now() + config.exitTimeoutMs * 2 + config.healthTimeoutMs + 10000
        while (!state.cancelled && Date.now() < deadline) {
          const records = await readRecords(logPath, 100)
          const result = records.findLast(row => row.armId === armId && row.kind === 'supervised')
          if (result) {
            if (!result.ok) await appendRecord(logPath, { kind: 'aborted', at: Date.now(), armId, reason: result.error })
            if (armed === state) armed = null
            return
          }
          await sleep(500)
        }
        if (armed === state) armed = null
        return
      }
      const exit = appExitOf(ctx)
      if (exit !== undefined) {
        exit(0)
        return
      }
      process.kill(process.pid, 'SIGTERM')
    } catch (error) {
      if (armed === state) armed = null
      await appendRecord(logPath, {
        kind: 'aborted',
        at: Date.now(),
        armId,
        reason: '重启执行失败：' + errorMessage(error),
      }).catch(() => {})
    }
  }

  /**
   * Arm one restart. This is the single implementation behind the dsh_restart
   * tool and the browser control's POST route; the two differ only in how the
   * arguments arrive.
   * @param args - delaySeconds, reason and dryRun.
   * @returns the plan result.
   */
  const armRestart = async (args) => {
    const facts = await gatherFacts(ctx, config)
    const plan = buildPlan({ ...facts, superviseFallback: config.superviseFallback })
    const requested = Number.isFinite(args.delaySeconds) ? args.delaySeconds : config.defaultDelaySeconds
    const delaySeconds = Math.max(0, Math.min(Math.round(requested), config.maxDelaySeconds))
    const notes = []

    if (args.dryRun === true) {
      return planResult(plan, facts, { logPath, dryRun: true, delaySeconds })
    }
    if (!plan.restartable) {
      return planResult(plan, facts, { logPath, dryRun: false, notes: ['未安排重启：' + plan.summary] })
    }
    if (armed !== null) {
      notes.push('此前已安排过一次重启（' + stamp(armed.fireAt) + '），本次不重复安排。')
      return planResult(plan, facts, {
        logPath,
        armed: true,
        delaySeconds: armed.delaySeconds,
        fireAt: stamp(armed.fireAt),
        notes,
      })
    }

    // Reserve the slot BEFORE the first await. Everything below — preflight and
    // the armed-record write — suspends, and a second call arriving in that
    // window would otherwise pass the same `armed !== null` check and schedule
    // a second restart with a second timer that only one of them can cancel.
    const at = Date.now()
    const armId = String(at) + '-' + String(facts.pid) + '-' + String(armSerial += 1)
    const fireAt = at + delaySeconds * 1000
    const reason = typeof args.reason === 'string' ? args.reason : ''
    const state = { armId, at, fireAt, delaySeconds, reason, plan, facts, cancelled: false, timer: null }
    armed = state

    // Recovery resources must exist before anything is allowed to exit.
    if (plan.strategy === 'supervisor' || plan.strategy === 'desktop') {
      const blocked = await preflightRecovery(config.childLogPath)
      if (blocked !== null) {
        if (armed === state) armed = null
        notes.push('未安排重启：supervisor 的子进程日志不可写（' + blocked + '）；'
          + '先修好再重启，否则进程退出后拉不起来。')
        return planResult(plan, facts, { logPath, armed: false, notes })
      }
    }

    // Persist the arm BEFORE the timer exists: a log write that fails must not
    // leave a restart scheduled with nothing on disk to explain it.
    try {
      await appendRecord(logPath, {
        kind: 'armed',
        at,
        armId,
        pid: facts.pid,
        ppid: facts.ppid,
        strategy: plan.strategy,
        label: plan.label,
        delaySeconds,
        reason,
        profile: profileName(),
        command: formatCommand(facts.command),
        cwd: facts.cwd,
        port: facts.port,
      })
    } catch (error) {
      if (armed === state) armed = null
      notes.push('未安排重启：写入重启记录失败（' + errorMessage(error) + '）。')
      return planResult(plan, facts, { logPath, armed: false, notes })
    }

    state.timer = setTimeout(() => { void fire(state) }, delaySeconds * 1000)
    state.timer.unref?.()

    notes.push('重启记录（armed -> exiting -> boot）写入 ' + logPath + '，重启后用 dsh_restart_status 复核。')
    if (plan.strategy === 'supervisor') {
      notes.push('无 KeepAlive 托管：届时先派发 detached supervisor 并完成握手；握手失败会取消退出，服务保持运行。')
    }
    if (facts.healthUrl === '') {
      notes.push('没有可探测的端点（读不到 --port 且 healthUrl 为空）：拉起仍会执行，'
        + '但"服务已恢复"只能由新进程自己写的 boot 记录来确认，不会有端口层面的证据。')
    }
    if (delaySeconds > 0) {
      notes.push('在 ' + stamp(fireAt) + ' 之前调用 dsh_restart_cancel 可以取消。')
    }

    return planResult(plan, facts, {
      logPath,
      armed: true,
      delaySeconds,
      fireAt: stamp(fireAt),
      notes,
    })
  }

  /**
   * Cancel the armed restart. Shared by the dsh_restart_cancel tool and the
   * browser control's cancel route.
   * @returns the cancellation result.
   */
  const cancelRestart = async () => {
    if (armed === null) {
      return { cancelled: false, wasArmed: false, fireAt: '', logPath, notes: ['当前没有已安排的重启。'] }
    }
    const state = armed
    if (state.started) return { cancelled: false, wasArmed: true, fireAt: stamp(state.fireAt), logPath,
      notes: ['重启已经开始；桌面任务退出确认仍可取消退出。'] }
    armed = null
    state.cancelled = true
    if (state.timer !== null) clearTimeout(state.timer)
    await appendRecord(logPath, {
      kind: 'cancelled',
      at: Date.now(),
      armId: state.armId,
      pid: process.pid,
      reason: '调用方取消',
    })
    return {
      cancelled: true,
      wasArmed: true,
      fireAt: stamp(state.fireAt),
      logPath,
      notes: ['已取消原定于 ' + stamp(state.fireAt) + ' 的重启，服务继续运行。'],
    }
  }

  /**
   * Read supervision facts, the armed state and the restart history. Shared by
   * the dsh_restart_status tool and the browser control's status route.
   * @returns the status object.
   */
  const readStatus = async () => {
    const facts = await gatherFacts(ctx, config)
    const plan = buildPlan({ ...facts, superviseFallback: config.superviseFallback })
    const records = await readRecords(logPath, 400)
    const history = buildHistory(records, config.bootHistoryLimit)
    const boots = records.filter(record => record.kind === 'boot')
    const lastRestart = history.restarts.length > 0 ? history.restarts[history.restarts.length - 1] : null

    let portResponds = false
    if (facts.healthUrl !== '') {
      const probe = await probeHealth(facts.healthUrl, { timeoutMs: 2500, intervalMs: 400, requestTimeoutMs: 1200 })
      portResponds = probe.ok
    }

    const notes = []
    if (boots.length === 0) notes.push('日志里还没有 boot 记录：这是本插件第一次使用这个日志文件。')
    if (lastRestart === null && boots.length > 0) notes.push('还没有一次由本插件发起的重启被记录完成。')
    if (history.lastAbort !== null) {
      notes.push('最近一次中断：' + (history.lastAbort.reason ?? '未说明') + '（' + stamp(history.lastAbort.at) + '）')
    }
    if (history.lastSupervised !== null) {
      notes.push('最近一次 supervisor 兜底拉起：' + (history.lastSupervised.ok ? '成功' : '失败')
        + (history.lastSupervised.error ? '（' + history.lastSupervised.error + '）' : ''))
    }
    if (plan.strategy === 'launchd') {
      notes.push('launchd 会在本进程退出后立即拉起，无需外部守护。')
    }

    const summary = lastRestart === null
      ? '尚无已完成的重启记录。'
      : '最近一次重启 ' + stamp(lastRestart.at) + ' 成功，停机 ' + duration(lastRestart.downtimeMs) + '。'

    return {
      pid: facts.pid,
      ppid: facts.ppid,
      uptimeSeconds: Math.round(process.uptime()),
      strategy: plan.strategy,
      restartable: plan.restartable,
      label: plan.label ?? '',
      port: facts.port ?? 0,
      healthUrl: facts.healthUrl ?? '',
      portResponds,
      command: formatCommand(facts.command),
      cwd: facts.cwd,
      logPath,
      armed: armed !== null,
      armedFireAt: armed === null ? '' : stamp(armed.fireAt),
      armedDelaySeconds: armed === null ? 0 : armed.delaySeconds,
      armedReason: armed === null ? '' : armed.reason,
      bootCount: boots.length,
      lastBootAt: history.lastBoot === null ? '' : stamp(history.lastBoot.at),
      lastBootPid: history.lastBoot === null ? 0 : history.lastBoot.pid,
      lastBootMode: history.lastBoot === null ? '' : (history.lastBoot.mode ?? ''),
      previousBootAt: history.previousBoot === null ? '' : stamp(history.previousBoot.at),
      lastRestartAt: lastRestart === null ? '' : stamp(lastRestart.at),
      lastRestartDowntimeMs: lastRestart === null || lastRestart.downtimeMs === null ? 0 : lastRestart.downtimeMs,
      lastRestartReason: lastRestart === null ? '' : lastRestart.restartedFrom.reason,
      supervisedOk: history.lastSupervised === null ? false : history.lastSupervised.ok === true,
      supervisedError: history.lastSupervised === null ? '' : (history.lastSupervised.error ?? ''),
      restarts: history.restarts.map(restart => ({
        at: stamp(restart.at),
        pid: restart.pid,
        downtimeMs: restart.downtimeMs ?? 0,
        reason: restart.restartedFrom.reason,
      })),
      recentRecords: records.slice(-8).map(record =>
        stamp(record.at) + ' ' + record.kind
        + (record.strategy ? ' strategy=' + record.strategy : '')
        + (record.pid ? ' pid=' + record.pid : '')
        + (record.reason ? ' ' + record.reason : '')),
      notes,
      summary,
    }
  }

  ctx.tools.register(defineTool({
    name: 'dsh_restart',
    description: [
      'Restart the running DSH process so plugin source changes take effect. Adding or',
      'removing a profile bundle hot-mounts immediately, but HMR runs with root: [] —',
      'config watching only — so edits to an already-mounted plugin need a restart.',
      'The browser connection drops and DSH comes back with the same command line,',
      'working directory, environment and profile.',
      'The restart is armed immediately but fires after delaySeconds (default 10) so this',
      'tool result and your final reply can reach the client first; sessions are flushed',
      'by the graceful shutdown. After calling this, reply with one short line and make no',
      'further tool calls. Use dryRun to inspect the plan without arming anything.',
    ].join(' '),
    parameters: {
      delaySeconds: { type: 'integer', description: 'Seconds to wait before restarting. Defaults to the configured value (10).' },
      reason: { type: 'string', description: 'Short note recorded in the restart log, e.g. what was just installed.' },
      dryRun: { type: 'boolean', description: 'Only report the plan; do not arm a restart.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          strategy: { type: 'string', required: true },
          restartable: { type: 'boolean', required: true },
          pid: { type: 'integer', required: true },
          ppid: { type: 'integer', required: true },
          label: { type: 'string', required: true },
          port: { type: 'integer', required: true },
          healthUrl: { type: 'string', required: true },
          command: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          delaySeconds: { type: 'integer', required: true },
          fireAt: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          armed: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          warnings: stringArray,
          notes: stringArray,
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          '重启计划：' + value.summary,
          '- 策略：' + value.strategy + '（pid ' + value.pid + '，ppid ' + value.ppid + '）',
          '- 启动命令：' + value.command,
          '- 工作目录：' + value.cwd,
        ]
        if (value.port !== 0) lines.push('- 端口：' + value.port + '（健康检查 ' + value.healthUrl + '）')
        if (value.label !== '') lines.push('- launchd 任务：' + value.label)
        if (value.dryRun) {
          lines.push('- dryRun：未安排重启。')
        } else if (value.armed) {
          lines.push('- 已安排：' + value.fireAt + '（' + value.delaySeconds + 's 后）重启')
          lines.push('- 取消：调用 dsh_restart_cancel')
        }
        for (const warning of value.warnings) lines.push('- ⚠ ' + warning)
        for (const note of value.notes) lines.push('- ' + note)
        lines.push('- 记录：' + value.logPath)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return await armRestart(args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_restart_cancel',
    description: [
      'Cancel an armed dsh_restart before it fires. Use when a restart was scheduled by',
      'mistake or when more work must finish first. Reports whether anything was armed.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cancelled: { type: 'boolean', required: true },
          wasArmed: { type: 'boolean', required: true },
          fireAt: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          notes: stringArray,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // cancelled:false has two very different causes — nothing was armed,
        // or the restart already started and can no longer be cancelled — so
        // the host's own explanation is what gets shown.
        text: value.cancelled
          ? '已取消原定于 ' + value.fireAt + ' 的重启。'
          : (value.notes?.[0] ?? '当前没有已安排的重启，无需取消。'),
      }],
    },
    async execute() {
      return await cancelRestart()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_restart_status',
    description: [
      'Report how this DSH process is supervised, whether a restart is currently armed,',
      'and the restart history recorded in the restart log.',
      'Use it to verify that a previous restart actually happened: each boot record carries',
      'the pid and the measured downtime of the restart that produced it.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          ppid: { type: 'integer', required: true },
          uptimeSeconds: { type: 'integer', required: true },
          strategy: { type: 'string', required: true },
          restartable: { type: 'boolean', required: true },
          label: { type: 'string', required: true },
          port: { type: 'integer', required: true },
          healthUrl: { type: 'string', required: true },
          portResponds: { type: 'boolean', required: true },
          command: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          armed: { type: 'boolean', required: true },
          armedFireAt: { type: 'string', required: true },
          armedDelaySeconds: { type: 'integer', required: true },
          armedReason: { type: 'string', required: true },
          bootCount: { type: 'integer', required: true },
          lastBootAt: { type: 'string', required: true },
          lastBootPid: { type: 'integer', required: true },
          lastBootMode: { type: 'string', required: true },
          previousBootAt: { type: 'string', required: true },
          lastRestartAt: { type: 'string', required: true },
          lastRestartDowntimeMs: { type: 'integer', required: true },
          lastRestartReason: { type: 'string', required: true },
          supervisedOk: { type: 'boolean', required: true },
          supervisedError: { type: 'string', required: true },
          restarts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                downtimeMs: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          recentRecords: stringArray,
          notes: stringArray,
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          '重启状态：' + value.summary,
          '- 进程：pid ' + value.pid + '（ppid ' + value.ppid + '），已运行 ' + value.uptimeSeconds + 's',
          '- 托管：' + value.strategy + (value.label !== '' ? '（' + value.label + '）' : ''),
          '- 启动命令：' + value.command,
        ]
        if (value.port !== 0) {
          lines.push('- 端口 ' + value.port + '：' + (value.portResponds ? '有响应' : '无响应'))
        }
        if (value.armed) {
          lines.push('- 已安排重启：' + value.armedFireAt + '（' + value.armedDelaySeconds + 's 后）'
            + (value.armedReason !== '' ? '，原因：' + value.armedReason : ''))
        }
        if (value.restarts.length > 0) {
          lines.push('- 最近重启：')
          for (const restart of value.restarts) {
            lines.push('  - ' + restart.at + ' · pid ' + restart.pid
              + ' · 停机 ' + duration(restart.downtimeMs)
              + (restart.reason !== '' ? ' · ' + restart.reason : ''))
          }
        } else {
          lines.push('- 最近重启：日志里还没有完成过一次重启')
        }
        for (const note of value.notes) lines.push('- ' + note)
        lines.push('- 记录：' + value.logPath)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return await readStatus()
    },
  }))

  // A pending arm must not outlive the plugin: unloading the bundle while a
  // restart is scheduled would otherwise fire a timer nobody can cancel.
  ctx.effect(() => () => {
    if (armed !== null) {
      if (armed.timer !== null) clearTimeout(armed.timer)
      armed.cancelled = true
      armed = null
    }
  }, 'dsh-restart: pending restart timer')

  // The browser control is web-only, so webServer is injected optionally
  // instead of being declared in the inject list: headless and other
  // surfaces keep the three tools and never wait on a web server.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerRestartRoutes(webCtx, {
      arm: args => armRestart({
        delaySeconds: typeof args.delaySeconds === 'number' ? args.delaySeconds : undefined,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      }),
      cancel: () => cancelRestart(),
      status: () => readStatus(),
    }), 'dsh-restart: browser control routes')
  })
}
