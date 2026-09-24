#!/usr/bin/env node
/** Reproducible local benchmark for scan and compact repository context. */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AgentContext } from '../packages/core/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const repositories = args.length > 0 ? args : ['simple-ts', 'layered-app', 'monorepo', 'cli-project', 'api-project'].map((name) => path.join(root, 'fixtures', name));
const rows = [];
for (const source of repositories) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ai-agent-context-bench-'));
  const target = path.join(temp, path.basename(source));
  cpSync(source, target, { recursive: true });
  const context = await AgentContext.load({ root: target });
  const start = performance.now();
  const report = await context.scan();
  const scanMs = performance.now() - start;
  const compactStart = performance.now();
  const compact = await context.getRepositoryContext({ maxModules: 10, maxEntryPoints: 10, maxExternalDependencies: 10, maxConventions: 10, maxDecisions: 10, maxCycles: 5 });
  const compactMs = performance.now() - compactStart;
  const jsonBytes = Buffer.byteLength(JSON.stringify(compact));
  rows.push({ repository: path.basename(source), files: report.files.total, modules: report.modules, dependencies: report.dependencies, scanMs: Math.round(scanMs), compactMs: Math.round(compactMs), compactBytes: jsonBytes, parsed: report.parsed, reused: report.reused });
  rmSync(temp, { recursive: true, force: true });
}
const output = JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, rows }, null, 2);
const target = path.join(root, 'benchmark-report.json');
writeFileSync(target, `${output}\n`, 'utf8');
console.log(output);
