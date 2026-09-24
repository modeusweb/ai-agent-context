/**
 * Tests for Git log parsing.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseGitLog, parseGitDiff } from '../dist/index.js';

describe('git log parsing', () => {
  test('handles empty input', () => {
    const commits = parseGitLog('');
    assert.equal(commits.length, 0);
  });

  test('parses changed file statuses including renames', () => {
    const files = parseGitDiff('M\tsrc/a.ts\nR100\told.ts\tsrc/new.ts');
    assert.deepEqual(files, [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'renamed', oldPath: 'old.ts' },
    ]);
  });
});
