/**
 * Organization-owned analysis policy.
 *
 * A repository's own `.agent/config.json` is written by whoever works on it, so
 * on its own it cannot express a rule an organization must enforce: nothing stops
 * a contributor from setting `security.allowSensitiveFiles` to `true`, or from
 * dropping a directory from `exclude`. The policy file is the floor beneath the
 * repository configuration — it can only tighten things, never loosen them.
 *
 * The file is found in this order:
 *
 * 1. the path in `AGENT_CONTEXT_POLICY` (absolute or relative to the root);
 * 2. `.agent-policy.json` in the repository root;
 * 3. `.agent-policy.json` in each parent directory up to the filesystem root.
 *
 * Walking up is deliberate: a policy committed at a monorepo or organization
 * checkout applies to every repository underneath it without being copied into
 * each one. A repository may still add its own exclusions and sensitive patterns
 * on top — the policy is a floor, not a replacement.
 *
 * Shape (the patterns below are illustrative; globs support the usual `star-star`
 * prefix, which is omitted here because a literal double-star followed by a
 * slash would terminate this comment):
 *
 * ```json
 * {
 *   "version": 1,
 *   "exclude": ["vendor/private", "internal/legacy"],
 *   "sensitive": ["*.tfvars", "service-account.json"],
 *   "allowSensitiveFiles": false,
 *   "redactSecrets": true,
 *   "readOnly": false
 * }
 * ```
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentContextConfig, LoadedConfig } from './types.ts';
import { ConfigError } from '../errors.ts';

/** Default file name looked up in the root and every parent directory. */
export const POLICY_FILE = '.agent-policy.json';

export const POLICY_VERSION = 1;

export interface OrganizationPolicy {
  /** Version of the policy document itself. */
  version: number;
  /** Glob patterns no repository may analyze. Unioned with the repo's `exclude`. */
  exclude: string[];
  /** Glob patterns treated as sensitive. Unioned with `extraSensitivePatterns`. */
  sensitive: string[];
  /**
   * When `false` here, `allowSensitiveFiles` is forced off regardless of what
   * the repository asks for. Omitted means "do not constrain".
   */
  allowSensitiveFiles?: boolean;
  /**
   * When `true`, secret redaction is forced on. Omitted means "do not
   * constrain". `false` is rejected: a policy cannot waive redaction.
   */
  redactSecrets?: boolean;
  /** When `true` here, the repository is read-only: scan and init are refused. */
  readOnly?: boolean;
}

export interface ResolvedPolicy {
  policy: OrganizationPolicy | null;
  /** Path the policy was read from, or `null` when none applied. */
  source: string | null;
  /** Non-fatal notes, surfaced by the CLI as warnings. */
  warnings: string[];
}

const EMPTY_POLICY: OrganizationPolicy = {
  version: POLICY_VERSION,
  exclude: [],
  sensitive: [],
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Parses a policy document, rejecting anything it cannot enforce unambiguously. */
export function parsePolicy(text: string, source: string): { policy: OrganizationPolicy; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(`Cannot parse organization policy ${source}: ${error instanceof Error ? error.message : String(error)}`, [
      'The policy file must be valid JSON.',
    ]);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`Organization policy ${source} must be a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  const version = record['version'];
  if (version !== POLICY_VERSION) {
    // An unknown version must not be silently ignored: a policy that fails to
    // apply is indistinguishable from one that does not exist.
    throw new ConfigError(
      `Organization policy ${source} has version ${String(version)}, but only version ${POLICY_VERSION} is supported.`,
      ['Update the tool, or pin the policy to a supported version.'],
    );
  }
  for (const key of ['exclude', 'sensitive'] as const) {
    const value = record[key];
    if (value !== undefined && !isStringArray(value)) {
      throw new ConfigError(`Organization policy ${source}: "${key}" must be an array of strings.`);
    }
  }
  for (const key of ['allowSensitiveFiles', 'redactSecrets', 'readOnly'] as const) {
    const value = record[key];
    if (value !== undefined && !isBoolean(value)) {
      throw new ConfigError(`Organization policy ${source}: "${key}" must be a boolean.`);
    }
  }
  const policy: OrganizationPolicy = {
    version: POLICY_VERSION,
    exclude: (record['exclude'] as string[] | undefined) ?? [],
    sensitive: (record['sensitive'] as string[] | undefined) ?? [],
  };
  if (isBoolean(record['allowSensitiveFiles'])) policy.allowSensitiveFiles = record['allowSensitiveFiles'];
  if (isBoolean(record['redactSecrets'])) policy.redactSecrets = record['redactSecrets'];
  if (isBoolean(record['readOnly'])) policy.readOnly = record['readOnly'];
  // Turning redaction off would copy secret material into a file people commit
  // and share. An organization policy may require it; it may never waive it.
  if (policy.redactSecrets === false) {
    throw new ConfigError(`Organization policy ${source}: "redactSecrets" cannot be disabled by a policy.`, [
      'A policy can require redaction (true) or leave it unconstrained (omit the key).',
    ]);
  }
  for (const key of Object.keys(record)) {
    if (!['version', 'exclude', 'sensitive', 'allowSensitiveFiles', 'redactSecrets', 'readOnly'].includes(key)) {
      warnings.push(`organization policy ${source}: unknown key "${key}" ignored`);
    }
  }
  return { policy, warnings };
}

/** Locates the nearest policy file by walking up from `root`. */
export function findPolicyFile(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['AGENT_CONTEXT_POLICY'];
  if (explicit !== undefined && explicit.length > 0) {
    const resolved = path.resolve(root, explicit);
    return existsSync(resolved) ? resolved : null;
  }
  let directory = path.resolve(root);
  for (;;) {
    const candidate = path.join(directory, POLICY_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Reads the nearest policy, or returns `null` when the repository has none. */
export async function loadPolicy(root: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedPolicy> {
  const file = findPolicyFile(root, env);
  if (file === null) return { policy: null, source: null, warnings: [] };
  const text = await readFile(file, 'utf8');
  const source = path.relative(path.resolve(root), file).split(path.sep).join('/') || POLICY_FILE;
  const parsed = parsePolicy(text, source);
  return { policy: parsed.policy, source, warnings: parsed.warnings };
}

/**
 * Applies the policy to a resolved configuration.
 *
 * Only tightening is possible. The policy's patterns are unioned in, and its
 * boolean switches are ANDed with the repository's, so a repository that asks
 * for `allowSensitiveFiles: true` under a policy that forbids it is overridden.
 */
export function applyPolicy(config: AgentContextConfig, resolved: ResolvedPolicy): AgentContextConfig {
  const policy = resolved.policy;
  if (policy === null) return config;

  const exclude = [...new Set([...config.exclude, ...policy.exclude])];
  const extraSensitivePatterns = [...new Set([...config.security.extraSensitivePatterns, ...policy.sensitive])];
  const allowSensitiveFiles =
    policy.allowSensitiveFiles === false ? false : config.security.allowSensitiveFiles;
  // Redaction is a floor, not a dial: a policy may require it, and no policy
  // may switch it off. `parsePolicy` rejects `redactSecrets: false` outright.
  const redactSecrets = policy.redactSecrets === true ? true : config.security.redactSecrets;
  const readOnly = policy.readOnly === true ? true : config.security.readOnly;

  return {
    ...config,
    exclude,
    security: { ...config.security, allowSensitiveFiles, redactSecrets, extraSensitivePatterns, readOnly },
  };
}

/** Policy path included in the configuration hash, so a policy change invalidates the cache. */
export function policyIdentity(resolved: ResolvedPolicy): string {
  return resolved.policy === null ? 'policy:none' : `policy:${resolved.source ?? POLICY_FILE}:${JSON.stringify(resolved.policy)}`;
}

/** Applies the policy to a loaded config and folds it into the cache hash. */
export function enforcePolicy(loaded: LoadedConfig, resolved: ResolvedPolicy): LoadedConfig {
  return {
    ...loaded,
    config: applyPolicy(loaded.config, resolved),
    policySource: resolved.source,
    hash: `${loaded.hash}:${policyIdentity(resolved)}`,
    warnings: [...loaded.warnings, ...resolved.warnings],
  };
}

export { EMPTY_POLICY };