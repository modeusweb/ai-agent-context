/**
 * Tests for language registry.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createDefaultRegistry } from '../dist/index.js';

describe('language registry', () => {
  test('creates default registry', () => {
    const registry = createDefaultRegistry();
    assert.ok(registry !== null);
  });
});
