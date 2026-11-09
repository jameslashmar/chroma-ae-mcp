import { callMetaTool, isMetaTool, metaToolList } from "./meta-tools.js";
import { callTool } from "./tool-call.js";
import {
  coreInstructions,
  coreTools,
  fullListEntry,
  parseToolset,
  trimmedListEntry,
  type ListedTool,
  type Toolset,
} from "./toolsets.js";
import type { ToolContext } from "./tools/common.js";
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

/** Per-request options. `toolset` comes from the X-Chroma-Toolset header (see toolsets.ts). */
export interface RpcOptions {
  toolset?: Toolset | string | null;
  /** The X-Chroma-Client value (the MCP client's name, sanitised by the relay). Usage log only. */
  client?: string | null;
}

/** The tools/list result for a toolset: the full list, or the core list with the three meta-tools first. */
export function listTools(toolset: Toolset): ListedTool[] {
  if (toolset === "core") {
    return [...metaToolList(), ...coreTools().map(trimmedListEntry)];
  }
  return ALL_TOOLS.map(fullListEntry);
}

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "chroma-ae-mcp";
// Kept equal to the repo's VERSION file (test/version.test.ts checks).
export const SERVER_VERSION = "0.7.2";

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
  ctx: ToolContext,
  toolset: Toolset,
  client?: string
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
          // Full mode sends no instructions (as before); core mode carries the safety text once,
          // how to use the meta-tools and the group index.
          ...(toolset === "core" ? { instructions: coreInstructions() } : {}),
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
          tools: listTools(toolset),
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

      // Meta-tools answer in either toolset (they are only listed in core). Everything else,
      // listed or not, goes through the one shared path in tool-call.ts.
      const result = isMetaTool(toolName)
        ? await callMetaTool(toolName, rawArgs, ctx, { toolset, client })
        : await callTool(toolName, rawArgs, ctx, { toolset, client });
      return { jsonrpc: "2.0", id, result };
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
  ctx: ToolContext,
  opts: RpcOptions = {}
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  // Any value but "core" (including a bad one) behaves as full.
  const toolset = parseToolset(opts.toolset).toolset;
  const client = typeof opts.client === "string" && opts.client.trim() ? opts.client : undefined;
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
      const res = await handleSingleRpc(item, ctx, toolset, client);
      if (res !== null) {
        results.push(res);
      }
    }
    return results.length > 0 ? results : null;
  }

  return await handleSingleRpc(parsed, ctx, toolset, client);
}
