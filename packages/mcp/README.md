# @ai-agent-context/mcp

MCP (Model Context Protocol) adapter for `ai-agent-context`.

This package provides MCP tools that allow AI agents (like Claude, etc.) to query repository context directly.

## Installation

```bash
npm install @ai-agent-context/mcp
```

## MCP Resources

The server exposes read-only resources:

- `agent://repository/context`
- `agent://repository/architecture`
- `agent://repository/dependencies`
- `agent://repository/conventions`
- `agent://repository/decisions`

## MCP Prompts

- `onboard_to_repository`
- `review_change_impact`
- `explain_architecture`


### `get_context_for_task`

Get bounded, task-oriented context for an agent.

```json
{
  "task": "add idempotent payment retries",
  "target": "src/payments",
  "maxModules": 5
}
```

Returns relevant modules, dependencies, public API, tests, conventions, decisions and evidence.

### `get_change_impact`

Get the bounded impact set for a proposed change.

```json
{
  "target": "src/payments",
  "maxFiles": 100
}
```

Returns transitive dependent modules, affected files, tests, relevant conventions, decisions and evidence.

### `get_module_history`

Returns bounded local Git history for a module.

```json
{"target":"src/models","limit":20}
```

### `get_revision_diff`

Returns changed paths and statuses between two local revisions.

```json
{"revision":"HEAD~1","base":"HEAD"}
```

### `get_revision_snapshot`

Returns metadata and structural summary for a local Git revision without checking it out or changing the working tree.

```json
{"revision":"HEAD~1"}
```

### `get_repository_context`

Get the complete repository context.

```json
{
  "root": "/path/to/repository",
  "maxModules": 10,
  "maxEntryPoints": 10,
  "maxExternalDependencies": 10,
  "maxConventions": 5,
  "maxDecisions": 5,
  "maxCycles": 5
}
```


Get the complete repository context.

**Input:**
```json
{
  "root": "/path/to/repository"
}
```

**Output:**
```json
{
  "repository": {
    "name": "my-project",
    "root": "/path/to/repository",
    "files": 1284,
    "modules": 42
  },
  "architecture": { ... },
  "dependencies": { ... },
  "conventions": [ ... ],
  "decisions": [ ... ]
}
```

### `explain_module`

Explain a specific module.

**Input:**
```json
{
  "root": "/path/to/repository",
  "target": "src/payments"
}
```

**Output:**
```json
{
  "path": "src/payments",
  "entryPoints": ["src/payments/index.ts"],
  "responsibilities": ["payment processing", "refunds"],
  "dependsOn": ["users", "events"],
  "usedBy": ["checkout"],
  "publicAPI": [ ... ],
  "conventions": [ ... ],
  "decisions": [ ... ]
}
```

### `get_dependencies`

Get dependency information.

**Input:**
```json
{
  "root": "/path/to/repository"
}
```

**Output:**
```json
{
  "internal": [ ... ],
  "external": [ ... ],
  "workspaceDependencies": [ ... ]
}
```

### `get_dependents`

Get modules that depend on a given module.

**Input:**
```json
{
  "root": "/path/to/repository",
  "moduleId": "payments"
}
```

**Output:**
```json
{
  "moduleId": "payments",
  "dependents": ["checkout", "subscription"]
}
```

### `search_context`

Search repository context.

**Input:**
```json
{
  "root": "/path/to/repository",
  "query": "payment idempotency"
}
```

**Output:**
```json
{
  "query": "payment idempotency",
  "results": [
    {
      "type": "module",
      "id": "payments",
      "score": 0.95,
      "reason": "module name and responsibilities match query"
    }
  ]
}
```

### `get_architecture`

Get architecture information.

**Input:**
```json
{
  "root": "/path/to/repository"
}
```

**Output:**
```json
{
  "modules": [ ... ],
  "layers": [ ... ],
  "boundaries": [ ... ]
}
```

### `get_conventions`

Get detected conventions.

**Input:**
```json
{
  "root": "/path/to/repository"
}
```

**Output:**
```json
{
  "conventions": [
    {
      "category": "Naming",
      "statement": "Files use kebab-case",
      "confidence": 0.9,
      "evidence": [ ... ]
    }
  ]
}
```

### `get_decisions`

Get architectural decisions.

**Input:**
```json
{
  "root": "/path/to/repository"
}
```

**Output:**
```json
{
  "decisions": [
    {
      "id": "ADR-001",
      "title": "Use PostgreSQL for transactional data",
      "status": "accepted",
      "source": "docs/adr/001-postgresql.md"
    }
  ]
}
```

## Usage

### Standalone MCP Server

```typescript
import { createMcpServer } from '@ai-agent-context/mcp';

const server = createMcpServer({
  root: process.cwd()
});

// Start the server
await server.start();
```

### With Claude Desktop

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "agent-context": {
      "command": "node",
      "args": ["path/to/@ai-agent-context/mcp/dist/server.js"],
      "env": {
        "AGENT_CONTEXT_ROOT": "/path/to/repository"
      }
    }
  }
}
```

### Programmatic Usage

```typescript
import { AgentContext } from '@ai-agent-context/core';
import { createMcpTools } from '@ai-agent-context/mcp';

const context = await AgentContext.load({ root: process.cwd() });
const tools = createMcpTools(context);

// Use tools with MCP server
// ...
```

## Architecture

The MCP adapter is a thin wrapper around the core API:

```
AI Agent
   ↓
MCP
   ↓
@ai-agent-context/mcp
   ↓
@ai-agent-context/core
   ↓
Repository Knowledge Graph
```

The MCP adapter:
- Does not contain business logic
- Only calls core API methods
- Transforms results to MCP-compatible format
- Handles MCP-specific error handling

## Configuration

The MCP adapter respects the same configuration as the core package:

- `.agent/config.json` - Repository configuration
- `.agent/index.json` - Cached context
- Environment variables - Override configuration

## Security

The MCP adapter inherits the security properties of the core package:

- **Local-only**: No external API calls
- **No telemetry**: No data sent to external services
- **Secret filtering**: Automatically excludes sensitive files
- **Repository-scoped**: Only accesses configured repository

## Error Handling

The MCP adapter returns structured errors:

```json
{
  "error": {
    "code": "CONTEXT_NOT_FOUND",
    "message": "No usable .agent/ context found",
    "suggestions": [
      "Run: agent-context init && agent-context scan"
    ]
  }
}
```

## License

MIT
