import type { JSX, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { voice } from '@shared/voice'
import { HealthCard } from '@/components/health-card'
import { PathSetting, SwitchSetting } from '@/components/settings/fields'
import type { CheckState, StepProps } from '@/components/setup/types'

/** Step 6: the watch folder. */
export function RecordingsStep({ state, draft, update }: StepProps): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <p>{voice('setup.watch', state.settings.voice)}</p>
      <PathSetting
        id="setupWatchDir"
        label="Recordings folder"
        kind="folder"
        description="Recordings made in Miss Minutes are saved here. If you also use OBS, choose the folder OBS saves to. New recordings here are picked up automatically."
        value={draft.watchDir}
        error={draft.watchDir.trim() ? undefined : 'Choose a folder'}
        onChange={(watchDir) => update({ watchDir })}
      />
    </div>
  )
}

/** Step 7: autostart (openAtLogin, started hidden in the tray). */
export function StartupStep({ state, draft, update }: StepProps): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <p>{voice('setup.autostart', state.settings.voice)}</p>
      <SwitchSetting
        id="setupAutostart"
        label="Start with Windows"
        description="Miss Minutes starts quietly in the tray (next to the clock) when you sign in to Windows, so new recordings are never missed."
        checked={draft.autostart}
        onChange={(autostart) => update({ autostart })}
      />
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** Step 8: what was chosen, warnings from the last check, and the health details. */
export function DoneStep({ state, draft, check }: StepProps & { check: CheckState }): JSX.Element {
  const account = state.google.account
  const result = check.status === 'done' ? check.result : null
  const warnings = [
    result && !result.watch_dir_ok
      ? `The recordings folder ${draft.watchDir} doesn't exist yet. Miss Minutes watches it once it does.`
      : null,
    result && !result.handbrake.ok
      ? `The video compressor wasn't found (${result.handbrake.error}).`
      : null
  ].filter((w): w is string => !!w)

  return (
    <div className="flex flex-col gap-5">
      <p>{voice('setup.done', state.settings.voice)}</p>
      <dl className="flex flex-col divide-y divide-border">
        <Row label="Google account">
          {account
            ? account.email
              ? `Signed in as ${account.email}`
              : 'Signed in'
            : 'Not signed in yet (Settings → Google account)'}
        </Row>
        <Row label="Meeting notes">
          <code className="text-sm">{draft.library}</code>
          {draft.libraryInfo && (
            <span className="block text-sm text-muted-foreground">
              Existing library: {draft.libraryInfo.meetings} meetings
            </span>
          )}
        </Row>
        <Row label="Recordings folder">
          <code className="text-sm">{draft.watchDir}</code>
        </Row>
        <Row label="Smart search">
          {draft.smartSearch ? 'On: the search model downloads after you start' : 'Not now'}
        </Row>
        <Row label="Start with Windows">{draft.autostart ? 'Yes, in the tray' : 'No'}</Row>
      </dl>
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {warning}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Details</summary>
        <div className="mt-3">
          <HealthCard state={state} />
        </div>
      </details>
    </div>
  )
}
