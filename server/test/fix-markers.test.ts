/**
 * Regression tests for the marker review fixes: the add receipt (clipped comments,
 * label, duration, close times), negative cue times, the remove cap and unmatched
 * indexes, the speaker-prefix heuristic, and the host's up-front validation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeAddMarkersSchema,
  AeRemoveMarkersSchema,
  addMarkersMismatches,
  markersTools,
  removeMarkersMismatches,
  type MarkerList,
} from "../src/tools/ext/markers.js";
import { zodToJsonSchema } from "../src/schema.js";
import { parseTranscript, transcriptCues } from "../src/transcript.js";
import { FakeProject, GUARD, loadHost, MarkerValue, type FakeProperty } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(results: Record<string, unknown[]>) {
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fixmk-"));
  tmpDirs.push(dir);
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
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
const mk = (index: number, time: number, comment: string, extra: object = {}) => ({ index, time, duration: 0, comment, ...extra });
const list = (markers: Array<ReturnType<typeof mk>>, extra: Partial<MarkerList> = {}): MarkerList => ({
  target: "comp",
  numMarkers: markers.length,
  markers,
  truncated: false,
  ...extra,
});
const tool = (name: string) => markersTools.find((t) => t.name === name)!;
const CLIP = " ...[truncated]";

describe("add receipt and long comments (C22, C24)", () => {
  it("accepts a comment over 2000 chars when the read-back is clipped", () => {
    const long = "x".repeat(2500);
    const clipped = long.slice(0, 2000) + CLIP;
    expect(addMarkersMismatches(list([]), list([mk(1, 1, clipped)]), { placed: [{ time: 1, comment: long }] })).toEqual([]);
    // A transcript cue is 2001 chars (2000 plus an ellipsis).
    const cue = "y".repeat(2000) + "…";
    expect(addMarkersMismatches(list([]), list([mk(1, 1, cue.slice(0, 2000) + CLIP)]), { placed: [{ time: 1, comment: cue }] })).toEqual([]);
  });

  it("still flags a long comment whose first 2000 chars differ, and copes with an already clipped placed comment", () => {
    const long = "x".repeat(2500);
    const wrong = "z".repeat(2000) + CLIP;
    expect(addMarkersMismatches(list([]), list([mk(1, 1, wrong)]), { placed: [{ time: 1, comment: long }] }).map((x) => x.path)).toEqual(["markers@1.comment"]);
    const clipped = long.slice(0, 2000) + CLIP;
    expect(addMarkersMismatches(list([]), list([mk(1, 1, clipped)]), { placed: [{ time: 1, comment: clipped }] })).toEqual([]);
  });
});

describe("add receipt checks label, duration, chapter and url (C23)", () => {
  const placed = { time: 1, comment: "a", duration: 2, label: 3, chapter: "Intro", url: "https://x.test" };
  const good = mk(1, 1, "a", { duration: 2, label: 3, chapter: "Intro", url: "https://x.test" });

  it("passes when everything matches", () => {
    expect(addMarkersMismatches(list([]), list([good]), { placed: [placed] })).toEqual([]);
  });

  it("flags a label that did not take, a failed label, another duration, chapter and url", () => {
    const paths = (got: object, p: object = placed) => addMarkersMismatches(list([]), list([{ ...good, ...got }]), { placed: [p] }).map((x) => x.path);
    expect(paths({ label: 0 })).toEqual(["markers@1.label"]);
    expect(paths({}, { ...placed, label_failed: true })).toEqual(["markers@1.label"]);
    expect(paths({ duration: 0 })).toEqual(["markers@1.duration"]);
    expect(paths({ chapter: "Other" })).toEqual(["markers@1.chapter"]);
    expect(paths({ url: undefined })).toEqual(["markers@1.url"]);
  });

  it("lets a duration snap by half a frame, and not by more", () => {
    const run = (duration: number) => addMarkersMismatches(list([]), list([mk(1, 1, "a", { duration })]), { placed: [{ time: 1, comment: "a", duration: 1.01 }], frame_duration: 0.04 });
    expect(run(1.03)).toEqual([]);
    expect(run(1.05).map((x) => x.path)).toEqual(["markers@1.duration"]);
  });
});

describe("add receipt with times 1 ms apart (C57, C59)", () => {
  const placed = [
    { time: 1, comment: "one" },
    { time: 1.001, comment: "two" },
  ];

  it("accepts AE keeping them as two markers", () => {
    expect(addMarkersMismatches(list([]), list([mk(1, 1, "one"), mk(2, 1.001, "two")]), { placed })).toEqual([]);
  });

  it("accepts AE merging them into one marker holding the later write", () => {
    expect(addMarkersMismatches(list([]), list([mk(1, 1, "two")]), { placed })).toEqual([]);
  });

  it("still flags a count outside that range and a comment that matches neither", () => {
    expect(addMarkersMismatches(list([]), list([mk(1, 1, "one"), mk(2, 1.001, "two"), mk(3, 5, "extra")]), { placed }).map((x) => x.path)).toEqual(["numMarkers"]);
    expect(addMarkersMismatches(list([]), list([mk(1, 1, "other")]), { placed }).map((x) => x.path)).toEqual(["markers@1.comment"]);
  });

  it("picks the nearest marker, not the first within the tolerance", () => {
    const before = list([mk(1, 1, "old")]);
    // A marker at 1.000 already exists; the new one at 1.001 is a second key in AE.
    expect(addMarkersMismatches(before, list([mk(1, 1, "old"), mk(2, 1.001, "new")]), { placed: [{ time: 1.001, comment: "new" }] })).toEqual([]);
  });
});

describe("negative transcript cue times (C25, C60)", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:05,000 --> 00:00:06,000\nBye.\n";

  it("refuses an offset that puts a cue before 0, in a dry run too, without touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    for (const dry_run of [true, undefined]) {
      const args = AeAddMarkersSchema.parse({ comp_id: 1, transcript: { text: SRT, offset: -2 }, dry_run, expect: expectArg });
      const out = await tool("ae_add_markers").handler(args, ctx);
      expect(out).toMatchObject({ ok: false, error: "bad_args" });
      expect(out.message).toContain("1 of 2");
    }
    expect(calls).toEqual([]);
  });

  it("allows an offset that keeps every cue at or after 0, and refuses a non-finite one", async () => {
    const { ctx } = fakeAe({});
    const out = await tool("ae_add_markers").handler(AeAddMarkersSchema.parse({ comp_id: 1, transcript: { text: SRT, offset: -1 }, dry_run: true }), ctx);
    expect(out).toMatchObject({ ok: true, count: 2 });
    expect(out.markers[0].time).toBe(0);
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, transcript: { text: SRT, offset: Infinity }, expect: expectArg }).success).toBe(false);
  });
});

describe("expect is optional for a dry run only (C61)", () => {
  it("parses a dry run without expect and refuses a write without it", () => {
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, markers: [{ time: 1 }], dry_run: true }).success).toBe(true);
    expect(AeAddMarkersSchema.safeParse({ comp_id: 1, markers: [{ time: 1 }] }).success).toBe(false);
    expect(AeRemoveMarkersSchema.safeParse({ comp_id: 1, all: true, dry_run: true }).success).toBe(true);
    expect(AeRemoveMarkersSchema.safeParse({ comp_id: 1, all: true }).success).toBe(false);
  });
});

describe("remove: count, cap, unmatched indexes (C58, C61)", () => {
  it("bases the count on removed_count when the list is capped", () => {
    const removed = [mk(1, 1, "a")];
    const before = list([mk(1, 1, "a"), mk(2, 2, "b"), mk(3, 3, "c")]);
    const after = list([mk(1, 3, "c")]);
    expect(removeMarkersMismatches(before, after, { removed, removed_count: 2 })).toEqual([]);
    expect(removeMarkersMismatches(before, after, { removed }).map((x) => x.path)).toEqual(["numMarkers"]);
  });

  it("reports indexes past the last marker and warns when nothing matched", async () => {
    const { ctx } = fakeAe({
      listMarkers: [list([mk(1, 1, "a")]), list([mk(1, 1, "a")])],
      removeMarkers: [{ target: "comp", removed: [], removed_count: 0, removed_truncated: false }],
    });
    const args = AeRemoveMarkersSchema.parse({ comp_id: 1, indexes: [999], expect: expectArg });
    const out = await tool("ae_remove_markers").handler(args, ctx);
    expect(out).toMatchObject({ applied: true, removed: [], removed_count: 0, unmatched_indexes: [999] });
    expect(out.warning).toContain("nothing was removed");
  });

  it("lists unmatched indexes in a dry run", async () => {
    const { ctx } = fakeAe({ listMarkers: [list([mk(1, 1, "a")])] });
    const out = await tool("ae_remove_markers").handler(AeRemoveMarkersSchema.parse({ comp_id: 1, indexes: [1, 7], dry_run: true }), ctx);
    expect(out).toMatchObject({ dry_run: true, count: 1, unmatched_indexes: [7] });
  });

  it("host returns at most 500 removed entries with the real count", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const { A } = loadHost(project, ["markers.jsx"]);
    const prop = comp.markerProperty as FakeProperty;
    const markers = [];
    for (let i = 0; i < 700; i++) markers.push({ time: i * 0.005, comment: "m" + i });
    A.addMarkers({ comp_id: comp.id, markers: markers.slice(0, 500), expect: GUARD });
    A.addMarkers({ comp_id: comp.id, markers: markers.slice(500), expect: GUARD });
    expect(prop.numKeys).toBe(700);
    const r = A.removeMarkers({ comp_id: comp.id, all: true, expect: GUARD });
    expect(r.removed.length).toBe(500);
    expect(r.removed_count).toBe(700);
    expect(r.removed_truncated).toBe(true);
    expect(r.removed[0].comment).toBe("m0");
    expect(prop.numKeys).toBe(0);
  });
});

describe("speaker prefixes (C62, C63)", () => {
  const cue = (n: number, text: string) => `${n}\n00:00:0${n},000 --> 00:00:0${n},900\n${text}\n`;
  const srt = (...lines: string[]) => lines.map((l, i) => cue(i + 1, l)).join("\n");

  it("keeps the text of an ordinary 'Note:' or 'Step 1:' sentence", () => {
    const s = parseTranscript(srt("Remember: always save first", "Step 1: open the comp"));
    expect(s.map((x) => [x.text, x.speaker])).toEqual([
      ["Remember: always save first", undefined],
      ["Step 1: open the comp", undefined],
    ]);
    expect(transcriptCues(s).every((c) => c.label === undefined)).toBe(true);
  });

  it("still reads ALL CAPS names, even once", () => {
    expect(parseTranscript(srt("ANNA: Hi.", "Plain line.")).map((x) => [x.text, x.speaker])).toEqual([
      ["Hi.", "ANNA"],
      ["Plain line.", undefined],
    ]);
  });

  it("reads mixed-case names that repeat across most cues, but not a stray 'Note:' among them", () => {
    const s = parseTranscript(srt("Anna: Hello.", "Ben: Hi.", "Anna: How are you?", "Note: this was cut", "Ben: Fine."));
    expect(s.map((x) => [x.text, x.speaker])).toEqual([
      ["Hello.", "Anna"],
      ["Hi.", "Ben"],
      ["How are you?", "Anna"],
      ["Note: this was cut", undefined],
      ["Fine.", "Ben"],
    ]);
  });

  it("does not read mixed-case names when only a few cues carry a prefix", () => {
    const s = parseTranscript(srt("Anna: one", "Anna: two", "plain", "plain too", "and more"));
    expect(s.every((x) => x.speaker === undefined)).toBe(true);
  });
});

describe("addMarkers on the host (N02, C23)", () => {
  function setup() {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const { A } = loadHost(project, ["layers.jsx", "markers.jsx"]);
    return { project, comp, A };
  }

  it("scales the duration by the stretch for layer-relative markers, and leaves comp markers alone", () => {
    const { comp, A } = setup();
    A.createLayer({ comp_id: comp.id, type: "solid", name: "VO", expect: GUARD });
    const vo = comp.layer("VO")!;
    vo.startTime = 2;
    vo.stretch = 50;
    const r = A.addMarkers({ comp_id: comp.id, layer: { name: "VO" }, markers: [{ time: 1, comment: "hi", duration: 2, label: 4 }], relative_to: "layer", expect: GUARD });
    expect(r.placed[0]).toMatchObject({ time: 2.5, duration: 1, label: 4 });
    expect(A.listMarkers({ comp_id: comp.id, layer: { name: "VO" } }).markers[0].duration).toBe(1);
    const c = A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "c", duration: 2 }], expect: GUARD });
    expect(c.placed[0].duration).toBe(2);
    expect(c.frame_duration).toBeGreaterThan(0);
  });

  it("refuses unusable markers before opening the undo group, so nothing is placed", () => {
    const { comp, A } = setup();
    const prop = comp.markerProperty as FakeProperty;
    expect(() =>
      A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "ok" }, { time: Infinity, comment: "bad" }], expect: GUARD })
    ).toThrow();
    expect(prop.numKeys).toBe(0);
    expect(() =>
      A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "ok" }, { time: 2, duration: -1 }], expect: GUARD })
    ).toThrow();
    expect(prop.numKeys).toBe(0);
  });
});

describe("expect schema description keeps the guard wording", () => {
  it("add and remove markers describe expect with the guard text", () => {
    for (const s of [AeAddMarkersSchema, AeRemoveMarkersSchema]) {
      const js = zodToJsonSchema(s) as { properties?: Record<string, { description?: string }> };
      const desc = js.properties?.expect?.description ?? "";
      expect(desc).toContain("Target guard verified before any mutation runs");
      expect(desc).toContain("Required unless dry_run.");
    }
  });
});

// ---------- editMarkers and the AE 16.0 marker fields ----------

/** The MarkerValue members this fake lacks (AE 16.0+); returns a function that takes them away again. */
function modernMarkers() {
  const proto = MarkerValue.prototype as any;
  const store = new WeakMap<object, Record<string, string>>();
  const added: Record<string, unknown> = { frameTarget: "", eventCuePoint: false, protectedRegion: false };
  Object.assign(proto, added);
  proto.getParameters = function () {
    return { ...(store.get(this) ?? {}) };
  };
  proto.setParameters = function (p: Record<string, string>) {
    store.set(this, { ...p });
  };
  return () => {
    for (const k of [...Object.keys(added), "getParameters", "setParameters"]) delete proto[k];
  };
}

describe("editMarkers on the host", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  function setup(modern = true) {
    if (modern) restore = modernMarkers();
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 10);
    comp.frameRate = 25;
    const { A, undo } = loadHost(project, ["layers.jsx", "markers.jsx"]);
    return { project, comp, A, undo, prop: comp.markerProperty as FakeProperty };
  }
  const full = {
    time: 1,
    comment: "hello",
    duration: 0.5,
    label: 3,
    chapter: "Ch 1",
    url: "https://example.com",
    frame_target: "_blank",
    cue_point_name: "cp",
    event_cue_point: true,
    protected_region: true,
    params: { a: "1", b: "two" },
  };
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));

  it("adds the new marker fields and lists them back in snake_case", () => {
    const { comp, A } = setup();
    const r = json(A.addMarkers({ comp_id: comp.id, markers: [full, { time: 5, comment: "plain" }], expect: GUARD }));
    expect(r.placed[0]).toMatchObject({ protected_region: true, frame_target: "_blank", cue_point_name: "cp", event_cue_point: true, params: { a: "1", b: "two" } });
    const l = json(A.listMarkers({ comp_id: comp.id }));
    expect(l.markers[0]).toMatchObject({ comment: "hello", chapter: "Ch 1", frame_target: "_blank", cue_point_name: "cp", event_cue_point: true, protected_region: true, params: { a: "1", b: "two" } });
    // The older camelCase fields stay.
    expect(l.markers[0]).toMatchObject({ cuePointName: "cp", protectedRegion: true });
    expect(l.markers[1]).toEqual({ index: 2, time: 5, duration: 0, comment: "plain", label: 0 });
  });

  it("refuses a protected region on a layer marker, and a field this AE lacks, before placing anything", () => {
    const { comp, A, prop } = setup();
    A.createLayer({ comp_id: comp.id, type: "solid", name: "VO", expect: GUARD });
    expect(() => A.addMarkers({ comp_id: comp.id, layer: { name: "VO" }, markers: [{ time: 1, protected_region: true }], expect: GUARD })).toThrow(/composition markers only/);
    expect(() => A.addMarkers({ comp_id: comp.id, markers: [{ time: 1 }, { time: 2, params: { a: { x: 1 } } }], expect: GUARD })).toThrow(/params\.a/);
    expect(prop.numKeys).toBe(0);
    restore?.();
    restore = undefined;
    expect(() => A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, protected_region: true }], expect: GUARD })).toThrow(/no MarkerValue\.protectedRegion/);
    expect(() => A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, params: { a: "1" } }], expect: GUARD })).toThrow(/setParameters/);
    // Without the new fields the old call still works.
    expect(json(A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "ok" }], expect: GUARD })).placed).toHaveLength(1);
  });

  it("changes one field and keeps every other, in place", () => {
    const { comp, A, undo } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [full, { time: 5, comment: "other" }], expect: GUARD });
    const begun = undo.begun;
    const r = json(A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, set: { comment: "changed" } }], expect: GUARD }));
    expect(undo.begun).toBe(begun + 1);
    expect(r.edits[0]).toMatchObject({ index: 1, from: 1, to: 1, moved: false });
    expect(r.edits[0].fields).toMatchObject({
      comment: "changed",
      duration: 0.5,
      label: 3,
      chapter: "Ch 1",
      url: "https://example.com",
      frame_target: "_blank",
      cue_point_name: "cp",
      event_cue_point: true,
      protected_region: true,
      params: { a: "1", b: "two" },
    });
    const l = json(A.listMarkers({ comp_id: comp.id }));
    expect(l.numMarkers).toBe(2);
    expect(l.markers[0]).toMatchObject({ comment: "changed", duration: 0.5, label: 3, chapter: "Ch 1", protected_region: true, params: { a: "1", b: "two" } });
    expect(l.markers[1].comment).toBe("other");
  });

  it("keeps every cue point parameter of a marker it edits, past 50 entries and 2000 characters", () => {
    const { comp, A, prop } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "cp" }, { time: 5, comment: "other" }], expect: GUARD });
    const params: Record<string, string> = {};
    for (let i = 0; i < 60; i++) params["k" + (i < 10 ? "0" : "") + i] = "v" + i;
    params.long = "x".repeat(3000);
    (prop as any).keyValue(1).setParameters(params);
    A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, set: { comment: "changed" } }], expect: GUARD });
    const kept = (prop as any).keyValue(1).getParameters();
    expect(Object.keys(kept)).toHaveLength(61);
    expect(kept.long).toHaveLength(3000);
    A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 2 }], expect: GUARD });
    const moved = (prop as any).keyValue(1).getParameters();
    expect(Object.keys(moved)).toHaveLength(61);
    expect(moved.long).toHaveLength(3000);
  });

  it("moves a marker with every field, by index and by time, and the old time is empty", () => {
    const { comp, A } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [full, { time: 5, comment: "other" }, { time: 8, comment: "last" }], expect: GUARD });
    const r = json(A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 6 }, { time: 8, move_to: 2, set: { label: 7 } }], expect: GUARD }));
    expect(r.edits.map((e: { from: number; to: number; moved: boolean }) => [e.from, e.to, e.moved])).toEqual([
      [1, 6, true],
      [8, 2, true],
    ]);
    const l = json(A.listMarkers({ comp_id: comp.id }));
    expect(l.markers.map((m: { time: number; comment: string }) => [m.time, m.comment])).toEqual([
      [2, "last"],
      [5, "other"],
      [6, "hello"],
    ]);
    expect(l.markers[2]).toMatchObject({ duration: 0.5, label: 3, chapter: "Ch 1", url: "https://example.com", frame_target: "_blank", protected_region: true, params: { a: "1", b: "two" } });
    expect(l.markers[0].label).toBe(7);
  });

  it("lets two markers swap places, and refuses a move onto a marker that stays", () => {
    const { comp, A } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "a" }, { time: 2, comment: "b" }], expect: GUARD });
    expect(() => A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 2 }], expect: GUARD })).toThrow(/Two markers would end up/);
    A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 2 }, { index: 2, move_to: 1 }], expect: GUARD });
    expect(json(A.listMarkers({ comp_id: comp.id })).markers.map((m: { comment: string }) => m.comment)).toEqual(["b", "a"]);
  });

  it("plans in a dry run without a guard or an undo group, and returns no_op for nothing to do", () => {
    const { comp, A, undo, prop } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "a" }], expect: GUARD });
    const begun = undo.begun;
    const plan = json(A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 4 }], dry_run: true }));
    expect(plan).toMatchObject({ dry_run: true, changed: true, edits: [{ index: 1, from: 1, to: 4, moved: true }] });
    expect(prop.keyTime(1)).toBe(1);
    const same = json(A.editMarkers({ comp_id: comp.id, edits: [{ index: 1, move_to: 1 }], expect: GUARD }));
    expect(same.no_op).toBe(true);
    expect(undo.begun).toBe(begun);
  });

  it("validates everything before the undo group", () => {
    const { comp, A, undo, prop } = setup();
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "a" }, { time: 2, comment: "b" }], expect: GUARD });
    const begun = undo.begun;
    const e = (edits: unknown[], extra: object = {}) => () => A.editMarkers({ comp_id: comp.id, edits, expect: GUARD, ...extra });
    expect(e([{ index: 3, set: { comment: "x" } }])).toThrow(/out of range/);
    expect(e([{ set: { comment: "x" } }])).toThrow(/index or time/);
    expect(e([{ index: 1, time: 1, set: { comment: "x" } }])).toThrow(/index or time/);
    expect(e([{ time: 1.5, set: { comment: "x" } }])).toThrow(/no marker at/);
    expect(e([{ index: 1 }])).toThrow(/nothing to change/);
    expect(e([{ index: 1, set: { comment: "x" } }, { index: 1, move_to: 5 }])).toThrow(/edited twice/);
    expect(e([{ index: 1, set: { duration: -1 } }])).toThrow(/bad duration/);
    expect(e([{ index: 1, set: { label: 20 } }])).toThrow(/label/);
    expect(e([{ index: 1, move_to: 99999 }])).toThrow(/AE can't use/);
    expect(e([{ index: 1, set: { comment: "x" } }], { expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(e([])).toThrow(/No edits/);
    expect(prop.numKeys).toBe(2);
    expect(undo.begun).toBe(begun);
  });

  it("refuses a protected region on a layer's markers and reads layer times with relative_to", () => {
    const { comp, A } = setup();
    A.createLayer({ comp_id: comp.id, type: "solid", name: "VO", expect: GUARD });
    const vo = comp.layer("VO")!;
    vo.startTime = 2;
    vo.stretch = 50;
    A.addMarkers({ comp_id: comp.id, layer: { name: "VO" }, markers: [{ time: 1, comment: "hi", duration: 2 }], relative_to: "layer", expect: GUARD });
    expect(() => A.editMarkers({ comp_id: comp.id, layer: { name: "VO" }, edits: [{ index: 1, set: { protected_region: true } }], expect: GUARD })).toThrow(/composition markers only/);
    const r = json(A.editMarkers({ comp_id: comp.id, layer: { name: "VO" }, relative_to: "layer", edits: [{ time: 1, move_to: 3, set: { duration: 4 } }], expect: GUARD }));
    expect(r.edits[0]).toMatchObject({ from: 2.5, to: 3.5, moved: true });
    expect(r.edits[0].fields.duration).toBe(2);
  });
});
