import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

// --- anchored recall + non-creating open -------------------------------------

test('recallByAnchor finds memories by absolute path (normalized) and basename', async (t) => {
  const mem = makeMemoir(t, new StubEmbedder(null));
  const { memory } = await mem.remember({
    content: 'do not await inside this loop',
    type: 'gotcha',
    anchors: ['src/embed.ts'],
  });

  // absolute path under the root → normalized to the relative anchor
  const abs = join(mem.root, 'src', 'embed.ts');
  assert.ok(mem.recallByAnchor(abs).some((m) => m.id === memory.id), 'absolute path matches');
  // already-relative anchor
  assert.ok(mem.recallByAnchor('src/embed.ts').some((m) => m.id === memory.id), 'relative matches');
  // basename fallback: a memory anchored to bare "embed.ts" still surfaces
  const { memory: base } = await mem.remember({ content: 'bare basename note', type: 'gotcha', anchors: ['embed.ts'] });
  assert.ok(mem.recallByAnchor(abs).some((m) => m.id === base.id), 'basename fallback matches');
});

test('openExisting returns null and does NOT create a store when none exists', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-noexist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(Memoir.openExisting(dir), null, 'no .memoir → null');
  assert.equal(existsSync(join(dir, '.memoir')), false, 'and nothing was created');

  Memoir.init(dir).mem.close(); // now there is one
  const reopened = Memoir.openExisting(dir);
  assert.ok(reopened, '.memoir exists → opens');
  reopened?.close();
});

// --- init: claiming a memory root --------------------------------------------

test('init creates a store in the folder and is a clean no-op the second time', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Memoir.init(dir);
  assert.equal(first.created, true);
  assert.equal(first.shadows, null);
  assert.ok(existsSync(join(dir, '.memoir', 'memory.db')), 'memory.db is created here');
  assert.equal(first.mem.count(), 0);
  first.mem.close();

  const second = Memoir.init(dir);
  assert.equal(second.created, false, 'a second init is a no-op');
  second.mem.close();
});

test('init in a nested folder reports it is shadowing a parent .memoir', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'memoir-parent-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const child = join(parent, 'nested');
  mkdirSync(child);

  Memoir.init(parent).mem.close(); // parent now owns a .memoir
  const res = Memoir.init(child); // claim the child as its own root
  assert.equal(res.created, true);
  assert.equal(res.shadows, parent, 'the shadowed parent root is reported');
  res.mem.close();
});

// --- ANN advisory wiring + throttle ------------------------------------------

test('remember surfaces an ANN advisory on entering the band, throttled per +1k', async (t) => {
  const prev = process.env.MEMOIR_ANN_THRESHOLD;
  process.env.MEMOIR_ANN_THRESHOLD = '3'; // tiny threshold → warn floor 2
  t.after(() => {
    if (prev === undefined) delete process.env.MEMOIR_ANN_THRESHOLD;
    else process.env.MEMOIR_ANN_THRESHOLD = prev;
  });
  const mem = makeMemoir(t, new StubEmbedder(null));

  const r1 = await mem.remember({ content: 'one', type: 'state' }); // count 1 → ok
  assert.equal(r1.advisory, null, 'below the warn floor → no advisory');

  const r2 = await mem.remember({ content: 'two', type: 'state' }); // count 2 → approaching
  assert.ok(r2.advisory, 'entering the band fires an advisory');
  assert.equal(r2.advisory?.tier, 'approaching');

  const r3 = await mem.remember({ content: 'three', type: 'state' }); // count 3 → over, same bucket
  assert.equal(r3.advisory, null, 'same +1k bucket → throttled, no repeat');

  // The unthrottled status surface still reports it (this is what `where` uses).
  const live = mem.annAdvisory();
  assert.ok(live, 'annAdvisory() reflects the live count regardless of throttle');
  assert.equal(live?.tier, 'over');
});

test('an ANN threshold of 0 disables the advisory on every surface', async (t) => {
  const prev = process.env.MEMOIR_ANN_THRESHOLD;
  process.env.MEMOIR_ANN_THRESHOLD = '0';
  t.after(() => {
    if (prev === undefined) delete process.env.MEMOIR_ANN_THRESHOLD;
    else process.env.MEMOIR_ANN_THRESHOLD = prev;
  });
  const mem = makeMemoir(t, new StubEmbedder(null));

  for (let i = 0; i < 5; i++) {
    const r = await mem.remember({ content: `m${i}`, type: 'state' });
    assert.equal(r.advisory, null, 'disabled → never any write advisory');
  }
  assert.equal(mem.annAdvisory(), null, 'disabled → no status advisory either');
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
