/**
 * Language adapter contract.
 *
 * The core analysis pipeline never sees a language specific AST. Every adapter
 * (TypeScript/JavaScript today; Python, Go, Rust, Java, C# later) reduces a file
 * to the same language-agnostic intermediate representation declared here:
 * imports, exports, symbols, calls, coarse signals and free-form metadata.
 *
 * Adding a language therefore means writing one adapter and registering it in
 * the {@link LanguageRegistry} — no change to the graph, architecture or
 * serialization layers.
 */
import type {
  DiagnosticPayload,
  ImportSyntax,
  ParseStatus,
  SymbolKind,
} from '../../model/types.ts';

export interface ImportRecord {
  /** Specifier exactly as written in the source. */
  specifier: string;
  syntax: ImportSyntax;
  /** Named imports, without the local alias (`{ a as b }` adds `a`). */
  names: string[];
  /** Default import binding, when present. */
  defaultImport?: string;
  /** Namespace import binding (`* as ns`), when present. */
  namespaceImport?: string;
  /** 1-based line of the import statement. */
  line: number;
  /** `true` for side-effect-only imports (`import './x'`). */
  hasSideEffects: boolean;
  /** `true` for `import type` / `export type` forms. */
  typeOnly: boolean;
}

export interface ExportRecord {
  name: string;
  kind: SymbolKind | 'unknown' | 'reexport' | 'star';
  isDefault: boolean;
  line: number;
  /** Set for re-exports: the module the symbols come from. */
  fromSpecifier?: string;
  /** Names pulled from another module (`export { a } from 'b'`). */
  names?: string[];
  typeOnly?: boolean;
}

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  isDefault: boolean;
  extends: string[];
  implements: string[];
  /** 1-based line of the declaration. */
  line: number;
  /** Decorator names, when the language supports them. */
  decorators?: string[];
}

export interface CallRecord {
  name: string;
  line: number;
  /** Receiver identifier for `receiver.method(...)` calls. */
  receiver?: string;
}

export interface RouteRecord {
  method: string;
  path: string;
  line: number;
}

/** Language-agnostic signals understood by the analysis core. */
export const SIGNALS = {
  envAccess: 'env:access',
  testSuite: 'test:suite',
  consoleUsage: 'console:usage',
  httpRoute: 'http:route',
  httpFramework: 'http:framework',
  httpClient: 'http:client',
  graphql: 'graphql:library',
  dbAccess: 'db:access',
  uiFramework: 'ui:framework',
  jsx: 'jsx:present',
  browserApi: 'browser:api',
  worker: 'worker:usage',
  queue: 'queue:usage',
  schedule: 'schedule:usage',
  eventEmitter: 'event:emitter',
  customErrorClass: 'error:custom-class',
  validation: 'validation:library',
  externalSdk: 'sdk:external',
  configLibrary: 'config:library',
  loggingLibrary: 'logging:library',
  cliFramework: 'cli:framework',
  testFramework: 'test:framework',
  decorators: 'decorators:present',
  commonjs: 'module:commonjs',
  esm: 'module:esm',
  typeOnlyExports: 'types:only-exports',
} as const;

export type Signal = (typeof SIGNALS)[keyof typeof SIGNALS] | `decorator:${string}`;

export interface ParseOptions {
  /** Absolute path is not required: adapters work on text only. */
  path: string;
  /** Resolved language id for the file. */
  language: string;
}

export interface ParsedFile {
  path: string;
  language: string;
  parseStatus: ParseStatus;
  imports: ImportRecord[];
  exports: ExportRecord[];
  symbols: SymbolRecord[];
  calls: CallRecord[];
  routes: RouteRecord[];
  /** Deduplicated, sorted signals. */
  signals: string[];
  /**
   * Language specific structured data. Known keys:
   * - `json.keys` — top-level keys of a JSON document
   * - `markdown.headings` — heading titles
   * - `package.name` / `package.scripts` / `package.dependencies` — package facts
   * - `tsconfig.paths` / `tsconfig.baseUrl` — TypeScript path aliases
   */
  metadata: Record<string, unknown>;
  diagnostics: DiagnosticPayload[];
}

export interface FileDescriptor {
  /** Repository-relative POSIX path. */
  path: string;
  /** Last path segment. */
  basename: string;
  /** Lowercase extension, including the dot (`''` when absent). */
  extension: string;
}

export interface LanguageAdapter {
  /** Stable language id, for example `typescript`, `json`, `markdown`. */
  readonly id: string;
  readonly displayName: string;
  /** Language ids this adapter can produce (a TS adapter also handles JS). */
  readonly languageIds: readonly string[];
  /**
   * When `true` the adapter runs regardless of the `languages` configuration —
   * used for structural files such as `package.json` and `tsconfig.json`.
   */
  readonly alwaysEnabled: boolean;
  /** `true` when this adapter claims the file. */
  handles(file: FileDescriptor): boolean;
  /** Pure function: text in, facts out. Must never throw. */
  parse(input: ParseOptions & { contents: string }): ParsedFile;
}

/** Helper used by adapters to build a correctly defaulted {@link ParsedFile}. */
export function createParsedFile(path: string, language: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    language,
    parseStatus: 'ok',
    imports: [],
    exports: [],
    symbols: [],
    calls: [],
    routes: [],
    signals: [],
    metadata: {},
    diagnostics: [],
    ...overrides,
  };
}

/** Sorts and deduplicates signals for deterministic output. */
export function normalizeSignals(signals: Iterable<string>): string[] {
  return [...new Set(signals)].sort();
}