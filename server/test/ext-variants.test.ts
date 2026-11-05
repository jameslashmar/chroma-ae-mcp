import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { EASE_CURVE_ARRAY_SCHEMA } from "../src/tools/ext/animate.js";
import { AskStore } from "../src/asks.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeVariantsDiscardSchema,
  AeVariantsPickSchema,
  AeVariantsSchema,
  cleanupMismatches,
  countTargets,
  createMismatches,
  defaultTimes,
  clampRenderTime,
  EASE_PRESETS,
  loadSet,
  normProjectPath,
  probeMismatches,
  saveSet,
  summariseOps,
  toHostOps,
  variantsTools,
  VariantOpSchema,
  type SetRecord,
  type Variant,
  type VariantOp,
} from "../src/tools/ext/variants.js";
import {
  FakeComp,
  FakeFootage,
  FakeGroup,
  FakeLayer,
  FakeProject,
  FakeProperty,
  GUARD,
  KeyframeEase,
  loadHost,
  PropertyType,
  PropertyValueType,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => variantsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const TRANSFORM = "ADBE Transform Group";
const FILL = ["ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"];

// ---------- schemas ----------

const variant = (id: string, ops: unknown[]) => ({ id, label: `Variant ${id}`, ops });
const shift = { op: "shift_time", layers: [{ index: 1 }], stagger: 0.1 };
const base = { comp_id: 1, expect: expectArg };

describe("variants schemas", () => {
  it("takes 2 to 6 variants with unique ids", () => {
    const ok = AeVariantsSchema.safeParse({ ...base, variants: [variant("a", [shift]), variant("b", [shift])] });
    expect(ok.success).toBe(true);
    expect(AeVariantsSchema.safeParse({ ...base, variants: [variant("a", [shift])] }).success).toBe(false);
    expect(AeVariantsSchema.safeParse({ ...base, variants: [variant("a", [shift]), variant("a", [shift])] }).success).toBe(false);
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => variant(id, [shift]));
    expect(AeVariantsSchema.safeParse({ ...base, variants: seven }).success).toBe(false);
    expect(AeVariantsSchema.safeParse({ comp_id: 1, variants: [variant("a", [shift]), variant("b", [shift])] }).success).toBe(false);
  });

  it("checks variant ids, times and the layer-change budget", () => {
    expect(AeVariantsSchema.safeParse({ ...base, variants: [variant("a b", [shift]), variant("b", [shift])] }).success).toBe(false);
    const two = [variant("a", [shift]), variant("b", [shift])];
    expect(AeVariantsSchema.safeParse({ ...base, variants: two, times: [0, 1, 2, 3] }).success).toBe(false);
    expect(AeVariantsSchema.safeParse({ ...base, variants: two, times: [-1] }).success).toBe(false);
    const fiftyLayers = Array.from({ length: 50 }, (_, i) => ({ index: i + 1 }));
    const heavy = (id: string) => variant(id, Array.from({ length: 6 }, () => ({ op: "shift_time", layers: fiftyLayers, offset: 1 })));
    expect(AeVariantsSchema.safeParse({ ...base, variants: [heavy("a"), heavy("b")] }).success).toBe(false);
  });

  it("validates each op", () => {
    const ok = (op: unknown) => VariantOpSchema.safeParse(op).success;
    const l = [{ index: 1 }];
    expect(ok({ op: "color", layers: l, path: FILL, color: [1, 0, 0] })).toBe(true);
    expect(ok({ op: "color", layers: l, path: FILL, color: [1, 0] })).toBe(false);
    expect(ok({ op: "color", layers: l, path: FILL, color: [2, 0, 0] })).toBe(false);
    expect(ok({ op: "color", layers: [], path: FILL, color: [1, 0, 0] })).toBe(false);
    expect(ok({ op: "set_value", layers: l, path: [TRANSFORM, "ADBE Opacity"], value: 50 })).toBe(true);
    expect(ok({ op: "set_value", layers: l, path: [TRANSFORM, "ADBE Scale"], value: [50, 50] })).toBe(true);
    expect(ok({ op: "set_value", layers: l, path: [TRANSFORM, "ADBE Scale"], value: [50] })).toBe(false);
    expect(ok({ op: "offset", layers: l, delta: [10, 0] })).toBe(true);
    expect(ok({ op: "offset", layers: l, delta: [10] })).toBe(false);
    expect(ok({ op: "ease", layers: l, ease: "gentle" })).toBe(true);
    expect(ok({ op: "ease", layers: l, ease: [0.2, 0, 0, 1] })).toBe(true);
    expect(ok({ op: "ease", layers: l, ease: "bouncy" })).toBe(false);
    expect(ok({ op: "ease", layers: l, ease: [0, 0, 1, 1] })).toBe(false);
    expect(ok({ op: "comp_duration", seconds: 5 })).toBe(true);
    expect(ok({ op: "comp_duration", seconds: 0 })).toBe(false);
    expect(ok({ op: "nope", layers: l })).toBe(false);
  });

  it("refuses a shift_time that shifts nothing", () => {
    const two = (op: unknown) => AeVariantsSchema.safeParse({ ...base, variants: [variant("a", [op]), variant("b", [shift])] }).success;
    expect(two({ op: "shift_time", layers: [{ index: 1 }] })).toBe(false);
    expect(two({ op: "shift_time", layers: [{ index: 1 }], offset: 0, stagger: 0 })).toBe(false);
    expect(two({ op: "shift_time", layers: [{ index: 1 }], offset: -0.5 })).toBe(true);
  });

  it("refuses two ops on one target in a variant", () => {
    const l = [{ index: 1 }];
    const two = (...ops: unknown[]) => AeVariantsSchema.safeParse({ ...base, variants: [variant("a", ops), variant("b", [shift])] });
    expect(two({ op: "shift_time", layers: l, offset: 0.5 }, { op: "shift_time", layers: l, offset: 0.25 }).success).toBe(false);
    expect(two({ op: "offset", layers: [{ index: 1 }, { index: 2 }], delta: [10, 0] }, { op: "offset", layers: [{ index: 2 }], delta: [0, 10] }).success).toBe(false);
    expect(two({ op: "color", layers: l, path: FILL, color: [1, 0, 0] }, { op: "color", layers: l, path: FILL, color: [0, 1, 0] }).success).toBe(false);
    expect(two({ op: "comp_duration", seconds: 3 }, { op: "comp_duration", seconds: 5 }).success).toBe(false);
    // Different layers, different properties, or a shift and an offset are fine.
    expect(two({ op: "shift_time", layers: l, offset: 0.5 }, { op: "shift_time", layers: [{ index: 2 }], offset: 0.5 }).success).toBe(true);
    expect(two({ op: "shift_time", layers: l, offset: 0.5 }, { op: "offset", layers: l, delta: [1, 1] }).success).toBe(true);
    expect(two({ op: "offset", layers: l, delta: [1, 1] }, { op: "offset", layers: l, delta: [1, 1], path: [TRANSFORM, "ADBE Anchor Point"] }).success).toBe(true);
    // An ease and an offset on one path are different targets; two eases on one path are not.
    const POS = [TRANSFORM, "ADBE Position"];
    expect(two({ op: "offset", layers: l, delta: [1, 1] }, { op: "ease", layers: l, ease: "gentle", path: POS }).success).toBe(true);
    expect(two({ op: "ease", layers: l, ease: "gentle", path: POS }, { op: "ease", layers: l, ease: "snappy", path: POS }).success).toBe(false);
  });

  it("pick and discard take a set id", () => {
    expect(AeVariantsPickSchema.safeParse({ comp_id: 1, set_id: "vs_0123abcd", variant_id: "a", expect: expectArg }).success).toBe(true);
    expect(AeVariantsPickSchema.safeParse({ comp_id: 1, set_id: "oops", variant_id: "a", expect: expectArg }).success).toBe(false);
    expect(AeVariantsPickSchema.safeParse({ comp_id: 1, set_id: "vs_0123abcd", variant_id: "a", cleanup: "keep", expect: expectArg }).success).toBe(false);
    expect(AeVariantsDiscardSchema.safeParse({ comp_id: 1, set_id: "vs_0123abcd", cleanup: "park", expect: expectArg }).success).toBe(true);
  });

  it("every tool is a guarded write with the safety guidance", () => {
    expect(variantsTools.map((t) => t.name)).toEqual(["ae_variants", "ae_variants_pick", "ae_variants_discard"]);
    for (const t of variantsTools) {
      expect(t.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
      expect(t.schema.safeParse({}).success).toBe(false);
    }
  });
});

// ---------- pure logic ----------

describe("variants pure logic", () => {
  it("never renders at or past the last frame", () => {
    expect(clampRenderTime(5, 4, 25)).toBeCloseTo(3.96, 6);
    expect(clampRenderTime(2, 4, 25)).toBe(2);
    expect(clampRenderTime(1, 0.01, 25)).toBe(0);
    expect(clampRenderTime(3, undefined, 25)).toBe(3);
  });

  it("turns an ease preset into its curve and leaves other ops alone", () => {
    const ops = VariantOpSchema.array().parse([
      { op: "ease", layers: [{ index: 1 }], ease: "snappy" },
      { op: "ease", layers: [{ index: 1 }], path: [TRANSFORM, "ADBE Opacity"], ease: [0.3, 0, 0.7, 1] },
      { op: "comp_duration", seconds: 6 },
    ]);
    const host = toHostOps(ops);
    expect(host[0]).toEqual({ op: "ease", layers: [{ index: 1 }], curve: [...EASE_PRESETS.snappy] });
    expect(host[1]).toMatchObject({ curve: [0.3, 0, 0.7, 1], path: [TRANSFORM, "ADBE Opacity"] });
    expect(host[2]).toEqual({ op: "comp_duration", seconds: 6 });
  });

  it("describes ops for the button and counts layer changes", () => {
    const ops = VariantOpSchema.array().parse([
      { op: "ease", layers: [{ index: 1 }, { index: 2 }], ease: "gentle" },
      { op: "color", layers: [{ index: 1 }], path: FILL, color: [1, 0, 0] },
      { op: "offset", layers: [{ index: 3 }], delta: [20, 0], cumulative: true },
      { op: "shift_time", layers: [{ index: 3 }], stagger: 0.2 },
      { op: "comp_duration", seconds: 8 },
    ]);
    const text = summariseOps(ops);
    expect(text).toContain("ease gentle on 2 layers");
    expect(text).toContain("colour on 1 layer");
    expect(text).toContain("(fanned)");
    expect(text).toContain("duration 8s");
    expect(countTargets(ops)).toBe(2 + 1 + 1 + 1 + 1);
    expect(summariseOps(Array.from({ length: 40 }, () => ({ op: "comp_duration", seconds: 1000 })) as VariantOp[]).length).toBeLessThanOrEqual(380);
  });

  it("picks the middle of the work area by default", () => {
    expect(defaultTimes({ workAreaStart: 1, workAreaDuration: 3 })).toEqual([2.5]);
    expect(defaultTimes({ duration: 4 })).toEqual([2]);
  });

  it("compares probes: values per key, partial vectors, start time, ease influence", () => {
    const probes = [
      { comp_id: 5, kind: "values" as const, layer_index: 1, path: ["a", "Position"], expected: [[10, 20]] },
      { comp_id: 5, kind: "start_time" as const, layer_index: 2, expected: 0.5 },
      { comp_id: 5, kind: "ease" as const, layer_index: 1, path: ["a", "Opacity"], keys: [{ key: 1, out_influence: 25 }, { key: 2, in_influence: 75 }] },
      { comp_id: 5, kind: "comp_duration" as const, expected: 6 },
    ];
    const good = [
      { ok: true, kind: "values", actual: [[10, 20, 0]] },
      { ok: true, kind: "start_time", actual: 0.51 },
      {
        ok: true,
        kind: "ease",
        actual: [
          { key: 1, in_influence: 16, out_influence: 25.2, in_interp: "bezier", out_interp: "bezier" },
          { key: 2, in_influence: 75, out_influence: 16, in_interp: "bezier", out_interp: "bezier" },
        ],
      },
      { ok: true, kind: "comp_duration", actual: 6 },
    ];
    expect(probeMismatches("t", probes, good, 25)).toEqual([]);
    const bad = [
      { ok: true, kind: "values", actual: [[10, 21, 0]] },
      { ok: true, kind: "start_time", actual: 0.7 },
      { ok: true, kind: "ease", actual: [{ key: 1, in_influence: 16, out_influence: 50, in_interp: "linear", out_interp: "bezier" }] },
      { ok: false, kind: "comp_duration", error: "boom" },
    ];
    const m = probeMismatches("t", probes, bad, 25);
    expect(m.length).toBe(6);
    expect(m.map((x) => x.message)).toEqual(
      expect.arrayContaining(["Value differs", "Start time differs", "Out influence differs", "Key is not bezier", "Key not read back"])
    );
    expect(m.some((x) => x.message.includes("boom"))).toBe(true);
    // A probe the host didn't read (past its cap) is only a mismatch when the read wasn't capped.
    expect(probeMismatches("t", probes.slice(0, 1), [], 25)).toHaveLength(1);
    expect(probeMismatches("t", probes.slice(0, 1), [], 25, true)).toEqual([]);
  });

  it("tells a one-frame shift from no write, but not a rounding error", () => {
    const p = [{ comp_id: 5, kind: "start_time" as const, layer_index: 1, expected: 0.04 }];
    expect(probeMismatches("t", p, [{ ok: true, kind: "start_time", actual: 0 }], 25)).toHaveLength(1);
    expect(probeMismatches("t", p, [{ ok: true, kind: "start_time", actual: 0.0401 }], 25)).toEqual([]);
  });

  it("flags a keyed property that came back with a different key count", () => {
    const probes = [{ comp_id: 5, kind: "values" as const, layer_index: 1, path: ["a"], expected: [[1, 2, 3], [1, 2, 3]] }];
    const m = probeMismatches("t", probes, [{ ok: true, kind: "values", actual: [[1, 2, 3]] }], 25);
    expect(m.map((x) => x.message)).toEqual(["Number of values (keys) differs"]);
  });

  const original = (digest: string, numLayers = 3) => ({ comp_id: 1, name: "Main", width: 64, height: 36, fps: 25, duration: 4, workAreaStart: 0, workAreaDuration: 4, numLayers, digest });
  const written = { copies: [{ variant_id: "a", label: "A", comp_id: 11, name: "Main [a]", duration: 4, changes: [], probes: [] }] };
  const variants = [{ id: "a", label: "A", ops: [] }] as unknown as Variant[];

  it("create: flags a missing copy, a layer-count mismatch, a copy outside the folder and a changed original", () => {
    const before = { original: original("d1"), copies: [], probes: [] };
    const goodAfter = { original: original("d1"), copies: [{ comp_id: 11, exists: true, numLayers: 3, in_folder: true }], probes: [] };
    expect(createMismatches(variants, before, goodAfter, written)).toEqual([]);
    const gone = { ...goodAfter, copies: [{ comp_id: 11, exists: false }] };
    expect(createMismatches(variants, before, gone, written).map((m) => m.path)).toEqual(["copies[a]"]);
    const odd = { ...goodAfter, copies: [{ comp_id: 11, exists: true, numLayers: 2, in_folder: false }] };
    expect(createMismatches(variants, before, odd, written).map((m) => m.path)).toEqual(["copies[a].numLayers", "copies[a].folder"]);
    const drifted = { ...goodAfter, original: original("d2") };
    expect(createMismatches(variants, before, drifted, written).map((m) => m.path)).toEqual(["original.digest"]);
    expect(createMismatches(variants, before, null, written)).toEqual([]);
  });

  it("cleanup: removed copies are gone, parked copies stay in the folder", () => {
    const before = { original: original("d1"), copies: [], probes: [] };
    const cleanup = { removed: [11], parked: [12], skipped: [], folder_removed: false };
    const ok = { original: original("d1"), copies: [{ comp_id: 11, exists: false }, { comp_id: 12, exists: true, in_folder: true }], probes: [] };
    expect(cleanupMismatches(before, ok, { cleanup })).toEqual([]);
    const bad = { original: original("d1", 2), copies: [{ comp_id: 11, exists: true }, { comp_id: 12, exists: true, in_folder: false }], probes: [] };
    expect(cleanupMismatches(before, bad, { cleanup }).map((m) => m.path)).toEqual(["copies[11]", "copies[12]", "original.numLayers"]);
  });
});

// ---------- the guarded flow, with a fake bridge ----------

type Step = unknown | ((script: string) => unknown);

/** A PanelHost whose AE answers from a script of results, recording each call. Functions in the script compute the answer. */
function fakeAe(results: Record<string, Step[]>, opts: { asks?: AskStore } = {}) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-variants-"));
  tmpDirs.push(dir);
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
      if (next === undefined) throw new Error(`Unexpected script: ${script.slice(0, 120)}`);
      const value = typeof next === "function" ? (next as (s: string) => unknown)(script) : next;
      return { ok: true, result: value, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir, ...(opts.asks ? { asks: opts.asks } : {}) };
  return { ctx, calls, dir };
}

/** snapshotFrame for the fake: writes a solid PNG where the host would. */
const snapshot = (rgb: [number, number, number] = [200, 80, 40]) => (script: string) => {
  const m = /"output_path":("(?:[^"\\]|\\.)*")/.exec(script);
  const file = JSON.parse(m![1]) as string;
  const png = new PNG({ width: 64, height: 36 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
  return { path: file };
};

const orig = (extra: Record<string, unknown> = {}) => ({
  comp_id: 1,
  name: "Main",
  width: 64,
  height: 36,
  fps: 25,
  duration: 4,
  workAreaStart: 0,
  workAreaDuration: 4,
  numLayers: 2,
  ...extra,
});

const copyOf = (id: string, compId: number, expected: number) => ({
  variant_id: id,
  label: `Variant ${id}`,
  comp_id: compId,
  name: `Main [${id}]`,
  duration: 4,
  changes: [{ op: "shift_time", layers: ["Title"] }],
  probes: [{ kind: "start_time", layer_index: 1, expected }],
});

const createArgs = (extra: Record<string, unknown> = {}) =>
  AeVariantsSchema.parse({
    ...base,
    variants: [variant("a", [{ op: "shift_time", layers: [{ index: 1 }], offset: 0.5 }]), variant("b", [{ op: "shift_time", layers: [{ index: 1 }], offset: 1 }])],
    ...extra,
  });

const createScript = (read = { ok: true }) => ({
  variantsRead: [
    { original: orig({ digest: "d1", digest_basis: "layers" }), copies: [], probes: [] },
    {
      original: orig({ digest: "d1" }),
      copies: [
        { comp_id: 11, exists: true, numLayers: 2, in_folder: true },
        { comp_id: 12, exists: true, numLayers: 2, in_folder: true },
      ],
      probes: [
        { ok: read.ok, kind: "start_time", actual: 0.5 },
        { ok: true, kind: "start_time", actual: 1 },
      ],
    },
  ],
  variantsCreate: [
    {
      original: orig(),
      folder: { id: 9, name: "chroma variants" },
      copies: [copyOf("a", 11, 0.5), copyOf("b", 12, 1)],
      warnings: { shared_precomps: [], comp_expressions: [], truncated: false },
    },
  ],
});

describe("ae_variants", () => {
  it("guards, reads, creates, reads back separately, then renders and builds the sheets", async () => {
    const { ctx, calls, dir } = fakeAe({ ...createScript(), snapshotFrame: [snapshot(), snapshot([20, 120, 220])] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "variantsRead", "variantsCreate", "variantsRead", "snapshotFrame", "snapshotFrame"]);
    expect(calls[2].script).toContain('"expect"');
    expect(calls[2].script).toContain('"op":"shift_time"');
    // The read after asks for the new copies and the probes, which carry the values to check.
    expect(calls[3].script).toContain('"copy_ids":[11,12]');
    expect(calls[3].script).toContain('"kind":"start_time"');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.set_id).toMatch(/^vs_[0-9a-f]{8}$/);
    expect(out.original).toMatchObject({ comp_id: 1, digest: "d1" });
    expect(out.copies.map((c: { variant_id: string; comp_id: number }) => [c.variant_id, c.comp_id])).toEqual([["a", 11], ["b", 12]]);
    expect(out.copies[0].probes).toBeUndefined();
    expect(out.record_saved).toBe(true);
    expect(out.renders.errors).toEqual([]);
    expect(out.renders.times).toEqual([2]);
    for (const v of out.renders.variants) expect(fs.existsSync(v.strip_path)).toBe(true);
    const sheet = PNG.sync.read(fs.readFileSync(out.renders.sheet_path));
    expect(sheet.width).toBeGreaterThan(64);
    expect(out.ask).toBeUndefined();
    expect(out.next).toContain("ae_variants_pick");
    // The set is saved, with the spec, for the pick.
    const rec = loadSet(ctx, out.set_id)!;
    expect(rec.original).toMatchObject({ comp_id: 1, digest: "d1" });
    expect(rec.variants.map((v) => [v.id, v.copy_comp_id])).toEqual([["a", 11], ["b", 12]]);
    expect(rec.variants[0].ops[0]).toMatchObject({ op: "shift_time", offset: 0.5 });
    expect(fs.existsSync(path.join(dir, "variants", `${out.set_id}.json`))).toBe(true);
  });

  it("keeps set_id and the digest when the read-back fails", async () => {
    const script = createScript();
    script.variantsRead = [script.variantsRead[0], (() => { throw new Error("read broke"); }) as never];
    const hostOriginal = { ...orig(), digest: "dHost", digest_basis: "fingerprint" };
    script.variantsCreate[0].original = hostOriginal as never;
    const { ctx } = fakeAe({ ...script, snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.applied).toBe(true);
    expect(out.set_id).toMatch(/^vs_[0-9a-f]{8}$/);
    expect(out.original.digest).toBe("dHost");
    expect(loadSet(ctx, out.set_id)!.original.digest).toBe("dHost");
  });

  it("does not throw after the write when the host result has no original", async () => {
    const script = createScript();
    script.variantsCreate = [{ copies: [copyOf("a", 11, 0.5), copyOf("b", 12, 1)] } as never];
    const { ctx } = fakeAe({ ...script, snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.applied).toBe(true);
    expect(out.set_id).toMatch(/^vs_/);
  });

  it("says so when the read-back covered fewer probes than were written", async () => {
    const script = createScript();
    script.variantsRead[1] = { ...script.variantsRead[1], probes: [{ ok: true, kind: "start_time", actual: 0.5 }], probes_truncated: true } as never;
    const { ctx } = fakeAe({ ...script, snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.unverified_probes).toBe(1);
    expect(out.receipt_note).toMatch(/not read back/);
  });

  it("dry_run only plans: one read call, nothing created", async () => {
    const plan = { original: orig(), folder_name: "chroma variants", variants: [], warnings: {}, dry_run: true };
    const { ctx, calls } = fakeAe({ variantsPlan: [plan] });
    const out = await tool("ae_variants").handler(createArgs({ dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["variantsPlan"]);
    expect(out).toMatchObject({ ok: true, dry_run: true });
  });

  it("renders several times per variant, clamped to each copy's duration", async () => {
    const script = createScript();
    // The host's own duration reading is not trusted: the comp_duration op decides.
    script.variantsCreate[0].copies[1].duration = 4;
    const { ctx, calls } = fakeAe({ ...script, snapshotFrame: [snapshot(), snapshot(), snapshot(), snapshot()] });
    const shortB = variant("b", [{ op: "shift_time", layers: [{ index: 1 }], offset: 1 }, { op: "comp_duration", seconds: 1.5 }]);
    const out = await tool("ae_variants").handler(createArgs({ ask: false, times: [0.5, 3], variants: [variant("a", [{ op: "shift_time", layers: [{ index: 1 }], offset: 0.5 }]), shortB] }), ctx);
    const times = calls.filter((c) => c.fn === "snapshotFrame").map((c) => /"time":([0-9.]+)/.exec(c.script)![1]);
    expect(times).toEqual(["0.5", "3", "0.5", "1.46"]);
    expect(out.renders.variants[0].frames).toHaveLength(2);
    expect(out.renders.variants[0].strip_path).toBeTruthy();
  });

  it("reports a failed render without throwing, since the copies already exist", async () => {
    const boom = () => {
      throw new Error("AE is busy");
    };
    const { ctx } = fakeAe({ ...createScript(), snapshotFrame: [boom, boom] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.applied).toBe(true);
    expect(out.renders.errors.length).toBe(2);
    expect(out.renders.errors[0]).toContain("AE is busy");
    expect(out.renders.sheet_path).toBeUndefined();
    expect(out.record_saved).toBe(true);
  });

  it("puts a read-back mismatch in the receipt instead of failing", async () => {
    const { ctx } = fakeAe({ ...createScript({ ok: false }), snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toContain("could not be read back");
  });

  it("reports a failed read-back and a changed original as mismatches", async () => {
    const script = createScript();
    (script.variantsRead[1] as { original: { digest: string } }).original.digest = "d2";
    const { ctx } = fakeAe({ ...script, snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("original.digest");

    const failing = createScript();
    failing.variantsRead[1] = (() => {
      throw new Error("timed out");
    }) as never;
    const second = fakeAe({ ...failing, snapshotFrame: [snapshot(), snapshot()] });
    const out2 = await tool("ae_variants").handler(createArgs({ ask: false }), second.ctx);
    expect(out2.applied).toBe(true);
    expect(out2.receipt.matches).toBe(false);
    expect(out2.receipt.mismatches[0].message).toContain("Do not resend");
  });

  it("asks with a picture per option and returns the chosen variant", async () => {
    const asks = new AskStore();
    const { ctx } = fakeAe({ ...createScript(), snapshotFrame: [snapshot(), snapshot()] }, { asks });
    const running = tool("ae_variants").handler(createArgs({ wait_seconds: 20 }), ctx);
    let open = asks.open();
    for (let i = 0; i < 200 && open.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      open = asks.open();
    }
    expect(open).toHaveLength(1);
    const q = open[0];
    expect(q.question).toContain("Main");
    expect(q.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(q.options.every((o) => o.image_path && fs.existsSync(o.image_path))).toBe(true);
    expect(q.options[0].description).toContain("shift 1 layer");
    asks.answer(q.id, { choice_ids: ["b"] });
    const out = await running;
    expect(out.ask).toMatchObject({ status: "answered" });
    expect(out.chosen_variant_id).toBe("b");
    expect(out.next).toContain('variant_id: "b"');
  });

  it("names the folder the copies are really in when asking", async () => {
    const asks = new AskStore();
    const { ctx } = fakeAe({ ...createScript(), snapshotFrame: [snapshot(), snapshot()] }, { asks });
    const running = tool("ae_variants").handler(createArgs({ wait_seconds: 20, folder_name: "my tries" }), ctx);
    let open = asks.open();
    for (let i = 0; i < 200 && open.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      open = asks.open();
    }
    expect(open[0].context).toContain("'my tries'");
    expect(open[0].context).not.toContain("chroma variants");
    asks.answer(open[0].id, { choice_ids: ["a"] });
    await running;
  });

  it("does not point at pick or discard when the record could not be stored", async () => {
    const { ctx, dir } = fakeAe({ ...createScript(), snapshotFrame: [snapshot(), snapshot()] });
    // A file where the variants folder should be: the record can't be written.
    fs.writeFileSync(path.join(dir, "variants"), "not a folder");
    const out = await tool("ae_variants").handler(createArgs({ ask: false }), ctx);
    expect(out.record_saved).toBe(false);
    expect(out.next).toContain("could not be stored");
    expect(out.next).toContain("Main [a] (comp 11)");
    expect(out.next).not.toContain("ae_variants_pick {");
  });

  it("says so when there is no panel to ask in", async () => {
    const { ctx } = fakeAe({ ...createScript(), snapshotFrame: [snapshot(), snapshot()] });
    const out = await tool("ae_variants").handler(createArgs(), ctx);
    expect(out.ask).toMatchObject({ ok: false, error: "panel_unavailable" });
    expect(out.chosen_variant_id).toBeUndefined();
    expect(out.applied).toBe(true);
  });
});

describe("ae_variants_pick and ae_variants_discard", () => {
  const record = (ctx: ToolContext): SetRecord => {
    const rec: SetRecord = {
      set_id: "vs_0123abcd",
      created_at: "2026-11-03T10:00:00.000Z",
      project_path: "<unsaved>",
      folder_name: "chroma variants",
      original: { comp_id: 1, name: "Main", digest: "d1", digest_basis: "layers" },
      times: [2],
      variants: [
        { id: "a", label: "Gentle", ops: [{ op: "shift_time", layers: [{ index: 1 }], offset: 0.5 }], copy_comp_id: 11, copy_name: "Main [a]" },
        { id: "b", label: "Snappy", ops: [{ op: "ease", layers: [{ index: 1 }], ease: "snappy" }], copy_comp_id: 12, copy_name: "Main [b]" },
      ],
    };
    expect(saveSet(ctx, rec)).toBe(true);
    return rec;
  };
  const pickArgs = (extra: Record<string, unknown> = {}) => AeVariantsPickSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", variant_id: "b", expect: expectArg, ...extra });

  const pickScript = (overrides: Record<string, unknown> = {}) => ({
    variantsRead: [
      { original: orig({ digest: "d1" }), copies: [], probes: [] },
      {
        original: orig({ digest: "d9" }),
        copies: [
          { comp_id: 11, exists: false },
          { comp_id: 12, exists: false },
        ],
        probes: [{ ok: true, kind: "ease", actual: [{ key: 1, in_influence: 16, out_influence: 20, in_interp: "bezier", out_interp: "bezier" }] }],
      },
    ],
    variantsPromote: [
      {
        original: orig(),
        changes: [{ op: "ease", layers: ["Title"], curve: [0.2, 0, 0, 1] }],
        probes: [{ comp_id: 1, kind: "ease", layer_index: 1, path: [TRANSFORM, "ADBE Position"], keys: [{ key: 1, out_influence: 20 }] }],
        cleanup: { removed: [11, 12], parked: [], skipped: [], folder_removed: true },
        ...overrides,
      },
    ],
  });

  it("replays the chosen spec on the original with the digest and the copies, then logs and drops the set", async () => {
    const { ctx, calls, dir } = fakeAe(pickScript());
    record(ctx);
    const out = await tool("ae_variants_pick").handler(pickArgs(), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "variantsRead", "variantsPromote", "variantsRead"]);
    const write = calls[2].script;
    expect(write).toContain('"digest":"d1"');
    expect(write).toContain('"copy_ids":[11,12]');
    expect(write).toContain('"cleanup":"delete"');
    expect(write).toContain('"curve":[0.2,0,0,1]');
    expect(write).not.toContain('"offset":0.5');
    expect(calls[3].script).toContain('"kind":"ease"');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.applied_variant).toEqual({ id: "b", label: "Snappy" });
    expect(out.cleanup.removed).toEqual([11, 12]);
    // The pick is logged apart from the taste file, and the set is gone.
    const logFile = path.join(dir, "variant-picks.jsonl");
    expect(out.pick_log).toBe(logFile);
    const entry = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    expect(entry).toMatchObject({ set_id: "vs_0123abcd", comp: { id: 1, name: "Main" }, picked: { id: "b", label: "Snappy" }, cleanup: "delete" });
    expect(entry.rejected.map((r: { id: string }) => r.id)).toEqual(["a"]);
    expect(loadSet(ctx, "vs_0123abcd")).toBeNull();
    expect(fs.existsSync(path.join(dir, "taste.json"))).toBe(false);
  });

  it("flags a copy that is still there after a delete and a property that didn't take", async () => {
    const script = pickScript();
    script.variantsRead[1] = {
      original: orig({ digest: "d9" }),
      copies: [{ comp_id: 11, exists: true }, { comp_id: 12, exists: false }],
      probes: [{ ok: true, kind: "ease", actual: [{ key: 1, in_influence: 16, out_influence: 60, in_interp: "bezier", out_interp: "bezier" }] }],
    } as never;
    const { ctx } = fakeAe(script);
    record(ctx);
    const out = await tool("ae_variants_pick").handler(pickArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { message: string }) => m.message)).toEqual(
      expect.arrayContaining(["Out influence differs", "A copy that was removed is still in the project"])
    );
  });

  it("parks the copies when asked", async () => {
    const script = pickScript({ cleanup: { removed: [], parked: [11, 12], skipped: [], folder_removed: false } });
    script.variantsRead[1] = {
      original: orig({ digest: "d9" }),
      copies: [{ comp_id: 11, exists: true, in_folder: true }, { comp_id: 12, exists: true, in_folder: true }],
      probes: [{ ok: true, kind: "ease", actual: [{ key: 1, in_influence: 16, out_influence: 20, in_interp: "bezier", out_interp: "bezier" }] }],
    } as never;
    const { ctx, calls } = fakeAe(script);
    record(ctx);
    const out = await tool("ae_variants_pick").handler(pickArgs({ cleanup: "park" }), ctx);
    expect(calls[2].script).toContain('"cleanup":"park"');
    expect(out.receipt.matches).toBe(true);
  });

  it("refuses a set from another project before touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    record(ctx);
    const other = AeVariantsPickSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", variant_id: "a", expect: { project_path: "C:/other.aep" } });
    expect(await tool("ae_variants_pick").handler(other, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    const otherDiscard = AeVariantsDiscardSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", expect: { project_path: "C:/other.aep" } });
    expect(await tool("ae_variants_discard").handler(otherDiscard, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });

  it("refuses a set without a digest before touching AE, and keeps it for a discard", async () => {
    const { ctx, calls } = fakeAe(pickScript());
    const rec = record(ctx);
    saveSet(ctx, { ...rec, original: { comp_id: 1, name: "Main" } });
    const out = await tool("ae_variants_pick").handler(pickArgs(), ctx);
    expect(out).toMatchObject({ ok: false, error: "no_digest" });
    expect(calls).toEqual([]);
    expect(loadSet(ctx, "vs_0123abcd")).not.toBeNull();
  });

  it("matches the project path the way the host guard does", async () => {
    expect(normProjectPath("F:\\Proj\\a.aep")).toBe(normProjectPath("F:/Proj/a.aep/"));
    expect(normProjectPath("<unsaved>")).toBe("<unsaved>");
    // A differently spelled path gets past the set check and on to the host guard (which the fake AE answers with <unsaved>).
    const { ctx, calls } = fakeAe(pickScript());
    const rec = record(ctx);
    saveSet(ctx, { ...rec, project_path: "F:\\Proj\\a.aep" });
    await expect(tool("ae_variants_pick").handler(pickArgs({ expect: { project_path: "F:/Proj/a.aep/" } }), ctx)).rejects.toThrow(/Target guard/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
    await expect(tool("ae_variants_discard").handler(AeVariantsDiscardSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", expect: { project_path: "F:/Proj/a.aep" } }), ctx)).rejects.toThrow(/Target guard/);
  });

  it("reports the original from the separate read-back, not the write's own script", async () => {
    const { ctx } = fakeAe(pickScript({ original: { comp_id: 1, name: "Main", numLayers: 2, duration: 99 } }));
    record(ctx);
    const out = await tool("ae_variants_pick").handler(pickArgs(), ctx);
    expect(out.original.duration).toBe(4);
    expect(out.original.workAreaDuration).toBe(4);
  });

  it("discards by project only, so a deleted original comp does not strand the copies", async () => {
    const { ctx, calls } = fakeAe({
      variantsRead: [
        { original: null, copies: [{ comp_id: 11, exists: true, in_folder: true }, { comp_id: 12, exists: true, in_folder: true }], probes: [] },
        { original: null, copies: [{ comp_id: 11, exists: false }, { comp_id: 12, exists: false }], probes: [] },
      ],
      variantsDiscard: [{ cleanup: { removed: [11, 12], parked: [], skipped: [], folder_removed: true } }],
    });
    record(ctx);
    const out = await tool("ae_variants_discard").handler(AeVariantsDiscardSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", expect: { project_path: "<unsaved>", comp_id: 1 } }), ctx);
    expect(out.receipt.matches).toBe(true);
    // Neither the guard nor the reads ask for the original comp.
    for (const c of calls) expect(c.script).not.toContain('"comp_id"');
  });

  it("refuses an unknown set, a wrong comp and an unknown variant before touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    expect(await tool("ae_variants_pick").handler(pickArgs(), ctx)).toMatchObject({ ok: false, error: "unknown_set" });
    record(ctx);
    expect(await tool("ae_variants_pick").handler(pickArgs({ comp_id: 2 }), ctx)).toMatchObject({ ok: false, error: "bad_args" });
    const out = await tool("ae_variants_pick").handler(pickArgs({ variant_id: "zzz" }), ctx);
    expect(out).toMatchObject({ ok: false, error: "unknown_variant" });
    expect(out.available.map((v: { id: string }) => v.id)).toEqual(["a", "b"]);
    expect(calls).toEqual([]);
    expect(loadSet(ctx, "vs_0123abcd")).not.toBeNull();
  });

  it("keeps the set when the host refuses the pick (drift)", async () => {
    const { ctx } = fakeAe({
      variantsRead: [{ original: orig({ digest: "d1" }), copies: [], probes: [] }],
      variantsPromote: [
        () => {
          throw new Error("Comp changed after the variants were made");
        },
      ],
    });
    record(ctx);
    await expect(tool("ae_variants_pick").handler(pickArgs(), ctx)).rejects.toThrow(/changed after/);
    expect(loadSet(ctx, "vs_0123abcd")).not.toBeNull();
  });

  it("discard removes every copy and drops the set", async () => {
    const { ctx, calls } = fakeAe({
      variantsRead: [
        { original: orig(), copies: [], probes: [] },
        { original: orig(), copies: [{ comp_id: 11, exists: false }, { comp_id: 12, exists: false }], probes: [] },
      ],
      variantsDiscard: [{ cleanup: { removed: [11, 12], parked: [], skipped: [], folder_removed: true } }],
    });
    record(ctx);
    const out = await tool("ae_variants_discard").handler(AeVariantsDiscardSchema.parse({ comp_id: 1, set_id: "vs_0123abcd", expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "variantsRead", "variantsDiscard", "variantsRead"]);
    expect(calls[2].script).toContain('"copy_ids":[11,12]');
    expect(out.receipt.matches).toBe(true);
    expect(out.cleanup.removed).toEqual([11, 12]);
    expect(loadSet(ctx, "vs_0123abcd")).toBeNull();
  });
});

// ---------- the host functions, under node:vm ----------

function cloneValue(v: unknown): unknown {
  return Array.isArray(v) ? v.map(cloneValue) : v;
}

function cloneNode(n: FakeProperty | FakeGroup): FakeProperty | FakeGroup {
  if (n instanceof FakeGroup) return new FakeGroup(n.name, n.matchName, n.props.map(cloneNode), n.propertyType === PropertyType.INDEXED_GROUP);
  const p = new FakeProperty(n.name, n.matchName, n.propertyValueType, cloneValue(n.staticValue), n.isSpatial);
  p.keys = n.keys.map((k) => ({
    ...k,
    value: cloneValue(k.value),
    inEase: k.inEase.map((e) => new KeyframeEase(e.speed, e.influence)),
    outEase: k.outEase.map((e) => new KeyframeEase(e.speed, e.influence)),
  }));
  for (const f of ["hasMin", "minValue", "hasMax", "maxValue"]) (p as any)[f] = (n as any)[f];
  return p;
}

/** comp.duplicate for the fake DOM: same layers, same indexes, new ids, deep-copied properties. */
function withDuplicate(project: FakeProject, comp: FakeComp) {
  (comp as any).duplicate = () => {
    const copy = project.addComp(`${comp.name} 2`, comp.width, comp.height, comp.duration);
    for (const l of [...comp.stack].reverse()) {
      const c = new FakeLayer(copy, l.name, l.reflect.name);
      c.group = cloneNode(l.group) as FakeGroup;
      c.source = l.source;
      c.enabled = l.enabled;
      c.inPoint = l.inPoint;
      c.outPoint = l.outPoint;
      c.startTime = l.startTime;
      copy.stack.unshift(c);
    }
    return copy;
  };
}

function addFill(layer: FakeLayer, rgba: number[]) {
  const color = new FakeProperty("Color", "ADBE Fill-0002", PropertyValueType.COLOR, rgba);
  const fill = new FakeGroup("Fill", "ADBE Fill", [color]);
  const fx = layer.property("ADBE Effect Parade") as FakeGroup;
  fx.props.push(fill);
  fill.parentProperty = fx;
  return color;
}

/** Main (4s): Title (1) with keyed Position and Opacity and a fill, Logo (2) static with a fill, BG (3). */
function scene() {
  const project = new FakeProject();
  (project as any).items = { addFolder: (name: string) => project.addFolder(name) };
  const comp = project.addComp("Main", 640, 360, 4);
  comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1, 4);
  const logo = comp.layers.addSolid([1, 1, 1], "Logo", 100, 100, 1, 4);
  const title = comp.layers.addSolid([1, 1, 1], "Title", 200, 50, 1, 4);
  const pos = title.transform("Position");
  pos.setValueAtTime(0, [100, 100, 0]);
  pos.setValueAtTime(1, [300, 100, 0]);
  const op = title.transform("Opacity");
  op.setValueAtTime(0, 0);
  op.setValueAtTime(1, 100);
  const titleFill = addFill(title, [1, 0, 0, 1]);
  titleFill.setValueAtTime(0, [1, 0, 0, 1]);
  titleFill.setValueAtTime(1, [0, 1, 0, 1]);
  const logoFill = addFill(logo, [0, 0, 1, 1]);
  logo.transform("Opacity");
  const logoOpacity = logo.transform("Opacity") as any;
  logoOpacity.hasMin = true;
  logoOpacity.minValue = 0;
  logoOpacity.hasMax = true;
  logoOpacity.maxValue = 100;
  withDuplicate(project, comp);
  return { project, comp, title, logo, titleFill, logoFill, pos, op };
}

const load = (project: FakeProject, extra: string[] = []) => loadHost(project, ["variants.jsx", ...extra]);
const hostVariants = (...lists: unknown[][]) => lists.map((ops, i) => ({ id: String.fromCharCode(97 + i), label: `Variant ${i}`, ops }));
const valid = { op: "shift_time", layers: [{ index: 1 }], stagger: 0.1 };
const FOLDER = "chroma variants";
const itemNames = (p: FakeProject) => p.all.map((i) => i.name);
/** Comps and folders only: solids are project items too. */
const structure = (p: FakeProject) => p.all.filter((i) => !(i instanceof FakeFootage)).map((i) => i.name);

describe("variants.jsx", () => {
  it("makes one copy per variant in the variants folder, in one undo group, and leaves the original alone", () => {
    const { project, comp, title, logo } = scene();
    const { A, undo } = load(project);
    const before = plain(A.variantsRead({ comp_id: comp.id }));
    const ops = {
      a: [
        { op: "color", layers: [{ name: "Title" }, { name: "Logo" }], path: FILL, color: [0.2, 0.4, 0.6] },
        { op: "offset", layers: [{ name: "Title" }], delta: [50, 10] },
      ],
      b: [
        { op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Opacity"], value: 40 },
        { op: "shift_time", layers: [{ name: "Title" }, { name: "Logo" }], offset: 0.5, stagger: 0.25 },
        { op: "comp_duration", seconds: 6 },
      ],
      c: [{ op: "ease", layers: [{ name: "Title" }], curve: [0.25, 0.1, 0.25, 1] }],
    };
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants(ops.a, ops.b, ops.c), expect: GUARD }));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(made.copies.map((c: { variant_id: string }) => c.variant_id)).toEqual(["a", "b", "c"]);
    expect(made.copies.map((c: { name: string }) => c.name)).toEqual(["Main [a]", "Main [b]", "Main [c]"]);
    expect(made.folder.name).toBe(FOLDER);
    const folder = project.all.find((i) => i.name === FOLDER) as any;
    expect(folder.numItems).toBe(3);
    expect(project.all.filter((i) => i instanceof FakeComp && (i as FakeComp).parentFolder === folder)).toHaveLength(3);

    // The original is untouched, and says so by its digest.
    expect(title.transform("Position").keyValue(1)).toEqual([100, 100, 0]);
    expect(logo.transform("Opacity").value).toBe(100);
    expect(title.startTime).toBe(0);
    expect(comp.duration).toBe(4);
    expect(plain(A.variantsRead({ comp_id: comp.id })).original.digest).toBe(before.original.digest);

    const [ca, cb, cc] = made.copies.map((c: { comp_id: number }) => project.itemByID(c.comp_id) as FakeComp);
    // a: colour on a static and a keyed fill (every key), alpha kept; the keyed Position moved key by key.
    expect(ca.layer(2)!.property(FILL[0])).toBeTruthy();
    const fillOf = (c: FakeComp, index: number) => {
      const fx = c.layer(index)!.property("ADBE Effect Parade") as FakeGroup;
      return (fx.property("ADBE Fill") as FakeGroup).property("ADBE Fill-0002") as FakeProperty;
    };
    expect(fillOf(ca, 2).value).toEqual([0.2, 0.4, 0.6, 1]);
    expect(fillOf(ca, 1).keys.map((k) => k.value)).toEqual([[0.2, 0.4, 0.6, 1], [0.2, 0.4, 0.6, 1]]);
    expect(ca.layer(1)!.transform("Position").keys.map((k) => k.value)).toEqual([[150, 110, 0], [350, 110, 0]]);
    // b: static value, staggered start times, a longer comp.
    expect(cb.layer(2)!.transform("Opacity").value).toBe(40);
    expect([cb.layer(1)!.startTime, cb.layer(2)!.startTime]).toEqual([0.5, 0.75]);
    expect(cb.duration).toBe(6);
    // c: the ease went on the keyed Position and Opacity of Title only.
    const posEase = cc.layer(1)!.transform("Position");
    expect(posEase.keyOutTemporalEase(1)[0]).toMatchObject({ influence: 25, speed: expect.closeTo(80, 5) });
    expect(posEase.keyInTemporalEase(2)[0]).toMatchObject({ influence: 75 });
    expect(posEase.keyInInterpolationType(1)).toBeDefined();
    const opEase = cc.layer(1)!.transform("Opacity");
    expect(opEase.keyOutTemporalEase(1)[0].speed).toBeCloseTo(40, 5);
    // The original's keys keep their ease.
    expect(title.transform("Position").keyOutTemporalEase(1)[0].influence).toBeCloseTo(16.666667, 4);

    // Every probe is something the read-back can check.
    const probes = made.copies.flatMap((c: { comp_id: number; probes: unknown[] }) => c.probes.map((p) => ({ ...(p as object), comp_id: c.comp_id })));
    expect(probes.length).toBeGreaterThan(5);
    const read = plain(A.variantsRead({ comp_id: comp.id, copy_ids: made.copies.map((c: { comp_id: number }) => c.comp_id), probes }));
    expect(read.copies.every((c: { exists: boolean; in_folder: boolean; numLayers: number }) => c.exists && c.in_folder && c.numLayers === 3)).toBe(true);
    expect(read.probes.every((p: { ok: boolean }) => p.ok)).toBe(true);
    expect(probeMismatches("host", probes, read.probes, 25)).toEqual([]);
    // A tampered copy shows up.
    cb.layer(1)!.startTime = 9;
    const again = plain(A.variantsRead({ comp_id: comp.id, probes }));
    expect(probeMismatches("host", probes, again.probes, 25).map((m) => m.message)).toContain("Start time differs");
  });

  it("plans without changing anything", () => {
    const { project, comp } = scene();
    const { A, undo } = load(project);
    const items = itemNames(project);
    const plan = plain(A.variantsPlan({ comp_id: comp.id, variants: hostVariants([{ op: "comp_duration", seconds: 9 }, { op: "ease", layers: [{ index: 1 }], curve: [0.2, 0, 0, 1] }], [valid]) }));
    expect(plan.dry_run).toBe(true);
    expect(plan.variants[0].changes).toEqual([
      { op: "comp_duration", layers: [], from: 4, to: 9 },
      { op: "ease", layers: ["Title", "Title"] },
    ]);
    expect(undo.begun).toBe(0);
    expect(itemNames(project)).toEqual(items);
  });

  it("refuses bad ops before creating or changing anything", () => {
    const { project, comp, logo } = scene();
    (logo.transform("Position") as any).dimensionsSeparated = true;
    const { A, undo } = load(project);
    const items = itemNames(project);
    const cases: Array<[unknown, RegExp]> = [
      [{ op: "color", layers: [{ name: "Title" }], path: [...FILL.slice(0, 2), "Nope"], color: [1, 0, 0] }, /not found/],
      [{ op: "color", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Opacity"], color: [1, 0, 0] }, /not a colour/],
      [{ op: "set_value", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Opacity"], value: 50 }, /has keyframes/],
      [{ op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Opacity"], value: 150 }, /above the property's maximum 100/],
      [{ op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Opacity"], value: -1 }, /below the property's minimum 0/],
      [{ op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Scale"], value: [1, 2, 3, 4] }, /2\.\.3 numbers/],
      [{ op: "set_value", layers: [{ name: "Logo" }], path: FILL, value: 1 }, /use the color op/],
      [{ op: "offset", layers: [{ name: "Logo" }], delta: [10, 0] }, /separated dimensions/],
      [{ op: "offset", layers: [{ name: "Title" }], delta: [1] }, /delta must be/],
      [{ op: "offset", layers: [{ name: "Title" }], delta: [1, 1], path: [TRANSFORM, "ADBE Opacity"] }, /position-like/],
      [{ op: "ease", layers: [{ name: "Logo" }], curve: [0.2, 0, 0, 1] }, /none of the layers/],
      [{ op: "ease", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Scale"], curve: [0.2, 0, 0, 1] }, /two keyframes/],
      [{ op: "ease", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Position"], curve: [0.3, -0.5, 0.5, 1] }, /spatial/],
      [{ op: "ease", layers: [{ name: "Title" }], curve: [0, 0, 1, 1] }, /x1 must be within/],
      [{ op: "shift_time", layers: [{ name: "Title" }] }, /non-zero/],
      [{ op: "shift_time", layers: [{ name: "Title" }], offset: 99999 }, /3 hour/],
      [{ op: "comp_duration", seconds: 0 }, /seconds/],
      [{ op: "shift_time", layers: [{ name: "Title" }, { index: 1 }], offset: 1 }, /selected twice/],
      [{ op: "shift_time", layers: [{ name: "Ghost" }], offset: 1 }, /No layer named "Ghost"/],
      [{ op: "shift_time", layers: [{ index: 9 }], offset: 1 }, /out of range/],
      [{ op: "wobble", layers: [{ index: 1 }] }, /Unknown op/],
    ];
    for (const [op, message] of cases) {
      expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([op], [valid]), expect: GUARD })).toThrow(message);
    }
    // An expression on the target counts too.
    (logo.transform("Opacity") as any).expressionEnabled = true;
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([{ op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Opacity"], value: 5 }], [valid]), expect: GUARD })).toThrow(/active expression/);
    // The error says which variant.
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [{ op: "comp_duration", seconds: 0 }]), expect: GUARD })).toThrow(/Variant "b"/);
    // Variant-level rules.
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid]), expect: GUARD })).toThrow(/2 to 6/);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: [{ id: "a", label: "A", ops: [valid] }, { id: "a", label: "A", ops: [valid] }], expect: GUARD })).toThrow(/used twice/);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([]  , [valid]), expect: GUARD })).toThrow(/at least one op/);
    expect(undo.begun).toBe(0);
    expect(itemNames(project)).toEqual(items);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => A.variantsCreate({ comp_id: 99999, variants: hostVariants([valid], [valid]), expect: GUARD })).toThrow(/No CompItem/);
  });

  it("refuses to make variants of a variant copy", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    expect(() => A.variantsPlan({ comp_id: made.copies[0].comp_id, variants: hostVariants([valid], [valid]) })).toThrow(/itself a variant copy/);
  });

  it("takes back its copies and the folder when a copy doesn't line up, inside the same undo group", () => {
    const { project, comp } = scene();
    const dup = (comp as any).duplicate;
    let calls = 0;
    (comp as any).duplicate = () => {
      const c = dup();
      calls++;
      if (calls === 2) c.layer(1).name = "Other";
      return c;
    };
    const { A, undo } = load(project);
    const items = itemNames(project);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD })).toThrow(/not "Title"/);
    expect(itemNames(project)).toEqual(items);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("reuses an existing folder and leaves it in place when a call fails", () => {
    const { project, comp } = scene();
    const folder = project.addFolder(FOLDER);
    const { A } = load(project);
    A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD });
    expect(project.all.filter((i) => i.name === FOLDER)).toHaveLength(1);
    expect(folder.numItems).toBe(2);
    // A second set gets its own names.
    const second = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    expect(second.copies.map((c: { name: string }) => c.name)).toEqual(["Main [a] 2", "Main [b] 2"]);
  });

  it("warns about shared precomps and expressions that name another comp", () => {
    const { project, comp, logo } = scene();
    const inner = project.addComp("Inner", 640, 360, 4);
    comp.layers.add(inner, 4);
    (logo.transform("Opacity") as any).expressionEnabled = true;
    (logo.transform("Opacity") as any).expression = 'comp("Inner").layer(1).transform.opacity';
    const { A } = load(project);
    const plan = plain(A.variantsPlan({ comp_id: comp.id, variants: hostVariants([valid], [valid]) }));
    expect(plan.warnings.shared_precomps).toEqual([{ layer_index: 1, layer: "Inner", source_id: inner.id, source: "Inner" }]);
    expect(plan.warnings.comp_expressions).toEqual([{ layer_index: 3, layer: "Logo", property: "Opacity" }]);
  });

  it("promotes: replays the spec on the original, removes the copies and the empty folder, in one undo group", () => {
    const { project, comp, title, logo } = scene();
    const { A, undo } = load(project);
    const digest = plain(A.variantsRead({ comp_id: comp.id })).original.digest;
    const ops = [
      { op: "color", layers: [{ name: "Title" }, { name: "Logo" }], path: FILL, color: [0.2, 0.4, 0.6] },
      { op: "shift_time", layers: [{ name: "Title" }], offset: 0.5 },
    ];
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants(ops, [valid]), expect: GUARD }));
    expect(undo.begun).toBe(1);
    const copyIds = made.copies.map((c: { comp_id: number }) => c.comp_id);
    const res = plain(A.variantsPromote({ comp_id: comp.id, ops, digest, copy_ids: copyIds, cleanup: "delete", expect: GUARD }));
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
    expect(title.startTime).toBe(0.5);
    expect(title.transform("Opacity").keys).toHaveLength(2);
    const fill = (l: FakeLayer) => ((l.property("ADBE Effect Parade") as FakeGroup).property("ADBE Fill") as FakeGroup).property("ADBE Fill-0002") as FakeProperty;
    expect(fill(logo).value).toEqual([0.2, 0.4, 0.6, 1]);
    expect(fill(title).keys.map((k) => k.value)).toEqual([[0.2, 0.4, 0.6, 1], [0.2, 0.4, 0.6, 1]]);
    expect(res.cleanup).toMatchObject({ removed: copyIds, parked: [], skipped: [], folder_removed: true });
    expect(structure(project)).toEqual(["Main"]);
    // What it set reads back as the probes say.
    const read = plain(A.variantsRead({ comp_id: comp.id, copy_ids: copyIds, probes: res.probes }));
    expect(probeMismatches("pick", res.probes, read.probes, 25)).toEqual([]);
    expect(cleanupMismatches(null, read, res)).toEqual([]);
  });

  it("parks the copies instead when asked", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    const copyIds = made.copies.map((c: { comp_id: number }) => c.comp_id);
    const res = plain(A.variantsPromote({ comp_id: comp.id, ops: [valid], copy_ids: copyIds, cleanup: "park", expect: GUARD }));
    expect(res.cleanup).toMatchObject({ removed: [], parked: copyIds, folder_removed: false });
    expect(structure(project)).toEqual(["Main", FOLDER, "Main [a]", "Main [b]"]);
  });

  it("refuses the pick when the original changed while the user chose, and changes nothing", () => {
    const { project, comp, title } = scene();
    const { A, undo } = load(project);
    const digest = plain(A.variantsRead({ comp_id: comp.id })).original.digest;
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    const copyIds = made.copies.map((c: { comp_id: number }) => c.comp_id);
    title.transform("Opacity").keys[0].value = 20; // the user edited
    const items = itemNames(project);
    let caught: any = null;
    try {
      A.variantsPromote({ comp_id: comp.id, ops: [valid], digest, copy_ids: copyIds, cleanup: "delete", expect: GUARD });
    } catch (e) {
      caught = e;
    }
    expect(caught.message).toMatch(/changed after the variants were made/);
    expect(caught.__kind).toBe("drift");
    expect(undo.begun).toBe(1);
    expect(title.startTime).toBe(0);
    expect(itemNames(project)).toEqual(items);
  });

  it("only ever removes comps inside the variants folder that nothing else uses", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    const [a, b] = made.copies.map((c: { comp_id: number }) => c.comp_id);
    const stranger = project.addComp("Precious", 640, 360, 2);
    // b is used by another comp.
    (project.itemByID(b) as any).usedIn = [comp];
    const res = plain(A.variantsDiscard({ copy_ids: [a, b, stranger.id, 424242], cleanup: "delete", expect: GUARD }));
    expect(res.cleanup.removed).toEqual([a]);
    expect(res.cleanup.skipped.map((s: { comp_id: number; reason: string }) => [s.comp_id, s.reason])).toEqual([
      [b, "used in another comp, left alone"],
      [stranger.id, `not a comp in the "${FOLDER}" folder, left alone`],
      [424242, "already gone"],
    ]);
    expect(res.cleanup.folder_removed).toBe(false);
    expect(project.itemByID(stranger.id)).not.toBeNull();
    expect(() => A.variantsDiscard({ copy_ids: [a], cleanup: "keep", expect: GUARD })).toThrow(/cleanup/);
  });

  it("keeps the digest the same when only the time indicator moves", () => {
    for (const extra of [["fingerprint.jsx"], []]) {
      const { project, comp, title } = scene();
      // Property.value is the value at the comp's time, as in AE.
      for (const prop of [title.transform("Opacity"), title.transform("Position")] as any[]) {
        Object.defineProperty(prop, "value", { get: () => prop.valueAtTime(comp.time, false), configurable: true });
      }
      const { A } = load(project, extra);
      comp.time = 0;
      const a = plain(A.variantsRead({ comp_id: comp.id })).original;
      comp.time = 0.5;
      const b = plain(A.variantsRead({ comp_id: comp.id })).original;
      expect(b.digest).toBe(a.digest);
      expect(a.digest_basis).toBe(extra.length ? "fingerprint" : "layers");
      // A real edit still changes it.
      title.transform("Opacity").keys[1].value = 90;
      expect(plain(A.variantsRead({ comp_id: comp.id })).original.digest).not.toBe(a.digest);
    }
  });

  it("variantsCreate returns the digest it took before writing", () => {
    const { project, comp } = scene();
    const { A } = load(project, ["fingerprint.jsx"]);
    const digest = plain(A.variantsRead({ comp_id: comp.id })).original.digest;
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants([valid], [valid]), expect: GUARD }));
    expect(made.original.digest).toBe(digest);
    expect(made.original.digest_basis).toBe("fingerprint");
  });

  it("every ease preset passes the schema and the host's curve check", () => {
    for (const [name, curve] of Object.entries(EASE_PRESETS)) {
      expect(EASE_CURVE_ARRAY_SCHEMA.safeParse([...curve]).success, name).toBe(true);
      const { project, comp, logo } = scene();
      const op = logo.transform("Opacity");
      op.setValueAtTime(0, 0);
      op.setValueAtTime(1, 100);
      const { A } = load(project);
      const made = plain(
        A.variantsCreate({ comp_id: comp.id, variants: hostVariants([{ op: "ease", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Opacity"], curve: [...curve] }], [valid]), expect: GUARD })
      );
      expect(made.copies[0].probes[0].kind, name).toBe("ease");
    }
  });

  it("refuses a locked layer before anything is made", () => {
    const { project, comp, logo } = scene();
    (logo as any).locked = true;
    const { A, undo } = load(project);
    const items = itemNames(project);
    const lockedVariants = hostVariants([valid], [{ op: "shift_time", layers: [{ name: "Logo" }], offset: 1 }]);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: lockedVariants, expect: GUARD })).toThrow(/locked/);
    expect(undo.begun).toBe(0);
    expect(itemNames(project)).toEqual(items);
    expect(() => A.variantsPlan({ comp_id: comp.id, variants: lockedVariants })).toThrow(/locked/);
  });

  it("set_value on a vector keeps the dimensions it was not given", () => {
    const { project, comp, logo } = scene();
    const scale = logo.transform("Scale") as any;
    scale.staticValue = [100, 100, 80];
    const { A } = load(project);
    const made = plain(
      A.variantsCreate({ comp_id: comp.id, variants: hostVariants([{ op: "set_value", layers: [{ name: "Logo" }], path: [TRANSFORM, "ADBE Scale"], value: [50, 60] }], [valid]), expect: GUARD })
    );
    expect(made.copies[0].probes[0].expected).toEqual([[50, 60, 80]]);
  });

  it("eases in the animate.jsx order and expects the speeds back", () => {
    const { project, comp, title } = scene();
    const op = title.transform("Opacity") as any;
    const order: string[] = [];
    for (const fn of ["setTemporalAutoBezierAtKey", "setTemporalContinuousAtKey", "setInterpolationTypeAtKey", "setTemporalEaseAtKey"]) {
      const orig = op[fn]?.bind(op);
      op[fn] = (...a: unknown[]) => {
        order.push(fn);
        return orig ? orig(...a) : undefined;
      };
    }
    const { A } = load(project);
    const res = plain(
      A.variantsPromote({
        comp_id: comp.id,
        ops: [{ op: "ease", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Opacity"], curve: [0.25, 0.1, 0.25, 1] }],
        copy_ids: [],
        cleanup: "delete",
        expect: GUARD,
      })
    );
    expect(order.slice(0, 4)).toEqual(["setTemporalAutoBezierAtKey", "setTemporalContinuousAtKey", "setInterpolationTypeAtKey", "setTemporalEaseAtKey"]);
    const keys = res.probes[0].keys;
    expect(keys[0].out_speed).toBeCloseTo((0.1 / 0.25) * 100, 3);
    const read = plain(A.variantsRead({ comp_id: comp.id, probes: res.probes }));
    expect(read.probes[0].actual[0].out_speed).toBeCloseTo(keys[0].out_speed, 3);
    expect(probeMismatches("t", res.probes, read.probes, 25)).toEqual([]);
  });

  it("reads the digest and copy state without touching the project", () => {
    const { project, comp, title } = scene();
    const { A, undo } = load(project, ["fingerprint.jsx"]);
    const a = plain(A.variantsRead({ comp_id: comp.id, copy_ids: [comp.id, 31337] }));
    const b = plain(A.variantsRead({ comp_id: comp.id }));
    expect(a.original.digest).toMatch(/^[0-9a-f]{16}-\d+$/);
    expect(a.original.digest_basis).toBe("fingerprint");
    expect(a.original.digest).toBe(b.original.digest);
    expect(a.copies).toMatchObject([{ comp_id: comp.id, exists: true, name: "Main", numLayers: 3, in_folder: false }, { comp_id: 31337, exists: false }]);
    title.transform("Opacity").keys[1].value = 90;
    expect(plain(A.variantsRead({ comp_id: comp.id })).original.digest).not.toBe(a.original.digest);
    expect(undo.begun).toBe(0);
  });

  it("reports a probe that can't be read instead of throwing", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const read = plain(
      A.variantsRead({
        comp_id: comp.id,
        probes: [
          { comp_id: comp.id, kind: "values", layer_index: 1, path: [TRANSFORM, "ADBE Nope"] },
          { comp_id: comp.id, kind: "start_time", layer_index: 99 },
          { comp_id: 123456, kind: "comp_duration" },
        ],
      })
    );
    expect(read.probes.map((p: { ok: boolean }) => p.ok)).toEqual([false, false, false]);
    expect(read.probes[0].error).toMatch(/not found/);
    expect(read.probes[1].error).toMatch(/out of range/);
  });
});

describe("variants.jsx: overlapping ops, easing, bounds", () => {
  const titleShift = (offset: number) => ({ op: "shift_time", layers: [{ name: "Title" }], offset });

  it("refuses two ops on one target before anything is made, in plan, create and promote", () => {
    const { project, comp } = scene();
    const { A, undo } = load(project);
    const items = itemNames(project);
    const cases: Array<[unknown[], RegExp]> = [
      [[titleShift(0.5), titleShift(0.25)], /start time of "Title" is already changed by op 1/],
      [[{ op: "offset", layers: [{ name: "Logo" }, { name: "Title" }], delta: [10, 0] }, { op: "offset", layers: [{ name: "Title" }], delta: [0, 10] }], /already changed by op 1/],
      [[{ op: "color", layers: [{ name: "Logo" }], path: FILL, color: [1, 0, 0] }, { op: "color", layers: [{ index: 2 }], path: FILL, color: [0, 1, 0] }], /already changed by op 1/],
      [[{ op: "ease", layers: [{ name: "Title" }], curve: [0.2, 0, 0, 1] }, { op: "ease", layers: [{ name: "Title" }], curve: [0.5, 0, 0.5, 1] }], /already changed by op 1/],
      // The same property by match name and by display name.
      [[{ op: "offset", layers: [{ name: "Title" }], delta: [5, 5] }, { op: "offset", layers: [{ name: "Title" }], path: ["Transform", "Position"], delta: [0, 5] }], /already changed by op 1/],
      [[{ op: "comp_duration", seconds: 3 }, { op: "comp_duration", seconds: 5 }], /comp duration is already changed/],
    ];
    for (const [ops, message] of cases) {
      expect(() => A.variantsPlan({ comp_id: comp.id, variants: hostVariants(ops, [valid]) })).toThrow(message);
      expect(() => A.variantsCreate({ comp_id: comp.id, variants: hostVariants(ops, [valid]), expect: GUARD })).toThrow(message);
      expect(() => A.variantsPromote({ comp_id: comp.id, ops, copy_ids: [], cleanup: "delete", expect: GUARD })).toThrow(message);
    }
    expect(undo.begun).toBe(0);
    expect(itemNames(project)).toEqual(items);
    // Different targets are fine.
    expect(() => A.variantsPlan({ comp_id: comp.id, variants: hostVariants([titleShift(0.5), { op: "shift_time", layers: [{ name: "Logo" }], offset: 0.5 }], [valid]) })).not.toThrow();
  });

  it("accepts an offset and an ease on one property, and both probes read back", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const ops = [{ op: "offset", layers: [{ name: "Title" }], delta: [5, 5] }, { op: "ease", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Position"], curve: [0.2, 0, 0, 1] }];
    expect(() => A.variantsPlan({ comp_id: comp.id, variants: hostVariants(ops, [valid]) })).not.toThrow();
    const made = plain(A.variantsCreate({ comp_id: comp.id, variants: hostVariants(ops, [valid]), expect: GUARD }));
    const probes = made.copies.flatMap((c: { comp_id: number; probes: unknown[] }) => c.probes.map((p) => ({ ...(p as object), comp_id: c.comp_id })));
    expect(probes.length).toBeGreaterThan(1);
    const read = plain(A.variantsRead({ comp_id: comp.id, copy_ids: made.copies.map((c: { comp_id: number }) => c.comp_id), probes }));
    expect(read.probes.every((p: { ok: boolean }) => p.ok)).toBe(true);
    expect(probeMismatches("host", probes, read.probes, 25)).toEqual([]);
  });

  it("refuses to ease a property that has no number to ease, in plan too", () => {
    const { project, comp, title } = scene();
    const text = new FakeProperty("Source", "ADBE Test Text", PropertyValueType.TEXT_DOCUMENT, "x");
    text.setValueAtTime(0, "a");
    text.setValueAtTime(1, "b");
    const fx = title.property("ADBE Effect Parade") as FakeGroup;
    fx.props.push(text);
    text.parentProperty = fx;
    const { A, undo } = load(project);
    const items = itemNames(project);
    const variants = hostVariants([{ op: "ease", layers: [{ name: "Title" }], path: ["ADBE Effect Parade", "ADBE Test Text"], curve: [0.2, 0, 0, 1] }], [valid]);
    expect(() => A.variantsPlan({ comp_id: comp.id, variants })).toThrow(/can't be eased/);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants, expect: GUARD })).toThrow(/can't be eased/);
    expect(undo.begun).toBe(0);
    expect(itemNames(project)).toEqual(items);
  });

  it("refuses a shift under one frame, which the read-back could not see", () => {
    const { project, comp } = scene();
    const { A, undo } = load(project);
    const tiny = hostVariants([{ op: "shift_time", layers: [{ name: "Title" }, { name: "Logo" }], stagger: 0.02 }], [valid]);
    expect(() => A.variantsCreate({ comp_id: comp.id, variants: tiny, expect: GUARD })).toThrow(/at least one frame/);
    expect(() => A.variantsPlan({ comp_id: comp.id, variants: hostVariants([{ op: "shift_time", layers: [{ name: "Title" }], offset: 0.01 }], [valid]) })).toThrow(/at least one frame/);
    expect(undo.begun).toBe(0);
    expect(() => A.variantsPlan({ comp_id: comp.id, variants: hostVariants([{ op: "shift_time", layers: [{ name: "Title" }], offset: 0.04 }], [valid]) })).not.toThrow();
  });

  it("caps the probe lists at 500 and says so, while still writing every key", () => {
    const { project, comp, title } = scene();
    const pos = title.transform("Position") as any;
    pos.keys = [];
    const op = title.transform("Opacity") as any;
    op.keys = [];
    for (let i = 0; i < 600; i++) {
      pos.setValueAtTime(i * 0.001, [i, 0, 0]);
      op.setValueAtTime(i * 0.001, i % 100);
    }
    const { A } = load(project);
    const made = plain(
      A.variantsCreate({
        comp_id: comp.id,
        variants: hostVariants(
          [
            { op: "offset", layers: [{ name: "Title" }], delta: [1, 0] },
            { op: "ease", layers: [{ name: "Title" }], path: [TRANSFORM, "ADBE Opacity"], curve: [0.2, 0, 0, 1] },
          ],
          [valid]
        ),
        expect: GUARD,
      })
    );
    const [offsetProbe, easeProbe] = made.copies[0].probes;
    expect(offsetProbe.expected).toHaveLength(500);
    expect(offsetProbe.truncated).toBe(true);
    expect(easeProbe.keys).toHaveLength(500);
    expect(easeProbe.truncated).toBe(true);
    const copy = project.itemByID(made.copies[0].comp_id) as FakeComp;
    expect((copy.layer(1).property(TRANSFORM) as any).property("ADBE Position").keys[599].value[0]).toBe(600);
  });

  it("promote does not report a duration it just wrote", () => {
    const { project, comp } = scene();
    const { A } = load(project);
    const res = plain(A.variantsPromote({ comp_id: comp.id, ops: [{ op: "comp_duration", seconds: 6 }], copy_ids: [], cleanup: "delete", expect: GUARD }));
    expect(res.original.duration).toBeUndefined();
    expect(res.original.workAreaDuration).toBeUndefined();
    expect(plain(A.variantsRead({ comp_id: comp.id })).original.duration).toBe(6);
  });

  it("reads without an original when no comp_id is given", () => {
    const { project } = scene();
    const { A } = load(project);
    expect(plain(A.variantsRead({ copy_ids: [31337] })).original).toBeNull();
  });
});
