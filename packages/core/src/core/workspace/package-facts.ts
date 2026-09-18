/**
 * Reconstruction of package facts from the parsed metadata of `package.json`.
 *
 * The scanner keeps only the language-agnostic IR, so the workspace layer rebuilds
 * the facts it needs from that metadata. This keeps a single source of truth and
 * makes the cache round-trip lossless for analysis purposes.
 */
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { PackageEntryField, PackageFacts } from '../../adapters/language/package-json/adapter.ts';

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Reads {@link PackageFacts} back from a parsed `package.json` file. */
export function packageFactsFromParsed(parsed: ParsedFile): PackageFacts | null {
  if (parsed.language !== 'package-json') return null;
  const metadata = parsed.metadata;
  const rawEntries = metadata['package.entries'];
  const entries: PackageEntryField[] = [];
  if (Array.isArray(rawEntries)) {
    for (const entry of rawEntries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { field?: unknown; value?: unknown };
      if (typeof record.field !== 'string' || typeof record.value !== 'string') continue;
      if (!['main', 'module', 'types', 'browser', 'exports', 'bin'].includes(record.field)) continue;
      entries.push({ field: record.field as PackageEntryField['field'], value: record.value });
    }
  }
  const typeValue = metadata['package.type'];
  return {
    name: typeof metadata['package.name'] === 'string' ? (metadata['package.name'] as string) : null,
    version: typeof metadata['package.version'] === 'string' ? (metadata['package.version'] as string) : null,
    private: metadata['package.private'] === true,
    type: typeValue === 'module' ? 'module' : typeValue === 'commonjs' ? 'commonjs' : null,
    scripts: stringRecord(metadata['package.scripts']),
    dependencies: stringArray(metadata['package.dependencies']),
    devDependencies: stringArray(metadata['package.devDependencies']),
    peerDependencies: stringArray(metadata['package.peerDependencies']),
    workspaces: stringArray(metadata['package.workspaces']),
    entries: entries.sort((a, b) =>
      a.field === b.field ? (a.value < b.value ? -1 : 1) : a.field < b.field ? -1 : 1,
    ),
    packageManager:
      typeof metadata['package.packageManagerField'] === 'string'
        ? (metadata['package.packageManagerField'] as string)
        : null,
  };
}