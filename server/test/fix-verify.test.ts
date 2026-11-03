import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeVerifyRenderSchema, createVerifyTools, looksLikeSequence, renderChecks } from "../src/tools/ext/verify.js";
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

const comp = { comp_id: 1, name: "Edit", width: 1920, height: 1080, fps: 25, duration: 4, work_area_start: 0, work_area_duration: 4, has_audio: false };
const render = (extra: object = {}) => ({ item_id: 9, name: "r", width: 1920, height: 1080, duration: 100 / 30, fps: 30, has_video: true, has_audio: false, still: false, frames: 100, ...extra });

describe("sequence frame rate (C01, C39)", () => {
  it("does not fail the fps check for a sequence imported at AE's default rate", () => {
    const checks = renderChecks(render(), comp, undefined, true);
    expect(checks.find((c) => c.what === "fps")).toMatchObject({ ok: true });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(renderChecks(render(), comp).find((c) => c.what === "fps")?.ok).toBe(false);
  });

  it("still fails a sequence with the wrong frame count", () => {
    expect(renderChecks(render({ frames: 99 }), comp, undefined, true).filter((c) => !c.ok).map((c) => c.what)).toEqual(["frames"]);
  });

  it("conforms an imported sequence to the comp's rate and leaves a movie alone", () => {
    const project = new FakeProject();
    const { A } = loadHost(project, ["verify.jsx"]);
    const dir = tempDir("chroma-fixverify-");
    const file = path.join(dir, "s_1920x1080_30fps_100f.png");
    fs.writeFileSync(file, "x");
    const seq = A.verifyImport({ path: file, sequence: true, fps: 25, expect: GUARD });
    expect(((project.itemByID(seq.item_id) as any).mainSource as any).conformFrameRate).toBe(25);
    const mov = A.verifyImport({ path: file, fps: 25, expect: GUARD });
    expect(((project.itemByID(mov.item_id) as any).mainSource as any).conformFrameRate).toBeUndefined();
  });
});

describe("looksLikeSequence needs sibling frames (C89)", () => {
  it("treats a lone numbered still as a still", () => {
    const dir = tempDir("chroma-fixverify-seq-");
    for (const n of ["title1.png", "title2.png", "title3.png", "img_final_v2.png", "shot_0001.png"]) fs.writeFileSync(path.join(dir, n), "x");
    expect(looksLikeSequence(path.join(dir, "img_final_v2.png"))).toBe(false);
    expect(looksLikeSequence(path.join(dir, "shot_0001.png"))).toBe(false);
    // short unpadded numbers are not frame counters, even with siblings
    expect(looksLikeSequence(path.join(dir, "title2.png"))).toBe(false);
    fs.writeFileSync(path.join(dir, "shot_0002.png"), "x");
    expect(looksLikeSequence(path.join(dir, "shot_0001.png"))).toBe(true);
  });
});

describe("imported item is cleaned up (C90)", () => {
  function fakeAe(answer: (fn: string) => unknown) {
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixverify-q-"), "quarantine.json"));
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
    return { ctx: { bridge: host, queue, quarantine } as ToolContext, calls };
  }
  const movie = () => {
    const f = path.join(tempDir("chroma-fixverify-mov-"), "edit.mov");
    fs.writeFileSync(f, "m");
    return f;
  };
  const answers = (read: unknown, opts: { removeFails?: boolean; readKind?: string } = {}) => {
    let removed = false;
    return (fn: string) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      if (fn === "verifyRead") {
        if (removed) return new Error("No imported item 9");
        return read;
      }
      if (opts.removeFails) return new Error("cannot remove");
      removed = true;
      return { removed: 9 };
    };
  };
  const tool = createVerifyTools()[0];

  // Once the import has returned the tool never throws: failures come back with the item's state.
  it("removes the item when the read fails, and reports instead of throwing", async () => {
    const { ctx, calls } = fakeAe(answers(new Error("read broke")));
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), ctx);
    expect(calls).toContain("verifyRemove");
    expect(res).toMatchObject({ ok: false, error: "read_failed", applied: true, imported_item: null, imported_item_state: "removed", project_changed: true });
    expect(res.problems[0].message).toMatch(/reading the imported render failed.*read broke.*Do not resend/);
  });

  it("keeps the item when keep_imported is set and names it", async () => {
    const { ctx, calls } = fakeAe(answers(new Error("boom")));
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, keep_imported: true, expect: GUARD }), ctx);
    expect(calls).not.toContain("verifyRemove");
    expect(res).toMatchObject({ ok: false, error: "read_failed", imported_item: 9, imported_item_state: "kept" });
    expect(res.message).toMatch(/item 9 \(kept\)/);
  });

  it("skips the cleanup after a timeout and names the leftover item", async () => {
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixverify-q-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push(fn);
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
        if (fn === "verifyRead") return { ok: false, error: { kind: "timeout", message: "timed out" }, durationMs: 1 } as any;
        return { ok: true, result: answers(null)(fn), durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), { bridge: host, queue, quarantine } as ToolContext);
    expect(calls).not.toContain("verifyRemove");
    expect(res).toMatchObject({ ok: false, error: "read_failed", imported_item: 9, imported_item_state: "left" });
  });

  it("returns the checks and reports the item when the removal fails after a good read", async () => {
    const { ctx } = fakeAe(answers(render(), { removeFails: true }));
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), ctx);
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.checks)).toBe(true);
    expect(res).toMatchObject({ imported_item: 9, imported_item_state: "left" });
    expect(res.problems[0].message).toMatch(/removing the imported render \(item 9\) failed.*cannot remove/);
  });

  it("says the item's state is unknown when the check after removing it fails", async () => {
    let removed = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "verifyCompInfo") return comp;
      if (fn === "verifyImport") return { item_id: 9 };
      if (fn === "verifyRead") return removed ? new Error("bridge hiccup") : render({ fps: 25, duration: 4, frames: 100 });
      removed = true;
      return { removed: 9 };
    });
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: true, imported_item: 9, imported_item_state: "unknown" });
    expect(res.problems[0].message).toMatch(/is gone failed.*bridge hiccup/);
  });

  it("reads back that the item is gone and reports it when it is not", async () => {
    const ok = fakeAe(answers(render({ fps: 25, duration: 4, frames: 100 })));
    const done: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), ok.ctx);
    expect(done.imported_item).toBeNull();
    // a removal that silently did nothing: the read-back still finds the item
    const stuck = fakeAe((fn) => (fn === "verifyRemove" ? { removed: 9 } : answers(render({ fps: 25, duration: 4, frames: 100 }))(fn)));
    const res: any = await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, expect: GUARD }), stuck.ctx);
    expect(res.imported_item).toBe(9);
    expect(res.imported_item_state).toBe("left");
    expect(res.problems[0].path).toBe("cleanup");
  });

  it("rolls back a non-footage import in the simulated AE", () => {
    const project = new FakeProject();
    const { A } = loadHost(project, ["verify.jsx"]);
    const dir = tempDir("chroma-fixverify-nf-");
    const file = path.join(dir, "x.png");
    fs.writeFileSync(file, "x");
    let made: any;
    project.importFile = () => {
      made = project.addComp("not footage");
      // the fake comp has no remove(); a real AE item does
      made.remove = () => { project.all = project.all.filter((x: any) => x !== made); };
      return made;
    };
    expect(() => A.verifyImport({ path: file, expect: GUARD })).toThrow(/Not a footage file/);
    expect(project.itemByID(made.id)).toBeFalsy();
  });

  it("passes the comp rate to the import only for a sequence", async () => {
    const scripts: string[] = [];
    const { ctx } = fakeAe((fn) => answers(render({ fps: 25, duration: 4, frames: 100 }))(fn));
    const orig = (ctx.bridge as any).evalRaw.bind(ctx.bridge);
    (ctx.bridge as any).evalRaw = (o: any) => (scripts.push(o.script), orig(o));
    const png = path.join(tempDir("chroma-fixverify-png-"), "shot_0001.png");
    fs.writeFileSync(png, "p");
    await tool.handler(AeVerifyRenderSchema.parse({ path: png, comp_id: 1, sequence: true, expect: GUARD }), ctx);
    expect(scripts.find((s) => s.includes("verifyImport"))).toContain('"fps":25');
    scripts.length = 0;
    await tool.handler(AeVerifyRenderSchema.parse({ path: movie(), comp_id: 1, sequence: true, expect: GUARD }), ctx);
    expect(scripts.find((s) => s.includes("verifyImport"))).not.toContain('"fps"');
  });
});

void BridgeError;
