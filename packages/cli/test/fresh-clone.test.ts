/**
 * CLI tests for the behaviour a *fresh clone* sees.
 *
 * `.agent/.local/` is gitignored, so nothing in it exists on a clean checkout
 * or in CI. These tests remove it from a scanned fixture — exactly what a
 * clone produces — and run the real binary the way a user or a workflow does.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTemp, createTempRepo, readRepoFile, writeRepoFile } from '../../core/test/helpers.ts';

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli/dist/bin.js');

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

function run(root: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, status: failure.status ?? 1 };
  }
}

/** A scanned repository without its local state: what `git clone` checks out. */
function freshClone(): string {
  const root = createTempRepo('layered-app');
  tempRoots.push(root);
  assert.equal(run(root, ['scan']).status, 0);
  rmSync(path.join(root, '.agent', '.local'), { recursive: true, force: true });
  return root;
}

describe('cli on a fresh clone', () => {
  test('verify passes when the committed context matches the tree', () => {
    const root = freshClone();
    const result = run(root, ['verify']);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Status: up-to-date/);
    assert.match(result.stdout, /Baseline: committed \.agent\/index\.json/, 'the output says what was compared');
    assert.match(result.stdout, /Context verification passed\./);
  });

  test('verify fails and names the file once the tree drifts', () => {
    const root = freshClone();
    const file = 'src/application/payment-service.ts';
    writeRepoFile(root, file, `${readRepoFile(root, file)}\n// edited without a rescan\n`);
    const result = run(root, ['verify']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /Modified: 1 file\(s\)/);
    assert.match(result.stdout, /git add \.agent/, 'the fix for a committed context includes committing it');
  });

  test('migrate --check reports a fresh clone as current', () => {
    const root = freshClone();
    const result = run(root, ['migrate', '--check']);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Context is current\./);
  });

  test('verify --json reports the baseline and stays machine readable', () => {
    const root = freshClone();
    const payload = JSON.parse(run(root, ['verify', '--json']).stdout) as {
      valid: boolean;
      baseline: string;
      changes: { unchangedCount: number };
    };
    assert.equal(payload.valid, true);
    assert.equal(payload.baseline, 'committed-index');
    assert.equal(payload.changes.unchangedCount > 0, true);
  });

  test('--compact minifies --json output without changing the data', () => {
    const root = freshClone();
    const indented = run(root, ['explain', 'src', '--json']).stdout;
    const compact = run(root, ['explain', 'src', '--json', '--compact']).stdout;
    assert.deepEqual(JSON.parse(compact), JSON.parse(indented), 'same data');
    assert.equal(compact.includes('\n  "'), false, 'no indentation');
    assert.equal(compact.length < indented.length, true, `${compact.length} should be shorter than ${indented.length}`);
  });
});
