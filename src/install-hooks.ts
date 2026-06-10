// Self-installer for memoir's Claude Code hooks. Shared by the CLI (`memoir hook
// install`) and the MCP server (which self-installs on startup, so registering
// the MCP is the only manual step — the hooks follow automatically). Idempotent
// and side-effect-free beyond writing <root>/.claude/settings.json.
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Minimal JSON value type so we can read/merge an arbitrary settings.json
// without `unknown` or blind casts — we narrow with typeof/Array.isArray guards.
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function asObject(v: JsonValue | undefined): { [k: string]: JsonValue } {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Is a hook already registered for this script? Matches on the script's filename
// (e.g. pre-tool-recall.ts) rather than its full path, so idempotency holds
// regardless of whether the existing command uses an absolute path or the
// $CLAUDE_PROJECT_DIR form. Walks the loose JSON shape defensively so a
// hand-edited settings.json can't crash the installer.
function groupsReference(groups: JsonValue[], script: string): boolean {
  const marker = basename(script);
  return groups.some((g) => {
    const hooks = asObject(g).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h) => {
      const cmd = asObject(h).command;
      return typeof cmd === 'string' && cmd.includes(marker);
    });
  });
}

// Build the hook command. When the script lives INSIDE the project we're
// installing into (memoir dogfooding its own repo), reference it via
// $CLAUDE_PROJECT_DIR so the committed settings.json is machine-independent and
// travels with the repo. When it lives elsewhere (memoir installed from a
// separate checkout into a consumer repo), keep the absolute path — it's the
// only thing that resolves from an arbitrary project root.
function hookCommand(script: string, cwd: string): string {
  const rel = relative(cwd, script);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  const target = inside ? `$CLAUDE_PROJECT_DIR/${rel}` : script;
  return `NODE_NO_WARNINGS=1 node "${target}"`;
}

// The bundled hooks/ directory, resolved from this module's location so it's
// correct no matter who calls it (CLI or MCP server). src/install-hooks.ts →
// repo root → hooks/.
export function hooksDir(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks');
}

// Merge the PreToolUse (anchored recall) + SessionStart (where-we-left-off)
// hooks into <cwd>/.claude/settings.json. Idempotent: skips anything already
// pointing at our scripts, and preserves every other key in the file.
export function installHooks(
  cwd: string,
  dir: string = hooksDir(),
): { added: string[]; skipped: string[]; file: string } {
  const specs = [
    { event: 'PreToolUse', matcher: 'Read|Edit|Write', script: join(dir, 'pre-tool-recall.ts') },
    { event: 'SessionStart', matcher: undefined, script: join(dir, 'session-start.ts') },
  ];
  const claudeDir = join(cwd, '.claude');
  const file = join(claudeDir, 'settings.json');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

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
      command: hookCommand(spec.script, cwd),
      timeout: 10,
    };
    const group: { [k: string]: JsonValue } = { hooks: [handler] };
    if (spec.matcher) group.matcher = spec.matcher;
    hooks[spec.event] = [...groups, group];
    added.push(spec.event);
  }

  // Status line: a persistent, user-visible footer showing the current in-flight
  // state — the only greeting surface a repo config can drive (SessionStart hook
  // output reaches only the model). Set it only when the project has none; never
  // clobber a statusLine the user already configured, ours or theirs.
  if (settings.statusLine === undefined) {
    settings.statusLine = {
      type: 'command',
      command: hookCommand(join(dir, 'statusline.ts'), cwd),
      padding: 0,
    };
    added.push('statusLine');
  } else {
    skipped.push('statusLine');
  }

  // Nothing new to write — leave the file untouched (don't rewrite formatting).
  if (!added.length) return { added, skipped, file };

  settings.hooks = hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { added, skipped, file };
}
