import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { DIM } from './model'
import type { WorkerReply, WorkerRequest } from './worker-protocol'

/** Decision 5: four chunks per batch (callers sort by length), so padding stays short. */
const BATCH = 4
const QUERY_TIMEOUT_MS = 5_000
const STOP_WAIT_MS = 3_000
const CRASH_WINDOW_MS = 5 * 60_000
const MAX_CRASHES = 3

/** A query that took longer than 5 s; the search falls back to keyword results for it. */
export class EmbedTimeoutError extends Error {
  constructor() {
    super('Smart search took too long')
  }
}

interface Pending {
  resolve: (vectors: Float32Array | undefined) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

/** The model card's query prefix (documents carry theirs in `Chunk.doc`). */
export function queryText(q: string): string {
  return `task: search result | query: ${q}`
}

/**
 * Main's handle on the search worker (SS·T10). Forks the utilityProcess on first use, matches replies to requests by
 * id, and re-forks after a crash; after 3 crashes in 5 minutes it sets `error` and stops restarting until `start()`.
 */
export class Embedder {
  /** Why embedding is unavailable (repeated crashes), or null. */
  error: string | null = null
  private child: UtilityProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private crashes: number[] = []
  private stopping: Promise<void> | null = null

  /** `modelDir` comes from `model.modelDir()`; `log` receives the worker's stdout/stderr lines. */
  constructor(
    private readonly modelDir: string,
    private readonly log: (text: string) => void = () => {}
  ) {}

  /** Clears a crash error (the "Retry" path) and forks the worker now. */
  start(): void {
    this.error = null
    this.crashes = []
    this.ensure()
  }

  /** `texts.length × 768` rows, embedded four at a time; texts are `Chunk.doc` values, already prefixed. */
  async embedDocs(texts: string[]): Promise<Float32Array> {
    const out = new Float32Array(texts.length * DIM)
    for (let i = 0; i < texts.length; i += BATCH) {
      const rows = await this.request({
        type: 'embed',
        texts: texts.slice(i, i + BATCH),
        kind: 'doc'
      })
      out.set(rows!, i * DIM)
    }
    return out
  }

  /** One 768-float query vector; rejects with `EmbedTimeoutError` after 5 s. */
  async embedQuery(q: string): Promise<Float32Array> {
    const rows = await this.request(
      { type: 'embed', texts: [queryText(q)], kind: 'query' },
      QUERY_TIMEOUT_MS
    )
    return rows!
  }

  /** Unloads the model and ends the worker (killed if it doesn't exit within 3 s). Pending requests reject. */
  stop(): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()
    this.stopping ??= new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill(), STOP_WAIT_MS)
      child.once('exit', () => {
        clearTimeout(kill)
        this.stopping = null
        resolve()
      })
      child.postMessage({ type: 'dispose', id: this.nextId++ } satisfies WorkerRequest)
    })
    return this.stopping
  }

  private request(
    msg: Omit<Extract<WorkerRequest, { type: 'embed' }>, 'id'>,
    timeoutMs?: number
  ): Promise<Float32Array | undefined> {
    return new Promise((resolve, reject) => {
      let child: UtilityProcess
      try {
        child = this.ensure()
      } catch (err) {
        return reject(err as Error)
      }
      const id = this.nextId++
      const entry: Pending = { resolve, reject }
      if (timeoutMs)
        entry.timer = setTimeout(() => {
          this.pending.delete(id) // a late reply is ignored
          reject(new EmbedTimeoutError())
        }, timeoutMs)
      this.pending.set(id, entry)
      child.postMessage({ ...msg, id } satisfies WorkerRequest)
    })
  }

  /** The running worker, forked (and told where the model is) if needed. */
  private ensure(): UtilityProcess {
    if (this.error) throw new Error(this.error)
    if (this.stopping) throw new Error('Smart search is stopping')
    if (this.child) return this.child
    const child = utilityProcess.fork(join(__dirname, 'search-worker.js'), [], {
      serviceName: 'Miss Minutes search',
      stdio: 'pipe'
    })
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) if (line) this.log(`search: ${line}`)
      })
    child.on('message', (reply: WorkerReply) => this.settle(reply))
    child.on('exit', (code) => this.exited(child, code))
    this.child = child
    child.postMessage({
      type: 'load',
      id: this.nextId++,
      modelDir: this.modelDir
    } satisfies WorkerRequest)
    return child
  }

  private settle(reply: WorkerReply): void {
    const entry = this.pending.get(reply.id)
    if (!entry) return
    this.pending.delete(reply.id)
    clearTimeout(entry.timer)
    if (reply.ok) entry.resolve(reply.vectors)
    else entry.reject(new Error(reply.error))
  }

  private exited(child: UtilityProcess, code: number): void {
    if (this.child !== child) return
    this.child = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Search worker stopped'))
    }
    this.pending.clear()
    if (this.stopping) return
    const now = Date.now()
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    this.log(`search: worker exited (code ${code})`)
    if (this.crashes.length >= MAX_CRASHES) this.error = 'Smart search keeps crashing'
  }
}
