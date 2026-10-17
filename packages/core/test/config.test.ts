/**
 * Tests for configuration loading and validation.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
  DEFAULT_SENSITIVE_PATTERNS,
  TOOL_VERSION,
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

    test('DEFAULT_INCLUDE covers source files outside src/', () => {
      assert.ok(DEFAULT_INCLUDE.some((p) => p.includes('{') && p.includes('ts')));
    });
  });

  describe('version', () => {
    test('TOOL_VERSION matches packages/core/package.json', () => {
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
      assert.equal(TOOL_VERSION, pkg.version);
    });
  });
});
