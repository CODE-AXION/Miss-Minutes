import { useState, type JSX, type ReactNode } from 'react'
import { LogIn, LogOut, RotateCcw, Trash2, UserRoundCog } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState } from '@shared/api'
import { openSignin } from '@/components/signin/signin-request'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelative } from '@/lib/format'

/** The account line: from the last sign-in plus what the worker reported since (same signals as the health card). */
function accountStatus(state: AppState): { text: string; signedIn: boolean; problem: boolean } {
  const { account, needsSignin } = state.google
  if (needsSignin || state.lastLoginRequired)
    return { text: 'Needs sign-in: your Google session expired.', signedIn: false, problem: true }
  if (account)
    return {
      text: `${account.email ? `Signed in as ${account.email}` : 'Signed in'} · checked ${formatRelative(account.checkedAt)}`,
      signedIn: true,
      problem: false
    }
  return { text: 'Not signed in', signedIn: false, problem: false }
}

/** Buttons that explain, in a tooltip, why they're disabled. */
function Gated({
  blocked,
  children
}: {
  blocked: string | null
  children: ReactNode
}): JSX.Element {
  if (!blocked) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{blocked}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Settings → Google account (11d·T1b): sign in, switch account, sign out, and reset the automation Chrome profile.
 * Each opens a visible Chrome for that step only (SigninDialog); the worker is paused meanwhile.
 */
export function GoogleAccountCard({ state }: { state: AppState }): JSX.Element {
  const [confirmReset, setConfirmReset] = useState(false)
  const status = accountStatus(state)
  const blocked =
    state.worker.state === 'busy'
      ? 'Wait until the current video finishes: its Chrome is in use.'
      : state.signinRunning
        ? 'A sign-in is already open.'
        : null

  async function resetProfile(): Promise<void> {
    setConfirmReset(false)
    try {
      await window.api.account.resetProfile()
      toast.success('Browser profile reset. Sign in again to continue.')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google account</CardTitle>
        <CardDescription>The account Miss Minutes uses in Google AI Studio.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={
              status.problem ? 'flex-1 text-sm text-destructive' : 'flex-1 text-sm font-medium'
            }
          >
            {status.text}
          </span>
          <Gated blocked={blocked}>
            <div className="flex gap-2">
              {!status.signedIn && (
                <Button size="sm" disabled={!!blocked} onClick={() => openSignin('signin')}>
                  <LogIn /> Sign in
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!!blocked}
                onClick={() => openSignin('switch')}
              >
                <UserRoundCog /> Use a different account
              </Button>
              {state.google.account && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!blocked}
                  onClick={() => openSignin('signout')}
                >
                  <LogOut /> Sign out
                </Button>
              )}
            </div>
          </Gated>
        </div>
        {state.settings.engine === 'bundled' && (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Troubleshooting
            </summary>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="flex-1 text-sm text-muted-foreground">
                Sign-in keeps failing? Start over with a fresh browser profile. You will need to
                sign in again.
              </span>
              <Gated blocked={blocked}>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!!blocked}
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw /> Reset browser profile
                </Button>
              </Gated>
            </div>
          </details>
        )}
      </CardContent>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset the browser profile?</DialogTitle>
            <DialogDescription>
              This deletes Miss Minutes&apos; own Chrome profile: its Google sign-in, cookies and
              settings. Your own Chrome and your meeting notes are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void resetProfile()}>
              <Trash2 /> Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
