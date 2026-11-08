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
  type ToolContext,
  type ToolDefinition,
} from "./common.js";
import { readAfterWrite } from "./read-back.js";
import { writeScaledCopy } from "./ext/png-utils.js";
import { autoCheckpoint, verifyTargetGuard } from "./mutate.js";
import { preflightRefusal, runPreflightGate } from "./ext/preflight.js";
import { followQueue } from "./ext/rqfollow.js";
import { captureCompFrame } from "./ext/frames.js";
import {
  MAX_SAVE_FRAMES,
  checkSaveFolder,
  moveRenderedFrame,
  planFrames,
  savedFrameName,
  type SavedFrame,
} from "./ext/frame-save.js";

export const AeSnapshotFrameSchema = z.object({
  comp_id: z.number().int().describe("The CompItem ID to snapshot."),
  time: z
    .number()
    .min(0)
    .optional()
    .describe("Composition time in seconds at which to capture the frame. Required, except with `save_to` (which takes `frames` or `times`)."),
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
  save_to: z
    .object({
      folder: z.string().min(1).describe("Absolute path of an existing folder. It is never created."),
      overwrite: z.boolean().optional().describe("Replace files that already exist. Default false: an existing file refuses the whole call before anything is rendered."),
    })
    .optional()
    .describe("Save full-resolution PNGs of the frames in `frames` or `times` (up to 50) into this folder as `<comp name>_<frame>.png`, instead of one snapshot. Gives each file's path, bytes, frame and time."),
  frames: z
    .array(z.number().int().min(0))
    .min(1)
    .max(MAX_SAVE_FRAMES)
    .optional()
    .describe("With `save_to`: frame numbers (0 is the comp's first frame)."),
  times: z
    .array(z.number().min(0))
    .min(1)
    .max(MAX_SAVE_FRAMES)
    .optional()
    .describe("With `save_to`: times in seconds, each taken to the nearest frame. Use `frames` or `times`, not both."),
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
  preflight: z
    .boolean()
    .optional()
    .describe(
      "Run the ae_preflight delivery check on this comp (and the comps it nests) first, and refuse to add it to the queue if it finds a blocker (missing footage or fonts, expressions in error). A missing output folder is only a warning and does not refuse. Nothing is changed when it refuses. Default false."
    ),
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

/** The poll of waitForFreshPng. Production keeps 100 ms / 10 s; test/setup-resources.ts sets a short interval so render tests do not sleep. */
export const pngWaitDeps = { intervalMs: 100, timeoutMs: 10_000 };

/**
 * saveFrameToPng returns before the PNG is written (measured on AE 26.0: the file
 * exists at 0 bytes when evalScript returns and fills in shortly after). Poll
 * until it is non-empty and its size has held still across two reads.
 */
export async function waitForFreshPng(
  filePath: string,
  requestStartMs: number,
  timeoutMs: number = pngWaitDeps.timeoutMs,
  intervalMs: number = pngWaitDeps.intervalMs
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

type SnapshotArgs = z.infer<typeof AeSnapshotFrameSchema>;

/** `save_to`: renders the chosen frames at full resolution (captureCompFrame, with its stale-frame retry) and copies each into the caller's folder. */
async function saveChosenFrames(args: SnapshotArgs, ctx: ToolContext, framesDir: string, opId: string): Promise<Record<string, unknown>> {
  const refuse = (error: string, message: string) => ({ ok: false, error, message });
  if (!args.save_to) return refuse("save_to_required", "`frames` and `times` are for `save_to: { folder }`. Nothing was rendered.");
  if ((args.frames === undefined) === (args.times === undefined)) return refuse("frames_or_times", "Pass either `frames` or `times` with `save_to`, not both and not neither. Nothing was rendered.");
  if (args.time !== undefined) return refuse("time_with_save_to", "`time` is for one snapshot; with `save_to` pass `frames` or `times`. Nothing was rendered.");
  const { folder } = args.save_to;
  const overwrite = args.save_to.overwrite === true;
  const folderProblem = checkSaveFolder(folder);
  if (folderProblem) return refuse(folderProblem.code, folderProblem.message);
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    return await ctx.queue.run(`ae_snapshot_frame(${args.comp_id} save_to)`, async () => {
      // The comp's name and frame rate, before anything is rendered.
      const info = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: `${opId}_comp`,
        script: buildJsxCall("getComp", { comp_id: args.comp_id, limit: 1 }),
        label: `ae_snapshot_frame(${args.comp_id} read comp)`,
        mutates: false,
        toolName: "ae_snapshot_frame",
      });
      const comp = (info.result ?? {}) as { name?: unknown; fps?: unknown; duration?: unknown };
      const fps = typeof comp.fps === "number" && comp.fps > 0 ? comp.fps : 0;
      const duration = typeof comp.duration === "number" ? comp.duration : 0;
      if (fps === 0 || duration <= 0) return refuse("comp_unreadable", `Could not read the frame rate and duration of comp ${args.comp_id}. Nothing was rendered.`);
      const compName = typeof comp.name === "string" ? comp.name : `comp${args.comp_id}`;

      const plan = planFrames({ frames: args.frames, times: args.times }, fps, duration);
      if (plan.problem) return refuse(plan.problem.code, plan.problem.message);
      const lastFrame = Math.max(0, Math.round(duration * fps) - 1);
      const targets = plan.picks.map((p) => ({ ...p, dest: path.join(folder, savedFrameName(compName, p.frame, lastFrame)) }));
      if (!overwrite) {
        const taken = targets.filter((t) => fs.existsSync(t.dest)).map((t) => t.dest);
        if (taken.length > 0) {
          return {
            ...refuse("file_exists", `${taken.length} file(s) already exist and overwrite is not set; nothing was rendered or written: ${taken.slice(0, 10).join(", ")}${taken.length > 10 ? ", ..." : ""}.`),
            existing: taken.slice(0, 50),
          };
        }
      }

      const saved: SavedFrame[] = [];
      const failed: Array<{ frame: number; path: string; error: string }> = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        try {
          const shot = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: t.time, frameIndex: i, framesDir, toolName: "ae_snapshot_frame" });
          const bytes = moveRenderedFrame(shot.path, t.dest, overwrite);
          saved.push({ path: t.dest, bytes, frame: t.frame, time: shot.time });
        } catch (err) {
          if (err instanceof BridgeError) throw err;
          failed.push({ frame: t.frame, path: t.dest, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        ok: failed.length === 0,
        ...(failed.length > 0 ? { error: "some_frames_not_saved" } : {}),
        comp_id: args.comp_id,
        comp_name: compName,
        folder,
        fps,
        saved,
        ...(failed.length > 0 ? { failed } : {}),
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

export const renderTools: ToolDefinition<any>[] = [
  {
    name: "ae_snapshot_frame",
    description:
      "Render a single frame of a composition to a unique PNG path in `%LOCALAPPDATA%\\chroma-ae-mcp\\frames\\`. " +
      "saveFrameToPng writes asynchronously, so the server waits (up to 10 s) for the file to be non-empty and stable, and checks its mtime is newer than the request; if not, retries once with a slight time nudge (+0.001s), and if still invalid reports `stale_frame`. " +
      "`path` is the PNG at the requested `scale` or `max_size` (shrunk on the server), `full_path` the full-resolution render. " +
      "To keep chosen frames (a plate, a check frame) pass `save_to: {folder, overwrite?}` and `frames` or `times` (up to 50): full-resolution `<comp>_<frame>.png` files in that existing folder. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSnapshotFrameSchema,
    handler: async (args, ctx) => {
      const scale = args.scale ?? 0.5;
      const framesDir = defaultFramesDir();
      const opId = ctx.bridge.newOpId();

      if (args.save_to !== undefined || args.frames !== undefined || args.times !== undefined) {
        return saveChosenFrames(args, ctx, framesDir, opId);
      }
      if (args.time === undefined) {
        return { ok: false, error: "time_required", message: "Pass `time` for one snapshot, or `save_to` with `frames` or `times` to save chosen frames. Nothing was rendered." };
      }
      const time = args.time;
      fs.mkdirSync(framesDir, { recursive: true });

      try {
        return await ctx.queue.run(
          `ae_snapshot_frame(${args.comp_id} @ ${time}s)`,
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
                time: time,
                scale,
                output_path: pngPath1,
              }),
              label: `ae_snapshot_frame(${args.comp_id} @ ${time}s)`,
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
                time: (resp1.result?.time as number | undefined) ?? time,
                scale,
                ...(args.max_size !== undefined ? { max_size: args.max_size } : {}),
                retried: false,
                comp_width: resp1.result?.width,
                comp_height: resp1.result?.height,
              };
            }

            // Retry once with a small time nudge
            const nudgedTime = Math.max(0, time + 0.001);
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
              time: time,
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
      "Add a composition to the After Effects Render Queue with an output path and optional templates, guarded by `expect`, returning the RQ item index and a before/after receipt. With preflight: true it first runs the ae_preflight delivery check on the comp and refuses on a blocker. " +
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

            const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);

            // Read-only, before the checkpoint: a refusal leaves no trace.
            let preflight: Awaited<ReturnType<typeof runPreflightGate>>["summary"] | undefined;
            if (args.preflight) {
              const gate = await runPreflightGate(ctx, { toolName: "ae_render_queue_add", opId, comp_ids: [args.comp_id], planned_output: args.output_path });
              if (gate.blocked) return preflightRefusal("ae_render_queue_add", gate.summary);
              preflight = gate.summary;
            }

            const checkpoint = await autoCheckpoint(ctx, guard, "ae_render_queue_add");

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

            // Separate read-back evalScript. The item is added from here on,
            // so a failed read is reported, never thrown.
            const afterRead = await readAfterWrite(opId, () =>
              ctx.bridge.evalRaw<Record<string, unknown>>({
                id: `${opId}_after`,
                script: buildJsxCall("rqStatus", {}),
                label: "ae_render_queue_add (after rqStatus)",
                mutates: false,
                toolName: "ae_render_queue_add",
              })
            );

            const rqIndex =
              typeof addResp.result?.index === "number"
                ? addResp.result.index
                : typeof addResp.result?.rq_index === "number"
                ? addResp.result.rq_index
                : undefined;

            const afterResult = afterRead.value?.result ?? null;
            const afterItems = Array.isArray(afterResult?.items)
              ? (afterResult.items as Array<Record<string, unknown>>)
              : [];

            const receipt = afterRead.failure
              ? buildReceipt({ before: beforeRq.result, after: null, customMismatches: [afterRead.failure] })
              : buildReceipt({
                  before: beforeRq.result,
                  after: afterResult,
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
              checkpoint,
              ...(preflight ? { preflight } : {}),
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
      "Read all items currently in the After Effects Render Queue (comp, status, output paths). For RENDERING and QUEUED items (even a render the user started by hand) `follow` adds each output file's exists, bytes, mtime and grew_since_last_check (a second read, made only when something renders or an item's Render box is checked). If After Effects does not answer, the earlier read is used and `follow.note` says why (the refusal or timeout, naming the render job when one is running). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueStatusSchema,
    handler: async (_args, ctx) => {
      const toolName = "ae_render_queue_status";
      let status: Record<string, unknown> | null = null;
      let readError: unknown;
      try {
        // The same wait as before the follow was added: a shorter one would leave this eval running in AE after the tool gave up on it.
        const res = await ctx.bridge.callHost("rqStatus", {}, { label: toolName, mutates: false, toolName });
        status = (res.result ?? {}) as Record<string, unknown>;
      } catch (err) {
        readError = err;
      }
      const followed = await followQueue(ctx, status, toolName, readError);
      if (status === null) {
        // After Effects did not answer (busy, or the render gate is shut): answer from the last successful read, or fail as before.
        if (!followed) throw readError;
        return { ok: true, answered_from_earlier_read: true, follow: followed.follow };
      }
      return followed ? { ...status, follow: followed.follow } : status;
    },
  },
];
