# Security policy

## Supported versions

Security fixes are provided for the latest published `0.3.x` release.

## Security model

- Analysis is local and performs no network requests.
- Core has no runtime dependencies.
- Sensitive files (`.env`, credentials, private keys and similar paths) are not read by default.
- Secret-looking values copied into generated context are redacted.
- Symbolic links are not followed by default, preventing traversal outside the repository root.
- MCP stdio uses stdout exclusively for JSON-RPC; diagnostics are written to stderr.
- MCP tool operations are read-only and do not modify repository source files.
- `.agent/verify` provides a read-only CI check for schema and context drift.

`allowSensitiveFiles` is an explicit escape hatch and should remain disabled for repositories containing credentials.

## Reporting

Report suspected vulnerabilities privately through the repository Security Advisory interface. Do not include real credentials in an issue, test fixture, log, or advisory. Provide a minimal reproduction with synthetic data.

## Operational guidance

- Commit `.agent/` only after reviewing generated content.
- Do not enable `allowSensitiveFiles` in CI.
- Keep Node.js and the CLI/MCP packages on supported releases.
- Run `npm audit` and `agent-context verify --json` in CI.
