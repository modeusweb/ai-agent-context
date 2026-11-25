/**
 * `verify` against the committed context.
 *
 * `.agent/.local/state.json` is gitignored, so a fresh clone — which is every
 * CI checkout — has none. The change set then has to be measured against the
 * one record that does survive a clone: the hashes in the committed
 * `index.json`. Before this baseline existed, every file on a fresh clone was
 * reported as added and `verify` exited 1 for a context that matched the tree
 * exactly, which made the published CI gate unusable on any repository.
 *
 * A "fresh clone" in these tests is a scanned repository with `.agent/.local`
 * removed: that is precisely what `git clone` produces.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentContext, AGENT_DIR, LOCAL_DIR } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, readRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** What a clone does not carry: the gitignored local state and parse cache. */
const localDirectory = (root: string): string => path.join(root, AGENT_DIR, LOCAL_DIR);

const MODIFIED = 'src/application/payment-service.ts';
const DELETED = 'src/domain/user.ts';

/** Scans a fixture, then removes what a clone would not carry. */
async function scannedThenCloned(fixture = 'layered-app'): Promise<string> {
  const root = createTempRepo(fixture);
  tempRoots.push(root);
  const context = await AgentContext.load({ root });
  await context.scan();
  rmSync(localDirectory(root), { recursive: true, force: true });
  assert.equal(existsSync(localDirectory(root)), false, 'the local state must be gone, as after a clone');
  return root;
}

describe('verify against the committed context', () => {
  test('a fresh clone with a matching context is up to date', async () => {
    const root = await scannedThenCloned();
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.baseline, 'committed-index');
    assert.equal(status.status, 'up-to-date', JSON.stringify(status.changes));
    assert.equal(status.changes.added.length, 0, 'no file may be reported as added against a matching context');
    assert.equal(status.configHashMatches, true);
    assert.equal(status.counts.files > 0, true, 'counts describe the tree, not the absence of local state');
  });

  test('a file modified after the context was committed is reported as modified', async () => {
    const root = await scannedThenCloned();
    writeRepoFile(root, MODIFIED, `${readRepoFile(root, MODIFIED)}\n// edited after the last scan\n`);
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.status, 'stale');
    assert.deepEqual(status.changes.modified, [MODIFIED]);
    assert.equal(status.changes.added.length, 0, 'untouched files stay unchanged');
  });

  test('a file added or deleted after the context was committed is reported', async () => {
    const root = await scannedThenCloned();
    deleteRepoFile(root, DELETED);
    writeRepoFile(root, 'src/application/audit-service.ts', 'export class AuditService {}\n');
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.status, 'stale');
    assert.deepEqual(status.changes.deleted, [DELETED]);
    assert.deepEqual(status.changes.added, ['src/application/audit-service.ts']);
  });

  test('a configuration change is detected without local state', async () => {
    const root = await scannedThenCloned();
    const context = await AgentContext.load({ root });
    const index = JSON.parse(readFileSync(path.join(root, '.agent', 'index.json'), 'utf8')) as { configHash: string };
    assert.equal(typeof index.configHash, 'string', 'the committed index records the configuration it was generated with');

    writeRepoFile(root, '.agent/config.json', JSON.stringify({ exclude: ['src/application/**'] }));
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.configHashMatches, false, 'the context was generated under different analysis rules');
    assert.equal(status.status, 'stale');
    void context;
  });

  test('a context generated before the hash was recorded is not failed for it', async () => {
    const root = await scannedThenCloned();
    const indexPath = path.join(root, '.agent', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    delete index.configHash;
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.baseline, 'committed-index');
    assert.equal(status.configHashMatches, true, 'an unrecorded hash is unknown, not a mismatch');
    assert.equal(status.status, 'up-to-date');
  });

  test('with local state present, the local state remains the baseline', async () => {
    const root = createTempRepo('layered-app');
    tempRoots.push(root);
    await (await AgentContext.load({ root })).scan();
    const status = await (await AgentContext.load({ root })).status();
    assert.equal(status.baseline, 'local-state');
    assert.equal(status.status, 'up-to-date');
  });

  test('--force measures against nothing, the committed context included', async () => {
    const root = await scannedThenCloned();
    const report = await (await AgentContext.load({ root })).scan({ force: true });
    assert.equal(report.changes.added.length, report.files.total, 'a forced scan reports every file as added');
  });

  test('verify never writes: a fresh clone still has no local state afterwards', async () => {
    const root = await scannedThenCloned();
    await (await AgentContext.load({ root })).status();
    assert.equal(existsSync(localDirectory(root)), false, 'verification must leave no trace');
  });
});

describe('staleness of an analysis held in memory', () => {
  test('isStale is false before the first query and on an unchanged repository', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    assert.equal(await context.isStale(), false, 'nothing is cached, so nothing can be stale');
    await context.explain('src');
    assert.equal(await context.isStale(), false);
  });

  test('isStale is true after a file is added, edited or deleted', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.explain('src');

    writeRepoFile(root, 'src/refund-service.ts', 'export const refund = () => 1;\n');
    assert.equal(await context.isStale(), true, 'an added file must be noticed');

    await context.invalidate();
    await context.explain('src');
    assert.equal(await context.isStale(), false);

    const existing = 'src/models/user.ts';
    const original = readRepoFile(root, existing);
    writeRepoFile(root, existing, `${original}\n// edited\n`);
    assert.equal(await context.isStale(), true, 'an edited file must be noticed');

    await context.invalidate();
    await context.explain('src');
    deleteRepoFile(root, existing);
    assert.equal(await context.isStale(), true, 'a deleted file must be noticed');
  });

  test('isStale is true when the configuration changes', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.explain('src');
    writeRepoFile(root, '.agent/config.json', JSON.stringify({ exclude: ['src/models/**'] }));
    assert.equal(await context.isStale(), true);
  });

  test('invalidate makes the next query describe the repository as it is now', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    const before = (await context.explain('src'))!;
    assert.equal(before.relatedFiles.includes('src/refund-service.ts'), false);

    writeRepoFile(root, 'src/refund-service.ts', 'export const refund = () => 1;\n');
    const stale = (await context.explain('src'))!;
    assert.equal(stale.relatedFiles.includes('src/refund-service.ts'), false, 'without invalidation the old analysis is reused');

    await context.invalidate();
    const refreshed = (await context.explain('src'))!;
    assert.equal(refreshed.relatedFiles.includes('src/refund-service.ts'), true);
  });
});
