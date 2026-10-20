import { useState, type JSX } from 'react'
import type { EngineMode, HbSpeed, Settings, ThemeSetting, ThinkingLevel } from '@shared/api'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import {
  NumberSetting,
  PathSetting,
  SettingsSection,
  SwitchSetting,
  TextSetting
} from '@/components/settings/fields'
import { ENCODERS, NUMBER_LIMITS, type NumberKey } from '@/lib/settings-form'

export interface SectionProps {
  draft: Settings
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  errors: Partial<Record<keyof Settings, string>>
  onValidity: (id: string, valid: boolean) => void
}

function Num({
  k,
  label,
  description,
  unit,
  p
}: {
  k: NumberKey
  label: string
  description: string
  unit?: string
  p: SectionProps
}): JSX.Element {
  return (
    <NumberSetting
      id={k}
      label={label}
      description={description}
      unit={unit}
      value={p.draft[k]}
      {...NUMBER_LIMITS[k]}
      onChange={(v) => p.set(k, v)}
      onValidity={p.onValidity}
    />
  )
}

// Descriptions are the argparse help strings (watcher.py / meeting_notes.py), verbatim.

export function WatchingSection(p: SectionProps): JSX.Element {
  return (
    <SettingsSection
      title="Watching"
      description="Where recordings come from and when they are picked up."
    >
      <PathSetting
        id="watchDir"
        className="md:col-span-2"
        label="Watch folder"
        kind="folder"
        description="Folder to watch"
        value={p.draft.watchDir}
        error={p.errors.watchDir}
        onChange={(v) => p.set('watchDir', v)}
      />
      <Num
        k="interval"
        p={p}
        label="Scan interval"
        unit="s"
        description="Seconds between scans (default: 60)"
      />
      <Num
        k="settle"
        p={p}
        label="Settle time"
        unit="s"
        description="Seconds a file must stay unchanged before processing (default: 120)"
      />
      <Num
        k="maxAttempts"
        p={p}
        label="Max attempts"
        description="Give up on a recording after this many failed runs (default: 3)"
      />
    </SettingsSection>
  )
}

const AUTO = 'auto'
const CUSTOM = 'custom'

export function CompressionSection(p: SectionProps): JSX.Element {
  const known = ENCODERS.some((e) => e.value === p.draft.hbEncoder)
  // "Custom" is a UI choice: it stays selected while the typed name is still empty or happens to be a known one.
  const [custom, setCustom] = useState(!known)
  const encoderChoice = custom ? CUSTOM : p.draft.hbEncoder || AUTO
  return (
    <SettingsSection
      title="Compression"
      description="HandBrake shrinks each recording before upload."
    >
      <PathSetting
        id="handbrake"
        className="md:col-span-2"
        label="HandBrakeCLI"
        kind="file"
        filters={[{ name: 'HandBrakeCLI', extensions: ['exe'] }]}
        placeholder="Automatic"
        description="Path to HandBrakeCLI.exe (default: tools/handbrake or Program Files)"
        value={p.draft.handbrake}
        onChange={(v) => p.set('handbrake', v)}
      />
      <TextSetting
        id="hbPreset"
        label="Preset"
        description='HandBrake base preset (default: "Fast 1080p30")'
        value={p.draft.hbPreset}
        error={p.errors.hbPreset}
        onChange={(v) => p.set('hbPreset', v)}
      />
      <Field>
        <FieldLabel htmlFor="hbEncoderChoice">Encoder</FieldLabel>
        <Select
          value={encoderChoice}
          onValueChange={(v) => {
            setCustom(v === CUSTOM)
            if (v !== CUSTOM) p.set('hbEncoder', v === AUTO ? '' : v)
          }}
        >
          <SelectTrigger id="hbEncoderChoice" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENCODERS.map((e) => (
              <SelectItem key={e.value || AUTO} value={e.value || AUTO}>
                {e.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        {custom && (
          <Input
            aria-label="Custom encoder"
            className="font-mono text-xs"
            placeholder="e.g. vce_h264"
            value={p.draft.hbEncoder}
            onChange={(e) => p.set('hbEncoder', e.target.value)}
          />
        )}
        <FieldDescription>
          Override the video encoder, e.g. qsv_h264 for Intel Quick Sync (faster)
        </FieldDescription>
      </Field>
      <Field className="md:col-span-2">
        <FieldLabel htmlFor="hbSpeed">Speed</FieldLabel>
        <Select value={p.draft.hbSpeed} onValueChange={(v) => p.set('hbSpeed', v as HbSpeed)}>
          <SelectTrigger id="hbSpeed" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="background">In the background (lighter on the PC)</SelectItem>
            <SelectItem value="full">Full speed</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          In the background, HandBrake runs at low priority in efficiency mode and uses about a
          third of the CPU and half the memory, so the PC stays usable; a one-hour meeting takes
          about 14 minutes instead of 10.
        </FieldDescription>
      </Field>
      <div className="flex flex-col gap-3 md:col-span-2">
        <div className="flex items-center gap-4">
          <span className="text-xs whitespace-nowrap text-muted-foreground">RF 18 · larger</span>
          <Slider
            className="flex-1"
            min={18}
            max={32}
            step={0.5}
            value={[Math.min(32, Math.max(18, p.draft.hbQuality))]}
            onValueChange={([v]) => p.set('hbQuality', v)}
            aria-label="Quality RF"
          />
          <span className="text-xs whitespace-nowrap text-muted-foreground">smaller · RF 32</span>
        </div>
        <Num
          k="hbQuality"
          p={p}
          label="Quality (RF)"
          description="Constant quality RF; higher = smaller (default: 25)"
        />
      </div>
    </SettingsSection>
  )
}

export function AiStudioSection(p: SectionProps): JSX.Element {
  return (
    <SettingsSection
      title="AI Studio"
      description="How the notes are generated in the automation Chrome."
    >
      <TextSetting
        id="model"
        label="Model"
        description="AI Studio model id (default: gemini-3.8-flash)"
        value={p.draft.model}
        error={p.errors.model}
        onChange={(v) => p.set('model', v)}
      />
      <TextSetting
        id="fallbackModel"
        label="Fallback model"
        placeholder="None"
        description="Model to try if --model keeps failing (e.g. gemini-3.7-flash)"
        value={p.draft.fallbackModel}
        onChange={(v) => p.set('fallbackModel', v)}
      />
      <Field>
        <FieldLabel htmlFor="thinkingLevel">Thinking level</FieldLabel>
        <Select
          value={p.draft.thinkingLevel}
          onValueChange={(v) => p.set('thinkingLevel', v as ThinkingLevel)}
        >
          <SelectTrigger id="thinkingLevel" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>low, medium or high (default: low)</FieldDescription>
      </Field>
      <TextSetting
        id="language"
        label="Language"
        description="Language of the output document"
        value={p.draft.language}
        error={p.errors.language}
        onChange={(v) => p.set('language', v)}
      />
      <Field className="md:col-span-2">
        <FieldLabel htmlFor="context">Background context</FieldLabel>
        <Textarea
          id="context"
          rows={5}
          value={p.draft.context}
          placeholder="Project names, usual attendees, domain terms…"
          onChange={(e) => p.set('context', e.target.value)}
        />
        <FieldDescription>
          Optional background (project, attendees, domain) to improve accuracy. Passed to the worker
          as --context-file.
        </FieldDescription>
      </Field>
      <Num
        k="retries"
        p={p}
        label="Retries"
        description="Retries per model on failure, with backoff (default: 2)"
      />
      <Num
        k="timeout"
        p={p}
        label="Generation timeout"
        unit="s"
        description="Max seconds to wait for one generation (default: 1800)"
      />
      <Num
        k="uploadTimeout"
        p={p}
        label="Upload timeout"
        unit="s"
        description="Max seconds to wait for the video upload (default: 1800)"
      />
      <Num
        k="loginWait"
        p={p}
        label="Sign-in wait"
        unit="s"
        description="Seconds to wait for you to sign in on first run (default: 600)"
      />
      <Num
        k="port"
        p={p}
        label="Chrome debug port"
        description="Chrome remote-debugging port (default: 9333)"
      />
      <SwitchSetting
        id="keepBrowser"
        label="Keep Chrome open"
        description="Leave the automation Chrome open after processing"
        checked={p.draft.keepBrowser}
        onChange={(v) => p.set('keepBrowser', v)}
      />
      <SwitchSetting
        id="chromeMode"
        label="Show the automation browser"
        description="Show the automation browser while processing (for troubleshooting). Off = it runs on a hidden Windows desktop: no window, no taskbar button."
        checked={p.draft.chromeMode === 'visible'}
        onChange={(v) => p.set('chromeMode', v ? 'visible' : 'hidden')}
      />
    </SettingsSection>
  )
}

export function AppSection(p: SectionProps & { rootError: string | null }): JSX.Element {
  return (
    <SettingsSection title="App" description="Miss Minutes itself.">
      <PathSetting
        id="library"
        className="md:col-span-2"
        label="Library folder"
        kind="folder"
        description="Library folder (index.json, INDEX.md, notes, compressed videos, logs)"
        value={p.draft.library}
        error={p.errors.library}
        onChange={(v) => p.set('library', v)}
      />
      <SwitchSetting
        id="openAtLogin"
        label="Start at Windows login"
        description="Keep watching the folder from the tray after you sign in to Windows."
        checked={p.draft.openAtLogin}
        onChange={(v) => p.set('openAtLogin', v)}
      />
      <SwitchSetting
        id="startHidden"
        label="Start hidden"
        description="At login, start in the tray without opening the window."
        checked={p.draft.startHidden}
        onChange={(v) => p.set('startHidden', v)}
      />
      <Field>
        <FieldLabel htmlFor="theme">Theme</FieldLabel>
        <Select value={p.draft.theme} onValueChange={(v) => p.set('theme', v as ThemeSetting)}>
          <SelectTrigger id="theme" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="office">TVA Office (light)</SelectItem>
            <SelectItem value="crt">CRT Terminal (dark)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <SwitchSetting
        id="voice"
        label="Miss Minutes voice"
        description="Flavour text in messages, and the Filed / Pruned / Archived stamps. Off = plain wording."
        checked={p.draft.voice}
        onChange={(v) => p.set('voice', v)}
      />
      {/* 11c·T4: changing the engine or the project folder restarts the worker (workerSignature). */}
      <details className="md:col-span-2" open={p.draft.engine === 'project'}>
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
          Developer
        </summary>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="engine">Engine</FieldLabel>
            <Select value={p.draft.engine} onValueChange={(v) => p.set('engine', v as EngineMode)}>
              <SelectTrigger id="engine" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bundled">Bundled (recommended)</SelectItem>
                <SelectItem value="project">Project folder (developer)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {p.draft.engine === 'project' && (
            <PathSetting
              id="projectRoot"
              className="md:col-span-2"
              label="Project folder"
              kind="folder"
              description="The video_automation folder: it must contain watcher.py and .venv\Scripts\python.exe."
              value={p.draft.projectRoot}
              error={p.errors.projectRoot ?? p.rootError ?? undefined}
              onChange={(v) => p.set('projectRoot', v)}
            />
          )}
        </div>
      </details>
    </SettingsSection>
  )
}

export function NotificationsSection(p: SectionProps): JSX.Element {
  const notify = (key: keyof Settings['notify'], value: boolean): void =>
    p.set('notify', { ...p.draft.notify, [key]: value })
  return (
    <SettingsSection title="Notifications" description="Windows toasts from the tray.">
      <SwitchSetting
        id="notifyDone"
        label="Notes ready"
        description="When a video's notes are saved."
        checked={p.draft.notify.done}
        onChange={(v) => notify('done', v)}
      />
      <SwitchSetting
        id="notifyFailedFinal"
        label="Final failure"
        description="When a video failed after all its attempts."
        checked={p.draft.notify.failedFinal}
        onChange={(v) => notify('failedFinal', v)}
      />
      <SwitchSetting
        id="notifyEveryFailure"
        label="Every failure"
        description="Also when a failed attempt will be retried automatically."
        checked={p.draft.notify.everyFailure}
        onChange={(v) => notify('everyFailure', v)}
      />
      <SwitchSetting
        id="notifyLogin"
        label="Google sign-in required"
        description="Always on: it is the only time processing waits for you."
        checked
        disabled
        onChange={() => undefined}
      />
    </SettingsSection>
  )
}
