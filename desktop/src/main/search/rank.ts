import type { SearchHit } from '@shared/api'
import type { Chunk, ChunkType } from '@shared/chunker'
import type { VideoEntry } from '@shared/protocol'
import { phrases, processTerm, TOKEN } from './keyword'

/** One ranked list's entry: a chunk id and that list's own score (BM25 or cosine). */
export interface RankedId {
  id: string
  score: number
}

/** Decision 8: RRF constant, and at most this many passages per meeting. */
const RRF_K = 60
const PER_MEETING = 3
const ALL_TERMS_BONUS = 1.25
const PERSON_BONUS = 1.2
const INTENT_BONUS = 1.2
const RECENCY_WEIGHT = 0.05
const RECENCY_DAYS = 90
const DAY_MS = 86_400_000

/** Question words → the passage types that answer them. */
const INTENTS: [RegExp, ChunkType[]][] = [
  [/\b(who|owner|owns|assigned|todo|to-do|follow)/, ['action']],
  [/\b(why|decid|agree|chose)/, ['decision', 'qa']],
  [/\b(what is|what's|meaning|stands? for)/, ['term']],
  [/\b(rule|validat|when does|must)/, ['rule']]
]

/** The query's terms as the keyword index sees them (stop words dropped, stemmed), whole identifiers only. */
function queryTerms(q: string): string[] {
  const terms = new Set<string>()
  for (const token of q.replace(/"/g, ' ').match(TOKEN) ?? []) {
    const forms = processTerm(token)
    if (forms) terms.add(forms[0])
  }
  return [...terms]
}

/** Lowercase name words of the people a passage or meeting names ("Priya Shah" → priya, shah). */
function nameWords(names: string[]): Set<string> {
  return new Set(names.flatMap((n) => n.toLowerCase().match(/\p{L}+/gu) ?? []))
}

/**
 * Ranges of `text` whose token matches a query term (the last term also as a prefix, for typing), plus the
 * set of terms found.
 */
function matchTerms(
  text: string,
  terms: string[]
): { ranges: [number, number][]; found: Set<string> } {
  const ranges: [number, number][] = []
  const found = new Set<string>()
  if (!terms.length) return { ranges, found }
  const exact = new Set(terms)
  const last = terms[terms.length - 1]
  for (const m of text.matchAll(TOKEN)) {
    let hit = false
    for (const f of processTerm(m[0]) ?? []) {
      if (exact.has(f)) {
        found.add(f)
        hit = true
      } else if (last.length >= 2 && f.startsWith(last)) {
        found.add(last)
        hit = true
      }
    }
    if (hit) ranges.push([m.index, m.index + m[0].length])
  }
  return { ranges, found }
}

function phraseRanges(text: string, list: string[]): [number, number][] {
  const lower = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const p of list)
    for (let at = lower.indexOf(p); at !== -1; at = lower.indexOf(p, at + p.length))
      ranges.push([at, at + p.length])
  return ranges
}

function merge(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const prev = out[out.length - 1]
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

function recency(entry: VideoEntry | undefined, now: number): number {
  const at = Date.parse(entry?.recorded || entry?.processed || '')
  if (Number.isNaN(at)) return 1
  const days = Math.max(0, (now - at) / DAY_MS)
  return 1 + RECENCY_WEIGHT * Math.exp(-days / RECENCY_DAYS)
}

/**
 * Fuses keyword and vector results (SS·T15, decision 8): RRF (k = 60) over both lists, then small rule-based
 * boosts (all terms or the quoted phrase present, a person named, the passage type the question asks for,
 * recency), then at most 3 passages per meeting, grouped by meeting in order of each meeting's best passage.
 * Quoted phrases must appear verbatim, so vector hits without them are dropped. Pure: no I/O.
 */
export function rank(
  q: string,
  kwHits: RankedId[],
  vecHits: RankedId[],
  chunkOf: (id: string) => Chunk | undefined,
  entries: Record<string, VideoEntry>,
  now: number,
  limit = 30
): SearchHit[] {
  const rrf = new Map<string, number>()
  for (const list of [kwHits, vecHits])
    list.forEach((h, i) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)))

  const lowerQ = q.toLowerCase()
  const must = phrases(q)
  const terms = queryTerms(q)
  const queryWords = lowerQ.match(/\p{L}{3,}/gu) ?? []
  const wantTypes = new Set(INTENTS.filter(([re]) => re.test(lowerQ)).flatMap(([, t]) => t))

  const scored: SearchHit[] = []
  for (const [id, base] of rrf) {
    const c = chunkOf(id)
    if (!c) continue
    const lower = c.text.toLowerCase()
    if (!must.every((p) => lower.includes(p))) continue
    const entry = entries[c.key]
    const { ranges, found } = matchTerms(c.text, terms)
    let score = base
    if (must.length || (terms.length > 0 && found.size === terms.length)) score *= ALL_TERMS_BONUS
    const names = nameWords([...c.people, ...(entry?.participants ?? [])])
    if (queryWords.some((w) => names.has(w))) score *= PERSON_BONUS
    if (wantTypes.has(c.type)) score *= INTENT_BONUS
    score *= recency(entry, now)
    scored.push({
      key: c.key,
      chunkId: c.id,
      type: c.type,
      section: c.section,
      anchor: c.anchor,
      ts: c.ts,
      text: c.text,
      highlights: merge([...ranges, ...phraseRanges(c.text, must)]),
      score
    })
  }
  scored.sort((a, b) => b.score - a.score)

  // A Map keeps first-insertion order, so meetings come out in the order of their best passage.
  const perMeeting = new Map<string, SearchHit[]>()
  let kept = 0
  for (const hit of scored) {
    if (kept >= limit) break
    const group = perMeeting.get(hit.key) ?? []
    if (group.length >= PER_MEETING) continue
    group.push(hit)
    perMeeting.set(hit.key, group)
    kept++
  }
  return [...perMeeting.values()].flat()
}
