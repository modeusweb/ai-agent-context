#!/usr/bin/env node
/**
 * Clean tool for the monorepo.
 *
 * Removes build artifacts and temporary files.
 */
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const dirsToClean = [
  path.join(root, 'packages', 'core', 'dist'),
  path.join(root, 'packages', 'cli', 'dist'),
  path.join(root, 'packages', 'mcp', 'dist'),
  path.join(root, '.temp'),
  path.join(root, 'fixtures'),
];

let removed = 0;

for (const dir of dirsToClean) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Removed: ${dir}`);
    removed++;
  }
}

if (removed === 0) {
  console.log('Nothing to clean.');
} else {
  console.log(`Cleaned ${removed} director${removed === 1 ? 'y' : 'ies'}.`);
}
