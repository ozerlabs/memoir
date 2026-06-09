import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.ts';
import { LocalEmbedder, type Embedder } from './embed.ts';
import type { Memory, MemoryType, MemorySource, RecallResult } from './types.ts';

// Find the nearest .memoir/ walking up from `start`, the way git finds .git.
// Any session opening this repo finds the same memory.
function findRoot(start: string): string | null {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, '.memoir'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// What we embed for a memory: its content plus the anchors/tags it lives near.
function docText(m: { content: string; anchors: string[]; tags: string[] }): string {
  return [m.content, ...m.anchors, ...m.tags].join(' ').trim();
}

// Reciprocal Rank Fusion — merge several ranked id-lists into one ranking by
// rank position, so keyword and vector results each get a vote. Higher = better.
// Exported for unit testing of the fusion ordering.
export function rrf(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export interface RememberInput {
  content: string;
  type: MemoryType;
  anchors?: string[];
  tags?: string[];
  supersedes?: string[]; // ids (full or short prefix) of memories this replaces
  source?: MemorySource;
}

export interface RememberResult {
  memory: Memory;
  superseded: string[];
  embedded: boolean;
}

export interface RecallOpts {
  limit?: number;
  type?: MemoryType;
}

export class Memoir {
  readonly root: string;
  private store: MemoryStore;
  private embedder: Embedder;

  private constructor(root: string, store: MemoryStore, embedder: Embedder) {
    this.root = root;
    this.store = store;
    this.embedder = embedder;
  }

  // Open the memory for `cwd`: discover an existing .memoir/ upward,
  // else create one right here. `embedder` is injectable so tests can supply a
  // deterministic, offline stub; production uses the local model.
  static open(cwd: string = process.cwd(), embedder: Embedder = new LocalEmbedder()): Memoir {
    const root = findRoot(cwd) ?? cwd;
    const dir = join(root, '.memoir');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return new Memoir(root, new MemoryStore(join(dir, 'memory.db')), embedder);
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const now = Date.now();
    const memory: Memory = {
      id: randomUUID(),
      content: input.content.trim(),
      type: input.type,
      anchors: input.anchors ?? [],
      tags: input.tags ?? [],
      status: 'active',
      supersededBy: null,
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
    };

    // Embed on write (best-effort; falls back to keyword-only if unavailable).
    let embedding: Float32Array | null = null;
    try {
      const [v] = await this.embedder.embed([docText(memory)], 'doc');
      embedding = v ?? null;
    } catch {
      embedding = null;
    }
    // Resolve supersede prefixes to full ids (reads) before the write tx.
    const resolved: string[] = [];
    for (const ref of input.supersedes ?? []) {
      const target = this.store.resolveId(ref);
      if (target) resolved.push(target);
    }

    // One atomic write: the new memory, its FTS row, and the supersessions.
    const superseded = this.store.add(
      memory,
      embedding,
      embedding ? this.embedder.id : null,
      resolved,
      now,
    );
    return { memory, superseded, embedded: embedding !== null };
  }

  // Hybrid recall: fuse keyword (bm25) and semantic (vector) rankings.
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult[]> {
    const limit = opts.limit ?? 5;
    const pool = Math.max(limit * 4, 20);
    const keyword = this.store.search(query, { limit: pool, type: opts.type });

    let vector: { id: string; score: number }[] = [];
    if (query.trim()) {
      try {
        const [qv] = await this.embedder.embed([query], 'query');
        if (qv) {
          vector = this.store.vectorSearch(qv, {
            limit: pool,
            type: opts.type,
            model: this.embedder.id,
          });
        }
      } catch {
        vector = [];
      }
    }

    // No embeddings available → keyword-only (the always-on floor).
    if (vector.length === 0) return keyword.slice(0, limit);

    const fused = rrf([keyword.map((r) => r.id), vector.map((v) => v.id)]).slice(0, limit);
    const results: RecallResult[] = [];
    for (const { id, score } of fused) {
      const m = this.store.get(id);
      if (m) results.push({ ...m, score });
    }
    return results;
  }

  list(opts: RecallOpts = {}): Memory[] {
    return this.store.recent(opts);
  }

  forget(idOrPrefix: string): boolean {
    const id = this.store.resolveId(idOrPrefix);
    return id ? this.store.forget(id) : false;
  }

  // Embed every active memory that lacks a vector (e.g. created before
  // embeddings existed). Returns how many were embedded.
  async backfill(onProgress?: (done: number, total: number) => void): Promise<number> {
    const pending = this.store.needingEmbedding();
    if (pending.length === 0) return 0;
    if (!(await this.embedder.available())) return 0;

    let done = 0;
    const BATCH = 16;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const vecs = await this.embedder.embed(
        batch.map((m) => docText(m)),
        'doc',
      );
      batch.forEach((m, j) => {
        const v = vecs[j];
        if (v) this.store.setEmbedding(m.id, v, this.embedder.id);
      });
      done += batch.length;
      onProgress?.(done, pending.length);
    }
    return done;
  }

  // Pre-load the embedder (model) so the first recall/remember isn't slow and
  // any one-time load logging happens before a caller starts streaming output.
  // Returns whether embeddings are available. Safe to call when they aren't.
  async warm(): Promise<boolean> {
    return this.embedder.available();
  }

  count(): number {
    return this.store.count();
  }

  close(): void {
    this.store.close();
  }
}
