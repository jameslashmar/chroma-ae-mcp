/**
 * server/src/tools/ext/rqedit.ts
 *
 * Tools for the Render Queue items that already exist, plus a delivery spec
 * library:
 * - ae_render_queue_inspect: items with time span, render settings, output
 *   modules, their settings and the installed templates (read only)
 * - ae_render_queue_edit: time span, skip frames, log type, render settings,
 *   and per output module template, settings, file, post-render action; add
 *   and remove output modules
 * - ae_render_queue_duplicate: RenderQueueItem.duplicate() N times, each copy
 *   with its own template, file and settings
 * - ae_delivery_specs: the spec library (YouTube, Instagram, TikTok, LinkedIn,
 *   broadcast, ProRes master, PNG sequence, WAV, GIF) and which specs this AE
 *   can meet (read only)
 * - ae_render_queue_apply_spec: specs applied to the item and/or duplicates of
 *   it, file names from a template
 * - ae_check_delivery_file: a finished file against its spec's size limit and
 *   extension (Node only)
 *
 * What AE allows: the output module Format (and with it the codec and
 * bitrate) is read-only; it changes only through an output module template
 * already installed on this machine. A spec therefore picks a template from
 * the installed ones and refuses when none fits. The settings keys beyond
 * "Output File Info" and "Crop" come from a community dump, so each tool checks
 * them against the item's own getSettings(STRING_SETTABLE) and reads every
 * change back in a separate evalScript.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { runGuardedWrite, type HostCall } from "./write-runner.js";

// ---------- read-back shapes ----------

export interface ModuleRead {
  index: number;
  name?: string | null;
  file?: string | null;
  post_render_action?: string | null;
  include_source_xmp?: boolean | null;
  settings?: Record<string, unknown> | null;
  settings_error?: string;
  settings_truncated?: boolean;
  error?: string;
}

export interface ItemRead {
  index: number;
  comp_id: number;
  comp_name?: string;
  comp_width?: number;
  comp_height?: number;
  comp_duration?: number;
  work_area_start?: number;
  work_area_duration?: number;
  status?: string;
  render?: boolean;
  time_span_start?: number;
  time_span_duration?: number;
  skip_frames?: number;
  log_type?: string;
  num_output_modules?: number;
  output_modules?: ModuleRead[];
  output_modules_truncated?: boolean;
  render_settings_truncated?: boolean;
  render_settings?: Record<string, unknown> | null;
  render_settings_error?: string;
}

export interface QueueRead {
  numItems: number;
  render_settings_templates?: string[];
  output_module_templates?: string[];
  rendering?: boolean;
  truncated?: boolean;
  items: ItemRead[];
}

/** What the host says the item should read back as after its plan. */
export interface PlanEcho {
  time_span?: { start: number; duration: number };
  skip_frames?: number;
  log_type?: string;
  render_settings?: Record<string, unknown>;
  modules: Array<{
    index: number;
    /** The module's index while the plan ran (before removals renumbered the rest); the host's skipped entries name it. */
    plan_index?: number;
    file?: string;
    settings?: Record<string, unknown>;
    post_render_action?: string;
    include_source_xmp?: boolean;
  }>;
  num_output_modules: number;
}

interface Skipped {
  where?: string;
  key: string;
  reason?: string;
}

interface StepError {
  step: string;
  message: string;
}

const queueOf = (v: unknown): QueueRead | null => (v && typeof v === "object" && Array.isArray((v as QueueRead).items) ? (v as QueueRead) : null);
const itemOf = (q: QueueRead | null, index: unknown): ItemRead | undefined => q?.items.find((i) => i.index === index);

// ---------- delivery spec library ----------

export interface TemplateCandidate {
  pattern: string;
  flags?: string;
}

export interface DeliverySpec {
  id: string;
  label: string;
  description: string;
  container: "mp4" | "mov" | "png_sequence" | "wav" | "gif";
  ext: string;
  sequence?: boolean;
  /** Output module template name patterns, best first. The first installed match is used. */
  template_candidates: TemplateCandidate[];
  resize?: { width: number; height: number };
  channels?: "RGB" | "RGB + Alpha";
  audio_sample_rate?: number;
  video_output?: boolean;
  output_audio?: "On" | "Off" | "Auto";
  name_template: string;
  /** Approximate platform upload limit. Platforms change these; check the current figure before relying on it. */
  max_size_mb?: number;
  /** A spec this AE can never meet, and why. */
  refuse?: string;
  note?: string;
}

const H264 = (mbps: number): TemplateCandidate[] => [
  { pattern: `^H\\.264.*Match Render Settings.*\\b${mbps} ?Mbps`, flags: "i" },
  { pattern: "^H\\.264.*Match Render Settings", flags: "i" },
  { pattern: "^H\\.264", flags: "i" },
];

const SOCIAL_NOTE =
  "The bitrate comes from the template (AE ships H.264 15 and 40 Mbps ones); scripts can't set it. The size limit is approximate.";

export const SPEC_LIBRARY: DeliverySpec[] = [
  {
    id: "youtube_1080p",
    label: "YouTube 1080p",
    description: "H.264 MP4, 1920x1080, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(15),
    resize: { width: 1920, height: 1080 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    note: "YouTube re-encodes; this is the upload master. " + SOCIAL_NOTE,
  },
  {
    id: "youtube_4k",
    label: "YouTube 4K",
    description: "H.264 MP4, 3840x2160, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(40),
    resize: { width: 3840, height: 2160 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    note: SOCIAL_NOTE,
  },
  {
    id: "instagram_feed",
    label: "Instagram feed (4:5)",
    description: "H.264 MP4, 1080x1350, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(15),
    resize: { width: 1080, height: 1350 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    max_size_mb: 4096,
    note: SOCIAL_NOTE,
  },
  {
    id: "instagram_reels_story",
    label: "Instagram Reels / Story (9:16)",
    description: "H.264 MP4, 1080x1920, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(15),
    resize: { width: 1080, height: 1920 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    max_size_mb: 4096,
    note: SOCIAL_NOTE,
  },
  {
    id: "tiktok",
    label: "TikTok (9:16)",
    description: "H.264 MP4, 1080x1920, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(15),
    resize: { width: 1080, height: 1920 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    max_size_mb: 500,
    note: SOCIAL_NOTE,
  },
  {
    id: "linkedin_1080p",
    label: "LinkedIn 1080p",
    description: "H.264 MP4, 1920x1080, 48 kHz audio.",
    container: "mp4",
    ext: "mp4",
    template_candidates: H264(15),
    resize: { width: 1920, height: 1080 },
    channels: "RGB",
    audio_sample_rate: 48000,
    name_template: "[compName]_[spec].mp4",
    max_size_mb: 5120,
    note: SOCIAL_NOTE,
  },
  {
    id: "broadcast_hd",
    label: "Broadcast HD (ProRes 422 HQ)",
    description: "Apple ProRes 422 HQ MOV, 1920x1080.",
    container: "mov",
    ext: "mov",
    template_candidates: [{ pattern: "ProRes 422 HQ", flags: "i" }],
    resize: { width: 1920, height: 1080 },
    channels: "RGB",
    name_template: "[compName]_[spec].mov",
    note: "Needs a ProRes 422 HQ output module template on this machine (made in the Output Module dialog); refused without one. Frame rate follows the comp.",
  },
  {
    id: "broadcast_uhd",
    label: "Broadcast UHD (ProRes 422 HQ)",
    description: "Apple ProRes 422 HQ MOV, 3840x2160.",
    container: "mov",
    ext: "mov",
    template_candidates: [{ pattern: "ProRes 422 HQ", flags: "i" }],
    resize: { width: 3840, height: 2160 },
    channels: "RGB",
    name_template: "[compName]_[spec].mov",
    note: "Needs a ProRes 422 HQ output module template on this machine; refused without one.",
  },
  {
    id: "prores_422_hq_master",
    label: "ProRes 422 HQ master",
    description: "Apple ProRes 422 HQ MOV at the comp's size.",
    container: "mov",
    ext: "mov",
    template_candidates: [{ pattern: "ProRes 422 HQ", flags: "i" }],
    name_template: "[compName]_master.mov",
    note: "Needs a ProRes 422 HQ output module template on this machine; refused without one.",
  },
  {
    id: "png_sequence",
    label: "PNG sequence",
    description: "Numbered PNG frames at the comp's size, with alpha.",
    container: "png_sequence",
    ext: "png",
    sequence: true,
    template_candidates: [{ pattern: "^PNG Sequence", flags: "i" }, { pattern: "PNG", flags: "i" }],
    channels: "RGB + Alpha",
    video_output: true,
    name_template: "[compName]_[spec]_[#####].png",
    note: "Needs a PNG output module template on this machine. The folder should be empty: every frame is a file.",
  },
  {
    id: "wav_audio",
    label: "WAV audio only",
    description: "48 kHz WAV, no picture.",
    container: "wav",
    ext: "wav",
    template_candidates: [{ pattern: "\\bWAV\\b", flags: "i" }],
    video_output: false,
    audio_sample_rate: 48000,
    output_audio: "On",
    name_template: "[compName]_[spec].wav",
    note: "Needs a WAV output module template on this machine; refused without one.",
  },
  {
    id: "gif",
    label: "Animated GIF",
    description: "Not available: After Effects has no animated GIF output module.",
    container: "gif",
    ext: "gif",
    template_candidates: [],
    name_template: "[compName].gif",
    refuse: "After Effects has no animated GIF output module (Adobe moved GIF to Media Encoder and Photoshop). Use the png_sequence spec and convert the frames outside AE.",
  },
];

export const SPEC_IDS = SPEC_LIBRARY.map((s) => s.id) as [string, ...string[]];
export const specById = (id: string) => SPEC_LIBRARY.find((s) => s.id === id);

// ---------- name templates ----------

export const NAME_TOKENS = ["compName", "spec", "width", "height", "date", "copy"] as const;

/** Tokens in a file name template that the tool doesn't know (AE's [#####] frame number is fine). */
export function unknownNameTokens(tpl: string): string[] {
  const bad: string[] = [];
  for (const m of tpl.matchAll(/\[([^\]]*)\]/g)) {
    const t = m[1];
    if (/^#+$/.test(t)) continue;
    if ((NAME_TOKENS as readonly string[]).includes(t)) continue;
    bad.push(t);
  }
  return bad;
}

const isAbsolutePath = (p: string) => /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p);
export const pathKey = (p: string) => p.replace(/\\/g, "/").toLowerCase();

// ---------- setting values and comparison ----------

const toBool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (/^(on|true|yes|1)$/i.test(v.trim())) return true;
    if (/^(off|false|no|0)$/i.test(v.trim())) return false;
  }
  return undefined;
};

const numbersIn = (s: string): number[] => (s.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

const toNum = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = numbersIn(v)[0];
    if (n === undefined) return undefined;
    return /khz/i.test(v) ? n * 1000 : n;
  }
  return undefined;
};

/** The numbers in a size read-back: "W x H" text or an object (values may be strings: STRING_SETTABLE returns strings). Unreadable entries are undefined. */
function sizeNumbers(got: unknown): Array<number | undefined> {
  if (typeof got === "string") return numbersIn(got);
  if (got && typeof got === "object" && !Array.isArray(got)) {
    const o = got as Record<string, unknown>;
    if ("x" in o && "y" in o) return [toNum(o.x), toNum(o.y)];
    if ("width" in o && "height" in o) return [toNum(o.width), toNum(o.height)];
    return Object.values(o).map(toNum);
  }
  return [];
}

/** Is what AE reads back the value asked for? Types differ between the dump and the request (On/true, 48000/"48.000 kHz", [w, h]/"w x h"). */
export function sameSetting(want: unknown, got: unknown): boolean {
  if (got === undefined || got === null) return false;
  if (typeof want === "boolean") return toBool(got) === want;
  if (typeof want === "number") {
    const n = toNum(got);
    return n !== undefined && Math.abs(n - want) <= 1e-4 * Math.max(1, Math.abs(want));
  }
  if (Array.isArray(want)) {
    if (Array.isArray(got)) return got.length === want.length && want.every((w, i) => sameSetting(w, got[i]));
    return sizeNumbers(got).length >= want.length && want.every((w, i) => typeof w === "number" && sizeNumbers(got)[i] !== undefined && Math.abs((sizeNumbers(got)[i] as number) - w) <= 1e-4);
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return false;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) => sameSetting(v, (got as Record<string, unknown>)[k]));
  }
  if (typeof want === "string") {
    if (typeof got === "string") return got.trim().toLowerCase() === want.trim().toLowerCase();
    if (typeof got === "number") return String(got) === want.trim();
    if (typeof got === "boolean") return toBool(want) === got;
  }
  return false;
}

export function settingsMismatches(where: string, want: Record<string, unknown> | undefined, got: Record<string, unknown> | null | undefined, skip: Set<string>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!want) return m;
  for (const [key, value] of Object.entries(want)) {
    if (skip.has(key)) continue;
    if (!got) {
      m.push({ path: `${where}.${key}`, expected: value, actual: undefined, message: "The settings could not be read back" });
      continue;
    }
    if (!(key in got)) {
      m.push({ path: `${where}.${key}`, expected: value, actual: undefined, message: `AE does not list "${key}" in the read-back` });
    } else if (!sameSetting(value, got[key])) {
      m.push({ path: `${where}.${key}`, expected: value, actual: got[key], message: `"${key}" reads back differently (a format can adjust a size or rate it can't take)` });
    }
  }
  return m;
}

/** The host's per-step failures and skipped keys, as mismatches: the item is only partly as asked. */
export function stepMismatches(where: string, errors: StepError[] | undefined, skipped: Skipped[] | undefined): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  (errors ?? []).forEach((e, i) =>
    m.push({ path: `${where}.errors[${i}]`, expected: "the step to succeed", actual: e.message, message: `${e.step} failed: ${e.message}` })
  );
  (skipped ?? []).forEach((s, i) =>
    m.push({ path: `${where}.skipped[${i}]`, expected: s.key, actual: undefined, message: `"${s.key}" was not set: ${s.reason ?? "AE does not offer it"}` })
  );
  return m;
}

const TIME_TOL = 0.05;

/** Compares an item as read after a write with what its plan should have left. */
export function itemMismatches(where: string, echo: PlanEcho | undefined, item: ItemRead | undefined, skipped: Skipped[] | undefined): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!echo) return m;
  if (!item) {
    m.push({ path: where, expected: "the item in the read-back", actual: undefined, message: "The render queue item could not be read back" });
    return m;
  }
  // A key skipped on one output module (or the render settings) is still compared everywhere else.
  const skipAt = (suffix: string) => new Set((skipped ?? []).filter((s) => !s.where || s.where.endsWith(suffix)).map((s) => s.key));
  const ne = (ok: boolean, p: string, expected: unknown, actual: unknown, message: string) => {
    if (!ok) m.push({ path: `${where}.${p}`, expected, actual, message });
  };
  if (echo.time_span) {
    ne(item.time_span_start !== undefined && Math.abs(item.time_span_start - echo.time_span.start) <= TIME_TOL, "time_span.start", echo.time_span.start, item.time_span_start, "Time span start differs");
    ne(
      item.time_span_duration !== undefined && Math.abs(item.time_span_duration - echo.time_span.duration) <= TIME_TOL,
      "time_span.duration",
      echo.time_span.duration,
      item.time_span_duration,
      "Time span length differs"
    );
  }
  if (echo.skip_frames !== undefined) ne(item.skip_frames === echo.skip_frames, "skip_frames", echo.skip_frames, item.skip_frames, "Skip frames differs");
  if (echo.log_type !== undefined) ne(item.log_type === echo.log_type, "log_type", echo.log_type, item.log_type, "Log type differs");
  m.push(...settingsMismatches(`${where}.render_settings`, echo.render_settings, item.render_settings, skipAt(" render settings")));
  ne(item.num_output_modules === echo.num_output_modules, "num_output_modules", echo.num_output_modules, item.num_output_modules, "Output module count differs");
  for (const e of echo.modules) {
    const mod = item.output_modules?.find((o) => o.index === e.index);
    const p = `${where}.output_modules[${e.index}]`;
    if (!mod) {
      m.push({ path: p, expected: "the output module in the read-back", actual: undefined, message: `Output module ${e.index} could not be read back` });
      continue;
    }
    if (e.file !== undefined) ne(!!mod.file && pathKey(mod.file) === pathKey(e.file), `output_modules[${e.index}].file`, e.file, mod.file, "Output file differs");
    if (e.post_render_action !== undefined) {
      ne(mod.post_render_action === e.post_render_action, `output_modules[${e.index}].post_render_action`, e.post_render_action, mod.post_render_action, "Post-render action differs");
    }
    if (e.include_source_xmp !== undefined) {
      ne(mod.include_source_xmp === e.include_source_xmp, `output_modules[${e.index}].include_source_xmp`, e.include_source_xmp, mod.include_source_xmp, "Include source XMP differs");
    }
    m.push(...settingsMismatches(p, e.settings, mod.settings, skipAt(` output module ${e.plan_index ?? e.index}`)));
  }
  return m;
}

// ---------- schemas ----------

const ItemIndexSchema = z.number().int().min(1).max(500).describe("1-based position in the Render Queue (see ae_render_queue_inspect). The queue shifts when items are added or removed, so re-read it first.");
const ItemCompSchema = z
  .number()
  .int()
  .optional()
  .describe("Expected CompItem id of the queue item at item_index. The tool refuses when it is another comp (the queue changed under you).");

const SettingValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([z.string().max(200), z.number().finite()])).max(8),
  z.record(z.string(), z.union([z.string().max(2000), z.number().finite(), z.boolean()])),
]);

const SettingsMapSchema = z
  .record(z.string().min(1).max(100), SettingValueSchema)
  .refine((r) => Object.keys(r).length <= 40, { message: "At most 40 settings at once." })
  .refine((r) => !Object.keys(r).some((k) => k.trim().toLowerCase() === "format"), {
    message: "\"Format\" is read-only in After Effects. Change the format with an output module template.",
  });

const FileSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(isAbsolutePath, { message: "An absolute path is needed." })
  .describe("Absolute output file path. AE's [#####] frame token is kept for image sequences. The tool refuses a path another queued item uses, or one already on disk unless allow_overwrite is true.");

const POST_ACTIONS = ["none", "import", "import_and_replace_usage", "set_proxy"] as const;
const LOG_TYPES = ["errors_only", "errors_and_settings", "errors_and_per_frame_info"] as const;

const PostActionSchema = z.enum(POST_ACTIONS).describe("What AE does with the rendered file: nothing, import it, import it and replace the comp's usage, or set it as the comp's proxy.");

export const TimeSpanSchema = z
  .union([
    z.enum(["comp", "work_area"]),
    z.object({
      start: z.number().min(0).describe("Seconds from the comp's start."),
      duration: z.number().positive().describe("Seconds."),
    }),
  ])
  .describe("The time span to render: 'comp' (whole comp), 'work_area', or { start, duration } in seconds. Must end inside the comp.");

const ModuleBase = {
  template: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Output module template to apply first (this is the only way to change the format, codec or bitrate). Must be installed on this machine; the tool lists the installed ones when it isn't."),
  settings: SettingsMapSchema.optional().describe(
    "Output module settings by their STRING_SETTABLE key, e.g. 'Channels', 'Resize', 'Resize to' ([width, height]), 'Audio Sample Rate', 'Output File Info' ({ 'File Name': ... }). Keys are checked against ae_render_queue_inspect's dump before anything changes; values take the dump's type. Applied after the template."
  ),
  file: FileSchema.optional(),
  post_render_action: PostActionSchema.optional(),
  include_source_xmp: z.boolean().optional().describe("Include the source XMP metadata in the output file."),
};

const hasModuleChange = (m: { template?: unknown; settings?: unknown; file?: unknown; post_render_action?: unknown; include_source_xmp?: unknown }) =>
  [m.template, m.settings, m.file, m.post_render_action, m.include_source_xmp].some((v) => v !== undefined);

const ModuleEditSchema = z
  .object({ index: z.number().int().min(1).max(20).describe("1-based output module index."), ...ModuleBase })
  .refine(hasModuleChange, { message: "Each output module edit changes something." });

const ModuleAddSchema = z.object(ModuleBase).describe("A new output module (AE starts it from the default template).");

export const AeRenderQueueInspectSchema = z.object({
  item_index: ItemIndexSchema.optional().describe("One item, with its render settings and output module settings. Without it: every item, briefly."),
  settings: z.boolean().optional().describe("Dump the render settings and each output module's settings (the keys ae_render_queue_edit accepts). Default true with item_index, false without."),
  include_templates: z.boolean().optional().describe("List the installed render settings and output module templates for the item(s)."),
});

export const AeRenderQueueEditSchema = z
  .object({
    item_index: ItemIndexSchema,
    comp_id: ItemCompSchema,
    render_settings_template: z.string().min(1).max(200).optional().describe("Render settings template to apply first."),
    time_span: TimeSpanSchema.optional(),
    skip_frames: z.number().int().min(0).max(99).optional().describe("Frames to skip between rendered frames (0 renders every frame)."),
    log_type: z.enum(LOG_TYPES).optional(),
    render_settings: SettingsMapSchema.optional().describe(
      "Render settings by STRING_SETTABLE key (e.g. 'Quality', 'Resolution', 'Frame Rate'). Keys are checked before anything changes. Applied after render_settings_template."
    ),
    output_modules: z.array(ModuleEditSchema).max(20).optional().describe("Edits to existing output modules, by index."),
    add_output_modules: z.array(ModuleAddSchema).max(10).optional().describe("Output modules to add (one more deliverable from the same render)."),
    remove_output_modules: z.array(z.number().int().min(1).max(20)).max(20).optional().describe("Output modules to remove, by their index before this call. At least one must remain."),
    allow_overwrite: z.boolean().optional().describe("Allow an output file that already exists on disk."),
    expect: ExpectSchema,
  })
  .refine(
    (v) =>
      [v.render_settings_template, v.time_span, v.skip_frames, v.log_type, v.render_settings, v.output_modules, v.add_output_modules, v.remove_output_modules].some(
        (x) => x !== undefined
      ),
    { message: "Nothing to change: give at least one of the settings." }
  );

const CopySchema = z
  .object({
    output_module_template: z.string().min(1).max(200).optional().describe("Output module template for this copy's first output module."),
    render_settings_template: z.string().min(1).max(200).optional(),
    file: FileSchema.optional().describe("Output file of this copy's first output module. Required with output_module_template (the format decides the extension, and a PNG sequence needs [#####]). Default: the source's path with the next free _copyN before the extension (a duplicate may keep the source's path, which would render over it)."),
    settings: SettingsMapSchema.optional().describe("Settings for this copy's first output module (see ae_render_queue_edit)."),
    render_settings: SettingsMapSchema.optional(),
    time_span: TimeSpanSchema.optional(),
    skip_frames: z.number().int().min(0).max(99).optional(),
    log_type: z.enum(LOG_TYPES).optional(),
    post_render_action: PostActionSchema.optional(),
  })
  .refine((c) => c.output_module_template === undefined || c.file !== undefined, {
    message: "Give file together with output_module_template: the template can change the container, so the source's path (and its extension) cannot be reused.",
  })
  .describe("What differs in this copy.");

export const AeRenderQueueDuplicateSchema = z
  .object({
    item_index: ItemIndexSchema,
    comp_id: ItemCompSchema,
    count: z.number().int().min(1).max(20).optional().describe("Plain copies (each with the next free _copyN path, so a later call continues the numbering). Use copies for per-copy changes."),
    copies: z.array(CopySchema).min(1).max(20).optional(),
    allow_overwrite: z.boolean().optional().describe("Allow output files that already exist on disk."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.count === undefined) !== (v.copies === undefined), { message: "Give either count or copies." });

export const AeDeliverySpecsSchema = z.object({
  ids: z.array(z.enum(SPEC_IDS)).max(20).optional().describe("Only these specs. Default: all."),
  item_index: ItemIndexSchema.optional().describe("Judge the specs against this queue item (its installed templates and its comp's size). Default: queue item 1, templates and comp."),
  comp_id: z.number().int().optional().describe("Judge the aspect ratio against this comp."),
});

export const AeApplySpecSchema = z
  .object({
    item_index: ItemIndexSchema,
    comp_id: ItemCompSchema,
    specs: z.array(z.enum(SPEC_IDS)).min(1).max(12).describe("Spec ids from ae_delivery_specs. One output per spec."),
    output_folder: z.string().min(1).max(1000).refine(isAbsolutePath, { message: "An absolute path is needed." }).describe("Folder the files go in. It should exist; the tool warns when it doesn't."),
    file_name: z
      .string()
      .min(1)
      .max(300)
      .refine((t) => unknownNameTokens(t).length === 0, { message: `Unknown token. Use ${NAME_TOKENS.map((t) => `[${t}]`).join(", ")} (and AE's [#####] for sequences).` })
      .optional()
      .describe("File name template; default each spec's own, like '[compName]_[spec].mp4'. A name without an extension gets the spec's; another media extension (like .mp4 on a ProRes spec) is replaced by the spec's."),
    in_place: z.boolean().optional().describe("Default true: the first spec is applied to the item itself and the rest to duplicates of it. False: every spec gets a duplicate and the item is left as it is. A DONE item is locked by AE, so it defaults to false and in_place: true is refused."),
    allow_stretch: z.boolean().optional().describe("Apply a spec whose aspect ratio differs from the comp's (the picture stretches). Default false: refused."),
    allow_overwrite: z.boolean().optional().describe("Allow output files that already exist on disk."),
    settings: SettingsMapSchema.optional().describe("Extra output module settings for every spec."),
    post_render_action: PostActionSchema.optional(),
    expect: ExpectSchema,
  })
  .refine((v) => new Set(v.specs).size === v.specs.length, { message: "A spec is listed twice." })
  .refine((v) => v.specs.length < 2 || v.file_name === undefined || /\[(spec|copy|width|height)\]/.test(v.file_name), {
    message: "With several specs the file name template needs [spec], [copy], [width] or [height] so the files differ.",
  });

export const AeCheckDeliveryFileSchema = z.object({
  spec_id: z.enum(SPEC_IDS),
  file_path: z.string().min(1).max(1000).describe("The finished file (for a PNG sequence, any one frame)."),
});

// ---------- tools ----------

type EditArgs = z.infer<typeof AeRenderQueueEditSchema>;
type DuplicateArgs = z.infer<typeof AeRenderQueueDuplicateSchema>;
type ApplyArgs = z.infer<typeof AeApplySpecSchema>;

const readCall = (indexes: number[] | undefined, settings: boolean): HostCall => ({
  host: "rqeditRead",
  args: { item_indexes: indexes, settings },
});

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function editMismatches(args: EditArgs, _before: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const after = queueOf(afterRaw);
  const where = `item[${args.item_index}]`;
  const m = stepMismatches(where, asArray<StepError>(written.errors), asArray<Skipped>(written.skipped));
  if (!after) return m;
  m.push(...itemMismatches(where, written.expect as PlanEcho | undefined, itemOf(after, args.item_index), asArray<Skipped>(written.skipped)));
  if (args.comp_id !== undefined) {
    const it = itemOf(after, args.item_index);
    if (it && it.comp_id !== args.comp_id) m.push({ path: `${where}.comp_id`, expected: args.comp_id, actual: it.comp_id, message: "The item at this index is another comp now" });
  }
  return m;
}

/** Copies of the source made by a duplicate or spec call: queue growth and each copy's read-back. */
export function copiesMismatches(
  kind: string,
  beforeRaw: unknown,
  afterRaw: unknown,
  entries: Array<Record<string, unknown>>,
  compId: unknown
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = queueOf(beforeRaw);
  const after = queueOf(afterRaw);
  const made = entries.filter((e) => typeof e.item_index === "number" && e.in_place !== true).length;
  entries.forEach((e, i) => {
    const where = `${kind}[${i + 1}]`;
    m.push(...stepMismatches(where, asArray<StepError>(e.errors), asArray<Skipped>(e.skipped)));
    if (typeof e.item_index !== "number") {
      m.push({ path: where, expected: "a duplicate", actual: undefined, message: "The item could not be duplicated, or its place in the queue could not be found" });
    }
  });
  if (!after) return m;
  if (before) {
    const grown = after.numItems - before.numItems;
    if (grown !== made) m.push({ path: "numItems", expected: before.numItems + made, actual: after.numItems, message: "The queue did not grow by the number of copies" });
  }
  entries.forEach((e, i) => {
    if (typeof e.item_index !== "number") return;
    const where = `${kind}[${i + 1}]`;
    const it = itemOf(after, e.item_index);
    m.push(...itemMismatches(where, e.expect as PlanEcho | undefined, it, asArray<Skipped>(e.skipped)));
    if (it && typeof compId === "number" && it.comp_id !== compId) {
      m.push({ path: `${where}.comp_id`, expected: compId, actual: it.comp_id, message: "The copy is another comp than the source" });
    }
  });
  // Two items to one file overwrite each other.
  const touched = new Set<number>(entries.map((e) => e.item_index).filter((n): n is number => typeof n === "number"));
  const seen = new Map<string, { label: string; index: number }>();
  for (const it of after.items) {
    if (it.status === "done") continue;
    for (const o of it.output_modules ?? []) {
      if (!o.file || /\[#+\]/.test(o.file)) continue;
      const key = pathKey(o.file);
      const other = seen.get(key);
      const here = `item ${it.index} output ${o.index}`;
      if (other && (touched.has(it.index) || touched.has(other.index))) {
        m.push({ path: `items[${it.index}]`, expected: "distinct output files", actual: o.file, message: `${here} and ${other.label} write the same file` });
      }
      if (!other) seen.set(key, { label: here, index: it.index });
    }
  }
  return m;
}

/** The read after a duplicate or spec call: the whole queue briefly (so a copy on another item's path shows), with settings for the items it made or edited. */
const afterCopiesRead = (entries: unknown): HostCall => {
  const idx = asArray<Record<string, unknown>>(entries)
    .map((e) => e.item_index)
    .filter((n): n is number => typeof n === "number");
  if (!idx.length) return readCall(undefined, false);
  return { host: "rqeditRead", args: { item_indexes: undefined, settings: false, settings_indexes: [...new Set(idx)] } };
};

export function checkDeliveryFile(spec: DeliverySpec, filePath: string): { ok: boolean; exists: boolean; size_bytes: number; size_mb: number; issues: string[] } {
  const issues: string[] = [];
  let size = 0;
  let exists = false;
  try {
    const st = fs.statSync(filePath);
    exists = st.isFile();
    size = st.size;
  } catch {
    exists = false;
  }
  if (!exists) {
    issues.push("The file does not exist.");
  } else {
    if (size === 0) issues.push("The file is empty.");
    const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
    if (ext !== spec.ext) issues.push(`The extension is .${ext}, the spec's is .${spec.ext}.`);
    if (spec.max_size_mb !== undefined && size > spec.max_size_mb * 1024 * 1024) {
      issues.push(`The file is ${(size / 1048576).toFixed(1)} MB, over the spec's approximate ${spec.max_size_mb} MB limit.`);
    }
  }
  return { ok: issues.length === 0, exists, size_bytes: size, size_mb: Math.round((size / 1048576) * 100) / 100, issues };
}

const editHostArgs = (a: EditArgs) => ({
  item_index: a.item_index,
  item_comp_id: a.comp_id,
  item_template: a.render_settings_template,
  time_span: a.time_span,
  skip_frames: a.skip_frames,
  log_type: a.log_type,
  render_settings: a.render_settings,
  modules: a.output_modules,
  add_modules: a.add_output_modules,
  remove_modules: a.remove_output_modules,
  allow_overwrite: a.allow_overwrite,
  label: `Edit render queue item ${a.item_index}`,
});

export const rqeditTools: ToolDefinition<any>[] = [
  {
    name: "ae_render_queue_inspect",
    description:
      "Read Render Queue items: comp, status, time span, skip frames, log type, output modules (file, post-render action) and, with settings, the render settings and each output module's settings by their STRING_SETTABLE key (the keys ae_render_queue_edit takes), with include_templates the installed templates. Changes nothing. " +
      "The output module Format is shown but cannot be set by script; only a template changes it.",
    schema: AeRenderQueueInspectSchema,
    handler: async (args: z.infer<typeof AeRenderQueueInspectSchema>, ctx) => {
      const res = await ctx.bridge.callHost(
        "rqeditRead",
        {
          item_indexes: args.item_index !== undefined ? [args.item_index] : undefined,
          settings: args.settings ?? args.item_index !== undefined,
          include_templates: args.include_templates === true,
        },
        { label: "ae_render_queue_inspect", mutates: false, toolName: "ae_render_queue_inspect" }
      );
      return res.result;
    },
  },
  {
    name: "ae_render_queue_edit",
    description:
      "Edit an item already in the Render Queue, in one undo group guarded by `expect`: render settings template, time span (comp, work area or start/duration), skip frames, log type, render settings, and per output module the template, settings, output file, post-render action and XMP; add or remove output modules. " +
      "A DONE item is refused (AE locks its settings; duplicate it instead). Everything is checked before AE changes: templates must be installed, setting keys must be ones the item offers (ae_render_queue_inspect lists them), \"Format\" is read-only (use a template), the time span must fit the comp, and an output file must not be another queued item's or already on disk (allow_overwrite). A step that fails inside AE is reported in `errors`, not thrown. " +
      "The read-back (a separate evalScript) compares every change; a format can adjust a size or rate it can't take, and that shows as a mismatch. A template itself can't be read back. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueEditSchema,
    handler: (args: EditArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_render_queue_edit",
        label: `ae_render_queue_edit(item ${args.item_index})`,
        expect: args.expect,
        read: () => readCall([args.item_index], true),
        write: { host: "rqeditEdit", args: editHostArgs(args) },
        check: (before, after, w) => editMismatches(args, before, after, w),
        present: (_b, after, w) => ({
          item_index: args.item_index,
          item: itemOf(queueOf(after), args.item_index),
          steps_done: w.steps_done,
          skipped: w.skipped,
          errors: w.errors,
          warnings: w.warnings,
          added_modules: w.added_modules,
          removed_modules: w.removed_modules,
        }),
      }),
  },
  {
    name: "ae_render_queue_duplicate",
    description:
      "Duplicate a Render Queue item N times (RenderQueueItem.duplicate), each copy with its own output module template, output file and settings, in one undo group guarded by `expect`: H.264 plus ProRes plus a PNG sequence from one comp. " +
      "A duplicate may keep the source's output path and render over it, so every copy gets its own file (yours, or the source's with the next free _copyN) and the tool refuses a path already queued or on disk. A copy with an output_module_template needs its own file. A finished item's copy is queued again. " +
      "The read-back (a separate evalScript) checks the queue grew by the copies, each copy's settings and that no copy writes the same file as another unfinished item in the queue. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueDuplicateSchema,
    handler: (args: DuplicateArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_render_queue_duplicate",
        label: `ae_render_queue_duplicate(item ${args.item_index} x${args.count ?? args.copies?.length ?? 0})`,
        expect: args.expect,
        read: (phase, w) => (phase === "before" ? readCall(undefined, false) : afterCopiesRead(w?.copies)),
        write: {
          host: "rqeditDuplicate",
          args: {
            item_index: args.item_index,
            item_comp_id: args.comp_id,
            copies: args.copies ?? Array.from({ length: args.count ?? 0 }, () => ({})),
            allow_overwrite: args.allow_overwrite,
            label: `Duplicate render queue item ${args.item_index}`,
          },
        },
        check: (before, after, w) => copiesMismatches("copy", before, after, asArray<Record<string, unknown>>(w.copies), w.comp_id).concat(stepMismatches("duplicate", asArray<StepError>(w.errors), [])),
        present: (_b, after, w) => {
          const q = queueOf(after);
          const copies = asArray<Record<string, unknown>>(w.copies);
          return {
            source_index: w.source_index,
            copies: copies.map((c) => ({ ...c, expect: undefined, item: itemOf(q, c.item_index) })),
            errors: w.errors,
          };
        },
      }),
  },
  {
    name: "ae_delivery_specs",
    description:
      "The delivery spec library (YouTube 1080p/4K, Instagram feed and Reels/Story, TikTok, LinkedIn, broadcast HD/UHD and ProRes 422 HQ master, PNG sequence, WAV, GIF) and which of them this After Effects can meet for a queue item: the installed output module template each would use, and why a spec is refused (no matching template, the comp's aspect ratio, GIF). Changes nothing. " +
      "Specs pick an installed template (AE can't set format, codec or bitrate by script) and set size, channels and audio around it; the bitrate is whatever the template carries. Apply with ae_render_queue_apply_spec.",
    schema: AeDeliverySpecsSchema,
    handler: async (args: z.infer<typeof AeDeliverySpecsSchema>, ctx) => {
      const specs = args.ids ? SPEC_LIBRARY.filter((s) => args.ids!.includes(s.id)) : SPEC_LIBRARY;
      const res = await ctx.bridge.callHost(
        "rqeditSpecs",
        { specs, item_index: args.item_index, comp_id: args.comp_id },
        { label: "ae_delivery_specs", mutates: false, toolName: "ae_delivery_specs" }
      );
      const host = (res.result ?? {}) as Record<string, unknown>;
      const verdicts = asArray<Record<string, unknown>>(host.specs);
      return {
        templates_known: host.templates_known,
        templates_from: host.templates_from,
        comp: host.comp,
        output_module_templates: host.output_module_templates,
        specs: specs.map((s) => ({ ...s, template_candidates: undefined, ...(verdicts.find((v) => v.id === s.id) ?? {}), id: s.id })),
      };
    },
  },
  {
    name: "ae_render_queue_apply_spec",
    description:
      "Apply delivery specs (ae_delivery_specs) to a Render Queue item, one output per spec, in one undo group guarded by `expect`: the output module template is picked from the installed ones, then size (Resize), channels, audio and the output file (from a name template: [compName], [spec], [width], [height], [date], [copy]). " +
      "By default the first spec edits the item and the others are duplicates of it (a DONE item is locked by AE, so every spec goes on a duplicate). A spec this AE can't meet is refused before anything changes, with the reason (no matching template, GIF, the comp's aspect ratio would stretch unless allow_stretch, an existing file unless allow_overwrite). The item must have exactly one output module. " +
      "The read-back (a separate evalScript) checks each item's file and settings; bitrate and codec come from the template and can't be read back. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeApplySpecSchema,
    handler: (args: ApplyArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_render_queue_apply_spec",
        label: `ae_render_queue_apply_spec(item ${args.item_index}: ${args.specs.join(", ")})`,
        expect: args.expect,
        read: (phase, w) => (phase === "before" ? readCall(undefined, false) : afterCopiesRead(w?.results)),
        write: {
          host: "rqeditApplySpec",
          args: {
            item_index: args.item_index,
            item_comp_id: args.comp_id,
            specs: args.specs.map((id) => specById(id)),
            output_folder: args.output_folder,
            file_name: args.file_name,
            in_place: args.in_place,
            allow_stretch: args.allow_stretch,
            allow_overwrite: args.allow_overwrite,
            settings: args.settings,
            post_render_action: args.post_render_action,
            label: `Apply delivery specs to render queue item ${args.item_index}`,
          },
        },
        check: (before, after, w) => {
          const results = asArray<Record<string, unknown>>(w.results);
          // In-place results are the item itself, which the queue count doesn't include.
          return copiesMismatches("spec", before, after, results, w.comp_id);
        },
        present: (_b, after, w) => {
          const q = queueOf(after);
          return {
            source_index: w.source_index,
            in_place: w.in_place,
            results: asArray<Record<string, unknown>>(w.results).map((r) => ({ ...r, expect: undefined, item: itemOf(q, r.item_index) })),
          };
        },
      }),
  },
  {
    name: "ae_check_delivery_file",
    description:
      "Check a finished render against its delivery spec: the file exists and isn't empty, has the spec's extension and is under the spec's approximate size limit (Node fs.stat). Codec, bitrate and dimensions aren't checked here; ae_verify_render imports the file and checks size, frame rate and audio. Changes nothing.",
    schema: AeCheckDeliveryFileSchema,
    handler: async (args: z.infer<typeof AeCheckDeliveryFileSchema>) => {
      const spec = specById(args.spec_id)!;
      return { spec_id: spec.id, file_path: args.file_path, ...checkDeliveryFile(spec, args.file_path), max_size_mb: spec.max_size_mb ?? null };
    },
  },
];
