import { useCallback, useEffect, useState, type JSX } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { toast } from 'sonner'
import type { RestartMode, Settings } from '@shared/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { HealthCard } from '@/components/health-card'
import { GoogleAccountCard } from '@/components/settings/google-account'
import { RecordingSettings } from '@/components/settings/recording'
import { UpdateSettings } from '@/components/settings/updates'
import { SmartSearchSettings } from '@/components/settings/smart-search'
import {
  AiStudioSection,
  AppSection,
  CompressionSection,
  NotificationsSection,
  WatchingSection,
  type SectionProps
} from '@/components/settings/sections'
import { changedKeys, needsRestart, patchOf, textErrors } from '@/lib/settings-form'
import { useApp } from '@/store'

/** Every CLI flag as a setting (08·T2), plus the app's own options and the health checks (08·T3). */
export function SettingsPage(): JSX.Element | null {
  const state = useApp((s) => s.state)
  // null = no unsaved changes: the form shows the saved settings, so outside changes appear right away.
  const [draft, setDraft] = useState<Settings | null>(null)
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [rootError, setRootError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState('')
  // Bumped on Save/Discard: remounts the fields, so a half-typed number is reset too.
  const [formKey, setFormKey] = useState(0)

  const saved = state?.settings
  // smartSearch and the hotkeys are saved at once by their own cards (SS·T26, RC·T25): never part of the draft,
  // so Save can't revert them.
  const current =
    draft && saved
      ? {
          ...draft,
          smartSearch: saved.smartSearch,
          recordHotkey: saved.recordHotkey,
          muteHotkey: saved.muteHotkey,
          recordingToolbar: saved.recordingToolbar
        }
      : saved

  const onValidity = useCallback((id: string, valid: boolean) => {
    setInvalid((set) => {
      if (valid !== set.has(id)) return set
      const next = new Set(set)
      if (valid) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // The project folder must hold watcher.py and the venv; only main can look at the disk.
  const root = current?.projectRoot
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      if (!root || root === saved?.projectRoot) setRootError(null)
      else void window.api.checkProjectRoot(root).then((problem) => live && setRootError(problem))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [root, saved?.projectRoot])

  useEffect(() => {
    void window.api.app.getVersion().then(setVersion)
  }, [])

  if (!state || !current || !saved) return null

  const keys = changedKeys(saved, current)
  const errors = textErrors(current)
  const blocked = invalid.size > 0 || Object.keys(errors).length > 0 || !!rootError
  const restart = needsRestart(keys)
  const busy = state.worker.state === 'busy'

  const set: SectionProps['set'] = (key, value) => setDraft({ ...current, [key]: value })

  async function save(mode: RestartMode): Promise<void> {
    if (!current || !saved) return
    setAsking(false)
    setSaving(true)
    try {
      await window.api.saveSettings(patchOf(current, keys), { restart: mode })
      setDraft(null)
      setFormKey((k) => k + 1)
      toast.success(
        !restart
          ? 'Settings saved'
          : busy && mode === 'after-current'
            ? 'Saved — the worker restarts after the current video'
            : 'Saved — the worker is restarting'
      )
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const props: SectionProps = { draft: current, set, errors, onValidity }

  return (
    <div className="flex flex-col gap-6 pb-4">
      <h1 className="font-display text-2xl">Settings</h1>
      <HealthCard state={state} />
      <div key={formKey} className="contents">
        <WatchingSection {...props} />
        <RecordingSettings state={state} />
        <CompressionSection {...props} />
        <GoogleAccountCard state={state} />
        <AiStudioSection {...props} />
        <SmartSearchSettings state={state} />
        <AppSection {...props} rootError={rootError} />
        <NotificationsSection {...props} />
      </div>
      <UpdateSettings state={state} version={version} />
      {version && (
        <p className="text-center text-xs text-muted-foreground">
          Miss Minutes {version} · Video compression by{' '}
          {/* 11b: HandBrakeCLI ships unmodified under the GPL; its licence files are in resources\handbrake\doc. */}
          <a
            href="https://handbrake.fr/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            HandBrake
          </a>{' '}
          (GPL v2)
        </p>
      )}

      {keys.length > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-lg">
          <span className="text-sm">
            {keys.length} unsaved change{keys.length > 1 ? 's' : ''}
            {restart && <span className="text-muted-foreground"> · restarts the worker</span>}
          </span>
          {blocked && (
            <span className="text-sm text-destructive">Fix the highlighted fields first.</span>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDraft(null)
                setFormKey((k) => k + 1)
              }}
              disabled={saving}
            >
              <RotateCcw /> Discard
            </Button>
            <Button
              disabled={blocked || saving}
              onClick={() => (restart && busy ? setAsking(true) : void save('after-current'))}
            >
              <Save /> Save
            </Button>
          </div>
        </div>
      )}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>A video is being processed</DialogTitle>
            <DialogDescription>
              These settings take effect when the worker restarts. Restarting now stops the current
              video; it is processed again right after.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => void save('now')}>
              Restart now
            </Button>
            <Button autoFocus onClick={() => void save('after-current')}>
              Apply after current video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
