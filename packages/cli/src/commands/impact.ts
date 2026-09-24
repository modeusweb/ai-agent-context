import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';

export async function runImpactCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const target = parsed.positional[0];
  if (target === undefined) {
    output.error('impact requires a target module or path');
    return 2;
  }
  const rawLimit = flagString(parsed, 'max-files');
  const maxFiles = rawLimit === undefined ? 100 : Number.parseInt(rawLimit, 10);
  if (Number.isNaN(maxFiles) || maxFiles <= 0) {
    output.error(`--max-files must be a positive integer (received: ${rawLimit ?? ''})`);
    return 2;
  }
  try {
    const payload = await (await dependencies.createContext(contextOptions(parsed, io))).getChangeImpact(target, { maxFiles });
    if (context.json) {
      output.print(JSON.stringify(payload, null, 2));
      return 0;
    }
    output.heading(`Change impact: ${payload.target}`);
    output.blank();
    output.print(`Modules: ${payload.modules.join(', ') || '<none>'}`);
    output.print(`Files: ${payload.files.length}${payload.truncated ? '+' : ''}`);
    output.print(`Tests: ${payload.tests.join(', ') || '<none>'}`);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
