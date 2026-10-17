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

The metrics section now marks every entry as measured or not measured, and
entry-point and dependency precision/recall is labelled as **not measured**: it
needs a labelled corpus that does not exist yet. Claiming it in a metrics table
is how a roadmap starts lying to its readers.

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

## v1.0 — Stable repository intelligence (in progress)

**Goal:** a stable release with a proven API, mature integrations and
measurable value for teams.

### Progress so far

| Component | Status |
| --- | --- |
| Stable semver API for `core`, `cli` and `mcp` | in progress — no public API has changed incompatibly since 0.4, but no deprecation policy is published yet |
| Stable context schema and migration policy | in progress — schema v1 unchanged since 0.3; `migrate` exists, the compatibility policy does not |
| Task-oriented context and impact analysis over a correct graph | done |
| Quality TypeScript/JavaScript structural analysis | done for the supported subset |
| Temporal context for git history | done |
| npm workspaces and verified monorepo scenarios | done |
| Production-ready local CLI and stdio MCP server | done |
| Compatibility matrix for Node.js and MCP clients | MCP matrix published in `packages/mcp/README.md`; the Node matrix is asserted by CI but not yet written down in the README |
| Benchmark report on public repositories | not done — the set is this repository plus five synthetic fixtures |

### Remaining work

1. **Publish a deprecation policy** for the public API: what constitutes a
   breaking change, how long a deprecation lasts, what is removed in a major.
2. **Publish a context schema compatibility policy**: which schema changes are
   additive, which require `agent-context migrate`, and how a consumer detects
   an incompatible document.
3. **Write the Node.js compatibility matrix** into the README as a table rather
   than leaving it implied by CI.
4. **Close the precision/recall gap** with a labelled corpus, or state it as a
   permanent limitation.
5. **Add public repositories to the benchmark**, pinned by commit SHA.

### Release criteria

- zero known critical/high vulnerabilities in the supported dependency graph;
- verify, typecheck and the integration tests pass on every supported Node.js
  version;
- no known data-loss or path traversal defects;
- API changes follow the published deprecation policy;
- the release process is reproducible (`node tools/set-version.mjs`);
- at least three real users or teams confirm regular use in an agent workflow.

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
| entry-point and dependency precision/recall on a labelled set | **not measured** | needs a labelled corpus; neither the corpus nor the code exists |

Before 0.10.0 the last two rows were listed as measurable while the benchmark
measured neither. They are now either measured or marked unfinished — that
difference is what makes the section readable.

**How the newer metrics are computed.** Evidence coverage walks the generated
documents and counts objects carrying a numeric `confidence`: exactly the
assertions the analyzer makes as heuristics. Structural facts (module ids, paths,
import specifiers) carry no confidence and are deliberately not counted. A
repository with no heuristics shows `null`, not 100%: there was nothing to
explain. Determinism compares a byte-level hash of the documents after two
independent scans with the cache bypassed, so a difference can only come from
the analyzer rather than from what it happened to reuse.

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
