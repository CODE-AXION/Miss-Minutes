/**
 * The contract between the renderer and main: the `window.api` surface exposed by the preload, the
 * app state main broadcasts, and the IPC channel names. Worker shapes come from ./protocol only.
 */
import type {
  Ack,
  CheckResult,
  CommandInput,
  HelloEvent,
  ProgressEvent,
  SettlingEvent,
  SigninEvent,
  VideoEntry,
  WorkerStateName
} from './protocol'
import type { ChunkType } from './chunker'
import type { MediaInfo } from './media'
import type { RecordingChoice, RecordingSource, RecordingStatus } from './recording'

// --- Settings (electron-store; defaults mirror argparse, see 05·T1) ------------------------

export type ThinkingLevel = 'low' | 'medium' | 'high'
/** office = light TVA theme, crt = dark terminal theme, system = follow Windows. */
export type ThemeSetting = 'system' | 'office' | 'crt'
/** bundled = resources\engine\mm-engine.exe (installed app); project = .venv python + watcher.py (developer). */
export type EngineMode = 'bundled' | 'project'
/** hidden = the automation Chrome runs on a hidden Windows desktop while processing; visible = shown, for troubleshooting. */
export type ChromeMode = 'hidden' | 'visible'
/** background = HandBrake at low priority in efficiency mode (lighter on the PC, slower); full = as fast as possible. */
export type HbSpeed = 'background' | 'full'

export interface Settings {
  engine: EngineMode
  /** Developer mode (engine: project) only. */
  projectRoot: string
  /** Chrome profile of the automation Chrome; bundled mode only (project mode uses .chrome-automation). */
  profileDir: string
  chromeMode: ChromeMode
  library: string
  watchDir: string
  interval: number
  settle: number
  maxAttempts: number
  handbrake: string
  hbPreset: string
  hbQuality: number
  hbEncoder: string
  hbSpeed: HbSpeed
  model: string
  fallbackModel: string
  thinkingLevel: ThinkingLevel
  language: string
  context: string
  retries: number
  timeout: number
  uploadTimeout: number
  loginWait: number
  port: number
  keepBrowser: boolean
  // app-only
  openAtLogin: boolean
  startHidden: boolean
  /** The Google sign-in toast has no switch: it always shows (it is the only state that waits for the user). */
  notify: { done: boolean; failedFinal: boolean; everyFailure: boolean }
  theme: ThemeSetting
  voice: boolean
  /** Opt-in semantic search (EmbeddingGemma 2, local). Keyword search is always on. */
  smartSearch: boolean
  /** Global start/stop recording shortcut (an Electron accelerator); '' = off (RC·T19). */
  recordHotkey: string
  /** Mute/unmute the mic while recording; only taken while a recording with a mic runs; '' = off (RC·T27). */
  muteHotkey: string
  /** The floating always-on-top REC pill while recording (RC·T29); it shows in captures. */
  recordingToolbar: boolean
  /** Offer to record when a Google Meet room is open (MD·T7). */
  meetingPrompt: boolean
}

/** after-current = restart the worker once the current video is finished; now = kill and requeue it. */
export type RestartMode = 'after-current' | 'now'

// --- App state (main is authoritative; broadcast to renderers) ------------------------------

export type Connection = 'up' | 'starting' | 'reconnecting' | 'crashed' | 'locked'

export interface WorkerStatus {
  /** null while no worker is connected. */
  state: WorkerStateName | null
  paused: boolean
  /** "signin": the worker paused itself because the hidden Chrome lost the Google session (11f·T2). */
  pauseReason: 'signin' | null
  current: string | null
  queue: string[]
  pid: number | null
  connection: Connection
  /** Why the worker is crashed/locked, plus the last stderr lines for "crashed". */
  problem?: { message: string; lastLines?: string[] }
}

export interface LiveState {
  progress: Record<string, Omit<ProgressEvent, 'type' | 'key'>>
  settling: Record<string, Omit<SettlingEvent, 'type' | 'key'>>
}

export interface AppState {
  worker: WorkerStatus
  videos: Record<string, VideoEntry>
  hello: HelloEvent | null
  live: LiveState
  settings: Settings
  /** Why the engine can't be started (bundled exe, or project python / watcher.py missing), or null. */
  engineProblem: string | null
  /** The first-run wizard shows (and the worker stays stopped) while true: setup not finished, or engineProblem. */
  setupNeeded: boolean
  google: GoogleState
  /** A sign-in/sign-out Chrome window is open (setup:signin or account:*). */
  signinRunning: boolean
  /** Latest `login_required` stage still unresolved (cleared by the next stage of that video). */
  lastLoginRequired: { key: string; at: string; wait_s: number; hidden: boolean } | null
  search: SearchStatus
  /** The in-app recorder (RC·T10); never anything but `idle` without a visible indicator. */
  recording: RecordingStatus
  /** App updates from GitHub Releases (UP·T2). */
  update: UpdateStatus
}

/**
 * off = not an installed build (development), so nothing is checked. A downloaded update installs on Restart, or
 * by itself the next time the app quits (UP·T2).
 */
export type UpdateStatus =
  | { phase: 'off' }
  | { phase: 'idle'; checkedAt: string | null; error?: string }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }

/** Smart search (SS·T13): the keyword index is always there; the semantic layer is opt-in. */
export interface SearchStatus {
  keyword: { meetings: number; passages: number }
  smart:
    | { phase: 'off' }
    | { phase: 'downloading'; bytes: number; total: number }
    /** Meetings embedded / meetings wanted. */
    | { phase: 'indexing'; done: number; total: number }
    | { phase: 'ready'; meetings: number; diskBytes: number }
    | { phase: 'error'; message: string; retry: 'download' | 'index' }
  /** Another Miss Minutes holds `<library>/.search/lock`: searching works, nothing is saved. */
  readOnly: boolean
  /** The model is downloaded (SS·T26): turning smart search on again needs no download. */
  modelOnDisk: boolean
  /** What "Also delete downloaded files" frees: the model plus the stored vectors. */
  diskBytes: number
}

/** One passage in the results (SS·T15); the renderer opens `/video/<key>` at `anchor`. */
export interface SearchHit {
  key: string
  chunkId: string
  type: ChunkType
  section: string
  /** slug of the section heading ("h-decisions-made"); '' for the meeting summary. */
  anchor: string
  /** [MM:SS] of the passage, without brackets. */
  ts: string | null
  text: string
  /** Character ranges of `text` that matched the query, for the snippet. */
  highlights: [number, number][]
  score: number
}

export interface SearchResult {
  /** Grouped by meeting, best meeting first, at most 3 passages each. */
  hits: SearchHit[]
  /** False when only keyword search ran (smart search off, not ready, or it failed for this query). */
  usedSmart: boolean
  ms: number
}

/** From the last `signin` run (persisted) plus what the worker reported since. */
export interface GoogleState {
  /** Set by signin_ok (email null when it could not be read), cleared by signout_ok. */
  account: { email: string | null; checkedAt: string } | null
  /** The worker hit a Google sign-in page (login_required) and no sign-in or chat has happened since. */
  needsSignin: boolean
}

/** A library folder the wizard can use as is (it has an index.json). */
export interface LibraryInfo {
  path: string
  /** Entries that are not baseline (done, failed, queued...). */
  meetings: number
  /** Baseline entries: recordings that were there before the library, or that were ignored. */
  ignored: number
}

/** How a sign-in or sign-out run ended. */
export type SigninOutcome = { ok: true; account: string | null } | { ok: false; error: string }

// --- Other payloads ---------------------------------------------------------------------------

export interface LogLine {
  /** ISO timestamp added by main when the line was received. */
  ts: string
  text: string
  source: 'worker' | 'app'
}

export interface UploadResult {
  /** The file the user picked or dropped. */
  path: string
  ok: boolean
  /** Final path in library/uploads (which is also the index key). */
  dest?: string
  error?: string
  /** Copied, but not queued yet (e.g. the worker is down; it picks up library/uploads when it starts). */
  warning?: string
}

/** Main asks the renderer to show a page (a toast or tray click). */
/** signin = open the Google sign-in dialog (the session-expired toast). */
/** record = open the recording picker (tray / hotkey while idle, RC·T16). */
export type NavigateRequest =
  { to: 'video'; key: string } | { to: 'dashboard' } | { to: 'signin' } | { to: 'record' }

export interface UploadProgress {
  path: string
  copied: number
  total: number
}

export type OpenPathKind =
  'note' | 'noteFolder' | 'library' | 'index' | 'source' | 'compressed' | 'hbLog'

export interface FileFilter {
  name: string
  extensions: string[]
}

export type Unsubscribe = () => void

// --- window.api -------------------------------------------------------------------------------

export interface MissMinutesApi {
  getState(): Promise<AppState>
  onState(cb: (state: AppState) => void): Unsubscribe
  onLog(cb: (lines: LogLine[]) => void): Unsubscribe
  onNavigate(cb: (request: NavigateRequest) => void): Unsubscribe
  command(cmd: CommandInput): Promise<Ack>

  uploadFiles(paths: string[]): Promise<UploadResult[]>
  pickFiles(): Promise<string[]>
  /** Absolute path of a dropped File (wraps webUtils.getPathForFile). */
  pathForFile(file: File): string
  onUploadProgress(cb: (progress: UploadProgress) => void): Unsubscribe

  /** `relPath` is the entry's `notes` value; main only reads inside library/notes. */
  readNote(relPath: string): Promise<string>
  readHandbrakeLog(key: string): Promise<string>
  getWorkerLog(): Promise<LogLine[]>
  /** Resolved by main from the entry for `key`, never from a raw renderer path. */
  openPath(kind: OpenPathKind, key?: string): Promise<void>
  /** Which playable files exist for the entry (resolved by main, never from a renderer path). */
  mediaInfo(key: string): Promise<MediaInfo>
  /**
   * Deletes a meeting's note, and with `video` its recording and compressed copy too (DM·T1). The files go to the
   * Recycle Bin; without `video` the recording stays, listed as not processed.
   */
  deleteMeeting(key: string, options: { video: boolean }): Promise<void>

  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>, options: { restart: RestartMode }): Promise<Settings>
  pickFolder(): Promise<string | null>
  pickFile(filters?: FileFilter[]): Promise<string | null>
  /** Why `root` can't run the worker (no watcher.py or .venv python), or null when it can. */
  checkProjectRoot(root: string): Promise<string | null>

  /** First-run wizard backend (11c·T3). */
  setup: {
    /** HandBrake, Chrome, watch folder and profile checks for `watchDir` (the engine's `check`). */
    check(watchDir: string): Promise<CheckResult>
    /**
     * Opens a visible Chrome for Google sign-in; resolves when it ends. Refused while the worker runs.
     * `switch` signs out first, so a different account can sign in.
     */
    signin(options?: { switch: boolean }): Promise<SigninOutcome>
    /** The library step's choices: a new library folder, and the old project library when there is one. */
    libraryOptions(): Promise<{ newLibrary: string; found: LibraryInfo | null }>
    /** The folder's index.json counts, or null when it has no readable index.json. */
    inspectLibrary(folder: string): Promise<LibraryInfo | null>
    /** Saves the wizard's choices, marks setup done, applies autostart and starts the worker. */
    finish(patch: Partial<Settings>): Promise<void>
  }
  /** Google account from Settings (11c·T5): the worker is paused while Chrome is used for this. */
  account: {
    signin(options: { switch: boolean }): Promise<SigninOutcome>
    signout(): Promise<SigninOutcome>
    /** Deletes the automation Chrome profile (bundled mode, Chrome not running). */
    resetProfile(): Promise<void>
  }
  /** Ends a running sign-in/sign-out (kills the engine process; the Chrome window stays). */
  cancelSignin(): Promise<void>
  /** Events of the running sign-in/sign-out (login_required carries the wait for the countdown). */
  onSigninEvent(cb: (event: SigninEvent) => void): Unsubscribe

  /** Search over the notes (SS·T16); progress arrives in `AppState.search`. */
  search: {
    /** Keyword search; with `smart`, also semantic search once it is ready. `keys` limits it to those meetings. */
    query(
      q: string,
      options: { smart: boolean; keys?: string[]; limit?: number }
    ): Promise<SearchResult>
    /** Saves `smartSearch`; turning it off with `deleteFiles` also removes the model and the vectors. */
    setEnabled(enabled: boolean, options?: { deleteFiles?: boolean }): Promise<void>
    /** Re-runs the phase that failed (download or indexing). */
    retry(): Promise<void>
    /** Re-chunks and re-embeds every meeting. */
    rebuild(): Promise<void>
  }

  /** App updates (UP·T2); progress arrives in `AppState.update`. */
  updates: {
    /** Looks for a newer release now (Settings); a found one downloads in the background. */
    check(): Promise<void>
    /** Quits and installs the downloaded update, then reopens; refused while recording or processing. */
    install(): Promise<void>
  }

  /** In-app recording (RC·T10); progress arrives in `AppState.recording`. Main picks the folder and the name. */
  recording: {
    /** Screens and windows with thumbnails, plus free space in the watch folder and the last choice. */
    sources(): Promise<{
      sources: RecordingSource[]
      freeBytes: number
      folder: string
      last: RecordingChoice | null
    }>
    /** Resolves once the recording runs; rejects (the picker shows why) when it could not start. */
    start(choice: RecordingChoice): Promise<void>
    /** Stops, saves and queues the recording. */
    stop(): Promise<void>
    /** Silences or restores the mic in the running recording (RC·T27). */
    setMicMuted(muted: boolean): Promise<void>
  }

  app: {
    quit(): Promise<void>
    hide(): Promise<void>
    restartWorker(): Promise<void>
    getVersion(): Promise<string>
  }
}

/** IPC channels. invoke = ipcMain.handle; push = main -> renderer (webContents.send). */
export const IPC = {
  getState: 'state:get',
  command: 'worker:command',
  uploadFiles: 'uploads:add',
  pickFiles: 'uploads:pick',
  readNote: 'files:read-note',
  readHandbrakeLog: 'files:read-hb-log',
  getWorkerLog: 'worker:log',
  openPath: 'files:open',
  deleteMeeting: 'files:delete-meeting',
  mediaInfo: 'media:info',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  pickFolder: 'dialog:pick-folder',
  pickFile: 'dialog:pick-file',
  checkProjectRoot: 'settings:check-root',
  setupCheck: 'setup:check',
  setupSignin: 'setup:signin',
  setupFinish: 'setup:finish',
  setupLibraryOptions: 'setup:library-options',
  setupInspectLibrary: 'setup:inspect-library',
  signinCancel: 'setup:signin-cancel',
  accountSignin: 'account:signin',
  accountSignout: 'account:signout',
  accountResetProfile: 'account:reset-profile',
  quit: 'app:quit',
  hide: 'app:hide',
  restartWorker: 'app:restart-worker',
  getVersion: 'app:version',
  searchQuery: 'search:query',
  searchSetEnabled: 'search:set-enabled',
  searchRetry: 'search:retry',
  searchRebuild: 'search:rebuild',
  recordingSources: 'recording:sources',
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingMute: 'recording:mute',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  // push
  state: 'state:changed',
  log: 'worker:log-lines',
  uploadProgress: 'uploads:progress',
  navigate: 'app:navigate',
  setupEvent: 'setup:event'
} as const
