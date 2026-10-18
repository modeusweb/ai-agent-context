# Security policy

## Supported versions

Security fixes are provided for the latest published `1.x` release.

## Security model

- Analysis is local and performs no network requests.
- Core has no runtime dependencies.
- Sensitive files (`.env`, credentials, private keys and similar paths) are not read by default.
- Secret-looking values copied into generated context are redacted, and no policy can waive that.
- Symbolic links are not followed by default, preventing traversal outside the repository root.
- Path traversal is rejected, not normalized away. A relative import specifier
  that climbs above the repository root (`../../../etc/passwd`) is reported as
  `unresolved` with an explicit `resolves outside the repository root`
  diagnostic; absolute specifiers are rejected on the same grounds. Collapsing
  such a specifier onto an in-repo path would let a crafted import resolve to a
  legitimate analyzed file.
- MCP stdio uses stdout exclusively for JSON-RPC; diagnostics are written to stderr.
- MCP tool operations are read-only and do not modify repository source files.
- `agent-context verify` provides a read-only CI check for schema and context drift.
- An MCP request is bounded by `requestTimeoutMs`, so a wedged client cannot pin
  the process; a cancelled request is never answered, including by that timeout.

`allowSensitiveFiles` is an explicit escape hatch and should remain disabled for repositories containing credentials.

## Organization policy

`.agent-policy.json` is a floor beneath a repository's own `.agent/config.json`.
It is discovered in the repository root or in any parent directory, so a policy
committed once at an organization or monorepo checkout applies to everything
underneath it; `AGENT_CONTEXT_POLICY` overrides the search.

A repository may tighten. It may not loosen. The policy:

- adds to `exclude` and to the sensitive-pattern list rather than replacing them;
- forces `allowSensitiveFiles` off when it says `false`;
- forces secret redaction on when it says `true`, and **refuses to load** a
  policy that sets `redactSecrets: false` — disabling redaction would copy secret
  material into a file people commit and share;
- forces read-only mode on when it says `true`, which no repository setting or
  CLI flag can undo;
- refuses to load a document with an unknown `version`, because a policy that
  silently fails to apply is indistinguishable from no policy at all.

```json
{
  "version": 1,
  "exclude": ["vendor/private"],
  "sensitive": ["*.tfvars"],
  "allowSensitiveFiles": false,
  "redactSecrets": true,
  "readOnly": false
}
```

## Read-only contract

`security.readOnly` — settable per repository or forced on by an organization
policy, and available as `--read-only` — makes every write fail and leaves every
query working.

The guard is enforced in the `AgentContext` facade rather than in each command,
so no code path can write: an MCP tool handler, a CLI command, and an embedder
calling `scan()` directly all hit the same check. It covers `scan()` and
`init()`, which are the only operations that write.

## Threat model

**In scope.** Repository content is treated as untrusted input. A repository may
contain path traversal attempts in import specifiers, symlinks pointing outside
the root, very large files, files that look like credentials, and constructs
aimed at the analyzer rather than at the build. The analyzer must either handle
these safely or degrade with a diagnostic — never resolve them onto a path the
caller did not name, and never read outside the repository root.

A repository is also untrusted with respect to *its own configuration*: the
`.agent/config.json` checked into it is written by contributors and may ask for
`allowSensitiveFiles` or for a broader `include`. The organization policy is
what makes those settings non-authoritative.

**Out of scope.** `ai-agent-context` runs with the privileges of the invoking
user, on a repository that user chose to scan. It does not defend against a
malicious *operating system*, a compromised npm registry, or a hostile process
that already has the same privileges. It does not sandbox the repository it
reads. If you need analysis of untrusted code in a sandbox, run it in one.

It also does not defend against a compromised *machine*: the policy file is read
from the filesystem like any other file, and a process able to rewrite it can
change the rules. Enforcing policy from a location the repository cannot write
(an environment variable pointing outside the checkout) is the stronger
arrangement.

**No guarantees against semantic mistakes.** Roles, conventions and decisions are
heuristics carrying a confidence and evidence. They are advisory and can be
wrong; the analyzer never asserts a fact it cannot cite.

## Audit guidance

For an organization deciding how to adopt this:

1. **Check what is read.** Run `agent-context detect` and read the resolution
   rate and the classified unresolved imports. A non-empty `unresolved` list is
   a statement about repository layout; `pathEscapes` must be zero.
2. **Check what is written.** Review the generated `.agent/` before committing
   it. The diff is meant to be reviewed, which is the reason the context is
   versionable in the first place.
3. **Pin the policy outside the repository.** Use `AGENT_CONTEXT_POLICY` pointing
   at a location contributors cannot write, and keep `allowSensitiveFiles` off.
4. **Gate CI.** Use the reusable workflow
   (`.github/workflows/reusable-verify-context.yml`), which runs the read-only
   `verify` and `migrate --check` and fails on a rejected traversal.
5. **Review dependency supply.** `npm audit --audit-level=high` in CI. Core has
   no runtime dependencies, so the audit mostly covers the CLI and the adapter.

## Reporting

Report suspected vulnerabilities privately through the repository Security Advisory interface. Do not include real credentials in an issue, test fixture, log, or advisory. Provide a minimal reproduction with synthetic data.

## Operational guidance

- Commit `.agent/` only after reviewing generated content.
- Do not enable `allowSensitiveFiles` in CI.
- Use `agent-context migrate --check` as a schema gate; `verify` covers drift.
- Keep Node.js and the CLI/MCP packages on supported releases.
- Run `npm audit` and `agent-context verify --json` in CI.