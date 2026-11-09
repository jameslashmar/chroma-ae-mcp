import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import { AeCollectFilesSchema } from "../src/tools/ext/collect.js";
import { AeLoudnessCheckSchema } from "../src/tools/ext/loudness.js";
import { AeRenderBatchCancelSchema, AeRenderBatchStartSchema, AeRenderBatchStatusSchema } from "../src/tools/ext/renderbatch.js";
import {
  AeDeliverRecipeSchema,
  AeDeliverStatusSchema,
  AeDeliverStepSchema,
  applyFailOn,
  batchOutputs,
  buildStageArgs,
  checkpointDue,
  classifyStageResult,
  clearDeliverMemory,
  currentStage,
  defaultStages,
  deliverPath,
  deliverTools,
  deriveState,
  describeError,
  DeliverStageSchema,
  extractBatchId,
  extractJobIds,
  extractOutputs,
  isPollable,
  loadStore,
  nextHint,
  normalizeStages,
  outputArgsFor,
  renderReport,
  saveStore,
  schemaAcceptsKey,
  setDeliverToolLookup,
  StoreUnreadableError,
  stagePrecheck,
  validateStageDef,
  worstOf,
  type Run,
  type StageDef,
  type StageState,
} from "../src/tools/ext/deliver.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";
// The collect's dest must be absolute on the machine running the test: "C:/d" is relative on macOS.
const DEST_D = process.platform === "win32" ? "C:/d" : "/d";
const DEST_ACME = process.platform === "win32" ? "C:/deliver/acme" : "/deliver/acme";

const tmpDirs: string[] = [];
afterEach(() => {
  setDeliverToolLookup();
  clearDeliverMemory();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const recipeTool = deliverTools.find((t) => t.name === "ae_deliver_recipe")!;
const stepTool = deliverTools.find((t) => t.name === "ae_deliver_step")!;
const statusTool = deliverTools.find((t) => t.name === "ae_deliver_status")!;

// ---------- schemas ----------

describe("schemas", () => {
  const expectArg = { project_path: "C:/p/show.aep" };

  it("exports the three tools, the mutating ones ending in the safety guidance", () => {
    expect(deliverTools.map((t) => t.name)).toEqual(["ae_deliver_recipe", "ae_deliver_step", "ae_deliver_status"]);
    expect(recipeTool.description).toContain("IMPORTANT");
    expect(stepTool.description).toContain("IMPORTANT");
  });

  it("limits a stage's tool to those of its kind and refuses expect in args", () => {
    expect(DeliverStageSchema.safeParse({ kind: "render", tool: "ae_aerender_start" }).success).toBe(true);
    expect(DeliverStageSchema.safeParse({ kind: "render", tool: "ae_run_jsx" }).success).toBe(false);
    expect(DeliverStageSchema.safeParse({ kind: "save", tool: "ae_aerender_start" }).success).toBe(false);
    expect(DeliverStageSchema.safeParse({ kind: "save", args: { expect: { project_path: "x" } } }).success).toBe(false);
    expect(DeliverStageSchema.safeParse({ kind: "save", id: "Bad Id" }).success).toBe(false);
  });

  it("checks the recipe action's required fields", () => {
    expect(AeDeliverRecipeSchema.safeParse({ action: "list", expect: expectArg }).success).toBe(true);
    expect(AeDeliverRecipeSchema.safeParse({ action: "get", expect: expectArg }).success).toBe(false);
    expect(AeDeliverRecipeSchema.safeParse({ action: "get", name: "Acme", comp_id: 3, expect: expectArg }).success).toBe(false);
    expect(AeDeliverRecipeSchema.safeParse({ action: "set", name: "Acme", stages: [{ kind: "render" }, { kind: "render" }], expect: expectArg }).success).toBe(false);
    expect(AeDeliverRecipeSchema.safeParse({ action: "set", name: "Acme", stages: [{ kind: "render" }, { kind: "render", id: "render_ig" }], expect: expectArg }).success).toBe(true);
    expect(AeDeliverRecipeSchema.safeParse({ action: "set", name: "../x", expect: expectArg }).success).toBe(false);
  });

  it("checks the step action's required fields", () => {
    const ok = (v: Record<string, unknown>) => AeDeliverStepSchema.safeParse({ expect: expectArg, ...v }).success;
    expect(ok({ action: "start", recipe: "Acme" })).toBe(true);
    expect(ok({ action: "start" })).toBe(false);
    expect(ok({ action: "next", recipe: "Acme" })).toBe(false);
    expect(ok({ action: "skip", stage: "preflight" })).toBe(false);
    expect(ok({ action: "skip", stage: "preflight", acknowledge: "Jay accepts the warning" })).toBe(true);
    expect(ok({ action: "next", acknowledge: "no reason here" })).toBe(false);
    expect(ok({ action: "next", dry_run: true })).toBe(false);
    expect(ok({ action: "next", run_id: "dl_abc_123" })).toBe(true);
    expect(ok({ action: "next", run_id: "other" })).toBe(false);
    expect(AeDeliverStatusSchema.safeParse({ expect: expectArg, list: true }).success).toBe(true);
  });
});

// ---------- pure logic ----------

describe("normalizeStages", () => {
  it("fills the tool, defaults and ids", () => {
    const defs = normalizeStages([{ kind: "render", args: { a: 1 } }, { kind: "scrub" }, { kind: "preflight", fail_on: "warning", optional: true, id: "gate" }]);
    expect(defs[0]).toMatchObject({ id: "render", tool: "ae_render_batch", optional: false, per_output: false, fail_on: "blocker", args: { a: 1 } });
    expect(defs[1]).toMatchObject({ id: "scrub", tool: "ae_scrub_check", optional: true, per_output: true });
    expect(defs[2]).toMatchObject({ id: "gate", optional: true, fail_on: "warning" });
  });

  it("gives the default recipe nine stages: a second save before loudness and collect, which refuse a project verify and scrub left changed", () => {
    expect(defaultStages().map((s) => s.id ?? s.kind)).toEqual(["preflight", "house_style", "save", "render", "verify", "scrub", "save_final", "loudness", "collect"]);
    const norm = normalizeStages(defaultStages());
    expect(norm.find((s) => s.id === "collect")!.args).toEqual({ dry_run: false });
    expect(normalizeStages(defaultStages()).map((s) => validateStageDef(s))).toEqual(norm.map(() => null));
  });
});

describe("checkpointDue", () => {
  const def = (kind: StageDef["kind"], checkpoint?: boolean): StageDef => normalizeStages([{ kind, ...(checkpoint !== undefined ? { checkpoint } : {}) }])[0];
  it("follows the mode and the stage's writes", () => {
    expect(checkpointDue("each_write", def("save"), 0)).toBe(true);
    expect(checkpointDue("each_write", def("preflight"), 0)).toBe(false);
    expect(checkpointDue("each_write", def("checkpoint"), 0)).toBe(false);
    expect(checkpointDue("start", def("save"), 0)).toBe(true);
    expect(checkpointDue("start", def("verify"), 1)).toBe(false);
    expect(checkpointDue("none", def("save"), 0)).toBe(false);
    expect(checkpointDue("none", def("save", true), 0)).toBe(true);
    expect(checkpointDue("each_write", def("save", false), 0)).toBe(false);
  });
});

describe("classifyStageResult", () => {
  it("reads the preflight verdict", () => {
    const blocked = classifyStageResult("preflight", { ok: true, verdict: "blocked", counts: { blocker: 2, warning: 1, note: 0 }, findings: [{ severity: "blocker", message: "Missing footage", where: { item: "clip.mov" } }] });
    expect(blocked.status).toBe("blocked");
    expect(blocked.summary).toContain("2 blocker");
    expect(blocked.findings[0]).toEqual({ severity: "blocker", message: "Missing footage", where: "clip.mov" });
    expect(classifyStageResult("preflight", { verdict: "warnings", counts: { warning: 1 } }).status).toBe("warn");
    expect(classifyStageResult("preflight", { verdict: "clear", counts: {} }).status).toBe("ok");
    // a gate that did not cover the whole project has not cleared it
    expect(classifyStageResult("preflight", { verdict: "incomplete" }).status).toBe("blocked");
    expect(classifyStageResult("scrub", { verdict: "incomplete" }).status).toBe("warn");
  });

  it("reads the loudness verdict object, a render still going, and a comp without audio", () => {
    const pass = { ok: true, state: "done", measurement: { integrated_lufs: -23.1, true_peak_dbtp: -2 }, verdict: { measurable: true, passes: true, loudness_ok: true, true_peak_ok: true, advice: [] } };
    expect(classifyStageResult("loudness", pass)).toMatchObject({ status: "ok" });
    const off = classifyStageResult("loudness", { ...pass, verdict: { measurable: true, passes: false, loudness_ok: false, true_peak_ok: true, advice: ["-18 LUFS is 5 LU louder than the target -23 LUFS."] } });
    expect(off.status).toBe("blocked");
    expect(off.summary).toContain("loudness off target");
    expect(off.summary).toContain("5 LU louder");
    const peak = classifyStageResult("loudness", { ...pass, verdict: { measurable: true, passes: false, loudness_ok: true, true_peak_ok: false } });
    expect(peak.summary).toContain("true peak");
    expect(classifyStageResult("loudness", { ok: true, verdict: { measurable: false, passes: false, advice: ["silent"] } }).status).toBe("blocked");
    expect(classifyStageResult("loudness", { ok: true, state: "rendering", job_id: "j9" })).toMatchObject({ status: "ok", running: true });
    expect(classifyStageResult("loudness", { ok: false, error: "no_audio", message: "no layer with audio" }).status).toBe("warn");
    expect(classifyStageResult("loudness", { ok: false, error: "bad_args", message: "Give exactly one of comp_id, job_id or audio_path." }).status).toBe("blocked");
  });

  it("reads the collect: a dry run warns, a stopped copy is not passed", () => {
    expect(classifyStageResult("collect", { dry_run: true, files: 3 }).status).toBe("warn");
    const partial = classifyStageResult("collect", { dry_run: false, complete: false, remaining: 4, errors_total: 0 });
    expect(partial.status).toBe("blocked");
    expect(partial.summary).toContain("4 file(s) left");
    expect(classifyStageResult("collect", { dry_run: false, complete: false, remaining: 0, errors_total: 2 }).summary).toContain("2 file(s) failed");
    expect(classifyStageResult("collect", { dry_run: false, complete: true, files_total: 12 })).toMatchObject({ status: "ok", summary: "collected 12 file(s)" });
    expect(classifyStageResult("collect", { ok: false, error: "bad_args", message: "The project has unsaved changes." }).status).toBe("blocked");
  });

  it("marks a failed result whose write reached the project as unverified", () => {
    const c = classifyStageResult("verify", { ok: false, error: "read_failed", applied: true, message: "could not read the import" });
    expect(c).toMatchObject({ status: "blocked", unverified: true, applied: true });
    expect(classifyStageResult("verify", { ok: false, error: "bad_args", applied: false }).unverified).toBeUndefined();
  });

  it("treats house style findings as warnings", () => {
    expect(classifyStageResult("house_style", { ok: true, clean: false, counts: { medium: 2, low: 0, info: 0 }, findings: [{ severity: "medium", message: "Off-palette", layer: "Title" }] }).status).toBe("warn");
    expect(classifyStageResult("house_style", { ok: true, clean: true, counts: { medium: 0, low: 0, info: 1 } }).status).toBe("ok");
  });

  it("reads the scrub verdict and the verify match", () => {
    expect(classifyStageResult("scrub", { verdict: "fail", findings: [{ severity: "high", message: "frozen", time: 2 }] }).findings[0].where).toBe("t=2s");
    expect(classifyStageResult("scrub", { verdict: "pass" }).status).toBe("ok");
    const v = classifyStageResult("verify", { ok: true, matches: false, checks: [{ what: "frames", expected: 120, actual: 118, ok: false }, { what: "size", expected: [1, 1], actual: [1, 1], ok: true }] });
    expect(v.status).toBe("blocked");
    expect(v.summary).toContain("frames");
    expect(classifyStageResult("verify", { ok: true, matches: true, imported_item_state: "left", imported_item: 9 })).toMatchObject({ status: "blocked", unverified: true });
    expect(classifyStageResult("verify", { ok: true, matches: true, imported_item_state: "removed" }).status).toBe("ok");
    expect(classifyStageResult("verify", { ok: true, matches: true, imported_item_state: "kept" }).status).toBe("ok");
  });

  it("blocks a verify whose imported item may still be in the project, as unverified so retry is refused", () => {
    const unknown = classifyStageResult("verify", {
      ok: true,
      matches: true,
      imported_item_state: "unknown",
      imported_item: 9,
      problems: [{ path: "read_back", expected: "gone", actual: "unknown", message: "the check that the imported render is gone failed" }],
    });
    expect(unknown).toMatchObject({ status: "blocked", unverified: true });
    expect(unknown.summary).toContain("item 9");
    expect(classifyStageResult("verify", { ok: true, matches: true, imported_item_state: "removed", problems: [{ path: "cleanup", message: "still there" }] })).toMatchObject({ status: "blocked", unverified: true });
  });

  it("blocks a scrub that passed but left its temporary comp and imported render in the project", () => {
    const left = classifyStageResult("scrub", { ok: true, verdict: "pass", imported_state: "left", left_in_project: { item_id: 11, comp_id: 12 }, problems: [{ path: "cleanup", message: "x" }] });
    expect(left).toMatchObject({ status: "blocked", unverified: true });
    expect(left.summary).toContain("item 11");
    expect(left.summary).toContain("comp 12");
    expect(classifyStageResult("scrub", { ok: true, verdict: "pass", imported_state: "unknown", left_in_project: { item_id: 11, comp_id: 12 }, problems: [{ path: "read_back", message: "x" }] })).toMatchObject({ status: "blocked", unverified: true });
    expect(classifyStageResult("scrub", { ok: true, verdict: "pass", imported_state: "removed", left_in_project: null })).toMatchObject({ status: "ok" });
    // an item another layer uses stays on purpose
    expect(classifyStageResult("scrub", { ok: true, verdict: "pass", imported_state: "kept_in_use", left_in_project: { item_id: 11 } }).status).toBe("ok");
  });

  it("does not pass a collect whose zip failed or is still being written, and warns about gaps", () => {
    const done = { dry_run: false, complete: true, files_total: 3, remaining: 0, errors_total: 0 };
    expect(classifyStageResult("collect", { ...done, zip: { ok: true, verified: true } }).status).toBe("ok");
    expect(classifyStageResult("collect", { ...done, zip: { ok: false, error: "The zip could not be written: disk full" } })).toMatchObject({ status: "blocked" });
    expect(classifyStageResult("collect", { ...done, zip: { ok: false, error: "disk full" } }).summary).toContain("disk full");
    expect(classifyStageResult("collect", { ...done, zip: { ok: false, status: "running" } }).summary).toContain("still being written");
    expect(classifyStageResult("collect", { ...done, zip: { ok: true, verified: false, verify_errors: ["a.mov: size differs"] } })).toMatchObject({ status: "blocked" });
    const gaps = classifyStageResult("collect", { ...done, problems_total: 2, no_file_items_total: 1, sequences_with_gaps: [{ name: "s" }], report: { error: "The report could not be written: x" } });
    expect(gaps.status).toBe("warn");
    expect(gaps.summary).toContain("2 problem(s)");
    expect(gaps.summary).toContain("1 sequence(s) with gaps");
    expect(gaps.summary).toContain("report was not written");
  });

  it("lists the problems of a refused render plan (errors[]), not only findings", () => {
    const refused = classifyStageResult("render", { ok: false, error: "plan_invalid", errors: [{ code: "comp_not_found", comp: "Ghost", message: "No comp named Ghost." }, { code: "output_collision", item: 3, message: "Items 1 and 3 write the same file." }] });
    expect(refused.status).toBe("blocked");
    expect(refused.findings.map((f) => [f.message, f.where])).toEqual([["No comp named Ghost.", "Ghost"], ["Items 1 and 3 write the same file.", "item 3"]]);
  });

  it("reads failures and unconfirmed writes", () => {
    expect(classifyStageResult("save", { ok: false, error: "bad_args", message: "nope" })).toMatchObject({ status: "blocked", summary: "bad_args: nope" });
    expect(classifyStageResult("save", { applied: true, receipt: { matches: false, mismatches: [{ path: "dirty", message: "still dirty" }] } }).status).toBe("blocked");
    const rb = classifyStageResult("save", { applied: true, receipt: { matches: false, mismatches: [{ path: "read_back", message: "x" }] } });
    expect(rb).toMatchObject({ status: "blocked", unverified: true });
    expect(classifyStageResult("save", { applied: true, receipt: { matches: true, mismatches: [] } }).status).toBe("ok");
    expect(classifyStageResult("loudness", { verdict: "fail" }).status).toBe("blocked");
    expect(classifyStageResult("loudness", { pass: false }).status).toBe("blocked");
    expect(classifyStageResult("collect", null).status).toBe("ok");
  });

  it("bounds the findings", () => {
    const findings = Array.from({ length: 40 }, (_, i) => ({ severity: "note", message: `n${i}` }));
    expect(classifyStageResult("preflight", { verdict: "clear", findings }).findings).toHaveLength(10);
  });
});

describe("worstOf and applyFailOn", () => {
  it("picks the worst and ignores skipped", () => {
    expect(worstOf(["ok", "skipped"])).toBe("ok");
    expect(worstOf(["ok", "warn", "skipped"])).toBe("warn");
    expect(worstOf(["warn", "blocked"])).toBe("blocked");
    expect(worstOf([])).toBe("ok");
  });
  it("turns a warning into a stop for a strict stage", () => {
    const strict = normalizeStages([{ kind: "house_style", fail_on: "warning" }])[0];
    const lax = normalizeStages([{ kind: "house_style" }])[0];
    const warn = { status: "warn" as const, summary: "x", findings: [] };
    expect(applyFailOn(warn, strict).status).toBe("blocked");
    expect(applyFailOn(warn, lax).status).toBe("warn");
  });
});

describe("render outputs", () => {
  it("finds job ids in the shapes a render tool may use", () => {
    expect(extractJobIds({ job_id: "a" })).toEqual(["a"]);
    expect(extractJobIds({ job_ids: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(extractJobIds({ jobs: [{ job_id: "a" }, { job_id: "b" }, "junk"] })).toEqual(["a", "b"]);
    expect(extractJobIds(null)).toEqual([]);
    expect(extractJobIds({ jobs: [{ nope: 1 }] })).toEqual([]);
  });

  it("finds the batch a render started and reads the files of a finished one", () => {
    expect(extractBatchId({ ok: true, batch_id: "batch_1_abcdef", items: [] })).toBe("batch_1_abcdef");
    expect(extractBatchId({ ok: true })).toBeUndefined();
    expect(extractBatchId(null)).toBeUndefined();
    // the start result's items are not files yet: no job ids or outputs are read from them
    expect(extractJobIds({ batch_id: "batch_1_abcdef", items: [{ job_id: "j1", output_path: "C:/o/a.mov" }] })).toEqual([]);
    expect(extractOutputs({ batch_id: "batch_1_abcdef", items: [{ job_id: "j1", output_path: "C:/o/a.mov" }] })).toEqual([]);
    const outs = batchOutputs([
      { state: "succeeded", output_path: "C:/o/a.mov", job_id: "j1" },
      { state: "failed", output_path: "C:/o/b.mov" },
      { state: "skipped", output_path: "C:/o/c.mov" },
      { state: "pending", output_path: "C:/o/d.mov" },
      { state: "succeeded", output_path: "C:/o/e_[#####].png" },
    ]);
    expect(outs).toEqual([{ path: "C:/o/a.mov", job_id: "j1" }, { path: "C:/o/c.mov" }, { path: "C:/o/e_[#####].png", sequence: true }]);
    // the comp an item came from is kept: a reframed copy is verified against its own comp
    expect(batchOutputs([{ state: "skipped", comp: "Promo_9x16", output_path: "C:/o/x.mov" }])).toEqual([{ path: "C:/o/x.mov", comp: "Promo_9x16" }]);
    // a batch of 600 items is followed to its last file
    const many = Array.from({ length: 600 }, (_, i) => ({ state: "succeeded", output_path: `C:/o/f${i}.mov` }));
    expect(batchOutputs(many)).toHaveLength(500);
  });

  it("finds output files and marks image-sequence patterns", () => {
    const outs = extractOutputs({ output_path: "C:/o/a.mp4", job_id: "j1", outputs: [{ path: "C:/o/b.mov" }, "C:/o/c_[#####].png", { path: "C:/o/a.mp4" }] });
    expect(outs).toEqual([{ path: "C:/o/a.mp4", job_id: "j1" }, { path: "C:/o/b.mov" }, { path: "C:/o/c_[#####].png", sequence: true }]);
    expect(extractOutputs({})).toEqual([]);
  });

  it("picks the argument each stage kind takes for an output", () => {
    expect(outputArgsFor("verify", { job_id: "j", path: "C:/a.mp4" })).toEqual({ job_id: "j" });
    expect(outputArgsFor("verify", { path: "C:/a.mp4" })).toEqual({ path: "C:/a.mp4" });
    expect(outputArgsFor("scrub", { job_id: "j", path: "C:/a.mp4" })).toEqual({ path: "C:/a.mp4" });
    expect(outputArgsFor("scrub", { path: "C:/a_[###].png", sequence: true })).toBeNull();
    expect(outputArgsFor("verify", { path: "C:/a_[###].png", sequence: true })).toBeNull();
    expect(outputArgsFor("scrub", { job_id: "j" })).toBeNull();
  });
});

describe("buildStageArgs", () => {
  const tool = (keys: string[]): ToolDefinition<any> => fakeTool("t", keys, async () => ({}));
  const run = { comp_id: 7, comp_name: "Promo", project_path: "C:/p/show.aep" };

  it("fills the comp and the guard where the tool takes them and the recipe left them out", () => {
    const def = normalizeStages([{ kind: "render", args: { outputs: [1] } }])[0];
    expect(buildStageArgs(def, tool(["comp_id", "comp_name", "outputs", "expect"]), run)).toEqual({ outputs: [1], comp_id: 7, comp_name: "Promo", expect: { project_path: "C:/p/show.aep" } });
    expect(buildStageArgs(def, tool(["outputs"]), run)).toEqual({ outputs: [1] });
    const own = normalizeStages([{ kind: "render", args: { comp_id: 9 } }])[0];
    expect(buildStageArgs(own, tool(["comp_id", "comp_name"]), run)).toMatchObject({ comp_id: 9, comp_name: "Promo" });
  });

  it("fills comps (names) for the render batch, comp_id for loudness unless it names its own target, and copies for collect", () => {
    const batch = normalizeStages([{ kind: "render", args: { output_dir: "C:/o" } }])[0];
    expect(buildStageArgs(batch, { ...tool(["comps", "output_dir", "expect"]) }, run)).toEqual({ output_dir: "C:/o", comps: ["Promo"], expect: { project_path: "C:/p/show.aep" } });
    const loud = normalizeStages([{ kind: "loudness" }])[0];
    expect(buildStageArgs(loud, tool(["comp_id", "job_id", "audio_path", "expect"]), run)).toEqual({ comp_id: 7, expect: { project_path: "C:/p/show.aep" } });
    const ownFile = normalizeStages([{ kind: "loudness", args: { audio_path: "C:/o/mix.wav" } }])[0];
    expect(buildStageArgs(ownFile, tool(["comp_id", "job_id", "audio_path", "expect"]), run)).not.toHaveProperty("comp_id");
    const collect = normalizeStages([{ kind: "collect", args: { dest: DEST_D } }])[0];
    expect(buildStageArgs(collect, tool(["dest", "dry_run", "expect"]), run)).toMatchObject({ dest: DEST_D, dry_run: false });
    const asked = normalizeStages([{ kind: "collect", args: { dest: DEST_D, dry_run: true } }])[0];
    expect(buildStageArgs(asked, tool(["dest", "dry_run"]), run)).toMatchObject({ dry_run: true });
    expect(stagePrecheck(normalizeStages([{ kind: "collect" }])[0])).toContain("args.dest");
    expect(stagePrecheck(collect)).toBeNull();
  });

  it("keeps comp_id for a verify of a file by path, but not for a verify of a job or a scrub of a file", () => {
    const verify = normalizeStages([{ kind: "verify" }])[0];
    const scrub = normalizeStages([{ kind: "scrub" }])[0];
    const keys = ["comp_id", "job_id", "path", "expect"];
    // a job names its own comp: filling the recipe's would compare a reframed copy with the wrong comp
    expect(buildStageArgs(verify, tool(keys), run, { job_id: "j" })).not.toHaveProperty("comp_id");
    expect(buildStageArgs(verify, tool(keys), run, { job_id: "j" })).toMatchObject({ job_id: "j" });
    expect(buildStageArgs(verify, tool(keys), run, { path: "C:/a.mp4" })).toMatchObject({ comp_id: 7, path: "C:/a.mp4" });
    const own = normalizeStages([{ kind: "verify", args: { comp_id: 9 } }])[0];
    expect(buildStageArgs(own, tool(keys), run, { job_id: "j" })).toMatchObject({ comp_id: 9, job_id: "j" });
    expect(buildStageArgs(scrub, tool(keys), run, { path: "C:/a.mp4" })).not.toHaveProperty("comp_id");
    expect(buildStageArgs(scrub, tool(keys), run)).toMatchObject({ comp_id: 7 });
  });

  it("detects keys through refinements and passes unknown shapes", () => {
    const refined = z.object({ a: z.string().optional() }).refine(() => true);
    expect(schemaAcceptsKey(refined, "a")).toBe(true);
    expect(schemaAcceptsKey(refined, "b")).toBe(false);
    expect(schemaAcceptsKey(z.any(), "b")).toBe(true);
  });
});

describe("describeError", () => {
  it("separates failures before a write from ones that may be after it", () => {
    expect(describeError(new BridgeError({ kind: "guard", message: "g" }))).toMatchObject({ error: "guard", applied: false });
    expect(describeError(new BridgeError({ kind: "timeout", message: "t" }))).toMatchObject({ error: "timeout", applied: "unknown" });
    expect(describeError(new Error("boom"))).toMatchObject({ error: "error", applied: "unknown" });
  });
});

function stage(id: string, status: StageState["status"], over: Partial<StageDef> = {}): StageState {
  const def = { ...normalizeStages([{ kind: "save" }])[0], id, ...over };
  return { id, kind: def.kind, tool: def.tool, def, status, attempts: 1 };
}
function runOf(stages: StageState[]): Run {
  return {
    id: "dl_x",
    recipe: "Acme",
    project_path: "C:/p/show.aep",
    checkpoint_mode: "each_write",
    created_at: "t0",
    updated_at: "t1",
    state: "in_progress",
    stages,
    outputs: [],
    checkpoints_taken: 0,
  };
}

describe("run state", () => {
  it("is done when every stage passed, an optional unavailable one included", () => {
    const r = runOf([stage("a", "ok"), stage("b", "warn"), stage("c", "skipped"), stage("d", "unavailable", { optional: true })]);
    expect(currentStage(r)).toBeUndefined();
    expect(deriveState(r)).toBe("done");
  });
  it("stops at the first stage that has not passed", () => {
    expect(deriveState(runOf([stage("a", "ok"), stage("b", "blocked"), stage("c", "pending")]))).toBe("blocked");
    expect(deriveState(runOf([stage("a", "ok"), stage("b", "unavailable", { optional: false })]))).toBe("blocked");
    expect(deriveState(runOf([stage("a", "ok"), stage("b", "running")]))).toBe("waiting");
    expect(deriveState(runOf([stage("a", "ok"), stage("b", "pending")]))).toBe("in_progress");
    expect(deriveState(runOf([stage("a", "error")]))).toBe("blocked");
    expect({ ...runOf([stage("a", "pending")]), state: "cancelled" as const }).toSatisfy((r: Run) => deriveState(r) === "cancelled");
  });
  it("says what to do next", () => {
    expect(nextHint({ ...runOf([stage("a", "blocked")]), state: "blocked" })).toContain("retry");
    expect(nextHint({ ...runOf([stage("a", "running")]), state: "waiting" })).toContain("next");
    expect(nextHint({ ...runOf([stage("a", "ok")]), state: "done" })).toContain("complete");
    expect(nextHint({ ...runOf([stage("a", "unavailable", { optional: false })]), state: "blocked" })).toContain("doesn't have");
  });
  it("writes a report with the stages, acknowledgements and outputs", () => {
    const a = stage("a", "ok");
    a.summary = "saved";
    a.checkpoint = { status: "created", path: "C:/cp.aep" };
    const b = stage("b", "skipped");
    b.acknowledged = "Jay accepts the pop at 2s";
    b.children = [{ output: "C:/o/a.mp4", status: "warn", summary: "pop" }];
    b.findings = [{ severity: "warning", message: "pop at 2s", where: "t=2s" }];
    const r = { ...runOf([a, b]), outputs: [{ path: "C:/o/a.mp4", job_id: "j1" }], comp_name: "Promo", ae_version: "26.2" };
    const text = renderReport(r);
    expect(text).toContain("Delivery report: Acme");
    expect(text).toContain("a (ae_save): ok - saved");
    expect(text).toContain("accepted by hand: Jay accepts the pop at 2s");
    expect(text).toContain("checkpoint created: C:/cp.aep");
    expect(text).toContain("C:/o/a.mp4 (job j1)");
    expect(text).toContain("[warning] pop at 2s (t=2s)");
  });
});

// ---------- the record next to the project ----------

describe("store", () => {
  it("saves beside the project and loads it back", () => {
    const projectPath = tempProject();
    const store = loadStore(projectPath);
    store.recipes.push({ name: "Acme", checkpoint_mode: "none", stages: normalizeStages([{ kind: "save" }]), updated_at: "now" });
    const saved = saveStore(projectPath, store);
    expect(saved.file).toBe(deliverPath(projectPath));
    expect(deliverPath("C:/x/show.aep")).toMatch(/show\.deliver\.json$/);
    clearDeliverMemory();
    expect(loadStore(projectPath).recipes.map((r) => r.name)).toEqual(["Acme"]);
  });

  it("keeps a file it cannot parse aside instead of overwriting it", () => {
    const projectPath = tempProject();
    fs.writeFileSync(deliverPath(projectPath), "{ not json");
    expect(loadStore(projectPath).recipes).toEqual([]);
    expect(fs.readdirSync(path.dirname(projectPath)).some((n) => n.endsWith(".bak"))).toBe(true);
  });

  it("does not fall back to an empty store when the file exists but cannot be read, so nothing overwrites it", () => {
    const projectPath = tempProject();
    // a directory where the file should be: reading it fails with EISDIR, not ENOENT (as a file locked by Dropbox would)
    fs.mkdirSync(deliverPath(projectPath));
    expect(() => loadStore(projectPath)).toThrow(StoreUnreadableError);
    expect(() => loadStore(projectPath)).toThrow(/could not be read/);
    // a file that is simply not there is an empty store
    expect(loadStore(tempProject()).recipes).toEqual([]);
  });

  it("keeps only the latest runs and works for an unsaved project in memory", () => {
    const store = loadStore("<unsaved>");
    for (let i = 0; i < 25; i++) store.runs.push({ ...runOf([stage("a", "ok")]), id: `dl_${i}` });
    const saved = saveStore("<unsaved>", store);
    expect(saved.file).toBeNull();
    expect(store.runs).toHaveLength(20);
    expect(loadStore("<unsaved>").runs[0].id).toBe("dl_5");
  });
});

// ---------- the flow, with a fake AE and fake tools ----------

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-deliver-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "show.aep");
  fs.writeFileSync(file, "aep");
  return file;
}

function fakeTool(name: string, keys: string[], handler: (args: any) => Promise<unknown>): ToolDefinition<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const k of keys) shape[k] = z.unknown().optional();
  return { name, description: "fake", schema: z.object(shape), handler: async (a: any) => handler(a) };
}

interface Call {
  name: string;
  args: any;
}

function world(opts: { guardFails?: boolean; compFound?: boolean; unsaved?: boolean } = {}) {
  const projectPath = opts.unsaved ? "<unsaved>" : tempProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-deliver-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const state = { guardFails: opts.guardFails ?? false, compFound: opts.compFound ?? true, dirty: false, listCompsTimeout: false };
  const reads: any[] = [];
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      let result: unknown;
      if (fn === "deliverRead") {
        reads.push(args);
        if (state.listCompsTimeout && args.list_comps === true) throw new BridgeError({ kind: "timeout", message: "AE did not answer the comp list" });
        if (state.guardFails) result = { guard_failed: true, project_path: "C:/other.aep" };
        else {
          result = {
            project_path: projectPath,
            saved: !opts.unsaved,
            dirty: state.dirty,
            ae_version: "26.2.1",
            comp: args.comp_id !== undefined && state.compFound ? { id: args.comp_id, name: "Promo", width: 1920, height: 1080, fps: 25, duration: 10 } : null,
            comp_found: args.comp_id !== undefined ? state.compFound : null,
            comps: args.list_comps === true ? [{ id: 7, name: "Promo" }, { id: 8, name: "Promo_9x16" }] : null,
            render_queue: { num_items: 0, items: [] },
          };
        }
      } else throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  const calls: Call[] = [];
  const tools = new Map<string, ToolDefinition<any>>();
  const reply: Record<string, (args: any) => unknown | Promise<unknown>> = {};
  /** Registers a fake tool that records its calls and answers from `reply[name]`. */
  const add = (name: string, keys: string[] | z.ZodTypeAny, answer: (args: any) => unknown | Promise<unknown>) => {
    reply[name] = answer;
    const handler = async (args: any) => {
      calls.push({ name, args });
      return reply[name](args);
    };
    // a list of keys makes a loose fake; a schema makes the tool take exactly what the real one takes
    tools.set(name, Array.isArray(keys) ? fakeTool(name, keys, handler) : { name, description: "fake", schema: keys, handler });
  };
  setDeliverToolLookup(async (n) => tools.get(n));
  const expectArg = { project_path: projectPath };
  const recipe = async (over: Record<string, unknown>) => (await recipeTool.handler(AeDeliverRecipeSchema.parse({ expect: expectArg, ...over }), ctx)) as any;
  const step = async (over: Record<string, unknown>) => (await stepTool.handler(AeDeliverStepSchema.parse({ expect: expectArg, ...over }), ctx)) as any;
  const status = async (over: Record<string, unknown> = {}) => (await statusTool.handler(AeDeliverStatusSchema.parse({ expect: expectArg, ...over }), ctx)) as any;
  return { projectPath, ctx, calls, add, tools, reply, state, reads, recipe, step, status, expectArg };
}

type World = ReturnType<typeof world>;

const names = (w: World) => w.calls.map((c) => c.name);

const BATCH_ID = "batch_1700000000_abc123";

/** The items of ae_render_batch's answers, in the shape the real tool reports (itemView in renderbatch.ts). */
function batchItems(kind: "start" | "running" | "succeeded" | "failed" | "skipped") {
  const base = (index: number, spec: string) => ({ index, comp: "Promo", spec, frames: 250, output_path: `C:/o/Promo_${spec}.mov` });
  if (kind === "start") return [{ ...base(1, "yt"), state: "running", percent: 0, job_id: "j1" }, { ...base(2, "ig"), state: "pending" }];
  if (kind === "running") return [{ ...base(1, "yt"), state: "running", percent: 40, job_id: "j1" }, { ...base(2, "ig"), state: "pending" }];
  if (kind === "failed") return [{ ...base(1, "yt"), state: "failed", job_id: "j1", error: "aerender exited with code 1" }, { ...base(2, "ig"), state: "pending" }];
  if (kind === "skipped") return [{ ...base(1, "yt"), state: "succeeded", job_id: "j1" }, { ...base(2, "ig"), state: "skipped", note: "output exists" }];
  return [{ ...base(1, "yt"), state: "succeeded", job_id: "j1", output_bytes: 100 }, { ...base(2, "ig"), state: "succeeded", job_id: "j2", output_bytes: 90 }];
}

const batchStatus = (state: string, kind: Parameters<typeof batchItems>[0], runnerActive = false) => ({
  ok: true,
  batch_id: BATCH_ID,
  state,
  runner_active: runnerActive,
  items: batchItems(kind),
});

const LOUD_PASS = { ok: true, state: "done", comp_id: 7, measurement: { integrated_lufs: -23.1, true_peak_dbtp: -2.4 }, verdict: { measurable: true, passes: true, loudness_ok: true, true_peak_ok: true, advice: [] } };

/**
 * The fake tools a full delivery uses, all answering ok. The render batch, loudness and collect take the real
 * tools' schemas and answer in the real tools' shapes; verify and scrub leave the project changed, as the real
 * ones do (they import a file and remove it), and the collect refuses a changed project.
 */
function addAll(w: World) {
  w.add("ae_preflight", ["scope", "comp_ids", "cursor"], () => ({ ok: true, verdict: "clear", complete: true, counts: { blocker: 0, warning: 0, note: 0 }, findings: [] }));
  w.add("ae_house_style_check", ["comp_id"], () => ({ ok: true, clean: true, counts: { medium: 0, low: 0, info: 0 }, findings: [] }));
  w.add("ae_checkpoint_create", ["expect", "label"], () => ({ applied: true, checkpoint_path: "C:/cp/show_1.aep", receipt: { matches: true, mismatches: [] } }));
  w.add("ae_save", ["expect", "backup"], () => {
    // the real ae_save refuses a project that has no file yet
    if (w.projectPath === "<unsaved>") throw new BridgeError({ kind: "guard", message: "The project has never been saved; ae_save needs a file path." });
    w.state.dirty = false;
    return { applied: true, receipt: { matches: true, mismatches: [] } };
  });
  w.add("ae_render_batch", AeRenderBatchStartSchema, () => ({ ok: true, applied: true, batch_id: BATCH_ID, state: "running", counts: { running: 1, pending: 1 }, items: batchItems("start") }));
  w.add("ae_render_batch_status", AeRenderBatchStatusSchema, () => batchStatus("succeeded", "succeeded"));
  w.add("ae_render_batch_cancel", AeRenderBatchCancelSchema, () => ({ ok: true, batch_id: BATCH_ID, state: "cancelled", cancelled: true }));
  w.add("ae_verify_render", ["job_id", "path", "comp_id", "expect"], () => {
    w.state.dirty = true;
    return { ok: true, matches: true, imported_item_state: "removed" };
  });
  w.add("ae_scrub_check", ["comp_id", "path", "expect"], () => {
    w.state.dirty = true;
    return { ok: true, verdict: "pass" };
  });
  w.add("ae_loudness_check", AeLoudnessCheckSchema, () => {
    // comp mode renders the saved project: it refuses a project with unsaved changes
    if (w.state.dirty) return { ok: false, error: "bad_args", message: "The project has unsaved changes. Save it first (ae_save)." };
    return LOUD_PASS;
  });
  w.add("ae_collect_files", AeCollectFilesSchema, (a) => {
    if (w.state.dirty) return { ok: false, error: "bad_args", message: "The project has unsaved changes. The .aep on disk is what gets copied, so save first (ae_save) and call again." };
    if (a.dry_run !== false) return { dry_run: true, files: 3, next: "Call again with dry_run: false to copy." };
    return { dry_run: false, complete: true, files_done: 3, files_total: 3, remaining: 0, errors_total: 0 };
  });
}

const RENDER_ARGS = { output_dir: "C:/o", specs: [{ name: "yt" }, { name: "ig" }] };
const FULL = [
  { kind: "preflight" },
  { kind: "house_style" },
  { kind: "save" },
  { kind: "render", args: RENDER_ARGS },
  { kind: "verify" },
  { kind: "scrub" },
  { kind: "save", id: "save_final", checkpoint: false },
  { kind: "loudness" },
  { kind: "collect", args: { dest: DEST_ACME } },
];

describe("ae_deliver_recipe", () => {
  it("sets a recipe with the default stages, checks the comp, warns about gaps and lists it", async () => {
    const w = world();
    w.add("ae_preflight", ["comp_ids"], () => ({}));
    const set = await w.recipe({ action: "set", name: "Acme YouTube", comp_id: 7 });
    expect(set).toMatchObject({ ok: true, applied: true, replaced: false });
    expect(set.recipe.stages.map((s: StageDef) => s.id)).toEqual(["preflight", "house_style", "save", "render", "verify", "scrub", "save_final", "loudness", "collect"]);
    expect(set.warnings.some((x: string) => x.startsWith("render:") && x.includes("not registered"))).toBe(true);
    expect(set.warnings.some((x: string) => x.includes("no args"))).toBe(true);
    expect(set.warnings.some((x: string) => x.startsWith("collect:") && x.includes("args.dest"))).toBe(true);
    expect(w.reads[0].comp_id).toBe(7);
    expect(fs.existsSync(deliverPath(w.projectPath))).toBe(true);
    const list = await w.recipe({ action: "list" });
    expect(list.recipes).toHaveLength(1);
    expect(list.recipes[0]).toMatchObject({ name: "Acme YouTube", comp_id: 7, checkpoint_mode: "each_write" });
  });

  it("keeps the stages of an existing recipe when set leaves them out, and replaces it otherwise", async () => {
    const w = world();
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }], checkpoint_mode: "none" });
    const changed = await w.recipe({ action: "set", name: "Acme", notes: "spec v2" });
    expect(changed).toMatchObject({ replaced: true });
    expect(changed.recipe.stages.map((s: StageDef) => s.id)).toEqual(["save"]);
    expect(changed.recipe).toMatchObject({ notes: "spec v2", checkpoint_mode: "none" });
    const swapped = await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save" }] });
    expect(swapped.recipe.stages).toHaveLength(2);
    expect(swapped.recipe.checkpoint_mode).toBe("none");
  });

  it("refuses an unknown comp without writing", async () => {
    const w = world({ compFound: false });
    const res = await w.recipe({ action: "set", name: "Acme", comp_id: 99 });
    expect(res).toMatchObject({ ok: false, error: "not_found", applied: false });
    expect(fs.existsSync(deliverPath(w.projectPath))).toBe(false);
  });

  it("gets a recipe with each tool's availability, and deletes it", async () => {
    const w = world();
    w.add("ae_save", ["expect"], () => ({}));
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }, { kind: "loudness" }] });
    const got = await w.recipe({ action: "get", name: "Acme" });
    expect(got.recipe.stages.map((s: any) => [s.id, s.available])).toEqual([["save", true], ["loudness", false]]);
    expect(await w.recipe({ action: "get", name: "Nope" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await w.recipe({ action: "delete", name: "Acme" })).toMatchObject({ ok: true, applied: true, deleted: "Acme" });
    expect(await w.recipe({ action: "delete", name: "Acme" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("stops on a failed target guard before reading or writing anything", async () => {
    const w = world({ guardFails: true });
    await expect(w.recipe({ action: "set", name: "Acme" })).rejects.toMatchObject({ kind: "guard" });
    expect(fs.existsSync(deliverPath(w.projectPath))).toBe(false);
  });
});

describe("ae_deliver_step: a full delivery", () => {
  it("runs the stages in order, follows the render batch, checks each file and finishes with a clean project", async () => {
    const w = world();
    addAll(w);
    // The save rewrites the .aep, so the checkpoint before the render is a new copy.
    w.reply.ae_save = () => {
      fs.writeFileSync(w.projectPath, "aep saved, longer");
      w.state.dirty = false;
      return { applied: true, receipt: { matches: true, mismatches: [] } };
    };
    const states = [batchStatus("running", "running", true)];
    w.reply.ae_render_batch_status = () => states.shift() ?? batchStatus("succeeded", "succeeded");
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: FULL });

    const started = await w.step({ action: "start", recipe: "Acme" });
    expect(started).toMatchObject({ ok: true, state: "waiting", stopped_at: "render" });
    expect(names(w)).toEqual(["ae_preflight", "ae_house_style_check", "ae_checkpoint_create", "ae_save", "ae_checkpoint_create", "ae_render_batch"]);
    // the comp and the guard are filled in, the recipe's args are kept; the batch takes comp names
    expect(w.calls[0].args).toEqual({ comp_ids: [7] });
    expect(w.calls[1].args).toEqual({ comp_id: 7 });
    expect(w.calls[3].args).toEqual({ expect: { project_path: w.projectPath } });
    expect(w.calls[5].args).toMatchObject({ comps: ["Promo"], output_dir: "C:/o", specs: [{ name: "yt" }, { name: "ig" }], expect: { project_path: w.projectPath } });
    expect(w.calls[5].args).not.toHaveProperty("comp_id");
    // the batch is followed, not read: the items are not files yet
    const render = started.stages.find((s: any) => s.id === "render");
    expect(render).toMatchObject({ status: "running", batch_id: BATCH_ID });
    expect(render.job_ids).toBeUndefined();
    expect(started.outputs).toEqual([]);
    expect(started.stages.find((s: any) => s.id === "save").checkpoint).toMatchObject({ status: "created", path: "C:/cp/show_1.aep" });
    expect(started.report).toBeUndefined();
    expect(started.next).toContain("next");

    const polled = await w.step({ action: "next" });
    expect(polled.state).toBe("waiting");
    expect(polled.stages.find((s: any) => s.id === "render").summary).toContain("0 of 2");
    expect(polled.outputs).toEqual([]);
    expect(w.calls.filter((c) => c.name === "ae_render_batch_status")[0].args).toEqual({ batch_id: BATCH_ID });

    const before = w.calls.length;
    const done = await w.step({ action: "next" });
    expect(done).toMatchObject({ ok: true, state: "done" });
    const after = w.calls.slice(before).map((c) => c.name);
    expect(after.filter((n) => n === "ae_render_batch_status")).toHaveLength(1);
    expect(after.filter((n) => n === "ae_verify_render")).toHaveLength(2);
    // after the render: verify and scrub (which leave the project changed), then the second save, then loudness and collect
    expect(after.filter((n) => !["ae_checkpoint_create"].includes(n))).toEqual([
      "ae_render_batch_status",
      "ae_verify_render",
      "ae_verify_render",
      "ae_scrub_check",
      "ae_scrub_check",
      "ae_save",
      "ae_loudness_check",
      "ae_collect_files",
    ]);
    const verifyCalls = w.calls.filter((c) => c.name === "ae_verify_render").map((c) => c.args);
    expect(verifyCalls.map((a) => a.job_id)).toEqual(["j1", "j2"]);
    expect(verifyCalls[0]).not.toHaveProperty("comp_id");
    const scrubCalls = w.calls.filter((c) => c.name === "ae_scrub_check").map((c) => c.args);
    expect(scrubCalls.map((a) => a.path)).toEqual(["C:/o/Promo_yt.mov", "C:/o/Promo_ig.mov"]);
    expect(scrubCalls[0]).not.toHaveProperty("comp_id");
    // loudness measures the comp's audio (once), collect really copies
    const loud = w.calls.filter((c) => c.name === "ae_loudness_check");
    expect(loud).toHaveLength(1);
    expect(loud[0].args).toMatchObject({ comp_id: 7, expect: { project_path: w.projectPath } });
    expect(loud[0].args).not.toHaveProperty("path");
    expect(w.calls.find((c) => c.name === "ae_collect_files")!.args).toMatchObject({ dest: DEST_ACME, dry_run: false });
    expect(done.stages.find((s: any) => s.id === "verify").outputs).toHaveLength(2);
    expect(done.stages.find((s: any) => s.id === "loudness").summary).toContain("-23.1 LUFS");
    expect(done.stages.find((s: any) => s.id === "collect").summary).toContain("collected 3");
    expect(done.outputs).toEqual([{ path: "C:/o/Promo_yt.mov", job_id: "j1", comp: "Promo" }, { path: "C:/o/Promo_ig.mov", job_id: "j2", comp: "Promo" }]);
    expect(done.report).toContain("Delivery report: Acme");
    expect(done.next).toContain("complete");

    // the record is on disk and the status tool reads it; the project ended clean, so no "changes after delivery" note
    const onDisk = JSON.parse(fs.readFileSync(deliverPath(w.projectPath), "utf8"));
    expect(onDisk.runs[0].state).toBe("done");
    expect(onDisk.runs[0].project_dirty_at_end).toBe(false);
    const shown = await w.status();
    expect(shown).toMatchObject({ ok: true, state: "done", run_id: done.run_id });
    expect(shown.note).toBeUndefined();
    expect(shown.report).toContain("Outputs");
    const listed = await w.status({ list: true });
    expect(listed.runs).toHaveLength(1);
  });

  it("stops at the loudness on a project that verify left changed (no second save), and goes on after a save", async () => {
    const w = world();
    addAll(w);
    // the recipe the reviewer found stuck: no save between verify and scrub and the stages that refuse a changed project
    const noSecondSave = FULL.filter((s: any) => s.id !== "save_final");
    await w.recipe({ action: "set", name: "Stuck", comp_id: 7, stages: noSecondSave });
    await w.step({ action: "start", recipe: "Stuck" });
    const blocked = await w.step({ action: "next" });
    expect(blocked).toMatchObject({ ok: false, state: "blocked", stopped_at: "loudness" });
    expect(blocked.stages.find((s: any) => s.id === "loudness").summary).toContain("unsaved changes");
    expect(names(w)).not.toContain("ae_collect_files");
    w.state.dirty = false;
    const retried = await w.step({ action: "retry", stage: "loudness" });
    expect(retried).toMatchObject({ ok: true, state: "done" });
    expect(names(w)).toContain("ae_collect_files");
    expect((await w.status()).note).toBeUndefined();
  });

  it("blocks the collect on a project with unsaved changes and never reports it as done", async () => {
    const w = world();
    addAll(w);
    w.state.dirty = true;
    await w.recipe({ action: "set", name: "C", stages: [{ kind: "collect", args: { dest: DEST_D } }] });
    const res = await w.step({ action: "start", recipe: "C" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "collect" });
    expect(res.stages[0].summary).toContain("unsaved changes");
  });

  it("says in the status when the delivery itself left the project changed, not when later edits did", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_collect_files = () => ({ dry_run: false, complete: true, files_done: 1, files_total: 1, remaining: 0, errors_total: 0 });
    await w.recipe({ action: "set", name: "Own", comp_id: 7, stages: [{ kind: "render", args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Own" });
    const done = await w.step({ action: "next" });
    expect(done.state).toBe("done");
    expect(w.state.dirty).toBe(true);
    const shown = await w.status();
    expect(shown.note).toContain("its own stages");
  });

  it("notes edits made after a clean delivery", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Clean", stages: [{ kind: "save", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Clean" });
    w.state.dirty = true;
    expect((await w.status()).note).toContain("made after this delivery ran");
  });

  it("stops at a blocker, keeps later stages from running, and goes on after a retry", async () => {
    const w = world();
    addAll(w);
    let verdict = "blocked";
    w.reply.ae_preflight = () => ({ ok: true, verdict, complete: true, counts: { blocker: verdict === "blocked" ? 1 : 0 }, findings: verdict === "blocked" ? [{ severity: "blocker", message: "Missing footage: clip.mov", where: { item: "clip.mov" } }] : [] });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save" }] });
    const first = await w.step({ action: "start", recipe: "Acme" });
    expect(first).toMatchObject({ ok: false, error: "delivery_blocked", state: "blocked", stopped_at: "preflight" });
    expect(first.stages[0].findings[0].message).toContain("Missing footage");
    expect(first.report).toContain("Stopped:");
    expect(names(w)).toEqual(["ae_preflight"]);
    // next does not run past a blocker
    const again = await w.step({ action: "next" });
    expect(again).toMatchObject({ state: "blocked", stopped_at: "preflight" });
    expect(names(w)).toEqual(["ae_preflight"]);
    // fixed: retry runs the stage again, then the rest
    verdict = "clear";
    const retried = await w.step({ action: "retry", stage: "preflight" });
    expect(retried).toMatchObject({ ok: true, state: "done" });
    expect(names(w)).toEqual(["ae_preflight", "ae_preflight", "ae_checkpoint_create", "ae_save"]);
    expect(retried.stages[0].attempts).toBe(2);
  });

  it("passes a warning but stops on one when the stage says fail_on warning", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_house_style_check = () => ({ ok: true, clean: false, counts: { medium: 1, low: 0, info: 0 }, findings: [{ severity: "medium", message: "Off palette", layer: "Title" }] });
    await w.recipe({ action: "set", name: "Lax", stages: [{ kind: "house_style" }, { kind: "save", checkpoint: false }] });
    const lax = await w.step({ action: "start", recipe: "Lax" });
    expect(lax).toMatchObject({ ok: true, state: "done" });
    expect(lax.stages[0]).toMatchObject({ status: "warn" });
    await w.recipe({ action: "set", name: "Strict", stages: [{ kind: "house_style", fail_on: "warning" }, { kind: "save" }] });
    const strict = await w.step({ action: "start", recipe: "Strict" });
    expect(strict).toMatchObject({ ok: false, state: "blocked", stopped_at: "house_style" });
  });

  it("skips a stopped stage only with an acknowledgement, which the report keeps", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_scrub_check = () => ({ ok: true, verdict: "fail", findings: [{ severity: "high", message: "frozen frames", time: 3 }] });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "scrub", args: { comp_id: 7 } }, { kind: "save", checkpoint: false }] });
    const blocked = await w.step({ action: "start", recipe: "Acme" });
    expect(blocked.state).toBe("blocked");
    expect(() => AeDeliverStepSchema.parse({ action: "skip", expect: w.expectArg })).toThrow();
    expect(await w.step({ action: "skip", stage: "save", acknowledge: "wrong stage on purpose" })).toMatchObject({ ok: false, error: "wrong_stage" });
    const skipped = await w.step({ action: "skip", stage: "scrub", acknowledge: "The freeze is the title hold, Jay confirmed" });
    expect(skipped).toMatchObject({ ok: true, state: "done" });
    expect(skipped.stages[0]).toMatchObject({ status: "skipped", acknowledged: "The freeze is the title hold, Jay confirmed" });
    expect(skipped.report).toContain("accepted by hand: The freeze is the title hold");
  });

  it("reports a missing tool as unavailable: optional stages go on, required ones stop", async () => {
    const w = world();
    addAll(w);
    w.tools.delete("ae_loudness_check");
    w.tools.delete("ae_render_batch");
    await w.recipe({ action: "set", name: "NoLoud", stages: [{ kind: "loudness" }, { kind: "save", checkpoint: false }] });
    const ok = await w.step({ action: "start", recipe: "NoLoud" });
    expect(ok).toMatchObject({ ok: true, state: "done" });
    expect(ok.stages[0]).toMatchObject({ status: "unavailable" });
    expect(ok.stages[0].summary).toContain("not registered");

    await w.recipe({ action: "set", name: "NoRender", stages: [{ kind: "render", args: { outputs: [] } }, { kind: "save" }] });
    const callsBefore = w.calls.length;
    const stopped = await w.step({ action: "start", recipe: "NoRender" });
    expect(stopped).toMatchObject({ ok: false, state: "blocked", stopped_at: "render" });
    expect(stopped.next).toContain("doesn't have");
    expect(w.calls.slice(callsBefore).map((c) => c.name)).not.toContain("ae_save");
    // the tool arrives (another group registered it): retry runs it
    w.add("ae_render_batch", ["outputs"], () => ({ ok: true, outputs: [{ path: "C:/o/a.mp4" }] }));
    const retried = await w.step({ action: "retry" });
    expect(retried).toMatchObject({ ok: true, state: "done" });
    expect(retried.outputs).toEqual([{ path: "C:/o/a.mp4" }]);
  });

  it("makes an unavailable stage optional through the recipe", async () => {
    const w = world();
    addAll(w);
    w.tools.delete("ae_render_batch");
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "render", optional: true }, { kind: "save", checkpoint: false }] });
    expect(await w.step({ action: "start", recipe: "Acme" })).toMatchObject({ ok: true, state: "done" });
  });

  it("takes a checkpoint before the writing stages only, once, and honours the mode", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save" }, { kind: "scrub" }] });
    await w.step({ action: "start", recipe: "Acme" });
    // preflight has none; save gets one; scrub reuses it because the saved file did not change
    expect(names(w)).toEqual(["ae_preflight", "ae_checkpoint_create", "ae_save", "ae_scrub_check"]);
    expect(w.calls[1].args).toEqual({ expect: { project_path: w.projectPath }, label: "deliver save" });
    const run = (await w.status()).stages;
    expect(run.find((s: any) => s.id === "scrub").checkpoint.status).toBe("reused");

    const none = world();
    addAll(none);
    await none.recipe({ action: "set", name: "N", stages: [{ kind: "save" }], checkpoint_mode: "none" });
    await none.step({ action: "start", recipe: "N" });
    expect(names(none)).toEqual(["ae_save"]);
  });

  it("does not run a writing stage when its checkpoint fails", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_checkpoint_create = () => {
      throw new Error("disk full");
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked" });
    expect(res.stages[0]).toMatchObject({ status: "error", applied: false });
    expect(res.stages[0].summary).toContain("did not run");
    expect(names(w)).not.toContain("ae_save");
  });

  it("skips the checkpoint for an unsaved project and keeps the run in memory", async () => {
    const w = world({ unsaved: true });
    addAll(w);
    // a stage that writes but needs no file: the scrub of the comp
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "scrub", args: { comp_id: 7 } }] });
    const run = await w.step({ action: "start", recipe: "Acme" });
    expect(run.state).toBe("done");
    expect(names(w)).toEqual(["ae_scrub_check"]);
    expect(run.stages[0].checkpoint.status).toBe("skipped");
    expect(run.state_file).toBeNull();
    expect(run.state_file_note).toContain("memory");
  });

  it("ends a save of an unsaved project as a guard error, as the real ae_save does, with its checkpoint skipped", async () => {
    const w = world({ unsaved: true });
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }] });
    const run = await w.step({ action: "start", recipe: "Acme" });
    expect(run).toMatchObject({ ok: false, state: "blocked", stopped_at: "save" });
    expect(run.stages[0]).toMatchObject({ status: "error", error: "guard", applied: false });
    expect(run.stages[0].checkpoint.status).toBe("skipped");
  });

  it("turns a tool that throws into an error row with what is known about the write, never a thrown error", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_save = () => {
      throw new BridgeError({ kind: "timeout", message: "AE did not answer" });
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save", checkpoint: false }, { kind: "scrub" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "save" });
    expect(res.stages[0]).toMatchObject({ status: "error", error: "timeout", applied: "unknown" });
    expect(names(w)).toEqual(["ae_save"]);
  });

  it("reports a stage that was running when the run was interrupted, and does not rerun it", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save", checkpoint: false }] });
    const first = await w.step({ action: "start", recipe: "Acme", max_stages: 1 });
    expect(first).toMatchObject({ state: "in_progress", stopped_at: "save" });
    // simulate a crash during the save
    const store = loadStore(w.projectPath);
    store.runs[0].stages[1].status = "in_flight";
    saveStore(w.projectPath, store);
    clearDeliverMemory();
    const res = await w.step({ action: "next" });
    expect(res).toMatchObject({ ok: false, state: "blocked" });
    expect(res.stages[1]).toMatchObject({ status: "error", error: "interrupted", applied: "unknown" });
    expect(names(w)).toEqual(["ae_preflight"]);
  });

  it("honours max_stages and continues with next", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "house_style" }, { kind: "collect", checkpoint: false, args: { dest: DEST_D } }] });
    const one = await w.step({ action: "start", recipe: "Acme", max_stages: 2 });
    expect(one).toMatchObject({ ok: true, state: "in_progress", stopped_at: "collect" });
    expect(names(w)).toEqual(["ae_preflight", "ae_house_style_check"]);
    expect(await w.step({ action: "next" })).toMatchObject({ state: "done" });
  });

  it("refuses a second open run of the same recipe, an unknown recipe and a missing run", async () => {
    const w = world();
    addAll(w);
    expect(await w.step({ action: "start", recipe: "Nope" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await w.step({ action: "next" })).toMatchObject({ ok: false, error: "unknown_run" });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "collect" }] });
    const a = await w.step({ action: "start", recipe: "Acme", max_stages: 1 });
    expect(await w.step({ action: "start", recipe: "Acme" })).toMatchObject({ ok: false, error: "run_open", run_id: a.run_id });
    expect(await w.step({ action: "next", run_id: "dl_nope" })).toMatchObject({ ok: false, error: "unknown_run" });
  });

  it("stops on a failed target guard without running anything", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }] });
    w.state.guardFails = true;
    await expect(w.step({ action: "start", recipe: "Acme" })).rejects.toMatchObject({ kind: "guard" });
    expect(w.calls).toHaveLength(0);
  });

  it("refuses a recipe whose comp is gone", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "save" }] });
    w.state.compFound = false;
    expect(await w.step({ action: "start", recipe: "Acme" })).toMatchObject({ ok: false, error: "not_found", applied: false });
    expect(w.calls).toHaveLength(0);
  });

  it("blocks a stage whose arguments the tool rejects, and takes the fixed definition on retry", async () => {
    const w = world();
    addAll(w);
    w.tools.set("ae_render_batch", { ...w.tools.get("ae_render_batch")!, schema: z.object({ outputs: z.array(z.string()).min(1), expect: z.unknown() }) });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "render", checkpoint: false }] });
    const bad = await w.step({ action: "start", recipe: "Acme" });
    expect(bad).toMatchObject({ ok: false, state: "blocked" });
    expect(bad.stages[0].summary).toContain("rejects the stage's arguments");
    expect(names(w)).toEqual([]);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "render", checkpoint: false, args: { outputs: ["a"] } }] });
    const fixed = await w.step({ action: "retry" });
    expect(fixed.state).not.toBe("blocked");
    expect(w.calls[0].args.outputs).toEqual(["a"]);
  });

  it("follows a preflight cursor to the end", async () => {
    const w = world();
    addAll(w);
    const seen: any[] = [];
    w.reply.ae_preflight = (a) => {
      seen.push(a);
      if (a.cursor === undefined) return { ok: true, verdict: "incomplete", complete: false, cursor: "pf_0123456789", counts: {}, findings: [] };
      return { ok: true, verdict: "blocked", complete: true, counts: { blocker: 1 }, findings: [{ severity: "blocker", message: "Font missing" }] };
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(seen).toEqual([{}, { cursor: "pf_0123456789" }]);
    expect(res).toMatchObject({ state: "blocked", stopped_at: "preflight" });
  });

  it("carries the preflight's own max_slices and budget_ms into every follow-up call", async () => {
    const w = world();
    addAll(w);
    const seen: any[] = [];
    w.add("ae_preflight", z.object({ scope: z.unknown().optional(), comp_ids: z.unknown().optional(), cursor: z.string().optional(), max_slices: z.number().optional(), budget_ms: z.number().optional() }), (a) => {
      seen.push(a);
      if (a.cursor === undefined) return { ok: true, verdict: "incomplete", complete: false, cursor: "pf_0123456789", counts: {}, findings: [] };
      return { ok: true, verdict: "clear", complete: true, counts: {}, findings: [] };
    });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight", args: { max_slices: 5, budget_ms: 8000 } }] });
    await w.step({ action: "start", recipe: "Acme" });
    expect(seen).toEqual([{ max_slices: 5, budget_ms: 8000 }, { max_slices: 5, budget_ms: 8000, cursor: "pf_0123456789" }]);
  });

  /** A world whose render batch has finished with these files. */
  function batchWorld(paths: string[]) {
    const w = world();
    addAll(w);
    const items = paths.map((p, i) => ({ index: i + 1, comp: "Promo", spec: `s${i}`, state: "succeeded", output_path: p, job_id: `j${i + 1}` }));
    w.reply.ae_render_batch_status = () => ({ ok: true, batch_id: BATCH_ID, state: "succeeded", runner_active: false, items });
    return w;
  }

  it("checks every rendered file, reports the worst, and skips image-sequence patterns", async () => {
    const w = batchWorld(["C:/o/a.mp4", "C:/o/b.mp4", "C:/o/frames_[#####].png"]);
    w.reply.ae_scrub_check = (a) => (a.path === "C:/o/b.mp4" ? { ok: true, verdict: "fail", findings: [{ severity: "high", message: "black frames at the end", time: 9 }] } : { ok: true, verdict: "pass" });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    const first = await w.step({ action: "start", recipe: "Acme" });
    expect(first.state).toBe("waiting");
    const res = await w.step({ action: "next" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "scrub" });
    const scrub = res.stages.find((s: any) => s.id === "scrub");
    expect(scrub.outputs.map((c: any) => [c.output, c.status])).toEqual([["C:/o/a.mp4", "ok"], ["C:/o/b.mp4", "blocked"], ["C:/o/frames_[#####].png", "skipped"]]);
    expect(scrub.summary).toContain("1 blocked");
    expect(scrub.findings[0].message).toContain("black frames");
  });

  it("falls back to the comp for a scrub with no files, blocks a verify with none, and measures the comp for loudness", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "scrub", checkpoint: false }, { kind: "loudness" }, { kind: "verify", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(w.calls[0]).toMatchObject({ name: "ae_scrub_check", args: { comp_id: 7 } });
    // loudness does not depend on the render's files: it takes the comp (the project is dirty from the scrub, so the real tool would refuse; the fake does)
    expect(w.calls[1]).toMatchObject({ name: "ae_loudness_check", args: { comp_id: 7 } });
    expect(res.stages.find((s: any) => s.id === "loudness").status).toBe("blocked");
    expect(res).toMatchObject({ state: "blocked", stopped_at: "loudness" });
  });

  it("blocks a verify with no render files", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "verify", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ state: "blocked", stopped_at: "verify" });
    expect(res.stages[0].summary).toContain("no output files");
  });

  it("stops when a render batch fails, names the item, and follows it again after the batch is resumed", async () => {
    const w = world();
    addAll(w);
    let answer: any = batchStatus("failed", "failed");
    w.reply.ae_render_batch_status = () => answer;
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "verify", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "render" });
    expect(res.stages[0].error).toBe("render_failed");
    expect(res.stages[0].summary).toContain("aerender exited with code 1");
    expect(res.stages[0].summary).toContain("ae_render_batch_resume");
    expect(res.next).toContain("'next'");
    expect(names(w)).not.toContain("ae_verify_render");
    // Jay resumes the batch outside the run; next looks at it again and goes on when it has finished
    answer = batchStatus("running", "running", true);
    const again = await w.step({ action: "next" });
    expect(again).toMatchObject({ state: "waiting" });
    answer = batchStatus("succeeded", "succeeded");
    const done = await w.step({ action: "next" });
    expect(names(w).filter((n) => n === "ae_verify_render")).toHaveLength(2);
    expect(done.outputs).toHaveLength(2);
  });

  it("warns, and keeps going, when a batch item stood on a file that already existed", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_render_batch_status = () => batchStatus("succeeded", "skipped");
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res).toMatchObject({ ok: true, state: "done" });
    expect(res.stages[0]).toMatchObject({ status: "warn" });
    expect(res.stages[0].summary).toContain("already existed");
  });

  it("says so when this server stopped driving the batch", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_render_batch_status = () => batchStatus("running", "running", false);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res.state).toBe("waiting");
    expect(res.stages[0].summary).toContain("ae_render_batch_resume");
  });

  it("stops when an aerender job fails, quoting the log", async () => {
    const w = world();
    addAll(w);
    w.add("ae_aerender_start", ["comp_id", "comp_name", "output_path", "expect"], () => ({ ok: true, job_id: "j1", output_path: "C:/o/yt.mp4" }));
    w.add("ae_aerender_status", ["job_id"], () => ({ ok: true, state: "failed", exit_code: 1, log_tail: "Error: out of memory" }));
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", tool: "ae_aerender_start", checkpoint: false, args: { output_path: "C:/o/yt.mp4" } }, { kind: "verify" }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "render" });
    expect(res.stages[0].summary).toContain("out of memory");
    expect(w.calls.find((c) => c.name === "ae_aerender_start")!.args).toMatchObject({ comp_id: 7, comp_name: "Promo" });
  });

  it("looks at a render again after a failed look, and refuses a second render while the first may still run", async () => {
    const w = world();
    addAll(w);
    w.add("ae_aerender_start", ["comp_id", "comp_name", "output_path", "expect"], () => ({ ok: true, job_id: "j1", output_path: "C:/o/yt.mp4" }));
    let lookup: () => unknown = () => {
      throw new Error("job registry unavailable");
    };
    w.add("ae_aerender_status", ["job_id"], () => lookup());
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", tool: "ae_aerender_start", checkpoint: false, args: { output_path: "C:/o/yt.mp4" } }] });
    await w.step({ action: "start", recipe: "Acme" });
    const lost = await w.step({ action: "next" });
    expect(lost.stages[0]).toMatchObject({ status: "error", error: "job_unknown", job_ids: ["j1"] });
    expect(lost.next).toContain("'next'");
    // retry would start new jobs while the old one may still be writing the same file
    const startsBefore = w.calls.filter((c) => c.name === "ae_aerender_start").length;
    expect(await w.step({ action: "retry" })).toMatchObject({ ok: false, error: "jobs_may_be_running" });
    expect(w.calls.filter((c) => c.name === "ae_aerender_start")).toHaveLength(startsBefore);
    // next looks again, and goes on when the job is found
    lookup = () => ({ ok: true, state: "succeeded", percent: 100, output_path: "C:/o/yt.mp4" });
    const found = await w.step({ action: "next" });
    expect(found).toMatchObject({ ok: true, state: "done" });
    expect(found.outputs).toEqual([{ job_id: "j1", path: "C:/o/yt.mp4" }]);
  });

  it("reports a batch whose status tool is missing as unavailable, and polls it again later", async () => {
    const w = world();
    addAll(w);
    w.tools.delete("ae_render_batch_status");
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res.stages[0]).toMatchObject({ status: "error", error: "unavailable", batch_id: BATCH_ID });
    expect(isPollable({ ...stage("r", "error"), kind: "render", error: "unavailable", batch_id: BATCH_ID })).toBe(true);
    w.add("ae_render_batch_status", AeRenderBatchStatusSchema, () => batchStatus("succeeded", "succeeded"));
    expect(await w.step({ action: "next" })).toMatchObject({ ok: true, state: "done" });
  });

  it("cancels a run and the aerender job it started, then refuses to continue it", async () => {
    const w = world();
    addAll(w);
    w.add("ae_aerender_start", ["comp_id", "comp_name", "output_path", "expect"], () => ({ ok: true, job_id: "j1", output_path: "C:/o/yt.mp4" }));
    w.add("ae_aerender_status", ["job_id"], () => ({ ok: true, state: "running", percent: 10 }));
    w.add("ae_aerender_cancel", ["job_id"], () => ({ ok: true }));
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", tool: "ae_aerender_start", checkpoint: false, args: { output_path: "C:/o/yt.mp4" } }, { kind: "verify" }] });
    const started = await w.step({ action: "start", recipe: "Acme" });
    expect(started.state).toBe("waiting");
    const cancelled = await w.step({ action: "cancel" });
    expect(cancelled).toMatchObject({ ok: true, state: "cancelled" });
    expect(w.calls.filter((c) => c.name === "ae_aerender_cancel").map((c) => c.args.job_id)).toEqual(["j1"]);
    expect(await w.step({ action: "next", run_id: started.run_id })).toMatchObject({ ok: false, error: "run_cancelled" });
    // the recipe can be run again
    expect((await w.step({ action: "start", recipe: "Acme" })).run_id).not.toBe(started.run_id);
  });

  it("cancels a run and its render batch", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "verify" }] });
    const started = await w.step({ action: "start", recipe: "Acme" });
    expect(started.state).toBe("waiting");
    const cancelled = await w.step({ action: "cancel" });
    expect(cancelled).toMatchObject({ ok: true, state: "cancelled" });
    expect(cancelled.cancel_notes).toEqual([`cancelled render batch ${BATCH_ID}`]);
    expect(w.calls.filter((c) => c.name === "ae_render_batch_cancel").map((c) => c.args)).toEqual([{ batch_id: BATCH_ID }]);
  });

  it("blocks the loudness stage when the measurement misses the target, and passes it on a skip with a reason", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_loudness_check = () => ({
      ok: true,
      state: "done",
      measurement: { integrated_lufs: -17.8, true_peak_dbtp: -0.2 },
      verdict: { measurable: true, passes: false, loudness_ok: false, true_peak_ok: true, advice: ["-17.8 LUFS is 5.2 LU louder than the target -23 LUFS."] },
    });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "loudness", args: { standard: "ebu_r128" } }, { kind: "save", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "loudness" });
    expect(res.stages[0].summary).toContain("loudness off target");
    expect(res.stages[0].summary).toContain("-17.8 LUFS");
    expect(w.calls[0].args).toMatchObject({ comp_id: 7, standard: "ebu_r128" });
    const skipped = await w.step({ action: "skip", acknowledge: "Streaming spec, Jay accepted -17.8" });
    expect(skipped).toMatchObject({ ok: true, state: "done" });
  });

  it("follows a loudness check whose audio render is still going, with its job id", async () => {
    const w = world();
    addAll(w);
    const answers: any[] = [{ ok: true, state: "rendering", job_id: "audio_1", message: "Still rendering." }, { ok: true, state: "rendering", job_id: "audio_1" }, LOUD_PASS];
    w.reply.ae_loudness_check = () => answers.shift();
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "loudness", args: { standard: "streaming" } }] });
    const first = await w.step({ action: "start", recipe: "Acme" });
    expect(first).toMatchObject({ ok: true, state: "waiting", stopped_at: "loudness" });
    expect(first.stages[0]).toMatchObject({ status: "running", job_ids: ["audio_1"] });
    const second = await w.step({ action: "next" });
    expect(second.state).toBe("waiting");
    const done = await w.step({ action: "next" });
    expect(done).toMatchObject({ ok: true, state: "done" });
    const follow = w.calls.filter((c) => c.name === "ae_loudness_check")[1].args;
    expect(follow).toMatchObject({ job_id: "audio_1", standard: "streaming" });
    expect(follow).not.toHaveProperty("comp_id");
    expect(done.stages[0].summary).toContain("-23.1 LUFS");
  });

  it("treats a comp without audio as a warning for the loudness stage, not a stop", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_loudness_check = () => ({ ok: false, error: "no_audio", message: '"Promo" has no layer with audio switched on.' });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "loudness" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: true, state: "done" });
    expect(res.stages[0].status).toBe("warn");
  });

  it("copies with the collect stage, asks again while it is not complete, and blocks when it still is not", async () => {
    const w = world();
    addAll(w);
    let calls = 0;
    w.reply.ae_collect_files = () => {
      calls++;
      return calls < 3 ? { dry_run: false, complete: false, files_done: calls, files_total: 5, remaining: 5 - calls, errors_total: 0 } : { dry_run: false, complete: true, files_done: 5, files_total: 5, remaining: 0, errors_total: 0 };
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "collect", checkpoint: false, args: { dest: DEST_D } }] });
    const ok = await w.step({ action: "start", recipe: "Acme" });
    expect(ok).toMatchObject({ ok: true, state: "done" });
    expect(calls).toBe(3);
    expect(w.calls.every((c) => c.args.dry_run === false && c.args.dest === "C:/d")).toBe(true);

    const never = world();
    addAll(never);
    never.reply.ae_collect_files = () => ({ dry_run: false, complete: false, files_done: 1, files_total: 5, remaining: 4, errors_total: 0 });
    await never.recipe({ action: "set", name: "Acme", stages: [{ kind: "collect", checkpoint: false, args: { dest: DEST_D } }] });
    const stuck = await never.step({ action: "start", recipe: "Acme" });
    expect(stuck).toMatchObject({ ok: false, state: "blocked", stopped_at: "collect" });
    expect(stuck.stages[0].summary).toContain("not complete");
    expect(never.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not call the collect without a destination, and warns when the stage asks for a dry run", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "NoDest", stages: [{ kind: "collect", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "NoDest" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "collect" });
    expect(res.stages[0].summary).toContain("args.dest");
    expect(w.calls).toHaveLength(0);
    await w.recipe({ action: "set", name: "Dry", stages: [{ kind: "collect", checkpoint: false, args: { dest: DEST_D, dry_run: true } }] });
    const dry = await w.step({ action: "start", recipe: "Dry" });
    expect(dry).toMatchObject({ ok: true, state: "done" });
    expect(dry.stages[0]).toMatchObject({ status: "warn" });
    expect(dry.stages[0].summary).toContain("nothing was copied");
  });

  it("blocks a preflight that never finished its slices, instead of passing the gate", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_preflight = () => ({ ok: true, verdict: "incomplete", complete: false, cursor: "pf_0123456789", counts: {}, findings: [] });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "preflight" });
    expect(res.stages[0].summary).toContain("did not cover the whole project");
    expect(names(w)).not.toContain("ae_save");
  });

  it("does not run a stage again whose write reached the project but could not be confirmed", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_verify_render = () => ({ ok: false, error: "read_failed", applied: true, message: "could not read the imported item back" });
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "verify", checkpoint: false, args: { path: "C:/o/a.mp4" } }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "verify" });
    expect(res.stages[0]).toMatchObject({ status: "blocked", error: "read_back_failed", applied: true });
    const refused = await w.step({ action: "retry" });
    expect(refused).toMatchObject({ ok: false, error: "unverified_write" });
    expect(w.calls.filter((c) => c.name === "ae_verify_render")).toHaveLength(1);
    // Jay inspects the project and accepts it
    expect(await w.step({ action: "skip", acknowledge: "Removed the imported item by hand" })).toMatchObject({ ok: true, state: "done" });
  });

  it("still lets a save be retried after an unconfirmed result (saving twice does no harm)", async () => {
    const w = world();
    addAll(w);
    let first = true;
    w.reply.ae_save = () => {
      if (first) {
        first = false;
        return { applied: true, receipt: { matches: false, mismatches: [{ path: "read_back", message: "read failed" }] } };
      }
      return { applied: true, receipt: { matches: true, mismatches: [] } };
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save", checkpoint: false }] });
    expect((await w.step({ action: "start", recipe: "Acme" })).stages[0]).toMatchObject({ status: "blocked", error: "read_back_failed" });
    expect(await w.step({ action: "retry" })).toMatchObject({ ok: true, state: "done" });
  });

  it("never runs a stage whose tool is not one its kind lists, even if the .deliver.json says so", async () => {
    const w = world();
    addAll(w);
    w.add("ae_run_jsx", ["script", "expect"], () => ({ ok: true }));
    w.add("ae_skill_run", ["skill", "expect"], () => ({ ok: true }));
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }, { kind: "save", checkpoint: false }, { kind: "scrub", checkpoint: false }] });
    // a hand-edited (or foreign) record
    const file = deliverPath(w.projectPath);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.recipes[0].stages[1].tool = "ae_run_jsx";
    raw.recipes[0].stages[1].args = { script: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)" };
    raw.recipes[0].stages[2].kind = "free_form";
    fs.writeFileSync(file, JSON.stringify(raw));
    clearDeliverMemory();

    const plan = await w.step({ action: "start", recipe: "Acme", dry_run: true });
    expect(plan.stages[1]).toMatchObject({ valid: false, available: false, args_valid: false });
    expect(plan.stages[1].args_note).toContain("invalid_stage");
    expect(plan.stages[2]).toMatchObject({ valid: false });
    expect((await w.recipe({ action: "get", name: "Acme" })).recipe.stages[1]).toMatchObject({ available: false });

    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "save" });
    expect(res.stages[1]).toMatchObject({ status: "blocked", error: "invalid_stage", applied: false });
    expect(names(w)).toEqual(["ae_preflight"]);
    // retry takes the stored definition, which is still invalid
    expect((await w.step({ action: "retry" })).stages[1].error).toBe("invalid_stage");
    expect(names(w)).toEqual(["ae_preflight"]);
    expect(validateStageDef({ id: "x", kind: "save", tool: "ae_save", args: {} })).toBeNull();
    expect(validateStageDef({ id: "x", kind: "save", tool: "ae_skill_run", args: {} })).toContain("ae_save");
    expect(validateStageDef({ id: "x", kind: "save", tool: "ae_save", args: { expect: {} } })).toContain("expect");
    expect(validateStageDef({ id: "Bad Id", kind: "save", tool: "ae_save", args: {} })).toContain("id");
    expect(validateStageDef({ id: "x", kind: "toString", tool: "ae_save", args: {} })).toContain("Unknown");
    expect(validateStageDef(null)).toContain("not an object");
  });

  it("refuses to run or write when the delivery record exists but cannot be read", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "save" }] });
    const file = deliverPath(w.projectPath);
    const good = fs.readFileSync(file, "utf8");
    // as if Dropbox held the file: remove it and put something there that cannot be read as a file
    clearDeliverMemory();
    fs.rmSync(file);
    fs.mkdirSync(file);
    const callsBefore = w.calls.length;
    for (const res of [
      await w.recipe({ action: "list" }),
      await w.recipe({ action: "set", name: "Other", stages: [{ kind: "save" }] }),
      await w.step({ action: "start", recipe: "Acme" }),
      await w.step({ action: "next" }),
      await w.status(),
    ]) {
      expect(res).toMatchObject({ ok: false, error: "state_file_unreadable", applied: false });
      expect(res.message).toContain("could not be read");
    }
    expect(w.calls).toHaveLength(callsBefore);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    // when the file is back, everything is as it was
    fs.rmdirSync(file);
    fs.writeFileSync(file, good);
    expect((await w.recipe({ action: "list" })).recipes.map((r: any) => r.name)).toEqual(["Acme"]);
  });

  it("previews with dry_run: availability, argument checks, checkpoints, and writes nothing", async () => {
    const w = world();
    addAll(w);
    w.tools.delete("ae_collect_files");
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "preflight" }, { kind: "save" }, { kind: "verify" }, { kind: "collect", args: { dest: DEST_D } }, { kind: "collect", id: "collect_b" }] });
    const before = fs.readFileSync(deliverPath(w.projectPath), "utf8");
    const plan = await w.step({ action: "start", recipe: "Acme", dry_run: true });
    expect(plan).toMatchObject({ ok: true, dry_run: true, applied: false });
    expect(plan.stages.map((s: any) => [s.id, s.available, s.args_valid, s.checkpoint_before])).toEqual([
      ["preflight", true, true, false],
      ["save", true, true, true],
      ["verify", true, "deferred", true],
      ["collect", false, "deferred", true],
      ["collect_b", false, false, true],
    ]);
    expect(plan.stages[3]).toMatchObject({ stops_run_if_unavailable: false });
    expect(plan.stages[4].args_note).toContain("args.dest");
    expect(w.calls).toHaveLength(0);
    expect(fs.readFileSync(deliverPath(w.projectPath), "utf8")).toBe(before);
  });

  it("counts the checkpoints in the dry run: with mode start only the first writing stage gets one", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Once", checkpoint_mode: "start", stages: [{ kind: "preflight" }, { kind: "save" }, { kind: "scrub", args: { comp_id: 7 } }, { kind: "save", id: "save_b" }] });
    const plan = await w.step({ action: "start", recipe: "Once", dry_run: true });
    expect(plan.stages.map((s: any) => [s.id, s.checkpoint_before])).toEqual([["preflight", false], ["save", true], ["scrub", false], ["save_b", false]]);
  });

  it("verifies a reframed copy against its own comp, not the recipe's: a job uses its own comp, a file by path gets its comp's id", async () => {
    const w = world();
    addAll(w);
    const items = [
      { index: 1, comp: "Promo", spec: "yt", state: "succeeded", output_path: "C:/o/Promo_yt.mov", job_id: "j1" },
      { index: 2, comp: "Promo_9x16", spec: "ig", state: "succeeded", output_path: "C:/o/Promo_9x16_ig.mov", job_id: "j2" },
      { index: 3, comp: "Promo_9x16", spec: "ig2", state: "skipped", output_path: "C:/o/Promo_9x16_ig2.mov" },
      { index: 4, comp: "Ghost", spec: "x", state: "skipped", output_path: "C:/o/Ghost_x.mov" },
    ];
    w.reply.ae_render_batch_status = () => ({ ok: true, batch_id: BATCH_ID, state: "succeeded", runner_active: false, items });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "verify", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    const calls = w.calls.filter((c) => c.name === "ae_verify_render").map((c) => c.args);
    // the two jobs: no comp_id, so ae_verify_render takes the job's own comp
    expect(calls.filter((a) => a.job_id !== undefined).map((a) => [a.job_id, "comp_id" in a])).toEqual([["j1", false], ["j2", false]]);
    // the file by path of the 9:16 copy is compared with that comp (id 8)
    expect(calls.find((a) => a.path === "C:/o/Promo_9x16_ig2.mov")).toMatchObject({ comp_id: 8 });
    // a comp that is not in the project is reported unchecked, not compared with the recipe's comp
    expect(calls.some((a) => a.path === "C:/o/Ghost_x.mov")).toBe(false);
    const verify = res.stages.find((s: any) => s.id === "verify");
    expect(verify.status).toBe("blocked");
    expect(verify.outputs.find((c: any) => c.output === "C:/o/Ghost_x.mov").summary).toContain("unchecked");
  });

  it("checks every file of a batch bigger than 20 items and says when more are shown than fit", async () => {
    const paths = Array.from({ length: 24 }, (_, i) => `C:/o/f${i}.mov`);
    const w = batchWorld(paths);
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res.state).toBe("done");
    expect(w.calls.filter((c) => c.name === "ae_scrub_check")).toHaveLength(24);
    const scrub = res.stages.find((s: any) => s.id === "scrub");
    expect(scrub.summary).toContain("24 outputs");
    // the answer stays bounded
    expect(scrub.outputs.length).toBeLessThanOrEqual(40);
    expect(scrub.outputs_total).toBeUndefined();
    expect(res.outputs).toHaveLength(24);
  });

  it("bounds the rows it returns for a very large batch", async () => {
    const paths = Array.from({ length: 120 }, (_, i) => `C:/o/f${i}.mov`);
    const w = batchWorld(paths);
    w.reply.ae_scrub_check = (a) => (a.path === "C:/o/f119.mov" ? { ok: true, verdict: "fail", findings: [] } : { ok: true, verdict: "pass" });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    const scrub = res.stages.find((s: any) => s.id === "scrub");
    expect(scrub.outputs).toHaveLength(40);
    expect(scrub.outputs_total).toBe(120);
    // the failing file is among the rows shown
    expect(scrub.outputs[0]).toMatchObject({ output: "C:/o/f119.mov", status: "blocked" });
    expect(res.outputs).toHaveLength(80);
    expect(res.outputs_total).toBe(120);
  });

  it("keeps a timed-out comp-list read from counting as a possible write, so the verify can be retried", async () => {
    const w = world();
    addAll(w);
    const items = [
      { index: 1, comp: "Promo", spec: "yt", state: "succeeded", output_path: "C:/o/Promo_yt.mov", job_id: "j1" },
      { index: 2, comp: "Promo_9x16", spec: "ig2", state: "skipped", output_path: "C:/o/Promo_9x16_ig2.mov" },
    ];
    w.reply.ae_render_batch_status = () => ({ ok: true, batch_id: BATCH_ID, state: "succeeded", runner_active: false, items });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "verify", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    w.state.listCompsTimeout = true;
    const res = await w.step({ action: "next" });
    const verify = res.stages.find((s: any) => s.id === "verify");
    expect(verify).toMatchObject({ status: "error", error: "timeout" });
    expect(verify.applied).not.toBe("unknown");
    // only a read failed: nothing was imported for the file by path, so retry is not refused
    w.state.listCompsTimeout = false;
    const retried = await w.step({ action: "retry" });
    expect(retried.error).not.toBe("unverified_write");
    expect(retried.stages.find((s: any) => s.id === "verify").status).not.toBe("error");
  });

  it("keeps the Outputs list and the blocked rows inside the report limit for a big delivery", () => {
    const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ output: `C:/very/long/path/${tag}_${i}_${"x".repeat(100)}.mov`, status: i === 39 ? ("blocked" as const) : ("ok" as const), summary: "y".repeat(290) }));
    const stages = ["render", "verify", "scrub", "loud"].map((id) => {
      const st = stage(id, "ok");
      st.children = rows(60, id);
      return st;
    });
    const run = { ...runOf(stages), outputs: Array.from({ length: 100 }, (_, i) => ({ path: `C:/o/${i}_${"z".repeat(300)}.mov` })) };
    const text = renderReport(run);
    expect(text.length).toBeLessThanOrEqual(20100);
    expect(text).toContain("Outputs");
    expect(text).toContain("and 20 more (100 in all)");
    expect(text).not.toContain("[report cut at");
    // Every stage keeps its status line and its blocked row, the last one too; ok rows give way first.
    for (const id of ["render", "verify", "scrub", "loud"]) {
      expect(text).toContain(`- ${id} (`);
      expect(text).toContain(`${id}_39_`);
      expect(text).toMatch(new RegExp(`and \\d+ more \\(60 in all\\)`));
    }
    expect(text.match(/: blocked - /g)?.length).toBe(4);
  });

  it("runs a scrub that names its own comp once on that comp, not once per rendered file", async () => {
    const w = batchWorld(["C:/o/a.mp4", "C:/o/b.mp4"]);
    w.add("ae_scrub_check", z.object({ comp_id: z.number().optional(), path: z.string().optional(), expect: z.unknown().optional() }).refine((v) => (v.comp_id === undefined) !== (v.path === undefined), { message: "Give comp_id or path, not both" }), () => ({ ok: true, verdict: "pass" }));
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false, args: { comp_id: 7 } }] });
    await w.step({ action: "start", recipe: "Acme" });
    const res = await w.step({ action: "next" });
    expect(res.state).toBe("done");
    expect(w.calls.filter((c) => c.name === "ae_scrub_check").map((c) => c.args.comp_id)).toEqual([7]);
  });

  it("stops before the final save when a scrub leaves its temporary comp in the project, and refuses to run it again", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_scrub_check = () => ({ ok: true, verdict: "pass", imported_state: "left", left_in_project: { item_id: 31, comp_id: 32 }, problems: [{ path: "cleanup", message: "still there" }] });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "scrub", checkpoint: false, args: { comp_id: 7 } }, { kind: "save", id: "save_final", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "scrub" });
    expect(res.stages[0].summary).toContain("item 31");
    expect(names(w)).not.toContain("ae_save");
    expect(await w.step({ action: "retry" })).toMatchObject({ ok: false, error: "unverified_write" });
    expect(w.calls.filter((c) => c.name === "ae_scrub_check")).toHaveLength(1);
  });

  it("stops before the final save when a verify could not confirm its imported item is gone", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_verify_render = () => ({ ok: true, matches: true, imported_item_state: "unknown", imported_item: 41, problems: [{ path: "read_back", message: "check failed" }] });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "verify", checkpoint: false, args: { path: "C:/o/a.mp4" } }, { kind: "save", id: "save_final", checkpoint: false }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "verify" });
    expect(res.stages[0]).toMatchObject({ status: "blocked", error: "read_back_failed" });
    expect(names(w)).not.toContain("ae_save");
  });

  it("does not report a delivery done while the zip is unfinished or failed", async () => {
    const running = world();
    addAll(running);
    let n = 0;
    running.reply.ae_collect_files = () => {
      n++;
      const base = { dry_run: false, complete: true, files_total: 3, remaining: 0, errors_total: 0 };
      return n < 3 ? { ...base, zip: { ok: false, status: "running", message: "still being written" } } : { ...base, zip: { ok: true, verified: true } };
    };
    await running.recipe({ action: "set", name: "Acme", stages: [{ kind: "collect", checkpoint: false, args: { dest: DEST_D, zip: true } }] });
    // asked again while the zip runs, then done
    expect(await running.step({ action: "start", recipe: "Acme" })).toMatchObject({ ok: true, state: "done" });
    expect(n).toBe(3);

    const failed = world();
    addAll(failed);
    failed.reply.ae_collect_files = () => ({ dry_run: false, complete: true, files_total: 3, remaining: 0, errors_total: 0, zip: { ok: false, error: "The zip could not be written: disk full" } });
    await failed.recipe({ action: "set", name: "Acme", stages: [{ kind: "collect", checkpoint: false, args: { dest: DEST_D, zip: true } }] });
    const res = await failed.step({ action: "start", recipe: "Acme" });
    expect(res).toMatchObject({ ok: false, state: "blocked", stopped_at: "collect" });
    expect(res.stages[0].summary).toContain("disk full");
  });

  it("refuses an expect.comp_id on the three tools instead of accepting and ignoring it", () => {
    for (const schema of [AeDeliverRecipeSchema, AeDeliverStepSchema, AeDeliverStatusSchema]) {
      const base = schema === AeDeliverStepSchema ? { action: "next" } : schema === AeDeliverRecipeSchema ? { action: "list" } : {};
      expect(schema.safeParse({ ...base, expect: { project_path: "C:/p/show.aep" } }).success).toBe(true);
      expect(schema.safeParse({ ...base, expect: { project_path: "C:/p/show.aep", comp_id: 7 } }).success).toBe(false);
    }
  });

  it("reads what ae_render_batch_cancel answered instead of saying cancelled", async () => {
    const mk = async (answer: unknown) => {
      const w = world();
      addAll(w);
      w.reply.ae_render_batch_cancel = () => answer;
      await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }] });
      await w.step({ action: "start", recipe: "Acme" });
      return (await w.step({ action: "cancel" })).cancel_notes as string[];
    };
    expect((await mk({ ok: true, state: "cancelled", cancelled: true }))[0]).toContain("cancelled render batch");
    expect((await mk({ ok: false, error: "not_found", message: "No render batch" }))[0]).toContain("was not cancelled: not_found");
    const finished = (await mk({ ok: true, state: "succeeded", already_finished: true }))[0];
    expect(finished).toContain("had already finished");
    expect(finished).not.toContain("cancelled render batch");
    // A kill that could not be confirmed is said, not hidden behind "cancelled".
    const unconfirmed = (await mk({ ok: true, state: "cancelled", cancelled: true, kill_unconfirmed: [{ index: 1, job_id: "j1" }] }))[0];
    expect(unconfirmed).toContain("could not be confirmed stopped");
    expect(unconfirmed).not.toContain("cancelled render batch");
  });

  it("refuses to retry a render batch (the new one would see the old files as recent), keeps the files that rendered for a skip, and points to resume", async () => {
    const w = world();
    addAll(w);
    const items = [
      { index: 1, comp: "Promo", spec: "yt", state: "succeeded", output_path: "C:/o/Promo_yt.mov", job_id: "j1" },
      { index: 2, comp: "Promo", spec: "ig", state: "failed", output_path: "C:/o/Promo_ig.mov", job_id: "j2", error: "aerender exited with code 1" },
    ];
    w.reply.ae_render_batch_status = () => ({ ok: true, batch_id: BATCH_ID, state: "failed", runner_active: false, items });
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "verify", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const blocked = await w.step({ action: "next" });
    expect(blocked.next).toContain("ae_render_batch_resume");
    expect(blocked.next).not.toContain("retry starts a new one");
    const retry = await w.step({ action: "retry" });
    expect(retry).toMatchObject({ ok: false, error: "use_resume" });
    expect(retry.message).toContain("ae_render_batch_resume");
    expect(w.calls.filter((c) => c.name === "ae_render_batch")).toHaveLength(1);
    // Jay accepts the failed item: the verify checks the file that did render
    const skipped = await w.step({ action: "skip", acknowledge: "The Instagram cut is redone by hand" });
    expect(w.calls.filter((c) => c.name === "ae_verify_render").map((c) => c.args.job_id)).toEqual(["j1"]);
    expect(skipped.state).toBe("done");
  });

  it("does not run a verify again after its call timed out, and keeps an earlier file's unconfirmed write when a later one throws", async () => {
    const timedOut = world();
    addAll(timedOut);
    timedOut.reply.ae_verify_render = () => {
      throw new BridgeError({ kind: "timeout", message: "AE did not answer" });
    };
    await timedOut.recipe({ action: "set", name: "Acme", stages: [{ kind: "verify", checkpoint: false, args: { path: "C:/o/a.mp4" } }] });
    const res = await timedOut.step({ action: "start", recipe: "Acme" });
    expect(res.stages[0]).toMatchObject({ status: "error", error: "timeout", applied: "unknown" });
    expect(await timedOut.step({ action: "retry" })).toMatchObject({ ok: false, error: "unverified_write" });
    expect(timedOut.calls.filter((c) => c.name === "ae_verify_render")).toHaveLength(1);

    const w = batchWorld(["C:/o/a.mp4", "C:/o/b.mp4"]);
    w.reply.ae_scrub_check = (a) => {
      if (a.path === "C:/o/a.mp4") return { ok: false, error: "read_failed", applied: true, message: "could not read it back" };
      throw new BridgeError({ kind: "timeout", message: "AE did not answer" });
    };
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const after = await w.step({ action: "next" });
    const scrub = after.stages.find((s: any) => s.id === "scrub");
    expect(scrub).toMatchObject({ status: "error", error: "read_back_failed", applied: true });
    expect(await w.step({ action: "retry" })).toMatchObject({ ok: false, error: "unverified_write" });
  });

  it("keeps an earlier output's unknown write when a later output throws a guard error", async () => {
    const w = batchWorld(["C:/o/a.mp4", "C:/o/b.mp4"]);
    w.reply.ae_scrub_check = (a) => {
      if (a.path === "C:/o/a.mp4") throw new BridgeError({ kind: "evalscript_error", message: "script failed" });
      throw new BridgeError({ kind: "guard", message: "wrong project" });
    };
    await w.recipe({ action: "set", name: "Acme", comp_id: 7, stages: [{ kind: "render", checkpoint: false, args: RENDER_ARGS }, { kind: "scrub", checkpoint: false }] });
    await w.step({ action: "start", recipe: "Acme" });
    const after = await w.step({ action: "next" });
    const scrub = after.stages.find((s: any) => s.id === "scrub");
    expect(scrub).toMatchObject({ status: "error", applied: "unknown" });
    expect(await w.step({ action: "retry" })).toMatchObject({ ok: false, error: "unverified_write" });
  });

  it("keeps a store it could not write in memory and prefers it to the older file, then writes it when it can, with no tmp file left", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "A", stages: [{ kind: "save" }] });
    // a directory where the temporary file goes: the write fails, the file stays as it was
    const tmp = `${deliverPath(w.projectPath)}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    const set = await w.recipe({ action: "set", name: "B", stages: [{ kind: "save" }] });
    expect(set.state_file_error).toBeDefined();
    expect(JSON.parse(fs.readFileSync(deliverPath(w.projectPath), "utf8")).recipes.map((r: any) => r.name)).toEqual(["A"]);
    // the next call sees B (memory is newer), not the older file
    expect((await w.recipe({ action: "list" })).recipes.map((r: any) => r.name).sort()).toEqual(["A", "B"]);
    fs.rmdirSync(tmp);
    expect((await w.recipe({ action: "list" })).recipes).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(deliverPath(w.projectPath), "utf8")).recipes.map((r: any) => r.name).sort()).toEqual(["A", "B"]);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("removes the temporary file when the rename fails", () => {
    const projectPath = tempProject();
    // a directory where the record goes: the temporary file is written, the rename onto the directory fails
    fs.mkdirSync(deliverPath(projectPath));
    const saved = saveStore(projectPath, { version: 1, recipes: [], runs: [] });
    expect(saved.error).toBeDefined();
    expect(fs.readdirSync(path.dirname(projectPath)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("does not lose a recipe set while a stage was running when the run writes its record", async () => {
    const w = world();
    addAll(w);
    w.reply.ae_house_style_check = async () => {
      await w.recipe({ action: "set", name: "Other", stages: [{ kind: "save" }] });
      return { ok: true, clean: true, counts: {}, findings: [] };
    };
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "house_style" }] });
    const res = await w.step({ action: "start", recipe: "Acme" });
    expect(res.state).toBe("done");
    expect((await w.recipe({ action: "list" })).recipes.map((r: any) => r.name).sort()).toEqual(["Acme", "Other"]);
    expect((await w.status({ list: true })).runs).toHaveLength(1);
  });

  it("shows a run's status with a hint about changes made after delivery", async () => {
    const w = world();
    addAll(w);
    await w.recipe({ action: "set", name: "Acme", stages: [{ kind: "preflight" }] });
    await w.step({ action: "start", recipe: "Acme" });
    w.state.dirty = true;
    const shown = await w.status();
    expect(shown).toMatchObject({ ok: true, state: "done", project: { dirty: true } });
    expect(shown.note).toContain("unsaved changes");
    expect(await w.status({ run_id: "dl_missing" })).toMatchObject({ ok: false, error: "unknown_run" });
    expect(await world().status()).toMatchObject({ ok: false, error: "unknown_run" });
  });
});

// ---------- the host function under node:vm ----------

describe("deliverRead (host)", () => {
  function host() {
    const project = new FakeProject();
    project.file = { fsName: "C:/work/show.aep" };
    const promo = project.addComp("Promo", 1920, 1080, 10);
    project.addComp("Other", 640, 360, 3);
    const { A } = loadHost(project, ["deliver.jsx"]);
    return { A, project, promo };
  }

  it("describes the project, the comp and the render queue, and lists the comps on request", () => {
    const { A, project, promo } = host();
    project.renderQueue.items.add(promo as any);
    const r = A.deliverRead({ expect: { project_path: "C:/work/show.aep" }, comp_id: promo.id, list_comps: true });
    expect(r).toMatchObject({ project_path: "C:/work/show.aep", saved: true, dirty: false, comp_found: true });
    expect(r.comp).toMatchObject({ id: promo.id, name: "Promo", width: 1920, height: 1080, duration: 10 });
    expect(r.comps.map((c: any) => c.name)).toEqual(["Promo", "Other"]);
    expect(r.comps_total).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.render_queue.num_items).toBe(1);
    expect(r.render_queue.items[0]).toMatchObject({ index: 1, comp_id: promo.id, comp_name: "Promo" });
  });

  it("answers a guard failure without reading anything, and reports a missing comp", () => {
    const { A } = host();
    expect(A.deliverRead({ expect: { project_path: "C:/other/show.aep" } })).toEqual({ guard_failed: true, project_path: "C:/work/show.aep" });
    const r = A.deliverRead({ expect: { project_path: "C:/work/show.aep" }, comp_id: 9999 });
    expect(r).toMatchObject({ comp: null, comp_found: false, comps: null });
  });

  it("reports an unsaved, dirty project and changes nothing", () => {
    const project = new FakeProject();
    project.dirty = true;
    const { A, undo } = loadHost(project, ["deliver.jsx"]);
    const r = A.deliverRead({});
    expect(r).toMatchObject({ project_path: "<unsaved>", saved: false, dirty: true });
    expect(undo).toEqual({ begun: 0, ended: 0 });
    expect(project.dirty).toBe(true);
  });
});
