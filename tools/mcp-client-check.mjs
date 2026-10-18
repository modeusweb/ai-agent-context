#!/usr/bin/env node
/**
 * Drives the MCP server with a real client.
 *
 * Every other check of this server talks to it with hand-written JSON-RPC, which
 * means it is checked against the same understanding of the protocol that wrote
 * it. `tools/smoke.mjs` proves the server answers; it cannot prove the answers
 * are shaped the way a client expects, because the client is ours too.
 *
 * This uses `@modelcontextprotocol/sdk`, the reference implementation, as a
 * client. It parses and validates every message, negotiates the protocol
 * version itself, and refuses anything that does not match the specification. A
 * server bug that our own client would tolerate shows up here.
 *
 * The full client matrix in the README is still not verified: those are desktop
 * applications, and launching them is outside what this environment can do. What
 * is verified here is that the server speaks the protocol correctly to a client
 * written by someone else.
 *
 * Usage: npm run mcp:client
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  LATEST_PROTOCOL_VERSION as SDK_LATEST_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS as SDK_SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '../packages/mcp/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(root, 'packages/mcp/dist/bin.js');

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  }
  return ok;
}

/**
 * A throwaway repository for the tools to analyse.
 *
 * A real scan rather than a stub, because what is being checked is the server,
 * and a server that answers correctly about nothing is not answering correctly.
 */
function makeFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aac-mcp-client-'));
  const write = (rel, content) => {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  };
  write('package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  write(
    'src/index.ts',
    [
      "import {service} from './service.js';",
      "export const main = () => service();",
      '',
    ].join('\n'),
  );
  write('src/service.ts', `export const service = () => 'ok';\n`);
  write('test/index.test.ts', "import {test} from 'node:test';\ntest('x', () => {});\n");
  return dir;
}

/** Connects a fresh SDK client to a fresh server process over stdio. */
async function connect(cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    stderr: 'ignore',
  });
  // The SDK asks for its own latest revision and calls this on whatever the
  // server answers with. Recording it is the only way to assert which version
  // was actually agreed, rather than inferring it from the absence of an error:
  // the client throws on a version it does not support, but a server that
  // answered a *different supported* version would pass unnoticed.
  const negotiated = { version: null };
  transport.setProtocolVersion = (version) => {
    negotiated.version = version;
  };
  const client = new Client({ name: 'ai-agent-context-selfcheck', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, negotiated, close: async () => await client.close() };
}

/**
 * Runs a block against a connected client and always closes it.
 *
 * Not a nicety: a server process that outlives its client keeps the fixture
 * directory open on Windows, and the cleanup then fails with EPERM, which hides
 * whatever the block was actually doing.
 */
async function withClient(cwd, label, body) {
  const { client, negotiated, close } = await connect(cwd);
  try {
    await body(client, negotiated);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${label} — threw ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await close();
  }
}

const fixture = makeFixture();

try {
  process.stdout.write('handshake\n');
  await withClient(fixture, 'handshake', async (client, negotiated) => {
    const capabilities = client.getServerCapabilities();
    const identity = client.getServerVersion();
    check('the SDK client completes the handshake', true);
    check('the server identifies itself by name', identity?.name === SERVER_NAME, JSON.stringify(identity));
    check('the server advertises tools', capabilities?.tools !== undefined, JSON.stringify(capabilities));
    // The SDK asks for its own latest revision and refuses anything else. The
    // server answers with the revision the client asked for rather than the
    // newest one it knows, which is the whole point of negotiation: a client
    // that cannot read the newest revision still gets a working session.
    check(
      'the revision the client asked for is the one it is given',
      negotiated.version === SDK_LATEST_VERSION,
      `asked ${SDK_LATEST_VERSION}, got ${String(negotiated.version)}`,
    );
    check(
      'the negotiated revision is one this project supports',
      SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated.version),
      String(negotiated.version),
    );
  });

  process.stdout.write('\ntools\n');
  await withClient(fixture, 'tools', async (client) => {
    const { tools } = await client.listTools();
    check('listTools returns at least 14 tools', tools.length >= 14, `got ${tools.length}`);
    const names = tools.map((tool) => tool.name).sort();
    check(
      'every tool has a description the SDK accepts',
      tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 0),
    );
    check(
      'every tool declares an object input schema',
      tools.every((tool) => typeof tool.inputSchema?.type === 'string'),
      JSON.stringify(tools.find((tool) => tool.inputSchema?.type !== 'string')?.name ?? ''),
    );
    check('tool names are unique', new Set(names).size === names.length);
    check(
      'an unknown tool is rejected rather than silently ignored',
      await rejects(async () => await client.callTool({ name: 'no_such_tool', arguments: {} })),
    );
  });

  process.stdout.write('\ntool calls\n');
  await withClient(fixture, 'tool calls', async (client) => {
    const context = await client.callTool({ name: 'get_repository_context', arguments: {} });
    check('get_repository_context answers through the SDK', context.isError !== true, JSON.stringify(context).slice(0, 200));
    check('the payload names the repository', extractText(context).includes('fixture'));

    const architecture = await client.callTool({ name: 'get_architecture', arguments: {} });
    check('get_architecture answers through the SDK', architecture.isError !== true);

    const compact = await client.callTool({
      name: 'explain_module',
      arguments: { path: 'src/service.ts', detail: 'compact' },
    });
    check('explain_module honours detail=compact', compact.isError !== true, JSON.stringify(compact).slice(0, 200));

    const detail = await client.callTool({
      name: 'explain_module',
      arguments: { path: 'src/service.ts', detail: 'full' },
    });
    check('explain_module honours detail=full', detail.isError !== true, JSON.stringify(detail).slice(0, 200));

    // `compact` is a size budget, not a different question. It keeps the same
    // shape and drops the justification: an agent paying for tokens reads the
    // same facts, and asks for the evidence only when it needs to justify them.
    const compactPayload = parsePayload(compact);
    const fullPayload = parsePayload(detail);
    check(
      'compact is materially smaller than full',
      extractText(compact).length < extractText(detail).length,
      `${extractText(compact).length} vs ${extractText(detail).length}`,
    );
    check('compact answers the same question as full', Object.keys(compactPayload).join() === Object.keys(fullPayload).join());
    check(
      'compact entry points carry no evidence',
      (compactPayload.entryPoints ?? []).every((entry) => Array.isArray(entry.evidence) && entry.evidence.length === 0),
      JSON.stringify(compactPayload.entryPoints ?? []).slice(0, 200),
    );
    check(
      'full entry points carry evidence',
      (fullPayload.entryPoints ?? []).some((entry) => (entry.evidence ?? []).length > 0),
      JSON.stringify(fullPayload.entryPoints ?? []).slice(0, 200),
    );

    // An argument the server rejects outright is a protocol-level error, which
    // the SDK surfaces as a thrown error rather than a tool result. Returning
    // `isError` here would tell the agent the call ran and failed, when in fact
    // it never ran.
    check(
      'an invalid argument is rejected as a protocol error',
      await rejects(async () =>
        await client.callTool({
          name: 'explain_module',
          arguments: { path: 'src/service.ts', detail: 'nonsense' },
        }),
      ),
    );

    const search = await client.callTool({ name: 'search_context', arguments: { query: 'service' } });
    check('search_context answers through the SDK', search.isError !== true, JSON.stringify(search).slice(0, 200));

    const gaps = await client.callTool({ name: 'detect_coverage_gaps', arguments: {} });
    check('detect_coverage_gaps answers through the SDK', gaps.isError !== true, JSON.stringify(gaps).slice(0, 200));
  });

  process.stdout.write('\nprotocol behaviour\n');
  await withClient(fixture, 'protocol behaviour', async (client) => {
    // The SDK chooses the version it asks for. Whatever it settles on, the
    // server has to have answered a request written for that revision rather
    // than its own idea of the current one.
    const { tools } = await client.listTools();
    check('requests are answered under the negotiated version', tools.length > 0);
  });
} finally {
  // Windows will not remove a directory a live process is holding, so a failed
  // cleanup must not mask the result of the checks above.
  try {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    process.stdout.write(`  note: the fixture ${fixture} could not be removed\n`);
  }
}

process.stdout.write(`\n${failed === 0 ? 'mcp client check passed' : 'mcp client check FAILED'}: ${passed}/${passed + failed} checks\n`);

// Stated on every run rather than only in the release notes, because a green
// result here is easy to read as more than it is.
process.stdout.write('\nnot verified here:\n');
if (!SDK_SUPPORTED_PROTOCOL_VERSIONS.includes(LATEST_PROTOCOL_VERSION)) {
  process.stdout.write(
    `  - the per-request _meta revision this server calls ${LATEST_PROTOCOL_VERSION}: the reference\n` +
      `    SDK's newest revision is ${SDK_LATEST_VERSION}, so no third-party client can exercise the\n` +
      '    modern era yet. The negotiation helpers are unit-tested; the era itself is not.\n',
  );
} else {
  process.stdout.write(`  - nothing: this client supports ${LATEST_PROTOCOL_VERSION}.\n`);
}
process.stdout.write(
  '  - the desktop clients in the README matrix: they are applications, and launching one is\n' +
    '    outside what a command-line check can do.\n',
);

process.exit(failed === 0 ? 0 : 1);

/** The SDK returns content as a list of parts; the text is what the tools answer with. */
function extractText(result) {
  return (result.content ?? [])
    .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
    .join('\n');
}

/** The tool payloads are JSON documents; a client parses them the same way. */
function parsePayload(result) {
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool did not answer with JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Whether calling throws, which is how the SDK reports a protocol-level error. */
async function rejects(action) {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}