/**
 * Regression tests for the reads fixes: flat-list depth, placeholders vs
 * missing files, comp-tree cost and grouping, unreadable text layers, and
 * ae_fonts missing_only with unknown fonts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { inventoryTools } from "../src/tools/ext/inventory.js";
import { AeGetProjectSchema, readTools } from "../src/tools/read.js";
import { FakeProject, loadHost, PlaceholderSource } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string) => unknown) {
  const scripts: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fix-reads-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      scripts.push(script);
      return { ok: true, result: answer(script.slice("__chromaAe.".length, script.indexOf("("))), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, scripts };
}

describe("ae_get_project depth", () => {
  it("walks every level for any sort, offset or limit, like the host's flat list", async () => {
    const { ctx, scripts } = fakeAe(() => ({ items: [] }));
    const tool = readTools.find((t) => t.name === "ae_get_project")!;
    await tool.handler(AeGetProjectSchema.parse({ sort: "name", limit: 100 }), ctx);
    await tool.handler(AeGetProjectSchema.parse({ offset: 0 }), ctx);
    await tool.handler(AeGetProjectSchema.parse({ sort: "tree" }), ctx);
    await tool.handler(AeGetProjectSchema.parse({ limit: 10, depth: 4 }), ctx);
    expect(scripts[0]).toContain('"depth":20');
    expect(scripts[1]).toContain('"depth":20');
    expect(scripts[2]).toContain('getProject({"depth":3})');
    expect(scripts[3]).toContain('"depth":4');
  });

  it("the host defaults to every level when paged without a depth, and offset 0 gives the paged shape", () => {
    const project = new FakeProject();
    let folder = project.rootFolder;
    for (let i = 0; i < 5; i++) folder = project.addFolder(`f${i}`, folder);
    project.addFootage("deep", 10, 10, undefined, folder);
    const { A } = loadHost(project, []);
    const r = A.getProject({ sort: "name" });
    expect(r.total).toBe(6);
    expect(r.items.map((i: any) => i.name)).toContain("deep");
    expect(A.getProject({ offset: 0 })).toMatchObject({ total: 6, next_offset: null });
    expect(A.getProject({}).total).toBeUndefined();
  });
});

describe("placeholders and missing files", () => {
  it("keeps placeholders out of missing and missing_only", () => {
    const project = new FakeProject();
    const lost = project.addFootage("lost", 10, 10);
    lost.footageMissing = true;
    const ph = project.addFootage("ph", 10, 10, new PlaceholderSource());
    ph.footageMissing = true;
    const { A } = loadHost(project, []);
    const all = A.getProject({ depth: 3 });
    const by = (n: string) => all.items.find((i: any) => i.name === n);
    expect(by("lost").missing).toBe(true);
    expect(by("lost").placeholder).toBeUndefined();
    expect(by("ph").missing).toBeUndefined();
    expect(by("ph").placeholder).toBe(true);
    const only = A.getProject({ depth: 3, missing_only: true });
    expect(only.items.map((i: any) => i.name)).toEqual(["lost"]);
    expect(A.getProject({ depth: 3, type: "placeholder" }).items.map((i: any) => i.name)).toEqual(["ph"]);
  });
});

describe("compTree", () => {
  function ladder(levels: number, perLevel: number) {
    const project = new FakeProject();
    const comps = [];
    for (let i = 0; i <= levels; i++) comps.push(project.addComp(`L${i}`));
    for (let i = 0; i < levels; i++) for (let k = 0; k < perLevel; k++) comps[i].layers.add(comps[i + 1]);
    return { project, comps };
  }

  it("computes nesting depth in linear time on repeated precomps", () => {
    const { project } = ladder(30, 3);
    const { A } = loadHost(project, ["inventory.jsx"]);
    const t0 = Date.now();
    const t = A.compTree({});
    expect(Date.now() - t0).toBeLessThan(2000);
    const by = (n: string) => t.comps.find((c: any) => c.name === n);
    expect(by("L0").nesting_depth).toBe(30);
    expect(by("L29").nesting_depth).toBe(1);
    expect(by("L30").nesting_depth).toBe(0);
  });

  it("counts distinct parent comps in used_in and layers in used_by_layers", () => {
    const { project } = ladder(1, 2);
    const { A } = loadHost(project, ["inventory.jsx"]);
    const t = A.compTree({});
    expect(t.comps.find((c: any) => c.name === "L1")).toMatchObject({ used_in: 1, used_by_layers: 2 });
  });

  it("groups the layers of one parent into a single used_in node", () => {
    const { project, comps } = ladder(2, 3);
    const { A } = loadHost(project, ["inventory.jsx"]);
    const up = A.compTree({ comp_id: comps[2].id });
    expect(up.used_in.length).toBe(1);
    expect(up.used_in[0]).toMatchObject({ name: "L1" });
    expect(up.used_in[0].layers.length).toBe(3);
    expect(up.used_in[0].used_in.length).toBe(1);
    expect(up.used_in[0].used_in[0].layers.length).toBe(3);
  });

  it("does not call comps top-level or unused when the layer scan was cut short", () => {
    const project = new FakeProject();
    const big = project.addComp("Big");
    for (let i = 0; i < 50001; i++) big.layers.addNull();
    const main = project.addComp("Main");
    const child = project.addComp("Child");
    main.layers.add(child);
    const { A } = loadHost(project, ["inventory.jsx"]);
    const t = A.compTree({});
    expect(t.partial).toBe(true);
    expect(t.top_level).toBeNull();
    expect(t.unused).toBeNull();
  });
});

describe("fontsInUse", () => {
  it("skips an unreadable text layer and counts it", () => {
    const project = new FakeProject();
    const comp = project.addComp("Titles");
    comp.layers.addText("Good");
    comp.layers.addText("Odd");
    const odd = comp.layer("Odd")!;
    (odd as any).property = () => {
      throw new Error("no text document");
    };
    const { A } = loadHost(project, ["inventory.jsx"]);
    const f = A.fontsInUse({});
    expect(f.text_layers).toBe(2);
    expect(f.skipped_layers).toBe(1);
    expect(f.fonts.length).toBe(1);
    expect(f.fonts[0].layers[0].layer).toBe("Good");
  });
});

describe("ae_fonts missing_only", () => {
  it("lists fonts known to be missing and reports how many have an unknown state", async () => {
    const { ctx } = fakeAe(() => ({
      fonts: [{ font: "A", missing: false }, { font: "B", missing: true }, { font: "C", missing: null }, { font: "D", missing: null }],
      missing: ["B"],
      missing_known: false,
    }));
    const tool = inventoryTools.find((t) => t.name === "ae_fonts")!;
    const out = await tool.handler({ missing_only: true }, ctx);
    expect(out.fonts.map((f: { font: string }) => f.font)).toEqual(["B"]);
    expect(out.unknown_state).toBe(2);
    expect(out.note).toMatch(/2 font/);
    const all = await tool.handler({}, ctx);
    expect(all.fonts.length).toBe(4);
  });

  it("has no note when every state is known", async () => {
    const { ctx } = fakeAe(() => ({ fonts: [{ font: "B", missing: true }], missing_known: true }));
    const out = await inventoryTools.find((t) => t.name === "ae_fonts")!.handler({ missing_only: true }, ctx);
    expect(out.unknown_state).toBe(0);
    expect(out.note).toBeUndefined();
  });
});

describe("review follow-ups", () => {
  it("depth has no schema default and says so in its description", () => {
    expect(AeGetProjectSchema.parse({}).depth).toBeUndefined();
    const desc = (AeGetProjectSchema.shape.depth as any).description as string;
    expect(desc).toContain("20");
  });

  it("a truncated unfiltered read tells the caller to restart at offset 0", () => {
    const project = new FakeProject();
    for (let i = 0; i < 501; i++) project.addFootage(`f${i}`, 10, 10);
    const { A } = loadHost(project, []);
    const r = A.getProject({});
    expect(r.truncated).toBe(true);
    expect(r.next).toContain("offset:0");
    expect(r.next_offset).toBeUndefined();
    const small = new FakeProject();
    small.addFootage("one", 10, 10);
    expect(loadHost(small, []).A.getProject({}).next).toBeUndefined();
  });

  it("a text layer whose later key fails keeps the earlier uses and is skipped once", () => {
    const project = new FakeProject();
    const comp = project.addComp("Titles");
    comp.layers.addText("Keyed");
    const layer = comp.layer("Keyed")! as any;
    const doc = { font: "Arial", fontFamily: "Arial", fontStyle: "Regular", fontLocation: "" };
    const st = {
      numKeys: 3,
      keyValue: (k: number) => {
        if (k === 3) throw new Error("bad key");
        return doc;
      },
    };
    layer.property = () => ({ property: () => st });
    const { A } = loadHost(project, ["inventory.jsx"]);
    const f = A.fontsInUse({});
    expect(f.skipped_layers).toBe(1);
    expect(f.fonts[0].uses).toBe(2);
  });
});
