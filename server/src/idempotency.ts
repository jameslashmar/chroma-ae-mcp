/**
 * server/src/idempotency.ts
 *
 * Idempotency keys for write tools, and the list of recent writes (ae_recent_ops).
 *
 * A client that gives up on a write (its own timeout, a dropped connection) and sends it again
 * would run it twice: two layers, two precomps. With the same `idempotency_key` and the same
 * arguments the second call gets the first call's answer instead:
 * - while the first is still running, the second waits for it (it never starts a second write);
 * - once it has finished, the stored answer comes back with `idempotent_replay: true`.
 * The same key with different arguments is refused (`idempotency_key_reused`): it is a client bug,
 * and running either version could be wrong.
 *
 * A write that changed nothing (outcome "not_applied", invalid arguments) is not kept, so sending it
 * again after fixing the cause runs it. Everything else is kept, an "unknown" outcome included:
 * resending that is exactly what must not happen.
 *
 * Module-level, so every request (HTTP, relay, ae_invoke_tool) shares it; at most 200 keys for an
 * hour. A key is scoped to its tool and to the client that sent it (X-Chroma-Client), so two agents
 * that happen to pick the same key never get each other's answer.
 */

import * as crypto from "node:crypto";

export const IDEMPOTENCY_MAX_ENTRIES = 200;
export const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX = 128;
export const RECENT_OPS_MAX = 200;

/** The MCP tool result shape (text content, maybe an error). */
export interface StoredResponse {
  isError?: true;
  content: Array<{ type: "text"; text: string }>;
}

interface Entry {
  hash: string;
  tool: string;
  at: number;
  /** Set while the first call runs; the answer once it is done. */
  pending?: Promise<StoredResponse>;
  response?: StoredResponse;
}

const entries = new Map<string, Entry>();

/** JSON with object keys sorted, so the same arguments in another key order hash the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function argumentsHash(tool: string, key: string, args: unknown): string {
  return crypto.createHash("sha256").update(`${tool}\n${key}\n${stableStringify(args)}`).digest("hex");
}

function prune(now: number): void {
  for (const [k, e] of entries) {
    if (e.pending) continue;
    if (now - e.at > IDEMPOTENCY_TTL_MS) entries.delete(k);
  }
  // Oldest first (Map keeps insertion order); a running call is never dropped.
  for (const [k, e] of entries) {
    if (entries.size <= IDEMPOTENCY_MAX_ENTRIES) break;
    if (!e.pending) entries.delete(k);
  }
}

/** The parsed JSON of a tool result's text, or null. */
export function responseJson(r: StoredResponse | undefined): Record<string, unknown> | null {
  const text = r?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A changed nothing: worth running again rather than replaying. */
function changedNothing(r: StoredResponse): boolean {
  const j = responseJson(r);
  if (!j) return r.isError === true;
  if (j.outcome === "not_applied") return true;
  if (r.isError === true && typeof j.message === "string" && /^Invalid arguments for /.test(j.message)) return true;
  // Refused before the write was sent: quarantine (formatToolError's kind "quarantined"), a busy queue,
  // a target guard. Resending after the cause is gone must run it.
  if (r.isError === true && (j.kind === "quarantined" || j.kind === "queued" || j.kind === "guard")) return true;
  return false;
}

function markReplay(r: StoredResponse, firstAt: number, waited: boolean): StoredResponse {
  const j = responseJson(r);
  const extra = { idempotent_replay: true, first_called_at: new Date(firstAt).toISOString(), ...(waited ? { waited_for_first_call: true } : {}) };
  const text = j ? JSON.stringify({ ...j, ...extra }) : r.content?.[0]?.text ?? "";
  return { ...(r.isError ? { isError: true as const } : {}), content: [{ type: "text", text }] };
}

function refusal(message: string, extra: Record<string, unknown> = {}): StoredResponse {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ kind: "evalscript_error", code: "idempotency_key_reused", outcome: "not_applied", message, ...extra }) }] };
}

/** A key that is not a non-empty string of at most 128 characters: the reason, else null. */
export function badIdempotencyKey(key: unknown): string | null {
  if (typeof key !== "string" || key.trim().length === 0) return "idempotency_key must be a non-empty string.";
  if (key.length > IDEMPOTENCY_KEY_MAX) return `idempotency_key is at most ${IDEMPOTENCY_KEY_MAX} characters.`;
  return null;
}

/**
 * Runs `run` once per (tool, key, arguments). `run` is the whole tool call (validation included)
 * and resolves to its MCP result; it is never rejected (tool errors are results).
 */
export async function withIdempotency(
  tool: string,
  key: string,
  args: unknown,
  run: () => Promise<StoredResponse>,
  now: () => number = Date.now,
  client = ""
): Promise<{ response: StoredResponse; replayed: boolean }> {
  prune(now());
  const id = `${client}\n${tool}\n${key}`;
  const hash = argumentsHash(tool, key, args);
  const found = entries.get(id);
  if (found && found.hash !== hash) {
    return {
      replayed: false,
      response: refusal(
        `idempotency_key "${key.slice(0, 40)}" was already used for a ${tool} call with other arguments (${new Date(found.at).toISOString()}). Nothing was run. Use a new key for a new write; resend the same arguments to get the first answer.`,
        { first_called_at: new Date(found.at).toISOString() }
      ),
    };
  }
  if (found?.pending) {
    const r = await found.pending;
    return { replayed: true, response: markReplay(r, found.at, true) };
  }
  if (found?.response) return { replayed: true, response: markReplay(found.response, found.at, false) };

  const entry: Entry = { hash, tool, at: now() };
  entry.pending = run();
  entries.set(id, entry);
  let response: StoredResponse;
  try {
    response = await entry.pending;
  } catch (err) {
    entries.delete(id);
    throw err;
  }
  entry.pending = undefined;
  if (changedNothing(response)) entries.delete(id);
  else entry.response = response;
  return { replayed: false, response };
}

/** For tests. */
export function resetIdempotency(): void {
  entries.clear();
  recent.length = 0;
}

// ---------- recent writes ----------

export interface RecentOp {
  at: string;
  tool: string;
  ms: number;
  /** applied / no_op / partial / not_applied / unknown; null when the result says nothing. */
  outcome: string | null;
  ok: boolean;
  op_id?: string;
  error?: string;
  code?: string;
  idempotency_key?: string;
  idempotent_replay?: true;
  via?: string;
}

const recent: RecentOp[] = [];

/** What a write result says it did, for the list. */
export function summariseWrite(r: StoredResponse): Pick<RecentOp, "outcome" | "ok" | "op_id" | "error" | "code"> {
  const j = responseJson(r) ?? {};
  let outcome = typeof j.outcome === "string" ? j.outcome : null;
  if (!outcome && r.isError !== true && j.applied === true) outcome = "applied";
  if (!outcome && j.applied === false) outcome = "not_applied";
  // Refused before the handler ran: invalid arguments, an unknown tool.
  if (!outcome && r.isError === true && typeof j.message === "string" && /^(Invalid arguments for |Unknown tool: )/.test(j.message)) outcome = "not_applied";
  const ok = r.isError !== true && j.ok !== false;
  const error = r.isError === true ? String(j.message ?? j.kind ?? "error").slice(0, 200) : j.ok === false ? String(j.message ?? j.error ?? "failed").slice(0, 200) : undefined;
  const code = typeof j.code === "string" ? j.code : r.isError !== true && typeof j.error === "string" ? j.error : undefined;
  return { outcome, ok, ...(typeof j.op_id === "string" ? { op_id: j.op_id } : {}), ...(error ? { error } : {}), ...(code ? { code } : {}) };
}

export function recordRecentOp(op: RecentOp): void {
  recent.push(op);
  if (recent.length > RECENT_OPS_MAX) recent.splice(0, recent.length - RECENT_OPS_MAX);
}

/** Newest first. */
export function recentOps(opts: { limit?: number; tool?: string } = {}): RecentOp[] {
  const list = opts.tool ? recent.filter((o) => o.tool === opts.tool) : recent;
  return list.slice().reverse().slice(0, Math.max(1, Math.min(opts.limit ?? 20, RECENT_OPS_MAX)));
}
