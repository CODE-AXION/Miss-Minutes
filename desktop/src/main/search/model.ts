import { createHash, type Hash } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, open, rename, rm, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type { ModelInfo } from './store'

export const MODEL_ID = 'onnx-community/embeddinggemma-2-ONNX'
/** The Hugging Face commit every file is downloaded from (pinned 2026-10-16). */
export const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
export const DTYPE = 'q4'
export const DIM = 768

/** What the store records, so vectors made by another model or revision are never mixed in. */
export const MODEL_INFO: ModelInfo = { id: MODEL_ID, revision: REVISION, dtype: DTYPE, dim: DIM }

export interface ModelFile {
  path: string
  size: number
  sha256: string
}

/** Everything a text-only q4 load reads (the vision/audio encoders and the other dtypes are never fetched). */
export const MODEL_FILES: readonly ModelFile[] = [
  {
    path: 'config.json',
    size: 5_031,
    sha256: '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d'
  },
  {
    path: 'tokenizer_config.json',
    size: 1_599,
    sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874'
  },
  {
    path: 'tokenizer.json',
    size: 32_170_510,
    sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4'
  },
  {
    path: 'onnx/model_q4.onnx',
    size: 490_742,
    sha256: 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9'
  },
  {
    path: 'onnx/model_q4.onnx_data',
    size: 174_028_800,
    sha256: 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49'
  }
]

export const MODEL_BYTES = MODEL_FILES.reduce((sum, f) => sum + f.size, 0)

const ATTEMPTS = 3
const BACKOFF_MS = [1_000, 4_000]
const PROGRESS_EVERY_MS = 200

/** `<userData>/models/embeddinggemma-2`: everything "Also delete downloaded files" removes. */
export function modelsRoot(userData: string): string {
  return join(userData, 'models', 'embeddinggemma-2')
}

/** The folder `env.localModelPath` points at; the files live in `<modelDir>/<MODEL_ID>/…`. Always computed in main. */
export function modelDir(userData: string): string {
  return join(modelsRoot(userData), REVISION)
}

const fileOf = (dir: string, f: ModelFile): string => join(dir, MODEL_ID, f.path)

/** True when every file is in place at its expected size (its sha256 was checked before it was renamed into place). */
export async function isModelPresent(dir: string): Promise<boolean> {
  for (const f of MODEL_FILES) if ((await sizeOf(fileOf(dir, f))) !== f.size) return false
  return true
}

/** A downloaded file doesn't match its pinned sha256 (shown as "Download failed: checksum mismatch"). */
export class ChecksumError extends Error {
  constructor() {
    super('checksum mismatch')
  }
}

export interface DownloadProgress {
  bytes: number
  total: number
}

export interface DownloadOptions {
  /** Electron `net.fetch` in the app (Chromium's proxy resolution); plain `fetch` in tests. */
  fetch: typeof fetch
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
  /** Tests only: download these instead of the pinned model files. */
  files?: readonly ModelFile[]
}

/**
 * Downloads the pinned model files into `dir` (SS·T8). Each file streams to `<file>.part` while being hashed, resumes
 * with a Range request when a `.part` is already there, and is renamed into place only when its sha256 matches. A
 * mismatch deletes the `.part` and throws `ChecksumError`; network errors are retried 3 times with backoff.
 * Progress counts bytes across all files (about 207 MB).
 */
export async function downloadModel(dir: string, opts: DownloadOptions): Promise<void> {
  const files = opts.files ?? MODEL_FILES
  const total = files.reduce((sum, f) => sum + f.size, 0)
  let done = 0
  let last = 0
  const report = (current: number, force = false): void => {
    const now = Date.now()
    if (!force && now - last < PROGRESS_EVERY_MS) return
    last = now
    opts.onProgress?.({ bytes: done + current, total })
  }
  for (const f of files) {
    const target = fileOf(dir, f)
    if ((await sizeOf(target)) !== f.size) {
      await mkdir(dirname(target), { recursive: true })
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadFile(f, target, opts, report)
          break
        } catch (err) {
          if (err instanceof ChecksumError || opts.signal?.aborted || attempt >= ATTEMPTS) throw err
          await delay(BACKOFF_MS[attempt - 1], opts.signal)
        }
      }
    }
    done += f.size
    report(0, true)
  }
}

async function downloadFile(
  f: ModelFile,
  target: string,
  opts: DownloadOptions,
  report: (current: number) => void
): Promise<void> {
  const part = `${target}.part`
  let have = (await sizeOf(part)) ?? 0
  if (have > f.size) {
    await rm(part, { force: true })
    have = 0
  }
  let hash = createHash('sha256')
  if (have > 0) await hashFile(part, hash)
  if (have < f.size) {
    const url = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${f.path}`
    const res = await opts.fetch(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      signal: opts.signal
    })
    if (!(res.status === 200 || res.status === 206) || !res.body)
      throw new Error(`HTTP ${res.status} for ${f.path}`)
    if (res.status === 200 && have > 0) {
      // The server ignored the Range: the body is the whole file, so start the .part over.
      have = 0
      hash = createHash('sha256')
    }
    have = await appendBody(res.body, part, have, hash, report)
    if (have !== f.size) throw new Error(`incomplete download of ${f.path}`)
  }
  if (hash.digest('hex') !== f.sha256) {
    await rm(part, { force: true })
    throw new ChecksumError()
  }
  await rename(part, target)
}

/** Writes the response body after the first `have` bytes of `part`, hashing as it goes; returns the new size. */
async function appendBody(
  body: ReadableStream<Uint8Array>,
  part: string,
  have: number,
  hash: Hash,
  report: (current: number) => void
): Promise<number> {
  const fh = await open(part, have > 0 ? 'a' : 'w')
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      await fh.write(chunk)
      hash.update(chunk)
      have += chunk.byteLength
      report(have)
    }
  } finally {
    await fh.close()
  }
  return have
}

function hashFile(path: string, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
}

/** Removes every downloaded revision (decision 2's "Also delete downloaded files"). */
export function deleteModel(userData: string): Promise<void> {
  return rm(modelsRoot(userData), { recursive: true, force: true })
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}
