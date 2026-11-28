import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeScreenForegroundSchema, screenfgTools } from "../src/tools/ext/screenfg.js";

// The sheet goes to the data dir's frames folder: keep it out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-screenfg-"));
const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
beforeAll(() => {
  process.env.LOCALAPPDATA = dataDir;
  process.env.HOME = dataDir;
  process.env.XDG_DATA_HOME = dataDir;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Out = Record<string, any>;
const tool = screenfgTools[0];

// ---------- a plate: a green screen (the area) with a skin disc crossing it, its edge carrying some screen ----------

const W = 160;
const H = 120;
const GREEN = [97, 181, 57];
const SKIN = [184, 140, 115];
const NEW = [128, 190, 250];
const AREA = { x0: 20, y0: 15, x1: 140, y1: 105 };
const inArea = (x: number, y: number) => x >= AREA.x0 && x < AREA.x1 && y >= AREA.y0 && y < AREA.y1;

/** The subject's true coverage at (x, y) and time t: a disc of radius 18 moving right, with a 2 px soft edge. */
function cover(x: number, y: number, t: number): number {
  const cx = 55 + 30 * t;
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - 60);
  return Math.min(1, Math.max(0, (18 - d) / 2 + 0.5));
}

interface KeyState {
  enabled: boolean;
  colour: number[];
  cb: number;
  cw: number;
}

/** The plate's pixel; a screen that is no key colour (`grey`) for the refusal test. */
function platePx(x: number, y: number, t: number, grey: boolean): number[] {
  const a = cover(x, y, t);
  const screen = grey ? [120, 120, 125] : GREEN;
  if (!inArea(x, y)) return [40, 40, 45];
  // The old screen bleeds into the subject's edge: its colour mixed in where the coverage is under 1.
  return [0, 1, 2].map((c) => a * SKIN[c] + (1 - a) * screen[c]);
}

/** A Keylight stand-in: the raw matte is 0.1 on the screen and 0.88 inside the subject, clipped as set. */
function keyAlpha(x: number, y: number, t: number, k: KeyState): number {
  if (!inArea(x, y)) return 1;
  const raw = 0.1 + 0.78 * cover(x, y, t);
  const lo = k.cb / 100;
  const hi = k.cw / 100;
  return Math.min(1, Math.max(0, (raw - lo) / Math.max(1e-3, hi - lo)));
}

function png(f: (x: number, y: number) => number[]): PNG {
  const p = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = f(x, y);
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) p.data[i + c] = Math.max(0, Math.min(255, Math.round(v[c])));
      p.data[i + 3] = Math.max(0, Math.min(255, Math.round((v[3] ?? 1) * 255)));
    }
  }
  return p;
}

interface FakeOpts {
  grey?: boolean;
  existing?: "all" | "some";
  info?: Record<string, any>;
  insert?: Record<string, any>;
  failRenders?: boolean;
  breakRead?: (read: any) => void;
}

const IDS = { key: 50, area: 51, wrap: 52, wrap_in: 61, wrap_out: 62, wrapL: 63, keyL: 64, areaL: 65, insert: 66 };

function fakeAe(opts: FakeOpts = {}) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-screenfg-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const key: KeyState = { enabled: false, colour: [0, 0, 0], cb: 0, cw: 100 };
  const wrap = { opacity: 0, colour: [0, 1, 0], map: 1, light: 2 };
  let grow = 2;
  let mb: { angle: number; phase: number } | null = null;
  let built = opts.existing === "all";
  const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
  const layerRead = (id: number, index: number, o: Record<string, unknown> = {}) => ({ index, id, name: `L${id}`, enabled: true, blending_mode: "normal", matte_id: null, matte_type: "none", opacity: 100, source_id: null, effects: [], ...o });
  const read = () => ({
    layers: {
      wrap_in: layerRead(IDS.wrap_in, 1, { blending_mode: "add", matte_id: IDS.wrapL, matte_type: "luma", opacity: wrap.opacity, effects: [{ match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": wrap.light } }] }),
      wrap_out: layerRead(IDS.wrap_out, 2, { blending_mode: "subtract", matte_id: IDS.wrapL, matte_type: "luma", opacity: wrap.opacity, effects: [{ match: "ADBE Fill", enabled: true, params: { "ADBE Fill-0002": [...wrap.colour, 1] } }, { match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": wrap.light } }] }),
      wrap: layerRead(IDS.wrapL, 3, { enabled: false }),
      key: layerRead(IDS.keyL, 4, { matte_id: IDS.areaL, matte_type: "alpha" }),
      area: layerRead(IDS.areaL, 5, { enabled: false }),
      insert: layerRead(IDS.insert, 6, { effects: mb ? [{ match: "CC Force Motion Blur", enabled: true, params: { "CC Force Motion Blur-0003": mb.angle, "CC Force Motion Blur-0005": mb.phase } }] : [] }),
    },
    inner: {
      key: layerRead(70, 1, { effects: [{ match: "Keylight 906", enabled: key.enabled, params: { "Keylight 906-0019": 2, "Keylight 906-0004": [...key.colour, 1], "Keylight 906-0012": key.cb, "Keylight 906-0013": key.cw } }] }),
      area: layerRead(71, 1, { effects: [{ match: "ADBE Minimax", enabled: true, params: { "ADBE Minimax-0002": grow } }] }),
      wrap: [layerRead(72, 1, { name: "alpha", blending_mode: "multiply" }), layerRead(73, 2, { effects: [{ match: "ADBE Invert", enabled: true, params: {} }, { match: "ADBE Box Blur2", enabled: true, params: { "ADBE Box Blur2-0001": wrap.map } }] })],
    },
    order: [61, 62, 63, 64, 65, 66],
    comps: { key: { id: IDS.key }, area: { id: IDS.area }, wrap: { id: IDS.wrap } },
  });
  const parts = {
    comps: { key: { id: IDS.key, name: "Phone KEY" }, area: { id: IDS.area, name: "Phone AREA" }, wrap: { id: IDS.wrap, name: "Phone WRAP" } },
    layers: {
      wrap_in: { index: 1, id: IDS.wrap_in },
      wrap_out: { index: 2, id: IDS.wrap_out },
      wrap: { index: 3, id: IDS.wrapL },
      key: { index: 4, id: IDS.keyL },
      area: { index: 5, id: IDS.areaL },
      insert: { index: 6, id: IDS.insert },
    },
  };
  // The insert's pin corners on every frame of its span (10 fps, 1 s): moving 3 px a frame.
  const frames = Array.from({ length: 10 }, (_, f) => ({ t: f / 10, c: [[20 + 3 * f, 15], [140 + 3 * f, 15], [20 + 3 * f, 105], [140 + 3 * f, 105]], p: [80, 60] }));
  const existing = () =>
    built || opts.existing
      ? {
          layers: {
            key: { index: 4, id: IDS.keyL, source_id: IDS.key },
            area: opts.existing === "some" ? null : { index: 5, id: IDS.areaL, source_id: IDS.area },
            wrap: { index: 3, id: IDS.wrapL, source_id: IDS.wrap },
            wrap_in: { index: 1, id: IDS.wrap_in },
            wrap_out: { index: 2, id: IDS.wrap_out },
          },
          comps: { key: { id: IDS.key }, area: { id: IDS.area }, wrap: { id: IDS.wrap } },
        }
      : { layers: { key: null, area: null, wrap: null, wrap_in: null, wrap_out: null }, comps: { key: null, area: null, wrap: null } };
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "screenfgInfo") {
        return ok({
          comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, duration: 1, motion_blur: false, shutter_angle: 180, shutter_phase: -90 },
          ae_version: "27.0",
          can_set_track_matte: true,
          has_subtract: true,
          name: "Phone",
          insert: { index: 6, id: IDS.insert, name: "Phone INSERT", locked: false, enabled: true, in_point: 0, out_point: 1, source_kind: "comp", source_pixel_aspect: 1, motion_blur: false, opacity_keyed: false, effects: [], pin: "CC Power Pin", force_mb: null, frames, frames_truncated: false, ...opts.insert },
          plate: { index: 7, id: 99, name: "Plate", locked: false, enabled: true, source_kind: "footage" },
          plate_has_keylight: false,
          existing: existing(),
          ...opts.info,
        });
      }
      if (fn === "screenfgApply") {
        if (args.mode === "build") {
          built = true;
          grow = args.grow_px;
          wrap.map = args.map_radius;
          wrap.light = args.light_radius;
          if (args.insert_mb) mb = args.insert_mb;
          return ok({ built: true, name: args.name, ...parts, inner: { key: 70, area: 71, wrap_blur: 73 }, insert_mb: args.insert_mb ? { added: true, ...args.insert_mb } : null });
        }
        if (args.mode === "set") {
          const k = args.keylight;
          if (k) {
            if (k.enabled !== undefined) key.enabled = k.enabled;
            if (k.colour) key.colour = k.colour;
            if (k.clip_black !== undefined) key.cb = k.clip_black;
            if (k.clip_white !== undefined) key.cw = k.clip_white;
          }
          const w = args.wrap;
          if (w) {
            if (w.opacity !== undefined) wrap.opacity = w.opacity;
            if (w.colour) wrap.colour = w.colour;
            if (w.map_radius !== undefined) wrap.map = w.map_radius;
            if (w.light_radius !== undefined) wrap.light = w.light_radius;
          }
          if (args.grow_px !== undefined) grow = args.grow_px;
          if (args.insert_mb) mb = args.insert_mb;
          return ok({ set: ["done"], insert_mb: args.insert_mb ?? null });
        }
        if (args.mode === "remove") return ok({ removed: { layers: ["a", "b", "c", "d", "e"], comps: ["K", "A", "W"] } });
      }
      if (fn === "screenfgRead") {
        const r = read();
        opts.breakRead?.(r);
        return ok(r);
      }
      if (fn === "snapshotFrame") {
        if (opts.failRenders) throw new Error("render failed");
        const t = args.time;
        let pic: PNG;
        if (args.comp_id === IDS.area) pic = png((x, y) => [255, 255, 255, inArea(x, y) ? 1 : 0]);
        else if (args.comp_id === IDS.key) {
          pic = png((x, y) => {
            const p = platePx(x, y, t, !!opts.grey);
            return key.enabled ? [...p, keyAlpha(x, y, t, key)] : [...p, 1];
          });
        } else {
          pic = png((x, y) => {
            const p = platePx(x, y, t, !!opts.grey);
            const a = keyAlpha(x, y, t, key);
            return [0, 1, 2].map((c) => a * p[c] + (1 - a) * NEW[c]);
          });
        }
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(pic));
        return ok({ path: args.output_path, time: t });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn), state: { key, wrap, get mb() { return mb; } } };
}

const run = async (extra: Record<string, unknown> = {}, ae = fakeAe()) => {
  const out = (await tool.handler(AeScreenForegroundSchema.parse({ comp_id: 1, insert: { name: "Phone INSERT" }, expect: { project_path: "<unsaved>" }, max_samples: 4, ...extra }), ae.ctx)) as Out;
  return { out, ae };
};

describe("ae_screen_foreground (the tool, against a fake bridge)", () => {
  it("builds, measures the screen colour, the clips and the wrap on renders, writes them in three guarded writes, and checks the result", async () => {
    const { out, ae } = await run();
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("built");
    // Three guarded writes: build, Keylight on, clips and wrap.
    const applies = ae.calls.filter((c) => c.fn === "screenfgApply");
    expect(applies.map((c) => c.args.mode)).toEqual(["build", "set", "set"]);
    expect(applies[0].args).toMatchObject({ name: "Phone", insert: { index: 6, id: IDS.insert }, plate: { index: 7, id: 99 } });
    expect(out.receipts).toHaveLength(3);
    for (const r of out.receipts) expect(r.matches).toBe(true);
    // The screen colour, measured on the plate inside the area.
    out.key.screen_colour_8bit.forEach((v: number, c: number) => expect(Math.abs(v - GREEN[c])).toBeLessThanOrEqual(3));
    expect(out.key.screen).toBe("green");
    // The clips: just above the screen's raw 0.1 and just under the subject's 0.88.
    expect(out.key.clip_black).toBeCloseTo(12, 0);
    expect(out.key.clip_white).toBeCloseTo(86, 0);
    expect(ae.state.key).toMatchObject({ enabled: true, cb: out.key.clip_black, cw: out.key.clip_white });
    // The wrap: the edge carries the old screen (the plate mixes it in), so it is fitted and written.
    expect(out.wrap.fit).not.toBeNull();
    expect(out.wrap.strength).toBeGreaterThan(0);
    expect(ae.state.wrap.opacity).toBeCloseTo(out.wrap.strength * 100, 1);
    expect(ae.state.wrap.colour.map((v: number) => Math.round(v * 255))).toEqual(out.key.screen_colour_8bit);
    // The insert moves 3 px a frame and had no motion blur: CC Force Motion Blur, centred.
    expect(out.insert_motion_blur.set).toEqual({ angle: 180, phase: -90 });
    expect(ae.state.mb).toEqual({ angle: 180, phase: -90 });
    // The check: the subject is solid, nothing of the old screen is left, the subject's colour is the plate's.
    expect(out.check.quality.fg_see_through_pct).toBe(0);
    expect(out.check.quality.screen_left_p999).toBe(0);
    expect(out.check.quality.fg_colour_shift_levels).toBe(0);
    expect(out.check.edge.length).toBeGreaterThan(0);
    expect(fs.existsSync(out.sheet_path)).toBe(true);
    expect(out.measured_on.length).toBe(4);
  });

  it("re-tunes the parts an earlier call made instead of building them again", async () => {
    const { out, ae } = await run({ wrap: 0.4, insert_motion_blur: "keep" }, fakeAe({ existing: "all" }));
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("retuned");
    const applies = ae.calls.filter((c) => c.fn === "screenfgApply");
    expect(applies.map((c) => c.args.mode)).toEqual(["set", "set", "set"]);
    // The reset turns Keylight off and opens the clips, so the plate can be measured again.
    expect(applies[0].args.keylight).toMatchObject({ enabled: false, clip_black: 0, clip_white: 100 });
    expect(out.wrap.strength).toBe(0.4);
    expect(out.insert_motion_blur.set).toBeNull();
  });

  it("uses given clips and screen colour, and leaves the wrap off when asked", async () => {
    const { out, ae } = await run({ clip_black: 15, clip_white: 80, screen_colour: [0.38, 0.71, 0.22], wrap: "off", contact_sheet: false });
    expect(out.ok).toBe(true);
    expect(out.key.clip_black).toBe(15);
    expect(out.key.clip_white).toBe(80);
    expect(out.wrap.strength).toBe(0);
    expect(out.sheet_path).toBeUndefined();
    expect(ae.calls.filter((c) => c.fn === "screenfgApply")[1].args.keylight).toMatchObject({ clip_black: 15, clip_white: 80 });
  });

  it("says so and how to remove the parts when the screen is no key colour", async () => {
    const { out } = await run({}, fakeAe({ grey: true }));
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(true);
    expect(out.error).toBe("not_a_key_screen");
    expect(out.how_to_remove).toMatch(/remove: true/);
    expect(out.parts.comps).toMatchObject({ key: IDS.key });
  });

  it("removes the parts of an earlier call, and says when there are none", async () => {
    const gone = await run({ remove: true }, fakeAe({ existing: "all" }));
    expect(gone.out).toMatchObject({ ok: true, applied: true, removed_parts: true });
    expect(gone.ae.calls.find((c) => c.fn === "screenfgApply")!.args).toMatchObject({ mode: "remove", name: "Phone" });
    const none = await run({ remove: true });
    expect(none.out).toMatchObject({ ok: true, applied: false, no_op: true });
    expect(none.ae.fns()).not.toContain("screenfgApply");
  });

  it("refuses before writing: no plate, a locked insert, a plate with Keylight, half an earlier build, a keyframed opacity", async () => {
    const cases: Array<[FakeOpts, RegExp]> = [
      [{ info: { plate: null } }, /No plate layer/],
      [{ insert: { locked: true } }, /locked/],
      [{ info: { plate_has_keylight: true } }, /already has Keylight/],
      [{ existing: "some" }, /remove: true/],
      [{ insert: { opacity_keyed: true } }, /keyframed/],
      [{ info: { can_set_track_matte: false } }, /track mattes/],
    ];
    for (const [o, msg] of cases) {
      const { out, ae } = await run({}, fakeAe(o));
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(msg);
      expect(ae.fns()).not.toContain("screenfgApply");
    }
  });

  it("reports a write that did not stick in its receipt, and a render that fails after the build", async () => {
    const broken = await run({}, fakeAe({ breakRead: (r) => (r.layers.wrap_in.blending_mode = "normal") }));
    expect(broken.out.receipts[0].matches).toBe(false);
    const failed = await run({}, fakeAe({ failRenders: true }));
    expect(failed.out.ok).toBe(false);
    expect(failed.out.applied).toBe(true);
    expect(failed.out.error).toBe("no_frames");
  });
});
