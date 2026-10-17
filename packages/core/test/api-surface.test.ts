/**
 * Public API surface lock.
 *
 * The exported symbols of a package are a contract with its consumers, not an
 * accident of how the modules happen to be laid out. This test compares the real
 * exports against a checked-in lock so that adding, renaming or removing one is a
 * deliberate act in a diff, with the corresponding entry in `MIGRATION.md`.
 *
 * See STABILITY.md for what is promised, and for how much of the surface is
 * stable. The lock records *everything* that is exported, including the parts
 * that are not yet classified as stable, because a symbol can only be governed
 * once it is known to exist.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const PACKAGES = [
  { name: 'core', entry: path.join(repoRoot, 'packages/core/dist/index.js'), lock: path.join(repoRoot, 'packages/core/test/public-api.lock.json') },
  { name: 'cli', entry: path.join(repoRoot, 'packages/cli/dist/index.js'), lock: path.join(repoRoot, 'packages/cli/test/public-api.lock.json') },
  { name: 'mcp', entry: path.join(repoRoot, 'packages/mcp/dist/index.js'), lock: path.join(repoRoot, 'packages/mcp/test/public-api.lock.json') },
];

describe('public API surface', () => {
  for (const pkg of PACKAGES) {
    test(`${pkg.name} exports exactly what the lock records`, async () => {
      const locked = JSON.parse(readFileSync(pkg.lock, 'utf8')) as { package: string; exports: string[] };
      assert.equal(locked.package, pkg.name, 'lock file names the wrong package');

      const module = (await import(`file://${pkg.entry.replace(/\\/g, '/')}`)) as Record<string, unknown>;
      const actual = Object.keys(module).sort();

      const removed = locked.exports.filter((name) => !actual.includes(name));
      const added = actual.filter((name) => !locked.exports.includes(name));

      assert.deepEqual(
        removed,
        [],
        `${pkg.name} no longer exports: ${removed.join(', ')}. A removal is a breaking change (STABILITY.md); record it in MIGRATION.md, and run \`npm run api:lock\` after the deprecation window.`,
      );
      assert.deepEqual(
        added,
        [],
        `${pkg.name} newly exports: ${added.join(', ')}. Record the addition in MIGRATION.md, then run \`npm run api:lock\`.`,
      );
      assert.deepEqual(actual, [...locked.exports].sort(), `${pkg.name} export order or set changed`);
    });
  }

  test('the lock is sorted so a diff shows only real changes', async () => {
    for (const pkg of PACKAGES) {
      const locked = JSON.parse(readFileSync(pkg.lock, 'utf8')) as { exports: string[] };
      assert.deepEqual(
        locked.exports,
        [...locked.exports].sort(),
        `${pkg.name} lock must stay sorted`,
      );
    }
  });

  test('the documented stable surface is actually exported', async () => {
    // STABILITY.md names these as the stable entry points. If one disappears the
    // document is lying, and that is exactly the failure this test exists to
    // prevent.
    const core = (await import(`file://${PACKAGES[0]!.entry.replace(/\\/g, '/')}`)) as Record<string, unknown>;
    for (const symbol of [
      'AgentContext',
      'TOOL_VERSION',
      'SCHEMA_VERSION',
      'loadConfig',
      'validateConfig',
      'applyOverrides',
      'loadPolicy',
      'applyPolicy',
      'parsePolicy',
      'escapesRoot',
      'joinStrict',
      'AgentContextError',
      'ReadOnlyError',
      'ContextStateError',
    ]) {
      assert.ok(symbol in core, `STABILITY.md promises core.${symbol}, but it is not exported`);
    }

    const mcp = (await import(`file://${PACKAGES[2]!.entry.replace(/\\/g, '/')}`)) as Record<string, unknown>;
    for (const symbol of ['McpServer', 'createStdioTransport', 'SUPPORTED_PROTOCOL_VERSIONS', 'ErrorCode', 'TOOL_DEFINITIONS']) {
      assert.ok(symbol in mcp, `STABILITY.md promises mcp.${symbol}, but it is not exported`);
    }
  });
});