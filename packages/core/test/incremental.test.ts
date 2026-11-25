/**
 * Incremental scanning: only changed files are reparsed, and the local state
 * classifies added/modified/deleted/unchanged correctly.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  AgentContext,
  createDefaultRegistry,
  createParsedFile,
  LanguageRegistry,
  STATE_FILE,
  TOOL_VERSION,
  type LanguageAdapter,
} from '../dist/index.js';
import { cleanupTemp, createTempRepo, deleteRepoFile, readRepoFile, writeRepoFile } from './helpers.ts';


/** Rewrites parse-cache entries; the callback returns whether it changed the entry. */
function rewriteCache(root: string, rewrite: (entry: Record<string, unknown>) => boolean): number {
  const directory = path.join(root, '.agent', '.local', 'cache');
  let rewritten = 0;
  for (const shard of readdirSync(directory)) {
    for (const name of readdirSync(path.join(directory, shard))) {
      const entryPath = path.join(directory, shard, name);
      const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
      if (!rewrite(entry)) continue;
      writeFileSync(entryPath, JSON.stringify(entry));
      rewritten += 1;
    }
  }
  return rewritten;
}

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** Each fresh() call is a full new AgentContext, as the CLI would create one. */
async function fresh(root: string): Promise<ReturnType<AgentContext['scan']> extends Promise<infer T> ? T : never> {
  const context = await AgentContext.load({ root });
  return context.scan();
}

describe('incremental scanning (simple-ts)', () => {
  test('second scan reuses the cache and reports everything unchanged', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const cold = await fresh(root);
    assert.equal(cold.changes.incremental, false);
    assert.ok(cold.files.total > 0);

    const warm = await fresh(root);
    assert.equal(warm.changes.incremental, true);
    assert.equal(warm.changes.modified.length, 0);
    assert.equal(warm.changes.added.length, 0);
    assert.equal(warm.changes.deleted.length, 0);
    assert.equal(warm.reused, warm.files.total, 'every file must come from the cache');
    assert.equal(warm.parsed, 0);
  });

  test('modifying one file reparses only that file', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);

    const modifiedPath = 'src/utils/format-user-name.ts';
    writeRepoFile(root, modifiedPath, `${readRepoFile(root, modifiedPath).trimEnd()}\n// touched\n`);
    const report = await fresh(root);
    assert.equal(report.changes.incremental, true);
    assert.deepEqual(report.changes.modified, [modifiedPath]);
    assert.equal(report.parsed, 1, 'exactly the changed file must be reparsed');
    assert.ok(report.affected.files.includes(modifiedPath));
    assert.ok(report.affected.modules.length > 0);
    assert.equal(report.reused, report.files.total - 1);
  });

  test('adding and deleting files updates the change set', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);

    writeRepoFile(root, 'src/extra/refund-service.ts', 'export class RefundService {}\n');
    const addedReport = await fresh(root);
    assert.deepEqual(addedReport.changes.added, ['src/extra/refund-service.ts']);
    assert.ok(addedReport.affected.files.includes('src/extra/refund-service.ts'));

    await fresh(root);
    deleteRepoFile(root, 'src/extra/refund-service.ts');
    const removedReport = await fresh(root);

    assert.deepEqual(removedReport.changes.deleted, ['src/extra/refund-service.ts']);
    assert.equal(removedReport.changes.added.length, 0);
  });

  test('status flips from up-to-date to stale after an edit', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    assert.equal((await context.status()).status, 'up-to-date');

    const modifiedPath = 'src/models/user.ts';
    writeRepoFile(root, modifiedPath, `${readRepoFile(root, modifiedPath).trimEnd()}\n// touch\n`);
    const staleContext = await AgentContext.load({ root });
    const status = await staleContext.status();
    assert.equal(status.status, 'stale');
    assert.deepEqual(status.changes.modified, [modifiedPath]);
  });


  test('a tool version change invalidates the incremental cache', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);

    const statePath = path.join(root, STATE_FILE);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { toolVersion: string };
    assert.equal(state.toolVersion, TOOL_VERSION, 'the tool version must be persisted');
    state.toolVersion = '0.0.0';
    writeFileSync(statePath, JSON.stringify(state));
    // An upgrade changes the release that wrote the cache entries too. Changing
    // only the state was the whole simulation until 1.1.0: the flag `incremental`
    // flipped, the assertion on the flag passed, and every parse result of the
    // previous release was still reused.
    assert.equal(
      rewriteCache(root, (entry) => {
        entry.toolVersion = '0.0.0';
        return true;
      }) > 0,
      true,
    );

    const report = await fresh(root);
    assert.equal(report.changes.incremental, false, 'an upgrade must force a full rescan');
    assert.equal(report.reused, 0, 'no parse result of another release may be reused');
    assert.equal(report.parsed, report.files.total, 'every file is parsed again');
  });
});

/** What an upgrade leaves behind: the same local state and cache, written by the previous release. */
function fileOf<T extends { path: string }>(repository: { files: T[] }, file: string): T {
  const entry = repository.files.find((candidate) => candidate.path === file);
  assert.ok(entry, `${file} must be analyzed`);
  return entry!;
}

function simulatePreviousRelease(root: string): void {
  const statePath = path.join(root, STATE_FILE);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { toolVersion: string };
  state.toolVersion = '0.0.0';
  writeFileSync(statePath, JSON.stringify(state));
  rewriteCache(root, (entry) => {
    entry.toolVersion = '0.0.0';
    return true;
  });
}

describe('what the parse cache may be keyed by', () => {
  test('a parse result written by another release is not reused', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    // What a previous release got wrong: the import after a template literal
    // was missing — the defect fixed in 0.15.0.
    const file = 'src/utils/format-user-name.ts';
    writeRepoFile(root, file, `${readRepoFile(root, file)}\nconst rows = items.map((item) => \`\${item}\`);\nimport { User } from '../models/user';\n`);
    await fresh(root);
    const importsOf = async (): Promise<string[]> =>
      (await (await AgentContext.load({ root })).getRepository()).files.find((entry) => entry.path === file)?.importSpecifiers ?? [];
    assert.ok((await importsOf()).includes('../models/user'));

    const rewritten = rewriteCache(root, (entry) => {
      const imports = (entry.file as { imports: Array<{ specifier: string }> }).imports;
      if (!imports.some((record) => record.specifier === '../models/user')) return false;
      entry.file = { ...(entry.file as object), imports: imports.filter((record) => record.specifier !== '../models/user') };
      return true;
    });
    assert.equal(rewritten, 1, 'exactly the cache entry of the file is rewritten');
    simulatePreviousRelease(root);

    const report = await fresh(root);
    assert.equal(report.parsed, report.files.total, 'an upgrade parses every file again');
    assert.ok((await importsOf()).includes('../models/user'), 'the import is back: the stale snapshot was not reused');
  });

  test('--force parses again instead of serving the cache', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await fresh(root);
    const context = await AgentContext.load({ root });
    const report = await context.scan({ force: true });
    assert.equal(report.reused, 0, 'a forced scan takes nothing from the cache');
    assert.equal(report.parsed, report.files.total);
  });

  test('the cache follows the languages configuration', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const file = 'src/models/user.ts';
    const typescript = async (): Promise<{ language: string; imports: string[] }> => {
      const context = await AgentContext.load({ root, config: { languages: ['typescript'] } });
      await context.scan();
      const entry = fileOf(await context.getRepository(), file);
      return { language: entry.language, imports: entry.importSpecifiers };
    };
    assert.equal((await typescript()).language, 'typescript');

    const context = await AgentContext.load({ root, config: { languages: ['json'] } });
    await context.scan();
    const entry = fileOf(await context.getRepository(), file);
    assert.equal(entry.language, 'unknown', 'typescript is not an enabled language, so the file is not parsed');
    assert.deepEqual(entry.importSpecifiers, []);

    assert.equal((await typescript()).language, 'typescript', 'and the first configuration still gets its own parse');
  });

  test('a custom adapter is not served the default adapter\'s parse result', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    await (await AgentContext.load({ root })).scan();

    const custom: LanguageAdapter = {
      id: 'custom-ts',
      displayName: 'Custom TypeScript adapter',
      languageIds: ['typescript'],
      alwaysEnabled: true,
      handles: (descriptor) => descriptor.extension === '.ts',
      parse: (input) => createParsedFile(input.path, 'custom', { signals: ['custom:adapter'] }),
    };
    const registry = new LanguageRegistry([custom, ...createDefaultRegistry().list()]);
    const context = await AgentContext.load({ root, registry });
    await context.scan();
    const entry = fileOf(await context.getRepository(), 'src/models/user.ts');
    assert.ok(entry.signals.includes('custom:adapter'), 'the registered adapter must parse the file, not the one it replaces');
  });
});
