/**
 * Single source of truth for the released tool version.
 *
 * The CLI and the MCP adapter re-export this constant instead of hard-coding
 * their own copy, and it is written into the local state so that upgrading the
 * tool invalidates the incremental parse cache. A test keeps it in sync with
 * `packages/core/package.json`.
 */
export const TOOL_VERSION = '0.6.0';
