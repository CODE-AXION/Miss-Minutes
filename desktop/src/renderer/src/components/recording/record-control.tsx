import { useState, type JSX } from 'react'
import { AlertTriangle, Circle, Mic, MicOff, Square } from 'lucide-react'
import { cn } from 'cn'
import type { RecordingAudio } from '@shared/recording'
import { Button } from '@/components/ui/button'
import {
  ON_RECORD,
  openRecordDialog,
  setMicMuted,
  stopRecording
} from '@/components/recording/record-request'
import { formatBytes, formatClock, hotkeyLabel, secondsSince } from '@/lib/format'
import { useApp, useNow } from '@/store'

/** "system audio + mic", "mic only", … (RC·T23); "mic muted" while muted (RC·T27). */
function audioSummary(audio: RecordingAudio, muted: boolean): string {
  const system = audio.system === 'on'
  const mic = audio.mic === 'on'
  if (mic && muted) return system ? 'system audio · mic muted' : 'mic muted'
  if (system && mic) return 'system audio + mic'
  if (system) return 'system audio only'
  if (mic) return 'mic only'
  return 'no audio'
}

function Clock({ startedAt }: { startedAt: string }): JSX.Element {
  const now = useNow(1000)
  return <span className="font-mono tabular-nums">{formatClock(secondsSince(startedAt, now))}</span>
}

/**
 * Recording in the app header (RC·T28): on every page, in the same place. Idle it is a Record button that opens the
 * picker; while recording a red REC pill (time, mic mute, Stop), with the source, audio, size and any audio warning
 * beside it.
 */
export function RecordControl(): JSX.Element | null {
  const state = useApp((s) => s.state)
  const [busy, setBusy] = useState(false)
  if (!state) return null
  const { recording, settings } = state

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    await action()
    setBusy(false)
  }

  if (recording.phase === 'idle')
    return (
      <Button
        variant="outline"
        size="sm"
        className="ml-auto h-7 cursor-pointer rounded-full px-3"
        title={settings.recordHotkey ? `Shortcut: ${hotkeyLabel(settings.recordHotkey)}` : ''}
        onClick={openRecordDialog}
      >
        <Circle className="fill-record text-record" /> Record a meeting
      </Button>
    )

  const live = recording.phase === 'recording'
  const hasMic = live && recording.audio.mic === 'on'
  const muted = live && recording.micMuted
  const muteKey = settings.muteHotkey ? ` (${hotkeyLabel(settings.muteHotkey)})` : ''

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 text-xs">
        {live && (
          <span className="truncate text-muted-foreground">
            {recording.sourceName} · {audioSummary(recording.audio, recording.micMuted)} ·{' '}
            {formatBytes(recording.bytes)}
          </span>
        )}
        {live && recording.warning && (
          <span className="flex min-w-0 items-center gap-1 text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate" title={recording.warning}>
              {recording.warning}
            </span>
            {recording.audio.mic === 'blocked' && (
              <a
                href="ms-settings:privacy-microphone"
                target="_blank"
                rel="noreferrer"
                className="shrink-0 underline underline-offset-2"
              >
                Open Windows settings
              </a>
            )}
          </span>
        )}
      </div>
      <div
        role="status"
        className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-record pr-0.5 pl-2.5 text-xs text-record-foreground shadow-sm"
      >
        <span className="size-2 shrink-0 animate-dot-pulse rounded-full bg-white" />
        <span className="mr-1 ml-0.5 font-semibold tracking-wide">
          {live ? (
            <>
              REC <Clock startedAt={recording.startedAt} />
            </>
          ) : recording.phase === 'starting' ? (
            'Starting…'
          ) : (
            'Saving…'
          )}
        </span>
        {hasMic && (
          <Button
            size="xs"
            variant="outline"
            aria-pressed={muted}
            title={(muted ? 'Unmute the mic' : 'Mute the mic') + muteKey}
            className={cn(
              'h-6 cursor-pointer rounded-full px-2',
              muted ? ON_RECORD.pressed : ON_RECORD.button
            )}
            disabled={busy}
            onClick={() => void run(() => setMicMuted(!muted))}
          >
            {muted ? <MicOff /> : <Mic />}
            {muted ? 'Unmute' : 'Mute'}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          className={cn('h-6 cursor-pointer rounded-full px-2', ON_RECORD.button)}
          disabled={!live || busy}
          onClick={() => void run(stopRecording)}
        >
          <Square className="fill-current" /> Stop
        </Button>
      </div>
    </>
  )
}
