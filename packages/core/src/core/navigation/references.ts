/**
 * Symbol-level navigation: what a file exports, who imports it, and where an
 * exported symbol is used.
 *
 * The module graph answers "which module depends on which". An agent editing
 * code asks finer questions — *who imports this file*, *where is this function
 * used*, *is this export still needed* — and `explain` of one file describes
 * the whole module that owns it.
 *
 * Nothing here is inferred. Every reference is an `import` statement that
 * exists in the analyzed source, at a line, resolved by the resolver that
 * builds the module graph. A re-export chain is followed to the file that
 * declares the symbol, so `import { pay } from '@app/payments'` is reported
 * against `src/payments/pay.ts`, with the barrel files named on the way.
 *
 * What this cannot see is stated rather than assumed: namespace imports (which
 * member is used is unknown), files the analyzer could not parse, and imports
 * it could not resolve are reported as limits of the answer.
 */
import type {
  Evidence,
  FileKind,
  ImportSyntax,
  ParseStatus,
  SymbolKind,
  UnresolvedReason,
} from '../../model/types.ts';
import type { ParsedFile, RouteRecord } from '../../adapters/language/types.ts';
import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import type { ResolvedImport } from '../graph/resolver.ts';
import { compareStrings, uniqueSorted } from '../../model/canonical.ts';
import { extname } from '../../util/paths.ts';

/** A symbol as its own file declares it for other files: the name an importer asks for. */
export interface OwnExport {
  /** The exported name (`default` for a default export). */
  name: string;
  kind: SymbolKind | 'unknown';
  /** 1-based line of the declaration or of the `export { … }` statement. */
  line: number;
  isDefault: boolean;
}

/** One entry of what a file makes available to its importers. */
export interface SurfaceEntry {
  /** The file that declares the symbol. */
  file: string;
  /** The name under which it is declared there. */
  name: string;
  kind: SymbolKind | 'unknown';
  /** Line of the declaration, in `file`. */
  line: number;
  /**
   * Line of the statement that re-exports the symbol, in the file whose surface
   * this is. Absent for that file's own exports: there the declaration is the
   * statement.
   */
  reexportedAt?: number;
  /** Files that re-export the symbol between this file and the declaration, nearest first. */
  chain: string[];
  /** Set when the entry is `export * as ns from './x'`: a namespace of that file. */
  namespaceOf?: string;
}

/** An import statement that reaches an analyzed file. */
export interface ImportSite {
  file: string;
  line: number;
  specifier: string;
  syntax: ImportSyntax;
  typeOnly: boolean;
  /** The file the specifier resolves to (a package's entry file for a package import). */
  target: string;
  /** `true` when the specifier named a workspace package rather than a path. */
  viaPackage: boolean;
  names: string[];
  defaultImport?: string;
  namespaceImport?: string;
}

/** A reference to an exported symbol: an import statement that binds it. */
export interface SymbolReference {
  file: string;
  line: number;
  specifier: string;
  /** The name the symbol is bound to, or `ns.name` for a namespace import. */
  importedAs: string;
  typeOnly: boolean;
  /** Barrel files the symbol was reached through, nearest first. */
  via: string[];
}

export interface ReferenceTarget {
  file: string;
  symbol: string;
  kind: SymbolKind | 'unknown';
  line: number;
  /** `false` when the symbol is declared in the file but not exported from it. */
  exported: boolean;
  isDefault: boolean;
}

export interface ReferenceReport {
  /** `null` when the name matched no exported symbol, or several. */
  target: ReferenceTarget | null;
  status: 'found' | 'not-found' | 'ambiguous';
  /** The exported symbols that share the name, when `status` is `ambiguous`. */
  candidates: ReferenceTarget[];
  /** Import statements that bind the symbol, directly or through a re-export chain. */
  references: SymbolReference[];
  /** Namespace imports through which the symbol may be used; whether it is, is not known. */
  possibleReferences: SymbolReference[];
  /** Files that re-export the symbol from its own file. */
  reexportedBy: Array<{ file: string; line: number; name: string }>;
  /**
   * Reachable from an entry point. If it is, a reference may exist that no
   * analyzed file contains — the consumer of a published package.
   */
  externallyReachable: boolean;
  /** `references.length + possibleReferences.length`. */
  count: number;
  evidence: Evidence[];
  caveats: string[];
}

export interface ImportLine {
  line: number;
  specifier: string;
  syntax: ImportSyntax;
  typeOnly: boolean;
  names: string[];
  /** The file, package or module the specifier resolves to; `null` when it does not resolve. */
  target: string | null;
  targetKind: 'internal-file' | 'workspace-package' | 'external-package' | 'node-builtin' | 'unresolved';
  /** Why an unresolved import did not resolve. */
  reason?: UnresolvedReason;
}

export interface FileOutline {
  file: string;
  module: string | null;
  language: string;
  kind: FileKind;
  parseStatus: ParseStatus;
  /** What the file makes available to importers: each with how many import statements bind it. */
  exports: Array<{
    name: string;
    kind: SymbolKind | 'unknown';
    /** Line in this file: of the declaration, or of the statement that re-exports it. */
    line: number;
    isDefault: boolean;
    references: number;
    possibleReferences: number;
    /** The file that declares it, when it is not this one. */
    reexportedFrom?: string;
    /** Line of the declaration in `reexportedFrom`. */
    declaredLine?: number;
  }>;
  /** Top-level declarations that are not exported. */
  internalSymbols: Array<{ name: string; kind: SymbolKind; line: number }>;
  /** The file's own imports, resolved. */
  imports: ImportLine[];
  /** Files that import this one. */
  importers: {
    direct: Array<ImportLine & { file: string }>;
    /**
     * Files that depend on this one only through other files. The direct
     * importers are not repeated here; they are in `direct`.
     */
    transitive: string[];
    /** How many files the transitive closure holds before the bound on `transitive` applied. */
    transitiveCount: number;
    /** Test files among the importers: what to run after changing this file. */
    tests: string[];
  };
  routes: RouteRecord[];
  caveats: string[];
}

export interface UnusedExport {
  file: string;
  name: string;
  kind: SymbolKind | 'unknown';
  line: number;
  confidence: number;
  evidence: Evidence[];
  /** Files that re-export it, although nothing imports it through them. */
  reexportedBy: string[];
}

export interface UnusedExportsReport {
  schemaVersion: number;
  unused: UnusedExport[];
  counts: {
    /** Named exports of the files that were assessed. */
    exported: number;
    /** Bound by at least one import statement. */
    referenced: number;
    /** Reachable from an entry point, so possibly used outside the analyzed tree. */
    publicApi: number;
    /** Not assessed: a namespace, dynamic or CommonJS import of the file may use any export. */
    unassessable: number;
    unused: number;
  };
  /** `true` when more unused exports exist than `unused` lists. */
  truncated: boolean;
  caveats: string[];
}

interface ReexportSite {
  file: string;
  line: number;
  exportedName: string;
  /** The name in the target file; `*` for `export * from`. */
  importedName: string;
}

/**
 * The import and export facts of a repository, indexed for navigation.
 *
 * Built once per analysis, in one pass over the import and export statements:
 * every lookup below is a map access, so asking about every export of a large
 * repository does not re-walk every import for each one.
 */
export interface ReferenceIndex {
  sites: ImportSite[];
  sitesByTarget: Map<string, ImportSite[]>;
  /** Import statements that bind a symbol, by `file#name` of its declaration. */
  bindings: Map<string, SymbolReference[]>;
  /** Namespace imports that may use a symbol, by `file#name`. */
  possible: Map<string, SymbolReference[]>;
  ownExports: (file: string) => Map<string, OwnExport>;
  /** What a file makes available to importers: its own exports and everything it re-exports. */
  surface: (file: string) => Map<string, SurfaceEntry>;
  reexportedBy: (file: string, name: string) => Array<{ file: string; line: number; name: string }>;
  /** `true` when the file uses a module system this analysis does not follow (`export =`). */
  opaqueModuleSystem: (file: string) => boolean;
  /** `file#name` keys reachable from an entry point of the repository. */
  publicKeys: () => Set<string>;
}

const keyOf = (file: string, name: string): string => `${file}#${name}`;

/** Imports that may use any export of their target: which one is not in the statement. */
const UNASSESSABLE_SYNTAX: ReadonlySet<ImportSyntax> = new Set(['dynamic', 'require', 'side-effect']);

/** How many files an outline lists as transitive importers. */
const MAX_TRANSITIVE_IMPORTERS = 500;

function ownExportsOf(facts: ParsedFile): Map<string, OwnExport> {
  const result = new Map<string, OwnExport>();
  for (const symbol of facts.symbols) {
    // `export default function foo()` is imported as `default`, never as `foo`.
    if (symbol.isDefault) {
      result.set('default', { name: 'default', kind: symbol.kind, line: symbol.line, isDefault: true });
    } else if (symbol.exported) {
      result.set(symbol.name, { name: symbol.name, kind: symbol.kind, line: symbol.line, isDefault: false });
    }
  }
  // `const a = 1; export { a as b };`: declared without `export`, exported by name.
  for (const record of facts.exports) {
    if (record.fromSpecifier !== undefined || record.name === 'export=') continue;
    // A record without a source is never a re-export; the union is wider than
    // the case, and the kind of a name exported by list is not known.
    const kind = record.kind === 'reexport' || record.kind === 'star' ? 'unknown' : record.kind;
    if (!result.has(record.name)) {
      result.set(record.name, { name: record.name, kind, line: record.line, isDefault: record.isDefault });
    }
  }
  return result;
}

function compareSites(a: { file: string; line: number }, b: { file: string; line: number }): number {
  return a.file === b.file ? a.line - b.line : compareStrings(a.file, b.file);
}

function push<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Builds the navigation index of a repository.
 *
 * Pure with respect to the file system: it reads the parsed facts the scanner
 * produced and resolves specifiers in memory.
 */
export function buildReferenceIndex(graph: KnowledgeGraph, parsed: Map<string, ParsedFile>): ReferenceIndex {
  const codeFiles = new Set<string>();
  for (const node of graph.repository.files) {
    if (node.sensitive) continue;
    if (node.language === 'typescript' || node.language === 'javascript') codeFiles.add(node.path);
  }

  /** The file an import of `specifier` written in `fromFile` reaches, when it is one. */
  const resolveToFile = (specifier: string, fromFile: string): { file: string; viaPackage: boolean } | null => {
    const resolved: ResolvedImport = graph.resolver.resolve(specifier, fromFile);
    if (resolved.kind === 'internal-file') return { file: resolved.target, viaPackage: false };
    if (resolved.kind === 'workspace-package' && resolved.entry !== null) return { file: resolved.entry, viaPackage: true };
    return null;
  };

  const exportsCache = new Map<string, Map<string, OwnExport>>();
  const ownExports = (file: string): Map<string, OwnExport> => {
    let result = exportsCache.get(file);
    if (result === undefined) {
      const facts = parsed.get(file);
      result = facts === undefined ? new Map() : ownExportsOf(facts);
      exportsCache.set(file, result);
    }
    return result;
  };

  const surfaces = new Map<string, Map<string, SurfaceEntry>>();
  const computing = new Set<string>();
  const surface = (file: string): Map<string, SurfaceEntry> => {
    const memoed = surfaces.get(file);
    if (memoed !== undefined) return memoed;
    // A barrel that re-exports, directly or not, from a file which re-exports
    // from it: what is still being computed is not used. That breaks the cycle
    // without asserting anything about it.
    if (computing.has(file)) return new Map();
    computing.add(file);
    const result = new Map<string, SurfaceEntry>();
    for (const own of ownExports(file).values()) {
      result.set(own.name, { file, name: own.name, kind: own.kind, line: own.line, chain: [] });
    }
    const facts = parsed.get(file);
    if (facts !== undefined) {
      for (const record of facts.exports) {
        if (record.fromSpecifier === undefined) continue;
        const target = resolveToFile(record.fromSpecifier, file);
        if (target === null) continue;
        if (record.kind === 'star') {
          for (const [name, entry] of surface(target.file)) {
            if (name === 'default' || result.has(name) || entry.namespaceOf !== undefined) continue;
            result.set(name, {
              file: entry.file,
              name: entry.name,
              kind: entry.kind,
              line: entry.line,
              reexportedAt: record.line,
              chain: entry.file === target.file ? [] : [target.file, ...entry.chain],
            });
          }
          continue;
        }
        // `export * as ns from './x'`: the namespace itself is what is exported.
        if (record.names === undefined) {
          result.set(record.name, { file: target.file, name: record.name, kind: 'unknown', line: record.line, reexportedAt: record.line, chain: [], namespaceOf: target.file });
          continue;
        }
        // `export { a as b } from './x'`: the extractor emits one record per name.
        const entry = surface(target.file).get(record.names[0] ?? '');
        if (entry === undefined || entry.namespaceOf !== undefined) continue;
        result.set(record.name, {
          file: entry.file,
          name: entry.name,
          kind: entry.kind,
          line: entry.line,
          reexportedAt: record.line,
          chain: entry.file === target.file ? [] : [target.file, ...entry.chain],
        });
      }
    }
    computing.delete(file);
    surfaces.set(file, result);
    return result;
  };

  const sites: ImportSite[] = [];
  const sitesByTarget = new Map<string, ImportSite[]>();
  const bindings = new Map<string, SymbolReference[]>();
  const possible = new Map<string, SymbolReference[]>();
  const reexports = new Map<string, ReexportSite[]>();

  for (const [file, facts] of parsed) {
    if (!codeFiles.has(file)) continue;
    for (const record of facts.imports) {
      const target = resolveToFile(record.specifier, file);
      if (target === null) continue;
      const site: ImportSite = {
        file,
        line: record.line,
        specifier: record.specifier,
        syntax: record.syntax,
        typeOnly: record.typeOnly,
        target: target.file,
        viaPackage: target.viaPackage,
        names: record.names,
      };
      if (record.defaultImport !== undefined) site.defaultImport = record.defaultImport;
      if (record.namespaceImport !== undefined) site.namespaceImport = record.namespaceImport;
      sites.push(site);
      push(sitesByTarget, target.file, site);
      // A re-export exposes the symbol; it does not use it. Whether anything
      // imports it through the barrel is answered by the barrel's own surface.
      if (record.syntax === 'reexport') continue;

      const targetSurface = surface(target.file);
      const viaFor = (entry: SurfaceEntry): string[] => (entry.file === target.file ? [] : [target.file, ...entry.chain]);
      const bind = (entry: SurfaceEntry, importedAs: string): void => {
        push(bindings, keyOf(entry.file, entry.name), {
          file,
          line: record.line,
          specifier: record.specifier,
          importedAs,
          typeOnly: record.typeOnly,
          via: viaFor(entry),
        });
      };
      const possibly = (entry: SurfaceEntry, importedAs: string): void => {
        push(possible, keyOf(entry.file, entry.name), {
          file,
          line: record.line,
          specifier: record.specifier,
          importedAs,
          typeOnly: record.typeOnly,
          via: viaFor(entry),
        });
      };
      for (const name of record.names) {
        const entry = targetSurface.get(name);
        if (entry === undefined) continue;
        if (entry.namespaceOf !== undefined) {
          // `import { ns } from './barrel'` for `export * as ns from './x'`.
          for (const member of surface(entry.namespaceOf).values()) {
            if (member.namespaceOf === undefined) possibly(member, `${name}.${member.name}`);
          }
          continue;
        }
        bind(entry, name);
      }
      if (record.defaultImport !== undefined) {
        const entry = targetSurface.get('default');
        if (entry !== undefined && entry.namespaceOf === undefined) bind(entry, record.defaultImport);
      }
      if (record.namespaceImport !== undefined) {
        for (const entry of targetSurface.values()) {
          if (entry.namespaceOf === undefined) possibly(entry, `${record.namespaceImport}.${entry.name}`);
        }
      }
    }
    for (const record of facts.exports) {
      if (record.fromSpecifier === undefined) continue;
      const target = resolveToFile(record.fromSpecifier, file);
      if (target === null) continue;
      const importedName = record.kind === 'star' ? '*' : record.names?.[0] ?? '*';
      push(reexports, target.file, { file, line: record.line, exportedName: record.name, importedName });
    }
  }
  sites.sort((a, b) => compareSites(a, b));
  for (const list of bindings.values()) list.sort(compareSites);
  for (const list of possible.values()) list.sort(compareSites);

  /**
   * Files whose exports may be imported from outside the analyzed tree.
   *
   * A barrel — an `index.*` inside a module — is an entry point by naming only,
   * at a low confidence. Taking it for public would make everything a barrel
   * re-exports unassailable, which is most exports. So only entry points the
   * repository declares or strongly signals count, plus the conventional entry
   * file of each package: a manifest that points at build output publishes the
   * surface of the source it is built from.
   */
  const publicEntryFiles = (): string[] => {
    const files = new Set<string>();
    for (const entry of graph.repository.entryPoints) {
      if (entry.type === 'test' || entry.confidence < 0.7) continue;
      if (codeFiles.has(entry.path)) files.add(entry.path);
    }
    for (const module of graph.repository.modules) {
      if (module.basis !== 'workspace-package') continue;
      for (const candidate of module.files) {
        const relative = module.path.length === 0 ? candidate : candidate.slice(module.path.length + 1);
        if (/^(src\/)?index\.[cm]?[jt]sx?$/.test(relative)) files.add(candidate);
      }
    }
    return [...files].sort(compareStrings);
  };
  let publicKeysCache: Set<string> | null = null;

  return {
    sites,
    sitesByTarget,
    bindings,
    possible,
    ownExports,
    surface,
    reexportedBy: (file, name) =>
      (reexports.get(file) ?? [])
        .filter((site) => site.importedName === name || (site.importedName === '*' && name !== 'default'))
        .map((site) => ({ file: site.file, line: site.line, name: site.importedName === '*' ? name : site.exportedName }))
        .sort((a, b) => compareSites(a, b) || compareStrings(a.name, b.name)),
    opaqueModuleSystem: (file) => (parsed.get(file)?.exports ?? []).some((record) => record.name === 'export='),
    publicKeys: () => {
      if (publicKeysCache !== null) return publicKeysCache;
      const keys = new Set<string>();
      for (const file of publicEntryFiles()) {
        for (const entry of surface(file).values()) {
          if (entry.namespaceOf === undefined) keys.add(keyOf(entry.file, entry.name));
        }
      }
      publicKeysCache = keys;
      return keys;
    },
  };
}

/** What a navigation answer cannot see, in the words of the answer. */
export function navigationCaveats(graph: KnowledgeGraph): string[] {
  const caveats: string[] = [];
  const unparsed = graph.repository.files.filter((file) => file.kind === 'source' && file.parseStatus === 'skipped' && !file.sensitive);
  if (unparsed.length > 0) {
    caveats.push(
      `${unparsed.length} source file(s) of an unsupported language (${uniqueSorted(unparsed.map((file) => extname(file.path))).join(', ')}) were not parsed; an import there is invisible here.`,
    );
  }
  const unfollowed = graph.unresolved.filter(
    (entry) => entry.reason === 'missing' || entry.reason === 'unresolved-alias' || entry.reason === 'excluded-file',
  );
  if (unfollowed.length > 0) caveats.push(`${unfollowed.length} import(s) did not resolve and were not followed.`);
  return caveats;
}

/** Files that import `file`: the direct ones, and everything that depends on them. */
function importersOf(index: ReferenceIndex, graph: KnowledgeGraph, file: string): FileOutline['importers'] {
  const seen = new Set<string>([file]);
  let frontier = [file];
  const transitive: string[] = [];
  for (;;) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const site of index.sitesByTarget.get(current) ?? []) {
        if (seen.has(site.file)) continue;
        seen.add(site.file);
        next.push(site.file);
      }
    }
    if (next.length === 0) break;
    transitive.push(...next);
    frontier = next;
  }
  const directSites = index.sitesByTarget.get(file) ?? [];
  const directFiles = new Set(directSites.map((site) => site.file));
  const sorted = [...transitive].filter((path) => !directFiles.has(path)).sort(compareStrings);
  return {
    direct: directSites
      .map((site) => ({ file: site.file, line: site.line, specifier: site.specifier, syntax: site.syntax, typeOnly: site.typeOnly, names: site.names, target: file, targetKind: 'internal-file' as const }))
      .sort((a, b) => compareSites(a, b)),
    transitive: sorted.slice(0, MAX_TRANSITIVE_IMPORTERS),
    transitiveCount: sorted.length,
    tests: [...transitive].filter((path) => graph.filesByPath.get(path)?.kind === 'test').sort(compareStrings),
  };
}

/** The imports of one file, each with what it resolves to. */
export function importLinesOf(graph: KnowledgeGraph, parsed: Map<string, ParsedFile>, file: string): ImportLine[] {
  return (parsed.get(file)?.imports ?? [])
    .map((record): ImportLine => {
      const resolved = graph.resolver.resolve(record.specifier, file);
      // Every kind the resolver reports maps onto an import line as it is.
      const targetKind = resolved.kind as ImportLine['targetKind'];
      const line: ImportLine = {
        line: record.line,
        specifier: record.specifier,
        syntax: record.syntax,
        typeOnly: record.typeOnly,
        names: record.names,
        target: resolved.kind === 'unresolved' ? null : resolved.target,
        targetKind,
      };
      if (resolved.kind === 'unresolved' && resolved.reason !== undefined) line.reason = resolved.reason;
      return line;
    })
    .sort((a, b) => a.line - b.line);
}

/** Builds the outline of a file. */
export function buildFileOutline(
  graph: KnowledgeGraph,
  parsed: Map<string, ParsedFile>,
  index: ReferenceIndex,
  file: string,
): FileOutline | null {
  const node = graph.filesByPath.get(file);
  const facts = parsed.get(file);
  if (node === undefined || facts === undefined) return null;
  const countOf = (map: Map<string, SymbolReference[]>, entry: SurfaceEntry): number => map.get(keyOf(entry.file, entry.name))?.length ?? 0;
  const exportsList: FileOutline['exports'] = [];
  for (const [name, entry] of index.surface(file)) {
    // For a re-export, the line to open in *this* file is the statement; the
    // declaration belongs to the other file and is given as such.
    const reexported = entry.file !== file;
    exportsList.push({
      name,
      kind: entry.kind,
      line: reexported ? (entry.reexportedAt ?? entry.line) : entry.line,
      isDefault: name === 'default',
      references: countOf(index.bindings, entry),
      possibleReferences: countOf(index.possible, entry),
      ...(reexported ? { reexportedFrom: entry.file, declaredLine: entry.line } : {}),
    });
  }
  exportsList.sort((a, b) => a.line - b.line || compareStrings(a.name, b.name));
  const exportedNames = new Set(facts.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name));
  const internalSymbols = facts.symbols
    .filter((symbol) => !symbol.exported && !symbol.isDefault && !exportedNames.has(symbol.name))
    .map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line }))
    .sort((a, b) => a.line - b.line || compareStrings(a.name, b.name));
  return {
    file,
    module: node.moduleId,
    language: node.language,
    kind: node.kind,
    parseStatus: node.parseStatus,
    exports: exportsList,
    internalSymbols,
    imports: importLinesOf(graph, parsed, file),
    importers: importersOf(index, graph, file),
    routes: facts.routes,
    caveats: navigationCaveats(graph),
  };
}

/** A report for a target that could not be resolved to a symbol. */
export function emptyReferenceReport(): ReferenceReport {
  return {
    target: null,
    status: 'not-found',
    candidates: [],
    references: [],
    possibleReferences: [],
    reexportedBy: [],
    externallyReachable: false,
    count: 0,
    evidence: [],
    caveats: [],
  };
}

/** Where a symbol declared in `file` is used. */
export function buildReferenceReport(
  graph: KnowledgeGraph,
  index: ReferenceIndex,
  target: ReferenceTarget,
): ReferenceReport {
  const key = keyOf(target.file, target.symbol);
  const references = index.bindings.get(key) ?? [];
  const possibleReferences = index.possible.get(key) ?? [];
  const reexportedBy = target.exported ? index.reexportedBy(target.file, target.symbol) : [];
  const externallyReachable = index.publicKeys().has(key);
  const caveats = navigationCaveats(graph);
  if (!target.exported) caveats.unshift('The symbol is not exported from its file, so no other file can import it.');
  else if (references.length === 0 && possibleReferences.length === 0) {
    caveats.unshift('No analyzed file imports it. Uses inside its own file are not import statements and are not listed.');
  }
  return {
    target,
    status: 'found',
    candidates: [],
    references,
    possibleReferences,
    reexportedBy,
    externallyReachable,
    count: references.length + possibleReferences.length,
    evidence: [
      { source: target.file, detail: `declared at line ${target.line}` },
      ...references.slice(0, 3).map((reference) => ({
        source: reference.file,
        detail: `imported at line ${reference.line} from '${reference.specifier}'${reference.via.length > 0 ? ` through ${reference.via.join(', ')}` : ''}`,
      })),
    ],
    caveats,
  };
}

/**
 * Named exports that no analyzed file imports and no entry point reaches.
 *
 * A finding here is a statement about the analyzed tree — "nothing in it
 * imports this" — and carries a confidence for that reason. Default exports
 * are not assessed: they are how a framework loads a file by convention.
 */
export function buildUnusedExports(
  graph: KnowledgeGraph,
  index: ReferenceIndex,
  options: { limit?: number } = {},
): UnusedExportsReport {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  const caveats = navigationCaveats(graph);
  const publicKeys = index.publicKeys();
  // The confidence is that of "nothing imports this", which is only as good as
  // the coverage: a file of an unsupported language may import anything.
  const confidence = caveats.length === 0 ? 0.85 : caveats.some((caveat) => caveat.includes('were not parsed')) ? 0.6 : 0.7;
  const unassessableFiles = new Set<string>();
  for (const site of index.sites) {
    if (UNASSESSABLE_SYNTAX.has(site.syntax) && site.file !== site.target) unassessableFiles.add(site.target);
  }
  const unused: UnusedExport[] = [];
  const counts = { exported: 0, referenced: 0, publicApi: 0, unassessable: 0, unused: 0 };
  for (const node of graph.repository.files) {
    if (node.sensitive || node.kind !== 'source' || node.parseStatus === 'skipped') continue;
    if (node.language !== 'typescript' && node.language !== 'javascript') continue;
    // A declaration file is consumed by the type system without an import of its names.
    if (/\.d\.[cm]?ts$/.test(node.path) || index.opaqueModuleSystem(node.path)) continue;
    for (const own of index.ownExports(node.path).values()) {
      if (own.isDefault || own.name === 'default') continue;
      counts.exported += 1;
      const key = keyOf(node.path, own.name);
      if (publicKeys.has(key)) {
        counts.publicApi += 1;
        continue;
      }
      if ((index.bindings.get(key)?.length ?? 0) > 0) {
        counts.referenced += 1;
        continue;
      }
      if ((index.possible.get(key)?.length ?? 0) > 0 || unassessableFiles.has(node.path)) {
        counts.unassessable += 1;
        continue;
      }
      counts.unused += 1;
      if (unused.length >= limit) continue;
      unused.push({
        file: node.path,
        name: own.name,
        kind: own.kind,
        line: own.line,
        confidence,
        evidence: [
          { source: node.path, detail: `exported at line ${own.line}` },
          { source: '<imports>', detail: 'imported by 0 analyzed files' },
        ],
        reexportedBy: index.reexportedBy(node.path, own.name).map((entry) => entry.file),
      });
    }
  }
  unused.sort((a, b) => compareSites(a, b) || compareStrings(a.name, b.name));
  return {
    schemaVersion: graph.repository.schemaVersion,
    unused,
    counts,
    truncated: counts.unused > unused.length,
    caveats: [
      'Only named exports are assessed. Default exports, declaration files and test files are left out: a default export is how a framework loads a file by convention.',
      ...caveats,
    ],
  };
}
