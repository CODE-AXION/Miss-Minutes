import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import { basename, extname, join } from 'path'
import { formatClock } from '@shared/timestamps'
import { voice } from '@shared/voice'
import type { Notifier } from './notify'
import type { State } from './state'

const BUSY_FRAMES = 8
const FRAME_MS = 250
/** Windows truncates tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127

type IconName = 'idle' | 'paused' | 'attention' | 'recording' | `busy-${number}`

export interface TrayActions {
  open(): void
  pause(): void
  resume(): void
  scanNow(): void
  openLibrary(): void
  /** Idle: open the recording picker; recording: stop and save (RC·T18). */
  toggleRecording(): void
  /** Mute/unmute the mic in the running recording (RC·T27). */
  toggleMicMuted(): void
  quit(): void
}

const stem = (key: string): string => basename(key, extname(key))

/**
 * Tray icon (04a·T4): red `attention` (worker crashed/locked, Google sign-in needed, an unseen final failure),
 * the animated `busy` clock, amber `paused` (also used for failures that will be retried), grey `idle`. The
 * `recording` rec dot outranks them all while the app records (RC·T18).
 */
export class AppTray {
  private tray: Tray
  private icons = new Map<IconName, NativeImage>()
  private frame = 0
  private animation: NodeJS.Timeout | null = null
  /** Ticks the recording time in the tooltip only, so an open menu isn't rebuilt every second. */
  private recordingClock: NodeJS.Timeout | null = null
  private menuSignature = ''

  constructor(
    private trayDir: string,
    private state: State,
    private notifier: Notifier,
    private actions: TrayActions
  ) {
    this.tray = new Tray(this.icon('idle'))
    this.tray.on('click', () => actions.open())
    this.tray.on('double-click', () => actions.open())
    state.on('change', () => this.update())
    notifier.on('change', () => this.update())
    this.update()
  }

  private icon(name: IconName): NativeImage {
    let image = this.icons.get(name)
    if (!image) {
      // createFromPath picks the @1.5x/@2x variant for the display scale itself.
      image = nativeImage.createFromPath(join(this.trayDir, `tray-${name}.png`))
      this.icons.set(name, image)
    }
    return image
  }

  /** Failed videos the worker will try again (not final yet). */
  private retrying(): number {
    const max = this.notifier.maxAttempts()
    return Object.values(this.state.videos).filter((e) => e.status === 'failed' && e.attempts < max)
      .length
  }

  private attention(): string | null {
    const { connection } = this.state.worker
    if (connection === 'crashed') return 'the worker stopped, open the app'
    if (connection === 'locked') return 'another watcher is running'
    if (this.state.lastLoginRequired) return 'sign in to Google in the automation Chrome window'
    const failed = this.notifier.unseenFinalFailures.size
    if (failed > 0) return `${failed} video${failed > 1 ? 's' : ''} failed for good`
    return null
  }

  /** "Compressing 2026-10-14 11-02-10 · 37%" for the current video, or null when nothing runs. */
  private currentJob(withProgress: boolean): string | null {
    const key = this.state.worker.current
    if (!key) return null
    const status = this.state.videos[key]?.status
    const verb =
      status === 'compressing'
        ? 'Compressing'
        : status === 'generating'
          ? 'Generating'
          : 'Processing'
    const pct = this.state.live.progress[key]?.pct
    const progress =
      withProgress && verb === 'Compressing' && pct !== undefined ? ` · ${Math.floor(pct)}%` : ''
    return `${verb} ${stem(key)}${progress}`
  }

  update(): void {
    const { worker } = this.state
    const attention = this.attention()
    const busy = worker.state === 'busy'
    const retrying = this.retrying()

    let status: string
    if (attention) status = attention
    else if (busy) status = this.currentJob(true) ?? 'Busy'
    else if (worker.connection !== 'up') status = 'starting…'
    else if (worker.paused) status = voice('worker.paused', this.state.settings.voice)
    else status = 'Idle'
    if (retrying > 0 && !attention) status += ` (${retrying} will retry)`
    this.tray.setToolTip(`Miss Minutes — ${status}`.slice(0, TOOLTIP_MAX))
    this.updateRecordingClock()

    if (this.state.recording.phase !== 'idle') this.setStatic('recording')
    else if (attention) this.setStatic('attention')
    else if (busy) this.animate()
    else this.setStatic(worker.paused || retrying > 0 ? 'paused' : 'idle')

    this.updateMenu()
  }

  /** "Recording 12:34" / "Saving the recording…", or null when not recording. */
  private recordingTip(): string | null {
    const { recording } = this.state
    switch (recording.phase) {
      case 'idle':
        return null
      case 'starting':
        return 'Starting to record…'
      case 'stopping':
        return 'Saving the recording…'
      case 'recording': {
        const time = formatClock((Date.now() - Date.parse(recording.startedAt)) / 1000)
        return `Recording ${time}${recording.micMuted ? ' · mic muted' : ''}`
      }
    }
  }

  /** While recording, the tooltip shows only the recording and its time, refreshed every second (RC·T18). */
  private updateRecordingClock(): void {
    const tick = (): void => {
      const tip = this.recordingTip()
      if (tip) this.tray.setToolTip(`Miss Minutes — ${tip}`.slice(0, TOOLTIP_MAX))
    }
    tick()
    if (this.state.recording.phase === 'recording') {
      this.recordingClock ??= setInterval(tick, 1000)
    } else if (this.recordingClock) {
      clearInterval(this.recordingClock)
      this.recordingClock = null
    }
  }

  private setStatic(name: IconName): void {
    if (this.animation) clearInterval(this.animation)
    this.animation = null
    this.tray.setImage(this.icon(name))
  }

  /** The minute hand advances every 250 ms, only while busy. */
  private animate(): void {
    if (this.animation) return
    const step = (): void => {
      this.tray.setImage(this.icon(`busy-${this.frame}`))
      this.frame = (this.frame + 1) % BUSY_FRAMES
    }
    step()
    this.animation = setInterval(step, FRAME_MS)
  }

  /** Rebuilt only when its content changes (not on every progress tick), so an open menu stays put. */
  private updateMenu(): void {
    const { worker } = this.state
    const up = worker.connection === 'up'
    const job = this.currentJob(false)
    const label = job ?? (up ? 'Nothing in progress' : `Worker ${worker.connection}`)
    const { phase } = this.state.recording
    // No recording before setup is done: there is no watch folder yet (RC·T20).
    const canRecord = !this.state.setupNeeded
    const { recording } = this.state
    // null = no mic in this recording, so no Mute item.
    const micMuted =
      recording.phase === 'recording' && recording.audio.mic === 'on' ? recording.micMuted : null
    const signature = JSON.stringify([label, up, worker.paused, phase, canRecord, micMuted])
    if (signature === this.menuSignature) return
    this.menuSignature = signature
    const { actions } = this
    const record: MenuItemConstructorOptions[] = !canRecord
      ? []
      : phase === 'idle'
        ? [{ label: 'Start recording…', click: () => actions.toggleRecording() }]
        : phase === 'recording'
          ? [
              { label: 'Stop recording', click: () => actions.toggleRecording() },
              ...(micMuted === null
                ? []
                : [
                    {
                      label: micMuted ? 'Unmute microphone' : 'Mute microphone',
                      click: () => actions.toggleMicMuted()
                    }
                  ])
            ]
          : [{ label: phase === 'starting' ? 'Starting…' : 'Saving…', enabled: false }]
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Miss Minutes', click: () => actions.open() },
        ...record,
        { label, enabled: false },
        { type: 'separator' },
        worker.paused
          ? { label: 'Resume watching', enabled: up, click: () => actions.resume() }
          : { label: 'Pause watching', enabled: up, click: () => actions.pause() },
        { label: 'Scan now', enabled: up, click: () => actions.scanNow() },
        { label: 'Open library folder', click: () => actions.openLibrary() },
        { type: 'separator' },
        { label: 'Quit', click: () => actions.quit() }
      ])
    )
  }

  destroy(): void {
    if (this.animation) clearInterval(this.animation)
    if (this.recordingClock) clearInterval(this.recordingClock)
    this.tray.destroy()
  }
}
