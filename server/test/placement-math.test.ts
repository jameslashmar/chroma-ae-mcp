import { describe, expect, it } from "vitest";
import { fitSource, layerRect, maskBoxInComp, regionToLayerSpace, sameRect } from "../src/tools/ext/placement-math.js";

describe("fitSource", () => {
  const region: [number, number, number, number] = [100, 50, 640, 640];

  it("contain: the whole 1920x1080 picture in a square, bars above and below", () => {
    const p = fitSource(1920, 1080, region, "contain");
    expect(p.scale).toEqual([33.3333, 33.3333]);
    expect(p.covered).toEqual([640, 360]);
    expect(p.position).toEqual([420, 370]);
    expect(p.anchor).toEqual([960, 540]);
    expect(p.rect).toEqual([100, 190, 640, 360]);
  });

  it("fill: the square is covered and the long side crops evenly", () => {
    const p = fitSource(1920, 1080, region, "fill");
    expect(p.scale[0]).toBeCloseTo(59.2593, 4);
    expect(p.scale[1]).toBe(p.scale[0]);
    expect(p.covered[1]).toBe(640);
    expect(p.covered[0]).toBeCloseTo(1137.7778, 3);
    expect(p.position).toEqual([420, 370]);
    expect(p.rect[0]).toBeCloseTo(420 - 568.8889, 3);
    expect(p.rect[1]).toBe(50);
  });

  it("stretch: each axis on its own", () => {
    const p = fitSource(1920, 1080, region, "stretch");
    expect(p.scale[0]).toBeCloseTo(33.3333, 4);
    expect(p.scale[1]).toBeCloseTo(59.2593, 4);
    expect(p.covered).toEqual([640, 640]);
    expect(p.rect).toEqual([100, 50, 640, 640]);
  });

  it("align puts the slack where asked: 0 is left / top, 1 is right / bottom", () => {
    expect(fitSource(1920, 1080, region, "contain", [0, 0]).rect).toEqual([100, 50, 640, 360]);
    expect(fitSource(1920, 1080, region, "contain", [1, 1]).rect).toEqual([100, 330, 640, 360]);
    const wide = fitSource(1920, 1080, region, "fill", [0, 0.5]);
    expect(wide.rect[0]).toBe(100);
    expect(fitSource(1920, 1080, region, "fill", [1, 0.5]).rect[0] + fitSource(1920, 1080, region, "fill", [1, 0.5]).rect[2]).toBeCloseTo(740, 3);
  });

  it("a region of the picture's own size is placed at 100%", () => {
    const p = fitSource(640, 360, [10, 20, 640, 360], "fill");
    expect(p.scale).toEqual([100, 100]);
    expect(p.rect).toEqual([10, 20, 640, 360]);
  });

  it("keeps sub-pixel regions and odd sizes exact enough to compare", () => {
    const p = fitSource(641, 361, [0.25, 0.5, 100.5, 50.25], "stretch");
    expect(sameRect(p.rect, [0.25, 0.5, 100.5, 50.25], 0.001)).toBe(true);
    expect(p.anchor).toEqual([320.5, 180.5]);
  });

  it("layerRect gives back the box a placement covers", () => {
    for (const fit of ["fill", "contain", "stretch"] as const) {
      const p = fitSource(1920, 1080, [33, 17, 777, 333], fit, [0.3, 0.8]);
      expect(sameRect(layerRect(1920, 1080, p), p.rect, 0.01)).toBe(true);
    }
  });
});

describe("regionToLayerSpace", () => {
  it("maps the region back through the layer's scale, position and anchor", () => {
    const region: [number, number, number, number] = [100, 50, 640, 640];
    const p = fitSource(1920, 1080, region, "fill");
    // The visible part of the 1920x1080 source is its middle 1080x1080.
    const corners = regionToLayerSpace(region, p);
    expect(corners[0][0]).toBeCloseTo(420, 2);
    expect(corners[0][1]).toBeCloseTo(0, 2);
    expect(corners[2][0]).toBeCloseTo(1500, 2);
    expect(corners[2][1]).toBeCloseTo(1080, 2);
  });
});

describe("maskBoxInComp", () => {
  const square = [[0, 0], [200, 0], [200, 100], [0, 100]];

  it("is the polygon box through position and scale", () => {
    expect(maskBoxInComp(square, { anchor: [0, 0], position: [100, 50], scale: [100, 100] })).toEqual([100, 50, 200, 100]);
    expect(maskBoxInComp(square, { anchor: [100, 50], position: [500, 300], scale: [200, 200] })).toEqual([300, 200, 400, 200]);
  });

  it("goes through rotation and scale together", () => {
    // 50 % and 90 degrees: (x, y) -> (500 - 0.5 y, 200 + 0.5 x).
    expect(maskBoxInComp(square, { anchor: [0, 0], position: [500, 200], scale: [50, 50], rotation: 90 })).toEqual([450, 200, 50, 100]);
  });
});
