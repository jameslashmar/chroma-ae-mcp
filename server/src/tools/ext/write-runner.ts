/**
 * server/src/tools/ext/write-runner.ts
 *
 * The guarded write every mutating tool goes through, in one queue lease:
 * quarantine check → target guard → automatic checkpoint → before read →
 * the write (one undo group, inside the host function) → after read in a
 * separate evalScript → receipt. With session tracking on (ext/session.ts)
 * it also reports what the user changed since the last write, keeps a
 * write-ahead record while the write runs, and stores the new baseline.
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
import { readBackMismatch } from "../read-back.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite } from "./session.js";

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
   * comp's id), and with what the before read returned (so the read after
   * can ask for the layers the write touched). Return null to skip a read.
   */
  read?: (phase: "before" | "after", written?: W, before?: unknown) => HostCall | null;
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
  const read = async (phase: "before" | "after", written?: W, before?: unknown) => {
    const call = spec.read?.(phase, written, before);
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
      const note = { opId, toolName: spec.toolName, label: spec.label, expect, checkpoint: checkpoint?.path ?? null };
      const sessionFields = await noteBeforeWrite(ctx, note);
      const before = await read("before");
      // The record lives while the evalScript runs; if AE dies mid-write it is
      // still there at the next start and turns into a quarantine entry.
      beginInflight(note);
      let write;
      try {
        write = await ctx.bridge.evalRaw<W>({
          id: opId,
          script: buildJsxCall(spec.write.host, { ...spec.write.args, expect }),
          label: spec.label,
          mutates: true,
          toolName: spec.toolName,
        });
      } finally {
        endInflight(opId);
      }
      const written = (write.result ?? {}) as W;
      // From here the write is applied: nothing below may throw, or the caller
      // sees a bare error for a change that happened and resends it.
      // Separate evalScript for the read-back: a read in the write's own
      // script returns stale values.
      let after: unknown = null;
      let readBackFailure: ReceiptMismatch | null = null;
      try {
        after = await read("after", written, before);
      } catch (err) {
        readBackFailure = readBackMismatch(opId, "the read-back failed", err);
      }
      let custom: ReceiptMismatch[] = [];
      let shown: Record<string, unknown> = written;
      if (!readBackFailure) {
        // check and present assume a valid read-back, so they are skipped when it failed.
        try {
          custom = spec.check?.(before, after, written) ?? [];
          shown = spec.present?.(before, after, written) ?? written;
        } catch (err) {
          custom = [readBackMismatch(opId, "checking the read-back failed", err)];
          shown = written;
        }
      } else {
        custom = [readBackFailure];
      }
      const receipt = buildReceipt({ before, after, customMismatches: custom });
      await noteAfterWrite(ctx, note);
      return {
        op_id: opId,
        applied: true as const,
        ...shown,
        checkpoint,
        receipt,
        ...sessionFields,
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
