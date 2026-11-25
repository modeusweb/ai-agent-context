/**
 * Navigation at the level of a file and a symbol.
 *
 * `explain` answers for a module. An agent that is about to edit one function
 * needs three things the module graph never said: what this file exports and
 * imports, which files import it, and where a symbol is used — through barrels
 * included. And before deleting something, whether anything still uses it.
 *
 * Every expectation below is a fact about an `import` statement written in the
 * fixture, at a known line.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const FILES = {
  'package.json': JSON.stringify({ name: 'app', private: true }),
  // pay.ts: charge at line 1, CURRENCY at 4, legacy at 5.
  'src/payments/pay.ts': 'export function charge(amount: number) {\n  return amount;\n}\nexport const CURRENCY = \'USD\';\nexport function legacy() {}\n',
  'src/payments/index.ts': "export { charge, CURRENCY } from './pay';\nexport * from './refund';\n",
  'src/payments/refund.ts': 'export function refund() {}\n',
  'src/barrel.ts': "export * from './payments';\n",
  // order.ts: the import at line 1, validate at 2, placeOrder at 3.
  'src/orders/order.ts':
    "import { charge as payNow, CURRENCY } from '../payments';\nfunction validate() {}\nexport function placeOrder() {\n  return payNow(1) + CURRENCY + validate();\n}\n",
  'src/api/routes.ts': "import * as payments from '../barrel';\nexport function handler() {\n  return payments.refund();\n}\n",
  'src/api/server.ts':
    "import { placeOrder } from '../orders/order';\nimport { usedHelper } from '../util';\nimport config from '../config';\nconst app = express();\napp.get('/orders', () => placeOrder());\nexport {};\n",
  'src/util.ts': "const fs = require('node:fs');\nconst helpers = require('./helpers');\nexport function unusedHelper() {}\nexport function usedHelper() {}\n",
  'src/helpers.ts': 'export const help = 1;\n',
  'src/legacy/old.ts': 'export function abandoned() {}\n',
  'src/legacy/index.ts': "export { abandoned } from './old';\n",
  'src/config.ts': "export default { port: 8080 };\nexport const named = 2;\n",
  'test/orders.test.ts': "import { placeOrder } from '../src/orders/order';\nexport function run() {\n  return placeOrder();\n}\n",
};

/** The fixture tree above, in an empty repository. */
async function repository(): Promise<AgentContext> {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  for (const file of ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
    deleteRepoFile(root, file);
  }
  for (const [file, contents] of Object.entries(FILES)) writeRepoFile(root, file, contents);
  return AgentContext.load({ root });
}

describe('file outline', () => {
  test('lists what a file exports, with how many import statements bind each', async () => {
    const context = await repository();
    const outline = await context.getFileOutline('src/payments/pay.ts');
    assert.ok(outline);
    assert.equal(outline.module, 'src/payments');
    assert.deepEqual(
      outline.exports.map((entry) => [entry.name, entry.line, entry.references]),
      [
        ['charge', 1, 1],
        ['CURRENCY', 4, 1],
        ['legacy', 5, 0],
      ],
    );
    assert.deepEqual(outline.imports, [], 'pay.ts imports nothing');
    assert.deepEqual(outline.routes, []);
  });

  test('a re-export names the file that declares the symbol and both lines', async () => {
    const context = await repository();
    const outline = await context.getFileOutline('src/payments/index.ts');
    assert.ok(outline);
    assert.deepEqual(
      outline.exports.map((entry) => [entry.name, entry.line, entry.reexportedFrom, entry.declaredLine]),
      [
        // Both are re-exported by the statement at line 1; within a line the
        // order is the code-unit one the whole analyzer sorts by.
        ['CURRENCY', 1, 'src/payments/pay.ts', 4],
        ['charge', 1, 'src/payments/pay.ts', 1],
        // The `export *` that brings refund in is at line 2.
        ['refund', 2, 'src/payments/refund.ts', 1],
      ],
    );
  });

  test('resolves every import of the file, and says why one does not resolve', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    for (const file of ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
      deleteRepoFile(root, file);
    }
    writeRepoFile(root, 'src/a.ts', "import fs from 'node:fs';\nimport express from 'express';\nimport { b } from './b';\nimport { gone } from './nowhere';\nimport { c } from './c';\nexport const a = [b, c];\n");
    writeRepoFile(root, 'src/b.ts', 'export const b = 1;\n');
    writeRepoFile(root, 'src/c.tsx', 'export const c = 2;\n');
    const outline = await (await AgentContext.load({ root })).getFileOutline('src/a.ts');
    assert.ok(outline);
    assert.deepEqual(
      outline.imports.map((entry) => [entry.line, entry.specifier, entry.targetKind, entry.target]),
      [
        [1, 'node:fs', 'node-builtin', 'node:fs'],
        [2, 'express', 'external-package', 'express'],
        [3, './b', 'internal-file', 'src/b.ts'],
        [4, './nowhere', 'unresolved', null],
        [5, './c', 'internal-file', 'src/c.tsx'],
      ],
    );
    assert.equal(outline.imports[3]?.reason, 'missing');
  });

  test('lists the direct importers and everything that depends on them, tests included', async () => {
    const context = await repository();
    const outline = await context.getFileOutline('src/payments/pay.ts');
    assert.ok(outline);
    assert.deepEqual(
      outline.importers.direct.map((entry) => [entry.file, entry.line, entry.syntax, entry.names]),
      [['src/payments/index.ts', 1, 'reexport', ['charge', 'CURRENCY']]],
    );
    assert.deepEqual(outline.importers.transitive, [
      'src/api/routes.ts',
      'src/api/server.ts',
      'src/barrel.ts',
      'src/orders/order.ts',
      'test/orders.test.ts',
    ]);
    assert.equal(outline.importers.transitiveCount, 5, 'the direct importer is not repeated in the transitive list');
    assert.deepEqual(outline.importers.tests, ['test/orders.test.ts'], 'the test to run after changing the file');
  });

  test('a file only a barrel imports has that barrel and nothing else', async () => {
    const context = await repository();
    const outline = await context.getFileOutline('src/legacy/old.ts');
    assert.ok(outline);
    assert.deepEqual(outline.importers.direct.map((entry) => entry.file), ['src/legacy/index.ts']);
    assert.deepEqual(outline.importers.transitive, []);
    assert.equal(outline.importers.transitiveCount, 0);
  });

  test('lists declarations the file does not export', async () => {
    const context = await repository();
    const outline = await context.getFileOutline('src/orders/order.ts');
    assert.ok(outline);
    assert.deepEqual(outline.internalSymbols, [{ name: 'validate', kind: 'function', line: 2 }]);
  });

  test('accepts a path without its extension, and refuses what is not an analyzed file', async () => {
    const context = await repository();
    assert.equal((await context.getFileOutline('src/payments/pay'))?.file, 'src/payments/pay.ts');
    // A directory that has an index file names that file, as an import of it would.
    assert.equal((await context.getFileOutline('src/payments'))?.file, 'src/payments/index.ts');
    assert.equal(await context.getFileOutline('src/orders'), null, 'a directory without an index file is a module: that is `explain`');
    assert.equal(await context.getFileOutline('src/does-not-exist.ts'), null);
  });
});

describe('references', () => {
  test('finds the import of a symbol through a barrel, naming the barrel', async () => {
    const context = await repository();
    const report = await context.findReferences('charge');
    assert.equal(report.status, 'found');
    assert.deepEqual(report.target, { file: 'src/payments/pay.ts', symbol: 'charge', kind: 'function', line: 1, exported: true, isDefault: false });
    assert.deepEqual(report.references, [
      { file: 'src/orders/order.ts', line: 1, specifier: '../payments', importedAs: 'charge', typeOnly: false, via: ['src/payments/index.ts'] },
    ]);
    assert.deepEqual(report.reexportedBy, [{ file: 'src/payments/index.ts', line: 1, name: 'charge' }]);
    // Being *used* by an entry point is the reference above. Reachable means
    // something else: exposed by a surface a consumer outside the tree imports.
    assert.equal(report.externallyReachable, false);
    assert.ok(report.evidence.some((entry) => entry.source === 'src/orders/order.ts'));
  });

  test('a namespace import is reported as possible, through every barrel on the way', async () => {
    const context = await repository();
    const report = await context.findReferences('src/payments/refund.ts#refund');
    assert.equal(report.status, 'found');
    assert.deepEqual(report.references, [], 'which member a namespace import uses is not in the statement');
    assert.deepEqual(report.possibleReferences, [
      { file: 'src/api/routes.ts', line: 1, specifier: '../barrel', importedAs: 'payments.refund', typeOnly: false, via: ['src/barrel.ts', 'src/payments/index.ts'] },
    ]);
    assert.equal(report.count, 1);
  });

  test('a default export is found under the name default', async () => {
    const context = await repository();
    const report = await context.findReferences('src/config.ts#default');
    assert.equal(report.status, 'found');
    assert.deepEqual(
      report.references.map((entry) => [entry.file, entry.line, entry.importedAs]),
      [['src/api/server.ts', 3, 'config']],
    );
  });

  test('a symbol that nothing imports says so, and does not claim it is unused', async () => {
    const context = await repository();
    const report = await context.findReferences('src/payments/pay.ts#legacy');
    assert.equal(report.count, 0);
    assert.equal(report.externallyReachable, false);
    assert.ok(report.caveats.some((caveat) => caveat.includes('No analyzed file imports it')));
  });

  test('a symbol that is declared but not exported cannot have references', async () => {
    const context = await repository();
    const report = await context.findReferences('src/orders/order.ts#validate');
    assert.equal(report.status, 'found');
    assert.equal(report.target?.exported, false);
    assert.equal(report.count, 0);
    assert.ok(report.caveats[0]?.includes('not exported'));
  });

  test('a name several files export is reported as ambiguous, with the files to choose from', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    for (const file of ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
      deleteRepoFile(root, file);
    }
    writeRepoFile(root, 'src/one.ts', 'export const same = 1;\n');
    writeRepoFile(root, 'src/two.ts', 'export const same = 2;\n');
    const context = await AgentContext.load({ root });
    const report = await context.findReferences('same');
    assert.equal(report.status, 'ambiguous');
    assert.equal(report.target, null);
    assert.deepEqual(report.candidates.map((candidate) => candidate.file), ['src/one.ts', 'src/two.ts']);
    // Naming the file settles it; so does the `file` option.
    assert.equal((await context.findReferences('src/two.ts#same')).target?.file, 'src/two.ts');
    assert.equal((await context.findReferences('same', { file: 'src/one' })).target?.file, 'src/one.ts');
  });

  test('a name nothing exports is not found', async () => {
    const context = await repository();
    const report = await context.findReferences('noSuchSymbol');
    assert.equal(report.status, 'not-found');
    assert.equal(report.count, 0);
    assert.equal((await context.findReferences('src/payments/pay.ts#nope')).status, 'not-found');
  });
});

describe('unused exports', () => {
  const unusedNames = async (context: AgentContext): Promise<string[]> =>
    (await context.findUnusedExports()).unused.map((entry) => `${entry.file}#${entry.name}`);

  test('reports the named exports that no analyzed file imports and no entry point reaches', async () => {
    const context = await repository();
    const report = await context.findUnusedExports();
    assert.deepEqual(
      report.unused.map((entry) => `${entry.file}#${entry.name}`),
      [
        'src/api/routes.ts#handler',
        'src/config.ts#named',
        'src/legacy/old.ts#abandoned',
        'src/payments/pay.ts#legacy',
        'src/util.ts#unusedHelper',
      ],
    );
    assert.deepEqual(report.counts, { exported: 11, referenced: 4, publicApi: 0, unassessable: 2, unused: 5 });
    assert.equal(report.truncated, false);
  });

  test('each finding cites where the symbol is exported and that nothing imports it', async () => {
    const context = await repository();
    const finding = (await context.findUnusedExports()).unused.find((entry) => entry.name === 'legacy');
    assert.ok(finding);
    assert.equal(finding.line, 5);
    assert.equal(finding.confidence, 0.85, 'every file could be followed, so "nothing imports it" is well supported');
    assert.deepEqual(
      finding.evidence.map((entry) => entry.detail),
      ['exported at line 5', 'imported by 0 analyzed files'],
    );
  });

  test('names the barrels that re-export an unused symbol', async () => {
    const context = await repository();
    const finding = (await context.findUnusedExports()).unused.find((entry) => entry.name === 'abandoned');
    assert.deepEqual(finding?.reexportedBy, ['src/legacy/index.ts']);
  });

  test('does not report what a namespace or a CommonJS import may use', async () => {
    const context = await repository();
    const names = await unusedNames(context);
    assert.equal(names.includes('src/payments/refund.ts#refund'), false, 'reached through `import * as payments`');
    assert.equal(names.includes('src/helpers.ts#help'), false, "the file is loaded with require('./helpers')");
    assert.equal((await context.findUnusedExports()).counts.unassessable, 2);
  });

  test('does not assess default exports or test files', async () => {
    const context = await repository();
    const names = await unusedNames(context);
    assert.equal(names.includes('src/config.ts#default'), false, 'a default export is how a config is loaded');
    assert.equal(names.includes('src/config.ts#named'), true, 'a named export next to it is assessed like any other');
    assert.equal(names.some((name) => name.startsWith('test/')), false);
  });

  test('an export reachable from an entry point is public API, not unused', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    for (const file of ['README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json']) {
      deleteRepoFile(root, file);
    }
    writeRepoFile(root, 'package.json', JSON.stringify({ name: 'lib', main: './src/public.ts' }));
    writeRepoFile(root, 'src/public.ts', "export { api } from './internal/api';\n");
    writeRepoFile(root, 'src/internal/api.ts', 'export function api() {}\n');
    const context = await AgentContext.load({ root });
    const report = await context.findUnusedExports();
    assert.deepEqual(report.unused, []);
    assert.equal(report.counts.publicApi, 1);
    // And the same fact from the other side: the reference report says a
    // consumer outside the analyzed tree may import it.
    const references = await context.findReferences('src/internal/api.ts#api');
    assert.equal(references.externallyReachable, true, 'it is in the surface of the package entry file');
    assert.equal(references.reexportedBy.length, 1);
  });

  test('a lower confidence, and the reason, when a file of an unsupported language may import anything', async () => {
    const context = await repository();
    const root = context.root;
    writeRepoFile(root, 'src/Widget.svelte', "<script>\nimport { abandoned } from './legacy';\n</script>\n");
    const refreshed = await AgentContext.load({ root });
    const report = await refreshed.findUnusedExports();
    assert.equal(report.unused.find((entry) => entry.name === 'abandoned')?.confidence, 0.6);
    assert.ok(report.caveats.some((caveat) => caveat.includes('.svelte') && caveat.includes('were not parsed')));
  });

  test('the list is bounded, and says when it is', async () => {
    const context = await repository();
    const report = await context.findUnusedExports({ limit: 2 });
    assert.equal(report.unused.length, 2);
    assert.equal(report.truncated, true);
    assert.equal(report.counts.unused, 5);
  });
});
