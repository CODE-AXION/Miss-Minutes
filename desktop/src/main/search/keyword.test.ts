import { readFileSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { describe, expect, it } from 'vitest'
import { chunkNote, type Chunk } from '@shared/chunker'
import type { VideoEntry } from '@shared/protocol'
import { KeywordIndex, stem } from './keyword'

const chunk = (key: string, n: number, text: string, extra: Partial<Chunk> = {}): Chunk => ({
  id: `${key}#${n}`,
  key,
  type: 'note',
  section: 'Notes',
  anchor: 'h-notes',
  ts: null,
  people: [],
  text,
  doc: text,
  ...extra
})

function index(): KeywordIndex {
  const k = new KeywordIndex()
  k.set(
    'm1',
    [
      chunk('m1', 0, 'Enter the HS code for every line item.'),
      chunk('m1', 1, 'The user has to confirm the shipment before submitting it.'),
      chunk('m1', 2, 'Call get_user_businesses to list the companies of the signed-in user.'),
      chunk('m1', 3, 'The /create-declaration endpoint saves a draft customs declaration.'),
      chunk('m1', 4, 'A duplicate BOL blocks the submission with an error.'),
      chunk('m1', 5, 'Duplicate entries of the same BOL number are merged.')
    ],
    { title: 'Customs Declaration Wizard Demo', category: 'demo-review', tags: ['customs'] }
  )
  k.set(
    'm2',
    [
      chunk('m2', 0, 'Priya asked how the approval queue sends reminders.', {
        type: 'qa',
        people: ['Priya Nair']
      })
    ],
    { title: 'Payroll Portal Review' }
  )
  return k
}

const ids = (k: KeywordIndex, q: string, opts?: Parameters<KeywordIndex['search']>[1]): string[] =>
  k.search(q, opts).map((h) => h.id)

describe('stem', () => {
  it('brings simple inflections together', () => {
    expect(stem('rules')).toBe(stem('rule'))
    expect(stem('validated')).toBe(stem('validate'))
    expect(stem('validating')).toBe(stem('validate'))
    expect(stem('processes')).toBe(stem('process'))
    expect(stem('declarations')).toBe(stem('declaration'))
    expect(stem('running')).toBe('run')
    expect(stem('has')).toBe('has') // under 4 letters
    expect(stem('status')).toBe('status')
  })
})

describe('KeywordIndex', () => {
  const k = index()

  it('matches short codes exactly', () => {
    expect(ids(k, 'HS')).toEqual(['m1#0'])
  })

  it('tolerates typos in longer words', () => {
    expect(ids(k, 'declration')).toContain('m1#3')
  })

  it('finds identifiers whole and by their parts', () => {
    expect(ids(k, 'get_user_businesses')[0]).toBe('m1#2')
    expect(ids(k, 'businesses')).toContain('m1#2')
    expect(ids(k, '/create-declaration')[0]).toBe('m1#3')
    expect(ids(k, 'create')).toContain('m1#3')
  })

  it('requires quoted phrases verbatim', () => {
    expect(ids(k, '"duplicate BOL"')).toEqual(['m1#4'])
    expect(ids(k, 'duplicate BOL').sort()).toEqual(['m1#4', 'm1#5'])
  })

  it('completes the last term as a prefix', () => {
    expect(ids(k, 'reminde')).toEqual(['m2#0'])
  })

  it('searches people, title and category', () => {
    expect(ids(k, 'priya')).toEqual(['m2#0'])
    expect(ids(k, 'payroll')).toEqual(['m2#0'])
    // The whole category matches every m1 chunk; its "review" part also matches m2's title.
    expect(ids(k, 'demo-review').sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((n) => `m1#${n}`).concat('m2#0')
    )
  })

  it('restricts results to the given meetings and the limit', () => {
    expect(ids(k, 'user', { keys: new Set(['m2']) })).toEqual([])
    expect(ids(k, 'approval queue', { keys: new Set(['m2']) })).toEqual(['m2#0'])
    expect(ids(k, 'the')).toEqual([]) // stop words only
    expect(ids(k, 'duplicate', { limit: 1 })).toHaveLength(1)
  })

  it('replaces and removes a meeting', () => {
    const k2 = index()
    k2.set('m2', [chunk('m2', 0, 'Travel expenses are reimbursed monthly.')])
    expect(ids(k2, 'reminders')).toEqual([])
    expect(ids(k2, 'travel')).toEqual(['m2#0'])
    k2.remove('m2')
    expect(ids(k2, 'travel')).toEqual([])
    expect(k2.size).toBe(6)
  })
})

// Timing on a real library, skipped unless MM_LIBRARY=<library folder> is set.
const LIBRARY = process.env.MM_LIBRARY ?? ''

describe.skipIf(!LIBRARY)('KeywordIndex on the real library', () => {
  it('builds and answers within budget', () => {
    const { videos } = JSON.parse(readFileSync(join(LIBRARY, 'index.json'), 'utf8')) as {
      videos: Record<string, VideoEntry>
    }
    const notes = Object.entries(videos)
      .filter(([, v]) => v.status === 'done' && v.notes)
      .map(([key, v]) => ({
        key,
        v,
        chunks: chunkNote(readFileSync(join(LIBRARY, v.notes!), 'utf8'), {
          key,
          title: v.title ?? '',
          recorded: v.recorded,
          participants: v.participants ?? []
        })
      }))

    const k = new KeywordIndex()
    const t0 = performance.now()
    for (const n of notes) k.set(n.key, n.chunks, n.v)
    const build = performance.now() - t0

    const queries = [
      'duplicate BOL',
      'HS code',
      'declration',
      'why do we always say there are four agents',
      'get_user_businesses',
      '"business rules"'
    ]
    // Best of 3 per query: a lone GC pause or a parallel test file shouldn't fail the budget.
    const times = queries.map((q) =>
      Math.min(
        ...[0, 1, 2].map(() => {
          const s = performance.now()
          k.search(q)
          return performance.now() - s
        })
      )
    )
    console.log(
      `${k.size} chunks indexed in ${build.toFixed(0)} ms; queries ${times.map((t) => t.toFixed(1)).join(', ')} ms`
    )
    expect(k.size).toBeGreaterThan(0)
    expect(Math.max(...times)).toBeLessThan(10)
  })
})
