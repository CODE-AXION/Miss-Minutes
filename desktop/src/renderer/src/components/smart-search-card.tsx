import type { JSX } from 'react'
import { Link } from 'react-router'
import { RotateCcw } from 'lucide-react'
import type { AppState, SearchStatus } from '@shared/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { retrySmartSearch, smartSearchError, useSmartSetup } from '@/hooks/use-search-toasts'
import { megabytes } from '@/lib/format'

type Smart = SearchStatus['smart']

const percent = (done: number, total: number): number =>
  total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

/**
 * The download or indexing bar with its caption ("85 / 207 MB · 41%", "12 / 27 meetings"); nothing in other
 * phases. Shared by the dashboard card and Settings → Smart search (SS·T26, SS·T28).
 */
export function SmartSearchProgress({ smart }: { smart: Smart }): JSX.Element | null {
  if (smart.phase === 'downloading') {
    const pct = percent(smart.bytes, smart.total)
    return (
      <div className="flex flex-col gap-1.5">
        <Progress value={pct} aria-label="Downloading the search model" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {megabytes(smart.bytes)} / {megabytes(smart.total)} MB · {pct}%
        </span>
      </div>
    )
  }
  if (smart.phase === 'indexing')
    return (
      <div className="flex flex-col gap-1.5">
        <Progress value={percent(smart.done, smart.total)} aria-label="Indexing meetings" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {smart.done} / {smart.total} meetings
        </span>
      </div>
    )
  return null
}

/**
 * Dashboard progress card (SS·T28): shows the background download and indexing after the user turned smart search
 * on, so it never runs invisibly, and failures with Retry. Hidden when off, when it was already ready at app start,
 * and while a new note catches up (`useSmartSetup`); a finished setup shows the summary for 5 s.
 */
export function SmartSearchCard({ state }: { state: AppState }): JSX.Element | null {
  const smart = state.search.smart
  const { settingUp, justReady } = useSmartSetup()

  if (
    smart.phase === 'off' ||
    (smart.phase === 'ready' && !justReady) ||
    (smart.phase === 'indexing' && !settingUp)
  )
    return null

  if (smart.phase === 'ready')
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            Smart search is ready · {smart.meetings} meetings · {state.search.keyword.passages}{' '}
            passages
          </CardTitle>
        </CardHeader>
      </Card>
    )

  if (smart.phase === 'error')
    return (
      <Card>
        <CardHeader>
          <CardTitle>Smart search</CardTitle>
          <CardDescription className="text-destructive">{smartSearchError(smart)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={retrySmartSearch}>
            <RotateCcw /> Retry
          </Button>
          <Link to="/settings" className="text-sm underline underline-offset-2">
            Settings → Smart search
          </Link>
        </CardContent>
      </Card>
    )

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {smart.phase === 'downloading'
            ? 'Setting up smart search — downloading the search model'
            : `Indexing your meetings — ${smart.done} / ${smart.total}`}
        </CardTitle>
        {smart.phase === 'indexing' && (
          <CardDescription>Keyword search works meanwhile.</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <SmartSearchProgress smart={smart} />
      </CardContent>
    </Card>
  )
}
