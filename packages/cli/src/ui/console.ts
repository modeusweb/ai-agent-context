/**
 * Console primitives for the CLI.
 *
 * - colours are disabled automatically when not a TTY, when `NO_COLOR` is set or
 *   when `--no-color` is passed;
 * - progress output goes to stderr so that `--json` output on stdout stays
 *   machine-readable;
 * - `quiet` mode silences everything except the final result.
 */
export interface ConsoleOptions {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export class ConsoleOutput {
  private readonly options: ConsoleOptions;

  constructor(options: ConsoleOptions) {
    this.options = options;
  }

  get quiet(): boolean {
    return this.options.quiet;
  }

  get verbose(): boolean {
    return this.options.verbose;
  }

  get supportsColor(): boolean {
    return this.options.color;
  }

  private paint(code: keyof typeof CODES, text: string): string {
    return this.options.color ? `${CODES[code]}${text}${CODES.reset}` : text;
  }

  bold(text: string): string {
    return this.paint('bold', text);
  }

  dim(text: string): string {
    return this.paint('dim', text);
  }

  red(text: string): string {
    return this.paint('red', text);
  }

  green(text: string): string {
    return this.paint('green', text);
  }

  yellow(text: string): string {
    return this.paint('yellow', text);
  }

  blue(text: string): string {
    return this.paint('blue', text);
  }

  cyan(text: string): string {
    return this.paint('cyan', text);
  }

  gray(text: string): string {
    return this.paint('gray', text);
  }

  /** User facing output (stdout). */
  print(line = ''): void {
    this.options.stdout(line);
  }

  /** Diagnostic/progress output (stderr). */
  note(line: string): void {
    if (this.options.quiet) return;
    this.options.stderr(line);
  }

  debug(line: string): void {
    if (!this.options.verbose) return;
    this.options.stderr(this.dim(line));
  }

  warn(line: string): void {
    this.options.stderr(`${this.yellow('\u26a0')} ${line}`);
  }

  error(line: string): void {
    this.options.stderr(`${this.red('\u2717')} ${line}`);
  }

  success(line: string): void {
    if (this.options.quiet) return;
    this.options.stdout(`${this.green('\u2713')} ${line}`);
  }

  heading(title: string): void {
    this.print(this.bold(title));
  }

  /** `label  value` line with a consistent alignment. */
  field(label: string, value: string, indent = 2): void {
    const padding = ' '.repeat(indent);
    this.print(`${padding}${this.dim(label.padEnd(18))}${value}`);
  }

  list(items: readonly string[], indent = 2): void {
    const padding = ' '.repeat(indent);
    for (const item of items) this.print(`${padding}${item}`);
  }

  blank(): void {
    this.print('');
  }
}

/** Formats a count with a thousands separator, independent of the locale. */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** Formats a duration in a human friendly way. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Formats a very small table as aligned text. */
export function formatTable(rows: Array<[string, string]>, indent = 2): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${' '.repeat(indent)}${label.padEnd(width + 2)}${value}`);
}