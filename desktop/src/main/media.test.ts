import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VideoEntry } from '@shared/protocol'
import { mediaInfo, resolveMediaPath } from './media'

let root: string
let library: string
let source: string
let compressed: string

const entry = (patch: Partial<VideoEntry> = {}): VideoEntry => ({
  source,
  status: 'done',
  recorded: '2026-01-01T00:00:00',
  attempts: 1,
  updated: '2026-01-01T00:00:00',
  compressed,
  ...patch
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mm-media-'))
  library = join(root, 'library')
  await mkdir(join(library, 'compressed'), { recursive: true })
  source = join(root, 'recording.mkv')
  compressed = join(library, 'compressed', 'recording.mp4')
  await writeFile(source, 'source bytes')
  await writeFile(compressed, 'compressed bytes')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveMediaPath', () => {
  it('resolves both files of a known entry', async () => {
    const videos = { [source]: entry() }
    expect(await resolveMediaPath(videos, library, source, 'compressed')).toBe(compressed)
    expect(await resolveMediaPath(videos, library, source, 'source')).toBe(source)
  })

  it('rejects unknown keys, including inherited properties', async () => {
    const videos = { [source]: entry() }
    expect(await resolveMediaPath(videos, library, 'C:\\other.mp4', 'source')).toBeNull()
    expect(await resolveMediaPath(videos, library, 'constructor', 'source')).toBeNull()
  })

  it('rejects a compressed path outside library/compressed', async () => {
    const outside = join(root, 'elsewhere.mp4')
    await writeFile(outside, 'bytes')
    const videos = { [source]: entry({ compressed: outside }) }
    expect(await resolveMediaPath(videos, library, source, 'compressed')).toBeNull()
  })

  it('rejects a source that is not the entry key', async () => {
    const videos = { [source]: entry({ source: compressed }) }
    expect(await resolveMediaPath(videos, library, source, 'source')).toBeNull()
  })

  it('rejects missing, empty and directory paths', async () => {
    await writeFile(compressed, '')
    const videos = { [source]: entry() }
    expect(await resolveMediaPath(videos, library, source, 'compressed')).toBeNull()
    const dir = { [source]: entry({ compressed: join(library, 'compressed', 'sub') }) }
    await mkdir(join(library, 'compressed', 'sub'))
    expect(await resolveMediaPath(dir, library, source, 'compressed')).toBeNull()
    await rm(source)
    expect(await resolveMediaPath(videos, library, source, 'source')).toBeNull()
  })
})

describe('mediaInfo', () => {
  it('reports which files exist', async () => {
    expect(await mediaInfo({ [source]: entry() }, library, source)).toEqual({
      compressed: true,
      source: true
    })
    expect(await mediaInfo({ [source]: entry({ compressed: null }) }, library, source)).toEqual({
      compressed: false,
      source: true
    })
    await rm(source)
    expect(await mediaInfo({ [source]: entry({ compressed: null }) }, library, source)).toEqual({
      compressed: false,
      source: false
    })
  })
})
