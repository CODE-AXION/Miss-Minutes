import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Chunk } from '@shared/chunker'

/** Bump when the chunker or the files' layout changes: an older store is then discarded and rebuilt. */
export const STORE_FORMAT = 1

export interface ModelInfo {
  id: string
  revision: string
  dtype: string
  dim: number
}

export interface MeetingRecord {
  /** The entry's `notes` path when it was chunked. */
  notes: string
  /** sha256 of the note text when it was chunked. */
  hash: string
  /** Chunk ids, in order. */
  chunks: string[]
  /** True once this meeting's rows in vectors.f32 hold real embeddings. */
  embedded: boolean
}

export interface Manifest {
  format: number
  model: ModelInfo | null
  meetings: Record<string, MeetingRecord>
}

/** Why the store can't be written: another app holds the lock, or the library folder doesn't exist yet. */
export type ReadOnlyReason = 'locked' | 'unavailable'

interface LockInfo {
  pid: number
  startedAt: string
}

/**
 * The smart-search index in `<library>/.search/` (SS·T5): manifest.json, chunks.json and vectors.f32, keyed by
 * index.json key. Writes are atomic (tmp + rename, manifest last) and only happen while this process holds
 * `.search/lock`; without it the store is read-only and `save()` does nothing.
 */
export class SearchStore {
  model: ModelInfo | null = null
  readonly meetings = new Map<string, MeetingRecord>()
  private readonly chunks = new Map<string, Chunk[]>()
  /** Per meeting, `chunks.length × dim` rows; only for meetings whose record says `embedded`. */
  private readonly vectors = new Map<string, Float32Array>()

  private constructor(
    readonly dir: string,
    public readOnly: ReadOnlyReason | null
  ) {}

  /** Opens (or starts) the store of `library`. Missing or broken files degrade to an empty or keyword-only store. */
  static async load(library: string): Promise<SearchStore> {
    const dir = join(library, '.search')
    const store = new SearchStore(dir, await acquireLock(dir))
    await store.read()
    return store
  }

  /** Retries taking the lock (e.g. after the other app quit). True when the store is now writable. */
  async tryLock(): Promise<boolean> {
    if (this.readOnly) this.readOnly = await acquireLock(this.dir)
    return this.readOnly === null
  }

  /** Releases the lock, if held. The store stays usable for searching. */
  async release(): Promise<void> {
    if (this.readOnly) return
    this.readOnly = 'locked'
    await releaseLock(this.dir)
  }

  keys(): string[] {
    return [...this.meetings.keys()]
  }

  chunksOf(key: string): Chunk[] {
    return this.chunks.get(key) ?? []
  }

  allChunks(): Chunk[] {
    return [...this.chunks.values()].flat()
  }

  vectorsOf(key: string): Float32Array | null {
    return this.vectors.get(key) ?? null
  }

  /** Replaces one meeting's chunks; its vectors are dropped until it is embedded again. */
  setMeeting(key: string, notes: string, hash: string, chunks: Chunk[]): void {
    this.meetings.set(key, { notes, hash, chunks: chunks.map((c) => c.id), embedded: false })
    this.chunks.set(key, chunks)
    this.vectors.delete(key)
  }

  removeMeeting(key: string): void {
    this.meetings.delete(key)
    this.chunks.delete(key)
    this.vectors.delete(key)
  }

  /** Switches the embedding model; a different model (or none) invalidates every stored vector. */
  setModel(model: ModelInfo | null): void {
    if (sameModel(this.model, model)) return
    this.model = model
    this.vectors.clear()
    for (const m of this.meetings.values()) m.embedded = false
  }

  /** Stores one meeting's embeddings: `chunksOf(key).length × model.dim` rows. */
  setVectors(key: string, rows: Float32Array): void {
    const m = this.meetings.get(key)
    if (!m || !this.model) throw new Error(`Cannot store vectors for ${key}`)
    if (rows.length !== m.chunks.length * this.model.dim)
      throw new Error(`Expected ${m.chunks.length} vectors for ${key}`)
    this.vectors.set(key, rows)
    m.embedded = true
  }

  /** Writes the store atomically; a no-op while read-only. */
  async save(): Promise<void> {
    if (this.readOnly) return
    const keys = this.keys()
    const chunks = keys.flatMap((k) => this.chunksOf(k))
    const manifest: Manifest = {
      format: STORE_FORMAT,
      model: this.model,
      meetings: Object.fromEntries(keys.map((k) => [k, this.meetings.get(k)!]))
    }
    await mkdir(this.dir, { recursive: true })
    await atomicWrite(join(this.dir, 'chunks.json'), JSON.stringify(chunks))
    if (this.model) {
      const { dim } = this.model
      const all = new Float32Array(chunks.length * dim)
      let row = 0
      for (const k of keys) {
        const v = this.meetings.get(k)!.embedded ? this.vectors.get(k) : undefined
        if (v) all.set(v, row * dim)
        row += this.chunksOf(k).length
      }
      await atomicWrite(join(this.dir, 'vectors.f32'), Buffer.from(all.buffer))
    } else {
      await rm(join(this.dir, 'vectors.f32'), { force: true })
    }
    // Last, so a crash before this point leaves the previous consistent manifest in place.
    await atomicWrite(join(this.dir, 'manifest.json'), JSON.stringify(manifest))
  }

  private async read(): Promise<void> {
    const manifest = await readJson<Manifest>(join(this.dir, 'manifest.json'))
    const chunks = await readJson<Chunk[]>(join(this.dir, 'chunks.json'))
    if (manifest?.format !== STORE_FORMAT || !Array.isArray(chunks) || !manifest.meetings) return

    const byId = new Map(chunks.map((c, i) => [c.id, i]))
    const vectors = manifest.model
      ? await readVectors(this.dir, chunks.length, manifest.model.dim)
      : null
    this.model = vectors ? manifest.model : null

    for (const [key, rec] of Object.entries(manifest.meetings)) {
      const rows = rec.chunks.map((id) => byId.get(id))
      // A meeting whose chunks are missing is left out: the next reconcile re-chunks it.
      if (rows.some((i) => i === undefined || chunks[i].key !== key)) continue
      const idx = rows as number[]
      this.meetings.set(key, { ...rec, embedded: Boolean(vectors && rec.embedded) })
      this.chunks.set(
        key,
        idx.map((i) => chunks[i])
      )
      if (vectors && rec.embedded) {
        const dim = this.model!.dim
        const v = new Float32Array(idx.length * dim)
        idx.forEach((i, r) => v.set(vectors.subarray(i * dim, (i + 1) * dim), r * dim))
        this.vectors.set(key, v)
      }
    }
  }
}

function sameModel(a: ModelInfo | null, b: ModelInfo | null): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.revision === b.revision && a.dtype === b.dtype && a.dim === b.dim
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/** vectors.f32 as `count × dim` floats, or null when it is missing or doesn't fit. */
async function readVectors(dir: string, count: number, dim: number): Promise<Float32Array | null> {
  try {
    const buf = await readFile(join(dir, 'vectors.f32'))
    if (!(dim > 0) || buf.byteLength !== count * dim * 4) return null
    // Copy: the Buffer's offset into its ArrayBuffer need not be 4-aligned.
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } catch {
    return null
  }
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

// ---------- lock ----------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours to signal
  }
}

/**
 * Takes `.search/lock` (`{pid, startedAt}`), taking over a lock whose process is gone. Mirrors the engine's
 * worker lock (watcher.py) without sharing its file. Returns null when held, else why the store is read-only.
 */
async function acquireLock(dir: string): Promise<ReadOnlyReason | null> {
  try {
    await mkdir(dir) // not recursive: never create the library itself
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable'
  }
  const path = join(dir, 'lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx')
      const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() }
      await fh.writeFile(JSON.stringify(info))
      await fh.close()
      return null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable'
    }
    const held = await readJson<LockInfo>(path)
    if (held?.pid === process.pid) return null // ours, e.g. the store was reopened
    if (held && typeof held.pid === 'number' && alive(held.pid)) return 'locked'
    // Unreadable and fresh: another app is still writing it.
    if (!held) {
      const written = (await stat(path).catch(() => null))?.mtimeMs ?? 0
      if (Date.now() - written < 5000) return 'locked'
    }
    await unlink(path).catch(() => undefined) // stale (or unreadable): take it over
  }
  return 'locked'
}

async function releaseLock(dir: string): Promise<void> {
  const path = join(dir, 'lock')
  const held = await readJson<LockInfo>(path)
  if (held?.pid === process.pid) await unlink(path).catch(() => undefined)
}
