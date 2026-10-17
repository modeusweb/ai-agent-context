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
import { isInside, normalizeRelative, basename } from '../../util/paths.ts';
import { isNodeBuiltin } from '../graph/resolver.ts';

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
  /**
   * Directory the answer should be scoped to when it is narrower than
   * `moduleId`. Set when the target is a real directory of analyzed files that
   * module detection did not promote to a module of its own.
   */
  scopeDirectory: string | null;
}

/** Files of the analyzed repository that live under `directory`. */
function filesUnderDirectory(graph: KnowledgeGraph, directory: string): string[] {
  const files: string[] = [];
  for (const module of graph.repository.modules) {
    for (const file of module.files) {
      if (isInside(directory, file)) files.push(file);
    }
  }
  return files.sort(compareStrings);
}

/** Resolves a human supplied path/id to a module (and, optionally, a file). */
export function resolveTarget(graph: KnowledgeGraph, rawTarget: string): ResolvedTarget | null {
  const target = normalizeRelative(rawTarget);
  if (target.length === 0) return null;

  const modules = graph.repository.modules;
  const exactModule = modules.find((module) => module.id === target);
  if (exactModule !== undefined) {
    return { moduleId: exactModule.id, filePath: null, matchedBy: 'module id', scopeDirectory: null };
  }

  const fileModule = graph.fileToModule.get(target);
  if (fileModule !== undefined) {
    return { moduleId: fileModule, filePath: target, matchedBy: 'file path', scopeDirectory: null };
  }

  const packageMatch = graph.repository.workspace.packages.find((entry) => entry.name === target);
  if (packageMatch !== undefined) {
    const module = modules.find((entry) => entry.id === packageMatch.name || entry.path === packageMatch.path);
    if (module !== undefined) {
      return { moduleId: module.id, filePath: null, matchedBy: 'workspace package name', scopeDirectory: null };
    }
  }

  const byName = modules
    .filter((module) => module.name === target || module.id.endsWith(`/${target}`))
    .sort((a, b) => compareStrings(a.id, b.id));
  if (byName[0] !== undefined) {
    return { moduleId: byName[0].id, filePath: null, matchedBy: 'module name', scopeDirectory: null };
  }

  // A directory of analyzed files that module detection did not promote (it sits
  // deeper than `analysis.moduleDepth`, or holds a single file). Answering with
  // the enclosing module instead would silently hand back a much wider slice of
  // the repository than the caller asked for, so scope to the directory.
  const scopedFiles = filesUnderDirectory(graph, target);
  if (scopedFiles.length > 0) {
    const owningModuleId = graph.fileToModule.get(scopedFiles[0]!) ?? null;
    if (owningModuleId !== null) {
      return { moduleId: owningModuleId, filePath: null, matchedBy: 'directory scope', scopeDirectory: target };
    }
  }

  const containing = modules
    .filter((module) => module.path.length > 0 && isInside(module.path, target))
    .sort((a, b) => b.path.length - a.path.length);
  if (containing[0] !== undefined) {
    return { moduleId: containing[0].id, filePath: null, matchedBy: 'module directory', scopeDirectory: null };
  }

  const prefixMatches = modules
    .filter((module) => module.id.startsWith(target))
    .sort((a, b) => compareStrings(a.id, b.id));
  if (prefixMatches[0] !== undefined) {
    return { moduleId: prefixMatches[0].id, filePath: null, matchedBy: 'module id prefix', scopeDirectory: null };
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

/**
 * Breadth-first transitive dependents: what a change here would touch.
 *
 * Without `scopeFiles` this is the module dependency graph. With it, the answer
 * is scoped to the given files: the first hop is the modules that import those
 * files, and the walk continues from there. The owning module is excluded — a
 * change inside a directory does not by itself break everything that imports
 * the rest of the module.
 */
export function transitiveDependents(
  graph: KnowledgeGraph,
  moduleId: string,
  depth = 3,
  scopeFiles: ReadonlySet<string> | null = null,
): string[] {
  if (scopeFiles !== null) {
    const direct = dependenciesOfScope(graph, scopeFiles, 'incoming')
      .map((entry) => entry.id)
      .filter((id) => id !== moduleId);
    const visited = new Set<string>();
    let frontier = direct;
    for (const id of direct) visited.add(id);
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

function buildSummary(graph: KnowledgeGraph, moduleId: string, fileCount?: number): string {
  const module = graph.repository.modules.find((entry) => entry.id === moduleId);
  if (module === undefined) return `No module found for "${moduleId}".`;
  const roleText =
    module.roles.length > 0
      ? ` Detected roles (heuristic): ${module.roles.map((role) => `${role.value} ${role.confidence.toFixed(2)}`).join(', ')}.`
      : ' No architectural role reached the confidence threshold.';
  const files = fileCount ?? module.files.length;
  return `${module.id} (${module.path || '<repository root>'}) — ${files} file(s), ${module.entryPoints.length} entry point(s), ${module.dependsOn.length} internal dependency/dependencies, used by ${module.usedBy.length} module(s).${roleText}`;
}

/** Module-level dependencies reachable from a set of source files. */
function dependenciesOfScope(
  graph: KnowledgeGraph,
  scopeFiles: ReadonlySet<string>,
  direction: 'outgoing' | 'incoming',
): Array<{ id: string; relationships: Relationship[]; files: number }> {
  const relationships = new Map<string, Set<Relationship>>();
  const files = new Map<string, Set<string>>();
  for (const edge of graph.fileEdges) {
    if (edge.fromKind !== 'file' || edge.toKind !== 'file') continue;
    const from = graph.fileToModule.get(edge.from);
    const to = graph.fileToModule.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const matches =
      direction === 'outgoing'
        ? scopeFiles.has(edge.from)
        : scopeFiles.has(edge.to);
    if (!matches) continue;
    const otherId = direction === 'outgoing' ? to : from;
    const pair = direction === 'outgoing' ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    relationships.set(otherId, (relationships.get(otherId) ?? new Set()).add(edge.relationship));
    files.set(otherId, (files.get(otherId) ?? new Set()).add(pair));
  }
  return [...relationships.entries()]
    .map(([id, values]) => ({
      id,
      relationships: uniqueSorted(values) as Relationship[],
      files: files.get(id)?.size ?? 0,
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
}

/** Produces the module explanation returned by `explain`. */
export function explainModule(input: ExplainInput): ModuleExplanation | null {
  const { graph, parsed } = input;
  const resolved = resolveTarget(graph, input.target);
  if (resolved === null || resolved.moduleId === null) return null;
  const module = graph.repository.modules.find((entry) => entry.id === resolved.moduleId);
  if (module === undefined) return null;

  const maxRelatedFiles = input.maxRelatedFiles ?? 25;
  const isScoped = resolved.scopeDirectory !== null;
  const scopeFiles = isScoped ? filesUnderDirectory(graph, resolved.scopeDirectory!) : module.files;
  const moduleFileSet = new Set(scopeFiles);

  const scopeDependsOn = isScoped ? dependenciesOfScope(graph, moduleFileSet, 'outgoing') : null;
  const scopeUsedBy = isScoped ? dependenciesOfScope(graph, moduleFileSet, 'incoming') : null;

  const dependsOn = (scopeDependsOn ?? module.dependsOn.map((id) => ({ id, relationships: null, files: null })))
    .map((entry) => {
      const target = graph.repository.modules.find((candidate) => candidate.id === entry.id);
      const counts = entry.files === null ? countEdgesBetween(graph, module.id, entry.id) : null;
      const relationships =
        entry.relationships ??
        (counts !== null && counts.relationships.length > 0 ? counts.relationships : (['depends-on'] as Relationship[]));
      return {
        id: entry.id,
        path: target?.path ?? entry.id,
        relationships,
        files: counts === null ? (entry.files ?? 0) : counts.files,
      };
    })
    .sort((a, b) => compareStrings(a.id, b.id));

  const usedBy = (scopeUsedBy ?? module.usedBy.map((id) => ({ id, relationships: null, files: null })))
    .map((entry) => {
      const source = graph.repository.modules.find((candidate) => candidate.id === entry.id);
      const counts = entry.files === null ? countEdgesBetween(graph, entry.id, module.id) : null;
      const relationships =
        entry.relationships ??
        (counts !== null && counts.relationships.length > 0 ? counts.relationships : (['used-by'] as Relationship[]));
      return {
        id: entry.id,
        path: source?.path ?? entry.id,
        relationships,
        files: counts === null ? (entry.files ?? 0) : counts.files,
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
        count,
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
    // Platform built-ins rank below declared packages; see buildRepositoryContext.
    .sort((a, b) => {
      const platformA = isNodeBuiltin(a.name) ? -1 : 0;
      const platformB = isNodeBuiltin(b.name) ? -1 : 0;
      if (platformA !== platformB) return platformB - platformA;
      if (b.importance.confidence !== a.importance.confidence) {
        return b.importance.confidence - a.importance.confidence;
      }
      if (b.count !== a.count) return b.count - a.count;
      return compareStrings(a.name, b.name);
    })
    .map(({ name, scope, importance }) => ({ name, scope, importance }));

  const publicApi = module.publicExports
    .filter((entry) => !isScoped || moduleFileSet.has(entry.file))
    .sort((a, b) => compareStrings(a.name, b.name));
  const publicKeys = new Set(publicApi.map((entry) => `${entry.file}#${entry.name}`));
  const internalSymbols = graph.repository.symbols
    .filter((symbol) => moduleFileSet.has(symbol.file) && !publicKeys.has(symbol.id))
    .slice(0, 40)
    .map((symbol) => ({ name: symbol.name, kind: symbol.kind as SymbolKind, file: symbol.file }));

  const impactModules = transitiveDependents(graph, module.id, 3, isScoped ? moduleFileSet : null);
  // For a scoped directory the directly importing files are the actionable
  // answer; listing every file of an affected module would bury them.
  const impactFiles = isScoped
    ? uniqueSorted(
        graph.fileEdges
          .filter((edge) => edge.fromKind === 'file' && edge.toKind === 'file' && moduleFileSet.has(edge.to))
          .map((edge) => edge.from),
      )
    : uniqueSorted(
        graph.repository.modules.filter((entry) => impactModules.includes(entry.id)).flatMap((entry) => entry.files),
      );

  const entryPoints = isScoped
    ? module.entryPoints.filter((entry) => moduleFileSet.has(entry.path))
    : module.entryPoints;

  const scopedTestFiles = scopeFiles.filter((file) => {
    const node = graph.filesByPath.get(file);
    return node?.kind === 'test';
  });

  const targetNote =
    resolved.matchedBy === 'file path' && resolved.filePath !== null
      ? ` Target "${resolved.filePath}" was matched to this module by file path.`
      : resolved.matchedBy === 'directory scope' && resolved.scopeDirectory !== null
        ? ` Scope "${resolved.scopeDirectory}" is narrower than module "${module.id}"; this answer covers only the ${scopeFiles.length} file(s) inside it.`
        : '';

  return {
    module: {
      id: module.id,
      path: isScoped ? resolved.scopeDirectory! : module.path,
      name: isScoped ? basename(resolved.scopeDirectory!) || module.name : module.name,
      basis: module.basis,
      roles: module.roles,
      responsibilities: module.responsibilities,
    },
    summary: `${buildSummary(graph, module.id, scopeFiles.length)}${targetNote}`,
    entryPoints,
    dependsOn,
    usedBy,
    externalDependencies,
    publicApi,
    internalSymbols,
    conventions: relevantConventions(scopeFiles, graph.repository.conventions),
    decisions: relevantDecisions(scopeFiles, graph.repository.decisions),
    tests: { files: scopedTestFiles, testCount: scopedTestFiles.length },
    git: module.git,
    impact: { modules: impactModules, files: impactFiles.slice(0, 100) },
    relatedFiles: scopeFiles.slice(0, maxRelatedFiles),
    ...(isScoped
      ? { scope: { moduleId: module.id, directory: resolved.scopeDirectory!, fileCount: scopeFiles.length } }
      : {}),
    warnings: parsed.size === 0 ? [{ code: 'WARN_NO_PARSED_FILES', severity: 'info', message: 'no parsed files available' }] : [],
  };
}