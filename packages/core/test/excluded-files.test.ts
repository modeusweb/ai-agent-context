/**
 * Imports that point at files the analysis left out.
 *
 * Regression for two defects that only a large third-party repository showed,
 * and both of which made a healthy repository look broken.
 *
 * The first: an import of a file that exists but was excluded from the
 * analysis — a declaration file too large to read, or a file the
 * sensitive-file policy forbids — was reported as an import of a file that does
 * not exist. The distinction is the whole point. One is a limit of the
 * coverage; the other is a hole in the graph. Reporting both as missing made
 * `playwright` — which has a 1.5 MB generated declaration file that forty
 * modules import — report 53.8% import resolution and 255 unresolved imports.
 *
 * The second: a tsconfig path alias that matched but resolved to nothing ended
 * the search, so a specifier that was really a package name was never looked
 * up as one. TypeScript treats `paths` as one candidate among several and falls
 * back to node_modules; the same has to happen here, or a monorepo that
 * declares a wildcard alias for its own scope loses every package of that
 * scope.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

function repo(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  return root;
}

describe('excluded files', () => {
  test('an import of an excluded file is not a missing import', async () => {
    const root = repo();
    // A file the sensitive-file policy forbids reading: it exists, and the
    // import of it resolves in any compiler.
    writeRepoFile(root, 'src/credentials.ts', 'export const token = 1;\n');
    writeRepoFile(root, 'src/index.ts', "export { token } from './credentials.js';\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();

    const missing = report.issues.find((issue) => issue.kind === 'unresolved-import' && issue.severity === 'warning');
    assert.equal(missing, undefined, `the import was reported as missing: ${JSON.stringify(missing?.samples)}`);

    const excluded = report.issues.find((issue) => issue.kind === 'excluded-file');
    assert.ok(excluded !== undefined, 'the import was not reported as pointing at an excluded file');
    assert.equal(excluded.severity, 'info');
  });

  test('an excluded import is left out of the resolution rate', async () => {
    const root = repo();
    writeRepoFile(root, 'src/credentials.ts', 'export const token = 1;\n');
    writeRepoFile(root, 'src/index.ts', "export { token } from './credentials.js';\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();

    assert.equal(report.imports.excludedFiles, 1);
    assert.equal(
      report.imports.resolutionRate,
      1,
      'an excluded import is a limit of the coverage, not a failure to resolve',
    );
  });

  test('a genuinely missing import is still a missing import', async () => {
    const root = repo();
    writeRepoFile(root, 'src/index.ts', "export { token } from './nowhere.js';\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();

    assert.equal(report.imports.excludedFiles, 0);
    assert.ok(report.imports.resolutionRate < 1, 'a missing import must lower the resolution rate');
    const missing = report.issues.find((issue) => issue.kind === 'unresolved-import' && issue.severity === 'warning');
    assert.ok(missing !== undefined, 'a missing import must be reported as a warning');
  });
});

describe('path aliases', () => {
  test('an alias that resolves to nothing does not shadow a package name', async () => {
    const root = repo();
    // A monorepo that declares a wildcard alias for its own scope, and also
    // has a package of that scope in a directory of its own.
    writeRepoFile(
      root,
      'tsconfig.json',
      `${JSON.stringify(
        {
          compilerOptions: {
            paths: { '@scope/*': ['./packages/*/src/*'] },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeRepoFile(root, 'packages/thing/src/index.ts', 'export const thing = 1;\n');
    writeRepoFile(root, 'src/index.ts', "export { thing } from '@scope/thing';\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();

    const aliasErrors = report.issues.filter((issue) => issue.kind === 'unresolved-alias');
    assert.deepEqual(
      aliasErrors,
      [],
      'a specifier that names a package must not be reported as an unresolved alias',
    );
  });
});