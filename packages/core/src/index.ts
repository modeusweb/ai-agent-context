/**
 * `@ai-agent-context/core` — public API.
 *
 * The package is local-first, deterministic and dependency free: it analyses a
 * repository into a knowledge graph, persists a versionable `.agent/` context and
 * answers questions about architecture, dependencies, conventions and decisions.
 * No LLM and no network access are involved.
 */
export { AgentContext } from './agent-context.ts';
export type { AgentContextOptions, ScanOptions, StatusReport, InitResult } from './agent-context.ts';

export { runPipeline, detectWorkspaceFromScan, documentHash } from './pipeline/scan-pipeline.ts';
export type { PipelineOptions, PipelineResult } from './pipeline/scan-pipeline.ts';

/* Model */
export * from './model/types.ts';
export {
  SCHEMA_VERSION,
  GENERATOR_NAME,
  AGENT_DIR,
  LOCAL_DIR,
  CONFIG_FILE,
  STATE_FILE,
  CONTEXT_FILES,
  CONFIDENCE,
} from './model/schema.ts';
export {
  canonicalize,
  stringifyCanonical,
  hashValue,
  sha256,
  shortHash,
  compareStrings,
  sortBy,
  uniqueSorted,
  clampConfidence,
} from './model/canonical.ts';

/* Errors */
export {
  AgentContextError,
  ConfigError,
  AnalysisError,
  ContextStateError,
  AdapterUnavailableError,
  isAgentContextError,
  toDiagnosticPayload,
} from './errors.ts';

/* Configuration */
export { DEFAULT_CONFIG, DEFAULT_EXCLUDE, DEFAULT_INCLUDE, DEFAULT_SENSITIVE_PATTERNS } from './config/defaults.ts';
export { loadConfig, applyOverrides, writeConfigFile, normalizeConfig, initConfigTemplate } from './config/load.ts';
export { validateConfig, parseConfigText } from './config/validate.ts';
export type { AgentContextConfig, ConfigOverrides, FeaturesConfig, LoadedConfig } from './config/types.ts';

/* Adapters */
export { FileSystemAdapter } from './adapters/filesystem/fs-adapter.ts';
export type { WalkedFile, WalkOptions } from './adapters/filesystem/fs-adapter.ts';
export {
  SensitivePathFilter,
  redactSecrets,
  containsSecret,
  SECRET_VALUE_PATTERNS,
  REDACTED,
} from './adapters/filesystem/sensitive.ts';
export { GitAdapter, parseGitLog } from './adapters/git/git-adapter.ts';
export type { GitCommit, GitAvailability } from './adapters/git/git-adapter.ts';
export { LanguageRegistry, createDefaultRegistry } from './adapters/language/registry.ts';
export { SIGNALS, createParsedFile, normalizeSignals } from './adapters/language/types.ts';
export type {
  LanguageAdapter,
  ParsedFile,
  FileDescriptor,
  ImportRecord,
  ExportRecord,
  SymbolRecord,
  CallRecord,
  RouteRecord,
} from './adapters/language/types.ts';
export { TsJsAdapter } from './adapters/language/ts-js/adapter.ts';
export { tokenize } from './adapters/language/ts-js/lexer.ts';
export { extractModuleFacts } from './adapters/language/ts-js/extractor.ts';
export { JsonAdapter } from './adapters/language/json/adapter.ts';
export { MarkdownAdapter } from './adapters/language/markdown/adapter.ts';
export { PackageJsonAdapter, readPackageFacts } from './adapters/language/package-json/adapter.ts';
export { TsConfigAdapter, readTsConfigFacts, relaxJson } from './adapters/language/tsconfig/adapter.ts';

/* Core analysis */
export { scanRepository, classifyFile } from './core/scanner/scanner.ts';
export type { ScanOutput, ScanOptions as ScannerOptions } from './core/scanner/scanner.ts';
export { LocalStateStore, ParseCache } from './core/scanner/cache.ts';
export type { LocalState, FileStateRecord } from './core/scanner/cache.ts';
export {
  buildKnowledgeGraph,
  buildSymbols,
  findModuleCycles,
  classifyExternalImportance,
} from './core/graph/knowledge-graph.ts';
export type { KnowledgeGraph, KnowledgeGraphInput, UnresolvedImport } from './core/graph/knowledge-graph.ts';
export { ImportResolver, withExtensions } from './core/graph/resolver.ts';
export type { AliasEntry, ResolvedImport } from './core/graph/resolver.ts';
export { buildModules } from './core/graph/modules.ts';
export { collectAliases } from './core/graph/aliases.ts';
export {
  detectWorkspace,
  owningPackage,
  parsePnpmWorkspaceYaml,
  LOCKFILE_CANDIDATES,
} from './core/workspace/workspace.ts';
export { packageFactsFromParsed } from './core/workspace/package-facts.ts';
export { applyArchitectureDetection } from './core/architecture/detector.ts';
export { detectEntryPoints } from './core/architecture/entry-points.ts';
export { detectModuleRoles, detectResponsibilities, roleValues } from './core/architecture/role-detector.ts';
export { detectConventions, MIN_SAMPLE } from './core/conventions/detector.ts';
export { renderConventionsMarkdown } from './core/conventions/renderer.ts';
export { detectDecisions, parseAdrDocument, collectAdrPaths } from './core/decisions/detector.ts';
export { computeGitActivity, applyGitSignals, bucket } from './core/git-analysis/activity.ts';
export type { GitActivityInput, GitActivityResult } from './core/git-analysis/activity.ts';
export { diffContext, hashDocuments } from './core/diff/differ.ts';
export type { DiffOptions } from './core/diff/differ.ts';
export { explainModule, resolveTarget, transitiveDependents } from './core/context/explain.ts';
export type { ExplainInput, ResolvedTarget } from './core/context/explain.ts';
export { buildRepositoryContext, collectCommands } from './core/context/repository-context.ts';
export type { RepositoryContext, RepositoryContextOptions, RepositoryContextPayload, ContextCommand } from './core/context/types.ts';
export { SearchService, toSearchResult } from './core/search/service.ts';
export type { SearchOptions } from './core/search/service.ts';
export { Bm25Index } from './core/search/bm25.ts';
export { buildSearchDocuments, snippetFor } from './core/search/documents.ts';
export { analyze, expandQueryTerms, SYNONYMS, stem } from './core/search/analyzer.ts';
export type {
  SearchBackend,
  SearchDocument,
  SearchQuery,
  RankedDocument,
  Reranker,
  SearchNodeType,
} from './core/search/types.ts';
export {
  buildContextDocuments,
  buildIndexDocument,
  buildArchitectureDocument,
  buildDependenciesDocument,
  buildConventionsDocuments,
  buildDecisionsDocument,
} from './core/serialization/documents.ts';
export type {
  ArchitectureDocument,
  ArchitectureModule,
  ConventionsDocument,
  DecisionsDocument,
  DependenciesDocument,
  IndexDocument,
  ContextDocuments,
  DocumentBuildOptions,
} from './core/serialization/types.ts';
export { readPersistedContext, hasUsableContext, contextFileNames } from './core/serialization/reader.ts';
export type { PersistedContext } from './core/serialization/reader.ts';
export { writeContext, serializeContextDocuments, removeContextDirectory } from './core/serialization/writer.ts';
export type { WriteContextResult } from './core/serialization/writer.ts';

/* Utilities (public because adapters and the CLI build on them) */
export { PatternSet, compileGlob, compileRule } from './util/glob.ts';
export {
  toPosix,
  normalizeRelative,
  dirname,
  basename,
  extname,
  stem as pathStem,
  join,
  isInside,
  ancestors,
  relativeTo,
} from './util/paths.ts';
export { mapWithConcurrency, runWithConcurrency, defaultConcurrency } from './util/concurrency.ts';
export { Logger, DiagnosticsCollector, silentLogger } from './logging/diagnostics.ts';
export type { LogLevel, ProgressEvent, ProgressReporter } from './logging/diagnostics.ts';
export { classifyIdentifierCase, splitIdentifier, truncate, formatDate, ratio, pluralize } from './util/text.ts';