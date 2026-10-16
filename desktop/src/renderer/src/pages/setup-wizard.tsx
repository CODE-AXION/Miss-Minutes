import { useCallback, useEffect, useState, type JSX } from 'react'
import { ArrowLeft, ArrowRight, Play } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState } from '@shared/api'
import { ChromeStep } from '@/components/setup/chrome-step'
import { LibraryStep, type LibraryOptions } from '@/components/setup/library-step'
import { SearchStep } from '@/components/setup/search-step'
import { DoneStep, RecordingsStep, StartupStep } from '@/components/setup/simple-steps'
import { SigninStep } from '@/components/setup/signin-step'
import { StepIndicator } from '@/components/setup/step-indicator'
import type { CheckState, StepProps, WizardDraft } from '@/components/setup/types'
import { WelcomeStep } from '@/components/setup/welcome-step'
import { useSignin } from '@/components/signin/use-signin'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { errorMessage } from '@/lib/format'

const STEPS = [
  'Welcome',
  'Google Chrome',
  'Sign in to Google',
  'Meeting notes',
  'Smart search',
  'Recordings',
  'Start with Windows',
  'Done'
] as const
const CHROME = 1
const SIGNIN = 2
const LIBRARY = 3
const SEARCH = 4
const RECORDINGS = 5
const DONE = STEPS.length - 1

/**
 * First-run wizard (11d): shown instead of the app while `state.setupNeeded`. Plain language only; technical
 * details sit behind "Details". The choices stay local until Start (setup.finish), which saves them, starts the
 * worker and so turns `setupNeeded` off: the dashboard then replaces the wizard.
 */
export function SetupWizard({ state }: { state: AppState }): JSX.Element {
  const { settings, engineProblem } = state
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>(() => ({
    library: settings.library,
    libraryInfo: null,
    watchDir: settings.watchDir,
    autostart: settings.openAtLogin,
    smartSearch: settings.smartSearch
  }))
  const [options, setOptions] = useState<LibraryOptions | null>(null)
  const [check, setCheck] = useState<CheckState>({ status: 'idle' })
  const [checkedKey, setCheckedKey] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const signin = useSignin()
  const signingIn = signin.view.phase === 'opening' || signin.view.phase === 'waiting'

  const checkKey = (watchDir: string): string =>
    [settings.engine, settings.projectRoot, watchDir].join('|')

  const update = useCallback(
    (patch: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...patch })),
    []
  )

  // The library choices, once: the old project library is preselected when there is one.
  useEffect(() => {
    let live = true
    void (async () => {
      const { newLibrary, found } = await window.api.setup.libraryOptions()
      const newInfo = await window.api.setup.inspectLibrary(newLibrary)
      if (!live) return
      setOptions({ newLibrary, newInfo, found })
      const pick = found ?? newInfo
      update({ library: pick?.path ?? newLibrary, libraryInfo: pick })
    })().catch((error) => toast.error(errorMessage(error)))
    return () => {
      live = false
    }
  }, [update])

  async function runCheck(watchDir: string): Promise<void> {
    const key = checkKey(watchDir)
    setCheck({ status: 'running' })
    setCheckedKey(key)
    try {
      setCheck({ status: 'done', result: await window.api.setup.check(watchDir) })
    } catch (error) {
      setCheck({ status: 'error', error: errorMessage(error) })
    }
  }

  /**
   * Moves to a step. The Chrome step checks on arrival, and the Done step checks again, whenever the recordings
   * folder or the engine (the developer switch) changed since the last check.
   */
  function goTo(next: number): void {
    setStep(next)
    const stale = checkedKey !== checkKey(draft.watchDir) || check.status === 'error'
    if ((next === CHROME || next === DONE) && stale && check.status !== 'running' && !engineProblem)
      void runCheck(draft.watchDir)
  }

  const canNext = ((): boolean => {
    switch (step) {
      case 0:
        return !engineProblem
      case CHROME:
        return check.status === 'done' && check.result.chrome.ok
      case SIGNIN:
        return !signingIn
      case LIBRARY:
        return !!options && !!draft.library
      case SEARCH:
        return true
      case RECORDINGS:
        return !!draft.watchDir.trim()
      default:
        return true
    }
  })()

  async function finish(): Promise<void> {
    setFinishing(true)
    try {
      await window.api.setup.finish({
        library: draft.library,
        watchDir: draft.watchDir.trim(),
        openAtLogin: draft.autostart,
        smartSearch: draft.smartSearch
      })
    } catch (error) {
      toast.error(errorMessage(error))
      setFinishing(false)
    }
  }

  const props: StepProps = { state, draft, update }
  const body = [
    <WelcomeStep key="welcome" {...props} />,
    <ChromeStep
      key="chrome"
      {...props}
      check={check}
      onCheck={() => void runCheck(draft.watchDir)}
    />,
    <SigninStep key="signin" {...props} check={check} signin={signin} />,
    <LibraryStep key="library" {...props} options={options} />,
    <SearchStep key="search" {...props} />,
    <RecordingsStep key="recordings" {...props} />,
    <StartupStep key="startup" {...props} />,
    <DoneStep key="done" {...props} check={check} />
  ][step]

  return (
    <div className="retro-grid h-screen overflow-auto p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <h1 className="wordmark text-lg">Miss Minutes · First-time setup</h1>
        <StepIndicator steps={STEPS} current={step} />
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-xl">{STEPS[step]}</CardTitle>
          </CardHeader>
          <CardContent>{body}</CardContent>
        </Card>
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            disabled={step === 0 || signingIn || finishing}
            onClick={() => goTo(step - 1)}
          >
            <ArrowLeft /> Back
          </Button>
          {step < DONE ? (
            <Button disabled={!canNext} onClick={() => goTo(step + 1)}>
              {step === SIGNIN && !state.google.account ? 'Skip for now' : 'Next'} <ArrowRight />
            </Button>
          ) : (
            <Button disabled={finishing || !!engineProblem} onClick={() => void finish()}>
              <Play /> Start Miss Minutes
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
