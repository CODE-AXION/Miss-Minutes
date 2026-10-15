import { useMemo, type JSX } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import {
  EyeOff,
  FolderOpen,
  MoreHorizontal,
  RotateCcw,
  SquareArrowOutUpRight,
  Upload,
  Video
} from 'lucide-react'
import type { AppState } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PosterPanel } from '@/components/brand/poster-panel'
import { StatusBadge } from '@/components/status-badge'
import { fileName, formatBytes, formatClock, formatRelative, secondsSince } from '@/lib/format'
import { videoPath } from '@/lib/paths'
import { lastStage, stageInfo } from '@/lib/stages'
import { voice } from '@shared/voice'
import {
  canCommand,
  isFinalFailure,
  maxAttempts,
  queueEntries,
  runCommand,
  useApp,
  useNow
} from '@/store'

type Filter = 'all' | 'active' | 'pending' | 'failed'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' }
]

interface Row {
  key: string
  entry: VideoEntry
  current: boolean
  final: boolean
  max: number
}

function matches(row: Row, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return row.current || ['compressing', 'compressed', 'generating'].includes(row.entry.status)
    case 'pending':
      return row.entry.status === 'pending' && !row.current
    case 'failed':
      return row.entry.status === 'failed'
  }
}

/** Queue order (what runs next) first, then everything else (failed…) newest first. */
function buildRows(state: AppState): Row[] {
  const max = maxAttempts(state)
  const order = new Map(state.worker.queue.map((key, i) => [key, i]))
  return queueEntries(state)
    .map(([key, entry]) => ({
      key,
      entry,
      current: state.worker.current === key,
      final: isFinalFailure(entry, max),
      max
    }))
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      const qa = order.get(a.key) ?? Infinity
      const qb = order.get(b.key) ?? Infinity
      if (qa !== qb) return qa - qb
      return b.entry.updated.localeCompare(a.entry.updated)
    })
}

function StepOrError({ row }: { row: Row }): JSX.Element {
  const now = useNow(1000)
  const settling = useApp((s) => s.state?.live.settling[row.key])
  let text: string
  if (row.entry.status === 'failed') text = row.entry.error ?? 'Failed'
  else if (settling) {
    const left = settling.remaining_s - secondsSince(settling.ts, now)
    text =
      left > 0 ? `Waiting for the recording to finish — ${formatClock(left)} left` : 'Ready soon'
  } else {
    const step = lastStage(row.entry)
    const info = step && (row.current || row.entry.status !== 'pending') ? stageInfo(step) : null
    text = info ? [info.label, info.text].filter(Boolean).join(' · ') : 'Waiting in the queue'
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`block max-w-48 truncate xl:max-w-80 ${row.entry.status === 'failed' ? 'text-destructive' : ''}`}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap">{text}</TooltipContent>
    </Tooltip>
  )
}

function NextRetry({ row }: { row: Row }): JSX.Element {
  const now = useNow(1000)
  if (row.entry.status !== 'failed') return <span className="text-muted-foreground">—</span>
  if (row.final) return <span className="text-muted-foreground">by hand</span>
  const left = (row.entry.next_try ?? 0) - now / 1000
  return <span className="tabular-nums">{left > 0 ? `in ${formatClock(left)}` : 'next scan'}</span>
}

function RowActions({ row }: { row: Row }): JSX.Element {
  const navigate = useNavigate()
  const up = useApp((s) => canCommand(s.state))
  const { status } = row.entry
  const ignorable = (status === 'pending' || status === 'failed') && !row.current
  const reason = up ? undefined : 'The worker is not running'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Actions for ${fileName(row.key)}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate(videoPath(row.key))}>
          <SquareArrowOutUpRight /> Open details
        </DropdownMenuItem>
        {status === 'failed' && (
          <DropdownMenuItem
            disabled={!up}
            title={reason}
            onSelect={() => void runCommand({ cmd: 'retry', key: row.key }, 'Queued for a retry')}
          >
            <RotateCcw /> Retry now
          </DropdownMenuItem>
        )}
        {ignorable && (
          <DropdownMenuItem
            disabled={!up}
            title={reason}
            onSelect={() =>
              void runCommand({ cmd: 'exclude', key: row.key }, 'Ignored; it is now archived')
            }
          >
            <EyeOff /> Ignore
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void window.api.openPath('source', row.key)}>
          <FolderOpen /> Show source in folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Columns dropped on narrower windows so the actions column stays visible. */
const RESPONSIVE: Record<string, string | undefined> = { updated: 'hidden xl:table-cell' }

// Stable at module scope (TanStack v9: new features/columns each render would rebuild the row models).
const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Row>()
const columns = helper.columns([
  helper.display({
    id: 'source',
    header: 'Source',
    cell: ({ row }) => (
      <Link
        to={videoPath(row.original.key)}
        className="block max-w-48 truncate font-medium xl:max-w-72"
        title={row.original.key}
      >
        {fileName(row.original.key)}
      </Link>
    )
  }),
  helper.display({
    id: 'origin',
    header: 'Origin',
    cell: ({ row }) =>
      row.original.entry.origin === 'upload' ? (
        <Upload className="size-4" aria-label="Uploaded" />
      ) : (
        <Video className="size-4" aria-label="Watch folder" />
      )
  }),
  helper.display({
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusCell row={row.original} />
  }),
  helper.display({
    id: 'step',
    header: 'Current step / error',
    cell: ({ row }) => <StepOrError row={row.original} />
  }),
  helper.display({
    id: 'attempts',
    header: 'Attempts',
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.entry.attempts} / {row.original.max}
      </span>
    )
  }),
  helper.display({
    id: 'nextTry',
    header: 'Next retry',
    cell: ({ row }) => <NextRetry row={row.original} />
  }),
  helper.display({
    id: 'size',
    header: 'Size',
    cell: ({ row }) => <span className="tabular-nums">{formatBytes(row.original.entry.size)}</span>
  }),
  helper.display({
    id: 'updated',
    header: 'Updated',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatRelative(row.original.entry.updated)}
      </span>
    )
  }),
  helper.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => <RowActions row={row.original} />
  })
])

function StatusCell({ row }: { row: Row }): JSX.Element {
  const voiceOn = useApp((s) => s.state?.settings.voice ?? true)
  return <StatusBadge status={row.entry.status} voice={voiceOn} final={row.final} />
}

export function QueuePage(): JSX.Element | null {
  const state = useApp((s) => s.state)
  const [params, setParams] = useSearchParams()
  const filter = (FILTERS.find((f) => f.value === params.get('filter'))?.value ?? 'all') as Filter
  const all = useMemo(() => (state ? buildRows(state) : []), [state])
  const data = useMemo(() => all.filter((row) => matches(row, filter)), [all, filter])
  const table = useTable({ features, columns, data, getRowId: (row) => row.key })
  if (!state) return null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl">Queue</h1>
        <ToggleGroup
          type="single"
          variant="outline"
          value={filter}
          onValueChange={(value) => value && setParams(value === 'all' ? {} : { filter: value })}
          aria-label="Filter the queue"
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.value} value={f.value}>
              {f.label} ({all.filter((row) => matches(row, f.value)).length})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {data.length === 0 ? (
        <PosterPanel pose={filter === 'failed' ? 'cheer' : 'wave'}>
          {filter === 'failed' ? 'No failed videos.' : voice('queue.empty', state.settings.voice)}
        </PosterPanel>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className={RESPONSIVE[header.column.id]}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.original.current ? 'selected' : undefined}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className={RESPONSIVE[cell.column.id]}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
