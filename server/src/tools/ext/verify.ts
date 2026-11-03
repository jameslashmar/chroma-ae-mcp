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
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { getDefaultAerenderRegistry, type AerenderJobRecord } from "./aerender.js";

export const AeVerifyRenderSchema = z
  .object({
    path: z.string().min(1).optional().describe("Absolute path of the render: a movie, or one frame of an image sequence."),
    job_id: z.string().min(1).optional().describe("Or an ae_aerender_start job: its output, comp and frame range."),
    comp_id: z.number().int().optional().describe("The comp it should match. Default: the job's comp."),
    sequence: z.boolean().optional().describe("Import as an image sequence. Default: yes for a numbered still (name.0001.png)."),
    keep_imported: z.boolean().optional().describe("Leave the imported render in the project. Default false: it is removed again."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.path === undefined) !== (v.job_id === undefined), { message: "Give path or job_id." });

const STILL = /\.(png|jpe?g|tiff?|exr|dpx|tga|psd|bmp|cin|hdr|webp)$/i;

/** A numbered still is a sequence frame. */
export function looksLikeSequence(file: string): boolean {
  return STILL.test(file) && /\d+\.[^.]+$/.test(path.basename(file));
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
export function renderChecks(r: RenderInfo, c: CompInfo, jobFrames?: number): RenderCheck[] {
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
    out.push({ what: "fps", expected: c.fps, actual: r.fps, ok: Math.abs(r.fps - c.fps) < 0.01 });
  }
  const sameSize = r.width === c.width && r.height === c.height;
  const half = r.width * 2 === c.width && r.height * 2 === c.height;
  out.push({ what: "size", expected: [c.width, c.height], actual: [r.width, r.height], ok: sameSize, ...(half ? { note: "half resolution: check the render settings" } : {}) });
  if (c.has_audio) out.push({ what: "audio", expected: true, actual: r.has_audio, ok: r.has_audio, ...(r.has_audio ? {} : { note: "the comp has sound; the output module may have audio off" }) });
  return out;
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
        "or with the aerender job's frame range when given a job_id. The imported item is removed again unless keep_imported; the import and removal are two undo steps and mark the project changed. " +
        "Guarded by `expect`, with an automatic checkpoint. No outside tools (no ffprobe). " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeVerifyRenderSchema,
      handler: async (args: z.infer<typeof AeVerifyRenderSchema>, ctx: ToolContext) => {
        let file = args.path;
        let compName: string | undefined;
        let jobFrames: number | undefined;
        if (args.job_id) {
          const job = getJob(args.job_id);
          if (!job) return { ok: false, error: "unknown_job", message: `No aerender job ${args.job_id}` };
          if (job.state !== "succeeded") return { ok: false, error: "not_finished", message: `The job is ${job.state}${job.error ? `: ${job.error}` : ""}.` };
          file = firstFrameOf(job.output_path) ?? undefined;
          if (!file) return { ok: false, error: "no_output", message: `No render found at ${job.output_path}` };
          compName = job.comp_name;
          if (job.start_frame !== undefined && job.end_frame !== undefined) jobFrames = job.end_frame - job.start_frame + 1;
        }
        if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return { ok: false, error: "bad_path", message: `Not an existing absolute path: ${file}` };
        const stat = fs.statSync(file);
        if (stat.size === 0) return { ok: false, error: "empty", message: `${file} is empty.` };
        if (args.comp_id === undefined && !compName) return { ok: false, error: "bad_args", message: "Give comp_id to compare with." };
        const sequence = args.sequence ?? looksLikeSequence(file);
        const jsxPath = file.replace(/\\/g, "/");

        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const call = <T,>(suffix: string, fn: string, a: Record<string, unknown>, mutates: boolean) =>
          ctx.bridge.evalRaw<T>({ id: `${opId}_${suffix}`, script: buildJsxCall(fn, a), label: `ae_verify_render (${suffix})`, mutates, toolName: "ae_verify_render" });
        try {
          return await ctx.queue.run("ae_verify_render", async () => {
            ctx.quarantine.assertClear();
            const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id };
            const guard = await verifyTargetGuard(ctx, expect, opId);
            const checkpoint = await autoCheckpoint(ctx, guard, "ae_verify_render");
            const comp = (await call<CompInfo>("comp", "verifyCompInfo", { comp_id: args.comp_id, comp_name: compName }, false)).result;
            const imported = (await call<{ item_id: number }>("import", "verifyImport", { path: jsxPath, sequence, expect, label: "Verify render: import" }, true)).result;
            // Read in its own evalScript, after the import.
            const render = (await call<RenderInfo>("read", "verifyRead", { item_id: imported.item_id }, false)).result;
            let removed = false;
            if (!args.keep_imported) {
              await call("remove", "verifyRemove", { item_id: imported.item_id, expect, label: "Verify render: remove" }, true);
              removed = true;
            }
            const checks = renderChecks(render, comp, jobFrames);
            return {
              ok: true,
              matches: checks.every((c) => c.ok),
              file: { path: file, size: stat.size, modified: stat.mtime.toISOString(), sequence },
              render,
              comp: { comp_id: comp.comp_id, name: comp.name },
              checks,
              imported_item: removed ? null : imported.item_id,
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
