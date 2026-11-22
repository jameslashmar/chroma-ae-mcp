#!/usr/bin/env node
// qa/calibrate-compositing.mjs — measures the compositing tools against answers After Effects
// itself knows: a photo moved by keyframed Corner Pin or Transform values (the true motion is the
// keys), with blur, grain, low contrast or motion blur on top. The tools never see the keys; the
// harness compares what they found with them.
//
//   node qa/calibrate-compositing.mjs --plate <image or video> [--plate-time <s>] [--dir <work dir>] [--only track]
//
// --plate is real footage or a photograph (synthetic noise flatters a tracker): an image, or a video
// from which one frame (--plate-time, default 4 s) is taken with ffmpeg. On macOS the aerial
// screensaver clips in /Library/Application Support/com.apple.idleassetsd/Customer work well (pick
// one with buildings or trees, not open water). Nothing from the plate is committed. Same isolation rules as qa/smoke-mcp.mjs: an unsaved empty project or one under
// /_work/qa. Writes qa/out/calibration.json and prints a table. It measures; it never fails a run
// on a number, because the point is to see the numbers.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient, DEFAULT_HOST, DEFAULT_PORT, readToken } from "./client.js";
import { assertSafeInitialProject, resetQaProject } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// pngjs comes with the server's dependencies.
const { PNG } = createRequire(path.join(__dirname, "..", "server", "package.json"))("pngjs");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const ROOT = path.resolve(arg("--dir") ?? path.join(os.tmpdir(), "_work", "qa", "calibrate", stamp));
const ONLY = (arg("--only") ?? "").split(",").filter(Boolean);
const want = (part) => ONLY.length === 0 || ONLY.includes(part);

const W = 960;
const H = 540;
const FPS = 25;
const DUR = 2;
const FRAMES = DUR * FPS;
const END = (FRAMES - 1) / FPS;

// ---------- MCP ----------

const token = readToken();
let seq = 0;
function postMcp(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: DEFAULT_HOST,
        port: Number(process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT,
        method: "POST",
        path: "/mcp",
        timeout: 900_000,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-chroma-client": "qa-calibrate" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data ? JSON.parse(data) : null));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function call(name, args = {}) {
  const r = await postMcp({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } });
  if (r.error) return { ok: false, __error: r.error.message };
  const text = r.result.content.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, __text: text };
  }
}
const brief = (r) => JSON.stringify(r).slice(0, 400);

// ---------- geometry ----------

/** Solves the 8 unknowns of the homography taking src[i] to dst[i] (4 points). Row-major 3x3, h33 = 1. */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}
const mul = (a, b) => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const inv = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
};
const apply = (m, [x, y]) => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const stats = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, mean: r3(v.reduce((a, x) => a + x, 0) / v.length), p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(v[v.length - 1]) };
};
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------- the true motion ----------

const RECT = [
  [0, 0],
  [W, 0],
  [0, H],
  [W, H],
]; // Corner Pin order: UL, UR, LL, LR

/** Corner Pin corners at time t: a similarity plus a perspective lean, `speed` times the base amplitude. */
function pinCorners(t, speed) {
  const u = t / DUR;
  const s = 1 + 0.06 * Math.sin(Math.PI * u);
  const th = ((3 * Math.PI) / 180) * Math.sin(2 * Math.PI * u) * speed;
  const tx = 40 * speed * Math.sin(2 * Math.PI * u);
  const ty = 20 * speed * Math.sin(Math.PI * u);
  const lean = 30 * Math.sin(Math.PI * u) * Math.min(speed, 2);
  const c = [W / 2, H / 2];
  return RECT.map(([x, y], i) => {
    const dx = (x - c[0]) * s;
    const dy = (y - c[1]) * s;
    let px = c[0] + dx * Math.cos(th) - dy * Math.sin(th) + tx;
    const py = c[1] + dx * Math.sin(th) + dy * Math.cos(th) + ty;
    if (i < 2) px += i === 0 ? lean : -lean; // the top edge narrows: a tilt away
    return [px, py];
  });
}

/** Transform values at time t for the motion-blur shot (only a similarity: AE blurs transform motion, not pins). */
function transformAt(t, speed) {
  const u = t / DUR;
  return {
    position: [W / 2 + 40 * speed * Math.sin(2 * Math.PI * u), H / 2 + 20 * speed * Math.sin(Math.PI * u)],
    scale: 100 * (1 + 0.06 * Math.sin(Math.PI * u)),
    rotation: 3 * speed * Math.sin(2 * Math.PI * u),
  };
}
function transformMatrix({ position, scale, rotation }) {
  const s = scale / 100;
  const th = (rotation * Math.PI) / 180;
  const T = [1, 0, position[0], 0, 1, position[1], 0, 0, 1];
  const R = [Math.cos(th) * s, -Math.sin(th) * s, 0, Math.sin(th) * s, Math.cos(th) * s, 0, 0, 0, 1];
  const A = [1, 0, -W / 2, 0, 1, -H / 2, 0, 0, 1];
  return mul(T, mul(R, A));
}

const lerp = (a, b, f) => a + (b - a) * f;

/**
 * True ref-frame comp px -> comp px at frame i. A motion-blurred frame shows the layer averaged over
 * the shutter, so its truth is the keys at the middle of the shutter: (phase + angle / 2) / 360 frames
 * after the frame (a quarter frame with AE's scripted defaults, phase 0 and angle 180), between the
 * per-frame linear keys. The reference frame is blurred the same way.
 */
function trueH(shot, i) {
  if (shot.kind === "pin") {
    const H0 = homography(RECT, pinCorners(0, shot.speed));
    const Ht = homography(RECT, pinCorners(i / FPS, shot.speed));
    return mul(Ht, inv(H0));
  }
  const at = (frame) => {
    const off = shot.motionBlur ? shot.shutterCenter ?? 0.25 : 0;
    const k = frame + 1 < FRAMES ? frame : frame - 1; // after the last key the value holds
    const f = frame + 1 < FRAMES ? off : 1;
    const a = transformAt(k / FPS, shot.speed);
    const b = transformAt((k + 1) / FPS, shot.speed);
    return transformMatrix({ position: [lerp(a.position[0], b.position[0], f), lerp(a.position[1], b.position[1], f)], scale: lerp(a.scale, b.scale, f), rotation: lerp(a.rotation, b.rotation, f) });
  };
  return mul(at(i), inv(at(0)));
}

// ---------- the shots ----------

const SHOTS = [
  { name: "clean", kind: "pin", speed: 1 },
  { name: "fast", kind: "pin", speed: 3 },
  { name: "defocus", kind: "pin", speed: 1, blur: 4 },
  { name: "grain", kind: "pin", speed: 1, noise: 12 },
  { name: "low_contrast", kind: "pin", speed: 1, opacity: 35, noise: 6 },
  { name: "motion_blur", kind: "transform", speed: 3, motionBlur: true },
  // A second surface over the right of the tracked region, moving differently (a nearer building):
  // the tool should name the points on it as not moving with the plane.
  { name: "parallax", kind: "pin", speed: 1, parallax: true },
];

function shotJsx(shot) {
  const times = [];
  for (let i = 0; i < FRAMES; i++) times.push(i / FPS);
  const lines = [`var c = mk("Cal ${shot.name}"); var L = c.layers.add(src); L.name = "Plate";`];
  if (shot.kind === "pin") {
    lines.push('var pin = L.property("ADBE Effect Parade").addProperty("ADBE Corner Pin");');
    for (let k = 0; k < 4; k++) {
      const vals = times.map((t) => pinCorners(t, shot.speed)[k].map(r3));
      lines.push(`pin.property(${k + 1}).setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(vals)});`);
    }
  } else {
    const tr = times.map((t) => transformAt(t, shot.speed));
    lines.push('var tg = L.property("ADBE Transform Group");');
    lines.push(`tg.property("ADBE Position").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(tr.map((v) => v.position.map(r3)))});`);
    lines.push(`tg.property("ADBE Scale").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(tr.map((v) => [r3(v.scale), r3(v.scale)]))});`);
    lines.push(`tg.property("ADBE Rotate Z").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(tr.map((v) => r3(v.rotation)))});`);
  }
  if (shot.blur) lines.push(`L.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2").property(1).setValue(${shot.blur});`);
  if (shot.noise) lines.push(`L.property("ADBE Effect Parade").addProperty("ADBE Noise").property(1).setValue(${shot.noise});`);
  if (shot.opacity) lines.push(`L.property("ADBE Transform Group").property("ADBE Opacity").setValue(${shot.opacity});`);
  if (shot.motionBlur) lines.push("L.motionBlur = true; c.motionBlur = true;");
  if (shot.parallax) {
    // The same picture, 1.6x larger, masked to the right 40% of the region, moving 2.5x as far sideways.
    lines.push("var F = c.layers.add(src); F.name = \"Near\";");
    lines.push('F.property("ADBE Transform Group").property("ADBE Scale").setValue([160, 160]);');
    lines.push(`var fm = F.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"); var sh = new Shape(); sh.vertices = [[${W * 0.62}, ${H * 0.2}], [${W * 0.8}, ${H * 0.2}], [${W * 0.8}, ${H * 0.8}], [${W * 0.62}, ${H * 0.8}]]; sh.closed = true; fm.property("ADBE Mask Shape").setValue(sh);`);
    const pos = times.map((t) => [r3(W / 2 + 100 * Math.sin((2 * Math.PI * t) / DUR)), r3(H / 2 + 10 * Math.sin((Math.PI * t) / DUR))]);
    lines.push(`F.property("ADBE Transform Group").property("ADBE Position").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(pos)});`);
  }
  lines.push(`ids["${shot.name}"] = c.id;`);
  return lines.join("\n");
}

// ---------- the plate ----------

function preparePlate() {
  const plate = arg("--plate");
  if (!plate || !fs.existsSync(plate)) throw new Error("Give --plate <image or video>: real footage or a photograph with texture.");
  fs.mkdirSync(path.join(ROOT, "media"), { recursive: true });
  const out = path.join(ROOT, "media", "plate.png");
  // One frame (or the image), 2400 px wide, as PNG: ffmpeg reads both; HEIC goes through sips on macOS.
  const at = /\.(mov|mp4|m4v|mxf|avi|mkv)$/i.test(plate) ? ["-ss", String(Number(arg("--plate-time") ?? 4))] : [];
  const ff = spawnSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", ...at, "-i", plate, "-frames:v", "1", "-vf", "scale=2400:-2", out], { encoding: "utf8" });
  if (ff.status !== 0 || !fs.existsSync(out)) {
    const sips = process.platform === "darwin" ? spawnSync("/usr/bin/sips", ["-s", "format", "png", "-Z", "2400", plate, "--out", out], { encoding: "utf8" }) : null;
    if (!sips || sips.status !== 0 || !fs.existsSync(out)) throw new Error(`Could not make a PNG plate from ${path.basename(plate)}: ${ff.stderr || sips?.stderr || ""}`);
  }
  return out;
}

// ---------- tracking ----------

/** The region the trackers work on, in ref comp px: the middle of the frame, which stays in view. */
const REGION = [240, 135, 480, 270];
function gridPoints() {
  const pts = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) pts.push([REGION[0] + (REGION[2] * i) / 4, REGION[1] + (REGION[3] * j) / 4]);
  return pts;
}

async function trackMulti(compId, model) {
  const t0 = Date.now();
  let r = await call("ae_track_multi", { comp_id: compId, auto_points: { region: { rect: REGION }, count: 8 }, ref_time: 0, start: 0, end: END, model, preview: false, max_frames: 1000, max_seconds: 300 });
  let guard = 0;
  while (r.ok && r.complete === false && r.continue_track_id && guard++ < 20) {
    r = await call("ae_track_multi", { comp_id: compId, continue_track_id: r.continue_track_id, preview: false, max_frames: 1000, max_seconds: 300 });
  }
  return { r, ms: Date.now() - t0 };
}

/** 5 x 5 points over a quad [UL, UR, LR, LL], the same grid the tool judges its expected error on. */
function quadPoints(q) {
  const out = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const s = i / 4, t = j / 4;
    const top = [q[0][0] + (q[1][0] - q[0][0]) * s, q[0][1] + (q[1][1] - q[0][1]) * s];
    const bot = [q[3][0] + (q[2][0] - q[3][0]) * s, q[3][1] + (q[2][1] - q[3][1]) * s];
    out.push([top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t]);
  }
  return out;
}

function scorePlanar(shot, track) {
  // The error is judged where the tool judges it: over the track's quad (the points' bounding box by default).
  const grid = track.tracking?.quad ? quadPoints(track.tracking.quad) : gridPoints();
  const per = [];
  for (const f of track.frames) {
    const i = Math.round(f.time * FPS);
    if (i === 0) continue;
    if (!f.H) {
      per.push({ i, solved: false, reported_rms: f.rms_px ?? null });
      continue;
    }
    const truth = trueH(shot, i);
    const errs = grid.map((p) => dist(apply(f.H, p), apply(truth, p)));
    if (!f.ok) {
      per.push({ i, solved: false, flagged: true, reported_rms: f.rms_px ?? null, true_if_kept: errs.reduce((a, x) => a + x, 0) / errs.length });
      continue;
    }
    per.push({ i, solved: true, ok: f.ok, mean: errs.reduce((a, x) => a + x, 0) / errs.length, max: Math.max(...errs), reported_rms: f.rms_px ?? null, expected: f.expected_px ?? null, inliers: f.inliers, note: f.note });
  }
  const solved = per.filter((p) => p.solved);
  const ratio = solved.filter((p) => p.reported_rms > 0).map((p) => p.mean / p.reported_rms);
  // Pearson correlation between the reported rms and the true mean error, over solved frames.
  const xs = solved.filter((p) => Number.isFinite(p.reported_rms)).map((p) => p.reported_rms);
  const ys = solved.filter((p) => Number.isFinite(p.reported_rms)).map((p) => p.mean);
  let corr = null;
  if (xs.length > 3) {
    const mx = xs.reduce((a, x) => a + x, 0) / xs.length;
    const my = ys.reduce((a, x) => a + x, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < xs.length; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) ** 2;
      syy += (ys[k] - my) ** 2;
    }
    corr = sxx > 0 && syy > 0 ? r3(sxy / Math.sqrt(sxx * syy)) : null;
  }
  // Drift: error of the last solved frame against the first ones.
  const withExp = solved.filter((p) => typeof p.expected === "number" && p.expected > 0);
  // The true frame-to-frame shake of the quad corners: the tool's jitter estimator on the error path.
  const quad = track.tracking?.quad;
  let trueJitter = null;
  if (quad) {
    trueJitter = 0;
    for (const c of quad) {
      const e = track.frames.filter((f) => f.H).map((f) => {
        const a = apply(f.H, c);
        const b = apply(trueH(shot, Math.round(f.time * FPS)), c);
        return [a[0] - b[0], a[1] - b[1]];
      });
      const d3 = [];
      for (let k = 3; k < e.length; k++) d3.push(Math.hypot(e[k][0] - 3 * e[k - 1][0] + 3 * e[k - 2][0] - e[k - 3][0], e[k][1] - 3 * e[k - 1][1] + 3 * e[k - 2][1] - e[k - 3][1]));
      d3.sort((x, y) => x - y);
      if (d3.length) trueJitter = Math.max(trueJitter, d3[Math.floor(d3.length / 2)] / (1.1774 * Math.sqrt(20)));
    }
    trueJitter = r3(trueJitter);
  }
  return {
    frames: per.length,
    solved: solved.length,
    flagged_unreliable: per.filter((p) => p.flagged).map((p) => ({ frame: p.i, true_px: r3(p.true_if_kept) })),
    expected_px: stats(withExp.map((p) => p.expected)),
    true_over_expected: withExp.length ? r3(withExp.reduce((a, p) => a + p.mean, 0) / withExp.reduce((a, p) => a + p.expected, 0)) : null,
    true_corner_jitter_px: trueJitter,
    marked_ok: solved.filter((p) => p.ok).length,
    true_mean_px: stats(solved.map((p) => p.mean)),
    true_max_px: stats(solved.map((p) => p.max)),
    reported_rms_px: stats(solved.map((p) => p.reported_rms)),
    true_over_reported: stats(ratio),
    reported_vs_true_corr: corr,
    last_frame_err_px: solved.length ? r3(solved[solved.length - 1].mean) : null,
    worst_frames: solved
      .slice()
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 3)
      .map((p) => ({ frame: p.i, true_px: r3(p.mean), reported_rms: p.reported_rms, inliers: p.inliers, ok: p.ok, note: p.note })),
  };
}

async function trackPoint(shot, compId, p0) {
  const t0 = Date.now();
  const r = await call("ae_track_point", { comp_id: compId, point: p0, start: 0, end: END });
  if (!r.ok) return { ok: false, message: r.message ?? brief(r), ms: Date.now() - t0 };
  const errs = [];
  for (const [t, x, y, conf] of r.path) {
    const i = Math.round(t * FPS);
    if (i === 0) continue;
    errs.push({ i, err: dist([x, y], apply(trueH(shot, i), p0)), conf });
  }
  return {
    ok: true,
    point: p0,
    frames: errs.length,
    lost_at: r.lost_at,
    true_err_px: stats(errs.map((e) => e.err)),
    mean_confidence: r.mean_confidence,
    min_confidence: r.min_confidence,
    last_err_px: errs.length ? r3(errs[errs.length - 1].err) : null,
    ms: Date.now() - t0,
  };
}

// ---------- frames ----------

/** A full-resolution render of one frame, decoded: { width, height, data (RGBA bytes) }. */
async function frame(compId, time) {
  const r = await call("ae_snapshot_frame", { comp_id: compId, time });
  if (!r.ok || !r.full_path) throw new Error(`ae_snapshot_frame failed: ${brief(r)}`);
  const img = PNG.sync.read(fs.readFileSync(r.full_path));
  return { width: img.width, height: img.height, data: img.data };
}
function decode(file) {
  const img = PNG.sync.read(fs.readFileSync(file));
  return { width: img.width, height: img.height, data: img.data };
}
/** Pixels of a rect [x0, y0, x1, y1], or of a ring between two rects when `outer` is given. */
function pixels(img, rect, outer) {
  const out = [];
  const [x0, y0, x1, y1] = outer ?? rect;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const inner = x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3];
      if (outer ? inner : !inner) continue;
      out.push((y * img.width + x) * 4);
    }
  }
  return out;
}
const channelMeans = (img, idx) => [0, 1, 2].map((c) => idx.reduce((a, i) => a + img.data[i + c], 0) / idx.length);
const shrink = (r, d) => [r[0] + d, r[1] + d, r[2] - d, r[3] - d];
const grow = (r, d) => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

/** Per-pixel temporal sigma (gray levels) over frames, averaged over `idx`; and the grain's lag-1 correlation across x. */
function temporalGrain(frames, idx) {
  const n = frames.length;
  let sum = 0;
  let corrNum = 0;
  let corrDen = 0;
  for (const i of idx) {
    for (let c = 0; c < 3; c++) {
      let m = 0;
      for (const f of frames) m += f.data[i + c];
      m /= n;
      let v = 0;
      for (const f of frames) v += (f.data[i + c] - m) ** 2;
      sum += Math.sqrt(v / (n - 1));
      // Lag-1 along x: does the grain clump (large grain) or is it per pixel?
      const j = i + 4;
      let mj = 0;
      for (const f of frames) mj += f.data[j + c];
      mj /= n;
      for (const f of frames) {
        corrNum += (f.data[i + c] - m) * (f.data[j + c] - mj);
        corrDen += (f.data[i + c] - m) ** 2;
      }
    }
  }
  return { sigma: r3(sum / (idx.length * 3)), lag1_corr: corrDen > 0 ? r3(corrNum / corrDen) : null };
}

// ---------- colour and grain (stage B) ----------

// The patch: a copy of the plate over this rect, masked; the plate around it changes, the patch does not.
const HOLE = [400, 200, 560, 320]; // x0, y0, x1, y1
const WARM = [1, 0.85, 0.7];
/** Per-channel gain of the colour shot at time t: a warm Multiply solid fading to 60% and a black solid to 25%. */
function colourGain(t) {
  const u = Math.min(1, t / END);
  const a = 0.6 * u;
  const b = 0.25 * Math.sin((Math.PI * u) / 2);
  return WARM.map((c) => (1 - b) * (1 - a + a * c));
}
function stageBJsx() {
  const mask = (name) =>
    `var mk_${name} = ${name}.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"); var sh_${name} = new Shape(); sh_${name}.vertices = [[${HOLE[0]}, ${HOLE[1]}], [${HOLE[2]}, ${HOLE[1]}], [${HOLE[2]}, ${HOLE[3]}], [${HOLE[0]}, ${HOLE[3]}]]; sh_${name}.closed = true; mk_${name}.property("ADBE Mask Shape").setValue(sh_${name});`;
  const times = [0, END / 2, END];
  return [
    // Colour: the patch does not get the light change the plate gets.
    'var cc = mk("Cal colour"); var cp = cc.layers.add(src); cp.name = "Plate";',
    `var warm = cc.layers.addSolid(${JSON.stringify(WARM)}, "Warm", ${W}, ${H}, 1); warm.blendingMode = BlendingMode.MULTIPLY;`,
    `warm.property("ADBE Transform Group").property("ADBE Opacity").setValuesAtTimes([0, ${END}], [0, 60]);`,
    `var dim = cc.layers.addSolid([0, 0, 0], "Dim", ${W}, ${H}, 1);`,
    // Black at opacity b(t) = 25 sin(pi u / 2): keyed every frame so the curve is exact.
    `var dt = []; var dv = []; for (var f = 0; f < ${FRAMES}; f++) { dt.push(f / ${FPS}); dv.push(25 * Math.sin(Math.PI * Math.min(1, (f / ${FPS}) / ${END}) / 2)); } dim.property("ADBE Transform Group").property("ADBE Opacity").setValuesAtTimes(dt, dv);`,
    `var warmOp = warm.property("ADBE Transform Group").property("ADBE Opacity"); for (var k = 1; k <= warmOp.numKeys; k++) warmOp.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);`,
    'var patch = cc.layers.add(src); patch.name = "Patch"; patch.moveToBeginning();',
    mask("patch"),
    "ids.colour = cc.id;",
    // Grain: the plate has animated Noise, the patch is the same picture without it.
    'var gc = mk("Cal grain match"); var gp = gc.layers.add(src); gp.name = "Plate";',
    'gp.property("ADBE Effect Parade").addProperty("ADBE Noise").property(1).setValue(10);',
    'var gpatch = gc.layers.add(src); gpatch.name = "Patch"; gpatch.moveToBeginning();',
    mask("gpatch"),
    "ids.grain_match = gc.id;",
  ].join("\n");
}

async function stageColour(ids, expect) {
  const compId = ids.colour;
  const region = { kind: "rect", rect: HOLE };
  const t0 = Date.now();
  const r = await call("ae_patch_color_match", { comp_id: compId, layer: { name: "Patch" }, region, ref_time: 0, start: 0, end: END, step: 2, expect });
  const out = { ok: r.ok !== false && r.complete !== false, ms: Date.now() - t0, applied: r.applied ?? r.write?.applied ?? null, tool_verify: r.verify ?? r.write?.verify ?? null, message: r.message };
  if (!out.ok) return { ...out, raw: brief(r) };
  // Truth: the patch is the plate, so the right patch colour at t is the plate's own colour at 0 times the gain.
  const inner = shrink(HOLE, 12);
  const f0 = await frame(compId, 0);
  const base = channelMeans(f0, pixels(f0, inner));
  const rows = [];
  for (const t of [0.4, 0.8, 1.2, 1.6, END]) {
    const f = await frame(compId, t);
    const got = channelMeans(f, pixels(f, inner));
    const g = colourGain(Math.round(t * FPS) / FPS);
    const want = base.map((v, c) => v * g[c]);
    rows.push({ t, residual: got.map((v, c) => r3(v - want[c])), uncorrected: base.map((v, c) => r3(v - want[c])) });
  }
  const worst = (k) => r3(Math.max(...rows.map((row) => Math.max(...row[k].map(Math.abs)))));
  return { ...out, rows, worst_residual_levels: worst("residual"), worst_uncorrected_levels: worst("uncorrected") };
}

async function stageGrain(ids, expect) {
  const compId = ids.grain_match;
  const region = { kind: "rect", rect: HOLE };
  const measure = async () => {
    const frames = [];
    for (let k = 0; k < 6; k++) frames.push(await frame(compId, 1 + k / FPS));
    return {
      plate_ring: temporalGrain(frames, pixels(frames[0], grow(HOLE, 4), grow(HOLE, 30))),
      patch: temporalGrain(frames, pixels(frames[0], shrink(HOLE, 6))),
    };
  };
  const before = await measure();
  const t0 = Date.now();
  const r = await call("ae_patch_grain", { comp_id: compId, layer: { name: "Patch" }, region, ref_time: 0, start: 0, end: END, samples: 3, rounds: 2, expect });
  const out = { ok: r.ok !== false, ms: Date.now() - t0, tool: { sigma_before: r.sigma_before, start_intensity: r.start_intensity, final_intensity: r.final_intensity, size: r.size, size_from: r.size_from, grain_texture: r.grain_texture, converged: r.converged }, message: r.message };
  if (!out.ok) return { ...out, raw: brief(r) };
  const after = await measure();
  return { ...out, before, after, sigma_ratio_after: after.plate_ring.sigma > 0 ? r3(after.patch.sigma / after.plate_ring.sigma) : null };
}

// ---------- Add Grain's own scale (for grain size, item 4) ----------

// What Add Grain's Size and Intensity give, on a flat 50% gray: temporal sigma and how much neighbouring
// pixels' grain agrees (lag-1 correlation along x; 0 for per-pixel noise, near 1 for big soft grain).
const GRAIN_SIZES = [0.25, 0.5, 0.75, 1, 1.5, 2];
const GRAIN_INTENSITIES = [0.1, 0.3, 0.6];
function grainCurveJsx() {
  const lines = [
    "function findParam(g, name) { for (var i = 1; i <= g.numProperties; i++) { var p = g.property(i); if (p.name === name) return p; if (p.numProperties > 0) { var r = findParam(p, name); if (r) return r; } } return null; }",
    "ids.grain_curve = [];",
    "function grainComp(size, intensity) {",
    '  var c = mk("Cal add grain " + size + " " + intensity); var l = c.layers.addSolid([0.5, 0.5, 0.5], "Gray", ' + W + ", " + H + ", 1);",
    '  var fx = l.property("ADBE Effect Parade").addProperty("VISINF Grain Implant");',
    '  var vm = findParam(fx, "Viewing Mode"); if (vm) vm.setValue(3);',
    '  var it = findParam(fx, "Intensity"); if (it) it.setValue(intensity);',
    '  var sz = findParam(fx, "Size"); if (sz) sz.setValue(size);',
    '  var sp = findParam(fx, "Animation Speed"); if (sp) sp.setValue(1);',
    "  ids.grain_curve.push({ id: c.id, size: size, intensity: intensity });",
    "}",
  ];
  for (const sz of GRAIN_SIZES) lines.push(`grainComp(${sz}, 0.3);`);
  for (const it of GRAIN_INTENSITIES) if (it !== 0.3) lines.push(`grainComp(1, ${it});`);
  return lines.join("\n");
}

async function stageGrainCurve(ids) {
  const rows = [];
  const box = [W / 2 - 100, H / 2 - 100, W / 2 + 100, H / 2 + 100];
  for (const g of ids.grain_curve ?? []) {
    const frames = [];
    for (let k = 0; k < 6; k++) frames.push(await frame(g.id, 0.4 + k / FPS));
    const m = temporalGrain(frames, pixels(frames[0], box));
    rows.push({ size: g.size, intensity: g.intensity, sigma: m.sigma, lag1_corr: m.lag1_corr });
  }
  return rows;
}

// ---------- 3D projection (for the camera solve check, item 3) ----------

// Where AE itself puts 3D points on screen (an expression's toComp) against the Node maths that
// ae_scene_3d_report, ae_annotate_frame and the solve check share. Cameras with every rotation.
const PROJ_TIMES = [0, 0.6, 1.2, 1.8];
const PROJ_POINTS = [[-300, -150, 200], [250, -100, -150], [0, 0, 0], [400, 200, 300], [-200, 250, -300], [120, -260, 500], [-420, 60, 80], [300, 300, -50]];
const PROJ_CAMS = [
  { name: "one-node", twoNode: false, pos: [[480, 270, -1200], [700, 150, -900]], ori: [[0, 0, 0], [10, 25, 5]], rot: [[0, 0, 0], [-8, 12, 4]], zoom: [1000, 1300] },
  { name: "two-node", twoNode: true, pos: [[200, 100, -1100], [800, 400, -800]], poi: [[480, 270, 0], [520, 250, 100]], rot: [[0, 0, 0], [6, -9, 15]], zoom: [900, 1100] },
];
function projectionJsx() {
  const lines = ["ids.proj = [];"];
  PROJ_CAMS.forEach((c, k) => {
    lines.push(`var pc${k} = mk("Cal projection ${c.name}");`);
    PROJ_POINTS.forEach((p, i) => lines.push(`var pn${k}_${i} = pc${k}.layers.addNull(); pn${k}_${i}.threeDLayer = true; pn${k}_${i}.name = "P${i}"; pn${k}_${i}.property("ADBE Transform Group").property("ADBE Position").setValue([${p[0] + W / 2}, ${p[1] + H / 2}, ${p[2]}]);`));
    lines.push(`var cam${k} = pc${k}.layers.addCamera("Cam", [${W / 2}, ${H / 2}]);`);
    lines.push(`cam${k}.autoOrient = ${c.twoNode ? "AutoOrientType.CAMERA_OR_POINT_OF_INTEREST" : "AutoOrientType.NO_AUTO_ORIENT"};`);
    lines.push(`var ct${k} = cam${k}.property("ADBE Transform Group");`);
    lines.push(`ct${k}.property("ADBE Position").setValuesAtTimes([0, ${END}], ${JSON.stringify(c.pos)});`);
    if (c.twoNode) lines.push(`ct${k}.property("ADBE Anchor Point").setValuesAtTimes([0, ${END}], ${JSON.stringify(c.poi)});`);
    else lines.push(`ct${k}.property("ADBE Orientation").setValuesAtTimes([0, ${END}], ${JSON.stringify(c.ori)});`);
    lines.push(`ct${k}.property("ADBE Rotate X").setValuesAtTimes([0, ${END}], [${c.rot[0][0]}, ${c.rot[1][0]}]);`);
    lines.push(`ct${k}.property("ADBE Rotate Y").setValuesAtTimes([0, ${END}], [${c.rot[0][1]}, ${c.rot[1][1]}]);`);
    lines.push(`ct${k}.property("ADBE Rotate Z").setValuesAtTimes([0, ${END}], [${c.rot[0][2]}, ${c.rot[1][2]}]);`);
    lines.push(`cam${k}.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValuesAtTimes([0, ${END}], ${JSON.stringify(c.zoom)});`);
    // AE's own answer: a 2D probe per point whose Position is toComp of that point.
    PROJ_POINTS.forEach((_, i) => lines.push(`var pr${k}_${i} = pc${k}.layers.addNull(); pr${k}_${i}.name = "Probe${i}"; pr${k}_${i}.property("ADBE Transform Group").property("ADBE Position").expression = 'var L = thisComp.layer("P${i}"); L.toComp(L.anchorPoint);';`));
    lines.push(`var truth${k} = []; for (var ti = 0; ti < ${PROJ_TIMES.length}; ti++) { var row = []; for (var pi = 0; pi < ${PROJ_POINTS.length}; pi++) { var v = pc${k}.layer("Probe" + pi).property("ADBE Transform Group").property("ADBE Position").valueAtTime(${JSON.stringify(PROJ_TIMES)}[ti], false); row.push([v[0], v[1]]); } truth${k}.push(row); }`);
    lines.push(`for (var pd = ${PROJ_POINTS.length - 1}; pd >= 0; pd--) pc${k}.layer("Probe" + pd).remove();`);
    // A rotated 3D layer: three of its own points through toComp, to check the layer rotation too.
    lines.push(`var q${k} = pc${k}.layers.addNull(); q${k}.threeDLayer = true; q${k}.name = "Q"; var qg${k} = q${k}.property("ADBE Transform Group"); qg${k}.property("ADBE Position").setValuesAtTimes([0, ${END}], [[${W / 2 + 60}, ${H / 2 - 40}, 150], [${W / 2 - 80}, ${H / 2 + 30}, -120]]); qg${k}.property("ADBE Orientation").setValue([20, -35, 10]); qg${k}.property("ADBE Rotate X").setValuesAtTimes([0, ${END}], [15, -25]); qg${k}.property("ADBE Rotate Y").setValuesAtTimes([0, ${END}], [-30, 40]); qg${k}.property("ADBE Rotate Z").setValuesAtTimes([0, ${END}], [5, 60]); qg${k}.property("ADBE Scale").setValue([120, 80, 150]); qg${k}.property("ADBE Anchor Point").setValue([10, -20, 30]);`);
    lines.push(`var qp${k} = pc${k}.layers.addNull(); qp${k}.name = "QProbe"; var qtruth${k} = []; var qlocal = [[100, 0, 0], [0, 80, 0], [40, -60, 90]]; for (var qi = 0; qi < qlocal.length; qi++) { qp${k}.property("ADBE Transform Group").property("ADBE Position").expression = 'thisComp.layer("Q").toComp([' + qlocal[qi].join(",") + '])'; var qrow = []; for (var qt = 0; qt < ${PROJ_TIMES.length}; qt++) { var qv = qp${k}.property("ADBE Transform Group").property("ADBE Position").valueAtTime(${JSON.stringify(PROJ_TIMES)}[qt], false); qrow.push([qv[0], qv[1]]); } qtruth${k}.push(qrow); } qp${k}.remove();`);
    // The camera's own values at the same times, for checking the maths offline.
    lines.push(`var camv${k} = []; for (var tj = 0; tj < ${PROJ_TIMES.length}; tj++) { var tt = ${JSON.stringify(PROJ_TIMES)}[tj]; var g = cam${k}.property("ADBE Transform Group"); camv${k}.push({ position: g.property("ADBE Position").valueAtTime(tt, false), poi: g.property("ADBE Anchor Point").valueAtTime(tt, false), orientation: g.property("ADBE Orientation").valueAtTime(tt, false), rx: g.property("ADBE Rotate X").valueAtTime(tt, false), ry: g.property("ADBE Rotate Y").valueAtTime(tt, false), rz: g.property("ADBE Rotate Z").valueAtTime(tt, false), zoom: cam${k}.property("ADBE Camera Options Group").property("ADBE Camera Zoom").valueAtTime(tt, false) }); }`);
    lines.push(`ids.proj.push({ id: pc${k}.id, name: "${c.name}", two_node: ${c.twoNode}, truth: truth${k}, cam: camv${k}, q_truth: qtruth${k} });`);
  });
  return lines.join("\n");
}

async function stageProjection(ids) {
  const out = [];
  for (const c of ids.proj ?? []) {
    let worst = 0;
    let sum = 0;
    let n = 0;
    const bad = [];
    for (let ti = 0; ti < PROJ_TIMES.length; ti++) {
      const r = await call("ae_scene_3d_report", { comp_id: c.id, time: PROJ_TIMES[ti] });
      for (let pi = 0; pi < PROJ_POINTS.length; pi++) {
        const e = (r.layers_by_depth ?? []).find((x) => x.name === `P${pi}`);
        const truth = c.truth[ti][pi];
        if (!e?.screen) {
          bad.push(`P${pi}@${PROJ_TIMES[ti]}: no screen`);
          continue;
        }
        const d = dist(e.screen, truth);
        sum += d;
        n++;
        if (d > worst) worst = d;
        if (d > 0.5 && bad.length < 6) bad.push(`P${pi}@${PROJ_TIMES[ti]}: node [${e.screen}] ae [${truth.map(r3)}]`);
      }
    }
    // The rotated layer: ae_scene_3d_report gives its anchor's screen point; the local points need the maths, done in the analysis below.
    out.push({ camera: c.name, mean_px: n ? r3(sum / n) : null, max_px: r3(worst), points: n, examples: bad, q_truth: c.q_truth, raw: { two_node: c.two_node, times: PROJ_TIMES, points: PROJ_POINTS.map((p) => [p[0] + W / 2, p[1] + H / 2, p[2]]), comp: [W, H], cam: c.cam, truth: c.truth } });
  }
  return out;
}

// ---------- camera solve check (item 3) ----------

// The plate as a 3D plane seen by a moving camera, nulls on the plane (features), one null off it.
// The check through the true camera should read the tracker's noise; through a camera with 3% more
// zoom and 8 px of offset, the slide that camera really has against the picture.
const SOLVE_NULLS = [[-260, -140], [220, -150], [-300, 120], [280, 130], [0, 0], [-120, 60], [140, -40], [60, 170]];
function solveJsx() {
  const lines = [
    'var sc = mk("Cal solve"); var sp = sc.layers.add(src); sp.threeDLayer = true; sp.name = "Plate3D";',
    `sp.property("ADBE Transform Group").property("ADBE Position").setValue([${W / 2}, ${H / 2}, 0]);`,
  ];
  SOLVE_NULLS.forEach(([x, y], i) => lines.push(`var sn${i} = sc.layers.addNull(); sn${i}.threeDLayer = true; sn${i}.name = "Track ${i}"; sn${i}.property("ADBE Transform Group").property("ADBE Position").setValue([${W / 2 + x}, ${H / 2 + y}, 0]);`));
  lines.push(`var off = sc.layers.addNull(); off.threeDLayer = true; off.name = "Off plane"; off.property("ADBE Transform Group").property("ADBE Position").setValue([${W / 2 - 40}, ${H / 2 - 90}, -250]);`);
  const cam = (name, zoomK, dx, enabled) => [
    `var ${name} = sc.layers.addCamera("${name === "tc" ? "True Cam" : "Off Cam"}", [${W / 2}, ${H / 2}]); ${name}.autoOrient = AutoOrientType.NO_AUTO_ORIENT;`,
    `var ${name}g = ${name}.property("ADBE Transform Group");`,
    `${name}g.property("ADBE Position").setValuesAtTimes([0, ${END}], [[${W / 2 + dx}, ${H / 2}, -1000], [${W / 2 + 140 + dx}, ${H / 2 - 60}, -820]]);`,
    `${name}g.property("ADBE Rotate Y").setValuesAtTimes([0, ${END}], [0, -7]);`,
    `${name}g.property("ADBE Rotate X").setValuesAtTimes([0, ${END}], [0, 3]);`,
    `${name}.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(${1000 * zoomK});`,
    `${name}.enabled = ${enabled};`,
  ];
  lines.push(...cam("oc", 1.03, 8, false), ...cam("tc", 1, 0, true));
  lines.push("ids.solve = sc.id;");
  return lines.join("\n");
}

async function stageSolve(ids) {
  const out = {};
  const nullNames = [...SOLVE_NULLS.map((_, i) => `Track ${i}`), "Off plane"];
  for (const camName of ["True Cam", "Off Cam"]) {
    const t0 = Date.now();
    const r = await call("ae_camera_solve_check", { comp_id: ids.solve, camera: { name: camName }, max_frames: 20 });
    if (r.ok === false) {
      out[camName] = { ok: false, message: r.message ?? brief(r) };
      continue;
    }
    // What that camera's slide against the picture really is: its projection's motion from the first
    // frame against the true camera's, from ae_scene_3d_report (the maths checked against toComp).
    // Compare at the times the tool measured each null (up to 6 of them, including its last).
    const at = async (cam, t) => {
      const rep = await call("ae_scene_3d_report", { comp_id: ids.solve, time: t, camera: { name: cam } });
      return Object.fromEntries((rep.layers_by_depth ?? []).filter((e) => nullNames.includes(e.name)).map((e) => [e.name, e.screen]));
    };
    const pts = Object.fromEntries((r.points ?? []).map((p) => [p.name, p]));
    const cache = new Map();
    const atCached = async (cam, t) => {
      const key = `${cam}@${t}`;
      if (!cache.has(key)) cache.set(key, await at(cam, t));
      return cache.get(key);
    };
    const expected = {};
    const toolAt = {};
    for (const n of nullNames.slice(0, SOLVE_NULLS.length)) {
      const ser = pts[n]?.series ?? [];
      if (ser.length < 2) continue;
      const t0 = ser[0][0];
      const pick = ser.length <= 6 ? ser.slice(1) : [1, 2, 3, 4, 5].map((q) => ser[Math.round((q * (ser.length - 1)) / 5)]);
      const T0 = await atCached("True Cam", t0);
      const C0 = await atCached(camName, t0);
      for (const [t, e] of pick) {
        const tr = await atCached("True Cam", t);
        const cm = await atCached(camName, t);
        const d = [cm[n][0] - C0[n][0] - (tr[n][0] - T0[n][0]), cm[n][1] - C0[n][1] - (tr[n][1] - T0[n][1])];
        expected[n] = Math.max(expected[n] ?? 0, Math.hypot(d[0], d[1]));
        toolAt[n] = Math.max(toolAt[n] ?? 0, e);
      }
    }
    out[camName] = {
      ok: true,
      ms: Date.now() - t0,
      verdict: r.verdict,
      error_px: r.error_px,
      off_plane: pts["Off plane"] ? { verdict: pts["Off plane"].verdict, max_px: pts["Off plane"].max_px } : null,
      // Per plane null: the tool's largest error against the slide that camera really has (largest of the sampled times).
      plane_nulls: nullNames.slice(0, SOLVE_NULLS.length).map((n) => ({ name: n, tool_max_px: toolAt[n] !== undefined ? r3(toolAt[n]) : null, true_max_px: r3(expected[n] ?? 0), verdict: pts[n]?.verdict, left_frame: pts[n]?.left_frame ?? false })),
    };
  }
  return out;
}

// ---------- inpaint (stage C) ----------

// An 80 px dark object that crosses the region; at the reference frame it sits over OBJECT_HOLE.
const REF_T = 1;
const objectX = (t) => 300 + (360 * t) / END;
const OBJECT_HOLE = [Math.round(objectX(REF_T)) - 50, 220, Math.round(objectX(REF_T)) + 50, 320];
function stageCJsx() {
  const times = [];
  for (let i = 0; i < FRAMES; i++) times.push(i / FPS);
  const xs = times.map((t) => [r3(objectX(t)), 270]);
  const pinTimes = times;
  const pinVals = (k) => pinTimes.map((t) => pinCorners(t, 1)[k].map(r3));
  return [
    // Locked-off plate with a moving object, as one footage-like layer.
    'var is = mk("Cal inpaint src"); is.layers.add(src);',
    'var ob = is.layers.addSolid([0.35, 0.05, 0.05], "Object", 80, 80, 1);',
    `ob.property("ADBE Transform Group").property("ADBE Position").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(xs)});`,
    'var ic = mk("Cal inpaint"); var il = ic.layers.add(is); il.name = "Plate"; ids.inpaint = ic.id;',
    // The same with the camera moving (Corner Pin on the picture under the object).
    'var ms = mk("Cal inpaint moving src"); var mp = ms.layers.add(src); var mpin = mp.property("ADBE Effect Parade").addProperty("ADBE Corner Pin");',
    ...[0, 1, 2, 3].map((k) => `mpin.property(${k + 1}).setValuesAtTimes(${JSON.stringify(pinTimes)}, ${JSON.stringify(pinVals(k))});`),
    'ids.inpaint_truth_moving = ms.id;',
    'var mo = mk("Cal inpaint moving obj"); mo.layers.add(ms); var ob2 = mo.layers.addSolid([0.35, 0.05, 0.05], "Object", 80, 80, 1);',
    `ob2.property("ADBE Transform Group").property("ADBE Position").setValuesAtTimes(${JSON.stringify(times)}, ${JSON.stringify(xs)});`,
    'var mc = mk("Cal inpaint moving"); var ml = mc.layers.add(mo); ml.name = "Plate"; ids.inpaint_moving = mc.id;',
  ].join("\n");
}

function compareFill(fillPng, truth, rect) {
  const fill = decode(fillPng);
  // The fill still is comp-sized; compare inside the hole only.
  if (fill.width !== truth.width || fill.height !== truth.height) return { note: `fill is ${fill.width}x${fill.height}, truth ${truth.width}x${truth.height}` };
  const idx = pixels(truth, rect);
  let abs = 0;
  let sq = 0;
  for (const i of idx) for (let c = 0; c < 3; c++) {
    const d = fill.data[i + c] - truth.data[i + c];
    abs += Math.abs(d);
    sq += d * d;
  }
  const n = idx.length * 3;
  const mse = sq / n;
  return { mae_levels: r3(abs / n), psnr_db: mse > 0 ? r3(10 * Math.log10((255 * 255) / mse)) : 99 };
}

async function stageInpaint(ids, expect) {
  const out = {};
  const truthStatic = await frame(ids.src, REF_T);
  const hole = { rect: [OBJECT_HOLE[0], OBJECT_HOLE[1], OBJECT_HOLE[2] - OBJECT_HOLE[0], OBJECT_HOLE[3] - OBJECT_HOLE[1]] };
  for (const method of ["auto", "spatial"]) {
    const t0 = Date.now();
    const r = await call("ae_inpaint_plate", { comp_id: ids.inpaint, plate_layer: { name: "Plate" }, regions: [hole], method, object_moves: true, ref_time: REF_T, start: 0, end: END, max_frames: 20, preview: false, expect });
    out[`static_${method}`] = r.ok === false || !r.fill?.png_path
      ? { ok: false, message: r.message ?? brief(r) }
      : { ok: true, ms: Date.now() - t0, temporal_share: r.fill?.filled?.temporal_share ?? null, low_confidence_share: r.fill?.filled?.low_confidence_share ?? null, ...compareFill(r.fill.png_path, truthStatic, OBJECT_HOLE) };
  }
  // Moving camera: track the plate away from the object's path, then fill along the track.
  const trk = await call("ae_track_multi", { comp_id: ids.inpaint_moving, auto_points: { region: { rect: REGION }, exclude: [{ rect: [240, 200, 480, 140] }], count: 8 }, ref_time: REF_T, start: 0, end: END, model: "perspective", preview: false, max_frames: 1000, max_seconds: 300 });
  if (trk.ok && trk.track_id) {
    const truthMoving = await frame(ids.inpaint_truth_moving, REF_T);
    const t0 = Date.now();
    const r = await call("ae_inpaint_plate", { comp_id: ids.inpaint_moving, plate_layer: { name: "Plate" }, regions: [hole], track: { track_id: trk.track_id }, method: "auto", object_moves: true, ref_time: REF_T, start: 0, end: END, max_frames: 20, preview: false, expect });
    out.moving_auto = r.ok === false || !r.fill?.png_path
      ? { ok: false, message: r.message ?? brief(r) }
      : { ok: true, ms: Date.now() - t0, track_expected_px: trk.expected_error_px ?? null, temporal_share: r.fill?.filled?.temporal_share ?? null, low_confidence_share: r.fill?.filled?.low_confidence_share ?? null, ...compareFill(r.fill.png_path, truthMoving, OBJECT_HOLE) };
  } else {
    out.moving_auto = { ok: false, message: `track failed: ${trk.message ?? brief(trk)}` };
  }
  return out;
}

// ---------- main ----------

async function main() {
  const client = createClient();
  await assertSafeInitialProject(client);
  await resetQaProject(client);
  await postMcp({ jsonrpc: "2.0", id: ++seq, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa-calibrate", version: "1" } } });
  fs.mkdirSync(ROOT, { recursive: true });
  const platePath = preparePlate();
  const expect = { project_path: "<unsaved>" };

  const imp = await call("ae_import_footage", { paths: [platePath], expect });
  const plateId = imp.items?.[0]?.id ?? imp.imported?.[0]?.id ?? imp.item_ids?.[0];
  if (!plateId) throw new Error("Plate import failed: " + brief(imp));

  const scene = await call("ae_run_jsx", {
    mutates: true,
    label: "qa calibrate: shots",
    expect,
    code: [
      `function mk(n) { return app.project.items.addComp(n, ${W}, ${H}, 1, ${DUR}, ${FPS}); }`,
      "var ids = {};",
      `var foot = app.project.itemByID(${plateId});`,
      'var src = mk("Cal Plate Src"); var pl = src.layers.add(foot);',
      // Fill the frame with margin, so the moving pins rarely show an edge inside the tracked region.
      `var s = Math.max(${W} / foot.width, ${H} / foot.height) * 100 * 1.25; pl.property("ADBE Transform Group").property("ADBE Scale").setValue([s, s]);`,
      "ids.src = src.id;",
      ...SHOTS.map(shotJsx),
      stageBJsx(),
      grainCurveJsx(),
      projectionJsx(),
      solveJsx(),
      stageCJsx(),
      "return ids;",
    ].join("\n"),
  });
  const ids = scene.result;
  if (!ids || typeof ids.clean !== "number") throw new Error("Could not build the shots: " + brief(scene));
  // Inpaint writes its plates next to the project, so the project needs a home: the work dir.
  const saved = await call("ae_save", { save_as: { path: path.join(ROOT, "Calibrate.aep") }, expect });
  if (saved.ok === false) throw new Error("Could not save the calibration project: " + brief(saved));
  expect.project_path = (await call("ae_status")).project_path;

  const report = { when: new Date().toISOString(), ae: null, comp: { width: W, height: H, fps: FPS, frames: FRAMES }, region: REGION, plate: path.basename(platePath), shots: {} };
  const st = await call("ae_status");
  report.ae = st.ae_version ?? st.version ?? null;

  if (want("track")) {
    for (const shot of SHOTS) {
      const compId = ids[shot.name];
      const out = { shot };
      for (const model of ["perspective", "similarity"]) {
        if (model === "similarity" && shot.kind === "pin" && shot.name !== "clean") continue;
        const { r, ms } = await trackMulti(compId, model);
        if (!r.ok || !r.track_path) {
          out[model] = { ok: false, message: r.message ?? brief(r), ms };
          continue;
        }
        const track = JSON.parse(fs.readFileSync(r.track_path, "utf8"));
        out[model] = {
          ok: true,
          ms,
          track_id: track.track_id,
          points: track.ref_points.length,
          tool_rms: r.rms_px ?? null,
          tool_expected: r.expected_error_px ?? null,
          tool_jitter: r.corner_jitter_px ?? null,
          tool_sliding: r.sliding_points ?? null,
          ...scorePlanar(shot, track),
        };
        if (model === "perspective") out.ref_points = track.ref_points;
      }
      // Two single points: the two reference points farthest apart.
      const refs = out.ref_points ?? [];
      const pair = [];
      let best = -1;
      for (let a = 0; a < refs.length; a++) for (let b = a + 1; b < refs.length; b++) if (dist(refs[a], refs[b]) > best) [best, pair[0], pair[1]] = [dist(refs[a], refs[b]), refs[a], refs[b]];
      out.point = [];
      for (const p of pair.filter(Boolean)) out.point.push(await trackPoint(shot, compId, p));
      report.shots[shot.name] = out;
      const pm = out.perspective;
      console.log(
        `${shot.name.padEnd(13)} perspective: ${pm?.ok ? `${pm.solved}/${pm.frames} solved, true mean ${pm.true_mean_px?.mean}px p95 ${pm.true_mean_px?.p95} max ${pm.true_max_px?.max}; rms ${pm.reported_rms_px?.mean}, expected ${pm.expected_px?.mean} (true/expected ${pm.true_over_expected}); jitter ${pm.tool_jitter} (true ${pm.true_corner_jitter_px}); sliding ${JSON.stringify((pm.tool_sliding ?? []).map((p) => p.index))}; flagged ${JSON.stringify(pm.flagged_unreliable?.map((f) => f.frame) ?? [])}` : pm?.message}` +
          ` | points: ${out.point.map((p) => (p.ok ? `${p.true_err_px?.mean}/${p.true_err_px?.max}px${p.lost_at ? " lost" : ""}` : "fail")).join(", ")}`
      );
    }
  }

  if (want("colour")) {
    report.colour = await stageColour(ids, expect);
    console.log(`colour        ${report.colour.ok ? `residual worst ${report.colour.worst_residual_levels} levels (uncorrected ${report.colour.worst_uncorrected_levels})` : report.colour.message ?? report.colour.raw}`);
  }
  if (want("grain")) {
    report.grain = await stageGrain(ids, expect);
    const g = report.grain;
    console.log(`grain         ${g.ok ? `plate ${g.after?.plate_ring.sigma} (lag1 ${g.after?.plate_ring.lag1_corr}), patch before ${g.before?.patch.sigma}, after ${g.after?.patch.sigma} (lag1 ${g.after?.patch.lag1_corr}); ratio ${g.sigma_ratio_after}; tool size ${g.tool?.size} (${g.tool?.size_from}), intensity ${g.tool?.start_intensity} -> ${g.tool?.final_intensity}` : g.message ?? g.raw}`);
  }
  if (want("projection")) {
    report.projection = await stageProjection(ids);
    for (const p of report.projection) console.log(`projection    ${p.camera.padEnd(9)} node vs AE toComp: mean ${p.mean_px}px max ${p.max_px}px over ${p.points}${p.examples.length ? `; ${p.examples.join("; ")}` : ""}`);
  }
  if (want("solve")) {
    report.solve = await stageSolve(ids);
    for (const [k, v] of Object.entries(report.solve)) {
      if (!v.ok) {
        console.log(`solve check   ${k}: ${v.message}`);
        continue;
      }
      const tool = v.plane_nulls.map((p) => p.tool_max_px ?? NaN);
      const truth = v.plane_nulls.map((p) => p.true_max_px);
      console.log(`solve check   ${k.padEnd(8)} ${v.verdict}; mean ${v.error_px?.mean} p95 ${v.error_px?.p95}; plane nulls max tool ${tool.map((x) => x.toFixed(2)).join(" ")} | true ${truth.map((x) => x.toFixed(2)).join(" ")}; off plane ${JSON.stringify(v.off_plane)}`);
    }
  }
  if (want("grain_curve")) {
    report.grain_curve = await stageGrainCurve(ids);
    for (const g of report.grain_curve) console.log(`add grain     size ${String(g.size).padEnd(5)} intensity ${String(g.intensity).padEnd(4)} sigma ${g.sigma}  lag1 ${g.lag1_corr}`);
  }
  if (want("inpaint")) {
    report.inpaint = await stageInpaint(ids, expect);
    for (const [k, v] of Object.entries(report.inpaint)) console.log(`inpaint ${k.padEnd(14)} ${v.ok ? `MAE ${v.mae_levels} levels, PSNR ${v.psnr_db} dB, temporal ${v.temporal_share}, low-confidence ${v.low_confidence_share}` : v.message}`);
  }

  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  const outPath = path.join(__dirname, "out", "calibration.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

export { SHOTS, trueH, gridPoints, apply, dist, stats, FPS, REGION };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
