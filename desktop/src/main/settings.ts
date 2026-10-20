import { app } from 'electron'
import Store from 'electron-store'
import { existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { EngineMode, GoogleState, Settings, ThemeSetting } from '@shared/api'
import { DEFAULT_MUTE_HOTKEY, DEFAULT_RECORD_HOTKEY, type RecordingChoice } from '@shared/recording'

export const DEFAULT_PROJECT_ROOT = 'C:\\laragon_bck\\www\\video_automation'

/** An unpackaged build has no resources\engine, so dev runs the project folder (11c·T1). */
const defaultEngine = (): EngineMode => (app.isPackaged ? 'bundled' : 'project')

/**
 * Defaults equal the watcher.py / meeting_notes.py argparse defaults (05·T1). The library defaults to
 * Documents\Miss Minutes for the bundled engine and to <project>\library in developer mode.
 */
export function defaultSettings(
  engine = defaultEngine(),
  projectRoot = DEFAULT_PROJECT_ROOT
): Settings {
  return {
    engine,
    projectRoot,
    profileDir: join(app.getPath('userData'), 'chrome-profile'),
    // Hidden desktop (11f): headless can't be used, AI Studio refuses to generate for it ("permission denied").
    chromeMode: 'hidden',
    library:
      engine === 'bundled'
        ? join(app.getPath('documents'), 'Miss Minutes')
        : join(projectRoot, 'library'),
    watchDir: join(homedir(), 'Videos'),
    interval: 60,
    settle: 120,
    maxAttempts: 3,
    handbrake: '',
    hbPreset: 'Fast 1080p30',
    hbQuality: 25,
    hbEncoder: '',
    hbSpeed: 'background',
    model: 'gemini-3.8-flash',
    fallbackModel: '',
    thinkingLevel: 'low',
    language: 'English',
    context: '',
    retries: 2,
    timeout: 1800,
    uploadTimeout: 1800,
    loginWait: 600,
    port: 9333,
    keepBrowser: false,
    openAtLogin: true,
    startHidden: true,
    notify: { done: true, failedFinal: true, everyFailure: false },
    theme: 'system',
    voice: true,
    // Not an engine argument (toArgs), so toggling it never restarts the worker (SS·T12).
    smartSearch: false,
    // App-only too; Ctrl+Shift+R would steal the browsers' hard refresh (RC·T19).
    recordHotkey: DEFAULT_RECORD_HOTKEY,
    muteHotkey: DEFAULT_MUTE_HOTKEY,
    recordingToolbar: true,
    // App-only as well: the Meet prompt (MD·T7) never restarts the worker.
    meetingPrompt: true
  }
}

/** nativeTheme.themeSource for each theme setting. The renderer follows prefers-color-scheme (lib/theme.ts). */
export const THEME_SOURCE: Record<ThemeSetting, 'system' | 'light' | 'dark'> = {
  system: 'system',
  office: 'light',
  crt: 'dark'
}

/** --background of each mode in styles/theme.css, so the window doesn't flash before the page paints. */
export const WINDOW_BACKGROUND = { light: '#F4EBD9', dark: '#16100B' } as const

// --- Persistence (%APPDATA%/Miss Minutes/config.json) ----------------------------------------

interface StoreShape {
  /** Only what the user set: anything else follows its (engine-dependent) default. */
  settings: Partial<Settings>
  /** The "still running in the tray" hint is shown once, the first time the window is closed. */
  trayHintShown: boolean
  /** The first-run wizard was finished (11c·T1). An upgraded install has none, so it goes through the wizard. */
  setupDone: boolean
  /** From the last signin_ok, cleared by signout_ok (11c·T5). */
  googleAccount: GoogleState['account']
  /** The picker's last Start (RC·T11), preselected next time; not a setting. */
  lastRecording: RecordingChoice | null
  /** Where the user dragged the recording mini-toolbar (RC·T29); null = top centre of the primary display. */
  toolbarPosition: { x: number; y: number } | null
}

let store: Store<StoreShape> | null = null

function getStore(): Store<StoreShape> {
  store ??= new Store<StoreShape>({
    defaults: {
      settings: {},
      trayHintShown: false,
      setupDone: false,
      googleAccount: null,
      lastRecording: null,
      toolbarPosition: null
    }
  })
  return store
}

const ENGINES: string[] = ['bundled', 'project']
const CHROME_MODES: string[] = ['hidden', 'visible']

const storedEngine = (stored: Partial<Settings>): EngineMode =>
  stored.engine && ENGINES.includes(stored.engine) ? stored.engine : defaultEngine()

/**
 * Stored values over the defaults, known keys only (nested `notify` too): settings added later get their default,
 * and removed ones (e.g. the old `notify.login`) are dropped.
 */
export function loadSettings(): Settings {
  const pick = <T extends object>(defaults: T, stored: Partial<T> | undefined): T =>
    Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [
        k,
        stored && k in stored ? stored[k as keyof T] : v
      ])
    ) as T
  const stored = getStore().get('settings')
  const defaults = defaultSettings(storedEngine(stored))
  return { ...pick(defaults, stored), notify: pick(defaults.notify, stored.notify) }
}

const THEMES: string[] = ['system', 'office', 'crt']
const THINKING: string[] = ['low', 'medium', 'high']
const HB_SPEEDS: string[] = ['background', 'full']

/**
 * Applies a renderer patch after a shallow type check against the defaults (unknown keys and wrong types are
 * rejected). Value ranges are argparse's job: a bad value shows up as a worker that refuses to start.
 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const defaults = defaultSettings()
  // Stored = the earlier choices plus this patch, so a dev run (engine: project) doesn't pin the engine or the
  // library of the installed app, which shares this config.json.
  const next: Record<string, unknown> = { ...getStore().get('settings') }
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (!(name in defaults)) throw new Error(`unknown setting: ${name}`)
    const expected = typeof defaults[name as keyof Settings]
    if (typeof value !== expected || value === null)
      throw new Error(`${name} must be a ${expected}`)
    if (expected === 'number' && !Number.isFinite(value))
      throw new Error(`${name} must be a number`)
    if (name === 'theme' && !THEMES.includes(value as string))
      throw new Error(`unknown theme: ${value}`)
    if (name === 'thinkingLevel' && !THINKING.includes(value as string))
      throw new Error(`unknown thinking level: ${value}`)
    if (name === 'hbSpeed' && !HB_SPEEDS.includes(value as string))
      throw new Error(`unknown compression speed: ${value}`)
    if (name === 'engine' && !ENGINES.includes(value as string))
      throw new Error(`unknown engine: ${value}`)
    if (name === 'chromeMode' && !CHROME_MODES.includes(value as string))
      throw new Error(`unknown Chrome mode: ${value}`)
    if (name === 'notify') {
      const notify: Record<string, boolean> = { ...current.notify }
      for (const [k, v] of Object.entries(value as object)) {
        if (!(k in defaults.notify) || typeof v !== 'boolean') throw new Error(`bad notify.${k}`)
        notify[k] = v
      }
      next.notify = notify
      continue
    }
    next[name] = value
  }
  getStore().set('settings', next as Partial<Settings>)
  const saved = loadSettings()
  recordUninstallInfo(saved)
  return saved
}

/**
 * %APPDATA%\Miss Minutes\uninstall.ini tells the uninstaller (build/installer.nsh) which library it may offer to
 * delete. UTF-16 with a BOM, the encoding GetPrivateProfileString reads for any path. Only the installed app
 * writes it: a dev run shares this folder and would point it at the project's library.
 */
export function recordUninstallInfo(s: Settings): void {
  if (!app.isPackaged) return
  const ini = `[library]\r\npath=${s.library}\r\nengine=${s.engine}\r\n`
  try {
    writeFileSync(join(app.getPath('userData'), 'uninstall.ini'), `\ufeff${ini}`, 'utf16le')
  } catch {
    // Best effort: without it the uninstaller just doesn't offer to delete the library.
  }
}

export const isSetupDone = (): boolean => getStore().get('setupDone')
export const markSetupDone = (): void => getStore().set('setupDone', true)
export const loadGoogleAccount = (): GoogleState['account'] => getStore().get('googleAccount')
export const saveGoogleAccount = (account: GoogleState['account']): void =>
  getStore().set('googleAccount', account)

/** True only the first time it is called (ever). */
export function takeTrayHint(): boolean {
  if (getStore().get('trayHintShown')) return false
  getStore().set('trayHintShown', true)
  return true
}

export const loadLastRecording = (): RecordingChoice | null => getStore().get('lastRecording')
export const saveLastRecording = (choice: RecordingChoice): void =>
  getStore().set('lastRecording', choice)

export const loadToolbarPosition = (): { x: number; y: number } | null =>
  getStore().get('toolbarPosition')
export const saveToolbarPosition = (position: { x: number; y: number }): void =>
  getStore().set('toolbarPosition', position)

// --- Engine command line (the one spawn resolver, 11c·T2) -------------------------------------

/** Engine subcommands the app runs: the worker, and the wizard's / account card's one-shot commands. */
export type Subcommand = 'serve' | 'check' | 'signin'

export interface EngineCommand {
  exe: string
  args: string[]
  cwd: string
}

const pythonPath = (projectRoot: string): string =>
  join(projectRoot, '.venv', 'Scripts', 'python.exe')

/** Why `projectRoot` can't run the engine in developer mode, or null when it can. */
export function validateRoot(projectRoot: string): string | null {
  if (!existsSync(pythonPath(projectRoot)))
    return `Python not found at ${pythonPath(projectRoot)}. Check the project folder in Settings.`
  if (!existsSync(join(projectRoot, 'watcher.py')))
    return `watcher.py not found in ${projectRoot}. Check the project folder in Settings.`
  return null
}

const bundledEngine = (): string => join(process.resourcesPath, 'engine', 'mm-engine.exe')
const bundledHandbrake = (): string => join(process.resourcesPath, 'handbrake', 'HandBrakeCLI.exe')

/**
 * What to spawn for a subcommand with these settings, or why it can't be. Every engine process (the worker,
 * `check`, `signin`) goes through here. bundled = resources\engine\mm-engine.exe with the profile folder and
 * the bundled HandBrake (unless one is set); project = today's `.venv python -u watcher.py` in the project
 * folder, with the engine's own profile (.chrome-automation).
 */
export function engineCommand(
  s: Settings,
  sub: Subcommand = 'serve',
  extra: string[] = []
): EngineCommand | { problem: string } {
  if (s.engine === 'bundled') {
    if (!existsSync(bundledEngine()))
      return { problem: "Miss Minutes' engine is missing; reinstall Miss Minutes." }
    const handbrake = s.handbrake.trim() || bundledHandbrake()
    return {
      exe: bundledEngine(),
      args: [...toArgs({ ...s, handbrake }, sub, s.profileDir), ...extra],
      cwd: app.getPath('userData')
    }
  }
  const problem = validateRoot(s.projectRoot)
  if (problem) return { problem }
  return {
    exe: pythonPath(s.projectRoot),
    args: ['-u', 'watcher.py', ...toArgs(s, sub, null), ...extra],
    cwd: s.projectRoot
  }
}

/** Why no engine can be started with these settings, or null. */
export function engineProblem(s: Settings): string | null {
  const command = engineCommand(s)
  return 'problem' in command ? command.problem : null
}

const contextFile = (): string => join(app.getPath('userData'), 'context.md')

/**
 * Engine arguments (after `watcher.py`) for one subcommand. Empty optional settings are left out (argparse
 * defaults apply); `--opt=value` keeps a value that starts with "-" from being read as a flag. The context goes
 * through a file (--context-file), written by writeContextFile() right before the serve spawn. `profileDir`
 * is null in developer mode. Only serve gets --hidden: sign-in always needs a visible window.
 */
export function toArgs(s: Settings, sub: Subcommand, profileDir: string | null): string[] {
  const opt = (flag: string, value: string | number): string => `--${flag}=${value}`
  const optional = (flag: string, value: string): string[] =>
    value.trim() ? [opt(flag, value.trim())] : []
  const profile = profileDir ? [opt('profile-dir', profileDir)] : []
  if (sub === 'check')
    return [
      opt('library', s.library),
      'check',
      opt('watch-dir', s.watchDir),
      ...optional('handbrake', s.handbrake),
      ...profile
    ]
  if (sub === 'signin')
    return [
      opt('library', s.library),
      'signin',
      opt('model', s.model),
      opt('login-wait', s.loginWait),
      opt('port', s.port),
      ...profile
    ]
  return [
    opt('library', s.library),
    'serve',
    opt('watch-dir', s.watchDir),
    opt('interval', s.interval),
    opt('settle', s.settle),
    opt('max-attempts', s.maxAttempts),
    ...optional('handbrake', s.handbrake),
    opt('hb-preset', s.hbPreset),
    opt('hb-quality', s.hbQuality),
    ...optional('hb-encoder', s.hbEncoder),
    opt('hb-speed', s.hbSpeed),
    opt('model', s.model),
    ...optional('fallback-model', s.fallbackModel),
    opt('thinking-level', s.thinkingLevel),
    opt('language', s.language),
    ...(s.context.trim() ? [opt('context-file', contextFile())] : []),
    opt('retries', s.retries),
    opt('timeout', s.timeout),
    opt('upload-timeout', s.uploadTimeout),
    opt('login-wait', s.loginWait),
    opt('port', s.port),
    ...(s.keepBrowser ? ['--keep-browser'] : []),
    ...profile,
    // Anything but 'visible' (also a stored 'headless' from before 11f) runs on the hidden desktop.
    ...(s.chromeMode !== 'visible' ? ['--hidden'] : [])
  ]
}

export function writeContextFile(s: Settings): void {
  if (s.context.trim()) writeFileSync(contextFile(), s.context, 'utf-8')
}

/** Everything the worker is started with (engine, exe, args incl. profile and Chrome mode): a change restarts it. */
export const workerSignature = (s: Settings): string =>
  JSON.stringify([engineCommand(s), s.context])
