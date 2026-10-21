import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import type { Settings } from '@shared/api'
import type { ToolbarState } from '@shared/recording'
import { TOOLBAR_IPC } from '@shared/toolbar-ipc'
import type { RecordingService } from './recording'
import { loadToolbarPosition, saveToolbarPosition } from './settings'
import type { State } from './state'

/** Room for the pill (REC 1:23:45 · Mute · Stop) and its shadow. */
const WIDTH = 250
const HEIGHT = 44
/** Default gap from the top of the primary display's work area. */
const TOP = 8

/**
 * The floating REC pill (RC·T29): shown while a recording runs (setting `recordingToolbar`) and Miss Minutes is not
 * the window in front (the app has its own controls then), always on top of the meeting app, never focused, draggable, and excluded from screen capture (Windows 10 2004+), so it isn't in the
 * video. Stop and Mute go through RecordingService like every other control.
 */
export class RecordingToolbar {
  private win: BrowserWindow | null = null
  private sent = ''
  /** Loaded and ready to show (set on ready-to-show). */
  private ready = false

  constructor(
    private state: State,
    private recording: RecordingService,
    private getSettings: () => Settings,
    private mainWindow: () => BrowserWindow | null
  ) {
    state.on('change', () => this.update())
    app.on('browser-window-focus', () => this.applyVisibility())
    app.on('browser-window-blur', () => this.applyVisibility())
    ipcMain.on(TOOLBAR_IPC.ready, (event) => {
      if (!this.from(event)) return
      this.sent = ''
      this.send()
    })
    ipcMain.on(TOOLBAR_IPC.stop, (event) => {
      if (this.from(event)) void this.recording.stop('user')
    })
    ipcMain.on(TOOLBAR_IPC.mute, (event) => {
      if (this.from(event)) this.recording.toggleMicMuted()
    })
  }

  /** What the pill shows, or null when it should be gone. */
  private view(): ToolbarState | null {
    const { recording } = this.state
    if (recording.phase === 'idle' || !this.getSettings().recordingToolbar) return null
    if (recording.phase !== 'recording')
      return { phase: recording.phase, startedAt: null, hasMic: false, micMuted: false }
    return {
      phase: 'recording',
      startedAt: recording.startedAt,
      hasMic: recording.audio.mic === 'on',
      micMuted: recording.micMuted
    }
  }

  private update(): void {
    const view = this.view()
    if (!view) return this.close()
    if (!this.win) this.open()
    this.send()
    this.applyVisibility()
  }

  /** Hidden while Miss Minutes itself is in front: its header or dashboard already shows the recording. */
  private applyVisibility(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.ready) return
    const main = this.mainWindow()
    const appInFront = !!main && !main.isDestroyed() && main.isVisible() && main.isFocused()
    if (appInFront && win.isVisible()) win.hide()
    else if (!appInFront && !win.isVisible()) win.showInactive()
  }

  /** Only real changes cross IPC; the pill ticks its own clock. */
  private send(): void {
    const view = this.view()
    const win = this.win
    if (!view || !win || win.isDestroyed()) return
    const signature = JSON.stringify(view)
    if (signature === this.sent) return
    this.sent = signature
    win.webContents.send(TOOLBAR_IPC.state, view)
  }

  private from(event: IpcMainEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && event.sender.id === this.win.webContents.id
  }

  private open(): void {
    const { x, y } = this.position()
    const win = new BrowserWindow({
      x,
      y,
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Clicking Stop or Mute must not pull focus away from the meeting app.
      focusable: false,
      title: 'Miss Minutes recording',
      webPreferences: {
        preload: join(__dirname, '../preload/toolbar.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // Above full-screen apps and the taskbar. No setContentProtection: while a capture-excluded window is on screen,
    // Chrome takes 5–8 s to start a screen share (Meet's Present), so the pill shows in captures, ours included.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.once('ready-to-show', () => {
      this.ready = true
      this.applyVisibility()
    })
    win.on('moved', () => {
      const [left, top] = win.getPosition()
      saveToolbarPosition({ x: left, y: top })
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.win = win
    this.sent = ''
    this.ready = false
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toolbar.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/toolbar.html'))
    }
  }

  /** Where the user left it, if that is still on a display; else top centre of the primary display. */
  private position(): { x: number; y: number } {
    const saved = loadToolbarPosition()
    if (saved) {
      const visible = screen.getAllDisplays().some(({ workArea: a }) => {
        const cx = saved.x + WIDTH / 2
        const cy = saved.y + HEIGHT / 2
        return cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height
      })
      if (visible) return saved
    }
    const area = screen.getPrimaryDisplay().workArea
    return { x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + TOP }
  }

  close(): void {
    const win = this.win
    this.win = null
    this.sent = ''
    if (win && !win.isDestroyed()) win.destroy()
  }
}
