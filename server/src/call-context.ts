/**
 * server/src/call-context.ts
 *
 * The tools/call that is running, without passing it through every tool: progress notifications and
 * cancellation (MCP notifications/progress and notifications/cancelled).
 *
 * - Progress: when the client sent `_meta.progressToken` and its transport can stream (the panel's
 *   /mcp answers with text/event-stream when the request accepts it), every After Effects eval of the
 *   call sends one notifications/progress with a growing count and the eval's label
 *   ("ae_scrub_check(12 @ 0.24s)"). There is no total: most tools do not know how many evals they need.
 * - Cancellation: notifications/cancelled marks the call. Work stops only at safe points, never by
 *   abandoning an eval After Effects is running (that wedges the ExtendScript bridge, CLAUDE.md):
 *   before the call enters the write queue, before each frame a loop renders (captureCompFrame), and
 *   just before a guarded write is sent (it is then not_applied). An eval already sent always ends.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export class CancelledError extends Error {
  readonly kind = "cancelled" as const;
  /** Set by a guarded write: not_applied when it stopped before the write was sent. */
  outcome?: "not_applied" | "unknown";
  constructor(readonly where: string, readonly reason?: string) {
    super(`Cancelled by the client${reason ? ` (${reason})` : ""} before ${where}. An eval already sent to After Effects was let finish.`);
    this.name = "CancelledError";
  }
}

export interface CallState {
  /** The JSON-RPC id of the tools/call, as the client sent it. */
  requestId: string | number;
  client: string;
  cancelled: boolean;
  reason?: string;
  progressToken?: string | number;
  /** Sends one JSON-RPC notification on the call's own response stream; absent when the transport cannot. */
  notify?: (message: Record<string, unknown>) => void;
  progress: number;
}

const storage = new AsyncLocalStorage<CallState>();
const running = new Map<string, CallState>();
const keyOf = (client: string, id: string | number) => `${client}\n${typeof id}:${id}`;

export function runInCall<T>(state: CallState, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(state.client, state.requestId);
  running.set(key, state);
  return storage.run(state, fn).finally(() => {
    if (running.get(key) === state) running.delete(key);
  });
}

export function currentCall(): CallState | undefined {
  return storage.getStore();
}

/** notifications/cancelled: marks the running call with that id from the same client. False when none is running. */
export function cancelCall(client: string, requestId: unknown, reason?: unknown): boolean {
  if (typeof requestId !== "string" && typeof requestId !== "number") return false;
  const state = running.get(keyOf(client, requestId));
  if (!state) return false;
  state.cancelled = true;
  if (typeof reason === "string" && reason) state.reason = reason.slice(0, 200);
  return true;
}

/** A safe point: throws CancelledError when the running call was cancelled. */
export function checkCancelled(where: string): void {
  const s = storage.getStore();
  if (s?.cancelled) throw new CancelledError(where, s.reason);
}

/** One eval of the running call is about to start: a progress notification when the client asked for them. */
export function noteProgress(label: string): void {
  const s = storage.getStore();
  if (!s || s.progressToken === undefined || !s.notify) return;
  s.progress += 1;
  try {
    s.notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: s.progressToken, progress: s.progress, message: label.slice(0, 200) } });
  } catch {
    // A closed stream must never fail the call.
  }
}
