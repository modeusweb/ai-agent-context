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
import { escapesRoot, extname, dirname, isInside, join, joinStrict, normalizeRelative } from '../../util/paths.ts';
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
  /**
   * Every `package.json` of the repository, with the dependency ranges it
   * declares. A package that declares a neighbouring package's name with a
   * registry range depends on the *published* package, not on the source next
   * door; see {@link ImportResolver.resolve}.
   */
  manifests?: readonly ManifestDeclaration[];
  /**
   * Whether the workspace packages were matched by workspace globs. A member
   * of a workspace is depended on through the workspace, whatever range its
   * neighbour declares; the range only decides for a package that stands alone.
   */
  workspaceMembers?: boolean;
}

export interface ManifestDeclaration {
  /** Repository-relative POSIX directory of the `package.json` (empty at the root). */
  directory: string;
  /** Dependency name → declared range, over every dependency field. */
  ranges: Readonly<Record<string, string>>;
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

/**
 * Every path a specifier base could refer to, in the order they are tried.
 *
 * One list serves both lookups, so that a file which exists but was excluded
 * is found by the same rules that would otherwise have resolved to it.
 */
function candidatesOf(base: string): string[] {
  const normalized = normalizeRelative(base);
  // An empty base is the repository root (`require('../..')`, `require('.')`),
  // and its index file sits there: `/index.js`, which the generic form gives
  // for an empty base, begins with a slash no repository-relative path has.
  const prefix = normalized.length === 0 ? '' : `${normalized}/`;
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
    for (const candidate of RESOLUTION_EXTENSIONS) candidates.push(`${prefix}index${candidate}`);
  }
  return candidates;
}

/** Tries the extension and index-file candidates of a specifier base path. */
export function withExtensions(base: string, filePaths: ReadonlySet<string>): string | null {
  for (const candidate of candidatesOf(base)) {
    if (filePaths.has(candidate)) return candidate;
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

export class ImportResolver {
  private readonly filePaths: ReadonlySet<string>;
  private readonly excludedFiles: ReadonlyMap<string, string>;
  private readonly aliases: AliasEntry[];
  private readonly workspacePackages: ResolverInput['workspacePackages'];
  /** Manifests by the directory they sit in, deepest first: the nearest wins. */
  private readonly manifests: readonly ManifestDeclaration[];
  private readonly workspaceMembers: boolean;

  constructor(input: ResolverInput) {
    this.filePaths = input.filePaths;
    this.excludedFiles = input.excludedFiles ?? new Map();
    // Deeper `base` first: the tsconfig closest to the importing file wins.
    this.aliases = [...input.aliases].sort((a, b) =>
      a.base.length === b.base.length ? compareStrings(a.pattern, b.pattern) : b.base.length - a.base.length,
    );
    this.workspacePackages = input.workspacePackages;
    this.workspaceMembers = input.workspaceMembers === true;
    // Deepest directory first, so the manifest nearest the importing file is found first.
    this.manifests = [...(input.manifests ?? [])].sort((a, b) =>
      a.directory.length === b.directory.length ? compareStrings(a.directory, b.directory) : b.directory.length - a.directory.length,
    );
  }

  /**
   * Whether the package that owns `fromFile` declares `packageName` as a
   * dependency with a registry range.
   *
   * A name that matches a package of the same tree usually names that package.
   * The manifest is what says when it does not: `clsx` keeps a `bench/`
   * directory that pins `clsx@1.1.0` from the registry, next to the `clsx`
   * sources, to compare against the released build. Declared with a registry
   * range, the dependency is the published package; declared with the
   * `workspace:` protocol, or not declared, it is the one next door. Package
   * managers enforce exactly this, so the declaration is evidence rather than
   * a convention.
   */
  private declaredFromRegistry(packageName: string, fromFile: string, targetDirectory: string): boolean {
    if (this.workspaceMembers) return false;
    const owner = this.manifests.find((manifest) => manifest.directory.length === 0 || isInside(manifest.directory, fromFile));
    if (owner === undefined) return false;
    // A package importing its own name depends on its own entry point.
    if (owner.directory === targetDirectory) return false;
    const range = owner.ranges[packageName];
    return range !== undefined && !range.startsWith('workspace:');
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
    for (const candidate of candidatesOf(base)) {
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
      // A directory that is a package is imported through that package's
      // declared entry: `from '..'` in a package's test folder, `require('../..')`
      // in an example. When the entry is not an analyzed file, it is because the
      // manifest points at build output — a limit of the analysis, not a missing
      // file. Until 1.1.0 such an import was dropped as an asset import.
      for (const [name, info] of this.workspacePackages) {
        if (info.directory !== base) continue;
        const entry = this.resolveWorkspaceEntry(name);
        if (entry !== null) {
          return {
            kind: 'workspace-package',
            target: name,
            entry,
            confidence: 0.95,
            evidence: `relative specifier "${specifier}" names the directory of workspace package "${name}", whose entry is ${entry}`,
            attempts: [],
          };
        }
        const pointsAtBuildOutput = info.entries.some((candidate) => /(^|\/)(dist|build|out)\//.test(candidate));
        return unresolved(
          specifier,
          pointsAtBuildOutput
            ? [`"${base.length === 0 ? '.' : base}" is the directory of package "${name}", whose manifest points at build output the analysis excludes`]
            : [`"${base}" is the directory of package "${name}", which has no entry file in the analyzed tree`],
          pointsAtBuildOutput ? 'excluded-build-output' : 'missing',
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
        if (this.declaredFromRegistry(packageName, fromFile, workspacePackage.directory)) {
          return {
            kind: 'external-package',
            target: packageName,
            entry: null,
            confidence: 0.9,
            evidence: `the package containing ${fromFile} declares "${packageName}" as a dependency with a registry range, so it depends on the published package rather than on the one in this repository`,
            attempts: [],
          };
        }
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