/**
 * Deterministic serialization helpers.
 *
 * A context file must be byte-identical for an identical repository state, so
 * every persisted value goes through {@link canonicalize} (recursively sorted
 * object keys) and {@link stringifyCanonical} (stable formatting). Arrays keep
 * the order assigned by the builders, which sort their output explicitly.
 */
import { createHash } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, stable content hash used for cache sharding and edge ids. */
export function shortHash(input: string, length = 16): string {
  return sha256(input).slice(0, length);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Recursively sorts object keys so that `JSON.stringify` output does not depend
 * on property insertion order.
 */
export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareStrings)) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = canonicalize(entry);
    }
    return result as unknown as T;
  }
  return value;
}

/** Canonical JSON with two-space indentation and a trailing newline. */
export function stringifyCanonical(value: unknown, pretty = true): string {
  const canonical = canonicalize(value as JsonValue);
  return `${pretty ? JSON.stringify(canonical, null, 2) : JSON.stringify(canonical)}\n`;
}

/** Locale-independent, code-unit based string comparison. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Stable, order-insensitive hash of an arbitrary value. */
export function hashValue(value: unknown): string {
  return sha256(stringifyCanonical(value, false));
}

/** Sorts a copy of the array by a derived string key. */
export function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareStrings(key(a), key(b)));
}

/** Deduplicates strings and sorts them. */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Rounds confidence to two decimals and clamps it into `[0, 0.99]`, so that a
 * heuristic result can never masquerade as an absolute fact.
 */
export function clampConfidence(value: number): number {
  const clamped = Math.max(0, Math.min(0.99, value));
  return Math.round(clamped * 100) / 100;
}
