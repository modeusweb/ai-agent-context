/** `agent-context status` — is the context up to date? */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagBoolean } from '../cli.ts';
import { compactStatusPayload, renderStatus } from '../ui/format.ts';

export async function runStatusCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const status = await agentContext.status();

  if (context.json) {
    const payload = flagBoolean(parsed, 'full') ? status : compactStatusPayload(status);
    output.print(JSON.stringify(payload, null, 2));
    return status.status === 'missing' ? 1 : 0;
  }

  for (const line of renderStatus(status)) output.print(line);
  return 0;
}