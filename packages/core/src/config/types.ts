/**
 * Configuration model of `ai-agent-context`.
 *
 * Configuration lives in `.agent/config.json` and can be overridden by CLI
 * flags, which always take precedence over the file.
 */

export interface FeaturesConfig {
  architecture: boolean;
  dependencies: boolean;
  conventions: boolean;
  decisions: boolean;
  /** Git metadata analysis (recently changed files, activity, ownership). */
  git: boolean;
  /** Local search index / query support. */
  search: boolean;
}

export interface GitAnalysisConfig {
  /** How far back `git log` looks, in days. */
  windowDays: number;
  /** Hard cap on parsed commits, to keep large repositories fast. */
  maxCommits: number;
  /** Window (days) used for the `recentChanges` / `recentActivity` signal. */
  recentDays: number;
  /** Patterns that mark a commit message as an architectural change signal. */
  architectureSignalPatterns: string[];
}

export interface AnalysisConfig {
  /**
   * Maximum directory depth below a workspace package root at which
   * automatically detected modules are created.
   */
  moduleDepth: number;
  /** Bounded concurrency for file system and parsing work. */
  concurrency: number;
  /** Files larger than this are recorded but not parsed. */
  maxFileSizeBytes: number;
  /** Never followed by default: symlink loops are a real risk in monorepos. */
  followSymlinks: boolean;
  /** Directories treated as source roots when deriving module ids. */
  sourceRoots: string[];
  git: GitAnalysisConfig;
}

export interface OutputConfig {
  /**
   * When `true`, `generatedAt` is written into `.agent/index.json`. Disabled by
   * default so that an unchanged repository produces an unchanged context.
   */
  includeTimestamp: boolean;
  prettyJson: boolean;
  /** Generate the human readable `.agent/conventions.md` projection. */
  conventionsMarkdown: boolean;
}

export interface SecurityConfig {
  /** Opt-in escape hatch for reading `.env`-like files. Off by default. */
  allowSensitiveFiles: boolean;
  /** Redact secret-looking values from excerpts copied into the context. */
  redactSecrets: boolean;
  /** Additional glob patterns treated as sensitive. */
  extraSensitivePatterns: string[];
}

export interface AgentContextConfig {
  version: number;
  root: string;
  include: string[];
  exclude: string[];
  ignore: string[];
  languages: string[];
  features: FeaturesConfig;
  analysis: AnalysisConfig;
  output: OutputConfig;
  security: SecurityConfig;
}

/** Deep partial used for CLI overrides and `init --force` templates. */
export interface ConfigOverrides {
  root?: string;
  include?: string[];
  exclude?: string[];
  ignore?: string[];
  languages?: string[];
  features?: Partial<FeaturesConfig>;
  analysis?: Partial<Omit<AnalysisConfig, 'git'>> & { git?: Partial<GitAnalysisConfig> };
  output?: Partial<OutputConfig>;
  security?: Partial<SecurityConfig>;
}

export interface LoadedConfig {
  config: AgentContextConfig;
  /** Path of the config file that was read, or `null` for pure defaults. */
  source: string | null;
  /** Stable hash of the resolved configuration (used for cache invalidation). */
  hash: string;
  warnings: string[];
}
