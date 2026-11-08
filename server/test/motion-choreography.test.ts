import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { resolveMotionSpec, type MotionSpec } from "../src/motion-spec.js";
import {
  CHOREOGRAPHY_CHECKS,
  reviewChoreography,
  type ChoreoProp,
  type LayerInfo,
} from "../src/tools/ext/choreography.js";
import {
  AeMotionReviewSchema,
  analyzeMotion,
  motionTools,
  reviewProperty,
  sampleSpeeds,
  type PropertyKey,
  type PropertySamples,
} from "../src/tools/ext/motion.js";

const FPS = 25;
const COMP = { width: 1920, height: 1080, fps: FPS };

type Shape = "inout" | "easein" | "easeout" | "linear";
const SHAPES: Record<Shape, (u: number) => number> = {
  inout: (u) => u * u * (3 - 2 * u),
  easein: (u) => u * u * u,
  easeout: (u) => 1 - (1 - u) ** 3,
  linear: (u) => u,
};

interface PropOpts {
  layer: { index: number; id: number; name: string };
  match: "ADBE Position" | "ADBE Opacity" | "ADBE Scale" | "ADBE Slider Control-0001";
  /** [time, value] per key; one shape per segment. */
  keys: Array<[number, number]>;
  shapes?: Shape[];
  /** Added to the value mid-segment as a bump of this fraction of the span (overshoot). */
  overshoot?: number;
  effect_name?: string;
}

function prop(o: PropOpts): ChoreoProp & { path: Array<string | number> } {
  const shapes = o.shapes ?? o.keys.slice(1).map(() => "inout" as Shape);
  const spatial = o.match === "ADBE Position";
  const twoD = o.match === "ADBE Position" || o.match === "ADBE Scale";
  const vec = (v: number) => (twoD ? [v, 0] : [v]);
  const keys: PropertyKey[] = o.keys.map(([time, v], i) => {
    const prevShape = i > 0 ? shapes[i - 1] : "inout";
    const nextShape = i < shapes.length ? shapes[i] : "inout";
    const k: PropertyKey = { index: i + 1, time, value: vec(v), in_interp: prevShape === "linear" ? "linear" : "bezier", out_interp: nextShape === "linear" ? "linear" : "bezier" };
    // Easy Ease is 33 % influence at zero speed; an ease-in-only curve is slow out, fast in; the reverse for ease out.
    const out = nextShape === "inout" ? 33 : nextShape === "easein" ? 80 : nextShape === "easeout" ? 5 : 0;
    const inn = prevShape === "inout" ? 33 : prevShape === "easein" ? 5 : prevShape === "easeout" ? 80 : 0;
    k.out_ease = [{ speed: nextShape === "easeout" || nextShape === "linear" ? 50 : 0, influence: out }];
    k.in_ease = [{ speed: prevShape === "easein" || prevShape === "linear" ? 50 : 0, influence: inn }];
    return k;
  });
  const t0 = o.keys[0][0];
  const t1 = o.keys[o.keys.length - 1][0];
  const times: number[] = [];
  for (let i = 0; t0 + i / FPS <= t1 + 1e-9; i++) times.push(Math.round((t0 + i / FPS) * 1e6) / 1e6);
  const values = times.map((t) => {
    let seg = o.keys.length - 2;
    for (let i = 0; i + 1 < o.keys.length; i++) if (t <= o.keys[i + 1][0] + 1e-9) { seg = i; break; }
    const [ta, va] = o.keys[seg];
    const [tb, vb] = o.keys[seg + 1];
    const u = Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
    const bump = o.overshoot ? o.overshoot * (vb - va) * Math.sin(Math.PI * u) * (u > 0.5 ? 1 : 0) : 0;
    return vec(va + (vb - va) * SHAPES[shapes[seg]](u) + bump);
  });
  const samples: PropertySamples = {
    comp: { id: 7, name: "Shot", fps: FPS },
    layer: o.layer,
    property: {
      name: o.match === "ADBE Position" ? "Position" : o.match === "ADBE Opacity" ? "Opacity" : o.match === "ADBE Scale" ? "Scale" : "Slider",
      matchName: o.match,
      value_type: spatial ? "TwoD_SPATIAL" : twoD ? "TwoD" : "OneD",
      spatial,
      dimensions: values[0].length,
      num_keys: keys.length,
      keys_truncated: false,
      samples_capped: false,
      expression: false,
    },
    start: t0,
    end: t1,
    step: 1 / FPS,
    times,
    values,
    keys,
  };
  const analysis = analyzeMotion(samples, sampleSpeeds(samples));
  const p = o.match === "ADBE Slider Control-0001" ? ["ADBE Effect Parade", 1, "ADBE Slider Control-0001"] : ["ADBE Transform Group", o.match];
  return { path: p, samples, analysis, effect_name: o.effect_name };
}

const L = (index: number, name = `L${index}`) => ({ index, id: 100 + index, name });
const info = (index: number, extra: Partial<LayerInfo> = {}): LayerInfo => ({
  index,
  id: 100 + index,
  name: `L${index}`,
  kind: "shape",
  in_point: 0,
  out_point: 10,
  width: 400,
  height: 200,
  parent: null,
  transform_expressions: [],
  ...extra,
});
const spec = (s: MotionSpec = {}) => resolveMotionSpec(s);
const run = (props: ChoreoProp[], layers: LayerInfo[], s = spec(), checks = CHOREOGRAPHY_CHECKS) => reviewChoreography({ comp: COMP, layers, props }, s, checks);
const kinds = (f: Array<{ kind: string }>) => f.map((x) => x.kind);
const pos = (index: number, t0: number, t1: number, shape: Shape = "inout") => prop({ layer: L(index), match: "ADBE Position", keys: [[t0, 0], [t1, 300]], shapes: [shape] });

describe("choreography: ease monotony", () => {
  const four = [0, 1, 2, 3].map((i) => pos(i + 1, 1 + i, 1.5 + i));
  const layers = [1, 2, 3, 4].map((i) => info(i, { in_point: i }));

  it("flags more than max_same_ease tweens with one ease and duration, naming the layers", () => {
    const f = run(four, layers, spec(), ["ease_monotony"]);
    expect(kinds(f)).toEqual(["ease_monotony"]);
    expect(f[0].severity).toBe("low");
    expect(f[0].message).toMatch(/4 tweens share one ease.*0\.5s.*L1 > Position.*L4 > Position/);
  });
  it("counts a stagger (siblings offset by a beat, one shared ease) as one gesture, not monotony", () => {
    const staggered = [0, 1, 2, 3].map((i) => pos(i + 1, 1 + i * 0.08, 1.5 + i * 0.08));
    const near = [1, 2, 3, 4].map((i) => info(i, { in_point: 0 }));
    expect(run(staggered, near, spec(), ["ease_monotony"])).toHaveLength(0);
    // The same four, each a second apart, are four separate identical gestures.
    expect(run(four, layers, spec(), ["ease_monotony"])).toHaveLength(1);
  });
  it("does not flag when the durations differ", () => {
    const varied = [pos(1, 1, 1.3), pos(2, 2, 2.5), pos(3, 3, 3.8), pos(4, 4, 4.3)];
    expect(kinds(run(varied, layers, spec(), ["ease_monotony"]))).toEqual([]);
  });
  it("does not flag when the eases differ", () => {
    const mixed = [pos(1, 1, 1.5), pos(2, 2, 2.5, "easeout"), pos(3, 3, 3.5, "easein"), pos(4, 4, 4.5, "inout")];
    expect(run(mixed, layers, spec(), ["ease_monotony"])).toHaveLength(0);
  });
  it("counts one move per layer: position and opacity together are one tween", () => {
    const pairs = [1, 2].flatMap((i) => [pos(i, i, i + 0.5), prop({ layer: L(i), match: "ADBE Opacity", keys: [[i, 0], [i + 0.5, 100]] })]);
    expect(run(pairs, layers.slice(0, 2), spec(), ["ease_monotony"])).toHaveLength(0);
  });
  it("follows max_same_ease from the brief, and is skipped for the handmade register", () => {
    expect(run(four, layers, spec({ max_same_ease: 4 }), ["ease_monotony"])).toHaveLength(0);
    expect(run(four, layers, spec({ max_same_ease: 3 }), ["ease_monotony"])).toHaveLength(1);
    expect(run(four, layers, spec({ register: "handmade" }), ["ease_monotony"])).toHaveLength(0);
  });
});

describe("choreography: entrance and exit direction", () => {
  const entering = (shape: Shape) => run([pos(1, 0.2, 0.8, shape)], [info(1)], spec(), ["direction"]);
  const leaving = (shape: Shape) => run([pos(1, 9.4, 10, shape)], [info(1, { out_point: 10 })], spec(), ["direction"]);

  it("flags an entrance that eases in only, with the heuristic explained", () => {
    const f = entering("easein");
    expect(kinds(f)).toEqual(["wrong_direction"]);
    expect(f[0].severity).toBe("medium");
    expect(f[0].message).toMatch(/enters.*easing in only.*within 0\.5 s of its in point.*decelerate/);
  });
  it("leaves a decelerating or symmetric entrance alone", () => {
    expect(entering("easeout")).toHaveLength(0);
    expect(entering("inout")).toHaveLength(0);
  });
  it("flags an exit that eases out only, and not one that accelerates away", () => {
    const f = leaving("easeout");
    expect(kinds(f)).toEqual(["wrong_direction"]);
    expect(f[0].message).toMatch(/exits.*easing out only.*accelerate away/);
    expect(leaving("easein")).toHaveLength(0);
  });
  it("does not call a mid-layer move an entrance or exit", () => {
    expect(run([pos(1, 4, 4.6, "easein")], [info(1)], spec(), ["direction"])).toHaveLength(0);
  });
});

describe("choreography: exit versus entrance duration", () => {
  const layer = (exitDur: number) => {
    const p = [pos(1, 0, 0.6, "easeout"), pos(1, 9.9 - exitDur, 9.9, "easein")];
    // two tweens on one property: merge into one prop with three keys is not needed; two props are fine
    return run(p, [info(1, { out_point: 10 })], spec(), ["exit_ratio"]);
  };
  it("accepts an exit inside the spec's ratio", () => {
    expect(layer(0.32)).toHaveLength(0); // 0.53x
  });
  it("flags an exit as long as its entrance as medium", () => {
    const f = layer(0.6);
    expect(kinds(f)).toEqual(["exit_ratio"]);
    expect(f[0].severity).toBe("medium");
    expect(f[0].message).toMatch(/1x.*wants 0\.5x to 0\.6x/);
  });
  it("flags a slightly long exit low and an abrupt one info", () => {
    expect(layer(0.48)[0].severity).toBe("low");
    expect(layer(0.12)[0].severity).toBe("info");
  });
  it("follows exit_ratio from the brief", () => {
    const f = run([pos(1, 0, 0.6, "easeout"), pos(1, 9.3, 9.9, "easein")], [info(1)], spec({ exit_ratio: { min: 0.9, max: 1.1 } }), ["exit_ratio"]);
    expect(f).toHaveLength(0);
  });
});

describe("choreography: first move on the layer's first frame", () => {
  it("is an info finding when the tween starts at the in point", () => {
    const f = run([pos(1, 2, 2.6)], [info(1, { in_point: 2 })], spec(), ["frame_zero"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "first_frame_move", severity: "info" });
  });
  it("ignores a move that starts a few frames in", () => {
    expect(run([pos(1, 2.2, 2.8)], [info(1, { in_point: 2 })], spec(), ["frame_zero"])).toHaveLength(0);
  });
});

describe("choreography: overshoot by property type", () => {
  const review = (p: ReturnType<typeof prop>, s = spec()) =>
    reviewProperty(p.samples, p.analysis, sampleSpeeds(p.samples), p.path, { comp_id: 7, project_path: "x.aep" }, undefined, { spec: s, effectName: p.effect_name });
  const opacity = prop({ layer: L(1), match: "ADBE Opacity", keys: [[0, 0], [1, 100]], overshoot: 0.12 });
  const position = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 0], [1, 300]], overshoot: 0.3 });

  it("raises opacity overshoot from info to medium", () => {
    const f = review(opacity).filter((x) => x.kind === "overshoot");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].message).toMatch(/Opacity never overshoots/);
  });
  it("raises a count slider's overshoot, but not a plain slider's", () => {
    const counter = prop({ layer: L(1), match: "ADBE Slider Control-0001", keys: [[0, 0], [1, 100]], overshoot: 0.1, effect_name: "Count" });
    expect(review(counter).find((x) => x.kind === "overshoot")?.severity).toBe("medium");
    const other = prop({ layer: L(1), match: "ADBE Slider Control-0001", keys: [[0, 0], [1, 100]], overshoot: 0.1, effect_name: "Blur radius" });
    expect(review(other).find((x) => x.kind === "overshoot")?.severity).toBe("info");
  });
  it("makes position overshoot medium where the register allows none", () => {
    expect(review(position, spec({ register: "brand_film" })).find((x) => x.kind === "overshoot")?.severity).toBe("medium");
    expect(review(position, spec({ register: "ui_micro", overshoot_max_pct: 0 })).find((x) => x.kind === "overshoot")?.severity).toBe("medium");
  });
  it("keeps it info inside the budget and low over a non-zero budget", () => {
    const within = review(position, spec({ register: "energetic" })).find((x) => x.kind === "overshoot");
    expect(within?.severity).toBe("info");
    expect(within?.message).toMatch(/inside the energetic register's 25% budget/);
    const big = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 0], [1, 300]], overshoot: 0.3 });
    const over = review(big, spec({ register: "ui_micro" })).find((x) => x.kind === "overshoot");
    expect(over?.severity).toBe("low");
    expect(over?.message).toMatch(/allows 5%/);
  });
  it("catches overshoot keyed by hand (0 -> 115 -> 100) against the register", () => {
    const keyed = prop({ layer: L(1), match: "ADBE Scale", keys: [[0, 0], [0.4, 115], [0.7, 100]] });
    const f = review(keyed, spec({ register: "brand_film" })).filter((x) => x.kind === "overshoot");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "medium", keys: [2] });
    expect(f[0].message).toMatch(/keyed 15(\.0+)? past where it settles at key 2/);
    expect(f[0].message).toMatch(/15% of the move/);
    const lenient = review(keyed, spec({ register: "energetic" })).find((x) => x.kind === "overshoot");
    expect(lenient?.severity).toBe("info");
  });
  it("reports a uniform scale overshoot once, not per dimension", () => {
    const keyed = prop({ layer: L(1), match: "ADBE Scale", keys: [[0, 0], [0.4, 115], [0.7, 100]] });
    for (const k of keyed.samples.keys) k.value = [k.value[0], k.value[0]];
    keyed.samples.values = keyed.samples.values.map((v) => [v[0], v[0]]);
    const f = review(keyed, spec({ register: "brand_film" })).filter((x) => x.kind === "overshoot");
    expect(f).toHaveLength(1);
    expect(f[0].message).not.toMatch(/dimension/);
  });
  it("leaves out-and-back moves and holds alone", () => {
    const back = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 0], [1, 300], [2, 0]] });
    expect(review(back, spec({ register: "brand_film" })).filter((x) => x.kind === "overshoot")).toHaveLength(0);
    const steps = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 0], [1, 300], [2, 300], [3, 500]] });
    expect(review(steps, spec({ register: "brand_film" })).filter((x) => x.kind === "overshoot")).toHaveLength(0);
  });
  it("makes a keyed opacity dip back medium in any register", () => {
    const dip = prop({ layer: L(1), match: "ADBE Opacity", keys: [[0, 0], [0.3, 100], [0.5, 80]] });
    const f = review(dip, spec({ register: "energetic" })).find((x) => x.kind === "overshoot");
    expect(f?.severity).toBe("medium");
    expect(f?.message).toMatch(/Opacity never overshoots/);
  });
  it("is the old info level without a spec", () => {
    const f = reviewProperty(opacity.samples, opacity.analysis, sampleSpeeds(opacity.samples), opacity.path, { comp_id: 7, project_path: "x.aep" });
    expect(f.find((x) => x.kind === "overshoot")?.severity).toBe("info");
  });
});

describe("choreography: stagger", () => {
  const sibs = (starts: number[], extra: Partial<LayerInfo> = {}) => ({
    props: starts.map((s, i) => pos(i + 1, s, s + 0.4)),
    layers: starts.map((_s, i) => info(i + 1, extra)),
  });
  it("accepts an even stagger inside the budget", () => {
    const { props, layers } = sibs([1, 1.1, 1.2, 1.3]);
    expect(run(props, layers, spec(), ["stagger"])).toHaveLength(0);
  });
  it("flags uneven offsets", () => {
    const { props, layers } = sibs([1, 1.05, 1.25, 1.3]);
    const f = run(props, layers, spec(), ["stagger"]);
    expect(kinds(f)).toEqual(["stagger_irregular"]);
    expect(f[0].message).toMatch(/50 ms, 200 ms, 50 ms/);
  });
  it("flags a spread over group_total_max, per register", () => {
    const { props, layers } = sibs([1, 1.4, 1.8, 2.2]); // 1.2 s
    const f = run(props, layers, spec(), ["stagger"]);
    expect(kinds(f)).toEqual(["stagger_spread"]);
    expect(f[0].severity).toBe("medium"); // 2x the 0.6 s budget
    expect(run(props, layers, spec({ register: "handmade" }), ["stagger"])).toHaveLength(0);
    expect(kinds(run(props, layers, spec({ stagger_ms: { group_total_max: 1000 } }), ["stagger"]))).toEqual(["stagger_spread"]);
  });
  it("ignores groups under three, layers that start together, and layers apart in the stack", () => {
    const two = sibs([1, 1.8]);
    expect(run(two.props, two.layers, spec(), ["stagger"])).toHaveLength(0);
    const together = sibs([1, 1, 1]);
    expect(run(together.props, together.layers, spec(), ["stagger"])).toHaveLength(0);
    const apart = [1, 3, 5].map((i, k) => pos(i, 1 + k * 0.7, 1.4 + k * 0.7));
    expect(run(apart, [1, 3, 5].map((i) => info(i)), spec(), ["stagger"])).toHaveLength(0);
  });
});

describe("choreography: density", () => {
  const six = [1, 2, 3, 4, 5, 6].map((i) => info(i));
  it("flags more than a third of a sibling group moving at one moment", () => {
    const props = [1, 2, 3].map((i) => pos(i, 2, 2.6)); // 3 of 6
    const f = run(props, six, spec(), ["density"]);
    expect(kinds(f)).toEqual(["density"]);
    expect(f[0].message).toMatch(/3 of 6 sibling layers/);
  });
  it("accepts a third or less", () => {
    const props = [1, 2].map((i) => pos(i, 2, 2.6)); // 2 of 6 = exactly a third
    expect(run(props, six, spec(), ["density"])).toHaveLength(0);
  });
  it("ignores groups under three, and does not count a background", () => {
    const props = [1, 2].map((i) => pos(i, 2, 2.6));
    expect(run(props, [info(1), info(2)], spec(), ["density"])).toHaveLength(0);
    const withBg = [info(1), info(2), info(3, { name: "Background", width: 1920, height: 1080 })];
    expect(run(props, withBg, spec(), ["density"])).toHaveLength(0);
  });
  it("counts only layers on screen at that moment", () => {
    const layers = [1, 2, 3, 4, 5, 6].map((i) => info(i, { in_point: i <= 3 ? 0 : 5 }));
    const props = [1, 2].map((i) => pos(i, 2, 2.6)); // 2 of the 3 on screen
    expect(kinds(run(props, layers, spec(), ["density"]))).toEqual(["density"]);
  });
});

describe("choreography: review fixes", () => {
  const six = [1, 2, 3, 4, 5, 6];
  it("does not flag a well-made stagger as density, but still flags unrelated simultaneous moves", () => {
    const staggered = six.map((i) => pos(i, 0.5 + (i - 1) * 0.1, 1.2 + (i - 1) * 0.1, "easeout"));
    const layers = six.map((i) => info(i));
    expect(run(staggered, layers, spec(), ["density"])).toHaveLength(0);
    const together = six.map((i) => pos(i, 0.5, 1.2, "easeout"));
    expect(kinds(run(together, layers, spec(), ["density"]))).toEqual(["density"]);
  });
  it("counts layers by id, so six layers all named Card are six elements", () => {
    const props = six.map((i) => {
      const p = pos(i, 0.5, 1.2, "easeout");
      p.samples.layer.name = "Card";
      return p;
    });
    const layers = six.map((i) => info(i, { name: "Card" }));
    const f = run(props, layers, spec(), ["density"]);
    expect(kinds(f)).toEqual(["density"]);
    expect(f[0].message).toMatch(/6 of 6 sibling layers.*Card, Card/);
  });
  it("skips cameras, lights and nulls in direction, exit ratio and first-frame checks", () => {
    const push = [pos(1, 0, 2, "easein")];
    for (const kind of ["camera", "light", "null"] as const) {
      expect(run(push, [info(1, { kind })], spec(), ["direction", "exit_ratio", "frame_zero"])).toHaveLength(0);
    }
    expect(run(push, [info(1)], spec(), ["direction", "frame_zero"]).length).toBeGreaterThan(0);
  });
  it("treats BG, Background and Card BG as backgrounds but not Back button", () => {
    const props = [pos(1, 2, 2.6), pos(2, 2, 2.6)];
    const mk = (name: string) => [info(1), info(2), info(3, { name, width: 100, height: 100 })];
    const names = ["BG", "Background", "BG plate", "Card BG", "Backdrop shape"];
    for (const n of names) expect(run(props, mk(n), spec(), ["density"])).toHaveLength(0);
    // With the third layer counted, 2 of 3 are moving.
    expect(kinds(run(props, mk("Back button"), spec(), ["density"]))).toEqual(["density"]);
  });
  it("matches counting words on the effect and property name, not the layer name", () => {
    const onStats = prop({ layer: L(1, "Stats panel"), match: "ADBE Slider Control-0001", keys: [[0, 0], [1, 100]], overshoot: 0.1, effect_name: "Blur radius" });
    const f = reviewProperty(onStats.samples, onStats.analysis, sampleSpeeds(onStats.samples), onStats.path, { comp_id: 7, project_path: "x.aep" }, undefined, { spec: spec(), effectName: onStats.effect_name });
    expect(f.find((x) => x.kind === "overshoot")?.severity).toBe("info");
  });
  describe("overshoot settle tolerance", () => {
    const sev = (frac: number, s = spec()) => {
      const p = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 0], [1, 300]], overshoot: frac });
      return reviewProperty(p.samples, p.analysis, sampleSpeeds(p.samples), p.path, { comp_id: 7, project_path: "x.aep" }, undefined, { spec: s }).find((x) => x.kind === "overshoot")?.severity;
    };
    it("keeps a 1 % settle info and a 5 % one medium where the register allows none", () => {
      expect(sev(0.1, spec({ register: "brand_film" }))).toBe("info"); // about 0.8 %
      expect(sev(0.25, spec({ register: "brand_film" }))).toBe("medium"); // about 5 %
    });
    it("is unchanged for a non-zero budget", () => {
      expect(sev(0.5, spec({ register: "energetic" }))).toBe("info"); // about 20 %
      expect(sev(0.8, spec({ register: "energetic" }))).toBe("low"); // about 43 %
    });
  });
});

describe("choreography: landed text still moving", () => {
  const text = info(1, { kind: "text", out_point: 8 });
  const scale = (t0: number, t1: number) => prop({ layer: L(1), match: "ADBE Scale", keys: [[t0, 100], [t1, 104]] });
  it("flags a transform tween after the entrance has settled", () => {
    const f = run([pos(1, 0.2, 0.8, "easeout"), scale(3, 4)], [text], spec(), ["landed_text"]);
    expect(kinds(f)).toEqual(["landed_text_moving"]);
    expect(f[0].severity).toBe("low");
    expect(f[0].message).toMatch(/after it landed at 0\.8s/);
  });
  it("leaves entrance plus exit alone", () => {
    expect(run([pos(1, 0.2, 0.8, "easeout"), pos(1, 7.4, 8, "easein")], [text], spec(), ["landed_text"])).toHaveLength(0);
  });
  it("does not apply to other layer kinds", () => {
    expect(run([pos(1, 0.2, 0.8, "easeout"), scale(3, 4)], [info(1)], spec(), ["landed_text"])).toHaveLength(0);
  });
  it("flags wiggle and loop expressions on a text layer's transform", () => {
    const f = run([], [info(1, { kind: "text", transform_expressions: [{ name: "Position", text: "wiggle(2, 10)" }] })], spec(), ["landed_text"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "landed_text_moving", severity: "medium" });
    expect(f[0].message).toMatch(/wiggle/);
    expect(run([], [info(1, { kind: "text", transform_expressions: [{ name: "Position", text: "value + [0, 4]" }] })], spec(), ["landed_text"])).toHaveLength(0);
  });
});

describe("choreography: long spatial tween", () => {
  const slow = (index: number) => pos(index, 1, 4); // 3 s
  it("flags a position move over the register's limit", () => {
    const f = run([slow(1)], [info(1)], spec(), ["long_tween"]);
    expect(kinds(f)).toEqual(["long_tween"]);
    expect(f[0].severity).toBe("low");
    expect(f[0].message).toMatch(/3s.*brand_film register allows 2s/);
  });
  it("follows the register: fine for handmade, flagged earlier for energetic", () => {
    expect(run([slow(1)], [info(1)], spec({ register: "handmade" }), ["long_tween"])).toHaveLength(0);
    expect(run([pos(1, 1, 2.5)], [info(1)], spec({ register: "energetic" }), ["long_tween"])).toHaveLength(1);
    expect(run([pos(1, 1, 2.5)], [info(1)], spec(), ["long_tween"])).toHaveLength(0);
  });
  it("skips cameras, lights and backgrounds, and non-spatial properties", () => {
    expect(run([slow(1)], [info(1, { kind: "camera" })], spec(), ["long_tween"])).toHaveLength(0);
    expect(run([slow(1)], [info(1, { name: "bg plate" })], spec(), ["long_tween"])).toHaveLength(0);
    expect(run([slow(1)], [info(1, { name: "Plate", width: 1920, height: 1080 })], spec(), ["long_tween"])).toHaveLength(0);
    const fade = prop({ layer: L(1), match: "ADBE Opacity", keys: [[1, 0], [4, 100]] });
    expect(run([fade], [info(1)], spec(), ["long_tween"])).toHaveLength(0);
  });
});

describe("ae_motion_review with choreography checks", () => {
  it("runs the checks, returns the spec used, and honours `checks`", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-choreo-"));
    try {
      const queue = new SingleWriterQueue();
      const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
      const slow = pos(1, 1, 4);
      const entries = [{ layer: slow.samples.layer, path: slow.path, name: "Position", matchName: "ADBE Position", num_keys: 2, first_key_time: 1, last_key_time: 4, expression: false }];
      const host = new PanelHost({
        evalScript: async (script) => {
          if (script.includes("__chromaAe.listAnimatedProperties(")) {
            return {
              ok: true,
              durationMs: 1,
              result: {
                comp: { id: 7, name: "Shot", fps: FPS, width: 1920, height: 1080, workAreaStart: 0, workAreaDuration: 6 },
                project_path: "C:/jobs/Shot.aep",
                layers_scanned: 1,
                truncated: false,
                layer_info: [info(1)],
                properties: entries,
              },
            };
          }
          if (script.includes("__chromaAe.sampleProperty(")) return { ok: true, durationMs: 1, result: slow.samples };
          return { ok: true, durationMs: 1, result: { project_path: "C:/jobs/Shot.aep" } };
        },
        queue,
        quarantine,
      });
      const tool = motionTools.find((t) => t.name === "ae_motion_review")!;
      const all = (await tool.handler(AeMotionReviewSchema.parse({ comp_id: 7, bounds: false }), { bridge: host, queue, quarantine })) as Record<string, any>;
      expect(all.by_kind.long_tween).toBe(1);
      expect(all.spec).toMatchObject({ register: "brand_film", from_brief: [], thresholds: { max_same_ease: 2, long_tween_s: 2, overshoot_max_pct: 0 } });
      const only = (await tool.handler(AeMotionReviewSchema.parse({ comp_id: 7, bounds: false, checks: ["ease_monotony"] }), { bridge: host, queue, quarantine })) as Record<string, any>;
      expect(only.by_kind.long_tween).toBeUndefined();
      expect(only.spec.checks).toEqual(["ease_monotony"]);
      expect(AeMotionReviewSchema.safeParse({ comp_id: 7, checks: ["nope"] }).success).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("choreography: a move split by a roving key", () => {
  // The review's fix for a linear A-B-C move: ease the end keys, rove the middle one. AE then
  // holds it as two segments, "speeds up" into the middle key and "slows down" out of it.
  const split = (layer = L(1)) => prop({ layer, match: "ADBE Position", keys: [[0, 100], [1, 320], [2, 540]], shapes: ["easein", "easeout"] });

  it("reads the two halves as one ease in-out, not an entrance that only eases in", () => {
    const f = run([split()], [info(1, { out_point: 10 })], spec(), ["direction"]);
    expect(f).toEqual([]);
  });
  it("runs the whole review (the after-the-fix state) with no medium finding", () => {
    const p = split();
    const speeds = sampleSpeeds(p.samples);
    const own = reviewProperty(p.samples, p.analysis, speeds, p.path as never, { comp_id: 7, project_path: "C:/jobs/Shot.aep" });
    const all = [...own, ...run([p], [info(1, { out_point: 2 })])];
    expect(all.filter((x) => x.severity === "medium")).toEqual([]);
  });
  it("still flags a real exit that only eases out, however many keys it has", () => {
    const p = prop({ layer: L(1), match: "ADBE Position", keys: [[8, 100], [9, 320], [10, 540]], shapes: ["linear", "easeout"] });
    // linear then ease-out: the join is not a pass-through (speeds differ), so the last tween is a plain ease out.
    expect(kinds(run([p], [info(1, { out_point: 10 })], spec(), ["direction"]))).toEqual(["wrong_direction"]);
  });
  it("keeps a key where the move stops as a boundary", () => {
    const p = prop({ layer: L(1), match: "ADBE Position", keys: [[0, 100], [1, 320], [2, 540]], shapes: ["inout", "inout"] });
    expect(kinds(run([p], [info(1)], spec(), ["direction"]))).toEqual([]);
  });
});
