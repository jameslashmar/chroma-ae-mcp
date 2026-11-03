/**
 * server/src/tools/ext/captions.ts
 *
 * Captions from a transcript (SRT, WebVTT, ElevenLabs or Whisper JSON):
 * - ae_captions_plan: the captions the options would make (line breaks, frame
 *   timing, warnings), without touching After Effects
 * - ae_captions: a guarded write that creates or updates the captions by
 *   name, one text layer per caption or one hold-keyed layer, with an
 *   optional per-word highlight and background box, placed in the safe area
 * - ae_captions_read: the caption layers as they are, with text extents
 *   against the safe area and the boxes' expression errors
 *
 * Grouping, line breaking and timing are pure Node (transcript.ts); After
 * Effects only gets finished captions. Node can't measure glyphs, so the
 * read-back measures the text with sourceRectAtTime in a separate evalScript
 * and reports captions that run outside the safe area.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  buildCaptions,
  detectFormat,
  parseTranscript,
  TranscriptError,
  type Caption,
  type CaptionPlan,
  type TranscriptSegment,
} from "../../transcript.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { DEFAULT_MARGINS } from "./reframe.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_CAPTIONS = 500;

// ---------- schemas ----------

const Color = z.array(z.number().min(0).max(1)).length(3);

export const CaptionTranscriptSchema = z
  .object({
    path: z.string().min(1).optional().describe("Absolute path of a .srt, .vtt or .json transcript."),
    text: z.string().max(MAX_TRANSCRIPT_BYTES).optional().describe("The transcript itself, instead of a path."),
    format: z.enum(["srt", "vtt", "json"]).optional().describe("Default: from the file extension or the content."),
    offset: z.number().finite().optional().describe("Seconds added to every transcript time (the captions must not start before 0)."),
    from_s: z.number().min(0).optional().describe("Only the transcript segments that start at or after this many seconds (before offset). For a long transcript in several calls."),
    to_s: z.number().min(0).optional().describe("Only the transcript segments that start before this many seconds (before offset)."),
  })
  .refine((t) => (t.path === undefined) !== (t.text === undefined), { message: "Give the transcript's path or its text, not both." });

const BreakFields = {
  max_chars_per_line: z.number().int().min(8).max(80).optional().describe("Characters per line, default 32 (about 20 suits 9:16). Counted, not measured: a proportional font can run wider, which ae_captions_read reports."),
  max_lines: z.number().int().min(1).max(4).optional().describe("Lines per caption, default 2. A caption is split when its words would need more."),
  min_duration: z.number().min(0.1).max(5).optional().describe("Seconds a caption stays up at least (up to the next caption), default 1."),
  max_duration: z.number().min(1).max(15).optional().describe("A caption is split when it would run longer than this, default 6."),
  linger: z.number().min(0).max(2).optional().describe("Seconds a caption stays after its last word (up to the next caption), default 0.25."),
  pause_break: z.number().min(0.1).max(5).optional().describe("A pause between words longer than this starts a new caption, default 0.7."),
};

const MarginsSchema = z
  .object({
    top: z.number().min(0).max(0.45).optional(),
    bottom: z.number().min(0).max(0.45).optional(),
    left: z.number().min(0).max(0.45).optional(),
    right: z.number().min(0).max(0.45).optional(),
  })
  .describe("Safe-area margins as fractions of the frame. Default: ae_reframe's for the comp's aspect (9:16 keeps the bottom 20% free for the platform's own UI).");

const StyleSchema = z
  .object({
    font: z.string().min(1).max(200).optional().describe("PostScript font name, as ae_fonts lists it. A name AE doesn't have is substituted silently; the read-back says so."),
    font_size: z.number().min(1).max(1296).optional().describe("Pixels. Default 6% of the comp's short side."),
    fill_color: Color.optional().describe("[r, g, b] in 0..1. Default white."),
    stroke_color: Color.optional().describe("Turns the stroke on."),
    stroke_width: z.number().min(0).max(200).optional().describe("Default font size / 12 when a stroke colour is given."),
    justification: z.enum(["left", "center", "right"]).optional().describe("Default center."),
    text_box: z
      .object({
        width: z.number().positive().max(30000).optional().describe("Default the safe-area width."),
        height: z.number().positive().max(30000).optional().describe("Default font size x 1.2 x the caption's lines."),
      })
      .optional()
      .describe("Make paragraph (box) text of this size instead of point text. The box is placed in the safe area from its top-left corner."),
  })
  .describe("Text style for new caption layers (and existing ones with restyle).");

const LayoutSchema = z
  .object({
    position: z.enum(["bottom", "middle", "top"]).optional().describe("Where in the safe area the captions sit. Default bottom (above the bottom margin)."),
    margins: MarginsSchema.optional(),
  })
  .describe("Where the captions go.");

const HighlightSchema = z
  .object({ color: Color.describe("Fill colour of the word being spoken, [r, g, b] in 0..1.") })
  .describe(
    "Highlight the spoken word: a text animator 'Caption Highlight' with a Fill Color and a range selector (Index units, Based On Words) whose Start/End are hold-keyed per word. " +
      "With SRT or VTT the word times are estimated from character share; JSON with word times is exact."
  );

const BoxSchema = z
  .object({
    color: Color.optional().describe("Default black."),
    opacity: z.number().min(0).max(100).optional().describe("Percent, default 60."),
    padding: z.number().min(0).max(1000).optional().describe("Pixels round the text, default 24."),
    roundness: z.number().min(0).max(1000).optional().describe("Corner radius in pixels, default 0."),
  })
  .describe("A background shape layer under each caption (or under the one layer) whose rectangle follows the text's extents through a sourceRectAtTime expression.");

const NameFields = {
  mode: z
    .enum(["layers", "single"])
    .optional()
    .describe(
      "'layers' (default): one text layer per caption, named '<name_prefix> 001', in and out at the caption's times. " +
        "'single': one layer '<name_prefix>' whose Source Text is hold-keyed per caption (text shifts to the tallest caption's height)."
    ),
  name_prefix: z.string().min(1).max(100).optional().describe("Layer name prefix, default 'Caption'. Re-running with the same prefix updates those layers instead of adding new ones."),
  first_number: z.number().int().min(1).max(100000).optional().describe("Number of the first caption (layers mode), default 1. Use it to caption a long transcript in several calls with from_s/to_s."),
};

export const AeCaptionsPlanSchema = z.object({
  transcript: CaptionTranscriptSchema,
  ...BreakFields,
  frame_rate: z.number().positive().max(240).optional().describe("Round the times to whole frames of this rate (ae_captions rounds to the comp's own)."),
});

export const AeCaptionsSchema = z
  .object({
    comp_id: z.number().int(),
    transcript: CaptionTranscriptSchema,
    ...NameFields,
    ...BreakFields,
    style: StyleSchema.optional(),
    layout: LayoutSchema.optional(),
    highlight: HighlightSchema.optional(),
    box: BoxSchema.optional(),
    remove_stale: z
      .boolean()
      .optional()
      .describe("Remove caption layers with this prefix whose number is past the new captions (an edited transcript with fewer lines); numbers below first_number are never removed. Default true when first_number is 1, else false."),
    restyle: z
      .boolean()
      .optional()
      .describe("Apply style and layout to captions that already exist too. Default false: existing layers keep their style, position and any effects, and only text and timing change."),
    expect: ExpectSchema,
  })
  .refine((v) => v.mode !== "single" || v.first_number === undefined || v.first_number === 1, { message: "first_number applies to layers mode only." });

export const AeCaptionsReadSchema = z
  .object({
  comp_id: z.number().int(),
  mode: z.enum(["layers", "single"]).optional().describe("Which kind of captions to look for (default layers)."),
  name_prefix: z.string().min(1).max(100).optional().describe("Default 'Caption'."),
  layout: LayoutSchema.optional().describe("The margins to judge the safe area by; the same as given to ae_captions."),
  from_number: z.number().int().min(1).optional().describe("Layers mode: list only captions numbered from this one (to page past 500 captions)."),
  to_number: z.number().int().min(1).optional().describe("Layers mode: list only captions numbered up to this one. beyond_count says how many are numbered above it."),
  })
  .refine((v) => v.from_number === undefined || v.to_number === undefined || v.to_number >= v.from_number, { message: "to_number must not be below from_number." });

type CaptionsArgs = z.infer<typeof AeCaptionsSchema>;
type PlanArgs = z.infer<typeof AeCaptionsPlanSchema>;
type ReadArgs = z.infer<typeof AeCaptionsReadSchema>;

// ---------- planning ----------

/** Reads the transcript argument into segments. Throws TranscriptError with a readable message. */
export function segmentsFromTranscript(t: z.infer<typeof CaptionTranscriptSchema>): TranscriptSegment[] {
  let text = t.text;
  if (t.path !== undefined) {
    if (!path.isAbsolute(t.path)) throw new TranscriptError(`Transcript path must be absolute: ${t.path}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(t.path);
    } catch {
      throw new TranscriptError(`No transcript at ${t.path}`);
    }
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new TranscriptError(`Transcript is over 5 MB: ${t.path}`);
    text = fs.readFileSync(t.path, "utf8").replace(/^﻿/, "");
  }
  const segs = parseTranscript(text ?? "", t.format ?? detectFormat(text ?? "", t.path));
  const from = t.from_s ?? 0;
  const to = t.to_s ?? Infinity;
  const kept = segs.filter((s) => s.start >= from && s.start < to);
  if (!kept.length) throw new TranscriptError(`No transcript segment starts between ${from} s and ${to} s`);
  return kept;
}

/** The captions for a tool call's transcript and options; throws TranscriptError. */
export function planCaptions(args: Pick<PlanArgs, "transcript" | "max_chars_per_line" | "max_lines" | "min_duration" | "max_duration" | "linger" | "pause_break"> & { frame_rate?: number }): CaptionPlan {
  const plan = buildCaptions(segmentsFromTranscript(args.transcript), {
    max_chars_per_line: args.max_chars_per_line,
    max_lines: args.max_lines,
    min_duration: args.min_duration,
    max_duration: args.max_duration,
    linger: args.linger,
    pause_break: args.pause_break,
    offset: args.transcript.offset,
    frame_rate: args.frame_rate,
  });
  const early = plan.captions.findIndex((c) => !(c.start >= 0));
  if (early >= 0) throw new TranscriptError(`Caption ${early + 1} would start before 0 s (at ${plan.captions[early].start} s); use a smaller negative offset or trim the transcript`);
  if (plan.captions.length > MAX_CAPTIONS) {
    throw new TranscriptError(
      `${plan.captions.length} captions; at most ${MAX_CAPTIONS} per call. Caption the transcript in parts with from_s/to_s and first_number.`
    );
  }
  return plan;
}

const previewOf = (c: Caption, n: number) => ({
  n,
  start: c.start,
  end: c.end,
  text: c.lines.join("\n"),
  words: c.words.length,
  ...(c.speaker !== undefined ? { speaker: c.speaker } : {}),
});

// ---------- read-back shape ----------

export interface ReadCaption {
  number: number;
  name: string;
  id: number;
  index: number;
  kind: string;
  inPoint: number;
  outPoint: number;
  startTime?: number;
  numKeys?: number;
  text?: string;
  font?: string;
  fontSize?: number;
  justification?: string;
  font_substituted?: boolean;
  highlight?: { present: boolean; start_keys?: number; end_keys?: number; units?: number; based_on?: number };
  keys?: Array<{ time: number; text: string; width?: number; outside_safe?: boolean }>;
  truncated_keys?: boolean;
  first_outside_safe?: number;
  rect?: { left: number; top: number; width: number; height: number };
  position?: number[];
  outside_safe?: boolean;
  rect_error?: string;
}

export interface CaptionsRead {
  comp_id: number;
  width: number;
  height: number;
  frameDuration: number;
  safe: { left: number; right: number; top: number; bottom: number; width: number };
  mode: "layers" | "single";
  captions: ReadCaption[];
  boxes: Array<{ number: number; name: string; id: number; inPoint: number; outPoint: number; expression_errors: string[] }>;
  total_captions: number;
  total_boxes: number;
  truncated: boolean;
  /** With a number range: captions numbered above to_number. */
  beyond_count?: number;
}

const readOf = (v: unknown): CaptionsRead | null => (v && typeof v === "object" ? (v as CaptionsRead) : null);

/** AE stores line breaks as \r. */
const norm = (s: string) => s.replace(/\r\n?|\n/g, "\n");

/** The Source Text keys a single layer should end up with: each caption, and an empty key where a gap follows. */
export function expectedSingleKeys(captions: Caption[], timings: Array<[number, number]>): Array<{ time: number; text: string }> {
  const keys: Array<{ time: number; text: string }> = [];
  captions.forEach((c, i) => {
    const [start, end] = timings[i] ?? [c.start, c.end];
    keys.push({ time: start, text: c.lines.join("\r") });
    const next = timings[i + 1];
    if (!next || next[0] > end + 1e-6) keys.push({ time: end, text: "" });
  });
  return keys;
}

// ---------- checks ----------

interface Written extends Record<string, unknown> {
  timings?: Array<[number, number]>;
  created?: string[];
  highlight_keys?: number;
  count?: number;
}

export function captionsMismatches(
  args: Pick<CaptionsArgs, "mode" | "first_number" | "highlight" | "box" | "style">,
  removeStale: boolean,
  captions: Caption[],
  afterRaw: unknown,
  written: Written
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = readOf(afterRaw);
  if (!after) return m;
  const mode = args.mode ?? "layers";
  const first = args.first_number ?? 1;
  const timings = written.timings ?? [];
  const tol = after.frameDuration * 1.01 + 1e-6;
  const made = new Set(written.created ?? []);
  const wantJust = args.style?.justification ?? "center";
  // A capped read can't judge layers it did not list.
  const capped = after.truncated || after.total_captions > after.captions.length;

  if (mode === "layers") {
    captions.forEach((c, i) => {
      const entry = after.captions.find((e) => e.number === first + i);
      if (!entry) {
        if (!capped) m.push({ path: `captions[${first + i}]`, expected: c.lines.join("\n"), actual: undefined, message: "The caption layer is not in the read-back" });
        return;
      }
      const want = c.lines.join("\n");
      expectThat(m, entry.text !== undefined && norm(entry.text) === want, `captions[${entry.number}].text`, want, entry.text === undefined ? undefined : norm(entry.text), "Caption text differs");
      const t = timings[i];
      if (t) {
        expectThat(m, Math.abs(entry.inPoint - t[0]) <= tol, `captions[${entry.number}].inPoint`, t[0], entry.inPoint, "Caption starts at another time");
        expectThat(m, Math.abs(entry.outPoint - t[1]) <= tol, `captions[${entry.number}].outPoint`, t[1], entry.outPoint, "Caption ends at another time");
      }
      if (made.has(entry.name) && entry.justification !== undefined) {
        expectThat(m, entry.justification === wantJust, `captions[${entry.number}].justification`, wantJust, entry.justification, "Justification did not stick");
      }
    });
    if (removeStale && !capped) {
      const last = first + captions.length - 1;
      // Only numbers past the new captions are stale; earlier chunks (numbers below first) stay.
      const left = after.captions.filter((e) => e.number > last).map((e) => e.name);
      if (after.beyond_count !== undefined) {
        expectThat(m, left.length === 0 && after.beyond_count === 0, "stale", [], left.length ? left : `${after.beyond_count} caption layer(s)`, "Caption layers past the new captions are still there");
      } else {
        expectThat(m, left.length === 0, "stale", [], left, "Caption layers past the new captions are still there");
      }
    }
    if (args.highlight && !capped) {
      // Only the layers this call keyed: older chunks keep their own highlights.
      const keyed = after.captions.filter((e) => e.number >= first && e.number < first + captions.length).reduce((n, e) => n + (e.highlight?.start_keys ?? 0), 0);
      expectThat(m, written.highlight_keys === undefined || keyed === written.highlight_keys, "highlight.keys", written.highlight_keys, keyed, "The highlight's word keys differ from what was written");
      const bare = after.captions.filter((e) => e.number >= first && e.number < first + captions.length && !e.highlight?.present).map((e) => e.name);
      expectThat(m, bare.length === 0, "highlight.present", [], bare, "Caption layers without the highlight animator");
    }
    if (!args.highlight && !capped) {
      // A re-run without a highlight takes the old Caption Highlight animator off.
      const kept = after.captions.filter((e) => e.number >= first && e.number < first + captions.length && e.highlight?.present).map((e) => e.name);
      expectThat(m, kept.length === 0, "highlight.stale", [], kept, "Caption layers still carry a Caption Highlight animator from an earlier run");
    }
    if (args.box && !capped) {
      const have = new Set(after.boxes.map((b) => b.number));
      const missing = captions.map((_c, i) => first + i).filter((n) => !have.has(n));
      expectThat(m, missing.length === 0 || after.truncated, "boxes", [], missing, "Caption boxes missing");
    }
  } else {
    const entry = after.captions[0];
    if (!entry) {
      m.push({ path: "caption", expected: "one hold-keyed layer", actual: undefined, message: "The caption layer is not in the read-back" });
      return m;
    }
    const want = expectedSingleKeys(captions, timings.length === captions.length ? timings : captions.map((c) => [c.start, c.end] as [number, number]));
    if (!entry.truncated_keys) {
      expectThat(m, entry.numKeys === want.length, "caption.numKeys", want.length, entry.numKeys, "Source Text key count differs");
      const got = entry.keys ?? [];
      for (let i = 0; i < Math.min(want.length, got.length); i++) {
        const okText = norm(got[i].text) === norm(want[i].text);
        const okTime = Math.abs(got[i].time - want[i].time) <= tol;
        if (!okText || !okTime) {
          m.push({ path: `caption.keys[${i}]`, expected: want[i], actual: got[i], message: "A Source Text key differs" });
          break;
        }
      }
    }
    if (entry.inPoint !== undefined && timings.length) {
      expectThat(m, Math.abs(entry.inPoint - timings[0][0]) <= tol, "caption.inPoint", timings[0][0], entry.inPoint, "Layer starts at another time");
      expectThat(m, Math.abs(entry.outPoint - timings[timings.length - 1][1]) <= tol, "caption.outPoint", timings[timings.length - 1][1], entry.outPoint, "Layer ends at another time");
    }
    if (args.highlight) {
      expectThat(m, entry.highlight?.present === true, "highlight.present", true, entry.highlight?.present, "The highlight animator is missing");
      expectThat(m, written.highlight_keys === undefined || entry.highlight?.start_keys === written.highlight_keys, "highlight.keys", written.highlight_keys, entry.highlight?.start_keys, "The highlight's word keys differ from what was written");
    }
    if (args.box) expectThat(m, after.boxes.length >= 1, "boxes", 1, after.boxes.length, "The caption box is missing");
  }
  for (const b of after.boxes) {
    if (b.expression_errors.length) m.push({ path: `boxes[${b.number}].expression`, expected: "no expression error", actual: b.expression_errors, message: `The box "${b.name}" has an expression error` });
  }
  return m;
}

// ---------- tools ----------

const readArgsFor = (args: { comp_id: number; mode?: "layers" | "single"; name_prefix?: string; layout?: CaptionsArgs["layout"]; from_number?: number; to_number?: number }) => ({
  comp_id: args.comp_id,
  mode: args.mode ?? "layers",
  name_prefix: args.name_prefix ?? "Caption",
  layout: args.layout ? { margins: args.layout.margins } : undefined,
  default_margins: DEFAULT_MARGINS,
  from_number: args.from_number,
  to_number: args.to_number,
});

const badTranscript = (err: unknown) => {
  if (err instanceof TranscriptError) return { ok: false, error: "bad_transcript", message: err.message };
  throw err;
};

export const captionsTools: ToolDefinition<any>[] = [
  {
    name: "ae_captions_plan",
    description:
      "Plan captions from a transcript (SRT, WebVTT, ElevenLabs speech-to-text JSON with words, Whisper-style JSON) without touching After Effects: words are grouped into captions at speaker changes, pauses and sentence ends " +
      "within the line, line-count and duration limits, balanced across lines, held for a minimum time and rounded to whole frames (give frame_rate). " +
      "Returns every caption (times, lines, word count) and warnings: estimated word times (SRT/VTT), captions faster than 21 characters per second, words longer than a line. Changes nothing.",
    schema: AeCaptionsPlanSchema,
    handler: async (args: PlanArgs) => {
      try {
        const plan = planCaptions(args);
        return {
          count: plan.captions.length,
          estimated_word_times: plan.estimated_word_times,
          warnings: plan.warnings,
          captions: plan.captions.map((c, i) => previewOf(c, i + 1)),
        };
      } catch (err) {
        return badTranscript(err);
      }
    },
  },
  {
    name: "ae_captions",
    description:
      "Turn a transcript (SRT, WebVTT, ElevenLabs or Whisper JSON) into caption layers in a comp, in one undo group guarded by `expect`. " +
      "Node groups the words into captions, breaks lines (max_chars_per_line, max_lines), and sets frame-rounded times; the captions sit in the safe area (ae_reframe's margins: 9:16 stays above the bottom UI margin). " +
      "mode 'layers' makes one text layer per caption ('Caption 001'...), mode 'single' one layer with hold-keyed Source Text. " +
      "highlight colours the spoken word (a text animator keyed per word; SRT/VTT word times are estimates). box adds a background shape that follows the text through sourceRectAtTime. " +
      "Re-running with the same name_prefix updates the captions by name: text and timing change, your style, position and effects stay (restyle: true resets style and position), and layers past the new count are removed. " +
      "Font names are not checked: use ae_fonts. Layers are made at the top of the stack. At most 500 captions per call (use from_s/to_s and first_number to continue). " +
      "The read-back (a separate evalScript) checks text, timing, justification, highlight keys, stale layers and box expressions, and measures each caption's extents: `outside_safe` lists captions that run outside the safe area (re-run with a smaller max_chars_per_line or font_size). " +
      "Check the result with ae_frame or ae_contact_sheet. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCaptionsSchema,
    handler: async (args: CaptionsArgs, ctx) => {
      let plan: CaptionPlan;
      try {
        plan = planCaptions(args);
      } catch (err) {
        return badTranscript(err);
      }
      const mode = args.mode ?? "layers";
      const prefix = args.name_prefix ?? "Caption";
      const first = args.first_number ?? 1;
      const removeStale = args.remove_stale ?? first === 1;
      const captions = plan.captions;
      // Layers mode asks only for the numbers this call writes (and counts the ones above), so a chunk past 500 reads its own captions.
      const readArgs = readArgsFor({
        comp_id: args.comp_id,
        mode,
        name_prefix: prefix,
        layout: args.layout,
        ...(mode === "layers" ? { from_number: first, to_number: first + captions.length - 1 } : {}),
      });
      const res = await runGuardedWrite<Written>(ctx, {
        toolName: "ae_captions",
        label: `ae_captions(${captions.length} ${mode})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "captionsRead", args: readArgs }),
        write: {
          host: "captionsApply",
          args: {
            comp_id: args.comp_id,
            mode,
            name_prefix: prefix,
            first_number: first,
            captions: captions.map((c) => ({
              start: c.start,
              end: c.end,
              lines: c.lines,
              ...(args.highlight ? { words: c.words.map((w) => ({ start: w.start })) } : {}),
            })),
            style: args.style,
            layout: args.layout,
            default_margins: DEFAULT_MARGINS,
            highlight: args.highlight,
            box: args.box
              ? { color: args.box.color ?? [0, 0, 0], opacity: args.box.opacity ?? 60, padding: args.box.padding ?? 24, roundness: args.box.roundness ?? 0 }
              : undefined,
            remove_stale: removeStale,
            restyle: args.restyle === true,
            label: `Captions (${captions.length})`,
          },
        },
        check: (_before, after, w) => captionsMismatches(args, removeStale, captions, after, w),
        present: (_before, after, w) => {
          const read = readOf(after);
          const outside = (read?.captions ?? [])
            .filter((e) => e.outside_safe === true || e.first_outside_safe !== undefined)
            .map((e) => ({ name: e.name, ...(e.rect ? { width: e.rect.width } : {}), ...(e.first_outside_safe !== undefined ? { first_at: e.first_outside_safe } : {}) }));
          const substituted = (read?.captions ?? []).filter((e) => e.font_substituted).map((e) => e.name);
          const warnings = [...plan.warnings, ...(((w.warnings as string[] | undefined) ?? []))];
          if (outside.length) warnings.push(`${outside.length} caption${outside.length === 1 ? " runs" : "s run"} outside the safe area; re-run with a smaller max_chars_per_line or font_size.`);
          if (substituted.length) warnings.push("The font is substituted (not installed under that name); check ae_fonts.");
          return {
            comp_id: args.comp_id,
            mode,
            name_prefix: prefix,
            count: captions.length,
            created: w.created,
            updated: w.updated,
            removed: w.removed,
            highlight_keys: w.highlight_keys,
            boxes: w.boxes,
            font_size: w.font_size,
            safe: w.safe,
            estimated_word_times: plan.estimated_word_times,
            outside_safe: outside,
            warnings,
            preview: captions.slice(0, 10).map((c, i) => previewOf(c, first + i)),
          };
        },
      });
      // A failed read-back skips `present`; the plan's warnings and the estimate don't depend on it.
      const shown = res as unknown as Record<string, unknown>;
      if (shown.estimated_word_times === undefined) {
        const hostWarnings = Array.isArray(shown.warnings) ? (shown.warnings as string[]) : [];
        return { ...res, estimated_word_times: plan.estimated_word_times, warnings: [...plan.warnings, ...hostWarnings] };
      }
      return res;
    },
  },
  {
    name: "ae_captions_read",
    description:
      "Read the caption layers a name_prefix finds in a comp (layers mode: '<prefix> 001'...; single mode: the one hold-keyed layer): text, in and out, font, size, justification, highlight animator and its key counts, " +
      "each caption's text extents (sourceRectAtTime) against the safe area with `outside_safe`, and the background boxes' expression errors. " +
      "Up to 500 captions (total_captions and truncated say more exist). Changes nothing in After Effects.",
    schema: AeCaptionsReadSchema,
    handler: async (args: ReadArgs, ctx) => {
      const res = await ctx.bridge.callHost("captionsRead", readArgsFor(args), {
        label: `ae_captions_read(${args.comp_id})`,
        mutates: false,
        toolName: "ae_captions_read",
      });
      return res.result;
    },
  },
];

