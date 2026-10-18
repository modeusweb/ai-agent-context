#!/usr/bin/env node
/**
 * End-to-end smoke test of the *published* artifacts.
 *
 * The unit suite runs against the workspace through TypeScript source. This
 * script runs against what users actually install: it packs every package,
 * installs the tarballs into a clean project, and drives the CLI and the MCP
 * server over stdio.
 *
 * It exists because the two can drift apart silently. The published packages
 * ship compiled JavaScript with no test coverage of their own, and the declared
 * `engines.node >= 20.11.0` cannot be validated by a suite that needs Node's
 * native type stripping. Running this on the oldest supported Node is the only
 * way to keep that claim honest.
 *
 * The fixture is built to contain exactly the inputs that broke things:
 *   - an import that climbs two directories (`../deep/nested/leaf.ts`)
 *   - a re-export that climbs one (`./deep/nested/leaf.ts` from src/index.ts)
 *   - an import that tries to escape the repository root
 *
 * Usage: node tools/smoke.mjs [--keep]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const base = mkdtempSync(path.join(os.tmpdir(), 'aac-smoke-'));
const tarballs = path.join(base, 'tarballs');
const consumer = path.join(base, 'consumer');
mkdirSync(tarballs, { recursive: true });
mkdirSync(consumer, { recursive: true });

const failures = [];
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
    failures.push(label);
  }
}

// npm is invoked through its own CLI entry point rather than the `npm` shim.
// Modern Node refuses to spawn a `.cmd` without a shell, and shelling out
// concatenates arguments unescaped; going straight to the CLI script avoids
// both problems. `npm_execpath` is set when this runs as `npm run smoke`.
const NPM_CLI = process.env.npm_execpath;

/** Runs an npm subcommand. */
function npm(args, cwd) {
  if (NPM_CLI !== undefined && NPM_CLI.length > 0) {
    return run(null, process.execPath, [NPM_CLI, ...args], cwd);
  }
  const shim = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(null, shim, args, cwd, { shell: process.platform === 'win32' });
}

function run(label, command, args, cwd, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error;
    if (label !== null) {
      console.log(`  FAIL ${label} — exited ${failure.status ?? 1}`);
      failures.push(label);
    }
    return {
      status: failure.status ?? 1,
      stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

/** Runs the CLI and returns parsed JSON, tolerating a non-zero exit. */
function cliJson(args) {
  const result = run(null, process.execPath, [path.join(consumer, 'node_modules/ai-agent-context/dist/bin.js'), ...args], consumer);
  try {
    return { status: result.status, payload: JSON.parse(result.stdout) };
  } catch {
    return { status: result.status, payload: undefined, raw: result.stdout };
  }
}

try {
  console.log(`smoke workspace: ${base}`);

  console.log('packing');
  for (const pkg of ['core', 'cli', 'mcp']) {
    const result = npm(['pack', `./packages/${pkg}`, '--pack-destination', tarballs], root);
    check(`pack ${pkg}`, result.status === 0, result.stdout.slice(-200));
  }
  const packed = readdirSync(tarballs);
  check('three tarballs produced', packed.length === 3, `got ${packed.length}: ${packed.join(', ')}`);

  console.log('installing into a clean project');
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'smoke-consumer', version: '1.0.0' }, null, 2));
  const coreTarball = packed.find((name) => /^ai-agent-context-core-/.test(name));
  const cliTarball = packed.find((name) => /^ai-agent-context-\d/.test(name));
  const mcpTarball = packed.find((name) => name.startsWith('ai-agent-context-mcp-'));
  check('core tarball found', coreTarball !== undefined, `packed: ${packed.join(', ')}`);
  check('cli tarball found', cliTarball !== undefined, `packed: ${packed.join(', ')}`);
  check('mcp tarball found', mcpTarball !== undefined, `packed: ${packed.join(', ')}`);
  if (packed.length !== 3 || coreTarball === undefined || cliTarball === undefined || mcpTarball === undefined) {
    throw new Error('cannot continue without all three packed tarballs');
  }
  // All three tarballs are installed together so npm satisfies the CLI's and
  // adapter's dependency on core from the local pack output instead of the registry.
  // That is what the artifacts under test actually are, and it removes a race with
  // registry propagation that failed the release commit for no real reason.
  const installed = npm(
    ['install', path.join(tarballs, coreTarball), path.join(tarballs, cliTarball), path.join(tarballs, mcpTarball)],
    consumer,
  );
  const installOk = installed.status === 0;
  check('install packed tarballs', installOk, installed.stdout.slice(-200));

  if (!installOk) {
    // Stop here. Every check below runs a binary out of node_modules, so a
    // failed install otherwise turns one root cause into a dozen identical
    // MODULE_NOT_FOUND failures that say nothing about the real problem.
    // `run` folds stderr into `stdout` when a command fails.
    const output = installed.stdout;
    const unpublished = /is not in this registry|No matching version found|404 Not Found/i.test(output);
    const version = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).version;
    console.error('');
    if (unpublished) {
      console.error('smoke cannot continue: @ai-agent-context/core is not on the registry yet.');
      console.error('');
      console.error(`  The packed CLI depends on @ai-agent-context/core@^${version}, and ${version}`);
      console.error('  has not been published. npm resolves that dependency from the registry');
      console.error('  even though a local tarball was packed, so the install fails.');
      console.error('');
      console.error('  This is the expected order of operations, not a defect. Publish first,');
      console.error('  then push:');
      console.error('');
      console.error('    npm run publish:all     # core, then cli, then mcp');
      console.error('    git push');
      console.error('');
      console.error('  After publishing, re-run: npm run smoke');
    } else {
      console.error('smoke cannot continue: installing the packed tarballs failed.');
      console.error(output.slice(-2000));
    }
    console.error('');
    throw new Error('packed tarballs are not installable');
  }

  console.log('building the fixture');
  mkdirSync(path.join(consumer, 'src/deep/nested'), { recursive: true });
  mkdirSync(path.join(consumer, 'src/app'), { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'smoke-consumer', version: '1.0.0', type: 'module' }, null, 2));
  writeFileSync(path.join(consumer, 'src/index.ts'), "export { leaf } from './deep/nested/leaf.ts';\n");
  writeFileSync(path.join(consumer, 'src/deep/nested/leaf.ts'), 'export const leaf = 1;\n');
  writeFileSync(path.join(consumer, 'src/deep/nested/other.ts'), 'export const other = 2;\n');
  writeFileSync(path.join(consumer, 'src/app/consumer.ts'), "import { leaf } from '../deep/nested/leaf.ts';\nexport const used = leaf;\n");
  writeFileSync(path.join(consumer, 'src/app/other.ts'), 'export const other = 5;\n');
  writeFileSync(path.join(consumer, 'src/app/evil.ts'), "import { x } from '../../../etc/passwd';\nexport const used = x;\n");

  const bin = path.join(consumer, 'node_modules/ai-agent-context/dist/bin.js');
  const cli = (...args) => run(null, process.execPath, [bin, ...args], consumer);

  console.log('CLI');
  check('init succeeds', cli('init').status === 0);
  const scan = cli('scan');
  check('scan succeeds', scan.status === 0);
  check('scan reports the climbing dependency', /Dependencies\s+1/.test(scan.stdout) || scan.stdout.includes('Dependencies            1'), scan.stdout.split('\n').find((l) => l.startsWith('Dependencies')) ?? '');
  const verify = cliJson(['verify', '--json']);
  check('verify reports valid context', verify.payload?.valid === true, String(verify.raw ?? '').slice(0, 160));

  const impact = cliJson(['impact', 'src/deep/nested', '--json']);
  check(
    'impact resolves the import that climbs two directories',
    impact.payload !== undefined && impact.payload.files.includes('src/app/consumer.ts'),
    JSON.stringify(impact.payload?.files ?? impact.raw ?? ''),
  );

  const detect = cliJson(['detect', '--json']);
  check('detect is available as a command', detect.payload !== undefined, String(detect.raw ?? '').slice(0, 120));
  check('detect counts exactly one path escape', detect.payload?.imports?.pathEscapes === 1, JSON.stringify(detect.payload?.imports ?? {}));
  check('detect rates a rejected traversal as an error', (detect.payload?.counts?.error ?? 0) >= 1);
  check('detect resolves every resolvable import', detect.payload?.imports?.resolutionRate === 1);

  const explainCompact = cliJson(['explain', 'src/app', '--detail', 'compact', '--json']);
  check('explain --detail compact is accepted', explainCompact.status === 0 && explainCompact.payload?.detail === 'compact', String(explainCompact.raw ?? '').slice(0, 120));
  const explainBad = cli('explain', 'src/app', '--detail', 'bogus');
  check('explain rejects an unknown --detail', explainBad.status === 2, `exit ${explainBad.status}`);

  console.log('MCP');
  const mcpResult = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(consumer, 'node_modules/@ai-agent-context/mcp/dist/bin.js')], {
      cwd: consumer,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const seen = new Map();
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) seen.set(message.id, message);
        } catch {
          resolve({ error: `unparsable stdout line: ${line}` });
        }
      }
    });
    const send = (object) => child.stdin.write(`${JSON.stringify(object)}\n`);
    const wait = (id) =>
      new Promise((res) => {
        const timer = setInterval(() => {
          if (seen.has(id)) { clearInterval(timer); res(seen.get(id)); }
        }, 50);
        setTimeout(() => { clearInterval(timer); res(undefined); }, 20000);
      });
    (async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const init = await wait(1);
      if (init === undefined) { child.kill(); resolve({ error: 'initialize timed out', stderr }); return; }
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const tools = await wait(2);
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'detect_coverage_gaps', arguments: {} } });
      const detectCall = await wait(3);
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'explain_module', arguments: { path: 'src/app', detail: 'compact' } } });
      const explainCall = await wait(4);
      send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'explain_module', arguments: { path: 'src/app', detail: 'bogus' } } });
      const badArgs = await wait(5);
      child.kill();
      resolve({ init, tools, detectCall, explainCall, badArgs, stderr });
    })();
  });

  check('mcp initialize responds', mcpResult?.init?.result?.protocolVersion !== undefined, JSON.stringify(mcpResult ?? {}).slice(0, 160));
  const toolNames = (mcpResult?.tools?.result?.tools ?? []).map((tool) => tool.name);
  check('mcp exposes at least 14 tools', toolNames.length >= 14, `${toolNames.length}`);
  check('mcp exposes detect_coverage_gaps', toolNames.includes('detect_coverage_gaps'));
  const detectPayload = mcpResult?.detectCall?.result
    ? JSON.parse(mcpResult.detectCall.result.content[0].text)
    : undefined;
  check('mcp detect reports the path escape', detectPayload?.imports?.pathEscapes === 1, JSON.stringify(detectPayload?.imports ?? {}));
  const explainPayload = mcpResult?.explainCall?.result
    ? JSON.parse(mcpResult.explainCall.result.content[0].text)
    : undefined;
  check('mcp explain honours detail=compact', explainPayload?.detail === 'compact', JSON.stringify(explainPayload ?? {}).slice(0, 120));
  check('mcp rejects an invalid detail value', mcpResult?.badArgs?.error !== undefined);
} finally {
  if (keep) {
    console.log(`kept workspace: ${base}`);
  } else {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`smoke FAILED: ${failures.length}/${checks} checks failed`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}
console.log(`smoke passed: ${checks}/${checks} checks`);