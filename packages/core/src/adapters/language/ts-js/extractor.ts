/**
 * Token-stream fact extraction for TypeScript/JavaScript.
 *
 * Design stance: a *reliable* import/export graph beats a pseudo-intelligent
 * call graph. Only syntactically unambiguous constructs produce graph edges
 * (`import`, `export ... from`, `require`, dynamic `import()`), while `calls`
 * edges are limited to identifiers that are actually imported by the file, which
 * keeps false positives low.
 */
import { tokenize, tokensWithoutComments, type Token } from './lexer.ts';
import type { CallRecord, ExportRecord, ImportRecord, RouteRecord, SymbolRecord } from '../types.ts';
import { SIGNALS, normalizeSignals } from '../types.ts';
import type { ParseStatus } from '../../../model/types.ts';

export interface ExtractionResult {
  imports: ImportRecord[];
  exports: ExportRecord[];
  symbols: SymbolRecord[];
  calls: CallRecord[];
  routes: RouteRecord[];
  signals: string[];
  parseStatus: ParseStatus;
  usesEsmSyntax: boolean;
  usesCommonJs: boolean;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);
const ROUTE_RECEIVER = /^(app|router|server|api|routes?|fastify|instance|handler|controller)$/i;
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All', 'Controller', 'Route']);

/** Keywords that may still be used as a declared name in the supported subset. */
const NOT_A_NAME = new Set([
  'import',
  'export',
  'from',
  'as',
  'class',
  'function',
  'const',
  'let',
  'var',
  'extends',
  'implements',
  'interface',
  'enum',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'delete',
  'typeof',
  'void',
  'in',
  'of',
  'instanceof',
  'default',
  'try',
  'catch',
  'finally',
  'throw',
  'await',
  'yield',
  'this',
  'super',
]);

const DECLARATION_START = new Set([
  'class',
  'interface',
  'function',
  'type',
  'enum',
  'namespace',
  'module',
  'const',
  'let',
  'var',
  'async',
  'abstract',
  'declare',
]);

const STATEMENT_START = new Set([
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'namespace',
  'async',
  'declare',
  'abstract',
]);

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.type === 'punct' && token.value === value;
}

function isKeyword(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.type === 'keyword' && token.value === value;
}

function isName(token: Token | undefined): boolean {
  if (token === undefined) return false;
  if (token.type === 'ident') return true;
  return token.type === 'keyword' && !NOT_A_NAME.has(token.value);
}

function isDeclarationStart(token: Token | undefined): boolean {
  return token !== undefined && token.type === 'keyword' && DECLARATION_START.has(token.value);
}

/** String literal or a template without interpolation. */
function literalValue(token: Token | undefined): string | null {
  if (token === undefined) return null;
  if (token.type === 'string') return token.stringValue ?? token.value.replace(/^['"]|['"]$/g, '');
  if (token.type === 'template' && !token.value.includes('${')) {
    return token.value.replace(/^`|`$/g, '');
  }
  return null;
}

/** Returns the index *after* the matching closing token, or `tokens.length`. */
function skipBalanced(tokens: readonly Token[], index: number, open: string, close: string): number {
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]!.value;
    if (tokens[cursor]!.type !== 'punct') continue;
    if (value === open) depth += 1;
    else if (value === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return tokens.length;
}

function findNext(tokens: readonly Token[], from: number, value: string, limit = 200): number {
  const end = Math.min(tokens.length, from + limit);
  for (let cursor = from; cursor < end; cursor += 1) {
    if (isPunct(tokens[cursor], value)) return cursor;
  }
  return -1;
}

/**
 * Skips a declarator/initializer, stopping at the next `,` or `;` at depth 0 or
 * at a keyword that starts a new statement on a later line.
 */
function skipDeclarator(tokens: readonly Token[], from: number): number {
  const startLine = tokens[from]?.line ?? 0;
  let depth = 0;
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (token.type === 'punct') {
      if (token.value === '(' || token.value === '{' || token.value === '[' || token.value === '<') depth += 1;
      else if (token.value === ')' || token.value === '}' || token.value === ']' || token.value === '>') {
        if (depth === 0) return cursor;
        depth -= 1;
      } else if (depth === 0 && (token.value === ';' || token.value === ',')) return cursor;
      continue;
    }
    if (depth === 0 && token.line > startLine && token.type === 'keyword' && STATEMENT_START.has(token.value)) {
      return cursor;
    }
  }
  return tokens.length;
}

function skipStatement(tokens: readonly Token[], from: number): number {
  const end = skipDeclarator(tokens, from);
  return isPunct(tokens[end], ';') ? end + 1 : end;
}

interface Heritage {
  extendsList: string[];
  implementsList: string[];
  /** Index of the `{` that opens the declaration body, or `-1`. */
  bodyIndex: number;
}

/** Collects `extends` / `implements` identifiers up to the declaration body. */
function collectHeritage(tokens: readonly Token[], from: number): Heritage {
  const extended: string[] = [];
  const implemented: string[] = [];
  let mode: 'none' | 'extends' | 'implements' = 'none';
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (token.type === 'punct') {
      if (token.value === '{' || token.value === ';' || token.value === '=') {
        return { extendsList: extended, implementsList: implemented, bodyIndex: token.value === '{' ? cursor : -1 };
      }
      if (token.value === '(' || token.value === '[') {
        cursor = skipBalanced(tokens, cursor, token.value, token.value === '(' ? ')' : ']') - 1;
        continue;
      }
      if (token.value === '<') {
        cursor = skipBalanced(tokens, cursor, '<', '>') - 1;
        continue;
      }
      continue;
    }
    if (isKeyword(token, 'extends')) {
      mode = 'extends';
      continue;
    }
    if (isKeyword(token, 'implements')) {
      mode = 'implements';
      continue;
    }
    if (isName(token)) {
      if (mode === 'extends') extended.push(token.value);
      else if (mode === 'implements') implemented.push(token.value);
      if (isPunct(tokens[cursor + 1], '<')) {
        cursor = skipBalanced(tokens, cursor + 1, '<', '>') - 1;
      }
      continue;
    }
  }
  return { extendsList: extended, implementsList: implemented, bodyIndex: -1 };
}

interface BracedName {
  name: string;
  alias?: string;
}

/** Reads `{ a, b as c, type D }` between two brace indices. */
function collectBracedNames(tokens: readonly Token[], openIndex: number, closeIndex: number): BracedName[] {
  const entries: BracedName[] = [];
  let cursor = openIndex + 1;
  while (cursor < closeIndex) {
    let name = '';
    let alias: string | undefined;
    if (isKeyword(tokens[cursor], 'type')) cursor += 1; // inline `type` specifier
    const nameToken = tokens[cursor];
    if (isName(nameToken)) {
      name = nameToken.value;
      cursor += 1;
      if (isKeyword(tokens[cursor], 'as') && isName(tokens[cursor + 1])) {
        alias = tokens[cursor + 1]!.value;
        cursor += 2;
      }
    } else {
      cursor += 1;
    }
    if (name.length > 0) entries.push(alias === undefined ? { name } : { name, alias });
    while (cursor < closeIndex && !isPunct(tokens[cursor], ',')) cursor += 1;
    cursor += 1;
  }
  return entries;
}

function mapDeclarationKeyword(keyword: string): SymbolRecord['kind'] {
  switch (keyword) {
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'namespace':
    case 'module':
      return 'namespace';
    case 'type':
      return 'type';
    case 'function':
      return 'function';
    default:
      return 'variable';
  }
}

/** Parses an `import` statement starting at `index`; returns the next index. */
function parseImport(tokens: readonly Token[], index: number, result: ExtractionResult): number {
  let cursor = index + 1;
  let typeOnly = false;
  const line = tokens[index]!.line;

  if (
    isKeyword(tokens[cursor], 'type') &&
    (isPunct(tokens[cursor + 1], '{') ||
      isPunct(tokens[cursor + 1], '*') ||
      (isName(tokens[cursor + 1]) && (isKeyword(tokens[cursor + 2], 'from') || isPunct(tokens[cursor + 2], ','))))
  ) {
    typeOnly = true;
    cursor += 1;
  }

  // dynamic import('...')
  if (isPunct(tokens[cursor], '(')) {
    const specifier = literalValue(tokens[cursor + 1]);
    if (specifier !== null) {
      result.imports.push({ specifier, syntax: 'dynamic', names: [], line, hasSideEffects: false, typeOnly: false });
      result.usesEsmSyntax = true;
    }
    return skipBalanced(tokens, cursor, '(', ')');
  }

  // side-effect only: import './styles.css'
  if (tokens[cursor]?.type === 'string') {
    const specifier = literalValue(tokens[cursor]);
    if (specifier !== null) {
      result.imports.push({ specifier, syntax: 'side-effect', names: [], line, hasSideEffects: true, typeOnly });
      result.usesEsmSyntax = true;
    }
    return skipStatement(tokens, cursor + 1);
  }

  const names: string[] = [];
  let defaultImport: string | undefined;
  let namespaceImport: string | undefined;

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (isKeyword(token, 'from')) {
      cursor += 1;
      break;
    }
    if (token.type === 'string') break;
    if (isPunct(token, '{')) {
      const close = skipBalanced(tokens, cursor, '{', '}');
      for (const entry of collectBracedNames(tokens, cursor, close - 1)) names.push(entry.name);
      cursor = close;
      continue;
    }
    if (isPunct(token, '*')) {
      if (isKeyword(tokens[cursor + 1], 'as') && isName(tokens[cursor + 2])) {
        namespaceImport = tokens[cursor + 2]!.value;
        cursor += 3;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (isPunct(token, '=')) {
      // `import x = require('y')` or `import x = ns.Y`
      if (isKeyword(tokens[cursor + 1], 'require') && isPunct(tokens[cursor + 2], '(')) {
        const specifier = literalValue(tokens[cursor + 3]);
        if (specifier !== null) {
          result.imports.push({ specifier, syntax: 'import-equals', names: [], line, hasSideEffects: false, typeOnly });
          result.usesCommonJs = true;
        }
        return skipBalanced(tokens, cursor + 2, '(', ')');
      }
      return skipStatement(tokens, cursor + 1);
    }
    if (isName(token) && defaultImport === undefined) {
      defaultImport = token.value;
      cursor += 1;
      continue;
    }
    cursor += 1;
  }

  const specifier = literalValue(tokens[cursor]);
  if (specifier !== null) {
    const record: ImportRecord = {
      specifier,
      syntax: typeOnly ? 'type-only' : 'static',
      names,
      line,
      hasSideEffects: false,
      typeOnly,
    };
    if (defaultImport !== undefined) record.defaultImport = defaultImport;
    if (namespaceImport !== undefined) record.namespaceImport = namespaceImport;
    result.imports.push(record);
    if (!typeOnly) result.usesEsmSyntax = true;
    return Math.min(cursor + 1, tokens.length);
  }
  return skipStatement(tokens, cursor);
}

/** Parses an `export` statement starting at `index`; returns the next index. */
function parseExport(tokens: readonly Token[], index: number, result: ExtractionResult): number {
  const line = tokens[index]!.line;
  let cursor = index + 1;

  if (isKeyword(tokens[cursor], 'default')) {
    if (isDeclarationStart(tokens[cursor + 1])) {
      const next = parseDeclaration(tokens, index, result, true, true);
      recordDefaultExportIfMissing(result, line);
      return next;
    }
    result.exports.push({ name: 'default', kind: 'unknown', isDefault: true, line });
    return skipStatement(tokens, cursor + 1);
  }

  let typeOnly = false;
  if (isKeyword(tokens[cursor], 'type') && isPunct(tokens[cursor + 1], '{')) {
    typeOnly = true;
    cursor += 1;
  }

  // export { a, b as c } [from '...']
  if (isPunct(tokens[cursor], '{')) {
    const close = skipBalanced(tokens, cursor, '{', '}');
    const entries = collectBracedNames(tokens, cursor, close - 1);
    if (isKeyword(tokens[close], 'from')) {
      const specifier = literalValue(tokens[close + 1]);
      if (specifier !== null) {
        result.imports.push({
          specifier,
          syntax: 'reexport',
          names: entries.map((entry) => entry.name),
          line,
          hasSideEffects: false,
          typeOnly,
        });
        result.usesEsmSyntax = true;
        for (const entry of entries) {
          result.exports.push({
            name: entry.alias ?? entry.name,
            kind: 'reexport',
            isDefault: false,
            line,
            fromSpecifier: specifier,
            names: [entry.name],
            typeOnly,
          });
        }
        return skipStatement(tokens, close + 2);
      }
    }
    for (const entry of entries) {
      result.exports.push({
        name: entry.alias ?? entry.name,
        kind: 'unknown',
        isDefault: false,
        line,
        typeOnly,
      });
    }
    return skipStatement(tokens, close);
  }

  // export * from '...' / export * as ns from '...'
  if (isPunct(tokens[cursor], '*')) {
    let namespace: string | undefined;
    let scan = cursor + 1;
    if (isKeyword(tokens[scan], 'as') && isName(tokens[scan + 1])) {
      namespace = tokens[scan + 1]!.value;
      scan += 2;
    }
    if (isKeyword(tokens[scan], 'from')) {
      const specifier = literalValue(tokens[scan + 1]);
      if (specifier !== null) {
        const importRecord: ImportRecord = {
          specifier,
          syntax: 'reexport',
          names: [],
          line,
          hasSideEffects: false,
          typeOnly,
        };
        if (namespace !== undefined) importRecord.namespaceImport = namespace;
        result.imports.push(importRecord);
        result.usesEsmSyntax = true;
        result.exports.push({
          name: namespace ?? '*',
          kind: namespace !== undefined ? 'reexport' : 'star',
          isDefault: false,
          line,
          fromSpecifier: specifier,
          typeOnly,
        });
        return skipStatement(tokens, scan + 2);
      }
    }
    return skipStatement(tokens, scan);
  }

  // TypeScript `export = ...`
  if (isPunct(tokens[cursor], '=')) {
    result.exports.push({ name: 'export=', kind: 'unknown', isDefault: false, line });
    result.usesCommonJs = true;
    return skipStatement(tokens, cursor + 1);
  }

  if (isDeclarationStart(tokens[cursor])) {
    return parseDeclaration(tokens, index, result, true, false);
  }

  return skipStatement(tokens, cursor);
}

function recordDefaultExportIfMissing(result: ExtractionResult, line: number): void {
  const hasDefault = result.exports.some((entry) => entry.isDefault);
  if (!hasDefault) result.exports.push({ name: 'default', kind: 'unknown', isDefault: true, line });
}

function pushSymbol(result: ExtractionResult, symbol: SymbolRecord): void {
  const duplicate = result.symbols.some((entry) => entry.name === symbol.name && entry.line === symbol.line);
  if (!duplicate) result.symbols.push(symbol);
}

/** Classifies a variable initializer (`() => {}`, `function () {}`, plain value). */
function inferInitializerKind(tokens: readonly Token[], from: number, declarationKeyword: string): SymbolRecord['kind'] {
  const fallback: SymbolRecord['kind'] = declarationKeyword === 'const' ? 'const' : 'variable';
  if (from >= tokens.length) return fallback;
  let cursor = from;
  if (isPunct(tokens[cursor], ':')) {
    // annotated declaration: skip the type annotation
    cursor += 1;
    while (cursor < tokens.length && !isPunct(tokens[cursor], '=')) {
      if (isPunct(tokens[cursor], '<')) cursor = skipBalanced(tokens, cursor, '<', '>');
      if (isPunct(tokens[cursor], '(')) cursor = skipBalanced(tokens, cursor, '(', ')');
      if (isPunct(tokens[cursor], '{')) cursor = skipBalanced(tokens, cursor, '{', '}');
      cursor += 1;
    }
  }
  if (!isPunct(tokens[cursor], '=')) return fallback;
  cursor += 1;
  if (isKeyword(tokens[cursor], 'async')) cursor += 1;
  if (isKeyword(tokens[cursor], 'function')) return 'function';
  if (isKeyword(tokens[cursor], 'class')) return 'class';
  if (isPunct(tokens[cursor], '(')) {
    const afterParams = skipBalanced(tokens, cursor, '(', ')');
    if (isPunct(tokens[afterParams], '=>')) return 'function';
  }
  const end = skipDeclarator(tokens, cursor);
  for (let scan = cursor; scan < end; scan += 1) {
    if (isPunct(tokens[scan], '=>')) return 'function';
    if (isKeyword(tokens[scan], 'function')) return 'function';
  }
  return fallback;
}

function parseVariableDeclaration(
  tokens: readonly Token[],
  keywordIndex: number,
  result: ExtractionResult,
  exported: boolean,
  isDefault: boolean,
): number {
  const declarationKeyword = tokens[keywordIndex]!.value;
  let cursor = keywordIndex + 1;
  for (;;) {
    const nameToken = tokens[cursor];
    if (!isName(nameToken)) return skipStatement(tokens, cursor);
    pushSymbol(result, {
      name: nameToken!.value,
      kind: inferInitializerKind(tokens, cursor + 1, declarationKeyword),
      exported,
      isDefault,
      extends: [],
      implements: [],
      line: nameToken!.line,
    });
    const next = skipDeclarator(tokens, cursor + 1);
    if (isPunct(tokens[next], ',')) {
      cursor = next + 1;
      continue;
    }
    return isPunct(tokens[next], ';') ? next + 1 : next;
  }
}

/** Parses a class/interface/function/type/enum/var declaration; returns the next index. */
function parseDeclaration(
  tokens: readonly Token[],
  index: number,
  result: ExtractionResult,
  exported: boolean,
  isDefault: boolean,
): number {
  let cursor = index;
  let exportedFlag = exported;
  let defaultFlag = isDefault;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (isKeyword(token, 'export')) {
      exportedFlag = true;
      cursor += 1;
      continue;
    }
    if (isKeyword(token, 'default')) {
      defaultFlag = true;
      cursor += 1;
      continue;
    }
    if (isKeyword(token, 'declare') || isKeyword(token, 'abstract') || isKeyword(token, 'async')) {
      cursor += 1;
      continue;
    }
    break;
  }
  const keywordToken = tokens[cursor];
  if (keywordToken === undefined || keywordToken.type !== 'keyword') return cursor;
  const keyword = keywordToken.value;
  const line = keywordToken.line;

  if (keyword === 'class' || keyword === 'interface' || keyword === 'enum' || keyword === 'namespace' || keyword === 'module') {
    const nameToken = tokens[cursor + 1];
    const name = isName(nameToken) ? nameToken!.value : '';
    const heritage = collectHeritage(tokens, cursor + 2);
    if (name.length > 0) {
      pushSymbol(result, {
        name,
        kind: mapDeclarationKeyword(keyword),
        exported: exportedFlag,
        isDefault: defaultFlag,
        extends: heritage.extendsList,
        implements: heritage.implementsList,
        line,
      });
      if (heritage.extendsList.includes('Error')) result.signals.push(SIGNALS.customErrorClass);
    }
    if (heritage.bodyIndex >= 0) return skipBalanced(tokens, heritage.bodyIndex, '{', '}');
    return skipStatement(tokens, cursor + 2);
  }

  if (keyword === 'function') {
    let scan = cursor + 1;
    if (isPunct(tokens[scan], '*')) scan += 1;
    const nameToken = tokens[scan];
    if (isName(nameToken)) {
      pushSymbol(result, {
        name: nameToken!.value,
        kind: 'function',
        exported: exportedFlag,
        isDefault: defaultFlag,
        extends: [],
        implements: [],
        line: nameToken!.line,
      });
      scan += 1;
    }
    const params = findNext(tokens, scan, '(');
    if (params === -1) return skipStatement(tokens, scan);
    const afterParams = skipBalanced(tokens, params, '(', ')');
    if (isPunct(tokens[afterParams], '{')) return skipBalanced(tokens, afterParams, '{', '}');
    return skipStatement(tokens, afterParams);
  }

  if (keyword === 'type') {
    const nameToken = tokens[cursor + 1];
    if (isName(nameToken)) {
      pushSymbol(result, {
        name: nameToken!.value,
        kind: 'type',
        exported: exportedFlag,
        isDefault: defaultFlag,
        extends: [],
        implements: [],
        line: nameToken!.line,
      });
    }
    return skipStatement(tokens, cursor + 2);
  }

  if (keyword === 'const' || keyword === 'let' || keyword === 'var') {
    return parseVariableDeclaration(tokens, cursor, result, exportedFlag, defaultFlag);
  }

  return cursor;
}

/** Detects coarse language signals around a single token position. */
function collectSignals(tokens: readonly Token[], cursor: number, result: ExtractionResult): void {
  const token = tokens[cursor]!;
  if (token.type !== 'ident' && token.type !== 'keyword') return;
  const next = tokens[cursor + 1];
  const next2 = tokens[cursor + 2];
  const value = token.value;

  if (isPunct(next, '(')) {
    if (value === 'require') {
      const specifier = literalValue(next2);
      if (specifier !== null) {
        result.imports.push({ specifier, syntax: 'require', names: [], line: token.line, hasSideEffects: false, typeOnly: false });
        result.usesCommonJs = true;
        return;
      }
    }
    if (value === 'describe' || value === 'it' || value === 'test' || value === 'beforeEach' || value === 'afterEach') {
      result.signals.push(SIGNALS.testSuite);
    }
    if (value === 'EventEmitter') result.signals.push(SIGNALS.eventEmitter);
    if (value === 'Queue' || value === 'Job' || value === 'Worker') {
      result.signals.push(value === 'Worker' ? SIGNALS.worker : SIGNALS.queue);
    }
    if (value === 'setInterval' || value === 'setTimeout' || value === 'cron' || value === 'schedule') {
      result.signals.push(SIGNALS.schedule);
    }
  }

  if (token.type === 'ident' && /^[A-Z]/.test(value) && isPunct(next, '(')) {
    result.calls.push({ name: value, line: token.line });
  }
  if (isKeyword(token, 'new') && isName(next)) {
    result.calls.push({ name: next!.value, line: token.line });
  }
  if (value === 'process' && isPunct(next, '.') && next2?.value === 'env') {
    result.signals.push(SIGNALS.envAccess);
  }
  if (value === 'console' && isPunct(next, '.')) result.signals.push(SIGNALS.consoleUsage);
  if ((value === 'window' || value === 'document') && isPunct(next, '.')) result.signals.push(SIGNALS.browserApi);
  if ((value === 'emit' || value === 'publish' || value === 'dispatch' || value === 'subscribe') && isPunct(next, '(')) {
    result.signals.push(SIGNALS.eventEmitter);
  }
  if (value === 'listen' && isPunct(next, '(')) result.signals.push(SIGNALS.httpFramework);

  if (ROUTE_RECEIVER.test(value) && isPunct(next, '.') && next2?.type === 'ident' && ROUTE_METHODS.has(next2.value)) {
    const routePath = literalValue(tokens[cursor + 4]);
    if (isPunct(tokens[cursor + 3], '(') && routePath !== null && routePath.startsWith('/')) {
      result.routes.push({ method: next2.value.toUpperCase(), path: routePath, line: token.line });
      result.signals.push(SIGNALS.httpRoute);
    }
  }
}

/**
 * Extracts imports, exports, symbols, calls, routes and signals from TS/JS source.
 *
 * The function never throws: malformed input yields `parseStatus: 'partial'`
 * together with the facts that could still be recovered.
 */
export function extractModuleFacts(source: string): ExtractionResult {
  const tokens = tokensWithoutComments(tokenize(source));
  const result: ExtractionResult = {
    imports: [],
    exports: [],
    symbols: [],
    calls: [],
    routes: [],
    signals: [],
    parseStatus: 'ok',
    usesEsmSyntax: false,
    usesCommonJs: false,
  };

  let depth = 0;
  let cursor = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.type === 'punct') {
      if (token.value === '{' || token.value === '(' || token.value === '[') depth += 1;
      else if (token.value === '}' || token.value === ')' || token.value === ']') depth = Math.max(0, depth - 1);
      else if (token.value === '@') {
        const decorator = tokens[cursor + 1];
        result.signals.push(SIGNALS.decorators);
        if (isName(decorator)) {
          result.signals.push(`decorator:${decorator.value}`);
          if (HTTP_DECORATORS.has(decorator.value)) result.signals.push(SIGNALS.httpRoute);
          if (decorator.value === 'Controller') result.signals.push(SIGNALS.httpFramework);
        }
      }
      cursor += 1;
      continue;
    }
    if (isKeyword(token, 'import')) {
      const next = parseImport(tokens, cursor, result);
      cursor = next > cursor ? next : cursor + 1;
      continue;
    }
    if (isKeyword(token, 'export') && depth === 0) {
      const next = parseExport(tokens, cursor, result);
      cursor = next > cursor ? next : cursor + 1;
      continue;
    }
    if (depth === 0 && isDeclarationStart(token)) {
      const next = parseDeclaration(tokens, cursor, result, false, false);
      cursor = next > cursor ? next : cursor + 1;
      continue;
    }
    collectSignals(tokens, cursor, result);
    cursor += 1;
  }

  let braceBalance = 0;
  let unterminatedLiteral = false;
  for (const token of tokens) {
    if (token.type === 'punct') {
      if (token.value === '{') braceBalance += 1;
      else if (token.value === '}') braceBalance -= 1;
      continue;
    }
    if (token.type === 'string') {
      const first = token.value[0];
      const last = token.value[token.value.length - 1];
      if (token.value.length > 1 && first !== last) unterminatedLiteral = true;
    }
    if (token.type === 'template') {
      if (!token.value.endsWith('`')) unterminatedLiteral = true;
    }
  }
  if (braceBalance !== 0 || unterminatedLiteral) result.parseStatus = 'partial';
  if (result.usesEsmSyntax) result.signals.push(SIGNALS.esm);
  if (result.usesCommonJs && !result.usesEsmSyntax) result.signals.push(SIGNALS.commonjs);
  result.signals = normalizeSignals(result.signals);
  return result;
}