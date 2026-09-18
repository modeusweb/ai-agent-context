/**
 * BM25 ranking over repository context nodes.
 *
 * Deterministic: no randomness, no external services, no embeddings. Scoring uses
 * field-weighted term frequencies (title ≫ keywords > body) and exact identifier
 * boosts, so `payment idempotency` ranks `PaymentMustBeIdempotentError` above a
 * file that merely mentions the words.
 */
import { compareStrings } from '../../model/canonical.ts';
import { analyze, expandQueryTerms, pathSegments, stem } from './analyzer.ts';
import type { RankedDocument, SearchBackend, SearchDocument, SearchQuery } from './types.ts';

const FIELD_WEIGHT = { title: 3, keywords: 2, body: 1 } as const;

interface IndexedDocument {
  document: SearchDocument;
  terms: Map<string, number>;
  length: number;
  /** Lowercased identifier parts, used for exact-match boosts. */
  identifiers: Set<string>;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  titleBoost?: number;
  identifierBoost?: number;
}

export class Bm25Index implements SearchBackend {
  readonly name = 'bm25';
  private readonly documents: IndexedDocument[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly k1: number;
  private readonly b: number;
  private readonly titleBoost: number;
  private readonly identifierBoost: number;
  private averageLength = 0;

  constructor(documents: readonly SearchDocument[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.titleBoost = options.titleBoost ?? 1.35;
    this.identifierBoost = options.identifierBoost ?? 0.9;

    for (const document of documents) {
      const terms = new Map<string, number>();
      const add = (text: string, weight: number): void => {
        for (const term of analyze(text, { keepStopWords: true })) {
          terms.set(term, (terms.get(term) ?? 0) + weight);
        }
      };
      add(document.title, FIELD_WEIGHT.title);
      for (const keyword of document.keywords) add(keyword, FIELD_WEIGHT.keywords);
      add(document.body, FIELD_WEIGHT.body);

      let length = 0;
      for (const count of terms.values()) length += count;
      for (const term of terms.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.documents.push({
        document,
        terms,
        length,
        identifiers: new Set([...analyze(document.title, { keepStopWords: true }), ...pathSegments(document.title)]),
      });
    }
    const total = this.documents.reduce((sum, entry) => sum + entry.length, 0);
    this.averageLength = this.documents.length === 0 ? 1 : Math.max(1, total / this.documents.length);
  }

  get size(): number {
    return this.documents.length;
  }

  query(query: SearchQuery): RankedDocument[] {
    const limit = query.limit ?? 10;
    const terms = expandQueryTerms(analyze(query.text));
    if (terms.size === 0) return [];
    const allowedTypes = query.types === undefined ? null : new Set(query.types);
    const totalDocuments = Math.max(1, this.documents.length);
    const results: RankedDocument[] = [];

    for (const entry of this.documents) {
      if (allowedTypes !== null && !allowedTypes.has(entry.document.type)) continue;
      let score = 0;
      const matched: string[] = [];
      for (const [term, weight] of terms) {
        const frequency = entry.terms.get(term) ?? 0;
        let termScore = 0;
        if (frequency > 0) {
          const documentFrequency = this.documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
          const normalization = 1 - this.b + this.b * (entry.length / this.averageLength);
          const saturation = frequency * (this.k1 + 1);
          termScore = (idf * saturation) / (frequency + this.k1 * normalization);
          matched.push(term);
        } else if (entry.identifiers.has(term) || entry.identifiers.has(stem(term))) {
          // Identifier boost: the term appears verbatim in the node name/path.
          termScore = 0.6 * (this.documentFrequency.get(term) === undefined ? 1 : 0.5);
          matched.push(term);
        }
        score += termScore * weight;
      }
      if (score <= 0) continue;

      const titleTerms = new Set(analyze(entry.document.title, { keepStopWords: true }));
      for (const term of matched) {
        if (titleTerms.has(term)) score *= this.titleBoost;
      }
      const positional = matched.filter((term) => pathSegments(entry.document.title).includes(term)).length;
      score += positional * this.identifierBoost;

      const reasons: string[] = [];
      if (titleTerms.size > 0) reasons.push(`matched ${matched.length} of ${terms.size} query terms`);
      results.push({ document: entry.document, score, matched, reasons });
    }

    results.sort((a, b) =>
      a.score === b.score
        ? compareStrings(a.document.id, b.document.id)
        : b.score - a.score,
    );
    const minimum = query.minScore ?? 0;
    return results.filter((result) => result.score >= minimum).slice(0, limit);
  }
}