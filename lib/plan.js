/**
 * Decide how this process can be brought back after it exits.
 *
 * Four strategies exist:
 *   launchd     a KeepAlive launchd job owns THIS process (it is the job's
 *               main process), so a graceful exit is all that is needed.
 *   supervisor  nothing is proven to own the process, so dsh-restart spawns a
 *               detached supervisor that waits for this pid to exit and
 *               re-executes the recorded command line.
 *   desktop     a macOS desktop app owns this process: the app is quit and
 *               reopened instead of re-executing a command line.
 *   none        restart is refused (no proven supervision and the supervisor
 *               fallback is disabled, or the desktop host cannot be confirmed).
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
    superviseFallback = true, trustParentJob = false,
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

  // launchd restarts the job's MAIN process. Only "this pid IS that main
  // process" proves that our exit is followed by a restart. Matching the direct
  // parent proves nothing on its own: a parent need not exit when its child
  // does, so exiting on that basis can take the service down for good.
  const isJobMainProcess = job !== null && job.pid === pid
  const isJobParent = job !== null && !isJobMainProcess && job.pid === ppid

  if (job !== null && keepAlive === true && (isJobMainProcess || (isJobParent && trustParentJob === true))) {
    if (isJobParent) {
      warnings.push(
        '本进程不是 launchd 任务 ' + job.label + ' 的主进程，只匹配到直接父进程：'
        + '本策略依赖父进程随本进程一起退出，这是配置项 trustParentJob 显式放行的假设，'
        + '若父进程不退出，launchd 不会重新拉起服务。',
      )
    }
    return {
      ...base,
      strategy: 'launchd',
      jobPid: job.pid,
      restartable: true,
      warnings,
      summary: isJobMainProcess
        ? 'launchd 任务 ' + job.label + ' 持有本进程（本进程即该任务的进程，KeepAlive=true）：'
          + '优雅退出后由 launchd 立即拉起，无需外部守护。'
        : 'launchd 任务 ' + job.label + ' 的主进程是本进程的父进程（KeepAlive=true）：'
          + '按 trustParentJob 放行的假设，父进程随本进程退出后由 launchd 立即拉起。',
    }
  }

  if (job === null) {
    warnings.push('本进程没有 launchd 任务托管（可能是手动启动的 pnpm dsh），退出后不会自动拉起。')
  } else if (keepAlive === false) {
    warnings.push('launchd 任务 ' + job.label + ' 存在但未开启 KeepAlive：退出后不会自动拉起。')
  } else if (keepAlive !== true) {
    warnings.push('无法确认 launchd 任务 ' + job.label + ' 的 KeepAlive 属性。')
  } else if (isJobParent) {
    warnings.push(
      'launchd 任务 ' + job.label + ' 只匹配到本进程的父进程（KeepAlive=true）：'
      + '无法证明该任务的主进程会随本进程退出，launchd 重启的是 job 主进程，'
      + '因此不采用 launchd 策略，改用 detached supervisor 兜底。',
    )
  } else {
    warnings.push('launchd 任务 ' + job.label + ' 的 KeepAlive 已开启，但无法确认它持有的就是本进程。')
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
