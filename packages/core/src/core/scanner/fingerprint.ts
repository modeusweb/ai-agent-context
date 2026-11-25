/**
 * Working-tree fingerprint.
 *
 * `AgentContext` keeps one analysis in memory for as long as it lives, which is
 * what makes repeated queries cheap. That is also what makes a long-lived host
 * dangerous: an MCP session holds one context for its whole lifetime, and the
 * agent using it edits the very repository it describes. Without a way to tell
 * that the tree moved, every answer after the first edit describes a repository
 * that no longer exists — silently, because nothing in the answer says so.
 *
 * The fingerprint is the cheapest signal that can tell: which files the analysis
 * would read, and their size and modification time. No file is opened beyond
 * the ignore files. It is the same walk the scanner performs, evaluated against
 * the same patterns and the same `.gitignore` files, so the fingerprint changes
 * exactly when the set of files the scanner would read changes.
 */
import { hashValue } from '../../model/canonical.ts';
import type { AgentContextConfig } from '../../config/types.ts';
import { FileSystemAdapter } from '../../adapters/filesystem/fs-adapter.ts';
import { buildPatterns } from './scanner.ts';

/** Hash of the files an analysis read, by path, size and modification time. */
export function treeFingerprint(
  files: ReadonlyArray<{ path: string; size: number; mtimeMs: number }>,
): string {
  return hashValue(files.map((file) => `${file.path}\u0000${file.size}\u0000${file.mtimeMs}`));
}

/** Fingerprint of the working tree as the scanner would see it right now. */
export async function workingTreeFingerprint(options: {
  root: string;
  config: AgentContextConfig;
}): Promise<string> {
  const fsAdapter = new FileSystemAdapter(options.root);
  const patterns = buildPatterns(options.config);
  const walked = await fsAdapter.walk({
    include: patterns.include,
    exclude: patterns.exclude,
    ignore: patterns.ignore,
    followSymlinks: options.config.analysis.followSymlinks,
  });
  return treeFingerprint(walked);
}
