/**
 * Module detection.
 *
 * A "module" is the architectural unit an agent asks about (`explain <path>`).
 * Detection is deliberately explainable — each module records a {@link ModuleBasis}:
 *
 * | basis              | meaning                                                     |
 * | ------------------ | ----------------------------------------------------------- |
 * | `workspace-package`| a workspace package (monorepo package boundary)              |
 * | `index-file`       | a directory exposing an `index.*` / `mod.*` entry file       |
 * | `directory`        | a directory up to `analysis.moduleDepth` deep with >= 2 files|
 * | `single-file`      | a source file that belongs to no detected directory module   |
 */
import type { FileNode, ModuleBasis, ModuleNode, WorkspaceInfo } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { basename, depth, dirname, isInside, normalizeRelative, relativeTo, stem } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';

const ENTRY_NAME_PATTERN = /^(index|mod)\.[cm]?[jt]sx?$/;

export interface ModuleBuildInput {
  workspace: WorkspaceInfo;
  files: FileNode[];
  parsed: Map<string, ParsedFile>;
  /** `analysis.moduleDepth` — how deep automatic directory modules are detected. */
  moduleDepth: number;
}

export interface ModuleBuildResult {
  modules: ModuleNode[];
  fileToModule: Map<string, string>;
}

interface Candidate {
  directory: string;
  basis: Exclude<ModuleBasis, 'single-file'>;
  id: string;
  packageName: string | null;
}

function isModuleFile(file: FileNode): boolean {
  return file.kind === 'source' || file.kind === 'test';
}

/** Directory of the nearest workspace package, or `null` when none contains the path. */
function owningPackageDirectory(workspace: WorkspaceInfo, filePath: string): { directory: string; name: string } | null {
  const candidates = [...workspace.packages].sort((a, b) => b.path.length - a.path.length);
  for (const entry of candidates) {
    if (entry.path.length === 0 || isInside(entry.path, filePath)) {
      return { directory: normalizeRelative(entry.path), name: entry.name };
    }
  }
  return null;
}

export function buildModules(input: ModuleBuildInput): ModuleBuildResult {
  const moduleFiles = input.files.filter(isModuleFile);
  const candidates: Candidate[] = [];
  const takenIds = new Set<string>();

  const addCandidate = (candidate: Candidate): void => {
    if (candidates.some((entry) => entry.directory === candidate.directory)) return;
    let id = candidate.id;
    if (takenIds.has(id)) id = candidate.directory;
    takenIds.add(id);
    candidates.push({ ...candidate, id });
  };

  // 1. workspace packages are always modules
  for (const entry of input.workspace.packages) {
    addCandidate({
      directory: normalizeRelative(entry.path),
      basis: 'workspace-package',
      id: entry.name,
      packageName: entry.name,
    });
  }

  const fileCountByDirectory = new Map<string, number>();
  const directoriesWithEntry = new Set<string>();
  for (const file of moduleFiles) {
    const directory = normalizeRelative(dirname(file.path));
    fileCountByDirectory.set(directory, (fileCountByDirectory.get(directory) ?? 0) + 1);
    if (ENTRY_NAME_PATTERN.test(basename(file.path))) directoriesWithEntry.add(directory);
  }

  // 2. directories exposing an index/mod entry file
  for (const directory of [...directoriesWithEntry].sort(compareStrings)) {
    const ownership = owningPackageDirectory(input.workspace, directory);
    const packageDirectory = ownership?.directory ?? '';
    if (directory === packageDirectory) continue;
    addCandidate({ directory, basis: 'index-file', id: directory, packageName: ownership?.name ?? null });
  }

  // 3. directories up to `moduleDepth` below their package root with >= 2 files
  const sortedDirectories = [...fileCountByDirectory].sort((a, b) => compareStrings(a[0], b[0]));
  for (const [directory, count] of sortedDirectories) {
    if (count < 2) continue;
    const ownership = owningPackageDirectory(input.workspace, directory);
    const packageDirectory = ownership?.directory ?? '';
    const relative = directory.length === 0 ? '' : (relativeTo(packageDirectory, directory) ?? directory);
    const relativeDepth = relative.length === 0 ? 0 : depth(relative);
    if (relativeDepth < 1 || relativeDepth > input.moduleDepth) continue;
    addCandidate({ directory, basis: 'directory', id: directory, packageName: ownership?.name ?? null });
  }

  candidates.sort((a, b) =>
    a.directory.length === b.directory.length
      ? compareStrings(a.directory, b.directory)
      : b.directory.length - a.directory.length,
  );

  const fileToModule = new Map<string, string>();
  const modulesById = new Map<string, ModuleNode>();

  const moduleForFile = (
    file: FileNode,
  ): { id: string; basis: ModuleBasis; directory: string; packageName: string | null } => {
    for (const candidate of candidates) {
      if (candidate.directory.length === 0 || isInside(candidate.directory, file.path)) {
        return {
          id: candidate.id,
          basis: candidate.basis,
          directory: candidate.directory,
          packageName: candidate.packageName,
        };
      }
    }
    return { id: file.path, basis: 'single-file', directory: normalizeRelative(dirname(file.path)), packageName: null };
  };

  for (const file of moduleFiles) {
    const assignment = moduleForFile(file);
    fileToModule.set(file.path, assignment.id);
    let moduleNode = modulesById.get(assignment.id);
    if (moduleNode === undefined) {
      moduleNode = {
        id: assignment.id,
        path: assignment.directory,
        name:
          assignment.basis === 'workspace-package'
            ? assignment.id
            : assignment.basis === 'single-file'
              ? stem(file.path)
              : basename(assignment.directory) || assignment.directory,
        basis: assignment.basis,
        roles: [],
        packageName: assignment.packageName,
        isWorkspacePackage: assignment.basis === 'workspace-package',
        files: [],
        entryPoints: [],
        dependsOn: [],
        usedBy: [],
        publicExports: [],
        boundaries: [],
        signals: [],
        responsibilities: [],
        git: null,
        testFiles: [],
      };
      modulesById.set(assignment.id, moduleNode);
    }
    moduleNode.files.push(file.path);
    if (file.kind === 'test') moduleNode.testFiles.push(file.path);
    const parsed = input.parsed.get(file.path);
    if (parsed !== undefined) {
      for (const signal of parsed.signals) {
        if (!moduleNode.signals.includes(signal)) moduleNode.signals.push(signal);
      }
    }
    file.moduleId = assignment.id;
    file.packageName = assignment.packageName;
  }

  for (const moduleNode of modulesById.values()) {
    if (moduleNode.basis === 'single-file') moduleNode.path = normalizeRelative(dirname(moduleNode.files[0] ?? ''));
    moduleNode.files.sort(compareStrings);
    moduleNode.testFiles.sort(compareStrings);
    moduleNode.signals.sort(compareStrings);
  }

  const modules = [...modulesById.values()].sort((a, b) => compareStrings(a.id, b.id));
  return { modules, fileToModule };
}