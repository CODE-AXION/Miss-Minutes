import { useState, type JSX, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { cn } from 'cn'
import type { LibraryInfo } from '@shared/api'
import { voice } from '@shared/voice'
import type { StepProps } from '@/components/setup/types'
import { Button } from '@/components/ui/button'

export interface LibraryOptions {
  newLibrary: string
  /** Its counts when the new-library folder already holds a library (a reinstall). */
  newInfo: LibraryInfo | null
  /** The old project library, offered preselected when there is one. */
  found: LibraryInfo | null
}

const meetings = (info: LibraryInfo): string =>
  `${info.meetings} meeting${info.meetings === 1 ? '' : 's'}`

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function Choice({
  selected,
  onSelect,
  title,
  path,
  children
}: {
  selected: boolean
  onSelect: () => void
  title: string
  path?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-md border-2 p-3 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
      )}
    >
      <span
        className={cn(
          'mt-1 size-4 shrink-0 rounded-full border-2',
          selected
            ? 'border-primary bg-primary shadow-[inset_0_0_0_2px_var(--card)]'
            : 'border-border'
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {path && <code className="truncate text-xs text-muted-foreground">{path}</code>}
        {children}
      </span>
    </button>
  )
}

/**
 * Step 4: where the notes go. A new library, the old project library when there is one (used in place: nothing is
 * copied), or any other existing library folder (it must have an index.json).
 */
export function LibraryStep({
  state,
  draft,
  update,
  options
}: StepProps & { options: LibraryOptions | null }): JSX.Element {
  const [other, setOther] = useState<LibraryInfo | null>(() =>
    draft.libraryInfo &&
    options &&
    !same(draft.library, options.newLibrary) &&
    !same(draft.library, options.found?.path ?? '')
      ? draft.libraryInfo
      : null
  )
  const [otherError, setOtherError] = useState<string | null>(null)

  async function pickOther(): Promise<void> {
    const folder = await window.api.pickFolder()
    if (!folder) return
    const info = await window.api.setup.inspectLibrary(folder)
    if (!info) {
      setOtherError(
        `${folder} isn't a Miss Minutes library. Choose the folder that holds your notes and index.json.`
      )
      return
    }
    setOtherError(null)
    setOther(info)
    update({ library: info.path, libraryInfo: info })
  }

  if (!options) return <p className="text-muted-foreground">Looking for an existing library…</p>
  const { found, newLibrary, newInfo } = options

  return (
    <div className="flex flex-col gap-4">
      <p>{voice('setup.library', state.settings.voice)}</p>
      <div role="radiogroup" aria-label="Library" className="flex flex-col gap-2">
        {found && !same(found.path, newLibrary) && (
          <Choice
            selected={same(draft.library, found.path)}
            onSelect={() => update({ library: found.path, libraryInfo: found })}
            title={`We found your existing library (${meetings(found)})`}
            path={found.path}
          >
            <span className="text-sm text-muted-foreground">
              Miss Minutes uses it where it is. Nothing is copied.
            </span>
          </Choice>
        )}
        <Choice
          selected={same(draft.library, newLibrary)}
          onSelect={() => update({ library: newLibrary, libraryInfo: newInfo })}
          title={
            newInfo
              ? `Your library in Documents (${meetings(newInfo)})`
              : 'A new library in Documents'
          }
          path={newLibrary}
        />
        <Choice
          selected={!!other && same(draft.library, other.path)}
          onSelect={() =>
            other ? update({ library: other.path, libraryInfo: other }) : void pickOther()
          }
          title={other ? `Another library (${meetings(other)})` : 'Use an existing library…'}
          path={other?.path}
        />
      </div>
      {other && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void pickOther()}>
          <FolderOpen /> Choose a different folder
        </Button>
      )}
      {otherError && <p className="text-sm text-destructive">{otherError}</p>}
    </div>
  )
}
