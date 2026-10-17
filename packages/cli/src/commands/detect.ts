/** `agent-context detect` — what the analysis could not determine. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import type { DetectionReport } from '@ai-agent-context/core';

const MARK: Record<string, string> = { error: 'x', warning: '!', info: '-' };

/**
 * Exit codes:
 *   0 — nothing above `info`
 *   1 — at least one warning; something in the context may be misleading
 *   2 — at least one error; the context should not be trusted without reading
 *       the affected files
 */
export async function runDetectCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output } = context;
  const agentContext = await dependencies.createContext(contextOptions(context.parsed, context.io));
  const report: DetectionReport = await agentContext.detect();

  if (context.json) {
    output.print(JSON.stringify(report, null, 2));
    return exitCode(report);
  }

  if (report.issues.length === 0) {
    output.print('Nothing to report: the analysis resolved everything it looked at.');
    return 0;
  }

  output.print('Coverage gaps');
  output.print('');
  for (const issue of report.issues) {
    output.print(`[${MARK[issue.severity] ?? '?'}] ${issue.kind} — ${issue.count} item(s)`);
    output.print(`      ${issue.detail}`);
    for (const sample of issue.samples) output.print(`      - ${sample}`);
    if (issue.count > issue.samples.length) {
      output.print(`      ... ${issue.count - issue.samples.length} more`);
    }
  }

  output.print('');
  output.print(
    `Analyzed ${report.analyzed.parsed}/${report.analyzed.files} file(s); ` +
      `${(report.imports.resolutionRate * 100).toFixed(1)}% of resolvable imports resolved ` +
      `(${report.imports.resolved} resolved, ${report.imports.unresolved} unresolved, ` +
      `${report.imports.excludedOutput} excluded build-output import(s)).`,
  );
  output.print('These are gaps in the analysis, not defects in the repository.');
  return exitCode(report);
}

function exitCode(report: DetectionReport): number {
  if (report.counts.error > 0) return 2;
  if (report.counts.warning > 0) return 1;
  return 0;
}