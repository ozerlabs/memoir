import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { formatAnchoredContext, formatSessionContext } from '../src/hooks.ts';
import { installHooks } from '../src/cli.ts';
import type { Memory } from '../src/types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOKS_DIR = join(ROOT, 'hooks');

function aMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: randomUUID(),
    content: 'do not await inside this loop',
    type: 'gotcha',
    anchors: ['src/embed.ts'],
    tags: [],
    status: 'active',
    supersededBy: null,
    source: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// A temp project with a .memoir/ holding one anchored memory.
function project(t: { after: (fn: () => void) => void }, m: Memory): string {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-hookproj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.memoir'));
  const store = new MemoryStore(join(dir, '.memoir', 'memory.db'));
  store.add(m);
  store.close();
  return dir;
}

function runHook(script: string, input: object): { stdout: string; status: number | null } {
  const res = spawnSync('node', [join(HOOKS_DIR, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

// --- pure formatters ---------------------------------------------------------

test('formatAnchoredContext returns null on empty, and includes type + content', () => {
  assert.equal(formatAnchoredContext([], 'src/x.ts'), null);
  const out = formatAnchoredContext([aMemory()], 'src/embed.ts');
  assert.match(out ?? '', /src\/embed\.ts/);
  assert.match(out ?? '', /\[gotcha\]/);
  assert.match(out ?? '', /do not await/);
});

test('formatAnchoredContext truncates very long content', () => {
  const out = formatAnchoredContext([aMemory({ content: 'x'.repeat(500) })], 'f');
  assert.ok((out ?? '').includes('…'), 'long content is elided');
  assert.ok((out ?? '').length < 400);
});

test('formatSessionContext returns null on empty and labels the catch-up', () => {
  assert.equal(formatSessionContext([]), null);
  assert.match(formatSessionContext([aMemory({ type: 'state', content: 'mid-refactor' })]) ?? '', /left off/);
});

// --- installHooks ------------------------------------------------------------

test('installHooks writes both hooks, preserves other keys, and is idempotent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));

  const first = installHooks(dir, HOOKS_DIR);
  assert.deepEqual(first.added.sort(), ['PreToolUse', 'SessionStart']);

  const settings = JSON.parse(readFileSync(first.file, 'utf8'));
  assert.equal(settings.model, 'opus', 'existing keys are preserved');
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Edit|Write');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /pre-tool-recall\.ts/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /session-start\.ts/);

  const second = installHooks(dir, HOOKS_DIR);
  assert.deepEqual(second.added, [], 'nothing added the second time');
  assert.deepEqual(second.skipped.sort(), ['PreToolUse', 'SessionStart']);
});

// --- pre-tool-recall hook, end to end ----------------------------------------

test('pre-tool-recall injects anchored context for a matching file', (t) => {
  const m = aMemory();
  const dir = project(t, m);
  const { stdout, status } = runHook('pre-tool-recall.ts', {
    tool_input: { file_path: join(dir, 'src', 'embed.ts') },
    cwd: dir,
    session_id: `s-${randomUUID()}`,
  });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /do not await/);
});

test('pre-tool-recall stays silent for an unrelated file', (t) => {
  const dir = project(t, aMemory());
  const { stdout, status } = runHook('pre-tool-recall.ts', {
    tool_input: { file_path: join(dir, 'src', 'unrelated.ts') },
    cwd: dir,
    session_id: `s-${randomUUID()}`,
  });
  assert.equal(status, 0);
  assert.equal(stdout, '', 'no anchored memory → no output');
});

test('pre-tool-recall dedups within a session', (t) => {
  const dir = project(t, aMemory());
  const session = `s-${randomUUID()}`;
  const input = { tool_input: { file_path: join(dir, 'src', 'embed.ts') }, cwd: dir, session_id: session };
  const first = runHook('pre-tool-recall.ts', input);
  assert.match(first.stdout, /do not await/);
  const second = runHook('pre-tool-recall.ts', input);
  assert.equal(second.stdout, '', 'same memory not re-injected in the same session');
});

test('pre-tool-recall does nothing (and never creates a store) outside any .memoir', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-bare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stdout, status } = runHook('pre-tool-recall.ts', {
    tool_input: { file_path: join(dir, 'a.ts') },
    cwd: dir,
    session_id: `s-${randomUUID()}`,
  });
  assert.equal(status, 0);
  assert.equal(stdout, '');
  assert.equal(existsSync(join(dir, '.memoir')), false, 'the hook must not create a store');
});

// --- session-start hook, end to end ------------------------------------------

test('session-start injects a where-we-left-off summary', (t) => {
  const dir = project(t, aMemory({ type: 'state', content: 'mid-refactor: extracting the parser' }));
  const { stdout, status } = runHook('session-start.ts', { cwd: dir });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /mid-refactor/);
});
