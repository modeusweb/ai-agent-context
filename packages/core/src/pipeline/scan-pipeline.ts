/**
 * The scanning pipeline: the single orchestration path used by the CLI, the
 * programmatic API and the MCP adapter.
 *
 * Order matters and is explicit:
 *
 * ```text
 * config в†’ local state в†’ scanner (incremental) в†’ workspace в†’ knowledge graph
 *        в†’ architecture roles / entry points в†’ git signals в†’ conventions
 *        в†’ decisions в†’ canonical documents в†’ diff в†’ persist в†’ local state
 * ```
 *
 * Nothing here writes to `.agent/` when `dryRun` is set, which is how `status`
 * and `diff` stay side-effect free.
 */
import type { LanguageRegistry } from '../adapters/language/registry.ts';
import type { ParsedFile } from '../adapters/language/types.ts';
import type { KnowledgeGraph } from '../core/graph/knowledge-graph.ts';
import type { ContextDiff, ScanReport, WorkspaceInfo } from '../model/types.ts';
import type { AgentContextConfig, ConfigOverrides } from '../config/types.ts';
import { loadConfig } from '../config/load.ts';
import { DiagnosticsCollector, Logger, type ProgressReporter } from '../logging/diagnostics.ts';
import { SCHEMA_VERSION } from '../model/schema.ts';
import { compareStrings } from '../model/canonical.ts';
import { FileSystemAdapter } from '../adapters/filesystem/fs-adapter.ts';
import { GitAdapter, type GitAvailability } from '../adapters/git/git-adapter.ts';
import { scanRepository, type ScanOutput } from '../core/scanner/scanner.ts';
import { LocalStateStore, ParseCache, type LocalState } from '../core/scanner/cache.ts';
import { detectWorkspace } from '../core/workspace/workspace.ts';
import { packageFactsFromParsed } from '../core/workspace/package-facts.ts';
import { buildKnowledgeGraph } from '../core/graph/knowledge-graph.ts';
import { applyArchitectureDetection } from '../core/architecture/detector.ts';
import { computeGitActivity, applyGitSignals } from '../core/git-analysis/activity.ts';
import { detectConventions } from '../core/conventions/detector.ts';
import { detectDecisions } from '../core/decisions/detector.ts';
import { buildContextDocuments } from '../core/serialization/documents.ts';
import { readPersistedContext, type PersistedContext } from '../core/serialization/reader.ts';
import { writeContext, type WriteContextResult } from '../core/serialization/writer.ts';
import { diffContext, hashDocuments } from '../core/diff/differ.ts';
import type { ContextDocuments } from '../core/serialization/types.ts';
import { transitiveDependents } from '../core/context/explain.ts';

export interface PipelineOptions {
  root: string;
  /** Configuration overrides coming from CLI flags. */
  overrides?: ConfigOverrides;
  configPath?: string;
  logger?: Logger;
  registry?: LanguageRegistry;
  progress?: ProgressReporter;
  /** Compute everything but write nothing (`status`, `diff`). */
  dryRun?: boolean;
  /** Ignore the local state and re-read every file. */
  force?: boolean;
  /** Injectable clock (tests), used for timestamps and git windows. */
  now?: () => number;
  /** Injectable git adapter (tests, or when git is not on PATH). */
  gitAdapter?: GitAdapter;
}

export interface PipelineResult {
  config: AgentContextConfig;
  configHash: string;
  graph: KnowledgeGraph;
  parsed: Map<string, ParsedFile>;
  documents: ContextDocuments;
  report: ScanReport;
  diff: ContextDiff;
  persisted: PersistedContext;
  written: WriteContextResult | null;
  state: LocalState;
  workspace: WorkspaceInfo;
  git: { availability: GitAvailability; commitsAnalyzed: number };
  diagnostics: DiagnosticsCollector;
}

/** Rebuilds the workspace model from the parsed `package.json` files. */
export function detectWorkspaceFromScan(scan: ScanOutput): WorkspaceInfo {
  const packageJsonFiles: Array<{ path: string; facts: NonNullable<ReturnType<typeof packageFactsFromParsed>> }> = [];
  for (const [filePath, parsed] of scan.parsed) {
    const facts = packageFactsFromParsed(parsed);
    if (facts === null) continue;
    const isEmpty =
      facts.name === null &&
      facts.entries.length === 0 &&
      facts.dependencies.length === 0 &&
      Object.keys(facts.scripts).length === 0;
    if (isEmpty) continue;
    packageJsonFiles.push({ path: filePath, facts });
  }
  packageJsonFiles.sort((a, b) => compareStrings(a.path, b.path));
  return detectWorkspace({
    packageJsonFiles,
    presentFiles: scan.presentFiles,
    pnpmWorkspaceYaml: scan.pnpmWorkspaceYaml,
  });
}

function buildReport(options: {
  scan: ScanOutput;
  graph: KnowledgeGraph;
  parsedNow: number;
  reused: number;
  diagnostics: DiagnosticsCollector;
  durationMs: number;
}): ScanReport {
  const { scan, graph, diagnostics } = options;
  const moduleByFile = new Map(scan.files.map((file) => [file.path, file.moduleId]));
  const changedFiles = [...scan.changes.added, ...scan.changes.modified].sort(compareStrings);
  const affectedModules = new Set<string>();
  const dependents = new Set<string>();
  for (const file of changedFiles) {
    const moduleId = moduleByFile.get(file) ?? null;
    if (moduleId === null) continue;
    affectedModules.add(moduleId);
    for (const dependent of transitiveDependents(graph, moduleId, 1)) dependents.add(dependent);
  }
  const files = scan.files;
  return {
    changes: scan.changes,
    files: {
      total: files.length,
      source: files.filter((file) => file.kind === 'source').length,
      tests: files.filter((file) => file.kind === 'test').length,
      skipped: files.filter((file) => file.parseStatus === 'skipped').length,
      failed: files.filter((file) => file.parseStatus === 'failed').length,
    },
    modules: graph.repository.modules.length,
    dependencies: graph.repository.dependencies.length,
    externalDependencies: graph.repository.externalDependencies.length,
    entryPoints: graph.repository.entryPoints.length,
    conventions: graph.repository.conventions.length,
    decisions: graph.repository.decisions.length,
    parsed: options.parsedNow,
    reused: options.reused,
    affected: {
      files: changedFiles,
      modules: [...affectedModules].sort(compareStrings),
      dependents: [...dependents].sort(compareStrings),
    },
    durationMs: options.durationMs,
    warnings: diagnostics.list(),
  };
}

function emptyState(configHash: string, counts: LocalState['counts']): LocalState {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: 'ai-agent-context',
    toolVersion: '0.0.0',
    lastScanAt: null,
    configHash,
    counts,
    files: {},
    canonical: {},
  };
}

/** Runs the whole pipeline. */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const startedAt = options.now?.() ?? Date.now();
  const logger = options.logger ?? new Logger({ level: 'warn' });
  const diagnostics = new DiagnosticsCollector({ logger });
  const now = options.now ?? (() => Date.now());

  const loaded = await loadConfig({
    root: options.root,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  for (const warning of loaded.warnings) diagnostics.warn('WARN_CONFIG', warning);

  const root = options.root;
  const stateStore = new LocalStateStore(root);
  const cache = new ParseCache(root);
  const previousState = options.force === true ? null : await stateStore.read();
  const persisted = await readPersistedContext(root);
  for (const invalid of persisted.invalid) {
    diagnostics.warn('WARN_CONTEXT_FILE', `${invalid.file}: ${invalid.reason}`, {
      hint: 'Run: agent-context scan to regenerate the context.',
    });
  }

  const fsAdapter = new FileSystemAdapter(root);
  options.progress?.({ phase: 'start', message: 'Scanning repository...' });
  const scan = await scanRepository({
    root,
    config: loaded.config,
    configHash: loaded.hash,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    fsAdapter,
    state: previousState,
    cache,
    diagnostics,
    logger,
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });

  const workspace = detectWorkspaceFromScan(scan);
  const graph = buildKnowledgeGraph({
    root,
    repositoryName: fsAdapter.basename,
    scan,
    workspace,
    moduleDepth: loaded.config.analysis.moduleDepth,
    schemaVersion: SCHEMA_VERSION,
    languages: loaded.config.languages,
  });

  options.progress?.({ phase: 'architecture', message: 'Detecting modules, entry points and roles...' });
  applyArchitectureDetection(graph, scan.parsed);

  const gitResult = await analyzeGit({
    graph,
    config: loaded.config,
    root,
    now,
    logger,
    diagnostics,
    ...(options.gitAdapter === undefined ? {} : { gitAdapter: options.gitAdapter }),
  });

  if (loaded.config.features.conventions) {
    graph.repository.conventions = detectConventions({
      repository: graph.repository,
      parsed: scan.parsed,
      aliases: graph.aliases,
    });
  }
  if (loaded.config.features.decisions) {
    graph.repository.decisions = detectDecisions({
      repository: graph.repository,
      parsed: scan.parsed,
      gitCommits: gitResult.commits,
      architectureSignalPatterns: loaded.config.features.git
        ? loaded.config.analysis.git.architectureSignalPatterns
        : [],
    });
  }

  const generatedAt = loaded.config.output.includeTimestamp ? new Date(now()).toISOString() : undefined;
  const documents = buildContextDocuments(graph, scan.parsed, loaded.config, {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    diagnostics: diagnostics.list(),
    commitsAnalyzed: gitResult.commits.length,
  });

  const diff = diffContext({
    previous: persisted,
    current: documents,
    baselineHash: previousState?.canonical['index.json'] ?? null,
  });

  let written: WriteContextResult | null = null;
  if (options.dryRun !== true) written = await writeContext(root, documents, loaded.config);

  const report = buildReport({
    scan,
    graph,
    parsedNow: scan.parsedNow,
    reused: scan.reused,
    diagnostics,
    durationMs: Math.max(0, (options.now?.() ?? Date.now()) - startedAt),
  });

  const counts = {
    files: report.files.total,
    modules: report.modules,
    dependencies: report.dependencies,
    entryPoints: report.entryPoints,
    conventions: report.conventions,
    decisions: report.decisions,
  };

  const state: LocalState = previousState === null ? emptyState(loaded.hash, counts) : { ...previousState };
  state.schemaVersion = SCHEMA_VERSION;
  state.configHash = loaded.hash;
  state.counts = counts;
  state.lastScanAt = new Date(now()).toISOString();
  state.files = {};
  for (const file of graph.repository.files) {
    if (file.sensitive) continue;
    state.files[file.path] = {
      hash: file.hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      language: file.language,
      kind: file.kind,
    };
  }
  if (options.dryRun !== true) {
    state.canonical = written === null ? state.canonical : { ...state.canonical, ...written.hashes };
    await stateStore.write(state);
  }

  options.progress?.({ phase: 'done', message: 'Context updated.' });
  return {
    config: loaded.config,
    configHash: loaded.hash,
    graph,
    parsed: scan.parsed,
    documents,
    report,
    diff,
    persisted,
    written,
    state,
    workspace,
    git: { availability: gitResult.availability, commitsAnalyzed: gitResult.commits.length },
    diagnostics,
  };
}

interface GitAnalysisOptions {
  graph: KnowledgeGraph;
  config: AgentContextConfig;
  root: string;
  now: () => number;
  logger: Logger;
  diagnostics: DiagnosticsCollector;
  gitAdapter?: GitAdapter;
}

interface GitAnalysisResult {
  availability: GitAvailability;
  commits: Awaited<ReturnType<GitAdapter['log']>>;
}

/** Optional git enrichment; never fails the scan. */
async function analyzeGit(options: GitAnalysisOptions): Promise<GitAnalysisResult> {
  if (!options.config.features.git) {
    return { availability: { available: false, reason: 'feature disabled in .agent/config.json' }, commits: [] };
  }
  const adapter = options.gitAdapter ?? new GitAdapter(options.root);
  const availability = await adapter.probe();
  if (availability.available !== true) {
    options.diagnostics.info(
      'INFO_GIT_UNAVAILABLE',
      `git signals unavailable: ${availability.reason ?? 'not a git repository'}`,
      { hint: 'Analysis continues without git activity data.' },
    );
    return { availability, commits: [] };
  }
  const commits = await adapter.log({
    windowDays: options.config.analysis.git.windowDays,
    maxCommits: options.config.analysis.git.maxCommits,
  });
  const activity = computeGitActivity({
    commits,
    files: options.graph.repository.files,
    modules: options.graph.repository.modules,
    recentDays: options.config.analysis.git.recentDays,
    architectureSignalPatterns: options.config.analysis.git.architectureSignalPatterns,
    now: options.now(),
  });
  applyGitSignals(options.graph.repository.modules, activity);
  options.logger.verbose(
    `git: analyzed ${activity.commitCount} commit(s) from the last ${options.config.analysis.git.windowDays} days`,
  );
  return { availability, commits };
}

/** Stable hash of the canonical documents; used by `status`. */
export function documentHash(documents: ContextDocuments): string {
  return hashDocuments(documents);
}
