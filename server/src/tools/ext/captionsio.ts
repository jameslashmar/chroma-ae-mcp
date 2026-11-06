/**
 * server/src/tools/ext/captionsio.ts
 *
 * Caption files in and out:
 * - ae_captions_export: write a sidecar file (SRT, WebVTT, TTML/IMSC) from a
 *   transcript plan or from the caption layers already in a comp
 * - ae_captions_qa: lint captions (a file, text, a plan or the layers) against
 *   a caption standard: reading speed, line length, timing, gaps, grammar,
 *   shot changes, safe area
 *
 * Both write nothing to the project: export writes a file, QA writes nothing.
 * Whatever they ask After Effects for (the project path, the caption layers)
 * is read-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  countTtmlCues,
  parseSubtitles,
  writeCaptions,
  formatTime,
  type CaptionFormat,
  type CuePosition,
  type ExportCue,
} from "../../caption-formats.js";
import { inferFrameRate, lintCaptions, type QaCue } from "../../caption-qa.js";
import { CAPTION_STANDARDS, CAPTION_STANDARD_IDS, captionsFolderFor } from "../../caption-standards.js";
import { TranscriptError } from "../../transcript.js";
import type { ToolContext, ToolDefinition } from "../common.js";
import { AeCaptionsPlanSchema, CAPTION_DEFAULT_MARGINS, CaptionTranscriptSchema, MAX_CAPTIONS, planCaptions, type CaptionsRead } from "./captions.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW = 5;

// ---------- schemas ----------

const FromLayersSchema = z
  .object({
    comp_id: z.number().int(),
    mode: z.enum(["layers", "single"]).optional().describe("Which kind of caption layers to read (default layers)."),
    name_prefix: z.string().min(1).max(100).optional().describe("Layer name prefix, default 'Caption'."),
    from_number: z.number().int().min(1).optional().describe("Layers mode: only captions numbered from this one (to page past 500 captions)."),
    to_number: z.number().int().min(1).optional().describe("Layers mode: only captions numbered up to this one."),
  })
  .describe("Read the caption layers already in a comp (up to 500; `truncated` says more exist). Read-only.");

const PositionSchema = z
  .object({
    line_pct: z.number().min(0).max(100).optional().describe("Top of the text as a percent of the frame height (VTT line, TTML region origin y). Default: the bottom, as players place captions."),
    align: z.enum(["start", "center", "end"]).optional().describe("Text alignment. Default center."),
    region_width_pct: z.number().min(10).max(100).optional().describe("Width of the text box as a percent of the frame width. Default 80 in TTML; VTT leaves it to the player."),
  })
  .describe("Cue placement for VTT and TTML (SRT has none). With from_layers each caption's own line and alignment are read from its layer; fields given here override them.");

const planShape = AeCaptionsPlanSchema.shape;

const ExportBase = {
  ...planShape,
  transcript: CaptionTranscriptSchema.optional().describe("Plan the captions from this transcript exactly as ae_captions_plan would (every other planner field applies). Give this or from_layers."),
  from_layers: FromLayersSchema.optional(),
  format: z.enum(["srt", "vtt", "ttml"]).describe("srt, vtt (WebVTT) or ttml (TTML, IMSC 1.1 text profile)."),
  path: z.string().min(1).optional().describe("Absolute path; the extension must match the format (.srt, .vtt, .ttml or .xml). Default: '<project folder>/<project name> chroma captions/<comp name or captions>.<ext>', numbered ' 2', ' 3' if taken."),
  overwrite: z.boolean().optional().describe("Replace a file that exists. Default false: an explicit path that exists is refused, and a default name that is taken gets a number."),
  position: PositionSchema.optional(),
  speaker_voice: z.boolean().optional().describe("VTT: wrap a caption's text in <v Name> when it has a speaker. Default true."),
};

export const AeCaptionsExportSchema = z
  .object(ExportBase)
  .refine((v) => (v.transcript === undefined) !== (v.from_layers === undefined), { message: "Give either transcript or from_layers, not both." });

const QaBase = {
  ...planShape,
  transcript: CaptionTranscriptSchema.optional().describe("Lint the captions a plan from this transcript would make (every planner field applies)."),
  file: z.object({ path: z.string().min(1).describe("Absolute path of a .srt or .vtt file (5 MB at most).") }).optional(),
  text: z.string().max(MAX_FILE_BYTES).optional().describe("SRT or WebVTT text to lint."),
  format: z.enum(["srt", "vtt"]).optional().describe("Format of `text`. Default: from the content (a WEBVTT header means vtt)."),
  from_layers: FromLayersSchema.optional(),
  standard: z.enum(CAPTION_STANDARD_IDS).optional().describe("Standard to judge by: netflix_adult (default), netflix_kids, bbc, dcmp, social_9x16."),
  frame_rate: z.number().positive().max(240).optional().describe("Frames per second for the frame-based rules (gaps). Default for files, text and plans: inferred from the cue times (the lowest of 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 they all sit on; reported as frame_rate_inferred), else 24 with a half-frame gap tolerance (with a warning); the comp's own rate for layers. With a transcript it also rounds the plan's times."),
  cut_times: z.array(z.number().min(0)).max(5000).optional().describe("Shot changes in seconds (ae_detect_cuts gives them). Captions that straddle a cut or sit too close to one are flagged."),
  max_issues: z.number().int().min(1).max(500).optional().describe("Issues listed at most (default 200). `counts` always covers all of them."),
};

export const AeCaptionsQaSchema = z
  .object(QaBase)
  .refine((v) => [v.file, v.text, v.transcript, v.from_layers].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of file, text, transcript or from_layers.",
  });

type ExportArgs = z.infer<typeof AeCaptionsExportSchema>;
type QaArgs = z.infer<typeof AeCaptionsQaSchema>;
type FromLayers = z.infer<typeof FromLayersSchema>;

// ---------- reading caption layers ----------

interface LayerCue extends ExportCue {
  n: number;
  outside_safe?: boolean;
  first_outside_safe?: number;
}

interface LayersResult {
  cues: LayerCue[];
  truncated: boolean;
  frame_rate: number;
  comp_id: number;
  warnings: string[];
}

const ALIGN: Record<string, CuePosition["align"]> = { left: "start", center: "center", right: "end" };
const lineSplit = (s: string) => s.split(/\r\n?|\n/);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Turns what captionsRead found into cues. Exported for the tests. */
export function cuesFromRead(read: CaptionsRead): { cues: LayerCue[]; warnings: string[] } {
  const warnings: string[] = [];
  const cues: LayerCue[] = [];
  let estimated = false;
  const positionOf = (c: CaptionsRead["captions"][number]): CuePosition | undefined => {
    const p: CuePosition = {};
    if (c.rect && read.height > 0) {
      // sourceRectAtTime is in layer space; adding the layer's position puts the top in comp space
      // for the usual unrotated, unscaled caption layer.
      const y = (c.position?.[1] ?? 0) + c.rect.top;
      p.line_pct = Math.min(100, Math.max(0, r2((y / read.height) * 100)));
      estimated = true;
    }
    const a = c.justification ? ALIGN[c.justification] : undefined;
    if (a) p.align = a;
    return p.line_pct !== undefined || p.align ? p : undefined;
  };
  for (const c of read.captions) {
    const pos = positionOf(c);
    const flags = {
      ...(c.outside_safe ? { outside_safe: true } : {}),
      ...(c.first_outside_safe !== undefined ? { first_outside_safe: c.first_outside_safe } : {}),
    };
    if (read.mode === "single") {
      const keys = c.keys ?? [];
      if (c.truncated_keys) warnings.push(`Layer "${c.name}" has more Source Text keys than were read; the captions after the last one read are missing.`);
      keys.forEach((k, i) => {
        if (!k.text || !k.text.trim()) return;
        const end = keys[i + 1] ? keys[i + 1].time : c.outPoint;
        cues.push({
          n: cues.length + 1,
          start: k.time,
          end,
          lines: lineSplit(k.text),
          ...(pos ? { position: pos } : {}),
          ...(k.outside_safe ? { outside_safe: true } : {}),
        });
      });
      continue;
    }
    if (c.text === undefined) {
      warnings.push(`Caption ${c.number} ("${c.name}") has no readable text and was skipped.`);
      continue;
    }
    cues.push({ n: c.number, start: c.inPoint, end: c.outPoint, lines: lineSplit(c.text), ...(pos ? { position: pos } : {}), ...flags });
  }
  if (estimated) warnings.push("Vertical positions are estimated from each layer's text extents and position; check them if the layers are rotated, scaled or parented.");
  return { cues, warnings };
}

async function readLayers(ctx: ToolContext, a: FromLayers, toolName: string): Promise<LayersResult> {
  const res = await ctx.bridge.callHost<CaptionsRead>(
    "captionsRead",
    {
      comp_id: a.comp_id,
      mode: a.mode ?? "layers",
      name_prefix: a.name_prefix ?? "Caption",
      layout: undefined,
      // The margins ae_captions places by (a 9:16 comp gets the reels box), so QA judges what was written.
      default_margins: CAPTION_DEFAULT_MARGINS,
      from_number: a.from_number,
      to_number: a.to_number,
    },
    { label: `${toolName}(${a.comp_id}) read caption layers`, mutates: false, toolName }
  );
  const read = res.result;
  const { cues, warnings } = cuesFromRead(read);
  const truncated = Boolean(read.truncated) || (read.beyond_count ?? 0) > 0;
  if (truncated) {
    warnings.push(
      `The comp has ${read.total_captions} captions; only up to ${MAX_CAPTIONS} were read${read.beyond_count ? ` (${read.beyond_count} numbered above to_number)` : ""}. Page on with from_number and to_number.`
    );
  }
  if (!cues.length) warnings.push("No caption layers with that name prefix were found in the comp.");
  const fd = read.frameDuration;
  return { cues, truncated, frame_rate: fd > 0 ? Math.round((1 / fd) * 1000) / 1000 : 24, comp_id: read.comp_id ?? a.comp_id, warnings };
}

// ---------- helpers ----------

const badTranscript = (err: unknown) => {
  if (err instanceof TranscriptError) return { ok: false, error: "bad_transcript", message: err.message };
  throw err;
};

const EXTENSIONS: Record<CaptionFormat, string[]> = { srt: [".srt"], vtt: [".vtt"], ttml: [".ttml", ".xml"] };

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 80) || "captions";

function withPosition(cues: LayerCue[] | ExportCue[], override: CuePosition | undefined): ExportCue[] {
  return cues.map((c) => {
    const merged = { ...(c.position ?? {}), ...(override ?? {}) };
    const { n: _n, outside_safe: _o, first_outside_safe: _f, ...rest } = c as LayerCue;
    return { ...rest, ...(Object.keys(merged).length ? { position: merged } : {}) };
  });
}

const previewOf = (cues: ExportCue[]) =>
  cues
    .slice(0, MAX_PREVIEW)
    .map((c, i) => `${i + 1}. ${formatTime(c.start, ".")} --> ${formatTime(c.end, ".")}  ${c.lines.join(" / ")}`)
    .join("\n");

/** The first free `<dir>/<stem>.<ext>`, `<stem> 2.<ext>`, ... written with `wx` so a racing writer is not overwritten. */
function writeNew(dir: string, stem: string, ext: string, data: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const target = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`);
    try {
      fs.writeFileSync(target, data, { encoding: "utf8", flag: "wx" });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free name for ${stem}${ext} in ${dir}`);
}

async function statusOf(ctx: ToolContext, toolName: string): Promise<{ project_path?: string; active_comp?: { id: number; name: string } | null }> {
  const res = await ctx.bridge.callHost<{ project_path?: string; active_comp?: { id: number; name: string } | null }>("status", {}, { label: `${toolName} (project path)`, mutates: false, toolName });
  return res.result ?? {};
}

// ---------- tools ----------

export const captionsioTools: ToolDefinition<any>[] = [
  {
    name: "ae_captions_export",
    description:
      "Write a caption sidecar file: SRT (UTF-8, CRLF, <i> for italics), WebVTT (cue settings line/position/align, <v Name> speakers, italics) or TTML (IMSC 1.1 text profile: regions in percent, <br/>, italic spans). " +
      "The captions come from a transcript, planned exactly as ae_captions_plan does (every planner field applies), or from the caption layers already in a comp (from_layers, read-only; positions and alignment are taken from the layers). " +
      "Default path is next to the project in '<project> chroma captions/'; a taken name gets ' 2', ' 3'. An explicit path that exists is refused unless overwrite is true. " +
      "After writing it reads the file back and compares the cue count; a mismatch sets ok false with a warning. Writes a file only: nothing in the After Effects project changes. " +
      "SRT carries no placement or speakers; <i> in SRT is widely supported but not standard.",
    schema: AeCaptionsExportSchema,
    handler: async (args: ExportArgs, ctx) => {
      const warnings: string[] = [];
      let cues: ExportCue[];
      let source: "transcript" | "layers";
      let truncated = false;
      let compName: string | undefined;

      // 1. validate everything before touching disk or After Effects
      if (args.path !== undefined) {
        const ext = path.extname(args.path).toLowerCase();
        if (!path.isAbsolute(args.path) || !EXTENSIONS[args.format].includes(ext)) {
          return { ok: false, error: "bad_path", message: `Give an absolute path ending ${EXTENSIONS[args.format].join(" or ")} for ${args.format}: ${args.path}` };
        }
        if (fs.existsSync(args.path) && !args.overwrite) {
          return { ok: false, error: "exists", message: `${args.path} exists; pass overwrite to replace it, or leave path out to get a numbered name.` };
        }
      }

      // 2. the cues
      if (args.transcript !== undefined) {
        source = "transcript";
        try {
          const plan = planCaptions(args as Parameters<typeof planCaptions>[0]);
          warnings.push(...plan.warnings);
          cues = plan.captions.map((c) => {
            const x = c as typeof c & { kind?: string; italic?: boolean };
            return { start: c.start, end: c.end, lines: c.lines, ...(c.speaker !== undefined ? { speaker: c.speaker } : {}), ...(x.italic ? { italic: true } : {}) };
          });
        } catch (err) {
          return badTranscript(err);
        }
        cues = withPosition(cues, args.position);
      } else {
        source = "layers";
        const got = await readLayers(ctx, args.from_layers!, "ae_captions_export");
        truncated = got.truncated;
        warnings.push(...got.warnings);
        cues = withPosition(got.cues, args.position);
      }
      if (!cues.length) return { ok: false, error: "no_captions", message: "There are no captions to write.", warnings };
      if (cues.some((c) => !(c.end > c.start))) warnings.push("Some captions end at or before their start; they were written 1 ms long.");

      // 3. the file
      const written = writeCaptions(args.format, cues, { speaker_voice: args.speaker_voice });
      warnings.push(...written.warnings);
      const ext = EXTENSIONS[args.format][0];
      let target: string;
      if (args.path !== undefined) {
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        try {
          fs.writeFileSync(args.path, written.text, { encoding: "utf8", flag: args.overwrite ? "w" : "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, error: "exists", message: `${args.path} exists; pass overwrite to replace it.` };
          throw err;
        }
        target = args.path;
      } else {
        let project: Awaited<ReturnType<typeof statusOf>>;
        try {
          project = await statusOf(ctx, "ae_captions_export");
        } catch (err) {
          return { ok: false, error: "no_path", message: `No path given and After Effects could not say where the project is (${err instanceof Error ? err.message : String(err)}). Give an absolute path.` };
        }
        let dir: string;
        try {
          dir = captionsFolderFor(project.project_path ?? "");
        } catch (err) {
          return { ok: false, error: "unsaved_project", message: err instanceof Error ? err.message : String(err) };
        }
        if (project.active_comp && args.from_layers && project.active_comp.id === args.from_layers.comp_id) compName = project.active_comp.name;
        target = writeNew(dir, fileSafe(compName ?? "captions"), ext, written.text);
      }

      // 4. verify what is on disk
      let bytes = 0;
      try {
        bytes = fs.statSync(target).size;
      } catch {
        bytes = 0;
      }
      let ok = true;
      if (bytes <= 0) {
        ok = false;
        warnings.push("The file is empty on disk.");
      } else {
        const text = fs.readFileSync(target, "utf8");
        const back = args.format === "ttml" ? countTtmlCues(text) : parseSubtitles(text, args.format).cues.length;
        if (back !== cues.length) {
          ok = false;
          warnings.push(`Wrote ${cues.length} cues but reading the file back found ${back}.`);
        }
      }
      return {
        ok,
        path: target,
        format: args.format,
        cues: cues.length,
        bytes,
        source,
        ...(truncated ? { truncated: true } : {}),
        warnings,
        preview: previewOf(cues),
      };
    },
  },
  {
    name: "ae_captions_qa",
    description:
      "Lint captions against a standard (netflix_adult default, netflix_kids, bbc, dcmp, social_9x16). The captions can be a .srt or .vtt file, SRT or VTT text, a transcript plan, or the caption layers in a comp. " +
      "Checks: reading speed (characters or words a second/minute), line length (markup not counted), line count, time on screen, gaps under the minimum frames (error) or short of a tidy gap (warning), overlaps, " +
      "breaks on a weak word (article, preposition, conjunction, auxiliary, a split name; warning), captions that straddle or sit near a cut_times shot change (warning), text outside the safe area (layers only), empty captions and end-before-start timing. " +
      "Returns pass (no errors), counts per rule and the issues with caption number, times and detail. It judges the text and times as written: it cannot see line breaks a player adds, or whether the words are right. Read-only.",
    schema: AeCaptionsQaSchema,
    handler: async (args: QaArgs, ctx) => {
      const warnings: string[] = [];
      let qaCues: QaCue[];
      let fps = args.frame_rate;
      let source: string;
      if (args.file !== undefined) {
        source = "file";
        const p = args.file.path;
        const ext = path.extname(p).toLowerCase();
        if (!path.isAbsolute(p) || (ext !== ".srt" && ext !== ".vtt")) return { ok: false, error: "bad_path", message: `Give an absolute .srt or .vtt path: ${p}` };
        let size: number;
        try {
          size = fs.statSync(p).size;
        } catch {
          return { ok: false, error: "not_found", message: `No file at ${p}` };
        }
        if (size > MAX_FILE_BYTES) return { ok: false, error: "too_big", message: `${p} is over 5 MB.` };
        const parsed = parseSubtitles(fs.readFileSync(p, "utf8"), ext === ".vtt" ? "vtt" : "srt");
        warnings.push(...parsed.warnings);
        qaCues = parsed.cues.map((c) => ({ n: c.n, start: c.start, end: c.end, lines: c.lines }));
      } else if (args.text !== undefined) {
        source = "text";
        const parsed = parseSubtitles(args.text, args.format);
        warnings.push(...parsed.warnings);
        qaCues = parsed.cues.map((c) => ({ n: c.n, start: c.start, end: c.end, lines: c.lines }));
      } else if (args.transcript !== undefined) {
        source = "transcript";
        try {
          const plan = planCaptions(args as Parameters<typeof planCaptions>[0]);
          warnings.push(...plan.warnings);
          qaCues = plan.captions.map((c, i) => ({ n: i + 1, start: c.start, end: c.end, lines: c.lines }));
        } catch (err) {
          return badTranscript(err);
        }
      } else {
        source = "layers";
        const got = await readLayers(ctx, args.from_layers!, "ae_captions_qa");
        warnings.push(...got.warnings);
        if (fps === undefined) fps = got.frame_rate;
        qaCues = got.cues.map((c) => ({
          n: c.n,
          start: c.start,
          end: c.end,
          lines: c.lines,
          ...(c.outside_safe ? { outside_safe: true } : {}),
          ...(c.first_outside_safe !== undefined ? { first_outside_safe: c.first_outside_safe } : {}),
        }));
      }
      let inferred: boolean | undefined;
      let gapTol: number | undefined;
      if (fps === undefined) {
        // A file's rate is not in it: the rate that puts every cue time on a frame boundary is the likely one.
        const guess = inferFrameRate(qaCues.flatMap((c) => [c.start, c.end]));
        if (guess !== null) {
          fps = guess;
          inferred = true;
          warnings.push(`No frame_rate given; inferred ${guess} fps from the cue times (the lowest common rate they all sit on). Pass frame_rate if the file was timed at another rate.`);
        } else {
          fps = 24;
          inferred = false;
          gapTol = 0.5;
          warnings.push("No frame_rate given and the cue times fit none of 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60 fps, so the frame-based rules (gaps) assume 24 fps with a half-frame tolerance. Pass frame_rate to judge gaps exactly.");
        }
      }
      const standardId = args.standard ?? "netflix_adult";
      if (args.standard === undefined) warnings.push(`No standard given; judged by ${CAPTION_STANDARDS[standardId].label}.`);
      const report = lintCaptions(qaCues, { standard: standardId, frame_rate: fps, cut_times: args.cut_times, max_issues: args.max_issues, ...(gapTol !== undefined ? { gap_tolerance_frames: gapTol } : {}) });
      if (!qaCues.length) warnings.push("There are no captions to check.");
      return { ok: true, source, ...report, ...(inferred !== undefined ? { frame_rate_inferred: inferred } : {}), warnings };
    },
  },
];
