/**
 * Which files the analysis reads: `.gitignore` files, and the patterns of the
 * configuration.
 *
 * Two defects made the analyzer read files git had been told to forget.
 *
 * Only the root `.gitignore` was read. In a monorepo — where packages
 * commonly ignore their own generated directories — everything a package had
 * asked git to forget was analyzed as source and joined the graph.
 *
 * And an anchored pattern (a leading `/`) matched nothing at all: the slash
 * survived into the regular expression, which then no path could begin with.
 * Every anchored line of every `.gitignore` was a dead rule.
 *
 * Where a case is about what git itself does, the expectation is checked
 * against git rather than against this tool's own idea of it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import path from 'node:path';
import { AgentContext, FileSystemAdapter, PatternSet, compileGlob } from '../dist/index.js';
import { cleanupTemp, createTempRepo, git, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** An empty git repository in a temporary directory. */
function emptyRepository(): string {
  const root = createTempRepo('simple-ts', { git: true });
  tempRoots.push(root);
  for (const entry of readdirSync(root)) {
    if (entry === '.git') continue;
    rmSync(path.join(root, entry), { force: true, recursive: true });
  }
  git(root, ['commit', '-q', '-am', 'chore: emptied', '--allow-empty']);
  return root;
}

/** Paths the analyzer reads under a configuration, as plain relative paths. */
async function analyzed(root: string, config?: Record<string, unknown>): Promise<string[]> {
  const context = await AgentContext.load({ root, ...(config === undefined ? {} : { config }) });
  const repository = await context.getRepository();
  return repository.files.map((file) => file.path).sort();
}

describe('anchored patterns', () => {
  test('a leading slash anchors to the root and nowhere else', () => {
    const rule = compileGlob('/only-root.ts');
    assert.equal(rule('only-root.ts'), true, 'the root file is matched');
    assert.equal(rule('src/only-root.ts'), false, 'a file of the same name deeper is not');
    assert.equal(new PatternSet(['/dist/**']).test('dist/a.js'), true);
    assert.equal(new PatternSet(['/dist/**']).test('packages/x/dist/a.js'), false, 'anchored, unlike `dist/**`');
  });

  test('a `./` prefix and a trailing slash do not make a pattern dead', () => {
    assert.equal(compileGlob('./src/**')('src/a.ts'), true);
    assert.equal(compileGlob('/src/')('src/a.ts'), true);
  });

  test('an anchored root rule is honoured where the same unanchored rule reaches deeper', async () => {
    const root = emptyRepository();
    writeRepoFile(root, '.gitignore', '/only-root.ts\n');
    writeRepoFile(root, 'only-root.ts', 'export const a = 1;\n');
    writeRepoFile(root, 'src/only-root.ts', 'export const b = 2;\n');
    const files = await analyzed(root);
    assert.equal(files.includes('only-root.ts'), false);
    assert.equal(files.includes('src/only-root.ts'), true);
  });

  test('an anchored include pattern does not prune the very directory it names', async () => {
    const root = emptyRepository();
    writeRepoFile(root, 'src/a.ts', 'export const a = 1;\n');
    writeRepoFile(root, 'lib/b.ts', 'export const b = 2;\n');
    assert.deepEqual(await analyzed(root, { include: ['/src/**'] }), ['src/a.ts']);
    assert.deepEqual(await analyzed(root, { include: ['./src/**'] }), ['src/a.ts']);
  });
});

describe('.gitignore files', () => {
  test('a package\'s own .gitignore is honoured, and only for that package', async () => {
    const root = emptyRepository();
    writeRepoFile(root, 'packages/foo/package.json', JSON.stringify({ name: 'foo' }));
    writeRepoFile(root, 'packages/foo/.gitignore', 'generated/\n');
    writeRepoFile(root, 'packages/foo/src/y.ts', 'export const y = 1;\n');
    writeRepoFile(root, 'packages/foo/generated/x.ts', "import { y } from '../src/y';\nexport const x = y;\n");
    writeRepoFile(root, 'packages/bar/generated/z.ts', 'export const z = 3;\n');
    git(root, ['add', '-A']);

    const files = await analyzed(root);
    assert.equal(files.includes('packages/foo/generated/x.ts'), false, 'ignored by packages/foo/.gitignore');
    assert.equal(files.includes('packages/foo/src/y.ts'), true);
    assert.equal(files.includes('packages/bar/generated/z.ts'), true, 'another package is not affected');
  });

  test('a deeper file overrides a shallower one, including a re-inclusion', async () => {
    const root = emptyRepository();
    writeRepoFile(root, '.gitignore', '*.gen.ts\n');
    writeRepoFile(root, 'packages/foo/.gitignore', '!keep.gen.ts\n');
    writeRepoFile(root, 'src/a.gen.ts', 'export const a = 1;\n');
    writeRepoFile(root, 'packages/foo/keep.gen.ts', 'export const keep = 1;\n');
    writeRepoFile(root, 'packages/foo/drop.gen.ts', 'export const drop = 1;\n');
    writeRepoFile(root, 'packages/bar/keep.gen.ts', 'export const other = 1;\n');
    git(root, ['add', '-A']);

    const files = await analyzed(root);
    assert.equal(files.includes('packages/foo/keep.gen.ts'), true, 're-included by the deeper file');
    assert.equal(files.includes('packages/foo/drop.gen.ts'), false);
    assert.equal(files.includes('src/a.gen.ts'), false);
    assert.equal(files.includes('packages/bar/keep.gen.ts'), false, 'the re-inclusion is scoped to its directory');
  });

  test('rules of a nested file are relative to its directory', async () => {
    const root = emptyRepository();
    writeRepoFile(root, 'packages/foo/.gitignore', 'src/generated/\n');
    writeRepoFile(root, 'packages/foo/src/generated/client.ts', 'export const client = 1;\n');
    writeRepoFile(root, 'packages/foo/src/public.ts', 'export const publicApi = 1;\n');
    git(root, ['add', '-A']);
    const files = await analyzed(root);
    assert.equal(files.includes('packages/foo/src/generated/client.ts'), false);
    assert.equal(files.includes('packages/foo/src/public.ts'), true);
  });

  test('the repository\'s own exclude list (.git/info/exclude) is honoured', async () => {
    const root = emptyRepository();
    writeRepoFile(root, 'src/scratch.ts', 'export const scratch = 1;\n');
    writeRepoFile(root, '.git/info/exclude', 'src/scratch.ts\n');
    git(root, ['add', '-A']);
    assert.equal((await analyzed(root)).includes('src/scratch.ts'), false);
  });

  test('the configured ignore list outranks every .gitignore file', async () => {
    const root = emptyRepository();
    writeRepoFile(root, '.gitignore', 'src/kept.ts\n!src/kept.ts\n');
    writeRepoFile(root, 'src/kept.ts', 'export const kept = 1;\n');
    git(root, ['add', '-A']);
    assert.equal((await analyzed(root, { ignore: ['src/kept.ts'] })).includes('src/kept.ts'), false);
  });

  test('agrees with git on a tree that mixes all of the above', async () => {
    const root = emptyRepository();
    writeRepoFile(root, '.gitignore', '*.gen.ts\n/generated-root/\n');
    writeRepoFile(root, '.git/info/exclude', 'src/local.ts\n');
    writeRepoFile(root, 'packages/foo/.gitignore', '!kept.gen.ts\nbuild/\n');
    writeRepoFile(root, 'packages/foo/kept.gen.ts', 'export const kept = 1;\n');
    writeRepoFile(root, 'packages/foo/dropped.gen.ts', 'export const dropped = 1;\n');
    writeRepoFile(root, 'packages/foo/build/out.ts', 'export const out = 1;\n');
    writeRepoFile(root, 'packages/bar/dropped.gen.ts', 'export const dropped = 2;\n');
    writeRepoFile(root, 'generated-root/x.ts', 'export const x = 1;\n');
    writeRepoFile(root, 'src/local.ts', 'export const local = 1;\n');
    writeRepoFile(root, 'src/main.ts', 'export const main = 1;\n');
    git(root, ['add', '-A']);

    // `git ls-files --others --ignored --exclude-standard` is git's own answer.
    const ignoredByGit = new Set(
      execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'src', 'packages', 'generated-root'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    git(root, ['add', '-A']);
    const files = new Set(await analyzed(root));
    const source = [...ignoredByGit];
    assert.ok(source.length >= 4, `git should ignore several files here; it listed ${JSON.stringify(source)}`);
    for (const file of source) assert.equal(files.has(file), false, `${file} is ignored by git and must not be analyzed`);
    for (const file of ['src/main.ts', 'packages/foo/kept.gen.ts']) assert.equal(files.has(file), true, `${file} is not ignored by git`);
  });
});

describe('the walker on its own', () => {
  test('reads .gitignore files without being given any ignore patterns', async () => {
    const root = emptyRepository();
    writeRepoFile(root, '.gitignore', 'hidden.ts\n');
    writeRepoFile(root, 'src/hidden.ts', 'export const hidden = 1;\n');
    writeRepoFile(root, 'src/shown.ts', 'export const shown = 1;\n');
    const walked = await new FileSystemAdapter(root).walk({ include: new PatternSet(['**/*.ts']) });
    assert.deepEqual(walked.map((file) => file.path), ['src/shown.ts']);
  });
});
