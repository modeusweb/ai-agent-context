/**
 * TypeScript path alias collection.
 *
 * Aliases come from `compilerOptions.paths` / `baseUrl`, following `extends`
 * chains (including `tsconfig.base.json` style monorepo setups). Collecting them
 * is what makes `@app/payments/...` imports resolvable to real files, keeping the
 * import graph honest instead of dropping aliased imports on the floor.
 */
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { TsConfigFacts } from '../../adapters/language/tsconfig/adapter.ts';
import type { AliasEntry } from './resolver.ts';
import { dirname, join, normalizeRelative } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';

interface TsConfigRecord {
  path: string;
  directory: string;
  facts: TsConfigFacts;
}

function readTsConfigFacts(parsed: ParsedFile): TsConfigFacts | null {
  const extendsChain = parsed.metadata['tsconfig.extends'];
  const paths = parsed.metadata['tsconfig.paths'];
  if (!Array.isArray(extendsChain) || paths === null || typeof paths !== 'object') return null;
  const baseUrl = parsed.metadata['tsconfig.baseUrl'];
  const facts: TsConfigFacts = {
    extendsChain: extendsChain.filter((entry): entry is string => typeof entry === 'string'),
    baseUrl: typeof baseUrl === 'string' ? baseUrl : null,
    paths: {},
    strict: parsed.metadata['tsconfig.strict'] === true,
    moduleResolution: null,
    module: null,
    target: null,
    jsx: null,
    composite: false,
    declaration: false,
  };
  for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
    if (Array.isArray(value)) facts.paths[key] = value.filter((entry): entry is string => typeof entry === 'string');
  }
  return facts;
}

/** Resolves an `extends` target to a repository-relative tsconfig path. */
function resolveExtends(fromDirectory: string, target: string): string {
  return target.startsWith('.') ? join(fromDirectory, target) : target;
}

/**
 * Collects alias entries from every tsconfig in the repository.
 *
 * Entries are ordered by decreasing `base` depth, so the tsconfig closest to the
 * importing file wins (matching how TypeScript resolves `paths` per project).
 */
export function collectAliases(parsed: Map<string, ParsedFile>): AliasEntry[] {
  const records = new Map<string, TsConfigRecord>();
  for (const file of parsed.values()) {
    if (file.language !== 'tsconfig') continue;
    const facts = readTsConfigFacts(file);
    if (facts === null) continue;
    records.set(file.path, { path: file.path, directory: dirname(file.path), facts });
  }

  const entries: AliasEntry[] = [];
  const seen = new Set<string>();
  for (const record of [...records.values()].sort((a, b) => compareStrings(a.path, b.path))) {
    for (const entry of aliasEntriesFor(record, records, new Set<string>())) {
      const key = `${entry.pattern}|${entry.targets.join(',')}|${entry.base}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  entries.sort((a, b) =>
    a.base.length === b.base.length
      ? compareStrings(a.pattern, b.pattern)
      : b.base.length - a.base.length,
  );
  return entries;
}

function aliasEntriesFor(
  record: TsConfigRecord,
  records: Map<string, TsConfigRecord>,
  visited: Set<string>,
): AliasEntry[] {
  if (visited.has(record.path)) return [];
  visited.add(record.path);

  const entries: AliasEntry[] = [];
  // Inherited entries first (parent project), the current file overrides them.
  for (const parentTarget of record.facts.extendsChain) {
    const parentPath = normalizeRelative(resolveExtends(record.directory, parentTarget));
    const parent = records.get(parentPath) ?? records.get(`${parentPath}.json`);
    if (parent !== undefined) entries.push(...aliasEntriesFor(parent, records, visited));
  }

  const base = normalizeRelative(join(record.directory, record.facts.baseUrl ?? '.'));
  for (const [pattern, targets] of Object.entries(record.facts.paths).sort((a, b) => compareStrings(a[0], b[0]))) {
    if (targets.length === 0) continue;
    entries.push({ pattern, targets: [...targets].sort(compareStrings), base, source: record.path });
  }
  if (Object.keys(record.facts.paths).length === 0 && record.facts.baseUrl !== null) {
    // A bare `baseUrl` makes every non-relative specifier resolvable from it.
    entries.push({ pattern: '*', targets: ['*'], base, source: record.path });
  }
  return entries;
}

/** Nearest tsconfig for a file, used in diagnostics and explanations. */
export function nearestTsConfig(tsconfigPaths: readonly string[], filePath: string): string | null {
  const sorted = [...tsconfigPaths].sort((a, b) => b.length - a.length);
  const directory = dirname(filePath);
  for (const candidate of sorted) {
    const configDirectory = dirname(candidate);
    if (configDirectory.length === 0 || directory === configDirectory || directory.startsWith(`${configDirectory}/`)) {
      return candidate;
    }
  }
  return null;
}