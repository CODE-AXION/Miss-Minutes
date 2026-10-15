import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { AppState, GoogleState, LiveState, Settings, WorkerStatus } from '@shared/api'
import type { HelloEvent, StageEvent, VideoEntry, WorkerMessage } from '@shared/protocol'
import { engineProblem, isSetupDone, loadGoogleAccount, saveGoogleAccount } from './settings'

const BROADCAST_MS = 100

/**
 * The authoritative app state in main. Fed by worker events (`apply`) or, while the worker is down, by reading
 * library/index.json read-only. Main never writes the index.
 *
 * Events: `change` (throttled to ~10/s; listeners read `snapshot()`), `stage` (every stage event, for
 * notifications), `hello`.
 */
export class State extends EventEmitter {
  hello: HelloEvent | null = null
  videos: Record<string, VideoEntry> = {}
  live: LiveState = { progress: {}, settling: {} }
  lastLoginRequired: AppState['lastLoginRequired'] = null
  worker: WorkerStatus = {
    state: null,
    paused: false,
    pauseReason: null,
    current: null,
    queue: [],
    pid: null,
    connection: 'starting'
  }

  private broadcastTimer: NodeJS.Timeout | null = null
  private indexWatcher: FSWatcher | null = null
  private indexReload: NodeJS.Timeout | null = null

  /** engineProblem() of the current settings (11c·T2): no engine to start. */
  engineProblem: string | null
  setupDone = isSetupDone()
  google: GoogleState = { account: loadGoogleAccount(), needsSignin: false }
  signinRunning = false

  constructor(public settings: Settings) {
    super()
    this.engineProblem = engineProblem(settings)
  }

  /** While true the first-run wizard shows, the window opens even with --hidden and the worker isn't started. */
  get setupNeeded(): boolean {
    return !this.setupDone || this.engineProblem !== null
  }

  snapshot(): AppState {
    return {
      worker: this.worker,
      videos: this.videos,
      hello: this.hello,
      live: this.live,
      settings: this.settings,
      engineProblem: this.engineProblem,
      setupNeeded: this.setupNeeded,
      google: this.google,
      signinRunning: this.signinRunning,
      lastLoginRequired: this.lastLoginRequired
    }
  }

  /** Schedules a `change` event; bursts of worker events become one broadcast. */
  changed(): void {
    this.broadcastTimer ??= setTimeout(() => {
      this.broadcastTimer = null
      this.emit('change')
    }, BROADCAST_MS)
  }

  setWorker(patch: Partial<WorkerStatus>): void {
    this.worker = { ...this.worker, ...patch }
    this.changed()
  }

  setSettings(settings: Settings): void {
    this.settings = settings
    this.engineProblem = engineProblem(settings)
    this.changed()
  }

  setSetupDone(): void {
    this.setupDone = true
    this.changed()
  }

  setSigninRunning(running: boolean): void {
    this.signinRunning = running
    this.changed()
  }

  /** A finished signin run: signin_ok stores the account, signout_ok clears it (both persisted). */
  setGoogleAccount(account: GoogleState['account']): void {
    saveGoogleAccount(account)
    this.google = { account, needsSignin: account === null && this.google.needsSignin }
    this.changed()
  }

  apply(event: WorkerMessage): void {
    switch (event.type) {
      case 'hello':
        this.hello = event
        this.emit('hello', event)
        break
      case 'snapshot':
        this.videos = event.videos
        break
      case 'video': {
        this.videos = { ...this.videos, [event.key]: event.entry }
        const { status } = event.entry
        if (status !== 'compressing') this.live.progress = omit(this.live.progress, event.key)
        if (status !== 'pending') this.live.settling = omit(this.live.settling, event.key)
        break
      }
      case 'stage':
        this.applyStage(event)
        break
      case 'progress': {
        const { ts, stage, pct, eta, fps } = event
        this.live.progress = { ...this.live.progress, [event.key]: { ts, stage, pct, eta, fps } }
        break
      }
      case 'settling':
        this.live.settling = {
          ...this.live.settling,
          [event.key]: { ts: event.ts, remaining_s: event.remaining_s }
        }
        break
      case 'worker':
        this.worker = {
          ...this.worker,
          state: event.state,
          paused: event.paused,
          pauseReason: event.pause_reason ?? null,
          current: event.current ?? null,
          queue: event.queue
        }
        break
      case 'ack':
        return // resolved by the supervisor; not state
    }
    this.changed()
  }

  /** The history row itself arrives in the `video` event just before; stages drive the login banner and toasts. */
  private applyStage(event: StageEvent): void {
    if (event.stage === 'login_required') {
      this.lastLoginRequired = {
        key: event.key,
        at: event.ts,
        wait_s: event.detail.wait_s,
        hidden: event.detail.hidden === true
      }
      this.google = { ...this.google, needsSignin: true }
    } else if (event.stage === 'chat_open') {
      // An open chat means the session works again (e.g. signed in in a visible window).
      this.google = { ...this.google, needsSignin: false }
      if (this.lastLoginRequired?.key === event.key) this.lastLoginRequired = null
    } else if (this.lastLoginRequired?.key === event.key) {
      this.lastLoginRequired = null
    }
    this.emit('stage', event)
  }

  /** The worker process is gone: live readings are stale and nobody is waiting for a login any more. */
  workerGone(): void {
    this.live = { progress: {}, settling: {} }
    this.lastLoginRequired = null
    this.worker = {
      ...this.worker,
      state: null,
      pauseReason: null,
      current: null,
      queue: [],
      pid: null
    }
    this.changed()
  }

  // --- Read-only index while the worker is down ----------------------------------------------

  /** Loads library/index.json and follows its changes (e.g. a CLI watcher holding the lock writes it). */
  watchIndex(library: string): void {
    this.unwatchIndex()
    try {
      // The index is replaced through a .tmp rename, so watch the folder, not the file.
      this.indexWatcher = watch(library, (_, file) => {
        if (file !== 'index.json') return
        if (this.indexReload) clearTimeout(this.indexReload)
        this.indexReload = setTimeout(() => void this.loadIndex(library), 300)
      })
      this.indexWatcher.on('error', () => this.unwatchIndex())
    } catch {
      // No library folder yet: nothing to show until the worker creates it.
    }
    void this.loadIndex(library)
  }

  unwatchIndex(): void {
    this.indexWatcher?.close()
    this.indexWatcher = null
    if (this.indexReload) clearTimeout(this.indexReload)
    this.indexReload = null
  }

  private async loadIndex(library: string): Promise<void> {
    try {
      const data = JSON.parse(await readFile(join(library, 'index.json'), 'utf-8'))
      if (this.worker.connection === 'up') return // the worker took over meanwhile; its snapshot wins
      this.videos = data?.videos ?? {}
      this.changed()
    } catch {
      // Missing or half-written: keep what we have; the watcher fires again after the rename.
    }
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const rest = { ...record }
  delete rest[key]
  return rest
}
