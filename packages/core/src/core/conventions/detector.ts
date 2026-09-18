/**
 * Observable convention detection.
 *
 * Guarantee: no convention is invented. Every statement comes from a counted
 * observation with counts and example files attached as evidence; small samples
 * get low confidence or are not reported at all.
 *
 * Categories: Naming, Imports, Tests, Error handling, Exports, Structure,
 * Toolchain, Documentation, Languages.
 */
import type { Convention, Evidence, Repository } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { AliasEntry } from '../graph/resolver.ts';
import { clampConfidence, compareStrings, shortHash } from '../../model/canonical.ts';
import { classifyIdentifierCase, ratio, splitIdentifier, type IdentifierCase } from '../../util/text.ts';
import { basename, stem } from '../../util/paths.ts';

/** Minimum sample sizes below which a convention is not reported. */
export const MIN_SAMPLE = {
  fileNaming: 6,
  symbols: 4,
  imports: 4,
  tests: 2,
  exports: 4,
} as const;

export interface ConventionDetectionInput {
  repository: Repository;
  parsed: Map<string, ParsedFile>;
  aliases: AliasEntry[];
}

export function makeConvention(
  category: string,
  statement: string,
  confidence: number,
  evidence: Evidence[],
  origin: Convention['origin'] = 'observed',
): Convention {
  return {
    id: `${category.toLowerCase()}:${shortHash(statement, 8)}`,
    category,
    statement,
    confidence: clampConfidence(confidence),
    evidence: evidence.slice(0, 4),
    origin,
  };
}

interface CaseTally {
  cases: Map<IdentifierCase, number>;
  total: number;
  examples: Map<IdentifierCase, string[]>;
}

function tallyCases(values: Array<{ key: string; sample: string }>): CaseTally {
  const cases = new Map<IdentifierCase, number>();
  const examples = new Map<IdentifierCase, string[]>();
  for (const entry of values) {
    const classification = classifyIdentifierCase(entry.key);
    if (classification === 'other') continue;
    cases.set(classification, (cases.get(classification) ?? 0) + 1);
    const list = examples.get(classification) ?? [];
    if (list.length < 3) list.push(entry.sample);
    examples.set(classification, list);
  }
  const total = [...cases.values()].reduce((sum, count) => sum + count, 0);
  return { cases, total, examples };
}

/** Returns the dominant case when it passes the threshold, otherwise `null`. */
function dominantCase(
  tally: CaseTally,
  minimumSample: number,
  threshold: number,
): { value: IdentifierCase; count: number; total: number; examples: string[] } | null {
  if (tally.total < minimumSample) return null;
  const entries = [...tally.cases.entries()].sort((a, b) => (b[1] === a[1] ? compareStrings(a[0], b[0]) : b[1] - a[1]));
  const top = entries[0];
  if (top === undefined) return null;
  if (ratio(top[1], tally.total) < threshold) return null;
  return { value: top[0], count: top[1], total: tally.total, examples: tally.examples.get(top[0]) ?? [] };
}

const CASE_PHRASE: Record<IdentifierCase, string> = {
  PascalCase: 'PascalCase',
  camelCase: 'camelCase',
  'kebab-case': 'kebab-case',
  snake_case: 'snake_case',
  SCREAMING_SNAKE_CASE: 'SCREAMING_SNAKE_CASE',
  other: 'mixed',
};

export function detectFileNaming(conventions: Convention[], repository: Repository): void {
  const sourceFiles = repository.files.filter(
    (file) =>
      (file.kind === 'source' || file.kind === 'test') &&
      (file.language === 'typescript' || file.language === 'javascript'),
  );
  const tally = tallyCases(
    sourceFiles
      .filter((file) => !basename(file.path).startsWith('index.'))
      .map((file) => ({ key: stem(file.path), sample: file.path })),
  );
  const dominant = dominantCase(tally, MIN_SAMPLE.fileNaming, 0.7);
  if (dominant === null) return;
  conventions.push(
    makeConvention(
      'Naming',
      `Source files use ${CASE_PHRASE[dominant.value]} (${dominant.count}/${dominant.total} files).`,
      0.75 + 0.2 * ratio(dominant.count, dominant.total),
      dominant.examples.map((example) => ({
        source: example,
        detail: `file name uses ${CASE_PHRASE[dominant.value]}`,
      })),
    ),
  );
}

export function detectSymbolNaming(conventions: Convention[], repository: Repository): void {
  const byKind = new Map<string, Array<{ key: string; sample: string }>>();
  for (const symbol of repository.symbols) {
    if (symbol.name.length < 2 || splitIdentifier(symbol.name).length === 0) continue;
    const list = byKind.get(symbol.kind) ?? [];
    list.push({ key: symbol.name, sample: symbol.id });
    byKind.set(symbol.kind, list);
  }

  const expectations: Array<{ kind: string; expected: IdentifierCase; minimum: number; statement: string }> = [
    { kind: 'class', expected: 'PascalCase', minimum: MIN_SAMPLE.symbols, statement: 'Classes use PascalCase' },
    { kind: 'interface', expected: 'PascalCase', minimum: 3, statement: 'TypeScript interfaces use PascalCase' },
    { kind: 'type', expected: 'PascalCase', minimum: 3, statement: 'Type aliases use PascalCase' },
    { kind: 'function', expected: 'camelCase', minimum: 5, statement: 'Functions use camelCase' },
    { kind: 'const', expected: 'camelCase', minimum: 5, statement: 'Module level constants use camelCase' },
  ];

  for (const expectation of expectations) {
    const entries = byKind.get(expectation.kind) ?? [];
    if (entries.length < expectation.minimum) continue;
    const tally = tallyCases(entries);
    const matching = tally.cases.get(expectation.expected) ?? 0;
    if (ratio(matching, tally.total) < 0.85) continue;
    conventions.push(
      makeConvention(
        'Naming',
        `${expectation.statement} (${matching}/${tally.total} declarations).`,
        0.8 + 0.15 * ratio(matching, tally.total),
        (tally.examples.get(expectation.expected) ?? []).map((example) => ({
          source: example.split('#')[0]!,
          detail: `${expectation.kind} "${example.split('#')[1]}" uses ${CASE_PHRASE[expectation.expected]}`,
        })),
      ),
    );
  }
}

interface ImportStatistics {
  filesWithImports: number;
  relative: number;
  alias: number;
  workspace: number;
  external: number;
  requireCalls: number;
  typeOnlyFiles: number;
  explicitJsExtensions: number;
  externalFirstFiles: number;
  orderedFiles: number;
}

/** Counts import styles across the repository. */
export function collectImportStatistics(parsed: Map<string, ParsedFile>, aliases: AliasEntry[]): ImportStatistics {
  const aliasPatterns = aliases.map((alias) => alias.pattern.replace('*', ''));
  const statistics: ImportStatistics = {
    filesWithImports: 0,
    relative: 0,
    alias: 0,
    workspace: 0,
    external: 0,
    requireCalls: 0,
    typeOnlyFiles: 0,
    explicitJsExtensions: 0,
    externalFirstFiles: 0,
    orderedFiles: 0,
  };

  for (const file of parsed.values()) {
    if (file.language !== 'typescript' && file.language !== 'javascript') continue;
    if (file.imports.length > 0) statistics.filesWithImports += 1;
    if (file.imports.some((record) => record.typeOnly)) statistics.typeOnlyFiles += 1;

    let hasExternal = false;
    let hasInternal = false;
    let externalFirst = true;
    let seenInternal = false;
    const ordered: Array<{ line: number; external: boolean }> = [];

    for (const record of file.imports) {
      const specifier = record.specifier;
      if (record.syntax === 'require') statistics.requireCalls += 1;
      if (record.syntax === 'require' || record.typeOnly) {
        // still classified below for ordering purposes
      }
      if (record.syntax === 'require' && !record.specifier.startsWith('.')) {
        hasExternal = true;
        continue;
      }
      if (record.specifier.startsWith('.')) {
        hasInternal = true;
        statistics.relative += 1;
        if (/\.(js|mjs|cjs)$/.test(record.specifier)) statistics.explicitJsExtensions += 1;
      } else if (aliasPatterns.some((pattern) => pattern.length > 1 && specifier.startsWith(pattern))) {
        hasInternal = true;
        statistics.alias += 1;
      } else if (specifier.startsWith('node:')) {
        hasExternal = true;
      } else {
        hasExternal = true;
        statistics.external += 1;
      }
      if (hasExternal && !hasInternal) externalFirst = !hasInternal;
      if (hasInternal) seenInternal = true;
      ordered.push({ line: record.line, external: !hasInternal || !record.specifier.startsWith('.') });
    }

    if (hasExternal && hasInternal) {
      statistics.orderedFiles += 1;
      const firstInternalLine = ordered.find((entry) => !entry.external)?.line ?? Number.POSITIVE_INFINITY;
      const lastExternalLine = [...ordered].filter((entry) => entry.external).pop()?.line ?? Number.NEGATIVE_INFINITY;
      if (lastExternalLine < firstInternalLine) statistics.externalFirstFiles += 1;
      void seenInternal;
      void externalFirst;
    }
  }
  return statistics;
}

export function detectImportConventions(
  conventions: Convention[],
  repository: Repository,
  parsed: Map<string, ParsedFile>,
  aliases: AliasEntry[],
): void {
  const statistics = collectImportStatistics(parsed, aliases);
  if (statistics.filesWithImports === 0) return;
  const internalImports = statistics.relative + statistics.alias + statistics.workspace;

  if (statistics.alias >= 3 && ratio(statistics.alias, Math.max(1, internalImports)) >= 0.2 && aliases.length > 0) {
    conventions.push(
      makeConvention(
        'Imports',
        `Internal imports use tsconfig path aliases (${statistics.alias} aliased imports).`,
        0.85,
        aliases.slice(0, 3).map((alias) => ({
          source: alias.source,
          detail: `alias "${alias.pattern}" → ${alias.targets.join(', ')}`,
        })),
      ),
    );
  }

  if (statistics.explicitJsExtensions >= 3 && ratio(statistics.explicitJsExtensions, Math.max(1, statistics.relative)) >= 0.4) {
    conventions.push(
      makeConvention(
        'Imports',
        `Relative imports use explicit .js extensions (${statistics.explicitJsExtensions}/${statistics.relative} relative imports).`,
        0.8,
        [{ source: '<repository>', detail: 'import specifiers end with .js while sources are .ts (ESM/NodeNext style)' }],
      ),
    );
  }

  if (statistics.orderedFiles >= MIN_SAMPLE.imports && ratio(statistics.externalFirstFiles, statistics.orderedFiles) >= 0.7) {
    conventions.push(
      makeConvention(
        'Imports',
        `External dependencies are imported before internal modules (${statistics.externalFirstFiles}/${statistics.orderedFiles} files).`,
        0.75,
        [{ source: '<repository>', detail: 'import order observed across files that import both kinds of modules' }],
      ),
    );
  }

  if (statistics.typeOnlyFiles >= 3 && ratio(statistics.typeOnlyFiles, statistics.filesWithImports) >= 0.25) {
    conventions.push(
      makeConvention(
        'Imports',
        `Type-only dependencies use \`import type\` (${statistics.typeOnlyFiles}/${statistics.filesWithImports} files).`,
        0.8,
        [{ source: '<repository>', detail: 'import type / export type statements detected' }],
      ),
    );
  }

  if (statistics.requireCalls > 0 && ratio(statistics.requireCalls, statistics.requireCalls + statistics.filesWithImports) >= 0.3) {
    conventions.push(
      makeConvention(
        'Imports',
        `CommonJS \`require()\` is used for module loading (${statistics.requireCalls} calls).`,
        0.7,
        [{ source: '<repository>', detail: 'require() calls detected in source files' }],
      ),
    );
  }

  void repository;
}

export function detectTestConventions(
  conventions: Convention[],
  repository: Repository,
  parsed: Map<string, ParsedFile>,
): void {
  const testFiles = repository.files.filter((file) => file.kind === 'test');
  if (testFiles.length >= MIN_SAMPLE.tests) {
    const suffixCounts = new Map<string, string[]>();
    for (const file of testFiles) {
      const match = /\.(test|spec)\.[cm]?[jt]sx?$/.exec(file.path);
      const key = match !== null ? `*.${match[1]}.ts` : file.path.includes('__tests__/') ? '__tests__' : 'other';
      const list = suffixCounts.get(key) ?? [];
      if (list.length < 3) list.push(file.path);
      suffixCounts.set(key, list);
    }
    const sorted = [...suffixCounts.entries()].sort((a, b) =>
      b[1].length === a[1].length ? compareStrings(a[0], b[0]) : b[1].length - a[1].length,
    );
    const dominant = sorted[0];
    if (dominant !== undefined && ratio(dominant[1].length, testFiles.length) >= 0.5) {
      conventions.push(
        makeConvention(
          'Tests',
          `Tests use the \`${dominant[0]}\` pattern.`,
          0.85,
          dominant[1].slice(0, 3).map((example) => ({ source: example, detail: 'test file naming pattern' })),
        ),
      );
    }

    const colocated = testFiles.filter((file) => {
      const directory = file.path.slice(0, file.path.lastIndexOf('/'));
      return repository.files.some(
        (candidate) =>
          candidate.kind === 'source' &&
          candidate.path.startsWith(`${directory}/`) &&
          !candidate.path.slice(directory.length + 1).includes('/'),
      );
    }).length;
    const centralized = testFiles.filter((file) => /(^|\/)(tests?|__tests__|e2e)\//.test(file.path)).length;
    if (ratio(colocated, testFiles.length) >= 0.6) {
      conventions.push(
        makeConvention(
          'Tests',
          `Tests are colocated with the code they cover (${colocated}/${testFiles.length} test files).`,
          0.8,
          testFiles.slice(0, 2).map((file) => ({ source: file.path, detail: 'test lives next to its source module' })),
        ),
      );
    } else if (centralized >= MIN_SAMPLE.tests && ratio(centralized, testFiles.length) >= 0.6) {
      conventions.push(
        makeConvention(
          'Tests',
          `Tests live in a dedicated test directory (${centralized}/${testFiles.length} test files).`,
          0.8,
          testFiles
            .filter((file) => /(^|\/)(tests?|__tests__|e2e)\//.test(file.path))
            .slice(0, 2)
            .map((file) => ({ source: file.path, detail: 'test located in a central tests directory' })),
        ),
      );
    }
  }

  const runners = new Set<string>();
  const runnerEvidence: Evidence[] = [];
  for (const workspacePackage of repository.workspace.packages) {
    for (const name of workspacePackage.developmentDependencies) {
      if (['vitest', 'jest', 'mocha', 'ava'].includes(name)) {
        runners.add(name);
        runnerEvidence.push({ source: 'package.json', detail: `${name} declared in devDependencies` });
      }
    }
    for (const [scriptName, command] of Object.entries(workspacePackage.scripts)) {
      if (scriptName !== 'test') continue;
      if (command.includes('node --test')) {
        runners.add('node:test');
        runnerEvidence.push({ source: 'package.json', detail: `npm script "test" runs \`${command}\`` });
      }
    }
  }
  if (runners.size > 0) {
    conventions.push(
      makeConvention('Tests', `Tests run with ${[...runners].sort(compareStrings).join(', ')}.`, 0.9, runnerEvidence),
    );
  }
  void parsed;
}

export function detectErrorConventions(conventions: Convention[], repository: Repository): void {
  const errorClasses = repository.symbols.filter((symbol) => symbol.extends.includes('Error'));
  if (errorClasses.length === 0) return;
  conventions.push(
    makeConvention(
      'Error handling',
      `Domain errors are declared as classes extending the built-in \`Error\` (${errorClasses.length} classes).`,
      0.85,
      errorClasses.slice(0, 3).map((symbol) => ({
        source: symbol.file,
        detail: `class ${symbol.name} extends Error (line ${symbol.line})`,
      })),
    ),
  );
}

export function detectExportConventions(conventions: Convention[], repository: Repository): void {
  const exported = repository.symbols.filter((symbol) => symbol.exported);
  if (exported.length < MIN_SAMPLE.exports) return;
  const defaults = exported.filter((symbol) => symbol.isDefault).length;
  const named = exported.length - defaults;
  if (ratio(defaults, exported.length) <= 0.15) {
    conventions.push(
      makeConvention(
        'Exports',
        `Modules use named exports rather than default exports (${named}/${exported.length} exported symbols are named).`,
        0.85,
        exported.slice(0, 3).map((symbol) => ({ source: symbol.file, detail: `exports ${symbol.name}` })),
      ),
    );
  } else if (ratio(defaults, exported.length) >= 0.5) {
    conventions.push(
      makeConvention(
        'Exports',
        `Modules primarily use default exports (${defaults}/${exported.length} exported symbols are default).`,
        0.75,
        exported
          .filter((symbol) => symbol.isDefault)
          .slice(0, 3)
          .map((symbol) => ({ source: symbol.file, detail: `default export at line ${symbol.line}` })),
      ),
    );
  }
}

export function detectStructureConventions(conventions: Convention[], repository: Repository): void {
  const modules = repository.modules.filter((module) => module.files.length > 0);
  if (modules.length < 3) return;

  const withBarrel = modules
    .map((module) => ({
      module,
      barrel: module.files.find((file) => /(^|\/)index\.[cm]?[jt]sx?$/.test(file)),
    }))
    .filter((entry): entry is { module: (typeof modules)[number]; barrel: string } => entry.barrel !== undefined);

  if (ratio(withBarrel.length, modules.length) >= 0.5) {
    conventions.push(
      makeConvention(
        'Structure',
        `Modules expose their public surface through \`index\` files (${withBarrel.length}/${modules.length} modules).`,
        0.8,
        withBarrel.slice(0, 3).map((entry) => ({
          source: entry.barrel,
          detail: `barrel file of module "${entry.module.id}"`,
        })),
      ),
    );
  }

  const domainish = modules.filter((module) =>
    module.roles.some((role) => role.value === 'domain' || role.value === 'repository'),
  );
  const layered = modules.filter((module) =>
    module.roles.some((role) => role.value === 'adapter' || role.value === 'controller' || role.value === 'infrastructure'),
  );
  if (domainish.length > 0 && layered.length > 0) {
    conventions.push(
      makeConvention(
        'Structure',
        `The repository appears to separate domain code from infrastructure and adapters (${domainish.length} domain-ish modules, ${layered.length} infrastructure/adapters modules).`,
        0.55,
        [
          { source: '<heuristic>', detail: 'module names and file signals suggested a layered separation' },
          {
            source: '<modules>',
            detail: [...domainish, ...layered]
              .slice(0, 3)
              .map((module) => `${module.id} → ${module.roles[0]?.value ?? 'unknown'}`)
              .join('; '),
          },
        ],
      ),
    );
  }
}

export function detectToolchainConventions(
  conventions: Convention[],
  repository: Repository,
  parsed: Map<string, ParsedFile>,
): void {
  const workspace = repository.workspace;
  if (workspace.packageManager !== 'unknown') {
    conventions.push(
      makeConvention(
        'Toolchain',
        `Dependencies are managed with ${workspace.packageManager} (repository signal).`,
        0.8,
        workspace.packageManagerEvidence.length > 0
          ? workspace.packageManagerEvidence
          : [{ source: '<repository>', detail: 'package manager detected from lockfiles' }],
        'config',
      ),
    );
  }

  const rootType = workspace.rootPackage?.type ?? null;
  if (rootType !== null) {
    conventions.push(
      makeConvention(
        'Toolchain',
        rootType === 'module'
          ? 'The repository is configured as ESM (`"type": "module"` in package.json).'
          : 'The repository is configured as CommonJS (`"type": "commonjs"` in package.json).',
        0.9,
        [{ source: 'package.json', detail: `"type": "${rootType}"` }],
        'config',
      ),
    );
  }

  const strictConfigs = [...parsed.values()].filter((file) => file.metadata['tsconfig.strict'] === true);
  if (strictConfigs.length > 0) {
    conventions.push(
      makeConvention(
        'Toolchain',
        `TypeScript strict mode is enabled (${strictConfigs.length} tsconfig file(s)).`,
        0.95,
        strictConfigs.slice(0, 3).map((file) => ({ source: file.path, detail: '"strict": true' })),
        'config',
      ),
    );
  }

  if (workspace.isMonorepo) {
    conventions.push(
      makeConvention(
        'Toolchain',
        `The repository is a ${workspace.workspaceModel.replace('-workspaces', '')} workspace monorepo (${workspace.workspaceGlobs.join(', ')}).`,
        0.95,
        [{ source: 'package.json', detail: `workspaces: ${workspace.workspaceGlobs.join(', ')}` }],
        'config',
      ),
    );
  }

  const devDependencyNames = new Set(workspace.packages.flatMap((entry) => entry.developmentDependencies));
  const tooling: Array<{ name: string; statement: string }> = [
    { name: 'eslint', statement: 'ESLint is used for linting' },
    { name: 'prettier', statement: 'Prettier is used for formatting' },
    { name: 'biome', statement: 'Biome is used for linting and formatting' },
    { name: 'husky', statement: 'Git hooks are managed with husky' },
  ];
  for (const entry of tooling) {
    if (!devDependencyNames.has(entry.name)) continue;
    conventions.push(
      makeConvention('Toolchain', `${entry.statement}.`, 0.85, [
        { source: 'package.json', detail: `${entry.name} declared in devDependencies` },
      ]),
    );
  }

  const workflows = repository.files
    .filter((file) => file.path.startsWith('.github/workflows/'))
    .map((file) => file.path);
  if (workflows.length > 0) {
    conventions.push(
      makeConvention(
        'Toolchain',
        'Continuous integration runs through GitHub Actions.',
        0.85,
        workflows.slice(0, 3).map((path) => ({ source: path, detail: 'workflow definition' })),
      ),
    );
  }
}

export function detectDocumentationConventions(
  conventions: Convention[],
  repository: Repository,
  parsed: Map<string, ParsedFile>,
): void {
  const files = new Set(repository.files.map((file) => file.path));
  if (files.has('README.md')) {
    conventions.push(
      makeConvention('Documentation', 'Repository documentation starts at `README.md`.', 0.9, [
        { source: 'README.md', detail: 'top level README present' },
      ]),
    );
  }

  const adrDocuments = [...parsed.values()].filter(
    (file) => file.language === 'markdown' && /(^|\/)(adr|adrs|decisions?)\//i.test(file.path),
  );
  if (adrDocuments.length > 0) {
    const directory = adrDocuments[0]!.path.split('/').slice(0, -1).join('/');
    conventions.push(
      makeConvention(
        'Documentation',
        `Architectural decisions are recorded as documents under \`${directory}/\` (${adrDocuments.length} documents).`,
        0.9,
        adrDocuments.slice(0, 3).map((file) => ({ source: file.path, detail: 'decision record' })),
      ),
    );
  } else if (repository.files.some((file) => file.path.startsWith('docs/'))) {
    conventions.push(
      makeConvention('Documentation', 'Extended documentation lives in `docs/`.', 0.7, [
        { source: 'docs/', detail: 'documentation directory present' },
      ]),
    );
  }
}

export function detectLanguageConventions(conventions: Convention[], repository: Repository): void {
  const counts = new Map<string, number>();
  for (const file of repository.files) {
    if (file.sensitive) continue;
    if (!['typescript', 'javascript', 'json', 'markdown'].includes(file.language)) continue;
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }
  const typescript = counts.get('typescript') ?? 0;
  const javascript = counts.get('javascript') ?? 0;
  if (typescript + javascript === 0) return;
  const statement =
    javascript === 0
      ? `Implementation is written in TypeScript (${typescript} files).`
      : typescript === 0
        ? `Implementation is written in JavaScript (${javascript} files).`
        : `Implementation mixes TypeScript (${typescript} files) and JavaScript (${javascript} files).`;
  conventions.push(
    makeConvention('Languages', statement, javascript === 0 ? 0.95 : 0.9, [
      { source: '<repository>', detail: 'languages are derived from file extensions, not from content guessing' },
    ]),
  );
}

const CATEGORY_ORDER = [
  'Languages',
  'Toolchain',
  'Naming',
  'Imports',
  'Exports',
  'Structure',
  'Error handling',
  'Tests',
  'Documentation',
];

/** Runs every convention detector and returns a deterministic, ordered list. */
export function detectConventions(input: ConventionDetectionInput): Convention[] {
  const conventions: Convention[] = [];
  const { repository, parsed, aliases } = input;

  detectLanguageConventions(conventions, repository);
  detectToolchainConventions(conventions, repository, parsed);
  detectFileNaming(conventions, repository);
  detectSymbolNaming(conventions, repository);
  detectImportConventions(conventions, repository, parsed, aliases);
  detectExportConventions(conventions, repository);
  detectStructureConventions(conventions, repository);
  detectErrorConventions(conventions, repository);
  detectTestConventions(conventions, repository, parsed);
  detectDocumentationConventions(conventions, repository, parsed);

  const seen = new Set<string>();
  const unique: Convention[] = [];
  for (const convention of conventions) {
    const key = `${convention.category}|${convention.statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(convention);
  }

  return unique.sort((a, b) => {
    const categoryA = CATEGORY_ORDER.indexOf(a.category);
    const categoryB = CATEGORY_ORDER.indexOf(b.category);
    const rankA = categoryA === -1 ? CATEGORY_ORDER.length : categoryA;
    const rankB = categoryB === -1 ? CATEGORY_ORDER.length : categoryB;
    if (rankA !== rankB) return rankA - rankB;
    return compareStrings(a.statement, b.statement);
  });
}