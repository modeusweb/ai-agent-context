#!/usr/bin/env node
/**
 * Executable entry point of the MCP adapter (`agent-context-mcp`).
 *
 * Usage:
 *   agent-context-mcp [--root <path>] [--staleness-check <ms>] [--pretty-json]
 *   agent-context-mcp config <client> [--root <path>] [--command <exe>] [--command-arg <arg> ...]
 *   agent-context-mcp config --all
 *   agent-context-mcp config --list
 *   agent-context-mcp --version
 *
 * The repository root defaults to `AGENT_CONTEXT_ROOT` and then to the current
 * working directory. The server speaks JSON-RPC over stdin/stdout, which is what
 * MCP clients expect; `config` prints a client configuration snippet and writes
 * nothing, so it is safe to run at any time.
 */
import path from 'node:path';
import { McpServer, createStdioTransport } from './server.ts';
import { MCP_VERSION } from './version.ts';
import { CLIENT_PRESETS, presetById, renderAllPresets, renderPreset } from './presets.ts';

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

function optionValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === flag) return argv[index + 1];
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
  }
  return undefined;
}

/** Collects a repeatable flag, so `--command-arg a --command-arg b` keeps order. */
function optionValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === flag) {
      const value = argv[index + 1];
      if (value !== undefined) values.push(value);
      continue;
    }
    if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
  }
  return values;
}

function usage(): string {
  return [
    'Usage:',
    '  agent-context-mcp [options]          run the stdio MCP server',
    '  agent-context-mcp config <client>    print a client config snippet',
    '  agent-context-mcp config --all       print every supported client',
    '  agent-context-mcp config --list      list supported clients',
    '  agent-context-mcp --version',
    '',
    'Options:',
    '  --root <path>            repository to analyze',
    '  --staleness-check <ms>   re-check the repository for edits at most this often (default: 1000; 0 = before every call)',
    '  --pretty-json            indent tool results (default: compact, which costs fewer tokens)',
    '  --command <exe>          executable that starts the server (default: npx)',
    '  --command-arg <arg>      argument for that executable (repeatable, default: -y @ai-agent-context/mcp)',
    '',
    `Clients: ${CLIENT_PRESETS.map((preset) => preset.id).join(', ')}`,
  ].join('\n');
}

/** Milliseconds between two staleness checks, or `null` when the flag is invalid. */
function parseStalenessCheck(argv: readonly string[]): number | undefined | null {
  const raw = optionValue(argv, '--staleness-check');
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Prints configuration for a client, or the usage text with exit code 2. */
function runConfigCommand(argv: readonly string[]): number {
  if (argv.includes('--list')) {
    for (const preset of CLIENT_PRESETS) {
      process.stdout.write(`${preset.id.padEnd(12)} ${preset.label} — ${preset.configFile}\n`);
    }
    return 0;
  }
  const command = optionValue(argv, '--command');
  const commandArgs = optionValues(argv, '--command-arg');
  const options = {
    root: parseRoot(argv),
    ...(command === undefined ? {} : { command }),
    ...(commandArgs.length > 0 ? { commandArgs } : {}),
  };
  if (argv.includes('--all')) {
    process.stdout.write(`${renderAllPresets(options)}\n`);
    return 0;
  }
  const requested = argv.find((argument) => !argument.startsWith('-'));
  if (requested === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const preset = presetById(requested);
  if (preset === undefined) {
    process.stderr.write(`unknown client: ${requested}\n\n${usage()}\n`);
    return 2;
  }
  process.stdout.write(`# ${preset.label} — add to ${preset.configFile}\n`);
  for (const note of preset.notes) process.stdout.write(`# ${note}\n`);
  process.stdout.write(`${renderPreset(preset, options)}\n`);
  return 0;
}

const argv = process.argv.slice(2);

if (process.argv.includes('--version')) {
  process.stdout.write(`${MCP_VERSION}\n`);
} else if (argv[0] === 'config') {
  process.exitCode = runConfigCommand(argv.slice(1));
} else if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const root = parseRoot(argv);
  const stalenessCheckMs = parseStalenessCheck(argv);
  if (stalenessCheckMs === null) {
    process.stderr.write('--staleness-check must be a number of milliseconds (0 or more)\n\n');
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else {
    const server = new McpServer({
      root,
      transport: createStdioTransport(),
      log: (line) => process.stderr.write(`${line}\n`),
      ...(stalenessCheckMs === undefined ? {} : { stalenessCheckMs }),
      ...(argv.includes('--pretty-json') ? { prettyJson: true } : {}),
    });
    server.start();
    // stderr only: stdout is the JSON-RPC channel and must stay parseable.
    process.stderr.write(`ai-agent-context MCP server ready (root: ${root})\n`);
  }
}