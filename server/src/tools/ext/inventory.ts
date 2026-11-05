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

export const FONT_ACTIONS = ["in_use", "search", "check", "replace"] as const;

export const AeFontsSchema = z
  .object({
    action: z
      .enum(FONT_ACTIONS)
      .optional()
      .describe(
        "in_use (default): the fonts the project's text layers use. search: find installed fonts. check: do these fonts exist, are they substituted, do they have the glyphs for this text. " +
          "replace: swap one font for another project-wide (a write: Project.replaceFont, AE 24.5, is NOT undoable)."
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
      "action search: find installed fonts by query, family, style, writing_script, variable_only or adobe_only (paged, at most 100 per page; the scan is bounded and says when it was cut short): PostScript name, family, style, native names, location, Adobe Fonts, variable axes. " +
      "A font's fontID is stable only within one AE session. " +
      "action check: for each of `fonts` (PostScript names or { family, style }) say whether it exists, whether AE would substitute it, duplicates, variable axes and, with `text`, which characters it lacks (AE 25.1+; Turkish s-cedilla, g-breve, dotless i, dotted I), " +
      "with AE's default font for the script of what is missing; fonts that do not exist come with near matches. It also lists the project's missing or substituted fonts. " +
      "action replace: swap `from` for `to` in every text layer (Project.replaceFont, AE 24.5). It is NOT undoable, so: dry_run (the default) lists the layers it would change and the glyphs the new font lacks for their text; " +
      "dry_run false needs `expect`, makes a checkpoint first and REFUSES if none can be made or the project has unsaved changes (ae_save first, or turn automatic checkpoints on), then reads the project's used fonts back (old font gone, new font used and not substituted). " +
      "Restore from the checkpoint to undo. With no_font_locking missing glyphs cannot be detected; mixed-font text changes only the ranges that used the old font. " +
      "in_use, search, check and dry-run replace are read-only. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeFontsSchema,
    handler: async (args: z.infer<typeof AeFontsSchema>, ctx) => {
      const action = args.action ?? "in_use";
      if (action === "search") {
        const res = await ctx.bridge.callHost(
          "inventorySearchFonts",
          {
            query: args.query,
            family: args.family,
            style: args.style,
            writing_script: args.writing_script,
            variable_only: args.variable_only,
            adobe_only: args.adobe_only,
            page: args.page,
            page_size: args.page_size,
          },
          { label: "ae_fonts(search)", mutates: false, toolName: "ae_fonts" }
        );
        return res.result;
      }
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
