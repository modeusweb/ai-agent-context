/** `agent-context verify` — fail in CI when context is missing, invalid or stale. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagBoolean } from '../cli.ts';
import { compactStatusPayload, renderStatus } from '../ui/format.ts';

export async function runVerifyCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const status = await agentContext.status();
  const valid =
    status.status === 'up-to-date' &&
    status.configHashMatches &&
    status.contextFiles.missing.length === 0 &&
    status.contextFiles.invalid.length === 0;

  if (context.json) {
    const payload = flagBoolean(parsed, 'full') ? status : compactStatusPayload(status);
    output.print(JSON.stringify({ ...payload, valid }, null, 2));
  } else {
    for (const line of renderStatus(status)) output.print(line);
    output.blank();
    output.print(valid ? 'Context verification passed.' : 'Context verification failed.');
  }
  return valid ? 0 : 1;
}
