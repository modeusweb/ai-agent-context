/**
 * Text analysis for search.
 *
 * Deterministic and language-agnostic-but-identifier-aware: code identifiers are
 * split (`refundPayment` → `refund payment`), light English stemming is applied to
 * both the index and the query, and a small synonym map lets an agent ask
 * "payment idempotency" and still find `PaymentMustBeIdempotentError`.
 */
import { splitIdentifier } from '../../util/text.ts';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
]);

/** Domain synonyms: query term → additional index terms. */
export const SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'authorization', 'login', 'token'],
  authentication: ['auth', 'login', 'token'],
  authorization: ['auth', 'permission', 'policy', 'acl'],
  payment: ['payments', 'billing', 'charge', 'invoice', 'stripe', 'checkout'],
  payments: ['payment', 'billing', 'charge', 'invoice', 'stripe'],
  billing: ['payment', 'invoice', 'subscription'],
  user: ['users', 'account', 'profile', 'identity'],
  users: ['user', 'account', 'identity'],
  db: ['database', 'repository', 'persistence', 'sql', 'query'],
  database: ['db', 'repository', 'persistence', 'sql', 'migration'],
  repository: ['db', 'database', 'persistence', 'store'],
  api: ['endpoint', 'route', 'controller', 'http', 'rest'],
  endpoint: ['api', 'route', 'controller'],
  route: ['api', 'endpoint', 'router', 'controller'],
  event: ['events', 'bus', 'publisher', 'subscriber', 'message', 'domain-event'],
  events: ['event', 'bus', 'messaging', 'publisher'],
  queue: ['job', 'worker', 'consumer', 'producer', 'broker'],
  job: ['queue', 'worker', 'cron', 'scheduler'],
  worker: ['job', 'queue', 'background'],
  cache: ['caching', 'redis', 'memo'],
  config: ['configuration', 'settings', 'env', 'environment'],
  configuration: ['config', 'settings', 'env'],
  error: ['errors', 'exception', 'failure'],
  test: ['tests', 'spec', 'testing'],
  tests: ['test', 'spec', 'suite'],
  build: ['compile', 'bundler', 'toolchain'],
  cli: ['command', 'bin', 'argument'],
  log: ['logging', 'logger', 'telemetry'],
  logging: ['log', 'logger'],
  security: ['auth', 'secret', 'credential', 'permission'],
  idempotent: ['idempotency', 'retry', 'duplicate'],
  idempotency: ['idempotent', 'retry', 'duplicate'],
  invariant: ['invariants', 'constraint', 'must', 'never'],
  invariant_s: ['invariants', 'constraint'],
  style: ['convention', 'format', 'lint'],
  convention: ['conventions', 'style', 'rule', 'pattern'],
  architecture: ['structure', 'layer', 'module', 'design'],
  module: ['package', 'component', 'service'],
  dependency: ['dependencies', 'import', 'requires'],
  contract: ['interface', 'port', 'boundary'],
  boundary: ['contract', 'interface', 'port'],
};

/**
 * Light stemmer: handles the plural/gerund/past forms that dominate code
 * identifiers and prose, and leaves anything else untouched.
 */
export function stem(term: string): string {
  if (term.length <= 3) return term;
  const rules: Array<[RegExp, string]> = [
    [/ies$/, 'y'],
    [/(ss|us|is)es$/, '$1'],
    [/([^s])s$/, '$1'],
    [/ing$/, ''],
    [/edly$/, ''],
    [/ed$/, ''],
    [/ally$/, 'al'],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(term)) {
      const candidate = term.replace(pattern, replacement);
      if (candidate.length >= 3) return candidate;
    }
  }
  return term;
}

/** Extracts normalized, deduplicated terms from arbitrary text. */
export function analyze(text: string, options: { keepStopWords?: boolean } = {}): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of splitIdentifier(text)) {
    if (word.length < 2) continue;
    if (!options.keepStopWords && STOP_WORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    const stemmed = stem(word);
    for (const candidate of new Set([word, stemmed])) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      terms.push(candidate);
    }
  }
  return terms;
}

/** Expands query terms with synonyms, keeping the original terms. */
export function expandQueryTerms(terms: readonly string[]): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };
  for (const term of terms) {
    add(term, 1);
    const synonyms = SYNONYMS[term] ?? SYNONYMS[stem(term)];
    if (synonyms === undefined) continue;
    for (const synonym of synonyms) {
      for (const expanded of analyze(synonym, { keepStopWords: true })) add(expanded, 0.45);
    }
  }
  return weights;
}

/** Path segments of a repository-relative path, for identifier boosting. */
export function pathSegments(path: string): string[] {
  return path
    .split('/')
    .flatMap((segment) => splitIdentifier(segment))
    .filter((segment) => segment.length > 1);
}