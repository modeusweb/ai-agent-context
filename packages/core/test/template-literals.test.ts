/**
 * Expressions inside template literals.
 *
 * Regression for a defect found by running the analyzer over a third-party
 * repository: a regex literal ending in an escaped slash — the ordinary way to
 * write "replace slashes", and very common inside a template literal — was read
 * as the start of a line comment.
 *
 * The scan over `${ ... }` did not know what an expression could contain, so a
 * bare `/` was always tested against the two comment forms, and the sequence
 * `/\//` looked like the two characters that open a comment. Everything after it
 * on that line was discarded, the scan carried on past the closing brace, and the
 * statements after it lost their imports.
 *
 * Two things about testing this are worth writing down, because both cost time.
 *
 * An import written *above* the construct parses either way, so a test that
 * checks resolved specifiers passes with the defect present — which is exactly
 * how it survived a first round of investigation. And `parseStatus` is not a
 * reliable signal either: a scan that swallows the rest of the file still
 * reports `ok`. The only position that discriminates is an import written
 * *after* the construct, which is what every case below checks.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { runPipeline } from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const PROBE = 'src/probe.ts';
const IMPORT = "import {formatUserName} from './models/user.js';\n";

/**
 * Runs a probe file through the pipeline and reports what the extractor recorded.
 *
 * The import is written after `body`, because a scan that loses its place loses
 * the statements that follow it and nothing else.
 */
async function probe(body: string): Promise<{ status: string; specifiers: string[] }> {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  writeRepoFile(root, PROBE, `${body}\n${IMPORT}export {formatUserName};\n`);

  const result = await runPipeline({ root, dryRun: true, force: true });
  const file = result.graph.repository.files.find((candidate) => candidate.path === PROBE);
  const specifiers = (result.parsed.get(PROBE)?.imports ?? []).map((record) => record.specifier);
  return { status: file?.parseStatus ?? 'missing', specifiers };
}

const IMPORT_KEPT = './models/user.js';

describe('expressions inside template literals', () => {
  test('a regex ending in an escaped slash is not read as a comment', async () => {
    const { specifiers } = await probe('const dir = `/p/${name.replace(/\\//g, "-")}`;');
    assert.ok(
      specifiers.includes(IMPORT_KEPT),
      `the import after the construct was dropped; recorded: ${JSON.stringify(specifiers)}`,
    );
  });

  test('several chained escaped-slash regexes stay balanced', async () => {
    const { specifiers } = await probe('const v = `${a.replace(/\\//g, "-").replace(/\\./g, "_")}`;');
    assert.ok(specifiers.includes(IMPORT_KEPT), `recorded: ${JSON.stringify(specifiers)}`);
  });

  test('a regex whose class contains a comment opener is not a comment', async () => {
    // The other half of the fix. Handling `\`` keeps a slash-replacing regex
    // aligned, but `[/*]` and `[//]` contain two characters that open a comment,
    // and only reading the regex as one token avoids that.
    for (const pattern of ['/[/*]/', '/[//]/', '/[*]/']) {
      const { specifiers } = await probe(`const v = \`${'${'}${pattern}.test(x)}\`;`);
      assert.ok(specifiers.includes(IMPORT_KEPT), `${pattern}: recorded ${JSON.stringify(specifiers)}`);
    }
  });

  test('other escapes inside ${...} are unaffected', async () => {
    for (const expression of [
      '`${a.replace(/\\d/g, "")}`',
      '`${a.replace(/\\./g, "")}`',
      '`${a.replace(/^@/, "")}`',
      '`${a.replace(/[a-z]/g, "")}`',
      '`${a.replace(/a{2,}/g, "")}`',
    ]) {
      const { specifiers } = await probe(`const v = ${expression};`);
      assert.ok(specifiers.includes(IMPORT_KEPT), `${expression}: recorded ${JSON.stringify(specifiers)}`);
    }
  });

  test('a regex matching the closing brace does not close the expression', async () => {
    for (const pattern of ['/}/', '/[{}]/', '/\\}/']) {
      const { specifiers } = await probe(`const v = \`${'${'}${pattern}.test(value)}\`;`);
      assert.ok(specifiers.includes(IMPORT_KEPT), `${pattern}: recorded ${JSON.stringify(specifiers)}`);
    }
  });

  test('a nested template inside ${...} still closes the right brace', async () => {
    const { specifiers } = await probe('const v = `${ `${a}` }`;');
    assert.ok(specifiers.includes(IMPORT_KEPT), `recorded: ${JSON.stringify(specifiers)}`);
  });

  test('division inside ${...} is not mistaken for a regex', async () => {
    const { specifiers } = await probe('const v = `${total / count}`;');
    assert.ok(specifiers.includes(IMPORT_KEPT), `recorded: ${JSON.stringify(specifiers)}`);
  });

  test('a comment inside ${...} is still a comment', async () => {
    const { specifiers } = await probe('const v = `${a /* note */ + b}`;');
    assert.ok(specifiers.includes(IMPORT_KEPT), `recorded: ${JSON.stringify(specifiers)}`);
  });

  test('the same constructs outside a template are unaffected', async () => {
    for (const statement of [
      'const v = "a/b".replace(/\\//g, "-");',
      'const v = "a".replace(/[/*]/g, "");',
      'const v = /\\//g;',
    ]) {
      const { specifiers } = await probe(statement);
      assert.ok(specifiers.includes(IMPORT_KEPT), `${statement}: recorded ${JSON.stringify(specifiers)}`);
    }
  });

  test('the scan report counts partial parses', async () => {
    // The defect was invisible twice because nothing reported it as a count. A
    // file the extractor only partly understood has to show up as a number a
    // caller can gate on, not as a warning buried in the log.
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = (await import('../../core/dist/index.js')).AgentContext;
    const loaded = await context.load({ root });
    const report = await loaded.scan();
    assert.equal(report.files.partial, 0, 'the fixture must parse completely');
    assert.equal(report.files.failed, 0);
  });
});