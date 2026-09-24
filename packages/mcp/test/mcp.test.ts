/**
 * MCP adapter tests: the adapter is a thin layer over the core API, so the tests
 * call the tool dispatcher directly with a pre-scanned fixture repository.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../../core/dist/index.js';
import { TOOL_DEFINITIONS, toolByName, callTool, ContextPool } from '../../mcp/dist/index.js';
import { cleanupTemp, createTempRepo } from '../../core/test/helpers.ts';


const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

async function setup() {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  const context = await AgentContext.load({ root });
  await context.scan();
  const pool = new ContextPool({ root });
  return { root, context, pool };
}

describe('mcp tool definitions', () => {
  test('exposes the ten documented tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'explain_module',
      'get_architecture',
      'get_change_impact',
      'get_context_for_task',
      'get_conventions',
      'get_decisions',
      'get_dependencies',
      'get_dependents',
      'get_repository_context',
      'search_context',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(toolByName(tool.name), 'every tool must be resolvable by name');
    }
  });
});

describe('mcp tool handlers', () => {
  test('get_repository_context returns a compact agent context', async () => {
    const { root, pool } = await setup();
    const result = await callTool('get_repository_context', {}, pool, root);
    assert.equal(result.isError, false);
    const payload = result.payload as { repository?: { name?: string }; commands?: unknown };
    assert.ok(payload.repository !== undefined);
  });

  test('get_repository_context accepts compact limits', async () => {
    const { root, pool } = await setup();
    const result = await callTool(
      'get_repository_context',
      { maxModules: 1, maxEntryPoints: 1, maxExternalDependencies: 1, maxConventions: 1, maxDecisions: 1, maxCycles: 0 },
      pool,
      root,
    );
    assert.equal(result.isError, false);
    const payload = result.payload as { modules: unknown[]; entryPoints: unknown[]; cycles: unknown[] };
    assert.ok(payload.modules.length <= 1);
    assert.ok(payload.entryPoints.length <= 1);
    assert.ok(payload.cycles.length <= 0);
  });

  test('explain_module returns structured module context', async () => {
    const { root, pool } = await setup();
    const result = await callTool('explain_module', { path: 'src/models' }, pool, root);
    assert.equal(result.isError, false);
    const payload = result.payload as { module: { id: string }; summary: string };
    assert.ok(payload.module.id.length > 0);
    assert.ok(payload.summary.length > 0);
  });


  test('explain_module reports a helpful error for unknown paths', async () => {
    const { root, pool } = await setup();
    const result = await callTool('explain_module', { path: 'does/not/exist' }, pool, root);
    assert.equal(result.isError, true);
    assert.ok(String((result.payload as { error: string }).error).includes('does/not/exist'));
  });

  test('get_dependencies and get_dependents are consistent', async () => {
    const { root, pool } = await setup();
    const deps = await callTool('get_dependencies', {}, pool, root);
    assert.equal(deps.isError, false);
    const dependents = await callTool('get_dependents', { module: 'src' }, pool, root);
    assert.equal(dependents.isError, false);
    const payload = dependents.payload as { module: string; direct: unknown[] };
    assert.equal(payload.module, 'src');
    assert.ok(Array.isArray(payload.direct));

  });

  test('task context is bounded and evidence-backed', async () => {
    const { root } = await setup();
    const context = await AgentContext.load({ root });
    const result = await context.getTaskContext('format user name', { target: 'src/models', maxModules: 2 });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.task, 'format user name');
    assert.equal(result.target, 'src/models');
    assert.ok(result.modules.length <= 2);
    assert.ok(result.modules.every((module) => module.id.length > 0));
  });

  test('change impact returns bounded affected files and evidence', async () => {
    const { root } = await setup();
    const context = await AgentContext.load({ root });
    const result = await context.getChangeImpact('src/models', { maxFiles: 2 });
    assert.equal(result.target, 'src/models');
    assert.ok(result.files.length <= 2);
    assert.ok(result.evidence.length > 0);
    assert.equal(typeof result.truncated, 'boolean');
  });

  test('search_context returns ranked results', async () => {
    const { root, pool } = await setup();
    const result = await callTool('search_context', { query: 'format user name', limit: 5 }, pool, root);
    assert.equal(result.isError, false);
    const payload = result.payload as { query: string; results: Array<{ id: string; score: number }> };
    assert.equal(payload.query, 'format user name');
    assert.ok(payload.results.length > 0);
    assert.ok(payload.results[0].score >= 0);
  });

  test('get_architecture, get_conventions and get_decisions return documents', async () => {
    const { root, pool } = await setup();
    const architecture = await callTool('get_architecture', {}, pool, root);
    assert.equal(architecture.isError, false);
    assert.ok((architecture.payload as { modules: unknown[] }).modules.length > 0);

    const conventions = await callTool('get_conventions', {}, pool, root);
    assert.equal(conventions.isError, false);
    assert.ok(((conventions.payload as { conventions: unknown[] }).conventions as unknown[]).length > 0);

    const decisions = await callTool('get_decisions', {}, pool, root);
    assert.equal(decisions.isError, false);
    assert.ok(typeof (decisions.payload as { total: number }).total === 'number');
  });

  test('unknown tools and missing arguments produce actionable errors', async () => {
    const { root, pool } = await setup();
    const unknown = await callTool('no_such_tool', {}, pool, root);
    assert.equal(unknown.isError, true);
    const missing = await callTool('explain_module', {}, pool, root);
    assert.equal(missing.isError, true);
    assert.ok(String((missing.payload as { error: string }).error).includes('path'));
  });

  test('context pool caches AgentContext instances per root', async () => {
    const { root, context, pool } = await setup();
    const first = await pool.get(root);
    const second = await pool.get(root);
    assert.equal(first, second);
    assert.ok(context instanceof AgentContext);
  });
});
