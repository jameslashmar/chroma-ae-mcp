/**
 * server/src/render-gate.ts
 *
 * While After Effects renders the Render Queue for ae_render_queue_render,
 * its scripting thread is busy inside one evalScript (RenderQueue.render()
 * only returns when the render ends), so it cannot answer anything else. The
 * gate is the one place that knows this. It is checked at the two doors every
 * tool goes through:
 *   - SingleWriterQueue.acquire (callHost, runGuardedWrite and every
 *     ctx.queue.run): a waiting tool would otherwise sit behind the render's
 *     lease until the queue's 600 s limit;
 *   - evalRaw of both transports (a tool that sends an eval without the
 *     queue, the asset watcher, the session hooks).
 * A refusal is a BridgeError of kind "queued" ("nothing was executed, safe to
 * retry later"): it is never sent to After Effects, never quarantined and
 * never counted as an applied write.
 *
 * The render's own evals (its op id, and ids that start with it plus "_")
 * pass. Two states:
 *   - "rendering": the render eval is in flight;
 *   - "unknown": the render eval hit its timeout. It is still running inside
 *     After Effects (an evalScript is never aborted), so the gate stays shut
 *     until the idle probe says the panel service has nothing in flight (or
 *     the service restarts, which empties this module).
 */

import { BridgeError } from "./host.js";

export type RenderGateState = "rendering" | "unknown";

/** Why an "unknown" gate is shut. */
export type RenderGateCause = "render_timeout" | "read_back_timeout" | "still_rendering";

export interface RenderGateInfo {
  job_id: string;
  /** The op id of the render's evalRaw; the read-back that follows uses `${op_id}_...`. */
  op_id: string;
  started_at: string;
  state: RenderGateState;
  /** Only in the "unknown" state. */
  cause?: RenderGateCause;
  /** Only in the "unknown" state: the idle probe does not lift it (After Effects itself said it is still rendering). */
  sticky?: boolean;
}

export class RenderGate {
  private current: RenderGateInfo | null = null;
  private idleProbe: (() => boolean) | null = null;
  private onLift: ((info: RenderGateInfo) => void) | null = null;
  private onClear: ((info: RenderGateInfo) => void) | null = null;

  /** Closes the gate. Call it inside the queue lease, before the render's eval is sent. */
  begin(info: Omit<RenderGateInfo, "state">, onLift?: (info: RenderGateInfo) => void, onClear?: (info: RenderGateInfo) => void): void {
    if (this.active()) throw new Error("A render job already holds the gate.");
    this.current = { ...info, state: "rendering" };
    this.onLift = onLift ?? null;
    this.onClear = onClear ?? null;
  }

  /**
   * Opens the gate (the render ended, or the panel can no longer be reached). Never throws.
   * With a job id it only opens that job's gate, so a late finish of an old job cannot
   * open the gate of a newer one.
   */
  end(jobId?: string): void {
    if (jobId !== undefined && this.current && this.current.job_id !== jobId) return;
    this.current = null;
    this.onLift = null;
    this.onClear = null;
  }

  /**
   * The user's way out of a gate that will not lift (the panel's "Clear render lock" button).
   * Not for tools. Returns the cleared gate, or null when it was open.
   */
  clear(): RenderGateInfo | null {
    const cur = this.current;
    if (!cur) return null;
    const cb = this.onClear;
    this.current = null;
    this.onLift = null;
    this.onClear = null;
    try {
      cb?.(cur);
    } catch {
      // bookkeeping only
    }
    return cur;
  }

  /** The render's outcome is unknown (its eval timed out, its read-back timed out, or After Effects still says it renders): it may still be busy. */
  markUnknown(cause: RenderGateCause = "render_timeout"): void {
    if (this.current) this.current = { ...this.current, state: "unknown", cause, sticky: cause === "still_rendering" };
  }

  /**
   * True when the panel service has nothing in flight. Only asked in the
   * "unknown" state; without a probe that state lasts until the service restarts.
   */
  setIdleProbe(probe: (() => boolean) | null): void {
    this.idleProbe = probe;
  }

  /** The gate's info while it is shut, else null. Lifts an "unknown" gate whose probe says AE is idle again. */
  active(): RenderGateInfo | null {
    const cur = this.current;
    if (!cur) return null;
    if (cur.state === "unknown" && !cur.sticky && this.idleProbe) {
      let idle = false;
      try {
        idle = this.idleProbe();
      } catch {
        idle = false;
      }
      if (idle) {
        const lifted = cur;
        const cb = this.onLift;
        this.current = null;
        this.onLift = null;
        try {
          cb?.(lifted);
        } catch {
          // bookkeeping only
        }
        return null;
      }
    }
    return cur;
  }

  /** Is this eval one of the render's own? */
  isRenderOp(id: string | undefined): boolean {
    const cur = this.current;
    if (!cur || typeof id !== "string") return false;
    return id === cur.op_id || id.startsWith(`${cur.op_id}_`);
  }

  /** Refuses at once (BridgeError "queued") unless the gate is open or `id` is the render's own eval. */
  check(id?: string): void {
    const cur = this.active();
    if (!cur) return;
    if (this.isRenderOp(id)) return;
    throw new BridgeError({ kind: "queued", op_id: id, message: renderGateMessage(cur) });
  }

  /** For tests: forgets everything. */
  reset(): void {
    this.current = null;
    this.onLift = null;
    this.onClear = null;
    this.idleProbe = null;
  }
}

const RESTART_HINT =
  "If After Effects is no longer rendering and this does not clear, restarting After Effects clears it (the user can also press \"Clear render lock\" in the Chroma AE MCP panel).";

export function renderGateMessage(info: RenderGateInfo): string {
  if (info.state === "unknown") {
    let why = "the render call timed out, so its outcome is unknown";
    if (info.cause === "read_back_timeout") why = "the read of the result after the render timed out, so its outcome is unknown";
    if (info.cause === "still_rendering") why = "After Effects still reported rendering after the render call returned";
    return (
      `After Effects may still be busy rendering (job ${info.job_id}, started ${info.started_at}): ${why}. ` +
      "Nothing was sent to After Effects. Look at After Effects and ae_render_queue_render_status; other tools can't reach AE until this clears. " +
      RESTART_HINT
    );
  }
  return (
    `After Effects is rendering (job ${info.job_id}, started ${info.started_at}). Nothing was sent to it. ` +
    "Check ae_render_queue_render_status; other tools can't reach AE until it ends. " +
    RESTART_HINT
  );
}

/** The one gate of this process. */
export const renderGate = new RenderGate();
