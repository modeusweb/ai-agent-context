/**
 * Nested generics in a type annotation.
 *
 * Regression for a silent data-loss bug found by the TypeScript-compiler oracle
 * on a third-party repository: a type annotation closing with `>>` made the
 * extractor skip to the end of the file, so every statement after it lost its
 * imports and exports — while the parse still reported success.
 *
 * In a barrel file that is most of the public surface. The consequences were
 * not cosmetic: `get_dependents`, `get_change_impact`, layering diagnostics and
 * cycle detection all read that graph.
 *
 * The lexer merges `>>`, `>>>` and `>>=` into single tokens, which is correct for
 * real shift operators, so the parser has to count the closing brackets a token
 * carries rather than comparing its value.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

function repo(): string {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  writeRepoFile(root, 'src/deep/one.ts', 'export const one = 1;\n');
  writeRepoFile(root, 'src/deep/two.ts', 'export const two = 2;\n');
  return root;
}

/** Specifiers the extractor recorded for one file. */
async function specifiersIn(root: string, file: string): Promise<string[]> {
  const context = await AgentContext.load({ root });
  await context.scan();
  const document = await context.getDependencies();
  const entry = document.fileImports.find((candidate) => candidate.file === file);
  return entry === undefined ? [] : entry.internalModules;
}

describe('nested generics in type annotations', () => {
  test('statements after a >> annotation are still parsed', async () => {
    const root = repo();
    writeRepoFile(
      root,
      'src/barrel.ts',
      [
        'const build: Partial<Mutable<Builder>> = (input: Input) => createRequest(input);',
        'export {one} from \'./deep/one.ts\';',
        'export {two} from \'./deep/two.ts\';',
        '',
      ].join('\n'),
    );

    const modules = await specifiersIn(root, 'src/barrel.ts');
    assert.ok(
      modules.includes('src/deep'),
      `the re-exports after the nested generic were dropped; recorded: ${JSON.stringify(modules)}`,
    );
  });

  test('a nested generic produces a dependency edge', async () => {
    const root = repo();
    writeRepoFile(
      root,
      'src/barrel.ts',
      [
        'const build: Partial<Mutable<Builder>> = (input: Input) => createRequest(input);',
        'export {one} from \'./deep/one.ts\';',
        '',
      ].join('\n'),
    );

    const context = await AgentContext.load({ root });
    await context.scan();
    const document = await context.getDependencies();
    const edge = document.internal.find(
      (candidate) => candidate.from === 'src' && candidate.to === 'src/deep',
    );
    assert.ok(edge !== undefined, 'the module edge created by the re-export is missing');
  });

  test('a triple generic closes all three levels', async () => {
    const root = repo();
    writeRepoFile(
      root,
      'src/barrel.ts',
      [
        'const build: Outer<Middle<Inner<Value>>> = buildThing();',
        'export {one} from \'./deep/one.ts\';',
        '',
      ].join('\n'),
    );
    const modules = await specifiersIn(root, 'src/barrel.ts');
    assert.ok(modules.includes('src/deep'), `recorded: ${JSON.stringify(modules)}`);
  });

  test('an ordinary shift expression is not mistaken for a type argument', async () => {
    const root = repo();
    writeRepoFile(
      root,
      'src/barrel.ts',
      [
        'export const shifted = (a: number, b: number) => a >> b;',
        'export {one} from \'./deep/one.ts\';',
        '',
      ].join('\n'),
    );
    const modules = await specifiersIn(root, 'src/barrel.ts');
    assert.ok(modules.includes('src/deep'), `recorded: ${JSON.stringify(modules)}`);
  });

  test('the parse is still reported as complete', async () => {
    // The failure mode was silent: no diagnostic, so nothing pointed at the file.
    const root = repo();
    writeRepoFile(
      root,
      'src/barrel.ts',
      [
        'const build: Partial<Mutable<Builder>> = (input: Input) => createRequest(input);',
        'export {one} from \'./deep/one.ts\';',
        '',
      ].join('\n'),
    );
    const context = await AgentContext.load({ root });
    await context.scan();
    const report = await context.detect();
    assert.equal(report.analyzed.partial, 0, 'the file must parse completely');
    assert.equal(report.analyzed.failed, 0, 'the file must not fail to parse');
    assert.equal(
      report.analyzed.parsed,
      report.analyzed.files,
      'every analyzed file must produce usable facts',
    );
  });
});