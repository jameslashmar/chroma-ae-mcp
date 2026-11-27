/**
 * qa/bench/tasks.mjs
 *
 * Fifteen everyday After Effects requests, written the way a user would type them. Each has:
 * - setup: ExtendScript (the body of a function, ES3) that builds the starting project, run through
 *   ae_run_jsx before the agent starts;
 * - prompt: what the agent is asked;
 * - check: reads the result back from After Effects (ae_run_jsx read-only, or a rendered frame) and says
 *   pass or fail with the numbers. Checks look at the outcome, not at the method: a fade done with keys
 *   or with an expression passes alike, a colour is checked on the rendered pixel.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pngSize, readPng } from "./png.mjs";

/** ExtendScript helpers prepended to every check (ES3). */
export const LIB = `
function compNamed(n) { for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === n) return it; } return null; }
function layerNamed(c, n) { if (!c) return null; for (var i = 1; i <= c.numLayers; i++) { if (c.layer(i).name === n) return c.layer(i); } return null; }
function tr(l, m) { return l.property("ADBE Transform Group").property(m); }
function at(p, t) { var v = p.valueAtTime(t, false); return (v instanceof Array) ? v.slice(0) : v; }
function visible(l, t) { return l.enabled && t >= l.inPoint && t < l.outPoint; }
`;

const mainComp = (seconds = 10) => `var c = app.project.items.addComp("Main", 1920, 1080, 1, ${seconds}, 25);`;
const solid = (name, rgb, w, h) => `c.layers.addSolid([${rgb.join(",")}], "${name}", ${w}, ${h}, 1);`;
const items5 = `for (var i = 1; i <= 5; i++) { var t = c.layers.addText("Item " + i); t.name = "Item " + i; t.property("ADBE Transform Group").property("ADBE Position").setValue([960, 240 + i * 110]); }`;
const openMain = `c.openInViewer(); return c.id;`;

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);

function result(checks) {
  const failed = checks.filter((c) => !c.ok);
  return { pass: failed.length === 0, checks: checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.what}: ${c.got}`) };
}

export const TASKS = [
  {
    id: "T01-title",
    title: "Title card: new comp with centred text",
    setup: () => `return 0;`,
    prompt: () => "Create a new 1920x1080 composition called 'Title Card', 6 seconds long at 25 fps. Put the text 'Hello World' in the middle of the frame, in white, 120 px.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Title Card"); if (!c) return { comp: null };
var out = { comp: { w: c.width, h: c.height, d: c.duration, fps: c.frameRate }, text: null };
for (var i = 1; i <= c.numLayers; i++) { var l = c.layer(i); if (!(l instanceof TextLayer)) continue;
  var doc = l.property("ADBE Text Properties").property("ADBE Text Document").value;
  var r = l.sourceRectAtTime(0, false); var a = at(tr(l, "ADBE Anchor Point"), 0); var p = at(tr(l, "ADBE Position"), 0); var s = at(tr(l, "ADBE Scale"), 0);
  out.text = { text: doc.text, size: doc.fontSize, fill: doc.applyFill ? doc.fillColor : null, cx: p[0] + (r.left + r.width / 2 - a[0]) * s[0] / 100, cy: p[1] + (r.top + r.height / 2 - a[1]) * s[1] / 100 }; break; }
return out;`);
      if (!r?.comp) return result([{ ok: false, what: "comp 'Title Card'", got: "missing" }]);
      const t = r.text;
      return result([
        { ok: r.comp.w === 1920 && r.comp.h === 1080, what: "size 1920x1080", got: `${r.comp.w}x${r.comp.h}` },
        { ok: near(r.comp.d, 6, 0.05), what: "6 s", got: fmt(r.comp.d) },
        { ok: near(r.comp.fps, 25, 0.01), what: "25 fps", got: fmt(r.comp.fps) },
        { ok: !!t && t.text.trim() === "Hello World", what: "text 'Hello World'", got: t ? JSON.stringify(t.text) : "no text layer" },
        { ok: !!t && near(t.size, 120, 1), what: "120 px", got: t ? fmt(t.size) : "-" },
        { ok: !!t && Array.isArray(t.fill) && t.fill.every((v) => v > 0.98), what: "white", got: t ? JSON.stringify(t.fill) : "-" },
        { ok: !!t && near(t.cx, 960, 40) && near(t.cy, 540, 40), what: "centred (±40 px)", got: t ? `${fmt(t.cx)}, ${fmt(t.cy)}` : "-" },
      ]);
    },
  },
  {
    id: "T02-fade",
    title: "Fade a layer in and out",
    setup: () => `${mainComp()} ${solid("Logo", [0.9, 0.3, 0.1], 400, 400)} ${openMain}`,
    prompt: () => "In the 'Main' comp, make the 'Logo' layer fade in over the first second and fade out over the last second.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var l = layerNamed(c, "Logo"); if (!l) return null; var o = tr(l, "ADBE Opacity");
var ts = [0, 0.5, 1, 5, 9, 9.5, 9.96]; var v = []; for (var i = 0; i < ts.length; i++) v.push(visible(l, ts[i]) ? at(o, ts[i]) : 0); return v;`);
      if (!r) return result([{ ok: false, what: "layer 'Logo'", got: "missing" }]);
      const [o0, o05, o1, o5, o9, o95, oEnd] = r;
      return result([
        { ok: o0 <= 5, what: "transparent at 0 s", got: fmt(o0) },
        { ok: o05 > 10 && o05 < 90, what: "half-way at 0.5 s", got: fmt(o05) },
        { ok: o1 >= 95 && o5 >= 95 && o9 >= 95, what: "opaque from 1 s to 9 s", got: [o1, o5, o9].map(fmt).join(", ") },
        { ok: o95 > 10 && o95 < 90, what: "half-way at 9.5 s", got: fmt(o95) },
        { ok: oEnd <= 10, what: "transparent at the end", got: fmt(oEnd) },
      ]);
    },
  },
  {
    id: "T03-pop",
    title: "Scale pop with overshoot",
    setup: () => `${mainComp()} ${solid("Logo", [0.9, 0.3, 0.1], 400, 400)} ${openMain}`,
    prompt: () => "Make the 'Logo' layer in 'Main' pop in at 1 second: scale it from 0% to 100% in half a second with a little overshoot, then let it settle.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var l = layerNamed(c, "Logo"); if (!l) return null; var s = tr(l, "ADBE Scale");
var v = []; for (var f = 0; f <= 75; f++) { var t = f / 25; v.push(visible(l, t) ? at(s, t)[0] : 0); } return v;`);
      if (!r) return result([{ ok: false, what: "layer 'Logo'", got: "missing" }]);
      const before = Math.max(...r.slice(0, 25));
      const peak = Math.max(...r.slice(25, 51));
      return result([
        { ok: before <= 5, what: "not visible before 1 s", got: fmt(before) },
        { ok: r[25] <= 10, what: "about 0% at 1 s", got: fmt(r[25]) },
        { ok: peak > 102 && peak < 140, what: "overshoots past 100% (but not wildly)", got: fmt(peak) },
        { ok: near(r[60], 100, 2) && near(r[75], 100, 1), what: "settles at 100% by 2.4-3 s", got: `${fmt(r[60])}, ${fmt(r[75])}` },
      ]);
    },
  },
  {
    id: "T04-slide",
    title: "Slide in from the left with ease-out",
    setup: () => `${mainComp()} ${solid("Card", [0.2, 0.6, 0.9], 600, 300)} ${openMain}`,
    prompt: () => "Slide the 'Card' layer in 'Main' in from off the left edge of the frame to the centre over the first second, easing out at the end.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var l = layerNamed(c, "Card"); if (!l) return null; var p = tr(l, "ADBE Position"); var s = tr(l, "ADBE Scale"); var a = tr(l, "ADBE Anchor Point");
var f = function (t) { var pp = at(p, t), aa = at(a, t), ss = at(s, t); return [pp[0] + (300 - aa[0]) * ss[0] / 100, pp[1] + (150 - aa[1]) * ss[1] / 100, ss[0]]; };
return { t0: f(0), t004: f(0.04), t096: f(0.96), t1: f(1), t3: f(3) };`);
      if (!r) return result([{ ok: false, what: "layer 'Card'", got: "missing" }]);
      const rightEdge0 = r.t0[0] + (300 * r.t0[2]) / 100;
      const vStart = r.t004[0] - r.t0[0];
      const vEnd = r.t1[0] - r.t096[0];
      return result([
        { ok: rightEdge0 <= 20, what: "off the left edge at 0 s (right edge ≤ 20 px)", got: fmt(rightEdge0) },
        { ok: near(r.t1[0], 960, 10) && near(r.t1[1], 540, 10), what: "centred at 1 s", got: `${fmt(r.t1[0])}, ${fmt(r.t1[1])}` },
        { ok: near(r.t3[0], 960, 10), what: "stays centred", got: fmt(r.t3[0]) },
        { ok: vStart > 0 && vEnd < vStart * 0.6, what: "eases out (slower at the end than at the start)", got: `start ${fmt(vStart)} px/frame, end ${fmt(vEnd)}` },
      ]);
    },
  },
  {
    id: "T05-stagger",
    title: "Staggered fade-in of five layers",
    setup: () => `${mainComp()} ${items5} ${openMain}`,
    prompt: () => "Make the five 'Item' text layers in 'Main' fade in one after another, 0.2 seconds apart, each fade lasting 0.5 seconds, starting with Item 1 at 0 seconds.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var out = [];
for (var i = 1; i <= 5; i++) { var l = layerNamed(c, "Item " + i); if (!l) { out.push(null); continue; } var o = tr(l, "ADBE Opacity"); var s = 0.2 * (i - 1);
  var g = function (t) { return visible(l, t) ? at(o, t) : 0; };
  out.push({ before: s > 0 ? g(s - 0.04) : 0, start: g(s), mid: g(s + 0.25), end: g(s + 0.5), later: g(s + 2) }); }
return out;`);
      return result(
        (r ?? [null, null, null, null, null]).map((x, i) => ({
          ok: !!x && x.before <= 5 && x.start <= 10 && x.mid > 15 && x.mid < 90 && x.end >= 95 && x.later >= 95,
          what: `Item ${i + 1} fades in from ${fmt(0.2 * i)} s to ${fmt(0.2 * i + 0.5)} s`,
          got: x ? [x.before, x.start, x.mid, x.end, x.later].map(fmt).join(" / ") : "missing",
        }))
      );
    },
  },
  {
    id: "T06-shadow",
    title: "Drop shadow effect with settings",
    setup: () => `${mainComp()} ${solid("Logo", [0.9, 0.3, 0.1], 400, 400)} ${openMain}`,
    prompt: () => "Add a drop shadow to the 'Logo' layer in 'Main', with 50% opacity and a distance of 10.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var l = layerNamed(c, "Logo"); if (!l) return null; var fx = l.property("ADBE Effect Parade");
for (var i = 1; i <= fx.numProperties; i++) { var e = fx.property(i); if (e.matchName === "ADBE Drop Shadow") return { opacity: e.property("Opacity").value, distance: e.property("Distance").value, enabled: e.enabled }; }
var st = l.property("ADBE Layer Styles"); return { style: st ? st.canSetEnabled : null };`);
      if (!r) return result([{ ok: false, what: "layer 'Logo'", got: "missing" }]);
      if (r.opacity === undefined) return result([{ ok: false, what: "a Drop Shadow effect", got: JSON.stringify(r) }]);
      return result([
        { ok: r.enabled !== false, what: "Drop Shadow on", got: String(r.enabled) },
        { ok: near(r.opacity, 50, 1) || near(r.opacity, 127.5, 2), what: "opacity 50%", got: fmt(r.opacity) },
        { ok: near(r.distance, 10, 0.5), what: "distance 10", got: fmt(r.distance) },
      ]);
    },
  },
  {
    id: "T07-color",
    title: "Change a solid's colour (checked on the rendered pixel)",
    setup: () => `${mainComp()} ${solid("BG", [0.5, 0.5, 0.5], 1920, 1080)} ${openMain}`,
    prompt: () => "Change the colour of the 'BG' solid in 'Main' to #1E90FF.",
    check: async ({ call, jsx }) => {
      const id = await jsx(`${LIB} var c = compNamed("Main"); return c ? c.id : null;`);
      if (!id) return result([{ ok: false, what: "comp 'Main'", got: "missing" }]);
      const s = await call("ae_snapshot_frame", { comp_id: id, time: 1 });
      const file = s.full_path ?? s.path;
      if (!s.ok || !file || !fs.existsSync(file)) return result([{ ok: false, what: "a rendered frame", got: JSON.stringify(s).slice(0, 200) }]);
      const png = readPng(file);
      const i = (Math.floor(png.height / 4) * png.width + Math.floor(png.width / 4)) * png.channels;
      const px = [png.data[i], png.data[i + 1], png.data[i + 2]];
      return result([{ ok: near(px[0], 30, 6) && near(px[1], 144, 6) && near(px[2], 255, 6), what: "pixel is #1E90FF (30,144,255) ±6", got: px.join(",") }]);
    },
  },
  {
    id: "T08-precompose",
    title: "Precompose five layers",
    setup: () => `${mainComp()} ${items5} ${openMain}`,
    prompt: () => "Precompose the layers 'Item 1' to 'Item 5' in 'Main' into a new composition called 'List'.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var list = compNamed("List"); var main = compNamed("Main"); var out = { list: null, mainItems: 0, mainHasList: false };
if (list) { out.list = []; for (var i = 1; i <= list.numLayers; i++) out.list.push(list.layer(i).name); }
if (main) for (var j = 1; j <= main.numLayers; j++) { var l = main.layer(j); if (/^Item \\d$/.test(l.name) && l instanceof TextLayer) out.mainItems++; if (l.source && l.source === list) out.mainHasList = true; }
return out;`);
      const names = (r?.list ?? []).slice().sort();
      return result([
        { ok: !!r?.list, what: "comp 'List' exists", got: r?.list ? "yes" : "no" },
        { ok: JSON.stringify(names) === JSON.stringify(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]), what: "'List' holds Item 1-5", got: names.join(", ") || "-" },
        { ok: r?.mainHasList === true && r?.mainItems === 0, what: "'Main' uses 'List' instead of the five layers", got: `uses List: ${r?.mainHasList}, text items left: ${r?.mainItems}` },
      ]);
    },
  },
  {
    id: "T09-null",
    title: "Null controller parenting without a jump",
    setup: () => `${mainComp()} ${items5} ${openMain}`,
    prompt: () => "Add a null called 'Controller' to 'Main' and parent all five 'Item' text layers to it, without them moving on screen.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var n = layerNamed(c, "Controller"); if (!n) return { nul: false };
var np = at(tr(n, "ADBE Position"), 0), na = at(tr(n, "ADBE Anchor Point"), 0), ns = at(tr(n, "ADBE Scale"), 0), nr = at(tr(n, "ADBE Rotate Z"), 0);
var out = { nul: n.nullLayer, items: [] };
for (var i = 1; i <= 5; i++) { var l = layerNamed(c, "Item " + i); if (!l) { out.items.push(null); continue; } var p = at(tr(l, "ADBE Position"), 0);
  var w = l.parent === n ? [np[0] + (p[0] - na[0]) * ns[0] / 100, np[1] + (p[1] - na[1]) * ns[1] / 100] : p;
  out.items.push({ parented: l.parent === n, world: w, rot: nr }); }
return out;`);
      if (!r?.nul) return result([{ ok: false, what: "null 'Controller'", got: r ? "not a null" : "missing" }]);
      return result(
        r.items.map((x, i) => ({
          ok: !!x && x.parented && near(x.world[0], 960, 1) && near(x.world[1], 240 + (i + 1) * 110, 1),
          what: `Item ${i + 1} parented, still at (960, ${240 + (i + 1) * 110})`,
          got: x ? `parented ${x.parented}, at ${x.world.map(fmt).join(", ")}` : "missing",
        }))
      );
    },
  },
  {
    id: "T10-mask",
    title: "Feathered elliptical mask",
    setup: () => `${mainComp()} ${solid("Photo", [0.3, 0.7, 0.3], 800, 800)} ${openMain}`,
    prompt: () => "Add an elliptical mask to the 'Photo' layer in 'Main' that fills the layer, with a 20 px feather.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); var l = layerNamed(c, "Photo"); if (!l) return null; var m = l.property("ADBE Mask Parade"); if (m.numProperties < 1) return { masks: 0 };
var k = m.property(1); var sh = k.property("ADBE Mask Shape").value; var v = sh.vertices; var xs = [], ys = []; for (var i = 0; i < v.length; i++) { xs.push(v[i][0]); ys.push(v[i][1]); }
var tan = 0; for (var j = 0; j < sh.inTangents.length; j++) tan += Math.abs(sh.inTangents[j][0]) + Math.abs(sh.inTangents[j][1]);
return { masks: m.numProperties, n: v.length, minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs), minY: Math.min.apply(null, ys), maxY: Math.max.apply(null, ys), tan: tan, feather: k.property("ADBE Mask Feather").value, mode: k.maskMode, inverted: k.inverted };`);
      if (!r) return result([{ ok: false, what: "layer 'Photo'", got: "missing" }]);
      if (!r.masks) return result([{ ok: false, what: "a mask", got: "none" }]);
      return result([
        { ok: r.n === 4 && r.tan > 100, what: "an ellipse (4 curved vertices)", got: `${r.n} vertices, tangents ${fmt(r.tan)}` },
        { ok: near(r.minX, 0, 40) && near(r.maxX, 800, 40) && near(r.minY, 0, 40) && near(r.maxY, 800, 40), what: "fills the 800x800 layer (±40 px)", got: [r.minX, r.maxX, r.minY, r.maxY].map(fmt).join(", ") },
        { ok: near(r.feather[0], 20, 1) && near(r.feather[1], 20, 1), what: "20 px feather", got: r.feather.map(fmt).join(", ") },
        { ok: r.inverted !== true, what: "not inverted", got: String(r.inverted) },
      ]);
    },
  },
  {
    id: "T11-trim",
    title: "Trim a layer",
    setup: () => `${mainComp()} ${solid("Clip", [0.6, 0.6, 0.2], 1920, 1080)} ${openMain}`,
    prompt: () => "Trim the 'Clip' layer in 'Main' so it starts at 2 seconds and ends at 5 seconds.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB} var l = layerNamed(compNamed("Main"), "Clip"); return l ? { inP: l.inPoint, outP: l.outPoint } : null;`);
      if (!r) return result([{ ok: false, what: "layer 'Clip'", got: "missing" }]);
      return result([
        { ok: near(r.inP, 2, 0.041), what: "starts at 2 s", got: fmt(r.inP) },
        { ok: near(r.outP, 5, 0.041), what: "ends at 5 s", got: fmt(r.outP) },
      ]);
    },
  },
  {
    id: "T12-rotate",
    title: "Continuous rotation",
    setup: () => `${mainComp()} ${solid("Gear", [0.8, 0.8, 0.8], 300, 300)} ${openMain}`,
    prompt: () => "Make the 'Gear' layer in 'Main' rotate continuously at 90 degrees per second for the whole comp.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB} var l = layerNamed(compNamed("Main"), "Gear"); if (!l) return null; var p = tr(l, "ADBE Rotate Z"); return [at(p, 0), at(p, 2), at(p, 4), at(p, 9.96)];`);
      if (!r) return result([{ ok: false, what: "layer 'Gear'", got: "missing" }]);
      const d = r.map((v) => v - r[0]);
      return result([
        { ok: near(Math.abs(d[1]), 180, 1) && near(Math.abs(d[2]), 360, 1), what: "90°/s (180° at 2 s, 360° at 4 s)", got: d.slice(1, 3).map(fmt).join(", ") },
        { ok: near(Math.abs(d[3]), 896.4, 3), what: "still turning at the end", got: fmt(d[3]) },
      ]);
    },
  },
  {
    id: "T13-captions",
    title: "Captions from an SRT file",
    files: (dir) => {
      const srt = path.join(dir, "subtitles.srt");
      fs.writeFileSync(srt, "1\r\n00:00:00,500 --> 00:00:02,000\r\nWelcome to the show\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,000\r\nThis is a caption test\r\n\r\n3\r\n00:00:04,500 --> 00:00:06,000\r\nThanks for watching\r\n");
      return { srt };
    },
    setup: () => `${mainComp()} ${solid("BG", [0.1, 0.1, 0.1], 1920, 1080)} ${openMain}`,
    prompt: ({ srt }) => `Add captions to the 'Main' comp from the subtitle file ${srt}.`,
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Main"); if (!c) return null; var ts = [1, 2.25, 3.25, 5.25]; var out = [];
for (var k = 0; k < ts.length; k++) { var t = ts[k]; var said = [];
  for (var i = 1; i <= c.numLayers; i++) { var l = c.layer(i); if (!(l instanceof TextLayer) || !visible(l, t)) continue; if (at(tr(l, "ADBE Opacity"), t) < 50) continue;
    said.push(l.property("ADBE Text Properties").property("ADBE Text Document").valueAtTime(t, false).text); }
  out.push(said.join(" | ")); }
return out;`);
      if (!r) return result([{ ok: false, what: "comp 'Main'", got: "missing" }]);
      const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
      return result([
        { ok: norm(r[0]).includes("welcome to the show"), what: "cue 1 shown at 1 s", got: JSON.stringify(r[0]) },
        { ok: !/welcome|caption test|thanks/i.test(r[1]), what: "nothing shown in the gap at 2.25 s", got: JSON.stringify(r[1]) },
        { ok: norm(r[2]).includes("this is a caption test"), what: "cue 2 shown at 3.25 s", got: JSON.stringify(r[2]) },
        { ok: norm(r[3]).includes("thanks for watching"), what: "cue 3 shown at 5.25 s", got: JSON.stringify(r[3]) },
      ]);
    },
  },
  {
    id: "T14-track",
    title: "Track a moving square and attach a layer",
    files: (dir, { ffmpeg }) => {
      const plate = path.join(dir, "plate.mp4");
      const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x202020:s=1280x720:d=3:r=25", "-f", "lavfi", "-i", "color=c=white:s=60x60:d=3:r=25", "-filter_complex", "[0][1]overlay=x='170+880*t/3':y=330:shortest=1,format=yuv420p", "-c:v", "libx264", "-crf", "12", plate], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
      return { plate };
    },
    setup: ({ plate }) => `var f = app.project.importFile(new ImportOptions(new File("${plate.replace(/\\/g, "/")}"))); f.name = "Plate";
var c = app.project.items.addComp("Track", 1280, 720, 1, 3, 25); var pl = c.layers.add(f); pl.name = "Plate";
var lab = c.layers.addSolid([1, 0.2, 0.2], "Label", 100, 40, 1); lab.property("ADBE Transform Group").property("ADBE Position").setValue([640, 200]); c.openInViewer(); return c.id;`,
    prompt: () => "In the 'Track' comp, track the white square moving across the 'Plate' footage and make the 'Label' layer follow it.",
    check: async ({ jsx }) => {
      const r = await jsx(`${LIB}
var c = compNamed("Track"); var l = layerNamed(c, "Label"); if (!l) return null;
var w = function (t) { var p = at(tr(l, "ADBE Position"), t); var q = l.parent; var x = p[0], y = p[1];
  while (q) { var qp = at(tr(q, "ADBE Position"), t), qa = at(tr(q, "ADBE Anchor Point"), t), qs = at(tr(q, "ADBE Scale"), t); x = qp[0] + (x - qa[0]) * qs[0] / 100; y = qp[1] + (y - qa[1]) * qs[1] / 100; q = q.parent; }
  return [x, y]; };
return [w(0), w(1.48), w(2.96)];`);
      if (!r) return result([{ ok: false, what: "layer 'Label'", got: "missing" }]);
      const want = (t) => 880 * (t / 3);
      const dx1 = r[1][0] - r[0][0];
      const dx2 = r[2][0] - r[0][0];
      const dy = Math.max(Math.abs(r[1][1] - r[0][1]), Math.abs(r[2][1] - r[0][1]));
      return result([
        { ok: near(dx1, want(1.48), 15), what: `moves with the square by 1.48 s (+${fmt(want(1.48))} px ±15)`, got: fmt(dx1) },
        { ok: near(dx2, want(2.96), 15), what: `moves with the square by 2.96 s (+${fmt(want(2.96))} px ±15)`, got: fmt(dx2) },
        { ok: dy <= 10, what: "no vertical drift (≤10 px)", got: fmt(dy) },
      ]);
    },
  },
  {
    id: "T15-render",
    title: "Render one second as a PNG sequence",
    files: (dir) => {
      const out = path.join(dir, "render_out");
      fs.mkdirSync(out, { recursive: true });
      return { out };
    },
    setup: () => `var c = app.project.items.addComp("Main", 1920, 1080, 1, 4, 25); c.layers.addSolid([0.2, 0.4, 0.8], "BG", 1920, 1080, 1); var t = c.layers.addText("Render me"); c.openInViewer(); return c.id;`,
    prompt: ({ out }) => `Render the first second of the 'Main' comp as a PNG sequence into the folder ${out}`,
    check: async ({ files }) => {
      const pngs = fs.existsSync(files.out) ? fs.readdirSync(files.out).filter((f) => /\.png$/i.test(f)).sort() : [];
      let size = "-";
      if (pngs.length > 0) {
        const p = pngSize(path.join(files.out, pngs[0]));
        size = `${p.width}x${p.height}`;
      }
      return result([
        { ok: pngs.length >= 24 && pngs.length <= 26, what: "25 PNG frames (24-26)", got: pngs.length },
        { ok: size === "1920x1080", what: "1920x1080", got: size },
      ]);
    },
  },
];

