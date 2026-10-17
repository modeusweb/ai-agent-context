#!/usr/bin/env node
/**
 * Regenerates the public API surface locks.
 *
 * The lock files under each package's `test` directory record every symbol that
 * package exports. They exist so that changing the public API is a deliberate, reviewable
 * act rather than something a refactor does by accident: a test compares the
 * real exports against the lock and fails when they differ, and regenerating the
 * lock is an explicit `npm run api:lock`.
 *
 * Usage:
 *   node tools/api-surface.mjs          # report drift, exit 1 on a mismatch
 *   node tools/api-surface.mjs --write  # rewrite the locks
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

const PACKAGES = [
  { name: 'core', entry: 'packages/core/dist/index.js', lock: 'packages/core/test/public-api.lock.json' },
  { name: 'cli', entry: 'packages/cli/dist/index.js', lock: 'packages/cli/test/public-api.lock.json' },
  { name: 'mcp', entry: 'packages/mcp/dist/index.js', lock: 'packages/mcp/test/public-api.lock.json' },
];

let drifted = 0;

for (const pkg of PACKAGES) {
  const entry = path.join(root, pkg.entry);
  if (!existsSync(entry)) {
    console.error(`skip ${pkg.name}: ${pkg.entry} not built (run: npm run build)`);
    process.exitCode = 1;
    continue;
  }
  const module = await import(`file://${entry.replace(/\\/g, '/')}`);
  const actual = Object.keys(module).sort();
  const lockPath = path.join(root, pkg.lock);

  if (write) {
    const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).exports : [];
    const removed = previous.filter((name) => !actual.includes(name));
    const added = actual.filter((name) => !previous.includes(name));
    writeFileSync(lockPath, `${JSON.stringify({ package: pkg.name, exports: actual }, null, 2)}\n`, 'utf8');
    console.log(
      previous.length === 0
        ? `  created ${pkg.lock} (${actual.length} exports)`
        : `  updated ${pkg.lock} (+${added.length} -${removed.length})`,
    );
    continue;
  }

  if (!existsSync(lockPath)) {
    console.error(`missing ${pkg.lock} — run: node tools/api-surface.mjs --write`);
    process.exitCode = 1;
    drifted += 1;
    continue;
  }
  const locked = JSON.parse(readFileSync(lockPath, 'utf8'));

  const removed = locked.exports.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !locked.exports.includes(name));

  if (added.length === 0 && removed.length === 0) {
    console.log(`  ok   ${pkg.name}: ${actual.length} exports unchanged`);
    continue;
  }
  drifted += 1;
  console.error(`  DRIFT ${pkg.name}`);
  for (const name of removed) console.error(`    removed: ${name}`);
  for (const name of added) console.error(`    added:   ${name}`);
  console.error('');
  console.error('  The public API is a contract (see STABILITY.md). If the change is');
  console.error('  intentional, record it in MIGRATION.md and run:');
  console.error('    node tools/api-surface.mjs --write');
}

if (drifted > 0 && !write) {
  console.error(`${drifted} package(s) drifted from the locked public API.`);
  process.exitCode = 1;
}