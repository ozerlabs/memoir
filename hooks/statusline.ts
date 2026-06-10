#!/usr/bin/env -S NODE_NO_WARNINGS=1 node
// Claude Code statusLine command. Runs after each assistant message and prints a
// compact, USER-VISIBLE reminder of memoir's current in-flight state to the
// status bar at the bottom of the screen — the one greeting surface a repo config
// can drive (the SessionStart hook reaches only the model). Read-only, never
// throws: a status line must never disrupt the session.
import { Memoir } from '../src/memoir.ts';
import { formatStatusLine } from '../src/hooks.ts';

interface StatusInput {
  cwd?: string;
  workspace?: { project_dir?: string; current_dir?: string };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let cwd = process.cwd();
  try {
    const data: StatusInput = JSON.parse(await readStdin());
    // project_dir is where Claude was launched (the repo root); prefer it over
    // cwd, which can drift mid-session. Fall back through cwd to process cwd.
    cwd = data.workspace?.project_dir ?? data.cwd ?? cwd;
  } catch {
    // no/!json stdin — fall back to process cwd
  }

  const mem = Memoir.openExisting(cwd);
  if (!mem) return;
  try {
    // The single most relevant memory: the latest explicit in-flight state, or
    // the most recent memory of any kind if nothing is flagged as state.
    const top = mem.list({ type: 'state', limit: 1 })[0] ?? mem.list({ limit: 1 })[0];
    const line = formatStatusLine(top ? [top] : []);
    // Dim it so it reads as ambient chrome, not a message demanding attention.
    if (line) process.stdout.write(`\x1b[2m${line}\x1b[0m`);
  } finally {
    mem.close();
  }
}

main().catch(() => {
  /* a status line must never disrupt the session */
});
