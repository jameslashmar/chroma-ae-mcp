import { z } from "zod";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { badIdempotencyKey, recordRecentOp, summariseWrite, withIdempotency } from "./idempotency.js";
import { ALL_TOOLS } from "./tools/registry.js";
import { isWriteTool } from "./write-tools.js";
import { errorKindOf, errorTextOf, recordUsage, resultCharsOf, resultFailureOf, runJsxFields, type UsageEntry } from "./usage-log.js";

/** Where a call came from, for the usage log only. */
export interface CallOptions {
  /** The X-Chroma-Toolset value of the request, when known. */
  toolset?: string;
  /** The X-Chroma-Client value of the request (the MCP client's name), when known. */
  client?: string;
  /** ae_invoke_tool sets "ae_invoke_tool"; a direct tools/call is "direct". */
  via?: "direct" | "ae_invoke_tool";
}

/** One line, at most 80 characters: a tool name is echoed in errors, so it must not carry line breaks. */
function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ").trim().slice(0, 80);
}

/** A tool result; structuredContent only with CHROMA_AE_MCP_STRUCTURED=1. */
export type ToolCallResult = (ReturnType<typeof formatToolResponse> | ReturnType<typeof formatToolError>) & { structuredContent?: unknown };

let toolMap = new Map<string, ToolDefinition<any>>();
let mappedKey = "";

/** What the registry looks like now: its length and last name (tests add and remove fake tools). */
export function registryKey(): string {
  return `${ALL_TOOLS.length}:${ALL_TOOLS[ALL_TOOLS.length - 1]?.name ?? ""}`;
}

/** A real tool by exact name (the meta-tools are not in ALL_TOOLS, so they are never found here). */
export function findTool(name: string): ToolDefinition<any> | undefined {
  // Rebuilt when the registry changes (tests add and remove fake tools).
  if (mappedKey !== registryKey()) {
    toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t] as const));
    mappedKey = registryKey();
  }
  return toolMap.get(name);
}

/** The output's numeric `waited_ms` (a wait_seconds call), else undefined. */
function waitedMsOf(output: unknown): number | undefined {
  if (!output || typeof output !== "object") return undefined;
  const w = (output as { waited_ms?: unknown }).waited_ms;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : undefined;
}

/**
 * The one path every tool call takes: tools/call and ae_invoke_tool both end up here, so
 * validation (against the full Zod schema), the handler, the result shape and the service-log
 * line (parseToolLine in panel/client/common.js) are the same, under the real tool's name.
 */
export async function callTool(
  toolName: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext,
  opts: CallOptions = {}
): Promise<ToolCallResult> {
  if (!isWriteTool(toolName)) return callToolOnce(toolName, rawArgs, ctx, opts);
  // A write: an idempotency_key (taken off before validation, so no schema has to declare it)
  // makes a resent call return the first answer; every write is listed for ae_recent_ops.
  const started = Date.now();
  const { idempotency_key: key, ...args } = rawArgs ?? {};
  let response: ToolCallResult;
  let replayed = false;
  if (key === undefined) {
    response = await callToolOnce(toolName, args, ctx, opts);
  } else {
    const bad = badIdempotencyKey(key);
    if (bad) {
      response = formatToolError(new Error(`Invalid arguments for ${toolName}: ${bad}`));
    } else {
      const r = await withIdempotency(toolName, key as string, args, () => callToolOnce(toolName, args, ctx, opts), Date.now, opts.client ?? "");
      response = r.response as ToolCallResult;
      replayed = r.replayed;
    }
  }
  response = withSuccessOutcome(response);
  recordRecentOp({
    at: new Date(started).toISOString(),
    tool: toolName,
    ms: Date.now() - started,
    ...summariseWrite(response),
    ...(typeof key === "string" ? { idempotency_key: key.slice(0, 128) } : {}),
    ...(replayed ? { idempotent_replay: true as const } : {}),
    ...(opts.via && opts.via !== "direct" ? { via: opts.via } : {}),
  });
  return response;
}

/**
 * Every write that succeeded says so the same way: a result with `applied: true` and no `outcome`
 * of its own (tools that do not go through runGuardedWrite) gets `outcome: "applied"`, or "no_op"
 * when it changed nothing. A result that already has an outcome is left as it is.
 */
function withSuccessOutcome(response: ToolCallResult): ToolCallResult {
  if ((response as { isError?: boolean }).isError === true) return response;
  const text = response.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) return response;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return response;
  }
  if (body.outcome !== undefined || body.applied !== true) return response;
  const outcome = body.no_op === true ? "no_op" : "applied";
  return { ...response, content: [{ type: "text", text: JSON.stringify({ ...body, outcome }) }, ...response.content.slice(1)] };
}

/** Off unless CHROMA_AE_MCP_STRUCTURED=1: whether results also carry structuredContent (MCP 2025-06-18). */
export function structuredResultsOn(): boolean {
  return process.env.CHROMA_AE_MCP_STRUCTURED === "1";
}

/** The fields every result object carries (see envelope()), for outputSchema. */
export const ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "The call did what was asked." },
    outcome: { type: "string", enum: ["applied", "no_op", "partial", "not_applied", "unknown"], description: "Writes: what happened to the project." },
    code: { type: "string", description: "Why it failed, machine-readable (invalid_args, guard, not_found, ...)." },
    message: { type: "string" },
    next_steps: { type: "array", items: { type: "string" } },
  },
  required: ["ok"],
  additionalProperties: true,
} as const;

const NOT_APPLIED_CODES = new Set(["invalid_args", "unknown_tool", "quarantined", "queued", "guard"]);

/**
 * One envelope for every result, added to what the tool returned (nothing is moved or renamed):
 * - ok: always there. False for an error, the tool's own ok when it set one, false when it named an
 *   error, else true.
 * - code: on every failure (the tool's code or error, else what kind of error it was).
 * - outcome: on a write's failure when it is certain (refused before anything was sent: not_applied;
 *   a timeout: unknown). Successful writes get theirs in withSuccessOutcome.
 * With CHROMA_AE_MCP_STRUCTURED=1 the same object is also sent as structuredContent.
 */
export function envelope(response: ToolCallResult, toolName: string): ToolCallResult {
  const text = response.content?.[0]?.text;
  let body: Record<string, unknown> | null = null;
  if (typeof text === "string" && text.startsWith("{")) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) body = v as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  if (!body) {
    if (!structuredResultsOn() || typeof text !== "string") return response;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return { ...response, structuredContent: { ok: (response as { isError?: boolean }).isError !== true, result: value } } as ToolCallResult;
  }
  const isError = (response as { isError?: boolean }).isError === true;
  const message = typeof body.message === "string" ? body.message : "";
  let ok: boolean;
  if (isError) ok = false;
  else if (typeof body.ok === "boolean") ok = body.ok;
  else ok = !(typeof body.error === "string" && body.error.length > 0);
  const extra: Record<string, unknown> = {};
  if (!ok && typeof body.code !== "string") {
    if (/^Invalid arguments for /.test(message)) extra.code = "invalid_args";
    else if (/^Unknown tool: /.test(message)) extra.code = "unknown_tool";
    else if (typeof body.error === "string" && body.error) extra.code = body.error;
    else if (typeof body.kind === "string" && body.kind) extra.code = body.kind;
    else extra.code = "error";
  }
  const code = (extra.code ?? body.code) as string | undefined;
  if (!ok && body.outcome === undefined && isWriteTool(toolName)) {
    if (code && NOT_APPLIED_CODES.has(code)) extra.outcome = "not_applied";
    else if (code === "timeout" || body.kind === "timeout") extra.outcome = "unknown";
  }
  const out = { ok, ...extra, ...body, ...(body.ok === undefined ? {} : { ok }) };
  const next: ToolCallResult = { ...response, content: [{ type: "text", text: JSON.stringify(out) }, ...response.content.slice(1)] } as ToolCallResult;
  if (structuredResultsOn()) (next as { structuredContent?: unknown }).structuredContent = out;
  return next;
}

async function callToolOnce(
  toolName: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext,
  opts: CallOptions = {}
): Promise<ToolCallResult> {
  const via = opts.via ?? "direct";
  const usage = (e: Pick<UsageEntry, "ms" | "ok" | "errorKind" | "error" | "resultOk" | "resultKind" | "resultError" | "waitedMs">, extra?: Partial<UsageEntry>, response?: ToolCallResult) =>
    recordUsage(ctx, { tool: toolName, toolset: opts.toolset, client: opts.client, via, ...extra, ...e, resultChars: resultCharsOf(response) });
  const tool = findTool(toolName);
  if (!tool) {
    const response = envelope(formatToolError(new Error(`Unknown tool: ${oneLine(toolName)}`)), toolName);
    usage({ ms: 0, ok: false, errorKind: "unknown_tool", error: "Unknown tool" }, undefined, response);
    return response;
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  const extra = toolName === "ae_run_jsx" ? runJsxFields(parsed.success ? parsed.data : rawArgs) : undefined;
  if (!parsed.success) {
    const why = `Invalid arguments for ${toolName}: ${parsed.error.issues
      .map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")}`;
    const response = envelope(formatToolError(new Error(why)), toolName);
    usage({ ms: 0, ok: false, errorKind: "invalid_args", error: why }, extra, response);
    return response;
  }

  // One line per tool call in the service log. The panel's tiles, reply-time
  // chart and Log are built from these lines (panel/client/common.js, parseToolLine).
  const started = Date.now();
  try {
    const output = await tool.handler(parsed.data, ctx);
    ctx.log?.("ok", `tool ${toolName} ok (${Date.now() - started}ms)`);
    // `ok` means no MCP error. A handler that returns { ok: false } without throwing is a failure the report must see.
    const failure = resultFailureOf(output);
    const waitedMs = waitedMsOf(output);
    const response = envelope(formatToolResponse(output), toolName);
    usage(
      failure
        ? { ms: Date.now() - started, ok: true, resultOk: false, resultKind: failure.kind, resultError: failure.error, waitedMs }
        : { ms: Date.now() - started, ok: true, waitedMs },
      extra,
      response
    );
    return response;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
    ctx.log?.("err", `tool ${toolName} failed (${Date.now() - started}ms): ${why}`);
    const response = envelope(formatToolError(err), toolName);
    usage({ ms: Date.now() - started, ok: false, errorKind: errorKindOf(err), error: errorTextOf(err) }, extra, response);
    return response;
  }
}
