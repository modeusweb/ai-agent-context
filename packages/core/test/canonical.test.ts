/**
 * Determinism of the canonical serialization primitives.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalize, stringifyCanonical, hashValue, sha256, clampConfidence, compareStrings } from '../dist/index.js';

describe('canonical serialization', () => {
  test('object key order does not affect output', () => {
    const a = stringifyCanonical({ b: 1, a: { d: 2, c: [3, 1, 2] } }, false);
    const b = stringifyCanonical({ a: { c: [3, 1, 2], d: 2 }, b: 1 }, false);
    assert.equal(a, b);
  });

  test('arrays keep their order (they are semantic)', () => {
    assert.notEqual(stringifyCanonical([1, 2, 3], false), stringifyCanonical([3, 2, 1], false));
  });

  test('nested values are sorted recursively', () => {
    const a = stringifyCanonical({ x: [{ z: 1, y: 2 }] }, false);
    assert.equal(a.includes('"y":2'), true);
    assert.ok(a.indexOf('"y"') < a.indexOf('"z"'));
  });

  test('pretty printing is stable', () => {
    const value = { a: 1, b: { c: 2 } };
    assert.equal(stringifyCanonical(value, true), stringifyCanonical(value, true));
    assert.ok(stringifyCanonical(value, true).includes('\n'));
  });

  test('hashValue is stable regardless of key order', () => {
    assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
    assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
  });

  test('sha256 is the expected hex digest of utf8 content', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('compareStrings is a plain lexicographic comparator', () => {
    const input = ['b.ts', 'a/c.ts', 'a/b.ts', 'a.ts'];
    assert.deepEqual([...input].sort(compareStrings), ['a.ts', 'a/b.ts', 'a/c.ts', 'b.ts']);
  });

  test('clampConfidence clamps to [0, 0.99] (heuristics are never certain)', () => {
    assert.equal(clampConfidence(1.5), 0.99);
    assert.equal(clampConfidence(-0.1), 0);
    assert.equal(clampConfidence(0.87), 0.87);
  });


  test('canonicalize deep-sorts plain objects', () => {
    const value = canonicalize({ z: 1, a: { y: 2, x: 3 } }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(value), ['a', 'z']);
  });
});
