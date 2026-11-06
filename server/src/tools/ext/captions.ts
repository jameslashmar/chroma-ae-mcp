/**
 * server/src/tools/ext/captions.ts
 *
 * Captions from a transcript (SRT, WebVTT, ElevenLabs or Whisper JSON):
 * - ae_captions_plan: the captions the options would make (line breaks, frame
 *   timing, warnings), without touching After Effects
 * - ae_captions: a guarded write that creates or updates the captions by
 *   name, as one text layer per caption, one hold-keyed layer, one text layer
 *   per word, or one instance of a template comp per caption, with an
 *   optional per-word highlight and background box, placed in the safe area
 *   of a platform (TikTok, Reels, Shorts), optionally parented to a null,
 *   precomposed, and matched to earlier layers by time; speaker colours and
 *   lyric italics from the plan; a look (pop, pill_slide, fill_sweep); or, with
 *   make_template, a new Essential Graphics comp for ae_export_mogrt
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
  parseCaptionTranscript,
  TranscriptError,
  type Caption,
  type CaptionPlan,
  type CaptionWord,
  type TranscriptSegment,
} from "../../transcript.js";
import { PlanOptionFields, pickPlanOptions, type PlanOptions, type CaptionKind, type CleanupReport, type PlanChange, type PlanViolation } from "../../caption-plan-options.js";
import { availableWidth, isTooWide, outsideReason, rebreakLines, shrinkSize, type FitArea, type FitCandidate, type RefitEntry } from "../../caption-fit.js";
import { CAPTION_STANDARDS } from "../../caption-standards.js";
import { PLATFORM_PRESET_IDS, PLATFORM_PRESETS, type PlatformPreset } from "../../motion-spec.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
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
  .describe("Safe-area margins as fractions of the frame, per edge on top of the platform. Default: the platform's, else for a 9:16 comp the reels_9_16 box (about 15% free at the top, 35% at the bottom, 11% left, 18% right), else ae_reframe's for the comp's aspect.");

const StyleSchema = z
  .object({
    font: z.string().min(1).max(200).optional().describe("PostScript font name, as ae_fonts lists it (action search finds names). AE 24+: a name AE doesn't have is refused, with near matches, before anything is written, unless allow_substitute is true; the caption text is also checked for glyphs the font lacks (AE 25.1+; warned, not refused). Before AE 24 the name cannot be checked."),
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

// The looks are our own, guided by the vargHQ/skills caption-styles ideas (MIT): a pop-in per word, a sliding pill, a colour sweep.
const LookSchema = z
  .enum(["none", "pop", "pill_slide", "fill_sweep"])
  .optional()
  .describe(
    "A word-timed look for layers and words modes (default none; refused for single and template). " +
      "pop: each word starts hidden and small and pops in at its time (Scale from look_options.scale_from, about 6% overshoot, Opacity over a third of the duration). " +
      "pill_slide: a rounded box behind the caption slides and resizes to the active word, arriving at the word's time (a shape layer '<name> Look'; point text only). " +
      "fill_sweep: the fill colour spreads across each word as it is said (a text animator 'Caption Look'); not with highlight. " +
      "Every look needs one time per word (SRT/VTT times are estimates). Re-running with look none (or another look) takes the old look off: its animators or its '<name> Look' layer. Words mode builds pop with layer keys and marks those layers in their comment."
  );

const LookOptionsSchema = z
  .object({
    duration_frames: z.number().int().min(1).max(30).optional().describe("Frames a word takes to pop in, or the pill takes to slide. Default 6 (pop) or 4 (pill_slide)."),
    scale_from: z.number().min(0).max(200).optional().describe("Percent a word starts at in pop. Default 80."),
    color: Color.optional().describe("[r, g, b] in 0..1: the sweep or pill colour. Default [1, 0.85, 0] for fill_sweep, [1, 0.8, 0] for pill_slide."),
    pill_padding: z.number().min(0).max(500).optional().describe("Pixels the pill reaches past the word. Default 12% of the font size."),
    pill_roundness: z.number().min(0).max(1000).optional().describe("Pill corner radius in pixels (AE caps it at half the pill's height). Default 1000, a full pill."),
  })
  .describe("Settings for `look`.");

const MakeTemplateSchema = z
  .object({
    name: z.string().min(1).max(100).optional().describe("Name of the new comp (and its Essential Graphics template name). Default '<name_prefix> Template'."),
    width: z.number().int().min(4).max(30000).optional().describe("Default the comp_id comp's width."),
    height: z.number().int().min(4).max(30000).optional().describe("Default the comp_id comp's height."),
    duration_s: z.number().min(0.1).max(10800).optional().describe("Default 5."),
    sample_text: z.string().min(1).max(200).optional().describe("The text the layer starts with. Default 'Caption text'."),
    lines: z.number().int().min(1).max(4).optional().describe("Lines the template holds, default 2: the text's first baseline is placed so this many lines end on the safe area's bottom, and a comp too short for them is made taller (with a warning)."),
  })
  .describe(
    "Make a caption template comp for Premiere instead of writing captions: a new comp with one text layer 'Caption' styled with style, layout, box and look (none or pop), and its Source Text ('Caption Text'), fill colour ('Caption Color', a Fill effect on the layer, which also recolours a stroke) " +
      "and, with a box, the box colour ('Box Color') and opacity ('Box Opacity') in Essential Graphics. Needs no transcript. Then ae_save and ae_export_mogrt with the new comp's id."
  );

const NameFields = {
  mode: z
    .enum(["layers", "single", "words", "template"])
    .optional()
    .describe(
      "'layers' (default): one text layer per caption, named '<name_prefix> 001', in and out at the caption's times. " +
        "'single': one layer '<name_prefix>' whose Source Text is hold-keyed per caption (text shifts to the tallest caption's height). " +
        "'words': one text layer per word, named '<name_prefix> 001.01', '001.02'..., each placed where its word falls in the caption's lines (measured in After Effects) and visible from the word's time to the caption's end, so the words build on; no highlight or box. " +
        "'template': one layer per caption that is an instance of the comp in `template`, named '<name_prefix> 001', with that comp's Essential Properties set to the caption's text."
    ),
  name_prefix: z.string().min(1).max(100).optional().describe("Layer name prefix, default 'Caption'. Re-running with the same prefix updates those layers instead of adding new ones."),
  first_number: z.number().int().min(1).max(100000).optional().describe("Number of the first caption (layers mode), default 1. Use it to caption a long transcript in several calls with from_s/to_s."),
};

export const AeCaptionsPlanSchema = z.object({
  transcript: CaptionTranscriptSchema,
  ...BreakFields,
  ...PlanOptionFields,
  frame_rate: z.number().positive().max(240).optional().describe("Round the times to whole frames of this rate (ae_captions rounds to the comp's own)."),
});

const PlatformField = z
  .enum(PLATFORM_PRESET_IDS as [PlatformPreset, ...PlatformPreset[]])
  .optional()
  .describe(
    "Safe-zone preset for the captions' box: reels_9_16 (the box safe on TikTok, Reels and Shorts together), tiktok_9_16, instagram_reels_9_16 or youtube_shorts_9_16 (one app), or any other preset ae_house_style_check knows. " +
      "The numbers are approximate (from the platforms' ad specs and third-party templates, as fractions of 1080x1920). layout.margins still win per edge. Default for a 9:16 comp: reels_9_16; other shapes keep ae_reframe's margins. " +
      "With tiktok_9_16 or reels_9_16 (and on a 9:16 comp with no platform) the read-back also flags captions reaching into the lower-right action rail (right of x 780/1080, below y 840/1920) as rail_overlap."
  );

const TemplateSchema = z
  .object({
    comp_id: z.number().int().describe("The template comp (a comp with Essential Graphics controllers)."),
    fields: z
      .record(z.enum(["line1", "line2", "line3", "text", "speaker"]))
      .describe("{ \"<Essential Property name>\": \"line1\" | \"line2\" | \"line3\" | \"text\" | \"speaker\" }: which part of the caption goes into which text Essential Property. line1..3 are the caption's lines (empty when it has fewer), text all lines, speaker the speaker's name or id."),
  })
  .describe(
    "Template mode: the comp whose Essential Properties the captions fill. Refused, before anything changes, when the comp has no property of a given name (the names it has are listed), is the target comp, or would be a circular reference. " +
      "New instances (and, with restyle, existing ones) are moved so the template's caption text sits where layers mode would put it: its last line on the bottom of the safe area (platform, layout.margins), or at layout.position top or middle, whatever the caption's line count; a template comp too short for the lines gets a warning. Its own time 0 is the caption's in point."
  );

const MatchSchema = z
  .enum(["name", "time"])
  .optional()
  .describe(
    "How existing caption layers are found. 'name' (default): by number in the name. 'time': by the greatest overlap in time with the new captions (layers, words and template modes), so a re-run after the transcript was edited keeps each layer on its caption; " +
      "matched layers are renamed to the new number and updated, missing ones are created, unmatched ones are removed only with remove_stale (otherwise they must not share a number with a new caption)."
  );

export const AeCaptionsSchema = z
  .object({
    comp_id: z.number().int().describe("The comp the captions go into (with make_template: the comp whose size and frame rate the template follows)."),
    transcript: CaptionTranscriptSchema.optional().describe("Required unless make_template is given."),
    ...NameFields,
    ...BreakFields,
    ...PlanOptionFields,
    template: TemplateSchema.optional(),
    platform: PlatformField,
    match: MatchSchema,
    parent_to_null: z
      .boolean()
      .optional()
      .describe("Parent every caption (and box) layer to a null '<name_prefix> Control' (made, or reused by name), so one layer moves or scales the lot. The layers keep their positions."),
    fit: z
      .enum(["rebreak", "shrink", "none"])
      .optional()
      .describe(
        "What to do with a caption After Effects measures wider than the safe area (layers and single mode; the planner counts characters, a wide font runs wider). " +
          "Default (left out): first break it into more lines, up to max_lines, with the planner's grammar-aware breaking at the characters per line the measured pixels per character allow; then, if it is still too wide, scale that caption's font size down (never below 70% of the base size). " +
          "'rebreak': only the re-breaking. 'shrink': only the scaling. 'none': change nothing, only warn. What changed comes back in `refit` ([{ name, action, from, to }]). " +
          "Template mode: each caption is measured in a temporary text layer of the template comp (taken out again) and re-broken before writing when wider than the template (`refit`, `template_fit`); what still does not fit comes back as `template_overflow: [{ name, width, template_width }]`. " +
          "Not for words mode, nor look pill_slide (its pill follows the original lines); look fill_sweep is only scaled."
      ),
    precompose: z
      .boolean()
      .optional()
      .describe(
        "After writing, precompose the caption (and box, and control null) layers into a comp '<name_prefix> Captions' in the same undo group; the result gives its comp id. " +
          "A re-run updates the captions inside that precomp when the '<name_prefix> Captions' layer exists in comp_id."
      ),
    style: StyleSchema.optional(),
    layout: LayoutSchema.optional(),
    highlight: HighlightSchema.optional(),
    box: BoxSchema.optional(),
    look: LookSchema,
    look_options: LookOptionsSchema.optional(),
    make_template: MakeTemplateSchema.optional(),
    remove_stale: z
      .boolean()
      .optional()
      .describe("Remove caption layers with this prefix whose number is past the new captions (an edited transcript with fewer lines); numbers below first_number are never removed. Default true when first_number is 1, else false."),
    allow_substitute: z
      .boolean()
      .optional()
      .describe("Write a style.font AE does not have anyway (AE then substitutes it silently; the read-back flags it). Default false: an unknown font is refused with candidates."),
    restyle: z
      .boolean()
      .optional()
      .describe("Apply style and layout to captions that already exist too. Default false: existing layers keep their style, position and any effects, and only text and timing change. In words mode a caption whose words changed is rebuilt with fresh word layers in the base style, so hand edits to those word layers are lost."),
    expect: ExpectSchema,
  })
  .refine((v) => v.mode !== "single" || v.first_number === undefined || v.first_number === 1, { message: "first_number applies to layers, words and template modes, not single." })
  .refine((v) => v.mode !== "template" || v.template !== undefined, { message: "mode 'template' needs template: { comp_id, fields }." })
  .refine((v) => v.template === undefined || v.mode === "template", { message: "template applies to mode 'template' only." })
  .refine((v) => !((v.mode === "words" || v.mode === "template") && v.highlight), { message: "highlight applies to layers and single mode; in words mode the words already build on, and a template sets its own look." })
  .refine((v) => !((v.mode === "words" || v.mode === "template") && v.box), { message: "box applies to layers and single mode, not words or template." })
  .refine((v) => !(v.match === "time" && v.mode === "single"), { message: "match 'time' applies to layers, words and template modes, not single." })
  .refine((v) => v.make_template !== undefined || v.transcript !== undefined, { message: "Give a transcript (or make_template to make a caption template without one)." })
  .refine((v) => v.make_template === undefined || v.transcript === undefined, { message: "make_template does not use a transcript; leave it out." })
  .refine((v) => v.make_template === undefined || (v.mode === undefined || v.mode === "layers") && !v.template && !v.highlight && !v.parent_to_null && !v.precompose && v.match === undefined && v.first_number === undefined, {
    message: "make_template makes one template comp: mode, template, highlight, parent_to_null, precompose, match and first_number do not apply.",
  })
  .refine((v) => v.make_template === undefined || v.look === undefined || v.look === "none" || v.look === "pop", { message: "A template takes look none or pop; pill_slide and fill_sweep need the word times of a real caption." })
  .refine((v) => v.look === undefined || v.look === "none" || v.make_template !== undefined || v.mode === undefined || v.mode === "layers" || v.mode === "words", { message: "look applies to layers and words modes, not single or template (a template sets its own look)." })
  .refine((v) => !(v.look === "fill_sweep" && v.highlight), { message: "look fill_sweep and highlight both colour the spoken words; use one of them." })
  .refine((v) => !(v.look === "pill_slide" && v.style?.text_box), { message: "look pill_slide measures point text; it cannot follow paragraph (text_box) text." })
  .refine((v) => v.look_options === undefined || (v.look !== undefined && v.look !== "none"), { message: "look_options need a look (pop, pill_slide or fill_sweep)." });

export const AeCaptionsReadSchema = z
  .object({
  comp_id: z.number().int(),
  mode: z.enum(["layers", "single", "words", "template"]).optional().describe("Which kind of captions to look for (default layers). words: groups '<prefix> 001.01'... by caption; template: the instances and their Essential Property values."),
  platform: PlatformField.describe("The platform whose safe area judges the captions; the same as given to ae_captions. Default: reels_9_16 for a 9:16 comp, else ae_reframe's margins."),
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
  const segs = parseCaptionTranscript(text ?? "", t.format ?? detectFormat(text ?? "", t.path));
  const from = t.from_s ?? 0;
  const to = t.to_s ?? Infinity;
  const kept = segs.filter((s) => s.start >= from && s.start < to);
  if (!kept.length) throw new TranscriptError(`No transcript segment starts between ${from} s and ${to} s`);
  return kept;
}

/** The captions for a tool call's transcript and options; throws TranscriptError. */
export function planCaptions(args: Pick<PlanArgs, "transcript" | "max_chars_per_line" | "max_lines" | "min_duration" | "max_duration" | "linger" | "pause_break"> & Partial<PlanOptions> & { frame_rate?: number }): CaptionPlan {
  const plan = buildCaptions(segmentsFromTranscript(args.transcript), {
    ...pickPlanOptions(args as Record<string, unknown>),
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

/** The planner fields a caption may carry (agent A's transcript.ts sets them when a standard, SDH or speaker style is on). */
interface CaptionExtras {
  kind?: CaptionKind;
  speaker_index?: number;
  color?: string;
  italic?: boolean;
}
interface PlanExtras {
  standard?: string;
  changes?: PlanChange[];
  violations?: PlanViolation[];
  cleanup?: CleanupReport;
}

const previewOf = (c: Caption, n: number) => {
  const x = c as Caption & CaptionExtras;
  return {
    n,
    start: c.start,
    end: c.end,
    text: c.lines.join("\n"),
    words: c.words.length,
    ...(c.speaker !== undefined ? { speaker: c.speaker } : {}),
    ...(x.kind !== undefined ? { kind: x.kind } : {}),
    ...(x.speaker_index !== undefined ? { speaker_index: x.speaker_index } : {}),
    ...(x.color !== undefined ? { color: x.color } : {}),
    ...(x.italic !== undefined ? { italic: x.italic } : {}),
  };
};

const PLAN_LIST_MAX = 200;

/** standard, changes, violations and cleanup of a plan; the lists are bounded, with their full counts. */
export function planFields(plan: CaptionPlan): Record<string, unknown> {
  const x = plan as CaptionPlan & PlanExtras;
  const out: Record<string, unknown> = {};
  if (x.standard !== undefined) out.standard = x.standard;
  const changes = x.changes ?? [];
  const violations = x.violations ?? [];
  out.changes = changes.slice(0, PLAN_LIST_MAX);
  out.change_count = changes.length;
  out.violations = violations.slice(0, PLAN_LIST_MAX);
  out.violation_count = violations.length;
  if (changes.length > PLAN_LIST_MAX || violations.length > PLAN_LIST_MAX) out.lists_truncated = true;
  if (x.cleanup !== undefined) out.cleanup = x.cleanup;
  return out;
}

// ---------- platforms ----------

export const platformMargins = (p: PlatformPreset) => {
  const x = PLATFORM_PRESETS[p];
  return { top: x.top, bottom: x.bottom, left: x.left, right: x.right };
};

/** The margin table the host uses when no platform is given: ae_reframe's, but a 9:16 comp gets the reels_9_16 box (ae_reframe keeps its own 20% bottom). */
export const CAPTION_DEFAULT_MARGINS: Record<string, { top: number; bottom: number; left: number; right: number }> = { ...DEFAULT_MARGINS, "9:16": platformMargins("reels_9_16") };

/** Presets whose lower-right action rail is checked; "auto" lets the host decide from the comp's shape (9:16 and no platform). */
const RAIL_PRESETS: PlatformPreset[] = ["tiktok_9_16", "reels_9_16"];
const railFor = (platform: PlatformPreset | undefined): boolean | "auto" => (platform === undefined ? "auto" : RAIL_PRESETS.includes(platform));

// ---------- match by time ----------

/**
 * Pairs existing caption layers with the new captions by the greatest overlap in time (each used once).
 * Greedy from the largest overlap; ties go to the nearer start, then the lower number. Only overlapping pairs are matched.
 */
export function matchByTime(
  existing: Array<{ id: number; number: number; inPoint: number; outPoint: number }>,
  wanted: Array<{ number: number; start: number; end: number }>
): Array<{ layer_id: number; number: number }> {
  const pairs: Array<{ id: number; number: number; overlap: number; gap: number }> = [];
  for (const e of existing) {
    for (const w of wanted) {
      const overlap = Math.min(e.outPoint, w.end) - Math.max(e.inPoint, w.start);
      if (overlap > 1e-6) pairs.push({ id: e.id, number: w.number, overlap, gap: Math.abs(e.inPoint - w.start) });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || a.gap - b.gap || a.number - b.number);
  const usedLayer = new Set<number>();
  const usedNumber = new Set<number>();
  const out: Array<{ layer_id: number; number: number }> = [];
  for (const p of pairs) {
    if (usedLayer.has(p.id) || usedNumber.has(p.number)) continue;
    usedLayer.add(p.id);
    usedNumber.add(p.number);
    out.push({ layer_id: p.id, number: p.number });
  }
  return out.sort((a, b) => a.number - b.number);
}

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
  /** The text's fill colour ([r, g, b], 0..1; words mode: the first word's) and whether faux italic is on. */
  fill?: number[];
  faux_italic?: boolean;
  /** The look the caption carries: its kind and the keys on its main property (words mode: summed over the word layers). */
  look?: { present: boolean; kind?: string; keys?: number; layers?: number };
  keys?: Array<{ time: number; text: string; width?: number; outside_safe?: boolean; rail_overlap?: boolean; fill?: number[]; faux_italic?: boolean }>;
  truncated_keys?: boolean;
  first_outside_safe?: number;
  rect?: { left: number; top: number; width: number; height: number };
  position?: number[];
  outside_safe?: boolean;
  rect_error?: string;
  /** Paragraph (box) text: the box size, and whether the text is taller than the box (lines are hidden). */
  box_text?: boolean;
  boxTextSize?: number[];
  box_overflow?: boolean;
  /** The caption (its box, in comp pixels) reaches into the platform's lower-right action rail. */
  rail_overlap?: boolean;
  /** Words mode: the caption's word layers (kind "words"; rect is the union of their extents in comp space). */
  word_layers?: number;
  words?: Array<{ word: number; name: string; id: number; inPoint: number; outPoint: number; text: string; fill?: number[]; faux_italic?: boolean }>;
  /** Template mode (kind "template"): the instanced comp and the values of its Essential Properties. */
  source_comp_id?: number;
  source_comp_name?: string;
  essential?: Record<string, unknown>;
}

export interface CaptionsRead {
  comp_id: number;
  width: number;
  height: number;
  frameDuration: number;
  safe: { left: number; right: number; top: number; bottom: number; width: number; rail?: boolean };
  mode: "layers" | "single" | "words" | "template";
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
  updated?: string[];
  removed?: string[];
  /** The host lists at most 500 names of each kind and says how many there were. */
  created_count?: number;
  updated_count?: number;
  removed_count?: number;
  names_truncated?: boolean;
  highlight_keys?: number;
  count?: number;
  /** The comp the captions are in after the write: the precomp's, when they were precomposed. */
  target_comp_id?: number;
  word_layers?: number;
  precomp?: { comp_id: number; layer_id: number | null; name: string; created: boolean };
  control?: { name: string; id: number; created: boolean };
  renamed?: number;
  template?: { comp_id: number; name: string; fields: number };
  look?: { kind: string; layers: number; keys: number; duration_frames: number };
  looks_removed?: number;
  colored?: boolean;
}

const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const nearColor = (a: number[] | undefined, b: number[], tol = 0.01) => a !== undefined && a.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= tol);

/** The text a template field receives from a caption (what ae_captions sends the host and what the read-back must find). */
export function templateFieldValue(kind: "line1" | "line2" | "line3" | "text" | "speaker", c: Caption, speakerNames?: Record<string, string>): string {
  if (kind === "line1") return c.lines[0] ?? "";
  if (kind === "line2") return c.lines[1] ?? "";
  if (kind === "line3") return c.lines[2] ?? "";
  if (kind === "text") return c.lines.join("\r");
  return speakerLabel(c, speakerNames);
}

const speakerLabel = (c: Caption, names?: Record<string, string>): string => (c.speaker === undefined ? "" : names?.[c.speaker] ?? c.speaker);

export function captionsMismatches(
  args: Pick<CaptionsArgs, "mode" | "first_number" | "highlight" | "box" | "style"> & Partial<Pick<CaptionsArgs, "template" | "speaker_names" | "look">>,
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
  const lookKind = args.look ?? "none";
  const anyColor = captions.some((c) => (c as Caption & CaptionExtras).color !== undefined);
  const anyItalic = captions.some((c) => (c as Caption & CaptionExtras).italic === true);
  // A capped read can't judge layers it did not list.
  const capped = after.truncated || after.total_captions > after.captions.length;

  if (mode !== "single") {
    captions.forEach((c, i) => {
      const entry = after.captions.find((e) => e.number === first + i);
      if (!entry) {
        if (!capped) m.push({ path: `captions[${first + i}]`, expected: c.lines.join("\n"), actual: undefined, message: "The caption layer is not in the read-back" });
        return;
      }
      // Words mode joins the words with spaces (the lines are a layout, not text).
      const want = mode === "words" ? c.lines.join(" ") : c.lines.join("\n");
      if (mode === "template") {
        expectThat(m, entry.kind === "template" && entry.source_comp_id === args.template?.comp_id, `captions[${entry.number}].template`, args.template?.comp_id, entry.source_comp_id, "The layer is not an instance of the template comp");
        for (const [field, kind] of Object.entries(args.template?.fields ?? {})) {
          const wantValue = norm(templateFieldValue(kind, c, args.speaker_names));
          const got = entry.essential?.[field];
          expectThat(m, typeof got === "string" && norm(got) === wantValue, `captions[${entry.number}].essential.${field}`, wantValue, got, "The Essential Property holds other text");
        }
      } else {
        expectThat(m, entry.text !== undefined && norm(entry.text) === want, `captions[${entry.number}].text`, want, entry.text === undefined ? undefined : norm(entry.text), "Caption text differs");
      }
      if (mode === "words") expectThat(m, entry.word_layers === c.words.length, `captions[${entry.number}].word_layers`, c.words.length, entry.word_layers, "The caption has another number of word layers");
      const t = timings[i];
      if (t) {
        expectThat(m, Math.abs(entry.inPoint - t[0]) <= tol, `captions[${entry.number}].inPoint`, t[0], entry.inPoint, "Caption starts at another time");
        expectThat(m, Math.abs(entry.outPoint - t[1]) <= tol, `captions[${entry.number}].outPoint`, t[1], entry.outPoint, "Caption ends at another time");
      }
      expectThat(m, entry.box_overflow !== true, `captions[${entry.number}].box_overflow`, false, entry.box_overflow, "The text is taller than its paragraph box, so lines are hidden");
      if (mode !== "template") {
        const x = c as Caption & CaptionExtras;
        if (anyColor) {
          const wantFill = x.color !== undefined ? hexToRgb(x.color) : args.style?.fill_color ?? [1, 1, 1];
          const got = mode === "words" ? (entry.words ?? []).map((w) => w.fill) : [entry.fill];
          const bad = got.filter((g) => g !== undefined && !nearColor(g, wantFill));
          expectThat(m, bad.length === 0, `captions[${entry.number}].fill`, wantFill, bad[0], "The text has another fill colour");
        }
        if (anyItalic) {
          const wantItalic = x.italic === true;
          const got = mode === "words" ? (entry.words ?? []).map((w) => w.faux_italic) : [entry.faux_italic];
          const bad = got.filter((g) => g !== undefined && g !== wantItalic);
          expectThat(m, bad.length === 0, `captions[${entry.number}].faux_italic`, wantItalic, bad[0], "Faux italic differs");
        }
      }
      if ((mode === "layers" || mode === "words") && !capped) {
        if (lookKind !== "none") {
          expectThat(m, entry.look?.present === true && entry.look.kind === lookKind, `captions[${entry.number}].look`, lookKind, entry.look, "The caption does not carry the look");
        } else {
          expectThat(m, entry.look?.present !== true, `captions[${entry.number}].look`, "none", entry.look, "The caption still carries a look from an earlier run");
        }
      }
      // A truncated name list cannot say which layers were made, so that check is skipped rather than guessed.
      if (mode === "layers" && !written.names_truncated && made.has(entry.name) && entry.justification !== undefined) {
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
    if (args.highlight && !capped && mode === "layers") {
      // Only the layers this call keyed: older chunks keep their own highlights.
      const keyed = after.captions.filter((e) => e.number >= first && e.number < first + captions.length).reduce((n, e) => n + (e.highlight?.start_keys ?? 0), 0);
      expectThat(m, written.highlight_keys === undefined || keyed === written.highlight_keys, "highlight.keys", written.highlight_keys, keyed, "The highlight's word keys differ from what was written");
      const bare = after.captions.filter((e) => e.number >= first && e.number < first + captions.length && !e.highlight?.present).map((e) => e.name);
      expectThat(m, bare.length === 0, "highlight.present", [], bare, "Caption layers without the highlight animator");
    }
    if (!args.highlight && !capped && mode === "layers") {
      // A re-run without a highlight takes the old Caption Highlight animator off.
      const kept = after.captions.filter((e) => e.number >= first && e.number < first + captions.length && e.highlight?.present).map((e) => e.name);
      expectThat(m, kept.length === 0, "highlight.stale", [], kept, "Caption layers still carry a Caption Highlight animator from an earlier run");
    }
    if (lookKind !== "none" && !capped && (mode === "layers" || mode === "words") && written.look?.keys !== undefined) {
      const total = after.captions.filter((e) => e.number >= first && e.number < first + captions.length).reduce((n, e) => n + (e.look?.keys ?? 0), 0);
      expectThat(m, total === written.look.keys, "look.keys", written.look.keys, total, "The look's key count differs from what was written");
    }
    if (args.box && !capped && mode === "layers") {
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
    expectThat(m, entry.box_overflow !== true, "caption.box_overflow", false, entry.box_overflow, "The text is taller than its paragraph box, so lines are hidden");
    if ((anyColor || anyItalic) && !entry.truncated_keys) {
      const tms = timings.length === captions.length ? timings : captions.map((c) => [c.start, c.end] as [number, number]);
      let ki = 0;
      captions.forEach((c, i) => {
        const at = ki;
        const key = entry.keys?.[at];
        ki++;
        const next = tms[i + 1];
        if (!next || next[0] > tms[i][1] + 1e-6) ki++;
        if (!key) return;
        const x = c as Caption & CaptionExtras;
        if (anyColor) {
          const wantFill = x.color !== undefined ? hexToRgb(x.color) : args.style?.fill_color ?? [1, 1, 1];
          expectThat(m, key.fill === undefined || nearColor(key.fill, wantFill), `caption.keys[${at}].fill`, wantFill, key.fill, "A Source Text key has another fill colour");
        }
        if (anyItalic) expectThat(m, key.faux_italic === undefined || key.faux_italic === (x.italic === true), `caption.keys[${at}].faux_italic`, x.italic === true, key.faux_italic, "A Source Text key has another faux italic setting");
      });
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

/** What the new template comp must hold: the controllers by the names asked for (when AE took them), the caption layer and its Fill effect, the box. */
export function templateMismatches(args: { box?: unknown; look?: string }, afterRaw: unknown, written: { comp_id?: number; controllers?: string[]; controllers_named?: boolean }): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw && typeof afterRaw === "object" ? (afterRaw as TemplateRead) : null;
  if (!after) return m;
  expectThat(m, after.comp_id === written.comp_id, "template.comp_id", written.comp_id, after.comp_id, "The read-back found another comp");
  const want = ["Caption Text", "Caption Color", ...(args.box ? ["Box Color", "Box Opacity"] : [])];
  if (written.controllers_named === false) {
    expectThat(m, after.controllers.length >= want.length, "template.controllers", `${want.length} controllers`, after.controllers, "Essential Graphics has fewer controllers than the template needs (AE named them itself)");
  } else {
    const missing = want.filter((n) => !after.controllers.includes(n));
    expectThat(m, missing.length === 0, "template.controllers", want, after.controllers, "Essential Graphics lacks controllers the template needs");
  }
  const text = after.layers.find((l) => l.kind === "text" && l.name === "Caption");
  expectThat(m, text !== undefined, "template.layers.Caption", "a text layer named Caption", after.layers.map((l) => l.name), "The caption text layer is missing");
  if (text) {
    expectThat(m, text.has_fill_effect !== false, "template.fill_effect", true, text.has_fill_effect, "The Fill effect behind Caption Color is missing");
    if (args.look === "pop") expectThat(m, text.look?.present === true, "template.look", "pop", text.look, "The pop keys are missing");
  }
  if (args.box) expectThat(m, after.layers.some((l) => l.kind === "shape" && l.name === "Caption Box"), "template.layers.Caption Box", true, after.layers.map((l) => l.name), "The box layer is missing");
  return m;
}

interface TemplateRead {
  comp_id: number;
  name: string;
  controllers: string[];
  layers: Array<{ name: string; id: number; kind: string; text?: string; fill?: number[]; has_fill_effect?: boolean; look?: { present: boolean; kind?: string } }>;
}

// ---------- fit ----------

/** Captions the read-back found outside the safe area, by name (with the width, and for single mode the first time). */
function outsideOf(read: CaptionsRead | null) {
  return (read?.captions ?? [])
    .filter((e) => e.outside_safe === true || e.first_outside_safe !== undefined)
    .map((e) => ({ name: e.name, ...(e.rect ? { width: e.rect.width } : {}), ...(e.first_outside_safe !== undefined ? { first_at: e.first_outside_safe } : {}) }));
}

interface FitWritten extends Record<string, unknown> {
  fitted?: Array<Record<string, unknown>>;
  skipped?: string[];
}

interface FitItem {
  layer_id?: number;
  number?: number;
  key?: number;
  lines?: string[];
  font_size?: number;
}

/** What each fit item must read back as. */
export function fitMismatches(mode: "layers" | "single", items: FitItem[], afterRaw: unknown, skipped: string[] = []): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = readOf(afterRaw);
  if (!after) return m;
  for (const it of items) {
    if (mode === "layers") {
      const e = after.captions.find((c) => c.number === it.number);
      if (!e) continue;
      if (skipped.includes(e.name)) continue;
      if (it.lines) expectThat(m, e.text !== undefined && norm(e.text) === it.lines.join("\n"), `captions[${it.number}].text`, it.lines.join("\n"), e.text === undefined ? undefined : norm(e.text), "The refitted caption holds other text");
      if (it.font_size !== undefined) expectThat(m, e.fontSize !== undefined && Math.abs(e.fontSize - it.font_size) <= 0.5, `captions[${it.number}].fontSize`, it.font_size, e.fontSize, "The refitted caption has another font size");
    } else {
      const key = after.captions[0]?.keys?.[(it.key ?? 1) - 1];
      if (!key) continue;
      if (it.lines) expectThat(m, norm(key.text) === it.lines.join("\n"), `caption.keys[${(it.key ?? 1) - 1}].text`, it.lines.join("\n"), norm(key.text), "The refitted key holds other text");
    }
  }
  return m;
}

interface FitContext {
  mode: "layers" | "single" | "words" | "template";
  captions: Caption[];
  first: number;
  measured: CaptionsRead | null;
  written: Record<string, unknown>;
}

/**
 * ae_captions fit. Starts from the read-back of the write (measured in a separate evalScript), re-breaks the
 * captions that are wider than the safe area, measures again, then shrinks those still too wide. Returns the
 * finished result (the write's, with `refit`, the final outside_safe and warnings), or null when nothing applies.
 */
async function fitCaptions(ctx: ToolContext, args: CaptionsArgs, f: FitContext): Promise<Record<string, unknown> | null> {
  const fitMode = args.fit;
  const mode = f.mode;
  if (fitMode === "none" || (mode !== "layers" && mode !== "single") || !f.measured || f.written.applied !== true) return null;
  const warnings = Array.isArray(f.written.warnings) ? [...(f.written.warnings as string[])] : [];
  if (args.look === "pill_slide") {
    if (outsideOf(f.measured).length) warnings.push("fit does not change captions with look pill_slide (the pill follows the original lines); re-run with a smaller max_chars_per_line or font_size.");
    return outsideOf(f.measured).length ? { ...f.written, warnings } : null;
  }
  const justification = args.style?.justification ?? "center";
  const boxPad = args.box?.padding ?? 0;
  const baseSize = typeof f.written.font_size === "number" ? f.written.font_size : 0;
  const maxLines =
    mode === "single"
      ? Math.max(1, ...f.captions.map((c) => c.lines.length))
      : args.max_lines ?? (args.standard ? CAPTION_STANDARDS[args.standard].max_lines : 2);
  const compId = typeof f.written.target_comp_id === "number" ? f.written.target_comp_id : args.comp_id;
  const readFit = (id: number) =>
    readArgsFor({
      comp_id: id,
      mode,
      name_prefix: args.name_prefix ?? "Caption",
      layout: args.layout,
      platform: args.platform,
      ...(mode === "single" ? {} : { from_number: f.first, to_number: f.first + f.captions.length - 1 }),
    });

  const areaOf = (r: CaptionsRead): FitArea => ({ comp_width: r.width, left: r.safe.left, right: r.safe.right, width: r.safe.width, justification, box_padding: boxPad });
  /** The measured captions (layers) or keys (single) as fit candidates, with the item data to address them. */
  const candidatesOf = (r: CaptionsRead): Array<{ c: FitCandidate; item: FitItem }> => {
    const out: Array<{ c: FitCandidate; item: FitItem }> = [];
    if (mode === "single") {
      const e = r.captions[0];
      (e?.keys ?? []).forEach((k, i) => {
        if (k.width === undefined || !k.text) return;
        out.push({ c: { index: i + 1, name: `${e.name} key ${i + 1}`, width: k.width, font_size: e.fontSize ?? baseSize, lines: norm(k.text).split("\n") }, item: { key: i + 1 } });
      });
      return out;
    }
    for (const e of r.captions) {
      if (e.kind !== "text" || e.box_text === true || !e.rect || e.text === undefined || e.fontSize === undefined) continue;
      out.push({ c: { index: e.number, name: e.name, width: e.rect.width, font_size: e.fontSize, lines: norm(e.text).split("\n") }, item: { layer_id: e.id, number: e.number } });
    }
    return out;
  };

  const refit: RefitEntry[] = [];
  let current: CaptionsRead = f.measured;
  let latest: unknown = null;
  let passes = 0;
  let receiptsOk = true;
  const write = async (items: FitItem[], label: string): Promise<boolean> => {
    const res = await runGuardedWrite<FitWritten>(ctx, {
      toolName: "ae_captions",
      label: `ae_captions(fit ${label}, ${items.length})`,
      expect: args.expect,
      compId: args.comp_id,
      read: (phase) => (phase === "after" ? { host: "captionsRead", args: readFit(compId) } : null),
      write: {
        host: "captionsFit",
        args: {
          comp_id: compId,
          mode,
          ...(mode === "single" ? { layer_id: current.captions[0]?.id } : {}),
          items,
          layout: args.layout,
          default_margins: CAPTION_DEFAULT_MARGINS,
          ...(args.platform ? { platform_margins: platformMargins(args.platform) } : {}),
          ...(boxPad > 0 ? { box_padding: boxPad } : {}),
          label: `Fit captions (${label})`,
        },
      },
      check: (_b, after, w) => fitMismatches(mode, items, after, w.skipped),
      present: (_b, after, w) => {
        latest = after;
        return { fitted: w.fitted, skipped: w.skipped ?? [] };
      },
    });
    passes++;
    const r = res as unknown as { receipt?: { ok?: boolean } };
    if (r.receipt && r.receipt.ok === false) receiptsOk = false;
    const read = readOf(latest);
    if (read) current = read;
    const skipped = (res as unknown as { skipped?: string[] }).skipped ?? [];
    if (skipped.length) warnings.push(`fit skipped paragraph-text caption${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} (box text wraps itself)`);
    return !!read;
  };

  try {
    // 1. Re-break.
    if (fitMode !== "shrink") {
      const items: FitItem[] = [];
      const entries: RefitEntry[] = [];
      for (const { c, item } of candidatesOf(current)) {
        if (!isTooWide(c, areaOf(current))) continue;
        if (args.look === "fill_sweep") continue;
        const lines = rebreakLines(c, areaOf(current), maxLines);
        if (!lines) continue;
        items.push({ ...item, lines });
        entries.push({ name: c.name, action: "rebreak", from: c.lines, to: lines });
      }
      if (items.length && (await write(items, "rebreak"))) refit.push(...entries);
    }
    // 2. Shrink what is still too wide.
    if (fitMode !== "rebreak") {
      const items: FitItem[] = [];
      const entries: RefitEntry[] = [];
      let floored = 0;
      for (const { c, item } of candidatesOf(current)) {
        if (!isTooWide(c, areaOf(current))) continue;
        const s = shrinkSize(c, areaOf(current), baseSize || c.font_size);
        if (!s) continue;
        if (!s.fits) floored++;
        items.push({ ...item, font_size: s.font_size });
        entries.push({ name: c.name, action: "shrink", from: c.font_size, to: s.font_size });
      }
      if (items.length && (await write(items, "shrink"))) refit.push(...entries);
      if (floored) warnings.push(`${floored} caption${floored === 1 ? " was" : "s were"} scaled to the smallest size fit allows (70% of ${baseSize || "the base size"} px) and still run wider than the safe area; shorten the lines or use a narrower font.`);
    }
  } catch (err) {
    warnings.push(`fit stopped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const finalArea = areaOf(current);
  // Same criterion as the fit: the width against the safe width. A caption flagged outside that is not too wide sits wrongly (position, lines).
  const outside = outsideOf(current).map((o) => {
    const cand = o.width !== undefined ? outsideReason({ width: o.width }, finalArea) : undefined;
    return cand ? { ...o, reason: cand } : o;
  });
  const kept = warnings.filter((w) => !/outside the safe area; /.test(w));
  if (outside.length) kept.push(`${outside.length} caption${outside.length === 1 ? " runs" : "s run"} outside the safe area${refit.length ? " even after fit" : ""}; re-run with a smaller max_chars_per_line or font_size.`);
  const rail = (current.captions ?? []).filter((e) => e.rail_overlap === true).map((e) => e.name);
  const result: Record<string, unknown> = {
    ...f.written,
    outside_safe: outside,
    refit,
    ...(passes ? { fit: { passes, receipts_ok: receiptsOk } } : {}),
    warnings: kept,
  };
  if (rail.length) result.rail_overlap = rail;
  else delete result.rail_overlap;
  return result;
}

// ---------- template fit ----------

interface TemplateMeasure {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  font_size: number;
  scale: number;
  box_padding: number;
  method: "measured" | "estimated";
  widths: number[];
}

export interface TemplateFitResult {
  method?: "measured" | "estimated";
  template_width?: number;
  refit: RefitEntry[];
  template_overflow: Array<{ name: string; width: number; template_width: number }>;
  warnings: string[];
}

/** The most lines a template's fields can show: its line fields, or max_lines (the standard's, else 2) for a single text field. */
export function templateMaxLines(fields: Record<string, string>, maxLines: number): number {
  const kinds = Object.values(fields);
  if (kinds.includes("text")) return maxLines;
  const lineFields = kinds.filter((k) => k === "line1" || k === "line2" || k === "line3").length;
  return Math.max(1, Math.min(maxLines, lineFields || maxLines));
}

/**
 * ae_captions fit for template mode. Measures each caption's widest line in the template's caption style, re-breaks the
 * captions wider than the template comp (their `lines` are changed in place, before they are written) and reports what still does not fit.
 */
async function fitTemplateCaptions(ctx: ToolContext, args: CaptionsArgs, captions: Caption[], prefix: string, first: number): Promise<TemplateFitResult | null> {
  const tpl = args.template;
  if (!tpl || !captions.length) return null;
  const out: TemplateFitResult = { refit: [], template_overflow: [], warnings: [] };
  const measure = async (lines: string[][], label: string) =>
    (await ctx.bridge.callHost<TemplateMeasure>("captionsTemplateMeasure", { comp_id: tpl.comp_id, texts: lines, label }, { label: `ae_captions(measure template, ${lines.length})`, mutates: true, toolName: "ae_captions" })).result;
  let m: TemplateMeasure;
  try {
    m = await measure(captions.map((c) => c.lines), "Measure template captions");
  } catch (err) {
    out.warnings.push(`template fit skipped: could not measure the captions in the template (${err instanceof Error ? err.message : String(err)}).`);
    return out;
  }
  if (!Array.isArray(m.widths) || m.widths.length !== captions.length) return out;
  out.method = m.method;
  out.template_width = m.width;
  if (m.method === "estimated") out.warnings.push("template fit estimated the widths from the pixels per character of the template's sample text (no temporary text layer could be made); the result is approximate, check it in the comp.");
  const std = args.standard ? CAPTION_STANDARDS[args.standard] : undefined;
  const maxLines = templateMaxLines(tpl.fields, args.max_lines ?? std?.max_lines ?? 2);
  const area: FitArea = { comp_width: m.width, left: 0, right: 0, width: m.width, justification: "left", box_padding: m.box_padding };
  const avail = availableWidth(area);
  const changed: number[] = [];
  captions.forEach((c, i) => {
    const width = m.widths[i];
    if (!(width > avail + 0.5)) return;
    const lines = rebreakLines({ index: first + i, name: `${prefix} ${String(first + i).padStart(3, "0")}`, width, font_size: m.font_size, lines: c.lines }, area, maxLines);
    if (!lines) return;
    out.refit.push({ name: `${prefix} ${String(first + i).padStart(3, "0")}`, action: "rebreak", from: c.lines, to: lines });
    c.lines = lines;
    changed.push(i);
  });
  // Measure the re-broken ones again: the estimate of the re-break can be off with a proportional font.
  let widths = m.widths;
  if (changed.length) {
    try {
      const again = await measure(changed.map((i) => captions[i].lines), "Measure re-broken template captions");
      widths = [...m.widths];
      changed.forEach((i, k) => (widths[i] = again.widths[k]));
    } catch {
      /* keep the first measurement; the overflow list below is then the earlier one */
    }
  }
  captions.forEach((c, i) => {
    if (widths[i] > avail + 0.5) out.template_overflow.push({ name: `${prefix} ${String(first + i).padStart(3, "0")}`, width: Math.round(widths[i]), template_width: m.width });
  });
  if (out.refit.length) out.warnings.push(`${out.refit.length} caption${out.refit.length === 1 ? " was" : "s were"} wider than the template comp (${m.width} px) and re-broken into more lines (${m.method}).`);
  if (out.template_overflow.length) {
    out.warnings.push(
      `${out.template_overflow.length} caption${out.template_overflow.length === 1 ? " is" : "s are"} still wider than the template comp (${m.width} px) and will be cropped; shorten the text, allow more lines (max_lines, more line fields), or make the template wider.`
    );
  }
  return out;
}

function mergeTemplateFit(res: Record<string, unknown>, fit: TemplateFitResult) {
  if (fit.method) res.template_fit = { method: fit.method, template_width: fit.template_width };
  if (fit.refit.length) res.refit = fit.refit;
  if (fit.template_overflow.length) res.template_overflow = fit.template_overflow;
  if (fit.warnings.length) res.warnings = [...(Array.isArray(res.warnings) ? (res.warnings as string[]) : []), ...fit.warnings];
}

// ---------- tools ----------

type ReadArgsIn = {
  comp_id: number;
  mode?: "layers" | "single" | "words" | "template";
  name_prefix?: string;
  layout?: CaptionsArgs["layout"];
  platform?: PlatformPreset;
  from_number?: number;
  to_number?: number;
  /** Follow a '<prefix> Captions' precomp layer into its comp (captions made with precompose). */
  through_precomp?: boolean;
  frame_rate_probe?: boolean;
};

const readArgsFor = (args: ReadArgsIn) => ({
  comp_id: args.comp_id,
  mode: args.mode ?? "layers",
  name_prefix: args.name_prefix ?? "Caption",
  layout: args.layout ? { margins: args.layout.margins } : undefined,
  default_margins: CAPTION_DEFAULT_MARGINS,
  ...(args.platform ? { platform_margins: platformMargins(args.platform) } : {}),
  rail: railFor(args.platform),
  ...(args.through_precomp ? { through_precomp: true } : {}),
  from_number: args.from_number,
  to_number: args.to_number,
  // Marks a read made only for the comp's frame rate (the host ignores it).
  ...(args.frame_rate_probe ? { frame_rate_probe: true } : {}),
});

const badTranscript = (err: unknown) => {
  if (err instanceof TranscriptError) return { ok: false, error: "bad_transcript", message: err.message };
  throw err;
};

/** The time a word shows: the highlight lead is already in `show_at` (transcript.ts), else the word's own start. */
const showAt = (w: CaptionWord): number => (w as CaptionWord & { show_at?: number }).show_at ?? w.start;

/** ae_captions with make_template: a new comp with the caption layer and its Essential Graphics controllers. */
async function makeTemplate(args: CaptionsArgs, ctx: ToolContext) {
  const mt = args.make_template ?? {};
  const prefix = args.name_prefix ?? "Caption";
  const name = mt.name ?? `${prefix} Template`;
  const box = args.box ? { color: args.box.color ?? [0, 0, 0], opacity: args.box.opacity ?? 60, padding: args.box.padding ?? 24, roundness: args.box.roundness ?? 0 } : undefined;
  const look = args.look === "pop" ? "pop" : "none";
  const res = await runGuardedWrite<TemplateWritten>(ctx, {
    toolName: "ae_captions",
    label: `ae_captions(make_template "${name}")`,
    expect: args.expect,
    compId: args.comp_id,
    read: (phase, written) => (phase === "after" && written?.comp_id !== undefined ? { host: "captionsTemplateRead", args: { comp_id: written.comp_id } } : null),
    write: {
      host: "captionsTemplate",
      args: {
        comp_id: args.comp_id,
        make_template: { ...mt, name },
        style: args.style,
        layout: args.layout,
        default_margins: CAPTION_DEFAULT_MARGINS,
        ...(args.platform ? { platform_margins: platformMargins(args.platform) } : {}),
        box,
        look,
        ...(look === "pop" && args.look_options ? { look_options: args.look_options } : {}),
        ...(args.allow_substitute ? { allow_substitute: true } : {}),
        label: `Caption template "${name}"`,
      },
    },
    check: (_before, after, w) => templateMismatches({ box, look }, after, w),
    present: (_before, _after, w) => ({
      comp_id: args.comp_id,
      template_comp_id: w.comp_id,
      template_name: w.name,
      width: w.width,
      height: w.height,
      duration_s: w.duration_s,
      controllers: w.controllers,
      controllers_named: w.controllers_named,
      look: w.look,
      has_box: w.has_box,
      warnings: w.warnings ?? [],
      next: `ae_save, then ae_export_mogrt with comp_id ${w.comp_id}`,
    }),
  });
  return res;
}

interface TemplateWritten extends Record<string, unknown> {
  comp_id?: number;
  name?: string;
  width?: number;
  height?: number;
  duration_s?: number;
  controllers?: string[];
  controllers_named?: boolean;
  has_box?: boolean;
  look?: string;
  warnings?: string[];
}

export const captionsTools: ToolDefinition<any>[] = [
  {
    name: "ae_captions_plan",
    description:
      "Plan captions from a transcript (SRT, WebVTT, ElevenLabs speech-to-text JSON with words, Whisper-style JSON) without touching After Effects: words are grouped into captions at speaker changes, pauses and sentence ends " +
      "within the line, line-count and duration limits, balanced across lines, held for a minimum time and rounded to whole frames (give frame_rate). " +
      "Options: `standard` (netflix_adult, netflix_kids, bbc, dcmp, social_9x16) sets the limits and fixes captions that break them (extend into gaps, merge short ones, split long ones); `fix: false` only reports. " +
      "`cut_times` keeps captions from straddling shot changes; `cleanup` drops invented trailing words, music tokens and near-zero words and can remove fillers and stutters, apply a glossary, change case or strip punctuation; " +
      "`max_words` and `single_word` chunk for social; `speaker_style`, `speaker_colors`, `speaker_names` and `accessibility` show who speaks; `sdh` keeps sound events and marks lyrics; `highlight_lead_frames` moves the highlighted word earlier; `min_gap_frames` and `close_gaps_under` set the gaps. " +
      "Returns every caption (times, lines, word count, and kind, speaker_index, color, italic when set), warnings (estimated word times for SRT/VTT, captions faster than 21 characters per second, words longer than a line), " +
      "and, when options made them, `standard`, `changes` (what was fixed), `violations` (what still breaks the standard) and `cleanup` counts (lists bounded to 200, with counts). Changes nothing.",
    schema: AeCaptionsPlanSchema,
    handler: async (args: PlanArgs) => {
      try {
        const plan = planCaptions(args);
        return {
          count: plan.captions.length,
          estimated_word_times: plan.estimated_word_times,
          warnings: plan.warnings,
          ...planFields(plan),
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
      "Turn a transcript (SRT, WebVTT, ElevenLabs or Whisper JSON) into captions in a comp, in one undo group guarded by `expect`. " +
      "Node groups the words into captions (the planner options of ae_captions_plan apply: standard, cleanup, cut_times, speakers, sdh...), breaks lines (max_chars_per_line, max_lines), and sets frame-rounded times; the captions sit in a platform's safe area. " +
      "SAFE AREA: `platform` (reels_9_16 = the box safe on TikTok, Reels and Shorts together; tiktok_9_16, instagram_reels_9_16, youtube_shorts_9_16; approximate numbers from the platforms' ad specs, re-check yearly) sets the margins; layout.margins win per edge. " +
      "With no platform a 9:16 comp uses reels_9_16 (about 35% kept clear at the bottom, 15% at the top); other shapes use ae_reframe's margins. For tiktok_9_16 and reels_9_16 the read-back flags captions reaching the lower-right action rail (`rail_overlap`). " +
      "MODES: 'layers' (default) one text layer per caption ('Caption 001'...); 'single' one layer with hold-keyed Source Text; " +
      "'words' one text layer per word ('Caption 001.01'...), each placed where the word falls in the caption's lines (widths measured in After Effects) and visible from the word's time to the caption's end, so words build on (no highlight or box); " +
      "'template' one instance of the comp in `template.comp_id` per caption, its text Essential Properties (template.fields: name to line1/line2/line3/text/speaker) set to the caption; refused before anything changes if the comp lacks those property names (it lists the ones it has), is the target comp or would be circular. " +
      "SPEAKERS AND LYRICS: a caption the planner gave a colour (speaker_style color) gets that fill colour (layers, words, and per key in single mode); the others get the style's fill. Lyric captions (sdh lyric_ranges) get faux italic: After Effects' fauxItalic flag, not a true italic face (that would need another font). Sound events keep the base style. The read-back checks both. " +
      "LOOKS: `look` (layers and words modes) pop, pill_slide or fill_sweep, timed from each word's time, with look_options (duration_frames, scale_from, color, pill_padding, pill_roundness); re-running with look none removes it. See the look field. Needs one time per word. " +
      "TEMPLATE FOR PREMIERE: `make_template` (no transcript) instead makes a new comp with a styled caption layer whose Source Text ('Caption Text'), fill colour ('Caption Color') and box colour and opacity ('Box Color', 'Box Opacity') are in Essential Graphics; it returns template_comp_id and the controller names; then ae_save and ae_export_mogrt. " +
      "highlight (layers and single mode) colours the spoken word (a text animator keyed per word; SRT/VTT word times are estimates). box (layers and single) adds a background shape that follows the text through sourceRectAtTime. " +
      "OPTIONS: parent_to_null parents every caption and box layer to a null '<name_prefix> Control' (positions kept); precompose puts them (and the null) into a comp '<name_prefix> Captions' and returns its id, and a re-run updates the captions inside it; " +
      "match 'time' pairs existing layers with new captions by overlap in time (renaming them to the new numbers) instead of by number. " +
      "The plan runs on the comp's own frame rate, read first (nothing is written if that read fails). Re-running with the same name_prefix updates the captions by name: text and timing change, your style, position and effects stay (restyle: true resets style and position; in words mode a caption's words are laid out again when their text, count or line breaks change; a word you moved on the same line stays, and word layers with keyframes on Position or Anchor Point, or on Scale or Opacity that this tool did not make, are refused). A speaker colour or lyric italic the tool wrote earlier is put back to the style when a re-run has none. A '<name_prefix> Control' null that you moved, scaled or rotated is refused when captions would be parented to it or placed relative to it. Layers past the new count are removed. " +
      "A style.font that AE does not have is refused before anything is written (AE 24+; allow_substitute: true writes it anyway), and the captions' text is checked for glyphs the font lacks (AE 25.1+; Turkish letters are the usual case): missing characters come back as a warning with AE's default font for the script. Layers are made at the top of the stack. At most 500 captions per call (use from_s/to_s and first_number to continue). " +
      "The read-back (a separate evalScript) checks text, timing, justification, highlight keys, stale layers, box expressions and (template mode) the Essential Property values, and measures each caption's extents: `outside_safe` lists captions that run outside the safe area. FIT: the planner counts characters, a wide font runs wider, so (layers and single mode, `fit` default) a caption measured wider than the safe area is first re-broken into more lines (up to max_lines, grammar-aware, at the characters per line the measured pixels per character allow), measured again, then scaled down to fit (never below 70% of the base size); `refit` lists [{ name, action, from, to }] and outside_safe is the final measurement; fit 'none' only warns. " +
      "The result also carries the plan's `standard`, `changes`, `violations` and `cleanup` when options made them (bounded to 200, with counts). " +
      "Check the result with ae_frame or ae_contact_sheet. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCaptionsSchema,
    handler: async (args: CaptionsArgs, ctx: ToolContext) => {
      if (args.make_template) return makeTemplate(args, ctx);
      // The frame rules (standard, cut_times, min_gap_frames, close_gaps_under) and the snapping run on the comp's own
      // frame grid. A plain read, before anything is written: if it fails, nothing was touched.
      const asGiven = args as CaptionsArgs & { transcript: NonNullable<CaptionsArgs["transcript"]> };
      // A transcript that cannot be planned is refused before AE is asked anything.
      try {
        planCaptions(asGiven);
      } catch (err) {
        return badTranscript(err);
      }
      let frameRate: number;
      try {
        const rate = await ctx.bridge.callHost(
          "captionsRead",
          readArgsFor({ comp_id: args.comp_id, mode: args.mode ?? "layers", name_prefix: args.name_prefix ?? "Caption", layout: args.layout, platform: args.platform, from_number: 1, to_number: 1, frame_rate_probe: true }),
          { label: `ae_captions(frame rate, ${args.comp_id})`, mutates: false, toolName: "ae_captions" }
        );
        const fd = readOf(rate.result)?.frameDuration;
        if (typeof fd !== "number" || !(fd > 0)) return { ok: false, error: "read_failed", message: "Could not read the comp's frame rate; nothing was written." };
        frameRate = 1 / fd;
      } catch (err) {
        return { ok: false, error: "read_failed", message: `Could not read the comp's frame rate (${err instanceof Error ? err.message : String(err)}); nothing was written.` };
      }
      let plan: CaptionPlan;
      try {
        plan = planCaptions({ ...asGiven, frame_rate: frameRate });
      } catch (err) {
        return badTranscript(err);
      }
      const mode = args.mode ?? "layers";
      const prefix = args.name_prefix ?? "Caption";
      const first = args.first_number ?? 1;
      const removeStale = args.remove_stale ?? first === 1;
      const captions = plan.captions;
      const lookOn = args.look !== undefined && args.look !== "none";
      const anyColor = captions.some((c) => (c as Caption & CaptionExtras).color !== undefined);
      const anyItalic = captions.some((c) => (c as Caption & CaptionExtras).italic === true);

      // match 'time': pair the layers that exist now with the new captions here, and hand the host the mapping.
      let mapping: Array<{ layer_id: number; number: number }> | undefined;
      if (args.match === "time") {
        const probe = await ctx.bridge.callHost("captionsRead", readArgsFor({ comp_id: args.comp_id, mode, name_prefix: prefix, layout: args.layout, platform: args.platform, through_precomp: args.precompose }), {
          label: `ae_captions(match by time, ${args.comp_id})`,
          mutates: false,
          toolName: "ae_captions",
        });
        const existing = readOf(probe.result);
        if (existing && (existing.truncated || existing.total_captions > existing.captions.length)) {
          return { ok: false, error: "too_many_existing", message: `More than ${existing.captions.length} caption layers exist; match 'time' reads them all. Use match 'name' with first_number to work in parts.` };
        }
        mapping = matchByTime(
          (existing?.captions ?? []).map((e) => ({ id: e.id, number: e.number, inPoint: e.inPoint, outPoint: e.outPoint })),
          captions.map((c, i) => ({ number: first + i, start: c.start, end: c.end }))
        );
      }

      // Layers mode asks only for the numbers this call writes (and counts the ones above), so a chunk past 500 reads its own captions.
      const range = mode === "single" ? {} : { from_number: first, to_number: first + captions.length - 1 };
      const readArgs = (compId: number, through?: boolean) =>
        readArgsFor({ comp_id: compId, mode, name_prefix: prefix, layout: args.layout, platform: args.platform, ...(through ? { through_precomp: true } : {}), ...range });
      // Template fit: the text layer inside a template is shared by all instances, so each caption's lines are measured in a
      // temporary text layer of the template's caption style (a separate evalScript, before anything is written) and a caption
      // wider than the template comp is re-broken into more lines (up to what the template's fields and max_lines hold).
      const tplFit = mode === "template" && args.template && args.fit !== "none" ? await fitTemplateCaptions(ctx, args, captions, prefix, first) : null;
      let measured: CaptionsRead | null = null;
      const res = await runGuardedWrite<Written>(ctx, {
        toolName: "ae_captions",
        label: `ae_captions(${captions.length} ${mode})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, written) =>
          phase === "before"
            ? { host: "captionsRead", args: readArgs(args.comp_id, args.precompose) }
            : { host: "captionsRead", args: readArgs(written?.target_comp_id ?? args.comp_id) },
        write: {
          host: "captionsApply",
          args: {
            comp_id: args.comp_id,
            mode,
            name_prefix: prefix,
            first_number: first,
            captions: captions.map((c) => {
              const x = c as Caption & CaptionExtras;
              return {
                start: c.start,
                end: c.end,
                lines: c.lines,
                ...(args.highlight || mode === "words" || lookOn ? { words: c.words.map((w) => (lookOn ? { start: showAt(w), end: w.end } : { start: showAt(w) })) } : {}),
                ...(mode === "template" ? { speaker: speakerLabel(c, args.speaker_names) } : {}),
                // When any caption has a colour (or an italic) every caption says which it has, so the host can put the others back to the base style.
                ...(anyColor ? { color: x.color !== undefined ? hexToRgb(x.color) : null } : {}),
                ...(anyItalic ? { italic: x.italic === true } : {}),
                ...(x.kind !== undefined ? { kind: x.kind } : {}),
              };
            }),
            style: args.style,
            layout: args.layout,
            default_margins: CAPTION_DEFAULT_MARGINS,
            ...(args.platform ? { platform_margins: platformMargins(args.platform) } : {}),
            highlight: args.highlight,
            box: args.box
              ? { color: args.box.color ?? [0, 0, 0], opacity: args.box.opacity ?? 60, padding: args.box.padding ?? 24, roundness: args.box.roundness ?? 0 }
              : undefined,
            ...(lookOn ? { look: args.look, ...(args.look_options ? { look_options: args.look_options } : {}) } : {}),
            ...(args.template ? { template: args.template } : {}),
            ...(args.parent_to_null ? { parent_to_null: true } : {}),
            ...(args.precompose ? { precompose: true } : {}),
            ...(mapping ? { mapping } : {}),
            remove_stale: removeStale,
            restyle: args.restyle === true,
            ...(args.allow_substitute ? { allow_substitute: true } : {}),
            label: `Captions (${captions.length})`,
          },
        },
        check: (_before, after, w) => captionsMismatches(args, removeStale, captions, after, w),
        present: (_before, after, w) => {
          const read = readOf(after);
          measured = read;
          const outside = outsideOf(read);
          const rail = (read?.captions ?? []).filter((e) => e.rail_overlap === true).map((e) => e.name);
          const substituted = (read?.captions ?? []).filter((e) => e.font_substituted).map((e) => e.name);
          const warnings = [...plan.warnings, ...(((w.warnings as string[] | undefined) ?? []))];
          if (outside.length) warnings.push(`${outside.length} caption${outside.length === 1 ? " runs" : "s run"} outside the safe area; ${(args.fit ?? "") === "none" ? "leave fit on to refit them, or " : ""}re-run with a smaller max_chars_per_line or font_size.`);
          if (rail.length) warnings.push(`${rail.length} caption${rail.length === 1 ? " reaches" : "s reach"} into the lower-right action rail (right of 72% of the width, below 44% of the height); shorten the lines or move the captions up.`);
          if (substituted.length) warnings.push("The font is substituted (not installed under that name); find an installed one with ae_fonts action search.");
          return {
            comp_id: args.comp_id,
            ...(w.target_comp_id !== undefined && w.target_comp_id !== args.comp_id ? { target_comp_id: w.target_comp_id } : {}),
            mode,
            name_prefix: prefix,
            ...(args.platform ? { platform: args.platform } : {}),
            count: captions.length,
            created: w.created,
            updated: w.updated,
            removed: w.removed,
            ...(w.names_truncated ? { created_count: w.created_count, updated_count: w.updated_count, removed_count: w.removed_count, names_truncated: true } : {}),
            ...(mapping ? { matched: mapping.length, renamed: w.renamed ?? 0 } : {}),
            highlight_keys: w.highlight_keys,
            boxes: w.boxes,
            ...(w.look ? { look: w.look } : {}),
            ...(w.looks_removed ? { looks_removed: w.looks_removed } : {}),
            ...(w.colored ? { colored: true } : {}),
            ...(w.word_layers !== undefined ? { word_layers: w.word_layers } : {}),
            ...(w.template ? { template: w.template } : {}),
            ...(w.control ? { control: w.control } : {}),
            ...(w.precomp ? { precomp: w.precomp } : {}),
            font_size: w.font_size,
            ...(w.font_check !== undefined ? { font_check: w.font_check } : {}),
            safe: w.safe,
            estimated_word_times: plan.estimated_word_times,
            outside_safe: outside,
            ...(rail.length ? { rail_overlap: rail } : {}),
            warnings,
            ...planFields(plan),
            preview: captions.slice(0, 10).map((c, i) => previewOf(c, first + i)),
          };
        },
      });
      if (tplFit) mergeTemplateFit(res as unknown as Record<string, unknown>, tplFit);
      // Fit: captions measured wider than the safe area are re-broken, then scaled (each step written, then measured again).
      const fitted = await fitCaptions(ctx, args, { mode, captions, first, measured, written: res as unknown as Record<string, unknown> });
      if (fitted) return fitted;
      // A failed read-back skips `present`; the plan's warnings and the estimate don't depend on it.
      const shown = res as unknown as Record<string, unknown>;
      if (shown.estimated_word_times === undefined) {
        const hostWarnings = Array.isArray(shown.warnings) ? (shown.warnings as string[]) : [];
        return { ...res, estimated_word_times: plan.estimated_word_times, warnings: [...plan.warnings, ...hostWarnings], ...planFields(plan) };
      }
      return res;
    },
  },
  {
    name: "ae_captions_read",
    description:
      "Read the caption layers a name_prefix finds in a comp (layers mode: '<prefix> 001'...; single mode: the one hold-keyed layer; words mode: '<prefix> 001.01'... grouped per caption with their word layers; template mode: the instances and the values of their Essential Properties): text, in and out, font, size, justification, highlight animator and its key counts, " +
      "each caption's text extents (sourceRectAtTime) against the safe area with `outside_safe`, `rail_overlap` for captions reaching a TikTok-style lower-right rail (tiktok_9_16, reels_9_16, or a 9:16 comp with no platform), and the background boxes' expression errors. " +
      "`platform` and layout.margins give the safe area (the same as for ae_captions). " +
      "Up to 500 captions (total_captions and truncated say more exist). Changes nothing in After Effects.",
    schema: AeCaptionsReadSchema,
    handler: async (args: ReadArgs, ctx: ToolContext) => {
      const res = await ctx.bridge.callHost("captionsRead", readArgsFor(args), {
        label: `ae_captions_read(${args.comp_id})`,
        mutates: false,
        toolName: "ae_captions_read",
      });
      return res.result;
    },
  },
];
