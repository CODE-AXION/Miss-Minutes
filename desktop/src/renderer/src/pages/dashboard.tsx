import type { JSX } from 'react'
import { Link } from 'react-router'
import { isThisWeek, isToday } from 'date-fns'
import { ArrowRight } from 'lucide-react'
import type { AppState } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { voice } from '@shared/voice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { CrtPanel, Readout } from '@/components/brand/crt-panel'
import { Mascot, type MascotPose } from '@/components/brand/mascot'
import { StatusBadge } from '@/components/status-badge'
import { UploadDropzone } from '@/components/upload-dropzone'
import {
  fileName,
  formatBytes,
  formatClock,
  formatDuration,
  formatEta,
  formatRelative,
  parseTs,
  secondsSince
} from '@/lib/format'
import { lastStage, PHASES, phaseStates, stageInfo } from '@/lib/stages'
import { videoPath } from '@/lib/paths'
import { isFinalFailure, maxAttempts, useApp, useNow } from '@/store'

function StepRow({ entry }: { entry: VideoEntry }): JSX.Element {
  const states = phaseStates(entry)
  const active = Math.max(
    0,
    states.findIndex((s) => s === 'active' || s === 'failed')
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="loom"
        role="img"
        aria-label={`Step ${active + 1} of ${PHASES.length}: ${PHASES[active]}`}
      >
        {states.map((state, i) => (
          <span
            key={PHASES[i]}
            className="loom-segment"
            data-state={state === 'pending' ? undefined : state}
          />
        ))}
      </div>
      <div className="grid grid-cols-5 text-xs text-muted-foreground">
        {PHASES.map((phase, i) => (
          <span
            key={phase}
            className={states[i] === 'active' ? 'font-medium text-foreground' : undefined}
          >
            {phase}
          </span>
        ))}
      </div>
    </div>
  )
}

function NowProcessing({ state }: { state: AppState }): JSX.Element {
  const now = useNow(1000)
  const { worker, settings, live, hello } = state
  const key = worker.current
  const entry = key ? state.videos[key] : undefined
  const voiceOn = settings.voice

  if (!key || !entry || worker.state !== 'busy') {
    const down = worker.connection !== 'up'
    const pose: MascotPose = down ? 'worried' : worker.paused ? 'sleep' : 'wave'
    const waiting = worker.queue.length
    return (
      <CrtPanel>
        <CardContent className="flex items-center gap-6 py-2">
          <Mascot pose={pose} size={96} className="shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="font-display text-xl">
              {down ? 'Worker not running' : worker.paused ? 'Paused' : 'Nothing processing'}
            </CardTitle>
            {!down && (
              <p className="truncate text-sm text-muted-foreground">
                Watching {hello?.watch_dir ?? settings.watchDir} every {settings.interval} s
              </p>
            )}
            <p className="text-sm">
              {waiting > 0
                ? `${waiting} video${waiting > 1 ? 's' : ''} waiting.`
                : voice('queue.empty', voiceOn)}
            </p>
          </div>
        </CardContent>
      </CrtPanel>
    )
  }

  const step = lastStage(entry)
  const info = step ? stageInfo(step) : null
  const progress = live.progress[key]
  const compressing = entry.status === 'compressing' && progress
  const elapsed = secondsSince(step?.at ?? entry.updated, now)
  const waitingForLogin = state.lastLoginRequired?.key === key

  return (
    <CrtPanel>
      <CardContent className="flex items-start gap-4">
        <Mascot pose={waitingForLogin ? 'point' : 'busy'} size={88} className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <CardDescription>Now processing</CardDescription>
          <CardTitle className="truncate text-lg" title={key}>
            {fileName(key)}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={entry.status} voice={voiceOn} />
            {info && (
              <span className="min-w-0 truncate" title={info.text}>
                <span className="font-medium">{info.label}</span>
                {info.text && <span className="text-muted-foreground"> · {info.text}</span>}
              </span>
            )}
            {entry.attempts > 1 && (
              <Badge variant="outline">
                attempt {entry.attempts} / {maxAttempts(state)}
              </Badge>
            )}
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={videoPath(key)}>
            Open details <ArrowRight />
          </Link>
        </Button>
      </CardContent>
      <CardContent className="flex flex-col gap-4">
        {compressing ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-6">
              <Readout className="text-4xl">{progress.pct.toFixed(1)}%</Readout>
              {formatEta(progress.eta) && (
                <span className="text-sm text-muted-foreground">
                  ETA <Readout className="text-2xl">{formatEta(progress.eta)}</Readout>
                </span>
              )}
              {progress.fps !== undefined && (
                <span className="text-sm text-muted-foreground">
                  <Readout className="text-2xl">{Math.round(progress.fps)}</Readout> fps
                </span>
              )}
            </div>
            <Progress value={progress.pct} aria-label="Compression progress" />
          </div>
        ) : (
          <div className="flex items-baseline gap-3">
            <Readout className="text-4xl" aria-label={`Elapsed ${formatDuration(elapsed)}`}>
              {formatClock(elapsed)}
            </Readout>
            <span className="text-sm text-muted-foreground">
              in this step{info ? ` (${info.label.toLowerCase()})` : ''}
            </span>
          </div>
        )}
        <StepRow entry={entry} />
      </CardContent>
    </CrtPanel>
  )
}

function UpNext({ state }: { state: AppState }): JSX.Element {
  const now = useNow(1000)
  const keys = state.worker.queue.filter((k) => k !== state.worker.current).slice(0, 5)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Up next</CardTitle>
        <CardDescription>
          {state.worker.queue.length > 5
            ? `${state.worker.queue.length} in the queue`
            : 'Uploads and retries go first'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {voice('queue.empty', state.settings.voice)}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {keys.map((key) => {
              const entry = state.videos[key]
              const settling = state.live.settling[key]
              const left = settling ? settling.remaining_s - secondsSince(settling.ts, now) : 0
              return (
                <li key={key} className="flex items-center gap-2 text-sm">
                  <Link to={videoPath(key)} className="min-w-0 flex-1 truncate" title={key}>
                    {fileName(key)}
                  </Link>
                  {settling && left > 0 && (
                    <span className="tabular-nums text-muted-foreground">
                      settling {formatClock(left)} left
                    </span>
                  )}
                  {entry && <StatusBadge status={entry.status} voice={state.settings.voice} />}
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

/** ready → saved of the latest run, in seconds (null without a timeline). */
function processingSeconds(entry: VideoEntry): number | null {
  const history = entry.history ?? []
  const saved = history.findLastIndex((h) => h.stage === 'saved')
  if (saved < 0) return null
  const ready = history.slice(0, saved).findLastIndex((h) => h.stage === 'ready')
  if (ready < 0) return null
  const start = parseTs(history[ready].at)
  const end = parseTs(history[saved].at)
  return start && end ? (end.getTime() - start.getTime()) / 1000 : null
}

function Stat({
  label,
  value,
  hint,
  to
}: {
  label: string
  value: string
  hint?: string
  to?: string
}): JSX.Element {
  const body = (
    <Card className="h-full gap-1 py-4">
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-display text-2xl text-foreground">{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} className="rounded-xl no-underline">
      {body}
    </Link>
  ) : (
    body
  )
}

function Stats({ state }: { state: AppState }): JSX.Element {
  const entries = Object.values(state.videos)
  const done = entries.filter((e) => e.status === 'done')
  const processed = done.map((e) => parseTs(e.processed)).filter((d): d is Date => d !== null)
  const today = processed.filter((d) => isToday(d)).length
  const week = processed.filter((d) => isThisWeek(d, { weekStartsOn: 1 })).length
  const max = maxAttempts(state)
  const failed = entries.filter((e) => e.status === 'failed')
  const finalFailed = failed.filter((e) => isFinalFailure(e, max)).length
  const durations = [...done]
    .sort((a, b) => (b.processed ?? '').localeCompare(a.processed ?? ''))
    .slice(0, 20)
    .map(processingSeconds)
    .filter((s): s is number => s !== null)
  const average = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  const saved = entries.reduce(
    (sum, e) => (e.size && e.compressed_size ? sum + Math.max(0, e.size - e.compressed_size) : sum),
    0
  )
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat label="Done today" value={String(today)} hint={`${week} this week`} />
      <Stat
        label="Failed"
        value={String(failed.length)}
        hint={finalFailed ? `${finalFailed} need a retry by hand` : 'none need you'}
        to="/queue?filter=failed"
      />
      <Stat
        label="Average processing"
        value={average === null ? '—' : formatDuration(average)}
        hint={durations.length ? `last ${durations.length} with a timeline` : 'no timelines yet'}
      />
      <Stat label="Space saved" value={formatBytes(saved)} hint="by compression" />
    </div>
  )
}

function RecentlyCompleted({ state }: { state: AppState }): JSX.Element {
  const recent = Object.entries(state.videos)
    .filter(([, e]) => e.status === 'done')
    .sort(([, a], [, b]) => (b.processed ?? '').localeCompare(a.processed ?? ''))
    .slice(0, 5)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recently completed</CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {recent.map(([key, entry]) => (
              <li key={key} className="flex flex-col gap-0.5">
                <Link to={videoPath(key)} className="truncate font-medium" title={entry.title}>
                  {entry.title ?? fileName(key)}
                </Link>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {entry.category && <Badge variant="secondary">{entry.category}</Badge>}
                  <span>{formatRelative(entry.processed)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function DashboardPage(): JSX.Element | null {
  const state = useApp((s) => s.state)
  if (!state) return null
  return (
    <div className="flex flex-col gap-6">
      <NowProcessing state={state} />
      <Stats state={state} />
      <div className="grid gap-6 lg:grid-cols-2">
        <UpNext state={state} />
        <Card>
          <CardHeader>
            <CardTitle>Add videos</CardTitle>
            <CardDescription>Copied into the library and processed first</CardDescription>
          </CardHeader>
          <CardContent>
            <UploadDropzone />
          </CardContent>
        </Card>
      </div>
      <RecentlyCompleted state={state} />
    </div>
  )
}
