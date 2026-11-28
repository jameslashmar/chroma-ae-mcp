import { describe, expect, it } from "vitest";
import {
  AeScreenForegroundSchema,
  maskBox,
  planInsertMb,
  planTimes,
  setMismatches,
  structureMismatches,
} from "../src/tools/ext/screenfg.js";
import {
  alphaOf,
  boxBlur3,
  classify,
  clipAlpha,
  clipsFrom,
  cornerSpeed,
  cropImage,
  dilate,
  edgeBox,
  erode,
  excessOf,
  fitWrap,
  keyQuality,
  maskFromAlpha,
  MIN_FG_PX,
  resizeMask,
  screenColourInside,
  swapCheck,
  wrapMapOf,
  type KeyColour,
} from "../src/tools/ext/screenfg-math.js";
import type { RgbaImage } from "../src/tools/ext/png-utils.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

// ---------- synthetic pictures ----------

const GREEN: [number, number, number] = [0.38, 0.71, 0.22];
const SKIN: [number, number, number] = [0.72, 0.55, 0.45];

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number?]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      data[i] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
      data[i + 3] = Math.round((a ?? 1) * 255);
    }
  }
  return { width: w, height: h, data };
}

function ones(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

/** A disc of radius r at (cx, cy) with a soft edge `soft` px wide: alpha 1 inside, 0 outside. */
function disc(w: number, h: number, cx: number, cy: number, r: number, soft = 2): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.min(1, Math.max(0, (r - Math.hypot(x - cx, y - cy)) / soft + 0.5));
  return a;
}

function keyOf(rgb: [number, number, number]): KeyColour {
  return { rgb, dom: 1, excess: excessOf(rgb[0], rgb[1], rgb[2], 1), pixels: 1, coverage: 1 };
}

// ---------- the measuring ----------

describe("screenfg-math", () => {
  it("finds a green screen's colour inside the area, half covered by a hand, and refuses a picture", () => {
    const w = 80;
    const h = 60;
    // Shaded green (+-8%) with a skin disc over a third of it.
    const img = image(w, h, (x, y) => (Math.hypot(x - 20, y - 30) < 18 ? SKIN : [GREEN[0] * (0.92 + 0.0027 * x), GREEN[1] * (0.92 + 0.0027 * x), GREEN[2] * (0.92 + 0.0027 * x)]));
    const k = screenColourInside([{ img, inside: ones(w, h) }], 1)!;
    expect(k.dom).toBe(1);
    for (let c = 0; c < 3; c++) expect(Math.abs(k.rgb[c] - GREEN[c])).toBeLessThan(0.05);
    expect(k.coverage).toBeGreaterThan(0.6);
    expect(k.coverage).toBeLessThan(0.8);
    // A blue screen.
    const blue = image(w, h, () => [0.15, 0.3, 0.75]);
    expect(screenColourInside([{ img: blue, inside: ones(w, h) }], 1)!.dom).toBe(2);
    // A picture: grey and skin, no key colour.
    const pic = image(w, h, (x) => (x < 40 ? [0.5, 0.5, 0.5] : SKIN));
    expect(screenColourInside([{ img: pic, inside: ones(w, h) }], 1)).toBeNull();
    // A red field is not a key colour either.
    expect(screenColourInside([{ img: image(w, h, () => [0.8, 0.2, 0.2]), inside: ones(w, h) }], 1)).toBeNull();
    // Only the inside counts: a box inside the hand has no screen in it.
    const inside = new Uint8Array(w * h);
    for (let y = 22; y < 38; y++) for (let x = 12; x < 28; x++) inside[y * w + x] = 1;
    expect(screenColourInside([{ img, inside }], 1)).toBeNull();
  });

  it("sorts sure screen and sure foreground from the plate, leaving the edge and a shadow to neither", () => {
    const w = 60;
    const h = 40;
    const img = image(w, h, (x) => {
      if (x < 20) return GREEN;
      if (x < 30) return [GREEN[0] * 0.5, GREEN[1] * 0.5, GREEN[2] * 0.5]; // a shadow on the screen
      return SKIN;
    });
    const { screen, fg } = classify(img, ones(w, h), keyOf(GREEN), 3);
    const at = (m: Uint8Array, x: number) => m[20 * w + x];
    expect(at(screen, 8)).toBe(1);
    expect(at(fg, 45)).toBe(1);
    // The shadow (excess half the screen's) and the pixels near each border are neither.
    expect(at(screen, 25)).toBe(0);
    expect(at(fg, 25)).toBe(0);
    expect(at(fg, 31)).toBe(0);
    expect(at(screen, 19)).toBe(0);
  });

  it("puts Clip Black over the screen's raw matte and Clip White under the subject's", () => {
    const n = 2000;
    const alpha = new Float32Array(n);
    const screen = new Uint8Array(n);
    const fg = new Uint8Array(n);
    for (let i = 0; i < 1000; i++) {
      alpha[i] = 0.05 + (0.15 * i) / 999; // screen 0.05..0.20
      screen[i] = 1;
    }
    for (let i = 1000; i < n; i++) {
      alpha[i] = 0.86 + (0.1 * (i - 1000)) / 999; // subject 0.86..0.96
      fg[i] = 1;
    }
    const c = clipsFrom([{ alpha, screen, fg }]);
    expect(c.black).toBeCloseTo(21.9, 0);
    expect(c.white).toBeCloseTo(84.1, 0);
    expect(c.fg_px).toBe(1000);
    // Too little foreground: no Clip White.
    const few = clipsFrom([{ alpha, screen, fg: fg.map((v, i) => (i < 1000 + MIN_FG_PX - 1 ? v : 0)) }]);
    expect(few.white).toBeNull();
    // Clip White never comes within 20 of Clip Black.
    const close = clipsFrom([{ alpha: alpha.map((v, i) => (i < 1000 ? 0.4 : 0.45)), screen, fg }]);
    expect(close.white! - close.black).toBeGreaterThanOrEqual(20 - 1e-9);
    // The clipped matte.
    const cl = clipAlpha(Float32Array.from([0.1, 0.24, 0.5, 0.835, 0.95]), 24, 83.5);
    expect(Array.from(cl).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 0.437, 1, 1]);
  });

  it("blurs as Fast Box Blur x3 does: constants stay, the sum is kept, a naive version agrees", () => {
    const w = 23;
    const h = 17;
    const src = new Float32Array(w * h).map((_, i) => ((i * 7919) % 13) / 13);
    const out = boxBlur3(src, w, h, 2);
    // Naive: three box passes with edge repeat.
    const pass = (a: Float32Array) => {
      const t = new Float32Array(w * h);
      const o = new Float32Array(w * h);
      const c = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += a[y * w + c(x + k, w - 1)];
        t[y * w + x] = s / 5;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += t[c(y + k, h - 1) * w + x];
        o[y * w + x] = s / 5;
      }
      return o;
    };
    const naive = pass(pass(pass(src)));
    for (let i = 0; i < w * h; i++) expect(out[i]).toBeCloseTo(naive[i], 5);
    expect(Array.from(boxBlur3(new Float32Array(50).fill(0.3), 10, 5, 3)).every((v) => Math.abs(v - 0.3) < 1e-6)).toBe(true);
  });

  it("makes the wrap map only just inside the subject's edge", () => {
    const w = 60;
    const h = 60;
    const a = disc(w, h, 30, 30, 18);
    const W = wrapMapOf(a, w, h, 3);
    expect(W[30 * w + 30]).toBeLessThan(1e-6); // the middle
    expect(W[30 * w + 2]).toBe(0); // outside
    const rim = W[30 * w + 30 + 16];
    expect(rim).toBeGreaterThan(0.05);
    expect(rim).toBeLessThan(0.6);
  });

  it("fits the old screen's bleed into the edge (strength and radius), whatever the shading", () => {
    const w = 90;
    const h = 90;
    const alpha = disc(w, h, 45, 45, 30);
    const key = keyOf(GREEN);
    for (const [trueW, trueR] of [
      [0.6, 3],
      [0.35, 4],
    ] as Array<[number, number]>) {
      const W = wrapMapOf(alpha, w, h, trueR);
      // The subject shaded darker toward its left (40%), plus the screen bleeding in, plus the screen outside.
      const plate = image(w, h, (x, y) => {
        const i = y * w + x;
        if (alpha[i] < 0.5) return GREEN;
        const shade = 0.6 + (0.4 * x) / w;
        return [0, 1, 2].map((c) => SKIN[c] * shade + trueW * W[i] * GREEN[c]) as [number, number, number];
      });
      const fit = fitWrap([{ plate, alpha, inside: ones(w, h) }], key, [2, 3, 4, 6])!;
      expect(fit.radius).toBe(trueR);
      expect(fit.strength).toBeGreaterThan(trueW * 0.85);
      expect(fit.strength).toBeLessThan(trueW * 1.15);
      expect(fit.r2).toBeGreaterThan(0.8);
    }
    // No bleed: strength near 0.
    const clean = image(w, h, (x, y) => (alpha[y * w + x] < 0.5 ? GREEN : SKIN));
    expect(fitWrap([{ plate: clean, alpha, inside: ones(w, h) }], key, [3])!.strength).toBeLessThan(0.05);
    // No subject at all: null.
    expect(fitWrap([{ plate: image(w, h, () => GREEN), alpha: new Float32Array(w * h), inside: ones(w, h) }], key, [3])).toBeNull();
  });

  it("picks a radius a layer's opacity can reach when the best fit would need over 100%", () => {
    const w = 90;
    const h = 90;
    const alpha = disc(w, h, 45, 45, 30);
    const W2 = wrapMapOf(alpha, w, h, 2);
    const plate = image(w, h, (x, y) => {
      const i = y * w + x;
      if (alpha[i] < 0.5) return GREEN;
      return [0, 1, 2].map((c) => SKIN[c] + 1.5 * W2[i] * GREEN[c]) as [number, number, number];
    });
    const fit = fitWrap([{ plate, alpha, inside: ones(w, h) }], keyOf(GREEN), [2, 3, 4, 6])!;
    expect(fit.per_radius.find((p) => p.radius === 2)!.strength).toBeGreaterThan(1.1);
    expect(fit.radius).toBeGreaterThan(2);
    expect(fit.strength).toBeLessThanOrEqual(1);
  });

  it("says how completely the comp swapped the old screen in the edge for the new one", () => {
    const w = 90;
    const h = 90;
    const alpha = disc(w, h, 45, 45, 30);
    const W = wrapMapOf(alpha, w, h, 3);
    const k = 0.5;
    const NEW: [number, number, number] = [0.5, 0.75, 0.98];
    const plate = image(w, h, (x, y) => {
      const i = y * w + x;
      if (alpha[i] < 0.5) return GREEN;
      return [0, 1, 2].map((c) => SKIN[c] + k * W[i] * GREEN[c]) as [number, number, number];
    });
    const comp = (swap: number) =>
      image(w, h, (x, y) => {
        const i = y * w + x;
        if (alpha[i] < 0.5) return NEW;
        return [0, 1, 2].map((c) => SKIN[c] + k * W[i] * GREEN[c] + swap * k * W[i] * (NEW[c] - GREEN[c])) as [number, number, number];
      });
    const full = swapCheck(plate, comp(1), alpha, ones(w, h), keyOf(GREEN), 3)!;
    expect(full.swapped_pct).toBeGreaterThan(85);
    expect(full.swapped_pct).toBeLessThan(115);
    expect(swapCheck(plate, comp(0), alpha, ones(w, h), keyOf(GREEN), 3)!.swapped_pct).toBeLessThan(10);
    expect(swapCheck(plate, comp(0.5), alpha, ones(w, h), keyOf(GREEN), 3)!.swapped_pct).toBeGreaterThan(35);
  });

  it("judges the finished key on the plate's sure pixels", () => {
    const w = 20;
    const h = 10;
    const plate = image(w, h, (x) => (x < 10 ? GREEN : SKIN));
    const screen = new Uint8Array(w * h).map((_, i) => (i % w < 10 ? 1 : 0));
    const fg = new Uint8Array(w * h).map((_, i) => (i % w >= 10 ? 1 : 0));
    const good = image(w, h, (x) => (x < 10 ? [0, 0, 0, 0] : [...SKIN, 1]));
    const q = keyQuality([{ plate, keyed: good, screen, fg }]);
    expect(q).toMatchObject({ fg_see_through_pct: 0, screen_left_p999: 0, fg_colour_shift_levels: 0 });
    const thin = image(w, h, (x) => (x < 10 ? [0, 0, 0, 0.2] : [SKIN[0], SKIN[1] + 0.04, SKIN[2], x < 15 ? 0.9 : 1]));
    const q2 = keyQuality([{ plate, keyed: thin, screen, fg }]);
    expect(q2.fg_see_through_pct).toBe(50);
    expect(q2.screen_left_p999).toBeCloseTo(0.2, 2);
    expect(q2.fg_colour_shift_levels).toBeGreaterThan(2);
  });

  it("measures corner speed as the picture shows it, and the masks and boxes", () => {
    const frames = [0, 1, 2, 3].map((k) => ({ time: k / 24, corners: [[10 + k * 2, 5], [50 + k * 2, 5], [50 + k * 2, 30 + k * 4], [10 + k * 2, 30]] as Array<[number, number]> }));
    const sp = cornerSpeed(frames, 1.5);
    expect(sp.max).toBeCloseTo(5, 3); // 3 px of x at pixel aspect 1.5 and 4 px of y
    expect(sp.frames).toBe(3);
    expect(cornerSpeed(frames.slice(0, 1), 1).max).toBe(0);
    const m = new Uint8Array(100);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) m[y * 10 + x] = 1;
    expect(erode(m, 10, 10, 1).reduce((s, v) => s + v, 0)).toBe(4);
    expect(dilate(m, 10, 10, 1).reduce((s, v) => s + v, 0)).toBe(36);
    expect(maskBox(m, 10, 10, 1)).toEqual({ x: 2, y: 2, w: 6, h: 6 });
    expect(maskBox(new Uint8Array(100), 10, 10, 1)).toBeNull();
    expect(Array.from(resizeMask(m, 10, 10, 5, 5))).toHaveLength(25);
    const img = image(10, 10, (x, y) => [x / 10, y / 10, 0, (m[y * 10 + x] ? 1 : 0)]);
    expect(maskFromAlpha(img).reduce((s, v) => s + v, 0)).toBe(16);
    expect(alphaOf(img)[33]).toBe(1);
    const c = cropImage(img, 2, 3, 4, 2);
    expect([c.width, c.height, c.data[0]]).toEqual([4, 2, Math.round(0.2 * 255)]);
    const box = edgeBox(alphaOf(img), ones(10, 10), 10, 10, 6)!;
    expect(box.size).toBe(6);
  });
});

// ---------- planning and receipts ----------

describe("ae_screen_foreground planning", () => {
  it("plans frames inside the insert's span, snapped", () => {
    // Spread over the span less its last frame (1.9583 s), snapped to 1/24 s.
    expect(planTimes(undefined, { start: 0, end: 2 }, 24, 4)).toEqual([0.25, 0.75, 1.2083, 1.7083]);
    expect(planTimes([0.51, 3, 0.51], { start: 0, end: 2 }, 24, 4)).toEqual([0.5]);
    expect(planTimes([5], { start: 0, end: 2 }, 24, 4)).toEqual([]);
  });

  const comp = { id: 1, name: "c", width: 100, height: 100, pixel_aspect: 1, fps: 24, duration: 4, motion_blur: false, shutter_angle: 180, shutter_phase: 0 };
  const insert = (o: Record<string, unknown>) => ({ index: 1, id: 2, name: "x INSERT", locked: false, enabled: true, in_point: 0, out_point: 4, source_kind: "comp", source_pixel_aspect: 1, motion_blur: false, opacity_keyed: false, effects: [], pin: "CC Power Pin", force_mb: null, frames: [], frames_truncated: false, ...o }) as any;

  it("adds CC Force Motion Blur, centred, to a moving insert that has none; leaves a still one", () => {
    const moving = planInsertMb("auto", { comp, insert: insert({}) }, { max: 5.5, at: 5.6 });
    expect(moving.set).toEqual({ angle: 180, phase: -90 });
    expect(moving.note).toMatch(/5\.5 px a frame/);
    expect(moving.note).toMatch(/camera blurs/);
    expect(planInsertMb("auto", { comp, insert: insert({}) }, { max: 1, at: 0 }).set).toBeNull();
    expect(planInsertMb("keep", { comp, insert: insert({}) }, { max: 9, at: 0 }).set).toBeNull();
  });

  it("centres a CC Force Motion Blur that runs ahead of the track, and leaves a centred one", () => {
    const ahead = planInsertMb("auto", { comp, insert: insert({ force_mb: { enabled: true, override: 1, angle: 180, phase: 0 } }) }, { max: 5.55, at: 1 });
    expect(ahead.set).toEqual({ angle: 180, phase: -90 });
    expect(ahead.note).toMatch(/1\.39 px/);
    expect(planInsertMb("auto", { comp, insert: insert({ force_mb: { enabled: true, override: 1, angle: 180, phase: -90 } }) }, { max: 5, at: 1 }).set).toBeNull();
    // The comp's own angle is used.
    const wide = planInsertMb("auto", { comp: { ...comp, shutter_angle: 270 }, insert: insert({}) }, { max: 4, at: 1 });
    expect(wide.set).toEqual({ angle: 270, phase: -135 });
    // Layer motion blur: only a note when the comp's phase is not centred.
    const layerMb = planInsertMb("auto", { comp: { ...comp, motion_blur: true }, insert: insert({ motion_blur: true }) }, { max: 4, at: 1 });
    expect(layerMb.set).toBeNull();
    expect(layerMb.note).toMatch(/comp's shutter phase 0/);
  });

  const layer = (id: number, index: number, o: Record<string, unknown> = {}) => ({ index, id, name: `L${id}`, enabled: true, blending_mode: "normal", matte_id: null, matte_type: "none", opacity: 100, source_id: null, effects: [], ...o }) as any;
  const parts = { comps: { key: 50, area: 51, wrap: 52 }, layers: { wrap_in: { index: 1, id: 11 }, wrap_out: { index: 2, id: 12 }, wrap: { index: 3, id: 13 }, key: { index: 4, id: 14 }, area: { index: 5, id: 15 }, insert: { index: 6, id: 16 } } };
  const goodRead = () => ({
    layers: {
      wrap_in: layer(11, 1, { blending_mode: "add", matte_id: 13, matte_type: "luma", opacity: 0, effects: [{ match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": 8 } }] }),
      wrap_out: layer(12, 2, { blending_mode: "subtract", matte_id: 13, matte_type: "luma", opacity: 0, effects: [{ match: "ADBE Fill", enabled: true, params: { "ADBE Fill-0002": [0.38, 0.71, 0.22, 1] } }, { match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": 8 } }] }),
      wrap: layer(13, 3, { enabled: false }),
      key: layer(14, 4, { matte_id: 15, matte_type: "alpha" }),
      area: layer(15, 5, { enabled: false }),
      insert: layer(16, 6, { effects: [{ match: "CC Force Motion Blur", enabled: true, params: { "CC Force Motion Blur-0003": 180, "CC Force Motion Blur-0005": -90 } }] }),
    },
    inner: {
      key: layer(20, 1, { effects: [{ match: "Keylight 906", enabled: true, params: { "Keylight 906-0019": 2, "Keylight 906-0004": [0.38, 0.71, 0.22, 1], "Keylight 906-0012": 24, "Keylight 906-0013": 83.5 } }] }),
      area: layer(21, 1, { effects: [{ match: "ADBE Minimax", enabled: true, params: { "ADBE Minimax-0002": 6 } }] }),
      wrap: [layer(22, 1, { name: "alpha", blending_mode: "multiply" }), layer(23, 2, { effects: [{ match: "ADBE Invert", enabled: true, params: {} }, { match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": 3 } }] })],
    },
    order: [11, 12, 13, 14, 15, 16],
    comps: { key: { id: 50 }, area: { id: 51 }, wrap: { id: 52 } },
  });

  it("checks the built structure and catches what did not stick", () => {
    expect(structureMismatches(goodRead() as any, parts, 6)).toEqual([]);
    const bad = goodRead() as any;
    bad.layers.key.matte_type = "luma";
    bad.layers.wrap_out.blending_mode = "normal";
    bad.layers.wrap.enabled = true;
    bad.inner.area.effects[0].params["ADBE Minimax-0002"] = 2;
    const m = structureMismatches(bad, parts, 6).map((x) => x.path);
    expect(m).toEqual(expect.arrayContaining(["key.matte", "wrap_out.blending_mode", "mattes.enabled", "area.grow_px"]));
    const swapped = goodRead() as any;
    swapped.layers.key.index = 2;
    swapped.layers.wrap_out.index = 4;
    expect(structureMismatches(swapped, parts, 6).map((x) => x.path)).toContain("order");
    const missing = goodRead() as any;
    missing.layers.area = null;
    expect(structureMismatches(missing, parts, 6).map((x) => x.path)).toEqual(["layers.area"]);
  });

  it("checks the values a set wrote", () => {
    const plan = { keylight: { colour: [0.38, 0.71, 0.22], clip_black: 24, clip_white: 83.5 }, wrap: { opacity: 0, colour: [0.38, 0.71, 0.22], map_radius: 3, light_radius: 8 }, grow_px: 6, insert_mb: { angle: 180, phase: -90 } };
    expect(setMismatches(goodRead() as any, plan)).toEqual([]);
    const bad = goodRead() as any;
    bad.inner.key.effects[0].params["Keylight 906-0013"] = 100;
    bad.layers.wrap_in.opacity = 50;
    bad.layers.insert.effects[0].params["CC Force Motion Blur-0005"] = 0;
    expect(setMismatches(bad, plan).map((x) => x.path)).toEqual(expect.arrayContaining(["keylight.clip_white", "wrap_in.opacity", "insert.force_mb.phase"]));
  });

  it("validates its arguments", () => {
    const base = { comp_id: 1, insert: { name: "x INSERT" }, expect: { project_path: "<unsaved>" } };
    expect(AeScreenForegroundSchema.safeParse(base).success).toBe(true);
    expect(AeScreenForegroundSchema.parse(base)).toMatchObject({ wrap: "auto", insert_motion_blur: "auto", remove: false, max_samples: 8 });
    expect(AeScreenForegroundSchema.safeParse({ ...base, wrap: 1.5 }).success).toBe(false);
    expect(AeScreenForegroundSchema.safeParse({ ...base, screen_colour: [0, 1] }).success).toBe(false);
    expect(AeScreenForegroundSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
  });
});

// ---------- screenfg.jsx against the fake AE ----------

const P1 = (name: string, matchName: string, v: number) => new FakeProperty(name, matchName, PropertyValueType.OneD, v);
const P2 = (name: string, matchName: string, v: number[]) => new FakeProperty(name, matchName, PropertyValueType.TwoD, v);
const PC = (name: string, matchName: string, v: number[]) => new FakeProperty(name, matchName, PropertyValueType.COLOR, v);

function makeEffect(matchName: string, fail: Set<string>): FakeGroup {
  if (fail.has(matchName)) throw new Error(`Can not add property ${matchName}`);
  const params: Record<string, FakeProperty[]> = {
    "Keylight 906": [P1("View", "Keylight 906-0002", 11), PC("Screen Colour", "Keylight 906-0004", [0, 0, 0, 1]), P1("Clip Black", "Keylight 906-0012", 0), P1("Clip White", "Keylight 906-0013", 100), P1("Replace Method", "Keylight 906-0019", 4)],
    "ADBE Shift Channels": [1, 2, 3, 4].map((v) => P1(`ch${v}`, `ADBE Shift Channels-000${v}`, v)),
    "ADBE Invert": [P1("Channel", "ADBE Invert-0001", 1)],
    "ADBE Box Blur2": [P1("Blur Radius", "ADBE Box Blur2-0001", 0), P1("Iterations", "ADBE Box Blur2-0002", 3), P1("Repeat Edge Pixels", "ADBE Box Blur2-0004", 1)],
    "ADBE Minimax": [P1("Operation", "ADBE Minimax-0001", 2), P1("Radius", "ADBE Minimax-0002", 0), P1("Channel", "ADBE Minimax-0003", 1)],
    "ADBE Fill": [PC("Color", "ADBE Fill-0002", [1, 0, 0, 1])],
    "CC Force Motion Blur": [P1("Override", "CC Force Motion Blur-0002", 1), P1("Shutter Angle", "CC Force Motion Blur-0003", 180), P1("Shutter Phase", "CC Force Motion Blur-0005", 0)],
    "CC Power Pin": [P2("Top Left", "CC Power Pin-0002", [0, 0]), P2("Top Right", "CC Power Pin-0003", [100, 0]), P2("Bottom Left", "CC Power Pin-0004", [0, 100]), P2("Bottom Right", "CC Power Pin-0005", [100, 100])],
    "ADBE Pro Levels2": [P1("Input Black", "l1", 0)],
  };
  const g = new FakeGroup(matchName, matchName, params[matchName] ?? []);
  (g as any).enabled = true;
  return g;
}

function withEffects(layer: FakeLayer, fail: Set<string>, existing: string[] = []) {
  const fx = layer.property("ADBE Effect Parade") as any;
  const add = (mn: string) => {
    const g = makeEffect(mn, fail) as any;
    g.parentProperty = fx;
    fx.props.push(g);
    Object.defineProperty(g, "propertyIndex", { get: () => fx.props.indexOf(g) + 1 });
    g.remove = () => fx.props.splice(fx.props.indexOf(g), 1);
    return g;
  };
  fx.addProperty = add;
  for (const mn of existing) add(mn);
  return fx;
}

function fgScene(opts: { fail?: string[] } = {}) {
  const fail = new Set(opts.fail ?? []);
  const project = new FakeProject();
  const wrap = (l: FakeLayer): FakeLayer => {
    withEffects(l, fail);
    (l as any).duplicate = () => {
      const d = new FakeLayer(l.comp, l.name);
      d.source = l.source;
      d.rect = { ...l.rect };
      l.comp.stack.splice(l.comp.stack.indexOf(l), 0, d);
      wrap(d);
      // Effects and their values are copied, as AE's duplicate does.
      for (const e of (l.property("ADBE Effect Parade") as any).props) {
        const c = (d.property("ADBE Effect Parade") as any).addProperty(e.matchName);
        for (const p of e.props) {
          const q = c.props.find((x: any) => x.matchName === p.matchName);
          if (q) q.setValue(p.value);
        }
      }
      return d;
    };
    return l;
  };
  const prep = (c: FakeComp): FakeComp => {
    for (const k of ["add", "addSolid", "addNull"]) {
      const orig = c.layers[k];
      c.layers[k] = (...a: any[]) => wrap(orig(...a));
    }
    return c;
  };
  const comp = prep(project.addComp("Main", 320, 200, 4));
  comp.frameRate = 10;
  (project as any).items = {
    addComp: (name: string, w: number, h: number, pa: number, dur: number, fps: number) => {
      const c = prep(project.addComp(name, w, h, dur));
      c.pixelAspect = pa;
      c.frameRate = fps;
      return c;
    },
  };
  const clip = project.addFootage("Plate.mov", 320, 200);
  const plate = comp.layers.add(clip) as FakeLayer;
  plate.name = "Plate";
  const uiComp = prep(project.addComp("Phone INSERT", 160, 90, 4));
  const ins = comp.layers.add(uiComp) as FakeLayer;
  ins.name = "Phone INSERT";
  const pin = (ins.property("ADBE Effect Parade") as any).addProperty("CC Power Pin");
  const tl = pin.props[0] as FakeProperty;
  tl.setValueAtTime(0, [10, 10]);
  tl.setValueAtTime(1, [16, 18]);
  const hostLoad = () => {
    const h = loadHost(project, ["planar.jsx", "screenfg.jsx"]);
    h.G.BlendingMode = { NORMAL: 5212, ADD: 5220, SUBTRACT: 5248, MULTIPLY: 5216 };
    return h;
  };
  return { project, comp: comp as FakeComp, plate, ins, clip, hostLoad };
}

const names = (c: FakeComp) => c.stack.map((l) => l.name);
const fxList = (l: FakeLayer) => (l.property("ADBE Effect Parade") as any).props.map((g: any) => g.matchName);
const fxOf = (l: FakeLayer, mn: string) => (l.property("ADBE Effect Parade") as any).props.filter((g: any) => g.matchName === mn).pop();
const pv = (l: FakeLayer, mn: string, p: string) => fxOf(l, mn).props.find((x: any) => x.matchName === p).value;

function buildArgs(s: ReturnType<typeof fgScene>, over: Record<string, unknown> = {}) {
  return { comp_id: s.comp.id, mode: "build", name: "Phone", insert: { index: s.ins.index, id: s.ins.id }, plate: { index: s.plate.index, id: s.plate.id }, grow_px: 6, map_radius: 3, light_radius: 8, expect: GUARD, ...over };
}

describe("screenfg.jsx", () => {
  it("reads the insert, its pin's corners on every frame, the plate below it and no earlier parts, changing nothing", () => {
    const s = fgScene();
    const { A, undo } = s.hostLoad();
    const info = A.screenfgInfo({ comp_id: s.comp.id, insert: { name: "Phone INSERT" } });
    expect(info.name).toBe("Phone");
    expect(info.plate).toMatchObject({ name: "Plate", source_kind: "footage" });
    expect(info.insert.pin).toBe("CC Power Pin");
    expect(info.insert.frames).toHaveLength(40);
    expect(info.insert.frames[10].c[0]).toEqual([16, 18]);
    expect(info.can_set_track_matte).toBe(true);
    expect(info.has_subtract).toBe(true);
    expect(Object.values(info.existing.layers).every((v) => v === null)).toBe(true);
    expect(undo.begun).toBe(0);
  });

  it("builds KEY, AREA, WRAP and the two wrap layers above the insert in one undo group", () => {
    const s = fgScene();
    const { A, undo } = s.hostLoad();
    const r = A.screenfgApply(buildArgs(s, { insert_mb: { angle: 180, phase: -90 } }));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(names(s.comp)).toEqual(["Phone wrap IN (new screen)", "Phone wrap OUT (old screen)", "Phone WRAP", "Phone KEY", "Phone AREA", "Phone INSERT", "Plate"]);
    const L = (n: string) => s.comp.layer(n)!;
    // The key: a copy of the plate with Keylight (Source, off until measured), matted by the area.
    const keyComp = s.project.itemByID(r.comps.key.id) as FakeComp;
    expect(keyComp.layer(1)!.source).toBe(s.clip);
    expect(fxList(keyComp.layer(1)!)).toEqual(["Keylight 906"]);
    expect(pv(keyComp.layer(1)!, "Keylight 906", "Keylight 906-0019")).toBe(2);
    expect(fxOf(keyComp.layer(1)!, "Keylight 906").enabled).toBe(false);
    expect(L("Phone KEY").trackMatteLayer).toBe(L("Phone AREA"));
    expect(L("Phone AREA").enabled).toBe(false);
    // The area: the insert's copy without motion blur, grown.
    const areaInner = (s.project.itemByID(r.comps.area.id) as FakeComp).layer(1)!;
    expect(fxList(areaInner)).toEqual(["CC Power Pin", "ADBE Minimax"]);
    expect(pv(areaInner, "ADBE Minimax", "ADBE Minimax-0002")).toBe(6);
    // The wrap map comp: blur(1 - a) under a Multiply of a.
    const wrapComp = s.project.itemByID(r.comps.wrap.id) as FakeComp;
    expect(names(wrapComp)).toEqual(["alpha", "1 - alpha, blurred"]);
    expect((wrapComp.layer(1) as any).blendingMode).toBe(5216);
    expect(fxList(wrapComp.layer(2)!)).toEqual(["ADBE Shift Channels", "ADBE Invert", "ADBE Box Blur2"]);
    expect(pv(wrapComp.layer(2)!, "ADBE Box Blur2", "ADBE Box Blur2-0001")).toBe(3);
    // The wrap layers: the pin kept, Subtract / Add, at opacity 0, luma-matted by WRAP.
    const out = L("Phone wrap OUT (old screen)");
    const inn = L("Phone wrap IN (new screen)");
    expect(fxList(out)).toEqual(["CC Power Pin", "ADBE Fill", "ADBE Box Blur2"]);
    expect(fxList(inn)).toEqual(["CC Power Pin", "ADBE Box Blur2"]);
    expect([(out as any).blendingMode, (inn as any).blendingMode]).toEqual([5248, 5220]);
    expect([out.trackMatteLayer, inn.trackMatteLayer]).toEqual([L("Phone WRAP"), L("Phone WRAP")]);
    expect(out.transform("ADBE Opacity").value).toBe(0);
    expect(L("Phone WRAP").enabled).toBe(false);
    // The insert got CC Force Motion Blur, centred; the plate is untouched.
    expect(pv(s.ins, "CC Force Motion Blur", "CC Force Motion Blur-0005")).toBe(-90);
    expect(r.insert_mb).toMatchObject({ added: true, phase: -90 });
    expect(fxList(s.plate)).toEqual([]);
    // The read-back names what it finds.
    const read = A.screenfgRead({ comp_id: s.comp.id, layer_ids: Object.fromEntries(Object.entries(r.layers).map(([k, v]: any) => [k, v.id])), comps: { key: r.comps.key.id, area: r.comps.area.id, wrap: r.comps.wrap.id } });
    const parts = { comps: { key: r.comps.key.id, area: r.comps.area.id, wrap: r.comps.wrap.id }, layers: r.layers };
    expect(structureMismatches(read, parts, 6)).toEqual([]);
  });

  it("sets measured values on the parts, and the info read finds them for a re-tune", () => {
    const s = fgScene();
    const { A } = s.hostLoad();
    const r = A.screenfgApply(buildArgs(s));
    const info = A.screenfgInfo({ comp_id: s.comp.id, insert: { name: "Phone INSERT" } });
    expect(info.existing.layers.key).toMatchObject({ id: r.layers.key.id });
    expect(info.existing.comps.wrap).toMatchObject({ id: r.comps.wrap.id });
    const parts = { comps: { key: r.comps.key.id, area: r.comps.area.id, wrap: r.comps.wrap.id }, layers: r.layers };
    const plan = { keylight: { enabled: true, colour: [0.38, 0.71, 0.22], clip_black: 24, clip_white: 83.5 }, wrap: { opacity: 97, colour: [0.38, 0.71, 0.22], map_radius: 4, light_radius: 9 }, grow_px: 7 };
    const res = A.screenfgApply({ comp_id: s.comp.id, mode: "set", parts, ...plan, expect: GUARD });
    expect(res.set).toEqual(expect.arrayContaining(["keylight.colour", "keylight.clip_white", "wrap.opacity", "wrap.map_radius", "grow_px"]));
    const read = A.screenfgRead({ comp_id: s.comp.id, layer_ids: Object.fromEntries(Object.entries(r.layers).map(([k, v]: any) => [k, v.id])), comps: parts.comps });
    expect(setMismatches(read, { ...plan, wrap: { ...plan.wrap, opacity: 97 } })).toEqual([]);
    // A part that went missing is refused before anything is written.
    s.comp.layer("Phone WRAP")!.remove();
    expect(() => A.screenfgApply({ comp_id: s.comp.id, mode: "set", parts, ...plan, expect: GUARD })).toThrow(/wrap layer/);
  });

  it("refuses a second build by the same name, a locked insert and a plate that already has Keylight, before writing", () => {
    const s = fgScene();
    const { A, undo } = s.hostLoad();
    A.screenfgApply(buildArgs(s));
    const ins = s.comp.layer("Phone INSERT")!;
    const plate = s.comp.layer("Plate")!;
    expect(() => A.screenfgApply(buildArgs(s, { insert: { index: ins.index, id: ins.id }, plate: { index: plate.index, id: plate.id } }))).toThrow(/already in the comp/);
    const t = fgScene();
    const h = t.hostLoad();
    t.ins.locked = true;
    expect(() => h.A.screenfgApply(buildArgs(t))).toThrow(/locked/);
    t.ins.locked = false;
    (t.plate.property("ADBE Effect Parade") as any).addProperty("Keylight 906");
    expect(() => h.A.screenfgApply(buildArgs(t))).toThrow(/already has Keylight/);
    expect(h.undo.begun).toBe(0);
    expect(undo.begun).toBe(1);
  });

  it("removes what it made when a step fails half way, in the same call", () => {
    const s = fgScene({ fail: ["ADBE Minimax"] });
    const { A } = s.hostLoad();
    const before = s.project.numItems;
    expect(() => A.screenfgApply(buildArgs(s))).toThrow(/Minimax could not be added/);
    expect(names(s.comp)).toEqual(["Phone INSERT", "Plate"]);
    expect(s.project.numItems).toBe(before);
  });

  it("removes the parts by id and leaves the insert", () => {
    const s = fgScene();
    const { A } = s.hostLoad();
    const r = A.screenfgApply(buildArgs(s));
    const before = s.project.numItems;
    const gone = A.screenfgApply({ comp_id: s.comp.id, mode: "remove", name: "Phone", parts: { layers: r.layers, comps: { key: r.comps.key.id, area: r.comps.area.id, wrap: r.comps.wrap.id } }, expect: GUARD });
    expect(gone.removed.layers).toHaveLength(5);
    expect(gone.removed.comps).toHaveLength(3);
    expect(names(s.comp)).toEqual(["Phone INSERT", "Plate"]);
    expect(s.project.numItems).toBe(before - 3);
    // Nothing left: no op, no undo group.
    expect(A.screenfgApply({ comp_id: s.comp.id, mode: "remove", name: "Phone", parts: { layers: {}, comps: {} }, expect: GUARD })).toMatchObject({ no_op: true });
  });
});
