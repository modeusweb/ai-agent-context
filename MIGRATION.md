# Migration guide

## v0.5.0

Correctness release for the dependency graph. The `.agent/` v1 schema is
unchanged, so existing context stays readable — but **a rescan is required** to
get the corrected graph, and `explain`/`impact` answers change shape.

### Behavior changes

- **Imports that climb directories now resolve.** This is the significant fix.
  Path normalization previously collapsed `.` and duplicate separators but not
  `..`, so a specifier like `../util/paths.ts` was joined into
  `src/core/graph/../util/paths.ts` and matched no analyzed file. Every
  relative import containing `..` was reported as `unresolved`, which emptied
  the dependency graph and, with it, `get_dependents`, `get_change_impact` and
  the layering diagnostics. Measured on this repository before the fix: 222 of
  250 relative imports unresolved, 18 module edges; after it, 16 unresolved
  (all of them imports of `dist/`, which is excluded by design) and 49 module
  edges. Rescan to regenerate the graph.
- **`explain` and `impact` scope to a directory instead of widening.** Asking
  about a directory that module detection did not promote (it sits deeper than
  `analysis.moduleDepth`, or holds a single direct file) used to answer with the
  enclosing module — e.g. `explain packages/core/src/core/graph` returned all 47
  files of `packages/core/src`. It now answers for the requested directory only
  and says so. Consumers that assume `explain <dir>` describes the whole owning
  module must check the new `scope` field.
- **New `scope` field on `ModuleExplanation`.** Present only for scoped
  answers: `{ moduleId, directory, fileCount }`. It is omitted otherwise.
  Surface it — a scoped result deliberately omits the rest of its module, and
  presenting it as a whole-module answer understates the change surface.
- **Scoped change impact is honest about the owning module.** For a scoped
  directory the impact set is the files and modules that actually import it.
  The owning module is no longer reported as broken by a change inside one of
  its own subdirectories.
- **Node built-ins rank below declared packages.** `node:fs` and `node:path`
  were classified as `infrastructure` at high confidence, so bounded
  projections filled their budget with them ahead of the packages that actually
  describe the project. `get_repository_context` and `explain_module` now rank
  platform built-ins last. Classification values are unchanged.

### Security

- **Path traversal is rejected, not clamped.** A relative specifier that climbs
  above the repository root (`../../../etc/passwd`) used to be silently
  collapsed onto an in-repo path, which could resolve to a legitimate analyzed
  file. It is now reported as `unresolved` with an explicit
  `resolves outside the repository root` diagnostic. Absolute specifiers are
  rejected on the same grounds. New exports: `escapesRoot`, `joinStrict`.

### New API

```ts
import { escapesRoot, joinStrict, isNodeBuiltin } from '@ai-agent-context/core';

escapesRoot('a/../../../etc/passwd'); // true
joinStrict('src/core/graph', '../util/paths.ts');
// { path: 'src/core/util/paths.ts', escaped: false, absolute: false }
```

`explainModule()` gained an optional `scope` in its resolved target, and
`transitiveDependents()` accepts an optional `scopeFiles` set.

No code changes are required from consumers that only read `.agent/` documents,
but a rescan is needed for the corrected dependency graph.

## v0.4.0

Reliability and ergonomics release. The `.agent/` v1 schema is unchanged, so an
existing context stays readable — but a rescan is recommended, and a few
behaviors changed intentionally.

### Behavior changes

- **Sensitive / oversized files no longer mark the context as stale.** They are
  reported as `unchanged` instead of recurring in `changes.added`, so `status`
  and `verify` no longer stay permanently `stale` when a sensitive path also
  matches `include` (for example `src/credentials.json`).
- **Broader default `include`.** The defaults now also match source files at any
  depth (`*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}`), so layouts without a
  `src/` directory (`app/`, `pages/`, `server/`, `api/`, root-level files, ...)
  are analyzed out of the box. Projects that set `include` explicitly in
  `.agent/config.json` are unaffected.
- **`scan` fails loudly on an empty match.** When no file matches the include
  patterns, `scan` emits a warning and exits with code `1` instead of silently
  reporting success.
- **Strict flag parsing.** Unknown `--key=value` and `--no-key` flags are now
  rejected with a usage error (exit code `2`), consistent with the
  space-separated form.
- **`AgentContext.load()` validates the root.** A missing root, or a path that is
  not a directory, now throws instead of resolving to an empty scan.
- **Compact JSON for `status` / `verify`.** `--json` omits the full
  `changes.unchanged` list and reports `changes.unchangedCount`; pass `--full`
  to restore the complete list.
- **`index.json` no longer advertises `conventions.md`** when
  `output.conventionsMarkdown` is disabled; the `context.conventionsMarkdown`
  key is omitted entirely.
- **Cache invalidation on upgrade.** The incremental parse cache is invalidated
  when the tool version changes, so a package upgrade always re-parses.
- **Single version source.** The CLI and MCP adapter derive their version from
  `@ai-agent-context/core` (`TOOL_VERSION`); the `ai-agent-context` dependency on
  core is raised to `^0.4.0`.

No code changes are required from consumers that only read `.agent/` documents.

## v0.3.7

Packaging hotfix: the published MCP package now depends on the current core release instead of an older minimum, preventing mixed-version runtime behavior during staged npm processing.

## v0.3.6

MCP tool calls now validate required fields, primitive types, enums, and reject unknown properties before dispatch. This release is additive and preserves the v1 context schema.

## v0.3.5

Added MCP Resources and Prompts plus the read-only CLI `verify` command. Existing APIs and `.agent/` schema remain compatible. `verify --json` adds a `valid` field and exits non-zero on missing, invalid, unsupported-schema, config-stale, or drifted context.

## v0.3.4

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
