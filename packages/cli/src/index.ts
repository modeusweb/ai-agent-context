/**
 * Programmatic entry point of the `ai-agent-context` package.
 *
 * The CLI package re-exports the core API so that `import { AgentContext } from
 * "ai-agent-context"` works exactly as documented in the README, while the core
 * remains a separate, CLI-free package.
 */
export * from '@ai-agent-context/core';

export { runCli, parseArguments, contextOptions, flagBoolean, flagList, flagString, CLI_NAME, CLI_VERSION } from './cli.ts';
export type { CliIo, ParsedArguments, CliCommandContext, CliDependencies } from './cli.ts';
export { ConsoleOutput, formatNumber, formatDuration, formatTable } from './ui/console.ts';
export type { ConsoleOptions } from './ui/console.ts';
export {
  renderScanSummary,
  renderStatus,
  renderExplain,
  renderDiff,
  renderRepositoryContext,
  renderSearchResults,
} from './ui/format.ts';
export { runInitCommand } from './commands/init.ts';
export { runScanCommand } from './commands/scan.ts';
export { runDiffCommand } from './commands/diff.ts';
export { runStatusCommand } from './commands/status.ts';
export { runExplainCommand } from './commands/explain.ts';
export { runSearchCommand } from './commands/search.ts';
export { runContextCommand } from './commands/context.ts';
export { runTaskCommand } from './commands/task.ts';
export { runImpactCommand } from './commands/impact.ts';
export { runHistoryCommand } from './commands/history.ts';
export { runRevisionDiffCommand } from './commands/revision-diff.ts';
export { runCleanCommand } from './commands/clean.ts';
