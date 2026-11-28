import { listedTools } from "./tool-families.js";
import { callMetaTool, isMetaTool, metaToolList } from "./meta-tools.js";
import { cancelCall, deliverClientResponse, requestFromClient, runInCall, type CallState } from "./call-context.js";
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
import { getMcpSkill, listMcpSkillResources, listMcpSkills, readMcpSkillFile, SKILL_URI_SCHEME } from "./guidance/mcp-skills.js";
import {
  ALL_PROTOCOL_VERSIONS,
  cacheable,
  classifyRequest,
  clientLabelOf,
  decorateResult,
  LEGACY_PROTOCOL_VERSIONS,
  type ModernClassification,
  type ServerInfo,
} from "./mcp-modern.js";

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
  /** The X-Chroma-Client value (the MCP client's name, sanitised by the relay). Usage log and cancellation scope. */
  client?: string | null;
  /** Sends a notification on this request's response stream (progress); only when the transport streams. */
  notify?: (message: Record<string, unknown>) => void;
  /** The client handles elicitation/create (the relay's X-Chroma-Elicitation header): tools may ask it questions. */
  elicitation?: boolean;
  /**
   * Called when a single (not batched) tools/call starts, with a function that cancels exactly that call (it is
   * marked and stops at its next safe point). The HTTP handler uses it when a 2026-07-28 client closes the connection;
   * looking the call up by client and id instead could hit another session's call with the same label and id.
   */
  onCallStart?: (cancel: (reason: string) => void) => void;
}

/** The tools/list result for a toolset: the full list, or the core list with the three meta-tools first. */
export function listTools(toolset: Toolset): ListedTool[] {
  if (toolset === "core") {
    return [...metaToolList(), ...coreTools().map(trimmedListEntry)];
  }
  return listedTools().map(fullListEntry);
}

/** The initialize-era revisions. The modern revision (2026-07-28) is in mcp-modern.ts; its requests need no initialize. */
export const SUPPORTED_PROTOCOL_VERSIONS = LEGACY_PROTOCOL_VERSIONS;

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "chroma-ae-mcp";
// Kept equal to the repo's VERSION file (test/version.test.ts checks).
export const SERVER_VERSION = "0.7.5";

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

/** What a method implementation answers: a result, or a JSON-RPC error. Both eras wrap it in their own envelope. */
type Outcome = { result: unknown } | { code: number; message: string; data?: unknown };

function respond(id: JsonRpcId, outcome: Outcome): JsonRpcResponse {
  if ("result" in outcome) return { jsonrpc: "2.0", id, result: outcome.result };
  return makeErrorResponse(id, outcome.code, outcome.message, outcome.data);
}

function promptsListPayload(): { prompts: unknown[] } {
  return { prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })) };
}

function promptsGet(params: Record<string, unknown>): Outcome {
  const name = params.name;
  const prompt = typeof name === "string" ? PROMPTS.find((p) => p.name === name) : undefined;
  if (!prompt) {
    return { code: -32602, message: `Invalid params: unknown prompt ${JSON.stringify(name)}. Available: ${PROMPTS.map((p) => p.name).join(", ")}` };
  }
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
    return { code: -32602, message: "Invalid params: `arguments` must be an object" };
  }
  const arg = rawArgs?.[prompt.arguments[0].name];
  if (arg !== undefined && typeof arg !== "string") {
    return { code: -32602, message: `Invalid params: argument \`${prompt.arguments[0].name}\` must be a string` };
  }
  return {
    result: {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: prompt.build(arg) } }],
    },
  };
}

function guidanceResourcesPayload(): { resources: unknown[] } {
  return {
    resources: listGuidanceResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  };
}

/** tools/call for both eras. `elicitation` is only ever true for legacy requests. */
async function toolsCall(
  id: JsonRpcId,
  params: Record<string, unknown>,
  ctx: ToolContext,
  toolset: Toolset,
  client: string | undefined,
  notify: ((message: Record<string, unknown>) => void) | undefined,
  elicitation: boolean | undefined,
  onCallStart?: RpcOptions["onCallStart"]
): Promise<Outcome> {
  const toolName = params.name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { code: -32602, message: "Invalid params: tools/call requires a string `name`" };
  }

  const rawArgs = params.arguments;
  if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
    return { code: -32602, message: "Invalid params: `arguments` must be an object" };
  }

  // Meta-tools answer in either toolset (they are only listed in core). Everything else,
  // listed or not, goes through the one shared path in tool-call.ts.
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const token = meta.progressToken;
  const state: CallState = {
    requestId: id ?? "",
    client: client ?? "",
    cancelled: false,
    progress: 0,
    ...(typeof token === "string" || typeof token === "number" ? { progressToken: token } : {}),
    ...(notify ? { notify } : {}),
    ...(notify && elicitation ? { request: (m: string, p: Record<string, unknown>, ms: number) => requestFromClient(notify, m, p, ms) } : {}),
  };
  onCallStart?.((reason) => {
    state.cancelled = true;
    state.reason = reason.slice(0, 200);
  });
  const result = await runInCall(state, () =>
    isMetaTool(toolName) ? callMetaTool(toolName, rawArgs, ctx, { toolset, client }) : callTool(toolName, rawArgs, ctx, { toolset, client })
  );
  return { result };
}

const SERVER_INFO: ServerInfo = { name: SERVER_NAME, version: SERVER_VERSION };

/**
 * A request of revision 2026-07-28: no initialize, no ping, no server-initiated requests (so a tool call
 * never elicits); answers carry resultType "complete" and the server's identity, and the cacheable ones
 * ttlMs and cacheScope. Anything else is -32601.
 */
async function handleModern(
  id: JsonRpcId,
  method: string,
  params: Record<string, unknown>,
  info: ModernClassification,
  ctx: ToolContext,
  toolset: Toolset,
  client: string | undefined,
  notify: ((message: Record<string, unknown>) => void) | undefined,
  onCallStart?: RpcOptions["onCallStart"]
): Promise<JsonRpcResponse> {
  const done = (payload: Record<string, unknown>): JsonRpcResponse => ({ jsonrpc: "2.0", id, result: decorateResult(payload, SERVER_INFO) });
  const settle = (outcome: Outcome): JsonRpcResponse => ("result" in outcome ? done(outcome.result as Record<string, unknown>) : respond(id, outcome));
  const label = client ?? (clientLabelOf(info) || undefined);

  switch (method) {
    case "server/discover":
      return done(
        cacheable(
          {
            supportedVersions: ALL_PROTOCOL_VERSIONS,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              extensions: { "io.modelcontextprotocol/skills": {} },
            },
            ...(toolset === "core" ? { instructions: coreInstructions() } : {}),
          },
          "private"
        )
      );

    case "tools/list":
      return done(cacheable({ tools: listTools(toolset) }, "private"));

    case "tools/call":
      // No elicitation: this revision has no server-to-client requests, so ae_ask_user falls back to the panel.
      return settle(await toolsCall(id, params, ctx, toolset, label, notify, false, onCallStart));

    case "prompts/list":
      return done(cacheable(promptsListPayload(), "public"));

    case "prompts/get":
      return settle(promptsGet(params));

    case "resources/list":
      // The skill files, named from their frontmatter (ext-skills "Resource Metadata"). The chroma-ae://guidance
      // URIs are still readable through resources/read; the legacy list keeps them.
      return done(cacheable({ resources: listMcpSkillResources() }, "public"));

    case "resources/templates/list":
      return done(cacheable({ resourceTemplates: [] }, "public"));

    case "resources/read": {
      const uri = params.uri;
      if (typeof uri !== "string") {
        return respond(id, { code: -32602, message: "Invalid params: `uri` must be a string" });
      }
      const file = uri.startsWith(SKILL_URI_SCHEME) ? readMcpSkillFile(uri) : readGuidance(uri);
      if (!file) {
        return respond(id, { code: -32602, message: `Resource not found: ${JSON.stringify(uri)}`, data: { uri } });
      }
      return done(cacheable({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }, "public"));
    }

    case "skills/list":
      return done(cacheable({ skills: listMcpSkills() }, "public"));

    case "skills/get": {
      const uri = params.uri;
      if (typeof uri !== "string") {
        return respond(id, { code: -32602, message: "Invalid params: `uri` must be a string" });
      }
      const skill = getMcpSkill(uri);
      if (!skill) {
        return respond(id, { code: -32602, message: `No skill is served at ${uri}`, data: { uri } });
      }
      return done(cacheable({ skill }, "public"));
    }

    default:
      return makeErrorResponse(id, -32601, `Method not found: ${method}`);
  }
}

async function handleSingleRpc(
  message: unknown,
  ctx: ToolContext,
  toolset: Toolset,
  client?: string,
  notify?: (message: Record<string, unknown>) => void,
  elicitation?: boolean,
  onCallStart?: RpcOptions["onCallStart"],
  batched = false
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
  // A client's answer to a request this server sent on a response stream (elicitation/create).
  if (method === undefined && hasId && ("result" in message || "error" in message)) {
    deliverClientResponse(message);
    return null;
  }
  if (typeof method !== "string" || method.length === 0) {
    return makeErrorResponse(id, -32600, "Invalid Request: missing method");
  }

  // Notifications (no `id`) produce no response. notifications/cancelled stops a running call at its next safe point.
  if (!hasId) {
    if (method === "notifications/cancelled" && isPlainObject(message.params)) {
      cancelCall(client ?? "", message.params.requestId, message.params.reason);
    }
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

  // Revision 2026-07-28 requests announce themselves in params._meta; everything else is the legacy switch below.
  const era = classifyRequest(message);
  if (era.era === "error") return era.response;
  if (era.era === "modern") {
    // 2026-07-28 has no JSON-RPC batches: each request is its own message (one HTTP POST, one stdio line).
    if (batched) {
      return makeErrorResponse(id, -32600, `Invalid Request: a ${era.version} request cannot be sent in a JSON-RPC batch; send it on its own`);
    }
    return handleModern(id, method, params, era, ctx, toolset, client, notify, onCallStart);
  }

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
      return respond(id, await toolsCall(id, params, ctx, toolset, client, notify, elicitation));
    }

    case "prompts/list": {
      return { jsonrpc: "2.0", id, result: promptsListPayload() };
    }

    case "prompts/get": {
      return respond(id, promptsGet(params));
    }

    case "resources/list": {
      return { jsonrpc: "2.0", id, result: guidanceResourcesPayload() };
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
      const res = await handleSingleRpc(item, ctx, toolset, client, opts.notify, opts.elicitation, undefined, true);
      if (res !== null) {
        results.push(res);
      }
    }
    return results.length > 0 ? results : null;
  }

  return await handleSingleRpc(parsed, ctx, toolset, client, opts.notify, opts.elicitation, opts.onCallStart);
}
