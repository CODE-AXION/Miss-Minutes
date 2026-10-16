import MiniSearch from 'minisearch'
import type { Chunk } from '@shared/chunker'

/** Meeting-level fields indexed with every chunk of that meeting (from its index.json entry). */
export interface MeetingFields {
  title?: string
  category?: string
  tags?: string[]
}

export interface KeywordHit {
  id: string
  score: number
}

interface Doc {
  id: string
  text: string
  title: string
  people: string
  section: string
  tags: string
}

const STOP = new Set(
  (
    'a an and are as at be been but by can did do does for from had has have he her his i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this to too us was we were ' +
    'what when where which who why will with would you your'
  ).split(' ')
)

/** Words and identifiers: letters/digits joined by `_`, `-`, `/` or `.` stay one token (`get_user_businesses`). */
export const TOKEN = /\/?[\p{L}\p{N}]+(?:[_\-/.][\p{L}\p{N}]+)*/gu
const JOINER = /[_\-/.]+/

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/**
 * Light English stemming on words of 4+ letters: -s, -es, -ing, -ed and a final -e, so "rules"/"rule" and
 * "validated"/"validating"/"validate" meet. Not a real stemmer; fuzzy matching covers the rest.
 */
export function stem(word: string): string {
  if (word.length < 4 || /\d/.test(word)) return word
  let w = word
  if (/(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2)
  else if (/[^su]s$/.test(w) && !w.endsWith('is')) w = w.slice(0, -1)
  else if (w.length >= 6 && w.endsWith('ing')) w = undouble(w.slice(0, -3))
  else if (w.length >= 5 && w.endsWith('ed')) w = undouble(w.slice(0, -2))
  if (w.length >= 5 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

/** "runn" → "run", "stopp" → "stop"; keeps "call", "pass", "buzz". */
function undouble(w: string): string {
  return /([^aeiouslz])\1$/.test(w) ? w.slice(0, -1) : w
}

function word(term: string): string | null {
  return STOP.has(term) ? null : stem(term)
}

/** One token → its index terms: an identifier keeps its whole form and adds its parts. */
export function processTerm(term: string): string[] | null {
  const t = term.toLowerCase()
  if (!JOINER.test(t)) {
    const w = word(t)
    return w ? [w] : null
  }
  const parts = t
    .split(JOINER)
    .filter(Boolean)
    .map(word)
    .filter((p): p is string => p !== null)
  return [t, ...parts]
}

/** The "quoted phrases" of a query, lowercased. */
export function phrases(q: string): string[] {
  return [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim().toLowerCase()).filter(Boolean)
}

/**
 * Keyword search over every chunk (SS·T7), for everyone: MiniSearch BM25 over the chunk text, the meeting's
 * title/tags/category, the people named and the section. Built in memory from the store, never persisted.
 */
export class KeywordIndex {
  private readonly mini = new MiniSearch<Doc>({
    fields: ['text', 'title', 'people', 'section', 'tags'],
    storeFields: [],
    tokenize,
    processTerm,
    searchOptions: {
      boost: { text: 1, title: 2, people: 3, section: 1.5, tags: 1 },
      prefix: (_term, i, terms) => i === terms.length - 1,
      // Short terms ("HS", "BOL") must match exactly.
      fuzzy: (term) => (term.length >= 5 ? 0.2 : 0)
    }
  })
  private readonly chunks = new Map<string, Chunk>()
  private readonly ids = new Map<string, string[]>()

  get size(): number {
    return this.chunks.size
  }

  chunk(id: string): Chunk | undefined {
    return this.chunks.get(id)
  }

  /** Replaces one meeting's chunks (also used to add a meeting). */
  set(key: string, chunks: Chunk[], meeting: MeetingFields = {}): void {
    this.remove(key)
    const shared = {
      title: meeting.title ?? '',
      tags: [...(meeting.tags ?? []), meeting.category ?? ''].join(' ')
    }
    for (const c of chunks) this.chunks.set(c.id, c)
    this.ids.set(
      key,
      chunks.map((c) => c.id)
    )
    this.mini.addAll(
      chunks.map((c) => ({
        id: c.id,
        text: c.text,
        people: c.people.join(' '),
        section: `${c.section} ${c.type}`,
        ...shared
      }))
    )
  }

  remove(key: string): void {
    for (const id of this.ids.get(key) ?? []) {
      this.mini.discard(id)
      this.chunks.delete(id)
    }
    this.ids.delete(key)
  }

  /**
   * Best chunks for `q`, highest score first. `keys` restricts the results to those meetings (the Library
   * filters); each "quoted phrase" must appear verbatim (case-insensitive) in the chunk text.
   */
  search(
    q: string,
    { limit = 50, keys }: { limit?: number; keys?: Set<string> } = {}
  ): KeywordHit[] {
    const must = phrases(q)
    const text = q.replace(/"/g, ' ')
    if (!text.trim()) return []
    const hits = this.mini.search(text, {
      filter: (r) => {
        const c = this.chunks.get(r.id as string)
        if (!c || (keys && !keys.has(c.key))) return false
        const lower = c.text.toLowerCase()
        return must.every((p) => lower.includes(p))
      }
    })
    return hits.slice(0, limit).map((r) => ({ id: r.id as string, score: r.score }))
  }
}
