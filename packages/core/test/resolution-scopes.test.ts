/**
 * Two ways an import fails to resolve to what it names.
 *
 * Both were invisible until 1.1.0 made `require()` calls visible, and both were
 * found by the compiler oracle on `express` and on `clsx` the moment it did.
 *
 * `require('../..')` — the repository root, the way an example or a test loads
 * the package it sits in. The base of the path is empty, and the index file was
 * looked for as `/index.js`, with a leading slash no repository-relative path
 * has. 58 imports of `express` did not resolve.
 *
 * A package that *declares* a neighbouring package as a dependency with a
 * registry range depends on the published package, not on the one next door.
 * `clsx` keeps `bench/` pinned to `clsx@1.1.0` from the registry, on purpose,
 * to compare against the released build; the analyzer drew an edge to the
 * source package in the same tree.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const FIXTURE_FILES = ['package.json', 'README.md', 'src/index.ts', 'src/models/user.ts', 'src/utils/format-user-name.ts', 'test/index.test.ts', 'tsconfig.json'];

function repository(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  for (const file of FIXTURE_FILES) deleteRepoFile(root, file);
  return root;
}

describe('an import of the repository root', () => {
  test("require('../..') resolves to the index file of the root", async () => {
    const root = repository();
    writeRepoFile(root, 'index.js', 'module.exports = () => 1;\n');
    writeRepoFile(root, 'examples/auth/index.js', "const express = require('../..');\nmodule.exports = express;\n");
    const context = await AgentContext.load({ root });
    const report = await context.detect();
    assert.equal(report.imports.unresolved, 0, JSON.stringify(report.issues, null, 2));
    assert.equal(report.imports.resolved, 1);
  });

  test("require('.') from a file at the root resolves to the same index file", async () => {
    const root = repository();
    writeRepoFile(root, 'index.js', 'module.exports = () => 1;\n');
    writeRepoFile(root, 'other.js', "const self = require('.');\nmodule.exports = self;\n");
    const report = await (await AgentContext.load({ root })).detect();
    assert.equal(report.imports.unresolved, 0);
  });

  test("an ES import of the root resolves as well", async () => {
    const root = repository();
    writeRepoFile(root, 'src/index.ts', 'export const root = 1;\n');
    writeRepoFile(root, 'src/deep/nested/consumer.ts', "import { root } from '../..';\nexport const value = root;\n");
    const report = await (await AgentContext.load({ root })).detect();
    assert.equal(report.imports.unresolved, 0);
  });

  test("a root with no index file is still reported as unresolved", async () => {
    const root = repository();
    writeRepoFile(root, 'examples/auth/index.js', "const express = require('../..');\nmodule.exports = express;\n");
    const report = await (await AgentContext.load({ root })).detect();
    assert.equal(report.imports.unresolved, 1);
  });
});

describe('a neighbouring package that is declared as a dependency', () => {
  // The rule is the one the compiler oracle applies, written here so that the
  // two implementations can be seen to agree: a member of a workspace is
  // depended on through the workspace, whatever range a neighbour declares;
  // the range decides for a package that stands alone.
  function standalone(): string {
    const root = repository();
    writeRepoFile(root, 'package.json', JSON.stringify({ name: '@ac/lib', main: 'index.js' }));
    writeRepoFile(root, 'index.js', 'module.exports.lib = () => 1;\n');
    writeRepoFile(root, 'bench/package.json', JSON.stringify({ name: 'bench', dependencies: { '@ac/lib': '1.0.0' } }));
    writeRepoFile(root, 'bench/run.js', "const lib = require('@ac/lib');\nmodule.exports = lib;\n");
    return root;
  }

  test('declared with a registry range, it is a dependency on the published package', async () => {
    const root = standalone();
    const context = await AgentContext.load({ root });
    const repository = await context.getRepository();
    const external = repository.externalDependencies.find((entry) => entry.name === '@ac/lib');
    assert.ok(external, 'the import is an external dependency');
    assert.equal(
      repository.dependencies.some((edge) => edge.from === 'bench' && edge.to === '@ac/lib'),
      false,
      'there is no edge from bench to the source package next to it',
    );
  });

  test('declared with the workspace protocol, it is the neighbouring package', async () => {
    const root = standalone();
    writeRepoFile(root, 'bench/package.json', JSON.stringify({ name: 'bench', dependencies: { '@ac/lib': 'workspace:^' } }));
    const context = await AgentContext.load({ root });
    const repository = await context.getRepository();
    assert.equal(
      repository.externalDependencies.some((entry) => entry.name === '@ac/lib'),
      false,
      'workspace:^ names the package in this tree, not the one on the registry',
    );
  });

  test('a member of a workspace is the neighbouring package, whatever a neighbour declares', async () => {
    const root = repository();
    writeRepoFile(root, 'package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'bench'] }));
    writeRepoFile(root, 'packages/lib/package.json', JSON.stringify({ name: '@ac/lib', main: 'index.js' }));
    writeRepoFile(root, 'packages/lib/index.js', 'module.exports.lib = () => 1;\n');
    writeRepoFile(root, 'bench/package.json', JSON.stringify({ name: 'bench', dependencies: { '@ac/lib': '1.0.0' } }));
    writeRepoFile(root, 'bench/run.js', "const lib = require('@ac/lib');\nmodule.exports = lib;\n");
    const graph = await (await AgentContext.load({ root })).getRepository();
    assert.ok(graph.dependencies.some((edge) => edge.from === 'bench' && edge.to === '@ac/lib'), 'a workspace member is the package next door');
    assert.equal(graph.externalDependencies.some((entry) => entry.name === '@ac/lib'), false);
  });
});
