/**
 * server/src/tools/ext/inventory.ts
 *
 * Project inventory:
 * - ae_comp_tree: which comps nest which, where a comp is used, top-level and
 *   unused comps (render queue membership included). Read-only.
 * - ae_fonts: the fonts text layers use (keyframed source text too), who uses
 *   them, and which are missing or substituted (AE 24+; `missing_known`
 *   says when AE couldn't tell). Also search (installed fonts), check
 *   (exists, substitute, glyphs for a real string) and replace
 *   (Project.replaceFont, AE 24.5: the one write; not undoable, so it is
 *   checkpointed first and read back).
 */

import * as fs from "node:fs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard, type AutoCheckpointResult } from "../mutate.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

export const AeCompTreeSchema = z.object({
  comp_id: z
    .number()
    .int()
    .optional()
    .describe("Show this comp's tree: what it contains, down, and where it is used, up. Default: an overview of every comp."),
  depth: z.number().int().min(1).max(50).optional().describe("How many levels to follow (default 10)."),
});

const FontRefSchema = z
  .union([
    z.string().min(1).max(200).describe("A PostScript name."),
    z.object({ family: z.string().min(1).max(200), style: z.string().min(1).max(200) }),
  ])
  .describe('A font: a PostScript name ("Arial-BoldMT"), or { family, style } ("Arial", "Bold").');
export type FontRef = z.infer<typeof FontRefSchema>;

export const FONT_ACTIONS = ["in_use", "search", "check", "replace", "check_files"] as const;

export const AeFontsSchema = z
  .object({
    action: z
      .enum(FONT_ACTIONS)
      .optional()
      .describe(
        "in_use (default): the fonts the project's text layers use. search: find installed fonts. check: do these fonts exist, are they substituted, do they have the glyphs for this text. " +
          "replace: swap one font for another project-wide (a write: Project.replaceFont, AE 24.5, is NOT undoable). " +
          "check_files: every installed font's file checked on disk (missing, empty, unreadable, not a font), to find the fonts behind After Effects' \"Unknown BIB Error. cannot access font\" warnings."
      ),
    comp_id: z.number().int().optional().describe("in_use: only this comp's text layers. Default: the whole project."),
    missing_only: z.boolean().optional().describe("in_use: list only fonts known to be missing or substituted. Fonts whose state AE couldn't report are left out and counted in unknown_state."),
    query: z.string().max(200).optional().describe("search: matches the PostScript, family, style or full name, or their native names (case, spaces and dashes ignored)."),
    family: z.string().max(200).optional().describe("search: the family name contains this."),
    style: z.string().max(200).optional().describe('search: the style name contains this ("bold", "italic").'),
    writing_script: z
      .string()
      .max(60)
      .optional()
      .describe("search: only fonts that support this script (roman, cyrillic, greek, arabic, hebrew, japanese, chinese_simplified, ...). Whether a font has Turkish letters is a glyph question: use check with text."),
    variable_only: z.boolean().optional().describe("search: only variable fonts (with design axes)."),
    adobe_only: z.boolean().optional().describe("search: only fonts that come from Adobe Fonts."),
    page: z.number().int().min(1).optional().describe("search: page number, from 1."),
    page_size: z.number().int().min(1).max(100).optional().describe("search: fonts per page (default 25, at most 100)."),
    fonts: z.array(FontRefSchema).min(1).max(50).optional().describe("check: the fonts to check (up to 50)."),
    text: z.string().max(20000).optional().describe("check: the real string the fonts must show (for example a Turkish caption). Missing characters are listed, with AE's default font for their script."),
    from: FontRefSchema.optional().describe("replace: the font to replace. It may be a font that is missing (substituted): the project's own list is searched for it."),
    to: FontRefSchema.optional().describe("replace: the installed font that takes its place."),
    no_font_locking: z
      .boolean()
      .optional()
      .describe("replace: AE's noFontLocking (default false). With true, missing glyphs cannot be detected; a substituted `from` font with identical properties ignores it."),
    dry_run: z
      .boolean()
      .optional()
      .describe("replace: default true: only report the layers that would change and any glyphs the new font lacks. Pass false to replace; it needs expect and a usable checkpoint."),
    expect: ExpectSchema.optional().describe("replace with dry_run false: the target guard."),
  })
  .superRefine((v, ctx) => {
    const action = v.action ?? "in_use";
    if (action === "check" && !v.fonts) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fonts"], message: "check needs fonts." });
    if (action === "replace") {
      if (!v.from) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "replace needs from." });
      if (!v.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "replace needs to." });
      if (v.dry_run === false && !v.expect) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expect"], message: "replace with dry_run false needs expect (the target guard)." });
    }
  });

// ---------- pure logic ----------

/** One font of the used-fonts read (host inventoryUsedFonts). */
export interface UsedFont {
  postscript?: string;
  family?: string;
  style?: string;
  is_substitute?: boolean;
  /** Distinct layers. */
  layer_count: number;
  /** Layer-and-time uses (Project.usedFonts usedAt.length). */
  uses?: number;
  /** One record per use, at most 100: where the font is used (layer id and layer times). */
  layers?: Array<{ layer_id?: number; times?: number[] }>;
}

export interface UsedFontsRead {
  supported: boolean;
  reason?: string;
  fonts: UsedFont[];
  truncated?: boolean;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s\-_]+/g, "");

/** Does a used font match a font reference (PostScript name, or family and style)? */
export function fontMatches(font: UsedFont, ref: FontRef): boolean {
  if (typeof ref === "string") return font.postscript === ref;
  return norm(font.family) === norm(ref.family) && norm(font.style) === norm(ref.style);
}

/** Why a replace must not go ahead on this checkpoint, or null when the checkpoint can restore the project. */
export function checkpointRefusal(cp: AutoCheckpointResult): string | null {
  if (cp.status === "skipped") {
    return `Replacing a font cannot be undone, and no checkpoint was made (${cp.reason ?? "checkpoints are off"}). Save the project with ae_save and turn automatic checkpoints on with ae_auto_checkpoint, then try again.`;
  }
  if (cp.unsaved_changes_not_included) {
    return "Replacing a font cannot be undone, and the project has unsaved changes the checkpoint would not hold (it copies the saved .aep). Save it first with ae_save, then try again.";
  }
  return null;
}

/** The read-back checks of a replace: the old font is gone from the project's used fonts, the new one is there and not substituted. */
export function replaceMismatches(before: UsedFontsRead | null, after: UsedFontsRead | null, from: FontRef, to: FontRef): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after || !after.supported) {
    m.push({ path: "used_fonts", expected: "a read of Project.usedFonts", actual: after?.reason ?? null, message: "The used fonts could not be read back, so the replace is not verified" });
    return m;
  }
  const fromLeft = after.fonts.find((f) => fontMatches(f, from));
  expectThat(m, !fromLeft, "from", "no layer uses the old font", fromLeft ? { layer_count: fromLeft.layer_count } : null, "The old font is still used after the replace");
  const toNow = after.fonts.find((f) => fontMatches(f, to));
  expectThat(m, !!toNow, "to", "the new font is used", null, "The new font is not among the project's used fonts after the replace");
  if (toNow) expectThat(m, toNow.is_substitute !== true, "to.is_substitute", false, toNow.is_substitute, "After Effects substitutes the new font");
  const was = before?.fonts.find((f) => fontMatches(f, from));
  if (was && toNow) {
    // Compare locations (layer id and layer time), not counts: a layer that already used `to` is listed once after the replace.
    const capped = (f: UsedFont) => (f.uses ?? f.layer_count) > (f.layers?.length ?? 0);
    if (!capped(was) && !capped(toNow) && was.layers && toNow.layers) {
      const key = (l: { layer_id?: number; times?: number[] }, t: number | undefined) => `${l.layer_id}@${t ?? ""}`;
      const keys = (f: UsedFont, byLayer: boolean) => {
        const set = new Set<string>();
        for (const l of f.layers ?? []) {
          if (byLayer || !l.times || l.times.length === 0) set.add(key(l, undefined));
          else for (const t of l.times) set.add(key(l, t));
        }
        return set;
      };
      // Times are layer times the host reports; when either side lacks them, compare layers only.
      const hasTimes = (f: UsedFont) => (f.layers ?? []).every((l) => l.times && l.times.length > 0);
      const byLayer = !(hasTimes(was) && hasTimes(toNow));
      const after = keys(toNow, byLayer);
      const lost = [...keys(was, byLayer)].filter((k) => !after.has(k));
      expectThat(m, lost.length === 0, "to.locations", "every place the old font was used now uses the new font", lost.slice(0, 20), "Some places that used the old font do not use the new font afterwards");
    }
  }
  return m;
}

const REPLACE_NOTES = [
  "Replacing a font is not undoable: Edit > Undo (Ctrl+Z) does not restore it; ae_checkpoint_revert with the checkpoint does.",
  "With no_font_locking, missing glyphs cannot be detected. A substituted from-font with identical properties ignores noFontLocking. In a document with mixed fonts only the ranges that used the old font change.",
];

async function replaceCheckpoint(ctx: ToolContext, expect: { project_path: string; comp_id?: number }): Promise<AutoCheckpointResult> {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  try {
    return await ctx.queue.run("ae_fonts replace (checkpoint)", async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expect, opId);
      return autoCheckpoint(ctx, guard, "ae_fonts");
    });
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

async function replaceFonts(args: z.infer<typeof AeFontsSchema>, ctx: ToolContext) {
  const from = args.from as FontRef;
  const to = args.to as FontRef;
  const planRes = await ctx.bridge.callHost<Record<string, unknown> & { ok?: boolean; from_used?: boolean; glyphs?: unknown }>(
    "inventoryReplacePlan",
    { from, to },
    { label: "ae_fonts replace (plan)", mutates: false, toolName: "ae_fonts" }
  );
  const plan = planRes.result;
  const dry = args.dry_run !== false;
  if (plan.ok === false) return { ...plan, action: "replace", dry_run: dry, applied: false };
  if (dry) {
    return {
      action: "replace",
      dry_run: true,
      applied: false,
      ...plan,
      notes: REPLACE_NOTES,
      next: plan.from_used ? "Run again with dry_run: false and expect to replace; a checkpoint is made first and the result is read back." : undefined,
    };
  }
  if (plan.from_used === false) return { action: "replace", dry_run: false, applied: false, no_op: true, ...plan };
  const expect = args.expect as { project_path: string; comp_id?: number };
  // Mandatory: Project.replaceFont is not undoable, so a checkpoint that can restore the project must exist first.
  const cp = await replaceCheckpoint(ctx, expect);
  const refusal = checkpointRefusal(cp);
  if (refusal) return { ok: false, action: "replace", applied: false, error: "checkpoint_required", message: refusal, checkpoint: cp };
  const res = await runGuardedWrite<Record<string, unknown>>(ctx, {
    toolName: "ae_fonts",
    label: "ae_fonts(replace)",
    expect,
    read: () => ({ host: "inventoryUsedFonts", args: { fonts: [from, to] } }),
    write: { host: "inventoryReplaceFont", args: { from, to, no_font_locking: args.no_font_locking === true, label: "Replace font" } },
    // Only the host's pre-write no-ops (unused font, same font) skip the check; a replaceFont that returned false (layers_changed false) is still verified and fails because "from" is still used.
    check: (b, a, w) => ((w.no_op === true || w.replaced === false) && w.layers_changed !== false ? [] : replaceMismatches(b as UsedFontsRead | null, a as UsedFontsRead | null, from, to)),
    // Project.replaceFont is not undoable: no Ctrl+Z step to list.
    undoable: false,
  });
  const shown = res as unknown as Record<string, unknown>;
  return { action: "replace", dry_run: false, ...shown, glyphs: plan.glyphs, notes: REPLACE_NOTES };
}

/** Each host call scans for about 2.5 s; the server goes on from where it stopped, up to this long in all. */
export const FONT_SEARCH_BUDGET_MS = 60_000;
const FONT_SEARCH_MAX_CHUNKS = 200;

interface FontSearchChunk {
  available?: boolean;
  fonts?: unknown[];
  total_matches?: number;
  scanned?: number;
  scan_truncated?: boolean;
  next_family?: number | null;
  next_font?: number | null;
  family_count?: number;
  [k: string]: unknown;
}

/**
 * ae_fonts search over the whole font list. The host stops after about 2.5 s so AE stays responsive
 * and other calls can run in between; this goes on from `next_family` until the list is done.
 * (Before, the search stopped at the first cut: on a PC with many fonts that was about 100 fonts,
 * and a font further down, such as Arial, was reported as not installed. PR #19.)
 */
export async function searchFonts(args: z.infer<typeof AeFontsSchema>, ctx: ToolContext, budgetMs = FONT_SEARCH_BUDGET_MS) {
  const pageSize = Math.min(100, Math.max(1, Math.floor(args.page_size ?? 25)));
  const page = Math.max(1, Math.floor(args.page ?? 1));
  const skip = (page - 1) * pageSize;
  const base = {
    query: args.query,
    family: args.family,
    style: args.style,
    writing_script: args.writing_script,
    variable_only: args.variable_only,
    adobe_only: args.adobe_only,
    page,
    page_size: pageSize,
  };
  const started = Date.now();
  const fonts: unknown[] = [];
  let matches = 0;
  let scanned = 0;
  let chunks = 0;
  let startFamily = 0;
  let startFont = 0;
  let first: FontSearchChunk | null = null;
  let truncated = false;
  for (;;) {
    const res = await ctx.bridge.callHost<FontSearchChunk>(
      "inventorySearchFonts",
      { ...base, start_family: startFamily, start_font: startFont, skip: Math.max(0, skip - matches), take: pageSize - fonts.length },
      { label: "ae_fonts(search)", mutates: false, toolName: "ae_fonts" }
    );
    const r = res.result;
    chunks++;
    if (first === null) first = r;
    if (r.available === false) return r;
    fonts.push(...(r.fonts ?? []));
    matches += r.total_matches ?? 0;
    scanned += r.scanned ?? 0;
    const nextFamily = typeof r.next_family === "number" ? r.next_family : null;
    const nextFont = typeof r.next_font === "number" ? r.next_font : 0;
    // Only go on when the host moved forward: an older host has no next_family.
    const moved = nextFamily !== null && (nextFamily > startFamily || (nextFamily === startFamily && nextFont > startFont));
    if (r.scan_truncated !== true || !moved) {
      truncated = r.scan_truncated === true;
      break;
    }
    if (Date.now() - started >= budgetMs || chunks >= FONT_SEARCH_MAX_CHUNKS) {
      truncated = true;
      break;
    }
    startFamily = nextFamily as number;
    startFont = nextFont;
  }
  const out: Record<string, unknown> = {
    ...(first ?? {}),
    available: true,
    fonts,
    page,
    page_size: pageSize,
    total_matches: matches,
    has_more: matches > skip + fonts.length,
    scanned,
    scan_truncated: truncated,
    scan_calls: chunks,
    font_ids_session_only: true,
  };
  delete out.next_family;
  delete out.next_font;
  delete out.note;
  if (truncated) {
    out.note =
      `The font list was only partly scanned (${scanned} fonts in ${Math.round((Date.now() - started) / 1000)} s); ` +
      "a font not listed may still be installed: narrow the search (family, or an exact PostScript name with action check) for a sure answer.";
  }
  return out;
}


// ---------- check_files: fonts whose file AE cannot open ----------

const FONT_SIGNATURES = [Buffer.from([0, 1, 0, 0]), Buffer.from("OTTO"), Buffer.from("true"), Buffer.from("typ1"), Buffer.from("ttcf"), Buffer.from("wOFF"), Buffer.from("wOF2")];

export type FontFileProblem = "no_location" | "missing" | "not_a_file" | "empty" | "unreadable" | "not_a_font";

/**
 * What is wrong with a font's file on disk, or null. The TrueType/OpenType signature is checked only for
 * .ttf/.otf/.ttc/.otc files that do not come from Adobe Fonts (those are stored in Adobe's own form).
 */
export function fontFileProblem(location: string | null, adobe: boolean | null): { problem: FontFileProblem; detail: string } | null {
  if (!location) return { problem: "no_location", detail: "After Effects gives no file for this font." };
  let st: fs.Stats;
  try {
    st = fs.statSync(location);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT" || code === "ENOTDIR") return { problem: "missing", detail: "The file is not there (deleted, moved, or on a drive that is not connected)." };
    return { problem: "unreadable", detail: `The file cannot be read (${code || (e as Error).message}).` };
  }
  if (!st.isFile()) return { problem: "not_a_file", detail: "The path is not a file." };
  if (st.size === 0) return { problem: "empty", detail: "The file is empty (0 bytes)." };
  let head = Buffer.alloc(0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(location, "r");
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    head = buf.subarray(0, n);
  } catch (e) {
    return { problem: "unreadable", detail: `The file cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  if (adobe !== true && /\.(ttf|otf|ttc|otc)$/i.test(location) && !FONT_SIGNATURES.some((sig) => head.length === 4 && head.equals(sig))) {
    return { problem: "not_a_font", detail: `The file does not start like a TrueType or OpenType font (first bytes ${head.toString("hex") || "none"}).` };
  }
  return null;
}

interface FontFileRow {
  postscript: string | null;
  family: string | null;
  style: string | null;
  location: string | null;
  adobe: boolean | null;
}

const FONT_FILES_NOTE =
  "After Effects shows \"Unknown BIB Error. cannot access font\" when its font engine (CoolType) cannot open a font file it has listed, the first time something reads that font in a session. " +
  "For each font listed: install it again from a good copy, or remove it (Windows: Settings > Personalization > Fonts; macOS: Font Book); for an Adobe Fonts font, turn it off and on again in the Creative Cloud app. " +
  "Then, with After Effects closed, delete Adobe's font cache files AdobeFnt*.lst (Windows: under %LOCALAPPDATA%\\Adobe\\TypeSupport and the CT Font Cache folders under %APPDATA%\\Adobe); After Effects builds them again on start. " +
  "A font whose file is intact but damaged inside is not caught here: the warning, when it comes, is about the font AE was reading.";

/**
 * ae_fonts check_files: every installed font's file, checked on disk by the server (the host only lists
 * names and paths, in steps like the search). Finds the fonts behind AE's "cannot access font" warnings.
 */
export async function checkFontFiles(ctx: ToolContext, budgetMs = FONT_SEARCH_BUDGET_MS) {
  const started = Date.now();
  const rows: FontFileRow[] = [];
  let startFamily = 0;
  let startFont = 0;
  let calls = 0;
  let truncated = false;
  for (;;) {
    const res = await ctx.bridge.callHost<{ available?: boolean; reason?: string; fonts?: FontFileRow[]; scan_truncated?: boolean; next_family?: number | null; next_font?: number | null }>(
      "inventoryFontFiles",
      { start_family: startFamily, start_font: startFont },
      { label: "ae_fonts(check_files)", mutates: false, toolName: "ae_fonts" }
    );
    const r = res.result;
    calls++;
    if (r.available === false) return { available: false, reason: r.reason, action: "check_files" };
    rows.push(...(r.fonts ?? []));
    const nf = typeof r.next_family === "number" ? r.next_family : null;
    const nfo = typeof r.next_font === "number" ? r.next_font : 0;
    const moved = nf !== null && (nf > startFamily || (nf === startFamily && nfo > startFont));
    if (r.scan_truncated !== true || !moved) {
      truncated = r.scan_truncated === true;
      break;
    }
    if (Date.now() - started >= budgetMs || calls >= FONT_SEARCH_MAX_CHUNKS) {
      truncated = true;
      break;
    }
    startFamily = nf as number;
    startFont = nfo;
  }
  const byPath = new Map<string, ReturnType<typeof fontFileProblem>>();
  const problems: Array<FontFileRow & { problem: FontFileProblem; detail: string }> = [];
  const counts: Partial<Record<FontFileProblem, number>> = {};
  // No file is not a fault: measured on AE 26.3 (Windows, 824 fonts) these were the named instances of a
  // variable font (Cascadia Code Italic weights) and Windows' bitmap .fon fonts (Courier, MS Sans Serif, System).
  const withoutFile: string[] = [];
  for (const row of rows) {
    if (!row.location) {
      withoutFile.push(row.postscript ?? `${row.family ?? "?"} ${row.style ?? ""}`.trim());
      continue;
    }
    const key = row.location ? `${row.location}|${row.adobe === true}` : "";
    let p = key ? byPath.get(key) : undefined;
    if (p === undefined) {
      p = fontFileProblem(row.location, row.adobe);
      if (key) byPath.set(key, p);
    }
    if (!p) continue;
    counts[p.problem] = (counts[p.problem] ?? 0) + 1;
    if (problems.length < 200) problems.push({ ...row, problem: p.problem, detail: p.detail });
  }
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return {
    available: true,
    action: "check_files",
    fonts: rows.length,
    files: byPath.size,
    adobe_fonts: rows.filter((r) => r.adobe === true).length,
    problem_fonts: total,
    problem_counts: counts,
    problems,
    ...(total > problems.length ? { problems_listed: problems.length } : {}),
    ...(withoutFile.length
      ? {
          without_file: { count: withoutFile.length, fonts: withoutFile.slice(0, 30), note: "AE gives no file for these, which is normal for the named instances of a variable font and for Windows' bitmap (.fon) fonts; they are not counted as problems." },
        }
      : {}),
    scan_truncated: truncated,
    scan_calls: calls,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    note: total > 0 ? FONT_FILES_NOTE : "Every font file After Effects lists is there and readable. " + FONT_FILES_NOTE,
  };
}

// ---------- tools ----------

export const inventoryTools: ToolDefinition<any>[] = [
  {
    name: "ae_comp_tree",
    description:
      "Read how comps nest. Without comp_id: every comp with how many comps use it, how many it contains, its nesting depth and whether it is in the render queue (used_in counts distinct comps, used_by_layers counts layers), " +
      "plus the top-level comps (used nowhere, but rendered or containing others) and the unused ones (used nowhere, containing nothing, not queued); " +
      "both are null when partial is true (the layer scan was cut short, so they can't be told). " +
      "With comp_id: what that comp contains, level by level (with the layers that hold each precomp), and where it is used, up to the top (one entry per parent comp, with its layers). Read-only.",
    schema: AeCompTreeSchema,
    handler: async (args: z.infer<typeof AeCompTreeSchema>, ctx) => {
      const res = await ctx.bridge.callHost("compTree", { comp_id: args.comp_id, depth: args.depth }, {
        label: "ae_comp_tree",
        mutates: false,
        toolName: "ae_comp_tree",
      });
      return res.result;
    },
  },
  {
    name: "ae_fonts",
    description:
      "Fonts. action in_use (the default): list the fonts the project's text layers use (each keyframe of animated source text counts), with the family, style, file location, how many uses and which layers, " +
      "and whether AE is substituting the font because it is missing (AE 24+; missing_known is false when AE couldn't say). " +
      "skipped_layers counts text layers that could not be fully read (each counted once). Check them against the brief's fonts (ae_brief) before a delivery. " +
      "action search: find installed fonts by query, family, style, writing_script, variable_only or adobe_only (paged, at most 100 per page; the whole font list is scanned in short steps, up to a minute, and scan_truncated says if it was cut short, in which case a font not listed may still be installed): PostScript name, family, style, native names, location, Adobe Fonts, variable axes. " +
      "A font's fontID is stable only within one AE session. " +
      "action check: for each of `fonts` (PostScript names or { family, style }) say whether it exists, whether AE would substitute it, duplicates, variable axes and, with `text`, which characters it lacks (AE 25.1+; Turkish s-cedilla, g-breve, dotless i, dotted I), " +
      "with AE's default font for the script of what is missing; fonts that do not exist come with near matches. It also lists the project's missing or substituted fonts. " +
      "action replace: swap `from` for `to` in every text layer (Project.replaceFont, AE 24.5). It is NOT undoable, so: dry_run (the default) lists the layers it would change and the glyphs the new font lacks for their text; " +
      "dry_run false needs `expect`, makes a checkpoint first and REFUSES if none can be made or the project has unsaved changes (ae_save first, or turn automatic checkpoints on), then reads the project's used fonts back (old font gone, new font used and not substituted). " +
      "Restore from the checkpoint to undo. With no_font_locking missing glyphs cannot be detected; mixed-font text changes only the ranges that used the old font. " +
      "action check_files: every installed font's file checked on disk (missing, empty, unreadable, not a TrueType/OpenType file) with the font's names and path, and how to fix them: the fonts behind After Effects' \"Unknown BIB Error. cannot access font\" warnings. If AE shows that warning while this runs, answer it with OK (ae_dialogs, ae_dialog_respond). " +
      "in_use, search, check, check_files and dry-run replace are read-only. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeFontsSchema,
    handler: async (args: z.infer<typeof AeFontsSchema>, ctx) => {
      const action = args.action ?? "in_use";
      if (action === "search") return searchFonts(args, ctx);
      if (action === "check_files") return checkFontFiles(ctx);
      if (action === "check") {
        const res = await ctx.bridge.callHost<{ checked?: Array<{ exists: boolean | null; is_substitute: boolean | null; glyphs?: { supported: boolean | null } }> }>(
          "inventoryCheckFonts",
          { fonts: args.fonts, text: args.text },
          { label: "ae_fonts(check)", mutates: false, toolName: "ae_fonts" }
        );
        const r = res.result;
        const list = r.checked ?? [];
        const problems = list.filter((c) => c.exists === false || c.is_substitute === true || c.glyphs?.supported === false).length;
        return { ...r, problems };
      }
      if (action === "replace") return replaceFonts(args, ctx);

      const res = await ctx.bridge.callHost<{ fonts: Array<{ missing: boolean | null }>; [k: string]: unknown }>(
        "fontsInUse",
        { comp_id: args.comp_id },
        { label: "ae_fonts", mutates: false, toolName: "ae_fonts" }
      );
      const r = res.result;
      if (!args.missing_only) return r;
      // Only fonts known to be missing; say how many were left out because AE couldn't tell.
      const unknown = r.fonts.filter((f) => f.missing === null || f.missing === undefined).length;
      const out: Record<string, unknown> = { ...r, fonts: r.fonts.filter((f) => f.missing === true), unknown_state: unknown };
      if (unknown > 0) out.note = `${unknown} font(s) have an unknown state (AE couldn't say) and are not listed; they may be missing.`;
      return out;
    },
  },
];
