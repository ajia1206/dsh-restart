/**
 * Append-only JSONL restart log plus the history view built from it.
 *
 * Every restart is reconstructable from this file alone: armed -> exiting ->
 * (process dies) -> boot. That is what makes the restart verifiable instead of
 * a fire-and-forget signal.
 *
 * The log is append-only on purpose, and records are correlated by `armId`
 * (plus pid and profile) rather than by position: several profiles share one
 * default log, and a crash can leave a torn line behind, so "the next boot
 * after an exit" is not evidence of anything by itself.
 */

import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Read at most this much of the tail of a long log. */
const MAX_READ_BYTES = 512 * 1024

/**
 * How long after an exit a boot may still complete that restart.
 *
 * Without a bound, an arm whose replacement never returned would keep waiting
 * and could eventually be credited with an unrelated boot from much later.
 */
const PAIRING_WINDOW_MS = 120000

/**
 * Whether the file currently ends mid-line (a crash during an earlier write).
 * @param logPath - log file path.
 * @returns true when a newline must be written before the next record.
 */
async function endsWithoutNewline(logPath) {
  let handle
  try {
    const info = await stat(logPath)
    if (info.size === 0) return false
    handle = await open(logPath, 'r')
    const buffer = Buffer.alloc(1)
    await handle.read(buffer, 0, 1, info.size - 1)
    return buffer[0] !== 0x0a
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    // A stray blank line is harmless; a swallowed record is not.
    return true
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Append one record.
 *
 * A torn final line is closed before the new record is written: appending onto
 * it would merge the two and the reader would discard both as malformed.
 * @param logPath - log file path.
 * @param record - JSON-serializable record.
 * @returns the record that was written.
 */
export async function appendRecord(logPath, record) {
  await mkdir(dirname(logPath), { recursive: true })
  const needsNewline = await endsWithoutNewline(logPath)
  const line = (needsNewline ? '\n' : '') + JSON.stringify(record) + '\n'
  // 0600: records carry the process command line, which can hold credentials.
  await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 })
  return record
}

/**
 * Read the most recent records, oldest first.
 *
 * Only the tail of a long log is read, and the fragment before the first
 * newline in that window is dropped rather than parsed.
 * @param logPath - log file path.
 * @param limit - maximum records returned.
 * @returns parsed records; malformed lines are skipped.
 */
export async function readRecords(logPath, limit = 400) {
  let text
  try {
    const info = await stat(logPath)
    if (info.size > MAX_READ_BYTES) {
      const start = info.size - MAX_READ_BYTES
      const handle = await open(logPath, 'r')
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, start)
        const window = buffer.subarray(0, bytesRead).toString('utf8')
        const firstBreak = window.indexOf('\n')
        text = firstBreak === -1 ? '' : window.slice(firstBreak + 1)
      } finally {
        await handle.close()
      }
    } else {
      text = await readFile(logPath, 'utf8')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      // A bare `null` or a scalar is valid JSON but not a record.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed)
      }
    } catch {
      // A crash can leave one torn line; the rest of the file is still valid.
    }
  }
  return records.slice(-limit)
}

/**
 * Whether an exit record can belong to an armed record.
 *
 * Records written before `armId` existed carry no correlation, so they fall
 * back to positional pairing; anything with an armId must match exactly.
 * @param armed - the pending armed record.
 * @param record - candidate exiting record.
 * @returns true when the exit belongs to this arm.
 */
function sameArm(armed, record) {
  if (armed === null) return false
  if (armed.armId === undefined) return true
  if (record.armId !== armed.armId) return false
  // The exiting record names the process that was about to exit; it has to be
  // the process this arm belonged to.
  if (armed.pid !== undefined && record.pid !== undefined && record.pid !== armed.pid) return false
  return true
}

/**
 * Whether a boot can be the replacement that an armed restart was waiting for.
 *
 * The replacement is a different process (so the pid must differ) in the same
 * profile. An empty profile on either side means "unknown" and is allowed: a
 * missing profile name must not silently break the history.
 *
 * When the supervisor recorded the pid it started (`supervised.newPid`), that
 * pid is authoritative: a boot from any other process is not this restart's
 * replacement, no matter how plausible it looks.
 * @param armed - the pending armed record.
 * @param exit - the matching exiting record.
 * @param boot - the candidate boot record.
 * @param supervised - the arm's supervised record, or null.
 * @returns true when the boot completes that restart.
 */
function completesRestart(armed, exit, boot, supervisedRecord) {
  if (boot.pid === undefined || exit.pid === undefined) return false
  if (boot.pid === exit.pid) return false
  if (supervisedRecord !== null && supervisedRecord.newPid !== undefined
    && boot.pid !== supervisedRecord.newPid) return false
  const armedProfile = typeof armed.profile === 'string' ? armed.profile : ''
  const bootProfile = typeof boot.profile === 'string' ? boot.profile : ''
  return armedProfile === '' || bootProfile === '' || armedProfile === bootProfile
}

/**
 * Whether a boot is known to belong to a different profile than the arm.
 * @param armed - the pending armed record.
 * @param boot - the candidate boot record.
 * @returns true when both sides name a profile and the names differ.
 */
function foreignProfile(armed, boot) {
  const armedProfile = typeof armed?.profile === 'string' ? armed.profile : ''
  const bootProfile = typeof boot?.profile === 'string' ? boot.profile : ''
  return armedProfile !== '' && bootProfile !== '' && armedProfile !== bootProfile
}

/**
 * Reconstruct boots and restarts from the record stream.
 *
 * A boot counts as a completed restart only when the same arm produced a
 * matching exiting record, a DIFFERENT pid came back, and no `supervised`
 * record for that arm reported a failure. Unrelated activity — another
 * profile's boot, a hot-mount boot in the same process, a crash — must never
 * be presented as a successful restart.
 *
 * `downtimeMs` measures the interval from writing `exiting` to the
 * replacement's boot record. It includes graceful-shutdown time, so it is not
 * a measurement of HTTP unavailability.
 * @param records - chronological records.
 * @param limit - maximum restarts returned.
 * @returns the history view.
 */
export function buildHistory(records, limit = 5) {
  const supervised = new Map()
  for (const record of records) {
    if (record?.kind === 'supervised' && typeof record.armId === 'string') {
      supervised.set(record.armId, record)
    }
  }

  const boots = []
  let pendingArmed = null
  let pendingExit = null
  for (const record of records) {
    const kind = record?.kind
    if (kind === 'armed') {
      pendingArmed = record
      pendingExit = null
    } else if (kind === 'exiting') {
      pendingExit = sameArm(pendingArmed, record) ? record : null
    } else if (kind === 'cancelled' || kind === 'aborted') {
      // Only the arm's own abort clears it; another profile's noise does not.
      if (pendingArmed === null || record.armId === undefined || record.armId === pendingArmed.armId) {
        pendingArmed = null
        pendingExit = null
      }
    } else if (kind === 'boot') {
      // A boot belonging to a DIFFERENT profile says nothing about this arm, so
      // it must neither complete it nor erase it — erasing here is how a real
      // replacement's boot gets lost when profiles share one log.
      const foreign = pendingArmed !== null && foreignProfile(pendingArmed, record)
      const withinWindow = pendingExit !== null
        && Number.isFinite(record.at) && Number.isFinite(pendingExit.at)
        && record.at >= pendingExit.at
        && record.at - pendingExit.at <= PAIRING_WINDOW_MS
      const armOfPending = pendingArmed !== null && pendingArmed.armId !== undefined
        ? (supervised.get(pendingArmed.armId) ?? null)
        : null
      const paired = pendingArmed !== null && pendingExit !== null && !foreign && withinWindow
        && completesRestart(pendingArmed, pendingExit, record, armOfPending)
      // For the strategies that run a supervisor, the supervisor's own outcome
      // is the authoritative evidence: without it, a same-profile boot from
      // some unrelated process could be credited as our restart. launchd has no
      // such record, so it keeps the positional/boot pairing.
      const needsSupervisorOutcome = pendingArmed !== null
        && (pendingArmed.strategy === 'supervisor' || pendingArmed.strategy === 'desktop')
      const backed = !needsSupervisorOutcome
        || (armOfPending !== null && armOfPending.ok === true)
      const armId = paired && backed ? pendingArmed.armId ?? null : null
      const result = armId === null ? null : (supervised.get(armId) ?? null)
      const supervisedFailed = result !== null && result.ok === false
      boots.push({
        at: record.at,
        pid: record.pid,
        mode: record.mode ?? null,
        label: record.label ?? null,
        profile: record.profile ?? null,
        restartedFrom: paired && backed && !supervisedFailed
          ? {
            armId,
            armedAt: pendingArmed.at,
            pid: pendingArmed.pid,
            reason: pendingArmed.reason ?? '',
            delaySeconds: pendingArmed.delaySeconds ?? null,
            strategy: pendingArmed.strategy ?? null,
          }
          : null,
        supervisedFailed,
        downtimeMs: pendingExit === null ? null : Math.max(0, record.at - pendingExit.at),
      })
      // Keep waiting only while the window is open and the boot could still be
      // someone else's: the arm's own replacement may simply not have written
      // its record yet. Once the window closes, the arm is over either way.
      if (!foreign && (paired || !withinWindow)) {
        pendingArmed = null
        pendingExit = null
      }
    }
  }
  const last = list => (list.length === 0 ? null : list[list.length - 1])
  return {
    lastBoot: last(boots),
    previousBoot: boots.length > 1 ? boots[boots.length - 2] : null,
    restarts: boots.filter(boot => boot.restartedFrom !== null).slice(-limit),
    lastArmed: last(records.filter(r => r?.kind === 'armed')),
    lastAbort: last(records.filter(r => r?.kind === 'aborted' || r?.kind === 'cancelled')),
    lastSupervised: last(records.filter(r => r?.kind === 'supervised')),
  }
}
