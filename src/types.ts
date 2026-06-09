// The taxonomy of what's worth remembering about a codebase.
// Principle: store what you CAN'T reconstruct from the repo —
// the why, the don't, the not-yet, and the how-we-like-it.
export const MEMORY_TYPES = [
  'decision', // why X over Y, including rejected alternatives
  'convention', // implicit rules to stay consistent
  'gotcha', // landmines, fragile/flaky code, "don't"
  'constraint', // hard boundaries that shape everything
  'glossary', // domain terms / what entities mean here
  'state', // what's in-flight right now, intentional WIP
  'preference', // how this particular user likes to work
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(v: string): v is MemoryType {
  return MEMORY_TYPES.some((t) => t === v);
}

export interface MemorySource {
  cwd?: string;
  session?: string;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  anchors: string[]; // files / modules / symbols / concepts this memory is "about"
  tags: string[];
  status: 'active' | 'superseded';
  supersededBy: string | null;
  source: MemorySource | null;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

export interface RecallResult extends Memory {
  // Relevance score. Semantics depend on the path that produced it:
  // hybrid recall → RRF (higher = better); keyword-only fallback → bm25
  // (lower = better); plain listings → 0. Treat as opaque ordering, not a scale.
  score: number;
}
