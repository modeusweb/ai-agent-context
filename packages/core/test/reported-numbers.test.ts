/**
 * Two numbers in the persisted and reported context, each of which said
 * something other than what it was read as.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext, buildDependenciesDocument, runPipeline } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/**
 * A repository with no package manifest and no index file: every source file
 * is a module of its own, which is what makes an import cross-module — the
 * only kind the per-file projection records. With a `package.json`, the whole
 * repository is one package and one module.
 */
function repository(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  for (const file of ['src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'package.json']) {
    deleteRepoFile(root, file);
  }
  return root;
}

describe('import resolution rate', () => {
  test('counts import statements on both sides, also inside a single module', async () => {
    const root = repository();
    writeRepoFile(root, 'src/index.ts', "export { a } from './a';\nexport { b } from './b';\n");
    writeRepoFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
    writeRepoFile(root, 'src/b.ts', "import { gone } from './missing';\nexport const b = () => gone;\n");
    const context = await AgentContext.load({ root });
    await context.scan();

    const modules = (await context.getRepository()).modules.map((module) => module.id);
    assert.equal(modules.length, 1, 'the repository is one module, so it has no module edges');
    const report = await context.detect();
    assert.equal(report.imports.resolved, 3, 'three imports resolve: index→a, index→b, a→b');
    assert.equal(report.imports.unresolved, 1);
    assert.equal(report.imports.resolutionRate, 0.75, 'not 0, which a numerator of module edges produced');
  });

  test('a re-export is an import statement too', async () => {
    const root = repository();
    writeRepoFile(root, 'src/index.ts', "export { a } from './a';\n");
    writeRepoFile(root, 'src/a.ts', 'export const a = 1;\n');
    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();
    assert.equal(report.imports.resolved, 1);
    assert.equal(report.imports.resolutionRate, 1);
  });

  test('an import of an excluded file is still left out of both sides', async () => {
    const root = repository();
    writeRepoFile(root, 'src/credentials.ts', 'export const token = 1;\n');
    writeRepoFile(root, 'src/index.ts', "export { token } from './credentials.js';\n");
    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();
    assert.equal(report.imports.resolved, 0);
    assert.equal(report.imports.unresolved, 0);
    assert.equal(report.imports.excludedFiles, 1);
    assert.equal(report.imports.resolutionRate, 1);
  });
});

describe('fileImports in dependencies.json', () => {
  // `fileImports` is the per-file projection of *cross-module* imports: the
  // modules and packages a file depends on. An import inside one module is
  // not in it by design, so each importer below is a module of its own.
  test('describes every file with imports; the bound is no longer 400', async () => {
    const root = repository();
    writeRepoFile(root, 'src/shared.ts', 'export const s = 1;\n');
    for (let index = 0; index < 450; index += 1) {
      writeRepoFile(root, `src/mod${index}/f.ts`, "import { s } from '../shared';\nexport const v = s;\n");
    }
    const context = await AgentContext.load({ root });
    await context.scan();
    const document = await context.getDependencies();
    assert.equal(document.fileImports.length, 450);
    assert.equal(document.summary.fileImports, 450);
    assert.equal(document.summary.fileImportsTotal, 450);
    assert.equal(document.summary.fileImportsTruncated, false);
    assert.equal(document.summary.fileImportsLimit, undefined, 'no limit is reported when none was reached');
  });

  test('an import inside one module is not a cross-module import', async () => {
    const root = repository();
    writeRepoFile(root, 'src/shared.ts', 'export const s = 1;\n');
    writeRepoFile(root, 'src/a.ts', "import { s } from './shared';\nexport const a = s;\n");
    const context = await AgentContext.load({ root });
    await context.scan();
    const document = await context.getDependencies();
    assert.equal(document.summary.fileImports, 0);
  });

  test('a projection cut by the bound says so in the summary', async () => {
    const root = repository();
    writeRepoFile(root, 'src/shared.ts', 'export const s = 1;\n');
    for (const name of ['a', 'b', 'c']) writeRepoFile(root, `src/consumers/${name}/use.ts`, "import { s } from '../../shared';\nexport const v = s;\n");
    const result = await runPipeline({ root });
    const document = buildDependenciesDocument(result.graph, result.config, {
      diagnostics: [],
      commitsAnalyzed: 0,
      configHash: result.configHash,
      maxFileImports: 2,
    });
    assert.equal(document.fileImports.length, 2);
    assert.equal(document.summary.fileImportsTotal, 3);
    assert.equal(document.summary.fileImportsTruncated, true);
    assert.equal(document.summary.fileImportsLimit, 2);
  });
});
