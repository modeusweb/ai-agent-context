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

  return { entryPoints: entryPoints.length, rolesDetected, modulesWithRoles };
}