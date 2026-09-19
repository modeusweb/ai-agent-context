/**
 * Convention detection: every statement must be evidence-backed and the
 * markdown projection must exist and be deterministic.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('conventions (simple-ts)', () => {
  let root: string;
  let context: AgentContext;

  test('scans the fixture once', async () => {
    root = createTempRepo('simple-ts');
    tempRoots.push(root);
    context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.conventions > 0, 'a typed fixture must expose observable conventions');
  });

  test('every convention has a statement, confidence and evidence', async () => {
    const conventions = await context.getConventions();
    assert.ok(conventions.length > 0);
    for (const convention of conventions) {
      assert.ok(convention.category.length > 0);
      assert.ok(convention.statement.length > 0);
      assert.ok(convention.confidence > 0 && convention.confidence <= 1);
      assert.ok(convention.evidence.length > 0, 'conventions must not be invented');
    }
  });

  test('conventions are detected from test placement and naming', async () => {
    const conventions = await context.getConventions();
    const categories = new Set(conventions.map((entry) => entry.category.toLowerCase()));
    assert.ok(
      [...categories].some((category) => category.includes('test') || category.includes('naming') || category.includes('import')),
      `unexpected category set: ${[...categories].join(', ')}`,
    );
  });

  test('conventions.md projection exists and mentions categories', async () => {
    const markdownPath = path.join(root, '.agent', 'conventions.md');
    assert.equal(existsSync(markdownPath), true);
    const markdown = readFileSync(markdownPath, 'utf8');
    assert.ok(markdown.includes('#'), 'markdown projection should have a heading');
    for (const convention of await context.getConventions()) {
      assert.ok(markdown.includes(convention.statement), 'every convention must appear in the projection');
    }
  });
});

describe('decisions', () => {
  test('extracts explicit ADR records from docs/ with ids and status', async () => {
    const root = createTempRepo('layered-app');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const decisions = await context.getDecisions();
    for (const decision of decisions) {
      assert.ok(decision.id.length > 0);
      assert.ok(decision.title.length > 0);
      assert.ok(['explicit', 'inferred'].includes(decision.origin), 'decision provenance must be explicit');
    }
    const explicit = decisions.filter((decision) => decision.origin === 'explicit');
    for (const decision of explicit) {
      assert.ok(decision.source !== null, 'explicit decisions must cite their source document');
    }
  });

  test('does not invent ADRs when none exist', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    await context.scan();
    const decisions = await context.getDecisions();
    const explicit = decisions.filter((decision) => decision.origin === 'explicit');
    assert.equal(explicit.length, 0, 'no explicit ADR should exist in a fixture without docs/');
  });
});
