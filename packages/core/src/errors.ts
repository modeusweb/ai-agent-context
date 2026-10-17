/**
 * Error model of the package.
 *
 * Every error carries a stable machine-readable `code`, a human readable
 * message and at least one actionable hint, so the CLI can print guidance such
 * as:
 *
 * ```text
 * Cannot analyze repository:
 *   TypeScript project detected but tsconfig.json is invalid.
 *
 * Run:
 *   agent-context status
 * ```
 */
import type { DiagnosticPayload } from './model/types.ts';

export interface AgentContextErrorOptions {
  code: string;
  message: string;
  hints?: string[];
  cause?: unknown;
  source?: string;
}

export class AgentContextError extends Error {
  readonly code: string;
  readonly hints: string[];
  readonly source?: string;

  constructor(options: AgentContextErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentContextError';
    this.code = options.code;
    this.hints = options.hints ?? [];
    if (options.source !== undefined) this.source = options.source;
  }

  toJSON(): DiagnosticPayload {
    const payload: DiagnosticPayload = {
      code: this.code,
      severity: 'error',
      message: this.message,
    };
    if (this.source !== undefined) payload.source = this.source;
    if (this.hints.length > 0) payload.hint = this.hints[0];
    return payload;
  }
}

/** Invalid `agent-context` configuration. */
export class ConfigError extends AgentContextError {
  constructor(message: string, hints: string[] = ['Fix .agent/config.json or pass CLI flags to override it.'], cause?: unknown) {
    super({ code: 'ERR_CONFIG', message, hints, cause });
    this.name = 'ConfigError';
  }
}

/** Repository level analysis failure (not a per-file parse failure). */
export class AnalysisError extends AgentContextError {
  constructor(message: string, hints: string[] = ['Run: agent-context status'], cause?: unknown, source?: string) {
    super({ code: 'ERR_ANALYSIS', message, hints, cause, source });
    this.name = 'AnalysisError';
  }
}

/** `.agent/` is missing or has an unsupported schema version. */
export class ContextStateError extends AgentContextError {
  constructor(message: string, hints: string[] = ['Run: agent-context scan'], cause?: unknown) {
    super({ code: 'ERR_CONTEXT_STATE', message, hints, cause });
    this.name = 'ContextStateError';
  }
}

/** Raised by adapters when an optional capability is unavailable (git, fs). */
export class AdapterUnavailableError extends AgentContextError {
  constructor(message: string, hints: string[] = [], cause?: unknown) {
    super({ code: 'ERR_ADAPTER_UNAVAILABLE', message, hints, cause });
    this.name = 'AdapterUnavailableError';
  }
}

/**
 * Raised when a write is attempted while the read-only contract is in force.
 *
 * The contract is about the whole tool, not one command: an MCP server started
 * against a repository whose policy sets `readOnly` must not be able to write,
 * whichever code path asks. Queries keep working — only writes are refused.
 */
export class ReadOnlyError extends AgentContextError {
  constructor(operation: string, source?: string) {
    super({
      code: 'ERR_READ_ONLY',
      message: `Refusing to ${operation}: this repository is in read-only mode.`,
      hints: [
        'Queries (status, explain, context, task, impact, search, detect, verify) keep working.',
        'Disable "security.readOnly" in .agent/config.json, or in the organization policy that sets it, to allow writes.',
        ...(source === undefined ? [] : [`Enforced by ${source}.`]),
      ],
      ...(source === undefined ? {} : { source }),
    });
    this.name = 'ReadOnlyError';
  }
}

export function isAgentContextError(error: unknown): error is AgentContextError {
  return error instanceof AgentContextError;
}

/** Converts any thrown value into a printable diagnostic payload. */
export function toDiagnosticPayload(error: unknown): DiagnosticPayload {
  if (isAgentContextError(error)) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'ERR_UNEXPECTED', severity: 'error', message };
}
