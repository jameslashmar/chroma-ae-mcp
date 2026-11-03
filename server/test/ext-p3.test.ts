import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeAlignSchema, AeHouseStyleCheckSchema, alignMismatches, layoutTools, styleFindings } from "../src/tools/ext/layout.js";
import { AeMaskSchema, AeTextAnimatorSchema, animatorMismatches, maskMismatches, masksTools } from "../src/tools/ext/masks.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
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

function fakeAe(answer: (fn: string, args: any) => unknown, projectPath = "<unsaved>") {
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-p3-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: projectPath, comp_id: 1, comp_is_valid: true, dirty: false }, durationMs: 1 };
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "{}");
      return { ok: true, result: answer(fn, args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const tool = (name: string) => [...masksTools, ...layoutTools].find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

describe("P3 tools", () => {
  it("are registered; the project writes take automatic checkpoints", () => {
    for (const n of ["ae_mask", "ae_text_animator", "ae_align", "ae_purge_unused", "ae_export_mogrt", "ae_house_style_check"]) {
      expect(ALL_TOOLS.some((t) => t.name === n)).toBe(true);
    }
    for (const n of ["ae_mask", "ae_text_animator", "ae_align", "ae_purge_unused"]) expect(AUTO_CHECKPOINT_TOOLS).toContain(n);
    expect(AUTO_CHECKPOINT_TOOLS).not.toContain("ae_export_mogrt");
  });
});

describe("ae_mask and ae_text_animator checks", () => {
  it("needs a shape and its fields for a new mask", () => {
    const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };
    expect(AeMaskSchema.safeParse({ ...base, add: [{ mode: "add" }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, add: [{ shape: "rect" }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, add: [{ shape: "ellipse", box: [0, 0, 10, 10] }] }).success).toBe(true);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, opacity: 50 }] }).success).toBe(true);
  });

  it("flags a mask whose feather and box read back differently", () => {
    const args = AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [{ shape: "rect", box: [0, 0, 100, 50], feather: [5, 5] }], expect: expectArg });
    const after = { count: 1, masks: [{ index: 1, name: "Mask 1", mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, box: [0, 0, 100, 50] }] };
    const m = maskMismatches(args, { count: 0, masks: [] }, after, { added: [{ index: 1 }], removed: [], changed: [] });
    expect(m.map((x) => x.path)).toEqual(["masks[1].feather[0]", "masks[1].feather[1]"]);
  });

  it("checks the animator's properties, colour with alpha, and the reveal's keys", () => {
    const args = AeTextAnimatorSchema.parse({ comp_id: 1, layer: { index: 1 }, properties: { opacity: 0, fill_color: [1, 0, 0] }, reveal: { from: 0, to: 100, start_time: 0, duration: 1 }, expect: expectArg });
    const after = {
      count: 1,
      animators: [{ index: 1, name: "Animator 1", properties: [{ matchName: "ADBE Text Opacity", value: 0 }, { matchName: "ADBE Text Fill Color", value: [1, 0, 0, 1] }], selectors: [{ start: 0, end: 100, start_keys: 1 }] }],
    };
    expect(animatorMismatches(args, { count: 0, animators: [] }, after, { index: 1 }).map((x) => x.path)).toEqual(["selector.reveal"]);
  });
});

describe("ae_align", () => {
  it("needs one of align or distribute, and two layers to distribute", () => {
    expect(AeAlignSchema.safeParse({ comp_id: 1, layers: [{ index: 1 }], expect: expectArg }).success).toBe(false);
    expect(AeAlignSchema.safeParse({ comp_id: 1, layers: [{ index: 1 }], distribute: "horizontal", expect: expectArg }).success).toBe(false);
  });

  it("checks edges and spacing in the read-back", () => {
    const args = AeAlignSchema.parse({ comp_id: 1, layers: [{ index: 1 }, { index: 2 }], align: "left", expect: expectArg });
    const read = (a: number, b: number) => ({ width: 640, height: 360, layers: [{ index: 1, id: 1, name: "A", rect: [a, 0, a + 10, 10] }, { index: 2, id: 2, name: "B", rect: [b, 0, b + 10, 10] }] });
    expect(alignMismatches(args, read(0, 0), { box: [0, 0, 640, 360] })).toEqual([]);
    expect(alignMismatches(args, read(0, 3), { box: [0, 0, 640, 360] })).toHaveLength(1);
    const dist = AeAlignSchema.parse({ comp_id: 1, layers: [{ index: 1 }, { index: 2 }, { index: 3 }], distribute: "horizontal", expect: expectArg });
    const three = { width: 640, height: 360, layers: [0, 100, 250].map((x, i) => ({ index: i + 1, id: i, name: String(i), rect: [x, 0, x + 10, 10] })) };
    expect(alignMismatches(dist, three, { box: [0, 0, 640, 360] }).length).toBeGreaterThan(0);
  });
});

describe("ae_purge_unused", () => {
  const unused = { items: [{ id: 5, name: "spare.png", kind: "footage", file: null }, { id: 6, name: "Old Solid", kind: "solid", file: null }], folders: [{ id: 7, name: "Empty", kind: "folder" }], numItems: 9 };

  it("lists by default, leaving kept items out", async () => {
    const { ctx, calls } = fakeAe(() => unused);
    const out = await tool("ae_purge_unused").handler({ empty_folders: true, keep: [6] }, ctx);
    expect(calls).toEqual(["unusedItems"]);
    expect(out).toMatchObject({ dry_run: true, count: 2 });
  });

  it("removes them with apply, folders last, and checks they are gone", async () => {
    let removedIds: number[] = [];
    const { ctx, calls } = fakeAe((fn, a) => {
      if (fn === "purgeItems") {
        removedIds = a.ids;
        return { removed: a.ids.map((id: number) => ({ id })), numItems: 6 };
      }
      return removedIds.length ? { items: [], folders: [], numItems: 6 } : unused;
    });
    const out = await tool("ae_purge_unused").handler({ empty_folders: true, apply: true, expect: expectArg }, ctx);
    expect(calls).toEqual(["unusedItems", "checkGuard", "unusedItems", "purgeItems", "unusedItems"]);
    expect(removedIds).toEqual([5, 6, 7]);
    expect(out.receipt.matches).toBe(true);
  });
});

describe("ae_export_mogrt", () => {
  it("refuses a relative or existing path before touching AE", async () => {
    const { ctx, calls } = fakeAe(() => ({}));
    expect(await tool("ae_export_mogrt").handler({ comp_id: 1, path: "t.mogrt", expect: expectArg }, ctx)).toMatchObject({ error: "bad_path" });
    const existing = path.join(tempDir("chroma-mogrt-"), "t.mogrt");
    fs.writeFileSync(existing, "old");
    expect(await tool("ae_export_mogrt").handler({ comp_id: 1, path: existing, expect: expectArg }, ctx)).toMatchObject({ error: "exists" });
    expect(calls).toEqual([]);
  });

  it("guards, exports, and checks the file is new and not empty", async () => {
    const out = path.join(tempDir("chroma-mogrt-"), "LT.mogrt");
    const { ctx, calls } = fakeAe((fn, a) => {
      fs.writeFileSync(a.path, "mogrt");
      return { exported: true, controllers: 2, template_name: "LT" };
    });
    const res = await tool("ae_export_mogrt").handler({ comp_id: 1, path: out, expect: expectArg }, ctx);
    expect(calls).toEqual(["checkGuard", "exportMogrt"]);
    expect(res).toMatchObject({ ok: true, exported: true, controllers: 2, file: { size: 5, fresh: true } });
  });
});

describe("ae_house_style_check", () => {
  const layers = [
    { index: 1, id: 1, name: "Title", kind: "text", enabled: true, font: "ArialMT", family: "Arial", font_size: 18, colours: [{ where: "text fill", role: "fill", rgb: [1, 1, 1] }] },
    { index: 2, id: 2, name: "Badge", kind: "shape", enabled: true, colours: [{ where: "Group 1 > Fill 1", role: "fill", rgb: [0.2, 0.8, 0.2] }, { where: "x", role: "fill", rgb: [0.99, 0.01, 0.01] }] },
    { index: 3, id: 3, name: "Sub", kind: "text", enabled: true, font: "Gotham-Book", family: "Gotham", font_size: 40, font_missing: true, colours: [] },
  ] as any[];

  it("finds off-brand and missing fonts, small text and off-palette colours", () => {
    const f = styleFindings(layers, { brand_colors: ["#FF0000", "#111111"], fonts: ["Gotham"], tolerance: 12, neutrals_ok: true, min_font_size: 24 });
    expect(f.map((x) => [x.kind, x.layer.name])).toEqual([
      ["off_brand_font", "Title"],
      ["missing_font", "Sub"],
      ["small_text", "Title"],
      ["off_palette_colour", "Badge"],
    ]);
    // In Lab the green sits nearer the near-black (delta E about 105) than the red (about 144).
    expect(f[3]).toMatchObject({ colour: "#33cc33", nearest: "#111111" });
  });

  it("reads the brief next to the project and checks text against title safe", async () => {
    const dir = tempDir("chroma-style-");
    const aep = path.join(dir, "Job.aep");
    fs.writeFileSync(path.join(dir, "Job.brief.json"), JSON.stringify({ brand_colors: ["#ff0000"], fonts: ["Gotham"] }));
    const { ctx } = fakeAe((fn) => {
      if (fn === "status") return { project_path: aep };
      if (fn === "styleScan") return { width: 640, height: 360, time: 1, layers: [layers[0]] };
      return { layer: { index: 1, id: 1, name: "Title" }, kind: "text", checkable: true, reason: null, samples: [{ time: 1, visible: true, rect: [10, 150, 300, 200] }] };
    }, aep);
    const out = await tool("ae_house_style_check").handler(AeHouseStyleCheckSchema.parse({ comp_id: 1 }), ctx);
    expect(out.used).toMatchObject({ brand_colors: ["#ff0000"], fonts: ["Gotham"], from_brief: true });
    expect(out.findings.map((x: { kind: string }) => x.kind).sort()).toEqual(["off_brand_font", "outside_safe"]);
    expect(out.clean).toBe(false);
  });
});
