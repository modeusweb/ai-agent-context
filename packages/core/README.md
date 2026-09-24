# @ai-agent-context/core

Core analysis engine for `ai-agent-context`.

This package provides the repository analysis capabilities without any CLI or MCP dependencies. It's designed to be:

- **Local-first**: 100% local execution, no external API calls
- **Deterministic**: Same repository state → identical context
- **Extensible**: Pluggable language adapters, detectors, and analyzers
- **Zero runtime dependencies**: Works with only Node.js built-ins

## Installation

```bash
npm install @ai-agent-context/core
```

## Usage

```typescript
import { AgentContext } from '@ai-agent-context/core';

const context = await AgentContext.load({ root: process.cwd() });

// Scan repository
await context.scan();

// Explain a module
const module = await context.explain('src/payments');

// Get architecture
const architecture = await context.getArchitecture();

// Get dependencies
const dependencies = await context.getDependencies();

// Search context
const results = await context.search('payment idempotency');
```

## API

### AgentContext

Main entry point for repository analysis.

```typescript
class AgentContext {
  static async load(options?: AgentContextOptions): Promise<AgentContext>
  async scan(options?: ScanOptions): Promise<ScanReport>
  async getRepositoryContext(options?: RepositoryContextOptions): Promise<RepositoryContext>
  async getTaskContext(task: string, options?: { target?: string; maxModules?: number }): Promise<TaskContext>
  async getChangeImpact(target: string, options?: { maxFiles?: number }): Promise<ChangeImpact>
  async getModuleHistory(target: string, options?: { limit?: number }): Promise<ModuleHistoryEntry[]>
  async getRevisionDiff(revision: string, base?: string): Promise<RevisionDiff>
  async getRevisionSnapshot(revision: string): Promise<RevisionSnapshot>
  async explain(target: string): Promise<ModuleExplanation | null>
  async diff(): Promise<ContextDiff>
  async status(): Promise<StatusReport>
  async getRepository(): Promise<Repository>
  async getArchitecture(): Promise<ArchitectureDocument>
  async getDependencies(): Promise<DependenciesDocument>
  async getConventions(): Promise<Convention[]>
  async getDecisions(): Promise<Decision[]>
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  async init(options?: { force?: boolean }): Promise<InitResult>
}
```

### Scanner

Repository scanner and file classification.

```typescript
import { scanRepository, classifyFile } from '@ai-agent-context/core';

const output = await scanRepository(root, options);
const classification = classifyFile(filePath, language);
```

### Knowledge Graph

Builds a repository knowledge graph from parsed files.

```typescript
import { buildKnowledgeGraph, buildModules } from '@ai-agent-context/core';

const graph = buildKnowledgeGraph(input);
const modules = buildModules(files, basePath);
```

### Architecture Detection

Detects module roles, entry points, and responsibilities.

```typescript
import {
  detectEntryPoints,
  detectModuleRoles,
  detectResponsibilities,
  applyArchitectureDetection
} from '@ai-agent-context/core';

const entryPoints = detectEntryPoints(input);
const roles = detectModuleRoles(module);
const responsibilities = detectResponsibilities(module);
const enhanced = applyArchitectureDetection(graph);
```

### Convention Detection

Detects observable coding conventions.

```typescript
import { detectConventions, renderConventionsMarkdown } from '@ai-agent-context/core';

const conventions = detectConventions(input);
const markdown = renderConventionsMarkdown(conventions, repositoryName);
```

### Decision Detection

Extracts architectural decisions from ADRs and configuration.

```typescript
import { detectDecisions, parseAdrDocument } from '@ai-agent-context/core';

const decisions = detectDecisions(input);
const adr = parseAdrDocument(content, path);
```

### Architecture Analysis

`getArchitecture()` includes `summary.layeringViolations` and `layeringViolations` with `from`, `to`, `kind`, `confidence` and evidence.


`getModuleHistory(target, { limit })` returns bounded Git history for a module.
`getRevisionDiff(revision, base)` returns changed paths and statuses, including renames.


```typescript
import { GitAdapter, computeGitActivity } from '@ai-agent-context/core';

const adapter = new GitAdapter(root);
const availability = await adapter.checkAvailability();
const commits = await adapter.getRecentCommits(limit);
const activity = computeGitActivity(input);
```

### Search

Deterministic lexical search over repository context.

```typescript
import { SearchService, Bm25Index } from '@ai-agent-context/core';

const service = SearchService.fromGraph({ graph, parsed });
const results = service.search(query, options);
```

### Serialization

Reads and writes `.agent/` context files.

```typescript
import {
  readPersistedContext,
  writeContext,
  serializeContextDocuments
} from '@ai-agent-context/core';

const persisted = await readPersistedContext(root);
await writeContext(root, documents, options);
```

## Language Adapters

### TypeScript/JavaScript

```typescript
import { TsJsAdapter } from '@ai-agent-context/core';

const adapter = new TsJsAdapter();
const parsed = await adapter.parse(filePath, content, language);
```

### JSON

```typescript
import { JsonAdapter } from '@ai-agent-context/core';

const adapter = new JsonAdapter();
const parsed = await adapter.parse(filePath, content, language);
```

### Markdown

```typescript
import { MarkdownAdapter } from '@ai-agent-context/core';

const adapter = new MarkdownAdapter();
const parsed = await adapter.parse(filePath, content, language);
```

### Package.json

```typescript
import { PackageJsonAdapter } from '@ai-agent-context/core';

const adapter = new PackageJsonAdapter();
const parsed = await adapter.parse(filePath, content, language);
```

### tsconfig.json

```typescript
import { TsConfigAdapter } from '@ai-agent-context/core';

const adapter = new TsConfigAdapter();
const parsed = await adapter.parse(filePath, content, language);
```

## Utilities

### Path Utilities

```typescript
import {
  toPosix,
  normalizeRelative,
  dirname,
  basename,
  extname,
  join,
  isInside,
  ancestors,
  relativeTo
} from '@ai-agent-context/core';
```

### Text Utilities

```typescript
import {
  classifyIdentifierCase,
  splitIdentifier,
  truncate,
  formatDate,
  ratio,
  pluralize
} from '@ai-agent-context/core';
```

### Pattern Matching

```typescript
import { PatternSet, compileGlob, compileRule } from '@ai-agent-context/core';
```

## Configuration

```typescript
import {
  loadConfig,
  DEFAULT_CONFIG,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE
} from '@ai-agent-context/core';

const config = await loadConfig({ root: process.cwd() });
```

## Error Handling

```typescript
import {
  AgentContextError,
  ConfigError,
  AnalysisError,
  ContextStateError,
  isAgentContextError
} from '@ai-agent-context/core';

try {
  await context.scan();
} catch (error) {
  if (isAgentContextError(error)) {
    console.error(error.message);
    console.error(error.suggestions);
  }
}
```

## Security

See the repository `SECURITY.md`. The core performs no network calls, excludes sensitive files by default, redacts secret-like excerpts, and does not follow symlinks unless explicitly configured.

## License

MIT
