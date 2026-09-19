/**
 * Tests for the repository scanner and sensitive-file filtering.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { classifyFile, AgentContext, CONTEXT_FILES } from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('scanner', () => {
  describe('classifyFile', () => {
    test('classifies source files', () => {
      assert.equal(classifyFile('src/index.ts'), 'source');
      assert.equal(classifyFile('lib/app.js'), 'source');
      assert.equal(classifyFile('src/component.tsx'), 'source');
    });

    test('classifies tests by path and naming convention', () => {
      assert.equal(classifyFile('test/index.test.ts'), 'test');
      assert.equal(classifyFile('src/payment-service.spec.ts'), 'test');
      assert.equal(classifyFile('tests/helpers.ts'), 'test');
      assert.equal(classifyFile('src/__tests__/a.ts'), 'test');
    });

    test('classifies docs, config and assets', () => {
      assert.equal(classifyFile('README.md'), 'docs');
      assert.equal(classifyFile('docs/adr/001-postgresql.md'), 'docs');
      assert.equal(classifyFile('tsconfig.json'), 'config');
      assert.equal(classifyFile('pnpm-workspace.yaml'), 'config');
      assert.equal(classifyFile('assets/logo.svg'), 'asset');
    });

    test('normalizes windows separators', () => {
      assert.equal(classifyFile('src\\utils\\format.ts'), 'source');
      assert.equal(classifyFile('test\\a.test.ts'), 'test');
    });
  });

  test('scans a fixture and reports counts', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.equal(report.changes.incremental, false);
    assert.ok(report.files.total > 0);
    assert.ok(report.modules > 0);
    assert.ok(report.externalDependencies > 0);
    assert.equal(report.warnings.filter((w) => w.severity === 'error').length, 0);
  });

  test('never includes sensitive files in the context', async () => {
    const root = createTempRepo('simple-ts', { git: true });
    tempRoots.push(root);
    writeRepoFile(root, 'src/.env', 'API_KEY=super-secret-value\n');
    writeRepoFile(root, 'src/secrets.json', '{ "token": "hunter2" }\n');

    const context = await AgentContext.load({ root });
    await context.scan();
    const files = await context.getFiles();
    const envFile = files.find((file) => file.path === 'src/.env');
    assert.ok(envFile, 'sensitive file should be visible as skipped, not analysed');
    assert.equal(envFile.sensitive, true);
    assert.equal(envFile.hash, '');
    assert.equal(envFile.signals.includes('skipped:sensitive'), true);
    assert.equal(files.some((file) => file.path === 'src/secrets.json' && file.sensitive === false), false);

    // No secret value may leak anywhere in the generated context.
    for (const name of CONTEXT_FILES) {
      const content = await import('node:fs/promises').then((fs) =>
        fs.readFile(`${root}/.agent/${name}`, 'utf8'),
      );
      assert.equal(content.includes('super-secret-value'), false, `secret leaked into ${name}`);
    }
  });

  test('warns but continues on unreadable files', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, 'src/broken.json', '{ not valid json at all');
    const context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.files.total > 0);
    assert.ok(report.warnings.length >= 0);
  });
});
