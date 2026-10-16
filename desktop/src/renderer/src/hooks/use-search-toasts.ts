import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/format'
import type { SearchStatus } from '@shared/api'
import { useApp } from '@/store'

type Smart = SearchStatus['smart']
type Phase = Smart['phase']

/** Re-runs the failed download or indexing (SS·T28, SS·T29). */
export function retrySmartSearch(): void {
  window.api.search.retry().catch((error) => toast.error(errorMessage(error)))
}

/** "Download failed: <reason>" / "Indexing failed: <reason>". */
export function smartSearchError(smart: Extract<Smart, { phase: 'error' }>): string {
  return `${smart.retry === 'download' ? 'Download' : 'Indexing'} failed: ${smart.message}`
}

/** How long the dashboard card shows the summary after a setup finished. */
const READY_MS = 5000
let readyTimer: ReturnType<typeof setTimeout> | undefined

const busy = (phase: Phase | null): boolean => phase === 'downloading' || phase === 'indexing'

/**
 * Whether smart search is being set up: a download/indexing run that started from off or an error (turning it
 * on, a resumed backfill, Retry). A run that starts from ready is a new or edited note catching up, which neither
 * the dashboard card nor a toast reports. `justReady` stays true for 5 s after a setup finished.
 */
export const useSmartSetup = create<{ settingUp: boolean; justReady: boolean }>(() => ({
  settingUp: false,
  justReady: false
}))

/**
 * Called once in AppShell, so it follows every status push on any page: keeps `useSmartSetup` current and toasts
 * when a setup finishes or anything fails (SS·T29). The first status seen never toasts: an app start with smart
 * search already ready (or already failed) stays quiet.
 */
export function useSearchToasts(): void {
  const smart = useApp((s) => s.state?.search.smart)
  const prev = useRef<Phase | null>(null)

  useEffect(() => {
    if (!smart) return
    const was = prev.current
    prev.current = smart.phase
    if (was === smart.phase) return
    const { settingUp } = useSmartSetup.getState()
    if (busy(smart.phase)) {
      if (!busy(was)) useSmartSetup.setState({ settingUp: was !== 'ready' })
      return
    }
    useSmartSetup.setState({ settingUp: false })
    if (smart.phase === 'ready' && settingUp) {
      useSmartSetup.setState({ justReady: true })
      clearTimeout(readyTimer)
      readyTimer = setTimeout(() => useSmartSetup.setState({ justReady: false }), READY_MS)
      toast.success('Smart search is ready', {
        description: `${smart.meetings} meeting${smart.meetings === 1 ? '' : 's'} indexed`
      })
    } else if (smart.phase === 'error' && was !== null)
      toast.error(`Smart search: ${smartSearchError(smart)}`, {
        action: { label: 'Retry', onClick: retrySmartSearch }
      })
  }, [smart])
}
