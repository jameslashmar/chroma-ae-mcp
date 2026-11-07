import * as crypto from "node:crypto";
import { noteOpFinished, noteOpStarted } from "./tools/ext/dialogs.js";
import {
  BridgeError,
  DEFAULT_TIMEOUT_MS,
  normalizeErrorKind,
  type CallHostOptions,
  type EvalSuccessResponse,
  type HostTransport,
} from "./host.js";
import { BUSY_REFUSE_AFTER_MS, busyError, describePopupBlock, describeBusy, isBusyNow, type BusySources } from "./ae-activity.js";
import { buildJsxCall, type HostFunctionName } from "./jsx.js";
import type { QuarantineStore } from "./quarantine.js";
import { QueueWaitError, type SingleWriterQueue } from "./queue.js";
import { renderGate } from "./render-gate.js";

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
  /** Reads popups blocking AE when a call times out (the panel passes describeBlockingDialogs). */
  describeDialogs?: () => Promise<object[]>;
  /**
   * The panel service's own bookkeeping (panel-entry passes ctx.serviceInfo): the eval it has in
   * flight and for how long. With it, evalRaw refuses at once while AE has been busy for
   * busyThresholdMs with something this server is not waiting on (see ae-activity.ts).
   */
  serviceInfo?: () => Record<string, unknown>;
  /** Default BUSY_REFUSE_AFTER_MS (15 s). */
  busyThresholdMs?: number;
  /**
   * Reads the open popups for a busy report. Default: UI Automation without screenshots.
   * Not describeDialogs: that one saves a screenshot per call, which a burst of refused calls must not.
   */
  busyDialogs?: () => Promise<object[]>;
}

/**
 * After a write's evalScript returned, the reads that follow it (read-back, session snapshot) are
 * never refused by the door for this long: a refused read-back would put a false mismatch in the
 * receipt of a write that was applied.
 */
const READ_BACK_GRACE_MS = 15_000;

/** Upper bound on reading popups after a timeout, so a stuck UI Automation call can't delay the report. */
const DESCRIBE_DIALOGS_BUDGET_MS = 4_000;

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
  private readonly describeDialogs?: () => Promise<object[]>;
  private readonly serviceInfo?: () => Record<string, unknown>;
  private readonly busyThresholdMs?: number;
  private readonly busyDialogs?: () => Promise<object[]>;
  /** Evals sent to the service that have not settled and that evalRaw still waits for. */
  private sentActive = 0;
  /** Evals whose timeout fired (evalRaw threw "timeout") but whose promise is still pending: AE may still be running them. */
  private abandoned = 0;
  /** Until when reads are let through after a write returned (see READ_BACK_GRACE_MS). */
  private readBackUntil = 0;

  constructor(
    optsOrFn: PanelHostOptions | PanelEvalScriptFn,
    extraOpts?: Omit<PanelHostOptions, "evalScript">
  ) {
    const o: PanelHostOptions =
      typeof optsOrFn === "function" ? { ...extraOpts, evalScript: optsOrFn } : optsOrFn;
    this.evalScript = o.evalScript;
    this.queue = o.queue;
    this.quarantine = o.quarantine;
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.describeDialogs = o.describeDialogs;
    this.serviceInfo = o.serviceInfo;
    this.busyThresholdMs = o.busyThresholdMs;
    this.busyDialogs = o.busyDialogs;
    // A call that has to wait for the lease while a popup blocks AE is refused instead of waiting up to 600 s.
    if (this.queue && this.serviceInfo) {
      this.queue.setWaitGuard(async (op) => {
        const report = await describePopupBlock(this.busySources());
        return report ? busyError(report, op) : null;
      });
    }
  }

  /** The popup reader this host was given, if any (ae_status reads popups through the same one, so they share its cache). */
  busyDialogReader(): (() => Promise<object[]>) | undefined {
    return this.busyDialogs;
  }

  /** The threshold this host refuses at (ae_status uses the same). */
  busyThreshold(): number {
    return this.busyThresholdMs ?? BUSY_REFUSE_AFTER_MS;
  }

  /** For the busy report (ae-activity.ts): how many of this host's evals are waited on, and how many were given up on but not finished. */
  busyState(): { sentActive: number; abandoned: number } {
    return { sentActive: this.sentActive, abandoned: this.abandoned };
  }

  private busySources(): BusySources {
    return {
      serviceInfo: this.serviceInfo,
      queue: this.queue,
      busyState: () => this.busyState(),
      readDialogs: this.busyDialogs,
      thresholdMs: this.busyThresholdMs,
    };
  }

  /**
   * The door for "AE cannot answer": refuses with kind "queued" before anything is sent, so the
   * call neither waits for a timeout nor is quarantined. The render's own evals pass (the gate
   * has its own door); everything else, reads and writes alike, is refused.
   */
  private async refuseIfBusy(id: string): Promise<void> {
    const src = this.busySources();
    if (!isBusyNow(src)) {
      // An eval of ours sent without a lease (the asset watcher, a footage read, ae_diagnostics) is never "foreign", so a popup
      // holding it does not make AE busy by the counters. A popup read tells: with one open, the next call would only wait for
      // the whole eval timeout (and a write would be quarantined). A long operation with no popup keeps being waited for.
      const popup = await describePopupBlock(src);
      if (popup) throw busyError(popup, id);
      return;
    }
    const report = await describeBusy(src);
    if (report) throw busyError(report, id);
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
    /**
     * Skip the busy door. For a cleanup that must reach AE even when an earlier eval of ours timed
     * out: removing a temporary comp, reopening the original project. It is only sent; AE may
     * answer late, and the timeout still applies.
     */
    mustSend?: boolean;
  }): Promise<EvalSuccessResponse<T>> {
    // While AE renders for ae_render_queue_render it cannot answer: refuse at once, send nothing.
    renderGate.check(params.id);
    const isRender = renderGate.isRenderOp(params.id);
    // AE has been busy for a while with something this server is not waiting on (a popup, a script,
    // a manual render), or an earlier eval of ours is still running in it: refuse at once, send nothing.
    // Reads shortly after a write returned (its read-back) are not refused either.
    const readBack = params.mutates !== true && Date.now() < this.readBackUntil;
    if (!isRender && !params.mustSend && !readBack) await this.refuseIfBusy(params.id);
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
    // Where this eval is counted: "active" while evalRaw waits for it; "abandoned" once its timeout
    // fired and AE may still run it; "none" after that for the render's own eval (the render gate owns that case).
    const flight: { settled: boolean; counted: "active" | "abandoned" | "none" } = { settled: false, counted: "active" };
    this.sentActive++;
    const settle = (): void => {
      flight.settled = true;
      if (flight.counted === "abandoned") this.abandoned--;
      else if (flight.counted === "active") this.sentActive--;
      flight.counted = "none";
      noteOpFinished(params.id);
    };
    rawPromise.then(settle, settle);

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
        // Still running in AE as far as we know: later calls are refused at the door until it settles.
        // The render's own eval is not counted: its unknown outcome shuts the render gate, which lifts
        // when the panel service reports nothing in flight.
        if (!flight.settled) {
          this.sentActive--;
          if (isRender) {
            flight.counted = "none";
          } else {
            flight.counted = "abandoned";
            this.abandoned++;
          }
        }
        // The render's own eval has no quarantine: the render job and the gate handle its unknown outcome.
        if (params.mutates && this.quarantine && !isRender) {
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
        if (this.describeDialogs) {
          let budget: ReturnType<typeof setTimeout> | undefined;
          try {
            blocking = await Promise.race([
              this.describeDialogs(),
              new Promise<object[]>((resolve) => {
                budget = setTimeout(() => resolve([]), DESCRIBE_DIALOGS_BUDGET_MS);
              }),
            ]);
          } catch {
            blocking = [];
          } finally {
            if (budget !== undefined) clearTimeout(budget);
          }
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
            (params.mutates && !isRender
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

    // A write that returned: its read-back must not be refused (see READ_BACK_GRACE_MS).
    if (params.mutates === true) this.readBackUntil = Date.now() + READ_BACK_GRACE_MS;

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
    renderGate.check(opts.opId);
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
