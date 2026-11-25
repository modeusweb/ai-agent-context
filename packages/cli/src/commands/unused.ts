/**
 * `agent-context unused` — named exports that no analyzed file imports.
 *
 * A report, not a lint error: every finding says how confident it is and why,
 * and the report names what was not assessed. The exit code follows `detect`:
 * `1` when there is a finding to look at, `0` when there is none.
 */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';
import { renderUnused } from '../ui/format.ts';

export async function runUnusedCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const rawLimit = flagString(parsed, 'limit');
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
    output.error(`--limit must be a positive integer (received: ${rawLimit ?? ''})`);
    return 2;
  }

  const report = await (await dependencies.createContext(contextOptions(parsed, io))).findUnusedExports(limit === undefined ? {} : { limit });
  if (context.json) {
    output.json(report);
    return report.unused.length > 0 ? 1 : 0;
  }
  for (const line of renderUnused(report)) output.print(line);
  return report.unused.length > 0 ? 1 : 0;
}
