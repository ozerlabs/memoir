// Proactive ANN advisory.
//
// Recall's vector search (store.vectorSearch) is brute-force: it scans every
// active embedded vector and computes a 384-dim dot product, so its latency is
// LINEAR in the number of memories. That is sub-millisecond at a repo's scale,
// but past a latency budget you want an approximate-nearest-neighbor index
// (sqlite-vec) instead. This module decides WHEN to warn — with a buffer, so
// you're told with runway to act, not at the cliff.
//
// The threshold is derived, not arbitrary: a ~50ms vector-search budget (so
// proactive recall stays "instant") divided by ~2µs per memory (BLOB decode +
// dot product on typical hardware) ≈ 25,000 memories. Hardware varies, so it's
// env-overridable; MEMOIR_ANN_THRESHOLD=0 disables the advisory entirely.

export const ANN_DEFAULT_THRESHOLD = 25_000; // ~50ms budget ÷ ~2µs per memory
export const ANN_WARN_RATIO = 0.8; // warn at 80% of the threshold — the buffer

export type AnnTier = 'ok' | 'approaching' | 'over';

export interface AnnAdvisory {
  tier: 'approaching' | 'over';
  count: number;
  threshold: number;
  bucket: number; // count / 1000, floored — for once-per-1,000 write throttling
  message: string; // plain text, no ANSI and no leading emoji (surfaces add those)
}

// Resolve the active threshold from the environment. An absent var uses the
// default; a non-finite or negative value is treated as garbage → default; 0
// disables. Floored to an integer so the math downstream stays clean.
export function annThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMOIR_ANN_THRESHOLD;
  if (raw === undefined || raw === '') return ANN_DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return ANN_DEFAULT_THRESHOLD;
  return Math.floor(n);
}

// The warn floor: where the buffer kicks in (e.g. 20,000 for a 25,000 ceiling).
export function annWarnFloor(threshold: number): number {
  return Math.floor(threshold * ANN_WARN_RATIO);
}

export function annTier(count: number, threshold: number): AnnTier {
  if (threshold <= 0) return 'ok'; // disabled
  if (count >= threshold) return 'over';
  if (count >= annWarnFloor(threshold)) return 'approaching';
  return 'ok';
}

// Group digits with commas without depending on Intl (deterministic for tests).
function commas(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const TAIL = 'adjust: MEMOIR_ANN_THRESHOLD · silence: MEMOIR_ANN_THRESHOLD=0';

// Returns the advisory for a given count, or null when there's nothing to say
// (tier 'ok' or the advisory disabled). The message carries the same four facts
// every time: count/limit, what's happening, the fix, and how to adjust/silence.
export function advisoryFor(count: number, threshold: number = annThreshold()): AnnAdvisory | null {
  const tier = annTier(count, threshold);
  if (tier === 'ok') return null;
  const n = commas(count);
  const t = commas(threshold);
  const message =
    tier === 'over'
      ? `memoir — ${n} / ${t} vectors, OVER LIMIT. Brute-force recall may now exceed ~50ms. Enable ANN (sqlite-vec) now. ${TAIL}`
      : `memoir — ${n} / ${t} vectors (${Math.floor((count / threshold) * 100)}%). Brute-force recall is nearing its limit. Enable ANN (sqlite-vec) soon. ${TAIL}`;
  return { tier, count, threshold, bucket: Math.floor(count / 1000), message };
}
