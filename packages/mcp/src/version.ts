/** Version constant, kept in one place for both the CLI handshake and MCP info. */
import { TOOL_VERSION } from '@ai-agent-context/core';

export const MCP_VERSION = TOOL_VERSION;

/** Re-exported for the MCP handshake (`serverInfo.version`). */
export { MCP_VERSION as CLI_VERSION };
