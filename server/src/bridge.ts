import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BridgeError,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  normalizeErrorKind,
  SLOW_TIMEOUT_MS,
  type BridgeErrorDetail,
  type BridgeErrorKind,
  type CallHostOptions,
  type EvalErrorResponse,
  type EvalResponse,
  type EvalSuccessResponse,
  type HostTransport,
  type PanelHealth,
} from "./host.js";
import { buildJsxCall, type HostFunctionName } from "./jsx.js";
import { defaultDataDir, type QuarantineStore } from "./quarantine.js";
import { QueueWaitError, type SingleWriterQueue } from "./queue.js";

export {
  BridgeError,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  normalizeErrorKind,
  SLOW_TIMEOUT_MS,
  type BridgeErrorDetail,
  type BridgeErrorKind,
  type CallHostOptions,
  type EvalErrorResponse,
  type EvalResponse,
  type EvalSuccessResponse,
  type HostTransport,
  type PanelHealth,
};

export function resolveBridgePort(): number {
  const raw = process.env.CHROMA_AE_MCP_PORT?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) {
      return n;
    }
  }
  return DEFAULT_BRIDGE_PORT;
}

export function defaultTokenFilePath(): string {
  return path.join(defaultDataDir(), "token");
}

/**
 * Reads the bridge token file on every connect attempt.
 */
export function readBridgeToken(
  tokenPath: string = defaultTokenFilePath()
): string {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch (err) {
    throw new BridgeError({
      kind: "unreachable",
      message: `Cannot read bridge token at ${tokenPath} (${
        (err as Error).message
      }). Open After Effects and ensure Window > Extensions > Chroma AE MCP is open.`,
    });
  }
}

function isFetchTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  return (
    e.name === "TimeoutError" ||
    e.name === "AbortError" ||
    e.code === "ABORT_ERR" ||
    Boolean(e.message && /timed?\s*out/i.test(e.message))
  );
}

export interface BridgeClientOptions {
  port?: number;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  queue?: SingleWriterQueue;
  quarantine?: QuarantineStore;
}

export class BridgeClient implements HostTransport {
  readonly port: number;
  readonly baseUrl: string;
  private readonly tokenPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly queue?: SingleWriterQueue;
  private readonly quarantine?: QuarantineStore;

  constructor(opts: BridgeClientOptions = {}) {
    this.port = opts.port ?? resolveBridgePort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.tokenPath = opts.tokenPath ?? defaultTokenFilePath();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.queue = opts.queue;
    this.quarantine = opts.quarantine;
  }

  newOpId(): string {
    return `op_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  private buildHeaders(): Record<string, string> {
    const token = readBridgeToken(this.tokenPath);
    if (!token) {
      throw new BridgeError({
        kind: "unreachable",
        message: `Bridge token file at ${this.tokenPath} is empty. Open Window > Extensions > Chroma AE MCP in After Effects.`,
      });
    }
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * GET /health — checks the CEP panel's HTTP server.
   */
  async health(timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<PanelHealth> {
    const headers = this.buildHeaders();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isFetchTimeout(err)) {
        throw new BridgeError({
          kind: "timeout",
          message: `GET /health timed out after ${Math.round(
            timeoutMs / 1000
          )}s. After Effects may be busy executing a synchronous script or showing a modal dialog.`,
        });
      }
      throw new BridgeError({
        kind: "unreachable",
        message: `Panel unreachable on 127.0.0.1:${this.port} (${
          (err as Error).message
        }). Open Window > Extensions > Chroma AE MCP in After Effects.`,
      });
    }

    if (!res.ok) {
      throw new BridgeError({
        kind: "unreachable",
        message: `Panel /health returned HTTP ${res.status}. Open Window > Extensions > Chroma AE MCP in After Effects.`,
      });
    }

    return (await res.json()) as PanelHealth;
  }

  /**
   * Raw POST /eval without queue acquisition (used internally inside a queue lease).
   * Never resends on timeout.
   */
  async evalRaw<T = unknown>(params: {
    id: string;
    script: string;
    label: string;
    timeoutMs?: number;
    mutates?: boolean;
    toolName?: string;
  }): Promise<EvalSuccessResponse<T>> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers = this.buildHeaders();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/eval`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: params.id,
          script: params.script,
          label: params.label,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isFetchTimeout(err)) {
        if (params.mutates && this.quarantine) {
          this.quarantine.add({
            op_id: params.id,
            tool: params.toolName ?? params.label,
            label: params.label,
            reason: `Timed out after ${Math.round(
              timeoutMs / 1000
            )}s; outcome unknown.`,
          });
        }
        throw new BridgeError({
          kind: "timeout",
          op_id: params.id,
          message:
            `Operation "${params.label}" (${params.id}) timed out after ${Math.round(
              timeoutMs / 1000
            )}s: outcome unknown. ` +
            `Do NOT resend this request — it may still be running or have completed in After Effects.` +
            (params.mutates
              ? ` Op "${params.id}" has been placed in quarantine; call ae_status, inspect state with read tools, then ae_acknowledge.`
              : ""),
        });
      }
      throw new BridgeError({
        kind: "unreachable",
        op_id: params.id,
        message: `Panel unreachable on 127.0.0.1:${this.port} (${
          (err as Error).message
        }). Open Window > Extensions > Chroma AE MCP in After Effects.`,
      });
    }

    let payload: EvalResponse<T>;
    try {
      payload = (await res.json()) as EvalResponse<T>;
    } catch {
      throw new BridgeError({
        kind: "unreachable",
        op_id: params.id,
        message: `Panel returned non-JSON response (HTTP ${res.status}). Open Window > Extensions > Chroma AE MCP in After Effects.`,
      });
    }

    if (!payload.ok) {
      const errObj = payload.error ?? {
        message: "Unknown ExtendScript error",
        kind: "evalscript_error",
      };
      const mappedKind = normalizeErrorKind(errObj.kind);
      throw new BridgeError({
        kind: mappedKind,
        op_id: payload.id ?? params.id,
        message: errObj.message,
        line: errObj.line,
        actual: errObj.actual,
        expected: errObj.expected,
      });
    }

    return payload;
  }

  /**
   * Executes a host function `__chromaAe.<fn>(args)` through the single-writer queue.
   */
  async callHost<T = unknown>(
    fn: HostFunctionName,
    args: unknown,
    opts: CallHostOptions
  ): Promise<{ id: string; result: T; durationMs: number }> {
    if (opts.mutates && this.quarantine) {
      this.quarantine.assertClear();
    }

    const opId = opts.opId ?? this.newOpId();
    const script = buildJsxCall(fn, args);

    const runEval = async () => {
      const resp = await this.evalRaw<T>({
        id: opId,
        script,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
        mutates: opts.mutates,
        toolName: opts.toolName,
      });
      return { id: resp.id, result: resp.result, durationMs: resp.durationMs };
    };

    if (!this.queue) {
      return await runEval();
    }

    try {
      return await this.queue.run(opts.label, runEval);
    } catch (err) {
      if (err instanceof QueueWaitError) {
        throw new BridgeError({
          kind: "queued",
          op_id: opId,
          message: err.message,
        });
      }
      throw err;
    }
  }
}
