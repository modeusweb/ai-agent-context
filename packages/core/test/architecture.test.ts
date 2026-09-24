/**
 * Architecture detection: entry points, module roles, dependency symmetry.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../dist/index.js';
import { cleanupTemp, createTempRepo } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('architecture detection (layered-app)', () => {
  let context: AgentContext;

  test('loads and scans the fixture once', async () => {
    const root = createTempRepo('layered-app', { git: true });
    tempRoots.push(root);
    context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.entryPoints > 0);
    assert.ok(report.modules > 1);
  });

  test('every module has an id, path and at least one basis', async () => {
    const modules = await context.getModules();
    for (const module of modules) {
      assert.equal(typeof module.id, 'string');
      assert.ok(module.id.length > 0);
      assert.ok(module.files.length > 0);
      assert.ok(['workspace-package', 'index-file', 'directory', 'single-file'].includes(module.basis));
    }
  });


  test('heuristic roles always carry confidence below 1 and evidence', async () => {
    const modules = await context.getModules();
    const withRoles = modules.filter((module) => module.roles.length > 0);
    assert.ok(withRoles.length > 0, 'at least one role should be detected in a layered app');
    for (const module of withRoles) {
      for (const role of module.roles) {
        assert.ok(role.confidence < 1, 'heuristic role must never be a certain fact');
        assert.ok(role.confidence > 0);
        assert.ok(role.evidence.length > 0, 'every role must cite evidence');
      }
    }
  });

  test('module dependency graph is symmetric (dependsOn ↔ usedBy)', async () => {
    const modules = await context.getModules();
    for (const module of modules) {
      for (const dep of module.dependsOn) {
        const target = modules.find((candidate) => candidate.id === dep);
        if (target === undefined) continue; // workspace package ids may live outside the fixture
        assert.ok(
          target.usedBy.includes(module.id),
          `${module.id} depends on ${dep}, so ${dep} must list ${module.id} as usedBy`,
        );
      }
    }
  });

  test('layering diagnostics are explainable and deterministic', async () => {
    const architecture = await context.getArchitecture();
    assert.equal(typeof architecture.summary.layeringViolations, 'number');
    assert.ok(Array.isArray(architecture.layeringViolations));
    for (const violation of architecture.layeringViolations) {
      assert.ok(violation.confidence < 1);
      assert.ok(violation.evidence.length > 0);
    }
    const repository = await context.getRepository();
    assert.deepEqual(architecture.layeringViolations, repository.layeringViolations);
  });

  test('entry points are detected with types and confidence', async () => {
    const repository = await context.getRepository();
    assert.ok(repository.entryPoints.length > 0);
    for (const entry of repository.entryPoints) {
      assert.ok(entry.type.length > 0);
      assert.ok(entry.confidence > 0);
      assert.ok(entry.path.length > 0);
    }
  });

  test('external dependencies distinguish runtime and development scope', async () => {
    const dependencies = await context.getDependencies();
    assert.ok(dependencies.external.length > 0);
    for (const external of dependencies.external) {
      assert.ok(['runtime', 'development', 'peer'].includes(external.scope));
      assert.ok(external.importance.confidence <= 1);
    }
  });

  test('explain returns a projection for a module path', async () => {
    const modules = await context.getModules();
    assert.ok(modules.length > 0);
    const explanation = await context.explain('src');
    assert.ok(explanation, 'explain must resolve the source module');
    assert.ok(explanation.summary.length > 0);
    assert.ok(explanation.relatedFiles.length > 0);
    assert.ok(Array.isArray(explanation.publicApi));
    assert.ok(Array.isArray(explanation.warnings));
  });



  test('explain resolves a file to its owning module', async () => {
    const repository = await context.getRepository();
    const file = repository.files.find((entry) => entry.kind === 'source');
    assert.ok(file);
    const explanation = await context.explain(file.path);
    assert.ok(explanation);
    assert.ok(explanation.relatedFiles.includes(file.path) || explanation.module.path === file.path);

  });


});

describe('monorepo workspace detection', () => {
  test('detects workspace packages and their dependencies', async () => {
    const root = createTempRepo('monorepo');
    tempRoots.push(root);
    const context = await AgentContext.load({ root });
    const report = await context.scan();
    assert.ok(report.modules >= 2, 'a monorepo must produce multiple modules');
    const dependencies = await context.getDependencies();
    assert.ok(dependencies.internal.length > 0, 'cross-module edges must exist in a monorepo');
    const workspaceEdges = dependencies.internal.filter(
      (edge) => edge.evidence.some((item) => item.detail.includes('workspace package')),
    );
    assert.ok(workspaceEdges.length > 0, 'workspace dependencies must be distinguishable from internal ones');
  });


});
