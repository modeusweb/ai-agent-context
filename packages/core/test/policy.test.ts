/**
 * Organization policy and read-only contract.
 *
 * The property under test is asymmetric on purpose: a repository configuration
 * may tighten, but an organization policy may only tighten further. Every test
 * that writes `allowSensitiveFiles: true` into a repository config checks that
 * the policy still wins, because that is the case an attacker or a careless
 * contributor would rely on.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AgentContext,
  POLICY_FILE,
  POLICY_VERSION,
  ReadOnlyError,
  applyPolicy,
  findPolicyFile,
  loadConfig,
  loadPolicy,
  parsePolicy,
} from '../../core/dist/index.js';
import { cleanupTemp, createTempRepo, writeRepoFile } from './helpers.ts';

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) cleanupTemp(root);
});

/** Scratch directory for policy-only tests that need no fixture. */
function scratch(): string {
  const dir = path.join(os.tmpdir(), `aac-policy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tempRoots.push(dir);
  return dir;
}

function writePolicy(root: string, policy: Record<string, unknown>, name = POLICY_FILE): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, name), JSON.stringify(policy), 'utf8');
}

describe('policy parsing', () => {
  test('accepts a well-formed document', () => {
    const { policy, warnings } = parsePolicy(
      JSON.stringify({
        version: 1,
        exclude: ['vendor/private'],
        sensitive: ['*.tfvars'],
        allowSensitiveFiles: false,
        redactSecrets: true,
        readOnly: true,
      }),
      POLICY_FILE,
    );
    assert.equal(policy.version, POLICY_VERSION);
    assert.deepEqual(policy.exclude, ['vendor/private']);
    assert.deepEqual(policy.sensitive, ['*.tfvars']);
    assert.equal(policy.allowSensitiveFiles, false);
    assert.equal(policy.redactSecrets, true);
    assert.equal(policy.readOnly, true);
    assert.deepEqual(warnings, []);
  });

  test('fills in defaults for omitted keys', () => {
    const { policy } = parsePolicy(JSON.stringify({ version: 1 }), POLICY_FILE);
    assert.deepEqual(policy.exclude, []);
    assert.deepEqual(policy.sensitive, []);
    assert.equal(policy.readOnly, undefined);
  });

  test('refuses an unsupported version rather than ignoring it', () => {
    // A policy that silently fails to apply is indistinguishable from no
    // policy at all, which is the failure mode worth refusing.
    assert.throws(
      () => parsePolicy(JSON.stringify({ version: 99, readOnly: true }), POLICY_FILE),
      /version 99/,
    );
  });

  test('refuses malformed documents and wrong types', () => {
    assert.throws(() => parsePolicy('not json', POLICY_FILE), /Cannot parse/);
    assert.throws(() => parsePolicy('[]', POLICY_FILE), /must be a JSON object/);
    assert.throws(() => parsePolicy(JSON.stringify({ version: 1, exclude: 'nope' }), POLICY_FILE), /"exclude" must be an array/);
    assert.throws(() => parsePolicy(JSON.stringify({ version: 1, readOnly: 'yes' }), POLICY_FILE), /"readOnly" must be a boolean/);
  });

  test('warns about unknown keys without failing', () => {
    const { warnings } = parsePolicy(JSON.stringify({ version: 1, nonsense: true }), POLICY_FILE);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('nonsense'));
  });
});

describe('policy discovery', () => {
  test('finds a policy in the repository root', () => {
    const root = scratch();
    writePolicy(root, { version: 1, readOnly: true });
    assert.equal(findPolicyFile(root, {}), path.join(root, POLICY_FILE));
  });

  test('walks up to a parent directory', () => {
    const parent = scratch();
    writePolicy(parent, { version: 1, readOnly: true });
    const child = path.join(parent, 'packages', 'service');
    mkdirSync(child, { recursive: true });
    assert.equal(findPolicyFile(child, {}), path.join(parent, POLICY_FILE));
  });

  test('the nearest policy wins', () => {
    const parent = scratch();
    writePolicy(parent, { version: 1, readOnly: false });
    const child = path.join(parent, 'service');
    mkdirSync(child, { recursive: true });
    writePolicy(child, { version: 1, readOnly: true });
    assert.equal(findPolicyFile(child, {}), path.join(child, POLICY_FILE));
  });

  test('AGENT_CONTEXT_POLICY overrides the walk', () => {
    const root = scratch();
    writePolicy(root, { version: 1, readOnly: false });
    const explicit = path.join(scratch(), 'org.json');
    writePolicy(path.dirname(explicit), { version: 1, readOnly: true }, 'org.json');
    assert.equal(findPolicyFile(root, { AGENT_CONTEXT_POLICY: explicit }), explicit);
  });

  test('a repository without a policy loads cleanly', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const resolved = await loadPolicy(root, { AGENT_CONTEXT_POLICY: path.join(root, 'does-not-exist.json') });
    assert.equal(resolved.policy, null);
    assert.equal(resolved.source, null);
  });
});

describe('policy can only tighten', () => {
  const base = {
    version: 1,
    root: '.',
    include: ['src/**'],
    exclude: ['dist/**'],
    ignore: [],
    languages: ['typescript'],
    features: { architecture: true, dependencies: true, conventions: true, decisions: true, git: true, search: true },
    analysis: {
      moduleDepth: 2,
      concurrency: 0,
      maxFileSizeBytes: 1000,
      followSymlinks: false,
      sourceRoots: ['src'],
      git: { windowDays: 1, maxCommits: 1, recentDays: 1, architectureSignalPatterns: [] },
    },
    output: { includeTimestamp: false, prettyJson: true, conventionsMarkdown: true },
    security: { allowSensitiveFiles: true, redactSecrets: false, extraSensitivePatterns: ['*.local'], readOnly: false },
  };

  test('forbids sensitive files even when the repository allows them', () => {
    const applied = applyPolicy(base, {
      policy: { version: 1, exclude: [], sensitive: [], allowSensitiveFiles: false },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.equal(applied.security.allowSensitiveFiles, false);
  });

  test('keeps the repository setting when the policy does not constrain it', () => {
    const applied = applyPolicy(base, {
      policy: { version: 1, exclude: [], sensitive: [] },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.equal(applied.security.allowSensitiveFiles, true);
  });

  test('forces redaction on even when the repository disabled it', () => {
    const applied = applyPolicy(base, {
      policy: { version: 1, exclude: [], sensitive: [], redactSecrets: true },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.equal(applied.security.redactSecrets, true);
  });

  test('a policy cannot waive secret redaction', () => {
    // Redaction is what keeps a committed secret out of a committed .agent/.
    // Letting a policy file disable it would turn a security control into a
    // setting, so the document is refused instead.
    assert.throws(
      () => parsePolicy(JSON.stringify({ version: 1, redactSecrets: false }), POLICY_FILE),
      /cannot be disabled by a policy/,
    );
  });

  test('forces read-only on, and never off', () => {
    const forced = applyPolicy(base, {
      policy: { version: 1, exclude: [], sensitive: [], readOnly: true },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.equal(forced.security.readOnly, true);

    // A policy asking for readOnly:false must not unlock a repository that set it.
    const unlocking = applyPolicy(base, {
      policy: { version: 1, exclude: [], sensitive: [], readOnly: false },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.equal(unlocking.security.readOnly, false);
  });

  test('unions patterns instead of replacing them', () => {
    const applied = applyPolicy(base, {
      policy: { version: 1, exclude: ['vendor/private'], sensitive: ['*.tfvars'] },
      source: POLICY_FILE,
      warnings: [],
    });
    assert.ok(applied.exclude.includes('dist/**'), 'repository excludes survive');
    assert.ok(applied.exclude.includes('vendor/private'));
    assert.ok(applied.security.extraSensitivePatterns.includes('*.local'));
    assert.ok(applied.security.extraSensitivePatterns.includes('*.tfvars'));
  });

  test('a null policy changes nothing', () => {
    const applied = applyPolicy(base, { policy: null, source: null, warnings: [] });
    assert.deepEqual(applied, base);
  });
});

describe('read-only contract', () => {
  test('scan is refused and init is refused', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));

    const context = await AgentContext.load({ root });
    assert.equal(context.readOnly, true);
    await assert.rejects(() => context.scan(), ReadOnlyError);
    await assert.rejects(() => context.init(), ReadOnlyError);
    assert.equal(existsSync(path.join(root, '.agent')), false, 'nothing may be written');
  });

  test('queries keep working in read-only mode', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    // Scan once, before the policy exists, so there is context to query.
    await (await AgentContext.load({ root })).scan();
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));

    const context = await AgentContext.load({ root });
    assert.equal(context.readOnly, true);
    assert.ok((await context.getRepositoryContext()).modules !== undefined);
    const explanation = await context.explain('src');
    assert.ok(explanation !== null);
    const report = await context.detect();
    assert.equal(typeof report.counts.warning, 'number');
    // status must stay callable and report a real state. It is stale here
    // by design: adding the policy file after the scan changed the working
    // tree, and a policy change invalidates the cache.
    const status = await context.status();
    assert.ok(['up-to-date', 'stale', 'missing'].includes(status.status));
    assert.equal(status.configHashMatches, false);
  });

  test('the error names the file that enforced it', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));
    const context = await AgentContext.load({ root });
    await assert.rejects(
      () => context.scan(),
      (error: unknown) => {
        assert.ok(error instanceof ReadOnlyError);
        assert.equal(error.code, 'ERR_READ_ONLY');
        assert.ok(error.source === POLICY_FILE);
        assert.ok(error.hints.some((hint) => hint.includes(POLICY_FILE)));
        return true;
      },
    );
  });

  test('config readOnly has the same effect as a policy', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const context = await AgentContext.load({
      root,
      config: { security: { readOnly: true } },
    });
    assert.equal(context.readOnly, true);
    await assert.rejects(() => context.scan(), ReadOnlyError);
  });

  test('a policy cannot be unlocked by repository configuration', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));
    const context = await AgentContext.load({ root, config: { security: { readOnly: false } } });
    assert.equal(context.readOnly, true, 'the repository must not be able to turn read-only off');
    await assert.rejects(() => context.scan(), ReadOnlyError);
  });

  test('ignorePolicy escapes the policy for embedders that supply their own', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));
    const context = await AgentContext.load({ root, ignorePolicy: true });
    assert.equal(context.readOnly, false);
  });

  test('init writes the repository template, not the organization policy', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: false, exclude: ['vendor/private'] }));
    const context = await AgentContext.load({ root });
    await context.init();
    const written = JSON.parse(readFileSync(path.join(root, '.agent', 'config.json'), 'utf8')) as {
      exclude: string[];
      security: { readOnly: boolean };
    };
    assert.ok(
      !written.exclude.includes('vendor/private'),
      'the organization policy must not be copied into the repository config',
    );
    assert.equal(written.security.readOnly, false);
  });
});

describe('policy participates in cache invalidation', () => {
  test('tightening the policy changes the configuration hash', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    const before = await loadConfig({ root, ignorePolicy: true });

    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, exclude: ['vendor/private'] }));
    const after = await loadConfig({ root });
    assert.notEqual(before.hash, after.hash, 'a cache built under weaker rules must not be reused');
  });

  test('an unchanged policy keeps the hash stable', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: true }));
    const first = await loadConfig({ root });
    const second = await loadConfig({ root });
    assert.equal(first.hash, second.hash);
    assert.equal(first.policySource, POLICY_FILE);
  });

  test('two runs of an identical scan produce identical context under a policy', async () => {
    const root = createTempRepo('simple-ts');
    tempRoots.push(root);
    writeRepoFile(root, POLICY_FILE, JSON.stringify({ version: 1, readOnly: false, exclude: [] }));
    const first = await (await AgentContext.load({ root })).scan();
    const firstBytes = readFileSync(path.join(root, '.agent', 'index.json'), 'utf8');
    const second = await (await AgentContext.load({ root })).scan();
    const secondBytes = readFileSync(path.join(root, '.agent', 'index.json'), 'utf8');
    assert.deepEqual(first.files, second.files);
    assert.equal(firstBytes, secondBytes);
  });
});

after(() => {
  // Scratch directories that were never turned into fixtures still need removal.
  for (const root of tempRoots) {
    if (existsSync(root)) rmSync(root, { force: true, recursive: true });
  }
});