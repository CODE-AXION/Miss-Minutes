import { net } from 'electron'
import { resolve } from 'path'
import { performance } from 'perf_hooks'
import type { SearchResult, SearchStatus, Settings } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import type { State } from '../state'
import { Embedder } from './embedder'
import { KeywordIndex } from './keyword'
import {
  DIM,
  deleteModel,
  downloadModel,
  isModelPresent,
  MODEL_BYTES,
  MODEL_INFO,
  modelDir
} from './model'
import { rank, type RankedId } from './rank'
import { SearchStore } from './store'
import { Syncer, type ReconcileResult } from './sync'

/** Decision 8: each list contributes its top 50 to the fusion. */
const TOP_N = 50
const DEFAULT_LIMIT = 30
/** Download and indexing progress reach the renderer at most 4 times a second. */
const PROGRESS_MS = 250
/** How often a read-only store retries the lock (the other Miss Minutes may have quit). */
const LOCK_RETRY_MS = 30_000

type Smart = SearchStatus['smart']

/** One library's open index. */
interface Session {
  library: string
  store: SearchStore
  keyword: KeywordIndex
  syncer: Syncer
  /** The first full reconcile was queued. */
  synced: boolean
}

const sameLibrary = (a: string | null, b: string): boolean =>
  a !== null && resolve(a).toLowerCase() === resolve(b).toLowerCase()

const recordedAt = (e: VideoEntry | undefined): number => Date.parse(e?.recorded ?? '') || 0

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The one entry point to search (SS·T14): owns the library's store and keyword index (02), the embedder and the
 * model download (03). Keyword search is always on; smart search runs off → downloading → indexing → ready while
 * `smartSearch` is set, and its status is published through `State.search`. Failures never reach the caller of
 * `query`: it degrades to keyword results.
 */
export class SearchService {
  private session: Session | null = null
  private smart: Smart = { phase: 'off' }
  private embedder: Embedder | null = null
  /** The running download/backfill, and how to cancel it. */
  private job: AbortController | null = null
  private running: Promise<void> | null = null
  /** Something changed while the backfill ran: run it once more. */
  private wake = false
  /** Lifecycle steps (open, close, delete, rebuild) run one at a time. */
  private ops: Promise<unknown> = Promise.resolve()
  private lastVideos: Record<string, VideoEntry> | null = null
  private lastPublish = 0
  private publishTimer: NodeJS.Timeout | null = null
  private lastLockTry = 0
  /** Every model file is in place (checked at open, set by a finished download, cleared by deleteFiles). */
  private modelOnDisk = false

  constructor(
    private readonly state: State,
    private readonly userData: string,
    private readonly log: (text: string) => void
  ) {
    state.on('change', () => this.onStateChange())
  }

  /** Opens the library's index and, with `smartSearch`, resumes downloading or indexing. */
  start(settings: Settings): Promise<void> {
    return this.serial(() => this.open(settings))
  }

  /** After a settings save (SS·T12): a new library reopens the index; `smartSearch` turns the semantic layer on/off. */
  applySettings(before: Settings, next: Settings): Promise<void> {
    if (!sameLibrary(before.library, next.library))
      return this.serial(async () => {
        await this.close()
        await this.open(next)
      })
    if (next.smartSearch === before.smartSearch) return Promise.resolve()
    if (!next.smartSearch) return this.disable()
    this.smart = { phase: 'off' }
    this.kick()
    return Promise.resolve()
  }

  /** Removes the model and the vectors ("Also delete downloaded files"); only while smart search is off. */
  deleteFiles(): Promise<void> {
    return this.serial(async () => {
      if (this.enabled()) throw new Error('Turn smart search off first')
      await this.disable()
      await deleteModel(this.userData)
      this.modelOnDisk = false
      const s = this.session
      if (s) {
        s.store.setModel(null)
        s.syncer.scheduleSave()
        await s.syncer.flush()
      }
      this.log('search: deleted the model and the vectors')
      this.publish()
    })
  }

  /** Re-runs the phase that failed. */
  retry(): Promise<void> {
    if (!this.enabled()) return Promise.resolve()
    this.embedder?.start() // clears a crash-loop error
    this.smart = { phase: 'off' }
    this.kick()
    return Promise.resolve()
  }

  /** Drops every passage and re-chunks (and, if on, re-embeds) from scratch. */
  rebuild(): Promise<void> {
    return this.serial(async () => {
      const s = this.session
      if (!s) return
      await s.syncer.flush()
      for (const key of s.store.keys()) {
        s.store.removeMeeting(key)
        s.keyword.remove(key)
      }
      s.synced = false
      this.lastVideos = null
      this.publish()
      this.onStateChange()
    })
  }

  /** App quit: cancel the backfill, write pending changes, end the worker and release the lock. */
  dispose(): Promise<void> {
    return this.serial(async () => {
      await this.disable()
      await this.close()
    })
  }

  /**
   * Keyword search, plus vector search when `smart` and the semantic layer is ready (or indexing: the meetings
   * already embedded take part), fused by `rank` (SS·T16). Never throws for a smart-search problem.
   */
  async query(
    q: string,
    { smart, keys, limit = DEFAULT_LIMIT }: { smart: boolean; keys?: string[]; limit?: number }
  ): Promise<SearchResult> {
    const t0 = performance.now()
    const s = this.session
    if (!s || !q.trim()) return { hits: [], usedSmart: false, ms: 0 }
    const only = keys ? new Set(keys) : undefined
    const kw = s.keyword.search(q, { limit: TOP_N, keys: only })
    let vec: RankedId[] = []
    let usedSmart = false
    const { phase } = this.smart
    if (smart && this.enabled() && (phase === 'ready' || phase === 'indexing') && s.store.model) {
      try {
        const qv = await this.getEmbedder().embedQuery(q)
        vec = nearest(s.store, qv, only)
        usedSmart = true
      } catch (err) {
        this.log(`search: smart query fell back to keywords: ${message(err)}`)
      }
    }
    const hits = rank(q, kw, vec, (id) => s.keyword.chunk(id), this.state.videos, Date.now(), limit)
    return { hits, usedSmart, ms: Math.round(performance.now() - t0) }
  }

  // ---------- lifecycle ----------

  private enabled(): boolean {
    return this.state.settings.smartSearch
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ops.then(fn)
    this.ops = next.catch(() => undefined)
    return next
  }

  private async open(settings: Settings): Promise<void> {
    const store = await SearchStore.load(settings.library)
    this.modelOnDisk = await isModelPresent(modelDir(this.userData))
    const keyword = new KeywordIndex()
    let session: Session | null = null
    const syncer = new Syncer(
      store,
      keyword,
      () => this.state.settings,
      (r) => session && this.reconciled(session, r)
    )
    session = { library: settings.library, store, keyword, syncer, synced: false }
    this.session = session
    this.lastVideos = null
    if (store.readOnly === 'locked')
      this.log('search: another Miss Minutes holds the index; it is read-only here')
    this.smart = { phase: 'off' }
    this.publish()
    this.onStateChange()
    if (settings.smartSearch) this.kick()
  }

  private async close(): Promise<void> {
    const s = this.session
    if (!s) return
    this.session = null
    this.job?.abort()
    await this.running
    await s.syncer
      .flush()
      .catch((err) => this.log(`search: saving the index failed: ${message(err)}`))
    s.syncer.dispose()
    await s.store.release().catch(() => undefined)
  }

  /** Cancels the download/backfill and ends the worker; the files stay. */
  private async disable(): Promise<void> {
    this.job?.abort()
    const embedder = this.embedder
    this.embedder = null
    await embedder?.stop()
    await this.running
    this.smart = { phase: 'off' }
    this.publish()
  }

  /** Reconciles the store with the index once the state holds this library's entries, then on every change. */
  private onStateChange(): void {
    const s = this.session
    if (!s || this.state.videos === this.lastVideos) return
    // Right after a library change the old library's entries are still in the state: never reconcile against them.
    if (!sameLibrary(this.state.videosLibrary, s.library)) return
    const videos = this.state.videos
    this.lastVideos = videos
    const first = !s.synced
    s.synced = true
    void (first ? s.syncer.all(videos) : s.syncer.changed(videos))
      .then(() => {
        if (this.session !== s) return
        this.publish()
        if (first) this.kick()
      })
      .catch((err) => this.log(`search: indexing notes failed: ${message(err)}`))
    void this.retryLock(s)
  }

  private reconciled(s: Session, r: ReconcileResult): void {
    if (this.session !== s) return
    this.publish()
    // After a failure only Retry starts it again, so a broken download isn't retried on every new note.
    if (r.changed.length && this.smart.phase !== 'error') this.kick()
  }

  private async retryLock(s: Session): Promise<void> {
    if (!s.store.readOnly || Date.now() - this.lastLockTry < LOCK_RETRY_MS) return
    this.lastLockTry = Date.now()
    if (await s.store.tryLock()) {
      this.log('search: took over the index lock')
      s.syncer.scheduleSave()
      this.publish()
    }
  }

  /** Starts the download/backfill, or asks the running one for another pass. */
  private kick(): void {
    if (!this.enabled() || !this.session) return
    this.wake = true
    if (this.running) return
    this.running = this.runSmart().finally(() => {
      this.running = null
      if (this.wake && this.smart.phase !== 'error') this.kick()
    })
  }

  private async runSmart(): Promise<void> {
    const ctl = new AbortController()
    this.job = ctl
    const { signal } = ctl
    this.wake = false
    try {
      const dir = modelDir(this.userData)
      if (!(await isModelPresent(dir))) {
        this.setSmart({ phase: 'downloading', bytes: 0, total: MODEL_BYTES })
        this.log('search: downloading the search model')
        try {
          await downloadModel(dir, {
            fetch: net.fetch as typeof fetch,
            signal,
            onProgress: (p) => this.setSmart({ phase: 'downloading', ...p })
          })
        } catch (err) {
          if (!signal.aborted) this.fail(err, 'download')
          return
        }
        this.modelOnDisk = true
      }
      await this.backfill(signal)
    } catch (err) {
      if (!signal.aborted) this.fail(err, 'index')
    } finally {
      if (this.job === ctl) this.job = null
    }
  }

  /**
   * Embeds every meeting not embedded yet, newest first, until none is left (SS·T14). Within a meeting the chunks
   * go shortest first, four per batch; each finished meeting is saved (debounced).
   */
  private async backfill(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const s = this.session
      if (!s) return
      // A different model revision invalidates every stored vector: a full re-embed.
      s.store.setModel(MODEL_INFO)
      const pending = s.store
        .keys()
        .filter((k) => !s.store.meetings.get(k)!.embedded)
        .sort((a, b) => recordedAt(this.state.videos[b]) - recordedAt(this.state.videos[a]))
      if (!pending.length) break
      for (const key of pending) {
        if (signal.aborted || this.session !== s) return
        const rec = s.store.meetings.get(key)
        if (!rec || rec.embedded) continue
        this.setSmart({
          phase: 'indexing',
          done: embeddedCount(s.store),
          total: s.store.meetings.size
        })
        const chunks = s.store.chunksOf(key)
        const order = chunks
          .map((_, i) => i)
          .sort((a, b) => chunks[a].doc.length - chunks[b].doc.length)
        const rows = await this.getEmbedder().embedDocs(order.map((i) => chunks[i].doc))
        // Re-chunked meanwhile (a new record): the next pass embeds the new chunks.
        if (signal.aborted || s.store.meetings.get(key) !== rec) continue
        const vectors = new Float32Array(rows.length)
        order.forEach((i, r) => vectors.set(rows.subarray(r * DIM, (r + 1) * DIM), i * DIM))
        s.store.setVectors(key, vectors)
        s.syncer.scheduleSave()
      }
    }
    const s = this.session
    if (signal.aborted || !s) return
    this.setSmart({
      phase: 'ready',
      meetings: embeddedCount(s.store),
      diskBytes: MODEL_BYTES + vectorBytes(s.store)
    })
  }

  private getEmbedder(): Embedder {
    this.embedder ??= new Embedder(modelDir(this.userData), this.log)
    return this.embedder
  }

  private fail(err: unknown, retry: 'download' | 'index'): void {
    const text = message(err)
    this.log(`search: ${retry === 'download' ? 'download' : 'indexing'} failed: ${text}`)
    this.setSmart({ phase: 'error', message: text, retry })
  }

  // ---------- status ----------

  private setSmart(smart: Smart): void {
    this.smart = smart
    this.publish(smart.phase !== 'downloading' && smart.phase !== 'indexing')
  }

  /** Pushes the status into AppState; progress updates (`force` false) are throttled to 4 per second. */
  private publish(force = true): void {
    const wait = PROGRESS_MS - (Date.now() - this.lastPublish)
    if (!force && wait > 0) {
      this.publishTimer ??= setTimeout(() => {
        this.publishTimer = null
        this.publish()
      }, wait)
      return
    }
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.lastPublish = Date.now()
    const s = this.session
    this.state.setSearch({
      keyword: { meetings: s?.store.meetings.size ?? 0, passages: s?.keyword.size ?? 0 },
      smart: this.enabled() ? this.smart : { phase: 'off' },
      readOnly: s?.store.readOnly === 'locked',
      modelOnDisk: this.modelOnDisk,
      diskBytes: (this.modelOnDisk ? MODEL_BYTES : 0) + (s ? vectorBytes(s.store) : 0)
    })
  }
}

function embeddedCount(store: SearchStore): number {
  let n = 0
  for (const m of store.meetings.values()) if (m.embedded) n++
  return n
}

/** Size of the stored vectors: one float32 row per passage of every embedded meeting. */
function vectorBytes(store: SearchStore): number {
  let rows = 0
  for (const key of store.keys())
    if (store.meetings.get(key)!.embedded) rows += store.chunksOf(key).length
  return rows * DIM * 4
}

/** Brute-force dot product (the vectors are L2-normalised) over every embedded passage; the best `TOP_N`. */
function nearest(store: SearchStore, qv: Float32Array, only?: Set<string>): RankedId[] {
  const out: RankedId[] = []
  for (const key of store.keys()) {
    if (only && !only.has(key)) continue
    const v = store.vectorsOf(key)
    if (!v) continue
    const chunks = store.chunksOf(key)
    for (let i = 0; i < chunks.length; i++) {
      let dot = 0
      const at = i * DIM
      for (let d = 0; d < DIM; d++) dot += v[at + d] * qv[d]
      out.push({ id: chunks[i].id, score: dot })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, TOP_N)
}
