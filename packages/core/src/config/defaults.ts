/** Default configuration, aligned with the documented `.agent/config.json` example. */
import type { AgentContextConfig } from './types.ts';

/** Directory patterns that are never analyzed. */
export const DEFAULT_EXCLUDE: string[] = [
  'node_modules/**',
  'dist/**',
  'build/**',
  'out/**',
  'coverage/**',
  'vendor/**',
  'target/**',
  '.git/**',
  '.agent/**',
  '.cache/**',
  '.next/**',
  '.turbo/**',
  '.venv/**',
  '__pycache__/**',
];

export const DEFAULT_INCLUDE: string[] = ['src/**', 'packages/**', 'apps/**', 'lib/**', 'test/**', 'tests/**', '**/*.md', '*.json'];

/** Files that are never read, even when they match the include patterns. */
export const DEFAULT_SENSITIVE_PATTERNS: string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.env',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.htpasswd',
  '**/.git-credentials',
  '**/credentials',
  '**/credentials.*',
  '**/secrets',
  '**/secrets.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.crt',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/service-account*.json',
];

export const DEFAULT_CONFIG: AgentContextConfig = {
  version: 1,
  root: '.',
  include: [...DEFAULT_INCLUDE],
  exclude: [...DEFAULT_EXCLUDE],
  ignore: [],
  languages: ['typescript', 'javascript'],
  features: {
    architecture: true,
    dependencies: true,
    conventions: true,
    decisions: true,
    git: true,
    search: true,
  },
  analysis: {
    moduleDepth: 2,
    concurrency: 0, // 0 => derive from the machine (see util/concurrency)
    maxFileSizeBytes: 1_048_576,
    followSymlinks: false,
    sourceRoots: ['src', 'lib', 'app', 'apps', 'packages', 'services'],
    git: {
      windowDays: 180,
      maxCommits: 5000,
      recentDays: 30,
      architectureSignalPatterns: ['refactor', 'architecture', 'adr', 'breaking', 'migrat', 'restructure', 'rewrite'],
    },
  },
  output: {
    includeTimestamp: false,
    prettyJson: true,
    conventionsMarkdown: true,
  },
  security: {
    allowSensitiveFiles: false,
    redactSecrets: true,
    extraSensitivePatterns: [],
  },
};

/** Directories searched for architecture decision records and documentation. */
export const DECISION_SOURCES: string[] = [
  'docs',
  'docs/adr',
  'adr',
  'adrs',
  'architecture',
  'docs/architecture',
  'doc',
  'spec',
  'specs',
];

/** Documented package.json fields that represent entry points. */
export const PACKAGE_ENTRY_FIELDS = ['main', 'module', 'types', 'browser', 'exports', 'bin'] as const;
