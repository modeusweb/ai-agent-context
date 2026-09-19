/**
 * Git adapter.
 *
 * Git is part of the core functionality (recently changed files, commit counts,
 * ownership signals, architectural change history), but it is strictly optional
 * at runtime: when `git` is missing or the directory is not a repository, the
 * adapter reports that and analysis continues without git signals.
 *
 * Nothing leaves the machine: `git` is invoked locally through `child_process`.
 */
import { execFile } from 'node:child_process';

export interface GitCommit {
  sha: string;
  /** Author name as recorded by git (neutral ownership signal). */
  author: string;
  /** ISO 8601 author date. */
  date: string;
  /** Author date in milliseconds since epoch. */
  dateMs: number;
  subject: string;
  /** Repository-relative POSIX paths touched by the commit. */
  files: string[];
}

export interface GitLogOptions {
  windowDays: number;
  maxCommits: number;
}

export interface GitAvailability {
  available: boolean;
  /** Reason why git signals are unavailable, when `available === false`. */
  reason?: string;
  /** Absolute path of the repository top level. */
  toplevel?: string;
  /** Current branch name, when resolvable. */
  branch?: string | null;
  head?: string | null;
}

export interface GitAdapterOptions {
  /** Path or name of the git binary. */
  gitBinary?: string;
  /** Hard timeout for every git invocation, in milliseconds. */
  timeoutMs?: number;
}

const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';
const LOG_FORMAT = `%x1e%H%x1f%an%x1f%aI%x1f%s`;


interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export class GitAdapter {
  private readonly root: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private availability: GitAvailability | null = null;

  constructor(root: string, options: GitAdapterOptions = {}) {
    this.root = root;
    this.binary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async run(args: string[]): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      execFile(
        this.binary,
        ['--no-pager', '-c', 'core.quotepath=false', ...args],
        { cwd: this.root, timeout: this.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
        },
      );
    });
  }

  /** Detects whether git signals can be produced for this repository. */
  async probe(): Promise<GitAvailability> {
    if (this.availability !== null) return this.availability;
    const inside = await this.run(['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      this.availability = {
        available: false,
        reason: inside.stderr.trim().length > 0 ? inside.stderr.trim() : 'not a git repository',
      };
      return this.availability;
    }
    const toplevel = await this.run(['rev-parse', '--show-toplevel']);
    const branch = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = await this.run(['rev-parse', 'HEAD']);
    const hasCommits = head.ok;
    this.availability = {
      available: hasCommits,
      reason: hasCommits ? undefined : 'repository has no commits yet',
      toplevel: toplevel.ok ? toplevel.stdout.trim() : undefined,
      branch: branch.ok ? branch.stdout.trim() : null,
      head: hasCommits ? head.stdout.trim() : null,
    };
    return this.availability;
  }

  /** Reads the commit history inside the configured window. */
  async log(options: GitLogOptions): Promise<GitCommit[]> {
    const availability = await this.probe();
    if (!availability?.available) return [];
    const result = await this.run([
      'log',
      `--since=${options.windowDays}.days.ago`,
      `--max-count=${options.maxCommits}`,
      '--name-only',
      `--format=${LOG_FORMAT}`,
      '--date-order',
    ]);
    if (!result.ok) return [];
    return parseGitLog(result.stdout);
  }
}

/** Parses the output produced by {@link LOG_FORMAT} combined with `--name-only`. */
export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const chunks = output.split(RECORD_SEPARATOR);
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\s+/, '');
    if (trimmed.length === 0) continue;
    const lines = trimmed.split('\n');
    const header = lines.shift();
    if (header === undefined) continue;
    const [sha, author, date, ...subjectParts] = header.split(FIELD_SEPARATOR);
    if (sha === undefined || author === undefined || date === undefined) continue;
    const dateMs = Date.parse(date);
    const files = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith(FIELD_SEPARATOR))
      .map((line) => line.replace(/\\/g, '/'));
    commits.push({
      sha: sha.trim(),
      author: author.trim(),
      date,
      dateMs: Number.isNaN(dateMs) ? 0 : dateMs,
      subject: subjectPartIsEmpty(subjectParts) ? '' : subjectParts.join(FIELD_SEPARATOR).trim(),
      files,
    });
  }
  return commits;
}

function subjectPartIsEmpty(parts: string[]): boolean {
  return parts.length === 0 || parts.join('').trim().length === 0;
}