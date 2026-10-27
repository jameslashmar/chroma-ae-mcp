import * as crypto from "node:crypto";
import { describeBlockingDialogs, noteOpFinished, noteOpStarted } from "./tools/ext/dialogs.js";
import {
  BridgeError,
  DEFAULT_TIMEOUT_MS,
  normalizeErrorKind,
  type CallHostOptions,
  type EvalSuccessResponse,
  type HostTransport,
} from "./host.js";
import { buildJsxCall, type HostFunctionName } from "./jsx.js";
import type { QuarantineStore } from "./quarantine.js";
import { QueueWaitError, type SingleWriterQueue } from "./queue.js";

export type PanelEvalScriptSuccess = {
  ok: true;
  result: unknown;
  durationMs: number;
};

export type PanelEvalScriptFailure = {
  ok: false;
  error: {
    message: string;
    kind: string;
    line?: number;
    actual?: unknown;
    expected?: unknown;
  };
  durationMs?: number;
};

export type PanelEvalScriptResult =
  | PanelEvalScriptSuccess
  | PanelEvalScriptFailure;

export type PanelEvalScriptFn = (
  script: string,
  label: string
) => Promise<PanelEvalScriptResult>;

export interface PanelHostOptions {
  evalScript: PanelEvalScriptFn;
  queue?: SingleWriterQueue;
  quarantine?: QuarantineStore;
  defaultTimeoutMs?: number;
}

class PanelTimeoutSignal extends Error {
  constructor() {
    super("PanelHost evalScript timed out");
    this.name = "PanelTimeoutSignal";
  }
}

export class PanelHost implements HostTransport {
  private readonly evalScript: PanelEvalScriptFn;
  private readonly queue?: SingleWriterQueue;
  private readonly quarantine?: QuarantineStore;
  private readonly defaultTimeoutMs: number;

  constructor(
    optsOrFn: PanelHostOptions | PanelEvalScriptFn,
    extraOpts?: Omit<PanelHostOptions, "evalScript">
  ) {
    if (typeof optsOrFn === "function") {
      this.evalScript = optsOrFn;
      this.queue = extraOpts?.queue;
      this.quarantine = extraOpts?.quarantine;
      this.defaultTimeoutMs = extraOpts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    } else {
      this.evalScript = optsOrFn.evalScript;
      this.queue = optsOrFn.queue;
      this.quarantine = optsOrFn.quarantine;
      this.defaultTimeoutMs = optsOrFn.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
  }

  newOpId(): string {
    return `op_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Calls the panel's evalScript queue, racing against a timeout via setTimeout.
   * On timeout, throws kind:"timeout", quarantines the op if mutates:true,
   * and NEVER cancels the underlying evalScript promise.
   */
  async evalRaw<T = unknown>(params: {
    id: string;
    script: string;
    label: string;
    timeoutMs?: number;
    mutates?: boolean;
    toolName?: string;
  }): Promise<EvalSuccessResponse<T>> {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    let rawPromise: Promise<PanelEvalScriptResult>;
    // Lets ae_dialogs attribute a popup to the operation that was running when it appeared.
    noteOpStarted(params.id);
    try {
      rawPromise = Promise.resolve(
        this.evalScript(params.script, params.label)
      );
    } catch (syncErr) {
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: syncErr instanceof Error ? syncErr.message : String(syncErr),
      });
    }

    // Attach a no-op rejection handler so that if the timeout wins the race
    // and rawPromise later rejects, Node does not emit an unhandledRejection.
    rawPromise.then(
      () => noteOpFinished(params.id),
      () => noteOpFinished(params.id)
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PanelTimeoutSignal());
      }, timeoutMs);
    });

    let payload: PanelEvalScriptResult;
    try {
      payload = await Promise.race([rawPromise, timeoutPromise]);
    } catch (err) {
      if (err instanceof PanelTimeoutSignal) {
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
        // AE is usually blocked by a modal popup. Read it from outside AE's
        // scripting thread so the agent sees what is waiting (never suppressed).
        let blocking: object[] = [];
        try {
          blocking = await describeBlockingDialogs();
        } catch {
          blocking = [];
        }
        const dialogNote =
          blocking.length > 0
            ? ` AE is showing ${blocking.length} popup(s): ` +
              blocking
                .map((d) => {
                  const x = d as { title?: string; buttons?: Array<{ name?: string }> };
                  const btns = (x.buttons ?? []).map((b) => b.name).filter(Boolean).join(" | ");
                  return `"${x.title ?? "untitled"}"${btns ? ` [${btns}]` : ""}`;
                })
                .join("; ") +
              ". Read them with ae_dialogs; answer with ae_dialog_respond only under Jay's rules."
            : "";
        throw new BridgeError({
          kind: "timeout",
          op_id: params.id,
          actual: blocking.length > 0 ? { blocking_dialogs: blocking } : undefined,
          message:
            `Operation "${params.label}" (${params.id}) timed out after ${Math.round(
              timeoutMs / 1000
            )}s: outcome unknown. ` +
            `Do NOT resend this request — it may still be running or have completed in After Effects.` +
            (params.mutates
              ? ` Op "${params.id}" has been placed in quarantine; call ae_status, inspect state with read tools, then ae_acknowledge.`
              : "") +
            dialogNote,
        });
      }
      if (err instanceof BridgeError) {
        throw err;
      }
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (!payload || typeof payload !== "object") {
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: "Panel evalScript returned an invalid response envelope",
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
        op_id: params.id,
        message: errObj.message || "Unknown ExtendScript error",
        line: errObj.line,
        actual: errObj.actual,
        expected: errObj.expected,
      });
    }

    return {
      id: params.id,
      ok: true,
      result: payload.result as T,
      durationMs:
        typeof payload.durationMs === "number"
          ? payload.durationMs
          : Date.now() - startedAt,
    };
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
