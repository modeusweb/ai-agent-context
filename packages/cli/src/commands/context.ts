/** `agent-context context` — compact repository context for agents and humans. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';

function positiveFlag(parsed: import('../cli.ts').ParsedArguments, name: string): number | undefined {
  const value = flagString(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number.parseInt(value, 10);
  return Number.isNaN(parsedValue) || parsedValue <= 0 ? undefined : Math.min(parsedValue, 200);
}
import { renderRepositoryContext } from '../ui/format.ts';

export async function runContextCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const repositoryContext = await agentContext.getRepositoryContext({
    ...(positiveFlag(parsed, 'max-modules') === undefined ? {} : { maxModules: positiveFlag(parsed, 'max-modules') }),
    ...(positiveFlag(parsed, 'max-entry-points') === undefined ? {} : { maxEntryPoints: positiveFlag(parsed, 'max-entry-points') }),
    ...(positiveFlag(parsed, 'max-external-dependencies') === undefined ? {} : { maxExternalDependencies: positiveFlag(parsed, 'max-external-dependencies') }),
    ...(positiveFlag(parsed, 'max-conventions') === undefined ? {} : { maxConventions: positiveFlag(parsed, 'max-conventions') }),
    ...(positiveFlag(parsed, 'max-decisions') === undefined ? {} : { maxDecisions: positiveFlag(parsed, 'max-decisions') }),
    ...(positiveFlag(parsed, 'max-cycles') === undefined ? {} : { maxCycles: positiveFlag(parsed, 'max-cycles') }),
  });
  if (context.json) {
    output.print(JSON.stringify(repositoryContext, null, 2));
    return 0;
  }
  for (const line of renderRepositoryContext(repositoryContext)) output.print(line);
  return 0;
}