import { useState, type JSX } from 'react'
import { Download, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { installUpdate } from '@/lib/updates'
import { useApp } from '@/store'

/**
 * In the header (UP·T4): a quiet "Downloading update" while one comes in, then "Update 1.4.0 ready · Restart". It
 * also installs by itself the next time the app quits, so ignoring it is fine.
 */
export function UpdateNotice(): JSX.Element | null {
  const update = useApp((s) => s.state?.update)
  const [busy, setBusy] = useState(false)
  if (update?.phase === 'downloading')
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Download className="size-3.5" /> Downloading update {update.version} · {update.percent}%
      </span>
    )
  if (update?.phase !== 'ready') return null
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 cursor-pointer rounded-full border-success/50 px-3 text-success hover:text-success"
      title="Installs the new version and reopens Miss Minutes"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await installUpdate()
        setBusy(false)
      }}
    >
      <RotateCw /> Update {update.version} ready · Restart
    </Button>
  )
}
