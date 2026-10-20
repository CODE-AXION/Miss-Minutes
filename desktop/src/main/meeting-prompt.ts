import { BrowserWindow, ipcMain, type Display, type IpcMainEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import type { PromptView } from '@shared/meetings'
import { PROMPT_IPC } from '@shared/prompt-ipc'
import type { PromptHandlers, PromptWindow } from './meetings'

/** The 360×200 card plus the page's 10 px padding for its shadow. */
const WIDTH = 380
const HEIGHT = 220
/** Window inset from the work area's top-right, so the card itself sits 16 px in. */
const INSET = 6

/**
 * The "record this meeting?" card (MD·T13): a sibling of the REC pill with its window recipe (toolbar.ts), shown at
 * the top-right of the Meet window's screen, never focused and left out of every capture, ours included. The first
 * answer (or main's own timeout, so a frozen page can't keep it up) closes it.
 */
export class MeetingPrompt implements PromptWindow {
  private win: BrowserWindow | null = null
  private view: PromptView | null = null
  private handlers: PromptHandlers | null = null
  private timer: NodeJS.Timeout | null = null

  constructor() {
    ipcMain.on(PROMPT_IPC.ready, (event) => {
      if (this.from(event) && this.view) event.sender.send(PROMPT_IPC.state, this.view)
    })
    ipcMain.on(PROMPT_IPC.record, (event) => this.from(event) && this.finish('onRecord'))
    ipcMain.on(PROMPT_IPC.dismiss, (event) => this.from(event) && this.finish('onDismiss'))
    ipcMain.on(PROMPT_IPC.never, (event) => this.from(event) && this.finish('onNever'))
  }

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  show(view: PromptView, display: Display, handlers: PromptHandlers): void {
    this.close()
    this.view = view
    this.handlers = handlers
    this.timer = setTimeout(
      () => this.finish('onDismiss'),
      Math.max(0, view.expiresAt - Date.now())
    )
    const area = display.workArea
    const win = new BrowserWindow({
      x: Math.round(area.x + area.width - WIDTH - INSET),
      y: Math.round(area.y + INSET),
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Answering must not pull focus away from the meeting.
      focusable: false,
      title: 'Record this meeting?',
      webPreferences: {
        preload: join(__dirname, '../preload/prompt.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // Above full-screen apps and the taskbar, and left out of every screen capture, ours included.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setContentProtection(true)
    win.once('ready-to-show', () => {
      if (this.win === win) win.showInactive()
    })
    win.on('closed', () => {
      if (this.win === win) this.finish('onDismiss')
    })
    this.win = win
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/prompt.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/prompt.html'))
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.view = null
    this.handlers = null
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  /** Only the first answer counts: close() drops the handlers before the chosen one runs. */
  private finish(which: keyof PromptHandlers): void {
    const handlers = this.handlers
    this.close()
    handlers?.[which]()
  }

  private from(event: IpcMainEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && event.sender.id === this.win.webContents.id
  }
}
