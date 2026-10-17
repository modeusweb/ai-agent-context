# Migration guide

## v0.9.0

Organization policy, a read-only contract, and schema migration tooling. The
`.agent/` v1 schema is unchanged and **no rescan is required** — nothing about
the analysis or the persisted context changed. Everything below is additive, with
one exception noted under "Behavior change".

### New configuration key

```json
{
  "security": {
    "readOnly": false
  }
}
```

`readOnly` refuses every write and leaves every query working. The guard is
enforced in the `AgentContext` facade, not per command, so an MCP tool handler
and an embedder calling `scan()` directly hit the same check. `scan()` and
`init()` are the only operations that write. `agent-context init` writes the
repository template and therefore still works under a read-only *repository*
setting; it is refused only when the mode was enforced by the policy.

Equivalent CLI flag: `--read-only` on any command.

### New API

```ts
import {
  POLICY_FILE, POLICY_VERSION, parsePolicy, findPolicyFile,
  loadPolicy, applyPolicy, enforcePolicy, ReadOnlyError,
} from '@ai-agent-context/core';

const context = await AgentContext.load({ root });
context.readOnly;              // boolean
await AgentContext.load({ root, ignorePolicy: true }); // escape hatch
```

`ReadOnlyError` has code `ERR_READ_ONLY`, names the file that enforced the mode,
and its first hint lists the commands that keep working.

### Organization policy

`.agent-policy.json` is discovered in the repository root or any parent
directory, so one file at a monorepo or organization checkout applies to
everything beneath it. `AGENT_CONTEXT_POLICY` overrides the search. It is a
floor: a repository can tighten, never loosen.

- its patterns are unioned into `exclude` and the sensitive list;
- `allowSensitiveFiles: false` forces the escape hatch off;
- `redactSecrets: true` forces redaction on;
- `readOnly: true` forces read-only on, which no repository setting or CLI flag
  can undo.

Two documents are **rejected rather than ignored**, because a policy that
silently fails to apply is indistinguishable from no policy at all:

- an unknown `version`;
- `redactSecrets: false` — disabling redaction would copy secret material into a
  file people commit and share.

A policy change changes the configuration hash, so a cache built under weaker
rules is never reused after the rules tighten.

### `agent-context migrate`

Brings a persisted `.agent/` up to the current schema. `--check` writes nothing
and exits `1` when the context is not what this version would produce, which
makes it a CI gate complementary to `verify`:

```bash
agent-context migrate
agent-context migrate --check --json
```

States reported: `current`, `stale`, `missing`, `invalid`.

### Behavior change

A request without a `method` is now reported as `-32600` (Invalid Request) rather
than `-32601` (Method not found). See the v0.8.0 section.

### CI

A reusable workflow is published at
`.github/workflows/reusable-verify-context.yml`, callable from another repository
by `uses:`. It runs the read-only `verify` and `migrate --check`, and fails on a
rejected path traversal.

No code changes are required for consumers that only read `.agent/` documents.

## v0.8.0

MCP protocol support. The `.agent/` v1 schema is unchanged and no rescan is
required — nothing about the analysis or the persisted context changed. Every
change below is in the MCP adapter's wire behaviour.

The headline fix: the server used to pin protocol version `2024-11-05` and answer
every `initialize` with it. A client asking for `2025-06-18` was told to
downgrade to a revision it did not request, which the specification requires it
to answer by disconnecting. The server now implements five revisions and
negotiates.

### Protocol support

| Era | Revisions | How the client opens |
| --- | --- | --- |
| Legacy | `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` | `initialize` handshake |
| Modern | `2026-07-28` | per-request `_meta`, no handshake |

- **`initialize` echoes the requested revision** when it is supported. Unknown,
  missing, malformed and modern revisions are answered with `2025-11-25`, the
  newest legacy revision implemented.
- **`server/discover` is implemented** and reports `supportedVersions`,
  capabilities and server identity. The specification requires it from a modern
  server.
- **Modern requests are validated per request.** A revision naming an unsupported
  value is refused with `-32022` and `data.supported`; there is no downgrade,
  because a modern request is stateless.
- **A modern request without `io.modelcontextprotocol/clientCapabilities` is
  refused with `-32602`.** The specification marks that field required.
- **Modern results carry `resultType: "complete"`.** Clients of older revisions
  ignore the extra key.

### Cancellation and timeouts

- **`notifications/cancelled` is honoured.** A cancelled request is never
  answered, and the timeout that would otherwise follow it is not sent either.
- **Every request is bounded** by `requestTimeoutMs` (default `120000`, `0`
  disables). An expired request is answered with `-32603` and `data.timeoutMs`,
  and any late result is discarded.

### Error taxonomy

- A message without a `method` now reports `-32600` (Invalid Request) instead of
  `-32601` (Method not found). They are different failures and a client may act
  on them differently.
- The reserved code list is documented in `ErrorCode`. `-32002` (resource not
  found, older revisions) is never emitted; unknown resources report `-32602`.

### Client configuration presets

`agent-context-mcp config <client>` prints a ready-to-merge snippet for Claude
Code, Cursor, Cline and Continue. `config --list` and `config --all` are also
available. The command writes nothing.

### New API

```ts
import {
  SUPPORTED_PROTOCOL_VERSIONS,   // ['2024-11-05', ..., '2026-07-28']
  LATEST_PROTOCOL_VERSION,       // '2026-07-28'
  LATEST_LEGACY_VERSION,         // '2025-11-25'
  ErrorCode,                     // -32600 / -32601 / -32602 / -32603 / -32021 / -32022
  isSupportedVersion,
  isModernVersion,
  negotiateLegacyVersion,
  unsupportedProtocolVersion,
  CLIENT_PRESETS, presetById, renderPreset, renderAllPresets, serverArgv,
} from '@ai-agent-context/mcp';

const server = new McpServer({ root, transport, requestTimeoutMs: 30_000 });
```

`MCP_PROTOCOL_VERSION` still exists and is now `2025-11-25`; it is deprecated in
favour of `SUPPORTED_PROTOCOL_VERSIONS`. If you asserted its value, update the
assertion — that is the intended signal that negotiation is working.

No code changes are required for consumers that only read `.agent/` documents.

## v0.7.0

Coverage reporting and a security fix. The `.agent/` v1 schema is unchanged and
no rescan is required — this release adds a diagnostic command and fixes how
traversal attempts are classified, it does not change what is persisted.

Shipped alongside the payload work in 0.6.0; the two are documented together
below because they were measured together.

### New commands and tools

- **`agent-context detect`** — reports what the analysis could not determine:
  unresolved imports classified by cause (real gap / excluded build output /
  rejected path traversal), failed and partial parses, sensitive files skipped,
  import cycles, layering violations and modules with no resolved dependency.
  Exit `0` when nothing exceeds `info`, `1` on warnings, `2` on errors.
- **MCP tool `detect_coverage_gaps`** — the same report for agents. There are now
  fourteen tools.

### Security fix

- **A rejected path traversal is now always reported.** Unresolved imports were
  filtered by taking `lastIndexOf('.')` of the whole specifier, which points at
  the leading `..` of a relative specifier. A traversal into an extensionless
  path (`../../../etc/passwd`) was therefore classified as a non-code asset and
  dropped from `dependencies.json` entirely — the rejection was still enforced,
  but it was invisible to anyone auditing the context. The extension is now read
  from the last path segment, and escapes bypass the asset filter.

  If you built tooling that audits `dependencies.json` for traversal attempts,
  it now sees them; if you asserted the `unresolved` list was empty in a
  repository with `../..` imports, that assertion now fails correctly.

## v0.6.0

Measurable value: the "compact context" claim replaced by reproducible numbers.
The `.agent/` v1 schema is unchanged, but this release **changes what
`explain` returns** — read the behavior changes below before relying on it.

### Behavior changes

- **`explain` picks a projection based on module size.** The payload now carries
  a `detail` field (`compact` or `full`). By default, modules whose own source
  is under 8 KB get the compact projection: structure only, without the internal
  symbol dump and without the repository-wide conventions and decisions that
  merely mention them. Larger modules are unchanged. Rationale and measurements
  are in README under "Detail levels"; the short version is that a full
  explanation of a 300-byte module cost 2–9x the module, and `auto` reduces
  small-module explanations from 1.84x their source to 0.72x.
- **Pass `detail: 'full'` if you relied on `internalSymbols` for small
  modules.** It is an empty array in the compact projection. Nothing else in the
  payload is reduced: dependencies, dependents, tests, impact, public API and
  the file list are present at both levels.
- **Evidence lists are trimmed to two entries per fact** in `explain`. Every
  fact still carries evidence — it is the count that is bounded, because
  conventions and decisions are repository-wide and repeating all of them for
  every file they cite made the explanation larger than its subject. The full
  lists remain available from `get_conventions` and `get_decisions`.
- **`responsibilities` no longer restates `roles`.** `detectResponsibilities`
  emits a `role: <value> (heuristic)` line for every detected role, so the
  `module` block carried each role twice. `roles` is authoritative;
  `responsibilities` now contains only entries that add something.
- **Entry points lose their evidence in the compact projection.** They keep
  `path`, `type` and `confidence`.

### New API

```ts
await context.explain('src/payments');                            // auto
await context.explain('src/payments', { detail: 'full' });       // force full
await context.explain('src/payments', { detail: 'compact' });    // force compact
await context.explain('src/payments', { compactSourceThresholdBytes: 32_768 });

const report = await context.detect();
```

New exports: `ExplainDetail`, `COMPACT_SOURCE_THRESHOLD_BYTES`, `detectIssues`,
`DetectionReport`, `DetectedIssue`, `IssueKind`, `IssueSeverity`.
The `explain_module` MCP tool accepts a `detail` argument; the CLI accepts
`--detail auto|full|compact` and exits `2` on an unknown value.

### Benchmark

`tools/benchmark.mjs` was rewritten. It previously reported only timings and a
`compactBytes` number, which could not falsify any claim. It now reports:

- import resolution rate, with unresolved imports classified into
  `excludedOutput` (build output the config excludes — not a defect),
  `actionableUnresolved` (a real defect) and `pathEscapes` (must be zero). The
  rate is computed over resolvable imports only, so excluding `dist/` no longer
  makes a healthy repository look broken;
- cold vs warm scan with parsed/reused counts, so the incremental path is
  actually exercised;
- the token budget bucketed by module size (`under8Kb`, `from8To64Kb`,
  `over64Kb`) instead of one averaged ratio, because describing a 383 KB module
  in 16 KB and describing a 300 byte module in 1 KB are opposite results that a
  single average hides.

The default source list now includes this repository alongside the fixtures. The
fixtures are all under 4 KB and cannot demonstrate the product claim; they remain
because they are useful as regression inputs. The script also prunes
`node_modules` and `.git` from its working copy, so it neither copies hundreds of
megabytes nor depends on symlink privileges.


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
