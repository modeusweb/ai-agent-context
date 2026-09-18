/**
 * Deterministic lexical search.
 *
 * No embeddings, no LLM, no network: tokens are extracted with a small
 * language-aware analyzer, expanded with a synonym map and scored with BM25 over
 * per-node documents. An optional {@link Reranker} hook (LLM, embeddings, vector
 * database) can be plugged in later without touching the index or the callers.
 */
import type { SearchResult } from '../../model/types.ts';

export type SearchNodeType = SearchResult['type'];

export interface SearchDocument {
  id: string;
  type: SearchNodeType;
  /** Primary text (path, symbol name, statement, ...). */
  title: string;
  /** Secondary text used for matching but not for identifier boosting. */
  body: string;
  /** Extra keywords: module ids, paths, kinds. */
  keywords: string[];
}

export interface SearchQuery {
  text: string;
  limit?: number;
  /** Restrict results to specific node types. */
  types?: SearchNodeType[];
  /** Minimum score below which results are dropped. */
  minScore?: number;
}

export interface RankedDocument {
  document: SearchDocument;
  score: number;
  /** Matched terms, sorted by weight contribution. */
  matched: string[];
  /** Reasons the ranking backend wants to surface. */
  reasons: string[];
}

/** Pluggable ranking backend. `Bm25Index` is the deterministic default. */
export interface SearchBackend {
  readonly name: string;
  query(query: SearchQuery): RankedDocument[];
}

/** Optional post-processing hook (LLM reranking, vector search, ...). */
export type Reranker = (query: SearchQuery, results: RankedDocument[]) => Promise<RankedDocument[]>;