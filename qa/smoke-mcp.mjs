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
}

let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err instanceof Error ? err.message : String(err);
  console.error(`\nStopped: ${fatal}`);
}
const passed = results.filter((x) => x.ok).length;
console.log(`\n${passed}/${results.length} passed${fatal ? " (stopped early)" : ""}. Project: ${AEP}`);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "smoke.json"),
  JSON.stringify({ project: AEP, passed, total: results.length, fatal, results }, null, 2)
);
process.exitCode = fatal || passed !== results.length ? 1 : 0;
