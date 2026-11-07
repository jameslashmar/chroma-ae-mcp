/**
 * server/src/ae-activity.ts
 *
 * Says, from outside After Effects, why AE cannot answer right now. AE's scripting thread is
 * single: a modal popup, a long script or a render keeps it inside one evalScript, and every
 * eval sent meanwhile only sits in the panel service's queue until it times out ("outcome
 * unknown", and a write is quarantined for nothing). This module is the evidence that lets the
 * doors in front of the bridge (PanelHost.evalRaw) and ae_status refuse at once instead:
 *   - the panel service has an eval in flight for BUSY_REFUSE_AFTER_MS or more that this server
 *     is not itself waiting on (someone else's script, a popup, a manual render), or
 *   - an eval of this server hit its timeout and is still unfinished in AE ("abandoned"), or
 *   - the render gate is shut.
 *
 * Nothing here talks to AE: it never uses the queue, evalRaw or callHost (they cannot answer
 * while AE is stuck). It reads the service's own bookkeeping, the render gate and, for the
 * report, the popups AE shows (read from outside through UI Automation, without screenshots).
 * It never aborts or resends anything.
 */

import { BridgeError } from "./host.js";
import { renderGate, renderGateMessage, type RenderGateInfo } from "./render-gate.js";
import { listBlockingDialogs } from "./tools/ext/dialogs.js";

/** An eval the service has had in flight this long, which this server is not waiting on, means AE is busy. */
export const BUSY_REFUSE_AFTER_MS = 15_000;
/** What the reports tell the caller: ae_status answers at once, so check it again after this long. */
export const BUSY_CHECK_AGAIN_S = 30;
/** One popup read serves every refused call within this window (it costs PowerShell and OCR). */
export const BUSY_DIALOG_CACHE_MS = 5_000;
/** Upper bound on a popup read, so a stuck UI Automation call never delays a refusal. */
export const BUSY_DIALOG_BUDGET_MS = 4_000;

const MAX_DIALOG_TEXT_CHARS = 400;
const MAX_DIALOGS = 10;

export type BusyCause = "rendering" | "dialog_open" | "script_running" | "unknown";

export interface BusyDialog {
  handle: number | null;
  title: string;
  /** Clipped to 400 characters. */
  text: string;
  buttons: string[];
  caused_by_op: string | null;
}

export interface AeBusyReport {
  busy: true;
  cause: BusyCause;
  /** How long the service's in-flight eval has been running, if it says. */
  running_ms: number | null;
  in_flight: { label: string; running_ms: number } | null;
  /** Evals waiting in the panel service behind the one in flight. */
  waiting_in_service: number;
  /** Evals of this server that timed out and are still unfinished in AE. */
  abandoned_ours: number;
  server_queue: { holder: string | null; depth: number };
  render_gate: { job_id: string; state: string } | null;
  dialogs: BusyDialog[];
  message: string;
  next_steps: string[];
  check_again_in_s: number;
}

/** Everything classifyBusy decides from. All plain data, so it is table-testable. */
export interface BusyInput {
  thresholdMs: number;
  renderGate: RenderGateInfo | null;
  /** The panel service's eval in flight (serviceInfo().inFlight). */
  inFlight: { label: string; runningMs: number } | null;
  evalQueueDepth: number;
  /** Evals this server sent that have not settled and were not abandoned. */
  sentActive: number;
  /** Evals this server gave up waiting for (its timeout fired) that AE has not finished. */
  abandoned: number;
  /**
   * The service says it has nothing in flight and nothing queued. Then no eval of ours can still be
   * running in AE, whatever the counters say (a promise that never settled must not refuse for ever).
   */
  serviceIdle: boolean;
  queue: { holder: string | null; depth: number };
  dialogs: BusyDialog[];
}

/** Where describeBusy gets its facts. Every member is optional: a transport without it reports nothing busy. */
export interface BusySources {
  serviceInfo?: () => Record<string, unknown>;
  queue?: { readonly inFlight: string | null; readonly depth: number };
  busyState?: () => { sentActive: number; abandoned: number };
  /** Reads the open popups. Default: UI Automation without screenshots (listBlockingDialogs). */
  readDialogs?: () => Promise<object[]>;
  thresholdMs?: number;
}

function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function describeDialog(d: BusyDialog): string {
  const btns = d.buttons.length > 0 ? ` [${d.buttons.join(" | ")}]` : "";
  const text = d.text ? `: "${clip(d.text.replace(/\s+/g, " ").trim(), 160)}"` : "";
  return `"${d.title || "untitled"}"${text}${btns}`;
}

/**
 * The pure decision. Returns null when After Effects is not busy by the rules above
 * (a popup alone does not make AE busy: it may be a dialog nothing is waiting on).
 * `force` builds a report anyway (cause "unknown" when nothing explains it), for ae_status
 * after a call that timed out or was refused.
 */
export function classifyBusy(
  input: BusyInput,
  opts: { force?: boolean; requestSent?: boolean } = {}
): AeBusyReport | null {
  const gate = input.renderGate;
  const foreign = input.inFlight !== null && input.sentActive === 0;
  const longRunning = input.inFlight !== null && input.inFlight.runningMs >= input.thresholdMs;
  const longForeign = foreign && longRunning;
  // An abandoned eval of ours counts only while the service really shows something running for the
  // threshold: evals with short limits (a snapshot 8 s, ae_status 10 s) are "abandoned" at once on a
  // healthy but slow AE, and refusing for them would stop work HEAD would have gone on with.
  const abandoned = input.abandoned > 0 && !input.serviceIdle && (!input.inFlight || longRunning);
  if (!gate && !abandoned && !longForeign && !opts.force) return null;

  let cause: BusyCause;
  if (gate) cause = "rendering";
  else if (input.dialogs.length > 0) cause = "dialog_open";
  else if (longForeign || abandoned || (opts.force && longRunning)) cause = "script_running";
  else cause = "unknown";

  const running = input.inFlight ? `"${input.inFlight.label}" has been in flight ${humanDuration(input.inFlight.runningMs)}` : null;
  let message: string;
  if (cause === "rendering") {
    message = renderGateMessage(gate!);
  } else {
    let why: string;
    if (cause === "dialog_open") {
      const shown = input.dialogs.slice(0, 3).map(describeDialog).join("; ");
      const more = input.dialogs.length > 3 ? ` and ${input.dialogs.length - 3} more` : "";
      why = `${input.dialogs.length === 1 ? "a popup is open" : `${input.dialogs.length} popups are open`} (${shown}${more})`;
      if (running) why += `; the running operation ${running}`;
    } else if (cause === "script_running") {
      if (abandoned && !longForeign && input.sentActive === 0) {
        why =
          `an earlier request of this server (${input.abandoned} in all) timed out and has not finished in After Effects` +
          (running ? `; ${running}` : "");
      } else {
        why =
          `${running ?? "an operation"} (a script, or AE's own work such as a manual render or playback; cannot tell from outside)`;
      }
    } else {
      why = running ? `${running}, and AE did not answer` : "it did not answer, and the cause could not be read from outside";
    }
    message =
      `After Effects is busy: ${why}. ` +
      (opts.requestSent
        ? "The request was sent and has not been answered (it is not cancelled). "
        : "Nothing was sent to AE. ") +
      (input.dialogs.length > 0
        ? "Read the popups with ae_dialogs; answer only under the dialog rules or ask the user. "
        : "Look at After Effects, or ask the user. ") +
      "Do not retry in a loop: call ae_status, it answers at once and shows when AE is free.";
  }

  const nextSteps: string[] = [];
  if (cause === "rendering") {
    nextSteps.push("Check ae_render_queue_render_status; other tools cannot reach AE until the render ends.");
  } else {
    if (input.dialogs.length > 0) nextSteps.push("Read the popups with ae_dialogs. Answer with ae_dialog_respond only under the dialog rules, or ask the user.");
    else nextSteps.push("Ask the user to look at After Effects (a popup, a script or a render may hold it).");
    nextSteps.push(`Call ae_status (it answers at once) again in about ${BUSY_CHECK_AGAIN_S} s instead of retrying the tool.`);
    nextSteps.push("Do not resend a write that was sent before: its outcome is unknown until AE answers.");
  }

  return {
    busy: true,
    cause,
    running_ms: input.inFlight ? input.inFlight.runningMs : null,
    in_flight: input.inFlight ? { label: input.inFlight.label, running_ms: input.inFlight.runningMs } : null,
    waiting_in_service: input.evalQueueDepth,
    abandoned_ours: input.abandoned,
    server_queue: { holder: input.queue.holder, depth: input.queue.depth },
    render_gate: gate ? { job_id: gate.job_id, state: gate.state } : null,
    dialogs: input.dialogs,
    message,
    next_steps: nextSteps,
    check_again_in_s: BUSY_CHECK_AGAIN_S,
  };
}

// ---------- popups ----------

function normaliseDialogs(raw: object[]): BusyDialog[] {
  const out: BusyDialog[] = [];
  for (const item of raw.slice(0, MAX_DIALOGS)) {
    const d = item as {
      handle?: unknown;
      title?: unknown;
      text?: unknown;
      buttons?: unknown;
      caused_by_op?: unknown;
    };
    const buttons: string[] = [];
    if (Array.isArray(d.buttons)) {
      for (const b of d.buttons) {
        const name = typeof b === "string" ? b : (b as { name?: unknown } | null)?.name;
        if (typeof name === "string" && name) buttons.push(name);
      }
    }
    out.push({
      handle: typeof d.handle === "number" ? d.handle : null,
      title: typeof d.title === "string" ? d.title : "",
      text: typeof d.text === "string" ? clip(d.text, MAX_DIALOG_TEXT_CHARS) : "",
      buttons,
      caused_by_op: typeof d.caused_by_op === "string" ? d.caused_by_op : null,
    });
  }
  return out;
}

async function defaultReadDialogs(): Promise<object[]> {
  const res = await listBlockingDialogs({ screenshots: false });
  return res.ok && res.dialogs ? res.dialogs : [];
}

const dialogCache = new WeakMap<() => Promise<object[]>, { at: number; value: BusyDialog[] }>();
const dialogPending = new WeakMap<() => Promise<object[]>, Promise<BusyDialog[]>>();

/** For tests: forgets the cached popup reads of one reader (or of the default one). */
export function resetBusyCache(reader?: () => Promise<object[]>): void {
  const key = reader ?? defaultReadDialogs;
  dialogCache.delete(key);
  dialogPending.delete(key);
}

/** The popups, from the cache when read within BUSY_DIALOG_CACHE_MS; one read serves a burst; bounded by BUSY_DIALOG_BUDGET_MS. Never throws. */
export async function readBusyDialogs(
  reader?: () => Promise<object[]>,
  now: () => number = Date.now,
  budgetMs: number = BUSY_DIALOG_BUDGET_MS
): Promise<BusyDialog[]> {
  const key = reader ?? defaultReadDialogs;
  const cached = dialogCache.get(key);
  if (cached && now() - cached.at < BUSY_DIALOG_CACHE_MS) return cached.value;

  let pending = dialogPending.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        return normaliseDialogs(await key());
      } catch {
        return [];
      }
    })();
    dialogPending.set(key, pending);
    const mine = pending;
    void mine.then((value) => {
      dialogCache.set(key, { at: now(), value });
      if (dialogPending.get(key) === mine) dialogPending.delete(key);
    });
  }
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<BusyDialog[]>((resolve) => {
        budget = setTimeout(() => resolve([]), Math.max(0, Math.min(budgetMs, BUSY_DIALOG_BUDGET_MS)));
        budget.unref?.();
      }),
    ]);
  } finally {
    if (budget !== undefined) clearTimeout(budget);
  }
}

// ---------- gathering ----------

function gather(src: BusySources): Omit<BusyInput, "dialogs"> {
  let info: Record<string, unknown> = {};
  try {
    info = src.serviceInfo?.() ?? {};
  } catch {
    info = {};
  }
  let inFlight: BusyInput["inFlight"] = null;
  const f = info.inFlight as { id?: unknown; label?: unknown; runningMs?: unknown } | null | undefined;
  if (f && typeof f === "object") {
    const label = typeof f.label === "string" && f.label ? f.label : typeof f.id === "string" && f.id ? f.id : "an operation";
    inFlight = { label, runningMs: typeof f.runningMs === "number" && Number.isFinite(f.runningMs) ? f.runningMs : 0 };
  }
  let state = { sentActive: 0, abandoned: 0 };
  try {
    state = src.busyState?.() ?? state;
  } catch {
    // bookkeeping only
  }
  return {
    thresholdMs: src.thresholdMs ?? BUSY_REFUSE_AFTER_MS,
    renderGate: renderGate.active(),
    inFlight,
    evalQueueDepth: typeof info.evalQueueDepth === "number" ? info.evalQueueDepth : 0,
    sentActive: state.sentActive,
    abandoned: state.abandoned,
    serviceIdle: "inFlight" in info && !inFlight && (typeof info.evalQueueDepth === "number" ? info.evalQueueDepth : 0) === 0,
    queue: { holder: src.queue?.inFlight ?? null, depth: src.queue?.depth ?? 0 },
  };
}

/** Synchronous: is After Effects busy by the rules above? Costs no I/O, so every eval can ask. */
export function isBusyNow(src: BusySources): boolean {
  return classifyBusy({ ...gather(src), dialogs: [] }) !== null;
}

/**
 * The busy report, or null when AE is not busy. `withDialogs: false` skips the popup read;
 * `force` reports even when the rules say not busy (cause "unknown").
 */
export async function describeBusy(
  src: BusySources,
  opts: { withDialogs?: boolean; force?: boolean; requestSent?: boolean; dialogBudgetMs?: number } = {}
): Promise<AeBusyReport | null> {
  const first = gather(src);
  if (!classifyBusy({ ...first, dialogs: [] }, { force: opts.force })) return null;
  // A shut render gate is explained by the render; no popup read for it.
  const dialogs = opts.withDialogs === false || first.renderGate ? [] : await readBusyDialogs(src.readDialogs, Date.now, opts.dialogBudgetMs);
  return classifyBusy({ ...gather(src), dialogs }, { force: opts.force, requestSent: opts.requestSent });
}

/**
 * For the queue's wait guard: a popup is open while the service has had an eval in flight for the
 * threshold, whoever's it is. Then a call that would wait for the lease cannot be served and is
 * refused (a long eval with no popup is a legitimate long operation and keeps waiting).
 * Costs nothing unless the service shows a long eval.
 */
export async function describePopupBlock(src: BusySources, opts: { dialogBudgetMs?: number } = {}): Promise<AeBusyReport | null> {
  const g = gather(src);
  if (g.renderGate) return null; // the render gate has its own door
  if (!g.inFlight || g.inFlight.runningMs < g.thresholdMs) return null;
  const dialogs = await readBusyDialogs(src.readDialogs, Date.now, opts.dialogBudgetMs);
  if (dialogs.length === 0) return null;
  return classifyBusy({ ...gather(src), dialogs }, { force: true });
}

/** The refusal: kind "queued" is "nothing was executed, safe to retry later"; the report rides in `actual.busy`. */
export function busyError(report: AeBusyReport, opId?: string): BridgeError {
  return new BridgeError({ kind: "queued", op_id: opId, message: report.message, actual: { busy: report } });
}
