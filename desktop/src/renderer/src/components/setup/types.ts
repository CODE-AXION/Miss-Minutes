import type { AppState, LibraryInfo } from '@shared/api'
import type { CheckResult } from '@shared/protocol'

/** The wizard's choices: local until Finish, so closing the window mid-wizard leaves nothing half-configured. */
export interface WizardDraft {
  library: string
  /** The chosen library's index.json counts when it already is a library (nothing is copied). */
  libraryInfo: LibraryInfo | null
  watchDir: string
  autostart: boolean
}

/** The engine's `check` for the current watch folder. */
export type CheckState =
  | { status: 'idle' | 'running' }
  | { status: 'done'; result: CheckResult }
  | { status: 'error'; error: string }

export interface StepProps {
  state: AppState
  draft: WizardDraft
  update(patch: Partial<WizardDraft>): void
}
