import { createReadStream, createWriteStream } from 'fs'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { Settings, UploadProgress, UploadResult } from '@shared/api'
import type { State } from './state'
import type { Supervisor } from './worker'

const PROGRESS_MS = 200

const stemOf = (file: string): string => basename(file, extname(file)).toLowerCase()
const samePath = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * Videos added from the app: copied to library/uploads as *.part (scans ignore it), renamed when complete, then
 * queued with `enqueue`, which puts them first. Uploads skip the settle wait (02).
 */
export class Uploads {
  /** One copy at a time, in the order they were added. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private state: State,
    private supervisor: Supervisor,
    private getSettings: () => Settings,
    private onProgress: (progress: UploadProgress) => void
  ) {}

  add(paths: string[]): Promise<UploadResult[]> {
    if (!Array.isArray(paths)) return Promise.reject(new Error('Expected a list of files'))
    const run = async (): Promise<UploadResult[]> => {
      const results: UploadResult[] = []
      for (const path of paths) results.push(await this.addOne(path))
      return results
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  private async addOne(path: string): Promise<UploadResult> {
    try {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Not a file path')
      const extensions = this.state.hello?.video_extensions
      if (!extensions) throw new Error('The worker has not started yet; try again in a moment')
      if (!extensions.includes(extname(path).toLowerCase()))
        throw new Error(`Not a video file (${extensions.join(' ')})`)
      const source = await stat(path)
      if (!source.isFile()) throw new Error('Not a file')

      const settings = this.getSettings()
      const uploadsDir = join(settings.library, 'uploads')
      // Already where the worker looks: queue it in place instead of making a second copy.
      if (samePath(dirname(path), settings.watchDir) || samePath(dirname(path), uploadsDir)) {
        return { path, ...(await this.enqueue(path)) }
      }

      await mkdir(uploadsDir, { recursive: true })
      const dest = join(uploadsDir, await this.uniqueName(path, settings))
      const part = `${dest}.part`
      try {
        await this.copy(path, part, source.size)
        await utimes(part, source.atime, source.mtime) // recorded_at falls back to the mtime
        await rename(part, dest)
      } catch (error) {
        await unlink(part).catch(() => {})
        throw error
      }
      return { path, ...(await this.enqueue(dest)) }
    } catch (error) {
      return { path, ok: false, error: (error as Error).message }
    }
  }

  private async enqueue(dest: string): Promise<Omit<UploadResult, 'path'>> {
    if (!this.supervisor.up) {
      return {
        ok: true,
        dest,
        warning: 'Copied; it will be queued when the worker is running again.'
      }
    }
    try {
      const ack = await this.supervisor.send({ cmd: 'enqueue', path: dest })
      if (!ack.ok) return { ok: false, dest, error: ack.error }
      return { ok: true, dest, warning: ack.warning }
    } catch (error) {
      return { ok: true, dest, warning: `Copied, but not queued yet: ${(error as Error).message}` }
    }
  }

  /**
   * `<stem> (2)`, `(3)`, … when the stem is already used by an entry, an upload or an encode: the worker reuses
   * compressed/<stem>.mp4, so a clash would hand this video another recording's encode.
   */
  private async uniqueName(path: string, settings: Settings): Promise<string> {
    const taken = new Set(Object.keys(this.state.videos).map(stemOf))
    for (const folder of ['uploads', 'compressed']) {
      const files = await readdir(join(settings.library, folder)).catch(() => [] as string[])
      for (const file of files) taken.add(stemOf(file.replace(/\.part$/i, '')))
    }
    const ext = extname(path)
    const stem = basename(path, ext)
    let candidate = stem
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})`
    return candidate + ext
  }

  private async copy(from: string, to: string, total: number): Promise<void> {
    let copied = 0
    let last = 0
    const report = (): void => this.onProgress({ path: from, copied, total })
    const counter = new Transform({
      transform(chunk: Buffer, _, done) {
        copied += chunk.length
        if (Date.now() - last >= PROGRESS_MS) {
          last = Date.now()
          report()
        }
        done(null, chunk)
      }
    })
    report()
    await pipeline(createReadStream(from), counter, createWriteStream(to))
    report()
  }
}
