/**
 * Renderer state: a mirror of main's AppState (hydrated by getState(), then replaced on every onState push) plus
 * the upload list. The renderer never changes app state locally: actions are commands, and the UI updates when the
 * resulting events come back through main.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import type { AppState, UploadResult } from '@shared/api'
import type { CommandInput, VideoEntry } from '@shared/protocol'
import { fileName } from '@/lib/format'

export interface UploadItem {
  id: number
  path: string
  name: string
  copied: number
  total: number
  status: 'waiting' | 'copying' | 'queued' | 'error'
  dest?: string
  error?: string
  warning?: string
}

interface AppStore {
  state: AppState | null
  uploads: UploadItem[]
  upload(paths: string[]): Promise<void>
  clearFinishedUploads(): void
}

let nextUploadId = 1

export const useApp = create<AppStore>((set, get) => ({
  state: null,
  uploads: [],

  async upload(paths) {
    if (paths.length === 0) return
    const items: UploadItem[] = paths.map((path) => ({
      id: nextUploadId++,
      path,
      name: fileName(path),
      copied: 0,
      total: 0,
      status: 'waiting'
    }))
    set({ uploads: [...get().uploads, ...items] })
    let results: UploadResult[]
    try {
      results = await window.api.uploadFiles(paths)
    } catch (error) {
      results = paths.map((path) => ({ path, ok: false, error: (error as Error).message }))
    }
    // Main copies in order and answers in the same order.
    const done = new Map(items.map((item, i) => [item.id, results[i]]))
    set({
      uploads: get().uploads.map((item) => {
        const result = done.get(item.id)
        if (!result) return item
        return {
          ...item,
          status: result.ok ? 'queued' : 'error',
          copied: result.ok ? item.total || item.copied : item.copied,
          dest: result.dest,
          error: result.error,
          warning: result.warning
        }
      })
    })
  },

  clearFinishedUploads() {
    set({ uploads: get().uploads.filter((u) => u.status === 'waiting' || u.status === 'copying') })
  }
}))

/** Hydrates the store and subscribes to main's pushes. Returns the unsubscribe function. */
export function connectStore(): () => void {
  let live = true
  void window.api.getState().then((state) => {
    if (live && !useApp.getState().state) useApp.setState({ state })
  })
  const offState = window.api.onState((state) => useApp.setState({ state }))
  const offProgress = window.api.onUploadProgress(({ path, copied, total }) => {
    const uploads = useApp.getState().uploads
    const target = uploads.find(
      (u) => u.path === path && (u.status === 'waiting' || u.status === 'copying')
    )
    if (!target) return
    useApp.setState({
      uploads: uploads.map((u) => (u === target ? { ...u, copied, total, status: 'copying' } : u))
    })
  })
  return () => {
    live = false
    offState()
    offProgress()
  }
}

// --- Selectors (pure, on AppState) ----------------------------------------------------------

/** Attempts after which a failure is final: what the running worker uses, else the setting. */
export function maxAttempts(state: AppState): number {
  const fromWorker = state.hello?.settings.max_attempts
  return typeof fromWorker === 'number' ? fromWorker : state.settings.maxAttempts
}

export function isFinalFailure(entry: VideoEntry, max: number): boolean {
  return entry.status === 'failed' && entry.attempts >= max
}

export const ACTIVE_STATUSES = new Set(['compressing', 'compressed', 'generating'])

/** Everything the Queue page lists: not done and not baseline. */
export function queueEntries(state: AppState): [string, VideoEntry][] {
  return Object.entries(state.videos).filter(
    ([, e]) => e.status !== 'done' && e.status !== 'baseline'
  )
}

export function failedCount(state: AppState): number {
  return Object.values(state.videos).filter((e) => e.status === 'failed').length
}

export function doneCount(state: AppState): number {
  return Object.values(state.videos).filter((e) => e.status === 'done').length
}

/** Tags for the tag picker: the worker's suggested tags first, then every other tag used in the library (A-Z). */
export function knownTags(state: AppState): string[] {
  const suggested = state.hello?.suggested_tags ?? []
  const used = new Set(Object.values(state.videos).flatMap((e) => e.tags ?? []))
  return [...suggested, ...[...used].filter((t) => !suggested.includes(t)).sort()]
}

/** The worker is up, so commands (the single writer) are possible. */
export function canCommand(state: AppState | null): boolean {
  return state?.worker.connection === 'up'
}

// --- Commands -------------------------------------------------------------------------------

/** Sends a command; errors and warnings from the ack become toasts. Resolves true when it was accepted. */
export async function runCommand(cmd: CommandInput, success?: string): Promise<boolean> {
  try {
    const ack = await window.api.command(cmd)
    if (!ack.ok) {
      toast.error(ack.error ?? 'The worker refused this')
      return false
    }
    if (ack.warning) toast.warning(ack.warning)
    else if (success) toast.success(success)
    return true
  } catch (error) {
    toast.error((error as Error).message)
    return false
  }
}

/** Copies text to the clipboard and confirms with a toast. */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Could not copy')
  )
}

/** Date.now(), refreshed every `ms` while mounted: timers tick locally, with no IPC. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}
