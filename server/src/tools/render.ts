import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../host.js";
import { buildJsxCall } from "../jsx.js";
import { defaultDataDir } from "../quarantine.js";
import { buildReceipt } from "../receipts.js";
import { QueueWaitError } from "../queue.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  type ToolDefinition,
} from "./common.js";
import { writeScaledCopy } from "./ext/png-utils.js";
import { verifyTargetGuard } from "./mutate.js";

export const AeSnapshotFrameSchema = z.object({
  comp_id: z.number().int().describe("The CompItem ID to snapshot."),
  time: z
    .number()
    .min(0)
    .describe("Composition time in seconds at which to capture the frame."),
  scale: z
    .number()
    .gt(0)
    .max(1)
    .default(0.5)
    .optional()
    .describe(
      "Size of the returned PNG as a fraction of the comp (default 0.5). AE always renders at full resolution (changing the comp's resolution would put steps on the user's undo stack); the server shrinks the PNG afterwards and keeps the full-size file as `full_path`."
    ),
  max_size: z
    .number()
    .int()
    .min(16)
    .max(8192)
    .optional()
    .describe(
      "Long edge in pixels of the returned PNG. Overrides `scale`. 512 to 1024 is enough for most visual checks and costs far fewer image tokens."
    ),
});

export const AeRenderQueueAddSchema = z.object({
  comp_id: z.number().int().describe("The CompItem ID to add to the Render Queue."),
  output_path: z
    .string()
    .min(1)
    .describe("Absolute file path for the rendered output."),
  output_module_template: z
    .string()
    .optional()
    .describe("Optional Output Module template name."),
  render_settings_template: z
    .string()
    .optional()
    .describe("Optional Render Settings template name."),
  expect: ExpectSchema,
});

export const AeRenderQueueStatusSchema = z.object({});

export function defaultFramesDir(): string {
  return path.join(defaultDataDir(), "frames");
}

export function isFreshPngFile(
  filePath: string,
  requestStartMs: number
): { fresh: boolean; size: number; mtimeMs: number } {
  try {
    if (!fs.existsSync(filePath)) {
      return { fresh: false, size: 0, mtimeMs: 0 };
    }
    const stat = fs.statSync(filePath);
    // Allow small filesystem mtime granularity tolerance (50ms) when file is newly created,
    // or strictly >= requestStartMs - 50
    const fresh = stat.size > 0 && stat.mtimeMs >= requestStartMs - 50;
    return { fresh, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { fresh: false, size: 0, mtimeMs: 0 };
  }
}

/**
 * saveFrameToPng returns before the PNG is written (measured on AE 26.0: the file
 * exists at 0 bytes when evalScript returns and fills in shortly after). Poll
 * until it is non-empty and its size has held still across two reads.
 */
export async function waitForFreshPng(
  filePath: string,
  requestStartMs: number,
  timeoutMs: number = 10_000,
  intervalMs: number = 100
): Promise<{ fresh: boolean; size: number; mtimeMs: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = isFreshPngFile(filePath, requestStartMs);
  for (;;) {
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    const next = isFreshPngFile(filePath, requestStartMs);
    if (next.fresh && last.fresh && next.size === last.size) return next;
    last = next;
  }
}

/**
 * Shrinks a fresh full-resolution snapshot on the server (never in AE) and
 * describes the file the agent should look at.
 */
function snapshotOutput(
  fullPath: string,
  check: { size: number; mtimeMs: number },
  scale: number,
  maxSize: number | undefined
): {
  path: string;
  full_path: string;
  size: number;
  mtimeMs: number;
  width: number;
  height: number;
} {
  const copy = writeScaledCopy(fullPath, fullPath.replace(/\.png$/i, "_small.png"), {
    scale,
    maxSize,
  });
  return {
    path: copy.path,
    full_path: fullPath,
    size: copy.scaled ? fs.statSync(copy.path).size : check.size,
    mtimeMs: check.mtimeMs,
    width: copy.width,
    height: copy.height,
  };
}

export const renderTools: ToolDefinition<any>[] = [
  {
    name: "ae_snapshot_frame",
    description:
      "Render a single frame of a composition to a unique PNG path in `%LOCALAPPDATA%\\chroma-ae-mcp\\frames\\`. " +
      "saveFrameToPng writes asynchronously, so the server waits (up to 10 s) for the file to be non-empty and stable, and checks its mtime is newer than the request; if not, retries once with a slight time nudge (+0.001s), and if still invalid reports `stale_frame`. " +
      "`path` is the PNG at the requested `scale` or `max_size` (shrunk on the server), `full_path` the full-resolution render. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSnapshotFrameSchema,
    handler: async (args, ctx) => {
      const scale = args.scale ?? 0.5;
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });

      const opId = ctx.bridge.newOpId();

      try {
        return await ctx.queue.run(
          `ae_snapshot_frame(${args.comp_id} @ ${args.time}s)`,
          async () => {
            const uniqueSuffix1 = `${Date.now()}_${crypto
              .randomBytes(4)
              .toString("hex")}`;
            const pngPath1 = path.join(
              framesDir,
              `frame_c${args.comp_id}_${uniqueSuffix1}.png`
            );
            const reqStart1 = Date.now();

            const resp1 = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_try1`,
              script: buildJsxCall("snapshotFrame", {
                comp_id: args.comp_id,
                time: args.time,
                scale,
                output_path: pngPath1,
              }),
              label: `ae_snapshot_frame(${args.comp_id} @ ${args.time}s)`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: false,
              toolName: "ae_snapshot_frame",
            });

            const check1 = await waitForFreshPng(pngPath1, reqStart1);
            if (check1.fresh) {
              return {
                ok: true,
                ...snapshotOutput(pngPath1, check1, scale, args.max_size),
                comp_id: args.comp_id,
                // snapshotFrame clamps time to the comp's duration; report what was
                // actually rendered when the host tells us, not the raw request.
                time: (resp1.result?.time as number | undefined) ?? args.time,
                scale,
                ...(args.max_size !== undefined ? { max_size: args.max_size } : {}),
                retried: false,
                comp_width: resp1.result?.width,
                comp_height: resp1.result?.height,
              };
            }

            // Retry once with a small time nudge
            const nudgedTime = Math.max(0, args.time + 0.001);
            const uniqueSuffix2 = `${Date.now()}_${crypto
              .randomBytes(4)
              .toString("hex")}`;
            const pngPath2 = path.join(
              framesDir,
              `frame_c${args.comp_id}_${uniqueSuffix2}.png`
            );
            const reqStart2 = Date.now();

            const resp2 = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_try2`,
              script: buildJsxCall("snapshotFrame", {
                comp_id: args.comp_id,
                time: nudgedTime,
                scale,
                output_path: pngPath2,
              }),
              label: `ae_snapshot_frame(${args.comp_id} @ ${nudgedTime}s retry)`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: false,
              toolName: "ae_snapshot_frame",
            });

            const check2 = await waitForFreshPng(pngPath2, reqStart2);
            if (check2.fresh) {
              return {
                ok: true,
                ...snapshotOutput(pngPath2, check2, scale, args.max_size),
                comp_id: args.comp_id,
                time: (resp2.result?.time as number | undefined) ?? nudgedTime,
                scale,
                ...(args.max_size !== undefined ? { max_size: args.max_size } : {}),
                retried: true,
                comp_width: resp2.result?.width,
                comp_height: resp2.result?.height,
              };
            }

            return {
              ok: false,
              error: "stale_frame",
              kind: "stale_frame",
              message:
                "saveFrameToPng did not produce a fresh non-empty PNG after retrying with a time nudge.",
              comp_id: args.comp_id,
              time: args.time,
              scale,
              retried: true,
              attempts: [
                { path: pngPath1, size: check1.size, mtimeMs: check1.mtimeMs },
                { path: pngPath2, size: check2.size, mtimeMs: check2.mtimeMs },
              ],
            };
          }
        );
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
    },
  },
  {
    name: "ae_render_queue_add",
    description:
      "Add a composition to the After Effects Render Queue with an output path and optional templates, guarded by `expect`, returning the RQ item index and a before/after receipt. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueAddSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const effectiveExpect = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id,
      };

      try {
        return await ctx.queue.run(
          `ae_render_queue_add(${args.comp_id})`,
          async () => {
            ctx.quarantine.assertClear();

            await verifyTargetGuard(ctx, effectiveExpect, opId);

            const beforeRq = await ctx.bridge.evalRaw({
              id: `${opId}_before`,
              script: buildJsxCall("rqStatus", {}),
              label: "ae_render_queue_add (before rqStatus)",
              mutates: false,
              toolName: "ae_render_queue_add",
            });

            const addResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: opId,
              script: buildJsxCall("rqAdd", {
                comp_id: args.comp_id,
                output_path: args.output_path,
                output_module_template: args.output_module_template,
                render_settings_template: args.render_settings_template,
                expect: effectiveExpect,
              }),
              label: `ae_render_queue_add(${args.comp_id})`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: true,
              toolName: "ae_render_queue_add",
            });

            // Separate read-back evalScript
            const afterRq = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("rqStatus", {}),
              label: "ae_render_queue_add (after rqStatus)",
              mutates: false,
              toolName: "ae_render_queue_add",
            });

            const rqIndex =
              typeof addResp.result?.index === "number"
                ? addResp.result.index
                : typeof addResp.result?.rq_index === "number"
                ? addResp.result.rq_index
                : undefined;

            const afterItems = Array.isArray(afterRq.result?.items)
              ? (afterRq.result.items as Array<Record<string, unknown>>)
              : [];

            const receipt = buildReceipt({
              before: beforeRq.result,
              after: afterRq.result,
              expected:
                rqIndex !== undefined
                  ? { rq_item_present: true }
                  : undefined,
              actualForExpected:
                rqIndex !== undefined
                  ? {
                      rq_item_present:
                        afterItems.length >= rqIndex ||
                        afterItems.some((item) => item.index === rqIndex),
                    }
                  : undefined,
            });

            return {
              op_id: opId,
              applied: true as const,
              index: rqIndex,
              result: addResp.result,
              receipt,
            };
          }
        );
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
    },
  },
  {
    name: "ae_render_queue_status",
    description:
      "Read all items currently in the After Effects Render Queue (comp, status, output paths). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueStatusSchema,
    handler: async (_args, ctx) => {
      const res = await ctx.bridge.callHost(
        "rqStatus",
        {},
        {
          label: "ae_render_queue_status",
          mutates: false,
          toolName: "ae_render_queue_status",
        }
      );
      return res.result;
    },
  },
];
