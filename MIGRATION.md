# Migration guide

## v0.18.0

Two fixes that change what the analyzer reports about imports. **Re-scan your
repository**: imports that were previously reported as missing are now
classified correctly, and the resolution rate changes.

No configuration or schema change. Nothing needs migrating.

### Fixed: an import of an excluded file was reported as a missing import

A file can exist and still be outside the analysis — too large to read, or
forbidden by the sensitive-file policy. An import of such a file was reported
as an import of a file that does not exist.

The two mean very different things. One is a limit of the coverage; the other is
a hole in the graph. Reporting both as missing made `playwright` — which has a
generated declaration file of 1.5 MB that forty modules import — report **53.8%
import resolution and 255 unresolved imports**, and made `detect` fail with 119
errors that were not errors at all.

The resolver now knows which files were excluded and why, and reports that
distinctly:

- `unresolvedImport` entries gain a `reason`: `missing`, `excluded-file`,
  `excluded-build-output`, `path-escape` or `unresolved-alias`.
- `detect` reports a new `excluded-file` issue at `info` severity, and
  `imports.excludedFiles` counts them.
- The resolution rate excludes them, exactly as it already excluded build
  output. On `playwright` the rate goes from 53.8% to 80%, and the number of
  genuine failures from 255 to 92.

### Fixed: a path alias shadowed a package name

A tsconfig `paths` alias that matched but resolved to nothing ended the search,
so a specifier that was really a package name was never looked up as one.

TypeScript treats `paths` as one candidate among several and falls back to
node_modules when the mapping does not resolve. The same now happens here.
Without it, a monorepo that declares a wildcard alias for its own scope lost
every package of that scope — 119 imports in `playwright`, each reported as a
`detect` **error** rather than as what it is, a dependency on a package that is
not installed in a fresh clone.

### Measured

`playwright`, 2953 files: import resolution **53.8% → 80.0%**, unresolved
imports 255 → 92, `detect` errors 120 → 1. The one remaining error is a path
escape, which is a security signal and stays an error.

The oracle agrees: imports the compiler resolves and the analyzer does not went
from **40 to 0**. The oracle now applies the same exclusion rule, and verifies
each claim against the file system rather than taking it on trust — an exclusion
for a file that does not exist is still a miss.

### Not yet fixed, and recorded rather than hidden

`playwright` still reports **precision 69.8% and recall 91.1%** against the
oracle: 111 edges the analyzer draws that the oracle does not, and 25 it does
not draw that the oracle does. These are at module level, not at file level, and
they involve how aliased imports are attributed to modules. The individual
imports resolve correctly; the disagreement is in the lift from files to
modules. It is an open defect, and the numbers are published rather than
quietly excluded from the set.

---

## v0.17.0

Tooling and documentation only. No behaviour change, no rescan required, nothing
to migrate.

### The MCP server is now checked by a client that is not ours

`npm run mcp:client` drives the server with `@modelcontextprotocol/sdk`, the
reference implementation, as a real client over stdio. It runs in CI as
`mcp against a real client`.

**23 checks:** handshake, negotiated revision, tool list and schemas, six tool
calls against a real repository, the `compact`/`full` contract, argument
rejection.

**No behaviour change and no user-visible contract change.** Two of the check's
own assumptions turned out to be wrong, and both in the direction of being more
lenient than the server:

- an invalid `detail` value is rejected as a protocol error, so a client sees a
  thrown error rather than a failed tool result. That is the correct behaviour —
  returning `isError` would tell the agent the call ran and failed when it never
  ran;
- `compact` keeps the same payload shape as `full` and only drops the evidence
  (entry points carry `evidence: []`). It is a size budget, not a different
  question.

**Still unverified, and printed on every run of the check.** The reference SDK's
newest revision is `2025-11-25`, so no third-party client can exercise the modern
per-request `_meta` era yet. The shipping desktop clients listed in
`packages/mcp/README.md` are applications and cannot be launched here.

---

## v0.16.0

A parser fix that changes what the analyzer sees. **Re-scan your repository**:
the graph can gain edges it previously lost.

No configuration or schema change. Nothing needs migrating.

### Fixed: TSX lost its imports

JSX was never lexed. A `<` was treated as either a bracket or a type argument,
and in

```tsx
<AlertDialog.Trigger onClick={(e) => { f(e); }}>delete</AlertDialog.Trigger>
```

the braces are attributes rather than a block, while `/>` does not close a type
argument list. Counting them skewed the bracket balance of every statement
scanner, which ran to the end of the file and dropped the statements after it. No
diagnostic was raised: the affected files reported complete parses of the part
that had been read.

A JSX element is now skipped as a single token, the same way a template literal
is. Deciding that a `<` opens an element rather than a type argument list uses its
position — after an identifier or a closing bracket it is type arguments, in
expression position it is an element — and `=>`, `&&`, `||` and `??` were all
missing from the set of expression positions. Each one costs every file that
returns an element or renders a conditional child.

**Measured:** `radix-ui/primitives`, 686 files, **25 partial parses before, zero
after.** It is now pinned in `tools/benchmark-repos.json` and checked in CI.

### Fixed: an unbalanced `<` trapped the scan

Pre-existing, and found while looking for the above. `const v = count < limit;`
opens an angle bracket that never closes, so the `;` no longer ended the
statement and the scan ran to the end of the file — losing every import written
after it. This one is not JSX and affected ordinary TypeScript.

Openers are now tracked as a stack rather than a count, so the scanner can see
that the only thing left open is an angle bracket, which no valid TypeScript can
be across a `;`.

### Corrected: how the oracle reads a bare specifier

Two errors in `tools/ground-truth.mjs`, both found by running it against the same
repository and both cases where the analyzer was right:

- a specifier was tested against the whole string, so
  `@radix-ui/env-check/is-development` was not recognised as naming a package in
  the repository. In a monorepo that is most imports, and the analyzer was
  reported as inventing nineteen edges. The lookup is now on the package name.
- a dependency declared with the `workspace:` protocol was counted as a registry
  dependency. That protocol means the dependency *is* this repository's own
  package, and it is the one declaration that cannot mean anything else.

**No action required.** These change what the tooling reports, not what the
analyzer does.

---

## v0.15.0

A parser fix and a new field in the scan report. **Re-scan your repository:**
the graph can gain edges it previously lost.

No configuration or schema change. Nothing needs migrating.

### Fixed: a regex inside a template literal was read as a comment

Scanning over `${ ... }` inside a template literal did not know what a
JavaScript expression could contain. A bare `/` was always tested against the two
comment forms, so a regex literal ending in an escaped slash — the ordinary way
to write "replace slashes", and very common in a template literal:

```ts
dir: `/packages/${name.replace(/^@/, "").replace(/\//g, "-")}`,
```

— was read as the start of a line comment. The rest of that line was discarded,
the scan carried on past the closing brace, and every statement after it lost its
imports.

The same applied to a regex whose character class contains a comment opener —
`/[/*]/` and `/[//]/` — which the scan also consumed as a comment and which
silently swallowed the remainder of the file.

Expressing `${ ... }` as an expression is now handled by scanning it as one:
escapes, comments, strings, nested templates, numbers, identifiers and regex
literals are all recognised, and the previous token is tracked so that `/` can be
told apart from a division.

**No action required beyond re-scanning.** This was found by running the analyzer
over `changesets`, where it was the only file out of 288 that did not parse
cleanly. It is in `MIGRATION.md` rather than a patch note because a repository
can silently have been reporting fewer dependencies than it has.

### Added: `files.partial` in the scan report

`agent-context scan --json` now reports how many files the extractor only partly
understood, separately from `files.failed`:

```json
{ "files": { "total": 288, "source": 204, "tests": 84, "skipped": 0, "partial": 0, "failed": 0 } }
```

The two mean different things. A failed file produced no facts at all. A partial
file produced facts for the statements the extractor reached and dropped
everything after the point it gave up — which is why this defect was invisible
for so long: the affected repository still reported full import resolution and
no diagnostics, while holding fewer imports than it had.

**New CI gate.** The `public repositories` job now fails if any pinned
third-party repository produces a partial or failed parse, alongside the existing
checks on resolution and path traversal. Parse coverage across the set is 1246
files, 100% complete.

---

## v0.14.0

Tooling only. No behaviour change, no rescan required, nothing to migrate.

### Declared entry points are now measured

`npm run ground-truth:entry` compares the entry points an analyzer reports with
the ones its package manifests declare, read by the tool's own manifest reader.
This is a real cross-check for the declared subset: when a manifest says
`"bin": { "agent-context": "./dist/bin.js" }` then the file that command runs is
a fact, not a judgement.

**Measured:** 14 declared entry files on this repository, 82 across the pinned
public set, 48 of them in a pnpm workspace where several packages declare more
than one command. Precision 100%, recall 100% on both.

CI gains a step, and `npm run ground-truth:public` now runs both oracles per
repository.

**What is still not measured, and is now stated rather than omitted.** Entry
points found by npm script reference, naming convention or behavioural signal are
heuristics, and this project has no oracle for heuristics — a hand-labelled corpus
would measure the labeller. The tool prints this on every run instead of a
number it cannot defend, and the roadmap records it as permanently unmeasured.

### The API lock now covers types

`STABILITY.md` said every exported symbol was recorded in the lock and that a test
and a CI job fail when the real surface differs. That was true for values and not
for types: the lock came from `Object.keys(await import(entry))`, which cannot see
a type. `type Confidence` could be renamed or removed with every check green.

- The lock gains a `types` array per package: **41 in `core` as first
  implemented, 112 in fact**, 117 in `cli`, 15 in `mcp`.
- The first implementation under-counted because `export type { X } from './y'`
  produces the same alias symbol as `export { X } from './y'`, and an alias was
  being read as a value declaration. Type names are now read from the generated
  `.d.ts` through the TypeScript compiler, which also resolves the `export *`
  chains the barrel hides.

**No action required.** This adds checks; it does not change any signature.

### Two things STABILITY.md promised and did not deliver

Found by making the lock honest, not by inspection:

- **`readPersistedContext` and `contextFileNames` are now stable.** The schema
  section tells consumers to check `schemaVersion` before reading a committed
  `.agent/` directory and names these two functions for the job, while the
  checker had them on an exemption list. They are now promised and verified.
- **The exported model types are now stable**, on the same terms as the methods
  that return them: fields may be added in a minor release, and a field may be
  removed or change its meaning only in a major one. `McpServerOptions` and
  `McpTransport` were named as stable and were not visible to the checker at all,
  because it scraped identifiers out of the barrel declaration file where those
  names do not appear.

### What was not promoted

The audit for 1.0 was going to promote document builders, detectors, the
pipeline and the graph internals to stable. It did not: each is a second route to
a result `AgentContext` already returns, so promoting them would widen the
promise without adding capability. Language adapters stay unstable for the same
reason in reverse — an extension point that is promised becomes one that cannot
change.

---

## v0.13.0

A parser fix that changes what the analyzer sees. **Re-scan your repository**:
the graph can gain edges it previously lost, so anything derived from the old
scan — impact analysis, dependents, cycle detection — may change.

No configuration, schema or API change. Nothing needs migrating.

### Fixed: a nested generic discarded the rest of the file

The lexer merges `>>`, `>>>` and `>>=` into single tokens, which is correct for
real shift operators. The parser then compared token values exactly, so the two
angle brackets closing a nested generic —

```ts
const ky: Partial<Mutable<KyInstance>> = (input: Input) => createRequest(input);
```

— arrived as one token and never matched the closer. Depth never reached zero, so
the scan continued to the end of the file and returned there. **Every statement
after that annotation silently lost its imports and exports, and the parse still
reported success.**

In a barrel file that is most of the public surface. The consequences were not
cosmetic: `get_dependents`, `get_change_impact`, layering diagnostics and cycle
detection all read the graph this produced.

```ts
// Before: source/index.ts reported three internal modules.
// After:  the re-exports that followed the annotation are counted too.

export {KyError} from './errors/KyError.js';      // was missing
export {HTTPError} from './errors/HTTPError.js';  // was missing
```

The fix counts how many brackets a token carries instead of comparing its value.
`>>` closes two levels, `>>>` three. A genuine shift expression is unaffected,
because this only applies where a type argument list is being closed. Five
regression tests cover it in `packages/core/test/generics.test.ts`, including one
that asserts the parse still reports itself complete — the original failure was
silent, which is why nothing pointed at the file.

This was found by running the dependency-graph oracle against third-party
repositories instead of only this one, and it did not appear in any of the 219
tests written against fixtures that were themselves simple enough not to contain
the pattern.

### Evidence now covers other people's code

- `tools/benchmark-repos.json` pins eight third-party repositories by commit SHA.
- `npm run benchmark:public` clones, measures and deletes them.
- `npm run ground-truth:public` runs the TypeScript-compiler oracle over the
  same set.

CI gains a `public repositories` job. It runs on pushes to `master` and on a
weekly schedule, deliberately **not** on pull requests: it needs the network, and
a slow clone should not block a change that can be reviewed without it.

Result: 8/8 measured, every one at 100% import resolution, 0 path escapes, 100%
evidence coverage, deterministic, and 100% precision and recall against the
compiler wherever the repository has module edges to compare. Three of the eight
have a single module, so precision and recall are undefined there rather than
100%.

### Corrected: how a bare specifier is classified

The oracle now reads workspace membership from `workspaces` /
`pnpm-workspace.yaml` instead of treating any same-named manifest in the tree as
a workspace package, and it recognises a package importing itself by name as a
local reference. This changes what the **tooling reports**, not what the analyzer
does — the analyzer already resolved all three cases correctly.

---

## v0.12.0

An independent oracle for the dependency graph. No behaviour change, no rescan
required: nothing about the analysis or the persisted context changed.

### The headline number is now checkable

`summary.imports.resolutionRate` was produced by the analyzer describing itself.
A resolver bug and its own accuracy check can only agree with each other, so the
figure could not fail and therefore was not evidence of anything.

`tools/ground-truth.mjs` compares the graph with the answer produced by the
TypeScript compiler, which is already a dev dependency, shares no code with this
project, and resolves modules for its own reasons:

```bash
npm run ground-truth
npm run ground-truth -- --json
```

Specifiers are extracted with `ts.createSourceFile` and resolved with
`ts.resolveModuleName`. Ground truth is importer-to-imported pairs, lifted to
module edges using the analyzer's file-to-module partition — a division of the
file list, not a claim about dependencies.

### Measured

653 specifiers, 408 file-level import pairs, 18 module edges on both sides.
**Precision 100%, recall 100%**, no false positives, no false negatives. Of the
23 imports the analyzer reports as unresolved, all 23 are imports of excluded
build output and none is a miss.

A second, finer check runs on top: every import the analyzer *failed* to resolve
is put to the compiler and classified as `expectedBuildOutput`, `agreedMissing`,
or `missed`. Eighteen module edges is a coarse denominator, so a single `missed`
entry is the signal that matters.

### CI

A new job, `dependency graph vs typescript`, fails below 100% precision or
recall.

### Fixed: read-only queries wrote to the repository

`scan-pipeline.ts` documents that nothing writes to `.agent/` when `dryRun` is
set, "which is how `status` and `diff` stay side-effect free". That contract was
broken. The incremental parse cache was written regardless of the flag, so every
read-only query — `status`, `diff`, `detect`, `verify`, `explain`, `search`, and
every MCP tool — created `.agent/.local/` in a repository it had only been asked
to read.

It also made `--read-only` incomplete: the flag refused `scan()`, while
`status --read-only` still created files.

The cache is now written only when the run is not a dry run. A dry run still
*reads* the cache, so `status` and `diff` stay fast; it simply stops growing it.
`scan()` is unaffected and still populates the cache, which the incremental path
depends on.

Found while building the oracle above: the fixture repositories had accumulated
`.agent/` directories, because pointing any read-only tool at a fixture wrote
into it. `createTempRepo` now strips `.agent/` when copying a fixture, so a test
can never pass against context it did not produce.

### Limits

One real repository and five synthetic fixtures, all small. The compiler is an
oracle for module resolution only — it says nothing about entry points, roles,
conventions or decisions — and it applies its own resolution rules rather than the
analyzer's configuration. Entry-point precision and recall remain unmeasured
because no independent oracle exists for them.


## v0.11.0

The first v1.0 work: the API stability promise, written down and enforced. No
behaviour change and no rescan required.

### The public API is now locked

Every symbol each package exports is recorded in
`packages/core/test/public-api.lock.json`, `packages/cli/test/public-api.lock.json`
and `packages/mcp/test/public-api.lock.json`. A test in the suite and a dedicated
CI job (`api surface`) fail when the real exports differ from the lock.

The lock covers all 384 exported symbols across the three packages, including the
ones that are explicitly *not* promised. That is deliberate: a symbol can only be
governed once it is known to exist, and an accidental export should show up in a
diff rather than disappear silently.

```bash
npm run api:check     # fails when the surface drifted
npm run api:lock      # rewrite the locks after an intentional change
```

`npm run verify` now runs `api:check`, so a drift cannot reach master.

### STABILITY.md

States which symbols are a compatibility promise and which are internal. The
promise is narrow on purpose: `AgentContext`, the configuration and policy
surface, the error types, the schema constants, the MCP server and protocol
negotiation helpers, the tool definitions and the client presets. The pipeline,
the language adapters, the graph internals, the document builders and the
detectors are exported because they are convenient to test and extend, not
because they are supported — they may change in a minor release.

It also states the semver rules (a change to what an existing field *means* is a
major release even when no type moved), the four-step deprecation process with a
two-minor window, and the `.agent/` schema compatibility policy.

### The document is checked too

`tools/check-stability.mjs` verifies that every symbol `STABILITY.md` names is
actually exported, and `npm run verify` runs it. It caught a wrong name on its
first execution — the document had claimed `detectRoles`, which does not exist.
Documentation that is not compiled drifts; this is the cheapest guard against
that.

### Node.js compatibility matrix

Written down in the README instead of being implied by CI: the two different
floors (published packages from 20.11, this repository's test suite from 22.18),
and why they differ.

### The `publish dry run` CI job passes

It had been failing since before 0.8. `npm pack --pack-destination` does not
create the directory, and the job wrote to `/tmp/pack` on a fresh runner, so
every pack failed with ENOENT. The job that exists to prove all three packages
are packable had never done so.


## v0.10.1

Request timeouts were silently disabled, and a release-order footgun was
removed. No schema change and no rescan required.

### Fixed: the request timeout never fired

The timeout timer was created with `unref()`. That timer is the only thing
holding the Node event loop while a request is outstanding, so unref'ing it let
the process exit with the request still pending — which means the timeout could
never fire in exactly the situation it exists for: a handler that never settles.

Observed on Node 22.18 as `Promise resolution is still pending but the event
loop has already resolved`. Node 24 happened to keep the loop alive through the
test runner, so the defect was invisible there; CI caught it on the 22.18 matrix
entries only.

`notifications/cancelled` is unaffected — it releases the waiter through a
promise, not a timer — so a cancelled request still receives no response.

### Fixed: `npm run smoke` reported one root cause as eighteen failures

When the packed CLI tarball could not be installed, the script recorded the
failure and kept going. Every remaining check runs a binary out of
`node_modules`, so the rest failed with identical `MODULE_NOT_FOUND` errors that
said nothing about the real problem.

It now stops at the failed install and distinguishes the common case — the
`@ai-agent-context/core` version in the workspace has not been published yet —
from a genuine packaging defect, and prints the fix.

### Fixed: the documented release order

`CONTRIBUTING.md` told you to commit before publishing. Because `smoke` installs
the packed tarball into a clean project, which resolves the core dependency from
the registry, pushing a version bump before that version exists on npm fails the
`packaged-smoke` CI job on every supported Node. The order is now publish, then
commit, then push, with the reason stated.


## v0.10.0

Trust metrics. No API change, no behaviour change, no rescan required: this
release measures two things the roadmap had been claiming were measurable and
were not.

### Evidence coverage

`tools/benchmark.mjs` now walks the documents the analyzer produced and counts
every object carrying a numeric `confidence` — exactly the shape used for a
heuristic — then reports how many of them cite at least one piece of evidence.

Structural facts (module ids, paths, import specifiers) carry no `confidence` and
are deliberately not counted. A repository with no heuristics reports `null`
rather than `100%`: there was nothing to explain, and a perfect score would
claim otherwise.

Current measurement across this repository and the five fixtures: **363
judgements, 363 with evidence, 0 without — 100%**.

### Determinism

The benchmark now scans each tree twice more with the cache bypassed and
compares a hash of the generated documents byte for byte. Because `force: true`
re-reads every file, a difference can only come from the analyzer and never from
what it happened to reuse.

Current measurement: **0 non-deterministic repositories**.

### CI

The `benchmark` job fails when any judgement lacks evidence, or when any
repository produced non-deterministic context.

### Roadmap

The "Roadmap metrics" section now marks every metric as measured or not
measured. Two entries — evidence coverage and determinism — became measured in
this release. One, entry-point and dependency precision/recall, is still not
measured and is now labelled as such: it needs a labelled corpus that does not
exist yet.

`benchmark-report.json` gains `summary.trust` and `row.trust`. Nothing reads
those fields except CI and a human, so a consumer of the report is unaffected.


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