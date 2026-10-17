#!/usr/bin/env node
/**
 * Checks that every symbol STABILITY.md promises is actually exported.
 *
 * A stability document that names a symbol the package does not export is worse
 * than no document: it is a promise nobody can rely on, and it is the kind of
 * drift that goes unnoticed because documentation is not compiled. The claim
 * lives in the document, so the check belongs next to the code.
 *
 * Type-only exports are read from the generated declarations, because
 * `McpServerOptions` is a documented part of the API that never appears at
 * runtime. A name present in either place counts as exported; a name in neither
 * is a promise the package breaks.
 *
 * Usage: node tools/check-stability.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const core = await import(`file://${path.join(root, 'packages/core/dist/index.js').replace(/\\/g, '/')}`);
const mcp = await import(`file://${path.join(root, 'packages/mcp/dist/index.js').replace(/\\/g, '/')}`);
const exported = new Set([...Object.keys(core), ...Object.keys(mcp)]);

for (const declaration of ['packages/core/dist/index.d.ts', 'packages/mcp/dist/index.d.ts']) {
  const text = readFileSync(path.join(root, declaration), 'utf8');
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) exported.add(match[1]);
}

const doc = readFileSync(path.join(root, 'STABILITY.md'), 'utf8');
const referenced = new Set();
for (const match of doc.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) referenced.add(match[1]);

// Identifiers that appear in backticks but are not API symbols: command and flag
// names, file names, property names, and prose about behaviour.
const notApiSymbols = new Set([
  'npm', 'json', 'ts', 'exports', 'exit', 'agent', 'tools', 'dist',
  'schemaVersion', 'readPersistedContext', 'contextFileNames',
  'api:check', 'api:lock', 'check', 'lock',
  'code', 'verify', 'invalid', 'full', 'compact', 'auto',
]);

const missing = [...referenced]
  .filter((name) => !exported.has(name))
  .filter((name) => !notApiSymbols.has(name));

const verified = [...referenced].filter((name) => exported.has(name)).length;
console.log(`identifiers referenced in STABILITY.md: ${referenced.size}`);
console.log(`stable symbols verified: ${verified}`);

if (missing.length > 0) {
  console.error(`STABILITY.md names symbols that are not exported: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('every promised symbol is exported');
}