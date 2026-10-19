/**
 * Rules main, the recorder window and the UI must agree on for in-app recording (RC·T1–T4). Pure: no Electron or
 * Node imports, so it is unit-tested like chunker.ts / media.ts.
 */

/** What the picker hands main on Start; main validates it and never takes a path from the renderer (RC·T1). */
export interface RecordingChoice {
  sourceId: string
  kind: 'screen' | 'window'
  /** desktopCapturer's display_id for a screen, so the choice survives a restart; null for a window. */
  displayId: string | null
  systemAudio: boolean
  /** null = no mic. */
  micDeviceId: string | null
}

/** The record hotkey's default (RC·T19); not Ctrl+Shift+R, which would steal the browsers' hard refresh. */
export const DEFAULT_RECORD_HOTKEY = 'CommandOrControl+Alt+R'

/** Mutes/unmutes the mic while recording (RC·T27); only registered while a recording with a mic runs. */
export const DEFAULT_MUTE_HOTKEY = 'CommandOrControl+Alt+M'

/** One screen or window in the picker (RC·T1). */
export interface RecordingSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  displayId: string | null
  /** Data URL (the renderer CSP already allows `img-src data:`). */
  thumbnail: string
}

/** What actually got captured; fallbacks never block a recording (RC·T1). */
export interface RecordingAudio {
  system: 'on' | 'off' | 'failed'
  mic: 'on' | 'off' | 'blocked' | 'failed'
  micLabel: string | null
}

export type StopReason = 'user' | 'track-ended' | 'disk' | 'quit' | 'crash'

/** `AppState.recording` (RC·T1). */
export type RecordingStatus =
  | { phase: 'idle'; last?: { file: string; seconds: number; error?: string } }
  | { phase: 'starting' }
  | {
      phase: 'recording'
      /** ISO. */
      startedAt: string
      /** Final path (without `.part`). */
      file: string
      sourceName: string
      audio: RecordingAudio
      /** The mic is silenced in the mix (RC·T27); the recording itself never pauses. */
      micMuted: boolean
      bytes: number
      warning: string | null
    }
  | { phase: 'stopping'; reason: StopReason }

/** Recorder window → main (RC·T1). */
export type RecorderEvent =
  | { type: 'ready' }
  | { type: 'started'; mime: string; audio: RecordingAudio; width: number; height: number }
  | { type: 'track-ended' }
  | { type: 'error'; message: string }
  | { type: 'finished' }

/**
 * The recorder window's channels (RC·T7). Kept out of `IPC` (api.ts) on purpose: if both preloads imported one
 * module, rollup would split it into a chunk the sandboxed preloads can't require().
 */
export const RECORDER_IPC = {
  // recorder -> main: send, not invoke, to keep chunk order and throughput
  chunk: 'recorder:chunk',
  event: 'recorder:event',
  // main -> recorder
  start: 'recorder:start',
  stop: 'recorder:stop',
  mute: 'recorder:mute'
} as const

/** What the mini-toolbar shows (RC·T29). */
export interface ToolbarState {
  phase: 'starting' | 'recording' | 'stopping'
  /** ISO, while recording. */
  startedAt: string | null
  hasMic: boolean
  micMuted: boolean
}

/** `window.recToolbar` (window.toolbar is taken by the DOM): the only things the mini-toolbar page can reach (RC·T29). */
export interface ToolbarBridge {
  onState(cb: (state: ToolbarState) => void): void
  ready(): void
  stop(): void
  toggleMute(): void
}

/** Main → recorder window on Start; `mime` null lets the window pick with `pickMime` (RC·T7). */
export interface RecorderJob {
  choice: RecordingChoice
  mime: string | null
}

/** `window.recorder`: the only things the hidden recorder page can reach (RC·T7). */
export interface RecorderBridge {
  onStart(cb: (job: RecorderJob) => void): void
  onStop(cb: () => void): void
  onMute(cb: (muted: boolean) => void): void
  chunk(data: Uint8Array): void
  event(e: RecorderEvent): void
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * "2026-10-19 14-03-27" in local time, the OBS name `watcher.recorded_at` parses as wall-clock time (RC·T2). Never
 * toISOString(): that is UTC.
 */
export function recordingStem(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/**
 * `stem`, else `stem (2)`, `stem (3)`, … — the first one not in `taken` (lower-cased stems) (RC·T2). The one rule
 * shared by uploads and recordings.
 */
export function uniqueStem(stem: string, taken: Set<string>): string {
  let candidate = stem
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})`
  return candidate
}

/** A recording is written as `<name>.mp4.part` and renamed on Stop; the watcher ignores `.part` (RC·T2). */
export const PART_SUFFIX = '.part'

const RECORDING_PART = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.(mp4|webm)\.part$/i

/** Only our own leftovers, so crash recovery never renames a user's `.part` file (RC·T2). */
export function isRecordingPart(name: string): boolean {
  return RECORDING_PART.test(name)
}

/** Free-space thresholds for the watch folder's drive (RC·T3). */
export const DISK = {
  warnBytes: 2 * 2 ** 30,
  refuseBytes: 500 * 2 ** 20,
  stopBytes: 300 * 2 ** 20,
  checkMs: 30_000
} as const

/** For the picker and Start: `low` warns, `refuse` blocks Start (RC·T3). */
export function diskVerdict(freeBytes: number): 'ok' | 'low' | 'refuse' {
  if (freeBytes < DISK.refuseBytes) return 'refuse'
  if (freeBytes < DISK.warnBytes) return 'low'
  return 'ok'
}

/** For the monitor while recording: stop and save before the drive fills (RC·T3). */
export function shouldAutoStop(freeBytes: number): boolean {
  return freeBytes < DISK.stopBytes
}

/** MP4 first; WebM only where MP4 isn't supported (`.webm` is in the engine's VIDEO_EXTENSIONS) (RC·T4). */
export const MIME_CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: '.mp4' },
  { mime: 'video/webm;codecs=h264,opus', ext: '.webm' }
] as const

/** The first candidate `MediaRecorder.isTypeSupported` accepts, or null (RC·T4). */
export function pickMime(isSupported: (mime: string) => boolean): string | null {
  return MIME_CANDIDATES.find((c) => isSupported(c.mime))?.mime ?? null
}

/** `.mp4` / `.webm` for a candidate MIME, else null (RC·T4). */
export function extForMime(mime: string): string | null {
  return MIME_CANDIDATES.find((c) => c.mime === mime)?.ext ?? null
}

/** Capture constraints and encoder settings (spiked at 1080p, ~28 fps) (RC·T4). */
export const CAPTURE = {
  frameRate: 30,
  maxWidth: 1920,
  maxHeight: 1080,
  videoBitsPerSecond: 2_500_000,
  audioBitsPerSecond: 128_000,
  timesliceMs: 1000,
  /**
   * fMP4 fragments are cut only at keyframes, and a static screen otherwise gets one every ~15 s: that is how much a
   * crash could lose, and how long chunks stall.
   */
  keyframeIntervalMs: 2000
} as const
