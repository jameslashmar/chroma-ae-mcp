/**
 * server/src/tools/ext/brief.ts
 *
 * Context that makes results land the first time:
 * - ae_brief: the project's brief (goal, audience, format, feel, references,
 *   brand, what not to touch), kept next to the .aep as <name>.brief.json so
 *   it travels with the project. Missing fields come back with questions to
 *   ask, ready for ae_ask_user.
 *   import_swatches reads a client .ase palette through After Effects
 *   (app.parseSwatchFile) and offers it as brand colours.
 * - ae_taste: the user's own motion taste, kept across projects in
 *   settings.json; ae_motion_review follows it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import type { ToolContext, ToolDefinition } from "../common.js";
import { MotionSpecSchema, resolveMotionSpec, type ResolvedMotionSpec } from "../../motion-spec.js";

// ---------- swatches (.ase) ----------

export interface SwatchValue {
  type: string;
  r?: number;
  g?: number;
  b?: number;
  c?: number;
  m?: number;
  y?: number;
  k?: number;
  L?: number;
  a?: number;
  value?: number;
}

export interface SwatchColor {
  hex: string;
  /** True for CMYK and LAB: converted without ICC profiles. */
  approximate: boolean;
  /** LAB only: the colour was outside sRGB and was clamped. */
  out_of_gamut?: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, "0")).join("");

const encodeSrgb = (lin: number) => {
  const c = clamp01(lin);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

/** CIELAB (D50, L 0..100) to sRGB through Bradford-adapted D50 sRGB primaries. */
export function labToSrgb(L: number, a: number, b: number): { rgb: [number, number, number]; out_of_gamut: boolean } {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const finv = (f: number) => (f * f * f > eps ? f * f * f : (116 * f - 16) / kappa);
  const X = 0.9642 * finv(fx);
  const Y = L > kappa * eps ? Math.pow((L + 16) / 116, 3) : L / kappa;
  const Z = 0.8249 * finv(fz);
  const rl = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const gl = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const out = [rl, gl, bl].some((c) => c < -0.002 || c > 1.002);
  return { rgb: [encodeSrgb(rl), encodeSrgb(gl), encodeSrgb(bl)], out_of_gamut: out };
}

/**
 * One swatch to #rrggbb. RGB and Gray are exact; CMYK (naive) and LAB are flagged
 * approximate. Returns a reason string for a swatch that can't be converted.
 */
export function swatchToColor(v: SwatchValue): SwatchColor | string {
  switch (v.type) {
    case "RGB":
      if (!isNum(v.r) || !isNum(v.g) || !isNum(v.b)) return "RGB swatch is missing r, g or b";
      return { hex: toHex(v.r, v.g, v.b), approximate: false };
    case "Gray":
      if (!isNum(v.value)) return "Gray swatch has no value";
      return { hex: toHex(v.value, v.value, v.value), approximate: false };
    case "CMYK": {
      if (!isNum(v.c) || !isNum(v.m) || !isNum(v.y) || !isNum(v.k)) return "CMYK swatch is missing c, m, y or k";
      const k = 1 - clamp01(v.k);
      return { hex: toHex((1 - clamp01(v.c)) * k, (1 - clamp01(v.m)) * k, (1 - clamp01(v.y)) * k), approximate: true };
    }
    case "LAB": {
      if (!isNum(v.L) || !isNum(v.a) || !isNum(v.b)) return "LAB swatch is missing L, a or b";
      const { rgb, out_of_gamut } = labToSrgb(clamp01(v.L) * 100, v.a, v.b);
      return { hex: toHex(rgb[0], rgb[1], rgb[2]), approximate: true, ...(out_of_gamut ? { out_of_gamut: true } : {}) };
    }
    default:
      return `swatch type '${v.type}' is not supported (only RGB, CMYK, LAB and Gray)`;
  }
}

export interface SwatchImport {
  swatches: Array<{ index: number; type: string; hex: string; approximate: boolean; out_of_gamut?: boolean }>;
  /** Unique colours in file order, lower-case #rrggbb. */
  colors: string[];
  duplicates_removed: number;
  skipped: Array<{ index: number; type: string; reason: string }>;
  approximate_count: number;
}

/** Converts parsed swatches, drops duplicates (first one wins) and lists what could not be converted. Indexes are 1-based file order. */
export function convertSwatches(values: SwatchValue[]): SwatchImport {
  const swatches: SwatchImport["swatches"] = [];
  const skipped: SwatchImport["skipped"] = [];
  const seen = new Set<string>();
  let dupes = 0;
  values.forEach((v, i) => {
    const c = swatchToColor(v);
    if (typeof c === "string") {
      skipped.push({ index: i + 1, type: String(v.type), reason: c });
      return;
    }
    if (seen.has(c.hex)) {
      dupes++;
      return;
    }
    seen.add(c.hex);
    swatches.push({ index: i + 1, type: v.type, ...c });
  });
  return {
    swatches,
    colors: swatches.map((s) => s.hex),
    duplicates_removed: dupes,
    skipped,
    approximate_count: swatches.filter((s) => s.approximate).length,
  };
}

/** Adds `incoming` to the existing brand colours: existing ones stay as they are, new ones are appended up to `max`. */
export function mergeBrandColors(existing: string[], incoming: string[], max = 12) {
  const have = new Set(existing.map((c) => c.toLowerCase()));
  const merged = [...existing];
  const added: string[] = [];
  const already_present: string[] = [];
  const not_added: string[] = [];
  for (const c of incoming) {
    if (have.has(c.toLowerCase())) already_present.push(c);
    else if (merged.length >= max) not_added.push(c);
    else {
      merged.push(c);
      have.add(c.toLowerCase());
      added.push(c);
    }
  }
  return { merged, added, already_present, not_added };
}

const MAX_SWATCH_FILE_BYTES = 5 * 1024 * 1024;

/** Checks a swatch file path on the Node side before After Effects is asked to read it. */
export function checkSwatchPath(file: string): string | null {
  if (!path.isAbsolute(file)) return "The swatch path must be absolute.";
  if (path.extname(file).toLowerCase() !== ".ase") return "The swatch file must be an Adobe Swatch Exchange file (.ase).";
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return "No file at that path.";
  }
  if (!st.isFile()) return "That path is not a file.";
  if (st.size === 0) return "The swatch file is empty.";
  if (st.size > MAX_SWATCH_FILE_BYTES) return `The swatch file is larger than ${MAX_SWATCH_FILE_BYTES / (1024 * 1024)} MB.`;
  return null;
}

// ---------- brief ----------

export const BriefFieldsSchema = z.object({
  goal: z.string().max(1000).optional().describe("What the piece is for and the one thing it must get across."),
  audience: z.string().max(500).optional().describe("Who watches it, and where (platform, screen)."),
  format: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      duration_s: z.number().positive().optional(),
    })
    .optional()
    .describe("Delivery size, frame rate and length."),
  feel: z.array(z.string().min(1).max(40)).max(6).optional().describe("A few words for the feel, e.g. ['confident', 'clean', 'snappy']."),
  references: z.array(z.string().min(1).max(500)).max(20).optional().describe("Links, file paths, or descriptions of work to match."),
  brand_colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb"))
    .max(12)
    .optional()
    .describe("Brand colours as #rrggbb."),
  fonts: z.array(z.string().min(1).max(100)).max(6).optional(),
  do_not_change: z.array(z.string().min(1).max(300)).max(20).optional().describe("Layers, comps or decisions to leave alone."),
  notes: z.string().max(4000).optional(),
  motion: MotionSpecSchema.optional(),
});

export type BriefFields = z.infer<typeof BriefFieldsSchema>;
export type Brief = BriefFields & { updated_at?: string };

export const AeBriefSchema = z
  .object({
    set: BriefFieldsSchema.optional().describe(
      "Fields to save. Omitted fields keep their value; an empty string or list clears one. Save only what the user said or confirmed."
    ),
    import_swatches: z
      .object({
        path: z.string().min(1).max(1000).describe("Absolute path to an Adobe Swatch Exchange (.ase) file."),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "false (default): only list the colours the file holds, to show the user (ae_ask_user) and get a yes. true: add them to brand_colors (existing colours stay; new ones are appended up to the limit of 12)."
          ),
      })
      .optional()
      .describe(
        "Read a client .ase palette through After Effects and offer its colours as #rrggbb for brand_colors. RGB and Gray are exact; CMYK and LAB are converted without colour profiles and flagged approximate. " +
          "The file holds no colour names, so the colours are numbered in file order. Nothing is saved until confirm is true."
      ),
    expect: z
      .object({ project_path: z.string().min(1) })
      .optional()
      .describe("Required with `set` or `import_swatches.confirm`: the open project's path, so the brief lands next to the right .aep."),
  })
  .refine((v) => (!v.set && v.import_swatches?.confirm !== true) || v.expect !== undefined, { message: "Saving a brief needs expect.project_path." });

const BRIEF_FIELDS = ["goal", "audience", "format", "feel", "references", "brand_colors", "fonts", "do_not_change"] as const;

/** Questions for missing fields, shaped for ae_ask_user where a choice fits and for the chat otherwise. */
export const BRIEF_QUESTIONS: Record<(typeof BRIEF_FIELDS)[number], { question: string; options?: Array<{ id: string; label: string }>; multi_select?: boolean }> = {
  goal: { question: "What is this piece for, and what is the one thing it must get across?" },
  audience: {
    question: "Who will watch it, and where?",
    options: [
      { id: "social_vertical", label: "Social, vertical (Reels, TikTok, Shorts)" },
      { id: "web_16x9", label: "YouTube or web, 16:9" },
      { id: "broadcast", label: "Broadcast or TV" },
      { id: "event", label: "Event screen or presentation" },
    ],
  },
  format: { question: "What size, frame rate and length should it be delivered at?" },
  feel: {
    question: "Which words fit the feel?",
    options: [
      { id: "calm", label: "Calm" },
      { id: "energetic", label: "Energetic" },
      { id: "playful", label: "Playful" },
      { id: "premium", label: "Premium" },
      { id: "technical", label: "Technical" },
      { id: "bold", label: "Bold" },
    ],
    multi_select: true,
  },
  references: { question: "Is there any work (links or files) it should feel like?" },
  brand_colors: { question: "Which brand colours should it use (hex codes)?" },
  fonts: { question: "Which fonts should it use?" },
  do_not_change: { question: "Is there anything I must leave alone?" },
};

export function briefPath(projectPath: string): string {
  return path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}.brief.json`);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function readBrief(file: string): Brief | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Brief) : null;
  } catch {
    return null;
  }
}

/** Merges `patch` into `current`; empty values clear a field. */
export function mergeBrief(current: Brief | null, patch: BriefFields, now: Date): Brief {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (isEmpty(v)) delete next[k];
    else next[k] = v;
  }
  next.updated_at = now.toISOString();
  return next as Brief;
}

export function missingFields(brief: Brief | null) {
  return BRIEF_FIELDS.filter((f) => isEmpty(brief?.[f]));
}

/**
 * The open project's motion spec, filled from its register's defaults. Never throws: with no
 * project, no brief or an unreadable one it returns the brand_film defaults (from_brief empty).
 * Checks call it for their thresholds.
 */
export async function loadMotionSpec(ctx: ToolContext): Promise<ResolvedMotionSpec & { brief_path: string | null }> {
  let file: string | null = null;
  try {
    const projectPath = await openProjectPath(ctx);
    if (projectPath) file = briefPath(projectPath);
  } catch {
    file = null;
  }
  const brief = file ? readBrief(file) : null;
  const parsed = MotionSpecSchema.safeParse(brief?.motion ?? {});
  return { ...resolveMotionSpec(parsed.success ? parsed.data : null), brief_path: brief ? file : null };
}

export async function openProjectPath(ctx: ToolContext): Promise<string> {
  const res = await ctx.bridge.evalRaw<{ project_path: string }>({
    id: `${ctx.bridge.newOpId()}_brief_status`,
    script: buildJsxCall("status", {}),
    label: "ae_brief (project path)",
    mutates: false,
    toolName: "ae_brief",
  });
  return res.result.project_path;
}

/** Reads an .ase file through After Effects and converts it; never throws. */
async function parseSwatches(file: string, ctx: ToolContext) {
  const bad = checkSwatchPath(file);
  if (bad) return { ok: false as const, error: "bad_swatch_file", message: bad };
  let raw: { majorVersion?: number | null; minorVersion?: number | null; count?: number; truncated?: boolean; values?: SwatchValue[] };
  try {
    const res = await ctx.bridge.callHost<typeof raw>("briefParseSwatches", { path: file }, { label: "ae_brief (parse swatches)", mutates: false, toolName: "ae_brief" });
    raw = res.result;
  } catch (err) {
    return { ok: false as const, error: "swatch_parse_failed", message: err instanceof Error ? err.message : String(err) };
  }
  const conv = convertSwatches(raw.values ?? []);
  const report: Record<string, unknown> = {
    path: file,
    ase_version: raw.majorVersion != null ? `${raw.majorVersion}.${raw.minorVersion ?? 0}` : undefined,
    swatch_count: raw.count ?? (raw.values ?? []).length,
    ...(raw.truncated ? { truncated: true } : {}),
    colors: conv.colors,
    swatches: conv.swatches,
    duplicates_removed: conv.duplicates_removed,
    skipped: conv.skipped,
    approximate_count: conv.approximate_count,
    confirmed: false,
    note:
      "The .ase file holds no colour names, so the colours are numbered in file order (swatches[].index). CMYK and LAB are converted without colour profiles: approximate." +
      (conv.colors.length > 12 ? " brand_colors holds at most 12 colours: only the first free slots are filled." : ""),
    next: "Show these colours to the user (ae_ask_user) and, on a yes, call ae_brief again with import_swatches.confirm true and expect.project_path.",
  };
  return { ok: true as const, report, colors: conv.colors };
}

// ---------- taste ----------

export const AeTasteSchema = z.object({
  set: z
    .object({
      // Deliberately not EASE_CURVE_ARRAY_SCHEMA/MIN_HANDLE-bounded: [0, 0, 1, 1] (x1=0,
      // x2=1) is a meaningful "clear to linear" sentinel here, checked by isLinear() below
      // before it's ever applied as a curve - the tighter apply-time bound would reject it.
      preferred_ease: z
        .array(z.number())
        .length(4)
        .refine((c) => c[0] >= 0 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1, { message: "curve x1 and x2 must be within 0..1" })
        .optional()
        .describe("The user's default cubic-bezier [x1, y1, x2, y2], e.g. the one they picked with ae_ask_user. [0, 0, 1, 1] (linear) clears it."),
      allow_linear_non_motion: z
        .boolean()
        .optional()
        .describe("Linear timing on opacity and effect parameters is on purpose: the review stops flagging it."),
      avoid_overshoot: z.boolean().optional().describe("The user doesn't want overshoot: the review reports it as low instead of info."),
      notes: z.string().max(2000).optional().describe("What the user has said about their taste, in their words. Replaces the earlier notes."),
    })
    .optional()
    .describe("Fields to change. Save only what the user said or confirmed."),
});

function isLinear(c: number[]): boolean {
  return c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;
}

// ---------- tools ----------

export const briefTools: ToolDefinition<any>[] = [
  {
    name: "ae_brief",
    description:
      "Read or save the open project's brief: goal, audience, format, feel, references, brand colours and fonts, and what not to change. It lives next to the .aep as <name>.brief.json, so it travels with the project. " +
      "Call it at the start of any creative job. The result lists `missing` fields with `questions`; ask the ones that matter for the task, choices through ae_ask_user (pass the question and options as given) and open questions in the chat, then save the answers with `set`. " +
      "Respect `do_not_change` in everything you do. Unsaved projects have no brief until they are saved. Never touches the AE project. " +
      "`import_swatches` {path, confirm} reads a client .ase palette through After Effects and lists its colours as #rrggbb (RGB and Gray exact, CMYK and LAB approximate, no names, so they are numbered); show them to the user with ae_ask_user, then repeat with confirm true to merge them into brand_colors (existing colours are kept, 12 at most).",
    schema: AeBriefSchema,
    handler: async (args: z.infer<typeof AeBriefSchema>, ctx) => {
      const projectPath = await openProjectPath(ctx);
      const imp = args.import_swatches;
      const writes = !!args.set || imp?.confirm === true;
      const previewOnly = !!imp && !writes;
      if (projectPath === "<unsaved>" && !previewOnly) {
        return {
          ok: false,
          error: "unsaved_project",
          message: "The project has not been saved, so there is nowhere to keep a brief yet. Ask the user to save it (or keep the brief in the chat for now).",
        };
      }
      const file = projectPath === "<unsaved>" ? null : briefPath(projectPath);
      let brief = file ? readBrief(file) : null;
      let saved = false;
      if (writes && normalizeGuardPath(args.expect!.project_path) !== normalizeGuardPath(projectPath)) {
        return {
          ok: false,
          error: "guard",
          message: `The open project is ${projectPath}, not ${args.expect!.project_path}. Re-read state; nothing was saved.`,
        };
      }
      let swatchReport: Record<string, unknown> | undefined;
      let importColors: string[] | undefined;
      if (imp) {
        const parsed = await parseSwatches(imp.path, ctx);
        if (!parsed.ok) return parsed;
        swatchReport = parsed.report;
        importColors = parsed.colors;
      }
      if (args.set) brief = mergeBrief(brief, args.set, new Date());
      if (imp?.confirm && importColors) {
        const merge = mergeBrandColors(brief?.brand_colors ?? [], importColors);
        brief = mergeBrief(brief, { brand_colors: merge.merged }, new Date());
        swatchReport = { ...swatchReport, confirmed: true, added: merge.added, already_present: merge.already_present, not_added: merge.not_added };
      }
      if (writes && file && brief) {
        const tmp = `${file}.tmp-${process.pid}`;
        // Match settings.ts/quarantine.ts's tmp+rename stores: restrictive permissions,
        // not the process umask default.
        fs.writeFileSync(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
        saved = true;
      }
      const missing = missingFields(brief);
      return {
        ok: true,
        project_path: projectPath,
        brief_path: file,
        exists: brief !== null,
        saved,
        brief,
        missing,
        questions: missing.map((field) => ({ field, ...BRIEF_QUESTIONS[field] })),
        ...(swatchReport ? { swatch_import: swatchReport } : {}),
      };
    },
  },
  {
    name: "ae_taste",
    description:
      "Read or change the user's motion taste, kept across projects: a preferred ease curve, whether linear opacity and effect timing is deliberate, whether overshoot is unwanted, and notes in their words. " +
      "ae_motion_review follows it (its fixes use the preferred curve's handle lengths). Read it before animating so first passes already match. " +
      "Change it only on the user's word: after they pick an ease with ae_ask_user, ask whether it should become their default. Call with no arguments to read.",
    schema: AeTasteSchema,
    handler: async (args: z.infer<typeof AeTasteSchema>, ctx) => {
      if (!ctx.settings) {
        return { ok: false, error: "no_settings", message: "This server has no settings store, so taste can't be kept." };
      }
      let saved = false;
      if (args.set) {
        const patch = { ...args.set };
        if (patch.preferred_ease && isLinear(patch.preferred_ease)) {
          (patch as { preferred_ease: number[] | null }).preferred_ease = null;
        }
        ctx.settings.updateTaste(patch);
        saved = true;
      }
      return { ok: true, saved, taste: ctx.settings.get().taste, settings_path: ctx.settings.path };
    },
  },
];
