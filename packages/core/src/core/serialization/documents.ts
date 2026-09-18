/**
 * Builders for the canonical `.agent/` documents.
 *
 * Determinism rules: arrays are sorted by stable keys, absolute paths never leak
 * into the output, and timestamps are optional (`output.includeTimestamp`).
 */
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { AgentContextConfig } from '../../config/types.ts';
import { compareStrings, uniqueSorted } from '../../model/canonical.ts';
import { GENERATOR_NAME, SCHEMA_VERSION } from '../../model/schema.ts';
import { renderConventionsMarkdown } from '../conventions/renderer.ts';
import type {
  ArchitectureDocument,
  ArchitectureModule,
  ContextDocuments,
  DecisionsDocument,
  DependenciesDocument,
  DocumentBuildOptions,
  IndexDocument,
  ConventionsDocument,
} from './types.ts';

function withTimestamp<T extends object>(document: T, options: DocumentBuildOptions): T {
  return options.generatedAt === undefined ? document : { ...document, generatedAt: options.generatedAt };
}

/** Builds the `index.json` manifest. */
export function buildIndexDocument(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
  config: AgentContextConfig,
  options: DocumentBuildOptions,
): IndexDocument {
  const files = graph.repository.files;
  const countKind = (kind: string): number => files.filter((file) => file.kind === kind).length;
  const document: IndexDocument = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    repository: {
      name: graph.repository.name,
      rootName: graph.repository.name,
      packageManager: graph.repository.workspace.packageManager,
      workspaceModel: graph.repository.workspace.workspaceModel,
      isMonorepo: graph.repository.workspace.isMonorepo,
      languages: graph.repository.languages,
      counts: {
        files: files.length,
        source: countKind('source'),
        tests: countKind('test'),
        config: countKind('config'),
        docs: countKind('docs'),
        assets: countKind('asset'),
        modules: graph.repository.modules.length,
        symbols: graph.repository.symbols.length,
        dependencies: graph.repository.dependencies.length,
        entryPoints: graph.repository.entryPoints.length,
        conventions: graph.repository.conventions.length,
        decisions: graph.repository.decisions.length,
        externalDependencies: graph.repository.externalDependencies.length,
      },
    },
    files: {
      entries: files
        .map((file) => ({
          path: file.path,
          hash: file.hash,
          language: file.language,
          kind: file.kind,
          module: file.moduleId,
        }))
        .sort((a, b) => compareStrings(a.path, b.path)),
      sensitiveSkipped: files.filter((file) => file.sensitive).map((file) => file.path).sort(compareStrings),
    },
    context: {
      architecture: 'architecture.json',
      dependencies: 'dependencies.json',
      conventions: 'conventions.json',
      conventionsMarkdown: 'conventions.md',
      decisions: 'decisions.json',
    },
    git: config.features.git
      ? { enabled: true, windowDays: config.analysis.git.windowDays, commitsAnalyzed: options.commitsAnalyzed }
      : null,
    diagnostics: options.diagnostics.sort((a, b) => compareStrings(`${a.code}|${a.source ?? ''}`, `${b.code}|${b.source ?? ''}`)),
  };
  void parsed;
  return withTimestamp(document, options);
}

/** Builds `architecture.json`. */
export function buildArchitectureDocument(
  graph: KnowledgeGraph,
  config: AgentContextConfig,
  options: DocumentBuildOptions,
): ArchitectureDocument {
  const repository = graph.repository;
  const modules: ArchitectureModule[] = repository.modules
    .map((module) => ({
      id: module.id,
      path: module.path,
      name: module.name,
      basis: module.basis,
      packageName: module.packageName,
      isWorkspacePackage: module.isWorkspacePackage,
      roles: module.roles,
      responsibilities: module.responsibilities,
      entryPoints: module.entryPoints.map((entry) => entry.path).sort(compareStrings),
      dependsOn: [...module.dependsOn].sort(compareStrings),
      usedBy: [...module.usedBy].sort(compareStrings),
      publicExports: module.publicExports.map((entry) => ({ name: entry.name, kind: entry.kind, file: entry.file })),
      boundaries: module.boundaries,
      files: module.files.length,
      fileList: [...module.files].sort(compareStrings),
      testFiles: [...module.testFiles].sort(compareStrings),
      signals: [...module.signals].sort(compareStrings),
      git: module.git,
    }))
    .sort((a, b) => compareStrings(a.id, b.id));

  const document: ArchitectureDocument = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    summary: {
      modules: modules.length,
      workspacePackages: repository.workspace.packages.length,
      entryPoints: repository.entryPoints.length,
      rolesDetected: modules.reduce((sum, module) => sum + module.roles.length, 0),
      cycles: repository.cycles.length,
    },
    workspace: {
      packageManager: repository.workspace.packageManager,
      workspaceModel: repository.workspace.workspaceModel,
      workspaceGlobs: repository.workspace.workspaceGlobs,
      packageManagerEvidence: repository.workspace.packageManagerEvidence,
      packages: repository.workspace.packages.map((entry) => ({
        name: entry.name,
        path: entry.path,
        private: entry.private,
        version: entry.version,
        entries: entry.entries.length,
      })),
    },
    entryPoints: [...repository.entryPoints].sort((a, b) =>
      a.path === b.path ? compareStrings(a.type, b.type) : compareStrings(a.path, b.path),
    ),
    modules,
  };
  void config;
  return withTimestamp(document, options);
}

const MAX_FILE_IMPORTS = 400;

/** Builds `dependencies.json` (module edges, external packages, per-file imports). */
export function buildDependenciesDocument(
  graph: KnowledgeGraph,
  config: AgentContextConfig,
  options: DocumentBuildOptions,
): DependenciesDocument {
  const perFile = new Map<string, { module: string | null; internal: Set<string>; external: Set<string> }>();
  for (const file of graph.repository.files) {
    if (file.sensitive) continue;
    perFile.set(file.path, { module: file.moduleId, internal: new Set(), external: new Set() });
  }

  for (const edge of graph.fileEdges) {
    const entry = perFile.get(edge.from);
    if (entry === undefined) continue;
    if (edge.kind === 'internal-module') {
      entry.internal.add(edge.to);
      continue;
    }
    if (edge.kind === 'workspace-package') {
      entry.internal.add(edge.to);
      continue;
    }
    if (edge.toKind === 'file') {
      const targetModule = graph.fileToModule.get(edge.to) ?? null;
      if (targetModule !== null && targetModule !== entry.module) entry.internal.add(targetModule);
      continue;
    }
    if (edge.toKind === 'package') entry.external.add(edge.to);
  }

  const fileImports = [...perFile.entries()]
    .map(([file, entry]) => ({
      file,
      module: entry.module,
      internalModules: uniqueSorted(entry.internal),
      externalPackages: uniqueSorted(entry.external),
    }))
    .filter((entry) => entry.internalModules.length > 0 || entry.externalPackages.length > 0)
    .sort((a, b) => compareStrings(a.file, b.file))
    .slice(0, MAX_FILE_IMPORTS);

  const internal = graph.moduleEdges
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: (edge.kind === 'workspace-package' ? 'workspace-package' : 'internal-module') as
        | 'internal-module'
        | 'workspace-package',
      confidence: edge.confidence,
      evidence: edge.evidence,
    }))
    .sort((a, b) => compareStrings(`${a.from}|${a.to}`, `${b.from}|${b.to}`));

  const document: DependenciesDocument = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    summary: {
      internalModuleEdges: internal.length,
      crossPackageEdges: internal.filter((edge) => edge.kind === 'workspace-package').length,
      externalPackages: graph.externalDependencies.length,
      unresolvedImports: graph.unresolved.length,
      cycles: graph.cycles.length,
    },
    internal,
    external: [...graph.externalDependencies].sort((a, b) => compareStrings(a.name, b.name)),
    fileImports,
    cycles: graph.cycles,
    unresolved: graph.unresolved,
  };
  void config;
  return withTimestamp(document, options);
}

/** Builds `conventions.json` and the human readable `conventions.md` projection. */
export function buildConventionsDocuments(
  graph: KnowledgeGraph,
  config: AgentContextConfig,
  options: DocumentBuildOptions,
): { document: ConventionsDocument; markdown: string } {
  const document: ConventionsDocument = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    conventions: [...graph.repository.conventions].sort((a, b) =>
      a.category === b.category ? compareStrings(a.statement, b.statement) : compareStrings(a.category, b.category),
    ),
  };
  const timestamped = withTimestamp(document, options);
  const markdownMeta: { repositoryName: string; generatedAt?: string } = { repositoryName: graph.repository.name };
  if (config.output.includeTimestamp && options.generatedAt !== undefined) {
    markdownMeta.generatedAt = options.generatedAt;
  }
  return {
    document: timestamped,
    markdown: renderConventionsMarkdown(timestamped.conventions, markdownMeta),
  };
}

/** Builds `decisions.json`. */
export function buildDecisionsDocument(
  graph: KnowledgeGraph,
  options: DocumentBuildOptions,
): DecisionsDocument {
  const document: DecisionsDocument = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATOR_NAME,
    decisions: [...graph.repository.decisions].sort((a, b) =>
      a.origin === b.origin ? compareStrings(a.id, b.id) : a.origin === 'explicit' ? -1 : 1,
    ),
  };
  return withTimestamp(document, options);
}

/** Builds every canonical document in one pass. */
export function buildContextDocuments(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
  config: AgentContextConfig,
  options: DocumentBuildOptions,
): ContextDocuments {
  const conventions = buildConventionsDocuments(graph, config, options);
  return {
    index: buildIndexDocument(graph, parsed, config, options),
    architecture: buildArchitectureDocument(graph, config, options),
    dependencies: buildDependenciesDocument(graph, config, options),
    conventions: conventions.document,
    conventionsMarkdown: conventions.markdown,
    decisions: buildDecisionsDocument(graph, options),
  };
}