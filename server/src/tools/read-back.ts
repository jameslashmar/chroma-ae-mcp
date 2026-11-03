/**
 * server/src/tools/read-back.ts
 *
 * The read-back after an applied write. The write's own evalScript has
 * already committed its undo group, so a read that fails afterwards (a
 * timeout, a popup, a host error) must not surface as a bare tool error:
 * the caller would think nothing happened and send the write again. These
 * helpers turn that failure into a receipt mismatch that says the write was
 * applied and not to resend.
 */

import type { ReceiptMismatch } from "../receipts.js";

export function readBackMismatch(opId: string, what: string, err: unknown): ReceiptMismatch {
  return {
    path: "read_back",
    expected: "a read-back after the applied write",
    actual: null,
    message: `The write was applied (op ${opId}) but ${what}: ${err instanceof Error ? err.message : String(err)}. Do not resend; inspect the state with a read tool.`,
  };
}

/** Runs a read after an applied write; never throws. */
export async function readAfterWrite<T>(
  opId: string,
  read: () => Promise<T>,
  what = "the read-back failed"
): Promise<{ value: T | null; failure: ReceiptMismatch | null }> {
  try {
    return { value: await read(), failure: null };
  } catch (err) {
    return { value: null, failure: readBackMismatch(opId, what, err) };
  }
}

/** Runs post-write receipt logic; if it throws, returns the fallback with a mismatch instead. */
export function checkAfterWrite<T>(opId: string, check: () => T, fallback: (failure: ReceiptMismatch) => T): T {
  try {
    return check();
  } catch (err) {
    return fallback(readBackMismatch(opId, "checking the read-back failed", err));
  }
}
