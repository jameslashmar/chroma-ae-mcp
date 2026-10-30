import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeBuildFromDataSchema,
  cellValue,
  checkBuild,
  dataTools,
  fillName,
  parseCsv,
  parseDataFile,
  prepareRows,
  validateAgainstTemplate,
} from "../src/tools/ext/data.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import {
  AeReframeSchema,
  aspectName,
  marginsFor,
  parseAspect,
  planTargets,
  reframeTools,
  sizeForAspect,
} from "../src/tools/ext/reframe.js";
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

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; args: any }> = [];
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-data-q-"), "quarantine.json"));
  const queue = new SingleWriterQueue();
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, args: JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")"))) });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      const q = results[fn];
      if (!q || q.length === 0) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: q.shift(), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

describe("data parsing", () => {
  it("parses CSV with quotes, doubled quotes, commas, CRLF and a BOM", () => {
    const rows = parseCsv('﻿lang,title\r\nen,"Hello, ""world"""\r\ntr,Merhaba\r\n\r\n');
    expect(rows).toEqual([
      { lang: "en", title: 'Hello, "world"' },
      { lang: "tr", title: "Merhaba" },
    ]);
    expect(parseCsv('a,b\n1,"two\nlines"')).toEqual([{ a: "1", b: "two\nlines" }]);
    expect(() => parseCsv('a\n"open')).toThrow(/quoted/);
  });

  it("reads JSON arrays or { rows }", () => {
    const dir = tempDir("chroma-data-");
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify([{ v: 1 }]));
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ rows: [{ v: 2 }] }));
    fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ nope: 1 }));
    expect(parseDataFile(path.join(dir, "a.json"))).toEqual([{ v: 1 }]);
    expect(parseDataFile(path.join(dir, "b.json"))).toEqual([{ v: 2 }]);
    expect(() => parseDataFile(path.join(dir, "c.json"))).toThrow(/array of objects/);
  });

  it("turns cells into AE values", () => {
    expect(cellValue("text", 12)).toEqual({ value: "12" });
    expect(cellValue("value", "60")).toEqual({ value: 60 });
    expect(cellValue("value", "100, 75")).toEqual({ value: [100, 75] });
    expect(cellValue("value", "[1;2;3]")).toEqual({ value: [1, 2, 3] });
    expect(cellValue("value", "40%")).toEqual({ value: 40 });
    expect(cellValue("value", true)).toEqual({ value: 1 });
    expect(cellValue("value", "abc")).toHaveProperty("error");
    expect(cellValue("color", "#ff8000")).toEqual({ value: [1, 128 / 255, 0, 1] });
    expect(cellValue("color", [0.1, 0.2, 0.3])).toEqual({ value: [0.1, 0.2, 0.3, 1] });
    expect(cellValue("color", "red")).toHaveProperty("error");
    expect(cellValue("footage", "relative.png")).toHaveProperty("error");
    expect(cellValue("footage", path.join(os.tmpdir(), "missing-chroma-file.png"))).toHaveProperty("error");
  });

  it("fills name patterns", () => {
    expect(fillName("{{template}} - {{lang}} #{{#}}", { lang: "tr" }, 2, "Promo")).toBe("Promo - tr #2");
    expect(fillName("{{ missing }}x", {}, 1, "T")).toBe("x");
  });

  it("checks every cell before writing, and skips empty ones", () => {
    const mapping = [
      { column: "title", layer: { name: "Title" }, target: "text" as const },
      { column: "v", layer: { name: "Bar" }, target: "value" as const, path: ["Scale"] },
    ];
    const ok = prepareRows([{ title: "A", v: "5" }, { title: "", v: "6" }], mapping, "{{#}}", "T");
    expect(ok.problems).toEqual([]);
    expect(ok.prepared[1].values).toEqual([null, 6]);
    expect(ok.skipped).toHaveLength(1);
    const bad = prepareRows([{ title: "A", v: "x" }], [...mapping, { column: "nope", layer: { name: "X" }, target: "text" as const }], "{{#}}", "T");
    expect(bad.problems.some((p) => /column "nope"/.test(p))).toBe(true);
    expect(bad.problems.some((p) => /row 1, "v"/.test(p))).toBe(true);
  });

  it("compares the read-back, allowing AE's third dimension, and flags text off the frame", () => {
    const mapping = AeBuildFromDataSchema.parse({
      template_comp_id: 1,
      rows: [{}],
      expect: { project_path: "<unsaved>" },
      mapping: [
        { column: "t", layer: { name: "Title" }, target: "text" },
        { column: "s", layer: { name: "Bar" }, target: "value", path: ["ADBE Transform Group", "ADBE Scale"] },
      ],
    }).mapping;
    const prepared = [{ row: 1, name: "A", values: ["Line one\nLine two", [100, 75]] }];
    const ok = checkBuild(prepared, mapping, [
      { comp_id: 2, name: "A", width: 1920, height: 1080, values: [{ text: "Line one\rLine two", bounds: { left: 10, top: 10, right: 2000, bottom: 50 } }, { value: [100, 75, 100] }] },
    ]);
    expect(ok.mismatches).toEqual([]);
    expect(ok.off_frame).toHaveLength(1);
    const bad = checkBuild(prepared, mapping, [{ comp_id: 2, name: "A", width: 1920, height: 1080, values: [{ text: "Other" }, { value: [100, 50, 100] }] }]);
    expect(bad.mismatches).toHaveLength(2);
  });
});

describe("data fixes", () => {
  it("keeps a record that had a quoted empty cell, and still drops blank lines", () => {
    expect(parseCsv('t\n""\nx\n\n')).toEqual([{ t: "" }, { t: "x" }]);
  });

  it("fills names in one pass and falls back to template and row number", () => {
    expect(fillName("{{title}}", { title: "{{#}}" }, 3, "T")).toBe("{{#}}");
    expect(fillName("{{ title }}", { title: "" }, 4, "Promo")).toBe("Promo - 4");
    expect(fillName("{{template}}", {}, 1, "{{#}}")).toBe("{{#}}");
  });

  it("refuses cells the template's properties can't take", () => {
    const mapping = [
      { column: "v", layer: { name: "Bar" }, target: "value" as const, path: ["Slider"], keyframe: 3 },
      { column: "s", layer: { name: "Bar" }, target: "value" as const, path: ["Scale"] },
      { column: "c", layer: { name: "Bar" }, target: "color" as const, path: ["Fill"] },
      { column: "f", layer: { name: "Pic" }, target: "footage" as const },
    ];
    const rows = [{ v: "1,5", s: "50", c: "#ff0000", f: "/x.png" }];
    const prepared = [{ row: 1, name: "A", values: [[1, 5], 50, [1, 0, 0, 1], "/x.png"] }];
    const problems = validateAgainstTemplate(rows, prepared, mapping, [
      { kind: "property", dims: 1, num_keys: 2 },
      { kind: "property", dims: 3, num_keys: 0 },
      { kind: "property", dims: 1, is_color: false, num_keys: 0 },
      { kind: "footage", can_take_footage: false },
    ]);
    expect(problems.some((p) => /reads as a list of 2 numbers; for a decimal use a point, 1.5/.test(p))).toBe(true);
    expect(problems.some((p) => /keyframe 3 is past/.test(p))).toBe(true);
    expect(problems.some((p) => /single number/.test(p))).toBe(true);
    expect(problems.some((p) => /not a colour property/.test(p))).toBe(true);
    expect(problems.some((p) => /can't take footage/.test(p))).toBe(true);
    const ok = validateAgainstTemplate(
      [{ s: "100, 75" }],
      [{ row: 1, name: "A", values: [[100, 75]] }],
      [mapping[1]],
      [{ kind: "property", dims: 3, num_keys: 0 }]
    );
    expect(ok).toEqual([]);
  });

  it("compares every key and flags off-frame text only where the cell was set", () => {
    const mapping = AeBuildFromDataSchema.parse({
      template_comp_id: 1,
      rows: [{}],
      expect: { project_path: "<unsaved>" },
      mapping: [
        { column: "t", layer: { name: "Title" }, target: "text" },
        { column: "s", layer: { name: "Bar" }, target: "value", path: ["Slider"], keyframe: "all" },
      ],
    }).mapping;
    const wide = { left: 10, top: 10, right: 3000, bottom: 50 };
    const keys = { comp_id: 2, name: "A", width: 1920, height: 1080, values: [{ text: "x", bounds: wide }, { value: 5, keys: [1, 2], key_values: [5, 6] }] };
    const r = checkBuild([{ row: 1, name: "A", values: [null, 5] }], mapping, [keys]);
    expect(r.off_frame).toEqual([]);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].path).toBe("A.s[key 2]");
  });
});

describe("ae_build_from_data", () => {
  it("is registered with automatic checkpoints", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_build_from_data")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_build_from_data");
  });

  it("dry_run reports the plan without writing, and bad cells stop the build", async () => {
    const { ctx, calls } = fakeAe({
      getComp: [{ name: "Promo" }, { name: "Promo" }],
      inspectDataMapping: [{ mappings: [{ kind: "text", dims: 0, num_keys: 0 }] }, { mappings: [{ kind: "property", dims: 4, is_color: true, num_keys: 0 }] }],
    });
    const tool = dataTools[0];
    const mapping = [{ column: "title", layer: { name: "Title" }, target: "text" }];
    const dry: any = await tool.handler(
      AeBuildFromDataSchema.parse({ template_comp_id: 1, rows: [{ lang: "en", title: "Hi" }], mapping, name: "{{template}} {{lang}}", dry_run: true, expect: { project_path: "<unsaved>" } }),
      ctx
    );
    expect(dry.comps).toEqual([{ row: 1, name: "Promo en", values: ["Hi"] }]);
    expect(dry.folder).toBe("Promo (data)");
    const bad: any = await tool.handler(
      AeBuildFromDataSchema.parse({ template_comp_id: 1, rows: [{ c: "nope" }], mapping: [{ column: "c", layer: { name: "Logo" }, target: "color", path: ["Fill", "Color"] }], expect: { project_path: "<unsaved>" } }),
      ctx
    );
    expect(bad.error).toBe("bad_data");
    expect(calls.map((c) => c.fn)).toEqual(["getComp", "inspectDataMapping", "getComp", "inspectDataMapping"]);
  });

  it("builds in one guarded write and reads back separately", async () => {
    const { ctx, calls } = fakeAe({
      getComp: [{ name: "Promo" }],
      inspectDataMapping: [{ mappings: [{ kind: "text", dims: 0, num_keys: 0 }] }],
      snapshotForReceipt: [{ numItems: 1 }, { numItems: 3 }],
      buildFromData: [{ folder_id: 9, mapping: [{ index: 2, layer_name: "Title", target: "text" }], comps: [{ comp_id: 5, name: "Promo - 1", row: 1, notes: [] }] }],
      readDataBuild: [{ comps: [{ comp_id: 5, name: "Promo - 1", width: 1920, height: 1080, values: [{ text: "Hi" }] }] }],
    });
    const out: any = await dataTools[0].handler(
      AeBuildFromDataSchema.parse({ template_comp_id: 1, rows: [{ title: "Hi" }], mapping: [{ column: "title", layer: { name: "Title" }, target: "text" }], expect: { project_path: "<unsaved>" } }),
      ctx
    );
    expect(out.receipt.matches).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["getComp", "inspectDataMapping", "checkGuard", "snapshotForReceipt", "buildFromData", "snapshotForReceipt", "readDataBuild"]);
    const write = calls.find((c) => c.fn === "buildFromData")!.args;
    expect(write.rows).toEqual([{ row: 1, name: "Promo - 1", values: ["Hi"] }]);
    expect(write.expect.comp_id).toBe(1);
  });
});

describe("ae_reframe planning", () => {
  it("parses aspects and keeps the source's short side", () => {
    expect(parseAspect("9:16")).toBeCloseTo(0.5625);
    expect(parseAspect("4x5")).toBeCloseTo(0.8);
    expect(parseAspect("wide")).toBeUndefined();
    expect(sizeForAspect(1920, 1080, 9 / 16)).toEqual({ width: 1080, height: 1920 });
    expect(sizeForAspect(1920, 1080, 1)).toEqual({ width: 1080, height: 1080 });
    expect(sizeForAspect(1920, 1080, 4 / 5)).toEqual({ width: 1080, height: 1350 });
    expect(sizeForAspect(1080, 1920, 16 / 9)).toEqual({ width: 1920, height: 1080 });
  });

  it("picks margins per aspect, with overrides", () => {
    expect(aspectName(1080, 1920)).toBe("9:16");
    expect(marginsFor(1080, 1920).bottom).toBe(0.2);
    expect(marginsFor(1920, 1080).left).toBe(0.05);
    expect(marginsFor(1000, 700)).toEqual({ top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 });
    expect(marginsFor(1080, 1920, { bottom: 0.3 }).bottom).toBe(0.3);
  });

  it("plans targets with names, sizes and margins, and rejects bad aspects", () => {
    const args = AeReframeSchema.parse({ comp_id: 1, targets: [{ aspect: "9:16" }, { aspect: "1:1", name: "Square" }, { aspect: "2:1", width: 1000, height: 500 }], expect: { project_path: "<unsaved>" } });
    const { targets, problems } = planTargets(args, 1920, 1080, "Promo");
    expect(problems).toEqual([]);
    expect(targets.map((t) => [t.name, t.width, t.height])).toEqual([
      ["Promo 1080x1920", 1080, 1920],
      ["Square", 1080, 1080],
      ["Promo 1000x500", 1000, 500],
    ]);
    const bad = planTargets(AeReframeSchema.parse({ comp_id: 1, targets: [{ aspect: "tall" }], expect: { project_path: "<unsaved>" } }), 1920, 1080, "P");
    expect(bad.problems).toHaveLength(1);
  });

  it("derives the other side from a lone width or height, and rejects sizes AE can't make", () => {
    const args = AeReframeSchema.parse({ comp_id: 1, targets: [{ aspect: "9:16", width: 540 }, { aspect: "4:5", height: 1350 }, { aspect: "100:1" }], expect: { project_path: "<unsaved>" } });
    const { targets, problems } = planTargets(args, 1920, 1080, "P");
    expect([targets[0].width, targets[0].height]).toEqual([540, 960]);
    expect([targets[1].width, targets[1].height]).toEqual([1080, 1350]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/100:1/);
  });

  it("writes every size in one guarded call and reports what is outside the safe area", async () => {
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_reframe");
    const safe = { left: 64.8, top: 230.4, right: 1015.2, bottom: 1536 };
    const { ctx, calls } = fakeAe({
      getComp: [{ name: "Promo", width: 1920, height: 1080 }],
      snapshotForReceipt: [{ numItems: 1 }, { numItems: 2 }],
      reframeComp: [{ source: { comp_id: 1 }, comps: [{ comp_id: 7, name: "Promo 1080x1920", width: 1080, height: 1920, safe, guide_layer_id: 3, layers: [] }] }],
      reframeReport: [{ comps: [{ comp_id: 7, width: 1080, height: 1920, outside_safe: [{ name: "Title" }] }] }],
    });
    const out: any = await reframeTools[0].handler(AeReframeSchema.parse({ comp_id: 1, targets: [{ aspect: "9:16" }], expect: { project_path: "<unsaved>" } }), ctx);
    expect(out.receipt.matches).toBe(true);
    expect(out.comps[0].outside_safe).toEqual([{ name: "Title" }]);
    const write = calls.find((c) => c.fn === "reframeComp")!.args;
    expect(write.targets[0]).toMatchObject({ width: 1080, height: 1920, margins: { bottom: 0.2 } });
    expect(write.shrink).toBe(true);
    expect(write.guide).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["getComp", "checkGuard", "snapshotForReceipt", "reframeComp", "snapshotForReceipt", "reframeReport"]);
  });
});
