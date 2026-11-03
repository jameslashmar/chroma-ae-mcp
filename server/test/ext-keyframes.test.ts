import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeSetKeyframeEaseSchema, animateTools, rovingMismatches } from "../src/tools/ext/animate.js";
import {
  AeRemoveKeyframesSchema,
  describeKey,
  easeSideName,
  keyframesTools,
  removeKeysMismatches,
  selectKeys,
} from "../src/tools/ext/keyframes.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-kf-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const tool = (name: string) => keyframesTools.find((t) => t.name === name)!;
const base = { comp_id: 1, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"], expect: { project_path: "<unsaved>" } };
const snap = (keys: Array<[number, number]>, value: unknown = null) => ({
  numKeys: keys.length,
  keys: keys.map(([time, v], i) => ({ index: i + 1, time, value: v })),
  truncated: false,
  value,
});

describe("keyframe tools", () => {
  it("are registered; removal takes an automatic checkpoint", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_get_keyframes")).toBe(true);
    expect(ALL_TOOLS.some((t) => t.name === "ae_remove_keyframes")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_remove_keyframes");
  });

  it("names each side of a key's ease", () => {
    expect(easeSideName("linear", [])).toBe("linear");
    expect(easeSideName("hold", [])).toBe("hold");
    expect(easeSideName("bezier", [{ speed: 0, influence: 33.333333 }])).toBe("easy ease");
    expect(easeSideName("bezier", [{ speed: 0, influence: 75 }])).toBe("bezier");
  });

  it("ae_get_keyframes describes keys and filters by time", async () => {
    const entry = (keyIndex: number, time: number) => ({
      keyIndex,
      time,
      value: 100,
      inInterp: "bezier",
      outInterp: "linear",
      easeIn: [{ speed: 0, influence: 33.333333 }],
      easeOut: [{ speed: 0, influence: 16.666 }],
    });
    const { ctx } = fakeAe({ getKeyframeEase: [{ name: "Opacity", matchName: "ADBE Opacity", isSpatial: false, numKeys: 2, keyframes: [entry(1, 0), entry(2, 2)] }] });
    const out = await tool("ae_get_keyframes").handler({ comp_id: 1, layer: { name: "Ball" }, path: base.path, start: 1 }, ctx);
    expect(out.numKeys).toBe(2);
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0]).toMatchObject({ index: 2, in: { name: "easy ease" }, out: { name: "linear" } });
    expect(describeKey({ ...entry(1, 0), roving: true, inTangent: [1, 2], outTangent: [3, 4] })).toMatchObject({ roving: true, in_tangent: [1, 2] });
  });

  it("ae_remove_keyframes removes, reads back separately, and checks the kept value", async () => {
    const { ctx, calls } = fakeAe({
      keysSnapshot: [snap([[0, 0], [1, 100]])],
      keysSnapshotStatic: [snap([[0, 0], [1, 100]]), snap([], 60)],
      removeKeys: [{ removed: [{ index: 1, time: 0, value: 0 }, { index: 2, time: 1, value: 100 }], numKeys: 0, static_value: 60, static_value_at: 0.6 }],
    });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, all: true, static_value_at: 0.6 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "keysSnapshot", "checkGuard", "keysSnapshotStatic", "removeKeys", "keysSnapshotStatic"]);
    expect(out.receipt.matches).toBe(true);
    expect(out).toMatchObject({ numKeys: 0, static_value: 60, static_value_at: 0.6 });
  });

  it("ae_remove_keyframes dry run lists the keys without writing", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [snap([[0, 0], [1, 50], [2, 100]])] });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, start: 0.5, dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["keysSnapshot"]);
    expect(out).toMatchObject({ dry_run: true, count: 2, all_keys: false });
  });

  it("selects like the host and flags keys left behind", () => {
    const keys = [{ index: 1, time: 0 }, { index: 2, time: 1 }, { index: 3, time: 2 }];
    const sel = (a: object) => selectKeys(keys, AeRemoveKeyframesSchema.parse({ ...base, ...a })).map((k) => k.index);
    expect(sel({ keys: [3, 1] })).toEqual([1, 3]);
    expect(sel({ end: 1 })).toEqual([1, 2]);
    expect(AeRemoveKeyframesSchema.safeParse(base).success).toBe(false);
    const m = removeKeysMismatches(snap([[0, 0], [1, 1]]), snap([[0, 0], [1, 1]]), { removed: [{ time: 1 }] });
    expect(m.map((x) => x.path)).toEqual(["numKeys", "keys@1"]);
  });
});

describe("ae_set_keyframe_ease rove_between", () => {
  const ease = animateTools.find((t) => t.name === "ae_set_keyframe_ease")!;

  it("is refused with a curve before AE is touched", async () => {
    const { ctx, calls } = fakeAe({});
    const args = AeSetKeyframeEaseSchema.parse({ ...base, path: ["ADBE Transform Group", "ADBE Position"], keys: [1, 3], ease: { curve: [0.42, 0, 0.58, 1] }, rove_between: true });
    expect(await ease.handler(args, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });

  it("passes rove_between to AE and checks the middle keys went roving", async () => {
    const kf = (keyIndex: number, roving: boolean) => ({ keyIndex, time: keyIndex - 1, value: [0, 0], inInterp: "bezier", outInterp: "bezier", easeIn: [{ speed: 0, influence: 33.333333 }], easeOut: [{ speed: 0, influence: 33.333333 }], roving });
    const { ctx, calls } = fakeAe({
      getKeyframeEase: [
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, false), kf(2, false), kf(3, false)] },
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, false), kf(2, true), kf(3, false)] },
      ],
      setKeyframeEase: [{ keysUpdated: [1, 3], roving: [2], mode: "easy_ease" }],
    });
    const args = AeSetKeyframeEaseSchema.parse({ ...base, path: ["ADBE Transform Group", "ADBE Position"], keys: [1, 3], ease: "easy_ease", rove_between: true });
    const out = await ease.handler(args, ctx);
    expect(calls.find((c) => c.fn === "setKeyframeEase")?.script).toContain('"rove_between":true');
    expect(out.receipt.mismatches.filter((m: { path: string }) => m.path.includes("roving"))).toEqual([]);
    expect(rovingMismatches([2], { keyframes: [kf(2, false)] })[0].message).toBe("Key 2 is not roving");
  });
});
