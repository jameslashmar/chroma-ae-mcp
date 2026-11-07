import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { AeVerifyRenderSchema, checkJobOutputs, createVerifyTools, firstFrameOf, looksLikeSequence, renderChecks } from "../src/tools/ext/verify.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const comp = { comp_id: 1, name: "Edit", width: 1920, height: 1080, fps: 25, duration: 4, work_area_start: 0, work_area_duration: 2, has_audio: true };
const render = (extra: object = {}) => ({ item_id: 9, name: "r.mov", width: 1920, height: 1080, duration: 4, fps: 25, has_video: true, has_audio: true, still: false, frames: 100, ...extra });

describe("ae_verify_render helpers", () => {
  it("is registered and takes a checkpoint", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_verify_render")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_verify_render");
  });

  it("tells sequence frames from stills and movies", () => {
    const dir = tempDir("chroma-verify-looks-");
    for (const n of ["shot_0001.png", "shot_0002.png", "logo.png", "shot_0001.mov"]) fs.writeFileSync(path.join(dir, n), "x");
    expect(looksLikeSequence(path.join(dir, "shot_0001.png"))).toBe(true);
    expect(looksLikeSequence(path.join(dir, "logo.png"))).toBe(false);
    expect(looksLikeSequence(path.join(dir, "shot_0001.mov"))).toBe(false);
  });

  it("finds the first frame of an aerender [####] output", () => {
    const dir = tempDir("chroma-verify-seq-");
    for (const n of ["out_0002.png", "out_0001.png", "other_0001.png"]) fs.writeFileSync(path.join(dir, n), "x");
    expect(firstFrameOf(path.join(dir, "out_[####].png"))).toBe(path.join(dir, "out_0001.png"));
    expect(firstFrameOf(path.join(dir, "none_[####].png"))).toBeNull();
  });

  it("checks frames against the comp or its work area, frame rate, size and audio", () => {
    expect(renderChecks(render(), comp).every((c) => c.ok)).toBe(true);
    const work = renderChecks(render({ frames: 50, duration: 2 }), comp);
    expect(work.find((c) => c.what === "frames")).toMatchObject({ ok: true, note: "matches the work area" });
    const off = renderChecks(render({ frames: 99, fps: 24, width: 960, height: 540, has_audio: false }), comp);
    expect(off.filter((c) => !c.ok).map((c) => c.what)).toEqual(["frames", "fps", "size", "audio"]);
    expect(off.find((c) => c.what === "size")?.note).toMatch(/half resolution/);
    expect(renderChecks(render({ frames: 30 }), comp, 30).find((c) => c.what === "frames")?.ok).toBe(true);
  });
});

describe("ae_verify_render flow", () => {
  function fakeAe(answer: (fn: string) => unknown) {
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-verify-q-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push(fn);
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
        const r = answer(fn);
        if (r instanceof Error) return { ok: false, error: { kind: "host_error", message: r.message }, durationMs: 1 } as any;
        return { ok: true, result: r, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    return { ctx, calls };
  }

  it("imports, reads in a separate call, removes, and compares with the job's frame range", async () => {
    const dir = tempDir("chroma-verify-");
    const out = path.join(dir, "edit.mov");
    fs.writeFileSync(out, "movie");
    const tool = createVerifyTools({
      getJob: () => ({ state: "succeeded", output_path: out, comp_name: "Edit", start_frame: 0, end_frame: 49 } as any),
    })[0];
    let gone = false;
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      if (fn === "verifyRead") return gone ? new Error("No imported item 9") : render({ frames: 50 });
      gone = true;
      return { removed: 9 };
    });
    const res = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "job_1", expect: GUARD }), ctx);
    expect(calls).toEqual(["checkGuard", "verifyCompInfo", "verifyImport", "verifyRead", "verifyRemove", "verifyRead"]);
    expect(res).toMatchObject({ ok: true, matches: true, imported_item: null, project_changed: true });
    expect(res.checks.find((c: { what: string }) => c.what === "frames")).toMatchObject({ expected: 50, ok: true });
  });

  it("after the read of the imported render times out, the removal is still sent, as a must-send cleanup", async () => {
    const dir = tempDir("chroma-verify-");
    const out = path.join(dir, "edit.mov");
    fs.writeFileSync(out, "movie");
    const tool = createVerifyTools({ getJob: () => ({ state: "succeeded", output_path: out, comp_name: "Edit", start_frame: 0, end_frame: 49 } as any) })[0];
    let gone = false;
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      if (fn === "verifyRead") return gone ? new Error("No imported item 9") : render({ frames: 50 });
      gone = true;
      return { removed: 9 };
    });
    const real = ctx.bridge.evalRaw.bind(ctx.bridge);
    const sent: Array<{ fn: string; mustSend: boolean | undefined }> = [];
    let reads = 0;
    (ctx.bridge as any).evalRaw = async (params: any) => {
      const fn = String(params.script).slice("__chromaAe.".length, String(params.script).indexOf("("));
      sent.push({ fn, mustSend: params.mustSend });
      if (fn === "verifyRead" && reads++ === 0) throw new BridgeError({ kind: "timeout", message: "timed out" });
      return real(params);
    };
    await tool.handler(AeVerifyRenderSchema.parse({ job_id: "job_1", expect: GUARD }), ctx);
    expect(calls).toContain("verifyRemove");
    expect(sent.find((x) => x.fn === "verifyRemove")).toMatchObject({ mustSend: true });
  });

  it("a removal that times out is unknown, not left: it is still queued and runs when AE answers", async () => {
    const dir = tempDir("chroma-verify-");
    const out = path.join(dir, "edit.mov");
    fs.writeFileSync(out, "movie");
    const tool = createVerifyTools({ getJob: () => ({ state: "succeeded", output_path: out, comp_name: "Edit", start_frame: 0, end_frame: 49 } as any) })[0];
    const { ctx } = fakeAe((fn) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      return render({ frames: 50 });
    });
    const real = ctx.bridge.evalRaw.bind(ctx.bridge);
    (ctx.bridge as any).evalRaw = async (params: any) => {
      if (String(params.script).startsWith("__chromaAe.verifyRemove(")) throw new BridgeError({ kind: "timeout", message: "timed out" });
      return real(params);
    };
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "job_1", expect: GUARD }), ctx);
    expect(res.imported_item_state ?? res.imported_state).toBe("unknown");
  });

  it("refuses an unfinished job and a missing file before touching AE", async () => {
    const tool = createVerifyTools({ getJob: () => ({ state: "running", output_path: "x" } as any) })[0];
    const { ctx, calls } = fakeAe(() => ({}));
    expect(await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", expect: GUARD }), ctx)).toMatchObject({ error: "not_finished" });
    expect(await tool.handler(AeVerifyRenderSchema.parse({ path: path.join(os.tmpdir(), "nope.mov"), comp_id: 1, expect: GUARD }), ctx)).toMatchObject({ error: "bad_path" });
    expect(calls).toEqual([]);
  });
});

describe("verify.jsx in the simulated AE", () => {
  it("imports a render as a sequence when asked, reads it, and removes it", () => {
    const project = new FakeProject();
    const c = project.addComp("Edit", 1920, 1080, 4);
    const { A } = loadHost(project, ["verify.jsx"]);
    const file = path.join(tempDir("chroma-verify-jsx-"), "edit_1920x1080_25fps_100f_audio.mov");
    fs.writeFileSync(file, "x");
    expect(A.verifyCompInfo({ comp_id: c.id })).toMatchObject({ name: "Edit", fps: 25, duration: 4 });
    const imp = A.verifyImport({ path: file, sequence: true, expect: GUARD });
    expect((project.itemByID(imp.item_id) as any).imported_as_sequence).toBe(true);
    expect(A.verifyRead({ item_id: imp.item_id })).toMatchObject({ width: 1920, height: 1080, fps: 25, frames: 100, has_audio: true });
    A.verifyRemove({ item_id: imp.item_id, expect: GUARD });
    expect(project.itemByID(imp.item_id)).toBeNull();
    expect(() => A.verifyImport({ path: file + ".gone", expect: GUARD })).toThrow(/No render/);
  });
});

// ---------- w5render: jobs started with rq_index / whole_queue ----------

describe("w5render: ae_verify_render for Render Queue jobs", () => {
  function fakeAe(answer: (fn: string) => unknown) {
    const calls: Array<{ fn: string; script: string }> = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-verify-rq-q-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push({ fn, script });
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
        const r = answer(fn);
        if (r instanceof Error) return { ok: false, error: { kind: "host_error", message: r.message }, durationMs: 1 } as any;
        return { ok: true, result: r, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    return { ctx, calls };
  }
  const answers = () => {
    let gone = false;
    return (fn: string) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      if (fn === "verifyRead") return gone ? new Error("No imported item 9") : render({ frames: 50 });
      gone = true;
      return { removed: 9 };
    };
  };
  const job = (dir: string, extra: object = {}) => {
    const a = path.join(dir, "edit.mov");
    const b = path.join(dir, "edit_audio.mov");
    return {
      files: [a, b],
      rec: { state: "succeeded", comp_name: "Edit", output_path: a, output_paths: [a, b], comp_id: 1, item_comp_id: 1, rq_index: 2, start_frame: 0, end_frame: 49, started_at: new Date(Date.now() - 60_000).toISOString(), ...extra } as any,
    };
  };

  it("checkJobOutputs finds missing, empty and stale outputs and resolves a sequence to its first frame", () => {
    const dir = tempDir("chroma-verify-rq-out-");
    const ok = path.join(dir, "a.mov");
    const empty = path.join(dir, "b.mov");
    const stale = path.join(dir, "c.mov");
    fs.writeFileSync(ok, "x");
    fs.writeFileSync(empty, "");
    fs.writeFileSync(stale, "x");
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(dir, "s_0001.png"), "x");
    const started = new Date(Date.now() - 60_000).toISOString();
    const r = checkJobOutputs([ok, empty, stale, path.join(dir, "gone.mov"), path.join(dir, "s_[####].png")], started);
    expect(r.ok).toBe(false);
    expect(r.outputs.map((o) => o.problem)).toEqual([undefined, "the output is empty", expect.stringContaining("older than the job"), "the output does not exist", undefined]);
    expect(r.outputs[4].file).toBe(path.join(dir, "s_0001.png"));
    expect(checkJobOutputs([ok], started).ok).toBe(true);
    expect(checkJobOutputs([], started).ok).toBe(false);
  });

  it("checks every output, imports the first, and compares with the item's comp by its stored id", async () => {
    const dir = tempDir("chroma-verify-rq-");
    const j = job(dir);
    j.files.forEach((f) => fs.writeFileSync(f, "movie"));
    const tool = createVerifyTools({ getJob: () => j.rec })[0];
    const { ctx, calls } = fakeAe(answers());
    const res = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "job_rq", expect: GUARD }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "verifyCompInfo", "verifyImport", "verifyRead", "verifyRemove", "verifyRead"]);
    expect(calls[1].script).toContain('"comp_id":1');
    expect(calls[2].script).toContain(j.files[0].replace(/\\/g, "/"));
    expect(res).toMatchObject({ ok: true, matches: true, render_queue: { rq_index: 2, item_comp_id: 1 } });
    expect(res.job_outputs).toHaveLength(2);
    expect(res.job_outputs.every((o: { problem?: string }) => o.problem === undefined)).toBe(true);
    expect(res.checks.find((c: { what: string }) => c.what === "frames")).toMatchObject({ expected: 50, ok: true });
  });

  it("output_index picks which file is imported; one past the list is refused before AE is touched", async () => {
    const dir = tempDir("chroma-verify-rq-idx-");
    const j = job(dir);
    j.files.forEach((f) => fs.writeFileSync(f, "movie"));
    const tool = createVerifyTools({ getJob: () => j.rec })[0];
    const { ctx, calls } = fakeAe(answers());
    await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", output_index: 2, expect: GUARD }), ctx);
    expect(calls.find((c) => c.fn === "verifyImport")!.script).toContain(j.files[1].replace(/\\/g, "/"));
    const { ctx: ctx2, calls: calls2 } = fakeAe(answers());
    expect(await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", output_index: 3, expect: GUARD }), ctx2)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls2).toEqual([]);
  });

  it("a missing or empty output module file fails the verification before AE imports anything", async () => {
    const dir = tempDir("chroma-verify-rq-miss-");
    const j = job(dir);
    fs.writeFileSync(j.files[0], "movie");
    const tool = createVerifyTools({ getJob: () => j.rec })[0];
    const { ctx, calls } = fakeAe(answers());
    const res = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: false, error: "output_missing" });
    expect(res.message).toContain(j.files[1]);
    expect(res.outputs).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  it("a whole-queue job needs comp_id; its render queue name is never looked up as a comp", async () => {
    const dir = tempDir("chroma-verify-rq-whole-");
    const j = job(dir, { whole_queue: true, rq_index: undefined, item_comp_id: undefined, comp_id: undefined, comp_name: "<render queue>", start_frame: undefined, end_frame: undefined });
    j.files.forEach((f) => fs.writeFileSync(f, "movie"));
    const tool = createVerifyTools({ getJob: () => j.rec })[0];
    const { ctx, calls } = fakeAe(answers());
    expect(await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", expect: GUARD }), ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
    const { ctx: ctx2, calls: calls2 } = fakeAe(answers());
    const res = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", comp_id: 1, expect: GUARD }), ctx2);
    expect(res).toMatchObject({ ok: true, render_queue: { whole_queue: true } });
    expect(calls2.find((c) => c.fn === "verifyCompInfo")!.script).not.toContain("render queue");
  });

  it("a plain job is untouched: no job_outputs, the comp is found by name as before", async () => {
    const dir = tempDir("chroma-verify-plain-");
    const out = path.join(dir, "edit.mov");
    fs.writeFileSync(out, "movie");
    const tool = createVerifyTools({ getJob: () => ({ state: "succeeded", output_path: out, comp_name: "Edit", start_frame: 0, end_frame: 49 } as any) })[0];
    const { ctx, calls } = fakeAe(answers());
    const res = await tool.handler(AeVerifyRenderSchema.parse({ job_id: "j", expect: GUARD }), ctx);
    expect(res.job_outputs).toBeUndefined();
    expect(res.render_queue).toBeUndefined();
    expect(calls[1].script).toContain('"comp_name":"Edit"');
  });

  it("output_index is bounded and described", () => {
    expect(AeVerifyRenderSchema.safeParse({ job_id: "j", output_index: 0, expect: GUARD }).success).toBe(false);
    expect(AeVerifyRenderSchema.safeParse({ job_id: "j", output_index: 2, expect: GUARD }).success).toBe(true);
    expect(createVerifyTools()[0].description).toMatch(/output_index/);
  });
});
