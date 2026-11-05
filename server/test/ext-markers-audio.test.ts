import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeAudioAnalyzeSchema, AeCueKeysSchema, createAudioTools, cueKeysMismatches, findRenderedAudio, planCueKeys } from "../src/tools/ext/audio.js";
import {
  AeAddMarkersSchema,
  AeRemoveMarkersSchema,
  addMarkersMismatches,
  editMarkersMismatches,
  markersTools,
  removeMarkersMismatches,
  sameParams,
  selectForRemoval,
  type MarkerList,
} from "../src/tools/ext/markers.js";
import { zodToJsonSchema } from "../src/schema.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-mk-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const expectArg = { project_path: "<unsaved>" };
const mk = (index: number, time: number, comment: string) => ({ index, time, duration: 0, comment });
const list = (markers: ReturnType<typeof mk>[], extra: Partial<MarkerList> = {}): MarkerList => ({
  target: "comp",
  numMarkers: markers.length,
  markers,
  truncated: false,
  ...extra,
});
const markerTool = (name: string) => markersTools.find((t) => t.name === name)!;

describe("marker and audio tools", () => {
  it("are registered; the writes take automatic checkpoints", () => {
    for (const name of ["ae_get_markers", "ae_add_markers", "ae_remove_markers", "ae_audio_analyze", "ae_cue_keys"]) {
      expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
    }
    for (const name of ["ae_add_markers", "ae_remove_markers", "ae_cue_keys"]) expect(AUTO_CHECKPOINT_TOOLS).toContain(name);
    expect(AUTO_CHECKPOINT_TOOLS).not.toContain("ae_audio_analyze");
  });
});

describe("ae_add_markers", () => {
  it("adds from a list with a separate read-back", async () => {
    const { ctx, calls } = fakeAe({
      listMarkers: [list([mk(1, 0, "start")]), list([mk(1, 0, "start"), mk(2, 1.5, "beat")])],
      addMarkers: [{ target: "comp", placed: [{ time: 1.5, comment: "beat" }], replaced: 0 }],
    });
    const args = AeAddMarkersSchema.parse({ comp_id: 1, markers: [{ time: 1.5, comment: "beat" }], expect: expectArg });
    const out = await markerTool("ae_add_markers").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "listMarkers", "addMarkers", "listMarkers"]);
    expect(out).toMatchObject({ applied: true, added: 1, numMarkers: 2, relative_to: "comp" });
    expect(out.receipt.matches).toBe(true);
  });

  it("turns a transcript into layer-relative markers, and dry runs without AE", async () => {
    const dir = tempDir("chroma-mk-tr-");
    const srt = path.join(dir, "vo.srt");
    fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nANNA: Hi.\n\n2\n00:00:03,000 --> 00:00:04,000\nBEN: Yo.\n");
    const { ctx, calls } = fakeAe({});
    const args = AeAddMarkersSchema.parse({ comp_id: 1, layer: { name: "VO" }, transcript: { path: srt }, dry_run: true, expect: expectArg });
    const out = await markerTool("ae_add_markers").handler(args, ctx);
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ dry_run: true, relative_to: "layer", count: 2 });
    expect(out.markers).toEqual([
      { time: 1, duration: 1, comment: "Hi.", label: 1 },
      { time: 3, duration: 1, comment: "Yo.", label: 2 },
    ]);
  });

  it("reports a bad transcript without touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    const out = await markerTool("ae_add_markers").handler(
      AeAddMarkersSchema.parse({ comp_id: 1, transcript: { text: "nothing timed" }, expect: expectArg }),
      ctx
    );
    expect(out).toMatchObject({ ok: false, error: "bad_transcript" });
    expect(calls).toEqual([]);
  });

  it("schema wants markers or a transcript, and a layer for layer time", () => {
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, markers: [{ time: 1 }], relative_to: "layer", expect: expectArg }).success).toBe(false);
  });
});

describe("addMarkersMismatches", () => {
  it("counts a time already marked as a replacement, not an addition", () => {
    const before = list([mk(1, 1, "old")]);
    const after = list([mk(1, 1, "new"), mk(2, 2, "two")]);
    expect(addMarkersMismatches(before, after, { placed: [{ time: 1, comment: "new" }, { time: 2, comment: "two" }] })).toEqual([]);
  });

  it("flags a missing marker and a wrong comment", () => {
    const after = list([mk(1, 1, "nope")]);
    const m = addMarkersMismatches(list([]), after, { placed: [{ time: 1, comment: "a" }, { time: 2, comment: "b" }] });
    expect(m.map((x) => x.path)).toEqual(["numMarkers", "markers@1.comment", "markers@2"]);
  });
});

describe("ae_remove_markers", () => {
  const markers = [mk(1, 0.5, "Beat"), mk(2, 1, "VO: hi"), mk(3, 2, "beat")];

  it("selects like the host does", () => {
    const sel = (a: object) => selectForRemoval(markers, AeRemoveMarkersSchema.parse({ comp_id: 1, expect: expectArg, ...a })).map((x) => x.index);
    expect(sel({ comment_contains: "beat" })).toEqual([1, 3]);
    expect(sel({ comment_contains: "beat", start: 1 })).toEqual([3]);
    expect(sel({ start: 0.9, end: 1.1 })).toEqual([2]);
    expect(sel({ indexes: [2] })).toEqual([2]);
    expect(sel({ all: true })).toEqual([1, 2, 3]);
  });

  it("needs a criterion", () => {
    expect(AeRemoveMarkersSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
  });

  it("checks the removed markers are gone", () => {
    const removed = [mk(1, 0.5, "Beat")];
    expect(removeMarkersMismatches(list(markers), list(markers.slice(1)), { removed })).toEqual([]);
    expect(removeMarkersMismatches(list(markers), list(markers), { removed }).map((x) => x.path)).toEqual(["numMarkers", "markers@0.5"]);
  });
});

// ---------- audio ----------

function silentAiff(seconds: number, sampleRate = 8000): Buffer {
  // A minimal 16-bit mono AIFF: FORM, COMM (18 bytes), SSND.
  const frames = Math.round(seconds * sampleRate);
  const comm = Buffer.alloc(26);
  comm.write("COMM", 0, "latin1");
  comm.writeUInt32BE(18, 4);
  comm.writeInt16BE(1, 8);
  comm.writeUInt32BE(frames, 10);
  comm.writeInt16BE(16, 14);
  const e = Math.floor(Math.log2(sampleRate));
  comm.writeUInt16BE(16383 + e, 16);
  comm.writeBigUInt64BE(BigInt(sampleRate) << BigInt(63 - e), 18);
  const ssnd = Buffer.alloc(16 + frames * 2);
  ssnd.write("SSND", 0, "latin1");
  ssnd.writeUInt32BE(8 + frames * 2, 4);
  const form = Buffer.alloc(12);
  form.write("FORM", 0, "latin1");
  form.writeUInt32BE(4 + comm.length + ssnd.length, 4);
  form.write("AIFF", 8, "latin1");
  return Buffer.concat([form, comm, ssnd]);
}

const compInfo = (extra: object = {}) => ({
  comp_id: 1,
  name: "Edit",
  name_unique: true,
  duration: 4,
  fps: 25,
  frame_duration: 0.04,
  display_start_time: 0,
  audio_layers: [{ index: 2, name: "Music" }],
  project_path: "C:/p/x.aep",
  dirty: false,
  ...extra,
});

describe("ae_audio_analyze", () => {
  it("starts an aerender job for the comp's audio, waits, and analyses the file it wrote", async () => {
    const dir = tempDir("chroma-audio-");
    const started: Array<Record<string, unknown>> = [];
    let state: "running" | "succeeded" = "running";
    let output = "";
    const tools = createAudioTools({
      rendersDir: () => dir,
      pollMs: 5,
      startRender: async (args) => {
        started.push(args);
        output = String(args.output_path);
        setTimeout(() => {
          fs.writeFileSync(output, silentAiff(1));
          state = "succeeded";
        }, 20);
        return { ok: true, job_id: "job_1" };
      },
      getJob: () => ({ state, output_path: output, log_path: "x.log" }),
    });
    const { ctx } = fakeAe({ audioCompInfo: [compInfo()] });
    const args = AeAudioAnalyzeSchema.parse({ comp_id: 1, start: 1, end: 3, expect: { project_path: "C:/p/x.aep" } });
    const out = await tools.find((t) => t.name === "ae_audio_analyze")!.handler(args, ctx);
    expect(started[0]).toMatchObject({ comp_name: "Edit", output_module_template: "AIFF 48kHz", start_frame: 25, end_frame: 74 });
    expect(out).toMatchObject({ ok: true, state: "done", job_id: "job_1", time_offset: 1 });
    expect(out.overall.silent_ratio).toBe(1);
    expect(fs.existsSync(`${output}.json`)).toBe(true);
  });

  it("returns the job id when the render outlasts wait_seconds", async () => {
    const tools = createAudioTools({
      rendersDir: () => tempDir("chroma-audio-wait-"),
      pollMs: 5,
      startRender: async () => ({ ok: true, job_id: "job_2" }),
      getJob: () => ({ state: "running", output_path: "nowhere.aif", log_path: "x.log" }),
    });
    const { ctx } = fakeAe({ audioCompInfo: [compInfo()] });
    const out = await tools[0].handler(AeAudioAnalyzeSchema.parse({ comp_id: 1, wait_seconds: 0, expect: { project_path: "C:/p/x.aep" } }), ctx);
    expect(out).toMatchObject({ ok: true, state: "rendering", job_id: "job_2" });
  });

  it("refuses a comp whose name is shared or that has no sound", async () => {
    const tools = createAudioTools({ startRender: async () => ({ job_id: "never" }) });
    const run = async (info: object) => {
      const { ctx } = fakeAe({ audioCompInfo: [compInfo(info)] });
      return tools[0].handler(AeAudioAnalyzeSchema.parse({ comp_id: 1, expect: { project_path: "C:/p/x.aep" } }), ctx);
    };
    expect(await run({ name_unique: false })).toMatchObject({ ok: false, error: "ambiguous_comp" });
    expect(await run({ audio_layers: [] })).toMatchObject({ ok: false, error: "no_audio" });
  });

  it("analyses a file by path without AE", async () => {
    const file = path.join(tempDir("chroma-audio-path-"), "a.aif");
    fs.writeFileSync(file, silentAiff(0.5));
    const { ctx, calls } = fakeAe({});
    const out = await createAudioTools()[0].handler(AeAudioAnalyzeSchema.parse({ audio_path: file, time_offset: 2 }), ctx);
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ ok: true, state: "done", time_offset: 2 });
    expect(out.source.sample_rate).toBe(8000);
  });

  it("schema wants one source and expect with a comp", () => {
    expect(AeAudioAnalyzeSchema.safeParse({}).success).toBe(false);
    expect(AeAudioAnalyzeSchema.safeParse({ comp_id: 1 }).success).toBe(false);
    expect(AeAudioAnalyzeSchema.safeParse({ comp_id: 1, job_id: "x", expect: expectArg }).success).toBe(false);
  });

  it("finds the render when aerender changed the extension", () => {
    const dir = tempDir("chroma-audio-ext-");
    fs.writeFileSync(path.join(dir, "Edit_1.aiff"), "x");
    expect(findRenderedAudio(path.join(dir, "Edit_1.aif"))).toBe(path.join(dir, "Edit_1.aiff"));
  });
});

describe("ae_cue_keys", () => {
  it("plans with the comp's frame, writes, and checks every key", async () => {
    const planned = planCueKeys([1], { attack: 0, decay: 0.2, frame: 0.04, peak: [120, 120] });
    const snapshot = (keys: Array<{ time: number; value: unknown }>) => ({ numKeys: keys.length, keys: keys.map((k, i) => ({ index: i + 1, ...k })), truncated: false });
    const { ctx, calls } = fakeAe({
      audioCompInfo: [compInfo()],
      keysSnapshot: [
        snapshot([]),
        snapshot([
          { time: 0.96, value: [100, 100, 100] },
          { time: 1, value: [120, 120, 100] },
          { time: 1.2, value: [100, 100, 100] },
        ]),
      ],
      cueKeys: [{ set: 3, cleared: 0, base: [100, 100, 100] }],
    });
    const args = AeCueKeysSchema.parse({ comp_id: 1, layer: { name: "Logo" }, path: ["ADBE Transform Group", "ADBE Scale"], times: [1], peak: [120, 120], decay: 0.2, expect: expectArg });
    const out = await createAudioTools()[1].handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["audioCompInfo", "checkGuard", "keysSnapshot", "cueKeys", "keysSnapshot"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.keys_set).toBe(3);
    expect(planned.length).toBe(3);
  });

  it("flags a key that read back with another value", () => {
    const planned = planCueKeys([1], { attack: 0, decay: 0.2, frame: 0.04, peak: 50 });
    const after = { numKeys: 3, truncated: false, keys: [{ index: 1, time: 0.96, value: 0 }, { index: 2, time: 1, value: 40 }, { index: 3, time: 1.2, value: 0 }] };
    expect(cueKeysMismatches(planned, after, { base: 0 }).map((m) => m.path)).toEqual(["keys@1"]);
  });
});

describe("ae_add_markers edit / move and the AE 16.0 fields", () => {
  const edit = (extra: object = {}) => ({ comp_id: 1, edit: [{ index: 1, move_to: 4 }], expect: expectArg, ...extra });
  const planned = { changed: true, target: "comp", numMarkers: 2, edits: [{ index: 1, from: 1, to: 4, moved: true }] };
  const fields = { comment: "a", duration: 0.5, label: 2, chapter: "", url: "", frame_target: "", cue_point_name: "", event_cue_point: false, protected_region: false, params: {} };
  const written = { target: "comp", edits: [{ index: 1, from: 1, to: 4, moved: true, fields }], frame_duration: 0.04, numMarkers: 2 };

  it("the schema takes exactly one of markers, transcript and edit, and each edit needs a way to find the marker and something to do", () => {
    expect(AeAddMarkersSchema.safeParse(edit()).success).toBe(true);
    expect(AeAddMarkersSchema.safeParse(edit({ markers: [{ time: 1 }] })).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse(edit({ edit: [{ move_to: 4 }] })).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse(edit({ edit: [{ index: 1, time: 1, move_to: 4 }] })).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse(edit({ edit: [{ index: 1 }] })).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse(edit({ edit: [{ time: 2, set: { protected_region: true, params: { a: "1" } } }] })).success).toBe(true);
    expect(AeAddMarkersSchema.safeParse(edit({ expect: undefined })).success).toBe(false);
    expect(AeAddMarkersSchema.safeParse(edit({ expect: undefined, dry_run: true })).success).toBe(true);
  });

  it("add accepts the new marker fields", () => {
    const ok = AeAddMarkersSchema.safeParse({
      comp_id: 1,
      markers: [{ time: 1, protected_region: true, frame_target: "_top", cue_point_name: "x", event_cue_point: false, params: { a: "1", n: 2, b: true } }],
      expect: expectArg,
    });
    expect(ok.success).toBe(true);
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, markers: [{ time: 1, params: { a: { x: 1 } } }], expect: expectArg }).success).toBe(false);
  });

  it("converts to JSON schema", () => {
    expect(() => zodToJsonSchema(AeAddMarkersSchema)).not.toThrow();
  });

  it("plans first, then guards, reads, edits and reads back; the receipt matches a faithful edit", async () => {
    const before = list([{ ...mk(1, 1, "a"), duration: 0.5, label: 2 }, mk(2, 2, "b")]);
    const after = list([mk(2, 2, "b"), { ...mk(1, 4, "a"), duration: 0.5, label: 2 }].map((m, i) => ({ ...m, index: i + 1 })));
    const { ctx, calls } = fakeAe({ editMarkers: [planned, written], listMarkers: [before, after] });
    const out: any = await markerTool("ae_add_markers").handler(AeAddMarkersSchema.parse(edit()), ctx);
    // Guard first, so a wrong project fails with the guard error and not an error from another project's ids.
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "editMarkers", "checkGuard", "listMarkers", "editMarkers", "listMarkers"]);
    expect(calls[1].script).toContain('"dry_run":true');
    expect(calls[4].script).not.toContain('"dry_run"');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out).toMatchObject({ edited: 1, numMarkers: 2, relative_to: "comp" });
  });

  it("dry run only plans", async () => {
    const { ctx, calls } = fakeAe({ editMarkers: [planned] });
    const out: any = await markerTool("ae_add_markers").handler(AeAddMarkersSchema.parse(edit({ dry_run: true })), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["editMarkers"]);
    expect(out).toMatchObject({ ok: true, dry_run: true, changed: true });
  });

  it("a wrong project fails with the guard error before the plan is read", async () => {
    const { ctx, calls } = fakeAe({ editMarkers: [planned] });
    const bad = AeAddMarkersSchema.parse(edit({ expect: { project_path: "C:/other.aep" } }));
    let seen: unknown;
    try {
      seen = await markerTool("ae_add_markers").handler(bad, ctx);
    } catch (e) {
      seen = e;
    }
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
    expect(String(seen) + JSON.stringify(seen)).toMatch(/guard/i);
  });

  it("an edit that changes nothing skips the write", async () => {
    const { ctx, calls } = fakeAe({ editMarkers: [{ ...planned, changed: false }] });
    const out: any = await markerTool("ae_add_markers").handler(AeAddMarkersSchema.parse(edit()), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "editMarkers"]);
    expect(out).toMatchObject({ ok: true, no_op: true });
  });

  it("passes a layer and layer-relative times to the host", async () => {
    const { ctx, calls } = fakeAe({ editMarkers: [planned] });
    await markerTool("ae_add_markers").handler(AeAddMarkersSchema.parse(edit({ layer: { name: "VO" }, relative_to: "layer", dry_run: true })), ctx);
    expect(calls[0].script).toContain('"relative_to":"layer"');
    expect(calls[0].script).toContain('"name":"VO"');
  });

  it("editMarkersMismatches checks the moved marker's fields, the old time and the untouched markers", () => {
    const before = list([{ ...mk(1, 1, "a"), duration: 0.5, label: 2 }, mk(2, 2, "b")]);
    const good = list([mk(1, 2, "b"), { ...mk(2, 4, "a"), duration: 0.5, label: 2 }]);
    expect(editMarkersMismatches(before, good, written)).toEqual([]);
    const wrongComment = list([mk(1, 2, "b"), { ...mk(2, 4, "zzz"), duration: 0.5, label: 2 }]);
    expect(editMarkersMismatches(before, wrongComment, written).map((x) => x.path)).toEqual(["markers@4.comment"]);
    const lostLabel = list([mk(1, 2, "b"), { ...mk(2, 4, "a"), duration: 0.5, label: 0 }]);
    expect(editMarkersMismatches(before, lostLabel, written).map((x) => x.path)).toEqual(["markers@4.label"]);
    const stillThere = list([mk(1, 1, "a"), mk(2, 2, "b"), { ...mk(3, 4, "a"), duration: 0.5, label: 2 }], {});
    const m = editMarkersMismatches(before, stillThere, written);
    expect(m.map((x) => x.path)).toEqual(["numMarkers", "markers@1"]);
    const lostUntouched = list([mk(1, 3, "b"), { ...mk(2, 4, "a"), duration: 0.5, label: 2 }]);
    expect(editMarkersMismatches(before, lostUntouched, written).map((x) => x.path)).toEqual(["markers@2"]);
  });

  it("editMarkersMismatches reports fields that could not be copied or set", () => {
    const before = list([mk(1, 1, "a")]);
    const after = list([mk(1, 1, "a")]);
    const w = { edits: [{ index: 1, from: 1, to: 1, moved: false, fields: { comment: "a" }, copy_failed: ["chapter"], refused: ["label"] }] };
    expect(editMarkersMismatches(before, after, w).map((x) => x.path)).toEqual(["markers@1.chapter", "markers@1.label"]);
  });

  it("editMarkersMismatches compares the AE 16.0 fields with the defaults an unset field reads back as", () => {
    const f = { comment: "a", frame_target: "_top", cue_point_name: "cp", event_cue_point: true, protected_region: true, params: { a: "1", b: "2" } };
    const w = { edits: [{ index: 1, from: 1, to: 1, moved: false, fields: f }] };
    const before = list([mk(1, 1, "a")]);
    const good = list([{ ...mk(1, 1, "a"), frame_target: "_top", cue_point_name: "cp", event_cue_point: true, protected_region: true, params: { b: "2", a: "1" } }]);
    expect(editMarkersMismatches(before, good, w)).toEqual([]);
    expect(editMarkersMismatches(before, list([mk(1, 1, "a")]), w).map((x) => x.path)).toEqual([
      "markers@1.frame_target",
      "markers@1.cue_point_name",
      "markers@1.event_cue_point",
      "markers@1.protected_region",
      "markers@1.params",
    ]);
  });

  it("addMarkersMismatches checks the new fields", () => {
    const placed = [{ time: 1, comment: "a", protected_region: true, frame_target: "_top", cue_point_name: "cp", event_cue_point: true, params: { a: "1" } }];
    const ok = list([{ ...mk(1, 1, "a"), protected_region: true, frame_target: "_top", cue_point_name: "cp", event_cue_point: true, params: { a: "1" } }]);
    expect(addMarkersMismatches(list([]), ok, { placed })).toEqual([]);
    expect(addMarkersMismatches(list([]), list([mk(1, 1, "a")]), { placed }).map((x) => x.path)).toEqual([
      "markers@1.protected_region",
      "markers@1.frame_target",
      "markers@1.cue_point_name",
      "markers@1.event_cue_point",
      "markers@1.params",
    ]);
    const refused = addMarkersMismatches(list([]), ok, { placed: [{ ...placed[0], refused: ["protected_region"] }] });
    expect(refused.map((x) => x.message)).toEqual(["AE refused protected_region at 1s"]);
    expect(sameParams({ a: 1 }, { a: "1" })).toBe(true);
    expect(sameParams({ a: "1" }, undefined)).toBe(false);
  });

  it("descriptions mention the edit and the new fields", () => {
    expect(markerTool("ae_add_markers").description).toMatch(/edit instead of markers/);
    expect(markerTool("ae_add_markers").description).toMatch(/protected_region/);
    expect(markerTool("ae_get_markers").description).toMatch(/protected_region/);
  });
});
