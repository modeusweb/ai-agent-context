/**
 * Coverage diagnostics.
 *
 * An analyzer that only reports what it found is half an answer: an agent that
 * trusts a dependency graph has to know which parts of that graph are missing.
 * This module turns every "I could not determine this" signal the pipeline
 * already produces into a single ranked list, so the caller can decide whether
 * to trust the context or go read the code.
 *
 * Everything here is an observation about the analysis, never about the
 * repository's quality: an unresolved import of `dist/` is a fact about the
 * configuration, not a defect in the project.
 */
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import { compareStrings } from '../../model/canonical.ts';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueKind =
  | 'path-escape'
  | 'unresolved-import'
  | 'unresolved-alias'
  | 'failed-parse'
  | 'partial-parse'
  | 'sensitive-skipped'
  | 'import-cycle'
  | 'layering-violation'
  | 'module-without-dependencies'
  | 'module-without-entry-point';

export interface DetectedIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  /** Repository-relative path this concerns, when it concerns exactly one. */
  subject: string | null;
  detail: string;
  /** How many items of this kind were folded into this one. */
  count: number;
  /** Up to five concrete examples, so the issue is actionable without a rerun. */
  samples: string[];
}

export interface DetectionReport {
  schemaVersion: number;
  /** True when nothing needs an agent's attention. */
  clean: boolean;
  /** Counts of issues per severity. */
  counts: { error: number; warning: number; info: number };
  /** Issues sorted most severe first, then by kind, then deterministically. */
  issues: DetectedIssue[];
  /** Fraction of analyzed files that produced usable facts. */
  analyzed: {
    files: number;
    parsed: number;
    failed: number;
    partial: number;
    sensitiveSkipped: number;
    parsedShare: number;
  };
  /**
 * Import resolution. `unresolved` counts only imports the analyzer could have
 * resolved; `excludedOutput` and `pathEscapes` are reported separately and are
 * excluded from the rate, because neither is a resolution failure.
 */
  imports: {
    resolved: number;
    unresolved: number;
    excludedOutput: number;
    pathEscapes: number;
    resolutionRate: number;
  };
}

const MAX_SAMPLES = 5;

/** Directories whose contents the default configuration excludes. */
const EXCLUDED_OUTPUT = /(?:^|\/)(?:dist|build|out|lib|coverage|node_modules|vendor|target)(?:\/|$)/;

function fold(
  kind: IssueKind,
  severity: IssueSeverity,
  subjects: readonly string[],
  detail: string,
): DetectedIssue | null {
  if (subjects.length === 0) return null;
  const unique = [...new Set(subjects)].sort(compareStrings);
  return {
    kind,
    severity,
    subject: unique.length === 1 ? unique[0]! : null,
    detail,
    count: unique.length,
    samples: unique.slice(0, MAX_SAMPLES),
  };
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

function compareIssues(a: DetectedIssue, b: DetectedIssue): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byKind = compareStrings(a.kind, b.kind);
  if (byKind !== 0) return byKind;
  return compareStrings(a.detail, b.detail);
}

/**
 * Builds the detection report.
 *
 * Unresolved imports are split by cause because they mean very different things:
 * an import of excluded build output is expected, an import that points at a
 * file the analyzer decided does not exist is a real gap in the graph, and an
 * import that tried to climb out of the repository is a security signal that
 * belongs above every other issue.
 */
export function detectIssues(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
  schemaVersion: number,
): DetectionReport {
  const issues: Array<DetectedIssue | null> = [];

  const escapes = graph.unresolved.filter((entry) =>
    (entry.attempts[0] ?? '').includes('outside the repository root'),
  );
  const unresolved = graph.unresolved.filter((entry) => !(entry.attempts[0] ?? '').includes('outside the repository root'));

  issues.push(
    fold(
      'path-escape',
      'error',
      escapes.map((entry) => `${entry.file} -> ${entry.specifier}`),
      'import specifiers tried to climb above the repository root and were rejected',
    ),
  );

  const unresolvedAliases = unresolved.filter((entry) =>
    (entry.attempts[0] ?? '').includes('did not resolve'),
  );
  const missing = unresolved.filter((entry) => !EXCLUDED_OUTPUT.test(entry.specifier));
  const excluded = unresolved.filter((entry) => EXCLUDED_OUTPUT.test(entry.specifier));

  issues.push(
    fold(
      'unresolved-alias',
      'error',
      unresolvedAliases.map((entry) => `${entry.file} -> ${entry.specifier}`),
      'a tsconfig path alias did not resolve to an analyzed file',
    ),
  );
  issues.push(
    fold(
      'unresolved-import',
      'warning',
      missing.map((entry) => `${entry.file} -> ${entry.specifier}`),
      'imports did not resolve to an analyzed file, so they are absent from the dependency graph',
    ),
  );
  issues.push(
    fold(
      'unresolved-import',
      'info',
      excluded.map((entry) => `${entry.file} -> ${entry.specifier}`),
      'imports of excluded build output; expected, and absent from the graph by design',
    ),
  );

  const failed = graph.repository.files.filter((file) => file.parseStatus === 'failed');
  const partial = graph.repository.files.filter((file) => file.parseStatus === 'partial');
  const sensitive = graph.repository.files.filter((file) => file.sensitive);

  issues.push(
    fold('failed-parse', 'warning', failed.map((file) => file.path), 'files could not be parsed at all'),
  );
  issues.push(
    fold(
      'partial-parse',
      'info',
      partial.map((file) => file.path),
      'files were only partially parsed, so their symbols or imports may be incomplete',
    ),
  );
  issues.push(
    fold(
      'sensitive-skipped',
      'info',
      sensitive.map((file) => file.path),
      'files skipped by the sensitive-file policy; never read and never analyzed',
    ),
  );

  issues.push(
    fold(
      'import-cycle',
      'warning',
      graph.cycles.map((cycle) => cycle.join(' -> ')),
      'modules form a dependency cycle',
    ),
  );

  issues.push(
    fold(
      'layering-violation',
      'warning',
      graph.repository.layeringViolations.map(
        (violation) => `${violation.from} -> ${violation.to} (${violation.kind})`,
      ),
      'modules depend on a layer above them',
    ),
  );

  issues.push(
    fold(
      'module-without-dependencies',
      'info',
      graph.repository.modules
        .filter((module) => module.dependsOn.length === 0 && module.usedBy.length === 0)
        .map((module) => module.id),
      'modules with no resolved dependency in either direction; the graph is probably incomplete here',
    ),
  );

  const present = issues.filter((issue): issue is DetectedIssue => issue !== null);
  present.sort(compareIssues);

  const files = graph.repository.files.length;
  // The rate covers only imports the analyzer could in principle have resolved.
  // Imports of excluded build output and rejected path escapes are reported
  // separately: counting them here would report a healthy repository as broken.
  const resolvedEdges = graph.repository.dependencies.filter(
    (edge) => edge.kind === 'internal-module',
  ).length;
  const resolvableMisses = missing.length + unresolvedAliases.length;
  const resolvableTotal = resolvedEdges + resolvableMisses;

  return {
    schemaVersion,
    clean: present.every((issue) => issue.severity === 'info'),
    counts: {
      error: present.filter((issue) => issue.severity === 'error').length,
      warning: present.filter((issue) => issue.severity === 'warning').length,
      info: present.filter((issue) => issue.severity === 'info').length,
    },
    issues: present,
    analyzed: {
      files,
      parsed: parsed.size,
      failed: failed.length,
      partial: partial.length,
      sensitiveSkipped: sensitive.length,
      parsedShare: files === 0 ? 1 : Number((parsed.size / files).toFixed(4)),
    },
    imports: {
      resolved: resolvedEdges,
      // Imports that should have resolved and did not.
      unresolved: resolvableMisses,
      // Reported above, excluded from the rate on purpose.
      excludedOutput: excluded.length,
      pathEscapes: escapes.length,
      resolutionRate:
        resolvableTotal === 0 ? 1 : Number((resolvedEdges / resolvableTotal).toFixed(4)),
    },
  };
}