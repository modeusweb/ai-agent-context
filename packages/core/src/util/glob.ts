/**
 * Minimal, dependency-free glob engine.
 *
 * Supported syntax (a documented subset of gitignore/minimatch semantics):
 *
 * | Pattern         | Meaning                                                       |
 * | --------------- | ------------------------------------------------------------- |
 * | `*`             | any characters inside a single path segment                    |
 * | `**`            | any number of path segments                                    |
 * | `?`             | a single character inside a segment                            |
 * | `[abc]`/`[!ab]` | character class / negated character class                      |
 * | `{a,b}`         | alternation                                                    |
 * | `prefix/**`     | everything below `prefix`, including the directory itself      |
 * | `name/`         | the directory `name` and everything below it                   |
 * | `!pattern`      | negation; the last matching rule wins (see {@link PatternSet}) |
 *
 * Patterns without a `/` match by basename at any depth.
 */
import { compareStrings } from '../model/canonical.ts';

const REGEXP_SPECIALS = new Set(['.', '+', '(', ')', '|', '^', '$', '\\', '/']);

function escapeLiteral(character: string): string {
  return REGEXP_SPECIALS.has(character) ? `\\${character}` : character;
}

function findMatchingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function translatePattern(pattern: string): string {
  let output = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2;
        // `**/` and `a/**/b` mean "zero or more segments"
        if (pattern[index] === '/') {
          output += '(?:[^/]*/)*';
          index += 1;
        } else {
          output += '.*';
        }
        continue;
      }
      output += '[^/]*';
      index += 1;
      continue;
    }
    if (character === '?') {
      output += '[^/]';
      index += 1;
      continue;
    }
    if (character === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing === -1) {
        output += '\\[';
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, closing);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      output += `[${body.replace(/\\/g, '\\\\')}]`;
      index = closing + 1;
      continue;
    }
    if (character === '{') {
      const closing = findMatchingBrace(pattern, index);
      if (closing !== -1) {
        const alternatives = splitAlternatives(pattern.slice(index + 1, closing));
        output += `(?:${alternatives.map((alternative) => translatePattern(alternative)).join('|')})`;
        index = closing + 1;
        continue;
      }
      output += '\\{';
      index += 1;
      continue;
    }
    output += escapeLiteral(character);
    index += 1;
  }
  return output;
}

export interface CompiledRule {
  raw: string;
  negated: boolean;
  /** `true` when the rule also matches paths below a matched directory. */
  directoryScoped: boolean;
  regex: RegExp;
}

function normalizePatternPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function compileRule(rawPattern: string): CompiledRule {
  let pattern = rawPattern.trim();
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let directoryScoped = false;
  if (pattern.endsWith('/')) {
    pattern = pattern.slice(0, -1);
    directoryScoped = true;
  }
  if (pattern.endsWith('/**')) {
    pattern = pattern.slice(0, -3);
    directoryScoped = true;
  }
  const hasSlash = pattern.includes('/');
  const body = translatePattern(pattern);
  const prefix = hasSlash ? '^' : '^(?:.*/)?';
  const suffix = directoryScoped ? '(?:/.*)?$' : '$';
  return {
    raw: rawPattern,
    negated,
    directoryScoped,
    regex: new RegExp(`${prefix}${body}${suffix}`),
  };
}

function ancestorPaths(path: string): string[] {
  const parts = path.split('/').filter((segment) => segment.length > 0);
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join('/'));
  }
  return result;
}

/** Ordered set of include/exclude glob rules with `.gitignore`-like semantics. */
export class PatternSet {
  readonly rules: CompiledRule[];

  constructor(patterns: readonly string[] = []) {
    this.rules = patterns.filter((pattern) => pattern.trim().length > 0).map(compileRule);
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Evaluates rules in declaration order; the last matching rule wins (as in
   * `.gitignore`). Directory-scoped rules also match descendants.
   */
  test(path: string, isDirectory = false): boolean {
    const normalized = normalizePatternPath(path);
    if (normalized.length === 0) return false;
    const parents = ancestorPaths(normalized);
    let ignored = false;
    for (const rule of this.rules) {
      let matched = rule.regex.test(normalized);
      if (!matched && rule.directoryScoped) {
        matched = parents.some((ancestor) => rule.regex.test(ancestor));
      }
      if (matched) ignored = !rule.negated;
    }
    void isDirectory;
    return ignored;
  }

  /** `true` when at least one positive pattern matches the path. */
  matchesAny(path: string): boolean {
    const normalized = normalizePatternPath(path);
    return this.rules.some((rule) => !rule.negated && rule.regex.test(normalized));
  }

  /** Sorted, deduplicated list of the configured patterns. */
  toArray(): string[] {
    return [...new Set(this.rules.map((rule) => rule.raw))].sort(compareStrings);
  }
}

/** Convenience wrapper returning a single-pattern predicate. */
export function compileGlob(pattern: string): (path: string) => boolean {
  const rule = compileRule(pattern);
  return (path: string): boolean => rule.regex.test(normalizePatternPath(path));
}