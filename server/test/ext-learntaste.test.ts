import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskStore } from "../src/asks.js";
import { SingleWriterQueue } from "../src/queue.js";
import { buildJsxCall } from "../src/jsx.js";
import { SettingsStore, sanitizeTasteRules } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { getSessionTracker, installSessionBridgeHook, installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import {
  AeLearnTasteSchema,
  askOptionOf,
  AeTasteBaselineSchema,
  AeTasteRulesSchema,
  baselineKey,
  buildRules,
  collectSeries,
  confidenceOf,
  diffTasteSnapshots,
  emptyLedger,
  hasOvershoot,
  learntasteTools,
  loadLedger,
  marginShare,
  median,
  recordEvidence,
  samplesFromObservations,
  type SnapKey,
  type SnapLayer,
  type SnapProp,
  type TasteSnapshot,
} from "../src/tools/ext/learntaste.js";
import { FakeProject, FakeProperty, GUARD, KeyframeEase, KeyframeInterpolationType, PropertyValueType, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-learntaste-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => learntasteTools.find((t) => t.name === name)!;

// ---------- snapshot builders for the pure logic ----------

const key = (t: number, v: number | number[], inI = 33, outI = 33, type = "bezier"): SnapKey => ({
  t,
  v,
  inE: [{ s: 0, i: inI }],
  outE: [{ s: 0, i: outI }],
  inT: type,
  outT: type,
});
const prop = (kind: string, keys: SnapKey[], value: SnapProp["value"] = null): SnapProp => ({ kind, value, keys });
const layer = (id: number, name: string, extra: Partial<SnapLayer> = {}): SnapLayer => ({
  id,
  index: id,
  name,
  kind: "text",
  inPoint: 0,
  outPoint: 4,
  startTime: 0,
  props: {},
  text: { fontSize: 72, fillColor: [1, 1, 1], text: name },
  ...extra,
});
const snap = (layers: SnapLayer[], extra: Partial<TasteSnapshot> = {}): TasteSnapshot => ({
  project_path: "C:/jobs/a.aep",
  revision: 10,
  comp_id: 1,
  name: "Main",
  width: 1000,
  height: 500,
  fps: 25,
  duration: 10,
  numLayers: layers.length,
  truncated: false,
  layers,
  ...extra,
});

describe("schemas", () => {
  it("take a comp id and optional layer selectors", () => {
    expect(AeTasteBaselineSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeTasteBaselineSchema.safeParse({ comp_id: 1, layers: [{ name: "Title" }, { id: 4 }] }).success).toBe(true);
    expect(AeTasteBaselineSchema.safeParse({ comp_id: 1, layers: [{}] }).success).toBe(false);
    expect(AeTasteBaselineSchema.safeParse({ comp_id: 1.5 }).success).toBe(false);
    expect(AeLearnTasteSchema.safeParse({ comp_id: 1, max_observations: 0 }).success).toBe(false);
    expect(AeLearnTasteSchema.safeParse({ comp_id: 1, record: false, max_observations: 500 }).success).toBe(true);
  });

  it("ae_taste_rules needs rule ids to save or forget, and the user's yes to save", () => {
    expect(AeTasteRulesSchema.safeParse({ action: "list" }).success).toBe(true);
    expect(AeTasteRulesSchema.safeParse({ action: "save", confirmed_in_chat: true }).success).toBe(false);
    expect(AeTasteRulesSchema.safeParse({ action: "save", rule_ids: ["ease_influence"] }).success).toBe(false);
    expect(AeTasteRulesSchema.safeParse({ action: "save", rule_ids: ["ease_influence"], confirmed_in_chat: false }).success).toBe(false);
    expect(AeTasteRulesSchema.safeParse({ action: "save", rule_ids: ["ease_influence"], ask_id: "ask_1" }).success).toBe(true);
    expect(AeTasteRulesSchema.safeParse({ action: "save", rule_ids: ["ease_influence"], confirmed_in_chat: true }).success).toBe(true);
    expect(AeTasteRulesSchema.safeParse({ action: "forget", rule_ids: ["overshoot"] }).success).toBe(true);
    expect(AeTasteRulesSchema.safeParse({ action: "forget" }).success).toBe(false);
  });

  it("every tool has a description that says it leaves the AE project alone", () => {
    expect(learntasteTools.map((t) => t.name)).toEqual(["ae_taste_baseline", "ae_learn_taste", "ae_taste_rules"]);
    for (const t of learntasteTools) {
      expect(t.description.length).toBeGreaterThan(80);
      expect(/without changing anything|Never touches the AE project/.test(t.description)).toBe(true);
    }
  });
});

describe("pure helpers", () => {
  it("median, margin and confidence", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(marginShare([100, 250], 1000, 500)).toBeCloseTo(0.2);
    expect(marginShare([-5, 250], 1000, 500)).toBeNull();
    expect(confidenceOf(1, 1, 5)).toBe("low");
    expect(confidenceOf(5, 0.5, 5)).toBe("low");
    expect(confidenceOf(3, 0.7, 1)).toBe("medium");
    expect(confidenceOf(8, 0.9, 1)).toBe("medium");
    expect(confidenceOf(8, 0.9, 2)).toBe("high");
  });

  it("finds an overshoot past the last value, in either direction", () => {
    expect(hasOvershoot([key(0, 0), key(0.4, 120), key(0.8, 100)])).toBe(true);
    expect(hasOvershoot([key(0, 100), key(0.4, -20), key(0.8, 0)])).toBe(true);
    expect(hasOvershoot([key(0, 0), key(0.4, 60), key(0.8, 100)])).toBe(false);
    expect(hasOvershoot([key(0, 0), key(0.8, 100)])).toBe(false);
    expect(hasOvershoot([key(0, [0, 0]), key(0.4, [50, 130]), key(0.8, [100, 100])])).toBe(true);
  });
});

describe("diffTasteSnapshots", () => {
  const pos = (keys: SnapKey[]) => ({ position: prop("position", keys) });

  it("reports nothing when nothing changed", () => {
    const l = layer(1, "T", { props: pos([key(0, [100, 100]), key(1, [500, 250])]) });
    const d = diffTasteSnapshots(snap([l]), snap([JSON.parse(JSON.stringify(l))]));
    expect(d.observations).toEqual([]);
    expect(d.compared_layers).toBe(1);
  });

  it("classifies ease influence changes per side and skips non-bezier keys", () => {
    const before = layer(1, "T", { props: pos([key(0, [0, 0], 33, 33), key(1, [100, 0], 33, 33)]) });
    const after = layer(1, "T", { props: pos([key(0, [0, 0], 33, 75), key(1, [100, 0], 80, 33)]) });
    const d = diffTasteSnapshots(snap([before]), snap([after]));
    expect(d.counts).toEqual({ ease_out_influence: 1, ease_in_influence: 1 });
    expect(d.observations[0]).toMatchObject({ kind: "ease_out_influence", before: 33, after: 75, prop: "position" });

    const linearKeys = layer(1, "T", { props: pos([key(0, [0, 0], 16, 16, "linear"), key(1, [100, 0], 16, 16, "linear")]) });
    const changedLinear = layer(1, "T", { props: pos([key(0, [0, 0], 16, 90, "linear"), key(1, [100, 0], 90, 16, "linear")]) });
    expect(diffTasteSnapshots(snap([linearKeys]), snap([changedLinear])).observations).toEqual([]);

    const toLinear = layer(1, "T", { props: pos([key(0, [0, 0], 16, 16, "linear"), key(1, [100, 0], 16, 16, "linear")]) });
    expect(diffTasteSnapshots(snap([before]), snap([toLinear])).counts).toEqual({ interp_changed: 2 });
  });

  it("measures layer length, start offset, animation span and keys", () => {
    const before = layer(1, "T", { outPoint: 5, props: pos([key(0, [0, 0]), key(1, [100, 0])]) });
    const after = layer(1, "T", { inPoint: 0.5, outPoint: 4, props: pos([key(0, [0, 0]), key(0.8, [100, 0])]) });
    const d = diffTasteSnapshots(snap([before]), snap([after]));
    const byKind = Object.fromEntries(d.observations.map((o) => [o.kind, o]));
    expect(byKind.layer_duration).toMatchObject({ before: 5, after: 3.5, ratio: 0.7 });
    expect(byKind.start_offset).toMatchObject({ before: 0, after: 0.5 });
    expect(byKind.animation_timing).toMatchObject({ before: 1, after: 0.8, ratio: 0.8 });
    expect(byKind.animation_offset).toBeUndefined();

    const moved = layer(1, "T", { props: pos([key(0.5, [0, 0]), key(1.5, [100, 0])]) });
    const base = layer(1, "T", { props: pos([key(0, [0, 0]), key(1, [100, 0])]) });
    expect(diffTasteSnapshots(snap([base]), snap([moved])).counts).toEqual({ animation_offset: 1 });

    const extra = layer(1, "T", { props: pos([key(0, [0, 0]), key(0.5, [50, 0]), key(1, [100, 0])]) });
    expect(diffTasteSnapshots(snap([base]), snap([extra])).counts).toEqual({ keys_added: 1 });
  });

  it("ignores changes under half a frame", () => {
    const before = layer(1, "T", { outPoint: 5 });
    const after = layer(1, "T", { outPoint: 5.015 });
    expect(diffTasteSnapshots(snap([before]), snap([after])).observations).toEqual([]);
  });

  it("sees overshoot removed and added", () => {
    const bouncy = layer(1, "T", { props: pos([key(0, [0, 0]), key(0.4, [130, 0]), key(0.8, [100, 0])]) });
    const plain = layer(1, "T", { props: pos([key(0, [0, 0]), key(0.4, [60, 0]), key(0.8, [100, 0])]) });
    expect(diffTasteSnapshots(snap([bouncy]), snap([plain])).counts.overshoot_removed).toBe(1);
    expect(diffTasteSnapshots(snap([plain]), snap([bouncy])).counts.overshoot_added).toBe(1);
  });

  it("sees a title pulled in from the edge from its resting position", () => {
    const before = layer(1, "T", { props: { position: prop("position", [], [50, 250]) } });
    const after = layer(1, "T", { props: { position: prop("position", [], [150, 250]) } });
    const d = diffTasteSnapshots(snap([before]), snap([after]));
    const margin = d.observations.find((o) => o.kind === "edge_margin");
    expect(margin).toMatchObject({ before: 0.1, after: 0.3 });
    expect(d.observations.find((o) => o.kind === "position_nudge")).toBeDefined();
    // A non-text layer's move is a nudge, not a margin.
    const shape = (x: number) => layer(2, "S", { kind: "shape", text: null, props: { position: prop("position", [], [x, 250]) } });
    expect(diffTasteSnapshots(snap([shape(50)]), snap([shape(150)])).counts).toEqual({ position_nudge: 1 });
  });

  it("sees font size and fill colour, and skips static values moved by an expression", () => {
    const before = layer(1, "T", { text: { fontSize: 72, fillColor: [1, 1, 1], text: "T" } });
    const after = layer(1, "T", { text: { fontSize: 60, fillColor: [1, 0.5, 0], text: "T" } });
    const d = diffTasteSnapshots(snap([before]), snap([after]));
    expect(d.observations.find((o) => o.kind === "font_size")).toMatchObject({ ratio: 0.833 });
    expect(d.observations.find((o) => o.kind === "fill_color")?.detail).toBe("fill colour #ffffff -> #ff8000");

    const e1 = layer(1, "T", { props: { opacity: { kind: "opacity", value: 100, keys: [], expr: true } } });
    const e2 = layer(1, "T", { props: { opacity: { kind: "opacity", value: 50, keys: [], expr: true } } });
    expect(diffTasteSnapshots(snap([e1]), snap([e2])).observations).toEqual([]);
  });

  it("reports deleted layers (unless the live read was capped) and added ones only for an untracked baseline", () => {
    const a = layer(1, "A");
    const b = layer(2, "B");
    const c = layer(3, "C");
    const d = diffTasteSnapshots(snap([a, b]), snap([a, c]));
    expect(d.counts).toEqual({ layer_removed: 1, layer_added: 1 });
    expect(diffTasteSnapshots(snap([a, b]), snap([a, c], { truncated: true })).counts).toEqual({});
    // Tracked: only layer 1 is compared, so B's deletion and C's arrival are not the baseline's business.
    expect(diffTasteSnapshots(snap([a]), snap([a, c]), [1]).counts).toEqual({});
    expect(diffTasteSnapshots(snap([a, b]), snap([a]), [1, 2]).counts).toEqual({ layer_removed: 1 });
  });
});

describe("rules and confidence", () => {
  it("builds an ease rule with a curve only when both sides were edited", () => {
    const outOnly = buildRules({ ease_out: [[33, 75], [33, 70], [33, 80]] }, { ease_out: 1 });
    expect(outOnly).toHaveLength(1);
    expect(outOnly[0]).toMatchObject({ id: "ease_influence", value: 75, samples: 3, confidence: "medium" });

    const both = buildRules(
      { ease_out: [[33, 75], [33, 75], [33, 75]], ease_in: [[33, 20], [33, 20], [33, 20]] },
      { ease_out: 1, ease_in: 1 }
    );
    expect(both[0].value).toEqual([0.75, 0, 0.8, 1]);
  });

  it("clamps the curve inside what AE and the settings store accept", () => {
    const r = buildRules({ ease_out: [[33, 100], [33, 100]], ease_in: [[33, 100], [33, 100]] }, {});
    expect(r[0].value).toEqual([1, 0, 0, 1]);
    const tiny = buildRules({ ease_out: [[33, 0.1], [33, 0.1]], ease_in: [[33, 0.1], [33, 0.1]] }, {});
    expect((tiny[0].value as number[])[0]).toBeGreaterThanOrEqual(0.001);
    expect((tiny[0].value as number[])[2]).toBeLessThanOrEqual(0.999);
  });

  it("one edit is low confidence, scattered edits are low, and high needs two reviews", () => {
    expect(buildRules({ layer_duration: [0.8] }, { layer_duration: 1 })[0].confidence).toBe("low");
    expect(buildRules({ layer_duration: [0.5, 1.4, 0.8] }, { layer_duration: 1 })[0].confidence).toBe("low");
    const same = [0.8, 0.8, 0.82, 0.78, 0.8, 0.8];
    expect(buildRules({ layer_duration: same }, { layer_duration: 1 })[0].confidence).toBe("medium");
    expect(buildRules({ layer_duration: same }, { layer_duration: 2 })[0].confidence).toBe("high");
  });

  it("a ratio near 1 makes no rule; the text says shorter or longer", () => {
    expect(buildRules({ font_size: [1.01, 1.02, 0.99] }, {})).toEqual([]);
    expect(buildRules({ animation_timing: [1.3, 1.3, 1.3] }, {})[0].text).toContain("longer");
    expect(buildRules({ font_size: [0.8, 0.8] }, {})[0].text).toContain("smaller");
  });

  it("overshoot needs more removals than additions", () => {
    expect(buildRules({ overshoot_removed: [1, 1, 1] }, {})[0]).toMatchObject({ id: "overshoot", samples: 3, consistency: 1 });
    expect(buildRules({ overshoot_removed: [1], overshoot_added: [1, 1] }, {})).toEqual([]);
  });

  it("edge margin needs a majority pulled in; fill colour needs two layers on the same colour", () => {
    const m = buildRules({ edge_margin: [[0.05, 0.12], [0.06, 0.12], [0.04, 0.11]] }, {});
    expect(m[0]).toMatchObject({ id: "edge_margin", confidence: "medium" });
    expect(m[0].value).toBeCloseTo(0.12);
    expect(buildRules({ edge_margin: [[0.2, 0.1], [0.2, 0.1], [0.05, 0.12]] }, {})).toEqual([]);

    const c = buildRules({ fill_color: [[1, 0, 0], [1, 0.01, 0], [0, 0, 1]] }, {});
    expect(c[0]).toMatchObject({ id: "fill_color", samples: 2 });
    expect(buildRules({ fill_color: [[1, 0, 0], [0, 0, 1]] }, {})).toEqual([]);
  });

  it("turns observations into samples", () => {
    const l = layer(1, "T");
    const d = diffTasteSnapshots(
      snap([layer(1, "T", { outPoint: 5, text: { fontSize: 72, fillColor: [1, 1, 1], text: "T" } })]),
      snap([{ ...l, outPoint: 4, text: { fontSize: 60, fillColor: [0, 0, 0], text: "T" } }])
    );
    expect(samplesFromObservations(d.observations)).toEqual({ layer_duration: [0.8], font_size: [0.833], fill_color: [[0, 0, 0]] });
  });
});

describe("evidence", () => {
  it("a review replaces its own earlier samples and counts reviews, not samples", () => {
    const ev = emptyLedger().evidence;
    recordEvidence(ev, "base_a", "2026-01-01T00:00:00Z", { layer_duration: [0.8, 0.8] });
    recordEvidence(ev, "base_a", "2026-01-02T00:00:00Z", { layer_duration: [0.8, 0.8, 0.8] });
    recordEvidence(ev, "base_b", "2026-01-03T00:00:00Z", { layer_duration: [0.75] });
    const got = collectSeries(ev);
    expect(got.series.layer_duration).toEqual([0.8, 0.8, 0.8, 0.75]);
    expect(got.reviews.layer_duration).toBe(2);
    recordEvidence(ev, "base_a", "2026-01-04T00:00:00Z", {});
    expect(collectSeries(ev).series.layer_duration).toEqual([0.75]);
  });

  it("loads an empty ledger from a missing or corrupt file", () => {
    const dir = tempDir();
    expect(loadLedger(path.join(dir, "none.json"))).toEqual(emptyLedger());
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    expect(loadLedger(path.join(dir, "bad.json"))).toEqual(emptyLedger());
  });

  it("keys baselines by normalised project path and comp", () => {
    expect(baselineKey("C:\\jobs\\a.aep", 3)).toBe(baselineKey("C:/jobs/a.aep", 3));
    expect(baselineKey("<unsaved>", 3)).toBe("<unsaved>|3");
  });
});

describe("settings: taste rules", () => {
  const rule = { id: "layer_duration", kind: "layer_duration", text: "Shorter.", value: 0.8, confidence: "medium", samples: 3, reviews: 1, saved_at: "2026-01-01T00:00:00Z" };

  it("keeps well-formed rules and drops the rest", () => {
    const out = sanitizeTasteRules([
      rule,
      { ...rule, id: "x", kind: "nonsense" },
      { ...rule, id: "y", confidence: "certain" },
      { ...rule, id: "z", value: "big" },
      { ...rule, id: "ease_influence", kind: "ease_influence", value: [0.7, 0, 0.8, 1] },
      { ...rule, text: "" },
      null,
    ]);
    expect(out.map((r) => r.id)).toEqual(["layer_duration", "ease_influence"]);
    expect(sanitizeTasteRules("nope")).toEqual([]);
  });

  it("saves rules next to the other taste fields and reads them back; defaults carry none", () => {
    const file = path.join(tempDir(), "settings.json");
    const store = new SettingsStore(file);
    expect(store.get().taste.rules).toBeUndefined();
    store.updateTaste({ rules: [rule as never] });
    store.updateTaste({ notes: "keep it calm" });
    expect(new SettingsStore(file).get().taste).toMatchObject({ notes: "keep it calm", rules: [{ id: "layer_duration", value: 0.8 }] });
    store.updateTaste({ rules: [] });
    expect(new SettingsStore(file).get().taste.rules).toBeUndefined();
  });
});

// ---------- the host function under node:vm ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1280, 720, 4);
  const loaded = loadHost(project, ["layers.jsx", "learntaste.jsx"]);
  return { project, comp, ...loaded };
}

/** A text layer with two bezier position keys whose ease the test can set. */
function animatedTitle(A: any, comp: FakeComp, name: string, to: number[], inf = 33.333) {
  A.createLayer({ comp_id: comp.id, type: "text", name, text: name, expect: GUARD });
  const l = comp.layer(name)!;
  const p = l.transform("Position") as FakeProperty;
  p.setValueAtTime(0, [100, 100, 0]);
  p.setValueAtTime(1, [...to, 0]);
  for (const k of [1, 2]) {
    p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
    p.setTemporalEaseAtKey(k, [new KeyframeEase(0, inf)], [new KeyframeEase(0, inf)]);
  }
  return l;
}

describe("learntasteRead (host, under node:vm)", () => {
  it("reads timing, keys with ease and interpolation, text size and colour, and changes nothing", () => {
    const { A, comp, undo, project } = scene();
    (project as any).revision = 7;
    const title = animatedTitle(A, comp, "Title", [500, 300], 60);
    const doc = (title.property("ADBE Text Properties") as any).property("ADBE Text Document").staticValue;
    doc.fontSize = 90;
    doc.fillColor = [1, 0.5, 0];
    const begun = undo.begun;
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id })));
    expect(undo.begun).toBe(begun);
    expect(out).toMatchObject({ project_path: "<unsaved>", revision: 7, comp_id: comp.id, width: 1280, height: 720, truncated: false });
    const l = out.layers[0];
    expect(l).toMatchObject({ name: "Title", kind: "text", inPoint: 0, outPoint: 4 });
    expect(l.props.position.keys).toHaveLength(2);
    expect(l.props.position.keys[1]).toMatchObject({ t: 1, v: [500, 300, 0], inT: "bezier", outT: "bezier", inE: [{ s: 0, i: 60 }], outE: [{ s: 0, i: 60 }] });
    expect(l.props.opacity).toMatchObject({ value: 100, keys: [] });
    expect(l.text).toMatchObject({ fontSize: 90, fillColor: [1, 0.5, 0], text: "Title" });
  });

  it("limits to the named layers, resolves them before reading, and fails on a bad one", () => {
    const { A, comp } = scene();
    animatedTitle(A, comp, "A", [200, 200]);
    animatedTitle(A, comp, "B", [300, 300]);
    const only = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id, layers: [{ name: "B" }, { name: "B" }] })));
    expect(only.layers.map((x: any) => x.name)).toEqual(["B"]);
    expect(() => A.learntasteRead({ comp_id: comp.id, layers: [{ name: "B" }, { name: "Nope" }] })).toThrow(/Nope/);
    expect(() => A.learntasteRead({ comp_id: 99999 })).toThrow(/No CompItem/);
    expect(() => A.learntasteRead({})).toThrow(/comp_id/);
  });

  it("reports an absent revision and a fill that cannot be read as null, without throwing", () => {
    const { A, comp } = scene();
    const t = animatedTitle(A, comp, "T", [200, 200]);
    ((t.property("ADBE Text Properties") as any).property("ADBE Text Document").staticValue as any).applyFill = false;
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id })));
    expect(out.revision).toBeNull();
    expect(out.layers[0].text.fillColor).toBeNull();
  });
});

// ---------- the guarded flow end to end: real host code behind a fake bridge ----------

function flow(project: FakeProject, A: any) {
  const dir = tempDir();
  const calls: string[] = [];
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  const asks = new AskStore();
  const queue = new SingleWriterQueue();
  let opSeq = 0;
  const bridge = {
    queueRuns: [] as string[],
    newOpId: () => "op_test",
    evalRaw: async ({ script, mutates }: { script: string; mutates?: boolean }) => {
      const m = /^__chromaAe\.(\w+)\((.*)\)$/s.exec(script);
      if (!m) throw new Error(`Unexpected script: ${script}`);
      calls.push(`${m[1]}${mutates ? " (mutates)" : ""}`);
      return { ok: true, result: JSON.parse(JSON.stringify(A[m[1]](JSON.parse(m[2])))), durationMs: 1 };
    },
    // Like HostBridge.callHost: the eval waits its turn in the single-writer queue.
    async callHost(fn: string, args: unknown, opts: { label: string; mutates?: boolean; toolName?: string }) {
      return queue.run(opts.label, async () => {
        bridge.queueRuns.push(opts.label);
        const r = await (bridge.evalRaw as any)({ id: `op_${++opSeq}`, script: buildJsxCall(fn, args), mutates: opts.mutates, label: opts.label, toolName: opts.toolName });
        return { id: "op", result: r.result, durationMs: 1 };
      });
    },
  };
  const ctx = {
    bridge,
    settings,
    asks,
    dataDir: dir,
  } as unknown as ToolContext;
  void project;
  return { ctx, calls, settings, asks, dir };
}

describe("ae_taste_baseline / ae_learn_taste / ae_taste_rules", () => {
  it("learns an ease preference from three edited titles, asks first, and saves only what was chosen", async () => {
    const { A, comp, project } = scene();
    const titles = ["One", "Two", "Three"].map((n) => animatedTitle(A, comp, n, [500, 300]));
    const { ctx, calls, settings, asks } = flow(project, A);

    const base = await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id, note: "intro titles" }), ctx);
    expect(base).toMatchObject({ ok: true, layers: 3, animated_properties: 3, tracked: "every layer" });
    // Reads only: the host call is not a mutation.
    expect(calls).toEqual(["learntasteRead"]);

    // The user pushes every title's ease to 75% / 25%, shortens them and pulls them in.
    for (const t of titles) {
      const p = t.transform("Position") as FakeProperty;
      p.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33.333)], [new KeyframeEase(0, 75)]);
      p.setTemporalEaseAtKey(2, [new KeyframeEase(0, 25)], [new KeyframeEase(0, 33.333)]);
      p.setValueAtKey(2, [640, 360, 0]);
      t.outPoint = 3;
    }

    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    expect(out).toMatchObject({ ok: true, changed: true, recorded: true, suspected_undo_or_reopen: false, compared_layers: 3 });
    expect(out.counts).toMatchObject({ ease_out_influence: 3, ease_in_influence: 3, layer_duration: 3, edge_margin: 3 });
    const ease = out.proposals.find((p: any) => p.id === "ease_influence");
    expect(ease).toMatchObject({ confidence: "medium", samples: 3, reviews: 1, worth_asking: true, already_saved: false });
    expect(ease.value).toEqual([0.75, 0, 0.75, 1]);
    expect(out.proposals.find((p: any) => p.id === "layer_duration")).toMatchObject({ value: 0.75 });
    expect(out.ask.multi_select).toBe(true);
    expect(out.ask.options.at(-1).id).toBe("none");
    expect(out.ask.options.map((o: any) => o.id)).toContain("ease_influence");
    expect(out.notes.join(" ")).toContain("cannot say who made a change");
    // Nothing is saved by the review.
    expect(settings.get().taste.rules).toBeUndefined();

    // Saving without the user's answer is refused.
    const unanswered = asks.ask({ question: "Keep?", kind: "choice", multi_select: true, allow_other: false, options: out.ask.options });
    expect(await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], ask_id: unanswered.id }), ctx)).toMatchObject({ ok: false, error: "not_answered" });

    // The user picks only the ease rule.
    asks.answer(unanswered.id, { choice_ids: ["ease_influence"] });
    const wrong = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence", "layer_duration"], ask_id: unanswered.id }), ctx);
    expect(wrong).toMatchObject({ ok: false, error: "not_confirmed" });
    expect(settings.get().taste.rules).toBeUndefined();

    const saved: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], ask_id: unanswered.id }), ctx);
    expect(saved).toMatchObject({ ok: true, saved: ["ease_influence"], also_set: ["preferred_ease"] });
    expect(settings.get().taste.preferred_ease).toEqual([0.75, 0, 0.75, 1]);
    expect(settings.get().taste.rules).toHaveLength(1);
    expect(settings.get().taste.avoid_overshoot).toBe(false);

    // A second review of the same baseline does not double the evidence, and the saved rule is no longer asked about.
    const again: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    const easeAgain = again.proposals.find((p: any) => p.id === "ease_influence");
    expect(easeAgain).toMatchObject({ samples: 3, reviews: 1, already_saved: true, worth_asking: false });
    expect(again.ask.options.map((o: any) => o.id)).not.toContain("ease_influence");

    // Listing, then forgetting clears the rule and its evidence.
    const listed: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "list" }), ctx);
    expect(listed.saved.map((r: any) => r.id)).toEqual(["ease_influence"]);
    expect(listed.proposals.map((r: any) => r.id)).toContain("layer_duration");
    const gone: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "forget", rule_ids: ["ease_influence", "overshoot"] }), ctx);
    expect(gone).toMatchObject({ ok: true, forgotten: ["ease_influence"], not_saved: ["overshoot"] });
    const after: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id, record: false }), ctx);
    // The ease evidence was dropped, but this review still sees the user's current ease against the baseline.
    expect(after.proposals.find((p: any) => p.id === "ease_influence")).toMatchObject({ reviews: 1 });
    const fresh = loadLedger(path.join(ctx.dataDir!, "learn-taste.json"));
    expect(fresh.evidence.ease_out).toBeUndefined();
  });

  it("saves on the user's word in the chat, applies overshoot to avoid_overshoot, and refuses an unknown rule", async () => {
    const { A, comp, project } = scene();
    const bouncy = animatedTitle(A, comp, "Pop", [500, 300]);
    const p = bouncy.transform("Position") as FakeProperty;
    p.setValueAtTime(0.5, [700, 300, 0]);
    for (const k of [1, 2, 3]) p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
    const { ctx, settings } = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    // The user deletes the bounce key.
    p.removeKey(2);
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    expect(out.counts).toMatchObject({ overshoot_removed: 1, keys_removed: 1 });
    // One edit is "low", so it is not put to the user as a question.
    expect(out.proposals.find((r: any) => r.id === "overshoot")).toMatchObject({ confidence: "low", worth_asking: false });
    expect(out.ask).toBeNull();

    expect(await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["font_size"], confirmed_in_chat: true }), ctx)).toMatchObject({ ok: false, error: "unknown_rule" });
    const saved: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["overshoot"], confirmed_in_chat: true }), ctx);
    expect(saved).toMatchObject({ ok: true, also_set: ["avoid_overshoot"] });
    expect(settings.get().taste.avoid_overshoot).toBe(true);
    expect(settings.get().taste.rules?.[0]).toMatchObject({ id: "overshoot", confidence: "low", value: null });
  });

  it("explains itself when there is no baseline, and refuses a baseline from another project", async () => {
    const { A, comp, project } = scene();
    animatedTitle(A, comp, "T", [500, 300]);
    const { ctx } = flow(project, A);
    const none: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    expect(none).toMatchObject({ ok: false, error: "no_baseline", baselines: [] });

    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    // Another unsaved project whose comp has the same id but none of the layers.
    const other = new FakeProject();
    const c2 = other.addComp("Other", 1280, 720, 4);
    (c2 as any).id = comp.id;
    const o = loadHost(other, ["layers.jsx", "learntaste.jsx"]);
    o.A.createLayer({ comp_id: c2.id, type: "null", name: "N1", expect: GUARD });
    o.A.createLayer({ comp_id: c2.id, type: "null", name: "N2", expect: GUARD });
    const ctxOther = { ...(ctx as any), bridge: flow(other, o.A).ctx.bridge } as ToolContext;
    const mismatch: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctxOther);
    expect(mismatch).toMatchObject({ ok: false, error: "baseline_mismatch" });
    const badId: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id, baseline_id: "base_missing" }), ctx);
    expect(badId).toMatchObject({ ok: false, error: "no_baseline" });
  });

  it("does not count edits as taste when the revision went back, and a baseline with named layers tracks only those", async () => {
    const { A, comp, project } = scene();
    const a = animatedTitle(A, comp, "A", [500, 300]);
    animatedTitle(A, comp, "B", [500, 300]);
    (project as any).revision = 20;
    const { ctx } = flow(project, A);
    const base: any = await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id, layers: [{ name: "A" }] }), ctx);
    expect(base).toMatchObject({ layers: 1, tracked: "the layers you named" });
    a.outPoint = 2;
    comp.layer("B")!.outPoint = 1;
    (project as any).revision = 12;
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    expect(out).toMatchObject({ ok: true, suspected_undo_or_reopen: true, compared_layers: 1 });
    expect(out.counts).toEqual({ layer_duration: 1 });
    expect(out.proposals).toEqual([]);
    expect(out.notes.join(" ")).toContain("revision went back");
  });

  it("record false leaves the ledger alone and caps the listed observations", async () => {
    const { A, comp, project } = scene();
    const titles = ["One", "Two", "Three"].map((n) => animatedTitle(A, comp, n, [500, 300]));
    const { ctx } = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    for (const t of titles) t.outPoint = 2;
    const file = path.join(ctx.dataDir!, "learn-taste.json");
    const before = fs.readFileSync(file, "utf8");
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id, record: false, max_observations: 2 }), ctx);
    expect(out).toMatchObject({ recorded: false, observations_truncated: true });
    expect(out.observations).toHaveLength(2);
    expect(out.counts.layer_duration).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("a new baseline replaces the old one for the same comp", async () => {
    const { A, comp, project } = scene();
    animatedTitle(A, comp, "T", [500, 300]);
    const { ctx } = flow(project, A);
    const first: any = await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    const second: any = await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    expect(second.baseline_id).not.toBe(first.baseline_id);
    expect(loadLedger(second.ledger_path).baselines).toHaveLength(1);
  });

  it("ae_taste_rules says so when the server has no settings store", async () => {
    const { A, project } = scene();
    const { ctx } = flow(project, A);
    const bare = { ...(ctx as any), settings: undefined } as ToolContext;
    expect(await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "list" }), bare)).toMatchObject({ ok: false, error: "no_settings" });
  });
});

describe("review fixes", () => {
  const pos = (keys: SnapKey[]) => ({ position: prop("position", keys) });

  async function threeEditedTitles() {
    const { A, comp, project } = scene();
    const titles = ["One", "Two", "Three"].map((n) => animatedTitle(A, comp, n, [500, 300]));
    const f = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), f.ctx);
    for (const t of titles) {
      const pr = t.transform("Position") as FakeProperty;
      pr.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33.333)], [new KeyframeEase(0, 75)]);
      pr.setTemporalEaseAtKey(2, [new KeyframeEase(0, 25)], [new KeyframeEase(0, 33.333)]);
    }
    return { A, comp, project, titles, ...f };
  }

  it("a review with record false returns no ask, since its rules are not stored to be saved", async () => {
    const { comp, ctx } = await threeEditedTitles();
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id, record: false }), ctx);
    expect(out.proposals.find((p: any) => p.id === "ease_influence").worth_asking).toBe(true);
    expect(out.ask).toBeNull();
    expect(out.next).toContain("record true");
  });

  it("saves only from a question built from the stored proposals", async () => {
    const { comp, ctx, asks } = await threeEditedTitles();
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    const opt = out.ask.options.find((o: any) => o.id === "ease_influence");
    expect(opt.label).toBe("Ease: out 75% / in 25%");
    expect(opt.label.length).toBeLessThan(40);
    expect(opt.description).toContain("cubic-bezier");
    expect(opt.description.length).toBeLessThanOrEqual(400);

    // Another question that happens to have an option with the same id is refused.
    const fake = asks.ask({ question: "Keep?", kind: "choice", multi_select: true, allow_other: false, options: [{ id: "ease_influence", label: "overshoot" }] });
    asks.answer(fake.id, { choice_ids: ["ease_influence"] });
    expect(await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], ask_id: fake.id }), ctx)).toMatchObject({ ok: false, error: "ask_mismatch" });

    // The real one passes, and the same options are rebuilt from the proposal.
    expect(askOptionOf(out.proposals.find((p: any) => p.id === "ease_influence"))).toEqual(opt);
    const real = asks.ask({ question: out.ask.question, kind: "choice", multi_select: true, allow_other: false, options: out.ask.options });
    asks.answer(real.id, { choice_ids: ["ease_influence"] });
    expect(await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], ask_id: real.id }), ctx)).toMatchObject({ ok: true });
  });

  it("forgetting a rule puts back the settings that saving it changed", async () => {
    const { comp, ctx, settings } = await threeEditedTitles();
    settings.updateTaste({ preferred_ease: [0.2, 0, 0.2, 1] });
    await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    const saved: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], confirmed_in_chat: true }), ctx);
    expect(saved.also_set).toEqual(["preferred_ease"]);
    expect(settings.get().taste.preferred_ease).toEqual([0.75, 0, 0.75, 1]);
    const gone: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "forget", rule_ids: ["ease_influence"] }), ctx);
    expect(gone.also_cleared).toEqual(["preferred_ease"]);
    // It was put back, not left alone: no still_set, no "changed by hand" note.
    expect(gone.still_set).toBeUndefined();
    expect(gone.note).toBeUndefined();
    expect(settings.get().taste.preferred_ease).toEqual([0.2, 0, 0.2, 1]);
  });

  it("forgetting leaves a setting the user changed by hand, and says so", async () => {
    const { comp, ctx, settings } = await threeEditedTitles();
    await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["ease_influence"], confirmed_in_chat: true }), ctx);
    settings.updateTaste({ preferred_ease: [0.5, 0, 0.5, 1] });
    const gone: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "forget", rule_ids: ["ease_influence"] }), ctx);
    expect(gone.also_cleared).toEqual([]);
    expect(gone.still_set).toEqual(["preferred_ease"]);
    expect(settings.get().taste.preferred_ease).toEqual([0.5, 0, 0.5, 1]);
  });

  it("forgetting the overshoot rule turns avoid_overshoot back off", async () => {
    const { A, comp, project } = scene();
    const bouncy = animatedTitle(A, comp, "Pop", [500, 300]);
    const pr = bouncy.transform("Position") as FakeProperty;
    pr.setValueAtTime(0.5, [700, 300, 0]);
    for (const k of [1, 2, 3]) pr.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
    const { ctx, settings } = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    pr.removeKey(2);
    await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["overshoot"], confirmed_in_chat: true }), ctx);
    expect(settings.get().taste.avoid_overshoot).toBe(true);
    const gone: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "forget", rule_ids: ["overshoot"] }), ctx);
    expect(gone.also_cleared).toEqual(["avoid_overshoot"]);
    expect(gone.still_set).toBeUndefined();
    expect(settings.get().taste.avoid_overshoot).toBe(false);
  });

  it("forgetting the overshoot rule keeps avoid_overshoot when it was already on, without calling it cleared", async () => {
    const { A, comp, project } = scene();
    const bouncy = animatedTitle(A, comp, "Pop", [500, 300]);
    const pr = bouncy.transform("Position") as FakeProperty;
    pr.setValueAtTime(0.5, [700, 300, 0]);
    for (const k of [1, 2, 3]) pr.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
    const { ctx, settings } = flow(project, A);
    settings.updateTaste({ avoid_overshoot: true });
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    pr.removeKey(2);
    await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "save", rule_ids: ["overshoot"], confirmed_in_chat: true }), ctx);
    const gone: any = await tool("ae_taste_rules").handler(AeTasteRulesSchema.parse({ action: "forget", rule_ids: ["overshoot"] }), ctx);
    expect(gone.also_cleared).toEqual([]);
    expect(gone.still_set).toBeUndefined();
    expect(settings.get().taste.avoid_overshoot).toBe(true);
  });

  it("the comp reads wait in the single-writer queue", async () => {
    const { A, comp, project } = scene();
    animatedTitle(A, comp, "A", [200, 200]);
    const { ctx } = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), ctx);
    await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id, record: false }), ctx);
    expect((ctx.bridge as any).queueRuns).toEqual([
      `ae_taste_baseline(${comp.id})`,
      `ae_learn_taste(${comp.id})`,
      `ae_learn_taste(${comp.id})`,
    ]);
  });

  it("a baseline with named layers is reviewed from those layers, and a deleted one is reported", async () => {
    const { A, comp, project } = scene();
    const a = animatedTitle(A, comp, "A", [200, 200]);
    const b = animatedTitle(A, comp, "B", [300, 300]);
    const { ctx } = flow(project, A);
    await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id, layers: [{ name: "A" }, { name: "B" }] }), ctx);
    b.remove();
    a.outPoint = 2;
    const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
    expect(out.ok).toBe(true);
    expect(out.compared_layers).toBe(1);
    expect(out.counts).toMatchObject({ layer_removed: 1, layer_duration: 1 });
  });

  it("the host lists ids it cannot find when asked to tolerate them, and reads no layers for a header read", () => {
    const { A, comp } = scene();
    const t = animatedTitle(A, comp, "A", [200, 200]);
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id, layers: [{ id: t.id }, { id: 987654 }], tolerate_missing: true })));
    expect(out.layers.map((l: any) => l.name)).toEqual(["A"]);
    expect(out.missing).toEqual([987654]);
    expect(() => A.learntasteRead({ comp_id: comp.id, layers: [{ id: 987654 }] })).toThrow(/No layer with id/);
    const head = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id, header_only: true })));
    expect(head.layers).toEqual([]);
    expect(head.comp_id).toBe(comp.id);
  });

  it("an ease the user added to linear keys is learned", () => {
    const linear = layer(1, "T", { props: pos([key(0, [0, 0], 16, 16, "linear"), key(1, [100, 0], 16, 16, "linear")]) });
    const eased = layer(1, "T", { props: pos([key(0, [0, 0], 16, 75, "bezier"), key(1, [100, 0], 25, 16, "bezier")]) });
    const d = diffTasteSnapshots(snap([linear]), snap([eased]));
    // Only the sides that carry a segment count: key 1 out and key 2 in, not key 1 in or key 2 out.
    expect(d.counts).toMatchObject({ interp_changed: 2, ease_out_influence: 1, ease_in_influence: 1 });
    const first = d.observations.find((o) => o.kind === "ease_out_influence");
    expect(first).toMatchObject({ before: null, after: 75 });
    const s = samplesFromObservations(d.observations);
    expect(s.ease_out).toEqual([[null, 75]]);
    expect(s.ease_in).toEqual([[null, 25]]);
    const rules = buildRules(s, { ease_out: 1, ease_in: 1 });
    const ease = rules.find((r) => r.id === "ease_influence")!;
    expect(ease).toBeDefined();
    // AE's 16.67% for a linear side is not what the agent chose: the text says linear, not a percentage.
    expect(ease.text).toContain("the agent used linear keys");
    expect(ease.text).not.toMatch(/agent used about/);
    // A side that goes to linear is not an ease.
    expect(diffTasteSnapshots(snap([eased]), snap([linear])).counts).toEqual({ interp_changed: 2 });
  });

  it("a separated position is read through its X and Y properties and diffed", () => {
    const { A, comp } = scene();
    const t = animatedTitle(A, comp, "Sep", [500, 300]);
    const group = (t as any).group.property("ADBE Transform Group");
    (t.transform("Position") as any).dimensionsSeparated = true;
    const px = new FakeProperty("X Position", "ADBE Position_0", PropertyValueType.OneD, 0);
    const py = new FakeProperty("Y Position", "ADBE Position_1", PropertyValueType.OneD, 300);
    px.parentProperty = group;
    py.parentProperty = group;
    group.props.push(px, py);
    px.setValueAtTime(0, 100);
    px.setValueAtTime(1, 500);
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id })));
    const props = out.layers[0].props;
    expect(props.position.separated).toBe(true);
    expect(props.position_x.keys.map((k: any) => k.v)).toEqual([100, 500]);
    expect(props.position_y).toMatchObject({ kind: "position_y", value: 300 });
    // Moving the X value shows up as a nudge and a margin change.
    const sep = { kind: "position", value: null, keys: [], separated: true } as SnapProp;
    const before = layer(1, "T", { props: { position: sep, position_x: prop("position_x", [], 100), position_y: prop("position_y", [], 250) } });
    const after = layer(1, "T", { props: { position: sep, position_x: prop("position_x", [], 200), position_y: prop("position_y", [], 250) } });
    const d = diffTasteSnapshots(snap([before]), snap([after]));
    expect(d.counts).toMatchObject({ position_nudge: 1, edge_margin: 1 });
  });

  it("a separated position reads without a value and is not diffed", () => {
    const { A, comp } = scene();
    const t = animatedTitle(A, comp, "Sep", [500, 300]);
    (t.transform("Position") as any).dimensionsSeparated = true;
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id })));
    expect(out.layers[0].props.position).toMatchObject({ separated: true, value: null, keys: [] });
    expect(out.layers[0].props.opacity.separated).toBeUndefined();

    const sepPos: SnapProp = { kind: "position", value: null, keys: [], separated: true };
    const before = layer(1, "T", { props: { position: sepPos } });
    const after = layer(1, "T", { props: { position: { ...sepPos } } });
    expect(diffTasteSnapshots(snap([before]), snap([after])).observations).toEqual([]);
    const moved = layer(1, "T", { props: { position: prop("position", [], [150, 250]) } });
    expect(diffTasteSnapshots(snap([before]), snap([moved])).observations).toEqual([]);
  });

  it("does not take a margin from a parented or 3D text layer", () => {
    const at = (x: number, extra: Partial<SnapLayer>) => layer(1, "T", { ...extra, props: { position: prop("position", [], [x, 250]) } });
    expect(diffTasteSnapshots(snap([at(50, {})]), snap([at(150, {})])).counts.edge_margin).toBe(1);
    expect(diffTasteSnapshots(snap([at(50, { parented: true })]), snap([at(150, { parented: true })])).counts.edge_margin).toBeUndefined();
    expect(diffTasteSnapshots(snap([at(50, { threeD: true })]), snap([at(150, { threeD: true })])).counts.edge_margin).toBeUndefined();
  });

  it("host reads parented and 3D flags", () => {
    const { A, comp } = scene();
    const a = animatedTitle(A, comp, "A", [200, 200]);
    const b = animatedTitle(A, comp, "B", [200, 200]);
    (b as any).parent = a;
    (b as any).threeDLayer = true;
    const out = JSON.parse(JSON.stringify(A.learntasteRead({ comp_id: comp.id })));
    const byName = Object.fromEntries(out.layers.map((l: any) => [l.name, l]));
    expect(byName.A).toMatchObject({ parented: false, threeD: false });
    expect(byName.B).toMatchObject({ parented: true, threeD: true });
  });

  it("a move in and back out, or a fade that ends near its start, is not an overshoot", () => {
    expect(hasOvershoot([key(0, 0), key(0.5, 500), key(1, 500), key(1.5, 100)])).toBe(false);
    expect(hasOvershoot([key(0, 0), key(0.5, 100), key(1, 5)])).toBe(false);
    expect(hasOvershoot([key(0, 0), key(0.5, 120), key(1, 100)])).toBe(true);
    // A damped bounce still counts.
    expect(hasOvershoot([key(0, 0), key(0.4, 120), key(0.6, 95), key(0.8, 100)])).toBe(true);
    // Moving the move-out key does not flip it.
    const a = layer(1, "T", { props: pos([key(0, [0]), key(0.5, [500]), key(1, [500]), key(1.5, [100])]) });
    const b = layer(1, "T", { props: pos([key(0, [0]), key(0.5, [500]), key(1, [500]), key(1.5, [150])]) });
    expect(diffTasteSnapshots(snap([a]), snap([b])).counts.overshoot_added).toBeUndefined();
  });

  it("caps the key values one observation lists", () => {
    const many = (off: number) => Array.from({ length: 60 }, (_, i) => key(i * 0.1, [i + off, 0]));
    const d = diffTasteSnapshots(snap([layer(1, "T", { props: pos(many(0)) })]), snap([layer(1, "T", { props: pos(many(5)) })]));
    const nudge = d.observations.find((o) => o.kind === "position_nudge")!;
    expect((nudge.before as unknown[]).length).toBe(20);
    expect(nudge.detail).toContain("60 of 60");
  });

  it("a review after an unguarded write (no undo step) is not learned from either", async () => {
    const dir = tempDir();
    installSessionTracking({ dataDir: dir });
    try {
      const { A, comp, project } = scene();
      const titles = ["One", "Two", "Three"].map((n) => animatedTitle(A, comp, n, [500, 300]));
      const f = flow(project, A);
      await tool("ae_taste_baseline").handler(AeTasteBaselineSchema.parse({ comp_id: comp.id }), f.ctx);
      // The agent's own unguarded mutating eval (as ae_set_keyframe_ease does): the real session bridge hook logs it as
      // an agent write for the project but adds no undo step.
      (A as any).sessionSnapshot = () => ({
        project_path: "<unsaved>", dirty: true, revision: 1, num_items: 1, item_ids: [comp.id], items_truncated: false,
        active_item: { id: comp.id, name: "Main", kind: "comp" }, ae_version: "26.2.1", build: "1",
        render_queue: { num_items: 0, queued: 0, rendering: 0 }, comps: [],
      });
      (A as any).easeWrite = () => ({ ok: true });
      const unhook = installSessionBridgeHook(f.ctx.bridge as any);
      await new Promise((r) => setTimeout(r, 5));
      try {
        await f.ctx.bridge.callHost("easeWrite" as never, {}, { label: "ease", mutates: true, toolName: "ae_set_keyframe_ease" });
      } finally {
        unhook();
      }
      for (const t of titles) {
        const pr = t.transform("Position") as FakeProperty;
        pr.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33.333)], [new KeyframeEase(0, 75)]);
        pr.setTemporalEaseAtKey(2, [new KeyframeEase(0, 25)], [new KeyframeEase(0, 33.333)]);
      }
      expect(getSessionTracker()!.steps()).toEqual([]);
      const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), f.ctx);
      expect(out).toMatchObject({ ok: true, agent_wrote_since_baseline: true, recorded: false, ask: null });
      expect(out.notes.join(" ")).toContain("ae_set_keyframe_ease");
      expect(loadLedger(path.join(f.ctx.dataDir!, "learn-taste.json")).evidence.ease_out).toBeUndefined();
    } finally {
      resetSessionTracking();
    }
  });

  it("a review after the agent's own write is not learned from", async () => {
    const dir = tempDir();
    const tracker = installSessionTracking({ dataDir: dir });
    try {
      const { comp, titles, ctx } = await threeEditedTitles();
      tracker.addStep({
        op_id: "op_1",
        tool: "ae_set_property",
        label: "ae_set_property",
        at: new Date(Date.now() + 5000).toISOString(),
        project_path: "<unsaved>",
        service_id: "svc",
        revision_after: null,
        checkpoint: null,
      });
      titles[0].outPoint = 2;
      const out: any = await tool("ae_learn_taste").handler(AeLearnTasteSchema.parse({ comp_id: comp.id }), ctx);
      expect(out).toMatchObject({ ok: true, agent_wrote_since_baseline: true, recorded: false, ask: null });
      expect(out.changed).toBe(true);
      expect(out.notes.join(" ")).toContain("ae_set_property");
      expect(out.next).toContain("new baseline");
      expect(loadLedger(path.join(ctx.dataDir!, "learn-taste.json")).evidence.ease_out).toBeUndefined();
    } finally {
      resetSessionTracking();
    }
  });
});
