import {
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  powerSaveBlocker,
  session,
  webContents,
  type DesktopCapturerSource,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import { is } from '@electron-toolkit/utils'
import { once } from 'events'
import { createWriteStream, type WriteStream } from 'fs'
import { readdir, rename, stat, statfs, unlink } from 'fs/promises'
import { basename, extname, join } from 'path'
import type { NavigateRequest, Settings } from '@shared/api'
import {
  DISK,
  PART_SUFFIX,
  RECORDER_IPC,
  diskVerdict,
  extForMime,
  isRecordingPart,
  recordingStem,
  shouldAutoStop,
  uniqueStem,
  type RecorderEvent,
  type RecorderJob,
  type RecordingAudio,
  type RecordingChoice,
  type RecordingSource,
  type RecordingStatus,
  type StopReason
} from '@shared/recording'
import { formatClock } from '@shared/timestamps'
import { voice } from '@shared/voice'
import type { Notifier } from './notify'
import { loadLastRecording, saveLastRecording } from './settings'
import type { State } from './state'
import { takenStems, type Uploads } from './uploads'

const START_TIMEOUT_MS = 10_000
/** Windows listed in the picker (screens are always all listed). */
const MAX_WINDOWS = 30

/** How long Stop waits for the recorder's last chunk: Windows logoff gives an app only a few seconds. */
const FINISH_TIMEOUT_MS = { quit: 5_000, other: 15_000 }
const BYTES_MS = 2_000
/** Queued writes past this mean the disk has stalled. */
const STALL_BYTES = 64 * 2 ** 20

type Recording = Extract<RecordingStatus, { phase: 'recording' }>

/** The one recording in flight, from Start until it is saved or abandoned. */
interface Active {
  win: BrowserWindow
  /** Kept apart from `win`: a destroyed window's `webContents` getter throws. */
  contents: WebContents
  choice: RecordingChoice
  sourceName: string
  stem: string
  /** Set on `started`, once the format (and so the extension) is known. */
  file: string | null
  stream: WriteStream | null
  /** Chunks that arrived before the file was open (one or two at most). */
  early: Buffer[]
  bytes: number
  startedAt: number
  /** Null until `started`. */
  status: Recording | null
  blocker: number | null
  timers: NodeJS.Timeout[]
  stalledLogged: boolean
  resolveStart: () => void
  rejectStart: (error: Error) => void
  /** Resolved by the recorder's `finished` (or its crash). */
  finished: Promise<void>
  markFinished: () => void
  /** Stop or abort in progress: every later stop() returns it. */
  ending: Promise<void> | null
}

const stemOf = (name: string): string => basename(name, extname(name)).toLowerCase()
const mb = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MB`
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Free bytes for the user on the drive holding `dir` (RC·T11). */
async function freeBytes(dir: string): Promise<number> {
  try {
    const fs = await statfs(dir)
    return fs.bavail * fs.bsize
  } catch (error) {
    throw new Error(`The recordings folder can't be read (${dir}): ${message(error)}`)
  }
}

/** The renderer's choice, checked field by field; nothing else of it is kept (RC·T12). */
function parseChoice(raw: unknown): RecordingChoice {
  const c = (raw ?? {}) as Record<string, unknown>
  const optionalString = (v: unknown, max: number): v is string | null =>
    v === null || (typeof v === 'string' && v.length > 0 && v.length <= max)
  if (
    typeof c.sourceId !== 'string' ||
    !/^(screen|window):[\w:-]{1,200}$/.test(c.sourceId) ||
    (c.kind !== 'screen' && c.kind !== 'window') ||
    !c.sourceId.startsWith(`${c.kind}:`) ||
    !optionalString(c.displayId, 100) ||
    typeof c.systemAudio !== 'boolean' ||
    !optionalString(c.micDeviceId, 500)
  )
    throw new Error('Invalid recording choice')
  return {
    sourceId: c.sourceId,
    kind: c.kind,
    displayId: c.displayId,
    systemAudio: c.systemAudio,
    micDeviceId: c.micDeviceId
  }
}

type WarningKey =
  'recording.noAudio' | 'recording.micBlocked' | 'recording.micFailed' | 'recording.noLoopback'

/** The banner/status line for an audio fallback; recording goes on either way (RC·T12). */
function audioWarning(choice: RecordingChoice, audio: RecordingAudio): WarningKey | null {
  const wanted = choice.systemAudio || choice.micDeviceId !== null
  if (wanted && audio.system !== 'on' && audio.mic !== 'on') return 'recording.noAudio'
  if (audio.mic === 'blocked') return 'recording.micBlocked'
  if (audio.mic === 'failed') return 'recording.micFailed'
  if (audio.system === 'failed') return 'recording.noLoopback'
  return null
}

/** Toast for a saved recording, by why it stopped (RC·T14). */
const SAVED_LINE: Record<
  StopReason,
  'recording.saved' | 'recording.trackEnded' | 'recording.diskStop'
> = {
  user: 'recording.saved',
  crash: 'recording.saved',
  quit: 'recording.saved',
  'track-ended': 'recording.trackEnded',
  disk: 'recording.diskStop'
}

/**
 * In-app recording (RC·T10–T16): one recording at a time, captured by a hidden sandboxed recorder window and written
 * by main to `<watchDir>\<stem>.mp4.part`. On Stop the file is closed, renamed and queued with `Uploads.enqueue`, so
 * from there it is processed like any OBS recording. Publishes `AppState.recording`.
 */
export class RecordingService {
  private active: Active | null = null
  /** The registered mute hotkey ('' = none); held only while a recording with a mic runs (RC·T27). */
  private muteKey = ''

  constructor(
    private state: State,
    private uploads: Uploads,
    private notifier: Notifier,
    private log: (text: string) => void,
    private getSettings: () => Settings,
    private navigate: (request: NavigateRequest) => void,
    private mainWindow: () => BrowserWindow | null
  ) {
    ipcMain.on(RECORDER_IPC.event, (event, e: RecorderEvent) => this.onEvent(event, e))
    ipcMain.on(RECORDER_IPC.chunk, (event, data: unknown) => this.onChunk(event, data))
    // Only the recorder window may capture the screen (RC·T12); every other request is denied.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const a = this.active
      const from = request.frame ? webContents.fromFrame(request.frame) : undefined
      const deny = (why: string): void => {
        this.log(`recording: screen capture refused (${why})`)
        try {
          callback(null)
        } catch {
          // The requesting frame is already gone.
        }
      }
      if (!a || a.status || a.ending || !from || from.id !== a.contents.id)
        return deny('not the recorder window')
      this.resolveSource(a.choice)
        .then((source) => {
          if (!source) return deny('the source is gone')
          callback({ video: source, ...(a.choice.systemAudio ? { audio: 'loopback' } : {}) })
        })
        .catch((error) => deny(message(error)))
    })
  }

  /** A recording is starting, running or being saved. */
  get busy(): boolean {
    return this.state.recording.phase !== 'idle'
  }

  /** Tray and hotkey (RC·T16): open the picker when idle, stop while recording, ignore the moments in between. */
  toggle(): void {
    const { phase } = this.state.recording
    if (phase === 'idle') this.navigate({ to: 'record' })
    else if (phase === 'recording') void this.stop('user')
  }

  /** Silences or restores the mic in the mix (RC·T27); the video and the system audio keep recording. */
  async setMicMuted(muted: boolean): Promise<void> {
    const a = this.active
    if (!a?.status || a.ending) throw new Error('Not recording')
    if (a.status.audio.mic !== 'on') throw new Error('No microphone is being recorded')
    if (a.status.micMuted === muted) return
    if (!a.contents.isDestroyed()) a.contents.send(RECORDER_IPC.mute, muted)
    a.status = { ...a.status, micMuted: muted }
    this.state.setRecording(a.status)
    this.log(`recording: mic ${muted ? 'muted' : 'unmuted'}`)
  }

  /** Mute hotkey and tray (RC·T27). */
  toggleMicMuted(): void {
    const status = this.active?.status
    if (status) void this.setMicMuted(!status.micMuted).catch(() => {})
  }

  /**
   * Holds the mute hotkey only while a recording with a mic runs, so the key isn't taken from other apps the rest
   * of the time (RC·T27). Also called when the setting changes. A key another app owns only logs.
   */
  syncMuteHotkey(): void {
    const a = this.active
    const wanted =
      a?.status && !a.ending && a.status.audio.mic === 'on' ? this.getSettings().muteHotkey : ''
    if (wanted === this.muteKey) return
    if (this.muteKey) globalShortcut.unregister(this.muteKey)
    this.muteKey = ''
    if (!wanted) return
    let ok = false
    try {
      ok = globalShortcut.register(wanted, () => this.toggleMicMuted())
    } catch {
      ok = false
    }
    if (ok) this.muteKey = wanted
    else this.log(`recording: mute hotkey ${wanted} unavailable`)
  }

  /** The picker's data (RC·T11): screens and windows except our own, free space and the last choice. */
  async sources(): Promise<{
    sources: RecordingSource[]
    freeBytes: number
    folder: string
    last: RecordingChoice | null
  }> {
    const win = this.mainWindow()
    const own = win && !win.isDestroyed() ? win.getMediaSourceId() : null
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    let windows = 0
    const sources = list
      .filter((s) => s.id !== own)
      // Every screen, but past 30 windows the picker only gets heavier (RC·T22).
      .filter((s) => s.id.startsWith('screen:') || ++windows <= MAX_WINDOWS)
      .map((s): RecordingSource => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        displayId: s.display_id || null,
        thumbnail: s.thumbnail.toDataURL()
      }))
    const folder = this.getSettings().watchDir
    return { sources, freeBytes: await freeBytes(folder), folder, last: loadLastRecording() }
  }

  /** Resolves once the recorder is writing; rejects with a message the picker can show (RC·T12). */
  async start(raw: unknown): Promise<void> {
    if (this.active || this.busy) throw new Error('Already recording')
    const choice = parseChoice(raw)
    const settings = this.getSettings()
    const before = this.state.recording
    this.state.setRecording({ phase: 'starting' })
    let source: DesktopCapturerSource
    let stem: string
    try {
      const free = await freeBytes(settings.watchDir)
      if (diskVerdict(free) === 'refuse')
        throw new Error(`Only ${mb(free)} free in ${settings.watchDir}. Free up some space first.`)
      const found = await this.resolveSource(choice)
      if (!found) throw new Error('That screen or window is no longer there. Pick it again.')
      source = found
      choice.sourceId = found.id
      const taken = await takenStems(this.state, [
        settings.watchDir,
        join(settings.library, 'uploads'),
        join(settings.library, 'compressed')
      ])
      stem = uniqueStem(recordingStem(new Date()), taken)
    } catch (error) {
      this.state.setRecording(before)
      throw error
    }

    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/recorder.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Hidden windows are throttled otherwise: chunks then stall for ~24 s (spike).
        backgroundThrottling: false
      }
    })
    let markFinished = (): void => {}
    const finished = new Promise<void>((resolve) => (markFinished = resolve))
    const started = new Promise<void>((resolve, reject) => {
      const a: Active = {
        win,
        contents: win.webContents,
        choice,
        sourceName: source.name,
        stem,
        file: null,
        stream: null,
        early: [],
        bytes: 0,
        startedAt: 0,
        status: null,
        blocker: null,
        timers: [],
        stalledLogged: false,
        resolveStart: resolve,
        rejectStart: reject,
        finished,
        markFinished,
        ending: null
      }
      this.active = a
      a.timers.push(
        setTimeout(() => {
          if (!a.status) void this.abort(a, new Error('The recorder did not start in time'))
        }, START_TIMEOUT_MS)
      )
      a.contents.on('render-process-gone', (_, details) => {
        this.log(`recording: the recorder window is gone (${details.reason})`)
        a.markFinished()
        void this.stop('crash')
      })
      win.on('closed', () => {
        a.markFinished()
        if (this.active === a) void this.stop('crash')
      })
    })

    // HMR dev server or the built file, as for the main window.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/recorder.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/recorder.html'))
    }
    await started
  }

  /** Stops, saves and queues (RC·T14). Idempotent: a second call returns the same promise. */
  stop(reason: StopReason = 'user'): Promise<void> {
    const a = this.active
    if (!a) return Promise.resolve()
    if (!a.status) return this.abort(a, new Error('The recording was stopped before it started'))
    a.ending ??= this.finalise(a, reason).catch((error) =>
      this.log(`recording: saving failed: ${message(error)}`)
    )
    return a.ending
  }

  /**
   * Startup (RC·T15): a crash leaves `<stem>.mp4.part`; fragmented MP4 plays up to the last fragment, so rename it
   * and let the worker's scan pick it up after the settle wait. Empty leftovers are deleted.
   */
  async recover(): Promise<void> {
    const dir = this.getSettings().watchDir
    const names = await readdir(dir).catch(() => [] as string[])
    const parts = names.filter(isRecordingPart)
    if (parts.length === 0) return
    const taken = new Set(names.filter((n) => !isRecordingPart(n)).map(stemOf))
    for (const name of parts) {
      const part = join(dir, name)
      try {
        if ((await stat(part)).size === 0) {
          await unlink(part)
          continue
        }
        const final = name.slice(0, -PART_SUFFIX.length)
        const stem = uniqueStem(basename(final, extname(final)), taken)
        taken.add(stem.toLowerCase())
        const target = join(dir, stem + extname(final))
        await rename(part, target)
        this.log(`recovered recording ${target}`)
      } catch (error) {
        this.log(`recording: could not recover ${part}: ${message(error)}`)
      }
    }
  }

  // --- Recorder window -----------------------------------------------------------------------

  private onEvent(event: IpcMainEvent, e: RecorderEvent): void {
    const a = this.active
    if (!a || event.sender.id !== a.contents.id || !e || typeof e !== 'object') return
    switch (e.type) {
      case 'ready': {
        const job: RecorderJob = { choice: a.choice, mime: null }
        a.contents.send(RECORDER_IPC.start, job)
        break
      }
      case 'started':
        if (!a.status && !a.ending) {
          this.onStarted(a, e).catch((error) => void this.abort(a, error as Error))
        }
        break
      case 'track-ended':
        if (a.status) {
          this.log('recording: the captured window or screen went away')
          void this.stop('track-ended')
        }
        break
      case 'error':
        if (!a.status) {
          void this.abort(a, new Error(String(e.message)))
        } else {
          // MediaRecorder's errors end the recording; keep what was written.
          this.log(`recording: ${String(e.message)}`)
          void this.stop('crash')
        }
        break
      case 'finished':
        a.markFinished()
        break
    }
  }

  private async onStarted(
    a: Active,
    e: Extract<RecorderEvent, { type: 'started' }>
  ): Promise<void> {
    const extension = extForMime(e.mime)
    if (!extension) throw new Error(`Unexpected recording format: ${e.mime}`)
    const dir = this.getSettings().watchDir
    const file = join(dir, a.stem + extension)
    const stream = createWriteStream(file + PART_SUFFIX, { flags: 'wx' })
    await once(stream, 'open')
    if (a.ending) {
      stream.destroy()
      await unlink(file + PART_SUFFIX).catch(() => {})
      return
    }
    stream.on('error', (error) => {
      this.log(`recording: writing ${file}${PART_SUFFIX} failed: ${error.message}`)
      void this.stop('crash')
    })
    a.file = file
    a.stream = stream
    for (const chunk of a.early.splice(0)) this.write(a, chunk)
    a.startedAt = Date.now()
    const warning = audioWarning(a.choice, e.audio)
    a.status = {
      phase: 'recording',
      startedAt: new Date(a.startedAt).toISOString(),
      file,
      sourceName: a.sourceName,
      audio: e.audio,
      micMuted: false,
      bytes: a.bytes,
      warning: warning && voice(warning, this.getSettings().voice)
    }
    this.state.setRecording(a.status)
    this.syncMuteHotkey()

    // A locked or sleeping screen captures black.
    a.blocker = powerSaveBlocker.start('prevent-display-sleep')
    a.timers.push(
      setInterval(() => {
        if (!a.status || a.ending || a.status.bytes === a.bytes) return
        a.status = { ...a.status, bytes: a.bytes }
        this.state.setRecording(a.status)
      }, BYTES_MS),
      setInterval(() => {
        freeBytes(dir)
          .then((free) => {
            if (!shouldAutoStop(free) || a.ending) return
            this.log(`recording: only ${mb(free)} free, stopping`)
            void this.stop('disk')
          })
          .catch((error) => this.log(`recording: ${message(error)}`))
      }, DISK.checkMs)
    )
    saveLastRecording(a.choice)
    const { audio } = e
    this.log(
      `recording started: ${file} (${a.sourceName}, ${e.width}x${e.height}, ${e.mime}, ` +
        `system audio ${audio.system}, mic ${audio.mic}${audio.micLabel ? ` "${audio.micLabel}"` : ''})`
    )
    a.resolveStart()
  }

  private onChunk(event: IpcMainEvent, data: unknown): void {
    const a = this.active
    if (!a || event.sender.id !== a.contents.id || !(data instanceof Uint8Array)) return
    const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (a.stream) this.write(a, chunk)
    else a.early.push(chunk)
  }

  /** Node queues writes when the disk is behind; nothing is dropped (RC·T13). */
  private write(a: Active, chunk: Buffer): void {
    const stream = a.stream
    if (!stream || stream.writableEnded || stream.destroyed) return
    stream.write(chunk)
    a.bytes += chunk.length
    if (!a.stalledLogged && stream.writableLength > STALL_BYTES) {
      a.stalledLogged = true
      this.log(`recording: ${mb(stream.writableLength)} waiting to be written; the disk is stalled`)
    }
  }

  // --- Ending --------------------------------------------------------------------------------

  /** Close the file, rename it, queue it and report (RC·T14). The file is closed before anything else sees it. */
  private async finalise(a: Active, reason: StopReason): Promise<void> {
    this.state.setRecording({ phase: 'stopping', reason })
    this.syncMuteHotkey()
    if (reason !== 'crash') {
      if (!a.contents.isDestroyed()) a.contents.send(RECORDER_IPC.stop)
      const cap = FINISH_TIMEOUT_MS[reason === 'quit' ? 'quit' : 'other']
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), cap)
      })
      if (await Promise.race([a.finished.then(() => false), timedOut]))
        this.log(`recording: the recorder did not finish within ${cap / 1000} s`)
      clearTimeout(timer)
    }
    const seconds = (Date.now() - a.startedAt) / 1000
    try {
      await this.release(a)
    } finally {
      this.active = null
    }

    const file = a.file as string
    const part = file + PART_SUFFIX
    if (a.bytes === 0) {
      await unlink(part).catch(() => {})
      this.idle({ file, seconds, error: 'Nothing was recorded' })
      return
    }
    try {
      await rename(part, file)
    } catch (error) {
      // The .part stays; the next start recovers it.
      this.log(`recording: could not rename ${part}: ${message(error)}`)
      this.idle({ file: part, seconds, error: `Saved as ${part}, but it could not be renamed` })
      return
    }
    this.log(`recording saved: ${file} (${formatClock(seconds)}, ${mb(a.bytes)}, ${reason})`)
    // On quit the worker is going down; its first scan next time finds the file.
    if (reason !== 'quit') {
      const result = await this.uploads.enqueue(file)
      if (!result.ok) this.log(`recording: not queued: ${result.error}`)
      else if (result.warning) this.log(`recording: ${result.warning}`)
    }
    this.idle({ file, seconds })
    if (reason !== 'quit') {
      const v = this.getSettings().voice
      this.notifier.toast(voice(SAVED_LINE[reason], v, { duration: formatClock(seconds) }), () =>
        this.navigate({ to: 'dashboard' })
      )
    }
  }

  /** Before `started`: drop everything, reject Start with `error` (RC·T12). */
  private abort(a: Active, error: Error): Promise<void> {
    a.ending ??= (async () => {
      this.log(`recording: could not start: ${error.message}`)
      try {
        await this.release(a)
        if (a.file) await unlink(a.file + PART_SUFFIX).catch(() => {})
      } finally {
        if (this.active === a) this.active = null
        this.idle({ file: '', seconds: 0, error: error.message })
        a.rejectStart(error)
      }
    })()
    return a.ending
  }

  /** No recorder window, power blocker or timer outlives a recording; the file is closed. */
  private async release(a: Active): Promise<void> {
    for (const timer of a.timers) clearTimeout(timer)
    a.timers = []
    if (a.blocker !== null) powerSaveBlocker.stop(a.blocker)
    a.blocker = null
    if (!a.win.isDestroyed()) a.win.destroy()
    const stream = a.stream
    if (stream && !stream.closed) {
      const closed = once(stream, 'close').catch(() => {})
      stream.end()
      await closed
    }
  }

  private idle(last: { file: string; seconds: number; error?: string }): void {
    this.state.setRecording({ phase: 'idle', last })
    this.syncMuteHotkey()
  }

  /** The chosen source as desktopCapturer lists it now; a screen is found again by display id (ids can change). */
  private async resolveSource(choice: RecordingChoice): Promise<DesktopCapturerSource | null> {
    const sources = await desktopCapturer.getSources({
      types: [choice.kind],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    return (
      sources.find((s) => s.id === choice.sourceId) ??
      (choice.kind === 'screen' && choice.displayId
        ? sources.find((s) => s.display_id === choice.displayId)
        : undefined) ??
      null
    )
  }
}
