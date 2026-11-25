/**
 * A long-lived MCP session must describe the repository as it is now.
 *
 * The pool keeps one analysis per root for the lifetime of the server, and the
 * agent using the server edits that same repository between tool calls. Before
 * these tests, every answer after the first edit described the tree as it was
 * when the session started — and nothing in the answer said so. An agent
 * asking for the impact of a file it had just created was told "no dependents".
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../../core/dist/index.js';
import { ContextPool, McpServer, createMemoryTransport, TOOL_DEFINITIONS } from '../../mcp/dist/index.js';
import { cleanupTemp, createTempRepo, readRepoFile, writeRepoFile } from '../../core/test/helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** An analysed repository with no local scan: what an MCP-only user has. */
async function setup(): Promise<string> {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  await (await AgentContext.load({ root })).scan();
  return root;
}

describe('mcp session freshness', () => {
  test('a session answers from the current working tree after an edit', async () => {
    const root = await setup();
    const pool = new ContextPool({ root, stalenessCheckMs: 0 });
    const first = await pool.get(root);
    const before = await first.search('refund', { types: ['file'] });
    assert.equal(before.length, 0);

    writeRepoFile(root, 'src/models/refund.ts', 'export class Refund {}\n');
    const second = await pool.get(root);
    const after = await second.search('refund', { types: ['file'] });
    assert.deepEqual(
      after.map((result) => result.id),
      ['src/models/refund.ts'],
      'a file added mid-session must be visible to the next call',
    );
  });

  test('a dependency added mid-session is part of the next answer', async () => {
    const root = await setup();
    const pool = new ContextPool({ root, stalenessCheckMs: 0 });
    const importer = 'src/models/user-label.ts';
    assert.equal(
      (await (await pool.get(root)).getRepository()).files.some((file) => file.path === importer),
      false,
    );

    writeRepoFile(root, importer, "import { User } from './user';\nexport const label = (user: User) => user.name;\n");
    const repository = await (await pool.get(root)).getRepository();
    const added = repository.files.find((file) => file.path === importer);
    assert.ok(added, 'the new file must be in the graph');
    assert.deepEqual(added.importSpecifiers, ['./user'], 'and so must the import it contains');
  });

  test('an unchanged repository is not invalidated', async () => {
    const root = await setup();
    const pool = new ContextPool({ root, stalenessCheckMs: 0 });
    const context = await pool.get(root);
    await context.explain('src');
    let invalidations = 0;
    const original = context.invalidate.bind(context);
    context.invalidate = async () => {
      invalidations += 1;
      await original();
    };
    await pool.get(root);
    await pool.get(root);
    assert.equal(invalidations, 0, 'a session must not re-analyse a repository that did not move');
    assert.equal(await pool.get(root), context, 'the same context serves the whole session');
  });

  test('a configuration change is noticed', async () => {
    const root = await setup();
    const pool = new ContextPool({ root, stalenessCheckMs: 0 });
    await (await pool.get(root)).explain('src');
    writeRepoFile(root, '.agent/config.json', JSON.stringify({ exclude: ['src/utils/**'] }));
    const repository = await (await pool.get(root)).getRepository();
    assert.equal(repository.files.some((file) => file.path.startsWith('src/utils/')), false);
  });

  test('checks are spaced by stalenessCheckMs and not skipped forever', async () => {
    const root = await setup();
    let clock = 1_000_000;
    const pool = new ContextPool({ root, stalenessCheckMs: 1000, now: () => clock });
    await (await pool.get(root)).explain('src');

    // Inside the interval the previous check is trusted.
    clock += 10;
    writeRepoFile(root, 'src/models/refund.ts', 'export class Refund {}\n');
    assert.equal((await (await pool.get(root)).search('refund', { types: ['file'] })).length, 0);

    // Once it has elapsed, the edit is seen.
    clock += 1000;
    assert.equal((await (await pool.get(root)).search('refund', { types: ['file'] })).length, 1);
  });

  test('the server answers through the pool, so edits show up over the protocol too', async () => {
    const root = await setup();
    const transport = createMemoryTransport();
    const server = new McpServer({ root, transport, stalenessCheckMs: 0 });
    server.start();
    const call = async (id: number, name: string, args: Record<string, unknown>): Promise<unknown> => {
      await server.handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const response = transport.sent.at(-1) as { result: { content: Array<{ text: string }> } };
      return JSON.parse(response.result.content[0]!.text);
    };
    assert.equal(((await call(1, 'search_context', { query: 'refund', types: ['file'] })) as { results: unknown[] }).results.length, 0);

    const existing = 'src/models/user.ts';
    writeRepoFile(root, existing, `${readRepoFile(root, existing)}\n// edited during the session\n`);
    writeRepoFile(root, 'src/models/refund.ts', 'export class Refund {}\n');

    const found = (await call(2, 'search_context', { query: 'refund', types: ['file'] })) as { results: Array<{ id: string }> };
    assert.deepEqual(found.results.map((result) => result.id), ['src/models/refund.ts']);
  });
});

describe('mcp tool metadata', () => {
  test('every tool declares that it only reads', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }, `${tool.name} reads the repository and does nothing else`);
    }
  });

  test('tools/list carries the annotations', async () => {
    const root = await setup();
    const transport = createMemoryTransport();
    const server = new McpServer({ root, transport });
    server.start();
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listed = transport.sent.at(-1) as { result: { tools: Array<{ annotations: Record<string, unknown> }> } };
    assert.ok(listed.result.tools.length > 0);
    for (const tool of listed.result.tools) assert.equal(tool.annotations.readOnlyHint, true, 'the hint must reach the client');
  });
});

describe('mcp result encoding', () => {
  test('tool results are compact by default: indentation is tokens the model pays for', async () => {
    const root = await setup();
    const transport = createMemoryTransport();
    const server = new McpServer({ root, transport });
    server.start();
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_conventions', arguments: {} } });
    const response = transport.sent.at(-1) as { result: { content: Array<{ text: string }> } };
    const text = response.result.content[0]!.text;
    assert.equal(text.includes('\n  "'), false, 'pretty-printed JSON costs about a quarter more tokens for the same data');
    assert.equal(typeof (JSON.parse(text) as { total: number }).total, 'number', 'and must stay the same data');
  });

  test('prettyJson restores indentation for a human reading a transcript', async () => {
    const root = await setup();
    const transport = createMemoryTransport();
    const server = new McpServer({ root, transport, prettyJson: true });
    server.start();
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_conventions', arguments: {} } });
    const response = transport.sent.at(-1) as { result: { content: Array<{ text: string }> } };
    assert.equal(response.result.content[0]!.text.includes('\n  "'), true);
  });

  test('resources are compact too', async () => {
    const root = await setup();
    const transport = createMemoryTransport();
    const server = new McpServer({ root, transport });
    server.start();
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'agent://repository/architecture' } });
    const read = transport.sent.at(-1) as { result: { contents: Array<{ text: string }> } };
    assert.equal(read.result.contents[0]!.text.includes('\n  "'), false);
  });
});
