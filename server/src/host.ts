import type { HostFunctionName } from "./jsx.js";

export type { HostFunctionName };

export type BridgeErrorKind =
  | "timeout"
  | "unreachable"
  | "queued"
  | "evalscript_error"
  | "guard";

export interface BridgeErrorDetail {
  kind: BridgeErrorKind;
  message: string;
  line?: number;
  actual?: unknown;
  expected?: unknown;
  op_id?: string;
}

export class BridgeError extends Error {
  readonly kind: BridgeErrorKind;
  readonly line?: number;
  readonly actual?: unknown;
  readonly expected?: unknown;
  readonly op_id?: string;

  constructor(detail: BridgeErrorDetail) {
    super(detail.message);
    this.name = "BridgeError";
    this.kind = detail.kind;
    this.line = detail.line;
    this.actual = detail.actual;
    this.expected = detail.expected;
    this.op_id = detail.op_id;
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
