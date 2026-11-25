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
import { compareStrings, hashValue, sha256 } from '../../model/canonical.ts';
import { TOOL_VERSION } from '../../model/version.ts';
import { basename, extname } from '../../util/paths.ts';
import { mapWithConcurrency, runWithConcurrency, defaultConcurrency } from '../../util/concurrency.ts';
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
  /**
   * Hashes recorded by the committed `index.json`, used as the baseline when
   * there is no local state.
   *
   * `.agent/.local/state.json` is gitignored, so a fresh clone — every CI
   * checkout — has none. Without a baseline every file then classifies as
   * "added" and the context reads as stale no matter how well it matches the
   * tree. The committed index records a hash for each analyzed file, which is
   * exactly the comparison `verify` needs: do these files still have the
   * contents the context was generated from?
   */
  baseline?: ReadonlyMap<string, string>;
  cache: ParseCache;
  /**
   * When true, nothing is written to `.agent/`, including the parse cache.
   *
   * A dry run still *reads* the cache, so `status` and `diff` stay fast; it
   * simply does not grow the cache while doing it. Without this, every read-only
   * query created `.agent/.local/` in a repository it was only supposed to read,
   * which contradicted the pipeline's documented contract and undermined
   * read-only mode.
   */
  dryRun?: boolean;
  /**
   * Bypass the parse cache as well as the local state.
   *
   * `--force` means "analyse this again from the source". Reading every file
   * and then serving its parse result from the cache is not that, and it made
   * the flag useless in the one situation a user reaches for it: suspecting
   * that what is cached no longer describes the file.
   */
  force?: boolean;
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

/**
 * Builds the include/exclude/ignore pattern sets.
 *
 * `.gitignore` files are deliberately not among them. The walker reads those
 * itself, one per directory, the way git does. Folding the root file into one
 * flat list — as this did until 1.1.0 — is what left every package's own
 * `.gitignore` unread.
 */
export function buildPatterns(config: AgentContextConfig): {
  include: PatternSet;
  exclude: PatternSet;
  ignore: PatternSet;
} {
  return {
    include: new PatternSet(config.include.map((pattern) => (pattern.endsWith('/') ? `${pattern}**` : pattern))),
    exclude: new PatternSet(config.exclude),
    ignore: new PatternSet(config.ignore),
  };
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
  const patterns = buildPatterns(config);

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
  const baseline = options.baseline ?? null;
  const incremental =
    options.state !== null &&
    options.state.configHash === options.configHash &&
    // Invalidates the cache when the tool itself is upgraded: parser behaviour
    // and canonical output may change between releases.
    options.state.toolVersion === TOOL_VERSION;
  const changes = emptyChanges(incremental);

  const entries: ScanEntry[] = walked.map((file) => {
    const record = previous[file.path];
    const sensitive = sensitiveFilter.isBlocked(file.path);
    const tooLarge = file.size > config.analysis.maxFileSizeBytes;
    const fastUnchanged =
      record !== undefined && record.hash.length > 0 && record.size === file.size && record.mtimeMs === file.mtimeMs;
    return {
      walked: file,
      previousHash: record?.hash ?? baseline?.get(file.path) ?? null,
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
  // What a file parses to depends on more than its bytes: the enabled languages
  // decide whether it is parsed at all, and the registered adapters decide how.
  // Keyed by content alone, the cache served TypeScript facts for a file under
  // `languages: ["json"]`, and the default adapter's parse to a custom adapter
  // that was registered to replace it. The key therefore carries both.
  const cacheNamespace = hashValue({
    languages: [...config.languages].sort(compareStrings),
    adapters: registry.list().map((adapter) => adapter.id).sort(compareStrings),
  });
  const cacheKey = (contentHash: string): string => sha256(`${contentHash}\u0000${cacheNamespace}`);

  options.progress?.({
    phase: 'parse',
    message: `Analyzing ${toRead.length} changed file(s)...`,
    completed: 0,
    total: toRead.length,
  });

  const parseWithCache = async (entry: ScanEntry, contents: string, hash: string): Promise<void> => {
    const snapshot = options.force === true ? null : await options.cache.get(cacheKey(hash));
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
    if (options.dryRun !== true) {
      cacheWrites.push(async () => {
        try {
          await options.cache.put(cacheKey(hash), toSnapshot(parsed));
        } catch (error) {
          diagnostics.warn('WARN_CACHE_WRITE', error instanceof Error ? error.message : String(error));
        }
      });
    }
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
    const snapshot = entry.hash.length > 0 ? await options.cache.get(cacheKey(entry.hash)) : null;
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

  // Cache writes are independent and I/O bound, so they are flushed with the same
  // bounded concurrency as the reads. Awaiting them one at a time turned a full
  // cold scan into one sequential mkdir + writeFile per file.
  await runWithConcurrency(concurrency, cacheWrites);

  // Change classification happens after hashing, so an mtime-only touch of an
  // unchanged file is still reported as "unchanged".
  for (const entry of entries) {
    const path = entry.walked.path;
    // Sensitive and oversized files are never content-hashed, so they have no
    // previous hash by construction. Treating them as "added" would make the
    // context permanently "stale" (`status`, `verify`) even when nothing in the
    // repository has changed. They are recorded as unchanged instead.
    if (entry.sensitive || entry.tooLarge) {
      changes.unchanged.push(path);
      continue;
    }
    if (entry.previousHash === null) {
      changes.added.push(path);
      continue;
    }
    const hashMatches = entry.hash.length > 0 && entry.hash === entry.previousHash;
    if (hashMatches || entry.fastUnchanged) changes.unchanged.push(path);
    else changes.modified.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!presentFiles.has(path)) changes.deleted.push(path);
  }
  // A file the committed context describes that is no longer in the tree was
  // deleted since the context was generated.
  if (baseline !== null) {
    for (const path of baseline.keys()) {
      if (!presentFiles.has(path) && !(path in previous)) changes.deleted.push(path);
    }
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

  if (files.length === 0) {
    diagnostics.warn('WARN_NO_FILES_MATCHED', 'no files matched the include patterns: nothing was analyzed', {
      hint: 'Check "include" in .agent/config.json or pass --include. The defaults already cover src/, app/, packages/ and source files at any depth.',
    });
  }

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