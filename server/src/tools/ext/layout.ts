/**
 * server/src/tools/ext/layout.ts
 *
 * - ae_align: align layers to the comp, the safe areas or their own box, or
 *   distribute their centres evenly (2D, unparented layers)
 * - ae_purge_unused: footage, solids and placeholders no comp uses, and
 *   empty folders; a dry run by default
 * - ae_export_mogrt: export a comp's Essential Graphics template as .mogrt
 *   from the saved project, checked on disk
 * - ae_house_style_check: a comp against the brief's fonts and brand colours,
 *   missing fonts, small text and the title-safe area
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { fontMatches, isNeutral, nearestBrand, rgbToHex, type Rgb } from "../../style.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { briefPath, readBrief, salvageMotionSpec, type Brief } from "./brief.js";
import { minTextPx, PLATFORM_PRESET_IDS, PLATFORM_PRESETS, resolveMotionSpec, safeRect, type PlatformPreset, type ResolvedMotionSpec } from "../../motion-spec.js";
import { reviewBounds, type LayerBounds } from "./motion.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- align ----------

export const AeAlignSchema = z
  .object({
    comp_id: z.number().int(),
    layers: z.array(LayerSelectorSchema).min(1).max(200),
    align: z.enum(["left", "center_h", "right", "top", "center_v", "bottom"]).optional(),
    distribute: z.enum(["horizontal", "vertical"]).optional().describe("Space the layers' centres evenly (between the outermost two, or across `to`)."),
    to: z.enum(["comp", "layers", "action_safe", "title_safe"]).optional().describe("What to align to. Default comp for align, layers for distribute."),
    time: z.number().optional().describe("The time the boxes are measured at. Default the comp's current time."),
    shift_keys: z.boolean().optional().describe("Move every position key of an animated layer by the same amount. Without it animated layers are refused."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.align === undefined) !== (v.distribute === undefined), { message: "Give align or distribute." })
  .refine((v) => v.distribute === undefined || v.layers.length >= 2, { message: "Distribute needs two or more layers." });

interface Bounds {
  width: number;
  height: number;
  layers: Array<{ index: number; id: number; name: string; rect: [number, number, number, number] | null }>;
}

const centre = (r: number[], h: boolean) => (h ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2);

export function alignMismatches(args: z.infer<typeof AeAlignSchema>, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as Bounds | null;
  const box = written.box as [number, number, number, number] | undefined;
  if (!after || !box) return m;
  const rects = after.layers.map((l) => l.rect).filter((r): r is [number, number, number, number] => r !== null);
  if (rects.length !== after.layers.length) {
    m.push({ path: "layers", expected: after.layers.length, actual: rects.length, message: "Some boxes could not be read back" });
    return m;
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  if (args.align) {
    const edge: Record<string, (r: number[]) => [number, number]> = {
      left: (r) => [r[0], box[0]],
      right: (r) => [r[2], box[2]],
      top: (r) => [r[1], box[1]],
      bottom: (r) => [r[3], box[3]],
      center_h: (r) => [centre(r, true), (box[0] + box[2]) / 2],
      center_v: (r) => [centre(r, false), (box[1] + box[3]) / 2],
    };
    after.layers.forEach((l, i) => {
      const [got, want] = edge[args.align!](rects[i]);
      expectThat(m, near(got, want), `layers[${l.name}].${args.align}`, Math.round(want * 10) / 10, Math.round(got * 10) / 10, `"${l.name}" is not aligned`);
    });
  } else {
    const h = args.distribute === "horizontal";
    const cs = rects.map((r) => centre(r, h)).sort((a, b) => a - b);
    const step = (cs[cs.length - 1] - cs[0]) / (cs.length - 1);
    cs.forEach((c, i) => expectThat(m, near(c, cs[0] + step * i), `centres[${i}]`, Math.round((cs[0] + step * i) * 10) / 10, Math.round(c * 10) / 10, "Centres are not evenly spaced"));
  }
  return m;
}

// ---------- purge ----------

export const AePurgeUnusedSchema = z
  .object({
    kinds: z.array(z.enum(["footage", "solid", "placeholder"])).min(1).optional().describe("Which unused items. Default all three."),
    empty_folders: z.boolean().optional().describe("Also remove folders that are already empty when scanned. Default false. A folder this purge empties stays; run it again to remove that too."),
    keep: z.array(z.number().int()).max(500).optional().describe("Item ids to leave alone."),
    consolidate: z
      .boolean()
      .optional()
      .describe(
        "Instead of removing unused items: merge duplicate footage with Project.consolidateFootage. The dry run lists the groups of footage items that share a file and an interpretation; " +
          "apply runs consolidateFootage (project-wide) and reports the count After Effects returns next to that plan, because its own duplicate rule is undocumented (it may also merge items this list does not show). Cannot be combined with kinds, empty_folders, keep or reduce_to_comp_ids."
      ),
    reduce_to_comp_ids: z
      .array(z.number().int())
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Instead of removing unused items: reduce the LIVE project to these comps and everything they use (Project.reduceProject). The dry run lists every comp, footage item and solid not reached through layers and nested comps; " +
          "apply removes them (expressions that reference other items by name, and the render queue entries of removed comps, are not followed). Cannot be combined with kinds, empty_folders, keep or consolidate."
      ),
    apply: z.boolean().optional().describe("Remove / merge them. Default false: list what would go. Needs expect."),
    expect: ExpectSchema.optional(),
  })
  .refine((v) => !(v.consolidate === true && v.reduce_to_comp_ids !== undefined), { message: "Give consolidate or reduce_to_comp_ids, not both." })
  .refine((v) => (v.consolidate !== true && v.reduce_to_comp_ids === undefined) || (v.kinds === undefined && v.empty_folders === undefined && v.keep === undefined), {
    message: "consolidate and reduce_to_comp_ids do not take kinds, empty_folders or keep.",
  });

interface ConsolidatePlan {
  numItems: number;
  footage_with_file: number;
  group_total: number;
  removable: number;
  groups: Array<{ file: string | null; count: number; items: Array<{ id: number; name: string; used_in: number }>; items_truncated?: boolean }>;
  truncated?: boolean;
}

interface ReducePlan {
  numItems: number;
  keep_comps: Array<{ id: number; name: string }>;
  kept_items: number;
  remove: Array<{ id: number; name: string; kind: string }>;
  remove_total: number;
  truncated?: boolean;
  folders_total: number;
}

export const CONSOLIDATE_NOTE =
  "Groups are footage items with the same file and interpretation. Which item After Effects keeps, and whether consolidateFootage also merges items outside these groups, is its own undocumented rule; the apply reports its returned count next to this plan.";
export const REDUCE_NOTE =
  "Reached means used by a layer of a kept comp or of a comp nested in it. Expressions that look an item up by name (comp(\"X\"), footage(\"X\")) are not followed, and folders are left to After Effects. Removed comps take their render-queue items with them.";

export function consolidateMismatches(before: ConsolidatePlan | null, after: ConsolidatePlan | null, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after || written.no_op === true) return m;
  // Groups left over are not a mismatch: the plan's duplicate key is a guess at AE's undocumented rule (Interpret Footage settings may keep copies apart).
  if (typeof written.removed === "number" && before) {
    expectThat(m, before.numItems - written.removed === after.numItems, "numItems", before.numItems - written.removed, after.numItems, "The item count does not match the number consolidateFootage returned");
  }
  return m;
}

export function reduceMismatches(ids: number[], after: ReducePlan | null, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after || written.no_op === true) return m;
  expectThat(m, after.remove_total === 0, "unreached_items", 0, after.remove_total, `${after.remove_total} item${after.remove_total === 1 ? " is" : "s are"} still in the project that the kept comps do not reach`);
  const kept = new Set(after.keep_comps.map((c) => c.id));
  for (const id of ids) expectThat(m, kept.has(id), `keep_comps[${id}]`, "present", "missing", `Comp ${id} is no longer in the project`);
  return m;
}

interface Unused {
  items: Array<{ id: number; name: string; kind: string; file: string | null }>;
  folders: Array<{ id: number; name: string; kind: string }>;
  numItems: number;
  total_unused?: number;
  truncated?: boolean;
}

// ---------- MOGRT ----------

export const AeExportMogrtSchema = z.object({
  comp_id: z.number().int().describe("A comp with Essential Graphics controllers."),
  path: z.string().min(1).optional().describe("Absolute .mogrt path. Default: AE's own Essential Graphics folder."),
  overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
  allow_font_dialog: z
    .boolean()
    .optional()
    .describe(
      "Default false: refuse when a text layer uses a font that is not from Adobe Fonts (or the font check could not cover everything), because AE then opens a modal \"fonts were not synced from Adobe\" dialog during the export and blocks every call until someone answers it. Pass true only when the user is at the machine to answer that dialog."
    ),
  expect: ExpectSchema,
});

// ---------- house style ----------

export const AeHouseStyleCheckSchema = z.object({
  comp_id: z.number().int(),
  brand_colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(40).optional().describe("Instead of the brief's brand colours."),
  fonts: z.array(z.string().min(1)).max(20).optional().describe("Instead of the brief's fonts."),
  color_tolerance: z.number().min(0).max(100).optional().describe("Delta E (CIE76) within which a colour counts as the brand colour. Default 12."),
  neutrals_ok: z.boolean().optional().describe("Black, white and greys pass the palette check. Default true."),
  min_font_size: z.number().positive().optional().describe("Flag text smaller than this, in pixels on screen. Without it there is no size check, unless the brief's motion spec sets min_text_pct or platform, or platform is passed: then the relative floor applies (min_text_pct, default 2.6, % of the comp's short side). On screen means the text size times the layer's and its parents' Scale at the check time. Text-animator scale, 3D depth and nested-comp scale are not counted."),
  safe_area: z.boolean().optional().describe("Check text layers against title safe at the check time. Default true."),
  title_safe: z.number().min(0).max(0.5).optional().describe("Default 0.2, AE's. Used when no platform preset applies."),
  platform: z.enum(PLATFORM_PRESET_IDS as [PlatformPreset, ...PlatformPreset[]]).optional().describe("Safe-zone preset for text and logo layers (footage, image, precomp, shape or solid layers named logo). Default: the brief's motion.platform if it sets one, else title safe. Passing it (or a brief platform) also turns on the relative text-size floor."),
  time: z.number().optional().describe("When to check the safe area. Default the comp's current time."),
});

interface StyleScan {
  width: number;
  height: number;
  time: number;
  truncated?: boolean;
  layers: StyleLayer[];
}

interface StyleLayer {
  index: number;
  id: number;
  name: string;
  kind: "text" | "shape" | "solid" | "logo";
  enabled: boolean;
  font?: string;
  family?: string;
  font_size?: number;
  font_style?: string;
  scale_factor?: number;
  screen_font_size?: number;
  font_missing?: boolean;
  colours: Array<{ where: string; role: string; rgb: Rgb | null }>;
}

export interface StyleFinding {
  severity: "medium" | "low" | "info";
  kind: "missing_font" | "off_brand_font" | "off_palette_colour" | "small_text" | "cut_off" | "outside_safe" | "outside_platform_safe" | "below_platform_ui" | "in_action_rail" | "platform_aspect_mismatch";
  layer: { index: number; id: number; name: string };
  message: string;
  [k: string]: unknown;
}

/**
 * Layer names that count as a logo: "logo" as a word ("Logo", "Brand logo", "logo_white", "Logo 2"),
 * not inside another word ("catalogue", "Dialogue", "Analogous"). Backing layers ("Logo BG", "logo backing")
 * and background solids are not logos.
 */
const LOGO_WORD = /(^|[^a-z])logo([^a-z]|$)/i;
const BACKGROUND_NAME = /(^|[^a-z])(bg|background)([^a-z]|$)/i;
const LOGO_BACKING = /(^|[^a-z])logo[\s_.-]*(bg|back|backing|background|plate|shadow|glow|mask|matte)([^a-z]|$)/i;
export function isLogoName(name: string): boolean {
  return LOGO_WORD.test(name) && !LOGO_BACKING.test(name);
}

export function styleFindings(
  layers: StyleLayer[],
  opts: { brand_colors: string[]; fonts: string[]; tolerance: number; neutrals_ok: boolean; min_font_size?: number; min_font_note?: string }
): StyleFinding[] {
  const out: StyleFinding[] = [];
  for (const l of layers) {
    const layer = { index: l.index, id: l.id, name: l.name };
    if (l.kind === "text") {
      if (l.font_missing) out.push({ severity: "medium", kind: "missing_font", layer, message: `"${l.name}" uses ${l.font}, which is missing; AE is showing a substitute.`, font: l.font });
      if (opts.fonts.length && l.font && !fontMatches({ font: l.font, family: l.family, style: l.font_style }, opts.fonts)) {
        out.push({ severity: "medium", kind: "off_brand_font", layer, message: `"${l.name}" is set in ${l.family ?? l.font} (${l.font}), not one of the brief's fonts: ${opts.fonts.join(", ")}.`, font: l.font });
      }
      const size = l.screen_font_size ?? l.font_size;
      if (opts.min_font_size && size !== undefined && size < opts.min_font_size) {
        const px = Math.round(size * 10) / 10;
        const scaled = l.screen_font_size !== undefined && l.font_size !== undefined && Math.abs(l.screen_font_size - l.font_size) > 0.05;
        out.push({
          severity: "low",
          kind: "small_text",
          layer,
          message: `"${l.name}" is ${px} px${scaled ? ` on screen (${l.font_size} px text at ${Math.round((l.scale_factor ?? 1) * 1000) / 10}% scale)` : ""}, under the ${Math.round(opts.min_font_size * 10) / 10} px minimum${opts.min_font_note ? ` (${opts.min_font_note})` : ""}.`,
          font_size: l.font_size,
          ...(scaled ? { screen_font_size: px } : {}),
        });
      }
    }
    if (!opts.brand_colors.length) continue;
    const seen = new Set<string>();
    for (const c of l.colours) {
      if (!c.rgb) continue;
      const hex = rgbToHex(c.rgb);
      if (seen.has(hex)) continue;
      seen.add(hex);
      if (opts.neutrals_ok && isNeutral(c.rgb)) continue;
      const near = nearestBrand(c.rgb, opts.brand_colors);
      if (near && near.delta_e > opts.tolerance) {
        out.push({
          severity: "low",
          kind: "off_palette_colour",
          layer,
          message: `"${l.name}" uses ${hex} (${c.where}), ${near.delta_e} delta E from the nearest brand colour ${near.hex}.`,
          colour: hex,
          where: c.where,
          nearest: near.hex,
          delta_e: near.delta_e,
        });
      }
    }
  }
  const order = { medium: 0, low: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.layer.index - b.layer.index);
}

/** Removes the empty folders mkdirSync made, from `dir` up to `top`; stops at the first one that has files. */
function removeEmptyDirs(dir: string, top: string): void {
  let cur = dir;
  for (;;) {
    try {
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    if (path.resolve(cur) === path.resolve(top)) return;
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

/** Brief values come from a hand-editable file: keep the usable ones and name the rest. */
export function cleanBriefStyle(brief: { brand_colors?: unknown; fonts?: unknown } | null | undefined): { colors: string[]; fonts: string[]; ignored: string[] } {
  const list = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v === undefined || v === null) return [];
    return [v];
  };
  const colors: string[] = [];
  const fonts: string[] = [];
  const ignored: string[] = [];
  for (const c of list(brief?.brand_colors)) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c.trim())) colors.push(c.trim());
    else ignored.push(`brand colour ${JSON.stringify(c)}`);
  }
  for (const f of list(brief?.fonts)) {
    if (typeof f === "string" && f.trim() !== "") fonts.push(f.trim());
    else ignored.push(`font ${JSON.stringify(f)}`);
  }
  return { colors, fonts, ignored };
}

const SAFE_AREA_MAX = 50;

const PRESET_ASPECT: Partial<Record<PlatformPreset, number>> = {
  landscape_16_9: 16 / 9,
  reels_9_16: 9 / 16,
  tiktok_9_16: 9 / 16,
  instagram_reels_9_16: 9 / 16,
  youtube_shorts_9_16: 9 / 16,
  promo_9_16: 9 / 16,
  feed_4_5: 4 / 5,
  square_1_1: 1,
};

/** One warning when the comp's shape is not the preset's (title_safe fits any). */
export function platformAspectWarning(preset: PlatformPreset, width: number, height: number): StyleFinding | null {
  const want = PRESET_ASPECT[preset];
  if (want === undefined || !(width > 0) || !(height > 0)) return null;
  if (Math.abs(width / height / want - 1) <= 0.05) return null;
  return {
    severity: "low",
    kind: "platform_aspect_mismatch",
    layer: { index: 0, id: 0, name: "(comp)" },
    message: `The ${PLATFORM_PRESETS[preset].label} preset is made for a different shape than this ${width}x${height} comp; its safe box is still applied as fractions of this size.`,
    preset,
  };
}

/**
 * Text and logo layers against a platform preset's safe box, at the sampled time. Each layer gives
 * findings naming the preset and the edges crossed with their pixel overlap. For reels_9_16 the bottom
 * crossing is "below the platform UI line" and the right one "in the right action rail". Layers in
 * skipLayerIds (those already reported as cut_off by the frame-edge test) are left out, so one layer
 * is not reported twice for the same overhang.
 */
export function platformFindings(bounds: LayerBounds[], comp: { width: number; height: number }, preset: PlatformPreset, skipLayerIds: ReadonlySet<number> = new Set()): StyleFinding[] {
  const out: StyleFinding[] = [];
  const box = safeRect(preset, comp.width, comp.height);
  const label = PLATFORM_PRESETS[preset].label;
  const reels = preset === "reels_9_16" || preset === "tiktok_9_16" || preset === "instagram_reels_9_16" || preset === "youtube_shorts_9_16";
  for (const b of bounds) {
    if (!b.checkable || skipLayerIds.has(b.layer.id)) continue;
    for (const s of b.samples) {
      if (!s.visible || !s.rect) continue;
      const [l, t, r, bt] = s.rect;
      const area = (r - l) * (bt - t);
      if (area <= 0 || area >= 0.8 * comp.width * comp.height) continue;
      const px = (n: number) => Math.round(n);
      const generic: string[] = [];
      if (l < box.left - 0.5) generic.push(`left by ${px(box.left - l)} px`);
      if (t < box.top - 0.5) generic.push(`top by ${px(box.top - t)} px`);
      if (r > box.right + 0.5) generic.push(`right by ${px(r - box.right)} px`);
      if (bt > box.bottom + 0.5) generic.push(`bottom by ${px(bt - box.bottom)} px`);
      if (!generic.length) break;
      const base = { layer: b.layer, time: Math.round(s.time * 1000) / 1000, preset, bounds: [px(l), px(t), px(r), px(bt)] as [number, number, number, number], safe_box: [px(box.left), px(box.top), px(box.right), px(box.bottom)] };
      const what = b.kind === "text" ? "Text" : "Logo";
      if (reels && bt > box.bottom + 0.5) {
        out.push({ severity: "low", kind: "below_platform_ui", message: `${what} "${b.layer.name}" is below the platform UI line (y ${px(box.bottom)}) by ${px(bt - box.bottom)} px; captions, buttons and the account name cover it on ${label}.`, ...base });
      }
      if (reels && r > box.right + 0.5) {
        out.push({ severity: "low", kind: "in_action_rail", message: `${what} "${b.layer.name}" reaches into the right action rail (x ${px(box.right)}) by ${px(r - box.right)} px on ${label}.`, ...base });
      }
      const rest = reels ? generic.filter((g) => !g.startsWith("bottom") && !g.startsWith("right")) : generic;
      if (rest.length) {
        out.push({ severity: "low", kind: "outside_platform_safe", message: `${what} "${b.layer.name}" is outside the ${label} safe box: past the ${rest.join(", ")}.`, ...base });
      }
      break;
    }
  }
  return out;
}

// ---------- purge modes ----------

async function consolidateFootageMode(args: z.infer<typeof AePurgeUnusedSchema>, ctx: ToolContext) {
  const read = { host: "exploreConsolidatePlan", args: {} };
  const plan = (await ctx.bridge.callHost<ConsolidatePlan>(read.host, read.args, { label: "ae_purge_unused (duplicate footage)", mutates: false, toolName: "ae_purge_unused" })).result;
  if (!args.apply || plan.group_total === 0) {
    return {
      ok: true,
      dry_run: !args.apply,
      mode: "consolidate",
      group_count: plan.group_total,
      removable_estimate: plan.removable,
      ...(plan.truncated ? { truncated: true, note: "Only the first 500 groups are listed." } : {}),
      groups: plan.groups,
      rule_note: CONSOLIDATE_NOTE,
    };
  }
  if (!args.expect) return { ok: false, error: "bad_args", message: "apply needs expect." };
  return runGuardedWrite(ctx, {
    toolName: "ae_purge_unused",
    label: `ae_purge_unused(consolidate ${plan.group_total} group${plan.group_total === 1 ? "" : "s"})`,
    expect: args.expect,
    read: () => read,
    write: { host: "exploreConsolidateFootage", args: { label: "Consolidate duplicate footage" } },
    check: (before, after, w) => consolidateMismatches(before as ConsolidatePlan | null, after as ConsolidatePlan | null, w),
    present: (before, after, w) => ({
      mode: "consolidate",
      planned: { groups: plan.group_total, removable_estimate: plan.removable },
      removed: w.removed,
      items_before: (before as ConsolidatePlan | null)?.numItems,
      numItems: (after as ConsolidatePlan | null)?.numItems,
      groups_left: (after as ConsolidatePlan | null)?.group_total,
      ...(((after as ConsolidatePlan | null)?.group_total ?? 0) > 0 ? { groups_left_note: "Groups left over are not an error: this plan's duplicate key is a guess, and After Effects may keep copies apart (for example by Interpret Footage settings)." } : {}),
      rule_note: CONSOLIDATE_NOTE,
      ...(typeof w.removed === "number" && w.removed !== plan.removable ? { count_note: `consolidateFootage reported ${w.removed} removed; the plan expected ${plan.removable}. Its duplicate rule differs from this plan's.` } : {}),
    }),
  });
}

async function reduceProjectMode(args: z.infer<typeof AePurgeUnusedSchema>, ctx: ToolContext) {
  const ids = args.reduce_to_comp_ids as number[];
  const read = { host: "exploreReducePlan", args: { comp_ids: ids } };
  const plan = (await ctx.bridge.callHost<ReducePlan>(read.host, read.args, { label: "ae_purge_unused (reduce plan)", mutates: false, toolName: "ae_purge_unused" })).result;
  if (!args.apply || plan.remove_total === 0) {
    return {
      ok: true,
      dry_run: !args.apply,
      mode: "reduce",
      keep_comps: plan.keep_comps,
      kept_items: plan.kept_items,
      remove_count: plan.remove_total,
      ...(plan.truncated ? { truncated: true, note: "Only the first 500 items to remove are listed." } : {}),
      remove: plan.remove,
      folders_total: plan.folders_total,
      rule_note: REDUCE_NOTE,
    };
  }
  if (!args.expect) return { ok: false, error: "bad_args", message: "apply needs expect." };
  return runGuardedWrite(ctx, {
    toolName: "ae_purge_unused",
    label: `ae_purge_unused(reduce to ${ids.length} comp${ids.length === 1 ? "" : "s"})`,
    expect: args.expect,
    read: () => read,
    write: { host: "exploreReduceProject", args: { comp_ids: ids, label: "Reduce project to comps" } },
    check: (_before, after, w) => reduceMismatches(ids, after as ReducePlan | null, w),
    present: (before, after, w) => ({
      mode: "reduce",
      planned_removals: plan.remove_total,
      removed: w.removed,
      items_before: (before as ReducePlan | null)?.numItems,
      numItems: (after as ReducePlan | null)?.numItems,
      rule_note: REDUCE_NOTE,
      ...(typeof w.removed === "number" && w.removed !== plan.remove_total ? { count_note: `reduceProject reported ${w.removed} removed; the plan listed ${plan.remove_total} (folders and other items count differently).` } : {}),
    }),
  });
}

// ---------- tools ----------

export const layoutTools: ToolDefinition<any>[] = [
  {
    name: "ae_align",
    description:
      "Align layers (left, horizontal centre, right, top, vertical centre, bottom) to the comp, the action- or title-safe area, or their combined box; or distribute their centres evenly. " +
      "Boxes are the layers' content (sourceRectAtTime through anchor, scale, rotation and position) at `time`. 2D, unparented layers only; animated positions move only with shift_keys. " +
      "One undo group guarded by `expect`; the read-back (a separate evalScript) measures the boxes again. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAlignSchema,
    handler: (args: z.infer<typeof AeAlignSchema>, ctx) => {
      const to = args.to ?? (args.distribute ? "layers" : "comp");
      return runGuardedWrite(ctx, {
        toolName: "ae_align",
        label: `ae_align(${args.align ?? `distribute ${args.distribute}`})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (_phase, w) => ({ host: "boundsOf", args: { comp_id: args.comp_id, layers: args.layers, time: (w?.time as number | undefined) ?? args.time } }),
        write: {
          host: "alignLayers",
          args: { comp_id: args.comp_id, layers: args.layers, align: args.align, distribute: args.distribute, to, time: args.time, shift_keys: args.shift_keys, label: "Align layers" },
        },
        check: (_before, after, w) => alignMismatches(args, after, w),
        present: (_before, after, w) => ({ to, box: w.box, moved: w.moved, layers: (after as Bounds | null)?.layers }),
      });
    },
  },
  {
    name: "ae_purge_unused",
    description:
      "Find project items nothing uses: footage, solids and placeholders in no comp, and optionally empty folders. By default it only lists them; with apply (and expect) it removes them in one undo group, " +
      "re-checking each is still unused first. In the default mode comps are never removed; reduce_to_comp_ids removes every comp the kept comps do not reach. The read-back (a separate evalScript) checks they are gone. " +
      "Two other modes, both dry-run first and both after an automatic checkpoint: consolidate (merge duplicate footage, Project.consolidateFootage) and reduce_to_comp_ids " +
      "(reduce the live project to the chosen comps and what they use, Project.reduceProject). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePurgeUnusedSchema,
    handler: async (args: z.infer<typeof AePurgeUnusedSchema>, ctx: ToolContext) => {
      if (args.consolidate === true) return consolidateFootageMode(args, ctx);
      if (args.reduce_to_comp_ids !== undefined) return reduceProjectMode(args, ctx);
      const read = { host: "unusedItems", args: { kinds: args.kinds, empty_folders: args.empty_folders } };
      const found = (await ctx.bridge.callHost<Unused>(read.host, read.args, { label: "ae_purge_unused (scan)", mutates: false, toolName: "ae_purge_unused" })).result;
      const keep = new Set(args.keep ?? []);
      const targets = [...found.items, ...found.folders].filter((i) => !keep.has(i.id));
      const cut = found.truncated === true ? { truncated: true, total_unused: found.total_unused, note: "The scan stops at 500 items; apply this list, then run it again for the rest." } : {};
      if (!args.apply || targets.length === 0) return { ok: true, dry_run: !args.apply, count: targets.length, ...cut, items: targets };
      if (!args.expect) return { ok: false, error: "bad_args", message: "apply needs expect." };
      // Folders last. Only folders already empty at scan time are listed; one this purge empties is left for the next run.
      const ids = [...found.items.filter((i) => !keep.has(i.id)).map((i) => i.id), ...found.folders.filter((i) => !keep.has(i.id)).map((i) => i.id)];
      return runGuardedWrite(ctx, {
        toolName: "ae_purge_unused",
        label: `ae_purge_unused(${ids.length})`,
        expect: args.expect,
        read: () => read,
        write: { host: "purgeItems", args: { ids, label: `Remove ${ids.length} unused item${ids.length === 1 ? "" : "s"}` } },
        check: (_before, after) => {
          const left = [...((after as Unused | null)?.items ?? []), ...((after as Unused | null)?.folders ?? [])].filter((i) => ids.includes(i.id));
          return left.map((i) => ({ path: `items[${i.id}]`, expected: "removed", actual: i.name, message: `"${i.name}" is still in the project` }));
        },
        present: (_before, after, w) => ({ removed: w.removed, numItems: (after as Unused | null)?.numItems, ...cut }),
      });
    },
  },
  {
    name: "ae_export_mogrt",
    description:
      "Export a comp's Essential Graphics template as a .mogrt, from the saved project (ae_save first; AE exports what is on disk), to `path` or AE's own Essential Graphics folder. " +
      "Guarded by `expect`; no undo group, since it writes a file, not the project. Dialogs are never suppressed: if AE asks something, the call says so and ae_dialogs shows it. " +
      "Before exporting it reads the fonts of the comp's text layers (and of comps nested in it, at the current value and at each key, run by run, since a layer's own font is only its first run's; AE 24+ reports whether a font is from Adobe Fonts). A font that is not from Adobe Fonts makes AE open a modal dialog (\"The following fonts were not synced from Adobe ... Click OK to continue. Click Cancel to stop the export\") during the export that blocks the whole queue until a person answers it, so unattended the call refuses and names the fonts; pass allow_font_dialog: true only when the user is at the machine to answer. A font whose origin AE does not report is not refused (the result counts them in fonts_origin_unknown). If the check could not cover everything (more than 500 text layers, 5000 layers, 50 keyframes on one text, 6 levels of nesting, a text with very many font runs), the call refuses too and lists the gaps, unless allow_font_dialog is true; the result carries fonts_scan_complete and fonts_scan_gaps. " +
      "With a path, the file is checked on disk (new, not empty). Pairs with premiere-pro-mcp, which can place the template in a sequence. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeExportMogrtSchema,
    handler: async (args: z.infer<typeof AeExportMogrtSchema>, ctx: ToolContext) => {
      if (args.path !== undefined) {
        if (!path.isAbsolute(args.path) || !/\.mogrt$/i.test(args.path)) return { ok: false, error: "bad_path", message: `Give an absolute .mogrt path: ${args.path}` };
        if (fs.existsSync(args.path) && !args.overwrite) return { ok: false, error: "exists", message: `${args.path} exists; pass overwrite to replace it.` };
      }
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const started = Date.now();
      try {
        return await ctx.queue.run(`ae_export_mogrt(${args.comp_id})`, async () => {
          await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, opId);
          // The folder is made only now: the quarantine and the guard have passed.
          const createdDir = args.path !== undefined ? fs.mkdirSync(path.dirname(args.path), { recursive: true }) : undefined;
          let res;
          try {
            res = await ctx.bridge.evalRaw<{ exported: boolean; controllers: number; template_name: string; fonts_checked?: number; fonts_origin_unknown?: number; fonts_scan_complete?: boolean; fonts_scan_gaps?: string[]; fonts_not_from_adobe?: unknown[] }>({
              id: opId,
              script: buildJsxCall("exportMogrt", { comp_id: args.comp_id, path: args.path?.replace(/\\/g, "/"), overwrite: args.overwrite, allow_font_dialog: args.allow_font_dialog, expect: args.expect }),
              label: `ae_export_mogrt(${args.comp_id})`,
              mutates: false,
              toolName: "ae_export_mogrt",
            });
          } catch (err) {
            // The host refused (no controllers, unsaved project): don't leave empty folders behind.
            // After a timeout the export may still be running (a dialog blocking AE), so keep its folder.
            const refused = err instanceof BridgeError && (err.kind === "evalscript_error" || err.kind === "guard");
            if (refused && createdDir !== undefined && args.path !== undefined) removeEmptyDirs(path.dirname(args.path), createdDir);
            throw err;
          }
          const r = res.result;
          if (!r.exported && createdDir !== undefined && args.path !== undefined) removeEmptyDirs(path.dirname(args.path), createdDir);
          let file: { path: string; size: number; fresh: boolean } | null = null;
          if (args.path) {
            try {
              const st = fs.statSync(args.path);
              file = { path: args.path, size: st.size, fresh: st.mtimeMs >= started - 2000 };
            } catch {
              file = null;
            }
          }
          const verified = args.path ? Boolean(file && file.size > 0 && file.fresh) : r.exported;
          return {
            ok: r.exported && verified,
            exported: r.exported,
            controllers: r.controllers,
            template_name: r.template_name,
            fonts_checked: r.fonts_checked,
            fonts_origin_unknown: r.fonts_origin_unknown,
            fonts_scan_complete: r.fonts_scan_complete,
            ...(r.fonts_scan_gaps ? { fonts_scan_gaps: r.fonts_scan_gaps } : {}),
            ...(r.fonts_not_from_adobe ? { fonts_not_from_adobe: r.fonts_not_from_adobe } : {}),
            file,
            ...(args.path && !verified ? { message: "AE reported an export but the file is missing, empty or old." } : {}),
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        throw err;
      }
    },
  },
  {
    name: "ae_house_style_check",
    description:
      "Check a comp against the house style: text in the brief's fonts (ae_brief) and not missing, colours of text, shapes and solids within color_tolerance (delta E) of a brand colour, " +
      "text above a minimum size, and text inside title safe at the check time. " +
      "The size check runs only when asked for: min_font_size (pixels on screen) always wins; otherwise a relative floor (the brief's motion.min_text_pct, default 2.6 % of the comp's short side) applies only when the brief's motion spec sets min_text_pct or platform, or the call passes platform; with none of those there is no size check. The result's min_text says which: { px, source: argument | brief | platform | off }. " +
      "platform (or the brief's motion.platform) swaps title safe for a preset box (reels_9_16 is the box safe on TikTok, Reels and Shorts together; tiktok_9_16, instagram_reels_9_16, youtube_shorts_9_16, promo_9_16, feed_4_5, square_1_1, landscape_16_9) for text and for logo layers (footage, image, precomp, shape or solid layers whose name has the word logo; \"Logo BG\" backings and full-frame layers are skipped), naming the edge crossed and the pixels; the 9:16 platform presets (not promo_9_16) also flag the bottom UI band and the right action rail, and a comp of another shape gets one warning. A layer already reported cut_off by the frame-edge test is not reported again for the platform box. promo_9_16 applies the 22 % title line (bottom 22 % kept clear), not the 15 % CTA line. brand_colors and fonts override the brief. Read-only; findings come most severe first, with the nearest brand colour for each off-palette one. " +
      "Nested comps are checked by running it on them.",
    schema: AeHouseStyleCheckSchema,
    handler: async (args: z.infer<typeof AeHouseStyleCheckSchema>, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const label = "ae_house_style_check";
      // One lease for the whole scan, so no other tool runs between the layers' reads. The one status eval
      // gives the project path; the brief (and its motion spec) is read from that path inside the lease, so a
      // bridge failure surfaces here (and QueueWaitError maps below) instead of being swallowed.
      let gathered: { brief: Brief | null; motion: ResolvedMotionSpec & { warning?: string }; platform: PlatformPreset | undefined; scan: StyleScan; bounds: LayerBounds[]; safeTotal: number; unchecked: Array<{ layer: string; reason: string }> };
      try {
        gathered = await ctx.queue.run(`ae_house_style_check(${args.comp_id})`, async () => {
          let n = 0;
          const read = <T,>(fn: string, hostArgs: unknown, what: string) =>
            ctx.bridge.evalRaw<T>({ id: `${opId}_${n++}`, script: buildJsxCall(fn, hostArgs), label: `${label} (${what})`, mutates: false, toolName: label });
          const status = (await read<{ project_path: string }>("status", {}, "status")).result;
          const brief = status.project_path && status.project_path !== "<unsaved>" ? readBrief(briefPath(status.project_path)) : null;
          // The same salvage as loadMotionSpec: valid fields of a malformed stored spec are kept.
          const salvaged = salvageMotionSpec(brief?.motion);
          const motion = { ...resolveMotionSpec(salvaged.spec), ...(salvaged.warning ? { warning: salvaged.warning } : {}) };
          const platform: PlatformPreset | undefined = args.platform ?? (motion.from_brief.includes("platform") ? motion.platform : undefined);
          const scan = (await read<StyleScan>("styleScan", { comp_id: args.comp_id, time: args.time }, "scan")).result;
          const bounds: LayerBounds[] = [];
          const unchecked: Array<{ layer: string; reason: string }> = [];
          const texts = scan.layers.filter((x) => x.kind === "text" && x.enabled);
          const logos = platform !== undefined && platform !== "title_safe" ? scan.layers.filter((x) => x.kind !== "text" && x.enabled && isLogoName(x.name) && !(x.kind === "solid" && BACKGROUND_NAME.test(x.name))) : [];
          if (args.safe_area !== false) {
            const t = args.time ?? scan.time;
            for (const l of [...texts.slice(0, SAFE_AREA_MAX), ...logos.slice(0, SAFE_AREA_MAX)]) {
              try {
                bounds.push((await read<LayerBounds>("layerBoundsAt", { comp_id: args.comp_id, layer: { id: l.id }, times: [t] }, `bounds ${l.name}`)).result);
              } catch (err) {
                // Only a failure the host reported for this layer (it vanished mid-scan) is one unchecked entry.
                // A timeout or an unreachable panel means the bridge is stuck: stop, do not stack more evals behind it.
                if (!(err instanceof BridgeError) || err.kind !== "evalscript_error") throw err;
                unchecked.push({ layer: l.name, reason: err instanceof Error ? err.message : String(err) });
              }
            }
          }
          return { brief, motion, platform, scan, bounds, safeTotal: texts.length, unchecked };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        throw err;
      }
      const { brief, motion, platform, scan, bounds, safeTotal, unchecked } = gathered;
      const platformSource = args.platform ? "argument" : platform ? "brief" : "default";
      // title_safe keeps the legacy path (and its title_safe argument); any other preset gets its own box.
      const presetActive = platform !== undefined && platform !== "title_safe";
      const cleaned = cleanBriefStyle(brief);
      const brandColors = args.brand_colors ?? cleaned.colors;
      const fonts = args.fonts ?? cleaned.fonts;
      const ignored = [...(args.brand_colors ? [] : cleaned.ignored.filter((x) => x.startsWith("brand colour"))), ...(args.fonts ? [] : cleaned.ignored.filter((x) => x.startsWith("font")))];
      // Size check: explicit min_font_size wins; else the relative floor only when the brief sets min_text_pct or
      // platform, or the call passes platform; else none (as before the motion spec existed).
      const relativeFloor = minTextPx(motion, scan.width, scan.height);
      let minText: { px: number | null; source: "argument" | "brief" | "platform" | "off" } = { px: null, source: "off" };
      if (args.min_font_size !== undefined) minText = { px: args.min_font_size, source: "argument" };
      else if (motion.from_brief.includes("min_text_pct")) minText = { px: relativeFloor, source: "brief" };
      else if (platform !== undefined) minText = { px: relativeFloor, source: "platform" };
      const findings: StyleFinding[] = styleFindings(scan.layers, {
        brand_colors: brandColors,
        fonts,
        tolerance: args.color_tolerance ?? 12,
        neutrals_ok: args.neutrals_ok !== false,
        ...(minText.px !== null ? { min_font_size: minText.px } : {}),
        ...(minText.source !== "argument" && minText.px !== null ? { min_font_note: `${motion.min_text_pct} % of the ${Math.min(scan.width, scan.height)} px short side` } : {}),
      });
      // Frame-edge (cut_off) first: a layer reported there is not reported again for the platform box.
      const cutOff = new Set<number>();
      const edge: StyleFinding[] = [];
      for (const b of bounds) {
        // Without a preset only text is judged (as before); with one, logos get the frame-edge test too.
        if (!presetActive && b.kind !== "text") continue;
        for (const f of reviewBounds(b, { width: scan.width, height: scan.height }, { action: 0.1, title: args.title_safe ?? 0.2 })) {
          // A preset replaces the title-safe test; the frame-edge (cut_off) finding stays.
          if (presetActive && f.kind === "outside_safe") continue;
          if (f.kind === "cut_off") cutOff.add(f.layer.id);
          edge.push({ severity: f.severity === "info" ? "low" : f.severity, kind: f.kind as StyleFinding["kind"], layer: f.layer, message: f.message, bounds: f.bounds, suggested_shift: f.suggested_shift });
        }
      }
      if (presetActive && platform) {
        const warn = platformAspectWarning(platform, scan.width, scan.height);
        if (warn) findings.push(warn);
        if (args.safe_area !== false) findings.push(...platformFindings(bounds, { width: scan.width, height: scan.height }, platform, cutOff));
      }
      findings.push(...edge);
      const safeCut = args.safe_area !== false && safeTotal > SAFE_AREA_MAX;
      const counts = { medium: 0, low: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      return {
        ok: true,
        clean: findings.length === 0,
        used: { brand_colors: brandColors, fonts, from_brief: Boolean(brief) && !args.brand_colors && !args.fonts },
        ...(ignored.length ? { ignored_brief_entries: ignored } : {}),
        ...(motion.warning ? { motion_warning: motion.warning } : {}),
        min_text: { px: minText.px === null ? null : Math.round(minText.px * 10) / 10, source: minText.source },
        platform: presetActive && platform ? { preset: platform, label: PLATFORM_PRESETS[platform].label, source: platformSource, box: Object.values(safeRect(platform, scan.width, scan.height)).map((n) => Math.round(n)) } : { preset: "title_safe", source: platform ? platformSource : "default", title_safe: args.title_safe ?? 0.2 },
        ...(scan.truncated === true ? { truncated: true, truncated_note: "The scan stops at 500 text, shape, solid and logo layers; later layers were not checked." } : {}),
        ...(safeCut ? { safe_area_truncated: true, safe_area_checked: SAFE_AREA_MAX, safe_area_note: `Title safe was checked on the first ${SAFE_AREA_MAX} of ${safeTotal} text layers.` } : {}),
        ...(unchecked.length ? { safe_area_unchecked: unchecked } : {}),
        ...(brandColors.length === 0 || fonts.length === 0
          ? { note: `No brand ${brandColors.length === 0 ? "colours" : ""}${brandColors.length === 0 && fonts.length === 0 ? " or " : ""}${fonts.length === 0 ? "fonts" : ""} to check against: set them with ae_brief or pass them here.` }
          : {}),
        checked: { text: scan.layers.filter((l) => l.kind === "text").length, shape: scan.layers.filter((l) => l.kind === "shape").length, solid: scan.layers.filter((l) => l.kind === "solid").length },
        counts,
        findings,
      };
    },
  },
];
