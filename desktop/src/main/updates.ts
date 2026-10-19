import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { Settings } from '@shared/api'
import { voice } from '@shared/voice'
import type { Notifier } from './notify'
import type { State } from './state'

// electron-updater is CommonJS; its named exports aren't visible to the ESM build.
const { autoUpdater } = electronUpdater

/** First look a little after startup, then every few hours while the app runs in the tray. */
const FIRST_CHECK_MS = 15_000
const CHECK_MS = 4 * 60 * 60 * 1000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** electron-updater's errors carry HTTP headers and a stack; Settings gets the first sentence (the log has it all). */
const short = (error: unknown): string =>
  message(error)
    .split('\n')[0]
    .replace(/:\s*HttpError:.*$/, '')
    .trim()

/**
 * App updates from GitHub Releases (UP·T2): checks at startup and every 4 hours, downloads a newer version in the
 * background and publishes `AppState.update`. A downloaded update installs on Restart (`install`), or silently the
 * next time the app quits (quitApp calls `installOnQuit`, since it exits with app.exit, which skips the updater's
 * own quit hook). Only an installed build updates: a development run stays `off`.
 *
 * MM_DEV_UPDATES=1 (development only) reads dev-app-update.yml instead, e.g. a local test server, to try the flow;
 * it never installs, since that would run the installer over the real installed app.
 */
const devTest = !app.isPackaged && process.env['MM_DEV_UPDATES'] === '1'

export class Updater {
  private timers: NodeJS.Timeout[] = []

  constructor(
    private state: State,
    private notifier: Notifier,
    private log: (text: string) => void,
    private getSettings: () => Settings
  ) {}

  start(): void {
    if (!app.isPackaged && !devTest) return
    autoUpdater.forceDevUpdateConfig = devTest
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    // The release is the full NSIS installer, never a web installer.
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      info: (m: unknown) => this.log(`update: ${String(m)}`),
      warn: (m: unknown) => this.log(`update: ${String(m)}`),
      error: (m: unknown) => this.log(`update: ${String(m)}`),
      debug: () => {}
    }
    autoUpdater.on('checking-for-update', () => {
      if (this.state.update.phase === 'idle') this.state.setUpdate({ phase: 'checking' })
    })
    autoUpdater.on('update-not-available', () =>
      this.state.setUpdate({ phase: 'idle', checkedAt: new Date().toISOString() })
    )
    autoUpdater.on('update-available', (info) =>
      this.state.setUpdate({ phase: 'downloading', version: info.version, percent: 0 })
    )
    autoUpdater.on('download-progress', (progress) => {
      const current = this.state.update
      const percent = Math.floor(progress.percent)
      if (current.phase === 'downloading' && percent !== current.percent)
        this.state.setUpdate({ ...current, percent })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.state.setUpdate({ phase: 'ready', version: info.version })
      this.notifier.toast(
        voice('update.ready', this.getSettings().voice, { version: info.version }),
        () => void this.install().catch(() => {})
      )
    })
    autoUpdater.on('error', (error) => {
      // A failed check or download keeps a downloaded update; otherwise say why on the next look.
      if (this.state.update.phase === 'ready') return
      this.state.setUpdate({
        phase: 'idle',
        checkedAt: new Date().toISOString(),
        error: short(error)
      })
    })
    this.state.setUpdate({ phase: 'idle', checkedAt: null })
    const check = (): void => void this.check().catch(() => {})
    this.timers.push(setTimeout(check, FIRST_CHECK_MS), setInterval(check, CHECK_MS))
  }

  /** Settings → Check for updates, and the timers. Nothing to do while one downloads or waits to install. */
  async check(): Promise<void> {
    const { phase } = this.state.update
    if (phase === 'off') throw new Error('Updates only work in the installed app')
    if (phase === 'checking' || phase === 'downloading' || phase === 'ready') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // Also reported through the `error` event, which records it in the state.
      throw new Error(`Could not check for updates: ${short(error)}`)
    }
  }

  get ready(): boolean {
    return this.state.update.phase === 'ready'
  }

  /** Restart to update; set by index.ts to quit cleanly (recording, worker, search) and then reopen. */
  install: () => Promise<void> = async () => {}

  /** The last step of quitting: run the downloaded installer silently, reopening the app if `relaunch`. */
  installOnQuit(relaunch: boolean): void {
    if (devTest) {
      this.log('update: MM_DEV_UPDATES run, not installing')
      app.exit(0)
      return
    }
    this.log(
      `update: installing ${this.state.update.phase === 'ready' ? this.state.update.version : ''}`
    )
    autoUpdater.quitAndInstall(true, relaunch)
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
}
