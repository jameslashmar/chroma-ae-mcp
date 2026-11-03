/**
 * Regression tests for what the check of the review fixes found: writes that
 * still threw after they were applied, checks that ran inside the undo group,
 * previews that hid what they couldn't list, and results that looked clean
 * when nothing had been checked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeAudioAnalyzeSchema, createAudioTools } from "../src/tools/ext/audio.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeProject, GUARD, loadHost, type FakeProperty } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * AE answering from a script of results per host function, in call order. An
 * Error entry is a host error; { __timeout } is a timeout.
 */
function scriptedAe(results: Record<string, unknown[]>, projectPath = "<unsaved>") {
  const calls: Array<{ fn: string; args: any }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-follow-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      let args: any = {};
      try {
        args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "{}");
      } catch {
        args = {};
      }
      calls.push({ fn, args });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: projectPath, comp_id: 1, comp_is_valid: true, dirty: false }, durationMs: 1 };
      }
      const queueFor = results[fn];
      if (!queueFor || queueFor.length === 0) throw new Error(`Unexpected script: ${fn}`);
      const next = queueFor.shift();
      if (next instanceof Error) return { ok: false, error: { message: next.message, kind: "runtime" } } as any;
      if (next && typeof next === "object" && "__timeout" in (next as object)) return { ok: false, error: { message: "timed out", kind: "timeout" } } as any;
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tool(name).handler(tool(name).schema.parse(args), ctx) as Promise<any>;
const opacity = ["ADBE Transform Group", "ADBE Opacity"];

describe("ae_batch_set after a failed chunk read-back", () => {
  it("returns what was applied, stops, and does not throw", async () => {
    const ops = [1, 2, 3].map((i) => ({ layer: { index: i }, path: opacity, value: 50 }));
    const { ctx, calls } = scriptedAe({
      batchValidate: [{ ok: true }, { ok: true }],
      batchRead: [{ time: 0, results: [] }, new Error("popup in the way")],
      batchSet: [{ done: 2 }],
    });
    const out = await run("ae_batch_set", { comp_id: 1, ops, chunk_size: 2, expect: GUARD }, ctx);
    expect(out).toMatchObject({ ok: false, error: "read_back_failed", applied: true, done: 2 });
    expect(out.mismatches[0].message).toMatch(/applied.*popup in the way.*Do not resend/);
    expect(calls.filter((c) => c.fn === "batchSet")).toHaveLength(1);
  });
});

describe("ae_build_from_data and ae_reframe with partial read-backs", () => {
  const dataArgs = { template_comp_id: 1, rows: [{ title: "Hi" }], mapping: [{ column: "title", layer: { name: "Title" }, target: "text" }], expect: GUARD };
  const dataBase = () => ({
    getComp: [{ name: "Promo" }],
    inspectDataMapping: [{ mappings: [{ kind: "text", dims: 0, num_keys: 0 }] }],
    buildFromData: [{ folder_id: 9, mapping: [{ index: 2, layer_name: "Title", target: "text" }], comps: [{ comp_id: 5, name: "Promo - 1", row: 1, notes: [] }] }],
  });

  it("still checks the values when only the project snapshot fails", async () => {
    const { ctx } = scriptedAe({
      ...dataBase(),
      snapshotForReceipt: [{ numItems: 1 }, new Error("snapshot broke")],
      readDataBuild: [{ comps: [{ comp_id: 5, name: "Promo - 1", width: 1920, height: 1080, values: [{ text: "Hi" }] }] }],
    });
    const out = await run("ae_build_from_data", dataArgs, ctx);
    expect(out.applied).toBe(true);
    expect(Array.isArray(out.off_frame)).toBe(true);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("read_back");
  });

  it("reports off_frame as unchecked when the build can't be read back", async () => {
    const { ctx } = scriptedAe({ ...dataBase(), snapshotForReceipt: [{ numItems: 1 }, { numItems: 3 }], readDataBuild: [new Error("read broke")] });
    const out = await run("ae_build_from_data", dataArgs, ctx);
    expect(out).toMatchObject({ applied: true, off_frame: null });
  });

  it("ae_reframe reports outside_safe as unchecked when its report fails", async () => {
    const { ctx } = scriptedAe({
      getComp: [{ name: "Edit", width: 1920, height: 1080 }],
      snapshotForReceipt: [{ numItems: 1 }, { numItems: 2 }],
      reframeComp: [{ source: {}, comps: [{ comp_id: 7, name: "Edit 9x16", safe: [0, 0, 1, 1] }] }],
      reframeReport: [new Error("report broke")],
    });
    const out = await run("ae_reframe", { comp_id: 1, targets: [{ aspect: "9:16" }], expect: GUARD }, ctx);
    expect(out.applied).toBe(true);
    expect(out.comps[0].outside_safe).toBeNull();
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("ae_checkpoint_revert reports a failed status read after opening the checkpoint", async () => {
    const dir = tempDir("chroma-follow-cp-");
    const aep = path.join(dir, "Job.aep");
    const cp = path.join(dir, "_mcp_checkpoints", "Job_1.aep");
    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(aep, "a");
    fs.writeFileSync(cp, "c");
    const { ctx } = scriptedAe({ status: [{ project_path: aep, dirty: false }, new Error("status broke")], openProject: [{ project_path: cp }] }, aep);
    const out = await run("ae_checkpoint_revert", { checkpoint_path: cp, expect: { project_path: aep } }, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches[0].message).toMatch(/applied.*status broke/);
  });
});

describe("ae_remove_markers dry run past the listing cap", () => {
  it("counts requested indexes past the listed markers and says the list is partial", async () => {
    const listed = Array.from({ length: 500 }, (_, i) => ({ index: i + 1, time: i, duration: 0, comment: "m" }));
    const { ctx } = scriptedAe({ listMarkers: [{ target: "comp", numMarkers: 700, markers: listed, truncated: true }, { target: "comp", numMarkers: 700, markers: listed, truncated: true }] });
    const byIndex = await run("ae_remove_markers", { comp_id: 1, indexes: [3, 600], dry_run: true }, ctx);
    expect(byIndex).toMatchObject({ count: 2, beyond_list: [600], truncated: true });
    const all = await run("ae_remove_markers", { comp_id: 1, all: true, dry_run: true }, ctx);
    expect(all.count).toBeUndefined();
    expect(all.count_at_least).toBe(500);
    expect(all.note).toMatch(/first 500 of 700/);
  });
});

describe("ae_export_mogrt cleanup", () => {
  it("keeps a folder it made when the export timed out, and removes it when AE refused", async () => {
    const base = tempDir("chroma-follow-mogrt-");
    const timedOut = path.join(base, "a", "t.mogrt");
    const t = scriptedAe({ exportMogrt: [{ __timeout: true }] });
    await expect(run("ae_export_mogrt", { comp_id: 1, path: timedOut, expect: GUARD }, t.ctx)).rejects.toThrow();
    expect(fs.existsSync(path.dirname(timedOut))).toBe(true);
    const refused = path.join(base, "b", "t.mogrt");
    const r = scriptedAe({ exportMogrt: [new Error("no controllers")] });
    await expect(run("ae_export_mogrt", { comp_id: 1, path: refused, expect: GUARD }, r.ctx)).rejects.toThrow(/no controllers/);
    expect(fs.existsSync(path.dirname(refused))).toBe(false);
  });
});

describe("host checks before the undo group", () => {
  it("cueKeys refuses a value past the property's limits before clearing any key", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main");
    const { A, undo } = loadHost(project, ["layers.jsx", "audio.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Ball", expect: GUARD });
    const op = comp.layer("Ball")!.transform("ADBE Opacity") as FakeProperty & Record<string, unknown>;
    Object.assign(op, { hasMin: true, minValue: 0, hasMax: true, maxValue: 100 });
    op.setValuesAtTimes([0.5, 1, 1.5], [10, 20, 30]);
    const before = undo.begun;
    expect(() =>
      A.cueKeys({ comp_id: comp.id, layer: { name: "Ball" }, path: opacity, keys: [{ time: 1, value: 150 }], clear_range: [0, 2], expect: GUARD })
    ).toThrow(/above the maximum/);
    expect(op.numKeys).toBe(3);
    expect(undo.begun).toBe(before);
  });

  it("createLayer takes back a null's solid item when a later step fails", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main");
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "BG", expect: GUARD });
    const realAddNull = comp.layers.addNull;
    // AE's addNull adds a solid item ("Null 1") to the project, as addSolid does.
    comp.layers.addNull = (dur?: number) => {
      const l = realAddNull(dur);
      l.source = project.addFootage("Null 1", 100, 100);
      l.moveBefore = () => {
        throw new Error("move failed");
      };
      return l;
    };
    const items = project.all.length;
    expect(() => A.createLayer({ comp_id: comp.id, type: "null", placement: { above: { name: "BG" } }, expect: GUARD })).toThrow(/move failed/);
    expect(project.all.length).toBe(items);
    expect(comp.numLayers).toBe(1);
  });

  it("fontsInUse counts a text layer whose text document reads as null as skipped", () => {
    const project = new FakeProject();
    const comp = project.addComp("Titles");
    comp.layers.addText("Hello");
    const layer = comp.layer(1)!;
    const real = layer.property.bind(layer);
    layer.property = (sel: string | number) => (sel === "ADBE Text Properties" ? ({ property: () => null } as any) : real(sel));
    const { A } = loadHost(project, ["inventory.jsx"]);
    const f = A.fontsInUse({});
    expect(f.text_layers).toBe(1);
    expect(f.skipped_layers).toBe(1);
  });

  it("styleScan reads at the time it is given", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main");
    comp.time = 1;
    const { A } = loadHost(project, ["layout.jsx"]);
    expect(A.styleScan({ comp_id: comp.id, time: 2.5 }).time).toBe(2.5);
    expect(A.styleScan({ comp_id: comp.id }).time).toBe(1);
  });
});

describe("ae_audio_analyze range", () => {
  it("refuses a range whose whole-frame render runs past 20 minutes, before rendering", async () => {
    let started = false;
    const tools = createAudioTools({ startRender: async () => ((started = true), { job_id: "j" }), rendersDir: () => tempDir("chroma-follow-audio-") });
    const { ctx } = scriptedAe({
      audioCompInfo: [{ comp_id: 1, name: "Long", name_unique: true, duration: 1200, fps: 29.97003, frame_duration: 1 / 29.97003, display_start_time: 0, audio_layers: [{ index: 1, name: "Music" }], project_path: "C:/p/x.aep", dirty: false }],
    });
    const out: any = await tools[0].handler(AeAudioAnalyzeSchema.parse({ comp_id: 1, expect: { project_path: "C:/p/x.aep" } }), ctx);
    expect(out.error).toBe("too_long");
    expect(started).toBe(false);
  });
});

describe("ae_motion_review with a cut-short ancestor scan", () => {
  it("leaves a layer whose parent may be unscanned out of the bounds check, and says so", async () => {
    const times = Array.from({ length: 26 }, (_, i) => i / 25);
    const samples = {
      comp: { id: 7, name: "Shot", fps: 25 },
      layer: { index: 2, id: 12, name: "Child" },
      property: { name: "Position", matchName: "ADBE Position", value_type: "TwoD_SPATIAL", spatial: true, dimensions: 2, num_keys: 2, keys_truncated: false, samples_capped: false, expression: false },
      start: 0,
      end: 1,
      step: 0.04,
      times,
      values: times.map((t) => [100 * t * t * (3 - 2 * t), 0]),
      keys: [
        { index: 1, time: 0, value: [0, 0], in_interp: "bezier", out_interp: "bezier" },
        { index: 2, time: 1, value: [100, 0], in_interp: "bezier", out_interp: "bezier" },
      ],
    };
    const { ctx, calls } = scriptedAe({
      listAnimatedProperties: [
        {
          comp: { id: 7, name: "Shot", fps: 25, width: 1920, height: 1080, workAreaStart: 0, workAreaDuration: 2 },
          project_path: "C:/jobs/Shot.aep",
          layers_scanned: 1,
          truncated: false,
          ancestors_truncated: true,
          properties: [{ layer: { index: 2, id: 12, name: "Child", parents: [11] }, path: ["ADBE Transform Group", "ADBE Position"], name: "Position", matchName: "ADBE Position", num_keys: 2, first_key_time: 0, last_key_time: 1, expression: false }],
        },
      ],
      sampleProperty: [samples],
    });
    const out = await run("ae_motion_review", { comp_id: 7 }, ctx);
    expect(calls.some((c) => c.fn === "layerBoundsAt")).toBe(false);
    expect(out.ancestors_truncated).toBe(true);
    expect(out.bounds_unchecked[0]).toMatchObject({ layer: "Child", reason: expect.stringMatching(/parent's motion was not fully scanned/) });
  });
});
