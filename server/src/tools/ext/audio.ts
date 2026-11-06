/**
 * server/src/tools/ext/audio.ts
 *
 * Audio tools:
 * - ae_audio_analyze: renders a comp's audio with aerender in the background
 *   (AE's UI stays free), then decodes and analyses it on the server: level,
 *   onsets, tempo, beats, the strongest hits, levels per frame. Or analyses a
 *   WAV/AIFF given by path. Everything AE does to the sound (layer levels,
 *   time remapping, mutes) is in the render.
 * - ae_cue_keys: keyframes on cue times (beats, onsets, words): a pulse from
 *   a base value to a peak and back, planned here, set in one undo group.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { analyzeAudio, AudioDecodeError, decodeAudio, offsetAnalysis, type AnalyzeOptions } from "../../audio.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { aerenderTools, getDefaultAerenderRegistry, type AerenderJobRecord } from "./aerender.js";
import { runGuardedWrite } from "./write-runner.js";

export const DEFAULT_AUDIO_TEMPLATE = "AIFF 48kHz";
const MAX_ANALYSIS_SECONDS = 20 * 60;
const MAX_AUDIO_BYTES = 600 * 1024 * 1024;
const MAX_LIST = 500;
/** Keys the read-back of ae_cue_keys may read: up to three per cue. */
const MAX_SNAPSHOT_KEYS = 3 * MAX_LIST;

// ---------- schemas ----------

const AnalysisOptionFields = {
  levels: z.boolean().optional().describe("Include RMS and peak levels in dBFS, one point per comp frame (with audio_path: per `fps`, default 25), at most 500 points, pooled for long audio. levels.step is the seconds per point, levels.frames_per_point the frames pooled into each."),
  sensitivity: z.number().min(0).max(1).optional().describe("Onset sensitivity 0..1; higher finds quieter hits. Default 0.5."),
  min_bpm: z.number().min(30).max(300).optional().describe("Tempo search range. Default 60."),
  max_bpm: z.number().min(30).max(400).optional().describe("Default 200."),
  hits: z.number().int().min(1).max(100).optional().describe("How many of the strongest onsets to list as hits. Default 20."),
};

export const AeAudioAnalyzeSchema = z
  .object({
    comp_id: z.number().int().optional().describe("Render this comp's audio with aerender and analyse it. The project must be saved, with no unsaved changes."),
    expect: ExpectSchema.optional().describe("Required with comp_id."),
    start: z.number().min(0).optional().describe("With comp_id: comp seconds to start the render at. Default 0."),
    end: z.number().positive().optional().describe("With comp_id: comp seconds to end at. Default the comp's end."),
    output_module_template: z
      .string()
      .min(1)
      .optional()
      .describe(`With comp_id: an audio-only output-module template. Default '${DEFAULT_AUDIO_TEMPLATE}', one of AE's own.`),
    job_id: z.string().min(1).optional().describe("Collect the analysis of a render this tool started earlier."),
    audio_path: z.string().min(1).optional().describe("Analyse this WAV or AIFF file instead (absolute path); nothing is rendered."),
    time_offset: z.number().optional().describe("With audio_path: seconds added to every time (e.g. the audio layer's start in the comp)."),
    fps: z.number().positive().max(240).optional().describe("With audio_path: the comp's frame rate for the levels. Default 25."),
    wait_seconds: z.number().min(0).max(120).optional().describe("How long to wait for the render before returning a job_id. Default 30."),
    ...AnalysisOptionFields,
  })
  .refine((v) => [v.comp_id, v.job_id, v.audio_path].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of comp_id, job_id or audio_path.",
  })
  .refine((v) => v.comp_id === undefined || v.expect !== undefined, { message: "comp_id needs expect." })
  .refine((v) => v.start === undefined || v.end === undefined || v.end > v.start, { message: "end must be after start." })
  .refine((v) => (v.min_bpm ?? 60) < (v.max_bpm ?? 200), { message: "min_bpm must be below max_bpm (defaults 60 and 200)." })
  .refine((v) => v.fps === undefined || v.audio_path !== undefined, { message: "fps goes with audio_path." });

const ValueSchema = z.union([z.number(), z.array(z.number()).min(1).max(4)]);

export const AeCueKeysSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  path: z.array(z.string().min(1)).min(1).describe("Property path by match names or names, e.g. ['ADBE Transform Group', 'ADBE Scale']."),
  times: z.array(z.number().min(0)).min(1).max(MAX_LIST).describe("Cue times in comp seconds: ae_audio_analyze's beats or onsets, or marker times."),
  peak: ValueSchema.describe("The value at each cue, e.g. [115, 115] for Scale. It must fit the property: a number for a one-value property, 2 numbers (or 3 for a 3D one) for a pair, 4 for a colour."),
  base: ValueSchema.optional().describe("The value between cues. Default: the property's own value where the cues start."),
  attack: z.number().min(0).max(5).optional().describe("Seconds from base to peak before each cue. Default 0: a jump one frame before the cue."),
  decay: z.number().min(0).max(10).optional().describe("Seconds from peak back to base. Default 0.15; 0 settles back one frame after the cue."),
  ease: z.enum(["smooth", "linear"]).optional().describe("Default smooth (easy ease on every key)."),
  clear_existing: z.boolean().optional().describe("Remove the property's keys between the first and last planned key first. Default false."),
  dry_run: z.boolean().optional().describe("Return the planned keys without touching AE."),
  expect: ExpectSchema,
});

// ---------- cue key plan ----------

export interface PlannedKey {
  time: number;
  /** null: the base value, filled in by AE when no base was given. */
  value: number | number[] | null;
  kind: "pre" | "peak" | "post";
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/**
 * Keys for a pulse on each cue: base before it (attack seconds, or one
 * frame), the peak on it, base again after `decay`. Keys that would collide
 * with the next cue's are left out, so close cues chain peak to peak.
 */
export function planCueKeys(
  times: number[],
  opts: { attack: number; decay: number; frame: number; peak: number | number[]; base?: number | number[] }
): PlannedKey[] {
  const gap = opts.frame / 2;
  const sorted = [...times].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] >= gap);
  const base = opts.base ?? null;
  const keys: PlannedKey[] = [];
  let last = -Infinity;
  sorted.forEach((t, i) => {
    const pre = t - Math.max(opts.attack, opts.frame);
    if (pre >= 0 && pre > last + gap) keys.push({ time: round4(pre), value: base, kind: "pre" });
    // The first cue is closer to 0 than its attack: start from base at 0, or AE holds the peak back to 0.
    else if (pre < 0 && last === -Infinity && t >= gap) keys.push({ time: 0, value: base, kind: "pre" });
    keys.push({ time: round4(t), value: opts.peak, kind: "peak" });
    last = t;
    const next = sorted[i + 1];
    // decay 0 still settles, one frame after the cue (as attack 0 jumps one frame before).
    const post = t + Math.max(opts.decay, opts.frame);
    const nextPre = next === undefined ? Infinity : next - Math.max(opts.attack, opts.frame);
    if (post < nextPre - gap) {
      keys.push({ time: round4(post), value: base, kind: "post" });
      last = post;
    }
  });
  return keys;
}

interface KeysSnapshot {
  numKeys: number;
  keys: Array<{ index: number; time: number; value: unknown }>;
  truncated: boolean;
}

export function cueKeysMismatches(planned: PlannedKey[], afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as KeysSnapshot | null;
  if (!after) return m;
  // A truncated read-back still checks the keys it holds (read in time order) and says what it could not.
  let checkedUpTo = Infinity;
  if (after.truncated) {
    checkedUpTo = after.keys.length ? after.keys[after.keys.length - 1].time : -Infinity;
    const unchecked = planned.filter((k) => k.time > checkedUpTo + 0.0015).length;
    m.push({
      path: "keys",
      expected: `${planned.length} planned keys read back`,
      actual: `read-back stopped at ${after.keys.length} keys`,
      message: `Read-back truncated at ${after.keys.length} keys; ${unchecked} planned key(s) after ${checkedUpTo}s were not verified`,
    });
  }
  for (const k of planned) {
    if (k.time > checkedUpTo + 0.0015) continue;
    const got = after.keys.find((x) => Math.abs(x.time - k.time) <= 0.0015);
    if (!got) {
      m.push({ path: `keys@${k.time}`, expected: k.value ?? written.base, actual: undefined, message: `No key at ${k.time}s` });
      continue;
    }
    const want = k.value ?? written.base;
    // 2D layers keep three-dimensional values; compare only the dimensions given.
    const actual = Array.isArray(want) && Array.isArray(got.value) ? (got.value as unknown[]).slice(0, want.length) : got.value;
    compareValues(want, actual, `keys@${k.time}`, m);
  }
  return m;
}

// ---------- audio jobs ----------

export interface CompAudioInfo {
  comp_id: number;
  name: string;
  name_unique: boolean;
  duration: number;
  fps: number;
  frame_duration: number;
  display_start_time: number;
  audio_layers: Array<{ index: number; name: string }>;
  project_path: string;
  dirty: boolean | null;
}

interface AudioJobMeta {
  comp_id: number;
  comp_name: string;
  /** Comp time of the render's first sample. */
  offset: number;
  fps: number;
  output_path: string;
}

export interface AudioToolsOptions {
  /** Starts the render; default: the ae_aerender_start tool. */
  startRender?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ job_id?: string; ok?: boolean }>;
  /** Reads a render job; default: the aerender job registry. */
  getJob?: (jobId: string) => Pick<AerenderJobRecord, "state" | "output_path" | "error" | "log_path"> | undefined;
  rendersDir?: () => string;
  pollMs?: number;
}

export function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "comp";
}

export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

/** aerender may add or change the extension; find the file it wrote. */
export function findRenderedAudio(outputPath: string): string | null {
  if (fs.existsSync(outputPath)) return outputPath;
  const dir = path.dirname(outputPath);
  const stem = path.basename(outputPath, path.extname(outputPath));
  try {
    const hit = fs.readdirSync(dir).find((n) => n.startsWith(stem) && /\.(aif|aiff|aifc|wav)$/i.test(n));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

async function analyzeFile(file: string, offset: number, opts: AnalyzeOptions, maxSeconds = MAX_ANALYSIS_SECONDS) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_AUDIO_BYTES) throw new AudioDecodeError(`Audio file is over ${MAX_AUDIO_BYTES / 1048576} MB`);
  // The header's length is checked before any sample is decoded.
  const decoded = decodeAudio(await fs.promises.readFile(file), { maxSeconds });
  const analysis = offsetAnalysis(await analyzeAudio(decoded.mono, decoded.sampleRate, opts), offset);
  const boundList = <T,>(list: T[]) => ({ list: list.slice(0, MAX_LIST), truncated: list.length > MAX_LIST });
  const beats = boundList(analysis.beats);
  const onsets = boundList(analysis.onsets);
  return {
    source: { path: file, format: decoded.format, sample_rate: decoded.sampleRate, channels: decoded.channels, duration: analysis.duration },
    time_offset: offset,
    overall: analysis.overall,
    tempo: analysis.tempo,
    beats: beats.list,
    beats_truncated: beats.truncated,
    onsets: onsets.list,
    onsets_truncated: onsets.truncated,
    hits: analysis.hits,
    ...(analysis.levels ? { levels: { ...analysis.levels, start: offset } } : {}),
  };
}

export function createAudioTools(options: AudioToolsOptions = {}): ToolDefinition<any>[] {
  const startRender =
    options.startRender ??
    (async (args: Record<string, unknown>, ctx: ToolContext) => {
      const tool = aerenderTools.find((t) => t.name === "ae_aerender_start")!;
      return (await tool.handler(args, ctx)) as { job_id?: string; ok?: boolean };
    });
  const getJob = options.getJob ?? ((id: string) => getDefaultAerenderRegistry().get(id));
  const rendersDir = options.rendersDir ?? (() => getDefaultAerenderRegistry().rendersDir);
  const pollMs = options.pollMs ?? 250;
  const jobs = new Map<string, AudioJobMeta>();

  const metaFor = (jobId: string): AudioJobMeta | undefined => {
    const known = jobs.get(jobId);
    if (known) return known;
    // After a restart: the sidecar written next to the render.
    const job = getJob(jobId);
    if (!job) return undefined;
    try {
      return JSON.parse(fs.readFileSync(`${job.output_path}.json`, "utf8")) as AudioJobMeta;
    } catch {
      return undefined;
    }
  };

  async function collect(jobId: string, waitSeconds: number, opts: AnalyzeOptions) {
    const meta = metaFor(jobId);
    if (!meta) return { ok: false, error: "unknown_job", message: `No audio render with job_id ${jobId}` };
    const deadline = Date.now() + waitSeconds * 1000;
    let job = getJob(jobId);
    while (job?.state === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      job = getJob(jobId);
    }
    if (!job) return { ok: false, error: "unknown_job", message: `The render job ${jobId} is gone` };
    if (job.state === "running") {
      return { ok: true, state: "rendering", job_id: jobId, message: "Still rendering. Call ae_audio_analyze again with this job_id." };
    }
    if (job.state === "failed") {
      return {
        ok: false,
        error: "render_failed",
        job_id: jobId,
        message:
          `aerender failed: ${job.error ?? "see the log"}. If the log says the output-module template is missing, ` +
          `pass output_module_template with an audio-only template that exists in this AE (ae_render_templates lists them).`,
        log_path: job.log_path,
      };
    }
    const file = findRenderedAudio(meta.output_path);
    if (!file) return { ok: false, error: "no_output", job_id: jobId, message: `aerender finished but wrote no audio file at ${meta.output_path}` };
    try {
      return { ok: true, state: "done", job_id: jobId, comp_id: meta.comp_id, ...(await analyzeFile(file, meta.offset, { ...opts, fps: meta.fps }, MAX_ANALYSIS_SECONDS + 2 / (meta.fps || 25))) };
    } catch (err) {
      if (err instanceof AudioDecodeError) return { ok: false, error: "bad_audio", job_id: jobId, message: err.message };
      throw err;
    }
  }

  return [
    {
      name: "ae_audio_analyze",
      description:
        "Analyse a comp's sound: overall level, onsets (hits), tempo in BPM with a confidence, beat times, the strongest hits, and optionally levels per frame. All times are comp seconds. " +
        "With comp_id the comp's audio is rendered by aerender in the background (an audio-only output-module template, default 'AIFF 48kHz'), so everything AE does to the sound counts, and AE stays usable; " +
        "the project must be saved with no unsaved changes (ae_save first). If the render takes longer than wait_seconds the result is a job_id to call again with. " +
        "With audio_path a WAV or AIFF is analysed directly. Analysis is plain JS on the server; no outside tools. " +
        "Use the beats or onsets with ae_add_markers (markers on beats) or ae_cue_keys (a pulse on each beat). " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeAudioAnalyzeSchema,
      handler: async (args: z.infer<typeof AeAudioAnalyzeSchema>, ctx: ToolContext) => {
        const opts: AnalyzeOptions = {
          levels: args.levels,
          sensitivity: args.sensitivity,
          min_bpm: args.min_bpm,
          max_bpm: args.max_bpm,
          hits: args.hits,
        };
        const wait = args.wait_seconds ?? 30;
        if (args.audio_path !== undefined) {
          if (!path.isAbsolute(args.audio_path) || !fs.existsSync(args.audio_path)) {
            return { ok: false, error: "bad_path", message: `Not an existing absolute path: ${args.audio_path}` };
          }
          try {
            return { ok: true, state: "done", ...(await analyzeFile(args.audio_path, args.time_offset ?? 0, { ...opts, fps: args.fps })) };
          } catch (err) {
            if (err instanceof AudioDecodeError) return { ok: false, error: "bad_audio", message: err.message };
            throw err;
          }
        }
        if (args.job_id !== undefined) return collect(args.job_id, wait, opts);

        const info = (
          await ctx.bridge.callHost<CompAudioInfo>("audioCompInfo", { comp_id: args.comp_id }, {
            label: "ae_audio_analyze (comp)",
            mutates: false,
            toolName: "ae_audio_analyze",
          })
        ).result;
        if (!info.name_unique) {
          return { ok: false, error: "ambiguous_comp", message: `Several comps are named "${info.name}"; aerender picks comps by name. Rename one first.` };
        }
        if (!info.audio_layers.length) {
          return { ok: false, error: "no_audio", message: `"${info.name}" has no layer with audio switched on.` };
        }
        const start = args.start ?? 0;
        const end = Math.min(args.end ?? info.duration, info.duration);
        if (end <= start) return { ok: false, error: "bad_range", message: `Nothing to render between ${start}s and ${end}s (comp is ${info.duration}s).` };
        // aerender counts frames as AE displays them, from the comp's start frame.
        const firstFrame = Math.round((info.display_start_time ?? 0) * info.fps);
        const startFrame = firstFrame + Math.round(start * info.fps);
        const endFrame = firstFrame + Math.max(Math.round(start * info.fps), Math.ceil(end * info.fps) - 1);
        // The render covers whole frames, which can run a little past end - start: check what is rendered.
        const renderedSeconds = (endFrame - startFrame + 1) / info.fps;
        if (renderedSeconds > MAX_ANALYSIS_SECONDS + 1e-6) {
          return {
            ok: false,
            error: "too_long",
            message: `${Math.round(renderedSeconds)} s of audio; analyse at most ${MAX_ANALYSIS_SECONDS / 60} minutes at a time (use start/end)`,
          };
        }
        const dir = path.join(rendersDir(), "audio");
        fs.mkdirSync(dir, { recursive: true });
        const outputPath = path.join(dir, `${sanitize(info.name)}_${stamp()}.aif`);
        const started = await startRender(
          {
            expect: args.expect,
            comp_name: info.name,
            output_path: outputPath,
            output_module_template: args.output_module_template ?? DEFAULT_AUDIO_TEMPLATE,
            start_frame: startFrame,
            end_frame: endFrame,
          },
          ctx
        );
        if (!started?.job_id) return { ok: false, error: "render_not_started", detail: started };
        // The render begins on a frame boundary: that is the comp time of its first sample.
        const renderStart = Math.round(start * info.fps) / info.fps;
        const meta: AudioJobMeta = { comp_id: info.comp_id, comp_name: info.name, offset: renderStart, fps: info.fps, output_path: outputPath };
        jobs.set(started.job_id, meta);
        try {
          fs.writeFileSync(`${outputPath}.json`, JSON.stringify(meta));
        } catch {
          // The in-memory record still serves this session.
        }
        return collect(started.job_id, wait, opts);
      },
    },
    {
      name: "ae_cue_keys",
      description:
        "Keyframe a property on cue times (beats or onsets from ae_audio_analyze, or marker times): for each cue the value jumps (or rises over `attack`) from base to `peak` and settles back over `decay`, " +
        "in one undo group guarded by `expect`. Close cues chain peak to peak instead of colliding. Base defaults to the property's own value where the cues start. " +
        "dry_run returns the planned keys without touching AE. The read-back (a separate evalScript) checks every planned key's time and value. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeCueKeysSchema,
      handler: async (args: z.infer<typeof AeCueKeysSchema>, ctx: ToolContext) => {
        const info = (
          await ctx.bridge.callHost<CompAudioInfo>("audioCompInfo", { comp_id: args.comp_id }, {
            label: "ae_cue_keys (comp)",
            mutates: false,
            toolName: "ae_cue_keys",
          })
        ).result;
        // The host unwraps a 1-element array on a one-value property; plan and send the plain number so the receipt compares like with like.
        const one = <T>(v: T): T => (Array.isArray(v) && v.length === 1 && typeof v[0] === "number" ? (v[0] as unknown as T) : v);
        const peakValue = one(args.peak);
        const baseValue = args.base === undefined ? undefined : one(args.base);
        const planned = planCueKeys(args.times, {
          attack: args.attack ?? 0,
          decay: args.decay ?? 0.15,
          frame: info.frame_duration || 1 / (info.fps || 25),
          peak: peakValue,
          base: baseValue,
        });
        if (args.dry_run) return { ok: true, dry_run: true, count: planned.length, keys: planned };
        const range: [number, number] = [planned[0].time, planned[planned.length - 1].time];
        const snapshot = () => ({ host: "keysSnapshot", args: { comp_id: args.comp_id, layer: args.layer, path: args.path, start: range[0], end: range[1], max: MAX_SNAPSHOT_KEYS } });
        return runGuardedWrite(ctx, {
          toolName: "ae_cue_keys",
          label: `ae_cue_keys(${args.times.length} cues)`,
          expect: args.expect,
          compId: args.comp_id,
          read: snapshot,
          write: {
            host: "cueKeys",
            args: {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              keys: planned.map((k) => ({ time: k.time, value: k.value })),
              base: baseValue,
              ease: args.ease ?? "smooth",
              clear_range: args.clear_existing ? range : undefined,
              label: "Keys on cues",
            },
          },
          check: (_before, after, w) => cueKeysMismatches(planned, after, w),
          present: (_before, after, w) => ({
            keys_set: w.set,
            cleared: w.cleared,
            base: w.base,
            layer: w.layer,
            property: w.property,
            numKeys: (after as KeysSnapshot | null)?.numKeys,
            ...(w.ease_warning ? { ease_warning: w.ease_warning } : {}),
            ...((after as KeysSnapshot | null)?.truncated ? { readback_truncated: true } : {}),
          }),
        });
      },
    },
  ];
}

export const audioTools: ToolDefinition<any>[] = createAudioTools();
