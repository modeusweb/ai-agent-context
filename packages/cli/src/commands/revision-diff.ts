import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { contextOptions, flagString } from '../cli.ts';

export async function runRevisionDiffCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const revision = flagString(parsed, 'revision');
  if (revision === undefined) return (output.error('revision-diff requires --revision <ref>'), 2);
  const payload = await (await dependencies.createContext(contextOptions(parsed, io))).getRevisionDiff(revision, flagString(parsed, 'base') ?? 'HEAD');
  if (context.json) { output.print(JSON.stringify(payload, null, 2)); return 0; }
  output.heading(`Revision diff: ${payload.revision}`);
  output.blank();
  for (const file of payload.files) output.print(`${file.status}\t${file.path}`);
  return 0;
}
