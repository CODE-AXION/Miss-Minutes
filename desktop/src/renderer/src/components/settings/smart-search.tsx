import { useState, type JSX } from 'react'
import { RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState } from '@shared/api'
import { voice } from '@shared/voice'
import { SwitchSetting } from '@/components/settings/fields'
import { SmartSearchProgress } from '@/components/smart-search-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { retrySmartSearch, smartSearchError } from '@/hooks/use-search-toasts'
import { errorMessage, megabytes } from '@/lib/format'

/**
 * Settings → Smart search (SS·T26): on/off, download and indexing progress, Retry, Rebuild, and deleting the
 * downloaded files. Unlike the other sections it acts at once (`search.setEnabled`), outside the Save draft:
 * `smartSearch` never restarts the engine.
 */
export function SmartSearchSettings({ state }: { state: AppState }): JSX.Element {
  const { search, settings } = state
  const { smart, keyword, readOnly } = search
  const [busy, setBusy] = useState(false)
  const [askOff, setAskOff] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [askRebuild, setAskRebuild] = useState(false)

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  function toggle(on: boolean): void {
    if (on) void run(() => window.api.search.setEnabled(true))
    else {
      setDeleteFiles(false)
      setAskOff(true)
    }
  }

  function turnOff(): void {
    setAskOff(false)
    void run(() => window.api.search.setEnabled(false, { deleteFiles }))
  }

  function rebuild(): void {
    setAskRebuild(false)
    void run(() => window.api.search.rebuild())
  }

  const status = ((): JSX.Element => {
    if (!settings.smartSearch)
      return (
        <p className="text-sm text-muted-foreground">
          {search.modelOnDisk
            ? 'Model already downloaded — turning on is instant.'
            : 'Downloads 207 MB.'}
        </p>
      )
    switch (smart.phase) {
      case 'off':
        return <p className="text-sm text-muted-foreground">Starting…</p>
      case 'downloading':
        return (
          <div className="flex flex-col gap-3">
            <SmartSearchProgress smart={smart} />
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={busy || readOnly}
              onClick={() => void run(() => window.api.search.setEnabled(false))}
            >
              <X /> Cancel
            </Button>
          </div>
        )
      case 'indexing':
        return (
          <div className="flex flex-col gap-1.5">
            <SmartSearchProgress smart={smart} />
            <p className="text-sm text-muted-foreground">
              Search works meanwhile with what&rsquo;s indexed so far.
            </p>
          </div>
        )
      case 'ready':
        return (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm font-medium">
              Ready · {smart.meetings} meetings · {keyword.passages} passages ·{' '}
              {megabytes(smart.diskBytes)} MB on disk
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || readOnly}
              onClick={() => setAskRebuild(true)}
            >
              <RefreshCw /> Rebuild index
            </Button>
          </div>
        )
      case 'error':
        return (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm text-destructive">{smartSearchError(smart)}</span>
            <Button size="sm" disabled={busy || readOnly} onClick={retrySmartSearch}>
              <RotateCcw /> Retry
            </Button>
          </div>
        )
    }
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Smart search</CardTitle>
        <CardDescription>{voice('settings.search', settings.voice)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SwitchSetting
          id="smartSearch"
          label="Smart search"
          description='Find things by meaning, e.g. "when did we agree to drop the manual approval step?". The search model runs on this computer.'
          checked={settings.smartSearch}
          disabled={busy || readOnly}
          onChange={toggle}
        />
        {readOnly && (
          <p className="text-sm text-warning">
            Another Miss Minutes window is indexing this library.
          </p>
        )}
        {status}
        <p className="text-sm text-muted-foreground">
          Keyword search: {keyword.meetings} meetings · {keyword.passages} passages indexed.
        </p>
      </CardContent>

      <Dialog open={askOff} onOpenChange={setAskOff}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn off smart search?</DialogTitle>
            <DialogDescription>
              Pressing Enter in the Library then searches by keyword only.
            </DialogDescription>
          </DialogHeader>
          {search.diskBytes > 0 && (
            <div className="flex items-start gap-3">
              <Checkbox
                id="deleteSearchFiles"
                checked={deleteFiles}
                onCheckedChange={(v) => setDeleteFiles(v === true)}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="deleteSearchFiles">
                  Also delete downloaded files (frees ~{megabytes(search.diskBytes)} MB)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Kept files make turning it on again instant; deleted ones are downloaded again.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAskOff(false)}>
              Cancel
            </Button>
            <Button onClick={turnOff}>Turn off</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={askRebuild} onOpenChange={setAskRebuild}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rebuild the search index?</DialogTitle>
            <DialogDescription>
              Every meeting is read and indexed again ({keyword.meetings} meetings, about 2 seconds
              each). Search keeps working meanwhile.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAskRebuild(false)}>
              Cancel
            </Button>
            <Button onClick={rebuild}>
              <RefreshCw /> Rebuild
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
