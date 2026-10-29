import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeSetKeyframeEaseSchema,
  animateTools,
  curveEaseMismatches,
  curveToSides,
  pathLength,
} from "../src/tools/ext/animate.js";

const ease1 = [{ speed: 0, influence: 33.3 }];
const ease3 = [ease1[0], ease1[0], ease1[0]];

function key(keyIndex: number, time: number, value: unknown, extra: Record<string, unknown> = {}) {
  return { keyIndex, time, value, easeIn: ease1, easeOut: ease1, inInterp: "linear", outInterp: "linear", ...extra };
}

describe("curveToSides", () => {
  it("turns a curve into out and in eases for a 1D segment, keeping the sign", () => {
    const snap = { isSpatial: false, keyframes: [key(1, 0.5, 100), key(2, 1.5, 0)] };
    const { sides, segments } = curveToSides(snap, undefined, [0.25, 0.1, 0.25, 1]);
    expect(segments).toEqual([[1, 2]]);
    // Average speed -100/s: out = (0.1 / 0.25) * -100, in = (0 / 0.75) * -100.
    expect(sides[0].key).toBe(1);
    expect(sides[0].in).toBeUndefined();
    expect(sides[0].out![0].speed).toBeCloseTo(-40);
    expect(sides[0].out![0].influence).toBeCloseTo(25);
    expect(sides[1].key).toBe(2);
    expect(sides[1].out).toBeUndefined();
    expect(sides[1].in![0].speed).toBeCloseTo(0);
    expect(sides[1].in![0].influence).toBeCloseTo(75);
  });

  it("gives each dimension of a non-spatial property its own speed", () => {
    const snap = {
      keyframes: [
        key(1, 0, [100, 100, 100], { easeIn: ease3, easeOut: ease3 }),
        key(2, 2, [150, 60, 100], { easeIn: ease3, easeOut: ease3 }),
      ],
    };
    const { sides } = curveToSides(snap, undefined, [0.5, 1, 0.5, 1]);
    expect(sides[0].out!.map((e) => e.speed)).toEqual([50, -40, 0]);
    expect(sides[1].in!.map((e) => e.speed)).toEqual([0, 0, 0]);
  });

  it("measures a spatial segment along its path", () => {
    expect(pathLength([0, 0], null, null, [300, 400])).toBeCloseTo(500, 6);
    const curved = pathLength([0, 0], [0, 100], [0, 100], [300, 0]);
    expect(curved).toBeGreaterThan(300);

    const snap = {
      isSpatial: true,
      keyframes: [
        key(1, 0, [0, 0, 0], { outTangent: [0, 0, 0], inTangent: [0, 0, 0] }),
        key(2, 1, [300, 400, 0], { outTangent: [0, 0, 0], inTangent: [0, 0, 0] }),
      ],
    };
    const { sides } = curveToSides(snap, undefined, [0.5, 1, 0.5, 1]);
    expect(sides[0].out).toHaveLength(1);
    expect(sides[0].out![0].speed).toBeCloseTo(1000, 3); // (1 / 0.5) * 500 px / 1 s
  });

  it("drops negative speeds on spatial properties, with a warning", () => {
    const snap = { isSpatial: true, keyframes: [key(1, 0, [0, 0]), key(2, 1, [100, 0])] };
    const { sides, warnings } = curveToSides(snap, undefined, [0.6, -0.28, 0.74, 0.05]);
    expect(sides[0].out![0].speed).toBe(0);
    expect(warnings[0]).toMatch(/can't go negative/);
  });

  it("shapes every neighbouring pair, so a middle key gets both sides", () => {
    const snap = { keyframes: [key(1, 0, 0), key(2, 1, 10), key(3, 2, 30)] };
    const { sides, segments } = curveToSides(snap, undefined, [0.3, 0, 0.7, 1]);
    expect(segments).toEqual([[1, 2], [2, 3]]);
    const middle = sides.find((s) => s.key === 2)!;
    expect(middle.in).toBeDefined();
    expect(middle.out).toBeDefined();
  });

  it("only shapes segments between selected neighbours", () => {
    const snap = { keyframes: [key(1, 0, 0), key(2, 1, 10), key(3, 2, 30), key(4, 3, 0)] };
    expect(curveToSides(snap, [3, 2], [0.3, 0, 0.7, 1]).segments).toEqual([[2, 3]]);
    expect(() => curveToSides(snap, [1, 3], [0.3, 0, 0.7, 1])).toThrow(/neighbouring keys/);
  });

  it("keeps handles off the keys, since AE's influence floor is 0.1%", () => {
    const snap = { keyframes: [key(1, 0, 0), key(2, 1, 10)] };
    const { sides } = curveToSides(snap, undefined, [0, 0, 1, 1]);
    expect(sides[0].out![0].influence).toBeCloseTo(0.1);
    expect(sides[1].in![0].influence).toBeCloseTo(0.1);
    expect(Number.isFinite(sides[0].out![0].speed)).toBe(true);
  });

  it("refuses keys at the same time or without numbers", () => {
    expect(() => curveToSides({ keyframes: [key(1, 1, 0), key(2, 1, 5)] }, undefined, [0.3, 0, 0.7, 1])).toThrow(/share a time/);
    expect(() => curveToSides({ keyframes: [key(1, 0, "a"), key(2, 1, "b")] }, undefined, [0.3, 0, 0.7, 1])).toThrow(/numeric/);
  });
});

describe("curveEaseMismatches", () => {
  const sides = [{ key: 1, out: [{ speed: -40, influence: 25 }] }];

  it("accepts AE's read-back within a relative tolerance", () => {
    const after = { keyframes: [key(1, 0, 100, { outInterp: "bezier", easeOut: [{ speed: -40.00002, influence: 25 }] })] };
    expect(curveEaseMismatches(sides, after)).toEqual([]);
  });

  it("flags a side that did not take", () => {
    const after = { keyframes: [key(1, 0, 100, { outInterp: "linear", easeOut: [{ speed: -100, influence: 16.7 }] })] };
    const mismatches = curveEaseMismatches(sides, after);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].path).toBe("keyframes[1].easeOut");
  });
});

describe("ae_set_keyframe_ease with a curve", () => {
  it("computes the sides from the before-read and sends them to setKeyframeEaseSides", async () => {
    const before = { isSpatial: false, keyframes: [key(1, 0.5, 100), key(2, 1.5, 0)] };
    const after = {
      isSpatial: false,
      keyframes: [
        key(1, 0.5, 100, { outInterp: "bezier", easeOut: [{ speed: -40, influence: 25 }] }),
        key(2, 1.5, 0, { inInterp: "bezier", easeIn: [{ speed: 0, influence: 75 }] }),
      ],
    };
    const reads = [before, after];
    const scripts: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-curve-")), "q.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        scripts.push(script);
        if (script.startsWith("__chromaAe.checkGuard(")) {
          return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
        }
        if (script.startsWith("__chromaAe.getKeyframeEase(")) return { ok: true, result: reads.shift(), durationMs: 1 };
        if (script.startsWith("__chromaAe.setKeyframeEaseSides(")) {
          return { ok: true, result: { keysUpdated: [1, 2], mode: "curve" }, durationMs: 1 };
        }
        throw new Error(`Unexpected script: ${script}`);
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    const tool = animateTools.find((t) => t.name === "ae_set_keyframe_ease")!;

    const out = await tool.handler(
      AeSetKeyframeEaseSchema.parse({
        comp_id: 1,
        layer: { index: 1 },
        path: ["ADBE Transform Group", "ADBE Opacity"],
        ease: { curve: [0.25, 0.1, 0.25, 1] },
        expect: { project_path: "<unsaved>" },
      }),
      ctx
    );

    const write = scripts.find((s) => s.startsWith("__chromaAe.setKeyframeEaseSides("))!;
    expect(write).toContain('"sides"');
    expect(scripts.some((s) => s.startsWith("__chromaAe.setKeyframeEase("))).toBe(false);
    expect(out.segments).toEqual([[1, 2]]);
    expect(out.curve).toEqual({ curve: [0.25, 0.1, 0.25, 1] });
    expect(out.receipt.matches).toBe(true);
  });
});

describe("ae_set_keyframe_ease schema", () => {
  const base = { comp_id: 1, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Position"], expect: { project_path: "<unsaved>" } };

  it("accepts a curve and the older forms", () => {
    expect(AeSetKeyframeEaseSchema.safeParse({ ...base, ease: { curve: [0.2, 0, 0, 1] } }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...base, ease: "easy_ease" }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...base, ease: { in: { speed: 0, influence: 50 }, out: { speed: 0, influence: 50 } } }).success).toBe(true);
  });

  it("rejects a curve whose x is outside 0..1", () => {
    expect(AeSetKeyframeEaseSchema.safeParse({ ...base, ease: { curve: [1.2, 0, 0, 1] } }).success).toBe(false);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...base, ease: { curve: [0.2, 0, 0] } }).success).toBe(false);
  });
});
