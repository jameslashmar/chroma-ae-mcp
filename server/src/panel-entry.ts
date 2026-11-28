import type { IncomingMessage, ServerResponse } from "node:http";
import { AskStore } from "./asks.js";
import { AssetWatcher } from "./tools/ext/assets.js";
import { writeDiagnostics } from "./tools/ext/diagnostics.js";
import { describeBlockingDialogs, listDialogsForWatcher, markShown, respondToDialog, startDialogWatch } from "./tools/ext/dialogs.js";
import { clientRequestChannel } from "./call-context.js";
import {
  classifyRequest,
  clientLabelOf,
  bodyVersionHeaderMismatch,
  ERR_HEADER_MISMATCH,
  idOf,
  legacyBodyWithModernHeader,
  sanitizeClientLabel,
  validateModernHeaders,
} from "./mcp-modern.js";
import { PopupCenter } from "./popups.js";
import * as path from "node:path";
import { handleRpc, type JsonRpcResponse } from "./mcp-rpc.js";
import { CLIENT_HEADER, parseToolset, TOOLSET_HEADER } from "./toolsets.js";
import { PanelHost, type PanelEvalScriptFn } from "./panel-host.js";
import { defaultDataDir, QuarantineStore } from "./quarantine.js";
import { SingleWriterQueue } from "./queue.js";
import { renderGate, renderGateMessage, type RenderGateInfo } from "./render-gate.js";
import { SettingsStore } from "./settings.js";
import { installSessionBridgeHook, installSessionTracking } from "./tools/ext/session.js";
import type { CepBridge, ToolContext } from "./tools/common.js";

export { handleRpc, PanelHost, type JsonRpcResponse, type PanelEvalScriptFn };

export interface CreatePanelMcpOptions {
  evalScript: PanelEvalScriptFn;
  dataDir?: string;
  log?: (level: string, msg: string) => void;
  cep?: CepBridge;
  /** Start the asset watcher's timer (default true; tests turn it off). */
  watchAssets?: boolean;
  /** The service's own state for ae_diagnostics (versions, eval queue, log paths). */
  serviceInfo?: () => Record<string, unknown>;
  /** Track what the user changes between the agent's writes (ae_session_changes). Default true. */
  sessionTracking?: boolean;
  /**
   * Watch After Effects' popups as they appear (popups.ts): ask the user about them, press a one-button popup
   * our own operation raised, report each on the next tool result. Default false; the service turns it on.
   */
  watchPopups?: boolean;
}

export interface HttpRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
}

export interface HttpResponseLike {
  statusCode?: number;
  writableEnded?: boolean;
  setHeader?: (name: string, value: string) => void;
  writeHead?: (statusCode: number, headers?: Record<string, string>) => void;
  /** For the event-stream reply (progress notifications). */
  write?: (chunk: string) => unknown;
  end: (body?: string) => void;
  /** 'close' fires when the connection ends; a modern client cancels a tools/call by closing it. */
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
}

function sendResponse(
  res: HttpResponseLike,
  statusCode: number,
  headers: Record<string, string>,
  body: string
): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  if (typeof res.setHeader === "function") {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
  } else if (typeof res.writeHead === "function") {
    res.writeHead(statusCode, headers);
  }
  res.end(body);
}

function readRequestBody(req: HttpRequestLike): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof req.on !== "function") {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      );
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export function createPanelMcp(opts: CreatePanelMcpOptions): {
  handleHttp: (
    req: IncomingMessage | HttpRequestLike,
    res: ServerResponse | HttpResponseLike,
    bodyText?: string
  ) => Promise<void>;
  ctx: ToolContext;
  host: PanelHost;
  /** Questions for the panel: service.js serves them on GET /ask and POST /ask/answer. */
  asks: AskStore;
  assetWatcher: AssetWatcher;
  /** Stops what keeps running on its own (the asset watcher's evalScript polling); the service calls it when it shuts down. */
  stop: () => void;
  /** For the panel's Save diagnostics button (POST /admin/diagnostics). */
  saveDiagnostics: () => Promise<{ path: string; summary: Record<string, unknown> }>;
  /** The render gate while it is shut (ae_render_queue_render), with the message tools get; null when open. service.js refuses POST /eval and shows the panel's "Clear render lock" button from it. */
  renderLock: () => { info: RenderGateInfo; message: string } | null;
  /** The user's way out of a render gate that will not lift (the panel's button). Returns the cleared gate, or null when it was open. */
  clearRenderLock: () => RenderGateInfo | null;
  /** The panel's "Ask first" button (GET / POST /admin/plan): whether ae_plan asks the user before a task. */
  planSettings: () => { ask_first: boolean };
  setAskFirst: (on: boolean) => { ask_first: boolean };
} {
  const resolvedDataDir = opts.dataDir ?? defaultDataDir();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(
    path.join(resolvedDataDir, "quarantine.json")
  );
  const host = new PanelHost({
    evalScript: opts.evalScript,
    queue,
    quarantine,
    describeDialogs: describeBlockingDialogs,
    serviceInfo: opts.serviceInfo,
  });
  const ctx: ToolContext = {
    bridge: host,
    queue,
    quarantine,
    cep: opts.cep,
    settings: new SettingsStore(path.join(resolvedDataDir, "settings.json")),
    asks: new AskStore(),
    dataDir: resolvedDataDir,
    serviceInfo: opts.serviceInfo,
    log: opts.log,
  };

  // After a render call timed out the gate stays shut until the panel service has nothing in flight again.
  renderGate.setIdleProbe(() => {
    const info = opts.serviceInfo?.();
    return info !== undefined && "inFlight" in info && info.inFlight === null;
  });

  // What the user changed between the agent's writes, and a write-ahead record
  // so a write cut short by an AE crash is reported rather than retried.
  if (opts.sessionTracking !== false) {
    try {
      installSessionTracking({ dataDir: resolvedDataDir, quarantine });
      installSessionBridgeHook(host);
    } catch (err) {
      opts.log?.("WARN", `Session tracking is off: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const log = opts.log;
  // Polls only while ae_import_assets { watch: true } has turned it on.
  const assetWatcher = new AssetWatcher(ctx, { log });
  if (opts.watchAssets !== false) assetWatcher.start();

  const popups = new PopupCenter({
    list: listDialogsForWatcher,
    markShown,
    respond: respondToDialog,
    asks: ctx.asks,
    clientChannel: clientRequestChannel,
    log,
  });
  ctx.popups = popups;
  if (opts.watchPopups === true) popups.start((onChange) => startDialogWatch(onChange, log));

  const warnedToolsets = new Set<string>();

  async function handleHttp(
    req: IncomingMessage | HttpRequestLike,
    res: ServerResponse | HttpResponseLike,
    bodyText?: string
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();

    if (method !== "POST") {
      sendResponse(
        res,
        405,
        {
          Allow: "POST",
          "Content-Type": "application/json",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Method Not Allowed. Use POST /mcp.",
          },
        })
      );
      return;
    }

    let rawBody: string;
    if (typeof bodyText === "string") {
      rawBody = bodyText;
    } else {
      try {
        rawBody = await readRequestBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (log) log("err", `MCP HTTP body read error: ${msg}`);
        sendResponse(
          res,
          400,
          { "Content-Type": "application/json" },
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: `Parse error: ${msg}`,
            },
          })
        );
        return;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      if (log) log("warn", "MCP received invalid JSON body");
      sendResponse(
        res,
        200,
        { "Content-Type": "application/json" },
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        })
      );
      return;
    }

    // The stdio relay sends X-Chroma-Toolset on every request (the service is stateless).
    // A missing header, or any value but "core", is the full list.
    const headerValue = req.headers?.[TOOLSET_HEADER];
    const choice = parseToolset(headerValue);
    if (choice.invalid) {
      const shown = String(Array.isArray(headerValue) ? headerValue[0] : headerValue).slice(0, 40);
      if (!warnedToolsets.has(shown)) {
        warnedToolsets.add(shown);
        log?.("warn", `Unknown toolset "${shown}" in X-Chroma-Toolset; serving the core tool list`);
      }
    }
    // Which MCP revision a single request speaks (mcp-modern.ts). A malformed modern request, or a
    // modern-only method without its _meta, is answered here with a 400; the legacy path is untouched.
    const single = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    // A 2026-07-28 POST body is a single message ("Sending Messages"): a batch holding a 2026-07-28 request would
    // skip every header rule, so the whole POST is refused. Legacy batches are served as before.
    if (Array.isArray(parsed) && parsed.some((item) => classifyRequest(item).era === "modern")) {
      sendResponse(
        res,
        400,
        { "Content-Type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: a 2026-07-28 request must be the only message in its POST body, not part of a JSON-RPC batch" } })
      );
      return;
    }
    // "Protocol Version Header": the header must equal the body's _meta version, whatever that value is; this is
    // checked before the version itself is judged (so an unknown body version with a mismatching header is -32020).
    const versionMismatch = single && single.id !== undefined ? bodyVersionHeaderMismatch(req.headers, single) : null;
    if (versionMismatch !== null) {
      sendResponse(
        res,
        400,
        { "Content-Type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: idOf(single as Record<string, unknown>), error: { code: ERR_HEADER_MISMATCH, message: versionMismatch } })
      );
      return;
    }
    const era = classifyRequest(single);
    if (era.era === "error") {
      sendResponse(res, era.httpStatus, { "Content-Type": "application/json" }, JSON.stringify(era.response));
      return;
    }
    const isRequest = !!single && typeof single.method === "string" && single.method.length > 0 && single.id !== undefined;
    let headerProblem: string | null = null;
    if (era.era === "modern" && single) {
      const check = validateModernHeaders(req.headers, { method: String(single.method), params: single.params }, era.version);
      if (!check.ok) headerProblem = check.message;
    } else if (isRequest) {
      headerProblem = legacyBodyWithModernHeader(req.headers);
    }
    if (headerProblem !== null) {
      sendResponse(
        res,
        400,
        { "Content-Type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: idOf(single as Record<string, unknown>), error: { code: ERR_HEADER_MISMATCH, message: headerProblem } })
      );
      return;
    }
    const modern = era.era === "modern";

    const clientHeader = req.headers?.[CLIENT_HEADER];
    // The header wins; a modern request without it is labelled by its _meta clientInfo.name.
    const client =
      sanitizeClientLabel(String(Array.isArray(clientHeader) ? clientHeader[0] : clientHeader ?? "")) || (era.era === "modern" ? clientLabelOf(era) : "");
    // A tools/call that asks for progress (_meta.progressToken) from a client that takes an event stream is
    // answered as one: a notifications/progress event per After Effects eval, then the result. Everything
    // else stays a single JSON reply.
    const accept = String(req.headers?.accept ?? "");
    const p = parsed as { method?: unknown; params?: { _meta?: { progressToken?: unknown } } };
    const isCall = !!p && !Array.isArray(parsed) && p.method === "tools/call";
    const token = isCall ? p.params?._meta?.progressToken : undefined;
    // The relay says the client handles elicitation/create; a call can then ask it questions on its stream.
    // Revision 2026-07-28 has no server-to-client requests, so the header is ignored for it.
    const elicitHeader = req.headers?.["x-chroma-elicitation"];
    const elicitation = !modern && isCall && String(Array.isArray(elicitHeader) ? elicitHeader[0] : elicitHeader ?? "") === "1";
    // Streamable HTTP "Cancellation": a modern client cancels a call by closing the connection. The hook cancels
    // exactly this call (not whichever call shares its client label and id). The call is only marked; it stops at
    // its next safe point (an eval already sent to After Effects is never abandoned).
    let cancelThisCall: ((reason: string) => void) | null = null;
    let closedEarly = false;
    const onCallStart =
      modern && isCall
        ? (cancel: (reason: string) => void) => {
            cancelThisCall = cancel;
            if (closedEarly) cancel("the client closed the connection");
          }
        : undefined;
    if (onCallStart && typeof res.on === "function") {
      res.on("close", () => {
        if (res.writableEnded) return;
        closedEarly = true;
        if (cancelThisCall) cancelThisCall("the client closed the connection");
      });
    }
    if ((typeof token === "string" || typeof token === "number" || elicitation) && /text\/event-stream/i.test(accept) && typeof res.write === "function" && typeof res.setHeader === "function") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      // 2026-07-28 streamable HTTP: SHOULD, so proxies do not hold the progress events back.
      if (modern) res.setHeader("X-Accel-Buffering", "no");
      const event = (msg: unknown) => {
        if (!res.writableEnded) res.write?.(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const streamed = await handleRpc(parsed, ctx, { toolset: choice.toolset, client: client || undefined, notify: event, elicitation, ...(onCallStart ? { onCallStart } : {}) });
      if (streamed) event(streamed);
      if (!res.writableEnded) res.end();
      return;
    }
    const rpcResponse = await handleRpc(parsed, ctx, { toolset: choice.toolset, client: client || undefined, ...(onCallStart ? { onCallStart } : {}) });

    if (
      rpcResponse === null ||
      (Array.isArray(rpcResponse) && rpcResponse.length === 0)
    ) {
      if (!res.writableEnded) {
        res.statusCode = 202;
        res.end("");
      }
      return;
    }

    // A modern request for a method this revision lacks (initialize, ping, ...) is a 404; every other answer,
    // errors included, is a 200 so a dual-era client never mistakes it for a legacy server.
    const notFound = modern && !Array.isArray(rpcResponse) && "error" in rpcResponse && rpcResponse.error.code === -32601;
    sendResponse(
      res,
      notFound ? 404 : 200,
      { "Content-Type": "application/json" },
      JSON.stringify(rpcResponse)
    );
  }

  return {
    handleHttp,
    ctx,
    host,
    asks: ctx.asks as AskStore,
    assetWatcher,
    stop: () => {
      assetWatcher.stop();
      popups.stop();
    },
    saveDiagnostics: () => writeDiagnostics(ctx, opts.serviceInfo?.()),
    renderLock: () => {
      const info = renderGate.active();
      return info ? { info, message: renderGateMessage(info) } : null;
    },
    clearRenderLock: () => renderGate.clear(),
    planSettings: () => ({ ask_first: (ctx.settings as SettingsStore).get().plan.ask_first }),
    setAskFirst: (on: boolean) => ({ ask_first: (ctx.settings as SettingsStore).updatePlan({ ask_first: on }).plan.ask_first }),
  };
}
