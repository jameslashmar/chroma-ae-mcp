import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
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

// ---------- wave 5: ae_mask and ae_text_animator ----------

describe("ae_mask schema (wave 5)", () => {
  const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };

  it("takes the new attributes, copies and moves, and counts them as work", () => {
    const ok = AeMaskSchema.parse({
      ...base,
      set: [{ mask: { index: 1 }, feather_falloff: "linear", motion_blur: "same_as_layer", color: [0, 1, 0], locked: true, roto_bezier: false }],
      duplicate: [{ mask: { name: "A" } }, { mask: { index: 2 }, count: 3 }],
      move_to: [{ mask: { name: "B" }, index: 1 }],
    });
    expect(ok.duplicate!.map((d) => d.count)).toEqual([1, 3]);
    expect(AeMaskSchema.safeParse({ ...base, duplicate: [{ mask: { index: 1 } }] }).success).toBe(true);
    expect(AeMaskSchema.safeParse({ ...base, move_to: [{ mask: { index: 1 }, index: 2 }] }).success).toBe(true);
    expect(AeMaskSchema.safeParse(base).success).toBe(false);
  });

  it("rejects bad attribute values and counts", () => {
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, feather_falloff: "sharp" }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, motion_blur: "maybe" }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, color: [0, 1] }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, color: [0, 1, 2] }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, duplicate: [{ mask: { index: 1 }, count: 0 }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, move_to: [{ mask: { index: 1 }, index: 0 }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, duplicate: [{ mask: {} }] }).success).toBe(false);
  });

  it("names both routes for animating a mask path, and ends with the safety guidance", () => {
    const d = tool("ae_mask").description;
    expect(d).toMatch(/ae_path_write/);
    expect(d).toMatch(/ae_set_property on path \['ADBE Mask Parade'/);
    expect(d.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(tool("ae_text_animator").description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
  });
});

describe("ae_text_animator schema (wave 5)", () => {
  const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };

  it("still takes the old call shape", () => {
    const a = AeTextAnimatorSchema.parse({
      ...base,
      properties: { opacity: 0, position: [0, 40], fill_color: [1, 0, 0], tracking: 5, blur: [2, 2], scale: [100, 100], rotation: 10 },
      selector: { start: 0, end: 50, based_on: "words", shape: "ramp_up", randomize: true },
      reveal: { from: 0, to: 100, start_time: 0, duration: 1 },
    });
    expect(a.selector?.type).toBeUndefined();
  });

  it("takes every new animator property and checks its shape", () => {
    const props = {
      anchor_point: [0, 1], skew: 5, skew_axis: 10, rotation_x: 1, rotation_y: 2, fill_opacity: 50, fill_hue: 30, fill_saturation: -20, fill_brightness: 10,
      stroke_opacity: 100, stroke_color: [1, 1, 1], stroke_hue: 1, stroke_saturation: 1, stroke_brightness: 1, stroke_width: 4, tracking_type: 2, line_anchor: 50,
      line_spacing: [0, 10], character_alignment: [0, 0], character_range: 2, character_value: 65, character_offset: 3, variable_font_spacing: 2,
    };
    expect(AeTextAnimatorSchema.safeParse({ ...base, properties: props }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, properties: { fill_opacity: 120 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, properties: { line_spacing: [1] } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, properties: { stroke_color: [2, 0, 0] } }).success).toBe(false);
  });

  it("needs at least one property or axis", () => {
    expect(AeTextAnimatorSchema.safeParse({ ...base, properties: {} }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, grouping: { anchor_point_grouping: "word" } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, variable_axes: [{ tag: "wght", value: 700 }] }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, variable_axes: [{ tag: "wght", value: 700 }, { tag: "wght", value: 800 }] }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, variable_axes: [{ tag: "weight", value: 700 }] }).success).toBe(false);
  });

  it("keeps each selector type to its own fields", () => {
    const props = { properties: { opacity: 0 } };
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "wiggly", max_amount: 50, wiggles_per_second: 2, lock_dimensions: true, mode: "add" } }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "wiggly", start: 10 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { max_amount: 50 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "expression" } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "expression", expression: "50", shape: "round" } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "expression", expression: "textIndex*5", based_on: "words" } }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "range", units: "index", mode: "subtract", amount: 50, smoothness: 20, random_seed: 3, randomize: true } }).success).toBe(true);
    // Random Seed is hidden (and unwritable) while Randomize Order is off.
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "range", random_seed: 3 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "wiggly", random_seed: 3 } }).success).toBe(true);
  });

  it("limits start, end and offset to percentages unless units is index", () => {
    const props = { properties: { opacity: 0 } };
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { end: 150 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { offset: -150 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { units: "index", start: 2, end: 150, offset: 200 } }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { start: -5 } }).success).toBe(false);
  });

  it("needs a range selector for a reveal, and a non-empty grouping", () => {
    const props = { properties: { opacity: 0 } };
    const reveal = { from: 0, to: 100, start_time: 0, duration: 1 };
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "wiggly" }, reveal }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, selector: { type: "wiggly" }, more_selectors: [{ start: 0 }], reveal }).success).toBe(true);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, grouping: {} }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, grouping: { fill_and_stroke: 4 } }).success).toBe(false);
    expect(AeTextAnimatorSchema.safeParse({ ...base, ...props, grouping: { anchor_point_grouping: "all", grouping_alignment: [50, 50], fill_and_stroke: 2, inter_character_blending: 5 } }).success).toBe(true);
  });
});

describe("ae_mask guarded write (wave 5)", () => {
  const masks = (names: string[]) => ({
    count: names.length,
    masks: names.map((n, i) => ({ index: i + 1, name: n, mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, closed: true, box: [0, 0, 10, 10] })),
  });

  it("copies and moves masks with a separate read-back and a matching receipt", async () => {
    let edited = false;
    let editArgs: any;
    const { ctx, calls } = fakeAe((fn, a) => {
      if (fn === "maskEdit") {
        edited = true;
        editArgs = a;
        return {
          changed: [],
          removed: [],
          added: [],
          duplicated: [{ source_index: 2, source_name: "B", index: 3, name: "B 2" }],
          moved: [{ from: 4, to: 1, name: "C", name_at_target: "C" }],
          order: ["C", "A", "B", "B 2"],
          plan_order: [{ original: 3 }, { original: 1 }, { original: 2 }, { copy_of: 2 }],
          count: 4,
          unsupported: [],
          warnings: ["1 expression reference(s) on this layer address masks by index or name"],
        };
      }
      if (fn === "maskList") return edited ? masks(["C", "A", "B", "B 2"]) : masks(["A", "B", "C"]);
      return {};
    });
    const out = await tool("ae_mask").handler(
      AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, duplicate: [{ mask: { name: "B" } }], move_to: [{ mask: { name: "C" }, index: 1 }], expect: expectArg }),
      ctx
    );
    expect(calls.filter((c) => c === "maskList" || c === "maskEdit")).toEqual(["maskList", "maskEdit", "maskList"]);
    expect(editArgs).toMatchObject({ duplicate: [{ mask: { name: "B" }, count: 1 }], move_to: [{ mask: { name: "C" }, index: 1 }] });
    expect(out.receipt.matches).toBe(true);
    expect(out.warnings[0]).toMatch(/expression reference/);
    expect(out.duplicated).toHaveLength(1);
  });

  it("flags an order in the read-back that differs from the one the edit left", async () => {
    let edited = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "maskEdit") {
        edited = true;
        return { changed: [], removed: [], added: [], duplicated: [], moved: [{ from: 3, to: 1, name: "C", name_at_target: "C" }], order: ["C", "A", "B"], plan_order: [{ original: 3 }, { original: 1 }, { original: 2 }], count: 3, unsupported: [], warnings: [] };
      }
      if (fn === "maskList") return edited ? masks(["A", "C", "B"]) : masks(["A", "B", "C"]);
      return {};
    });
    const out = await tool("ae_mask").handler(AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, move_to: [{ mask: { name: "C" }, index: 1 }], expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((x: { path: string }) => x.path)).toContain("order");
  });
});

describe("ae_text_animator guarded write (wave 5)", () => {
  it("writes selectors and axes, reads them back separately, and matches", async () => {
    let written = false;
    let writeArgs: any;
    const state = (n: number) => ({
      count: n,
      animators:
        n === 0
          ? []
          : [
              {
                index: 1,
                name: "Animator 1",
                properties: [
                  { name: "Opacity", matchName: "ADBE Text Opacity", value: 0 },
                  { name: "Axis wght", matchName: "ADBE Text Variable Axis wght", value: 700 },
                ],
                selectors: [
                  {
                    index: 1,
                    type: "wiggly",
                    children: [
                      { name: "Max Amount", matchName: "ADBE Text Wiggly Max Amount", value: 80 },
                      { name: "Lock Dimensions", matchName: "ADBE Text Wiggly Lock Dim", value: 1 },
                    ],
                  },
                ],
              },
            ],
      more_options: { anchor_point_grouping: 3 },
    });
    const { ctx, calls } = fakeAe((fn, a) => {
      if (fn === "addTextAnimator") {
        written = true;
        writeArgs = a;
        return {
          index: 1,
          name: "Animator 1",
          properties: ["opacity"],
          property_matches: { opacity: { match_name: "ADBE Text Opacity", name: "Opacity" } },
          variable_axes: [{ tag: "wght", value: 700, index: 2, name: "Axis wght", match_name: "ADBE Text Variable Axis wght", applies_to: ["Inter"], skipped_fonts: [], custom: false }],
          selectors: [
            {
              index: 1,
              type: "wiggly",
              fields: {
                max_amount: { match_name: "ADBE Text Wiggly Max Amount", name: "Max Amount" },
                lock_dimensions: { match_name: "ADBE Text Wiggly Lock Dim", name: "Lock Dimensions" },
              },
            },
          ],
          grouping: { anchor_point_grouping: 3 },
          warnings: [],
        };
      }
      if (fn === "textAnimators") return state(written ? 1 : 0);
      return {};
    });
    const args = AeTextAnimatorSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      properties: { opacity: 0 },
      variable_axes: [{ tag: "wght", value: 700 }],
      selector: { type: "wiggly", max_amount: 80, lock_dimensions: true },
      grouping: { anchor_point_grouping: "line" },
      expect: expectArg,
    });
    const out = await tool("ae_text_animator").handler(args, ctx);
    expect(calls.filter((c) => c === "textAnimators" || c === "addTextAnimator")).toEqual(["textAnimators", "addTextAnimator", "textAnimators"]);
    expect(writeArgs).toMatchObject({ variable_axes: [{ tag: "wght", value: 700 }], selector: { type: "wiggly", max_amount: 80 }, grouping: { anchor_point_grouping: "line" } });
    expect(out.receipt.matches).toBe(true);
    expect(out.variable_axes).toHaveLength(1);
  });
});
