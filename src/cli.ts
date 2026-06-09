#!/usr/bin/env -S NODE_NO_WARNINGS=1 node
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Memoir } from './memoir.ts';
import { MEMORY_TYPES, isMemoryType, type Memory } from './types.ts';

const C = process.stdout.isTTY
  ? {
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
      cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    }
  : {
      dim: (s: string) => s,
      bold: (s: string) => s,
      cyan: (s: string) => s,
      yellow: (s: string) => s,
      green: (s: string) => s,
    };

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function csv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse --limit defensively: reject NaN / non-positive, cap absurd values.
// Exported for unit testing.
export function parseLimit(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(n, 1000);
}

// Minimal JSON value type so we can read/merge an arbitrary settings.json
// without `unknown` or blind casts — we narrow with typeof/Array.isArray guards.
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function asObject(v: JsonValue | undefined): { [k: string]: JsonValue } {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Is a hook already registered for this script path? Walks the loose JSON shape
// defensively so a hand-edited settings.json can't crash the installer.
function groupsReference(groups: JsonValue[], script: string): boolean {
  return groups.some((g) => {
    const hooks = asObject(g).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h) => {
      const cmd = asObject(h).command;
      return typeof cmd === 'string' && cmd.includes(script);
    });
  });
}

// Merge the PreToolUse (anchored recall) + SessionStart (where-we-left-off)
// hooks into <cwd>/.claude/settings.json. Idempotent: skips anything already
// pointing at our scripts, and preserves every other key in the file.
export function installHooks(
  cwd: string,
  hooksDir: string,
): { added: string[]; skipped: string[]; file: string } {
  const specs = [
    { event: 'PreToolUse', matcher: 'Read|Edit|Write', script: join(hooksDir, 'pre-tool-recall.ts') },
    { event: 'SessionStart', matcher: undefined, script: join(hooksDir, 'session-start.ts') },
  ];
  const dir = join(cwd, '.claude');
  const file = join(dir, 'settings.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: { [k: string]: JsonValue } = {};
  if (existsSync(file)) {
    const parsed: JsonValue = JSON.parse(readFileSync(file, 'utf8'));
    settings = asObject(parsed);
  }
  const hooks = asObject(settings.hooks);
  const added: string[] = [];
  const skipped: string[] = [];

  for (const spec of specs) {
    const existing = hooks[spec.event];
    const groups: JsonValue[] = Array.isArray(existing) ? existing : [];
    if (groupsReference(groups, spec.script)) {
      skipped.push(spec.event);
      continue;
    }
    const handler: { [k: string]: JsonValue } = {
      type: 'command',
      command: `NODE_NO_WARNINGS=1 node "${spec.script}"`,
      timeout: 10,
    };
    const group: { [k: string]: JsonValue } = { hooks: [handler] };
    if (spec.matcher) group.matcher = spec.matcher;
    hooks[spec.event] = [...groups, group];
    added.push(spec.event);
  }

  settings.hooks = hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { added, skipped, file };
}

function printMemory(m: Memory): void {
  const head = `${C.cyan(`[${m.type}]`)} ${C.dim(m.id.slice(0, 8))} ${C.dim(ago(m.updatedAt))}`;
  console.log(head);
  console.log(`  ${m.content}`);
  const meta: string[] = [];
  if (m.anchors.length) meta.push(`${C.dim('@')} ${m.anchors.join(' ')}`);
  if (m.tags.length) meta.push(`${C.dim('#')} ${m.tags.join(' ')}`);
  if (meta.length) console.log(`  ${meta.join('   ')}`);
  console.log();
}

const HELP = `${C.bold('memoir')} — local long-term memory for your codebase

${C.bold('Usage')}
  memoir init                     # create .memoir/ here — claim this folder as a memory root
  memoir remember <content...> --type <type> [--anchors a,b] [--tags x,y] [--supersedes id,id]
  memoir recall <query...> [--type <type>] [--limit N]
  memoir anchored <file> [--limit N] [--json]   # memories anchored to a file (proactive recall)
  memoir list [--type <type>] [--limit N]
  memoir forget <id>
  memoir reembed
  memoir hook install            # register the PreToolUse + SessionStart hooks in ./.claude/settings.json
  memoir types
  memoir where

${C.bold('Types')}
  ${MEMORY_TYPES.join('  ')}

${C.bold('Examples')}
  memoir remember "Store is embedded SQLite in the repo folder" --type decision --anchors src/store.ts --tags storage
  memoir recall "where are we on building memoir"
  memoir list --type preference
`;

function parseCliArgs() {
  return parseArgs({
    allowPositionals: true,
    options: {
      type: { type: 'string', short: 't' },
      anchors: { type: 'string', short: 'a' },
      tags: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      supersedes: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;

  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'types') {
    console.log(MEMORY_TYPES.join('\n'));
    return;
  }

  if (cmd === 'init') {
    const { mem, created, shadows } = Memoir.init();
    try {
      const dbPath = join(mem.root, '.memoir', 'memory.db');
      const tail = C.dim(`(${mem.count()} memories)`);
      if (created) {
        console.log(`${C.green('initialized')} ${dbPath}  ${tail}`);
        if (shadows) {
          console.log(
            C.yellow(
              `  note: shadowing a parent .memoir at ${join(shadows, '.memoir')} — this project now has its own memory`,
            ),
          );
        }
      } else {
        console.log(`${C.dim('already initialized')} ${dbPath}  ${tail}`);
      }
    } finally {
      mem.close();
    }
    return;
  }

  if (cmd === 'hook') {
    if (positionals[1] !== 'install') return fail('usage: memoir hook install');
    const hooksDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks');
    const { added, skipped, file } = installHooks(process.cwd(), hooksDir);
    for (const a of added) console.log(`${C.green('+ installed')} ${a} hook`);
    for (const s of skipped) console.log(C.dim(`already present: ${s} hook`));
    console.log(C.dim(`→ ${file}`));
    console.log(C.dim('restart Claude Code (new session) for the hooks to take effect'));
    return;
  }

  const mem = Memoir.open();
  try {
    if (cmd === 'where') {
      const dbPath = join(mem.root, '.memoir', 'memory.db');
      console.log(`${dbPath}  ${C.dim(`(${mem.count()} memories)`)}`);
      return;
    }

    if (cmd === 'remember') {
      const content = positionals.slice(1).join(' ').trim();
      if (!content) return fail('nothing to remember — pass the content');
      const type = values.type;
      if (!type || !isMemoryType(type)) {
        return fail(`--type is required, one of: ${MEMORY_TYPES.join(', ')}`);
      }
      const requested = csv(values.supersedes);
      const { memory: m, superseded, embedded } = await mem.remember({
        content,
        type,
        anchors: csv(values.anchors),
        tags: csv(values.tags),
        supersedes: requested,
        source: { cwd: process.cwd() },
      });
      const tail = embedded ? '' : C.dim(' (keyword-only, no embedding)');
      console.log(`${C.green('remembered')} ${C.dim(m.id.slice(0, 8))} ${C.cyan(`[${m.type}]`)}${tail}`);
      if (superseded.length) {
        console.log(C.dim(`  superseded ${superseded.length} memory(ies)`));
      } else if (requested.length) {
        console.log(C.yellow(`  warning: --supersedes matched nothing (check the ids)`));
      }
      return;
    }

    if (cmd === 'recall') {
      const query = positionals.slice(1).join(' ').trim();
      const type = values.type && isMemoryType(values.type) ? values.type : undefined;
      const limit = parseLimit(values.limit, 5);
      const results = await mem.recall(query, { limit, type });
      if (!results.length) {
        console.log(C.dim('no memories yet — nothing to recall'));
        return;
      }
      console.log(C.dim(`${results.length} memory(ies) for "${query || '(recent)'}"\n`));
      for (const r of results) printMemory(r);
      return;
    }

    if (cmd === 'anchored') {
      const path = positionals[1];
      if (!path) return fail('pass a file path — memoir anchored <file>');
      const limit = parseLimit(values.limit, 5);
      const abs = isAbsolute(path) ? path : join(process.cwd(), path);
      const results = mem.recallByAnchor(abs, limit);
      if (values.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (!results.length) {
        console.log(C.dim(`no memories anchored to ${path}`));
        return;
      }
      console.log(C.dim(`${results.length} memory(ies) anchored to ${path}\n`));
      for (const m of results) printMemory(m);
      return;
    }

    if (cmd === 'list') {
      const type = values.type && isMemoryType(values.type) ? values.type : undefined;
      const limit = parseLimit(values.limit, 20);
      const all = mem.list({ limit, type });
      if (!all.length) {
        console.log(C.dim('no memories yet'));
        return;
      }
      for (const m of all) printMemory(m);
      return;
    }

    if (cmd === 'forget') {
      const id = positionals[1];
      if (!id) return fail('pass the id to forget');
      console.log(mem.forget(id) ? `${C.green('forgot')} ${id}` : C.dim(`no memory ${id}`));
      return;
    }

    if (cmd === 'reembed') {
      const n = await mem.backfill((done, total) => {
        process.stdout.write(`\r${C.dim(`embedding ${done}/${total}…`)}`);
      });
      if (process.stdout.isTTY) process.stdout.write('\n');
      console.log(
        n > 0
          ? `${C.green('embedded')} ${n} memory(ies)`
          : C.dim('nothing to embed (already embedded, or embeddings unavailable)'),
      );
      return;
    }

    fail(`unknown command: ${cmd}\n\n${HELP}`);
  } finally {
    mem.close();
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

// Only drive the CLI when run as the entry point — importing this module (e.g.
// from tests, to exercise parseLimit) must not execute a command.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
