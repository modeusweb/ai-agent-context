/**
 * Local (gitignored) incremental scanning state.
 *
 * Two artifacts, both inside `.agent/.local/` so they are never committed:
 * - `state.json` — per file hash/size/mtime plus the last scan timestamp;
 * - `cache/<shard>/<sha256>.json` — content-addressed parse results, so an
 *   unchanged file (or an identical file elsewhere in the repository) is never
 *   parsed twice.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileKind, ParsedFileSnapshot } from './types.ts';
import { AGENT_DIR, LOCAL_DIR, SCHEMA_VERSION, STATE_FILE, GENERATOR_NAME } from '../../model/schema.ts';
import { stringifyCanonical } from '../../model/canonical.ts';

export interface FileStateRecord {
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
  kind: FileKind;
}

export interface LocalStateCounts {
  files: number;
  modules: number;
  dependencies: number;
  entryPoints: number;
  conventions: number;
  decisions: number;
}

export interface LocalState {
  schemaVersion: number;
  generatedBy: string;
  toolVersion: string;
  /** ISO timestamp of the last successful scan (local only, never canonical). */
  lastScanAt: string | null;
  /** Hash of the resolved configuration; a change invalidates the cache. */
  configHash: string;
  counts: LocalStateCounts;
  files: Record<string, FileStateRecord>;
  /** Hashes of the canonical `.agent/*` files as written by the last scan. */
  canonical: Record<string, string>;
}

export function localStatePath(root: string): string {
  return path.join(root, STATE_FILE);
}

export function cacheDirectory(root: string): string {
  return path.join(root, AGENT_DIR, LOCAL_DIR, 'cache');
}

export class LocalStateStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = localStatePath(root);
  }

  get path(): string {
    return this.file;
  }

  async read(): Promise<LocalState | null> {
    try {
      const contents = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(contents) as Partial<LocalState>;
      if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
      return {
        schemaVersion: SCHEMA_VERSION,
        generatedBy: parsed.generatedBy ?? GENERATOR_NAME,
        toolVersion: parsed.toolVersion ?? '0.0.0',
        lastScanAt: parsed.lastScanAt ?? null,
        configHash: parsed.configHash ?? '',
        counts: {
          files: parsed.counts?.files ?? 0,
          modules: parsed.counts?.modules ?? 0,
          dependencies: parsed.counts?.dependencies ?? 0,
          entryPoints: parsed.counts?.entryPoints ?? 0,
          conventions: parsed.counts?.conventions ?? 0,
          decisions: parsed.counts?.decisions ?? 0,
        },
        files: parsed.files ?? {},
        canonical: parsed.canonical ?? {},
      };
    } catch {
      return null;
    }
  }

  async write(state: LocalState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, stringifyCanonical(state), 'utf8');
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

function shardPath(root: string, hash: string): string {
  return path.join(cacheDirectory(root), hash.slice(0, 2), `${hash}.json`);
}

/** Content-addressed cache of parse results. */
export class ParseCache {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get directory(): string {
    return cacheDirectory(this.root);
  }

  async get(hash: string): Promise<ParsedFileSnapshot | null> {
    if (hash.length === 0) return null;
    try {
      const contents = await readFile(shardPath(this.root, hash), 'utf8');
      const parsed = JSON.parse(contents) as { schemaVersion?: number; file?: ParsedFileSnapshot };
      if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.file === undefined) return null;
      return parsed.file;
    } catch {
      return null;
    }
  }

  async put(hash: string, file: ParsedFileSnapshot): Promise<void> {
    if (hash.length === 0) return;
    const target = shardPath(this.root, hash);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, stringifyCanonical({ schemaVersion: SCHEMA_VERSION, file }), 'utf8');
  }

  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}