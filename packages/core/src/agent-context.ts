/**
 * Public API of `ai-agent-context`.
 *
 * ```ts
 * import { AgentContext } from 'ai-agent-context';
 *
 * const context = await AgentContext.load({ root: process.cwd() });
 * const payments = await context.explain('src/payments');
 * ```
 *
 * Design notes:
 * - the facade is the only entry point to the pipeline and it is what the CLI and
 *   the MCP adapter call, so neither contains business logic;
 * - read-only queries use a *dry run* of the pipeline: the local cache makes it
 *   cheap and `.agent/` on disk is never modified by a query;
 * - `scan()` is the only method that persists the context.
 */
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LanguageRegistry } from './adapters/language/registry.ts';
import type { ParsedFile } from './adapters/language/types.ts';
import type { ConfigOverrides, AgentContextConfig, LoadedConfig } from './config/types.ts';
import type { ProgressReporter } from './logging/diagnostics.ts';
import { Logger } from './logging/diagnostics.ts';
import { GitAdapter } from './adapters/git/git-adapter.ts';
import type {
  ChangeSet,
  ContextDiff,
  Convention,
  Decision,
  FileNode,
  ChangeImpact,
  TaskContext,
  ModuleHistoryEntry,
  RevisionDiff,
  RevisionSnapshot,
  ModuleExplanation,
  ModuleNode,
  Repository,
  ScanReport,
  SearchResult,
} from './model/types.ts';
import { AGENT_DIR, AGENT_GITIGNORE, CONFIG_FILE, SCHEMA_VERSION } from './model/schema.ts';
import { compareStrings } from './model/canonical.ts';
import { loadConfig, writeConfigFile } from './config/load.ts';
import { runPipeline, type PipelineResult } from './pipeline/scan-pipeline.ts';
import { readPersistedContext, type PersistedContext } from './core/serialization/reader.ts';
import { LocalStateStore, type LocalState } from './core/scanner/cache.ts';
import { workingTreeFingerprint } from './core/scanner/fingerprint.ts';
import type { ArchitectureDocument, DependenciesDocument, IndexDocument } from './core/serialization/types.ts';
import { explainModule, resolveTarget, type ResolvedTarget } from './core/context/explain.ts';
import type { ExplainDetail } from './core/context/explain.ts';
import type { KnowledgeGraph } from './core/graph/knowledge-graph.ts';
import { withExtensions } from './core/graph/resolver.ts';
import {
  buildFileOutline,
  buildReferenceIndex,
  buildReferenceReport,
  buildUnusedExports,
  emptyReferenceReport,
  type FileOutline,
  type ReferenceIndex,
  type ReferenceReport,
  type ReferenceTarget,
  type UnusedExportsReport,
} from './core/navigation/references.ts';
import { isInside, normalizeRelative } from './util/paths.ts';
import { detectIssues } from './core/context/diagnostics.ts';
import type { DetectionReport } from './core/context/diagnostics.ts';
import { buildRepositoryContext } from './core/context/repository-context.ts';
import type { RepositoryContext, RepositoryContextOptions } from './core/context/types.ts';
import { SearchService, type SearchOptions } from './core/search/service.ts';
import { ContextStateError, ReadOnlyError } from './errors.ts';

export interface AgentContextOptions {
  /** Repository root; defaults to `process.cwd()`. */
  root?: string;
  /** Configuration overrides (CLI flags take exactly this path). */
  config?: ConfigOverrides;
  /** Explicit configuration file path. */
  configPath?: string;
  logger?: Logger;
  registry?: LanguageRegistry;
  progress?: ProgressReporter;
  /** Injectable clock (deterministic tests). */
  now?: () => number;
  /** Injectable git adapter (tests, sandboxes). */
  gitAdapter?: GitAdapter;
  /** Skip the organization policy (embedders that supply their own rules). */
  ignorePolicy?: boolean;
}

export interface ScanOptions {
  /** Ignore the local state and re-read every file. */
  force?: boolean;
  /** Do not write `.agent/`. */
  dryRun?: boolean;
}

export interface StatusReport {
  status: 'up-to-date' | 'stale' | 'missing';
  lastScanAt: string | null;
  /**
   * What the working tree was compared with: the local state, the committed
   * `index.json` (a fresh clone has no local state), or nothing.
   */
  baseline: 'local-state' | 'committed-index' | 'none';
  configPath: string | null;
  configHashMatches: boolean;
  contextFiles: { present: string[]; missing: string[]; invalid: Array<{ file: string; reason: string }> };
  changes: ChangeSet;
  counts: LocalState['counts'];
  git: { available: boolean; reason?: string; commitsAnalyzed: number };
}

export interface InitResult {
  configPath: string;
  created: string[];
  alreadyExisted: boolean;
  overwritten: boolean;
}

export class AgentContext {
  readonly root: string;
  private readonly options: AgentContextOptions;
  private resolvedConfig: AgentContextConfig;
  private configSource: string | null = null;
  /** Organization policy file that applied, when one did. */
  private readOnlySource: string | undefined;
  private pipeline: PipelineResult | null = null;
  private pipelineMode: 'dry' | 'full' | null = null;
  /** Navigation index of the cached pipeline; rebuilt whenever the pipeline is. */
  private referenceIndex: ReferenceIndex | null = null;

  private persisted: PersistedContext | null = null;

  private constructor(root: string, options: AgentContextOptions, config: AgentContextConfig) {
    this.root = root;
    this.options = options;
    this.resolvedConfig = config;
  }

  /**
   * Loads the context for a repository.
   *
   * Nothing is scanned yet: the first query (or `scan()`) runs the pipeline. This
   * keeps `AgentContext.load()` cheap for callers that only need configuration.
   */
  static async load(options: AgentContextOptions = {}): Promise<AgentContext> {
    const root = path.resolve(options.root ?? process.cwd());
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new ContextStateError(`Repository root does not exist or is not a directory: ${root}`, [
        'Pass an existing directory with --root, or run the command from inside the repository.',
      ]);
    }
    const loaded = await loadConfig({
      root,
      ...(options.config === undefined ? {} : { overrides: options.config }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.ignorePolicy === undefined ? {} : { ignorePolicy: options.ignorePolicy }),
    });
    const context = new AgentContext(root, options, loaded.config);
    await context.adoptConfiguration(loaded);
    return context;
  }

  /** Adopts a loaded configuration: the config, its source, the policy that applied and the persisted context. */
  private async adoptConfiguration(loaded: LoadedConfig): Promise<void> {
    this.resolvedConfig = loaded.config;
    this.configSource = loaded.source;
    this.readOnlySource = loaded.policySource === null ? undefined : loaded.policySource;
    this.persisted = await readPersistedContext(this.root);
  }

  /**
   * Whether the repository moved since the analysis in memory was produced.
   *
   * A query re-runs no analysis while the facade lives, which is what makes
   * repeated queries cheap — and what makes a long-lived host answer from a
   * repository that no longer exists once its first edit lands. This is the
   * check such a host makes between queries: the configuration, then the files
   * the analysis read (by path, size and modification time; nothing is opened).
   *
   * Always `false` before the first query: there is nothing to be stale.
   */
  async isStale(): Promise<boolean> {
    if (this.pipeline === null) return false;
    const loaded = await this.loadConfiguration();
    if (loaded.hash !== this.pipeline.configHash) return true;
    return (await workingTreeFingerprint({ root: this.root, config: loaded.config })) !== this.pipeline.fingerprint;
  }

  /**
   * Drops the analysis in memory and re-reads the configuration, so the next
   * query describes the repository as it is now.
   *
   * Writes nothing and reads no source file.
   */
  async invalidate(): Promise<void> {
    this.pipeline = null;
    this.pipelineMode = null;
    this.referenceIndex = null;
    await this.adoptConfiguration(await this.loadConfiguration());
  }

  /** Loads the configuration with this facade's overrides. */
  private loadConfiguration(): Promise<LoadedConfig> {
    return loadConfig({
      root: this.root,
      ...(this.options.config === undefined ? {} : { overrides: this.options.config }),
      ...(this.options.configPath === undefined ? {} : { configPath: this.options.configPath }),
      ...(this.options.ignorePolicy === undefined ? {} : { ignorePolicy: this.options.ignorePolicy }),
    });
  }

  /** Resolved configuration (defaults + config file + overrides). */
  get config(): AgentContextConfig {
    return this.resolvedConfig;
  }

  /** Path of the configuration file in use, relative to the root, when it exists. */
  get configFile(): string | null {
    return this.configSource;
  }

  /**
   * Whether the read-only contract is in force.
   *
   * Enforced at the facade rather than per command, so no code path can write:
   * an MCP tool handler, a future command, or an embedder calling `scan()`
   * directly all hit the same guard.
   */
  get readOnly(): boolean {
    return this.resolvedConfig.security.readOnly;
  }

  /** Throws {@link ReadOnlyError} when writes are not permitted. */
  private assertWritable(operation: string): void {
    if (!this.readOnly) return;
    throw new ReadOnlyError(operation, this.readOnlySource);
  }

  private pipelineOptions(scanOptions: ScanOptions = {}): Parameters<typeof runPipeline>[0] {
    return {
      root: this.root,
      ...(this.options.config === undefined ? {} : { overrides: this.options.config }),
      ...(this.options.configPath === undefined ? {} : { configPath: this.options.configPath }),
      logger: this.options.logger ?? new Logger({ level: 'silent' }),
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
      ...(this.options.progress === undefined ? {} : { progress: this.options.progress }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.gitAdapter === undefined ? {} : { gitAdapter: this.options.gitAdapter }),
      dryRun: scanOptions.dryRun === true,
      force: scanOptions.force === true,
    };
  }

  /** Runs the pipeline; read-only queries use `dryRun` so nothing is written. */
  private async ensurePipeline(scanOptions: ScanOptions = {}): Promise<PipelineResult> {
    const dryRun = scanOptions.dryRun === true;
    // A cached pipeline may only be reused when the scan mode matches: a dry
    // run must always observe the *current* on-disk state (local cache plus
    // working tree), never the frozen result of an earlier `scan()`.
    if (this.pipeline !== null && this.pipelineMode === (dryRun ? 'dry' : 'full') && scanOptions.force !== true) {
      return this.pipeline;
    }
    const result = await runPipeline(this.pipelineOptions(scanOptions));
    this.pipeline = result;
    this.pipelineMode = dryRun ? 'dry' : 'full';
    this.referenceIndex = null;
    return result;
  }


  /** Scans the repository and persists the context into `.agent/`. */
  async scan(options: ScanOptions = {}): Promise<ScanReport> {
    this.assertWritable('scan and write .agent/');
    // A scan must always observe the current working tree — it never reuses the
    // cached pipeline. `force` re-reads every file, ignoring the local state.
    const pipelineOptions = this.pipelineOptions({ ...options, dryRun: false });
    const result = await runPipeline(pipelineOptions);
    this.pipeline = result;
    this.pipelineMode = 'full';
    this.referenceIndex = null;
    this.persisted = await readPersistedContext(this.root);
    return result.report;
  }


  /** Complete repository model, in memory. */
  async getRepository(): Promise<Repository> {
    return (await this.ensurePipeline({ dryRun: true })).graph.repository;
  }

  /** Architecture projection. */
  async getArchitecture(): Promise<ArchitectureDocument> {
    return (await this.ensurePipeline({ dryRun: true })).documents.architecture;
  }

  async getDependencies(): Promise<DependenciesDocument> {
    return (await this.ensurePipeline({ dryRun: true })).documents.dependencies;
  }

  async getConventions(): Promise<Convention[]> {
    return (await this.ensurePipeline({ dryRun: true })).documents.conventions.conventions;
  }

  async getDecisions(): Promise<Decision[]> {
    return (await this.ensurePipeline({ dryRun: true })).documents.decisions.decisions;
  }

  async getIndex(): Promise<IndexDocument> {
    return (await this.ensurePipeline({ dryRun: true })).documents.index;
  }

  async getFiles(): Promise<FileNode[]> {
    return (await this.ensurePipeline({ dryRun: true })).graph.repository.files;
  }

  /** Modules of the repository, each with heuristic roles and evidence. */
  async getModules(): Promise<ModuleNode[]> {
    return (await this.ensurePipeline({ dryRun: true })).graph.repository.modules;
  }

  /** Module ids that depend on the given module (direct dependents). */
  async getDependents(moduleId: string): Promise<string[]> {
    const repository = await this.getRepository();
    return (repository.modules.find((module) => module.id === moduleId)?.usedBy ?? []).sort(compareStrings);
  }

  /** Module ids the given module depends on. */
  async getDependenciesOf(moduleId: string): Promise<string[]> {
    const repository = await this.getRepository();
    return (repository.modules.find((module) => module.id === moduleId)?.dependsOn ?? []).sort(compareStrings);
  }

  /**
   * What the analysis could not determine.
   *
   * An agent about to act on a dependency graph needs to know which parts of it
   * are missing; this turns every "could not resolve / could not parse" signal
   * into one ranked list.
   */
  async detect(): Promise<DetectionReport> {
    const result = await this.ensurePipeline({ dryRun: true });
    return detectIssues(result.graph, result.parsed, SCHEMA_VERSION);
  }

  /** Compact, agent oriented repository context. */
  async getRepositoryContext(options: RepositoryContextOptions = {}): Promise<RepositoryContext> {
    const result = await this.ensurePipeline({ dryRun: true });
    return buildRepositoryContext(result.graph, result.parsed, options);
  }

  /** Structured explanation of a module (or of the module owning a file). */
  async explain(
    target: string,
    options: { detail?: ExplainDetail; compactSourceThresholdBytes?: number } = {},
  ): Promise<ModuleExplanation | null> {
    const result = await this.ensurePipeline({ dryRun: true });
    return explainModule({
      graph: result.graph,
      parsed: result.parsed,
      target,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.compactSourceThresholdBytes === undefined
        ? {}
        : { compactSourceThresholdBytes: options.compactSourceThresholdBytes }),
    });
  }

  /** Task-oriented, bounded context for an agent. */
  async getTaskContext(task: string, options: { target?: string; maxModules?: number } = {}): Promise<TaskContext> {
    const query = task.trim();
    if (query.length === 0) throw new Error('task must not be empty');
    const result = await this.ensurePipeline({ dryRun: true });
    const maxModules = Math.max(1, Math.min(options.maxModules ?? 5, 12));
    const target = options.target === undefined ? null : options.target;
    const explanations: ModuleExplanation[] = [];
    if (target !== null) {
      const explanation = explainModule({ graph: result.graph, parsed: result.parsed, target, maxRelatedFiles: 20 });
      if (explanation !== null) explanations.push(explanation);
    }
    const searched = await this.search(query, { limit: maxModules * 2, types: ['module'] });
    for (const item of searched) {
      if (explanations.some((entry) => entry.module.id === item.id)) continue;
      const explanation = await this.explain(item.id);
      if (explanation !== null) explanations.push(explanation);
      if (explanations.length >= maxModules) break;
    }
    const selected = explanations.slice(0, maxModules);
    const modules = selected.map((explanation) => ({
      id: explanation.module.id,
      summary: explanation.summary,
      dependsOn: explanation.dependsOn.map((entry) => entry.id),
      usedBy: explanation.usedBy.map((entry) => entry.id),
      publicApi: explanation.publicApi.map((entry) => entry.name),
      tests: explanation.tests.files,
      evidence: [
        ...explanation.module.roles.flatMap((entry) => entry.evidence),
        ...explanation.module.responsibilities.flatMap((entry) => entry.evidence),
        ...(explanation.module.roles.length === 0 && explanation.module.responsibilities.length === 0
          ? [{ source: explanation.module.path || '.', detail: `module ${explanation.module.id} selected by the requested task` }]
          : []),
      ],
    }));
    const files = new Set(selected.flatMap((entry) => entry.relatedFiles));
    const conventions = result.graph.repository.conventions.filter((entry) => entry.evidence.some((evidence) => files.has(evidence.source))).slice(0, 8);
    const decisions = result.graph.repository.decisions.filter((entry) => entry.evidence.some((evidence) => files.has(evidence.source))).slice(0, 8);
    return {
      schemaVersion: result.documents.index.schemaVersion,
      task: query,
      target,
      modules,
      conventions,
      decisions,
      diagnostics: result.report.warnings,
      truncated: explanations.length > selected.length || selected.length === maxModules,
    };
  }

  /** Bounded impact context for a proposed change. */
  async getChangeImpact(target: string, options: { maxFiles?: number } = {}): Promise<ChangeImpact> {
    const explanation = await this.explain(target);
    if (explanation === null) throw new Error(`no module or file matched "${target}"`);
    const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 100, 500));
    const files = explanation.impact.files.slice(0, maxFiles);
    const filesForEvidence = new Set(files);
    const conventions = explanation.conventions.filter((entry) => entry.evidence.some((item) => filesForEvidence.has(item.source) || explanation.relatedFiles.includes(item.source))).slice(0, 10);
    const decisions = explanation.decisions.filter((entry) => entry.evidence.some((item) => filesForEvidence.has(item.source) || explanation.relatedFiles.includes(item.source))).slice(0, 10);
    return {
      schemaVersion: SCHEMA_VERSION,
      target,
      modules: explanation.impact.modules,
      files,
      tests: explanation.tests.files,
      conventions,
      decisions,
      evidence: [
        { source: explanation.module.path || '.', detail: `change impact derived from ${explanation.module.id} and its transitive dependents` },
        ...explanation.module.roles.flatMap((entry) => entry.evidence),
      ],
      truncated: explanation.impact.files.length > files.length,
    };
  }

  /**
   * Git history of a module, a directory or a file.
   *
   * The history is scoped by asking git for the commits that touch the target's
   * paths, rather than by taking the most recent commits of the whole repository
   * and keeping the ones that touch it. The second form silently returns almost
   * nothing for any target that is not under constant change: in a repository
   * with fifty commits since the last edit to `src/legacy`, the history of
   * `src/legacy` was empty.
   */
  async getModuleHistory(target: string, options: { limit?: number } = {}): Promise<ModuleHistoryEntry[]> {
    const result = await this.ensurePipeline({ dryRun: true });
    const resolved = resolveTarget(result.graph, target);
    if (resolved === null || resolved.moduleId === null) throw new Error(`no module or file matched "${target}"`);
    const adapter = this.options.gitAdapter ?? new GitAdapter(this.root);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const paths = historyScope(result.graph, resolved);
    // No time window: the paths are the bound. A window would cut off the last
    // change to a file that has not been touched for years, which is precisely
    // the file someone asks the history of.
    const commits = await adapter.log({ windowDays: 0, maxCommits: limit, ...(paths === null ? {} : { paths }) });
    const inScope = (file: string): boolean => paths === null || paths.some((scope) => isInside(scope, file));
    const patterns = result.config.features.git ? result.config.analysis.git.architectureSignalPatterns : [];
    const signal = new RegExp(patterns.map((pattern) => pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    return commits
      .filter((commit) => commit.files.some(inScope))
      .slice(0, limit)
      .map((commit) => ({
        sha: commit.sha.slice(0, 8),
        date: commit.date.slice(0, 10),
        author: commit.author,
        subject: commit.subject,
        files: commit.files.filter(inScope).sort(compareStrings),
        architectureSignal: patterns.length > 0 && signal.test(commit.subject),
      }));
  }

  async getRevisionDiff(revision: string, base = 'HEAD'): Promise<RevisionDiff> {
    const adapter = this.options.gitAdapter ?? new GitAdapter(this.root);
    const files = await adapter.diff(revision, base);
    return { revision, files, hasChanges: files.length > 0 };
  }

  async getRevisionSnapshot(revision: string): Promise<RevisionSnapshot> {
    const adapter = this.options.gitAdapter ?? new GitAdapter(this.root);
    const commit = await adapter.revision(revision);
    if (commit === null) {
      return {
        revision,
        sha: '',
        author: '',
        date: '',
        subject: '',
        files: [],
        moduleCount: null,
        dependencyCount: null,
        entryPointCount: null,
        decisionIds: [],
        available: false,
        reason: 'revision is unavailable or repository has no commit',
      };
    }
    const current = await this.getRepository();
    const files = new Set(commit.files);
    const decisionIds = current.decisions
      .filter((decision) => decision.evidence.some((evidence) => files.has(evidence.source)))
      .map((decision) => decision.id)
      .sort(compareStrings);
    const moduleCount = current.modules.filter((module) => module.files.some((file) => files.has(file))).length;
    const dependencyCount = current.dependencies.filter((edge) => files.has(edge.from) || files.has(edge.to)).length;
    const entryPointCount = current.entryPoints.filter((entry) => files.has(entry.path)).length;
    return {
      revision,
      sha: commit.sha,
      author: commit.author,
      date: commit.date,
      subject: commit.subject,
      files: commit.files,
      moduleCount,
      dependencyCount,
      entryPointCount,
      decisionIds,
      available: true,
    };
  }

  /** Context changes relative to the persisted context. */
  async diff(): Promise<ContextDiff> {
    return (await this.ensurePipeline({ dryRun: true })).diff;
  }

  /** Deterministic lexical search over files, modules, symbols, conventions, decisions. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const result = await this.ensurePipeline({ dryRun: true });
    return SearchService.fromGraph({ graph: result.graph, parsed: result.parsed }).search(query, options);
  }

  /** Search with an explicitly provided backend (embeddings, vector database, ...). */
  async searchWith(service: SearchService, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    await this.ensurePipeline({ dryRun: true });

    return service.search(query, options);
  }

  /** The analysis with its navigation index, which is built on first use. */
  private async navigation(): Promise<NavigationBundle> {
    const result = await this.ensurePipeline({ dryRun: true });
    this.referenceIndex ??= buildReferenceIndex(result.graph, result.parsed);
    return {
      graph: result.graph,
      parsed: result.parsed,
      index: this.referenceIndex,
      analyzed: new Set(result.graph.repository.files.map((file) => file.path)),
    };
  }

  /**
   * Outline of one file: what it exports, what it imports, and who imports it.
   *
   * This is the file-level view `explain` does not give — `explain` of a file
   * describes the module that owns it. `null` when the target is not an
   * analyzed file.
   */
  async getFileOutline(target: string): Promise<FileOutline | null> {
    const navigation = await this.navigation();
    const file = resolveAnalyzedFile(navigation, target);
    return file === null ? null : buildFileOutline(navigation.graph, navigation.parsed, navigation.index, file);
  }

  /**
   * Where a symbol is imported.
   *
   * The target is `symbol`, `file#symbol`, or `symbol` with `options.file`.
   * A name alone must be unambiguous; when several files export it, the report
   * says so and lists them instead of guessing.
   */
  async findReferences(target: string, options: { file?: string } = {}): Promise<ReferenceReport> {
    const navigation = await this.navigation();
    const { graph, parsed, index } = navigation;
    const separator = target.indexOf('#');
    const fileTarget = separator === -1 ? options.file : target.slice(0, separator);
    const symbol = (separator === -1 ? target : target.slice(separator + 1)).trim();
    const report = emptyReferenceReport();

    if (symbol.length === 0) {
      report.caveats.push('Name the symbol: <symbol>, or <file>#<symbol> when several files export the name.');
      return report;
    }
    if (fileTarget !== undefined && fileTarget.trim().length > 0) {
      const file = resolveAnalyzedFile(navigation, fileTarget);
      if (file === null) {
        report.caveats.push(`no analyzed file matched "${fileTarget}"`);
        return report;
      }
      const declared = parsed.get(file)?.symbols.find((entry) => (symbol === 'default' ? entry.isDefault : entry.name === symbol));
      const exported = index.ownExports(file).get(symbol);
      if (declared === undefined && exported === undefined) {
        report.caveats.push(`"${symbol}" is not declared in ${file}`);
        return report;
      }
      return buildReferenceReport(graph, index, {
        file,
        symbol,
        kind: declared?.kind ?? exported?.kind ?? 'unknown',
        line: declared?.line ?? exported?.line ?? 0,
        exported: exported !== undefined,
        isDefault: symbol === 'default',
      });
    }

    const candidates: ReferenceTarget[] = [];
    for (const node of graph.repository.files) {
      if (node.sensitive || (node.language !== 'typescript' && node.language !== 'javascript')) continue;
      const own = index.ownExports(node.path).get(symbol);
      if (own !== undefined) {
        candidates.push({ file: node.path, symbol, kind: own.kind, line: own.line, exported: true, isDefault: own.isDefault });
      }
    }
    if (candidates.length === 1) return buildReferenceReport(graph, index, candidates[0]!);
    report.candidates = candidates;
    report.status = candidates.length === 0 ? 'not-found' : 'ambiguous';
    report.caveats.push(
      candidates.length === 0
        ? `No analyzed file exports "${symbol}".`
        : `${candidates.length} files export "${symbol}"; name the file: <file>#${symbol}`,
    );
    return report;
  }

  /**
   * Named exports that no analyzed file imports and no entry point reaches.
   *
   * A finding is a statement about the analyzed tree, with a confidence that
   * reflects its coverage; the report names what was not assessed and why.
   */
  async findUnusedExports(options: { limit?: number } = {}): Promise<UnusedExportsReport> {
    const navigation = await this.navigation();
    return buildUnusedExports(navigation.graph, navigation.index, options);
  }

  /** Compares the working tree with the persisted context. */
  async status(): Promise<StatusReport> {
    const result = await this.ensurePipeline({ dryRun: true });

    // Always re-read persisted documents: callers may have changed `.agent/`
    // after this facade was loaded (notably the CI verification command).
    const persisted = await readPersistedContext(this.root);
    const state = await new LocalStateStore(this.root).read();
    // Which record the change set was measured against decides how the
    // configuration is checked. Against the local state, its hash is compared;
    // against the committed index, the hash that index recorded. A document
    // written before 1.1.0 records none: the question then cannot be asked, and
    // answering it "no" would fail every such repository on upgrade.
    const recordedConfigHash = persisted.index?.configHash;
    const configHashMatches =
      result.baseline === 'committed-index'
        ? recordedConfigHash === undefined || recordedConfigHash === result.configHash
        : state !== null && state.configHash === result.configHash;
    const changes = result.report.changes;
    const pending = changes.added.length > 0 || changes.modified.length > 0 || changes.deleted.length > 0;
    const present: string[] = [];
    if (persisted.index !== null) present.push('index.json');
    if (persisted.architecture !== null) present.push('architecture.json');
    if (persisted.dependencies !== null) present.push('dependencies.json');
    if (persisted.conventions !== null) present.push('conventions.json');
    if (persisted.decisions !== null) present.push('decisions.json');

    const status: StatusReport['status'] =
      persisted.index === null ? 'missing' : pending || !configHashMatches ? 'stale' : 'up-to-date';

    return {
      status,
      lastScanAt: state?.lastScanAt ?? null,
      baseline: result.baseline,
      configPath: this.configSource,
      configHashMatches,
      contextFiles: { present, missing: [...persisted.missing], invalid: [...persisted.invalid] },
      changes,
      // With no local state the counts come from the analysis just run, which
      // is what the working tree holds; zeros would describe the machine, not
      // the repository.
      counts: state?.counts ?? {
        files: result.report.files.total,
        modules: result.report.modules,
        dependencies: result.report.dependencies,
        entryPoints: result.report.entryPoints,
        conventions: result.report.conventions,
        decisions: result.report.decisions,
      },
      git: {
        available: result.git.availability.available,
        ...(result.git.availability.reason === undefined ? {} : { reason: result.git.availability.reason }),
        commitsAnalyzed: result.git.commitsAnalyzed,
      },
    };
  }

  /**
   * Creates `.agent/` and `.agent/config.json`.
   *
   * Idempotent: an existing configuration is left untouched unless `force` is set.
   */
  async init(options: { force?: boolean } = {}): Promise<InitResult> {
    this.assertWritable('create .agent/');
    const configPath = path.join(this.root, CONFIG_FILE);
    const existed = existsSync(configPath);
    const created: string[] = [];
    if (!existsSync(path.join(this.root, AGENT_DIR))) {
      await mkdir(path.join(this.root, AGENT_DIR), { recursive: true });
      created.push(`${AGENT_DIR}/`);
    }
    const gitignorePath = path.join(this.root, AGENT_DIR, '.gitignore');
    if (!existsSync(gitignorePath)) {
      await writeFile(gitignorePath, AGENT_GITIGNORE, 'utf8');
      created.push(`${AGENT_DIR}/.gitignore`);
    }
    let overwritten = false;
    if (!existed || options.force === true) {
      // The template is the *repository's* configuration. Baking an organization
      // policy into it would duplicate a file the repository does not own, at a
      // lower precedence than the real one, and misdescribe where the rule
      // comes from.
      const loaded = await loadConfig({ root: this.root, ignoreFile: true, ignorePolicy: true });
      await writeConfigFile(this.root, loaded.config, true);
      if (existed) overwritten = true;
      else created.push(CONFIG_FILE);
    }
    return { configPath, created: created.sort(compareStrings), alreadyExisted: existed, overwritten };
  }

  /** Returns the persisted context or throws a helpful error when it is missing. */
  async requirePersistedContext(): Promise<PersistedContext> {
    const persisted = this.persisted ?? (await readPersistedContext(this.root));
    if (persisted.index === null) {
      throw new ContextStateError('No usable .agent/ context found in this repository.', [
        'Run: agent-context init && agent-context scan',
      ]);
    }
    return persisted;
  }
}

/**
 * The analysis of one repository state, with what navigation needs on top of
 * the graph: the parsed facts and the import/export index built from them.
 */
interface NavigationBundle {
  graph: KnowledgeGraph;
  parsed: Map<string, ParsedFile>;
  index: ReferenceIndex;
  analyzed: Set<string>;
}

/** The analyzed file a target names, with or without its extension. */
function resolveAnalyzedFile(navigation: NavigationBundle, rawTarget: string): string | null {
  const target = normalizeRelative(rawTarget);
  if (target.length === 0) return null;
  if (navigation.analyzed.has(target)) return target;
  return withExtensions(target, navigation.analyzed);
}

/**
 * The paths whose history a resolved target asks for, or `null` for the whole
 * repository.
 *
 * A directory rather than a list of files: the files that used to be in it and
 * are gone now are part of its history too, and only git knows them.
 */
function historyScope(graph: KnowledgeGraph, resolved: ResolvedTarget): string[] | null {
  if (resolved.scopeDirectory !== null) return [resolved.scopeDirectory];
  if (resolved.filePath !== null) return [resolved.filePath];
  const module = graph.repository.modules.find((entry) => entry.id === resolved.moduleId);
  if (module === undefined) return null;
  if (module.basis === 'single-file') return [module.files[0] ?? module.path];
  // The package at the repository root is the whole repository.
  return module.path.length === 0 ? null : [module.path];
}