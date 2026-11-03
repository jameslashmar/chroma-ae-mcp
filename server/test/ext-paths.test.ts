import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AePathConnectorSchema,
  AePathLinkSchema,
  AePathOperatorSchema,
  AePathReadSchema,
  AePathWriteSchema,
  applyPathOperation,
  catmullRomTangents,
  connectorMismatches,
  flatten,
  linkMismatches,
  mirrorPath,
  operatorMismatches,
  pathChecksum,
  pathLength,
  pathWriteMismatches,
  pathsTools,
  PathMathError,
  resamplePath,
  reversePath,
  smoothPath,
  toPathData,
  type PathData,
} from "../src/tools/ext/paths.js";
import {
  FakeGroup,
  FakeProject,
  FakeProperty,
  GUARD,
  loadHost,
  PropertyType,
  PropertyValueType,
  Shape,
  type FakeComp,
  type FakeLayer,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => pathsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const shapeTarget = { layer: { index: 1 }, shape: { group: { index: 1 }, path: { index: 1 } } };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-paths-q-"));
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
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const SQUARE: PathData = {
  vertices: [[0, 0], [100, 0], [100, 100], [0, 100]],
  inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  closed: true,
};

/** What pathsRead returns for a path. */
function readout(p: PathData, extra: Record<string, unknown> = {}) {
  return {
    kind: "shape",
    layer: { index: 1, id: 7, name: "Shape Layer 1" },
    group: { index: 1, name: "Group 1" },
    path: { closed: p.closed, vertexCount: p.vertices.length, vertices: p.vertices, inTangents: p.inTangents, outTangents: p.outTangents, truncated: false },
    feather_points: 0,
    numKeys: 0,
    key_times: [],
    expression: { enabled: false, text: "", error: "" },
    ...extra,
  };
}

describe("schemas", () => {
  const base = { comp_id: 1, target: shapeTarget, expect: expectArg };

  it("a path target needs exactly one of mask or shape", () => {
    expect(AePathReadSchema.safeParse({ comp_id: 1, target: { layer: { index: 1 } } }).success).toBe(false);
    expect(AePathReadSchema.safeParse({ comp_id: 1, target: { layer: { index: 1 }, mask: { index: 1 }, shape: {} } }).success).toBe(false);
    expect(AePathReadSchema.safeParse({ comp_id: 1, target: { layer: { index: 1 }, mask: { name: "Mask 1" } } }).success).toBe(true);
    expect(AePathReadSchema.safeParse({ comp_id: 1, target: { layer: { index: 1 }, shape: {} } }).success).toBe(true);
    expect(AePathReadSchema.safeParse({ comp_id: 1, target: { layer: { index: 1 }, mask: {} } }).success).toBe(false);
  });

  it("ae_path_write pairs each operation with its parameters", () => {
    const path = { vertices: [[0, 0], [1, 1]] };
    expect(AePathWriteSchema.safeParse({ ...base, operation: "set", path }).success).toBe(true);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "set" }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "reverse", path }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "reverse" }).success).toBe(true);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "resample" }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "resample", resample: { count: 8 } }).success).toBe(true);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "resample", resample: { count: 8, spacing: 5 } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "resample", resample: { count: 1 } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "smooth", smooth: { method: "chaikin", iterations: 5 } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "mirror", mirror: { axis: "x" } }).success).toBe(true);
    expect(AePathWriteSchema.safeParse({ ...base, operation: "mirror", mirror: { axis: "z" } }).success).toBe(false);
  });

  it("ae_path_write refuses mismatched tangents, non-finite numbers and too many vertices, and needs expect", () => {
    const op = { operation: "set", comp_id: 1, target: shapeTarget, expect: expectArg };
    expect(AePathWriteSchema.safeParse({ ...op, path: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]] } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...op, path: { vertices: [[0, 0], [Infinity, 1]] } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...op, path: { vertices: Array.from({ length: 501 }, (_, i) => [i, 0]) } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ ...op, path: { vertices: [[0, 0]] } }).success).toBe(false);
    expect(AePathWriteSchema.safeParse({ operation: "reverse", comp_id: 1, target: shapeTarget }).success).toBe(false);
  });

  it("ae_path_operator pairs the operator with its settings and rejects clashes", () => {
    const op = { comp_id: 1, layer: { index: 1 }, group: { index: 1 }, expect: expectArg };
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1 } } }).success).toBe(true);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "trim", trim: { end: 50, draw_on: { start_time: 0, duration: 1 } } }).success).toBe(false);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "trim", trim: { end: 120 } }).success).toBe(false);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "trim", offset: { amount: 1 } }).success).toBe(false);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "offset", offset: { line_join: "round" } }).success).toBe(true);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "repeater", repeater: { grid: { columns: 3, rows: 2, spacing: [10, 10] } } }).success).toBe(true);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "repeater", repeater: { copies: 3, grid: { columns: 3, rows: 2, spacing: [10, 10] } } }).success).toBe(false);
    expect(AePathOperatorSchema.safeParse({ ...op, operator: "repeater", repeater: { grid: { columns: 500, rows: 500, spacing: [1, 1] } } }).success).toBe(false);
    expect(AePathOperatorSchema.safeParse({ ...op, group: {}, operator: "trim" }).success).toBe(false);
  });

  it("ae_path_link takes a source to link or unlink alone", () => {
    const t = { comp_id: 1, target: shapeTarget, expect: expectArg };
    expect(AePathLinkSchema.safeParse({ ...t, source: { layer: { index: 2 }, mask: { index: 1 } } }).success).toBe(true);
    expect(AePathLinkSchema.safeParse(t).success).toBe(false);
    expect(AePathLinkSchema.safeParse({ ...t, unlink: true }).success).toBe(true);
    expect(AePathLinkSchema.safeParse({ ...t, unlink: true, source: { layer: { index: 2 }, mask: { index: 1 } } }).success).toBe(false);
    expect(AePathLinkSchema.safeParse({ ...t, source: { layer: { index: 2 }, mask: { index: 1 } }, bake: true }).success).toBe(false);
  });

  it("ae_path_connector needs two endpoints and a valid stroke", () => {
    const c = { comp_id: 1, from: { layer: { name: "A" } }, to: { layer: { name: "B" } }, expect: expectArg };
    expect(AePathConnectorSchema.safeParse(c).success).toBe(true);
    expect(AePathConnectorSchema.safeParse({ ...c, to: undefined }).success).toBe(false);
    expect(AePathConnectorSchema.safeParse({ ...c, color: [1, 1, 2] }).success).toBe(false);
    expect(AePathConnectorSchema.safeParse({ ...c, style: "zigzag" }).success).toBe(false);
    expect(AePathConnectorSchema.safeParse({ ...c, from: { layer: { name: "A" }, point: [1] } }).success).toBe(false);
  });

  it("every mutating tool takes expect and ends with the safety guidance", () => {
    expect(pathsTools.map((t) => t.name)).toEqual(["ae_path_read", "ae_path_write", "ae_path_operator", "ae_path_link", "ae_path_connector"]);
    for (const t of pathsTools) expect(t.description).toContain("IMPORTANT:");
    for (const name of ["ae_path_write", "ae_path_operator", "ae_path_link", "ae_path_connector"]) {
      expect(tool(name).description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    }
  });
});

describe("path maths", () => {
  it("measures a path by arc length, curves included", () => {
    expect(pathLength(SQUARE)).toBeCloseTo(400, 6);
    expect(pathLength({ ...SQUARE, closed: false })).toBeCloseTo(300, 6);
    // A quarter circle from (100,0) to (0,100) with the standard handles.
    const k = 100 * 0.5522847498;
    const arc: PathData = { vertices: [[100, 0], [0, 100]], inTangents: [[0, 0], [k, 0]], outTangents: [[0, k], [0, 0]], closed: false };
    expect(pathLength(arc)).toBeCloseTo((Math.PI / 2) * 100, 1);
    expect(flatten(arc).points.length).toBe(25);
  });

  it("resamples a closed path to evenly spaced vertices, starting at the first", () => {
    const r = resamplePath(SQUARE, { count: 8 });
    expect(r.vertices).toHaveLength(8);
    expect(r.vertices[0]).toEqual([0, 0]);
    expect(r.vertices[1][0]).toBeCloseTo(50, 6);
    expect(r.vertices[2][0]).toBeCloseTo(100, 6);
    expect(r.vertices[3][1]).toBeCloseTo(50, 6);
    expect(r.closed).toBe(true);
    expect(r.inTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
  });

  it("resamples an open path including both ends, by count or by spacing", () => {
    const line: PathData = { vertices: [[0, 0], [100, 0]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false };
    expect(resamplePath(line, { count: 5 }).vertices.map((v) => v[0])).toEqual([0, 25, 50, 75, 100]);
    expect(resamplePath(line, { spacing: 20 }).vertices.map((v) => v[0])).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("fits tangents through resampled vertices of a curved path, unless told not to", () => {
    const k = 100 * 0.5522847498;
    const circle: PathData = {
      vertices: [[100, 0], [0, 100], [-100, 0], [0, -100]],
      inTangents: [[0, -k], [k, 0], [0, k], [-k, 0]],
      outTangents: [[0, k], [-k, 0], [0, -k], [k, 0]],
      closed: true,
    };
    const curved = resamplePath(circle, { count: 12 });
    expect(curved.outTangents.some((t) => t[0] !== 0 || t[1] !== 0)).toBe(true);
    expect(resamplePath(circle, { count: 12, keep_curves: false }).outTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
    // Every resampled vertex lies on the circle, within the flattening error.
    for (const v of curved.vertices) expect(Math.hypot(v[0], v[1])).toBeCloseTo(100, 0);
  });

  it("refuses what it can't resample", () => {
    expect(() => resamplePath({ ...SQUARE, vertices: [[5, 5], [5, 5], [5, 5]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]] }, { count: 4 })).toThrow(PathMathError);
    expect(() => resamplePath(SQUARE, { spacing: 0.1 })).toThrow(/at most 500/);
    expect(() => resamplePath(SQUARE, {})).toThrow(/count or spacing/);
  });

  it("smooths by Chaikin: closed doubles the vertices, open keeps its ends", () => {
    const c = smoothPath(SQUARE, { method: "chaikin" });
    expect(c.vertices).toHaveLength(8);
    expect(c.vertices[0]).toEqual([25, 0]);
    expect(c.vertices[1]).toEqual([75, 0]);
    const open: PathData = { vertices: [[0, 0], [100, 0], [100, 100]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: false };
    expect(smoothPath(open, { method: "chaikin" }).vertices).toEqual([[0, 0], [75, 0], [100, 25], [100, 100]]);
    expect(smoothPath(SQUARE, { method: "chaikin", iterations: 3 }).vertices).toHaveLength(32);
    expect(() => smoothPath({ ...SQUARE, vertices: Array.from({ length: 200 }, (_, i) => [i, i % 2]), inTangents: Array.from({ length: 200 }, () => [0, 0]), outTangents: Array.from({ length: 200 }, () => [0, 0]) }, { method: "chaikin", iterations: 2 })).toThrow(PathMathError);
  });

  it("smooths by Catmull-Rom without moving vertices", () => {
    const s = smoothPath(SQUARE, { method: "catmull_rom" });
    expect(s.vertices).toEqual(SQUARE.vertices);
    // The handle at (100,0) is a sixth of the slope between its neighbours (0,0) and (100,100).
    expect(s.outTangents[1][0]).toBeCloseTo(100 / 6, 6);
    expect(s.outTangents[1][1]).toBeCloseTo(100 / 6, 6);
    expect(s.inTangents[1][0]).toBeCloseTo(-100 / 6, 6);
    expect(smoothPath(SQUARE, { method: "catmull_rom", tension: 0 }).outTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
    const open = catmullRomTangents([[0, 0], [10, 0], [20, 0]], false);
    expect(open.outTangents.map((t) => t[0])).toEqual([10 / 3, 20 / 6, 10 / 3]);
  });

  it("mirrors across the middle of the path or a given line, flipping tangents", () => {
    const p: PathData = { vertices: [[10, 5], [60, 20]], inTangents: [[0, 0], [-3, 4]], outTangents: [[3, 4], [0, 0]], closed: false };
    const m = mirrorPath(p, { axis: "x" });
    expect(m.vertices).toEqual([[60, 5], [10, 20]]);
    expect(m.outTangents[0]).toEqual([-3, 4]);
    expect(m.inTangents[1]).toEqual([3, 4]);
    expect(mirrorPath(p, { axis: "y", about: 0 }).vertices).toEqual([[10, -5], [60, -20]]);
    // Mirrored twice about the same line it is the original again.
    expect(mirrorPath(mirrorPath(p, { axis: "x", about: 30 }), { axis: "x", about: 30 })).toEqual(p);
  });

  it("reverses a closed path around its first vertex and an open one end to end", () => {
    const p: PathData = { ...SQUARE, outTangents: [[1, 0], [2, 0], [3, 0], [4, 0]] };
    const r = reversePath(p);
    expect(r.vertices).toEqual([[0, 0], [0, 100], [100, 100], [100, 0]]);
    // The leading handle becomes the trailing one.
    expect(r.inTangents[0]).toEqual([1, 0]);
    expect(r.inTangents[1]).toEqual([4, 0]);
    expect(r.outTangents.every((t) => t[0] === 0)).toBe(true);
    const open = reversePath({ ...p, closed: false });
    expect(open.vertices[0]).toEqual([0, 100]);
    expect(reversePath(reversePath(p))).toEqual(p);
    expect(mirrorPath(SQUARE, { axis: "x", reverse_direction: true }).vertices[1][1]).toBe(100);
  });

  it("fills in missing tangents and the closed flag", () => {
    const d = toPathData({ vertices: [[0, 0], [5, 5]] });
    expect(d).toEqual({ vertices: [[0, 0], [5, 5]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: true });
    expect(toPathData({ vertices: [[0, 0], [5, 5]], closed: false }).closed).toBe(false);
  });

  it("checksums change with any coordinate", () => {
    const a = pathChecksum(SQUARE);
    expect(pathChecksum({ ...SQUARE, vertices: [[0, 0], [100, 0], [100, 100], [0, 100.5]] })).not.toBe(a);
    expect(pathChecksum({ ...SQUARE, outTangents: [[0, 0], [0, 0], [0, 0.5], [0, 0]] })).not.toBe(a);
    expect(pathChecksum(SQUARE)).toBe(a);
  });

  it("applyPathOperation routes each operation", () => {
    const args = (o: object) => AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, expect: expectArg, ...o });
    expect(applyPathOperation(args({ operation: "reverse" }), SQUARE).vertices[1]).toEqual([0, 100]);
    expect(applyPathOperation(args({ operation: "set", path: { vertices: [[1, 1], [2, 2]], closed: false } }), SQUARE).closed).toBe(false);
    expect(applyPathOperation(args({ operation: "resample", resample: { count: 8 } }), SQUARE).vertices).toHaveLength(8);
  });
});

describe("pathWriteMismatches", () => {
  const written = {};
  it("accepts the path that was written", () => {
    expect(pathWriteMismatches(SQUARE, readout(SQUARE), {}, written)).toEqual([]);
  });

  it("flags a vertex that moved, a count change, and an expression on top", () => {
    const moved = { ...SQUARE, vertices: [[0, 0], [100, 0], [100, 99], [0, 100]] };
    expect(pathWriteMismatches(SQUARE, readout(moved), {}, written).map((m) => m.path)).toEqual(["path.vertices[2]"]);
    const fewer = { ...SQUARE, vertices: SQUARE.vertices.slice(0, 3), inTangents: SQUARE.inTangents.slice(0, 3), outTangents: SQUARE.outTangents.slice(0, 3) };
    expect(pathWriteMismatches(SQUARE, readout(fewer), {}, written).map((m) => m.path)).toEqual(["path.vertexCount"]);
    expect(pathWriteMismatches(SQUARE, readout(SQUARE, { expression: { enabled: true, text: "x", error: "" } }), {}, written).map((m) => m.path)).toEqual(["expression.enabled"]);
  });

  it("wants a key when a time was given, and says when a key's ease could not be put back", () => {
    expect(pathWriteMismatches(SQUARE, readout(SQUARE, { numKeys: 0 }), { time: 1 }, written).map((m) => m.path)).toEqual(["numKeys"]);
    expect(pathWriteMismatches(SQUARE, readout(SQUARE, { numKeys: 2 }), { time: 1 }, { replaced_key: true, ease_restored: false }).map((m) => m.path)).toEqual(["key.ease"]);
    expect(pathWriteMismatches(SQUARE, readout(SQUARE, { numKeys: 2 }), { time: 1 }, { replaced_key: true, ease_restored: true })).toEqual([]);
  });

  it("does not compare vertices past the read-back's cap", () => {
    const capped = readout(SQUARE) as any;
    capped.path.truncated = true;
    capped.path.vertices = [];
    expect(pathWriteMismatches(SQUARE, capped, {}, written).map((m) => m.path)).toEqual([]);
  });
});

describe("ae_path_write flow", () => {
  it("reads, guards, reads, writes and reads back in separate calls", async () => {
    const expected = resamplePath(SQUARE, { count: 8 });
    const { ctx, calls } = fakeAe({
      pathsRead: [readout(SQUARE), readout(SQUARE), readout(expected)],
      pathsApply: [{ kind: "shape", wrote: "value", previous_vertex_count: 4, vertex_count: 8, closed: true }],
    });
    const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "resample", resample: { count: 8 }, expect: expectArg });
    const out = (await tool("ae_path_write").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["pathsRead", "checkGuard", "pathsRead", "pathsApply", "pathsRead"]);
    expect(calls[3].script).toContain('"expect"');
    expect(calls[3].script).toContain('"base":{"count":4,');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.path.vertexCount).toBe(8);
  });

  it("sends reorders only for a mirror that reverses direction", async () => {
    const run = async (mirror: Record<string, unknown>) => {
      const { ctx, calls } = fakeAe({
        pathsRead: [readout(SQUARE), readout(SQUARE), readout(SQUARE)],
        pathsApply: [{ kind: "shape", wrote: "value", previous_vertex_count: 4, vertex_count: 4, closed: true }],
      });
      const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "mirror", mirror, expect: expectArg });
      await tool("ae_path_write").handler(args, ctx);
      return calls[3].script;
    };
    expect(await run({ axis: "x", reverse_direction: true })).toContain('"reorders":true');
    expect(await run({ axis: "x" })).not.toContain('"reorders"');
  });

  it("puts a wrong read-back in the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      pathsRead: [readout(SQUARE), readout(SQUARE), readout(SQUARE)],
      pathsApply: [{ wrote: "value", previous_vertex_count: 4, vertex_count: 8 }],
    });
    const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "resample", resample: { count: 8 }, expect: expectArg });
    const out = (await tool("ae_path_write").handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("path.vertexCount");
  });

  it("set skips the pre-read and sends no base", async () => {
    const p = { vertices: [[0, 0], [10, 10]], closed: false };
    const written = toPathData(p);
    const { ctx, calls } = fakeAe({ pathsRead: [readout(SQUARE), readout(written, { path: { closed: false, vertexCount: 2, vertices: written.vertices, inTangents: written.inTangents, outTangents: written.outTangents, truncated: false } })], pathsApply: [{ wrote: "value" }] });
    const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "set", path: p, expect: expectArg });
    const out = (await tool("ae_path_write").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "pathsRead", "pathsApply", "pathsRead"]);
    expect(calls[2].script).toContain('"base":null');
    expect(out.receipt.matches).toBe(true);
  });

  it("refuses a keyframed path without a time, an expression, and a truncated path before the guard", async () => {
    for (const [extra, pattern] of [
      [{ numKeys: 2 }, /keyframed/],
      [{ expression: { enabled: true, text: "x", error: "" } }, /expression/],
    ] as const) {
      const { ctx, calls } = fakeAe({ pathsRead: [readout(SQUARE, extra)] });
      const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "reverse", expect: expectArg });
      const out = (await tool("ae_path_write").handler(args, ctx)) as any;
      expect(out).toMatchObject({ ok: false, error: "bad_args" });
      expect(out.message).toMatch(pattern);
      expect(calls.map((c) => c.fn)).toEqual(["pathsRead"]);
    }
    const big = readout(SQUARE) as any;
    big.path.truncated = true;
    big.path.vertexCount = 900;
    const { ctx, calls } = fakeAe({ pathsRead: [big] });
    const args = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "reverse", expect: expectArg });
    expect(((await tool("ae_path_write").handler(args, ctx)) as any).message).toMatch(/900 vertices/);
    expect(calls).toHaveLength(1);
  });

  it("turns a resample that can't be done into bad_args, and a dry run writes nothing", async () => {
    const { ctx, calls } = fakeAe({ pathsRead: [readout(SQUARE), readout(SQUARE)] });
    const tooMany = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "resample", resample: { spacing: 0.1 }, expect: expectArg });
    expect(await tool("ae_path_write").handler(tooMany, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    const dry = AePathWriteSchema.parse({ comp_id: 1, target: shapeTarget, operation: "mirror", mirror: { axis: "x" }, dry_run: true, expect: expectArg });
    const out = (await tool("ae_path_write").handler(dry, ctx)) as any;
    expect(out).toMatchObject({ ok: true, dry_run: true, vertex_count: 4 });
    expect(calls.map((c) => c.fn)).toEqual(["pathsRead", "pathsRead"]);
  });
});

describe("operatorMismatches", () => {
  const op = { comp_id: 1, layer: { index: 1 }, group: { index: 1 }, expect: expectArg };
  const before = { group: { index: 1, name: "G" }, count: 2, truncated: false, items: [] };
  const trimItem = (extra: Record<string, unknown> = {}) => ({ index: 3, name: "Trim Paths 1", matchName: "ADBE Vector Filter - Trim", kind: "trim", start: 0, end: 100, offset: 0, trim_type: 1, ...extra });
  const after = (items: unknown[], count = 3) => ({ group: { index: 1, name: "G" }, count, truncated: false, items });
  const added = { added: [{ index: 3, name: "Trim Paths 1", matchName: "ADBE Vector Filter - Trim" }] };

  it("accepts a forward draw-on with two End keys and flags wrong keys", () => {
    const args = AePathOperatorSchema.parse({ ...op, operator: "trim", trim: { draw_on: { start_time: 0.5, duration: 1 } } });
    const good = after([trimItem({ end_key_times: [0.5, 1.5], end_key_values: [0, 100] })]);
    expect(operatorMismatches(args, before, good, added)).toEqual([]);
    const wrong = after([trimItem({ end_key_times: [0.5, 2.5], end_key_values: [0, 100] })]);
    expect(operatorMismatches(args, before, wrong, added).map((m) => m.path)).toEqual(["items[3].end_key_times"]);
    expect(operatorMismatches(args, before, after([trimItem()]), added).map((m) => m.path)).toEqual(["items[3].end_key_times"]);
    expect(operatorMismatches(args, before, good, { ...added, eased: false }).map((m) => m.path)).toEqual(["items[3].ease"]);
  });

  it("checks a reverse draw-on on Start and a centre one on both", () => {
    const rev = AePathOperatorSchema.parse({ ...op, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1, direction: "reverse" } } });
    expect(operatorMismatches(rev, before, after([trimItem({ start_key_times: [0, 1], start_key_values: [100, 0], end: 100 })]), added)).toEqual([]);
    const mid = AePathOperatorSchema.parse({ ...op, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1, direction: "center" } } });
    const good = trimItem({ start_key_times: [0, 1], start_key_values: [50, 0], end_key_times: [0, 1], end_key_values: [50, 100] });
    expect(operatorMismatches(mid, before, after([good]), added)).toEqual([]);
    expect(operatorMismatches(mid, before, after([trimItem({ end_key_times: [0, 1], end_key_values: [50, 100] })]), added).map((m) => m.path)).toContain("items[3].start_key_times");
  });

  it("checks static trim values, the count and the item at the index", () => {
    const args = AePathOperatorSchema.parse({ ...op, operator: "trim", trim: { start: 10, end: 60, type: "individually" } });
    expect(operatorMismatches(args, before, after([trimItem({ start: 10, end: 60, trim_type: 2 })]), added)).toEqual([]);
    expect(operatorMismatches(args, before, after([trimItem({ start: 10, end: 50, trim_type: 1 })]), added).map((m) => m.path)).toEqual(["items[3].end", "items[3].trim_type"]);
    expect(operatorMismatches(args, before, after([trimItem({ start: 10, end: 60, trim_type: 2 })], 4), added).map((m) => m.path)).toEqual(["count", "added.last.index"]);
    expect(operatorMismatches(args, before, after([{ ...trimItem(), matchName: "ADBE Vector Graphic - Fill" }]), added).map((m) => m.path)).toContain("items[3].matchName");
  });

  it("checks offset values with their enums", () => {
    const args = AePathOperatorSchema.parse({ ...op, operator: "offset", offset: { amount: 5, line_join: "round", copies: 2 } });
    const item = { index: 3, name: "Offset Paths 1", matchName: "ADBE Vector Filter - Offset", kind: "offset", amount: 5, line_join: 2, copies: 2 };
    const w = { added: [{ index: 3, name: "Offset Paths 1", matchName: "ADBE Vector Filter - Offset" }] };
    expect(operatorMismatches(args, before, after([item]), w)).toEqual([]);
    expect(operatorMismatches(args, before, after([{ ...item, line_join: 1 }]), w).map((m) => m.path)).toEqual(["items[3].line_join"]);
  });

  it("compares the Repeater order with the value the host writes", () => {
    const rep = (order: number) => ({
      index: 3,
      name: "Repeater 1",
      matchName: "ADBE Vector Filter - Repeater",
      kind: "repeater",
      copies: 3,
      order,
      transform: [],
    });
    const w = { added: [{ index: 3, name: "Repeater 1", matchName: "ADBE Vector Filter - Repeater" }] };
    const above = AePathOperatorSchema.parse({ ...op, operator: "repeater", repeater: { copies: 3, order: "above" } });
    const below = AePathOperatorSchema.parse({ ...op, operator: "repeater", repeater: { copies: 3, order: "below" } });
    expect(operatorMismatches(above, before, after([rep(1)]), w)).toEqual([]);
    expect(operatorMismatches(below, before, after([rep(2)]), w)).toEqual([]);
    expect(operatorMismatches(above, before, after([rep(2)]), w).map((m) => m.path)).toEqual(["items[3].order"]);
  });

  it("checks both Repeaters of a grid", () => {
    const args = AePathOperatorSchema.parse({ ...op, operator: "repeater", repeater: { grid: { columns: 4, rows: 3, spacing: [50, 40] } } });
    const rep = (index: number, copies: number, position: number[]) => ({
      index,
      name: `Repeater ${index}`,
      matchName: "ADBE Vector Filter - Repeater",
      kind: "repeater",
      copies,
      transform: [{ name: "Position", matchName: "ADBE Vector Repeater Position", value: position }],
    });
    const w = {
      added: [
        { index: 3, name: "Repeater 1", matchName: "ADBE Vector Filter - Repeater", role: "columns" },
        { index: 4, name: "Repeater 2", matchName: "ADBE Vector Filter - Repeater", role: "rows" },
      ],
    };
    expect(operatorMismatches(args, before, after([rep(3, 4, [50, 0]), rep(4, 3, [0, 40])], 4), w)).toEqual([]);
    expect(operatorMismatches(args, before, after([rep(3, 4, [50, 0]), rep(4, 3, [40, 0])], 4), w).map((m) => m.path)).toEqual(["items[4].position[0]", "items[4].position[1]"]);
    const noChild = { ...rep(3, 4, [50, 0]), transform: [] };
    expect(operatorMismatches(args, before, after([noChild, rep(4, 3, [0, 40])], 4), w).map((m) => m.path)).toEqual(["items[3].position"]);
  });
});

describe("linkMismatches and connectorMismatches", () => {
  const link = (extra: object = {}) => AePathLinkSchema.parse({ comp_id: 1, target: shapeTarget, source: { layer: { index: 2 }, mask: { index: 1 } }, expect: expectArg, ...extra });

  it("accepts a link whose expression is on, error-free and the same size as its source", () => {
    const expr = { enabled: true, text: 'thisComp.layer("Plate").mask("Mask 1").maskPath', error: "" };
    const after = { target: readout(SQUARE, { expression: expr }), source: readout(SQUARE) };
    expect(linkMismatches(link(), null, after, { expression: expr.text })).toEqual([]);
    const bad = { target: readout(SQUARE, { expression: { ...expr, error: "Error: bad" } }), source: readout(SQUARE) };
    expect(linkMismatches(link(), null, bad, { expression: expr.text }).map((m) => m.path)).toEqual(["expression.error"]);
    const fewer = { target: readout({ ...SQUARE, vertices: SQUARE.vertices.slice(0, 3) }, { expression: expr }), source: readout(SQUARE) };
    expect(linkMismatches(link(), null, fewer, { expression: expr.text }).map((m) => m.path)).toEqual(["path.vertexCount"]);
  });

  it("checks an unlink, and a bake against the linked shape", () => {
    const unlink = AePathLinkSchema.parse({ comp_id: 1, target: shapeTarget, unlink: true, bake: true, expect: expectArg });
    const linked = { target: readout(SQUARE, { expression: { enabled: true, text: "x", error: "" } }), source: null };
    const off = { target: readout(SQUARE), source: null };
    expect(linkMismatches(unlink, linked, off, { baked: true })).toEqual([]);
    const still = { target: readout(SQUARE, { expression: { enabled: true, text: "x", error: "" } }), source: null };
    expect(linkMismatches(unlink, linked, still, { baked: true }).map((m) => m.path)).toEqual(["expression.enabled", "expression.text"]);
    const moved = { target: readout({ ...SQUARE, vertices: [[1, 1], [100, 0], [100, 100], [0, 100]] }), source: null };
    expect(linkMismatches(unlink, linked, moved, { baked: true }).map((m) => m.path)).toEqual(["path.vertices[0]"]);
  });

  it("checks a connector's count, expression, shape and place", () => {
    const args = AePathConnectorSchema.parse({ comp_id: 1, from: { layer: { name: "A" } }, to: { layer: { name: "B" } }, expect: expectArg });
    const line: PathData = { vertices: [[0, 0], [100, 50]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false };
    const conn = (extra: object = {}) => ({
      num_layers: 3,
      from: { index: 1, id: 1, name: "A" },
      to: { index: 2, id: 2, name: "B" },
      connector: readout(line, { layer: { index: 3, id: 9, name: "Connector" }, expression: { enabled: true, text: "createPath", error: "" }, ...extra }),
    });
    const before = { num_layers: 2, from: null, to: null, connector: null };
    expect(connectorMismatches(args, before, conn(), { layer: { id: 9 } })).toEqual([]);
    const wrongPlace = conn({ layer: { index: 1, id: 9, name: "Connector" } });
    expect(connectorMismatches(args, before, wrongPlace, {}).map((m) => m.path)).toEqual(["layer.index"]);
    expect(connectorMismatches({ ...args, behind: false }, before, wrongPlace, {})).toEqual([]);
    expect(connectorMismatches(args, before, conn({ expression: { enabled: true, text: "x", error: "Error" } }), {}).map((m) => m.path)).toEqual(["expression.error"]);
    expect(connectorMismatches(args, before, { ...conn(), num_layers: 2 }, {}).map((m) => m.path)).toEqual(["numLayers"]);
    expect(connectorMismatches(args, before, { ...conn(), connector: null }, {}).map((m) => m.path)).toEqual(["connector"]);
  });
});

describe("operator, link and connector flows", () => {
  it("ae_path_operator reads the group before and after around the write", async () => {
    const before = { group: { index: 1, name: "G" }, count: 2, truncated: false, items: [] };
    const item = { index: 3, name: "Trim Paths 1", matchName: "ADBE Vector Filter - Trim", kind: "trim", start: 0, end: 100, offset: 0, end_key_times: [0, 1], end_key_values: [0, 100] };
    const { ctx, calls } = fakeAe({
      pathsOperators: [before, { ...before, count: 3, items: [item] }],
      pathsOperator: [{ operator: "trim", added: [{ index: 3, name: "Trim Paths 1", matchName: "ADBE Vector Filter - Trim" }], eased: true }],
    });
    const args = AePathOperatorSchema.parse({ comp_id: 1, layer: { index: 1 }, group: { index: 1 }, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1 } }, expect: expectArg });
    const out = (await tool("ae_path_operator").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "pathsOperators", "pathsOperator", "pathsOperators"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.contents).toHaveLength(1);
  });

  it("ae_path_link reads both paths and puts the source in the write", async () => {
    const expr = 'thisComp.layer("Plate").mask("Mask 1").maskPath';
    const state = (on: boolean) => ({ target: readout(SQUARE, { expression: { enabled: on, text: on ? expr : "", error: "" } }), source: readout(SQUARE) });
    const { ctx, calls } = fakeAe({ pathsLinkState: [state(false), state(true)], pathsLink: [{ expression: expr }] });
    const args = AePathLinkSchema.parse({ comp_id: 1, target: shapeTarget, source: { layer: { name: "Plate" }, mask: { index: 1 } }, expect: expectArg });
    const out = (await tool("ae_path_link").handler(args, ctx)) as any;
    expect(calls[2].script).toContain('"source"');
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_path_connector asks for the new layer by id after the write", async () => {
    const line: PathData = { vertices: [[0, 0], [100, 50]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: false };
    const after = {
      num_layers: 3,
      from: { index: 1, id: 1, name: "A" },
      to: { index: 2, id: 2, name: "B" },
      connector: readout(line, { layer: { index: 3, id: 9, name: "Connector" }, expression: { enabled: true, text: "createPath", error: "" } }),
    };
    const { ctx, calls } = fakeAe({
      pathsConnectorState: [{ num_layers: 2, from: null, to: null, connector: null }, after],
      pathsConnector: [{ layer: { index: 3, id: 9, name: "Connector" }, from: { index: 1, id: 1, name: "A" }, to: { index: 2, id: 2, name: "B" }, style: "straight", expression: "createPath" }],
    });
    const args = AePathConnectorSchema.parse({ comp_id: 1, from: { layer: { name: "A" } }, to: { layer: { name: "B" } }, expect: expectArg });
    const out = (await tool("ae_path_connector").handler(args, ctx)) as any;
    expect(calls[3].script).toContain('"layer_id":9');
    expect(calls[3].script).toContain('"from_id":1');
    expect(out.receipt.matches).toBe(true);
    expect(out.path.vertexCount).toBe(2);
  });
});

// ---------- host functions under node:vm ----------

const P = (name: string, matchName: string, type: number, value: unknown) => new FakeProperty(name, matchName, type, value);

/** The path operators the fake's addProperty doesn't know; names follow AE's numbering. */
const OPERATORS: Record<string, (n: number, opts: { dropMiterLimit?: boolean }) => FakeGroup> = {
  "ADBE Vector Filter - Trim": (n) =>
    new FakeGroup(`Trim Paths ${n}`, "ADBE Vector Filter - Trim", [
      P("Start", "ADBE Vector Trim Start", PropertyValueType.OneD, 0),
      P("End", "ADBE Vector Trim End", PropertyValueType.OneD, 100),
      P("Offset", "ADBE Vector Trim Offset", PropertyValueType.OneD, 0),
      P("Trim Multiple Shapes", "ADBE Vector Trim Type", PropertyValueType.OneD, 1),
    ]),
  "ADBE Vector Filter - Offset": (n, o) =>
    new FakeGroup(
      `Offset Paths ${n}`,
      "ADBE Vector Filter - Offset",
      [
        P("Amount", "ADBE Vector Offset Amount", PropertyValueType.OneD, 0),
        P("Line Join", "ADBE Vector Offset Line Join", PropertyValueType.OneD, 1),
        ...(o.dropMiterLimit ? [] : [P("Miter Limit", "ADBE Vector Offset Miter Limit", PropertyValueType.OneD, 4)]),
        P("Copies", "ADBE Vector Offset Copies", PropertyValueType.OneD, 1),
        P("Copy Offset", "ADBE Vector Offset Copy Offset", PropertyValueType.OneD, 0),
      ]
    ),
  "ADBE Vector Filter - Repeater": (n) =>
    new FakeGroup(`Repeater ${n}`, "ADBE Vector Filter - Repeater", [
      P("Copies", "ADBE Vector Repeater Copies", PropertyValueType.OneD, 3),
      P("Offset", "ADBE Vector Repeater Offset", PropertyValueType.OneD, 0),
      P("Composite", "ADBE Vector Repeater Order", PropertyValueType.OneD, 1),
      new FakeGroup("Transform", "ADBE Vector Repeater Transform", [
        P("Anchor Point", "ADBE Vector Repeater Anchor", PropertyValueType.TwoD, [0, 0]),
        P("Position", "ADBE Vector Repeater Position", PropertyValueType.TwoD, [100, 0]),
        P("Scale", "ADBE Vector Repeater Scale", PropertyValueType.TwoD, [100, 100]),
        P("Rotation", "ADBE Vector Repeater Rotation", PropertyValueType.OneD, 0),
        P("Start Opacity", "ADBE Vector Repeater Opacity 1", PropertyValueType.OneD, 100),
        P("End Opacity", "ADBE Vector Repeater Opacity 2", PropertyValueType.OneD, 100),
      ]),
    ]),
};

const opts: { dropMiterLimit?: boolean } = {};
const originalAdd = FakeGroup.prototype.addProperty;
beforeAll(() => {
  FakeGroup.prototype.addProperty = function (this: FakeGroup, matchName: string) {
    const make = OPERATORS[matchName];
    if (!make) return originalAdd.call(this, matchName);
    if (this.propertyType !== PropertyType.INDEXED_GROUP) throw new Error(`Can't add ${matchName} to ${this.name}`);
    const made = make(this.props.filter((p) => p.matchName === matchName).length + 1, opts);
    made.parentProperty = this;
    this.props.push(made);
    return made;
  } as typeof originalAdd;
});
afterAll(() => {
  FakeGroup.prototype.addProperty = originalAdd;
});

const shapeOf = (p: PathData, extra: Record<string, unknown> = {}) => {
  const s = new Shape();
  s.vertices = p.vertices;
  s.inTangents = p.inTangents;
  s.outTangents = p.outTangents;
  s.closed = p.closed;
  return Object.assign(s, extra);
};

/** A comp with a shape layer (group "Group 1" with free path "Path 1", a stroke and a rectangle) and a solid with a mask. */
function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const plate = comp.layers.addSolid([0, 0, 0], "Plate", 640, 360, 1, 4);
  const mask = (plate.property("ADBE Mask Parade") as FakeGroup).addProperty("ADBE Mask Atom") as FakeGroup;
  (mask.property("ADBE Mask Shape") as FakeProperty).setValue(shapeOf(SQUARE));
  const layer = comp.layers.addShape();
  const root = layer.property("ADBE Root Vectors Group") as FakeGroup;
  const group = root.addProperty("ADBE Vector Group") as FakeGroup;
  const vectors = group.property("ADBE Vectors Group") as FakeGroup;
  const pathItem = vectors.addProperty("ADBE Vector Shape - Group") as FakeGroup;
  const pathProp = pathItem.property("ADBE Vector Shape") as FakeProperty;
  pathProp.setValue(shapeOf(SQUARE));
  vectors.addProperty("ADBE Vector Graphic - Stroke");
  vectors.addProperty("ADBE Vector Shape - Rect");
  return { project, comp, plate, layer, vectors, pathProp, maskProp: mask.property("ADBE Mask Shape") as FakeProperty };
}

const shapeRef = (l: FakeLayer, extra: object = {}) => ({ layer: { id: l.id }, shape: { group: { index: 1 }, path: { index: 1 }, ...extra } });
const maskRef = (l: FakeLayer) => ({ layer: { id: l.id }, mask: { index: 1 } });
const names = (c: FakeComp) => c.stack.map((l) => l.name);

describe("paths.jsx: reading", () => {
  it("reads a free shape path and a mask path without touching the project", () => {
    const { project, comp, layer, plate } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const s = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) });
    expect(s).toMatchObject({ kind: "shape", group: { index: 1, name: "Group 1" }, path_item: { index: 1, name: "Path 1" }, numKeys: 0 });
    expect(s.path).toMatchObject({ closed: true, vertexCount: 4, truncated: false });
    expect(s.path.vertices).toEqual(SQUARE.vertices);
    expect(s.expression).toEqual({ enabled: false, text: "", error: "" });
    const m = A.pathsRead({ comp_id: comp.id, target: maskRef(plate) });
    expect(m).toMatchObject({ kind: "mask", mask: { index: 1, name: "Mask 1" }, feather_points: 0 });
    expect(undo.begun).toBe(0);
    expect(comp.time).toBe(0);
  });

  it("finds the only group and path without a selector, and refuses rectangles and bad selectors", () => {
    const { project, comp, layer, plate } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    expect(A.pathsRead({ comp_id: comp.id, target: { layer: { id: layer.id }, shape: {} } }).path.vertexCount).toBe(4);
    expect(() => A.pathsRead({ comp_id: comp.id, target: shapeRef(layer, { path: { index: 3 } }) })).toThrow(/not a free path/);
    expect(() => A.pathsRead({ comp_id: comp.id, target: shapeRef(layer, { path: { index: 9 } }) })).toThrow(/out of range/);
    expect(() => A.pathsRead({ comp_id: comp.id, target: shapeRef(layer, { group: { name: "Nope" } }) })).toThrow(/No Group named/);
    expect(() => A.pathsRead({ comp_id: comp.id, target: { layer: { id: plate.id }, shape: {} } })).toThrow(/not a shape layer/);
    expect(() => A.pathsRead({ comp_id: comp.id, target: { layer: { id: layer.id }, mask: { index: 1 } } })).toThrow(/Mask 1 out of range|Mask index 1/);
    expect(() => A.pathsRead({ comp_id: comp.id, target: { layer: { id: layer.id } } })).toThrow(/exactly one of mask or shape/);
  });

  it("reads a keyed path at a time and reports key times", () => {
    const { project, comp, layer, pathProp } = scene();
    pathProp.setValueAtTime(0, shapeOf(SQUARE));
    pathProp.setValueAtTime(2, shapeOf({ ...SQUARE, vertices: [[0, 0], [200, 0], [200, 200], [0, 200]] }));
    const { A } = loadHost(project, ["paths.jsx"]);
    const r = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer), time: 2 });
    expect(r.numKeys).toBe(2);
    expect(r.key_times).toEqual([0, 2]);
    expect(r.path.vertices[1]).toEqual([200, 0]);
    expect(r.time).toBe(2);
  });

  it("reads an unkeyed path at the requested time, not the comp time", () => {
    const { project, comp, layer, pathProp } = scene();
    const orig = pathProp.valueAtTime;
    const asked: number[] = [];
    (pathProp as any).valueAtTime = function (t: number, pre: boolean) {
      asked.push(t);
      return orig.call(this, t, pre);
    };
    const { A } = loadHost(project, ["paths.jsx"]);
    A.pathsRead({ comp_id: comp.id, target: shapeRef(layer), time: 3 });
    expect(asked).toContain(3);
  });

  it("lists a group's operators with their keys", () => {
    const { project, comp, layer } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, operator: "trim", trim: { draw_on: { start_time: 0, duration: 1 } }, expect: GUARD });
    const r = A.pathsOperators({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 } });
    expect(r.items.map((i: any) => i.kind)).toEqual(["path", "stroke", "rect", "trim"]);
    expect(r.items[3]).toMatchObject({ index: 4, end_key_times: [0, 1], end_key_values: [0, 100], start_key_times: [] });
  });
});

describe("paths.jsx: writing a path", () => {
  const next = { vertices: [[0, 0], [50, 0], [50, 50]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: false };

  it("writes a value into a shape path and a mask in one undo group", () => {
    const { project, comp, layer, plate, maskProp } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const out = A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: next, expect: GUARD });
    expect(out).toMatchObject({ wrote: "value", previous_vertex_count: 4, vertex_count: 3, closed: false });
    const back = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) });
    expect(back.path).toMatchObject({ closed: false, vertexCount: 3 });
    expect(back.path.vertices).toEqual(next.vertices);
    A.pathsApply({ comp_id: comp.id, target: maskRef(plate), path: { ...SQUARE, closed: true }, expect: GUARD });
    expect((maskProp.value as Shape).vertices).toEqual(SQUARE.vertices);
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
  });

  it("refuses bad input before the undo group opens, and a guard mismatch", () => {
    const { project, comp, layer } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const go = (path: unknown, extra: object = {}) => () => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path, expect: GUARD, ...extra });
    expect(go({ ...next, vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]] })).toThrow(/at least 2/);
    expect(go({ ...next, inTangents: [[0, 0]] })).toThrow(/same length/);
    expect(go({ ...next, vertices: [[0, 0], [NaN, 1], [2, 2]] })).toThrow(/finite/);
    expect(go({ ...next, closed: "yes" })).toThrow(/closed must be/);
    expect(go(next, { time: "soon" })).toThrow(/time must be/);
    expect(() => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: next, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(undo.begun).toBe(0);
    expect(A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) }).path.vertexCount).toBe(4);
  });

  it("refuses a path with an expression on it", () => {
    const { project, comp, layer, pathProp } = scene();
    pathProp.expression = "x";
    pathProp.expressionEnabled = true;
    const { A } = loadHost(project, ["paths.jsx"]);
    expect(() => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: next, expect: GUARD })).toThrow(/has an expression/);
  });

  it("makes a key with a time, and needs a time once the path has keys", () => {
    const { project, comp, layer, pathProp } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const out = A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: SQUARE, time: 1, expect: GUARD });
    expect(out).toMatchObject({ wrote: "key", time: 1, replaced_key: false });
    expect(pathProp.numKeys).toBe(1);
    expect(() => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: SQUARE, expect: GUARD })).toThrow(/keyframed \(1 keys\)/);
  });

  it("keeps a replaced key's interpolation and ease", () => {
    const { project, comp, layer, pathProp } = scene();
    pathProp.setValueAtTime(0, shapeOf(SQUARE));
    pathProp.setValueAtTime(2, shapeOf(SQUARE));
    pathProp.setInterpolationTypeAtKey(2, 6613);
    pathProp.setTemporalEaseAtKey(2, [{ speed: 0, influence: 80 } as any], [{ speed: 0, influence: 20 } as any]);
    const { A } = loadHost(project, ["paths.jsx"]);
    const moved = { ...SQUARE, vertices: [[0, 0], [150, 0], [150, 100], [0, 100]] };
    const out = A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: moved, time: 2, expect: GUARD });
    expect(out).toMatchObject({ replaced_key: true, ease_restored: true });
    expect(pathProp.numKeys).toBe(2);
    expect(pathProp.keyInInterpolationType(2)).toBe(6613);
    expect(pathProp.keyInTemporalEase(2)[0].influence).toBe(80);
    expect(pathProp.keyOutTemporalEase(2)[0].influence).toBe(20);
    expect((pathProp.keyValue(2) as Shape).vertices[1]).toEqual([150, 0]);
  });

  it("refuses a key with a different vertex count unless allowed", () => {
    const { project, comp, layer, pathProp } = scene();
    pathProp.setValueAtTime(0, shapeOf(SQUARE));
    const { A } = loadHost(project, ["paths.jsx"]);
    const go = (extra: object = {}) => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: next, time: 1, expect: GUARD, ...extra });
    expect(() => go()).toThrow(/breaks the morph/);
    expect(go({ allow_vertex_count_change: true })).toMatchObject({ vertex_count: 3 });
  });

  it("refuses a vertex count change on a feathered mask, and keeps the feather when the count stays", () => {
    const { project, comp, plate, maskProp } = scene();
    (maskProp.value as any).featherSegLocs = [0];
    (maskProp.value as any).featherRadii = [5];
    const { A } = loadHost(project, ["paths.jsx"]);
    const target = maskRef(plate);
    expect(() => A.pathsApply({ comp_id: comp.id, target, path: next, expect: GUARD })).toThrow(/feather points/);
    expect(A.pathsRead({ comp_id: comp.id, target }).path.vertexCount).toBe(4);
    A.pathsApply({ comp_id: comp.id, target, path: { ...SQUARE, vertices: [[0, 0], [90, 0], [90, 90], [0, 90]] }, expect: GUARD });
    expect((maskProp.value as any).featherRadii).toEqual([5]);
    A.pathsApply({ comp_id: comp.id, target, path: next, allow_feather_loss: true, expect: GUARD });
    expect((maskProp.value as any).featherRadii).toBeUndefined();
    expect(A.pathsRead({ comp_id: comp.id, target }).path.vertexCount).toBe(3);
  });

  it("treats reverse and resample on a feathered mask like a count change", () => {
    const { project, comp, plate, maskProp } = scene();
    (maskProp.value as any).featherSegLocs = [0];
    (maskProp.value as any).featherRadii = [5];
    const { A } = loadHost(project, ["paths.jsx"]);
    const target = maskRef(plate);
    const rev = { ...SQUARE, vertices: [[0, 90], [90, 90], [90, 0], [0, 0]] };
    expect(() => A.pathsApply({ comp_id: comp.id, target, path: rev, operation: "reverse", expect: GUARD })).toThrow(/feather points/);
    expect((maskProp.value as any).featherRadii).toEqual([5]);
    A.pathsApply({ comp_id: comp.id, target, path: rev, operation: "mirror", expect: GUARD });
    expect((maskProp.value as any).featherRadii).toEqual([5]);
    A.pathsApply({ comp_id: comp.id, target, path: rev, operation: "reverse", allow_feather_loss: true, expect: GUARD });
    expect((maskProp.value as any).featherRadii).toBeUndefined();
  });

  it("treats a mirror that reverses the vertex order as reordering the feather", () => {
    const { project, comp, plate, maskProp } = scene();
    (maskProp.value as any).featherSegLocs = [0];
    (maskProp.value as any).featherRadii = [5];
    const { A } = loadHost(project, ["paths.jsx"]);
    const target = maskRef(plate);
    const rev = { ...SQUARE, vertices: [[0, 90], [90, 90], [90, 0], [0, 0]] };
    expect(() => A.pathsApply({ comp_id: comp.id, target, path: rev, operation: "mirror", reorders: true, expect: GUARD })).toThrow(/feather points/);
    expect((maskProp.value as any).featherRadii).toEqual([5]);
    A.pathsApply({ comp_id: comp.id, target, path: rev, operation: "mirror", reorders: true, allow_feather_loss: true, expect: GUARD });
    expect((maskProp.value as any).featherRadii).toBeUndefined();
  });

  it("refuses a write when the path changed since the server read it", () => {
    const { project, comp, layer } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const read = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) });
    const base = { count: read.path.vertexCount, checksum: pathChecksum(read.path) };
    // The server's checksum and the host's agree, so a path nobody touched passes.
    expect(A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: SQUARE, base, expect: GUARD })).toMatchObject({ wrote: "value" });
    A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: next, expect: GUARD });
    expect(() => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: SQUARE, base, expect: GUARD })).toThrow(/changed since it was read/);
    const moved = { ...SQUARE, vertices: [[0, 0], [100, 0], [100, 100], [0, 99]] };
    A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: moved, expect: GUARD });
    expect(() => A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: SQUARE, base, expect: GUARD })).toThrow(/changed since it was read/);
  });

  it("round-trips an operation computed on the server through the host", () => {
    const { project, comp, layer } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const read = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) });
    const args = AePathWriteSchema.parse({ comp_id: comp.id, target: shapeRef(layer), operation: "resample", resample: { count: 8 }, expect: GUARD });
    const computed = applyPathOperation(args, { vertices: read.path.vertices, inTangents: read.path.inTangents, outTangents: read.path.outTangents, closed: read.path.closed });
    A.pathsApply({ comp_id: comp.id, target: shapeRef(layer), path: computed, expect: GUARD });
    const after = A.pathsRead({ comp_id: comp.id, target: shapeRef(layer) });
    expect(pathWriteMismatches(computed, after, {}, {})).toEqual([]);
  });
});

describe("paths.jsx: operators", () => {
  const go = (A: any, comp: FakeComp, layer: FakeLayer, o: object) =>
    A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, expect: GUARD, ...o });

  it("adds Trim Paths with a forward draw-on: End 0 to 100 with Easy Ease", () => {
    const { project, comp, layer, vectors } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const out = go(A, comp, layer, { operator: "trim", trim: { draw_on: { start_time: 0.5, duration: 1 } }, name: "Reveal" });
    expect(out.added).toEqual([{ index: 4, name: "Reveal", matchName: "ADBE Vector Filter - Trim" }]);
    expect(out.eased).toBe(true);
    const trim = vectors.property(4) as FakeGroup;
    const end = trim.property("ADBE Vector Trim End") as FakeProperty;
    expect([end.keyTime(1), end.keyTime(2)]).toEqual([0.5, 1.5]);
    expect([end.keyValue(1), end.keyValue(2)]).toEqual([0, 100]);
    expect(end.keyOutTemporalEase(1)[0].influence).toBeCloseTo(33.333, 2);
    expect(end.keyInInterpolationType(2)).toBe(6613);
    expect((trim.property("ADBE Vector Trim Start") as FakeProperty).numKeys).toBe(0);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("draws on in reverse (Start 100 to 0, End 100) and from the centre (both keyed)", () => {
    const { project, comp, layer, vectors } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    go(A, comp, layer, { operator: "trim", trim: { draw_on: { start_time: 0, duration: 2, direction: "reverse", ease: "linear" } } });
    const rev = vectors.property(4) as FakeGroup;
    const start = rev.property("ADBE Vector Trim Start") as FakeProperty;
    expect([start.keyValue(1), start.keyValue(2), start.keyTime(2)]).toEqual([100, 0, 2]);
    expect((rev.property("ADBE Vector Trim End") as FakeProperty).value).toBe(100);
    expect(start.keyInInterpolationType(1)).not.toBe(6613);
    go(A, comp, layer, { operator: "trim", trim: { draw_on: { start_time: 0, duration: 1, direction: "center" } } });
    const mid = vectors.property(5) as FakeGroup;
    expect(((mid.property("ADBE Vector Trim Start") as FakeProperty).keys.map((k) => k.value))).toEqual([50, 0]);
    expect(((mid.property("ADBE Vector Trim End") as FakeProperty).keys.map((k) => k.value))).toEqual([50, 100]);
  });

  it("adds a static trim, an offset and a repeater with their settings", () => {
    const { project, comp, layer, vectors } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    go(A, comp, layer, { operator: "trim", trim: { start: 10, end: 60, offset: 90, type: "individually" } });
    const trim = vectors.property(4) as FakeGroup;
    expect(["Start", "End", "Offset", "Trim Multiple Shapes"].map((n) => (trim.property(n) as FakeProperty).value)).toEqual([10, 60, 90, 2]);
    go(A, comp, layer, { operator: "offset", offset: { amount: -5, line_join: "bevel", miter_limit: 8, copies: 3, copy_offset: 2 } });
    const off = vectors.property(5) as FakeGroup;
    expect(["Amount", "Line Join", "Miter Limit", "Copies", "Copy Offset"].map((n) => (off.property(n) as FakeProperty).value)).toEqual([-5, 3, 8, 3, 2]);
    const rep = go(A, comp, layer, { operator: "repeater", repeater: { copies: 5, offset: 1, order: "above", position: [20, 10], scale: [90, 90], rotation: 15, start_opacity: 100, end_opacity: 20 } });
    expect(rep.transform_children.map((c: any) => c.name)).toEqual(["Anchor Point", "Position", "Scale", "Rotation", "Start Opacity", "End Opacity"]);
    const r = vectors.property(6) as FakeGroup;
    expect((r.property("ADBE Vector Repeater Copies") as FakeProperty).value).toBe(5);
    expect((r.property("ADBE Vector Repeater Order") as FakeProperty).value).toBe(1);
    expect(rep.order_mapping).toMatch(/unverified/);
    const tr = r.property("ADBE Vector Repeater Transform") as FakeGroup;
    expect((tr.property("Position") as FakeProperty).value).toEqual([20, 10]);
    expect((tr.property("End Opacity") as FakeProperty).value).toBe(20);
  });

  it("builds a grid from two Repeaters, columns first", () => {
    const { project, comp, layer, vectors } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const out = go(A, comp, layer, { operator: "repeater", repeater: { grid: { columns: 4, rows: 3, spacing: [50, 40] } }, name: "Dots" });
    expect(out.added.map((a: any) => [a.index, a.name, a.role])).toEqual([[4, "Dots X", "columns"], [5, "Dots Y", "rows"]]);
    const x = vectors.property(4) as FakeGroup;
    const y = vectors.property(5) as FakeGroup;
    expect((x.property("ADBE Vector Repeater Copies") as FakeProperty).value).toBe(4);
    expect(((x.property("ADBE Vector Repeater Transform") as FakeGroup).property("Position") as FakeProperty).value).toEqual([50, 0]);
    expect((y.property("ADBE Vector Repeater Copies") as FakeProperty).value).toBe(3);
    expect(((y.property("ADBE Vector Repeater Transform") as FakeGroup).property("Position") as FakeProperty).value).toEqual([0, 40]);
    const back = A.pathsOperators({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 } });
    const args = AePathOperatorSchema.parse({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, operator: "repeater", repeater: { grid: { columns: 4, rows: 3, spacing: [50, 40] } }, name: "Dots", expect: GUARD });
    const before = { group: back.group, count: 3, truncated: false, items: [] };
    expect(operatorMismatches(args, before, back, out)).toEqual([]);
  });

  it("refuses bad settings before the undo group opens", () => {
    const { project, comp, layer, vectors } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    expect(() => go(A, comp, layer, { operator: "trim", trim: { end: 120 } })).toThrow(/0\.\.100/);
    expect(() => go(A, comp, layer, { operator: "trim", trim: { end: 50, draw_on: { start_time: 0, duration: 1 } } })).toThrow(/don't also set/);
    expect(() => go(A, comp, layer, { operator: "trim", trim: { draw_on: { start_time: 0, duration: 0 } } })).toThrow(/duration/);
    expect(() => go(A, comp, layer, { operator: "offset", offset: { line_join: "sharp" } })).toThrow(/line_join/);
    expect(() => go(A, comp, layer, { operator: "repeater", repeater: { copies: 2.5 } })).toThrow(/whole number/);
    expect(() => go(A, comp, layer, { operator: "repeater", repeater: { grid: { columns: 200, rows: 200, spacing: [1, 1] } } })).toThrow(/10000/);
    expect(() => go(A, comp, layer, { operator: "repeater", repeater: { copies: 2, grid: { columns: 2, rows: 2, spacing: [1, 1] } } })).toThrow(/grid sets/);
    expect(() => go(A, comp, layer, { operator: "blur" })).toThrow(/operator must be/);
    expect(() => A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 2 }, operator: "trim", expect: GUARD })).toThrow(/out of range/);
    expect(() => A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, operator: "trim", expect: { project_path: "C:/x.aep" } })).toThrow(/Target guard refused/);
    expect(undo.begun).toBe(0);
    expect(vectors.numProperties).toBe(3);
  });

  it("takes an operator back out when AE has no such property, inside the same undo group", () => {
    const { project, comp, layer, vectors } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    opts.dropMiterLimit = true;
    try {
      expect(() => go(A, comp, layer, { operator: "offset", offset: { amount: 5, miter_limit: 8 } })).toThrow(/Offset Miter Limit was not found/);
    } finally {
      opts.dropMiterLimit = false;
    }
    expect(vectors.numProperties).toBe(3);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });
});

describe("paths.jsx: operator rollback when AE inserts at the top", () => {
  it("removes only the operator it added, not the user's own content", () => {
    const { project, comp, layer, vectors } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const real = vectors.addProperty.bind(vectors);
    (vectors as any).addProperty = (m: string) => {
      const made = real(m);
      vectors.props.pop();
      vectors.props.unshift(made);
      return made;
    };
    const before = vectors.props.map((p) => p.matchName);
    opts.dropMiterLimit = true;
    try {
      expect(() => A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, operator: "offset", offset: { amount: 5, miter_limit: 8 }, expect: GUARD })).toThrow(/Offset Miter Limit was not found/);
    } finally {
      opts.dropMiterLimit = false;
    }
    expect(vectors.props.map((p) => p.matchName)).toEqual(before);
    // On success the add lands first, which the result reports as index 1 (the server's receipt flags it as not last).
    const out = A.pathsOperator({ comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 }, operator: "offset", offset: { amount: 5 }, expect: GUARD });
    expect(out.added[0].index).toBe(1);
    expect(out.count).toBe(4);
  });
});

describe("paths.jsx: links", () => {
  it("links a shape path to a mask by name and reads the expression back", () => {
    const { project, comp, layer, plate, pathProp } = scene();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const out = A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD });
    expect(out.expression).toBe('thisComp.layer("Plate").mask("Mask 1").maskPath');
    expect(pathProp.expression).toBe(out.expression);
    expect(pathProp.expressionEnabled).toBe(true);
    const state = A.pathsLinkState({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate) });
    expect(state.target.expression.enabled).toBe(true);
    expect(state.source.kind).toBe("mask");
    expect(linkMismatches(AePathLinkSchema.parse({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD }), null, state, out)).toEqual([]);
    expect(undo.begun).toBe(1);
  });

  it("links a mask to a shape path and offsets time", () => {
    const { project, comp, layer, plate, maskProp } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    const out = A.pathsLink({ comp_id: comp.id, target: maskRef(plate), source: shapeRef(layer), time_offset: 0.25, expect: GUARD });
    expect(out.expression).toBe('thisComp.layer("Shape Layer 1").content("Group 1").content("Path 1").path.valueAtTime(time - 0.25)');
    expect(maskProp.expressionEnabled).toBe(true);
  });

  it("escapes quotes in names and refuses duplicate names, itself and a bad offset", () => {
    const { project, comp, layer, plate } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    plate.name = 'My "Plate"';
    expect(A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD }).expression).toContain('thisComp.layer("My \\"Plate\\"")');
    comp.layers.addNull().name = 'My "Plate"';
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD })).toThrow(/More than one layer is named/);
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: shapeRef(layer), expect: GUARD })).toThrow(/itself/);
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), time_offset: "x", expect: GUARD })).toThrow(/time_offset/);
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), expect: GUARD })).toThrow(/source path/);
  });

  it("unlinks, optionally baking the current shape into a value", () => {
    const { project, comp, layer, plate, pathProp } = scene();
    const { A } = loadHost(project, ["paths.jsx"]);
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), unlink: true, expect: GUARD })).toThrow(/no expression to remove/);
    A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD });
    const out = A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), unlink: true, bake: true, expect: GUARD });
    expect(out).toMatchObject({ unlinked: true, baked: true, vertex_count: 4 });
    expect(pathProp.expression).toBe("");
    expect(pathProp.expressionEnabled).toBe(false);
    expect((pathProp.value as Shape).vertices).toEqual(SQUARE.vertices);
    A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), source: maskRef(plate), expect: GUARD });
    pathProp.setValueAtTime(1, shapeOf(SQUARE));
    expect(() => A.pathsLink({ comp_id: comp.id, target: shapeRef(layer), unlink: true, bake: true, expect: GUARD })).toThrow(/keyframed/);
  });

  it("bakes a feathered mask only when the vertex counts agree, else refuses before the undo group", () => {
    const { project, comp, layer, plate, maskProp } = scene();
    (maskProp.value as any).featherSegLocs = [0];
    (maskProp.value as any).featherRadii = [5];
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    // The mask follows a 3-vertex path: its value shows that, while the path under the expression keeps 4 vertices and a feather.
    const tri = { vertices: [[0, 0], [50, 0], [0, 50]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: true };
    A.pathsLink({ comp_id: comp.id, target: maskRef(plate), source: shapeRef(layer), expect: GUARD });
    let evaluated: unknown = shapeOf(tri);
    Object.defineProperty(maskProp, "value", { get: () => (maskProp.expressionEnabled ? evaluated : maskProp.staticValue), configurable: true });
    const begun = undo.begun;
    expect(() => A.pathsLink({ comp_id: comp.id, target: maskRef(plate), unlink: true, bake: true, expect: GUARD })).toThrow(/feather points/);
    expect(undo.begun).toBe(begun);
    expect(maskProp.expression).not.toBe("");
    const out = A.pathsLink({ comp_id: comp.id, target: maskRef(plate), unlink: true, bake: true, allow_feather_loss: true, expect: GUARD });
    expect(out).toMatchObject({ baked: true, vertex_count: 3, feather_kept: false, feather_dropped: 1 });
    // Same count: the feather points under the expression are kept.
    (maskProp.staticValue as any).featherSegLocs = [0];
    (maskProp.staticValue as any).featherRadii = [5];
    evaluated = shapeOf(SQUARE);
    maskProp.staticValue = Object.assign(shapeOf(SQUARE), { featherSegLocs: [1], featherRadii: [7] });
    A.pathsLink({ comp_id: comp.id, target: maskRef(plate), source: shapeRef(layer), expect: GUARD });
    const kept = A.pathsLink({ comp_id: comp.id, target: maskRef(plate), unlink: true, bake: true, expect: GUARD });
    expect(kept).toMatchObject({ baked: true, vertex_count: 4, feather_kept: true });
    expect((maskProp.staticValue as any).featherRadii).toEqual([7]);
  });
});

describe("paths.jsx: connector", () => {
  function twoLayers() {
    const { project, comp } = scene();
    const a = comp.layers.addSolid([1, 0, 0], "A", 50, 50, 1, 4);
    const b = comp.layers.addSolid([0, 1, 0], "B", 50, 50, 1, 4);
    return { project, comp, a, b };
  }

  it("creates a shape layer with a two-point expression path below the lower endpoint", () => {
    const { project, comp, a, b } = twoLayers();
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const before = names(comp);
    const out = A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id }, point: [10, 20] }, color: [0, 0.5, 1], width: 6, style: "curve_h", curve: 0.4, expect: GUARD });
    expect(out.layer.name).toBe("Connector A - B");
    expect(out.expression).toContain('var a = thisComp.layer("A");');
    expect(out.expression).toContain("var cb = b.toComp([10, 20]);");
    expect(out.expression).toContain("var p1 = fromComp([ca[0], ca[1]]);");
    expect(out.expression).toContain("var h = (p2[0] - p1[0]) * 0.4;");
    expect(out.expression).toContain("createPath([p1, p2], [[0, 0], [-h, 0]], [[h, 0], [0, 0]], false);");
    // B was added last so it is on top; the connector sits directly below the lower one (A).
    expect(names(comp).indexOf("Connector A - B")).toBe(names(comp).indexOf("A") + 1);
    expect(names(comp)).toHaveLength(before.length + 1);
    const state = A.pathsConnectorState({ comp_id: comp.id, layer_id: out.layer.id, from_id: a.id, to_id: b.id });
    expect(state.connector.expression).toMatchObject({ enabled: true });
    expect(state.connector.path_item).toMatchObject({ index: 1, name: "Path 1" });
    expect(state.num_layers).toBe(before.length + 1);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    // Straight is the default; vertical handles use the y distance.
    const v = A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id } }, style: "curve_v", behind: false, name: "Wire V", expect: GUARD });
    expect(v.expression).toContain("var h = (p2[1] - p1[1]) * 0.5;");
    expect(comp.layer(1)!.name).toBe("Wire V");
    const s = A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id } }, name: "Wire", expect: GUARD });
    expect(s.expression).toContain("createPath([p1, p2], [[0, 0], [0, 0]], [[0, 0], [0, 0]], false);");
    expect(s.expression).toContain("var ca = a.toComp(a.anchorPoint);");
  });

  it("refuses the same layer twice, cameras, duplicate names and bad styling before adding anything", () => {
    const { project, comp, a, b } = twoLayers();
    comp.layers.addCamera("Cam", [0, 0]);
    const { A, undo } = loadHost(project, ["paths.jsx"]);
    const n = comp.numLayers;
    const go = (o: object) => () => A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id } }, expect: GUARD, ...o });
    expect(go({ to: { layer: { id: a.id } } })).toThrow(/two different layers/);
    expect(go({ to: { layer: { name: "Cam" } } })).toThrow(/CameraLayer/);
    expect(go({ style: "zigzag" })).toThrow(/style/);
    expect(go({ color: [2, 0, 0] })).toThrow(/0\.\.1/);
    expect(go({ width: -1 })).toThrow(/width/);
    expect(go({ from: { layer: { id: a.id }, point: [1] } })).toThrow(/point must be/);
    expect(go({ name: "A" })).toThrow(/already exists/);
    comp.layers.addNull().name = "B";
    expect(go({})).toThrow(/More than one layer is named "B"/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(n + 1);
  });

  it("a made connector takes its name; a second one can't reuse it", () => {
    const { project, comp, a, b } = twoLayers();
    const { A } = loadHost(project, ["paths.jsx"]);
    const go = () => A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id } }, name: "Taken", expect: GUARD });
    expect(go).not.toThrow();
    expect(go).toThrow(/already exists/);
  });

  it("refuses a default name over 200 characters with a clear message", () => {
    const { project, comp, a, b } = twoLayers();
    a.name = "x".repeat(150);
    b.name = "y".repeat(150);
    const { A } = loadHost(project, ["paths.jsx"]);
    expect(() => A.pathsConnector({ comp_id: comp.id, from: { layer: { id: a.id } }, to: { layer: { id: b.id } }, expect: GUARD })).toThrow(/default connector name/);
  });
});
