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

### `explain`

Explains a module or file:

```bash
agent-context explain src/payments
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

### `clean`

Removes generated context:

```bash
agent-context clean
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

- **Local-first**: 100% local execution, no external API calls
- **No telemetry**: No data sent to external services
- **Secret filtering**: Automatically excludes `.env`, credentials, certificates
- **Deterministic**: Same repository state → identical context

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

Contributions are welcome! Please read the contributing guidelines before submitting PRs.
