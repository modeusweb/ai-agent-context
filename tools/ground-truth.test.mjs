/**
 * Tests for the oracle itself.
 *
 * A check that only prints a number is not a gate, and a gate that compares a
 * different set of files than the analyzer read is not a comparison. These two
 * tests fail on the 1.1.1 oracle: the first because the file-level verdict was
 * never enforced, the second because 43 pairs under `fixtures/` were counted
 * as "not compared" and dot-directories were absent from the truth tree.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { oracleFailures } from './oracle-gate.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const oracle = path.join(root, 'tools/ground-truth.mjs');

/** A clean report; the fields not relevant to a test are still explicit. */
function cleanReport() {
  return {
    precisionPercent: 100,
    recallPercent: 100,
    fileLevel: {
      falsePositive: 0,
      falseNegative: 0,
      falsePositiveSample: [],
      falseNegativeSample: [],
    },
    unresolvedCrossCheck: { missed: 0 },
    missedSample: [],
  };
}

test('a single missing file pair fails the oracle even at 100% module precision', () => {
  const report = cleanReport();
  report.fileLevel.falseNegative = 1;
  report.fileLevel.falseNegativeSample = ['src/a.ts -> src/b.ts'];
  const failures = oracleFailures(report);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /file-level oracle: 0 extra and 1 missing pair/);
  assert.match(failures[0], /src\/a\.ts -> src\/b\.ts/);
});

test('an unresolved claim the compiler can resolve fails the oracle', () => {
  const report = cleanReport();
  report.unresolvedCrossCheck.missed = 1;
  report.missedSample = ['src/a.ts: ./b'];
  assert.match(oracleFailures(report).join('\n'), /reported unresolved but resolvable/);
});

test('a clean report has no failures', () => {
  assert.deepEqual(oracleFailures(cleanReport()), []);
});

test('the oracle compares only the configured scope, including dot-directories', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aac-oracle-scope-'));
  try {
    const write = (file, contents) => {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), `${contents}\n`, 'utf8');
    };
    write('package.json', JSON.stringify({ name: 'oracle-scope-fixture', version: '1.0.0', private: true }));
    write('.agent/config.json', JSON.stringify({ version: 1, exclude: ['excluded/**'] }));
    write('src/shared.ts', 'export const value = 1;');
    write('src/a.ts', "import { value } from './shared';\nexport const a = value;");
    // The truth file is outside the configured scope. It must be counted as
    // excluded, not silently compared and not left as an unexplained gap.
    write('excluded/other.ts', "import { value } from '../src/shared';\nexport const other = value;");
    // The analyzer reads dot-directories; so must the oracle.
    write('.changeset/change.ts', "import { value } from '../src/shared';\nexport const change = value;");

    const output = execFileSync(process.execPath, [oracle, directory, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(output);

    assert.ok(report.scope.filesExcludedByConfig >= 1, 'the excluded source file must be reported, not silently dropped');
    assert.equal(report.fileLevel.outsideConfiguration, 0);
    assert.equal(report.fileLevel.outsideOracleWalk, 0);
    assert.ok(
      report.fileLevel.truthSample.some((pair) => pair.startsWith('.changeset/')),
      `an import inside a dot-directory must be in the truth: ${JSON.stringify(report.fileLevel.truthSample)}`,
    );
    assert.ok(report.fileLevel.truthPairs >= 2);
    assert.equal(report.fileLevel.falseNegative, 0);
    assert.equal(report.fileLevel.falsePositive, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the oracle counts typeof import() as a type-only dependency', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aac-oracle-typeof-'));
  try {
    const write = (file, contents) => {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), `${contents}\n`, 'utf8');
    };
    write('package.json', JSON.stringify({ name: 'oracle-typeof-fixture', version: '1.0.0', private: true }));
    write('src/shared.ts', 'export const value = 1;');
    // TypeScript parses this as ImportTypeNode, not as a CallExpression. The
    // analyzer records it; without this branch the oracle called it an extra pair.
    write('src/types.ts', "declare const shared: typeof import('./shared');\nexport { shared };\n");

    const output = execFileSync(process.execPath, [oracle, directory, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(output);
    assert.ok(
      report.fileLevel.truthSample.includes('src/types.ts -> src/shared.ts'),
      `typeof import() must be in the truth: ${JSON.stringify(report.fileLevel.truthSample)}`,
    );
    assert.equal(report.fileLevel.falsePositive, 0);
    assert.equal(report.fileLevel.falseNegative, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
