import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit } from '../src/cli.ts';

// --limit comes off the command line as a raw string (or undefined). parseLimit
// is the only thing standing between user input and a SQL LIMIT, so it must
// never let NaN, zero, negatives, or absurd values through.
test('parseLimit: missing value falls back to the default', () => {
  assert.equal(parseLimit(undefined, 5), 5);
  assert.equal(parseLimit(undefined, 20), 20);
});

test('parseLimit: a normal value is parsed as an integer', () => {
  assert.equal(parseLimit('7', 5), 7);
  assert.equal(parseLimit('1', 5), 1);
});

test('parseLimit: NaN / non-numeric falls back to the default', () => {
  assert.equal(parseLimit('abc', 5), 5);
  assert.equal(parseLimit('', 5), 5); // empty string is falsy → default
  assert.equal(parseLimit('   ', 5), 5); // parseInt('   ') is NaN
});

test('parseLimit: zero and negatives fall back to the default', () => {
  assert.equal(parseLimit('0', 5), 5);
  assert.equal(parseLimit('-1', 5), 5);
  assert.equal(parseLimit('-1000', 20), 20);
});

test('parseLimit: absurd values are capped at 1000', () => {
  assert.equal(parseLimit('1000000', 5), 1000);
  assert.equal(parseLimit('1001', 5), 1000);
  assert.equal(parseLimit('1000', 5), 1000); // boundary stays
});

test('parseLimit: trailing junk after digits parses the leading integer', () => {
  // Number.parseInt('12abc', 10) === 12 — defensive but not strict; documents
  // the actual behavior so a future change to strict parsing is a deliberate one.
  assert.equal(parseLimit('12abc', 5), 12);
});
