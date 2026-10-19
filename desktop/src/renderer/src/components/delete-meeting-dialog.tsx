import { useState, type JSX } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { errorMessage } from '@/lib/format'

type Choice = 'note' | 'video'

function Option({
  value,
  choice,
  onChoose,
  title,
  children
}: {
  value: Choice
  choice: Choice
  onChoose: (value: Choice) => void
  title: string
  children: string
}): JSX.Element {
  const selected = value === choice
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/60',
        selected ? 'border-destructive/60 bg-destructive/5' : 'border-border'
      )}
    >
      <input
        type="radio"
        name="deleteChoice"
        value={value}
        checked={selected}
        onChange={() => onChoose(value)}
        className="mt-0.5 size-4 shrink-0 accent-destructive"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}

/**
 * Confirms a Delete (DM·T2): the note only, or the note and the video, for one meeting or a Library selection
 * (DM·T3). Everything goes to the Recycle Bin, so it can be restored from there. Without a note (a failed or
 * archived recording) only the video can be deleted. A selection is deleted one by one; failures are reported, the
 * rest still goes.
 */
export function DeleteMeetingDialog({
  open,
  onOpenChange,
  entryKeys,
  name,
  hasNote,
  onDeleted
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryKeys: string[]
  /** One meeting's title (or file name); a selection is named by its count. */
  name: string
  /** Every one of them has a note (always true for Library rows). */
  hasNote: boolean
  /** After the deletes; `video` says whether the entries are gone, `deleted` which keys succeeded. */
  onDeleted?: (video: boolean, deleted: string[]) => void
}): JSX.Element {
  const [choice, setChoice] = useState<Choice>(hasNote ? 'note' : 'video')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const video = !hasNote || choice === 'video'
  const many = entryKeys.length > 1
  const notes = many ? 'notes' : 'note'
  const videos = many ? 'videos' : 'video'

  async function submit(): Promise<void> {
    setBusy(true)
    const deleted: string[] = []
    const failed: string[] = []
    for (const [i, key] of entryKeys.entries()) {
      setProgress(i + 1)
      try {
        await window.api.deleteMeeting(key, { video })
        deleted.push(key)
      } catch (error) {
        failed.push(errorMessage(error))
      }
    }
    setBusy(false)
    if (deleted.length > 0) {
      const what = video ? (hasNote ? `${notes} and ${videos}` : 'recording') : notes
      toast.success(
        many
          ? `${deleted.length} ${deleted.length === 1 ? 'meeting' : 'meetings'}: ${what} moved to the Recycle Bin`
          : `${what[0].toUpperCase()}${what.slice(1)} moved to the Recycle Bin`
      )
    }
    if (failed.length > 0)
      toast.error(many ? `${failed.length} could not be deleted: ${failed[0]}` : failed[0])
    if (deleted.length > 0) {
      onOpenChange(false)
      onDeleted?.(video, deleted)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {many
              ? `Delete ${entryKeys.length} meetings?`
              : hasNote
                ? 'Delete this meeting?'
                : 'Delete this recording?'}
          </DialogTitle>
          <DialogDescription className="break-words">
            <span className="font-medium text-foreground">{name}</span> — everything you delete goes
            to the Recycle Bin, so you can restore it from there.
          </DialogDescription>
        </DialogHeader>
        {hasNote ? (
          <div role="radiogroup" aria-label="What to delete" className="flex flex-col gap-2">
            <Option
              value="note"
              choice={choice}
              onChoose={setChoice}
              title={`Delete the ${notes} only`}
            >
              {many
                ? 'Keeps the recordings. They stay in the library as not processed, and you can generate notes from them again later.'
                : 'Keeps the recording. It stays in the library as not processed, and you can generate notes from it again later.'}
            </Option>
            <Option
              value="video"
              choice={choice}
              onChoose={setChoice}
              title={`Delete the ${notes} and the ${videos}`}
            >
              {many
                ? 'Also deletes the recordings and their compressed copies. The meetings disappear from the library.'
                : 'Also deletes the recording and its compressed copy. The meeting disappears from the library.'}
            </Option>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Deletes the recording and its compressed copy. It disappears from the library.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={() => void submit()}
          >
            <Trash2 />{' '}
            {busy && many
              ? `Deleting ${progress} of ${entryKeys.length}…`
              : video
                ? hasNote
                  ? `Delete ${notes} and ${videos}`
                  : 'Delete recording'
                : `Delete ${notes}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
