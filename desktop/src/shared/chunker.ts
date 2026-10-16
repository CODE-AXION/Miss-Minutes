/**
 * Structure-aware chunker for smart search (SS·T2): turns one Miss Minutes note into search passages — one per
 * Agenda/Decision/Note bullet, table row, Q-with-its-A and group of 4 process steps, plus one summary passage per
 * meeting. Mermaid and other fenced code blocks are never indexed.
 *
 * Pure: no Node or Electron imports, so the renderer, main and the search worker can all use it.
 */
import { slug } from './slug'

export type ChunkType =
  | 'summary'
  | 'overview'
  | 'topic'
  | 'flow'
  | 'rule'
  | 'term'
  | 'qa'
  | 'decision'
  | 'action'
  | 'note'

export interface Chunk {
  /** `${key}#${n}`, stable for an unchanged note. */
  id: string
  /** index.json key (not the file path: notes are renamed when they are recategorised). */
  key: string
  type: ChunkType
  /** Heading text as written, e.g. "Decisions Made"; "Summary" for the summary passage. */
  section: string
  /** slug(section), e.g. "h-decisions-made"; '' for the summary passage. */
  anchor: string
  /** First [MM:SS] or [HH:MM:SS] in the text, without brackets. */
  ts: string | null
  /** Participants named in this passage (Q askers, A answerers, action owners). */
  people: string[]
  /** Clean display text (no ** markup, collapsed whitespace). */
  text: string
  /** Embedding input: `title: ${title} · ${date} · ${section} | text: ${text}`. */
  doc: string
}

export interface NoteMeta {
  key: string
  title: string
  recorded: string
  participants: string[]
}

/** Passages under this many words are merged into the previous passage of the same section. */
const MIN_WORDS = 15
/** Passages over this many words (~512 tokens) are split at sentence boundaries. */
const MAX_WORDS = 400
const STEPS_PER_CHUNK = 4

const TS = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/
const NUMBERED = /^\s*\d+[.)]\s+/
const BULLET = /^\s*[-*+]\s+/
const RULE_LINE = /^(-{3,}|\*{3,}|_{3,})$/
/** The prompt's placeholder for an empty section, sometimes followed by a reason: "_None discussed._ (…)". */
const NONE = /^none discussed\b\.?\s*/i

interface Piece {
  text: string
  people: string[]
}

/** Turns a note into search passages; see the module docblock. `meta` fills in whatever the front matter lacks. */
export function chunkNote(markdown: string, meta: NoteMeta): Chunk[] {
  // Notes saved so far end their lines in "\r\r\n" (watcher.py); normalise to "\n" first, as the note viewer does.
  const md = markdown.replace(/\r+\n?/g, '\n')
  const [fm, body] = frontMatter(md)

  const title = str(fm.title) || meta.title
  const date = (str(fm.recorded) || meta.recorded).slice(0, 10)
  const participants = list(fm.participants) ?? meta.participants
  const tags = list(fm.tags) ?? []

  const out: Omit<Chunk, 'id' | 'doc'>[] = [
    {
      key: meta.key,
      type: 'summary',
      section: 'Summary',
      anchor: '',
      ts: null,
      people: [...participants],
      text: clean(
        `${title}. ${str(fm.summary)} Participants: ${participants.join(', ')}. Tags: ${tags.join(', ')}.`
      )
    }
  ]

  const sections = body
    .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
    .split(/^## /m)
    .slice(1)
  for (const sec of sections) {
    const [headingLine, ...lines] = sec.split('\n')
    const section = clean(headingLine)
    if (!section) continue
    const type = typeOf(section)
    for (const p of splitLong(merge(sectionPieces(type, lines)))) {
      out.push({
        key: meta.key,
        type,
        section,
        anchor: slug(section),
        ts: p.text.match(TS)?.[1] ?? null,
        people: peopleIn(p, participants),
        text: p.text
      })
    }
  }

  return out.map((c, i) => ({
    id: `${meta.key}#${i}`,
    ...c,
    doc: `title: ${title} · ${date} · ${c.section} | text: ${c.text}`
  }))
}

// ---------- front matter ----------

type FmValue = string | string[]

/** The leading `---…---` YAML block as flat `key: value` pairs (all the engine writes), and the body after it. */
function frontMatter(md: string): [Record<string, FmValue>, string] {
  const m = md.match(/^\s*---\n([\s\S]*?)\n---\n/)
  if (!m) return [{}, md]
  const fm: Record<string, FmValue> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*?)\s*$/)
    if (kv) fm[kv[1]] = yamlValue(kv[2])
  }
  return [fm, md.slice(m[0].length)]
}

function yamlValue(raw: string): FmValue {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const v: unknown = JSON.parse(raw)
      if (Array.isArray(v)) return v.map(String)
    } catch {
      // Unquoted flow list, e.g. [demo, ui-ux].
    }
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean)
  }
  return unquote(raw)
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s))
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

function str(v: FmValue | undefined): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : ''
}

function list(v: FmValue | undefined): string[] | undefined {
  if (Array.isArray(v)) return v
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
}

// ---------- sections ----------

/** Passage type from the heading, by keyword (headings come from the prompt in meeting_notes.py). */
function typeOf(heading: string): ChunkType {
  const h = heading.toLowerCase()
  if (h.includes('agenda') || h.includes('topic')) return 'topic'
  if (h.includes('process') || h.includes('flow')) return 'flow'
  if (h.includes('rule') || h.includes('logic')) return 'rule'
  if (h.includes('glossary') || h.includes('term')) return 'term'
  if (h.includes('doubt') || h.includes('q&a')) return 'qa'
  if (h.includes('decision')) return 'decision'
  if (h.includes('action')) return 'action'
  if (h.includes('overview')) return 'overview'
  return 'note'
}

/**
 * Raw passages of one section, in document order: one per table row, bullet or paragraph, groups of 4 numbered steps,
 * and (in Q&A sections) one per `**Q` with its answer.
 */
function sectionPieces(type: ChunkType, lines: string[]): Piece[] {
  if (type === 'qa' && lines.some((l) => /^\s*\*\*Q\b/.test(l))) return qaPieces(lines)

  const pieces: Piece[] = []
  let para: string[] = []
  let steps: string[] = []
  let table: string[] = []
  let bullet: string | null = null

  const flushPara = (): void => {
    if (para.length) pieces.push({ text: para.join(' '), people: [] })
    para = []
  }
  const flushSteps = (): void => {
    for (let i = 0; i < steps.length; i += STEPS_PER_CHUNK) {
      pieces.push({ text: steps.slice(i, i + STEPS_PER_CHUNK).join(' '), people: [] })
    }
    steps = []
  }
  const flushTable = (): void => {
    if (table.length) pieces.push(...tablePieces(type, table))
    table = []
  }
  const flushBullet = (): void => {
    if (bullet !== null) pieces.push({ text: bullet, people: [] })
    bullet = null
  }
  const flushAll = (): void => {
    flushPara()
    flushSteps()
    flushTable()
    flushBullet()
  }

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('|')) {
      if (!table.length) flushAll()
      table.push(t)
      continue
    }
    flushTable()
    if (!t || RULE_LINE.test(t)) {
      // A blank line ends a paragraph; lists may have blank lines between items.
      flushPara()
      continue
    }
    const indented = /^\s{2,}/.test(line)
    if (NUMBERED.test(line) && !indented) {
      flushPara()
      flushBullet()
      steps.push(t)
    } else if (BULLET.test(line)) {
      flushPara()
      const sub = t.replace(BULLET, '')
      if (indented && bullet !== null)
        bullet += ' ' + sub // nested bullet: part of the bullet above
      else if (indented && steps.length)
        steps[steps.length - 1] += ' ' + sub // ... or of the step above
      else {
        flushSteps()
        flushBullet()
        bullet = sub
      }
    } else if (bullet !== null && /^\s/.test(line)) {
      bullet += ' ' + t // continuation line of a bullet
    } else if (steps.length && /^\s/.test(line)) {
      steps[steps.length - 1] += ' ' + t // continuation line of a step
    } else {
      flushSteps()
      flushBullet()
      para.push(t.replace(/^#+\s+/, ''))
    }
  }
  flushAll()
  return pieces.map((p) => ({ ...p, text: clean(p.text).replace(NONE, '') })).filter((p) => p.text)
}

/**
 * One passage per data row, written as `Header: cell. Header: cell.` Cells are split on unescaped `|`; a `|` inside
 * backticks splits the cell too — rare enough in notes to accept rather than write a full table parser.
 */
function tablePieces(type: ChunkType, rows: string[]): Piece[] {
  const cells = rows.map((r) =>
    r
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => clean(c.replace(/\\\|/g, '|')))
  )
  const isSeparator = (r: string[]): boolean => r.every((c) => /^:?-+:?$/.test(c))
  const head = cells[0]
  const data = cells.slice(1).filter((r) => !isSeparator(r))
  const ownerCol = type === 'action' ? head.findIndex((h) => /owner|assignee/i.test(h)) : -1
  return data.map((r) => ({
    text: r
      .map((c, i) => (c ? (head[i] ? `${head[i]}: ${c}` : c) : ''))
      .filter(Boolean)
      .map((c) => (/[.!?]$/.test(c) ? c : c + '.'))
      .join(' '),
    people: ownerCol >= 0 && r[ownerCol] ? names(r[ownerCol]) : []
  }))
}

/** Q&A sections: each `**Q …` line starts a passage that keeps its `**A …` answer; text before the first Q is a paragraph. */
function qaPieces(lines: string[]): Piece[] {
  const blocks: string[][] = [[]]
  for (const l of lines) {
    if (/^\s*\*\*Q\b/.test(l)) blocks.push([])
    if (l.trim() && !RULE_LINE.test(l.trim())) blocks[blocks.length - 1].push(l.trim())
  }
  return blocks
    .filter((b) => b.length)
    .map((b) => {
      const raw = b.join(' ')
      const people: string[] = []
      for (const m of raw.matchAll(/\*\*[QA]\b[^(*]*\(([^)]*)\)/g)) people.push(...names(m[1]))
      return { text: clean(raw).replace(NONE, ''), people }
    })
    .filter((p) => p.text)
}

/** "Priya Nair / Tom Becker" → ["Priya Nair", "Tom Becker"]. */
function names(s: string): string[] {
  return clean(s)
    .split(/\s*(?:\/|,|&|\band\b)\s*/)
    .map((n) => n.trim())
    .filter((n) => n && !/^(asked by|answered by|unresolved|n\/a|-)$/i.test(n))
}

// ---------- merge / split ----------

const words = (s: string): number => (s ? s.split(/\s+/).length : 0)

/** Merges tiny passages into the previous one; a tiny first passage (e.g. a list intro) is carried into the next. */
function merge(pieces: Piece[]): Piece[] {
  const join = (a: Piece, b: Piece): Piece => ({
    text: `${a.text} ${b.text}`,
    people: [...a.people, ...b.people]
  })
  const out: Piece[] = []
  let carry: Piece | null = null
  for (const p of pieces) {
    const cur = carry ? join(carry, p) : p
    carry = null
    if (words(cur.text) >= MIN_WORDS) out.push(cur)
    else if (out.length) out[out.length - 1] = join(out[out.length - 1], cur)
    else carry = cur
  }
  if (carry) out.push(carry)
  return out
}

/** Splits passages over MAX_WORDS at sentence boundaries (or hard at MAX_WORDS for one endless sentence). */
function splitLong(pieces: Piece[]): Piece[] {
  return pieces.flatMap((p) => {
    if (words(p.text) <= MAX_WORDS) return [p]
    const parts: string[] = []
    let cur: string[] = []
    const push = (): void => {
      if (cur.length) parts.push(cur.join(' '))
      cur = []
    }
    for (const sentence of p.text.split(/(?<=[.!?])\s+/)) {
      const w = sentence.split(/\s+/)
      if (cur.length + w.length > MAX_WORDS) push()
      for (const word of w) {
        cur.push(word)
        if (cur.length >= MAX_WORDS) push()
      }
    }
    push()
    return parts.map((text) => ({ text, people: p.people }))
  })
}

// ---------- text ----------

/** Display text: no bold, code or _italic_ markup (snake_case is left alone), whitespace collapsed. */
function clean(s: string): string {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Explicit names (Q/A, owners) plus every participant whose name appears in the text; participant spelling wins. */
function peopleIn(p: Piece, participants: string[]): string[] {
  const text = p.text.toLowerCase()
  const seen = new Map<string, string>()
  const add = (n: string): void => {
    const k = n.toLowerCase()
    if (!seen.has(k)) seen.set(k, participants.find((x) => x.toLowerCase() === k) ?? n)
  }
  p.people.forEach(add)
  participants.filter((n) => n && text.includes(n.toLowerCase())).forEach(add)
  return [...seen.values()]
}
