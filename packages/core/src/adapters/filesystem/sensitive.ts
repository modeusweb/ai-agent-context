/**
 * Secret handling.
 *
 * Two guarantees:
 * 1. Sensitive *files* are never read (`.env`, keys, certificates, credentials).
 * 2. Any text copied into the generated context (ADR excerpts, commit subjects)
 *    is passed through {@link redactSecrets} first, so a secret accidentally
 *    committed to the repository cannot leak into `.agent/`.
 *
 * The package performs no network calls and sends nothing anywhere.
 */
import { PatternSet } from '../../util/glob.ts';
import { DEFAULT_SENSITIVE_PATTERNS } from '../../config/defaults.ts';

export const REDACTED = '[REDACTED]';

interface SecretPattern {
  name: string;
  regex: RegExp;
}

/** Value-level patterns used to detect and redact secret material. */
export const SECRET_VALUE_PATTERNS: SecretPattern[] = [
  { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'assigned-secret',
    regex: /\b(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{8,})["']?/gi,
  },
  { name: 'openai-key', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github-token', regex: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g },
  { name: 'aws-access-key', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'credentials-in-url', regex: /\/\/[A-Za-z0-9._%-]+:[^\s@/]+@/g },
];

/** `true` when the text appears to contain secret material. */
export function containsSecret(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(text);
  });
}

/** Replaces secret-looking values with `[REDACTED]`, keeping the surrounding text. */
export function redactSecrets(text: string): string {
  let output = text;
  output = output.replace(SECRET_VALUE_PATTERNS[0]!.regex, `${REDACTED} private key`);
  output = output.replace(SECRET_VALUE_PATTERNS[1]!.regex, (_match, key: string) => `${key}: "${REDACTED}"`);
  for (const pattern of SECRET_VALUE_PATTERNS.slice(2, 8)) {
    output = output.replace(pattern.regex, REDACTED);
  }
  output = output.replace(SECRET_VALUE_PATTERNS[8]!.regex, `//${REDACTED}@`);
  return output;
}

export interface SensitiveFilterOptions {
  allowSensitiveFiles: boolean;
  extraSensitivePatterns?: string[];
}

/** Path-level filter; checked before any file content is read. */
export class SensitivePathFilter {
  private readonly patterns: PatternSet;
  private readonly allow: boolean;

  constructor(options: SensitiveFilterOptions) {
    this.allow = options.allowSensitiveFiles;
    this.patterns = new PatternSet([...DEFAULT_SENSITIVE_PATTERNS, ...(options.extraSensitivePatterns ?? [])]);
  }

  /** `true` when the file must not be read. */
  isBlocked(relativePath: string): boolean {
    if (this.allow) return false;
    return this.patterns.test(relativePath, false);
  }

  toArray(): string[] {
    return this.patterns.toArray();
  }
}