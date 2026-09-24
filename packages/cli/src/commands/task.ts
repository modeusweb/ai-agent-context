import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';

export async function runTaskCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const task = parsed.positional.join(' ').trim();
  if (task.length === 0) {
    output.error('task requires a description, for example: agent-context task "add payment retries"');
    return 2;
  }
  const target = flagString(parsed, 'target');
  const rawLimit = flagString(parsed, 'max-modules');
  const maxModules = rawLimit === undefined ? 5 : Number.parseInt(rawLimit, 10);
  if (Number.isNaN(maxModules) || maxModules <= 0) {
    output.error(`--max-modules must be a positive integer (received: ${rawLimit ?? ''})`);
    return 2;
  }
  const payload = await (await dependencies.createContext(contextOptions(parsed, io))).getTaskContext(task, {
    maxModules,
    ...(target === undefined ? {} : { target }),
  });
  if (context.json) {
    output.print(JSON.stringify(payload, null, 2));
    return 0;
  }
  output.heading(`Task context: ${task}`);
  output.blank();
  for (const module of payload.modules) {
    output.print(`${module.id} — ${module.summary}`);
    const evidence = module.evidence[0];
    if (evidence !== undefined) output.note(`  evidence: ${evidence.source} — ${evidence.detail}`);
  }
  output.blank();
  output.note(`${payload.modules.length} module(s) · ${payload.conventions.length} convention(s) · ${payload.decisions.length} decision(s)`);
  return 0;
}
