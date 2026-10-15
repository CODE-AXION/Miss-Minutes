import { useState, type JSX } from 'react'
import { format } from 'date-fns'
import { ChevronRight, Copy, Hourglass, ListOrdered } from 'lucide-react'
import { cn } from 'cn'
import type { LiveState } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { statusLabel, voice } from '@shared/voice'
import { Button } from '@/components/ui/button'
import { Readout } from '@/components/brand/crt-panel'
import { TvaStamp } from '@/components/brand/tva-stamp'
import { PhaseBar } from '@/components/phase-bar'
import { formatClock, formatDuration, formatEta, secondsSince } from '@/lib/format'
import { stageInfo, type Tone } from '@/lib/stages'
import { buildRuns, type Run, type TimelineRow } from '@/lib/timeline'
import { copyText } from '@/store'

const TONE_TEXT: Record<Tone, string> = {
  info: '',
  success: '',
  warning: 'text-warning',
  danger: 'text-destructive',
  muted: 'text-muted-foreground'
}

/** The in-flight readouts: compress % / ETA / fps from `live.progress`, otherwise a ticking elapsed time. */
function LiveReadout({
  row,
  progress
}: {
  row: TimelineRow
  progress: LiveState['progress'][string] | undefined
}): JSX.Element {
  const compressing = row.item.stage === 'compress_start' && progress
  return (
    <div className="crt-scanlines mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-md border border-border bg-card px-3 py-2">
      {compressing ? (
        <>
          <Readout className="text-3xl">{progress.pct.toFixed(1)}%</Readout>
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
        </>
      ) : (
        <span className="text-sm text-muted-foreground">
          <Readout className="text-3xl">{formatClock(row.seconds ?? 0)}</Readout> elapsed
        </span>
      )}
    </div>
  )
}

function Row({
  row,
  longest,
  progress
}: {
  row: TimelineRow
  longest: number
  progress?: LiveState['progress'][string]
}): JSX.Element {
  const { label, icon: Icon, tone, text } = stageInfo(row.item)
  const error = row.item.stage === 'failed' ? row.item.error : null
  const state = row.live ? 'active' : error !== null ? 'pruned' : 'done'
  return (
    <li className="timeline-item" data-state={state}>
      <span className="timeline-node" />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <Icon className={cn('size-4 shrink-0 self-center', TONE_TEXT[tone])} aria-hidden />
          <span className={cn('font-medium', TONE_TEXT[tone])}>{label}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {format(row.start, 'HH:mm:ss')}
          </span>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums">
            {row.seconds !== null && !row.live ? formatDuration(row.seconds) : ''}
          </span>
        </div>
        {error !== null ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <pre className="min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap text-destructive">
              {error}
            </pre>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Copy the error"
              onClick={() => copyText(error)}
            >
              <Copy />
            </Button>
          </div>
        ) : (
          text && <p className="text-sm break-words text-muted-foreground">{text}</p>
        )}
        {row.seconds !== null && !row.live && longest > 0 && row.seconds > 0 && (
          <div className="h-1 rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-brand/70"
              style={{ width: `${Math.max(1, (row.seconds / longest) * 100)}%` }}
            />
          </div>
        )}
        {row.live && <LiveReadout row={row} progress={progress} />}
      </div>
    </li>
  )
}

function longestRow(run: Run): number {
  return Math.max(0, ...run.rows.map((r) => (r.live ? 0 : (r.seconds ?? 0))))
}

function runTitle(run: Run, voiceOn: boolean): string {
  const when = format(run.start, 'd MMM HH:mm')
  switch (run.outcome) {
    case 'failed':
      return `Variant attempt ${run.attempt} — ${statusLabel('failed', voiceOn).label.toLowerCase()}: ${run.error ?? 'failed'}`
    case 'interrupted':
      return `Variant attempt ${run.attempt} — interrupted (${when})`
    case 'stopped':
      return `Variant attempt ${run.attempt} — stopped when the app quit (${when})`
    default:
      return `Earlier run — saved (${when})`
  }
}

/** An earlier run, drawn as a branch off the main line, collapsed by default. */
function Branch({ run, voiceOn }: { run: Run; voiceOn: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const longest = longestRow(run)
  const pruned = run.outcome === 'failed'
  return (
    <li className="timeline-item" data-state={pruned ? 'pruned' : 'done'}>
      <span className="timeline-node" />
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-start gap-1 text-left text-sm',
          pruned ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        <ChevronRight
          className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="line-clamp-2 break-words">{runTitle(run, voiceOn)}</span>
      </button>
      {open && (
        <div className="timeline-branch">
          <ol className="flex flex-col gap-3">
            {run.rows.map((row, i) => (
              <Row key={i} row={row} longest={longest} />
            ))}
          </ol>
          {pruned && (
            <TvaStamp tone="pruned" title="Failed" className="mt-3 ml-1">
              {statusLabel('failed', voiceOn).label}
            </TvaStamp>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The Sacred Timeline of one video (07·T2, styling 04a·T6). Built only from `entry.history` plus the live events: the
 * latest run is the main line, every earlier run is a collapsed branch above it.
 */
export function Timeline({
  entryKey,
  entry,
  running,
  live,
  now,
  voiceOn
}: {
  entryKey: string
  entry: VideoEntry
  /** The worker is processing this video right now. */
  running: boolean
  live: LiveState
  now: number
  voiceOn: boolean
}): JSX.Element {
  const runs = buildRuns(entry, running, now)
  const main = runs.at(-1)
  const branches = runs.slice(0, -1)
  const settling = live.settling[entryKey]
  const settleLeft = settling ? settling.remaining_s - secondsSince(settling.ts, now) : 0
  const waiting = entry.status === 'pending' && !running
  const longest = main ? longestRow(main) : 0

  if (!main && !waiting) {
    return <p className="text-sm text-muted-foreground">{voice('timeline.noHistory', voiceOn)}</p>
  }

  return (
    <div className="flex flex-col gap-5">
      {main && <PhaseBar run={main} />}
      <ol className="timeline">
        {branches.map((run, i) => (
          <Branch key={i} run={run} voiceOn={voiceOn} />
        ))}
        {main?.rows.map((row, i) => (
          <Row
            key={`${branches.length}-${i}`}
            row={row}
            longest={longest}
            progress={row.live ? live.progress[entryKey] : undefined}
          />
        ))}
        {waiting && (
          <li className="timeline-item" data-state={settleLeft > 0 ? 'active' : 'pending'}>
            <span className="timeline-node" />
            <div className="flex items-center gap-2 text-sm">
              {settleLeft > 0 ? (
                <>
                  <Hourglass className="size-4" aria-hidden />
                  <span className="font-medium">Waiting for the recording to finish</span>
                  <Readout className="ml-auto text-2xl">{formatClock(settleLeft)}</Readout>
                  <span className="text-muted-foreground">left</span>
                </>
              ) : (
                <>
                  <ListOrdered className="size-4" aria-hidden />
                  <span className="font-medium">Waiting for its turn in the queue</span>
                </>
              )}
            </div>
          </li>
        )}
      </ol>
    </div>
  )
}
