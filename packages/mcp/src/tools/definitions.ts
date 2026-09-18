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
    name: 'get_repository_context',
    title: 'Get repository context',
    description:
      'Compact, structured overview of the repository: languages, file counts, workspace layout, runnable commands, ranked modules with heuristic roles, entry points, external dependencies and documented decisions. Call this first to orient yourself.',
    inputSchema: { type: 'object', properties: { root: ROOT_PROPERTY }, additionalProperties: false },
    outputDescription: 'Repository context payload (schema v1).',
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