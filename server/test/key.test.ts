import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  AeKeyGreenScreenSchema,
  detectScreenColor,
  keyAdvice,
  keyPreview,
  keyTimes,
  measureKey,
  worstMetrics,
  type KeyMetrics,
} from "../src/tools/ext/key.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";

const W = 100;
const H = 60;
const GREEN: [number, number, number] = [0.1, 0.75, 0.2];
const SKIN: [number, number, number] = [0.85, 0.65, 0.55];

/** A plate: green everywhere except a skin-coloured box in the middle (x 30..69, y 15..44). */
function plate(screen = GREEN): PNG {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 30 && x < 70 && y >= 15 && y < 45;
      const c = inside ? SKIN : screen;
      const i = (y * W + x) * 4;
      png.data[i] = Math.round(c[0] * 255);
      png.data[i + 1] = Math.round(c[1] * 255);
      png.data[i + 2] = Math.round(c[2] * 255);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/** The plate keyed: screen alpha `screenAlpha`, and a `holeAlpha` patch inside the subject. */
function keyed(src: PNG, screenAlpha: number, holeAlpha = 1, holeSize = 0, greenCast = 0): PNG {
  const out = new PNG({ width: W, height: H });
  src.data.copy(out.data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = x >= 30 && x < 70 && y >= 15 && y < 45;
      if (!inside) out.data[i + 3] = Math.round(screenAlpha * 255);
      else {
        if (x >= 45 && x < 45 + holeSize && y >= 25 && y < 25 + holeSize) out.data[i + 3] = Math.round(holeAlpha * 255);
        out.data[i + 1] = Math.min(255, out.data[i + 1] + greenCast);
      }
    }
  }
  return out;
}

describe("ae_key_greenscreen analysis", () => {
  it("is registered and takes automatic checkpoints", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_key_greenscreen")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_key_greenscreen");
  });

  it("detects a green screen, a blue one, and the lack of one", () => {
    const g = detectScreenColor(plate())!;
    expect(g.kind).toBe("green");
    expect(g.color[1]).toBeCloseTo(0.75, 2);
    expect(g.coverage).toBeCloseTo(0.8, 2);
    expect(detectScreenColor(plate([0.1, 0.25, 0.85]))!.kind).toBe("blue");
    expect(detectScreenColor(plate([0.5, 0.5, 0.5]))).toBeNull();
  });

  it("measures a clean key as clean", () => {
    const before = plate();
    const m = measureKey(before, keyed(before, 0), GREEN);
    expect(m.screen_pixels_pct).toBeCloseTo(80, 0);
    expect(m.screen_left_pct).toBe(0);
    expect(m.holes_pct).toBe(0);
    expect(m.spill_after).toBe(0);
    expect(m.subject_color_shift).toBe(0);
  });

  it("measures screen left behind, holes and spill", () => {
    const before = plate();
    const m = measureKey(before, keyed(before, 0.3, 0.5, 10, 60), GREEN);
    expect(m.screen_left_pct).toBe(100);
    expect(m.screen_residual_alpha).toBeCloseTo(0.3, 2);
    expect(m.holes_pct).toBeGreaterThan(5);
    expect(m.spill_after).toBeGreaterThan(0);
    expect(m.subject_color_shift).toBeCloseTo(60 / (3 * 255), 3);
    expect(m.recoloured_pct).toBeGreaterThan(90); // green moved by 60 of 255 on every subject pixel
  });

  it("catches a small recoloured prop that the mean shift hides", () => {
    const before = plate();
    const after = keyed(before, 0);
    // Turn a 10x10 corner of the subject from skin to brown, as despill does to an olive prop.
    for (let y = 15; y < 25; y++) {
      for (let x = 30; x < 40; x++) {
        const i = (y * W + x) * 4;
        after.data[i] = 90;
        after.data[i + 1] = 66;
        after.data[i + 2] = 42;
      }
    }
    const m = measureKey(before, after, GREEN);
    expect(m.subject_color_shift).toBeLessThan(0.06);
    expect(m.recoloured_pct).toBeGreaterThan(2);
  });

  it("does not count the subject's edge as holes", () => {
    const before = plate();
    const after = keyed(before, 0);
    // Soften the subject's outermost ring, as a real key does.
    for (let y = 15; y < 45; y++) {
      for (const x of [30, 69]) after.data[(y * W + x) * 4 + 3] = 128;
    }
    expect(measureKey(before, after, GREEN).holes_pct).toBe(0);
  });

  it("turns metrics into findings with ready ae_set_effect fixes", () => {
    const kl = { index: 1, clip_black: 0, clip_white: 100, screen_gain: 100 };
    const target = { comp_id: 3, layer_id: 9, expect: { project_path: "C:/jobs/Shot.aep", comp_id: 3 } };
    const bad: KeyMetrics = { screen_pixels_pct: 80, subject_pixels_pct: 15, screen_left_pct: 12, screen_residual_alpha: 0.2, holes_pct: 3, spill_before: 0.1, spill_after: 0.08, subject_color_shift: 0.1, recoloured_pct: 20 };
    const advice = keyAdvice(bad, kl, target);
    expect(advice.verdict).toBe("needs_work");
    expect(advice.findings.map((f) => f.issue)).toEqual(["screen_left", "holes", "spill", "color_shift"]);
    expect(advice.findings[0].fix).toEqual({
      tool: "ae_set_effect",
      args: { comp_id: 3, layer: { id: 9 }, effect: { index: 1 }, params: [{ param: "Keylight 906-0012", value: 20 }], expect: target.expect },
    });
    expect((advice.findings[1].fix as any).args.params[0]).toEqual({ param: "Keylight 906-0013", value: 90 });
    const clean = { ...bad, screen_left_pct: 0, holes_pct: 0, spill_after: 0.01, subject_color_shift: 0.02, recoloured_pct: 0.5 };
    expect(keyAdvice(clean, kl, target)).toEqual({ verdict: "clean", findings: [] });
  });

  it("keeps the worst frame", () => {
    const a: KeyMetrics = { screen_pixels_pct: 80, subject_pixels_pct: 15, screen_left_pct: 0.1, screen_residual_alpha: 0.01, holes_pct: 2, spill_before: 0.1, spill_after: 0.01, subject_color_shift: 0, recoloured_pct: 0 };
    const b = { ...a, screen_left_pct: 4, holes_pct: 0 };
    expect(worstMetrics([a, b])).toMatchObject({ screen_left_pct: 4, holes_pct: 2 });
  });

  it("picks start, middle and end of the layer inside the work area", () => {
    const info = { comp: { fps: 25, workAreaStart: 0, workAreaDuration: 4 }, layer: { inPoint: 1, outPoint: 10 } };
    expect(keyTimes(info)).toEqual([1, 2.48, 3.96]);
  });

  it("lays out before and after side by side, a row per frame", () => {
    const p = plate();
    const img = keyPreview([{ before: p, after: keyed(p, 0) }, { before: p, after: keyed(p, 0) }], 50);
    expect(img.width).toBe(50 * 2 + 18);
    expect(img.height).toBe((30 + 6) * 2 + 6);
  });

  it("needs expect unless it only checks", () => {
    expect(AeKeyGreenScreenSchema.safeParse({ comp_id: 1, layer: { index: 1 } }).success).toBe(false);
    expect(AeKeyGreenScreenSchema.safeParse({ comp_id: 1, layer: { index: 1 }, check_only: true }).success).toBe(true);
    expect(AeKeyGreenScreenSchema.safeParse({ comp_id: 1, layer: { index: 1 }, expect: { project_path: "<unsaved>" } }).success).toBe(true);
  });
});
