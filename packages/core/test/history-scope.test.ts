/**
 * `history` answers for the target that was asked about.
 *
 * The history used to be read as "the most recent N commits of the repository,
 * keep those that touch the target". For a target that is not under constant
 * change that is close to "nothing": in a repository with more than N commits
 * since the target was last edited, its history came back empty while `git log
 * -- <target>` listed every commit. These tests build exactly that repository.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** More than any default limit (20 for the CLI, 50 for the API). */
const BUSY_COMMITS = 55;
let clock = Date.now() - 400 * 86_400_000;

/** One commit at a fixed, increasing date, so the order is not the file system's. */
function commit(root: string, message: string): void {
  clock += 86_400_000;
  const date = new Date(clock).toISOString();
  execFileSync('git', ['commit', '-q', '-a', '-m', message, '--date', date], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

/**
 * `src/legacy` changes in the first three commits; `src/busy` in the next
 * fifty-five. Built once: the tests only read it.
 */
function busyRepository(): string {
  const root = createTempRepo('simple-ts', { git: true });
  tempRoots.push(root);
  writeRepoFile(root, 'src/legacy/keep.ts', 'export const keep = 1;\n');
  writeRepoFile(root, 'src/legacy/old.ts', 'export const old = 0;\n');
  writeRepoFile(root, 'src/busy/work.ts', 'export const work = 0;\n');
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  for (let index = 1; index <= 3; index += 1) {
    writeRepoFile(root, 'src/legacy/old.ts', `export const old = ${index};\n`);
    commit(root, `refactor: legacy change ${index}`);
  }
  for (let index = 1; index <= BUSY_COMMITS; index += 1) {
    writeRepoFile(root, 'src/busy/work.ts', `export const work = ${index};\n`);
    commit(root, `chore: busy change ${index}`);
  }
  return root;
}

let shared: string | null = null;
const repository = (): string => (shared ??= busyRepository());

describe('history is scoped to the target', () => {
  test('a directory that stopped changing is not hidden by later commits elsewhere', async () => {
    const root = repository();
    const context = await AgentContext.load({ root });
    const history = await context.getModuleHistory('src/legacy', { limit: 50 });
    assert.deepEqual(
      history.map((entry) => entry.subject),
      ['refactor: legacy change 3', 'refactor: legacy change 2', 'refactor: legacy change 1'],
      'three commits, not the last fifty of the repository filtered down to none',
    );
  });

  test('the limit counts commits of the target, not of the repository', async () => {
    const root = repository();
    const context = await AgentContext.load({ root });
    const history = await context.getModuleHistory('src/legacy', { limit: 2 });
    assert.deepEqual(
      history.map((entry) => entry.subject),
      ['refactor: legacy change 3', 'refactor: legacy change 2'],
      'two commits of src/legacy, not the last two commits of the repository',
    );
  });

  test('a file target lists only the commits that touched that file', async () => {
    const root = repository();
    const context = await AgentContext.load({ root });
    // `keep.ts` was created by the first commit that also changed `old.ts`, and
    // has not been touched since: one commit, out of fifty-eight.
    const history = await context.getModuleHistory('src/legacy/keep.ts', { limit: 20 });
    assert.deepEqual(
      history.map((entry) => entry.subject),
      ['refactor: legacy change 1'],
    );
    assert.deepEqual(history[0]?.files, ['src/legacy/keep.ts'], 'only the asked-for file is listed');
  });

  test('each entry lists the files of the target that the commit touched', async () => {
    const root = repository();
    const context = await AgentContext.load({ root });
    const history = await context.getModuleHistory('src/legacy', { limit: 50 });
    assert.deepEqual(history[0]?.files, ['src/legacy/old.ts'], 'the second and third changes touch old.ts only');
    assert.deepEqual(history[1]?.files, ['src/legacy/old.ts']);
    assert.deepEqual(history[2]?.files, ['src/legacy/keep.ts', 'src/legacy/old.ts'], 'the first also created keep.ts');
  });

  test('an architecture signal follows the configured patterns', async () => {
    const root = repository();
    const context = await AgentContext.load({ root });
    const legacy = await context.getModuleHistory('src/legacy', { limit: 50 });
    assert.ok(legacy.every((entry) => entry.architectureSignal), 'every commit says "refactor"');
    const busy = await context.getModuleHistory('src/busy', { limit: 5 });
    assert.ok(busy.every((entry) => !entry.architectureSignal), 'a "chore" commit is not an architecture signal');
  });

  test('a commit touching a file beyond the first twenty-five of a module is not dropped', async () => {
    const root = createTempRepo('simple-ts', { git: true });
    tempRoots.push(root);
    for (let index = 0; index < 40; index += 1) {
      writeRepoFile(root, `src/wide/file-${String(index).padStart(2, '0')}.ts`, `export const v${index} = ${index};\n`);
    }
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    commit(root, 'chore: forty files');
    writeRepoFile(root, 'src/wide/file-39.ts', 'export const v39 = 390;\n');
    commit(root, 'feat: last file edited');
    const context = await AgentContext.load({ root });
    const history = await context.getModuleHistory('src/wide/file-39.ts', { limit: 20 });
    assert.ok(
      history.some((entry) => entry.subject === 'feat: last file edited'),
      'the history of a file is not bounded by the explanation file list',
    );
  });
});
