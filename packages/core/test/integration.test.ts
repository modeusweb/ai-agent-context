/**
 * Full lifecycle integration tests over the committed fixtures:
 * init → scan → status → explain → search → diff → clean.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  AgentContext,
  CONTEXT_FILES,
  AGENT_DIR,
  CONFIG_FILE,
  removeContextDirectory,
} from '../dist/index.js';
import { cleanupTemp, createTempRepo, readRepoFile, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('lifecycle: init / scan / status / explain / search / diff / clean (simple-ts)', () => {
  test('init is idempotent and respects --force', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });

    const first = await context.init();
    assert.equal(first.alreadyExisted, false);
    assert.ok(existsSync(path.join(root, CONFIG_FILE)));

    const second = await context.init();
    assert.equal(second.alreadyExisted, true);
    assert.equal(second.overwritten, false);
    const configBefore = readFileSync(path.join(root, CONFIG_FILE), 'utf8');
    writeRepoFile(root, CONFIG_FILE, configBefore.replace('"prettyJson": true', '"prettyJson": false'));

    const forced = await context.init({ force: true });
    assert.equal(forced.overwritten, true);
    assert.equal(readFileSync(path.join(root, CONFIG_FILE), 'utf8').includes('"prettyJson": false'), false);
  });

  test('scan generates every documented context file', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.init();
    await context.scan();
    for (const name of [...CONTEXT_FILES, '.gitignore', '.local']) {
      assert.equal(existsSync(path.join(root, AGENT_DIR, name)), true, `${name} must exist`);
    }
    assert.equal(existsSync(path.join(root, AGENT_DIR, 'cache')), false, 'no cache dir may be versioned');
  });

  test('status reports up to date after scan', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const status = await context.status();
    assert.equal(status.status, 'up-to-date');
    assert.equal(status.changes.modified.length + status.changes.added.length + status.changes.deleted.length, 0);
  });

  test('explain produces a useful module context', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const modules = await context.getModules();
    assert.ok(modules.length > 0);
    const explanation = await context.explain('src/models');
    assert.ok(explanation, 'explain must resolve a module directory');
    assert.ok(explanation.summary.length > 0);
    assert.ok(explanation.relatedFiles.length > 0);
    assert.ok(explanation.publicApi.some((entry) => entry.name === 'User'), 'public API must list exported symbols');


  });
});


describe('search / diff / clean', () => {
  test('search finds nodes by query with reasons', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const results = await context.search('format user name');
    assert.ok(results.length > 0);
    for (const result of results) {
      assert.ok(
        ['file', 'module', 'symbol', 'decision', 'convention', 'entry-point', 'dependency'].includes(result.type),
      );
      assert.ok(result.id.length > 0);
      assert.ok(result.reason.length > 0);
      assert.ok(result.score >= 0);
    }
    const missing = await context.search('qqqqzzzz0000-unmatched-tokens');
    assert.equal(missing.length, 0);

  });

  test('diff shows repository context changes after an edit', async () => {
    const root = createTempRepo('simple-ts', { git: true });
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    assert.equal((await context.diff()).hasChanges, false);

    writeRepoFile(root, 'src/checkout.ts', 'import { greet } from "./index.ts";\nexport const checkout = greet;\n');
    const diff = await (await AgentContext.load({ root })).diff();
    assert.equal(diff.hasChanges, true);
    assert.ok(diff.files.added.includes('src/checkout.ts'));

    await (await AgentContext.load({ root })).scan();
    const afterRescan = await (await AgentContext.load({ root })).diff();
    assert.equal(afterRescan.hasChanges, false);
  });

  test('diff detects removed files', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const files = await context.getFiles();
    const victim = files.find((file) => file.kind === 'source' && file.path.includes('models')) ?? files[0];
    assert.ok(victim);
    rmSync(path.join(root, victim.path));
    const diff = await (await AgentContext.load({ root })).diff();
    assert.ok(diff.files.removed.includes(victim.path));
  });

  test('clean removes generated data and keeps the config when asked', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.init();
    await context.scan();
    const removed = await removeContextDirectory(root, { keepConfig: true });

    assert.ok(removed.includes('index.json'));
    assert.equal(removed.includes('config.json'), false);
    assert.equal(existsSync(path.join(root, CONFIG_FILE)), true);
    assert.equal(existsSync(path.join(root, AGENT_DIR, 'index.json')), false);
    assert.equal(existsSync(path.join(root, 'src/index.ts')), true, 'source code is never removed');
  });
});

describe('git integration', () => {
  test('git signals are attached to modules when history exists', async () => {
    const root = createTempRepo('simple-ts', { git: true });
    tempRoots.push(root);
    writeRepoFile(root, 'src/models/user.ts', `${readRepoFile(root, 'src/models/user.ts').trimEnd()}\n// v2\n`);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'refactor: touch model'], { cwd: root });

    const context = await AgentContext.load({ root });
    await context.scan();
    const modules = await context.getModules();
    const withGit = modules.filter((module) => module.git !== null);
    assert.ok(withGit.length > 0, 'git activity must be attached when history exists');
    for (const module of withGit) {
      assert.ok(module.git !== null && module.git.historicalChanges >= 1);
      assert.ok(['none', 'low', 'medium', 'high'].includes(module.git.changeFrequency));
    }
  });

  test('scan still works outside a git repository', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.files.total > 0);
    const status = await context.status();
    assert.equal(status.git.available, false);
  });
});

describe('other fixtures', () => {
  test('api-project detects entry points', async () => {
    const root = createTempRepo('api-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.entryPoints > 0);
    const repository = await context.getRepository();
    const types = new Set(repository.entryPoints.map((entry) => entry.type));
    assert.ok(
      [...types].some((type) => ['application', 'http-routes', 'package-main'].includes(type)),
      `unexpected entry point types: ${[...types].join(', ')}`,
    );
  });

  test('cli-project works end to end', async () => {
    const root = createTempRepo('cli-project');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const status = await context.status();
    assert.equal(status.status, 'up-to-date');
    assert.ok(status.counts.modules > 0);
    assert.ok(status.counts.entryPoints > 0);
  });
});
