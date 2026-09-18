/**
 * File system adapter.
 *
 * Responsibilities:
 * - deterministic, streaming directory traversal (never loads file contents here);
 * - include/exclude/ignore glob evaluation with safe directory pruning;
 * - bounded concurrency for stat/hash/read work is owned by the callers.
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
  exclude?: PatternSet;
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

/** Leading literal directory of a glob pattern, used for directory pruning. */
function literalPrefix(pattern: string): string {
  const segments = pattern.replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[{]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
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
   */
  async walk(options: WalkOptions = {}): Promise<WalkedFile[]> {
    const files: WalkedFile[] = [];
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const canPrune = this.canPrune(options.include);
    const queue: string[] = [''];

    while (queue.length > 0) {
      const relativeDir = queue.shift()!;
      const absoluteDir = relativeDir.length === 0 ? this.root : path.join(this.root, relativeDir);
      let entries;
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true });
      } catch {
        // Unreadable directory: analysis continues and the caller reports a warning.
        continue;
      }
      entries.sort((a, b) => compareStrings(a.name, b.name));
      for (const entry of entries) {
        const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
        const absolutePath = path.join(absoluteDir, entry.name);
        const isSymbolicLink = entry.isSymbolicLink();
        if (entry.isDirectory() || isSymbolicLink) {
          if (isSymbolicLink && options.followSymlinks !== true) continue;
          if (this.isExcludedDirectory(relativePath, options)) continue;
          if (canPrune && !this.canContainIncluded(relativePath, options.include)) continue;
          options.onDirectory?.(relativePath);
          queue.push(relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (this.isExcludedFile(relativePath, options)) continue;
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

  private isExcludedDirectory(relativePath: string, options: WalkOptions): boolean {
    if (options.exclude?.test(relativePath, true)) return true;
    if (options.ignore?.test(relativePath, true)) return true;
    return false;
  }

  private isExcludedFile(relativePath: string, options: WalkOptions): boolean {
    if (options.exclude?.test(relativePath, false)) return true;
    if (options.ignore?.test(relativePath, false)) return true;
    return false;
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