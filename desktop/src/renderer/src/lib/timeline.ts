/**
 * The Sacred Timeline (07·T2) as data: `entry.history` split into runs, each row with its duration, and the phase
 * totals for the phase bar. Built only from the persisted history (plus `now` for the in-flight row), never from log
 * text, so a finished video's timeline is identical after a restart.
 */
import type { HistoryItem, StageId, VideoEntry } from '@shared/protocol'
import { parseTs } from './format'

/** How a run ended. `stopped` = no closing stage (the worker was killed) and nothing is running it now. */
export type RunOutcome = 'saved' | 'failed' | 'interrupted' | 'running' | 'stopped'

export interface TimelineRow {
  item: HistoryItem
  /** Epoch ms of `item.at`. */
  start: number
  /** Seconds until the next row (or until now for the live row); null for the closing row of a run. */
  seconds: number | null
  /** The in-flight row of the running video. */
  live: boolean
}

export interface Run {
  /** The worker's attempt number (attempts restart at 1 after a manual retry or reprocess). */
  attempt: number
  rows: TimelineRow[]
  outcome: RunOutcome
  start: number
  /** Epoch ms of the closing row, or now while running. */
  end: number
  error?: string
}

const CLOSING: ReadonlySet<StageId> = new Set(['saved', 'failed', 'interrupted'])

function ms(at: string): number {
  return parseTs(at)?.getTime() ?? 0
}

/**
 * History split into runs: a run starts at each `ready` (the worker records one before every attempt). The
 * `detected` row of a watched recording comes before the first `ready` and belongs to the first run. `running` = the
 * worker is processing this video right now (only the last run can be running).
 */
export function buildRuns(entry: VideoEntry, running: boolean, now: number): Run[] {
  const groups: HistoryItem[][] = []
  for (const item of entry.history ?? []) {
    const current = groups[groups.length - 1]
    const startsRun = item.stage === 'ready' && current?.some((h) => h.stage === 'ready')
    if (!current || startsRun) groups.push([item])
    else current.push(item)
  }
  return groups.map((items, g) => {
    const last = items[items.length - 1]
    const isLast = g === groups.length - 1
    const outcome: RunOutcome = CLOSING.has(last.stage)
      ? (last.stage as RunOutcome)
      : isLast && running
        ? 'running'
        : 'stopped'
    const rows = items.map((item, i): TimelineRow => {
      const start = ms(item.at)
      const next = items[i + 1]
      const live = outcome === 'running' && i === items.length - 1
      const seconds = next ? (ms(next.at) - start) / 1000 : live ? (now - start) / 1000 : null
      return { item, start, seconds: seconds === null ? null : Math.max(0, seconds), live }
    })
    return {
      attempt: last.attempt,
      rows,
      outcome,
      start: rows[0].start,
      end: outcome === 'running' ? now : rows[rows.length - 1].start,
      error: last.stage === 'failed' ? last.error : undefined
    }
  })
}

/** Seconds from the latest `ready` to the `saved` after it (the "total time of the last attempt"). */
export function lastRunSeconds(entry: VideoEntry): number | null {
  const history = entry.history ?? []
  const saved = history.findLastIndex((h) => h.stage === 'saved')
  if (saved < 0) return null
  const ready = history.slice(0, saved).findLastIndex((h) => h.stage === 'ready')
  if (ready < 0) return null
  return (ms(history[saved].at) - ms(history[ready].at)) / 1000
}

// --- Phase bar ------------------------------------------------------------------------------

export const BAR_PHASES = [
  { id: 'settle', label: 'Settle' },
  { id: 'compress', label: 'Compress' },
  { id: 'setup', label: 'AI Studio setup' },
  { id: 'upload', label: 'Upload' },
  { id: 'generate', label: 'Generate + save' }
] as const

export type BarPhaseId = (typeof BAR_PHASES)[number]['id']

/** The phase that the time *after* a row counts toward (closing rows have no time after them). */
const PHASE_AFTER: Record<StageId, BarPhaseId | null> = {
  detected: 'settle',
  ready: 'compress',
  compress_reused: 'compress',
  compress_start: 'compress',
  compress_done: 'compress',
  chrome_start: 'setup',
  chrome_reconnect: 'setup',
  login_required: 'setup',
  chat_open: 'setup',
  resumed_tab: 'setup',
  upload_start: 'upload',
  upload_ready: 'generate',
  run_retry_click: 'generate',
  generating: 'generate',
  copy_fallback: 'generate',
  retry_wait: 'generate',
  fallback_model: 'generate',
  saved: null,
  failed: null,
  interrupted: null
}

export interface PhaseTotal {
  id: BarPhaseId
  label: string
  seconds: number
  /** The live row is in this phase. */
  active: boolean
}

/** Time per phase in one run (a retry inside the run that re-opens a chat and re-uploads adds to the same phases). */
export function phaseTotals(run: Run): PhaseTotal[] {
  const totals = new Map<BarPhaseId, { seconds: number; active: boolean }>()
  for (const row of run.rows) {
    const phase = PHASE_AFTER[row.item.stage]
    if (!phase || row.seconds === null) continue
    const total = totals.get(phase) ?? { seconds: 0, active: false }
    totals.set(phase, { seconds: total.seconds + row.seconds, active: total.active || row.live })
  }
  return BAR_PHASES.map(({ id, label }) => ({
    id,
    label,
    seconds: totals.get(id)?.seconds ?? 0,
    active: totals.get(id)?.active ?? false
  }))
}

// --- Per-video log window -------------------------------------------------------------------

/**
 * Time windows (epoch ms) when the worker was working on this video: each run from its `ready` (the settle wait
 * before it can overlap another video's processing) to its closing row, or now while running. Processing is
 * sequential, so worker log lines inside these windows belong to this video (07·T5).
 */
export function logWindows(runs: Run[]): [number, number][] {
  return runs.map((run) => {
    const ready = run.rows.find((r) => r.item.stage === 'ready')
    // `at` is truncated to the second, so the run's first line ("=== name (attempt n) ===") is never before it. A
    // little slack at the end for the lines logged just after the closing row.
    return [(ready ?? run.rows[0]).start, run.end + 3000]
  })
}
