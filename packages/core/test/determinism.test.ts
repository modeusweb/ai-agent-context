/**
 * Determinism test: the same repository state must always produce the same
 * canonical `.agent/` bytes, independently of timing, environment or mtime.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AgentContext, CONTEXT_FILES } from '../dist/index.js';
import { cleanupTemp, createTempRepo } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z').getTime();

async function scanDeterministically(fixture: string): Promise<{ root: string; contents: Record<string, string> }> {
  const root = createTempRepo(fixture, { git: true });
  tempRoots.push(root);
  const context = await AgentContext.load({ root, now: () => FIXED_NOW });
  await context.scan();
  const contents: Record<string, string> = {};
  for (const name of CONTEXT_FILES) {
    contents[name] = readFileSync(path.join(root, '.agent', name), 'utf8');
  }
  return { root, contents };
}

describe('determinism', () => {
  for (const fixture of ['simple-ts', 'layered-app', 'monorepo']) {
    test(`repeated scans of ${fixture} produce identical canonical context`, async () => {
      const first = await scanDeterministically(fixture);
      const second = await scanDeterministically(fixture);
      assert.deepEqual(Object.keys(second.contents), Object.keys(first.contents));
      for (const name of Object.keys(first.contents)) {
        assert.equal(second.contents[name], first.contents[name], `${fixture}: ${name} must be byte-identical`);
      }
    });
  }

  test('generated context has no timestamps by default', async () => {
    const { contents } = await scanDeterministically('simple-ts');
    assert.equal(contents['index.json'].includes('generatedAt'), false);
    assert.ok(contents['index.json'].includes('"schemaVersion": 1'));
    assert.ok(contents['index.json'].includes('ai-agent-context'));
  });

  test('all context documents carry the schema version and generator name', async () => {
    const { contents } = await scanDeterministically('layered-app');
    for (const name of ['architecture.json', 'dependencies.json', 'conventions.json', 'decisions.json']) {
      assert.ok(contents[name].includes('"schemaVersion": 1'), `${name} must be versioned`);
      assert.ok(contents[name].includes('"generatedBy"'), `${name} must record the generator`);
    }
  });
});
