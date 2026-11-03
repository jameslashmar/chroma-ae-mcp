/**
 * ae_explain_layer and ae_explain_layer_proof: the schemas, the pure ranking
 * and proof logic, the proof's guarded flow against a fake bridge, and
 * panel/host/ext/explain.jsx under node:vm against the fake AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeExplainLayerProofSchema,
  AeExplainLayerSchema,
  FIX_HINTS,
  cropFrame,
  explainTools,
  proofMismatches,
  proofVerdict,
  rankExplanation,
  regionToPixels,
  type ExplainFinding,
  type ExplainRaw,
} from "../src/tools/ext/explain.js";
import {
  FakeFootage,
  FakeGroup,
  FakeLayer,
  FakeProject,
  FakeProperty,
  GUARD,
  MaskMode,
  PropertyValueType,
  TrackMatteType,
  loadHost,
  type FakeComp,
} from "./support/fake-ae.js";

const tool = (name: string) => explainTools.find((t) => t.name === name)!;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const expectArg = { project_path: "<unsaved>" };

// ---------- schemas ----------

describe("explain schemas and tools", () => {
  it("ae_explain_layer needs a layer or a point, and takes no guard", () => {
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1 }).success).toBe(false);
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1, layer: { index: 1 } }).success).toBe(true);
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1, point: [10, 20] }).success).toBe(true);
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1, point: [10] }).success).toBe(false);
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1, layer: {} }).success).toBe(false);
    expect(AeExplainLayerSchema.safeParse({ comp_id: 1, layer: { index: 1 }, time: -1 }).success).toBe(false);
    expect("expect" in AeExplainLayerSchema.innerType().shape).toBe(false);
  });

  it("ae_explain_layer_proof takes expect, a layer and a known suspect", () => {
    const ok = { comp_id: 1, layer: { name: "Logo" }, suspect: "enabled", expect: expectArg };
    expect(AeExplainLayerProofSchema.safeParse(ok).success).toBe(true);
    expect(AeExplainLayerProofSchema.safeParse({ ...ok, expect: undefined }).success).toBe(false);
    expect(AeExplainLayerProofSchema.safeParse({ ...ok, suspect: "parent_opacity" }).success).toBe(false);
    expect(AeExplainLayerProofSchema.safeParse({ ...ok, threshold: 2 }).success).toBe(false);
  });

  it("descriptions end with the agent safety guidance", () => {
    for (const t of explainTools) expect(t.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(explainTools.map((t) => t.name)).toEqual(["ae_explain_layer", "ae_explain_layer_proof"]);
  });
});

// ---------- pure logic ----------

const F = (id: string, severity: ExplainFinding["severity"], order: number): ExplainFinding => ({ id, severity, order, title: `${id} title`, detail: "" });

describe("rankExplanation", () => {
  const layer = { index: 1, id: 5, name: "Logo" };

  it("sorts by severity, then order, and adds fix text", () => {
    const raw: ExplainRaw = {
      layer,
      findings: [F("blend_mode", "possible", 240), F("opacity_zero", "blocks", 40), F("disabled", "blocks", 10), F("shy", "info", 910), F("expression_error", "likely", 160)],
    };
    const r = rankExplanation(raw);
    expect(r.findings.map((f) => f.id)).toEqual(["disabled", "opacity_zero", "expression_error", "blend_mode", "shy"]);
    expect(r.findings[0].fix).toBe(FIX_HINTS.disabled);
    expect(r.counts).toEqual({ blocks: 2, likely: 1, possible: 1, info: 1 });
    expect(r.verdict).toBe("hidden");
    expect(r.headline).toBe("Hidden: disabled title.");
  });

  it("grades the verdict by the worst finding", () => {
    expect(rankExplanation({ layer, findings: [F("expression_error", "likely", 1)] }).verdict).toBe("probably_hidden_or_wrong");
    expect(rankExplanation({ layer, findings: [F("blend_mode", "possible", 1)] }).verdict).toBe("visible_with_possible_causes");
    expect(rankExplanation({ layer, findings: [F("shy", "info", 1)] }).verdict).toBe("no_cause_found");
    expect(rankExplanation({ layer }).verdict).toBe("no_cause_found");
  });

  it("describes a point with no layer", () => {
    const hit = rankExplanation({
      at_point: { candidates: [{ index: 1, id: 1, name: "Top", renders: false, reasons: ["video switch off"] }, { index: 2, id: 2, name: "BG", renders: true, reasons: [] }], topmost_rendering: 2 },
    });
    expect(hit.verdict).toBe("point_only");
    expect(hit.headline).toContain("2 (BG)");
    expect(rankExplanation({ at_point: { candidates: [{ index: 1, id: 1, name: "Top", renders: false, reasons: [] }], topmost_rendering: null } }).headline).toContain("none of them renders");
    expect(rankExplanation({ at_point: { candidates: [], topmost_rendering: null } }).headline).toContain("No 2D layer");
  });
});

describe("proof logic", () => {
  const diff = { changed_pixels: 10, total_pixels: 100, pct_pixels_changed: 10, mean_abs_diff: 0.1, max_diff: 1, identical: false };

  it("confirms a suspect when pixels change", () => {
    expect(proofVerdict("enabled", diff).verdict).toBe("confirmed");
    expect(proofVerdict("enabled", { ...diff, changed_pixels: 0, pct_pixels_changed: 0, identical: true }).verdict).toBe("not_confirmed");
    const none = proofVerdict("masks", null, "boom");
    expect(none.verdict).toBe("inconclusive");
    expect(none.explanation).toContain("boom");
  });

  it("words the verdict by where the diff was taken", () => {
    expect(proofVerdict("layers_above", diff, undefined, "layer_box").explanation).toContain("inside the layer's box");
    expect(proofVerdict("enabled", diff).explanation).toContain("in the frame");
  });

  it("maps the target's comp box to frame pixels and crops it", () => {
    expect(regionToPixels([0, 0, 4, 4], [8, 8], { width: 4, height: 4 })).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 });
    expect(regionToPixels([4, 4, 4, 8], [8, 8], { width: 4, height: 4 })).toBeNull();
    expect(regionToPixels(null, [8, 8], { width: 4, height: 4 })).toBeNull();
    const data = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data[i * 4] = i;
    const c = cropFrame({ width: 4, height: 4, data }, { x0: 1, y0: 1, x1: 3, y1: 3 });
    expect(c.width).toBe(2);
    expect([c.data[0], c.data[4], c.data[8], c.data[12]]).toEqual([5, 6, 9, 10]);
  });

  it("flags a left-over copy or a changed item count in the receipt", () => {
    const before = { num_items: 4, comps: 2, proof_comps: 0 };
    expect(proofMismatches(before, { ...before }, null, 9)).toEqual([]);
    const m = proofMismatches(before, { num_items: 5, comps: 3, proof_comps: 1 }, "gone wrong", 9);
    expect(m.map((x) => x.path)).toEqual(["temp_comp", "proof_comps", "num_items"]);
    expect(m[0].message).toContain("chroma-explain-proof");
  });
});

// ---------- the proof's guarded flow ----------

const tmpDirs: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;

beforeEach(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-explain-"));
  tmpDirs.push(d);
  process.env.LOCALAPPDATA = d;
});

afterEach(() => {
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeSolid(file: string, rgba: [number, number, number, number]) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 64; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Same as writeSolid's original colour inside the top-left 2x2, different elsewhere. */
function writeBoxed(file: string) {
  const png = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      const inside = x < 2 && y < 2;
      png.data[i] = inside ? 10 : 250;
      png.data[i + 1] = inside ? 20 : 250;
      png.data[i + 2] = inside ? 30 : 250;
      png.data[i + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** A PanelHost whose AE answers the proof's host calls, recording each one. */
function proofAe(
  opts: {
    copyColour?: [number, number, number, number];
    failRemove?: boolean;
    failBegin?: boolean;
    failPlan?: boolean;
    failAfter?: boolean;
    noCopyId?: boolean;
    afterItems?: number;
    region?: number[] | null;
    /** The copy's frame equals the original inside the top-left 2x2 pixels only. */
    sameInsideBox?: boolean;
    /** Report the Nth snapshot (0-based) as stale so the capture retries with a nudged time. */
    staleShot?: number;
  } = {}
) {
  const calls: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-explain-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  let states = 0;
  let shots = 0;
  let written = 0;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      if (fn === "explainProofPlan") {
        if (opts.failPlan) throw new Error("Nothing to toggle for suspect enabled");
        return { ok: true, result: { applies: true }, durationMs: 1 };
      }
      if (fn === "explainProofState") {
        states++;
        if (states === 2 && opts.failAfter) throw new Error("read failed");
        const items = states === 1 ? 4 : (opts.afterItems ?? 4);
        return { ok: true, result: { num_items: items, comps: 2, proof_comps: 0 }, durationMs: 1 };
      }
      if (fn === "explainProofBegin") {
        if (opts.failBegin) throw new Error("Nothing to toggle for suspect enabled");
        const res: Record<string, unknown> = { copy_name: "chroma-explain-proof Main", layer_index: 2, what: "turn the layer's video switch on", layers_changed: 1, time: 1.5, comp_size: [8, 8] };
        if (!opts.noCopyId) res.copy_id = 77;
        if (opts.region !== undefined) res.region = opts.region;
        return { ok: true, result: res, durationMs: 1 };
      }
      if (fn === "snapshotFrame") {
        const m = /"output_path":"([^"]+)"/.exec(script)!;
        const out = JSON.parse(`"${m[1]}"`) as string;
        const n = shots++;
        const isOriginal = written++ === 0;
        if (opts.staleShot === n) {
          // No file: waitForFreshPng finds nothing and the capture retries.
        } else if (isOriginal) writeSolid(out, [10, 20, 30, 255]);
        else if (opts.sameInsideBox) writeBoxed(out);
        else writeSolid(out, opts.copyColour ?? [200, 100, 50, 255]);
        return { ok: true, result: { path: out }, durationMs: 1 };
      }
      if (fn === "explainProofEnd") {
        if (opts.failRemove) throw new Error("item is locked");
        return { ok: true, result: { removed: true, copy_id: 77 }, durationMs: 1 };
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, scripts: () => calls };
}

describe("ae_explain_layer_proof flow", () => {
  const args = () => AeExplainLayerProofSchema.parse({ comp_id: 1, layer: { name: "Logo" }, suspect: "enabled", time: 1.5, expect: expectArg });

  it("guards, duplicates, renders both, removes the copy, and reads back separately", async () => {
    const { ctx, calls } = proofAe();
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(calls).toEqual(["explainProofPlan", "checkGuard", "explainProofState", "explainProofBegin", "snapshotFrame", "snapshotFrame", "explainProofEnd", "explainProofState"]);
    expect(out.applied).toBe(true);
    expect(out.verdict).toBe("confirmed");
    expect(out.proof).toMatchObject({ suspect: "enabled", copy_removed: true, layers_changed: 1, time: 1.5 });
    expect(out.proof.diff.pct_pixels_changed).toBe(100);
    expect(out.proof.frames.original).not.toBe(out.proof.frames.copy);
    expect(out.receipt.matches).toBe(true);
  });

  it("says not_confirmed when both renders are the same", async () => {
    const { ctx } = proofAe({ copyColour: [10, 20, 30, 255] });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(out.verdict).toBe("not_confirmed");
    expect(out.proof.diff.identical).toBe(true);
  });

  it("puts a failed removal into the receipt instead of throwing", async () => {
    const { ctx } = proofAe({ failRemove: true });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(out.applied).toBe(true);
    expect(out.proof.copy_removed).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => m.path === "temp_comp")).toBe(true);
  });

  it("flags an item count that did not come back", async () => {
    const { ctx } = proofAe({ afterItems: 5 });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(out.receipt.mismatches.some((m: any) => m.path === "num_items")).toBe(true);
  });

  it("rejects when the host refuses, with no render and no removal", async () => {
    const { ctx, calls } = proofAe({ failBegin: true });
    await expect(tool("ae_explain_layer_proof").handler(args(), ctx)).rejects.toThrow(/Nothing to toggle/);
    expect(calls).toEqual(["explainProofPlan", "checkGuard", "explainProofState", "explainProofBegin"]);
  });

  it("refuses an inapplicable suspect before the guard, a checkpoint or any write", async () => {
    const { ctx, calls } = proofAe({ failPlan: true });
    await expect(tool("ae_explain_layer_proof").handler(args(), ctx)).rejects.toThrow(/Nothing to toggle/);
    expect(calls).toEqual(["explainProofPlan"]);
  });

  it("keeps the cleanup failure in the receipt when the read-back also fails", async () => {
    const { ctx } = proofAe({ failRemove: true, failAfter: true });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(out.proof.copy_removed).toBe(false);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths).toContain("temp_comp");
    expect(paths).toContain("read_back");
  });

  it("does not count a missing copy id as a removal", async () => {
    const { ctx, calls } = proofAe({ noCopyId: true });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    expect(calls).not.toContain("explainProofEnd");
    expect(out.proof.copy_removed).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => m.path === "temp_comp")).toBe(true);
    expect(out.verdict).toBe("inconclusive");
  });

  it("limits layers_above and adjustment_above to the target's box", async () => {
    const boxArgs = (suspect: string) => AeExplainLayerProofSchema.parse({ comp_id: 1, layer: { name: "Logo" }, suspect, time: 1.5, expect: expectArg });
    // The frames differ only outside the box: not confirmed.
    let r = proofAe({ sameInsideBox: true, region: [0, 0, 4, 4] });
    let out = (await tool("ae_explain_layer_proof").handler(boxArgs("layers_above"), r.ctx)) as Record<string, any>;
    expect(out.verdict).toBe("not_confirmed");
    expect(out.proof.diff_scope).toBe("layer_box");
    expect(out.proof.diff.total_pixels).toBe(4);
    // The same frames judged on the whole frame (suspect enabled) differ.
    r = proofAe({ sameInsideBox: true, region: [0, 0, 4, 4] });
    out = (await tool("ae_explain_layer_proof").handler(args(), r.ctx)) as Record<string, any>;
    expect(out.verdict).toBe("confirmed");
    expect(out.proof.diff_scope).toBe("frame");
    // A 3D target has no box: inconclusive, and the copy is still removed.
    r = proofAe({ region: null });
    out = (await tool("ae_explain_layer_proof").handler(boxArgs("adjustment_above"), r.ctx)) as Record<string, any>;
    expect(out.verdict).toBe("inconclusive");
    expect(out.proof.copy_removed).toBe(true);
    expect(r.calls).toContain("explainProofEnd");
  });

  it("brings both renders to the same time when one was nudged", async () => {
    const { ctx, calls } = proofAe({ staleShot: 0, copyColour: [10, 20, 30, 255] });
    const out = (await tool("ae_explain_layer_proof").handler(args(), ctx)) as Record<string, any>;
    // original stale -> retried at +0.001; the copy is then re-rendered at that time.
    expect(calls.filter((c) => c === "snapshotFrame").length).toBe(4);
    expect(out.verdict).toBe("not_confirmed");
  }, 60000);
});

// ---------- explain.jsx under node:vm ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

/** A solid whose anchor is its centre, so it sits at the comp's centre by default. */
function solid(comp: FakeComp, name: string, w = 640, h = 360): FakeLayer {
  const l = comp.layers.addSolid([1, 1, 1], name, w, h, 1) as FakeLayer;
  l.transform("Anchor Point").setValue([w / 2, h / 2, 0]);
  return l;
}

function load(project: FakeProject, extra: Record<string, unknown> = {}) {
  const host = loadHost(project, ["explain.jsx"]);
  // AE's enum objects have no enumerable keys: the host code must not rely on for-in.
  const hidden = (o: Record<string, number>) => {
    const h = {};
    for (const k of Object.keys(o)) Object.defineProperty(h, k, { value: o[k], enumerable: false });
    return h;
  };
  host.G.BlendingMode = hidden({ NORMAL: 100, MULTIPLY: 101, STENCIL_ALPHA: 102, SILHOUETE_ALPHA: 103 });
  host.G.MaskMode = hidden(MaskMode);
  host.G.TrackMatteType = hidden(TrackMatteType);
  host.G.AutoOrientType = { NO_AUTO_ORIENT: 200, CAMERA_OR_POINT_OF_INTEREST: 201 };
  Object.assign(host.G, extra);
  return host;
}

const explain = (A: any, comp: FakeComp, layer: FakeLayer | null, over: Record<string, unknown> = {}) =>
  rankExplanation(plain(A.explainLayer({ comp_id: comp.id, layer: layer ? { id: layer.id } : undefined, time: 1, ...over })));

const idsOf = (r: { findings: ExplainFinding[] }) => r.findings.map((f) => f.id);
const sev = (r: { findings: ExplainFinding[] }, id: string) => r.findings.find((f) => f.id === id)?.severity;

describe("explain.jsx: ae_explain_layer", () => {
  it("finds nothing wrong with a plain visible layer", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("no_cause_found");
    expect(r.limits?.length).toBeGreaterThan(0);
    expect(r.facts).toMatchObject({ kind: "solid", enabled: true, opacity: 100 });
  });

  it("is read-only: no undo group, no time or state change", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    comp.time = 2.5;
    const { A, undo } = load(project);
    const r = A.explainLayer({ comp_id: comp.id, layer: { id: a.id } });
    expect(plain(r).time).toBe(2.5);
    expect(comp.time).toBe(2.5);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(1);
  });

  it("ranks the video switch, in/out points, solo and opacity as blockers", () => {
    const { project, comp } = scene();
    const other = solid(comp, "Other");
    const a = solid(comp, "A");
    a.enabled = false;
    a.inPoint = 2;
    a.outPoint = 3;
    (other as any).solo = true;
    a.transform("Opacity").setValue(0);
    const { A } = load(project);
    const r = explain(A, comp, a, { time: 1 });
    expect(idsOf(r)).toEqual(["disabled", "outside_in_out", "solo_elsewhere", "opacity_zero"]);
    expect(r.counts.blocks).toBe(4);
    expect(r.verdict).toBe("hidden");
    expect(r.findings[1].evidence).toMatchObject({ in_point: 2, out_point: 3 });
  });

  it("counts only the layer's own opacity: a parent at 0% is info, a parent at scale 0 blocks", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const p = solid(comp, "Parent");
    a.parent = p;
    p.transform("Opacity").setValue(0);
    const { A } = load(project);
    let r = explain(A, comp, a);
    expect(sev(r, "parent_opacity_not_inherited")).toBe("info");
    expect(idsOf(r)).not.toContain("opacity_zero");
    expect(r.verdict).toBe("no_cause_found");
    p.transform("Scale").setValue([0, 100, 100]);
    r = explain(A, comp, a);
    expect(sev(r, "scale_zero")).toBe("blocks");
    expect(r.findings.find((f) => f.id === "scale_zero")!.title).toContain("parent");
  });

  it("reports shy as info only", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    (a as any).shy = true;
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(sev(r, "shy")).toBe("info");
    expect(r.verdict).toBe("no_cause_found");
  });

  it("says a null, a guide layer and an audio-only layer cannot show", () => {
    const { project, comp } = scene();
    const n = comp.layers.addNull() as FakeLayer;
    const g = solid(comp, "Guide");
    g.guideLayer = true;
    const au = solid(comp, "Audio");
    au.hasVideo = false;
    const { A } = load(project);
    expect(sev(explain(A, comp, n), "null_layer")).toBe("blocks");
    expect(sev(explain(A, comp, g), "guide_layer")).toBe("likely");
    expect(sev(explain(A, comp, au), "audio_only")).toBe("blocks");
  });

  it("reads masks: empty hides, inverted is a possible cause", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const masks = a.property("ADBE Mask Parade") as FakeGroup;
    const mk = masks.addProperty("ADBE Mask Atom") as any;
    const { A } = load(project);
    expect(sev(explain(A, comp, a), "mask_empty")).toBe("blocks");
    const shape = (mk.property("ADBE Mask Shape") as FakeProperty).staticValue as any;
    shape.vertices = [[0, 0], [10, 0], [10, 10]];
    mk.inverted = true;
    let r = explain(A, comp, a);
    expect(idsOf(r)).toEqual(["mask_inverted"]);
    mk.inverted = false;
    (mk.property("ADBE Mask Opacity") as FakeProperty).setValue(0);
    r = explain(A, comp, a);
    expect(sev(r, "mask_opacity_zero")).toBe("likely");
    mk.maskMode = 6812; // None
    expect(explain(A, comp, a).findings).toEqual([]);
  });

  it("an empty alpha matte hides the layer; an inverted one does not", () => {
    const { project, comp } = scene();
    const m = solid(comp, "Matte");
    const a = solid(comp, "A");
    a.setTrackMatte!(m, TrackMatteType.ALPHA);
    m.transform("Opacity").setValue(0);
    const { A } = load(project);
    let r = explain(A, comp, a);
    expect(sev(r, "matte_empty")).toBe("blocks");
    a.setTrackMatte!(m, TrackMatteType.ALPHA_INVERTED);
    r = explain(A, comp, a);
    expect(idsOf(r)).toEqual(["track_matte"]);
    m.transform("Opacity").setValue(100);
    a.setTrackMatte!(m, TrackMatteType.ALPHA);
    m.inPoint = 3;
    expect(sev(explain(A, comp, a, { time: 1 }), "matte_empty")).toBe("blocks");
    // The matte layer itself says it is one.
    expect(sev(explain(A, comp, m), "is_track_matte")).toBe("info");
  });

  it("reports blend modes, a stencil above, and an adjustment layer above", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    (a as any).blendingMode = 101;
    const stencil = solid(comp, "Stencil");
    (stencil as any).blendingMode = 102;
    const adj = solid(comp, "Adj");
    adj.adjustmentLayer = true;
    (adj.property("ADBE Effect Parade") as FakeGroup).props.push(new FakeGroup("Blur", "ADBE Gaussian Blur 2", []));
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(sev(r, "blend_mode")).toBe("possible");
    expect(sev(r, "stencil_above")).toBe("possible");
    expect(sev(r, "adjustment_above")).toBe("possible");
    expect((r.facts as any).blend_mode).toBe("MULTIPLY");
    (a as any).blendingMode = 102;
    expect(sev(explain(A, comp, a), "blend_stencil")).toBe("likely");
  });

  it("reads effect switches and expression errors without moving time", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const fx = new FakeGroup("Blur", "ADBE Gaussian Blur 2", []) as any;
    fx.enabled = false;
    (a.property("ADBE Effect Parade") as FakeGroup).props.push(fx);
    const pos = a.transform("Position") as any;
    pos.expression = "thisProperty.bad(";
    pos.expressionEnabled = true;
    pos.expressionError = "Error: bad";
    const { A, undo } = load(project);
    const r = explain(A, comp, a);
    expect(sev(r, "effect_disabled")).toBe("possible");
    const e = r.findings.find((f) => f.id === "expression_error")!;
    expect(e.severity).toBe("likely");
    expect((e.evidence as any).errors[0]).toMatchObject({ path: "Transform > Position", error: "Error: bad" });
    expect(undo.begun).toBe(0);
  });

  it("flags missing footage and a placeholder", () => {
    const { project, comp } = scene();
    const clip = project.addFootage("clip.mov", 640, 360) as FakeFootage;
    clip.footageMissing = true;
    const a = comp.layers.add(clip) as FakeLayer;
    a.transform("Anchor Point").setValue([320, 180, 0]);
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(sev(r, "footage_missing")).toBe("likely");
    expect((r.findings[0].evidence as any).placeholder).toBe(false);
  });

  it("flags time remapping past the end of the source", () => {
    const { project, comp } = scene();
    const clip = project.addFootage("clip.mov", 640, 360) as FakeFootage;
    clip.duration = 5;
    const a = comp.layers.add(clip) as FakeLayer;
    a.transform("Anchor Point").setValue([320, 180, 0]);
    (a as any).timeRemapEnabled = true;
    a.group.props.push(new FakeProperty("Time Remap", "ADBE Time Remapping", PropertyValueType.OneD, 9));
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(sev(r, "time_remap_out_of_range")).toBe("likely");
    (a.group.property("ADBE Time Remapping") as FakeProperty).setValue(2);
    expect(idsOf(explain(A, comp, a))).not.toContain("time_remap_out_of_range");
  });

  it("finds a layer entirely off the canvas, and one with no extent", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A", 100, 100);
    a.transform("Position").setValue([2000, 180, 0]);
    const { A } = load(project);
    let r = explain(A, comp, a);
    expect(sev(r, "off_canvas")).toBe("blocks");
    a.transform("Position").setValue([320, 180, 0]);
    expect(explain(A, comp, a).findings).toEqual([]);
    a.rect = { left: 0, top: 0, width: 0, height: 0 };
    r = explain(A, comp, a);
    expect(sev(r, "no_extent")).toBe("likely");
  });

  it("guesses a plain opaque solid above covers the layer, and not a translucent one", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A", 200, 100);
    const cover = solid(comp, "Cover");
    const { A } = load(project);
    let r = explain(A, comp, a);
    expect(sev(r, "covered_guess")).toBe("possible");
    cover.transform("Opacity").setValue(50);
    r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("covered_guess");
  });

  it("works out 'behind the camera' for a two-node camera, and says when it can't", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    a.threeDLayer = true;
    a.transform("Position").setValue([320, 180, -500]);
    const cam = comp.layers.addCamera("Cam") as FakeLayer;
    cam.threeDLayer = true;
    (cam as any).autoOrient = 201;
    const tr = cam.group.property("ADBE Transform Group") as FakeGroup;
    cam.transform("Position").setValue([320, 180, -1000]);
    tr.props.push(new FakeProperty("Point of Interest", "ADBE Point of Interest", PropertyValueType.ThreeD_SPATIAL, [320, 180, 0], true));
    (comp as any).activeCamera = cam;
    const { A } = load(project);
    let r = explain(A, comp, a);
    // The camera at z=-1000 looks towards +z; the layer at z=-500 is in front.
    expect(idsOf(r)).not.toContain("behind_camera");
    expect((r.facts as any).camera.depth).toBe(500);
    a.transform("Position").setValue([320, 180, -1500]);
    r = explain(A, comp, a);
    expect(sev(r, "behind_camera")).toBe("likely");
    // A rotated one-node camera is not worked out.
    (cam as any).autoOrient = 200;
    cam.group.props.push(new FakeProperty("Orientation", "ADBE Orientation", PropertyValueType.ThreeD, [0, 90, 0]));
    tr.props.push(new FakeProperty("Orientation", "ADBE Orientation", PropertyValueType.ThreeD, [0, 90, 0]));
    r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("behind_camera");
    expect(r.unchecked?.join(" ")).toContain("view direction is not worked out");
  });

  it("does not depend on enumerating AE's enum objects", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const { A, G } = load(project);
    expect(Object.keys(G.BlendingMode as object)).toEqual([]);
    expect(Object.keys(G.MaskMode as object)).toEqual([]);
    expect(Object.keys(G.TrackMatteType as object)).toEqual([]);
    (a as any).blendingMode = 100;
    const r = explain(A, comp, a);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("no_cause_found");
    expect((r.facts as any).blend_mode).toBe("NORMAL");
    // A plain opaque solid above still counts as covering the layer.
    const small = solid(comp, "Small", 100, 50);
    const cover = solid(comp, "Cover");
    (cover as any).blendingMode = 100;
    expect(sev(explain(A, comp, small), "covered_guess")).toBe("possible");
    // A stencil above and the layer's own stencil mode are found.
    (cover as any).blendingMode = 102;
    const above = explain(A, comp, small);
    expect(sev(above, "stencil_above")).toBe("possible");
    expect(idsOf(above)).not.toContain("covered_guess");
    (small as any).blendingMode = 103;
    expect((explain(A, comp, small).facts as any).blend_mode).toBe("SILHOUETE_ALPHA");
    expect(sev(explain(A, comp, small), "blend_stencil")).toBe("likely");
  });

  it("an inverted matte over an empty matte layer is not 'matte_empty'", () => {
    const { project, comp } = scene();
    const m = solid(comp, "Matte");
    const a = solid(comp, "A");
    a.setTrackMatte!(m, TrackMatteType.LUMA_INVERTED);
    m.transform("Opacity").setValue(0);
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("matte_empty");
    expect((r.facts as any).track_matte.type).toBe("LUMA_INVERTED");
  });

  it("a first Subtract mask with no area is not 'mask_empty'", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const mk = (a.property("ADBE Mask Parade") as FakeGroup).addProperty("ADBE Mask Atom") as any;
    mk.maskMode = MaskMode.SUBTRACT;
    const { A } = load(project);
    const r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("mask_empty");
    expect((r.facts as any).masks[0].mode).toBe("SUBTRACT");
  });

  it("does not work out 'behind the camera' for a parented camera or a turned two-node camera", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    a.threeDLayer = true;
    a.transform("Position").setValue([320, 180, -1500]);
    const rig = comp.layers.addNull() as FakeLayer;
    const cam = comp.layers.addCamera("Cam") as FakeLayer;
    cam.threeDLayer = true;
    (cam as any).autoOrient = 201;
    const tr = cam.group.property("ADBE Transform Group") as FakeGroup;
    cam.transform("Position").setValue([320, 180, -1000]);
    tr.props.push(new FakeProperty("Point of Interest", "ADBE Point of Interest", PropertyValueType.ThreeD_SPATIAL, [320, 180, 0], true));
    (comp as any).activeCamera = cam;
    const { A } = load(project);
    expect(sev(explain(A, comp, a), "behind_camera")).toBe("likely");
    cam.parent = rig;
    let r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("behind_camera");
    expect(r.unchecked?.join(" ")).toContain("camera has a parent");
    cam.parent = null;
    tr.props.push(new FakeProperty("Y Rotation", "ADBE Rotate Y", PropertyValueType.OneD, 30));
    r = explain(A, comp, a);
    expect(idsOf(r)).not.toContain("behind_camera");
    expect(r.unchecked?.join(" ")).toContain("orientation or rotation");
  });

  it("looks inside a precomp: empty, nothing active, a time outside, and missing footage", () => {
    const { project, comp } = scene();
    const inner = project.addComp("Inner", 640, 360, 2);
    const pl = comp.layers.add(inner) as FakeLayer;
    pl.transform("Anchor Point").setValue([320, 180, 0]);
    const { A } = load(project);
    expect(sev(explain(A, comp, pl), "precomp_empty")).toBe("likely");
    const il = solid(inner, "Inside");
    il.enabled = false;
    let r = explain(A, comp, pl);
    expect(sev(r, "precomp_nothing_active")).toBe("likely");
    expect((r.inside as any).summary[0]).toMatchObject({ name: "Inside", renders: false, reasons: ["video switch off"] });
    il.enabled = true;
    expect(idsOf(explain(A, comp, pl))).toEqual([]);
    expect((explain(A, comp, pl).inside as any).active_layers).toBe(1);
    expect(sev(explain(A, comp, pl, { time: 3 }), "precomp_time_outside")).toBe("likely");
    expect(explain(A, comp, pl, { inside: false }).inside).toBeUndefined();
    const clip = project.addFootage("clip.mov", 10, 10) as FakeFootage;
    clip.footageMissing = true;
    inner.layers.add(clip);
    r = explain(A, comp, pl);
    expect(sev(r, "precomp_missing_footage")).toBe("possible");
  });

  it("lists the layers under a pixel and the first that renders", () => {
    const { project, comp } = scene();
    solid(comp, "BG");
    const off = solid(comp, "Hidden", 100, 100);
    off.enabled = false;
    const { A } = load(project);
    const r = explain(A, comp, null, { point: [320, 180] });
    expect(r.verdict).toBe("point_only");
    const at = r.at_point!;
    expect(at.candidates!.map((c) => [c.name, c.renders])).toEqual([["Hidden", false], ["BG", true]]);
    expect(at.topmost_rendering).toBe(2);
    expect(r.headline).toContain("BG");
    const withLayer = explain(A, comp, off, { point: [600, 50] });
    expect(withLayer.at_point!.layer_covers_point).toBe(false);
    expect(idsOf(withLayer)).toContain("point_outside_layer");
  });

  it("refuses bad arguments", () => {
    const { project, comp } = scene();
    solid(comp, "A");
    const { A } = load(project);
    expect(() => A.explainLayer({ comp_id: comp.id })).toThrow(/layer, a point/);
    expect(() => A.explainLayer({ comp_id: comp.id, layer: { index: 1 }, time: NaN })).toThrow(/finite/);
    expect(() => A.explainLayer({ comp_id: comp.id, layer: { index: 1 }, point: [1] })).toThrow(/\[x, y\]/);
    expect(() => A.explainLayer({ comp_id: 999, layer: { index: 1 } })).toThrow(/No CompItem/);
    expect(() => A.explainLayer({ comp_id: comp.id, layer: { index: 5 } })).toThrow(/out of range/);
  });
});

// ---------- the proof's host functions ----------

/** comp.duplicate for the fake DOM: a copy with the same layers and static values. */
function withDuplicate(project: FakeProject, comp: FakeComp) {
  (comp as any).duplicate = () => {
    const copy = project.addComp(`${comp.name} 2`, comp.width, comp.height, comp.duration);
    copy.modernMattes = comp.modernMattes;
    const bottomUp = [...comp.stack].reverse();
    const made = new Map<FakeLayer, FakeLayer>();
    for (const l of bottomUp) {
      const c = new FakeLayer(copy, l.name, l.reflect.name);
      made.set(l, c);
      (c as any).blendingMode = (l as any).blendingMode;
      c.threeDLayer = l.threeDLayer;
      c.guideLayer = l.guideLayer;
      c.source = l.source;
      const srcMasks = l.property("ADBE Mask Parade") as FakeGroup;
      for (const m of srcMasks.props as any[]) {
        const nm = (c.property("ADBE Mask Parade") as FakeGroup).addProperty("ADBE Mask Atom") as any;
        nm.maskMode = m.maskMode;
        nm.inverted = m.inverted;
      }
      c.enabled = l.enabled;
      c.inPoint = l.inPoint;
      c.outPoint = l.outPoint;
      c.rect = { ...l.rect };
      (c as any).solo = (l as any).solo;
      c.adjustmentLayer = l.adjustmentLayer;
      c.transform("Opacity").setValue(l.transform("Opacity").value);
      copy.stack.unshift(c);
    }
    for (const l of comp.stack) {
      const c = made.get(l)!;
      c.trackMatteType = l.trackMatteType;
      c.trackMatteLayer = l.trackMatteLayer ? made.get(l.trackMatteLayer) ?? null : null;
    }
    return copy;
  };
}

describe("explain.jsx: the pixel proof", () => {
  it("duplicates the comp, undoes the suspect in the copy only, and removes the copy", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const a = solid(comp, "A");
    a.enabled = false;
    const { A, undo } = load(project);
    const before = plain(A.explainProofState());
    const began = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", time: 1, expect: GUARD }));
    expect(began).toMatchObject({ suspect: "enabled", layer_index: 1, layers_changed: 1, time: 1, original_id: comp.id });
    expect(began.copy_name).toBe("chroma-explain-proof Main");
    const copy = project.itemByID(began.copy_id) as FakeComp;
    expect(copy.layer(1)!.enabled).toBe(true);
    expect(a.enabled).toBe(false); // the original is untouched
    expect(plain(A.explainProofState()).proof_comps).toBe(1);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);

    const ended = plain(A.explainProofEnd({ copy_id: began.copy_id, expect: GUARD }));
    expect(ended).toMatchObject({ removed: true });
    expect(plain(A.explainProofState())).toEqual(before);
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
    expect(plain(A.explainProofEnd({ copy_id: began.copy_id, expect: GUARD })).already_gone).toBe(true);
  });

  it("toggles each kind of suspect in the copy", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const bottom = solid(comp, "Bottom");
    const mid = solid(comp, "Mid");
    mid.adjustmentLayer = true;
    const top = solid(comp, "Top");
    const { A } = load(project);
    const itemsAtStart = project.numItems;
    const run = (suspect: string, layer: FakeLayer) => {
      const r = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: layer.id }, suspect, expect: GUARD }));
      const copy = project.itemByID(r.copy_id) as FakeComp;
      return { r, copy };
    };
    let x = run("layers_above", bottom);
    expect(x.r.layers_changed).toBe(2);
    expect(x.copy.stack.map((l) => l.enabled)).toEqual([false, false, true]);
    expect(comp.stack.every((l) => l.enabled)).toBe(true);
    A.explainProofEnd({ copy_id: x.r.copy_id, expect: GUARD });
    x = run("adjustment_above", bottom);
    expect(x.r.layers_changed).toBe(1);
    expect(x.copy.stack.map((l) => l.enabled)).toEqual([true, false, true]);
    A.explainProofEnd({ copy_id: x.r.copy_id, expect: GUARD });
    top.transform("Opacity").setValue(0);
    x = run("opacity", top);
    expect(x.copy.layer(1)!.transform("Opacity").value).toBe(100);
    expect(top.transform("Opacity").value).toBe(0);
    A.explainProofEnd({ copy_id: x.r.copy_id, expect: GUARD });
    expect(plain(A.explainProofState())).toEqual({ num_items: itemsAtStart, comps: 1, proof_comps: 0 });
  });

  it("solo: solos only the target in the copy and leaves the other layers' solo", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const target = solid(comp, "Target");
    const other = solid(comp, "Other");
    (other as any).solo = true;
    const { A } = load(project);
    const r = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: target.id }, suspect: "solo", expect: GUARD }));
    const copy = project.itemByID(r.copy_id) as FakeComp;
    expect(r.layers_changed).toBe(1);
    expect(copy.layer(1)!.name).toBe("Other");
    expect((copy.layer(1) as any).solo).toBe(true);
    expect((copy.layer(2) as any).solo).toBe(true);
    expect((target as any).solo).toBeFalsy();
  });

  it("layers_above: leaves cameras, lights and track mattes alone", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const target = solid(comp, "Target");
    const matte = solid(comp, "Matte");
    const cam = comp.layers.addCamera("Cam") as FakeLayer;
    const light = comp.layers.addLight("Light") as FakeLayer;
    const plainTop = solid(comp, "Plain");
    const user = solid(comp, "User");
    user.setTrackMatte!(matte, TrackMatteType.ALPHA);
    const { A } = load(project);
    const r = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: target.id }, suspect: "layers_above", expect: GUARD }));
    const copy = project.itemByID(r.copy_id) as FakeComp;
    const state = Object.fromEntries(copy.stack.map((l) => [l.name, l.enabled]));
    expect(state).toEqual({ User: false, Plain: false, Light: true, Cam: true, Matte: true, Target: true });
    expect(r.layers_changed).toBe(2);
    expect([cam, light, matte, plainTop].every((l) => l.enabled)).toBe(true);
  });

  it("layers_above: refuses when only cameras, lights and mattes are above", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const target = solid(comp, "Target");
    comp.layers.addCamera("Cam");
    const { A } = load(project);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: target.id }, suspect: "layers_above", expect: GUARD })).toThrow(/no enabled layer above that draws/);
  });

  it("track_matte: removes the matte in the copy (modern AE, and the type fallback)", () => {
    for (const modern of [true, false]) {
      const { project, comp } = scene();
      comp.modernMattes = modern;
      withDuplicate(project, comp);
      const m = solid(comp, "Matte");
      const a = solid(comp, "A");
      if (modern) a.setTrackMatte!(m, TrackMatteType.ALPHA);
      else a.trackMatteType = TrackMatteType.ALPHA;
      const { A } = load(project);
      const r = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "track_matte", expect: GUARD }));
      const copy = project.itemByID(r.copy_id) as FakeComp;
      expect(copy.layer(1)!.trackMatteType).toBe(TrackMatteType.NO_TRACK_MATTE);
      expect(a.trackMatteType).toBe(TrackMatteType.ALPHA);
      expect(typeof copy.layer(1)!.removeTrackMatte).toBe(modern ? "function" : "undefined");
    }
  });

  it("masks: sets every active mask to None in the copy only", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const a = solid(comp, "A");
    const masks = a.property("ADBE Mask Parade") as FakeGroup;
    const m1 = masks.addProperty("ADBE Mask Atom") as any;
    const m2 = masks.addProperty("ADBE Mask Atom") as any;
    m2.maskMode = MaskMode.NONE;
    const { A } = load(project);
    const r = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "masks", expect: GUARD }));
    const copy = project.itemByID(r.copy_id) as FakeComp;
    const cm = (copy.layer(1)!.property("ADBE Mask Parade") as FakeGroup).props as any[];
    expect(r.layers_changed).toBe(1);
    expect(cm.map((x) => x.maskMode)).toEqual([MaskMode.NONE, MaskMode.NONE]);
    expect(m1.maskMode).toBe(MaskMode.ADD);
  });

  it("returns the target's box for a 2D layer, and null for a 3D one", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const a = solid(comp, "A", 200, 100);
    a.enabled = false;
    const { A } = load(project);
    const r2 = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", expect: GUARD }));
    expect(r2.comp_size).toEqual([640, 360]);
    expect(r2.region).toEqual([220, 130, 420, 230]);
    A.explainProofEnd({ copy_id: r2.copy_id, expect: GUARD });
    a.threeDLayer = true;
    const r3 = plain(A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", expect: GUARD }));
    expect(r3.region).toBeNull();
  });

  it("explainProofPlan refuses without touching the project", () => {
    const { project, comp } = scene();
    const a = solid(comp, "A");
    const { A, undo } = load(project);
    const items = project.numItems;
    expect(() => A.explainProofPlan({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled" })).toThrow(/already on/);
    a.enabled = false;
    expect(plain(A.explainProofPlan({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled" })).applies).toBe(true);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
  });

  it("refuses before duplicating when the suspect does not apply or the guard fails", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const a = solid(comp, "A");
    const { A, undo } = load(project);
    const items = project.numItems;
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", expect: GUARD })).toThrow(/already on/);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "solo", expect: GUARD })).toThrow(/no other layer is soloed/);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "masks", expect: GUARD })).toThrow(/no active masks/);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "nope", expect: GUARD })).toThrow(/Unknown suspect/);
    a.transform("Opacity").setValueAtTime(0, 0);
    a.transform("Opacity").setValueAtTime(2, 0);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "opacity", expect: GUARD })).toThrow(/animated/);
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
  });

  it("removes a half-made copy when the toggle fails", () => {
    const { project, comp } = scene();
    withDuplicate(project, comp);
    const a = solid(comp, "A");
    a.enabled = false;
    // A duplicate whose layers come back in another order.
    const dup = (comp as any).duplicate;
    (comp as any).duplicate = () => {
      const c = dup();
      c.layer(1)!.name = "Other";
      return c;
    };
    const { A, undo } = load(project);
    const items = project.numItems;
    expect(() => A.explainProofBegin({ comp_id: comp.id, layer: { id: a.id }, suspect: "enabled", expect: GUARD })).toThrow(/is not "A"/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(undo.ended);
  });

  it("only ever removes a proof copy", () => {
    const { project, comp } = scene();
    const { A, undo } = load(project);
    expect(() => A.explainProofEnd({ copy_id: comp.id, expect: GUARD })).toThrow(/not an explain proof copy/);
    expect(project.itemByID(comp.id)).toBe(comp);
    expect(undo.begun).toBe(0);
    expect(() => A.explainProofEnd({ copy_id: comp.id, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
  });
});
