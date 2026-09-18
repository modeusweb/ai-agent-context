/**
 * A compact TypeScript/JavaScript lexer.
 *
 * Why not a full AST: the goal of the MVP graph is a *reliable* import/export
 * graph, and a tokenizer that understands comments, strings, template literals,
 * regular expressions and nested braces gets there without pulling a compiler
 * into a 100k-file scan. The lexer is deterministic, allocation-light and never
 * throws on malformed input.
 */
export type TokenType =
  | 'ident'
  | 'keyword'
  | 'string'
  | 'template'
  | 'number'
  | 'punct'
  | 'regex'
  | 'comment'
  | 'unknown';

export interface Token {
  type: TokenType;
  /** Token text; for strings/templates this is the *raw* text including quotes. */
  value: string;
  /** Decoded string value for `string` tokens. */
  stringValue?: string;
  start: number;
  end: number;
  /** 1-based line number. */
  line: number;
}

export const TS_KEYWORDS = new Set([
  'abstract',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'global',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'override',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'satisfies',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'delete',
  'void',
  'new',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

const REGEX_PRECEDING_PUNCT = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '&&=',
  '||=',
  '??=',
  '>>>',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '!',
  '~',
  '?',
  ':',
  '=',
  '.',
  '#',
  '@',
];

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    character === '_' ||
    character === '$'
  );
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}

function decodeStringLiteral(raw: string): string {
  const body = raw.replace(/^['"]|['"]$/g, '');
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(['"\\])/g, '$1');
}

class LexerState {
  readonly source: string;
  index = 0;
  readonly tokens: Token[] = [];
  readonly lineStarts: number[] = [0];

  constructor(source: string) {
    this.source = source;
    this.indexLines();
  }

  private indexLines(): void {
    for (let index = 0; index < this.source.length; index += 1) {
      if (this.source[index] === '\n') this.lineStarts.push(index + 1);
    }
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  push(type: TokenType, start: number, end: number, value: string, stringValue?: string): void {
    const token: Token = { type, value, start, end, line: this.lineAt(start) };
    if (stringValue !== undefined) token.stringValue = stringValue;
    this.tokens.push(token);
  }
}

function skipLineComment(state: LexerState): void {
  const start = state.index;
  while (state.index < state.source.length && state.source[state.index] !== '\n') state.index += 1;
  state.push('comment', start, state.index, state.source.slice(start, state.index));
}

function skipBlockComment(state: LexerState): void {
  const start = state.index;
  state.index += 2;
  while (state.index < state.source.length) {
    if (state.source[state.index] === '*' && state.source[state.index + 1] === '/') {
      state.index += 2;
      break;
    }
    state.index += 1;
  }
  state.push('comment', start, state.index, state.source.slice(start, state.index));
}

function readString(state: LexerState, quote: string): void {
  const start = state.index;
  state.index += 1;
  while (state.index < state.source.length) {
    const character = state.source[state.index]!;
    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (character === quote) {
      state.index += 1;
      break;
    }
    if (character === '\n') break; // unterminated string: stop at the line break
    state.index += 1;
  }
  const raw = state.source.slice(start, state.index);
  state.push('string', start, state.index, raw, decodeStringLiteral(raw));
}

/** Skips a template literal, including nested `${ ... }` expressions. */
function readTemplate(state: LexerState): void {
  const start = state.index;
  state.index += 1;
  while (state.index < state.source.length) {
    const character = state.source[state.index]!;
    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (character === '`') {
      state.index += 1;
      break;
    }
    if (character === '$' && state.source[state.index + 1] === '{') {
      state.index += 2;
      skipBalancedExpression(state, '{', '}');
      continue;
    }
    state.index += 1;
  }
  state.push('template', start, state.index, state.source.slice(start, state.index));
}

/** Skips a balanced `{...}` region, respecting nested strings and comments. */
function skipBalancedExpression(state: LexerState, open: string, close: string): void {
  let depth = 1;
  while (state.index < state.source.length && depth > 0) {
    const character = state.source[state.index]!;
    if (character === '/' && state.source[state.index + 1] === '/') {
      skipLineComment(state);
      state.tokens.pop();
      continue;
    }
    if (character === '/' && state.source[state.index + 1] === '*') {
      skipBlockComment(state);
      state.tokens.pop();
      continue;
    }
    if (character === '"' || character === "'") {
      readString(state, character);
      state.tokens.pop();
      continue;
    }
    if (character === '`') {
      readTemplate(state);
      state.tokens.pop();
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) depth -= 1;
    state.index += 1;
  }
}

function readNumber(state: LexerState): void {
  const start = state.index;
  while (state.index < state.source.length) {
    const character = state.source[state.index]!;
    if (!/[0-9a-fA-FxXoObBeE._+-]/.test(character)) break;
    if ((character === '+' || character === '-') && !/[eE]/.test(state.source[state.index - 1] ?? '')) break;
    state.index += 1;
  }
  state.push('number', start, state.index, state.source.slice(start, state.index));
}

function readIdentifier(state: LexerState): void {
  const start = state.index;
  while (state.index < state.source.length && isIdentifierPart(state.source[state.index]!)) state.index += 1;
  const value = state.source.slice(start, state.index);
  state.push(TS_KEYWORDS.has(value) ? 'keyword' : 'ident', start, state.index, value);
}

function readRegex(state: LexerState): void {
  const start = state.index;
  state.index += 1;
  let inClass = false;
  while (state.index < state.source.length) {
    const character = state.source[state.index]!;
    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (character === '\n') break;
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      state.index += 1;
      break;
    }
    state.index += 1;
  }
  while (state.index < state.source.length && /[a-z]/i.test(state.source[state.index]!)) state.index += 1;
  state.push('regex', start, state.index, state.source.slice(start, state.index));
}

function lastSignificant(tokens: readonly Token[]): Token | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.type !== 'comment') return token;
  }
  return null;
}

function regexAllowed(previous: Token | null): boolean {
  if (previous === null) return true;
  if (previous.type === 'punct') return REGEX_PRECEDING_PUNCT.has(previous.value);
  if (previous.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  return false;
}

/**
 * Tokenizes `source`. Comments are emitted (and can be filtered out with
 * {@link tokensWithoutComments}); malformed input never throws.
 */
export function tokenize(source: string): Token[] {
  const state = new LexerState(source);
  while (state.index < source.length) {
    const character = source[state.index]!;
    if (character === '\n' || character === ' ' || character === '\t' || character === '\r' || character === '\u00a0') {
      state.index += 1;
      continue;
    }
    if (character === '/' && source[state.index + 1] === '/') {
      skipLineComment(state);
      continue;
    }
    if (character === '/' && source[state.index + 1] === '*') {
      skipBlockComment(state);
      continue;
    }
    if (character === '"' || character === "'") {
      readString(state, character);
      continue;
    }
    if (character === '`') {
      readTemplate(state);
      continue;
    }
    if (isDigit(character)) {
      readNumber(state);
      continue;
    }
    if (isIdentifierStart(character)) {
      readIdentifier(state);
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, state.index));
    if (punctuator !== undefined) {
      const start = state.index;
      state.index += punctuator.length;
      if (punctuator === '/' && regexAllowed(lastSignificant(state.tokens))) {
        state.index = start;
        readRegex(state);
        continue;
      }
      state.push('punct', start, state.index, punctuator);
      continue;
    }
    const start = state.index;
    state.index += 1;
    state.push('unknown', start, state.index, character);
  }
  return state.tokens;
}

/** Significant tokens only (comments removed), for stack based extraction. */
export function tokensWithoutComments(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => token.type !== 'comment');
}