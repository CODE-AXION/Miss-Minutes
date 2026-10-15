import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { cn } from 'cn'
import type { LogLine } from '@shared/api'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

/** The `[tag]` prefixes the worker logs with (07·T6); tags seen in the lines are added to the filter too. */
const KNOWN_TAGS = [
  'error',
  'warn',
  'retry',
  'compress',
  'upload',
  'model',
  'watch',
  'chrome',
  'login',
  'resume',
  'done'
]

function tagOf(text: string): string | null {
  return /^\s*\[([a-z][\w-]*)\]/i.exec(text)?.[1].toLowerCase() ?? null
}

function toneOf(tag: string | null): string | undefined {
  if (tag === 'error') return 'text-destructive'
  if (tag === 'warn' || tag === 'retry' || tag === 'login') return 'text-warning'
  if (tag === 'done') return 'text-success'
  return undefined
}

/**
 * Monospaced log lines with a text filter, an optional `[tag]` filter and a follow (autoscroll) toggle. Used by the
 * global Logs page and the per-video Logs tab.
 */
export function LogViewer({
  lines,
  tagFilter = false,
  empty = 'No log lines yet.',
  toolbar,
  className
}: {
  lines: LogLine[]
  tagFilter?: boolean
  empty?: string
  /** Extra controls at the end of the toolbar. */
  toolbar?: ReactNode
  className?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('all')
  const [follow, setFollow] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)

  const tags = useMemo(() => {
    const seen = new Set(KNOWN_TAGS)
    for (const line of lines) {
      const t = tagOf(line.text)
      if (t) seen.add(t)
    }
    return [...seen].sort()
  }, [lines])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter(
      (l) => (!q || l.text.toLowerCase().includes(q)) && (tag === 'all' || tagOf(l.text) === tag)
    )
  }, [lines, query, tag])

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'end' })
  }, [shown, follow])

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-72"
          placeholder="Search lines"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search log lines"
        />
        {tagFilter && (
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="w-40" aria-label="Filter by tag">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t} value={t}>
                  [{t}]
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={follow} onCheckedChange={setFollow} /> Follow
        </label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {shown.length} line{shown.length === 1 ? '' : 's'}
        </span>
        {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs">
        {shown.length === 0 ? (
          <p className="text-muted-foreground">{lines.length ? 'No matching lines.' : empty}</p>
        ) : (
          shown.map((line, i) => (
            <div key={i} className="flex gap-3 break-all whitespace-pre-wrap">
              <span className="shrink-0 text-muted-foreground">{line.ts.slice(11, 19)}</span>
              <span className={line.source === 'app' ? 'text-link' : toneOf(tagOf(line.text))}>
                {line.text}
              </span>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
    </div>
  )
}
