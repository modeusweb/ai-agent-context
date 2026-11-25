/**
 * File system adapter.
 *
 * Responsibilities:
 * - deterministic, streaming directory traversal (never loads file contents here);
 * - include/exclude/ignore glob evaluation with safe directory pruning;
 * - `.gitignore` files, read the way git reads them: one per directory, a
 *   deeper one overriding a shallower one.
 *
 * The rest of the pipeline only talks to this adapter, so swapping in a virtual
 * file system (or a remote checkout) later does not touch the analysis core.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { toPosix, normalizeRelative } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';
import { PatternSet } from '../../util/glob.ts';

export interface WalkedFile {
  /** Repository-relative POSIX path. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  size: number;
  mtimeMs: number;
  isSymbolicLink: boolean;
}

export interface WalkOptions {
  /** Include patterns; an empty set means "everything not excluded". */
  include?: PatternSet;
  /** Exclude patterns; a match is never walked. */
  exclude?: PatternSet;
  /**
   * Ignore patterns from the configuration. They outrank every `.gitignore`
   * file, as command-line excludes do in git.
   */
  ignore?: PatternSet;
  followSymlinks?: boolean;
  /** Safety valve for pathological trees (default: 500_000). */
  maxFiles?: number;
  /** Streaming callback; called as soon as a file is discovered. */
  onFile?: (file: WalkedFile) => void;
  /** Directory visited callback, used for progress reporting. */
  onDirectory?: (relativePath: string) => void;
}

const DEFAULT_MAX_FILES = 500_000;

/** One ignore file: its rules, and the directory they are relative to. */
interface IgnoreLayer {
  /** Repository-relative POSIX path of the directory the file lives in. */
  base: string;
  /** Repository-relative path of the file, for diagnostics. */
  source: string;
  rules: PatternSet;
}

/** Leading literal directory of a glob pattern, used for directory pruning. */
function literalPrefix(pattern: string): string {
  // Normalised the way the rule itself is (`/src/**` is rooted at `src`), so
  // that pruning looks in the same place the rule matches.
  const segments = normalizePatternPrefix(pattern).split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[{]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

function normalizePatternPrefix(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The patterns of an ignore file, in order, without comments and blank lines. */
function ignoreFilePatterns(contents: string): string[] {
  const patterns: string[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

export class FileSystemAdapter {
  readonly root: string;
  private readonly prefixes: string[] = [];

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Traverses the repository, returning files sorted by path.
   *
   * Traversal is breadth-first with an explicit queue, so deep trees cannot blow
   * the call stack, and directory entries are read in sorted order so that the
   * resulting context does not depend on file system ordering.
   *
   * Each directory carries the ignore files that apply below it. Until 1.1.0
   * only the root `.gitignore` was read, so in a monorepo — where packages
   * commonly ignore their own generated directories — everything a package had
   * asked git to forget was analyzed as source: generated clients, build caches
   * and snapshots joined the dependency graph and the module file lists.
   */
  async walk(options: WalkOptions = {}): Promise<WalkedFile[]> {
    const files: WalkedFile[] = [];
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const canPrune = this.canPrune(options.include);
    const queue: Array<{ directory: string; layers: readonly IgnoreLayer[] }> = [
      { directory: '', layers: await this.rootIgnoreLayers() },
    ];

    while (queue.length > 0) {
      const { directory: relativeDir, layers } = queue.shift()!;
      const absoluteDir = relativeDir.length === 0 ? this.root : path.join(this.root, relativeDir);
      let entries;
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true });
      } catch {
        // Unreadable directory: analysis continues and the caller reports a warning.
        continue;
      }
      entries.sort((a, b) => compareStrings(a.name, b.name));
      // The directory's own ignore file governs what is below it.
      const own = entries.find((entry) => entry.name === '.gitignore' && entry.isFile());
      const below = own === undefined ? layers : [...layers, await this.ignoreLayer(relativeDir)];
      for (const entry of entries) {
        const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
        const absolutePath = path.join(absoluteDir, entry.name);
        const isSymbolicLink = entry.isSymbolicLink();
        if (entry.isDirectory() || isSymbolicLink) {
          if (isSymbolicLink && options.followSymlinks !== true) continue;
          if (this.isIgnored(relativePath, true, options, below)) continue;
          if (canPrune && !this.canContainIncluded(relativePath, options.include)) continue;
          options.onDirectory?.(relativePath);
          queue.push({ directory: relativePath, layers: below });
          continue;
        }
        if (!entry.isFile()) continue;
        if (this.isIgnored(relativePath, false, options, below)) continue;
        if (!this.matchesInclude(relativePath, options.include)) continue;
        let stats;
        try {
          stats = await stat(absolutePath);
        } catch {
          continue;
        }
        const walked: WalkedFile = {
          path: relativePath,
          absolutePath,
          size: stats.size,
          mtimeMs: Math.round(stats.mtimeMs),
          isSymbolicLink,
        };
        files.push(walked);
        options.onFile?.(walked);
        if (files.length >= maxFiles) return files;
      }
    }
    files.sort((a, b) => compareStrings(a.path, b.path));
    return files;
  }

  /**
   * Whether a path is left out of the walk.
   *
   * Lowest precedence first: the repository's ignore files, shallower before
   * deeper — a rule in `packages/foo/.gitignore` overrides one in the root
   * file, and can even re-include a file the root file ignores. Above them all
   * sits the configured `ignore` list, and above that `exclude`, which nothing
   * re-includes. That is git's order, with the configuration in the place of
   * its command-line excludes.
   */
  private isIgnored(
    relativePath: string,
    isDirectory: boolean,
    options: WalkOptions,
    layers: readonly IgnoreLayer[],
  ): boolean {
    if (options.exclude?.test(relativePath, isDirectory)) return true;
    let ignored = false;
    for (const layer of layers) {
      const relative = layer.base.length === 0 ? relativePath : relativePath.slice(layer.base.length + 1);
      const decision = layer.rules.decision(relative, isDirectory);
      if (decision !== undefined) ignored = decision;
    }
    const configured = options.ignore?.decision(relativePath, isDirectory);
    if (configured !== undefined) ignored = configured;
    return ignored;
  }

  /** The ignore files that apply to the whole repository, weakest first. */
  private async rootIgnoreLayers(): Promise<IgnoreLayer[]> {
    const layers: IgnoreLayer[] = [];
    // Git's per-clone list. Below every `.gitignore` in precedence, as in git.
    const exclude = await this.tryReadText('.git/info/exclude');
    if (exclude !== null) layers.push({ base: '', source: '.git/info/exclude', rules: new PatternSet(ignoreFilePatterns(exclude)) });
    const root = await this.tryReadText('.gitignore');
    if (root !== null) layers.push({ base: '', source: '.gitignore', rules: new PatternSet(ignoreFilePatterns(root)) });
    return layers;
  }

  private async ignoreLayer(directory: string): Promise<IgnoreLayer> {
    const source = directory.length === 0 ? '.gitignore' : `${directory}/.gitignore`;
    const contents = await this.tryReadText(source);
    return { base: directory, source, rules: new PatternSet(ignoreFilePatterns(contents ?? '')) };
  }

  private matchesInclude(relativePath: string, include: PatternSet | undefined): boolean {
    if (!include || include.isEmpty) return true;
    return include.matchesAny(relativePath);
  }

  /** `true` when directory pruning is safe for the configured include patterns. */
  private canPrune(include: PatternSet | undefined): boolean {
    if (!include || include.isEmpty) return false;
    const prefixes = include.rules.filter((rule) => !rule.negated).map((rule) => literalPrefix(rule.raw));
    if (prefixes.length === 0 || prefixes.some((prefix) => prefix.length === 0)) return false;
    this.prefixes.length = 0;
    this.prefixes.push(...new Set(prefixes));
    return true;
  }

  private canContainIncluded(relativeDir: string, include: PatternSet | undefined): boolean {
    if (!include || this.prefixes.length === 0) return true;
    const normalized = normalizeRelative(relativeDir);
    return this.prefixes.some(
      (prefix) => prefix === normalized || prefix.startsWith(`${normalized}/`) || normalized.startsWith(`${prefix}/`),
    );
  }

  exists(relativePath: string): boolean {
    return existsSync(path.join(this.root, relativePath));
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(path.join(this.root, relativePath), 'utf8');
  }

  async readJson<T = unknown>(relativePath: string): Promise<T> {
    const contents = await this.readText(relativePath);
    return JSON.parse(contents) as T;
  }

  async tryReadText(relativePath: string): Promise<string | null> {
    try {
      return await this.readText(relativePath);
    } catch {
      return null;
    }
  }

  toRelative(absolutePath: string): string {
    return toPosix(path.relative(this.root, absolutePath));
  }

  toAbsolute(relativePath: string): string {
    return path.join(this.root, relativePath);
  }

  get basename(): string {
    return path.basename(this.root);
  }
}
