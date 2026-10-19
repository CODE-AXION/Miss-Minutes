import {
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode
} from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { format } from 'date-fns'
import {
  ArrowLeft,
  EyeOff,
  FileText,
  FolderOpen,
  Pencil,
  Trash2,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Upload,
  Video
} from 'lucide-react'
import type { AppState } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { statusLabel } from '@shared/voice'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PosterPanel } from '@/components/brand/poster-panel'
import { TvaStamp, type StampTone } from '@/components/brand/tva-stamp'
import { EditMetaDialog } from '@/components/edit-meta-dialog'
import { ReprocessDialog } from '@/components/reprocess-dialog'
import { DeleteMeetingDialog } from '@/components/delete-meeting-dialog'
import { LogViewer } from '@/components/log-viewer'
import { NotesViewer } from '@/components/notes-viewer'
import { StatusBadge } from '@/components/status-badge'
import { Timeline } from '@/components/timeline'
import { useLogLines } from '@/hooks/use-log-lines'
import {
  fileName,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRelative,
  parseTs
} from '@/lib/format'
import { buildRuns, lastRunSeconds, logWindows } from '@/lib/timeline'
import {
  canCommand,
  isFinalFailure,
  knownTags,
  maxAttempts,
  runCommand,
  useApp,
  useNow
} from '@/store'

const DOWN = 'The worker is not running'

function formatDate(ts: string | undefined | null): string {
  const date = parseTs(ts)
  return date ? format(date, 'd MMM yyyy, HH:mm') : '—'
}

/** A button that is disabled with an explanation tooltip (disabled buttons get no hover, so the span takes it). */
function ActionButton({
  disabledReason,
  children,
  ...props
}: ComponentProps<typeof Button> & { disabledReason?: string }): JSX.Element {
  const button = (
    <Button size="sm" variant="outline" disabled={!!disabledReason} {...props}>
      {children}
    </Button>
  )
  if (!disabledReason) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  )
}

function stampOf(entry: VideoEntry, final: boolean): StampTone | null {
  if (entry.status === 'done') return 'filed'
  if (entry.status === 'failed' && final) return 'pruned'
  if (entry.status === 'baseline') return 'archived'
  return null
}

/** Opens a file through main; a missing file becomes a toast-free no-op (the button only shows when it exists). */
function open(kind: Parameters<typeof window.api.openPath>[0], key: string): void {
  window.api.openPath(kind, key).catch(() => undefined)
}

function Header({
  entryKey,
  entry,
  state
}: {
  entryKey: string
  entry: VideoEntry
  state: AppState
}): JSX.Element {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const voiceOn = state.settings.voice
  const max = maxAttempts(state)
  const final = isFinalFailure(entry, max)
  const stamp = stampOf(entry, final)
  const current = state.worker.current === entryKey
  const down = canCommand(state) ? undefined : DOWN
  const { status } = entry
  const total = lastRunSeconds(entry)
  const ratio = entry.size && entry.compressed_size ? entry.compressed_size / entry.size : null

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="mt-0.5 shrink-0"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-4">
            <h1 className="min-w-0 font-display text-2xl break-words" title={entryKey}>
              {entry.title ?? fileName(entryKey)}
            </h1>
            {stamp && (
              <TvaStamp tone={stamp} title={statusLabel(status, false).label} className="shrink-0">
                {statusLabel(status, voiceOn, final).label}
              </TvaStamp>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={status} voice={voiceOn} final={final} />
            {entry.category && <Badge variant="secondary">{entry.category}</Badge>}
            {entry.tags?.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
          {entry.summary && <p className="text-sm text-muted-foreground">{entry.summary}</p>}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3 xl:grid-cols-6">
        <Fact label="Recorded">{formatDate(entry.recorded)}</Fact>
        <Fact label="Origin">
          <span className="inline-flex items-center gap-1.5">
            {entry.origin === 'upload' ? (
              <Upload className="size-3.5" />
            ) : (
              <Video className="size-3.5" />
            )}
            {entry.origin === 'upload' ? 'Uploaded' : 'Watch folder'}
          </span>
        </Fact>
        <Fact label="Size">
          {formatBytes(entry.size)}
          {entry.compressed_size ? (
            <>
              {' → '}
              {formatBytes(entry.compressed_size)}
              {ratio !== null && (
                <span className="text-muted-foreground"> ({formatPercent(ratio)})</span>
              )}
            </>
          ) : null}
        </Fact>
        <Fact label="Model">{entry.model ?? '—'}</Fact>
        <Fact label="Processed">
          <span title={formatDate(entry.processed)}>
            {entry.processed ? formatRelative(entry.processed) : '—'}
          </span>
        </Fact>
        <Fact label="Attempts · last run">
          {entry.attempts} / {max}
          {total !== null && (
            <span className="text-muted-foreground"> · {formatDuration(total)}</span>
          )}
        </Fact>
        {entry.participants && entry.participants.length > 0 && (
          <div className="col-span-full">
            <Fact label="Participants">{entry.participants.join(', ')}</Fact>
          </div>
        )}
      </dl>

      {status === 'failed' && entry.error && (
        <Alert variant="destructive">
          <AlertTitle>
            {final
              ? `Failed after ${entry.attempts} attempts — retry it by hand`
              : entry.next_try
                ? `Failed — retried automatically ${formatRelative(new Date(entry.next_try * 1000).toISOString())}`
                : 'Failed — retried automatically'}
          </AlertTitle>
          <AlertDescription className="break-words">{entry.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {status === 'failed' && (
          <ActionButton
            variant="default"
            disabledReason={down}
            onClick={() => void runCommand({ cmd: 'retry', key: entryKey }, 'Queued for a retry')}
          >
            <RotateCcw /> Retry now
          </ActionButton>
        )}
        {status === 'done' && (
          <ActionButton disabledReason={down} onClick={() => setReprocessing(true)}>
            <RefreshCw /> Reprocess
          </ActionButton>
        )}
        {status === 'baseline' && (
          <ActionButton
            variant="default"
            disabledReason={down}
            onClick={() =>
              void runCommand({ cmd: 'include', key: entryKey }, 'Included; it is queued now')
            }
          >
            <PlusCircle /> Include
          </ActionButton>
        )}
        {(status === 'pending' || status === 'failed') && !current && (
          <ActionButton
            disabledReason={down}
            onClick={() =>
              void runCommand({ cmd: 'exclude', key: entryKey }, 'Ignored; it is now archived')
            }
          >
            <EyeOff /> Ignore
          </ActionButton>
        )}
        {status === 'done' && (
          <ActionButton
            disabledReason={down ?? (state.hello ? undefined : DOWN)}
            onClick={() => setEditing(true)}
          >
            <Pencil /> Edit details
          </ActionButton>
        )}
        {entry.notes && (
          <ActionButton onClick={() => open('note', entryKey)}>
            <FileText /> Open note
          </ActionButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <FolderOpen /> Show in folder
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => open('source', entryKey)}>
              <Video /> Source video
            </DropdownMenuItem>
            {entry.compressed && (
              <DropdownMenuItem onSelect={() => open('compressed', entryKey)}>
                <Video /> Compressed video
              </DropdownMenuItem>
            )}
            {entry.notes && (
              <DropdownMenuItem onSelect={() => open('noteFolder', entryKey)}>
                <FileText /> Note
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <ActionButton variant="ghost" onClick={() => open('hbLog', entryKey)}>
          <ScrollText /> HandBrake log
        </ActionButton>
        {status !== 'compressing' && status !== 'generating' && !current && (
          <ActionButton
            variant="ghost"
            className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabledReason={down}
            onClick={() => setDeleting(true)}
          >
            <Trash2 /> Delete
          </ActionButton>
        )}
      </div>

      {state.hello && (
        <EditMetaDialog
          open={editing}
          onOpenChange={setEditing}
          entryKey={entryKey}
          entry={entry}
          categories={state.hello.categories}
          knownTags={knownTags(state)}
        />
      )}
      <ReprocessDialog
        open={reprocessing}
        onOpenChange={setReprocessing}
        entryKey={entryKey}
        hasCompressed={!!entry.compressed}
      />
      {deleting && (
        <DeleteMeetingDialog
          open
          onOpenChange={setDeleting}
          entryKeys={[entryKey]}
          name={entry.title ?? fileName(entryKey)}
          hasNote={!!entry.notes}
          // With its video the meeting is gone from the library, so this page has nothing left to show.
          onDeleted={(video) => video && navigate('/library')}
        />
      )}
    </header>
  )
}

/** Ticks every second for the live row, so the rest of the page does not re-render. */
function TimelineTab({
  entryKey,
  entry,
  state
}: {
  entryKey: string
  entry: VideoEntry
  state: AppState
}): JSX.Element {
  const now = useNow(1000)
  const running = state.worker.current === entryKey && state.worker.state === 'busy'
  return (
    <Timeline
      entryKey={entryKey}
      entry={entry}
      running={running}
      live={state.live}
      now={now}
      voiceOn={state.settings.voice}
    />
  )
}

function HandbrakeLog({ entryKey }: { entryKey: string }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    window.api.readHandbrakeLog(entryKey).then(
      (log) => live && setText(log),
      (e: Error) => live && setText(`Could not read the log: ${e.message}`)
    )
    return () => {
      live = false
    }
  }, [entryKey, version])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setVersion(version + 1)}>
          <RefreshCw /> Reload
        </Button>
        <span className="text-xs text-muted-foreground">
          library/logs/{fileName(entryKey).replace(/\.[^.]+$/, '')}.handbrake.log
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
        {text === null
          ? 'Loading…'
          : text || 'No HandBrake log (not compressed yet, or an earlier compression was reused).'}
      </pre>
    </div>
  )
}

function LogsTab({
  entryKey,
  entry,
  state
}: {
  entryKey: string
  entry: VideoEntry
  state: AppState
}): JSX.Element {
  const lines = useLogLines()
  const now = useNow(5000)
  const running = state.worker.current === entryKey && state.worker.state === 'busy'
  const windows = useMemo(() => logWindows(buildRuns(entry, running, now)), [entry, running, now])
  const mine = useMemo(
    () =>
      lines.filter((line) => {
        if (line.source !== 'worker') return false
        const t = parseTs(line.ts)?.getTime() ?? 0
        return windows.some(([from, to]) => t >= from && t <= to)
      }),
    [lines, windows]
  )
  return (
    <Tabs defaultValue="worker" className="flex flex-col gap-3">
      <TabsList>
        <TabsTrigger value="worker">Worker</TabsTrigger>
        <TabsTrigger value="handbrake">HandBrake</TabsTrigger>
      </TabsList>
      <TabsContent value="worker" className="flex h-[60vh] min-h-0 flex-col">
        <LogViewer
          className="flex-1"
          lines={mine}
          empty={
            windows.length
              ? 'No lines for this video in the log buffer (it keeps the last 5,000 lines since the app started).'
              : 'No timeline for this video, so its log lines cannot be picked out.'
          }
        />
      </TabsContent>
      <TabsContent value="handbrake" className="flex h-[60vh] min-h-0 flex-col">
        <HandbrakeLog entryKey={entryKey} />
      </TabsContent>
    </Tabs>
  )
}

// The note only re-renders when the note itself changes, not on every state push.
const Notes = memo(NotesViewer)

type Tab = 'timeline' | 'notes' | 'logs'
const TABS: readonly string[] = ['timeline', 'notes', 'logs']

/** Everything about one video (07): header + actions, the Sacred Timeline, the notes and the logs. */
export function VideoDetailPage(): JSX.Element | null {
  const key = decodeURIComponent(useParams().key ?? '')
  const state = useApp((s) => s.state)
  const entry = state?.videos[key]
  const [params, setParams] = useSearchParams()

  if (!state) return null
  if (!entry) {
    return (
      <PosterPanel pose="worried" heading="Not on file">
        This video is not in the library (it may have been renamed or removed): {fileName(key)}
      </PosterPanel>
    )
  }

  // Done videos open on their notes; everything else on the timeline. ?tab= keeps the choice.
  const requested = params.get('tab')
  const fallback: Tab = entry.status === 'done' && entry.notes ? 'notes' : 'timeline'
  let tab: Tab = requested && TABS.includes(requested) ? (requested as Tab) : fallback
  if (tab === 'notes' && !entry.notes) tab = 'timeline'

  return (
    <div className="flex flex-col gap-6">
      <Header entryKey={key} entry={entry} state={state} />
      <Tabs
        value={tab}
        onValueChange={(value) => setParams({ tab: value }, { replace: true })}
        className="flex flex-col gap-4"
      >
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes" disabled={!entry.notes}>
            Notes
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <TimelineTab entryKey={key} entry={entry} state={state} />
        </TabsContent>
        <TabsContent value="notes">
          {entry.notes && (
            <Notes
              key={key}
              entryKey={key}
              notes={entry.notes}
              version={entry.updated}
              focusSection={params.get('section')}
              playable={entry.status === 'done'}
            />
          )}
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab entryKey={key} entry={entry} state={state} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
