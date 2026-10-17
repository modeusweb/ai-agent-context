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
  }
}
```

Every key is optional: omitted keys keep their defaults. The defaults already cover `src/`, `packages/`, `apps/`, `lib/` and source files at any depth (`*.{ts,tsx,js,jsx,vue,svelte,...}`), plus `**/*.md` and `*.json`, while `node_modules/`, `dist/`, `build/`, `coverage/`, `.git/` and `.agent/` are always excluded.

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

## Architecture

The package is organized as a monorepo:

```
packages/
  core/     # Core analysis engine
  cli/      # Command-line interface
  mcp/      # MCP adapter (for Claude, etc.)
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

- MCP tools for AI agents
- Structured context queries
- Module explanations
- Dependency analysis

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
