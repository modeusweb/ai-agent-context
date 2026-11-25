/**
 * An import of a package's directory follows the package's manifest.
 *
 * `from '..'` in a package's test folder and `require('../..')` in an example
 * are imports of the package. What they get is what the manifest declares as
 * the entry of the package itself:
 *
 *  - where that is build output, the analysis does not have the file, and says
 *    so — it must not draw an edge to the source index through the fallback a
 *    manifest that declares nothing would use;
 *  - it is not `bin`, which is an executable, and not a subpath under
 *    `exports` such as `"./package.json"`, which is as likely to be there as
 *    the root.
 *
 * Both mistakes were made on the way here, and the compiler oracle caught the
 * first on this repository (`packages/core/test -> @ai-agent-context/core`)
 * and the second in the same place, one commit later. An importer inside the
 * package's own module would hide both: an edge from a module to itself is not
 * drawn, so every importer below sits in a module of its own.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const LIB = 'packages/lib';

/**
 * A workspace whose `lib` package declares `manifest`, with a source index and
 * a test folder of two files — two, so that the folder is a module of its own.
 */
function workspace(manifest: Record<string, unknown>): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  for (const file of ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
    deleteRepoFile(root, file);
  }
  writeRepoFile(root, 'package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
  writeRepoFile(root, `${LIB}/package.json`, JSON.stringify({ name: '@ac/lib', ...manifest }));
  writeRepoFile(root, `${LIB}/src/index.ts`, 'export const a = 1;\n');
  writeRepoFile(root, `${LIB}/src/util.ts`, 'export const util = () => 1;\n');
  writeRepoFile(root, `${LIB}/bin/cli.js`, "console.log('cli');\n");
  // The import of the package's directory; the second file only makes the folder a module.
  writeRepoFile(root, `${LIB}/test/config.test.ts`, "import { a } from '..';\nexport const b = a;\n");
  writeRepoFile(root, `${LIB}/test/other.test.ts`, "import { util } from '../src/util';\nexport const c = util;\n");
  return root;
}

const edgesToLib = async (root: string): Promise<Array<[string, string]>> =>
  (await (await AgentContext.load({ root })).getRepository())
    .dependencies.filter((edge) => edge.to === '@ac/lib')
    .map((edge) => [edge.from, edge.kind]);

describe("an import of a package's directory", () => {
  test('is not an edge when the declared entry is build output, and is reported as such', async () => {
    const root = workspace({ main: './dist/index.js', types: './dist/index.d.ts' });
    const context = await AgentContext.load({ root });
    const report = await context.detect();
    assert.equal(report.imports.unresolved, 0, 'it is not a missing file');
    assert.equal(report.imports.excludedOutput, 1, "the manifest's entry is build output, which the analysis excludes");
    assert.deepEqual(await edgesToLib(root), [], 'no edge to the package: neither through its source index nor otherwise');
  });

  test('is not resolved to a subpath export, to the exported package.json or to bin', async () => {
    const root = workspace({
      exports: { '.': './dist/index.js', './util': './src/util.ts', './package.json': './package.json' },
      bin: { lib: './bin/cli.js' },
    });
    const context = await AgentContext.load({ root });
    const report = await context.detect();
    assert.equal(report.imports.excludedOutput, 1, 'the root export is build output');
    assert.deepEqual(await edgesToLib(root), []);
  });

  test('resolves to the declared entry when that entry is an analyzed file', async () => {
    const root = workspace({ main: './lib.js' });
    writeRepoFile(root, `${LIB}/lib.js`, 'module.exports = () => 1;\n');
    const context = await AgentContext.load({ root });
    assert.deepEqual(await edgesToLib(root), [[`${LIB}/test`, 'workspace-package']]);
    const outline = await context.getFileOutline(`${LIB}/lib.js`);
    assert.deepEqual(
      outline?.importers.direct.map((entry) => [entry.file, entry.syntax]),
      [[`${LIB}/test/config.test.ts`, 'static']],
    );
  });

  test('follows the root export when the manifest declares nothing else', async () => {
    const root = workspace({ exports: { '.': './src/index.ts', './util': './src/util.ts' } });
    const context = await AgentContext.load({ root });
    const outline = await context.getFileOutline(`${LIB}/src/index.ts`);
    assert.deepEqual(
      outline?.importers.direct.map((entry) => entry.file),
      [`${LIB}/test/config.test.ts`],
      'through the root export, not through ./util',
    );
    const util = await context.getFileOutline(`${LIB}/src/util.ts`);
    assert.equal(
      util?.importers.direct.some((entry) => entry.file === `${LIB}/test/config.test.ts`),
      false,
      'the ./util subpath is not what an import of the package gets',
    );
  });

  test('uses the source index for a manifest that declares no entry at all', async () => {
    const root = workspace({});
    const outline = await (await AgentContext.load({ root })).getFileOutline(`${LIB}/src/index.ts`);
    assert.deepEqual(
      outline?.importers.direct.map((entry) => entry.file),
      [`${LIB}/test/config.test.ts`],
    );
  });
});
