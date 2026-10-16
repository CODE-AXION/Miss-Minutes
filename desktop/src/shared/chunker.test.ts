import { readFileSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { describe, expect, it } from 'vitest'
import { chunkNote, type Chunk, type ChunkType } from './chunker'
import { slug } from './slug'

const META = {
  key: 'C:\\Videos\\2026-03-04 10-15-00.mp4',
  title: 'fallback title',
  recorded: '2026-03-04T10:15:00',
  participants: []
}

// The engine writes "\r\r\n" line endings (watcher.py); build that form here, since git may rewrite the fixture's.
const lf = readFileSync(join(__dirname, '__fixtures__', 'sample-note.md'), 'utf8').replace(
  /\r+\n/g,
  '\n'
)
const note = lf.replace(/\n/g, '\r\r\n')

const ofType = (chunks: Chunk[], type: ChunkType): Chunk[] => chunks.filter((c) => c.type === type)

describe('chunkNote on the fixture note', () => {
  const chunks = chunkNote(note, META)

  it('makes the expected number of passages per type', () => {
    const counts: Record<string, number> = {}
    for (const c of chunks) counts[c.type] = (counts[c.type] ?? 0) + 1
    expect(counts).toEqual({
      summary: 1,
      overview: 1,
      topic: 3,
      flow: 2,
      rule: 2,
      term: 2,
      qa: 2,
      decision: 2,
      action: 2,
      note: 2
    })
  })

  it('reads the summary passage from the front matter', () => {
    const [s] = chunks
    expect(s.type).toBe('summary')
    expect(s.anchor).toBe('')
    expect(s.text).toContain('Payroll Portal Onboarding Review.')
    expect(s.text).toContain('Participants: Priya Nair, Tom Becker, Lena Ortiz.')
    expect(s.text).toContain('Tags: onboarding, business-rules, demo.')
    expect(s.people).toEqual(['Priya Nair', 'Tom Becker', 'Lena Ortiz'])
  })

  it('drops mermaid blocks', () => {
    for (const c of chunks) {
      expect(c.text).not.toMatch(/SECRETMERMAID|flowchart|```/)
    }
  })

  it('writes each table row as one passage with Header: labels', () => {
    const rules = ofType(chunks, 'rule')
    expect(rules[0].text).toMatch(
      /^Rule: Invite expiry\. Details \/ Conditions: An invitation link/
    )
    expect(rules[0].text).toMatch(/Timestamp: \[01:45\]\.$/)
    expect(rules[1].text).toMatch(/^Rule: IBAN validation\./)
    const actions = ofType(chunks, 'action')
    expect(actions[0].text).toMatch(
      /^Owner: Priya Nair\. Task: .+ Due \/ Priority \(if mentioned\): High\. Timestamp: \[06:20\]\.$/
    )
    expect(actions[0].people).toEqual(['Priya Nair'])
    expect(actions[1].people).toEqual(['Tom Becker'])
  })

  it('keeps each question with its answer and names the askers and answerers', () => {
    const qa = ofType(chunks, 'qa')
    expect(qa[0].text).toMatch(
      /^Q \[05:02\] \(Tom Becker\): What happens .+ A \(Priya Nair\): The checksum/
    )
    expect(qa[0].people).toEqual(['Tom Becker', 'Priya Nair'])
    expect(qa[1].people).toEqual(['Lena Ortiz', 'Priya Nair', 'Tom Becker'])
  })

  it('groups numbered steps by 4 and carries a short intro into the first group', () => {
    const flow = ofType(chunks, 'flow')
    expect(flow[0].text).toMatch(/^The onboarding flow: 1\. Invite: .+ 4\. Tax form: .+ 5 MB\.$/)
    expect(flow[1].text).toMatch(/^5\. Approval: .+ 6\. Payroll sync: /)
  })

  it('merges a tiny bullet into the previous passage', () => {
    const topics = ofType(chunks, 'topic')
    expect(topics[2].text).toMatch(/Approval Queue: .+ \[09:55\] Wrap-up\.$/)
  })

  it('skips "None discussed" sections and indexes unknown headings as notes', () => {
    expect(chunks.some((c) => c.section.startsWith('Open Questions'))).toBe(false)
    const other = chunks.find((c) => c.section === 'Something New')
    expect(other?.type).toBe('note')
    expect(other?.text).toMatch(/^This section heading is not in the prompt today/)
  })

  it('uses the note viewer slug for anchors', () => {
    for (const c of chunks.slice(1)) expect(c.anchor).toBe(slug(c.section))
    expect(ofType(chunks, 'qa')[0].anchor).toBe('h-doubts-raised-resolutions')
    expect(ofType(chunks, 'topic')[0].anchor).toBe('h-agenda-topics-covered')
  })

  it('extracts the first timestamp', () => {
    expect(ofType(chunks, 'topic').map((c) => c.ts)).toEqual(['00:00', '03:12', '07:40'])
    expect(ofType(chunks, 'qa').map((c) => c.ts)).toEqual(['05:02', '08:10'])
    expect(ofType(chunks, 'overview')[0].ts).toBeNull()
  })

  it('formats the embedding input with the model card prefix', () => {
    const d = ofType(chunks, 'decision')[0]
    expect(d.doc).toBe(
      `title: Payroll Portal Onboarding Review · 2026-03-04 · Decisions Made | text: ${d.text}`
    )
    expect(d.text).not.toContain('**')
  })

  it('gives stable ids and the same result for any line endings', () => {
    expect(chunkNote(note, META)).toEqual(chunks)
    expect(chunkNote(lf, META)).toEqual(chunks)
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `${META.key}#${i}`))
  })
})

describe('chunkNote edge cases', () => {
  it('falls back to meta without front matter', () => {
    const [s, o] = chunkNote('# T\n\n## Overview\nOne short line here.\n', {
      ...META,
      title: 'Meta Title',
      participants: ['Ann Lee']
    })
    expect(s.text).toBe('Meta Title. Participants: Ann Lee. Tags: .')
    expect(o.doc).toBe('title: Meta Title · 2026-03-04 · Overview | text: One short line here.')
  })

  it('drops the "None discussed" placeholder but keeps any reason after it', () => {
    const md = [
      '## Doubts Raised & Resolutions',
      '_None discussed._',
      '',
      '## Important Notes',
      '_None discussed._ (The next step is for Ann to retry the upload alone.)'
    ].join('\n')
    const chunks = chunkNote(md, META).slice(1)
    expect(chunks.map((c) => c.text)).toEqual([
      '(The next step is for Ann to retry the upload alone.)'
    ])
  })

  it('strips _italic_ markup but not snake_case names', () => {
    const [, c] = chunkNote('## Important Notes\nThe save_invoice call is _not_ retried.\n', META)
    expect(c.text).toBe('The save_invoice call is not retried.')
  })

  it('splits very long passages at sentence boundaries, keeping the section', () => {
    const sentence = 'This sentence has exactly ten words in it for testing. '
    const md = `## Important Notes\n${sentence.repeat(90)}\n`
    const parts = chunkNote(md, META).slice(1)
    expect(parts.length).toBe(3)
    for (const p of parts) {
      expect(p.text.split(' ').length).toBeLessThanOrEqual(400)
      expect(p.anchor).toBe('h-important-notes')
      expect(p.text).toMatch(/testing\.$/)
    }
  })
})

interface IndexEntry {
  status?: string
  notes?: string
  title?: string
  recorded?: string
  participants?: string[]
}

// Smoke test on a real library, skipped unless MM_LIBRARY=<library folder> is set.
const LIBRARY = process.env.MM_LIBRARY ?? ''

describe.skipIf(!LIBRARY)('chunkNote on the real library', () => {
  it('chunks every done note cleanly', () => {
    const index = JSON.parse(readFileSync(join(LIBRARY, 'index.json'), 'utf8')) as {
      videos: Record<string, IndexEntry>
    }
    const notes = Object.entries(index.videos)
      .filter(([, v]) => v.status === 'done' && v.notes)
      .map(([key, v]) => ({
        md: readFileSync(join(LIBRARY, v.notes ?? ''), 'utf8'),
        meta: {
          key,
          title: v.title ?? '',
          recorded: v.recorded ?? '',
          participants: v.participants ?? []
        }
      }))

    const t0 = performance.now()
    const all = notes.map((n) => chunkNote(n.md, n.meta))
    const ms = performance.now() - t0

    const counts: Record<string, number> = {}
    for (const c of all.flat()) counts[c.type] = (counts[c.type] ?? 0) + 1
    console.log(
      `${notes.length} notes → ${all.flat().length} chunks in ${ms.toFixed(0)} ms`,
      counts
    )

    expect(notes.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(100 * Math.max(1, notes.length / 27))
    for (const chunks of all) {
      expect(chunks.filter((c) => c.type === 'summary')).toHaveLength(1)
      for (const c of chunks) {
        expect(c.text.trim()).not.toBe('')
        expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(400)
        expect(c.text).not.toMatch(/flowchart|graph TD|sequenceDiagram/)
      }
    }
  })
})
