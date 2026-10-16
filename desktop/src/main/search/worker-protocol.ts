/** Messages main sends the search worker (SS·T9). Every request carries an `id` its reply echoes. */
export type WorkerRequest =
  /** Sets the folder the model is loaded from; the load itself waits for the first `embed`. */
  | { type: 'load'; id: number; modelDir: string }
  | { type: 'embed'; id: number; texts: string[]; kind: 'doc' | 'query' }
  /** Unloads the model and exits. */
  | { type: 'dispose'; id: number }

/** `vectors` is `texts.length × 768` L2-normalised floats, rows in request order. */
export type WorkerReply =
  { id: number; ok: true; vectors?: Float32Array } | { id: number; ok: false; error: string }
