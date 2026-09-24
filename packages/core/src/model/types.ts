/**
 * Canonical data model of the repository knowledge graph.
 *
 * Everything in this file is a plain, serializable TypeScript type: the model is
 * the single source of truth for both the analysis pipeline and the `.agent/`
 * serialization layer. Heuristic results are never modelled as facts — they are
 * modelled as {@link Detection} values carrying `confidence` and `evidence`.
 */

/** Normalized confidence in the `[0, 1]` range. Never `1` for heuristic results. */
export type Confidence = number;

/** A single piece of machine-readable justification for a heuristic statement. */
export interface Evidence {
  /** Where the evidence comes from, for example `package.json` or `src/a/b.ts`. */
  source: string;
  /** Human readable description of what was observed. */
  detail: string;
}

/** A heuristic conclusion that is explicitly *not* asserted as an absolute fact. */
export interface Detection<TValue extends string = string> {
  value: TValue;
  confidence: Confidence;
  evidence: Evidence[];
}

/** Edge types supported by the knowledge graph. */
export type Relationship =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'depends-on'
  | 'used-by'
  | 'contains';

/** Node kinds inside the graph. */
export type NodeKind = 'repository' | 'package' | 'module' | 'file' | 'symbol';

/** Classification of a resolved dependency edge. */
export type DependencyKind =
  | 'internal-file'
  | 'internal-module'
  | 'workspace-package'
  | 'external-package'
  | 'node-builtin'
  | 'unresolved';

/** Coarse file classification, language agnostic. */
export type FileKind = 'source' | 'test' | 'config' | 'docs' | 'asset' | 'other';

/** Why a directory/package was treated as an architectural module. */
export type ModuleBasis = 'workspace-package' | 'index-file' | 'directory' | 'single-file';

/** Neutral activity bucket. Deliberately avoids words such as "critical". */
export type ChangeFrequency = 'none' | 'low' | 'medium' | 'high';

/** Detected architectural roles. Heuristic — always reported with confidence. */
export type ModuleRole =
  | 'workspace-package'
  | 'application'
  | 'domain'
  | 'service'
  | 'adapter'
  | 'repository'
  | 'controller'
  | 'api-routes'
  | 'infrastructure'
  | 'eventing'
  | 'worker'
  | 'cli'
  | 'ui'
  | 'shared'
  | 'configuration'
  | 'test-support';

/** Entry point categories. */
export type EntryPointType =
  | 'application'
  | 'cli'
  | 'library'
  | 'package-main'
  | 'package-bin'
  | 'package-export'
  | 'http-routes'
  | 'worker'
  | 'test';
export interface GitFileSignals {
  /** Commits touching this path inside the analysis window. */
  historicalChanges: number;
  /** Commits touching this path inside the "recent" window. */
  recentChanges: number;
  /** ISO date (`YYYY-MM-DD`) of the last change, if known. */
  lastChanged: string | null;
  /** Bucketed activity derived from the distribution of module activity. */
  changeFrequency: ChangeFrequency;
  /** Number of distinct authors observed for this path. */
  contributorCount: number;
}

export interface GitModuleSignals extends GitFileSignals {
  /** Most frequently observed authors (neutral ownership signal). */
  topContributors: Array<{ name: string; commits: number }>;
  /** Commits whose message suggests an architectural change (bounded list). */
  architectureChangeSignals: Array<{ sha: string; date: string; subject: string }>;
}

export interface FileNode {
  /** POSIX path relative to the repository root. */
  path: string;
  /** SHA-256 of the file content. */
  hash: string;
  size: number;
  /** Modification time in milliseconds since epoch (informational, local). */
  mtimeMs: number;
  /** Language id assigned by a language adapter, for example `typescript`. */
  language: string;
  kind: FileKind;
  /** Owning module id, when the file belongs to a module. */
  moduleId: string | null;
  /** Owning workspace package name, when inside a workspace package. */
  packageName: string | null;
  /** Symbol ids declared in this file. */
  symbolIds: string[];
  /** Outgoing import/dependency specifiers observed in this file. */
  importSpecifiers: string[];
  /** Language-agnostic signals emitted by the language adapter. */
  signals: string[];
  /** `true` when the file was skipped because it matched sensitive patterns. */
  sensitive: boolean;
  parseStatus: ParseStatus;
}

export interface ModuleNode {
  /** Stable id: workspace package name or path relative to the repository root. */
  id: string;
  path: string;
  name: string;
  basis: ModuleBasis;
  /** Architectural roles, heuristic, each with confidence and evidence. */
  roles: Detection<ModuleRole>[];
  packageName: string | null;
  isWorkspacePackage: boolean;
  files: string[];
  entryPoints: EntryPoint[];
  /** Ids of modules this module depends on. */
  dependsOn: string[];
  /** Ids of modules that depend on this module. */
  usedBy: string[];
  /** Externally reachable exported symbols (agent-facing API surface). */
  publicExports: Array<{ name: string; kind: SymbolKind; file: string }>;
  /** Files of the module that re-export other modules (boundary candidates). */
  boundaries: string[];
  /** Aggregated language-agnostic signals of the module files. */
  signals: string[];
  /** Heuristic responsibilities, never asserted as facts. */
  responsibilities: Detection[];
  git: GitModuleSignals | null;
  /** Test files inside the module. */
  testFiles: string[];
}

export interface SymbolNode {
  /** Stable id: `<file path>#<symbol name>`. */
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  moduleId: string | null;
  exported: boolean;
  isDefault: boolean;
  extends: string[];
  implements: string[];
  /** 1-based line of the declaration. */
  line: number;
}

export interface DependencyEdge {
  /** Stable id: `<from>|<relationship>|<to>`. */
  id: string;
  from: string;
  fromKind: NodeKind;
  to: string;
  toKind: NodeKind;
  relationship: Relationship;
  kind: DependencyKind;
  /** Raw specifier as written in the source, when applicable. */
  specifier?: string;
  /** Import syntax flavour, when applicable. */
  syntax?: ImportSyntax;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface EntryPoint {
  path: string;
  moduleId: string | null;
  type: EntryPointType;
  confidence: Confidence;
  evidence: Evidence[];
  /** Additional context, for example the npm script or route method. */
  details?: string;
}

export interface Convention {
  id: string;
  category: string;
  statement: string;
  confidence: Confidence;
  evidence: Evidence[];
  /** How the convention was derived. */
  origin: 'observed' | 'config';
}

export type ParseStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export type ImportSyntax =
  | 'static'
  | 'type-only'
  | 'dynamic'
  | 'require'
  | 'side-effect'
  | 'reexport'
  | 'import-equals';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'const'
  | 'variable'
  | 'method'
  | 'namespace';

export type DecisionStatus = 'accepted' | 'proposed' | 'deprecated' | 'superseded' | 'rejected' | 'unknown';

export interface Decision {
  id: string;
  title: string;
  status: DecisionStatus;
  /** Repository-relative path (or git reference) the decision was found in. */
  source: string;
  /** `explicit` = authored by humans in the repository, `inferred` = derived by heuristics. */
  origin: 'explicit' | 'inferred';
  kind: 'adr' | 'documented-section' | 'git-signal' | 'config-signal' | 'dependency-signal';
  confidence: Confidence;
  evidence: Evidence[];
  excerpt?: string;
}

export interface WorkspacePackage {
  name: string;
  /** Repository-relative POSIX path. */
  path: string;
  version: string | null;
  private: boolean;
  type: 'module' | 'commonjs' | null;
  runtimeDependencies: string[];
  developmentDependencies: string[];
  peerDependencies: string[];
  scripts: Record<string, string>;
  /** Declared entry fields from package.json (structural facts). */
  entries: Array<{ field: 'main' | 'module' | 'types' | 'browser' | 'exports' | 'bin'; value: string }>;
}

export interface WorkspaceInfo {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  /** Repository signals only: a lockfile is a signal, not proof of runtime usage. */
  packageManagerEvidence: Evidence[];
  lockfiles: string[];
  isMonorepo: boolean;
  workspaceModel: 'npm-workspaces' | 'yarn-workspaces' | 'pnpm-workspaces' | 'bun-workspaces' | 'single-package';
  workspaceGlobs: string[];
  rootPackage: WorkspacePackage | null;
  packages: WorkspacePackage[];
}

export interface ExternalDependency {
  name: string;
  scope: 'runtime' | 'development' | 'peer';
  /** Workspace package names declaring this dependency. */
  declaredBy: string[];
  /** Number of internal modules importing it. */
  importedByModules: number;
  /** Heuristic importance classification with evidence. */
  importance: Detection<'infrastructure' | 'framework' | 'tooling' | 'utility'>;
}

export interface Repository {
  /** Absolute repository root. */
  root: string;
  name: string;
  schemaVersion: number;
  languages: string[];
  workspace: WorkspaceInfo;
  files: FileNode[];
  modules: ModuleNode[];
  symbols: SymbolNode[];
  dependencies: DependencyEdge[];
  entryPoints: EntryPoint[];
  conventions: Convention[];
  decisions: Decision[];
  externalDependencies: ExternalDependency[];
  /** Module-level dependency cycles (module ids, deterministic order). */
  cycles: string[][];
  /** Heuristic dependency direction violations with evidence. */
  layeringViolations: LayeringViolation[];
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  /** `false` when metadata was missing, forcing a cold scan. */
  incremental: boolean;
}

export interface ScanReport {
  changes: ChangeSet;
  files: { total: number; source: number; tests: number; skipped: number; failed: number };
  modules: number;
  dependencies: number;
  externalDependencies: number;
  entryPoints: number;
  conventions: number;
  decisions: number;
  /** Number of files whose content was parsed during this scan. */
  parsed: number;
  /** Number of files whose parse result was reused from the local cache. */
  reused: number;
  /** Subgraph affected by this scan (used for incremental invalidation). */
  affected: { files: string[]; modules: string[]; dependents: string[] };
  durationMs: number;
  warnings: DiagnosticPayload[];
}

export interface DiagnosticPayload {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
  hint?: string;
}

export interface ContextDiff {
  files: { added: string[]; modified: string[]; removed: string[] };
  modules: {
    added: string[];
    removed: string[];
    roleChanges: Array<{ moduleId: string; added: string[]; removed: string[] }>;
  };
  entryPoints: { added: string[]; removed: string[] };
  dependencies: {
    added: Array<{ from: string; to: string; relationship: Relationship; kind: DependencyKind }>;
    removed: Array<{ from: string; to: string; relationship: Relationship; kind: DependencyKind }>;
    externalAdded: string[];
    externalRemoved: string[];
  };
  conventions: { added: string[]; removed: string[]; changed: string[] };
  decisions: { added: string[]; removed: string[] };
  statistics: { files: number; modules: number; dependencies: number; entries: number };
  hasChanges: boolean;
  /** Hash of the previously persisted canonical context, when available. */
  baseline: string | null;
}

export interface SearchResult {
  type: 'file' | 'module' | 'symbol' | 'decision' | 'convention' | 'entry-point' | 'dependency';
  id: string;
  score: number;
  /** Deterministic explanation of why the node matched. */
  reason: string;
  /** Short, agent-friendly excerpt. */
  snippet?: string;
}

export interface TaskContext {
  schemaVersion: number;
  task: string;
  target: string | null;
  modules: Array<{
    id: string;
    summary: string;
    dependsOn: string[];
    usedBy: string[];
    publicApi: string[];
    tests: string[];
    evidence: Evidence[];
  }>;
  conventions: Convention[];
  decisions: Decision[];
  diagnostics: DiagnosticPayload[];
  truncated: boolean;
}

export interface ChangeImpact {
  schemaVersion: number;
  target: string;
  modules: string[];
  files: string[];
  tests: string[];
  conventions: Convention[];
  decisions: Decision[];
  evidence: Evidence[];
  truncated: boolean;
}

export type LayeringViolationKind = 'domain-infrastructure' | 'domain-adapter' | 'application-ui' | 'application-controller' | 'infrastructure-ui';

export interface LayeringViolation {
  from: string;
  to: string;
  kind: LayeringViolationKind;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface ModuleHistoryEntry {
  sha: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
  architectureSignal: boolean;
}

export interface RevisionDiff {
  revision: string;
  files: Array<{ path: string; status: string; oldPath?: string }>;
  hasChanges: boolean;
}

export interface RevisionSnapshot {
  revision: string;
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  moduleCount: number | null;
  dependencyCount: number | null;
  entryPointCount: number | null;
  available: boolean;
  reason?: string;
}

export interface ModuleExplanation {
  module: {
    id: string;
    path: string;
    name: string;
    basis: ModuleBasis;
    roles: Detection<ModuleRole>[];
    responsibilities: Detection[];
  };
  summary: string;
  entryPoints: EntryPoint[];
  dependsOn: Array<{ id: string; path: string; relationships: Relationship[]; files: number }>;
  usedBy: Array<{ id: string; path: string; relationships: Relationship[]; files: number }>;
  externalDependencies: Array<{ name: string; scope: ExternalDependency['scope']; importance: Detection }>;
  publicApi: Array<{ name: string; kind: SymbolKind; file: string }>;
  internalSymbols: Array<{ name: string; kind: SymbolKind; file: string }>;
  conventions: Convention[];
  decisions: Decision[];
  tests: { files: string[]; testCount: number };
  git: GitModuleSignals | null;
  /** Modules and files that would be affected by a change in this module. */
  impact: { modules: string[]; files: string[] };
  relatedFiles: string[];
  warnings: DiagnosticPayload[];
}
