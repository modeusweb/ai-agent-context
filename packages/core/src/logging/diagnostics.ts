/**
 * Diagnostics and logging.
 *
 * A single unparsable file produces a warning and analysis continues; only
 * repository-level problems raise {@link AgentContextError}. Both surfaces are
 * collected in a {@link DiagnosticsCollector} that the CLI can print (verbose
 * mode) or serialize (`--json`).
 */
import type { DiagnosticPayload } from '../model/types.ts';
import { compareStrings } from '../model/canonical.ts';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose';

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, verbose: 4 };

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
}

/** Structured progress logger; writes to a sink so the CLI owns the formatting. */
export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  get currentLevel(): LogLevel {
    return this.level;
  }

  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_ORDER[this.level] >= LEVEL_ORDER[level];
  }

  log(level: Exclude<LogLevel, 'silent'>, message: string): void {
    if (!this.enabled(level)) return;
    this.sink(message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  warn(message: string): void {
    this.log('warn', `warning: ${message}`);
  }

  info(message: string): void {
    this.log('info', message);
  }

  verbose(message: string): void {
    this.log('verbose', `debug: ${message}`);
  }
}

export const silentLogger = new Logger({ level: 'silent' });

export interface DiagnosticsCollectorOptions {
  logger?: Logger;
}

/** Collects warnings/errors produced during analysis. */
export class DiagnosticsCollector {
  private readonly items: DiagnosticPayload[] = [];
  private readonly logger: Logger;

  constructor(options: DiagnosticsCollectorOptions = {}) {
    this.logger = options.logger ?? silentLogger;
  }

  add(payload: DiagnosticPayload): void {
    this.items.push(payload);
    if (payload.severity === 'error') this.logger.error(payload.message);
    else if (payload.severity === 'warning') this.logger.warn(payload.message);
    else this.logger.verbose(payload.message);
  }

  warn(code: string, message: string, options: { source?: string; hint?: string } = {}): void {
    const payload: DiagnosticPayload = { code, severity: 'warning', message };
    if (options.source !== undefined) payload.source = options.source;
    if (options.hint !== undefined) payload.hint = options.hint;
    this.add(payload);
  }

  info(code: string, message: string, options: { source?: string; hint?: string } = {}): void {
    const payload: DiagnosticPayload = { code, severity: 'info', message };
    if (options.source !== undefined) payload.source = options.source;
    if (options.hint !== undefined) payload.hint = options.hint;
    this.add(payload);
  }

  error(code: string, message: string, options: { source?: string; hint?: string } = {}): void {
    const payload: DiagnosticPayload = { code, severity: 'error', message };
    if (options.source !== undefined) payload.source = options.source;
    if (options.hint !== undefined) payload.hint = options.hint;
    this.add(payload);
  }

  /** Deterministically ordered diagnostics. */
  list(): DiagnosticPayload[] {
    return [...this.items].sort(
      (a, b) =>
        compareStrings(a.code, b.code) ||
        compareStrings(a.source ?? '', b.source ?? '') ||
        compareStrings(a.message, b.message),
    );
  }

  warnings(): DiagnosticPayload[] {
    return this.list().filter((item) => item.severity === 'warning');
  }

  errors(): DiagnosticPayload[] {
    return this.list().filter((item) => item.severity === 'error');
  }

  get count(): number {
    return this.items.length;
  }
}

export interface ProgressEvent {
  phase: string;
  message: string;
  completed?: number;
  total?: number;
}

export type ProgressReporter = (event: ProgressEvent) => void;
