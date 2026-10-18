#!/usr/bin/env node
/**
 * Runs the oracles against the pinned public repositories.
 *
 * Measuring ourselves is not evidence. Both oracles are exact, but this
 * repository is the one codebase we wrote the analyzer for; a defect that only
 * exists in other people's code would never show up. Each repository below is a
 * third-party codebase at a pinned commit, so a run is a check on the product
 * rather than on our own habits.
 *
 * This is the check that found a real bug: a nested generic in a type
 * annotation closed with `>>`, which the lexer had merged into a single shift
 * token, made the extractor skip to the end of the file. Every statement after
 * it silently lost its imports and exports, and the parse still reported
 * success. In a barrel file that is most of the public surface.
 *
 * Two oracles run per repository, because they answer different questions:
 *
 *  - `ground-truth.mjs` compares the dependency graph with the answer the
 *    TypeScript compiler gives.
 *  - `ground-truth-entry.mjs` compares declared entry points with the manifests
 *    that declare them.
 *
 * Nothing is vendored: each repository is cloned into a temporary directory,
 * measured, and deleted.
 *
 * Usage: npm run ground-truth:public [-- --only <name>] [-- --json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, 'tools/benchmark-repos.json'), 'utf8'));

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
const asJson = args.includes('--json');

const ORACLES = [
  { name: 'graph', script: 'tools/ground-truth.mjs', metrics: ['precision', 'recall'] },
  { name: 'entry', script: 'tools/ground-truth-entry.mjs', metrics: ['declared entry points', 'precision', 'recall'] },
];

function parseReport(output) {
  const metrics = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?):\s+(.*)$/.exec(line);
    if (match === null) continue;
    metrics[match[1].trim()] = match[2].trim();
  }
  return metrics;
}

/**
 * Runs one oracle and returns its metrics.
 *
 * A non-zero exit is the normal way these report a metric below 100%, so the
 * partial output is the result rather than a failure to have one. Output that
 * is entirely absent is a real failure and is rethrown.
 */
function runOracle(script, directory) {
  try {
    return parseReport(
      execFileSync('node', [path.join(root, script), directory], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    const output = typeof error.stdout === 'string' ? error.stdout : '';
    if (output.trim() === '') throw error;
    return parseReport(output);
  }
}

/**
 * Whether an oracle passed.
 *
 * `n/a` means the repository has no module edges to compare, which is a
 * property of the repository rather than a result. Refusing to pass those would
 * make a single-module package a permanent CI failure.
 */
function verdict(metrics, keys) {
  const precision = metrics[keys.precision] ?? 'n/a';
  const recall = metrics[keys.recall] ?? 'n/a';
  if (precision === 'n/a' || recall === 'n/a') return { ok: true, comparable: false, text: 'no module edges' };
  const ok = precision === '100%' && recall === '100%';
  return { ok, comparable: true, text: `${precision} / ${recall}` };
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
  const result = { name: entry.name, sha: entry.sha, oracles: {} };
  try {
    clonePinned(entry, directory);
    for (const oracle of ORACLES) {
      const metrics = runOracle(oracle.script, directory);
      const check = verdict(metrics, { precision: 'precision', recall: 'recall' });
      result.oracles[oracle.name] = {
        ...check,
        metrics: Object.fromEntries(oracle.metrics.map((key) => [key, metrics[key] ?? 'n/a'])),
      };
    }
    result.ok = Object.values(result.oracles).every((outcome) => outcome.ok);
    process.stderr.write(` graph ${result.oracles.graph.text}, entry ${result.oracles.entry.text}\n`);
  } catch (error) {
    // A clone that fails is a failure, not a skip. Silently measuring fewer
    // repositories is how a green run starts meaning nothing.
    result.ok = false;
    result.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
    process.stderr.write(' FAILED\n');
  }
  results.push(result);
}

rmSync(workspace, { recursive: true, force: true });

const failures = results.filter((result) => !result.ok);
const summary = {
  repositories: results.length,
  passed: results.length - failures.length,
  graphNotComparable: results.filter((result) => result.oracles?.graph?.comparable === false).length,
  entryNotComparable: results.filter((result) => result.oracles?.entry?.comparable === false).length,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ...summary, results }, null, 2)}\n`);
} else {
  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    const mark = result.ok ? 'ok  ' : 'LOW ';
    if (result.error !== undefined) {
      process.stdout.write(`${mark} ${result.name.padEnd(width)}  FAILED: ${result.error}\n`);
      continue;
    }
    const { graph, entry } = result.oracles;
    const declared = entry.metrics['declared entry points'] === 'n/a' ? '' : ` of ${entry.metrics['declared entry points']} declared`;
    process.stdout.write(
      `${mark} ${result.name.padEnd(width)}  graph ${graph.text.padEnd(16)} entry ${entry.text}${declared}\n`,
    );
  }
  process.stdout.write(
    `\n${summary.passed}/${summary.repositories} at 100% precision and recall on both oracles` +
      (summary.graphNotComparable > 0 ? `, ${summary.graphNotComparable} without module edges to compare` : '') +
      '\n',
  );
}

process.exit(failures.length === 0 ? 0 : 1);