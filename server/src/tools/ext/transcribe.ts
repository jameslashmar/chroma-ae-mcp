/**
 * server/src/tools/ext/transcribe.ts
 *
 * ae_transcribe: speech to word-level JSON with ElevenLabs Scribe.
 *
 * Render (comp source, aerender in the background exactly as ae_audio_analyze
 * does) then upload run as one background job held in memory, so a long
 * upload never holds the AE eval queue. A call waits up to wait_s for it and
 * otherwise returns the job_id to call again with. Not a project mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { captionsFolderFor } from "../../caption-standards.js";
import {
  createElevenLabsEngine,
  MAX_UPLOAD_BYTES,
  redactKey,
  SOURCE_EXTENSIONS,
  TranscribeError,
  type TranscribeEngine,
  type TranscriptSummary,
} from "../../transcribe.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../common.js";
import { aerenderTools, getDefaultAerenderRegistry, type AerenderJobRecord } from "./aerender.js";
import { DEFAULT_AUDIO_TEMPLATE, findRenderedAudio, sanitize, stamp, type CompAudioInfo } from "./audio.js";

const MAX_RENDER_SECONDS = 2 * 60 * 60;
const MAX_JOBS = 50;

export const AeTranscribeSchema = z
  .object({
    confirm_upload: z
      .literal(true)
      .describe("Must be true. It records that the user agreed to send this audio to ElevenLabs."),
    comp_id: z.number().int().optional().describe("Transcribe this comp's audio. When its only audible layer is one untouched footage file, that file is uploaded directly (source 'footage_file'; see footage_shortcut); otherwise aerender renders the audio in the background (project saved, no unsaved changes)."),
    footage_shortcut: z.boolean().optional().describe("With comp_id: upload the layer's footage file instead of rendering when the comp's sound is exactly that one file (audio on, no time remap or stretch, no effects, Audio Levels unkeyed at 0 dB, a format ElevenLabs takes). Default true; false always renders."),
    path: z.string().min(1).optional().describe(`Absolute path of an audio or video file (${SOURCE_EXTENSIONS.join(" ")}), at most 1 GB.`),
    job_id: z.string().min(1).optional().describe("Continue a call that is still rendering or uploading."),
    output_module_template: z.string().min(1).optional().describe(`With comp_id: an audio-only output-module template. Default '${DEFAULT_AUDIO_TEMPLATE}'.`),
    engine: z.enum(["elevenlabs"]).optional().describe("Default elevenlabs (Scribe). The only engine so far."),
    model: z.string().min(1).optional().describe("Default scribe_v1."),
    language: z.string().min(2).max(8).optional().describe("ISO 639-1 or 639-3 code. Omit to auto-detect."),
    diarize: z.boolean().optional().describe("Label who speaks. Default true."),
    num_speakers: z.number().int().min(1).max(32).optional().describe("Number of speakers if known."),
    tag_audio_events: z.boolean().optional().describe("Mark laughter, applause and similar as audio events. Default true."),
    out_path: z.string().min(1).optional().describe("Absolute .json path for the raw response. Default: the project's 'chroma captions' folder, '<comp or file name>.elevenlabs.json'. An existing file is never overwritten: ' 2', ' 3' is added."),
    wait_s: z.number().min(0).max(120).optional().describe("Seconds this call waits for the render and upload before returning the job_id. Default 20."),
  })
  .refine((v) => [v.comp_id, v.path, v.job_id].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of comp_id, path or job_id.",
  })
  .refine((v) => v.out_path === undefined || (path.isAbsolute(v.out_path) && /\.json$/i.test(v.out_path)), {
    message: "out_path must be an absolute path ending in .json.",
  })
  .refine((v) => v.job_id === undefined || v.output_module_template === undefined, { message: "output_module_template goes with comp_id." });

type Args = z.infer<typeof AeTranscribeSchema>;

export interface TranscribeToolsOptions {
  /** Engines by id; default: ElevenLabs. */
  engines?: Record<string, TranscribeEngine>;
  /** Starts the render; default: the ae_aerender_start tool. */
  startRender?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ job_id?: string; ok?: boolean; message?: string }>;
  getJob?: (jobId: string) => Pick<AerenderJobRecord, "state" | "output_path" | "error" | "log_path"> | undefined;
  rendersDir?: () => string;
  pollMs?: number;
  maxBytes?: number;
}

type JobState = "rendering" | "uploading" | "done" | "failed";

interface Job {
  id: string;
  state: JobState;
  engine: string;
  model: string;
  offset: number;
  stem: string;
  /** Directory for the default output name. */
  defaultDir: string;
  /** Where the audio came from: "footage_file" (the comp's one footage layer), "render" (aerender) or "file" (path). */
  source?: string;
  /** More fields for the finished result (the layer a footage file came from, why the shortcut was skipped). */
  extra?: Record<string, unknown>;
  /** The audible range of the file, in file time, when the layer trims it. */
  window?: { from_s: number; to_s: number };
  outPath?: string;
  result?: Record<string, unknown>;
  done: Promise<void>;
}

const fail = (error: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, error, message, ...extra });

function fileStem(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").trim().slice(0, 100) || "transcript";
}

/** Writes with flag "wx"; a taken name gets " 2", " 3" before its suffix. */
export function writeUnique(wanted: string, data: string): string {
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  const m = /^(.*?)(\.elevenlabs\.json|\.[^.\\/]*)?$/.exec(wanted)!;
  const base = m[1];
  const suffix = m[2] ?? "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? wanted : `${base} ${n}${suffix}`;
    try {
      fs.writeFileSync(candidate, data, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Every name from ${wanted} to " 999" is taken`);
}

/** What captionsAudioSource (host, read only) says about a comp's sound. */
interface AudioSource {
  comp_id: number;
  name: string;
  eligible: boolean;
  reasons: string[];
  audible_layers: number;
  layer?: { id: number; index: number; name: string; in_point: number; out_point: number; start_time: number; stretch: number };
  file?: { path: string; name: string };
  footage_duration?: number;
}

/**
 * The comp's only sound is one footage file as it is: returns the job to upload that file with, offset = the layer's
 * start time (file times plus it are comp times; a layer whose in or out point trims the file also gets the audible
 * window in file time). Otherwise says why not. The detection is a read-only evalScript.
 */
async function footageShortcut(
  ctx: ToolContext,
  args: Args,
  info: CompAudioInfo,
  base: { engine: string; model: string },
  maxBytes: number
): Promise<{ job?: { init: Omit<Job, "id" | "state" | "done">; file: string }; reasons: string[] }> {
  let s: AudioSource;
  try {
    s = (await ctx.bridge.callHost<AudioSource>("captionsAudioSource", { comp_id: args.comp_id }, { label: "ae_transcribe (comp audio source)", mutates: false, toolName: "ae_transcribe" })).result;
  } catch (err) {
    return { reasons: [`could not check the comp's audio source: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!s.eligible || !s.file || !s.layer) return { reasons: s.reasons?.length ? s.reasons : ["the comp's sound is not one footage file"] };
  const file = s.file.path;
  const ext = path.extname(file).toLowerCase();
  if (!SOURCE_EXTENSIONS.includes(ext)) return { reasons: [`${ext || "(no extension)"} is not a format ElevenLabs takes (${SOURCE_EXTENSIONS.join(" ")})`] };
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return { reasons: [`the footage file is not readable from here: ${file}`] };
  }
  if (size > maxBytes) return { reasons: [`the footage file is ${Math.round(size / 1048576)} MB; the upload limit is ${Math.round(maxBytes / 1048576)} MB`] };
  const l = s.layer;
  const from = Math.max(0, l.in_point - l.start_time);
  const to = l.out_point - l.start_time;
  const dur = s.footage_duration;
  const trimmed = from > 0.001 || (dur !== undefined && to < dur - 0.001);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  let defaultDir: string;
  try {
    defaultDir = args.out_path ? path.dirname(args.out_path) : captionsFolderFor(info.project_path);
  } catch {
    defaultDir = path.dirname(file);
  }
  return {
    reasons: [],
    job: {
      file,
      init: {
        ...base,
        // Word times in the file plus the layer's start time are comp times.
        offset: r3(l.start_time),
        stem: fileStem(info.name),
        defaultDir,
        outPath: args.out_path,
        source: "footage_file",
        extra: { source_file: file, layer: { name: l.name, start_time: r3(l.start_time), in_point: r3(l.in_point), out_point: r3(l.out_point) } },
        ...(trimmed ? { window: { from_s: r3(from), to_s: r3(to) } } : {}),
      },
    },
  };
}

export function createTranscribeTools(options: TranscribeToolsOptions = {}): ToolDefinition<any>[] {
  const engines = options.engines ?? { elevenlabs: createElevenLabsEngine() };
  const startRender =
    options.startRender ??
    (async (args: Record<string, unknown>, ctx: ToolContext) => {
      const tool = aerenderTools.find((t) => t.name === "ae_aerender_start")!;
      return (await tool.handler(args, ctx)) as { job_id?: string; ok?: boolean; message?: string };
    });
  const getJob = options.getJob ?? ((id: string) => getDefaultAerenderRegistry().get(id));
  const rendersDir = options.rendersDir ?? (() => getDefaultAerenderRegistry().rendersDir);
  const pollMs = options.pollMs ?? 250;
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const jobs = new Map<string, Job>();
  let seq = 0;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function newJob(init: Omit<Job, "id" | "state" | "done">, run: (job: Job) => Promise<Record<string, unknown>>, id?: string): Job {
    const job = { ...init, id: id ?? `tr_${stamp()}_${++seq}`, state: "rendering" as JobState, done: Promise.resolve() } as Job;
    job.done = (async () => {
      try {
        job.result = await run(job);
        job.state = job.result.ok === true ? "done" : "failed";
      } catch (err) {
        job.state = "failed";
        job.result =
          err instanceof TranscribeError
            ? fail(err.code, err.message, err.status !== undefined ? { http_status: err.status } : {})
            : fail("upload_failed", redactKey(err instanceof Error ? err.message : String(err)));
      }
    })();
    jobs.set(job.id, job);
    // Keep the map small: forget the oldest finished jobs.
    if (jobs.size > MAX_JOBS) {
      for (const [k, j] of jobs) {
        if (jobs.size <= MAX_JOBS) break;
        if (j.state === "done" || j.state === "failed") jobs.delete(k);
      }
    }
    return job;
  }

  async function upload(job: Job, file: string, args: Args): Promise<Record<string, unknown>> {
    const size = fs.statSync(file).size;
    if (size > maxBytes) return fail("too_large", `${file} is ${Math.round(size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB`);
    job.state = "uploading";
    const engine = engines[job.engine];
    const res = await engine.transcribe(file, {
      model: job.model,
      language: args.language,
      diarize: args.diarize ?? true,
      num_speakers: args.num_speakers,
      tag_audio_events: args.tag_audio_events ?? true,
    });
    const wanted = job.outPath ?? path.join(job.defaultDir, `${job.stem}.elevenlabs.json`);
    // The response is stored as returned.
    const written = writeUnique(wanted, JSON.stringify(res.raw, null, 2));
    const s: TranscriptSummary = res.summary;
    return {
      ok: true,
      state: "done",
      job_id: job.id,
      engine: job.engine,
      model: job.model,
      transcript_path: written,
      offset: job.offset,
      language_code: s.language_code,
      language_probability: s.language_probability,
      duration_s: s.duration_s,
      words: s.words,
      speakers: s.speakers,
      audio_events: s.audio_events,
      preview: s.preview,
      source: job.source ?? "file",
      ...(job.extra ?? {}),
      ...(job.window ? { audible_in_file: job.window } : {}),
      next: `ae_captions_plan with transcript: { path: ${JSON.stringify(written)}, offset: ${job.offset}${job.window ? `, from_s: ${job.window.from_s}, to_s: ${job.window.to_s}` : ""} }`,
    };
  }

  async function respond(job: Job, waitS: number) {
    if (job.state !== "done" && job.state !== "failed") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, waitS * 1000)))]);
      if (timer) clearTimeout(timer);
    }
    if (job.state === "done" || job.state === "failed") return { ...job.result!, ...(job.state === "failed" ? { job_id: job.id } : {}) };
    return {
      ok: true,
      state: job.state,
      job_id: job.id,
      message: `${job.state === "rendering" ? "Rendering the comp's audio" : "Uploading to ElevenLabs"}. Call ae_transcribe again with this job_id (confirm_upload: true).`,
    };
  }

  async function projectFolderFor(ctx: ToolContext): Promise<string | undefined> {
    try {
      const st = (await ctx.bridge.callHost<{ project_path?: string }>("status", {}, { label: "ae_transcribe (project)", mutates: false, toolName: "ae_transcribe" })).result;
      return st?.project_path ? captionsFolderFor(st.project_path) : undefined;
    } catch {
      return undefined;
    }
  }

  return [
    {
      name: "ae_transcribe",
      description:
        "Transcribe speech to word-level JSON with ElevenLabs Scribe. This UPLOADS the audio (client material) to ElevenLabs, a third-party US service: ask the user before calling it, and pass confirm_upload: true only after they agree. " +
        "Source, exactly one of: comp_id (when the comp's only audible layer is one footage file with no time remap, stretch, effects or Audio Levels change, that file is uploaded as it is and the result says source 'footage_file', offset = the layer's start time, and audible_in_file when the layer trims it; otherwise the audio is rendered by aerender in the background like ae_audio_analyze: project saved with no unsaved changes, audio-only template default 'AIFF 48kHz', and footage_shortcut_skipped says why the file was not used), " +
        "path (an absolute audio or video file, at most 1 GB), or job_id (continue a call that was still working). " +
        "Needs ELEVENLABS_API_KEY in the environment (Windows User variable or macOS ~/.zprofile); the key is never shown. " +
        "Render and upload run in the background; if they outlast wait_s (default 20) the result is state 'rendering' or 'uploading' with a job_id to call again with. " +
        "When done the raw response is written to transcript_path (never overwriting) and the result gives offset (the comp time of the audio's first sample, 0 for a file), language, duration, word and speaker counts and a preview. " +
        "Pass transcript: { path: transcript_path, offset } to ae_captions_plan or ae_captions. Speech is transcribed as heard: check names and numbers before shipping captions. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeTranscribeSchema,
      handler: async (args: Args, ctx: ToolContext) => {
        const wait = args.wait_s ?? 20;
        if (args.job_id !== undefined) {
          const job = jobs.get(args.job_id);
          if (!job) return fail("unknown_job", `No transcription job ${args.job_id} (jobs live in memory until the server restarts)`);
          return respond(job, wait);
        }
        const engineId = args.engine ?? "elevenlabs";
        if (!engines[engineId]) return fail("bad_path", `Unknown engine ${engineId}`);
        const model = args.model ?? "scribe_v1";
        const base = { engine: engineId, model };

        if (args.path !== undefined) {
          const file = args.path;
          const ext = path.extname(file).toLowerCase();
          let size: number;
          try {
            if (!path.isAbsolute(file)) throw new Error("not absolute");
            const st = fs.statSync(file);
            if (!st.isFile()) throw new Error("not a file");
            size = st.size;
          } catch {
            return fail("bad_path", `Not an existing absolute file path: ${file}`);
          }
          if (!SOURCE_EXTENSIONS.includes(ext)) return fail("bad_path", `${ext || "(no extension)"} is not supported. Use one of: ${SOURCE_EXTENSIONS.join(" ")}`);
          if (size > maxBytes) return fail("too_large", `${file} is ${Math.round(size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB`);
          const folder = args.out_path ? undefined : await projectFolderFor(ctx);
          const job = newJob(
            { ...base, offset: 0, stem: fileStem(path.basename(file, path.extname(file))), defaultDir: folder ?? path.dirname(file), outPath: args.out_path, source: "file" },
            (j) => upload(j, file, args)
          );
          return respond(job, wait);
        }

        // Comp source: the same checks and render as ae_audio_analyze.
        const info = (
          await ctx.bridge.callHost<CompAudioInfo>("audioCompInfo", { comp_id: args.comp_id }, { label: "ae_transcribe (comp)", mutates: false, toolName: "ae_transcribe" })
        ).result;
        if (!info.audio_layers.length) return fail("no_audio", `"${info.name}" has no layer with audio switched on.`);
        let skipped: string[] | undefined;
        if (args.footage_shortcut !== false) {
          const shortcut = await footageShortcut(ctx, args, info, base, maxBytes);
          if (shortcut.job) {
            const sj = shortcut.job;
            const j = newJob(sj.init, (jj) => upload(jj, sj.file, args));
            return respond(j, wait);
          }
          skipped = shortcut.reasons;
        }
        if (!info.name_unique) return fail("ambiguous_comp", `Several comps are named "${info.name}"; aerender picks comps by name. Rename one first.`);
        if (!info.audio_layers.length) return fail("no_audio", `"${info.name}" has no layer with audio switched on.`);
        if (info.duration > MAX_RENDER_SECONDS) return fail("too_long", `${Math.round(info.duration)} s of audio; at most ${MAX_RENDER_SECONDS / 3600} hours`);
        let defaultDir: string;
        try {
          defaultDir = args.out_path ? path.dirname(args.out_path) : captionsFolderFor(info.project_path);
        } catch (err) {
          return fail("render_failed", (err as Error).message);
        }
        const firstFrame = Math.round((info.display_start_time ?? 0) * info.fps);
        const endFrame = firstFrame + Math.max(0, Math.ceil(info.duration * info.fps) - 1);
        const dir = path.join(rendersDir(), "audio");
        fs.mkdirSync(dir, { recursive: true });
        const outputPath = path.join(dir, `${sanitize(info.name)}_${stamp()}.aif`);
        const started = await startRender(
          {
            expect: { project_path: info.project_path },
            comp_name: info.name,
            output_module_template: args.output_module_template ?? DEFAULT_AUDIO_TEMPLATE,
            output_path: outputPath,
            start_frame: firstFrame,
            end_frame: endFrame,
          },
          ctx
        );
        if (!started?.job_id) return fail("render_failed", `The render did not start: ${started?.message ?? JSON.stringify(started ?? {}).slice(0, 400)}`);
        const renderId = started.job_id;
        const job = newJob(
          { ...base, offset: 0, stem: fileStem(info.name), defaultDir, outPath: args.out_path, source: "render", ...(skipped?.length ? { extra: { footage_shortcut_skipped: skipped } } : {}) },
          async (j) => {
            let r = getJob(renderId);
            const limit = Date.now() + 2 * 60 * 60 * 1000;
            while (r?.state === "running" && Date.now() < limit) {
              await sleep(pollMs);
              r = getJob(renderId);
            }
            if (!r) return fail("render_failed", `The render job ${renderId} is gone`);
            if (r.state !== "succeeded") {
              return fail("render_failed", `aerender failed: ${r.error ?? "see the log"}. If the log says the output-module template is missing, pass output_module_template with an audio-only template that exists in this AE (ae_render_templates lists them).`, { log_path: r.log_path });
            }
            const file = findRenderedAudio(outputPath);
            if (!file) return fail("render_failed", `aerender finished but wrote no audio file at ${outputPath}`);
            return upload(j, file, args);
          }
        );
        return respond(job, wait);
      },
    },
  ];
}

export const transcribeTools: ToolDefinition<any>[] = createTranscribeTools();
