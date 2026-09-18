/**
 * Search service.
 *
 * Orchestrates the backend (BM25 by default) and the optional reranker, then
 * projects the hits into `SearchResult` objects with a deterministic `reason`
 * string — an agent must be able to see *why* a node was returned.
 */
import type { SearchResult } from '../../model/types.ts';
import { compareStrings } from '../../model/canonical.ts';
import { Bm25Index } from './bm25.ts';
import { buildSearchDocuments, snippetFor, type SearchDocumentInput } from './documents.ts';
import type { RankedDocument, Reranker, SearchBackend, SearchNodeType, SearchQuery } from './types.ts';

export interface SearchOptions {
  limit?: number;
  types?: SearchNodeType[];
  minScore?: number;
  /** Optional semantic/LLM reranking hook; unused by default (local-first). */
  reranker?: Reranker;
}

export class SearchService {
  private readonly backend: SearchBackend;

  constructor(backend: SearchBackend) {
    this.backend = backend;
  }

  get backendName(): string {
    return this.backend.name;
  }

  /** Builds a service over the knowledge graph with the default BM25 backend. */
  static fromGraph(input: SearchDocumentInput): SearchService {
    return new SearchService(new Bm25Index(buildSearchDocuments(input)));
  }

  /** Builds a service over an explicit backend (embeddings, vector DB, ...). */
  static withBackend(backend: SearchBackend): SearchService {
    return new SearchService(backend);
  }

  async search(text: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const query: SearchQuery = { text, limit: options.limit ?? 10 };
    if (options.types !== undefined) query.types = options.types;
    if (options.minScore !== undefined) query.minScore = options.minScore;

    let ranked = this.backend.query(query);
    if (options.reranker !== undefined && ranked.length > 0) {
      ranked = await options.reranker(query, ranked);
    }
    return ranked.map((entry) => toSearchResult(entry, this.backend.name));
  }
}

const STOP_WORD_FILTER = new Set(['and', 'the', 'of', 'in', 'is', 'to', 'for', 'with']);

/** Maps a ranked document onto the public, agent-facing result shape. */
export function toSearchResult(ranked: RankedDocument, backendName: string): SearchResult {
  const matched = ranked.matched.filter((term) => !STOP_WORD_FILTER.has(term)).sort(compareStrings);
  const reasonParts = [
    matched.length > 0 ? `matched terms: ${matched.join(', ')}` : 'matched by identifier',
    ...ranked.reasons,
    `ranked by ${backendName}`,
  ];
  const [type, ...idParts] = ranked.document.id.split(':');
  const result: SearchResult = {
    type: (type ?? 'file') as SearchResult['type'],
    id: idParts.join(':'),
    score: Math.round(ranked.score * 10_000) / 10_000,
    reason: reasonParts.filter((part) => part.length > 0).join('; '),
  };
  const snippet = snippetFor(ranked.document);
  if (snippet.length > 0) result.snippet = snippet;
  return result;
}