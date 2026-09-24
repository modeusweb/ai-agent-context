/**
 * Repository level context projection.
 *
 * This is what an MCP client (or `explain` without a target) receives: a compact,
 * structured overview — what the repository is, how it is organized, which modules
 * matter, what is imported from outside, which commands exist, where documented
 * decisions live. It summarises the graph; `explain` and `search` drill down.
 */
import type { ContextCommand, RepositoryContextOptions, RepositoryContextPayload } from './types.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { compareStrings } from '../../model/canonical.ts';
import { GENERATOR_NAME, SCHEMA_VERSION } from '../../model/schema.ts';

const COMMAND_PATTERN = /^(start|dev|serve|build|test|lint|typecheck|check|format|migrate|seed|generate|clean)$/;
const COMMAND_ORDER = ['start', 'dev', 'build', 'test', 'lint', 'typecheck', 'format'];

/** Collects the runnable commands declared by the repository (documented facts). */
export function collectCommands(graph: KnowledgeGraph): ContextCommand[] {
  const commands: ContextCommand[] = [];
  const manager =
    graph.repository.workspace.packageManager === 'unknown' ? 'npm' : graph.repository.workspace.packageManager;
  for (const entry of [...graph.repository.workspace.packages].sort((a, b) => compareStrings(a.path, b.path))) {
    for (const [name, script] of Object.entries(entry.scripts).sort((a, b) => compareStrings(a[0], b[0]))) {
      if (!COMMAND_PATTERN.test(name) && !name.startsWith('test:')) continue;
      commands.push({
        name,
        command: `${manager} run ${name}${entry.path.length > 0 ? ` --workspace ${entry.name}` : ''}`,
        script,
        scope: entry.path.length === 0 ? 'root' : entry.name,
      });
    }
  }
  return commands.sort((a, b) => {
    const indexA = COMMAND_ORDER.indexOf(a.name);
    const indexB = COMMAND_ORDER.indexOf(b.name);
    const rankA = indexA === -1 ? COMMAND_ORDER.length : indexA;
    const rankB = indexB === -1 ? COMMAND_ORDER.length : indexB;
    if (rankA !== rankB) return rankA - rankB;
    return compareStrings(`${a.scope}|${a.name}`, `${b.scope}|${b.name}`);
  });
}
/** Builds the repository context payload. */
export function buildRepositoryContext(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
  options: RepositoryContextOptions = {},
): RepositoryContextPayload {
  const repository = graph.repository;
  const maxModules = Math.max(1, Math.min(options.maxModules ?? 25, 100));
  const maxEntryPoints = Math.max(1, Math.min(options.maxEntryPoints ?? 30, 200));
  const maxExternalDependencies = Math.max(1, Math.min(options.maxExternalDependencies ?? 25, 200));
  const maxConventions = Math.max(1, Math.min(options.maxConventions ?? 25, 200));
  const maxDecisions = Math.max(1, Math.min(options.maxDecisions ?? 25, 200));
  const maxCycles = Math.max(0, Math.min(options.maxCycles ?? 25, 200));
  const modulesByImportance = [...repository.modules]
    .sort((a, b) => {
      const scoreA = a.usedBy.length * 10 + a.files.length;
      const scoreB = b.usedBy.length * 10 + b.files.length;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return compareStrings(a.id, b.id);
    })
    .slice(0, maxModules);

  const entryPoints = [...repository.entryPoints]
    .sort((a, b) => (b.confidence === a.confidence ? compareStrings(a.path, b.path) : b.confidence - a.confidence))
    .slice(0, maxEntryPoints);

  const importanceRank = { infrastructure: 3, framework: 2, tooling: 1, utility: 0 } as const;
  const externalDependencies = [...repository.externalDependencies]
    .sort((a, b) => {
      const rankA = importanceRank[a.importance.value] * 1000 + a.importedByModules;
      const rankB = importanceRank[b.importance.value] * 1000 + b.importedByModules;
      if (rankA !== rankB) return rankB - rankA;
      return compareStrings(a.name, b.name);
    })
    .slice(0, maxExternalDependencies);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    repository: {
      name: repository.name,
      languages: repository.languages,
      fileCount: repository.files.length,
      sourceFileCount: repository.files.filter((file) => file.kind === 'source').length,
      testFileCount: repository.files.filter((file) => file.kind === 'test').length,
      moduleCount: repository.modules.length,
      symbolCount: repository.symbols.length,
      dependencyCount: repository.dependencies.length,
      entryPointCount: repository.entryPoints.length,
    },
    workspace: {
      isMonorepo: repository.workspace.isMonorepo,
      model: repository.workspace.workspaceModel,
      packageManager: repository.workspace.packageManager,
      packageManagerEvidence: repository.workspace.packageManagerEvidence,
      lockfiles: repository.workspace.lockfiles,
      packages: repository.workspace.packages.map((entry) => ({
        name: entry.name,
        path: entry.path,
        version: entry.version,
        private: entry.private,
        runtimeDependencies: entry.runtimeDependencies.length,
        developmentDependencies: entry.developmentDependencies.length,
      })),
    },
    commands: collectCommands(graph),
    modules: modulesByImportance.map((module) => ({
      id: module.id,
      path: module.path,
      basis: module.basis,
      files: module.files.length,
      roles: module.roles,
      dependsOn: module.dependsOn,
      usedBy: module.usedBy,
      entryPoints: module.entryPoints.map((entry) => entry.path).slice(0, 5),
      publicExports: module.publicExports.map((entry) => entry.name).slice(0, 10),
      git: module.git,
    })),
    entryPoints,
    externalDependencies,
    conventions: repository.conventions.slice(0, maxConventions).map((convention) => ({
      id: convention.id,
      category: convention.category,
      statement: convention.statement,
      confidence: convention.confidence,
    })),
    decisions: repository.decisions.slice(0, maxDecisions).map((decision) => ({
      id: decision.id,
      title: decision.title,
      status: decision.status,
      origin: decision.origin,
      source: decision.source,
    })),
    cycles: repository.cycles.slice(0, maxCycles),
    layeringViolations: [...repository.layeringViolations].sort((a, b) => compareStrings(`${a.from}|${a.to}|${a.kind}`, `${b.from}|${b.to}|${b.kind}`)),
    diagnostics: {
      parsedFiles: parsed.size,
      sensitiveSkipped: repository.files.filter((file) => file.sensitive).length,
      partialParses: repository.files
        .filter((file) => file.parseStatus === 'partial')
        .map((file) => file.path)
        .slice(0, 20),
      failedParses: repository.files
        .filter((file) => file.parseStatus === 'failed')
        .map((file) => file.path)
        .slice(0, 20),
      unresolvedImports: graph.unresolved.slice(0, 20),
    },
    notes: [
      'Roles carrying a confidence value are heuristics derived from file names, paths and import signals; they are not authoritative statements about the architecture.',
      'Conventions and decisions carry their evidence; entries with origin "inferred" were derived by heuristics rather than authored by humans.',
      'All analysis is local: no repository content leaves the machine and no LLM is involved.',
    ],
  };
}