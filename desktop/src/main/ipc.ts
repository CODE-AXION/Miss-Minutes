import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type FileFilter,
  type OpenPathKind,
  type RestartMode,
  type Settings
} from '@shared/api'
import type { Ack, CommandInput, CommandName } from '@shared/protocol'
import { openPath, readHandbrakeLog, readNote, trashMeetingFiles } from './files'
import { mediaInfo } from './media'
import { join } from 'path'
import type { RecordingService } from './recording'
import { DEFAULT_PROJECT_ROOT, validateRoot } from './settings'
import type { SearchService } from './search/service'
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
  search: SearchService
  recording: RecordingService
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

/** Longest search query accepted, and the most passages one search returns. */
const MAX_QUERY = 500
const MAX_LIMIT = 100

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
  // Delete (DM·T1): files to the Recycle Bin first, then the worker updates the index (it refuses while a file is
  // still there, so a scan can't pick the recording up again as new).
  handle(IPC.deleteMeeting, async (key: string, options: { video?: unknown } | undefined) => {
    const entry = ctx.state.videos[key]
    if (!entry) throw new Error('Unknown video')
    if (!ctx.supervisor.up)
      throw new Error('The worker is not running, so the library cannot be changed right now')
    if (ctx.state.worker.current === key || ['compressing', 'generating'].includes(entry.status))
      throw new Error('This video is being processed; delete it once it is done')
    const video = options?.video === true
    if (!video && !entry.notes) throw new Error('This recording has no note to delete')
    await trashMeetingFiles(settings(), key, entry, video)
    const ack = await ctx.supervisor.send({ cmd: 'delete', key, video })
    if (!ack.ok) throw new Error(ack.error ?? 'The worker refused')
  })
  handle(IPC.mediaInfo, (key: string) => {
    if (!(key in ctx.state.videos)) throw new Error('Unknown video')
    return mediaInfo(ctx.state.videos, settings().library, key)
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

  // Search (SS·T16): the renderer gets passages by index key, never file paths.
  handle(
    IPC.searchQuery,
    (q: string, options?: { smart?: boolean; keys?: unknown; limit?: unknown }) => {
      if (typeof q !== 'string' || q.length > MAX_QUERY) throw new Error('Invalid query')
      const keys = options?.keys
      if (
        keys !== undefined &&
        (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && k in ctx.state.videos))
      )
        throw new Error('Unknown video')
      const limit =
        typeof options?.limit === 'number' && Number.isInteger(options.limit)
          ? Math.min(Math.max(options.limit, 1), MAX_LIMIT)
          : undefined
      return ctx.search.query(q, {
        smart: options?.smart === true,
        keys: keys as string[] | undefined,
        limit
      })
    }
  )
  handle(
    IPC.searchSetEnabled,
    async (enabled: boolean, options?: { deleteFiles?: boolean }): Promise<void> => {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
      // smartSearch isn't part of workerSignature, so this save never restarts the engine.
      await ctx.saveSettings({ smartSearch: enabled }, 'after-current')
      if (!enabled && options?.deleteFiles === true) await ctx.search.deleteFiles()
    }
  )
  handle(IPC.searchRetry, () => ctx.search.retry())
  handle(IPC.searchRebuild, () => ctx.search.rebuild())

  // In-app recording (RC·T16): the renderer sends a source id and flags; main picks the folder and the name.
  handle(IPC.recordingSources, () => ctx.recording.sources())
  handle(IPC.recordingStart, (choice: unknown) => ctx.recording.start(choice))
  handle(IPC.recordingStop, () => ctx.recording.stop('user'))
  handle(IPC.recordingMute, (muted: unknown) => ctx.recording.setMicMuted(muted === true))

  handle(IPC.quit, () => ctx.quit())
  handle(IPC.hide, () => ctx.window()?.hide())
  // The UI confirms first when a video is being processed: "now" processes it again after the restart.
  handle(IPC.restartWorker, () => ctx.supervisor.restart('now'))
  handle(IPC.getVersion, () => app.getVersion())
}
