/**
 * `agent-context search <query>` — deterministic lexical search.
 *
 * The default backend is BM25 over the knowledge graph; no embeddings, no LLM and
 * no network access are involved.
 */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagList, flagString } from '../cli.ts';
import { renderSearchResults } from '../ui/format.ts';
import type { SearchResult } from '@ai-agent-context/core';

export async function runSearchCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const query = parsed.positional.join(' ').trim();
  if (query.length === 0) {
    output.error('search requires a query, for example: agent-context search "payment idempotency"');
    return 2;
  }

  const limitValue = flagString(parsed, 'limit');
  const limit = limitValue === undefined ? 10 : Number.parseInt(limitValue, 10);
  if (Number.isNaN(limit) || limit <= 0) {
    output.error(`--limit must be a positive integer (received: ${limitValue ?? ''})`);
    return 2;
  }
  const types = flagList(parsed, 'types');
  const searchOptions: { limit: number; types?: SearchResult['type'][] } = { limit };
  if (types !== undefined) searchOptions.types = types as SearchResult['type'][];

  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const results = await agentContext.search(query, searchOptions);

  if (context.json) {
    output.print(JSON.stringify({ query, backend: 'bm25', results }, null, 2));
    return results.length === 0 ? 1 : 0;
  }

  output.heading(`Search: ${query}`);
  output.blank();
  for (const line of renderSearchResults(results)) output.print(line);
  output.blank();
  output.note(`backend: bm25 (deterministic lexical search, local only) · ${results.length} result(s)`);
  return results.length === 0 ? 1 : 0;
}