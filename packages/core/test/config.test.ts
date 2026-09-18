/**
 * Tests for configuration loading and validation.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  DEFAULT_CONFIG,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
  DEFAULT_SENSITIVE_PATTERNS,
} from '../dist/index.js';

describe('config', () => {
  describe('defaults', () => {
    test('DEFAULT_CONFIG has expected structure', () => {
      assert.equal(DEFAULT_CONFIG.version, 1);
      assert.equal(DEFAULT_CONFIG.root, '.');
      assert.ok(Array.isArray(DEFAULT_CONFIG.include));
      assert.ok(Array.isArray(DEFAULT_CONFIG.exclude));
      assert.ok(Array.isArray(DEFAULT_CONFIG.languages));
      assert.ok(typeof DEFAULT_CONFIG.features === 'object');
    });

    test('DEFAULT_INCLUDE contains expected patterns', () => {
      assert.ok(DEFAULT_INCLUDE.includes('src/**'));
      assert.ok(DEFAULT_INCLUDE.includes('packages/**'));
    });

    test('DEFAULT_EXCLUDE contains expected patterns', () => {
      assert.ok(DEFAULT_EXCLUDE.includes('node_modules/**'));
      assert.ok(DEFAULT_EXCLUDE.includes('dist/**'));
      assert.ok(DEFAULT_EXCLUDE.includes('build/**'));
      assert.ok(DEFAULT_EXCLUDE.includes('.git/**'));
    });

    test('DEFAULT_SENSITIVE_PATTERNS contains expected patterns', () => {
      assert.ok(DEFAULT_SENSITIVE_PATTERNS.some((p) => p.includes('.env')));
      assert.ok(DEFAULT_SENSITIVE_PATTERNS.some((p) => p.includes('secret')));
      assert.ok(DEFAULT_SENSITIVE_PATTERNS.some((p) => p.includes('key')));
    });
  });
});
