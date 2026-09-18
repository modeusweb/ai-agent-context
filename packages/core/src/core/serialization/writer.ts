/**
 * Deterministic writer for the `.agent/` context.
 *
 * Everything written here is meant to be committed: canonical JSON with sorted
 * keys, a `.gitignore` that keeps the local cache out of version control, and no
 * timestamps unless the user asks for them.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_DIR, AGENT_GITIGNORE, CONTEXT_FILES } from '../../model/schema.ts';
import { sha256, stringifyCanonical } from '../../model/canonical.ts';
import type { AgentContextConfig } from '../../config/types.ts';
import type { ContextDocuments } from './types.ts';

export interface WriteContextResult {
  directory: string;
  /** File name → sha256 of the written content (used for `status`/`diff`). */
  hashes: Record<string, string>;
  written: string[];
}

/** Serializes the documents into the exact byte content of each `.agent` file. */
export function serializeContextDocuments(
  documents: ContextDocuments,
  config: AgentContextConfig,
): Record<string, string> {
  const output: Record<string, string> = {
    'index.json': stringifyCanonical(documents.index, config.output.prettyJson),
    'architecture.json': stringifyCanonical(documents.architecture, config.output.prettyJson),
    'dependencies.json': stringifyCanonical(documents.dependencies, config.output.prettyJson),
    'conventions.json': stringifyCanonical(documents.conventions, config.output.prettyJson),
    'decisions.json': stringifyCanonical(documents.decisions, config.output.prettyJson),
  };
  if (config.output.conventionsMarkdown) output['conventions.md'] = documents.conventionsMarkdown;
  return output;
}

/** Writes `.agent/` (creating it when needed) and returns content hashes. */
export async function writeContext(
  root: string,
  documents: ContextDocuments,
  config: AgentContextConfig,
): Promise<WriteContextResult> {
  const directory = path.join(root, AGENT_DIR);
  await mkdir(path.join(directory, '.local'), { recursive: true });
  const contents = serializeContextDocuments(documents, config);
  const hashes: Record<string, string> = {};
  const written: string[] = [];

  for (const name of CONTEXT_FILES) {
    const content = contents[name];
    if (content === undefined) continue;
    await writeFile(path.join(directory, name), content, 'utf8');
    hashes[name] = sha256(content);
    written.push(name);
  }

  const gitignorePath = path.join(directory, '.gitignore');
  await writeFile(gitignorePath, AGENT_GITIGNORE, 'utf8');
  hashes['.gitignore'] = sha256(AGENT_GITIGNORE);
  written.push('.gitignore');

  return { directory, hashes, written: written.sort() };
}

/** Removes everything under `.agent/` that this tool generated (never source code). */
export async function removeContextDirectory(root: string, options: { keepConfig: boolean }): Promise<string[]> {
  const { rm } = await import('node:fs/promises');
  const directory = path.join(root, AGENT_DIR);
  const removed: string[] = [];
  const generated = [...CONTEXT_FILES, '.gitignore'];
  for (const name of generated) {
    await rm(path.join(directory, name), { force: true });
    removed.push(name);
  }
  await rm(path.join(directory, '.local'), { recursive: true, force: true });
  removed.push('.local/');
  if (!options.keepConfig) {
    await rm(path.join(directory, 'config.json'), { force: true });
    removed.push('config.json');
  }
  return removed.sort();
}