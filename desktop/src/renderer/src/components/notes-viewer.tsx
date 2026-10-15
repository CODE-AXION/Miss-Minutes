import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MermaidBlock } from '@/components/mermaid-block'
import { copyText } from '@/store'

/**
 * The note without its YAML front matter (already shown in the page header) and leading `# Title` line. Line endings
 * are normalised first: notes saved so far end their lines in "\r\r\n", which Markdown reads as two line breaks
 * (that splits every table and list).
 */
function noteBody(text: string): string {
  return text
    .replace(/\r+\n?/g, '\n')
    .replace(/^\s*---\n[\s\S]*?\n---\n/, '') // \s also matches a BOM
    .replace(/^\s*# .*\n/, '')
    .trimStart()
}

// --- [MM:SS] timestamps: a tiny remark plugin that wraps them in <mark class="note-ts"> ----------------------

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

/** "[36:15]", "[1:02:03]", "[38:40, 39:37]". */
const TIMESTAMP = /\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,–-]\s*\d{1,2}:\d{2}(?::\d{2})?)*\]/g

function splitTimestamps(node: MdNode): MdNode[] {
  const value = node.value ?? ''
  const parts: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(TIMESTAMP)) {
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) })
    parts.push({
      type: 'text',
      value: match[0],
      data: { hName: 'mark', hProperties: { className: ['note-ts'] } }
    })
    last = match.index + match[0].length
  }
  if (parts.length === 0) return [node]
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

function wrapTimestamps(node: MdNode): void {
  if (!node.children) return
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitTimestamps(child)
    wrapTimestamps(child)
    return [child]
  })
}

function remarkTimestamps() {
  return (tree: MdNode): void => wrapTimestamps(tree)
}

// --- Rendering ------------------------------------------------------------------------------

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function slug(text: string): string {
  return (
    'h-' +
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  )
}

function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const COMPONENTS: Components = {
  h2: ({ node, children }) => <h2 id={slug(hastText(node as HastNode))}>{children}</h2>,
  pre: ({ node, children }) => {
    const code = (node as HastNode | undefined)?.children?.[0]
    const classes = code?.tagName === 'code' ? code.properties?.className : undefined
    if (Array.isArray(classes) && classes.includes('language-mermaid')) {
      return <MermaidBlock code={hastText(code).trimEnd()} />
    }
    return <pre>{children}</pre>
  },
  table: ({ children }) => (
    <div className="note-table">
      <table>{children}</table>
    </div>
  ),
  // Web links open in the browser (main's window-open handler); in-page anchors scroll; nothing navigates the app.
  a: ({ href, children }) => {
    if (href && /^https?:\/\//i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    }
    if (href?.startsWith('#')) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault()
            scrollToId(slug(decodeURIComponent(href.slice(1))))
          }}
        >
          {children}
        </a>
      )
    }
    return <span>{children}</span>
  }
}

interface TocItem {
  id: string
  text: string
}

/**
 * The note of a done video (07·T3): front matter stripped, GFM tables, Mermaid diagrams, highlighted [MM:SS]
 * timestamps and a table of contents from the `##` headings. No raw HTML (react-markdown's default). Plain card
 * style, no scanlines, so long documents stay readable.
 */
export function NotesViewer({
  entryKey,
  notes,
  version
}: {
  entryKey: string
  /** The entry's `notes` path (relative to the library). */
  notes: string
  /** Changes when the note may have changed on disk (the entry's `updated`), to read it again. */
  version: string | undefined
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const article = useRef<HTMLElement>(null)

  useEffect(() => {
    let live = true
    window.api.readNote(notes).then(
      (raw) => {
        if (!live) return
        setText(noteBody(raw))
        setError(null)
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [notes, version])

  // The table of contents comes from the rendered headings, so its ids always match.
  useEffect(() => {
    const headings = article.current?.querySelectorAll<HTMLHeadingElement>('h2[id]') ?? []
    setToc([...headings].map((h) => ({ id: h.id, text: h.textContent ?? '' })))
  }, [text])

  let body: ReactNode
  if (error) body = <p className="text-sm text-destructive">Could not read the note: {error}</p>
  else if (text === null)
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    )
  else
    body = (
      <article ref={article} className="note-markdown">
        <Markdown remarkPlugins={[remarkGfm, remarkTimestamps]} components={COMPONENTS}>
          {text}
        </Markdown>
      </article>
    )

  return (
    <div className="flex items-start gap-6">
      <Card className="min-w-0 flex-1">
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 [&>button]:shrink-0">
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={notes}
            >
              {notes}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.api.openPath('note', entryKey)}
            >
              <ExternalLink /> Open in editor
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={text === null}
              onClick={() => text !== null && copyText(text)}
            >
              <Copy /> Copy markdown
            </Button>
          </div>
          {body}
        </CardContent>
      </Card>
      {toc.length > 0 && (
        <nav
          aria-label="Contents"
          className="sticky top-0 hidden w-56 shrink-0 flex-col gap-1 text-sm xl:flex"
        >
          <span className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">
            Contents
          </span>
          {toc.map((item) => (
            <button
              key={item.id}
              type="button"
              className="truncate rounded px-2 py-1 text-left hover:bg-muted"
              title={item.text}
              onClick={() => scrollToId(item.id)}
            >
              {item.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
