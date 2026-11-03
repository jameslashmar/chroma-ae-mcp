import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeFootageProxySchema,
  AeGetFootageInterpretationSchema,
  AeSetFootageInterpretationSchema,
  interpretMismatches,
  interpretTools,
  interpretationFindings,
  proxyMismatches,
  renderQueueFindings,
  type FootageInterp,
  type InterpretRead,
} from "../src/tools/ext/interpret.js";
import { FakeFootage, FakeProject, FileSource, GUARD, SolidSource, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => interpretTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-interpret-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: undefined, comp_is_valid: true }, durationMs: 1 };
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

// ---------- a fake footage source that follows AE's rules ----------

const AlphaMode = { IGNORE: 1, STRAIGHT: 2, PREMULTIPLIED: 3 };
const FieldSeparationType = { OFF: 10, UPPER_FIELD_FIRST: 11, LOWER_FIELD_FIRST: 12 };
const PulldownPhase = {
  OFF: 20,
  WSSWW_24P_ADVANCE: 21,
  SSWWW_24P_ADVANCE: 22,
  SWWWS_24P_ADVANCE: 23,
  WWWSS_24P_ADVANCE: 24,
  WWSSW_24P_ADVANCE: 25,
  WSSWW: 26,
  SSWWW: 27,
  SWWWS: 28,
  WWWSS: 29,
  WWSSW: 30,
};
const PulldownMethod = { PULLDOWN_3_2: 40, ADVANCE_24P: 41 };
const RQItemStatus = { WILL_CONTINUE: 50, NEEDS_OUTPUT: 51, UNQUEUED: 52, QUEUED: 53, RENDERING: 54, USER_STOPPED: 55, ERR_STOPPED: 56, DONE: 57 };
const GetSettingsFormat = { STRING: 60 };

class FakeSource extends FileSource {
  writes: string[] = [];
  hasAlpha = true;
  isStill = false;
  alphaMode = AlphaMode.STRAIGHT;
  invertAlpha = false;
  nativeFrameRate = 29.97;
  loop = 1;
  failOn: string | null = null;
  file: { fsName: string } | null = null;
  private fs = FieldSeparationType.OFF;
  private hq = false;
  private pd = PulldownPhase.OFF;
  private conform = 0;
  private premul = [0, 0, 0];
  private still() {
    if (this.isStill) throw new Error("Not valid for a still");
  }
  private log(what: string) {
    this.writes.push(what);
    if (this.failOn === what) {
      this.failOn = null;
      throw new Error(`forced failure at ${what}`);
    }
  }
  get fieldSeparationType() {
    this.still();
    return this.fs;
  }
  set fieldSeparationType(v: number) {
    this.still();
    if (v === FieldSeparationType.OFF && this.pd !== PulldownPhase.OFF) throw new Error("Remove the pulldown first");
    this.log("fieldSeparationType");
    this.fs = v;
  }
  get highQualityFieldSeparation() {
    this.still();
    if (this.fs === FieldSeparationType.OFF) throw new Error("Fields are off");
    return this.hq;
  }
  set highQualityFieldSeparation(v: boolean) {
    this.still();
    if (this.fs === FieldSeparationType.OFF) throw new Error("Fields are off");
    this.log("highQualityFieldSeparation");
    this.hq = v;
  }
  get removePulldown() {
    this.still();
    return this.pd;
  }
  set removePulldown(v: number) {
    this.still();
    if (v !== PulldownPhase.OFF && this.fs === FieldSeparationType.OFF) throw new Error("Turn fields on first");
    this.log("removePulldown");
    this.pd = v;
    if (v !== PulldownPhase.OFF) this.conform = 24;
  }
  get conformFrameRate() {
    this.still();
    return this.conform;
  }
  set conformFrameRate(v: number) {
    this.still();
    if (v === 0 && this.pd !== PulldownPhase.OFF) throw new Error("Pulldown is on");
    this.log("conformFrameRate");
    this.conform = v;
  }
  get displayFrameRate() {
    return this.conform || this.nativeFrameRate;
  }
  get premulColor() {
    if (this.alphaMode !== AlphaMode.PREMULTIPLIED) throw new Error("Not premultiplied");
    return this.premul;
  }
  set premulColor(v: number[]) {
    this.log("premulColor");
    this.premul = v;
  }
  guessAlphaMode() {
    this.log("guessAlphaMode");
    this.alphaMode = AlphaMode.PREMULTIPLIED;
    this.premul = [0, 0, 0];
  }
  guessPulldown(method: number) {
    this.log("guessPulldown");
    this.fs = FieldSeparationType.UPPER_FIELD_FIRST;
    this.pd = method === PulldownMethod.PULLDOWN_3_2 ? PulldownPhase.WSSWW : PulldownPhase.WSSWW_24P_ADVANCE;
    this.conform = 24;
  }
}

class ProxyFootage extends FakeFootage {
  hasVideo = true;
  pixelAspect = 1;
  useProxy = false;
  proxySource: any = null;
  setProxy(f: { fsName: string }) {
    this.useProxy = true;
    this.proxySource = Object.assign(new FileSource(), { file: { fsName: f.fsName, exists: true }, isStill: false, hasAlpha: false });
  }
  setProxyWithSequence(f: { fsName: string }, _alpha: boolean) {
    this.setProxy(f);
  }
  setProxyWithSolid(color: number[], _name: string, _w: number, _h: number, _pa: number) {
    this.useProxy = true;
    this.proxySource = Object.assign(new SolidSource(), { color });
  }
  setProxyToNone() {
    this.useProxy = false;
    this.proxySource = null;
  }
}

function scene() {
  const project = new FakeProject();
  const src = new FakeSource();
  const item = new ProxyFootage("plate.mov", 1920, 1080, src);
  item.project = project;
  item.parentFolder = project.rootFolder;
  project.all.push(item);
  const host = loadHost(project, ["interpret.jsx"]);
  Object.assign(host.G, { AlphaMode, FieldSeparationType, PulldownPhase, PulldownMethod, RQItemStatus, GetSettingsFormat });
  return { project, src, item, ...host };
}

// ---------- schemas ----------

describe("interpret schemas", () => {
  it("the set schema needs a setting and keeps guesses alone", () => {
    const parse = (v: object) => AeSetFootageInterpretationSchema.safeParse({ item_id: 1, expect: expectArg, ...v }).success;
    expect(parse({})).toBe(false);
    expect(parse({ loop: 2 })).toBe(true);
    expect(parse({ loop: 0 })).toBe(false);
    expect(parse({ conform_frame_rate: 100 })).toBe(false);
    expect(parse({ pixel_aspect: 0 })).toBe(false);
    expect(parse({ pulldown: "guess_3_2" })).toBe(true);
    expect(parse({ pulldown: "guess_3_2", conform_frame_rate: 24 })).toBe(false);
    expect(parse({ pulldown: "guess_3_2", field_separation: "off" })).toBe(false);
    expect(parse({ pulldown: "bogus" })).toBe(false);
  });

  it("the alpha block refuses contradictions", () => {
    const parse = (alpha: object) => AeSetFootageInterpretationSchema.safeParse({ item_id: 1, alpha, expect: expectArg }).success;
    expect(parse({})).toBe(false);
    expect(parse({ mode: "straight" })).toBe(true);
    expect(parse({ mode: "guess" })).toBe(true);
    expect(parse({ mode: "guess", invert: true })).toBe(false);
    expect(parse({ mode: "straight", premul_color: [0, 0, 0] })).toBe(false);
    expect(parse({ mode: "premultiplied", premul_color: [0, 0, 0] })).toBe(true);
    expect(parse({ mode: "premultiplied", premul_color: [0, 0, 2] })).toBe(false);
    expect(parse({ mode: "ignore", invert: true })).toBe(false);
  });

  it("the proxy schema ties each action to its arguments", () => {
    const parse = (v: object) => AeFootageProxySchema.safeParse({ item_ids: [1], expect: expectArg, ...v }).success;
    expect(parse({ action: "set_file" })).toBe(false);
    expect(parse({ action: "set_file", file: "C:/p.mov" })).toBe(true);
    expect(parse({ action: "set_file", file: "C:/p.mov", item_ids: [1, 2] })).toBe(false);
    expect(parse({ action: "set_solid" })).toBe(false);
    expect(parse({ action: "set_solid", solid: { color: [0, 0, 0], width: 480, height: 270 } })).toBe(true);
    expect(parse({ action: "use_off", item_ids: [1, 2, 3] })).toBe(true);
    expect(parse({ action: "use_off", file: "C:/p.mov" })).toBe(false);
    expect(parse({ action: "use_off", use_proxy: true })).toBe(false);
    expect(parse({ action: "clear", item_ids: [] })).toBe(false);
  });

  it("every mutating tool takes expect and ends with the safety guidance", () => {
    for (const name of ["ae_set_footage_interpretation", "ae_footage_proxy"]) {
      expect(tool(name).description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    }
    expect(AeSetFootageInterpretationSchema.safeParse({ item_id: 1, loop: 2 }).success).toBe(false);
    expect(AeFootageProxySchema.safeParse({ item_ids: [1], action: "use_off" }).success).toBe(false);
    expect(interpretTools.map((t) => t.name)).toEqual(["ae_get_footage_interpretation", "ae_set_footage_interpretation", "ae_footage_proxy"]);
    expect(AeGetFootageInterpretationSchema.safeParse({ item_ids: [] }).success).toBe(false);
  });
});

// ---------- pure logic ----------

const clipInfo = (extra: Partial<FootageInterp> = {}): FootageInterp => ({
  id: 7,
  name: "plate.mov",
  kind: "file",
  width: 1920,
  height: 1080,
  has_alpha: true,
  alpha_mode: "straight",
  invert_alpha: false,
  field_separation: "off",
  remove_pulldown: "off",
  conform_frame_rate: 0,
  native_frame_rate: 29.97,
  loop: 1,
  pixel_aspect: 1,
  use_proxy: false,
  proxy: null,
  ...extra,
});
const codes = (i: FootageInterp) => interpretationFindings(i).map((f) => f.code);

describe("interpretationFindings", () => {
  it("is quiet for a clean clip", () => {
    expect(codes(clipInfo())).toEqual([]);
  });

  it("flags alpha ignored on a clip that has alpha, but not on one that doesn't", () => {
    expect(codes(clipInfo({ alpha_mode: "ignore" }))).toEqual(["alpha_ignored"]);
    expect(codes(clipInfo({ has_alpha: false, alpha_mode: undefined }))).toEqual([]);
  });

  it("flags 29.97 conformed to 30 and 23.976 to 24, but treats other conforms as information", () => {
    expect(codes(clipInfo({ conform_frame_rate: 30 }))).toEqual(["conform_rounded"]);
    expect(codes(clipInfo({ native_frame_rate: 23.976, conform_frame_rate: 24 }))).toEqual(["conform_rounded"]);
    expect(codes(clipInfo({ native_frame_rate: 25, conform_frame_rate: 24 }))).toEqual(["conform_changed"]);
    expect(codes(clipInfo({ native_frame_rate: 29.97, conform_frame_rate: 29.97 }))).toEqual([]);
  });

  it("flags loops, fields on UHD, non-square pixels on HD media and proxies left on", () => {
    expect(codes(clipInfo({ loop: 3 }))).toEqual(["loop_set"]);
    expect(codes(clipInfo({ field_separation: "upper_field_first", height: 2160, width: 3840 }))).toEqual(["fields_on_uhd"]);
    expect(codes(clipInfo({ field_separation: "upper_field_first" }))).toEqual(["fields_on"]);
    expect(codes(clipInfo({ pixel_aspect: 0.9 }))).toEqual(["pixel_aspect_non_square"]);
    expect(codes(clipInfo({ width: 720, height: 480, pixel_aspect: 0.9 }))).toEqual([]);
    expect(codes(clipInfo({ use_proxy: true, proxy: { kind: "file", file: "C:/p.mov", missing: true } }))).toEqual(["proxy_in_use", "proxy_missing"]);
  });

  it("flags a comp whose proxy is on", () => {
    expect(codes({ id: 3, name: "Main", kind: "comp", use_proxy: true, proxy: { kind: "file" } })).toEqual(["proxy_in_use"]);
  });

  it("flags queue items that would render with proxies only while a proxy is on", () => {
    const read = (on: boolean, use: string, key = true): InterpretRead => ({
      items: [clipInfo({ use_proxy: on, proxy: { kind: "file" } })],
      render_queue: { key_found: key, truncated: false, items: [{ index: 1, comp: "Main", status: "queued", proxy_use: use }] },
    });
    expect(renderQueueFindings(read(true, "Use All Proxies")).map((f) => f.code)).toEqual(["queue_uses_proxies"]);
    expect(renderQueueFindings(read(true, "Use No Proxies"))).toEqual([]);
    expect(renderQueueFindings(read(false, "Use All Proxies"))).toEqual([]);
    expect(renderQueueFindings(read(true, "x", false)).map((f) => f.code)).toEqual(["proxy_use_unreadable"]);
  });

  it("ignores queue items that will not render, and footage proxies under Comp Proxies Only", () => {
    const base = (status: string, use: string, kind = "file"): InterpretRead => ({
      items: [{ ...clipInfo({ use_proxy: true, proxy: { kind: "file" } }), kind }],
      render_queue: { key_found: true, truncated: false, items: [{ index: 1, comp: "Main", status, proxy_use: use }] },
    });
    expect(renderQueueFindings(base("unqueued", "Use All Proxies"))).toEqual([]);
    expect(renderQueueFindings(base("needs_output", "Use All Proxies"))).toEqual([]);
    expect(renderQueueFindings(base("done", "Use All Proxies"))).toEqual([]);
    expect(renderQueueFindings(base("queued", "Use Comp Proxies Only"))).toEqual([]);
    expect(renderQueueFindings(base("queued", "Use Comp Proxies Only", "comp")).map((f) => f.code)).toEqual(["queue_uses_proxies"]);
  });

  it("accepts conform 0 reading back as the native rate, and flags unasked field changes", () => {
    const read = (i: FootageInterp): InterpretRead => ({ items: [i] });
    const zero = AeSetFootageInterpretationSchema.parse({ item_id: 7, conform_frame_rate: 0, expect: expectArg });
    expect(interpretMismatches(zero, read(clipInfo({ conform_frame_rate: 30 })), read(clipInfo({ conform_frame_rate: 29.97 })))).toEqual([]);
    expect(interpretMismatches(zero, read(clipInfo({ conform_frame_rate: 30 })), read(clipInfo({ conform_frame_rate: 25 }))).map((m) => m.path)).toEqual(["conform_frame_rate"]);
    const loopOnly = AeSetFootageInterpretationSchema.parse({ item_id: 7, loop: 2, expect: expectArg });
    const moved = clipInfo({ loop: 2, field_separation: "upper_field_first", remove_pulldown: "wssww", conform_frame_rate: 24, invert_alpha: true });
    expect(interpretMismatches(loopOnly, read(clipInfo()), read(moved)).map((m) => m.path)).toEqual(["invert_alpha", "field_separation", "remove_pulldown", "conform_frame_rate"]);
    const unread = { ...moved, unreadable: ["invert_alpha", "field_separation", "remove_pulldown", "conform_frame_rate"] };
    expect(interpretMismatches(loopOnly, read(clipInfo()), read(unread))).toEqual([]);
    const alphaUnread = clipInfo({ alpha_mode: "ignore", unreadable: ["alpha_mode"] });
    expect(interpretMismatches(loopOnly, read(clipInfo({ loop: 1 })), read({ ...alphaUnread, loop: 2 }))).toEqual([]);
  });
});

describe("interpretMismatches", () => {
  const args = AeSetFootageInterpretationSchema.parse({ item_id: 7, conform_frame_rate: 0, alpha: { mode: "straight", invert: true }, loop: 2, expect: expectArg });
  const read = (i: FootageInterp): InterpretRead => ({ items: [i] });

  it("accepts a clean read-back", () => {
    const before = read(clipInfo({ conform_frame_rate: 30 }));
    const after = read(clipInfo({ conform_frame_rate: 0, invert_alpha: true, loop: 2 }));
    expect(interpretMismatches(args, before, after)).toEqual([]);
  });

  it("flags values that did not stick, and changes nobody asked for", () => {
    const before = read(clipInfo({ conform_frame_rate: 30 }));
    const after = read(clipInfo({ conform_frame_rate: 30, invert_alpha: true, loop: 2, pixel_aspect: 2, use_proxy: true }));
    expect(interpretMismatches(args, before, after).map((m) => m.path)).toEqual(["conform_frame_rate", "pixel_aspect", "use_proxy"]);
  });

  it("skips guesses and a field the host could not read", () => {
    const guess = AeSetFootageInterpretationSchema.parse({ item_id: 7, alpha: { mode: "guess" }, pulldown: "guess_3_2", expect: expectArg });
    const before = read(clipInfo());
    const after = read(clipInfo({ alpha_mode: "premultiplied", remove_pulldown: "wssww", field_separation: "upper_field_first", conform_frame_rate: 24 }));
    expect(interpretMismatches(guess, before, after)).toEqual([]);
    const px = AeSetFootageInterpretationSchema.parse({ item_id: 7, conform_frame_rate: 24, expect: expectArg });
    const none = interpretMismatches(px, before, read(clipInfo({ pixel_aspect: undefined, unreadable: ["pixel_aspect"], conform_frame_rate: 24 })));
    expect(none).toEqual([]);
  });

  it("flags an item missing from the read-back", () => {
    expect(interpretMismatches(args, read(clipInfo()), { items: [] }).map((m) => m.path)).toEqual(["item"]);
  });
});

describe("proxyMismatches", () => {
  const read = (...items: FootageInterp[]): InterpretRead => ({ items });
  it("checks each action's end state", () => {
    const on = AeFootageProxySchema.parse({ item_ids: [7], action: "use_on", expect: expectArg });
    expect(proxyMismatches(on, read(), read(clipInfo({ use_proxy: true, proxy: { kind: "file" } })))).toEqual([]);
    expect(proxyMismatches(on, read(), read(clipInfo({ use_proxy: false, proxy: { kind: "file" } }))).map((m) => m.path)).toEqual(["items[7].use_proxy"]);
    const clear = AeFootageProxySchema.parse({ item_ids: [7], action: "clear", expect: expectArg });
    expect(proxyMismatches(clear, read(), read(clipInfo({ proxy: { kind: "file" } }))).map((m) => m.path)).toEqual(["items[7].proxy"]);
    const set = AeFootageProxySchema.parse({ item_ids: [7], action: "set_file", file: "C:\\Proxy\\a.mov", use_proxy: true, expect: expectArg });
    expect(proxyMismatches(set, read(), read(clipInfo({ use_proxy: true, proxy: { kind: "file", file: "c:/proxy/A.mov" } })))).toEqual([]);
    expect(proxyMismatches(set, read(), read(clipInfo({ use_proxy: false, proxy: { kind: "file", file: "C:/other.mov" } }))).map((m) => m.path)).toEqual([
      "items[7].proxy.file",
      "items[7].use_proxy",
    ]);
  });
});

// ---------- host functions under node:vm ----------

describe("interpret.jsx: interpretRead", () => {
  it("lists file footage with its settings, skips solids and leaves stills' field settings unread", () => {
    const { project, src, item, A } = scene();
    project.addFootage("Solid 1", 100, 100, new SolidSource());
    const still = new FakeSource();
    still.isStill = true;
    project.addFootage("logo.png", 500, 500, still);
    src.alphaMode = AlphaMode.IGNORE;
    const out = A.interpretRead({ include_render_queue: false });
    expect(out.skipped).toEqual({ solid: 1, placeholder: 0 });
    expect(out.items.map((i: any) => i.name)).toEqual(["plate.mov", "logo.png"]);
    const plate = out.items[0];
    expect(plate).toMatchObject({
      id: item.id,
      kind: "file",
      has_alpha: true,
      alpha_mode: "ignore",
      field_separation: "off",
      remove_pulldown: "off",
      conform_frame_rate: 0,
      native_frame_rate: 29.97,
      loop: 1,
      pixel_aspect: 1,
      use_proxy: false,
      proxy: null,
    });
    expect(out.items[1].is_still).toBe(true);
    expect(out.items[1].field_separation).toBeUndefined();
    expect(out.items[1].unreadable).toBeUndefined();
    expect(out.render_queue).toBeUndefined();
  });

  it("reads a proxy, the render queue's Proxy Use and changes nothing", () => {
    const { project, item, A, undo } = scene();
    item.setProxy({ fsName: "C:/proxy/plate.mov" });
    item.useProxy = true;
    const comp = project.addComp("Main");
    (project.renderQueue.items as any).push({ comp, status: RQItemStatus.QUEUED, getSettings: () => ({ "Proxy Use": "Use All Proxies" }) });
    const out = A.interpretRead({ item_ids: [item.id, 9999] });
    expect(out.items[0].proxy).toMatchObject({ kind: "file", file: "C:/proxy/plate.mov" });
    expect(out.items[0].use_proxy).toBe(true);
    expect(out.items[1]).toEqual({ id: 9999, error: "not_found" });
    expect(out.render_queue).toMatchObject({ key_found: true, items: [{ index: 1, comp: "Main", status: "queued", proxy_use: "Use All Proxies" }] });
    expect(undo.begun).toBe(0);
  });

  it("lists comps only when they carry a proxy, and says when the Proxy Use key is unreadable", () => {
    const { project, A } = scene();
    const withProxy: any = project.addComp("Heavy");
    withProxy.proxySource = Object.assign(new FileSource(), { file: { fsName: "C:/p.mov" } });
    project.addComp("Plain");
    (project.renderQueue.items as any).push({ comp: withProxy, status: RQItemStatus.QUEUED, getSettings: () => ({}) });
    const out = A.interpretRead({});
    expect(out.items.map((i: any) => [i.name, i.kind])).toEqual([["plate.mov", "file"], ["Heavy", "comp"]]);
    expect(out.render_queue.key_found).toBe(false);
  });

  it("bounds the list and probes for colour properties without relying on them", () => {
    const { project, A } = scene();
    for (let i = 0; i < 505; i++) project.addFootage(`f${i}.mov`, 10, 10, new FakeSource());
    const out = A.interpretRead({ include_render_queue: false, probe_colour: true });
    expect(out.items).toHaveLength(500);
    expect(out.truncated).toBe(true);
    expect(out.total_items).toBe(506);
    expect(out.colour_probe.checked).toBeDefined();
  });
});

describe("interpret.jsx: interpretApply", () => {
  it("sets fields, then pulldown, then conform, in one undo group", () => {
    const { src, item, A, undo } = scene();
    const r = A.interpretApply({
      item_id: item.id,
      pulldown: "wssww",
      field_separation: "upper_field_first",
      high_quality_field_separation: true,
      conform_frame_rate: 24,
      expect: GUARD,
    });
    expect(src.writes).toEqual(["fieldSeparationType", "removePulldown", "highQualityFieldSeparation", "conformFrameRate"]);
    expect(r.changed).toEqual(["remove_pulldown", "field_separation", "high_quality_field_separation", "conform_frame_rate"].sort((a, b) => r.changed.indexOf(a) - r.changed.indexOf(b)));
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    const back = A.interpretRead({ item_ids: [item.id], include_render_queue: false }).items[0];
    expect(back).toMatchObject({ field_separation: "upper_field_first", remove_pulldown: "wssww", conform_frame_rate: 24, high_quality_field_separation: true });
  });

  it("unwinds in reverse: pulldown off before fields off, and conform 0 after the pulldown", () => {
    const { src, item, A } = scene();
    A.interpretApply({ item_id: item.id, field_separation: "lower_field_first", pulldown: "sswww", expect: GUARD });
    src.writes.length = 0;
    A.interpretApply({ item_id: item.id, field_separation: "off", pulldown: "off", conform_frame_rate: 0, expect: GUARD });
    expect(src.writes).toEqual(["removePulldown", "fieldSeparationType", "conformFrameRate"]);
    expect(A.interpretRead({ item_ids: [item.id], include_render_queue: false }).items[0]).toMatchObject({ field_separation: "off", remove_pulldown: "off", conform_frame_rate: 0 });
  });

  it("sets alpha: premultiplied with a colour, invert, and guess", () => {
    const { src, item, A } = scene();
    A.interpretApply({ item_id: item.id, alpha: { mode: "premultiplied", premul_color: [1, 0, 0], invert: true }, expect: GUARD });
    expect(src.alphaMode).toBe(AlphaMode.PREMULTIPLIED);
    expect(src.premulColor).toEqual([1, 0, 0]);
    expect(src.invertAlpha).toBe(true);
    src.alphaMode = AlphaMode.IGNORE;
    const r = A.interpretApply({ item_id: item.id, alpha: { mode: "guess" }, expect: GUARD });
    expect(r.changed).toEqual(["alpha_mode"]);
    expect(src.alphaMode).toBe(AlphaMode.PREMULTIPLIED);
  });

  it("runs the pulldown guess alone and sets loop and pixel aspect", () => {
    const { src, item, A } = scene();
    A.interpretApply({ item_id: item.id, pulldown: "guess_3_2", expect: GUARD });
    expect(src.writes).toEqual(["guessPulldown"]);
    expect(A.interpretRead({ item_ids: [item.id], include_render_queue: false }).items[0]).toMatchObject({ field_separation: "upper_field_first", remove_pulldown: "wssww" });
    A.interpretApply({ item_id: item.id, loop: 3, pixel_aspect: 1.5, expect: GUARD });
    expect(src.loop).toBe(3);
    expect(item.pixelAspect).toBe(1.5);
  });

  it("opens no undo group when everything asked for is already so", () => {
    const { item, A, undo } = scene();
    const r = A.interpretApply({ item_id: item.id, loop: 1, field_separation: "off", expect: GUARD });
    expect(r).toMatchObject({ no_change: true, changed: [] });
    expect(undo.begun).toBe(0);
  });

  it("refuses before touching AE: guard, stills, missing alpha, order rules, ranges", () => {
    const { project, src, item, A, undo } = scene();
    const bad = (args: object, re: RegExp) => expect(() => A.interpretApply({ item_id: item.id, expect: GUARD, ...args })).toThrow(re);
    expect(() => A.interpretApply({ item_id: item.id, loop: 2, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    bad({ pulldown: "wssww" }, /field separation on/);
    bad({ field_separation: "upper_field_first", conform_frame_rate: 100 }, /0\.\.99/);
    bad({ high_quality_field_separation: true }, /needs field separation on/);
    bad({ loop: 0 }, /1\.\.9999/);
    bad({ loop: 1.5 }, /whole number/);
    bad({ pixel_aspect: 500 }, /0\.01\.\.100/);
    bad({ alpha: { mode: "premultiplied", premul_color: [2, 0, 0] } }, /0\.\.1/);
    bad({ alpha: { premul_color: [0, 0, 0] } }, /premultiplied alpha only/);
    bad({ alpha: { mode: "ignore", invert: true } }, /alpha is ignored/);
    bad({ alpha: { mode: "guess", invert: true } }, /can't be combined/);
    bad({ pulldown: "guess_3_2", conform_frame_rate: 24 }, /run it alone/);
    bad({ pulldown: "nope", field_separation: "upper_field_first" }, /Unknown pulldown/);
    bad({}, /Nothing to set/);
    A.interpretApply({ item_id: item.id, field_separation: "upper_field_first", pulldown: "wssww", expect: GUARD });
    undo.begun = 0;
    bad({ field_separation: "off" }, /Field separation can't go off/);
    bad({ conform_frame_rate: 0 }, /conform rate can't be 0/);
    src.hasAlpha = false;
    bad({ alpha: { mode: "straight" } }, /no alpha channel/);
    src.isStill = true;
    bad({ loop: 2 }, /is a still/);
    src.isStill = false;
    (item as any).footageMissing = true;
    bad({ loop: 2 }, /missing its file/);
    (item as any).footageMissing = false;
    const solid = project.addFootage("Solid", 10, 10, new SolidSource());
    expect(() => A.interpretApply({ item_id: solid.id, loop: 2, expect: GUARD })).toThrow(/solid item/);
    expect(() => A.interpretApply({ item_id: 99999, loop: 2, expect: GUARD })).toThrow(/No footage item/);
    expect(undo.begun).toBe(0);
  });

  it("puts the old values back, inside the same undo group, when a step fails", () => {
    const { src, item, A, undo } = scene();
    src.failOn = "conformFrameRate";
    expect(() =>
      A.interpretApply({ item_id: item.id, field_separation: "upper_field_first", pulldown: "wssww", conform_frame_rate: 24, loop: 4, alpha: { mode: "ignore" }, expect: GUARD })
    ).toThrow(/old interpretation was put back/);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect(src.alphaMode).toBe(AlphaMode.STRAIGHT);
    expect(src.loop).toBe(1);
    expect(A.interpretRead({ item_ids: [item.id], include_render_queue: false }).items[0]).toMatchObject({ field_separation: "off", remove_pulldown: "off", conform_frame_rate: 0 });
  });

  it("says so when the old values could not all be put back", () => {
    const { src, item, A, undo } = scene();
    let fieldWrites = 0;
    (src as any).log = (what: string) => {
      (src as any).writes.push(what);
      if (what === "conformFrameRate") throw new Error("forced failure at conform");
      if (what === "fieldSeparationType" && ++fieldWrites > 1) throw new Error("restore blocked");
    };
    let err: any;
    try {
      A.interpretApply({ item_id: item.id, field_separation: "upper_field_first", conform_frame_rate: 24, expect: GUARD });
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/could NOT be fully put back.*fieldSep/);
    expect(err.message).not.toMatch(/old interpretation was put back/);
    expect(err.__actual).toMatchObject({ fieldSep: FieldSeparationType.UPPER_FIELD_FIRST });
    expect(err.__expected).toMatchObject({ fieldSep: FieldSeparationType.OFF });
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });
});

describe("interpret.jsx: interpretProxy", () => {
  function proxyFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-interpret-p-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "plate_proxy.mov");
    fs.writeFileSync(file, "x");
    return file;
  }

  it("sets a file proxy, switches it on and off, and clears it", () => {
    const { item, A, undo } = scene();
    const file = proxyFile();
    const set = A.interpretProxy({ item_ids: [item.id], action: "set_file", file, use_proxy: true, expect: GUARD });
    expect(set.item_ids).toEqual([item.id]);
    expect(item.proxySource.file.fsName).toBe(file);
    expect(item.useProxy).toBe(true);
    expect(A.interpretProxy({ item_ids: [item.id], action: "use_on", expect: GUARD })).toMatchObject({ no_change: true, skipped_ids: [item.id] });
    A.interpretProxy({ item_ids: [item.id], action: "use_off", expect: GUARD });
    expect(item.useProxy).toBe(false);
    A.interpretProxy({ item_ids: [item.id], action: "clear", expect: GUARD });
    expect(item.proxySource).toBeNull();
    expect(A.interpretProxy({ item_ids: [item.id], action: "clear", expect: GUARD }).no_change).toBe(true);
    expect(undo).toMatchObject({ begun: 3, ended: 3 });
  });

  it("sets a solid and a sequence proxy", () => {
    const { item, A } = scene();
    A.interpretProxy({ item_ids: [item.id], action: "set_solid", solid: { color: [0.5, 0.5, 0.5], width: 480, height: 270 }, expect: GUARD });
    expect(item.proxySource).toBeInstanceOf(SolidSource);
    // As AE does: any set_ action switches useProxy on unless use_proxy: false is given.
    expect(item.useProxy).toBe(true);
    A.interpretProxy({ item_ids: [item.id], action: "set_sequence", file: proxyFile(), expect: GUARD });
    expect(item.proxySource).toBeInstanceOf(FileSource);
  });

  it("switches several items and refuses bad requests before AE is touched", () => {
    const { project, item, A, undo } = scene();
    const second = new ProxyFootage("b.mov", 10, 10, new FakeSource());
    second.project = project;
    project.all.push(second);
    item.setProxy({ fsName: "C:/a.mov" });
    second.setProxy({ fsName: "C:/b.mov" });
    A.interpretProxy({ item_ids: [item.id, second.id], action: "use_on", expect: GUARD });
    expect([item.useProxy, second.useProxy]).toEqual([true, true]);
    undo.begun = 0;
    const third = new ProxyFootage("c.mov", 10, 10, new FakeSource());
    third.project = project;
    project.all.push(third);
    const bad = (args: object, re: RegExp) => expect(() => A.interpretProxy({ expect: GUARD, ...args })).toThrow(re);
    bad({ item_ids: [third.id], action: "use_on" }, /no proxy to switch on/);
    bad({ item_ids: [item.id], action: "set_file", file: "C:/definitely/not/here.mov" }, /does not exist/);
    bad({ item_ids: [item.id, second.id], action: "set_file", file: proxyFile() }, /one item at a time/);
    bad({ item_ids: [item.id], action: "set_solid", solid: { color: [0, 0, 9], width: 4, height: 4 } }, /0\.\.1/);
    bad({ item_ids: [item.id], action: "set_solid", solid: { color: [0, 0, 0], width: 0, height: 4 } }, /1\.\.30000/);
    bad({ item_ids: [item.id], action: "use_off", use_proxy: true }, /goes with set_file/);
    bad({ item_ids: [424242], action: "clear" }, /No footage or comp item/);
    bad({ item_ids: [item.id], action: "explode" }, /Unknown proxy action/);
    (item as any).footageMissing = true;
    bad({ item_ids: [item.id], action: "set_solid", solid: { color: [0, 0, 0], width: 4, height: 4 } }, /missing its file/);
    expect(undo.begun).toBe(0);
  });

  it("switches back the items already done when one fails", () => {
    const { project, item, A, undo } = scene();
    const second = new ProxyFootage("b.mov", 10, 10, new FakeSource());
    second.project = project;
    project.all.push(second);
    item.setProxy({ fsName: "C:/a.mov" });
    second.setProxy({ fsName: "C:/b.mov" });
    item.useProxy = false;
    Object.defineProperty(second, "useProxy", {
      get: () => false,
      set: () => {
        throw new Error("AE refused");
      },
    });
    expect(() => A.interpretProxy({ item_ids: [item.id, second.id], action: "use_on", expect: GUARD })).toThrow(/AE refused/);
    expect(item.useProxy).toBe(false);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });
});

// ---------- the tools with a fake bridge ----------

describe("interpret tools", () => {
  it("ae_set_footage_interpretation guards, reads, writes, and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      interpretRead: [{ items: [clipInfo({ conform_frame_rate: 30 })] }, { items: [clipInfo({ conform_frame_rate: 0 })] }],
      interpretApply: [{ item_id: 7, name: "plate.mov", changed: ["conform_frame_rate"], no_change: false }],
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_id: 7, conform_frame_rate: 0, expect: expectArg });
    const out = await tool("ae_set_footage_interpretation").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "interpretRead", "interpretApply", "interpretRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out.receipt.matches).toBe(true);
    expect(out.changed).toEqual(["conform_frame_rate"]);
    expect(out.findings).toEqual([]);
  });

  it("ae_set_footage_interpretation reports a value that didn't stick in the receipt", async () => {
    const { ctx } = fakeAe({
      interpretRead: [{ items: [clipInfo({ conform_frame_rate: 30 })] }, { items: [clipInfo({ conform_frame_rate: 30 })] }],
      interpretApply: [{ item_id: 7, changed: ["conform_frame_rate"], no_change: false }],
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_id: 7, conform_frame_rate: 0, expect: expectArg });
    const out = await tool("ae_set_footage_interpretation").handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toEqual(["conform_frame_rate"]);
    expect(out.findings.map((f: { code: string }) => f.code)).toEqual(["conform_rounded"]);
  });

  it("ae_footage_proxy reads the items before and after", async () => {
    const { ctx, calls } = fakeAe({
      interpretRead: [
        { items: [clipInfo({ proxy: { kind: "file", file: "C:/p.mov" }, use_proxy: false })] },
        { items: [clipInfo({ proxy: { kind: "file", file: "C:/p.mov" }, use_proxy: true })] },
      ],
      interpretProxy: [{ action: "use_on", item_ids: [7], skipped_ids: [], no_change: false }],
    });
    const args = AeFootageProxySchema.parse({ item_ids: [7], action: "use_on", expect: expectArg });
    const out = await tool("ae_footage_proxy").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "interpretRead", "interpretProxy", "interpretRead"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.items[0]).toMatchObject({ id: 7, use_proxy: true });
  });

  it("a failed read-back goes into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      interpretRead: [{ items: [clipInfo()] }],
      interpretProxy: [{ action: "use_off", item_ids: [7], skipped_ids: [], no_change: false }],
    });
    const args = AeFootageProxySchema.parse({ item_ids: [7], action: "use_off", expect: expectArg });
    const out = await tool("ae_footage_proxy").handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("ae_get_footage_interpretation adds findings, counts warnings and can filter to them", async () => {
    const read = {
      items: [clipInfo({ id: 1, name: "ok.mov" }), clipInfo({ id: 2, name: "bad.mov", alpha_mode: "ignore", conform_frame_rate: 30 })],
      render_queue: { key_found: true, truncated: false, items: [] },
    };
    const all = fakeAe({ interpretRead: [read] });
    const out: any = await tool("ae_get_footage_interpretation").handler(AeGetFootageInterpretationSchema.parse({}), all.ctx);
    expect(all.calls.map((c) => c.fn)).toEqual(["interpretRead"]);
    expect(out.items).toHaveLength(2);
    expect(out.items[1].findings.map((f: { code: string }) => f.code)).toEqual(["alpha_ignored", "conform_rounded"]);
    expect(out.warnings).toBe(2);
    const only = fakeAe({ interpretRead: [read] });
    const filtered: any = await tool("ae_get_footage_interpretation").handler(AeGetFootageInterpretationSchema.parse({ only_findings: true }), only.ctx);
    expect(filtered.items.map((i: { id: number }) => i.id)).toEqual([2]);
    expect(filtered.findings_total).toBe(2);
  });
});
