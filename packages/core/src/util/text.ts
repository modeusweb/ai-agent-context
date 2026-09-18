/** Small, dependency-free text helpers shared by the analysis modules. */

/** Splits `paymentService`/`Payment_Service`/`HTTPClient` into lowercase words. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/** Word shape of an identifier, used by naming convention detection. */
export type IdentifierCase = 'PascalCase' | 'camelCase' | 'kebab-case' | 'snake_case' | 'SCREAMING_SNAKE_CASE' | 'other';

export function classifyIdentifierCase(identifier: string): IdentifierCase {
  if (/^[A-Z][A-Za-z0-9]*$/.test(identifier) && /[a-z]/.test(identifier)) return 'PascalCase';
  if (/^[a-z][A-Za-z0-9]*$/.test(identifier)) return 'camelCase';
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(identifier) && identifier.includes('-')) return 'kebab-case';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(identifier)) return 'snake_case';
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(identifier)) return 'SCREAMING_SNAKE_CASE';
  return 'other';
}

/** Formats a millisecond timestamp as a `YYYY-MM-DD` UTC date. */
export function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** Formats a millisecond timestamp as a full ISO timestamp. */
export function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function truncate(text: string, maxLength: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxLength) return single;
  return `${single.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

/** Counts occurrences of each value, returning the most frequent first. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const itemKey = key(item);
    counts.set(itemKey, (counts.get(itemKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([entryKey, count]) => ({ key: entryKey, count }))
    .sort((a, b) => (b.count === a.count ? (a.key < b.key ? -1 : 1) : b.count - a.count));
}

/** Percentage helper that never returns `NaN`. */
export function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return part / total;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Indents every non-empty line by `indent` spaces. */
export function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim().length === 0 ? line : `${indent}${line}`))
    .join('\n');
}
