/**
 * Library search over the notes (SS·T22): keyword results while typing, the smart search on Enter. Results come
 * from main's SearchService by index key; the snippet and the type labels are built here.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchHit, SearchResult } from '@shared/api'
import { videoPath } from './paths'

/** Keyword results follow the typing after this pause. */
export const DEBOUNCE_MS = 150
/** Characters of passage text shown per result. */
export const SNIPPET_CHARS = 220

export const TYPE_LABEL: Record<SearchHit['type'], string> = {
  decision: 'Decision',
  action: 'Action item',
  qa: 'Q&A',
  rule: 'Rule',
  term: 'Term',
  topic: 'Topic',
  flow: 'Flow',
  overview: 'Overview',
  summary: 'Summary',
  note: 'Note'
}

/** Route that opens a passage: the note tab, scrolled to its section (SS·T24). */
export function hitPath(hit: Pick<SearchHit, 'key' | 'anchor'>): string {
  const section = hit.anchor ? `&section=${encodeURIComponent(hit.anchor)}` : ''
  return `${videoPath(hit.key)}?tab=notes${section}`
}

export interface SnippetPart {
  text: string
  mark: boolean
}

/**
 * About `max` characters of `text` around the first highlight, cut at word boundaries, with the highlight ranges
 * as marked parts. Plain text only: the caller renders `<mark>` elements, never HTML from the index.
 */
export function snippet(
  text: string,
  highlights: [number, number][],
  max = SNIPPET_CHARS
): SnippetPart[] {
  let start = 0
  let end = text.length
  if (text.length > max) {
    // Some context before the first match, then fill up to `max`.
    const first = highlights[0]?.[0] ?? 0
    start = Math.max(0, first - Math.floor(max / 4))
    end = Math.min(text.length, start + max)
    start = Math.max(0, end - max)
    if (start > 0) {
      const space = text.indexOf(' ', start)
      if (space !== -1 && space < first) start = space + 1
    }
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > start) end = space
    }
  }
  const parts: SnippetPart[] = []
  const push = (from: number, to: number, mark: boolean): void => {
    if (to > from) parts.push({ text: text.slice(from, to), mark })
  }
  let at = start
  for (const [a, b] of [...highlights].sort((x, y) => x[0] - y[0])) {
    const from = Math.max(a, at)
    const to = Math.min(b, end)
    if (to <= from) continue
    push(at, from, false)
    push(from, to, true)
    at = to
  }
  push(at, end, false)
  if (start > 0) parts.unshift({ text: '…', mark: false })
  if (end < text.length) parts.push({ text: '…', mark: false })
  return parts
}

/** Hits grouped by meeting, in the order the meetings first appear. */
export function groupHits(hits: SearchHit[]): [string, SearchHit[]][] {
  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const group = groups.get(hit.key)
    if (group) group.push(hit)
    else groups.set(hit.key, [hit])
  }
  return [...groups]
}

export interface NoteSearch {
  /** The latest answer for a non-empty query (it stays up while the next one is on its way); null before it. */
  result: SearchResult | null
  /** The search IPC failed: the page falls back to the title/summary filter. */
  failed: boolean
  /** Runs the smart search for the current query now (Enter). */
  runSmart: () => void
}

/**
 * Keyword search `DEBOUNCE_MS` after the last change of `q` or `keys`; `runSmart` asks for keyword + vector search.
 * A request counter drops stale answers, so the results never flick back to an older query.
 */
export function useNoteSearch(q: string, keys: string[]): NoteSearch {
  const [answer, setAnswer] = useState<{ result: SearchResult | null; failed: boolean }>({
    result: null,
    failed: false
  })
  const seq = useRef(0)
  const query = q.trim()
  // The keys array is rebuilt on every state push; only a different set of meetings should search again.
  const keySig = keys.join('\n')

  const run = useCallback(
    (smart: boolean) => {
      const id = ++seq.current
      if (!query) return
      window.api.search.query(query, { smart, keys: keySig ? keySig.split('\n') : [] }).then(
        (result) => id === seq.current && setAnswer({ result, failed: false }),
        () => id === seq.current && setAnswer({ result: null, failed: true })
      )
    },
    [query, keySig]
  )

  useEffect(() => {
    if (!query) {
      seq.current++ // an answer still on its way is stale now
      return
    }
    const timer = setTimeout(() => run(false), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, run])

  return {
    result: query ? answer.result : null,
    failed: query ? answer.failed : false,
    runSmart: () => run(true)
  }
}
