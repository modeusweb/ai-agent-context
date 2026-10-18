#!/usr/bin/env node
/**
 * Entry points that are declared, checked against the manifest.
 *
 * Entry points come from four sources: declared `package.json` fields, npm
 * scripts that name a file, naming conventions, and behavioural signals. Three
 * of those are heuristics, and this project has no oracle for heuristics — a
 * corpus labelled by hand would measure the labeller.
 *
 * The declared fields are different in kind. When a manifest says
 * `"bin": { "agent-context": "./dist/bin.js" }` then the file that command runs
 * is not a judgement, it is a statement of fact that exists independently of
 * anything in `packages/core`. So this script reads the manifests with its own
 * code, derives the declared entry files from them, and compares that with what
 * the analyzer reported. It is a real cross-check because the analyzer cannot
 * disagree without being wrong.
 *
 * Scope rules, each counted in the output rather than assumed:
 *
 *  - `types` is excluded, because the analyzer deliberately does not report a
 *    type declaration file as a runtime entry point. Measuring it here would
 *    report every package that declares types as a false positive, which
 *    measures a decision rather than an accuracy.
 *  - Wildcard exports (`"./*": "./src/*.ts"`) are excluded for the same reason
 *    they are excluded upstream: they name a family of files, not one.
 *  - Comparison is over `(path, type)` pairs, which is the analyzer's own
 *    identity for an entry point.
 *  - Only workspace packages the analyzer discovered are measured. Which
 *    packages exist is a separate question with its own answer; this measures
 *    what the entry-point detection did with the packages it was given.
 *
 * Usage: npm run ground-truth:entry [-- --json]
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentContext } from '../packages/core/dist/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(process.argv[2] ?? root);
const asJson = process.argv.includes('--json');

const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.agent']);

/** Manifest fields that declare a runtime entry point, and the type each yields. */
const DECLARED_FIELDS = new Map([
  ['main', 'package-main'],
  ['module', 'package-main'],
  ['browser', 'package-main'],
  ['exports', 'package-export'],
  ['bin', 'package-bin'],
]);

function toRelative(absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

function readManifests(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED.has(entry.name)) continue;
      readManifests(full, acc);
      continue;
    }
    if (entry.name === 'package.json') acc.push(full);
  }
  return acc;
}

/**
 * Every entry file a manifest declares.
 *
 * Returns pairs of `(package-relative path, entry point type)`. No filesystem
 * check is made: a manifest may declare a file that does not exist yet because
 * it is build output, and the declaration is still the fact under test.
 */
function declaredEntries(manifest, packageDirectory) {
  const found = new Set();
  const add = (field, value) => {
    if (typeof value !== 'string' || value === '' || value.includes('*')) return;
    const type = DECLARED_FIELDS.get(field);
    // `browser` may be an object of overrides rather than a string entry.
    if (type === undefined) return;
    found.add(`${path.posix.join(packageDirectory, value.replace(/^\.\//, ''))}|${type}`);
  };

  add('main', manifest.main);
  add('module', manifest.module);
  add('browser', manifest.browser);
  add('bin', typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0]);
  flattenExports(manifest.exports).forEach((value) => add('exports', value));
  return found;
}

/** Flattens the several shapes `exports` is allowed to take into a list of paths. */
function flattenExports(node, acc = []) {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) for (const item of node) flattenExports(item, acc);
  else if (node !== null && typeof node === 'object') for (const value of Object.values(node)) flattenExports(value, acc);
  return acc;
}

const context = await AgentContext.load({ root: repoRoot });
await context.scan();
const repository = await context.getRepository();

const discovered = new Map(
  repository.workspace.packages.map((pkg) => [pkg.path, pkg.name ?? pkg.path]),
);

const expected = new Set();
const skippedWildcards = [];
for (const manifestPath of readManifests(repoRoot)) {
  const directory = toRelative(path.dirname(manifestPath));
  // Only packages the analyzer discovered are measured; see the scope rules.
  if (!discovered.has(directory)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  for (const pair of declaredEntries(manifest, directory)) expected.add(pair);
  if (typeof manifest.bin === 'object' && Object.keys(manifest.bin ?? {}).length > 1) {
    skippedWildcards.push(`${directory}: bin declares several commands, the first is compared`);
  }
}

const analyzer = new Set(
  repository.entryPoints
    .filter((entry) => entry.type.startsWith('package-'))
    .map((entry) => `${entry.path}|${entry.type}`),
);

const truePositive = [...expected].filter((pair) => analyzer.has(pair));
const falseNegative = [...expected].filter((pair) => !analyzer.has(pair));
const falsePositive = [...analyzer].filter((pair) => !expected.has(pair));
const percent = (part, total) => (total === 0 ? null : Number(((part / total) * 100).toFixed(1)));

const report = {
  repository: toRelative(repoRoot) || '.',
  packagesCompared: discovered.size,
  declaredEntryFiles: expected.size,
  analyzerEntryFiles: analyzer.size,
  truePositive: truePositive.length,
  falsePositive: falsePositive.length,
  falseNegative: falseNegative.length,
  precision: percent(truePositive.length, truePositive.length + falsePositive.length),
  recall: percent(truePositive.length, truePositive.length + falseNegative.length),
  notMeasured: [
    'entry points found by npm script reference: the detection is a heuristic over command lines, and a second heuristic written independently would measure itself',
    'entry points found by naming convention or behavioural signal: no oracle exists for these, by construction',
  ],
  ...(falsePositive.length === 0 && falseNegative.length === 0
    ? {}
    : { details: { falsePositive, falseNegative } }),
  ...(skippedWildcards.length === 0 ? {} : { notes: skippedWildcards }),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`declared entry points: ${report.declaredEntryFiles}\n`);
  process.stdout.write(`true positive:       ${report.truePositive}\n`);
  process.stdout.write(`false positive:      ${report.falsePositive}\n`);
  process.stdout.write(`false negative:      ${report.falseNegative}\n`);
  process.stdout.write(`precision:           ${report.precision === null ? 'n/a' : `${report.precision}%`}\n`);
  process.stdout.write(`recall:              ${report.recall === null ? 'n/a' : `${report.recall}%`}\n`);
  process.stdout.write('\nnot measured, and deliberately so:\n');
  for (const item of report.notMeasured) process.stdout.write(`  - ${item}\n`);
}

process.exit(falsePositive.length === 0 && falseNegative.length === 0 ? 0 : 1);