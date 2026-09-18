/**
 * Scanner level types.
 *
 * `ParsedFileSnapshot` is a serializable subset of the adapter output: only the
 * facts that survive a cache round-trip are kept, which keeps the local cache
 * small even for repositories with 100k+ files.
 */
import type { FileKind, ParseStatus } from '../../model/types.ts';
import type {
  CallRecord,
  ExportRecord,
  ImportRecord,
  ParsedFile,
  RouteRecord,
  SymbolRecord,
} from '../../adapters/language/types.ts';

export type { FileKind };

/** Serializable parse result stored in the content-addressed cache. */
export interface ParsedFileSnapshot {
  path: string;
  language: string;
  parseStatus: ParseStatus;
  imports: ImportRecord[];
  exports: ExportRecord[];
  symbols: SymbolRecord[];
  calls: CallRecord[];
  routes: RouteRecord[];
  signals: string[];
  metadata: Record<string, unknown>;
}

export function toSnapshot(parsed: ParsedFile): ParsedFileSnapshot {
  return {
    path: parsed.path,
    language: parsed.language,
    parseStatus: parsed.parseStatus,
    imports: parsed.imports,
    exports: parsed.exports,
    symbols: parsed.symbols,
    calls: parsed.calls,
    routes: parsed.routes,
    signals: parsed.signals,
    metadata: parsed.metadata,
  };
}

export function fromSnapshot(snapshot: ParsedFileSnapshot): ParsedFile {
  return { ...snapshot, diagnostics: [] };
}

export interface ScannerFileResult {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
  kind: FileKind;
  /** `true` when the file matched a sensitive pattern and was never read. */
  sensitive: boolean;
  /** `true` when contents were parsed during this scan. */
  parsedNow: boolean;
  skippedReason: string | null;
}

export interface ScannerDiagnosticList {
  path: string;
  messages: Array<{ code: string; message: string; hint?: string }>;
}