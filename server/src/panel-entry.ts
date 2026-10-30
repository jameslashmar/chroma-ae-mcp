import type { IncomingMessage, ServerResponse } from "node:http";
import { AskStore } from "./asks.js";
import { AssetWatcher } from "./tools/ext/assets.js";
import { writeDiagnostics } from "./tools/ext/diagnostics.js";
import { describeBlockingDialogs } from "./tools/ext/dialogs.js";
import * as path from "node:path";
import { handleRpc, type JsonRpcResponse } from "./mcp-rpc.js";
import { PanelHost, type PanelEvalScriptFn } from "./panel-host.js";
import { defaultDataDir, QuarantineStore } from "./quarantine.js";
import { SingleWriterQueue } from "./queue.js";
import { SettingsStore } from "./settings.js";
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
  end: (body?: string) => void;
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
  /** For the panel's Save diagnostics button (POST /admin/diagnostics). */
  saveDiagnostics: () => Promise<{ path: string; summary: Record<string, unknown> }>;
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
  };

  const log = opts.log;
  // Polls only while ae_import_assets { watch: true } has turned it on.
  const assetWatcher = new AssetWatcher(ctx, { log });
  if (opts.watchAssets !== false) assetWatcher.start();

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

    const rpcResponse = await handleRpc(parsed, ctx);

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

    sendResponse(
      res,
      200,
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
    saveDiagnostics: () => writeDiagnostics(ctx, opts.serviceInfo?.()),
  };
}
