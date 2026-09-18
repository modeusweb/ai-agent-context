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
import { extname, dirname, join, normalizeRelative } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';
import { packageNameFromSpecifier } from '../../adapters/language/ts-js/package-signals.ts';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

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

function unresolved(specifier: string, attempts: string[]): ResolvedImport {
  return {
    kind: 'unresolved',
    target: specifier,
    entry: null,
    confidence: 0.3,
    evidence: `could not resolve "${specifier}" to an analyzed file`,
    attempts,
  };
}

export class ImportResolver {
  private readonly filePaths: ReadonlySet<string>;
  private readonly aliases: AliasEntry[];
  private readonly workspacePackages: ResolverInput['workspacePackages'];

  constructor(input: ResolverInput) {
    this.filePaths = input.filePaths;
    // Deeper `base` first: the tsconfig closest to the importing file wins.
    this.aliases = [...input.aliases].sort((a, b) =>
      a.base.length === b.base.length ? compareStrings(a.pattern, b.pattern) : b.base.length - a.base.length,
    );
    this.workspacePackages = input.workspacePackages;
  }

  /** Resolves a specifier written in `fromFile`. */
  resolve(specifier: string, fromFile: string): ResolvedImport {
    const normalizedSpecifier = specifier.replace(/\\/g, '/');
    if (normalizedSpecifier.length === 0) return unresolved(specifier, ['empty specifier']);

    if (normalizedSpecifier.startsWith('.') || normalizedSpecifier.startsWith('/')) {
      const base = join(dirname(fromFile), normalizedSpecifier);
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
      return unresolved(specifier, [`no analyzed file matched "${base}" with a known extension or index file`]);
    }

    const aliasMatch = this.matchAlias(normalizedSpecifier);
    if (aliasMatch !== null) return aliasMatch;

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
      }
      return unresolved(specifier, [
        `alias "${alias.pattern}" declared in ${alias.source} did not resolve to an analyzed file`,
      ]);
    }
    return null;
  }
}

/** Relative specifier target without extension resolution; used by tests. */
export function relativeSpecifierTarget(specifier: string, fromFile: string): string {
  return normalizeRelative(join(dirname(fromFile), specifier));
}