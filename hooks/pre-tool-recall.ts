#!/usr/bin/env -S NODE_NO_WARNINGS=1 node
// Claude Code PreToolUse hook. Fires right before Read/Edit/Write; if the file
// being touched has memories anchored to it, inject them so the agent is warned
// BEFORE it acts. Read-only on the store, dedups per session, and NEVER throws
// (a hook crash must never block a tool call).
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { Memoir } from '../src/memoir.ts';
import { formatAnchoredContext } from '../src/hooks.ts';
import type { Memory } from '../src/types.ts';

interface HookInput {
  tool_input?: { file_path?: string };
  cwd?: string;
  session_id?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Don't re-inject the same memory every time a file is opened in one session.
function seenFile(session: string): string {
  return join(tmpdir(), `memoir-hook-${session.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function filterUnseen(session: string, memories: Memory[]): Memory[] {
  const path = seenFile(session);
  let seen: string[] = [];
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(arr)) seen = arr.map(String);
  } catch {
    // first sight this session — no file yet
  }
  const set = new Set(seen);
  const fresh = memories.filter((m) => !set.has(m.id));
  if (fresh.length) {
    try {
      writeFileSync(path, JSON.stringify([...seen, ...fresh.map((m) => m.id)]));
    } catch {
      // dedup is best-effort; showing a memory twice beats blocking the tool
    }
  }
  return fresh;
}

async function main(): Promise<void> {
  const data: HookInput = JSON.parse(await readStdin());
  const fp = data.tool_input?.file_path;
  const file = typeof fp === 'string' ? fp : '';
  const cwd = typeof data.cwd === 'string' ? data.cwd : process.cwd();
  const session = typeof data.session_id === 'string' ? data.session_id : 'default';
  if (!file) return;

  const mem = Memoir.openExisting(cwd);
  if (!mem) return;
  try {
    const hits = filterUnseen(session, mem.recallByAnchor(file, 6));
    const nice = isAbsolute(file) ? relative(cwd, file) || file : file;
    const ctx = formatAnchoredContext(hits, nice);
    if (ctx) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } }),
      );
    }
  } finally {
    mem.close();
  }
}

main().catch(() => {
  /* swallow everything — a hook must never block the agent's tool call */
});
