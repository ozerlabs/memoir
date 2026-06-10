// Pure formatting for the Claude Code hooks. No I/O here so it stays unit-
// testable; the hook scripts in ../hooks do stdin/stdout and the store open.
import type { Memory } from './types.ts';

function bullet(m: Memory, max = 240): string {
  const c = m.content.length > max ? `${m.content.slice(0, max - 1)}…` : m.content;
  const where = m.anchors.length ? ` (@ ${m.anchors.join(' ')})` : '';
  return `• [${m.type}] ${c}${where}`;
}

// Human-readable labels for the session recap (the file-anchored recall keeps the
// raw [type] tag, since that context is read by the model mid-task).
const TYPE_LABEL: Record<Memory['type'], string> = {
  state: 'In flight',
  decision: 'Decided',
  gotcha: 'Watch out',
  constraint: 'Constraint',
  convention: 'Convention',
  preference: 'Preference',
  glossary: 'Term',
};

// The gist of a memory: its first sentence, capped at `max` chars on a word
// boundary. Memories often pack the headline into the first sentence and detail
// after, so this reads as prose instead of a fragment cut mid-token.
function gist(content: string, max = 200): string {
  const text = content.trim();
  // First sentence, if it ends within the cap. A sentence end is .!? followed by
  // whitespace/EOS — so "src/install-hooks.ts" and "store.vectorSearch" don't trip it.
  const end = text.search(/[.!?](?:\s|$)/);
  if (end !== -1 && end + 1 <= max) return text.slice(0, end + 1);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max).trimEnd()}…`;
}

// Strip a leading status marker so the recap reads like prose, not a changelog.
// Memories often open with "VERIFIED (2026-06-10) …", "RESOLVED (…) …" or
// "BUILD STATUS: …" — these orient the writer but read as noise at a glance. Drop a
// run of ALL-CAPS words + optional (parenthetical) + optional colon, then
// re-capitalize the remainder. The full content is still one recall away.
function stripStatusMarker(content: string): string {
  const trimmed = content.trim();
  const stripped = trimmed.replace(/^[A-Z][A-Z]+(?:\s+[A-Z]+)*\s*(?:\([^)]*\))?:?\s+/, '');
  // Only re-capitalize when we actually removed a marker — leave untouched content
  // (which may legitimately start lowercase) exactly as the author wrote it.
  return stripped === trimmed ? trimmed : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function recapLine(m: Memory): string {
  return `• ${TYPE_LABEL[m.type] ?? m.type}: ${gist(stripStatusMarker(m.content))}`;
}

// A compact, single-line status for Claude Code's status bar — a persistent,
// USER-VISIBLE footer (unlike formatSessionContext, which is a multi-line recap
// fed to the model). Shows the gist of the current in-flight work so a glance at
// the bottom of the screen answers "what was I doing here?". Returns null when
// nothing is in flight, so the status bar stays empty. The "·" / "⟳" framing
// matches the greeting the user signed off on.
export function formatStatusLine(memories: Memory[]): string | null {
  const top = memories[0];
  if (!top) return null;
  return `memoir · ⟳ ${gist(stripStatusMarker(top.content), 72)}`;
}

// Context injected before the agent reads/edits a file. Returns null when there
// is nothing to say, so the hook can emit no output (no noise).
export function formatAnchoredContext(memories: Memory[], file: string): string | null {
  if (memories.length === 0) return null;
  return `memoir — what this codebase remembers about ${file}:\n${memories.map((m) => bullet(m)).join('\n')}`;
}

// Context injected once at session start — the "where did we leave off".
export function formatSessionContext(memories: Memory[]): string | null {
  if (memories.length === 0) return null;
  return `memoir — picking up where we left off in this codebase:\n${memories.map(recapLine).join('\n')}`;
}
