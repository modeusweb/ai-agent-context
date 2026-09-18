/**
 * JSON adapter — structural facts only (top-level keys, validity).
 *
 * Invalid JSON is a warning, never a fatal error: the scan continues and the
 * remaining files are still analyzed.
 */
import { createParsedFile, type FileDescriptor, type LanguageAdapter, type ParsedFile } from '../types.ts';

export class JsonAdapter implements LanguageAdapter {
  readonly id = 'json';
  readonly displayName = 'JSON';
  readonly languageIds: readonly string[] = ['json'];
  /** Structural files are analyzed regardless of the `languages` setting. */
  readonly alwaysEnabled = true;

  handles(file: FileDescriptor): boolean {
    return file.extension === '.json';
  }

  parse(input: { path: string; language: string; contents: string }): ParsedFile {
    try {
      const value: unknown = JSON.parse(stripJsonPreamble(input.contents));
      const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
      return createParsedFile(input.path, 'json', {
        metadata: {
          'json.valid': true,
          'json.topLevelKeys': keys,
          'json.rootType': Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createParsedFile(input.path, 'json', {
        parseStatus: 'partial',
        metadata: { 'json.valid': false },
        diagnostics: [
          {
            code: 'WARN_JSON_INVALID',
            severity: 'warning',
            message: `failed to parse ${input.path}`,
            source: input.path,
            hint: message,
          },
        ],
      });
    }
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes a UTF-8 BOM so that JSON.parse does not fail on Windows checkouts. */
export function stripJsonPreamble(contents: string): string {
  return contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
}