/**
 * Bounded concurrency helpers.
 *
 * The scanner must handle repositories with 100k+ files without opening all of
 * them at once, so every I/O fan-out goes through {@link mapWithConcurrency}
 * with a configurable limit (default: min(cpus, 8)).
 */
import { availableParallelism } from 'node:os';

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(availableParallelism() - 1, 8));
}

export interface ConcurrencyResult<T> {
  items: T[];
  errors: Array<{ index: number; error: unknown }>;
}

/**
 * Maps items with a bounded number of in-flight tasks, preserving input order in
 * the result. Failures are collected instead of aborting the run: one unreadable
 * file must never break a repository scan.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<ConcurrencyResult<TOutput>> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<TOutput>(items.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        errors.push({ index, error });
      }
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return { items: results.filter((item) => item !== undefined), errors };
}

/** Runs tasks with bounded concurrency, ignoring the results. */
export async function runWithConcurrency(limit: number, tasks: Array<() => Promise<void>>): Promise<void> {
  await mapWithConcurrency(tasks, limit, async (task) => {
    await task();
    return undefined;
  });
}
