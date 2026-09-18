/**
 * TypeScript / JavaScript language adapter.
 *
 * Produces the language-agnostic IR used by the whole pipeline. All TypeScript
 * specific knowledge (lexing, `import type`, `export =`, decorators, JSX) stops
 * at this module.
 */
import { extractModuleFacts } from './extractor.ts';
import { signalsForSpecifier } from './package-signals.ts';
import type { DiagnosticPayload } from '../../../model/types.ts';
import { createParsedFile, normalizeSignals, type FileDescriptor, type LanguageAdapter, type ParsedFile } from '../types.ts';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const JSX_EXTENSIONS = new Set(['.tsx', '.jsx']);

export class TsJsAdapter implements LanguageAdapter {
  readonly id = 'typescript';
  readonly displayName = 'TypeScript / JavaScript';
  readonly languageIds: readonly string[] = ['typescript', 'javascript'];
  readonly alwaysEnabled = false;

  handles(file: FileDescriptor): boolean {
    return TS_JS_EXTENSIONS.has(file.extension);
  }

  parse(input: { path: string; language: string; contents: string }): ParsedFile {
    const extension = input.path.slice(input.path.lastIndexOf('.')).toLowerCase();
    const language = JAVASCRIPT_EXTENSIONS.has(extension) ? 'javascript' : 'typescript';
    const extraction = extractModuleFacts(input.contents);
    const signals = [...extraction.signals];
    if (JSX_EXTENSIONS.has(extension)) signals.push('jsx:present');
    for (const record of extraction.imports) {
      signals.push(...signalsForSpecifier(record.specifier));
    }
    const diagnostics: DiagnosticPayload[] = [];
    if (extraction.parseStatus === 'partial') {
      diagnostics.push({
        code: 'WARN_PARSE_PARTIAL',
        severity: 'warning',
        message: `failed to fully parse ${input.path}`,
        source: input.path,
        hint: 'The file contains unbalanced braces or unterminated literals; recovered facts are still used.',
      });
    }
    return createParsedFile(input.path, language, {
      parseStatus: extraction.parseStatus,
      imports: extraction.imports,
      exports: extraction.exports,
      symbols: extraction.symbols,
      calls: extraction.calls,
      routes: extraction.routes,
      signals: normalizeSignals(signals),
      metadata: {
        'ts.moduleFormat': extraction.usesEsmSyntax ? 'esm' : extraction.usesCommonJs ? 'commonjs' : 'unknown',
        'ts.symbolCount': extraction.symbols.length,
        'ts.exportCount': extraction.exports.length,
      },
      diagnostics,
    });
  }
}