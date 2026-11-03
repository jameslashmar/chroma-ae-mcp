/**
 * server/src/tools/ext/write-runner.ts
 *
 * The guarded write every mutating tool goes through, in one queue lease:
 * quarantine check → target guard → automatic checkpoint → before read →
 * the write (one undo group, inside the host function) → after read in a
 * separate evalScript → receipt.
 *
 * Tool groups describe what to read and write; this runs it the same way
 * each time, so a new tool can't skip a step.
 */

import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import type { ExpectGuard, ToolContext } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";

export interface HostCall {
  host: string;
  args: Record<string, unknown>;
}

export type Written = Record<string, unknown>;

export interface GuardedWriteSpec<W extends Written = Written> {
  toolName: string;
  label: string;
  expect: ExpectGuard;
  /** Fills expect.comp_id when the caller left it out. */
  compId?: number;
  /**
   * The read for the receipt. Called with "before", then with "after" and
   * what the write returned (the read after can depend on it, e.g. a new
   * comp's id). Return null to skip a read.
   */
  read?: (phase: "before" | "after", written?: W) => HostCall | null;
  /** The write. `expect` is added to its args. */
  write: HostCall;
  check?: (before: unknown, after: unknown, written: W) => ReceiptMismatch[];
  present?: (before: unknown, after: unknown, written: W) => Record<string, unknown>;
}

export async function runGuardedWrite<W extends Written = Written>(ctx: ToolContext, spec: GuardedWriteSpec<W>) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect: ExpectGuard = {
    project_path: spec.expect.project_path,
    comp_id: spec.expect.comp_id ?? spec.compId,
  };
  const read = async (phase: "before" | "after", written?: W) => {
    const call = spec.read?.(phase, written);
    if (!call) return null;
    const res = await ctx.bridge.evalRaw({
      id: `${opId}_${phase}`,
      script: buildJsxCall(call.host, call.args),
      label: `${spec.label} (${phase})`,
      mutates: false,
      toolName: spec.toolName,
    });
    return res.result ?? null;
  };

  try {
    return await ctx.queue.run(spec.label, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expect, opId);
      const checkpoint = await autoCheckpoint(ctx, guard, spec.toolName);
      const before = await read("before");
      const write = await ctx.bridge.evalRaw<W>({
        id: opId,
        script: buildJsxCall(spec.write.host, { ...spec.write.args, expect }),
        label: spec.label,
        mutates: true,
        toolName: spec.toolName,
      });
      const written = (write.result ?? {}) as W;
      // Separate evalScript for the read-back: a read in the write's own
      // script returns stale values.
      const after = await read("after", written);
      const receipt = buildReceipt({
        before,
        after,
        customMismatches: spec.check?.(before, after, written) ?? [],
      });
      return {
        op_id: opId,
        applied: true as const,
        ...(spec.present?.(before, after, written) ?? written),
        checkpoint,
        receipt,
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

/** Pushes a mismatch when `ok` is false. Keeps the check functions short. */
export function expectThat(
  mismatches: ReceiptMismatch[],
  ok: boolean,
  path: string,
  expected: unknown,
  actual: unknown,
  message: string
): void {
  if (!ok) mismatches.push({ path, expected, actual, message });
}
