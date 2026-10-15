import { useState, type FormEvent, type JSX } from 'react'
import type { VideoEntry } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TagInput } from '@/components/tag-input'
import { runCommand } from '@/store'

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

function EditForm({
  entryKey,
  entry,
  categories,
  knownTags,
  onDone
}: {
  entryKey: string
  entry: VideoEntry
  categories: Record<string, string>
  knownTags: string[]
  onDone: () => void
}): JSX.Element {
  const [title, setTitle] = useState(entry.title ?? '')
  const [category, setCategory] = useState(entry.category ?? '')
  const [tags, setTags] = useState<string[]>(entry.tags ?? [])
  const [saving, setSaving] = useState(false)

  const trimmed = title.trim()
  const changed =
    trimmed !== (entry.title ?? '') ||
    category !== (entry.category ?? '') ||
    !sameTags(tags, entry.tags ?? [])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!trimmed || !changed) return
    setSaving(true)
    const moved = category !== entry.category
    const ok = await runCommand(
      { cmd: 'edit', key: entryKey, title: trimmed, category, tags },
      moved ? `Saved — note moved to notes/${category}/` : 'Saved'
    )
    setSaving(false)
    if (ok) onDone()
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-title">Title</FieldLabel>
          <Input
            id="edit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={!trimmed}
            autoFocus
          />
          {!trimmed && <FieldDescription>The title cannot be empty.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-category">Category</FieldLabel>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id="edit-category" className="w-full">
              <SelectValue placeholder="Choose a category">{category}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(categories).map(([id, description]) => (
                <SelectItem key={id} value={id}>
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="font-medium">{id}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Changing it moves the note to notes/{category || '…'}/.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-tags">Tags</FieldLabel>
          <TagInput id="edit-tags" value={tags} onChange={setTags} suggestions={knownTags} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmed || !changed || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * Edit the title, category and tags of a done video (07·T4). Sends the `edit` command; the worker moves/renames the
 * note, rewrites its front matter and updates index.json + INDEX.md, and the page updates from the `video` event.
 */
export function EditMetaDialog({
  open,
  onOpenChange,
  entryKey,
  entry,
  categories,
  knownTags
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryKey: string
  entry: VideoEntry
  /** hello.categories: id -> description. */
  categories: Record<string, string>
  /** hello.suggested_tags plus every tag already used in the library. */
  knownTags: string[]
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit details</DialogTitle>
          <DialogDescription>Updates the note, its front matter and the index.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so it starts from the current values every time. */}
        {open && (
          <EditForm
            entryKey={entryKey}
            entry={entry}
            categories={categories}
            knownTags={knownTags}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
