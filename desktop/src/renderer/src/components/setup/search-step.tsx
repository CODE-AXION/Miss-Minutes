import type { JSX } from 'react'
import { voice } from '@shared/voice'
import { Choice } from '@/components/setup/library-step'
import type { StepProps } from '@/components/setup/types'

/** Step 5 (SS·T25): the smart search opt-in, "Not now" preselected. Nothing downloads until Start. */
export function SearchStep({ state, draft, update }: StepProps): JSX.Element {
  const meetings = draft.libraryInfo?.meetings ?? 0
  return (
    <div className="flex flex-col gap-4">
      <p>{voice('setup.search', state.settings.voice)}</p>
      <div role="radiogroup" aria-label="Smart search" className="flex flex-col gap-2">
        <Choice
          selected={draft.smartSearch}
          onSelect={() => update({ smartSearch: true })}
          title="Turn on smart search"
        >
          <span className="text-sm text-muted-foreground">
            Find things by meaning, e.g. &ldquo;when did we agree to drop the manual approval
            step?&rdquo;. Downloads a 207 MB search model once; everything stays on this computer.
          </span>
          {meetings > 0 && (
            <span className="text-sm text-muted-foreground">
              Your {meetings} meeting{meetings === 1 ? '' : 's'} will be indexed in the background
              (about 2 seconds each).
            </span>
          )}
        </Choice>
        <Choice
          selected={!draft.smartSearch}
          onSelect={() => update({ smartSearch: false })}
          title="Not now"
        >
          <span className="text-sm text-muted-foreground">
            You can turn it on any time in Settings → Smart search.
          </span>
        </Choice>
      </div>
      <p className="text-sm text-muted-foreground">
        Searching inside your notes by keyword works either way.
      </p>
    </div>
  )
}
