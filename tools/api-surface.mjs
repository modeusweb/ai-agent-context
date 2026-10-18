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
import { exportedTypeNames } from './exported-types.mjs';

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
  // Types have no runtime binding, so they are read from the declaration file
  // instead. Without this half a renamed type or interface changed the package
  // without changing anything the lock could see.
  const types = exportedTypeNames(path.join(root, pkg.entry.replace(/\.js$/, '.d.ts')));
  const lockPath = path.join(root, pkg.lock);

  if (write) {
    const previousLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { exports: [], types: [] };
    const removed = previousLock.exports.filter((name) => !actual.includes(name));
    const added = actual.filter((name) => !previousLock.exports.includes(name));
    const typesRemoved = (previousLock.types ?? []).filter((name) => !types.includes(name));
    const typesAdded = types.filter((name) => !(previousLock.types ?? []).includes(name));
    writeFileSync(
      lockPath,
      `${JSON.stringify({ package: pkg.name, exports: actual, types }, null, 2)}\n`,
      'utf8',
    );
    const counts = `+${added.length} -${removed.length} values, +${typesAdded.length} -${typesRemoved.length} types`;
    console.log(
      previousLock.exports.length === 0
        ? `  created ${pkg.lock} (${actual.length} exports, ${types.length} types)`
        : `  updated ${pkg.lock} (${counts})`,
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
  const typesRemoved = (locked.types ?? []).filter((name) => !types.includes(name));
  const typesAdded = types.filter((name) => !(locked.types ?? []).includes(name));

  if (added.length === 0 && removed.length === 0 && typesAdded.length === 0 && typesRemoved.length === 0) {
    console.log(`  ok   ${pkg.name}: ${actual.length} exports, ${types.length} types, unchanged`);
    continue;
  }
  drifted += 1;
  console.error(`  DRIFT ${pkg.name}`);
  for (const name of removed) console.error(`    removed:        ${name}`);
  for (const name of added) console.error(`    added:          ${name}`);
  for (const name of typesRemoved) console.error(`    removed type:   ${name}`);
  for (const name of typesAdded) console.error(`    added type:     ${name}`);
  console.error('');
  console.error('  The public API is a contract (see STABILITY.md). If the change is');
  console.error('  intentional, record it in MIGRATION.md and run:');
  console.error('    node tools/api-surface.mjs --write');
}

if (drifted > 0 && !write) {
  console.error(`${drifted} package(s) drifted from the locked public API.`);
  process.exitCode = 1;
}