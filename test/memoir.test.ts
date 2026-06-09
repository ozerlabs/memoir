import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memoir, rrf } from '../src/memoir.ts';
import type { Embedder } from '../src/embed.ts';

function unit(arr: number[]): Float32Array {
  const mag = Math.hypot(...arr) || 1;
  return Float32Array.from(arr.map((x) => x / mag));
}

// A deterministic, offline stand-in for the real model. With a vector it makes
// embeddings "available" (exercises the hybrid path); with null it reports
// unavailable and embed() returns nothing (exercises the keyword-only floor).
class StubEmbedder implements Embedder {
  readonly id = 'stub-model';
  readonly dim = 3;
  private vec: number[] | null;
  // Node runs TS in strip-only mode (no build step), so no parameter properties.
  constructor(vec: number[] | null) {
    this.vec = vec;
  }
  async available(): Promise<boolean> {
    return this.vec !== null;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const v = this.vec;
    if (v === null) return [];
    return texts.map(() => unit(v));
  }
}

function makeMemoir(t: { after: (fn: () => void) => void }, embedder: Embedder): Memoir {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-mem-'));
  const mem = Memoir.open(dir, embedder);
  t.after(() => {
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return mem;
}

test('remember → recall finds the memory (hybrid path, embeddings available)', async (t) => {
  const mem = makeMemoir(t, new StubEmbedder([1, 0, 0]));
  const { memory, embedded } = await mem.remember({
    content: 'the store is embedded SQLite living in the repo folder',
    type: 'decision',
    tags: ['storage'],
  });
  assert.equal(embedded, true, 'an embedding was produced');

  const results = await mem.recall('where does sqlite storage live');
  assert.ok(results.some((r) => r.id === memory.id), 'the memory is recalled');
});

test('recall falls back to keyword-only when embeddings are unavailable', async (t) => {
  const mem = makeMemoir(t, new StubEmbedder(null));
  const { memory, embedded } = await mem.remember({
    content: 'the parser uses recursive descent',
    type: 'gotcha',
  });
  assert.equal(embedded, false, 'no embedding when the embedder is unavailable');

  const results = await mem.recall('recursive parser');
  assert.ok(results.length >= 1, 'keyword recall still returns results');
  assert.equal(results[0]?.id, memory.id, 'the matching memory ranks first');
});

test('remember with supersedes reconciles the old memory (via short-id prefix)', async (t) => {
  const mem = makeMemoir(t, new StubEmbedder(null));
  const { memory: old } = await mem.remember({
    content: 'config lives in a global singleton',
    type: 'decision',
  });

  const { superseded } = await mem.remember({
    content: 'config is now passed by dependency injection',
    type: 'decision',
    supersedes: [old.id.slice(0, 8)], // the short id the CLI actually displays
  });

  assert.deepEqual(superseded, [old.id], 'the old memory was superseded');
  const active = mem.list();
  assert.ok(!active.some((m) => m.id === old.id), 'superseded memory drops out of listings');
});

test('forget removes a memory by short-id prefix', async (t) => {
  const mem = makeMemoir(t, new StubEmbedder(null));
  const { memory } = await mem.remember({ content: 'a fact to drop', type: 'glossary' });
  assert.equal(mem.count(), 1);

  assert.equal(mem.forget(memory.id.slice(0, 8)), true);
  assert.equal(mem.count(), 0);
  assert.equal(mem.forget('deadbeef'), false, 'a non-existent id is a no-op');
});

// --- RRF fusion, as a pure unit ----------------------------------------------

test('rrf: an item ranked high in both lists wins', () => {
  const fused = rrf([
    ['x', 'y', 'z'],
    ['x', 'z', 'y'],
  ]);
  assert.equal(fused[0]?.id, 'x', 'top-of-both ranks first');
  const score = (id: string) => fused.find((f) => f.id === id)?.score ?? 0;
  assert.ok(score('x') > score('y'), 'x outscores y');
  assert.ok(score('x') > score('z'), 'x outscores z');
});

test('rrf: presence in more lists beats a single high placement', () => {
  const fused = rrf([
    ['a', 'b'],
    ['a'],
  ]);
  // a: 1/61 + 1/61; b: 1/62 — a wins on two votes.
  assert.equal(fused[0]?.id, 'a');
  assert.equal(fused[1]?.id, 'b');
});

test('rrf: results are sorted by descending score and ids are de-duplicated', () => {
  const fused = rrf([
    ['a', 'b', 'c'],
    ['b', 'c', 'a'],
  ]);
  assert.equal(new Set(fused.map((f) => f.id)).size, fused.length, 'no duplicate ids');
  for (let i = 1; i < fused.length; i++) {
    assert.ok(fused[i - 1].score >= fused[i].score, 'monotonically non-increasing scores');
  }
});

test('rrf: an empty input yields an empty ranking', () => {
  assert.deepEqual(rrf([]), []);
  assert.deepEqual(rrf([[], []]), []);
});
