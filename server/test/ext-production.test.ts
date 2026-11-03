import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeBatchSetSchema,
  AeSetEssentialGraphicsSchema,
  AeVersionFootageSchema,
  batchMismatches,
  egpMismatches,
  productionTools,
  sameFootage,
} from "../src/tools/ext/production.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { AeShapeSchema, shapeMismatches, shapesTools } from "../src/tools/ext/shapes.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string, script: string) => unknown) {
  const calls: Array<{ fn: string; script: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-prod-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      return { ok: true, result: answer(fn, script), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const tool = (name: string) => [...productionTools, ...shapesTools].find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

describe("production tools", () => {
  it("are registered; the writes take automatic checkpoints", () => {
    const names = ["ae_shape", "ae_get_essential_graphics", "ae_set_essential_graphics", "ae_render_templates", "ae_version_footage", "ae_batch_set"];
    for (const n of names) expect(ALL_TOOLS.some((t) => t.name === n)).toBe(true);
    for (const n of ["ae_shape", "ae_set_essential_graphics", "ae_version_footage", "ae_batch_set"]) expect(AUTO_CHECKPOINT_TOOLS).toContain(n);
  });
});

describe("ae_shape", () => {
  it("validates each shape's fields", () => {
    const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };
    expect(AeShapeSchema.safeParse({ ...base, add: [{ type: "rect" }] }).success).toBe(false);
    expect(AeShapeSchema.safeParse({ ...base, add: [{ type: "star", points: 5, outer_radius: 50 }] }).success).toBe(false);
    expect(AeShapeSchema.safeParse({ ...base, add: [{ type: "path", vertices: [[0, 0], [1, 1]], in_tangents: [[0, 0]] }] }).success).toBe(false);
    expect(AeShapeSchema.safeParse({ ...base, add: [{ type: "polygon", points: 6, outer_radius: 50 }] }).success).toBe(true);
    expect(AeShapeSchema.safeParse(base).success).toBe(false);
  });

  it("checks the new groups' shape, size, fill and stroke", () => {
    const adds = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [{ type: "rect", name: "Card", size: [200, 100], fill: { color: [1, 0, 0] }, stroke: { color: [1, 1, 1], width: 3 } }], expect: expectArg }).add!;
    const after = {
      count: 1,
      truncated: false,
      contents: [{ index: 1, name: "Card", kind: "group", items: [{ name: "R", kind: "rect", size: [200, 100] }, { name: "S", kind: "stroke", width: 2 }, { name: "F", kind: "fill", color: [1, 0, 0, 1] }] }],
    };
    const m = shapeMismatches(adds, { count: 0, contents: [], truncated: false }, after, { added: [{ index: 1, name: "Card" }], removed: [] });
    expect(m.map((x) => x.path)).toEqual(["Card.stroke.width"]);
  });
});

describe("Essential Graphics", () => {
  it("schema needs the fields each action uses", () => {
    expect(AeSetEssentialGraphicsSchema.safeParse({ comp_id: 1, action: "add", expect: expectArg }).success).toBe(false);
    expect(AeSetEssentialGraphicsSchema.safeParse({ comp_id: 1, action: "set_override", layer: { index: 1 }, name: "Title", value: "Hi", expect: expectArg }).success).toBe(true);
  });

  it("checks a text override against its read-back", () => {
    const args = AeSetEssentialGraphicsSchema.parse({ comp_id: 1, action: "set_override", layer: { index: 1 }, name: "Title", value: "Hi", expect: expectArg });
    const read = (text: string) => ({ template_name: null, controllers: [], overrides: [{ index: 1, name: "Title", value: { text } }] });
    expect(egpMismatches(args, read("x"), read("Hi"))).toEqual([]);
    expect(egpMismatches(args, read("x"), read("Ho"))).toHaveLength(1);
  });
});

describe("ae_render_templates", () => {
  it("reads from an existing queue item and says whether the audio template is there", async () => {
    const { ctx } = fakeAe(() => ({ source: "existing_item", render_settings: ["Best Settings"], output_modules: ["Lossless", "AIFF 48kHz"] }));
    expect(await tool("ae_render_templates").handler({}, ctx)).toMatchObject({ source: "existing_item", audio_template_found: true });
  });

  it("asks for an item or allow_temp when the queue is empty", async () => {
    const { ctx } = fakeAe(() => ({ source: "none", needs_item: true, render_settings: [], output_modules: [] }));
    expect(await tool("ae_render_templates").handler({}, ctx)).toMatchObject({ ok: false, error: "empty_queue" });
    expect(await tool("ae_render_templates").handler({ allow_temp: true }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("with allow_temp goes through the guarded write and checks the queue is as it was", async () => {
    let looked = false;
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "rqStatus") return { numItems: 0 };
      if (!looked) {
        looked = true;
        return { source: "none", needs_item: true, render_settings: [], output_modules: [] };
      }
      return { source: "temporary_item", render_settings: ["Best Settings"], output_modules: ["Lossless"] };
    });
    const out = await tool("ae_render_templates").handler({ allow_temp: true, expect: expectArg }, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["renderTemplates", "checkGuard", "rqStatus", "renderTemplates", "rqStatus"]);
    expect(out).toMatchObject({ source: "temporary_item", audio_template_found: false });
    expect(out.receipt.matches).toBe(true);
  });
});

describe("ae_version_footage", () => {
  function shotDir() {
    const dir = tempDir("chroma-prod-ver-");
    for (const n of ["a_v001.mov", "a_v002.mov", "b_v004.mov"]) fs.writeFileSync(path.join(dir, n), "x");
    return dir;
  }

  it("reports newer versions without touching AE", async () => {
    const dir = shotDir();
    const files = { project_path: "<unsaved>", items: [{ item_id: 1, name: "a", file: path.join(dir, "a_v001.mov"), sequence: false, missing: false, used_in: 1 }, { item_id: 2, name: "b", file: path.join(dir, "b_v004.mov"), sequence: false, missing: false, used_in: 1 }] };
    const { ctx, calls } = fakeAe(() => files);
    const out = await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({}), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["footageFiles"]);
    expect(out).toMatchObject({ checked: 2, outdated: 1 });
    expect(out.items[0]).toMatchObject({ item_id: 1, current: 1, latest: 2, newer: true, target_version: 2 });
  });

  it("swaps to the latest, checks the read-back, and logs next to the project", async () => {
    const dir = shotDir();
    const aep = path.join(dir, "Job.aep");
    const v1 = path.join(dir, "a_v001.mov");
    const v2 = path.join(dir, "a_v002.mov");
    let swapped = false;
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "versionFootage") {
        swapped = true;
        return { replaced: [{ item_id: 1, name: "a", from: v1, to: v2 }] };
      }
      return { project_path: aep, items: [{ item_id: 1, name: "a", file: swapped ? v2 : v1, sequence: false, missing: false, used_in: 1 }] };
    });
    const out = await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ update: true, expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["footageFiles", "checkGuard", "footageFiles", "versionFootage", "footageFiles"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.log_path).toBe(path.join(dir, "Job.versions.json"));
    expect(JSON.parse(fs.readFileSync(out.log_path, "utf8")).entries[0]).toMatchObject({ from_version: 1, to_version: 2 });
  });

  it("compares sequences by folder and version, not the frame AE reports", () => {
    expect(sameFootage("C:/s/x_v002.0001.exr", "C:/s/x_v002.0005.exr", true)).toBe(true);
    expect(sameFootage("C:/s/x_v001.0001.exr", "C:/s/x_v002.0001.exr", true)).toBe(false);
    expect(sameFootage("C:/s/a.mov", "C:/s/b.mov", false)).toBe(false);
  });
});

describe("ae_batch_set", () => {
  const opacity = ["ADBE Transform Group", "ADBE Opacity"];

  it("runs in chunks, each its own guarded write, and checks every value", async () => {
    const ops = [1, 2, 3, 4, 5].map((i) => ({ layer: { index: i }, path: opacity, value: i * 10 }));
    let lastOps: Array<{ layer: { index: number } }> = [];
    const { ctx, calls } = fakeAe((fn, script) => {
      if (fn === "batchSet") return { done: JSON.parse(script.slice(script.indexOf("(") + 1, -1)).ops.length };
      lastOps = JSON.parse(script.slice(script.indexOf("(") + 1, -1)).ops;
      return { time: 0, results: lastOps.map((o, i) => ({ op: i + 1, numKeys: 0, value: o.layer.index * 10, expression: "" })) };
    });
    const out = await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: expectArg }), ctx);
    expect(out).toMatchObject({ ok: true, done: 5, matches: true });
    expect(out.chunks.map((c: { ops: string }) => c.ops)).toEqual(["1-2", "3-4", "5-5"]);
    expect(calls.filter((c) => c.fn === "batchSet")).toHaveLength(3);
  });

  it("stops at a failed op and says which", async () => {
    const ops = [1, 2, 3].map((i) => ({ layer: { index: i }, path: opacity, value: 1 }));
    const { ctx } = fakeAe((fn) => (fn === "batchSet" ? { done: 1, failed_at: 2, error: "boom" } : { time: 0, results: [] }));
    const out = await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: expectArg }), ctx);
    expect(out).toMatchObject({ ok: false, error: "op_failed", failed_op: 2, done: 1 });
    expect(out.chunks).toHaveLength(1);
  });

  it("checks keys, expressions and text values the AE way", () => {
    const ops = AeBatchSetSchema.parse({
      comp_id: 1,
      ops: [
        { layer: { index: 1 }, path: opacity, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] },
        { layer: { index: 2 }, path: ["ADBE Transform Group", "ADBE Scale"], value: [50, 50] },
        { layer: { index: 3 }, path: ["ADBE Text Properties", "ADBE Text Document"], value: "Hi" },
        { layer: { index: 4 }, path: opacity, expression: "wiggle(1, 5)" },
      ],
      expect: expectArg,
    }).ops;
    const after = {
      time: 0,
      results: [
        { op: 1, numKeys: 2, keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] },
        { op: 2, numKeys: 0, value: [50, 50, 100] },
        { op: 3, numKeys: 0, value: { text: "Hi" } },
        { op: 4, numKeys: 0, value: 100, expression: "wiggle(1, 5)" },
      ],
    };
    expect(batchMismatches(ops, after, 0).map((m) => m.path)).toEqual(["ops[1].keys@1"]);
  });
});
