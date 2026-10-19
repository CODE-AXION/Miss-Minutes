import { useMemo, useState, type JSX, type MouseEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { format } from 'date-fns'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  FileText,
  FolderOpen,
  ListRestart,
  MoreHorizontal,
  Pencil,
  Trash2,
  PlusCircle,
  RefreshCw,
  Tags,
  Upload,
  Users,
  Video,
  X
} from 'lucide-react'
import type { AppState } from '@shared/api'
import type { VideoEntry } from '@shared/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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
import { EditMetaDialog } from '@/components/edit-meta-dialog'
import { ReprocessDialog } from '@/components/reprocess-dialog'
import { DeleteMeetingDialog } from '@/components/delete-meeting-dialog'
import { SearchResults } from '@/components/search-results'
import { fileName, formatBytes, parseTs } from '@/lib/format'
import {
  countValues,
  hasFilters,
  matchesFilters,
  matchesNonSearchFilters,
  readFilters,
  readGrouping,
  readSort,
  sortEntries,
  type Grouping,
  type SortKey
} from '@/lib/library'
import { videoPath } from '@/lib/paths'
import { useNoteSearch } from '@/lib/search'
import { canCommand, knownTags, runCommand, useApp } from '@/store'

const ALL = '__all'
const DOWN = 'The worker is not running'

interface Row {
  key: string
  entry: VideoEntry
}

function recordedText(entry: VideoEntry): string {
  const date = parseTs(entry.recorded)
  return date ? format(date, 'd MMM yyyy, HH:mm') : '—'
}

// --- Sortable headers (sort lives in ?sort=) --------------------------------------------------

function SortHeader({ label, sortKey }: { label: string; sortKey: SortKey }): JSX.Element {
  const [params, setParams] = useSearchParams()
  const sort = readSort(params)
  const active = sort.key === sortKey
  const toggle = (): void => {
    const next = new URLSearchParams(params)
    // First click: newest / largest first for recorded and size, A-Z for the title.
    const desc = active ? !sort.desc : sortKey !== 'title'
    next.set('sort', `${desc ? '-' : ''}${sortKey}`)
    setParams(next, { replace: true })
  }
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
    >
      {label}
      {active &&
        (sort.desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
    </button>
  )
}

// --- Row actions ---------------------------------------------------------------------------------

type OpenDialog = { kind: 'edit' | 'reprocess' | 'delete'; key: string } | null

function RowMenu({
  row,
  up,
  onDialog
}: {
  row: Row
  up: boolean
  onDialog: (dialog: OpenDialog) => void
}): JSX.Element {
  // The row itself navigates on click; the menu must not.
  const stop = (e: MouseEvent): void => e.stopPropagation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={stop}>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Actions for ${row.entry.title ?? fileName(row.key)}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stop}>
        <DropdownMenuItem
          onSelect={() => void window.api.openPath('note', row.key).catch(() => undefined)}
        >
          <ExternalLink /> Open note in editor
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!up}
          title={up ? undefined : DOWN}
          onSelect={() => onDialog({ kind: 'edit', key: row.key })}
        >
          <Pencil /> Edit details
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!up}
          title={up ? undefined : DOWN}
          onSelect={() => onDialog({ kind: 'reprocess', key: row.key })}
        >
          <RefreshCw /> Reprocess
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void window.api.openPath('source', row.key)}>
          <FolderOpen /> Show source in folder
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void window.api.openPath('noteFolder', row.key).catch(() => undefined)}
        >
          <FileText /> Show note in folder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={!up}
          title={up ? undefined : DOWN}
          onSelect={() => onDialog({ kind: 'delete', key: row.key })}
        >
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// --- The table (one per group) ---------------------------------------------------------------------

/** Columns dropped on narrower windows so the title and actions stay readable. */
const RESPONSIVE: Record<string, string | undefined> = {
  participants: 'hidden xl:table-cell',
  summary: 'hidden 2xl:table-cell',
  size: 'hidden xl:table-cell',
  model: 'hidden xl:table-cell'
}

interface TableMeta {
  up: boolean
  onDialog: (dialog: OpenDialog) => void
  /** Ticked rows, for Delete on several at once (DM·T3). */
  selected: ReadonlySet<string>
  onSelect: (keys: string[], on: boolean) => void
}

const metaOf = (options: unknown): TableMeta | undefined => (options as { meta?: TableMeta }).meta

// Stable at module scope (TanStack v9). Row actions get their callbacks through the table's meta.
const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Row>()
const columns = helper.columns([
  helper.display({
    id: 'select',
    // Ticks every row of this table (one group when grouped); the selection itself spans the whole page.
    header: ({ table }) => {
      const meta = metaOf(table.options)
      const keys = table.getRowModel().rows.map((r) => r.original.key)
      const ticked = meta ? keys.filter((k) => meta.selected.has(k)).length : 0
      return meta ? (
        <Checkbox
          aria-label="Select all"
          checked={ticked === 0 ? false : ticked === keys.length ? true : 'indeterminate'}
          onCheckedChange={(on) => meta.onSelect(keys, on === true)}
        />
      ) : null
    },
    cell: ({ row, table }) => {
      const meta = metaOf(table.options)
      const key = row.original.key
      return meta ? (
        // The row itself navigates on click; ticking must not.
        <span className="flex" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label={`Select ${row.original.entry.title ?? fileName(key)}`}
            checked={meta.selected.has(key)}
            onCheckedChange={(on) => meta.onSelect([key], on === true)}
          />
        </span>
      ) : null
    }
  }),
  helper.display({
    id: 'recorded',
    header: () => <SortHeader label="Recorded" sortKey="recorded" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums">{recordedText(row.original.entry)}</span>
    )
  }),
  helper.display({
    id: 'title',
    header: () => <SortHeader label="Title" sortKey="title" />,
    cell: ({ row }) => (
      <Link
        to={videoPath(row.original.key)}
        onClick={(e) => e.stopPropagation()}
        className="line-clamp-2 max-w-md min-w-48 font-medium whitespace-normal"
        title={row.original.entry.title}
      >
        {row.original.entry.title ?? fileName(row.original.key)}
      </Link>
    )
  }),
  helper.display({
    id: 'category',
    header: 'Category',
    cell: ({ row }) =>
      row.original.entry.category ? (
        <Badge variant="secondary">{row.original.entry.category}</Badge>
      ) : null
  }),
  helper.display({
    id: 'tags',
    header: 'Tags',
    cell: ({ row }) => {
      const tags = row.original.entry.tags ?? []
      return (
        <div className="flex w-56 flex-wrap gap-1 whitespace-normal">
          {tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="outline">
              {t}
            </Badge>
          ))}
          {tags.length > 3 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline">+{tags.length - 3}</Badge>
              </TooltipTrigger>
              <TooltipContent>{tags.slice(3).join(', ')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )
    }
  }),
  helper.display({
    id: 'participants',
    header: 'People',
    cell: ({ row }) => {
      const people = row.original.entry.participants ?? []
      if (people.length === 0) return <span className="text-muted-foreground">—</span>
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Users className="size-3.5" /> {people.length}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{people.join(', ')}</TooltipContent>
        </Tooltip>
      )
    }
  }),
  helper.display({
    id: 'summary',
    header: 'Summary',
    cell: ({ row }) => (
      <span
        className="line-clamp-2 max-w-md whitespace-normal text-muted-foreground"
        title={row.original.entry.summary}
      >
        {row.original.entry.summary}
      </span>
    )
  }),
  helper.display({
    id: 'size',
    header: () => <SortHeader label="Size" sortKey="size" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums">{formatBytes(row.original.entry.size)}</span>
    )
  }),
  helper.display({
    id: 'model',
    header: 'Model',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">{row.original.entry.model}</span>
    )
  }),
  helper.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row, table }) => {
      const meta = metaOf(table.options)
      return meta ? <RowMenu row={row.original} up={meta.up} onDialog={meta.onDialog} /> : null
    }
  })
])

function LibraryTable({ rows, meta }: { rows: Row[]; meta: TableMeta }): JSX.Element {
  const navigate = useNavigate()
  const table = useTable({ features, columns, data: rows, getRowId: (row) => row.key, meta })
  return (
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
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => navigate(videoPath(row.original.key))}
            >
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
  )
}

// --- Toolbar -------------------------------------------------------------------------------------

/** Multi-select of tags (AND), searchable, with counts: the tag list grows freely, so a flat list won't do. */
function TagFilter({
  selected,
  counts,
  onChange
}: {
  selected: string[]
  counts: [string, number][]
  onChange: (tags: string[]) => void
}): JSX.Element {
  const toggle = (tag: string): void =>
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <Tags /> Tags{selected.length ? ` (${selected.length})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tags" />
          <CommandList>
            <CommandEmpty>No tag found.</CommandEmpty>
            <CommandGroup>
              {counts.map(([tag, n]) => (
                <CommandItem key={tag} value={tag} onSelect={() => toggle(tag)}>
                  <Check className={selected.includes(tag) ? 'opacity-100' : 'opacity-0'} />
                  <span className="flex-1">{tag}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// --- Ignored (baseline) recordings ---------------------------------------------------------------

function BaselineSection({ rows, up }: { rows: Row[]; up: boolean }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg">Ignored recordings ({rows.length})</h2>
      <p className="text-sm text-muted-foreground">
        Recordings that were in the watch folder before the library existed, or that you ignored.
        Include one to process it.
      </p>
      {rows.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recording</TableHead>
                <TableHead>Recorded</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <Link to={videoPath(row.key)} className="font-medium" title={row.key}>
                      {fileName(row.key)}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">{recordedText(row.entry)}</TableCell>
                  <TableCell className="tabular-nums">{formatBytes(row.entry.size)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!up}
                      title={up ? undefined : DOWN}
                      onClick={() =>
                        void runCommand(
                          { cmd: 'include', key: row.key },
                          'Included; it is queued now'
                        )
                      }
                    >
                      <PlusCircle /> Include
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

// --- Page --------------------------------------------------------------------------------------------

function groupRows(rows: Row[], grouping: Grouping, state: AppState): [string, Row[]][] {
  if (grouping === 'flat') return [['', rows]]
  if (grouping === 'category') {
    // The worker's category order (mn.CATEGORIES), like INDEX.md.
    const order = Object.keys(state.hello?.categories ?? {})
    const rank = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length)
    const ids = [...new Set(rows.map((r) => r.entry.category ?? 'other'))].sort(
      (a, b) => rank(a) - rank(b)
    )
    return ids.map((id) => [id, rows.filter((r) => (r.entry.category ?? 'other') === id)])
  }
  // By tag, like INDEX.md: a meeting appears under each of its tags.
  const tags = [...new Set(rows.flatMap((r) => r.entry.tags ?? []))].sort()
  return tags.map((tag) => [tag, rows.filter((r) => r.entry.tags?.includes(tag))])
}

/** GUI parity for `watcher.py list` / `reindex` / `--backfill` (08·T1). */
export function LibraryPage(): JSX.Element | null {
  const state = useApp((s) => s.state)
  const [params, setParams] = useSearchParams()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [deletingMany, setDeletingMany] = useState(false)
  const query = params.toString()
  const filters = useMemo(() => readFilters(new URLSearchParams(query)), [query])
  const sort = useMemo(() => readSort(new URLSearchParams(query)), [query])
  const grouping = readGrouping(params)
  const showBaseline = params.get('baseline') === '1'

  const entries = useMemo(
    () => Object.entries(state?.videos ?? {}).map(([key, entry]) => ({ key, entry })),
    [state?.videos]
  )
  const done = useMemo(() => entries.filter((r) => r.entry.status === 'done'), [entries])
  const baseline = useMemo(
    () =>
      sortEntries(
        entries.filter((r) => r.entry.status === 'baseline'),
        { key: 'recorded', desc: true }
      ),
    [entries]
  )
  const rows = useMemo(
    () =>
      sortEntries(
        done.filter((r) => matchesFilters(r.entry, filters)),
        sort
      ),
    [done, filters, sort]
  )
  // The note search (SS·T22) only looks at the meetings the other filters let through.
  const searchKeys = useMemo(
    () => done.filter((r) => matchesNonSearchFilters(r.entry, filters)).map((r) => r.key),
    [done, filters]
  )
  const search = useNoteSearch(filters.search, searchKeys)
  const categoryCounts = useMemo(
    () =>
      countValues(
        done.map((r) => r.entry),
        (e) => (e.category ? [e.category] : [])
      ),
    [done]
  )
  const tagCounts = useMemo(
    () =>
      countValues(
        done.map((r) => r.entry),
        (e) => e.tags ?? []
      ),
    [done]
  )

  if (!state) return null
  const up = canCommand(state)
  // Only meetings that are still listed count (a ticked one may have been deleted or reprocessed meanwhile).
  const selected = new Set([...ticked].filter((k) => state.videos[k]?.status === 'done'))
  const onSelect = (keys: string[], on: boolean): void =>
    setTicked((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  const meta: TableMeta = { up, onDialog: setDialog, selected, onSelect }
  const dialogEntry = dialog ? state.videos[dialog.key] : undefined
  const smart = state.search.smart.phase
  const searching = !!filters.search.trim()
  // No index to ask (the IPC failed, or it has not loaded any note yet): cmd_list's title/summary filter instead.
  const indexMissing = state.search.keyword.meetings === 0 && done.length > 0
  const fallback = searching && (search.failed || indexMissing)
  const results = searching && !fallback ? search.result : null
  const shown = results ? new Set(results.hits.map((h) => h.key)).size : rows.length

  const set = (name: string, value: string | string[] | null): void => {
    const next = new URLSearchParams(params)
    next.delete(name)
    for (const v of Array.isArray(value) ? value : value ? [value] : []) next.append(name, v)
    setParams(next, { replace: true })
  }
  const clearFilters = (): void => {
    const next = new URLSearchParams(params)
    for (const name of ['q', 'category', 'tag', 'from', 'to', 'origin']) next.delete(name)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto font-display text-2xl">Library</h1>
        <Button
          size="sm"
          variant="outline"
          disabled={!up}
          title={up ? undefined : DOWN}
          onClick={() => void runCommand({ cmd: 'reindex' }, 'INDEX.md rebuilt')}
        >
          <ListRestart /> Rebuild INDEX.md
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void window.api.openPath('index').catch(() => undefined)}
        >
          <FileText /> Open INDEX.md
        </Button>
        <Button size="sm" variant="outline" onClick={() => void window.api.openPath('library')}>
          <FolderOpen /> Open library folder
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Input
            className="h-9 w-72 pr-36"
            placeholder="Search notes"
            value={filters.search}
            onChange={(e) => set('q', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search.runSmart()}
            aria-label="Search notes"
          />
          {(smart === 'ready' || smart === 'indexing') && (
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1.5 text-[11px] text-muted-foreground">
              Enter = smart search
            </span>
          )}
        </div>
        <Select
          value={filters.category || ALL}
          onValueChange={(v) => set('category', v === ALL ? null : v)}
        >
          <SelectTrigger className="w-52" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {Object.keys(state.hello?.categories ?? {}).map((id) => (
              <SelectItem key={id} value={id}>
                {id} ({categoryCounts.find(([c]) => c === id)?.[1] ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TagFilter selected={filters.tags} counts={tagCounts} onChange={(t) => set('tag', t)} />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <Input
            type="date"
            className="h-9 w-36"
            value={filters.from}
            onChange={(e) => set('from', e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          to
          <Input
            type="date"
            className="h-9 w-36"
            value={filters.to}
            onChange={(e) => set('to', e.target.value)}
          />
        </label>
        <Select
          value={filters.origin || ALL}
          onValueChange={(v) => set('origin', v === ALL ? null : v)}
        >
          <SelectTrigger className="w-40" aria-label="Origin">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any origin</SelectItem>
            <SelectItem value="watch">
              <Video /> Watch folder
            </SelectItem>
            <SelectItem value="upload">
              <Upload /> Uploaded
            </SelectItem>
          </SelectContent>
        </Select>
        {hasFilters(filters) && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X /> Clear
          </Button>
        )}
      </div>

      {filters.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Has all of:</span>
          {filters.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                className="opacity-70 hover:opacity-100"
                onClick={() =>
                  set(
                    'tag',
                    filters.tags.filter((t) => t !== tag)
                  )
                }
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground tabular-nums">
          {shown} of {done.length} meeting{done.length === 1 ? '' : 's'}
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={grouping}
          onValueChange={(v) => v && set('group', v === 'flat' ? null : v)}
          aria-label="Group by"
        >
          <ToggleGroupItem value="flat">Flat</ToggleGroupItem>
          <ToggleGroupItem value="category">By category</ToggleGroupItem>
          <ToggleGroupItem value="tag">By tag</ToggleGroupItem>
        </ToggleGroup>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Switch
            checked={showBaseline}
            onCheckedChange={(on) => set('baseline', on ? '1' : null)}
          />
          Show ignored ({baseline.length})
        </label>
        {showBaseline && baseline.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={!up}
            title={up ? undefined : DOWN}
            onClick={() =>
              void runCommand(
                { cmd: 'include_all_baseline' },
                `Included ${baseline.length} recordings; they are queued now`
              )
            }
          >
            <PlusCircle /> Include all ignored ({baseline.length})
          </Button>
        )}
      </div>

      {fallback && (
        <p className="text-sm text-muted-foreground">
          {search.failed ? 'Search index unavailable' : 'Search index is still loading'} — showing
          title/summary matches.
        </p>
      )}

      {searching && !fallback ? (
        results ? (
          <SearchResults
            hits={results.hits}
            entries={state.videos}
            usedSmart={results.usedSmart}
            ms={results.ms}
            smartOff={smart === 'off'}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Searching…</p>
        )
      ) : rows.length === 0 ? (
        <PosterPanel pose={done.length ? 'point' : 'wave'}>
          {done.length ? 'No meetings match these filters.' : 'No notes yet.'}
        </PosterPanel>
      ) : (
        groupRows(rows, grouping, state).map(([group, items]) => (
          <section key={group || 'all'} className="flex flex-col gap-2">
            {group && (
              <h2 className="font-display text-lg">
                {group} <span className="text-muted-foreground">({items.length})</span>
              </h2>
            )}
            <LibraryTable rows={items} meta={meta} />
          </section>
        ))
      )}

      {showBaseline && <BaselineSection rows={baseline} up={up} />}

      {selected.size > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-lg">
          <span className="text-sm font-medium">
            {selected.size} meeting{selected.size > 1 ? 's' : ''} selected
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => setTicked(new Set())}>
              Clear
            </Button>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={!up}
              title={up ? undefined : DOWN}
              onClick={() => setDeletingMany(true)}
            >
              <Trash2 /> Delete…
            </Button>
          </div>
        </div>
      )}
      {deletingMany && (
        <DeleteMeetingDialog
          open
          onOpenChange={setDeletingMany}
          entryKeys={[...selected]}
          name={
            selected.size === 1
              ? (state.videos[[...selected][0]]?.title ?? fileName([...selected][0]))
              : `${selected.size} meetings`
          }
          hasNote
          onDeleted={(_, deleted) =>
            setTicked((prev) => new Set([...prev].filter((k) => !deleted.includes(k))))
          }
        />
      )}

      {dialog?.kind === 'edit' && dialogEntry && state.hello && (
        <EditMetaDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          entryKey={dialog.key}
          entry={dialogEntry}
          categories={state.hello.categories}
          knownTags={knownTags(state)}
        />
      )}
      {dialog?.kind === 'reprocess' && (
        <ReprocessDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          entryKey={dialog.key}
          hasCompressed={!!dialogEntry?.compressed}
        />
      )}
      {dialog?.kind === 'delete' && dialogEntry && (
        <DeleteMeetingDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          entryKeys={[dialog.key]}
          name={dialogEntry.title ?? fileName(dialog.key)}
          hasNote={!!dialogEntry.notes}
        />
      )}
    </div>
  )
}
