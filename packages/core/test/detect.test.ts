/**
 * Coverage diagnostics (`detect`).
 *
 * The point of this command is that an agent can tell the difference between
 * "there are no dependencies here" and "the analyzer failed to resolve them".
 * These tests pin the classification, because collapsing the categories would
 * make a healthy repository look broken.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('detect', () => {
  test('reports a clean analysis for a repository it fully understands', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    assert.equal(report.counts.error, 0, JSON.stringify(report.issues, null, 2));
    assert.equal(report.imports.resolutionRate, 1);
    assert.equal(report.imports.pathEscapes, 0);
  });

  test('classifies imports of excluded build output as expected, not as failures', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, 'src/index.ts', 'export const a = 1;\n');
    // dist/ is excluded by the default configuration, so this can never resolve.
    writeRepoFile(root, 'dist/helper.js', 'export const helper = 1;\n');
    writeRepoFile(root, 'src/consumer.ts', "import { helper } from '../dist/helper.js';\nexport const used = helper;\n");

    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    assert.ok(report.imports.excludedOutput > 0, 'the build-output import must be classified as excluded');
    assert.equal(report.imports.unresolved, 0, 'an excluded build-output import is not a resolution failure');
    assert.equal(report.imports.resolutionRate, 1);
  });

  test('classifies an import that points at a missing file as a warning', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, 'src/index.ts', "export { gone } from './does-not-exist.ts';\n");

    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    assert.ok(report.imports.unresolved > 0);
    assert.ok(report.imports.resolutionRate < 1);
    const issue = report.issues.find((entry) => entry.kind === 'unresolved-import');
    assert.ok(issue, 'a genuinely missing import must be reported');
    assert.equal(issue.severity, 'warning');
  });

  test('a rejected path traversal is an error, not a warning', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(
      root,
      'src/index.ts',
      "import { x } from '../../../etc/passwd';\nexport const used = x;\n",
    );

    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    assert.equal(report.imports.pathEscapes, 1, 'the traversal must be counted as a path escape');
    assert.equal(report.counts.error, 1, `expected exactly one error, got ${JSON.stringify(report.issues, null, 2)}`);
    assert.equal(report.clean, false);
  });

  test('never marks a repository clean while an error is present', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, 'src/index.ts', "import { x } from '../../../etc/passwd';\nexport const used = x;\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();
    if (report.counts.error > 0) assert.equal(report.clean, false);
  });

  test('issues are ordered most severe first and are deterministic', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();

    const first = await context.detect();
    const second = await context.detect();
    assert.deepEqual(
      first.issues.map((issue) => `${issue.severity}:${issue.kind}`),
      second.issues.map((issue) => `${issue.severity}:${issue.kind}`),
      'detect must be deterministic across runs',
    );

    const ranks = { error: 0, warning: 1, info: 2 } as const;
    for (let index = 1; index < first.issues.length; index += 1) {
      assert.ok(
        ranks[first.issues[index - 1]!.severity] <= ranks[first.issues[index]!.severity],
        'issues must be sorted by severity',
      );
    }
  });

  test('reports how much of the repository was actually analyzed', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    assert.ok(report.analyzed.files > 0);
    assert.ok(report.analyzed.parsed > 0);
    assert.ok(report.analyzed.parsedShare > 0 && report.analyzed.parsedShare <= 1);
  });

  test('every issue carries a detail, a count and concrete samples', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();

    const report = await context.detect();
    for (const issue of report.issues) {
      assert.ok(issue.detail.length > 0, `${issue.kind} has no detail`);
      assert.ok(issue.count > 0, `${issue.kind} has a non-positive count`);
      assert.ok(issue.samples.length > 0, `${issue.kind} has no samples`);
      assert.ok(issue.samples.length <= issue.count);
    }
  });
});