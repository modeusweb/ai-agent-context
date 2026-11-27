#!/usr/bin/env node
/**
 * Independent ground truth for the dependency graph, from the TypeScript
 * compiler.
 *
 * Why this exists: `summary.imports.resolutionRate` is the product's headline
 * number, and it is produced by the analyzer reporting on itself. A resolver bug
 * and its own accuracy check can only ever agree with each other.
 *
 * The TypeScript compiler is already a dev dependency, resolves modules for its
 * own reasons, and shares no code with this project. Extracting specifiers with
 * `ts.createSourceFile` and resolving them with `ts.resolveModuleName` therefore
 * gives a second opinion about the same repository, and the comparison can fail.
 *
 * The only input taken from the analyzer is the file-to-module mapping, which is
 * a partition of the file list rather than a claim about dependencies. Everything
 * that decides whether an edge exists comes from the compiler.
 *
 * The dependency claims are independent of the analyzer, but the *scope* is
 * deliberately shared: the oracle reads the repository's `.agent/config.json`
 * and applies its include/exclude/ignore patterns to its own walk. Before that,
 * a truth pair could involve a file the analyzer was configured not to read —
 * 43 pairs under `fixtures/` here — and was counted as "not compared". A metric
 * with an unexplained hole in its denominator cannot be a gate. The patterns
 * are the repository's own instructions, borrowed only to decide which files
 * are in scope, never to decide whether an import exists or resolves.
 *
 * Two representation differences are normalised explicitly, and both are counted
 * and reported so the normalisation cannot quietly absorb a disagreement:
 *
 *  - The analyzer reports an import of `@ai-agent-context/core` as an edge to
 *    that package, because that is what the specifier names. The compiler
 *    reports the file it resolved to, which is the package's build output.
 *  - Neither graph reports the same thing at two levels of detail as a single
 *    edge, so package-level edges are compared as package-level edges.
 *
 * Usage:
 *   node tools/ground-truth.mjs [repoRoot]
 *   node tools/ground-truth.mjs --json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AgentContext, Logger, PatternSet, loadConfig, runPipeline } from '../packages/core/dist/index.js';
import { oracleFailures } from './oracle-gate.mjs';

const explicitRoot = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const repoRoot = path.resolve(explicitRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const asJson = process.argv.includes('--json');

/**
 * The scope both sides are compared on.
 *
 * `loadConfig` reads the repository's own file, its defaults and any
 * organization policy. `PatternSet` is the analyzer's glob engine: using it here
 * is not borrowing an answer about dependencies, it is making sure the oracle
 * and the analyzer agree on which files exist for the purpose of this check.
 */
const loadedConfig = await loadConfig({ root: repoRoot });
const scope = {
  source: loadedConfig.source ?? 'defaults and organization policy',
  include: new PatternSet(loadedConfig.config.include),
  exclude: new PatternSet(loadedConfig.config.exclude),
  ignore: new PatternSet(loadedConfig.config.ignore),
};
const configExcludedFiles = [];

/** Whether a repository-relative source file is inside the configured scope. */
function inScope(relative) {
  const normalized = relative.split(path.sep).join('/');
  if (scope.exclude.test(normalized) || scope.ignore.test(normalized)) return false;
  return scope.include.isEmpty || scope.include.matchesAny(normalized);
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/** Never analyzed here, so never part of ground truth either. */
const ALWAYS_EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.agent']);
/** Directories whose contents are generated rather than authored. */
const BUILD_OUTPUT = new Set(['dist', 'build', 'out', 'coverage']);

function toRelative(absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

/**
 * Walks the tree with rules written here rather than borrowed from the analyzer.
 *
 * Dot-directories are not skipped wholesale: `.changeset/` and `.github/` can
 * hold authored TypeScript, and the analyzer reads them. Skipping them here
 * produced analyzer pairs the oracle could not compare. Only the hard excludes
 * below, which neither side analyzes, prune directories.
 */
function walk(dir, { extensions, manifests }, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDED.has(entry.name)) continue;
      walk(full, { extensions, manifests }, acc);
      continue;
    }
    // Symlinks are skipped for the same reason the analyzer skips them: they can
    // point outside the repository and would make the two graphs incomparable.
    if (entry.isSymbolicLink()) continue;
    if (manifests && entry.name === 'package.json') {
      acc.push(full);
      continue;
    }
    if (manifests || !extensions.has(path.extname(entry.name))) continue;
    const relative = toRelative(full);
    if (!inScope(relative)) {
      configExcludedFiles.push(relative);
      continue;
    }
    acc.push(full);
  }
  return acc;
}

/** Workspace package name to its directory, read from the package manifests. */
function readWorkspacePackages() {
  const byName = new Map();
  for (const manifest of manifests) {
    if (typeof manifest.parsed.name === 'string') {
      byName.set(manifest.parsed.name, manifest.directory);
    }
  }
  return byName;
}

/**
 * Every package manifest in the tree, including ones without a `name`.
 *
 * A manifest without a name cannot be a dependency target, but it can still be
 * the package a file belongs to, and which dependencies it declares is the
 * evidence for whether a bare specifier reaches the registry.
 */
function readManifests() {
  const manifests = [];
  for (const manifestPath of walk(repoRoot, { extensions: new Set(), manifests: true })) {
    try {
      manifests.push({ directory: path.resolve(path.dirname(manifestPath)), parsed: JSON.parse(readFileSync(manifestPath, 'utf8')) });
    } catch {
      // A manifest we cannot read declares nothing.
    }
  }
  return manifests;
}

/** The manifest that owns a file: the nearest ancestor directory that has one. */
function nearestManifest(file) {
  let directory = path.dirname(path.resolve(file));
  while (true) {
    for (const manifest of manifests) {
      if (manifest.directory === directory) return manifest;
    }
    const parent = path.dirname(directory);
    if (parent === directory || directory.length < repoRoot.length) break;
    directory = parent;
  }
  return null;
}

/**
 * The version range a manifest declares for a package, or `null`.
 *
 * Returning the range rather than a boolean is what lets the caller tell a
 * `workspace:` protocol from a registry version, which are different facts.
 */
function declaredRange(manifest, packageName) {
  if (manifest === null) return null;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const declared = manifest.parsed[field];
    if (declared !== null && typeof declared === 'object' && Object.hasOwn(declared, packageName)) {
      const value = declared[packageName];
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

const manifests = readManifests();
const packagesByName = readWorkspacePackages();
const workspaceNames = readWorkspaceMemberNames();

/**
 * Workspace membership, read from the workspace configuration.
 *
 * Only a declared member counts, and that distinction is load-bearing. A
 * repository can contain a package manifest whose `name` matches the package it
 * sits next to without being part of any workspace — a benchmark directory that
 * pins the published `clsx@1.1.0` next to the `clsx` sources is the ordinary
 * case. Treating that bare specifier as an in-repo edge would add an edge the
 * analyzer deliberately does not draw, and make it look wrong for being right.
 *
 * The analyzer reads membership from the same place, so the oracle has to as
 * well; mirroring it here is not copying an implementation, it is the only way
 * for two graphs to be comparable at all.
 */
function readWorkspaceMemberNames() {
  const patterns = readWorkspacePatterns();
  if (patterns.length === 0) return new Set();
  const names = new Set();
  for (const [name, directory] of packagesByName) {
    const relative = path.relative(repoRoot, directory).split(path.sep).join('/');
    if (patterns.some((pattern) => matchesWorkspacePattern(relative, pattern))) names.add(name);
  }
  return names;
}

/** Workspace directory patterns, from npm/yarn `workspaces` or pnpm's own file. */
function readWorkspacePatterns() {
  const patterns = [];
  try {
    const parsed = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const declared = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : parsed.workspaces?.packages;
    if (Array.isArray(declared)) {
      for (const entry of declared) if (typeof entry === 'string') patterns.push(entry);
    }
  } catch {
    // A repository with no readable root manifest declares no workspace.
  }
  const pnpm = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(pnpm)) return patterns;
  // The `packages:` list is a flat run of dash-prefixed paths, which is all
  // that is needed here; taking a YAML dependency for it would not pay for
  // itself in a script whose whole point is to stay independent of the product.
  let inPackages = false;
  for (const line of readFileSync(pnpm, 'utf8').split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (match !== null) {
      patterns.push(match[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (line.trim() !== '') break;
  }
  return patterns;
}

/** Matches a workspace-relative directory against a pattern such as `packages/*`. */
function matchesWorkspacePattern(directory, pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  const actual = directory.split('/').filter((segment) => segment !== '');
  let cursor = 0;
  for (const segment of segments) {
    if (segment === '**') return true;
    if (cursor >= actual.length) return false;
    if (segment !== '*' && segment !== actual[cursor]) return false;
    cursor += 1;
  }
  return cursor === actual.length;
}

/**
 * The workspace package that owns an absolute path, if any.
 *
 * The deepest matching package wins. Taking the first match would let the
 * repository's own root manifest claim every file, because its directory is the
 * whole tree — which silently turns every unresolvable path into a dependency on
 * the root package and fabricates edges.
 */
function packageOwning(absolute) {
  let owner = null;
  let ownerDepth = -1;
  for (const [name, directory] of packagesByName) {
    if (directory === repoRoot) continue;
    if (absolute !== directory && !absolute.startsWith(`${directory}${path.sep}`)) continue;
    const depth = directory.split(path.sep).length;
    if (depth > ownerDepth) {
      owner = name;
      ownerDepth = depth;
    }
  }
  return owner;
}

/** Build output inside the repository, which the analysis excludes by design. */
function isExcludedBuildOutput(absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (relative === '' || relative.startsWith('..')) return false;
  return relative.split(path.sep).some((segment) => BUILD_OUTPUT.has(segment));
}

function insideRepo(absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (relative === '' || relative.startsWith('..')) return false;
  return !relative.split(path.sep).some((segment) => ALWAYS_EXCLUDED.has(segment));
}

/** Every import specifier in a file, found by the compiler's own parser. */
function specifiersIn(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    const isModuleSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier);
    if (isModuleSpecifier) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteral(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.getText(source) === 'require') {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // A dynamic `import('x')`. The compiler sees it wherever it is written,
      // including inside a function body, which is where lazy loading puts it.
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * The repository's own TypeScript resolution options.
 *
 * Without `paths` from the tsconfig, the compiler cannot resolve a single
 * aliased import, and every alias edge the analyzer draws counts as a false
 * positive — the measurement disagreeing with the product about a rule the
 * product had read correctly. The options are read with the compiler's own
 * parser, so the alias table is the one in the repository rather than a
 * reimplementation of it.
 */
function readCompilerOptions() {
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
    baseUrl: repoRoot,
  };
  const configPath = path.join(repoRoot, 'tsconfig.json');
  if (!existsSync(configPath)) return options;
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error !== undefined) return options;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
    if (parsed.options.paths !== undefined) {
      // `paths` are relative to the tsconfig, and the compiler needs a base to
      // resolve them against. A config with `paths` and no `baseUrl` is common
      // — the base is then the directory of the tsconfig itself.
      const base = parsed.options.baseUrl === undefined ? repoRoot : path.resolve(repoRoot, parsed.options.baseUrl);
      options.baseUrl = base;
      options.paths = {};
      for (const [pattern, targets] of Object.entries(parsed.options.paths)) {
        options.paths[pattern] = targets.map((target) => path.resolve(base, target));
      }
    } else if (parsed.options.baseUrl !== undefined) {
      options.baseUrl = path.resolve(repoRoot, parsed.options.baseUrl);
    }
  } catch {
    // A tsconfig the compiler cannot read leaves the default options in place.
  }
  return options;
}

/**
 * Ground truth: importer to imported file, plus importer to workspace package.
 *
 * Type-only imports are counted. They are real edges in the graph this product
 * builds, and excluding them would quietly shrink the denominator.
 */
function buildGroundTruth() {
  const compilerOptions = readCompilerOptions();
  const filePairs = new Set();
  const packagePairs = new Set();
  let specifiers = 0;
  let external = 0;
  let unresolved = 0;
  let inRepo = 0;
  let excludedOutput = 0;

  const files = walk(repoRoot, { extensions: SOURCE_EXTENSIONS, manifests: false });
  for (const file of files) {
    for (const specifier of specifiersIn(file)) {
      specifiers += 1;

      // A bare specifier naming a package in this repository is usually an
      // in-repo dependency rather than an external one, but "usually" is doing
      // real work in that sentence and each case has to be decided separately.
      //
      // The lookup is on the *package name*, never the whole specifier:
      // `@radix-ui/env-check/is-development` is a dependency on
      // `@radix-ui/env-check`. Testing the whole string missed every subpath
      // import, and in a monorepo that is most of them — each one was counted as
      // an external package, so the analyzer was reported as inventing edges for
      // dependencies the manifests declared plainly.
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (packagesByName.has(packageName)) {
        const range = declaredRange(nearestManifest(file), packageName);
        const isWorkspaceProtocol = range !== null && range.startsWith('workspace:');
        // Declared as a registry range and not a workspace member: this is a
        // published package the repository depends on. `clsx` keeps a `bench/`
        // directory that pins `clsx@1.1.0` next to the `clsx` sources, on
        // purpose, to compare against the released build.
        //
        // A `workspace:` protocol is the opposite and is unconditional. It says
        // the dependency *is* this repository's own package, and it is the one
        // declaration that cannot mean anything else. Trusting it also covers the
        // case no glob can: in a pnpm workspace a package can be depended on by
        // name while matching no `packages/*` pattern at all.
        if (workspaceNames.has(packageName) || range === null || isWorkspaceProtocol) {
          // Otherwise it is either a workspace member or a self-reference. The
          // second case is `ky` importing `ky` from its own type tests, which
          // means the local entry point, not a download. An undeclared bare
          // import of your own package name is what self-reference looks like;
          // package managers require real dependencies to be declared.
          packagePairs.add(`${toRelative(file)} -> ${packageName}`);
          continue;
        }
      }
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        external += 1;
        continue;
      }

      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
      if (resolved === undefined) {
        unresolved += 1;
        continue;
      }
      const absolute = path.resolve(path.dirname(file), resolved.resolvedFileName);
      if (insideRepo(absolute)) {
        inRepo += 1;
        filePairs.add(`${toRelative(file)} -> ${toRelative(absolute)}`);
        continue;
      }
      if (isExcludedBuildOutput(absolute)) {
        // A test importing `../core/dist/index.js` is a real import, and the
        // analyzer deliberately declines to turn it into a graph edge: build
        // output is excluded from the analysis, and an edge derived from it
        // would make the dependency graph depend on whether the project happened
        // to be built. The analyzer accounts for these separately as
        // `excludedOutput`, and so does this script.
        excludedOutput += 1;
        continue;
      }
      // Anything still owned by a workspace package, for example a package
      // resolved through node_modules, is an in-repo dependency.
      const owning = packageOwning(absolute);
      if (owning !== null) packagePairs.add(`${toRelative(file)} -> ${owning}`);
    }
  }
  return {
    filePairs,
    packagePairs,
    files: files.length,
    /** The files the oracle looked at, relative: what its walk reached and what it did not. */
    scanned: new Set(files.map(toRelative)),
    specifiers,
    inRepo,
    external,
    unresolved,
    excludedOutput,
  };
}

/**
 * The analyzer's file-to-module partition, used only to lift edges to modules.
 *
 * Built from the module list rather than from `fileImports`, because a file that
 * imports nothing appears in no import list. Using `fileImports` here would drop
 * the module of every import-free file and silently delete the edges that end at
 * one — which looks exactly like an analyzer miss.
 */
async function analyzerGraph() {
  const context = await AgentContext.load({ root: repoRoot });
  const document = await context.getDependencies();
  const repository = await context.getRepository();
  const moduleOf = new Map();
  for (const module of repository.modules) {
    for (const file of module.files) moduleOf.set(file, module.id);
  }
  const edges = new Set();
  for (const edge of document.internal) {
    // Both kinds are module edges and both are compared: an edge to a workspace
    // package is matched to the file the compiler resolved by `targetsMatch`.
    edges.add(`${edge.from} -> ${edge.to}`);
  }
  return { moduleOf, edges, document };
}

/**
 * Every import the analyzer resolved, at the level of files.
 *
 * `getDependencies()` publishes module edges only. A file-level pair is where
 * an import that the analyzer never recorded shows: lifted to modules, an
 * import between two files of one module is not an edge at all, so a missing
 * one leaves nothing to miss. Until 1.1.0 the extractor did not record a
 * `require()` or a dynamic `import()` written inside a declaration or a
 * function — which is where nearly all of them are written — and the
 * module-level comparison could not see it.
 */
async function analyzerFilePairs() {
  // A dry run: this is a check, and it must leave `.agent/` as it found it.
  const result = await runPipeline({ root: repoRoot, dryRun: true, logger: new Logger({ level: 'silent' }) });
  const files = new Set();
  const packages = new Map();
  /** Every file the analyzer resolved an importer to, for rules that match by name. */
  const targetsByFrom = new Map();
  for (const edge of result.graph.fileEdges) {
    if (edge.relationship !== 'imports' && edge.relationship !== 'exports') continue;
    if (edge.kind === 'internal-file') {
      files.add(`${edge.from} -> ${edge.to}`);
      const targets = targetsByFrom.get(edge.from) ?? new Set();
      targets.add(edge.to);
      targetsByFrom.set(edge.from, targets);
      continue;
    }
    // A workspace package is recorded by name; the compiler resolves it to a
    // file inside the package, which is the rule `targetsMatch` applies.
    if (edge.kind === 'workspace-package') {
      const names = packages.get(edge.from) ?? new Set();
      names.add(edge.to);
      packages.set(edge.from, names);
    }
  }
  // Every file the analyzer read, of any kind: what tells a pair outside the
  // analyzer's configuration from a pair it should have had and did not.
  const analyzed = new Set(result.graph.repository.files.map((file) => file.path));
  return { files, packages, targetsByFrom, analyzed };
}

const truth = buildGroundTruth();
const { moduleOf, edges: analyzerEdges, document } = await analyzerGraph();
/** Truth targets per importer, for the file-level rules that match by name. */
const truthPairsByFrom = new Map();
/** Truth packages per importer: the oracle records a package where the analyzer may record a file in it. */
const truthPackagesByFrom = new Map();
for (const pair of truth.filePairs) {
  const [from, to] = pair.split(' -> ');
  const targets = truthPairsByFrom.get(from) ?? new Set();
  targets.add(to);
  truthPairsByFrom.set(from, targets);
}
for (const pair of truth.packagePairs) {
  const [from, packageName] = pair.split(' -> ');
  const names = truthPackagesByFrom.get(from) ?? new Set();
  names.add(packageName);
  truthPackagesByFrom.set(from, names);
}

// Lift the ground truth to module edges using the file-to-module partition.
const truthModuleEdges = new Set();
for (const pair of truth.filePairs) {
  const [from, to] = pair.split(' -> ');
  const fromModule = moduleOf.get(from);
  const toModule = moduleOf.get(to);
  if (fromModule === undefined || toModule === undefined) continue;
  if (fromModule === toModule) continue;
  truthModuleEdges.add(`${fromModule} -> ${toModule}`);
}
for (const pair of truth.packagePairs) {
  const [from, packageName] = pair.split(' -> ');
  const fromModule = moduleOf.get(from);
  if (fromModule === undefined) continue;
  // A package importing its own name depends on its own entry point. That is
  // an import inside one module, like any other between two of its files, and
  // is not lifted to a module edge either.
  if (fromModule === packageName) continue;
  truthModuleEdges.add(`${fromModule} -> ${packageName}`);
}

/**
 * An analyzer target matches a truth target when they are equal, or when the
 * analyzer target is a workspace package whose directory contains the truth
 * target. Both describe one dependency at different levels of detail.
 */
function targetsMatch(analyzerTarget, truthTarget) {
  if (analyzerTarget === truthTarget) return true;
  const directory = packagesByName.get(analyzerTarget);
  if (directory === undefined) return false;
  const relative = toRelative(directory);
  return truthTarget === relative || truthTarget.startsWith(`${relative}/`);
}

let truePositive = 0;
let matchedViaPackage = 0;
const falsePositives = [];
for (const edge of analyzerEdges) {
  const [from, to] = edge.split(' -> ');
  let matched = false;
  for (const candidate of truthModuleEdges) {
    const [truthFrom, truthTo] = candidate.split(' -> ');
    if (truthFrom !== from) continue;
    if (!targetsMatch(to, truthTo)) continue;
    matched = true;
    if (to !== truthTo) matchedViaPackage += 1;
    break;
  }
  if (matched) truePositive += 1;
  else falsePositives.push(edge);
}

const falseNegatives = [];
for (const candidate of truthModuleEdges) {
  const [truthFrom, truthTo] = candidate.split(' -> ');
  let matched = false;
  for (const edge of analyzerEdges) {
    const [from, to] = edge.split(' -> ');
    if (from !== truthFrom) continue;
    if (!targetsMatch(to, truthTo)) continue;
    matched = true;
    break;
  }
  if (!matched) falseNegatives.push(candidate);
}

/**
 * The same comparison at the level of files, where no lift can hide an import.
 *
 * Three things make a truth pair (importer → resolved file) and an analyzer
 * pair describe one dependency without being the same string, and each is
 * counted so that none can absorb a real disagreement:
 *
 *  - **Package rule.** The analyzer resolved the importer to a workspace
 *    package; the compiler resolved it to a file inside that package.
 *  - **Declaration rule.** The compiler resolved to a declaration file
 *    (`x.d.ts`, `x.d.mts`) that stands next to its implementation; the analyzer
 *    resolved to the implementation. They are one dependency: for "who imports
 *    this file" the implementation is the more useful of the two to name.
 *
 * A truth pair whose importer or target the analyzer did not read at all is
 * outside the comparison and counted as `outsideConfiguration`. Since both
 * walks apply the repository's configured scope, such a pair is now an
 * anomaly — a file the configuration allows but the analyzer did not read,
 * for example because a `.gitignore` or the sensitive-file policy excluded it
 * — rather than a known instruction the oracle failed to honour. It is still
 * reported and never silently dropped.
 */
const analyzerFiles = await analyzerFilePairs();
/** `x.d.ts`, `x.d.mts` and `x.d.cts` describe an implementation; they are not files of their own. */
const isDeclaration = (file) => /\.d\.(mts|cts|ts)$/.test(file);
/** A path without its last extension: `x.d.mts` and `x.mjs` both have the stem `x`. */
const stemOf = (file) => file.replace(/\.d\.(mts|cts|ts)$/, '').replace(/\.[^./]+$/, '');
const fileTargetsMatch = (analyzerTarget, truthTarget) =>
  analyzerTarget === truthTarget ||
  (isDeclaration(truthTarget) && !isDeclaration(analyzerTarget) && stemOf(analyzerTarget) === stemOf(truthTarget));

const fileFalseNegatives = [];
const outsideConfiguration = [];
let fileTruePositive = 0;
let fileMatchedViaPackage = 0;
let fileMatchedViaDeclaration = 0;
for (const pair of truth.filePairs) {
  const [from, to] = pair.split(' -> ');
  if (analyzerFiles.files.has(pair)) {
    fileTruePositive += 1;
    continue;
  }
  const viaPackage = [...(analyzerFiles.packages.get(from) ?? [])].some((packageName) => targetsMatch(packageName, to));
  if (viaPackage) {
    fileTruePositive += 1;
    fileMatchedViaPackage += 1;
    continue;
  }
  const declaration = [...(analyzerFiles.targetsByFrom.get(from) ?? [])].find((target) => fileTargetsMatch(target, to));
  if (declaration !== undefined) {
    fileTruePositive += 1;
    fileMatchedViaDeclaration += 1;
    continue;
  }
  if (!analyzerFiles.analyzed.has(from) || !analyzerFiles.analyzed.has(to)) {
    outsideConfiguration.push(pair);
    continue;
  }
  fileFalseNegatives.push(pair);
}
// An analyzer pair is unexplained when no truth pair covers it under the same
// three rules — the package rule included in the other direction: the oracle
// records a workspace package where the analyzer, having read the same tsconfig,
// resolved to a file inside it.
const outsideWalk = [];
let fileExtraViaPackage = 0;
const fileFalsePositives = [];
for (const pair of analyzerFiles.files) {
  const [from, to] = pair.split(' -> ');
  if (truth.filePairs.has(pair)) continue;
  if ([...(truthPairsByFrom.get(from) ?? [])].some((target) => fileTargetsMatch(to, target))) continue;
  if ([...(truthPackagesByFrom.get(from) ?? [])].some((packageName) => targetsMatch(packageName, to))) {
    fileExtraViaPackage += 1;
    continue;
  }
  // A file the oracle's own walk never reached — it skips every dot-directory
  // — is not something the analyzer can be compared against. Counted, not hidden.
  if (!truth.scanned.has(from) || !truth.scanned.has(to)) {
    outsideWalk.push(pair);
    continue;
  }
  fileFalsePositives.push(pair);
}
const filePrecision = fileTruePositive + fileFalsePositives.length === 0 ? null : fileTruePositive / (fileTruePositive + fileFalsePositives.length);
// The denominator is what was comparable. A pair outside the configuration was
// never compared, so counting it as found would flatter and counting it as
// missing would accuse; it is reported on its own line instead.
const fileComparable = fileTruePositive + fileFalseNegatives.length;
const fileRecall = fileComparable === 0 ? null : fileTruePositive / fileComparable;

/**
 * File-level cross-check of the headline claim.
 *
 * The module-level comparison is coarse: on this repository it is eighteen
 * edges, so one wrong edge moves it by five points. This check is finer. It asks
 * the compiler about every import the analyzer *failed* to resolve, which is the
 * only list of its failures the tool publishes, and classifies each one:
 *
 *  - `expectedBuildOutput` - the compiler resolves it into excluded build output,
 *    which is exactly the documented `excludedOutput` class;
 *  - `excludedFile` - the analyzer says the target exists but was left out of
 *    the analysis, and the compiler agrees it resolves to a real file. The
 *    claim is checked against the file system rather than taken on trust: if
 *    the file were not there, the analyzer would be claiming an exclusion for
 *    something that does not exist;
 *  - `agreedMissing` - the compiler cannot resolve it either, so both agree the
 *    import is broken;
 *  - `missed` - the compiler resolves it to in-repo source that the analyzer was
 *    supposed to resolve. Any entry here is a real miss, and the headline
 *    resolution rate is overstated.
 */
function classifyUnresolved(document) {
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
    baseUrl: repoRoot,
  };
  const counts = { total: 0, expectedBuildOutput: 0, excludedFile: 0, agreedMissing: 0, missed: 0 };
  const missed = [];
  for (const entry of document.unresolved ?? []) {
    counts.total += 1;
    const importer = path.join(repoRoot, entry.file);
    const resolved = ts.resolveModuleName(entry.specifier, importer, compilerOptions, ts.sys).resolvedModule;
    if (resolved === undefined) {
      counts.agreedMissing += 1;
      continue;
    }
    const absolute = path.resolve(path.dirname(importer), resolved.resolvedFileName);
    if (insideRepo(absolute)) {
      // The analyzer excluded the file on purpose — it is too large, or the
      // sensitive-file policy forbids reading it. That is a limit of the
      // coverage rather than a hole in the graph, and the claim is verified
      // here: the file has to exist for the exclusion to be honest.
      if (entry.reason === 'excluded-file' && existsSync(absolute)) {
        counts.excludedFile += 1;
        continue;
      }
      counts.missed += 1;
      if (missed.length < 5) missed.push(`${entry.file}: ${entry.specifier}`);
    } else if (isExcludedBuildOutput(absolute)) {
      counts.expectedBuildOutput += 1;
    } else {
      counts.agreedMissing += 1;
    }
  }
  return { counts, missed };
}
const unresolvedCrossCheck = classifyUnresolved(document);

const precision = truePositive + falsePositives.length === 0 ? null : truePositive / (truePositive + falsePositives.length);
const recall = truePositive + falseNegatives.length === 0 ? null : truePositive / (truePositive + falseNegatives.length);
const percent = (value) => (value === null ? null : Number((value * 100).toFixed(1)));

const result = {
  repository: toRelative(repoRoot) || '.',
  source: 'typescript compiler',
  scope: {
    source: scope.source,
    filesIncluded: truth.files,
    filesExcludedByConfig: configExcludedFiles.length,
    excludedSample: configExcludedFiles.slice(0, 5),
  },
  filesScanned: truth.files,
  specifiers: {
    total: truth.specifiers,
    inRepo: truth.inRepo,
    external: truth.external,
    unresolvedByCompiler: truth.unresolved,
    excludedBuildOutput: truth.excludedOutput,
  },
  filePairs: truth.filePairs.size,
  packagePairs: truth.packagePairs.size,
  truthModuleEdges: truthModuleEdges.size,
  analyzerModuleEdges: analyzerEdges.size,
  truePositive,
  falsePositive: falsePositives.length,
  falseNegative: falseNegatives.length,
  matchedViaPackageRule: matchedViaPackage,
  precisionPercent: percent(precision),
  recallPercent: percent(recall),
  unresolvedCrossCheck: unresolvedCrossCheck.counts,
  missedSample: unresolvedCrossCheck.missed,
  falsePositiveSample: falsePositives.slice(0, 5),
  falseNegativeSample: falseNegatives.slice(0, 5),
  fileLevel: {
    truthPairs: truth.filePairs.size,
    truthSample: [...truth.filePairs].slice(0, 5),
    analyzerPairs: analyzerFiles.files.size,
    truePositive: fileTruePositive,
    falsePositive: fileFalsePositives.length,
    falseNegative: fileFalseNegatives.length,
    matchedViaPackageRule: fileMatchedViaPackage,
    matchedViaDeclarationRule: fileMatchedViaDeclaration,
    analyzerPairsViaPackageRule: fileExtraViaPackage,
    outsideConfiguration: outsideConfiguration.length,
    outsideConfigurationSample: outsideConfiguration.slice(0, 5),
    outsideOracleWalk: outsideWalk.length,
    outsideOracleWalkSample: outsideWalk.slice(0, 5),
    precisionPercent: percent(filePrecision),
    recallPercent: percent(fileRecall),
    falsePositiveSample: fileFalsePositives.slice(0, 5),
    falseNegativeSample: fileFalseNegatives.slice(0, 5),
  },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`repository:        ${result.repository}`);
  console.log(`ground truth:     ${result.source}`);
  console.log(`files scanned:    ${result.filesScanned} (scope: ${result.scope.source}, ${result.scope.filesExcludedByConfig} excluded by config)`);
  console.log(`specifiers:       ${result.specifiers.total} total (${result.specifiers.inRepo} in-repo, ${result.specifiers.external} external, ${result.specifiers.unresolvedByCompiler} unresolved)`);
  console.log(`pairs:            ${result.filePairs} file + ${result.packagePairs} package -> ${result.truthModuleEdges} module edges`);
  console.log(`analyzer edges:   ${result.analyzerModuleEdges}`);
  console.log(`true positive:    ${result.truePositive}`);
  console.log(`false positive:   ${result.falsePositive}  ${result.falsePositiveSample.join('   ')}`);
  console.log(`false negative:   ${result.falseNegative}  ${result.falseNegativeSample.join('   ')}`);
  console.log(`package rule:     ${result.matchedViaPackageRule} match(es) needed package-level normalisation`);
  console.log(`precision:        ${result.precisionPercent === null ? 'n/a' : `${result.precisionPercent}%`}`);
  console.log(`recall:           ${result.recallPercent === null ? 'n/a' : `${result.recallPercent}%`}`);
  const file = result.fileLevel;
  console.log(`file level:       ${file.truePositive} of ${file.truthPairs} truth pair(s) found by the analyzer (${file.matchedViaPackageRule} via a workspace package, ${file.matchedViaDeclarationRule} via a declaration file)`);
  console.log(`file precision:   ${file.precisionPercent === null ? 'n/a' : `${file.precisionPercent}%`}  ${file.falsePositive} extra  ${file.falsePositiveSample.join('   ')}`);
  console.log(`file recall:      ${file.recallPercent === null ? 'n/a' : `${file.recallPercent}%`}  ${file.falseNegative} missing  ${file.falseNegativeSample.join('   ')}`);
  if (file.outsideConfiguration > 0) {
    console.log(`outside config:   ${file.outsideConfiguration} truth pair(s) involve a file the analyzer is configured not to read; not compared  ${file.outsideConfigurationSample.slice(0, 2).join('   ')}`);
  }
  if (file.outsideOracleWalk > 0 || file.analyzerPairsViaPackageRule > 0) {
    console.log(`not in the truth: ${file.outsideOracleWalk} analyzer pair(s) involve a file the oracle's walk does not reach (dot-directories); not compared. ${file.analyzerPairsViaPackageRule} analyzer pair(s) name a file where the truth names its package`);
  }
console.log(`unresolved cross-check: ${result.unresolvedCrossCheck.total} reported (${result.unresolvedCrossCheck.expectedBuildOutput} build output, ${result.unresolvedCrossCheck.excludedFile} excluded file, ${result.unresolvedCrossCheck.agreedMissing} agreed missing, ${result.unresolvedCrossCheck.missed} MISSED)`);
  if (result.missedSample.length > 0) console.log(`  missed: ${result.missedSample.join('   ')}`);
}

// One verdict for all three gates — module edges, file pairs and unresolved
// claims. `oracleFailures` is a separate module so the gate can be tested with
// a report that contains exactly one missing file pair.
const failures = oracleFailures(result);
for (const failure of failures) console.error(`\n${failure}`);
if (failures.length > 0) process.exitCode = 1;
