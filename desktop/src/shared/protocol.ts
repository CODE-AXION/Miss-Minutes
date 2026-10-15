/**
 * Protocol v1 between the Python worker (`watcher.py serve`) and Electron main.
 *
 * Source of truth: .claude/plans/desktop-app/01-python-event-protocol.md (+ the "Implemented" notes in
 * 02 and 03). Events arrive as JSON lines on the worker's stdout, commands go out as JSON lines on its
 * stdin and are answered by an `ack`. This file is the ONLY TypeScript definition of these shapes.
 */

export const PROTOCOL_VERSION = 1

// --- Index entries (library/index.json, keyed by the source's absolute path) ---------------

export type Status =
  'pending' | 'compressing' | 'compressed' | 'generating' | 'done' | 'failed' | 'baseline'

export type Origin = 'watch' | 'upload'

/** Stage ids recorded in `entry.history` and sent as `stage` events. */
export type StageId =
  | 'detected'
  | 'ready'
  | 'compress_reused'
  | 'compress_start'
  | 'compress_done'
  | 'chrome_start'
  | 'chrome_reconnect'
  | 'login_required'
  | 'chat_open'
  | 'resumed_tab'
  | 'upload_start'
  | 'upload_ready'
  | 'run_retry_click'
  | 'generating'
  | 'copy_fallback'
  | 'retry_wait'
  | 'fallback_model'
  | 'saved'
  | 'failed'
  | 'interrupted'

type NoDetail = Record<string, never>

/** The `detail` fields of each stage. */
export interface StageDetails {
  detected: NoDetail
  ready: NoDetail
  compress_reused: { file: string }
  compress_start: { size_mb: number; quality: number; encoder: string | null }
  compress_done: { size_mb: number; ratio: number; seconds: number }
  chrome_start: NoDetail
  chrome_reconnect: NoDetail
  /** `hidden`: Chrome runs on the hidden desktop, so nobody can sign in there; `wait_s` is 0, the video isn't waited on. */
  login_required: { wait_s: number; hidden?: true }
  chat_open: { model: string }
  resumed_tab: NoDetail
  upload_start: { size_mb: number }
  upload_ready: { seconds: number }
  /** `n` = click number (1-3); `hint` = visible AI Studio error text, may be empty. */
  run_retry_click: { n: number; hint: string }
  generating: NoDetail
  copy_fallback: NoDetail
  /** `retry` = 1-based retry inside one pipeline attempt, `retries` = configured maximum. */
  retry_wait: { model: string; retry: number; retries: number; wait_s: number; error: string }
  fallback_model: { model: string }
  saved: { notes: string; category: string; tags: string[] }
  failed: { error: string }
  interrupted: NoDetail
}

/** One persisted timeline row: `{stage, at, attempt, ...detail}` (at most 300 per entry). */
export type HistoryItem = {
  [S in StageId]: { stage: S; at: string; attempt: number } & StageDetails[S]
}[StageId]

export interface VideoEntry {
  source: string
  status: Status
  recorded: string
  attempts: number
  updated: string
  size?: number
  error?: string | null
  /** Absolute path of the compressed file. */
  compressed?: string | null
  compressed_size?: number | null
  /** Note path relative to the library, posix separators (e.g. "notes/requirements/….md"). */
  notes?: string
  model?: string
  processed?: string
  title?: string
  category?: string
  tags?: string[]
  summary?: string
  participants?: string[]
  /** Epoch seconds before which a failed entry is not retried automatically. */
  next_try?: number
  history?: HistoryItem[]
  origin?: Origin
  context?: string
  /** Set by the `edit` command (ISO seconds). */
  edited?: string
}

// --- Events (worker stdout) ----------------------------------------------------------------

interface EventBase {
  /** ISO timestamp, seconds precision, local time. */
  ts: string
}

export type HealthCheck = { ok: true; path: string } | { ok: false; error: string }

/** Effective `watcher.py serve` arguments (argparse names, snake_case). */
export type WorkerArgs = Record<string, string | number | boolean | null>

export interface HelloEvent extends EventBase {
  type: 'hello'
  protocol: typeof PROTOCOL_VERSION
  pid: number
  library: string
  watch_dir: string
  /** Category id -> description (meeting_notes.CATEGORIES). */
  categories: Record<string, string>
  suggested_tags: string[]
  video_extensions: string[]
  checks: { watch_dir_ok: boolean; handbrake: HealthCheck; chrome: HealthCheck }
  settings: WorkerArgs
}

export interface SnapshotEvent extends EventBase {
  type: 'snapshot'
  videos: Record<string, VideoEntry>
}

export interface VideoEvent extends EventBase {
  type: 'video'
  key: string
  entry: VideoEntry
}

export type StageEvent = {
  [S in StageId]: EventBase & {
    type: 'stage'
    key: string
    stage: S
    attempt: number
    detail: StageDetails[S]
  }
}[StageId]

/** Live only, at most about once per second while compressing. */
export interface ProgressEvent extends EventBase {
  type: 'progress'
  key: string
  stage: 'compressing'
  pct: number
  /** HandBrake's ETA, e.g. "00h02m11s". */
  eta?: string
  /** HandBrake's average fps. */
  fps?: number
}

/** Live only: a watch-folder recording that is not ready yet. */
export interface SettlingEvent extends EventBase {
  type: 'settling'
  key: string
  remaining_s: number
}

export type WorkerStateName = 'idle' | 'busy' | 'paused'

export interface WorkerEvent extends EventBase {
  type: 'worker'
  state: WorkerStateName
  /** True after `pause`, also while the current video still finishes (state stays "busy"). */
  paused: boolean
  /** Set while paused by the worker itself: "signin" = the session expired on the hidden desktop; resume after a sign-in. */
  pause_reason?: 'signin'
  /** Keys in processing order: manual requests first, then pending by recording time. */
  queue: string[]
  current?: string
}

export interface AckEvent extends EventBase {
  type: 'ack'
  /** null when the command line could not be parsed. */
  id: string | null
  ok: boolean
  error?: string
  warning?: string
}

export type WorkerMessage =
  | HelloEvent
  | SnapshotEvent
  | VideoEvent
  | StageEvent
  | ProgressEvent
  | SettlingEvent
  | WorkerEvent
  | AckEvent

export type WorkerMessageType = WorkerMessage['type']

// --- One-shot setup commands (no worker, no library) ----------------------------------------

/** `watcher.py check`: one JSON line on stdout, exit 0. */
export interface CheckResult {
  watch_dir_ok: boolean
  handbrake: HealthCheck
  chrome: HealthCheck
  /** Absolute Chrome profile folder in use. */
  profile_dir: string
  /** The profile folder exists and is not empty (a past sign-in is likely, not verified). */
  signed_in_hint: boolean
}

/**
 * `watcher.py signin [--switch | --signout-only]`: JSON lines on stdout with a top-level `type`
 * (not wrapped in `stage` events). Ends with `signin_ok`/`signout_ok` (exit 0) or `signin_failed` (exit 1).
 */
export type SigninEvent = EventBase &
  (
    | { type: 'chrome_start' }
    | { type: 'login_required'; wait_s: number }
    /** `account`: the signed-in email, null when AI Studio's account button could not be read. */
    | { type: 'signin_ok'; account: string | null }
    | { type: 'signout_ok' }
    | { type: 'signin_failed'; error: string }
  )

// --- Commands (worker stdin) ---------------------------------------------------------------

type Cmd<C extends string, F = unknown> = { id: string; cmd: C } & F

export type WorkerCommand =
  | Cmd<'ping'>
  | Cmd<'snapshot'>
  | Cmd<'scan_now'>
  | Cmd<'pause'>
  | Cmd<'resume'>
  /** File must be directly inside the watch folder or library/uploads. Jumps the queue. */
  | Cmd<'enqueue', { path: string }>
  /** Only `failed` entries. Resets attempts; jumps the queue. */
  | Cmd<'retry', { key: string }>
  /** Not while processing. `recompress` deletes the old encode first. Jumps the queue. */
  | Cmd<'reprocess', { key: string; recompress?: boolean }>
  /** `baseline` -> `pending` (no settle wait, normal order). */
  | Cmd<'include', { key: string }>
  | Cmd<'include_all_baseline'>
  /** `pending`/`failed` -> `baseline` (ignore the recording). */
  | Cmd<'exclude', { key: string }>
  /** Only `done` entries; omitted fields keep their value. May ack with a `warning`. */
  | Cmd<'edit', { key: string; title?: string; category?: string; tags?: string[] }>
  | Cmd<'reindex'>
  /** Refused with error "busy" while processing, unless `after_current`. */
  | Cmd<'shutdown', { after_current?: boolean }>

export type CommandName = WorkerCommand['cmd']

/** Omit that keeps the union discriminated (plain Omit<Union, K> collapses it). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A command as callers write it; main assigns the `id`. */
export type CommandInput = DistributiveOmit<WorkerCommand, 'id'>

/** What a caller gets back for a command. */
export type Ack = Pick<AckEvent, 'ok' | 'error' | 'warning'>
