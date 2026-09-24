/** Version constant, kept in one place for both the CLI handshake and MCP info. */
export const MCP_VERSION = '0.3.0';


/** Re-exported for the MCP handshake (`serverInfo.version`). */
export { MCP_VERSION as CLI_VERSION };