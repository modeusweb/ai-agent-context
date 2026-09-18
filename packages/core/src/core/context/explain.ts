/**
 * Context projection (`agent-context explain`).
 *
 * Goal: *maximum useful context with minimum irrelevant context*. For a target
 * path the projection returns the module's subgraph — entry points, dependencies,
 * dependents, external packages, public API, relevant conventions and decisions,
 * tests, git activity and the transitive impact set — instead of dumping the whole
 * repository.
 */
import type { Convention, Decision, ModuleExplanation, Relationship, SymbolKind } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import { compareStrings, uniqueSorted } from '../../model/canonical.ts';
import { isInside, normalizeRelative } from '../../util/paths.ts';

export interface ExplainInput {
  graph: KnowledgeGraph;
  parsed: Map<string, ParsedFile>;
  /** Module id, module directory, file path or workspace package name. */
  target: string;
  maxRelatedFiles?: number;
}

export interface ResolvedTarget {
  moduleId: string | null;
  filePath: string | null;
  matchedBy: string;
}

/** Resolves a human supplied path/id to a module (and, optionally, a file). */
export function resolveTarget(graph: KnowledgeGraph, rawTarget: string): ResolvedTarget | null {
  const target = normalizeRelative(rawTarget);
  if (target.length === 0) return null;

  const modules = graph.repository.modules;
  const exactModule = modules.find((module) => module.id === target);
  if (exactModule !== undefined) return { moduleId: exactModule.id, filePath: null, matchedBy: 'module id' };

  const fileModule = graph.fileToModule.get(target);
  if (fileModule !== undefined) return { moduleId: fileModule, filePath: target, matchedBy: 'file path' };

  const packageMatch = graph.repository.workspace.packages.find((entry) => entry.name === target);
  if (packageMatch !== undefined) {
    const module = modules.find((entry) => entry.id === packageMatch.name || entry.path === packageMatch.path);
    if (module !== undefined) return { moduleId: module.id, filePath: null, matchedBy: 'workspace package name' };
  }

  const containing = modules
    .filter((module) => module.path.length > 0 && isInside(module.path, target))
    .sort((a, b) => b.path.length - a.path.length);
  if (containing[0] !== undefined) return { moduleId: containing[0].id, filePath: null, matchedBy: 'module directory' };

  const byName = modules
    .filter((module) => module.name === target || module.id.endsWith(`/${target}`))
    .sort((a, b) => compareStrings(a.id, b.id));
  if (byName[0] !== undefined) return { moduleId: byName[0].id, filePath: null, matchedBy: 'module name' };

  const prefixMatches = modules
    .filter((module) => module.id.startsWith(target))
    .sort((a, b) => compareStrings(a.id, b.id));
  if (prefixMatches[0] !== undefined) {
    return { moduleId: prefixMatches[0].id, filePath: null, matchedBy: 'module id prefix' };
  }

  return null;
}

/** Counts the file-level edges that connect two modules. */
export function countEdgesBetween(
  graph: KnowledgeGraph,
  from: string,
  to: string,
): { relationships: Relationship[]; files: number } {
  const files = new Set<string>();
  const relationships = new Set<Relationship>();
  for (const edge of graph.fileEdges) {
    if (edge.fromKind !== 'file' || edge.toKind !== 'file') continue;
    if (graph.fileToModule.get(edge.from) !== from) continue;
    if (graph.fileToModule.get(edge.to) !== to) continue;
    files.add(edge.from);
    relationships.add(edge.relationship);
  }
  return { relationships: uniqueSorted(relationships) as Relationship[], files: files.size };
}

/** Breadth-first transitive dependents: what a change here would touch. */
export function transitiveDependents(graph: KnowledgeGraph, moduleId: string, depth = 3): string[] {
  const visited = new Set<string>();
  let frontier = [moduleId];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.moduleEdges) {
        if (edge.to !== current) continue;
        if (visited.has(edge.from) || edge.from === moduleId) continue;
        visited.add(edge.from);
        next.push(edge.from);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...visited].sort(compareStrings);
}

function relevantConventions(moduleFiles: readonly string[], conventions: readonly Convention[]): Convention[] {
  const files = new Set(moduleFiles);
  const scoped = conventions.filter((convention) =>
    convention.evidence.some((evidence) => files.has(evidence.source.split('#')[0] ?? evidence.source)),
  );
  const repositoryWide = conventions.filter(
    (convention) =>
      (convention.category === 'Toolchain' || convention.category === 'Imports') && !scoped.includes(convention),
  );
  return [...scoped, ...repositoryWide].slice(0, 6);
}

function relevantDecisions(moduleFiles: readonly string[], decisions: readonly Decision[]): Decision[] {
  const files = new Set(moduleFiles);
  const scoped = decisions.filter((decision) =>
    decision.evidence.some((evidence) => {
      const source = evidence.source.split('#')[0] ?? evidence.source;
      if (files.has(source)) return true;
      return source.length > 0 && [...files].some((file) => file.startsWith(`${source}/`));
    }),
  );
  const global = decisions.filter((decision) => decision.kind === 'config-signal' && !scoped.includes(decision));
  return [...scoped, ...global].slice(0, 5);
}

function buildSummary(graph: KnowledgeGraph, moduleId: string): string {
  const module = graph.repository.modules.find((entry) => entry.id === moduleId);
  if (module === undefined) return `No module found for "${moduleId}".`;
  const roleText =
    module.roles.length > 0
      ? ` Detected roles (heuristic): ${module.roles.map((role) => `${role.value} ${role.confidence.toFixed(2)}`).join(', ')}.`
      : ' No architectural role reached the confidence threshold.';
  return `${module.id} (${module.path || '<repository root>'}) — ${module.files.length} file(s), ${module.entryPoints.length} entry point(s), ${module.dependsOn.length} internal dependency/dependencies, used by ${module.usedBy.length} module(s).${roleText}`;
}

/** Produces the module explanation returned by `explain`. */
export function explainModule(input: ExplainInput): ModuleExplanation | null {
  const { graph, parsed } = input;
  const resolved = resolveTarget(graph, input.target);
  if (resolved === null || resolved.moduleId === null) return null;
  const module = graph.repository.modules.find((entry) => entry.id === resolved.moduleId);
  if (module === undefined) return null;

  const maxRelatedFiles = input.maxRelatedFiles ?? 25;
  const moduleFileSet = new Set(module.files);

  const dependsOn = module.dependsOn
    .map((dependencyId) => {
      const target = graph.repository.modules.find((entry) => entry.id === dependencyId);
      const counts = countEdgesBetween(graph, module.id, dependencyId);
      return {
        id: dependencyId,
        path: target?.path ?? dependencyId,
        relationships: counts.relationships.length > 0 ? counts.relationships : (['depends-on'] as Relationship[]),
        files: counts.files,
      };
    })
    .sort((a, b) => compareStrings(a.id, b.id));

  const usedBy = module.usedBy
    .map((dependentId) => {
      const source = graph.repository.modules.find((entry) => entry.id === dependentId);
      const counts = countEdgesBetween(graph, dependentId, module.id);
      return {
        id: dependentId,
        path: source?.path ?? dependentId,
        relationships: counts.relationships.length > 0 ? counts.relationships : (['used-by'] as Relationship[]),
        files: counts.files,
      };
    })
    .sort((a, b) => compareStrings(a.id, b.id));

  const externalCounts = new Map<string, number>();
  for (const edge of graph.fileEdges) {
    if (edge.fromKind !== 'file' || edge.toKind !== 'package') continue;
    if (!moduleFileSet.has(edge.from)) continue;
    externalCounts.set(edge.to, (externalCounts.get(edge.to) ?? 0) + 1);
  }
  const externalDependencies = [...externalCounts.entries()]
    .map(([name, count]) => {
      const entry = graph.repository.externalDependencies.find((candidate) => candidate.name === name);
      return {
        name,
        scope: entry?.scope ?? ('runtime' as const),
        importance:
          entry?.importance ??
          ({
            value: 'utility' as const,
            confidence: 0.3,
            evidence: [{ source: '<graph>', detail: `imported from ${count} file(s) of this module` }],
          }),
      };
    })
    .sort((a, b) =>
      b.importance.confidence === a.importance.confidence
        ? compareStrings(a.name, b.name)
        : b.importance.confidence - a.importance.confidence,
    );

  const publicApi = [...module.publicExports].sort((a, b) => compareStrings(a.name, b.name));
  const publicKeys = new Set(publicApi.map((entry) => `${entry.file}#${entry.name}`));
  const internalSymbols = graph.repository.symbols
    .filter((symbol) => moduleFileSet.has(symbol.file) && !publicKeys.has(symbol.id))
    .slice(0, 40)
    .map((symbol) => ({ name: symbol.name, kind: symbol.kind as SymbolKind, file: symbol.file }));

  const impactModules = transitiveDependents(graph, module.id);
  const impactFiles = uniqueSorted(
    graph.repository.modules.filter((entry) => impactModules.includes(entry.id)).flatMap((entry) => entry.files),
  );

  const targetNote =
    resolved.matchedBy === 'file path' && resolved.filePath !== null
      ? ` Target "${resolved.filePath}" was matched to this module by file path.`
      : '';

  return {
    module: {
      id: module.id,
      path: module.path,
      name: module.name,
      basis: module.basis,
      roles: module.roles,
      responsibilities: module.responsibilities,
    },
    summary: `${buildSummary(graph, module.id)}${targetNote}`,
    entryPoints: module.entryPoints,
    dependsOn,
    usedBy,
    externalDependencies,
    publicApi,
    internalSymbols,
    conventions: relevantConventions(module.files, graph.repository.conventions),
    decisions: relevantDecisions(module.files, graph.repository.decisions),
    tests: { files: module.testFiles, testCount: module.testFiles.length },
    git: module.git,
    impact: { modules: impactModules, files: impactFiles.slice(0, 100) },
    relatedFiles: module.files.slice(0, maxRelatedFiles),
    warnings: parsed.size === 0 ? [{ code: 'WARN_NO_PARSED_FILES', severity: 'info', message: 'no parsed files available' }] : [],
  };
}