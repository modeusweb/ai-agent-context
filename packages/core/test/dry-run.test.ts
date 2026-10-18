/**
 * The dry-run contract: a query must not write to the repository.
 *
 * `scan-pipeline.ts` documents that nothing writes to `.agent/` when `dryRun` is
 * set, "which is how `status` and `diff` stay side-effect free". That contract
 * was broken: the parse cache was written regardless of the flag, so every
 * read-only query created `.agent/.local/` in a repository it had only been
 * asked to read. That contradicted the documentation, and it made `--read-only`
 * incomplete — the flag refused `scan()` while `status --read-only` still
 * created files.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AgentContext } from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

function repo(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  return root;
}

/** Everything the analysis could have written, one level under the root. */
function agentContents(root: string): string[] {
  const dir = path.join(root, '.agent');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

describe('dry run does not write', () => {
  test('a query on a repository with no context creates nothing', async () => {
    for (const operation of ['getRepositoryContext', 'getRepository', 'detect', 'status'] as const) {
      const root = repo();
      const context = await AgentContext.load({ root });
      await (context[operation]() as Promise<unknown>);
      assert.deepEqual(
        agentContents(root),
        [],
        `${operation} created ${JSON.stringify(agentContents(root))} in a repository it should only have read`,
      );
    }
  });

  test('explain and search create nothing either', async () => {
    const root = repo();
    const context = await AgentContext.load({ root });
    await context.explain('src');
    await context.search('user');
    await context.getTaskContext('format user name');
    assert.deepEqual(agentContents(root), []);
  });

  test('a dry run after a scan does not grow the cache', async () => {
    const root = repo();
    await (await AgentContext.load({ root })).scan();

    const cacheDir = path.join(root, '.agent', '.local', 'cache');
    const before = readdirSync(cacheDir, { recursive: true }).length;
    assert.ok(before > 0, 'scan is expected to populate the cache');

    // A forced scan re-parses every file, which is exactly the path that used to
    // write fresh cache shards during a read-only query.
    const context = await AgentContext.load({ root });
    await context.scan({ force: true, dryRun: true });
    const after = readdirSync(cacheDir, { recursive: true }).length;
    assert.equal(after, before, 'a forced dry run re-parsed without writing new cache shards');
  });

  test('scan still populates the cache, which the incremental path depends on', async () => {
    const root = repo();
    await (await AgentContext.load({ root })).scan();
    const cacheDir = path.join(root, '.agent', '.local', 'cache');
    assert.ok(existsSync(cacheDir), 'scan must populate the parse cache');
    assert.ok(existsSync(path.join(root, '.agent', '.local', 'state.json')), 'scan must record local state');
  });

  test('a second scan still reuses the cache it wrote', async () => {
    const root = repo();
    const first = await (await AgentContext.load({ root })).scan();
    assert.ok(first.parsed > 0, 'the first scan parses');
    const second = await (await AgentContext.load({ root })).scan();
    assert.equal(second.parsed, 0, 'nothing changed, so nothing should be re-parsed');
    assert.ok(second.reused > 0, 'the second scan must serve files from the cache');
  });
});