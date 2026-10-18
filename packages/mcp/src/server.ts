/**
 * Minimal Model Context Protocol server over stdio.
 *
 * Implemented without runtime dependencies (the package keeps a zero-dependency
 * core): newline-delimited JSON-RPC 2.0 on stdin/stdout, covering the subset of
 * MCP that matters here — `initialize`, `tools/list`, `tools/call`, `resources/*`,
 * `prompts/*` and `ping` — plus `server/discover` for modern clients.
 *
 * The server is dual-era: it speaks the `initialize` handshake for legacy clients
 * and per-request `_meta` for modern ones, and selects between them from how the
 * client opens. See `./protocol.ts` for the versions and the negotiation rules.
 *
 * The transport is injectable, so the protocol can be tested without a process.
 */
import { MCP_VERSION } from './version.ts';
import { TOOL_DEFINITIONS, toolByName, validateToolArguments } from './tools/definitions.ts';
import { ContextPool, callTool } from './tools/handlers.ts';
import type { AgentContextOptions } from '@ai-agent-context/core';
import {
  ErrorCode,
  LATEST_LEGACY_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  RESULT_TYPE_COMPLETE,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedVersion,
  negotiateLegacyVersion,
  readMeta,
  unsupportedProtocolVersion,
} from './protocol.ts';
import type { JsonRpcErrorObject, ProtocolVersion } from './protocol.ts';

/**
 * Version reported to a legacy client that sends no usable `protocolVersion`.
 *
 * @deprecated This is only the *legacy* fallback. Use
 * {@link SUPPORTED_PROTOCOL_VERSIONS} to see every version the server
 * implements, or {@link LATEST_LEGACY_VERSION} for the handshake default.
 */
export const MCP_PROTOCOL_VERSION: ProtocolVersion = LATEST_LEGACY_VERSION;
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

/** Lifecycle of one in-flight request, shared by cancellation and the timeout. */
interface RequestState {
  cancelled: boolean;
  settled: boolean;
  /** Releases the waiter so a cancelled request stops being awaited. */
  release: () => void;
}

export interface McpServerOptions {
  root: string;
  transport: McpTransport;
  /** Injectable context factory (tests). */
  createContext?: (options: AgentContextOptions) => Promise<import('@ai-agent-context/core').AgentContext>;
  /** Protocol diagnostics go to stderr; stdout is the JSON-RPC channel. */
  log?: (line: string) => void;
  /**
   * Upper bound on a single request, in milliseconds. The specification requires
   * implementations to bound requests so a wedged client cannot pin the process
   * forever. Defaults to 120s, which no observed scan of a real repository
   * approaches; `0` disables the bound.
   */
  requestTimeoutMs?: number;
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

const SERVER_INSTRUCTIONS =
  'Repository context layer. Start with get_context_for_task or get_repository_context, then use explain_module, get_change_impact, get_dependencies, get_dependents, search_context, get_architecture, get_conventions and get_decisions. All data is generated locally from the repository; heuristic values carry a confidence and their evidence.';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function toMcpTools(): Array<{ name: string; title: string; description: string; inputSchema: unknown }> {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: `${tool.description}\n\nReturns: ${tool.outputDescription}`,
    inputSchema: tool.inputSchema,
  }));
}

/** Capabilities advertised by both `initialize` and `server/discover`. */
function serverCapabilities(): Record<string, unknown> {
  return { tools: { listChanged: false }, resources: {}, prompts: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class McpServer {
  private readonly options: McpServerOptions;
  private readonly pool: ContextPool;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, RequestState>();
  private initialized = false;
  /** Whether {@link start} has already wired the transport. */
  private started = false;
  /** Version agreed with a legacy client during `initialize`; null before that. */
  private negotiatedVersion: ProtocolVersion | null = null;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pool = new ContextPool({
      root: options.root,
      ...(options.createContext === undefined ? {} : { createContext: options.createContext }),
    });
  }

  /** Wires the transport and starts serving. Calling it twice is a no-op. */
  start(): void {
    // A transport's onMessage registers another reader on the channel, so a
    // second call would dispatch every request twice and answer each id twice —
    // which a JSON-RPC client rejects as a protocol violation.
    if (this.started) return;
    this.started = true;
    this.options.transport.onMessage((message) => {
      void this.handleMessage(message);
    });
  }

  /** Version in effect for a legacy session, once `initialize` has run. */
  get protocolVersion(): string {
    return this.negotiatedVersion ?? LATEST_LEGACY_VERSION;
  }

  /** Handles a single JSON-RPC message. */
  async handleMessage(message: unknown): Promise<void> {
    if (!isPlainObject(message)) return;
    const request = message as JsonRpcRequest;
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';
    const log = this.options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

    // JSON-RPC requires a Request to carry a method. Anything else is an
    // Invalid Request, which is a different failure from an unknown method.
    if (method.length === 0) {
      this.respondRaw(id, {
        error: { code: ErrorCode.InvalidRequest, message: 'request must carry a non-empty method' },
      });
      return;
    }

    if (id === null && method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') this.initialized = true;
      if (method === 'notifications/cancelled') this.cancel(request.params?.['requestId']);
      return;
    }

    // A request carrying modern `_meta` selects the modern era; everything else,
    // `initialize` included, is legacy.
    const meta = readMeta(request.params);
    const declaredVersion = meta[META_PROTOCOL_VERSION];
    const modern = declaredVersion !== undefined;

    if (modern) {
      // An unsupported revision is refused per request; there is no downgrade.
      if (!isSupportedVersion(declaredVersion)) {
        this.respondRaw(id, { error: unsupportedProtocolVersion(declaredVersion) });
        return;
      }
      // `clientCapabilities` is a required per-request field; without it the
      // request is malformed.
      if (meta[META_CLIENT_CAPABILITIES] === undefined) {
        this.respondRaw(id, {
          error: {
            code: ErrorCode.InvalidParams,
            message: `Missing required _meta field: ${META_CLIENT_CAPABILITIES}`,
            data: { field: META_CLIENT_CAPABILITIES },
          },
        });
        return;
      }
    }

    // Bound the request so a wedged client cannot pin the process forever.
    const state: RequestState = { cancelled: false, settled: false, release: () => {} };
    const key = id === null ? null : JSON.stringify(id);
    if (key !== null) this.inFlight.set(key, state);

    try {
      const run = this.dispatch(request, id, method, modern, log);
      if (this.timeoutMs <= 0 || key === null) {
        await run;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        // Deliberately NOT unref'd. The timer is the only thing holding the
        // event loop while a slow request is outstanding, and unref'ing it lets
        // Node exit with the request still pending, which silently disables the
        // timeout. It is cleared below as soon as the request settles, so a
        // completed request leaves nothing behind.
      });
      // Cancellation releases the waiter too: a cancelled request must stop
      // being awaited immediately, or the timeout would answer it later.
      const cancelled = new Promise<'cancelled'>((resolve) => {
        state.release = () => resolve('cancelled');
      });
      const outcome = await Promise.race([
        run.then(() => 'done' as const, () => 'done' as const),
        timedOut,
        cancelled,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === 'timeout') {
        // Suppress the late result: `dispatch` checks `settled` before responding.
        state.settled = true;
        log(`mcp: ${method} timed out after ${this.timeoutMs}ms`);
        this.respondRaw(id, {
          error: {
            code: ErrorCode.InternalError,
            message: `request timed out after ${this.timeoutMs}ms`,
            data: { method, timeoutMs: this.timeoutMs },
          },
        });
      }
      // A cancelled request is deliberately left unanswered.
    } finally {
      if (key !== null) this.inFlight.delete(key);
    }
  }

  /** Marks a request cancelled; a cancelled request is never answered. */
  private cancel(requestId: unknown): void {
    const state = this.inFlight.get(JSON.stringify(requestId));
    if (state === undefined) return;
    state.cancelled = true;
    state.settled = true;
    state.release();
  }

  /** Routes one request. Responses are suppressed once the request is cancelled. */
  private async dispatch(
    request: JsonRpcRequest,
    id: string | number | null,
    method: string,
    modern: boolean,
    log: (line: string) => void,
  ): Promise<void> {
    const live = (): boolean => {
      const state = this.stateFor(id);
      return state === null || (!state.cancelled && !state.settled);
    };
    const respond = (result: unknown): void => {
      if (!live()) return;
      this.respond(id, result, modern);
    };
    const respondError = (error: JsonRpcErrorObject): void => {
      if (!live()) return;
      this.respondRaw(id, { error });
    };

    try {
      switch (method) {
        case 'initialize': {
          const negotiated = negotiateLegacyVersion(request.params?.['protocolVersion']);
          this.negotiatedVersion = negotiated;
          // A new handshake re-opens the session; the client owes us `initialized`.
          this.initialized = false;
          respond({
            protocolVersion: negotiated,
            capabilities: serverCapabilities(),
            serverInfo: { name: SERVER_NAME, version: MCP_VERSION },
            instructions: SERVER_INSTRUCTIONS,
          });
          return;
        }
        case 'server/discover':
          respond({
            resultType: RESULT_TYPE_COMPLETE,
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: serverCapabilities(),
            _meta: { [META_SERVER_INFO]: { name: SERVER_NAME, version: MCP_VERSION } },
            instructions: SERVER_INSTRUCTIONS,
          });
          return;
        case 'ping':
          respond({});
          return;
        case 'tools/list':
          respond({ tools: toMcpTools() });
          return;
        case 'resources/list':
          respond({ resources: MCP_RESOURCES.map(({ read: _read, ...resource }) => resource) });
          return;
        case 'resources/read': {
          const uri = request.params?.['uri'];
          const resource = typeof uri === 'string' ? MCP_RESOURCES.find((entry) => entry.uri === uri) : undefined;
          // -32002 (resource not found) is reserved by the current specification;
          // an unknown resource reports Invalid params instead.
          if (resource === undefined) { respondError({ code: ErrorCode.InvalidParams, message: `unknown resource: ${String(uri)}` }); return; }
          respond({ contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(await resource.read(this.pool, this.options.root), null, 2) }] });
          return;
        }
        case 'prompts/list':
          respond({ prompts: MCP_PROMPTS });
          return;
        case 'prompts/get': {
          const name = request.params?.['name'];
          const prompt = typeof name === 'string' ? MCP_PROMPTS.find((entry) => entry.name === name) : undefined;
          if (prompt === undefined) { respondError({ code: ErrorCode.InvalidParams, message: `unknown prompt: ${String(name)}` }); return; }
          const argumentsValue = request.params?.['arguments'];
          const args = typeof argumentsValue === 'object' && argumentsValue !== null ? argumentsValue as Record<string, unknown> : {};
          const text = prompt.name === 'onboard_to_repository'
            ? 'Read agent://repository/context, then explain the architecture and conventions before editing code.'
            : `Call get_context_for_task or get_change_impact for ${String(args['target'] ?? 'the requested target')}.`;
          respond({ description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
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
            respondError({ code: ErrorCode.InvalidParams, message: 'tools/call requires a tool name' });
            return;
          }
          const definition = toolByName(name);
          if (definition === undefined) {
            respondError({ code: ErrorCode.InvalidParams, message: `unknown tool: ${name}` });
            return;
          }
          const validation = validateToolArguments(definition.inputSchema, args);
          if (!validation.valid) {
            respondError({ code: ErrorCode.InvalidParams, message: `invalid arguments for ${name}: ${validation.errors.join('; ')}` });
            return;
          }
          const result = await callTool(name, args, this.pool, this.options.root);
          respond({
            content: [{ type: 'text', text: JSON.stringify(result.payload, null, 2) }],
            isError: result.isError,
          });
          return;
        }
        default:
          respondError({ code: ErrorCode.MethodNotFound, message: `method not found: ${method}` });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`mcp: ${method} failed: ${reason}`);
      respondError({ code: ErrorCode.InternalError, message: reason, data: { method } });
    }
  }

  private stateFor(id: string | number | null): RequestState | null {
    if (id === null) return null;
    return this.inFlight.get(JSON.stringify(id)) ?? null;
  }

  /**
   * Sends a result. Modern-era results carry `resultType`, which the current
   * specification requires; clients of earlier revisions ignore unknown keys.
   */
  private respond(id: string | number | null, result: unknown, modern = false): void {
    const payload = modern && isPlainObject(result) && result['resultType'] === undefined
      ? { resultType: RESULT_TYPE_COMPLETE, ...result }
      : result;
    this.respondRaw(id, { result: payload });
  }

  private respondRaw(id: string | number | null, body: Record<string, unknown>): void {
    this.options.transport.send({ jsonrpc: '2.0', id, ...body });
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
              // stdout is the protocol channel: a parse failure is reported on
              // stderr and the connection survives.
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