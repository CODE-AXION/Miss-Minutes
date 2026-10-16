import {
  AutoConfig,
  AutoModel,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor
} from '@huggingface/transformers'
import { DIM, DTYPE, MODEL_ID } from './model'

const MAX_TOKENS = 1024

/**
 * EmbeddingGemma 2's text encoder, loaded from disk only (SS·T9). Used inside the search worker; kept apart from the
 * message protocol so it also runs in plain Node for checks.
 */
export class Encoder {
  private constructor(
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly model: PreTrainedModel
  ) {}

  /** Loads the q4 text encoder from `modelDir` (a folder computed in main, never one a renderer supplied). */
  static async load(modelDir: string): Promise<Encoder> {
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = modelDir
    const config = await AutoConfig.from_pretrained(MODEL_ID)
    // Text only: without these the vision and audio encoders would be loaded too.
    const multimodal = config as unknown as { vision_config: unknown; audio_config: unknown }
    multimodal.vision_config = multimodal.audio_config = null
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
    const model = await AutoModel.from_pretrained(MODEL_ID, { config, device: 'cpu', dtype: DTYPE })
    return new Encoder(tokenizer, model)
  }

  /** `texts.length × 768` L2-normalised rows. Callers add the model-card prefixes. */
  async embed(texts: string[]): Promise<Float32Array> {
    const inputs = this.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: MAX_TOKENS
    })
    const out = (await this.model(inputs)) as Record<string, Tensor>
    const tensor = out.sentence_embedding
    const rows = new Float32Array(tensor.data as Float32Array)
    for (const t of Object.values(out)) t.dispose()
    if (rows.length !== texts.length * DIM)
      throw new Error(`Unexpected embedding size ${tensor.dims.join('×')}`)
    for (let r = 0; r < texts.length; r++) {
      const row = rows.subarray(r * DIM, (r + 1) * DIM)
      let norm = 0
      for (const x of row) norm += x * x
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < DIM; i++) row[i] /= norm
    }
    return rows
  }

  async dispose(): Promise<void> {
    await this.model.dispose()
  }
}
