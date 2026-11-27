/**
 * The verdict of the dependency oracle, separated from its reporting.
 *
 * Keeping this in its own module is what lets a test present a synthetic
 * report with one missing file pair and assert that CI would fail. Checking
 * the verdict only inside the script would mean the gate itself was never
 * gated — the same mistake the module-level check made before 1.1.1.
 */

/**
 * Every reason a report must fail CI. An empty array means the measurement is
 * clean; a metric that cannot be compared (`n/a`) is not a failure, because a
 * repository with no module edges has nothing to compare at that level.
 */
export function oracleFailures(result) {
  const failures = [];

  if (result.precisionPercent !== null && result.recallPercent !== null) {
    if (result.precisionPercent < 100 || result.recallPercent < 100) {
      failures.push(
        `module-level oracle: precision ${result.precisionPercent}%, recall ${result.recallPercent}%`,
      );
    }
  }

  // Gate the counts, not the rounded percentages: a single extra pair among
  // thousands still rounds to 100.0%.
  const file = result.fileLevel;
  if (file.falsePositive > 0 || file.falseNegative > 0) {
    const lines = [
      `file-level oracle: ${file.falsePositive} extra and ${file.falseNegative} missing pair(s)`,
    ];
    for (const sample of file.falsePositiveSample ?? []) lines.push(`  extra:  ${sample}`);
    for (const sample of file.falseNegativeSample ?? []) lines.push(`  missing: ${sample}`);
    failures.push(lines.join('\n'));
  }

  // An import the analyzer called unresolved while the compiler resolved it to
  // in-repo source is an overstated resolution rate, not a documented limit.
  if (result.unresolvedCrossCheck.missed > 0) {
    const lines = [
      `${result.unresolvedCrossCheck.missed} import(s) reported unresolved but resolvable by the compiler`,
    ];
    for (const sample of result.missedSample ?? []) lines.push(`  ${sample}`);
    failures.push(lines.join('\n'));
  }

  return failures;
}
