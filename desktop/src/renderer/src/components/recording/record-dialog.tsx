import { useEffect, useState, type JSX } from 'react'
import { AlertTriangle, AppWindow, Circle, Monitor, RefreshCw } from 'lucide-react'
import { cn } from 'cn'
import { diskVerdict, type RecordingChoice, type RecordingSource } from '@shared/recording'
import { voice } from '@shared/voice'
import { ClockSpinner } from '@/components/brand/clock-spinner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { closeRecordDialog, useRecordRequest } from '@/components/recording/record-request'
import { errorMessage, formatBytes } from '@/lib/format'
import { useApp } from '@/store'

/** Radix Select can't hold '' as a value. */
const NO_MIC = 'none'

interface Mic {
  deviceId: string
  label: string
}

interface PickerData {
  sources: RecordingSource[]
  mics: Mic[]
  freeBytes: number
  folder: string
}

/** Audio inputs, enumerated here: main only ever gets the chosen deviceId (RC·T22). */
async function listMics(): Promise<Mic[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

function SourceButton({
  source,
  selected,
  onSelect
}: {
  source: RecordingSource
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  // A minimised window has an empty thumbnail ("data:image/png;base64,").
  const hasThumbnail = source.thumbnail.length > 30
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={source.name}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-md border p-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        selected ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-border'
      )}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-muted">
        {hasThumbnail ? (
          <img src={source.thumbnail} alt="" className="size-full object-contain" />
        ) : source.kind === 'screen' ? (
          <Monitor className="size-6 text-muted-foreground" />
        ) : (
          <AppWindow className="size-6 text-muted-foreground" />
        )}
      </div>
      <span className="truncate">{source.name}</span>
    </button>
  )
}

function SourceGroup({
  title,
  sources,
  selected,
  onSelect
}: {
  title: string
  sources: RecordingSource[]
  selected: string | null
  onSelect: (id: string) => void
}): JSX.Element | null {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <Label>{title}</Label>
      <div className="grid grid-cols-3 gap-2">
        {sources.map((s) => (
          <SourceButton
            key={s.id}
            source={s}
            selected={s.id === selected}
            onSelect={() => onSelect(s.id)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The recording picker (RC·T22): which screen or window, system audio, which microphone, and free space in the
 * recordings folder. Opened every time, with the last choice preselected; mounted once by AppShell.
 */
export function RecordDialog(): JSX.Element {
  const session = useRecordRequest((s) => s.session)
  return <Picker key={session} />
}

function Picker(): JSX.Element {
  const open = useRecordRequest((s) => s.open)
  const phase = useApp((s) => s.state?.recording.phase ?? 'idle')
  const voiceOn = useApp((s) => s.state?.settings.voice ?? false)
  const [picker, setPicker] = useState<PickerData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 0 = the first load (applies the last choice); bumped by Refresh.
  const [reload, setReload] = useState(0)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [systemAudio, setSystemAudio] = useState(true)
  const [mic, setMic] = useState(NO_MIC)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // Recording started elsewhere (tray, hotkey) while the picker is open: it has nothing left to do.
  useEffect(() => {
    if (open && !starting && phase !== 'idle') closeRecordDialog()
  }, [open, starting, phase])

  useEffect(() => {
    if (!open) return
    let live = true
    Promise.all([window.api.recording.sources(), listMics()]).then(
      ([data, mics]) => {
        if (!live) return
        setPicker({ sources: data.sources, mics, freeBytes: data.freeBytes, folder: data.folder })
        setSourceId((current) => {
          // A refresh keeps what's picked while it still exists.
          if (current && data.sources.some((s) => s.id === current)) return current
          // Window ids don't survive a restart, so a window choice falls back to the last screen.
          const screens = data.sources.filter((s) => s.kind === 'screen')
          const lastScreen = screens.find(
            (s) => s.displayId && s.displayId === data.last?.displayId
          )
          return (lastScreen ?? screens[0])?.id ?? null
        })
        if (reload > 0) return
        setSystemAudio(data.last?.systemAudio ?? true)
        const wanted = data.last ? data.last.micDeviceId : 'default'
        if (wanted === null) setMic(NO_MIC)
        else if (mics.some((m) => m.deviceId === wanted)) setMic(wanted)
        else setMic(mics.some((m) => m.deviceId === 'default') ? 'default' : NO_MIC)
      },
      (error) => live && setLoadError(errorMessage(error))
    )
    return () => {
      live = false
    }
  }, [open, reload])

  const source = picker?.sources.find((s) => s.id === sourceId) ?? null
  const verdict = picker ? diskVerdict(picker.freeBytes) : 'ok'

  async function start(): Promise<void> {
    if (!source) return
    const choice: RecordingChoice = {
      sourceId: source.id,
      kind: source.kind,
      displayId: source.kind === 'screen' ? source.displayId : null,
      systemAudio,
      micDeviceId: mic === NO_MIC ? null : mic
    }
    setStarting(true)
    setStartError(null)
    try {
      await window.api.recording.start(choice)
      closeRecordDialog()
    } catch (error) {
      setStartError(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }

  const screens = picker?.sources.filter((s) => s.kind === 'screen') ?? []
  const windows = picker?.sources.filter((s) => s.kind === 'window') ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !starting && closeRecordDialog()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a meeting</DialogTitle>
          <DialogDescription>
            The recording is saved to your recordings folder and processed like any other.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : !picker ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <ClockSpinner label="" /> Looking for screens and windows…
          </div>
        ) : (
          <div className="-mr-3 flex max-h-[60vh] flex-col gap-5 overflow-x-hidden overflow-y-auto pr-3">
            <div className="flex flex-col gap-4">
              <SourceGroup
                title="Screens"
                sources={screens}
                selected={sourceId}
                onSelect={setSourceId}
              />
              <SourceGroup
                title="Windows"
                sources={windows}
                selected={sourceId}
                onSelect={setSourceId}
              />
              {source?.kind === 'window' && (
                <p className="text-sm text-muted-foreground">
                  Keep the window open and not minimised, or the recording freezes.
                </p>
              )}
            </div>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="recordSystemAudio">
                  Record system audio (other people in the call)
                </FieldLabel>
              </FieldContent>
              <Switch
                id="recordSystemAudio"
                checked={systemAudio}
                onCheckedChange={setSystemAudio}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="recordMic">Microphone</FieldLabel>
              <Select value={mic} onValueChange={setMic}>
                <SelectTrigger id="recordMic" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MIC}>No microphone</SelectItem>
                  {picker.mics.map((m) => (
                    <SelectItem key={m.deviceId} value={m.deviceId}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{voice('recording.headphones', voiceOn)}</FieldDescription>
            </Field>

            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">
                Saving to <span className="break-all">{picker.folder}</span> ·{' '}
                {formatBytes(picker.freeBytes)} free
              </p>
              {verdict === 'low' && (
                <p className="flex items-center gap-1.5 text-warning">
                  <AlertTriangle className="size-4 shrink-0" /> The drive is getting full: a long
                  meeting may not fit.
                </p>
              )}
              {verdict === 'refuse' && (
                <p className="flex items-center gap-1.5 text-destructive">
                  <AlertTriangle className="size-4 shrink-0" /> Not enough free space to record.
                  Free up some space first.
                </p>
              )}
            </div>
          </div>
        )}

        {startError && <p className="text-sm text-destructive">{startError}</p>}

        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            disabled={!picker || starting}
            onClick={() => setReload((n) => n + 1)}
          >
            <RefreshCw /> Refresh
          </Button>
          <Button variant="outline" disabled={starting} onClick={closeRecordDialog}>
            Cancel
          </Button>
          <Button
            className="bg-record text-record-foreground hover:bg-record/90"
            disabled={!source || verdict === 'refuse' || starting}
            onClick={() => void start()}
          >
            {starting ? <ClockSpinner label="" /> : <Circle className="fill-current" />}
            {starting ? 'Starting…' : 'Start recording'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
