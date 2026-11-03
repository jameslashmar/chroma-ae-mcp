/**
 * server/src/tools/ext/reframe.ts
 *
 * ae_reframe: social cut-downs. Copies a comp to 16:9, 1:1, 4:5, 9:16 (or any
 * size) and re-lays out its top-level layers: backgrounds cover the new
 * frame, everything else (controller nulls included) is pinned to the nearest
 * edge or the centre of the safe area and shrunk if it no longer fits;
 * children follow their parents. A guide layer shows the safe area. The
 * layout is read back in a separate evalScript and layers outside the safe
 * area are listed, for the agent to look at with ae_contact_sheet.
 */

import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Default safe margins (fractions of the frame) per aspect. 16:9 is the usual
 * 90% title safe. 9:16 leaves room for the platform's own UI on vertical
 * video (caption and buttons at the bottom, account name at the top); these
 * are approximations, so a brief with a platform's own numbers wins.
 */
export const DEFAULT_MARGINS: Record<string, Margins> = {
  "16:9": { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
  "1:1": { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
  "4:5": { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
  "9:16": { top: 0.12, bottom: 0.2, left: 0.06, right: 0.06 },
};
const FALLBACK_MARGINS: Margins = { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };

export function parseAspect(aspect: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(aspect);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}

const MIN_SIZE = 4;
const MAX_SIZE = 30000;

function even(n: number): number {
  return Math.max(4, Math.round(n / 2) * 2);
}

/** Target size from an aspect, keeping the source's short side (1920x1080 to 9:16 gives 1080x1920). */
export function sizeForAspect(srcW: number, srcH: number, ratio: number): { width: number; height: number } {
  const short = Math.min(srcW, srcH);
  if (ratio >= 1) return { width: even(short * ratio), height: even(short) };
  return { width: even(short), height: even(short / ratio) };
}

/** The named aspect closest to a size, if within 1%, for picking default margins. */
export function aspectName(w: number, h: number): string | undefined {
  const r = w / h;
  return Object.keys(DEFAULT_MARGINS).find((k) => Math.abs(parseAspect(k)! - r) / r < 0.01);
}

export function marginsFor(w: number, h: number, override?: Partial<Margins>): Margins {
  const base = DEFAULT_MARGINS[aspectName(w, h) ?? ""] ?? FALLBACK_MARGINS;
  return { ...base, ...(override ?? {}) };
}

const MarginsSchema = z
  .object({
    top: z.number().min(0).max(0.45).optional(),
    bottom: z.number().min(0).max(0.45).optional(),
    left: z.number().min(0).max(0.45).optional(),
    right: z.number().min(0).max(0.45).optional(),
  })
  .describe("Safe margins as fractions of the frame, e.g. { bottom: 0.25 } for a platform with a tall caption area.");

export const AeReframeSchema = z.object({
  comp_id: z.number().int().describe("The approved comp to reframe."),
  targets: z
    .array(
      z.object({
        aspect: z.string().min(3).describe("'16:9', '1:1', '4:5', '9:16', or any 'w:h'."),
        width: z.number().int().min(4).max(30000).optional().describe("Exact size instead of keeping the source's short side."),
        height: z.number().int().min(4).max(30000).optional(),
        name: z.string().min(1).max(200).optional().describe("Default '<comp> <w>x<h>'."),
        margins: MarginsSchema.optional(),
      })
    )
    .min(1)
    .max(6),
  source_margins: MarginsSchema.optional().describe("The source comp's safe margins, if not the defaults for its aspect."),
  shrink: z.boolean().optional().describe("Shrink a pinned layer that no longer fits the safe area. Default true."),
  guide: z.boolean().optional().describe("Add a guide layer (not rendered) outlining the safe area. Default true."),
  expect: ExpectSchema,
});

type Args = z.infer<typeof AeReframeSchema>;

interface Made {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  safe: { left: number; top: number; right: number; bottom: number };
  guide_layer_id: number | null;
  layers: Array<Record<string, unknown>>;
}

export function planTargets(args: Args, srcW: number, srcH: number, srcName: string) {
  const problems: string[] = [];
  const targets = args.targets.map((t) => {
    const ratio = parseAspect(t.aspect);
    let size: { width: number; height: number };
    if (t.width && t.height) {
      size = { width: t.width, height: t.height };
    } else if (ratio === undefined) {
      problems.push(`"${t.aspect}" is not an aspect like 9:16`);
      size = { width: srcW, height: srcH };
    } else if (t.width) {
      // A lone width: the height follows from the aspect.
      size = { width: t.width, height: even(t.width / ratio) };
    } else if (t.height) {
      size = { width: even(t.height * ratio), height: t.height };
    } else {
      size = sizeForAspect(srcW, srcH, ratio);
    }
    if (size.width < MIN_SIZE || size.height < MIN_SIZE || size.width > MAX_SIZE || size.height > MAX_SIZE) {
      problems.push(`"${t.aspect}" gives ${size.width}x${size.height}; a comp must be ${MIN_SIZE} to ${MAX_SIZE} pixels on each side (give width and height)`);
    }
    return {
      aspect: t.aspect,
      name: t.name ?? `${srcName} ${size.width}x${size.height}`,
      width: size.width,
      height: size.height,
      margins: marginsFor(size.width, size.height, t.margins),
    };
  });
  return { targets, problems };
}

export const reframeTools: ToolDefinition<any>[] = [
  {
    name: "ae_reframe",
    description:
      "Social cut-downs: copy a comp to other aspects (16:9, 1:1, 4:5, 9:16, or any w:h; the source's short side is kept, so 1920x1080 gives 1080x1920) and re-lay out its top-level layers. " +
      "Backgrounds (footage, solids, adjustment and shape layers covering the frame) are scaled to cover the new frame. Everything else, controller nulls included, is pinned to the nearest edge or centre of the safe area, keeping its margin, and shrunk if it no longer fits; keys move with it; children follow their parent. 3D layers, cameras and lights move with the frame's centre. Precomps are treated like any other layer (shrunk to fit), so reframe inside them if they need their own layout. " +
      "Default safe margins: 5% on 16:9, 6% on 1:1 and 4:5, and on 9:16 12% top, 20% bottom, 6% sides for platform UI; override with `margins` (a brief's platform numbers win). A guide layer outlines the safe area. " +
      "One undo group for every size, guarded by `expect`, with an auto checkpoint. The layout is read back in a separate evalScript: `outside_safe` lists layers still past the safe area. Look at each new comp (ae_contact_sheet) before calling it done. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeReframeSchema,
    handler: async (args: Args, ctx) => {
      const src = await ctx.bridge.evalRaw<{ name: string; width: number; height: number }>({
        id: `${ctx.bridge.newOpId()}_reframe_src`,
        script: buildJsxCall("getComp", { comp_id: args.comp_id }),
        label: "ae_reframe (source)",
        mutates: false,
        toolName: "ae_reframe",
      });
      const { width: srcW, height: srcH, name: srcName } = src.result;
      const { targets, problems } = planTargets(args, srcW, srcH, srcName);
      if (problems.length > 0) return { ok: false, error: "bad_args", problems };

      ctx.quarantine.assertClear();
      const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
      const opId = ctx.bridge.newOpId();
      const projectSnapshot = (suffix: string) =>
        ctx.bridge.evalRaw({
          id: `${opId}_${suffix}`,
          script: buildJsxCall("snapshotForReceipt", {}),
          label: `ae_reframe (${suffix} snapshot)`,
          mutates: false,
          toolName: "ae_reframe",
        });
      try {
        return await ctx.queue.run("ae_reframe", async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_reframe");
          const before = await projectSnapshot("before");
          const write = await ctx.bridge.evalRaw<{ source: unknown; comps: Made[] }>({
            id: opId,
            script: buildJsxCall("reframeComp", {
              expect,
              comp_id: args.comp_id,
              targets,
              source_margins: marginsFor(srcW, srcH, args.source_margins),
              shrink: args.shrink !== false,
              guide: args.guide !== false,
            }),
            label: `ae_reframe(${targets.map((t) => t.aspect).join(", ")})`,
            mutates: true,
            toolName: "ae_reframe",
          });
          const made = write.result.comps;
          // Separate evalScripts for the read-back. The comps exist from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () => projectSnapshot("after"));
          const reportRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<{
              comps: Array<{ comp_id: number; width: number; height: number; outside_safe: unknown[] }>;
            }>({
              id: `${opId}_report`,
              script: buildJsxCall("reframeReport", { comps: made.map((m) => ({ comp_id: m.comp_id, safe: m.safe })) }),
              label: "ae_reframe (read back)",
              mutates: false,
              toolName: "ae_reframe",
            })
          );
          const after = afterRead.value;
          const reportComps = reportRead.value?.result?.comps ?? [];
          const mismatches: ReceiptMismatch[] = [];
          const readFailure = afterRead.failure ?? reportRead.failure;
          if (readFailure) mismatches.push(readFailure);
          reportComps.forEach((r, i) => {
            const t = targets[i];
            if (r.width !== t.width || r.height !== t.height) {
              mismatches.push({ path: `${t.name}.size`, expected: [t.width, t.height], actual: [r.width, r.height], message: `${t.name} is not ${t.width}x${t.height}` });
            }
          });
          return {
            ok: true,
            op_id: opId,
            applied: true as const,
            source: write.result.source,
            comps: made.map((m, i) => ({
              ...m,
              aspect: targets[i].aspect,
              margins: targets[i].margins,
              // null: the layout couldn't be read back, so it is unchecked (not clean).
              outside_safe: reportRead.failure ? null : reportComps[i]?.outside_safe ?? [],
            })),
            next: "Check each new comp with ae_contact_sheet; nudge anything in outside_safe with ae_set_property.",
            checkpoint,
            receipt: buildReceipt({ before: before.result, after: after?.result ?? null, customMismatches: mismatches }),
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    },
  },
];
