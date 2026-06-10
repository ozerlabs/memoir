import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { formatAnchoredContext, formatSessionContext, formatStatusLine } from '../src/hooks.ts';
import { installHooks } from '../src/install-hooks.ts';
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

test('formatSessionContext strips a leading status marker so the recap reads like prose', () => {
  const out = formatSessionContext([aMemory({ content: 'VERIFIED (2026-06-10) the hook command works end to end' })]) ?? '';
  assert.ok(!out.includes('VERIFIED'), 'the ALL-CAPS status marker is dropped');
  assert.ok(!out.includes('(2026-06-10)'), 'the parenthetical date is dropped');
  assert.match(out, /The hook command works/, 'remainder is kept and re-capitalized');
});

test('formatStatusLine returns null on empty and renders a compact, marker-free line', () => {
  assert.equal(formatStatusLine([]), null);
  const out = formatStatusLine([aMemory({ type: 'state', content: 'VERIFIED (2026-06-10) the statusline renders cleanly' })]) ?? '';
  assert.match(out, /memoir/, 'labelled so it is recognizable in the status bar');
  assert.ok(!out.includes('VERIFIED'), 'the loud status marker is stripped');
  assert.match(out, /statusline renders cleanly/i, 'shows the gist of the in-flight work');
});

// --- installHooks ------------------------------------------------------------

test('installHooks writes both hooks, preserves other keys, and is idempotent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));

  const first = installHooks(dir, HOOKS_DIR);
  assert.deepEqual(first.added.sort(), ['PreToolUse', 'SessionStart', 'statusLine']);

  const settings = JSON.parse(readFileSync(first.file, 'utf8'));
  assert.equal(settings.model, 'opus', 'existing keys are preserved');
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Edit|Write');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /pre-tool-recall\.ts/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /session-start\.ts/);
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /statusline\.ts/);

  const second = installHooks(dir, HOOKS_DIR);
  assert.deepEqual(second.added, [], 'nothing added the second time');
  assert.deepEqual(second.skipped.sort(), ['PreToolUse', 'SessionStart', 'statusLine']);
});

test('installHooks never clobbers an existing statusLine', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-statusline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }),
  );

  const res = installHooks(dir, HOOKS_DIR);
  const settings = JSON.parse(readFileSync(res.file, 'utf8'));
  assert.equal(settings.statusLine.command, 'my-own.sh', "the user's statusLine is left untouched");
  assert.ok(res.skipped.includes('statusLine'), 'an existing statusLine is reported as skipped');
});

test('installHooks emits a $CLAUDE_PROJECT_DIR command when hooks live inside the project', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-portable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inside = join(dir, 'hooks');
  mkdirSync(inside);

  const { file } = installHooks(dir, inside);
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /\$CLAUDE_PROJECT_DIR\/hooks\/pre-tool-recall\.ts/, 'machine-independent, committable');
  assert.ok(!cmd.includes(dir), 'no absolute machine path leaks into the command');
});

test('installHooks keeps an absolute path when hooks live outside the project', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-abs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { file } = installHooks(dir, HOOKS_DIR); // HOOKS_DIR is the real repo, outside dir
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes(HOOKS_DIR), 'consumer repos need the absolute path to resolve');
  assert.ok(!cmd.includes('$CLAUDE_PROJECT_DIR'), 'no project-relative form when outside');
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

// --- statusline command, end to end ------------------------------------------

test('statusline prints the in-flight state for the project (resolved via project_dir)', (t) => {
  const dir = project(t, aMemory({ type: 'state', content: 'mid-refactor: extracting the parser' }));
  const { stdout, status } = runHook('statusline.ts', { workspace: { project_dir: dir } });
  assert.equal(status, 0);
  assert.match(stdout, /memoir/);
  assert.match(stdout, /mid-refactor/);
});

test('statusline stays silent outside any .memoir store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memoir-statusbare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stdout, status } = runHook('statusline.ts', { workspace: { project_dir: dir } });
  assert.equal(status, 0);
  assert.equal(stdout, '', 'no store → empty status line');
  assert.equal(existsSync(join(dir, '.memoir')), false, 'the status line must not create a store');
});
