import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { AeVerifyRenderSchema, createVerifyTools, firstFrameOf, looksLikeSequence, renderChecks } from "../src/tools/ext/verify.js";
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
