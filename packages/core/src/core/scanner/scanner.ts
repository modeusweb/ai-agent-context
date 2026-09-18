/**
 * Repository scanner.
 *
 * Pipeline: walk → decide what changed → parse only what changed → emit file
 * facts. Parsing is content-addressed, so:
 *
 * - a file whose size and mtime are unchanged is never read at all;
 * - a changed file is hashed and, when its hash is already cached, not re-parsed;
 * - a new file that is byte-identical to an existing one reuses its cache entry.
 *
 * The scanner performs no language specific work: adapters are resolved through
 * the {@link LanguageRegistry} and return the language-agnostic IR.
 */
import type { ChangeSet, FileKind, FileNode } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { AgentContextConfig } from '../../config/types.ts';
import { PatternSet } from '../../util/glob.ts';
import { compareStrings, sha256 } from '../../model/canonical.ts';
import { basename, extname } from '../../util/paths.ts';
import { mapWithConcurrency, defaultConcurrency } from '../../util/concurrency.ts';
import type { DiagnosticsCollector, Logger, ProgressReporter } from '../../logging/diagnostics.ts';
import { FileSystemAdapter, type WalkedFile } from '../../adapters/filesystem/fs-adapter.ts';
import { SensitivePathFilter } from '../../adapters/filesystem/sensitive.ts';
import { LanguageRegistry, createDefaultRegistry } from '../../adapters/language/registry.ts';
import type { ParseCache, LocalState } from './cache.ts';
import { fromSnapshot, toSnapshot } from './types.ts';

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|__mocks__|e2e)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.(md|json)$/,
];

const CONFIG_BASENAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'package.json',
  'pnpm-workspace.yaml',
  'bunfig.toml',
  'Dockerfile',
  'Makefile',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
]);

const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.properties']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.pdf',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);

/** Classifies a file, language agnostically. */
export function classifyFile(path: string, signals: readonly string[] = []): FileKind {
  const normalized = path.replace(/\\/g, '/');
  const name = basename(normalized);
  const extension = extname(normalized).toLowerCase();

  if (TEST_PATTERNS.some((pattern) => pattern.test(normalized)) || signals.includes('test:suite')) return 'test';
  if (DOC_EXTENSIONS.has(extension)) return 'docs';
  if (
    CONFIG_BASENAMES.has(name) ||
    CONFIG_EXTENSIONS.has(extension) ||
    /\.config\.[cm]?[jt]s$/.test(name) ||
    normalized.startsWith('.github/') ||
    (name.startsWith('.') && name.length > 1)
  ) {
    return 'config';
  }
  if (ASSET_EXTENSIONS.has(extension)) return 'asset';
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';
  return 'other';
}

export interface ScanOptions {
  root: string;
  config: AgentContextConfig;
  /** Hash of the resolved configuration, used for cache invalidation. */
  configHash: string;
  registry?: LanguageRegistry;
  fsAdapter?: FileSystemAdapter;
  /** Previous local state, when available (enables the incremental path). */
  state: LocalState | null;
  cache: ParseCache;
  diagnostics: DiagnosticsCollector;
  logger: Logger;
  progress?: ProgressReporter;
}

export interface ScanOutput {
  files: FileNode[];
  /** Parsed facts of every readable file, keyed by repository-relative path. */
  parsed: Map<string, ParsedFile>;
  changes: ChangeSet;
  /** Number of files whose content was parsed during this scan. */
  parsedNow: number;
  /** Number of files served from the local parse cache without being parsed. */
  reused: number;
  skippedSensitive: string[];
  skippedLarge: string[];
  failed: string[];
  partial: string[];
  /** All walked paths, used for lockfile and workspace detection. */
  presentFiles: Set<string>;
  /** Raw contents of pnpm-workspace.yaml, when present. */
  pnpmWorkspaceYaml: string | null;
}

interface ScanEntry {
  walked: WalkedFile;
  previousHash: string | null;
  fastUnchanged: boolean;
  sensitive: boolean;
  tooLarge: boolean;
  hash: string;
  parse: ParsedFile | null;
}

function emptyChanges(incremental: boolean): ChangeSet {
  return { added: [], modified: [], deleted: [], unchanged: [], incremental };
}

/** Builds the include/exclude/ignore pattern sets, merging the root .gitignore. */
async function buildPatterns(
  config: AgentContextConfig,
  fsAdapter: FileSystemAdapter,
): Promise<{ include: PatternSet; exclude: PatternSet; ignore: PatternSet }> {
  const include = new PatternSet(config.include.map((pattern) => (pattern.endsWith('/') ? `${pattern}**` : pattern)));
  const exclude = new PatternSet(config.exclude);
  const ignorePatterns = [...config.ignore];
  const gitignore = await fsAdapter.tryReadText('.gitignore');
  if (gitignore !== null) {
    for (const line of gitignore.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      if (!ignorePatterns.includes(trimmed)) ignorePatterns.push(trimmed);
    }
  }
  return { include, exclude, ignore: new PatternSet(ignorePatterns) };
}

/**
 * Scans a repository and returns file level facts plus the change set relative to
 * the previous local state.
 */
export async function scanRepository(options: ScanOptions): Promise<ScanOutput> {
  const { config, diagnostics } = options;
  const registry = options.registry ?? createDefaultRegistry();
  const fsAdapter = options.fsAdapter ?? new FileSystemAdapter(options.root);
  const concurrency = config.analysis.concurrency > 0 ? config.analysis.concurrency : defaultConcurrency();
  const sensitiveFilter = new SensitivePathFilter({
    allowSensitiveFiles: config.security.allowSensitiveFiles,
    extraSensitivePatterns: config.security.extraSensitivePatterns,
  });
  const patterns = await buildPatterns(config, fsAdapter);

  options.progress?.({ phase: 'walk', message: 'Scanning repository...' });
  const walked = await fsAdapter.walk({
    include: patterns.include,
    exclude: patterns.exclude,
    ignore: patterns.ignore,
    followSymlinks: config.analysis.followSymlinks,
    onDirectory: (directory) => options.logger.verbose(`walk ${directory}/`),
  });

  const presentFiles = new Set(walked.map((file) => file.path));
  const previous = options.state?.files ?? {};
  const incremental = options.state !== null && options.state.configHash === options.configHash;
  const changes = emptyChanges(incremental);

  const entries: ScanEntry[] = walked.map((file) => {
    const record = previous[file.path];
    const sensitive = sensitiveFilter.isBlocked(file.path);
    const tooLarge = file.size > config.analysis.maxFileSizeBytes;
    const fastUnchanged =
      record !== undefined && record.hash.length > 0 && record.size === file.size && record.mtimeMs === file.mtimeMs;
    return {
      walked: file,
      previousHash: record?.hash ?? null,
      fastUnchanged,
      sensitive,
      tooLarge,
      hash: '',
      parse: null,
    };
  });

  const skippedSensitive = entries.filter((entry) => entry.sensitive).map((entry) => entry.walked.path);
  const skippedLarge = entries.filter((entry) => !entry.sensitive && entry.tooLarge).map((entry) => entry.walked.path);
  for (const path of skippedLarge) {
    diagnostics.warn('WARN_FILE_TOO_LARGE', `skipped large file ${path}`, {
      source: path,
      hint: `size exceeds analysis.maxFileSizeBytes (${config.analysis.maxFileSizeBytes})`,
    });
  }

  const work = entries.filter((entry) => !entry.sensitive && !entry.tooLarge);
  const toRead = work.filter((entry) => !entry.fastUnchanged);
  const toReuse = work.filter((entry) => entry.fastUnchanged);
  let reused = 0;
  let parsedNow = 0;
  const cacheWrites: Array<() => Promise<void>> = [];

  options.progress?.({
    phase: 'parse',
    message: `Analyzing ${toRead.length} changed file(s)...`,
    completed: 0,
    total: toRead.length,
  });

  const parseWithCache = async (entry: ScanEntry, contents: string, hash: string): Promise<void> => {
    const snapshot = await options.cache.get(hash);
    if (snapshot !== null) {
      entry.parse = fromSnapshot(snapshot);
      reused += 1;
      return;
    }
    const parsed = registry.parseFile(entry.walked.path, contents, config.languages);
    entry.parse = parsed;
    parsedNow += 1;
    for (const diagnostic of parsed.diagnostics) {
      diagnostics.add(diagnostic.source === undefined ? { ...diagnostic, source: entry.walked.path } : diagnostic);
    }
    cacheWrites.push(() => options.cache.put(hash, toSnapshot(parsed)));
  };

  let processed = 0;
  await mapWithConcurrency(toRead, concurrency, async (entry) => {
    try {
      const contents = await fsAdapter.readText(entry.walked.path);
      entry.hash = sha256(contents);
      await parseWithCache(entry, contents, entry.hash);
    } catch (error) {
      diagnostics.warn('WARN_FILE_UNREADABLE', `failed to read ${entry.walked.path}`, {
        source: entry.walked.path,
        hint: error instanceof Error ? error.message : String(error),
      });
    }
    processed += 1;
    options.progress?.({
      phase: 'parse',
      message: `Analyzing ${toRead.length} changed file(s)...`,
      completed: processed,
      total: toRead.length,
    });
  });

  await mapWithConcurrency(toReuse, concurrency, async (entry) => {
    entry.hash = entry.previousHash ?? '';
    const snapshot = entry.hash.length > 0 ? await options.cache.get(entry.hash) : null;
    if (snapshot !== null) {
      entry.parse = fromSnapshot(snapshot);
      reused += 1;
      return;
    }
    // Cache miss (fresh checkout or cleared cache): fall back to reading the file.
    try {
      const contents = await fsAdapter.readText(entry.walked.path);
      if (entry.hash.length === 0) entry.hash = sha256(contents);
      await parseWithCache(entry, contents, entry.hash);
    } catch (error) {
      diagnostics.warn('WARN_FILE_UNREADABLE', `failed to read ${entry.walked.path}`, {
        source: entry.walked.path,
        hint: error instanceof Error ? error.message : String(error),
      });
    }
  });

  for (const write of cacheWrites) {
    try {
      await write();
    } catch (error) {
      diagnostics.warn('WARN_CACHE_WRITE', error instanceof Error ? error.message : String(error));
    }
  }

  // Change classification happens after hashing, so an mtime-only touch of an
  // unchanged file is still reported as "unchanged".
  for (const entry of entries) {
    const path = entry.walked.path;
    if (entry.previousHash === null) {
      changes.added.push(path);
      continue;
    }
    const hashMatches = entry.hash.length > 0 && entry.hash === entry.previousHash;
    if (hashMatches || entry.sensitive || entry.tooLarge || entry.fastUnchanged) changes.unchanged.push(path);
    else changes.modified.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!presentFiles.has(path)) changes.deleted.push(path);
  }
  changes.added.sort(compareStrings);
  changes.modified.sort(compareStrings);
  changes.deleted.sort(compareStrings);
  changes.unchanged.sort(compareStrings);

  const parsedMap = new Map<string, ParsedFile>();
  const failed: string[] = [];
  const partial: string[] = [];
  const files: FileNode[] = [];
  for (const entry of entries) {
    const path = entry.walked.path;
    if (entry.sensitive) {
      files.push({
        path,
        hash: '',
        size: entry.walked.size,
        mtimeMs: entry.walked.mtimeMs,
        language: 'unknown',
        kind: 'other',
        moduleId: null,
        packageName: null,
        symbolIds: [],
        importSpecifiers: [],
        signals: ['skipped:sensitive'],
        sensitive: true,
        parseStatus: 'skipped',
      });
      continue;
    }
    if (entry.parse !== null) parsedMap.set(path, entry.parse);
    const parseStatus = entry.parse?.parseStatus ?? 'skipped';
    if (parseStatus === 'failed') failed.push(path);
    if (parseStatus === 'partial') partial.push(path);
    files.push({
      path,
      hash: entry.hash,
      size: entry.walked.size,
      mtimeMs: entry.walked.mtimeMs,
      language: entry.parse?.language ?? 'unknown',
      kind: classifyFile(path, entry.parse?.signals ?? []),
      moduleId: null,
      packageName: null,
      symbolIds: [],
      importSpecifiers:
        entry.parse === null
          ? []
          : [...new Set(entry.parse.imports.map((record) => record.specifier))].sort(compareStrings),
      signals: entry.parse?.signals ?? [],
      sensitive: false,
      parseStatus,
    });
  }
  files.sort((a, b) => compareStrings(a.path, b.path));

  options.progress?.({ phase: 'done', message: `Analyzed ${files.length} file(s)` });
  return {
    files,
    parsed: parsedMap,
    changes,
    parsedNow,
    reused,
    skippedSensitive: skippedSensitive.sort(compareStrings),
    skippedLarge: skippedLarge.sort(compareStrings),
    failed: failed.sort(compareStrings),
    partial: partial.sort(compareStrings),
    presentFiles,
    pnpmWorkspaceYaml: await fsAdapter.tryReadText('pnpm-workspace.yaml'),
  };
}