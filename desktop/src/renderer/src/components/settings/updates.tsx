import { useState, type JSX } from 'react'
import { RefreshCw, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState } from '@shared/api'
import { installUpdate } from '@/lib/updates'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { errorMessage, formatRelative } from '@/lib/format'

/** Settings → Updates (UP·T4): the running version, the last check, Check for updates and Restart to update. */
export function UpdateSettings({
  state,
  version
}: {
  state: AppState
  version: string
}): JSX.Element {
  const { update } = state
  const [checking, setChecking] = useState(false)

  async function check(): Promise<void> {
    setChecking(true)
    try {
      await window.api.updates.check()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setChecking(false)
    }
  }

  const status = ((): JSX.Element => {
    switch (update.phase) {
      case 'off':
        return <>Updates are checked in the installed app only (this is a development run).</>
      case 'checking':
        return <>Checking for updates…</>
      case 'downloading':
        return (
          <>
            Downloading {update.version}… {update.percent}%
          </>
        )
      case 'ready':
        return <>Version {update.version} is downloaded and ready to install.</>
      case 'idle':
        return update.error ? (
          <span className="text-destructive">Could not check for updates: {update.error}</span>
        ) : update.checkedAt ? (
          <>You have the latest version (checked {formatRelative(update.checkedAt)}).</>
        ) : (
          <>Checked automatically at startup and every few hours.</>
        )
    }
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          {version ? `Miss Minutes ${version}. ` : ''}New versions download in the background and
          install when you restart, or the next time Miss Minutes quits.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-sm text-muted-foreground">{status}</p>
        {update.phase === 'ready' ? (
          <Button className="cursor-pointer" onClick={() => void installUpdate()}>
            <RotateCw /> Restart to update
          </Button>
        ) : (
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={update.phase !== 'idle' || checking}
            onClick={() => void check()}
          >
            <RefreshCw /> Check for updates
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
