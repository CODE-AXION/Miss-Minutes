import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import {
  MEDIA_SCHEME,
  parseMediaUrl,
  parseRange,
  videoContentType,
  type MediaFile,
  type MediaInfo
} from '@shared/media'
import type { VideoEntry } from '@shared/protocol'
import { inside } from './files'

/** Privileges for `mm-media` (NV·T4); must run before app `ready`. `stream` lets Chromium seek with Range requests. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ])
}

/**
 * The file to play for an entry, resolved from the index only (NV·T5), or null. Compressed encodes must live in
 * library/compressed (only those are ours, as in watcher.py); the source must be the path the entry is keyed by.
 */
export async function resolveMediaPath(
  videos: Record<string, VideoEntry>,
  library: string,
  key: string,
  file: MediaFile
): Promise<string | null> {
  const entry = Object.hasOwn(videos, key) ? videos[key] : undefined
  if (!entry) return null
  let path: string
  if (file === 'compressed') {
    if (!entry.compressed) return null
    try {
      path = inside(join(library, 'compressed'), entry.compressed)
    } catch {
      return null
    }
  } else {
    if (entry.source !== key) return null
    path = entry.source
  }
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0 ? path : null
  } catch {
    return null
  }
}

/** Which playable files exist for the entry: the `media:info` IPC (NV·T5). */
export async function mediaInfo(
  videos: Record<string, VideoEntry>,
  library: string,
  key: string
): Promise<MediaInfo> {
  const [compressed, source] = await Promise.all([
    resolveMediaPath(videos, library, key, 'compressed'),
    resolveMediaPath(videos, library, key, 'source')
  ])
  return { compressed: compressed !== null, source: source !== null }
}

/**
 * Serves `mm-media://` (NV·T6): one byte range per request with a manual 206, streamed from disk. Getters are read on
 * every request, so index and library changes apply without registering again. Must run before the window loads.
 */
export function handleMedia(
  getVideos: () => Record<string, VideoEntry>,
  getLibrary: () => string,
  onError: (text: string) => void
): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    const target = parseMediaUrl(request.url)
    if (!target) return new Response(null, { status: 400 })
    try {
      const path = await resolveMediaPath(getVideos(), getLibrary(), target.key, target.file)
      if (!path) return new Response(null, { status: 404 })

      const { size } = await stat(path)
      const range = parseRange(request.headers.get('range'), size)
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Type': videoContentType(path),
        'Cache-Control': 'no-store'
      })
      if (range === 'unsatisfiable') {
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }

      const { start, end } = range ?? { start: 0, end: size - 1 }
      headers.set('Content-Length', String(end - start + 1))
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      const status = range ? 206 : 200
      if (request.method === 'HEAD') return new Response(null, { status, headers })
      // toWeb destroys the file stream when Chromium cancels the request (every seek does), closing the handle.
      const body = Readable.toWeb(createReadStream(path, { start, end }))
      return new Response(body as ReadableStream, { status, headers })
    } catch (error) {
      onError(`media: ${(error as Error).message}`)
      return new Response(null, { status: 500 })
    }
  })
}
