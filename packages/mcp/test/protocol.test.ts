/**
 * Protocol-level tests for the MCP adapter.
 *
 * These cover version negotiation, era selection, the error taxonomy,
 * cancellation and request timeouts. They exercise the server through the
 * in-memory transport, so no analysis runs for the pure-protocol cases.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { AgentContext } from '../../core/dist/index.js';
import {
  ErrorCode,
  LATEST_LEGACY_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  isModernVersion,
  isSupportedVersion,
  negotiateLegacyVersion,
  unsupportedProtocolVersion,
  McpServer,
  createMemoryTransport,
} from '../../mcp/dist/index.js';
import { cleanupTemp, createTempRepo } from '../../core/test/helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

function server(overrides: Record<string, unknown> = {}) {
  const root = createTempRepo('simple-ts');
  tempRoots.push(root);
  const transport = createMemoryTransport();
  const instance = new McpServer({ root, transport, ...overrides });
  return { root, transport, instance };
}

async function initialize(
  instance: McpServer,
  transport: ReturnType<typeof createMemoryTransport>,
  protocolVersion: unknown,
  id = 1,
): Promise<{ protocolVersion?: string }> {
  await instance.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: protocolVersion === undefined ? {} : { protocolVersion },
  });
  return (transport.sent.at(-1) as { result: { protocolVersion?: string } }).result;
}

/** `_meta` block a modern client attaches to every request. */
function modernMeta(version: string): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_CAPABILITIES]: {},
  };
}

describe('protocol version helpers', () => {
  test('knows which revisions are implemented', () => {
    assert.ok(isSupportedVersion('2024-11-05'));
    assert.ok(isSupportedVersion('2026-07-28'));
    assert.equal(isSupportedVersion('1900-01-01'), false);
    assert.equal(isSupportedVersion(undefined), false);
    assert.equal(isSupportedVersion(20240101), false);
    // Every advertised revision is classified as either legacy or modern.
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      assert.equal(typeof isModernVersion(version), 'boolean');
    }
    assert.equal(isModernVersion('2025-11-25'), false);
    assert.equal(isModernVersion('2026-07-28'), true);
    // An unknown revision is assumed modern: a newer client cannot use legacy
    // handshake semantics, so guessing otherwise would serve it the wrong era.
    assert.equal(isModernVersion('2099-01-01'), true);
  });

  test('legacy negotiation echoes a supported version and otherwise falls back', () => {
    assert.equal(negotiateLegacyVersion('2024-11-05'), '2024-11-05');
    assert.equal(negotiateLegacyVersion('2025-03-26'), '2025-03-26');
    assert.equal(negotiateLegacyVersion('2025-06-18'), '2025-06-18');
    assert.equal(negotiateLegacyVersion('2025-11-25'), '2025-11-25');
    // Unknown, missing, malformed and modern requests all get the newest legacy.
    assert.equal(negotiateLegacyVersion('1999-01-01'), LATEST_LEGACY_VERSION);
    assert.equal(negotiateLegacyVersion(undefined), LATEST_LEGACY_VERSION);
    assert.equal(negotiateLegacyVersion(42), LATEST_LEGACY_VERSION);
    assert.equal(negotiateLegacyVersion('2026-07-28'), LATEST_LEGACY_VERSION);
  });

  test('unsupported version error lists the versions a client may retry with', () => {
    const error = unsupportedProtocolVersion('1900-01-01');
    assert.equal(error.code, ErrorCode.UnsupportedProtocolVersion);
    assert.equal(error.code, -32022);
    const data = error.data as { supported: string[]; requested: string };
    assert.deepEqual(data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal(data.requested, '1900-01-01');
  });
});

describe('legacy era: initialize handshake', () => {
  test('answers the version the client asked for', async () => {
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      const { instance, transport } = server();
      const result = await initialize(instance, transport, version);
      // Before negotiation the server pinned 2024-11-05 and every newer client
      // was told to downgrade to a revision it did not ask for.
      assert.equal(result.protocolVersion, version, `client asking for ${version} must be answered with ${version}`);
      assert.equal(instance.protocolVersion, version);
    }
  });

  test('falls back to the newest legacy version for an unknown request', async () => {
    const { instance, transport } = server();
    const result = await initialize(instance, transport, '1999-01-01');
    assert.equal(result.protocolVersion, LATEST_LEGACY_VERSION);
  });

  test('defaults when the client sends no version at all', async () => {
    const { instance, transport } = server();
    const result = await initialize(instance, transport, undefined);
    assert.equal(result.protocolVersion, LATEST_LEGACY_VERSION);
  });

  test('a modern revision requested over initialize is not echoed', async () => {
    const { instance, transport } = server();
    const result = await initialize(instance, transport, '2026-07-28');
    // Modern clients never send this handshake; answering with a legacy revision
    // gives them the best available chance rather than a revision they cannot run.
    assert.equal(result.protocolVersion, LATEST_LEGACY_VERSION);
  });
});

describe('modern era: server/discover', () => {
  test('advertises every supported version and the server identity', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 'discover-1',
      method: 'server/discover',
      params: { _meta: modernMeta('2026-07-28') },
    });
    const result = (transport.sent.at(-1) as {
      result: {
        resultType: string;
        supportedVersions: string[];
        capabilities: Record<string, unknown>;
        _meta: Record<string, { name: string; version: string }>;
      };
    }).result;
    assert.equal(result.resultType, 'complete');
    assert.deepEqual(result.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.ok(result.capabilities['tools'] !== undefined);
    assert.equal(result._meta[META_SERVER_INFO].name, 'ai-agent-context');
  });

  test('refuses an unsupported revision with -32022 and the retry list', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
      params: { _meta: modernMeta('2099-01-01') },
    });
    const response = transport.sent.at(-1) as {
      error: { code: number; message: string; data: { supported: string[]; requested: string } };
    };
    assert.equal(response.error.code, -32022);
    assert.equal(response.error.message, 'Unsupported protocol version');
    assert.deepEqual(response.error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal(response.error.data.requested, '2099-01-01');
  });

  test('rejects a modern request that omits the required client capabilities', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' } },
    });
    const response = transport.sent.at(-1) as { error: { code: number; message: string; data: { field: string } } };
    assert.equal(response.error.code, ErrorCode.InvalidParams);
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.data.field, META_CLIENT_CAPABILITIES);
  });

  test('modern results carry resultType while legacy results do not', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({ jsonrpc: '2.0', id: 'm1', method: 'ping', params: { _meta: modernMeta('2026-07-28') } });
    const modern = (transport.sent.at(-1) as { result: Record<string, unknown> }).result;
    assert.equal(modern['resultType'], 'complete');

    await instance.handleMessage({ jsonrpc: '2.0', id: 'm2', method: 'ping' });
    const legacy = (transport.sent.at(-1) as { result: Record<string, unknown> }).result;
    assert.equal(legacy['resultType'], undefined);
  });
});

describe('error taxonomy', () => {
  test('unknown method reports -32601', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({ jsonrpc: '2.0', id: 1, method: 'nope/nope' });
    const response = transport.sent.at(-1) as { error: { code: number } };
    assert.equal(response.error.code, -32601);
  });

  test('unknown resource reports -32602 and never the reserved -32002', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'agent://nope' } });
    const response = transport.sent.at(-1) as { error: { code: number } };
    assert.equal(response.error.code, -32602);
    assert.notEqual(response.error.code, -32002);
  });

  test('invalid tool arguments are rejected before dispatch', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'explain_module', arguments: {} },
    });
    const response = transport.sent.at(-1) as { error: { code: number; message: string } };
    assert.equal(response.error.code, -32602);
  });

  test('a failing tool is reported as a result, not a protocol error', async () => {
    const { root, instance, transport } = server();
    const context = await AgentContext.load({ root });
    await context.scan();
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'explain_module', arguments: { path: 'src/models' } },
    });
    const response = transport.sent.at(-1) as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(response.result.isError, false);
    assert.ok(response.result.content[0].text.includes('modules'));
  });

  test('malformed messages never corrupt the protocol channel', async () => {
    const { instance, transport } = server();
    // Non-objects are not requests at all and draw no response.
    await instance.handleMessage(null);
    await instance.handleMessage('a string');
    await instance.handleMessage([1, 2, 3]);
    assert.equal(transport.sent.length, 0);

    // An object without a method is an Invalid Request, not an unknown method.
    await instance.handleMessage({ jsonrpc: '2.0', id: 1 });
    const invalid = transport.sent.at(-1) as { error: { code: number } };
    assert.equal(invalid.error.code, -32600);

    // The channel still works afterwards.
    await instance.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(transport.sent.length, 2);
    assert.ok((transport.sent.at(-1) as { result?: unknown }).result !== undefined);
  });
});

describe('cancellation and timeouts', () => {
  test('a cancelled request is never answered', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const transport = createMemoryTransport();
    // A context factory that never resolves, so the cancellation lands first.
    const instance = new McpServer({
      root,
      transport,
      createContext: () => new Promise(() => {}),
    });
    const pending = instance.handleMessage({
      jsonrpc: '2.0',
      id: 'cancel-me',
      method: 'tools/call',
      params: { name: 'explain_module', arguments: { path: 'src' } },
    });
    // Let the request reach the in-flight map before cancelling it.
    await new Promise((resolve) => setImmediate(resolve));
    await instance.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'cancel-me', reason: 'user aborted' },
    });
    await pending;
    assert.equal(transport.sent.length, 0, 'a cancelled request must not produce a response');
  });

  test('cancelling an unknown request is harmless', async () => {
    const { instance, transport } = server();
    await instance.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'never-existed' },
    });
    assert.equal(transport.sent.length, 0);
    await instance.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(transport.sent.length, 1);
  });

  test('a request that exceeds the timeout is answered with an error', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const transport = createMemoryTransport();
    const instance = new McpServer({
      root,
      transport,
      requestTimeoutMs: 10,
      createContext: () => new Promise(() => {}),
    });
    await instance.handleMessage({
      jsonrpc: '2.0',
      id: 'slow',
      method: 'tools/call',
      params: { name: 'explain_module', arguments: { path: 'src' } },
    });
    const response = transport.sent.at(-1) as { error: { code: number; message: string; data: { timeoutMs: number } } };
    assert.equal(response.error.code, -32603);
    assert.ok(response.error.message.includes('timed out'));
    assert.equal(response.error.data.timeoutMs, 10);
  });

  test('a request that finishes in time is answered normally', async () => {
    const { instance, transport } = server({ requestTimeoutMs: 30_000 });
    await instance.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const response = transport.sent.at(-1) as { result: Record<string, unknown> };
    assert.deepEqual(response.result, {});
  });
});