import { createHash } from 'crypto'
import type { Settings } from '@shared/api'
import { chunkNote } from '@shared/chunker'
import type { VideoEntry } from '@shared/protocol'
import { readNote } from '../files'
import type { KeywordIndex } from './keyword'
import type { SearchStore } from './store'

const SAVE_DEBOUNCE_MS = 1000

export interface ReconcileResult {
  /** Meetings re-chunked (new, edited or moved); their vectors are gone until re-embedded. */
  changed: string[]
  /** Meetings dropped from the store. */
  removed: string[]
  /** Wanted meetings whose note couldn't be read (e.g. mid-write); their old chunks are kept. */
  failed: string[]
}

const wanted = (e: VideoEntry | undefined): e is VideoEntry & { notes: string } =>
  e?.status === 'done' && Boolean(e.notes)

/**
 * Brings the store in line with index.json (SS·T6), by index key: new, edited or moved notes are re-chunked,
 * entries no longer done are dropped. `only` limits the work to those keys (default: every key in either).
 * Notes are read through readNote, never through a path built here.
 */
export async function reconcile(
  store: SearchStore,
  videos: Record<string, VideoEntry>,
  settings: Settings,
  only?: Iterable<string>
): Promise<ReconcileResult> {
  const result: ReconcileResult = { changed: [], removed: [], failed: [] }
  const keys = only ? new Set(only) : new Set([...store.keys(), ...Object.keys(videos)])
  for (const key of keys) {
    const entry = videos[key]
    if (!wanted(entry)) {
      if (store.meetings.has(key)) {
        store.removeMeeting(key)
        result.removed.push(key)
      }
      continue
    }
    let text: string
    try {
      text = await readNote(settings, entry.notes)
    } catch {
      result.failed.push(key)
      continue
    }
    const hash = createHash('sha256').update(text).digest('hex')
    const rec = store.meetings.get(key)
    if (rec && rec.hash === hash && rec.notes === entry.notes) continue
    const chunks = chunkNote(text, {
      key,
      title: entry.title ?? '',
      recorded: entry.recorded,
      participants: entry.participants ?? []
    })
    store.setMeeting(key, entry.notes, hash, chunks)
    result.changed.push(key)
  }
  return result
}

/** What makes an entry worth another look: a new note path, a reprocess, an edit or a status change. */
const fingerprint = (e: VideoEntry): string => `${e.notes}|${e.processed}|${e.edited}|${e.status}`

/**
 * Keeps one library's store and keyword index current (SS·T6): `all()` at start, `changed()` on every State
 * `change` (only entries whose fingerprint moved are reconciled). Runs are serialised; saves are debounced.
 * A read-only store is still reconciled in memory, so keyword search stays current; it just isn't saved.
 */
export class Syncer {
  private readonly seen = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: SearchStore,
    private readonly keyword: KeywordIndex,
    private readonly settings: () => Settings,
    /** Called after each run that changed something (e.g. to queue embedding). */
    private readonly onChange: (r: ReconcileResult) => void = () => undefined
  ) {}

  /** Indexes the store's chunks into the keyword index, then reconciles every entry. */
  all(videos: Record<string, VideoEntry>): Promise<ReconcileResult> {
    return this.run(async () => {
      for (const key of this.store.keys()) this.index(key, videos[key])
      this.seen.clear()
      return this.reconcile(videos, undefined)
    })
  }

  /** Reconciles only the entries that changed since the last run. */
  changed(videos: Record<string, VideoEntry>): Promise<ReconcileResult> {
    return this.run(async () => {
      const keys: string[] = []
      for (const [key, e] of Object.entries(videos))
        if (this.seen.get(key) !== fingerprint(e)) keys.push(key)
      for (const key of this.seen.keys()) if (!(key in videos)) keys.push(key)
      return this.reconcile(videos, keys)
    })
  }

  /** Writes any pending changes now. */
  async flush(): Promise<void> {
    await this.queue
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.store.save()
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  /** Marks the store dirty (e.g. after vectors were added) so it is saved shortly. */
  scheduleSave(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null
      this.store.save().catch(() => undefined) // retried with the next change
    }, SAVE_DEBOUNCE_MS)
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async reconcile(
    videos: Record<string, VideoEntry>,
    only: string[] | undefined
  ): Promise<ReconcileResult> {
    const r = await reconcile(this.store, videos, this.settings(), only)
    for (const key of only ?? Object.keys(videos)) {
      const e = videos[key]
      if (e) this.seen.set(key, fingerprint(e))
      else this.seen.delete(key)
    }
    for (const key of r.failed) this.seen.delete(key) // retried on the next change
    for (const key of r.changed) this.index(key, videos[key])
    for (const key of r.removed) this.keyword.remove(key)
    if (r.changed.length || r.removed.length) {
      this.scheduleSave()
      this.onChange(r)
    }
    return r
  }

  private index(key: string, entry: VideoEntry | undefined): void {
    this.keyword.set(key, this.store.chunksOf(key), {
      title: entry?.title,
      category: entry?.category,
      tags: entry?.tags
    })
  }
}
