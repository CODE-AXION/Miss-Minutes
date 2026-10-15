import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { basename, extname, join } from 'path'
import { voice } from '@shared/voice'
import type { Notifier } from './notify'
import type { State } from './state'

const BUSY_FRAMES = 8
const FRAME_MS = 250
/** Windows truncates tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127

type IconName = 'idle' | 'paused' | 'attention' | `busy-${number}`

export interface TrayActions {
  open(): void
  pause(): void
  resume(): void
  scanNow(): void
  openLibrary(): void
  quit(): void
}

const stem = (key: string): string => basename(key, extname(key))

/**
 * Tray icon (04a·T4): red `attention` (worker crashed/locked, Google sign-in needed, an unseen final failure),
 * the animated `busy` clock, amber `paused` (also used for failures that will be retried), grey `idle`.
 */
export class AppTray {
  private tray: Tray
  private icons = new Map<IconName, NativeImage>()
  private frame = 0
  private animation: NodeJS.Timeout | null = null
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

    if (attention) this.setStatic('attention')
    else if (busy) this.animate()
    else this.setStatic(worker.paused || retrying > 0 ? 'paused' : 'idle')

    this.updateMenu()
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
    const signature = JSON.stringify([label, up, worker.paused])
    if (signature === this.menuSignature) return
    this.menuSignature = signature
    const { actions } = this
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Miss Minutes', click: () => actions.open() },
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
    this.tray.destroy()
  }
}
