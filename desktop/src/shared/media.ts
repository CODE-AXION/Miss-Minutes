/** Privileged scheme main serves meeting recordings on (NV·T2); registered in 02. */
export const MEDIA_SCHEME = 'mm-media'

/** Which of an entry's files to play: the compressed encode Gemini watched, or the original recording. */
export type MediaFile = 'compressed' | 'source'

const FILES: readonly string[] = ['compressed', 'source'] satisfies MediaFile[]

/**
 * `mm-media://video/?key=…&file=…&v=…` for an entry's file (NV·T2). The key travels in the query because Chromium
 * lowercases the host of a standard scheme; `v` (the entry's `updated`) busts the cache when the file changes.
 */
export function mediaUrl(key: string, file: MediaFile, version?: string): string {
  const url = new URL(`${MEDIA_SCHEME}://video/`)
  url.search = new URLSearchParams({ key, file, v: version ?? '' }).toString()
  return url.toString()
}

/** The entry key and file named by a media URL, or null for anything that isn't one (NV·T2). */
export function parseMediaUrl(url: string): { key: string; file: MediaFile } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== 'video') return null
  const key = parsed.searchParams.get('key')
  const file = parsed.searchParams.get('file')
  if (!key || !file || !FILES.includes(file)) return null
  return { key, file: file as MediaFile }
}

/** Which files of an entry exist on disk: the `media:info` IPC result (02). */
export interface MediaInfo {
  compressed: boolean
  source: boolean
}

/**
 * The byte range an HTTP `Range` header asks for (NV·T2). Null means no usable header (serve the whole file with
 * 200); 'unsatisfiable' means answer 416. Only the first range of a multi-range header is used; Chromium's media
 * stack never sends more than one.
 */
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(header)
  if (!match || match[1].toLowerCase() !== 'bytes') return null
  const spec = /^(\d*)-(\d*)$/.exec(match[2].split(',')[0].trim())
  if (!spec || (spec[1] === '' && spec[2] === '')) return 'unsatisfiable'

  let start: number
  let end: number
  if (spec[1] === '') {
    // Suffix range: the last N bytes.
    const length = Number(spec[2])
    if (length === 0) return 'unsatisfiable'
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(spec[1])
    end = spec[2] === '' ? size - 1 : Math.min(Number(spec[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska'
}

/** Content-Type for a recording by extension (NV·T2); unknown types are left for Chromium to sniff. */
export function videoContentType(path: string): string {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1].toLowerCase() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}
