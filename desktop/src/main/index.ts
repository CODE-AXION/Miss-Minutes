import { app, shell, BrowserWindow, dialog, nativeTheme } from 'electron'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC, type NavigateRequest, type RestartMode, type Settings } from '@shared/api'
import { voice } from '@shared/voice'
import { registerIpc } from './ipc'
import { Notifier } from './notify'
import {
  loadSettings,
  markSetupDone,
  recordUninstallInfo,
  saveSettings,
  takeTrayHint,
  THEME_SOURCE,
  WINDOW_BACKGROUND,
  workerSignature
} from './settings'
import { SearchService } from './search/service'
import { EngineTasks } from './setup'
import { State } from './state'
import { AppTray } from './tray'
import { Uploads } from './uploads'
import { LogBuffer, Supervisor } from './worker'
import icon from '../../resources/icon.png?asset'

// One app instance = one worker = one writer of index.json (the worker lock also guards against the CLI).
const primary = app.requestSingleInstanceLock()
if (!primary) app.exit(0)

/** resources/ next to the app; electron-builder unpacks it from the asar (asarUnpack). */
const resourcesDir = join(__dirname, '../../resources').replace('app.asar', 'app.asar.unpacked')
const startHidden = process.argv.includes('--hidden')

const state = new State(loadSettings())
const log = new LogBuffer(join(state.settings.library, 'logs'))
const supervisor = new Supervisor(state, log, () => state.settings)
// Search runs in main and its own utilityProcess, so it keeps working while the engine is down (SS·T14).
const search = new SearchService(state, app.getPath('userData'), (text) => log.add('app', text))
let mainWindow: BrowserWindow | null = null
let tray: AppTray | null = null
let notifier: Notifier | null = null
let isQuitting = false
/** The state changed while the window was hidden: send it on the next show. */
let stateDirty = false

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function navigate(request: NavigateRequest): void {
  showWindow()
  send(IPC.navigate, request)
}

function windowBackground(): string {
  return WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Miss Minutes',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon,
    // Matches the theme background so there is no white flash before the page paints.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = win

  // --hidden (autostart) still opens the window while setup is needed (09·T2, 11c·T3).
  win.on('ready-to-show', () => {
    if (!startHidden || state.setupNeeded) win.show()
  })

  // Closing only hides: the worker keeps processing and the tray stays. Quit is in the tray menu.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
    if (takeTrayHint()) notifier?.toast(voice('tray.closed', state.settings.voice))
  })

  // A minimized window isn't isVisible() either, and un-minimizing fires 'restore', not 'show'.
  const onSeen = (): void => {
    notifier?.acknowledge()
    if (stateDirty) {
      stateDirty = false
      send(IPC.state, state.snapshot())
    }
  }
  win.on('show', onSeen)
  win.on('restore', onSeen)

  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for the renderer in dev (electron-vite), the built file otherwise.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Registry value name of the autostart entry (HKCU\…\Run); build/installer.nsh deletes it on uninstall. */
const LOGIN_ITEM_NAME = 'Miss Minutes'

/** Autostart at Windows login, hidden. Packaged builds only: in dev it would register electron.exe. */
function applyLoginItem(settings: Settings): void {
  if (!app.isPackaged) {
    log.add('app', `autostart (openAtLogin=${settings.openAtLogin}) is skipped in dev builds`)
    return
  }
  app.setLoginItemSettings({
    name: LOGIN_ITEM_NAME,
    openAtLogin: settings.openAtLogin,
    args: settings.startHidden ? ['--hidden'] : []
  })
}

function applyTheme(settings: Settings): void {
  // The renderer follows prefers-color-scheme, which Electron derives from nativeTheme.
  nativeTheme.themeSource = THEME_SOURCE[settings.theme]
}

async function updateSettings(patch: Partial<Settings>, restart: RestartMode): Promise<Settings> {
  const before = state.settings
  const next = saveSettings(patch)
  state.setSettings(next)
  log.setLogsDir(join(next.library, 'logs'))
  if (next.theme !== before.theme) applyTheme(next)
  if (next.openAtLogin !== before.openAtLogin || next.startHidden !== before.startHidden)
    applyLoginItem(next)
  // Not awaited: a library switch or turning smart search off must not hold up the save.
  search
    .applySettings(before, next)
    .catch((error: Error) => log.add('app', `search: ${error.message}`))
  if (workerSignature(next) !== workerSignature(before)) {
    if (!supervisor.up && next.library !== before.library) state.watchIndex(next.library)
    await supervisor.restart(restart)
  }
  return next
}

/**
 * The wizard's Finish (11c·T3): save its choices, create the library, mark setup done, apply autostart and
 * start the worker. Refused while the engine can't start (the wizard stays).
 */
async function finishSetup(patch: Partial<Settings>): Promise<void> {
  const next = await updateSettings(patch, 'now')
  if (state.engineProblem) throw new Error(state.engineProblem)
  await mkdir(next.library, { recursive: true })
  markSetupDone()
  state.setSetupDone()
  applyLoginItem(next)
  log.add('app', 'first-run setup finished')
  state.watchIndex(next.library)
  supervisor.start()
}

/** Tray Quit / the app's Quit: ask first while a video is being processed, then end the worker and the app. */
async function quitApp({ confirm = true } = {}): Promise<void> {
  if (isQuitting) return
  if (confirm && supervisor.busy) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Miss Minutes',
      message: 'A video is being processed. Quit anyway?',
      detail: 'It will be processed again next time Miss Minutes starts.',
      buttons: ['Quit anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return
  }
  isQuitting = true
  await Promise.all([
    supervisor.shutdownForQuit(),
    search.dispose().catch((error: Error) => log.add('app', `search: ${error.message}`))
  ])
  await log.flush()
  tray?.destroy()
  app.exit(0)
}

app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  if (!primary) return
  electronApp.setAppUserModelId('com.finloge.missminutes')

  // F12 toggles DevTools in dev; Ctrl+R reload is ignored in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  applyTheme(state.settings)
  recordUninstallInfo(state.settings)
  nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackground()))
  // Before setup is done, autostart is the wizard's choice (setup:finish applies it).
  if (state.setupDone) applyLoginItem(state.settings)

  notifier = new Notifier(
    state,
    () => state.settings,
    join(resourcesDir, 'mascot.png'),
    (key) => navigate({ to: 'video', key }),
    () => navigate({ to: 'signin' })
  )
  const uploads = new Uploads(
    state,
    supervisor,
    () => state.settings,
    (progress) => send(IPC.uploadProgress, progress)
  )

  state.on('change', () => {
    if (mainWindow?.isVisible()) send(IPC.state, state.snapshot())
    else stateDirty = true
  })
  log.on('lines', (lines) => send(IPC.log, lines))

  const tasks = new EngineTasks(state, supervisor, log, (event) => send(IPC.setupEvent, event))

  registerIpc({
    state,
    supervisor,
    uploads,
    log,
    tasks,
    search,
    window: () => mainWindow,
    saveSettings: updateSettings,
    finishSetup,
    quit: () => quitApp()
  })

  createWindow()

  const command = (cmd: 'pause' | 'resume' | 'scan_now'): void => {
    supervisor
      .send({ cmd })
      .catch((error: Error) => log.add('app', `${cmd} failed: ${error.message}`))
  }
  tray = new AppTray(join(resourcesDir, 'tray'), state, notifier, {
    open: showWindow,
    pause: () => command('pause'),
    resume: () => command('resume'),
    scanNow: () => command('scan_now'),
    openLibrary: () => void shell.openPath(state.settings.library),
    quit: () => void quitApp()
  })

  // The library shows right away (read-only); the worker's snapshot replaces it once it is up.
  state.watchIndex(state.settings.library)
  supervisor.start()
  search.start(state.settings).catch((error: Error) => log.add('app', `search: ${error.message}`))
})

// A tray app: closing the window never quits.
app.on('window-all-closed', () => {})

// Quits we didn't start (Windows logoff/shutdown): no dialog, just end the worker.
app.on('before-quit', (event) => {
  if (isQuitting || !primary) return
  event.preventDefault()
  void quitApp({ confirm: false })
})

app.on('will-quit', () => supervisor.killNow())
