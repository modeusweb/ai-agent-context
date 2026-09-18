/**
 * `package.json` adapter — declared structural facts.
 *
 * Everything extracted here is *declared by the repository*, not inferred, so it
 * is reported with the high `declared` confidence: entry fields, scripts, runtime
 * and development dependencies, workspaces, module format.
 */
import { createParsedFile, type FileDescriptor, type LanguageAdapter, type ParsedFile } from '../types.ts';
import { isPlainObject, stripJsonPreamble } from '../json/adapter.ts';
import { PACKAGE_ENTRY_FIELDS } from '../../../config/defaults.ts';

export interface PackageEntryField {
  field: 'main' | 'module' | 'types' | 'browser' | 'exports' | 'bin';
  value: string;
}

export interface PackageFacts {
  name: string | null;
  version: string | null;
  private: boolean;
  type: 'module' | 'commonjs' | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  peerDependencies: string[];
  workspaces: string[];
  entries: PackageEntryField[];
  packageManager: string | null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function dependencyNames(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).sort();
}

/**
 * Flattens the `exports` field into string paths.
 *
 * Only shapes that map to files are kept (`".": "./dist/index.js"`, condition
 * maps, wildcard subpaths) — they still describe a published boundary.
 */
export function flattenExports(value: unknown): string[] {
  const result: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      result.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node).sort()) visit(node[key]);
    }
  };
  visit(value);
  return [...new Set(result)];
}

export class PackageJsonAdapter implements LanguageAdapter {
  readonly id = 'package-json';
  readonly displayName = 'package.json';
  readonly languageIds: readonly string[] = ['json'];
  readonly alwaysEnabled = true;

  handles(file: FileDescriptor): boolean {
    return file.basename === 'package.json';
  }

  parse(input: { path: string; language: string; contents: string }): ParsedFile {
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(stripJsonPreamble(input.contents));
      if (!isPlainObject(parsed)) throw new Error('package.json must contain a JSON object');
      raw = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createParsedFile(input.path, 'package-json', {
        parseStatus: 'failed',
        diagnostics: [
          {
            code: 'WARN_PACKAGE_JSON_INVALID',
            severity: 'warning',
            message: `failed to parse ${input.path}`,
            source: input.path,
            hint: `${message}. Run: agent-context status`,
          },
        ],
      });
    }

    const facts = readPackageFacts(raw);
    return createParsedFile(input.path, 'package-json', {
      metadata: {
        'package.name': facts.name,
        'package.version': facts.version,
        'package.private': facts.private,
        'package.type': facts.type,
        'package.scripts': facts.scripts,
        'package.dependencies': facts.dependencies,
        'package.devDependencies': facts.devDependencies,
        'package.peerDependencies': facts.peerDependencies,
        'package.workspaces': facts.workspaces,
        'package.entries': facts.entries,
        'package.packageManagerField': facts.packageManager,
      },
    });
  }
}

/** Normalizes a raw package.json object into {@link PackageFacts}. */
export function readPackageFacts(raw: Record<string, unknown>): PackageFacts {
  const entries: PackageEntryField[] = [];
  for (const field of PACKAGE_ENTRY_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (field === 'exports') {
      for (const exported of flattenExports(value)) entries.push({ field: 'exports', value: exported });
      continue;
    }
    if (field === 'bin') {
      if (typeof value === 'string') {
        entries.push({ field: 'bin', value });
        continue;
      }
      if (isPlainObject(value)) {
        for (const key of Object.keys(value).sort()) {
          const target = value[key];
          if (typeof target === 'string') entries.push({ field: 'bin', value: target });
        }
      }
      continue;
    }
    if (typeof value === 'string') entries.push({ field, value });
  }

  const workspacesValue = raw.workspaces;
  let workspaces: string[] = [];
  if (Array.isArray(workspacesValue)) {
    workspaces = workspacesValue.filter((entry): entry is string => typeof entry === 'string').sort();
  } else if (isPlainObject(workspacesValue) && Array.isArray(workspacesValue.packages)) {
    workspaces = workspacesValue.packages.filter((entry): entry is string => typeof entry === 'string').sort();
  }

  const typeValue = raw.type;
  return {
    name: typeof raw.name === 'string' ? raw.name : null,
    version: typeof raw.version === 'string' ? raw.version : null,
    private: raw.private === true,
    type: typeValue === 'module' ? 'module' : typeValue === 'commonjs' ? 'commonjs' : null,
    scripts: stringRecord(raw.scripts),
    dependencies: dependencyNames(raw.dependencies),
    devDependencies: dependencyNames(raw.devDependencies),
    peerDependencies: dependencyNames(raw.peerDependencies),
    workspaces,
    entries: entries.sort((a, b) => (a.field === b.field ? (a.value < b.value ? -1 : 1) : a.field < b.field ? -1 : 1)),
    packageManager: typeof raw.packageManager === 'string' ? raw.packageManager : null,
  };
}