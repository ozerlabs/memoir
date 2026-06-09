import { DatabaseSync } from 'node:sqlite';
import { dot } from './embed.ts';
import {
  isMemoryType,
  type Memory,
  type MemoryType,
  type MemorySource,
  type RecallResult,
} from './types.ts';

// One embedded SQLite file holds everything: the facts AND the keyword index.
// No server, no native deps — node:sqlite ships FTS5 in core.
// (Vector recall comes later; at a repo's memory scale, keyword + brute-force
//  cosine in JS is plenty. This is deliberately the seed.)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  type          TEXT NOT NULL,
  anchors       TEXT NOT NULL DEFAULT '[]',
  tags          TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  source        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  mid UNINDEXED,
  content,
  anchors,
  tags
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_type   ON memories(type);
`;

// The columns rowToMemory needs — never SELECT *, so the embedding BLOB is not
// dragged into keyword/list/get results that don't use it.
const MEMORY_COLS =
  'id, content, type, anchors, tags, status, superseded_by, source, created_at, updated_at';
const MEMORY_COLS_M =
  'm.id, m.content, m.type, m.anchors, m.tags, m.status, m.superseded_by, m.source, m.created_at, m.updated_at';

// A raw row as node:sqlite hands it back. Mirrors the module-internal
// SQLOutputValue (which isn't exported) so we can name the boundary type.
type SqlValue = null | number | bigint | string | Uint8Array;
type RawRow = Record<string, SqlValue>;

// Column coercions — validate at the boundary instead of trusting the DB.
// A corrupt row throws here, loudly, rather than poisoning a Memory downstream.
function asString(v: SqlValue): string {
  if (typeof v === 'string') return v;
  throw new TypeError(`expected TEXT, got ${v === null ? 'null' : typeof v}`);
}

function asNumber(v: SqlValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new TypeError(`expected numeric, got ${v === null ? 'null' : typeof v}`);
}

function asStringOrNull(v: SqlValue): string | null {
  return v === null ? null : asString(v);
}

function asStringArray(v: SqlValue): string[] {
  const parsed = JSON.parse(asString(v));
  return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
}

function asMemoryType(v: SqlValue): MemoryType {
  const s = asString(v);
  if (isMemoryType(s)) return s;
  throw new TypeError(`unknown memory type in db: ${s}`);
}

function asStatus(v: SqlValue): 'active' | 'superseded' {
  const s = asString(v);
  if (s === 'active' || s === 'superseded') return s;
  throw new TypeError(`unknown status in db: ${s}`);
}

function asSource(v: SqlValue): MemorySource | null {
  if (v === null) return null;
  const parsed = JSON.parse(asString(v));
  if (parsed && typeof parsed === 'object') {
    const src: MemorySource = {};
    if (typeof parsed.cwd === 'string') src.cwd = parsed.cwd;
    if (typeof parsed.session === 'string') src.session = parsed.session;
    return src;
  }
  return null;
}

// Decode a stored embedding BLOB back into a Float32Array (clean, aligned copy).
function decodeVec(v: SqlValue): Float32Array {
  if (v instanceof Uint8Array) {
    return new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  throw new TypeError('expected BLOB embedding');
}

function rowToMemory(r: RawRow): Memory {
  return {
    id: asString(r.id),
    content: asString(r.content),
    type: asMemoryType(r.type),
    anchors: asStringArray(r.anchors),
    tags: asStringArray(r.tags),
    status: asStatus(r.status),
    supersededBy: asStringOrNull(r.superseded_by),
    source: asSource(r.source),
    createdAt: asNumber(r.created_at),
    updatedAt: asNumber(r.updated_at),
  };
}

// Turn a free-text query into a safe FTS5 MATCH expression.
// We OR the terms with prefix-matching for broad recall (memory should
// surface generously, then rank — not require every word to be present).
function buildMatch(query: string): string | null {
  const toks = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (toks.length === 0) return null;
  return [...new Set(toks)].map((t) => `"${t}"*`).join(' OR ');
}

export interface SearchOpts {
  limit?: number;
  type?: MemoryType;
  model?: string; // vectorSearch only: restrict to vectors from this embed model
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // WAL allows one writer at a time; wait for the lock instead of failing
    // immediately. Matters now that a persistent MCP server and the CLI can
    // both write to the same store.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Additive migrations for stores created before a column existed.
  // Only swallow the "already exists" case — any other failure is real.
  private migrate(): void {
    for (const col of ['embedding BLOB', 'embed_model TEXT']) {
      try {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${col}`);
      } catch (e) {
        if (!(e instanceof Error && /duplicate column name/i.test(e.message))) throw e;
      }
    }
  }

  // Run fn inside a single transaction; roll back on any throw so a partial
  // write can never leave memories and memories_fts out of sync.
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // nothing to roll back
      }
      throw e;
    }
  }

  // Insert a memory (+ its FTS row) and apply any supersessions atomically.
  // `supersedeIds` must be already-resolved full ids. Returns the ids that were
  // actually flipped active -> superseded. Either all of this commits, or none.
  add(
    m: Memory,
    embedding?: Float32Array | null,
    model?: string | null,
    supersedeIds: string[] = [],
    now?: number,
  ): string[] {
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO memories
             (id, content, type, anchors, tags, status, superseded_by, source, created_at, updated_at, embedding, embed_model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.id,
          m.content,
          m.type,
          JSON.stringify(m.anchors),
          JSON.stringify(m.tags),
          m.status,
          m.supersededBy,
          m.source ? JSON.stringify(m.source) : null,
          m.createdAt,
          m.updatedAt,
          embedding ?? null,
          embedding ? (model ?? null) : null,
        );

      this.db
        .prepare(`INSERT INTO memories_fts (mid, content, anchors, tags) VALUES (?, ?, ?, ?)`)
        .run(m.id, m.content, m.anchors.join(' '), m.tags.join(' '));

      const ts = now ?? m.updatedAt;
      const superseded: string[] = [];
      for (const id of supersedeIds) {
        if (this.supersede(id, m.id, ts)) superseded.push(id);
      }
      return superseded;
    });
  }

  setEmbedding(id: string, embedding: Float32Array, model: string): void {
    this.db
      .prepare(`UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?`)
      .run(embedding, model, id);
  }

  // Active memories that have no embedding yet, with the text to embed.
  needingEmbedding(): { id: string; content: string; anchors: string[]; tags: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT id, content, anchors, tags FROM memories
         WHERE status = 'active' AND embedding IS NULL`,
      )
      .all();
    return rows.map((r) => ({
      id: asString(r.id),
      content: asString(r.content),
      anchors: asStringArray(r.anchors),
      tags: asStringArray(r.tags),
    }));
  }

  // Brute-force cosine over active embeddings. Fine at a repo's memory scale;
  // swap for an ANN index only if a store ever grows past tens of thousands.
  vectorSearch(queryVec: Float32Array, opts: SearchOpts = {}): { id: string; score: number }[] {
    const limit = opts.limit ?? 5;
    let sql = `SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL`;
    const params: (string | number)[] = [];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    // Only compare against vectors from the same model — different models are
    // not comparable, and different dims would produce meaningless scores.
    if (opts.model) {
      sql += ` AND embed_model = ?`;
      params.push(opts.model);
    }
    const rows = this.db.prepare(sql).all(...params);
    const scored: { id: string; score: number }[] = [];
    for (const r of rows) {
      const v = decodeVec(r.embedding);
      if (v.length !== queryVec.length) continue; // belt-and-suspenders: never cross dims
      scored.push({ id: asString(r.id), score: dot(queryVec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  get(id: string): Memory | null {
    const r = this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id = ?`).get(id);
    return r ? rowToMemory(r) : null;
  }

  // Resolve a full id or a (displayed) short prefix to a full id.
  // Returns null if nothing matches OR the prefix is ambiguous — callers
  // must treat null as "did not act".
  resolveId(idOrPrefix: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM memories WHERE id = ?`).get(idOrPrefix);
    if (exact) return asString(exact.id);
    // Escape LIKE wildcards so a prefix like "a_" matches literally, not as a pattern.
    const esc = idOrPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(`SELECT id FROM memories WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(`${esc}%`);
    return rows.length === 1 ? asString(rows[0].id) : null;
  }

  // Keyword recall over active memories, ranked by bm25 (lower = better).
  search(query: string, opts: SearchOpts = {}): RecallResult[] {
    const limit = opts.limit ?? 5;
    const match = buildMatch(query);
    if (!match) return this.recent(opts).map((m) => ({ ...m, score: 0 }));

    let sql = `
      SELECT ${MEMORY_COLS_M}, bm25(memories_fts) AS score
      FROM memories_fts f
      JOIN memories m ON m.id = f.mid
      WHERE memories_fts MATCH ? AND m.status = 'active'`;
    const params: (string | number)[] = [match];
    if (opts.type) {
      sql += ` AND m.type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY score ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({ ...rowToMemory(r), score: asNumber(r.score) }));
  }

  recent(opts: SearchOpts = {}): Memory[] {
    const limit = opts.limit ?? 5;
    let sql = `SELECT ${MEMORY_COLS} FROM memories WHERE status = 'active'`;
    const params: (string | number)[] = [];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params).map(rowToMemory);
  }

  // Reconciliation primitive: mark an old memory as replaced by a new one.
  // (Mem0's UPDATE/DELETE, done explicitly by the agent — no LLM pipeline.)
  supersede(oldId: string, byId: string, now: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(byId, now, oldId);
    return res.changes > 0;
  }

  forget(id: string): boolean {
    return this.tx(() => {
      this.db.prepare(`DELETE FROM memories_fts WHERE mid = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
      return res.changes > 0;
    });
  }

  count(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'active'`).get();
    return r ? asNumber(r.n) : 0;
  }

  close(): void {
    this.db.close();
  }
}
