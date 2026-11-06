import { z } from "zod";
import { zodToJsonSchema } from "./schema.js";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";
import { captionsSkillBody, listGuidanceResources, readGuidance, reviewBody, skillBody } from "./guidance/index.js";

export { ALL_TOOLS };

interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  build: (arg: string | undefined) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "motion_director",
    description:
      "Motion director guidance: brief, numeric spec, stills, choreography, sound, review and delivery, with measured timing, easing and stagger rules.",
    arguments: [{ name: "task", description: "What you are about to make or fix (optional).", required: false }],
    build: (task) => skillBody() + (task && task.trim() ? `\n\nTask: ${task.trim()}\n` : ""),
  },
  {
    name: "motion_review",
    description: "Motion review checklist: measure the comp first, then judge by eye.",
    arguments: [{ name: "comp", description: "Name or id of the comp to review (optional).", required: false }],
    build: (comp) => reviewBody() + (comp && comp.trim() ? `\n\nComp to review: ${comp.trim()}\n` : ""),
  },
  {
    name: "captions",
    description:
      "Captions guidance: standards (Netflix, BBC, DCMP), reading speed, line and shot-change rules, SDH, platform safe zones, ASR clean-up, file formats, and the chroma-ae caption tools.",
    arguments: [{ name: "task", description: "What you are captioning or checking (optional).", required: false }],
    build: (task) => captionsSkillBody() + (task && task.trim() ? `\n\nTask: ${task.trim()}\n` : ""),
  },
];

const TOOL_MAP = new Map<string, ToolDefinition<any>>(
  ALL_TOOLS.map((t) => [t.name, t])
);

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "chroma-ae-mcp";
// Kept equal to the repo's VERSION file (test/version.test.ts checks).
export const SERVER_VERSION = "0.6.0";

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function makeErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

async function handleSingleRpc(
  message: unknown,
  ctx: ToolContext
): Promise<JsonRpcResponse | null> {
  if (!isPlainObject(message)) {
    return makeErrorResponse(null, -32600, "Invalid Request");
  }

  const hasId = "id" in message && message.id !== undefined;
  const rawId = message.id;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" || rawId === null
      ? rawId
      : null;

  const method = message.method;
  if (typeof method !== "string" || method.length === 0) {
    return makeErrorResponse(id, -32600, "Invalid Request: missing method");
  }

  // Notifications (no `id`) produce no response.
  if (!hasId) {
    return null;
  }

  const rawParams = message.params;
  if (rawParams !== undefined && !isPlainObject(rawParams)) {
    return makeErrorResponse(
      id,
      -32602,
      "Invalid params: expected an object"
    );
  }
  const params: Record<string, unknown> = rawParams ?? {};

  switch (method) {
    case "initialize": {
      const clientVersion =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : undefined;
      const protocolVersion =
        clientVersion &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
          clientVersion
        )
          ? clientVersion
          : DEFAULT_PROTOCOL_VERSION;

      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
            prompts: {
              listChanged: false,
            },
            resources: {
              subscribe: false,
              listChanged: false,
            },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        },
      };
    }

    case "ping": {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: ALL_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: zodToJsonSchema(t.schema),
          })),
        },
      };
    }

    case "tools/call": {
      const toolName = params.name;
      if (typeof toolName !== "string" || toolName.length === 0) {
        return makeErrorResponse(
          id,
          -32602,
          "Invalid params: tools/call requires a string `name`"
        );
      }

      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
        return makeErrorResponse(
          id,
          -32602,
          "Invalid params: `arguments` must be an object"
        );
      }

      const tool = TOOL_MAP.get(toolName);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(new Error(`Unknown tool: ${toolName}`)),
        };
      }

      const parsed = tool.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(
            new Error(
              `Invalid arguments for ${toolName}: ${parsed.error.issues
                .map(
                  (i: z.ZodIssue) =>
                    `${i.path.join(".") || "<root>"}: ${i.message}`
                )
                .join("; ")}`
            )
          ),
        };
      }

      // One line per tool call in the service log. The panel's tiles, reply-time
      // chart and Log are built from these lines (panel/client/common.js, parseToolLine).
      const started = Date.now();
      try {
        const output = await tool.handler(parsed.data, ctx);
        ctx.log?.("ok", `tool ${toolName} ok (${Date.now() - started}ms)`);
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolResponse(output),
        };
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
        ctx.log?.("err", `tool ${toolName} failed (${Date.now() - started}ms): ${why}`);
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(err),
        };
      }
    }

    case "prompts/list": {
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })) } };
    }

    case "prompts/get": {
      const name = params.name;
      const prompt = typeof name === "string" ? PROMPTS.find((p) => p.name === name) : undefined;
      if (!prompt) {
        return makeErrorResponse(id, -32602, `Invalid params: unknown prompt ${JSON.stringify(name)}. Available: ${PROMPTS.map((p) => p.name).join(", ")}`);
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
        return makeErrorResponse(id, -32602, "Invalid params: `arguments` must be an object");
      }
      const arg = rawArgs?.[prompt.arguments[0].name];
      if (arg !== undefined && typeof arg !== "string") {
        return makeErrorResponse(id, -32602, `Invalid params: argument \`${prompt.arguments[0].name}\` must be a string`);
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: prompt.description,
          messages: [{ role: "user", content: { type: "text", text: prompt.build(arg) } }],
        },
      };
    }

    case "resources/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: listGuidanceResources().map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        },
      };
    }

    case "resources/read": {
      const uri = params.uri;
      if (typeof uri !== "string") {
        return makeErrorResponse(id, -32602, "Invalid params: `uri` must be a string");
      }
      const res = readGuidance(uri);
      if (!res) {
        // -32002: resource not found (MCP spec).
        return makeErrorResponse(id, -32002, `Resource not found: ${JSON.stringify(uri)}. Use resources/list.`);
      }
      return { jsonrpc: "2.0", id, result: { contents: [{ uri: res.uri, mimeType: res.mimeType, text: res.text }] } };
    }

    default: {
      return makeErrorResponse(
        id,
        -32601,
        `Method not found: ${method}`
      );
    }
  }
}

/**
 * Pure JSON-RPC MCP handler.
 * Accepts either an already-parsed JSON message (object or batch array) or a raw JSON string.
 */
export async function handleRpc(
  message: unknown,
  ctx: ToolContext
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  let parsed: unknown = message;
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message);
    } catch {
      return makeErrorResponse(null, -32700, "Parse error");
    }
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return makeErrorResponse(null, -32600, "Invalid Request: empty batch");
    }
    const results: JsonRpcResponse[] = [];
    for (const item of parsed) {
      const res = await handleSingleRpc(item, ctx);
      if (res !== null) {
        results.push(res);
      }
    }
    return results.length > 0 ? results : null;
  }

  return await handleSingleRpc(parsed, ctx);
}
