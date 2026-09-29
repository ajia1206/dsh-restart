/**
 * Decide how this process can be brought back after it exits.
 *
 * Two strategies exist:
 *   launchd     a KeepAlive launchd job owns this process (or an ancestor),
 *               so a graceful exit is all that is needed.
 *   supervisor  nothing owns the process, so dsh-restart spawns a detached
 *               supervisor that waits for this pid to exit and re-executes
 *               the recorded command line.
 *
 * The decision is a pure function of observed facts so it can be tested
 * without touching a real process.
 */

/**
 * Build the restart plan.
 * @param facts - pid, ancestors, owning launchd job, KeepAlive, command, cwd, port and config.
 * @returns the plan, including the chosen strategy and any warnings.
 */
export function buildPlan(facts) {
  const {
    pid, ppid, job = null, keepAlive = null, command, cwd, port = null,
    superviseFallback = true,
  } = facts
  const warnings = []
  const base = { pid, ppid, command, cwd, port, label: job === null ? null : job.label }

  if (facts.desktop !== undefined) {
    return { ...base, strategy: facts.desktop === null ? 'none' : 'desktop',
      restartable: facts.desktop !== null, warnings,
      summary: facts.desktop === null
        ? '拒绝重启：无法确认桌面主进程及 IPC 连接，请使用桌面原生重启菜单。'
        : '退出并重新打开桌面应用，由 Electron 创建 Host 并恢复 IPC；有任务时保留原生退出确认。' }
  }

  if (job !== null && keepAlive === true) {
    return {
      ...base,
      strategy: 'launchd',
      jobPid: job.pid,
      restartable: true,
      warnings,
      summary:
        'launchd 任务 ' + job.label + ' 持有本进程（KeepAlive=true）：'
        + '优雅退出后由 launchd 立即拉起，无需外部守护。',
    }
  }

  if (job === null) {
    warnings.push('本进程没有 launchd 任务托管（可能是手动启动的 pnpm dsh），退出后不会自动拉起。')
  } else if (keepAlive === false) {
    warnings.push('launchd 任务 ' + job.label + ' 存在但未开启 KeepAlive：退出后不会自动拉起。')
  } else {
    warnings.push('无法确认 launchd 任务 ' + job.label + ' 的 KeepAlive 属性。')
  }

  if (!superviseFallback) {
    return {
      ...base,
      strategy: 'none',
      jobPid: job === null ? null : job.pid,
      restartable: false,
      warnings,
      summary: '拒绝重启：没有可确认的 KeepAlive 托管，且 superviseFallback=false。',
    }
  }

  return {
    ...base,
    strategy: 'supervisor',
    jobPid: job === null ? null : job.pid,
    restartable: true,
    warnings,
    summary:
      '将派发 detached supervisor：等本进程退出后用同一 execPath/execArgv/argv/cwd/env 拉起，'
      + '再对端口做健康检查，结果写入重启日志。',
  }
}

/**
 * Whether a strategy exits the process by asking DSH to shut down gracefully.
 * @param strategy - plan strategy.
 * @returns true when the plugin should call ctx.appExit.
 */
export function usesGracefulExit(strategy) {
  return strategy === 'launchd' || strategy === 'supervisor'
}
