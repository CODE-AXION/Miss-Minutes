import { formatDistanceToNowStrict } from 'date-fns'

/** File name of an index key (an absolute Windows path). */
export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
}

/** Worker timestamps are local ISO without a zone ("2026-10-14T11:02:10"), which JS parses as local time. */
export function parseTs(ts: string | undefined | null): Date | null {
  if (!ts) return null
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "61 MB", "1.4 GB" (binary units, like the worker's size_mb). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const mb = bytes / 2 ** 20
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

/** Whole decimal megabytes, as the search model's size is quoted ("207 MB"; formatBytes would say 197). */
export const megabytes = (bytes: number): number => Math.round(bytes / 1e6)

/** "2m 48s", "1h 05m", "42s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(rest).padStart(2, '0')}s`
  return `${rest}s`
}

/** "01:40" for countdowns and live timers (hours added when needed). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** HandBrake's "00h02m11s" → "2m 11s". */
export function formatEta(eta: string | undefined): string | null {
  const m = eta ? /(\d+)h(\d+)m(\d+)s/.exec(eta) : null
  return m ? formatDuration(+m[1] * 3600 + +m[2] * 60 + +m[3]) : null
}

/** "3 minutes ago". */
export function formatRelative(ts: string | undefined | null): string {
  const date = parseTs(ts)
  return date ? formatDistanceToNowStrict(date, { addSuffix: true }) : '—'
}

/** 0.29 → "29%". */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** Seconds from `ts` to `now` (ms). */
export function secondsSince(ts: string | undefined | null, now: number): number {
  const date = parseTs(ts)
  return date ? (now - date.getTime()) / 1000 : 0
}

/**
 * Preview of how the worker normalises a typed tag (meeting_notes.slugify: lower case, runs of anything other than
 * a-z0-9 become "-"). Display only: the `edit` command slugifies again in Python, which stays the source of truth.
 */
export function slugifyTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** An error's message without Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
