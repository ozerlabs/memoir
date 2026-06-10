import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advisoryFor,
  annThreshold,
  annTier,
  annWarnFloor,
  ANN_DEFAULT_THRESHOLD,
} from '../src/advisory.ts';

// --- tier boundaries (the heart of the feature) ------------------------------

test('annTier: silent below the warn floor', () => {
  // floor for 25,000 is 20,000 — 19,999 must stay 'ok' (the "no change" proof)
  assert.equal(annWarnFloor(25_000), 20_000);
  assert.equal(annTier(0, 25_000), 'ok');
  assert.equal(annTier(19_999, 25_000), 'ok');
});

test('annTier: approaching inside the buffer band [floor, threshold)', () => {
  assert.equal(annTier(20_000, 25_000), 'approaching');
  assert.equal(annTier(24_999, 25_000), 'approaching');
});

test('annTier: over at and above the threshold', () => {
  assert.equal(annTier(25_000, 25_000), 'over');
  assert.equal(annTier(30_000, 25_000), 'over');
});

test('annTier: a threshold of 0 disables the advisory entirely', () => {
  assert.equal(annTier(1_000_000, 0), 'ok');
});

// --- env resolution ----------------------------------------------------------

test('annThreshold: default, override, disable, and garbage handling', () => {
  assert.equal(annThreshold({}), ANN_DEFAULT_THRESHOLD, 'absent → default');
  assert.equal(annThreshold({ MEMOIR_ANN_THRESHOLD: '' }), ANN_DEFAULT_THRESHOLD, 'empty → default');
  assert.equal(annThreshold({ MEMOIR_ANN_THRESHOLD: '30000' }), 30_000, 'override honored');
  assert.equal(annThreshold({ MEMOIR_ANN_THRESHOLD: '0' }), 0, '0 disables');
  assert.equal(annThreshold({ MEMOIR_ANN_THRESHOLD: 'abc' }), ANN_DEFAULT_THRESHOLD, 'garbage → default');
  assert.equal(annThreshold({ MEMOIR_ANN_THRESHOLD: '-5' }), ANN_DEFAULT_THRESHOLD, 'negative → default');
});

// --- the advisory payload ----------------------------------------------------

test('advisoryFor: returns null when there is nothing to say', () => {
  assert.equal(advisoryFor(19_999, 25_000), null);
  assert.equal(advisoryFor(0, 25_000), null);
  assert.equal(advisoryFor(1_000_000, 0), null, 'disabled → null');
});

test('advisoryFor: approaching carries count, limit, percent, and the fix', () => {
  const adv = advisoryFor(20_143, 25_000);
  assert.ok(adv);
  assert.equal(adv?.tier, 'approaching');
  assert.equal(adv?.bucket, 20, 'bucket is count / 1000 floored');
  assert.match(adv!.message, /20,143 \/ 25,000/, 'comma-grouped count and limit');
  assert.match(adv!.message, /80%/, 'percent of threshold');
  assert.match(adv!.message, /sqlite-vec/, 'names the fix');
  assert.match(adv!.message, /MEMOIR_ANN_THRESHOLD=0/, 'how to silence');
  assert.doesNotMatch(adv!.message, /\x1b/, 'message carries no ANSI');
});

test('advisoryFor: over is escalated and labeled OVER LIMIT', () => {
  const adv = advisoryFor(25_610, 25_000);
  assert.ok(adv);
  assert.equal(adv?.tier, 'over');
  assert.match(adv!.message, /OVER LIMIT/);
  assert.match(adv!.message, /25,610 \/ 25,000/);
});
