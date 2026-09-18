/** `agent-context explain <path>` — structured module context. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderExplain, renderRepositoryContext } from '../ui/format.ts';

export async function runExplainCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const target = parsed.positional[0];

  if (target === undefined) {
    const repositoryContext = await agentContext.getRepositoryContext();
    if (context.json) {
      output.print(JSON.stringify(repositoryContext, null, 2));
      return 0;
    }
    for (const line of renderRepositoryContext(repositoryContext)) output.print(line);
    return 0;
  }

  const explanation = await agentContext.explain(target);
  if (explanation === null) {
    output.error(`cannot explain "${target}": no module or file matched.`);
    const modules = await agentContext.getModules();
    const suggestions = modules
      .filter((module) => module.id.includes(target) || module.path.includes(target))
      .slice(0, 5)
      .map((module) => module.id);
    if (suggestions.length > 0) {
      output.note('Did you mean one of these?');
      for (const suggestion of suggestions) output.note(`  ${suggestion}`);
    } else {
      output.note('Run: agent-context context   # list the detected modules');
    }
    return 1;
  }

  if (context.json) {
    output.print(JSON.stringify(explanation, null, 2));
    return 0;
  }

  for (const line of renderExplain(explanation)) output.print(line);
  return 0;
}