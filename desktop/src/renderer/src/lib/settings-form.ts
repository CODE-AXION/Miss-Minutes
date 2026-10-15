/**
 * Settings form helpers (08·T2): which settings need a worker restart, the input limits the UI enforces, and the
 * patch to save. The limits only keep obviously wrong input out; argparse stays the real validator (a value it
 * rejects shows up as a crashed worker with argparse's error line in the banner).
 */
import type { Settings } from '@shared/api'

/** Settings the worker is not started with: saving them never restarts it. */
const APP_ONLY: ReadonlySet<keyof Settings> = new Set([
  'openAtLogin',
  'startHidden',
  'notify',
  'theme',
  'voice'
])

export type NumberKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never
}[keyof Settings]

/** Limits per numeric setting; whole numbers unless `step` says otherwise (hbQuality allows halves). */
export const NUMBER_LIMITS: Record<NumberKey, { min: number; max: number; step?: number }> = {
  interval: { min: 5, max: 86_400 },
  settle: { min: 0, max: 86_400 },
  maxAttempts: { min: 1, max: 20 },
  hbQuality: { min: 0, max: 51, step: 0.5 },
  retries: { min: 0, max: 10 },
  timeout: { min: 60, max: 86_400 },
  uploadTimeout: { min: 60, max: 86_400 },
  loginWait: { min: 0, max: 86_400 },
  port: { min: 1024, max: 65_535 }
}

/** Text settings that cannot be empty (an empty flag value would override argparse's default). */
const REQUIRED_TEXT: readonly (keyof Settings)[] = [
  'projectRoot',
  'library',
  'watchDir',
  'hbPreset',
  'model',
  'language'
]

/** The changed keys between saved and draft settings (`notify` compared as a whole). */
export function changedKeys(saved: Settings, draft: Settings): (keyof Settings)[] {
  return (Object.keys(draft) as (keyof Settings)[]).filter(
    (k) => JSON.stringify(saved[k]) !== JSON.stringify(draft[k])
  )
}

export function needsRestart(keys: (keyof Settings)[]): boolean {
  return keys.some((k) => !APP_ONLY.has(k))
}

export function patchOf(draft: Settings, keys: (keyof Settings)[]): Partial<Settings> {
  return Object.fromEntries(keys.map((k) => [k, draft[k]])) as Partial<Settings>
}

/** Errors for the required text fields (numbers are checked by their inputs). */
export function textErrors(draft: Settings): Partial<Record<keyof Settings, string>> {
  const errors: Partial<Record<keyof Settings, string>> = {}
  for (const key of REQUIRED_TEXT) {
    if (!String(draft[key]).trim()) errors[key] = 'Required'
  }
  return errors
}

/** HandBrake encoders offered in the select; anything else is "custom". */
export const ENCODERS = [
  { value: '', label: 'Automatic (preset default)' },
  { value: 'x264', label: 'x264 (CPU)' },
  { value: 'qsv_h264', label: 'qsv_h264 (Intel Quick Sync)' },
  { value: 'nvenc_h264', label: 'nvenc_h264 (NVIDIA)' }
] as const
