import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import type { Memory } from '../src/types.ts';

// A throwaway store on a temp file, cleaned up when the test ends.
function makeStore(t: { after: (fn: () => void) => void }): { store: MemoryStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-store-'));
  const dbPath = join(dir, 'memory.db');
  const store = new MemoryStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dbPath };
}

let clock = 1_700_000_000_000;
function mem(overrides: Partial<Memory> = {}): Memory {
  clock += 1000;
  return {
    id: randomUUID(),
    content: 'a plain fact worth remembering',
    type: 'decision',
    anchors: [],
    tags: [],
    status: 'active',
    supersededBy: null,
    source: null,
    createdAt: clock,
    updatedAt: clock,
    ...overrides,
  };
}

// L2-normalize so dot product == cosine similarity (what the store assumes).
function unit(arr: number[]): Float32Array {
  const mag = Math.hypot(...arr) || 1;
  return Float32Array.from(arr.map((x) => x / mag));
}

// Count rows in the FTS shadow table via an independent connection — the store
// deliberately doesn't expose this, but the desync invariant is about it.
function ftsCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get();
    return Number(r?.n);
  } finally {
    db.close();
  }
}

test('round-trip: an added memory is retrievable by id and by keyword', (t) => {
  const { store } = makeStore(t);
  const m = mem({ content: 'the parser uses a recursive descent strategy', tags: ['parser'] });
  store.add(m);

  const got = store.get(m.id);
  assert.ok(got);
  assert.equal(got.content, m.content);
  assert.equal(got.type, 'decision');
  assert.deepEqual(got.tags, ['parser']);

  const hits = store.search('recursive parser');
  assert.equal(hits[0]?.id, m.id);
});

test('rollback: a failure during the FTS insert leaves memories and FTS in sync', (t) => {
  const { store, dbPath } = makeStore(t);
  store.add(mem({ content: 'a clean prior memory' })); // baseline row in both tables
  const before = store.count();
  assert.equal(ftsCount(dbPath), before);

  // Poison the second statement: JSON.stringify (the memories insert, statement
  // one) skips function-valued props, so that row inserts fine — but the FTS
  // insert evaluates anchors.join(' '), which calls toString and throws. The
  // memories row must roll back, or we'd have memories without its FTS row.
  const poison = { toString() { throw new Error('boom'); } };
  const bad = mem({ anchors: [poison as unknown as string] });

  assert.throws(() => store.add(bad), /boom/);

  assert.equal(store.count(), before, 'memories row was rolled back');
  assert.equal(ftsCount(dbPath), before, 'no orphan FTS row left behind');
  assert.equal(store.get(bad.id), null, 'the failed memory is not retrievable');
});

test('coercion: a corrupt memory type throws on read (asMemoryType)', (t) => {
  const { store, dbPath } = makeStore(t);
  const id = randomUUID();
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    `INSERT INTO memories (id, content, type, anchors, tags, status, created_at, updated_at)
     VALUES (?, 'x', 'bogus-type', '[]', '[]', 'active', 1, 1)`,
  ).run(id);
  raw.close();

  assert.throws(() => store.get(id), /unknown memory type/);
});

test('coercion: a corrupt status throws on read (asStatus)', (t) => {
  const { store, dbPath } = makeStore(t);
  const id = randomUUID();
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    `INSERT INTO memories (id, content, type, anchors, tags, status, created_at, updated_at)
     VALUES (?, 'x', 'decision', '[]', '[]', 'weird', 1, 1)`,
  ).run(id);
  raw.close();

  assert.throws(() => store.get(id), /unknown status/);
});

test('coercion: a non-TEXT value where TEXT is expected throws (asString)', (t) => {
  const { store, dbPath } = makeStore(t);
  const id = randomUUID();
  const raw = new DatabaseSync(dbPath);
  // TEXT affinity quietly coerces numbers to strings, so a BLOB is the only way
  // a non-string reaches asString — affinity leaves BLOBs untouched.
  raw.prepare(
    `INSERT INTO memories (id, content, type, anchors, tags, status, created_at, updated_at)
     VALUES (?, x'0500', 'decision', '[]', '[]', 'active', 1, 1)`,
  ).run(id);
  raw.close();

  assert.throws(() => store.get(id), /expected TEXT/);
});

test('coercion: a non-numeric value where numeric is expected throws (asNumber)', (t) => {
  const { store, dbPath } = makeStore(t);
  const id = randomUUID();
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    `INSERT INTO memories (id, content, type, anchors, tags, status, created_at, updated_at)
     VALUES (?, 'x', 'decision', '[]', '[]', 'active', 'not-a-number', 1)`,
  ).run(id);
  raw.close();

  assert.throws(() => store.get(id), /expected numeric/);
});

test('resolveId: a short prefix resolves to the full id', (t) => {
  const { store } = makeStore(t);
  const m = mem();
  store.add(m);
  const short = m.id.slice(0, 8);
  assert.equal(store.resolveId(short), m.id);
  assert.equal(store.resolveId(m.id), m.id, 'a full id resolves to itself');
});

test('resolveId: an ambiguous prefix returns null', (t) => {
  const { store } = makeStore(t);
  store.add(mem({ id: 'pre111-aaaa' }));
  store.add(mem({ id: 'pre222-bbbb' }));
  assert.equal(store.resolveId('pre'), null, 'matches two → ambiguous → null');
  assert.equal(store.resolveId('pre111'), 'pre111-aaaa', 'a unique prefix still resolves');
  assert.equal(store.resolveId('nope'), null, 'no match → null');
});

test("resolveId: '_' in a prefix is matched literally, not as a wildcard", (t) => {
  const { store } = makeStore(t);
  store.add(mem({ id: 'a_c' }));
  store.add(mem({ id: 'axc' }));
  // Unescaped, LIKE 'a_%' would match BOTH 'a_c' and 'axc' (→ ambiguous null).
  // Escaped, '_' is literal, so only 'a_c' matches.
  assert.equal(store.resolveId('a_'), 'a_c');
});

test("resolveId: '%' in a prefix is matched literally, not as a wildcard", (t) => {
  const { store } = makeStore(t);
  store.add(mem({ id: 'a%c' }));
  store.add(mem({ id: 'axyzc' }));
  assert.equal(store.resolveId('a%'), 'a%c');
});

test('forget with an escaped-wildcard prefix deletes only the literal match', (t) => {
  const { store, dbPath } = makeStore(t);
  store.add(mem({ id: 'a_c' }));
  store.add(mem({ id: 'axc' }));

  assert.equal(store.forget(store.resolveId('a_') ?? ''), true);
  assert.equal(store.get('a_c'), null, 'the literal match is gone');
  assert.ok(store.get('axc'), 'the wildcard-only match survives');
  assert.equal(store.count(), ftsCount(dbPath), 'memories and FTS stay in sync after forget');
});

test('vectorSearch: ranks by cosine and respects the model filter and dimensions', (t) => {
  const { store } = makeStore(t);
  const a = mem();
  const b = mem();
  const c = mem();
  const other = mem();
  const wrongDim = mem();
  store.add(a, unit([1, 0, 0]), 'test');
  store.add(b, unit([0, 1, 0]), 'test');
  store.add(c, unit([0.9, 0.1, 0]), 'test');
  store.add(other, unit([1, 0, 0]), 'other-model'); // perfect match, wrong model
  store.add(wrongDim, unit([1, 0]), 'test'); // right model, wrong dimensions

  const ranked = store.vectorSearch(unit([1, 0, 0]), { model: 'test' });
  const ids = ranked.map((r) => r.id);

  assert.equal(ids[0], a.id, 'closest vector ranks first');
  assert.equal(ids[1], c.id, 'next-closest ranks second');
  assert.equal(ids[ids.length - 1], b.id, 'orthogonal vector ranks last');
  assert.ok(!ids.includes(other.id), 'a different embed model is excluded');
  assert.ok(!ids.includes(wrongDim.id), 'a dimension mismatch is skipped');
});

test('search and recent ignore superseded memories and honor the type filter', (t) => {
  const { store } = makeStore(t);
  const old = mem({ content: 'old approach using global state' });
  const fresh = mem({ content: 'new approach using dependency injection' });
  const pref = mem({ content: 'user prefers tabs', type: 'preference' });
  store.add(old);
  store.add(fresh);
  store.add(pref);
  store.supersede(old.id, fresh.id, clock);

  const active = store.recent();
  assert.ok(!active.some((m) => m.id === old.id), 'superseded memory is not listed');

  const decisions = store.recent({ type: 'decision' });
  assert.ok(decisions.every((m) => m.type === 'decision'));
  assert.ok(!decisions.some((m) => m.id === pref.id));

  const hits = store.search('approach', { type: 'decision' });
  assert.ok(hits.some((h) => h.id === fresh.id));
  assert.ok(!hits.some((h) => h.id === old.id), 'superseded rows excluded from search');
});
