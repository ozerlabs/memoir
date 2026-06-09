// Pure formatting for the Claude Code hooks. No I/O here so it stays unit-
// testable; the hook scripts in ../hooks do stdin/stdout and the store open.
import type { Memory } from './types.ts';

function bullet(m: Memory, max = 240): string {
  const c = m.content.length > max ? `${m.content.slice(0, max - 1)}…` : m.content;
  const where = m.anchors.length ? ` (@ ${m.anchors.join(' ')})` : '';
  return `• [${m.type}] ${c}${where}`;
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
  return `memoir — picking up where we left off (recall for more):\n${memories.map((m) => bullet(m)).join('\n')}`;
}
