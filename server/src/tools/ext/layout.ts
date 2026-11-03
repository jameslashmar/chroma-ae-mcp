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
import { briefPath, readBrief } from "./brief.js";
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

export const AePurgeUnusedSchema = z.object({
  kinds: z.array(z.enum(["footage", "solid", "placeholder"])).min(1).optional().describe("Which unused items. Default all three."),
  empty_folders: z.boolean().optional().describe("Also remove folders with nothing in them. Default false."),
  keep: z.array(z.number().int()).max(500).optional().describe("Item ids to leave alone."),
  apply: z.boolean().optional().describe("Remove them. Default false: list what would go. Needs expect."),
  expect: ExpectSchema.optional(),
});

interface Unused {
  items: Array<{ id: number; name: string; kind: string; file: string | null }>;
  folders: Array<{ id: number; name: string; kind: string }>;
  numItems: number;
}

// ---------- MOGRT ----------

export const AeExportMogrtSchema = z.object({
  comp_id: z.number().int().describe("A comp with Essential Graphics controllers."),
  path: z.string().min(1).optional().describe("Absolute .mogrt path. Default: AE's own Essential Graphics folder."),
  overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
  expect: ExpectSchema,
});

// ---------- house style ----------

export const AeHouseStyleCheckSchema = z.object({
  comp_id: z.number().int(),
  brand_colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(40).optional().describe("Instead of the brief's brand colours."),
  fonts: z.array(z.string().min(1)).max(20).optional().describe("Instead of the brief's fonts."),
  color_tolerance: z.number().min(0).max(100).optional().describe("Delta E (CIE76) within which a colour counts as the brand colour. Default 12."),
  neutrals_ok: z.boolean().optional().describe("Black, white and greys pass the palette check. Default true."),
  min_font_size: z.number().positive().optional().describe("Flag text smaller than this, in pixels."),
  safe_area: z.boolean().optional().describe("Check text layers against title safe at the check time. Default true."),
  title_safe: z.number().min(0).max(0.5).optional().describe("Default 0.2, AE's."),
  time: z.number().optional().describe("When to check the safe area. Default the comp's current time."),
});

interface StyleLayer {
  index: number;
  id: number;
  name: string;
  kind: "text" | "shape" | "solid";
  enabled: boolean;
  font?: string;
  family?: string;
  font_size?: number;
  font_missing?: boolean;
  colours: Array<{ where: string; role: string; rgb: Rgb | null }>;
}

export interface StyleFinding {
  severity: "medium" | "low" | "info";
  kind: "missing_font" | "off_brand_font" | "off_palette_colour" | "small_text" | "cut_off" | "outside_safe";
  layer: { index: number; id: number; name: string };
  message: string;
  [k: string]: unknown;
}

export function styleFindings(
  layers: StyleLayer[],
  opts: { brand_colors: string[]; fonts: string[]; tolerance: number; neutrals_ok: boolean; min_font_size?: number }
): StyleFinding[] {
  const out: StyleFinding[] = [];
  for (const l of layers) {
    const layer = { index: l.index, id: l.id, name: l.name };
    if (l.kind === "text") {
      if (l.font_missing) out.push({ severity: "medium", kind: "missing_font", layer, message: `"${l.name}" uses ${l.font}, which is missing; AE is showing a substitute.`, font: l.font });
      if (opts.fonts.length && l.font && !fontMatches(l, opts.fonts)) {
        out.push({ severity: "medium", kind: "off_brand_font", layer, message: `"${l.name}" is set in ${l.family ?? l.font} (${l.font}), not one of the brief's fonts: ${opts.fonts.join(", ")}.`, font: l.font });
      }
      if (opts.min_font_size && l.font_size !== undefined && l.font_size < opts.min_font_size) {
        out.push({ severity: "low", kind: "small_text", layer, message: `"${l.name}" is ${l.font_size} px, under the ${opts.min_font_size} px minimum.`, font_size: l.font_size });
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
      "re-checking each is still unused first. Comps are never removed. The read-back (a separate evalScript) checks they are gone. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePurgeUnusedSchema,
    handler: async (args: z.infer<typeof AePurgeUnusedSchema>, ctx: ToolContext) => {
      const read = { host: "unusedItems", args: { kinds: args.kinds, empty_folders: args.empty_folders } };
      const found = (await ctx.bridge.callHost<Unused>(read.host, read.args, { label: "ae_purge_unused (scan)", mutates: false, toolName: "ae_purge_unused" })).result;
      const keep = new Set(args.keep ?? []);
      const targets = [...found.items, ...found.folders].filter((i) => !keep.has(i.id));
      if (!args.apply || targets.length === 0) return { ok: true, dry_run: !args.apply, count: targets.length, items: targets };
      if (!args.expect) return { ok: false, error: "bad_args", message: "apply needs expect." };
      // Folders last, so a folder emptied by this purge isn't refused as non-empty.
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
        present: (_before, after, w) => ({ removed: w.removed, numItems: (after as Unused | null)?.numItems }),
      });
    },
  },
  {
    name: "ae_export_mogrt",
    description:
      "Export a comp's Essential Graphics template as a .mogrt, from the saved project (ae_save first; AE exports what is on disk), to `path` or AE's own Essential Graphics folder. " +
      "Guarded by `expect`; no undo group, since it writes a file, not the project. Dialogs are never suppressed: if AE asks something, the call says so and ae_dialogs shows it. " +
      "With a path, the file is checked on disk (new, not empty). Pairs with premiere-pro-mcp, which can place the template in a sequence. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeExportMogrtSchema,
    handler: async (args: z.infer<typeof AeExportMogrtSchema>, ctx: ToolContext) => {
      if (args.path !== undefined) {
        if (!path.isAbsolute(args.path) || !/\.mogrt$/i.test(args.path)) return { ok: false, error: "bad_path", message: `Give an absolute .mogrt path: ${args.path}` };
        if (fs.existsSync(args.path) && !args.overwrite) return { ok: false, error: "exists", message: `${args.path} exists; pass overwrite to replace it.` };
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
      }
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const started = Date.now();
      try {
        return await ctx.queue.run(`ae_export_mogrt(${args.comp_id})`, async () => {
          await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, opId);
          const res = await ctx.bridge.evalRaw<{ exported: boolean; controllers: number; template_name: string }>({
            id: opId,
            script: buildJsxCall("exportMogrt", { comp_id: args.comp_id, path: args.path?.replace(/\\/g, "/"), overwrite: args.overwrite, expect: args.expect }),
            label: `ae_export_mogrt(${args.comp_id})`,
            mutates: false,
            toolName: "ae_export_mogrt",
          });
          const r = res.result;
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
      "text above a minimum size, and text inside title safe at the check time. brand_colors and fonts override the brief. Read-only; findings come most severe first, with the nearest brand colour for each off-palette one. " +
      "Nested comps are checked by running it on them.",
    schema: AeHouseStyleCheckSchema,
    handler: async (args: z.infer<typeof AeHouseStyleCheckSchema>, ctx: ToolContext) => {
      const status = (await ctx.bridge.callHost<{ project_path: string }>("status", {}, { label: "ae_house_style_check (status)", mutates: false, toolName: "ae_house_style_check" })).result;
      const brief = status.project_path && status.project_path !== "<unsaved>" ? readBrief(briefPath(status.project_path)) : null;
      const brandColors = args.brand_colors ?? brief?.brand_colors ?? [];
      const fonts = args.fonts ?? brief?.fonts ?? [];
      const scan = (
        await ctx.bridge.callHost<{ width: number; height: number; time: number; layers: StyleLayer[] }>("styleScan", { comp_id: args.comp_id }, {
          label: "ae_house_style_check (scan)",
          mutates: false,
          toolName: "ae_house_style_check",
        })
      ).result;
      const findings: StyleFinding[] = styleFindings(scan.layers, {
        brand_colors: brandColors,
        fonts,
        tolerance: args.color_tolerance ?? 12,
        neutrals_ok: args.neutrals_ok !== false,
        min_font_size: args.min_font_size,
      });
      if (args.safe_area !== false) {
        const t = args.time ?? scan.time;
        for (const l of scan.layers.filter((x) => x.kind === "text" && x.enabled)) {
          const b = (
            await ctx.bridge.callHost<LayerBounds>("layerBoundsAt", { comp_id: args.comp_id, layer: { id: l.id }, times: [t] }, {
              label: `ae_house_style_check (bounds ${l.name})`,
              mutates: false,
              toolName: "ae_house_style_check",
            })
          ).result;
          for (const f of reviewBounds(b, { width: scan.width, height: scan.height }, { action: 0.1, title: args.title_safe ?? 0.2 })) {
            findings.push({ severity: f.severity === "info" ? "low" : f.severity, kind: f.kind as StyleFinding["kind"], layer: f.layer, message: f.message, bounds: f.bounds, suggested_shift: f.suggested_shift });
          }
        }
      }
      const counts = { medium: 0, low: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      return {
        ok: true,
        clean: findings.length === 0,
        used: { brand_colors: brandColors, fonts, from_brief: Boolean(brief) && !args.brand_colors && !args.fonts },
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
