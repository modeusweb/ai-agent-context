/** `agent-context context` — compact repository context for agents and humans. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderRepositoryContext } from '../ui/format.ts';

export async function runContextCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const repositoryContext = await agentContext.getRepositoryContext();

  if (context.json) {
    output.print(JSON.stringify(repositoryContext, null, 2));
    return 0;
  }

  for (const line of renderRepositoryContext(repositoryContext)) output.print(line);
  return 0;
}