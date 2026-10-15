import { useEffect, useState } from 'react'
import type { LogLine } from '@shared/api'

/** Main keeps the last 5,000 lines; the renderer keeps the same window. */
const MAX_LINES = 5000

/** The worker's stderr and the app's own lines: main's buffer, then live batches. */
export function useLogLines(): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([])
  useEffect(() => {
    let live = true
    void window.api.getWorkerLog().then((initial) => live && setLines(initial))
    const off = window.api.onLog((batch) =>
      setLines((current) => [...current, ...batch].slice(-MAX_LINES))
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return lines
}
