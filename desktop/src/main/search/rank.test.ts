import { describe, expect, it } from 'vitest'
import type { Chunk } from '@shared/chunker'
import type { VideoEntry } from '@shared/protocol'
import { rank, type RankedId } from './rank'

const NOW = Date.parse('2026-10-16T12:00:00')

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

const entry = (recorded: string, participants: string[] = []): VideoEntry => ({
  source: 'x.mp4',
  status: 'done',
  recorded,
  attempts: 1,
  updated: recorded,
  participants
})

const ids = (...list: string[]): RankedId[] => list.map((id, i) => ({ id, score: 10 - i }))

function lookup(chunks: Chunk[]): (id: string) => Chunk | undefined {
  const map = new Map(chunks.map((c) => [c.id, c]))
  return (id) => map.get(id)
}

const entries = {
  m1: entry('2026-10-01T10:00:00'),
  m2: entry('2026-10-01T10:00:00'),
  m3: entry('2026-10-01T10:00:00')
}

describe('rank', () => {
  it('puts a chunk found by both lists above chunks found by one', () => {
    const chunks = [
      chunk('m1', 0, 'alpha one'),
      chunk('m2', 0, 'beta two'),
      chunk('m3', 0, 'gamma three')
    ]
    const hits = rank('zzz', ids('m1#0', 'm2#0'), ids('m3#0', 'm2#0'), lookup(chunks), entries, NOW)
    expect(hits[0].chunkId).toBe('m2#0')
    expect(hits).toHaveLength(3)
  })

  it('lifts an action item for "who owns …"', () => {
    const chunks = [
      chunk('m1', 0, 'The export format was discussed at length.'),
      chunk('m2', 0, 'Task: send the export format. Owner: Priya.', { type: 'action' })
    ]
    // Same RRF score for both (rank 1 in one list each): only the intent rule separates them.
    const hits = rank('who owns the export', ids('m1#0'), ids('m2#0'), lookup(chunks), entries, NOW)
    expect(hits[0].chunkId).toBe('m2#0')
  })

  it('keeps at most 3 passages per meeting, grouped by meeting', () => {
    const chunks = [
      ...[0, 1, 2, 3, 4].map((n) => chunk('m1', n, `invoice item ${n}`)),
      chunk('m2', 0, 'invoice other')
    ]
    const kw = ids('m1#0', 'm1#1', 'm1#2', 'm1#3', 'm2#0', 'm1#4')
    const hits = rank('invoice', kw, [], lookup(chunks), entries, NOW)
    expect(hits.filter((h) => h.key === 'm1')).toHaveLength(3)
    expect(hits.map((h) => h.key)).toEqual(['m1', 'm1', 'm1', 'm2'])
  })

  it('drops vector hits without the quoted phrase and highlights it', () => {
    const chunks = [
      chunk('m1', 0, 'The duplicate BOL blocks submission.'),
      chunk('m2', 0, 'A bill of lading that repeats is rejected.')
    ]
    const hits = rank(
      '"duplicate bol"',
      ids('m1#0'),
      ids('m2#0', 'm1#0'),
      lookup(chunks),
      entries,
      NOW
    )
    expect(hits.map((h) => h.chunkId)).toEqual(['m1#0'])
    expect(hits[0].highlights).toEqual([[4, 17]])
  })

  it('highlights matched terms, including stemmed forms', () => {
    const chunks = [chunk('m1', 0, 'Rules are validated before saving.')]
    const [hit] = rank('validating rule', ids('m1#0'), [], lookup(chunks), entries, NOW)
    const words = hit.highlights.map(([a, b]) => hit.text.slice(a, b))
    expect(words).toEqual(['Rules', 'validated'])
  })

  it('boosts a passage naming the person asked about', () => {
    const chunks = [
      chunk('m1', 0, 'Pricing tiers were reviewed.'),
      chunk('m2', 0, 'Pricing tiers were reviewed again.', { people: ['Priya Shah'] })
    ]
    const hits = rank('priya pricing', ids('m1#0'), ids('m2#0'), lookup(chunks), entries, NOW)
    expect(hits[0].chunkId).toBe('m2#0')
  })

  it('breaks ties toward recent meetings', () => {
    const chunks = [chunk('m1', 0, 'same text'), chunk('m2', 0, 'same text')]
    const dated = { m1: entry('2025-01-01T10:00:00'), m2: entry('2026-10-15T10:00:00') }
    const hits = rank('zzz', ids('m1#0'), ids('m2#0'), lookup(chunks), dated, NOW)
    expect(hits[0].key).toBe('m2')
  })
})
