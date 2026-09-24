/**
 * Canonical `.agent/` documents.
 *
 * The documents are the *machine readable* representation of the graph: JSON with
 * a schema version, deterministic ordering and no timestamps unless explicitly
 * enabled. `conventions.md` is a human projection of `conventions.json`.
 *
 * Document shapes are versioned independently of the in-memory model, so the
 * model can evolve while readers keep working against schema v1.
 */
import type {
  Convention,
  Decision,
  EntryPoint,
  ExternalDependency,
  GitModuleSignals,
  ModuleBasis,
  ModuleRole,
  Detection,
  DiagnosticPayload,
} from '../../model/types.ts';

export interface IndexDocument {
  schemaVersion: number;
  generatedBy: string;
  generatedAt?: string;
  repository: {
    name: string;
    /** Repository name only: absolute paths are machine specific and not canonical. */
    rootName: string;
    packageManager: string;
    workspaceModel: string;
    isMonorepo: boolean;
    languages: string[];
    counts: {
      files: number;
      source: number;
      tests: number;
      config: number;
      docs: number;
      assets: number;
      modules: number;
      symbols: number;
      dependencies: number;
      entryPoints: number;
      conventions: number;
      decisions: number;
      externalDependencies: number;
    };
  };
  files: {
    /** Hash of every analyzed file: enables `status` and `diff` without rescanning. */
    entries: Array<{ path: string; hash: string; language: string; kind: string; module: string | null }>;
    sensitiveSkipped: string[];
  };
  context: {
    architecture: string;
    dependencies: string;
    conventions: string;
    conventionsMarkdown: string;
    decisions: string;
  };
  git: { enabled: boolean; windowDays: number; commitsAnalyzed: number } | null;
  diagnostics: DiagnosticPayload[];
}

export interface ArchitectureDocument {
  schemaVersion: number;
  generatedBy: string;
  generatedAt?: string;
  summary: {
    modules: number;
    workspacePackages: number;
    entryPoints: number;
    rolesDetected: number;
    cycles: number;
    layeringViolations: number;
  };
  workspace: {
    packageManager: string;
    workspaceModel: string;
    workspaceGlobs: string[];
    packageManagerEvidence: Array<{ source: string; detail: string }>;
    packages: Array<{ name: string; path: string; private: boolean; version: string | null; entries: number }>;
  };
  entryPoints: EntryPoint[];
  modules: ArchitectureModule[];
  layeringViolations: import('../../model/types.ts').LayeringViolation[];
}

export interface ArchitectureModule {
  id: string;
  path: string;
  name: string;
  basis: ModuleBasis;
  packageName: string | null;
  isWorkspacePackage: boolean;
  /** Heuristic roles; each carries confidence and evidence. */
  roles: Array<Detection<ModuleRole>>;
  /** Heuristic responsibilities; each carries confidence and evidence. */
  responsibilities: Array<Detection>;
  entryPoints: string[];
  dependsOn: string[];
  usedBy: string[];
  publicExports: Array<{ name: string; kind: string; file: string }>;
  boundaries: string[];
  files: number;
  fileList: string[];
  testFiles: string[];
  signals: string[];
  git: GitModuleSignals | null;
}

export interface DependenciesDocument {
  schemaVersion: number;
  generatedBy: string;
  generatedAt?: string;
  summary: {
    internalModuleEdges: number;
    crossPackageEdges: number;
    externalPackages: number;
    unresolvedImports: number;
    cycles: number;
  };
  /** Module → module edges (the architectural dependency graph). */
  internal: Array<{
    from: string;
    to: string;
    kind: 'internal-module' | 'workspace-package';
    confidence: number;
    evidence: Array<{ source: string; detail: string }>;
  }>;
  external: ExternalDependency[];
  /** Per-file projection: what each file imports (module ids and package names). */
  fileImports: Array<{ file: string; module: string | null; internalModules: string[]; externalPackages: string[] }>;
  cycles: string[][];
  unresolved: Array<{ file: string; specifier: string; attempts: string[] }>;
}

export interface ConventionsDocument {
  schemaVersion: number;
  generatedBy: string;
  generatedAt?: string;
  conventions: Convention[];
}

export interface DecisionsDocument {
  schemaVersion: number;
  generatedBy: string;
  generatedAt?: string;
  decisions: Decision[];
}

export interface ContextDocuments {
  index: IndexDocument;
  architecture: ArchitectureDocument;
  dependencies: DependenciesDocument;
  conventions: ConventionsDocument;
  decisions: DecisionsDocument;
  conventionsMarkdown: string;
}

export interface DocumentBuildOptions {
  /** ISO timestamp; only included when `output.includeTimestamp` is enabled. */
  generatedAt?: string;
  diagnostics: DiagnosticPayload[];
  commitsAnalyzed: number;
}