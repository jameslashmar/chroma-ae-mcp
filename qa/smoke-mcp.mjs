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

function postMcp(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: DEFAULT_HOST,
        port: Number(process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT,
        method: "POST",
        path: "/mcp",
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
      "return { comp_id: c.id };",
    ].join("\n"),
  });
  const COMP = scene.result?.comp_id;
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

  r = await call("ae_save", { expect });
  check("ae_save", r.applied && r.receipt?.matches !== false && Boolean(r.backup_path), path.basename(String(r.backup_path)));

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
