/** `agent-context outline <file>` — what one file exports, what it imports, and who imports it. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderOutline } from '../ui/format.ts';

export async function runOutlineCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const target = parsed.positional[0];
  if (target === undefined) {
    output.error('outline requires a file, for example: agent-context outline src/payments/pay.ts');
    return 2;
  }

  const outline = await (await dependencies.createContext(contextOptions(parsed, io))).getFileOutline(target);
  if (outline === null) {
    output.error(`cannot outline "${target}": no analyzed file matched.`);
    output.note('outline describes one file. A directory or a module is explained by: agent-context explain <path>');
    return 1;
  }

  if (context.json) {
    output.json(outline);
    return 0;
  }
  for (const line of renderOutline(outline)) output.print(line);
  return 0;
}
