import { useEffect, useRef, type JSX } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SigninProgress } from '@/components/signin/signin-progress'
import { useSigninRequest, type SigninMode } from '@/components/signin/signin-request'
import { useSignin } from '@/components/signin/use-signin'

const TITLE: Record<SigninMode, string> = {
  signin: 'Sign in to Google',
  switch: 'Use a different Google account',
  signout: 'Sign out of Google'
}

/**
 * The waiting state of a sign-in started from the app (11d·T1b): Chrome opens visibly for this step only. Mounted
 * once by AppShell; the run ends by itself, by Cancel, or by closing the dialog.
 */
export function SigninDialog(): JSX.Element {
  const request = useSigninRequest((s) => s.request)
  const { view, run, cancel, reset } = useSignin()
  const started = useRef(0)
  const running = view.phase === 'opening' || view.phase === 'waiting'

  function close(): void {
    if (running) cancel()
    useSigninRequest.setState({ request: null })
    reset()
  }

  function start(mode: SigninMode): void {
    void run(() =>
      mode === 'signout'
        ? window.api.account.signout()
        : window.api.account.signin({ switch: mode === 'switch' })
    ).then((outcome) => {
      if (!outcome.ok) return
      toast.success(
        mode === 'signout'
          ? 'Signed out of Google'
          : outcome.account
            ? `Signed in as ${outcome.account}`
            : 'Signed in to Google'
      )
      useSigninRequest.setState({ request: null })
      reset()
    })
  }

  useEffect(() => {
    if (!request || started.current === request.id) return
    started.current = request.id
    start(request.mode)
    // start() only uses the hook's stable functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const mode = request?.mode ?? 'signin'
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{TITLE[mode]}</DialogTitle>
          <DialogDescription>
            {mode === 'signout'
              ? 'Miss Minutes signs out of Google in its Chrome window, then closes it.'
              : 'A Google Chrome window opens for this step only. Processing pauses until you are done.'}
          </DialogDescription>
        </DialogHeader>
        <SigninProgress view={view} onCancel={close} signout={mode === 'signout'} />
        {view.phase === 'failed' && (
          <>
            <p className="text-sm text-destructive">
              {view.error === 'Cancelled' ? 'Cancelled.' : view.error}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              <Button onClick={() => start(mode)}>
                <RotateCcw /> Try again
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
