/**
 * server/src/tools/ext/path-check.ts
 *
 * A track's output checked for jumps, whatever method made it: every corner's path against the smooth
 * path the frames around it make. A camera shake moves, turns and scales the whole surface at once,
 * and can be as sharp as a footstep (Hollywood Camera Work's walking U-Haul plate: the true corners jolt
 * 20-26 px off a smooth path in one frame); what it hardly changes from one frame to the next is the
 * surface's shape: the corners against each other once the shift, turn and scale they share are taken
 * out (a similarity fitted to the reference quad). Each corner's place in that shape is checked at two
 * scales, each against a robust local fit through the frames around it:
 *
 * - a jump: off the curve through the two frames before and the two after it, by over CORNER_JUMP_PX
 *   (what the eye sees as a tick or a shake: an edge flicking between two parallel edges). The frame
 *   itself is left out of that curve: a fit through the frames around that includes them follows a
 *   flicker that comes every other or third frame and halves it. Only the frame that stands out most is
 *   flagged, not its neighbours (which a lone jump moves too);
 * - off its path: off the fit through the 12 frames on each side, by over CORNER_OFF_PX (an edge dragged
 *   away for several frames and back, smoothly enough that no single frame jumps: a hand's edge taken
 *   for the screen's while it crosses). A smooth bump of a pixel over half a dozen frames is the surface
 *   turning, not an error (the walking U-Haul's true corners make one), so this limit is higher.
 *
 * Taking the shared motion out takes part of a wrong move with it: one edge of a 16:10 screen moving by
 * d alone shows as about 0.42 d at every corner (the shape cannot say which edge moved, so frames are
 * flagged, not corners). The limits are set for that: an edge flicking by 1.5 px, or dragged by 5 px,
 * is over them; on the tuning plates (a licence plate, a walking U-Haul, both with true camera jolts)
 * no frame of a good track came within 0.46 px (jump) and 1.24 px (off its path) of them.
 *
 * The whole surface jumping (a repeating pattern matched one period over) cannot be told from a sharp
 * camera move by the path alone, so it is only reported (whole), never flagged.
 *
 * Off its path is only judged where the surface holds its shape. A board turned edge-on and back in
 * the hand (Hollywood Camera Work's green cloud: 388 px wide, 203 px twelve frames later, 376 px after
 * twelve more) changes its shape by 6-9 px a frame, and the fit through 25 frames cannot follow the turn:
 * a right track (checked by warping every frame back onto the reference) sat up to 55 px off it, and
 * flagging those frames would have left AE to interpolate straight across the turn. A wrong stretch and a
 * real wobble look the same in a path, so where the shape's own speed (the median step of the frames 3
 * to 12 away each side) is over FAST_SHAPE_PX, off-path is not checked and the frames are reported
 * (fast_frames); jumps still are. Every frame the check had rightly flagged on the tuning plates and the
 * held-out clips (a laptop, a green board, a window, a marked wall, a lens) had a speed of 2.1 px a frame
 * or less; the green cloud's turns ran at 2.9 to 7.7.
 *
 * A jump is measured against the frame's two neighbours each side as a curve, not as a line: the frame
 * against the quadratic through them (a turn speeding up or slowing down is a curve, and the line put the
 * turn's peak 2.7 px off; a lone tick, an every-other-frame or every-third-frame flicker still stand out
 * by their full size). Where those four are not all there, it is the plain half second difference.
 *
 * The local fit is a quadratic over the frames nearby (tricube weights), made robust the LOESS way
 * (Cleveland 1979: bisquare weights at 6 median residuals, a few rounds); the shape's fit starts from a
 * running median, so a wrong stretch of up to `shapeHalf` frames is still seen as off (a mean would follow
 * it). Pure: no AE, no files.
 */

import type { Vec2 } from "./planar-math.js";

export interface PathSample {
  /** Frame number (integer: time x fps). */
  frame: number;
  /** The tracked corners (or points), comp px. */
  points: Vec2[];
}

export interface PathFlag {
  frame: number;
  /** jump: off the short fit (one frame against its neighbours); off_path: off the long fit. */
  kind: "jump" | "off_path";
  /** How far the surface's shape is off, comp px: the corner furthest off. */
  px: number;
  limit_px: number;
}

export interface PathCheckResult {
  frames_checked: number;
  /** The shot's own corner noise from frame to frame (each corner in the surface's shape), a robust sigma, px. */
  corner_sigma_px: number;
  /** Over this a corner jumped: CORNER_JUMP_PX (scaled to the comp) or 6 sigma. */
  jump_limit_px: number;
  /** Over this a corner is off its path: CORNER_OFF_PX (scaled to the comp) or 6 times that fit's sigma. */
  off_limit_px: number;
  per_corner: Array<{ worst_jump_px: number; worst_jump_frame: number | null; jumps: number; worst_off_px: number; worst_off_frame: number | null; off_frames: number }>;
  /** The sharpest move of the surface's centre off its smooth path (camera shake, or a jump): reported only. */
  whole: { worst_px: number; worst_frame: number | null; sigma_px: number };
  /** Every frame over a limit, worst first (by how many times its limit). */
  flags: PathFlag[];
  /** Frames where the surface's shape moved faster than FAST_SHAPE_PX a frame: off-path not checked there (jumps are). */
  fast_frames: number;
  /** Those frames as [first, last] stretches. */
  fast_ranges: Array<[number, number]>;
  /** Frames over the jump limit that were kept: left out, AE's line between their neighbours would be further off. */
  jumps_kept: number[];
  /** Per checked frame: each corner's jump and distance off its path, and the whole surface's, px. */
  residuals: Array<{ frame: number; jump: number[]; off: number[]; whole: number }>;
}

/** A corner off the fit through its 3 neighbours each side by more than this (comp px at 1080 lines; scaled for taller comps) jumped. */
export const CORNER_JUMP_PX = 0.6;
/** A corner off the fit through its 12 neighbours each side by more than this (comp px at 1080 lines) is off its path. */
export const CORNER_OFF_PX = 2;
/** Times the shot's own noise (robust sigma) that also counts as off. */
export const SIGMA_TIMES = 6;
/** Over this local speed of the shape (comp px a frame at 1080 lines), the surface is turning too fast for the off-path test. */
export const FAST_SHAPE_PX = 2.5;
/**
 * The shape's speed at a frame is the median step of the frames FAST_INNER to FAST_OUTER away on either
 * side (its flanks), not of the frames next to it: a wrong stretch makes big steps of its own (the
 * glasses' lens flipping 20-30 px for six frames), and counted in, they made the stretch look like a turn.
 */
const FAST_INNER = 3;
const FAST_OUTER = 12;

export interface PathCheckOptions {
  /** Half the window of the off-path fit, frames. Default 12 (a wrong stretch of up to 12 frames shows). */
  shapeHalf?: number;
  /** Half the window of the centre's fit (reported only), frames. Default 6. */
  wholeHalf?: number;
  /** The comp's height, px: the limits scale with it from 1080 (a 4K comp's 1 px is half as big on screen). */
  compHeight?: number;
}

/** Robust sigma of 2-D residual lengths: the median of a Rayleigh is 1.1774 sigma. */
const rayleighSigma = (v: number[]): number => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] / 1.1774;
};

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The smooth path through (f, v): at each sample, a weighted quadratic through the samples within `half`
 * frames (tricube in the distance, times the robustness weights). When a side has no sample (the first
 * or last frames, or next to frames not ok), the window is the 2 x half frames on the other side and the
 * fit is a line.
 */
function localFit(f: number[], v: number[], rob: Float64Array, half: number): Float64Array {
  const n = f.length;
  const out = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < n && f[lo] < f[i] - 2 * half) lo++;
    while (hi < n - 1 && f[hi + 1] <= f[i] + 2 * half) hi++;
    let before = 0;
    let after = 0;
    for (let j = lo; j <= hi; j++) {
      const d = f[j] - f[i];
      if (d < 0 && d >= -half && rob[j] > 0) before++;
      if (d > 0 && d <= half && rob[j] > 0) after++;
    }
    const oneSided = before === 0 || after === 0;
    const reach = oneSided ? 2 * half : half;
    // Weighted sums for a + b d + c d^2.
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let t0 = 0;
    let t1 = 0;
    let t2 = 0;
    for (let j = lo; j <= hi; j++) {
      const d = f[j] - f[i];
      const a = Math.abs(d) / (reach + 1);
      if (a >= 1) continue;
      const w = (1 - a * a * a) ** 3 * rob[j];
      if (!(w > 0)) continue;
      const d2 = d * d;
      s0 += w;
      s1 += w * d;
      s2 += w * d2;
      s3 += w * d2 * d;
      s4 += w * d2 * d2;
      t0 += w * v[j];
      t1 += w * v[j] * d;
      t2 += w * v[j] * d2;
    }
    if (!(s0 > 0)) {
      out[i] = v[i];
      continue;
    }
    // One side only: a line. A quadratic there followed a wrong stretch at a track's end, where a track
    // that is losing its surface goes wrong (a green board's first frames, 2.4-3.3 px off its path, went
    // unflagged with it); the price is that the last frames of a surface turning fast can be flagged.
    if (!oneSided) {
      // Quadratic: solve [s0 s1 s2; s1 s2 s3; s2 s3 s4] [a b c] = [t0 t1 t2] for a (the value at d = 0).
      const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) > 1e-9 * Math.max(1, s0 * s2 * s4)) {
        out[i] = (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
        continue;
      }
    }
    // A line (one side only, or too few samples for a curve).
    const det2 = s0 * s2 - s1 * s1;
    out[i] = Math.abs(det2) > 1e-9 * Math.max(1, s0 * s2) ? (t0 * s2 - s1 * t1) / det2 : t0 / s0;
  }
  return out;
}

/**
 * The running median over the samples within `half` frames, the window kept symmetric near the ends (a
 * symmetric median follows a steady trend exactly; a one-sided one lags it by half the window).
 */
function runningMedian(f: number[], v: number[], half: number): Float64Array {
  const n = f.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, f[i] - f[0], f[n - 1] - f[i]);
    const win: number[] = [];
    for (let j = i; j >= 0 && f[j] >= f[i] - h; j--) win.push(v[j]);
    for (let j = i + 1; j < n && f[j] <= f[i] + h; j++) win.push(v[j]);
    out[i] = median(win);
  }
  return out;
}

/**
 * The robust smooth path of a 2-D series: (x, y) together share the robustness weights (a sample is off
 * or not as a point). `fromMedian` starts from a running median (holds against a wrong stretch), else from
 * a plain fit (follows a fast turn better).
 */
function robustPath(f: number[], xs: number[], ys: number[], half: number, fromMedian: boolean, floorPx: number): { x: Float64Array; y: Float64Array; res: Float64Array } {
  const n = f.length;
  const rob = new Float64Array(n).fill(1);
  let fx: Float64Array;
  let fy: Float64Array;
  if (fromMedian) {
    fx = runningMedian(f, xs, half);
    fy = runningMedian(f, ys, half);
  } else {
    fx = localFit(f, xs, rob, half);
    fy = localFit(f, ys, rob, half);
  }
  const res = new Float64Array(n);
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < n; i++) res[i] = Math.hypot(xs[i] - fx[i], ys[i] - fy[i]);
    const m = Math.max(floorPx, median(Array.from(res)));
    const c = 6 * m;
    for (let i = 0; i < n; i++) {
      const u = res[i] / c;
      rob[i] = u < 1 ? (1 - u * u) ** 2 : 0;
    }
    fx = localFit(f, xs, rob, half);
    fy = localFit(f, ys, rob, half);
  }
  for (let i = 0; i < n; i++) res[i] = Math.hypot(xs[i] - fx[i], ys[i] - fy[i]);
  return { x: fx, y: fy, res };
}

/**
 * Checks the corners' paths. `samples` are the frames the track solved (ok frames only), in any order;
 * every one has the same number of points. Fewer than 9 frames: nothing is checked (null).
 */
export function checkPaths(samples: PathSample[], opts: PathCheckOptions = {}): PathCheckResult | null {
  const s = samples.filter((x) => x.points.length > 0 && x.points.every((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))).sort((a, b) => a.frame - b.frame);
  if (s.length < 9) return null;
  const nPts = s[0].points.length;
  if (s.some((x) => x.points.length !== nPts)) return null;
  const shapeHalf = Math.max(3, Math.round(opts.shapeHalf ?? 12));
  const wholeHalf = Math.max(2, Math.round(opts.wholeHalf ?? 6));
  const k = Math.max(1, (opts.compHeight ?? 1080) / 1080);
  const f = s.map((x) => x.frame);
  const n = s.length;
  const cx = s.map((x) => x.points.reduce((t, p) => t + p[0], 0) / nPts);
  const cy = s.map((x) => x.points.reduce((t, p) => t + p[1], 0) / nPts);
  const whole = robustPath(f, cx, cy, wholeHalf, false, 0.05 * k);
  // The shape: each frame's corners less the similarity (shift, turn, scale) that best maps the first
  // checked frame's corners onto them. Two points or fewer have no shape left: nothing to check.
  const jump: Float64Array[] = [];
  const off: Float64Array[] = [];
  // Per frame: whether the shape moves too fast there for the off-path test.
  const fast = new Uint8Array(n);
  // Per frame: how far the line between its two neighbours (what AE puts there when the frame is not
  // written) is off the curve through its four neighbours, the corner furthest off.
  const dropCost = new Float64Array(n);
  if (nPts > 2) {
    const ref = s[0].points;
    const rcx = ref.reduce((t, p) => t + p[0], 0) / nPts;
    const rcy = ref.reduce((t, p) => t + p[1], 0) / nPts;
    const q = ref.map((p) => [p[0] - rcx, p[1] - rcy]);
    const qq = q.reduce((t, p) => t + p[0] * p[0] + p[1] * p[1], 0) || 1;
    const shx: number[][] = q.map(() => []);
    const shy: number[][] = q.map(() => []);
    s.forEach((x, i) => {
      // P - c = (a + ib) (Q - qc): least squares a, b.
      let a = 0;
      let b = 0;
      x.points.forEach((p, c) => {
        const px = p[0] - cx[i];
        const py = p[1] - cy[i];
        a += px * q[c][0] + py * q[c][1];
        b += py * q[c][0] - px * q[c][1];
      });
      a /= qq;
      b /= qq;
      x.points.forEach((p, c) => {
        shx[c].push(p[0] - cx[i] - (a * q[c][0] - b * q[c][1]));
        shy[c].push(p[1] - cy[i] - (b * q[c][0] + a * q[c][1]));
      });
    });
    for (let c = 0; c < nPts; c++) {
      // Off the quadratic through the two neighbours each side ((4 (v-1 + v+1) - (v-2 + v+2)) / 6 at the
      // frame), or half the second difference where only one neighbour each side is there (0 where not
      // even that: not checked for jumps).
      const d = new Float64Array(n);
      const X = shx[c];
      const Y = shy[c];
      for (let i = 1; i < n - 1; i++) {
        if (f[i] - f[i - 1] !== 1 || f[i + 1] - f[i] !== 1) continue;
        if (i >= 2 && i < n - 2 && f[i] - f[i - 2] === 2 && f[i + 2] - f[i] === 2) {
          const qx = (4 * (X[i - 1] + X[i + 1]) - (X[i - 2] + X[i + 2])) / 6;
          const qy = (4 * (Y[i - 1] + Y[i + 1]) - (Y[i - 2] + Y[i + 2])) / 6;
          d[i] = Math.hypot(X[i] - qx, Y[i] - qy);
          dropCost[i] = Math.max(dropCost[i], Math.hypot((X[i - 1] + X[i + 1]) / 2 - qx, (Y[i - 1] + Y[i + 1]) / 2 - qy));
        } else {
          d[i] = Math.hypot(X[i] - (X[i - 1] + X[i + 1]) / 2, Y[i] - (Y[i - 1] + Y[i + 1]) / 2);
        }
      }
      jump.push(d);
      off.push(robustPath(f, shx[c], shy[c], shapeHalf, true, 0.03 * k).res);
    }
    // The shape's step from the frame before (the corner that moved most), on consecutive frames.
    const step: Array<number | null> = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      if (f[i] - f[i - 1] !== 1) continue;
      let m = 0;
      for (let c = 0; c < nPts; c++) m = Math.max(m, Math.hypot(shx[c][i] - shx[c][i - 1], shy[c][i] - shy[c][i - 1]));
      step[i] = m;
    }
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      while (f[lo] < f[i] - FAST_OUTER) lo++;
      while (hi < n - 1 && f[hi + 1] <= f[i] + FAST_OUTER) hi++;
      // Each flank on its own, the faster one counting: a turn that starts or stops next to the frame
      // shows on one side only.
      const before: number[] = [];
      const after: number[] = [];
      for (let j = lo; j <= hi; j++) {
        if (step[j] === null || Math.abs(f[j] - f[i]) < FAST_INNER) continue;
        (f[j] < f[i] ? before : after).push(step[j] as number);
      }
      const speed = Math.max(before.length >= 3 ? median(before) : 0, after.length >= 3 ? median(after) : 0);
      if (speed > FAST_SHAPE_PX * k) fast[i] = 1;
    }
  }
  const checkable: number[] = [];
  for (let i = 1; i < n - 1; i++) if (f[i] - f[i - 1] === 1 && f[i + 1] - f[i] === 1) checkable.push(i);
  const cornerSigma = jump.length ? rayleighSigma(jump.flatMap((r) => checkable.map((i) => r[i]))) : 0;
  const offSigma = off.length ? rayleighSigma(off.flatMap((r) => Array.from(r))) : 0;
  const wholeSigma = rayleighSigma(Array.from(whole.res));
  const jumpLimit = Math.max(CORNER_JUMP_PX * k, SIGMA_TIMES * cornerSigma);
  const offLimit = Math.max(CORNER_OFF_PX * k, SIGMA_TIMES * offSigma);
  // The first and last frames are fitted from one side only: a looser off-path limit there.
  const edge = (i: number) => (i < 2 || i >= n - 2 ? 1.5 : 1);
  const flags: PathFlag[] = [];
  const worstOf = (r: Float64Array, limit: number, skipFast: boolean) => {
    let worst = 0;
    let at: number | null = null;
    let over = 0;
    for (let i = 0; i < n; i++) {
      if (skipFast && fast[i]) continue;
      if (r[i] > worst) {
        worst = r[i];
        at = f[i];
      }
      if (r[i] > limit * edge(i)) over++;
    }
    return { worst: round2(worst), at, over };
  };
  const perCorner = jump.map((rj, c) => {
    const a = worstOf(rj, jumpLimit, false);
    const b = worstOf(off[c], offLimit, true);
    return { worst_jump_px: a.worst, worst_jump_frame: a.at, jumps: a.over, worst_off_px: b.worst, worst_off_frame: b.at, off_frames: b.over };
  });
  const jmax = (i: number) => (i < 0 || i >= n ? 0 : Math.max(...jump.map((r) => r[i])));
  const kept: number[] = [];
  for (let i = 0; jump.length && i < n; i++) {
    const rj = jmax(i);
    const ro = Math.max(...off.map((r) => r[i]));
    // A jump at the frame that stands out most: a lone jump moves its neighbours' residuals too. Not
    // flagged when leaving the frame out would put it further off: where the surface speeds up or slows
    // down, AE's straight line between the neighbours misses the curve by more than the frame does.
    const isJump = rj > jumpLimit && rj >= jmax(i - 1) && rj >= jmax(i + 1);
    if (isJump && rj > dropCost[i]) flags.push({ frame: f[i], kind: "jump", px: round2(rj), limit_px: round2(jumpLimit) });
    else if (!fast[i] && ro > offLimit * edge(i)) flags.push({ frame: f[i], kind: "off_path", px: round2(ro), limit_px: round2(offLimit * edge(i)) });
    else if (isJump) kept.push(f[i]);
  }
  const fastRanges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (!fast[i]) continue;
    const last = fastRanges[fastRanges.length - 1];
    if (last && f[i] - last[1] <= 1) last[1] = f[i];
    else fastRanges.push([f[i], f[i]]);
  }
  let wWorst = 0;
  let wFrame: number | null = null;
  for (let i = 0; i < n; i++) {
    if (whole.res[i] > wWorst) {
      wWorst = whole.res[i];
      wFrame = f[i];
    }
  }
  flags.sort((a, b) => b.px / b.limit_px - a.px / a.limit_px);
  return {
    frames_checked: n,
    corner_sigma_px: round2(cornerSigma),
    jump_limit_px: round2(jumpLimit),
    off_limit_px: round2(offLimit),
    per_corner: perCorner,
    whole: { worst_px: round2(wWorst), worst_frame: wFrame, sigma_px: round2(wholeSigma) },
    flags,
    fast_frames: fast.reduce((t, v) => t + v, 0),
    fast_ranges: fastRanges,
    jumps_kept: kept,
    residuals: f.map((fr, i) => ({ frame: fr, jump: jump.map((r) => r[i]), off: off.map((r) => r[i]), whole: whole.res[i] })),
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
