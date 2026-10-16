import { describe, expect, it } from 'vitest'
import type { SearchHit } from '@shared/api'
import { groupHits, hitPath, snippet } from './search'

const join = (parts: { text: string }[]): string => parts.map((p) => p.text).join('')

describe('snippet', () => {
  it('keeps short text whole and marks the ranges', () => {
    const parts = snippet('resolve the duplicate BOL error', [[22, 25]])
    expect(parts).toEqual([
      { text: 'resolve the duplicate ', mark: false },
      { text: 'BOL', mark: true },
      { text: ' error', mark: false }
    ])
  })

  it('cuts long text around the first highlight at word boundaries', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
    const at = words.indexOf('w150')
    const parts = snippet(words, [[at, at + 4]], 80)
    const text = join(parts)
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(82)
    expect(parts.find((p) => p.mark)?.text).toBe('w150')
    // No word is cut in half.
    expect(
      text
        .slice(1, -1)
        .split(' ')
        .every((w) => /^w\d+$/.test(w))
    ).toBe(true)
  })

  it('drops ranges outside the window and never marks a character twice', () => {
    const text = 'a'.repeat(50) + ' match two ' + 'b'.repeat(500)
    const parts = snippet(text, [
      [51, 56],
      [53, 60],
      [400, 410]
    ])
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(['match', ' two'])
    expect(join(parts)).toBe('a'.repeat(50) + ' match two…')
  })

  it('starts at the beginning when there is no highlight', () => {
    const text = 'x '.repeat(300)
    expect(join(snippet(text, [], 40)).startsWith('x')).toBe(true)
  })
})

describe('groupHits / hitPath', () => {
  const hit = (key: string, chunkId: string, anchor = 'h-decisions-made'): SearchHit => ({
    key,
    chunkId,
    type: 'decision',
    section: 'Decisions Made',
    anchor,
    ts: null,
    text: '',
    highlights: [],
    score: 1
  })

  it('groups by meeting in first-seen order', () => {
    const groups = groupHits([hit('b', 'b#1'), hit('a', 'a#1'), hit('b', 'b#2')])
    expect(groups.map(([k, hs]) => [k, hs.map((h) => h.chunkId)])).toEqual([
      ['b', ['b#1', 'b#2']],
      ['a', ['a#1']]
    ])
  })

  it('opens the notes tab at the section', () => {
    expect(hitPath(hit('C:\\v\\a b.mp4', 'x'))).toBe(
      '/video/C%3A%5Cv%5Ca%20b.mp4?tab=notes&section=h-decisions-made'
    )
    expect(hitPath(hit('k', 'x', ''))).toBe('/video/k?tab=notes')
  })
})
