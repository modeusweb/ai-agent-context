/** `agent-context scan` — analyze the repository and update `.agent/`. */
import { flagBoolean, type CliCommandContext, type CliDependencies } from '../cli.ts';
import { contextOptions } from '../cli.ts';
import { renderScanSummary } from '../ui/format.ts';
import { Logger } from '@ai-agent-context/core';

export async function runScanCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const options = contextOptions(parsed, io);
  options.logger = new Logger({
    level: output.verbose ? 'verbose' : output.quiet ? 'silent' : 'info',
    sink: (line: string) => output.note(line),
  });
  if (!output.quiet && !context.json) options.progress = (event) => output.note(event.message);

  const agentContext = await dependencies.createContext(options);
  const report = await agentContext.scan({ force: flagBoolean(parsed, 'force') });

  if (context.json) {
    output.print(JSON.stringify(report, null, 2));
    return report.files.failed > 0 && report.files.total === 0 ? 1 : 0;
  }

  output.success(`Analyzed ${report.files.total} files.`);
  for (const line of renderScanSummary(report)) output.print(line);
  output.blank();
  output.print('Context updated:');
  output.list(['.agent/index.json', '.agent/architecture.json', '.agent/dependencies.json', '.agent/conventions.md', '.agent/decisions.json']);
  if (!output.quiet) {
    output.blank();
    output.print('Next:');
    output.print('  agent-context diff      # review the context changes');
    output.print('  agent-context explain <path>');
  }
  return 0;
}