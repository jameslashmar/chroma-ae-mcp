import { describe, expect, it } from "vitest";
import { deltaE, fontMatches, hexToRgb, isNeutral, nearestBrand, rgbToHex } from "../src/style.js";

describe("colour", () => {
  it("round-trips hex", () => {
    expect(hexToRgb("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(rgbToHex([1, 128 / 255, 0])).toBe("#ff8000");
    expect(() => hexToRgb("orange")).toThrow();
  });

  it("measures delta E like the eye: a near red is close, blue is far", () => {
    expect(deltaE([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(deltaE([1, 0, 0], [0.97, 0.02, 0.02])).toBeLessThan(5);
    expect(deltaE([1, 0, 0], [0, 0, 1])).toBeGreaterThan(150);
    // Black to white is 100 in L*.
    expect(deltaE([0, 0, 0], [1, 1, 1])).toBeCloseTo(100, 0);
  });

  it("treats black, white and greys as neutral", () => {
    expect(isNeutral([0.5, 0.5, 0.5])).toBe(true);
    expect(isNeutral([1, 1, 1])).toBe(true);
    expect(isNeutral([0.5, 0.45, 0.5])).toBe(false);
  });

  it("finds the nearest brand colour", () => {
    expect(nearestBrand([0.95, 0.05, 0.05], ["#0000FF", "#FF0000"])).toMatchObject({ hex: "#ff0000" });
    expect(nearestBrand([1, 0, 0], [])).toBeNull();
  });
});

describe("fontMatches", () => {
  it("matches families and PostScript names however the brief writes them", () => {
    expect(fontMatches({ font: "Gotham-Bold", family: "Gotham" }, ["Gotham"])).toBe(true);
    expect(fontMatches({ font: "Gotham-Bold", family: "Gotham" }, ["gotham bold"])).toBe(true);
    expect(fontMatches({ font: "HelveticaNeue-Medium", family: "Helvetica Neue" }, ["Helvetica Neue"])).toBe(true);
    expect(fontMatches({ font: "ArialMT", family: "Arial" }, ["Gotham", "Helvetica Neue"])).toBe(false);
  });
});
