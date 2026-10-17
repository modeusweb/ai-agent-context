/**
 * Target resolution and explanation scoping.
 *
 * `explain`/`impact` are the two commands an agent calls before touching code.
 * Returning a wide slice of the repository when a narrow one was requested (or
 * an empty result for a directory that exists) is the failure mode these tests
 * pin down.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/**
 * Builds a small repository whose interesting directory sits deeper than
 * `analysis.moduleDepth`, which is what module detection refuses to promote.
 */
function repoWithDeepModule(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  writeRepoFile(root, 'src/index.ts', "export const version = '1.0.0';\n");
  writeRepoFile(root, 'src/deep/nested/leaf.ts', 'export const leaf = 1;\n');
  writeRepoFile(root, 'src/deep/nested/other.ts', 'export const other = 2;\n');
  writeRepoFile(root, 'src/deep/middle.ts', 'export const middle = 3;\n');
  return root;
}

describe('explain target resolution', () => {
  test('a directory deeper than moduleDepth is scoped, not widened', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/deep/nested');
    assert.ok(explanation, 'the directory must resolve to something');
    assert.equal(explanation.scope?.directory, 'src/deep/nested');
    assert.equal(explanation.module.path, 'src/deep/nested');
    assert.equal(explanation.scope?.fileCount, 2);
  });

  test('a scoped explanation covers only the requested directory', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/deep/nested');
    assert.ok(explanation);
    for (const file of explanation.relatedFiles) {
      assert.ok(
        file.startsWith('src/deep/nested/'),
        `scoped answer leaked unrelated file: ${file}`,
      );
    }
    // The owning module also contains files outside the scope; those must not appear.
    const owning = await context.explain('src');
    assert.ok(owning);
    assert.ok(owning.relatedFiles.length > explanation.relatedFiles.length);
  });

  test('a scoped explanation states that it is narrower than its module', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/deep/nested');
    assert.ok(explanation?.scope);
    assert.equal(typeof explanation.scope.moduleId, 'string');
    assert.ok(explanation.scope.moduleId.length > 0);
  });

  test('a detected module is answered as a whole, without a scope', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src');
    assert.ok(explanation);
    assert.equal(explanation.scope, undefined);
    assert.equal(explanation.module.path, 'src');
  });

  test('a directory holding a single direct file is still scoped', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    // src/deep holds only middle.ts directly, so it is not promoted to a module,
    // but it is a real directory and must be answered precisely.
    const explanation = await context.explain('src/deep');
    assert.ok(explanation);
    assert.equal(explanation.scope?.directory, 'src/deep');
    assert.equal(explanation.scope?.fileCount, 3);
  });

  test('a single file still resolves to its module by file path', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/deep/middle.ts');
    assert.ok(explanation);
    assert.equal(explanation.scope, undefined);
    assert.match(explanation.summary, /matched to this module by file path/);
  });

  test('an unknown target resolves to nothing', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    assert.equal(await context.explain('does/not/exist'), null);
  });
});

describe('change impact for a scoped directory', () => {
  test('impact lists the file that imports the scoped directory', async () => {
    const root = repoWithDeepModule();
    writeRepoFile(root, 'src/consumer.ts', "import { leaf } from './deep/nested/leaf.ts';\nexport const used = leaf;\n");
    const context = await AgentContext.load({ root });
    await context.scan();

    const impact = await context.getChangeImpact('src/deep/nested');
    assert.ok(
      impact.files.includes('src/consumer.ts'),
      'the importing file must be listed as affected',
    );
    // The importer lives in the module that owns the scope, so that module is
    // not itself reported as broken.
    assert.ok(!impact.modules.includes('src'));
  });

  test('impact propagates to a module in another package', async () => {
    const root = repoWithDeepModule();
    // A second module that imports the scoped directory, so the transitive hop
    // across modules is exercised.
    writeRepoFile(root, 'src/app/consumer.ts', "import { leaf } from '../deep/nested/leaf.ts';\nexport const used = leaf;\n");
    writeRepoFile(root, 'src/app/other.ts', 'export const other = 5;\n');
    const context = await AgentContext.load({ root });
    await context.scan();

    const explanation = await context.explain('src/deep/nested');
    assert.ok(explanation);
    assert.ok(
      explanation.usedBy.some((entry) => entry.id.endsWith('app')),
      `expected the app module in usedBy, got ${JSON.stringify(explanation.usedBy.map((e) => e.id))}`,
    );

    const impact = await context.getChangeImpact('src/deep/nested');
    assert.ok(impact.modules.some((id) => id.endsWith('app')));
  });

  test('impact of an isolated directory is empty rather than wrong', async () => {
    const root = repoWithDeepModule();
    const context = await AgentContext.load({ root });
    await context.scan();

    const impact = await context.getChangeImpact('src/deep/nested');
    // Nothing imports it, so the honest answer is an empty impact set.
    assert.deepEqual(impact.files, []);
    assert.deepEqual(impact.modules, []);
  });
});