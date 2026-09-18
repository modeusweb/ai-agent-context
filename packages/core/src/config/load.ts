/**
 * Configuration loading and merging.
 *
 * Precedence (highest first):
 * 1. CLI flags (`ConfigOverrides`)
 * 2. `.agent/config.json`
 * 3. built-in defaults
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.ts';
import { hashValue, stringifyCanonical } from '../model/canonical.ts';
import { AGENT_DIR, CONFIG_FILE } from '../model/schema.ts';
import { DEFAULT_CONFIG } from './defaults.ts';
import { parseConfigText, validateConfig } from './validate.ts';
import type { AgentContextConfig, ConfigOverrides, LoadedConfig } from './types.ts';

/** Deep merge of CLI overrides on top of a resolved configuration. */
export function applyOverrides(config: AgentContextConfig, overrides: ConfigOverrides | undefined): AgentContextConfig {
  if (!overrides) return config;
  const merged: AgentContextConfig = {
    ...config,
    include: overrides.include ?? config.include,
    exclude: overrides.exclude ?? config.exclude,
    ignore: overrides.ignore ?? config.ignore,
    languages: overrides.languages ?? config.languages,
    features: { ...config.features, ...(overrides.features ?? {}) },
    analysis: {
      ...config.analysis,
      ...(overrides.analysis ?? {}),
      git: { ...config.analysis.git, ...(overrides.analysis?.git ?? {}) },
    },
    output: { ...config.output, ...(overrides.output ?? {}) },
    security: { ...config.security, ...(overrides.security ?? {}) },
  };
  if (overrides.root !== undefined) merged.root = overrides.root;
  return merged;
}

/** Validation of the merged result (guards against contradictory overrides). */
export function validateMerged(config: AgentContextConfig): string[] {
  const warnings: string[] = [];
  if (config.include.length === 0) {
    warnings.push('include patterns are empty: no files will be analyzed');
  }
  if (config.languages.length === 0) {
    warnings.push('no languages configured: no source files will be parsed');
  }
  if (config.analysis.moduleDepth < 1) {
    throw new ConfigError('analysis.moduleDepth must be >= 1', ['Set moduleDepth to at least 1 in .agent/config.json.']);
  }
  return warnings;
}

export interface LoadConfigOptions {
  /** Repository root (absolute or relative to `process.cwd()`). */
  root: string;
  /** CLI overrides; take precedence over the config file. */
  overrides?: ConfigOverrides;
  /** Explicit config file path. Defaults to `<root>/.agent/config.json`. */
  configPath?: string;
  /** Skip reading the config file entirely (used by `init`). */
  ignoreFile?: boolean;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const root = path.resolve(options.root);
  const configPath = options.configPath ? path.resolve(options.configPath) : path.join(root, CONFIG_FILE);
  const warnings: string[] = [];
  let fileConfig: AgentContextConfig = structuredClone(DEFAULT_CONFIG);
  let source: string | null = null;

  if (!options.ignoreFile && existsSync(configPath)) {
    source = path.relative(root, configPath).split(path.sep).join('/');
    const text = await readFile(configPath, 'utf8');
    const validated = parseConfigText(text, source);
    fileConfig = validated.config;
    warnings.push(...validated.warnings);
  }

  const config = applyOverrides(fileConfig, options.overrides);
  warnings.push(...validateMerged(config));
  // Note: `root` is intentionally excluded from the hash — moving a repository
  // must not invalidate the local cache.
  const hash = hashValue({ ...config, root: '.' });
  return { config, source, hash, warnings };
}

/** Synchronous config resolution for CLI startup paths that must not await. */
export function resolveConfigSync(root: string, overrides?: ConfigOverrides, configText?: string): LoadedConfig {
  const configPath = path.join(path.resolve(root), CONFIG_FILE);
  const warnings: string[] = [];
  let fileConfig: AgentContextConfig = structuredClone(DEFAULT_CONFIG);
  let source: string | null = null;
  if (configText !== undefined) {
    source = path.relative(root, configPath).split(path.sep).join('/');
    const validated = parseConfigText(configText, source);
    fileConfig = validated.config;
    warnings.push(...validated.warnings);
  }
  const config = applyOverrides(fileConfig, overrides);
  warnings.push(...validateMerged(config));
  return { config, source, hash: hashValue({ ...config, root: '.' }), warnings };
}

/** Validates an already parsed configuration object (used by tests and adapters). */
export function normalizeConfig(raw: unknown): AgentContextConfig {
  return validateConfig(raw).config;
}

/** Writes `.agent/config.json`, creating `.agent/` when necessary. */
export async function writeConfigFile(root: string, config: AgentContextConfig, pretty = true): Promise<string> {
  const agentDir = path.join(root, AGENT_DIR);
  await mkdir(agentDir, { recursive: true });
  const target = path.join(root, CONFIG_FILE);
  await writeFile(target, stringifyCanonical(config, pretty), 'utf8');
  return target;
}

/** Configuration template written by `agent-context init` (documented in the README). */
export function initConfigTemplate(): AgentContextConfig {
  return structuredClone(DEFAULT_CONFIG);
}
