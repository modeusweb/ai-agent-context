#!/usr/bin/env node
/**
 * Executable entry point of the MCP adapter (`agent-context-mcp`).
 *
 * Usage:
 *   agent-context-mcp [--root <path>]
 *
 * The repository root defaults to `AGENT_CONTEXT_ROOT` and then to the current
 * working directory. The server speaks JSON-RPC over stdin/stdout, which is what
 * MCP clients (Claude Desktop, IDEs, custom agents) expect.
 */
import path from 'node:path';
import { McpServer, createStdioTransport } from './server.ts';
import { MCP_VERSION } from './version.ts';

function parseRoot(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--root') {
      const value = argv[index + 1];
      if (value !== undefined) return path.resolve(value);
      continue;
    }
    if (argument.startsWith('--root=')) return path.resolve(argument.slice('--root='.length));
  }
  const fromEnv = process.env['AGENT_CONTEXT_ROOT'];
  return path.resolve(fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : process.cwd());
}

if (process.argv.includes('--version')) {
  process.stdout.write(`${MCP_VERSION}\n`);
} else {
  const root = parseRoot(process.argv.slice(2));
  const server = new McpServer({
    root,
    transport: createStdioTransport(),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  server.start();
  process.stderr.write(`ai-agent-context MCP server ready (root: ${root})\n`);
}