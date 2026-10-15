import type { JSX } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, KeyRound, LogIn, PauseCircle, PlugZap, RefreshCw } from 'lucide-react'
import { voice } from '@shared/voice'
import { openSignin } from '@/components/signin/signin-request'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ClockSpinner } from '@/components/brand/clock-spinner'
import { formatDuration, fileName } from '@/lib/format'
import { runCommand, useApp } from '@/store'

/**
 * Banners above every page for states that need attention: Google sign-in, a crashed or locked worker, a paused
 * watcher, and reconnecting. Several can show at once (e.g. paused + sign-in).
 */
export function WorkerBanner(): JSX.Element | null {
  const state = useApp((s) => s.state)
  const navigate = useNavigate()
  if (!state) return null
  const { worker, lastLoginRequired, settings } = state
  const banners: JSX.Element[] = []
  // Hidden desktop (11f·T2): the worker paused itself; signing in resumes it and the waiting video goes first.
  const sessionExpired =
    (worker.paused && worker.pauseReason === 'signin') || lastLoginRequired?.hidden === true

  if (sessionExpired) {
    banners.push(
      <Alert key="login" variant="destructive" role="alert">
        <KeyRound />
        <AlertTitle>{voice('toast.sessionExpired', settings.voice)}</AlertTitle>
        <AlertDescription>
          {lastLoginRequired ? `${fileName(lastLoginRequired.key)} is waiting. ` : ''}
          Processing is paused until you sign in; it carries on by itself afterwards.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" disabled={state.signinRunning} onClick={() => openSignin('signin')}>
            <LogIn /> Sign in
          </Button>
        </AlertAction>
      </Alert>
    )
  } else if (lastLoginRequired) {
    banners.push(
      <Alert key="login" variant="destructive" role="alert">
        <KeyRound />
        <AlertTitle>{voice('toast.login', settings.voice)}</AlertTitle>
        <AlertDescription>
          Waiting up to {formatDuration(lastLoginRequired.wait_s)} for{' '}
          {fileName(lastLoginRequired.key)}. It carries on by itself once you are signed in.
        </AlertDescription>
      </Alert>
    )
  }

  if (worker.connection === 'crashed') {
    banners.push(
      <Alert key="crashed" variant="destructive" role="alert">
        <AlertTriangle />
        <AlertTitle>The worker stopped</AlertTitle>
        <AlertDescription>
          {worker.problem?.message ?? 'It exited unexpectedly.'} Nothing is processed until it runs
          again; the library below is read-only.
          {worker.problem?.lastLines && worker.problem.lastLines.length > 0 && (
            <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-xs text-foreground">
              {worker.problem.lastLines.slice(-8).join('\n')}
            </pre>
          )}
        </AlertDescription>
        <AlertAction className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate('/logs')}>
            Show log
          </Button>
          <Button size="sm" onClick={() => void window.api.app.restartWorker()}>
            <RefreshCw /> Restart
          </Button>
        </AlertAction>
      </Alert>
    )
  } else if (worker.connection === 'locked') {
    banners.push(
      <Alert key="locked" role="alert">
        <PlugZap />
        <AlertTitle>Another watcher is running</AlertTitle>
        <AlertDescription>
          {worker.problem?.message} The library below is read-only until then.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={() => void window.api.app.restartWorker()}>
            <RefreshCw /> Try again
          </Button>
        </AlertAction>
      </Alert>
    )
  } else if (worker.connection === 'reconnecting' || worker.connection === 'starting') {
    banners.push(
      <Alert key="reconnecting">
        <ClockSpinner label="" />
        <AlertTitle>
          {worker.connection === 'starting'
            ? 'Starting the worker…'
            : 'Reconnecting to the worker…'}
        </AlertTitle>
        <AlertDescription>
          The library is shown read-only meanwhile. A video that was interrupted is processed again.
        </AlertDescription>
      </Alert>
    )
  } else if (worker.paused && !sessionExpired) {
    banners.push(
      <Alert key="paused">
        <PauseCircle />
        <AlertTitle>{voice('worker.paused', settings.voice)}</AlertTitle>
        <AlertDescription>
          {worker.state === 'busy'
            ? 'The current video finishes first; no new video starts until you resume.'
            : 'No new video starts until you resume. Uploads still join the queue.'}
        </AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={() => void runCommand({ cmd: 'resume' })}>
            Resume
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (banners.length === 0) return null
  return <div className="flex flex-col gap-2 px-6 pt-4">{banners}</div>
}
