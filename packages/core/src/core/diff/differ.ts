/**
 * Context differ.
 *
 * Compares the previously persisted `.agent/` context with the freshly computed
 * one and answers the questions an engineer has before committing: which files
 * changed, which modules appeared, which architectural dependency moved, which
 * conventions/decisions changed.
 *
 * Wording stays neutral: no "critical", no "unsafe" — just what changed.
 */
import type { ContextDiff } from '../../model/types.ts';
import { compareStrings, hashValue } from '../../model/canonical.ts';
import type { PersistedContext } from '../serialization/reader.ts';
import type { ContextDocuments } from '../serialization/types.ts';

function difference(current: readonly string[], previous: readonly string[]): string[] {
  const previousSet = new Set(previous);
  return [...current].filter((entry) => !previousSet.has(entry)).sort(compareStrings);
}

function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from} -> ${edge.to}`;
}

export interface DiffOptions {
  /** Previously persisted context; `null` when there is nothing to compare against. */
  previous: PersistedContext | null;
  /** Freshly computed documents. */
  current: ContextDocuments;
  /** Hash of the previous canonical context (from the local state). */
  baselineHash?: string | null;
}

function emptyDiff(current: ContextDocuments, baseline: string | null): ContextDiff {
  return {
    files: { added: [], modified: [], removed: [] },
    modules: { added: [], removed: [], roleChanges: [] },
    entryPoints: { added: [], removed: [] },
    dependencies: { added: [], removed: [], externalAdded: [], externalRemoved: [] },
    conventions: { added: [], removed: [], changed: [] },
    decisions: { added: [], removed: [] },
    statistics: {
      files: current.index.repository.counts.files,
      modules: current.index.repository.counts.modules,
      dependencies: current.index.repository.counts.dependencies,
      entries: current.index.repository.counts.entryPoints,
    },
    hasChanges: false,
    baseline,
  };
}

/** Computes the context diff. */
export function diffContext(options: DiffOptions): ContextDiff {
  const { previous, current } = options;
  const baseline = options.baselineHash ?? null;
  if (previous === null || previous.index === null) return emptyDiff(current, baseline);

  const previousFiles = new Map(previous.index.files.entries.map((entry) => [entry.path, entry.hash]));
  const currentFiles = new Map(current.index.files.entries.map((entry) => [entry.path, entry.hash]));
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const [file, hash] of currentFiles) {
    const before = previousFiles.get(file);
    if (before === undefined) addedFiles.push(file);
    else if (before !== hash) modifiedFiles.push(file);
  }
  const removedFiles = [...previousFiles.keys()].filter((file) => !currentFiles.has(file));

  const previousModules = new Map((previous.architecture?.modules ?? []).map((module) => [module.id, module]));
  const currentModules = new Map(current.architecture.modules.map((module) => [module.id, module]));
  const modulesAdded = difference([...currentModules.keys()], [...previousModules.keys()]);
  const modulesRemoved = difference([...previousModules.keys()], [...currentModules.keys()]);
  const roleChanges: ContextDiff['modules']['roleChanges'] = [];
  for (const [id, module] of currentModules) {
    const before = previousModules.get(id);
    if (before === undefined) continue;
    const beforeRoles = before.roles.map((role) => role.value);
    const afterRoles = module.roles.map((role) => role.value);
    const addedRoles = difference(afterRoles, beforeRoles);
    const removedRoles = difference(beforeRoles, afterRoles);
    if (addedRoles.length > 0 || removedRoles.length > 0) {
      roleChanges.push({ moduleId: id, added: addedRoles, removed: removedRoles });
    }
  }
  roleChanges.sort((a, b) => compareStrings(a.moduleId, b.moduleId));

  const previousEntries = (previous.architecture?.entryPoints ?? []).map((entry) => `${entry.path} (${entry.type})`);
  const currentEntries = current.architecture.entryPoints.map((entry) => `${entry.path} (${entry.type})`);

  const previousEdges = (previous.dependencies?.internal ?? []).map((edge) => edgeKey(edge));
  const currentEdges = current.dependencies.internal.map((edge) => edgeKey(edge));
  const addedEdgeKeys = difference(currentEdges, previousEdges);
  const removedEdgeKeys = difference(previousEdges, currentEdges);
  const currentEdgeByKey = new Map(current.dependencies.internal.map((edge) => [edgeKey(edge), edge]));
  const previousEdgeByKey = new Map((previous.dependencies?.internal ?? []).map((edge) => [edgeKey(edge), edge]));

  const previousExternal = (previous.dependencies?.external ?? []).map((entry) => entry.name);
  const currentExternal = current.dependencies.external.map((entry) => entry.name);

  const previousConventions = new Map(
    (previous.conventions?.conventions ?? []).map((entry) => [entry.id, entry.statement]),
  );
  const currentConventions = new Map(current.conventions.conventions.map((entry) => [entry.id, entry.statement]));
  const conventionsChanged: string[] = [];
  for (const [id, statement] of currentConventions) {
    const before = previousConventions.get(id);
    if (before !== undefined && before !== statement) {
      conventionsChanged.push(`${id}: "${before}" → "${statement}"`);
    }
  }

  const previousDecisions = (previous.decisions?.decisions ?? []).map((entry) => `${entry.id} ${entry.title}`);
  const currentDecisions = current.decisions.decisions.map((entry) => `${entry.id} ${entry.title}`);

  const diff: ContextDiff = {
    files: {
      added: addedFiles.sort(compareStrings),
      modified: modifiedFiles.sort(compareStrings),
      removed: removedFiles.sort(compareStrings),
    },
    modules: { added: modulesAdded, removed: modulesRemoved, roleChanges },
    entryPoints: {
      added: difference(currentEntries, previousEntries),
      removed: difference(previousEntries, currentEntries),
    },
    dependencies: {
      added: addedEdgeKeys.flatMap((key) => {
        const edge = currentEdgeByKey.get(key);
        return edge === undefined
          ? []
          : [{ from: edge.from, to: edge.to, relationship: 'depends-on' as const, kind: edge.kind }];
      }),
      removed: removedEdgeKeys.flatMap((key) => {
        const edge = previousEdgeByKey.get(key);
        return edge === undefined
          ? []
          : [{ from: edge.from, to: edge.to, relationship: 'depends-on' as const, kind: edge.kind }];
      }),
      externalAdded: difference(currentExternal, previousExternal),
      externalRemoved: difference(previousExternal, currentExternal),
    },
    conventions: {
      added: difference([...currentConventions.keys()], [...previousConventions.keys()]),
      removed: difference([...previousConventions.keys()], [...currentConventions.keys()]),
      changed: conventionsChanged.sort(compareStrings),
    },
    decisions: {
      added: difference(currentDecisions, previousDecisions),
      removed: difference(previousDecisions, currentDecisions),
    },
    statistics: {
      files: current.index.repository.counts.files,
      modules: current.index.repository.counts.modules,
      dependencies: current.index.repository.counts.dependencies,
      entries: current.index.repository.counts.entryPoints,
    },
    hasChanges: false,
    baseline,
  };

  diff.hasChanges =
    diff.files.added.length > 0 ||
    diff.files.modified.length > 0 ||
    diff.files.removed.length > 0 ||
    diff.modules.added.length > 0 ||
    diff.modules.removed.length > 0 ||
    diff.modules.roleChanges.length > 0 ||
    diff.entryPoints.added.length > 0 ||
    diff.entryPoints.removed.length > 0 ||
    diff.dependencies.added.length > 0 ||
    diff.dependencies.removed.length > 0 ||
    diff.dependencies.externalAdded.length > 0 ||
    diff.dependencies.externalRemoved.length > 0 ||
    diff.conventions.added.length > 0 ||
    diff.conventions.removed.length > 0 ||
    diff.conventions.changed.length > 0 ||
    diff.decisions.added.length > 0 ||
    diff.decisions.removed.length > 0;

  return diff;
}

/** Stable hash of the generated documents, stored locally as the diff baseline. */
export function hashDocuments(documents: ContextDocuments): string {
  return hashValue({
    index: { ...documents.index, generatedAt: undefined },
    architecture: { ...documents.architecture, generatedAt: undefined },
    dependencies: { ...documents.dependencies, generatedAt: undefined },
    conventions: { ...documents.conventions, generatedAt: undefined },
    decisions: { ...documents.decisions, generatedAt: undefined },
  });
}