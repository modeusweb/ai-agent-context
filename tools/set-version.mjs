#!/usr/bin/env node
/**
 * Bumps the released version of every published package in lockstep.
 *
 * There is a single version source (`packages/core/src/model/version.ts`) that
 * the CLI and MCP adapter re-export, and the workspace packages must agree with
 * each other and with their `@ai-agent-context/core` dependency range. Doing
 * that by hand is how the published packages drifted apart before, so this
 * script is the supported path:
 *
 *   node tools/set-version.mjs 0.5.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node tools/set-version.mjs <semver>');
  process.exit(2);
}

const targets = [
  { file: path.join(root, 'packages/core/package.json'), set: (raw) => setField(raw, 'version', version) },
  {
    file: path.join(root, 'packages/core/src/model/version.ts'),
    set: (raw) => {
      // Asserted rather than assumed: a silent no-op here used to be reported
      // as "updated", shipping a release whose TOOL_VERSION the CLI never
      // reports. A release that lies about its own version is worse than one
      // that fails loudly.
      const next = raw.replace(/TOOL_VERSION = '[^']*'/, `TOOL_VERSION = '${version}'`);
      if (next === raw) {
        throw new Error(
          'could not find TOOL_VERSION in packages/core/src/model/version.ts; ' +
            'update it by hand and re-run.',
        );
      }
      return next;
    },
  },
  {
    file: path.join(root, 'packages/cli/package.json'),
    set: (raw) => setField(setField(raw, 'version', version), 'dependencies', {
      '@ai-agent-context/core': `^${version}`,
    }),
  },
  {
    file: path.join(root, 'packages/mcp/package.json'),
    set: (raw) => setField(setField(raw, 'version', version), 'dependencies', {
      '@ai-agent-context/core': `^${version}`,
    }),
  },
];

function setField(raw, field, value) {
  const data = JSON.parse(raw);
  if (typeof value === 'object' && value !== null) Object.assign(data[field], value);
  else data[field] = value;
  return `${JSON.stringify(data, null, 2)}\n`;
}

for (const target of targets) {
  const next = target.set(readFileSync(target.file, 'utf8'));
  writeFileSync(target.file, next, 'utf8');
  console.log(`updated ${path.relative(root, target.file)}`);
}

console.log(`\nversion set to ${version}`);
console.log('next: npm install --package-lock-only && npm run verify && npm run publish:all');