/**
 * server/src/tools/ext/placement-math.ts
 *
 * Pure maths for ae_layout_apply: fitting a source into a rectangle, the
 * layer-space clip mask, and the box a placed layer covers. Pixels, origin at
 * the top-left of the comp, square pixels only. No After Effects here.
 */

/** x, y, width, height. */
export type Rect = [number, number, number, number];
export type FitMode = "fill" | "contain" | "stretch";

export interface Placement {
  /** Layer Scale in percent. */
  scale: [number, number];
  /** Layer Position, comp pixels. */
  position: [number, number];
  /** Layer Anchor Point, layer pixels: the source centre. */
  anchor: [number, number];
  /** Size of the placed picture in comp pixels. */
  covered: [number, number];
  /** The box the placed layer covers (not the clip), [x, y, w, h]. */
  rect: Rect;
}

const round = (v: number, places = 4) => {
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
};

/**
 * Fits a `sw` x `sh` source into `region`. contain: the whole source shows,
 * bars on the short side. fill: the region is covered, the long side crops.
 * stretch: each axis on its own. `align` is where the slack goes (0 = left /
 * top, 1 = right / bottom, default centred). The anchor is the source centre
 * and rotation is 0.
 */
export function fitSource(sw: number, sh: number, region: Rect, fit: FitMode = "fill", align: [number, number] = [0.5, 0.5]): Placement {
  const [x, y, w, h] = region;
  let sx: number;
  let sy: number;
  if (fit === "stretch") {
    sx = w / sw;
    sy = h / sh;
  } else if (fit === "contain") {
    sx = sy = Math.min(w / sw, h / sh);
  } else {
    sx = sy = Math.max(w / sw, h / sh);
  }
  const cw = sw * sx;
  const ch = sh * sy;
  // Region centre plus (align - 0.5) times the slack.
  const px = x + w / 2 + (align[0] - 0.5) * (w - cw);
  const py = y + h / 2 + (align[1] - 0.5) * (h - ch);
  return {
    scale: [round(sx * 100), round(sy * 100)],
    position: [round(px), round(py)],
    anchor: [round(sw / 2), round(sh / 2)],
    covered: [round(cw), round(ch)],
    rect: [round(px - cw / 2), round(py - ch / 2), round(cw), round(ch)],
  };
}

/** The box a layer covers for the numbers a placement writes (no rotation). */
export function layerRect(sw: number, sh: number, p: Pick<Placement, "scale" | "position" | "anchor">): Rect {
  const cw = (sw * p.scale[0]) / 100;
  const ch = (sh * p.scale[1]) / 100;
  return [round(p.position[0] - (p.anchor[0] * p.scale[0]) / 100), round(p.position[1] - (p.anchor[1] * p.scale[1]) / 100), round(cw), round(ch)];
}

/**
 * The four corners of a comp-space rectangle in layer space, for the clip
 * mask: through the layer's scale, position and anchor (rotation 0).
 */
export function regionToLayerSpace(region: Rect, p: Pick<Placement, "scale" | "position" | "anchor">): number[][] {
  const [x, y, w, h] = region;
  const toLayer = (cx: number, cy: number) => [round(((cx - p.position[0]) * 100) / p.scale[0] + p.anchor[0]), round(((cy - p.position[1]) * 100) / p.scale[1] + p.anchor[1])];
  return [toLayer(x, y), toLayer(x + w, y), toLayer(x + w, y + h), toLayer(x, y + h)];
}

/**
 * The comp-space box of a mask, from its vertices in layer space, through a
 * 2D layer's anchor, scale (percent), rotation (degrees) and position.
 */
export function maskBoxInComp(
  vertices: number[][],
  layer: { anchor: [number, number]; position: [number, number]; scale: [number, number]; rotation?: number }
): Rect {
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const cs = Math.cos(rad);
  const sn = Math.sin(rad);
  const a = (cs * layer.scale[0]) / 100;
  const b = (-sn * layer.scale[1]) / 100;
  const d = (sn * layer.scale[0]) / 100;
  const e = (cs * layer.scale[1]) / 100;
  const c = layer.position[0] - (a * layer.anchor[0] + b * layer.anchor[1]);
  const f = layer.position[1] - (d * layer.anchor[0] + e * layer.anchor[1]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [vx, vy] of vertices) {
    const X = a * vx + b * vy + c;
    const Y = d * vx + e * vy + f;
    x0 = Math.min(x0, X);
    y0 = Math.min(y0, Y);
    x1 = Math.max(x1, X);
    y1 = Math.max(y1, Y);
  }
  return [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)];
}

/** Whether two boxes agree to within `tol` pixels on every edge value. */
export function sameRect(a: Rect, b: Rect, tol = 0.5): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}
