import type { HostFunctionName } from "./jsx.js";

export type { HostFunctionName };

export type BridgeErrorKind =
  | "timeout"
  | "unreachable"
  | "queued"
  | "evalscript_error"
  | "guard";

/**
 * What a failed write did to the project:
 * - "not_applied": nothing was changed (refused before the project was touched).
 * - "unknown": the write may be part-way in; read the state before doing anything else.
 */
export type WriteOutcome = "not_applied" | "unknown";

export interface BridgeErrorDetail {
  kind: BridgeErrorKind;
  message: string;
  line?: number;
  actual?: unknown;
  expected?: unknown;
  op_id?: string;
  /** Set on a failed write (a mutating eval or a guarded write): see WriteOutcome. */
  outcome?: WriteOutcome;
  /** The host's own error code ("bad_args", "unsupported", an A.refuse code). */
  code?: string;
  /** What to do next, for the agent to follow or relay. */
  next_steps?: string[];
}

export class BridgeError extends Error {
  readonly kind: BridgeErrorKind;
  readonly line?: number;
  readonly actual?: unknown;
  readonly expected?: unknown;
  readonly op_id?: string;
  readonly outcome?: WriteOutcome;
  readonly code?: string;
  readonly next_steps?: string[];

  constructor(detail: BridgeErrorDetail) {
    super(detail.message);
    this.name = "BridgeError";
    this.kind = detail.kind;
    this.line = detail.line;
    this.actual = detail.actual;
    this.expected = detail.expected;
    this.op_id = detail.op_id;
    this.outcome = detail.outcome;
    this.code = detail.code;
    this.next_steps = detail.next_steps;
  }

  toJSON(): BridgeErrorDetail {
    const out: BridgeErrorDetail = {
      kind: this.kind,
      message: this.message,
    };
    if (this.line !== undefined) out.line = this.line;
    if (this.actual !== undefined) out.actual = this.actual;
    if (this.expected !== undefined) out.expected = this.expected;
    if (this.op_id !== undefined) out.op_id = this.op_id;
    if (this.code !== undefined) out.code = this.code;
    if (this.outcome !== undefined) out.outcome = this.outcome;
    if (this.next_steps !== undefined) out.next_steps = this.next_steps;
    return out;
  }
}

export interface PanelHealth {
  ok: boolean;
  busy: boolean;
  queueDepth: number;
  aeVersion: string;
  panelVersion: string;
  inFlight: { id: string; startedAt: number } | null;
}

export interface EvalSuccessResponse<T = unknown> {
  id: string;
  ok: true;
  result: T;
  durationMs: number;
}

export interface EvalErrorResponse {
  id: string;
  ok: false;
  error: {
    message: string;
    line?: number;
    kind: BridgeErrorKind | string;
    actual?: unknown;
    expected?: unknown;
  };
}

export type EvalResponse<T = unknown> =
  | EvalSuccessResponse<T>
  | EvalErrorResponse;

export const DEFAULT_BRIDGE_PORT = 7790;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const SLOW_TIMEOUT_MS = 600_000;
export const HEALTH_TIMEOUT_MS = 5_000;

export interface CallHostOptions {
  label: string;
  mutates?: boolean;
  toolName?: string;
  timeoutMs?: number;
  opId?: string;
}

/** The error object the panel's eval wrapper returns (core.jsx formatError, plus what the panel adds). */
export interface HostErrorObject {
  message?: string;
  kind?: string;
  line?: number;
  actual?: unknown;
  expected?: unknown;
  code?: string;
  refused?: boolean;
  touched?: boolean;
}

export const NEXT_STEPS_NOT_APPLIED = ["Nothing in the project was changed. Fix what the message names and call again."];

export function nextStepsUnknown(label: string, checkpoint?: string | null): string[] {
  return [
    `Part of "${label}" may already be in the project. Do not resend it: read the state first (ae_comp_diff, or the read tools for what it touches).`,
    "If it is wrong, one Edit > Undo in After Effects (Ctrl+Z, Cmd+Z on macOS) removes this call's whole undo group; a save, a project open or close, a render and a font replacement have none. Tell the user before doing anything else.",
    checkpoint
      ? `The checkpoint taken just before it holds the project as it was: ${checkpoint}`
      : "The automatic checkpoint taken before the write (ae_status lists it) holds the project as it was.",
  ];
}

/**
 * The BridgeError for an error the host returned. For a mutating eval it says what happened to the
 * project: a refusal (A.refuse) or an error before the project was touched (no undo group opened,
 * no A.touch()) is "not_applied"; anything else, including an older panel that does not report
 * `touched`, is "unknown".
 */
export function bridgeErrorFromHost(errObj: HostErrorObject, opId: string, opts: { mutates?: boolean; label?: string } = {}): BridgeError {
  const mappedKind = normalizeErrorKind(errObj.kind);
  const code = errObj.code ?? (errObj.kind && errObj.kind !== mappedKind && errObj.kind !== "runtime" ? errObj.kind : undefined);
  let outcome: WriteOutcome | undefined;
  if (opts.mutates === true) outcome = errObj.refused === true || errObj.touched === false ? "not_applied" : "unknown";
  return new BridgeError({
    kind: mappedKind,
    op_id: opId,
    message: errObj.message || "Unknown ExtendScript error",
    line: errObj.line,
    actual: errObj.actual,
    expected: errObj.expected,
    ...(code ? { code } : {}),
    ...(outcome ? { outcome, next_steps: outcome === "not_applied" ? NEXT_STEPS_NOT_APPLIED : nextStepsUnknown(opts.label ?? "this write") } : {}),
  });
}

/**
 * A copy of `err` with an outcome and its next steps.
 * - "not_applied" is for a failure before the write was sent: it always wins.
 * - "unknown" is for a failure of the write itself: a "not_applied" the host reported is kept
 *   (the host knows nothing was touched); otherwise the steps name the checkpoint.
 */
export function withOutcome(err: BridgeError, outcome: WriteOutcome, label: string, checkpoint?: string | null): BridgeError {
  if (outcome === "unknown" && err.outcome === "not_applied") return err;
  const steps = outcome === "not_applied" ? NEXT_STEPS_NOT_APPLIED : nextStepsUnknown(label, checkpoint);
  return new BridgeError({ ...err.toJSON(), outcome, next_steps: steps });
}

export function normalizeErrorKind(kind: string | undefined): BridgeErrorKind {
  switch (kind) {
    case "timeout":
    case "unreachable":
    case "queued":
    case "evalscript_error":
    case "guard":
      return kind;
    default:
      return "evalscript_error";
  }
}

export interface HostTransport {
  newOpId(): string;
  evalRaw<T = unknown>(p: {
    id: string;
    script: string;
    label: string;
    timeoutMs?: number;
    mutates?: boolean;
    toolName?: string;
    /** Skip the busy door (cleanup after a timed-out eval). Ignored by transports without one. */
    mustSend?: boolean;
  }): Promise<EvalSuccessResponse<T>>;
  callHost<T = unknown>(
    fn: HostFunctionName,
    args: unknown,
    opts: CallHostOptions
  ): Promise<{ id: string; result: T; durationMs: number }>;
  health?(): Promise<PanelHealth>;
}
