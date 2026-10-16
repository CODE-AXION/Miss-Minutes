import { Encoder } from './encoder'
import type { WorkerReply, WorkerRequest } from './worker-protocol'

/** Unload after this long without work, to free about 300 MB; the next request reloads it in about 0.5 s. */
const IDLE_MS = 10 * 60_000

type EmbedRequest = Extract<WorkerRequest, { type: 'embed' }>

let modelDir: string | null = null
let encoder: Promise<Encoder> | null = null
let idleTimer: NodeJS.Timeout | null = null
/** Waiting embeds; queries jump ahead of document batches so a search isn't stuck behind a backfill. */
const queue: EmbedRequest[] = []
let busy = false

const reply = (msg: WorkerReply): void => process.parentPort.postMessage(msg)
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The search worker's entry point (SS·T9): runs in a utilityProcess so embedding never blocks the window. */
process.parentPort.on('message', (e) => {
  const msg = e.data as WorkerRequest
  switch (msg.type) {
    case 'load':
      modelDir = msg.modelDir
      reply({ id: msg.id, ok: true })
      return
    case 'embed':
      if (msg.kind === 'query') {
        const at = queue.findIndex((q) => q.kind !== 'query')
        queue.splice(at === -1 ? queue.length : at, 0, msg)
      } else queue.push(msg)
      void drain()
      return
    case 'dispose':
      void unload().finally(() => {
        reply({ id: msg.id, ok: true })
        process.exit(0)
      })
  }
})

async function drain(): Promise<void> {
  if (busy) return
  busy = true
  if (idleTimer) clearTimeout(idleTimer)
  try {
    for (let req = queue.shift(); req; req = queue.shift()) {
      try {
        const vectors = await (await getEncoder()).embed(req.texts)
        reply({ id: req.id, ok: true, vectors })
      } catch (err) {
        reply({ id: req.id, ok: false, error: message(err) })
      }
    }
  } finally {
    busy = false
    idleTimer = setTimeout(() => void unload(), IDLE_MS)
  }
}

function getEncoder(): Promise<Encoder> {
  if (!modelDir) return Promise.reject(new Error('Search model folder not set'))
  encoder ??= Encoder.load(modelDir).catch((err) => {
    encoder = null // a failed load is retried on the next request
    throw err
  })
  return encoder
}

async function unload(): Promise<void> {
  const loading = encoder
  encoder = null
  if (loading) await (await loading.catch(() => null))?.dispose()
}
