/**
 * POSIX oriented path helpers.
 *
 * The whole analysis pipeline works with repository-relative POSIX paths
 * (`src/payments/index.ts`) so that the generated context is identical on
 * Windows, macOS and Linux.
 */
import { compareStrings } from '../model/canonical.ts';

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function normalizeRelative(path: string): string {
  const posix = toPosix(path);
  const collapsed = posix
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  return collapsed.replace(/^\/+/, '');
}

export function dirname(path: string): string {
  const normalized = normalizeRelative(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizeRelative(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  if (index <= 0) return '';
  return name.slice(index);
}

export function stem(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? name : name.slice(0, index);
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((part) => part !== undefined && part !== null && part.length > 0);
  return normalizeRelative(filtered.map((part) => toPosix(part)).join('/'));
}

export function segments(path: string): string[] {
  const normalized = normalizeRelative(path);
  return normalized.length === 0 ? [] : normalized.split('/');
}

/** `true` when `child` is `parent` itself or lives below it. */
export function isInside(parent: string, child: string): boolean {
  const container = normalizeRelative(parent);
  const candidate = normalizeRelative(child);
  if (container.length === 0) return true;
  if (candidate === container) return true;
  return candidate.startsWith(`${container}/`);
}

export function depth(path: string): number {
  return segments(path).length;
}

/** Path relative to `parent`, or `null` when `child` is outside of `parent`. */
export function relativeTo(parent: string, child: string): string | null {
  if (!isInside(parent, child)) return null;
  const container = normalizeRelative(parent);
  const candidate = normalizeRelative(child);
  if (container.length === 0) return candidate;
  if (candidate === container) return '';
  return candidate.slice(container.length + 1);
}

/** All ancestor directories of a path, from the shallowest to the deepest. */
export function ancestors(path: string): string[] {
  const parts = segments(path);
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join('/'));
  }
  return result;
}

/** Longest shared directory prefix of two paths. */
export function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const sorted = [...paths].sort(compareStrings);
  const first = segments(sorted[0]!);
  const last = segments(sorted[sorted.length - 1]!);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(first.length, last.length); index += 1) {
    if (first[index] !== last[index]) break;
    shared.push(first[index]!);
  }
  return shared.join('/');
}

/**
 * Derives a stable, human readable module id from a directory path, for example
 * `src/payments` -> `payments`.
 */
export function moduleIdFromPath(path: string, sourceRoots: readonly string[] = []): string {
  const normalized = normalizeRelative(path);
  for (const root of [...sourceRoots].sort((a, b) => b.length - a.length)) {
    const rootNormalized = normalizeRelative(root);
    if (rootNormalized.length === 0) continue;
    if (normalized.startsWith(`${rootNormalized}/`)) {
      return normalized.slice(rootNormalized.length + 1);
    }
  }
  return normalized;
}
