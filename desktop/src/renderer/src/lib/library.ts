/**
 * Library filters (08·T1). The core mirrors `watcher.py list` (cmd_list): done entries only, the category is an exact
 * id, tags are AND-ed, and the search is case-insensitive over "title summary". The date range and origin are
 * GUI-only extras. Filters live in the URL search params, so they survive navigation to a video and back.
 */
import type { VideoEntry } from '@shared/protocol'
import { slugifyTag } from './format'

export interface LibraryFilters {
  search: string
  category: string
  tags: string[]
  /** "YYYY-MM-DD", inclusive; empty = open. */
  from: string
  to: string
  origin: '' | 'watch' | 'upload'
}

export type Grouping = 'flat' | 'category' | 'tag'
export type SortKey = 'recorded' | 'title' | 'size'
export interface Sort {
  key: SortKey
  desc: boolean
}

export function readFilters(params: URLSearchParams): LibraryFilters {
  const origin = params.get('origin')
  return {
    search: params.get('q') ?? '',
    category: params.get('category') ?? '',
    tags: params.getAll('tag'),
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    origin: origin === 'watch' || origin === 'upload' ? origin : ''
  }
}

export function readGrouping(params: URLSearchParams): Grouping {
  const group = params.get('group')
  return group === 'category' || group === 'tag' ? group : 'flat'
}

/** `sort=recorded` / `sort=-recorded` (default: recorded, newest first, like cmd_list). */
export function readSort(params: URLSearchParams): Sort {
  const raw = params.get('sort') ?? '-recorded'
  const key = raw.replace(/^-/, '')
  return key === 'title' || key === 'size' || key === 'recorded'
    ? { key, desc: raw.startsWith('-') }
    : { key: 'recorded', desc: true }
}

export function hasFilters(f: LibraryFilters): boolean {
  return !!(f.search || f.category || f.tags.length || f.from || f.to || f.origin)
}

/** cmd_list's tests, in the same order, plus the GUI-only date range and origin. */
export function matchesFilters(entry: VideoEntry, f: LibraryFilters): boolean {
  if (entry.status !== 'done') return false
  if (f.category && entry.category !== slugifyTag(f.category)) return false
  const tags = new Set(entry.tags ?? [])
  if (!f.tags.every((t) => tags.has(slugifyTag(t)))) return false
  if (
    f.search &&
    !`${entry.title ?? ''} ${entry.summary ?? ''}`.toLowerCase().includes(f.search.toLowerCase())
  )
    return false
  const day = (entry.recorded ?? '').slice(0, 10)
  if (f.from && day < f.from) return false
  if (f.to && day > f.to) return false
  if (f.origin && (entry.origin ?? 'watch') !== f.origin) return false
  return true
}

export function sortEntries<T extends { entry: VideoEntry }>(rows: T[], sort: Sort): T[] {
  const value = (e: VideoEntry): string | number =>
    sort.key === 'size'
      ? (e.size ?? 0)
      : sort.key === 'title'
        ? (e.title ?? '').toLowerCase()
        : (e.recorded ?? '')
  return [...rows].sort((a, b) => {
    const va = value(a.entry)
    const vb = value(b.entry)
    const order = va < vb ? -1 : va > vb ? 1 : 0
    return sort.desc ? -order : order
  })
}

/** How many entries carry each value (for the category and tag pickers), most used first. */
export function countValues(
  entries: VideoEntry[],
  pick: (e: VideoEntry) => string[]
): [string, number][] {
  const counts = new Map<string, number>()
  for (const e of entries) for (const v of pick(e)) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
