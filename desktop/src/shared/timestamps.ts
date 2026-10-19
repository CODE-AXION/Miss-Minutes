/** "[36:15]", "[1:02:03]", "[38:40, 39:37]". */
export const TIMESTAMP = /\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,–-]\s*\d{1,2}:\d{2}(?::\d{2})?)*\]/g

/** One clock inside a matched timestamp run (NV·T1). */
export const CLOCK = /\d{1,2}:\d{2}(?::\d{2})?/g

/**
 * Seconds for "36:15" (MM:SS, minutes may exceed 59) or "1:02:03" (H:MM:SS) (NV·T1). Null when seconds ≥ 60, or
 * minutes ≥ 60 in the H:MM:SS form.
 */
export function parseClock(text: string): number | null {
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return null
  const parts = text.split(':').map(Number)
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts]
  if (s >= 60 || (parts.length === 3 && m >= 60)) return null
  return h * 3600 + m * 60 + s
}

export interface RunPart {
  text: string
  /** Set for a clock (a jump target); null for brackets, separators and clocks that don't parse. */
  seconds: number | null
}

/**
 * A matched run such as "[38:40 – 39:37]" split into its clocks and the text between them (NV·T1). Joining every
 * `text` gives back `run` exactly, so the note reads and copies as before.
 */
export function splitRun(run: string): RunPart[] {
  const parts: RunPart[] = []
  let last = 0
  for (const match of run.matchAll(CLOCK)) {
    if (match.index > last) parts.push({ text: run.slice(last, match.index), seconds: null })
    parts.push({ text: match[0], seconds: parseClock(match[0]) })
    last = match.index + match[0].length
  }
  if (last < run.length) parts.push({ text: run.slice(last), seconds: null })
  return parts
}

/** Playback starts this many seconds before a clicked timestamp, to catch the lead-in. */
export const LEAD_SECONDS = 2

/**
 * Where to seek for a timestamp (NV·T1): `LEAD_SECONDS` early, never below 0, and capped at the last second once
 * the video's duration is known (Gemini sometimes writes a time past the end).
 */
export function seekTarget(seconds: number, duration?: number): number {
  const target = Math.max(0, seconds - LEAD_SECONDS)
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    return Math.min(target, Math.max(0, duration - 1))
  }
  return target
}

/** "01:40" for countdowns and live timers (hours added when needed); shared with main (RC·T4). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
