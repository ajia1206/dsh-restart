/**
 * Recovery resources and the detached supervisor launch.
 *
 * Both live here rather than in index.js so they can be unit-tested without
 * booting DSH: nothing in this module imports @deepseek-ai/*.
 */

import { spawn } from 'node:child_process'
import { constants as FS } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Confirm the supervisor will be able to write the replacement's output
 * BEFORE the old process is ever allowed to exit.
 *
 * The supervisor opens childLogPath after the old process is gone: if that
 * destination is missing or unwritable, the host is already down and nothing
 * brings it back. Failing here instead costs nothing — the service is up.
 * @param childLogPath - the supervisor's child stdout/stderr sink.
 * @returns null when ready, otherwise a human-readable reason.
 */
export async function preflightRecovery(childLogPath) {
  try {
    await mkdir(dirname(childLogPath), { recursive: true })
    await access(dirname(childLogPath), FS.W_OK)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  try {
    await access(childLogPath, FS.W_OK)
  } catch (error) {
    if (error?.code !== 'ENOENT') return error instanceof Error ? error.message : String(error)
  }
  return null
}

/**
 * Spawn the detached supervisor and wait until the OS confirms it started.
 *
 * A spawn failure is delivered as an asynchronous 'error' event, so a plain
 * try/catch around spawn() would miss it and leave the arm half-executed: the
 * plugin would then wait for a handshake that can never arrive. Node emits
 * exactly one of 'spawn' or 'error' for every attempt, so this settles once.
 * @param options - execPath, supervisorPath, specPath, cwd and desktop flag.
 * @returns true once the child process really started.
 */
export function startSupervisor(options) {
  const { execPath, supervisorPath, specPath, cwd, desktop = false, env = process.env } = options
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(execPath, [supervisorPath, specPath], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: desktop ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
      })
    } catch {
      finish(false)
      return
    }
    child.once('error', () => finish(false))
    child.once('spawn', () => {
      child.unref()
      finish(true)
    })
  })
}
