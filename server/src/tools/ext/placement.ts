/**
 * server/src/tools/ext/placement.ts
 *
 * ae_layout_apply: builds or fills a layout from a declared spec in ONE undo
 * group - regions (typed rectangles, or the box of a mask or layer in a
 * template comp), each filled with a comp, a footage item, an existing layer
 * or a feed comp made for a footage item, fitted (fill, contain, stretch) and
 * optionally clipped to the region - plus layers (cameras) copied between comps.
 *
 * The plan is worked out here (placement-math.ts, pure) from two reads: the
 * facts of every item and layer the spec names (host layoutFacts) and, for
 * regions taken from a template, ae_describe_comp's layout read. The host gets
 * explicit numbers, checks them against the project again before its undo group
 * opens, and removes what it made if a step throws. A separate read-back
 * (layoutRead) checks every placed rectangle against the plan.
 *
 * Camera copies use Layer.copyToComp, which has not been measured on a real
 * Cinema 4D camera: the result says `verified: false` until a live test has
 * shown the copy faithful. There is no property-by-property rebuild.
 */

import { z } from "zod";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type LayerSelector, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import type { DescribeLayer, DescribeRaw } from "./describe.js";
import { fitSource, layerRect, regionToLayerSpace, sameRect, type FitMode, type Placement, type Rect } from "./placement-math.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- schema ----------

const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).describe("[x, y, width, height] in comp pixels; origin top-left; width and height at least 1.");
const MaskRef = z.union([z.string().min(1), z.number().int().positive()]);

const RegionSourceSchema = z
  .object({
    layer: LayerSelectorSchema.describe("A layer of the target comp (the template)."),
    use: z.enum(["mask", "bounds"]).describe("mask: the box of one of its masks. bounds: the layer's own box."),
    mask: MaskRef.optional().describe("With use 'mask': the mask's name (exact, else a unique part of it) or 1-based index."),
    time: z.number().optional().describe("Seconds. Default: the call's `time`, else the comp's current time."),
  })
  .strict();

const ContentSchema = z.union([
  z.object({ comp_id: z.number().int() }).strict(),
  z
    .object({
      footage_id: z.number().int(),
      make_feed: z
        .object({
          name: z.string().min(1).max(200).describe("Name of the new feed comp."),
          width: z.number().int().min(4).max(30000).optional().describe("Feed comp width in pixels. Default: the region's width, rounded."),
          height: z.number().int().min(4).max(30000).optional().describe("Feed comp height in pixels. Default: the region's height, rounded."),
          fit: z.enum(["fill", "contain", "stretch"]).optional().describe("How the footage fits inside the feed comp. Default fill."),
          target_folder_id: z.number().int().optional().describe("Project folder (item id) to put the feed comp in."),
        })
        .strict(),
    })
    .strict(),
  z.object({ footage_id: z.number().int() }).strict(),
  z.object({ layer: LayerSelectorSchema }).strict(),
]);

const RegionSchema = z
  .object({
    name: z.string().min(1).max(200).describe("The name of the layer placed here; unique in the call."),
    rect: RectSchema.optional(),
    from: RegionSourceSchema.optional(),
    content: ContentSchema.describe("One of: {comp_id} a comp to nest; {footage_id} a footage item; {layer} a layer already in the target comp (filled in place: renamed, anchor / position / scale set, rotation reset to 0); {footage_id, make_feed:{name, width?, height?, fit?, target_folder_id?}} a new comp holding the footage, nested here at 100%; make_feed.name is the new comp's name, width / height its size in pixels (default: the region's size, rounded), fit how the footage sits inside it (fill, contain or stretch; default fill), target_folder_id the project folder (item id) it goes in."),
    fit: z.enum(["fill", "contain", "stretch"]).optional().describe("fill (default): covers the region, crops the long side. contain: whole picture, bars. stretch: each axis on its own."),
    align: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional().describe("Where the slack (the side that does not fill the region) goes: [x, y] in 0..1, 0 = left / top, 1 = right / bottom. Default [0.5, 0.5]."),
    clip: z.boolean().optional().describe("A rectangular mask equal to the region. Default true for fill, false otherwise."),
    above: LayerSelectorSchema.optional().describe("Stack directly above this layer of the target comp."),
    below: LayerSelectorSchema.optional().describe("Stack directly below this layer of the target comp."),
  })
  .strict()
  .refine((r) => (r.rect === undefined) !== (r.from === undefined), { message: "Give exactly one of rect and from." })
  .refine((r) => !(r.above && r.below), { message: "Give above or below, not both." });

const CopySchema = z
  .object({
    from: z.object({ comp_id: z.number().int(), layer: LayerSelectorSchema }).strict(),
    to_comp_id: z.number().int(),
    name: z.string().min(1).max(200).optional(),
    as_active_camera: z.boolean().optional().describe("For a camera: make the copy the top camera of the destination (default true)."),
  })
  .strict();

const CreateMasterSchema = z
  .object({
    name: z.string().min(1).max(200),
    width: z.number().int().min(4).max(30000),
    height: z.number().int().min(4).max(30000),
    fps: z.number().min(1).max(99),
    duration: z.number().positive().max(10800).describe("Seconds, at most 10800."),
    bg_color: z.array(z.number().min(0).max(1)).length(3).optional(),
    target_folder_id: z.number().int().optional(),
  })
  .strict();

export const AeLayoutApplySchema = z
  .object({
    comp_id: z.number().int().optional().describe("The target comp. With only `copies`, any comp of the project (the guard)."),
    create_master: CreateMasterSchema.optional().describe("Make the target comp (square pixels) instead of using comp_id."),
    regions: z.array(RegionSchema).max(100).optional(),
    copies: z.array(CopySchema).max(100).optional().describe("Layers (cameras) copied from one comp to another with Layer.copyToComp."),
    time: z.number().optional().describe("Seconds at which `from` rectangles are read. Default: the comp's current time."),
    dry_run: z.boolean().optional().describe("Return the plan - every rectangle, scale and position, and what would be created - and change nothing."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.comp_id === undefined) !== (v.create_master === undefined), { message: "Give exactly one of comp_id and create_master." })
  .refine((v) => (v.regions?.length ?? 0) + (v.copies?.length ?? 0) > 0, { message: "Give regions or copies." });

export type LayoutApplyArgs = z.infer<typeof AeLayoutApplySchema>;
type Region = z.infer<typeof RegionSchema>;

// ---------- facts (what the host's layoutFacts returns) ----------

export interface ItemFacts {
  id: number;
  name?: string;
  kind: "comp" | "footage" | "folder" | "other" | "missing";
  width?: number;
  height?: number;
  pixel_aspect?: number;
  has_video?: boolean;
  missing?: boolean;
  placeholder?: boolean;
  contains_target?: boolean;
  contains_unknown?: boolean;
}

export interface LayerFacts {
  key: string;
  comp_id: number;
  comp_found?: boolean;
  found: boolean;
  ambiguous?: boolean;
  id?: number;
  index?: number;
  name?: string;
  locked?: boolean;
  three_d?: boolean;
  parent?: number | null;
  kind?: "layer" | "camera" | "light";
  keyed?: number;
  separated?: boolean;
  is_parent?: boolean;
  rotation?: number;
  flipped?: boolean;
  effects?: number;
  source_width?: number;
  source_height?: number;
  source_pixel_aspect?: number;
}

export interface LayoutFacts {
  target: { id: number; name: string; width: number; height: number; pixel_aspect: number; fps: number; duration: number; num_layers: number } | null;
  items: Record<string, ItemFacts>;
  layers: LayerFacts[];
  folders: Record<string, boolean>;
}

/** What to ask the host for. Keys name the layer lookups the plan builder reads back. */
export function factsRequest(args: LayoutApplyArgs) {
  const items = new Set<number>();
  const folders = new Set<number>();
  const layers: Array<{ key: string; comp_id: number; selector: LayerSelector }> = [];
  (args.regions ?? []).forEach((r, i) => {
    const c = r.content as Record<string, any>;
    if (c.comp_id !== undefined) items.add(c.comp_id);
    if (c.footage_id !== undefined) items.add(c.footage_id);
    if (c.make_feed?.target_folder_id !== undefined) folders.add(c.make_feed.target_folder_id);
    if (args.comp_id !== undefined) {
      if (c.layer) layers.push({ key: `region:${i}:layer`, comp_id: args.comp_id, selector: c.layer });
      if (r.above) layers.push({ key: `region:${i}:above`, comp_id: args.comp_id, selector: r.above });
      if (r.below) layers.push({ key: `region:${i}:below`, comp_id: args.comp_id, selector: r.below });
    }
  });
  (args.copies ?? []).forEach((c, i) => {
    items.add(c.from.comp_id);
    items.add(c.to_comp_id);
    layers.push({ key: `copy:${i}:layer`, comp_id: c.from.comp_id, selector: c.from.layer });
  });
  if (args.create_master?.target_folder_id !== undefined) folders.add(args.create_master.target_folder_id);
  return { comp_id: args.comp_id, items: [...items], folders: [...folders], layers };
}

// ---------- the plan ----------

export interface PlannedRegion {
  name: string;
  rect: Rect;
  rect_from?: string;
  fit: FitMode;
  placement: Placement;
  /** The box the placed layer covers (not the clip). */
  layer_rect: Rect;
  clip: boolean;
  /** Corners of the clip mask in layer space. */
  clip_corners: number[][] | null;
  content: { kind: "comp" | "footage" | "layer" | "feed"; item_id?: number; footage_id?: number; layer_id?: number; size: [number, number] };
  feed?: { name: string; width: number; height: number; fit: FitMode; place: Placement; folder_id?: number };
  above?: number;
  below?: number;
}

export interface PlannedCopy {
  from_comp_id: number;
  from_layer_id: number;
  from_layer_name?: string;
  to_comp_id: number;
  name?: string;
  camera: boolean;
  as_active_camera: boolean;
}

export interface LayoutPlan {
  regions: PlannedRegion[];
  copies: PlannedCopy[];
  warnings: string[];
  /** Frame rate and duration of the target, for the feed comps. */
  feed_fps: number;
  feed_duration: number;
}

const cmp = (s: string) => s.toLowerCase();

/** The describe-layout row a selector names (null with a reason when it names none or several). */
function pickLayerRow(rows: DescribeLayer[], sel: LayerSelector): { row?: DescribeLayer; problem?: string } {
  if (sel.id !== undefined) {
    const row = rows.find((r) => r.id === sel.id);
    return row ? { row } : { problem: `no layer with id ${sel.id}` };
  }
  if (sel.index !== undefined) {
    const row = rows.find((r) => r.index === sel.index);
    return row ? { row } : { problem: `no layer ${sel.index} among the layers read` };
  }
  const hits = rows.filter((r) => r.name === sel.name);
  if (hits.length === 1) return { row: hits[0] };
  return { problem: hits.length === 0 ? `no layer named "${sel.name}"` : `${hits.length} layers are named "${sel.name}"; use id or index` };
}

type Rows = Array<DescribeLayer & { layout?: { rect: Rect | null; rect_reason?: string | null; masks: Array<{ name: string; vertices: number; rect: Rect | null; rect_approx?: boolean; rect_reason?: string | null }> } }>;

/** The rectangle a `from` names, read from the describe layout rows. */
export function rectFromTemplate(rows: Rows, src: NonNullable<Region["from"]>): { rect?: Rect; label?: string; approx?: boolean; problem?: string } {
  const { row, problem } = pickLayerRow(rows, src.layer);
  if (!row) return { problem };
  const lay = row.layout;
  if (!lay) return { problem: `layer "${row.name}" was not read with its layout` };
  if (src.use === "bounds") {
    if (!lay.rect) return { problem: `layer "${row.name}" has no comp-space box (${lay.rect_reason ?? "unknown"})` };
    return { rect: lay.rect, label: `bounds of "${row.name}"` };
  }
  if (src.mask === undefined) return { problem: `use 'mask' needs mask (a name or index) for "${row.name}"` };
  let mask: (typeof lay.masks)[number] | undefined;
  if (typeof src.mask === "number") {
    mask = lay.masks[src.mask - 1];
  } else {
    mask = lay.masks.find((m) => m.name === src.mask);
    if (!mask) {
      const part = cmp(src.mask);
      const hits = lay.masks.filter((m) => cmp(m.name).includes(part));
      if (hits.length > 1) return { problem: `${hits.length} masks on "${row.name}" contain "${src.mask}"; use the exact name or the index` };
      mask = hits[0];
    }
  }
  if (!mask) return { problem: `layer "${row.name}" has no mask ${JSON.stringify(src.mask)}` };
  if (!mask.vertices) return { problem: `mask "${mask.name}" on "${row.name}" has no vertices` };
  if (!mask.rect) return { problem: `mask "${mask.name}" on "${row.name}" has no comp-space box (${mask.rect_reason ?? lay.rect_reason ?? "unknown"})` };
  return { rect: mask.rect, label: `mask "${mask.name}" of "${row.name}"`, approx: mask.rect_approx === true };
}

const nearly = (a: number, b: number) => Math.abs(a - b) <= 1e-6;

/**
 * Checks the whole spec against the facts and builds the plan. Every problem
 * is collected, so one refusal lists them all.
 */
export function buildLayoutPlan(
  args: LayoutApplyArgs,
  facts: LayoutFacts,
  templates: Record<string, Rows> = {}
): { problems: string[]; plan: LayoutPlan } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const plan: LayoutPlan = { regions: [], copies: [], warnings, feed_fps: 25, feed_duration: 1 };
  const bad = (m: string) => problems.push(m);
  const layerFact = (key: string) => facts.layers.find((l) => l.key === key);
  const item = (id: number) => facts.items[String(id)];
  const targetId = facts.target?.id;
  const master = args.create_master;
  if (args.comp_id !== undefined && !facts.target) bad(`The target comp ${args.comp_id} does not exist.`);
  if (facts.target && !nearly(facts.target.pixel_aspect, 1)) bad(`The target comp has pixel aspect ${facts.target.pixel_aspect}; only square pixels are supported yet.`);
  const targetFps = master ? master.fps : facts.target?.fps ?? 25;
  const targetDuration = master ? master.duration : facts.target?.duration ?? 1;
  if (master?.target_folder_id !== undefined && facts.folders[String(master.target_folder_id)] !== true) bad(`create_master.target_folder_id ${master.target_folder_id} is not a project folder.`);

  const names = new Set<string>();
  const usedLayerIds = new Set<number>();
  (args.regions ?? []).forEach((r, i) => {
    const tag = `Region "${r.name}"`;
    if (names.has(r.name)) bad(`${tag}: the name is used twice.`);
    names.add(r.name);

    // The rectangle.
    let rect: Rect | undefined = r.rect as Rect | undefined;
    let rectFrom: string | undefined;
    if (r.from) {
      if (args.comp_id === undefined) {
        bad(`${tag}: \`from\` reads a template and needs comp_id, not create_master.`);
      } else {
        const rows = templates[String(r.from.time ?? args.time ?? "now")];
        if (!rows) bad(`${tag}: the template was not read.`);
        else {
          const got = rectFromTemplate(rows, r.from);
          if (got.problem) bad(`${tag}: ${got.problem}.`);
          else {
            rect = got.rect;
            rectFrom = got.label;
            if (got.approx) warnings.push(`${tag}: the rectangle is the control-polygon box of a curved mask (approximate).`);
          }
        }
      }
    }
    if (rect && (rect[2] < 1 || rect[3] < 1)) {
      bad(`${tag}: the rectangle is smaller than 1 px.`);
      rect = undefined;
    }

    // The content.
    const c = r.content as Record<string, any>;
    let size: [number, number] | undefined;
    let content: PlannedRegion["content"] | undefined;
    let feed: PlannedRegion["feed"] | undefined;
    if (c.comp_id !== undefined) {
      const f = item(c.comp_id);
      if (!f || f.kind !== "comp") bad(`${tag}: item ${c.comp_id} is not a comp.`);
      else {
        if (targetId !== undefined && (f.id === targetId || f.contains_target)) bad(`${tag}: comp "${f.name}" is the target or contains it, so it would contain itself.`);
        if (f.contains_unknown) warnings.push(`${tag}: could not tell whether "${f.name}" contains the target (the walk was cut short).`);
        if (!nearly(f.pixel_aspect ?? 1, 1)) bad(`${tag}: comp "${f.name}" has pixel aspect ${f.pixel_aspect}; only square pixels are supported yet.`);
        size = [f.width as number, f.height as number];
        content = { kind: "comp", item_id: f.id, size };
      }
    } else if (c.footage_id !== undefined) {
      const f = item(c.footage_id);
      if (!f || f.kind !== "footage") bad(`${tag}: item ${c.footage_id} is not a footage item.`);
      else {
        if (f.has_video === false) bad(`${tag}: footage "${f.name}" has no video.`);
        if (f.missing) bad(`${tag}: footage "${f.name}" is missing its file.`);
        if (!nearly(f.pixel_aspect ?? 1, 1)) bad(`${tag}: footage "${f.name}" has pixel aspect ${f.pixel_aspect}; only square pixels are supported yet.`);
        if (c.make_feed) {
          const mf = c.make_feed as NonNullable<Extract<z.infer<typeof ContentSchema>, { make_feed: unknown }>["make_feed"]>;
          const fw = mf.width ?? (rect ? Math.max(4, Math.round(rect[2])) : 4);
          const fh = mf.height ?? (rect ? Math.max(4, Math.round(rect[3])) : 4);
          if (mf.target_folder_id !== undefined && facts.folders[String(mf.target_folder_id)] !== true) bad(`${tag}: make_feed.target_folder_id ${mf.target_folder_id} is not a project folder.`);
          const fit: FitMode = mf.fit ?? "fill";
          const place = fitSource(f.width as number, f.height as number, [0, 0, fw, fh], fit);
          feed = { name: mf.name, width: fw, height: fh, fit, place, ...(mf.target_folder_id !== undefined ? { folder_id: mf.target_folder_id } : {}) };
          size = [fw, fh];
          content = { kind: "feed", footage_id: f.id, size: [f.width as number, f.height as number] };
        } else {
          size = [f.width as number, f.height as number];
          content = { kind: "footage", item_id: f.id, size };
        }
      }
    } else if (c.layer) {
      const lf = layerFact(`region:${i}:layer`);
      if (args.comp_id === undefined) bad(`${tag}: an existing layer needs comp_id, not create_master.`);
      else if (!lf || !lf.found) bad(`${tag}: the layer is not in the target comp.`);
      else {
        const nm = `layer "${lf.name}"`;
        if (lf.ambiguous) bad(`${tag}: ${lf.name ? `"${lf.name}"` : "that name"} fits several layers; use id or index.`);
        if (lf.locked) bad(`${tag}: ${nm} is locked.`);
        if (lf.three_d) bad(`${tag}: ${nm} is 3D.`);
        if (lf.parent) bad(`${tag}: ${nm} is parented.`);
        if (lf.kind === "camera" || lf.kind === "light") bad(`${tag}: ${nm} is a camera or light.`);
        if (lf.separated) bad(`${tag}: ${nm} has Position separated into X and Y; a plain write would not apply.`);
        if (lf.is_parent) bad(`${tag}: ${nm} is the parent of other layers, which would move with it.`);
        if (lf.id !== undefined) {
          if (usedLayerIds.has(lf.id)) bad(`${tag}: ${nm} is already filled by another region.`);
          usedLayerIds.add(lf.id);
        }
        if (lf.rotation !== undefined && Math.abs(lf.rotation) > 1e-6) warnings.push(`${tag}: ${nm} is rotated ${lf.rotation} degrees; the placement sets rotation to 0.`);
        if (lf.flipped) warnings.push(`${tag}: ${nm} is flipped (negative scale); the placement writes a positive scale, so the flip is lost.`);
        if ((lf.keyed ?? 0) > 0) bad(`${tag}: ${nm} has keyframes on anchor, position, scale or rotation, which a plain write would not keep.`);
        if (lf.source_width === undefined || lf.source_height === undefined) bad(`${tag}: ${nm} has no source size (a text, shape or null layer).`);
        else if (!nearly(lf.source_pixel_aspect ?? 1, 1)) bad(`${tag}: ${nm} has a source with pixel aspect ${lf.source_pixel_aspect}; only square pixels are supported yet.`);
        else {
          size = [lf.source_width, lf.source_height];
          content = { kind: "layer", layer_id: lf.id, size };
        }
      }
    }

    // Stacking.
    let above: number | undefined;
    let below: number | undefined;
    for (const side of ["above", "below"] as const) {
      if (!r[side]) continue;
      const lf = layerFact(`region:${i}:${side}`);
      if (args.comp_id === undefined) bad(`${tag}: ${side} needs comp_id, not create_master (later regions stack on top of earlier ones).`);
      else if (!lf || !lf.found) bad(`${tag}: the layer to stack ${side} is not in the target comp.`);
      else if (lf.ambiguous) bad(`${tag}: the layer to stack ${side} fits several layers; use id or index.`);
      else if (side === "above") above = lf.id;
      else below = lf.id;
    }

    if (!rect || !size || !content) return;
    const fit: FitMode = r.fit ?? "fill";
    const placement = fitSource(size[0], size[1], rect, fit, r.align);
    const clip = r.clip ?? fit === "fill";
    if (feed) {
      const dev = Math.max(Math.abs(placement.scale[0] - 100), Math.abs(placement.scale[1] - 100));
      if (dev > 0.01) warnings.push(`${tag}: the feed comp is ${feed.width}x${feed.height} for a ${rect[2]}x${rect[3]} region, so it is placed at ${placement.scale[0]}% (whole-pixel comp sizes).`);
    }
    plan.regions.push({
      name: r.name,
      rect,
      ...(rectFrom ? { rect_from: rectFrom } : {}),
      fit,
      placement,
      layer_rect: layerRect(size[0], size[1], placement),
      clip,
      clip_corners: clip ? regionToLayerSpace(rect, placement) : null,
      content,
      ...(feed ? { feed } : {}),
      ...(above !== undefined ? { above } : {}),
      ...(below !== undefined ? { below } : {}),
    });
  });

  (args.copies ?? []).forEach((c, i) => {
    const tag = `Copy ${i + 1}`;
    const lf = layerFact(`copy:${i}:layer`);
    const to = item(c.to_comp_id);
    const from = item(c.from.comp_id);
    if (!from || from.kind !== "comp") bad(`${tag}: the source comp ${c.from.comp_id} does not exist.`);
    if (!to || to.kind !== "comp") bad(`${tag}: the destination comp ${c.to_comp_id} does not exist.`);
    if (c.from.comp_id === c.to_comp_id) bad(`${tag}: the source and destination are the same comp.`);
    if (!lf || !lf.found) {
      if (from?.kind === "comp") bad(`${tag}: the layer is not in the source comp.`);
      return;
    }
    if (lf.ambiguous) bad(`${tag}: that layer name fits several layers; use id or index.`);
    if ((lf.effects ?? 0) > 0) bad(`${tag}: layer "${lf.name}" has effects; undoing a copy of such a layer has crashed After Effects.`);
    if (lf.parent) warnings.push(`${tag}: layer "${lf.name}" has a parent (layer ${lf.parent}); the copy does not carry the parent link, so it will sit unparented.`);
    plan.copies.push({
      from_comp_id: c.from.comp_id,
      from_layer_id: lf.id as number,
      from_layer_name: lf.name,
      to_comp_id: c.to_comp_id,
      ...(c.name ? { name: c.name } : {}),
      camera: lf.kind === "camera",
      as_active_camera: c.as_active_camera !== false,
    });
  });

  plan.feed_fps = targetFps;
  plan.feed_duration = targetDuration;
  return { problems, plan };
}

// ---------- host plan and summaries ----------

export function hostPlan(args: LayoutApplyArgs, plan: LayoutPlan) {
  const m = args.create_master;
  return {
    target: m
      ? { create: { name: m.name, width: m.width, height: m.height, fps: m.fps, duration: m.duration, bg_color: m.bg_color, folder_id: m.target_folder_id } }
      : { comp_id: args.comp_id },
    feed_fps: plan.feed_fps,
    feed_duration: plan.feed_duration,
    regions: plan.regions.map((r) => ({
      name: r.name,
      content: r.content.kind === "feed"
        ? { kind: "feed", footage_id: r.content.footage_id, size: r.content.size, feed: r.feed }
        : r.content.kind === "layer"
          ? { kind: "layer", layer_id: r.content.layer_id, size: r.content.size }
          : { kind: r.content.kind, item_id: r.content.item_id, size: r.content.size },
      place: r.placement,
      clip: r.clip_corners,
      above: r.above,
      below: r.below,
    })),
    copies: plan.copies.map((c) => ({ from_comp_id: c.from_comp_id, from_layer_id: c.from_layer_id, to_comp_id: c.to_comp_id, name: c.name, as_active_camera: c.as_active_camera })),
  };
}

const ROWS = 200;
/** Warnings listed in a result; `warnings_total` says how many there were. */
const WARNINGS_SHOWN = 20;

function capWarnings(all: string[]): { warnings: string[]; warnings_total?: number } {
  return all.length <= WARNINGS_SHOWN ? { warnings: all } : { warnings: all.slice(0, WARNINGS_SHOWN), warnings_total: all.length };
}

const RECEIPT_FULL_LAYERS = 20;

/**
 * Above 20 regions and copies the receipt's before and after reads keep only the layers that have a mismatch
 * (and the comps' own facts), with the count, as the many-item interpretation receipt does: a 100-region layout
 * read back as every layer of every comp twice was most of the reply.
 */
export function trimLayoutReceipt<T>(result: T, requested: number): T {
  const r = result as unknown as { receipt?: { before?: unknown; after?: unknown; mismatches?: Array<{ path: string }> } };
  const receipt = r?.receipt;
  if (!receipt || requested <= RECEIPT_FULL_LAYERS) return result;
  const badNames = new Set<string>();
  const badIds = new Set<number>();
  for (const mm of receipt.mismatches ?? []) {
    const placed = /^placed\[(.*?)\]/.exec(mm.path);
    if (placed) badNames.add(placed[1]);
    const byId = /^(?:copies|layers)\[(\d+)\]/.exec(mm.path);
    if (byId) badIds.add(Number(byId[1]));
  }
  const shrink = (v: unknown) => {
    const read = readOf(v);
    if (!read) return v;
    return {
      trimmed: true,
      comps: read.comps.map((c) => ({
        ...c,
        layers_read: c.layers?.length ?? 0,
        layers: (c.layers ?? []).filter((l) => badIds.has(l.id) || badNames.has(l.name)),
      })),
    };
  };
  return { ...r, receipt: { ...receipt, before: shrink(receipt.before), after: shrink(receipt.after) } } as unknown as T;
}

function planSummary(plan: LayoutPlan) {
  return {
    regions: plan.regions.slice(0, ROWS).map((r) => ({
      name: r.name,
      rect: r.rect,
      ...(r.rect_from ? { rect_from: r.rect_from } : {}),
      fit: r.fit,
      scale: r.placement.scale,
      position: r.placement.position,
      anchor: r.placement.anchor,
      layer_rect: r.layer_rect,
      clip: r.clip,
      content: r.content.kind,
      ...(r.feed ? { creates: { comp: r.feed.name, size: [r.feed.width, r.feed.height], fit: r.feed.fit } } : {}),
    })),
    copies: plan.copies.slice(0, ROWS).map((c) => ({ from_comp_id: c.from_comp_id, layer: c.from_layer_name, to_comp_id: c.to_comp_id, camera: c.camera, as_active_camera: c.camera ? c.as_active_camera : undefined })),
    ...capWarnings(plan.warnings),
  };
}

// ---------- read-back ----------

interface ReadLayer {
  id: number;
  index: number;
  name: string;
  enabled: boolean;
  camera: boolean;
  rect: Rect | null;
  camera_facts?: { zoom?: number; position?: number[]; point_of_interest?: number[]; two_node?: boolean; keys?: { zoom?: number; position?: number; point_of_interest?: number } };
}
interface ReadComp {
  id: number;
  found: boolean;
  name?: string;
  width?: number;
  height?: number;
  num_layers?: number;
  layers: ReadLayer[];
  truncated?: boolean;
}
interface LayoutRead {
  comps: ReadComp[];
}

interface Written extends Record<string, unknown> {
  refused?: boolean;
  no_op?: boolean;
  problems?: string[];
  problems_total?: number;
  comp_id?: number;
  created?: Array<{ kind: string; role: string; id: number; name: string }>;
  placed?: Array<{ name: string; layer_id: number; index?: number; feed_comp_id?: number; clip: boolean }>;
  copies?: Array<{ to_comp_id: number; from_layer_id: number; layer_id?: number; name?: string; camera: boolean; active_camera?: boolean; unidentified?: boolean }>;
  warnings?: string[];
}

const readOf = (v: unknown): LayoutRead | null => (v && typeof v === "object" && Array.isArray((v as LayoutRead).comps) ? (v as LayoutRead) : null);
const compOf = (r: LayoutRead | null, id: number | undefined) => r?.comps.find((c) => c.id === id);
const CHECKS = 50;
const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-3;
const nearList = (a: number[] | undefined, b: number[] | undefined) => !a || !b || (a.length === b.length && a.every((v, i) => near(v, b[i])));

export const CAMERA_COPY_NOTE =
  "Layer.copyToComp on a camera layer has not been measured on After Effects yet. The read-back compared, between the source and the copy, the value at time 0 of zoom, position and point of interest, how many keys each has, and one-node or two-node. Key times and values after the first, expressions, orientation and rotation, focus distance and aperture were NOT compared. Treat the copy as unverified until a live test has shown it faithful.";

export function layoutMismatches(plan: LayoutPlan, args: LayoutApplyArgs, before: unknown, after: unknown, w: Written): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const b = readOf(before);
  const a = readOf(after);
  if (!a) return m;
  const targetId = w.comp_id;
  const targetAfter = compOf(a, targetId);
  const targetBefore = args.comp_id !== undefined ? compOf(b, args.comp_id) : undefined;
  let capped = 0;
  const push = (x: ReceiptMismatch) => {
    if (m.length < CHECKS) m.push(x);
    else capped++;
  };
  expectThat(m, !!targetAfter?.found, "target", targetId, targetAfter?.found, "The target comp is not in the read-back");
  const touched = new Set<number>();
  for (const row of w.placed ?? []) {
    touched.add(row.layer_id);
    const planned = plan.regions.find((r) => r.name === row.name);
    const layer = targetAfter?.layers.find((l) => l.id === row.layer_id);
    if (!planned) continue;
    if (!layer) {
      push({ path: `placed[${row.name}]`, expected: row.layer_id, actual: undefined, message: `Layer "${row.name}" is not in the target comp after the write` });
      continue;
    }
    if (layer.name !== row.name) push({ path: `placed[${row.name}].name`, expected: row.name, actual: layer.name, message: "The layer has another name" });
    if (!layer.rect) push({ path: `placed[${row.name}].rect`, expected: planned.layer_rect, actual: null, message: "The layer's box could not be read back" });
    else if (!sameRect(layer.rect, planned.layer_rect)) push({ path: `placed[${row.name}].rect`, expected: planned.layer_rect, actual: layer.rect, message: "The placed layer covers another box than planned" });
  }
  let feedIndex = 0;
  for (const c of w.created ?? []) {
    const comp = compOf(a, c.id);
    if (!comp?.found) {
      push({ path: `created[${c.name}]`, expected: c.id, actual: undefined, message: `The ${c.role} comp "${c.name}" is not in the read-back` });
      continue;
    }
    if (c.role === "feed") {
      // The host creates feed comps in region order, so the n-th feed is the n-th region that has one (names can repeat).
      const planned = plan.regions.filter((r) => r.feed)[feedIndex++];
      if (planned?.feed && (comp.width !== planned.feed.width || comp.height !== planned.feed.height)) {
        push({ path: `created[${c.name}].size`, expected: [planned.feed.width, planned.feed.height], actual: [comp.width, comp.height], message: "The feed comp has another size than planned" });
      }
      if (comp.num_layers !== 1) push({ path: `created[${c.name}].num_layers`, expected: 1, actual: comp.num_layers, message: "The feed comp should hold exactly the footage layer" });
    }
  }
  // Copies: the layer is in the destination, is a camera when the source was, and matches it.
  const gained = new Map<number, number>();
  for (const cp of w.copies ?? []) {
    if (cp.unidentified || cp.layer_id === undefined) {
      push({ path: `copies[${cp.from_layer_id}]`, expected: "one new layer", actual: "unidentified", message: "The copied layer could not be identified" });
      continue;
    }
    touched.add(cp.layer_id);
    gained.set(cp.to_comp_id, (gained.get(cp.to_comp_id) ?? 0) + 1);
    const dest = compOf(a, cp.to_comp_id);
    const layer = dest?.layers.find((l) => l.id === cp.layer_id);
    if (!layer) {
      push({ path: `copies[${cp.layer_id}]`, expected: cp.layer_id, actual: undefined, message: `The copy is not in comp ${cp.to_comp_id} after the write` });
      continue;
    }
    if (layer.camera !== cp.camera) push({ path: `copies[${cp.layer_id}].camera`, expected: cp.camera, actual: layer.camera, message: "The copy is not the same kind of layer as the source" });
    if (cp.camera) {
      const planned = plan.copies.find((c) => c.from_layer_id === cp.from_layer_id && c.to_comp_id === cp.to_comp_id);
      const src = planned ? compOf(b, planned.from_comp_id)?.layers.find((l) => l.id === cp.from_layer_id) : undefined;
      const sf = src?.camera_facts;
      const cf = layer.camera_facts;
      if (sf && cf) {
        if (sf.two_node !== undefined && cf.two_node !== undefined && sf.two_node !== cf.two_node) push({ path: `copies[${cp.layer_id}].two_node`, expected: sf.two_node, actual: cf.two_node, message: "The copied camera is not the same kind of camera (one-node or two-node)" });
        for (const key of ["zoom", "position", "point_of_interest"] as const) {
          const was = sf.keys?.[key];
          const now = cf.keys?.[key];
          if (was !== undefined && now !== undefined && was !== now) push({ path: `copies[${cp.layer_id}].keys.${key}`, expected: was, actual: now, message: `The copied camera has another number of keys on ${key}` });
        }
        if (sf.zoom !== undefined && !near(sf.zoom, cf.zoom)) push({ path: `copies[${cp.layer_id}].zoom`, expected: sf.zoom, actual: cf.zoom, message: "The copied camera has another zoom" });
        if (!nearList(sf.position, cf.position)) push({ path: `copies[${cp.layer_id}].position`, expected: sf.position, actual: cf.position, message: "The copied camera has another position" });
        if (!nearList(sf.point_of_interest, cf.point_of_interest)) push({ path: `copies[${cp.layer_id}].point_of_interest`, expected: sf.point_of_interest, actual: cf.point_of_interest, message: "The copied camera has another point of interest" });
      }
    }
  }
  // A destination other than the target gained exactly the copies made into it.
  for (const [destId, n] of gained) {
    if (destId === targetId) continue;
    const was = compOf(b, destId)?.num_layers;
    const now = compOf(a, destId)?.num_layers;
    if (was !== undefined && now !== undefined && now !== was + n) push({ path: `comp[${destId}].num_layers`, expected: was + n, actual: now, message: "The destination gained another number of layers than the copies made" });
  }
  // Layers of the target that the call did not name are as they were.
  if (targetBefore?.found && targetAfter?.found && !targetBefore.truncated) {
    const named = new Set<number>([...touched]);
    for (const r of plan.regions) if (r.content.kind === "layer" && r.content.layer_id !== undefined) named.add(r.content.layer_id);
    for (const was of targetBefore.layers) {
      if (named.has(was.id)) continue;
      const now = targetAfter.layers.find((l) => l.id === was.id);
      if (!now) {
        push({ path: `layers[${was.id}]`, expected: was.name, actual: undefined, message: `Layer "${was.name}" is gone though the call did not name it` });
        continue;
      }
      if (was.rect && now.rect && !sameRect(was.rect, now.rect, 0.01)) push({ path: `layers[${was.id}].rect`, expected: was.rect, actual: now.rect, message: `Layer "${was.name}" moved though the call did not name it` });
      if (was.enabled !== now.enabled) push({ path: `layers[${was.id}].enabled`, expected: was.enabled, actual: now.enabled, message: `Layer "${was.name}" was switched though the call did not name it` });
    }
  }
  if (capped > 0) m.push({ path: "mismatches", expected: "no more mismatches", actual: capped, message: `${capped} more mismatch(es) are not listed (the first ${CHECKS} are shown)` });
  return m;
}

// ---------- tool ----------

const CALL = "ae_layout_apply";

async function readHost<T>(ctx: ToolContext, host: string, args: Record<string, unknown>, label: string): Promise<T> {
  const res = await ctx.bridge.callHost<T>(host, args, { label, mutates: false, toolName: CALL });
  return res.result;
}

export const placementTools: ToolDefinition<any>[] = [
  {
    name: CALL,
    description:
      "Build or fill a layout from a declared spec in ONE undo group guarded by `expect`: a target comp (comp_id, or create_master to make a square-pixel comp), `regions` each with a name and a rectangle - typed [x, y, w, h] in comp pixels, or `from` a mask or layer of a template comp (the box ae_describe_comp layout:true reports) - filled with a comp (comp_id), a footage item (footage_id), a layer already in the comp (layer), or a feed comp made for a footage item (footage_id with make_feed), fitted fill / contain / stretch with an alignment, optionally clipped to the region by a rectangular mask, and stacked above or below a layer; and `copies` of layers (cameras) from one comp into another. " +
      "Everything is planned and checked before After Effects is touched, and one refusal lists every problem: duplicate names, a comp that would contain itself, a locked, keyframed, 3D, parented or camera layer, a pixel aspect other than 1, a mask with no vertices, a copied layer with effects (undoing such a copy has crashed AE). `dry_run` returns the plan (every rectangle, scale, position, what would be created) and changes nothing. " +
      "If a step throws, what the call made is removed. The read-back (a separate evalScript) checks each placed layer covers the planned box (within 0.5 px, the layer's box, not the clip), that created comps exist, that layers the call did not name are unchanged, and that each copy arrived. Later regions stack above earlier ones unless above / below says otherwise. " +
      "Camera copies use Layer.copyToComp, which has not been measured on a real Cinema 4D camera: the result carries camera_copy.verified: false, and the read-back only compares zoom, position and point of interest, not keyframes or expressions. There is no property-by-property rebuild. " +
      "Up to 100 regions and 100 copies a call; at most 200 rows come back. Filling an existing layer renames it, sets anchor / position / scale and resets rotation to 0 (a rotation or a flip is lost and the result says so); a layer that is a parent, has Position separated, or is filled twice is refused; copying a parented layer leaves the copy unparented (warned). Not for 3D layers, animation or non-square pixels. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeLayoutApplySchema,
    handler: async (args: LayoutApplyArgs, ctx) => {
      if (!args.dry_run) {
        ctx.quarantine.assertClear();
        // Guard first, so a wrong project fails with the guard error and not a not_found from another project's ids.
        await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, ctx.bridge.newOpId());
      }
      const request = factsRequest(args);
      const facts = await readHost<LayoutFacts>(ctx, "layoutFacts", { ...request, expect: { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id } }, `${CALL} (${args.dry_run ? "dry run" : "plan"})`);

      // Templates: one layout read of the target comp per distinct time a `from` asks for.
      const templates: Record<string, Rows> = {};
      const times = new Set<string>();
      for (const r of args.regions ?? []) if (r.from) times.add(String(r.from.time ?? args.time ?? "now"));
      if (times.size > 5) return { ok: false, error: "layout_rejected", applied: false, no_op: true, problems: [`\`from\` asks for ${times.size} different times; at most 5.`] };
      if (args.comp_id !== undefined) {
        for (const key of times) {
          const raw = await readHost<DescribeRaw>(
            ctx,
            "describeRead",
            { comp_id: args.comp_id, layout: true, layout_time: key === "now" ? undefined : Number(key), max_layers: 500, max_masks_per_layer: 50 },
            `${CALL} (template read)`
          );
          templates[key] = raw.layers as Rows;
        }
      }

      const { problems, plan } = buildLayoutPlan(args, facts, templates);
      if (problems.length > 0) {
        return { ok: false, error: "layout_rejected", applied: false, no_op: true, message: `${problems.length} problem(s); nothing was written.`, problems: problems.slice(0, 50), problems_total: problems.length };
      }
      if (args.dry_run) return { ok: true, dry_run: true, target: args.comp_id !== undefined ? { comp_id: args.comp_id } : { create_master: args.create_master }, plan: planSummary(plan) };

      const total = plan.regions.length + plan.copies.length;
      const cameraCopies = plan.copies.some((c) => c.camera);
      const result = await runGuardedWrite<Written>(ctx, {
        toolName: CALL,
        label: `${CALL}(${plan.regions.length} region${plan.regions.length === 1 ? "" : "s"}, ${plan.copies.length} cop${plan.copies.length === 1 ? "y" : "ies"})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, written) => {
          const ids = new Set<number>();
          if (args.comp_id !== undefined) ids.add(args.comp_id);
          for (const c of plan.copies) {
            ids.add(c.to_comp_id);
            ids.add(c.from_comp_id);
          }
          if (phase === "after") {
            if (written?.comp_id !== undefined) ids.add(written.comp_id);
            for (const c of written?.created ?? []) ids.add(c.id);
          }
          return ids.size === 0 ? null : { host: "layoutRead", args: { comp_ids: [...ids] } };
        },
        write: { host: "layoutApply", args: { ...hostPlan(args, plan), label: "Chroma AE MCP: layout" }, timeoutMs: total > 20 ? SLOW_TIMEOUT_MS : undefined },
        check: (before, after, w) => (w.refused ? [] : layoutMismatches(plan, args, before, after, w)),
        present: (_before, _after, w) => {
          if (w.refused) return { ok: false, error: "layout_rejected", applied: false, no_op: true, problems: w.problems, message: "The project changed since the plan was made; nothing was written. Re-read and try again." };
          const placed = (w.placed ?? []).slice(0, ROWS).map((p) => {
            const r = plan.regions.find((x) => x.name === p.name);
            return { ...p, ...(r ? { rect: r.layer_rect, scale: r.placement.scale, position: r.placement.position } : {}) };
          });
          return {
            comp_id: w.comp_id,
            created: (w.created ?? []).slice(0, ROWS),
            placed,
            copies: (w.copies ?? []).slice(0, 100),
            ...capWarnings([...new Set([...plan.warnings, ...(w.warnings ?? [])])]),
            ...(cameraCopies ? { camera_copy: { verified: false, note: CAMERA_COPY_NOTE } } : {}),
          };
        },
      });
      return trimLayoutReceipt(result, total);
    },
  },
];
