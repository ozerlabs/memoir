// Local, offline sentence embeddings. The model engine (transformers.js) is an
// OPTIONAL dependency loaded via dynamic import — if it's missing or the model
// can't be fetched, the embedder reports unavailable and memoir falls back to
// keyword-only recall. Embeddings are an enhancement, never a hard requirement.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export interface Embedder {
  readonly id: string; // model identifier, stored per-vector so we never mix models
  readonly dim: number;
  available(): Promise<boolean>;
  embed(texts: string[], kind?: 'doc' | 'query'): Promise<Float32Array[]>;
}

const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
// bge models retrieve better when the QUERY (not the stored doc) carries this
// instruction. Docs are embedded plainly.
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

export class LocalEmbedder implements Embedder {
  readonly id = MODEL;
  readonly dim = DIM;
  private pipe: FeatureExtractionPipeline | null = null;
  private failed = false;

  private async load(): Promise<FeatureExtractionPipeline | null> {
    if (this.pipe) return this.pipe;
    if (this.failed) return null;
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = true; // permit one-time model download; cached after
      this.pipe = await pipeline('feature-extraction', MODEL);
      return this.pipe;
    } catch (e) {
      this.failed = true; // module absent or model unreachable → degrade gracefully
      if (process.env.MEMOIR_DEBUG) console.error('[memoir] embeddings unavailable:', e);
      return null;
    }
  }

  async available(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  async embed(texts: string[], kind: 'doc' | 'query' = 'doc'): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    if (!extractor) return [];
    const inputs = kind === 'query' ? texts.map((t) => QUERY_INSTRUCTION + t) : texts;
    const out = await extractor(inputs, { pooling: 'mean', normalize: true });
    const list: number[][] = out.tolist();
    return list.map((v) => Float32Array.from(v));
  }
}

// Cosine similarity for L2-normalized vectors reduces to a dot product.
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
