#!/usr/bin/env node
/**
 * Quality and performance benchmark.
 *
 * The point of this script is not to produce a prettier report than the one it
 * replaced — it is to make claims falsifiable. Everything here is computed from
 * a real scan of a real directory tree, and every number in the report can be
 * traced back to an artifact the analyzer produced.
 *
 * Metrics, in the order they matter:
 *
 *   imports.rate        share of relative imports the resolver resolved. This is
 *                       the single number that decides whether the dependency
 *                       graph is usable at all; everything else is downstream of
 *                       it. Before v0.5 this sat near 0.45 on real code.
 *   imports.unresolved  the specifiers it could not resolve, with reasons, so a
 *                       bad rate can be diagnosed instead of guessed at.
 *   graph.*             edges, cycles and layering findings.
 *   scan.*              cold scan vs warm rescan, and parsed/reused ratio. The
 *                       incremental path is meaningless if it is never measured.
 *   tokenBudget.*       bytes of `explain <module>` against the bytes of the
 *                       files that module contains. This is the product claim
 *                       ("compact context") expressed as a ratio, so it can be
 *                       compared against reading the module directly.
 *
 * Usage:
 *   node tools/benchmark.mjs                       # committed fixtures
 *   node tools/benchmark.mjs <dir> [<dir> ...]     # any local repositories
 *
 * The report is written to benchmark-report.json and can also be printed to
 * stdout as JSON for CI to archive.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AgentContext } from '../packages/core/dist/index.js';
import { evidenceCoverage, hashDocuments } from './trust-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// The fixtures are deliberately tiny, which is useful for regression testing and
// useless for measuring the product claim: no structured payload can describe a
// 300 byte module in fewer than 300 bytes. The default set therefore includes
// this repository, whose modules span two orders of magnitude in size.
const DEFAULT_SOURCES = [
  ...['simple-ts', 'layered-app', 'monorepo', 'cli-project', 'api-project'].map((name) =>
    path.join(root, 'fixtures', name),
  ),
  root,
];

// The public set exists because the fixtures are useless for the product claim
// and this repository alone is a sample of one. Every entry is pinned to a
// commit SHA, so two runs compare each other; a moving target would make every
// measurement incomparable with the last, which is measuring a moving specifier.
//
// Nothing is vendored. Each repository is cloned into a temporary directory,
// measured, and deleted.
function loadPublicRepositories() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'tools/benchmark-repos.json'), 'utf8'));
  return manifest.repositories.map((entry) => ({
    ...entry,
    dir: path.join(publicWorkspace, path.basename(new URL(entry.url).pathname).replace(/\.git$/, '')),
  }));
}

const wantsPublic = args.includes('--public') || process.env.AAC_PUBLIC_BENCH === '1';
const positional = args.filter((entry) => !entry.startsWith('--'));
const publicWorkspace = mkdtempSync(path.join(os.tmpdir(), 'aac-bench-public-'));

function fetchPublicRepositories(entries) {
  for (const entry of entries) {
    process.stderr.write(`cloning ${entry.name}...`);
    try {
      // Fetching a single commit keeps the clone shallow and fast even for
      // repositories with a long history.
      execFileSync(
        'git',
        ['clone', '--quiet', '--depth', '1', '--no-tags', entry.url, entry.dir],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', entry.sha], {
        cwd: entry.dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      execFileSync('git', ['checkout', '--quiet', entry.sha], { cwd: entry.dir, stdio: 'ignore' });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: entry.dir, encoding: 'utf8' }).trim();
      if (head !== entry.sha) throw new Error(`expected ${entry.sha}, checked out ${head}`);
      process.stderr.write(` ok (${head.slice(0, 8)})\n`);
    } catch (error) {
      process.stderr.write(` FAILED\n`);
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
}
const publicRepositories = wantsPublic ? loadPublicRepositories() : [];
if (publicRepositories.length > 0) {
  fetchPublicRepositories(publicRepositories);
  process.stderr.write(`cloned ${publicRepositories.filter((r) => r.error === undefined).length}/${publicRepositories.length} repositories\n`);
}

const sources = [
  ...(positional.length > 0 ? positional.map((entry) => path.resolve(entry)) : DEFAULT_SOURCES),
  ...publicRepositories.filter((entry) => entry.error === undefined).map((entry) => entry.dir),
];

const compactOptions = {
  maxModules: 10,
  maxEntryPoints: 10,
  maxExternalDependencies: 10,
  maxConventions: 10,
  maxDecisions: 10,
  maxCycles: 5,
};

function ratio(part, total) {
  return total === 0 ? 1 : Number((part / total).toFixed(4));
}

async function measure(source) {
  if (!existsSync(source)) throw new Error(`repository not found: ${source}`);
  // Work on a copy so a benchmark run never mutates the repository it measures.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aac-bench-'));
  const target = path.join(temp, path.basename(source));
  // The copy is pruned deliberately:
  //  - `node_modules` is excluded by the analyzer anyway, and npm workspaces
  //    put symlinks there that `cpSync` cannot recreate without extra privileges
  //    on Windows;
  //  - the local parse cache is excluded because copying it would make the
  //    "cold" scan reuse entries and quietly turn both timings into warm scans.
  const PRUNED = /(^|[\\/])(node_modules|\.git)([\\/]|$)|[\\/]\.agent[\\/]\.local([\\/]|$)/;
  cpSync(source, target, { recursive: true, filter: (entry) => !PRUNED.test(entry) });

  try {
    const context = await AgentContext.load({ root: target });

    const coldStart = performance.now();
    const report = await context.scan();
    const coldMs = performance.now() - coldStart;

    // Second pass over an unchanged tree: this is the incremental path, and it
    // is the one that matters for day-to-day use.
    const warmStart = performance.now();
    const warmReport = await context.scan();
    const warmMs = performance.now() - warmStart;

    const compactStart = performance.now();
    const compact = await context.getRepositoryContext(compactOptions);
    const compactMs = performance.now() - compactStart;

    const dependencies = await context.getDependencies();
    const modules = await context.getModules();
    const architecture = await context.getArchitecture();

    // Import resolution, classified by whether the import was ever resolvable.
    //
    // A single "unresolved / total" ratio is not a useful metric: an import of
    // `../dist/index.js` can never resolve in a repository that excludes build
    // output, and counting it would make a healthy repository look broken.
    // Unresolved specifiers are therefore bucketed, and the rate is computed
    // over the ones the analyzer could in principle have resolved.
    const classified = { excludedOutput: [], pathEscape: [], missing: [], other: [] };
    for (const entry of dependencies.unresolved) {
      const reason = entry.attempts[0] ?? '';
      if (reason.includes('outside the repository root')) classified.pathEscape.push(entry);
      else if (/(^|\/)(dist|build|out|lib|coverage|node_modules)(\/|$)/.test(entry.specifier)) {
        classified.excludedOutput.push(entry);
      } else if (reason.includes('no analyzed file matched')) classified.missing.push(entry);
      else classified.other.push(entry);
    }
    const expectedUnresolved = classified.excludedOutput.length;
    const actionableUnresolved = classified.missing.length + classified.other.length;
    const resolvable = dependencies.internal.length + actionableUnresolved;

    const unresolvedDetail = [
      ...classified.pathEscape.slice(0, 5),
      ...classified.missing.slice(0, 5),
      ...classified.other.slice(0, 5),
    ].map((entry) => ({
      bucket: classified.pathEscape.includes(entry)
        ? 'path-escape'
        : classified.missing.includes(entry)
          ? 'missing'
          : 'other',
      file: entry.file,
      specifier: entry.specifier,
      reason: entry.attempts[0] ?? 'unknown',
    }));

    // Token budget, bucketed by module size.
    //
    // A single ratio across all modules is misleading: describing a 300 KB
    // module in 15 KB is the product working, while describing a 300 byte
    // module in 1 KB is the product failing, and averaging the two hides both.
    const perModule = [];
    for (const module of modules) {
      let bytes = 0;
      for (const file of module.files) {
        try {
          bytes += statSync(path.join(target, file)).size;
        } catch {
          // A file listed by the graph but absent on disk contributes nothing.
        }
      }
      if (bytes === 0) continue;
      const explanation = await context.explain(module.id);
      if (explanation === null) continue;
      perModule.push({
        module: module.id,
        bytes,
        explainBytes: Buffer.byteLength(JSON.stringify(explanation)),
      });
    }

    // Trust metrics, computed from the documents the tool actually produced.
    //
    // Determinism is checked against a second, independent scan of the same
    // tree: the cache is bypassed, so a difference can only come from the
    // analyzer rather than from what it happened to reuse.
    const coverage = evidenceCoverage({
      architecture,
      dependencies,
      conventions: await context.getConventions(),
      decisions: await context.getDecisions(),
    });
    await context.scan({ force: true, dryRun: true });
    const firstHash = hashDocuments(target);
    await context.scan({ force: true, dryRun: true });
    const secondHash = hashDocuments(target);

    const sizeBuckets = { under8Kb: [], from8To64Kb: [], over64Kb: [] };    for (const entry of perModule) {
      if (entry.bytes < 8 * 1024) sizeBuckets.under8Kb.push(entry);
      else if (entry.bytes <= 64 * 1024) sizeBuckets.from8To64Kb.push(entry);
      else sizeBuckets.over64Kb.push(entry);
    }
    const summarize = (list) => {
      const sourceBytes = list.reduce((sum, entry) => sum + entry.bytes, 0);
      const explainBytes = list.reduce((sum, entry) => sum + entry.explainBytes, 0);
      return {
        modules: list.length,
        sourceBytes,
        explainBytes,
        ratio: ratio(explainBytes, sourceBytes),
        savedPercent:
          sourceBytes === 0 ? 0 : Number((100 - (explainBytes / sourceBytes) * 100).toFixed(1)),
      };
    };

    return {
      repository: path.basename(source),
      files: report.files.total,
      sourceFiles: report.files.source,
      testFiles: report.files.test,
      // Parse coverage, kept next to the file counts because it qualifies them.
      // A partial file yields facts for the statements before the point the
      // extractor gave up, so a repository can report full resolution while
      // silently holding fewer imports than it has.
      parse: {
        partial: report.files.partial,
        failed: report.files.failed,
        skipped: report.files.skipped,
      },
      modules: report.modules,
      imports: {
        resolved: dependencies.internal.length,
        // Expected: build output the configuration excludes. Not a defect.
        excludedOutput: expectedUnresolved,
        // Defects: imports that should have resolved and did not.
        actionableUnresolved,
        // Security events. Must be zero.
        pathEscapes: classified.pathEscape.length,
        resolutionRate: ratio(dependencies.internal.length, resolvable),
      },
      unresolvedSample: unresolvedDetail,
      graph: {
        moduleEdges: dependencies.internal.length,
        crossPackageEdges: dependencies.summary.crossPackageEdges,
        externalPackages: dependencies.external.length,
        cycles: dependencies.cycles.length,
        layeringViolations: architecture.layeringViolations?.length ?? 0,
      },
      scan: {
        coldMs: Math.round(coldMs),
        warmMs: Math.round(warmMs),
        parsed: coldReportParsed(report),
        warmParsed: coldReportParsed(warmReport),
        warmReused: coldReportReused(warmReport),
      },
      compact: {
        ms: Math.round(compactMs),
        bytes: Buffer.byteLength(JSON.stringify(compact)),
      },
      trust: {         judgements: coverage.judgements,         withEvidence: coverage.withEvidence,         withoutEvidence: coverage.withoutEvidence,         coveragePercent: coverage.coverage,         unsupportedEvidence: coverage.samples,         deterministic: firstHash === secondHash,         contextHash: firstHash,       },      tokenBudget: {
        under8Kb: summarize(sizeBuckets.under8Kb),
        from8To64Kb: summarize(sizeBuckets.from8To64Kb),
        over64Kb: summarize(sizeBuckets.over64Kb),
        largest: [...perModule]
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 5)
          .map((entry) => ({ ...entry, ratio: ratio(entry.explainBytes, entry.bytes) })),
      },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// `report` is intentionally probed rather than destructured so that a change to
// the scan report shape fails here loudly instead of producing NaN.
function coldReportParsed(report) {
  const value = report?.parsed;
  if (typeof value !== 'number') throw new Error('scan report is missing a `parsed` count');
  return value;
}

function coldReportReused(report) {
  const value = report?.reused;
  if (typeof value !== 'number') throw new Error('scan report is missing a `reused` count');
  return value;
}

const rows = [];
for (const source of sources) {
  process.stderr.write(`benchmarking ${path.basename(source)}...\n`);
  rows.push(await measure(source));
}

const totals = rows.reduce(
  (acc, row) => {
    acc.imports.resolved += row.imports.resolved;
    acc.imports.excludedOutput += row.imports.excludedOutput;
    acc.imports.actionableUnresolved += row.imports.actionableUnresolved;
    acc.imports.pathEscapes += row.imports.pathEscapes;
    acc.graph.moduleEdges += row.graph.moduleEdges;
    acc.graph.cycles += row.graph.cycles;
    acc.trust.judgements += row.trust.judgements;     acc.trust.withEvidence += row.trust.withEvidence;     acc.trust.withoutEvidence += row.trust.withoutEvidence;     if (!row.trust.deterministic) acc.trust.nonDeterministic += 1;    for (const bucket of ['under8Kb', 'from8To64Kb', 'over64Kb']) {
      acc.tokenBudget[bucket].sourceBytes += row.tokenBudget[bucket].sourceBytes;
      acc.tokenBudget[bucket].explainBytes += row.tokenBudget[bucket].explainBytes;
      acc.tokenBudget[bucket].modules += row.tokenBudget[bucket].modules;
    }
    return acc;
  },
  {
    imports: { resolved: 0, excludedOutput: 0, actionableUnresolved: 0, pathEscapes: 0 },
    graph: { moduleEdges: 0, cycles: 0 },
    trust: { judgements: 0, withEvidence: 0, withoutEvidence: 0, nonDeterministic: 0 },
    tokenBudget: {
      under8Kb: { modules: 0, sourceBytes: 0, explainBytes: 0 },
      from8To64Kb: { modules: 0, sourceBytes: 0, explainBytes: 0 },
      over64Kb: { modules: 0, sourceBytes: 0, explainBytes: 0 },
    },
  },
);

const withRatio = (bucket) => ({
  ...bucket,
  ratio: ratio(bucket.explainBytes, bucket.sourceBytes),
  savedPercent:
    bucket.sourceBytes === 0 ? 0 : Number((100 - (bucket.explainBytes / bucket.sourceBytes) * 100).toFixed(1)),
});

const resolvableTotal = totals.imports.resolved + totals.imports.actionableUnresolved;

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  summary: {
    repositories: rows.length,
    files: rows.reduce((sum, row) => sum + row.files, 0),
    imports: {
      resolved: totals.imports.resolved,
      excludedOutput: totals.imports.excludedOutput,
      actionableUnresolved: totals.imports.actionableUnresolved,
      pathEscapes: totals.imports.pathEscapes,
      resolutionRate: ratio(totals.imports.resolved, resolvableTotal),
    },
    graph: totals.graph,
    trust: {
      judgements: totals.trust.judgements,
      withEvidence: totals.trust.withEvidence,
      withoutEvidence: totals.trust.withoutEvidence,
      coveragePercent:
        totals.trust.judgements === 0
          ? null
          : Number(((totals.trust.withEvidence / totals.trust.judgements) * 100).toFixed(1)),
      nonDeterministic: totals.trust.nonDeterministic,
    },
    tokenBudget: {
      under8Kb: withRatio(totals.tokenBudget.under8Kb),
      from8To64Kb: withRatio(totals.tokenBudget.from8To64Kb),
      over64Kb: withRatio(totals.tokenBudget.over64Kb),
    },
  },
  rows,
};

if (publicRepositories.length > 0) {
  // Reported separately from the local totals: these repositories are not
  // ours, so merging them into the headline numbers would quietly change what
  // "the benchmark" measures depending on whether the network was available.
  report.public = {
    note: 'Repositories pinned by commit SHA in tools/benchmark-repos.json. Measured on a temporary clone; nothing is vendored.',
    requested: publicRepositories.length,
    measured: publicRepositories.filter((entry) => entry.error === undefined).length,
    repositories: publicRepositories.map((entry) => {
      const row = rows.find((candidate) => candidate.repository === path.basename(entry.dir));
      return {
        name: entry.name,
        url: entry.url,
        sha: entry.sha,
        note: entry.note,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(row === undefined
          ? {}
          : {
              files: row.files,
              modules: row.modules,
              partialParses: row.parse.partial,
              failedParses: row.parse.failed,
              resolutionRate: row.imports.resolutionRate,
              pathEscapes: row.imports.pathEscapes,
              moduleEdges: row.graph.moduleEdges,
              cycles: row.graph.cycles,
              coveragePercent: row.trust.coveragePercent,
              deterministic: row.trust.deterministic,
              over8Kb: row.tokenBudget.from8To64Kb.modules + row.tokenBudget.over64Kb.modules,
              explainRatio8To64Kb: row.tokenBudget.from8To64Kb.ratio,
              explainRatioOver64Kb: row.tokenBudget.over64Kb.ratio,
            }),
      };
    }),
  };
}

const output = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(path.join(root, 'benchmark-report.json'), output, 'utf8');
process.stdout.write(output);
rmSync(publicWorkspace, { recursive: true, force: true });