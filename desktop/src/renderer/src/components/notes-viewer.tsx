import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MermaidBlock } from '@/components/mermaid-block'
import { VideoPanel, type Jump } from '@/components/video-panel'
import { formatClock } from '@/lib/format'
import { copyText } from '@/store'
import { slug } from '@shared/slug'
import { splitRun, TIMESTAMP } from '@shared/timestamps'

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
// Each clock inside the mark is a <button class="note-ts-jump" data-t="<seconds>"> (NV·T9); the visible text is unchanged.

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

/** hast children of a timestamp mark: its clocks as jump buttons, brackets and separators as plain text. */
function jumpButtons(run: string): HastNode[] {
  return splitRun(run).map(({ text, seconds }) =>
    seconds === null
      ? { type: 'text', value: text }
      : {
          type: 'element',
          tagName: 'button',
          properties: {
            type: 'button',
            className: ['note-ts-jump'],
            dataT: String(seconds),
            ariaLabel: `Play video at ${formatClock(seconds)}`
          },
          children: [{ type: 'text', value: text }]
        }
  )
}

/** `buttons` is false inside links, where a <button> would be nested interactive content. */
function splitTimestamps(node: MdNode, buttons: boolean): MdNode[] {
  const value = node.value ?? ''
  const parts: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(TIMESTAMP)) {
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) })
    parts.push({
      type: 'text',
      value: match[0],
      data: {
        hName: 'mark',
        hProperties: { className: ['note-ts'] },
        ...(buttons && { hChildren: jumpButtons(match[0]) })
      }
    })
    last = match.index + match[0].length
  }
  if (parts.length === 0) return [node]
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

function wrapTimestamps(node: MdNode, inLink = false): void {
  if (!node.children) return
  const link = inLink || node.type === 'link' || node.type === 'linkReference'
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitTimestamps(child, !link)
    wrapTimestamps(child, link)
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
  properties?: { className?: unknown } & Record<string, unknown>
  children?: HastNode[]
}

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
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
 * style, no scanlines, so long documents stay readable. Each clock in a timestamp is a button; one delegated click
 * handler on the article reports it (NV·T10). Timestamps are buttons that open the docked video panel at that
 * moment (NV·T12); it takes the Contents column's place while open.
 */
export function NotesViewer({
  entryKey,
  notes,
  version,
  focusSection,
  playable
}: {
  entryKey: string
  /** The entry's `notes` path (relative to the library). */
  notes: string
  /** Changes when the note may have changed on disk (the entry's `updated`), to read it again. */
  version: string | undefined
  /** Heading id to open at (`?section=` from a search result, SS·T24); unknown ids leave the note at the top. */
  focusSection?: string | null
  /** The entry is `done`: when it stops being so (reprocess), the video panel closes and releases the file. */
  playable: boolean
}): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const article = useRef<HTMLElement>(null)
  // The docked video panel (NV·T12): null is closed; the nonce makes a repeat click on one timestamp seek again.
  const [jump, setJump] = useState<Jump | null>(null)
  const onJump = (seconds: number): void =>
    setJump((j) => ({ seconds, nonce: (j?.nonce ?? 0) + 1 }))
  const closeVideo = useCallback(() => setJump(null), [])

  // Reprocess (the entry leaves `done`) or a rewritten note (a new `version`) closes the panel; adjusted while
  // rendering rather than in an effect, so the stale panel never paints.
  const [seen, setSeen] = useState({ playable, version })
  if (seen.playable !== playable || seen.version !== version) {
    setSeen({ playable, version })
    if (!playable || seen.version !== version) setJump(null)
  }

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

  // Open at the searched section once, with a short flash; a later re-read of the note does not jump again.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    const root = article.current
    if (!focusSection || focused.current === focusSection || !root) return
    const heading = root.querySelector<HTMLHeadingElement>(`h2[id="${CSS.escape(focusSection)}"]`)
    if (!heading) return
    // Mermaid diagrams above the section render after this and push it down: keep it aligned while the layout
    // settles, until the user scrolls or presses a key.
    const align = (): void => heading.scrollIntoView({ block: 'start' })
    const resize = new ResizeObserver(align)
    const stop = (): void => resize.disconnect()
    const USER = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
    align()
    resize.observe(root)
    for (const name of USER) window.addEventListener(name, stop, { passive: true })
    heading.classList.add('note-flash')
    const timer = setTimeout(() => {
      focused.current = focusSection
      stop()
    }, 2000)
    return () => {
      clearTimeout(timer)
      stop()
      for (const name of USER) window.removeEventListener(name, stop)
      heading.classList.remove('note-flash')
    }
  }, [text, focusSection])

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
      <article
        ref={article}
        className="note-markdown"
        onClick={(e) => {
          const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button.note-ts-jump')
          if (!button) return
          const t = Number(button.dataset.t)
          if (Number.isFinite(t)) onJump(t)
        }}
      >
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
      {jump ? (
        <VideoPanel entryKey={entryKey} version={version} jump={jump} onClose={closeVideo} />
      ) : (
        toc.length > 0 && (
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
        )
      )}
    </div>
  )
}
