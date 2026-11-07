import { z } from "zod";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";

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

/**
 * The one path every tool call takes: tools/call and ae_invoke_tool both end up here, so
 * validation (against the full Zod schema), the handler, the result shape and the service-log
 * line (parseToolLine in panel/client/common.js) are the same, under the real tool's name.
 */
export async function callTool(
  toolName: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext
): Promise<ToolCallResult> {
  const tool = findTool(toolName);
  if (!tool) {
    return formatToolError(new Error(`Unknown tool: ${oneLine(toolName)}`));
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return formatToolError(
      new Error(
        `Invalid arguments for ${toolName}: ${parsed.error.issues
          .map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`
      )
    );
  }

  // One line per tool call in the service log. The panel's tiles, reply-time
  // chart and Log are built from these lines (panel/client/common.js, parseToolLine).
  const started = Date.now();
  try {
    const output = await tool.handler(parsed.data, ctx);
    ctx.log?.("ok", `tool ${toolName} ok (${Date.now() - started}ms)`);
    return formatToolResponse(output);
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
    ctx.log?.("err", `tool ${toolName} failed (${Date.now() - started}ms): ${why}`);
    return formatToolError(err);
  }
}
