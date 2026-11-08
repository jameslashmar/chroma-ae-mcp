import { z } from "zod";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";
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

export type ToolCallResult = ReturnType<typeof formatToolResponse> | ReturnType<typeof formatToolError>;

let toolMap = new Map<string, ToolDefinition<any>>();
let mappedCount = -1;

/** A real tool by exact name (the meta-tools are not in ALL_TOOLS, so they are never found here). */
export function findTool(name: string): ToolDefinition<any> | undefined {
  // Rebuilt when the registry changes length (tests add a fake tool to ALL_TOOLS).
  if (mappedCount !== ALL_TOOLS.length) {
    toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t] as const));
    mappedCount = ALL_TOOLS.length;
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
  const via = opts.via ?? "direct";
  const usage = (e: Pick<UsageEntry, "ms" | "ok" | "errorKind" | "error" | "resultOk" | "resultKind" | "resultError" | "waitedMs">, extra?: Partial<UsageEntry>, response?: ToolCallResult) =>
    recordUsage(ctx, { tool: toolName, toolset: opts.toolset, client: opts.client, via, ...extra, ...e, resultChars: resultCharsOf(response) });
  const tool = findTool(toolName);
  if (!tool) {
    const response = formatToolError(new Error(`Unknown tool: ${oneLine(toolName)}`));
    usage({ ms: 0, ok: false, errorKind: "unknown_tool", error: "Unknown tool" }, undefined, response);
    return response;
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  const extra = toolName === "ae_run_jsx" ? runJsxFields(parsed.success ? parsed.data : rawArgs) : undefined;
  if (!parsed.success) {
    const why = `Invalid arguments for ${toolName}: ${parsed.error.issues
      .map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")}`;
    const response = formatToolError(new Error(why));
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
    const response = formatToolResponse(output);
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
    const response = formatToolError(err);
    usage({ ms: Date.now() - started, ok: false, errorKind: errorKindOf(err), error: errorTextOf(err) }, extra, response);
    return response;
  }
}
