/**
 * Append-only JSONL restart log plus the history view built from it.
 *
 * Every restart is reconstructable from this file alone: armed -> exiting ->
 * (process dies) -> boot. That is what makes the restart verifiable instead of
 * a fire-and-forget signal.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Append one record.
 * @param logPath - log file path.
 * @param record - JSON-serializable record.
 * @returns the record that was written.
 */
export async function appendRecord(logPath, record) {
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, JSON.stringify(record) + '\n', 'utf8')
  return record
}

/**
 * Read the most recent records, oldest first.
 * @param logPath - log file path.
 * @param limit - maximum records returned.
 * @returns parsed records; a torn trailing line is skipped.
 */
export async function readRecords(logPath, limit = 400) {
  let text
  try {
    text = await readFile(logPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // A crash can leave one torn line; the rest of the file is still valid.
    }
  }
  return records.slice(-limit)
}

/**
 * Reconstruct boots and restarts from the record stream.
 *
 * A boot counts as a completed restart only when it is preceded by both an
 * armed record and an exiting record: an unrelated crash must not be reported
 * as a successful restart.
 * @param records - chronological records.
 * @param limit - maximum restarts returned.
 * @returns the history view.
 */
export function buildHistory(records, limit = 5) {
  const boots = []
  let pendingArmed = null
  let pendingExit = null
  for (const record of records) {
    if (record.kind === 'armed') {
      pendingArmed = record
    } else if (record.kind === 'exiting') {
      pendingExit = record
    } else if (record.kind === 'cancelled' || record.kind === 'aborted') {
      pendingArmed = null
      pendingExit = null
    } else if (record.kind === 'boot') {
      const completed = pendingArmed !== null && pendingExit !== null
      boots.push({
        at: record.at,
        pid: record.pid,
        mode: record.mode ?? null,
        label: record.label ?? null,
        restartedFrom: completed
          ? {
            armedAt: pendingArmed.at,
            pid: pendingArmed.pid,
            reason: pendingArmed.reason ?? '',
            delaySeconds: pendingArmed.delaySeconds ?? null,
          }
          : null,
        downtimeMs: pendingExit === null ? null : Math.max(0, record.at - pendingExit.at),
      })
      pendingArmed = null
      pendingExit = null
    }
  }
  const last = list => (list.length === 0 ? null : list[list.length - 1])
  return {
    lastBoot: last(boots),
    previousBoot: boots.length > 1 ? boots[boots.length - 2] : null,
    restarts: boots.filter(boot => boot.restartedFrom !== null).slice(-limit),
    lastArmed: last(records.filter(r => r.kind === 'armed')),
    lastAbort: last(records.filter(r => r.kind === 'aborted' || r.kind === 'cancelled')),
    lastSupervised: last(records.filter(r => r.kind === 'supervised')),
  }
}
