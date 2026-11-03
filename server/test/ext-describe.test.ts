import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeDescribeCompSchema,
  buildActions,
  buildBeats,
  overshootFromSamples,
  describeFromRaw,
  describeTools,
  drawGantt,
  findConcerns,
  stackRuns,
  verbFor,
  type DescribeLayer,
  type DescribeRaw,
  type DescribeSegment,
} from "../src/tools/ext/describe.js";
import { FakeGroup, FakeProject, FakeProperty, KeyframeInterpolationType, loadHost, MarkerValue, PropertyValueType, TrackMatteType, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = describeTools.find((t) => t.name === "ae_describe_comp")!;

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-describe-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
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

// ---------- builders for raw host data ----------

const L = (index: number, name: string, extra: Partial<DescribeLayer> = {}): DescribeLayer => ({
  index,
  id: 100 + index,
  name,
  role: "solid",
  enabled: true,
  in_point: 0,
  out_point: 4,
  parent: null,
  matte: null,
  is_parent: false,
  is_matte: false,
  expressions: { count: 0, props: [], refs: [], errors: 0 },
  animated: { props: 0, keys: 0 },
  markers: [],
  ...extra,
});

const S = (layer: number, prop: string, start: number, end: number, from: number[], to: number[], extra: Partial<DescribeSegment> = {}): DescribeSegment => ({
  layer,
  prop,
  kind: from.length > 1 ? "3d" : "1d",
  start,
  end,
  from,
  to,
  ...extra,
});

function raw(layers: DescribeLayer[], segments: DescribeSegment[] = [], extra: Partial<DescribeRaw> = {}): DescribeRaw {
  return {
    comp: { id: 7, name: "Main", width: 1920, height: 1080, pixel_aspect: 1, frame_rate: 25, duration: 4, work_area: { start: 0, duration: 4 }, num_layers: layers.length },
    range: { from: 1, to: layers.length, complete: true, next_from_layer: null, layers_over_cap: false },
    layers,
    segments,
    segments_truncated: false,
    walk_truncated: false,
    markers: { count: 0, list: [], truncated: false },
    nesting: { id: 7, name: "Main", layers: layers.length, duration: 4, children: [] },
    nesting_truncated: false,
    properties_visited: 10,
    ...extra,
  };
}

// ---------- schema ----------

describe("ae_describe_comp schema", () => {
  it("takes a comp id and optional paging, beats and output switches", () => {
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1, from_layer: 201, max_layers: 500, max_beats: 5, gantt: true, include_layers: true }).success).toBe(true);
    expect(AeDescribeCompSchema.safeParse({}).success).toBe(false);
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1, max_layers: 501 }).success).toBe(false);
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1, from_layer: 0 }).success).toBe(false);
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1, max_beats: 51 }).success).toBe(false);
  });

  it("is read-only: no expect, and the description says so", () => {
    expect(AeDescribeCompSchema.shape).not.toHaveProperty("expect");
    expect(tool.description).toMatch(/Read-only/);
  });
});

// ---------- pure logic ----------

describe("verbFor", () => {
  it("names the common moves", () => {
    expect(verbFor(S(1, "Opacity", 0, 1, [0], [100]))).toBe("fades in");
    expect(verbFor(S(1, "Opacity", 0, 1, [100], [0]))).toBe("fades out");
    expect(verbFor(S(1, "Opacity", 0, 0, [0], [100], { hold: true }))).toBe("appears");
    expect(verbFor(S(1, "Scale", 0, 1, [0, 0, 100], [100, 100, 100]))).toBe("scales up");
    expect(verbFor(S(1, "Scale", 0, 1, [100, 100, 100], [50, 50, 100]))).toBe("scales down");
    expect(verbFor(S(1, "Position", 0, 1, [0, 100], [200, 100]))).toBe("slides right");
    expect(verbFor(S(1, "Position", 0, 1, [0, 100], [0, 300]))).toBe("moves down");
    expect(verbFor(S(1, "Position", 0, 1, [0, 100], [150, 300]))).toBe("moves");
    expect(verbFor(S(1, "Rotation", 0, 1, [0], [90]))).toBe("rotates");
    expect(verbFor(S(1, "Gaussian Blur > Blurriness", 0, 1, [0], [20]))).toBe("animates Gaussian Blur > Blurriness");
    expect(verbFor({ layer: 1, prop: "Source Text", kind: "text", start: 0, end: 1 })).toBe("changes its text");
  });

  it("adds overshoot, except for expression-modified values", () => {
    expect(verbFor(S(1, "Scale", 0, 1, [0, 0], [100, 100], { overshoot: true }))).toBe("scales up with overshoot");
    expect(verbFor(S(1, "Scale", 0, 1, [0, 0], [100, 100], { overshoot: true, expression: true }))).toBe("scales up");
  });
});

describe("beats", () => {
  const layers = [L(1, "Title", { role: "text" }), L(2, "Logo", { role: "shape" }), L(3, "BG")];

  it("clusters actions into beats in time order, merging same layer and verb", () => {
    const segs = [
      S(1, "Opacity", 0, 0.5, [0], [100]),
      S(2, "Scale", 0.5, 2, [0, 0, 100], [100, 100, 100], { overshoot: true }),
      S(2, "Scale", 2.1, 2.3, [100, 100, 100], [105, 105, 100], { overshoot: true }),
    ];
    const beats = buildBeats(buildActions(raw(layers, segs)));
    expect(beats.map((b) => b.text)).toEqual(['"Title" fades in', '"Logo" scales up with overshoot']);
    expect(beats[1]).toMatchObject({ start: 0.5, end: 2.3 });
  });

  it("joins actions that start together and uses the plural verb for several layers", () => {
    const segs = [S(1, "Opacity", 0, 0.5, [0], [100]), S(2, "Opacity", 0.1, 0.6, [0], [100]), S(3, "Opacity", 0.2, 0.7, [0], [100])];
    const beats = buildBeats(buildActions(raw(layers, segs)));
    expect(beats).toHaveLength(1);
    expect(beats[0].text).toBe('"Title", "Logo" and "BG" fade in');
    expect(beats[0].actions).toBe(3);
  });

  it("adds entrances and exits unless a keyed move already marks them", () => {
    const ls = [L(1, "Late", { in_point: 1, out_point: 3 }), L(2, "Fades", { in_point: 1, out_point: 4 }), L(3, "Off", { enabled: false, in_point: 2 })];
    const actions = buildActions(raw(ls, [S(2, "Opacity", 1, 1.5, [0], [100])]));
    expect(actions.map((a) => `${a.name}:${a.verb}`)).toEqual(["Late:enters", "Fades:fades in", "Late:leaves"]);
  });

  it("caps the verbs listed in one beat", () => {
    const many = Array.from({ length: 6 }, (_, i) => L(i + 1, `L${i + 1}`));
    const segs = ["Opacity", "Scale", "Position", "Rotation", "Anchor Point", "Mask"].map((p, i) =>
      S(i + 1, p, 0, 1, p === "Position" || p === "Scale" ? [0, 0] : [0], p === "Position" || p === "Scale" ? [10, 10] : [10])
    );
    const beat = buildBeats(buildActions(raw(many, segs)))[0];
    expect(beat.text).toMatch(/; 2 more$/);
  });
});

describe("stack and concerns", () => {
  it("groups the stack top to bottom into runs of one role", () => {
    const ls = [L(1, "A", { role: "text" }), L(2, "B", { role: "text" }), L(3, "C", { role: "null" }), L(4, "D", { role: "text" })];
    expect(stackRuns(ls)).toEqual([
      { role: "text", from: 1, to: 2, count: 2, names: ["A", "B"] },
      { role: "null", from: 3, to: 3, count: 1, names: ["C"] },
      { role: "text", from: 4, to: 4, count: 1, names: ["D"] },
    ]);
  });

  it("defines unused layers: off, not a matte or parent, not named by an expression", () => {
    const ls = [
      L(1, "Driver", { expressions: { count: 1, props: ["Position"], refs: ["Ghost B"], errors: 0 } }),
      L(2, "Ghost A", { enabled: false }),
      L(3, "Ghost B", { enabled: false }),
      L(4, "Rig", { enabled: false, is_parent: true }),
      L(5, "Matte", { enabled: false, is_matte: true }),
    ];
    const c = findConcerns(raw(ls));
    const unused = c.find((k) => k.kind === "unused_layers")!;
    expect(unused.layers).toEqual([{ index: 2, name: "Ghost A" }]);
    expect(c.find((k) => k.kind === "switched_off")!.layers.map((l) => l.name)).toEqual(["Ghost B", "Rig"]);
  });

  it("does not judge unused when only part of the comp was read", () => {
    const r = raw([L(2, "Ghost", { enabled: false })], [], { range: { from: 2, to: 2, complete: false, next_from_layer: null, layers_over_cap: false } });
    const kinds = findConcerns(r).map((k) => k.kind);
    expect(kinds).toContain("switched_off");
    expect(kinds).not.toContain("unused_layers");
  });

  it("flags short, invisible, solo, missing and broken layers", () => {
    const ls = [
      L(1, "Blip", { in_point: 1, out_point: 1.04 }),
      L(2, "Early", { in_point: -5, out_point: 0 }),
      L(3, "Soloed", { solo: true }),
      L(4, "Gone", { source: { kind: "footage", missing: true } }),
      L(5, "Bad", { expressions: { count: 1, props: ["Position"], refs: [], errors: 1 } }),
    ];
    const kinds = findConcerns(raw(ls)).map((k) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(["very_short", "outside_comp_time", "solo_active", "missing_footage", "expression_errors"]));
  });
});

describe("describeFromRaw", () => {
  it("builds a short summary with format, roles, timeline, expressions, precomps and markers", () => {
    const ls = [
      L(1, "Title", { role: "text", expressions: { count: 2, props: ["Position"], refs: [], errors: 0 } }),
      L(2, "Intro", { role: "precomp", source: { kind: "comp", id: 9, name: "Intro comp", layers: 3 } }),
      L(3, "BG"),
    ];
    const r = raw(ls, [S(1, "Opacity", 0, 0.5, [0], [100])], {
      markers: { count: 1, list: [{ time: 1, comment: "Beat drop" }], truncated: false },
      nesting: { id: 7, name: "Main", children: [{ id: 9, name: "Intro comp", children: [{ id: 10, name: "Deep" }] }] },
    });
    const d = describeFromRaw(r);
    expect(d.summary).toContain('"Main": 1920x1080, 25 fps, 4.0 s (100 frames), 3 layers.');
    expect(d.summary).toContain("1 text, 1 solid, 1 precomp");
    expect(d.summary).toContain('0.0-0.5 s: "Title" fades in');
    expect(d.summary).toContain('Expressions: 2 properties on 1 layer: "Title" (2)');
    expect(d.summary).toContain('Precomps: 1: "Intro" -> "Intro comp"');
    expect(d.summary).toContain('Nesting goes deeper in: "Intro comp" ("Deep")');
    expect(d.summary).toContain('Markers: 1 comp marker (1.0 s "Beat drop")');
    expect(d.format.frames).toBe(100);
    expect(d.precomps).toEqual([{ layer: 2, name: "Intro", comp_id: 9, comp_name: "Intro comp", comp_layers: 3 }]);
  });

  it("says what was left out", () => {
    const r = raw([L(1, "A")], [], {
      range: { from: 1, to: 1, complete: false, next_from_layer: 2, layers_over_cap: false },
      segments_truncated: true,
    });
    const d = describeFromRaw(r);
    expect(d.summary).toContain("continue with from_layer 2");
    expect(d.summary).toContain("timeline may be incomplete");
  });

  it("limits the beats in the text but keeps them all in the array", () => {
    const ls = Array.from({ length: 5 }, (_, i) => L(i + 1, `L${i + 1}`));
    const segs = ls.map((l, i) => S(l.index, "Opacity", i * 2, i * 2 + 0.5, [0], [100]));
    const d = describeFromRaw(raw(ls, segs), 2);
    expect(d.beats).toHaveLength(5);
    expect(d.summary).toContain("3 more beats");
  });
});

describe("drawGantt", () => {
  it("draws a PNG with one row per layer and notes truncation at 150 rows", () => {
    const ls = Array.from({ length: 3 }, (_, i) => L(i + 1, `Layer ${i + 1}`, { role: "text", markers: [{ time: 1, comment: "" }] }));
    const { png, info } = drawGantt(raw(ls, [S(1, "Opacity", 0, 1, [0], [100])], { markers: { count: 1, list: [{ time: 2, comment: "" }], truncated: false } }));
    expect(info).toMatchObject({ rows: 3, rows_truncated: false });
    expect(png.width).toBe(info.width);
    const decoded = PNG.sync.read(PNG.sync.write(png));
    expect(decoded.height).toBe(info.height);
    const many = Array.from({ length: 200 }, (_, i) => L(i + 1, `L${i}`));
    expect(drawGantt(raw(many)).info).toMatchObject({ rows: 150, rows_truncated: true });
  });
});

// ---------- the tool with a fake bridge ----------

describe("ae_describe_comp handler", () => {
  const hostResult = raw([L(1, "Title", { role: "text" }), L(2, "BG")], [S(1, "Opacity", 0, 0.5, [0], [100])]);

  it("is one read-only host call (no guard, no write) and returns the description", async () => {
    const { ctx, calls } = fakeAe({ describeRead: [hostResult] });
    const out = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7, from_layer: 1, max_layers: 50 }), ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["describeRead"]);
    expect(calls[0].script).toContain('"comp_id":7');
    expect(out).toMatchObject({ ok: true, read_only: true, truncated: false });
    expect(out.summary).toContain('"Title" fades in');
    expect(out.layers).toBeUndefined();
    expect(out.gantt).toBeUndefined();
  });

  it("returns compact layer rows on request and reports truncation", async () => {
    const { ctx } = fakeAe({ describeRead: [{ ...hostResult, segments_truncated: true }] });
    const out = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7, include_layers: true }), ctx)) as any;
    expect(out.layers).toHaveLength(2);
    expect(out.layers[0]).toMatchObject({ index: 1, name: "Title", role: "text", in: 0, out: 4 });
    expect(out.truncated).toBe(true);
  });

  it("writes the Gantt PNG next to the other frames", async () => {
    const { ctx } = fakeAe({ describeRead: [hostResult] });
    const out = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7, gantt: true }), ctx)) as any;
    expect(out.gantt_error).toBeUndefined();
    expect(fs.existsSync(out.gantt.path)).toBe(true);
    expect(PNG.sync.read(fs.readFileSync(out.gantt.path)).width).toBe(out.gantt.width);
    fs.rmSync(out.gantt.path, { force: true });
  });

  it("surfaces a host failure as an error (nothing was written, so nothing to hide)", async () => {
    const { ctx } = fakeAe({});
    await expect(tool.handler(AeDescribeCompSchema.parse({ comp_id: 7 }), ctx)).rejects.toThrow();
  });
});

// ---------- describe.jsx under node:vm ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 4);
  return { project, comp };
}

const key = (layer: FakeLayer, prop: string, pairs: Array<[number, unknown]>) => {
  const p = layer.transform(prop);
  for (const [t, v] of pairs) p.setValueAtTime(t, v);
  return p;
};

describe("describe.jsx", () => {
  it("reads roles, flags, links, text, sources, markers and keyframed segments", () => {
    const { project, comp } = scene();
    const inner = project.addComp("Inner", 640, 360, 2);
    inner.layers.addNull();
    const { A } = loadHost(project, ["describe.jsx"]);
    const bg = comp.layers.addSolid([0, 0, 0], "BG", 1920, 1080, 1, 4);
    const matte = comp.layers.addShape();
    const pre = comp.layers.add(inner);
    const ctrl = comp.layers.addNull();
    const title = comp.layers.addText("Hello\rWorld");
    pre.parent = ctrl;
    bg.setTrackMatte!(matte, TrackMatteType.ALPHA);
    title.inPoint = 0.5;
    key(title, "Opacity", [[0.5, 0], [1, 100]]);
    key(title, "Scale", [[1, [0, 0, 100]], [2, [100, 100, 100]]]);
    // A key pair with equal values is no change; a single key is not a move.
    key(title, "Rotation", [[0, 5], [1, 5]]);
    key(ctrl, "Position", [[0, [0, 0, 0]], [1, [300, 0, 0]]]);
    title.property("ADBE Marker")!.setValueAtTime(1.5, Object.assign(new MarkerValue("Hit"), { duration: 0.5 }));
    comp.markerProperty.setValueAtTime(2, new MarkerValue("Comp marker"));

    const r = A.describeRead({ comp_id: comp.id });
    expect(r.comp).toMatchObject({ id: comp.id, name: "Main", width: 1920, height: 1080, duration: 4, num_layers: 5 });
    expect(r.range).toMatchObject({ from: 1, to: 5, complete: true, next_from_layer: null });
    const roles = r.layers.map((l: any) => l.role);
    expect(roles).toEqual(["text", "null", "precomp", "shape", "solid"]);
    const t = r.layers[0];
    expect(t).toMatchObject({ in_point: 0.5, text: "Hello / World" });
    expect(r.layers[2].source).toMatchObject({ kind: "comp", id: inner.id, name: "Inner", layers: 1 });
    expect(r.layers[2].parent).toBe(2);
    expect(r.layers[1].is_parent).toBe(true);
    expect(r.layers[3].is_matte).toBe(true);
    expect(r.layers[4].matte).toEqual({ type: "alpha", layer: 4 });
    expect(t.markers).toEqual([{ time: 1.5, comment: "Hit", duration: 0.5 }]);
    expect(r.markers).toMatchObject({ count: 1, list: [{ time: 2, comment: "Comp marker" }] });

    const segs = r.segments.map((s: any) => `${s.layer}:${s.prop}:${s.start}-${s.end}`);
    expect(segs).toEqual(expect.arrayContaining(["1:Opacity:0.5-1", "1:Scale:1-2", "2:Position:0-1"]));
    expect(segs.some((s: string) => s.includes("Rotation"))).toBe(false);
    expect(r.segments.find((s: any) => s.prop === "Scale")).toMatchObject({ from: [0, 0, 100], to: [100, 100, 100] });
    expect(r.nesting.children).toEqual([expect.objectContaining({ id: inner.id, name: "Inner" })]);
  });

  it("finds expressions and the layer names they mention", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["describe.jsx"]);
    comp.layers.addNull();
    const follower = comp.layers.addSolid([1, 1, 1], "Follower", 100, 100, 1, 4);
    const pos = follower.transform("Position");
    pos.expression = 'thisComp.layer("Null 1").transform.position + thisComp.layer(\'Other\').position';
    pos.expressionEnabled = true;
    const off = follower.transform("Opacity");
    off.expression = "wiggle(1, 10)";
    off.expressionEnabled = false;
    const r = A.describeRead({ comp_id: comp.id });
    const f = r.layers.find((l: any) => l.name === "Follower");
    expect(f.expressions).toMatchObject({ count: 1, props: ["Position"], errors: 0 });
    expect(f.expressions.refs).toEqual(["Null 1", "Other"]);
  });

  it("samples between keys for overshoot but never for position paths or expression values", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["describe.jsx"]);
    const l = comp.layers.addSolid([1, 1, 1], "Pop", 100, 100, 1, 4);
    const scale = key(l, "Scale", [[0, [0, 0, 100]], [1, [100, 100, 100]]]);
    scale.valueAtTime = (t: number) => (t > 0.4 && t < 0.8 ? [112, 112, 100] : [50, 50, 100]);
    const pos = key(l, "Position", [[0, [0, 0, 0]], [1, [100, 0, 0]]]);
    pos.valueAtTime = () => [150, 0, 0];
    const opacity = key(l, "Opacity", [[0, 0], [1, 100]]);
    opacity.valueAtTime = () => 130;
    opacity.expression = "value";
    opacity.expressionEnabled = true;
    const r = A.describeRead({ comp_id: comp.id });
    const seg = (p: string) => r.segments.find((s: any) => s.prop === p);
    // The host sends the samples; the server's motion.ts rule decides overshoot.
    expect(seg("Scale").samples).toHaveLength(6);
    expect(overshootFromSamples(seg("Scale"))).toBe(true);
    expect(seg("Scale").match).toBe("ADBE Scale");
    expect(seg("Position").samples).toBeUndefined();
    expect(seg("Opacity").samples).toBeUndefined();
    expect(seg("Opacity").expression).toBe(true);
  });

  it("marks hold keys", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["describe.jsx"]);
    const l = comp.layers.addSolid([1, 1, 1], "Blink", 100, 100, 1, 4);
    const o = key(l, "Opacity", [[1, 0], [1.04, 100]]);
    o.setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD);
    const r = A.describeRead({ comp_id: comp.id });
    expect(r.segments[0]).toMatchObject({ prop: "Opacity", hold: true });
    expect(verbFor(r.segments[0])).toBe("appears");
  });

  it("pages layers, keeping parent and matte flags from the whole comp", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["describe.jsx"]);
    for (let i = 0; i < 5; i++) comp.layers.addSolid([1, 1, 1], `S${i}`, 10, 10, 1, 4);
    const page = A.describeRead({ comp_id: comp.id, from_layer: 2, max_layers: 2 });
    expect(page.layers.map((l: any) => l.index)).toEqual([2, 3]);
    expect(page.range).toMatchObject({ from: 2, to: 3, complete: false, next_from_layer: 4 });
    const last = A.describeRead({ comp_id: comp.id, from_layer: 4, max_layers: 10 });
    expect(last.range).toMatchObject({ to: 5, next_from_layer: null, complete: false });
  });

  it("changes nothing: no undo group, time, markers or keys", () => {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["describe.jsx"]);
    const l = comp.layers.addText("Hi");
    key(l, "Opacity", [[0, 0], [1, 100]]);
    comp.time = 1.25;
    const before = JSON.stringify({ n: comp.numLayers, keys: l.transform("Opacity").numKeys, time: comp.time, workArea: comp.workAreaStart });
    A.describeRead({ comp_id: comp.id });
    expect(JSON.stringify({ n: comp.numLayers, keys: l.transform("Opacity").numKeys, time: comp.time, workArea: comp.workAreaStart })).toBe(before);
    expect(undo).toEqual({ begun: 0, ended: 0 });
  });

  it("refuses an id that is not a comp", () => {
    const { project } = scene();
    const { A } = loadHost(project, ["describe.jsx"]);
    expect(() => A.describeRead({ comp_id: 999999 })).toThrow(/No CompItem/);
  });

  it("works with a nested cycle and old-AE mattes (the layer above)", () => {
    const { project, comp } = scene();
    comp.modernMattes = false;
    const { A } = loadHost(project, ["describe.jsx"]);
    const a = comp.layers.addSolid([1, 1, 1], "Under", 10, 10, 1, 4);
    comp.layers.addShape();
    a.trackMatteType = TrackMatteType.LUMA;
    const self = comp.layers.add(comp as FakeComp);
    expect(self.source).toBe(comp);
    const r = A.describeRead({ comp_id: comp.id });
    expect(r.nesting.children[0]).toMatchObject({ id: comp.id, cycle: true });
    const under = r.layers.find((l: any) => l.name === "Under");
    expect(under.matte).toEqual({ type: "luma", layer: under.index - 1 });
    expect(r.layers[under.index - 2].is_matte).toBe(true);
  });
});

// ---------- review fixes ----------

describe("review fixes", () => {
  const L = (index: number, name: string, extra: Partial<DescribeLayer> = {}): DescribeLayer => ({
    index,
    id: 100 + index,
    name,
    role: "solid",
    enabled: true,
    in_point: 0,
    out_point: 4,
    parent: null,
    matte: null,
    is_parent: false,
    is_matte: false,
    expressions: { count: 0, props: [], refs: [], errors: 0 },
    animated: { props: 0, keys: 0 },
    markers: [],
    ...extra,
  });

  const S = (layer: number, prop: string, start: number, end: number, from: number[], to: number[], extra: Partial<DescribeSegment> = {}): DescribeSegment => ({
    layer,
    prop,
    kind: from.length > 1 ? "3d" : "1d",
    start,
    end,
    from,
    to,
    ...extra,
  });

  function raw(layers: DescribeLayer[], segments: DescribeSegment[] = [], extra: Partial<DescribeRaw> = {}, duration = 4): DescribeRaw {
    return {
      comp: { id: 7, name: "Main", width: 1920, height: 1080, pixel_aspect: 1, frame_rate: 25, duration, work_area: { start: 0, duration }, num_layers: layers.length },
      range: { from: 1, to: layers.length, complete: true, next_from_layer: null, layers_over_cap: false },
      layers,
      segments,
      segments_truncated: false,
      walk_truncated: false,
      markers: { count: 0, list: [], truncated: false },
      nesting: { id: 7, name: "Main", layers: layers.length, duration, children: [] },
      nesting_truncated: false,
      properties_visited: 10,
      ...extra,
    };
  }

  describe("beats cluster on start times", () => {
    const layers = [L(1, "BG", { out_point: 10 }), L(2, "Title", { role: "text", out_point: 10 }), L(3, "Logo", { role: "shape", out_point: 10 }), L(4, "CTA", { role: "text", out_point: 10 })];
    const segs = [
      S(1, "Scale", 0, 10, [100, 100, 100], [120, 120, 100]),
      S(2, "Opacity", 0.5, 1, [0], [100]),
      S(3, "Scale", 2, 2.5, [0, 0, 100], [100, 100, 100]),
      S(4, "Opacity", 4, 4.5, [0], [100]),
    ];

    it("a slow background move does not swallow the short moves after it", () => {
      const beats = buildBeats(buildActions(raw(layers, segs, {}, 10)));
      expect(beats.length).toBeGreaterThanOrEqual(3);
      expect(beats.map((b) => b.start)).toEqual([0, 0.5, 2, 4]);
    });

    it("lists moves that run most of the comp as throughout, not as a beat", () => {
      const d = describeFromRaw(raw(layers, segs, {}, 10));
      expect(d.beats.map((b) => b.text)).toEqual(['"Title" fades in', '"Logo" scales up', '"CTA" fades in']);
      expect(d.throughout).toEqual(['"BG" scales up (0.0-10.0 s)']);
      expect(d.summary).toContain("Throughout");
    });

    it("keeps a staggered entrance together but cuts it at the span limit", () => {
      const many = Array.from({ length: 12 }, (_, i) => L(i + 1, `L${i + 1}`));
      const staggered = many.map((l, i) => S(l.index, "Opacity", i * 0.2, i * 0.2 + 0.3, [0], [100]));
      const beats = buildBeats(buildActions(raw(many, staggered)));
      expect(beats.length).toBeGreaterThan(1);
      expect(beats[0].actions).toBeGreaterThan(3);
    });
  });

  describe("verbs come from matchNames", () => {
    it("names a localized Transform move", () => {
      const loc = (match: string, prop: string, from: number[], to: number[]) => S(1, prop, 0, 1, from, to, { match });
      expect(verbFor(loc("ADBE Opacity", "Deckkraft", [0], [100]))).toBe("fades in");
      expect(verbFor(loc("ADBE Scale", "Skalierung", [0, 0, 100], [100, 100, 100]))).toBe("scales up");
      expect(verbFor(loc("ADBE Position", "Position", [0, 0], [100, 0]))).toBe("slides right");
      expect(verbFor(loc("ADBE Position_0", "X-Position", [100], [0]))).toBe("slides left");
      expect(verbFor(loc("ADBE Position_1", "Y-Position", [0], [50]))).toBe("moves down");
      expect(verbFor(loc("ADBE Rotate Z", "Drehung", [0], [90]))).toBe("rotates");
      expect(verbFor(loc("ADBE Orientation", "Ausrichtung", [0, 0, 0], [0, 90, 0]))).toBe("rotates");
      expect(verbFor(loc("ADBE Anchor Point", "Ankerpunkt", [0, 0], [10, 0]))).toBe("shifts its anchor point");
    });

    it("does not take an effect's Opacity-named property for the layer's opacity", () => {
      expect(verbFor(S(1, "Opacity", 0, 1, [0], [100], { match: "ADBE Fill-0007" }))).toBe("animates Opacity");
    });

    it("describes sampled expression motion", () => {
      const seg = S(1, "Position", 0, 4, [100, 100], [140, 90], { match: "ADBE Position", expression: true, sampled: true });
      expect(verbFor(seg)).toBe("moves (expression)");
      const d = describeFromRaw(raw([L(1, "Wobble")], [seg]));
      expect(d.throughout.length + d.beats.length).toBe(1);
    });
  });

  describe("overshootFromSamples", () => {
    it("agrees with motion.ts: values outside the keys' range", () => {
      const base = S(1, "Scale", 0, 1, [0], [100]);
      expect(overshootFromSamples({ ...base, samples: [[10], [40], [80], [105], [101], [100]] })).toBe(true);
      expect(overshootFromSamples({ ...base, samples: [[10], [20], [40], [60], [80], [95]] })).toBe(false);
      expect(overshootFromSamples({ ...base, samples: [[-5], [20], [40], [60], [80], [95]] })).toBe(true);
      expect(overshootFromSamples(base)).toBe(false);
    });

    it("turns up as 'with overshoot' in the actions", () => {
      const seg = S(1, "Scale", 0, 1, [0], [100], { match: "ADBE Scale", samples: [[10], [40], [80], [105], [101], [100]] });
      expect(buildActions(raw([L(1, "Pop")], [seg]))[0].verb).toBe("scales up with overshoot");
    });
  });

  describe("unused_layers has fewer false positives", () => {
    const unusedOf = (r: DescribeRaw) => findConcerns(r).find((k) => k.kind === "unused_layers");

    it("does not call a layer with audio on unused", () => {
      const c = findConcerns(raw([L(1, "Music", { enabled: false, audio: true, role: "footage" }), L(2, "Ghost", { enabled: false })]));
      expect(c.find((k) => k.kind === "unused_layers")!.layers).toEqual([{ index: 2, name: "Ghost" }]);
      expect(c.find((k) => k.kind === "video_off_audio_on")!.layers).toEqual([{ index: 1, name: "Music" }]);
    });

    it("does not judge when the property scan was cut short", () => {
      const r = raw([L(1, "Ghost", { enabled: false })], [], { walk_truncated: true });
      expect(unusedOf(r)).toBeUndefined();
      expect(findConcerns(r).find((k) => k.kind === "switched_off")!.message).toContain("property scan hit its cap");
    });

    it("does not judge when a layer's expression refs were cut", () => {
      const r = raw([L(1, "Driver", { expressions: { count: 1, props: ["Position"], refs: [], errors: 0, refs_truncated: true } }), L(2, "Ghost", { enabled: false })]);
      expect(unusedOf(r)).toBeUndefined();
    });

    it("does not judge when the comp is over the cross-reference cap", () => {
      const r = raw([L(1, "Ghost", { enabled: false })], [], { range: { from: 1, to: 1, complete: true, next_from_layer: null, layers_over_cap: true } });
      expect(unusedOf(r)).toBeUndefined();
    });

    it("treats a layer picked by an effect's layer parameter as used", () => {
      const c = findConcerns(raw([L(1, "Map", { enabled: false, is_referenced: true }), L(2, "Ghost", { enabled: false })]));
      expect(c.find((k) => k.kind === "unused_layers")!.layers).toEqual([{ index: 2, name: "Ghost" }]);
      expect(c.find((k) => k.kind === "switched_off")!.layers).toEqual([{ index: 1, name: "Map" }]);
    });
  });

  describe("truncation flags", () => {
    it("flags more than 50 beats", () => {
      const many = Array.from({ length: 60 }, (_, i) => L(i + 1, `L${i + 1}`));
      const segs = many.map((l, i) => S(l.index, "Opacity", i * 2, i * 2 + 0.5, [0], [100]));
      const d = describeFromRaw(raw(many, segs, {}, 200));
      expect(d.beats).toHaveLength(50);
      expect(d.beats_truncated).toBe(true);
      expect(d.summary).toContain("More than 50 beats");
    });

    it("the tool's truncated flag covers the stack and the Gantt rows", async () => {
      const roles = ["text", "shape"];
      const many = Array.from({ length: 160 }, (_, i) => L(i + 1, `L${i + 1}`, { role: roles[i % 2] }));
      const { ctx } = fakeAe({ describeRead: [raw(many, [], {}, 400)] });
      const out = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7 }), ctx)) as any;
      expect(out.stack_truncated).toBe(true);
      expect(out.truncated).toBe(true);

      const { ctx: ctx2 } = fakeAe({ describeRead: [raw(many.slice(0, 2))] });
      const g = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7, gantt: true }), ctx2)) as any;
      expect(g.truncated).toBe(false);
      fs.rmSync(g.gantt.path, { force: true });

      const oneRole = Array.from({ length: 160 }, (_, i) => L(i + 1, `L${i + 1}`));
      const { ctx: ctx3 } = fakeAe({ describeRead: [raw(oneRole)] });
      const g3 = (await tool.handler(AeDescribeCompSchema.parse({ comp_id: 7, gantt: true }), ctx3)) as any;
      expect(g3.gantt.rows_truncated).toBe(true);
      expect(g3.truncated).toBe(true);
      fs.rmSync(g3.gantt.path, { force: true });
    });
  });

  // ---------- describe.jsx under node:vm ----------

  function scene() {
    const project = new FakeProject();
    const comp = project.addComp("Main", 1920, 1080, 4);
    return { project, comp };
  }

  const key = (layer: FakeLayer, prop: string, pairs: Array<[number, unknown]>) => {
    const p = layer.transform(prop);
    for (const [t, v] of pairs) p.setValueAtTime(t, v);
    return p;
  };

  describe("describe.jsx review fixes", () => {
    it("samples expression-driven motion and reports it as an expression segment", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const l = comp.layers.addSolid([1, 1, 1], "Wobble", 100, 100, 1, 4);
      const pos = l.transform("Position");
      pos.valueAtTime = (t: number) => [100 + 30 * Math.sin(t * 5), 100, 0];
      pos.expression = "wiggle(2, 30)";
      pos.expressionEnabled = true;
      const still = l.transform("Opacity");
      still.valueAtTime = () => 100;
      still.expression = "value";
      still.expressionEnabled = true;
      const r = A.describeRead({ comp_id: comp.id });
      const segs = r.segments.filter((s: any) => s.layer === 1);
      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({ prop: "Position", match: "ADBE Position", expression: true, sampled: true, start: 0, end: 4 });
      expect(verbFor(segs[0])).toBe("moves (expression)");
      expect(describeFromRaw(r).throughout[0]).toContain("moves (expression)");
    });

    it("samples the tail past the last key for loopOut style expressions", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const l = comp.layers.addSolid([1, 1, 1], "Loop", 100, 100, 1, 4);
      const rot = key(l, "Rotation", [[0, 0], [1, 90]]);
      rot.valueAtTime = (t: number) => (t <= 1 ? t * 90 : 90 + (t - 1) * 90);
      rot.expression = "loopOut('continue')";
      rot.expressionEnabled = true;
      const r = A.describeRead({ comp_id: comp.id });
      const sampled = r.segments.filter((s: any) => s.sampled);
      expect(sampled).toHaveLength(1);
      expect(sampled[0]).toMatchObject({ start: 1, end: 4 });
      expect(r.segments.filter((s: any) => !s.sampled)).toHaveLength(1);
    });

    it("reads localized Transform groups by matchName", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const l = comp.layers.addSolid([1, 1, 1], "Logo", 100, 100, 1, 4);
      const grp = l.group.property("ADBE Transform Group") as FakeGroup;
      key(l, "ADBE Opacity", [[0, 0], [1, 100]]);
      grp.name = "Transformieren";
      l.transform("ADBE Opacity").name = "Deckkraft";
      const r = A.describeRead({ comp_id: comp.id });
      expect(r.segments[0]).toMatchObject({ prop: "Deckkraft", match: "ADBE Opacity" });
      expect(verbFor(r.segments[0])).toBe("fades in");
    });

    it("marks layers that an effect's layer parameter picks", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const map = comp.layers.addSolid([1, 1, 1], "Map", 100, 100, 1, 4);
      map.enabled = false;
      const target = comp.layers.addSolid([1, 1, 1], "Target", 100, 100, 1, 4);
      const fx = target.group.property("ADBE Effect Parade") as FakeGroup;
      const dm = new FakeGroup("Displacement Map", "ADBE Displacement Map", [new FakeProperty("Displacement Map Layer", "ADBE Displacement Map-0001", PropertyValueType.LAYER_INDEX, map.index)]);
      fx.props.push(dm);
      dm.parentProperty = fx;
      const r = A.describeRead({ comp_id: comp.id });
      expect(r.layers.find((x: any) => x.name === "Map").is_referenced).toBe(true);
      expect(r.layers.find((x: any) => x.name === "Target").is_referenced).toBeUndefined();
      expect(findConcerns(r).find((k) => k.kind === "unused_layers")).toBeUndefined();
    });

    it("flags expression refs that did not fit", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const l = comp.layers.addSolid([1, 1, 1], "Many", 100, 100, 1, 4);
      const pos = l.transform("Position");
      pos.expression = Array.from({ length: 60 }, (_, i) => `thisComp.layer("N${i}")`).join(" + ");
      pos.expressionEnabled = true;
      const r = A.describeRead({ comp_id: comp.id });
      expect(r.layers[0].expressions.refs).toHaveLength(50);
      expect(r.layers[0].expressions.refs_truncated).toBe(true);
    });

    it("pages past layer 500 and refuses a start past the last layer", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      for (let i = 0; i < 520; i++) comp.layers.addSolid([1, 1, 1], `S${i}`, 10, 10, 1, 4);
      const page = A.describeRead({ comp_id: comp.id, from_layer: 501, max_layers: 100 });
      expect(page.layers[0].index).toBe(501);
      expect(page.range).toMatchObject({ from: 501, to: 520, complete: false, next_from_layer: null, layers_over_cap: false });
      expect(() => A.describeRead({ comp_id: comp.id, from_layer: 521 })).toThrow(/past the last layer/);
      const first = A.describeRead({ comp_id: comp.id, max_layers: 500 });
      expect(first.range).toMatchObject({ to: 500, next_from_layer: 501 });
    });

    it("still reads an empty comp", () => {
      const { project, comp } = scene();
      const { A } = loadHost(project, ["describe.jsx"]);
      const r = A.describeRead({ comp_id: comp.id });
      expect(r.layers).toEqual([]);
      expect(r.range.complete).toBe(true);
    });
  });
});
