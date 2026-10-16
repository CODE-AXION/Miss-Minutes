import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChecksumError,
  deleteModel,
  downloadModel,
  MODEL_BYTES,
  MODEL_FILES,
  MODEL_ID,
  modelDir,
  REVISION,
  type ModelFile
} from './model'

const bytes = (n: number, seed: number): Buffer =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256))
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const CONTENT: Record<string, Buffer> = { 'a.json': bytes(300, 1), 'onnx/b.onnx': bytes(5_000, 2) }
const FILES: ModelFile[] = Object.entries(CONTENT).map(([path, b]) => ({
  path,
  size: b.length,
  sha256: sha(b)
}))

interface Call {
  url: string
  range: string | null
}

/** A fake Hugging Face: serves CONTENT, honours `Range`, and can fail or corrupt on demand. */
function server(opts: { failFirst?: number; corrupt?: string; ignoreRange?: boolean } = {}): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  let failures = opts.failFirst ?? 0
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const range = new Headers(init?.headers).get('Range')
    calls.push({ url, range })
    if (failures-- > 0) throw new TypeError('fetch failed')
    const path = url.split(`/resolve/${REVISION}/`)[1]
    const body = Buffer.from(CONTENT[path])
    if (path === opts.corrupt) body[body.length - 1] ^= 0xff
    const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    return new Response(new Uint8Array(body.subarray(from)), { status: from ? 206 : 200 })
  }
  return { fetch: fake as typeof fetch, calls }
}

let dir: string
const fileAt = (path: string): string => join(dir, MODEL_ID, path)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-model-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pinned model files', () => {
  it('are the five files of a text-only q4 load, about 207 MB', () => {
    expect(MODEL_FILES.map((f) => f.path)).toEqual([
      'config.json',
      'tokenizer_config.json',
      'tokenizer.json',
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx_data'
    ])
    expect(MODEL_FILES.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(Math.round(MODEL_BYTES / 1e6)).toBe(207)
  })

  it('live under userData/models/embeddinggemma-2/<revision>', () => {
    expect(modelDir(join('C:', 'u'))).toBe(join('C:', 'u', 'models', 'embeddinggemma-2', REVISION))
  })
})

describe('downloadModel', () => {
  it('downloads every file from the pinned revision and reports progress up to the total', async () => {
    const { fetch, calls } = server()
    const progress: number[] = []
    await downloadModel(dir, { fetch, files: FILES, onProgress: (p) => progress.push(p.bytes) })
    for (const f of FILES) expect(await readFile(fileAt(f.path))).toEqual(CONTENT[f.path])
    expect(calls.map((c) => c.url)).toEqual(
      FILES.map((f) => `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${f.path}`)
    )
    expect(progress.at(-1)).toBe(5_300)
  })

  it('skips files already in place', async () => {
    await downloadModel(dir, { fetch: server().fetch, files: FILES })
    const { fetch, calls } = server()
    await downloadModel(dir, { fetch, files: FILES })
    expect(calls).toEqual([])
  })

  it('resumes a .part with a Range request', async () => {
    const part = `${fileAt('onnx/b.onnx')}.part`
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, CONTENT['onnx/b.onnx'].subarray(0, 1_234))
    const { fetch, calls } = server()
    await downloadModel(dir, { fetch, files: FILES })
    expect(calls.find((c) => c.url.endsWith('b.onnx'))?.range).toBe('bytes=1234-')
    expect(await readFile(fileAt('onnx/b.onnx'))).toEqual(CONTENT['onnx/b.onnx'])
  })

  it('starts over when the server ignores the Range', async () => {
    const part = `${fileAt('onnx/b.onnx')}.part`
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, CONTENT['onnx/b.onnx'].subarray(0, 1_234))
    await downloadModel(dir, { fetch: server({ ignoreRange: true }).fetch, files: FILES })
    expect(await readFile(fileAt('onnx/b.onnx'))).toEqual(CONTENT['onnx/b.onnx'])
  })

  it('deletes a file that fails its checksum and throws "checksum mismatch"', async () => {
    const run = downloadModel(dir, {
      fetch: server({ corrupt: 'onnx/b.onnx' }).fetch,
      files: FILES
    })
    await expect(run).rejects.toBeInstanceOf(ChecksumError)
    await expect(run).rejects.toThrow('checksum mismatch')
    expect(existsSync(fileAt('onnx/b.onnx'))).toBe(false)
    expect(existsSync(`${fileAt('onnx/b.onnx')}.part`)).toBe(false)
  })

  it('catches a tampered .part on resume', async () => {
    const part = `${fileAt('onnx/b.onnx')}.part`
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, bytes(1_000, 99))
    await expect(downloadModel(dir, { fetch: server().fetch, files: FILES })).rejects.toThrow(
      'checksum mismatch'
    )
    expect(existsSync(part)).toBe(false)
  })

  it('retries a network error, then gives up after 3 attempts', async () => {
    const flaky = server({ failFirst: 1 })
    await downloadModel(dir, { fetch: flaky.fetch, files: FILES })
    expect(flaky.calls.length).toBe(FILES.length + 1)

    await rm(dir, { recursive: true, force: true })
    const down = server({ failFirst: 99 })
    await expect(downloadModel(dir, { fetch: down.fetch, files: FILES })).rejects.toThrow(
      'fetch failed'
    )
    expect(down.calls.length).toBe(3)
  }, 15_000)

  it('stops when aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { fetch } = server({ failFirst: 1 })
    await expect(downloadModel(dir, { fetch, files: FILES, signal: ctl.signal })).rejects.toThrow()
  })
})

describe('deleteModel', () => {
  it('removes every downloaded revision', async () => {
    const root = join(dir, 'models', 'embeddinggemma-2')
    await mkdir(join(root, 'old'), { recursive: true })
    await deleteModel(dir)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(dir, 'models'))).toBe(true)
  })
})
