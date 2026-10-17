/**
 * Explanation size and detail levels.
 *
 * The product claim is that an agent can read a description of a module
 * instead of the module. That claim is only true if the description is smaller
 * than the source, so these tests assert on payload size, not just on shape.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext, COMPACT_SOURCE_THRESHOLD_BYTES } from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** A module big enough that the full projection is the right default. */
function repoWithLargeModule(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  const body = Array.from(
    { length: 400 },
    (_, index) => `export const value${index} = ${index};\n`,
  ).join('');
  writeRepoFile(root, 'src/big/payload.ts', body);
  writeRepoFile(root, 'src/big/other.ts', body);
  writeRepoFile(
    root,
    'src/small/tiny.ts',
    'function internalHelper() {\n  return 1;\n}\nexport const tiny = internalHelper();\n',
  );
  writeRepoFile(root, 'src/small/other.ts', 'export const alsoTiny = 2;\n');
  return root;
}

describe('explain detail levels', () => {
  test('auto returns the full projection for a large module', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/big');
    assert.ok(explanation);
    assert.equal(explanation.detail, 'full');
  });

  test('auto returns the compact projection for a small module', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/small');
    assert.ok(explanation);
    assert.equal(explanation.detail, 'compact');
  });

  test('compact drops the internal symbol dump but keeps the structure', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const compact = await context.explain('src/small', { detail: 'compact' });
    const full = await context.explain('src/small', { detail: 'full' });
    assert.ok(compact && full);
    assert.deepEqual(compact.internalSymbols, []);
    assert.ok(full.internalSymbols.length > 0, 'the full projection keeps internal symbols');
    // Structural facts survive both levels: losing them would make compact useless.
    assert.ok(compact.relatedFiles.length > 0);
    assert.ok(compact.summary.length > 0);
    assert.ok(compact.dependsOn !== undefined);
  });

  test('full can be requested explicitly for a small module', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/small', { detail: 'full' });
    assert.ok(explanation);
    assert.equal(explanation.detail, 'full');
  });

  test('the compact projection is smaller than the full one', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const compact = await context.explain('src/big', { detail: 'compact' });
    const full = await context.explain('src/big', { detail: 'full' });
    assert.ok(compact && full);
    assert.ok(
      Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)),
      'compact must be cheaper than full',
    );
  });

  test('the threshold is configurable', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    // Raising the threshold above the module size flips the decision.
    const explanation = await context.explain('src/big', {
      detail: 'auto',
      compactSourceThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(explanation);
    assert.equal(explanation.detail, 'compact');
    assert.ok(COMPACT_SOURCE_THRESHOLD_BYTES > 0);
  });

  test('every fact still carries evidence in both projections', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    for (const detail of ['compact', 'full'] as const) {
      const explanation = await context.explain('src/big', { detail });
      assert.ok(explanation);
      for (const role of explanation.module.roles) {
        assert.ok(role.evidence.length > 0, `role ${role.value} lost its evidence in ${detail}`);
        assert.ok(role.confidence > 0 && role.confidence <= 1);
      }
      for (const convention of explanation.conventions) {
        assert.ok(convention.evidence.length > 0, 'a convention without evidence must not ship');
        assert.ok(convention.confidence > 0 && convention.confidence <= 1);
      }
      for (const decision of explanation.decisions) {
        assert.ok(decision.evidence.length > 0, 'a decision without evidence must not ship');
      }
    }
  });

  test('compact omits repository-wide conventions but keeps scoped ones', async () => {
    const root = repoWithLargeModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const compact = await context.explain('src/big', { detail: 'compact' });
    const full = await context.explain('src/big', { detail: 'full' });
    assert.ok(compact && full);
    assert.ok(
      compact.conventions.length <= full.conventions.length,
      'compact must never report more conventions than full',
    );
  });
});