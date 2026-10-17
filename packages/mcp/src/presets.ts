/**
 * Configuration presets for the MCP clients this server is expected to work with.
 *
 * Every MCP client stores servers differently — some take an object keyed by
 * name, Continue takes an array — and each one expects the entry in a specific
 * file. Getting that wrong is the most common reason a working server appears
 * broken, so the shapes are encoded here once and rendered per client.
 *
 * The command is parameterised because the published package is usually run
 * through `npx`, while a local checkout is run through `node <path>/bin.js`.
 */

export type ClientPresetId = 'claude-code' | 'cursor' | 'cline' | 'continue';

export interface ClientPreset {
  id: ClientPresetId;
  label: string;
  /** Where the client reads server definitions from. */
  configFile: string;
  /** Whether the client expects an object keyed by server name or an array. */
  format: 'object' | 'array';
  /** Extra client-specific keys merged into the server entry. */
  extras?: Record<string, unknown>;
  /** Notes worth printing with the snippet. */
  notes: string[];
}

export const CLIENT_PRESETS: readonly ClientPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    configFile: '.mcp.json',
    format: 'object',
    notes: [
      'Project-scoped: .mcp.json is committed and shared with the team.',
      'Equivalent command: claude mcp add agent-context -- npx -y @ai-agent-context/mcp --root <path>',
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configFile: '.cursor/mcp.json',
    format: 'object',
    notes: ['Cursor reads this file from the project root.'],
  },
  {
    id: 'cline',
    label: 'Cline (VS Code)',
    configFile: 'cline_mcp_settings.json',
    format: 'object',
    extras: { disabled: false, autoApprove: [] },
    notes: [
      'Merge the entry into an existing cline_mcp_settings.json rather than replacing the file.',
      'autoApprove is intentionally empty: every tool reads the repository, so approve per use.',
    ],
  },
  {
    id: 'continue',
    label: 'Continue',
    configFile: '~/.continue/config.json',
    format: 'array',
    notes: ['Continue takes an array of servers; append to the existing mcpServers list.'],
  },
];

export interface RenderOptions {
  /** Repository the server should analyze. */
  root: string;
  /** Executable that starts the server. Defaults to npx against the published package. */
  command?: string;
  /** Extra arguments inserted before `--root`. */
  commandArgs?: readonly string[];
  /** Server name as it appears in the client UI. */
  name?: string;
}

const DEFAULT_COMMAND = 'npx';
const DEFAULT_COMMAND_ARGS: readonly string[] = ['-y', '@ai-agent-context/mcp'];

export function presetById(id: string): ClientPreset | undefined {
  return CLIENT_PRESETS.find((preset) => preset.id === id);
}

/** Argument vector that starts the server against `root`. */
export function serverArgv(options: RenderOptions): string[] {
  const commandArgs = options.commandArgs ?? DEFAULT_COMMAND_ARGS;
  return [...commandArgs, '--root', options.root];
}

interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * Renders the configuration snippet for one client.
 *
 * The output is the value of the client's `mcpServers` field, not a whole
 * config file: every one of these files also carries unrelated settings, and
 * overwriting them would destroy the user's configuration.
 */
export function renderPreset(preset: ClientPreset, options: RenderOptions): string {
  const name = options.name ?? 'agent-context';
  const entry: ServerEntry = {
    command: options.command ?? DEFAULT_COMMAND,
    args: serverArgv(options),
  };
  const payload: Record<string, unknown> = { ...entry, ...(preset.extras ?? {}) };
  const value = preset.format === 'array' ? [{ name, ...payload }] : { [name]: payload };
  return JSON.stringify({ mcpServers: value }, null, 2);
}

/** Every preset, rendered for the same root — the "show me the options" case. */
export function renderAllPresets(options: RenderOptions): string {
  return CLIENT_PRESETS.map((preset) => {
    const notes = preset.notes.map((note) => `  # ${note}`).join('\n');
    return `# ${preset.label} — ${preset.configFile}\n${notes}\n${renderPreset(preset, options)}`;
  }).join('\n\n');
}