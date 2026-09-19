/**
 * Shared test helpers: fixture repositories are copied into a temporary
 * directory so tests never mutate the committed fixtures, and git history is
 * created locally per copy.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES_ROOT = path.join(REPO_ROOT, 'fixtures');

/**
 * Base directory for temporary test repositories. Deliberately outside the
 * repository tree so that a copied fixture is never nested inside the parent
 * git worktree (which would make `git` probes resolve to the parent).
 */
export const TEMP_BASE = path.join(os.tmpdir(), 'ai-agent-context-tests');

/** List of fixture repository names that must exist (see tools/generate-fixtures.mjs). */
export const FIXTURE_NAMES = ['simple-ts', 'layered-app', 'monorepo', 'cli-project', 'api-project'] as const;

let counter = 0;

/** Copies a committed fixture into a fresh temporary directory and returns its path. */
export function createTempRepo(fixture: string, options: { git?: boolean; name?: string } = {}): string {
  const source = path.join(FIXTURES_ROOT, fixture);
  if (!existsSync(source)) {
    throw new Error(`fixture "${fixture}" is missing — run: npm run fixtures`);
  }
  const unique = `${process.pid}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
  // The leaf directory name is the repository name used in canonical output, so
  // tests that compare bytes across copies use the same basename.
  const target = path.join(TEMP_BASE, unique, options.name ?? fixture);
  rmSync(target, { force: true, recursive: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  if (options.git === true) initGit(target);
  return target;
}


/** Initialises a git repository with a deterministic identity and one commit. */
export function initGit(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test Author']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: fixture snapshot']);
}

/** Runs an extra git command inside a temp repository. */
export function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root });
}

/** Reads a file of the temporary repository. */
export function readRepoFile(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

/** Writes (or overwrites) a file inside the temporary repository. */
export function writeRepoFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/** Deletes a file inside the temporary repository. */
export function deleteRepoFile(root: string, relativePath: string): void {
  rmSync(path.join(root, relativePath), { force: true });
}

/** Removes a temporary repository created by the current process. */
export function cleanupTemp(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

