import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import {
  AGENT_SAFETY_GUIDANCE,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { defaultFramesDir, waitForFreshPng } from "../render.js";

export type FrameFlag = "blank" | "black" | "transparent";

export interface FrameAnalysis {
  index: number;
  path: string;
  time?: number;
  width: number;
  height: number;
  is_blank: boolean;
  is_black: boolean;
  is_transparent: boolean;
  is_uniform: boolean;
  flags: FrameFlag[];
  mean_rgba: [number, number, number, number];
}

export interface FramePairComparison {
  pair_index: number;
  a_index: number;
  b_index: number;
  a_path: string;
  b_path: string;
  a_time?: number;
  b_time?: number;
  width: number;
  height: number;
  mean_abs_diff: number;
  max_diff: number;
  threshold: number;
  changed_pixels: number;
  total_pixels: number;
  pct_pixels_changed: number;
  percent_changed: number;
  identical: boolean;
  diff_png?: string;
}

export const AeCompareFramesSchema = z
  .object({
    comp_id: z
      .number()
      .int()
      .optional()
      .describe(
        "CompItem ID to capture frames from (use with `times`, mutually exclusive with `a_path`/`b_path`)."
      ),
    times: z
      .array(z.number().min(0))
      .min(2)
      .max(20)
      .optional()
      .describe(
        "2 to 20 composition times in seconds to snapshot and compare sequentially."
      ),
    a_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute path to the first PNG file on disk (use with `b_path`, mutually exclusive with `comp_id`/`times`)."
      ),
    b_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute path to the second PNG file on disk (use with `a_path`, mutually exclusive with `comp_id`/`times`)."
      ),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.02)
      .describe(
        "Per-pixel channel difference threshold in [0..1] above which a pixel is counted as changed (default: 0.02)."
      ),
    write_diff_png: z
      .boolean()
      .default(false)
      .describe(
        "If true, writes a visual diff PNG for each compared pair to %LOCALAPPDATA%\\chroma-ae-mcp\\frames."
      ),
    diff_png: z
      .boolean()
      .optional()
      .describe(
        "Optional alias for `write_diff_png` to write diff PNGs to %LOCALAPPDATA%\\chroma-ae-mcp\\frames."
      ),
  })
  .superRefine((val, ctx) => {
    const hasComp = val.comp_id !== undefined;
    const hasTimes = val.times !== undefined;
    const hasA = val.a_path !== undefined;
    const hasB = val.b_path !== undefined;

    if (hasComp !== hasTimes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasComp ? ["times"] : ["comp_id"],
        message: "Both `comp_id` and `times` (2 to 20 entries) must be provided together.",
      });
      return;
    }

    if (hasA !== hasB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasA ? ["b_path"] : ["a_path"],
        message: "Both `a_path` and `b_path` must be provided together.",
      });
      return;
    }

    const modeComp = hasComp && hasTimes;
    const modePaths = hasA && hasB;

    if (!modeComp && !modePaths) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comp_id"],
        message:
          "Provide either `{ comp_id, times }` (2 to 20 times) or `{ a_path, b_path }`.",
      });
      return;
    }

    if (modeComp && modePaths) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["a_path"],
        message:
          "Provide either `{ comp_id, times }` or `{ a_path, b_path }`, not both.",
      });
    }
  });

export type AeCompareFramesArgs = z.infer<typeof AeCompareFramesSchema>;

/**
 * Decodes a PNG file from disk using pure-JS `pngjs`.
 */
export function decodePngFile(filePath: string): PNG {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PNG file not found: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    throw new Error(`PNG file is empty (0 bytes): ${filePath}`);
  }
  return PNG.sync.read(buf);
}

/**
 * Inspects a decoded PNG frame and flags whether it is blank (uniform colour,
 * all-black, or all-transparent), black, or fully transparent.
 */
export function analyzeDecodedFrame(
  png: { width: number; height: number; data: Buffer | Uint8Array },
  meta: { index: number; path: string; time?: number }
): FrameAnalysis {
  const { width, height, data } = png;
  const totalPixels = width * height;

  if (totalPixels <= 0 || data.length < totalPixels * 4) {
    return {
      index: meta.index,
      path: meta.path,
      ...(meta.time !== undefined ? { time: meta.time } : {}),
      width,
      height,
      is_blank: true,
      is_black: false,
      is_transparent: true,
      is_uniform: true,
      flags: ["blank", "transparent"],
      mean_rgba: [0, 0, 0, 0],
    };
  }

  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  const a0 = data[3];

  let isUniform = true;
  let allTransparent = true;
  let allBlack = true;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;

  for (let i = 0; i < totalPixels * 4; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    sumR += r;
    sumG += g;
    sumB += b;
    sumA += a;

    if (a > 0) {
      allTransparent = false;
      if (r > 1 || g > 1 || b > 1) {
        allBlack = false;
      }
    }

    if (
      isUniform &&
      (Math.abs(r - r0) > 1 ||
        Math.abs(g - g0) > 1 ||
        Math.abs(b - b0) > 1 ||
        Math.abs(a - a0) > 1)
    ) {
      isUniform = false;
    }
  }

  // A fully transparent frame is transparent and blank, not opaque black.
  const isTransparent = allTransparent;
  const isBlack = !allTransparent && allBlack;
  const isBlank = isTransparent || isBlack || isUniform;

  const flags: FrameFlag[] = [];
  if (isBlank) flags.push("blank");
  if (isBlack) flags.push("black");
  if (isTransparent) flags.push("transparent");

  const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

  return {
    index: meta.index,
    path: meta.path,
    ...(meta.time !== undefined ? { time: meta.time } : {}),
    width,
    height,
    is_blank: isBlank,
    is_black: isBlack,
    is_transparent: isTransparent,
    is_uniform: isUniform,
    flags,
    mean_rgba: [
      round4(sumR / (totalPixels * 255)),
      round4(sumG / (totalPixels * 255)),
      round4(sumB / (totalPixels * 255)),
      round4(sumA / (totalPixels * 255)),
    ],
  };
}

/**
 * Compares two decoded PNG images of matching dimensions.
 * Returns:
 * - `mean_abs_diff` in [0..1] (mean absolute difference across all RGBA channels & pixels)
 * - `max_diff` in [0..1] (maximum single-channel difference across all pixels)
 * - `pct_pixels_changed` in [0..100] (percentage of pixels where max channel diff > threshold)
 * - optional `diffPng` (`PNG` instance) when `buildDiffPng` is true.
 */
export function compareDecodedFrames(
  pngA: { width: number; height: number; data: Buffer | Uint8Array },
  pngB: { width: number; height: number; data: Buffer | Uint8Array },
  options: { threshold?: number; buildDiffPng?: boolean } = {}
): {
  width: number;
  height: number;
  mean_abs_diff: number;
  max_diff: number;
  threshold: number;
  changed_pixels: number;
  total_pixels: number;
  pct_pixels_changed: number;
  percent_changed: number;
  identical: boolean;
  diffPng?: PNG;
} {
  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    throw new Error(
      `Frame dimensions do not match: ${pngA.width}x${pngA.height} vs ${pngB.width}x${pngB.height}`
    );
  }

  const width = pngA.width;
  const height = pngA.height;
  const totalPixels = width * height;
  const threshold = options.threshold ?? 0.02;
  const buildDiff = Boolean(options.buildDiffPng);

  const diffPng = buildDiff ? new PNG({ width, height }) : undefined;

  if (totalPixels === 0) {
    return {
      width,
      height,
      mean_abs_diff: 0,
      max_diff: 0,
      threshold,
      changed_pixels: 0,
      total_pixels: 0,
      pct_pixels_changed: 0,
      percent_changed: 0,
      identical: true,
      diffPng,
    };
  }

  let sumAbsDiff = 0;
  let maxDiff = 0;
  let changedPixels = 0;

  const dataA = pngA.data;
  const dataB = pngB.data;

  for (let i = 0; i < totalPixels * 4; i += 4) {
    const dr = Math.abs(dataA[i] - dataB[i]) / 255;
    const dg = Math.abs(dataA[i + 1] - dataB[i + 1]) / 255;
    const db = Math.abs(dataA[i + 2] - dataB[i + 2]) / 255;
    const da = Math.abs(dataA[i + 3] - dataB[i + 3]) / 255;

    const pixelMean = (dr + dg + db + da) / 4;
    const pixelMax = Math.max(dr, dg, db, da);

    sumAbsDiff += pixelMean;
    if (pixelMax > maxDiff) {
      maxDiff = pixelMax;
    }

    const isChanged = pixelMax > threshold;
    if (isChanged) {
      changedPixels++;
    }

    if (diffPng) {
      if (isChanged) {
        // Highlight changed pixels in high-contrast red/magenta proportional to diff
        const intensity = Math.min(
          255,
          Math.max(64, Math.round(pixelMax * 255))
        );
        diffPng.data[i] = intensity;
        diffPng.data[i + 1] = Math.round(dg * 128);
        diffPng.data[i + 2] = intensity;
        diffPng.data[i + 3] = 255;
      } else {
        // Dimmed grayscale background of frame A for unchanged pixels
        const luma = Math.round(
          (dataA[i] * 0.299 + dataA[i + 1] * 0.587 + dataA[i + 2] * 0.114) *
            0.25
        );
        diffPng.data[i] = luma;
        diffPng.data[i + 1] = luma;
        diffPng.data[i + 2] = luma;
        diffPng.data[i + 3] = 255;
      }
    }
  }

  const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
  const meanAbsDiff = round6(sumAbsDiff / totalPixels);
  const maxDiffRounded = round6(maxDiff);
  const pctChanged = round6((changedPixels / totalPixels) * 100);

  return {
    width,
    height,
    mean_abs_diff: meanAbsDiff,
    max_diff: maxDiffRounded,
    threshold,
    changed_pixels: changedPixels,
    total_pixels: totalPixels,
    pct_pixels_changed: pctChanged,
    percent_changed: pctChanged,
    identical: maxDiff === 0,
    diffPng,
  };
}

/**
 * Captures a single composition frame inside an active queue lease using the
 * `snapshotFrame` host function and `waitForFreshPng`, retrying once with a
 * +0.001s time nudge if the first write is stale.
 */
async function captureCompFrame(params: {
  ctx: ToolContext;
  opId: string;
  compId: number;
  time: number;
  frameIndex: number;
  framesDir: string;
  waitMs?: number;
}): Promise<{ path: string; time: number }> {
  const { ctx, opId, compId, time, frameIndex, framesDir } = params;
  const suffix1 = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const pngPath1 = path.join(
    framesDir,
    `frame_c${compId}_f${frameIndex}_${suffix1}.png`
  );
  const reqStart1 = Date.now();

  await ctx.bridge.evalRaw<Record<string, unknown>>({
    id: `${opId}_f${frameIndex}_try1`,
    script: buildJsxCall("snapshotFrame", {
      comp_id: compId,
      time,
      scale: 0.5,
      output_path: pngPath1,
    }),
    label: `ae_compare_frames(${compId} @ ${time}s)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName: "ae_compare_frames",
  });

  const check1 = await waitForFreshPng(pngPath1, reqStart1, params.waitMs);
  if (check1.fresh) {
    return { path: pngPath1, time };
  }

  // Retry once with a slight +0.001s time nudge
  const nudgedTime = Math.max(0, time + 0.001);
  const suffix2 = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const pngPath2 = path.join(
    framesDir,
    `frame_c${compId}_f${frameIndex}_${suffix2}.png`
  );
  const reqStart2 = Date.now();

  await ctx.bridge.evalRaw<Record<string, unknown>>({
    id: `${opId}_f${frameIndex}_try2`,
    script: buildJsxCall("snapshotFrame", {
      comp_id: compId,
      time: nudgedTime,
      scale: 0.5,
      output_path: pngPath2,
    }),
    label: `ae_compare_frames(${compId} @ ${nudgedTime}s retry)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName: "ae_compare_frames",
  });

  const check2 = await waitForFreshPng(pngPath2, reqStart2, params.waitMs);
  if (check2.fresh) {
    return { path: pngPath2, time: nudgedTime };
  }

  throw new Error(
    `saveFrameToPng did not produce a fresh non-empty PNG for comp ${compId} at time ${time}s after retry.`
  );
}

export const framesTools: ToolDefinition<any>[] = [
  {
    name: "ae_compare_frames",
    description:
      "Compare 2 to 20 composition frames captured at `times` (via `snapshotFrame` + `waitForFreshPng`) or two existing PNG files (`a_path`, `b_path`). " +
      "Decodes frames with `pngjs`, flags blank, black, or fully transparent frames, returns pairwise `mean_abs_diff` (0..1), `max_diff` (0..1), and `pct_pixels_changed` over `threshold`, and optionally writes a `diff_png` to `%LOCALAPPDATA%\\chroma-ae-mcp\\frames`. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCompareFramesSchema,
    handler: async (args: AeCompareFramesArgs, ctx: ToolContext) => {
      const threshold = args.threshold ?? 0.02;
      const shouldWriteDiff = Boolean(args.write_diff_png || args.diff_png);
      const framesDir = defaultFramesDir();

      const capturedItems: Array<{
        path: string;
        time?: number;
      }> = [];

      if (args.comp_id !== undefined && args.times !== undefined) {
        fs.mkdirSync(framesDir, { recursive: true });
        const opId = ctx.bridge.newOpId();
        const compId = args.comp_id;
        const times = args.times;

        try {
          await ctx.queue.run(
            `ae_compare_frames(${compId}, ${times.length} frames)`,
            async () => {
              for (let i = 0; i < times.length; i++) {
                const snap = await captureCompFrame({
                  ctx,
                  opId,
                  compId,
                  time: times[i],
                  frameIndex: i,
                  framesDir,
                });
                capturedItems.push({ path: snap.path, time: times[i] });
              }
            }
          );
        } catch (err) {
          if (err instanceof QueueWaitError) {
            throw new BridgeError({
              kind: "queued",
              op_id: opId,
              message: err.message,
            });
          }
          throw err;
        }
      } else if (args.a_path !== undefined && args.b_path !== undefined) {
        capturedItems.push({ path: args.a_path }, { path: args.b_path });
      } else {
        throw new Error(
          "Invalid arguments: provide either { comp_id, times } or { a_path, b_path }."
        );
      }

      if (shouldWriteDiff) {
        fs.mkdirSync(framesDir, { recursive: true });
      }

      const decodedPngs: PNG[] = [];
      const frameAnalyses: FrameAnalysis[] = [];

      for (let i = 0; i < capturedItems.length; i++) {
        const item = capturedItems[i];
        const png = decodePngFile(item.path);
        decodedPngs.push(png);
        frameAnalyses.push(
          analyzeDecodedFrame(png, {
            index: i,
            path: item.path,
            time: item.time,
          })
        );
      }

      const pairs: FramePairComparison[] = [];
      const diffPngPaths: string[] = [];

      for (let i = 0; i < decodedPngs.length - 1; i++) {
        const itemA = capturedItems[i];
        const itemB = capturedItems[i + 1];
        const cmp = compareDecodedFrames(decodedPngs[i], decodedPngs[i + 1], {
          threshold,
          buildDiffPng: shouldWriteDiff,
        });

        let diffPngPath: string | undefined;
        if (shouldWriteDiff && cmp.diffPng) {
          const suffix = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
          diffPngPath = path.join(framesDir, `diff_${i}_${i + 1}_${suffix}.png`);
          const outBuf = PNG.sync.write(cmp.diffPng);
          fs.writeFileSync(diffPngPath, outBuf);
          diffPngPaths.push(diffPngPath);
        }

        pairs.push({
          pair_index: i,
          a_index: i,
          b_index: i + 1,
          a_path: itemA.path,
          b_path: itemB.path,
          ...(itemA.time !== undefined ? { a_time: itemA.time } : {}),
          ...(itemB.time !== undefined ? { b_time: itemB.time } : {}),
          width: cmp.width,
          height: cmp.height,
          mean_abs_diff: cmp.mean_abs_diff,
          max_diff: cmp.max_diff,
          threshold: cmp.threshold,
          changed_pixels: cmp.changed_pixels,
          total_pixels: cmp.total_pixels,
          pct_pixels_changed: cmp.pct_pixels_changed,
          percent_changed: cmp.percent_changed,
          identical: cmp.identical,
          ...(diffPngPath ? { diff_png: diffPngPath } : {}),
        });
      }

      const flaggedFrames = frameAnalyses
        .filter((f) => f.flags.length > 0)
        .map((f) => ({
          index: f.index,
          path: f.path,
          ...(f.time !== undefined ? { time: f.time } : {}),
          flags: f.flags,
        }));

      const firstPair = pairs[0];

      return {
        ok: true,
        mode: args.comp_id !== undefined ? "comp_times" : "file_pair",
        ...(args.comp_id !== undefined ? { comp_id: args.comp_id } : {}),
        threshold,
        frames: frameAnalyses,
        flagged_frames: flaggedFrames,
        pairs,
        // Convenience top-level summary fields when comparing a single pair
        ...(firstPair
          ? {
              mean_abs_diff: firstPair.mean_abs_diff,
              max_diff: firstPair.max_diff,
              pct_pixels_changed: firstPair.pct_pixels_changed,
              percent_changed: firstPair.percent_changed,
              ...(firstPair.diff_png ? { diff_png: firstPair.diff_png } : {}),
            }
          : {}),
        ...(diffPngPaths.length > 0 ? { diff_pngs: diffPngPaths } : {}),
      };
    },
  },
];
