# ai-agent-context CLI

Command-line interface for `ai-agent-context`.

This package provides the user-facing CLI commands for scanning repositories and querying context.

## Installation

```bash
npm install -g ai-agent-context
```

Or use without installation:

```bash
npx agent-context <command>
```

## Commands

### `init`

Initialize context for a repository.

```bash
agent-context init
```

Creates:
- `.agent/` directory
- `.agent/config.json` - Configuration file
- `.agent/.gitignore` - Git ignore for local cache

Options:
- `--force` - Overwrite existing configuration

### `scan`

Scan the repository and generate context.

```bash
agent-context scan
```

Options:
- `--force` - Ignore cache and re-scan all files
- `--dry-run` - Scan without writing to disk
- `--quiet` - Minimal output
- `--json` - JSON output format

### `context`

Compact repository context summary with optional limits.

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

Show bounded local Git history for a module:

```bash
agent-context history src/models --limit-history 20
agent-context history src/models --json
```

### `revision-diff`

Show paths changed between local revisions:

```bash
agent-context revision-diff --revision HEAD~1 --base HEAD
agent-context revision-diff --revision HEAD~1 --json
```


Get the bounded impact set for a proposed change.

```bash
agent-context impact src/payments --max-files 100
agent-context impact src/payments --json
```

### `explain`

Explain a module or file.

```bash
agent-context explain <path>
```

Options:
- `--json` - JSON output format

Example:
```bash
agent-context explain src/payments
```

### `diff`

Show context changes since last scan.

```bash
agent-context diff
```

Options:
- `--json` - JSON output format

### `status`

Show repository context status.

```bash
agent-context status
```

### `verify`

Validates persisted context without modifying it. Returns a non-zero exit code for missing, invalid, schema-mismatched, config-stale, or working-tree-drifted context.

```bash
agent-context verify --json
```

### `clean`

Remove generated context.

```bash
agent-context clean
```

Options:
- `--force` - Skip confirmation

### `search`

Search repository context.

```bash
agent-context search <query>
```

Options:
- `--json` - JSON output format
- `--limit <n>` - Limit results

## Examples

### Initial Setup

```bash
# Initialize context
agent-context init

# Scan repository
agent-context scan

# Check status
agent-context status
```

### Explaining Modules

```bash
# Explain a module
agent-context explain src/payments

# Explain a specific file
agent-context explain src/payments/payment-service.ts

# Get JSON output
agent-context explain src/payments --json
```

### Checking Changes

```bash
# Scan after making changes
agent-context scan

# Review changes
agent-context diff

# See what changed in architecture
agent-context diff --json | jq '.architecture'
```

### CI/CD Integration

```bash
# Quiet mode for CI
agent-context scan --quiet

# JSON output for automation
agent-context scan --json > context-scan.json
```

## Output Formats

### Human-Readable

The default output is human-readable with colored sections:

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
```

### JSON

Use `--json` for machine-readable output:

```bash
agent-context explain src/payments --json
```

Returns structured JSON suitable for parsing by tools and AI agents.

## Configuration

The CLI reads configuration from `.agent/config.json`:

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

CLI flags override configuration:

```bash
agent-context scan --include "custom/**" --exclude "test/**"
```

## Exit Codes

- `0` - Success
- `1` - Error
- `2` - Configuration error

## Tips

### Incremental Scanning

The CLI uses incremental scanning by default. Only changed files are re-analyzed.

```bash
# First scan (full)
agent-context scan

# Subsequent scans (incremental)
agent-context scan
```

### CI/CD

For CI/CD, use quiet mode:

```bash
agent-context scan --quiet
```

### Large Repositories

For large repositories, consider:

1. Excluding unnecessary directories
2. Limiting the languages analyzed
3. Using `--force` only when needed

## Troubleshooting

### "No usable .agent/ context found"

Run `agent-context init` followed by `agent-context scan`.

### "Git signals: unavailable"

Ensure the repository is a Git repository.

### "Failed to parse file"

The scanner continues even if some files fail to parse. Use `--verbose` for details.

## Security

The CLI is local-only. Sensitive files are excluded, symlinks are not followed by default, and `verify` is read-only. See the repository `SECURITY.md`.

## License

MIT
