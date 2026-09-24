/**
 * Programmatic entry point of the MCP adapter.
 *
 * The adapter is intentionally thin: it exposes the core API as MCP tools and
 * contains no analysis logic, so an embedder can reuse the server with a custom
 * transport (HTTP, WebSocket, in-process) without touching the core.
 */
export { McpServer, createStdioTransport, createMemoryTransport, MCP_PROTOCOL_VERSION, SERVER_NAME } from './server.ts';
export type { McpServerOptions, McpTransport, JsonRpcRequest, MemoryTransport } from './server.ts';
export { TOOL_DEFINITIONS, toolByName, validateToolArguments } from './tools/definitions.ts';
export type { ToolDefinition, JsonSchema, ValidationResult } from './tools/definitions.ts';
export { callTool, ContextPool } from './tools/handlers.ts';
export type { ToolCallResult, ToolHandlerDependencies } from './tools/handlers.ts';
export { MCP_VERSION } from './version.ts';