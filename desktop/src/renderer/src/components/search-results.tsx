import { useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { format } from 'date-fns'
import type { SearchHit } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { Badge } from '@/components/ui/badge'
import { PosterPanel } from '@/components/brand/poster-panel'
import { fileName, parseTs } from '@/lib/format'
import { groupHits, hitPath, snippet, TYPE_LABEL } from '@/lib/search'

function Snippet({ hit }: { hit: SearchHit }): JSX.Element {
  return (
    <span className="line-clamp-3 text-sm">
      {snippet(hit.text, hit.highlights).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-sm bg-accent/40 px-0.5 text-inherit">
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </span>
  )
}

/**
 * Passages grouped by meeting (SS·T23), in the order main ranked them. Each passage is a link that opens the note
 * at its section; ↑/↓ move between them (roving tabindex) and Enter opens one.
 */
export function SearchResults({
  hits,
  entries,
  usedSmart,
  ms,
  smartOff
}: {
  hits: SearchHit[]
  entries: Record<string, VideoEntry>
  usedSmart: boolean
  ms: number
  /** Smart search is turned off: the empty state suggests it. */
  smartOff: boolean
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  if (hits.length === 0) {
    return (
      <PosterPanel pose="point">
        No passages match.
        {smartOff && (
          <span className="mt-1 block text-sm text-muted-foreground">
            Turn on smart search in Settings to also find matches by meaning.
          </span>
        )}
      </PosterPanel>
    )
  }

  const groups = groupHits(hits)
  const order = groups.flatMap(([, items]) => items)
  const current = Math.min(active, order.length - 1)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = Math.max(0, Math.min(order.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))
    setActive(next)
    list.current?.querySelectorAll<HTMLElement>('[data-passage]')[next]?.focus()
  }

  return (
    <div className="flex flex-col gap-4">
      <div ref={list} className="flex flex-col gap-4" onKeyDown={onKeyDown}>
        {groups.map(([key, items]) => {
          const entry = entries[key]
          const date = parseTs(entry?.recorded)
          return (
            <section key={key} className="flex flex-col gap-1.5" aria-label={entry?.title}>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-medium">{entry?.title ?? fileName(key)}</h2>
                {date && (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {format(date, 'd MMM yyyy')}
                  </span>
                )}
                {entry?.category && <Badge variant="secondary">{entry.category}</Badge>}
              </div>
              <ul className="flex flex-col gap-1">
                {items.map((hit) => {
                  const index = order.indexOf(hit)
                  return (
                    <li key={hit.chunkId}>
                      <Link
                        to={hitPath(hit)}
                        data-passage
                        tabIndex={index === current ? 0 : -1}
                        onFocus={() => setActive(index)}
                        className="flex flex-col gap-1 rounded-md border px-3 py-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="flex flex-wrap items-center gap-1.5 text-xs">
                          <Badge variant="outline">{TYPE_LABEL[hit.type]}</Badge>
                          {hit.ts && (
                            <span className="font-mono text-muted-foreground">[{hit.ts}]</span>
                          )}
                          <span className="text-muted-foreground">{hit.section}</span>
                        </span>
                        <Snippet hit={hit} />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {hits.length} passage{hits.length === 1 ? '' : 's'} in {groups.length} meeting
        {groups.length === 1 ? '' : 's'} · {usedSmart ? 'smart' : 'keyword'} · {ms} ms
      </p>
    </div>
  )
}
