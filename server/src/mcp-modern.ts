/**
 * server/src/mcp-modern.ts
 *
 * MCP revision 2026-07-28 ("modern"): requests carry their protocol version and client details in
 * `params._meta` (no initialize handshake), results say `resultType: "complete"`, and over HTTP the
 * version, method and name are mirrored in headers. The server speaks it alongside the legacy
 * revisions (2025-06-18, 2025-03-26, 2024-11-05), which keep working byte for byte.
 *
 * Everything here is pure (no I/O, no imports from the dispatcher): the era classifier, the result
 * decorator, the HTTP header validation and the client-label sanitiser. mcp-rpc.ts dispatches on the
 * classification, panel-entry.ts applies the header rules.
 * Runs on CEP's Node 17 (bundled with esbuild --target=node17): no fetch or other Node 18+ APIs, Buffer (not atob)
 * for Base64, and no TextDecoder `fatal` option (it needs ICU).
 */

import type { JsonRpcErrorResponse, JsonRpcId } from "./mcp-rpc.js";

export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
/** The initialize-era revisions; mcp-rpc.ts re-exports this list as SUPPORTED_PROTOCOL_VERSIONS. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const ALL_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";

export const ERR_HEADER_MISMATCH = -32020;
export const ERR_MISSING_CLIENT_CAPABILITY = -32021;
export const ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** How long (ms) a client may reuse any answer the panel gives. The relay's offline answers use 0. */
export const CACHE_TTL_MS = 300000;

export type CacheScope = "public" | "private";

/** Methods that exist only in the modern revision: without the _meta version they are a -32602, not a legacy call. */
export const MODERN_ONLY_METHODS: readonly string[] = ["server/discover", "skills/list", "skills/get"];

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ModernClassification {
  era: "modern";
  version: string;
  clientInfo?: Record<string, unknown>;
  clientCapabilities: Record<string, unknown>;
}

export type Classification =
  | { era: "legacy" }
  | ModernClassification
  | { era: "error"; response: JsonRpcErrorResponse; httpStatus: 400 };

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): Classification {
  const error: JsonRpcErrorResponse["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { era: "error", httpStatus: 400, response: { jsonrpc: "2.0", id, error } };
}

/** The JSON-RPC id of a message as handleRpc echoes it (anything but a string, number or null becomes null). */
export function idOf(message: Record<string, unknown>): JsonRpcId {
  const raw = message.id;
  return typeof raw === "string" || typeof raw === "number" || raw === null ? raw : null;
}

/**
 * Which revision a request belongs to. Only requests (objects with a method and an id) are classified;
 * notifications, client responses and anything malformed are "legacy" and stay on today's path.
 *
 * - no _meta protocolVersion: legacy, except the modern-only methods, which are -32602;
 * - a modern version: modern, which also needs _meta clientCapabilities (an object) or it is -32602;
 * - a legacy version in _meta: legacy (served exactly as a request without _meta);
 * - anything else (unknown or not a string): -32022 with the versions this server speaks.
 */
export function classifyRequest(message: unknown): Classification {
  if (!isPlainObject(message)) return { era: "legacy" };
  const method = message.method;
  if (typeof method !== "string" || method.length === 0) return { era: "legacy" };
  if (!("id" in message) || message.id === undefined) return { era: "legacy" };
  const id = idOf(message);
  const params = isPlainObject(message.params) ? message.params : {};
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const version = meta[META_PROTOCOL_VERSION];

  if (version === undefined) {
    if (MODERN_ONLY_METHODS.includes(method)) {
      return errorResponse(
        id,
        -32602,
        `Invalid params: ${method} needs _meta["${META_PROTOCOL_VERSION}"] (${MODERN_PROTOCOL_VERSIONS[0]})`,
        { supported: ALL_PROTOCOL_VERSIONS }
      );
    }
    return { era: "legacy" };
  }
  if (typeof version === "string" && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    const caps = meta[META_CLIENT_CAPABILITIES];
    if (!isPlainObject(caps)) {
      return errorResponse(id, -32602, `Invalid params: missing _meta["${META_CLIENT_CAPABILITIES}"]`);
    }
    const info = meta[META_CLIENT_INFO];
    return { era: "modern", version, clientCapabilities: caps, ...(isPlainObject(info) ? { clientInfo: info } : {}) };
  }
  if (typeof version === "string" && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return { era: "legacy" };
  }
  return errorResponse(id, ERR_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
    supported: ALL_PROTOCOL_VERSIONS,
    requested: version,
  });
}

/**
 * The client label for the usage log, idempotency scope and cancellation scope: printable ASCII only
 * (every other run becomes one space), trimmed, at most 40 characters. The X-Chroma-Client header and a
 * modern request's clientInfo.name go through this same rule; clientInfo also has runs of spaces collapsed
 * (the header keeps them, as it always has).
 */
export function sanitizeClientLabel(value: unknown, collapseSpaces = false): string {
  if (typeof value !== "string") return "";
  const printable = value.replace(/[^ -~]+/g, " ");
  return (collapseSpaces ? printable.replace(/ {2,}/g, " ") : printable).trim().slice(0, 40);
}

/** The label a modern request's clientInfo gives, "" when it has none. */
export function clientLabelOf(c: ModernClassification): string {
  return sanitizeClientLabel(c.clientInfo?.name, true);
}

/** A modern result: the payload, resultType "complete" and the server's identity in _meta (existing _meta is kept). */
export function decorateResult(payload: unknown, serverInfo: ServerInfo): Record<string, unknown> {
  const body = isPlainObject(payload) ? payload : {};
  const meta = isPlainObject(body._meta) ? body._meta : {};
  return { ...body, resultType: "complete", _meta: { ...meta, [META_SERVER_INFO]: serverInfo } };
}

/** A cacheable payload: ttlMs and cacheScope added (the caching utility's CacheableResult). */
export function cacheable(payload: Record<string, unknown>, cacheScope: CacheScope, ttlMs: number = CACHE_TTL_MS): Record<string, unknown> {
  return { ...payload, ttlMs, cacheScope };
}

// ---- HTTP header validation (streamable-http "Request Metadata" and "Server Validation") ----

type HeaderBag = Record<string, string | string[] | undefined> | undefined;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const v = headers[key];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;

/** Decodes the "=?base64?<b64>?=" form (UTF-8); a plain value is returned as is; null when it cannot be decoded. */
export function decodeHeaderValue(value: string): string | null {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const m = SENTINEL.exec(value);
  if (!m || m[1].length % 4 !== 0) return null;
  const bytes = Buffer.from(m[1], "base64");
  // Invalid UTF-8 decodes to U+FFFD, so it no longer round-trips. (Not TextDecoder's `fatal` option: a Node
  // built without ICU, which CEP's may be, refuses it.)
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** Header values may hold only visible ASCII, space and tab (RFC 9110). */
function hasInvalidChars(value: string): boolean {
  return /[^\t -~]/.test(value);
}

function show(value: string): string {
  const s = value.length > 80 ? `${value.slice(0, 80)}...` : value;
  return `'${s}'`;
}

export type HeaderCheck = { ok: true } | { ok: false; message: string };

/**
 * Checks a modern request's MCP-Protocol-Version, Mcp-Method and Mcp-Name headers against its body.
 * `headers` is Node's lower-cased map (any case is accepted); values are compared case-sensitively.
 * Mcp-Param-* headers are not checked: no tool declares x-mcp-header.
 */
export function validateModernHeaders(headers: HeaderBag, body: { method: string; params?: unknown }, version: string): HeaderCheck {
  const fail = (message: string): HeaderCheck => ({ ok: false, message: `Header mismatch: ${message}` });
  const protocol = headerValue(headers, "mcp-protocol-version");
  const methodHeader = headerValue(headers, "mcp-method");
  const nameHeader = headerValue(headers, "mcp-name");

  for (const [label, value] of [["MCP-Protocol-Version", protocol], ["Mcp-Method", methodHeader], ["Mcp-Name", nameHeader]] as const) {
    if (value !== undefined && hasInvalidChars(value)) return fail(`${label} header contains invalid characters`);
  }

  if (protocol === undefined) return fail("MCP-Protocol-Version header is missing");
  if (protocol !== version) {
    return fail(`MCP-Protocol-Version header value ${show(protocol)} does not match body value ${show(version)}`);
  }
  if (methodHeader === undefined) return fail("Mcp-Method header is missing");
  if (methodHeader !== body.method) {
    return fail(`Mcp-Method header value ${show(methodHeader)} does not match body value ${show(body.method)}`);
  }

  const params = isPlainObject(body.params) ? body.params : {};
  let expected: unknown;
  let required = false;
  if (body.method === "tools/call" || body.method === "prompts/get") {
    expected = params.name;
    required = true;
  } else if (body.method === "resources/read") {
    expected = params.uri;
    required = true;
  } else {
    expected = typeof params.name === "string" ? params.name : params.uri;
  }
  if (typeof expected !== "string") return { ok: true }; // the body itself is invalid; the dispatcher answers -32602
  if (nameHeader === undefined) return required ? fail("Mcp-Name header is missing") : { ok: true };
  const decoded = decodeHeaderValue(nameHeader);
  if (decoded === null) return fail("Mcp-Name header is not valid Base64-encoded UTF-8");
  if (decoded !== expected) {
    return fail(`Mcp-Name header value ${show(decoded)} does not match body value ${show(expected)}`);
  }
  return { ok: true };
}

/**
 * A request whose body carries _meta[protocolVersion] (any value) next to an MCP-Protocol-Version header that
 * differs from it: the mismatch message, else null. Judged before the version itself.
 */
export function bodyVersionHeaderMismatch(headers: HeaderBag, body: Record<string, unknown>): string | null {
  const params = isPlainObject(body.params) ? body.params : {};
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const version = meta[META_PROTOCOL_VERSION];
  const protocol = headerValue(headers, "mcp-protocol-version");
  if (version === undefined || protocol === undefined) return null;
  // A header is text, so a non-string body value is compared as its JSON text (5 and "5" match; -32022 then says why).
  const bodyText = typeof version === "string" ? version : JSON.stringify(version);
  if (protocol === bodyText) return null;
  return `Header mismatch: MCP-Protocol-Version header value ${show(protocol)} does not match body value ${show(bodyText)}`;
}

/** A legacy-era request whose MCP-Protocol-Version header names a modern revision: the body is missing its _meta. */
export function legacyBodyWithModernHeader(headers: HeaderBag): string | null {
  const protocol = headerValue(headers, "mcp-protocol-version");
  if (protocol !== undefined && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(protocol)) {
    return `Header mismatch: MCP-Protocol-Version header names ${show(protocol)} but the body has no matching _meta["${META_PROTOCOL_VERSION}"]`;
  }
  return null;
}
