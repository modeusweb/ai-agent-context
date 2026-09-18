/**
 * Reader for previously generated `.agent/` context.
 *
 * Reading is tolerant: a missing or unparsable file becomes a warning, never a
 * crash, and a schema version mismatch is reported explicitly so the CLI can tell
 * the user to re-run `scan`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_DIR, CONTEXT_FILES, SCHEMA_VERSION } from '../../model/schema.ts';
import type {
  ArchitectureDocument,
  ConventionsDocument,
  DecisionsDocument,
  DependenciesDocument,
  IndexDocument,
} from './types.ts';

export interface PersistedContext {
  index: IndexDocument | null;
  architecture: ArchitectureDocument | null;
  dependencies: DependenciesDocument | null;
  conventions: ConventionsDocument | null;
  decisions: DecisionsDocument | null;
  /** Files that do not exist yet. */
  missing: string[];
  /** Files that exist but could not be used (invalid JSON or schema mismatch). */
  invalid: Array<{ file: string; reason: string }>;
}

const EMPTY: PersistedContext = {
  index: null,
  architecture: null,
  dependencies: null,
  conventions: null,
  decisions: null,
  missing: [],
  invalid: [],
};

async function readJson<T>(root: string, name: string, result: PersistedContext): Promise<T | null> {
  const target = path.join(root, AGENT_DIR, name);
  let contents: string;
  try {
    contents = await readFile(target, 'utf8');
  } catch {
    result.missing.push(name);
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as { schemaVersion?: number };
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      result.invalid.push({
        file: name,
        reason: `schema version ${String(parsed.schemaVersion)} is not supported (expected ${SCHEMA_VERSION})`,
      });
      return null;
    }
    return parsed as T;
  } catch (error) {
    result.invalid.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Reads the persisted context, tolerating missing or damaged files. */
export async function readPersistedContext(root: string): Promise<PersistedContext> {
  const result: PersistedContext = { ...EMPTY, missing: [], invalid: [] };
  result.index = await readJson<IndexDocument>(root, 'index.json', result);
  result.architecture = await readJson<ArchitectureDocument>(root, 'architecture.json', result);
  result.dependencies = await readJson<DependenciesDocument>(root, 'dependencies.json', result);
  result.conventions = await readJson<ConventionsDocument>(root, 'conventions.json', result);
  result.decisions = await readJson<DecisionsDocument>(root, 'decisions.json', result);
  result.missing.sort();
  return result;
}

/** `true` when a usable context exists (index.json with a supported schema). */
export function hasUsableContext(context: PersistedContext): boolean {
  return context.index !== null;
}

/** Names of the canonical files this tool writes. */
export function contextFileNames(): readonly string[] {
  return CONTEXT_FILES;
}