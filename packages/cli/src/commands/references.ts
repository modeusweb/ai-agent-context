/**
 * `agent-context references <symbol>` — where an exported symbol is imported.
 *
 * The target is a symbol name, or `file#symbol` when several files export the
 * name — the same form `search` reports for a symbol.
 *
 * Exit code `1` when nothing was resolved to, so a script can tell "no such
 * symbol" from "no references": the latter is a successful answer and prints a
 * report with an empty list.
 */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';
import { renderReferences } from '../ui/format.ts';

export async function runReferencesCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const target = parsed.positional[0];
  if (target === undefined) {
    output.error('references requires a symbol, for example: agent-context references charge');
    return 2;
  }

  const file = flagString(parsed, 'file');
  const report = await (await dependencies.createContext(contextOptions(parsed, io))).findReferences(target, {
    ...(file === undefined ? {} : { file }),
  });
  const resolved = report.status === 'found';

  if (context.json) {
    output.json(report);
    return resolved ? 0 : 1;
  }
  for (const line of renderReferences(report)) output.print(line);
  return resolved ? 0 : 1;
}
