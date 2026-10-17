# Security policy

## Supported versions

Security fixes are provided for the latest published `0.5.x` release.

## Security model

- Analysis is local and performs no network requests.
- Core has no runtime dependencies.
- Sensitive files (`.env`, credentials, private keys and similar paths) are not read by default.
- Secret-looking values copied into generated context are redacted.
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

`allowSensitiveFiles` is an explicit escape hatch and should remain disabled for repositories containing credentials.

## Threat model

**In scope.** Repository content is treated as untrusted input. A repository may
contain path traversal attempts in import specifiers, symlinks pointing outside
the root, very large files, files that look like credentials, and constructs
aimed at the analyzer rather than at the build. The analyzer must either handle
these safely or degrade with a diagnostic — never resolve them onto a path the
caller did not name, and never read outside the repository root.

**Out of scope.** `ai-agent-context` runs with the privileges of the invoking
user, on a repository that user chose to scan. It does not defend against a
malicious *operating system*, a compromised npm registry, or a hostile process
that already has the same privileges. It does not sandbox the repository it
reads. If you need analysis of untrusted code in a sandbox, run it in one.

**No guarantees against semantic mistakes.** Roles, conventions and decisions are
heuristics carrying a confidence and evidence. They are advisory and can be
wrong; the analyzer never asserts a fact it cannot cite.

## Reporting

Report suspected vulnerabilities privately through the repository Security Advisory interface. Do not include real credentials in an issue, test fixture, log, or advisory. Provide a minimal reproduction with synthetic data.

## Operational guidance

- Commit `.agent/` only after reviewing generated content.
- Do not enable `allowSensitiveFiles` in CI.
- Keep Node.js and the CLI/MCP packages on supported releases.
- Run `npm audit` and `agent-context verify --json` in CI.
