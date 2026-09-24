/**
 * Tool definitions of the MCP adapter.
 *
 * The adapter contains no analysis logic: every tool delegates to the core API
 * (`AgentContext`) and returns a JSON payload an LLM can consume directly. Each
 * schema declares exactly what the tool needs, so an agent cannot accidentally
 * trigger a full repository dump.
 */

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Documented shape of the returned payload. */
  outputDescription: string;
}

const ROOT_PROPERTY: JsonSchema = {
  type: 'string',
  description: 'Repository root. Omit to use the root configured when the server started.',
};

const MODULE_PROPERTY: JsonSchema = {
  type: 'string',
  description: 'Module id, module directory, file path or workspace package name (for example "src/payments").',
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_context_for_task',
    title: 'Get context for task',
    description:
      'Bounded, task-oriented repository context. Searches relevant modules, then returns their summary, dependencies, dependents, public API, tests, conventions, decisions and evidence. Use this before proposing or implementing a change.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description, for example "add idempotent payment retries".' },
        target: MODULE_PROPERTY,
        maxModules: { type: 'number', description: 'Maximum number of modules (1-12, default 5).' },
        root: ROOT_PROPERTY,
      },
      required: ['task'],
      additionalProperties: false,
    },
    outputDescription: 'Task context (schema v1) with bounded modules, evidence and truncation flag.',
  },
  {
    name: 'get_change_impact',
    title: 'Get change impact',
    description:
      'Bounded impact set for a proposed change: transitive dependent modules, affected files, tests, relevant conventions, decisions and evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        target: MODULE_PROPERTY,
        maxFiles: { type: 'number', description: 'Maximum number of files (1-500, default 100).' },
        root: ROOT_PROPERTY,
      },
      required: ['target'],
      additionalProperties: false,
    },
    outputDescription: 'Change impact (schema v1) with affected modules/files and evidence.',
  },
  {
    name: 'get_repository_context',
    title: 'Get repository context',
    description:
      'Compact, structured overview of the repository: languages, file counts, workspace layout, runnable commands, ranked modules with heuristic roles, entry points, external dependencies and documented decisions. Call this first to orient yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROPERTY,
        maxModules: { type: 'number', description: 'Maximum modules (1-100).' },
        maxEntryPoints: { type: 'number', description: 'Maximum entry points (1-200).' },
        maxExternalDependencies: { type: 'number', description: 'Maximum external dependencies (1-200).' },
        maxConventions: { type: 'number', description: 'Maximum conventions (1-200).' },
        maxDecisions: { type: 'number', description: 'Maximum decisions (1-200).' },
        maxCycles: { type: 'number', description: 'Maximum dependency cycles (0-200).' },
      },
      additionalProperties: false,
    },
    outputDescription: 'Repository context payload (schema v1) with optional bounded projections.',
  },
  {
    name: 'explain_module',
    title: 'Explain module',
    description:
      'Structured explanation of one module (or of the module owning a file path): entry points, internal dependencies, dependents, external packages, public API, relevant conventions and decisions, tests, neutral git activity and the transitive change impact set.',
    inputSchema: {
      type: 'object',
      properties: { path: MODULE_PROPERTY, root: ROOT_PROPERTY },
      required: ['path'],
      additionalProperties: false,
    },
    outputDescription: 'Module explanation with confidence-carrying heuristics and their evidence.',
  },
  {
    name: 'get_dependencies',
    title: 'Get dependencies',
    description:
      'Dependencies of a module or of the whole repository: internal module edges with evidence, external packages grouped by scope and heuristic importance, and imports that could not be resolved to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Optional module id or path. Omit for the whole repository.' },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    outputDescription: 'Dependency edges and external packages.',
  },
  {
    name: 'get_dependents',
    title: 'Get dependents',
    description:
      'Modules that depend on a given module: direct dependents plus the transitive set, so you can reason about the impact of a change.',
    inputSchema: {
      type: 'object',
      properties: { module: MODULE_PROPERTY, root: ROOT_PROPERTY },
      required: ['module'],
      additionalProperties: false,
    },
    outputDescription: 'Direct and transitive dependents.',
  },
  {
    name: 'search_context',
    title: 'Search context',
    description:
      'Deterministic lexical (BM25) search across files, modules, symbols, conventions, decisions and entry points; returns ranked nodes and the reason each matched. Example queries: "payment idempotency", "where are routes registered".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or identifier query.' },
        limit: { type: 'number', description: 'Maximum number of results (default 10).' },
        types: {
          type: 'array',
          description: 'Restrict to node types.',
          items: { type: 'string', enum: ['file', 'module', 'symbol', 'decision', 'convention', 'entry-point'] },
        },
        root: ROOT_PROPERTY,
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputDescription: 'Ranked search results with deterministic match reasons.',
  },
  {
    name: 'get_module_history',
    title: 'Get module history',
    description: 'Bounded local Git history for a module: commits, authors, dates, touched files and architecture-change signals.',
    inputSchema: {
      type: 'object',
      properties: { target: MODULE_PROPERTY, limit: { type: 'number', description: 'Maximum history entries (1-200).' }, root: ROOT_PROPERTY },
      required: ['target'],
      additionalProperties: false,
    },
    outputDescription: 'Deterministic module history entries.',
  },
  {
    name: 'get_revision_diff',
    title: 'Get revision diff',
    description: 'Changed paths and statuses between two local Git revisions, including additions, deletions, modifications and renames.',
    inputSchema: {
      type: 'object',
      properties: { revision: { type: 'string' }, base: { type: 'string' }, root: ROOT_PROPERTY },
      required: ['revision'],
      additionalProperties: false,
    },
    outputDescription: 'Revision diff with deterministic ordering.',
  },
  {
    name: 'get_architecture',
    title: 'Get architecture',
    description:
      'Architecture projection: workspace model, entry points and every detected module with heuristic roles (confidence + evidence), responsibilities, dependency edges and neutral git activity.',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: 'Optional module id filter.' }, root: ROOT_PROPERTY },
      additionalProperties: false,
    },
    outputDescription: 'Architecture document (schema v1).',
  },
  {
    name: 'get_conventions',
    title: 'Get conventions',
    description:
      'Observable repository conventions (naming, imports, tests, error handling, exports, structure, toolchain). Every statement is a counted observation with confidence and evidence — never an invented rule.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter, for example "Tests".' },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    outputDescription: 'Conventions with confidence and evidence.',
  },
  {
    name: 'get_decisions',
    title: 'Get decisions',
    description:
      'Architecture decisions: documents found in docs/, adr/ and README sections (origin "explicit") plus heuristically derived signals (origin "inferred", with evidence and source).',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', enum: ['explicit', 'inferred'], description: 'Optional origin filter.' },
        root: ROOT_PROPERTY,
      },
      additionalProperties: false,
    },
    outputDescription: 'Decisions with origin, status and evidence.',
  },
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}