/**
 * CLI end-to-end tests: the real `agent-context` binary is spawned against a
 * temporary fixture repository, exactly the way a user (or npx) would run it.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTemp, createTempRepo, readRepoFile, writeRepoFile } from '../../core/test/helpers.ts';


const CLI_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cli/dist/bin.js',
);

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
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { stdout: failure.stdout ?? String(error), status: failure.status ?? 1 };
  }
}

describe('cli end-to-end', () => {
  test('init / scan / status / explain / search / diff lifecycle', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);

    const init = run(root, ['init']);
    assert.equal(init.status, 0, init.stdout);
    assert.equal(existsSync(path.join(root, '.agent', 'config.json')), true);

    const scan = run(root, ['scan']);
    assert.equal(scan.status, 0, scan.stdout);
    assert.ok(scan.stdout.includes('agent-context') || scan.stdout.length > 0);
    assert.equal(existsSync(path.join(root, '.agent', 'index.json')), true);

    const scanJson = run(root, ['scan', '--json']);
    assert.equal(scanJson.status, 0);
    const parsedScan = JSON.parse(scanJson.stdout) as { files?: unknown; report?: unknown };
    assert.ok(parsedScan.files !== undefined || parsedScan.report !== undefined);

    const status = run(root, ['status', '--json']);
    assert.equal(status.status, 0);
    const statusReport = JSON.parse(status.stdout) as { status: string };
    assert.equal(statusReport.status, 'up-to-date');

    const explain = run(root, ['explain', 'src/models', '--json']);
    assert.equal(explain.status, 0, explain.stdout);
    const explanation = JSON.parse(explain.stdout) as { module: { id: string }; summary: string };
    assert.ok(explanation.module.id.length > 0);
    assert.ok(explanation.summary.length > 0);


    const search = run(root, ['search', 'format user name', '--json']);
    assert.equal(search.status, 0, `search exited ${search.status}: ${search.stdout.slice(0, 400)}`);
    const results = JSON.parse(search.stdout) as Array<{ id: string }> | { results?: Array<{ id: string }> };
    const list = Array.isArray(results) ? results : (results.results ?? []);
    assert.ok(Array.isArray(list) && list.length > 0, `unexpected search payload: ${search.stdout.slice(0, 400)}`);

    const task = run(root, ['task', 'format', 'user', 'name', '--target', 'src/models', '--max-modules', '2', '--json']);
    assert.equal(task.status, 0, task.stdout);
    const taskPayload = JSON.parse(task.stdout) as { task: string; modules: unknown[] };
    assert.equal(taskPayload.task, 'format user name');
    assert.ok(taskPayload.modules.length <= 2);

    const impact = run(root, ['impact', 'src/models', '--max-files', '2', '--json']);
    assert.equal(impact.status, 0, impact.stdout);
    const impactPayload = JSON.parse(impact.stdout) as { target: string; files: string[] };
    assert.equal(impactPayload.target, 'src/models');
    assert.ok(impactPayload.files.length <= 2);


    // Modify a file, then diff.
    writeRepoFile(root, 'src/models/user.ts', `${readRepoFile(root, 'src/models/user.ts').trimEnd()}\n// v2\n`);
    const diff = run(root, ['diff', '--json']);
    assert.equal(diff.status, 0, diff.stdout);
    const diffReport = JSON.parse(diff.stdout) as { files: { modified: string[] }; hasChanges: boolean };
    assert.equal(diffReport.hasChanges, true);
    assert.ok(diffReport.files.modified.includes('src/models/user.ts'));
  });

  test('verify passes for a fresh context and fails after drift', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    assert.equal(run(root, ['scan']).status, 0);

    const valid = run(root, ['verify', '--json']);
    assert.equal(valid.status, 0, valid.stdout);
    assert.equal((JSON.parse(valid.stdout) as { valid: boolean }).valid, true);

    writeRepoFile(root, 'src/index.ts', '// changed after scan\n');
    const stale = run(root, ['verify', '--json']);
    assert.equal(stale.status, 1);
    assert.equal((JSON.parse(stale.stdout) as { valid: boolean }).valid, false);
  });

  test('status reflects stale context in human readable output', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    assert.equal(run(root, ['scan']).status, 0);
    writeRepoFile(root, 'src/index.ts', '// changed\n');
    const status = run(root, ['status']);
    assert.equal(status.status, 0);
    assert.ok(/stale/i.test(status.stdout));
  });

  test('unknown command exits non-zero with usage help', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const result = run(root, ['definitely-not-a-command']);
    assert.notEqual(result.status, 0);
  });

  test('clean removes the generated context only', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    assert.equal(run(root, ['scan']).status, 0);
    assert.equal(existsSync(path.join(root, '.agent', 'index.json')), true);
    const result = run(root, ['clean', '--yes']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(existsSync(path.join(root, '.agent', 'index.json')), false);
    assert.equal(existsSync(path.join(root, 'src', 'index.ts')), true, 'source code must never be removed');
  });

  test('init does not overwrite an existing config without --force', () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    assert.equal(run(root, ['init']).status, 0);
    const before = readFileSync(path.join(root, '.agent', 'config.json'), 'utf8');
    writeRepoFile(root, '.agent/config.json', before.replace('"version": 1', '"version": 1, "custom": true'));
    assert.equal(run(root, ['init']).status, 0);
    assert.equal(readFileSync(path.join(root, '.agent', 'config.json'), 'utf8').includes('"custom": true'), true);
    assert.equal(run(root, ['init', '--force']).status, 0);
    assert.equal(readFileSync(path.join(root, '.agent', 'config.json'), 'utf8').includes('"custom"'), false);
  });
});
