/**
 * Extension point for language support.
 *
 * Third-party code can add a language adapter without touching the core:
 *
 * ```ts
 * const registry = createDefaultRegistry();
 * registry.register(myPythonAdapter);
 * const context = await AgentContext.load({ root, languageRegistry: registry });
 * ```
 *
 * Resolution order: adapters that match by file name (`package.json`,
 * `tsconfig.json`) win over extension based adapters.
 */
import type { FileDescriptor, LanguageAdapter, ParsedFile } from './types.ts';
import { createParsedFile } from './types.ts';
import { TsJsAdapter } from './ts-js/adapter.ts';
import { JsonAdapter } from './json/adapter.ts';
import { MarkdownAdapter } from './markdown/adapter.ts';
import { PackageJsonAdapter } from './package-json/adapter.ts';
import { TsConfigAdapter } from './tsconfig/adapter.ts';
import { extname, basename } from '../../util/paths.ts';

export class LanguageRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  constructor(adapters: readonly LanguageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: LanguageAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  list(): LanguageAdapter[] {
    return [...this.adapters];
  }

  get(id: string): LanguageAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  /**
   * Picks the adapter for a file.
   *
   * @param file file descriptor (path/basename/extension)
   * @param enabledLanguages language ids enabled through configuration
   */
  resolve(file: FileDescriptor, enabledLanguages: readonly string[]): LanguageAdapter | null {
    const enabled = new Set(enabledLanguages.map((language) => language.toLowerCase()));
    for (const adapter of this.adapters) {
      if (!adapter.handles(file)) continue;
      if (adapter.alwaysEnabled) return adapter;
      if (adapter.languageIds.some((id) => enabled.has(id))) return adapter;
    }
    return null;
  }

  /** Parses content with the appropriate adapter, never throwing. */
  parseFile(path: string, contents: string, enabledLanguages: readonly string[]): ParsedFile {
    const descriptor: FileDescriptor = { path, basename: basename(path), extension: extname(path).toLowerCase() };
    const adapter = this.resolve(descriptor, enabledLanguages);
    if (adapter === null) {
      return createParsedFile(path, 'unknown', { parseStatus: 'skipped' });
    }
    try {
      return adapter.parse({ path, language: adapter.languageIds[0] ?? adapter.id, contents });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createParsedFile(path, adapter.id, {
        parseStatus: 'failed',
        diagnostics: [
          {
            code: 'WARN_PARSE_FAILED',
            severity: 'warning',
            message: `failed to parse ${path}`,
            source: path,
            hint: message,
          },
        ],
      });
    }
  }
}

/** Registry with the built-in adapters (TypeScript/JavaScript, JSON, Markdown). */
export function createDefaultRegistry(): LanguageRegistry {
  return new LanguageRegistry([
    new PackageJsonAdapter(),
    new TsConfigAdapter(),
    new JsonAdapter(),
    new MarkdownAdapter(),
    new TsJsAdapter(),
  ]);
}

export type { LanguageAdapter, ParsedFile, FileDescriptor } from './types.ts';
