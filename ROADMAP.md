# Roadmap

## Purpose of this document

This document describes the intended evolution of `ai-agent-context` — a local,
Git-native context layer for AI coding agents. It is not a binding schedule:
priorities may change in response to user research, benchmark results and
feedback.

## Product goal

Give a coding agent, before it changes any code, a compact, checkable and
versionable map of the repository:

- module architecture and responsibilities;
- internal and external dependencies;
- entry points and public API;
- conventions and architectural decisions;
- change history and the potential impact of a change.

The principles the product is built on:

- **Local-first** — source code does not leave the machine without an explicit
  user action.
- **Deterministic** — the same repository state produces the same context.
- **Evidence-based** — conclusions carry their source and a confidence level.
- **Agent-oriented** — context is selected for a task and a token budget.
- **Git-native** — both the current state and the history are taken into account.
- **Incremental** — a re-analysis does not re-read unchanged files.
- **Safe by default** — path traversal, symlinks and sensitive files are handled
  explicitly.

## Current baseline

Current package version: `0.10.1`.

Implemented:

- a scanner core with no runtime dependencies;
- CLI: `init`, `scan`, `status`, `explain`, `context`, `task`, `impact`,
  `search`, `diff`, `detect`, `history`, `revision-diff`, `verify`, `migrate`,
  `clean`;
- MCP stdio server: 14 tools, Resources, Prompts, strict argument validation;
- dual-era MCP: five protocol revisions, negotiation, `server/discover`,
  cancellation, timeouts, an error taxonomy, and configuration presets for four
  clients;
- incremental scanning and a content-addressed parse cache;
- a knowledge graph with module detection, entry points, cycles and layering
  diagnostics;
- dependency, convention and decision detection with confidence and evidence;
- temporal context: `getModuleHistory`, `getRevisionDiff`, `getRevisionSnapshot`;
- directory-scoped `explain`/`impact` instead of a silent widening to the parent
  module;
- budget-aware `explain`: the `compact`/`full` projection is chosen by module size;
- path traversal rejected rather than collapsed, and always reported;
- git activity signals, deterministic `.agent/` serialization, secret filtering;
- npm workspaces support;
- `agent-context detect` and the `detect_coverage_gaps` MCP tool: what the
  analysis could **not** determine;
- a benchmark that measures import resolution rate and token budget per size
  bucket;
- evidence coverage and determinism, both measured and gated in CI;
- an organization-owned policy (`.agent-policy.json`) that can only tighten a
  repository's own settings;
- a read-only contract: `security.readOnly` and `--read-only`, enforced in the
  `AgentContext` facade;
- `agent-context migrate` and a reusable CI workflow for drift detection.

Still open, and not closable by code:

- a verified integration with three real MCP clients;
- an opt-in survey of real users.

## Priorities

- **P0** — measurable value and trust in the numbers. Quality metrics are
  published and reproducible.
- **P1** — relevance of context to the task at hand.
- **P2** — temporal context, mature MCP, enterprise controls.
- **P3** — ecosystem and integrations, after confirmed demand.

**Priority rule.** No new analyzer ships until it has a measurable baseline and
regression coverage on real code. Extending a broken dependency graph makes the
product worse rather than bigger: v0.5 started by fixing the resolver, not by
adding features.

---

## v0.3 — Agent-ready context (completed)

**Goal:** turn the full repository context into a compact one an AI agent can
use effectively for a specific task.

**Implemented:**

- `getTaskContext(task, options)` with a bounded `maxModules` and optional
  `target`;
- `getChangeImpact(target, options)` with a bounded `maxFiles`;
- the CLI commands `task` and `impact`;
- the MCP tools `get_context_for_task` and `get_change_impact`;
- evidence for the selected modules and impact slices;
- regression coverage in the CLI/MCP integration tests.

**Done criteria:**

- an agent gets relevant context without manually reading a large number of
  files;
- the user can bound how much context is returned;
- every new conclusion is explainable through evidence;
- the `init → scan → explain → diff` flow works end to end.

---

## v0.4 — Structural intelligence (completed)

**Goal:** improve the accuracy of TypeScript/JavaScript structural analysis.

**Implemented:**

- extended extraction for re-exports, aliases, barrel files and conditional
  exports;
- entry-point detection including package exports, CLI bin and HTTP routes;
- `test → module` and `entry point → module` relations;
- import cycle diagnostics;
- layering violations with confidence and evidence;
- a deterministic import resolver (`..` correctness was fixed in v0.5).

**Done criteria:**

- false positives on dynamic imports and barrel files do not regress;
- impact analysis returns verifiable evidence paths;
- the release passes the full verify pipeline.

---

## v0.5 — Graph correctness (completed)

**Goal:** make the dependency graph usable for decisions rather than for display.

This release re-prioritized. An audit on a real repository showed the resolver
did not collapse `..`: 222 of 250 relative imports landed in `unresolved`, and
with them `get_dependents`, `get_change_impact` and the layering diagnostics
emptied out. None of the 103 existing tests caught it — the fixtures contained
not a single import with `..`.

**Implemented:**

- `..` collapsing in `normalizeRelative`, making it impossible to mask a
  traversal as a valid in-repo path;
- `escapesRoot`/`joinStrict` — an explicit refusal instead of silent collapsing;
- directory-scoped `explain`/`impact` with a `scope` field;
- Node built-ins ranked below declared packages;
- regression suite: `resolver.test.ts`, `explain.test.ts`;
- `tools/set-version.mjs` as the single source of version;
- CI on Node 20/22/24 across Linux, Windows and macOS;
- `CONTRIBUTING.md`.

**Measured on this repository:**

| Metric | Before | After |
| --- | --- | --- |
| Unresolved imports | 222 | 16 (all `dist/`, excluded by default) |
| Module edges | 18 | 49 |
| Relative-import recall | 45.5% | 93.6% |
| Tests | 103 | 131 |

**Done criteria:**

- relative imports that climb the tree resolve;
- traversal is refused with a comprehensible diagnostic;
- `explain`/`impact` never widen silently to the parent module;
- every item is covered by a test that would have failed before the fix.

---

## v0.6 — Measurable value (completed)

**Goal:** replace the "compact context" slogan with reproducible numbers.

Reason for the delay: while half the dependency graph was empty, any comparison
of context volume would have been noise against noise.

**Implemented:**

- `tools/benchmark.mjs` rewritten: instead of timings it measures import
  resolution rate (classifying unresolved imports as `excludedOutput` /
  `actionable` / `pathEscapes`), cold vs warm scan with parsed/reused counts, and
  token budget per module-size bucket;
- budget-aware `explain`: the `compact`/`full` projection by module size, plus an
  explicit `detail` in the CLI and over MCP;
- payload deduplication: `responsibilities` no longer restates `roles`, and
  evidence is capped at two entries per fact;
- `agent-context detect` and the MCP `detect_coverage_gaps` — what the analyzer
  did not determine, ranked by severity;
- a security bug fixed: a rejected path traversal disappeared from
  `dependencies.json` because unresolved imports were classified by the whole
  specifier rather than by the last path segment;
- this repository added to the benchmark set, because the fixtures are under
  4 KB and cannot test the product claim.

**Measured results:**

| Metric | Value |
| --- | --- |
| Import resolution rate (resolvable) | 100% |
| Actionable unresolved | 0 |
| Path escapes | 0 |
| Modules >64 KB: `explain` against source | 0.042x (−95.8%) |
| Modules 8–64 KB | 0.343x (−65.7%) |
| Modules <8 KB, `auto` | 0.72x (was 1.84x with `full`) |
| Tests | 150 |

**Honest caveat, recorded in the benchmark:** on modules under 4 KB the product
is still more expensive than reading the source (2.07x on the fixtures). This is
not hidden by averaging — the buckets exist precisely so the result is visible.

**Done criteria:**

- import resolution rate is measurable and published;
- the token-budget benchmark shows a win over naive reading on large modules;
- the incremental path is exercised in the benchmark (cold/warm with
  parsed/reused);
- the benchmark is reproducible with one command, runs in CI and is published as
  an artifact;
- a user can find out where the analysis is incomplete.

**Left for later:**

- entry-point precision/recall on a labelled set;
- a public set of real repositories instead of only our own.

---

## v0.8 — MCP production readiness (completed, shipped as 0.8.0)

**Goal:** make the MCP package reliable and usable with real clients.

**The problem this release solved.** The server pinned one protocol revision —
`2024-11-05` — and answered every `initialize` with it. A client asking for
`2025-06-18` was told to move to a revision it had not requested, which the
specification requires it to answer by disconnecting. Compatibility with real
clients was decided by the age of the file rather than by the code.

**Implemented**

- **Dual-era server.** Five revisions: legacy (`2024-11-05`, `2025-03-26`,
  `2025-06-18`, `2025-11-25`) and modern (`2026-07-28`). The era is chosen by how
  the client opens: a request carrying `_meta` is served statelessly, while
  `initialize` selects legacy semantics.
- **Legacy negotiation.** `initialize` answers with the requested revision; an
  unknown, absent or modern value is answered with the newest legacy revision
  (`2025-11-25`).
- **`server/discover`**, which the specification requires of a modern server;
  it reports `supportedVersions`, capabilities and server identity.
- **Per-request modern validation.** An unsupported revision is refused with
  `-32022` and the list to retry with; a missing required
  `io.modelcontextprotocol/clientCapabilities` with `-32602`; modern results
  carry `resultType`.
- **Cancellation.** `notifications/cancelled` suppresses the response, including
  the timeout response that would otherwise have followed it.
- **Timeouts.** `requestTimeoutMs` (default 120000, `0` disables it); an expired
  request answers `-32603` with `data.timeoutMs`, and the late result is
  discarded.
- **Error taxonomy.** A message without a `method` answers `-32600` rather than
  `-32601`. The reserved `-32002` is never emitted.
- **Configuration presets** for Claude Code, Cursor, Cline and Continue:
  `agent-context-mcp config <client>`, plus `--list` and `--all`.
- **Real-process tests.** Sessions of both eras, garbage input, cancellation and
  timeouts are exercised through an actual stdio process rather than an in-memory
  transport, because "diagnostics stay off stdout" is otherwise not provable.

**Done criteria**

- **met:** malformed requests do not corrupt the protocol — covered by a garbage
  input test asserting the stdout channel stays parseable;
- **met:** the stdout/stdin transport stays clean — covered by a test against a
  real process;
- **met:** a compatibility matrix of clients and protocol revisions is published
  in `packages/mcp/README.md`;
- **not met:** a verified integration with at least three real MCP clients. The
  presets encode each client's documented configuration format, but none was
  launched in this environment. The criterion stays open deliberately: only an
  installed client can confirm it.

The optional remote transport is deferred until demand is confirmed, as planned.

---

## v0.9 — Enterprise controls (completed, shipped as 0.9.0)

**Goal:** prepare the product for organizations that require controls and
reproducibility.

**The problem this release solved.** A repository is configured by a file its
contributors write. Nothing stopped a contributor from setting
`security.allowSensitiveFiles: true` or dropping a directory from `exclude`, and
thereby weakening rules the organization treats as mandatory. The set of
guarantees (secret filtering, symlink policy, path traversal rejection,
`verify`, deterministic output) existed, but without enforcement: it described
how the tool behaves, not a rule that could not be worked around.

**Implemented**

- **Organization-owned policy.** `.agent-policy.json` is looked up in the
  repository root and in any parent directory, so one file at a monorepo or
  organization checkout applies to everything beneath it;
  `AGENT_CONTEXT_POLICY` overrides the search. The policy is a **floor**, not a
  replacement: patterns are unioned with the repository's rather than replacing
  them.
- **A policy can only tighten.** `allowSensitiveFiles: false` forces the escape
  hatch off, `redactSecrets: true` forces redaction on, `readOnly: true` forces
  read-only on. No repository setting or CLI flag can undo any of them.
- **Two documents are refused rather than ignored:** an unknown `version`, and
  `redactSecrets: false`. A policy that silently failed to apply is
  indistinguishable from no policy at all; and disabling redaction copies secret
  material into a file people commit and share.
- **Read-only contract.** `security.readOnly` and the `--read-only` flag refuse
  every write and leave every query working. The guard lives in the
  `AgentContext` facade rather than in individual commands, so neither an MCP
  tool handler nor an embedder calling `scan()` directly can get around it. Only
  `scan()` and `init()` write.
- **A policy change invalidates the cache**, so context built under weaker rules
  is never reused after the rules tighten.
- **`agent-context migrate`** brings a committed `.agent/` up to the current
  schema; `--check` writes nothing and exits `1`, which makes it a CI gate.
  States: `current`, `stale`, `missing`, `invalid`.
- **A ready CI workflow:** `.github/workflows/reusable-verify-context.yml`,
  callable from another repository through `uses:`.
- **The threat model is extended** to cover the repository's own configuration,
  and `SECURITY.md` gains five audit steps.

**Done criteria**

- **met:** no access to files outside the repository root — covered by tests;
- **met:** context can be generated safely in CI — read-only mode makes a write
  impossible from a process that only intends to read;
- **met:** a schema change is detected by an explicit error or a migration —
  `migrate --check` plus an explicit refusal to read a document of an unknown
  version;
- **met:** security-sensitive scenarios have dedicated tests — 27 tests covering
  policy and read-only, including a repository attempting to disable read-only
  and an attempt to disable redaction through a policy.

---

## v0.10 — Trust metrics (completed, shipped as 0.10.0)

**Goal:** measure what the roadmap claimed was measurable and was not.

**The problem this release solved.** The metrics section listed evidence
coverage and determinism as CI-measurable. Neither was measured: the benchmark
reported resolution rate, timings and token budget, and the metrics section read
like a report of work already done.

**Implemented**

- **Evidence coverage.** The benchmark walks the documents the analyzer produced
  and counts objects carrying a numeric `confidence` — exactly the shape used
  for a heuristic — then reports how many cite at least one source. Structural
  facts (module ids, paths, import specifiers) carry no confidence and are
  deliberately excluded. A repository with no heuristics reports `null` rather
  than `100%`, because a perfect score would claim something was explained when
  there was nothing to explain.
- **Determinism.** Each tree is scanned twice more with the cache bypassed and a
  hash of the generated documents is compared byte for byte. Because `force:
  true` re-reads every file, a difference can only come from the analyzer rather
  than from what it happened to reuse.
- **CI gates** on both: a judgement without evidence, or a non-deterministic
  repository, fails the build.

**Measured:** across this repository and the five fixtures, 363 judgements, 363
with evidence, 0 without; 0 non-deterministic repositories.

The metrics section now marks every entry as measured or not measured. Evidence
coverage and determinism became measured in this release; entry-point and
dependency precision/recall became measured in 0.12.0. At the time this was
written it was not, and claiming it in a metrics table is how a roadmap starts
lying to its readers.

---

## v0.10.1 — Timeout correctness and release order (completed, shipped as 0.10.1)

**The problem this release solved.** The request timeout timer was created with
`unref()`. That timer is the only thing holding the Node event loop while a
request is outstanding, so unref'ing it let the process exit with the request
still pending — which means the timeout could never fire in exactly the situation
it exists for: a handler that never settles. Node 22.18 reports it as `Promise
resolution is still pending but the event loop has already resolved`; Node 24
happens to keep the loop alive through the test runner, so the defect was
invisible there. Only the 22.18 matrix entries caught it, which is the argument
for running the matrix instead of the newest Node alone.

Two related problems were fixed at the same time:

- `npm run smoke` recorded a failed tarball install and carried on, so one root
  cause produced eighteen `MODULE_NOT_FOUND` failures that said nothing about the
  real problem. It now stops at the install and separates "core is not published
  yet" from a genuine packaging defect.
- `CONTRIBUTING.md` documented committing before publishing. Because `smoke`
  installs the packed tarball into a clean project, which resolves the core
  dependency from the registry, pushing a version bump before that version exists
  on npm fails the `packaged-smoke` job on every supported Node. The order is now
  publish, commit, push, with the reason stated.

---

## v0.12.0 — An oracle for the graph (in progress)

**Goal:** stop the analyzer from grading its own homework.

**The problem this release solved.** `summary.imports.resolutionRate` is the
product's headline number, and the analyzer produced it by describing itself. A
resolver bug and its own accuracy check can only ever agree with each other, so
the figure could not fail and therefore could not be evidence of anything. The
metrics table had been listing precision and recall as measurable since v0.6
without anything measuring them.

**Implemented**

- **`tools/ground-truth.mjs`** compares the dependency graph with the answer
  produced by the TypeScript compiler, which is already a dev dependency, shares
  no code with this project, and resolves modules for its own reasons.
  Specifiers are extracted with `ts.createSourceFile` and resolved with
  `ts.resolveModuleName`.
- **A file-level cross-check** on top of the module-level comparison. Eighteen
  module edges is a coarse denominator, so every import the analyzer *failed* to
  resolve is also put to the compiler and classified as `expectedBuildOutput`,
  `agreedMissing`, or `missed`. A single `missed` entry means the headline
  resolution rate is overstated.
- **CI gate** `dependency graph vs typescript`, failing below 100% precision or
  recall. `npm run ground-truth` runs it locally; `--json` emits the payload.

**Measured:** 653 specifiers, 408 file-level import pairs, 18 module edges on
both sides. Precision 100%, recall 100%, 0 false positives, 0 false negatives. Of
23 unresolved imports reported by the analyzer, all 23 are imports of excluded
build output and none is a miss.

**Three defects the work surfaced in the measurement itself**, each fixed before
the numbers were published:

- The first comparison reported 85.7% recall, because the module partition was
  built from `fileImports` — which lists only files that *have* imports. Edges
  ending at an import-free file were being dropped, which looks exactly like an
  analyzer miss. The partition now comes from the module list.
- The repository's own root manifest claimed every file, so the "which workspace
  package owns this path" lookup fabricated edges on the root package. It now
  takes the deepest match and ignores the root.
- Tests importing `../core/dist/index.js` were counted as dependencies on the
  package. Build output is excluded by design, and an edge derived from it would
  make the graph depend on whether the project happened to be built. These are
  now reported as `excludedBuildOutput`, which is what the analyzer already calls
  them.

**A real defect the work exposed.** Pointing the oracle at the fixture
repositories revealed that they had accumulated `.agent/` directories: every
read-only query wrote a parse cache into the repository it had only been asked to
read, contradicting the pipeline's own documented contract and leaving
`--read-only` incomplete, since it refused `scan()` while `status --read-only`
still created files. The cache is now written only on a non-dry run; a dry run
still reads it, so `status` and `diff` stay fast. `createTempRepo` now strips
`.agent/` when copying a fixture, so a test can never pass against context it did
not produce. Five regression tests cover the contract.

**Known limits, stated because the numbers are perfect and perfect numbers
deserve suspicion.** One real repository and five synthetic fixtures, all small.
The compiler is an oracle for module resolution only: it says nothing about entry
points, roles, conventions or decisions. It also applies its own resolution rules
rather than the analyzer's configuration, so agreement is evidence about the
resolver, not a certificate for the whole product. Entry-point precision and
recall remain unmeasured, because no independent oracle exists for them.

---

## v0.13.0 — Evidence on other people's code (in progress)

**Goal:** stop measuring ourselves on the one codebase we wrote the analyzer
for.

**The problem this release solved.** Every measurement so far — benchmark,
oracle, determinism, evidence coverage — ran against this repository and five
synthetic fixtures. All of it is a repository whose conventions the analyzer was
built around, so a defect that only exists in other people's code passes all of
it without raising anything.

**Implemented**

- **`tools/benchmark-repos.json`** pins eight third-party repositories by commit
  SHA, chosen for a spread of sizes, eras and layouts: `clsx` (single file),
  `p-map`, `ansi-styles` (CommonJS), `ky`, `ora`, `execa`, `got` (modern
  TypeScript, the largest) and `changesets` (a pnpm workspace, so cross-package
  resolution is measured on a layout that is not ours). A SHA rather than a branch
  is the whole point: a moving target would make every run incomparable with the
  last, which is measuring a moving specifier.
- **`node tools/benchmark.mjs --public`** clones each one into a temporary
  directory, measures it, and deletes it. Nothing is vendored. Results are
  reported under a separate `public` key rather than merged into the headline
  totals, so the numbers do not quietly change meaning depending on whether the
  network was available.
- **`tools/ground-truth-public.mjs`** runs the TypeScript-compiler oracle over
  the same set, so the resolver is checked on foreign code rather than asserted.
- **CI job `public repositories`**, on pushes to `master` and on a weekly
  schedule but not on pull requests: a slow or unreachable clone should not block
  a change that can be reviewed without it. It fails if any pinned repository was
  not measured — measuring less than it claims, while going green, is the worst
  outcome available.

**Measured:** eight of eight cloned and measured. Every one at 100% import
resolution, 0 path escapes, 100% evidence coverage, deterministic output, and
100% precision and recall against the compiler where the repository has module
edges to compare. 1298 files across the set. The token-budget claim holds on
foreign code: modules over 64 KB cost 2.2%–11.1% of source bytes.

**Two real defects the work surfaced**, both found by the oracle disagreeing with
the compiler on a repository neither of us wrote:

- **The parser silently discarded most of a barrel file.** The lexer merges
  `>>`, `>>>` and `>>=` into single tokens, which is correct for shift operators,
  so the two angle brackets closing `Partial<Mutable<T>>` arrived as one token.
  `skipBalanced` compared token values exactly, never reached depth zero, scanned
  to the end of the file and returned there — so **every statement after that
  annotation lost its imports and exports, and the parse still reported
  success.** In `ky/source/index.ts` that removed seven re-exports and one module
  edge. `get_dependents`, `get_change_impact`, layering diagnostics and cycle
  detection all read that graph. Fixed by counting the brackets a token carries
  rather than comparing its value; five regression tests in
  `packages/core/test/generics.test.ts`.
- **The oracle counted a published dependency as a source dependency.** A bare
  specifier naming any package manifest in the tree was treated as an in-repo
  workspace edge. `clsx` keeps a `bench/` directory that pins `clsx@1.1.0` next to
  the `clsx` sources on purpose, to compare against the released build; the oracle
  called that an edge to the local module and reported a false negative against an
  analyzer that was right. Membership is now read from `workspaces` /
  `pnpm-workspace.yaml`, with a separate rule for a package importing itself by
  name — which is what `ky`'s own type tests do, and which is a real dependency on
  the local entry point.

**Known limits, restated because the numbers are again perfect.** Three of the
eight repositories have a single module, so precision and recall are undefined
there rather than 100%; the public set covers resolution and determinism well and
architectural inference barely. Entry-point precision and recall remain
unmeasured: the compiler is an oracle for module resolution only, and nothing
independent exists for the others.

---

## v0.14.0 — Measuring what is a fact (in progress)

**Goal:** stop calling heuristics metrics.

**The problem this release solved.** The metrics table listed "entry-point and
dependency precision/recall" as one row with one verdict. Only half of it had
ever been measured. The other half — entry points — had been marked "not
measured" since v0.6 and stayed that way, which is indistinguishable from
neglect.

**Implemented**

- **`tools/ground-truth-entry.mjs`** compares declared entry points with the
  manifests that declare them, using its own manifest reader. Where
  `tools/ground-truth.mjs` asks the TypeScript compiler, this asks `package.json`.
- Two oracles now run per pinned repository in `ground-truth-public.mjs`, and a
  CI step for the local one.

**Measured:** 14 declared entry files on this repository, 82 across the pinned
set, 48 of them in a pnpm workspace where several packages declare more than one
command. Precision 100%, recall 100% everywhere.

**The part that is still not measured, and will not be.** Entry points found by
npm script reference, by naming convention, or by behavioural signal are
heuristics. A hand-labelled corpus would measure whoever labelled it, and a
second heuristic written independently would measure itself. The tool prints
this as a limitation on every run rather than reporting a number it cannot
defend, and the metrics table records it as permanently unmeasured.

**The API lock did not cover half of what it claimed.** `STABILITY.md` said every
exported symbol of every package was recorded in the lock and that a test and a CI
job fail when the real surface differs. The lock was built from
`Object.keys(await import(entry))`, which sees values at runtime and cannot see a
type: `type Confidence` could be renamed or removed and every check stayed green
while the package broke every consumer that used it. Type exports are now read
from the generated `.d.ts` through the TypeScript compiler, which also resolves
the `export *` chains that a regular expression would miss.

That count is not a detail. The first implementation reported 41 type exports in
`core`; the correct answer is **112**. The filtering bug was that
`export type { X } from './y'` produces the same alias symbol as
`export { X } from './y'`, and an alias was being read as "this is a value".

Making the lock honest immediately exposed two more things:

- **`STABILITY.md` promised `McpServerOptions` and `McpTransport`, which are
  exported as types.** They had been invisible to the checker, which scraped
  identifiers out of the barrel declaration file — and those names live in
  `dist/server.d.ts`, not in `dist/index.d.ts`.
- **`readPersistedContext` and `contextFileNames` were in the checker's exclusion
  list**, so the document pointed readers at them while promising nothing about
  them. The schema section said to check the version before reading a committed
  `.agent/` directory and named the two functions for the job. They are now
  stable, and the exported model types are promised on the same terms as the
  methods that return them.

**What was not promoted, and why.** The audit was supposed to promote a few
internal exports. It did not, because everything they offer is a second route to
a result the facade already returns: the document builders duplicate
`getArchitecture()`, the detectors duplicate fields on `getRepository()`, the
pipeline duplicates `load()` plus `scan()`, and the graph internals duplicate
`getDependencies()` and `getChangeImpact()`. Promoting them would widen the
promise without adding capability. Language adapters are the deliberate exception
in the other direction — an extension point that is promised becomes an
extension point that cannot change, so supporting a second language remains a
fork and `STABILITY.md` says so.

Two scope rules are declared rather than assumed: `types` fields and wildcard
exports are excluded, because the analyzer deliberately does not report either
as a runtime entry point, and measuring them would report a decision as an
accuracy.

---

## v0.15.0 — Parsing what real code contains (in progress)

**Goal:** stop guessing at what "supported TypeScript/JavaScript" means.

**The problem this release solved.** v0.13.0 introduced the public repository set
and immediately found a parser defect on it. The obvious next step was to check
the other thing those measurements had never checked: whether the extractor
actually understands the code. Every repository was scanned and one file in
`changesets` — one of 288 — came out `partial`, meaning the extractor gave up
partway through and dropped the statements after that point.

**Implemented**

- **Expressions inside `${ ... }` are scanned as expressions.** Previously a bare
  `/` was always tested against the two comment forms, so a regex literal ending
  in an escaped slash — the ordinary way to write "replace slashes", and very
  common in a template literal — was read as the start of a line comment. The
  rest of that line was discarded and the scan carried on past the closing
  brace. The same applied to a regex whose character class contains a comment
  opener, `[/*]` and `[//]`, which silently swallowed the remainder of the file.
  Escapes, comments, strings, nested templates, numbers, identifiers and regex
  literals are now all recognised, and the previous token is tracked so `/` can
  be told apart from a division.
- **`files.partial` in the scan report**, separate from `files.failed`. A failed
  file produced no facts; a partial file produced facts for the statements before
  the point the extractor gave up. That distinction is the whole reason this
  defect survived: the repository reported full resolution, no diagnostics and a
  clean `detect`, while holding fewer imports than it contained.
- **A CI gate on parse coverage.** The `public repositories` job fails on any
  partial or failed parse among the pinned repositories, next to the existing
  resolution and path-traversal checks.

**Measured:** 1246 files across the eight pinned repositories, **100% parse
coverage** — zero partial, zero failed. Before this release `changesets` had one.

**What was nearly missed, and is worth writing down.** The first investigation
checked whether the imports in the affected file were recorded. They were, because
the file's only import sat at the top, above the construct. A test written that way
passes with the defect present. `parseStatus` is not a reliable signal either: a
scan that swallows the rest of a file still reports `ok`. The only position that
discriminates is an import written *after* the construct — which is now what every
case in `packages/core/test/template-literals.test.ts` checks. The tests were
verified to fail against the unfixed lexer before being accepted.

**Known limits, unchanged.** Parse coverage is complete on the pinned set, which
is eight TypeScript and JavaScript repositories. There is no pinned repository
containing TSX, decorators or a class-heavy codebase, so "supported" is still
established on a sample rather than on a specification. That is the next thing to
change, and changing it means choosing repositories for the syntax they contain
rather than for their popularity.

---

## v0.16.0 — TSX, and repositories chosen for what they contain (in progress)

**Goal:** stop treating "supported TypeScript/JavaScript" as a sample.

**The problem this release solved.** v0.15.0 stated that the pinned set contained
no TSX, no decorators and no class-heavy codebase, so the word "supported" rested
on eight repositories chosen for being popular and small. Choosing the next one
for the *syntax it contains* rather than for its reputation is what turned up the
largest gap in the analyzer so far.

**Implemented**

- **A JSX element is lexed as one token**, the same way a template literal is, so
  the bracket balance never sees its interior. Previously a `<` was either a
  bracket or a type argument, and in `<Trigger onClick={(e) => f(e)} />` the
  braces are attributes rather than a block while `/>` does not close a type
  argument list. Counting them skewed every statement scanner, which ran to the
  end of the file and dropped the statements after it.
- **`=>`, `&&`, `||` and `??` are recognised as expression positions.** The set
  that decides "is a `<` an element or a type argument" — and "is a `/` a regex or
  a division" — was missing all four. Each one costs every file that returns an
  element or renders a conditional child: `render={() => <div />}`, `{ok && <Error />}`
  are the ordinary shapes.
- **A JSX element inside an expression.** `{cond ? <A /> : <B />}` nests the same
  problem one level down, inside the balanced scan of `{ ... }`.
- **Fragments.** `<>` has no tag name, so what follows it is children rather than
  attributes. Treating that region as attributes consumed the first child and, if
  it was self-closing, ended the fragment one element too early.
- **An unbalanced `<` no longer traps the scan.** A related defect the TSX work
  exposed, and pre-existing: `const v = count < limit;` opens an angle bracket
  that never closes, so a `;` no longer ended the statement and the scan ran to
  the end of the file. The openers are now tracked as a stack, so the case is
  visible as "only angle brackets are open", which no valid TypeScript can be
  across a `;`.
- **`radix-ui/primitives` added to the pinned set**, pinned by commit SHA. It is
  TSX at scale and a pnpm workspace where dozens of packages import each other by
  subpath — the repository that found the gaps above.

**Measured:** `radix-ui/primitives`, 686 files — **25 partial parses before,
zero after.** Across the whole pinned set, 1932 files, 100% parse coverage, and
100% precision and recall against the compiler on both oracles.

**Two defects in the oracle, found by the same repository.** The analyzer was
right and the measurement was wrong, twice:

- A bare specifier was tested against the whole string, so `@radix-ui/env-check/is-development`
  was not recognised as naming a package in the repository and was counted as an
  external dependency. In a monorepo that is most of them, and the analyzer was
  reported as inventing nineteen edges for dependencies the manifests declared
  plainly. The lookup is now on the package name, without any subpath.
- A dependency declared with the `workspace:` protocol was counted as a registry
  dependency. That protocol is the one declaration that cannot mean anything else,
  and trusting it also covers a case no glob can: in a pnpm workspace a package
  can be depended on by name while matching no `packages/*` pattern at all.

**Known limits, restated because the set now contains TSX.** TSX is covered;
decorators, class-heavy code, and `.vue`/`.svelte` are not, and no repository in
the set contains them. Choosing the next set members by the syntax they contain
is the standing method, not a one-off.

---

## v1.0 — Stable repository intelligence (in progress)

**Goal:** a stable release with a proven API, mature integrations and
measurable value for teams.

### Progress so far

| Component | Status |
| --- | --- |
| Stable semver API for `core`, `cli` and `mcp` | done — `STABILITY.md` publishes the promise and the rules; the surface is locked and checked in CI |
| Stable context schema and migration policy | done — schema v1 stable since 0.3, compatibility policy published, `migrate`/`migrate --check` operational |
| Task-oriented context and impact analysis over a correct graph | done |
| Quality TypeScript/JavaScript structural analysis | done for the supported subset |
| Temporal context for git history | done |
| npm workspaces and verified monorepo scenarios | done |
| Production-ready local CLI and stdio MCP server | done |
| Compatibility matrix for Node.js and MCP clients | done — Node matrix written down in the README, MCP matrix in `packages/mcp/README.md` |
| Benchmark report on public repositories | done since 0.13.0 — eight third-party repositories pinned by commit SHA, measured and oracle-checked in CI |

### Remaining work

1. ~~Close the precision/recall gap.~~ Done in 0.12.0 against the TypeScript
   independent oracle exists for.
2. ~~Add public repositories to the benchmark, pinned by commit SHA.~~ Done in
   0.13.0: eight repositories, all at 100% resolution and, where there are module
   edges to compare, 100% precision and recall.
3. ~~Re-audit the exported surface against STABILITY.md.~~ Audited in 0.14.0, and
   the answer was mostly "promote fewer than expected", plus one mechanism that
   did not do what it claimed.
4. ~~Decide whether `.agent/` schema v2 is worth the migration cost.~~ Decided in
   0.14.1: no, and `STABILITY.md` now records the three conditions that would
   force one, so the next decision is made against a stated trigger rather than
   an impression.
5. ~~Decide what to do about entry-point precision and recall.~~ Decided in
   0.14.0, and split rather than resolved: declared entry points are a fact and
   are now measured; the naming and signal heuristics have no oracle and are now
   a stated limitation instead of a metric marked "not measured".

### Release criteria

Five of the six are checked by something that can fail. The sixth is not, and
that asymmetry is the reason 1.0 has not been tagged.

| Criterion | Status | Checked by |
| --- | --- | --- |
| zero known critical/high vulnerabilities in the supported dependency graph | **met** | `npm audit --audit-level=high`, CI `audit` |
| verify, typecheck and the integration tests pass on every supported Node.js version | **met** | CI `test` (Node 22.18/24 × Linux/macOS/Windows) and `packaged smoke` (Node 20.11/22.18/24) |
| no known data-loss or path traversal defects | **met** | CI `self scan` fails on any path escape; two data-loss defects found and fixed this cycle (dry-run writes, parser dropping a file's imports) |
| API changes follow the published deprecation policy | **met** | `STABILITY.md`, `npm run api:check` over values *and* types, `npm run stability:check` over the document |
| the release process is reproducible (`node tools/set-version.mjs`) | **met** | every release from 0.8.0 onward used it; publish-before-push is documented in `CONTRIBUTING.md` with the reason |
| at least three real users or teams confirm regular use in an agent workflow | **not met** | nothing — it is a fact about the world, not about the code |

**On the sixth criterion.** It cannot be satisfied by writing more code or by
running more checks. Everything this project can verify about itself, it now
verifies, and the two cycles above were spent finding and fixing what it had
missed. What remains is whether the tool is useful to people who did not write
it, and the only honest way to establish that is for someone to try it and say
so.

Tagging 1.0 without it would make the release criteria decorative, in a project
whose whole argument is that claims should be checkable. The engineering is
ready: when three users confirm regular use, `node tools/set-version.mjs 1.0.0`
followed by the publish sequence is the entire process.

### Not promised in 1.0

- a compiler-grade analyzer for every language;
- a drop-in replacement for tree-sitter, Sourcegraph or built-in repository
  indexing;
- automatic understanding of business logic without evidence;
- sending source code to external services.

---

## After 1.0

Priority directions are decided by usage data:

- semantic search and embeddings as an optional backend;
- additional languages through pluggable adapters;
- call graph and impact analysis for enterprise use cases;
- a VS Code extension and git hooks;
- GitHub Actions and GitLab CI integrations;
- a team/shared context registry;
- a web dashboard for context health and architecture drift;
- remote MCP deployment;
- import/export from other code graph formats;
- paid Pro/Team/Enterprise tiers.

## Roadmap metrics

Metrics are split into **measurable automatically** and **requiring external
data**. The agent sends no telemetry, so product metrics are collected only
through opt-in surveys and issue activity — stated explicitly so that no number
nobody measured ends up in a report.

Every metric is marked, so the list cannot be read as a report of finished work:
**measured** means there is code and a CI gate behind it; **not measured** means
it is only claimed.

### Measurable automatically (CI)

| Metric | Status | Where |
| --- | --- | --- |
| import resolution rate (resolved / total internal imports) | measured | `summary.imports.resolutionRate`, CI gate |
| dependency graph density | measured | `summary.graph` |
| token budget per module-size bucket | measured | `summary.tokenBudget` |
| cold/warm scan, parsed/reused | measured | `row.scan` |
| evidence coverage: share of judgements citing at least one source | measured since 0.10.0 | `summary.trust.coveragePercent`, CI gate |
| determinism: byte-identical context for one commit | measured since 0.10.0 | `summary.trust.nonDeterministic`, CI gate |
| dependency graph precision/recall | measured since 0.12.0, on third-party code since 0.13.0 | `npm run ground-truth`, `npm run ground-truth:public`, CI gates: 100% precision and recall against the TypeScript compiler |
| declared entry-point precision/recall | measured since 0.14.0 | `npm run ground-truth:entry`, CI gate: 100% precision and recall against the manifests |
| entry points found by naming or behaviour | **not measured, permanently** | no oracle exists; see below |

**How the newer metrics are computed.** Evidence coverage walks the generated
documents and counts objects carrying a numeric `confidence`: exactly the
assertions the analyzer makes as heuristics. Structural facts (module ids, paths,
import specifiers) carry no confidence and are deliberately not counted. A
repository with no heuristics shows `null`, not 100%: there was nothing to
explain. Determinism compares a byte-level hash of the documents after two
independent scans with the cache bypassed, so a difference can only come from
the analyzer rather than from what it happened to reuse.

**How precision and recall are computed.** `tools/ground-truth.mjs` extracts
specifiers with `ts.createSourceFile` and resolves them with
`ts.resolveModuleName`, then compares the resulting graph with the analyzer's.
The compiler shares no code with this project, so the comparison can fail, and a
failure fails the build.

Three scope rules apply, and each is counted in the output so none can quietly
absorb a disagreement: build output is excluded, matching the analyzer's own
`excludedOutput` class; a bare specifier naming a declared workspace package is
an in-repo dependency rather than an external one; and an analyzer edge to a
workspace package matches a truth edge into that package's directory, because both
describe one dependency at different levels of detail.

The workspace rule has a second clause, added in 0.13.0 after measuring third-party
code: a package importing **itself by name** — which is what `ky`'s own type tests
do — is a dependency on its local entry point, not a download. Conversely a
specifier that the importing manifest *declares* as a dependency is a registry
dependency even when the name matches a package in the same tree, which is what
separates `clsx`'s `bench/` from `ky`'s `test-d/`. Package managers require real
dependencies to be declared, so the declaration is evidence rather than a
convention.

Eighteen module edges is a coarse denominator, so the finer check is also run:
every import the analyzer failed to resolve is put to the compiler and classified
as `expectedBuildOutput`, `agreedMissing`, or `missed`. A single `missed` entry
means the headline resolution rate is overstated.

**The same oracle runs on third-party code.** `npm run ground-truth:public`
repeats this over the eight pinned repositories in `tools/benchmark-repos.json`,
which is where the nested-generic parser defect was found: every measurement on
this repository had passed it.

**Declared entry points are a fact, so they are measured too.** Entry points come
from four sources. Three of them are heuristics — npm script references, naming
conventions, behavioural signals — and this project has no oracle for heuristics:
a corpus labelled by hand would measure the labeller. The fourth is different in
kind. When a manifest says `"bin": { "agent-context": "./dist/bin.js" }` then the
file that command runs is not a judgement, it exists independently of anything in
`packages/core`. `npm run ground-truth:entry` reads the manifests with its own
code and compares.

Measured: 14 declared entry files on this repository and 82 across the pinned
set, including 48 in a pnpm workspace with several commands per package.
**Precision 100%, recall 100%** on both. `types` fields and wildcard exports are
excluded, because the analyzer deliberately does not report either as a runtime
entry point and measuring them would report a decision rather than an accuracy.

The remaining two sources are recorded as **not measured, permanently** rather
than left as a metric that looks like an oversight.

**What this does not certify.** The compiler is an oracle for module resolution
only. It says nothing about entry points, roles, conventions or decisions, which
remain heuristics carrying a confidence and evidence.

**Current values on this repository and the five fixtures:** evidence coverage
100% (363 judgements, 0 without a source), 0 non-deterministic repositories.

### Requiring external data (opt-in, no telemetry)

None of these can be obtained from code: the product does not observe itself,
and the agent sends no telemetry.

- reduction in tokens consumed by coding agents;
- reduction in time-to-first-correct-change;
- fewer incorrect file/module selections;
- repeat usage after 7 and 30 days;
- weekly active users, active MCP installations;
- support/issue volume per release.

Separately: **a verified integration with at least three real MCP clients** is a
v0.8 criterion that stays open. The configuration presets encode each client's
documented format, but none of them was launched in the development
environment.

## Release checklist for every version

- [ ] README and migration notes updated.
- [ ] API/CLI/MCP schemas updated.
- [ ] Unit and integration tests added for the new behaviour.
- [ ] Every new analyzer is covered by a test that fails before the fix.
- [ ] Windows, Linux and macOS verified (CI matrix).
- [ ] `npm run verify`, `npm audit` and `git diff --check` run.
- [ ] Performance and deterministic output checked.
- [ ] This repository is re-scanned and the updated `.agent/` is committed
      (`node packages/cli/dist/bin.js scan && git add .agent`). Mandatory: the
      CI job `self-scan` runs `init && scan` **before** `verify`, so it validates
      freshly generated context and cannot notice a stale committed one.
- [ ] Version set through `node tools/set-version.mjs <semver>`.
- [ ] Every affected npm package confirmed packable with a dry run.
- [ ] Known limitations and security notes updated.
- [ ] Release notes prepared with the measurable changes.
- [ ] Published **before** pushing, in the order core → cli → mcp. Pushing a
      version bump first fails `packaged-smoke` on every supported Node, because
      the packed CLI resolves its core dependency from the registry.