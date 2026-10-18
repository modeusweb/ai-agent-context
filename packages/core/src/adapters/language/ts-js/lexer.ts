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
  | 'jsx'
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

/**
 * Punctuators after which `/` starts a regular expression and `<` starts a JSX
 * element, rather than either being an operator.
 *
 * `=>` belongs here for the same reason `=` does: an arrow function body is an
 * expression, so `useCallback(() => /re/.test(x))` and `render(() => <div />)`
 * are both an expression after the arrow. Leaving it out made every JSX element
 * returned from an arrow function read as a type argument list, which unbalanced
 * the statement scanner and cost the file the rest of its imports.
 */
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
  '=>',
  // The two-character logical operators are listed as well as their
  // single-character forms, because the lexer produces `&&` as one token: the
  // set is matched against token values, not source characters. A JSX child
  // written as `{ok && <Error />}` is exactly this case.
  '&&',
  '||',
  '??',
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

/**
 * Skips a JSX element, leaving `state.index` after its closing `>`.
 *
 * JSX is the reason a `<` cannot simply be counted as a bracket. In
 * `<Trigger onClick={(e) => f(e)} />` the braces belong to an attribute, not to a
 * block, and `/>` is not a type argument list closing. Counting them skewed the
 * depth balance of every statement scanner that walked the token stream, which
 * ran to the end of the file and dropped the statements after it — so a TSX file
 * with an arrow function in a prop silently lost its imports.
 *
 * Emitting the whole element as one token keeps it out of the balance the same
 * way a template literal already is.
 *
 * Returns `false` without moving when the text is not a JSX element, so the
 * caller can fall back to treating the `<` as a type argument. The two are
 * genuinely ambiguous — `<T>(x)` and `<T />` start the same way — so the
 * decision is made by position and then confirmed by the shape: a `<` after an
 * identifier or a closing bracket is type arguments, and one in expression
 * position is JSX.
 */
function skipJsxElement(state: LexerState): boolean {
  const source = state.source;
  const start = state.index;
  let cursor = start + 1;

  const skipSpace = (): void => {
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  };

  /** A tag name: an identifier, dotted, with `-` for web components. */
  const readTagName = (): boolean => {
    const nameStart = cursor;
    while (cursor < source.length && /[A-Za-z0-9_$.\-:!]/.test(source[cursor]!)) cursor += 1;
    return cursor > nameStart;
  };

  /** Skips a `{ ... }` attribute or child expression. */
  const skipExpression = (): boolean => {
    // `skipBalancedExpression` expects to start *after* the opening brace, the
    // same position `readTemplate` leaves it in when it sees `${`.
    state.index = cursor + 1;
    skipBalancedExpression(state, '{', '}');
    cursor = state.index;
    return cursor <= source.length;
  };

  /** Skips attributes of an opening tag; returns false if it is not one. */
  const skipAttributes = (): boolean => {
    while (cursor < source.length) {
      skipSpace();
      if (source.startsWith('/>', cursor)) {
        cursor += 2;
        return true;
      }
      if (source[cursor] === '>') {
        cursor += 1;
        return true;
      }
      // A `(` before the tag closes is a type argument list, not JSX: `f<T>(x)`.
      if (source[cursor] === '(') return false;
      if (source[cursor] === '{') {
        if (!skipExpression()) return false;
        continue;
      }
      if (source.startsWith('...', cursor)) {
        cursor += 3;
        continue;
      }
      // Attribute names and their quoted values.
      if (/["']/.test(source[cursor]!)) {
        const quote = source[cursor]!;
        cursor += 1;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        if (cursor >= source.length) return false;
        cursor += 1;
        continue;
      }
      cursor += 1;
    }
    return false;
  };

  skipSpace();
  // `<>` opens a fragment and `</>` closes one: both have no tag name, and what
  // follows is children rather than attributes. Running the attribute scan there
  // consumed the first child — and, for a self-closing child, ended the fragment
  // one element too early.
  if (source[cursor] === '>') {
    cursor += 1;
  } else if (source[cursor] === '/') {
    cursor += 1;
    skipSpace();
    if (source[cursor] !== '>') {
      if (!readTagName()) return false;
      skipSpace();
    }
    if (source[cursor] !== '>') return false;
    cursor += 1;
    state.index = cursor;
    return true;
  } else if (!readTagName()) {
    return false;
  } else if (!skipAttributes()) {
    return false;
  } else if (source.slice(cursor - 2, cursor) === '/>') {
    state.index = cursor;
    return true;
  }

  // Children, until the matching closing tag.
  while (cursor < source.length) {
    if (source[cursor] === '{') {
      if (!skipExpression()) return false;
      continue;
    }
    if (source[cursor] !== '<') {
      cursor += 1;
      continue;
    }
    // A `</` here closes this element, at any nesting depth.
    const after = cursor + 1;
    if (source[after] === '/') {
      cursor = after + 1;
      skipSpace();
      if (source[cursor] !== '>' && !readTagName()) return false;
      skipSpace();
      if (source[cursor] !== '>') return false;
      cursor += 1;
      state.index = cursor;
      return true;
    }
    state.index = cursor;
    if (!skipJsxElement(state)) return false;
    cursor = state.index;
  }
  return false;
}

/**
 * Skips a balanced `{...}` region, scanning it the way a JavaScript expression
 * is scanned.
 *
 * This runs inside `${ ... }`, so it has to survive everything an expression may
 * contain. It used to handle comments, strings and nested templates and nothing
 * else, and a bare `/` was always tested against the two comment forms. A regex
 * literal ending in an escaped slash — the ordinary way to write "replace
 * slashes", and common in a template literal — has the shape `/\//`, whose last
 * two characters are adjacent slashes. That was read as the start of a line
 * comment: the rest of the line was discarded, the scan carried on past the
 * closing brace, and the file came out partial with the statements after it
 * missing their imports.
 *
 * The previous token is tracked here for the same reason the main loop tracks
 * it: `/` is a regex start or a division depending on what came before, and
 * guessing wrong either way corrupts the scan.
 */
function skipBalancedExpression(state: LexerState, open: string, close: string): void {
  let depth = 1;
  let previous: { type: TokenType; value: string } | null = null;

  /** Reads a token through the shared readers, then drops it from the stream. */
  const take = (read: () => void): void => {
    const before = state.tokens.length;
    read();
    const token = state.tokens[before];
    state.tokens.pop();
    if (token !== undefined) previous = { type: token.type, value: token.value };
  };
  const remember = (type: TokenType, value: string): void => {
    previous = { type, value };
  };

  while (state.index < state.source.length && depth > 0) {
    const character = state.source[state.index]!;

    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (character === '/' && state.source[state.index + 1] === '/') {
      take(() => skipLineComment(state));
      continue;
    }
    if (character === '/' && state.source[state.index + 1] === '*') {
      take(() => skipBlockComment(state));
      continue;
    }
    if (character === '/' && regexAllowed(previous)) {
      take(() => readRegex(state));
      continue;
    }
    // A JSX element can also appear inside the expression, which is how a
    // conditional child reads: `{cond ? <A /> : <B />}`. Without this the `<` was
    // counted as a bracket, and the unbalanced `/>` skewed every statement
    // scanner in the file.
    if (character === '<' && regexAllowed(previous)) {
      const start = state.index;
      if (skipJsxElement(state)) {
        previous = { type: 'jsx', value: '' };
        continue;
      }
      state.index = start;
    }
    if (character === '"' || character === "'") {
      take(() => readString(state, character));
      continue;
    }
    if (character === '`') {
      take(() => readTemplate(state));
      continue;
    }
    if (isDigit(character)) {
      take(() => readNumber(state));
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = state.index;
      while (state.index < state.source.length && isIdentifierPart(state.source[state.index]!)) state.index += 1;
      const value = state.source.slice(start, state.index);
      remember(TS_KEYWORDS.has(value) ? 'keyword' : 'ident', value);
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
    } else {
      const punctuator = PUNCTUATORS.find((candidate) => state.source.startsWith(candidate, state.index));
      if (punctuator === undefined) {
        remember('unknown', character);
        state.index += 1;
        continue;
      }
      remember('punct', punctuator);
      state.index += punctuator.length;
      continue;
    }
    remember('punct', character);
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

function regexAllowed(previous: { type: TokenType; value: string } | null): boolean {
  if (previous === null) return true;
  if (previous.type === 'punct') return REGEX_PRECEDING_PUNCT.has(previous.value);
  if (previous.type === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  return false;
}

/**
 * Whether a `<` here starts a JSX element rather than a type argument list.
 *
 * The same positions that can be followed by a regular expression can be
 * followed by an element: both appear where an expression is expected. The sets
 * are shared deliberately — they are the same grammar fact.
 */
function jsxAllowed(previous: { type: TokenType; value: string } | null): boolean {
  return regexAllowed(previous);
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
      // A `<` in expression position is a JSX element, not a type argument list.
      // The shape check inside keeps `f<T>(x)` working: it declines anything
      // that turns out not to be an element, and the `<` is then a bracket.
      if (punctuator === '<' && jsxAllowed(lastSignificant(state.tokens))) {
        if (skipJsxElement(state)) {
          state.push('jsx', start, state.index, source.slice(start, state.index));
          continue;
        }
        state.index = start;
      }
      if (punctuator === '/' && regexAllowed(lastSignificant(state.tokens))) {
        state.index = start;
        readRegex(state);
        continue;
      }
      state.index += punctuator.length;
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