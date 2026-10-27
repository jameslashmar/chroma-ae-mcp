import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { zodToJsonSchema } from "../src/schema.js";
import {
  AeCompareFramesSchema,
  analyzeDecodedFrame,
  compareDecodedFrames,
  framesTools,
} from "../src/tools/ext/frames.js";

function writeSolidPng(
  filePath: string,
  width: number,
  height: number,
  rgba: [number, number, number, number]
): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function writeCheckerPng(
  filePath: string,
  width: number,
  height: number,
  rgbaEven: [number, number, number, number],
  rgbaOdd: [number, number, number, number]
): void {
  const png = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) {
    const c = p % 2 === 0 ? rgbaEven : rgbaOdd;
    const i = p * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = c[3];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

describe("ext/frames (ae_compare_frames)", () => {
  const tmpDirs: string[] = [];
  const origLocalAppData = process.env.LOCALAPPDATA;

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-frames-"));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    const dir = makeTempDir();
    process.env.LOCALAPPDATA = dir;
  });

  afterEach(() => {
    if (origLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = origLocalAppData;
    }
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("validates AeCompareFramesSchema for both {comp_id, times} and {a_path, b_path} modes", () => {
    const jsonSchema = zodToJsonSchema(AeCompareFramesSchema);
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("comp_id");
    expect(jsonSchema.properties).toHaveProperty("times");
    expect(jsonSchema.properties).toHaveProperty("a_path");
    expect(jsonSchema.properties).toHaveProperty("b_path");

    expect(
      AeCompareFramesSchema.safeParse({ comp_id: 1, times: [0, 1.5, 3] }).success
    ).toBe(true);
    expect(
      AeCompareFramesSchema.safeParse({ a_path: "a.png", b_path: "b.png" })
        .success
    ).toBe(true);

    // Reject < 2 or > 20 times
    expect(
      AeCompareFramesSchema.safeParse({ comp_id: 1, times: [0] }).success
    ).toBe(false);
    expect(
      AeCompareFramesSchema.safeParse({
        comp_id: 1,
        times: Array.from({ length: 21 }, (_, i) => i * 0.1),
      }).success
    ).toBe(false);

    // Reject incomplete or mixed modes
    expect(AeCompareFramesSchema.safeParse({ comp_id: 1 }).success).toBe(false);
    expect(AeCompareFramesSchema.safeParse({ a_path: "a.png" }).success).toBe(
      false
    );
    expect(
      AeCompareFramesSchema.safeParse({
        comp_id: 1,
        times: [0, 1],
        a_path: "a.png",
        b_path: "b.png",
      }).success
    ).toBe(false);
  });

  it("flags blank, black, and fully transparent single frames accurately", () => {
    const dir = makeTempDir();
    const blackPath = path.join(dir, "black.png");
    const transPath = path.join(dir, "transparent.png");
    const solidWhitePath = path.join(dir, "white.png");
    const checkerPath = path.join(dir, "checker.png");

    writeSolidPng(blackPath, 4, 4, [0, 0, 0, 255]);
    writeSolidPng(transPath, 4, 4, [0, 0, 0, 0]);
    writeSolidPng(solidWhitePath, 4, 4, [255, 255, 255, 255]);
    writeCheckerPng(checkerPath, 4, 4, [255, 0, 0, 255], [0, 255, 0, 255]);

    const blackInfo = analyzeDecodedFrame(
      PNG.sync.read(fs.readFileSync(blackPath)),
      { index: 0, path: blackPath }
    );
    expect(blackInfo.is_black).toBe(true);
    expect(blackInfo.is_blank).toBe(true);
    expect(blackInfo.is_transparent).toBe(false);
    expect(blackInfo.flags).toEqual(["blank", "black"]);

    const transInfo = analyzeDecodedFrame(
      PNG.sync.read(fs.readFileSync(transPath)),
      { index: 1, path: transPath }
    );
    expect(transInfo.is_transparent).toBe(true);
    expect(transInfo.is_blank).toBe(true);
    expect(transInfo.is_black).toBe(false);
    expect(transInfo.flags).toEqual(["blank", "transparent"]);

    const whiteInfo = analyzeDecodedFrame(
      PNG.sync.read(fs.readFileSync(solidWhitePath)),
      { index: 2, path: solidWhitePath }
    );
    expect(whiteInfo.is_blank).toBe(true);
    expect(whiteInfo.is_black).toBe(false);
    expect(whiteInfo.is_transparent).toBe(false);
    expect(whiteInfo.flags).toEqual(["blank"]);

    const checkerInfo = analyzeDecodedFrame(
      PNG.sync.read(fs.readFileSync(checkerPath)),
      { index: 3, path: checkerPath }
    );
    expect(checkerInfo.is_blank).toBe(false);
    expect(checkerInfo.is_black).toBe(false);
    expect(checkerInfo.is_transparent).toBe(false);
    expect(checkerInfo.flags).toEqual([]);
  });

  it("compares {a_path, b_path} PNG files and writes an optional diff_png", async () => {
    const dir = makeTempDir();
    const aPath = path.join(dir, "a.png");
    const bPath = path.join(dir, "b.png");

    // 2x2 all black vs 2x2 checkerboard (50% pixels white, 50% pixels black)
    writeSolidPng(aPath, 2, 2, [0, 0, 0, 255]);
    writeCheckerPng(bPath, 2, 2, [255, 255, 255, 255], [0, 0, 0, 255]);

    const tool = framesTools.find((t) => t.name === "ae_compare_frames")!;
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const host = new PanelHost({
      evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }),
      queue,
      quarantine,
    });

    const parsedArgs = AeCompareFramesSchema.parse({
      a_path: aPath,
      b_path: bPath,
      threshold: 0.05,
      write_diff_png: true,
    });

    const res = (await tool.handler(parsedArgs, {
      bridge: host,
      queue,
      quarantine,
    })) as Record<string, any>;

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("file_pair");
    expect(res.frames).toHaveLength(2);
    expect(res.frames[0].flags).toEqual(["blank", "black"]);
    expect(res.frames[1].flags).toEqual([]);
    expect(res.pairs).toHaveLength(1);

    const pair = res.pairs[0];
    // 2 of 4 pixels changed from [0,0,0,255] -> [255,255,255,255]:
    // per changed pixel mean channel diff is (1 + 1 + 1 + 0)/4 = 0.75; across 4 pixels mean = 0.375
    expect(pair.mean_abs_diff).toBeCloseTo(0.375, 5);
    expect(pair.max_diff).toBe(1);
    expect(pair.changed_pixels).toBe(2);
    expect(pair.total_pixels).toBe(4);
    expect(pair.pct_pixels_changed).toBe(50);
    expect(typeof pair.diff_png).toBe("string");
    expect(fs.existsSync(pair.diff_png)).toBe(true);

    const decodedDiff = PNG.sync.read(fs.readFileSync(pair.diff_png));
    expect(decodedDiff.width).toBe(2);
    expect(decodedDiff.height).toBe(2);
  });

  it("captures frames via snapshotFrame + waitForFreshPng in {comp_id, times} mode", async () => {
    const dir = makeTempDir();
    const calls: Array<{ script: string; label: string }> = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));

    let callIdx = 0;
    const host = new PanelHost({
      evalScript: async (script, label) => {
        calls.push({ script, label });
        const m = /"output_path":"([^"]+)"/.exec(script);
        expect(m).not.toBeNull();
        const outPath = JSON.parse(`"${m![1]}"`) as string;

        if (callIdx === 0) {
          // Frame 0 @ 0s: solid black
          writeSolidPng(outPath, 4, 4, [0, 0, 0, 255]);
        } else if (callIdx === 1) {
          // Frame 1 @ 1s: checkerboard
          writeCheckerPng(
            outPath,
            4,
            4,
            [200, 100, 50, 255],
            [20, 40, 60, 255]
          );
        } else {
          // Frame 2 @ 2s: identical to Frame 1
          writeCheckerPng(
            outPath,
            4,
            4,
            [200, 100, 50, 255],
            [20, 40, 60, 255]
          );
        }
        callIdx++;

        return {
          ok: true,
          result: { path: outPath, width: 4, height: 4 },
          durationMs: 5,
        };
      },
      queue,
      quarantine,
    });

    const tool = framesTools.find((t) => t.name === "ae_compare_frames")!;
    const parsedArgs = AeCompareFramesSchema.parse({
      comp_id: 7,
      times: [0, 1, 2],
    });

    const res = (await tool.handler(parsedArgs, {
      bridge: host,
      queue,
      quarantine,
    })) as Record<string, any>;

    expect(calls).toHaveLength(3);
    expect(calls[0].script).toContain("__chromaAe.snapshotFrame(");
    expect(res.ok).toBe(true);
    expect(res.comp_id).toBe(7);
    expect(res.frames).toHaveLength(3);
    expect(res.flagged_frames).toHaveLength(1);
    expect(res.flagged_frames[0].index).toBe(0);
    expect(res.flagged_frames[0].flags).toContain("black");

    expect(res.pairs).toHaveLength(2);
    // Pair 0 (0s -> 1s) has changes
    expect(res.pairs[0].identical).toBe(false);
    expect(res.pairs[0].pct_pixels_changed).toBe(100);
    // Pair 1 (1s -> 2s) is identical
    expect(res.pairs[1].identical).toBe(true);
    expect(res.pairs[1].mean_abs_diff).toBe(0);
    expect(res.pairs[1].max_diff).toBe(0);
    expect(res.pairs[1].pct_pixels_changed).toBe(0);
  });

  it("throws when comparing frames of mismatched dimensions", () => {
    const a = new PNG({ width: 4, height: 4 });
    const b = new PNG({ width: 8, height: 4 });
    expect(() => compareDecodedFrames(a, b)).toThrow(
      /Frame dimensions do not match/
    );
  });
});
