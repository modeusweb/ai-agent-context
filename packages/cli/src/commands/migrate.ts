/**
 * `agent-context migrate` — bring a persisted `.agent/` up to the current
 * schema.
 *
 * Context is meant to be committed, so it outlives the tool that wrote it. When
 * a release changes what the analyzer produces — a corrected resolver, a new
 * document, a changed heuristic — a repository can be left holding context that
 * no longer matches its own source. `verify` already detects that; this command
 * explains it and fixes it.
 *
 * `--check` reports without writing, for CI. Exit code `1` means the context is
 * not what this version would produce, and `0` means it is.
 */
import { SCHEMA_VERSION, readPersistedContext, contextFileNames } from '@ai-agent-context/core';
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagBoolean } from '../cli.ts';

export type MigrationState = 'current' | 'missing' | 'invalid' | 'stale';

export interface MigrationReport {
  schemaVersion: number;
  state: MigrationState;
  /** Files that do not exist. */
  missing: string[];
  /** Files that exist but are unusable, with the reason. */
  invalid: Array<{ file: string; reason: string }>;
  /** Files that differ from what a fresh scan would produce. */
  changed: string[];
  /** Whether the working tree moved since the last scan. */
  pendingChanges: number;
  /** `true` when `--check` was requested, i.e. nothing was written. */
  checkOnly: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Assesses the persisted context without writing anything. */
async function assess(agentContext: Awaited<ReturnType<CliDependencies['createContext']>>): Promise<MigrationReport> {
  const status = await agentContext.status();
  const persisted = await readPersistedContext(agentContext.root);
  const changed = [...status.changes.added, ...status.changes.modified, ...status.changes.deleted].sort();

  let state: MigrationState = 'current';
  if (status.contextFiles.missing.length > 0 || persisted.index === null) state = 'missing';
  else if (status.contextFiles.invalid.length > 0 || persisted.invalid.length > 0) state = 'invalid';
  else if (status.status !== 'up-to-date' || !status.configHashMatches) state = 'stale';

  return {
    schemaVersion: SCHEMA_VERSION,
    state,
    missing: [...new Set([...status.contextFiles.missing, ...persisted.missing])].sort(),
    invalid: [...status.contextFiles.invalid, ...persisted.invalid.filter((entry) => !status.contextFiles.invalid.some((other) => other.file === entry.file))].sort((a, b) => a.file.localeCompare(b.file)),
    changed,
    pendingChanges: status.changes.added.length + status.changes.modified.length + status.changes.deleted.length,
    checkOnly: false,
  };
}

const STATE_HEADLINE: Record<MigrationState, string> = {
  current: 'Context is current.',
  missing: 'Context is missing.',
  invalid: 'Context has unreadable documents.',
  stale: 'Context does not match the working tree.',
};

export async function runMigrateCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const checkOnly = flagBoolean(parsed, 'check');
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const report: MigrationReport = { ...(await assess(agentContext)), checkOnly };

  const wasUpToDate = report.state === 'current';
  let regenerated = false;

  if (!checkOnly && !wasUpToDate) {
    // Regenerate. A read-only repository throws here, and the CLI prints the
    // ReadOnlyError hint: the fix is configuration, not a flag.
    await agentContext.scan();
    regenerated = true;
    report.state = 'current';
    report.changed = [];
    report.pendingChanges = 0;
    report.missing = [];
    report.invalid = [];
  }

  const upToDate = report.state === 'current';

  if (context.json) {
    output.print(JSON.stringify(report, null, 2));
    return upToDate || !checkOnly ? 0 : 1;
  }

  output.print(`Schema version: ${report.schemaVersion}`);
  output.blank();
  output.print(STATE_HEADLINE[report.state]);

  if (regenerated) {
    // Say what happened. Printing "nothing to do" after a successful rescan
    // would describe the state before the command ran.
    output.blank();
    output.print('Context regenerated from the current working tree.');
  } else if (report.state === 'invalid') {
    output.blank();
    for (const entry of report.invalid) output.print(`  ${entry.file}: ${entry.reason}`);
    output.blank();
    output.note('These documents cannot be read. Regenerate the context with: agent-context migrate');
  } else if (report.state === 'missing') {
    output.blank();
    output.print(`  Missing: ${report.missing.length > 0 ? report.missing.join(', ') : contextFileNames().join(', ')}`);
    output.blank();
    output.note('Run: agent-context migrate');
  } else if (report.state === 'stale') {
    output.blank();
    output.print(`  Changed files: ${plural(report.changed.length, 'file')}`);
    if (report.changed.length > 0) {
      for (const file of report.changed.slice(0, 10)) output.print(`    ${file}`);
      if (report.changed.length > 10) output.print(`    ... and ${report.changed.length - 10} more`);
    }
    output.blank();
    // `stale` is only reachable here with `--check`: without it the command
    // rescans first and `report.state` has already become `current`.
    output.note('Context drifted. Run: agent-context migrate');
  } else if (!checkOnly) {
    output.blank();
    output.print('Nothing to do.');
  }

  return upToDate || !checkOnly ? 0 : 1;
}