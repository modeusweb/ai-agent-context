/**
 * `agent-context clean` — remove generated context and local caches.
 *
 * Safety rules:
 * - only ever touches paths inside `.agent/`: source code is never a candidate;
 * - destructive operations require explicit confirmation (`--yes`);
 * - `--cache` is the narrow option: it clears only the local parse cache.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AGENT_DIR, ParseCache, removeContextDirectory } from '@ai-agent-context/core';
import type { CliCommandContext, CliDependencies } from '../cli.ts';
import { flagBoolean, contextOptions } from '../cli.ts';

export async function runCleanCommand(context: CliCommandContext, dependencies: CliDependencies): Promise<number> {
  const { output, parsed, io } = context;
  const agentContext = await dependencies.createContext(contextOptions(parsed, io));
  const root = agentContext.root;
  const cacheOnly = flagBoolean(parsed, 'cache');
  const confirmed = flagBoolean(parsed, 'yes');
  const removeConfig = flagBoolean(parsed, 'all');

  if (!existsSync(path.join(root, AGENT_DIR))) {
    output.print('Nothing to clean: .agent/ does not exist.');
    return 0;
  }

  if (!cacheOnly && !confirmed) {
    output.warn('This removes the generated context inside .agent/. Source code is never touched.');
    output.note('Confirm with --yes, or clear only the local cache with --cache.');
    output.print('');
    output.print('Usage: agent-context clean [--cache] [--all] [--yes]');
    return 2;
  }

  const removed: string[] = [];
  if (cacheOnly) {
    await new ParseCache(root).clear();
    removed.push('.agent/.local/cache/');
  } else {
    removed.push(...(await removeContextDirectory(root, { keepConfig: !removeConfig })));
  }
  removed.sort();

  if (context.json) {
    output.print(JSON.stringify({ root, removed, cacheOnly, removedConfig: !cacheOnly && removeConfig }, null, 2));
    return 0;
  }
  output.success(`Removed ${removed.length} path(s) inside .agent/:`);
  output.list(removed);
  if (!cacheOnly) {
    output.blank();
    output.print('Run:');
    output.print('  agent-context scan      # regenerate the context');
  }
  return 0;
}