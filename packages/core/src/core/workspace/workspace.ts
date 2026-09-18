/**
 * Workspace and package manager detection.
 *
 * A lockfile is a *repository signal*, not proof of how the project is built or
 * run, so every conclusion here carries evidence and the wording stays neutral.
 * Supported workspace models: npm, yarn, pnpm, bun.
 */
import type { Evidence, WorkspaceInfo, WorkspacePackage } from '../../model/types.ts';
import type { PackageFacts } from '../../adapters/language/package-json/adapter.ts';
import { compileGlob } from '../../util/glob.ts';
import { dirname, normalizeRelative } from '../../util/paths.ts';
import { compareStrings } from '../../model/canonical.ts';

export const LOCKFILE_CANDIDATES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

export interface WorkspaceInput {
  /** Facts of every parsed package.json, keyed by repository-relative path. */
  packageJsonFiles: Array<{ path: string; facts: PackageFacts }>;
  /** Repository-relative file names that exist in the working tree. */
  presentFiles: Set<string>;
  /** Contents of `pnpm-workspace.yaml`, when present. */
  pnpmWorkspaceYaml?: string | null;
}

function toWorkspacePackage(relativePath: string, facts: PackageFacts): WorkspacePackage {
  const directory = normalizeRelative(dirname(relativePath));
  return {
    name: facts.name ?? (directory.length === 0 ? 'root' : (directory.split('/').pop() ?? 'root')),
    path: directory,
    version: facts.version,
    private: facts.private,
    type: facts.type,
    runtimeDependencies: facts.dependencies,
    developmentDependencies: facts.devDependencies,
    peerDependencies: facts.peerDependencies,
    scripts: facts.scripts,
    entries: facts.entries,
  };
}

/** Workspace globs declared by pnpm-workspace.yaml (`packages:` list). */
export function parsePnpmWorkspaceYaml(contents: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^[A-Za-z]/.test(line)) {
      inPackages = /^packages\s*:/.test(line.trim());
      continue;
    }
    if (!inPackages) continue;
    const match = /^\s*-\s*['"]?([^'"#]+)['"]?\s*(#.*)?$/.exec(line);
    if (match === null) continue;
    const value = match[1]!.trim();
    if (value.length > 0) globs.push(value);
  }
  return globs;
}

interface PackageManagerSignal {
  manager: WorkspaceInfo['packageManager'];
  evidence: Evidence[];
}

function managerForLockfile(lockfile: string): WorkspaceInfo['packageManager'] {
  if (lockfile.startsWith('package-lock') || lockfile === 'npm-shrinkwrap.json') return 'npm';
  if (lockfile === 'pnpm-lock.yaml') return 'pnpm';
  if (lockfile === 'yarn.lock') return 'yarn';
  return 'bun';
}

function detectPackageManager(input: WorkspaceInput, rootFacts: PackageFacts | null): PackageManagerSignal {
  const evidence: Evidence[] = [];
  const candidates = new Set<WorkspaceInfo['packageManager']>();
  for (const lockfile of LOCKFILE_CANDIDATES) {
    if (!input.presentFiles.has(lockfile)) continue;
    candidates.add(managerForLockfile(lockfile));
    evidence.push({
      source: lockfile,
      detail: 'lockfile present (repository signal only, not proof of runtime usage)',
    });
  }
  if (input.presentFiles.has('pnpm-workspace.yaml')) {
    candidates.add('pnpm');
    evidence.push({ source: 'pnpm-workspace.yaml', detail: 'pnpm workspace definition present' });
  }

  const declared = rootFacts?.packageManager ?? null;
  if (declared !== null) {
    const manager = declared.split('@')[0] as WorkspaceInfo['packageManager'];
    if (manager !== 'npm' && manager !== 'pnpm' && manager !== 'yarn' && manager !== 'bun') {
      evidence.push({ source: 'package.json', detail: `unknown packageManager field "${declared}"` });
    } else {
      evidence.push({ source: 'package.json', detail: `package.json declares packageManager "${declared}"` });
      if (candidates.size > 1) {
        evidence.push({ source: 'package.json', detail: 'multiple lockfiles present; the declared packageManager wins' });
      }
      return { manager, evidence };
    }
  }

  if (candidates.size === 1) return { manager: [...candidates][0]!, evidence };
  if (candidates.size > 1) {
    evidence.push({
      source: '<repository>',
      detail: `multiple package managers detected (${[...candidates].sort(compareStrings).join(', ')}); reported as unknown`,
    });
    return { manager: 'unknown', evidence };
  }
  evidence.push({ source: '<repository>', detail: 'no lockfile or packageManager field found' });
  return { manager: 'unknown', evidence };
}

/** Builds the {@link WorkspaceInfo} of a repository (single package or monorepo). */
export function detectWorkspace(input: WorkspaceInput): WorkspaceInfo {
  const rootEntry = input.packageJsonFiles.find((entry) => entry.path === 'package.json');
  const rootFacts = rootEntry?.facts ?? null;
  const lockfiles = LOCKFILE_CANDIDATES.filter((candidate) => input.presentFiles.has(candidate));
  const managerSignal = detectPackageManager(input, rootFacts);

  const pnpmGlobs = input.pnpmWorkspaceYaml ? parsePnpmWorkspaceYaml(input.pnpmWorkspaceYaml) : [];
  const declaredGlobs = [...new Set([...(rootFacts?.workspaces ?? []), ...pnpmGlobs])].sort(compareStrings);
  const hasWorkspaces = declaredGlobs.length > 0;

  const workspaceModel: WorkspaceInfo['workspaceModel'] = !hasWorkspaces
    ? 'single-package'
    : pnpmGlobs.length > 0
      ? 'pnpm-workspaces'
      : managerSignal.manager === 'yarn'
        ? 'yarn-workspaces'
        : managerSignal.manager === 'bun'
          ? 'bun-workspaces'
          : 'npm-workspaces';

  const matchers = declaredGlobs.map((glob) => compileGlob(glob.endsWith('/') ? `${glob}**` : glob));
  const packages: WorkspacePackage[] = [];
  for (const entry of input.packageJsonFiles) {
    if (entry.path === 'package.json') continue;
    if (entry.path.split('/').includes('node_modules')) continue;
    if (!hasWorkspaces) continue;
    const directory = normalizeRelative(dirname(entry.path));
    if (matchers.some((match) => match(directory))) packages.push(toWorkspacePackage(entry.path, entry.facts));
  }
  if (!hasWorkspaces && rootFacts !== null) packages.push(toWorkspacePackage('package.json', rootFacts));
  packages.sort((a, b) => compareStrings(a.path, b.path));

  return {
    packageManager: managerSignal.manager,
    packageManagerEvidence: [...managerSignal.evidence].sort((a, b) => compareStrings(a.source, b.source)),
    lockfiles: [...lockfiles].sort(compareStrings),
    isMonorepo: hasWorkspaces,
    workspaceModel,
    workspaceGlobs: declaredGlobs,
    rootPackage: rootFacts !== null ? toWorkspacePackage('package.json', rootFacts) : null,
    packages,
  };
}

/** Nearest workspace package for a file path, when the file lives inside one. */
export function owningPackage(info: WorkspaceInfo, filePath: string): WorkspacePackage | null {
  const normalized = normalizeRelative(filePath);
  const candidates = [...info.packages].sort((a, b) => b.path.length - a.path.length);
  for (const entry of candidates) {
    if (entry.path.length === 0) return entry;
    if (normalized.startsWith(`${entry.path}/`)) return entry;
  }
  return null;
}

/** Maps workspace package directories to their package names. */
export function packageNameByDirectory(info: WorkspaceInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of info.packages) map.set(normalizeRelative(entry.path), entry.name);
  return map;
}

/** Package names declared as internal workspaces, used for dependency classification. */
export function workspacePackageNames(info: WorkspaceInfo): string[] {
  return info.packages.map((entry) => entry.name).sort(compareStrings);
}