import type { JSX } from 'react'
import { X } from 'lucide-react'
import { ClockSpinner } from '@/components/brand/clock-spinner'
import { Button } from '@/components/ui/button'
import type { SigninView } from '@/components/signin/use-signin'
import { formatClock } from '@/lib/format'
import { useNow } from '@/store'

/**
 * A running sign-in (11d): "switch to the Chrome window" copy, the login-wait countdown and Cancel. Chrome is never
 * embedded: the user signs in in the real Chrome window the engine opened.
 */
export function SigninProgress({
  view,
  onCancel,
  signout = false
}: {
  view: SigninView
  onCancel: () => void
  signout?: boolean
}): JSX.Element | null {
  const now = useNow()
  if (view.phase !== 'opening' && view.phase !== 'waiting') return null
  const left = view.deadline ? (view.deadline - now) / 1000 : null
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted/50 p-3">
      <ClockSpinner size={20} label="" className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {view.phase === 'opening' ? (
          <span className="font-medium">
            {signout ? 'Signing out in Chrome…' : 'Opening Google Chrome…'}
          </span>
        ) : (
          <>
            <span className="font-medium">
              Sign in to Google in the Chrome window that just opened.
            </span>
            <span className="text-sm text-muted-foreground">
              Waiting for you to sign in…
              {left !== null && left > 0 && ` ${formatClock(left)} left`}
            </span>
          </>
        )}
        <span className="text-xs text-muted-foreground">
          Don&apos;t see it? Look for Google Chrome in the taskbar.
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={onCancel}>
        <X /> Cancel
      </Button>
    </div>
  )
}
