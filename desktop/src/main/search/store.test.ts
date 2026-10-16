import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Chunk } from '@shared/chunker'
import { SearchStore, STORE_FORMAT, type ModelInfo } from './store'

const MODEL: ModelInfo = { id: 'test/model', revision: 'abc', dtype: 'q4', dim: 4 }

const chunk = (key: string, n: number, text = `passage ${n} of ${key}`): Chunk => ({
  id: `${key}#${n}`,
  key,
  type: 'note',
  section: 'Notes',
  anchor: 'h-notes',
  ts: null,
  people: [],
  text,
  doc: text
})

let library: string
let store: SearchStore | null

beforeEach(async () => {
  library = await mkdtemp(join(tmpdir(), 'mm-store-'))
  store = null
})

afterEach(async () => {
  await store?.release()
  await rm(library, { recursive: true, force: true })
})

/** A store with two meetings, both embedded with distinct rows, saved. */
async function seeded(): Promise<SearchStore> {
  const s = await SearchStore.load(library)
  s.setModel(MODEL)
  s.setMeeting('a', 'notes/x/a.md', 'h1', [chunk('a', 0), chunk('a', 1)])
  s.setMeeting('b', 'notes/x/b.md', 'h2', [chunk('b', 0)])
  s.setVectors('a', Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
  s.setVectors('b', Float32Array.from([9, 10, 11, 12]))
  await s.save()
  await s.release()
  return s
}

const manifestOf = async (): Promise<{ meetings: Record<string, unknown> }> =>
  JSON.parse(await readFile(join(library, '.search', 'manifest.json'), 'utf8'))

describe('SearchStore', () => {
  it('starts empty and takes the lock', async () => {
    store = await SearchStore.load(library)
    expect(store.readOnly).toBeNull()
    expect(store.keys()).toEqual([])
    const lock = JSON.parse(await readFile(join(library, '.search', 'lock'), 'utf8'))
    expect(lock.pid).toBe(process.pid)
    expect(typeof lock.startedAt).toBe('string')
  })

  it('round-trips meetings, chunks and vectors', async () => {
    await seeded()
    store = await SearchStore.load(library)
    expect(store.model).toEqual(MODEL)
    expect(store.keys()).toEqual(['a', 'b'])
    expect(store.chunksOf('a').map((c) => c.id)).toEqual(['a#0', 'a#1'])
    expect([...store.vectorsOf('a')!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...store.vectorsOf('b')!]).toEqual([9, 10, 11, 12])
    expect(store.meetings.get('b')).toMatchObject({
      notes: 'notes/x/b.md',
      hash: 'h2',
      embedded: true
    })
  })

  it('writes zero rows for meetings not embedded yet', async () => {
    await seeded()
    store = await SearchStore.load(library)
    store.setMeeting('a', 'notes/x/a.md', 'h1b', [chunk('a', 0), chunk('a', 1), chunk('a', 2)])
    await store.save()
    const buf = await readFile(join(library, '.search', 'vectors.f32'))
    expect(buf.byteLength).toBe(4 * 4 * 4)
    await store.release()
    store = await SearchStore.load(library)
    expect(store.meetings.get('a')!.embedded).toBe(false)
    expect(store.vectorsOf('a')).toBeNull()
    expect([...store.vectorsOf('b')!]).toEqual([9, 10, 11, 12])
  })

  it('loads a corrupt vectors.f32 as keyword-only', async () => {
    await seeded()
    await truncate(join(library, '.search', 'vectors.f32'), 10)
    store = await SearchStore.load(library)
    expect(store.model).toBeNull()
    expect(store.keys()).toEqual(['a', 'b'])
    expect(store.chunksOf('a')).toHaveLength(2)
    expect([...store.meetings.values()].every((m) => !m.embedded)).toBe(true)
    expect(store.vectorsOf('a')).toBeNull()
  })

  it('discards a store of another format', async () => {
    await seeded()
    const manifest = await manifestOf()
    await writeFile(
      join(library, '.search', 'manifest.json'),
      JSON.stringify({ ...manifest, format: STORE_FORMAT + 1 })
    )
    store = await SearchStore.load(library)
    expect(store.keys()).toEqual([])
  })

  it('leaves out a meeting whose chunks are missing', async () => {
    await seeded()
    const path = join(library, '.search', 'chunks.json')
    const chunks = JSON.parse(await readFile(path, 'utf8')) as Chunk[]
    await writeFile(path, JSON.stringify(chunks.filter((c) => c.id !== 'a#1')))
    store = await SearchStore.load(library)
    expect(store.keys()).toEqual(['b'])
  })

  it('drops every vector when the model changes', async () => {
    await seeded()
    store = await SearchStore.load(library)
    store.setModel({ ...MODEL, revision: 'def' })
    expect(store.vectorsOf('a')).toBeNull()
    expect(store.meetings.get('a')!.embedded).toBe(false)
    store.setModel(null)
    await store.save()
    expect(existsSync(join(library, '.search', 'vectors.f32'))).toBe(false)
  })

  it('opens read-only while another live process holds the lock', async () => {
    await seeded()
    const lock = join(library, '.search', 'lock')
    await writeFile(
      lock,
      JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })
    )
    store = await SearchStore.load(library)
    expect(store.readOnly).toBe('locked')
    expect(store.keys()).toEqual(['a', 'b']) // still searchable
    store.removeMeeting('a')
    await store.save()
    expect((await manifestOf()).meetings).toHaveProperty('a') // nothing written
    await store.release()
    expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(process.ppid) // not ours to remove
    expect(await store.tryLock()).toBe(false)
  })

  it('takes over a stale lock', async () => {
    await mkdir(join(library, '.search'))
    await writeFile(
      join(library, '.search', 'lock'),
      JSON.stringify({ pid: 2 ** 30, startedAt: '2026-01-01T00:00:00.000Z' })
    )
    store = await SearchStore.load(library)
    expect(store.readOnly).toBeNull()
  })

  it('is unavailable without a library folder, and creates none', async () => {
    const missing = join(library, 'nope')
    store = await SearchStore.load(missing)
    expect(store.readOnly).toBe('unavailable')
    expect(existsSync(missing)).toBe(false)
  })
})
