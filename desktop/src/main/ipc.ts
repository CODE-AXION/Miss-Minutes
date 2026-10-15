import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type FileFilter,
  type OpenPathKind,
  type RestartMode,
  type Settings
} from '@shared/api'
import type { Ack, CommandInput, CommandName } from '@shared/protocol'
import { openPath, readHandbrakeLog, readNote } from './files'
import { join } from 'path'
import { DEFAULT_PROJECT_ROOT, validateRoot } from './settings'
import { inspectLibrary, type EngineTasks } from './setup'
import type { State } from './state'
import type { Uploads } from './uploads'
import type { LogBuffer, Supervisor } from './worker'

export interface IpcContext {
  state: State
  supervisor: Supervisor
  uploads: Uploads
  log: LogBuffer
  tasks: EngineTasks
  window(): BrowserWindow | null
  saveSettings(patch: Partial<Settings>, restart: RestartMode): Promise<Settings>
  finishSetup(patch: Partial<Settings>): Promise<void>
  quit(): Promise<void>
}

/** Commands the renderer may send. `shutdown` is main's own (quit/restart), so the UI can't strand the app. */
const RENDERER_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'ping',
  'snapshot',
  'scan_now',
  'pause',
  'resume',
  'enqueue',
  'retry',
  'reprocess',
  'include',
  'include_all_baseline',
  'exclude',
  'edit',
  'reindex'
])

const OPEN_KINDS: ReadonlySet<string> = new Set<OpenPathKind>([
  'note',
  'noteFolder',
  'library',
  'index',
  'source',
  'compressed',
  'hbLog'
])

export function registerIpc(ctx: IpcContext): void {
  /** Only our own window may call main. */
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== ctx.window()?.webContents) throw new Error('Unknown sender')
      return fn(...(args as A))
    })
  }
  const settings = (): Settings => ctx.state.settings
  const dialogParent = (): BrowserWindow => {
    const win = ctx.window()
    if (!win) throw new Error('No window')
    return win
  }

  handle(IPC.getState, () => ctx.state.snapshot())
  handle(IPC.command, async (cmd: CommandInput): Promise<Ack> => {
    if (!cmd || !RENDERER_COMMANDS.has(cmd.cmd)) return { ok: false, error: 'Unknown command' }
    if (!ctx.supervisor.up) {
      return {
        ok: false,
        error: 'The worker is not running, so the library cannot be changed right now'
      }
    }
    try {
      return await ctx.supervisor.send(cmd)
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  handle(IPC.uploadFiles, (paths: string[]) => ctx.uploads.add(paths))
  handle(IPC.pickFiles, async (): Promise<string[]> => {
    const extensions = (ctx.state.hello?.video_extensions ?? []).map((e) => e.replace(/^\./, ''))
    const result = await dialog.showOpenDialog(dialogParent(), {
      title: 'Add videos',
      properties: ['openFile', 'multiSelections'],
      filters: extensions.length ? [{ name: 'Videos', extensions }] : []
    })
    return result.canceled ? [] : result.filePaths
  })

  handle(IPC.readNote, (relPath: string) => readNote(settings(), relPath))
  handle(IPC.readHandbrakeLog, (key: string) => {
    if (!(key in ctx.state.videos)) throw new Error('Unknown video')
    return readHandbrakeLog(settings(), key)
  })
  handle(IPC.getWorkerLog, () => ctx.log.lines)
  handle(IPC.openPath, (kind: OpenPathKind, key?: string) => {
    if (!OPEN_KINDS.has(kind)) throw new Error(`Unknown kind: ${kind}`)
    return openPath(settings(), kind, key ? ctx.state.videos[key] : undefined)
  })

  handle(IPC.getSettings, () => settings())
  handle(IPC.saveSettings, (patch: Partial<Settings>, options?: { restart?: RestartMode }) => {
    const restart = options?.restart ?? 'after-current'
    if (restart !== 'after-current' && restart !== 'now')
      throw new Error(`Unknown restart mode: ${restart}`)
    return ctx.saveSettings(patch, restart)
  })
  handle(IPC.pickFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  handle(IPC.pickFile, async (filters?: FileFilter[]): Promise<string | null> => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      properties: ['openFile'],
      filters: Array.isArray(filters) ? filters : []
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle(IPC.checkProjectRoot, (root: string) => {
    if (typeof root !== 'string' || !root.trim()) return 'Choose a folder'
    return validateRoot(root)
  })

  // First-run wizard (11c·T3) and the Google account card (T5); all of it spawns through engineCommand().
  handle(IPC.setupCheck, (watchDir: string) => {
    if (typeof watchDir !== 'string' || !watchDir.trim()) throw new Error('Choose a folder')
    return ctx.tasks.check(watchDir)
  })
  handle(IPC.setupSignin, (options?: { switch?: boolean }) =>
    ctx.tasks.runSignin(options?.switch === true ? 'switch' : 'signin', { setup: true })
  )
  handle(IPC.setupLibraryOptions, async () => ({
    newLibrary: join(app.getPath('documents'), 'Miss Minutes'),
    found: await inspectLibrary(join(DEFAULT_PROJECT_ROOT, 'library'))
  }))
  handle(IPC.setupInspectLibrary, (folder: string) => {
    if (typeof folder !== 'string' || !folder.trim()) return null
    return inspectLibrary(folder)
  })
  handle(IPC.setupFinish, (patch: Partial<Settings>) => ctx.finishSetup(patch ?? {}))
  handle(IPC.signinCancel, () => ctx.tasks.cancelSignin())
  handle(IPC.accountSignin, (options?: { switch?: boolean }) =>
    ctx.tasks.runSignin(options?.switch === true ? 'switch' : 'signin')
  )
  handle(IPC.accountSignout, () => ctx.tasks.runSignin('signout'))
  handle(IPC.accountResetProfile, () => ctx.tasks.resetProfile())

  handle(IPC.quit, () => ctx.quit())
  handle(IPC.hide, () => ctx.window()?.hide())
  // The UI confirms first when a video is being processed: "now" processes it again after the restart.
  handle(IPC.restartWorker, () => ctx.supervisor.restart('now'))
  handle(IPC.getVersion, () => app.getVersion())
}
