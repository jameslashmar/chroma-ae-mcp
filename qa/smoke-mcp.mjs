#!/usr/bin/env node
// qa/smoke-mcp.mjs — live smoke test of every chroma-ae-mcp tool, through the
// panel's MCP endpoint (POST /mcp), against the After Effects on this machine.
//
//   node qa/smoke-mcp.mjs [--dir <work dir>]
//
// It follows the harness's isolation rules: it refuses to start unless AE has
// an unsaved empty project, a QA-owned one, or one under /_work/qa open, and
// it builds its own project. The work dir defaults to
// <tmp>/_work/qa/mcp-smoke/<stamp>, so the project it leaves open passes the
// guard on the next run. Writes qa/out/smoke.json and exits 1 on any failure.
// Plain Node 20, no dependencies.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, DEFAULT_HOST, DEFAULT_PORT, readToken } from "./client.js";
import { assertSafeInitialProject, resetQaProject } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.indexOf("--dir");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const ROOT = path.resolve(
  dirArg > 0 ? process.argv[dirArg + 1] : path.join(os.tmpdir(), "_work", "qa", "mcp-smoke", stamp)
);
const AEP = path.join(ROOT, "Smoke.aep");
const MEDIA = path.join(ROOT, "media");
const RENDER = path.join(ROOT, "render");

// 8x8 solid PNGs for the footage import and replace checks.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMCTN++exizY427kzj4UECRIkSJAg4QNAHgI7oUX6cwAAAABJRU5ErkJggg==";
const BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJklEQVR4AYXBAREAIBCAMCSNcex/dvEbyLb2uY8PCRIkSJAgQcIAZ6YCY4Mbu2IAAAAASUVORK5CYII=";

const token = readToken();
let seq = 0;

function postMcp(body, route = "/mcp") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: DEFAULT_HOST,
        port: Number(process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT,
        method: "POST",
        path: route,
        timeout: 600_000,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = "";
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
  if (r.error) return { __error: r.error.message };
  const text = r.result.content.find((c) => c.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { __text: text };
  }
  if (r.result.isError) parsed.__isError = true;
  return parsed;
}

const CLICKS_WAV = path.join(MEDIA, "clicks.wav");

/** A 48 kHz 16-bit mono WAV of short noise bursts on every beat at `bpm`, starting a quarter beat in. */
function clickWav(bpm, seconds) {
  const sr = 48000;
  const n = Math.round(seconds * sr);
  const data = Buffer.alloc(n * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31 - 1);
  for (let t = (60 / bpm) / 4; t < seconds; t += 60 / bpm) {
    const start = Math.round(t * sr);
    for (let i = 0; i < 0.03 * sr && start + i < n; i++) {
      data.writeInt16LE(Math.round(rnd() * 0.8 * Math.exp(-i / (0.006 * sr)) * 32767), (start + i) * 2);
    }
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const results = [];
function check(tool, ok, note = "") {
  results.push({ tool, ok: Boolean(ok), note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${tool.padEnd(30)} ${note}`);
}
const cpNote = (r) =>
  r.checkpoint
    ? `checkpoint ${r.checkpoint.status}${r.checkpoint.unsaved_changes_not_included ? " (unsaved changes left out)" : ""}`
    : "no checkpoint field";

// ---- helpers for the waves 1-3 steps ----
// A step that cannot run here (no font, no video footage, no matching template) is logged, not failed.
const skipped = [];
function skip(tool, why) {
  skipped.push({ tool, why });
  console.log(`SKIP  ${tool.padEnd(30)} ${why}`);
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const brief = (r) => String(JSON.stringify(r) ?? "none").slice(0, 220);
/** A guarded write that was applied and read back clean. */
const okWrite = (r) => r.applied === true && r.receipt?.matches === true;
/** The tool refused: a schema error, a typed refusal (ok false) or a call that applied nothing. */
const refused = (r) => r.__isError === true || Boolean(r.__error) || r.ok === false || r.applied === false;
/** Why a call failed, for the note column. */
const why = (r) =>
  String(r.message ?? r.__error ?? r.__text ?? ((r.receipt?.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; ") || r.error || ""));
/** A refusal of an unknown font names it and lists near matches (core.jsx checkTextFont, findFont, captions.jsx). */
const FONT_REFUSAL = /No installed font|not available|candidates|Near matches/i;

// ---- helpers for the waves 4-5 steps ----
/**
 * A step that only some After Effects builds can do (a version-gated API, a font, a plug-in). It passes when `ok(r)` holds,
 * is logged as SKIP when the tool or AE refused and the refusal TEXT matches `reason` (the host's own words for a missing version or API;
 * keep each pattern narrow, or a real bug reads as SKIP), and FAILS otherwise.
 */
function reasonText(r) {
  const strings = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string");
  return [...strings(r.message), ...strings(r.__error), ...strings(r.__text), ...strings(r.error), ...strings(r.reason), ...(r.receipt?.mismatches ?? []).flatMap((m) => strings(m?.message)), ...strings(r.warnings)].join(" | ");
}
function gated(tool, r, ok, reason, note = "") {
  if (ok(r)) check(tool, true, note || brief(r).slice(0, 160));
  else if (refused(r) && reason.test(reasonText(r))) skip(tool, `refused on this AE: ${(why(r) || brief(r)).slice(0, 150)}`);
  else check(tool, false, `${note}${note ? "; " : ""}${why(r) || brief(r).slice(0, 160)}`);
}

/** JSON for a note column, safe on undefined. */
const js = (v, n = 160) => String(JSON.stringify(v) ?? "none").slice(0, n);

/** A minimal Adobe Swatch Exchange file with one global RGB colour per entry ([r, g, b] in 0..1), for ae_brief import_swatches. */
function aseFile(colors) {
  const head = Buffer.alloc(12);
  head.write("ASEF", 0, "latin1");
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(0, 6);
  head.writeUInt32BE(colors.length, 8);
  const parts = [head];
  colors.forEach((c, i) => {
    const name = `Colour ${i + 1}`;
    const nameBuf = Buffer.alloc((name.length + 1) * 2);
    for (let k = 0; k < name.length; k++) nameBuf.writeUInt16BE(name.charCodeAt(k), k * 2);
    const body = Buffer.alloc(2 + nameBuf.length + 4 + 12 + 2);
    let o = 0;
    body.writeUInt16BE(name.length + 1, o);
    o += 2;
    nameBuf.copy(body, o);
    o += nameBuf.length;
    body.write("RGB ", o, "latin1");
    o += 4;
    for (const v of c) {
      body.writeFloatBE(v, o);
      o += 4;
    }
    body.writeUInt16BE(0, o);
    const block = Buffer.alloc(6);
    block.writeUInt16BE(0x0001, 0);
    block.writeUInt32BE(body.length, 2);
    parts.push(block, body);
  });
  return Buffer.concat(parts);
}

async function main() {
  const client = createClient();
  await assertSafeInitialProject(client);
  await resetQaProject(client);
  await postMcp({
    jsonrpc: "2.0",
    id: ++seq,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa-smoke", version: "1" } },
  });

  fs.mkdirSync(MEDIA, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, "a.png"), Buffer.from(RED_PNG, "base64"));
  fs.writeFileSync(path.join(MEDIA, "b.png"), Buffer.from(BLUE_PNG, "base64"));
  fs.writeFileSync(CLICKS_WAV, clickWav(120, 4));

  const settings = await call("ae_auto_checkpoint");
  const autoOn = settings.auto_checkpoint?.enabled === true;
  check("ae_auto_checkpoint", settings.applies_to?.length > 0, JSON.stringify(settings.auto_checkpoint));
  // With auto checkpoints off (the user's choice), every write must report "skipped".
  const want = (status) => (autoOn ? status : "skipped");

  // ---------- scene ----------
  const scene = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: scene",
    expect: { project_path: "<unsaved>" },
    code: [
      'var c = app.project.items.addComp("Smoke", 640, 360, 1, 3, 25);',
      'c.layers.addSolid([0.15, 0.15, 0.18], "BG", 640, 360, 1);',
      'var t = c.layers.addText("Hello"); t.name = "Title";',
      't.property("ADBE Transform Group").property("ADBE Position").setValue([320, 120]);',
      'var d = c.layers.addShape(); d.name = "Dot";',
      'var g = d.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");',
      'g.addProperty("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").setValue([60, 60]);',
      'g.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([1, 0.8, 0.1, 1]);',
      'var p = d.property("ADBE Transform Group").property("ADBE Position");',
      // A straight, linear move, so the review has something definite to flag.
      "p.setValueAtTime(0, [80, 240]); p.setValueAtTime(1.5, [560, 240]); p.setValueAtTime(2.5, [560, 300]);",
      "for (var k = 1; k <= 3; k++) p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      // An empty comp for ae_skill_run to write into, so the Smoke comp keeps its three layers.
      'var sk = app.project.items.addComp("Skill target", 320, 180, 1, 1, 25);',
      // An empty comp for the 0.4 layer, audio and animation tools, so they leave the Smoke comp alone.
      'var lc = app.project.items.addComp("Layers", 640, 360, 1, 3, 25);',
      // The 120 BPM click track in a comp of its own, for ae_audio_analyze.
      `var wav = app.project.importFile(new ImportOptions(new File(${JSON.stringify(CLICKS_WAV.replace(/\\/g, "/"))})));`,
      'var au = app.project.items.addComp("Audio", 320, 180, 1, 4, 25); au.layers.add(wav);',
      "return { comp_id: c.id, skill_comp_id: sk.id, layers_comp_id: lc.id, audio_comp_id: au.id };",
    ].join("\n"),
  });
  const COMP = scene.result?.comp_id;
  const SKILL_COMP = scene.result?.skill_comp_id;
  const LAYERS_COMP = scene.result?.layers_comp_id;
  const AUDIO_COMP = scene.result?.audio_comp_id;
  if (typeof COMP !== "number") throw new Error("Could not build the smoke scene: " + JSON.stringify(scene));

  // The scene above was a write on an unsaved project, so it took no checkpoint.
  check("ae_run_jsx (unsaved project)", scene.applied === true && scene.checkpoint?.status === "skipped", cpNote(scene));
  // ae_run_jsx now refuses project.save (its safety lint names ae_save), so the untitled project is named with ae_save save_as.
  // overwrite: true, because a second run into the same --dir finds Smoke.aep already there (save_as refuses an existing file otherwise).
  let r = await call("ae_save", { expect: { project_path: "<unsaved>" }, save_as: { path: AEP, overwrite: true } });
  check(
    "ae_save (save_as, untitled project)",
    r.applied === true && r.receipt?.matches !== false && r.previous_project_path === "<unsaved>" && /Smoke\.aep$/i.test(String(r.project_path)) && fs.existsSync(AEP),
    `${path.basename(String(r.project_path))}; ${why(r)}`
  );
  // Without a named project every later write is refused by the guard, so stop here instead of failing hundreds of steps.
  if (r.applied !== true) throw new Error("Could not name the smoke project with ae_save save_as: " + (why(r) || brief(r)));
  const expect = { project_path: AEP };

  // ---------- writes, each with its checkpoint ----------
  const dot = { name: "Dot" };
  const opacity = ["ADBE Transform Group", "ADBE Opacity"];
  r = await call("ae_set_property", { comp_id: COMP, layer: dot, path: opacity, value: 80, expect });
  check("ae_set_property", r.applied && r.receipt?.matches !== false && r.checkpoint?.status === want("created"), cpNote(r));

  // Review, fix with easy_ease, review again: the Dot's keys start out linear.
  r = await call("ae_motion_review", { comp_id: COMP });
  const dotLinear = (r.findings ?? []).filter((f) => f.kind === "linear" && f.severity === "medium" && f.layer.name === "Dot");
  check(
    "ae_motion_review (before)",
    r.ok && dotLinear.length >= 1 && dotLinear.every((f) => f.fix?.tool === "ae_set_keyframe_ease"),
    `${r.counts?.medium} medium, kinds ${Object.keys(r.by_kind ?? {}).join(", ")}`
  );

  r = await call("ae_set_keyframe_ease", { comp_id: COMP, layer: dot, path: ["ADBE Transform Group", "ADBE Position"], ease: "easy_ease", expect });
  check("ae_set_keyframe_ease", r.applied && r.checkpoint?.status === want("reused"), cpNote(r));

  r = await call("ae_motion_review", { comp_id: COMP });
  check("ae_motion_review (after)", r.ok && r.counts?.medium === 0, `${r.counts?.medium} medium, ${r.counts?.low} low`);

  // Ask for an ease the way an agent would, answer it the way the panel does
  // (POST /ask/answer), collect the answer, and apply the curve.
  r = await call("ae_ask_user", {
    question: "QA smoke: which ease?",
    kind: "ease",
    options: [
      { id: "in_out", label: "Ease in-out", curve: [0.42, 0, 0.58, 1] },
      { id: "snappy", label: "Snappy", curve: [0.2, 0, 0, 1] },
    ],
    wait_seconds: 0,
  });
  const askId = r.ask_id;
  const answered = await postMcp({ id: askId, choice_ids: ["in_out"], curve: [0.42, 0, 0.58, 1] }, "/ask/answer");
  r = await call("ae_ask_user", { ask_id: askId, wait_seconds: 0 });
  check(
    "ae_ask_user",
    answered?.ok === true && r.status === "answered" && r.chosen?.[0]?.id === "in_out" && r.edited === false,
    `${r.status}, curve ${JSON.stringify(r.curve)}`
  );

  r = await call("ae_set_keyframe_ease", { comp_id: COMP, layer: dot, path: ["ADBE Transform Group", "ADBE Position"], ease: { curve: r.curve ?? [0.42, 0, 0.58, 1] }, expect });
  check(
    "ae_set_keyframe_ease (curve)",
    r.applied && r.receipt?.matches === true && r.segments?.length === 2 && r.checkpoint?.status === want("reused"),
    `segments ${JSON.stringify(r.segments)}; ${cpNote(r)}`
  );

  // Effects on the BG: add, switch off, apply a preset from AE's own folder, remove.
  const bg = { name: "BG" };
  r = await call("ae_add_effect", { comp_id: COMP, layer: bg, effect: "ADBE Gaussian Blur 2", params: [{ param: "Blurriness", value: 4 }], expect });
  check("ae_add_effect", r.applied && r.receipt?.matches === true && r.checkpoint?.status === want("reused"), `${r.effect?.name}, ${r.effect?.params?.length} params`);
  r = await call("ae_set_effect", { comp_id: COMP, layer: bg, effect: { index: 1 }, enabled: false, expect });
  check("ae_set_effect", r.applied && r.receipt?.matches === true && r.effect?.enabled === false, `enabled ${r.effect?.enabled}`);
  r = await call("ae_list_presets", { filter: "Colorize", source: "app", limit: 1 });
  const smokePreset = r.presets?.[0]?.path;
  check("ae_list_presets", r.count > 0 && /\.ffx$/i.test(String(smokePreset)), `${r.count} match, ${r.scanned} scanned`);
  r = await call("ae_apply_preset", { comp_id: COMP, layer: bg, preset_path: smokePreset, expect });
  check("ae_apply_preset", r.applied && r.receipt?.matches === true && r.effects_added?.length >= 1, `added ${(r.effects_added ?? []).map((e) => e.name).join(", ")}`);
  r = await call("ae_remove_effect", { comp_id: COMP, layer: bg, effect: { index: 1 }, expect });
  check("ae_remove_effect", r.applied && r.receipt?.matches === true && r.removed?.matchName === "ADBE Gaussian Blur 2", `removed ${r.removed?.name}`);

  // Track the Dot's right edge for a few frames (its middle is flat), then
  // write the track to a null.
  r = await call("ae_track_point", { comp_id: COMP, point: [110, 240], end: 0.4, apply: { null_name: "Smoke Track", expect } });
  check(
    "ae_track_point",
    r.ok && r.frames_tracked === r.frames_requested && r.applied && r.receipt?.matches === true && fs.existsSync(String(r.preview_path)),
    `${r.frames_tracked}/${r.frames_requested} frames, min confidence ${r.min_confidence}, null ${r.null?.name}`
  );
  await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: remove track null",
    expect: { ...expect, comp_id: COMP },
    code: `app.project.itemByID(${COMP}).layer("Smoke Track").remove(); return 0;`,
  });

  // A green screen plate in its own comp: key it, and the check must measure it.
  const plate = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: green plate",
    expect,
    code: [
      'var k = app.project.items.addComp("Smoke Key", 320, 180, 1, 1, 25);',
      'k.layers.addSolid([0.1, 0.72, 0.22], "Screen", 320, 180, 1);',
      'k.layers.addSolid([0.85, 0.65, 0.55], "Subject", 120, 100, 1);',
      'var p = app.project.items.addComp("Smoke Key Test", 320, 180, 1, 1, 25); p.layers.add(k);',
      "return p.id;",
    ].join("\n"),
  });
  r = await call("ae_key_greenscreen", { comp_id: plate.result, layer: { index: 1 }, clip_black: 20, expect });
  check(
    "ae_key_greenscreen",
    r.ok && r.applied && r.receipt?.matches === true && r.screen_detected?.kind === "green" && r.metrics && r.metrics.screen_left_pct < 1,
    `verdict ${r.verdict}, screen left ${r.metrics?.screen_left_pct}%, holes ${r.metrics?.holes_pct}%`
  );

  r = await call("ae_set_text", { comp_id: COMP, layer: { name: "Title" }, text: "Smoke test", style: { fontSize: 40, fillColor: [1, 1, 1] }, expect });
  check("ae_set_text", r.applied && r.checkpoint?.status === want("reused"), cpNote(r));

  r = await call("ae_import_footage", { paths: [path.join(MEDIA, "a.png")], expect });
  const itemId = r.item_ids?.[0];
  check("ae_import_footage", r.applied && typeof itemId === "number" && r.checkpoint?.status === want("reused"), `item ${itemId}; ${cpNote(r)}`);

  r = await call("ae_replace_footage", { item_id: itemId, path: path.join(MEDIA, "b.png"), expect });
  check("ae_replace_footage", r.applied && /b\.png$/i.test(String(r.after_path)) && r.checkpoint?.status === want("reused"), cpNote(r));

  r = await call("ae_render_queue_add", { comp_id: COMP, output_path: path.join(RENDER, "rq_smoke.mov"), expect });
  check("ae_render_queue_add", r.applied && r.checkpoint?.status === want("reused"), `rq index ${r.index}; ${cpNote(r)}`);

  r = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: marker",
    expect: { ...expect, comp_id: COMP },
    code: `var c = app.project.itemByID(${COMP}); c.markerProperty.setValueAtTime(1, new MarkerValue("smoke")); return c.markerProperty.numKeys;`,
  });
  check("ae_run_jsx (write)", r.applied && r.result === 1 && r.checkpoint?.status === want("reused"), cpNote(r));

  // A project skill with two steps (args, prev and results), listed, then run into its own comp.
  r = await call("ae_skill_save", {
    name: "smoke-null",
    description: "Adds a null named from args.",
    steps: ["var c = app.project.itemByID(args.comp_id);\nvar n = c.layers.addNull();\nn.name = args.name;\nreturn n;", 'return prev.name + " " + results.length;'],
    scope: "project",
    overwrite: true,
    args_example: { comp_id: 1, name: "Rig" },
    expect: { project_path: AEP },
  });
  check("ae_skill_save", r.ok && fs.existsSync(path.join(ROOT, "ae-skills", "smoke-null", "2.jsx")), (r.files ?? []).join(", "));
  r = await call("ae_skill_list");
  check("ae_skill_list", r.ok && (r.skills ?? []).some((x) => x.name === "smoke-null" && x.scope === "project"), `${r.count} skill(s)`);
  r = await call("ae_skill_run", { name: "smoke-null", args: { comp_id: SKILL_COMP, name: "Rig" }, expect: { ...expect, comp_id: SKILL_COMP } });
  check("ae_skill_run", r.applied && r.value === "Rig 1" && r.receipt?.matches === true && r.checkpoint?.status === want("reused"), cpNote(r));

  // Two copies of the Smoke comp with the title from data, and a 9:16 reframe of it.
  r = await call("ae_build_from_data", {
    template_comp_id: COMP,
    rows: [{ lang: "en", t: "Hello" }, { lang: "tr", t: "Merhaba" }],
    mapping: [{ column: "t", layer: { name: "Title" }, target: "text" }],
    name: "{{template}} {{lang}}",
    expect,
  });
  check("ae_build_from_data", r.applied && r.receipt?.matches === true && r.comps?.length === 2 && r.checkpoint?.status === want("reused"), (r.comps ?? []).map((c) => c.name).join(", "));
  r = await call("ae_reframe", { comp_id: COMP, targets: [{ aspect: "9:16" }], expect });
  const vertical = r.comps?.[0];
  check("ae_reframe", r.applied && r.receipt?.matches === true && vertical?.width === 360 && vertical?.height === 640, `${vertical?.name}, ${(vertical?.outside_safe ?? []).length} outside the safe area`);

  // A still dropped in the asset folder goes into the _Assets bin, once.
  const staged = path.join(ROOT, "_assets", "stills", "red.png");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, Buffer.from(RED_PNG, "base64"));
  // The importer judges a file "still being written" by the newest of mtime, ctime and birthtime with a 2 s settle.
  // utimes only moves mtime (ctime and birthtime stay at "now"), so the file has to age for real: wait it out.
  await sleep(2500);
  r = await call("ae_import_assets", { expect: { project_path: AEP } });
  const again = await call("ae_import_assets", { dry_run: true, expect: { project_path: AEP } });
  check("ae_import_assets", r.ok && r.imported?.length === 1 && r.receipt?.matches === true && again.to_import?.length === 0, `${r.imported?.[0]?.name} into ${r.bin}; ${cpNote(r)}`);

  // ---------- 0.4: layers ----------
  // Plate (solid), then MATTE (text) on top, then Ctrl (null) between them, so
  // the matte is not the layer directly above: that needs AE 23's setTrackMatte.
  const LC = LAYERS_COMP;
  r = await call("ae_create_layer", { comp_id: LC, type: "solid", name: "Plate", color: [0.2, 0.4, 0.8], expect });
  check("ae_create_layer (solid)", r.applied && r.receipt?.matches === true && r.layer?.kind === "solid" && r.checkpoint?.status === want("reused"), cpNote(r));
  r = await call("ae_create_layer", { comp_id: LC, type: "text", text: "MATTE", expect });
  check("ae_create_layer (text)", r.applied && r.receipt?.matches === true && r.layer?.text === "MATTE" && r.layer?.index === 1, `${r.layer?.name} #${r.layer?.index}`);
  r = await call("ae_create_layer", { comp_id: LC, type: "null", name: "Ctrl", placement: { below: { name: "MATTE" } }, expect });
  check("ae_create_layer (null, placed)", r.applied && r.receipt?.matches === true && r.layer?.index === 2, `#${r.layer?.index}`);
  r = await call("ae_create_layer", { comp_id: LC, type: "light", name: "Key", light_type: "spot", parent: { name: "Ctrl" }, placement: { bottom: true }, expect });
  check("ae_create_layer (light, parented)", r.applied && r.receipt?.matches === true && r.layer?.lightType === "spot" && r.layer?.parent === 2, `#${r.layer?.index}, parent ${r.layer?.parent}`);
  r = await call("ae_set_track_matte", { comp_id: LC, layer: { name: "Plate" }, matte: { name: "MATTE" }, type: "alpha", expect });
  check(
    "ae_set_track_matte",
    r.applied && r.receipt?.matches === true && r.layer?.trackMatte?.type === "alpha" && r.layer?.trackMatte?.layer?.name === "MATTE",
    `api ${r.api}; ${(r.receipt?.mismatches ?? []).map((m) => m.message).join("; ")}`
  );
  r = await call("ae_set_track_matte", { comp_id: LC, layer: { name: "Plate" }, type: "none", show_matte: true, expect });
  check("ae_set_track_matte (remove)", r.applied && r.receipt?.matches === true && r.layer?.trackMatte?.type === "none", `previous ${r.previous_matte?.name}`);
  r = await call("ae_precompose", { comp_id: LC, layers: [{ name: "MATTE" }, { name: "Plate" }], name: "Smoke Precomp", expect });
  check(
    "ae_precompose",
    r.applied && r.receipt?.matches === true && r.new_comp?.layers?.length === 2 && r.precomp_layer?.index === 1,
    `${r.new_comp?.name}: ${(r.new_comp?.layers ?? []).map((l) => l.name).join(", ")}`
  );

  // ---------- 0.4: markers and cue keys ----------
  r = await call("ae_add_markers", { comp_id: LC, markers: [{ time: 0.5, comment: "one" }, { time: 1, comment: "two", label: 3 }], expect });
  check("ae_add_markers", r.applied && r.receipt?.matches === true && r.added === 2 && r.checkpoint?.status === want("reused"), `${r.numMarkers} markers`);
  r = await call("ae_add_markers", {
    comp_id: LC,
    layer: { name: "Ctrl" },
    transcript: { text: "1\n00:00:00,500 --> 00:00:01,000\nANNA: Hello.\n\n2\n00:00:01,200 --> 00:00:02,000\nBEN: Hi there.\n" },
    expect,
  });
  check("ae_add_markers (transcript)", r.applied && r.receipt?.matches === true && r.added === 2 && r.relative_to === "layer", `${r.numMarkers} on Ctrl`);
  r = await call("ae_get_markers", { comp_id: LC });
  check("ae_get_markers", r.numMarkers === 2 && r.markers?.[1]?.comment === "two" && r.markers?.[1]?.label === 3, JSON.stringify(r.markers?.map((m) => [m.time, m.comment])));
  r = await call("ae_remove_markers", { comp_id: LC, comment_contains: "one", expect });
  check("ae_remove_markers", r.applied && r.receipt?.matches === true && r.removed?.length === 1 && r.numMarkers === 1, `${r.numMarkers} left`);
  r = await call("ae_cue_keys", { comp_id: LC, layer: { name: "Ctrl" }, path: ["ADBE Transform Group", "ADBE Scale"], times: [0.5, 1, 1.5, 2], peak: [120, 120], expect });
  check("ae_cue_keys", r.applied && r.receipt?.matches === true && r.keys_set >= 8, `${r.keys_set} keys, base ${JSON.stringify(r.base)}; ${(r.receipt?.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; ")}`);

  // ---------- 0.4: keyframes, roving, rest bounds ----------
  const SCALE = ["ADBE Transform Group", "ADBE Scale"];
  const POS = ["ADBE Transform Group", "ADBE Position"];
  r = await call("ae_get_keyframes", { comp_id: LC, layer: { name: "Ctrl" }, path: SCALE });
  check("ae_get_keyframes", r.numKeys >= 8 && r.keys?.[1]?.in?.name === "easy ease", `${r.numKeys} keys; key 2 in: ${r.keys?.[1]?.in?.name}`);
  r = await call("ae_remove_keyframes", { comp_id: LC, layer: { name: "Ctrl" }, path: SCALE, start: 1.4, expect });
  check("ae_remove_keyframes (range)", r.applied && r.receipt?.matches === true && r.removed?.length >= 3, `${r.removed?.length} removed, ${r.numKeys} left`);
  r = await call("ae_remove_keyframes", { comp_id: LC, layer: { name: "Ctrl" }, path: SCALE, all: true, static_value_at: 0, expect });
  check("ae_remove_keyframes (all)", r.applied && r.receipt?.matches === true && r.numKeys === 0, `kept ${JSON.stringify(r.static_value)}`);

  // A linear move through a middle key: the review's fix eases the ends and roves the middle.
  await call("ae_create_layer", { comp_id: LC, type: "solid", name: "Mover", color: [1, 0.5, 0], width: 80, height: 80, expect });
  await call("ae_set_property", {
    comp_id: LC,
    layer: { name: "Mover" },
    path: POS,
    keyframes: [
      { time: 0, value: [100, 180], interp: "linear" },
      { time: 1, value: [320, 180], interp: "linear" },
      { time: 2, value: [540, 180], interp: "linear" },
    ],
    expect,
  });
  r = await call("ae_motion_review", { comp_id: LC });
  const moverLinear = (r.findings ?? []).find((f) => f.kind === "linear" && f.layer?.name === "Mover");
  check("ae_motion_review (roving fix)", moverLinear?.fix?.args?.rove_between === true, String(moverLinear?.message ?? JSON.stringify(r.by_kind)));
  if (moverLinear?.fix) {
    r = await call("ae_set_keyframe_ease", moverLinear.fix.args);
    check("ae_set_keyframe_ease (rove_between)", r.applied && r.receipt?.matches === true && JSON.stringify(r.result?.roving) === "[2]", `roving ${JSON.stringify(r.result?.roving)}`);
  }
  r = await call("ae_motion_review", { comp_id: LC });
  const moverLeft = (r.findings ?? []).filter((f) => f.layer?.name === "Mover" && f.severity === "medium");
  check("ae_motion_review (after roving)", r.ok && moverLeft.length === 0, `${moverLeft.length} medium on Mover`);

  // A box that comes to rest half past the right edge.
  await call("ae_create_layer", { comp_id: LC, type: "solid", name: "Edge", color: [0.2, 1, 0.4], width: 100, height: 100, expect });
  await call("ae_set_property", { comp_id: LC, layer: { name: "Edge" }, path: POS, keyframes: [{ time: 0, value: [320, 300] }, { time: 1, value: [640, 300] }], expect });
  r = await call("ae_motion_review", { comp_id: LC });
  const edgeCut = (r.findings ?? []).find((f) => f.kind === "cut_off" && f.layer?.name === "Edge");
  check("ae_motion_review (rest bounds)", Boolean(edgeCut) && edgeCut.suggested_shift?.[0] < 0, String(edgeCut?.message ?? JSON.stringify(r.bounds_unchecked ?? r.by_kind)));

  // ---------- 0.4: reads ----------
  r = await call("ae_comp_tree", {});
  const layersNode = (r.comps ?? []).find((c) => c.name === "Layers");
  check("ae_comp_tree", layersNode?.contains === 1 && (r.unused ?? []).some((c) => c.name === "Skill target"), `${r.num_comps} comps, unused ${(r.unused ?? []).map((c) => c.name).join(", ")}`);
  r = await call("ae_comp_tree", { comp_id: LC });
  check("ae_comp_tree (one comp)", r.contains?.[0]?.name === "Smoke Precomp", JSON.stringify(r.contains?.map((n) => n.name)));
  r = await call("ae_fonts", {});
  check("ae_fonts", r.text_layers >= 2 && r.fonts?.length >= 1 && typeof r.missing_known === "boolean", `${(r.fonts ?? []).map((f) => `${f.font}${f.missing ? " (missing)" : ""}`).join(", ")}`);
  r = await call("ae_get_project", { type: "comp", sort: "name", limit: 2 });
  check("ae_get_project (paged)", r.items?.length === 2 && r.total >= 5 && r.next_offset === 2, `${r.total} comps; ${(r.items ?? []).map((i) => i.name).join(", ")}`);
  r = await call("ae_get_comp", { comp_id: LC, limit: 1 });
  check("ae_get_comp (paged)", r.layers?.length === 1 && r.next_offset === 1, `${r.numLayers} layers, next ${r.next_offset}`);

  // ---------- 0.4: shapes, Essential Graphics, templates, versions, batch ----------
  await call("ae_create_layer", { comp_id: LC, type: "shape", name: "Art", expect });
  r = await call("ae_shape", {
    comp_id: LC,
    layer: { name: "Art" },
    add: [
      { type: "rect", name: "Card", size: [200, 120], roundness: 12, fill: { color: [0, 0.5, 1] }, stroke: { color: [1, 1, 1], width: 4 } },
      { type: "polygon", name: "Hex", points: 6, outer_radius: 60, fill: { color: [1, 0.8, 0] } },
    ],
    expect,
  });
  check("ae_shape", r.applied && r.receipt?.matches === true && r.contents?.length === 2, `${(r.contents ?? []).map((c) => `${c.name}: ${(c.items ?? []).map((i) => i.kind).join("+")}`).join("; ")}`);

  r = await call("ae_render_templates", {});
  check("ae_render_templates", r.render_settings?.length > 0 && r.output_modules?.length > 0 && typeof r.audio_template_found === "boolean", `${r.source}; AIFF 48kHz ${r.audio_template_found ? "found" : "missing"}`);
  const audioTemplate = r.audio_template_found === true; // ae_loudness_check on a comp renders audio with it

  // The precomp made earlier from MATTE and Plate becomes a template; its layer in Layers gets an override.
  const PRE = (await call("ae_get_project", { type: "comp", name_contains: "Smoke Precomp" })).items?.[0]?.id;
  r = await call("ae_set_essential_graphics", { comp_id: PRE, action: "add", layer: { name: "MATTE" }, path: ["ADBE Transform Group", "ADBE Opacity"], name: "Matte opacity", expect });
  check("ae_set_essential_graphics (add)", r.applied && r.receipt?.matches === true, `${r.essential_graphics?.controllers?.length} controllers`);
  r = await call("ae_set_essential_graphics", { comp_id: PRE, action: "template_name", name: "Smoke Template", expect });
  check("ae_set_essential_graphics (name)", r.applied && r.receipt?.matches === true, String(r.essential_graphics?.template_name));
  r = await call("ae_set_essential_graphics", { comp_id: LC, action: "set_override", layer: { name: "Smoke Precomp" }, name: "Matte opacity", value: 50, expect });
  check("ae_set_essential_graphics (override)", r.applied && r.receipt?.matches === true, JSON.stringify(r.essential_graphics?.overrides));
  r = await call("ae_get_essential_graphics", { comp_id: LC, layer: { name: "Smoke Precomp" } });
  check("ae_get_essential_graphics", r.overrides?.[0]?.value === 50, JSON.stringify(r.overrides));

  r = await call("ae_batch_set", {
    comp_id: LC,
    ops: [
      { layer: { name: "Mover" }, path: ["ADBE Transform Group", "ADBE Opacity"], value: 60 },
      { layer: { name: "Edge" }, path: ["ADBE Transform Group", "ADBE Opacity"], expression: "50 + 50 * Math.sin(time * 4)" },
      { layer: { name: "Art" }, path: ["ADBE Transform Group", "ADBE Rotate Z"], keyframes: [{ time: 0, value: 0 }, { time: 2, value: 90 }] },
    ],
    expect,
  });
  check("ae_batch_set", r.ok && r.done === 3 && r.matches === true, `${r.chunks?.length} chunk(s); ${(r.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; ")}`);

  // A still with two versions on disk: import v001, then version up.
  fs.writeFileSync(path.join(MEDIA, "tile_v001.png"), Buffer.from(RED_PNG, "base64"));
  fs.writeFileSync(path.join(MEDIA, "tile_v002.png"), Buffer.from(BLUE_PNG, "base64"));
  const tile = await call("ae_import_footage", { paths: [path.join(MEDIA, "tile_v001.png")], expect });
  const tileId = tile.item_ids?.[0];
  r = await call("ae_version_footage", { item_ids: [tileId] });
  check("ae_version_footage (report)", r.outdated === 1 && r.items?.[0]?.latest === 2, `item ${tileId}: v${r.items?.[0]?.current} -> v${r.items?.[0]?.latest}`);
  r = await call("ae_version_footage", { item_ids: [tileId], update: true, expect });
  check("ae_version_footage (update)", r.applied && r.receipt?.matches === true && Boolean(r.log_path), `${path.basename(String(r.items?.[0]?.target))}, log ${path.basename(String(r.log_path))}`);

  // ---------- 0.4: masks, text animators, layout, purge, house style ----------
  r = await call("ae_mask", { comp_id: LC, layer: { name: "Mover" }, add: [{ name: "Round", shape: "ellipse", box: [0, 0, 80, 80], feather: [6, 6] }], expect });
  check("ae_mask (add)", r.applied && r.receipt?.matches === true && r.masks?.[0]?.vertices === 4, JSON.stringify(r.masks?.[0]?.box));
  r = await call("ae_mask", { comp_id: LC, layer: { name: "Mover" }, set: [{ mask: { name: "Round" }, mode: "subtract", inverted: true }], expect });
  check("ae_mask (set)", r.applied && r.receipt?.matches === true && r.masks?.[0]?.mode === "subtract", `${r.masks?.[0]?.mode}, inverted ${r.masks?.[0]?.inverted}`);

  await call("ae_create_layer", { comp_id: LC, type: "text", text: "Reveal me", name: "Reveal", expect });
  r = await call("ae_text_animator", {
    comp_id: LC,
    layer: { name: "Reveal" },
    properties: { opacity: 0, position: [0, 30, 0] },
    selector: { based_on: "characters", shape: "ramp_up" },
    reveal: { from: 0, to: 100, start_time: 0, duration: 1.5 },
    expect,
  });
  check("ae_text_animator", r.applied && r.receipt?.matches === true, `${(r.animator?.properties ?? []).map((p) => p.matchName).join(", ")}; ${(r.receipt?.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; ")}`);

  for (const n of ["Box1", "Box2", "Box3"]) await call("ae_create_layer", { comp_id: LC, type: "solid", name: n, width: 40, height: 40, color: [0.9, 0.9, 0.9], expect });
  await call("ae_batch_set", {
    comp_id: LC,
    ops: [80, 200, 520].map((x, i) => ({ layer: { name: `Box${i + 1}` }, path: ["ADBE Transform Group", "ADBE Position"], value: [x, 260] })),
    expect,
  });
  r = await call("ae_align", { comp_id: LC, layers: [{ name: "Box1" }, { name: "Box2" }, { name: "Box3" }], distribute: "horizontal", expect });
  check("ae_align (distribute)", r.applied && r.receipt?.matches === true, (r.moved ?? []).map((m) => `${m.name} ${Math.round(m.delta?.[0])}`).join(", "));
  r = await call("ae_align", { comp_id: LC, layers: [{ name: "Box1" }, { name: "Box2" }, { name: "Box3" }], align: "top", to: "title_safe", expect });
  check("ae_align (top, title safe)", r.applied && r.receipt?.matches === true && Math.abs((r.layers?.[0]?.rect?.[1] ?? 0) - 36) < 0.6, JSON.stringify(r.layers?.map((l) => l.rect?.map((v) => Math.round(v)))));

  r = await call("ae_purge_unused", {});
  const purgeable = r.count;
  check("ae_purge_unused (list)", r.dry_run === true && purgeable >= 1, (r.items ?? []).map((i) => `${i.name} (${i.kind})`).join(", "));
  r = await call("ae_purge_unused", { kinds: ["footage"], apply: true, expect });
  check("ae_purge_unused (apply)", r.applied && r.receipt?.matches === true && (r.removed ?? []).length >= 1, `${(r.removed ?? []).length} removed`);

  r = await call("ae_house_style_check", { comp_id: LC, brand_colors: ["#3399ff", "#ffcc00"], fonts: ["Arial"], min_font_size: 10 });
  check("ae_house_style_check", r.ok && Array.isArray(r.findings) && r.checked?.text >= 1, `${r.counts?.medium} medium, ${r.counts?.low} low: ${[...new Set((r.findings ?? []).map((f) => f.kind))].join(", ")}`);

  // ======================================================================
  // Waves 1-3 (149 tools in all, 69 of them new). NONE of these steps has run in a live After Effects yet;
  // the arguments and checks come from the tools' zod schemas and results. Expect to adjust some on the first run.
  // Each group works in a scratch comp of its own, so the Smoke, Layers and Audio comps keep what the later checks read.
  // ======================================================================
  const wave = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: waves 1-3 scene",
    expect,
    code: [
      "function mk(n, w, h, d) { return app.project.items.addComp(n, w, h, 1, d, 25); }",
      "var ids = {};",
      // Work: four solids for the stagger, rig, fit text and path tools (8 s so captions-style timing fits).
      'var wk = mk("Wave Work", 640, 360, 8); ids.work = wk.id;',
      'for (var i = 1; i <= 4; i++) { var s = wk.layers.addSolid([0.2 * i, 0.5, 0.9 - 0.2 * i], "Row" + i, 60, 60, 1); s.property("ADBE Transform Group").property("ADBE Position").setValue([100 * i, 200]); }',
      'var cp = mk("Wave Captions", 640, 360, 8); ids.caps = cp.id;',
      // A 4 s comp used as a precomp layer "Clip": the time remap tools need a layer with a source length.
      'var rs = mk("Wave Remap Src", 320, 180, 4); rs.layers.addSolid([0.9, 0.4, 0.1], "Src", 320, 180, 1); ids.remap_src = rs.id;',
      'var rm = mk("Wave Remap", 640, 360, 8); var clip = rm.layers.add(rs); clip.name = "Clip"; ids.remap = rm.id;',
      'var cm = mk("Wave Cam", 640, 360, 4); cm.layers.addSolid([0.2, 0.4, 0.8], "CamPlate", 640, 360, 1); ids.cam = cm.id;',
      // Two text layers that overlap, on a dark plate.
      'var lg = mk("Wave Legibility", 640, 360, 4); ids.leg = lg.id;',
      'lg.layers.addSolid([0.1, 0.1, 0.12], "Leg BG", 640, 360, 1);',
      'var la = lg.layers.addText("Legibility check"); la.name = "Leg A";',
      'var lb = lg.layers.addText("Overlap"); lb.name = "Leg B";',
      'la.property("ADBE Transform Group").property("ADBE Position").setValue([320, 170]);',
      'lb.property("ADBE Transform Group").property("ADBE Position").setValue([330, 180]);',
      'var vc = mk("Wave Variants", 640, 360, 4); ids.vars = vc.id;',
      'var v1 = vc.layers.addSolid([1, 0.6, 0.1], "V1", 80, 80, 1); var v2 = vc.layers.addSolid([0.1, 0.6, 1], "V2", 80, 80, 1);',
      'v1.property("ADBE Transform Group").property("ADBE Position").setValue([200, 180]);',
      'v2.property("ADBE Transform Group").property("ADBE Position").setValue([440, 180]);',
      'var ma = mk("MC A", 320, 180, 2); ma.layers.addSolid([1, 1, 1], "Mover", 40, 40, 1); ids.mca = ma.id;',
      'var mb = mk("MC B", 320, 180, 2); mb.layers.addSolid([1, 1, 1], "Mover", 40, 40, 1); ids.mcb = mb.id;',
      // Layer ops: four plain solids and one locked one on top.
      'var po = mk("Wave Ops", 640, 360, 4); ids.ops = po.id;',
      'for (var j = 1; j <= 4; j++) po.layers.addSolid([0.5, 0.5, 0.5], "Op" + j, 80, 80, 1);',
      'var lk = po.layers.addSolid([0.9, 0.2, 0.2], "Op Lock", 80, 80, 1); lk.locked = true;',
      "return ids;",
    ].join("\n"),
  });
  const W = wave.result ?? {};
  if (typeof W.work !== "number") throw new Error("Could not build the waves 1-3 scene: " + brief(wave));
  const TR = "ADBE Transform Group";
  const ROT = [TR, "ADBE Rotate Z"];
  let ramPurgeAvailable = null; // from ae_memory_status: PurgeTarget.ALL_MEMORY_CACHES needs AE 24.3+

  // ---------- wave 1: session ----------
  r = await call("ae_session_changes", { rebase: true });
  if (r.tracking_enabled === false) skip("ae_session_changes (rebase)", "session tracking is off on this server (tracking_enabled is false)");
  else check("ae_session_changes (rebase)", r.rebased === true && !r.__isError, `baseline ${r.baseline ? "taken" : "none (session tracking off?)"}`);

  // ---------- wave 1: ae_comp_settings, ae_get_comp_settings ----------
  {
    const cs0 = await call("ae_get_comp_settings", { comp_id: W.work });
    const g0 = cs0.guide_count;
    check("ae_get_comp_settings", typeof g0 === "number" && cs0.comp_id === W.work && cs0.width === 640, `${g0} guide(s), motion blur ${cs0.motion_blur}, unreadable ${(cs0.unreadable ?? []).join(",") || "none"}`);
    r = await call("ae_comp_settings", {
      comp_id: W.work,
      expect,
      settings: { motion_blur: !cs0.motion_blur, shutter_angle: 180, motion_blur_samples: 16, motion_blur_adaptive_limit: 128, work_area: { start: 0, duration: Math.min(1, cs0.duration ?? 1) } },
      guides: [
        { action: "add", orientation: "vertical", position: 400 },
        { action: "add", orientation: "horizontal", position: 300 },
        { action: "set", index: g0, position: 420 },
        { action: "remove", index: g0 + 1 },
      ],
    });
    check("ae_comp_settings", okWrite(r), why(r));
    r = await call("ae_get_comp_settings", { comp_id: W.work, match: { width: 640, height: 360, fps: 25 } });
    check("ae_get_comp_settings (guides, brief match)", r.guide_count === g0 + 1 && r.match?.ok === true, `${r.guide_count} guide(s); differences ${JSON.stringify(r.match?.differences)}`);
    // Put the switches and the work area back, remove the guide that is left.
    r = await call("ae_comp_settings", {
      comp_id: W.work,
      expect,
      settings: {
        motion_blur: cs0.motion_blur,
        shutter_angle: cs0.shutter_angle,
        motion_blur_samples: cs0.motion_blur_samples,
        motion_blur_adaptive_limit: cs0.motion_blur_adaptive_limit,
        work_area: cs0.work_area,
      },
      guides: [{ action: "remove", index: g0 }],
    });
    check("ae_comp_settings (restore)", okWrite(r), why(r));
  }

  // ---------- wave 1: ae_multi_comp_apply (two small comps; Smoke itself is not touched) ----------
  {
    const op = { tool: "ae_set_property", args: { layer: { name: "Mover" }, path: [TR, "ADBE Opacity"], value: 50 } };
    r = await call("ae_multi_comp_apply", { op, name_pattern: "^MC (A|B)$", dry_run: true, expect });
    check("ae_multi_comp_apply (dry run)", r.ok && r.dry_run === true && r.would_run === 2 && r.would_fail === 0, brief(r));
    r = await call("ae_multi_comp_apply", { op, name_pattern: "^MC (A|B)$", fingerprints: true, pause_ms: 100, expect });
    check("ae_multi_comp_apply (run)", r.ok && r.state === "done" && r.summary?.ok === 2, brief(r.summary));
    check("ae_multi_comp_apply (undo note)", /step/.test(r.undo_note ?? ""), String(r.undo_note ?? "no undo_note").slice(0, 100));
    const job = r.job_id;
    r = await call("ae_multi_comp_apply", { resume_job_id: job, expect });
    check("ae_multi_comp_apply (resume a done job)", r.state === "done" && r.summary?.pending === 0, brief(r.summary));
    r = await call("ae_multi_comp_apply", { op: { tool: "ae_set_property", args: { layer: { name: "No Such Layer" }, path: [TR, "ADBE Opacity"], value: 10 } }, name_pattern: "^MC (A|B)$", expect });
    check("ae_multi_comp_apply (missing layer is skipped)", r.summary?.skipped === 2 && r.summary?.failed === 0, brief(r.summary));
    r = await call("ae_multi_comp_apply", { op: { tool: "ae_set_property", args: { layer: { index: 1 }, path: [TR, "ADBE Opacity"], value: 10 } }, name_pattern: "^MC (A|B)$", expect });
    check("ae_multi_comp_apply (index selector refused for 2 comps)", refused(r), why(r).slice(0, 120));
  }

  // ---------- wave 1: ae_layer_ops (Wave Ops comp: Op Lock on top, then Op4..Op1) ----------
  {
    const ops = (args) => call("ae_layer_ops", { comp_id: W.ops, expect, ...args });
    const ops4 = [{ name: "Op1" }, { name: "Op2" }, { name: "Op3" }, { name: "Op4" }];
    r = await ops({ action: "reorder", layers: [{ name: "Op1" }], move_to: "beginning", dry_run: true });
    check("ae_layer_ops (dry run)", r.dry_run === true && !r.__isError, brief(r.stack ?? r));
    r = await ops({ action: "parent", layers: [{ name: "Op2" }], parent: { name: "Op1" } });
    check("ae_layer_ops (parent)", okWrite(r) && typeof r.parent_id === "number", why(r));
    r = await ops({ action: "parent", layers: [{ name: "Op2" }], unparent: true });
    check("ae_layer_ops (unparent)", okWrite(r), why(r));
    r = await ops({ action: "reorder", layers: [{ name: "Op1" }], move_to: "beginning" });
    check("ae_layer_ops (reorder)", okWrite(r), why(r));
    r = await ops({ action: "sort", layers: ops4, sort_by: "name" });
    check("ae_layer_ops (sort)", okWrite(r), why(r));
    r = await ops({ action: "trim", layers: [{ name: "Op3" }], start_time: 0.5, in_point: 0.75, out_point: 2.5 });
    check("ae_layer_ops (trim: start, in and out)", okWrite(r), why(r));
    r = await ops({ action: "switches", layers: [{ name: "Op2" }, { name: "Op3" }], shy: true, label_color: 5, blend_mode: "screen" });
    check("ae_layer_ops (switches)", okWrite(r), why(r));
    r = await ops({ action: "rename", layers: [{ name: "Op1" }], find: "Op1", replace: "First" });
    check("ae_layer_ops (rename)", okWrite(r) && r.renames?.length === 1, why(r));
    r = await ops({ action: "delete", layers: [{ name: "Op Lock" }] });
    check("ae_layer_ops (delete of a locked layer is refused)", refused(r), why(r).slice(0, 120));
    r = await ops({ action: "delete", layers: [{ name: "Op Lock" }], unlock_locked: true });
    check("ae_layer_ops (delete, unlock_locked)", okWrite(r) && r.deleted_total === 1 && Array.isArray(r.unlocked), why(r));
    // Into another comp first (so "Op4" is still one name), then in place.
    r = await ops({ action: "duplicate", layers: [{ name: "Op4" }], to_comp_id: W.mcb });
    check("ae_layer_ops (duplicate into another comp)", okWrite(r), why(r));
    r = await ops({ action: "duplicate", layers: [{ name: "Op4" }], count: 2 });
    check("ae_layer_ops (duplicate in place)", okWrite(r) && r.duplicates_total === 2, why(r));
  }

  // ---------- wave 2: captions (Wave Captions, 25 fps, 8 s) ----------
  {
    const srt = "1\n00:00:00,400 --> 00:00:02,000\nHello there friends\n\n2\n00:00:03,200 --> 00:00:04,400\nSecond caption here\n";
    const words = JSON.stringify({
      words: [
        { text: "Hello", start: 0.4, end: 0.8, type: "word" },
        { text: "there", start: 0.8, end: 1.2, type: "word" },
        { text: "friends.", start: 1.2, end: 1.8, type: "word" },
        { text: "Second", start: 3.2, end: 3.6, type: "word" },
        { text: "caption", start: 3.6, end: 4.0, type: "word" },
        { text: "here", start: 4.0, end: 4.4, type: "word" },
      ],
    });
    const hl = { color: [1, 0.8, 0] };
    r = await call("ae_captions_plan", { transcript: { text: srt }, frame_rate: 25 });
    check("ae_captions_plan", r.count === 2 && r.estimated_word_times === true, `${r.count} captions; ${(r.warnings ?? []).length} warning(s)`);
    r = await call("ae_captions", { comp_id: W.caps, transcript: { text: words }, highlight: hl, box: {}, style: { font_size: 60 }, expect });
    check("ae_captions", okWrite(r) && r.count === 2 && r.created?.length >= 2, `${r.created?.length} layers created; outside safe ${JSON.stringify(r.outside_safe)}; ${why(r)}`);
    r = await call("ae_captions_read", { comp_id: W.caps });
    check("ae_captions_read", r.total_captions === 2 && r.captions?.[0]?.highlight?.present === true, `${r.total_captions} captions`);
    check("ae_captions_read (box expressions)", (r.boxes ?? []).every((b) => (b.expression_errors ?? []).length === 0), `${(r.boxes ?? []).length} box(es)`);
    r = await call("ae_captions", { comp_id: W.caps, transcript: { text: words, to_s: 3 }, highlight: hl, box: {}, style: { font_size: 60 }, expect });
    check("ae_captions (re-run updates by name, drops the stale one)", okWrite(r) && (r.updated ?? []).includes("Caption 001") && (r.removed ?? []).includes("Caption 002"), `updated ${JSON.stringify(r.updated)}, removed ${JSON.stringify(r.removed)}; ${why(r)}`);
    r = await call("ae_captions", { comp_id: W.caps, name_prefix: "Hold", mode: "single", transcript: { text: words }, highlight: { color: [0, 1, 1] }, expect });
    check("ae_captions (single layer, hold keys)", okWrite(r), why(r));
    r = await call("ae_captions_read", { comp_id: W.caps, mode: "single", name_prefix: "Hold" });
    check("ae_captions_read (single)", r.captions?.length === 1, `${r.captions?.[0]?.numKeys} Source Text keys`);
    // A continuation chunk: number 3 on, remove_stale must not touch 1 and 2.
    r = await call("ae_captions", { comp_id: W.caps, first_number: 3, remove_stale: true, transcript: { text: "1\n00:00:05,000 --> 00:00:06,000\nChunk three\n" }, expect });
    check("ae_captions (continuation from number 3)", okWrite(r) && (r.removed ?? []).length === 0, `created ${JSON.stringify(r.created)}; ${why(r)}`);
    r = await call("ae_captions_read", { comp_id: W.caps, from_number: 3, to_number: 3 });
    check("ae_captions_read (from_number, to_number)", r.captions?.length === 1, `${r.captions?.length} caption(s)`);
  }

  // ---------- wave 2: fit text (Wave Work) ----------
  {
    r = await call("ae_create_layer", { comp_id: W.work, type: "text", name: "FitTitle", text: "A VERY LONG TITLE THAT WILL NOT FIT THE BOX", expect });
    check("ae_create_layer (text for fitting)", okWrite(r), why(r));
    const fitLayer = [{ name: "FitTitle" }];
    r = await call("ae_measure_text", { comp_id: W.work, layers: fitLayer, max_width: 300 });
    check("ae_measure_text (overflow)", r.layers?.[0]?.fits === false && r.layers?.[0]?.bounds?.width > 300, `width ${r.layers?.[0]?.bounds?.width}, size ${r.layers?.[0]?.fontSize}`);
    r = await call("ae_fit_text", { comp_id: W.work, layers: fitLayer, max_width: 300, dry_run: true, expect });
    check("ae_fit_text (dry run)", r.dry_run === true && r.layers?.[0]?.plan?.status === "resize", JSON.stringify(r.layers?.[0]?.plan));
    r = await call("ae_fit_text", { comp_id: W.work, layers: fitLayer, max_width: 300, expect });
    check("ae_fit_text (size)", r.ok && r.applied === true && r.all_fit === true && r.receipt?.matches !== false, `${r.passes?.length} pass(es); ${JSON.stringify((r.layers ?? []).map((l) => [l.status, l.from_size, l.to_size]))}`);
    r = await call("ae_measure_text", { comp_id: W.work, layers: fitLayer, max_width: 300 });
    check("ae_measure_text (fits now)", r.layers?.[0]?.fits === true, `width ${r.layers?.[0]?.bounds?.width}`);
    r = await call("ae_fit_text", { comp_id: W.work, layers: fitLayer, mode: "live", max_width: 200, dry_run: true, expect });
    check("ae_fit_text (live, dry run)", r.dry_run === true && Array.isArray(r.would), JSON.stringify(r.would));
    r = await call("ae_fit_text", { comp_id: W.work, layers: fitLayer, mode: "live", max_width: 200, expect });
    check("ae_fit_text (live expression)", okWrite(r), why(r));
    r = await call("ae_fit_text", { comp_id: W.work, layers: fitLayer, mode: "unlive", expect });
    check("ae_fit_text (unlive)", okWrite(r), why(r));
    r = await call("ae_text_backdrop", { comp_id: W.work, layer: fitLayer[0], padding: [20, 10], expect });
    check("ae_text_backdrop", okWrite(r), `${r.backdrop?.kind ?? "no backdrop"}; ${why(r)}`);
    r = await call("ae_set_text", { comp_id: W.work, layer: fitLayer[0], ranges: [{ match: "LONG", style: { fauxBold: true, fillColor: [1, 0, 0] } }], expect });
    check("ae_set_text (ranges)", okWrite(r), why(r));
  }

  // ---------- wave 2: stagger (Row1 to Row3 in Wave Work) ----------
  {
    const rows = [{ name: "Row1" }, { name: "Row2" }, { name: "Row3" }];
    const OP = [TR, "ADBE Opacity"];
    r = await call("ae_batch_set", {
      comp_id: W.work,
      ops: rows.map((l) => ({ layer: l, path: OP, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] })),
      expect,
    });
    check("ae_batch_set (opacity keys for the stagger)", r.ok && r.done === 3, `${r.done} done`);
    r = await call("ae_stagger", { comp_id: W.work, layers: rows, step: 0.2, order: "center_out", dry_run: true, expect });
    check("ae_stagger (dry run)", r.dry_run === true && r.layers?.length === 3, `${r.layers?.length} layer(s) planned`);
    r = await call("ae_stagger", { comp_id: W.work, layers: rows, step: 0.2, order: "stack", expect });
    check("ae_stagger (layers)", okWrite(r), why(r));
    const keysArgs = { comp_id: W.work, mode: "keys", layers: rows, property_path: OP, total: 0.6, order: "random", seed: 7, expect };
    const planA = await call("ae_stagger", { ...keysArgs, dry_run: true });
    const planB = await call("ae_stagger", { ...keysArgs, dry_run: true });
    check("ae_stagger (same seed, same plan)", JSON.stringify(planA.layers?.map((l) => l.offset)) === JSON.stringify(planB.layers?.map((l) => l.offset)) && planA.layers?.length === 3, JSON.stringify(planA.layers?.map((l) => l.offset)));
    r = await call("ae_stagger", keysArgs);
    check("ae_stagger (keys)", okWrite(r) && JSON.stringify(r.layers?.map((l) => l.offset)) === JSON.stringify(planA.layers?.map((l) => l.offset)), why(r));
    r = await call("ae_stagger", { comp_id: W.work, mode: "copy_keys", source: rows[0], layers: [rows[1], rows[2]], property_path: OP, step: 0.25, replace_existing: true, expect });
    check("ae_stagger (copy_keys)", okWrite(r), why(r));
    r = await call("ae_stagger_layout", { comp_id: W.work, pattern: "grid", layers: rows, columns: 2, spacing: [120, 90], expect });
    check("ae_stagger_layout (grid)", okWrite(r), why(r));
    r = await call("ae_stagger_layout", { comp_id: W.work, pattern: "radial", layers: rows, radius: 100, origin: [320, 180], expect });
    check("ae_stagger_layout (radial)", okWrite(r), why(r));
  }

  // ---------- wave 2: rig (Rig Controls null, Row4) ----------
  {
    const holder = { name: "Rig Controls" };
    r = await call("ae_rig_add_controls", {
      comp_id: W.work,
      layer: holder,
      create_if_missing: true,
      controls: [
        { name: "Speed", kind: "slider", value: 50 },
        { name: "Spin", kind: "angle", value: 90 },
        { name: "Show", kind: "checkbox", value: true },
        { name: "Tint", kind: "color", value: [0, 0.5, 1] },
        { name: "Center", kind: "point", value: [100, 100] },
        { name: "Mode", kind: "dropdown", items: ["A", "B", "C"], value: 2 },
      ],
      expect,
    });
    check("ae_rig_add_controls", okWrite(r), why(r));
    r = await call("ae_rig_add_controls", { comp_id: W.work, layer: holder, controls: [{ name: "Target", kind: "layer", layer: { name: "Row1" } }, { name: "Many", kind: "dropdown", items: Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`) }], expect });
    check("ae_rig_add_controls (layer control, 20 dropdown items)", okWrite(r), why(r));
    r = await call("ae_rig_add_controls", { comp_id: W.work, layer: holder, controls: [{ name: "Big", kind: "slider", value: 5e6 }], expect });
    check("ae_rig_add_controls (slider over 1e6 refused)", refused(r), why(r).slice(0, 120));
    r = await call("ae_rig_list", { comp_id: W.work });
    check("ae_rig_list", Array.isArray(r.controls) && r.controls.length >= 8, `${r.controls?.length} controls`);
    r = await call("ae_rig_link", { comp_id: W.work, links: [{ layer: { name: "Row4" }, path: ROT, control: { name: "Spin", layer: holder } }], replace: true, expect });
    check("ae_rig_link", okWrite(r), why(r));
    r = await call("ae_rig_rename", { comp_id: W.work, layer: holder, control: "Spin", new_name: "Twist", expect });
    check("ae_rig_rename", okWrite(r), why(r));
    r = await call("ae_expr_recipes", { recipe: "wiggle" });
    check("ae_expr_recipes", r.recipes?.length === 1 && r.recipes[0].name === "wiggle", `${r.recipes?.[0]?.name}`);
    r = await call("ae_expr_recipe", { comp_id: W.work, layer: { name: "Row4" }, path: [TR, "ADBE Position"], recipe: "wiggle", controller: holder, replace: true, expect });
    check("ae_expr_recipe (wiggle)", okWrite(r), why(r));
    r = await call("ae_rig_unlink", { comp_id: W.work, targets: [{ layer: { name: "Row4" }, path: [TR, "ADBE Position"] }, { layer: { name: "Row4" }, path: ROT }], expect });
    check("ae_rig_unlink", okWrite(r), why(r));
  }

  // ---------- wave 2: time remap (Wave Remap: precomp layer Clip, 4 s source) ----------
  {
    const clip = { name: "Clip" };
    const tr = (args) => call("ae_time_remap", { comp_id: W.remap, layer: clip, expect, ...args });
    r = await call("ae_get_time_remap", { comp_id: W.remap, layer: clip });
    check("ae_get_time_remap", r.ok && r.eligible === true && r.remap_enabled === false, `source ${r.source?.duration}s; ${r.ineligible_reason ?? ""}`);
    r = await call("ae_get_time_remap", { comp_id: W.work, layer: { name: "Row1" } });
    check("ae_get_time_remap (a solid is not eligible)", r.eligible === false && Boolean(r.ineligible_reason), String(r.ineligible_reason));
    r = await tr({ operation: "enable" });
    check("ae_time_remap (enable)", okWrite(r) && r.after?.remap_enabled === true, `AE's own keys: ${JSON.stringify((r.keys ?? []).map((k) => [k.time, k.value]))}; ${why(r)}`);
    r = await tr({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 1, speed: 10000 }] });
    check("ae_time_remap (ramp past the source end is refused)", refused(r), why(r).slice(0, 140));
    r = await tr({ operation: "freeze", at_time: 1 });
    check("ae_time_remap (freeze)", okWrite(r), why(r));
    r = await tr({ operation: "ramp", method: "per_frame", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    check("ae_time_remap (ramp, per_frame)", okWrite(r), why(r));
    r = await tr({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    check("ae_time_remap (ramp, bezier: ease speed unit)", okWrite(r), why(r));
    r = await tr({ operation: "reverse" });
    check("ae_time_remap (reverse)", okWrite(r), why(r));
    r = await tr({ operation: "hold_last_frame" });
    check("ae_time_remap (hold_last_frame)", okWrite(r), why(r));
    r = await tr({ operation: "loop", loop_type: "cycle" });
    check("ae_time_remap (loop)", okWrite(r), why(r));
    r = await tr({ operation: "disable" });
    check("ae_time_remap (disable)", okWrite(r) && r.after?.remap_enabled === false, why(r));
    r = await tr({ operation: "speed", speed_percent: 200 });
    check("ae_time_remap (speed 200)", okWrite(r), why(r));
    r = await call("ae_get_time_remap", { comp_id: W.remap, layer: clip, sample_times: [0, 1] });
    check("ae_get_time_remap (after)", r.ok && r.stretch === 50, `stretch ${r.stretch}`);
  }

  // ---------- wave 2: camera (Wave Cam) ----------
  {
    r = await call("ae_camera_rig", {
      comp_id: W.cam,
      name: "SmokeCam",
      preset: "push_in",
      lens: { focal_length: 35 },
      motion: { amount: 600, duration: 2 },
      focus: { layer: { name: "CamPlate" }, aperture: 20 },
      spread: { layers: [{ name: "CamPlate" }], near: 300, far: 300 },
      expect,
    });
    check("ae_camera_rig (two nodes, push in, DOF, spread)", okWrite(r) && r.camera?.two_node === true, why(r));
    check("ae_camera_rig (active camera, depth of field)", r.is_active_camera === true && r.camera?.dof === true, `active ${r.is_active_camera}, dof ${r.camera?.dof}`);
    r = await call("ae_scene_3d_report", { comp_id: W.cam, time: 0 });
    check("ae_scene_3d_report", r.camera?.source === "layer" && r.camera?.name === "SmokeCam" && r.camera?.two_node === true && r.layers_by_depth?.length >= 1, `${r.counts?.three_d} 3D layer(s); ${JSON.stringify(r.warnings)}`);
    r = await call("ae_camera_rig", { comp_id: W.cam, name: "SmokeDolly", nodes: "one", preset: "dolly", expect });
    check("ae_camera_rig (one node, dolly)", okWrite(r) && r.camera?.two_node === false, why(r));
    r = await call("ae_camera_rig", { comp_id: W.cam, preset: "orbit", nodes: "one", expect });
    check("ae_camera_rig (orbit with one node is refused)", refused(r), why(r).slice(0, 120));
  }

  // ---------- wave 2: paths (shape layers PathTest and PathBake in Wave Work) ----------
  {
    const zeroes = [[0, 0], [0, 0], [0, 0], [0, 0]];
    await call("ae_create_layer", { comp_id: W.work, type: "shape", name: "PathTest", expect });
    await call("ae_shape", { comp_id: W.work, layer: { name: "PathTest" }, add: [{ type: "path", name: "Zig", vertices: [[0, 0], [100, 0], [100, 80], [0, 80]], in_tangents: zeroes, out_tangents: zeroes, closed: false, stroke: { color: [1, 1, 1], width: 4 } }], expect });
    await call("ae_create_layer", { comp_id: W.work, type: "shape", name: "PathBake", expect });
    await call("ae_shape", { comp_id: W.work, layer: { name: "PathBake" }, add: [{ type: "path", name: "Zag", vertices: [[0, 0], [50, 0], [50, 50], [0, 50]], in_tangents: zeroes, out_tangents: zeroes, closed: true, stroke: { color: [1, 1, 1], width: 4 } }], expect });
    const pTest = { layer: { name: "PathTest" }, shape: { group: { index: 1 }, path: { index: 1 } } };
    const pBake = { layer: { name: "PathBake" }, shape: { group: { index: 1 }, path: { index: 1 } } };
    r = await call("ae_path_read", { comp_id: W.work, target: pTest, include_operators: true });
    check("ae_path_read", r.path?.vertexCount === 4 && r.path?.closed === false, `${r.path?.vertexCount} vertices; ${JSON.stringify(r.operators ?? null).slice(0, 80)}`);
    // Unkeyed edits first: the keyed write comes last, because a keyed path refuses bake and the others.
    r = await call("ae_path_write", { comp_id: W.work, target: pTest, operation: "resample", resample: { count: 12 }, dry_run: true, expect });
    check("ae_path_write (dry run)", r.dry_run === true && r.vertex_count === 12, `${r.vertex_count} vertices planned`);
    r = await call("ae_path_write", { comp_id: W.work, target: pTest, operation: "resample", resample: { count: 12 }, expect });
    check("ae_path_write (resample)", okWrite(r), why(r));
    r = await call("ae_path_write", { comp_id: W.work, target: pTest, operation: "smooth", smooth: { method: "catmull_rom" }, expect });
    check("ae_path_write (smooth)", okWrite(r), why(r));
    r = await call("ae_path_write", { comp_id: W.work, target: pTest, operation: "mirror", mirror: { axis: "x" }, expect });
    check("ae_path_write (mirror)", okWrite(r), why(r));
    r = await call("ae_path_operator", { comp_id: W.work, layer: { name: "PathTest" }, group: { index: 1 }, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1 } }, expect });
    check("ae_path_operator (trim, draw-on)", okWrite(r), why(r));
    r = await call("ae_path_operator", { comp_id: W.work, layer: { name: "PathTest" }, group: { index: 1 }, operator: "repeater", repeater: { grid: { columns: 3, rows: 2, spacing: [30, 30] }, order: "above" }, expect });
    check("ae_path_operator (repeater grid)", okWrite(r), `transform children ${JSON.stringify(r.transform_children ?? null).slice(0, 80)}; ${why(r)}`);
    r = await call("ae_path_operator", { comp_id: W.work, layer: { name: "PathTest" }, group: { index: 1 }, operator: "offset", offset: { amount: 6, line_join: "round" }, expect });
    check("ae_path_operator (offset)", okWrite(r), why(r));
    // Link the unkeyed PathBake to PathTest, then unlink and bake it.
    r = await call("ae_path_link", { comp_id: W.work, target: pBake, source: pTest, expect });
    check("ae_path_link (link)", okWrite(r), why(r));
    r = await call("ae_path_link", { comp_id: W.work, target: pBake, unlink: true, bake: true, expect });
    check("ae_path_link (unlink, bake)", okWrite(r) && r.baked === true, why(r));
    r = await call("ae_path_write", { comp_id: W.work, target: pTest, operation: "reverse", time: 0, expect });
    check("ae_path_write (path key at a time)", okWrite(r) && r.numKeys === 1, `${r.numKeys} key(s); ${why(r)}`);
    r = await call("ae_path_connector", { comp_id: W.work, from: { layer: { name: "PathTest" } }, to: { layer: { name: "PathBake" } }, name: "Smoke Connector", expect });
    check("ae_path_connector", okWrite(r), why(r));
    // The keyed path cannot be baked: link it, unlink it without bake.
    r = await call("ae_path_link", { comp_id: W.work, target: pTest, source: pBake, expect });
    check("ae_path_link (onto a keyed path)", okWrite(r), why(r));
    r = await call("ae_path_link", { comp_id: W.work, target: pTest, unlink: true, expect });
    check("ae_path_link (unlink, no bake)", okWrite(r), why(r));
  }

  // ---------- wave 2: describe, explain; wave 1: annotate, preflight ----------
  {
    r = await call("ae_describe_comp", { comp_id: W.work, gantt: true, include_layers: true });
    check("ae_describe_comp", r.ok === true && r.read_only === true && typeof r.summary === "string" && r.layers?.length === Math.min(r.comp?.num_layers, 200), `${r.comp?.num_layers} layers, ${r.beats?.length} beats, ${r.throughout?.length} throughout`);
    check("ae_describe_comp (gantt, roles)", fs.existsSync(String(r.gantt?.path)) && Object.values(r.roles ?? {}).reduce((a, b) => a + b, 0) === r.layers?.length, String(r.gantt?.path ?? "no gantt").slice(-40));
    r = await call("ae_describe_comp", { comp_id: W.work, max_layers: 1 });
    check("ae_describe_comp (paging)", r.range?.to === 1 && r.range?.next_from_layer === 2, JSON.stringify(r.range));
    r = await call("ae_describe_comp", { comp_id: W.work, from_layer: 9999 });
    check("ae_describe_comp (from_layer past the end is refused)", refused(r), why(r).slice(0, 100));

    r = await call("ae_annotate_frame", { comp_id: COMP, time: 1 });
    check("ae_annotate_frame", r.ok && fs.existsSync(String(r.path)) && r.frames?.[0]?.layer_count >= 1, `${r.width}x${r.height}, ${r.frames?.[0]?.layer_count} layer(s) drawn`);
    r = await call("ae_annotate_frame", { comp_id: COMP, time: 0.5, time_b: 2, layers: "all", layer_ids: [999], outlines: true, tags: true, anchors: false });
    check("ae_annotate_frame (A/B pair, an id that is not in the comp)", r.ok && r.mode === "pair" && r.frames?.length === 2, `missing ${JSON.stringify(r.frames?.[0]?.missing_layer_ids)}`);

    // Hide a probe layer, then ask why it does not show.
    await call("ae_create_layer", { comp_id: W.work, type: "solid", name: "Explain probe", color: [1, 0, 0], expect });
    r = await call("ae_layer_ops", { action: "switches", comp_id: W.work, layers: [{ name: "Explain probe" }], enabled: false, expect });
    check("ae_layer_ops (switch a layer off)", okWrite(r), why(r));
    r = await call("ae_explain_layer", { comp_id: W.work, layer: { name: "Explain probe" }, time: 0 });
    check("ae_explain_layer", r.verdict === "hidden" && r.findings?.[0]?.id === "disabled" && r.findings[0].severity === "blocks", `${r.verdict}: ${r.headline}`);
    check("ae_explain_layer (limits stated)", Array.isArray(r.limits) && r.limits.length >= 3, `${r.limits?.length} limits`);
    r = await call("ae_explain_layer", { comp_id: W.work, point: [10, 10], time: 0 });
    check("ae_explain_layer (point)", r.verdict === "point_only" && Array.isArray(r.at_point?.candidates), `${r.at_point?.candidates?.length} candidate(s)`);
    r = await call("ae_explain_layer", { comp_id: W.remap, layer: { name: "Clip" }, time: 0, inside: true });
    check("ae_explain_layer (inside a precomp)", r.findings !== undefined && !r.__isError, `${r.verdict}`);
    r = await call("ae_explain_layer_proof", { comp_id: W.work, layer: { name: "Explain probe" }, suspect: "enabled", time: 0, expect });
    check("ae_explain_layer_proof", r.applied === true && r.receipt?.matches === true && r.proof?.copy_removed === true && ["confirmed", "not_confirmed", "inconclusive"].includes(r.verdict), `${r.verdict}; ${why(r)}`);
    r = await call("ae_explain_layer_proof", { comp_id: W.work, layer: { name: "Explain probe" }, suspect: "solo", time: 0, expect });
    check("ae_explain_layer_proof (a suspect that does not apply is refused before a checkpoint)", refused(r) && !r.checkpoint, why(r).slice(0, 120));

    r = await call("ae_preflight", { comp_ids: [W.work], force_eval: true });
    check(
      "ae_preflight (delivery, forced expressions)",
      r.ok && ["blocked", "warnings", "clear", "incomplete"].includes(r.verdict) && !(r.findings ?? []).some((f) => /not been implemented/.test(String(f.message ?? ""))),
      `${r.verdict}: ${JSON.stringify(r.counts)}`
    );
    r = await call("ae_preflight", { scope: "health" });
    check("ae_preflight (health)", r.ok && r.scope === "health" && r.health !== undefined, `${r.progress?.comps_scanned} comps scanned`);

    // Comp mode only reads: the comp and its time are not touched.
    r = await call("ae_scrub_check", { comp_id: COMP, samples: 6 });
    check("ae_scrub_check (comp)", r.ok === true && ["pass", "warn", "fail"].includes(r.verdict) && r.coverage?.sample_points >= 2 && fs.existsSync(String(r.chart?.path)), `${r.verdict}; ${r.coverage?.sample_points} pairs, ${r.findings?.length} finding(s)`);
    r = await call("ae_scrub_check", { comp_id: COMP, start: 0, end: 0.001 });
    check("ae_scrub_check (a sub-frame range is refused)", r.ok === false && r.error === "range_too_short", String(r.error));
  }

  // ---------- wave 2: footage interpretation and proxies (a still: loop and fields do not apply to it) ----------
  {
    r = await call("ae_import_footage", { paths: [path.join(MEDIA, "a.png")], expect });
    const FOOT = r.item_ids?.[0];
    check("ae_import_footage (for the interpretation steps)", r.applied && typeof FOOT === "number", `item ${FOOT}`);
    r = await call("ae_get_footage_interpretation", { item_ids: [FOOT] });
    check("ae_get_footage_interpretation", r.items?.[0]?.id === FOOT, `${r.items?.[0]?.is_still ? "still" : "not a still"}, pixel aspect ${r.items?.[0]?.pixel_aspect}`);
    r = await call("ae_set_footage_interpretation", { item_id: FOOT, pixel_aspect: 2, expect });
    check("ae_set_footage_interpretation (pixel aspect)", okWrite(r), why(r));
    r = await call("ae_set_footage_interpretation", { item_id: FOOT, pixel_aspect: 1, expect });
    check("ae_set_footage_interpretation (put back)", okWrite(r), why(r));
    r = await call("ae_set_footage_interpretation", { item_id: FOOT, loop: 2, expect });
    check("ae_set_footage_interpretation (loop on a still is refused)", refused(r), why(r).slice(0, 120));
    skip("ae_set_footage_interpretation (alpha, fields, pulldown, conform, and loop on video)", "the scratch project has stills and a WAV only: no video, no alpha channel to change");
    r = await call("ae_get_footage_interpretation", { only_findings: true });
    check("ae_get_footage_interpretation (project audit)", Array.isArray(r.items) && typeof r.warnings === "number", `${r.items?.length} item(s) with findings, ${r.warnings} warning(s)`);
    r = await call("ae_footage_proxy", { item_ids: [FOOT], action: "set_solid", solid: { color: [0.5, 0.5, 0.5], width: 480, height: 270 }, use_proxy: true, expect });
    check("ae_footage_proxy (set_solid)", okWrite(r), why(r));
    r = await call("ae_footage_proxy", { item_ids: [FOOT], action: "use_off", expect });
    check("ae_footage_proxy (use_off)", okWrite(r), why(r));
    r = await call("ae_footage_proxy", { item_ids: [FOOT], action: "clear", expect });
    check("ae_footage_proxy (clear)", okWrite(r), why(r));
  }

  // ---------- busy handling, dialogs, render pre-checks, import and layout (unreleased; first live run) ----------
  // Scratch project only: main() refuses to start on anything else. Nothing here opens a popup or starts a render.
  {
    // Many items in one undo step (two stills; pixel aspect is the one setting a still can take).
    const impDir = path.join(MEDIA, "imp");
    fs.mkdirSync(impDir, { recursive: true });
    const impOne = path.join(impDir, "imp_one.png");
    const impTwo = path.join(impDir, "imp_two.png");
    fs.writeFileSync(impOne, Buffer.from(RED_PNG, "base64"));
    fs.writeFileSync(impTwo, Buffer.from(BLUE_PNG, "base64"));
    // The importer waits for a file to age (2 s) before it counts as written.
    await sleep(2500);

    r = await call("ae_import_footage", { paths: [path.join(MEDIA, "a.png"), path.join(MEDIA, "b.png")], expect });
    const BATCH = r.item_ids ?? [];
    check("ae_import_footage (for the batch interpretation steps)", r.applied && BATCH.length === 2, `items ${BATCH.join(", ")}`);
    r = await call("ae_set_footage_interpretation", { item_ids: BATCH, pixel_aspect: 2, expect });
    check("ae_set_footage_interpretation (item_ids: two items, one undo step)", okWrite(r) && r.batch === true && r.summary?.requested === 2, `${JSON.stringify(r.summary)}; ${why(r)}`);
    r = await call("ae_set_footage_interpretation", { item_ids: BATCH, pixel_aspect: 1, overrides: [{ item_id: BATCH[1], pixel_aspect: 1 }], expect });
    check("ae_set_footage_interpretation (item_ids, put back, with an override)", okWrite(r) && r.batch === true, `${JSON.stringify(r.summary)}; ${why(r)}`);
    r = await call("ae_set_footage_interpretation", { item_ids: BATCH, loop: 2, expect });
    check("ae_set_footage_interpretation (item_ids: loop on stills refuses all, writes nothing)", refused(r) && r.error === "interpretation_rejected" && !r.checkpoint, why(r).slice(0, 120));

    // Import by paths with interpretation in the same undo step; dry run first, then write, then nothing left to import.
    r = await call("ae_import_assets", { paths: [impOne, impTwo], interpret: { pixel_aspect: 2 }, dry_run: true, expect });
    check("ae_import_assets (paths, dry run)", r.ok && r.to_import?.length === 2, `${r.to_import?.length} to import`);
    r = await call("ae_import_assets", { paths: [impOne, impTwo], interpret: { pixel_aspect: 2 }, rules: [{ match: { name_glob: "imp_two*" }, interpret: { pixel_aspect: 1 } }], expect });
    check("ae_import_assets (paths, interpret and a rule)", r.ok && r.imported?.length === 2 && r.receipt?.matches === true, `${r.imported?.length} imported into ${r.bin}; ${cpNote(r)}; ${why(r)}`);
    r = await call("ae_import_assets", { paths: [impOne, impTwo], dry_run: true, expect });
    check("ae_import_assets (paths: files already in the project are skipped)", r.ok && r.to_import?.length === 0, `${r.to_import?.length} left`);

    // Pre-render sequence check on its own: reads the footage list and the folders, changes nothing.
    r = await call("ae_preflight", { scope: "sequences" });
    check("ae_preflight (scope sequences)", r.ok !== false && r.scope === "sequences" && r.sequences !== undefined, `${r.verdict ?? ""}`);

    // Layout: a master comp, one typed rectangle region filled with a footage item. Dry run changes nothing.
    const master = await call("ae_create_comp", { mode: "new", name: "smoke_layout", width: 640, height: 360, fps: 25, duration: 2, unique_name: true, expect });
    const LAYOUT = master.comps?.[0]?.id;
    check("ae_create_comp (target for ae_layout_apply)", master.applied === true && typeof LAYOUT === "number", why(master));
    const regionsArg = [{ name: "Smoke Panel A", rect: [0, 0, 320, 180], content: { footage_id: BATCH[0] } }];
    r = await call("ae_layout_apply", { comp_id: LAYOUT, regions: regionsArg, dry_run: true, expect });
    const layersAfterDry = (await call("ae_describe_comp", { comp_id: LAYOUT })).comp?.num_layers;
    check("ae_layout_apply (dry run: the plan, nothing written)", r.ok === true && r.dry_run === true && r.plan?.regions?.length === 1 && layersAfterDry === 0, `${JSON.stringify(r.plan?.regions?.[0]?.layer_rect)}; layers ${layersAfterDry}`);
    r = await call("ae_layout_apply", { comp_id: LAYOUT, regions: regionsArg, expect });
    check("ae_layout_apply (a typed rect region, written)", okWrite(r) && r.placed?.length === 1 && r.placed[0].name === "Smoke Panel A", `${cpNote(r)}; ${why(r)}`);
    r = await call("ae_layout_apply", { comp_id: LAYOUT, regions: [{ name: "Smoke Panel A", rect: [0, 0, 100, 100], content: { footage_id: BATCH[1] } }, { name: "Smoke Panel A", rect: [100, 0, 100, 100], content: { footage_id: BATCH[1] } }], dry_run: true, expect });
    check("ae_layout_apply (a duplicate region name is refused)", refused(r), why(r).slice(0, 120));

    // The template read that ae_layout_apply works from.
    r = await call("ae_describe_comp", { comp_id: LAYOUT, layout: true, include_layers: true });
    check("ae_describe_comp (layout: true)", r.ok === true && r.layout !== undefined && Array.isArray(r.regions) && r.layers?.some((l) => l.layout !== undefined), `${r.regions?.length} region(s); ${r.layers?.length} layer(s)`);
  }

  // ---------- wave 3: legibility (Wave Legibility: two overlapping texts) ----------
  {
    for (const n of ["Leg A", "Leg B"]) await call("ae_set_text", { comp_id: W.leg, layer: { name: n }, style: { fontSize: 60, fillColor: [1, 1, 1] }, expect });
    r = await call("ae_check_text_overlap", { comp_id: W.leg, times: [1] });
    check("ae_check_text_overlap", r.ok && r.read_only === true && r.overlap_count >= 1, `${r.text_layers} text layer(s), ${r.overlap_count} overlap(s)`);
    r = await call("ae_estimate_legibility", { comp_id: W.leg, times: [1] });
    check("ae_estimate_legibility", r.ok && r.read_only === true && typeof r.verdict === "string" && (!r.times_checked?.[0]?.annotated_path || /\.png$/i.test(r.times_checked[0].annotated_path)), `verdict ${r.verdict}`);
    const compsBefore = (await call("ae_get_project", { type: "comp", limit: 1 })).total;
    r = await call("ae_check_legibility", { comp_id: W.leg, times: [1], expect });
    check("ae_check_legibility", r.applied === true && r.receipt?.matches !== false && r.temp_comp?.copy_removed === true, `${r.verdict}: ${r.pass} pass, ${r.fail} fail, ${r.inconclusive} inconclusive; ${cpNote(r)}`);
    const compsAfter = (await call("ae_get_project", { type: "comp", limit: 1 })).total;
    check("ae_check_legibility (the copy is gone)", compsBefore === compsAfter, `${compsBefore} -> ${compsAfter} comps`);
    r = await call("ae_check_legibility", { comp_id: W.leg, times: [1], layers: [{ name: "does-not-exist" }], expect });
    check("ae_check_legibility (a bad selector is refused)", refused(r), why(r).slice(0, 100));
  }

  // ---------- wave 3: variants (Wave Variants; ask:false, so nobody has to answer) ----------
  {
    const vA = { id: "a", label: "Shift right", ops: [{ op: "offset", layers: [{ name: "V1" }, { name: "V2" }], delta: [60, 0] }] };
    const vB = { id: "b", label: "Staggered", ops: [{ op: "shift_time", layers: [{ name: "V1" }, { name: "V2" }], stagger: 0.25 }] };
    r = await call("ae_variants", { comp_id: W.vars, variants: [vA, vB], dry_run: true, expect });
    check("ae_variants (dry run)", r.ok && r.dry_run === true && !r.__isError, brief(r).slice(0, 120));
    r = await call("ae_variants", { comp_id: W.vars, variants: [vA, vB], ask: false, times: [0.5], expect });
    check("ae_variants", okWrite(r) && r.copies?.length === 2 && typeof r.set_id === "string", `${r.set_id}; ${why(r)}`);
    check("ae_variants (sheet rendered)", Boolean(r.renders?.sheet_path) && fs.existsSync(String(r.renders.sheet_path)) && (r.renders.errors ?? []).length === 0, String(r.renders?.sheet_path ?? "no sheet").slice(-40));
    r = await call("ae_variants_pick", { comp_id: W.vars, set_id: r.set_id, variant_id: "b", expect });
    check("ae_variants_pick", okWrite(r) && r.applied_variant?.id === "b", `${JSON.stringify(r.cleanup)}; ${why(r)}`);
    const vC = { id: "c", label: "Longer", ops: [{ op: "comp_duration", seconds: 3 }] };
    const vD = { id: "d", label: "Up", ops: [{ op: "offset", layers: [{ name: "V1" }], delta: [0, -40] }] };
    r = await call("ae_variants", { comp_id: W.vars, variants: [vC, vD], ask: false, expect });
    const discardId = r.set_id;
    r = await call("ae_variants_discard", { comp_id: W.vars, set_id: discardId, expect });
    check("ae_variants_discard", okWrite(r), `${JSON.stringify(r.cleanup)}; ${why(r)}`);
  }

  // ---------- wave 2: memory (the purges that can drop the undo history come later) ----------
  {
    r = await call("ae_memory_status", { warn_above_mb: 1, min_free_mb: 1 });
    ramPurgeAvailable = r.ae?.purge_targets_available?.ram ?? null;
    check("ae_memory_status", Boolean(r.ae) && Boolean(r.server) && typeof r.preflight?.ready === "boolean", `AE ${r.ae?.memory_in_use_bytes ?? "unreadable"} bytes; ready ${r.preflight?.ready}`);
    r = await call("ae_memory_status", { prefs: [{ section: "No Such Section", key: "No Such Key" }] });
    check("ae_memory_status (a missing pref)", r.ae?.prefs?.[0]?.exists === false, JSON.stringify(r.ae?.prefs?.[0]));
    r = await call("ae_memory_purge", { target: "image", expect });
    check("ae_memory_purge (image)", r.applied === true && r.purged === true && r.undo_history_cleared === false, `${why(r)}; receipt ${r.receipt?.matches}`);
    r = await call("ae_memory_purge", { target: "image", only_above_mb: 1_000_000, expect });
    check("ae_memory_purge (watchdog below its threshold)", r.purged === false && r.skipped_reason === "below_threshold", String(r.skipped_reason));
    r = await call("ae_memory_purge", { target: "snapshot", expect });
    check("ae_memory_purge (snapshot)", r.applied === true && !(r.warnings ?? []).some((w) => /RAM preview/.test(w)), why(r));
    r = await call("ae_memory_purge", { target: "ram", expect });
    check("ae_memory_purge (ram without the confirm flag is refused)", refused(r), why(r).slice(0, 100));
  }

  // ---------- wave 3: learn taste (Wave Work, last, because the trim changes a layer) ----------
  {
    r = await call("ae_taste_baseline", { comp_id: W.work });
    check("ae_taste_baseline", r.ok === true && r.layers > 0 && typeof r.baseline_id === "string", `${r.layers} layers, ${r.animated_properties} animated properties`);
    r = await call("ae_learn_taste", { comp_id: W.work, record: false });
    check("ae_learn_taste (no edits)", r.ok === true && r.changed === false && r.observations?.length === 0, JSON.stringify(r.counts));
    r = await call("ae_layer_ops", { action: "trim", comp_id: W.work, layers: [{ name: "Row3" }], out_point: 2, expect });
    check("ae_layer_ops (trim, as the edit to learn from)", okWrite(r), why(r));
    r = await call("ae_learn_taste", { comp_id: W.work, record: false });
    check("ae_learn_taste (after an agent write, so no ask)", r.ok === true && r.changed === true && r.agent_wrote_since_baseline === true && r.ask === null, JSON.stringify({ wrote: r.agent_wrote_since_baseline, counts: r.counts }));
    r = await call("ae_taste_rules", { action: "save", rule_ids: ["ease_influence"] });
    check("ae_taste_rules (save without a yes is refused)", refused(r), why(r).slice(0, 100));
    r = await call("ae_taste_rules", { action: "save", rule_ids: ["ease_influence"], ask_id: "ask_none" });
    check("ae_taste_rules (save with an unanswered ask)", r.ok === false && ["not_answered", "unknown_rule"].includes(r.error), String(r.error));
    r = await call("ae_taste_rules", { action: "list" });
    check("ae_taste_rules (list)", r.ok === true && Array.isArray(r.saved), `${r.saved?.length} saved rule(s), ${r.proposals?.length} proposal(s)`);
  }

  // ======================================================================
  // Waves 4 and 5 (167 tools after wave 4, 173 after wave 5). NONE of these steps has run in a live After Effects yet;
  // the arguments and checks come from the tools' current zod schemas and results (the build handoffs were only a start).
  // They run before the first plain ae_save of this script (the save_as at the top takes no checkpoint), so they take no new auto checkpoint (the checkpoint list check below counts them).
  // Each group works in comps of its own. The compositing groups share one textured, moving plate: fractal noise and twelve
  // bright or dark squares, 640 x 360, panning 16 px over half a second inside a 480 x 270 shot. Tracks cover 0 to 0.2 s (6 frames).
  // ======================================================================
  const w45 = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: waves 4-5 scene",
    expect,
    code: [
      "function mk(n, w, h, d) { return app.project.items.addComp(n, w, h, 1, d, 25); }",
      "var ids = {};",
      'var src = mk("W4 Plate Src", 640, 360, 2); ids.src = src.id;',
      'var tex = src.layers.addSolid([0.5, 0.5, 0.5], "Texture", 640, 360, 1);',
      'try { var nz = tex.property("ADBE Effect Parade").addProperty("ADBE Fractal Noise"); try { nz.property("Contrast").setValue(220); } catch (e1) {} try { nz.property("Scale").setValue(30); } catch (e2) {} try { nz.property("Complexity").setValue(6); } catch (e3) {} } catch (e0) {}',
      "for (var i = 0; i < 12; i++) {",
      '  var sq = src.layers.addSolid(i % 2 === 0 ? [1, 1, 1] : [0.05, 0.05, 0.05], "Mark" + i, 28, 28, 1);',
      '  sq.property("ADBE Transform Group").property("ADBE Position").setValue([60 + (i % 4) * 150 + (i * 13) % 40, 50 + Math.floor(i / 4) * 120 + (i * 29) % 30]);',
      "}",
      // A 480 x 270 shot: the plate pans [240,135] -> [256,141] in half a second (linear keys).
      "function shot(n) {",
      "  var c = mk(n, 480, 270, 2);",
      '  var p = c.layers.add(src); p.name = "Plate";',
      '  var pos = p.property("ADBE Transform Group").property("ADBE Position");',
      "  pos.setValueAtTime(0, [240, 135]); pos.setValueAtTime(0.5, [256, 141]);",
      "  pos.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      "  pos.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      "  return c;",
      "}",
      'ids.planar = shot("W4 Planar").id;',
      // Stabilize: Plate (moving) is the track source; five plates with no keys or effects are the targets (each ae_stabilize call needs a fresh one).
      'var st = shot("W4 Stab"); ids.stab = st.id;',
      'var sn = ["StabA", "StabB", "StabC", "StabD", "StabR"];',
      "for (var s = 0; s < sn.length; s++) { var q = st.layers.add(src); q.name = sn[s]; }",
      'ids.clean = shot("W4 Clean").id;',
      // clone_offset refuses a plate with animated transform keys, so it gets a comp with an unkeyed plate.
      'var cc = mk("W4 CloneSrc", 480, 270, 2); var cl = cc.layers.add(src); cl.name = "Plate"; ids.clone = cc.id;',
      // The residual check needs motion in the picture itself, not in the layer's keys: a precomp that pans, placed on an unkeyed layer.
      'var mvs = mk("W4 Moving Src", 640, 360, 2); var mvp = mvs.layers.add(src);',
      'var mpos = mvp.property("ADBE Transform Group").property("ADBE Position");',
      "mpos.setValueAtTime(0, [320, 180]); mpos.setValueAtTime(0.5, [336, 186]);",
      "mpos.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      "mpos.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      'var sv = mk("W4 StabV", 480, 270, 2); var svl = sv.layers.add(mvs); svl.name = "Plate"; ids.stabv = sv.id;',
      'ids.inpaint = shot("W4 Inpaint").id;',
      'ids.inp_out = mk("W4 Inpaint Out", 480, 270, 2).id;',
      'ids.matte = shot("W4 Matte").id;',
      'var lc = shot("W4 Locked"); lc.layer("Plate").locked = true; ids.locked = lc.id;',
      // Screen replacement: a dark plate, a lighter 160 x 90 screen that pans, an insert comp of the same 16:9 shape.
      'var sc = mk("W4 Screen", 480, 270, 2); ids.screen = sc.id;',
      'sc.layers.addSolid([0.08, 0.08, 0.1], "SR Plate", 480, 270, 1);',
      'var scr = sc.layers.addSolid([0.55, 0.6, 0.7], "SR Screen", 160, 90, 1);',
      'var sp = scr.property("ADBE Transform Group").property("ADBE Position");',
      "sp.setValueAtTime(0, [240, 135]); sp.setValueAtTime(0.4, [256, 141]);",
      "sp.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      "sp.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);",
      'var ins = mk("W4 Insert", 640, 360, 2); ins.layers.addSolid([0.9, 0.2, 0.2], "Insert Fill", 640, 360, 1); ids.insert = ins.id;',
      // Wave 5 fixtures.
      'var ops = mk("W5 Ops", 640, 360, 4); ids.ops = ops.id;',
      'var on = ["OpA", "OpB", "OpC", "OpD", "OpE", "OpM"];',
      "for (var j = 0; j < on.length; j++) ops.layers.addSolid([0.4, 0.5, 0.6], on[j], 100, 100, 1);",
      'var alt = mk("W5 Alt", 320, 180, 2); var al = alt.layers.addSolid([0.9, 0.3, 0.3], "Alt", 100, 100, 1); ids.alt_item = al.source.id;',
      'var fxc = mk("W5 FX", 640, 360, 2); fxc.layers.addSolid([0.3, 0.3, 0.4], "Backdrop", 640, 360, 1); ids.fx = fxc.id;',
      'var kc = mk("W5 Key", 640, 360, 4); kc.layers.addSolid([1, 0.5, 0], "Keys", 80, 80, 1); kc.layers.addSolid([0, 0.5, 1], "Keys2", 80, 80, 1); ids.key = kc.id;',
      'var tc = mk("W5 Text", 640, 360, 4); var tl = tc.layers.addText("W5 text"); tl.name = "W5Text"; ids.text = tc.id;',
      'ids.d3 = mk("W5 3D", 640, 360, 4).id;',
      'var sg = mk("W5 Settings", 640, 360, 4); sg.layers.addSolid([0.2, 0.2, 0.25], "Fill", 640, 360, 1); ids.settings = sg.id;',
      "return ids;",
    ].join("\n"),
  });
  const WS = w45.result ?? {};
  if (typeof WS.planar !== "number" || typeof WS.ops !== "number") throw new Error("Could not build the waves 4-5 scene: " + brief(w45));
  const compCount = async () => (await call("ae_get_project", { type: "comp", limit: 1 })).total;

  // ---------- wave 4: planar tracking (ae_track_multi, ae_track_read, ae_track_apply) ----------
  {
    const PL = WS.planar;
    const wholePlate = { rect: [0, 0, 480, 270] };
    r = await call("ae_track_multi", { comp_id: PL, auto_points: { region: wholePlate, count: 4 }, ref_time: 0, start: 0, end: 0.2, model: "similarity", preview: true });
    check(
      "ae_track_multi (auto points)",
      r.ok === true && r.complete === true && r.frames >= 5 && r.frames_ok >= r.frames - 1 && fs.existsSync(String(r.preview_path)) && fs.existsSync(String(r.track_path)),
      `${r.frames_ok}/${r.frames} frames, ${r.points?.length} points, rms ${JSON.stringify(r.rms_px)}; ${r.message ?? ""}`
    );
    const planarTrack = r.track_id;
    // A small budget stops with a continue id; the continue finishes the track.
    r = await call("ae_track_multi", { comp_id: PL, auto_points: { region: wholePlate, count: 4 }, ref_time: 0, start: 0, end: 0.2, max_frames: 3, preview: false });
    if (r.ok && r.complete === false && r.continue_track_id) {
      const cont = await call("ae_track_multi", { comp_id: PL, continue_track_id: r.continue_track_id, preview: false });
      check("ae_track_multi (continue after a small budget)", cont.ok === true && cont.complete === true, `${cont.frames} frames after the continue`);
    } else {
      check("ae_track_multi (small budget)", r.ok === true && r.complete === true, "finished inside the budget");
    }
    // isolate_layers renders a temporary copy with only the plate on, and removes it in the same call.
    r = await call("ae_track_multi", { comp_id: PL, auto_points: { region: wholePlate, count: 4 }, ref_time: 0, start: 0, end: 0.08, isolate_layers: [{ name: "Plate" }], preview: false, expect });
    check("ae_track_multi (isolate_layers, expect)", r.ok === true && r.temp_comp?.copy_removed === true && r.receipt?.matches === true, `${r.frames_ok}/${r.frames} frames; ${why(r)}`);
    r = await call("ae_track_multi", { comp_id: PL, auto_points: { region: wholePlate, count: 4 }, ref_time: 0, start: 0, end: 0.08, model: "perspective", preview: false });
    check("ae_track_multi (perspective with 4 points is allowed, with a note)", r.ok === true || /needs 4|bad_args/.test(JSON.stringify(r)), `${r.ok} ${(r.notes ?? []).length} note(s); ${r.message ?? ""}`.slice(0, 160));

    // Write the track as nulls, then read the nulls back as a track and compare.
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "nulls", null_prefix: "W4 Plate", solved_null: true, expect });
    check("ae_track_apply (nulls, solved null)", r.ok === true && r.applied === true && r.receipt?.matches === true && (r.nulls?.length ?? 0) >= 2, `${r.nulls?.length} nulls, ${r.frames_written} frames; ${why(r)}`);
    const nullNames = (r.nulls ?? []).map((n) => n.name).filter((n) => !/solved/i.test(String(n)));
    if (nullNames.length > 0) {
      r = await call("ae_track_read", { comp_id: PL, source: { nulls: nullNames.map((name) => ({ name })), model: "similarity" }, preview: false });
      check("ae_track_read (nulls)", r.ok === true && r.frames >= 2 && r.rms_px?.max < 2, `${r.frames} frames, rms ${JSON.stringify(r.rms_px)}; ${r.message ?? ""}`);
    } else {
      skip("ae_track_read (nulls)", "ae_track_apply nulls returned no point nulls to read back");
    }
    r = await call("ae_track_read", { comp_id: PL, source: { track_id: planarTrack }, preview: false });
    check("ae_track_read (a stored track_id)", r.ok === true && r.track_id === planarTrack, `${r.frames} frames`);
    r = await call("ae_track_read", { comp_id: PL, source: { transform: { layer: { name: "Plate" } } }, preview: false });
    check("ae_track_read (transform: the plate's own keys)", r.ok === true && r.frames >= 5 && r.model === "similarity", `${r.frames} frames, model ${r.model}; ${r.message ?? ""}`);

    // A Corner Pin on a solid, then the same track as a layer transform, CC Power Pin and transform + residual pin on others.
    for (const [nm, size] of [["W4 Pin", [200, 120]], ["W4 Pin2", [200, 120]], ["W4 Pin3", [200, 120]], ["W4 Pin4", [200, 120]]]) {
      await call("ae_create_layer", { comp_id: PL, type: "solid", name: nm, color: [1, 0, 0], width: size[0], height: size[1], expect });
    }
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "corner_pin", layer: { name: "W4 Pin" }, expect });
    check("ae_track_apply (corner_pin)", r.ok === true && r.applied === true && r.receipt?.matches === true, `${r.frames_written} frames, effect index ${r.written?.[0]?.effect_index}; ${why(r)}`);
    r = await call("ae_track_read", { comp_id: PL, source: { corner_pin: { layer: { name: "W4 Pin" } } }, preview: false });
    check("ae_track_read (corner_pin)", r.ok === true && r.model === "perspective" && Array.isArray(r.source_info?.param_table), `param table: ${JSON.stringify(r.source_info?.param_table)}`);
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "transform", layer: { name: "W4 Pin" }, replace_keys: true, expect });
    check("ae_track_apply (transform)", r.ok === true && r.applied === true && r.receipt?.matches === true, `${r.frames_written} frames; ${why(r)}`);
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "power_pin", layer: { name: "W4 Pin2" }, expect });
    check("ae_track_apply (power_pin)", r.ok === true && r.applied === true && r.receipt?.matches === true, `${r.frames_written} frames; ${why(r)}`);
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "transform_pin", layer: { name: "W4 Pin3" }, expect });
    check("ae_track_apply (transform_pin)", r.ok === true && r.applied === true && r.receipt?.matches === true, `${r.frames_written} frames; ${why(r)}`);
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "transform", layer: { name: "W4 Pin4" }, range: { start: 0, end: 0.08 }, expect });
    check("ae_track_apply (transform, a time range)", r.ok === true && r.applied === true && r.receipt?.matches === true && r.frames_written <= 4, `${r.frames_written} frames; ${why(r)}`);
    r = await call("ae_track_apply", { comp_id: PL, track: { track_id: planarTrack }, mode: "transform", layer: { name: "W4 Pin" }, expect });
    check("ae_track_apply (keys already on the layer refuse the write without replace_keys)", refused(r), why(r).slice(0, 120));
    await call("ae_run_jsx", {
      mutates: true,
      label: "qa smoke: remove planar layers",
      expect: { ...expect, comp_id: PL },
      code: `var c = app.project.itemByID(${PL}); for (var i = c.numLayers; i >= 1; i--) { var n = c.layer(i).name; if (n.indexOf("W4 Plate ") === 0 || n.indexOf("W4 Pin") === 0) c.layer(i).remove(); } return c.numLayers;`,
    });
    skip("ae_track_read (tracker: AE Tracker points)", "the scratch project has no AE Tracker data, and a script cannot make any");
    skip("ae_track_apply / ae_track_multi on a 3D layer, a separated Position or non-square pixels", "these are refusals of the host; the scratch scene has none of them");
  }

  // ---------- wave 4: stabilize (ae_stabilize, ae_stabilize_roundtrip) ----------
  {
    const ST = WS.stab;
    // FIRST wave 4 live check: does a guide layer inside a nested comp stay out of the parent's render and of saveFrameToPng?
    const stabTrack = { transform: { layer: { name: "Plate" } }, model: "translate", ref_time: 0 };
    r = await call("ae_stabilize_roundtrip", { comp_id: ST, plate: { name: "StabR" }, track: stabTrack, pad_px: 40, expect });
    check("ae_stabilize_roundtrip (build)", r.ok === true && r.applied === true && r.receipt?.matches === true && typeof r.roundtrip_error_px === "number" && r.roundtrip_error_px < 0.05, `error ${r.roundtrip_error_px} px; ${why(r)}`);
    const rigWork = r.work_comp?.id;
    const rigOuter = r.outer_layer?.id;
    if (Array.isArray(r.picture_change)) {
      check(
        "ae_stabilize_roundtrip (the guide layer stays out of the shot: picture_change is 0)",
        r.guide_plate_renders_suspected !== true && r.picture_change.every((p) => p.mean_abs_diff !== null && p.mean_abs_diff < 1),
        `picture_change ${JSON.stringify(r.picture_change)}; suspected ${r.guide_plate_renders_suspected}`
      );
    } else {
      skip("ae_stabilize_roundtrip (picture_change)", `the build returned no picture_change (${r.sheet_error ?? "no renders were made"})`);
    }
    r = await call("ae_stabilize_roundtrip", { comp_id: ST, action: "remove", rig_layer: { id: rigOuter }, expect });
    check("ae_stabilize_roundtrip (remove)", r.ok === true && r.applied === true && r.receipt?.matches === true && r.removed?.work_comp?.id === rigWork, `removed ${JSON.stringify(r.removed)}; ${why(r)}`);

    r = await call("ae_stabilize", { comp_id: ST, layer: { name: "StabA" }, track: stabTrack, verify: false, sheets: false, expect });
    check("ae_stabilize (layer_transform, lock)", r.ok === true && r.applied === true && r.receipt?.matches === true && r.target === "layer_transform" && r.frames_written >= 2, `${r.frames_written} keys; ${why(r)}`);
    r = await call("ae_stabilize", { comp_id: ST, layer: { name: "StabB" }, track: stabTrack, target: "transform_effect", edges: "motion_tile", shutter_angle: 90, verify: false, sheets: false, expect });
    check(
      "ae_stabilize (transform_effect + motion_tile): LIVE CHECK the param_tables",
      r.ok === true && r.applied === true && r.receipt?.matches === true && (r.param_tables?.transform_effect ?? []).some((p) => p.role === "rotation"),
      `${JSON.stringify(r.param_tables)}; ${why(r)}`
    );
    r = await call("ae_stabilize", { comp_id: ST, layer: { name: "StabB" }, track: stabTrack, target: "transform_effect", expect });
    check("ae_stabilize (a plate that already has a Stabilize Transform is refused)", refused(r), why(r).slice(0, 120));
    r = await call("ae_stabilize", { comp_id: ST, layer: { name: "StabC" }, track: stabTrack, target: "transform_effect", edges: "scale_to_fill", mode: "smooth", verify: false, sheets: false, expect });
    check("ae_stabilize (smooth, scale_to_fill)", r.ok === true && r.applied === true && r.receipt?.matches === true && (r.zoom === undefined || r.zoom >= 1), `zoom ${r.zoom}; ${why(r)}`);
    r = await call("ae_stabilize", { comp_id: ST, layer: { name: "StabD" }, track: stabTrack, target: "corner_pin", verify: false, sheets: false, expect });
    check("ae_stabilize (corner_pin)", r.ok === true && r.applied === true && r.receipt?.matches === true && r.target === "corner_pin", `${r.frames_written} keys; ${why(r)}`);
    // The residual check (verify: true) renders and measures at the track's points, so the picture must really move inside the frame.
    // W4 StabV holds a panning precomp on an unkeyed layer; ae_track_multi tracks it, and ae_stabilize locks it with that track.
    const vt = await call("ae_track_multi", { comp_id: WS.stabv, auto_points: { region: { rect: [0, 0, 480, 270] }, count: 4 }, ref_time: 0, start: 0, end: 0.2, model: "similarity", preview: false });
    r = await call("ae_stabilize", { comp_id: WS.stabv, layer: { name: "Plate" }, track: { track_id: vt.track_id }, verify: true, verify_frames: 3, sheets: false, max_renders: 8, expect });
    check(
      "ae_stabilize (verify: residual motion measured at the track's points, under 2 px)",
      vt.ok === true && r.ok === true && r.applied === true && typeof r.residual?.rms_px === "number" && r.residual.rms_px < 2,
      `track ${vt.ok} (${vt.message ?? "ok"}); residual ${JSON.stringify(r.residual)?.slice(0, 140)}; meets the 0.5 px target: ${r.residual?.meets_target}; ${r.verify_error ?? why(r)}`
    );
  }

  // ---------- wave 4: clean plate, patch checks and fits, inpaint ----------
  {
    const CL = WS.clean;
    const hole = { rect: [160, 90, 80, 60] }; // [x, y, w, h], planar's region form
    const holeBox = { kind: "rect", rect: [160, 90, 240, 150] }; // [x0, y0, x1, y1], the patch tools' form
    const pick = await call("ae_cleanplate_pick", { comp_id: CL, region: hole, mode: "static", start: 0, end: 0.4, every_n: 4, max_renders: 12, contact_sheet: true });
    check("ae_cleanplate_pick", pick.ok === true && typeof pick.recommended_ref_time === "number" && /^sampled \d+ of \d+$/.test(String(pick.sampled)), `ref ${pick.recommended_ref_time}, ${pick.sampled}; ${pick.message ?? ""}`);
    check("ae_cleanplate_pick (contact sheet)", fs.existsSync(String(pick.contact_sheet_path)), String(pick.contact_sheet_path ?? "no sheet").slice(-40));
    const refT = typeof pick.recommended_ref_time === "number" ? pick.recommended_ref_time : 0;
    const setup = await call("ae_cleanplate_setup", { comp_id: CL, plate: { name: "Plate" }, source: "freeze", ref_time: refT, region: hole, name: "W4 Patch", expect });
    check("ae_cleanplate_setup (freeze)", setup.ok === true && setup.applied === true && setup.receipt?.matches === true && typeof setup.patch_layer?.id === "number", `${why(setup)}`);
    check("ae_cleanplate_setup (freeze: needs_fix until the hole is cleaned)", setup.needs_fix === true && (setup.fixes_in_order ?? []).length >= 2, `${(setup.fixes_in_order ?? []).length} fixes in order`);
    check("ae_cleanplate_setup (the patch comp is comp-sized, the sheet is written)", setup.patch_comp?.width === 480 && setup.patch_comp?.height === 270 && typeof setup.before_after_sheet === "string", `${setup.patch_comp?.name} ${setup.patch_comp?.width}x${setup.patch_comp?.height}`);
    const patchId = setup.patch_layer?.id;
    const clone = await call("ae_cleanplate_setup", { comp_id: WS.clone, plate: { name: "Plate" }, source: "clone_offset", offset: { dx: 120, dy: 0, frames: 0 }, ref_time: 0, region: hole, feather_px: 10, expansion_px: 1, name: "W4 Clone", expect });
    check("ae_cleanplate_setup (clone_offset: no fix needed, expansion raised to half the feather)", clone.ok === true && clone.applied === true && clone.needs_fix === false && clone.mask?.expansion_px === 5, `needs_fix ${clone.needs_fix}, expansion ${clone.mask?.expansion_px}; ${why(clone)}`);
    r = await call("ae_cleanplate_setup", { comp_id: WS.locked, plate: { name: "Plate" }, source: "freeze", ref_time: 0, region: hole, expect });
    check("ae_cleanplate_setup (a locked plate is refused before anything changes)", r.ok === false, why(r).slice(0, 120));
    skip("ae_cleanplate_setup (source still, action reload)", "they need a painted PNG of the cleaned frame, which the scratch project cannot make");

    // patch_check and region_stats on the freeze patch, few frames (neighbours 0.04 s apart, so pops are measurable).
    if (typeof patchId === "number") {
      const compsBefore = await compCount();
      r = await call("ae_patch_check", { comp_id: CL, patch_layers: [{ id: patchId }], times: [0, 0.04, 0.08, 0.12], grain_probes: 1, max_renders: 40, expect });
      check("ae_patch_check (footprint from the patch layer's masks)", r.applied === true && r.temp_comp?.copy_removed === true && r.receipt?.matches === true && Array.isArray(r.checks) && r.checks.length >= 3 && Boolean(r.series_path), `verdict ${r.verdict}, ${r.checks?.length} checks; ${r.sampled?.note}; ${why(r)}`);
      check("ae_patch_check (leaves no copy)", (await compCount()) === compsBefore, `${compsBefore} comps`);
      r = await call("ae_patch_check", { comp_id: CL, patch_layers: [{ id: patchId }], region: holeBox, times: [0, 0.04, 0.08, 0.12], grain_probes: 0, max_renders: 4, expect });
      check("ae_patch_check (a render budget cuts the run and says so)", r.applied === true && r.temp_comp?.copy_removed === true && r.render_budget?.cut === true && r.sampled?.frames_measured < r.sampled?.frames_sampled, `budget ${JSON.stringify(r.render_budget)}; measured ${r.sampled?.frames_measured} of ${r.sampled?.frames_sampled}; ${r.sampled?.note}`);
      r = await call("ae_region_stats", { comp_id: CL, regions: [{ name: "centre", shape: holeBox }], times: [0, 0.04, 0.08], max_samples: 4 });
      check("ae_region_stats (read-only)", r.ok === true && r.read_only === true && (r.regions?.[0]?.frames?.length ?? 0) >= 2, `${r.regions?.[0]?.frames?.length} frames; ${r.sampled?.note}; ${r.message ?? ""}`);
      check("ae_region_stats (series, graph and region image are written)", fs.existsSync(String(r.series_path)) && fs.existsSync(String(r.graph_path)) && fs.existsSync(String(r.regions_png)), `${String(r.graph_path ?? "").slice(-30)}`);
      const trkRead = await call("ae_track_read", { comp_id: CL, source: { transform: { layer: { name: "Plate" } } }, preview: false });
      r = await call("ae_region_stats", { comp_id: CL, regions: [{ name: "tracked", shape: holeBox, track: { track_id: trkRead.track_id } }], times: [0, 0.04, 0.08], max_samples: 4 });
      check("ae_region_stats (a region that follows a track)", r.ok === true && r.regions?.[0]?.tracked === true, `${r.regions?.[0]?.frames?.length} frames; ${r.message ?? ""}`);
      r = await call("ae_region_stats", { comp_id: CL, regions: [{ shape: holeBox }], hide_layers: [{ id: patchId }], times: [0, 0.08], max_samples: 2, expect });
      check("ae_region_stats (hide_layers: a temporary copy, removed again)", r.applied === true && r.temp_comp?.copy_removed === true && r.receipt?.matches === true, why(r));

      const fit = { comp_id: CL, layer: { id: patchId }, region: holeBox, ref_time: 0, expect };
      r = await call("ae_patch_color_match", { ...fit, start: 0, end: 0.2, step: 2, dry_run: true });
      check("ae_patch_color_match (dry_run)", r.ok !== false && r.complete === true && r.temp_comp?.copy_removed === true && r.receipt?.matches === true, `${r.curves?.samples?.length} samples; swing ${r.drift?.flicker_luma_swing}; ${r.message ?? ""}`);
      r = await call("ae_patch_color_match", { ...fit, start: 0, end: 0.2, step: 2 });
      check("ae_patch_color_match (levels)", r.ok !== false && r.complete === true && (r.applied === false || (r.write?.applied === true && r.write?.receipt?.matches === true)), `applied ${r.applied}; ${(r.write?.receipt?.mismatches ?? []).map((m) => m.message).join("; ")}; ${r.message ?? ""}`);
      r = await call("ae_patch_color_match", { ...fit, start: 0, end: 0.2, step: 1, max_renders: 4, dry_run: true });
      check("ae_patch_color_match (max_renders gives a continue_id or finishes)", r.ok !== false && (r.complete === true || typeof r.continue_id === "string"), `complete ${r.complete}, continue ${r.continue_id}`);
      r = await call("ae_patch_grain", { comp_id: CL, layer: { id: patchId }, region: holeBox, ref_time: 0, start: 0, end: 0.2, samples: 2, dry_run: true, expect });
      check("ae_patch_grain (dry_run: measure only)", r.ok !== false && r.sigma_before?.plate_ring?.spatial?.length === 3, `ring ${JSON.stringify(r.sigma_before?.plate_ring?.spatial)}, patch ${JSON.stringify(r.sigma_before?.patch?.spatial)}, frozen ${r.sigma_before?.frozen_grain}; ${r.message ?? ""}`);
      r = await call("ae_patch_grain", { comp_id: CL, layer: { id: patchId }, region: holeBox, ref_time: 0, start: 0, end: 0.2, samples: 2, rounds: 1, expect });
      check("ae_patch_grain (add and tune)", r.ok !== false && (r.grain_added === false || (r.write?.applied === true && r.write?.receipt?.matches === true)), `intensity ${r.start_intensity} -> ${r.final_intensity}; mode index ${r.write?.grain?.viewing_mode_index}; converged ${r.converged}; ${r.message ?? ""}`);
      r = await call("ae_patch_finish", { comp_id: CL, layer: { id: patchId }, region: holeBox, ref_time: 0, start: 0, end: 0.2, samples: 3, dry_run: true, expect });
      check("ae_patch_finish (dry_run: the plan)", r.ok !== false && r.applied === false && typeof r.measured === "object", `plan ${JSON.stringify(Object.keys(r.plan ?? {}))}; ${r.message ?? ""}`);
      r = await call("ae_patch_finish", { comp_id: CL, layer: { id: patchId }, region: holeBox, ref_time: 0, start: 0, end: 0.2, samples: 3, expect });
      check("ae_patch_finish", r.ok !== false && (r.applied === false || (r.write?.applied === true && r.write?.receipt?.matches === true)), `${(r.write?.receipt?.mismatches ?? []).map((m) => m.message).join("; ")}; ${r.message ?? ""}`);
    } else {
      skip("ae_patch_check / ae_region_stats / ae_patch_color_match / ae_patch_grain / ae_patch_finish", "ae_cleanplate_setup made no patch layer to measure");
    }

    // inpaint: spatial first (one render of the isolated plate), then temporal with an object that moves, placed masked in a scratch comp.
    const IP = WS.inpaint;
    const inp = await call("ae_inpaint_plate", { comp_id: IP, plate_layer: { name: "Plate" }, regions: [{ rect: [160, 90, 60, 60] }], method: "spatial", spatial: "diffuse", grow_px: 4, expect });
    check("ae_inpaint_plate (spatial: applied, clean receipt, still imported)", inp.applied === true && inp.receipt?.matches === true && typeof inp.item?.id === "number", `${why(inp)}; ${inp.message ?? ""}`);
    check("ae_inpaint_plate (spatial: the whole hole is spatial, png in the plates folder, plate copy removed)", (inp.fill?.filled?.spatial_share ?? 0) >= 0.99 && /chroma plates/.test(String(inp.fill?.png_path)) && inp.fill?.plate_copy?.removed === true, `spatial ${inp.fill?.filled?.spatial_share}; ${String(inp.fill?.png_path).slice(-40)}`);
    const inp2 = await call("ae_inpaint_plate", { comp_id: IP, plate_layer: { name: "Plate" }, regions: [{ rect: [160, 90, 60, 60] }], method: "auto", object_moves: true, ref_time: 0.1, start: 0, end: 0.2, max_frames: 6, place_in_comp: { comp_id: WS.inp_out, mode: "masked" }, expect });
    check("ae_inpaint_plate (temporal, placed masked in another comp)", inp2.applied === true && inp2.receipt?.matches === true && Boolean(inp2.layer), `${why(inp2)}; ${inp2.message ?? ""}`);
    check("ae_inpaint_plate (a second still does not overwrite the first)", Boolean(inp2.fill?.png_path) && inp2.fill?.png_path !== inp.fill?.png_path, String(inp2.fill?.png_path).slice(-40));
    r = await call("ae_inpaint_plate", { comp_id: IP, plate_layer: { name: "Plate" }, regions: [{ rect: [0, 0, 100000, 100000] }], expect });
    check("ae_inpaint_plate (a hole over 25% of the frame is refused)", r.ok === false && r.error === "refused", `${r.error}: ${String(r.message ?? "").slice(0, 100)}`);
  }

  // ---------- wave 4: mattes (ae_mask_follow, ae_garbage_matte, ae_caf_prep) ----------
  {
    const MT = WS.matte;
    const tr0 = await call("ae_track_read", { comp_id: MT, source: { transform: { layer: { name: "Plate" } } }, preview: false });
    const trk = tr0.track_id;
    check("ae_track_read (transform, for the mattes)", tr0.ok === true && typeof trk === "string", `${tr0.frames} frames`);
    r = await call("ae_mask_follow", { comp_id: MT, layer: { name: "Plate" }, new_mask: { region: { rect: [100, 60, 120, 80] }, name: "Smoke follow" }, track: { track_id: trk }, mode: "subtract", expansion: 3, expect });
    check("ae_mask_follow (new mask, tracked)", r.applied === true && r.receipt?.matches === true && r.mask !== undefined && r.frames?.keyed >= 2, `${r.frames?.keyed}/${r.frames?.solved} keys, bezier err ${r.max_bezier_error_px}; ${why(r)}`);
    r = await call("ae_mask_follow", { comp_id: MT, layer: { name: "Plate" }, mask: { name: "Smoke follow" }, track: { track_id: trk }, replace_keys: true, scale_feather: true, feather: 8, expect });
    check("ae_mask_follow (existing mask, replace keys, scaled feather)", r.applied === true && r.receipt?.matches === true && !r.feather_fallback && !r.path_error && !r.work_area_error, `${why(r)}`);
    r = await call("ae_garbage_matte", { comp_id: MT, targets: [{ name: "Plate" }], region: { ellipse: [240, 135, 60, 40] }, track: { track_id: trk }, matte_type: "alpha", name: "Smoke GM", feather: 6, choke: 2, replace_existing_matte: true, expect });
    check("ae_garbage_matte (tracked, hidden, choke)", r.applied === true && r.receipt?.matches === true, `choke ${JSON.stringify(r.choke)}; keys ${JSON.stringify(r.frames)}; ${why(r)}`);
    r = await call("ae_caf_prep", { comp_id: MT, layer: { name: "Plate" }, new_mask: { region: { rect: [200, 150, 80, 60] }, name: "Smoke CAF" }, track: { track_id: trk }, expansion: 6, expect });
    check("ae_caf_prep (tracked Subtract mask, work area)", r.applied === true && r.receipt?.matches === true && Array.isArray(r.instructions) && r.instructions.length >= 5 && r.open_panel?.tool === "ae_open_panel", `work area ${JSON.stringify(r.work_area)}; ${why(r)}`);
    r = await call("ae_caf_prep", { comp_id: MT, layer: { name: "Plate" }, find_fill: true });
    check("ae_caf_prep (find_fill, read only)", r.ok === true && r.find_fill === true && Array.isArray(r.candidates), `${r.candidates?.length} candidate(s)`);
    skip("ae_caf_prep (the Content-Aware Fill itself)", "Generate Fill Layer has no scripting API; only the prep and find_fill are covered");
  }

  // ---------- wave 4: screen replacement (ae_screen_corners, ae_screen_replace) ----------
  {
    const SR = WS.screen;
    const trueCorners = [[160, 90], [320, 90], [320, 180], [160, 180]];
    const guess = [[164, 86], [324, 93], [322, 184], [157, 177]];
    r = await call("ae_screen_corners", { comp_id: SR, ref_time: 0, corners: guess, search_px: 14, preview: true });
    const snapped = r.corners_snapped;
    check(
      "ae_screen_corners (snaps rough corners onto a step edge)",
      r.ok === true && r.read_only === true && r.corners?.length === 4 && Array.isArray(snapped) && trueCorners.every((t, i) => Math.hypot(snapped[i][0] - t[0], snapped[i][1] - t[1]) < 2) && fs.existsSync(String(r.preview_path)),
      `${(r.corners ?? []).map((c) => `${c.name}:${c.method}/${c.confidence}`).join(" ")}; aspect ${r.aspect?.estimate} (${r.aspect?.method}); ${r.message ?? ""}`
    );
    const trS = await call("ae_track_read", { comp_id: SR, source: { transform: { layer: { name: "SR Screen" } } }, preview: false });
    check("ae_track_read (transform, for the screen)", trS.ok === true && trS.frames >= 5, `${trS.frames} frames`);
    if (Array.isArray(snapped) && typeof trS.track_id === "string") {
      r = await call("ae_screen_replace", {
        comp_id: SR,
        track: { track_id: trS.track_id },
        corners: snapped,
        ref_time: 0,
        insert: { item_id: WS.insert },
        plate: { name: "SR Plate" },
        name: "SR",
        insert_aspect: 16 / 9,
        max_samples: 4,
        contact_sheet: true,
        expect,
      });
      check("ae_screen_replace (CC Power Pin)", r.applied === true && r.receipt?.matches === true && Boolean(r.insert?.comp) && /power_pin|corner_pin/.test(String(r.pin?.kind)) && Boolean(r.sheet_path), `pin ${r.pin?.kind} (${r.pin?.values_used}); skipped ${JSON.stringify((r.look_skipped ?? []).map((s) => s.step))}; ${why(r)}`);
      // LIVE-ONLY facts to read off the result: pin.param_table (CC Power Pin point names and order), pin.expansion.mode, look.levels.unit, look.blur, measured.edge.sigma_px.
      r = await call("ae_screen_replace", {
        comp_id: SR,
        track: { track_id: trS.track_id },
        corners: snapped,
        ref_time: 0,
        insert: { item_id: WS.insert },
        plate: { name: "SR Plate" },
        name: "SR2",
        insert_aspect: 16 / 9,
        pin: "corner_pin",
        motion_blur: "transform_pin",
        reflections: true,
        match_look: true,
        contact_sheet: false,
        max_samples: 3,
        expect,
      });
      check("ae_screen_replace (corner pin, transform_pin blur, reflections)", r.applied === true && r.receipt?.matches === true && r.motion_blur?.mode === "transform_pin", `skipped ${JSON.stringify((r.look_skipped ?? []).map((s) => s.step))}; ${why(r)}`);
      r = await call("ae_screen_replace", { comp_id: SR, track: { track_id: trS.track_id }, corners: snapped, ref_time: 0, insert: { item_id: WS.screen }, name: "SR3", expect });
      check("ae_screen_replace (an insert that is the target comp is refused)", refused(r), why(r).slice(0, 120));
    } else {
      skip("ae_screen_replace", "ae_screen_corners or ae_track_read gave no corners or track to use");
    }
  }

  // ---------- wave 5: ae_run_jsx and skill safety lint, ae_status detail, property metadata ----------
  const OPS = WS.ops;
  const TRN = "ADBE Transform Group";
  const OPAC = [TRN, "ADBE Opacity"];
  {
    r = await call("ae_run_jsx", { code: "system.callSystem('cmd /c dir');", mutates: false, label: "lint callSystem" });
    check("ae_run_jsx (safety lint: an outside program)", r.__isError === true && /system\.callSystem/.test(JSON.stringify(r)), brief(r).slice(0, 120));
    r = await call("ae_run_jsx", { code: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);", mutates: true, label: "lint close", expect });
    check("ae_run_jsx (safety lint: project.close names ae_project_session)", r.__isError === true && /ae_project_session/.test(JSON.stringify(r)), brief(r).slice(0, 120));
    r = await call("ae_run_jsx", { code: "app.project.save(new File('x.aep'));", mutates: true, label: "lint save", expect });
    check("ae_run_jsx (safety lint: project.save names ae_save)", r.__isError === true && /ae_save/.test(JSON.stringify(r)), brief(r).slice(0, 120));
    r = await call("ae_run_jsx", { code: "app.project.item(1).remove();", mutates: false, label: "lint write as read" });
    check("ae_run_jsx (safety lint: a write with mutates false)", r.__isError === true && /mutates: true/.test(JSON.stringify(r)), brief(r).slice(0, 120));
    r = await call("ae_run_jsx", { code: "return app.version;", mutates: false, label: "lint allows reads" });
    check("ae_run_jsx (safety lint: a plain read passes)", !r.__isError && Boolean(r.result), brief(r).slice(0, 80));
    r = await call("ae_skill_save", { name: "smoke-unsafe", description: "Must be refused.", steps: ["system.callSystem('cmd /c dir');"], scope: "project", overwrite: true, expect });
    check("ae_skill_save (safety lint: a step with an outside program is refused)", refused(r) && /callSystem/.test(JSON.stringify(r)), why(r).slice(0, 120) || brief(r).slice(0, 120));

    r = await call("ae_status", { detail: true });
    const d = r.detail ?? {};
    check("ae_status (detail)", Array.isArray(d.selected_properties) && Array.isArray(d.project_selection) && d.build !== undefined && Array.isArray(d.missing), `viewer ${d.viewer?.type ?? "none"}, lang ${d.iso_language}, rendering_disabled ${d.rendering_disabled}, missing ${(d.missing ?? []).join("; ")}`);
    check("ae_status (detail has no user or machine name)", !/userName|machineName/.test(JSON.stringify(r)));
    check("ae_status (default unchanged)", (await call("ae_status")).detail === undefined);

    r = await call("ae_get_layer_props", { comp_id: OPS, layer: { name: "OpA" }, path: OPAC, depth: 1, meta: true });
    check("ae_get_layer_props (meta: what the property accepts)", r.property?.meta?.value_type === "OneD" && r.property.meta.max === 100, brief(r.property?.meta ?? r).slice(0, 140));
    r = await call("ae_set_property", { comp_id: OPS, layer: { name: "OpA" }, path: OPAC, value: 140, expect });
    check("ae_set_property (a value over the property's maximum is refused before the undo group)", refused(r), why(r).slice(0, 120));
    r = await call("ae_set_property", { comp_id: OPS, layer: { name: "OpA" }, path: OPAC, expression: "thisIsNotDefined(", expect });
    check("ae_set_property (a broken expression is a receipt mismatch with expression_error)", r.applied === true && r.receipt?.matches === false && String(r.expression_error ?? "").length > 0, `expression_error ${String(r.expression_error).slice(0, 80)}`);
    r = await call("ae_set_property", { comp_id: OPS, layer: { name: "OpA" }, path: OPAC, expression: "", expression_enabled: false, expect });
    check("ae_set_property (clear the expression)", r.applied === true && r.receipt?.matches !== false, why(r));

    r = await call("ae_run_jsx", { code: "var l = app.project.itemByID(" + OPS + ").layer('OpM'); var m = l.property('ADBE Mask Parade').addProperty('ADBE Mask Atom'); return m.name;", mutates: true, label: "qa smoke: w5 mask", expect });
    const maskPath = ["ADBE Mask Parade", String(r.result), "ADBE Mask Shape"];
    r = await call("ae_set_property", { comp_id: OPS, layer: { name: "OpM" }, path: maskPath, value: { vertices: [[0, 0], [100, 0], [100, 100]], closed: true }, expect });
    check("ae_set_property (a mask path value)", okWrite(r), why(r));
    r = await call("ae_get_layer_props", { comp_id: OPS, layer: { name: "OpM" }, path: maskPath, depth: 1, shape_values: true });
    check("ae_get_layer_props (shape_values: the path reads back)", r.property?.value?.num_vertices === 3, brief(r.property?.value ?? r).slice(0, 120));
    r = await call("ae_set_property", { comp_id: WS.text, layer: { name: "W5Text" }, path: ["ADBE Text Properties", "ADBE Text Document"], value: { text: "w5", font: "NoSuchFont-Regular" }, expect });
    if (refused(r)) check("ae_set_property (an unknown font is refused with candidates)", /not available|candidates|No installed font/i.test(JSON.stringify(r)), why(r).slice(0, 140));
    else skip("ae_set_property (an unknown font is refused with candidates)", "this AE did not check the font (it has no app.fonts, which needs AE 24.0)");
  }

  // ---------- wave 5: ae_layer_ops (split, stretch, replace source, solid settings, the missing switches, separate dimensions) ----------
  {
    const wops = (args) => call("ae_layer_ops", { comp_id: OPS, expect, ...args });
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], effects_active: false, preserve_transparency: true, comment: "smoke", stretch: 200 });
    check("ae_layer_ops (switches: effects_active, preserve_transparency, comment, stretch 200)", okWrite(r), why(r));
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], stretch: 100, effects_active: true, preserve_transparency: false, comment: "" });
    check("ae_layer_ops (switches back, stretch 100)", okWrite(r), why(r));
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], stretch: 0.5 });
    check("ae_layer_ops (a stretch between -1 and 1 is refused)", refused(r), why(r).slice(0, 120));
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], frame_blending: "frame_mix", auto_orient: "along_path" });
    check("ae_layer_ops (frame blending and auto-orient)", okWrite(r), why(r));
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], frame_blending: "none", auto_orient: "off" });
    check("ae_layer_ops (frame blending and auto-orient reset)", okWrite(r), why(r));
    r = await wops({ action: "switches", layers: [{ name: "OpA" }], environment: true, dry_run: true });
    check("ae_layer_ops (environment layer dry run lists its renderer warning or a skip)", !r.__isError && r.dry_run === true, brief(r).slice(0, 140));
    r = await wops({ action: "split", layers: [{ name: "OpB" }], time: 1.5, dry_run: true });
    check("ae_layer_ops (split dry run)", r.dry_run === true && !r.__isError, brief(r.splits ?? r).slice(0, 140));
    r = await wops({ action: "split", layers: [{ name: "OpB" }], time: 1.5 });
    check("ae_layer_ops (split)", okWrite(r) && r.duplicates_total === 1, why(r));
    r = await wops({ action: "split", layers: [{ name: "OpC" }], time: 9999 });
    check("ae_layer_ops (a split outside the layer changes nothing)", !r.__isError && (r.no_op === true || r.applied === true), brief(r.skipped ?? r).slice(0, 120));
    r = await wops({ action: "separate_dimensions", layers: [{ name: "OpC" }], enable: true });
    check("ae_layer_ops (separate Position)", okWrite(r), why(r));
    r = await wops({ action: "separate_dimensions", layers: [{ name: "OpC" }], enable: false });
    check("ae_layer_ops (unify Position)", okWrite(r), why(r));
    r = await wops({ action: "replace_source", layers: [{ name: "OpD" }], item_id: WS.alt_item, keep_size: true, dry_run: true });
    check("ae_layer_ops (replace_source dry run)", r.dry_run === true && Array.isArray(r.replacements), brief(r.replacements ?? r).slice(0, 140));
    r = await wops({ action: "replace_source", layers: [{ name: "OpD" }], item_id: WS.alt_item, keep_size: true });
    check("ae_layer_ops (replace_source)", okWrite(r), why(r));
    r = await wops({ action: "replace_source", layers: [{ name: "OpD" }], item_id: OPS });
    check("ae_layer_ops (replace_source with the comp itself is refused)", refused(r), why(r).slice(0, 120));
    r = await wops({ action: "solid_settings", layers: [{ name: "OpE" }], color: [0.2, 0.4, 0.6], dry_run: true });
    check("ae_layer_ops (solid_settings dry run lists the layers that use the solid)", r.dry_run === true && !r.__isError, brief(r.solids ?? r).slice(0, 140));
    r = await wops({ action: "solid_settings", layers: [{ name: "OpE" }], color: [0.2, 0.4, 0.6], width: 120, scope: "layer_only" });
    check("ae_layer_ops (solid_settings, this layer only)", okWrite(r), why(r));
  }

  // ---------- wave 5: ae_comp_settings (name, size around an anchor, frame rate, duration, trim to work area, guides) ----------
  {
    const SG = WS.settings;
    const g0 = await call("ae_get_comp_settings", { comp_id: SG });
    check("ae_get_comp_settings (guides carry their direction)", Array.isArray(g0.guides) && g0.guides.every((g) => g.orientation === undefined || g.orientation === "horizontal" || g.orientation === "vertical"), `${g0.guide_count} guide(s)`);
    r = await call("ae_comp_settings", { comp_id: SG, settings: { name: "W5 Settings renamed", pixel_aspect: 1 }, expect });
    check("ae_comp_settings (rename, pixel aspect)", okWrite(r), why(r));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { size: { width: g0.width + 200, height: g0.height + 100, anchor: "center" } }, expect });
    check("ae_comp_settings (anchored resize: the layer keeps its place, no doubled shift)", okWrite(r) && (r.resize?.layers_moved ?? 0) >= 1, `moved ${r.resize?.layers_moved}; ${why(r)}`);
    r = await call("ae_comp_settings", { comp_id: SG, settings: { size: { width: g0.width, height: g0.height, anchor: "center" } }, expect });
    check("ae_comp_settings (resize back)", okWrite(r), why(r));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { name: "W5 Settings renamed" }, expect });
    check("ae_comp_settings (setting what is already set is a no-op)", r.no_op === true, brief(r).slice(0, 100));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { drop_frame: true }, expect });
    check("ae_comp_settings (drop frame at 25 fps is refused)", refused(r) && /29\.97|59\.94/.test(JSON.stringify(r)), why(r).slice(0, 120));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { frame_rate: 29.97, drop_frame: true }, expect });
    check("ae_comp_settings (29.97 drop frame)", okWrite(r) && r.settings?.drop_frame === true, why(r));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { frame_rate: g0.fps, drop_frame: false }, expect });
    check("ae_comp_settings (frame rate back to the original)", okWrite(r), why(r));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { duration: { seconds: g0.duration + 4 } }, expect });
    check("ae_comp_settings (duration longer: the layer follows)", okWrite(r) && (r.duration_change?.extended_count ?? 0) >= 1, `extended ${r.duration_change?.extended_count}; ${why(r)}`);
    r = await call("ae_comp_settings", { comp_id: SG, settings: { work_area: { start: 1, duration: 2 } }, expect });
    check("ae_comp_settings (work area for the trim)", okWrite(r), why(r));
    r = await call("ae_comp_settings", { comp_id: SG, settings: { trim_to_work_area: true }, expect });
    check("ae_comp_settings (trim to work area: the comp is 2 s)", okWrite(r) && r.settings?.duration > 1.9 && r.settings?.duration < 2.1, `duration ${r.settings?.duration}; ${why(r)}`);
    r = await call("ae_comp_settings", { comp_id: SG, guides: [{ action: "add", orientation: "vertical", position: 25, position_type: "percentage", color: [1, 0, 0], pinned: true }], expect });
    gated("ae_comp_settings (26.5 guide colour, pinned and percentage position read back)", r, (x) => okWrite(x) && x.settings?.guides?.some((g) => g.position_kind === "percentage" && g.pinned === true), /After Effects 26\.5|no GuideOptions/i, why(r).slice(0, 120));
  }

  // ---------- wave 5: ae_create_comp, ae_project_items, ae_project_settings ----------
  {
    const made = await call("ae_create_comp", { mode: "new", name: "smoke_pi_comp", width: 640, height: 360, fps: 25, duration_frames: 50, bg_color: "#102030", unique_name: true, expect });
    check("ae_create_comp (new: applied, receipt matches)", made.applied === true && made.receipt?.matches === true, why(made));
    const compId = made.comps?.[0]?.id;
    check("ae_create_comp (read back as 2 s, 640x360)", made.comps?.[0]?.duration === 2 && made.comps?.[0]?.width === 640, `${made.comps?.[0]?.duration} s, ${made.comps?.[0]?.width}x${made.comps?.[0]?.height}`);
    const wide = await call("ae_create_comp", { mode: "new", name: "smoke_pi_par", width: 640, height: 360, fps: 25, duration: 2, pixel_aspect: 2, unique_name: true, expect });
    check("ae_create_comp (a valid pixel aspect of 2)", wide.applied === true && wide.receipt?.matches === true, why(wide));
    r = await call("ae_create_comp", { mode: "new", name: "smoke_pi_bad", width: 640, height: 360, fps: 25, duration: 2, pixel_aspect: 500, expect });
    check("ae_create_comp (a pixel aspect of 500 is refused before anything changes)", refused(r), why(r).slice(0, 100));
    const pngItem = (await call("ae_import_footage", { paths: [path.join(MEDIA, "a.png")], expect })).item_ids?.[0];
    const fromFoot = await call("ae_create_comp", { mode: "from_footage", item_id: pngItem, duration: 2, fps: 25, add_layer: true, unique_name: true, expect });
    check("ae_create_comp (from_footage: a still needs a duration and a frame rate, the footage becomes a layer)", fromFoot.applied === true && fromFoot.receipt?.matches === true, `${fromFoot.comps?.[0]?.name}; ${why(fromFoot)}`);
    const deepDry = await call("ae_create_comp", { mode: "duplicate", comp_id: compId, deep: true, expect });
    check("ae_create_comp (a deep duplicate is a dry run by default)", deepDry.dry_run === true && deepDry.would_create_total === 1, brief(deepDry).slice(0, 120));
    const dup = await call("ae_create_comp", { mode: "duplicate", comp_id: compId, deep: true, dry_run: false, expect });
    check("ae_create_comp (deep duplicate applied)", dup.applied === true && dup.receipt?.matches === true, why(dup));
    const planDry = await call("ae_project_items", { ops: [{ action: "create_folder", name: "smoke_pi_bin" }, { action: "move", item_ids: [compId], folder_path: "smoke_pi_bin/inner" }], expect });
    check("ae_project_items (a dry run by default)", planDry.dry_run === true && planDry.applied === false, brief(planDry).slice(0, 120));
    const applied = await call("ae_project_items", { ops: [{ action: "move", item_ids: [compId], folder_path: "smoke_pi_bin/inner" }, { action: "label", item_ids: [compId], label: 5 }, { action: "comment", item_ids: [compId], text: "smoke" }], dry_run: false, expect });
    check("ae_project_items (move into a new folder path, label, comment)", applied.applied === true && applied.receipt?.matches === true, why(applied));
    const renamed = await call("ae_project_items", { action: "rename", item_id: compId, name: "smoke_pi_renamed", dry_run: false, expect });
    check("ae_project_items (rename)", renamed.applied === true && renamed.receipt?.matches === true, why(renamed));
    r = await call("ae_project_items", { action: "organize", preset: "by_kind", dry_run: true, expect });
    check("ae_project_items (organize by kind, dry run)", r.dry_run === true && !r.__isError, brief(r).slice(0, 120));
    r = await call("ae_project_items", { action: "delete", item_ids: [OPS], dry_run: true, expect });
    check("ae_project_items (a comp used by nothing is deletable; the dry run lists it)", r.dry_run === true && !r.__isError, brief(r).slice(0, 120));
    const doomed = [compId, wide.comps?.[0]?.id, fromFoot.comps?.[0]?.id, ...(dup.comps ?? []).map((c) => c.id)].filter((x) => typeof x === "number");
    // remove_empty_folders from the project root would also delete __chroma_qa__ (the empty ownership folder qa/runner.js adds), so it works inside smoke_pi_bin only; the bin itself is then deleted by id.
    const binId = (applied.created_folders ?? []).find((fo) => fo.name === "smoke_pi_bin")?.id;
    const binOps = typeof binId === "number" ? [{ action: "remove_empty_folders", parent_id: binId }, { action: "delete", item_ids: [binId] }] : [];
    const cleanup = await call("ae_project_items", { ops: [{ action: "delete", item_ids: doomed }, ...binOps], dry_run: false, expect });
    check("ae_project_items (delete the comps made here, remove the empty folders inside the smoke bin, then the bin)", cleanup.applied === true && cleanup.receipt?.matches === true && typeof binId === "number", `bin ${binId}; ${why(cleanup)}`);

    const ps = await call("ae_project_settings", {});
    check("ae_project_settings (read)", ps.ok === true && typeof ps.bits_per_channel === "number" && Array.isArray(ps.list_color_profiles) && Array.isArray(ps.available_gpu_types) && Array.isArray(ps.probed?.not_found), `${ps.bits_per_channel} bpc, ${ps.list_color_profiles?.length} profiles, gpu ${(ps.available_gpu_types ?? []).join("/")}`);
    r = await call("ae_project_settings", { set: { bits_per_channel: ps.bits_per_channel }, expect });
    check("ae_project_settings (setting the current value is a no-op)", r.applied === true && r.no_op === true && r.receipt?.matches === true, brief(r).slice(0, 100));
    r = await call("ae_project_settings", { set: { working_space: "definitely not a profile" }, expect });
    check("ae_project_settings (a colour profile that is not in the list is refused)", refused(r), why(r).slice(0, 100));
  }

  // ---------- wave 5: ae_view (UI state: the playhead, selection, viewer options; no undo step, no checkpoint) ----------
  {
    const FX = WS.fx;
    r = await call("ae_view", { comp_id: FX, open: { in: "viewer" }, time: { time: 1 }, select: { layers: [{ name: "Backdrop" }] }, expect });
    const before = r.previous_state;
    check("ae_view (open in the viewer, playhead, select a layer)", r.applied === true && r.receipt?.matches === true, `${why(r)}; skipped ${JSON.stringify(r.skipped ?? [])}`);
    check("ae_view (the result carries the previous and the new state)", before !== undefined && r.state !== undefined, `dirty ${r.dirty_before} -> ${r.dirty_after}`);
    r = await call("ae_view", { comp_id: FX, time: { frame: 5 }, expect });
    check("ae_view (playhead by frame)", r.applied === true && r.receipt?.matches === true, why(r));
    r = await call("ae_view", { comp_id: FX, viewer_options: { checkerboards: true }, expect });
    gated("ae_view (viewer options)", r, (x) => x.applied === true && x.receipt?.matches === true, /no active viewer/i, why(r).slice(0, 120));
    r = await call("ae_view", { comp_id: FX, viewer_options: { checkerboards: false }, expect });
    gated("ae_view (viewer options back)", r, (x) => x.applied === true && x.receipt?.matches === true, /no active viewer/i, why(r).slice(0, 120));
    if (before) {
      r = await call("ae_view", { restore: before, expect });
      check("ae_view (restore the earlier state)", r.applied === true, `${why(r)}; skipped ${JSON.stringify(r.skipped ?? [])}`);
    } else {
      skip("ae_view (restore)", "the first call returned no previous_state");
    }
    r = await call("ae_view", { comp_id: FX, time: { time: 1, frame: 25 }, expect });
    check("ae_view (time and frame together are refused)", refused(r), why(r).slice(0, 100));
  }

  // ---------- wave 5: keyframes (ae_keyframes_transform, ae_detect_cuts, ae_get_keyframes), markers, per-key ease extras ----------
  {
    const K = WS.key;
    const POSK = [TRN, "ADBE Position"];
    r = await call("ae_set_property", {
      comp_id: K,
      layer: { name: "Keys" },
      path: POSK,
      keyframes: [{ time: 0, value: [100, 180], interp: "bezier" }, { time: 1, value: [300, 120], interp: "bezier" }, { time: 2, value: [500, 180], interp: "bezier" }],
      expect,
    });
    check("ae_set_property (three position keys for the keyframe tools)", okWrite(r), why(r));
    r = await call("ae_set_keyframe_ease", { comp_id: K, layer: { name: "Keys" }, path: POSK, ease: "easy_ease", expect });
    check("ae_set_keyframe_ease (easy ease before the transforms)", r.applied === true && r.receipt?.matches === true, why(r));
    const KT = { comp_id: K, targets: [{ layer: { name: "Keys" }, path: POSK }] };
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "shift", frames: 6 }, dry_run: true });
    check("ae_keyframes_transform (dry run)", r.ok === true && r.dry_run === true && (r.targets?.[0]?.moves?.length ?? 0) >= 3, `${r.targets?.[0]?.moves?.length} keys planned`);
    const kBefore = await call("ae_get_keyframes", { comp_id: K, layer: { name: "Keys" }, path: POSK });
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "shift", frames: 6 }, expect });
    check("ae_keyframes_transform (shift by 6 frames)", r.applied === true && r.receipt?.matches === true && r.keys_selected >= 3, `${r.keys_selected} keys moved; ${why(r)}`);
    const kAfter = await call("ae_get_keyframes", { comp_id: K, layer: { name: "Keys" }, path: POSK });
    check("ae_keyframes_transform (a shift keeps every key's ease)", kBefore.numKeys === kAfter.numKeys && JSON.stringify((kBefore.keys ?? []).map((k) => [k.in, k.out])) === JSON.stringify((kAfter.keys ?? []).map((k) => [k.in, k.out])), `${kAfter.numKeys} keys`);
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "reverse" }, expect });
    check("ae_keyframes_transform (reverse)", r.applied === true && r.receipt?.matches === true, why(r));
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "scale", factor: 1.5 }, expect });
    check("ae_keyframes_transform (scale time by 1.5)", r.applied === true && r.receipt?.matches === true, why(r));
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "move_to", time: 0.5 }, expect });
    check("ae_keyframes_transform (move the first key to 0.5 s)", r.applied === true && r.receipt?.matches === true, why(r));
    r = await call("ae_keyframes_transform", { ...KT, operation: { type: "copy_to", layer: { name: "Keys2" }, path: POSK, relative_value: true, at_time: 0.2 }, expect });
    check("ae_keyframes_transform (copy to another layer, relative value)", r.applied === true && r.receipt?.matches === true, why(r));
    r = await call("ae_keyframes_transform", { comp_id: K, keys: "selected", operation: { type: "reverse" }, dry_run: true });
    check("ae_keyframes_transform (keys: selected, with none selected, says so and touches nothing)", r.error === "no_match" || r.ok === true, String(r.error ?? "a selection was found"));
    r = await call("ae_remove_keyframes", { comp_id: K, layer: { name: "Keys" }, path: POSK, keys: "selected", dry_run: true, expect });
    check("ae_remove_keyframes (keys: selected, dry run)", r.error === "no_match" || r.dry_run === true || r.ok === true, String(r.error ?? `${r.count} selected`));
    // A real selection, made with ae_view: two keys selected, then the keyframe tools act on exactly those.
    r = await call("ae_view", { comp_id: K, select: { keys: [{ layer: { name: "Keys" }, path: POSK, indexes: [1, 2] }], deselect_others: true }, expect });
    check("ae_view (select two keys)", r.applied === true && r.receipt?.matches === true, `${why(r)}; skipped ${js(r.skipped)}`);
    r = await call("ae_keyframes_transform", { comp_id: K, keys: "selected", operation: { type: "shift", frames: 2 }, dry_run: true });
    gated("ae_keyframes_transform (keys: selected plans the two keys ae_view selected)", r, (x) => x.ok === true && x.keys_selected === 2, /No keys match that selection|keySelected/i, `keys_selected ${r.keys_selected}; ${r.error ?? ""}`);
    r = await call("ae_view", { comp_id: K, select: { properties: [{ layer: { name: "Keys2" }, path: POSK }], deselect_others: true }, expect });
    check("ae_view (select a property)", r.applied === true && r.receipt?.matches === true, `${why(r)}; skipped ${js(r.skipped)}`);
    r = await call("ae_view", { comp_id: K, open: { in: "layer", layer: { name: "Keys" } }, expect });
    gated("ae_view (open a layer in the layer panel)", r, (x) => x.applied === true && x.receipt?.matches === true, /no openInViewer|Layer panel|no active viewer/i, `${why(r)}; skipped ${js(r.skipped)}`);
    r = await call("ae_view", { select: { items: [WS.fx], deselect_others: true }, expect });
    check("ae_view (select a project item)", r.applied === true && r.receipt?.matches === true, `${why(r)}; skipped ${js(r.skipped)}`);

    // Per-key interpolation and label on the Keys2 copy.
    r = await call("ae_set_keyframe_ease", { comp_id: K, layer: { name: "Keys2" }, path: POSK, keys: [1], in_interp: "linear", out_interp: "bezier", label: 3, expect });
    gated("ae_set_keyframe_ease (per-key in and out interpolation, key label)", r, (x) => x.applied === true && x.receipt?.matches === true, /After Effects 22\.6|setLabelAtKey/i, js(r.receipt?.mismatches ?? why(r)));

    // Scene Edit Detection needs footage with cuts. A pre-comp layer is an AV layer with video and no cuts; a text layer is not one.
    r = await call("ae_detect_cuts", { comp_id: W.remap, layer: { name: "Clip" } });
    gated("ae_detect_cuts (list, on a pre-comp layer: no cuts)", r, (x) => x.ok === true && Array.isArray(x.cuts) && x.cut_count === 0, /doSceneEditDetection|SceneEditDetectionMode|AE 22\.3/i, `${r.cut_count} cuts in ${r.clip_duration}s`);
    r = await call("ae_detect_cuts", { comp_id: COMP, layer: { name: "Title" } });
    check("ae_detect_cuts (a text layer is refused: not an AV layer)", refused(r), why(r).slice(0, 120));
    skip("ae_detect_cuts (markers, split, split_precomp)", "the scratch project has no video footage with cuts, so these modes would find nothing to write");

    // Markers: edit, move, and the 16.0 fields (on the Layers comp, after its earlier marker checks).
    r = await call("ae_add_markers", { comp_id: LC, markers: [{ time: 2, comment: "edit me", duration: 0.5, label: 4, chapter: "Ch", url: "https://example.com" }], expect });
    check("ae_add_markers (setup for the edit)", okWrite(r), `${r.numMarkers} markers; ${why(r)}`);
    r = await call("ae_add_markers", { comp_id: LC, edit: [{ time: 2, move_to: 2.4, set: { comment: "moved" } }], dry_run: true });
    check("ae_add_markers (edit dry run)", r.ok === true && r.dry_run === true && r.edits?.[0]?.moved === true, js(r.edits?.[0], 140));
    r = await call("ae_add_markers", { comp_id: LC, edit: [{ time: 2, move_to: 2.4, set: { comment: "moved" } }], expect });
    check("ae_add_markers (edit and move)", okWrite(r) && r.edited === 1, why(r));
    const mk = await call("ae_get_markers", { comp_id: LC });
    const moved = (mk.markers ?? []).find((m) => Math.abs(m.time - 2.4) < 0.01);
    check("ae_add_markers (an edited marker keeps its other fields, the old time is empty)", Boolean(moved) && moved.comment === "moved" && moved.label === 4 && moved.chapter === "Ch" && moved.url === "https://example.com" && !(mk.markers ?? []).some((m) => Math.abs(m.time - 2) < 0.01), js(moved));
    r = await call("ae_add_markers", { comp_id: LC, markers: [{ time: 0.2, comment: "region", duration: 0.2, protected_region: true, frame_target: "_blank", params: { k: "v" } }], expect });
    check("ae_add_markers (protected_region, frame_target, params)", okWrite(r), why(r));
    const mk2 = await call("ae_get_markers", { comp_id: LC });
    const reg = (mk2.markers ?? []).find((m) => Math.abs(m.time - 0.2) < 0.01);
    check("ae_get_markers (the 16.0 fields read back)", Boolean(reg) && reg.protected_region === true && reg.frame_target === "_blank" && reg.params?.k === "v", js(reg));
  }

  // ---------- wave 5: text (ae_set_text typography, ae_text_animator selectors), masks, effects, shapes ----------
  {
    const T = WS.text;
    const tl = { name: "W5Text" };
    r = await call("ae_set_text", { comp_id: T, layer: tl, style: { caps: "all", kerning: "optical", ligature: false }, paragraph: { justify: "full_center", space_after: 6 }, expect });
    check("ae_set_text (typography and paragraph options)", okWrite(r), why(r));
    r = await call("ae_set_text", { comp_id: T, layer: tl, style: { font: "NoSuchFont-Regular" }, expect });
    if (refused(r)) check("ae_set_text (an unknown font is refused with near matches)", FONT_REFUSAL.test(JSON.stringify(r)), why(r).slice(0, 140));
    else skip("ae_set_text (an unknown font is refused with near matches)", "this AE did not check the font (it has no app.fonts, which needs AE 24.0)");
    r = await call("ae_set_text", { comp_id: T, layer: tl, paragraphs: [{ index: 0, style: { fillColor: [1, 0, 0] } }], expect });
    check("ae_set_text (a paragraph's character style)", okWrite(r), why(r));

    r = await call("ae_text_animator", { comp_id: T, layer: tl, name: "Wiggle", properties: { position: [0, 20, 0], rotation: 8, stroke_width: 2, skew: 10 }, selector: { type: "wiggly", max_amount: 100, min_amount: -100, wiggles_per_second: 3, correlation: 40, lock_dimensions: false, based_on: "characters" }, expect });
    check("ae_text_animator (wiggly selector): LIVE CHECK the child match names", r.applied === true && r.receipt?.matches === true, `${JSON.stringify(r.selectors?.[0]?.fields)}; ${why(r)}`);
    r = await call("ae_text_animator", { comp_id: T, layer: tl, properties: { opacity: 0 }, selector: { type: "range", units: "index", start: 0, end: 3, mode: "add", shape: "round" }, more_selectors: [{ type: "expression", expression: "Math.sin(textIndex * 0.8) * 50 + 50" }], reveal: { property: "end", from: 0, to: 12, start_time: 0, duration: 1 }, expect });
    check("ae_text_animator (range selector in index units plus an expression selector)", r.applied === true && r.receipt?.matches === true, `${JSON.stringify(r.selectors?.map((s) => s.type))}; ${why(r)}`);
    r = await call("ae_text_animator", { comp_id: T, layer: tl, properties: { opacity: 50 }, selector: { type: "range", shape: "round", smoothness: 50 }, expect });
    check("ae_text_animator (smoothness with a round shape is refused before anything changes)", refused(r) && /smoothness applies only to the square shape/i.test(why(r)), why(r).slice(0, 140));
    r = await call("ae_text_animator", { comp_id: T, layer: tl, properties: { opacity: 100 }, grouping: { anchor_point_grouping: "word", grouping_alignment: [0, 0] }, expect });
    check("ae_text_animator (More Options: grouping)", r.applied === true && r.receipt?.matches === true, JSON.stringify(r.grouping));
    r = await call("ae_text_animator", { comp_id: T, layer: tl, variable_axes: [{ tag: "wght", value: 700 }], expect });
    gated("ae_text_animator (a variable font axis, AE 26)", r, (x) => x.applied === true && x.receipt?.matches === true, /After Effects 26\.0|addVariableFontAxis|not a variable font/i, js(r.variable_axes ?? r.message ?? r.error));

    // Masks: a second mask, its attributes, a duplicate and a move in one call.
    r = await call("ae_mask", { comp_id: OPS, layer: { name: "OpA" }, add: [{ name: "First", shape: "ellipse", box: [0, 0, 80, 80] }, { name: "Edge", shape: "rect", box: [0, 0, 60, 60] }], expect });
    check("ae_mask (add two)", okWrite(r) && (r.masks ?? []).length >= 2, JSON.stringify(r.masks?.map((m) => m.name)));
    r = await call("ae_mask", { comp_id: OPS, layer: { name: "OpA" }, set: [{ mask: { name: "Edge" }, feather_falloff: "linear", motion_blur: "on", color: [0, 1, 0], locked: false }], duplicate: [{ mask: { name: "Edge" }, count: 1 }], move_to: [{ mask: { name: "Edge" }, index: 1 }], expect });
    check("ae_mask (attributes, duplicate, move_to)", okWrite(r) && (r.duplicated ?? []).length === 1, `${JSON.stringify(r.duplicated)} order ${JSON.stringify(r.masks?.map((m) => m.name))} unsupported ${JSON.stringify(r.unsupported)} warnings ${JSON.stringify(r.warnings)}`);

    // Effects: stack order, duplicate, a popup by label, a layer style.
    const FX = WS.fx;
    await call("ae_create_layer", { comp_id: FX, type: "solid", name: "FxPlate", color: [0.6, 0.6, 0.6], expect });
    r = await call("ae_add_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: "ADBE Gaussian Blur 2", name: "Blur A", params: [{ param: "Blurriness", value: 3 }], expect });
    check("ae_add_effect (Blur A)", okWrite(r), why(r));
    r = await call("ae_add_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: "ADBE Tint", name: "Tint B", expect });
    check("ae_add_effect (Tint B)", okWrite(r), why(r));
    r = await call("ae_set_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: { name: "Tint B" }, move_to: 1, expect });
    check("ae_set_effect (move_to: Tint B to the top of the stack)", okWrite(r) && r.effect?.index === 1, `index ${r.effect?.index}; ${why(r)}`);
    r = await call("ae_set_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: { name: "Blur A" }, duplicate: 1, expect });
    check("ae_set_effect (duplicate: the copy is located)", okWrite(r) && r.duplicate_located === true, `located ${r.duplicate_located}; scope ${r.expression_scan_scope}; ${why(r)}`);
    r = await call("ae_add_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: "ADBE Gaussian Blur 2", name: "Blur H", params: [{ param: "Blur Dimensions", value: "Horizontal" }], expect });
    gated("ae_add_effect (a popup set by its label, AE 26.0)", r, (x) => okWrite(x), /reports no menu labels/i, why(r).slice(0, 140));
    r = await call("ae_add_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: "dropShadow", expect });
    gated("ae_add_effect (a layer style, or told to use a preset)", r, (x) => x.applied === true, /not addable by script/i, why(r).slice(0, 140));

    // Shapes: stroke details and gradient fills, duplicate, move, then the path operators.
    await call("ae_create_layer", { comp_id: FX, type: "shape", name: "Shapes", expect });
    r = await call("ae_shape", { comp_id: FX, layer: { name: "Shapes" }, add: [{ type: "rect", name: "Dashed", size: [200, 80], stroke: { color: [1, 1, 1], width: 6, line_cap: "round", line_join: "round", dashes: [{ dash: 12, gap: 8 }], taper: { start_length: 20 } }, gradient_fill: { type: "radial", start_point: [0, 0], end_point: [100, 0] } }], expect });
    check("ae_shape (stroke cap, join, dashes, taper and a radial gradient fill)", okWrite(r), why(r));
    r = await call("ae_shape", { comp_id: FX, layer: { name: "Shapes" }, duplicate: [{ name: "Dashed", count: 2 }], expect });
    check("ae_shape (duplicate a group twice, located)", okWrite(r) && r.duplicate_located === true, `located ${r.duplicate_located}; ${why(r)}`);
    r = await call("ae_shape", { comp_id: FX, layer: { name: "Shapes" }, move: [{ index: 1, to: 2 }], expect });
    check("ae_shape (move a group)", okWrite(r), why(r));
    for (const [operator, extra] of [
      ["merge", { merge: { mode: "add" } }],
      ["round_corners", { round_corners: { radius: 20 } }],
      ["zig_zag", { zig_zag: { size: 6, ridges_per_segment: 4 } }],
      ["pucker_bloat", { pucker_bloat: { amount: 25 } }],
      ["twist", { twist: { angle: 45 } }],
      ["wiggle_paths", { wiggle_paths: { size: 5, random_seed: 3 } }],
      ["wiggle_transform", { wiggle_transform: { wiggles_per_second: 2 } }],
    ]) {
      r = await call("ae_path_operator", { comp_id: FX, layer: { name: "Shapes" }, group: { index: 1 }, operator, ...extra, expect });
      check(`ae_path_operator (${operator})`, okWrite(r), why(r));
    }
    r = await call("ae_add_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: "ADBE Set Matte3", name: "Matte S", expect });
    check("ae_add_effect (Set Matte, for the layer picker)", okWrite(r), why(r));
    r = await call("ae_set_effect", { comp_id: FX, layer: { name: "FxPlate" }, effect: { name: "Matte S" }, params: [{ param: 1, value: { layer: { name: "Backdrop" }, stage: "masks" } }], expect });
    gated("ae_set_effect (a layer picker with a stage, AE 26.5)", r, (x) => okWrite(x), /After Effects 26\.5|setInputLayerAndStage/i, why(r).slice(0, 140));
  }

  // ---------- wave 5: 3D layers and cameras (lights, meshes, vertical text, focus options) ----------
  {
    const D = WS.d3;
    r = await call("ae_create_layer", { comp_id: D, type: "solid", name: "W5 HDRI", color: [0.5, 0.5, 0.5], expect });
    check("ae_create_layer (a solid to use as the light source)", okWrite(r), why(r));
    r = await call("ae_create_layer", { comp_id: D, type: "light", name: "W5 Env", light_type: "environment", light_source: { name: "W5 HDRI" }, light_options: { intensity: 80 }, expect });
    gated("ae_create_layer (environment light with a source layer)", r, (x) => x.applied === true && Array.isArray(x.receipt?.mismatches), /Environment lights need After Effects 24\.3/i, why(r).slice(0, 140));
    r = await call("ae_create_layer", { comp_id: D, type: "light", name: "W5 Spot", light_type: "spot", light_options: { cone_angle: 40, casts_shadows: true, shadow_darkness: 50 }, expect });
    check("ae_create_layer (spot light options read back)", okWrite(r), why(r));
    r = await call("ae_create_layer", { comp_id: D, type: "mesh", name: "W5 Cube", mesh_type: "cube", mesh_options: { width: 300, height: 200, depth: 100 }, bevel_options: { radius: 5, sides: 3 }, expect });
    gated("ae_create_layer (a cube mesh, AE 26.3)", r, (x) => okWrite(x), /Parametric mesh layers need After Effects 26\.3|ParametricMeshType/i, why(r).slice(0, 140));
    r = await call("ae_create_layer", { comp_id: D, type: "text", name: "W5 Vertical", text: "ABC", orientation: "vertical", font: "ArialMT", expect });
    gated("ae_create_layer (vertical text with a checked font, AE 24.2)", r, (x) => x.applied === true, /Vertical (box )?text needs After Effects 24\.2/i, why(r).slice(0, 140));
    r = await call("ae_create_layer", { comp_id: D, type: "text", name: "W5 BadFont", text: "x", font: "NoSuchFont-Regular", expect });
    if (refused(r)) check("ae_create_layer (an unknown font is refused before anything changes)", FONT_REFUSAL.test(JSON.stringify(r)), why(r).slice(0, 140));
    else skip("ae_create_layer (an unknown font is refused before anything changes)", "this AE did not check the font (it has no app.fonts, which needs AE 24.0)");
    r = await call("ae_camera_rig", { comp_id: D, name: "W5 Cam", expect });
    check("ae_camera_rig (a new camera)", okWrite(r), why(r));
    r = await call("ae_camera_rig", { comp_id: D, camera: { name: "W5 Cam" }, lens: { focal_length: 35 }, depth_of_field: true, focus: { aperture: 20 }, expect });
    check("ae_camera_rig (retune an existing camera: lens, depth of field, aperture)", okWrite(r), why(r));
    r = await call("ae_camera_rig", { comp_id: D, camera: { name: "W5 Cam" }, lens: { focal_length: 35 }, expect });
    check("ae_camera_rig (the same retune again is a no-op)", r.no_op === true, brief(r).slice(0, 100));
    r = await call("ae_camera_rig", { comp_id: D, camera: { name: "W5 Cam" }, focus: { focus_area_width: 40, near_far_blur_multiplier: 2 }, expect });
    gated("ae_camera_rig (26.3 focus options, or reported absent in the warnings)", r, (x) => x.applied === true && (x.probe?.focus_area_width !== undefined || /focus_area_width property/.test(JSON.stringify(x.warnings))), /26\.3|focus_area_width/i, JSON.stringify({ probe: r.probe, warnings: r.warnings }).slice(0, 160));
    r = await call("ae_scene_3d_report", { comp_id: D });
    check("ae_scene_3d_report (lights and models are listed)", Array.isArray(r.lights) && r.lights.some((l) => l.name === "W5 Spot") && Array.isArray(r.models), `${(r.lights ?? []).length} light(s), ${(r.models ?? []).length} model(s); ${JSON.stringify(r.warnings)?.slice(0, 80)}`);
    r = await call("ae_describe_comp", { comp_id: D });
    check("ae_describe_comp (a 3D comp with lights, a camera and text)", r.ok === true && r.read_only === true, `${r.comp?.num_layers} layers; ${r.summary?.slice(0, 80)}`);
    r = await call("ae_annotate_frame", { comp_id: D, time: 0 });
    check("ae_annotate_frame (a 3D comp)", r.ok === true && fs.existsSync(String(r.path)), `${r.frames?.[0]?.layer_count} layer(s) drawn`);
  }

  // ---------- wave 5: reads, expressions, fonts, footage (ae_get_layer_full, ae_find_layers, ae_validate_expressions, ae_purge_unused, ae_fonts, ae_import_footage, ae_replace_footage, ae_brief) ----------
  {
    const T = WS.text;
    r = await call("ae_get_layer_full", { comp_id: T, layer: { name: "W5Text" }, include: ["transform", "text"], meta: true, text_full: true, bounds: { points_to_comp: [[0, 0]] } });
    check("ae_get_layer_full (meta: the transform properties carry their value type)", /value_type/.test(JSON.stringify(r.transform ?? {})), JSON.stringify(r.transform ?? {}).slice(0, 100));
    check("ae_get_layer_full (bounds: the rectangle and four corners)", Boolean(r.bounds?.rect) && (r.bounds?.corners_comp ?? []).length === 4, js(r.bounds, 140));
    r = await call("ae_find_layers", { comp_id: WS.d3, type: "model_3d" });
    check("ae_find_layers (type model_3d is accepted)", typeof r.total_matched === "number", `matched ${r.total_matched}`);
    r = await call("ae_validate_expressions", { comp_id: OPS, fix: { find: "__no_such_text__", replace: "x" } });
    check("ae_validate_expressions (fix without apply is a project-wide dry run)", r.dry_run === true && /whole project/.test(String(r.scope_note)), String(r.scope_note).slice(0, 100));
    r = await call("ae_purge_unused", { consolidate: true });
    check("ae_purge_unused (consolidate duplicate footage: a dry run lists the groups)", r.mode === "consolidate" && typeof r.group_count === "number", `${r.group_count} group(s)`);
    r = await call("ae_purge_unused", { reduce_to_comp_ids: [WS.fx] });
    check("ae_purge_unused (reduce the project to one comp: a dry run)", r.mode === "reduce" && r.keep_comps?.[0]?.id === WS.fx, `${r.remove_count} item(s) would go`);
    r = await call("ae_get_essential_graphics", { comp_id: WS.fx });
    check("ae_get_essential_graphics (a comp with no controllers)", Array.isArray(r.controllers), `${r.controllers?.length} controllers`);
    skip("ae_set_essential_graphics (set_media, and add of a media slot)", "needs a template comp with a footage layer, a parent comp and AE 22 media replacement; the scratch project has no such pair");
    r = await call("ae_batch_set", { comp_id: OPS, ops: [{ layer: { name: "OpE" }, path: OPAC, expression: "wiggle(1, 5)" }], expect });
    check("ae_batch_set (an expression that evaluates clean)", r.ok === true && r.matches === true, (r.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; "));
    r = await call("ae_batch_set", { comp_id: OPS, ops: [{ layer: { name: "OpE" }, path: OPAC, expression: "wigle(1, 5)" }], expect });
    check("ae_batch_set (a broken expression is a mismatch)", r.matches === false && (r.mismatches ?? []).some((m) => /expression_error/.test(String(m.path))), (r.mismatches ?? []).slice(0, 2).map((m) => m.path).join("; "));
    await call("ae_set_property", { comp_id: OPS, layer: { name: "OpE" }, path: OPAC, expression: "", expression_enabled: false, expect });
    r = await call("ae_render_templates", { action: "save", kind: "render_settings", name: "chroma-smoke-w5", expect });
    check("ae_render_templates (save without an item is refused)", refused(r), why(r).slice(0, 100));
    skip("ae_render_templates (save, a real template)", "a saved template goes into the user's After Effects preferences, which the smoke does not touch");

    // Fonts: search, check (with glyphs), a replace dry run, the composed lines, a captions font check, the preflight glyph check.
    r = await call("ae_fonts", { action: "search", query: "arial", page_size: 5 });
    check("ae_fonts (search)", r.available === true && Array.isArray(r.fonts) && r.fonts.length >= 1 && typeof r.total_matches === "number", `${r.total_matches} matches, scanned ${r.scanned}${r.scan_truncated ? " (cut short)" : ""}`);
    const psName = r.fonts?.[0]?.postscript;
    if (psName) {
      r = await call("ae_fonts", { action: "check", fonts: [psName, "No-Such-Font-Xyz"], text: "Sehir ğıİ" });
      check("ae_fonts (check: exists, near matches for a missing one, glyph coverage)", r.available === true && r.checked?.[0]?.exists === true && r.checked?.[1]?.exists === false && Array.isArray(r.checked?.[1]?.candidates), `problems ${r.problems}; glyphs ${JSON.stringify(r.checked?.[0]?.glyphs?.supported)}`);
      r = await call("ae_fonts", { action: "replace", from: psName, to: psName });
      check("ae_fonts (replace, dry run)", r.dry_run === true && r.applied === false && (r.ok !== false || r.error === "unsupported"), `${r.affected_layers ?? "-"} layers; ${r.reason ?? ""}`);
      r = await call("ae_fonts", { action: "replace", from: psName, to: "ArialMT", dry_run: false, expect });
      check("ae_fonts (replace on an unsaved or dirty project is refused for want of a checkpoint)", r.error === "checkpoint_required" || r.no_op === true || r.ok === false, `${r.error ?? (r.applied ? "applied" : "no-op")}: ${String(r.message ?? "").slice(0, 100)}`);
    } else {
      skip("ae_fonts (check, replace)", "ae_fonts search found no Arial to use (no app.fonts, which needs AE 24.0)");
    }
    r = await call("ae_measure_text", { comp_id: W.caps, lines: true, max_lines: 2 });
    check("ae_measure_text (lines: AE's composed lines)", (r.layers ?? []).length >= 1 && r.layers.every((l) => l.composed && (l.composed.supported === false || (Array.isArray(l.composed.lines) && l.composed.flags))), `${r.layers?.[0]?.composed?.line_count ?? "n/a"} lines on ${r.layers?.[0]?.name}`);
    r = await call("ae_captions", { comp_id: WS.text, name_prefix: "FontProbe", transcript: { text: "1\n00:00:00,400 --> 00:00:01,000\nHi\n" }, style: { font: "No-Such-Font-Xyz" }, expect });
    if (refused(r)) check("ae_captions (an unknown font is refused before anything is written)", FONT_REFUSAL.test(JSON.stringify(r)), why(r).slice(0, 100));
    else skip("ae_captions (an unknown font is refused before anything is written)", "this AE did not check the font (it has no app.fonts, which needs AE 24.0)");
    r = await call("ae_preflight", { comp_ids: [WS.text] });
    check("ae_preflight (the glyph check ran, or says why not)", r.ok !== false && r.checked?.glyphs !== undefined, `${r.checked?.glyphs}`);

    // Footage: reload, placeholders, import_as on a file that is not layered.
    const fi = await call("ae_import_footage", { paths: [path.join(MEDIA, "b.png")], expect });
    const footId = fi.item_ids?.[0];
    r = await call("ae_replace_footage", { action: "reload", item_ids: [footId], expect });
    check("ae_replace_footage (reload)", r.applied === true && Array.isArray(r.reloaded) && r.reloaded.includes(footId), brief(r).slice(0, 160));
    r = await call("ae_import_footage", { placeholders: [{ name: "QA Plate", width: 320, height: 180, fps: 24, duration: 2 }], expect });
    check("ae_import_footage (a placeholder)", r.applied === true && Array.isArray(r.placeholder_ids) && r.placeholder_ids.length === 1 && r.receipt?.matches === true, brief(r).slice(0, 160));
    // A placeholder is missing footage: take it out so the preflight, collect and relink steps later see a clean project.
    if ((r.placeholder_ids ?? []).length > 0) {
      const del = await call("ae_project_items", { action: "delete", item_ids: r.placeholder_ids, dry_run: false, expect });
      check("ae_project_items (delete the placeholder again)", del.applied === true && del.receipt?.matches === true, why(del));
    }
    r = await call("ae_import_footage", { paths: [path.join(MEDIA, "a.png")], import_as: "comp", expect });
    check("ae_import_footage (import_as comp on a PNG is refused, nothing is imported)", refused(r) || /can't be imported as|canImportAs/.test(JSON.stringify(r)), brief(r).slice(0, 160));
    skip("ae_import_footage (import_as comp from a PSD or AI file, and a whole project)", "the scratch project has no layered file, and a script cannot write a PSD");

    // Brief swatches: a generated .ase, preview only (nothing is saved without confirm).
    const ase = path.join(MEDIA, "swatches.ase");
    fs.writeFileSync(ase, aseFile([[1, 0, 0], [0, 0.5, 1]]));
    r = await call("ae_brief", { import_swatches: { path: ase } });
    check("ae_brief (import_swatches: the colours are listed, nothing is saved)", r.ok === true && r.saved === false && (r.swatch_import?.colors ?? []).map((c) => String(c).toLowerCase()).includes("#ff0000"), JSON.stringify(r.swatch_import?.colors));
  }

  // The agent's own guarded writes above must not show up as the user's changes.
  r = await call("ae_session_changes", {});
  if (r.tracking_enabled === false) skip("ae_session_changes (lists)", "session tracking is off on this server (tracking_enabled is false)");
  else check("ae_session_changes (lists)", Array.isArray(r.interrupted_ops) && Array.isArray(r.acknowledged_interrupted_ops), `changes ${r.changes === null ? "none (no baseline)" : JSON.stringify(r.changes?.changed)}, ${r.interrupted_ops?.length} interrupted`);

  r = await call("ae_save", { expect });
  check("ae_save", r.applied && r.receipt?.matches !== false && Boolean(r.backup_path), path.basename(String(r.backup_path)));

  // The project is saved and clean now, which aerender needs. Nothing here writes.
  r = await call("ae_audio_analyze", { comp_id: AUDIO_COMP, expect, wait_seconds: 120 });
  check(
    "ae_audio_analyze (aerender)",
    r.ok && r.state === "done" && Math.abs((r.tempo?.bpm ?? 0) - 120) < 3,
    `${r.state ?? r.error}: ${r.tempo?.bpm} BPM, ${r.onsets?.length} onsets, ${r.beats?.length} beats ${r.message ?? ""}`
  );
  r = await call("ae_audio_analyze", { audio_path: CLICKS_WAV });
  check("ae_audio_analyze (file)", r.ok && Math.abs((r.tempo?.bpm ?? 0) - 120) < 3 && r.onsets?.length === 8, `${r.tempo?.bpm} BPM, ${r.onsets?.length} onsets`);
  r = await call("ae_export_mogrt", { comp_id: PRE, path: path.join(RENDER, "qa_template.mogrt"), overwrite: true, expect });
  // Space Grotesk is installed locally, not from Adobe Fonts, and AE would open a modal "fonts were not synced" dialog
  // during the export. Called without allow_font_dialog the tool must refuse and name the font; that refusal is the pass.
  // An Adobe Fonts font or a comp without local fonts exports for real, which passes as well.
  if (r.ok && r.file?.size > 0 && r.file?.fresh === true) {
    check("ae_export_mogrt", true, `${r.controllers} controller(s), ${r.file?.size} bytes`);
  } else if (/not from Adobe Fonts/i.test(why(r))) {
    check("ae_export_mogrt", /Space Grotesk|SpaceGrotesk/i.test(why(r)) && /allow_font_dialog/.test(why(r)), `refused before the export, as designed: ${why(r).slice(0, 160)}`);
  } else {
    check("ae_export_mogrt", false, `${r.controllers ?? "?"} controller(s), ${r.file?.size ?? "no file"} ${why(r)}`);
  }

  r = await call("ae_set_property", { comp_id: COMP, layer: dot, path: opacity, value: 90, expect });
  check("ae_set_property (after save)", r.applied && r.checkpoint?.status === want("created") && !r.checkpoint?.unsaved_changes_not_included, cpNote(r));

  r = await call("ae_checkpoint_create", { expect, label: "smoke manual" });
  check("ae_checkpoint_create", r.applied && fs.existsSync(String(r.checkpoint_path)), path.basename(String(r.checkpoint_path)));

  r = await call("ae_checkpoint_list", { expect });
  const autos = (r.checkpoints ?? []).filter((c) => c.auto).length;
  const manuals = (r.checkpoints ?? []).filter((c) => !c.auto).length;
  check("ae_checkpoint_list", autos === (autoOn ? 2 : 0) && manuals === 1, `${autos} auto, ${manuals} manual`);

  // ---------- reads ----------
  r = await call("ae_status");
  check("ae_status", /Smoke\.aep$/i.test(String(r.project_path)), `dirty ${r.dirty}`);
  r = await call("ae_brief", { set: { goal: "QA smoke", feel: ["clean"] }, expect });
  check("ae_brief", r.saved && fs.existsSync(String(r.brief_path)) && !r.missing?.includes("goal"), `${path.basename(String(r.brief_path))}, ${r.missing?.length} missing`);
  // Read only: the taste is the user's own, across projects.
  r = await call("ae_taste");
  check("ae_taste", r.ok && typeof r.taste?.allow_linear_non_motion === "boolean", JSON.stringify(r.taste));
  r = await call("ae_get_project", { depth: 2 });
  check("ae_get_project", JSON.stringify(r).includes("Smoke"));
  r = await call("ae_get_comp", { comp_id: COMP });
  check("ae_get_comp", (r.layers ?? []).length === 3, `${(r.layers ?? []).length} layers`);
  r = await call("ae_get_layer_props", { comp_id: COMP, layer: dot, path: opacity, depth: 1 });
  check("ae_get_layer_props", JSON.stringify(r).includes("90"), "opacity reads 90");
  r = await call("ae_get_layer_full", { comp_id: COMP, layer: { name: "Title" } });
  check("ae_get_layer_full", JSON.stringify(r).includes("Smoke test"), "text reads back");
  r = await call("ae_find_layers", { comp_id: COMP, name_contains: "dot" });
  check("ae_find_layers", r.total_matched === 1, `matched ${r.total_matched}`);
  r = await call("ae_list_effects", { filter: "Gaussian" });
  check("ae_list_effects", JSON.stringify(r).includes("Gaussian Blur"), `${r.total_installed} installed`);
  r = await call("ae_validate_expressions", { comp_id: COMP });
  check("ae_validate_expressions", !r.__isError && !r.__error && r.error_count === 0, `${r.total_expressions} expressions`);
  const fp = await call("ae_comp_fingerprint", { comp_id: COMP });
  check("ae_comp_fingerprint", typeof fp.id === "string", `${fp.summary?.propertyCount} properties`);
  await call("ae_set_property", { comp_id: COMP, layer: dot, path: opacity, value: 70, expect });
  r = await call("ae_comp_diff", { before_id: fp.id });
  check("ae_comp_diff", (r.changed ?? []).length >= 1, `${(r.changed ?? []).length} changed`);
  r = await call("ae_snapshot_frame", { comp_id: COMP, time: 1, max_size: 320 });
  check("ae_snapshot_frame", r.ok && r.width === 320 && fs.existsSync(String(r.full_path)), `${r.width}x${r.height}`);
  r = await call("ae_compare_frames", { comp_id: COMP, times: [0, 1.5] });
  check("ae_compare_frames", !r.__isError && !r.__error, "two frames compared");
  r = await call("ae_contact_sheet", { comp_id: COMP, count: 6 });
  check("ae_contact_sheet", r.ok && r.frames?.length === 6 && r.flagged_frames?.length === 0, `${r.width}x${r.height}`);
  r = await call("ae_motion_graph", { comp_id: COMP, layer: dot, path: ["ADBE Transform Group", "ADBE Position"] });
  const profiles = (r.segments ?? []).map((s) => s.profile);
  check("ae_motion_graph", r.ok && profiles.length === 2 && profiles.every((p) => p === "ease in-out"), `profiles: ${profiles.join(", ")}`);
  r = await call("ae_render_queue_status");
  check("ae_render_queue_status", JSON.stringify(r).includes("Smoke"));
  r = await call("ae_quarantine_status");
  check("ae_quarantine_status", r.quarantined === false, `${r.count} quarantined`);
  r = await call("ae_dialogs", { screenshots: false });
  check("ae_dialogs", !r.__isError && !r.__error, `${(r.dialogs ?? []).length} dialog(s)`);
  r = await call("ae_diagnostics", { log_lines: 20, include_dialogs: false });
  check("ae_diagnostics", r.ok && fs.existsSync(String(r.path)) && r.summary?.ae_answered === true, path.basename(String(r.path)));
  r = await call("ae_list_panels", { filter: "Chroma" });
  check("ae_list_panels", JSON.stringify(r).includes("london.chroma.aemcp"));
  r = await call("ae_ui_screenshot");
  check(
    "ae_ui_screenshot",
    (r.ok && r.width > 300 && fs.existsSync(String(r.path))) || r.error === "ae_minimized",
    r.ok ? `${r.width}x${r.height}` : `${r.error} (AE is minimized)`
  );

  // ---------- wave 3: loudness (the Audio comp holds the 120 BPM click track) ----------
  // The comp measure renders audio with aerender, so the project must be saved and clean first.
  await call("ae_save", { expect });
  if (audioTemplate) {
    r = await call("ae_loudness_check", { comp_id: AUDIO_COMP, expect: { ...expect, comp_id: AUDIO_COMP }, wait_seconds: 110 });
    check(
      "ae_loudness_check (comp, aerender)",
      r.ok === true && r.state === "done" && r.source?.sample_rate > 0 && typeof r.verdict === "object",
      `${r.state ?? r.error}: ${r.measurement?.integrated_lufs} LUFS, true peak ${r.measurement?.true_peak_dbtp} dBTP ${r.message ?? ""}`
    );
  } else {
    skip("ae_loudness_check (comp, aerender)", "no AIFF 48 kHz output module template (ae_render_templates audio_template_found is false)");
  }
  r = await call("ae_loudness_check", { audio_path: CLICKS_WAV, standard: "streaming" });
  check("ae_loudness_check (file)", r.ok === true && r.source?.sample_rate === 48000 && typeof r.verdict === "object", `${r.measurement?.integrated_lufs} LUFS, gain needed ${r.verdict?.gain_needed_db} dB`);
  {
    const lx = { ...expect, comp_id: AUDIO_COMP };
    r = await call("ae_loudness_apply", { comp_id: AUDIO_COMP, gain_db: -3, expect: lx });
    check("ae_loudness_apply (-3 dB)", okWrite(r) && (r.layers ?? []).length >= 1, `${(r.layers ?? []).map((l) => l.name).join(", ")}; ${why(r)}`);
    r = await call("ae_loudness_apply", { comp_id: AUDIO_COMP, gain_db: 3, expect: lx });
    check("ae_loudness_apply (+3 dB, back)", okWrite(r), why(r));
    // The click layer starts at 0 and ends with the comp, so the default comp-scope fade fits.
    r = await call("ae_loudness_apply", { comp_id: AUDIO_COMP, fade_in: 0.5, fade_out: 0.5, expect: lx });
    check("ae_loudness_apply (fades)", okWrite(r), why(r));
    r = await call("ae_loudness_apply", { comp_id: AUDIO_COMP, gain_db: 0, fade_in: 0.25, fade_scope: "layer", expect: lx });
    check("ae_loudness_apply (fade, layer scope)", okWrite(r), why(r));
    r = await call("ae_loudness_apply", { comp_id: AUDIO_COMP, gain_db: 12, true_peak_db: -3, true_peak_max_db: -1, expect: lx });
    check("ae_loudness_apply (a gain over the true-peak ceiling is refused)", r.ok === false && r.error === "true_peak_conflict", String(r.error));
  }

  // ---------- background render (needs a saved, clean project) ----------
  await call("ae_save", { expect });
  const om = await call("ae_run_jsx", {
    mutates: false,
    label: "qa smoke: output module templates",
    code: "var t = app.project.renderQueue.item(1).outputModule(1).templates; var out = []; for (var i = 0; i < t.length; i++) out.push(t[i]); return out;",
  });
  const pngTemplate = (om.result ?? []).find((t) => /png/i.test(t));
  r = await call("ae_aerender_start", {
    expect,
    comp_name: "Smoke",
    output_path: path.join(RENDER, pngTemplate ? "smoke_[#####].png" : "smoke.avi"),
    start_frame: 0,
    end_frame: 4,
    ...(pngTemplate ? { output_module_template: pngTemplate } : {}),
  });
  let job = r;
  for (let i = 0; i < 150 && r.job_id; i++) {
    job = await call("ae_aerender_status", { job_id: r.job_id });
    if (job.state && !/running|starting|queued/i.test(job.state)) break;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  const frames = fs.existsSync(RENDER) ? fs.readdirSync(RENDER).filter((f) => /^smoke/i.test(f)) : [];
  check(
    "ae_aerender_start/status",
    job.state === "succeeded" && job.exit_code === 0 && frames.length === (pngTemplate ? 5 : 1),
    `${job.state}, ${frames.length} file(s)`
  );

  // The render read back by AE itself, against the job's five frames.
  if (job.state === "succeeded") {
    const v = await call("ae_verify_render", { job_id: r.job_id, expect });
    check(
      "ae_verify_render",
      v.ok && v.matches === true && v.render?.frames === 5 && v.imported_item === null,
      (v.checks ?? []).map((c) => `${c.what} ${JSON.stringify(c.actual)}${c.ok ? "" : " (expected " + JSON.stringify(c.expected) + ")"}`).join(", ") || String(v.message ?? v.error)
    );
  }

  // ======================================================================
  // Waves 1-3, late block (not run live yet, see the note above the first waves 1-3 step).
  // These steps rewrite the render queue, render for a while, close and reopen the project or drop the undo history,
  // so they go last, in this order. Each one leaves the project saved and open for the next, or is the last of its kind.
  // Wave 5 adds to it: ae_fonts replace (right after the first save), a batch plan with queue items (in the render queue block),
  // the queue item flag, aerender -rqindex and queue item removal (before the render batch), and ae_save save_as / increment
  // (last, between ae_project_session new and close: they move the open project, so nothing after them may use Smoke.aep).
  // ======================================================================
  const smokeKey = (await call("ae_get_project", { type: "comp", name_contains: "Smoke Key" })).items?.find((i) => i.name === "Smoke Key");
  const firstFrame = job.state === "succeeded" && pngTemplate ? frames.slice().sort()[0] : undefined; // smoke_00000.png of the aerender step
  r = await call("ae_save", { expect });
  check("ae_save (before the late block)", r.applied && r.receipt?.matches !== false, path.basename(String(r.backup_path)));

  // ---------- wave 5: ae_fonts replace for real (Project.replaceFont is not undoable; the project is saved and clean here) ----------
  {
    const used = await call("ae_fonts", {});
    const fromFont = (used.fonts ?? []).find((f) => f.font && !f.missing)?.font;
    const found = await call("ae_fonts", { action: "search", query: "a", page_size: 25 });
    const toFont = (found.fonts ?? []).map((f) => f.postscript).find((p) => p && p !== fromFont);
    if (!fromFont || !toFont) {
      skip("ae_fonts (replace, applied)", `no used font to replace (${fromFont ?? "none"}) or no other installed font to replace it with (${toFont ?? "none"}); needs AE 24.5`);
    } else {
      r = await call("ae_fonts", { action: "replace", from: fromFont, to: toFont, dry_run: false, expect });
      gated("ae_fonts (replace, applied after a checkpoint, read back)", r, (x) => (x.applied === true && x.receipt?.matches === true) || x.no_op === true, /24\.5|unsupported|replaceFont/i, `${fromFont} -> ${toFont}; ${why(r)}`);
      await call("ae_save", { expect });
    }
  }

  // ---------- wave 2: scrub check on a render file (imports it, checks it, removes it again) ----------
  if (firstFrame) {
    r = await call("ae_scrub_check", { path: path.join(RENDER, firstFrame), sequence: true, fps: 25, samples: 4, expect });
    check("ae_scrub_check (render file)", r.ok === true && r.imported_state === "removed" && r.left_in_project === null, `${r.verdict}; imported ${r.imported_state}; ${r.message ?? ""}`);
    r = await call("ae_get_project", { type: "comp", name_contains: "Scrub check" });
    check("ae_scrub_check (no temp comp left behind)", (r.items ?? []).length === 0, `${(r.items ?? []).length} left`);
    await call("ae_save", { expect });
  } else {
    skip("ae_scrub_check (render file)", "the aerender step produced no PNG sequence (no PNG output module template, or the render failed)");
  }

  // ---------- wave 3: render queue edits (queue items past the first are removed again at the end) ----------
  {
    const specs = await call("ae_delivery_specs", { item_index: 1 });
    check(
      "ae_delivery_specs",
      Array.isArray(specs.specs) && specs.specs.length >= 12 && specs.specs.find((s) => s.id === "gif")?.feasible === false,
      `${specs.specs?.length} specs; this AE can do: ${(specs.specs ?? []).filter((s) => s.feasible).map((s) => s.id).join(", ")}`
    );
    r = await call("ae_render_queue_add", { comp_id: COMP, output_path: path.join(RENDER, "rqedit_a.mov"), expect });
    const rqIdx = r.index;
    check("ae_render_queue_add (item for the edit steps)", r.applied && typeof rqIdx === "number" && rqIdx >= 2, `index ${rqIdx}`);
    const insp = await call("ae_render_queue_inspect", { item_index: rqIdx, settings: true });
    const fileBefore = insp.items?.[0]?.output_modules?.[0]?.file;
    check("ae_render_queue_inspect", Boolean(insp.items?.[0]?.render_settings) && Boolean(fileBefore), `${path.basename(String(fileBefore))}`);
    r = await call("ae_render_queue_inspect", { include_templates: true });
    check("ae_render_queue_inspect (templates)", Array.isArray(r.render_settings_templates) && Array.isArray(r.output_module_templates), `${r.render_settings_templates?.length} render settings, ${r.output_module_templates?.length} output module templates`);
    r = await call("ae_render_queue_edit", { item_index: rqIdx, comp_id: COMP, skip_frames: 1, time_span: "work_area", log_type: "errors_and_settings", expect });
    check("ae_render_queue_edit", okWrite(r), why(r));
    r = await call("ae_render_queue_edit", { item_index: rqIdx, output_modules: [{ index: 1, settings: { Format: "H.264" } }], expect });
    check("ae_render_queue_edit (Format is read-only: refused)", refused(r), why(r).slice(0, 100));
    r = await call("ae_render_queue_duplicate", { item_index: rqIdx, comp_id: COMP, count: 1, expect });
    check("ae_render_queue_duplicate", okWrite(r) && r.copies?.[0]?.item?.output_modules?.[0]?.file !== fileBefore, `copy writes ${path.basename(String(r.copies?.[0]?.item?.output_modules?.[0]?.file))}; ${why(r)}`);
    const yt = (specs.specs ?? []).find((s) => s.id === "youtube_1080p");
    if (yt?.feasible) {
      r = await call("ae_render_queue_apply_spec", { item_index: rqIdx, comp_id: COMP, specs: ["youtube_1080p"], output_folder: RENDER, allow_stretch: true, allow_overwrite: true, expect });
      // Channels "RGB" is not offered for an H.264 template: it comes back in results[].skipped[] with optional: true and is no failure.
      const optSkips = (r.results ?? []).flatMap((x) => (x.skipped ?? []).filter((k) => k.optional === true).map((k) => k.key));
      const realSkips = (r.results ?? []).flatMap((x) => (x.skipped ?? []).filter((k) => k.optional !== true).map((k) => k.key));
      check("ae_render_queue_apply_spec", okWrite(r) && realSkips.length === 0, why(r) || `optional skips: ${optSkips.join(", ") || "none"}`);
    } else {
      skip("ae_render_queue_apply_spec", `youtube_1080p is not feasible here: ${yt?.refusal ?? yt?.reason ?? "no reason given"}`);
    }
    r = await call("ae_check_delivery_file", { spec_id: "youtube_1080p", file_path: path.join(RENDER, "no_such_file.mp4") });
    check("ae_check_delivery_file (missing file)", r.exists === false && r.ok === false, JSON.stringify(r.issues));
    if (firstFrame) {
      r = await call("ae_check_delivery_file", { spec_id: "png_sequence", file_path: path.join(RENDER, firstFrame) });
      check("ae_check_delivery_file (a real frame)", r.exists === true && r.size_bytes > 0, `${r.size_bytes} bytes; ${JSON.stringify(r.issues)}`);
    } else {
      skip("ae_check_delivery_file (a real frame)", "no rendered frame to check");
    }
    // A batch can name queue items as well (plan only here; the batch step below renders). The plan wants a saved, clean project.
    await call("ae_save", { expect });
    r = await call("ae_render_batch_plan", { queue_items: [{ rq_index: rqIdx, item_comp_id: COMP, name: "rqitem" }], output_dir: path.join(ROOT, "batch_out_rq") });
    check("ae_render_batch_plan (a Render Queue item)", r.ok === true && r.valid === true && r.item_count === 1, `${r.item_count} item(s); errors ${js(r.errors)}`);
    r = await call("ae_render_batch_plan", { queue_items: [{ rq_index: rqIdx, item_comp_id: 999999 }], output_dir: path.join(ROOT, "batch_out_rq") });
    check("ae_render_batch_plan (a Render Queue item of another comp is invalid)", r.valid === false || refused(r), js(r.errors?.[0]));
    r = await call("ae_run_jsx", {
      mutates: true,
      label: "qa smoke: remove the queue items the edit steps added",
      expect,
      code: "var q = app.project.renderQueue; for (var i = q.numItems; i >= 2; i--) q.item(i).remove(); return q.numItems;",
    });
    check("ae_render_queue_* (cleanup, the first item is left)", r.applied !== false && r.result === 1, `${r.result} item(s) in the queue`);
    await call("ae_save", { expect });
  }

  // ---------- wave 5: queue item flag, aerender -rqindex, queue item removal (a short PNG item; the project is saved and clean) ----------
  {
    r = await call("ae_render_queue_add", { comp_id: COMP, output_path: path.join(RENDER, "w5_rq.mov"), expect });
    const idx = r.index;
    check("ae_render_queue_add (item for the wave 5 steps)", r.applied && typeof idx === "number", `index ${idx}`);
    let q = await call("ae_render_queue_inspect", { item_index: idx });
    const qComp = q.items?.[0]?.comp_id;
    r = await call("ae_render_queue_edit", {
      item_index: idx,
      comp_id: qComp,
      time_span: { start: 0, duration: 0.2 },
      ...(pngTemplate ? { output_modules: [{ index: 1, template: pngTemplate, file: path.join(RENDER, "w5rq_[#####].png") }] } : {}),
      expect,
    });
    check("ae_render_queue_edit (a short time span" + (pngTemplate ? ", PNG sequence output" : "") + ")", okWrite(r), why(r));
    r = await call("ae_render_queue_edit", { item_index: idx, comp_id: qComp, queued: false, expect });
    q = await call("ae_render_queue_inspect", { item_index: idx });
    check("ae_render_queue_edit (queued false: the Render checkbox is off)", okWrite(r) && q.items?.[0]?.render === false, `${q.items?.[0]?.status}; ${why(r)}`);
    r = await call("ae_render_queue_edit", { item_index: idx, comp_id: qComp, queued: true, expect });
    q = await call("ae_render_queue_inspect", { item_index: idx });
    check("ae_render_queue_edit (queued true)", okWrite(r) && q.items?.[0]?.render === true, `${q.items?.[0]?.status}; ${why(r)}`);
    r = await call("ae_render_queue_edit", { item_index: idx, comp_id: qComp, queued: true, expect });
    check("ae_render_queue_edit (queued again is a no-op)", r.applied && r.no_op === true, brief(r).slice(0, 120));

    // The edits left the project dirty: rq_index must refuse until it is saved. Then the wrong comp, an output_path, and the real run.
    r = await call("ae_aerender_start", { rq_index: idx, item_comp_id: qComp, expect });
    check("ae_aerender_start (rq_index on a dirty project is refused, naming ae_save)", refused(r) && /ae_save|save/i.test(why(r) + JSON.stringify(r)), why(r).slice(0, 120));
    await call("ae_save", { expect });
    r = await call("ae_aerender_start", { rq_index: idx, item_comp_id: 999999, expect });
    check("ae_aerender_start (rq_index with another comp's id is refused)", refused(r), why(r).slice(0, 120));
    r = await call("ae_aerender_start", { rq_index: idx, item_comp_id: qComp, output_path: path.join(RENDER, "x.mov"), expect });
    check("ae_aerender_start (rq_index with output_path is refused: the item brings its own)", refused(r), why(r).slice(0, 120));
    if (pngTemplate) {
      r = await call("ae_aerender_start", { rq_index: idx, item_comp_id: qComp, expect });
      check("ae_aerender_start (rq_index)", r.ok && r.state === "running" && !JSON.stringify(r.args ?? []).includes("-comp") && JSON.stringify(r.args ?? []).includes("-rqindex") && (r.output_paths ?? []).length >= 1, brief(r).slice(0, 200));
      const rqJob = r.job_id;
      for (let i = 0; i < 120 && rqJob; i++) {
        await sleep(2000);
        r = await call("ae_aerender_status", { job_id: rqJob });
        if (r.state !== "running") break;
      }
      check("ae_aerender_status (rq_index job)", r.state === "succeeded" && r.rq_index === idx && (r.output_paths ?? []).length >= 1, `${r.state} ${r.percent ?? ""}%`);
      if (r.state === "succeeded") {
        r = await call("ae_verify_render", { job_id: rqJob, expect: { ...expect, comp_id: COMP } });
        check("ae_verify_render (a Render Queue job: every output is checked, the import is removed)", r.ok === true && (r.job_outputs ?? []).length >= 1 && r.imported_item_state === "removed", brief(r).slice(0, 200));
      }
    } else {
      skip("ae_aerender_start (rq_index) / ae_aerender_status / ae_verify_render (rq job)", "no PNG output module template to keep the render to a few frames");
    }

    // Removal: a dry run (a plan), then the item itself, then a row that names the wrong comp.
    r = await call("ae_render_queue_edit", { remove_filter: { status: "done" }, dry_run: true, expect });
    check("ae_render_queue_edit (remove_filter dry run)", r.dry_run === true && !r.__isError, js(r.would_remove ?? r, 120));
    q = await call("ae_render_queue_inspect", {});
    const before = q.numItems;
    const last = q.items?.[before - 1];
    r = await call("ae_render_queue_edit", { remove: [{ index: before, comp_id: last?.comp_id }], expect });
    check("ae_render_queue_edit (remove an item)", okWrite(r) && r.num_items === before - 1, `${before} -> ${r.num_items}; ${cpNote(r)}; ${why(r)}`);
    r = await call("ae_render_queue_edit", { remove: [{ index: 1, comp_id: 999999 }], expect });
    check("ae_render_queue_edit (remove with the wrong comp id is refused)", refused(r), why(r).slice(0, 120));
    await call("ae_save", { expect });
  }

  // ---------- ae_render_queue_render: AE's own render in the background (OPT-IN: it keeps AE busy; not run live yet) ----------
  // Set CHROMA_SMOKE_RENDER_IN_AE=1 to run it. A 0.2 s PNG sequence item is rendered by AE itself; meanwhile every AE tool must be refused
  // at once (not hang, not quarantine), the status tool must answer, and the steps after this one must still work.
  if (process.env.CHROMA_SMOKE_RENDER_IN_AE !== "1") {
    skip("ae_render_queue_render / ae_render_queue_render_status", "opt-in: set CHROMA_SMOKE_RENDER_IN_AE=1 (After Effects is busy for the render)");
  } else if (!pngTemplate) {
    skip("ae_render_queue_render / ae_render_queue_render_status", "no PNG output module template to keep the render to a few frames");
  } else {
    r = await call("ae_render_queue_add", { comp_id: COMP, output_path: path.join(RENDER, "rqrender_a.mov"), expect });
    const rIdx = r.index;
    check("ae_render_queue_add (item for ae_render_queue_render)", r.applied && typeof rIdx === "number", `index ${rIdx}`);
    const rq0 = await call("ae_render_queue_inspect", { item_index: rIdx });
    const rComp = rq0.items?.[0]?.comp_id;
    r = await call("ae_render_queue_edit", {
      item_index: rIdx,
      comp_id: rComp,
      time_span: { start: 0, duration: 0.2 },
      output_modules: [{ index: 1, template: pngTemplate, file: path.join(RENDER, "rqrender_[#####].png") }],
      queued: true,
      expect,
    });
    check("ae_render_queue_edit (item for ae_render_queue_render)", okWrite(r), why(r));
    // Refusals first: nothing may start. The wrong project path is a guard refusal.
    r = await call("ae_render_queue_render", { expect: { project_path: "C:\no\such\project.aep" } });
    check("ae_render_queue_render (wrong project is refused)", refused(r), why(r).slice(0, 120));
    r = await call("ae_render_queue_render", { expect });
    const rJob = r.job_id;
    check("ae_render_queue_render (returns at once with a job id)", r.ok === true && r.started === true && r.state === "running" && typeof rJob === "string", brief(r).slice(0, 200));
    if (rJob) {
      const t0 = Date.now();
      r = await call("ae_get_project", {});
      check("ae_get_project (during the render: refused at once, not sent to AE)", refused(r) && /rendering/i.test(why(r) + JSON.stringify(r)) && Date.now() - t0 < 5000, `${Date.now() - t0} ms; ${why(r).slice(0, 100)}`);
      r = await call("ae_status", {});
      check("ae_status (during the render: answers with the render state)", Boolean(r.rendering) || /rendering/i.test(JSON.stringify(r)), js(r.rendering ?? r, 120));
      let st = await call("ae_render_queue_render_status", { job_id: rJob });
      for (let i = 0; i < 150 && st.state === "running"; i++) {
        await sleep(2000);
        st = await call("ae_render_queue_render_status", { job_id: rJob });
      }
      check("ae_render_queue_render_status (finished, item DONE, frames on disk)", st.state === "finished" && st.render_ok === true && (st.outputs ?? []).every((o) => o.exists && o.bytes > 0), `${st.state}; ${st.summary ?? st.error ?? ""}`.slice(0, 220));
      // AE answers again: later steps must work, and nothing was quarantined.
      r = await call("ae_get_project", {});
      check("ae_get_project (after the render: AE answers again)", !r.__isError && Array.isArray(r.items ?? r.tree ?? r.children ?? [r]), brief(r).slice(0, 120));
      r = await call("ae_status", {});
      check("ae_status (after the render: no quarantine)", !r.rendering && (r.quarantine ?? []).length === 0, js(r.quarantine ?? [], 120));
      r = await call("ae_verify_render", { path: path.join(RENDER, "rqrender_00000.png"), sequence: true, expect: { ...expect, comp_id: COMP } });
      check("ae_verify_render (a frame from ae_render_queue_render)", r.ok === true, brief(r).slice(0, 160));
    }
    // Remove the DONE item again so the later steps see the queue they expect.
    const rq1 = await call("ae_render_queue_inspect", {});
    const doneItem = (rq1.items ?? []).find((i) => i.comp_id === rComp && i.status === "done" && /rqrender_/.test(String(i.output_modules?.[0]?.file)));
    if (doneItem) await call("ae_render_queue_edit", { remove: [{ index: doneItem.index, comp_id: doneItem.comp_id }], expect });
    await call("ae_save", { expect });
  }

  // ---------- wave 3: render batch (a frozen copy of the saved project, aerender in the background) ----------
  const rbOut = path.join(ROOT, "batch_out");
  let batchSpec = null;
  if (pngTemplate) batchSpec = { name: "png", output_module_template: pngTemplate, extension: "png", sequence: true };
  else {
    const lossless = (om.result ?? []).find((t) => /lossless/i.test(t));
    if (lossless) batchSpec = { name: "lossless", output_module_template: lossless, extension: "mov" };
  }
  if (batchSpec && smokeKey) {
    const job1 = { comps: ["Smoke Key"], specs: [batchSpec], output_dir: rbOut };
    r = await call("ae_render_batch_plan", job1);
    check("ae_render_batch_plan", r.ok === true && r.valid === true && r.item_count === 1, `${r.item_count} item(s); errors ${JSON.stringify(r.errors)}`);
    r = await call("ae_render_batch_plan", { comps: ["__no_such_comp__"], output_dir: rbOut });
    check("ae_render_batch_plan (a missing comp)", r.valid === false && r.errors?.[0]?.code === "comp_not_found", JSON.stringify(r.errors?.[0]));
    r = await call("ae_render_batch", { expect, ...job1, preflight: true, max_cpu_percent: 50 });
    const batchId = r.batch_id;
    check("ae_render_batch", r.ok === true && r.applied === true && typeof batchId === "string" && r.frozen_project !== AEP, `${batchId}; ${r.error ?? ""} ${r.message ?? ""}`.slice(0, 200));
    let rb = r;
    for (let i = 0; i < 150 && batchId; i++) {
      rb = await call("ae_render_batch_status", { batch_id: batchId });
      if (rb.state && rb.state !== "running") break;
      await sleep(2000);
    }
    check("ae_render_batch_status (finished)", rb.state === "succeeded" && rb.items?.[0]?.output_bytes > 0, `${rb.state}, ${rb.items?.[0]?.output_bytes} bytes, ${rb.items?.[0]?.error ?? ""}`);
    r = await call("ae_render_batch_status", {});
    check("ae_render_batch_status (recent batches)", Array.isArray(r.batches) && r.batches.some((b) => b.batch_id === batchId), `${r.batches?.length} batch(es)`);
    r = await call("ae_render_batch_plan", job1);
    check("ae_render_batch_plan (the new output is protected)", r.items?.[0]?.existing?.would_block === true, JSON.stringify(r.items?.[0]?.existing));
    r = await call("ae_render_batch_resume", { expect, batch_id: batchId });
    check("ae_render_batch_resume (a finished batch keeps its output)", r.ok === true && r.reset === 0 && r.kept === 1, `${r.state}, kept ${r.kept}, reset ${r.reset}`);
    r = await call("ae_render_batch_cancel", { batch_id: batchId });
    check("ae_render_batch_cancel (a finished batch is a no-op)", r.ok === true && r.already_finished === true, String(r.state));
    skip("ae_render_batch_cancel (a running batch)", "the batch is too short to cancel mid-render; the kill path needs a long render by hand");
  } else {
    skip("ae_render_batch_plan / ae_render_batch / _status / _resume / _cancel", "no PNG or Lossless output module template to render with, or no Smoke Key comp");
  }

  // ---------- wave 3: delivery chain (a recipe, then a run that renders through the batch above) ----------
  if (batchSpec && smokeKey) {
    const dex = { project_path: AEP };
    await call("ae_save", { expect });
    r = await call("ae_deliver_recipe", {
      action: "set",
      name: "smoke",
      comp_id: smokeKey.id,
      stages: [
        { kind: "preflight" },
        { kind: "house_style" },
        { kind: "save", args: { backup: false } },
        { kind: "render", args: { output_dir: path.join(ROOT, "deliver_out"), specs: [batchSpec] } },
        { kind: "verify" },
      ],
      checkpoint_mode: "each_write",
      expect: dex,
    });
    check("ae_deliver_recipe (set)", r.ok === true && r.recipe?.stages?.length === 5, `${(r.warnings ?? []).join("; ")}`);
    r = await call("ae_deliver_recipe", { action: "get", name: "smoke", expect: dex });
    check("ae_deliver_recipe (get)", r.ok === true && !r.__isError, brief(r).slice(0, 140));
    r = await call("ae_deliver_recipe", { action: "list", expect: dex });
    check("ae_deliver_recipe (list)", r.ok === true && (r.recipes ?? []).some((x) => x.name === "smoke"), `${(r.recipes ?? []).length} recipe(s)`);
    r = await call("ae_deliver_step", { action: "start", recipe: "smoke", dry_run: true, expect: dex });
    check("ae_deliver_step (dry run)", r.ok === true && r.dry_run === true && r.stages?.length === 5, `${r.stages?.length} stages`);
    let run = await call("ae_deliver_step", { action: "start", recipe: "smoke", expect: dex });
    const runId = run.run_id;
    for (let i = 0; i < 60 && run.state === "waiting"; i++) {
      await sleep(5000);
      run = await call("ae_deliver_step", { action: "next", run_id: runId, expect: dex });
    }
    check("ae_deliver_step (done, or stopped at a named stage)", run.state === "done" || (run.state === "blocked" && typeof run.stopped_at === "string"), `${run.state}${run.stopped_at ? " at " + run.stopped_at : ""}; ${run.stop_reason ?? run.message ?? ""}`.slice(0, 200));
    check("ae_deliver_step (outputs come from the batch)", (run.outputs ?? []).length >= 1 || run.state === "blocked", `${(run.outputs ?? []).length} output(s)`);
    r = await call("ae_deliver_status", { run_id: runId, expect: dex });
    check("ae_deliver_status", r.ok !== false && typeof r.report === "string" && r.report.startsWith("Delivery report"), String(r.report ?? r.message ?? "no report").slice(0, 60));
    r = await call("ae_deliver_status", { list: true, expect: dex });
    check("ae_deliver_status (list)", r.ok !== false && !r.__isError, brief(r).slice(0, 100));
    if (run.state !== "done") {
      r = await call("ae_deliver_step", { action: "cancel", run_id: runId, expect: dex });
      check("ae_deliver_step (cancel the open run)", r.ok !== false && !r.__isError, String(r.state));
    }
    r = await call("ae_deliver_recipe", { action: "delete", name: "smoke", expect: dex });
    check("ae_deliver_recipe (delete)", r.ok === true && r.deleted === "smoke", String(r.deleted));
    await call("ae_save", { expect });
  } else {
    skip("ae_deliver_recipe / ae_deliver_step / ae_deliver_status", "the render stage needs the batch above (an output module template to render with)");
  }

  // ---------- wave 3: collect files, report, relink (relink closes the project and reopens it) ----------
  {
    const dest = path.join(ROOT, "collect");
    r = await call("ae_collect_files", { dest, expect });
    check("ae_collect_files (dry run)", r.dry_run === true && typeof r.files === "number" && typeof r.bytes === "number", `${r.files} file(s), ${r.bytes_human}; not collected: ${JSON.stringify(r.problems_total ?? 0)} problem(s)`);
    // A call works for max_seconds and a zip runs on in the background: call again with the same arguments until both are done.
    let col = await call("ae_collect_files", { dest, dry_run: false, zip: true, report: "markdown", expect });
    for (let i = 0; i < 30 && (col.complete !== true || col.zip?.status === "running"); i++) {
      await sleep(2000);
      col = await call("ae_collect_files", { dest, dry_run: false, zip: true, report: "markdown", expect });
    }
    check("ae_collect_files (copy)", col.complete === true && col.errors_total === 0, `${col.files_done}/${col.files_total} file(s), ${col.copied_files} copied`);
    check("ae_collect_files (zip verified)", col.zip?.ok === true && col.zip?.verified === true, JSON.stringify(col.zip ?? null).slice(0, 120));
    r = await call("ae_collect_files", { dest, dry_run: false, report: "none", expect });
    check("ae_collect_files (resume copies nothing again)", r.complete === true && r.copied_files === 0, `${r.copied_files} copied`);
    r = await call("ae_collect_report", { dest, format: "json", write: false });
    check("ae_collect_report (json)", Array.isArray(r.report?.comps) && r.report.comps.length > 0 && Boolean(r.report?.ae), `${r.report?.comps?.length} comps`);
    r = await call("ae_collect_report", { dest });
    check("ae_collect_report (markdown, written)", r.format === "markdown" && typeof r.markdown === "string" && r.markdown.length > 0, `written ${JSON.stringify(r.written)}`);
    r = await call("ae_collect_relink", { dest, confirm_close_project: true, expect });
    check("ae_collect_relink", okWrite(r) && r.original_reopened === true && r.copy_saved === true && r.errors_total === 0, `relinked ${r.relinked}, proxies ${r.proxies_relinked}; ${why(r)}`);
    // The original must be open again for what follows; if it is not, try to put it back.
    r = await call("ae_status");
    if (!new RegExp("Smoke\\.aep$", "i").test(String(r.project_path))) {
      // Discarding is only safe for the smoke's own scratch files: the collect copy under ROOT, or an unsaved project.
      const openPath = r.project_path == null ? "<unsaved>" : String(r.project_path);
      const norm = (x) => x.split("\\").join("/").toLowerCase();
      if (openPath !== "<unsaved>" && !norm(openPath).startsWith(norm(ROOT) + "/")) {
        throw new Error("After ae_collect_relink the open project is not the smoke's own (" + openPath + "); not discarding it.");
      }
      const back = await call("ae_project_session", { action: "open", path: AEP, expect: { project_path: openPath }, if_dirty: "discard", user_confirmed: true });
      check("ae_collect_relink (original reopened by hand)", back.applied === true, brief(back).slice(0, 120));
    }
  }

  // ---------- wave 2: memory purges that can drop the undo history ----------
  {
    if (ramPurgeAvailable === false) skip("ae_memory_purge (ram, confirmed)", "this AE has no ALL_MEMORY_CACHES purge target (needs AE 24.3+)");
    else {
    r = await call("ae_memory_purge", { target: "ram", confirm_undo_purge: true, expect });
    check("ae_memory_purge (ram, confirmed)", r.applied === true && r.purged === true && r.undo_history_cleared === null && r.undo_history_may_be_cleared === true, `${why(r)}; ${(r.warnings ?? []).length} warning(s)`);
    }
    r = await call("ae_memory_purge", { target: "undo", confirm_undo_purge: true, expect });
    check("ae_memory_purge (undo, confirmed)", r.applied === true && r.purged === true && r.undo_history_cleared === true, why(r));
    skip("ae_memory_purge (all)", "it also wipes the disk cache, which is the machine's own, not the scratch project's");
  }

  // ---------- wave 3: project session (open, new, close change the open project: this is the last block) ----------
  {
    r = await call("ae_project_session", { action: "autosave" });
    check("ae_project_session (autosave read)", !r.__isError && typeof r.auto_save?.prefs_available === "boolean" && r.policy?.enabled === false, `prefs available ${r.auto_save?.prefs_available}`);
    r = await call("ae_project_session", { action: "autosave", policy: { enabled: true, after_minutes: 5 }, user_confirmed: true, expect });
    check("ae_project_session (timed-save policy on)", r.policy?.enabled === true && r.policy?.max_backups === 10 && !r.__isError, JSON.stringify(r.policy ?? r).slice(0, 120));
    r = await call("ae_project_session", { action: "autosave", policy: { enabled: false } });
    check("ae_project_session (timed-save policy off)", r.policy?.enabled === false, JSON.stringify(r.policy ?? r).slice(0, 120));
    r = await call("ae_project_session", { action: "recover" });
    check("ae_project_session (recover list)", Array.isArray(r.files) && Array.isArray(r.searched), `${r.files?.length} file(s) in ${r.searched?.length} folder(s)`);
    // A dirty project must ask, never close.
    await call("ae_set_property", { comp_id: COMP, layer: dot, path: opacity, value: 85, expect });
    r = await call("ae_project_session", { action: "close", expect });
    check("ae_project_session (close on a dirty project asks)", r.needs_user === true && r.applied === false, `options ${JSON.stringify(r.options)}`);
    // Open the same project again, saving the change first (a backup goes to _mcp_backups).
    r = await call("ae_project_session", { action: "open", path: AEP, if_dirty: "save", expect });
    check("ae_project_session (open, if_dirty save)", okWrite(r) && r.opened === true && /_mcp_backups/.test(String(r.backup_path)) && typeof r.missing_footage?.count === "number", `missing footage ${r.missing_footage?.count}; backup ${path.basename(String(r.backup_path))}; ${why(r)}`);
    // app.project.dirty is undocumented and can read null; AE then asks (needs_user) and the scratch project is discarded on purpose.
    r = await call("ae_project_session", { action: "new", expect });
    if (r.needs_user === true && r.dirty === null) {
      console.log("  note: AE did not report the dirty flag (known limit); discarding the scratch project");
      r = await call("ae_project_session", { action: "new", expect, if_dirty: "discard", user_confirmed: true });
    }
    check("ae_project_session (new)", okWrite(r) && r.created === true, why(r));

    // ae_save save_as and increment move the open project to a new file, so nothing after them may use Smoke.aep.
    // The untitled project ae_project_session new just made can only be named with save_as; increment then saves the next _vNNN beside it.
    const same = (a, b) => String(a).split("\\").join("/").toLowerCase() === String(b).split("\\").join("/").toLowerCase();
    let openAt = "<unsaved>";
    // A folder of its own per run: save_as refuses an existing file, and a re-run into the same --dir would find SmokeSaveAs.aep (and its _v002, _v003).
    const saveAsDir = path.join(ROOT, `saveas_${Date.now()}`);
    fs.mkdirSync(saveAsDir, { recursive: true });
    const savedAs = path.join(saveAsDir, "SmokeSaveAs.aep");
    r = await call("ae_save", { expect: { project_path: "<unsaved>" }, save_as: { path: savedAs } });
    check("ae_save (save_as: an untitled project gets its first file)", r.applied === true && r.receipt?.matches !== false && r.previous_project_path === "<unsaved>" && fs.existsSync(savedAs), `${path.basename(String(r.project_path))}; ${why(r)}`);
    if (r.applied === true) openAt = String(r.project_path);
    r = await call("ae_save", { expect: { project_path: openAt }, save_as: { path: savedAs } });
    check("ae_save (save_as onto an existing file is refused unless overwrite)", refused(r), why(r).slice(0, 120));
    r = await call("ae_save", { expect: { project_path: openAt }, increment: true });
    check("ae_save (increment: the next _vNNN beside it, the old file stays)", r.applied === true && /SmokeSaveAs_v002\.aep$/i.test(String(r.project_path)) && fs.existsSync(savedAs) && fs.existsSync(String(r.project_path)), `${path.basename(String(r.project_path))}; ${why(r)}`);
    if (r.applied === true) openAt = String(r.project_path);
    r = await call("ae_status");
    check("ae_status (the open project is the incremented file)", same(r.project_path, openAt), String(r.project_path));
    r = await call("ae_save", { expect: { project_path: openAt }, increment: true });
    check("ae_save (a second increment gives _v003)", r.applied === true && /SmokeSaveAs_v003\.aep$/i.test(String(r.project_path)), path.basename(String(r.project_path)));
    if (r.applied === true) openAt = String(r.project_path);

    r = await call("ae_project_session", { action: "close", expect: { project_path: openAt } });
    if (r.needs_user === true && r.dirty === null) {
      r = await call("ae_project_session", { action: "close", expect: { project_path: openAt }, if_dirty: "discard", user_confirmed: true });
    }
    check("ae_project_session (close leaves an empty untitled project)", okWrite(r) && r.closed === true, why(r));
  }
}

let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err instanceof Error ? err.message : String(err);
  console.error(`\nStopped: ${fatal}`);
}
const passed = results.filter((x) => x.ok).length;
console.log(`\n${passed}/${results.length} passed${fatal ? " (stopped early)" : ""}${skipped.length ? `, ${skipped.length} skipped` : ""}. Project: ${AEP}`);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "smoke.json"),
  JSON.stringify({ project: AEP, passed, total: results.length, fatal, skipped, results }, null, 2)
);
process.exitCode = fatal || passed !== results.length ? 1 : 0;
