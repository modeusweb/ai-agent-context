/**
 * Knowledge graph assembly.
 *
 * Turns scanner output into the graph the whole product is built on:
 *
 * ```text
 * File → Module → Symbol → Dependency,  Module A --imports--> Module B,  B --used-by--> A
 * ```
 *
 * Only unambiguous relationships become edges: `imports`, `exports` (re-exports),
 * `calls` (restricted to symbols that are actually imported by the file) and
 * `extends` / `implements` (same restriction). Unresolvable imports are collected
 * separately and reported as diagnostics instead of polluting the graph.
 */
import type {
  DependencyEdge,
  Detection,
  ExternalDependency,
  FileNode,
  ModuleNode,
  Relationship,
  Repository,
  SymbolNode,
  WorkspaceInfo,
} from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { compareStrings, uniqueSorted } from '../../model/canonical.ts';
import { CONFIDENCE } from '../../model/schema.ts';
import { join, normalizeRelative } from '../../util/paths.ts';
import { ImportResolver, withExtensions, type AliasEntry } from './resolver.ts';
import { collectAliases } from './aliases.ts';
import { buildModules } from './modules.ts';
import type { ScanOutput } from '../scanner/scanner.ts';

export interface KnowledgeGraphInput {
  root: string;
  repositoryName: string;
  scan: ScanOutput;
  workspace: WorkspaceInfo;
  moduleDepth: number;
  schemaVersion: number;
  languages: string[];
}

export interface UnresolvedImport {
  file: string;
  specifier: string;
  attempts: string[];
}

export interface KnowledgeGraph {
  repository: Repository;
  /** File level edges (`file → file`, `file → package`, symbol level calls). */
  fileEdges: DependencyEdge[];
  /** Module/package level edges — these are the serialized dependencies. */
  moduleEdges: DependencyEdge[];
  externalDependencies: ExternalDependency[];
  unresolved: UnresolvedImport[];
  cycles: string[][];
  fileToModule: Map<string, string>;
  symbolsByFile: Map<string, SymbolNode[]>;
  symbolsByName: Map<string, SymbolNode[]>;
  filesByPath: Map<string, FileNode>;
  resolver: ImportResolver;
  aliases: AliasEntry[];
  tsconfigPaths: string[];
}

/** Builds symbol nodes and the name/file indexes used for resolution. */
export function buildSymbols(
  files: FileNode[],
  parsed: Map<string, ParsedFile>,
): { symbols: SymbolNode[]; symbolsByFile: Map<string, SymbolNode[]>; symbolsByName: Map<string, SymbolNode[]> } {
  const symbols: SymbolNode[] = [];
  const symbolsByFile = new Map<string, SymbolNode[]>();
  const symbolsByName = new Map<string, SymbolNode[]>();

  for (const file of files) {
    const facts = parsed.get(file.path);
    if (facts === undefined || file.sensitive) continue;
    const declared: SymbolNode[] = [];
    const seen = new Set<string>();
    for (const record of facts.symbols) {
      if (seen.has(record.name)) continue;
      seen.add(record.name);
      const symbol: SymbolNode = {
        id: `${file.path}#${record.name}`,
        name: record.name,
        kind: record.kind,
        file: file.path,
        moduleId: file.moduleId,
        exported: record.exported,
        isDefault: record.isDefault,
        extends: uniqueSorted(record.extends),
        implements: uniqueSorted(record.implements),
        line: record.line,
      };
      symbols.push(symbol);
      declared.push(symbol);
      const byName = symbolsByName.get(symbol.name);
      if (byName === undefined) symbolsByName.set(symbol.name, [symbol]);
      else byName.push(symbol);
    }
    declared.sort((a, b) => (a.line === b.line ? compareStrings(a.name, b.name) : a.line - b.line));
    symbolsByFile.set(file.path, declared);
    file.symbolIds = declared.map((symbol) => symbol.id);
  }
  symbols.sort((a, b) =>
    a.file === b.file
      ? a.line === b.line
        ? compareStrings(a.name, b.name)
        : a.line - b.line
      : compareStrings(a.file, b.file),
  );
  return { symbols, symbolsByFile, symbolsByName };
}

/** Workspace package entry candidates, used to resolve package-name imports. */
export function resolverWorkspacePackages(
  workspace: WorkspaceInfo,
  filePaths: ReadonlySet<string>,
): Map<string, { directory: string; entries: string[] }> {
  const result = new Map<string, { directory: string; entries: string[] }>();
  for (const entry of workspace.packages) {
    const candidates: string[] = [];
    for (const declared of entry.entries) {
      if (declared.value.includes('*')) continue;
      if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(declared.value) && !declared.value.startsWith('.')) continue;
      candidates.push(join(entry.path, declared.value.replace(/^\.\//, '')));
    }
    candidates.push(join(entry.path, 'src/index'), join(entry.path, 'index'), join(entry.path, 'src/main'));
    const resolvable = candidates.filter((candidate) => withExtensions(candidate, filePaths) !== null);
    result.set(entry.name, {
      directory: normalizeRelative(entry.path),
      entries: resolvable.length > 0 ? resolvable : candidates,
    });
  }
  return result;
}

const INFRASTRUCTURE_PACKAGES = new Set([
  '@prisma/client',
  'prisma',
  'pg',
  'mysql2',
  'mongoose',
  'mongodb',
  'redis',
  'ioredis',
  'knex',
  'typeorm',
  'kafkajs',
  'amqplib',
  'bull',
  'bullmq',
  'winston',
  'pino',
  'axios',
  'undici',
]);

const FRAMEWORK_PACKAGES = new Set([
  'react',
  'react-dom',
  'next',
  'vue',
  'svelte',
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  '@nestjs/common',
]);

const TOOLING_PACKAGES = new Set([
  'typescript',
  'ts-node',
  'tsx',
  'esbuild',
  'vite',
  'webpack',
  'rollup',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'mocha',
  'cypress',
  '@playwright/test',
  'husky',
  'lint-staged',
]);

/** Heuristic importance of an external dependency; always reported with evidence. */
export function classifyExternalImportance(
  name: string,
  options: { builtin: boolean; development: boolean },
): Detection<'infrastructure' | 'framework' | 'tooling' | 'utility'> {
  const evidence: Array<{ source: string; detail: string }> = [];
  const rootName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name;
  if (options.builtin) {
    evidence.push({ source: '<node>', detail: 'Node.js built-in module' });
    return { value: 'infrastructure', confidence: CONFIDENCE.declared, evidence };
  }
  if (INFRASTRUCTURE_PACKAGES.has(rootName)) {
    evidence.push({ source: 'package.json', detail: 'dependency is a known infrastructure library' });
    return { value: 'infrastructure', confidence: CONFIDENCE.medium, evidence };
  }
  if (FRAMEWORK_PACKAGES.has(rootName)) {
    evidence.push({ source: 'package.json', detail: 'dependency is a known application framework' });
    return { value: 'framework', confidence: CONFIDENCE.medium, evidence };
  }
  if (TOOLING_PACKAGES.has(rootName)) {
    evidence.push({ source: 'package.json', detail: 'dependency is a known build or test tool' });
    return { value: 'tooling', confidence: CONFIDENCE.medium, evidence };
  }
  if (options.development) {
    evidence.push({ source: 'package.json', detail: 'declared in devDependencies' });
    return { value: 'tooling', confidence: CONFIDENCE.weak, evidence };
  }
  evidence.push({ source: '<heuristic>', detail: 'no specific classification signal matched' });
  return { value: 'utility', confidence: CONFIDENCE.speculative, evidence };
}

/** Accumulates module→module edges deterministically, with bounded evidence. */
export class ModuleEdgeAccumulator {
  private readonly entries = new Map<
    string,
    {
      from: string;
      to: string;
      files: Set<string>;
      relationships: Set<Relationship>;
      evidence: Array<{ source: string; detail: string }>;
    }
  >();

  add(from: string, to: string, relationship: Relationship, sourceFile: string, detail: string): void {
    const key = `${from}|${to}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { from, to, files: new Set(), relationships: new Set(), evidence: [] };
      this.entries.set(key, entry);
    }
    entry.files.add(sourceFile);
    entry.relationships.add(relationship);
    if (entry.evidence.length < 4) entry.evidence.push({ source: sourceFile, detail });
  }

  /** Files that create the edge, keyed by `from|to`. */
  fileCount(from: string, to: string): number {
    return this.entries.get(`${from}|${to}`)?.files.size ?? 0;
  }

  /** Relationships observed between two modules. */
  relationships(from: string, to: string): Relationship[] {
    return uniqueSorted(this.entries.get(`${from}|${to}`)?.relationships ?? []) as Relationship[];
  }

  edges(): DependencyEdge[] {
    return [...this.entries.values()]
      .map((entry) => ({
        id: `${entry.from}|depends-on|${entry.to}`,
        from: entry.from,
        fromKind: 'module' as const,
        to: entry.to,
        toKind: 'module' as const,
        relationship: 'depends-on' as Relationship,
        kind: 'internal-module' as const,
        confidence: CONFIDENCE.declared,
        evidence: [
          {
            source: entry.from,
            detail: `${entry.files.size} file(s) import ${entry.to}`,
          },
          ...entry.evidence,
        ].slice(0, 5),
      }))
      .sort((a, b) => (a.from === b.from ? compareStrings(a.to, b.to) : compareStrings(a.from, b.from)));
  }
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.node']);

/** Local binding name → specifier, used for calls/extends resolution. */
function importedSymbolNames(facts: ParsedFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const record of facts.imports) {
    if (record.namespaceImport !== undefined) names.set(record.namespaceImport, record.specifier);
    if (record.defaultImport !== undefined) names.set(record.defaultImport, record.specifier);
    for (const name of record.names) {
      if (!names.has(name)) names.set(name, record.specifier);
    }
  }
  return names;
}

interface ExternalAccumulatorEntry {
  name: string;
  builtin: boolean;
  modules: Set<string>;
  files: Set<string>;
}

function pushEdge(edges: DependencyEdge[], edge: Omit<DependencyEdge, 'id'>): void {
  edges.push({ id: `${edge.from}|${edge.relationship}|${edge.to}`, ...edge });
}

/**
 * Builds the complete repository knowledge graph.
 *
 * The function is pure with respect to the file system: everything it needs was
 * produced by the scanner, which is what keeps incremental scans cheap.
 */
export function buildKnowledgeGraph(input: KnowledgeGraphInput): KnowledgeGraph {
  const { scan, workspace } = input;
  const files = scan.files;
  const resolvableFiles = new Set(
    files.filter((file) => !file.sensitive && file.parseStatus !== 'skipped').map((file) => file.path),
  );

  const moduleBuild = buildModules({ workspace, files, parsed: scan.parsed, moduleDepth: input.moduleDepth });
  const modulesById = new Map(moduleBuild.modules.map((module) => [module.id, module]));

  const { symbols, symbolsByFile, symbolsByName } = buildSymbols(files, scan.parsed);
  const aliases = collectAliases(scan.parsed);
  const resolver = new ImportResolver({
    filePaths: resolvableFiles,
    aliases,
    workspacePackages: resolverWorkspacePackages(workspace, resolvableFiles),
  });

  const fileEdges: DependencyEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const moduleEdges = new ModuleEdgeAccumulator();
  const externalMap = new Map<string, ExternalAccumulatorEntry>();
  const filesByPath = new Map(files.map((file) => [file.path, file]));

  const recordExternal = (name: string, builtin: boolean, file: FileNode): void => {
    let entry = externalMap.get(name);
    if (entry === undefined) {
      entry = { name, builtin, modules: new Set(), files: new Set() };
      externalMap.set(name, entry);
    }
    entry.files.add(file.path);
    if (file.moduleId !== null) entry.modules.add(file.moduleId);
  };

  for (const file of files) {
    if (file.sensitive || file.parseStatus === 'skipped') continue;
    const facts = scan.parsed.get(file.path);
    if (facts === undefined) continue;
    const fromModule = file.moduleId;

    for (const record of facts.imports) {
      const resolved = resolver.resolve(record.specifier, file.path);
      const relationship: Relationship = record.syntax === 'reexport' ? 'exports' : 'imports';
      const evidence = [{ source: file.path, detail: resolved.evidence }];

      if (resolved.kind === 'internal-file') {
        pushEdge(fileEdges, {
          from: file.path,
          fromKind: 'file',
          to: resolved.target,
          toKind: 'file',
          relationship,
          kind: 'internal-file',
          specifier: record.specifier,
          syntax: record.syntax,
          confidence: resolved.confidence,
          evidence,
        });
        const targetModule = filesByPath.get(resolved.target)?.moduleId ?? null;
        if (fromModule !== null && targetModule !== null && fromModule !== targetModule) {
          moduleEdges.add(fromModule, targetModule, relationship, file.path, resolved.evidence);
        }
        continue;
      }

      if (resolved.kind === 'workspace-package') {
        pushEdge(fileEdges, {
          from: file.path,
          fromKind: 'file',
          to: resolved.target,
          toKind: 'module',
          relationship,
          kind: 'workspace-package',
          specifier: record.specifier,
          syntax: record.syntax,
          confidence: resolved.confidence,
          evidence,
        });
        if (fromModule !== null && resolved.target !== fromModule) {
          moduleEdges.add(fromModule, resolved.target, relationship, file.path, resolved.evidence);
        }
        continue;
      }

      if (resolved.kind === 'external-package' || resolved.kind === 'node-builtin') {
        pushEdge(fileEdges, {
          from: file.path,
          fromKind: 'file',
          to: resolved.target,
          toKind: 'package',
          relationship,
          kind: resolved.kind,
          specifier: record.specifier,
          syntax: record.syntax,
          confidence: resolved.confidence,
          evidence,
        });
        recordExternal(resolved.target, resolved.kind === 'node-builtin', file);
        continue;
      }

      const extension = record.specifier.slice(record.specifier.lastIndexOf('.'));
      const looksLikeCode = !record.specifier.includes('.') || CODE_EXTENSIONS.has(extension);
      if (looksLikeCode) unresolved.push({ file: file.path, specifier: record.specifier, attempts: resolved.attempts });
    }

    const importedNames = importedSymbolNames(facts);

    for (const call of facts.calls) {
      const specifier = importedNames.get(call.name);
      if (specifier === undefined) continue;
      const resolved = resolver.resolve(specifier, file.path);
      if (resolved.kind !== 'internal-file') continue;
      const targetSymbol = (symbolsByName.get(call.name) ?? []).find((symbol) => symbol.file === resolved.target);
      if (targetSymbol === undefined) continue;
      pushEdge(fileEdges, {
        from: file.path,
        fromKind: 'file',
        to: targetSymbol.id,
        toKind: 'symbol',
        relationship: 'calls',
        kind: 'internal-file',
        specifier,
        confidence: 0.6,
        evidence: [{ source: file.path, detail: `lexical call to imported symbol ${call.name} (line ${call.line})` }],
      });
    }

    for (const symbol of facts.symbols) {
      const heritage: Array<{ names: string[]; relationship: Relationship; label: string }> = [
        { names: symbol.extends, relationship: 'extends', label: 'extends' },
        { names: symbol.implements, relationship: 'implements', label: 'implements' },
      ];
      for (const entry of heritage) {
        for (const baseName of entry.names) {
          const specifier = importedNames.get(baseName);
          if (specifier === undefined) continue;
          const resolved = resolver.resolve(specifier, file.path);
          if (resolved.kind !== 'internal-file') continue;
          const targetSymbol = (symbolsByName.get(baseName) ?? []).find((candidate) => candidate.file === resolved.target);
          if (targetSymbol === undefined) continue;
          pushEdge(fileEdges, {
            from: `${file.path}#${symbol.name}`,
            fromKind: 'symbol',
            to: targetSymbol.id,
            toKind: 'symbol',
            relationship: entry.relationship,
            kind: 'internal-file',
            specifier,
            confidence: 0.62,
            evidence: [
              {
                source: file.path,
                detail: `${symbol.name} ${entry.label} imported symbol ${baseName} (line ${symbol.line})`,
              },
            ],
          });
        }
      }
    }
  }

  fileEdges.sort((a, b) => (a.id === b.id ? compareStrings(a.from, b.from) : compareStrings(a.id, b.id)));

  const moduleEdgeList = moduleEdges.edges();
  for (const edge of moduleEdgeList) {
    const from = modulesById.get(edge.from);
    const to = modulesById.get(edge.to);
    if (from !== undefined && !from.dependsOn.includes(edge.to)) from.dependsOn.push(edge.to);
    if (to !== undefined && !to.usedBy.includes(edge.from)) to.usedBy.push(edge.from);
  }
  for (const module of modulesById.values()) {
    module.dependsOn.sort(compareStrings);
    module.usedBy.sort(compareStrings);
  }

  // Public API surface: exported symbols of entry files (index/mod files) and of
  // files that other modules actually import.
  const importedFileCounts = new Map<string, number>();
  for (const edge of fileEdges) {
    if (edge.kind !== 'internal-file' || edge.toKind !== 'file') continue;
    importedFileCounts.set(edge.to, (importedFileCounts.get(edge.to) ?? 0) + 1);
  }
  for (const module of modulesById.values()) {
    const priorityFiles = module.files.filter((file) => /^(index|mod)\.[cm]?[jt]sx?$/.test(file.split('/').pop() ?? ''));
    const importedFiles = module.files.filter((file) => (importedFileCounts.get(file) ?? 0) > 0);
    const publicFiles = [...new Set([...priorityFiles, ...importedFiles, ...module.files])].sort(compareStrings);
    const exports: ModuleNode['publicExports'] = [];
    for (const file of publicFiles) {
      for (const symbol of symbolsByFile.get(file) ?? []) {
        if (!symbol.exported) continue;
        if (exports.some((entry) => entry.name === symbol.name)) continue;
        exports.push({ name: symbol.name, kind: symbol.kind, file });
      }
      if (exports.length >= 40) break;
    }
    module.publicExports = exports.sort((a, b) => compareStrings(a.name, b.name));
    module.boundaries = module.files
      .filter((file) => {
        const facts = scan.parsed.get(file);
        if (facts === undefined) return false;
        return facts.imports.some((record) => record.syntax === 'reexport');
      })
      .sort(compareStrings);
  }

  const externalDependencies = buildExternalDependencies(externalMap, workspace);
  const cycles = findModuleCycles(modulesById);

  const repository: Repository = {
    root: input.root,
    name: input.repositoryName,
    schemaVersion: input.schemaVersion,
    languages: [...input.languages].sort(compareStrings),
    workspace,
    files,
    modules: [...modulesById.values()].sort((a, b) => compareStrings(a.id, b.id)),
    symbols,
    dependencies: moduleEdgeList,
    entryPoints: [],
    conventions: [],
    decisions: [],
    externalDependencies,
    cycles,
  };

  return {
    repository,
    fileEdges,
    moduleEdges: moduleEdgeList,
    externalDependencies,
    unresolved: dedupeUnresolved(unresolved),
    cycles,
    fileToModule: moduleBuild.fileToModule,
    symbolsByFile,
    symbolsByName,
    filesByPath,
    resolver,
    aliases,
    tsconfigPaths: [...scan.parsed.keys()]
      .filter((path) => scan.parsed.get(path)?.language === 'tsconfig')
      .sort(compareStrings),
  };
}

function dedupeUnresolved(items: UnresolvedImport[]): UnresolvedImport[] {
  const seen = new Set<string>();
  const result: UnresolvedImport[] = [];
  for (const item of items) {
    const key = `${item.file}|${item.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((a, b) =>
    a.file === b.file ? compareStrings(a.specifier, b.specifier) : compareStrings(a.file, b.file),
  );
}

/** Aggregates imported external packages with scope, declaring packages and importance. */
export function buildExternalDependencies(
  externalMap: Map<string, { builtin: boolean; modules: Set<string>; files: Set<string> }>,
  workspace: WorkspaceInfo,
): ExternalDependency[] {
  const declarations = new Map<string, { scope: 'runtime' | 'development' | 'peer'; packages: Set<string> }>();
  const scopePriority = { runtime: 3, peer: 2, development: 1 } as const;
  for (const entry of workspace.packages) {
    const recordScope = (name: string, scope: 'runtime' | 'development' | 'peer'): void => {
      const record = declarations.get(name);
      if (record === undefined) {
        declarations.set(name, { scope, packages: new Set([entry.name]) });
        return;
      }
      if (scopePriority[scope] > scopePriority[record.scope]) record.scope = scope;
      record.packages.add(entry.name);
    };
    for (const name of entry.runtimeDependencies) recordScope(name, 'runtime');
    for (const name of entry.peerDependencies) recordScope(name, 'peer');
    for (const name of entry.developmentDependencies) recordScope(name, 'development');
  }

  const result: ExternalDependency[] = [];
  for (const [name, entry] of externalMap) {
    const declaration = declarations.get(name);
    const scope: ExternalDependency['scope'] = entry.builtin ? 'runtime' : (declaration?.scope ?? 'runtime');
    const extraEvidence: Array<{ source: string; detail: string }> = [];
    if (declaration === undefined && !entry.builtin) {
      extraEvidence.push({
        source: '<package.json>',
        detail: 'imported by source code but not declared as a dependency in any workspace package',
      });
    }
    const importance = classifyExternalImportance(name, {
      builtin: entry.builtin,
      development: scope === 'development',
    });
    result.push({
      name,
      scope,
      declaredBy: [...(declaration?.packages ?? [])].sort(compareStrings),
      importedByModules: entry.modules.size,
      importance: {
        value: importance.value,
        confidence: extraEvidence.length === 0 ? importance.confidence : Math.min(importance.confidence, 0.6),
        evidence: [...extraEvidence, ...importance.evidence],
      },
    });
  }
  return result.sort((a, b) => compareStrings(a.name, b.name));
}

/** Finds strongly connected components (size > 1) in the module dependency graph. */
export function findModuleCycles(modulesById: Map<string, ModuleNode>): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    const targets = [...(modulesById.get(node)?.dependsOn ?? [])].sort(compareStrings);
    for (const target of targets) {
      if (!modulesById.has(target)) continue;
      if (!index.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(target)!));
      }
    }

    if (lowLink.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      if (component.length > 1) components.push(component.sort(compareStrings));
    }
  };

  for (const id of [...modulesById.keys()].sort(compareStrings)) {
    if (!index.has(id)) visit(id);
  }
  return components.sort((a, b) => compareStrings(a.join(','), b.join(',')));
}