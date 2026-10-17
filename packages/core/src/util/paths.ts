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
  return collapse(path).path;
}

export interface CollapsedPath {
  /** Normalized repository-relative POSIX path. */
  path: string;
  /** `true` when a `..` segment tried to climb above the repository root. */
  escaped: boolean;
  /** `true` when the input was absolute (leading slash or Windows drive). */
  absolute: boolean;
}

/**
 * Collapses `.`/`..` segments and duplicate separators in a path.
 *
 * `..` that would climb above the repository root is dropped and reported
 * through {@link CollapsedPath.escaped} rather than silently clamped, so a
 * traversal attempt stays visible instead of degrading into a plausible
 * in-repo path that later matches an analyzed file.
 */
function collapse(path: string): CollapsedPath {
  const posix = toPosix(path);
  const absolute = posix.startsWith('/') || /^[A-Za-z]:\//.test(posix);
  const segments: string[] = [];
  let escaped = false;
  for (const segment of posix.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) escaped = true;
      else segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { path: segments.join('/'), escaped, absolute };
}

/**
 * `true` when `path` is absolute or contains a `..` segment that escapes the
 * repository root. Used by the resolver to reject traversal attempts instead
 * of resolving them to an in-repo fallback.
 */
export function escapesRoot(path: string): boolean {
  const { escaped, absolute } = collapse(path);
  return escaped || absolute;
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
  return joinStrict(...parts).path;
}

/**
 * {@link join} that also reports whether the joined path tried to climb above
 * the repository root or was absolute.
 *
 * `join` collapses `..` eagerly, so a traversal attempt is indistinguishable
 * from a legitimate path by the time {@link escapesRoot} runs. Callers that turn
 * untrusted specifiers into file targets (the import resolver) must use this
 * variant so the escape is visible instead of silently clamped.
 */
export function joinStrict(...parts: Array<string | undefined | null>): CollapsedPath {
  const filtered = parts.filter(
    (part): part is string => part !== undefined && part !== null && part.length > 0,
  );
  const joined = filtered.map((part) => toPosix(part)).join('/');
  const leading = parts.find(
    (part) => typeof part === 'string' && (part.startsWith('/') || /^[A-Za-z]:[\\/]/.test(part)),
  );
  const collapsed = collapse(joined);
  return {
    path: collapsed.path,
    escaped: collapsed.escaped,
    absolute: leading !== undefined || collapsed.absolute,
  };
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
