/** `agent-context status` — is the context up to date? */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderStatus } from '../ui/format.ts';

export async function runStatusCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const status = await agentContext.status();

  if (context.json) {
    output.print(JSON.stringify(status, null, 2));
    return status.status === 'missing' ? 1 : 0;
  }

  for (const line of renderStatus(status)) output.print(line);
  return 0;
}