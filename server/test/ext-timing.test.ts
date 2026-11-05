/**
 * ae_timing_check: the pure checks (reading time, dead stretches, silent film,
 * facts), timing.jsx run under node:vm against the simulated AE DOM, and the
 * whole tool against a fake bridge that answers the host calls from that DOM and
 * writes real PNGs where a frame is asked for.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMotionSpec } from "../src/motion-spec.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeTimingCheckSchema,
  analyzeTiming,
  extractNames,
  extractNumbers,
  opacityVisible,
  timingTools,
  unapprovedTokens,
  type HostTiming,
  type TimingCheck,
} from "../src/tools/ext/timing.js";
import { FakeLayer, FakeProject, FileSource, Shape, TextDocument, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = timingTools.find((t) => t.name === "ae_timing_check")!;

// ---------- scene helpers ----------

function scene(duration = 10) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, duration) as FakeComp;
  return { project, comp };
}

function text(comp: FakeComp, content: string, inS: number, outS: number): FakeLayer {
  const l = comp.layers.addText(content) as FakeLayer;
  l.inPoint = inS;
  l.outPoint = outS;
  return l;
}

function still(project: FakeProject, comp: FakeComp, name = "Still"): FakeLayer {
  const item = project.addFootage(name, 100, 100, Object.assign(new FileSource(), { isStill: true }));
  return comp.layers.add(item) as FakeLayer;
}

function video(project: FakeProject, comp: FakeComp, name = "Clip"): FakeLayer {
  const item = project.addFootage(name, 100, 100, Object.assign(new FileSource(), { isStill: false }));
  (item as any).duration = 5;
  return comp.layers.add(item) as FakeLayer;
}

function readHost(project: FakeProject, comp: FakeComp, extra: Record<string, unknown> = {}): HostTiming {
  const { A } = loadHost(project, ["timing.jsx"], extra);
  return JSON.parse(JSON.stringify(A.timingRead({ comp_id: comp.id })));
}

const ALL = new Set<TimingCheck>(["unread_lines", "dead_stretches", "first_frame", "silent_film", "facts"]);
const run = (host: HostTiming, spec = resolveMotionSpec(null), checks: Set<TimingCheck> = ALL, range?: [number, number]) =>
  analyzeTiming(host, spec, checks, range ?? [0, host.comp.duration_s]);

const kinds = (f: { findings: Array<{ check: string }> }) => f.findings.map((x) => x.check);

// ---------- unread lines ----------

describe("unread_lines", () => {
  it("flags a line shorter than 0.5 s + 0.3 s per word and reports needed against actual", () => {
    const { project, comp } = scene(8);
    text(comp, "Hello there friend", 0, 1);
    text(comp, "Buy now", 1, 6);
    const out = run(readHost(project, comp));
    const f = out.findings.filter((x) => x.check === "unread_lines");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatchObject({ on_screen_s: 1, needed_s: 1.4, words: 3, is_last: false });
    expect(f[0].severity).toBe("P1");
    expect(f[0].layers[0].name).toBe("Hello there friend");
    expect(f[0].start_frame).toBe(0);
    expect(f[0].end_frame).toBe(25);
    expect(f[0].fix).toMatch(/longer/);
  });

  it("is P0 when the line has under half the time it needs", () => {
    const { project, comp } = scene(8);
    text(comp, "Hello there friend", 0, 0.5);
    text(comp, "Buy now", 1, 6);
    expect(run(readHost(project, comp)).findings.find((x) => x.check === "unread_lines")!.severity).toBe("P0");
  });

  it("passes lines that are held long enough", () => {
    const { project, comp } = scene(8);
    text(comp, "Hello there friend", 0, 2);
    text(comp, "Buy now", 2, 6);
    const out = run(readHost(project, comp));
    expect(out.findings.filter((x) => x.check === "unread_lines")).toEqual([]);
    expect(out.reports.every((r) => r.ok)).toBe(true);
  });

  it("holds the last line to last_line_s", () => {
    const { project, comp } = scene(8);
    text(comp, "Buy now", 0, 1.5);
    const f = run(readHost(project, comp)).findings.find((x) => x.check === "unread_lines")!;
    expect(f.detail).toMatchObject({ needed_s: 2, is_last: true });
  });

  it("counts only the time Opacity is above the floor", () => {
    const { project, comp } = scene(8);
    const l = text(comp, "one two three four five six", 0, 3);
    l.transform("ADBE Opacity").setValueAtTime(0, 0);
    l.transform("ADBE Opacity").setValueAtTime(2, 100);
    text(comp, "Buy now", 3, 7);
    const out = run(readHost(project, comp));
    const r = out.reports.find((x) => x.text.startsWith("one"))!;
    // Visible from 5 % of the 2 s fade (0.1 s) to the out point.
    expect(r.on_screen_s).toBeCloseTo(2.9, 3);
    expect(r.ok).toBe(true);
    expect(opacityVisible({ value: 100, keys: [{ t: 0, v: 0 }, { t: 2, v: 100 }] }, 0, 3)[0][0]).toBeCloseTo(0.1, 6);
  });

  it("skips a layer that is transparent, switched off or soloed out", () => {
    const { project, comp } = scene(8);
    text(comp, "invisible", 0, 0.2).transform("ADBE Opacity").setValue(0);
    text(comp, "off", 0, 0.2).enabled = false;
    text(comp, "Buy now", 0, 6);
    expect(run(readHost(project, comp)).reports.map((r) => r.text)).toEqual(["Buy now"]);
    const solo = text(comp, "soloed", 0, 6);
    solo.solo = true;
    expect(run(readHost(project, comp)).reports.map((r) => r.text)).toEqual(["soloed"]);
  });

  it("makes each Source Text key its own line with its own span", () => {
    const { project, comp } = scene(8);
    const l = text(comp, "One", 0, 6);
    const doc = (l.property("ADBE Text Properties") as any).property("ADBE Text Document");
    doc.setValueAtTime(0, new TextDocument("One"));
    doc.setValueAtTime(0.5, new TextDocument("Two words here now"));
    const out = run(readHost(project, comp));
    expect(out.reports.map((r) => [r.text, r.start_s, r.end_s, r.is_last])).toEqual([
      ["One", 0, 0.5, false],
      ["Two words here now", 0.5, 6, true],
    ]);
    const f = out.findings.filter((x) => x.check === "unread_lines");
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('"One"');
  });

  it("takes the thresholds from the spec", () => {
    const { project, comp } = scene(8);
    text(comp, "Hello there friend", 0, 2);
    text(comp, "Buy now", 2, 6);
    const host = readHost(project, comp);
    expect(run(host, undefined, new Set<TimingCheck>(["unread_lines"])).findings).toEqual([]);
    const slow = resolveMotionSpec({ reading: { per_word_s: 1, base_s: 0.5 } });
    const f = run(host, slow, new Set<TimingCheck>(["unread_lines"])).findings;
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatchObject({ needed_s: 3.5, on_screen_s: 2 });
  });
});

// ---------- dead stretches ----------

describe("dead_stretches", () => {
  const only = new Set<TimingCheck>(["dead_stretches"]);

  it("flags a still that fades in and then just sits", () => {
    const { project, comp } = scene(10);
    const s = still(project, comp);
    s.transform("ADBE Opacity").setValueAtTime(0, 0);
    s.transform("ADBE Opacity").setValueAtTime(1, 100);
    const out = run(readHost(project, comp), undefined, only);
    expect(out.stretches).toHaveLength(1);
    expect(out.stretches[0].start_s).toBeCloseTo(1, 6);
    expect(out.stretches[0].end_s).toBe(10);
    const f = out.findings[0];
    expect(f.check).toBe("dead_stretches");
    expect(f.severity).toBe("P0");
    expect(f.layers[0].name).toBe("Still");
    expect(f.end_frame).toBe(250);
  });

  it("does not flag when keyframes keep coming within the limit", () => {
    const { project, comp } = scene(10);
    const s = still(project, comp);
    const pos = s.transform("ADBE Position");
    for (let i = 0; i <= 4; i++) pos.setValueAtTime(i * 2.5, [100 + i * 50, 100, 0]);
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
  });

  it("ignores keyframe segments whose values do not change", () => {
    const { project, comp } = scene(10);
    const s = still(project, comp);
    const pos = s.transform("ADBE Position");
    pos.setValueAtTime(0, [100, 100, 0]);
    pos.setValueAtTime(5, [100, 100, 0]);
    pos.setValueAtTime(9, [100, 100, 0]);
    const out = run(readHost(project, comp), undefined, only);
    expect(out.stretches).toHaveLength(1);
    expect(out.stretches[0].length_s).toBe(10);
  });

  it("counts playing video, but not stills or solids", () => {
    const { project, comp } = scene(10);
    video(project, comp);
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
    const b = scene(10);
    still(b.project, b.comp);
    b.comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1);
    expect(run(readHost(b.project, b.comp), undefined, only).findings).toHaveLength(1);
  });

  it("counts a precomp that animates, not one that doesn't", () => {
    const moving = scene(10);
    const innerA = moving.project.addComp("Inner", 640, 360, 10) as FakeComp;
    const il = innerA.layers.addNull() as FakeLayer;
    il.transform("ADBE Rotate Z").setValueAtTime(0, 0);
    il.transform("ADBE Rotate Z").setValueAtTime(5, 90);
    moving.comp.layers.add(innerA);
    expect(run(readHost(moving.project, moving.comp), undefined, only).findings).toEqual([]);

    const calm = scene(10);
    const innerB = calm.project.addComp("Inner", 640, 360, 10) as FakeComp;
    innerB.layers.addSolid([1, 0, 0], "Red", 640, 360, 1);
    calm.comp.layers.add(innerB);
    expect(run(readHost(calm.project, calm.comp), undefined, only).findings).toHaveLength(1);
  });

  it("treats a layer boundary or a text change as a change", () => {
    const { project, comp } = scene(10);
    still(project, comp).outPoint = 4;
    const b = still(project, comp, "B");
    b.inPoint = 4;
    const out = run(readHost(project, comp), undefined, only);
    // 0-4 and 4-10: the cut at 4 splits them, but both stretches are still over 3 s.
    expect(out.stretches.map((s) => [s.start_s, s.end_s])).toEqual([[0, 4], [4, 10]]);
    const t = text(comp, "Hello", 0, 10);
    const doc = (t.property("ADBE Text Properties") as any).property("ADBE Text Document");
    for (const [time, s] of [[0, "A"], [2.5, "B"], [5, "C"], [7.5, "D"]] as const) doc.setValueAtTime(time, new TextDocument(s));
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
  });

  it("honours dead_stretch_s from the spec and the checked range", () => {
    const { project, comp } = scene(10);
    still(project, comp);
    const host = readHost(project, comp);
    expect(run(host, resolveMotionSpec({ dead_stretch_s: 12 }), only).findings).toEqual([]);
    expect(run(host, resolveMotionSpec({ dead_stretch_s: 5 }), only, [0, 4]).findings).toEqual([]);
    expect(run(host, resolveMotionSpec({ dead_stretch_s: 5 }), only, [2, 9]).findings).toHaveLength(1);
  });

  it("does not count motion in a layer that is not showing", () => {
    const { project, comp } = scene(10);
    still(project, comp);
    const hidden = still(project, comp, "Hidden");
    hidden.transform("ADBE Opacity").setValue(0);
    hidden.transform("ADBE Position").setValueAtTime(0, [0, 0, 0]);
    hidden.transform("ADBE Position").setValueAtTime(9, [100, 0, 0]);
    expect(run(readHost(project, comp), undefined, only).stretches).toHaveLength(1);
  });
});

// ---------- silent film ----------

describe("silent_film", () => {
  const only = new Set<TimingCheck>(["silent_film"]);

  it("flags a long comp with no audio layer", () => {
    const { project, comp } = scene(20);
    still(project, comp);
    const out = run(readHost(project, comp), undefined, only);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ check: "silent_film", severity: "P1", start_s: 0, end_s: 20 });
  });

  it("passes with an audio layer that is on, fails when it is off or muted", () => {
    const { project, comp } = scene(20);
    const a = video(project, comp, "Music");
    a.hasAudio = true;
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
    a.audioEnabled = false;
    expect(run(readHost(project, comp), undefined, only).findings).toHaveLength(1);
    a.audioEnabled = true;
    a.group.property("ADBE Audio Group");
    const host = readHost(project, comp);
    host.layers.find((l) => l.name === "Music")!.audio_muted = true;
    expect(run(host, undefined, only).findings).toHaveLength(1);
  });

  it("allows up to 15 s of silence", () => {
    const { project, comp } = scene(15);
    still(project, comp);
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
  });
});

// ---------- facts ----------

describe("facts", () => {
  const facts = ["£4.99", "Aurora Pro", "2026", "Chroma London"];

  it("passes numbers and names that the facts cover, ignoring case and currency signs", () => {
    expect(unapprovedTokens("Aurora Pro from £4.99 in 2026", facts)).toEqual([]);
    expect(unapprovedTokens("aurora pro only 4.99", facts)).toEqual([]);
    expect(unapprovedTokens("Made by Chroma London", facts)).toEqual([]);
  });

  it("flags a number or a Capitalised name that no fact covers", () => {
    expect(unapprovedTokens("Aurora Pro from £5.99", facts)).toEqual([{ text: "£5.99", kind: "number" }]);
    expect(unapprovedTokens("Meet Aurora Max today", facts)).toEqual([{ text: "Aurora Max", kind: "name" }]);
    expect(unapprovedTokens("50% off, 3 left", facts).map((t) => t.text)).toEqual(["50%", "3"]);
  });

  it("is conservative: not 3D or 4K, not all caps, not a four-word headline, not a lone capitalised word", () => {
    expect(extractNumbers("Shot in 4K 3D with H264, 2nd take").map((n) => n.text)).toEqual([]);
    expect(extractNumbers("1,000 users and £2m, 12.5% up").map((n) => n.text)).toEqual(["1,000", "£2m", "12.5%"]);
    expect(extractNames("BUY NOW AT ACME STORE")).toEqual([]);
    expect(extractNames("Our New Product Launch Event")).toEqual([]);
    expect(extractNames("Available in London")).toEqual([]);
    expect(extractNames("Bank of America and Jane Doe")).toEqual(["Bank of America", "Jane Doe"]);
    expect(extractNames("Introducing Aurora Pro")).toEqual(["Aurora Pro"]);
  });

  it("reports per visible line with its time range, and does nothing without a facts list", () => {
    const { project, comp } = scene(8);
    text(comp, "Aurora Max from £5.99", 1, 5);
    const host = readHost(project, comp);
    const only = new Set<TimingCheck>(["facts"]);
    expect(run(host, resolveMotionSpec(null), only).findings).toEqual([]);
    const out = run(host, resolveMotionSpec({ facts }), only);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ check: "facts", severity: "P0", start_s: 1, end_s: 5, start_frame: 25, end_frame: 125 });
    expect(out.findings[0].detail!.unapproved).toEqual([
      { text: "£5.99", kind: "number" },
      { text: "Aurora Max", kind: "name" },
    ]);
  });

  it("ignores text that is never visible", () => {
    const { project, comp } = scene(8);
    text(comp, "Aurora Max £9", 1, 5).enabled = false;
    expect(run(readHost(project, comp), resolveMotionSpec({ facts }), new Set<TimingCheck>(["facts"])).findings).toEqual([]);
  });
});

// ---------- timing.jsx ----------

describe("timing.jsx", () => {
  it("reads kinds, switches, spans, hold-key moments and text keys, and changes nothing", () => {
    const { project, comp } = scene(10);
    const t = text(comp, "Hi", 1, 9);
    const doc = (t.property("ADBE Text Properties") as any).property("ADBE Text Document");
    doc.setValueAtTime(1, new TextDocument("Hi"));
    doc.setValueAtTime(4, new TextDocument("There"));
    const pos = t.transform("ADBE Position");
    pos.setValueAtTime(1, [0, 0, 0]);
    pos.setValueAtTime(2, [50, 0, 0]);
    const s = still(project, comp);
    s.transform("ADBE Scale").setValueAtTime(0, [100, 100, 100]);
    s.transform("ADBE Scale").setValueAtTime(3, [100, 100, 100]);
    const n = comp.layers.addNull() as FakeLayer;
    n.guideLayer = true;
    const { A, undo } = loadHost(project, ["timing.jsx"]);
    const out = JSON.parse(JSON.stringify(A.timingRead({ comp_id: comp.id }))) as HostTiming;
    expect(undo.begun).toBe(0);
    expect(out.comp).toMatchObject({ name: "Main", duration_s: 10, frame_rate: 25, work_area_start_s: 0, work_area_duration_s: 10 });
    const by = (name: string) => out.layers.find((l) => l.name === name)!;
    expect(by("Hi")).toMatchObject({ kind: "text", in_s: 1, out_s: 9, spans: [[1, 2]], text_keys: [{ t: 1, text: "Hi" }, { t: 4, text: "There" }] });
    expect(by("Still")).toMatchObject({ kind: "footage", video_playing: false, spans: [] });
    expect(by("Null 1")).toMatchObject({ kind: "null", guide: true });
  });

  it("refuses a missing comp", () => {
    const { project } = scene();
    const { A } = loadHost(project, ["timing.jsx"]);
    expect(() => A.timingRead({ comp_id: 99999 })).toThrow(/No CompItem/);
    expect(() => A.timingRead({})).toThrow(/active item/);
  });
});

// ---------- the tool ----------

function writePng(file: string, fn: (x: number, y: number) => [number, number, number, number]) {
  const png = new PNG({ width: 20, height: 12 });
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 20; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * 20 + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

interface Rig {
  project: FakeProject;
  comp: FakeComp;
  brief?: Record<string, unknown>;
  frame?: "blank" | "black" | "transparent" | "picture" | "varying";
}

function bridge(rig: Rig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-timing-q-"));
  tmpDirs.push(dir);
  const projectPath = path.join(dir, "film.aep");
  if (rig.brief) fs.writeFileSync(path.join(dir, "film.brief.json"), JSON.stringify(rig.brief));
  const { A } = loadHost(rig.project, ["timing.jsx"]);
  const calls: Array<{ fn: string; script: string }> = [];
  let renders = 0;
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "status") return ok({ project_path: rig.brief ? projectPath : "" });
      if (fn === "timingRead") {
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
        return ok(JSON.parse(JSON.stringify(A.timingRead(args))));
      }
      if (fn === "snapshotFrame") {
        renders++;
        const out = JSON.parse(`"${/"output_path":"([^"]+)"/.exec(script)![1]}"`) as string;
        const kind = rig.frame ?? "picture";
        const n = renders;
        writePng(out, (x, y) => {
          if (kind === "blank") return [90, 90, 90, 255];
          if (kind === "black") return [0, 0, 0, 255];
          if (kind === "transparent") return [0, 0, 0, 0];
          if (kind === "varying") return [(n * 60) % 256, 40, 40, 255];
          return x < 10 && y < 6 ? [255, 255, 255, 255] : [30, 30, 30, 255];
        });
        return ok({ path: out });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn) };
}

const call = async (rig: Rig, args: Record<string, unknown> = {}) => {
  const b = bridge(rig);
  const out = (await tool.handler(AeTimingCheckSchema.parse({ comp_id: rig.comp.id, ...args }), b.ctx)) as Record<string, any>;
  return { out, ...b };
};

function messyScene() {
  const { project, comp } = scene(20);
  still(project, comp);
  text(comp, "Hello there friend", 0, 1);
  text(comp, "Aurora Max £5.99", 1, 6);
  return { project, comp };
}

describe("ae_timing_check", () => {
  it("is registered", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_timing_check")).toBe(true);
    expect(() => AeTimingCheckSchema.parse({ start_s: 5, end_s: 2 })).toThrow(/after start_s/);
    expect(() => AeTimingCheckSchema.parse({ checks: ["nope"] })).toThrow();
  });

  it("runs every check, sorts P0 first, and reports the spec used", async () => {
    const { project, comp } = messyScene();
    const { out, fns } = await call({
      project,
      comp,
      frame: "black",
      brief: { motion: { register: "energetic", facts: ["Aurora Pro"], dead_stretch_s: 4, reading: { per_word_s: 0.3 } } },
    });
    expect(out.ok).toBe(true);
    expect(out.read_only).toBe(true);
    expect(out.checks_run).toEqual(["unread_lines", "dead_stretches", "first_frame", "silent_film", "facts"]);
    expect(out.spec.register).toBe("energetic");
    expect(out.spec.from_brief).toEqual(expect.arrayContaining(["facts", "dead_stretch_s", "reading"]));
    expect(out.spec.thresholds).toMatchObject({ dead_stretch_s: 4, silent_film_after_s: 15, facts: 1 });
    expect(out.spec.thresholds.reading).toMatchObject({ base_s: 0.5, per_word_s: 0.3, last_line_s: 2 });
    expect(out.spec.brief_path).toContain("film.brief.json");
    const checks = out.findings.map((f: any) => f.check);
    expect(checks).toEqual(expect.arrayContaining(["unread_lines", "dead_stretches", "first_frame", "silent_film", "facts"]));
    const rank = out.findings.map((f: any) => ({ P0: 0, P1: 1, P2: 2 })[f.severity as string]);
    expect(rank).toEqual([...rank].sort((a: number, b: number) => a - b));
    expect(out.verdict).toBe("issues");
    expect(out.counts.P0).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(typeof f.start_frame).toBe("number");
      expect(typeof f.fix).toBe("string");
    }
    expect(out.first_frame).toMatchObject({ time_s: 0, flags: expect.arrayContaining(["black"]) });
    expect(fns()).toEqual(["status", "timingRead", "snapshotFrame"]);
  });

  it("falls back to brand_film defaults with no brief", async () => {
    const { project, comp } = messyScene();
    const { out } = await call({ project, comp, frame: "picture" }, { checks: ["dead_stretches"] });
    expect(out.spec).toMatchObject({ register: "brand_film", from_brief: [], brief_path: null });
    expect(out.spec.thresholds.dead_stretch_s).toBe(3);
  });

  it("renders only for first_frame, and flags blank, black and transparent but not a picture", async () => {
    for (const frame of ["blank", "black", "transparent"] as const) {
      const { project, comp } = messyScene();
      const { out } = await call({ project, comp, frame }, { checks: ["first_frame"] });
      const f = out.findings.find((x: any) => x.check === "first_frame");
      expect(f, frame).toBeTruthy();
      expect(f.severity).toBe("P0");
      expect(f.start_s).toBe(0);
    }
    const { project, comp } = messyScene();
    const ok = await call({ project, comp, frame: "picture" }, { checks: ["first_frame"] });
    expect(ok.out.findings).toEqual([]);
    expect(ok.out.first_frame.flags).toEqual([]);
    const nr = await call({ project, comp }, { checks: ["unread_lines", "dead_stretches", "silent_film", "facts"] });
    expect(nr.fns()).not.toContain("snapshotFrame");
  });

  it("renders the first frame at the work area start", async () => {
    const { project, comp } = messyScene();
    comp.workAreaStart = 2;
    comp.workAreaDuration = 6;
    const { out, calls } = await call({ project, comp, frame: "picture" }, { checks: ["first_frame"] });
    expect(out.range_s).toEqual([2, 8]);
    expect(calls.find((c) => c.fn === "snapshotFrame")!.script).toMatch(/"time":2[,}]/);
    const custom = await call({ project, comp, frame: "picture" }, { checks: ["first_frame"], start_s: 4 });
    expect(custom.out.range_s[0]).toBe(4);
    expect(custom.out.first_frame.time_s).toBe(4);
  });

  it("honours the checks list", async () => {
    const { project, comp } = messyScene();
    const { out } = await call({ project, comp }, { checks: ["silent_film"] });
    expect(out.findings.map((f: any) => f.check)).toEqual(["silent_film"]);
    expect(out.lines).toBeUndefined();
  });

  it("confirms dead stretches with frames: identical frames confirm, differing frames downgrade to P2", async () => {
    const a = messyScene();
    const same = await call({ project: a.project, comp: a.comp, frame: "picture" }, { checks: ["dead_stretches"], confirm_with_frames: true });
    const f1 = same.out.findings.find((x: any) => x.check === "dead_stretches");
    expect(f1.detail.frames_confirm).toMatchObject({ identical: true });
    expect(f1.severity).toBe("P0");
    // Two stretches (1-6 s and 6-20 s), three frames each.
    expect(same.fns().filter((f) => f === "snapshotFrame")).toHaveLength(6);

    const b = messyScene();
    const diff = await call({ project: b.project, comp: b.comp, frame: "varying" }, { checks: ["dead_stretches"], confirm_with_frames: true });
    const f2 = diff.out.findings.find((x: any) => x.check === "dead_stretches");
    expect(f2.severity).toBe("P2");
    expect(f2.detail.frames_confirm.identical).toBe(false);
  });

  it("keeps going when the first frame cannot be rendered", async () => {
    const { project, comp } = messyScene();
    const b = bridge({ project, comp });
    const orig = (b.ctx.bridge as any).evalRaw.bind(b.ctx.bridge);
    (b.ctx.bridge as any).evalRaw = async (req: any) => {
      if (String(req.script).includes("snapshotFrame")) throw new Error("render failed");
      return orig(req);
    };
    const out = (await tool.handler(AeTimingCheckSchema.parse({ comp_id: comp.id }), b.ctx)) as Record<string, any>;
    expect(out.first_frame.error).toMatch(/render failed/);
    expect(out.findings.some((f: any) => f.check === "unread_lines")).toBe(true);
  });

  it("refuses an empty range", async () => {
    const { project, comp } = messyScene();
    const { out } = await call({ project, comp }, { start_s: 30 });
    expect(out).toMatchObject({ ok: false, error: "empty_range" });
  });

  it("returns a clean verdict for a healthy comp", async () => {
    const { project, comp } = scene(10);
    video(project, comp).hasAudio = true;
    text(comp, "Buy now", 0, 9);
    const { out } = await call({ project, comp, frame: "picture" });
    expect(out.findings).toEqual([]);
    expect(out.verdict).toBe("clean");
    expect(out.lines).toHaveLength(1);
  });
});

// ---------- review fixes ----------

describe("facts: ordinary copy is not a finding", () => {
  const facts = ["£4.99", "Aurora Pro", "Chroma London"];
  const bad = (t: string) => unapprovedTokens(t, facts);

  it("ignores Title Case calls to action and sale names", () => {
    for (const t of ["Learn More", "Sign Up Today", "Black Friday", "Visit Our Store", "Get Started Now", "Discover Built Different"]) {
      expect(bad(t)).toEqual([]);
    }
  });

  it("ignores times, ratios, phone numbers, ordinals, #n, years and dates as single tokens", () => {
    for (const t of ["Doors 10:30", "Open 24/7", "Call 0800 123 4567", "We are #1", "Our 2nd store", "Since 1999", "In 2031", "Ends 31 Dec", "From March 5th", "A 16/9 frame", "Call +44 20 7946 0958"]) {
      expect(bad(t)).toEqual([]);
    }
  });

  it("still reads real numbers around them", () => {
    expect(bad("10:30 and 50% off").map((x) => x.text)).toEqual(["50%"]);
    expect(bad("Ends 31 Dec, only 3 left").map((x) => x.text)).toEqual(["3"]);
  });

  it("keeps Unicode letters in names", () => {
    expect(extractNames("Welcome to Zürich Airport")).toEqual(["Zürich Airport"]);
    expect(bad("Fly from Zürich Airport").map((x) => x.text)).toEqual(["Zürich Airport"]);
  });

  it("flags the real misses: a wrong price is P0, a near-miss name is P1", () => {
    expect(bad("Only £5.99")).toEqual([{ text: "£5.99", kind: "number" }]);
    expect(bad("Meet Aurora Max")).toEqual([{ text: "Aurora Max", kind: "name" }]);
    const only = new Set<TimingCheck>(["facts"]);
    const sp = resolveMotionSpec({ facts });
    const a = scene(8);
    text(a.comp, "Only £5.99", 1, 5);
    expect(run(readHost(a.project, a.comp), sp, only).findings[0].severity).toBe("P0");
    const b = scene(8);
    text(b.comp, "Aurora Max", 1, 5);
    expect(run(readHost(b.project, b.comp), sp, only).findings[0].severity).toBe("P1");
  });
});

describe("silent_film uses the range", () => {
  const only = new Set<TimingCheck>(["silent_film"]);
  const music = (project: FakeProject, comp: FakeComp, inS: number, outS: number) => {
    const a = video(project, comp, "Music");
    a.hasAudio = true;
    a.inPoint = inS;
    a.outPoint = outS;
    return a;
  };

  it("flags a 5 s music layer in a 30 s film, and reports the uncovered stretch", () => {
    const { project, comp } = scene(30);
    music(project, comp, 0, 5);
    const out = run(readHost(project, comp), undefined, only);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ check: "silent_film", severity: "P1", start_s: 5, end_s: 30 });
    expect(out.audioLayers).toBe(1);
  });

  it("passes with full coverage, also from two layers, and ignores audio outside the range", () => {
    const { project, comp } = scene(30);
    music(project, comp, 0, 16);
    music(project, comp, 15, 30);
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
    const o = scene(40);
    music(o.project, o.comp, 30, 40);
    const out = run(readHost(o.project, o.comp), undefined, only, [0, 25]);
    expect(out.findings).toHaveLength(1);
    expect(out.audioLayers).toBe(0);
  });

  it("allows an audio gap up to 15 s", () => {
    const { project, comp } = scene(30);
    music(project, comp, 0, 15);
    music(project, comp, 29, 30);
    expect(run(readHost(project, comp), undefined, only).findings).toEqual([]);
  });
});

describe("truncated host data", () => {
  const only = new Set<TimingCheck>(["dead_stretches"]);

  it("treats a layer whose spans were cut as changing to its out point", () => {
    const { project, comp } = scene(700);
    const s = still(project, comp);
    const pos = s.transform("ADBE Position");
    // 220 separate moves (440 keys), each 1 s long with a 2 s rest between: more than MAX_SPANS.
    for (let i = 0; i < 220; i++) {
      pos.setValueAtTime(i * 3, [i, 0, 0]);
      pos.setValueAtTime(i * 3 + 1, [i + 1, 0, 0]);
    }
    const host = readHost(project, comp);
    const l = host.layers[0];
    expect(l.truncated).toBe(true);
    expect(l.spans).toHaveLength(200);
    expect(l.change_from_s).toBeCloseTo(l.spans[199][1], 4);
    const out = run(host, undefined, only);
    expect(out.stretches).toEqual([]);
    expect(out.findings.map((f) => f.severity)).toEqual(["P2"]);
    expect(out.findings[0].message).toMatch(/read in part/);
  });

  it("caps the keys read per property", () => {
    const { project, comp } = scene(2000);
    const s = still(project, comp);
    const op = s.transform("ADBE Opacity");
    for (let i = 0; i < 600; i++) op.setValueAtTime(i, i % 2 ? 100 : 50);
    const l = readHost(project, comp).layers[0];
    expect(l.truncated).toBe(true);
    expect(l.change_from_s).toBeGreaterThan(400);
    expect(l.change_from_s).toBeLessThan(600);
  });

  it("skips dead_stretches and says so when layers were dropped", () => {
    const { project, comp } = scene(10);
    still(project, comp);
    const host = readHost(project, comp);
    host.truncated = true;
    host.layer_count = 900;
    const out = run(host, undefined, only);
    expect(out.stretches).toEqual([]);
    expect(out.deadSkipped).toBe(true);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ check: "dead_stretches", severity: "P2" });
  });
});

describe("timing.jsx value comparison", () => {
  it("does not count identical Shape or TextDocument keys as movement, but does count real changes", () => {
    const { project, comp } = scene(10);
    const s = still(project, comp);
    const mk = (s.property("ADBE Mask Parade") as any).addProperty("ADBE Mask Atom");
    const path = mk.property("ADBE Mask Shape");
    const sh = (v: number) => Object.assign(new Shape(), { vertices: [[v, 0], [10, 10]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]] });
    path.setValueAtTime(0, sh(0));
    path.setValueAtTime(2, sh(0));
    path.setValueAtTime(4, sh(5));
    expect(readHost(project, comp).layers[0].spans).toEqual([[2, 4]]);
  });
});

describe("expressions", () => {
  it("is stated in the tool description and the result notes", () => {
    expect(tool.description).toMatch(/expression marks its whole layer as changing/);
  });
});
