import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';

export async function runHistoryCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const target = parsed.positional[0];
  if (target === undefined) return (output.error('history requires a module or path target'), 2);
  const raw = flagString(parsed, 'limit-history');
  const limit = raw === undefined ? 20 : Number.parseInt(raw, 10);
  if (Number.isNaN(limit) || limit <= 0) return (output.error('--limit-history must be a positive integer'), 2);
  try {
    const payload = await (await dependencies.createContext(contextOptions(parsed, io))).getModuleHistory(target, { limit });
    if (context.json) { output.json(payload); return 0; }
    output.heading(`History: ${target}`);
    output.blank();
    if (payload.length === 0) {
      output.print('No commits touch this target in the local history.');
      return 0;
    }
    for (const entry of payload) output.print(`${entry.sha} ${entry.date} ${entry.subject}`);
    return 0;
  } catch (error) { output.error(error instanceof Error ? error.message : String(error)); return 1; }
}
