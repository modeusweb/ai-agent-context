/**
 * Incremental scanning: only changed files are reparsed, and the local state
 * classifies added/modified/deleted/unchanged correctly.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, readRepoFile, writeRepoFile } from './helpers.ts';


const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** Each fresh() call is a full new AgentContext, as the CLI would create one. */
async function fresh(root: string): Promise<ReturnType<AgentContext['scan']> extends Promise<infer T> ? T : never> {
  const context = await AgentContext.load({ root });
  return context.scan();
}

describe('incremental scanning (simple-ts)', () => {
  test('second scan reuses the cache and reports everything unchanged', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const cold = await fresh(root);
    assert.equal(cold.changes.incremental, false);
    assert.ok(cold.files.total > 0);

    const warm = await fresh(root);
    assert.equal(warm.changes.incremental, true);
    assert.equal(warm.changes.modified.length, 0);
    assert.equal(warm.changes.added.length, 0);
    assert.equal(warm.changes.deleted.length, 0);
    assert.equal(warm.reused, warm.files.total, 'every file must come from the cache');
    assert.equal(warm.parsed, 0);
  });

  test('modifying one file reparses only that file', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);

    const modifiedPath = 'src/utils/format-user-name.ts';
    writeRepoFile(root, modifiedPath, `${readRepoFile(root, modifiedPath).trimEnd()}\n// touched\n`);
    const report = await fresh(root);
    assert.equal(report.changes.incremental, true);
    assert.deepEqual(report.changes.modified, [modifiedPath]);
    assert.equal(report.parsed, 1, 'exactly the changed file must be reparsed');
    assert.ok(report.affected.files.includes(modifiedPath));
    assert.ok(report.affected.modules.length > 0);
    assert.equal(report.reused, report.files.total - 1);
  });

  test('adding and deleting files updates the change set', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);

    writeRepoFile(root, 'src/extra/refund-service.ts', 'export class RefundService {}\n');
    const addedReport = await fresh(root);
    assert.deepEqual(addedReport.changes.added, ['src/extra/refund-service.ts']);
    assert.ok(addedReport.affected.files.includes('src/extra/refund-service.ts'));

    await fresh(root);
    deleteRepoFile(root, 'src/extra/refund-service.ts');
    const removedReport = await fresh(root);

    assert.deepEqual(removedReport.changes.deleted, ['src/extra/refund-service.ts']);
    assert.equal(removedReport.changes.added.length, 0);
  });

  test('status flips from up-to-date to stale after an edit', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    assert.equal((await context.status()).status, 'up-to-date');

    const modifiedPath = 'src/models/user.ts';
    writeRepoFile(root, modifiedPath, `${readRepoFile(root, modifiedPath).trimEnd()}\n// touch\n`);
    const staleContext = await AgentContext.load({ root });
    const status = await staleContext.status();
    assert.equal(status.status, 'stale');
    assert.deepEqual(status.changes.modified, [modifiedPath]);
  });
});


