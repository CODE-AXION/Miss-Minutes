import type { JSX } from 'react'
import { CheckCircle2, LogIn, RotateCcw, UserRoundCog } from 'lucide-react'
import { voice } from '@shared/voice'
import { SigninProgress } from '@/components/signin/signin-progress'
import type { useSignin } from '@/components/signin/use-signin'
import type { CheckState, StepProps } from '@/components/setup/types'
import { Button } from '@/components/ui/button'

/**
 * Step 3 (optional): Google sign-in in a visible Chrome window, the only time the user sees Chrome (processing
 * runs on a hidden desktop). Skipping never blocks Finish: Miss Minutes asks again when it first needs the account.
 */
export function SigninStep({
  state,
  check,
  signin
}: StepProps & { check: CheckState; signin: ReturnType<typeof useSignin> }): JSX.Element {
  const { view, run, cancel } = signin
  const account = state.google.account
  const running = view.phase === 'opening' || view.phase === 'waiting'
  const hint = check.status === 'done' && check.result.signed_in_hint

  const start = (switchAccount: boolean): void =>
    void run(() => window.api.setup.signin({ switch: switchAccount }))

  return (
    <div className="flex flex-col gap-5">
      <p>{voice('setup.signin', state.settings.voice)}</p>

      {running ? (
        <SigninProgress view={view} onCancel={cancel} />
      ) : account ? (
        <div className="flex flex-wrap items-center gap-3">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          <span className="flex-1 font-medium">
            {account.email ? `Signed in as ${account.email}` : 'Signed in to Google'}
          </span>
          <Button variant="outline" onClick={() => start(true)}>
            <UserRoundCog /> Use a different account
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {hint
              ? 'You may already be signed in. Click Sign in to check: a Chrome window opens for a moment.'
              : 'A Google Chrome window opens. Sign in there, and Miss Minutes picks it up by itself.'}
          </p>
          {view.phase === 'failed' && (
            <p className="text-sm text-destructive">
              {view.error === 'Cancelled' ? 'Sign-in cancelled.' : view.error}
            </p>
          )}
          <Button className="self-start" onClick={() => start(false)}>
            {view.phase === 'failed' ? <RotateCcw /> : <LogIn />}
            {view.phase === 'failed' ? 'Try again' : 'Sign in'}
          </Button>
        </div>
      )}

      {!account && (
        <p className="text-sm text-muted-foreground">
          Not now? Choose <strong>Skip for now</strong>. You can sign in later in Settings → Google
          account. Miss Minutes will also ask when it first needs it.
        </p>
      )}
    </div>
  )
}
