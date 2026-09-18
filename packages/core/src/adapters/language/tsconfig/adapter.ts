/**
 * `tsconfig.json` adapter.
 *
 * tsconfig files are JSON with comments and trailing commas, so they are parsed
 * with a small tolerant pre-processor. Only the facts the analysis needs are
 * extracted: module format hints, path aliases (`baseUrl` + `paths`), strictness
 * and the `extends` chain, which the alias resolver follows separately.
 */
import { createParsedFile, type FileDescriptor, type LanguageAdapter, type ParsedFile } from '../types.ts';
import { isPlainObject } from '../json/adapter.ts';

const TSCONFIG_NAMES = new Set(['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json', 'tsconfig.build.json']);

/** Removes comments and trailing commas so that `JSON.parse` accepts the file. */
export function relaxJson(contents: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < contents.length) {
    const character = contents[index]!;
    if (inString) {
      output += character;
      if (character === '\\') {
        output += contents[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === '/' && contents[index + 1] === '/') {
      while (index < contents.length && contents[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && contents[index + 1] === '*') {
      index += 2;
      while (index < contents.length && !(contents[index] === '*' && contents[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}

export interface TsConfigFacts {
  extendsChain: string[];
  baseUrl: string | null;
  paths: Record<string, string[]>;
  strict: boolean;
  moduleResolution: string | null;
  module: string | null;
  target: string | null;
  jsx: string | null;
  composite: boolean;
  declaration: boolean;
}

/** Reads the facts the analysis needs from a parsed tsconfig document. */
export function readTsConfigFacts(raw: Record<string, unknown>): TsConfigFacts {
  const extendsValue = raw.extends;
  const extendsChain =
    typeof extendsValue === 'string'
      ? [extendsValue]
      : Array.isArray(extendsValue)
        ? extendsValue.filter((entry): entry is string => typeof entry === 'string')
        : [];
  const compilerOptions = isPlainObject(raw.compilerOptions) ? raw.compilerOptions : {};
  const rawPaths = isPlainObject(compilerOptions.paths) ? compilerOptions.paths : {};
  const paths: Record<string, string[]> = {};
  for (const key of Object.keys(rawPaths).sort()) {
    const value = rawPaths[key];
    if (Array.isArray(value)) {
      paths[key] = value.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return {
    extendsChain,
    baseUrl: typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null,
    paths,
    strict: compilerOptions.strict === true,
    moduleResolution: typeof compilerOptions.moduleResolution === 'string' ? compilerOptions.moduleResolution : null,
    module: typeof compilerOptions.module === 'string' ? compilerOptions.module : null,
    target: typeof compilerOptions.target === 'string' ? compilerOptions.target : null,
    jsx: typeof compilerOptions.jsx === 'string' ? compilerOptions.jsx : null,
    composite: compilerOptions.composite === true,
    declaration: compilerOptions.declaration === true,
  };
}

export class TsConfigAdapter implements LanguageAdapter {
  readonly id = 'tsconfig';
  readonly displayName = 'TypeScript configuration';
  readonly languageIds: readonly string[] = ['typescript', 'json'];
  readonly alwaysEnabled = true;

  handles(file: FileDescriptor): boolean {
    return TSCONFIG_NAMES.has(file.basename);
  }

  parse(input: { path: string; language: string; contents: string }): ParsedFile {
    try {
      const parsed: unknown = JSON.parse(relaxJson(input.contents));
      if (!isPlainObject(parsed)) throw new Error('tsconfig must contain a JSON object');
      const facts = readTsConfigFacts(parsed);
      return createParsedFile(input.path, 'tsconfig', {
        metadata: {
          'tsconfig.extends': facts.extendsChain,
          'tsconfig.baseUrl': facts.baseUrl,
          'tsconfig.paths': facts.paths,
          'tsconfig.strict': facts.strict,
          'tsconfig.moduleResolution': facts.moduleResolution,
          'tsconfig.module': facts.module,
          'tsconfig.target': facts.target,
          'tsconfig.jsx': facts.jsx,
          'tsconfig.composite': facts.composite,
          'tsconfig.declaration': facts.declaration,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createParsedFile(input.path, 'tsconfig', {
        parseStatus: 'failed',
        diagnostics: [
          {
            code: 'WARN_TSCONFIG_INVALID',
            severity: 'warning',
            message: 'TypeScript project detected but tsconfig.json is invalid.',
            source: input.path,
            hint: `${message}. Run: agent-context status`,
          },
        ],
      });
    }
  }
}