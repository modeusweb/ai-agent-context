# Migration guide

## v0.3.5

Temporal context APIs are additive: `getModuleHistory()` and `getRevisionDiff()` use local Git only. Git absence, shallow history and invalid revisions degrade to empty/diagnostic results without changing the repository.


Layering diagnostics are exposed by `getArchitecture()` and the persisted `architecture.json` document. Existing `.agent/` files remain readable; rescan to regenerate documents with the new field.


The `.agent/` schema remains unchanged. This release adds bounded projections and task-oriented APIs.

### Core

`getRepositoryContext()` remains compatible and now accepts optional limits:

```ts
await context.getRepositoryContext({
  maxModules: 10,
  maxEntryPoints: 10,
  maxExternalDependencies: 10,
  maxConventions: 5,
  maxDecisions: 5,
  maxCycles: 5,
});
```

New APIs:

```ts
await context.getTaskContext('add payment retries', { target: 'src/payments', maxModules: 5 });
await context.getChangeImpact('src/payments', { maxFiles: 100 });
```

### CLI

New commands:

```bash
agent-context task "add payment retries" --target src/payments --max-modules 5
agent-context impact src/payments --max-files 100
agent-context context --max-modules 10 --max-entry-points 10
```

### MCP

New tools:

- `get_context_for_task`
- `get_change_impact`

`get_repository_context` accepts optional projection limits:

```json
{
  "maxModules": 10,
  "maxEntryPoints": 10,
  "maxExternalDependencies": 10,
  "maxConventions": 5,
  "maxDecisions": 5,
  "maxCycles": 5
}
```

No migration is required for existing `.agent/` files. The release is additive and keeps deterministic local-only analysis.
