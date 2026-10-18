#!/usr/bin/env node
/**
 * Runs the TypeScript-compiler oracle against the pinned public repositories.
 *
 * Measuring ourselves is not evidence. The oracle is exact against a compiler,
 * but this repository is the one codebase we wrote the analyzer for; a defect
 * that only exists in other people's code would never show up. Each repository
 * below is a third-party codebase at a pinned commit, so a run is a check on
 * the product rather than on our own habits.
 *
 * This is the check that found a real bug: a nested generic in a type
 * annotation closed with `>>`, which the lexer had merged into a single shift
 * token, made the extractor skip to the end of the file. Every statement after
 * it silently lost its imports and exports, and the parse still reported
 * success. In a barrel file that is most of the public surface.
 *
 * Nothing is vendored: each repository is cloned into a temporary directory,
 * measured, and deleted.
 *
 * Usage: npm run ground-truth:public [-- --only <name>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, 'tools/benchmark-repos.json'), 'utf8'));

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
const asJson = args.includes('--json');

/** Fields read back out of `ground-truth.mjs` output. */
const FIELDS = ['files', 'specifiers', 'analyzer edges', 'precision', 'recall'];

function parseReport(output) {
  const metrics = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?):\s+(.*)$/.exec(line);
    if (match === null) continue;
    metrics[match[1].trim()] = match[2].trim();
  }
  return metrics;
}

/** True when a metric is exactly 100%, or when it does not apply at all. */
function isSatisfied(metrics) {
  const precision = metrics.precision ?? 'n/a';
  const recall = metrics.recall ?? 'n/a';
  // `n/a` means the repository has no module edges to compare, which is a
  // property of the repository rather than a result. Refusing to pass those
  // would make a single-module package a permanent CI failure.
  if (precision === 'n/a' || recall === 'n/a') return { ok: true, comparable: false };
  return { ok: precision === '100%' && recall === '100%', comparable: true };
}

function clonePinned(entry, target) {
  // Fetching a single commit keeps the clone shallow even for repositories with
  // a long history, and the pinned SHA is what makes the run reproducible.
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--no-tags', entry.url, target], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', entry.sha], {
    cwd: target,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['checkout', '--quiet', entry.sha], { cwd: target, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
  if (head !== entry.sha) throw new Error(`expected ${entry.sha}, checked out ${head}`);
  return target;
}

function measure(entry, directory) {
  try {
    const output = execFileSync('node', [path.join(root, 'tools/ground-truth.mjs'), directory], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { metrics: parseReport(output) };
  } catch (error) {
    // A non-zero exit is the normal way this script reports a metric below
    // 100%, so the partial output is the result, not a failure to have one.
    const output = typeof error.stdout === 'string' ? error.stdout : '';
    if (output.trim() === '') throw error;
    return { metrics: parseReport(output) };
  }
}

const entries = only === null ? manifest.repositories : manifest.repositories.filter((entry) => entry.name === only);
if (entries.length === 0) {
  process.stderr.write(`no repository named "${only}" in tools/benchmark-repos.json\n`);
  process.exit(2);
}

const workspace = mkdtempSync(path.join(os.tmpdir(), 'aac-ground-truth-public-'));
const results = [];

for (const entry of entries) {
  const directory = path.join(workspace, entry.name);
  process.stderr.write(`measuring ${entry.name}...`);
  let result;
  try {
    clonePinned(entry, directory);
    const { metrics } = measure(entry, directory);
    const verdict = isSatisfied(metrics);
    result = { name: entry.name, sha: entry.sha, ...verdict, metrics };
  } catch (error) {
    // A clone that fails is a failure, not a skip. Silently measuring fewer
    // repositories is how a green run starts meaning nothing.
    result = {
      name: entry.name,
      sha: entry.sha,
      ok: false,
      comparable: true,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }
  process.stderr.write(
    result.error === undefined
      ? ` ${result.comparable ? `${result.metrics.precision}/${result.metrics.recall}` : 'no module edges'}\n`
      : ` FAILED\n`,
  );
  results.push(result);
}

rmSync(workspace, { recursive: true, force: true });

const failures = results.filter((result) => !result.ok);
const report = {
  repositories: results.length,
  passed: results.length - failures.length,
  notComparable: results.filter((result) => result.comparable === false).length,
  failures: failures.map((result) => ({ name: result.name, ...(result.error === undefined ? {} : { error: result.error }), ...(result.metrics === undefined ? {} : { metrics: Object.fromEntries(FIELDS.map((field) => [field, result.metrics[field] ?? 'n/a'])) }) })),
  results: results.map((result) => ({ name: result.name, sha: result.sha, ...(result.error === undefined ? {} : { error: result.error }), ...(result.metrics === undefined ? {} : { metrics: Object.fromEntries(FIELDS.map((field) => [field, result.metrics[field] ?? 'n/a'])) }) })),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    const verdict = result.error !== undefined ? `FAILED: ${result.error}` : result.comparable ? `${result.metrics.precision} / ${result.metrics.recall}` : 'no module edges to compare';
    const mark = result.ok ? 'ok  ' : 'LOW ';
    process.stdout.write(`${mark} ${result.name.padEnd(width)}  ${verdict}\n`);
  }
  process.stdout.write(
    `\n${report.passed}/${report.repositories} at 100% precision and recall` +
      (report.notComparable > 0 ? `, ${report.notComparable} without module edges to compare` : '') +
      '\n',
  );
}

process.exit(failures.length === 0 ? 0 : 1);