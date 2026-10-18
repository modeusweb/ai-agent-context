/**
 * Import resolution.
 *
 * Resolution is deterministic and purely in-memory: it looks only at the set of
 * analyzed files plus alias/workspace metadata, which is why a single file change
 * never triggers a full repository re-read.
 *
 * Classification distinguishes the dependency kinds the task requires: internal
 * file, workspace package, external package and Node built-in modules (plus an
 * honest `unresolved` result with the candidates that were tried).
 */
import { builtinModules } from 'node:module';
import type { DependencyKind } from '../../model/types.ts';
import type { UnresolvedReason } from '../../model/types.ts';
import { escapesRoot, extname, dirname, join, joinStrict, normalizeRelative } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';
import { packageNameFromSpecifier } from '../../adapters/language/ts-js/package-signals.ts';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/**
 * `true` when a specifier is provided by Node.js itself.
 *
 * Built-ins are platform capabilities, not architectural choices, so the
 * bounded projections rank them below real dependencies instead of letting
 * `node:fs` and `node:path` crowd out the packages that actually say something
 * about the project.
 */
export function isNodeBuiltin(name: string): boolean {
  return BUILTINS.has(name);
}

/** Extensions tried when a specifier has no extension, in deterministic order. */
export const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** TypeScript ESM rewrite: `./x.js` may be emitted from `./x.ts`. */
const ESM_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
  '.d.ts': ['.d.ts'],
};

export interface AliasEntry {
  /** Pattern such as `@app/*` or `@app/domain`. */
  pattern: string;
  /** Replacement targets, e.g. `src/*`. */
  targets: string[];
  /** Directory that relative targets are resolved against. */
  base: string;
  /** tsconfig that declared the alias. */
  source: string;
}

export interface ResolverInput {
  /** All analyzed file paths (repository-relative POSIX). */
  filePaths: ReadonlySet<string>;
  /**
   * Files that exist but were excluded from the analysis, with the reason.
   *
   * Without this, an import of an excluded file looks exactly like an import of
   * a file that does not exist. The two mean very different things: the first
   * is a limit of the analysis, the second is a hole in the graph. Reporting
   * both as missing made a repository with large declaration files look as if
   * a third of its imports were broken.
   */
  excludedFiles?: ReadonlyMap<string, string>;
  /** Path aliases collected from tsconfig files. */
  aliases: AliasEntry[];
  /** Workspace package name → package directory and entry candidates. */
  workspacePackages: Map<string, { directory: string; entries: string[] }>;
}

export interface ResolvedImport {
  kind: DependencyKind;
  /** Resolved file path, package name or builtin name. */
  target: string;
  /** Entry file of a workspace package, when known. */
  entry: string | null;
  confidence: number;
  evidence: string;
  /** Candidates that were tried and rejected (only for unresolved imports). */
  attempts: string[];
  /** Why the import did not resolve, when it did not. */
  reason?: UnresolvedReason;
}

/** Tries the extension and index-file candidates of a specifier base path. */
export function withExtensions(base: string, filePaths: ReadonlySet<string>): string | null {
  const normalized = normalizeRelative(base);
  if (filePaths.has(normalized)) return normalized;
  const extension = extname(normalized);
  if (extension.length > 0) {
    const rewrites = ESM_TO_TS[extension];
    if (rewrites === undefined) return null;
    const stem = normalized.slice(0, -extension.length);
    for (const candidate of rewrites) {
      if (filePaths.has(`${stem}${candidate}`)) return `${stem}${candidate}`;
    }
    return null;
  }
  for (const candidate of RESOLUTION_EXTENSIONS) {
    if (filePaths.has(`${normalized}${candidate}`)) return `${normalized}${candidate}`;
  }
  for (const candidate of RESOLUTION_EXTENSIONS) {
    if (filePaths.has(`${normalized}/index${candidate}`)) return `${normalized}/index${candidate}`;
  }
  return null;
}

function unresolved(specifier: string, attempts: string[], reason: UnresolvedReason = 'missing'): ResolvedImport {
  return {
    kind: 'unresolved',
    target: specifier,
    entry: null,
    confidence: 0.3,
    evidence: `could not resolve "${specifier}" to an analyzed file`,
    attempts,
    reason,
  };
}

/**
 * The paths a specifier base could refer to, in the order they are tried.
 *
 * The same set the resolver searches for analyzed files, so that a file which
 * exists but is excluded is found by the same rules that would have found it
 * otherwise.
 */
function excludedCandidates(base: string): string[] {
  const normalized = normalizeRelative(base);
  const candidates = [normalized];
  const extension = extname(normalized);
  if (extension.length > 0) {
    const rewrites = ESM_TO_TS[extension];
    if (rewrites !== undefined) {
      const stem = normalized.slice(0, -extension.length);
      for (const candidate of rewrites) candidates.push(`${stem}${candidate}`);
    }
  } else {
    for (const candidate of RESOLUTION_EXTENSIONS) candidates.push(`${normalized}${candidate}`);
    for (const candidate of RESOLUTION_EXTENSIONS) candidates.push(`${normalized}/index${candidate}`);
  }
  return candidates;
}

export class ImportResolver {
  private readonly filePaths: ReadonlySet<string>;
  private readonly excludedFiles: ReadonlyMap<string, string>;
  private readonly aliases: AliasEntry[];
  private readonly workspacePackages: ResolverInput['workspacePackages'];

  constructor(input: ResolverInput) {
    this.filePaths = input.filePaths;
    this.excludedFiles = input.excludedFiles ?? new Map();
    // Deeper `base` first: the tsconfig closest to the importing file wins.
    this.aliases = [...input.aliases].sort((a, b) =>
      a.base.length === b.base.length ? compareStrings(a.pattern, b.pattern) : b.base.length - a.base.length,
    );
    this.workspacePackages = input.workspacePackages;
  }

  /**
   * Whether a specifier base points at a file that exists but was excluded.
   *
   * The reason is what makes the difference visible: a file excluded for being
   * too large and one excluded by the sensitive-file policy are both limits of
   * the analysis, and both are worth naming.
   */
  private excludedTarget(base: string): { path: string; reason: string } | null {
    if (this.excludedFiles.size === 0) return null;
    for (const candidate of excludedCandidates(base)) {
      const reason = this.excludedFiles.get(candidate);
      if (reason !== undefined) return { path: candidate, reason };
    }
    return null;
  }

  /** Resolves a specifier written in `fromFile`. */
  resolve(specifier: string, fromFile: string): ResolvedImport {
    const normalizedSpecifier = specifier.replace(/\\/g, '/');
    if (normalizedSpecifier.length === 0) return unresolved(specifier, ['empty specifier']);

    if (normalizedSpecifier.startsWith('.') || normalizedSpecifier.startsWith('/')) {
      // `join` collapses `..` eagerly, which would hide a traversal attempt, so
      // the join is computed in strict mode and the escape checked explicitly.
      const joined = joinStrict(dirname(fromFile), normalizedSpecifier);
      if (joined.escaped || joined.absolute) {
        return unresolved(
          specifier,
          [`relative specifier "${specifier}" resolves outside the repository root`],
          'path-escape',
        );
      }
      const base = joined.path;
      const resolved = withExtensions(base, this.filePaths);
      if (resolved !== null) {
        const sameDirectory = dirname(fromFile) === dirname(resolved);
        return {
          kind: 'internal-file',
          target: resolved,
          entry: null,
          confidence: 0.99,
          evidence: sameDirectory
            ? `relative import inside ${dirname(fromFile) === '' ? '<repository root>' : dirname(fromFile)}`
            : `relative import resolved to ${resolved}`,
          attempts: [],
        };
      }
      const excluded = this.excludedTarget(base);
      if (excluded !== null) {
        return unresolved(
          specifier,
          [`"${excluded.path}" exists but was excluded from the analysis: ${excluded.reason}`],
          'excluded-file',
        );
      }
      return unresolved(specifier, [`no analyzed file matched "${base}" with a known extension or index file`]);
    }

    const aliasMatch = this.matchAlias(normalizedSpecifier);
    if (aliasMatch !== null) {
      // A path alias that matched but resolved to nothing does not end the
      // search. TypeScript treats `paths` as one candidate among several and
      // falls back to node_modules, and the same has to happen here: a monorepo
      // that declares `"@scope/*": ["./packages/*/src/*"]` also has packages
      // named `@scope/thing` that live in their own directory, and the alias
      // must not shadow them.
      const isPackageShaped = packageNameFromSpecifier(normalizedSpecifier) !== null;
      if (aliasMatch.reason !== 'unresolved-alias' || !isPackageShaped) return aliasMatch;
    }

    const packageName = packageNameFromSpecifier(normalizedSpecifier);
    if (packageName !== null) {
      const workspacePackage = this.workspacePackages.get(packageName);
      if (workspacePackage !== undefined) {
        return {
          kind: 'workspace-package',
          target: packageName,
          entry: this.resolveWorkspaceEntry(packageName),
          confidence: 0.97,
          evidence: `specifier resolves to workspace package "${packageName}" (${workspacePackage.directory})`,
          attempts: [],
        };
      }
      if (BUILTINS.has(normalizedSpecifier)) {
        return {
          kind: 'node-builtin',
          target: normalizedSpecifier,
          entry: null,
          confidence: 0.99,
          evidence: 'specifier is a Node.js built-in module',
          attempts: [],
        };
      }
      return {
        kind: 'external-package',
        target: packageName,
        entry: null,
        confidence: 0.96,
        evidence: 'specifier is an external package dependency',
        attempts: [],
      };
    }

    return unresolved(specifier, ['specifier is neither relative, aliased, nor a package name']);
  }

  private resolveWorkspaceEntry(packageName: string): string | null {
    const workspacePackage = this.workspacePackages.get(packageName);
    if (workspacePackage === undefined) return null;
    for (const candidate of workspacePackage.entries) {
      const resolved = withExtensions(candidate, this.filePaths);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  private matchAlias(specifier: string): ResolvedImport | null {
    for (const alias of this.aliases) {
      const wildcard = alias.pattern.includes('*');
      if (!wildcard && alias.pattern !== specifier) continue;
      const prefix = wildcard ? alias.pattern.slice(0, alias.pattern.indexOf('*')) : alias.pattern;
      if (!specifier.startsWith(prefix)) continue;
      const rest = wildcard ? specifier.slice(prefix.length) : '';
      for (const target of alias.targets) {
        const substituted = wildcard ? target.replace('*', rest) : target;
        const base = normalizeRelative(join(alias.base, substituted));
        if (escapesRoot(base)) continue;
        const resolved = withExtensions(base, this.filePaths);
        if (resolved !== null) {
          return {
            kind: 'internal-file',
            target: resolved,
            entry: null,
            confidence: 0.95,
            evidence: `alias "${alias.pattern}" declared in ${alias.source} resolved to ${resolved}`,
            attempts: [],
          };
        }
        const excluded = this.excludedTarget(base);
        if (excluded !== null) {
          return unresolved(
            specifier,
            [`"${excluded.path}" exists but was excluded from the analysis: ${excluded.reason}`],
            'excluded-file',
          );
        }
      }
      return unresolved(
        specifier,
        [`alias "${alias.pattern}" declared in ${alias.source} did not resolve to an analyzed file`],
        'unresolved-alias',
      );
    }
    return null;
  }
}

/** Relative specifier target without extension resolution; used by tests. */
export function relativeSpecifierTarget(specifier: string, fromFile: string): string {
  return normalizeRelative(join(dirname(fromFile), specifier));
}