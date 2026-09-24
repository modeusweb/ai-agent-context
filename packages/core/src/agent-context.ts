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
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LanguageRegistry } from './adapters/language/registry.ts';
import type { ConfigOverrides, AgentContextConfig } from './config/types.ts';
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
import type { ArchitectureDocument, DependenciesDocument, IndexDocument } from './core/serialization/types.ts';
import { explainModule } from './core/context/explain.ts';
import { buildRepositoryContext } from './core/context/repository-context.ts';
import type { RepositoryContext, RepositoryContextOptions } from './core/context/types.ts';
import { SearchService, type SearchOptions } from './core/search/service.ts';
import { ContextStateError } from './errors.ts';

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
  private pipeline: PipelineResult | null = null;
  private pipelineMode: 'dry' | 'full' | null = null;

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
    const loaded = await loadConfig({
      root,
      ...(options.config === undefined ? {} : { overrides: options.config }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    });
    const context = new AgentContext(root, options, loaded.config);
    context.configSource = loaded.source;
    context.persisted = await readPersistedContext(root);
    return context;
  }

  /** Resolved configuration (defaults + config file + overrides). */
  get config(): AgentContextConfig {
    return this.resolvedConfig;
  }

  /** Path of the configuration file in use, relative to the root, when it exists. */
  get configFile(): string | null {
    return this.configSource;
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
    return result;
  }


  /** Scans the repository and persists the context into `.agent/`. */
  async scan(options: ScanOptions = {}): Promise<ScanReport> {
    // A scan must always observe the current working tree — it never reuses the
    // cached pipeline. `force` re-reads every file, ignoring the local state.
    const pipelineOptions = this.pipelineOptions({ ...options, dryRun: false });
    const result = await runPipeline(pipelineOptions);
    this.pipeline = result;
    this.pipelineMode = 'full';
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

  /** Compact, agent oriented repository context. */
  async getRepositoryContext(options: RepositoryContextOptions = {}): Promise<RepositoryContext> {
    const result = await this.ensurePipeline({ dryRun: true });
    return buildRepositoryContext(result.graph, result.parsed, options);
  }

  /** Structured explanation of a module (or of the module owning a file). */
  async explain(target: string): Promise<ModuleExplanation | null> {
    const result = await this.ensurePipeline({ dryRun: true });
    return explainModule({ graph: result.graph, parsed: result.parsed, target });
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

  async getModuleHistory(target: string, options: { limit?: number } = {}): Promise<ModuleHistoryEntry[]> {
    const explanation = await this.explain(target);
    if (explanation === null) throw new Error(`no module or file matched "${target}"`);
    const adapter = this.options.gitAdapter ?? new GitAdapter(this.root);
    const commits = await adapter.log({ windowDays: 3650, maxCommits: Math.max(1, Math.min(options.limit ?? 50, 200)) });
    const files = new Set(explanation.relatedFiles);
    return commits
      .filter((commit) => commit.files.some((file) => files.has(file)))
      .slice(0, Math.max(1, Math.min(options.limit ?? 50, 200)))
      .map((commit) => ({
        sha: commit.sha.slice(0, 8),
        date: commit.date.slice(0, 10),
        author: commit.author,
        subject: commit.subject,
        files: commit.files.filter((file) => files.has(file)).sort(compareStrings),
        architectureSignal: /refactor|architecture|adr|breaking|migrat|restructure|rewrite/i.test(commit.subject),
      }));
  }

  async getRevisionDiff(revision: string, base = 'HEAD'): Promise<RevisionDiff> {
    const adapter = this.options.gitAdapter ?? new GitAdapter(this.root);
    const files = await adapter.diff(revision, base);
    return { revision, files, hasChanges: files.length > 0 };
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

  /** Compares the working tree with the persisted context. */
  async status(): Promise<StatusReport> {
    const result = await this.ensurePipeline({ dryRun: true });

    const persisted = this.persisted ?? (await readPersistedContext(this.root));
    const state = await new LocalStateStore(this.root).read();
    const configHashMatches = state !== null && state.configHash === result.configHash;
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
      configPath: this.configSource,
      configHashMatches,
      contextFiles: { present, missing: [...persisted.missing], invalid: [...persisted.invalid] },
      changes,
      counts: state?.counts ?? {
        files: 0,
        modules: 0,
        dependencies: 0,
        entryPoints: 0,
        conventions: 0,
        decisions: 0,
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
      const loaded = await loadConfig({ root: this.root, ignoreFile: true });
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