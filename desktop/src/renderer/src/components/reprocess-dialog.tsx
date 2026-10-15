import { useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { runCommand } from '@/store'

/** Confirms a `reprocess` of a done video, optionally deleting its compressed file first. */
export function ReprocessDialog({
  open,
  onOpenChange,
  entryKey,
  hasCompressed
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryKey: string
  hasCompressed: boolean
}): JSX.Element {
  const [recompress, setRecompress] = useState(false)
  const [busy, setBusy] = useState(false)
  async function submit(): Promise<void> {
    setBusy(true)
    const ok = await runCommand(
      { cmd: 'reprocess', key: entryKey, recompress },
      'Queued for reprocessing — it goes first'
    )
    setBusy(false)
    if (ok) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reprocess this video?</DialogTitle>
          <DialogDescription>
            The notes are generated again and replace the current ones. It jumps the queue.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3">
          <Checkbox
            id="recompress"
            checked={recompress}
            onCheckedChange={(v) => setRecompress(v === true)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="recompress">Also recompress</Label>
            <p className="text-xs text-muted-foreground">
              {hasCompressed
                ? 'Deletes the existing compressed file and encodes it again with the current settings.'
                : 'There is no compressed file yet, so it is compressed either way.'}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            <RefreshCw /> Reprocess
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
