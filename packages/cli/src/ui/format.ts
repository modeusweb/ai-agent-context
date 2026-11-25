/**
 * Human readable projections.
 *
 * The JSON documents are canonical; these functions render the same information
 * for a terminal. Output is plain text so it can be pasted into an issue, a PR
 * description or an agent prompt.
 */
import type {
  ContextDiff,
  FileOutline,
  ImportLine,
  ModuleExplanation,
  ReferenceReport,
  RepositoryContext,
  ScanReport,
  SearchResult,
  StatusReport,
  UnusedExportsReport,
} from '@ai-agent-context/core';
import { formatDuration, formatNumber } from './console.ts';

function indicator(confidence: number): string {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  if (confidence >= 0.5) return 'low';
  return 'speculative';
}

export function renderScanSummary(report: ScanReport): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Files            ${formatNumber(report.files.total)}`);
  lines.push(`Source files     ${formatNumber(report.files.source)}`);
  lines.push(`Test files       ${formatNumber(report.files.tests)}`);
  lines.push(`Modules          ${formatNumber(report.modules)}`);
  lines.push(`Dependencies     ${formatNumber(report.dependencies)}`);
  lines.push(`External deps    ${formatNumber(report.externalDependencies)}`);
  lines.push(`Entry points     ${formatNumber(report.entryPoints)}`);
  lines.push(`Conventions      ${formatNumber(report.conventions)}`);
  lines.push(`Decisions        ${formatNumber(report.decisions)}`);
  const changes = report.changes;
  lines.push(
    `Changes          +${changes.added.length} added, ~${changes.modified.length} modified, -${changes.deleted.length} removed`,
  );
  lines.push(`Parsed/cache     ${formatNumber(report.parsed)} parsed, ${formatNumber(report.reused)} from cache`);
  lines.push(`Duration         ${formatDuration(report.durationMs)}`);
  if (report.affected.modules.length > 0) lines.push(`Affected modules ${report.affected.modules.join(', ')}`);
  const warnings = report.warnings.filter((warning) => warning.severity === 'warning');
  if (warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings (${warnings.length}):`);
    for (const warning of warnings.slice(0, 10)) {
      lines.push(`  ${warning.message}${warning.source === undefined ? '' : ` [${warning.source}]`}`);
    }
    if (warnings.length > 10) lines.push(`  ...and ${warnings.length - 10} more (run with --verbose)`);
  }
  return lines;
}

/**
 * Machine readable status without the (potentially huge) list of unchanged
 * files. `unchanged` is replaced by `unchangedCount`; pass `--full` to keep the
 * complete list.
 */
export function compactStatusPayload(status: StatusReport): Record<string, unknown> {
  const { unchanged, ...changes } = status.changes;
  return { ...status, changes: { ...changes, unchangedCount: unchanged.length } };
}

export function renderStatus(status: StatusReport): string[] {
  const lines: string[] = [];
  lines.push('Repository context');
  lines.push('');
  lines.push(`Status: ${status.status}`);
  lines.push(`Baseline: ${describeBaseline(status.baseline, status.lastScanAt)}`);
  lines.push(`Config file: ${status.configPath ?? 'defaults (run agent-context init)'}`);
  lines.push(`Config hash matches baseline: ${status.configHashMatches ? 'yes' : 'no'}`);
  lines.push('');
  lines.push(`Files: ${formatNumber(status.counts.files)}`);
  lines.push(`Modules: ${formatNumber(status.counts.modules)}`);
  lines.push(`Dependencies: ${formatNumber(status.counts.dependencies)}`);
  lines.push(`Entry points: ${formatNumber(status.counts.entryPoints)}`);
  lines.push(`Conventions: ${formatNumber(status.counts.conventions)}`);
  lines.push(`Decisions: ${formatNumber(status.counts.decisions)}`);
  lines.push('');
  lines.push(
    `Pending changes: ${status.changes.added.length + status.changes.modified.length + status.changes.deleted.length}`,
  );
  if (status.changes.added.length > 0) lines.push(`  Added: ${status.changes.added.length} file(s)`);
  if (status.changes.modified.length > 0) lines.push(`  Modified: ${status.changes.modified.length} file(s)`);
  if (status.changes.deleted.length > 0) lines.push(`  Deleted: ${status.changes.deleted.length} file(s)`);
  if (status.contextFiles.missing.length > 0) {
    lines.push(`  Missing context files: ${status.contextFiles.missing.join(', ')}`);
  }
  for (const invalid of status.contextFiles.invalid) lines.push(`  Invalid: ${invalid.file} (${invalid.reason})`);
  lines.push('');
  const gitLine = status.git.available
    ? `available (${status.git.commitsAnalyzed} commit(s) analyzed)`
    : `unavailable (${status.git.reason ?? 'unknown reason'})`;
  lines.push(`Git signals: ${gitLine}`);
  if (status.status !== 'up-to-date') {
    lines.push('');
    lines.push('Run:');
    lines.push('  agent-context scan');
    if (status.baseline === 'committed-index') lines.push('  git add .agent            # the context is committed, so commit the regenerated one');
  }
  return lines;
}

/**
 * What the working tree was compared with. Said in the output because the two
 * baselines answer different situations: a developer who scanned a moment ago,
 * and a CI checkout that has never scanned and never will.
 */
function describeBaseline(baseline: StatusReport['baseline'], lastScanAt: string | null): string {
  switch (baseline) {
    case 'local-state':
      return lastScanAt === null ? 'local scan state' : `local scan state (last scan ${lastScanAt})`;
    case 'committed-index':
      return 'committed .agent/index.json (no local scan on this machine)';
    default:
      return 'none (no committed context and no local scan)';
  }
}

export function renderExplain(explanation: ModuleExplanation): string[] {
  const lines: string[] = [];
  lines.push(explanation.module.id);
  lines.push('');
  lines.push('Path:');
  lines.push(`  ${explanation.module.path === '' ? '<repository root>' : explanation.module.path}`);
  lines.push('');
  if (explanation.scope !== undefined) {
    lines.push('Scope:');
    lines.push(`  directory only — ${explanation.scope.fileCount} file(s) under ${explanation.scope.directory}`);
    lines.push(`  owning module: ${explanation.scope.moduleId} (this answer does not cover the rest of it)`);
    lines.push('');
  }
  if (explanation.module.roles.length > 0) {
    lines.push('Detected roles (heuristic, with confidence):');
    for (const role of explanation.module.roles) {
      lines.push(`  ${role.value} (${role.confidence.toFixed(2)}, ${indicator(role.confidence)})`);
      for (const evidence of role.evidence.slice(0, 2)) {
        lines.push(`    evidence: ${evidence.source} — ${evidence.detail}`);
      }
    }
    lines.push('');
  }
  if (explanation.entryPoints.length > 0) {
    lines.push('Entry points:');
    for (const entry of explanation.entryPoints) {
      lines.push(`  ${entry.path} (${entry.type}, confidence ${entry.confidence.toFixed(2)})`);
    }
    lines.push('');
  }
  if (explanation.module.responsibilities.length > 0) {
    lines.push('Responsibilities:');
    for (const responsibility of explanation.module.responsibilities) {
      lines.push(`  - ${responsibility.value} (${responsibility.confidence.toFixed(2)})`);
    }
    lines.push('');
  }
  if (explanation.dependsOn.length > 0) {
    lines.push('Depends on:');
    for (const dependency of explanation.dependsOn) {
      lines.push(
        `  ${dependency.id} (${dependency.path}) — ${dependency.files} file(s), ${dependency.relationships.join(', ')}`,
      );
    }
    lines.push('');
  }
  if (explanation.usedBy.length > 0) {
    lines.push('Used by:');
    for (const dependent of explanation.usedBy) {
      lines.push(`  ${dependent.id} (${dependent.path}) — ${dependent.files} file(s)`);
    }
    lines.push('');
  }
  if (explanation.externalDependencies.length > 0) {
    lines.push('External dependencies:');
    for (const dependency of explanation.externalDependencies) {
      lines.push(
        `  ${dependency.name} (${dependency.scope}, heuristic: ${dependency.importance.value} ${dependency.importance.confidence.toFixed(2)})`,
      );
    }
    lines.push('');
  }
  if (explanation.publicApi.length > 0) {
    lines.push('Public API:');
    for (const entry of explanation.publicApi.slice(0, 20)) {
      lines.push(`  ${entry.name} (${entry.kind}) — ${entry.file}`);
    }
    lines.push('');
  }
  if (explanation.tests.files.length > 0) {
    lines.push(`Tests: ${explanation.tests.testCount} test file(s)`);
    for (const file of explanation.tests.files.slice(0, 5)) lines.push(`  ${file}`);
    lines.push('');
  }
  if (explanation.conventions.length > 0) {
    lines.push('Relevant conventions:');
    for (const convention of explanation.conventions) {
      lines.push(`  - [${convention.category}] ${convention.statement} (${convention.confidence.toFixed(2)})`);
    }
    lines.push('');
  }
  if (explanation.decisions.length > 0) {
    lines.push('Relevant decisions:');
    for (const decision of explanation.decisions) {
      lines.push(`  - ${decision.id} ${decision.title} (${decision.origin}, ${decision.status}) — ${decision.source}`);
    }
    lines.push('');
  }
  if (explanation.git !== null) {
    lines.push('Git activity (neutral signals):');
    lines.push(
      `  historicalChanges ${explanation.git.historicalChanges}, recentChanges ${explanation.git.recentChanges}, changeFrequency ${explanation.git.changeFrequency}, lastChanged ${explanation.git.lastChanged ?? 'unknown'}`,
    );
    if (explanation.git.topContributors.length > 0) {
      lines.push(
        `  top contributors: ${explanation.git.topContributors.map((entry) => `${entry.name} (${entry.commits})`).join(', ')}`,
      );
    }
    lines.push('');
  }
  if (explanation.impact.modules.length > 0) {
    lines.push('Change impact (transitive dependents):');
    for (const moduleId of explanation.impact.modules.slice(0, 15)) lines.push(`  ${moduleId}`);
    lines.push('');
  }
  if (explanation.relatedFiles.length > 0) {
    lines.push('Files:');
    for (const file of explanation.relatedFiles) lines.push(`  ${file}`);
    lines.push('');
  }
  return lines;
}

export function renderDiff(diff: ContextDiff): string[] {
  const lines: string[] = [];
  lines.push('Repository context changes');
  lines.push('');
  const section = (title: string, items: readonly string[]): void => {
    lines.push(`${title}:`);
    if (items.length === 0) lines.push('  no changes');
    else for (const item of items.slice(0, 40)) lines.push(`  ${item}`);
    if (items.length > 40) lines.push(`  ...and ${items.length - 40} more`);
    lines.push('');
  };
  section('Added', diff.files.added);
  section('Modified', diff.files.modified);
  section('Removed', diff.files.removed);
  section('Modules added', diff.modules.added);
  section('Modules removed', diff.modules.removed);
  section(
    'Architecture (role changes, heuristic)',
    diff.modules.roleChanges.map(
      (change) => `${change.moduleId}: +[${change.added.join(', ')}] -[${change.removed.join(', ')}]`,
    ),
  );
  section('Dependencies', [
    ...diff.dependencies.added.map((edge) => `+ ${edge.from} → ${edge.to}`),
    ...diff.dependencies.removed.map((edge) => `- ${edge.from} → ${edge.to}`),
    ...diff.dependencies.externalAdded.map((name) => `+ external ${name}`),
    ...diff.dependencies.externalRemoved.map((name) => `- external ${name}`),
  ]);
  section('Entry points', [
    ...diff.entryPoints.added.map((entry) => `+ ${entry}`),
    ...diff.entryPoints.removed.map((entry) => `- ${entry}`),
  ]);
  section('Conventions', [
    ...diff.conventions.added.map((entry) => `+ ${entry}`),
    ...diff.conventions.changed.map((entry) => `~ ${entry}`),
    ...diff.conventions.removed.map((entry) => `- ${entry}`),
  ]);
  section('Decisions', [
    ...diff.decisions.added.map((entry) => `+ ${entry}`),
    ...diff.decisions.removed.map((entry) => `- ${entry}`),
  ]);
  if (!diff.hasChanges) lines.push('No context changes since the last scan.');
  return lines;
}

export function renderRepositoryContext(context: RepositoryContext): string[] {
  const lines: string[] = [];
  lines.push(`Repository: ${context.repository.name}`);
  lines.push(
    `Languages: ${context.repository.languages.join(', ')} · ${formatNumber(context.repository.fileCount)} files (${formatNumber(context.repository.sourceFileCount)} source, ${formatNumber(context.repository.testFileCount)} test)`,
  );
  lines.push(
    `Modules: ${formatNumber(context.repository.moduleCount)} · Symbols: ${formatNumber(context.repository.symbolCount)} · Module dependencies: ${formatNumber(context.repository.dependencyCount)}`,
  );
  lines.push(
    `Workspace: ${context.workspace.isMonorepo ? context.workspace.model : 'single package'} · package manager: ${context.workspace.packageManager}`,
  );
  lines.push('');
  if (context.commands.length > 0) {
    lines.push('Commands:');
    for (const command of context.commands.slice(0, 12)) lines.push(`  ${command.name}: ${command.command}`);
    lines.push('');
  }
  lines.push('Modules (ranked by architectural centrality):');
  for (const module of context.modules.slice(0, 12)) {
    const roles =
      module.roles.length > 0
        ? module.roles.map((role) => `${role.value} ${role.confidence.toFixed(2)}`).join(', ')
        : 'no role above threshold';
    lines.push(`  ${module.id} (${module.path}) — ${module.files} file(s) — ${roles}`);
  }
  lines.push('');
  if (context.entryPoints.length > 0) {
    lines.push('Entry points:');
    for (const entry of context.entryPoints.slice(0, 12)) {
      lines.push(`  ${entry.path} (${entry.type}, ${entry.confidence.toFixed(2)})`);
    }
    lines.push('');
  }
  if (context.externalDependencies.length > 0) {
    lines.push('External dependencies (heuristic importance):');
    for (const dependency of context.externalDependencies.slice(0, 12)) {
      lines.push(
        `  ${dependency.name} (${dependency.scope}, ${dependency.importance.value}, used by ${dependency.importedByModules} module(s))`,
      );
    }
    lines.push('');
  }
  if (context.cycles.length > 0) {
    lines.push('Module dependency cycles:');
    for (const cycle of context.cycles) lines.push(`  ${cycle.join(' <-> ')}`);
    lines.push('');
  }
  if (context.decisions.length > 0) {
    lines.push('Decisions:');
    for (const decision of context.decisions.slice(0, 10)) {
      lines.push(`  ${decision.id} ${decision.title} (${decision.origin}, ${decision.status})`);
    }
    lines.push('');
  }
  lines.push(`Conventions: ${context.conventions.length} detected (see .agent/conventions.md)`);
  return lines;
}

/** Renders search results. */
export function renderSearchResults(results: readonly SearchResult[]): string[] {
  if (results.length === 0) return ['No results.', '', 'Try different keywords, for example: payment idempotency'];
  const lines: string[] = [];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.type} ${result.id} (score ${result.score})`);
    lines.push(`   reason: ${result.reason}`);
    if (result.snippet !== undefined) lines.push(`   ${result.snippet}`);
  });
  return lines;
}
/** The kind of an import statement, in the words of the line that shows it. */
function syntaxLabel(syntax: string): string {
  switch (syntax) {
    case 'reexport':
      return 're-export';
    case 'type-only':
      return 'type-only';
    case 'dynamic':
      return 'dynamic import';
    case 'require':
      return 'require';
    case 'side-effect':
      return 'side effect';
    case 'import-equals':
      return 'import =';
    default:
      return '';
  }
}

/** What an import resolves to, as one short phrase. */
function targetLabel(line: ImportLine): string {
  switch (line.targetKind) {
    case 'internal-file':
      return `→ ${line.target}`;
    case 'workspace-package':
      return `→ workspace package ${line.target}`;
    case 'external-package':
      return `→ external package ${line.target}`;
    case 'node-builtin':
      return `→ Node built-in ${line.target}`;
    default:
      return `unresolved${line.reason === undefined ? '' : ` (${line.reason})`}`;
  }
}

const truncateList = (items: readonly string[], limit: number): string[] =>
  items.length > limit ? [...items.slice(0, limit), `…and ${items.length - limit} more`] : [...items];

export function renderOutline(outline: FileOutline): string[] {
  const lines: string[] = [];
  lines.push(outline.file);
  lines.push(`module ${outline.module ?? '<none>'} · ${outline.language} · ${outline.kind}`);
  if (outline.parseStatus !== 'ok') lines.push(`parse status: ${outline.parseStatus} — facts may be incomplete`);
  lines.push('');

  lines.push(`Exports (${outline.exports.length}):`);
  if (outline.exports.length === 0) lines.push('  <none>');
  for (const entry of outline.exports) {
    const origin = entry.reexportedFrom === undefined ? '' : `  re-exported from ${entry.reexportedFrom}:${entry.declaredLine}`;
    const possible = entry.possibleReferences > 0 ? ` (+${entry.possibleReferences} possible)` : '';
    lines.push(
      `  line ${String(entry.line).padStart(4)}  ${entry.name.padEnd(28)} ${entry.kind.padEnd(10)} imported by ${entry.references}${possible}${origin}`,
    );
  }
  lines.push('');

  if (outline.internalSymbols.length > 0) {
    lines.push(`Not exported (${outline.internalSymbols.length}):`);
    for (const symbol of outline.internalSymbols.slice(0, 25)) {
      lines.push(`  line ${String(symbol.line).padStart(4)}  ${symbol.name.padEnd(28)} ${symbol.kind}`);
    }
    lines.push('');
  }

  lines.push(`Imports (${outline.imports.length}):`);
  if (outline.imports.length === 0) lines.push('  <none>');
  for (const line of outline.imports) {
    const names = line.names.length > 0 ? `  { ${line.names.join(', ')} }` : '';
    const label = syntaxLabel(line.syntax);
    lines.push(`  line ${String(line.line).padStart(4)}  '${line.specifier}' ${targetLabel(line)}${names}${label.length === 0 ? '' : `  [${label}]`}`);
  }
  lines.push('');

  const { importers } = outline;
  lines.push(`Imported by, directly (${importers.direct.length}):`);
  if (importers.direct.length === 0) lines.push('  <no analyzed file imports it>');
  for (const entry of importers.direct) {
    const names = entry.names.length > 0 ? `  { ${entry.names.join(', ')} }` : '';
    const label = syntaxLabel(entry.syntax);
    lines.push(`  ${entry.file}:${entry.line}${names}${label.length === 0 ? '' : `  [${label}]`}`);
  }
  lines.push('');
  lines.push(`Depended on by, through other files (${importers.transitiveCount}):`);
  for (const file of truncateList(importers.transitive, 40)) lines.push(`  ${file}`);
  lines.push('');
  lines.push(`Tests among the importers (${importers.tests.length}):`);
  for (const file of truncateList(importers.tests, 20)) lines.push(`  ${file}`);
  if (outline.routes.length > 0) {
    lines.push('');
    lines.push('HTTP routes registered here:');
    for (const route of outline.routes) lines.push(`  line ${route.line}  ${route.method} ${route.path}`);
  }
  if (outline.caveats.length > 0) {
    lines.push('');
    lines.push('Limits of this answer:');
    for (const caveat of outline.caveats) lines.push(`  - ${caveat}`);
  }
  return lines;
}

export function renderReferences(report: ReferenceReport): string[] {
  const lines: string[] = [];
  const target = report.target;
  if (target === null) {
    lines.push(`References: ${report.status === 'ambiguous' ? 'ambiguous name' : 'not found'}`);
    lines.push('');
    for (const caveat of report.caveats) lines.push(caveat);
    if (report.candidates.length > 0) {
      lines.push('');
      lines.push('Candidates:');
      for (const candidate of report.candidates) lines.push(`  ${candidate.file}#${candidate.symbol}  (${candidate.kind}, line ${candidate.line})`);
    }
    return lines;
  }

  lines.push(`References: ${target.symbol}`);
  lines.push(`declared in ${target.file}:${target.line} (${target.kind}${target.exported ? ', exported' : ', not exported'})`);
  lines.push('');
  lines.push(`Imported by ${report.references.length} statement(s):`);
  if (report.references.length === 0) lines.push('  <none>');
  for (const reference of report.references) {
    const through = reference.via.length > 0 ? `  through ${reference.via.join(' → ')}` : '';
    const typeOnly = reference.typeOnly ? '  [type-only]' : '';
    lines.push(`  ${reference.file}:${reference.line}  as ${reference.importedAs}${through}${typeOnly}`);
  }
  if (report.possibleReferences.length > 0) {
    lines.push('');
    lines.push(`Possibly used through a namespace import (${report.possibleReferences.length}) — whether it is, is not in the statement:`);
    for (const reference of report.possibleReferences) {
      const through = reference.via.length > 0 ? `  through ${reference.via.join(' → ')}` : '';
      lines.push(`  ${reference.file}:${reference.line}  as ${reference.importedAs}${through}`);
    }
  }
  if (report.reexportedBy.length > 0) {
    lines.push('');
    lines.push('Re-exported by:');
    for (const entry of report.reexportedBy) lines.push(`  ${entry.file}:${entry.line}  as ${entry.name}`);
  }
  lines.push('');
  lines.push(`Reachable from an entry point: ${report.externallyReachable ? 'yes — a consumer outside the analyzed files may import it' : 'no'}`);
  if (report.caveats.length > 0) {
    lines.push('');
    lines.push('Limits of this answer:');
    for (const caveat of report.caveats) lines.push(`  - ${caveat}`);
  }
  return lines;
}

export function renderUnused(report: UnusedExportsReport): string[] {
  const lines: string[] = [];
  const { counts } = report;
  lines.push('Unused exports');
  lines.push('');
  lines.push(
    `${counts.unused} of ${counts.exported} assessed named exports are imported by no analyzed file ` +
      `(${counts.referenced} imported, ${counts.publicApi} reachable from an entry point, ${counts.unassessable} not assessable).`,
  );
  lines.push('');
  if (report.unused.length === 0) {
    lines.push('Nothing to report.');
  }
  for (const entry of report.unused) {
    const reexported = entry.reexportedBy.length > 0 ? `  re-exported by ${entry.reexportedBy.join(', ')}` : '';
    lines.push(`  ${entry.file}:${entry.line}  ${entry.name}  (${entry.kind})${reexported}`);
  }
  if (report.truncated) lines.push(`  …and ${counts.unused - report.unused.length} more (--limit)`);
  lines.push('');
  lines.push(`Confidence per finding: ${report.unused[0]?.confidence ?? 'n/a'}. A finding says that nothing in the analyzed files imports the export; it does not say the export is safe to delete.`);
  for (const caveat of report.caveats) lines.push(`  - ${caveat}`);
  return lines;
}
