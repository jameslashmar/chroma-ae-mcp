/** ae_color_match_element's fit: per-channel Levels from 1-3 pairs of element and plate values. */
import { describe, expect, it } from "vitest";
import { fitLevels, levelsApply, levelsInverse, type LevelsChannel } from "../src/tools/ext/elementmatch.js";

describe("element colour fit", () => {
  const truth: LevelsChannel = { in_black: 0.05, in_white: 0.9, gamma: 1.3, out_black: 0.02, out_white: 0.95 };
  // The element was made by undoing `truth`: matching it means finding `truth` again from three samples.
  const plateValues = [0.12, 0.45, 0.85];
  const pairs = plateValues.map((p) => ({ element: levelsInverse(truth, p), plate: p }));

  it("three pairs: black, white and gamma, and every tone in between follows", () => {
    const fit = fitLevels(pairs);
    for (const p of pairs) expect(levelsApply(fit, p.element)).toBeCloseTo(p.plate, 4);
    // A tone that was not sampled lands close too (the model is the same shape).
    const mid = levelsInverse(truth, 0.3);
    expect(Math.abs(levelsApply(fit, mid) - 0.3)).toBeLessThan(0.01);
  });

  it("two pairs: a straight line; one pair: a gain", () => {
    const two = fitLevels([{ element: 0.2, plate: 0.15 }, { element: 0.8, plate: 0.7 }]);
    expect(levelsApply(two, 0.2)).toBeCloseTo(0.15, 4);
    expect(levelsApply(two, 0.8)).toBeCloseTo(0.7, 4);
    expect(two.gamma).toBe(1);
    const one = fitLevels([{ element: 0.5, plate: 0.4 }]);
    expect(levelsApply(one, 0.5)).toBeCloseTo(0.4, 4);
    expect(levelsApply(one, 0)).toBeCloseTo(0, 4);
    // A brighter target sets the input white below 1 instead of an output white above it.
    const up = fitLevels([{ element: 0.5, plate: 0.6 }]);
    expect(up.out_white).toBeLessThanOrEqual(1);
    expect(levelsApply(up, 0.5)).toBeCloseTo(0.6, 4);
  });

  it("leaves a channel alone when the pairs say darker element means brighter plate", () => {
    expect(fitLevels([{ element: 0.2, plate: 0.8 }, { element: 0.8, plate: 0.2 }])).toEqual({ in_black: 0, in_white: 1, gamma: 1, out_black: 0, out_white: 1 });
  });
});

describe("element colour fit picks the simplest exact Levels", () => {
  const cases: Array<[string, LevelsChannel]> = [
    ["an output white (darker element)", { in_black: 0, in_white: 1, gamma: 1, out_black: 0, out_white: 0.85 }],
    ["a gamma", { in_black: 0, in_white: 1, gamma: 1.3, out_black: 0, out_white: 1 }],
    ["an output black (lifted blacks)", { in_black: 0, in_white: 1, gamma: 1, out_black: 0.06, out_white: 1 }],
  ];
  it.each(cases)("undoes %s", (_n, mismatch) => {
    // The element is the plate through `mismatch`; the fit must undo it for every tone, not only the three sampled.
    const pairs = [0.15, 0.45, 0.8].map((p) => ({ element: levelsApply(mismatch, p), plate: p }));
    const fit = fitLevels(pairs);
    for (const t of [0.1, 0.3, 0.6, 0.9]) expect(Math.abs(levelsApply(fit, levelsApply(mismatch, t)) - t)).toBeLessThan(0.006);
  });
});
