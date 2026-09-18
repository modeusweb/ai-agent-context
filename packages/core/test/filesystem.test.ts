/**
 * Tests for path utilities.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  toPosix,
  basename,
  extname,
  join,
  ancestors,
} from '../dist/index.js';

describe('path utilities', () => {
  test('toPosix converts Windows paths to POSIX', () => {
    assert.equal(toPosix('C:\\Users\\test\\file.ts'), 'C:/Users/test/file.ts');
    assert.equal(toPosix('relative\\path\\file.ts'), 'relative/path/file.ts');
    assert.equal(toPosix('already/posix/path.ts'), 'already/posix/path.ts');
  });

  test('basename extracts filename', () => {
    assert.equal(basename('src/utils/helper.ts'), 'helper.ts');
    assert.equal(basename('src/index.ts'), 'index.ts');
    assert.equal(basename('index.ts'), 'index.ts');
  });

  test('extname extracts extension', () => {
    assert.equal(extname('src/utils/helper.ts'), '.ts');
    assert.equal(extname('src/index.ts'), '.ts');
    assert.equal(extname('package.json'), '.json');
    assert.equal(extname('README'), '');
  });

  test('join joins paths', () => {
    assert.equal(join('src', 'utils', 'helper.ts'), 'src/utils/helper.ts');
    assert.equal(join('src', './utils', 'helper.ts'), 'src/utils/helper.ts');
  });

  test('ancestors returns all ancestor paths', () => {
    const result = ancestors('src/utils/helper.ts');
    assert.ok(result.includes('src'));
    assert.ok(result.includes('src/utils'));
    assert.ok(!result.includes('src/utils/helper.ts'));
  });
});
