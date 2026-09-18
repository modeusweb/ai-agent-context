/**
 * Tests for Git log parsing.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseGitLog } from '../dist/index.js';

describe('git log parsing', () => {
  test('handles empty input', () => {
    const commits = parseGitLog('');
    assert.equal(commits.length, 0);
  });
});
