/**
 * Schema constants for the versioned `.agent/` context format.
 *
 * The format is explicit about its version so that consumers (CLI, MCP adapters,
 * agents, humans reading the JSON) can detect incompatible layouts.
 */

/** Current schema version of every file written into `.agent/`. */
export const SCHEMA_VERSION = 1;

export const GENERATOR_NAME = 'ai-agent-context';

/** Directory that stores the versioned, committable context. */
export const AGENT_DIR = '.agent';

/** Directory inside `.agent/` that stores local (gitignored) state and caches. */
export const LOCAL_DIR = '.local';

/** Config file path, relative to the repository root. */
export const CONFIG_FILE = `${AGENT_DIR}/config.json`;

export const CACHE_DIR = `${AGENT_DIR}/${LOCAL_DIR}/cache`;

export const STATE_FILE = `${AGENT_DIR}/${LOCAL_DIR}/state.json`;

/** Canonical generated context files. Order is the documented output order. */
export const CONTEXT_FILES = [
  'index.json',
  'architecture.json',
  'dependencies.json',
  'conventions.json',
  'conventions.md',
  'decisions.json',
] as const;

export type ContextFile = (typeof CONTEXT_FILES)[number];

/** Content written into `.agent/.gitignore` so the local cache is never committed. */
export const AGENT_GITIGNORE = `# Local, machine-specific state and caches (never committed).\n.local/\n`;

/** Confidence values reported when a signal is conclusive. */
export const CONFIDENCE = {
  /** Structural facts from configuration files, e.g. package.json `main`. */
  declared: 0.99,
  /** Direct observation across many files, e.g. all classes are PascalCase. */
  strong: 0.88,
  /** Multiple independent signals agree. */
  medium: 0.72,
  /** A single, weaker signal. */
  weak: 0.52,
  /** Mentioned only for completeness; needs human verification. */
  speculative: 0.3,
} as const;

export type ConfidenceLevel = keyof typeof CONFIDENCE;
