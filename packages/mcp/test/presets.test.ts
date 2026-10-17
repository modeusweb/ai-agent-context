/**
 * Configuration presets and stdio-channel tests.
 *
 * The presets are the part of the adapter a user touches first: a wrong shape or
 * a wrong path is what makes a working server look broken, so the rendered JSON
 * is asserted directly. The stdio tests drive the real executable as a child
 * process, because "diagnostics stay off stdout" cannot be proven with an
 * in-memory transport.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_PRESETS,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  presetById,
  renderAllPresets,
  renderPreset,
  serverArgv,
} from '../../mcp/dist/index.js';
import { cleanupTemp, createTempRepo } from '../../core/test/helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '../../mcp/dist/bin.js');

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

describe('mcp client presets', () => {
  test('covers the clients the roadmap names', () => {
    assert.deepEqual(
      CLIENT_PRESETS.map((preset) => preset.id),
      ['claude-code', 'cursor', 'cline', 'continue'],
    );
    for (const preset of CLIENT_PRESETS) {
      assert.ok(preset.configFile.length > 0);
      assert.ok(preset.notes.length > 0);
    }
  });

  test('object-shaped clients get a name-keyed entry', () => {
    for (const id of ['claude-code', 'cursor', 'cline'] as const) {
      const preset = presetById(id)!;
      const rendered = JSON.parse(renderPreset(preset, { root: '/repo' })) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      const entry = rendered.mcpServers['agent-context'];
      assert.ok(entry, `${id} must define an "agent-context" entry`);
      assert.equal(entry.command, 'npx');
      assert.deepEqual(entry.args, ['-y', '@ai-agent-context/mcp', '--root', '/repo']);
    }
  });

  test('continue takes an array and carries the server name inside it', () => {
    const rendered = JSON.parse(renderPreset(presetById('continue')!, { root: '/repo' })) as {
      mcpServers: Array<{ name: string; command: string; args: string[] }>;
    };
    assert.ok(Array.isArray(rendered.mcpServers));
    assert.equal(rendered.mcpServers[0].name, 'agent-context');
    assert.deepEqual(rendered.mcpServers[0].args, ['-y', '@ai-agent-context/mcp', '--root', '/repo']);
  });

  test('a local checkout can be started through node instead of npx', () => {
    const preset = presetById('cursor')!;
    const rendered = JSON.parse(renderPreset(preset, { root: '/repo', command: 'node', commandArgs: ['/tmp/mcp/bin.js'] })) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = rendered.mcpServers['agent-context'];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['/tmp/mcp/bin.js', '--root', '/repo']);
    assert.deepEqual(serverArgv({ root: '/repo', commandArgs: ['/tmp/mcp/bin.js'] }), ['/tmp/mcp/bin.js', '--root', '/repo']);
  });

  test('cline keeps its own keys but never pre-approves a tool', () => {
    const rendered = JSON.parse(renderPreset(presetById('cline')!, { root: '/repo' })) as {
      mcpServers: Record<string, { disabled: boolean; autoApprove: string[] }>;
    };
    const entry = rendered.mcpServers['agent-context'];
    assert.equal(entry.disabled, false);
    assert.deepEqual(entry.autoApprove, []);
  });

  test('renderAllPresets emits one labelled section per client', () => {
    const all = renderAllPresets({ root: '/repo' });
    for (const preset of CLIENT_PRESETS) {
      assert.ok(all.includes(preset.configFile), `${preset.id} section must name its config file`);
    }
    // Every section must be valid JSON on its own.
    const sections = all.split('\n\n').filter((section) => section.includes('{'));
    assert.equal(sections.length, CLIENT_PRESETS.length);
    for (const section of sections) {
      JSON.parse(section.slice(section.indexOf('{')));
    }
  });

  test('an unknown client resolves to undefined', () => {
    assert.equal(presetById('emacs'), undefined);
  });
});

/** Runs the server binary and collects one line of stdout per request sent. */
function driveServer(requests: unknown[], root: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('mcp stdio channel', () => {
  test('a full legacy session runs over a real process and stdout stays JSON', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const { stdout, code } = await driveServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ], root);

    const lines = stdout.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 3, 'every request must be answered exactly once');
    const parsed = lines.map((line) => JSON.parse(line) as { id: string | number; result?: Record<string, unknown> });
    assert.deepEqual(parsed.map((message) => message.id), [1, 2, 3]);
    assert.equal((parsed[0].result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.ok(Array.isArray((parsed[1].result as { tools: unknown[] }).tools));
    assert.notEqual(code, 1);
  });

  test('a modern session negotiates per request over the same channel', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const meta = { [META_PROTOCOL_VERSION]: '2026-07-28', [META_CLIENT_CAPABILITIES]: {} };
    const { stdout } = await driveServer([
      { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: meta } },
      { jsonrpc: '2.0', id: 'd2', method: 'ping', params: { _meta: meta } },
      { jsonrpc: '2.0', id: 'd3', method: 'tools/list', params: { _meta: { [META_PROTOCOL_VERSION]: '2099-01-01', [META_CLIENT_CAPABILITIES]: {} } } },
    ], root);

    const parsed = stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as { id: string; result?: Record<string, unknown>; error?: { code: number } });
    assert.equal(parsed.length, 3);
    assert.deepEqual((parsed[0].result as { supportedVersions: string[] }).supportedVersions.slice(-1), ['2026-07-28']);
    assert.equal((parsed[1].result as { resultType: string }).resultType, 'complete');
    assert.equal(parsed[2].error?.code, -32022);
  });

  test('garbage on stdin never breaks the channel', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const child = spawn(process.execPath, [BIN, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.stdin.write('this is not json\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    child.stdin.write('[]\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    const lines = stdout.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 2, 'only the two well-formed pings are answered');
    assert.ok(stderr.includes('unparsable message'), 'the parse failure is reported on stderr');
    assert.notEqual(code, 1);
  });

  test('the config subcommand prints a snippet and exits 0', async () => {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'config', '--list'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.stdin.end();
      child.on('close', (code) => resolve({ stdout, stderr, code }));
    });
    assert.equal(result.code, 0);
    for (const id of ['claude-code', 'cursor', 'cline', 'continue']) {
      assert.ok(result.stdout.includes(id), `config --list must mention ${id}`);
    }
  });

  test('an unknown client exits 2 with usage', async () => {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'config', 'emacs'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.stdin.end();
      child.on('close', (code) => resolve({ stdout, stderr, code }));
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('unknown client: emacs'));
  });
});