import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { zodToJsonSchema } from "../src/schema.js";
import type { ToolContext } from "../src/tools/common.js";
import { AerenderJobRegistry, buildAerenderArgs, cancelAerenderJob, isAerenderProcess, type AerenderJobRecord, type SpawnLike } from "../src/tools/ext/aerender.js";
import {
  AeRenderBatchCancelSchema,
  AeRenderBatchPlanSchema,
  AeRenderBatchResumeSchema,
  AeRenderBatchStartSchema,
  AeRenderBatchStatusSchema,
  BatchStore,
  batchSpaceDirs,
  computeEta,
  createRenderbatch,
  defaultIsPidAlive,
  driveLetterOf,
  estimateBytes,
  expandItems,
  framesFor,
  getFreeBytes,
  inspectOutput,
  inspectOutputs,
  joinOutput,
  mayShareVolume,
  normaliseJob,
  outputNameFor,
  outputsOf,
  parseDfAvailableBytes,
  protectedReason,
  queueItemFrames,
  renderbatchTools,
  sanitizeFileToken,
  spaceDirsOf,
  spaceStatus,
  validatePlan,
  verifyOutput,
  verifyOutputs,
  type BatchItem,
  type BatchRecord,
  type CompRead,
  type QueueItemRead,
  type RenderbatchRead,
} from "../src/tools/ext/renderbatch.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const NO_GATE = { cool_down_ms: 0, list_engines: () => [], max_running: 8 };

const GIB = 1024 * 1024 * 1024;
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-renderbatch-"));
  tmpDirs.push(d);
  return d;
}

const expectArg = (project: string) => ({ project_path: project });

// ---------- schemas ----------

describe("render batch schemas", () => {
  const base = { comps: ["Main"], output_dir: path.join(os.tmpdir(), "out") };

  it("accepts a minimal job and every tool has a describe()d schema", () => {
    expect(AeRenderBatchPlanSchema.safeParse(base).success).toBe(true);
    expect(AeRenderBatchStartSchema.safeParse({ ...base, expect: { project_path: "<unsaved>" } }).success).toBe(true);
    expect(AeRenderBatchStatusSchema.safeParse({}).success).toBe(true);
    expect(AeRenderBatchCancelSchema.safeParse({}).success).toBe(false);
    expect(AeRenderBatchResumeSchema.safeParse({ batch_id: "b" }).success).toBe(false);
    expect(AeRenderBatchCancelSchema.safeParse({ batch_id: ".." + String.fromCharCode(92) + "x" }).success).toBe(false);
    expect(AeRenderBatchStatusSchema.safeParse({ batch_id: "batch_1700000000000_a1b2c3" }).success).toBe(true);
    expect(AeRenderBatchStatusSchema.safeParse({ batch_id: "../batch_1_abcdef" }).success).toBe(false);
  });

  it("rejects duplicate comps, duplicate specs, a relative folder and unknown tokens", () => {
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, comps: ["A", "A"] }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, specs: [{ name: "x" }, { name: "X" }] }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, output_dir: "renders/out" }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, name_template: "{comp}_{size}" }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, name_template: "{comp}_{spec}_{date}_{n}" }).success).toBe(true);
  });

  it("bounds its numbers and spec names", () => {
    const start = { ...base, expect: { project_path: "<unsaved>" } };
    expect(AeRenderBatchStartSchema.safeParse({ ...start, concurrency: 5 }).success).toBe(false);
    expect(AeRenderBatchStartSchema.safeParse({ ...start, max_cpu_percent: 0 }).success).toBe(false);
    expect(AeRenderBatchStartSchema.safeParse({ ...start, max_cpu_percent: 101 }).success).toBe(false);
    expect(AeRenderBatchStartSchema.safeParse({ ...start, on_error: "ignore" }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, specs: [{ name: "a b" }] }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, specs: [{ name: "a", extension: ".mp4" }] }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, comps: Array.from({ length: 51 }, (_, i) => `C${i}`) }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, comps: ["x".repeat(256)] }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ ...base, comps: ["x".repeat(255)] }).success).toBe(true);
  });

  it("is exported as renderbatchTools with the expected names, mutating ones ending in the safety guidance", () => {
    expect(renderbatchTools.map((t) => t.name)).toEqual([
      "ae_render_batch_plan",
      "ae_render_batch",
      "ae_render_batch_status",
      "ae_render_batch_resume",
      "ae_render_batch_cancel",
    ]);
    for (const name of ["ae_render_batch", "ae_render_batch_resume", "ae_render_batch_cancel"]) {
      expect(renderbatchTools.find((t) => t.name === name)!.description).toContain("IMPORTANT: (1) Always re-read");
    }
  });
});

// ---------- pure logic ----------

describe("render batch pure logic", () => {
  const read = (comps: CompRead[], extra: Partial<RenderbatchRead> = {}): RenderbatchRead => ({
    project_path: "C:/p/job.aep",
    dirty: false,
    comp_total: comps.length,
    comps,
    templates: { source: "existing_item", render_settings: ["Best Settings"], output_modules: ["Lossless", "H.264"] },
    ...extra,
  });
  const main: CompRead = { name: "Main", count: 1, id: 1, frame_rate: 25, duration: 4, work_area_start: 1, work_area_duration: 2 };
  const job = normaliseJob({ comps: ["Main"], output_dir: "C:\\out", specs: [{ name: "h264", extension: "mp4" }, { name: "pro", sequence: true, extension: "png" }] });

  it("sanitises file names and joins in the folder's own separator style", () => {
    expect(sanitizeFileToken('a<b>:"c"/d\\e|f?g*')).toBe("a_b___c__d_e_f_g_");
    expect(sanitizeFileToken("name. ")).toBe("name");
    expect(sanitizeFileToken("...")).toBe("_");
    expect(joinOutput("C:\\out\\", "a.mov")).toBe("C:\\out\\a.mov");
    expect(joinOutput("/out/", "a.mov")).toBe("/out/a.mov");
  });

  it("names outputs from the template, with a frame token for sequences", () => {
    const t = Date.UTC(2026, 10, 3, 12);
    expect(outputNameFor({ ...job, name_template: "{comp}_{spec}_{n}" }, "Main 16:9", job.specs[0], 3, t)).toBe("Main 16_9_h264_03.mp4");
    expect(outputNameFor(job, "Main", job.specs[1], 2, t)).toBe("Main_pro.[#####].png");
    expect(outputNameFor({ ...job, name_template: "{date}" }, "Main", job.specs[0], 1, t)).toMatch(/^2026110[34]\.mp4$/);
  });

  it("computes frame ranges for the three time spans", () => {
    expect(framesFor(main, "comp")).toEqual({ start: 0, end: 99, frames: 100 });
    expect(framesFor(main, "work_area")).toEqual({ start: 25, end: 74, frames: 50 });
    expect(framesFor(main, "template")).toEqual({ frames: 100 });
    expect(framesFor(undefined, "comp")).toEqual({ frames: null });
    expect(framesFor({ name: "x", count: 1 }, "comp")).toEqual({ frames: null });
    // A work area that can't be read falls back to the whole comp.
    expect(framesFor({ ...main, work_area_start: null, work_area_duration: null }, "work_area")).toEqual({ start: 0, end: 99, frames: 100 });
  });

  it("expands comps outer, specs inner, numbering items from 1", () => {
    const items = expandItems(normaliseJob({ comps: ["A", "B"], output_dir: "/out", specs: [{ name: "x" }, { name: "y" }] }), [{ ...main, name: "A" }, { ...main, name: "B" }], 0);
    expect(items.map((i) => `${i.index}:${i.comp_name}/${i.spec_name}`)).toEqual(["1:A/x", "2:A/y", "3:B/x", "4:B/y"]);
    expect(items[0]).toMatchObject({ start_frame: 0, end_frame: 99, frames: 100, output_path: "/out/A_x.mov" });
  });

  it("an ambiguous or missing comp gets no frame range", () => {
    const items = expandItems(normaliseJob({ comps: ["Main"], output_dir: "/out" }), [{ ...main, count: 2 }], 0);
    expect(items[0].frames).toBeNull();
    expect(items[0].start_frame).toBeUndefined();
  });

  it("flags duplicate comp names, missing comps, unknown templates, collisions and protected folders", () => {
    const j = normaliseJob({
      comps: ["Main", "Dup", "Gone"],
      output_dir: "C:/out/_mcp_backups",
      name_template: "same",
      specs: [{ name: "a", output_module_template: "Nope", render_settings_template: "Best Settings" }],
    });
    const r = read([main, { name: "Dup", count: 2 }, { name: "Gone", count: 0 }]);
    const items = expandItems(j, r.comps, 0);
    const { errors } = validatePlan(j, r, items, ["C:/p/job.aep"]);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("comp_name_ambiguous");
    expect(codes).toContain("comp_not_found");
    expect(codes).toContain("template_not_found");
    expect(codes).toContain("output_collision");
    expect(codes).toContain("output_protected");
  });

  it("warns instead of failing when the templates could not be read", () => {
    const r = read([main], { templates: { source: "none", render_settings: [], output_modules: [] } });
    const j = normaliseJob({ comps: ["Main"], output_dir: "/out", specs: [{ name: "a", output_module_template: "Whatever" }] });
    const v = validatePlan(j, r, expandItems(j, r.comps, 0));
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(" ")).toContain("Template names were not checked");
  });

  it("warns, not errors, when template lists are empty, and flags a non-zero display start", () => {
    const r = read([{ ...main, display_start_time: 3600 }], { templates: { source: "existing_item", render_settings: [], output_modules: [] } });
    const j = normaliseJob({ comps: ["Main"], output_dir: "/out", specs: [{ name: "a", output_module_template: "X", render_settings_template: "Y" }] });
    const v = validatePlan(j, r, expandItems(j, r.comps, 0));
    expect(v.errors.filter((e) => e.code === "template_not_found")).toEqual([]);
    expect(v.warnings.join(" ")).toContain("could not be read");
    expect(v.warnings.join(" ")).toContain("display start time");
    const t = normaliseJob({ comps: ["Main"], output_dir: "/out", time_span: "template" });
    expect(validatePlan(t, r, expandItems(t, r.comps, 0)).warnings.join(" ")).not.toContain("display start time");
  });

  it("refuses a queued item with extra output modules and warns that its settings apply when a template is left out", () => {
    const q: CompRead = { ...main, queued_item: { item_index: 2, num_output_modules: 2, output_files: ["C:/o/a.mov", "D:/_mcp_backups/b.mov"] } };
    const r = read([q]);
    const j = normaliseJob({ comps: ["Main"], output_dir: "C:/out", specs: [{ name: "a", extension: "mov" }] });
    const v = validatePlan(j, r, expandItems(j, r.comps, 0), ["C:/p/job.aep"]);
    expect(v.errors.map((e) => e.code)).toEqual(["queued_item_extra_output_modules", "output_protected"]);
    expect(v.errors[0].message).toContain("C:/o/a.mov");
    expect(v.warnings.join(" ")).toContain("queued render-queue item");
    const one: CompRead = { ...main, queued_item: { item_index: 1, num_output_modules: 1, output_files: ["C:/o/a.mov"] } };
    const full = normaliseJob({ comps: ["Main"], output_dir: "C:/out", specs: [{ name: "a", extension: "mov", render_settings_template: "Best Settings", output_module_template: "Lossless" }] });
    const ok = validatePlan(full, read([one]), expandItems(full, [one], 0));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(" ")).not.toContain("queued render-queue item");
  });

  it("refuses to guess the extension for a spec without an output-module template, and warns when a template is given", () => {
    const r = read([main]);
    const guess = normaliseJob({ comps: ["Main"], output_dir: "/out" });
    expect(validatePlan(guess, r, expandItems(guess, r.comps, 0)).errors.map((e) => e.code)).toEqual(["extension_required"]);
    const templated = normaliseJob({ comps: ["Main"], output_dir: "/out", specs: [{ name: "a", output_module_template: "Lossless" }] });
    const t = validatePlan(templated, r, expandItems(templated, r.comps, 0));
    expect(t.errors).toEqual([]);
    expect(t.warnings.join(" ")).toContain("has no extension");
    const given = normaliseJob({ comps: ["Main"], output_dir: "/out", extension: "mp4" });
    expect(validatePlan(given, r, expandItems(given, r.comps, 0)).errors).toEqual([]);
  });

  it("verifies a sequence by the frames written since the start, against the expected count", () => {
    const dir = tmp();
    const seq = path.join(dir, "f.[#####].png");
    const old = new Date(Date.now() - 3600_000);
    for (let i = 1; i <= 5; i++) {
      const f = path.join(dir, `f.${String(i).padStart(5, "0")}.png`);
      fs.writeFileSync(f, "old");
      fs.utimesSync(f, old, old);
    }
    const since = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, "f.00001.png"), "new");
    fs.writeFileSync(path.join(dir, "f.00002.png"), "new");
    // 2 fresh frames next to 3 stale ones: not the 5 expected.
    expect(verifyOutput(seq, since, 5)).toMatchObject({ ok: false, files: 2 });
    expect(verifyOutput(seq, since, 5).reason).toContain("2 of 5");
    expect(verifyOutput(seq, since, 2)).toMatchObject({ ok: true, files: 2, bytes: 6 });
    expect(verifyOutput(seq, since, null)).toMatchObject({ ok: true, files: 2 });
    expect(verifyOutput(seq, Date.now() + 60_000, null).ok).toBe(false);
  });

  it("recognises an aerender process by name, and nothing else", () => {
    const win = (out: string) => isAerenderProcess(1234, "win32", () => out);
    expect(win('"aerender.exe","1234","Console","1","50,000 K"\r\n')).toBe(true);
    expect(win('"chrome.exe","1234","Console","1","50,000 K"')).toBe(false);
    expect(win("INFO: No tasks are running which match the specified criteria.")).toBe(false);
    expect(isAerenderProcess(1234, "darwin", () => "/Applications/Adobe After Effects 2026/aerender\n")).toBe(true);
    expect(isAerenderProcess(1234, "darwin", () => "bash\n")).toBe(false);
    expect(isAerenderProcess(1234, "win32", () => {
      throw new Error("no tasklist");
    })).toBeNull();
    expect(win("garbage")).toBeNull();
    expect(isAerenderProcess(0, "win32", () => '"aerender.exe","0"')).toBe(false);
  });

  it("answers unknown (null), not false, when the identity lookup throws while the pid exists", () => {
    expect(isAerenderProcess(process.pid, "win32", () => {
      throw new Error("tasklist timed out");
    })).toBeNull();
  });

  it("protects backup and checkpoint folders and the project file", () => {
    expect(protectedReason("D:\\x\\_MCP_Checkpoints\\a.mov")).toContain("_mcp_checkpoints");
    expect(protectedReason("/x/_mcp_backups/a.mov")).toContain("_mcp_backups");
    expect(protectedReason("C:\\p\\job.aep", ["c:/p/job.aep"])).toContain("project file");
    expect(protectedReason("/x/out/a.mov", ["/x/job.aep"])).toBeNull();
  });

  it("parses df output and picks the drive letter, and UNC paths have none", () => {
    const df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5   971350180 430000000 500000000 47% /System/Volumes/Data\n";
    expect(parseDfAvailableBytes(df)).toBe(500000000 * 1024);
    expect(parseDfAvailableBytes("garbage")).toBeNull();
    expect(driveLetterOf("d:\\renders")).toBe("D");
    expect(driveLetterOf("\\\\nas\\share\\x")).toBeNull();
    expect(driveLetterOf("/Volumes/x")).toBeNull();
  });

  it("measures free space through PowerShell on Windows, df elsewhere, and says unknown for a UNC path", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return file === "df" ? "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 50 50 50% /\n" : "123456789\n";
    };
    expect(await getFreeBytes("D:\\out", "win32", run)).toBe(123456789);
    expect(calls[0][0]).toBe("powershell.exe");
    expect(calls[0].join(" ")).toContain("(Get-PSDrive -Name D).Free");
    expect(await getFreeBytes("\\\\nas\\share", "win32", run)).toBeNull();
    expect(await getFreeBytes(os.tmpdir(), "darwin", run)).toBe(50 * 1024);
    expect(await getFreeBytes("D:" + String.fromCharCode(92) + "out", "win32", async () => "  ")).toBeNull();
    expect(await getFreeBytes("D:\\out", "win32", async () => "not a number")).toBeNull();
    expect(
      await getFreeBytes("D:\\out", "win32", async () => {
        throw new Error("no powershell");
      })
    ).toBeNull();
  });

  it("measures an output at the root of a drive (and of /) through the real free-space lookup", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return "987654321";
    };
    const bs = String.fromCharCode(92);
    for (const out of ["E:" + bs + "hero.mov", "E:/hero.mov"]) {
      const dirs = spaceDirsOf({ rq_index: 2, output_paths: [out] }, "C:" + bs + "batch");
      expect(dirs).toHaveLength(1);
      expect(typeof (await getFreeBytes(dirs[0], "win32", run))).toBe("number");
    }
    expect(calls.map((c) => c.join(" ")).every((c) => c.includes("(Get-PSDrive -Name E).Free"))).toBe(true);
    expect(calls).toHaveLength(2);
    // A file at the root of "/" is measured at "/", not at the batch output folder.
    expect(spaceDirsOf({ rq_index: 2, output_paths: ["/hero.mov"] }, "/renders/batch")).toEqual(["/"]);
    // Only the queue item's volume when the batch has no comp items; the output folder joins for a comp item.
    expect(batchSpaceDirs([{ rq_index: 2, output_paths: ["E:/hero.mov"] }], "C:/batch")).toEqual(["E:/"]);
    expect(batchSpaceDirs([{ rq_index: 2, output_paths: ["E:/hero.mov"] }, { output_path: "C:/batch/a.mp4" }], "C:/batch")).toEqual(["C:/batch", "E:/"]);
    expect(batchSpaceDirs([], "C:/batch")).toEqual(["C:/batch"]);
  });

  it("never reports unknown space as ok", () => {
    expect(spaceStatus(null, null, 2)).toBe("unknown");
    expect(spaceStatus(10 * GIB, 5 * GIB, 2)).toBe("ok");
    expect(spaceStatus(6 * GIB, 5 * GIB, 2)).toBe("low");
  });

  it("estimates an item's size from finished items of the same spec", () => {
    const mk = (spec: string, state: BatchItem["state"], bytes: number | undefined, frames: number): BatchItem =>
      ({ index: 1, comp_name: "A", spec_name: spec, output_path: "x", frames, state, attempts: 1, output_bytes: bytes }) as BatchItem;
    const items = [mk("a", "succeeded", 1000, 100), mk("b", "succeeded", 9999, 100), mk("a", "pending", undefined, 200)];
    expect(estimateBytes(items, items[2])).toBe(Math.round(10 * 200 * 1.1));
    expect(estimateBytes([mk("a", "pending", undefined, 100)], items[2])).toBeNull();
  });

  it("verifies single files and numbered sequences, and the mtime rule", () => {
    const dir = tmp();
    const one = path.join(dir, "a.mov");
    expect(verifyOutput(one, null).ok).toBe(false);
    fs.writeFileSync(one, "");
    expect(verifyOutput(one, null).reason).toContain("empty");
    fs.writeFileSync(one, "data");
    expect(verifyOutput(one, null)).toMatchObject({ ok: true, bytes: 4 });
    expect(verifyOutput(one, Date.now() + 60_000).reason).toContain("older");
    const seq = path.join(dir, "frames.[#####].png");
    expect(inspectOutput(seq).exists).toBe(false);
    fs.writeFileSync(path.join(dir, "frames.00001.png"), "xx");
    fs.writeFileSync(path.join(dir, "frames.00002.png"), "xx");
    fs.writeFileSync(path.join(dir, "other.00001.png"), "xx");
    expect(verifyOutput(seq, null)).toMatchObject({ ok: true, bytes: 4 });
  });

  it("adds -mfr ON <percent> to the aerender arguments only when asked", () => {
    const a = buildAerenderArgs({ project_path: "p", comp_name: "c", output_path: "o", start_frame: 0, end_frame: 9, max_cpu_percent: 40 });
    expect(a.slice(-3)).toEqual(["-mfr", "ON", "40"]);
    expect(buildAerenderArgs({ project_path: "p", comp_name: "c", output_path: "o" })).not.toContain("-mfr");
  });

  it("counts the start gate in the ETA: only the gate's concurrency, and the cool-down before every pending item", () => {
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    const item = (o: Partial<BatchItem>): BatchItem => ({ index: 1, comp_name: "A", spec_name: "x", output_path: "o", frames: 100, state: "pending", attempts: 0, ...o }) as BatchItem;
    const b = {
      options: { concurrency: 4 },
      items: [
        item({ state: "succeeded", started_at: "2026-11-03T10:00:00Z", finished_at: "2026-11-03T10:01:40Z" }),
        item({ state: "pending" }),
        item({ state: "pending" }),
        item({ state: "pending" }),
      ],
    } as unknown as BatchRecord;
    // 1 s per frame, 300 frames left, one at a time, 20 s before each of the 3 items.
    expect(computeEta(b, t0 + 200_000, { concurrency: 1, gap_s: 20 }).eta_seconds).toBe(360);
  });

  it("computes an ETA from running progress and seconds per finished frame", () => {
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    const item = (o: Partial<BatchItem>): BatchItem => ({ index: 1, comp_name: "A", spec_name: "x", output_path: "o", frames: 100, state: "pending", attempts: 0, ...o }) as BatchItem;
    const b = {
      options: { concurrency: 1 },
      items: [
        item({ state: "succeeded", started_at: "2026-11-03T10:00:00Z", finished_at: "2026-11-03T10:01:40Z" }),
        item({ state: "running", started_at: "2026-11-03T10:01:40Z", percent: 50 }),
        item({ state: "pending" }),
      ],
    } as unknown as BatchRecord;
    // 100 s per 100 frames = 1 s/frame. Running: 50 s elapsed at 50% -> 50 s left. Pending: 100 s.
    const eta = computeEta(b, t0 + 150_000);
    expect(eta.eta_seconds).toBe(150);
    expect(eta.eta_at).toBe(new Date(t0 + 300_000).toISOString());
    // No finished item and no progress: unknown, not zero.
    const none = { options: { concurrency: 1 }, items: [item({ state: "pending" })] } as unknown as BatchRecord;
    expect(computeEta(none, t0).eta_seconds).toBeNull();
    expect(computeEta({ options: { concurrency: 1 }, items: [item({ state: "succeeded" })] } as unknown as BatchRecord, t0).eta_seconds).toBe(0);
  });
});

// ---------- tools and runner with a fake bridge ----------

class FakeChild extends EventEmitter {
  pid: number;
  killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill() {
    this.killed = true;
    return true;
  }
  unref() {}
}

interface Rig {
  ctx: ToolContext;
  calls: string[];
  spawned: Array<{ command: string; args: string[]; child: FakeChild }>;
  rb: ReturnType<typeof createRenderbatch>;
  registry: AerenderJobRegistry;
  clock: { t: number };
  space: { free: number | null };
  project: string;
  outDir: string;
  dir: string;
  tool: (name: string) => (typeof renderbatchTools)[number];
  finish: (jobId: string, ok: boolean, write?: boolean) => void;
  gate: { p?: Promise<void> };
}

function rig(opts: { dirty?: boolean; comps?: CompRead[]; openProject?: string; read?: Partial<RenderbatchRead>; gateOpts?: ConstructorParameters<typeof AerenderJobRegistry>[1] } = {}): Rig {
  const dir = tmp();
  const project = path.join(dir, "job.aep");
  fs.writeFileSync(project, "aep-bytes");
  const outDir = path.join(dir, "out");
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const comps: CompRead[] = opts.comps ?? [
    { name: "Main", count: 1, id: 1, width: 1920, height: 1080, frame_rate: 25, duration: 2, work_area_start: 0, work_area_duration: 2 },
    { name: "Square", count: 1, id: 2, width: 1080, height: 1080, frame_rate: 25, duration: 2, work_area_start: 0, work_area_duration: 2 },
  ];
  const openPath = opts.openProject ?? project;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "status") return { ok: true, result: { aeVersion: "26.0", project_path: openPath, dirty: opts.dirty ?? false }, durationMs: 1 };
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: openPath, comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      if (fn === "renderbatchRead") {
        const want = (JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")"))) as { comp_names: string[] }).comp_names;
        const result: RenderbatchRead = {
          project_path: openPath,
          dirty: opts.dirty ?? false,
          comp_total: comps.length,
          comps: want.map((n) => comps.find((c) => c.name === n) ?? { name: n, count: 0 }),
          templates: { source: "existing_item", render_settings: ["Best Settings"], output_modules: ["Lossless", "H.264"] },
          ...opts.read,
        };
        return { ok: true, result, durationMs: 1 };
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  const registry = new AerenderJobRegistry(path.join(dir, "renders", "jobs.json"), opts.gateOpts ?? NO_GATE);
  const spawned: Rig["spawned"] = [];
  let pid = 1000;
  const spawn: SpawnLike = ((command: string, args: readonly string[]) => {
    const child = new FakeChild(pid++);
    spawned.push({ command, args: [...args], child });
    return child as never;
  }) as SpawnLike;
  const clock = { t: Date.now() };
  const space = { free: 500 * GIB as number | null, by: undefined as undefined | ((dir: string) => number | null), asked: [] as string[] };
  const gate: { p?: Promise<void> } = {};
  const rb = createRenderbatch({
    registry,
    store: new BatchStore(path.join(dir, "renders", "batches")),
    spawn,
    now: () => clock.t,
    getFreeBytes: async (dir: string) => {
      space.asked.push(dir);
      if (gate.p) await gate.p;
      return space.by ? space.by(dir) : space.free;
    },
    isPidAlive: () => false,
    autoTick: false,
  });
  const tool = (name: string) => rb.tools.find((t) => t.name === name)!;
  const finish = (jobId: string, ok: boolean, write = ok) => {
    const job = registry.get(jobId)!;
    if (write) fs.writeFileSync(job.output_path, "x".repeat(1000));
    registry.update(jobId, { state: ok ? "succeeded" : "failed", exit_code: ok ? 0 : 1, finished_at: new Date().toISOString() });
  };
  return { ctx, calls, spawned, rb, registry, clock, space, project, outDir, dir, tool, finish, gate };
}

const startArgs = (r: Rig, extra: Record<string, unknown> = {}) =>
  AeRenderBatchStartSchema.parse({
    expect: expectArg(r.project),
    comps: ["Main", "Square"],
    specs: [{ name: "h264", output_module_template: "H.264", extension: "mp4" }],
    output_dir: r.outDir,
    preflight: false,
    ...extra,
  });

describe("ae_render_batch_plan", () => {
  it("reads once, expands the items and reports space and existing outputs, changing nothing", async () => {
    const r = rig({ dirty: true });
    fs.mkdirSync(r.outDir, { recursive: true });
    fs.writeFileSync(path.join(r.outDir, "Main_h264.mp4"), "recent");
    const args = AeRenderBatchPlanSchema.parse({
      comps: ["Main", "Square"],
      specs: [{ name: "h264", output_module_template: "H.264", extension: "mp4" }],
      output_dir: r.outDir,
    });
    const out = await r.tool("ae_render_batch_plan").handler(args, r.ctx);
    expect(r.calls).toEqual(["renderbatchRead"]);
    expect(out).toMatchObject({ ok: true, valid: true, item_count: 2, templates_checked: true });
    expect(out.items[0]).toMatchObject({ comp_name: "Main", start_frame: 0, end_frame: 49, frames: 50 });
    expect(out.items[0].existing).toMatchObject({ exists: true, would_block: true });
    expect(out.items[1].existing.exists).toBe(false);
    expect(out.free_space.status).toBe("ok");
    expect(out.warnings.join(" ")).toContain("unsaved changes");
    expect(r.spawned).toHaveLength(0);
  });

  it("is invalid for a missing comp, an unknown template and an unmeasurable volume (unknown, not ok)", async () => {
    const r = rig();
    r.space.free = null;
    const args = AeRenderBatchPlanSchema.parse({ comps: ["Main", "Missing"], specs: [{ name: "x", output_module_template: "Nope" }], output_dir: r.outDir });
    const out = await r.tool("ae_render_batch_plan").handler(args, r.ctx);
    expect(out.valid).toBe(false);
    expect(out.errors.map((e: { code: string }) => e.code).sort()).toEqual(["comp_not_found", "template_not_found"]);
    expect(out.free_space.status).toBe("unknown");
  });
});

describe("ae_render_batch", () => {
  it("guards, reads in separate calls, freezes the project and starts the first item with a CPU cap", async () => {
    const r = rig();
    const out = await r.tool("ae_render_batch").handler(startArgs(r), r.ctx);
    expect(r.calls).toEqual(["status", "renderbatchRead"]);
    expect(out).toMatchObject({ ok: true, applied: true, state: "running", counts: { running: 1, pending: 1 } });
    expect(fs.readFileSync(out.frozen_project, "utf8")).toBe("aep-bytes");
    expect(out.frozen_project).not.toBe(r.project);
    expect(r.spawned).toHaveLength(1);
    const a = r.spawned[0].args;
    expect(a.slice(a.indexOf("-project"), a.indexOf("-project") + 2)).toEqual(["-project", out.frozen_project]);
    expect(a).toEqual(expect.arrayContaining(["-comp", "Main", "-OMtemplate", "H.264", "-s", "0", "-e", "49", "-mfr", "ON", "50"]));
    expect(JSON.parse(fs.readFileSync(out.batch_json, "utf8")).items).toHaveLength(2);
  });

  it("can freeze beside the project, under a unique name, and deletes the copy when the batch succeeds", async () => {
    const r = rig();
    const out = await r.tool("ae_render_batch").handler(startArgs(r, { freeze_location: "project_folder" }), r.ctx);
    expect(path.dirname(out.frozen_project)).toBe(path.dirname(r.project));
    expect(path.basename(out.frozen_project)).toBe(`job.mcp_${out.batch_id}.aep`);
    expect(out.frozen_temporary).toBe(true);
    expect(fs.existsSync(out.frozen_project)).toBe(true);
    const runner = r.rb.getRunner();
    r.finish(r.rb.getStore().get(out.batch_id)!.items[0].job_id!, true);
    await runner.tick(out.batch_id);
    expect(fs.existsSync(out.frozen_project)).toBe(true); // not while items remain
    r.finish(r.rb.getStore().get(out.batch_id)!.items[1].job_id!, true);
    const done = await runner.tick(out.batch_id);
    expect(done!.state).toBe("succeeded");
    expect(fs.existsSync(out.frozen_project)).toBe(false);
    expect(fs.existsSync(r.project)).toBe(true);
    expect(done!.notices.join(" ")).toContain("was deleted");
  });

  it("splits the CPU cap over the concurrent processes", async () => {
    const r = rig();
    await r.tool("ae_render_batch").handler(startArgs(r, { concurrency: 2, max_cpu_percent: 50 }), r.ctx);
    expect(r.spawned).toHaveLength(2);
    for (const sp of r.spawned) expect(sp.args.slice(-3)).toEqual(["-mfr", "ON", "25"]);
    const tiny = rig();
    await tiny.tool("ae_render_batch").handler(startArgs(tiny, { concurrency: 4, max_cpu_percent: 2 }), tiny.ctx);
    expect(tiny.spawned[0].args.slice(-3)).toEqual(["-mfr", "ON", "1"]);
  });

  it("returns a structured refusal, and removes the frozen copy, when the batch state cannot be saved", async () => {
    const r = rig();
    const store = r.rb.getStore();
    // The disk write fails for real: a plain file sits where the batch folder must go.
    const id = "batch_1_abcdef";
    store.newId = () => id;
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.batchDir(id), "in the way");
    const out = await r.tool("ae_render_batch").handler(startArgs(r, { freeze_location: "project_folder" }), r.ctx);
    expect(out).toMatchObject({ ok: false, error: "state_save_failed", applied: false });
    expect(r.spawned).toHaveLength(0);
    expect(store.list()).toEqual([]);
    expect(store.get(id)).toBeUndefined();
    expect(fs.existsSync(store.batchDir(id))).toBe(false);
    expect(fs.readdirSync(path.dirname(r.project)).filter((n) => n.includes(".mcp_"))).toEqual([]);
  });

  it("refuses a dirty project, a different open project and an unsaved one, starting nothing", async () => {
    const dirty = rig({ dirty: true });
    await expect(dirty.tool("ae_render_batch").handler(startArgs(dirty), dirty.ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(dirty.spawned).toHaveLength(0);
    const allowed = rig({ dirty: true });
    const ok = await allowed.tool("ae_render_batch").handler(startArgs(allowed, { allow_dirty: true }), allowed.ctx);
    expect(ok.ok).toBe(true);
    expect(ok.warnings.join(" ")).toContain("unsaved changes");

    const other = rig({ openProject: path.join(os.tmpdir(), "other.aep") });
    await expect(other.tool("ae_render_batch").handler(startArgs(other), other.ctx)).rejects.toMatchObject({ kind: "guard" });
    const unsaved = rig({ openProject: "<unsaved>" });
    await expect(unsaved.tool("ae_render_batch").handler(startArgs(unsaved, { expect: { project_path: "<unsaved>" } }), unsaved.ctx)).rejects.toMatchObject({ kind: "guard" });
  });

  it("refuses an invalid plan before copying anything", async () => {
    const r = rig();
    const out = await r.tool("ae_render_batch").handler(startArgs(r, { comps: ["Main", "Nope"] }), r.ctx);
    expect(out).toMatchObject({ ok: false, error: "plan_invalid", applied: false });
    expect(r.spawned).toHaveLength(0);
    expect(r.rb.getStore().list()).toEqual([]);
  });
});

describe("the batch runner", () => {
  async function started(r: Rig, extra: Record<string, unknown> = {}) {
    const out = await r.tool("ae_render_batch").handler(startArgs(r, extra), r.ctx);
    return out.batch_id as string;
  }
  const states = (r: Rig, id: string) => r.rb.getStore().get(id)!.items.map((i) => i.state);

  it("runs items one after another, verifying each output, and ends succeeded", async () => {
    const r = rig();
    const id = await started(r);
    const runner = r.rb.getRunner();
    expect(states(r, id)).toEqual(["running", "pending"]);
    // Still running: a tick changes nothing and starts nothing more (concurrency 1).
    await runner.tick(id);
    expect(r.spawned).toHaveLength(1);

    const first = r.rb.getStore().get(id)!.items[0];
    r.finish(first.job_id!, true);
    await runner.tick(id);
    expect(states(r, id)).toEqual(["succeeded", "running"]);
    expect(r.rb.getStore().get(id)!.items[0].output_bytes).toBe(1000);
    expect(r.spawned).toHaveLength(2);

    r.finish(r.rb.getStore().get(id)!.items[1].job_id!, true);
    const done = await runner.tick(id);
    expect(done!.state).toBe("succeeded");
    expect(done!.finished_at).not.toBeNull();
    const status = await r.tool("ae_render_batch_status").handler({ batch_id: id }, r.ctx);
    expect(status).toMatchObject({ state: "succeeded", counts: { succeeded: 2 }, eta: { eta_seconds: 0 } });
  });

  it("a cancel that lands while the free-space check is awaited launches nothing", async () => {
    const r = rig();
    const id = await started(r);
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, true);
    let release!: () => void;
    r.gate.p = new Promise<void>((res) => {
      release = res;
    });
    const ticking = r.rb.getRunner().tick(id);
    await Promise.resolve();
    r.rb.getRunner().cancel(r.rb.getStore().get(id)!);
    release();
    const done = await ticking;
    expect(r.spawned).toHaveLength(1);
    expect(done!.state).toBe("cancelled");
    expect(done!.items[1].state).toBe("pending");
  });

  it("a failing save in the tick does not reject it", async () => {
    const r = rig();
    const id = await started(r);
    r.rb.getStore().save = () => {
      throw new Error("disk full");
    };
    const b = await r.rb.getRunner().tick(id);
    expect(b!.notices.join(" ")).toContain("could not be saved");
  });

  it("runs two at once when concurrency is 2", async () => {
    const r = rig();
    await started(r, { concurrency: 2 });
    expect(r.spawned).toHaveLength(2);
  });

  it("caps concurrency at the start gate's limit: one item at a time, the whole CPU share for it, and the descriptions say so", async () => {
    const r = rig({ gateOpts: { cool_down_ms: 0, list_engines: () => [], max_running: 1 } });
    const id = await started(r, { concurrency: 4, max_cpu_percent: 50 });
    // The default gate runs one aerender at a time: the second item is not started (and queued behind the gate), the first is not starved.
    expect(r.spawned).toHaveLength(1);
    expect(states(r, id)).toEqual(["running", "pending"]);
    expect(r.spawned[0].args.slice(-3)).toEqual(["-mfr", "ON", "50"]);
    const text = r.tool("ae_render_batch").description + JSON.stringify(zodToJsonSchema(AeRenderBatchStartSchema));
    expect(text).toContain("only one aerender at a time");
    expect(text).toContain("capped to 1");
    expect(text).toContain("20 s");
  });

  it("does not flag an item the start gate still holds back as stalled", async () => {
    const g = { t: 1_000_000 };
    const r = rig({ gateOpts: { cool_down_ms: 20_000, list_engines: () => [], max_running: 1, now: () => g.t, set_timer: () => 0, clear_timer: () => {} } });
    const id = await started(r, { stall_minutes: 1 });
    const runner = r.rb.getRunner();
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, true);
    await runner.tick(id); // the second item is launched, and the gate holds it for the cool-down
    const second = r.rb.getStore().get(id)!.items[1];
    expect(r.registry.get(second.job_id!)!.phase).toBe("queued");
    r.clock.t += 10 * 60_000;
    await runner.tick(id);
    r.clock.t += 10 * 60_000;
    const b = await runner.tick(id);
    expect(b!.items[1].stalled).toBe(false);
    expect(b!.notices.join(" ")).not.toContain("ae_aerender_cancel");
  });

  it("an exit 0 without an output file is a failure, and on_error stop leaves the rest pending", async () => {
    const r = rig();
    const id = await started(r);
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, true, false);
    const b = await r.rb.getRunner().tick(id);
    expect(b!.items[0]).toMatchObject({ state: "failed" });
    expect(b!.items[0].error).toContain("does not exist");
    expect(b!.items[1].state).toBe("pending");
    expect(b!.state).toBe("stopped");
    expect(r.spawned).toHaveLength(1);
  });

  it("on_error continue goes on and ends failed", async () => {
    const r = rig();
    const id = await started(r, { on_error: "continue" });
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, false);
    await r.rb.getRunner().tick(id);
    expect(states(r, id)).toEqual(["failed", "running"]);
    r.finish(r.rb.getStore().get(id)!.items[1].job_id!, true);
    const b = await r.rb.getRunner().tick(id);
    expect(b!.state).toBe("failed");
    expect(b!.items[0].error).toContain("exited with code 1");
  });

  it("will not overwrite a recent file, but overwrites an old one and skips on request", async () => {
    const r = rig();
    fs.mkdirSync(r.outDir, { recursive: true });
    const recent = path.join(r.outDir, "Main_h264.mp4");
    fs.writeFileSync(recent, "keep me");
    const id = await started(r);
    const b = r.rb.getStore().get(id)!;
    expect(b.items[0].state).toBe("failed");
    expect(b.items[0].error).toContain("blocked");
    expect(b.state).toBe("stopped");
    expect(fs.readFileSync(recent, "utf8")).toBe("keep me");
    expect(r.spawned).toHaveLength(0);

    const old = rig();
    fs.mkdirSync(old.outDir, { recursive: true });
    const oldFile = path.join(old.outDir, "Main_h264.mp4");
    fs.writeFileSync(oldFile, "old");
    old.clock.t = Date.now() + 3 * 3600_000;
    const oid = await started(old);
    expect(old.rb.getStore().get(oid)!.items[0]).toMatchObject({ state: "running", overwrote: true });

    const skip = rig();
    fs.mkdirSync(skip.outDir, { recursive: true });
    fs.writeFileSync(path.join(skip.outDir, "Main_h264.mp4"), "already there");
    const sid = await started(skip, { if_output_exists: "skip" });
    expect(skip.rb.getStore().get(sid)!.items.map((i) => i.state)).toEqual(["skipped", "running"]);

    const over = rig();
    fs.mkdirSync(over.outDir, { recursive: true });
    fs.writeFileSync(path.join(over.outDir, "Main_h264.mp4"), "recent");
    const vid = await started(over, { if_output_exists: "overwrite" });
    expect(over.rb.getStore().get(vid)!.items[0].state).toBe("running");
  });

  it("blocks an item when free space is low, and treats unknown space as a flag unless told to stop", async () => {
    const low = rig();
    low.space.free = 1 * GIB;
    const lid = await started(low);
    expect(low.rb.getStore().get(lid)!.items[0].error).toContain("GB free");
    expect(low.rb.getStore().get(lid)!.free_space).toMatchObject({ status: "low" });
    expect(low.spawned).toHaveLength(0);

    const unknown = rig();
    unknown.space.free = null;
    const uid = await started(unknown);
    const ub = unknown.rb.getStore().get(uid)!;
    expect(ub.items[0].state).toBe("running");
    expect(ub.free_space!.status).toBe("unknown");
    expect(ub.notices.join(" ")).toContain("could not be measured");

    const strict = rig();
    strict.space.free = null;
    const sid = await started(strict, { on_unknown_space: "stop" });
    expect(strict.rb.getStore().get(sid)!.items[0].error).toContain("could not be measured");
  });

  it("flags a stalled item as advice and never cancels it", async () => {
    const r = rig();
    const id = await started(r, { stall_minutes: 10 });
    const runner = r.rb.getRunner();
    const jobId = r.rb.getStore().get(id)!.items[0].job_id!;
    await runner.tick(id); // the first look at the log sets the baseline
    r.clock.t += 5 * 60_000;
    await runner.tick(id);
    expect(r.rb.getStore().get(id)!.items[0].stalled).toBe(false);
    r.clock.t += 6 * 60_000;
    const b = await runner.tick(id);
    expect(b!.items[0].stalled).toBe(true);
    expect(b!.notices.join(" ")).toContain("ae_aerender_cancel");
    expect(r.registry.get(jobId)!.state).toBe("running");
    expect(r.spawned[0].child.killed).toBe(false);
    // The notice is made once, not every tick.
    await runner.tick(id);
    expect(r.rb.getStore().get(id)!.notices.filter((n) => n.includes("no log or output growth"))).toHaveLength(1);
    // Log growth clears the flag.
    fs.appendFileSync(r.registry.get(jobId)!.log_path, "PROGRESS:  0:00:00:01 (2): 0 Seconds\n");
    await runner.tick(id);
    expect(r.rb.getStore().get(id)!.items[0].stalled).toBe(false);
    const status = await r.tool("ae_render_batch_status").handler({ batch_id: id }, r.ctx);
    expect(status.items[0].percent).toBeGreaterThan(0);
  });

  it("status is read-only and says when the server no longer drives the batch", async () => {
    const r = rig();
    const id = await started(r);
    const before = fs.readFileSync(r.rb.getStore().jsonPath(id), "utf8");
    const s = await r.tool("ae_render_batch_status").handler({ batch_id: id, include_free_space: true }, r.ctx);
    expect(s.free_space.status).toBe("ok");
    expect(fs.readFileSync(r.rb.getStore().jsonPath(id), "utf8")).toBe(before);
    expect(r.spawned).toHaveLength(1);
    expect(r.calls.filter((c) => c !== "status" && c !== "renderbatchRead")).toEqual([]);
    expect(s.runner_active).toBe(false); // autoTick is off in tests, so nothing holds a timer
    expect(s.advice).toContain("ae_render_batch_resume");
    const list = await r.tool("ae_render_batch_status").handler({}, r.ctx);
    expect(list.batches[0]).toMatchObject({ batch_id: id, state: "running", total: 2 });
    expect(await r.tool("ae_render_batch_status").handler({ batch_id: "nope" }, r.ctx)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("cancel terminates the running aerender and ends the batch, keeping finished renders", async () => {
    const r = rig();
    const id = await started(r);
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, true);
    await r.rb.getRunner().tick(id);
    const out = await r.tool("ae_render_batch_cancel").handler({ batch_id: id }, r.ctx);
    expect(out).toMatchObject({ ok: true, state: "cancelled", counts: { succeeded: 1, cancelled: 1 } });
    expect(r.spawned[1].child.killed).toBe(true);
    expect(r.registry.get(r.rb.getStore().get(id)!.items[1].job_id!)).toMatchObject({ cancelled: true });
    const again = await r.tool("ae_render_batch_cancel").handler({ batch_id: id }, r.ctx);
    expect(again).toMatchObject({ already_finished: true });
    expect(await r.tool("ae_render_batch_cancel").handler({ batch_id: "nope" }, r.ctx)).toMatchObject({ error: "not_found" });
  });

  it("resume keeps verified renders, re-renders the failed one and guards the project", async () => {
    const r = rig();
    const id = await started(r);
    const jobA = r.rb.getStore().get(id)!.items[0].job_id!;
    r.finish(jobA, true);
    await r.rb.getRunner().tick(id);
    r.finish(r.rb.getStore().get(id)!.items[1].job_id!, false);
    const stopped = await r.rb.getRunner().tick(id);
    expect(stopped!.state).toBe("failed");

    r.calls.length = 0;
    const out = await r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(r.calls).toEqual(["checkGuard"]);
    expect(out).toMatchObject({ ok: true, state: "running", kept: 1, reset: 1, recovered: 0 });
    expect(r.spawned).toHaveLength(3);
    expect(states(r, id)).toEqual(["succeeded", "running"]);
    expect(r.rb.getStore().get(id)!.items[1].attempts).toBe(2);

    const wrong = rig({ openProject: path.join(os.tmpdir(), "elsewhere.aep") });
    await expect(r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(wrong.project), batch_id: id }), wrong.ctx)).rejects.toMatchObject({ kind: "guard" });
  });

  it("resume re-renders a succeeded item whose file vanished, and adopts one whose runner died after it finished", async () => {
    const r = rig();
    const id = await started(r);
    const b = r.rb.getStore().get(id)!;
    r.finish(b.items[0].job_id!, true);
    await r.rb.getRunner().tick(id);
    // The first file is deleted; the second item is "running" but its process is gone and the log says it finished.
    fs.rmSync(b.items[0].output_path);
    const second = r.rb.getStore().get(id)!.items[1];
    fs.writeFileSync(second.output_path, "z".repeat(500));
    fs.appendFileSync(r.registry.get(second.job_id!)!.log_path, 'PROGRESS: Finished composition "Square".\n');
    const out = await r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(out).toMatchObject({ ok: true, kept: 0, recovered: 1, reset: 1 });
    expect(states(r, id)).toEqual(["running", "succeeded"]);
  });

  it("resume refuses while an aerender of the batch is still alive", async () => {
    const r = rig();
    const id = await started(r);
    const alive = createRenderbatch({
      registry: r.registry,
      store: r.rb.getStore(),
      spawn: (() => new FakeChild(1)) as never,
      isPidAlive: () => true,
      autoTick: false,
    });
    const out = await alive.tools.find((t) => t.name === "ae_render_batch_resume")!.handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(out).toMatchObject({ ok: false, error: "still_running" });
    expect(r.rb.getStore().get(id)!.items[0].state).toBe("running");
  });

  it("a resumed item's own partial file is not 'recent output to protect'", async () => {
    const r = rig();
    const id = await started(r);
    const first = r.rb.getStore().get(id)!.items[0];
    fs.mkdirSync(r.outDir, { recursive: true });
    fs.writeFileSync(first.output_path, "partial");
    r.finish(first.job_id!, false, false);
    await r.rb.getRunner().tick(id);
    await r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(r.rb.getStore().get(id)!.items[0]).toMatchObject({ state: "running", attempts: 2, overwrote: true });
  });
});

describe("the batch runner, review fixes", () => {
  async function started(r: Rig, extra: Record<string, unknown> = {}) {
    const out = await r.tool("ae_render_batch").handler(startArgs(r, extra), r.ctx);
    return out.batch_id as string;
  }
  const resume = (r: Rig, id: string, extra: Record<string, unknown> = {}) =>
    r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id, ...extra }), r.ctx);
  const states = (r: Rig, id: string) => r.rb.getStore().get(id)!.items.map((i) => i.state);

  it("with skip, a partial file from the item's own failed attempt is rendered again on resume, not counted as done", async () => {
    const r = rig();
    const id = await started(r, { if_output_exists: "skip" });
    const first = r.rb.getStore().get(id)!.items[0];
    fs.mkdirSync(r.outDir, { recursive: true });
    fs.writeFileSync(first.output_path, "truncated");
    r.finish(first.job_id!, false, false);
    await r.rb.getRunner().tick(id);
    expect(states(r, id)).toEqual(["failed", "pending"]);
    const out = await resume(r, id);
    expect(out).toMatchObject({ ok: true, reset: 2 });
    const item = r.rb.getStore().get(id)!.items[0];
    expect(item).toMatchObject({ state: "running", attempts: 2, overwrote: true });
    expect(r.spawned).toHaveLength(2);
  });

  it("a resume keeps items skipped on purpose, even when it passes overwrite", async () => {
    const r = rig();
    fs.mkdirSync(r.outDir, { recursive: true });
    const mine = path.join(r.outDir, "Main_h264.mp4");
    fs.writeFileSync(mine, "precious");
    const id = await started(r, { if_output_exists: "skip" });
    expect(states(r, id)).toEqual(["skipped", "running"]);
    r.finish(r.rb.getStore().get(id)!.items[1].job_id!, false);
    await r.rb.getRunner().tick(id);
    const out = await resume(r, id, { if_output_exists: "overwrite" });
    expect(out).toMatchObject({ ok: true, kept: 1, skipped_kept: 1, reset: 1 });
    expect(states(r, id)).toEqual(["skipped", "running"]);
    expect(fs.readFileSync(mine, "utf8")).toBe("precious");
    expect(r.spawned).toHaveLength(2);
    // If the file it left alone is gone, the item renders after all.
    fs.rmSync(mine);
    r.finish(r.rb.getStore().get(id)!.items[1].job_id!, false);
    await r.rb.getRunner().tick(id);
    expect(await resume(r, id, { if_output_exists: "overwrite" })).toMatchObject({ kept: 0, reset: 2 });
  });

  it("adopts an item whose job ended cleanly while the runner was away, without the log wording", async () => {
    const r = rig();
    const id = await started(r);
    const first = r.rb.getStore().get(id)!.items[0];
    r.finish(first.job_id!, true); // the registry says succeeded and the file is there; no tick ran
    const out = await resume(r, id);
    expect(out).toMatchObject({ ok: true, recovered: 1 });
    expect(r.rb.getStore().get(id)!.items[0]).toMatchObject({ state: "succeeded", note: expect.stringContaining("adopted") });
    expect(r.spawned).toHaveLength(2);
  });

  it("an image sequence with fewer fresh frames than the range fails, however many old frames sit beside them", async () => {
    const r = rig();
    const id = await started(r, { specs: [{ name: "png", extension: "png", sequence: true }], comps: ["Main"] });
    const item = r.rb.getStore().get(id)!.items[0];
    expect(item.frames).toBe(50);
    fs.mkdirSync(r.outDir, { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    for (let i = 1; i <= 50; i++) {
      const f = path.join(r.outDir, `Main_png.${String(i).padStart(5, "0")}.png`);
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, old, old);
    }
    fs.writeFileSync(path.join(r.outDir, "Main_png.00001.png"), "fresh");
    registryDone(r, item.job_id!);
    const b = await r.rb.getRunner().tick(id);
    expect(b!.items[0]).toMatchObject({ state: "failed" });
    expect(b!.items[0].error).toContain("1 of 50 frames");
  });

  it("counts every running aerender job toward the cap and waits instead of stopping the batch", async () => {
    const r = rig();
    const external: AerenderJobRecord = {
      job_id: "job_external",
      pid: 777,
      state: "running",
      exit_code: null,
      signal: null,
      cancelled: false,
      project_path: "x.aep",
      comp_name: "Other",
      output_path: path.join(r.dir, "other.mov"),
      aerender_path: "aerender",
      args: [],
      log_path: path.join(r.dir, "other.log"),
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    r.registry.register(external, new FakeChild(777) as never);
    const id = await started(r);
    expect(r.spawned).toHaveLength(0);
    const b = r.rb.getStore().get(id)!;
    expect(b.state).toBe("running");
    expect(b.items.map((i) => i.state)).toEqual(["pending", "pending"]);
    expect(b.notices.join(" ")).toContain("Waiting");
    r.registry.update("job_external", { state: "succeeded", exit_code: 0, finished_at: new Date().toISOString() });
    await r.rb.getRunner().tick(id);
    expect(states(r, id)).toEqual(["running", "pending"]);
  });

  it("does not count the sizes of items already running as free space", async () => {
    const r = rig({
      comps: ["Main", "Square", "Third"].map((name, i) => ({ name, count: 1, id: i + 1, frame_rate: 25, duration: 2, work_area_start: 0, work_area_duration: 2 })),
    });
    const id = await started(r, { comps: ["Main", "Square", "Third"], min_free_gb: 0 });
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, true); // 1000 bytes / 50 frames: ~1100 bytes per item
    await r.rb.getRunner().tick(id);
    expect(states(r, id)).toEqual(["succeeded", "running", "pending"]);
    r.rb.getStore().get(id)!.options.concurrency = 2;
    r.space.free = 1500; // enough for one more item (1100) but not for it beside the running one
    const b = await r.rb.getRunner().tick(id);
    expect(b!.items[2].state).toBe("failed");
    expect(b!.items[2].error).toContain("free");
    expect(b!.items[2].error).toContain("reserved for running items");
  });

  it("cancelling a stalled item clears the stalled flag and the status no longer lists it", async () => {
    const r = rig();
    const id = await started(r, { stall_minutes: 1 });
    const runner = r.rb.getRunner();
    await runner.tick(id);
    r.clock.t += 2 * 60_000;
    await runner.tick(id);
    expect(r.rb.getStore().get(id)!.items[0].stalled).toBe(true);
    const out = await r.tool("ae_render_batch_cancel").handler({ batch_id: id }, r.ctx);
    expect(out.items[0]).not.toHaveProperty("stalled");
    const status = await r.tool("ae_render_batch_status").handler({ batch_id: id }, r.ctx);
    expect(status.stalled).toEqual([]);
  });

  it("never kills a bare pid after a restart: only a process that is an aerender is signalled, and the dead job is closed on resume", async () => {
    const r = rig();
    const id = await started(r);
    const jobId = r.rb.getStore().get(id)!.items[0].job_id!;
    // A new server process: the registry loads from disk and holds no process handle.
    const reloaded = new AerenderJobRegistry(r.registry.path, NO_GATE);
    expect(reloaded.get(jobId)).toMatchObject({ state: "running", pid: 1000 });
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      const fresh = createRenderbatch({ registry: reloaded, store: r.rb.getStore(), spawn: (() => new FakeChild(1)) as never, isPidAlive: () => false, autoTick: false, now: () => r.clock.t });
      const status = await fresh.tools.find((t) => t.name === "ae_render_batch_status")!.handler({ batch_id: id }, r.ctx);
      expect(status.orphaned).toHaveLength(1);
      expect(status.stalled).toEqual([]);
      const out = await fresh.tools.find((t) => t.name === "ae_render_batch_cancel")!.handler({ batch_id: id }, r.ctx);
      expect(out).toMatchObject({ ok: true, state: "cancelled" });
      // pid 1000 is not an aerender (here nothing, or some other process): no signal was sent.
      expect(kill.mock.calls.filter((c) => c[0] === 1000 && c[1] === "SIGTERM")).toEqual([]);
    } finally {
      kill.mockRestore();
    }
    // Resume on yet another process: the stale 'running' job is closed in the registry instead of left to a later cancel.
    const again = new AerenderJobRegistry(r.registry.path, NO_GATE);
    const rb2 = createRenderbatch({ registry: again, store: new BatchStore(r.rb.getStore().dir), spawn: (() => new FakeChild(2)) as never, isPidAlive: () => false, autoTick: false, now: () => r.clock.t });
    const b = rb2.getStore().get(id)!;
    b.state = "stopped";
    const res = await rb2.tools.find((t) => t.name === "ae_render_batch_resume")!.handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(res).toMatchObject({ ok: true });
    expect(again.get(jobId)).toMatchObject({ state: "failed" });
  });

  it("defaultIsPidAlive treats an unknown identity as alive, a positive non-aerender as dead, and a pid held by a live job as dead", () => {
    const r = rig();
    // The pid exists (this process), so only the identity answer decides.
    expect(defaultIsPidAlive(process.pid, r.registry, undefined, () => null)).toBe(true);
    expect(defaultIsPidAlive(process.pid, r.registry, undefined, () => true)).toBe(true);
    expect(defaultIsPidAlive(process.pid, r.registry, undefined, () => false)).toBe(false);
    // Another job with a live handle in this server holds the number: the old job's pid is not that process.
    const rec = { job_id: "held", pid: process.pid, state: "running", exit_code: null, signal: null, cancelled: false, project_path: r.project, comp_name: "Main", output_path: "o", aerender_path: "aerender", args: [], log_path: path.join(r.dir, "h.log"), started_at: new Date().toISOString(), finished_at: null } as AerenderJobRecord;
    r.registry.register(rec, new FakeChild(process.pid) as never);
    expect(defaultIsPidAlive(process.pid, r.registry, "old_job", () => true)).toBe(false);
    expect(defaultIsPidAlive(process.pid, r.registry, "held", () => null)).toBe(true);
  });

  it("cancelAerenderJob after a restart: kills a positive aerender, never an unidentified or foreign pid, and leaves an unconfirmed job running", () => {
    const mk = () => {
      const r = rig();
      const jobId = "job_x";
      const log = path.join(r.dir, "x.log");
      fs.writeFileSync(log, "");
      const rec = { job_id: jobId, pid: 4242, state: "running", exit_code: null, signal: null, cancelled: false, project_path: r.project, comp_name: "Main", output_path: path.join(r.dir, "o.mov"), aerender_path: "aerender", args: [], log_path: log, started_at: new Date().toISOString(), finished_at: null } as AerenderJobRecord;
      r.registry.register(rec);
      return { r, rec };
    };
    const signals: number[] = [];
    const signal = (pid: number) => {
      signals.push(pid);
    };

    const a = mk();
    const killed = cancelAerenderJob(a.r.registry, a.rec, undefined, "t", { identify: () => true, signal });
    expect(signals).toEqual([4242]);
    expect(killed).toMatchObject({ state: "failed", cancelled: true });

    signals.length = 0;
    const b = mk();
    const unknown = cancelAerenderJob(b.r.registry, b.rec, undefined, "t", { identify: () => null, signal });
    expect(signals).toEqual([]);
    expect(unknown.kill_unconfirmed).toBe(true);
    expect(b.r.registry.get("job_x")).toMatchObject({ state: "running", cancelled: false });
    expect(fs.readFileSync(b.rec.log_path, "utf8")).toContain("could not confirm");

    const c = mk();
    const foreign = cancelAerenderJob(c.r.registry, c.rec, undefined, "t", { identify: () => false, signal });
    expect(signals).toEqual([]);
    expect(foreign.kill_unconfirmed).toBeUndefined();
    expect(c.r.registry.get("job_x")).toMatchObject({ state: "failed", cancelled: true });
  });

  it("a batch cancel whose process cannot be identified kills nothing, keeps the item running and makes resume refuse", async () => {
    const r = rig();
    const id = await started(r);
    const jobId = r.rb.getStore().get(id)!.items[0].job_id!;
    const reloaded = new AerenderJobRegistry(r.registry.path, NO_GATE); // a restart: no process handle
    reloaded.update(jobId, { pid: process.pid }); // a pid that exists, so only the identity decides
    const signals: number[] = [];
    const fresh = createRenderbatch({
      registry: reloaded,
      store: r.rb.getStore(),
      spawn: (() => new FakeChild(1)) as never,
      isPidAlive: (pid, jid) => defaultIsPidAlive(pid, reloaded, jid, () => null),
      cancelHooks: { identify: () => null, signal: (pid) => void signals.push(pid) },
      autoTick: false,
      now: () => r.clock.t,
    });
    const tool = (n: string) => fresh.tools.find((t) => t.name === n)!;
    const out = await tool("ae_render_batch_cancel").handler({ batch_id: id }, r.ctx);
    expect(signals).toEqual([]);
    expect(out).toMatchObject({ ok: true, state: "cancelled", kill_unconfirmed: [{ index: 1, job_id: jobId }] });
    expect(reloaded.get(jobId)).toMatchObject({ state: "running", cancelled: false });
    expect(fresh.getStore().get(id)!.items[0].state).toBe("running");
    const res = await tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id }), r.ctx);
    expect(res).toMatchObject({ ok: false, error: "still_running" });
  });

  it("ae_aerender_cancel reports kill_unconfirmed instead of cancelled when the process cannot be identified", async () => {
    const r = rig();
    const id = await started(r);
    const jobId = r.rb.getStore().get(id)!.items[0].job_id!;
    const reloaded = new AerenderJobRegistry(r.registry.path, NO_GATE);
    const { createAerenderTools } = await import("../src/tools/ext/aerender.js");
    const tools = createAerenderTools({ registry: reloaded, cancelHooks: { identify: () => null } } as never);
    const out = await tools.find((t) => t.name === "ae_aerender_cancel")!.handler({ job_id: jobId }, r.ctx);
    expect(out).toMatchObject({ ok: true, cancelled: false, kill_unconfirmed: true, state: "running" });
  });

  it("a resume that cannot save does not leave the batch claiming to run", async () => {
    const r = rig();
    const id = await started(r);
    r.finish(r.rb.getStore().get(id)!.items[0].job_id!, false);
    await r.rb.getRunner().tick(id);
    r.rb.getStore().save = () => {
      throw new Error("disk full");
    };
    const out = await resume(r, id);
    expect(out).toMatchObject({ ok: false, error: "state_save_failed", applied: false });
    expect(r.rb.getStore().get(id)!.state).toBe("stopped");
    expect(r.spawned).toHaveLength(1);
  });
});

function registryDone(r: Rig, jobId: string): void {
  r.registry.update(jobId, { state: "succeeded", exit_code: 0, finished_at: new Date().toISOString() });
}

// ---------- the host function under node:vm ----------

describe("renderbatch.jsx", () => {
  it("reports comps by name with duplicates counted, frame data and templates, changing nothing", () => {
    const project = new FakeProject();
    const main = project.addComp("Main", 1920, 1080, 4);
    main.workAreaStart = 1;
    main.workAreaDuration = 2;
    project.addComp("Twin", 640, 360, 2);
    project.addComp("Twin", 640, 360, 2);
    project.addFolder("Footage");
    const { A, undo } = loadHost(project, ["renderbatch.jsx"]);
    const r = A.renderbatchRead({ comp_names: ["Main", "Twin", "Absent"] });
    expect(r.comp_total).toBe(3);
    expect(r.comps[0]).toMatchObject({ name: "Main", count: 1, width: 1920, height: 1080, frame_rate: 25, duration: 4, work_area_start: 1, work_area_duration: 2 });
    expect(r.comps[1]).toMatchObject({ name: "Twin", count: 2 });
    expect(r.comps[2]).toEqual({ name: "Absent", count: 0 });
    expect(r.templates).toMatchObject({ source: "none", render_settings: [], output_modules: [] });
    expect(project.renderQueue.numItems).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("reads template names from an existing render-queue item", () => {
    const project = new FakeProject();
    const main = project.addComp("Main");
    project.renderQueue.items.add(main);
    const { A } = loadHost(project, ["renderbatch.jsx"]);
    const r = A.renderbatchRead({ comp_names: ["Main"] });
    expect(r.templates.source).toBe("existing_item");
    expect(r.templates.render_settings).toContain("Best Settings");
    expect(r.templates.output_modules).toContain("Lossless");
    expect(project.renderQueue.numItems).toBe(1);
  });

  it("reports the first queued item of each listed comp with its output modules, and clips long names", () => {
    const project = new FakeProject();
    const main = project.addComp("Main");
    project.addComp("Other");
    const done = project.renderQueue.items.add(main);
    Object.assign(done, { status: 3016, numOutputModules: 1, outputModule: () => ({ templates: ["Lossless"], file: { fsName: "C:/old/done.mov" } }) });
    const queued = project.renderQueue.items.add(main);
    Object.assign(queued, {
      status: 3015,
      numOutputModules: 2,
      outputModule: (j: number) => ({ templates: ["Lossless"], file: { fsName: `C:/o/om${j}.mov` } }),
    });
    const { A, G } = loadHost(project, ["renderbatch.jsx"]);
    G.RQItemStatus = { QUEUED: 3015 };
    const r = A.renderbatchRead({ comp_names: ["Main", "Other", "x".repeat(30000)] });
    expect(r.comps[0].queued_item).toEqual({ item_index: 2, num_output_modules: 2, output_files: ["C:/o/om1.mov", "C:/o/om2.mov"] });
    expect(r.comps[1].queued_item).toBeUndefined();
    expect(r.comps[2].count).toBe(0);
    expect(r.comps[2].name.length).toBe(20000);
    expect(project.renderQueue.numItems).toBe(2);
  });

  it("tolerates an empty name list", () => {
    const { A } = loadHost(new FakeProject(), ["renderbatch.jsx"]);
    expect(A.renderbatchRead({ comp_names: [] })).toMatchObject({ comps: [], comp_total: 0 });
    expect(A.renderbatchRead({})).toMatchObject({ comps: [] });
  });
});

// ---------- w5render: Render Queue items in a batch (-rqindex) ----------

describe("w5render: batch schema for queue_items", () => {
  const outputDir = path.join(os.tmpdir(), "out");
  const q = { rq_index: 2, item_comp_id: 5 };

  it("takes queue items alone, with comps, and needs one of the two", () => {
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [q], output_dir: outputDir }).success).toBe(true);
    expect(AeRenderBatchPlanSchema.safeParse({ comps: ["Main"], queue_items: [q], output_dir: outputDir }).success).toBe(true);
    expect(AeRenderBatchPlanSchema.safeParse({ output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ comps: [], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchStartSchema.safeParse({ queue_items: [q], output_dir: outputDir, expect: { project_path: "<unsaved>" } }).success).toBe(true);
  });

  it("guards each item with its comp id and keeps indexes and names unique", () => {
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [{ rq_index: 2 }], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [{ rq_index: 0, item_comp_id: 5 }], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [q, q], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [{ ...q, name: "a" }, { rq_index: 3, item_comp_id: 6, name: "A" }], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: [{ ...q, name: "has space" }], output_dir: outputDir }).success).toBe(false);
    expect(AeRenderBatchPlanSchema.safeParse({ queue_items: Array.from({ length: 51 }, (_, i) => ({ rq_index: i + 1, item_comp_id: 5 })), output_dir: outputDir }).success).toBe(false);
  });

  it("describes queue_items and the tools say they take Render Queue items", () => {
    const json = JSON.stringify(zodToJsonSchema(AeRenderBatchStartSchema));
    expect(json).toMatch(/aerender -rqindex/);
    expect(renderbatchTools.find((t) => t.name === "ae_render_batch")!.description).toMatch(/queue_items/);
    expect(renderbatchTools.find((t) => t.name === "ae_render_batch_plan")!.description).toMatch(/queue_items/);
  });
});

const rqRead = (index: number, extra: Partial<QueueItemRead> = {}): QueueItemRead => ({
  index,
  found: true,
  comp_id: 5,
  comp_name: "Hero",
  status: "queued",
  render: true,
  comp_frame_rate: 25,
  comp_duration: 2,
  time_span_start: 0,
  time_span_duration: 2,
  skip_frames: 0,
  num_output_modules: 2,
  output_modules: [
    { index: 1, name: "Output Module 1", file: "C:/deliver/hero.mp4" },
    { index: 2, name: "Output Module 2", file: "C:/deliver/hero.mov" },
  ],
  ...extra,
});

describe("w5render: batch pure logic for queue items", () => {
  const base = (over: Partial<RenderbatchRead> = {}): RenderbatchRead => ({
    project_path: "C:/p/job.aep",
    dirty: false,
    comp_total: 1,
    comps: [],
    templates: { source: "none", render_settings: [], output_modules: [] },
    queue_total: 3,
    queue_items: [rqRead(2)],
    ...over,
  });
  const job = normaliseJob({ queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: "C:/out" });

  it("normaliseJob keeps comps as before and defaults the new list", () => {
    expect(normaliseJob({ comps: ["A"], output_dir: "/o" })).toMatchObject({ comps: ["A"], queue_items: [] });
    expect(job).toMatchObject({ comps: [], queue_items: [{ rq_index: 2, item_comp_id: 5 }] });
  });

  it("expands a queue item after the comp items: its outputs, label and frame estimate", () => {
    const withComp = normaliseJob({ comps: ["Main"], queue_items: [{ rq_index: 2, item_comp_id: 5, name: "master" }, { rq_index: 4, item_comp_id: 6 }], output_dir: "C:/out", specs: [{ name: "x", extension: "mp4" }] });
    const main: CompRead = { name: "Main", count: 1, id: 1, frame_rate: 25, duration: 4, work_area_start: 0, work_area_duration: 4 };
    const items = expandItems(withComp, [main], 0, [rqRead(2), rqRead(4, { found: false, comp_name: undefined, output_modules: undefined })]);
    expect(items.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(items[0]).toMatchObject({ comp_name: "Main", spec_name: "x" });
    expect(items[0].rq_index).toBeUndefined();
    expect(items[1]).toMatchObject({ comp_name: "Hero", spec_name: "master", rq_index: 2, item_comp_id: 5, output_path: "C:/deliver/hero.mp4", output_paths: ["C:/deliver/hero.mp4", "C:/deliver/hero.mov"], frames: 50 });
    // An item the read did not find still appears, so the plan can name the problem.
    expect(items[2]).toMatchObject({ spec_name: "rq4", rq_index: 4, output_path: "", output_paths: [], frames: null });
    expect(outputsOf(items[1])).toEqual(["C:/deliver/hero.mp4", "C:/deliver/hero.mov"]);
    expect(outputsOf({ output_path: "a.mov" })).toEqual(["a.mov"]);
    expect(outputsOf({ output_path: "" })).toEqual([]);
  });

  it("estimates frames from the span and skip frames", () => {
    expect(queueItemFrames(rqRead(1))).toBe(50);
    expect(queueItemFrames(rqRead(1, { skip_frames: 1 }))).toBe(25);
    expect(queueItemFrames(rqRead(1, { time_span_duration: undefined, comp_duration: 4 }))).toBe(100);
    expect(queueItemFrames(rqRead(1, { comp_frame_rate: undefined }))).toBeNull();
    expect(queueItemFrames(undefined)).toBeNull();
  });

  it("a valid queue item makes a valid plan, needs no comp and no extension", () => {
    const read = base();
    const items = expandItems(job, [], 0, read.queue_items);
    const { errors, warnings } = validatePlan(job, read, items, ["C:/p/job.aep"]);
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).not.toMatch(/extension/);
  });

  it("refuses a dirty project, another comp, a status that is not QUEUED, a missing item and an output module without a file", () => {
    const run = (r: RenderbatchRead) => validatePlan(job, r, expandItems(job, [], 0, r.queue_items), ["C:/p/job.aep"]).errors;
    expect(run(base({ dirty: true })).map((e) => e.code)).toEqual(["queue_items_need_saved_project"]);
    expect(run(base({ queue_items: [rqRead(2, { comp_id: 9 })] })).map((e) => e.code)).toEqual(["rq_item_comp_mismatch"]);
    expect(run(base({ queue_items: [rqRead(2, { status: "unqueued" })] })).map((e) => e.code)).toEqual(["rq_item_not_queued"]);
    expect(run(base({ queue_items: [rqRead(2, { status: "unqueued" })] }))[0].message).toMatch(/queued: true/);
    expect(run(base({ queue_items: [rqRead(2, { found: false })] })).map((e) => e.code)).toEqual(["rq_item_not_found"]);
    expect(run(base({ queue_items: undefined })).map((e) => e.code)).toEqual(["rq_item_not_found"]);
    expect(run(base({ queue_items: [rqRead(2, { output_modules: [{ index: 1, file: "C:/a.mp4" }, { index: 2, file: null }] })] })).map((e) => e.code)).toEqual(["rq_item_no_output"]);
  });

  it("an output of the item in _mcp_backups, or the project itself, is refused; the comp-name ambiguity check does not apply", () => {
    const read = base({ queue_items: [rqRead(2, { output_modules: [{ index: 1, file: "C:/x/_mcp_backups/a.mov" }, { index: 2, file: "C:/p/job.aep" }] })] });
    const codes = validatePlan(job, read, expandItems(job, [], 0, read.queue_items), ["C:/p/job.aep"]).errors.map((e) => e.code);
    expect(codes).toEqual(["output_protected", "output_protected"]);
    // A comp of the same name twice stays an error for a comp item and is no concern of a queue item.
    const both = normaliseJob({ comps: ["Hero"], queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: "C:/out", specs: [{ name: "x", extension: "mp4" }] });
    const r2 = base({ comps: [{ name: "Hero", count: 2 }] });
    const errs = validatePlan(both, r2, expandItems(both, r2.comps, 0, r2.queue_items), []).errors;
    expect(errs.map((e) => e.code)).toEqual(["comp_name_ambiguous"]);
  });

  it("two outputs on one file collide, inside an item and across items", () => {
    const same = base({ queue_items: [rqRead(2, { output_modules: [{ index: 1, file: "C:/d/a.mov" }, { index: 2, file: "C:/D/A.mov" }] })] });
    const e1 = validatePlan(job, same, expandItems(job, [], 0, same.queue_items), []).errors;
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ code: "output_collision", item: 1 });
    expect(e1[0].message).toMatch(/same file from two output modules/);
    const two = normaliseJob({ queue_items: [{ rq_index: 2, item_comp_id: 5 }, { rq_index: 3, item_comp_id: 5 }], output_dir: "C:/out" });
    const read = base({ queue_items: [rqRead(2), rqRead(3)] });
    const e2 = validatePlan(two, read, expandItems(two, [], 0, read.queue_items), []).errors;
    expect(e2.map((e) => e.code)).toEqual(["output_collision", "output_collision"]);
    expect(e2[0].message).toMatch(/Items 1 and 2 write the same file/);
  });

  it("an item not found does not look like a collision on an empty path", () => {
    const two = normaliseJob({ queue_items: [{ rq_index: 8, item_comp_id: 5 }, { rq_index: 9, item_comp_id: 5 }], output_dir: "C:/out" });
    const read = base({ queue_items: [rqRead(8, { found: false }), rqRead(9, { found: false })] });
    expect(validatePlan(two, read, expandItems(two, [], 0, read.queue_items), []).errors.map((e) => e.code)).toEqual(["rq_item_not_found", "rq_item_not_found"]);
  });

  it("inspectOutputs and verifyOutputs cover every output of an item", () => {
    const dir = tmp();
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mov");
    const item = { output_path: a, output_paths: [a, b] };
    expect(inspectOutputs([a, b])).toMatchObject({ exists: false, bytes: 0 });
    fs.writeFileSync(a, "x".repeat(10));
    expect(inspectOutputs([a, b])).toMatchObject({ exists: true, bytes: 10 });
    const miss = verifyOutputs(item, null);
    expect(miss.ok).toBe(false);
    expect(miss.reason).toContain(b);
    fs.writeFileSync(b, "y".repeat(5));
    expect(verifyOutputs(item, null)).toMatchObject({ ok: true, bytes: 15 });
    // A file older than the item's start is not a fresh render.
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(b, old, old);
    expect(verifyOutputs(item, Date.now()).ok).toBe(false);
    // A plain item behaves as verifyOutput did.
    expect(verifyOutputs({ output_path: a }, null)).toEqual(verifyOutput(a, null));
    expect(inspectOutputs([a])).toEqual(inspectOutput(a));
  });
});

describe("w5render: batch with queue items through a fake bridge", () => {
  const queueRig = (override: Partial<RenderbatchRead> = {}, opts: { dirty?: boolean } = {}) => {
    // The item's files live in the rig's own folder; the read mock reads this object at call time.
    const readOpts: Partial<RenderbatchRead> = {};
    const r = rig({ dirty: opts.dirty, read: readOpts });
    const hero = path.join(r.dir, "deliver", "hero.mp4");
    const mov = path.join(r.dir, "deliver", "hero.mov");
    Object.assign(readOpts, { queue_total: 3, queue_items: [rqRead(2, { output_modules: [{ index: 1, name: "OM1", file: hero }, { index: 2, name: "OM2", file: mov }] })], ...override });
    return Object.assign(r, { files: [hero, mov] });
  };
  const args = (r: Rig, extra: Record<string, unknown> = {}) =>
    AeRenderBatchStartSchema.parse({ expect: expectArg(r.project), queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir, preflight: false, ...extra });

  it("the plan reads the queue items by index and counts every output", async () => {
    const r = queueRig();
    const out = await r.tool("ae_render_batch_plan").handler(AeRenderBatchPlanSchema.parse({ queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir }), r.ctx);
    expect(r.calls).toEqual(["renderbatchRead"]);
    expect(out).toMatchObject({ ok: true, valid: true, item_count: 1 });
    expect(out.items[0]).toMatchObject({ rq_index: 2, item_comp_id: 5, comp_name: "Hero", frames: 50 });
    expect(out.items[0].output_paths).toHaveLength(2);
    expect(out.items[0].existing).toMatchObject({ exists: false });
    expect(r.spawned).toHaveLength(0);
  });

  it("the plan counts an existing second output toward the overwrite check", async () => {
    const r = queueRig();
    fs.mkdirSync(path.dirname(r.files[1]), { recursive: true });
    fs.writeFileSync(r.files[1], "recent");
    const out = await r.tool("ae_render_batch_plan").handler(AeRenderBatchPlanSchema.parse({ queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir }), r.ctx);
    expect(out.items[0].existing).toMatchObject({ exists: true, would_block: true });
  });

  it("starts the item with -rqindex and its outputs, no -comp, -output, templates or -s/-e", async () => {
    const r = queueRig();
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    expect(r.calls).toEqual(["status", "renderbatchRead"]);
    expect(out).toMatchObject({ ok: true, state: "running", counts: { running: 1 } });
    expect(out.items[0]).toMatchObject({ rq_index: 2, output_paths: r.files, spec: "rq2", comp: "Hero" });
    const a = r.spawned[0].args;
    expect(a.slice(a.indexOf("-project"), a.indexOf("-project") + 4)).toEqual(["-project", out.frozen_project, "-rqindex", "2"]);
    for (const flag of ["-comp", "-output", "-OMtemplate", "-RStemplate", "-s", "-e"]) expect(a).not.toContain(flag);
    expect(a).toEqual(expect.arrayContaining(["-mfr", "ON", "50"]));
    expect(a.some((x) => /reuse/i.test(x))).toBe(false);
    const rec = r.registry.list()[0];
    expect(rec).toMatchObject({ rq_index: 2, item_comp_id: 5, comp_name: "Hero", output_paths: r.files });
    // The output folders of the item's modules are made by the launcher.
    expect(fs.existsSync(path.dirname(r.files[0]))).toBe(true);
    const saved = JSON.parse(fs.readFileSync(out.batch_json, "utf8"));
    expect(saved.items[0]).toMatchObject({ rq_index: 2, item_comp_id: 5, output_paths: r.files });
  });

  it("measures free space on the volume of the queue item's own outputs, not output_dir", async () => {
    const r = queueRig({ queue_items: [rqRead(2, { output_modules: [{ index: 1, name: "OM1", file: "Q:/deliver/hero.mp4" }, { index: 2, name: "OM2", file: "Q:/deliver/hero.mov" }] })] });
    r.space.by = (dir) => (dir.startsWith("Q:") ? 1 * GIB : 500 * GIB);
    const plan = await r.tool("ae_render_batch_plan").handler(AeRenderBatchPlanSchema.parse({ queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir }), r.ctx);
    expect(plan.free_space).toMatchObject({ status: "low" });
    expect(plan.free_space.dir.startsWith("Q:")).toBe(true);
    // Both modules are on Q:, and a queue-only job writes nothing under output_dir: one row, and output_dir is not measured.
    expect(plan.free_space_volumes).toBeUndefined();
    expect(r.space.asked.every((d) => d.startsWith("Q:"))).toBe(true);
    r.space.asked.length = 0;
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    expect(out.ok).toBe(true);
    expect(r.spawned).toHaveLength(0);
    const b = r.rb.getStore().get(out.batch_id)!;
    expect(b.items[0].error).toContain("GB free");
    expect(b.free_space).toMatchObject({ status: "low" });
    expect(r.space.asked.some((d) => d.startsWith("Q:"))).toBe(true);
  });

  it("a mixed plan measures output_dir too, and a queue-only plan on a healthy output_dir is not blocked by it", async () => {
    const r = queueRig({ queue_items: [rqRead(2, { output_modules: [{ index: 1, name: "OM1", file: "Q:/deliver/hero.mp4" }] })] });
    r.space.by = (dir) => (dir.startsWith("Q:") ? 500 * GIB : 1 * GIB);
    const queueOnly = await r.tool("ae_render_batch_plan").handler(AeRenderBatchPlanSchema.parse({ queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir }), r.ctx);
    expect(queueOnly.free_space).toMatchObject({ status: "ok" });
    expect(queueOnly.free_space_volumes).toBeUndefined();
    const mixed = await r.tool("ae_render_batch_plan").handler(
      AeRenderBatchPlanSchema.parse({ comps: ["Main"], specs: [{ name: "h264", output_module_template: "H.264", extension: "mp4" }], queue_items: [{ rq_index: 2, item_comp_id: 5 }], output_dir: r.outDir }),
      r.ctx
    );
    expect(mixed.free_space_volumes).toHaveLength(2);
    expect(mixed.free_space).toMatchObject({ status: "low", dir: r.outDir });
  });

  it("mayShareVolume separates only two different drive letters; a POSIX or UNC path stays conservative", () => {
    expect(mayShareVolume("C:/a", "D:/b")).toBe(false);
    expect(mayShareVolume("C:/a", "c:/b")).toBe(true);
    expect(mayShareVolume("/Volumes/X/a", "/Volumes/X/b")).toBe(true);
    expect(mayShareVolume("/Volumes/X/a", "C:/b")).toBe(true);
    expect(mayShareVolume("//nas/share/a", "D:/b")).toBe(true);
  });

  it("reserves the estimated size of a running item for a queue item on a path whose volume cannot be identified", async () => {
    // The queue item writes under /Volumes/X/b (no drive letter). The running comp item writes under output_dir.
    // The two may share a disk, so the running item's estimated size is not free space for the queue item.
    const posix = "/Volumes/X/b/chroma-test-hero.mp4";
    const r = queueRig({ queue_items: [rqRead(2, { output_modules: [{ index: 1, name: "OM1", file: posix }] })] });
    const out = await r.tool("ae_render_batch").handler(
      args(r, { comps: ["Main", "Square"], specs: [{ name: "h264", output_module_template: "H.264", extension: "mp4" }], min_free_gb: 1 }),
      r.ctx
    );
    expect(out.ok).toBe(true);
    const id = out.batch_id as string;
    const b = r.rb.getStore().get(id)!;
    expect(b.items.map((i) => i.state)).toEqual(["running", "pending", "pending"]);
    r.finish(b.items[0].job_id!, true);
    await r.rb.getRunner().tick(id);
    expect(b.items.map((i) => i.state)).toEqual(["succeeded", "running", "pending"]);
    b.items[0].output_bytes = 5 * GIB; // ~5.5 GiB estimated for the running Square item
    b.options.concurrency = 2;
    r.space.by = (dir) => (dir.startsWith("/Volumes/X") ? 6 * GIB : 500 * GIB);
    await r.rb.getRunner().tick(id);
    expect(b.items[2].state).toBe("failed");
    expect(b.items[2].error).toContain("reserved for running items");
    expect(r.spawned).toHaveLength(2);
  });

  it("status with include_free_space measures the batch's real volumes, not output_dir", async () => {
    const r = queueRig({ queue_items: [rqRead(2, { output_modules: [{ index: 1, name: "OM1", file: "Q:/deliver/hero.mp4" }] })] });
    r.space.by = (dir) => (dir.startsWith("Q:") ? 1 * GIB : 500 * GIB);
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    expect(out.ok).toBe(true);
    r.space.asked.length = 0;
    const s = await r.tool("ae_render_batch_status").handler({ batch_id: out.batch_id, include_free_space: true }, r.ctx);
    expect(s.free_space).toMatchObject({ status: "low" });
    expect(s.free_space.dir.startsWith("Q:")).toBe(true);
    expect(s.free_space_volumes).toBeUndefined();
    expect(r.space.asked.length).toBeGreaterThan(0);
    expect(r.space.asked.every((d) => d.startsWith("Q:"))).toBe(true);
  });

  it("mixes comp items and queue items; comp items still use -comp", async () => {
    const r = queueRig();
    const out = await r.tool("ae_render_batch").handler(
      args(r, { comps: ["Main"], specs: [{ name: "h264", output_module_template: "H.264", extension: "mp4" }], concurrency: 2 }),
      r.ctx
    );
    expect(out.ok).toBe(true);
    expect(r.spawned).toHaveLength(2);
    expect(r.spawned[0].args).toEqual(expect.arrayContaining(["-comp", "Main", "-OMtemplate", "H.264"]));
    expect(r.spawned[1].args).toEqual(expect.arrayContaining(["-rqindex", "2"]));
    expect(out.items.map((i: { rq_index?: number }) => i.rq_index)).toEqual([undefined, 2]);
  });

  it("refuses with plan_invalid and starts nothing: dirty with allow_dirty, another comp, not queued", async () => {
    const dirty = queueRig({}, { dirty: true });
    const d = await dirty.tool("ae_render_batch").handler(args(dirty, { allow_dirty: true }), dirty.ctx);
    expect(d).toMatchObject({ ok: false, error: "plan_invalid", applied: false });
    expect(d.errors.map((e: { code: string }) => e.code)).toEqual(["queue_items_need_saved_project"]);
    expect(dirty.spawned).toHaveLength(0);

    const other = queueRig({ queue_items: [rqRead(2, { comp_id: 9 })] });
    const o = await other.tool("ae_render_batch").handler(args(other), other.ctx);
    expect(o.errors.map((e: { code: string }) => e.code)).toEqual(["rq_item_comp_mismatch"]);
    expect(other.spawned).toHaveLength(0);

    const unq = queueRig({ queue_items: [rqRead(2, { status: "unqueued" })] });
    const u = await unq.tool("ae_render_batch").handler(args(unq), unq.ctx);
    expect(u.errors.map((e: { code: string }) => e.code)).toEqual(["rq_item_not_queued"]);
    expect(unq.spawned).toHaveLength(0);
  });

  it("refuses when the project file changed between the read and the freeze, and cleans up", async () => {
    const r = queueRig();
    const store = r.rb.getStore();
    // The read of the queue is where the file is saved over, as a save by the user would.
    const realCall = r.ctx.bridge.evalRaw.bind(r.ctx.bridge);
    (r.ctx.bridge as unknown as { evalRaw: typeof r.ctx.bridge.evalRaw }).evalRaw = (async (req: Parameters<typeof realCall>[0]) => {
      const res = await realCall(req);
      if (req.script.includes("renderbatchRead")) fs.writeFileSync(r.project, "aep-bytes-saved-again-and-longer");
      return res;
    }) as typeof r.ctx.bridge.evalRaw;
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    expect(out).toMatchObject({ ok: false, error: "project_changed", applied: false });
    expect(r.spawned).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it("an item is succeeded only when every output module's file is fresh and not empty", async () => {
    const r = queueRig();
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    const id = out.batch_id as string;
    const jobId = r.rb.getStore().get(id)!.items[0].job_id!;
    fs.writeFileSync(r.files[0], "x".repeat(100));
    registryDone(r, jobId);
    const failed = await r.rb.getRunner().tick(id);
    expect(failed!.items[0].state).toBe("failed");
    expect(failed!.items[0].error).toContain(r.files[1]);
    expect(failed!.state).toBe("failed");

    // Resume renders it again; with both files written it passes and the sizes add up.
    const again = await r.tool("ae_render_batch_resume").handler(AeRenderBatchResumeSchema.parse({ expect: expectArg(r.project), batch_id: id, if_output_exists: "overwrite" }), r.ctx);
    expect(again).toMatchObject({ ok: true, reset: 1 });
    const job2 = r.rb.getStore().get(id)!.items[0].job_id!;
    fs.writeFileSync(r.files[0], "x".repeat(100));
    fs.writeFileSync(r.files[1], "y".repeat(50));
    registryDone(r, job2);
    const done = await r.rb.getRunner().tick(id);
    expect(done!.items[0]).toMatchObject({ state: "succeeded", output_bytes: 150 });
    expect(done!.state).toBe("succeeded");
  });

  it("protects a recent second output (protect_recent) and skips the item when the outputs exist (skip)", async () => {
    const r = queueRig();
    fs.mkdirSync(path.dirname(r.files[1]), { recursive: true });
    fs.writeFileSync(r.files[1], "recent");
    const out = await r.tool("ae_render_batch").handler(args(r), r.ctx);
    expect(r.spawned).toHaveLength(0);
    const b = r.rb.getStore().get(out.batch_id)!;
    expect(b.items[0].state).toBe("failed");
    expect(b.items[0].error).toMatch(/blocked: .*was written/);

    const s = queueRig();
    fs.mkdirSync(path.dirname(s.files[0]), { recursive: true });
    fs.writeFileSync(s.files[0], "a");
    fs.writeFileSync(s.files[1], "b");
    const skipped = await s.tool("ae_render_batch").handler(args(s, { if_output_exists: "skip" }), s.ctx);
    expect(s.spawned).toHaveLength(0);
    expect(s.rb.getStore().get(skipped.batch_id)!.items[0]).toMatchObject({ state: "skipped", output_bytes: 2 });
  });
});

describe("renderbatch.jsx: Render Queue items", () => {
  const STATUS = { QUEUED: 3015, DONE: 3016, UNQUEUED: 3014 };

  function sceneWithQueue() {
    const project = new FakeProject();
    const hero = project.addComp("Hero", 1920, 1080, 4);
    hero.workAreaStart = 0;
    const other = project.addComp("Other", 640, 360, 2);
    const first = project.renderQueue.items.add(other);
    Object.assign(first, { status: STATUS.DONE, render: false, timeSpanStart: 0, timeSpanDuration: 2, skipFrames: 0, numOutputModules: 1, outputModule: () => ({ name: "Lossless", templates: [], file: { fsName: "C:/old/other.mov" } }) });
    const second = project.renderQueue.items.add(hero);
    Object.assign(second, {
      status: STATUS.QUEUED,
      render: true,
      timeSpanStart: 1,
      timeSpanDuration: 2,
      skipFrames: 1,
      numOutputModules: 2,
      outputModule: (j: number) => ({ name: `Output Module ${j}`, templates: [], file: j === 2 ? null : { fsName: "C:/deliver/hero.mp4" } }),
    });
    const { A, G, undo } = loadHost(project, ["renderbatch.jsx"]);
    G.RQItemStatus = STATUS;
    return { project, A, undo, hero };
  }

  it("reads the named Render Queue items: status, comp, span, rate and every output module, changing nothing", () => {
    const { A, undo, project, hero } = sceneWithQueue();
    const r = A.renderbatchRead({ comp_names: [], rq_items: [{ rq_index: 2 }, { rq_index: 1 }, { rq_index: 7 }] });
    expect(r.queue_total).toBe(2);
    expect(r.queue_items).toHaveLength(3);
    expect(r.queue_items[0]).toMatchObject({
      index: 2,
      found: true,
      comp_id: hero.id,
      comp_name: "Hero",
      status: "queued",
      render: true,
      comp_frame_rate: 25,
      comp_duration: 4,
      time_span_start: 1,
      time_span_duration: 2,
      skip_frames: 1,
      num_output_modules: 2,
    });
    expect(r.queue_items[0].output_modules).toEqual([
      { index: 1, name: "Output Module 1", file: "C:/deliver/hero.mp4" },
      { index: 2, name: "Output Module 2", file: null },
    ]);
    expect(r.queue_items[1]).toMatchObject({ index: 1, status: "done", render: false });
    expect(r.queue_items[2]).toEqual({ index: 7, found: false });
    expect(project.renderQueue.numItems).toBe(2);
    expect(undo.begun).toBe(0);
  });

  it("leaves queue_items out when none are asked for, and a comp-only read is unchanged", () => {
    const { A } = sceneWithQueue();
    const r = A.renderbatchRead({ comp_names: ["Hero"] });
    expect(r.queue_items).toBeUndefined();
    expect(r.comps[0]).toMatchObject({ name: "Hero", count: 1 });
  });

  it("feeds the plan: the host's read through selectRqItem accepts the queued item only when its outputs are complete", () => {
    const { A, hero } = sceneWithQueue();
    const r = JSON.parse(JSON.stringify(A.renderbatchRead({ comp_names: [], rq_items: [{ rq_index: 2 }] }))) as RenderbatchRead;
    const job = normaliseJob({ queue_items: [{ rq_index: 2, item_comp_id: hero.id }], output_dir: "C:/out" });
    const errs = validatePlan(job, r, expandItems(job, [], 0, r.queue_items), []).errors;
    expect(errs.map((e) => e.code)).toEqual(["rq_item_no_output"]);
  });
});
