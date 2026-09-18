/** `agent-context init` — create `.agent/` and `.agent/config.json` (idempotent). */
import { flagBoolean, type CliCommandContext, type CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';

export async function runInitCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const force = flagBoolean(parsed, 'force');
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const result = await agentContext.init({ force });

  if (context.json) {
    output.print(JSON.stringify(result, null, 2));
    return 0;
  }

  if (result.created.length > 0) {
    output.success('Created:');
    output.list(result.created);
  }
  if (result.overwritten) output.note('Existing configuration overwritten (--force).');
  if (result.created.length === 0 && !result.overwritten) {
    output.print(`Configuration already exists: ${agentContext.configFile ?? '.agent/config.json'}`);
    output.note('Use --force to overwrite it.');
  }
  output.blank();
  output.print('Next:');
  output.print('  agent-context scan');
  return 0;
}