/** Payload shapes of the context projections (canonical, serializable). */
import type { Detection, EntryPoint, GitModuleSignals, ModuleBasis, ModuleRole } from '../../model/types.ts';

export interface ContextCommand {
  name: string;
  /** Ready to paste command line. */
  command: string;
  /** The raw npm script body. */
  script: string;
  /** `root` or the workspace package name. */
  scope: string;
}

export interface RepositoryContextPayload {
  schemaVersion: number;
  generatedBy: string;
  repository: {
    name: string;
    languages: string[];
    fileCount: number;
    sourceFileCount: number;
    testFileCount: number;
    moduleCount: number;
    symbolCount: number;
    dependencyCount: number;
    entryPointCount: number;
  };
  workspace: {
    isMonorepo: boolean;
    model: string;
    packageManager: string;
    packageManagerEvidence: Array<{ source: string; detail: string }>;
    lockfiles: string[];
    packages: Array<{
      name: string;
      path: string;
      version: string | null;
      private: boolean;
      runtimeDependencies: number;
      developmentDependencies: number;
    }>;
  };
  commands: ContextCommand[];
  modules: Array<{
    id: string;
    path: string;
    basis: ModuleBasis;
    files: number;
    roles: Detection<ModuleRole>[];
    dependsOn: string[];
    usedBy: string[];
    entryPoints: string[];
    publicExports: string[];
    git: GitModuleSignals | null;
  }>;
  entryPoints: EntryPoint[];
  externalDependencies: Array<{
    name: string;
    scope: string;
    declaredBy: string[];
    importedByModules: number;
    importance: Detection;
  }>;
  conventions: Array<{ id: string; category: string; statement: string; confidence: number }>;
  decisions: Array<{ id: string; title: string; status: string; origin: string; source: string }>;
  cycles: string[][];
  diagnostics: {
    parsedFiles: number;
    sensitiveSkipped: number;
    partialParses: string[];
    failedParses: string[];
    unresolvedImports: Array<{ file: string; specifier: string; attempts: string[] }>;
  };
  notes: string[];
}

/** Short alias used by the public API. */
export type RepositoryContext = RepositoryContextPayload;