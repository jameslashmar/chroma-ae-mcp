/**
 * server/src/tools/ext/verify.ts
 *
 * ae_verify_render: checks a finished render by importing it back into AE
 * (so any format AE reads works, and no outside tool is needed), reading its
 * length, frame count, frame rate, size and audio in a separate evalScript,
 * comparing them with the comp (or the aerender job's frame range), and
 * removing the imported item again.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readBackMismatch } from "../read-back.js";
import { getDefaultAerenderRegistry, type AerenderJobRecord } from "./aerender.js";

export const AeVerifyRenderSchema = z
  .object({
    path: z.string().min(1).optional().describe("Absolute path of the render: a movie, or one frame of an image sequence."),
    job_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Or an ae_aerender_start job: its output, comp and frame range. For a job started with rq_index every output module's file is checked first (exists, not empty, written after the job started) and the one picked by output_index is imported and compared with the item's comp (by its stored comp id); the frame range is the item's time span read at launch, so a render-settings frame rate override can show as a frames mismatch. For a whole_queue job give comp_id and output_index of the output to compare."
      ),
    output_index: z.number().int().min(1).max(500).optional().describe("With a job_id that has several outputs (rq_index / whole_queue): which output_paths entry to import and compare, 1-based. Default 1. Every entry is still checked for existence."),
    comp_id: z.number().int().optional().describe("The comp it should match. Default: the job's comp."),
    sequence: z.boolean().optional().describe("Import as an image sequence. Default: yes when other frames with the same numbering sit beside it (name.0001.png, name.0002.png), or for an aerender [####] output."),
    keep_imported: z.boolean().optional().describe("Leave the imported render in the project. Default false: it is removed again."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.path === undefined) !== (v.job_id === undefined), { message: "Give path or job_id." });

const STILL = /\.(png|jpe?g|tiff?|exr|dpx|tga|psd|bmp|cin|hdr|webp)$/i;

/** A numbered still is a sequence frame only when other frames with the same pattern sit beside it. */
export function looksLikeSequence(file: string): boolean {
  if (!STILL.test(file)) return false;
  const base = path.basename(file);
  // A frame counter is padded (3+ digits after a separator); title2.png beside title1.png is not a sequence.
  if (!/[._-]\d{3,}\.[^.]+$/.test(base)) return false;
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(base);
  if (!m) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(m[1])}\\d{${m[2].length}}${esc(m[3])}$`, "i");
  try {
    return fs.readdirSync(path.dirname(file)).some((n) => n !== base && re.test(n));
  } catch {
    return false;
  }
}

/** aerender writes `name_[####].png` as name_0000.png...; find the first frame on disk. */
export function firstFrameOf(output: string): string | null {
  if (!/\[#+\]/.test(output)) return fs.existsSync(output) ? output : null;
  const dir = path.dirname(output);
  const base = path.basename(output);
  const m = /^(.*)\[(#+)\](.*)$/.exec(base);
  if (!m) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(m[1])}(\\d{${m[2].length},})${esc(m[3])}$`, "i");
  try {
    const frames = fs
      .readdirSync(dir)
      .filter((n) => re.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return frames.length ? path.join(dir, frames[0]) : null;
  } catch {
    return null;
  }
}

interface RenderInfo {
  item_id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  has_video: boolean;
  has_audio: boolean;
  still: boolean;
  frames: number | null;
}

interface CompInfo {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  work_area_start: number;
  work_area_duration: number;
  has_audio: boolean;
}

export interface RenderCheck {
  what: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
  note?: string;
}

/** The checks: frames (against the job's range, else the comp or its work area), frame rate, size, audio. */
export function renderChecks(r: RenderInfo, c: CompInfo, jobFrames?: number, sequence = false): RenderCheck[] {
  const out: RenderCheck[] = [];
  if (!r.still) {
    const compFrames = Math.round(c.duration * c.fps);
    const workFrames = Math.round(c.work_area_duration * c.fps);
    if (jobFrames !== undefined) {
      out.push({ what: "frames", expected: jobFrames, actual: r.frames, ok: r.frames === jobFrames, note: "the job's frame range" });
    } else {
      const ok = r.frames === compFrames || r.frames === workFrames;
      out.push({
        what: "frames",
        expected: compFrames === workFrames ? compFrames : [compFrames, workFrames],
        actual: r.frames,
        ok,
        note: r.frames === workFrames && compFrames !== workFrames ? "matches the work area" : compFrames === workFrames ? undefined : "the comp or its work area",
      });
    }
    if (sequence) {
      // A sequence has no frame rate of its own (AE uses its import preference), so judge by frame count.
      out.push({ what: "fps", expected: c.fps, actual: r.fps, ok: true, note: "an image sequence has no frame rate of its own; the frame count is what is checked" });
    } else {
      out.push({ what: "fps", expected: c.fps, actual: r.fps, ok: Math.abs(r.fps - c.fps) < 0.01 });
    }
  }
  const sameSize = r.width === c.width && r.height === c.height;
  const half = r.width * 2 === c.width && r.height * 2 === c.height;
  out.push({ what: "size", expected: [c.width, c.height], actual: [r.width, r.height], ok: sameSize, ...(half ? { note: "half resolution: check the render settings" } : {}) });
  if (c.has_audio) out.push({ what: "audio", expected: true, actual: r.has_audio, ok: r.has_audio, ...(r.has_audio ? {} : { note: "the comp has sound; the output module may have audio off" }) });
  return out;
}

export interface JobOutputCheck {
  path: string;
  file: string | null;
  exists: boolean;
  size_bytes: number;
  fresh: boolean;
  problem?: string;
}

/** Every output file of an rq_index / whole_queue job: it exists (the first frame of a sequence), is not empty and was written since the job started. */
export function checkJobOutputs(paths: string[], startedAt: string | undefined): { ok: boolean; outputs: JobOutputCheck[] } {
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const outputs: JobOutputCheck[] = paths.slice(0, 500).map((p) => {
    const file = firstFrameOf(p);
    if (!file) return { path: p, file: null, exists: false, size_bytes: 0, fresh: false, problem: "the output does not exist" };
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(file);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return { path: p, file, exists: false, size_bytes: 0, fresh: false, problem: "the output could not be read" };
    }
    const fresh = Number.isNaN(startedMs) || mtime >= startedMs - 2000;
    const problem = size === 0 ? "the output is empty" : !fresh ? "the output is older than the job's start (aerender did not write it)" : undefined;
    return { path: p, file, exists: true, size_bytes: size, fresh, ...(problem ? { problem } : {}) };
  });
  return { ok: outputs.length > 0 && outputs.every((o) => o.problem === undefined), outputs };
}

export interface VerifyOptions {
  getJob?: (id: string) => AerenderJobRecord | undefined;
}

export function createVerifyTools(options: VerifyOptions = {}): ToolDefinition<any>[] {
  const getJob = options.getJob ?? ((id: string) => getDefaultAerenderRegistry().get(id));
  return [
    {
      name: "ae_verify_render",
      description:
        "Check a finished render by importing it back into After Effects: its frame count, frame rate, size and audio are read by AE (any format AE can open, image sequences too) and compared with the comp, " +
        "or with the aerender job's frame range when given a job_id. A job started with ae_aerender_start rq_index / whole_queue has several output files: all of them are checked for existence before the import, and output_index picks the one imported and compared (job_outputs lists them all). The imported item is removed again unless keep_imported; the import and removal are two undo steps and mark the project changed. " +
        "Guarded by `expect`, with an automatic checkpoint. No outside tools (no ffprobe). " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeVerifyRenderSchema,
      handler: async (args: z.infer<typeof AeVerifyRenderSchema>, ctx: ToolContext) => {
        let file = args.path;
        let compName: string | undefined;
        let jobFrames: number | undefined;
        let jobIsSequence = false;
        let jobCompId: number | undefined;
        let jobOutputs: JobOutputCheck[] | undefined;
        let renderQueue: { rq_index?: number; item_comp_id?: number; whole_queue?: boolean } | undefined;
        if (args.job_id) {
          const job = getJob(args.job_id);
          if (!job) return { ok: false, error: "unknown_job", message: `No aerender job ${args.job_id}` };
          if (job.state !== "succeeded") return { ok: false, error: "not_finished", message: `The job is ${job.state}${job.error ? `: ${job.error}` : ""}.` };
          let outputPath = job.output_path;
          if (job.output_paths && job.output_paths.length > 0) {
            // A Render Queue job: every output module's file counts, not only the first.
            const checked = checkJobOutputs(job.output_paths, job.started_at);
            jobOutputs = checked.outputs;
            if (!checked.ok) {
              return {
                ok: false,
                error: "output_missing",
                message: `${checked.outputs.filter((o) => o.problem).length} of the job's ${checked.outputs.length} output(s) are missing, empty or stale: ${checked.outputs
                  .filter((o) => o.problem)
                  .slice(0, 5)
                  .map((o) => `${o.path} (${o.problem})`)
                  .join("; ")}`,
                outputs: checked.outputs,
              };
            }
            const pick = args.output_index ?? 1;
            if (pick > job.output_paths.length) return { ok: false, error: "bad_args", message: `output_index ${pick} is past the job's ${job.output_paths.length} output(s).` };
            outputPath = job.output_paths[pick - 1];
            jobCompId = job.comp_id ?? job.item_comp_id;
            renderQueue = { ...(job.rq_index !== undefined ? { rq_index: job.rq_index, item_comp_id: job.item_comp_id } : {}), ...(job.whole_queue ? { whole_queue: true } : {}) };
          }
          file = firstFrameOf(outputPath) ?? undefined;
          if (!file) return { ok: false, error: "no_output", message: `No render found at ${outputPath}` };
          // A whole-queue job renders several comps: its "<render queue>" name is no comp to look up.
          compName = job.whole_queue ? undefined : job.comp_name;
          jobIsSequence = /\[#+\]/.test(outputPath);
          if (job.start_frame !== undefined && job.end_frame !== undefined) jobFrames = job.end_frame - job.start_frame + 1;
        }
        if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return { ok: false, error: "bad_path", message: `Not an existing absolute path: ${file}` };
        const stat = fs.statSync(file);
        if (stat.size === 0) return { ok: false, error: "empty", message: `${file} is empty.` };
        if (args.comp_id === undefined && jobCompId === undefined && !compName) {
          return { ok: false, error: "bad_args", message: "Give comp_id to compare with (a whole-queue job renders several comps)." };
        }
        // Only a still can be an image sequence; a movie keeps its own rate.
        const sequence = (args.sequence ?? (jobIsSequence || looksLikeSequence(file))) && STILL.test(file);
        const jsxPath = file.replace(/\\/g, "/");

        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const call = <T,>(suffix: string, fn: string, a: Record<string, unknown>, mutates: boolean, mustSend = false) =>
          ctx.bridge.evalRaw<T>({ id: `${opId}_${suffix}`, script: buildJsxCall(fn, a), label: `ae_verify_render (${suffix})`, mutates, mustSend, toolName: "ae_verify_render" });
        try {
          return await ctx.queue.run("ae_verify_render", async () => {
            ctx.quarantine.assertClear();
            const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id };
            const guard = await verifyTargetGuard(ctx, expect, opId);
            const checkpoint = await autoCheckpoint(ctx, guard, "ae_verify_render");
            const comp = (await call<CompInfo>("comp", "verifyCompInfo", { comp_id: args.comp_id ?? jobCompId, comp_name: compName }, false)).result;
            const imported = (await call<{ item_id: number }>("import", "verifyImport", { path: jsxPath, sequence, fps: sequence ? comp.fps : undefined, expect, label: "Verify render: import" }, true)).result;
            // The render is in the project from here on: nothing below throws. Failures are
            // reported with what happened to the imported item, so a caller never imports twice.
            const problems: ReceiptMismatch[] = [];
            let render: RenderInfo | null = null;
            try {
              // Read in its own evalScript, after the import.
              render = (await call<RenderInfo>("read", "verifyRead", { item_id: imported.item_id }, false)).result;
            } catch (err) {
              problems.push(readBackMismatch(opId, "reading the imported render failed", err));
            }
            // removed: confirmed gone; kept: keep_imported; left: the removal failed or didn't take; unknown: the removal timed out
            // (it is still queued and runs when AE answers) or the check afterwards failed.
            let itemState: "removed" | "kept" | "left" | "unknown" = "kept";
            // The removal is sent even after a timeout or a lost bridge (mustSend): it waits for AE and then takes the item out,
            // as the other cleanups do. The only reason to skip it was that it used to queue behind a blocked eval.
            if (!args.keep_imported) {
              let removeErr: unknown;
              try {
                await call("remove", "verifyRemove", { item_id: imported.item_id, expect, label: "Verify render: remove" }, true, true);
              } catch (err) {
                removeErr = err;
              }
              if (removeErr !== undefined) {
                // A timed-out removal is still queued behind AE's eval and runs when AE is free: its outcome is not "left".
                itemState = removeErr instanceof BridgeError && removeErr.kind === "timeout" ? "unknown" : "left";
                problems.push(readBackMismatch(opId, `removing the imported render (item ${imported.item_id}) failed`, removeErr));
              } else {
                // Read back in a separate evalScript: the item must be gone.
                try {
                  await call("gone", "verifyRead", { item_id: imported.item_id }, false);
                  itemState = "left";
                  problems.push({ path: "cleanup", expected: "removed", actual: imported.item_id, message: `The imported render (item ${imported.item_id}) is still in the project after its removal.` });
                } catch (errG) {
                  if (errG instanceof BridgeError && /not_found|No imported item/i.test(errG.message)) itemState = "removed";
                  else {
                    itemState = "unknown";
                    problems.push(readBackMismatch(opId, `the check that the imported render (item ${imported.item_id}) is gone failed`, errG));
                  }
                }
              }
            }
            const leftover = itemState === "removed" ? null : imported.item_id;
            if (!render) {
              return {
                ok: false,
                error: "read_failed",
                applied: true,
                message: `The render was imported but could not be read back. Do not run this again before checking item ${imported.item_id} (${itemState}).`,
                problems,
                imported_item: leftover,
                imported_item_state: itemState,
                project_changed: true,
                checkpoint,
              };
            }
            const checks = renderChecks(render, comp, jobFrames, sequence);
            return {
              ok: true,
              matches: checks.every((c) => c.ok),
              file: { path: file, size: stat.size, modified: stat.mtime.toISOString(), sequence },
              render,
              comp: { comp_id: comp.comp_id, name: comp.name },
              checks,
              ...(jobOutputs ? { job_outputs: jobOutputs, ...(renderQueue ? { render_queue: renderQueue } : {}) } : {}),
              imported_item: leftover,
              imported_item_state: itemState,
              ...(problems.length ? { problems } : {}),
              project_changed: true,
              checkpoint,
            };
          });
        } catch (err) {
          if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
          throw err;
        }
      },
    },
  ];
}

export const verifyTools: ToolDefinition<any>[] = createVerifyTools();
