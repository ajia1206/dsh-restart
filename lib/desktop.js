import { run } from './proc.js'

/** Read only the executable path, excluding launch flags and deep links. */
export function desktopExecutable(pid) {
  return run('ps', ['-o', 'comm=', '-p', String(pid)]).trim()
}

/** A desktop Host must be restarted together with its IPC-owning Electron shell. */
export function desktopTarget({ platform, execPath, scriptPath, ppid, connected, parentExecutable }) {
  if (!scriptPath?.includes('/dsh-desktop-host/')) return undefined
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  if (platform !== 'darwin' || !match || !connected || ppid <= 1 || parentExecutable !== execPath) return null
  return { appPath: match[1], shellPid: ppid }
}

/** Quit through macOS so Electron retains its task/quit confirmation behavior. */
export async function restartDesktop(spec, io) {
  await io.quit(spec.desktop.appPath)
  if (!await io.wait(spec.desktop.shellPid, spec.exitTimeoutMs)
    || !await io.wait(spec.oldPid, spec.exitTimeoutMs)) {
    throw new Error('桌面退出被取消或超时；未强制终止，也未启动第二个 Host')
  }
  await io.open(spec.desktop.appPath)
  if (!await io.ready(spec)) throw new Error('桌面已请求启动，但未验证新的 shell/Host IPC 连接')
}
