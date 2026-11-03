import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeApplySpecSchema,
  AeCheckDeliveryFileSchema,
  AeDeliverySpecsSchema,
  AeRenderQueueDuplicateSchema,
  AeRenderQueueEditSchema,
  AeRenderQueueInspectSchema,
  SPEC_LIBRARY,
  checkDeliveryFile,
  copiesMismatches,
  editMismatches,
  itemMismatches,
  pathKey,
  rqeditTools,
  sameSetting,
  settingsMismatches,
  specById,
  stepMismatches,
  unknownNameTokens,
  type ItemRead,
  type PlanEcho,
} from "../src/tools/ext/rqedit.js";
import { FakeFile, FakeProject, GUARD, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rqedit-"));
  tmpDirs.push(d);
  return d;
};

const tool = (name: string) => rqeditTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
/** Host results come from the vm's realm; a JSON round trip makes them comparable. */
const plainOf = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- a Render Queue for the fake AE ----------

const STATUS = { WILL_CONTINUE: 1, NEEDS_OUTPUT: 2, UNQUEUED: 3, QUEUED: 4, RENDERING: 5, USER_STOPPED: 6, ERR_STOPPED: 7, DONE: 8 };
const POST = { NONE: 20, IMPORT: 21, IMPORT_AND_REPLACE_USAGE: 22, SET_PROXY: 23 };
const LOG = { ERRORS_ONLY: 30, ERRORS_AND_SETTINGS: 31, ERRORS_AND_PER_FRAME_INFO: 32 };
const SETTINGS_FORMAT = { SPEC: 1, STRING_SETTABLE: 2, NUMBER_SETTABLE: 3 };

const RS_TEMPLATES = ["Best Settings", "Draft Settings", "Multi-Machine Settings"];
const OM_TEMPLATES = ["Lossless", "H.264 - Match Render Settings - 15 Mbps", "H.264 - Match Render Settings - 40 Mbps", "Apple ProRes 422 HQ", "PNG Sequence"];

type Settings = Record<string, unknown>;

/** What each output module template leaves: the keys a format offers differ (a PNG sequence has no audio). */
function templateSettings(name: string, comp: FakeComp, shape: "array" | "text"): Settings {
  const size = shape === "array" ? [comp.width, comp.height] : `${comp.width} x ${comp.height}`;
  const base: Settings = {
    Format: "AVI",
    "Video Output": true,
    Channels: "RGB",
    Resize: false,
    "Resize to": size,
    "Output File Info": { "Base Path": "", "File Name": "" },
  };
  if (name.startsWith("H.264")) return { ...base, Format: "H.264", "Audio Sample Rate": 48000, "Output Audio": "Auto" };
  if (name.startsWith("Apple ProRes")) return { ...base, Format: "QuickTime", "Audio Sample Rate": 48000, "Output Audio": "Auto" };
  if (name.startsWith("PNG")) return { ...base, Format: "PNG Sequence", Channels: "RGB + Alpha" };
  return base;
}

class FakeOM {
  settings: Settings;
  file: FakeFile | null = null;
  postRenderAction = POST.NONE;
  includeSourceXMP = false;
  name = "Output Module 1";
  templates = OM_TEMPLATES;
  templatesApplied: string[] = [];
  constructor(public item: FakeItem, public shape: "array" | "text") {
    this.settings = templateSettings("Lossless", item.comp, shape);
  }
  getSettings(fmt: number) {
    if (fmt !== SETTINGS_FORMAT.STRING_SETTABLE) throw new Error("Only STRING_SETTABLE is faked");
    return JSON.parse(JSON.stringify(this.settings));
  }
  setSettings(o: Settings) {
    for (const [k, v] of Object.entries(o)) {
      if (k.toLowerCase() === "format") throw new Error("Property is read-only");
      if (!(k in this.settings)) throw new Error(`Unknown setting ${k}`);
      this.settings[k] = JSON.parse(JSON.stringify(v));
    }
  }
  applyTemplate(name: string) {
    if (!this.templates.includes(name)) throw new Error(`No template ${name}`);
    this.templatesApplied.push(name);
    this.settings = templateSettings(name, this.item.comp, this.shape);
  }
  remove() {
    this.item.mods.splice(this.item.mods.indexOf(this), 1);
  }
}

class FakeItem {
  status = STATUS.QUEUED;
  render = true;
  timeSpanStart = 0;
  timeSpanDuration: number;
  skipFrames = 0;
  logType = LOG.ERRORS_ONLY;
  templates = RS_TEMPLATES;
  settings: Settings = { Quality: "Best", Resolution: "Full", "Frame Rate": "25", "Use this frame rate": "Off" };
  mods: FakeOM[] = [];
  outputModules = { add: () => this.addModule() };
  constructor(public rq: FakeRq, public comp: FakeComp, public shape: "array" | "text") {
    this.timeSpanDuration = comp.duration;
    this.addModule();
  }
  addModule() {
    const om = new FakeOM(this, this.shape);
    this.mods.push(om);
    return om;
  }
  get numOutputModules() {
    return this.mods.length;
  }
  outputModule(i: number) {
    const om = this.mods[i - 1];
    if (!om) throw new Error(`Output module ${i} out of range`);
    return om;
  }
  getSettings(fmt: number) {
    if (fmt !== SETTINGS_FORMAT.STRING_SETTABLE) throw new Error("Only STRING_SETTABLE is faked");
    return JSON.parse(JSON.stringify(this.settings));
  }
  setSettings(o: Settings) {
    for (const [k, v] of Object.entries(o)) {
      if (!(k in this.settings)) throw new Error(`Unknown setting ${k}`);
      this.settings[k] = JSON.parse(JSON.stringify(v));
    }
  }
  applyTemplate(name: string) {
    if (!this.templates.includes(name)) throw new Error(`No template ${name}`);
  }
  /** A copy keeps the source's output paths, as AE may. */
  duplicate() {
    const copy = new FakeItem(this.rq, this.comp, this.shape);
    copy.mods = [];
    for (const m of this.mods) {
      const c = new FakeOM(copy, this.shape);
      c.settings = JSON.parse(JSON.stringify(m.settings));
      c.file = m.file;
      c.postRenderAction = m.postRenderAction;
      copy.mods.push(c);
    }
    copy.timeSpanStart = this.timeSpanStart;
    copy.timeSpanDuration = this.timeSpanDuration;
    copy.settings = { ...this.settings };
    copy.status = STATUS.QUEUED;
    this.rq.insert(copy, this);
    return copy;
  }
}

class FakeRq {
  list: FakeItem[] = [];
  rendering = false;
  /** Where duplicates land: after the source (AE's UI) or at the end. */
  duplicateAfterSource = false;
  shape: "array" | "text" = "array";
  items = { add: (comp: FakeComp) => this.add(comp) };
  get numItems() {
    return this.list.length;
  }
  item(i: number) {
    return this.list[i - 1];
  }
  add(comp: FakeComp) {
    const it = new FakeItem(this, comp, this.shape);
    this.list.push(it);
    return it;
  }
  insert(copy: FakeItem, source: FakeItem) {
    this.list.splice(this.duplicateAfterSource ? this.list.indexOf(source) + 1 : this.list.length, 0, copy);
  }
}

function scene(opts: { shape?: "array" | "text"; width?: number; height?: number; duplicateAfterSource?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main Film", opts.width ?? 1920, opts.height ?? 1080, 10);
  const rq = new FakeRq();
  rq.shape = opts.shape ?? "array";
  rq.duplicateAfterSource = opts.duplicateAfterSource ?? false;
  (project as unknown as { renderQueue: FakeRq }).renderQueue = rq;
  const { A, undo, G } = loadHost(project, ["rqedit.jsx"]);
  Object.assign(G, {
    GetSettingsFormat: SETTINGS_FORMAT,
    RQItemStatus: STATUS,
    PostRenderAction: POST,
    LogType: LOG,
  });
  const item = rq.add(comp);
  return { project, comp, rq, A, undo, item, G };
}

/** The item as ae_render_queue_inspect shows it, from the host. */
const read = (A: any, ...indexes: number[]) => plainOf(A.rqeditRead({ item_indexes: indexes.length ? indexes : undefined, settings: true })) as { numItems: number; items: ItemRead[] };

// ---------- a PanelHost over a script of host results ----------

type Result = unknown | (() => unknown);

function fakeAe(results: Record<string, Result[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = tmp();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      const value = typeof next === "function" ? (next as () => unknown)() : next;
      return { ok: true, result: value, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const item = (index: number, extra: Partial<ItemRead> = {}): ItemRead => ({
  index,
  comp_id: 5,
  status: "queued",
  time_span_start: 0,
  time_span_duration: 10,
  skip_frames: 0,
  log_type: "errors_only",
  num_output_modules: 1,
  output_modules: [{ index: 1, file: "C:\\out\\a.mp4", post_render_action: "none", include_source_xmp: false, settings: { Channels: "RGB" } }],
  render_settings: { Quality: "Best" },
  ...extra,
});
const queueOfItems = (...items: ItemRead[]) => ({ numItems: items.length, rendering: false, items });

// ---------- schemas ----------

describe("rqedit schemas", () => {
  it("ae_render_queue_edit needs a change, an absolute file, and refuses the read-only Format", () => {
    const base = { item_index: 1, expect: expectArg };
    expect(AeRenderQueueEditSchema.safeParse(base).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, skip_frames: 2 }).success).toBe(true);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, skip_frames: 100 }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, output_modules: [{ index: 1, file: "out/a.mp4" }] }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, output_modules: [{ index: 1 }] }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, output_modules: [{ index: 1, settings: { Format: "H.264" } }] }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, output_modules: [{ index: 1, settings: { format: "H.264" } }] }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, render_settings: { Format: "x" } }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, output_modules: [{ index: 1, settings: { "Resize to": [1280, 720], Resize: true } }] }).success).toBe(true);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, time_span: "work_area" }).success).toBe(true);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, time_span: { start: 1, duration: 0 } }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ ...base, log_type: "everything" }).success).toBe(false);
    expect(AeRenderQueueEditSchema.safeParse({ skip_frames: 1, item_index: 1 }).success).toBe(false);
  });

  it("ae_render_queue_duplicate takes a count or copies, not both", () => {
    const base = { item_index: 2, expect: expectArg };
    expect(AeRenderQueueDuplicateSchema.safeParse(base).success).toBe(false);
    expect(AeRenderQueueDuplicateSchema.safeParse({ ...base, count: 3 }).success).toBe(true);
    expect(AeRenderQueueDuplicateSchema.safeParse({ ...base, copies: [{ output_module_template: "Lossless", file: "C:/out/a.mov" }] }).success).toBe(true);
    expect(AeRenderQueueDuplicateSchema.safeParse({ ...base, copies: [{ output_module_template: "Lossless" }] }).success).toBe(false);
    expect(AeRenderQueueDuplicateSchema.safeParse({ ...base, count: 1, copies: [{}] }).success).toBe(false);
    expect(AeRenderQueueDuplicateSchema.safeParse({ ...base, count: 21 }).success).toBe(false);
  });

  it("ae_render_queue_apply_spec checks ids, name tokens and that several specs get different names", () => {
    const base = { item_index: 1, output_folder: "C:/out", expect: expectArg };
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["youtube_1080p"] }).success).toBe(true);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["myspace_240p"] }).success).toBe(false);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["youtube_1080p", "youtube_1080p"] }).success).toBe(false);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["tiktok"], file_name: "[bogus].mp4" }).success).toBe(false);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["tiktok", "youtube_1080p"], file_name: "final" }).success).toBe(false);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["tiktok", "youtube_1080p"], file_name: "final_[spec]" }).success).toBe(true);
    expect(AeApplySpecSchema.safeParse({ ...base, specs: ["png_sequence"], file_name: "[compName]_[#####].png" }).success).toBe(true);
    expect(AeApplySpecSchema.safeParse({ ...base, output_folder: "out", specs: ["tiktok"] }).success).toBe(false);
  });

  it("the read tools and the file check take small inputs", () => {
    expect(AeRenderQueueInspectSchema.safeParse({}).success).toBe(true);
    expect(AeRenderQueueInspectSchema.safeParse({ item_index: 0 }).success).toBe(false);
    expect(AeDeliverySpecsSchema.safeParse({ ids: ["gif", "tiktok"] }).success).toBe(true);
    expect(AeDeliverySpecsSchema.safeParse({ ids: ["vine"] }).success).toBe(false);
    expect(AeCheckDeliveryFileSchema.safeParse({ spec_id: "tiktok", file_path: "C:/out/a.mp4" }).success).toBe(true);
  });

  it("every writing tool takes expect and ends its description with the safety guidance", () => {
    const names = rqeditTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "ae_render_queue_inspect",
      "ae_render_queue_edit",
      "ae_render_queue_duplicate",
      "ae_delivery_specs",
      "ae_render_queue_apply_spec",
      "ae_check_delivery_file",
    ]);
    for (const name of ["ae_render_queue_edit", "ae_render_queue_duplicate", "ae_render_queue_apply_spec"]) {
      expect(tool(name).description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    }
    expect(AeRenderQueueEditSchema.safeParse({ item_index: 1, skip_frames: 1 }).success).toBe(false);
    expect(AeRenderQueueDuplicateSchema.safeParse({ item_index: 1, count: 1 }).success).toBe(false);
    expect(AeApplySpecSchema.safeParse({ item_index: 1, specs: ["tiktok"], output_folder: "C:/out" }).success).toBe(false);
    for (const name of ["ae_render_queue_inspect", "ae_delivery_specs", "ae_check_delivery_file"]) {
      expect(tool(name).description).toMatch(/Changes nothing/);
    }
  });
});

// ---------- pure logic ----------

describe("rqedit pure logic", () => {
  it("the spec library is consistent", () => {
    const ids = SPEC_LIBRARY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SPEC_LIBRARY) {
      expect(unknownNameTokens(s.name_template)).toEqual([]);
      expect(s.name_template.endsWith(`.${s.ext}`)).toBe(true);
      for (const c of s.template_candidates) expect(() => new RegExp(c.pattern, c.flags)).not.toThrow();
      if (!s.refuse) expect(s.template_candidates.length).toBeGreaterThan(0);
      if (s.container === "png_sequence") expect(s.name_template).toMatch(/\[#+\]/);
    }
    expect(specById("gif")?.refuse).toMatch(/GIF/);
    expect(specById("instagram_reels_story")?.resize).toEqual({ width: 1080, height: 1920 });
    expect(specById("wav_audio")?.video_output).toBe(false);
    // The library goes through JSON to the host.
    expect(JSON.parse(JSON.stringify(SPEC_LIBRARY))).toEqual(SPEC_LIBRARY);
  });

  it("the H.264 candidates prefer the template with the right bitrate", () => {
    const pick = (id: string, installed: string[]) => {
      for (const c of specById(id)!.template_candidates) {
        const hit = installed.find((n) => new RegExp(c.pattern, c.flags).test(n));
        if (hit) return hit;
      }
      return null;
    };
    const names = ["H.264 - Match Render Settings - 40 Mbps", "H.264 - Match Render Settings - 15 Mbps", "Lossless"];
    expect(pick("youtube_1080p", names)).toBe("H.264 - Match Render Settings - 15 Mbps");
    expect(pick("youtube_4k", names)).toBe("H.264 - Match Render Settings - 40 Mbps");
    expect(pick("youtube_1080p", ["H.264 - Match Render Settings - 5 Mbps"])).toBe("H.264 - Match Render Settings - 5 Mbps");
    expect(pick("youtube_1080p", ["Lossless"])).toBeNull();
    expect(pick("broadcast_hd", ["Apple ProRes 422 HQ"])).toBe("Apple ProRes 422 HQ");
    expect(pick("broadcast_hd", ["Apple ProRes 422"])).toBeNull();
  });

  it("finds unknown name tokens and keeps AE's frame number", () => {
    expect(unknownNameTokens("[compName]_[spec]_[width]x[height]_[date]_[copy]")).toEqual([]);
    expect(unknownNameTokens("[compName]_[#####].png")).toEqual([]);
    expect(unknownNameTokens("[comp]_[nope]")).toEqual(["comp", "nope"]);
  });

  it("compares settings across the types AE reads back", () => {
    expect(sameSetting(true, "On")).toBe(true);
    expect(sameSetting(true, "off")).toBe(false);
    expect(sameSetting(false, false)).toBe(true);
    expect(sameSetting(48000, "48.000 kHz")).toBe(true);
    expect(sameSetting(48000, 44100)).toBe(false);
    expect(sameSetting([1280, 720], [1280, 720])).toBe(true);
    expect(sameSetting([1280, 720], "1280 x 720")).toBe(true);
    expect(sameSetting([1280, 720], { width: 1280, height: 720 })).toBe(true);
    expect(sameSetting([1280, 720], "1920 x 1080")).toBe(false);
    expect(sameSetting({ "File Name": "a" }, { "Base Path": "C:/", "File Name": "a" })).toBe(true);
    expect(sameSetting({ "File Name": "a" }, { "File Name": "b" })).toBe(false);
    expect(sameSetting("RGB", " rgb ")).toBe(true);
    expect(sameSetting("30", 30)).toBe(true);
    expect(sameSetting(30, "30")).toBe(true);
    expect(sameSetting("x", undefined)).toBe(false);
    expect(pathKey("C:\\Out\\A.mp4")).toBe("c:/out/a.mp4");
  });

  it("a size read back as strings in an object matches the array asked for", () => {
    expect(sameSetting([1280, 720], { x: "1280", y: "720" })).toBe(true);
    expect(sameSetting([1280, 720], { width: "1280", height: "720" })).toBe(true);
    expect(sameSetting([1280, 720], { x: "1280", y: "1080" })).toBe(false);
    expect(sameSetting([1280, 720], { x: "1280" })).toBe(false);
    expect(sameSetting([1280, 720], ["1280", "720"])).toBe(true);
  });

  it("a skipped key is excused only where it was skipped", () => {
    const echo: PlanEcho = {
      render_settings: { Channels: "RGB" },
      num_output_modules: 2,
      modules: [
        { index: 1, plan_index: 1, settings: { Channels: "RGB" } },
        { index: 2, plan_index: 2, settings: { Channels: "RGB" } },
      ],
    };
    const wrong = item(1, {
      num_output_modules: 2,
      render_settings: { Channels: "RGBA" },
      output_modules: [
        { index: 1, settings: { Channels: "RGBA" } },
        { index: 2, settings: {} },
      ],
    });
    const m = itemMismatches("w", echo, wrong, [{ where: "Copy 1 output module 2", key: "Channels" }]);
    expect(m.map((x) => x.path).sort()).toEqual(["w.output_modules[1].Channels", "w.render_settings.Channels"].sort());
  });

  it("settingsMismatches names each key that differs, is missing or was skipped", () => {
    const m = settingsMismatches("w", { A: 1, B: "x", C: true, D: 2 }, { A: 1, B: "y", D: 3 }, new Set(["D"]));
    expect(m.map((x) => x.path)).toEqual(["w.B", "w.C"]);
    expect(settingsMismatches("w", { A: 1 }, null, new Set()).length).toBe(1);
    expect(settingsMismatches("w", undefined, null, new Set())).toEqual([]);
  });

  it("itemMismatches compares span, counts, files and settings", () => {
    const echo: PlanEcho = {
      time_span: { start: 1, duration: 4 },
      skip_frames: 2,
      log_type: "errors_only",
      render_settings: { Quality: "Draft" },
      num_output_modules: 1,
      modules: [{ index: 1, file: "C:/out/a.mp4", settings: { Channels: "RGB" }, post_render_action: "none" }],
    };
    const good = item(1, { time_span_start: 1, time_span_duration: 4, skip_frames: 2, render_settings: { Quality: "Draft" } });
    expect(itemMismatches("w", echo, good, [])).toEqual([]);
    const bad = item(1, { time_span_start: 2, time_span_duration: 4, skip_frames: 0, num_output_modules: 2, render_settings: { Quality: "Best" } });
    expect(itemMismatches("w", echo, bad, []).map((x) => x.path).sort()).toEqual(
      ["w.num_output_modules", "w.render_settings.Quality", "w.skip_frames", "w.time_span.start"].sort()
    );
    expect(itemMismatches("w", echo, undefined, []).length).toBe(1);
    expect(itemMismatches("w", undefined, good, [])).toEqual([]);
    const otherFile = item(1, { time_span_start: 1, time_span_duration: 4, skip_frames: 2, render_settings: { Quality: "Draft" }, output_modules: [{ index: 1, file: "C:\\out\\b.mp4", post_render_action: "none" }] });
    expect(itemMismatches("w", echo, otherFile, []).map((x) => x.path)).toContain("w.output_modules[1].file");
  });

  it("step errors and skipped keys become mismatches", () => {
    const m = stepMismatches("w", [{ step: "file", message: "boom" }], [{ key: "Audio Sample Rate", reason: "not offered" }]);
    expect(m.map((x) => x.path)).toEqual(["w.errors[0]", "w.skipped[0]"]);
    // A skipped key is not also reported as a differing value.
    const echo: PlanEcho = { num_output_modules: 1, modules: [{ index: 1, settings: { "Audio Sample Rate": 48000 } }] };
    expect(itemMismatches("w", echo, item(1), [{ key: "Audio Sample Rate" }])).toEqual([]);
  });

  it("copiesMismatches checks the queue growth, the comp and that no two items share a file", () => {
    const entries = [{ item_index: 2, expect: { num_output_modules: 1, modules: [] } }];
    const before = queueOfItems(item(1));
    const ok = queueOfItems(item(1), item(2, { output_modules: [{ index: 1, file: "C:\\out\\b.mp4" }] }));
    expect(copiesMismatches("copy", before, ok, entries, 5)).toEqual([]);
    expect(copiesMismatches("copy", before, queueOfItems(item(1)), entries, 5).map((x) => x.path)).toContain("numItems");
    const other = queueOfItems(item(1), item(2, { comp_id: 9, output_modules: [{ index: 1, file: "C:\\out\\b.mp4" }] }));
    expect(copiesMismatches("copy", before, other, entries, 5).map((x) => x.path)).toContain("copy[1].comp_id");
    const same = queueOfItems(item(1), item(2));
    expect(copiesMismatches("copy", before, same, entries, 5).some((x) => /write the same file/.test(x.message))).toBe(true);
    expect(copiesMismatches("copy", before, ok, [{ item_index: null }], 5).some((x) => /could not be duplicated/.test(x.message))).toBe(true);
    // A copy on a path an item outside the copies uses is caught; a DONE item's path is free.
    const clash = queueOfItems(item(1), item(2, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }));
    expect(copiesMismatches("copy", before, clash, entries, 5).some((x) => /write the same file/.test(x.message))).toBe(true);
    const doneFirst = queueOfItems(item(1, { status: "done" }), item(2, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }));
    expect(copiesMismatches("copy", before, doneFirst, entries, 5).some((x) => /write the same file/.test(x.message))).toBe(false);
    // Two untouched items sharing a path are not this call's doing; a correct copy elsewhere gives no mismatch.
    const pre = queueOfItems(item(1, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }), item(2, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }));
    const post = queueOfItems(item(1, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }), item(2, { output_modules: [{ index: 1, file: "C:\\out\\a.mp4" }] }), item(3, { output_modules: [{ index: 1, file: "C:\\out\\c.mp4" }] }));
    expect(copiesMismatches("copy", pre, post, [{ item_index: 3, expect: { num_output_modules: 1, modules: [] } }], 5).some((x) => /write the same file/.test(x.message))).toBe(false);
    // An in-place spec result is the item itself and does not count as a copy.
    expect(copiesMismatches("spec", before, queueOfItems(item(1)), [{ item_index: 1, in_place: true }], 5)).toEqual([]);
  });

  it("checkDeliveryFile looks at existence, size, extension and the size limit", () => {
    const dir = tmp();
    const file = path.join(dir, "reel.mp4");
    fs.writeFileSync(file, Buffer.alloc(2048));
    const tiktok = specById("tiktok")!;
    expect(checkDeliveryFile(tiktok, file)).toMatchObject({ ok: true, exists: true, size_bytes: 2048, issues: [] });
    expect(checkDeliveryFile(tiktok, path.join(dir, "missing.mp4"))).toMatchObject({ ok: false, exists: false });
    const wrong = path.join(dir, "reel.mov");
    fs.writeFileSync(wrong, "x");
    expect(checkDeliveryFile(tiktok, wrong).issues.join()).toMatch(/extension/);
    const empty = path.join(dir, "empty.mp4");
    fs.writeFileSync(empty, "");
    expect(checkDeliveryFile(tiktok, empty).issues.join()).toMatch(/empty/);
    expect(checkDeliveryFile({ ...tiktok, max_size_mb: 0.001 }, file).issues.join()).toMatch(/limit/);
  });

  it("ae_check_delivery_file reports against the spec", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.mp4");
    fs.writeFileSync(file, "abc");
    const out: any = await tool("ae_check_delivery_file").handler({ spec_id: "tiktok", file_path: file }, {} as ToolContext);
    expect(out).toMatchObject({ spec_id: "tiktok", ok: true, size_bytes: 3, max_size_mb: 500 });
  });
});

// ---------- the guarded write through a fake bridge ----------

describe("rqedit tools through a fake bridge", () => {
  const editArgs = () =>
    AeRenderQueueEditSchema.parse({ item_index: 1, comp_id: 5, skip_frames: 2, output_modules: [{ index: 1, file: "C:/out/a.mp4" }], expect: expectArg });
  const echo: PlanEcho = { skip_frames: 2, num_output_modules: 1, modules: [{ index: 1, file: "C:/out/a.mp4" }] };

  it("ae_render_queue_edit guards, reads, writes and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      rqeditRead: [queueOfItems(item(1, { skip_frames: 0 })), queueOfItems(item(1, { skip_frames: 2 }))],
      rqeditEdit: [{ item_index: 1, comp_id: 5, steps_done: ["x"], skipped: [], errors: [], warnings: [], added_modules: [], removed_modules: [], expect: echo }],
    });
    const out: any = await tool("ae_render_queue_edit").handler(editArgs(), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "rqeditRead", "rqeditEdit", "rqeditRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(calls[2].script).toContain('"item_comp_id":5');
    expect(out.applied).toBe(true);
    expect(out.steps_done).toEqual(["x"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.item).toMatchObject({ index: 1, skip_frames: 2 });
  });

  it("ae_render_queue_edit puts a differing read-back and failed steps in the receipt", async () => {
    const { ctx } = fakeAe({
      rqeditRead: [queueOfItems(item(1)), queueOfItems(item(1, { skip_frames: 0 }))],
      rqeditEdit: [{ item_index: 1, comp_id: 5, steps_done: [], skipped: [{ key: "Resize", reason: "not offered" }], errors: [{ step: "file", message: "boom" }], expect: echo }],
    });
    const out: any = await tool("ae_render_queue_edit").handler(editArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths).toContain("item[1].errors[0]");
    expect(paths).toContain("item[1].skipped[0]");
    expect(paths).toContain("item[1].skip_frames");
  });

  it("ae_render_queue_edit does not throw when the read-back fails after the write", async () => {
    const { ctx } = fakeAe({
      rqeditRead: [
        queueOfItems(item(1)),
        () => {
          throw new Error("AE is busy");
        },
      ],
      rqeditEdit: [{ item_index: 1, comp_id: 5, steps_done: [], skipped: [], errors: [], expect: echo }],
    });
    const out: any = await tool("ae_render_queue_edit").handler(editArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toMatch(/Do not resend/);
  });

  it("editMismatches notices another comp at the index", () => {
    const m = editMismatches(editArgs(), null, queueOfItems(item(1, { comp_id: 9, skip_frames: 2, output_modules: [{ index: 1, file: "C:/out/a.mp4" }] })), { expect: echo });
    expect(m.map((x) => x.path)).toEqual(["item[1].comp_id"]);
  });

  it("ae_render_queue_duplicate reads the queue before and the copies after", async () => {
    const { ctx, calls } = fakeAe({
      rqeditRead: [queueOfItems(item(1)), queueOfItems(item(1), item(2, { output_modules: [{ index: 1, file: "C:\\out\\a_copy1.mp4" }] }))],
      rqeditDuplicate: [
        {
          source_index: 1,
          comp_id: 5,
          errors: [],
          copies: [{ copy: 1, item_index: 2, applied: [], skipped: [], errors: [], expect: { num_output_modules: 1, modules: [{ index: 1, file: "C:/out/a_copy1.mp4" }] } }],
        },
      ],
    });
    const args = AeRenderQueueDuplicateSchema.parse({ item_index: 1, count: 1, expect: expectArg });
    const out: any = await tool("ae_render_queue_duplicate").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "rqeditRead", "rqeditDuplicate", "rqeditRead"]);
    expect(calls[3].script).toContain('"settings_indexes":[2]');
    expect(calls[2].script).toContain('"copies":[{}]');
    expect(out.receipt.matches).toBe(true);
    expect(out.copies[0].item.index).toBe(2);
  });

  it("ae_render_queue_apply_spec sends the library entries and checks the made items", async () => {
    const { ctx, calls } = fakeAe({
      rqeditRead: [queueOfItems(item(1)), queueOfItems(item(1), item(2, { output_modules: [{ index: 1, file: "C:\out\b.mp4" }] }))],
      rqeditApplySpec: [
        {
          source_index: 1,
          comp_id: 5,
          in_place: true,
          results: [
            { spec_id: "youtube_1080p", item_index: 1, in_place: true, errors: [], skipped: [], expect: { num_output_modules: 1, modules: [] } },
            { spec_id: "tiktok", item_index: 2, in_place: false, errors: [], skipped: [], expect: { num_output_modules: 1, modules: [] } },
          ],
        },
      ],
    });
    const args = AeApplySpecSchema.parse({ item_index: 1, specs: ["youtube_1080p", "tiktok"], output_folder: "C:/out", expect: expectArg });
    const out: any = await tool("ae_render_queue_apply_spec").handler(args, ctx);
    expect(calls[2].script).toContain('"id":"youtube_1080p"');
    expect(calls[2].script).toContain('"id":"tiktok"');
    expect(calls[3].script).toContain('"settings_indexes":[1,2]');
    expect(out.receipt.matches).toBe(true);
    expect(out.results).toHaveLength(2);
    // A copy that was not made is a mismatch, not an exception.
    const second = fakeAe({
      rqeditRead: [queueOfItems(item(1)), queueOfItems(item(1))],
      rqeditApplySpec: [{ source_index: 1, comp_id: 5, in_place: false, results: [{ spec_id: "tiktok", item_index: 2, in_place: false, errors: [{ step: "x", message: "y" }], skipped: [] }] }],
    });
    const bad: any = await tool("ae_render_queue_apply_spec").handler(AeApplySpecSchema.parse({ item_index: 1, specs: ["tiktok"], output_folder: "C:/out", expect: expectArg }), second.ctx);
    expect(bad.receipt.matches).toBe(false);
  });

  it("ae_delivery_specs merges the host's verdict into the library", async () => {
    const { ctx, calls } = fakeAe({
      rqeditSpecs: [
        {
          templates_known: true,
          templates_from: "queue item 1",
          output_module_templates: OM_TEMPLATES,
          comp: { id: 5, name: "Main", width: 1920, height: 1080 },
          specs: [
            { id: "tiktok", feasible: false, refusal: "stretch", template: "H.264", warnings: [] },
            { id: "gif", feasible: false, refusal: "no GIF", template: null, warnings: [] },
          ],
        },
      ],
    });
    const out: any = await tool("ae_delivery_specs").handler(AeDeliverySpecsSchema.parse({ ids: ["tiktok", "gif"] }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["rqeditSpecs"]);
    expect(JSON.parse(calls[0].script.slice(calls[0].script.indexOf("(") + 1, -1)).specs).toHaveLength(2);
    expect(out.specs.map((s: any) => [s.id, s.feasible, s.resize?.height ?? null])).toEqual([
      ["tiktok", false, 1920],
      ["gif", false, null],
    ]);
  });

  it("ae_render_queue_inspect shows settings for one item and not for the list", async () => {
    const { ctx, calls } = fakeAe({ rqeditRead: [queueOfItems(item(1)), queueOfItems(item(1))] });
    await tool("ae_render_queue_inspect").handler(AeRenderQueueInspectSchema.parse({ item_index: 1 }), ctx);
    await tool("ae_render_queue_inspect").handler(AeRenderQueueInspectSchema.parse({}), ctx);
    expect(calls[0].script).toContain('"settings":true');
    expect(calls[0].script).toContain('"item_indexes":[1]');
    expect(calls[1].script).toContain('"settings":false');
  });
});

// ---------- the host functions under node:vm ----------

describe("rqedit.jsx: reading", () => {
  it("lists items with span, modules, settings and templates, and changes nothing", () => {
    const { A, undo, rq } = scene();
    rq.item(1).mods[0].file = new FakeFile("C:\\out\\a.mp4");
    const r = plainOf(A.rqeditRead({ settings: true, include_templates: true }));
    expect(undo.begun).toBe(0);
    expect(r.numItems).toBe(1);
    const it = r.items[0];
    expect(it).toMatchObject({ index: 1, comp_name: "Main Film", comp_width: 1920, status: "queued", time_span_start: 0, time_span_duration: 10, skip_frames: 0, log_type: "errors_only", num_output_modules: 1 });
    expect(it.render_settings.Quality).toBe("Best");
    expect(it.render_settings_templates).toBeUndefined();
    expect(r.render_settings_templates).toEqual(RS_TEMPLATES);
    expect(r.output_module_templates).toEqual(OM_TEMPLATES);
    expect(it.output_modules[0]).toMatchObject({ index: 1, file: "C:\\out\\a.mp4", post_render_action: "none", include_source_xmp: false });
    expect(it.output_modules[0].settings.Format).toBe("AVI");
    expect(it.output_modules[0].templates).toBeUndefined();
    expect(() => A.rqeditRead({ item_indexes: [3] })).toThrow(/No render queue item 3/);
  });

  it("reports a missing settings dump instead of failing", () => {
    const { A, G } = scene();
    delete (G as any).GetSettingsFormat;
    const r = plainOf(A.rqeditRead({ settings: true }));
    expect(r.items[0].render_settings).toBeNull();
    expect(r.items[0].render_settings_error).toMatch(/not available/);
  });
});

describe("rqedit.jsx: ae_render_queue_edit", () => {
  const full = (item: any) => ({
    item_index: 1,
    item_comp_id: item.comp.id,
    time_span: { start: 1, duration: 4 },
    skip_frames: 2,
    log_type: "errors_and_settings",
    render_settings: { Quality: "Draft", "Frame Rate": 30 },
    modules: [
      {
        index: 1,
        template: "H.264 - Match Render Settings - 15 Mbps",
        settings: { Channels: "RGB", Resize: true, "Resize to": [1280, 720] },
        file: "C:/out/a.mp4",
        post_render_action: "import",
        include_source_xmp: true,
      },
    ],
    add_modules: [{ template: "Apple ProRes 422 HQ", file: "C:/out/a.mov" }],
    expect: GUARD,
  });

  it("changes the item and its modules in one undo group, and the read-back matches the plan", () => {
    const { A, undo, item } = scene();
    const out = plainOf(A.rqeditEdit(full(item)));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(out.errors).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.added_modules).toEqual([2]);
    expect(item.timeSpanStart).toBe(1);
    expect(item.timeSpanDuration).toBe(4);
    expect(item.skipFrames).toBe(2);
    expect(item.logType).toBe(LOG.ERRORS_AND_SETTINGS);
    expect(item.settings).toMatchObject({ Quality: "Draft", "Frame Rate": "30" });
    const om = item.outputModule(1);
    expect(om.templatesApplied).toEqual(["H.264 - Match Render Settings - 15 Mbps"]);
    expect(om.settings).toMatchObject({ Format: "H.264", Resize: true, "Resize to": [1280, 720] });
    expect(om.file.fsName).toBe("C:/out/a.mp4");
    expect(om.postRenderAction).toBe(POST.IMPORT);
    expect(om.includeSourceXMP).toBe(true);
    expect(item.outputModule(2).settings.Format).toBe("QuickTime");
    expect(item.outputModule(2).file.fsName).toBe("C:/out/a.mov");
    // The host's own echo agrees with a separate read.
    const after = read(A, 1);
    expect(itemMismatches("item", out.expect, after.items[0], out.skipped)).toEqual([]);
    expect(out.expect.num_output_modules).toBe(2);
  });

  it("takes the work area or the whole comp as the span", () => {
    const { A, item, comp } = scene();
    comp.workAreaStart = 2;
    comp.workAreaDuration = 3;
    A.rqeditEdit({ item_index: 1, time_span: "work_area", expect: GUARD });
    expect([item.timeSpanStart, item.timeSpanDuration]).toEqual([2, 3]);
    A.rqeditEdit({ item_index: 1, time_span: "comp", expect: GUARD });
    expect([item.timeSpanStart, item.timeSpanDuration]).toEqual([0, 10]);
  });

  it("mirrors the type of the dump's values: On/Off text and 'W x H' text", () => {
    const { A, item } = scene({ shape: "text" });
    item.outputModule(1).settings.Resize = "Off";
    A.rqeditEdit({ item_index: 1, modules: [{ index: 1, settings: { Resize: true, "Resize to": [1280, 720] } }], expect: GUARD });
    expect(item.outputModule(1).settings).toMatchObject({ Resize: "On", "Resize to": "1280 x 720" });
    const out = plainOf(A.rqeditEdit({ item_index: 1, modules: [{ index: 1, settings: { Resize: false } }], expect: GUARD }));
    expect(item.outputModule(1).settings.Resize).toBe("Off");
    expect(itemMismatches("i", out.expect, read(A, 1).items[0], [])).toEqual([]);
  });

  it("removes output modules, highest first, and keeps one", () => {
    const { A, item } = scene();
    A.rqeditEdit({ item_index: 1, add_modules: [{}, {}], expect: GUARD });
    expect(item.numOutputModules).toBe(3);
    item.outputModule(2).name = "two";
    item.outputModule(3).name = "three";
    A.rqeditEdit({ item_index: 1, remove_modules: [1, 3], expect: GUARD });
    expect(item.mods.map((m: any) => m.name)).toEqual(["two"]);
    expect(() => A.rqeditEdit({ item_index: 1, remove_modules: [1], expect: GUARD })).toThrow(/no output module/);
  });

  it("refuses before touching AE: unknown keys, Format, templates, span, files, rendering, wrong comp", () => {
    const { A, undo, item, rq, comp, project } = scene();
    const other = project.addComp("Other", 640, 360, 5);
    const second = rq.add(other);
    second.outputModule(1).file = new FakeFile("C:/out/taken.mp4");
    const dir = tmp();
    const existing = path.join(dir, "exists.mp4");
    fs.writeFileSync(existing, "x");
    const refused: Array<[any, RegExp]> = [
      [{ render_settings: { Nope: 1 } }, /does not offer the setting\(s\) Nope/],
      [{ modules: [{ index: 1, settings: { "Audio Sample Rate": 44100 } }] }, /not offer the setting\(s\) Audio Sample Rate/],
      [{ modules: [{ index: 1, settings: { Format: "H.264" } }] }, /read-only/],
      [{ modules: [{ index: 1, template: "No Such Template" }] }, /no output module template named "No Such Template"/],
      [{ item_template: "Nope" }, /no render settings template/],
      [{ time_span: { start: 8, duration: 5 } }, /past the comp's end/],
      [{ time_span: { start: 0, duration: 0 } }, /duration > 0/],
      [{ skip_frames: 100 }, /0 to 99/],
      [{ log_type: "chatty" }, /log_type/],
      [{ modules: [{ index: 3, file: "C:/out/x.mp4" }] }, /has 1 output module/],
      [{ modules: [{ index: 1, file: "out/relative.mp4" }] }, /absolute path/],
      [{ modules: [{ index: 1, file: "C:/OUT/taken.mp4" }] }, /already the output of queue item 2/],
      [{ modules: [{ index: 1, file: existing }] }, /already exists on disk/],
      [{ modules: [{ index: 1, post_render_action: "explode" }] }, /post_render_action/],
      [{ modules: [{ index: 1, file: "C:/out/x.mp4" }, { index: 1, template: "Lossless" }] }, /listed twice/],
      [{ add_modules: [{ file: "C:/out/y.mp4" }, { file: "C:/out/y.mp4" }] }, /already the output of/],
      [{ add_modules: [{}], remove_modules: [3] }, /cannot remove output module 3/],
      [{ modules: [{ index: 1, template: "Lossless" }], add_modules: [{}], remove_modules: [1] }, /both edited and removed/],
      [{ item_comp_id: comp.id + 999, skip_frames: 1 }, /not [0-9]+\. The queue changed/],
      [{ item_index: 9, skip_frames: 1 }, /No render queue item 9/],
    ];
    for (const [extra, re] of refused) {
      expect(() => A.rqeditEdit({ item_index: 1, expect: GUARD, ...extra }), JSON.stringify(extra)).toThrow(re);
    }
    expect(undo.begun).toBe(0);
    expect(item.skipFrames).toBe(0);
    expect(item.mods).toHaveLength(1);
    // The existing file passes with allow_overwrite.
    A.rqeditEdit({ item_index: 1, modules: [{ index: 1, file: existing }], allow_overwrite: true, expect: GUARD });
    expect(item.outputModule(1).file.fsName).toBe(existing);
    rq.rendering = true;
    expect(() => A.rqeditEdit({ item_index: 1, skip_frames: 1, expect: GUARD })).toThrow(/is rendering/);
    rq.rendering = false;
    item.status = STATUS.RENDERING;
    expect(() => A.rqeditEdit({ item_index: 1, skip_frames: 1, expect: GUARD })).toThrow(/item 1 is rendering/);
    expect(() => A.rqeditEdit({ item_index: 1, skip_frames: 1, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
  });

  it("a finished item's old path is not a collision, and an item's own path can be set again", () => {
    const { A, item, rq, project } = scene();
    const done = rq.add(project.addComp("Done", 640, 360, 5));
    done.status = STATUS.DONE;
    done.outputModule(1).file = new FakeFile("C:/out/old.mp4");
    A.rqeditEdit({ item_index: 1, modules: [{ index: 1, file: "C:/out/old.mp4" }], expect: GUARD });
    expect(item.outputModule(1).file.fsName).toBe("C:/out/old.mp4");
    A.rqeditEdit({ item_index: 1, modules: [{ index: 1, file: "C:/out/old.mp4", post_render_action: "none" }], expect: GUARD });
  });

  it("after a template, keys the new format doesn't offer are skipped and reported, not thrown", () => {
    const { A, item, undo } = scene();
    const out = plainOf(
      A.rqeditEdit({ item_index: 1, modules: [{ index: 1, template: "PNG Sequence", settings: { "Audio Sample Rate": 48000, Channels: "RGB + Alpha" } }], expect: GUARD })
    );
    expect(undo.begun).toBe(1);
    expect(item.outputModule(1).settings.Format).toBe("PNG Sequence");
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].key).toBe("Audio Sample Rate");
    expect(out.errors).toEqual([]);
    const mism = itemMismatches("i", out.expect, read(A, 1).items[0], out.skipped);
    expect(mism).toEqual([]);
    expect(stepMismatches("i", out.errors, out.skipped)).toHaveLength(1);
  });

  it("a step AE rejects goes in errors and the remaining steps still run", () => {
    const { A, item } = scene();
    item.setSettings = () => {
      throw new Error("AE said no");
    };
    const out = plainOf(A.rqeditEdit({ item_index: 1, render_settings: { Quality: "Draft" }, skip_frames: 3, expect: GUARD }));
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].message).toBe("AE said no");
    expect(item.skipFrames).toBe(3);
  });

  it("fetches the output module again for every step", () => {
    const { A, item } = scene();
    const first = item.outputModule(1);
    let fetched = 0;
    const real = item.outputModule.bind(item);
    item.outputModule = (i: number) => {
      fetched++;
      return real(i);
    };
    A.rqeditEdit({ item_index: 1, modules: [{ index: 1, settings: { Channels: "RGB", Resize: true }, file: "C:/out/z.mp4", post_render_action: "none" }], expect: GUARD });
    // Once for validation, then per settings key and per property.
    expect(fetched).toBeGreaterThanOrEqual(6);
    expect(first.settings.Resize).toBe(true);
  });
});

describe("rqedit.jsx: ae_render_queue_duplicate", () => {
  it("makes copies with their own templates and paths and leaves the source alone", () => {
    const { A, rq, item, undo } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/film.mp4");
    const out = plainOf(
      A.rqeditDuplicate({
        item_index: 1,
        item_comp_id: item.comp.id,
        copies: [
          { output_module_template: "Apple ProRes 422 HQ", file: "C:/out/film_prores.mov" },
          { output_module_template: "PNG Sequence", file: "C:/out/film_[#####].png", settings: { Channels: "RGB" } },
          {},
        ],
        expect: GUARD,
      })
    );
    expect(undo.begun).toBe(1);
    expect(rq.numItems).toBe(4);
    expect(out.errors).toEqual([]);
    expect(out.copies.map((c: any) => c.item_index)).toEqual([2, 3, 4]);
    expect(rq.item(2).outputModule(1).settings.Format).toBe("QuickTime");
    expect(rq.item(3).outputModule(1).settings.Format).toBe("PNG Sequence");
    expect(rq.item(3).outputModule(1).settings.Channels).toBe("RGB");
    expect(rq.item(2).outputModule(1).file.fsName).toBe("C:/out/film_prores.mov");
    expect(rq.item(3).outputModule(1).file.fsName).toBe("C:/out/film_[#####].png");
    expect(rq.item(4).outputModule(1).file.fsName).toBe("C:/out/film_copy3.mp4");
    expect(item.outputModule(1).file.fsName).toBe("C:/out/film.mp4");
    expect(item.outputModule(1).settings.Format).toBe("AVI");
    const after = read(A, 2, 3, 4);
    const entries = out.copies;
    const q = { numItems: 4, items: after.items };
    expect(copiesMismatches("copy", { numItems: 1, items: [] }, q, entries, item.comp.id)).toEqual([]);
  });

  it("derives a path before the frame number of a sequence, per module", () => {
    const { A, rq, item } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/seq_[#####].png");
    item.addModule().file = new FakeFile("C:/out/audio.wav");
    A.rqeditDuplicate({ item_index: 1, copies: [{}], expect: GUARD });
    expect(rq.item(2).outputModule(1).file.fsName).toBe("C:/out/seq_copy1_[#####].png");
    expect(rq.item(2).outputModule(2).file.fsName).toBe("C:/out/audio_copy1.wav");
  });

  it("finds the copy where AE put it, and keeps following the source", () => {
    const { A, rq, item, project } = scene({ duplicateAfterSource: true });
    item.outputModule(1).file = new FakeFile("C:/out/one.mp4");
    const later = rq.add(project.addComp("Later", 640, 360, 5));
    later.outputModule(1).file = new FakeFile("C:/out/later.mp4");
    const out = plainOf(A.rqeditDuplicate({ item_index: 1, copies: [{ file: "C:/out/c1.mp4" }, { file: "C:/out/c2.mp4" }], expect: GUARD }));
    // Copies land after the source, so the second goes in front of the first.
    // c1 was at 2 when made; c2 then went in front of it, so c1 reads 3.
    expect(out.copies.map((c: any) => c.item_index)).toEqual([3, 2]);
    expect(rq.item(2).outputModule(1).file.fsName).toBe("C:/out/c2.mp4");
    expect(rq.item(3).outputModule(1).file.fsName).toBe("C:/out/c1.mp4");
    expect(rq.item(4).comp.name).toBe("Later");
    expect(copiesMismatches("copy", { numItems: 2, items: [] }, read(A, 2, 3), out.copies, out.comp_id)).toEqual([]);
  });

  it("refuses a copy that would reuse a path, or that is out of range, before duplicating", () => {
    const { A, rq, item, undo } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/film.mp4");
    const bad: Array<[any, RegExp]> = [
      [{ copies: [{ file: "C:/out/film.mp4" }] }, /already the output of/],
      [{ copies: [{ file: "C:/out/x.mp4" }, { file: "C:/out/x.mp4" }] }, /already the output of/],
      [{ copies: [{ output_module_template: "Nope", file: "C:/out/n.mp4" }] }, /no output module template/],
      [{ copies: [{ output_module_template: "PNG Sequence" }] }, /give a file together with output_module_template/],
      [{ copies: [{ settings: { Bogus: 1 } }] }, /not offer the setting/],
      [{ copies: [] }, /1 to 20/],
      [{ item_index: 4, copies: [{}] }, /No render queue item 4/],
    ];
    for (const [extra, re] of bad) {
      expect(() => A.rqeditDuplicate({ item_index: 1, expect: GUARD, ...extra }), JSON.stringify(extra)).toThrow(re);
    }
    expect(undo.begun).toBe(0);
    expect(rq.numItems).toBe(1);
  });

  it("a duplicate that throws is reported and the others still go", () => {
    const { A, rq, item } = scene();
    const real = item.duplicate.bind(item);
    let n = 0;
    item.duplicate = () => {
      n++;
      if (n === 1) throw new Error("cannot duplicate");
      return real();
    };
    const out = plainOf(A.rqeditDuplicate({ item_index: 1, copies: [{}, {}], expect: GUARD }));
    expect(out.errors).toHaveLength(1);
    expect(out.copies[0].item_index).toBeNull();
    expect(rq.numItems).toBe(2);
    const m = copiesMismatches("copy", { numItems: 1, items: [] }, read(A), out.copies, item.comp.id);
    expect(m.some((x) => /could not be duplicated/.test(x.message))).toBe(true);
  });
});

describe("rqedit.jsx: delivery specs", () => {
  const libs = (...ids: string[]) => ids.map((id) => specById(id)!);
  const apply = (A: any, extra: Record<string, unknown>) =>
    plainOf(A.rqeditApplySpec({ item_index: 1, output_folder: "C:/deliver", expect: GUARD, ...extra }));

  it("lists what this AE can meet, with the template each would use", () => {
    const { A, undo } = scene();
    const r = plainOf(A.rqeditSpecs({ specs: SPEC_LIBRARY, item_index: 1 }));
    expect(undo.begun).toBe(0);
    expect(r.templates_known).toBe(true);
    const by = (id: string) => r.specs.find((s: any) => s.id === id);
    expect(by("youtube_1080p")).toMatchObject({ feasible: true, template: "H.264 - Match Render Settings - 15 Mbps", template_is_preferred: true });
    expect(by("youtube_4k")).toMatchObject({ feasible: true, template: "H.264 - Match Render Settings - 40 Mbps" });
    expect(by("broadcast_hd")).toMatchObject({ feasible: true, template: "Apple ProRes 422 HQ" });
    expect(by("png_sequence")).toMatchObject({ feasible: true, template: "PNG Sequence" });
    expect(by("wav_audio").feasible).toBe(false);
    expect(by("wav_audio").refusal).toMatch(/No installed output module template/);
    expect(by("gif").refusal).toMatch(/no animated GIF/);
    expect(by("tiktok").feasible).toBe(false);
    expect(by("tiktok").refusal).toMatch(/stretch/);
  });

  it("says the templates are unknown when the queue is empty", () => {
    const { A, rq } = scene();
    rq.list.length = 0;
    const r = plainOf(A.rqeditSpecs({ specs: libs("youtube_1080p") }));
    expect(r.templates_known).toBe(false);
    expect(r.specs[0].feasible).toBe(true);
    expect(r.specs[0].warnings[0]).toMatch(/not checked/);
  });

  it("applies a spec in place: template, no resize at the comp's size, audio, file from the name template", () => {
    const { A, item, undo } = scene();
    const out = apply(A, { specs: libs("youtube_1080p") });
    expect(undo.begun).toBe(1);
    expect(out.in_place).toBe(true);
    expect(out.results[0]).toMatchObject({ spec_id: "youtube_1080p", item_index: 1, in_place: true, errors: [], skipped: [] });
    const om = item.outputModule(1);
    expect(om.templatesApplied).toEqual(["H.264 - Match Render Settings - 15 Mbps"]);
    expect(om.settings).toMatchObject({ Format: "H.264", Channels: "RGB", Resize: false, "Audio Sample Rate": 48000 });
    expect(om.file.fsName).toBe("C:/deliver/Main Film_youtube_1080p.mp4");
    expect(itemMismatches("s", out.results[0].expect, read(A, 1).items[0], [])).toEqual([]);
  });

  it("resizes with Resize and Resize to when the comp is another size (array or text values)", () => {
    for (const shape of ["array", "text"] as const) {
      const { A, item } = scene({ shape, width: 1920, height: 1080 });
      const out = apply(A, { specs: libs("youtube_4k") });
      const s = item.outputModule(1).settings;
      expect(s.Resize).toBe(true);
      expect(s["Resize to"]).toEqual(shape === "array" ? [3840, 2160] : "3840 x 2160");
      expect(itemMismatches("s", out.results[0].expect, read(A, 1).items[0], out.results[0].skipped)).toEqual([]);
      expect(out.results[0].warnings.join()).toMatch(/smaller than 3840x2160/);
    }
  });

  it("makes duplicates for the other specs, each with its own template, size and file", () => {
    const { A, rq } = scene({ width: 1080, height: 1920 });
    const out = apply(A, { specs: libs("tiktok", "instagram_reels_story", "png_sequence", "broadcast_hd"), allow_stretch: true });
    expect(rq.numItems).toBe(4);
    expect(out.results.map((r: any) => [r.spec_id, r.item_index, r.in_place])).toEqual([
      ["tiktok", 1, true],
      ["instagram_reels_story", 2, false],
      ["png_sequence", 3, false],
      ["broadcast_hd", 4, false],
    ]);
    expect(rq.item(3).outputModule(1).file.fsName).toBe("C:/deliver/Main Film_png_sequence_[#####].png");
    expect(rq.item(3).outputModule(1).settings).toMatchObject({ Format: "PNG Sequence", Channels: "RGB + Alpha" });
    expect(rq.item(4).outputModule(1).settings.Format).toBe("QuickTime");
    expect(rq.item(4).outputModule(1).file.fsName).toBe("C:/deliver/Main Film_broadcast_hd.mov");
    const files = rq.list.map((i: any) => i.outputModule(1).file.fsName);
    expect(new Set(files).size).toBe(4);
    const q = read(A, 1, 2, 3, 4);
    const m = copiesMismatches("spec", { numItems: 1, items: [] }, q, out.results, out.comp_id);
    expect(m).toEqual([]);
  });

  it("with in_place false leaves the item as it is and puts every spec on a duplicate", () => {
    const { A, rq, item } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/mine.mp4");
    const out = apply(A, { specs: libs("youtube_1080p", "linkedin_1080p"), in_place: false });
    expect(out.results.map((r: any) => r.item_index)).toEqual([2, 3]);
    expect(rq.item(1).outputModule(1).file.fsName).toBe("C:/out/mine.mp4");
    expect(rq.item(1).outputModule(1).settings.Format).toBe("AVI");
    expect(rq.item(2).outputModule(1).settings.Format).toBe("H.264");
  });

  it("follows the source when AE puts copies right after it", () => {
    const { A, rq, item, project } = scene({ duplicateAfterSource: true });
    rq.add(project.addComp("Later", 1920, 1080, 5)).outputModule(1).file = new FakeFile("C:/out/later.mp4");
    const out = apply(A, { specs: libs("youtube_1080p", "linkedin_1080p", "broadcast_hd") });
    expect(out.results.map((r: any) => r.item_index)).toEqual([1, 3, 2]);
    expect(copiesMismatches("spec", { numItems: 2, items: [] }, read(A, 1, 2, 3), out.results, out.comp_id)).toEqual([]);
    expect(item.outputModule(1).settings.Format).toBe("H.264");
    expect(rq.item(2).outputModule(1).file.fsName).toBe("C:/deliver/Main Film_broadcast_hd.mov");
    expect(rq.item(3).outputModule(1).file.fsName).toBe("C:/deliver/Main Film_linkedin_1080p.mp4");
    expect(rq.item(4).comp.name).toBe("Later");
  });

  it("expands the name template, adds the extension, and keeps AE's frame token", () => {
    const { A, item } = scene();
    apply(A, { specs: libs("youtube_1080p"), file_name: "[compName]-[width]x[height]-[copy]" });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/Main Film-1920x1080-1.mp4");
    apply(A, { specs: libs("png_sequence"), file_name: "frames", output_folder: "C:/deliver/" });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/frames_[#####].png");
    apply(A, { specs: libs("youtube_1080p"), file_name: "[date]_[spec].mp4" });
    expect(item.outputModule(1).file.fsName).toMatch(/^C:\/deliver\/\d{8}_youtube_1080p\.mp4$/);
    // A comp name with slashes can't break the path.
    item.comp.name = "A/B:C";
    apply(A, { specs: libs("youtube_1080p") });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/A_B_C_youtube_1080p.mp4");
  });

  it("the spec's container decides the extension, and Resize is written off for a spec without a size", () => {
    const { A, item } = scene();
    const out = apply(A, { specs: libs("prores_422_hq_master"), file_name: "[compName]_[spec].mp4" });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/Main Film_prores_422_hq_master.mov");
    expect(out.results[0].expect.modules[0].settings.Resize).toBe(false);
    const png = apply(A, { specs: libs("png_sequence"), file_name: "[compName]_[spec].mp4" });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/Main Film_png_sequence_[#####].png");
    expect(png.results[0].expect.modules[0].settings.Resize).toBe(false);
    // An audio-only spec has no picture to resize.
    item.outputModule(1).templates = [...OM_TEMPLATES, "WAV"];
    expect(apply(A, { specs: libs("wav_audio") }).results[0].expect.modules[0].settings.Resize).toBeUndefined();
    // A name with a dot that isn't a media extension keeps it.
    apply(A, { specs: libs("youtube_1080p"), file_name: "v2.final" });
    expect(item.outputModule(1).file.fsName).toBe("C:/deliver/v2.final.mp4");
  });

  it("refuses with a reason and changes nothing", () => {
    const { A, rq, item, undo } = scene();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "Main Film_youtube_1080p.mp4"), "x");
    const bad: Array<[any, RegExp]> = [
      [{ specs: libs("gif") }, /no animated GIF/],
      [{ specs: libs("wav_audio") }, /No installed output module template fits WAV audio only/],
      [{ specs: libs("tiktok") }, /would stretch the picture/],
      [{ specs: libs("youtube_1080p", "youtube_1080p") }, /listed twice/],
      [{ specs: libs("youtube_1080p"), output_folder: dir }, /already exists on disk/],
      [{ specs: libs("youtube_1080p"), output_folder: "relative/dir" }, /absolute path/],
      [{ specs: [] }, /1 to 20/],
      [{ specs: libs("youtube_1080p", "wav_audio") }, /WAV audio only/],
    ];
    for (const [extra, re] of bad) {
      expect(() => A.rqeditApplySpec({ item_index: 1, output_folder: "C:/deliver", expect: GUARD, ...extra }), JSON.stringify(extra.specs?.map((s: any) => s.id))).toThrow(re);
    }
    expect(undo.begun).toBe(0);
    expect(rq.numItems).toBe(1);
    expect(item.outputModule(1).settings.Format).toBe("AVI");
    // Two modules: the spec needs exactly one.
    item.addModule();
    expect(() => A.rqeditApplySpec({ item_index: 1, specs: libs("youtube_1080p"), output_folder: "C:/deliver", expect: GUARD })).toThrow(/exactly one/);
  });

  it("allows overwriting an existing file when told to, and a stretch when told to", () => {
    const { A, item } = scene();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "Main Film_tiktok.mp4"), "x");
    const out = apply(A, { specs: libs("tiktok"), output_folder: dir, allow_overwrite: true, allow_stretch: true });
    expect(out.results[0].warnings.join()).toMatch(/stretch/);
    expect(item.outputModule(1).settings["Resize to"]).toEqual([1080, 1920]);
  });

  it("applies extra settings and a post-render action to every spec, and reports a key the format lacks", () => {
    const { A, item } = scene();
    const out = apply(A, { specs: libs("png_sequence"), settings: { "Audio Sample Rate": 48000 }, post_render_action: "import" });
    expect(item.outputModule(1).postRenderAction).toBe(POST.IMPORT);
    expect(out.results[0].skipped.map((s: any) => s.key)).toEqual(["Audio Sample Rate"]);
    expect(stepMismatches("s", out.results[0].errors, out.results[0].skipped)).toHaveLength(1);
  });

  it("warns when the preferred template isn't installed", () => {
    const { A, item } = scene();
    item.outputModule(1).templates = ["Lossless", "H.264 - Match Render Settings - 5 Mbps"];
    const out = apply(A, { specs: libs("youtube_1080p") });
    expect(out.results[0].template).toBe("H.264 - Match Render Settings - 5 Mbps");
    expect(out.results[0].warnings.join()).toMatch(/preferred template/);
  });
});

describe("rqedit.jsx: review fixes", () => {
  it("echoes final module indexes when modules are removed (replace a module)", () => {
    const { A, item } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/old.mp4");
    const out = plainOf(
      A.rqeditEdit({ item_index: 1, add_modules: [{ file: "C:/out/new.mp4" }], remove_modules: [1], expect: GUARD })
    );
    expect(out.errors).toEqual([]);
    expect(out.added_modules).toEqual([1]);
    expect(itemMismatches("item[1]", out.expect, read(A, 1).items[0], [])).toEqual([]);
    expect(item.numOutputModules).toBe(1);
    expect(item.outputModule(1).file.fsName).toBe("C:/out/new.mp4");
  });

  it("maps an edited module above a removed one to its final index", () => {
    const { A, item } = scene();
    item.outputModules.add();
    item.outputModule(1).file = new FakeFile("C:/out/a.mp4");
    item.outputModule(2).file = new FakeFile("C:/out/b.mp4");
    const out = plainOf(A.rqeditEdit({ item_index: 1, modules: [{ index: 2, file: "C:/out/c.mp4" }], remove_modules: [1], expect: GUARD }));
    expect(out.expect.modules[0].index).toBe(1);
    expect(itemMismatches("item[1]", out.expect, read(A, 1).items[0], [])).toEqual([]);
  });

  it("refuses an existing image sequence without allow_overwrite", () => {
    const { A, item, G } = scene();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "frames_00001.png"), "x");
    (G as any).Folder = class {
      constructor(public p: string) {}
      get exists() {
        return fs.existsSync(this.p);
      }
      getFiles(mask: string) {
        const re = new RegExp("^" + mask.split(".").join("[.]").split("*").join(".*") + "$");
        return fs.readdirSync(this.p).filter((n) => re.test(n)).map((n) => ({ name: n }));
      }
    };
    const seq = dir.split("\\").join("/") + "/frames_[#####].png";
    const args = { item_index: 1, modules: [{ index: 1, file: seq }], expect: GUARD };
    expect(() => A.rqeditEdit(args)).toThrow(/already exists/);
    const ok = plainOf(A.rqeditEdit({ ...args, allow_overwrite: true }));
    expect(ok.errors).toEqual([]);
    expect(item.outputModule(1).file.fsName).toBe(seq);
  });

  it("refuses to edit a DONE item before touching AE", () => {
    const { A, item, undo } = scene();
    item.status = STATUS.DONE;
    expect(() => A.rqeditEdit({ item_index: 1, skip_frames: 1, expect: GUARD })).toThrow(/DONE.*ae_render_queue_duplicate/);
    expect(undo.begun).toBe(0);
    expect(item.skipFrames).toBe(0);
  });

  it("apply_spec on a DONE item puts every spec on a duplicate, and refuses in_place: true", () => {
    const { A, rq, item, undo } = scene();
    item.status = STATUS.DONE;
    expect(() => A.rqeditApplySpec({ item_index: 1, specs: [specById("youtube_1080p")], output_folder: "C:/deliver", in_place: true, expect: GUARD })).toThrow(/DONE/);
    expect(undo.begun).toBe(0);
    const out = plainOf(A.rqeditApplySpec({ item_index: 1, specs: [specById("youtube_1080p"), specById("linkedin_1080p")], output_folder: "C:/deliver", expect: GUARD }));
    expect(out.in_place).toBe(false);
    expect(out.results.map((r: any) => [r.item_index, r.in_place])).toEqual([[2, false], [3, false]]);
    expect(rq.item(1).outputModule(1).settings.Format).toBe("AVI");
    expect(rq.item(2).outputModule(1).settings.Format).toBe("H.264");
  });

  it("a copy is found by its tag, not by how it looks: identical items (no output file) get their own plan", () => {
    const { A, rq } = scene({ duplicateAfterSource: true });
    const out = plainOf(A.rqeditDuplicate({ item_index: 1, copies: [{ skip_frames: 1 }, { skip_frames: 2 }], expect: GUARD }));
    expect(out.errors).toEqual([]);
    expect(rq.list.map((i: any) => i.skipFrames)).toEqual([0, 2, 1]);
    expect(out.copies.map((c: any) => c.item_index)).toEqual([3, 2]);
    // The tag is taken off again.
    expect(rq.list.map((i: any) => i.comment)).toEqual([undefined, undefined, undefined]);
  });

  it("without a way to tag the copy, an indistinguishable copy is reported and left alone", () => {
    const { A, rq, item } = scene({ duplicateAfterSource: true });
    const real = item.duplicate.bind(item);
    item.duplicate = () => {
      const c = real();
      Object.defineProperty(c, "comment", {
        get() {
          throw new Error("no comment");
        },
        set() {
          throw new Error("no comment");
        },
      });
      return c;
    };
    const out = plainOf(A.rqeditDuplicate({ item_index: 1, copies: [{ skip_frames: 1 }], expect: GUARD }));
    expect(rq.numItems).toBe(2);
    expect(out.errors[0].message).toMatch(/could not be told/);
    expect(out.copies[0].item_index).toBeNull();
    expect(rq.list.map((i: any) => i.skipFrames)).toEqual([0, 0]);
  });

  it("plain copies continue the _copyN numbering on a later call", () => {
    const { A, rq, item } = scene();
    item.outputModule(1).file = new FakeFile("C:/out/film.mp4");
    A.rqeditDuplicate({ item_index: 1, copies: [{}], expect: GUARD });
    const out = plainOf(A.rqeditDuplicate({ item_index: 1, copies: [{}, {}], expect: GUARD }));
    expect(out.errors).toEqual([]);
    expect(rq.list.map((i: any) => i.outputModule(1).file.fsName)).toEqual(["C:/out/film.mp4", "C:/out/film_copy1.mp4", "C:/out/film_copy2.mp4", "C:/out/film_copy3.mp4"]);
  });

  it("a settings step whose module is gone is recorded, not thrown out of the undo group", () => {
    const { A, item } = scene();
    const real = item.outputModule.bind(item);
    let armed = false;
    item.outputModule = (i: number) => {
      if (armed) throw new Error("module is gone");
      return real(i);
    };
    // Validation runs first; the host then loses the module once the write starts.
    const realTemplate = item.applyTemplate.bind(item);
    item.applyTemplate = (n: string) => {
      armed = true;
      realTemplate(n);
    };
    const out = plainOf(A.rqeditEdit({ item_index: 1, item_template: "Draft Settings", modules: [{ index: 1, settings: { Channels: "RGB" } }], expect: GUARD }));
    expect(out.errors.map((e: any) => e.message)).toContain("module is gone");
  });

  it("the default spec check judges the aspect ratio against item 1's comp", () => {
    const { A } = scene();
    const r = plainOf(A.rqeditSpecs({ specs: [specById("tiktok"), specById("youtube_1080p")] }));
    expect(r.comp).toMatchObject({ width: 1920, height: 1080 });
    expect(r.specs.map((s: any) => s.feasible)).toEqual([false, true]);
  });

  it("the whole queue can be read briefly with settings only for chosen items", () => {
    const { A, rq, project } = scene();
    rq.add(project.addComp("Two", 640, 360, 5));
    const r = plainOf(A.rqeditRead({ settings_indexes: [2] }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0].render_settings).toBeUndefined();
    expect(r.items[1].render_settings).toBeTruthy();
  });

  it("flags a capped module list", () => {
    const { A, item } = scene();
    for (let i = 0; i < 24; i++) item.outputModules.add();
    const r = plainOf(A.rqeditRead({ item_indexes: [1] }));
    expect(r.items[0].output_modules.length).toBe(20);
    expect(r.items[0].output_modules_truncated).toBe(true);
  });
});
