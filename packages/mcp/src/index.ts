/**
 * Programmatic entry point of the MCP adapter.
 *
 * The adapter is intentionally thin: it exposes the core API as MCP tools and
 * contains no analysis logic, so an embedder can reuse the server with a custom
 * transport (HTTP, WebSocket, in-process) without touching the core.
 */
export { McpServer, createStdioTransport, createMemoryTransport, MCP_PROTOCOL_VERSION, SERVER_NAME } from './server.ts';
export type { McpServerOptions, McpTransport, JsonRpcRequest, MemoryTransport } from './server.ts';
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  LATEST_LEGACY_VERSION,
  FIRST_MODERN_VERSION,
  ErrorCode,
  isSupportedVersion,
  isModernVersion,
  negotiateLegacyVersion,
  unsupportedProtocolVersion,
  missingRequiredClientCapability,
  readMeta,
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  META_SERVER_INFO,
  RESULT_TYPE_COMPLETE,
} from './protocol.ts';
export type { ProtocolVersion, JsonRpcErrorObject, ProtocolEra } from './protocol.ts';
export { CLIENT_PRESETS, presetById, renderPreset, renderAllPresets, serverArgv } from './presets.ts';
export type { ClientPreset, ClientPresetId, RenderOptions } from './presets.ts';
export { TOOL_DEFINITIONS, toolByName, validateToolArguments } from './tools/definitions.ts';
export type { ToolDefinition, JsonSchema, ValidationResult } from './tools/definitions.ts';
export { callTool, ContextPool } from './tools/handlers.ts';
export type { ToolCallResult, ToolHandlerDependencies } from './tools/handlers.ts';
export { MCP_VERSION } from './version.ts';