/** `agent-context diff` — repository context changes since the persisted scan. */
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderDiff } from '../ui/format.ts';

export async function runDiffCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const diff = await agentContext.diff();

  if (context.json) {
    output.print(JSON.stringify(diff, null, 2));
    return 0;
  }

  for (const line of renderDiff(diff)) output.print(line);
  output.blank();
  if (diff.hasChanges) {
    output.note(`Baseline: ${diff.baseline ?? 'no local state (first run)'}`);
    output.print('Run:');
    output.print('  agent-context scan      # persist the new context');
  } else {
    output.print('Context matches the working tree.');
  }
  return 0;
}