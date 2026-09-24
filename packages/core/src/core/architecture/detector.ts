/**
 * Architecture orchestration.
 *
 * Attaches the detected entry points, roles and responsibilities to the graph.
 * Everything produced here is heuristic and carries confidence + evidence.
 */
import type { EntryPoint } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { compareStrings } from '../../model/canonical.ts';
import { detectEntryPoints } from './entry-points.ts';
import { detectModuleRoles, detectResponsibilities } from './role-detector.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';

export interface ArchitectureDetectionSummary {
  entryPoints: number;
  rolesDetected: number;
  modulesWithRoles: number;
  layeringViolations: number;
}

const LAYERING_RULES: ReadonlyArray<{ kind: import('../../model/types.ts').LayeringViolationKind; from: import('../../model/types.ts').ModuleRole; to: import('../../model/types.ts').ModuleRole }> = [
  { kind: 'domain-infrastructure', from: 'domain', to: 'infrastructure' },
  { kind: 'domain-adapter', from: 'domain', to: 'adapter' },
  { kind: 'application-ui', from: 'application', to: 'ui' },
  { kind: 'application-controller', from: 'application', to: 'controller' },
  { kind: 'infrastructure-ui', from: 'infrastructure', to: 'ui' },
];

/** Finds likely dependency-direction violations using detected roles and evidence. */
export function detectLayeringViolations(graph: KnowledgeGraph): import('../../model/types.ts').LayeringViolation[] {
  const modules = new Map(graph.repository.modules.map((module) => [module.id, module]));
  const violations: import('../../model/types.ts').LayeringViolation[] = [];
  for (const module of graph.repository.modules) {
    for (const dependencyId of module.dependsOn) {
      const dependency = modules.get(dependencyId);
      if (dependency === undefined) continue;
      for (const rule of LAYERING_RULES) {
        if (!module.roles.some((role) => role.value === rule.from) || !dependency.roles.some((role) => role.value === rule.to)) continue;
        violations.push({
          from: module.id,
          to: dependency.id,
          kind: rule.kind,
          confidence: 0.72,
          evidence: [
            { source: module.id, detail: `heuristic role ${rule.from} depends on ${rule.to}` },
            { source: dependency.id, detail: `target module is classified as ${rule.to}` },
          ],
        });
      }
    }
  }
  return violations.sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`));
}

/** Applies entry point, role and responsibility detection to the graph. */
export function applyArchitectureDetection(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
): ArchitectureDetectionSummary {
  const entryPoints = detectEntryPoints({
    workspace: graph.repository.workspace,
    files: graph.repository.files,
    parsed,
  });
  graph.repository.entryPoints = entryPoints;

  const entryPointsByModule = new Map<string, EntryPoint[]>();
  for (const entry of entryPoints) {
    if (entry.moduleId === null) continue;
    const list = entryPointsByModule.get(entry.moduleId) ?? [];
    list.push(entry);
    entryPointsByModule.set(entry.moduleId, list);
  }

  let rolesDetected = 0;
  let modulesWithRoles = 0;
  for (const module of graph.repository.modules) {
    module.entryPoints = (entryPointsByModule.get(module.id) ?? []).sort((a, b) =>
      a.path === b.path ? compareStrings(a.type, b.type) : compareStrings(a.path, b.path),
    );
    module.roles = detectModuleRoles({
      module,
      files: graph.repository.files,
      parsed,
      externalDependencies: graph.externalDependencies,
    });
    module.responsibilities = detectResponsibilities(module, parsed);
    rolesDetected += module.roles.length;
    if (module.roles.length > 0) modulesWithRoles += 1;
  }

  const violations = detectLayeringViolations(graph);
  graph.repository.layeringViolations = violations;
  return { entryPoints: entryPoints.length, rolesDetected, modulesWithRoles, layeringViolations: violations.length };
}