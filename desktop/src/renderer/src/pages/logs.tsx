import type { JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LogViewer } from '@/components/log-viewer'
import { useLogLines } from '@/hooks/use-log-lines'

/** The worker's stderr and the app's own lines, live (main keeps the last 5,000), filterable by `[tag]` (07·T6). */
export function LogsPage(): JSX.Element {
  const lines = useLogLines()
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="font-display text-2xl">Logs</h1>
      <LogViewer
        className="flex-1"
        lines={lines}
        tagFilter
        toolbar={
          <Button variant="outline" size="sm" onClick={() => void window.api.openPath('library')}>
            <FolderOpen /> Open library folder
          </Button>
        }
      />
    </div>
  )
}
