# API stability

What this project promises about its public API, what it does not, and how a
consumer can tell which is which.

The short version: **the `AgentContext` facade and the `.agent/` schema are the
contract. Everything else is an implementation detail that happens to be
reachable.** That is stated up front because a promise covering all 161 exports
of `@ai-agent-context/core` would be a promise nobody could keep.

## Why this document exists

The package is meant to be depended on. A consumer who pins a version needs to
know which of its calls can change under them at a minor bump, and which cannot.
Without an answer, the only safe assumption is that nothing is stable — which
makes the package unusable for anything long-lived.

Two mechanisms make the promise checkable rather than aspirational:

1. **The public API lock.** Every exported symbol of every package is recorded in
   `packages/core/test/public-api.lock.json`, `packages/cli/test/public-api.lock.json`
   and `packages/mcp/test/public-api.lock.json`. A test and a dedicated CI job
   (`api surface`) fail when the real exports differ from the lock.
2. **This document.** The lock records what exists; this says what is *promised*.

## Stable from 1.0

### `@ai-agent-context/core`

| Symbol | Promise |
| --- | --- |
| `AgentContext` | The facade. Methods, options and result shapes follow semver. |
| `TOOL_VERSION`, `SCHEMA_VERSION` | Additive only. |
| `loadConfig`, `validateConfig`, `normalizeConfig`, `applyOverrides`, `writeConfigFile` | Configuration surface. |
| `loadPolicy`, `applyPolicy`, `parsePolicy`, `findPolicyFile`, `enforcePolicy`, `POLICY_FILE`, `POLICY_VERSION` | Organization policy surface. |
| `escapesRoot`, `joinStrict` | Path-safety helpers used by embedders that resolve their own imports. |
| `AgentContextError`, `ConfigError`, `AnalysisError`, `ContextStateError`, `ReadOnlyError`, `AdapterUnavailableError` | Error types and their `code` values. |
| `SCHEMA_VERSION`, `AGENT_DIR`, `CONFIG_FILE`, `CONTEXT_FILES`, `GENERATOR_NAME` | Schema constants. |

### `@ai-agent-context/mcp`

| Symbol | Promise |
| --- | --- |
| `McpServer`, `createStdioTransport`, `createMemoryTransport`, `McpServerOptions`, `McpTransport` | Server and transports. |
| `SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION`, `LATEST_LEGACY_VERSION`, `isSupportedVersion`, `isModernVersion`, `negotiateLegacyVersion` | Protocol negotiation surface. |
| `ErrorCode` | The JSON-RPC codes the server emits. |
| `TOOL_DEFINITIONS`, `toolByName`, `validateToolArguments` | Tool surface. |
| `CLIENT_PRESETS`, `presetById`, `renderPreset`, `renderAllPresets`, `serverArgv` | Client configuration presets. |

### `ai-agent-context` (CLI)

The CLI's **commands, flags, exit codes and `--json` payload shapes** are the
contract. The functions exported from `packages/cli/src` for embedding are
best-effort.

## Not stable

Everything else that is exported. Concretely:

- the internal pipeline (`runPipeline` and its result types);
- individual language adapters (`TsJsAdapter`, `JsonAdapter`, `MarkdownAdapter`,
  `PackageJsonAdapter`, `TsConfigAdapter`, `LanguageRegistry`);
- graph internals (`ImportResolver`, `PatternSet`, `ParseCache`, `LocalStateStore`,
  `Bm25Index`, `SearchService`);
- the document builders (`buildArchitectureDocument`, `buildIndexDocument`, …);
- detectors (`applyArchitectureDetection`, `detectEntryPoints`, `detectModuleRoles`, ...);
- utility helpers (`ancestors`, `basename`, `bucket`, `analyze`, …).

These are exported because the analyzer is easier to test and extend with them
reachable, not because they are supported. **They may change or disappear in a
minor release.** If you need one, open an issue: promoting a symbol to the stable
list is a small change.

## Semver rules

| Change | Release |
| --- | --- |
| Adding an export to a stable symbol's result type | minor |
| Adding a new optional property to an options object | minor |
| Adding a new command, CLI flag, MCP tool or resource | minor |
| Adding a new field to an `.agent/` document | minor |
| Removing or renaming a stable export | **major** |
| Making an options property required | **major** |
| Removing a field from a persisted `.agent/` document | **major** |
| Changing a JSON-RPC error code or MCP tool name | **major** for the code; existing tools are renamed, never repurposed |
| Changing what an existing analysis *means* (e.g. what counts as an entry point) | **major**, or a minor with a loud `MIGRATION.md` entry when the payload shape is unchanged |

The rule behind the table: a consumer's code must keep compiling and keep
producing the same results across a minor upgrade. That is the guarantee worth
making, and the reason "a heuristic now returns a different value" is treated as a
major change even when nothing in the types moved.

## Deprecation

A deprecation is a deliberate sequence, not a flag flipped at the last moment:

1. **Announced.** The symbol or behaviour is marked `@deprecated` in its JSDoc
   and written up in `MIGRATION.md`, with the replacement named and the version
   in which it will be removed.
2. **Warned.** Where the caller can observe it — CLI, MCP — the deprecation is
   reported at runtime, on stderr or in the JSON payload's diagnostics.
3. **Kept for at least two minor releases** after the announcement.
4. **Removed only in a major release**, listed in `MIGRATION.md` with the
   migration path.

A deprecation window is never shortened. If a deprecated symbol turns out to be
load-bearing for someone, it stays until the major that was already planned.

## `.agent/` schema compatibility

The `.agent/` directory is committed and diffed across releases, so the schema is
the most durable contract in the project.

- `SCHEMA_VERSION` is currently **1** and has not changed since 0.3. Every
  release so far has been additive within v1.
- **Within `SCHEMA_VERSION = 1`**, documents may gain fields. Consumers must
  ignore unknown fields — reading a field that is absent is an error, reading a
  field that is present but unknown to you is not.
- **A change in what an existing field means is a schema change.** Bumping
  `SCHEMA_VERSION` is a major release, requires `agent-context migrate`, and is
  documented in `MIGRATION.md`.
- **A reader refuses what it cannot understand.** A document whose
  `schemaVersion` is not supported is reported as invalid rather than parsed
  optimistically, with the reason recorded. `verify` fails on it;
  `agent-context migrate --check` reports it as the `invalid` state.
- **Consumers should check the version before reading.** `readPersistedContext`
  and `contextFileNames` are exported for exactly this.

## What is not promised

- a compiler-grade analyzer for languages other than TypeScript/JavaScript;
- automatic understanding of business logic without evidence;
- dropping a runtime dependency from the core, which is what keeps it installable
  anywhere and safe on untrusted repositories;
- behaviour of the internal exports listed above;
- that heuristic output never changes — roles, conventions and decisions are
  advisory, carry a confidence and evidence, and will improve over time. When
  that changes *what is reported*, it is a major release regardless.

## How to check a version's promises

```bash
npm run api:check     # does this build match the locked surface?
npm run api:lock      # rewrite the locks after an intentional change
```

Both require `dist/` and run the build first. If `api:check` fails in your fork,
the exports changed — read `MIGRATION.md` before deciding whether that was
intended.