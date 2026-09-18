/**
 * Entry point detection.
 *
 * Sources of truth, in order of strength:
 * 1. declared `package.json` fields (`main`, `module`, `exports`, `bin`);
 * 2. npm scripts that reference a file (`start`, `dev`, `test`, ...);
 * 3. naming conventions (`cli.ts`, `server.ts`, `main.ts`, `index.ts`);
 * 4. behavioural signals (HTTP routes registered, workers started).
 *
 * Every entry point reports confidence and the evidence that produced it.
 */
import type { EntryPoint, EntryPointType, FileNode, WorkspaceInfo } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { SIGNALS } from '../../adapters/language/types.ts';
import { CONFIDENCE } from '../../model/schema.ts';
import { compareStrings } from '../../model/canonical.ts';
import { basename, dirname, join, normalizeRelative, stem } from '../../util/paths.ts';
import { truncate } from '../../util/text.ts';
import { withExtensions } from '../graph/resolver.ts';

const CLI_STEM = /^(cli|bin|command|commands)([-_.].*)?$/i;
const APPLICATION_STEM = /^(index|main|server|app|bootstrap|start)$/i;
const WORKER_STEM = /^(worker|workers|job|jobs|scheduler|consumer)([-_.].*)?$/i;
const SCRIPT_FILE_PATTERN = /[\w./@-]+\.(?:[cm]?[jt]sx?)/g;

export interface EntryPointInput {
  workspace: WorkspaceInfo;
  files: FileNode[];
  parsed: Map<string, ParsedFile>;
}

function manifestPath(packageDirectory: string): string {
  return packageDirectory.length === 0 ? 'package.json' : `${packageDirectory}/package.json`;
}

/** `true` when a path sits directly in the package root or its `src` directory. */
function isSourceRootLevel(filePath: string, packageDirectory: string): boolean {
  const directory = normalizeRelative(dirname(filePath));
  const root = normalizeRelative(packageDirectory);
  const candidates = new Set([root, root.length === 0 ? 'src' : `${root}/src`]);
  return candidates.has(directory);
}

export function detectEntryPoints(input: EntryPointInput): EntryPoint[] {
  const results: EntryPoint[] = [];
  const resolvable = new Set(input.files.map((file) => file.path));
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));

  const add = (entry: EntryPoint): void => {
    const exists = results.some((candidate) => candidate.path === entry.path && candidate.type === entry.type);
    if (!exists) results.push(entry);
  };

  // 1. declared package.json fields
  for (const workspacePackage of input.workspace.packages) {
    const manifest = manifestPath(workspacePackage.path);
    for (const declared of workspacePackage.entries) {
      if (declared.field === 'types') continue;
      const raw = declared.value.replace(/^\.\//, '');
      const type: EntryPointType =
        declared.field === 'bin' ? 'package-bin' : declared.field === 'exports' ? 'package-export' : 'package-main';
      const resolved = withExtensions(join(workspacePackage.path, raw), resolvable);
      if (resolved !== null) {
        add({
          path: resolved,
          moduleId: fileByPath.get(resolved)?.moduleId ?? null,
          type,
          confidence: CONFIDENCE.declared,
          evidence: [{ source: manifest, detail: `package.json "${declared.field}" points here (${declared.value})` }],
          details: `declared by ${workspacePackage.name}`,
        });
      } else if (!raw.includes('*')) {
        add({
          path: normalizeRelative(join(workspacePackage.path, raw)),
          moduleId: null,
          type,
          confidence: 0.6,
          evidence: [
            {
              source: manifest,
              detail: `package.json "${declared.field}" points here (${declared.value}), but the file is not in the analyzed tree`,
            },
          ],
          details: `declared by ${workspacePackage.name}`,
        });
      }
    }
  }

  // 2. npm scripts that reference a file
  const scriptNames = (scripts: Record<string, string>): Array<[string, string]> =>
    Object.entries(scripts).sort((a, b) => compareStrings(a[0], b[0]));
  for (const workspacePackage of input.workspace.packages) {
    const manifest = manifestPath(workspacePackage.path);
    for (const [scriptName, command] of scriptNames(workspacePackage.scripts)) {
      const matches = command.match(SCRIPT_FILE_PATTERN) ?? [];
      for (const candidate of matches) {
        if (candidate.includes('node_modules')) continue;
        const resolved = withExtensions(join(workspacePackage.path, candidate), resolvable);
        if (resolved === null) continue;
        const fileStem = stem(resolved);
        const type: EntryPointType =
          /test|spec/.test(scriptName) || /test|spec/.test(fileStem)
            ? 'test'
            : CLI_STEM.test(fileStem)
              ? 'cli'
              : /^(start|dev|serve|preview|run)$/.test(scriptName)
                ? 'application'
                : 'library';
        add({
          path: resolved,
          moduleId: fileByPath.get(resolved)?.moduleId ?? null,
          type,
          confidence: 0.85,
          evidence: [{ source: manifest, detail: `npm script "${scriptName}" runs this file: ${truncate(command, 120)}` }],
          details: `script "${scriptName}"`,
        });
      }
    }
  }

  // 3. naming conventions and behavioural signals
  for (const file of input.files) {
    if (file.kind === 'config' || file.kind === 'docs' || file.kind === 'asset') continue;
    const facts = input.parsed.get(file.path);
    const fileStem = stem(file.path);
    const moduleId = file.moduleId;

    if (file.kind === 'test') {
      add({
        path: file.path,
        moduleId,
        type: 'test',
        confidence: 0.95,
        evidence: [{ source: file.path, detail: 'file name matches the test conventions of the repository' }],
      });
      continue;
    }

    if (facts !== undefined && facts.routes.length > 0) {
      const preview = facts.routes.slice(0, 4).map((route) => `${route.method} ${route.path}`).join(', ');
      add({
        path: file.path,
        moduleId,
        type: 'http-routes',
        confidence: 0.87,
        evidence: [{ source: file.path, detail: `registers HTTP routes: ${preview}` }],
      });
    }

    if (facts !== undefined && (facts.signals.includes(SIGNALS.worker) || facts.signals.includes(SIGNALS.schedule))) {
      add({
        path: file.path,
        moduleId,
        type: 'worker',
        confidence: 0.7,
        evidence: [
          {
            source: file.path,
            detail: `background work signals: ${facts.signals
              .filter((signal) => signal.startsWith('worker:') || signal.startsWith('schedule:'))
              .join(', ')}`,
          },
        ],
      });
    }

    if (CLI_STEM.test(fileStem) || (facts !== undefined && facts.signals.includes(SIGNALS.cliFramework))) {
      add({
        path: file.path,
        moduleId,
        type: 'cli',
        confidence: facts?.signals.includes(SIGNALS.cliFramework) === true ? 0.85 : 0.8,
        evidence: [{ source: file.path, detail: `entry naming matches CLI conventions ("${basename(file.path)}")` }],
      });
      continue;
    }

    if (WORKER_STEM.test(fileStem)) {
      add({
        path: file.path,
        moduleId,
        type: 'worker',
        confidence: 0.7,
        evidence: [{ source: file.path, detail: `entry naming matches worker conventions ("${basename(file.path)}")` }],
      });
      continue;
    }

    const owningPackageName = input.workspace.packages.find((entry) =>
      entry.path.length === 0 ? true : file.path.startsWith(`${entry.path}/`),
    )?.name;
    const workspacePackage = input.workspace.packages.find((entry) => entry.name === owningPackageName);
    if (
      workspacePackage !== undefined &&
      isSourceRootLevel(file.path, workspacePackage.path) &&
      APPLICATION_STEM.test(fileStem)
    ) {
      const type: EntryPointType = fileStem === 'index' && (facts?.exports.length ?? 0) === 0 ? 'library' : 'application';
      add({
        path: file.path,
        moduleId,
        type,
        confidence: fileStem === 'index' ? 0.7 : 0.85,
        evidence: [
          { source: file.path, detail: `entry naming convention at the source root ("${basename(file.path)}")` },
        ],
        details: facts !== undefined && facts.routes.length > 0 ? 'registers HTTP routes' : undefined,
      });
      continue;
    }

    if (fileStem === 'index' && moduleId !== null && moduleId !== file.path) {
      add({
        path: file.path,
        moduleId,
        type: 'library',
        confidence: 0.65,
        evidence: [{ source: file.path, detail: 'module barrel file (index.*) re-exporting the module surface' }],
      });
    }
  }

  return results.sort((a, b) => (a.path === b.path ? compareStrings(a.type, b.type) : compareStrings(a.path, b.path)));
}