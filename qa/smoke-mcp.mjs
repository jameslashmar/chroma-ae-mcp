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
const brief = (r) => JSON.stringify(r).slice(0, 220);
/** A guarded write that was applied and read back clean. */
const okWrite = (r) => r.applied === true && r.receipt?.matches === true;
/** The tool refused: a schema error, a typed refusal (ok false) or a call that applied nothing. */
const refused = (r) => r.__isError === true || Boolean(r.__error) || r.ok === false || r.applied === false;
/** Why a call failed, for the note column. */
const why = (r) =>
  String(r.message ?? r.__error ?? ((r.receipt?.mismatches ?? []).slice(0, 2).map((m) => m.message).join("; ") || r.error || ""));

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

  let r = await call("ae_run_jsx", {
    mutates: true,
    label: "qa smoke: save as",
    expect: { project_path: "<unsaved>" },
    code: `app.project.save(new File(${JSON.stringify(AEP.replace(/\\/g, "/"))})); return app.project.file.fsName;`,
  });
  check("ae_run_jsx (unsaved project)", r.applied && r.checkpoint?.status === "skipped", cpNote(r));
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
  const settled = new Date(Date.now() - 10_000);
  fs.utimesSync(staged, settled, settled);
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
  check("ae_export_mogrt", r.ok && r.file?.size > 0 && r.file?.fresh === true, `${r.controllers} controller(s), ${r.file?.size} bytes ${r.message ?? ""}`);

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
  // ======================================================================
  const smokeKey = (await call("ae_get_project", { type: "comp", name_contains: "Smoke Key" })).items?.find((i) => i.name === "Smoke Key");
  const firstFrame = job.state === "succeeded" && pngTemplate ? frames.slice().sort()[0] : undefined; // smoke_00000.png of the aerender step
  r = await call("ae_save", { expect });
  check("ae_save (before the late block)", r.applied && r.receipt?.matches !== false, path.basename(String(r.backup_path)));

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
      check("ae_render_queue_apply_spec", okWrite(r), why(r));
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
    r = await call("ae_run_jsx", {
      mutates: true,
      label: "qa smoke: remove the queue items the edit steps added",
      expect,
      code: "var q = app.project.renderQueue; for (var i = q.numItems; i >= 2; i--) q.item(i).remove(); return q.numItems;",
    });
    check("ae_render_queue_* (cleanup, the first item is left)", r.applied !== false && r.result === 1, `${r.result} item(s) in the queue`);
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
    r = await call("ae_project_session", { action: "close", expect: { project_path: "<unsaved>" } });
    if (r.needs_user === true && r.dirty === null) {
      r = await call("ae_project_session", { action: "close", expect: { project_path: "<unsaved>" }, if_dirty: "discard", user_confirmed: true });
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
