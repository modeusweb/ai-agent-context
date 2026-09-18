/**
 * Search document construction.
 *
 * Nodes of the knowledge graph are flattened into documents with a title (what the
 * node *is*), keywords (identity: paths, kinds, module ids) and a body (facts:
 * signals, exports, responsibilities, evidence). The same node kinds are exposed
 * by the CLI, the programmatic API and the MCP tools, so `search_context`
 * returns results an agent can act on.
 */
import type { SearchDocument } from './types.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { compareStrings } from '../../model/canonical.ts';

export interface SearchDocumentInput {
  graph: KnowledgeGraph;
  parsed: Map<string, ParsedFile>;
}

export function buildSearchDocuments(input: SearchDocumentInput): SearchDocument[] {
  const { graph, parsed } = input;
  const documents: SearchDocument[] = [];

  for (const file of graph.repository.files) {
    const facts = parsed.get(file.path);
    const exportedNames = (graph.symbolsByFile.get(file.path) ?? [])
      .filter((symbol) => symbol.exported)
      .map((symbol) => symbol.name)
      .slice(0, 25);
    const bodyParts = [
      `kind: ${file.kind}`,
      `language: ${file.language}`,
      file.moduleId !== null ? `module: ${file.moduleId}` : '',
      file.signals.length > 0 ? `signals: ${file.signals.join(', ')}` : '',
      exportedNames.length > 0 ? `exports: ${exportedNames.join(', ')}` : '',
      facts !== undefined && facts.routes.length > 0
        ? `routes: ${facts.routes.map((route) => `${route.method} ${route.path}`).join(', ')}`
        : '',
      facts !== undefined && facts.imports.length > 0
        ? `imports: ${[...new Set(facts.imports.map((record) => record.specifier))].slice(0, 20).join(', ')}`
        : '',
    ].filter((part) => part.length > 0);
    documents.push({
      id: `file:${file.path}`,
      type: 'file',
      title: file.path,
      body: bodyParts.join('\n'),
      keywords: [file.language, file.kind, file.moduleId ?? '', ...file.signals],
    });
  }

  for (const module of graph.repository.modules) {
    const bodyParts = [
      `path: ${module.path}`,
      `basis: ${module.basis}`,
      module.roles.length > 0 ? `roles: ${module.roles.map((role) => `${role.value} (${role.confidence})`).join(', ')}` : '',
      module.responsibilities.length > 0
        ? `responsibilities: ${module.responsibilities.map((entry) => entry.value).join('; ')}`
        : '',
      module.dependsOn.length > 0 ? `depends on: ${module.dependsOn.join(', ')}` : '',
      module.usedBy.length > 0 ? `used by: ${module.usedBy.join(', ')}` : '',
      module.publicExports.length > 0
        ? `public API: ${module.publicExports.map((entry) => entry.name).join(', ')}`
        : '',
      module.signals.length > 0 ? `signals: ${module.signals.join(', ')}` : '',
      `files: ${module.files.length}`,
    ].filter((part) => part.length > 0);
    documents.push({
      id: `module:${module.id}`,
      type: 'module',
      title: `${module.id} ${module.name}`,
      body: bodyParts.join('\n'),
      keywords: [module.path, module.packageName ?? '', module.basis, ...module.roles.map((role) => role.value)],
    });
  }

  for (const symbol of graph.repository.symbols) {
    const bodyParts = [
      `${symbol.kind} in ${symbol.file} (line ${symbol.line})`,
      symbol.exported ? 'exported' : 'internal',
      symbol.extends.length > 0 ? `extends ${symbol.extends.join(', ')}` : '',
      symbol.implements.length > 0 ? `implements ${symbol.implements.join(', ')}` : '',
      symbol.moduleId !== null ? `module ${symbol.moduleId}` : '',
    ].filter((part) => part.length > 0);
    documents.push({
      id: `symbol:${symbol.id}`,
      type: 'symbol',
      title: symbol.name,
      body: bodyParts.join('\n'),
      keywords: [symbol.file, symbol.kind, symbol.moduleId ?? ''],
    });
  }

  for (const decision of graph.repository.decisions) {
    documents.push({
      id: `decision:${decision.id}`,
      type: 'decision',
      title: decision.title,
      body: [decision.excerpt ?? '', `status: ${decision.status}`, `origin: ${decision.origin}`, decision.source].join('\n'),
      keywords: [decision.id, decision.status, decision.kind],
    });
  }

  for (const convention of graph.repository.conventions) {
    documents.push({
      id: `convention:${convention.id}`,
      type: 'convention',
      title: convention.statement,
      body: [convention.category, ...convention.evidence.map((entry) => `${entry.source}: ${entry.detail}`)].join('\n'),
      keywords: [convention.category, convention.origin],
    });
  }

  for (const entry of graph.repository.entryPoints) {
    documents.push({
      id: `entry-point:${entry.path}:${entry.type}`,
      type: 'entry-point',
      title: `${entry.path} (${entry.type})`,
      body: [entry.details ?? '', ...entry.evidence.map((item) => `${item.source}: ${item.detail}`)].join('\n'),
      keywords: [entry.type, entry.moduleId ?? ''],
    });
  }

  return documents.sort((a, b) => compareStrings(a.id, b.id));
}

/** Compact snippet shown next to a search hit. */
export function snippetFor(document: SearchDocument, limit = 160): string {
  const text = document.body.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}\u2026`;
}
