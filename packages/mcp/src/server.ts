/**
 * Minimal Model Context Protocol server over stdio.
 *
 * Implemented without runtime dependencies (the package keeps a zero-dependency
 * core): newline-delimited JSON-RPC 2.0 on stdin/stdout, covering the subset of
 * MCP that matters for tools — `initialize`, `tools/list`, `tools/call`, `ping`.
 * `resources` and `prompts` are advertised as empty capabilities: the documented
 * extension point for later versions.
 *
 * The transport is injectable, so the protocol can be tested without a process.
 */
import { MCP_VERSION } from './version.ts';
import { TOOL_DEFINITIONS } from './tools/definitions.ts';
import { ContextPool, callTool } from './tools/handlers.ts';
import type { AgentContextOptions } from '@ai-agent-context/core';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'ai-agent-context';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpTransport {
  /** Registers the message handler (called for every parsed JSON message). */
  onMessage(handler: (message: unknown) => void): void;
  /** Sends a JSON-RPC response/notification. */
  send(message: unknown): void;
  close(): void;
}

export interface McpServerOptions {
  root: string;
  transport: McpTransport;
  /** Injectable context factory (tests). */
  createContext?: (options: AgentContextOptions) => Promise<import('@ai-agent-context/core').AgentContext>;
  /** Protocol diagnostics go to stderr; stdout is the JSON-RPC channel. */
  log?: (line: string) => void;
}

interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (pool: ContextPool, root: string) => Promise<unknown>;
}

const MCP_RESOURCES: McpResourceDefinition[] = [
  { uri: 'agent://repository/context', name: 'Repository context', description: 'Compact repository overview.', mimeType: 'application/json', read: (pool, root) => pool.get(root).then((context) => context.getRepositoryContext()) },
  { uri: 'agent://repository/architecture', name: 'Repository architecture', description: 'Modules, entry points, roles and dependencies.', mimeType: 'application/json', read: (pool, root) => pool.get(root).then((context) => context.getArchitecture()) },
  { uri: 'agent://repository/dependencies', name: 'Repository dependencies', description: 'Dependency graph and cycles.', mimeType: 'application/json', read: (pool, root) => pool.get(root).then((context) => context.getDependencies()) },
  { uri: 'agent://repository/conventions', name: 'Repository conventions', description: 'Observed conventions with evidence.', mimeType: 'application/json', read: (pool, root) => pool.get(root).then((context) => context.getConventions()) },
  { uri: 'agent://repository/decisions', name: 'Repository decisions', description: 'Architectural decisions and evidence.', mimeType: 'application/json', read: (pool, root) => pool.get(root).then((context) => context.getDecisions()) },
];

const MCP_PROMPTS = [
  { name: 'onboard_to_repository', description: 'Prepare a compact repository orientation for a coding agent.', arguments: [] },
  { name: 'review_change_impact', description: 'Review a proposed change and its affected modules.', arguments: [{ name: 'target', description: 'Module or path under review', required: true }] },
  { name: 'explain_architecture', description: 'Explain module architecture and conventions.', arguments: [{ name: 'target', description: 'Module or path to explain', required: true }] },
] as const;

function toMcpTools(): Array<{ name: string; title: string; description: string; inputSchema: unknown }> {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: `${tool.description}\n\nReturns: ${tool.outputDescription}`,
    inputSchema: tool.inputSchema,
  }));
}

export class McpServer {
  private readonly options: McpServerOptions;
  private readonly pool: ContextPool;
  private initialized = false;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.pool = new ContextPool({
      root: options.root,
      ...(options.createContext === undefined ? {} : { createContext: options.createContext }),
    });
  }

  /** Wires the transport and starts serving. */
  start(): void {
    this.options.transport.onMessage((message) => {
      void this.handleMessage(message);
    });
  }

  /** Handles a single JSON-RPC message. */
  async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return;
    const request = message as JsonRpcRequest;
    const id = request.id ?? null;
    const method = request.method ?? '';
    const log = this.options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

    if (id === null && method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') this.initialized = true;
      return;
    }

    try {
      switch (method) {
        case 'initialize':
          this.respond(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
            serverInfo: { name: SERVER_NAME, version: MCP_VERSION },
            instructions:
              'Repository context layer. Start with get_context_for_task or get_repository_context, then use explain_module, get_change_impact, get_dependencies, get_dependents, search_context, get_architecture, get_conventions and get_decisions. All data is generated locally from the repository; heuristic values carry a confidence and their evidence.',
          });
          return;
        case 'ping':
          this.respond(id, {});
          return;
        case 'tools/list':
          this.respond(id, { tools: toMcpTools() });
          return;
        case 'resources/list':
          this.respond(id, { resources: MCP_RESOURCES.map(({ read: _read, ...resource }) => resource) });
          return;
        case 'resources/read': {
          const uri = request.params?.['uri'];
          const resource = typeof uri === 'string' ? MCP_RESOURCES.find((entry) => entry.uri === uri) : undefined;
          if (resource === undefined) { this.respondError(id, -32602, `unknown resource: ${String(uri)}`); return; }
          this.respond(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(await resource.read(this.pool, this.options.root), null, 2) }] });
          return;
        }
        case 'prompts/list':
          this.respond(id, { prompts: MCP_PROMPTS });
          return;
        case 'prompts/get': {
          const name = request.params?.['name'];
          const prompt = typeof name === 'string' ? MCP_PROMPTS.find((entry) => entry.name === name) : undefined;
          if (prompt === undefined) { this.respondError(id, -32602, `unknown prompt: ${String(name)}`); return; }
          const argumentsValue = request.params?.['arguments'];
          const args = typeof argumentsValue === 'object' && argumentsValue !== null ? argumentsValue as Record<string, unknown> : {};
          const text = prompt.name === 'onboard_to_repository'
            ? 'Read agent://repository/context, then explain the architecture and conventions before editing code.'
            : `Call get_context_for_task or get_change_impact for ${String(args['target'] ?? 'the requested target')}.`;
          this.respond(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
          return;
        }
        case 'tools/call': {
          const params = request.params ?? {};
          const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
          const rawArguments = params['arguments'];
          const args =
            typeof rawArguments === 'object' && rawArguments !== null
              ? (rawArguments as Record<string, unknown>)
              : {};
          if (name.length === 0) {
            this.respondError(id, -32602, 'tools/call requires a tool name');
            return;
          }
          const result = await callTool(name, args, this.pool, this.options.root);
          this.respond(id, {
            content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
            isError: result.isError,
          });
          return;
        }
        default:
          this.respondError(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`mcp: ${method} failed: ${reason}`);
      this.respondError(id, -32603, reason);
    }
  }

  private respond(id: string | number | null, result: unknown): void {
    this.options.transport.send({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: string | number | null, code: number, message: string): void {
    this.options.transport.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

/** stdio transport: newline delimited JSON-RPC on stdin/stdout. */
export function createStdioTransport(): McpTransport {
  return {
    onMessage(handler) {
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            try {
              handler(JSON.parse(line) as unknown);
            } catch {
              process.stderr.write('mcp: ignoring unparsable message\n');
            }
          }
          newline = buffer.indexOf('\n');
        }
      });
    },
    send(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    close() {
      process.stdin.pause();
    },
  };
}

export interface MemoryTransport extends McpTransport {
  sent: unknown[];
  /** Pushes a message into the server, as stdin would. */
  push(message: unknown): void;
}

/** In-memory transport, used by tests and by embedders. */
export function createMemoryTransport(): MemoryTransport {
  const sent: unknown[] = [];
  let handler: ((message: unknown) => void) | null = null;
  return {
    sent,
    push(message) {
      handler?.(message);
    },
    onMessage(next) {
      handler = next;
    },
    send(message) {
      sent.push(message);
    },
    close() {
      handler = null;
    },
  };
}