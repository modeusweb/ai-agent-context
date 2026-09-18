/**
 * Git activity analysis.
 *
 * Terminology is deliberately neutral: `historicalChanges`, `recentChanges`,
 * `changeFrequency`, `lastChanged`. A frequently changed file is *not* labelled
 * critical — the numbers are reported and the reader decides.
 *
 * All data comes from `git log`, executed locally by GitAdapter.
 */
import type { ChangeFrequency, FileNode, GitFileSignals, GitModuleSignals, ModuleNode } from '../../model/types.ts';
import type { GitCommit } from '../../adapters/git/git-adapter.ts';
import { compareStrings } from '../../model/canonical.ts';
import { formatDate, truncate } from '../../util/text.ts';

const MS_PER_DAY = 86_400_000;

interface FileActivity {
  shas: Set<string>;
  recentShas: Set<string>;
  lastDateMs: number;
  authors: Map<string, number>;
}

export interface GitActivityInput {
  commits: GitCommit[];
  files: FileNode[];
  modules: ModuleNode[];
  /** Window (days) counted as "recent activity". */
  recentDays: number;
  /** Patterns that mark a commit message as an architectural change signal. */
  architectureSignalPatterns: string[];
  /** Injectable clock (tests). */
  now?: number;
}

export interface GitActivityResult {
  fileSignals: Map<string, GitFileSignals>;
  moduleSignals: Map<string, GitModuleSignals>;
  /** Number of commits inspected. */
  commitCount: number;
}

/** Buckets a count against the quantiles of the repository distribution. */
export function bucket(count: number, lowThreshold: number, highThreshold: number): ChangeFrequency {
  if (count <= 0) return 'none';
  if (count >= highThreshold) return 'high';
  if (count >= lowThreshold) return 'medium';
  return 'low';
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

/** Computes per-file and per-module git signals from the parsed commit history. */
export function computeGitActivity(input: GitActivityInput): GitActivityResult {
  const now = input.now ?? Date.now();
  const recentWindowStart = now - input.recentDays * MS_PER_DAY;
  const moduleByFile = new Map<string, string>();
  for (const module of input.modules) {
    for (const file of module.files) moduleByFile.set(file, module.id);
  }
  const knownFiles = new Set(input.files.map((file) => file.path));

  const fileActivity = new Map<string, FileActivity>();
  const moduleActivity = new Map<string, FileActivity>();
  const architectureSignals = new Map<string, Array<{ sha: string; date: string; subject: string }>>();
  const patterns = input.architectureSignalPatterns.map((pattern) => pattern.toLowerCase());

  const ensure = (map: Map<string, FileActivity>, key: string): FileActivity => {
    let record = map.get(key);
    if (record === undefined) {
      record = { shas: new Set(), recentShas: new Set(), lastDateMs: 0, authors: new Map() };
      map.set(key, record);
    }
    return record;
  };

  let commitCount = 0;
  for (const commit of input.commits) {
    commitCount += 1;
    const isRecent = commit.dateMs >= recentWindowStart;
    const touchesArchitecture = patterns.some((pattern) => commit.subject.toLowerCase().includes(pattern));
    const modulesTouched = new Set<string>();

    for (const rawPath of commit.files) {
      const path = rawPath.replace(/\\/g, '/');
      if (!knownFiles.has(path)) continue;
      const activity = ensure(fileActivity, path);
      activity.shas.add(commit.sha);
      if (isRecent) activity.recentShas.add(commit.sha);
      activity.lastDateMs = Math.max(activity.lastDateMs, commit.dateMs);
      activity.authors.set(commit.author, (activity.authors.get(commit.author) ?? 0) + 1);

      const moduleId = moduleByFile.get(path);
      if (moduleId === undefined) continue;
      const moduleRecord = ensure(moduleActivity, moduleId);
      moduleRecord.shas.add(commit.sha);
      if (isRecent) moduleRecord.recentShas.add(commit.sha);
      moduleRecord.lastDateMs = Math.max(moduleRecord.lastDateMs, commit.dateMs);
      moduleRecord.authors.set(commit.author, (moduleRecord.authors.get(commit.author) ?? 0) + 1);
      modulesTouched.add(moduleId);
    }

    if (touchesArchitecture && commit.sha.length > 0) {
      for (const moduleId of modulesTouched) {
        const list = architectureSignals.get(moduleId) ?? [];
        if (list.length < 5) {
          list.push({
            sha: commit.sha.slice(0, 8),
            date: formatDate(commit.dateMs),
            subject: truncate(commit.subject, 120),
          });
        }
        architectureSignals.set(moduleId, list);
      }
    }
  }

  const fileCounts = [...fileActivity.values()].map((activity) => activity.shas.size).sort((a, b) => a - b);
  const moduleCounts = [...moduleActivity.values()].map((activity) => activity.shas.size).sort((a, b) => a - b);
  const fileLow = quantile(fileCounts, 0.33);
  const fileHigh = quantile(fileCounts, 0.66);
  const moduleLow = quantile(moduleCounts, 0.33);
  const moduleHigh = quantile(moduleCounts, 0.66);

  const fileSignals = new Map<string, GitFileSignals>();
  for (const [path, activity] of fileActivity) {
    fileSignals.set(path, {
      historicalChanges: activity.shas.size,
      recentChanges: activity.recentShas.size,
      lastChanged: activity.lastDateMs > 0 ? formatDate(activity.lastDateMs) : null,
      changeFrequency: bucket(activity.shas.size, Math.max(1, fileLow), Math.max(2, fileHigh)),
      contributorCount: activity.authors.size,
    });
  }

  const moduleSignals = new Map<string, GitModuleSignals>();
  for (const [moduleId, activity] of moduleActivity) {
    const topContributors = [...activity.authors.entries()]
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => (b.commits === a.commits ? compareStrings(a.name, b.name) : b.commits - a.commits))
      .slice(0, 3);
    moduleSignals.set(moduleId, {
      historicalChanges: activity.shas.size,
      recentChanges: activity.recentShas.size,
      lastChanged: activity.lastDateMs > 0 ? formatDate(activity.lastDateMs) : null,
      changeFrequency: bucket(activity.shas.size, Math.max(1, moduleLow), Math.max(2, moduleHigh)),
      contributorCount: activity.authors.size,
      topContributors,
      architectureChangeSignals: architectureSignals.get(moduleId) ?? [],
    });
  }

  return { fileSignals, moduleSignals, commitCount };
}

/** Attaches the computed module signals to the repository modules. */
export function applyGitSignals(modules: ModuleNode[], activity: GitActivityResult): void {
  for (const module of modules) {
    module.git = activity.moduleSignals.get(module.id) ?? null;
  }
}