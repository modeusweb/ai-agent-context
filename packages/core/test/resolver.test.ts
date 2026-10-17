/**
 * Path normalization and import resolution.
 *
 * These are load-bearing for the whole product: the dependency graph, impact
 * analysis, layering diagnostics and `get_dependents` are all derived from
 * resolved imports. A regression here silently empties every one of them, so
 * the cases below assert on resolution outcomes rather than on shapes.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  AgentContext,
  ImportResolver,
  escapesRoot,
  normalizeRelative,
} from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('path normalization', () => {
  test('collapses "." and duplicate separators', () => {
    assert.equal(normalizeRelative('./a//b/./c.ts'), 'a/b/c.ts');
    assert.equal(normalizeRelative('a/b/c.ts'), 'a/b/c.ts');
  });

  test('collapses ".." segments', () => {
    assert.equal(normalizeRelative('a/b/../c.ts'), 'a/c.ts');
    assert.equal(normalizeRelative('a/b/c/../../d/e.ts'), 'a/d/e.ts');
    assert.equal(normalizeRelative('packages/core/src/core/graph/../context/explain.ts'), 'packages/core/src/core/context/explain.ts');
  });

  test('does not let ".." escape the repository root', () => {
    // The climbing segment is dropped, and the escape is reported rather than
    // silently clamped onto a plausible in-repo path.
    assert.equal(normalizeRelative('a/../../../etc/passwd'), 'etc/passwd');
    assert.equal(escapesRoot('a/../../../etc/passwd'), true);
    assert.equal(escapesRoot('a/b/../c.ts'), false);
  });

  test('reports absolute paths as escaping', () => {
    assert.equal(escapesRoot('/etc/passwd'), true);
    assert.equal(escapesRoot('C:/Windows/system32'), true);
    assert.equal(escapesRoot('src/app.ts'), false);
  });
});

describe('import resolution', () => {
  const files = new Set([
    'packages/core/src/index.ts',
    'packages/core/src/core/graph/modules.ts',
    'packages/core/src/core/context/explain.ts',
    'packages/core/src/util/paths.ts',
    'packages/core/src/adapters/index.ts',
    'packages/core/src/adapters/fs-adapter.ts',
    'fixtures/api-project/src/server.ts',
    'fixtures/api-project/src/services/payment-service.ts',
  ]);

  const resolve = (specifier: string, from: string) =>
    new ImportResolver({ filePaths: files, aliases: [], workspacePackages: new Map() }).resolve(specifier, from);

  test('resolves same-directory relative imports', () => {
    const result = resolve('./modules.ts', 'packages/core/src/core/graph/knowledge-graph.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/core/graph/modules.ts');
  });

  test('resolves imports that climb one directory with ".."', () => {
    // from .../src/core/graph  ->  .../src/core/context
    const result = resolve('../context/explain.ts', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/core/context/explain.ts');
  });

  test('resolves imports that climb two directories with "../.."', () => {
    // from .../src/core/graph  ->  .../src/util
    const result = resolve('../../util/paths.ts', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/util/paths.ts');
  });

  test('resolves ".." imports that descend again ("../x/../y")', () => {
    const result = resolve('../context/../graph/modules.ts', 'packages/core/src/core/context/explain.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/core/graph/modules.ts');
  });

  test('resolves index files behind ".."', () => {
    const result = resolve('../../adapters', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/adapters/index.ts');
  });

  test('resolves extensionless imports that climb', () => {
    const result = resolve('../../util/paths', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/util/paths.ts');
  });

  test('applies the TypeScript ESM ".js" -> ".ts" rewrite after ".."', () => {
    const result = resolve('../../util/paths.js', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'packages/core/src/util/paths.ts');
  });

  test('resolves ".." imports across fixtures', () => {
    const result = resolve('../services/payment-service.ts', 'fixtures/api-project/src/routes/payment-routes.ts');
    assert.equal(result.kind, 'internal-file');
    assert.equal(result.target, 'fixtures/api-project/src/services/payment-service.ts');
  });

  test('rejects relative specifiers that escape the repository root', () => {
    // The importing file sits 5 directories deep, so a 6-level climb is out.
    const result = resolve('../../../../../../etc/passwd', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'unresolved');
    assert.match(result.attempts[0] ?? '', /outside the repository root/);
  });

  test('a climb that stays inside the root is not treated as an escape', () => {
    const result = resolve('../../../../etc/passwd', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'unresolved');
    assert.doesNotMatch(result.attempts[0] ?? '', /outside the repository root/);
  });

  test('rejects absolute specifiers as escapes', () => {
    const result = resolve('/etc/passwd', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'unresolved');
    assert.match(result.attempts[0] ?? '', /outside the repository root/);
  });

  test('an extensionless traversal is still recognised as an escape', () => {
    // The graph used to classify unresolved imports by taking lastIndexOf('.')
    // of the whole specifier, which points at the leading ".." — so a
    // traversal into an extensionless path was filtered out as a non-code
    // asset and vanished from the report entirely.
    const shallow = resolve('../../../etc/passwd', 'src/index.ts');
    assert.equal(shallow.kind, 'unresolved');
    assert.match(shallow.attempts[0] ?? '', /outside the repository root/);

    const withExtension = resolve('../../../etc/shadow.ts', 'src/index.ts');
    assert.equal(withExtension.kind, 'unresolved');
    assert.match(withExtension.attempts[0] ?? '', /outside the repository root/);
  });

  test('a rejected traversal reaches the persisted dependency document', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, 'src/index.ts', "import { x } from '../../../etc/passwd';\nexport const used = x;\n");

    const context = await AgentContext.load({ root });
    await context.scan();
    const dependencies = await context.getDependencies();
    const escape = dependencies.unresolved.find((entry) =>
      (entry.attempts[0] ?? '').includes('outside the repository root'),
    );
    assert.ok(
      escape,
      `a rejected traversal must be reported, got ${JSON.stringify(dependencies.unresolved)}`,
    );
  });

  test('reports genuinely missing targets as unresolved, not as escapes', () => {
    const result = resolve('../does/not/exist.ts', 'packages/core/src/core/graph/modules.ts');
    assert.equal(result.kind, 'unresolved');
    assert.doesNotMatch(result.attempts[0] ?? '', /outside the repository root/);
  });
});

describe('resolved imports drive the dependency graph', () => {
  test('a ".." import produces a module dependency edge', async () => {
    const root = createTempRepo('layered-app');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const modules = await context.getModules();
    const application = modules.find((module) => module.path.endsWith('src/application'));
    assert.ok(application, 'the fixture must expose an application module');
    assert.ok(
      application.dependsOn.length > 0,
      'application must depend on other modules through imports that climb directories',
    );
  });

  test('unresolved imports are a small minority on a real fixture', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const dependencies = await context.getDependencies();
    const total = dependencies.unresolved.length + dependencies.internal.length;
    assert.ok(total > 0);
    const ratio = dependencies.unresolved.length / total;
    assert.ok(ratio < 0.25, `unresolved share ${ratio.toFixed(2)} is too high to be a healthy graph`);
  });
});