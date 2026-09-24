/**
 * `agent-context` CLI — argument parsing and dispatch.
 *
 * The CLI contains no analysis logic: every command builds an AgentContext and
 * prints a projection of the result. It is fully testable without spawning a
 * process because {@link runCli} receives its I/O as parameters.
 */
import { AgentContext, toDiagnosticPayload, isAgentContextError, type AgentContextOptions } from '@ai-agent-context/core';
import { ConsoleOutput } from './ui/console.ts';
import { runInitCommand } from './commands/init.ts';
import { runScanCommand } from './commands/scan.ts';
import { runDiffCommand } from './commands/diff.ts';
import { runStatusCommand } from './commands/status.ts';
import { runExplainCommand } from './commands/explain.ts';
import { runCleanCommand } from './commands/clean.ts';
import { runSearchCommand } from './commands/search.ts';
import { runContextCommand } from './commands/context.ts';
import { runTaskCommand } from './commands/task.ts';
import { runImpactCommand } from './commands/impact.ts';
import { runHistoryCommand } from './commands/history.ts';
import { runRevisionDiffCommand } from './commands/revision-diff.ts';

export const CLI_NAME = 'agent-context';
export const CLI_VERSION = '0.3.3';


export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Force colours on/off; `undefined` means auto-detect. */
  color?: boolean;
}

export interface ParsedArguments {
  command: string | null;
  positional: string[];
  flags: Map<string, string | boolean>;
  unknownFlags: string[];
}

/** Flags that take a value when written as `--flag value`. */
const VALUED_FLAGS = new Set([
  'root',
  'config',
  'include',
  'exclude',
  'ignore',
  'language',
  'languages',
  'limit',
  'types',
  'max-files',
  'max-modules',
  'max-entry-points',
  'max-external-dependencies',
  'max-conventions',
  'max-decisions',
  'max-cycles',
  'target',
  'base',
  'revision',
  'limit-history',
]);

const KNOWN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'quiet',
  'verbose',
  'force',
  'yes',
  'color',
  'cache',
  'all',
  'root',
  'config',
  'include',
  'exclude',
  'ignore',
  'language',
  'languages',
  'limit',
  'types',
  'max-files',
  'max-modules',
  'max-entry-points',
  'max-external-dependencies',
  'max-conventions',
  'max-decisions',
  'max-cycles',
  'target',
  'base',
  'revision',
  'limit-history',
]);

function appendFlag(flags: Map<string, string | boolean>, name: string, value: string): void {
  const existing = flags.get(name);
  if (typeof existing === 'string' && existing.length > 0) flags.set(name, `${existing},${value}`);
  else flags.set(name, value);
}

/**
 * Parses CLI arguments.
 *
 * Supported forms: `--flag`, `--no-flag`, `--key=value`, `--key value`, `-h`.
 * Repeated value flags are joined with commas, so
 * `--include a --include b` behaves like `--include a,b`.
 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      if (body.length === 0) continue;
      const equals = body.indexOf('=');
      if (equals !== -1) {
        appendFlag(flags, body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        flags.set(body.slice(3), false);
        continue;
      }
      const next = argv[index + 1];
      if (VALUED_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        appendFlag(flags, body, next);
        index += 1;
        continue;
      }
      flags.set(body, true);
      if (!KNOWN_FLAGS.has(body)) unknownFlags.push(body);
      continue;
    }
    if (argument.startsWith('-') && argument.length > 1) {
      const short = argument.slice(1);
      if (short === 'h') flags.set('help', true);
      else if (short === 'v') flags.set('version', true);
      else unknownFlags.push(short);
      continue;
    }
    if (command === null) command = argument;
    else positional.push(argument);
  }

  return { command, positional, flags, unknownFlags };
}

export function flagString(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagList(parsed: ParsedArguments, name: string): string[] | undefined {
  const value = flagString(parsed, name);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function flagBoolean(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/** Builds the {@link AgentContextOptions} implied by global CLI flags. */
export function contextOptions(parsed: ParsedArguments, io: CliIo): AgentContextOptions {
  const include = flagList(parsed, 'include');
  const exclude = flagList(parsed, 'exclude');
  const ignore = flagList(parsed, 'ignore');
  const languages = flagList(parsed, 'languages') ?? flagList(parsed, 'language');
  const root = flagString(parsed, 'root') ?? io.cwd;
  const options: AgentContextOptions = {
    root,
    config: {
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(ignore === undefined ? {} : { ignore }),
      ...(languages === undefined ? {} : { languages }),
    },
  };
  const configPath = flagString(parsed, 'config');
  if (configPath !== undefined) options.configPath = configPath;
  return options;
}

export interface CliCommandContext {
  parsed: ParsedArguments;
  output: ConsoleOutput;
  io: CliIo;
  json: boolean;
}

export interface CliDependencies {
  createContext: (options: AgentContextOptions) => Promise<AgentContext>;
}

const HELP_TEXT = `Git-native context layer for AI coding agents

Usage:
  agent-context <command> [options]

Commands:
  init                 Create .agent/ and .agent/config.json (idempotent)
  scan                 Analyze the repository and update .agent/
  diff                 Show repository context changes since the last scan
  status               Show whether the context is up to date
  explain <path>       Explain a module (or the module owning a file)
  search <query>       Deterministic lexical search over the context
  context              Compact repository context summary
  task <description>   Bounded task-oriented context for an agent
  impact <target>      Show bounded change impact for a module
  history <target>    Show bounded Git history for a module
  revision-diff       Show local diff for a revision
  clean                Remove generated context and caches

Options:
  --root <path>        Repository root (default: current directory)
  --config <path>      Alternative configuration file
  --include <glob>     Override include patterns (repeatable, comma separated)
  --exclude <glob>     Override exclude patterns
  --ignore <glob>      Additional ignore patterns
  --language <name>    Restrict language analysis (repeatable)
  --force              init: overwrite config · scan: ignore the local state
  --json               Machine readable output on stdout
  --quiet              Suppress progress output
  --verbose            Verbose diagnostics on stderr
  --no-color           Disable colours
  -h, --help           Show this help
  -v, --version        Show the version

Exit codes:
  0 success · 1 analysis error · 2 usage error
`;

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: readonly string[], ioOverrides: Partial<CliIo> = {}): Promise<number> {
  const io: CliIo = {
    stdout: ioOverrides.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
    stderr: ioOverrides.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
    cwd: ioOverrides.cwd ?? process.cwd(),
    env: ioOverrides.env ?? process.env,
  };
  const parsed = parseArguments(argv);
  const color =
    io.color ??
    (io.env['NO_COLOR'] === undefined && parsed.flags.get('color') !== false && process.stdout.isTTY === true);
  const output = new ConsoleOutput({
    stdout: io.stdout,
    stderr: io.stderr,
    color,
    quiet: flagBoolean(parsed, 'quiet'),
    verbose: flagBoolean(parsed, 'verbose'),
  });

  if (flagBoolean(parsed, 'version')) {
    output.print(CLI_VERSION);
    return 0;
  }
  if (flagBoolean(parsed, 'help')) {
    output.print(HELP_TEXT);
    return 0;
  }
  if (parsed.command === null || parsed.command === 'help') {
    output.print(HELP_TEXT);
    return argv.length > 0 && parsed.command === null ? 2 : 0;
  }
  if (parsed.unknownFlags.length > 0) {
    output.error(`unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    output.note('Run: agent-context --help');
    return 2;
  }

  const dependencies: CliDependencies = {
    createContext: async (options) => AgentContext.load(options),
  };
  const commandContext: CliCommandContext = { parsed, output, io, json: flagBoolean(parsed, 'json') };

  try {
    switch (parsed.command) {
      case 'init':
        return await runInitCommand(commandContext, dependencies);
      case 'scan':
        return await runScanCommand(commandContext, dependencies);
      case 'diff':
        return await runDiffCommand(commandContext, dependencies);
      case 'status':
        return await runStatusCommand(commandContext, dependencies);
      case 'explain':
        return await runExplainCommand(commandContext, dependencies);
      case 'search':
        return await runSearchCommand(commandContext, dependencies);
      case 'context':
        return await runContextCommand(commandContext, dependencies);
      case 'task':
        return await runTaskCommand(commandContext, dependencies);
      case 'impact':
        return await runImpactCommand(commandContext, dependencies);
      case 'history':
        return await runHistoryCommand(commandContext, dependencies);
      case 'revision-diff':
        return await runRevisionDiffCommand(commandContext, dependencies);
      case 'clean':
        return await runCleanCommand(commandContext, dependencies);
      default:
        output.error(`unknown command: ${parsed.command}`);
        output.note('Run: agent-context --help');
        return 2;
    }
  } catch (error) {
    const payload = toDiagnosticPayload(error);
    output.error(payload.message);
    if (isAgentContextError(error)) {
      for (const hint of error.hints) output.note(`  ${hint}`);
    }
    if (output.verbose && error instanceof Error && error.stack !== undefined) output.note(error.stack);
    return 1;
  }
}