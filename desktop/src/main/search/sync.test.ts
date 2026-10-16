import { readFileSync } from 'fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { KeywordIndex } from './keyword'
import { SearchStore } from './store'
import { reconcile, Syncer } from './sync'

// files.ts imports electron's shell for openPath; readNote doesn't need it.
vi.mock('electron', () => ({ shell: {} }))

const NOTE = readFileSync(join(__dirname, '../../shared/__fixtures__/sample-note.md'), 'utf8')
const A = 'C:\\Videos\\a.mp4'
const B = 'C:\\Videos\\b.mp4'

let library: string
let settings: Settings
let store: SearchStore

const entry = (notes: string | undefined, extra: Partial<VideoEntry> = {}): VideoEntry => ({
  source: '',
  status: 'done',
  recorded: '2026-03-04T10:15:00',
  attempts: 1,
  updated: '2026-03-04T11:00:00',
  notes,
  processed: '2026-03-04T11:00:00',
  ...extra
})

async function note(rel: string, text: string): Promise<void> {
  await mkdir(join(library, rel, '..'), { recursive: true })
  await writeFile(join(library, rel), text)
}

beforeEach(async () => {
  library = await mkdtemp(join(tmpdir(), 'mm-sync-'))
  settings = { library } as Settings
  await note('notes/demo/a.md', NOTE)
  await note('notes/demo/b.md', NOTE.replace('Payroll Portal', 'Expense Portal'))
  store = await SearchStore.load(library)
})

afterEach(async () => {
  await store.release()
  await rm(library, { recursive: true, force: true })
})

describe('reconcile', () => {
  const videos = (): Record<string, VideoEntry> => ({
    [A]: entry('notes/demo/a.md'),
    [B]: entry('notes/demo/b.md'),
    'C:\\Videos\\pending.mp4': entry(undefined, { status: 'pending' })
  })

  it('indexes every done note on the first run', async () => {
    const r = await reconcile(store, videos(), settings)
    expect(r.changed.sort()).toEqual([A, B].sort())
    expect(store.keys().sort()).toEqual([A, B].sort())
    expect(store.chunksOf(A).length).toBeGreaterThan(5)
    expect(store.chunksOf(A).every((c) => c.key === A && c.id.startsWith(`${A}#`))).toBe(true)
    expect((await reconcile(store, videos(), settings)).changed).toEqual([]) // nothing changed
  })

  it('re-chunks only the edited note', async () => {
    await reconcile(store, videos(), settings)
    const before = store.chunksOf(B)
    await note('notes/demo/a.md', NOTE.replace('IBAN check', 'SWIFT check'))
    const r = await reconcile(store, videos(), settings)
    expect(r).toEqual({ changed: [A], removed: [], failed: [] })
    expect(store.chunksOf(A).some((c) => c.text.includes('SWIFT check'))).toBe(true)
    expect(store.chunksOf(B)).toBe(before)
  })

  it('moves a recategorised note without duplicates', async () => {
    await reconcile(store, videos(), settings)
    const count = store.chunksOf(A).length
    await mkdir(join(library, 'notes/other'))
    await rename(join(library, 'notes/demo/a.md'), join(library, 'notes/other/a.md'))
    const v = { ...videos(), [A]: entry('notes/other/a.md', { edited: '2026-03-05T09:00:00' }) }
    const r = await reconcile(store, v, settings)
    expect(r.changed).toEqual([A])
    expect(store.meetings.get(A)!.notes).toBe('notes/other/a.md')
    expect(store.keys()).toHaveLength(2)
    expect(store.allChunks().filter((c) => c.key === A)).toHaveLength(count)
  })

  it('drops removed or no-longer-done entries', async () => {
    await reconcile(store, videos(), settings)
    const v = videos()
    delete v[A]
    v[B] = { ...v[B], status: 'failed' }
    const r = await reconcile(store, v, settings)
    expect(r.removed.sort()).toEqual([A, B].sort())
    expect(store.keys()).toEqual([])
  })

  it('keeps the old chunks when a note cannot be read', async () => {
    await reconcile(store, videos(), settings)
    const before = store.chunksOf(A)
    await rm(join(library, 'notes/demo/a.md'))
    const r = await reconcile(store, videos(), settings)
    expect(r.failed).toEqual([A])
    expect(store.chunksOf(A)).toBe(before)
  })

  it('never reads outside library/notes', async () => {
    const r = await reconcile(store, { [A]: entry('../secret.md') }, settings)
    expect(r.failed).toEqual([A])
  })
})

describe('Syncer', () => {
  it('keeps the keyword index current and saves', async () => {
    const keyword = new KeywordIndex()
    const changes: string[][] = []
    const syncer = new Syncer(
      store,
      keyword,
      () => settings,
      (r) => changes.push(r.changed)
    )
    const videos: Record<string, VideoEntry> = {
      [A]: entry('notes/demo/a.md'),
      [B]: entry('notes/demo/b.md')
    }
    await syncer.all(videos)
    expect(keyword.size).toBe(store.allChunks().length)
    expect(keyword.search('expense').length).toBeGreaterThan(0)

    // A change outside the fingerprint: nothing is re-read.
    const again = await syncer.changed({ ...videos, [B]: { ...videos[B], attempts: 2 } })
    expect(again.changed).toEqual([])

    await note('notes/demo/b.md', NOTE.replace('Payroll Portal', 'Travel Portal'))
    const edited = { ...videos, [B]: { ...videos[B], edited: '2026-03-06T08:00:00' } }
    expect((await syncer.changed(edited)).changed).toEqual([B])
    expect(keyword.search('expense')).toEqual([])
    expect(keyword.search('travel').length).toBeGreaterThan(0)

    await syncer.flush()
    await store.release()
    const reopened = await SearchStore.load(library)
    expect(reopened.keys().sort()).toEqual([A, B].sort())
    expect(reopened.chunksOf(B).some((c) => c.text.includes('Travel Portal'))).toBe(true)
    await reopened.release()
    expect(changes).toHaveLength(2)
  })
})
