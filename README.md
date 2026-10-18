# ai-agent-context

**Git-native context layer for AI coding agents**

`ai-agent-context` is a production-ready npm package that analyzes Git repositories and builds a structured, versionable knowledge layer in `.agent/`. Unlike simple file listings, it provides AI coding agents with deep understanding of architecture, dependencies, conventions, and decisions.

## Why not just list files?

AI coding agents need more than a file tree. They need to understand:

- **Architecture**: How modules are organized and their relationships
- **Dependencies**: Internal and external dependency graphs
- **Entry points**: Application bootstrap, CLI, API routes, workers
- **Conventions**: Naming patterns, import organization, testing strategies
- **Decisions**: Architectural decisions (ADRs) and their rationale
- **Context**: What's important, what's stable, what's changing

`ai-agent-context` extracts this information deterministically and stores it as structured, versionable data in `.agent/`.

## Installation

```bash
npm install -g ai-agent-context
```

Or use without installation:

```bash
npx agent-context <command>
```

## Quick Start

```bash
# Initialize context for your repository
agent-context init

# Scan the repository
agent-context scan

# Explain a module
agent-context explain src/payments

# Check for changes
agent-context diff

# View status
agent-context status
```

## Commands

### `init`

Creates `.agent/` directory and configuration:

```bash
agent-context init
```

Creates:
- `.agent/config.json` - Configuration file
- `.agent/.gitignore` - Git ignore for local cache

### `scan`

Analyzes the repository and generates context:

```bash
agent-context scan
```

Output:
```
Scanning repository...
✓ Analyzed 1,284 files.

Files            1,284
Source files     842
Test files       156
Modules          42
Dependencies     187
External deps    23
Entry points     11
Conventions      17
Decisions        6

Context updated:
  .agent/index.json
  .agent/architecture.json
  .agent/dependencies.json
  .agent/conventions.md
  .agent/decisions.json
```

### `context`

Compact repository context summary. Use limits for agent budget control:

```bash
agent-context context --max-modules 10 --max-entry-points 10 --max-conventions 5 --max-decisions 5
```
### `task <description>`

Get bounded, task-oriented context for an agent.

```bash
agent-context task "add idempotent payment retries" --target src/payments --max-modules 5
agent-context task "add idempotent payment retries" --json
```

### `impact <target>`

Get the bounded impact set for a proposed change.

```bash
agent-context impact src/payments --max-files 100
agent-context impact src/payments --json
```

### `explain`

Explains a module, a directory or a file:

```bash
agent-context explain src/payments
agent-context explain src/payments/gateways
```

Output:
```
Payments

Path:
  src/payments

Entry points:
  src/payments/index.ts

Responsibilities:
  payment processing
  refunds
  Stripe integration

Depends on:
  UserRepository
  EventBus
  StripeAdapter

Used by:
  CheckoutService
  SubscriptionService

External dependencies:
  stripe

Public API:
  createPayment()
  refundPayment()

Tests:
  14 tests
  src/payments/*.test.ts

Important conventions:
  domain errors must not cross the application boundary

Git activity:
  high recent activity
```

When you point `explain` at a directory that is narrower than the module owning
it, the answer is scoped to that directory and says so:

```
Scope:
  directory only — 4 file(s) under src/core/graph
  owning module: packages/core/src (this answer does not cover the rest of it)
```

The JSON payload carries the same information in a `scope` field.

#### Detail levels

`explain` returns one of two projections, reported in the `detail` field:

| Level | Contents | When `auto` picks it |
| --- | --- | --- |
| `compact` | Structure only: dependencies, dependents, tests, impact, file list. Drops the internal symbol dump and the repository-wide conventions/decisions that merely mention the module. | The module's own source is under 8 KB |
| `full` | Everything: per-symbol detail, entry-point evidence, scoped conventions and decisions. | Otherwise |

```bash
agent-context explain src/payments                    # auto
agent-context explain src/payments --detail full      # force the full projection
agent-context explain src/payments --detail compact   # force the cheap one
```

**Why the threshold exists.** Describing a module is only worth doing when the
description is smaller than the module. Measured on this repository: explaining
the 383 KB `packages/core/src` module costs 16 KB (a 95.8% reduction), while the
`full` projection of a 300-byte fixture module costs 2–9x the module itself. For
modules that small the honest answer is "read the two files", which is what
`compact` leaves the agent free to do — it keeps the structure and drops the
symbol dump. Measured on the fixtures, `auto` cuts the cost of a small-module
explanation from 1.84x its source to 0.72x.

Every fact still carries a confidence and evidence in both projections; the
compact level trims how many evidence entries are listed, not whether they
exist.

### `diff`

Shows context changes since last scan:

```bash
agent-context diff
```

Output:
```
Repository context changes

Added:
  src/payments/refund-service.ts

Modified:
  src/payments/payment-service.ts

Removed:
  src/payments/legacy-provider.ts

Architecture:
  payments now depends on refunds

Dependencies:
  payments → EventBus

Conventions:
  no changes

Decisions:
  no changes
```

### `status`

Shows repository context status:

```bash
agent-context status
```

Output:
```
Repository context

Status: up-to-date

Last scan:
  2026-09-18

Files:
  1,284

Modules:
  42

Pending changes:
  0
```

### `verify`

CI-friendly context verification. Exits with code `1` when `.agent/` is missing, has unsupported schema, has invalid documents, has a stale config hash, or drifted from the working tree.

```bash
agent-context verify
agent-context verify --json
```

`verify` is read-only and never regenerates context.

`--json` output omits the (potentially very large) list of unchanged files and reports `changes.unchangedCount` instead; pass `--full` to include the complete list.

A reusable workflow is published at `.github/workflows/reusable-verify-context.yml`:

```yaml
jobs:
  context:
    uses: modeusweb/ai-agent-context/.github/workflows/reusable-verify-context.yml@v0.9.0
```

### `migrate`

Brings a persisted `.agent/` up to the current schema. Context is committed, so it outlives the tool that wrote it, and a release that changes what the analyzer produces can leave a repository holding context that no longer matches its own source.

```bash
agent-context migrate            # regenerate when needed
agent-context migrate --check    # report only, exit 1 when action is needed
agent-context migrate --json
```

States: `current`, `stale` (drifted from the working tree), `missing`, `invalid` (unreadable or unsupported schema version). `--check` writes nothing, which makes it usable as a CI gate alongside `verify`.

### `detect`

Reports what the analysis could **not** determine. An agent about to act on a
dependency graph needs to know which parts of that graph are missing.

```bash
agent-context detect
agent-context detect --json
```

Output:
```
Coverage gaps

[!] import-cycle — 2 item(s)
      modules form a dependency cycle
      - packages/cli/src -> packages/cli/src/commands
      - packages/core/src -> packages/core/src/config

[-] unresolved-import — 17 item(s)
      imports of excluded build output; expected, and absent from the graph by design
      - packages/core/test/architecture.test.ts -> ../dist/index.js
      ...

Analyzed 128/128 file(s); 100.0% of resolvable imports resolved (18 resolved, 0 unresolved, 17 excluded build-output import(s)).
These are gaps in the analysis, not defects in the repository.
```

Issues are ranked by severity and classified by cause, because "there is no
dependency here" and "the analyzer failed to resolve it" are different facts:

| Severity | Kinds |
| --- | --- |
| `error` | `path-escape` — an import tried to climb above the repository root and was rejected; `unresolved-alias` |
| `warning` | `unresolved-import` — an import that should have resolved; `failed-parse`; `import-cycle`; `layering-violation` |
| `info` | imports of excluded build output; `partial-parse`; `sensitive-skipped`; `module-without-dependencies` |

The import resolution rate deliberately excludes imports of excluded build
output and rejected traversals: neither is a resolution failure, and counting
them would report a healthy repository as broken.

Exit codes: `0` nothing above `info`, `1` at least one warning, `2` at least one
error (the context should not be trusted without reading the affected files).

### `clean`

Removes generated context:

```bash
agent-context clean
agent-context clean --yes      # skip the confirmation prompt
```

### `history <target>`

Bounded local Git history for a module or path: commits, authors, dates and the files each commit touched.

```bash
agent-context history src/payments
agent-context history src/payments --limit-history 50 --json
```

### `revision-diff`

Local diff introduced by a revision relative to a base ref (`HEAD` by default).

```bash
agent-context revision-diff --revision HEAD~1
agent-context revision-diff --revision <sha> --base main --json
```

### `search`

Deterministic, local lexical search (BM25) over the knowledge graph — no embeddings, no LLM, no network:

```bash
agent-context search "payment idempotency"
agent-context search "format user name" --json --limit 5
```

Every result carries `score` and a `reason` explaining why the node matched:

```json
{
  "query": "payment idempotency",
  "backend": "bm25",
  "results": [
    {
      "type": "symbol",
      "id": "src/payments/payment-service.ts#PaymentService",
      "score": 9.4,
      "reason": "matched terms: idempotency, payment; ranked by bm25"
    }
  ]
}
```

Exit code is `1` when nothing matched, which is convenient in scripts.

## Node.js compatibility

| Version | Published packages | This repository's test suite |
| --- | --- | --- |
| 20.11.0 and above | supported (`engines.node >= 20.11.0`) | cannot run |
| 22.18 and above | supported | supported |
| 24 | supported | supported |

Two different floors for two different reasons. The published packages ship compiled JavaScript with no runtime dependencies, so nothing in the code needs a newer Node. This repository's tests are TypeScript and run through Node's native type stripping, which is unflagged only from 22.18 — on Node 20 the build succeeds but the tests cannot start at all.

CI mirrors this rather than asserting it: the `test` job runs the TypeScript suite on Node 22.18 and 24 across Linux, Windows and macOS, while `npm run smoke` packs the real tarballs, installs them into a clean project and drives the CLI and the MCP server over stdio on Node 20.11 as well. If `engines.node` is raised, the smoke job is what notices.

## Compatibility and stability

MCP protocol support spans five revisions; see
[`packages/mcp/README.md`](packages/mcp/README.md) for the matrix and the
configuration presets.

The server is driven in CI by `@modelcontextprotocol/sdk` — the reference
implementation — as a real client: handshake, negotiated revision, tool schemas and
six tool calls against a real repository. Everything else that exercises it speaks
JSON-RPC by hand, which checks the server against the same understanding of the
protocol that wrote it. What no client can yet exercise is the modern per-request
revision, because the SDK's newest is `2025-11-25`.

[`STABILITY.md`](STABILITY.md) states which exported symbols are a compatibility
promise, which are internal, and how a deprecation runs its course. The promise is
enforced: `npm run api:check` fails when the exported surface changes without the
lock being updated, and `npm run stability:check` fails when this file names a
symbol the packages do not export.

The lock covers both halves of a package's surface. Runtime exports come from the
built module; **type-only exports come from the generated `.d.ts` read through
the TypeScript compiler**, because a renamed type has no runtime binding and
would otherwise change the package without changing anything a check could see.
`core` has 161 exports and 112 exported types.

## Programmatic API

```typescript
import { AgentContext } from 'ai-agent-context';

const context = await AgentContext.load({ root: process.cwd() });

// Scan repository
await context.scan();

// Explain a module
const module = await context.explain('src/payments');

// Get architecture
const architecture = await context.getArchitecture();

// Get dependencies
const dependencies = await context.getDependencies();

// Search context
const results = await context.search('payment idempotency');
```

## .agent Format

The `.agent/` directory contains structured, versionable context:

```
.agent/
├── config.json          # Configuration
├── index.json           # Repository index
├── architecture.json    # Module architecture
├── dependencies.json    # Dependency graph
├── conventions.md       # Detected conventions
└── decisions.json       # Architectural decisions
```

### index.json

```json
{
  "schemaVersion": 1,
  "generatedBy": "ai-agent-context",
  "generatedAt": "2026-09-18T00:00:00.000Z",
  "repository": {
    "name": "my-project",
    "root": "/path/to/repo"
  },
  "files": 1284,
  "modules": 42,
  "dependencies": 187,
  "entryPoints": 11
}
```

### architecture.json

```json
{
  "schemaVersion": 1,
  "modules": [
    {
      "id": "payments",
      "path": "src/payments",
      "entryPoints": ["src/payments/index.ts"],
      "dependsOn": ["users", "events"],
      "usedBy": ["checkout"],
      "role": {
        "value": "service",
        "confidence": 0.87,
        "evidence": ["name matches *Service*"]
      },
      "responsibilities": ["payment processing", "refunds"]
    }
  ]
}
```

### dependencies.json

```json
{
  "schemaVersion": 1,
  "internal": [
    {
      "source": "src/checkout",
      "target": "src/payments",
      "kind": "imports"
    }
  ],
  "external": [
    {
      "source": "src/payments",
      "target": "stripe",
      "kind": "runtime"
    }
  ],
  "workspaceDependencies": []
}
```

## Configuration

`.agent/config.json`:

```json
{
  "version": 1,
  "root": ".",
  "include": ["src/**", "packages/**"],
  "exclude": ["node_modules/**", "dist/**", "build/**", ".git/**"],
  "languages": ["typescript", "javascript"],
  "features": {
    "architecture": true,
    "dependencies": true,
    "conventions": true,
    "decisions": true,
    "git": true
  },
  "security": {
    "allowSensitiveFiles": false,
    "redactSecrets": true,
    "extraSensitivePatterns": [],
    "readOnly": false
  }
}
```

Every key is optional: omitted keys keep their defaults. The defaults already cover `src/`, `packages/`, `apps/`, `lib/` and source files at any depth (`*.{ts,tsx,js,jsx,vue,svelte,...}`), plus `**/*.md` and `*.json`, while `node_modules/`, `dist/`, `build/`, `coverage/`, `.git/` and `.agent/` are always excluded.

### Read-only mode

`security.readOnly`, or the global `--read-only` flag, refuses every write while leaving every query working:

```bash
agent-context scan --read-only
# ✗ Refusing to scan and write .agent/: this repository is in read-only mode.
#   Queries (status, explain, context, task, impact, search, detect, verify) keep working.
```

The guard lives in the `AgentContext` facade rather than in each command, so no code path can write around it — including an MCP tool handler and an embedder calling `scan()` directly. Only `scan()` and `init()` write.

### Organization policy

`.agent/config.json` is written by contributors, so on its own it cannot enforce a rule the organization requires. `.agent-policy.json` is the floor beneath it, and it is looked up in the repository root **or any parent directory** — one file at a monorepo or organization checkout applies to everything under it. `AGENT_CONTEXT_POLICY` overrides the search.

```json
{
  "version": 1,
  "exclude": ["vendor/private"],
  "sensitive": ["*.tfvars"],
  "allowSensitiveFiles": false,
  "redactSecrets": true,
  "readOnly": false
}
```

A repository may tighten; it may not loosen. The policy unions its patterns in, forces `allowSensitiveFiles` off when it says `false`, forces redaction on when it says `true`, and forces read-only on when it says `true` — none of which a repository setting or CLI flag can undo. A policy that sets `redactSecrets: false`, or carries an unknown `version`, is **rejected rather than ignored**: a policy that silently fails to apply is indistinguishable from no policy at all. See [SECURITY.md](SECURITY.md).

A change to the policy invalidates the incremental cache, so context is never reused across a tightening of the rules.

## Monorepo Support

`ai-agent-context` supports monorepo structures:

```
packages/
  api/
  payments/
  users/
```

It detects:
- Workspace configuration (npm, pnpm, yarn)
- Workspace dependencies
- Package-level entry points
- Cross-package relationships

## Security

Layering diagnostics are heuristic, confidence-bearing and evidence-based; they are advisory, not compiler-enforced rules.

- **Local-first**: 100% local execution, no external API calls
- **No telemetry**: No data sent to external services
- **Secret filtering**: Automatically excludes `.env`, credentials, certificates
- **Deterministic**: Same repository state → identical context
- **Symlink protection**: Symlinks are not followed by default
- **Path traversal rejected**: An import specifier that climbs above the repository root is reported as unresolved with an explicit diagnostic, never silently collapsed onto an in-repo path
- **CI verification**: `agent-context verify --json` detects invalid schema and drift
- **Policy**: See [SECURITY.md](SECURITY.md) for supported versions and reporting guidance

## Accuracy notes

The analyzer is deterministic and evidence-based, not omniscient. Two behaviours
are worth knowing before you rely on it:

- **`explain` and `impact` scope to what you asked for.** If the path you pass is
  a directory narrower than the module that owns it, the answer covers only that
  directory and says so in a `Scope:` block (and in the `scope` field of the JSON
  payload). It never silently widens to the whole module.
- **Unresolved imports are reported, not guessed.** Imports of build output
  (`dist/`), undeclared packages and aliases that point nowhere appear in
  `dependencies.json` under `unresolved` with the reason. A non-empty
  `unresolved` list is a signal about repository layout, not necessarily a bug.

Platform built-ins (`node:fs`, `node:path`, …) rank below declared packages in
bounded projections: they are capabilities of the runtime, not facts about the
project.

**`agent-context detect` tells you where the analysis was incomplete.** Before
relying on the dependency graph, run it: it reports unresolved imports separated
into real gaps, excluded build output and rejected path traversals, plus failed
parses, cycles and layering violations.

## Dependency graph checked against an independent resolver

`tools/ground-truth.mjs` compares the dependency graph with the answer produced by
the TypeScript compiler, which shares no code with this project:

```bash
npm run ground-truth
npm run ground-truth -- --json
```

It runs in CI as `dependency graph vs typescript`, and exits non-zero when
precision or recall falls below 100%.

**Current result on this repository:**

| Metric | Value |
| --- | --- |
| Specifiers examined | 663 (462 in-repo, 165 external) |
| File-level import pairs | 410 |
| Module edges, ground truth | 18 |
| Module edges, analyzer | 18 |
| **Precision** | **100%** (0 false positives) |
| **Recall** | **100%** (0 false negatives) |
| Unresolved imports cross-checked | 25 — all imports of excluded build output, **0 missed** |

**Why this is not the same number twice.** `summary.imports.resolutionRate` is
produced by the analyzer describing itself: it counts what its own resolver
managed to resolve. A resolver bug and its own accuracy check can only agree with
each other. Here the specifiers are extracted with `ts.createSourceFile` and
resolved with `ts.resolveModuleName`, so a disagreement is possible and a
disagreement would fail the build.

**What is compared.** Ground truth is importer-to-imported pairs, lifted to module
edges using the analyzer's file-to-module partition. That partition is a division
of the file list, not a claim about dependencies; everything that decides whether
an edge exists comes from the compiler.

**Three scope rules, each counted in the output so none can hide a disagreement:**

- Build output is excluded, matching the analyzer's documented `excludedOutput`
  class. An edge derived from `dist/` would make the dependency graph depend on
  whether the project happened to be built.
- A bare specifier naming a declared workspace package is an in-repo dependency,
  not an external one. A package importing **itself by name** — which is what
  `ky`'s own type tests do — is a dependency on its local entry point. A
  specifier the importing manifest *declares* as a dependency is a registry
  dependency even when the name matches a package in the same tree, which is what
  separates `clsx`'s `bench/` from `ky`'s `test-d/`.
- An analyzer target matches a truth target when they are equal, or when the
  analyzer target is a workspace package containing the truth target. Both
  describe one dependency at different levels of detail; matches that needed this
  rule are reported as `package rule`.

**The finer check.** Eighteen module edges is a coarse denominator: one wrong
edge moves the percentage by five points. So every import the analyzer *failed*
to resolve is also put to the compiler and classified as `expectedBuildOutput`,
`agreedMissing`, or `missed`. A single `missed` entry means the headline
resolution rate is overstated.

**Known limits.** The compiler is only an oracle for TypeScript/JavaScript, and
it applies its own resolution rules rather than the analyzer's configuration.
This measures whether the resolver agrees with a well-known independent
implementation — it does not certify the analyzer's heuristics, which remain
confidence-bearing and advisory.

## The same check on other people's repositories

Measuring yourself is not evidence. Every repository above is one the analyzer
was written alongside, so a defect that only exists in third-party code would
pass all of it — and one did: a nested generic in a type annotation closed the
type argument list with `>>`, which the lexer had merged into a single shift
token, and the parser then scanned to the end of the file and dropped every
statement after it, reporting success. In a barrel file that is most of the
public surface.

Eight third-party repositories are therefore pinned by commit SHA in
`tools/benchmark-repos.json`:

```bash
npm run benchmark:public        # clone, measure, delete
npm run ground-truth:public     # both oracles, on the same set
```

| Repository | Shape | Files | Resolution | Path escapes | Determinism | Precision / recall |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `clsx` | single file | 13 | 100% | 0 | yes | 100% / 100% |
| `p-map` | small, several deps | 11 | 100% | 0 | yes | single module |
| `ansi-styles` | CommonJS | 8 | 100% | 0 | yes | single module |
| `ky` | modern ESM TypeScript | 105 | 100% | 0 | yes | 100% / 100% |
| `ora` | TypeScript, build output committed | 11 | 100% | 0 | yes | single module |
| `execa` | larger TypeScript | 673 | 100% | 0 | yes | 100% / 100% |
| `got` | deep directory tree | 127 | 100% | 0 | yes | 100% / 100% |
| `changesets` | pnpm workspace monorepo | 288 | 100% | 0 | yes | 100% / 100% |
| `radix-primitives` | TSX at scale, pnpm workspace | 686 | 100% | 0 | yes | 100% / 100% |

A commit SHA rather than a branch, so two runs compare each other; a moving
target would make every measurement incomparable with the last. Nothing is
vendored — each repository is cloned into a temporary directory, measured, and
deleted. "Single module" means the repository has no module edges to compare, so
precision and recall are undefined there rather than 100%.

**Parse coverage is complete: 1922 files, zero partial, zero failed.** That is a
CI gate, not an observation. A partial parse means the extractor gave up partway
through a file and dropped the statements after that point, so the repository
would report fewer dependencies than it has while showing a clean result — which
is what happened until v0.15.0.

Repositories are added for the **syntax they contain**, not for their
popularity. That is how TSX was found at all: eight plain-TypeScript and
CommonJS repositories were all passing, and the first one chosen for containing
TSX had 25 files out of 686 silently losing their imports.

CI runs this as `public repositories`, on pushes to `master` and weekly, but not
on pull requests: it needs the network, and a slow clone should not block a
change that can be reviewed without it.

### Entry points that are declared rather than guessed

Four sources produce entry points: declared `package.json` fields, npm scripts
that name a file, naming conventions, and behavioural signals. Only the first is
a fact — when a manifest says `"bin": { "agent-context": "./dist/bin.js" }`, the
file that command runs does not depend on anything in this package.

```bash
npm run ground-truth:entry
```

Measured: **14 declared entry files on this repository, 82 across the pinned set,
48 of them in a pnpm workspace where several packages declare more than one
command. Precision 100%, recall 100%.**

The other three sources are heuristics, and this project has no oracle for
heuristics — a hand-labelled corpus would measure whoever labelled it, and a
second heuristic written independently would measure itself. The tool says so on
every run rather than printing a number it cannot defend.

## Measured, not asserted

The benchmark measures the claims rather than restating them, and CI fails on regressions:

| Metric | Current | Gate |
| --- | --- | --- |
| import resolution rate | 100% | yes |
| dependency graph precision vs the TypeScript compiler | 100% (0 false positives) | yes |
| dependency graph recall vs the TypeScript compiler | 100% (0 false negatives) | yes |
| path escapes | 0 | yes |
| evidence coverage | 100% (363/363 judgements cite a source) | yes |
| determinism | 0 non-deterministic repositories | yes |
| `explain` on modules >64 KB | 0.062x of source size (−93.8%) | reported |
| `explain` on modules <8 KB | 2.07x of source size | reported |

Evidence coverage counts every object carrying a numeric `confidence` — the shape used for a heuristic — and asks how many cite at least one source. A repository with no heuristics reports `null` rather than 100%, because a perfect score would claim something was explained when nothing was. Determinism is checked by scanning each tree twice more with the cache bypassed and comparing a hash of the generated documents byte for byte; `force: true` re-reads every file, so a difference can only come from the analyzer.

Reproduce with `npm run benchmark`. The last size bucket is reported rather than hidden: on modules under 4 KB the tool is still more expensive than reading the source, and averaging that away with the large-module win would be the dishonest way to present the result.

## Architecture

The package is organized as a monorepo:

```
packages/
  core/     # Core analysis engine
  cli/      # Command-line interface
  mcp/      # MCP adapter (dual-era: legacy + modern protocol revisions)
```

### Core API

The core package (`@ai-agent-context/core`) provides:

- Repository scanner
- Language adapters (TypeScript, JavaScript, JSON, Markdown)
- Knowledge graph builder
- Architecture detection
- Convention detection
- Git integration
- Incremental scanning
- Deterministic serialization

### CLI

The CLI package (`ai-agent-context`) provides:

- User-friendly commands
- Colored output
- Progress indicators
- JSON output mode

### MCP Adapter

The MCP adapter (`@ai-agent-context/mcp`) provides:

- 14 MCP tools: structured context queries, module explanations, dependency
  analysis, change impact and coverage diagnostics
- Read-only Resources and Prompts
- **Dual-era protocol support**: legacy revisions `2024-11-05`, `2025-03-26`,
  `2025-06-18`, `2025-11-25` negotiated through the `initialize` handshake, and
  modern `2026-07-28` negotiated per request, plus `server/discover`
- Request cancellation and per-request timeouts
- Configuration presets for Claude Code, Cursor, Cline and Continue:

```bash
agent-context-mcp config claude-code   # or cursor, cline, continue
agent-context-mcp config --list
```

## Example Workflow with AI Agent

```bash
# Developer initializes context
npm install -g ai-agent-context
agent-context init
agent-context scan

# Developer commits context to Git
git add .agent
git commit -m "chore: add agent context"

# AI agent can now query context
agent-context explain src/payments

# When architecture changes
agent-context scan
agent-context diff

# Git shows architectural changes
git diff .agent/architecture.json
```

## Extensibility

The architecture is designed for extensibility:

- **Language adapters**: Add support for Python, Go, Rust, etc.
- **Convention detectors**: Add custom convention detection
- **Architecture detectors**: Add custom role detection
- **Search backends**: Add BM25, embeddings, vector databases
- **MCP tools**: Add custom MCP tools

## License

MIT

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the analysis-code rules (determinism, evidence, confidence) and the release process.