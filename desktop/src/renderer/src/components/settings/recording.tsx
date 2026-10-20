import { useEffect, useState, type JSX } from 'react'
import { Keyboard, PowerOff, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState } from '@shared/api'
import { DEFAULT_MUTE_HOTKEY, DEFAULT_RECORD_HOTKEY } from '@shared/recording'
import { SwitchSetting } from '@/components/settings/fields'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { errorMessage, hotkeyLabel } from '@/lib/format'
import { acceleratorFromKey } from '@/lib/hotkey'

type HotkeyKey = 'recordHotkey' | 'muteHotkey'

/** One global shortcut: Change (captures the next combination), Reset and Turn off (RC·T25). */
function HotkeySetting({
  id,
  label,
  description,
  value,
  fallback
}: {
  id: HotkeyKey
  label: string
  description: string
  value: string
  fallback: string
}): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: string): Promise<void> {
    setCapturing(false)
    setError(null)
    if (next === value) return
    setSaving(true)
    try {
      await window.api.saveSettings({ [id]: next }, { restart: 'after-current' })
      toast.success(next ? `Shortcut set to ${hotkeyLabel(next)}` : 'Shortcut off')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  // Change: the next key combination becomes the shortcut; Escape cancels.
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') return setCapturing(false)
      const accelerator = acceleratorFromKey(e)
      if (accelerator) void save(accelerator)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // save only reads `value`, which can't change while capturing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing])

  return (
    <Field data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <div
          id={id}
          role="textbox"
          aria-readonly="true"
          aria-live="polite"
          className="flex h-8 min-w-48 items-center rounded-md border border-input bg-muted/40 px-2.5 font-mono text-sm"
        >
          {capturing ? (
            <span className="font-sans text-muted-foreground">Press a key combination…</span>
          ) : value ? (
            hotkeyLabel(value)
          ) : (
            <span className="font-sans text-muted-foreground">Off</span>
          )}
        </div>
        {capturing ? (
          <Button variant="outline" size="sm" onClick={() => setCapturing(false)}>
            <X /> Cancel
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              setError(null)
              setCapturing(true)
            }}
          >
            <Keyboard /> Change
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || capturing || value === fallback}
          onClick={() => void save(fallback)}
        >
          <RotateCcw /> Reset
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || capturing || value === ''}
          onClick={() => void save('')}
        >
          <PowerOff /> Turn off
        </Button>
      </div>
      <FieldDescription>{description}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/**
 * Settings → Recording (RC·T25, RC·T27): the global start/stop and mute shortcuts. Like Smart search they save at
 * once, outside the Save draft: main checks a key before storing it, so one another app owns is refused here and
 * the old one stays.
 */
export function RecordingSettings({ state }: { state: AppState }): JSX.Element {
  const { settings } = state
  const [savingToolbar, setSavingToolbar] = useState(false)

  async function setToolbar(recordingToolbar: boolean): Promise<void> {
    setSavingToolbar(true)
    try {
      await window.api.saveSettings({ recordingToolbar }, { restart: 'after-current' })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSavingToolbar(false)
    }
  }

  const [savingMeetingPrompt, setSavingMeetingPrompt] = useState(false)

  async function setMeetingPrompt(meetingPrompt: boolean): Promise<void> {
    setSavingMeetingPrompt(true)
    try {
      await window.api.saveSettings({ meetingPrompt }, { restart: 'after-current' })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSavingMeetingPrompt(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recording</CardTitle>
        <CardDescription>
          Recordings are saved to your Recordings folder (Watch folder setting).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-6">
          <HotkeySetting
            id="recordHotkey"
            label="Start / stop shortcut"
            description="Works from any app: starts a recording (opens the picker) or stops the one running. Use Ctrl, Alt or Win with a key, or an F-key."
            value={settings.recordHotkey}
            fallback={DEFAULT_RECORD_HOTKEY}
          />
          <HotkeySetting
            id="muteHotkey"
            label="Mute / unmute mic shortcut"
            description="Silences your mic in the recording (not in the meeting app) and turns it back on. Only active while recording with a mic, so the key stays free otherwise."
            value={settings.muteHotkey}
            fallback={DEFAULT_MUTE_HOTKEY}
          />
          <SwitchSetting
            id="recordingToolbar"
            label="Floating toolbar while recording"
            description="A small REC pill with Mute and Stop that stays on top of your meeting app. Drag it anywhere; it is not in the recording itself."
            checked={settings.recordingToolbar}
            disabled={savingToolbar}
            onChange={(on) => void setToolbar(on)}
          />
          <SwitchSetting
            id="meetingPrompt"
            label="Offer to record Google Meet calls"
            description="When a Google Meet room is open in your browser, a small prompt shows which screen and audio would be recorded. Nothing records until you click Record. Meet must be the visible tab."
            checked={settings.meetingPrompt}
            disabled={savingMeetingPrompt}
            onChange={(on) => void setMeetingPrompt(on)}
          />
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
