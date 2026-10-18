/**
 * Protocol versions, version negotiation and the error taxonomy.
 *
 * The MCP specification describes two eras of the protocol:
 *
 * - **Legacy** (`2025-11-25` and earlier) establishes a session with an
 *   `initialize` handshake. The client states the version it wants and the server
 *   answers with that version, or with another one it supports when it cannot
 *   honour the request. The session then runs on the negotiated version.
 * - **Modern** (`2026-07-28` and later) is stateless: there is no handshake, and
 *   every request carries its version in `_meta` under
 *   `io.modelcontextprotocol/protocolVersion`. An unsupported version is refused
 *   per request with `UnsupportedProtocolVersionError` (`-32022`) instead of
 *   being negotiated down.
 *
 * A server that supports both is called dual-era, and the specification's
 * compatibility matrix requires it to pick its behaviour from how the client
 * opens: a request carrying modern `_meta` is served statelessly, an `initialize`
 * request selects legacy semantics for the process.
 *
 * Pinning a single version — which this adapter used to do — is what makes a
 * server look old to every client newer than that version: a client asking for
 * `2025-06-18` was answered `2024-11-05` and, per the specification, had to
 * disconnect. This module is the fix.
 */

/**
 * Every protocol revision this server implements, oldest first.
 *
 * `2024-10-07` is the reference SDK's oldest supported revision. Omitting it was
 * a real interoperability break: a client pinned to it asked for `2024-10-07`,
 * got the `2024-11-05` fallback, and then refused the connection with "Server's
 * protocol version is not supported" — the exact failure this module exists to
 * prevent, fixed for four revisions and missed for the fifth.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** First revision that carries per-request `_meta` instead of a handshake. */
export const FIRST_MODERN_VERSION: ProtocolVersion = '2026-07-28';

/** Newest legacy revision; the answer to an `initialize` we cannot match. */
export const LATEST_LEGACY_VERSION: ProtocolVersion = '2025-11-25';

/** Newest revision overall; what `server/discover` puts first. */
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = '2026-07-28';

const INDEX: ReadonlyMap<string, number> = new Map(
  SUPPORTED_PROTOCOL_VERSIONS.map((version, index) => [version as string, index]),
);

/** Whether this server implements `version` at all. */
export function isSupportedVersion(version: unknown): version is ProtocolVersion {
  return typeof version === 'string' && INDEX.has(version);
}

/**
 * Whether `version` is a modern (handshake-free) revision.
 *
 * Unknown versions are treated as modern: a client speaking something newer
 * than this server is by definition not a legacy client, and guessing otherwise
 * would serve it legacy semantics it cannot use.
 */
export function isModernVersion(version: string): boolean {
  const index = INDEX.get(version);
  return index === undefined ? true : index >= INDEX.get(FIRST_MODERN_VERSION)!;
}

/**
 * Legacy negotiation for the `initialize` handshake.
 *
 * Per the specification: if the requested version is supported the server MUST
 * answer with the same version, otherwise it MUST answer with a version it does
 * support, which SHOULD be its latest.
 *
 * A *modern* revision requested over `initialize` is not echoed. Modern clients
 * never send that handshake, so the only client that would is one speaking a
 * dialect this server does not implement as legacy; answering with our newest
 * legacy revision gives it the best chance to work.
 */
export function negotiateLegacyVersion(requested: unknown): ProtocolVersion {
  if (typeof requested === 'string' && isSupportedVersion(requested) && !isModernVersion(requested)) {
    return requested;
  }
  return LATEST_LEGACY_VERSION;
}

/**
 * JSON-RPC 2.0 error codes.
 *
 * The MCP specification partitions `-32000..-32099` explicitly: `-32000..-32019`
 * are legacy and must not be reused, while `-32020..-32099` are reserved for the
 * specification. `-32002` (resource not found, 2025-11-25 and earlier) is in the
 * legacy sub-range and MUST NOT be emitted by an implementation of this version;
 * unknown resources report `-32602` instead.
 */
export const ErrorCode = {
  /** Invalid JSON was received. */
  ParseError: -32700,
  /** The payload is not a valid Request object. */
  InvalidRequest: -32600,
  /** The method does not exist. */
  MethodNotFound: -32601,
  /** Invalid method parameters. */
  InvalidParams: -32602,
  /** Internal JSON-RPC error. */
  InternalError: -32603,
  /** A required client capability was not declared. */
  MissingRequiredClientCapability: -32021,
  /** The requested protocol revision is not implemented. */
  UnsupportedProtocolVersion: -32022,
} as const;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Builds the `UnsupportedProtocolVersionError` payload, including the list of
 * versions the client may retry with.
 */
export function unsupportedProtocolVersion(requested: unknown): JsonRpcErrorObject {
  return {
    code: ErrorCode.UnsupportedProtocolVersion,
    message: 'Unsupported protocol version',
    data: {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: typeof requested === 'string' ? requested : null,
    },
  };
}

/**
 * Builds the `MissingRequiredClientCapabilityError` payload.
 */
export function missingRequiredClientCapability(required: string[]): JsonRpcErrorObject {
  return {
    code: ErrorCode.MissingRequiredClientCapability,
    message: 'Missing required client capability',
    data: { requiredCapabilities: required },
  };
}

/** Reserved `_meta` keys defined by the specification. */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** `resultType` required on every modern-era result. */
export const RESULT_TYPE_COMPLETE = 'complete';

export interface ProtocolEra {
  /** Modern requests carry their version per request; legacy ones negotiated it once. */
  modern: boolean;
  /** The version in effect for this request, when it is known. */
  version: string | null;
  /** `_meta` of the request, when present. */
  meta: Record<string, unknown>;
}

/** Reads `_meta` out of request params without trusting its shape. */
export function readMeta(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = params?.['_meta'];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {};
  return meta as Record<string, unknown>;
}