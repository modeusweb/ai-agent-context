#!/usr/bin/env node
/**
 * Fails when the committed `.agent/` context no longer describes the source.
 *
 * Why this exists instead of `git diff -- .agent` or `agent-context verify`:
 *
 * - `git diff -- .agent` requires byte-identical regeneration, which can never
 *   hold. `.agent/index.json` records `git.commitsAnalyzed`, so *every* commit
 *   to this repository changes the regenerated output even when no source file
 *   changed. It also records the repository directory name.
 * - `agent-context verify` compares the working tree against `.agent/.local/
 *   state.json`, which is gitignored. On a fresh clone there is no baseline, so
 *   every file is reported as pending and the command always exits 1.
 *
 * What actually matters is one property: does the committed context describe the
 * files that are in the tree right now? That is exactly the set of recorded
 * `path -> sha256` pairs, so this compares those and ignores everything else.
 * It is stable across commits, across directory names, and across git history,
 * and it still catches real drift (a source edit without a regeneration) as
 * well as a checkout that disagrees about file contents (different line
 * endings).
 *
 * Usage:
 *   node tools/check-context.mjs           # compare committed vs working tree
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = '.agent/index.json';

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Reads the committed index document, or null when the context is untracked. */
function readCommitted() {
  try {
    return JSON.parse(git(['show', `HEAD:${INDEX}`]));
  } catch {
    return null;
  }
}

function readWorkingTree() {
  try {
    return JSON.parse(readFileSync(path.join(root, INDEX), 'utf8'));
  } catch {
    return null;
  }
}

/** `path -> sha256` for every analyzed file. */
function hashMap(document) {
  const entries = document?.files?.entries;
  if (!Array.isArray(entries)) return null;
  return new Map(entries.map((entry) => [entry.path, entry.hash]));
}

const committed = readCommitted();
const fresh = readWorkingTree();

if (fresh === null) {
  console.error(`${INDEX} was not generated. Run the scan before this check.`);
  process.exit(1);
}
if (committed === null) {
  console.error(`${INDEX} is not tracked in HEAD. Commit the generated context.`);
  process.exit(1);
}

const before = hashMap(committed);
const after = hashMap(fresh);
if (before === null || after === null) {
  console.error(`${INDEX} has no "files.entries"; cannot compare.`);
  process.exit(1);
}

const drift = [];
for (const [file, hash] of before) {
  const current = after.get(file);
  if (current === undefined) drift.push({ file, why: 'removed from the analysis' });
  else if (current !== hash) drift.push({ file, why: 'contents changed' });
}
for (const file of after.keys()) {
  if (!before.has(file)) drift.push({ file, why: 'not present in the committed context' });
}

if (drift.length > 0) {
  console.error(`${drift.length} file(s) are described differently by the committed context:`);
  for (const { file, why } of drift) console.error(`  ${file} (${why})`);
  console.error('');
  console.error('Regenerate the context and commit it:');
  console.error('  npx agent-context scan && git add .agent && git commit -m "chore(context): rescan"');
  process.exit(1);
}

console.log(`committed context matches all ${before.size} analyzed file(s)`);