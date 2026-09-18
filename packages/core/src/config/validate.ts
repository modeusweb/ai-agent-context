/**
 * Hand-written validation.
 *
 * No runtime schema library is used on purpose: the package ships zero runtime
 * dependencies, and validation errors must read like instructions, e.g.
 *
 * ```text
 * .agent/config.json: "analysis.moduleDepth" must be an integer (received: string "two")
 * ```
 */
import { ConfigError } from '../errors.ts';
import type {
  AgentContextConfig,
  AnalysisConfig,
  FeaturesConfig,
  GitAnalysisConfig,
  OutputConfig,
  SecurityConfig,
} from './types.ts';
import { DEFAULT_CONFIG } from './defaults.ts';

type Raw = Record<string, unknown>;

const KNOWN_KEYS = new Set([
  'version',
  'root',
  'include',
  'exclude',
  'ignore',
  'languages',
  'features',
  'analysis',
  'output',
  'security',
]);

const FEATURE_KEYS: Array<keyof FeaturesConfig> = [
  'architecture',
  'dependencies',
  'conventions',
  'decisions',
  'git',
  'search',
];

function isPlainObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return `${typeof value} ${JSON.stringify(value)}`.trim();
}

function strings(value: unknown, path: string, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${source}: "${path}" must be an array of glob patterns (received: ${describe(value)})`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ConfigError(`${source}: "${path}[${index}]" must be a string (received: ${describe(entry)})`);
    }
    return entry;
  });
}

function bool(value: unknown, path: string, source: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(`${source}: "${path}" must be a boolean (received: ${describe(value)})`);
  return value;
}

function integer(value: unknown, path: string, source: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${source}: "${path}" must be an integer (received: ${describe(value)})`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${source}: "${path}" must be between ${min} and ${max} (received: ${value})`);
  }
  return value;
}

function text(value: unknown, path: string, source: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${source}: "${path}" must be a string (received: ${describe(value)})`);
  return value;
}

function object(value: unknown, path: string, source: string): Raw {
  if (!isPlainObject(value)) throw new ConfigError(`${source}: "${path}" must be an object (received: ${describe(value)})`);
  return value;
}

export interface ValidatedConfig {
  config: AgentContextConfig;
  warnings: string[];
}

/**
 * Validates raw configuration JSON against the documented schema.
 *
 * Unknown keys produce warnings (forward compatibility) while invalid types
 * raise {@link ConfigError}.
 */
export function validateConfig(raw: unknown, source = '.agent/config.json'): ValidatedConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${source}: expected a JSON object at the top level (received: ${describe(raw)})`, [
      'Run: agent-context init --force to regenerate a valid configuration.',
    ]);
  }
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${source}: unknown key "${key}" is ignored`);
  }

  const config: AgentContextConfig = structuredClone(DEFAULT_CONFIG);

  if (raw.version !== undefined) config.version = integer(raw.version, 'version', source, 1, 1000);
  if (raw.root !== undefined) config.root = text(raw.root, 'root', source);
  if (raw.include !== undefined) config.include = strings(raw.include, 'include', source);
  if (raw.exclude !== undefined) config.exclude = strings(raw.exclude, 'exclude', source);
  if (raw.ignore !== undefined) config.ignore = strings(raw.ignore, 'ignore', source);
  if (raw.languages !== undefined) {
    config.languages = strings(raw.languages, 'languages', source).map((entry) => entry.trim().toLowerCase());
  }

  if (raw.features !== undefined) {
    const rawFeatures = object(raw.features, 'features', source);
    const features: FeaturesConfig = { ...config.features };
    for (const key of FEATURE_KEYS) {
      const value = rawFeatures[key];
      if (value !== undefined) features[key] = bool(value, `features.${key}`, source);
    }
    for (const key of Object.keys(rawFeatures)) {
      if (!FEATURE_KEYS.includes(key as keyof FeaturesConfig)) {
        warnings.push(`${source}: unknown feature "${key}" is ignored`);
      }
    }
    config.features = features;
  }

  if (raw.analysis !== undefined) {
    const rawAnalysis = object(raw.analysis, 'analysis', source);
    const analysis: AnalysisConfig = { ...config.analysis };
    if (rawAnalysis.moduleDepth !== undefined) {
      analysis.moduleDepth = integer(rawAnalysis.moduleDepth, 'analysis.moduleDepth', source, 1, 10);
    }
    if (rawAnalysis.concurrency !== undefined) {
      analysis.concurrency = integer(rawAnalysis.concurrency, 'analysis.concurrency', source, 0, 128);
    }
    if (rawAnalysis.maxFileSizeBytes !== undefined) {
      analysis.maxFileSizeBytes = integer(rawAnalysis.maxFileSizeBytes, 'analysis.maxFileSizeBytes', source, 1024, 1_073_741_824);
    }
    if (rawAnalysis.followSymlinks !== undefined) {
      analysis.followSymlinks = bool(rawAnalysis.followSymlinks, 'analysis.followSymlinks', source);
    }
    if (rawAnalysis.sourceRoots !== undefined) {
      analysis.sourceRoots = strings(rawAnalysis.sourceRoots, 'analysis.sourceRoots', source);
    }
    if (rawAnalysis.git !== undefined) {
      const rawGit = object(rawAnalysis.git, 'analysis.git', source);
      const git: GitAnalysisConfig = { ...analysis.git };
      if (rawGit.windowDays !== undefined) git.windowDays = integer(rawGit.windowDays, 'analysis.git.windowDays', source, 1, 3650);
      if (rawGit.maxCommits !== undefined) {
        git.maxCommits = integer(rawGit.maxCommits, 'analysis.git.maxCommits', source, 1, 1_000_000);
      }
      if (rawGit.recentDays !== undefined) git.recentDays = integer(rawGit.recentDays, 'analysis.git.recentDays', source, 1, 3650);
      if (rawGit.architectureSignalPatterns !== undefined) {
        git.architectureSignalPatterns = strings(
          rawGit.architectureSignalPatterns,
          'analysis.git.architectureSignalPatterns',
          source,
        );
      }
      analysis.git = git;
    }
    config.analysis = analysis;
  }

  if (raw.output !== undefined) {
    const rawOutput = object(raw.output, 'output', source);
    const output: OutputConfig = { ...config.output };
    if (rawOutput.includeTimestamp !== undefined) {
      output.includeTimestamp = bool(rawOutput.includeTimestamp, 'output.includeTimestamp', source);
    }
    if (rawOutput.prettyJson !== undefined) output.prettyJson = bool(rawOutput.prettyJson, 'output.prettyJson', source);
    if (rawOutput.conventionsMarkdown !== undefined) {
      output.conventionsMarkdown = bool(rawOutput.conventionsMarkdown, 'output.conventionsMarkdown', source);
    }
    config.output = output;
  }

  if (raw.security !== undefined) {
    const rawSecurity = object(raw.security, 'security', source);
    const security: SecurityConfig = { ...config.security };
    if (rawSecurity.allowSensitiveFiles !== undefined) {
      security.allowSensitiveFiles = bool(rawSecurity.allowSensitiveFiles, 'security.allowSensitiveFiles', source);
    }
    if (rawSecurity.redactSecrets !== undefined) {
      security.redactSecrets = bool(rawSecurity.redactSecrets, 'security.redactSecrets', source);
    }
    if (rawSecurity.extraSensitivePatterns !== undefined) {
      security.extraSensitivePatterns = strings(
        rawSecurity.extraSensitivePatterns,
        'security.extraSensitivePatterns',
        source,
      );
    }
    config.security = security;
  }

  return { config, warnings };
}

/** Parses configuration text, translating JSON syntax errors into ConfigError. */
export function parseConfigText(contents: string, source = '.agent/config.json'): ValidatedConfig {
  try {
    return validateConfig(JSON.parse(contents) as unknown, source);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `${source}: invalid JSON (${message})`,
      ['Run: agent-context init --force to regenerate the configuration.'],
      error,
    );
  }
}
