import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import {
  AeMultiCompApplySchema,
  classifyError,
  classifyResult,
  clearJobMemory,
  hashFingerprint,
  jobsPath,
  loadJob,
  multicompTools,
  planFromProbe,
  saveJob,
  scanLayerSelectors,
  setToolLookup,
  summarize,
  type JobComp,
} from "../src/tools/ext/multicomp.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  setToolLookup();
  clearJobMemory();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = multicompTools.find((t) => t.name === "ae_multi_comp_apply")!;

// ---------- a fake AE behind a real PanelHost ----------

interface Scene {
  comps: Array<{ id: number; name: string; layers: string[] }>;
}

/** A PanelHost whose AE answers the host functions this tool uses from a small scene. */
function fakeAe(scene: Scene, projectPath: string) {
  const calls: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-multicomp-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  let fingerprintSeq = 0;
  const opts = { guardFailsOnResolve: false, truncated: false, fingerprintTruncated: false };
  const argsOf = (script: string) => JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      const a = argsOf(script);
      let result: unknown;
      if (fn === "checkGuard") result = { ok: true, project_path: projectPath, comp_id: null, comp_is_valid: true };
      else if (fn === "multicompResolve") {
        if (opts.guardFailsOnResolve) return { ok: true, result: { guard_failed: true, project_path: "C:/other.aep" }, durationMs: 1 };
        const all = scene.comps.filter((c) => (a.ids ? a.ids.includes(c.id) : true));
        const re = a.name_pattern ? new RegExp(a.name_pattern, a.case_insensitive ? "i" : "") : null;
        const comps = all.filter((c) => !re || re.test(c.name)).map((c) => ({ id: c.id, name: c.name }));
        const known = new Set(scene.comps.map((c) => c.id));
        result = { comps, matched: opts.truncated ? 900 : comps.length, missing_ids: (a.ids ?? []).filter((i: number) => !known.has(i)), truncated: opts.truncated, partial: false };
      } else if (fn === "multicompProbe") {
        result = {
          comps: a.comp_ids.map((id: number) => {
            const c = scene.comps.find((x) => x.id === id);
            if (!c) return { id, exists: false, name: null, found: {} };
            const found: Record<string, number> = {};
            for (const n of a.layer_names) found[n] = c.layers.filter((l) => l === n).length;
            return { id, exists: true, name: c.name, found };
          }),
          truncated: false,
        };
      } else if (fn === "compFingerprint") result = { comp_id: a.comp_id, seq: fingerprintSeq++, ...(opts.fingerprintTruncated ? { truncated: true } : {}) };
      else if (fn === "batchValidate") result = a.ops.some((o: { bad?: boolean }) => o.bad) ? { ok: false, error: "Op 1 is invalid" } : { ok: true };
      else throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, opts };
}

const SCENE: Scene = {
  comps: [
    { id: 1, name: "Promo 16x9", layers: ["Title", "BG"] },
    { id: 2, name: "Promo 9x16", layers: ["Title", "BG"] },
    { id: 3, name: "Promo 1x1", layers: ["BG"] },
    { id: 4, name: "Lower third", layers: ["Title", "Title"] },
  ],
};

interface Seen {
  comp_id: number;
  args: Record<string, unknown>;
}

/** A stand-in write tool: records what it was given and answers per comp from `answers`. */
function fakeWriteTool(answers: Record<number, unknown | (() => never)> = {}, seen: Seen[] = []) {
  const schema = z.object({
    comp_id: z.number().int(),
    layer: z.object({ name: z.string().optional(), index: z.number().int().optional() }).optional(),
    value: z.number().optional(),
    expect: z.object({ project_path: z.string(), comp_id: z.number().int().optional() }),
  });
  const def: ToolDefinition<any> = {
    name: "ae_set_property",
    description: "fake",
    schema,
    handler: async (a: z.infer<typeof schema>) => {
      seen.push({ comp_id: a.comp_id, args: a as Record<string, unknown> });
      const answer = answers[a.comp_id];
      if (typeof answer === "function") return (answer as () => never)();
      return answer ?? { op_id: "x", applied: true, checkpoint: { status: "created", path: "C:/cp.aep" }, receipt: { matches: true, mismatches: [] } };
    },
  };
  setToolLookup(async (n) => (n === "ae_set_property" ? def : undefined));
  return seen;
}

function projectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-multicomp-p-"));
  tmpDirs.push(dir);
  return path.join(dir, "show.aep");
}

const base = (projectPath: string, over: Record<string, unknown> = {}) =>
  AeMultiCompApplySchema.parse({
    op: { tool: "ae_set_property", args: { layer: { name: "Title" }, value: 5 } },
    name_pattern: "^Promo",
    pause_ms: 0,
    expect: { project_path: projectPath },
    ...over,
  });

const run = (args: unknown, ctx: ToolContext) => tool.handler(args, ctx) as Promise<any>;

// ---------- schema ----------

describe("ae_multi_comp_apply schema", () => {
  const expectArg = { project_path: "<unsaved>" };
  const op = { tool: "ae_set_property", args: { value: 1 } };

  it("needs an op or a job to resume, and the comps named", () => {
    expect(AeMultiCompApplySchema.safeParse({ op, comp_ids: [1], expect: expectArg }).success).toBe(true);
    expect(AeMultiCompApplySchema.safeParse({ comp_ids: [1], expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, name_pattern: ".", expect: expectArg }).success).toBe(true);
  });

  it("takes one of comp_ids, folder_id and nested_in", () => {
    expect(AeMultiCompApplySchema.safeParse({ op, comp_ids: [1], folder_id: 2, expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, nested_in: 2, name_pattern: "A", expect: expectArg }).success).toBe(true);
  });

  it("keeps resume apart from op and the selectors", () => {
    expect(AeMultiCompApplySchema.safeParse({ resume_job_id: "mc_abc_1", expect: expectArg }).success).toBe(true);
    expect(AeMultiCompApplySchema.safeParse({ resume_job_id: "mc_abc_1", op, expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ resume_job_id: "mc_abc_1", comp_ids: [1], expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, comp_ids: [1], retry_failed: true, expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ resume_job_id: "../x", expect: expectArg }).success).toBe(false);
  });

  it("refuses tools outside the whitelist, and comp_id / expect inside the args", () => {
    expect(AeMultiCompApplySchema.safeParse({ op: { tool: "ae_run_jsx", args: {} }, comp_ids: [1], expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op: { tool: "ae_skill_run", args: {} }, comp_ids: [1], expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op: { ...op, args: { comp_id: 3 } }, comp_ids: [1], expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op: { ...op, args: { expect: expectArg } }, comp_ids: [1], expect: expectArg }).success).toBe(false);
  });

  it("checks the regular expression and the numeric bounds", () => {
    expect(AeMultiCompApplySchema.safeParse({ op, name_pattern: "([", expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, comp_ids: [1], pause_ms: 99999, expect: expectArg }).success).toBe(false);
    expect(AeMultiCompApplySchema.safeParse({ op, comp_ids: [1], max_comps: 201, expect: expectArg }).success).toBe(false);
  });

  it("describes itself and ends with the safety guidance", () => {
    expect(tool.description).toMatch(/IMPORTANT: \(1\) Always re-read/);
    expect(tool.description).toContain("resume_job_id");
  });
});

// ---------- pure logic ----------

describe("scanLayerSelectors", () => {
  it("finds names and positional selectors at any depth", () => {
    expect(scanLayerSelectors({ layer: { name: "Title" }, value: 1 })).toEqual({ positional: [], names: ["Title"] });
    expect(scanLayerSelectors({ layer: { index: 2 } }).positional).toEqual(["layer"]);
    const s = scanLayerSelectors({ ops: [{ layer: { name: "A" }, path: ["x"] }, { layer: { id: 7 } }], parent: { name: "Ctrl" } });
    expect(s.names.sort()).toEqual(["A", "Ctrl"]);
    expect(s.positional).toEqual(["ops[1].layer"]);
  });

  it("does not take a placement index or a value for a layer selector", () => {
    expect(scanLayerSelectors({ placement: { index: 2 }, value: { index: 3 } })).toEqual({ positional: [], names: [] });
    expect(scanLayerSelectors({ placement: { above: { name: "Logo" } } }).names).toEqual(["Logo"]);
  });

  it("counts a selector with a name and an index as positional", () => {
    expect(scanLayerSelectors({ layer: { name: "A", index: 1 } })).toEqual({ positional: ["layer"], names: [] });
  });
});

describe("classifyResult", () => {
  it("accepts a matching receipt and a plain result", () => {
    expect(classifyResult({ applied: true, receipt: { matches: true, mismatches: [] } })).toEqual({ status: "ok", receipt_matches: true });
    expect(classifyResult({ done: 3, matches: true }).status).toBe("ok");
    expect(classifyResult(null).status).toBe("ok");
  });

  it("calls a failed read-back unverified, in either result shape", () => {
    const r = classifyResult({ applied: true, receipt: { matches: false, mismatches: [{ path: "read_back", message: "popup" }] } });
    expect(r).toMatchObject({ status: "unverified", applied: true });
    expect(classifyResult({ ok: false, error: "read_back_failed", applied: true }).status).toBe("unverified");
  });

  it("fails a receipt mismatch as applied", () => {
    const r = classifyResult({ applied: true, receipt: { matches: false, mismatches: [{ path: "value", message: "differs" }] } });
    expect(r).toMatchObject({ status: "failed", error: "receipt_mismatch", applied: true });
    expect(r.mismatches).toEqual([{ path: "value", message: "differs" }]);
  });

  it("tells a refused write from a half-done one", () => {
    expect(classifyResult({ ok: false, error: "bad_args", message: "no" })).toMatchObject({ status: "failed", applied: false });
    expect(classifyResult({ ok: false, error: "op_failed", done: 2 })).toMatchObject({ status: "failed", applied: true });
    expect(classifyResult({ ok: false, error: "weird" })).toMatchObject({ status: "failed", applied: "unknown" });
  });
});

describe("classifyError", () => {
  it("stops the job on a guard failure, a timeout and a dropped op, not on a host error", () => {
    expect(classifyError(new BridgeError({ kind: "guard", message: "g" }))).toMatchObject({ fatal: true, outcome: { error: "guard", applied: false } });
    expect(classifyError(new BridgeError({ kind: "timeout", message: "t" }))).toMatchObject({ fatal: true, outcome: { applied: "unknown" } });
    expect(classifyError(new BridgeError({ kind: "queued", message: "q" })).fatal).toBe(true);
    expect(classifyError(new BridgeError({ kind: "evalscript_error", message: "No layer" }))).toMatchObject({ fatal: false, outcome: { applied: "unknown" } });
    expect(classifyError(new Error("boom"))).toMatchObject({ fatal: false, outcome: { applied: "unknown" } });
  });
});

describe("planFromProbe", () => {
  const comps: JobComp[] = [1, 2, 3, 4].map((id) => ({ comp_id: id, name: `C${id}`, status: "pending" }));
  it("skips gone comps and missing layers, fails an ambiguous name", () => {
    const probe = [
      { id: 1, exists: true, name: "C1", found: { Title: 1 } },
      { id: 2, exists: true, name: "C2", found: { Title: 0 } },
      { id: 3, exists: true, name: "C3", found: { Title: 2 } },
    ];
    const plan = planFromProbe(comps, ["Title"], probe);
    expect(plan.get(1)).toEqual({ action: "run" });
    expect(plan.get(2)?.action).toBe("skip");
    expect(plan.get(3)?.action).toBe("fail");
    expect(plan.get(4)).toMatchObject({ action: "skip", reason: "The comp no longer exists." });
  });

  it("runs every comp when no layer is named", () => {
    const plan = planFromProbe(comps.slice(0, 1), [], [{ id: 1, exists: true, name: "C1", found: {} }]);
    expect(plan.get(1)?.action).toBe("run");
  });
});

describe("summarize and hashFingerprint", () => {
  it("counts statuses", () => {
    const c = (status: JobComp["status"]): JobComp => ({ comp_id: 1, name: "x", status });
    expect(summarize([c("ok"), c("ok"), c("failed"), c("pending")])).toEqual({ pending: 1, in_flight: 0, ok: 2, skipped: 0, failed: 1, unverified: 0 });
  });

  it("hashes equal fingerprints equally and different ones differently", () => {
    expect(hashFingerprint({ a: 1 })).toBe(hashFingerprint({ a: 1 }));
    expect(hashFingerprint({ a: 1 })).not.toBe(hashFingerprint({ a: 2 }));
    expect(hashFingerprint({ a: 1 })).toHaveLength(16);
  });
});

// ---------- the guarded flow ----------

describe("ae_multi_comp_apply flow", () => {
  let aep: string;
  beforeEach(() => {
    aep = projectDir();
  });

  it("runs the tool on each comp with its own comp_id and expect, skips a comp without the layer, and records the job", async () => {
    const { ctx, calls } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const out = await run(base(aep), ctx);
    expect(calls.slice(0, 3)).toEqual(["checkGuard", "multicompResolve", "multicompProbe"]);
    expect(seen.map((s) => s.comp_id)).toEqual([1, 2]);
    expect(seen[0].args).toMatchObject({ layer: { name: "Title" }, value: 5, expect: { project_path: aep, comp_id: 1 } });
    expect(out).toMatchObject({ ok: true, applied: true, state: "done", summary: { ok: 2, skipped: 1, failed: 0, pending: 0 } });
    expect(out.comps.map((c: JobComp) => [c.comp_id, c.status])).toEqual([[1, "ok"], [2, "ok"], [3, "skipped"]]);
    expect(out.comps[2].reason).toContain('"Title"');
    expect(out.checkpoint).toMatchObject({ status: "created" });
    expect(out.undo_note).toContain("2 steps");
    const file = JSON.parse(fs.readFileSync(jobsPath(aep), "utf8"));
    expect(file.jobs).toHaveLength(1);
    expect(file.jobs[0]).toMatchObject({ id: out.job_id, state: "done", tool: "ae_set_property" });
    expect(out.job_file).toBe(jobsPath(aep));
  });

  it("checks the target guard before resolving or writing anything", async () => {
    const { ctx, calls } = fakeAe(SCENE, "H:/other/open.aep");
    const seen = fakeWriteTool();
    await expect(run(base(aep), ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(calls).toEqual(["checkGuard"]);
    expect(seen).toEqual([]);
  });

  it("validates the arguments against every comp before writing", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const out = await run(base(aep, { op: { tool: "ae_set_property", args: { layer: { name: "Title" }, value: "five" } } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args", applied: false });
    expect(out.message).toContain("Nothing was written");
    expect(seen).toEqual([]);
    expect(fs.existsSync(jobsPath(aep))).toBe(false);
  });

  it("refuses index and id selectors for several comps but allows them for one", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const many = await run(base(aep, { op: { tool: "ae_set_property", args: { layer: { index: 1 }, value: 5 } } }), ctx);
    expect(many).toMatchObject({ ok: false, error: "bad_args" });
    expect(many.message).toContain("by name");
    expect(seen).toEqual([]);
    const one = await run(base(aep, { op: { tool: "ae_set_property", args: { layer: { index: 1 }, value: 5 } }, name_pattern: undefined, comp_ids: [1] }), ctx);
    expect(one.ok).toBe(true);
    expect(seen.map((s) => s.comp_id)).toEqual([1]);
  });

  it("refuses a selection that is empty, has unknown ids or is over max_comps", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    expect(await run(base(aep, { name_pattern: "^Nope" }), ctx)).toMatchObject({ ok: false, error: "no_comps" });
    expect(await run(base(aep, { name_pattern: undefined, comp_ids: [1, 99] }), ctx)).toMatchObject({ ok: false, error: "not_found", missing_ids: [99] });
    expect(await run(base(aep, { max_comps: 2, name_pattern: "." }), ctx)).toMatchObject({ ok: false, error: "bad_args", matched: 4 });
    expect(seen).toEqual([]);
  });

  it("stops at the first failure, leaves the rest pending and resumes from there", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool({ 1: { ok: false, error: "bad_args", message: "nope" } });
    const first = await run(base(aep, { name_pattern: "^Promo (16x9|9x16)" }), ctx);
    expect(first).toMatchObject({ ok: false, error: "job_stopped", state: "stopped", summary: { failed: 1, pending: 1 }, stopped_at: { comp_id: 1 } });
    expect(seen.map((s) => s.comp_id)).toEqual([1]);
    expect(first.resume).toContain(first.job_id);

    // Comp 1 is not run again without retry_failed.
    fakeWriteTool({}, seen);
    const second = await run(AeMultiCompApplySchema.parse({ resume_job_id: first.job_id, pause_ms: 0, expect: { project_path: aep } }), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([1, 2]);
    expect(second).toMatchObject({ job_id: first.job_id, state: "done", summary: { ok: 1, failed: 1, pending: 0 } });

    const third = await run(AeMultiCompApplySchema.parse({ resume_job_id: first.job_id, retry_failed: true, pause_ms: 0, expect: { project_path: aep } }), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([1, 2, 1]);
    expect(third.summary).toMatchObject({ ok: 2, failed: 0 });
  });

  it("goes on past a failure with on_failure continue", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool({ 1: { ok: false, error: "bad_args" } });
    const out = await run(base(aep, { on_failure: "continue" }), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([1, 2]);
    expect(out).toMatchObject({ ok: false, error: "comps_failed", state: "done", summary: { failed: 1, ok: 1, skipped: 1 } });
  });

  it("fails a comp whose layer name is ambiguous without writing it", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const out = await run(base(aep, { name_pattern: "^Lower", on_failure: "continue" }), ctx);
    expect(seen).toEqual([]);
    expect(out.comps[0]).toMatchObject({ status: "failed", error: "ambiguous_layer", applied: false });
  });

  it("stops whatever on_failure says on a guard failure, and on a failed read-back", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    fakeWriteTool({
      1: () => {
        throw new BridgeError({ kind: "guard", message: "Jay switched project" });
      },
    });
    const guarded = await run(base(aep, { on_failure: "continue" }), ctx);
    expect(guarded).toMatchObject({ ok: false, state: "stopped", summary: { failed: 1, pending: 2 } });
    expect(guarded.message).toContain("whatever on_failure says");

    const seen = fakeWriteTool({ 1: { applied: true, receipt: { matches: false, mismatches: [{ path: "read_back", message: "timed out" }] } } });
    const unverified = await run(base(aep, { on_failure: "continue" }), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([1]);
    expect(unverified).toMatchObject({ ok: false, state: "stopped", summary: { unverified: 1, pending: 2 } });
    expect(unverified.comps[0]).toMatchObject({ status: "unverified", applied: true });
  });

  it("never throws after a write: a thrown host error becomes a failed row", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    fakeWriteTool({
      2: () => {
        throw new BridgeError({ kind: "evalscript_error", message: "Layer is locked" });
      },
    });
    const out = await run(base(aep, { on_failure: "continue" }), ctx);
    expect(out.comps[1]).toMatchObject({ comp_id: 2, status: "failed", error: "evalscript_error", applied: "unknown" });
  });

  it("hashes fingerprints before and after and flags a comp that did not change", async () => {
    const { ctx, calls } = fakeAe(SCENE, aep);
    fakeWriteTool();
    const out = await run(base(aep, { fingerprints: true, name_pattern: "^Promo 16x9" }), ctx);
    expect(calls.filter((c) => c === "compFingerprint")).toHaveLength(2);
    expect(out.comps[0].fingerprint_before).toHaveLength(16);
    expect(out.comps[0].fingerprint_after).toHaveLength(16);
    // The fake AE numbers each fingerprint, so before and after differ.
    expect(out.comps[0].changed).toBe(true);
  });

  it("dry run resolves and checks without writing or recording a job", async () => {
    const { ctx, calls } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const out = await run(base(aep, { dry_run: true }), ctx);
    expect(seen).toEqual([]);
    expect(calls).toEqual(["checkGuard", "multicompResolve", "multicompProbe", "batchValidate", "batchValidate"]);
    expect(out).toMatchObject({ ok: true, dry_run: true, applied: false, would_run: 2, would_skip: 1, would_fail: 0, depth: "validated" });
    expect(out.comps.map((c: { plan: string }) => c.plan)).toEqual(["run", "run", "skip"]);
    expect(fs.existsSync(jobsPath(aep))).toBe(false);
  });

  it("dry run of ae_batch_set runs its validation pass per comp", async () => {
    const { ctx, calls } = fakeAe(SCENE, aep);
    const schema = z.object({ comp_id: z.number(), ops: z.array(z.object({ bad: z.boolean().optional() })), expect: z.any() });
    setToolLookup(async () => ({ name: "ae_batch_set", description: "", schema, handler: async () => ({}) }));
    const out = await run(
      AeMultiCompApplySchema.parse({ op: { tool: "ae_batch_set", args: { ops: [{ bad: true }] } }, comp_ids: [1, 2], dry_run: true, expect: { project_path: aep } }),
      ctx
    );
    expect(calls.filter((c) => c === "batchValidate")).toHaveLength(2);
    expect(out).toMatchObject({ would_fail: 2, depth: "validated" });
  });

  it("resolves the real registry tool and checks its schema in a dry run", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const good = await run(
      AeMultiCompApplySchema.parse({
        op: { tool: "ae_set_property", args: { layer: { name: "Title" }, path: ["Transform", "Opacity"], value: 50 } },
        comp_ids: [1, 2],
        dry_run: true,
        expect: { project_path: aep },
      }),
      ctx
    );
    expect(good).toMatchObject({ ok: true, would_run: 2 });
    const badArgs = await run(
      AeMultiCompApplySchema.parse({ op: { tool: "ae_set_property", args: { layer: { name: "Title" } } }, comp_ids: [1], dry_run: true, expect: { project_path: aep } }),
      ctx
    );
    expect(badArgs).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("keeps a job of an unsaved project in memory and resumes it there", async () => {
    const { ctx } = fakeAe(SCENE, "<unsaved>");
    const seen = fakeWriteTool({ 1: { ok: false, error: "bad_args" } });
    const first = await run(base("<unsaved>", { name_pattern: "^Promo (16x9|9x16)" }), ctx);
    expect(first.job_file).toBeNull();
    expect(first.job_file_note).toContain("memory");
    fakeWriteTool({}, seen);
    const second = await run(AeMultiCompApplySchema.parse({ resume_job_id: first.job_id, pause_ms: 0, expect: { project_path: "<unsaved>" } }), ctx);
    expect(second.summary).toMatchObject({ ok: 1, failed: 1 });
  });

  it("answers an unknown job and a job from another project without writing", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const unknown = await run(AeMultiCompApplySchema.parse({ resume_job_id: "mc_nope_1", expect: { project_path: aep } }), ctx);
    expect(unknown).toMatchObject({ ok: false, error: "unknown_job" });

    const first = await run(base(aep, { name_pattern: "^Promo 16x9" }), ctx);
    const job = loadJob(aep, first.job_id)!;
    // The same record found for a different open project: refused.
    const other = projectDir();
    fs.copyFileSync(jobsPath(aep), jobsPath(other));
    const { ctx: ctx2 } = fakeAe(SCENE, other);
    const wrong = await run(AeMultiCompApplySchema.parse({ resume_job_id: job.id, expect: { project_path: other } }), ctx2);
    expect(wrong).toMatchObject({ ok: false, error: "wrong_project" });
    expect(seen.map((s) => s.comp_id)).toEqual([1]);
  });

  it("keeps a job file it cannot parse beside the new one", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    fakeWriteTool();
    fs.writeFileSync(jobsPath(aep), "{ not json");
    const out = await run(base(aep, { name_pattern: "^Promo 16x9" }), ctx);
    expect(out.ok).toBe(true);
    const aside = fs.readdirSync(path.dirname(aep)).filter((f) => f.endsWith(".bak"));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(jobsPath(aep), "utf8")).jobs).toHaveLength(1);
  });
});

// ---------- host functions under node:vm ----------

describe("ae_multi_comp_apply review fixes", () => {
  let aep: string;
  beforeEach(() => {
    aep = projectDir();
  });
  const resume = (id: string, over: Record<string, unknown> = {}) => AeMultiCompApplySchema.parse({ resume_job_id: id, pause_ms: 0, expect: { project_path: aep }, ...over });
  const one = (toolName: string, handler: (a: any) => Promise<unknown>, schema: z.ZodTypeAny = z.any()) =>
    setToolLookup(async () => ({ name: toolName, description: "", schema, handler }));
  const single = (toolName: string) =>
    AeMultiCompApplySchema.parse({ op: { tool: toolName, args: {} }, comp_ids: [1], pause_ms: 0, expect: { project_path: aep } });

  it("marks a comp in flight before its write starts", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    let statusDuringWrite: string | undefined;
    one("ae_set_property", async (a) => {
      const file = JSON.parse(fs.readFileSync(jobsPath(aep), "utf8"));
      statusDuringWrite = file.jobs[0].comps.find((c: JobComp) => c.comp_id === a.comp_id).status;
      return { applied: true, receipt: { matches: true, mismatches: [] } };
    });
    await run(single("ae_set_property"), ctx);
    expect(statusDuringWrite).toBe("in_flight");
  });

  it("reports a comp left in flight as unverified on resume and runs it only with retry_failed", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    const t = new Date().toISOString();
    saveJob({
      id: "mc_crashed_1",
      created_at: t,
      updated_at: t,
      state: "running",
      project_path: aep,
      tool: "ae_set_property",
      args: { layer: { name: "Title" }, value: 5 },
      on_failure: "stop",
      fingerprints: false,
      pause_ms: 0,
      selection: {},
      comps: [
        { comp_id: 1, name: "Promo 16x9", status: "in_flight" },
        { comp_id: 2, name: "Promo 9x16", status: "pending" },
      ],
    });
    const out = await run(resume("mc_crashed_1"), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([2]);
    expect(out.comps[0]).toMatchObject({ comp_id: 1, status: "unverified", error: "interrupted", applied: "unknown" });
    expect(out.comps[0].reason).toContain("inspect");
    expect(out).toMatchObject({ ok: false, state: "stopped", summary: { unverified: 1, ok: 1, in_flight: 0 } });
    expect(out.message).toContain("Promo 16x9");

    const again = await run(resume("mc_crashed_1", { retry_failed: true }), ctx);
    expect(seen.map((s) => s.comp_id)).toEqual([2, 1]);
    expect(again.summary).toMatchObject({ ok: 2, unverified: 0 });
  });

  it("takes the checkpoint of an ae_batch_set job from its chunks and counts a step per chunk", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_batch_set", async () => ({
      ok: true,
      applied: true,
      done: 3,
      matches: true,
      chunks: [
        { done: 2, matches: true, checkpoint: { status: "created", path: "C:/cp.aep" } },
        { done: 1, matches: true, checkpoint: { status: "reused" } },
      ],
    }));
    const out = await run(single("ae_batch_set"), ctx);
    expect(out.checkpoint).toMatchObject({ status: "created" });
    expect(out.undo_note).toContain("2 steps");
  });

  it("says so when no checkpoint was captured", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_set_property", async () => ({ applied: true, receipt: { matches: true, mismatches: [] } }));
    const out = await run(single("ae_set_property"), ctx);
    expect(out.checkpoint).toBeNull();
    expect(out.checkpoint_note).toContain("No automatic checkpoint");
  });

  it("does not offer ae_checkpoint_revert when the checkpoint was skipped", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_set_property", async () => ({ applied: true, checkpoint: { status: "skipped", reason: "The project was never saved." }, receipt: { matches: true, mismatches: [] } }));
    const out = await run(single("ae_set_property"), ctx);
    expect(out.checkpoint).toBeNull();
    expect(out.checkpoint_note).toContain("never saved");
    expect(out.checkpoint_note).not.toContain("ae_checkpoint_revert");
  });

  it("lets a later real checkpoint replace an earlier skipped one, also in batch chunks", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_batch_set", async (a) => ({
      ok: true,
      applied: true,
      done: 2,
      matches: true,
      chunks: [
        { done: 1, matches: true, checkpoint: { status: "skipped", reason: "off" } },
        ...(a.comp_id === 2 ? [{ done: 1, matches: true, checkpoint: { status: "created", path: "C:/cp.aep" } }] : []),
      ],
    }));
    const out = await run(AeMultiCompApplySchema.parse({ op: { tool: "ae_batch_set", args: {} }, comp_ids: [1, 2], pause_ms: 0, expect: { project_path: aep } }), ctx);
    expect(out.checkpoint).toMatchObject({ status: "created" });
    expect(out.checkpoint_note).toContain("ae_checkpoint_revert");
  });

  it("reports applied for this call only on a resume that writes nothing", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_set_property", async () => ({ applied: true, receipt: { matches: true, mismatches: [] } }));
    const t = new Date().toISOString();
    saveJob({
      id: "mc_done_1",
      created_at: t,
      updated_at: t,
      state: "stopped",
      project_path: aep,
      tool: "ae_set_property",
      args: { layer: { name: "Title" }, value: 5 },
      on_failure: "stop",
      fingerprints: false,
      pause_ms: 0,
      selection: {},
      comps: [
        { comp_id: 1, name: "Promo 16x9", status: "ok", applied: true },
        { comp_id: 3, name: "Promo 1x1", status: "pending" },
      ],
    });
    const out = await run(resume("mc_done_1"), ctx);
    expect(out.comps[1].status).toBe("skipped");
    expect(out).toMatchObject({ applied: false, job_applied: true });
    expect(out.undo_note).toContain("0 steps");
  });

  it("probes more than 50 layer names in chunks", async () => {
    const names = Array.from({ length: 120 }, (_, i) => `L${i}`);
    const scene: Scene = { comps: [{ id: 1, name: "Promo A", layers: names }] };
    const { ctx, calls } = fakeAe(scene, aep);
    one("ae_batch_set", async () => ({}), z.object({ comp_id: z.number(), ops: z.array(z.any()), expect: z.any() }));
    const out = await run(
      AeMultiCompApplySchema.parse({
        op: { tool: "ae_batch_set", args: { ops: names.map((n) => ({ layer: { name: n } })) } },
        comp_ids: [1],
        pause_ms: 0,
        dry_run: true,
        expect: { project_path: aep },
      }),
      ctx
    );
    expect(calls.filter((c) => c === "multicompProbe")).toHaveLength(3);
    expect(out.comps[0].plan).not.toBe("skip");
  });

  it("does not call a capped fingerprint unchanged", async () => {
    const { ctx, opts } = fakeAe(SCENE, aep);
    fakeWriteTool();
    opts.fingerprintTruncated = true;
    const out = await run(base(aep, { fingerprints: true, name_pattern: "^Promo 16x9" }), ctx);
    expect(out.comps[0].changed).toBeUndefined();
    expect(out.comps[0].fingerprint_note).toContain("capped");
  });

  it("dry run of ae_set_property sends a one-op batch to the validation pass", async () => {
    const { ctx, calls } = fakeAe(SCENE, aep);
    const schema = z.object({ comp_id: z.number(), layer: z.any(), path: z.array(z.string()), value: z.any().optional(), expect: z.any() });
    one("ae_set_property", async () => ({}), schema);
    const out = await run(
      AeMultiCompApplySchema.parse({
        op: { tool: "ae_set_property", args: { layer: { name: "Title" }, path: ["ADBE Transform Group", "ADBE Opacity"], value: 5 } },
        comp_ids: [1],
        dry_run: true,
        expect: { project_path: aep },
      }),
      ctx
    );
    expect(calls).toContain("batchValidate");
    expect(out).toMatchObject({ would_run: 1, depth: "validated" });
  });

  it("refuses the target tool's own dry_run inside op.args", () => {
    const r = AeMultiCompApplySchema.safeParse({ op: { tool: "ae_add_markers", args: { dry_run: true } }, comp_ids: [1], expect: { project_path: "<unsaved>" } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("top-level dry_run");
  });

  it("refuses the job when the host sees another project while resolving", async () => {
    const { ctx, opts } = fakeAe(SCENE, aep);
    const seen = fakeWriteTool();
    opts.guardFailsOnResolve = true;
    await expect(run(base(aep), ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(seen).toEqual([]);
    expect(fs.existsSync(jobsPath(aep))).toBe(false);
  });

  it("names the cause of a selection over the listing limit", async () => {
    const { ctx, opts } = fakeAe(SCENE, aep);
    fakeWriteTool();
    opts.truncated = true;
    const out = await run(base(aep), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(out.message).toContain("900 comps");
    expect(out.message).not.toContain("scan limit");
  });

  it("carries user_changed from the inner write into the row and the result", async () => {
    const { ctx } = fakeAe(SCENE, aep);
    one("ae_set_property", async () => ({ applied: true, user_changed: "Since the last write: layer Title moved.", receipt: { matches: true, mismatches: [] } }));
    const out = await run(single("ae_set_property"), ctx);
    expect(out.comps[0].user_changed).toContain("Title moved");
    expect(out.user_changed).toEqual([{ comp_id: 1, name: "Promo 16x9", user_changed: expect.stringContaining("Title moved") }]);
  });
});

describe("multicomp.jsx", () => {
  function scene() {
    const project = new FakeProject();
    const clients = project.addFolder("Clients");
    const acme = project.addFolder("Acme", clients);
    const a1 = project.addComp("Acme Promo A", 640, 360, 4, acme);
    const a2 = project.addComp("Acme promo B", 640, 360, 4, acme);
    const top = project.addComp("Master", 1920, 1080, 10, clients);
    const loose = project.addComp("Loose", 640, 360, 2);
    // Master holds a1 (twice) and a2; a1 holds nothing.
    top.layers.add(a1);
    top.layers.add(a1);
    top.layers.add(a2);
    a1.layers.addSolid([1, 1, 1], "Title", 100, 100, 1, 2);
    a1.layers.addSolid([1, 1, 1], "BG", 100, 100, 1, 2);
    return { project, clients, acme, a1, a2, top, loose };
  }

  it("lists every comp, filters by name pattern, and honours case and exclusions", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    expect(A.multicompResolve({}).comps.map((c: any) => c.name)).toEqual(["Acme Promo A", "Acme promo B", "Master", "Loose"]);
    expect(A.multicompResolve({ name_pattern: "promo" }).comps.map((c: any) => c.name)).toEqual(["Acme promo B"]);
    expect(A.multicompResolve({ name_pattern: "promo", case_insensitive: true }).comps).toHaveLength(2);
    expect(A.multicompResolve({ name_pattern: "^Acme", exclude_ids: [s.a1.id] }).comps.map((c: any) => c.id)).toEqual([s.a2.id]);
    const first = A.multicompResolve({}).comps[0];
    expect(first).toMatchObject({ id: s.a1.id, folder: "Acme", width: 640, height: 360, num_layers: 2 });
  });

  it("walks a folder recursively", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    expect(A.multicompResolve({ folder_id: s.clients.id }).comps.map((c: any) => c.name)).toEqual(["Acme Promo A", "Acme promo B", "Master"]);
    expect(A.multicompResolve({ folder_id: s.acme.id }).matched).toBe(2);
    expect(() => A.multicompResolve({ folder_id: s.a1.id })).toThrow(/No folder/);
  });

  it("finds the comps nested inside a comp, once each, root excluded", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    const r = A.multicompResolve({ nested_in: s.top.id });
    // Breadth first from the top layer down: the layer stack lists the newest layer first.
    expect(r.comps.map((c: any) => c.id).sort()).toEqual([s.a1.id, s.a2.id].sort());
    expect(A.multicompResolve({ nested_in: s.loose.id }).comps).toEqual([]);
    expect(() => A.multicompResolve({ nested_in: 9999 })).toThrow(/No CompItem/);
  });

  it("reports ids that are not comps and refuses two selectors or a bad pattern", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    const r = A.multicompResolve({ ids: [s.a1.id, s.clients.id, 4242] });
    expect(r.comps.map((c: any) => c.id)).toEqual([s.a1.id]);
    expect(r.missing_ids).toEqual([s.clients.id, 4242]);
    expect(() => A.multicompResolve({ ids: [1], folder_id: 2 })).toThrow(/at most one/);
    expect(() => A.multicompResolve({ name_pattern: "([" })).toThrow(/regular expression/);
  });

  it("probes whether comps exist and how many layers carry each name", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    const r = A.multicompProbe({ comp_ids: [s.a1.id, s.loose.id, 4242], layer_names: ["Title", "Nope"] });
    expect(r.comps[0]).toMatchObject({ id: s.a1.id, exists: true, name: "Acme Promo A", found: { Title: 1, Nope: 0 } });
    expect(r.comps[1]).toMatchObject({ exists: true, found: { Title: 0, Nope: 0 } });
    expect(r.comps[2]).toMatchObject({ id: 4242, exists: false });
    expect(r.truncated).toBe(false);
  });

  it("checks expect in the same call and refuses another project", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["multicomp.jsx"]);
    expect(A.multicompResolve({ expect: { project_path: "<unsaved>" } }).comps).toHaveLength(4);
    expect(A.multicompResolve({ expect: { project_path: "C:/other.aep" } })).toMatchObject({ guard_failed: true, project_path: "<unsaved>" });
    expect(A.multicompProbe({ comp_ids: [s.a1.id], layer_names: [], expect: { project_path: "C:/other.aep" } })).toMatchObject({ guard_failed: true });
  });

  it("leaves the project untouched: no undo group, no new items", () => {
    const s = scene();
    const { A, undo } = loadHost(s.project, ["multicomp.jsx"]);
    const before = s.project.numItems;
    A.multicompResolve({ nested_in: s.top.id });
    A.multicompProbe({ comp_ids: [s.a1.id], layer_names: ["Title"] });
    expect(undo).toEqual({ begun: 0, ended: 0 });
    expect(s.project.numItems).toBe(before);
    expect(GUARD.project_path).toBe("<unsaved>");
  });
});
