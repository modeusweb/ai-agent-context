# @ai-agent-context/mcp

MCP (Model Context Protocol) adapter for `ai-agent-context`.

The adapter exposes the repository knowledge graph built by `@ai-agent-context/core` to MCP clients over stdio. It contains no analysis logic: every tool delegates to the core API, so the same guarantees (deterministic, local-only, evidence-backed) apply unchanged.

## Installation

```bash
npm install @ai-agent-context/mcp
```

## Running the server

```bash
agent-context-mcp --root /path/to/repository
```

The repository root defaults to `AGENT_CONTEXT_ROOT`, then to the current working directory. stdout carries JSON-RPC only; all diagnostics go to stderr.

## Client configuration

Print the snippet for a supported client:

```bash
agent-context-mcp config claude-code
agent-context-mcp config cursor
agent-context-mcp config cline
agent-context-mcp config continue
agent-context-mcp config --list     # supported clients
agent-context-mcp config --all      # every client at once
```

Each snippet prints the value of the client's `mcpServers` field. Merge it into the existing file — the config file also carries unrelated settings, so replacing the file would destroy them.

| Client | File | Shape |
| --- | --- | --- |
| Claude Code | `.mcp.json` | object keyed by server name |
| Cursor | `.cursor/mcp.json` | object keyed by server name |
| Cline (VS Code) | `cline_mcp_settings.json` | object keyed by server name |
| Continue | `~/.continue/config.json` | array |

Running a local checkout instead of the published package:

```bash
agent-context-mcp config cursor --command node --command-arg /path/to/packages/mcp/dist/bin.js
```

## Protocol support

The server is **dual-era**: it selects its behaviour from how the client opens.

| Era | Revisions | How the client opens |
| --- | --- | --- |
| Legacy | `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` | `initialize` handshake |
| Modern | `2026-07-28` | per-request `_meta`, no handshake |

**Legacy negotiation.** `initialize` is answered with the version the client asked for. When the client asks for a revision this server does not implement, it answers with the newest legacy revision it does — as the specification requires — so a client is never told to downgrade to a revision it did not request.

**Modern negotiation.** Every request carries `io.modelcontextprotocol/protocolVersion` in `_meta`. There is no handshake and no downgrade: a request naming an unsupported revision is refused with `-32022` and a list of versions to retry with. A modern request that omits the required `io.modelcontextprotocol/clientCapabilities` is refused with `-32602`. Modern results carry `resultType: "complete"`.

`server/discover` is implemented and reports `supportedVersions`, capabilities and server identity.

```bash
# what the server supports
{"jsonrpc":"2.0","id":"d1","method":"server/discover","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientCapabilities":{}}}}
```

### Compatibility matrix

| Client era | Server | Outcome |
| --- | --- | --- |
| Legacy (`initialize`) | this server | Works; answered with the requested or the newest legacy revision |
| Modern (`_meta`, `server/discover`) | this server | Works for `2026-07-28`; other revisions get `-32022` with a retry list |
| Legacy | modern-only server | Would fail; not applicable here, this server is dual-era |

### Verified against a client written by someone else

Everything else that exercises this server — the packaged smoke test and the test
suite — speaks JSON-RPC by hand, which means it checks the server against the
same understanding of the protocol that wrote it.

```bash
npm run mcp:client
```

That drives the server with `@modelcontextprotocol/sdk`, the reference
implementation, as a real client over stdio. The SDK parses and validates every
message, negotiates the revision itself, and throws on anything off-specification.
It runs in CI as `mcp against a real client`.

**23 checks:** the handshake and the negotiated revision, the tool list and every
schema in it, six tool calls against a real repository, the `compact`/`full`
size contract, and the fact that an argument the server rejects outright is a
protocol error rather than a failed tool result.

Two things it established by disagreeing with the assumptions written into the
check: an invalid `detail` value is *rejected*, not returned as a tool error —
which is the correct behaviour, since returning `isError` would tell the agent the
call ran and failed when it never ran; and `compact` is a size budget rather than
a different question, keeping the same shape while dropping the evidence.

**Not verified, stated on every run of the check.** The reference SDK's newest
revision is `2025-11-25`, so no third-party client can exercise the modern
`_meta` era yet; the negotiation helpers are unit-tested and the era itself is
not. And the shipping desktop clients listed above are applications — launching
one is outside what a command-line check can do. Those presets encode the
documented configuration format of each client; confirm against your own
installation before relying on them.

Verified here otherwise: legacy and modern sessions over a real stdio process,
malformed input, cancellation and timeouts.

## Cancellation and timeouts

`notifications/cancelled` stops a request: the response is suppressed, and a cancelled request is never answered — including by the timeout that follows it.

Every request is bounded by `requestTimeoutMs` (default 120000, `0` disables). An expired request is answered with `-32603` and `data.timeoutMs`, and any late result is discarded.

## Error handling

Errors use the JSON-RPC codes and the MCP-specific codes in the specification's reserved range:

| Code | Meaning |
| --- | --- |
| `-32600` | Invalid Request — message without a `method` |
| `-32601` | Method not found |
| `-32602` | Invalid params — unknown resource or prompt, failed argument validation, missing required `_meta` field |
| `-32603` | Internal error, including a request that exceeded its timeout |
| `-32021` | `MissingRequiredClientCapabilityError` |
| `-32022` | `UnsupportedProtocolVersionError`, with `data.supported` |

`-32002` (resource not found, reserved by older revisions) is never emitted; unknown resources report `-32602`.

A tool that runs but fails is **not** a protocol error: the response carries `isError: true` with a human-readable payload, so the agent can read and act on the message.

Arguments are validated against the published JSON Schema before dispatch. Missing required fields, wrong primitive types, invalid enums and unknown properties are rejected with `-32602` without starting repository analysis.

## Resources

Read-only, exposed as MCP resources:

- `agent://repository/context`
- `agent://repository/architecture`
- `agent://repository/dependencies`
- `agent://repository/conventions`
- `agent://repository/decisions`

## Prompts

- `onboard_to_repository`
- `review_change_impact`
- `explain_architecture`

## Tools

| Tool | Required arguments |
| --- | --- |
| `get_repository_context` | — |
| `get_context_for_task` | `task` |
| `get_change_impact` | `target` |
| `explain_module` | `path` |
| `get_dependencies` | — |
| `get_dependents` | `module` |
| `search_context` | `query` |
| `get_architecture` | — |
| `get_conventions` | — |
| `get_decisions` | — |
| `get_module_history` | `target` |
| `get_revision_diff` | `revision` |
| `get_revision_snapshot` | `revision` |
| `detect_coverage_gaps` | — |

Every tool accepts an optional `root`. All tools are bounded and carry a confidence and evidence for heuristic values; see the repository `README.md` for what each returns.

## Programmatic use

```ts
import { McpServer, createMemoryTransport, SUPPORTED_PROTOCOL_VERSIONS } from '@ai-agent-context/mcp';

const transport = createMemoryTransport();
const server = new McpServer({ root: process.cwd(), transport, requestTimeoutMs: 30_000 });
server.start();
transport.push({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
} } });
console.log(transport.sent);
```

Exported for embedders: `McpServer`, `createStdioTransport`, `createMemoryTransport`, the `CLIENT_PRESETS` set with `presetById`/`renderPreset`/`renderAllPresets`/`serverArgv`, the protocol helpers (`SUPPORTED_PROTOCOL_VERSIONS`, `ErrorCode`, `negotiateLegacyVersion`, `isSupportedVersion`, …), `TOOL_DEFINITIONS`, `callTool` and `ContextPool`.

`MCP_PROTOCOL_VERSION` is the legacy handshake default and is deprecated in favour of `SUPPORTED_PROTOCOL_VERSIONS`.

## Security

The adapter inherits the core package's properties:

- **Local-only**: no external API calls, no telemetry
- **Repository-scoped**: tools accept a `root`, and the core rejects paths outside it
- **Read-only**: tools, resources and prompts never modify the repository
- **Clean stdio channel**: JSON-RPC on stdout, diagnostics on stderr
- **Secret filtering**: sensitive files are skipped by the core, not by the adapter

See the repository `SECURITY.md`.

## License

MIT