#!/usr/bin/env -S NODE_NO_WARNINGS=1 node
// Claude Code SessionStart hook. Fires once when a session begins; injects a
// "where did we leave off" summary (recent state + recent memories) so a fresh
// session opens the brain on its own. Read-only, never throws.
import { Memoir } from '../src/memoir.ts';
import { formatSessionContext } from '../src/hooks.ts';
import type { Memory } from '../src/types.ts';

interface HookInput {
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let cwd = process.cwd();
  try {
    const data: HookInput = JSON.parse(await readStdin());
    if (typeof data.cwd === 'string') cwd = data.cwd;
  } catch {
    // no/!json stdin — fall back to process cwd
  }

  const mem = Memoir.openExisting(cwd);
  if (!mem) return;
  try {
    // State first (the explicit "what's in-flight"), then fill with recents.
    const seen = new Set<string>();
    const merged: Memory[] = [];
    for (const m of [...mem.list({ type: 'state', limit: 3 }), ...mem.list({ limit: 6 })]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
      if (merged.length >= 6) break;
    }
    const ctx = formatSessionContext(merged);
    if (ctx) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }),
      );
    }
  } finally {
    mem.close();
  }
}

main().catch(() => {
  /* a hook must never disrupt session start */
});
