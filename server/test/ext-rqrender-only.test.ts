import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { renderGate } from "../src/render-gate.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeRenderQueueRenderSchema,
  AeRenderQueueRenderStatusSchema,
  RenderJobStore,
  ameNearApp,
  ameRootCandidates,
  bindJobFailureLog,
  jobsFileFor,
  planStart,
  rqrenderDeps,
  otherExtensionFiles,
  resetRenderJobStores,
  rqrenderTools,
  storeFor,
} from "../src/tools/ext/rqrender.js";
import { FakeFile, FakeProject, loadHost } from "./support/fake-ae.js";

const STATUS = { WILL_CONTINUE: 1, NEEDS_OUTPUT: 2, UNQUEUED: 3, QUEUED: 4, RENDERING: 5, USER_STOPPED: 6, ERR_STOPPED: 7, DONE: 8 };
const NAMES: Record<number, string> = { 1: "will_continue", 2: "needs_output", 3: "unqueued", 4: "queued", 5: "rendering", 6: "user_stopped", 7: "err_stopped", 8: "done" };

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rqonly-"));
  tmpDirs.push(d);
  return d;
};
const realAmeInstalled = rqrenderDeps.ameInstalled;
const realAmeNear = rqrenderDeps.ameNearApp;
beforeEach(() => {
  rqrenderDeps.ameInstalled = () => true;
  rqrenderDeps.ameNearApp = realAmeNear;
  renderGate.reset();
  resetRenderJobStores();
});
afterEach(() => {
  rqrenderDeps.ameInstalled = realAmeInstalled;
  rqrenderDeps.ameNearApp = realAmeNear;
  renderGate.reset();
  resetRenderJobStores();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => rqrenderTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const SAVED_PATH = "C:\\work\\demo.aep";

class QItem {
  status = STATUS.QUEUED;
  renderFlag = true;
  /** A box that cannot be unchecked (to make the hold fail). */
  stuck = false;
  elapsedSeconds = 3;
  startTime = { getTime: () => 1700000000000 };
  timeSpanStart = 0;
  timeSpanDuration = 10;
  skipFrames = 0;
  mods: Array<{ name: string; file: FakeFile; postRenderAction: number; includeSourceXMP: boolean }>;
  constructor(public comp: { id: number; name: string }, file: string) {
    this.mods = [{ name: "Lossless", file: new FakeFile(file), postRenderAction: 20, includeSourceXMP: false }];
  }
  get render() {
    return this.renderFlag;
  }
  set render(v: boolean) {
    if (this.stuck) return;
    this.renderFlag = v;
    if (!v && this.status === STATUS.QUEUED) this.status = STATUS.UNQUEUED;
    else if (v && this.status === STATUS.UNQUEUED) this.status = STATUS.QUEUED;
  }
  get numOutputModules() {
    return this.mods.length;
  }
  outputModule(i: number) {
    return this.mods[i - 1];
  }
}

/** A Render Queue of QItems under the real rqedit.jsx; the evalScripts run in node:vm. */
function fakeAe(opts: { count?: number; saved?: boolean } = {}) {
  const dir = tmp();
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const project = new FakeProject();
  const list: QItem[] = [];
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  for (let i = 0; i < (opts.count ?? 3); i++) {
    const comp = project.addComp(names[i], 1920, 1080, 10);
    list.push(new QItem(comp, path.join(outDir, `${names[i].toLowerCase()}.mp4`)));
  }
  const behaviour = {
    /** What the render does: finish the QUEUED items, stop them, or raise. */
    mode: "done" as "done" | "stopped" | "throw",
    /** Runs inside render(), where AE is busy. */
    during: undefined as undefined | (() => void),
    /** Runs when the render is over, still inside render(). */
    after: undefined as undefined | (() => void),
    /** The render eval answers as if AE died. */
    unreachable: false,
    /** Adobe Media Encoder: canQueueInAME is false / the property is missing. */
    ameCan: true,
    ameMissing: false,
    /** queueInAME raises. */
    ameThrows: false,
    /** Runs inside queueInAME. */
    duringAme: undefined as undefined | (() => void),
  };
  const rq = {
    rendering: false,
    renders: 0,
    get numItems() {
      return list.length;
    },
    item: (i: number) => list[i - 1],
    ameCalls: [] as boolean[],
    get canQueueInAME() {
      if (behaviour.ameMissing) return undefined;
      return behaviour.ameCan && list.some((i) => i.status === STATUS.QUEUED);
    },
    queueInAME(now: boolean) {
      if (behaviour.ameThrows) throw new Error("Media Encoder is not installed");
      rq.ameCalls.push(now);
      behaviour.duringAme?.();
    },
    render() {
      rq.renders++;
      behaviour.during?.();
      if (behaviour.mode === "throw") throw new Error("Render failed");
      for (const it of list) {
        if (it.status !== STATUS.QUEUED) continue;
        if (behaviour.mode === "stopped") {
          it.status = STATUS.USER_STOPPED;
          continue;
        }
        fs.writeFileSync(it.mods[0].file.fsName, "x");
        it.status = STATUS.DONE;
      }
      behaviour.after?.();
    },
  };
  (project as unknown as { renderQueue: unknown }).renderQueue = rq;
  if (opts.saved) {
    project.file = { fsName: SAVED_PATH };
    project.dirty = false;
  }
  const { A, G, undo } = loadHost(project, ["rqedit.jsx"]);
  Object.assign(G, { RQItemStatus: STATUS });

  const calls: Array<{ fn: string; script: string; label: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script, label) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script, label });
      if (fn === "rqeditRender" && behaviour.unreachable) {
        rq.renders++;
        return { ok: false as const, error: { kind: "unreachable", message: "panel gone" } };
      }
      if (fn === "sessionSnapshot") return { ok: true as const, result: { project_path: "<unsaved>", fn }, durationMs: 1 };
      try {
        const out = vm.runInContext(script, G);
        return { ok: true as const, result: out === undefined ? null : JSON.parse(JSON.stringify(out)), durationMs: 1 };
      } catch (e) {
        const err = e as { message?: string; __kind?: string };
        return { ok: false as const, error: { kind: err.__kind === "guard" ? "guard" : "evalscript_error", message: String(err.message ?? e) } };
      }
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir, serviceInfo: () => ({ inFlight: null }) };
  const states = () => list.map((i) => NAMES[i.status]);
  return { ctx, A, G, undo, list, rq, calls, behaviour, project, dir, outDir, states };
}

const start = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  tool("ae_render_queue_render").handler(AeRenderQueueRenderSchema.parse({ expect: expectArg, ...extra }), ctx) as Promise<Record<string, any>>;
const status = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  tool("ae_render_queue_render_status").handler(AeRenderQueueRenderStatusSchema.parse({ include_dialogs: false, ...extra }), ctx) as Promise<Record<string, any>>;
const finish = async (ctx: ToolContext, out: Record<string, any>) => {
  await storeFor(ctx).done(out.job_id);
  return storeFor(ctx).get(out.job_id)!;
};

describe("ae_render_queue_render item_indexes: only the chosen items render", () => {
  it("renders item 2 only; the others are unchecked during the render and checked again after it", async () => {
    const f = fakeAe();
    let during: string[] = [];
    f.behaviour.during = () => {
      during = f.states();
    };
    const out = await start(f.ctx, { item_indexes: [2], comp_ids: [f.list[1].comp.id] });
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.held_back.map((h: any) => h.index)).toEqual([1, 3]);
    expect(out.items.map((i: any) => i.index)).toEqual([2]);
    const rec = await finish(f.ctx, out);

    expect(during).toEqual(["unqueued", "queued", "unqueued"]);
    expect(f.states()).toEqual(["queued", "done", "queued"]);
    expect(fs.existsSync(f.list[0].mods[0].file.fsName)).toBe(false);
    expect(fs.existsSync(f.list[1].mods[0].file.fsName)).toBe(true);
    expect(fs.existsSync(f.list[2].mods[0].file.fsName)).toBe(false);
    expect(f.list.map((i) => i.render)).toEqual([true, true, true]);

    expect(rec.state).toBe("finished");
    expect(rec.ok).toBe(true);
    expect(rec.only_item_indexes).toEqual([2]);
    expect(rec.restore?.state).toBe("restored");
    expect(rec.restore?.restored.map((r) => r.index)).toEqual([1, 3]);
    expect(rec.restore?.not_restored).toEqual([]);
    expect(rec.summary).toMatch(/QUEUED again: 1 \(Alpha\), 3 \(Charlie\)/);

    // One undo group for the hold and one for the restore; the reads and the render are their own evalScripts.
    expect(f.undo.begun).toBe(2);
    expect(f.undo.ended).toBe(2);
    const order = f.calls.map((c) => c.fn).filter((fn) => fn.startsWith("rqedit"));
    expect(order).toEqual(["rqeditRead", "rqeditHold", "rqeditRead", "rqeditRender", "rqeditRenderResult", "rqeditRelease", "rqeditRead"]);
    expect(f.calls.find((c) => c.fn === "rqeditRender")!.script).toContain('"expected_queued":1');

    const st = await status(f.ctx);
    expect(st.restore.state).toBe("restored");
    expect(st.restore_summary).toMatch(/QUEUED again/);
    expect(st.restore_pending).toBeUndefined();
    expect(st.only_item_indexes).toEqual([2]);
  });

  it("renders two chosen items and holds back only the third", async () => {
    const f = fakeAe();
    const out = await start(f.ctx, { item_indexes: [1, 3] });
    expect(out.held_back.map((h: any) => h.index)).toEqual([2]);
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["done", "queued", "done"]);
    expect(rec.restore?.state).toBe("restored");
  });

  it("holds nothing back when the chosen item is the only QUEUED one, and records no restore", async () => {
    const f = fakeAe();
    f.list[0].status = STATUS.DONE;
    f.list[2].status = STATUS.UNQUEUED;
    f.list[2].renderFlag = false;
    const out = await start(f.ctx, { item_indexes: [2] });
    expect(out.held_back).toBeUndefined();
    const rec = await finish(f.ctx, out);
    expect(rec.restore).toBeUndefined();
    expect(f.calls.some((c) => c.fn === "rqeditHold" || c.fn === "rqeditRelease")).toBe(false);
    expect(f.states()).toEqual(["done", "done", "unqueued"]);
  });

  it("an item that was UNQUEUED before is never touched or restored", async () => {
    const f = fakeAe();
    f.list[2].status = STATUS.UNQUEUED;
    f.list[2].renderFlag = false;
    const out = await start(f.ctx, { item_indexes: [2] });
    expect(out.held_back.map((h: any) => h.index)).toEqual([1]);
    await finish(f.ctx, out);
    expect(f.states()).toEqual(["queued", "done", "unqueued"]);
  });

  it("puts the held items back after a render that raised an error", async () => {
    const f = fakeAe();
    f.behaviour.mode = "throw";
    const out = await start(f.ctx, { item_indexes: [3] });
    const rec = await finish(f.ctx, out);
    expect(rec.state).toBe("failed");
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    expect(rec.restore?.state).toBe("restored");
    expect(rec.restore?.restored.map((r) => r.index)).toEqual([1, 2]);
    expect(rec.summary).toMatch(/QUEUED again/);
    expect(renderGate.active()).toBeNull();
  });

  it("puts the held items back after a render the user stopped", async () => {
    const f = fakeAe();
    f.behaviour.mode = "stopped";
    const out = await start(f.ctx, { item_indexes: [1] });
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["user_stopped", "queued", "queued"]);
    expect(rec.ok).toBe(false);
    expect(rec.summary).toMatch(/USER_STOPPED/);
    expect(rec.restore?.state).toBe("restored");
  });

  it("does not queue a changed, moved or deleted item again, and reports each", async () => {
    const f = fakeAe(); // Alpha, Bravo (chosen), Charlie
    f.behaviour.during = () => {
      // Alpha gets another output file; Charlie is deleted. (Both while AE renders: a person edited the queue.)
      f.list[0].mods[0].file = new FakeFile(path.join(f.outDir, "alpha-other.mp4"));
      f.list.splice(2, 1);
    };
    const out = await start(f.ctx, { item_indexes: [2] });
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["unqueued", "done"]);
    expect(rec.restore?.state).toBe("partial");
    expect(rec.restore?.restored).toEqual([]);
    const byIndex = Object.fromEntries((rec.restore?.not_restored ?? []).map((n) => [n.index, n.code]));
    expect(byIndex).toEqual({ 1: "changed", 3: "gone" });
    expect(rec.summary).toMatch(/NOT queued again: 1 \(Alpha\): its output file\(s\) changed; 3 \(Charlie\): no item with that comp and output file is left/);
    const st = await status(f.ctx);
    expect(st.restore_summary).toMatch(/NOT queued again/);
    expect(st.restore.not_restored).toHaveLength(2);
  });

  it("reports an item that moved and restores the others", async () => {
    const f = fakeAe({ count: 4 }); // Alpha, Bravo (chosen), Charlie, Delta
    f.behaviour.during = () => {
      // Charlie and Delta swap places.
      const [c, d] = [f.list[2], f.list[3]];
      f.list[2] = d;
      f.list[3] = c;
    };
    const out = await start(f.ctx, { item_indexes: [2] });
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["queued", "done", "unqueued", "unqueued"]);
    const moved = (rec.restore?.not_restored ?? []).filter((n) => n.code === "moved");
    expect(moved.map((m) => [m.index, m.now_at])).toEqual([
      [3, 4],
      [4, 3],
    ]);
    expect(rec.restore?.restored.map((r) => r.index)).toEqual([1]);
    expect(rec.restore?.state).toBe("partial");
  });

  it("treats an item the user queued again meanwhile as fine", async () => {
    const f = fakeAe();
    f.behaviour.after = () => {
      f.list[0].render = true;
    };
    const out = await start(f.ctx, { item_indexes: [2] });
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["queued", "done", "queued"]);
    expect(rec.restore?.state).toBe("restored");
    expect(rec.restore?.not_restored.map((n) => n.code)).toEqual(["already_queued"]);
  });

  it("an AE that dies mid-render leaves the restore pending on disk, and the status says how to finish it", async () => {
    const f = fakeAe();
    f.behaviour.unreachable = true;
    const out = await start(f.ctx, { item_indexes: [2] });
    const rec = await finish(f.ctx, out);
    expect(rec.state).toBe("unknown");
    expect(rec.restore?.state).toBe("pending");
    expect(f.states()).toEqual(["unqueued", "queued", "unqueued"]);
    expect(f.calls.some((c) => c.fn === "rqeditRelease")).toBe(false);

    const st = await status(f.ctx);
    expect(st.restore_pending).toBe(true);
    expect(st.restore_how).toMatch(/ae_render_queue_edit/);
    expect(st.restore_how).toMatch(/queued: true/);
    expect(st.restore.held.map((h: any) => [h.index, h.comp_id])).toEqual([
      [1, f.list[0].comp.id],
      [3, f.list[2].comp.id],
    ]);

    // A service restart: the record is read from disk, the job is "lost", the list is still there.
    renderGate.reset();
    resetRenderJobStores();
    const again = new RenderJobStore(jobsFileFor(f.ctx));
    const back = again.get(out.job_id)!;
    expect(back.restore?.state).toBe("pending");
    expect(back.restore?.held).toHaveLength(2);
    expect(back.restore?.held[0].files[0]).toBe(f.list[0].mods[0].file.fsName);
  });

  it("the job record is on disk before the other items are unchecked", async () => {
    const f = fakeAe();
    let onDisk: any = null;
    const realEval = f.ctx.bridge.evalRaw.bind(f.ctx.bridge);
    (f.ctx.bridge as any).evalRaw = async (p: any) => {
      if (p.id.endsWith("_hold")) onDisk = JSON.parse(fs.readFileSync(jobsFileFor(f.ctx), "utf8")).jobs[0];
      return realEval(p);
    };
    const out = await start(f.ctx, { item_indexes: [2] });
    await finish(f.ctx, out);
    expect(onDisk?.restore?.state).toBe("pending");
    expect(onDisk?.restore?.held.map((h: any) => h.index)).toEqual([1, 3]);
  });

  it("puts back what it unchecked and refuses when the read-back shows another item still QUEUED", async () => {
    const f = fakeAe();
    f.list[2].stuck = true; // its Render box cannot be unchecked
    const out = await start(f.ctx, { item_indexes: [2] });
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("hold_failed");
    expect(out.refused[0].message).toMatch(/item 3 is still QUEUED/);
    expect(out.refused[0].message).toMatch(/QUEUED again/);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    expect(f.rq.renders).toBe(0);
    expect(renderGate.active()).toBeNull();
    expect(storeFor(f.ctx).list()).toEqual([]);
    // hold, read, release, read: nothing was left behind.
    expect(f.calls.map((c) => c.fn).filter((fn) => fn.startsWith("rqedit"))).toEqual(["rqeditRead", "rqeditHold", "rqeditRead", "rqeditRelease", "rqeditRead"]);
  });

  it("keeps the record and says what is left when the rollback cannot finish", async () => {
    const f = fakeAe();
    f.list[2].stuck = true;
    const realEval = f.ctx.bridge.evalRaw.bind(f.ctx.bridge);
    (f.ctx.bridge as any).evalRaw = async (p: any) => {
      if (p.id.endsWith("_unhold")) throw new Error("AE did not answer");
      return realEval(p);
    };
    const out = await start(f.ctx, { item_indexes: [2] });
    expect(out.ok).toBe(false);
    expect(out.restore_how).toMatch(/ae_render_queue_edit/);
    expect(f.rq.renders).toBe(0);
    const rec = storeFor(f.ctx).get(out.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.restore?.state).toBe("failed");
    expect(f.states()).toEqual(["unqueued", "queued", "queued"]);
  });
});

describe("ae_render_queue_render item_indexes: refusals before any write", () => {
  const untouched = (f: ReturnType<typeof fakeAe>) => {
    expect(f.undo.begun).toBe(0);
    expect(f.rq.renders).toBe(0);
    expect(f.calls.some((c) => c.fn === "rqeditHold" || c.fn === "rqeditRender" || c.fn === "rqeditRelease")).toBe(false);
    expect(renderGate.active()).toBeNull();
    expect(storeFor(f.ctx).list()).toEqual([]);
  };

  it("refuses an item that is not QUEUED, with its status", async () => {
    const f = fakeAe();
    f.list[1].status = STATUS.DONE;
    const out = await start(f.ctx, { item_indexes: [2] });
    expect(out.ok).toBe(false);
    expect(out.refused[0]).toMatchObject({ code: "item_not_queued", item_index: 2 });
    expect(out.refused[0].message).toMatch(/is done, not QUEUED/);
    untouched(f);
    expect(f.states()).toEqual(["queued", "done", "queued"]);
  });

  it("refuses an index that is not in the queue", async () => {
    const f = fakeAe();
    const out = await start(f.ctx, { item_indexes: [2, 9] });
    expect(out.refused.map((r: any) => r.code)).toEqual(["item_not_found"]);
    untouched(f);
  });

  it("refuses a comp that is not the one at that index", async () => {
    const f = fakeAe();
    const out = await start(f.ctx, { item_indexes: [1, 2], comp_ids: [f.list[0].comp.id, f.list[2].comp.id] });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]).toMatchObject({ code: "item_comp_mismatch", item_index: 2 });
    untouched(f);
  });

  it("refuses comp_ids of another length, and comp_ids without item_indexes", async () => {
    const f = fakeAe();
    const a = await start(f.ctx, { item_indexes: [1, 2], comp_ids: [f.list[0].comp.id] });
    expect(a.refused[0].code).toBe("bad_item_indexes");
    const b = await start(f.ctx, { comp_ids: [f.list[0].comp.id] });
    expect(b.refused[0].code).toBe("bad_item_indexes");
    untouched(f);
  });

  it("applies the output pre-checks to the chosen items only", async () => {
    const f = fakeAe();
    fs.writeFileSync(f.list[1].mods[0].file.fsName, "old"); // Bravo's file exists
    const refused = await start(f.ctx, { item_indexes: [2] });
    expect(refused.refused[0].code).toBe("output_exists");
    untouched(f);
    // An existing file of an item that is NOT chosen is not a reason to refuse.
    const ok = await start(f.ctx, { item_indexes: [1] });
    expect(ok).toMatchObject({ ok: true, started: true });
    await finish(f.ctx, ok);
    expect(f.states()).toEqual(["done", "queued", "queued"]);
  });

  it("still refuses a checked item without an output, and a queue already rendering", async () => {
    const f = fakeAe();
    f.list[2].status = STATUS.NEEDS_OUTPUT;
    const a = await start(f.ctx, { item_indexes: [1] });
    expect(a.refused.map((r: any) => r.code)).toContain("needs_output");
    f.list[2].status = STATUS.QUEUED;
    f.rq.rendering = true;
    const b = await start(f.ctx, { item_indexes: [1] });
    expect(b.refused.map((r: any) => r.code)).toContain("already_rendering");
    untouched(f);
  });

  it("the schema bounds the list and keeps the argument optional", () => {
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg }).success).toBe(true);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, item_indexes: [] }).success).toBe(false);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, item_indexes: [0] }).success).toBe(false);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, item_indexes: [1.5] }).success).toBe(false);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, item_indexes: [1, 2], comp_ids: [5, 6] }).success).toBe(true);
  });
});

describe("ae_render_queue_render without item_indexes", () => {
  it("renders every QUEUED item, as before: no hold, no restore, no expected_queued", async () => {
    const f = fakeAe();
    const out = await start(f.ctx);
    expect(out.held_back).toBeUndefined();
    const rec = await finish(f.ctx, out);
    expect(f.states()).toEqual(["done", "done", "done"]);
    expect(rec.restore).toBeUndefined();
    expect(rec.only_item_indexes).toBeUndefined();
    expect(f.undo.begun).toBe(0);
    expect(f.calls.map((c) => c.fn).filter((fn) => fn.startsWith("rqedit"))).toEqual(["rqeditRead", "rqeditRender", "rqeditRenderResult"]);
    expect(f.calls.find((c) => c.fn === "rqeditRender")!.script).toBe("__chromaAe.rqeditRender({})");
    const st = await status(f.ctx);
    expect(st.restore).toBeUndefined();
    expect(st.restore_summary).toBeUndefined();
  });
});

describe("planStart with item_indexes", () => {
  const q = (...items: any[]) => ({ numItems: items.length, rendering: false, items } as any);
  const qi = (index: number, status = "queued") => ({ index, comp_id: 10 + index, comp_name: `C${index}`, status, output_modules: [{ index: 1, file: `C:\\no-such-dir-${index}\\x.mp4` }] });

  it("lists the other QUEUED items to hold, with their files, and judges the chosen ones only", () => {
    const plan = planStart(q(qi(1), qi(2), qi(3, "unqueued"), qi(4)), true, [], { indexes: [2] });
    expect(plan.items.map((i) => i.index)).toEqual([2]);
    expect(plan.hold).toEqual([
      { index: 1, comp_id: 11, comp_name: "C1", files: ["C:\\no-such-dir-1\\x.mp4"] },
      { index: 4, comp_id: 14, comp_name: "C4", files: ["C:\\no-such-dir-4\\x.mp4"] },
    ]);
  });

  it("without the argument the hold list is empty and the plan is what it was", () => {
    const plan = planStart(q(qi(1), qi(2)), true, []);
    expect(plan.hold).toEqual([]);
    expect(plan.items.map((i) => i.index)).toEqual([1, 2]);
  });

  it("names a repeated index once", () => {
    const plan = planStart(q(qi(1), qi(2)), true, [], { indexes: [2, 2] });
    expect(plan.items.map((i) => i.index)).toEqual([2]);
    expect(plan.hold.map((h) => h.index)).toEqual([1]);
  });
});

describe("ae_render_queue_render engine media_encoder (opt-in)", () => {
  const ame = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
    start(ctx, { engine: "media_encoder", user_confirmed: true, expect: { project_path: SAVED_PATH }, ...extra });
  const calledFns = (f: ReturnType<typeof fakeAe>) => f.calls.map((c) => c.fn).filter((fn) => fn.startsWith("rqedit"));
  /** Leaves only item n QUEUED (the others UNQUEUED with their Render box off), as a person would before a Media Encoder hand-over. */
  const onlyQueued = (f: ReturnType<typeof fakeAe>, n: number) => {
    f.list.forEach((it, k) => {
      if (k + 1 === n) return;
      it.status = STATUS.UNQUEUED;
      it.renderFlag = false;
    });
  };

  it("refuses without user_confirmed and says what to ask the user; nothing is sent to AE", async () => {
    const f = fakeAe({ saved: true });
    const out = await start(f.ctx, { engine: "media_encoder", expect: { project_path: SAVED_PATH } });
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("user_confirmation_needed");
    expect(out.refused[0].message).toMatch(/Ask the user first/);
    expect(out.refused[0].message).toMatch(/Media Encoder renders the SAVED project/);
    expect(out.refused[0].message).toMatch(/After Effects stays free/);
    expect(out.refused[0].message).toMatch(/take a moment to open/);
    const no = await start(f.ctx, { engine: "media_encoder", user_confirmed: false, expect: { project_path: SAVED_PATH } });
    expect(no.refused[0].code).toBe("user_confirmation_needed");
    expect(f.calls).toHaveLength(0);
    expect(f.rq.ameCalls).toEqual([]);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("refuses an unsaved project and a project with unsaved changes (save first with ae_save)", async () => {
    const f = fakeAe(); // never saved
    const a = await start(f.ctx, { engine: "media_encoder", user_confirmed: true });
    expect(a.refused[0].code).toBe("project_unsaved");
    expect(a.refused[0].message).toMatch(/ae_save/);
    const g = fakeAe({ saved: true });
    g.project.dirty = true;
    const b = await ame(g.ctx);
    expect(b.refused[0].code).toBe("project_unsaved");
    expect(b.refused[0].message).toMatch(/unsaved changes/);
    expect(b.refused[0].message).toMatch(/ae_save/);
    for (const x of [f, g]) {
      expect(x.rq.ameCalls).toEqual([]);
      expect(x.undo.begun).toBe(0);
      expect(storeFor(x.ctx).list()).toEqual([]);
    }
  });

  it("refuses when canQueueInAME is false or the property is missing", async () => {
    const f = fakeAe({ saved: true });
    f.behaviour.ameCan = false;
    const a = await ame(f.ctx);
    expect(a.refused[0].code).toBe("ame_unavailable");
    expect(a.refused[0].message).toMatch(/canQueueInAME is false/);
    f.behaviour.ameCan = true;
    f.behaviour.ameMissing = true;
    const b = await ame(f.ctx);
    expect(b.refused[0].code).toBe("ame_unavailable");
    expect(b.refused[0].message).toMatch(/no renderQueue\.canQueueInAME/);
    expect(f.rq.ameCalls).toEqual([]);
    expect(f.calls.some((c) => c.fn === "rqeditQueueInAme" || c.fn === "rqeditHold")).toBe(false);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("still applies the output pre-checks", async () => {
    const f = fakeAe({ saved: true });
    fs.writeFileSync(f.list[0].mods[0].file.fsName, "old");
    const out = await ame(f.ctx);
    expect(out.refused.map((r: any) => r.code)).toContain("output_exists");
    expect(f.rq.ameCalls).toEqual([]);
  });

  it("default start_now false: calls queueInAME(false), items wait in AME, state queued_in_media_encoder, no gate", async () => {
    const f = fakeAe({ saved: true });
    const out = await ame(f.ctx);
    expect(out).toMatchObject({ ok: true, started: true, state: "queued_in_media_encoder", start_now: false });
    expect(f.rq.ameCalls).toEqual([false]);
    expect(f.rq.renders).toBe(0);
    expect(renderGate.active()).toBeNull();
    expect(out.note).toMatch(/WAIT there/);
    expect(out.note).toMatch(/check the preset and format/);
    expect(out.note).toMatch(/press Start/);
    expect(f.calls.find((c) => c.fn === "rqeditQueueInAme")!.script).toContain('"start_now":false');
    const rec = storeFor(f.ctx).get(out.job_id)!;
    expect(rec.state).toBe("queued_in_media_encoder");
    expect(rec.summary).toMatch(/Start/);
    const st = await status(f.ctx);
    expect(st.state).toBe("queued_in_media_encoder");
    expect(st.message).toMatch(/presses Start|presses Start there|pressed Start/);
  });

  it("refuses with ame_not_installed (usual folders and the AE install folder both lack it) before anything is written", async () => {
    const f = fakeAe({ saved: true });
    rqrenderDeps.ameInstalled = () => false;
    rqrenderDeps.ameNearApp = () => false;
    const out = await ame(f.ctx);
    expect(out.refused[0].code).toBe("ame_not_installed");
    expect(out.refused[0].message).toContain("C:\\Program Files\\Adobe");
    expect(out.refused[0].message).not.toContain("C:Program");
    expect(calledFns(f)).toEqual(["rqeditRead", "rqeditAmeState"]);
    expect(f.rq.ameCalls).toEqual([]);
    expect(f.undo.begun).toBe(0);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("does not refuse as not installed when Media Encoder sits next to After Effects' own install folder", async () => {
    const f = fakeAe({ saved: true });
    rqrenderDeps.ameInstalled = () => false;
    let seen: unknown = "unset";
    rqrenderDeps.ameNearApp = (p) => {
      seen = p;
      return true;
    };
    const out = await ame(f.ctx);
    expect(out).toMatchObject({ ok: true, started: true });
    expect(seen).toBeNull(); // the fake AE has no Folder.appPackage: the host reports null, never throws
    expect(f.rq.ameCalls).toEqual([false]);
  });

  it("the consent text names the preset risk", async () => {
    const f = fakeAe({ saved: true });
    const out = await start(f.ctx, { engine: "media_encoder", expect: { project_path: SAVED_PATH } });
    expect(out.refused[0].message).toMatch(/last-used preset/);
  });

  it("the consent text says to check preset and format, and that other AME items start too", async () => {
    const f = fakeAe({ saved: true });
    const out = await start(f.ctx, { engine: "media_encoder", expect: { project_path: SAVED_PATH } });
    expect(out.refused[0].message).toMatch(/check the preset and format/);
    expect(out.refused[0].message).toMatch(/other items already in Media Encoder.s queue start too/);
    expect(out.refused[0].message).toMatch(/ProRes 4444/);
  });

  it("start_now true without whole_ame_queue_ok is refused before anything is sent to AE or AME", async () => {
    const f = fakeAe({ saved: true });
    const out = await start(f.ctx, { engine: "media_encoder", user_confirmed: true, start_now: true, expect: { project_path: SAVED_PATH } });
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("whole_ame_queue_not_confirmed");
    expect(out.refused[0].message).toMatch(/EVERY item waiting/);
    const no = await start(f.ctx, { engine: "media_encoder", user_confirmed: true, start_now: true, whole_ame_queue_ok: false, expect: { project_path: SAVED_PATH } });
    expect(no.refused[0].code).toBe("whole_ame_queue_not_confirmed");
    expect(f.calls).toHaveLength(0);
    expect(f.rq.ameCalls).toEqual([]);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("start_now true: calls queueInAME(true), sets no render gate, and does not call render()", async () => {
    const f = fakeAe({ saved: true });
    let gateDuring: unknown = "unset";
    f.behaviour.duringAme = () => {
      gateDuring = renderGate.active();
    };
    const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
    expect(out).toMatchObject({ ok: true, started: true, engine: "media_encoder", state: "handed_to_media_encoder" });
    expect(f.rq.ameCalls).toEqual([true]);
    expect(f.rq.renders).toBe(0);
    expect(gateDuring).toBeNull();
    expect(renderGate.active()).toBeNull();
    expect(out.note).toMatch(/NOT locked/);
    expect(out.items.map((i: any) => i.index)).toEqual([1, 2, 3]);
    expect(out.item_statuses_after_hand_over).toHaveLength(3);
    expect(calledFns(f)).toEqual(["rqeditRead", "rqeditAmeState", "rqeditQueueInAme", "rqeditRenderResult"]);
    expect(f.calls.find((c) => c.fn === "rqeditQueueInAme")!.script).toContain('"expected_queued":3');
    expect(f.calls.find((c) => c.fn === "rqeditQueueInAme")!.script).toContain('"start_now":true');
    const rec = storeFor(f.ctx).get(out.job_id)!;
    expect(rec.state).toBe("handed_to_media_encoder");
    expect(rec.engine).toBe("media_encoder");
    expect(rec.handed_at).toBeTruthy();
  });

  it("other tools are not refused afterwards (the gate stays open)", async () => {
    const f = fakeAe({ saved: true });
    await ame(f.ctx);
    const res = await f.ctx.bridge.evalRaw({ id: "after", script: "__chromaAe.rqeditRead({})", label: "read", mutates: false, toolName: "x" });
    expect(res).toBeTruthy();
  });

  it("reports an error from queueInAME as a failed job", async () => {
    const f = fakeAe({ saved: true });
    f.behaviour.ameThrows = true;
    const out = await ame(f.ctx);
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].message).toMatch(/Media Encoder is not installed/);
    expect(storeFor(f.ctx).get(out.job_id)!.state).toBe("failed");
    expect(renderGate.active()).toBeNull();
  });

  it("refuses item_indexes with media_encoder before anything is sent: the hold would dirty the saved project", async () => {
    const f = fakeAe({ saved: true });
    const out = await ame(f.ctx, { item_indexes: [2], comp_ids: [f.list[1].comp.id], start_now: true, whole_ame_queue_ok: true });
    expect(out).toMatchObject({ ok: false, started: false, engine: "media_encoder" });
    expect(out.refused[0].code).toBe("item_indexes_with_media_encoder");
    expect(out.refused[0].message).toMatch(/ae_render_queue_edit/);
    expect(out.refused[0].message).toMatch(/ae_save/);
    expect(f.calls).toHaveLength(0);
    expect(f.undo.begun).toBe(0);
    expect(f.rq.ameCalls).toEqual([]);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("a project with only the wanted item queued hands over that item and leaves the project clean", async () => {
    const f = fakeAe({ saved: true });
    onlyQueued(f, 2);
    const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.items.map((i: any) => i.index)).toEqual([2]);
    expect(calledFns(f)).toEqual(["rqeditRead", "rqeditAmeState", "rqeditQueueInAme", "rqeditRenderResult"]);
    expect(f.undo.begun).toBe(0);
  });

  it("status: handed_to_media_encoder, per-file exists/bytes and growth, never finished", async () => {
    const f = fakeAe({ saved: true });
    onlyQueued(f, 1);
    const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
    const file = f.list[0].mods[0].file.fsName;

    const s1 = await status(f.ctx, { job_id: out.job_id });
    expect(s1.state).toBe("handed_to_media_encoder");
    expect(s1.engine).toBe("media_encoder");
    expect(s1.outputs).toHaveLength(1);
    expect(s1.outputs[0]).toMatchObject({ exists: false, bytes: 0, grew_since_last_check: null });
    expect(s1.message).toMatch(/NEVER says the render finished/);
    expect(s1.message).toMatch(/ae_verify_render/);
    expect(s1.render_ok).toBeUndefined();
    expect(s1.gate).toBeUndefined();

    fs.writeFileSync(file, "x".repeat(10));
    const s2 = await status(f.ctx, { job_id: out.job_id });
    expect(s2.outputs[0]).toMatchObject({ exists: true, bytes: 10, grew_since_last_check: true });

    fs.writeFileSync(file, "x".repeat(10));
    const s3 = await status(f.ctx, { job_id: out.job_id });
    expect(s3.outputs[0]).toMatchObject({ exists: true, bytes: 10, grew_since_last_check: false });

    fs.writeFileSync(file, "x".repeat(25));
    const s4 = await status(f.ctx);
    expect(s4.job_id).toBe(out.job_id);
    expect(s4.outputs[0]).toMatchObject({ bytes: 25, grew_since_last_check: true });
    expect(s4.state).not.toBe("finished");
  });

  it("status lists a same-name file with another extension that appeared after the hand-over (at most 10)", async () => {
    const f = fakeAe({ saved: true });
    const stale = path.join(f.outDir, "alpha.mov");
    fs.writeFileSync(stale, "old");
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(f.outDir, "bravo.mov"), "other item"); // another base name
    onlyQueued(f, 1);
    const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
    const s0 = await status(f.ctx, { job_id: out.job_id });
    expect(s0.other_extension_files).toBeUndefined();
    const later = new Date(Date.now() + 5_000);
    fs.writeFileSync(path.join(f.outDir, "alpha.m4v"), "abc");
    fs.utimesSync(path.join(f.outDir, "alpha.m4v"), later, later);
    for (let i = 0; i < 14; i++) {
      const g = path.join(f.outDir, `alpha.x${i}`);
      fs.writeFileSync(g, "z");
      fs.utimesSync(g, later, later);
    }
    const s1 = await status(f.ctx, { job_id: out.job_id });
    expect(s1.outputs[0].exists).toBe(false);
    expect(s1.other_extension_files.length).toBe(10);
    expect(s1.other_extension_files.map((x: any) => path.basename(x.file))).toContain("alpha.m4v");
    expect(s1.other_extension_files.map((x: any) => path.basename(x.file))).not.toContain("alpha.mov");
    expect(s1.other_extension_files.map((x: any) => path.basename(x.file))).not.toContain("bravo.mov");
    expect(s1.other_extension_note).toMatch(/another format/);
    expect(otherExtensionFiles(path.join(f.outDir, "seq_[####].png"), 0)).toEqual([]);
  });

  it("a job handed to Media Encoder survives a service restart as it was", async () => {
    const f = fakeAe({ saved: true });
    const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
    resetRenderJobStores();
    const again = new RenderJobStore(jobsFileFor(f.ctx));
    expect(again.get(out.job_id)?.state).toBe("handed_to_media_encoder");
  });
});

describe("ae_render_queue_render default engine is unchanged", () => {
  it("engine after_effects (or none) renders inside AE behind the gate and never touches queueInAME", async () => {
    const f = fakeAe();
    const a = await start(f.ctx, { engine: "after_effects" });
    expect(a).toMatchObject({ ok: true, started: true, state: "running" });
    expect(a.engine).toBeUndefined();
    const rec = await finish(f.ctx, a);
    expect(rec.state).toBe("finished");
    expect(rec.engine).toBeUndefined();
    expect(f.rq.renders).toBe(1);
    expect(f.rq.ameCalls).toEqual([]);
    expect(f.calls.some((c) => c.fn === "rqeditAmeState" || c.fn === "rqeditQueueInAme")).toBe(false);
    expect(AeRenderQueueRenderSchema.parse({ expect: expectArg }).engine).toBeUndefined();
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, engine: "ame" }).success).toBe(false);
  });

  it("user_confirmed is ignored for the After Effects engine", async () => {
    const f = fakeAe();
    const a = await start(f.ctx, { user_confirmed: true });
    expect(a).toMatchObject({ ok: true, started: true });
    await finish(f.ctx, a);
    expect(f.rq.ameCalls).toEqual([]);
  });
});

describe("rqeditHold and rqeditRelease (fake AE)", () => {
  const files = (it: QItem) => [it.mods[0].file.fsName];
  const row = (it: QItem, index: number) => ({ index, comp_id: it.comp.id, files: files(it) });

  it("hold refuses before any write when a QUEUED item is in neither list", () => {
    const f = fakeAe();
    expect(() => f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [row(f.list[0], 1)] })).toThrow(/became QUEUED/);
    expect(f.undo.begun).toBe(0);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
  });

  it("hold refuses a changed output file, a changed comp and a render in progress", () => {
    const f = fakeAe();
    expect(() => f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [{ ...row(f.list[0], 1), files: ["C:\\elsewhere.mp4"] }, row(f.list[2], 3)] })).toThrow(/other output files/);
    expect(() => f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [{ ...row(f.list[0], 1), comp_id: 99999 }, row(f.list[2], 3)] })).toThrow(/is comp/);
    f.rq.rendering = true;
    expect(() => f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [row(f.list[0], 1), row(f.list[2], 3)] })).toThrow(/rendering/);
    expect(f.undo.begun).toBe(0);
  });

  it("hold with nothing to hold is a no-op without an undo group", () => {
    const f = fakeAe({ count: 1 });
    const out = JSON.parse(JSON.stringify(f.A.rqeditHold({ keep: [row(f.list[0], 1)], hold: [] })));
    expect(out).toMatchObject({ held: [], no_op: true });
    expect(f.undo.begun).toBe(0);
  });

  it("release restores only UNQUEUED items that still match; one undo group; nothing thrown", () => {
    const f = fakeAe();
    f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [row(f.list[0], 1), row(f.list[2], 3)] });
    expect(f.states()).toEqual(["unqueued", "queued", "unqueued"]);
    f.undo.begun = 0;
    f.undo.ended = 0;
    const out = JSON.parse(JSON.stringify(f.A.rqeditRelease({ items: [row(f.list[0], 1), row(f.list[2], 3)] })));
    expect(out.restored.map((r: any) => r.index)).toEqual([1, 3]);
    expect(out.not_restored).toEqual([]);
    expect(f.undo.begun).toBe(1);
    expect(f.undo.ended).toBe(1);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    // A second release finds them queued already and writes nothing.
    f.undo.begun = 0;
    const again = JSON.parse(JSON.stringify(f.A.rqeditRelease({ items: [row(f.list[0], 1)] })));
    expect(again).toMatchObject({ no_op: true, restored: [] });
    expect(again.not_restored[0].code).toBe("already_queued");
    expect(f.undo.begun).toBe(0);
  });

  it("release leaves a DONE item alone and says its status changed", () => {
    const f = fakeAe();
    f.A.rqeditHold({ keep: [row(f.list[1], 2)], hold: [row(f.list[0], 1), row(f.list[2], 3)] });
    f.list[0].status = STATUS.DONE;
    const out = JSON.parse(JSON.stringify(f.A.rqeditRelease({ items: [row(f.list[0], 1), row(f.list[2], 3)] })));
    expect(out.restored.map((r: any) => r.index)).toEqual([3]);
    expect(out.not_restored[0]).toMatchObject({ index: 1, code: "changed" });
    expect(out.not_restored[0].reason).toMatch(/done/);
  });
});

// ---------- review fixes ----------

describe("review fixes", () => {
  const calledFns = (f: ReturnType<typeof fakeAe>) => f.calls.map((c) => c.fn).filter((fn) => fn.startsWith("rqedit"));
  const ame = (ctx: ToolContext, extra: Record<string, unknown> = {}) => start(ctx, { engine: "media_encoder", user_confirmed: true, expect: { project_path: SAVED_PATH }, ...extra });
  const onlyQueued = (f: ReturnType<typeof fakeAe>, n: number) => {
    f.list.forEach((it, k) => {
      if (k + 1 === n) return;
      it.status = STATUS.UNQUEUED;
      it.renderFlag = false;
    });
  };
  /** Makes the evalRaw whose id ends with `suffix` fail with a bridge error of `kind`. */
  const failEval = (f: ReturnType<typeof fakeAe>, suffix: string, kind: "timeout" | "queued" | "unreachable") => {
    const realEval = f.ctx.bridge.evalRaw.bind(f.ctx.bridge);
    (f.ctx.bridge as any).evalRaw = async (p: any) => {
      if (String(p.id).endsWith(suffix)) throw new BridgeError({ kind, message: `${kind} on ${suffix}` });
      return realEval(p);
    };
  };

  describe("1: a Media Encoder hand-over that times out is not 'not started'", () => {
    it("answers started 'unknown' with ame_handover_unknown, never resends, and the record stays unknown", async () => {
      const f = fakeAe({ saved: true });
      failEval(f, "_ame", "timeout");
      const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
      expect(out).toMatchObject({ ok: false, started: "unknown", engine: "media_encoder" });
      expect(out.refused[0].code).toBe("ame_handover_unknown");
      expect(out.refused[0].message).toMatch(/NOT KNOWN whether Media Encoder got/);
      expect(out.refused[0].message).toMatch(/Do not call ae_render_queue_render again/);
      expect(f.rq.ameCalls).toEqual([]);
      expect(calledFns(f)).not.toContain("rqeditQueueInAme");
      expect(calledFns(f)).not.toContain("rqeditRenderResult");
      const rec = storeFor(f.ctx).get(out.job_id)!;
      expect(rec.state).toBe("unknown");
    });
  });

  describe("2: a pending restore is not hidden by the next job", () => {
    const strand = async (f: ReturnType<typeof fakeAe>) => {
      f.behaviour.unreachable = true;
      const out = await start(f.ctx, { item_indexes: [2] });
      await finish(f.ctx, out);
      f.behaviour.unreachable = false;
      renderGate.reset();
      return out.job_id as string;
    };

    it("refuses a new item_indexes render (restore_pending) while the items are still unchecked", async () => {
      const f = fakeAe();
      const first = await strand(f);
      expect(f.states()).toEqual(["unqueued", "queued", "unqueued"]);
      const callsBefore = f.calls.length;
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out).toMatchObject({ ok: false, started: false });
      expect(out.refused[0].code).toBe("restore_pending");
      expect(out.pending_restores).toHaveLength(1);
      expect(out.pending_restores[0]).toMatchObject({ job_id: first, restore_state: "pending" });
      expect(out.pending_restores[0].items.map((h: any) => h.index)).toEqual([1, 3]);
      expect(out.restore_how).toMatch(/ae_render_queue_edit/);
      expect(f.calls.slice(callsBefore).map((c) => c.fn).filter((fn) => fn === "rqeditHold" || fn === "rqeditRender")).toEqual([]);
      expect(storeFor(f.ctx).list()).toHaveLength(1);
    });

    it("a render without item_indexes still starts and lists them; status without a job_id shows them behind the newer job", async () => {
      const f = fakeAe();
      const first = await strand(f);
      const out = await start(f.ctx);
      expect(out).toMatchObject({ ok: true, started: true });
      expect(out.pending_restores[0].job_id).toBe(first);
      expect(out.restore_how).toBeDefined();
      await finish(f.ctx, out);
      const st = await status(f.ctx);
      expect(st.job_id).toBe(out.job_id);
      expect(st.pending_restores.map((p: any) => p.job_id)).toEqual([first]);
      expect(st.pending_restores[0].items.map((h: any) => h.index)).toEqual([1, 3]);
      expect(st.restore_how).toBeDefined();
      // With a job id the answer is that job's alone.
      const byId = await status(f.ctx, { job_id: out.job_id });
      expect(byId.pending_restores).toBeUndefined();
    });

    it("lets item_indexes through once the items are queued again, and closes the old record", async () => {
      const f = fakeAe();
      const first = await strand(f);
      for (const k of [0, 2]) f.list[k].render = true; // the user queued them again
      expect(f.states()).toEqual(["queued", "queued", "queued"]);
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out).toMatchObject({ ok: true, started: true });
      expect(out.pending_restores).toBeUndefined();
      await finish(f.ctx, out);
      const old = storeFor(f.ctx).get(first)!;
      expect(old.restore?.state).toBe("partial");
      const st = await status(f.ctx);
      expect(st.pending_restores).toBeUndefined();
    });

    it("an item that changed since is not waited for either", async () => {
      const f = fakeAe();
      await strand(f);
      f.list[0].mods[0].file = new FakeFile(path.join(f.outDir, "alpha-moved.mp4"));
      f.list.splice(2, 1);
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out).toMatchObject({ ok: true, started: true });
      await finish(f.ctx, out);
    });

    it("never prunes a job that still has items to put back, however many jobs follow", () => {
      const dir = tmp();
      const file = path.join(dir, "jobs.json");
      const store = new RenderJobStore(file);
      const base = { op_id: "o", state: "finished" as const, max_hours: 1, project_path: "p", overwrite: false, items: [] };
      store.create({ ...base, job_id: "j000", started_at: "2026-01-01T00:00:00.000Z", restore: { state: "pending", held: [{ index: 1, comp_id: 5, files: ["a"] }], restored: [], not_restored: [] } });
      store.create({ ...base, job_id: "j001", started_at: "2026-01-01T00:00:01.000Z" });
      for (let i = 2; i < 40; i++) store.create({ ...base, job_id: `j${String(i).padStart(3, "0")}`, started_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
      const back = new RenderJobStore(file);
      expect(back.get("j000")?.restore?.state).toBe("pending");
      expect(back.get("j001")).toBeUndefined(); // pruned: finished, nothing to restore
      expect(back.list()).toHaveLength(31);
    });

    it("the descriptions no longer promise a restore 'even when it failed or was stopped'", () => {
      const d = tool("ae_render_queue_render").description;
      expect(d).not.toMatch(/even when it failed or was stopped/);
      expect(d).toMatch(/restore_pending/);
      expect(d).toMatch(/pending_restores/);
      const argDesc = String((AeRenderQueueRenderSchema.shape.item_indexes as any).description ?? (AeRenderQueueRenderSchema.shape.item_indexes as any)._def.innerType?._def.description);
      expect(argDesc).not.toMatch(/even when it failed or was stopped/);
      expect(argDesc).toMatch(/stay unchecked/);
    });
  });

  describe("3: the hold rollback runs only when the hold may have written", () => {
    it("a hold refused by the busy door (queued) is a clean refusal: no release, nothing left, 'Nothing was unchecked'", async () => {
      const f = fakeAe();
      failEval(f, "_hold", "queued");
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out).toMatchObject({ ok: false, started: false });
      expect(out.refused[0].code).toBe("hold_failed");
      expect(out.refused[0].message).toMatch(/Nothing was unchecked/);
      expect(out.refused[0].message).not.toMatch(/QUEUED again/);
      expect(calledFns(f)).toEqual(["rqeditRead"]);
      expect(storeFor(f.ctx).list()).toEqual([]);
      expect(out.job_id).toBeUndefined();
    });

    it("a hold refused by a host guard is the same", async () => {
      const f = fakeAe();
      const realEval = f.ctx.bridge.evalRaw.bind(f.ctx.bridge);
      (f.ctx.bridge as any).evalRaw = async (p: any) => {
        if (String(p.id).endsWith("_hold")) f.list[0].mods[0].file = new FakeFile(path.join(f.outDir, "changed-since-read.mp4"));
        return realEval(p);
      };
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out.refused[0].code).toBe("hold_failed");
      expect(calledFns(f)).not.toContain("rqeditRelease");
      expect(f.undo.begun).toBe(0);
      expect(storeFor(f.ctx).list()).toEqual([]);
    });

    it("a hold that times out may have written: the rollback is still sent", async () => {
      const f = fakeAe();
      failEval(f, "_hold", "timeout");
      const out = await start(f.ctx, { item_indexes: [2] });
      expect(out.refused[0].code).toBe("hold_failed");
      expect(calledFns(f)).toContain("rqeditRelease");
    });

    it("rqeditRelease tests QUEUED (already_queued) before the output files", () => {
      const f = fakeAe();
      const row = { index: 1, comp_id: f.list[0].comp.id, files: ["C:\\elsewhere\\old-name.mp4"] };
      // The item is QUEUED and its file differs from the held list: it was queued again by the user, nothing to put back.
      const out = JSON.parse(JSON.stringify(f.A.rqeditRelease({ items: [row] })));
      expect(out.not_restored).toHaveLength(1);
      expect(out.not_restored[0].code).toBe("already_queued");
      expect(out.restored).toEqual([]);
      // An UNQUEUED item with other files is still "changed".
      f.list[0].status = STATUS.UNQUEUED;
      f.list[0].renderFlag = false;
      const out2 = JSON.parse(JSON.stringify(f.A.rqeditRelease({ items: [row] })));
      expect(out2.not_restored[0].code).toBe("changed");
    });
  });

  describe("4: Media Encoder with overwrite: a stale file is not the result", () => {
    it("marks a file older than the hand-over stale and finds the _1 file Media Encoder wrote", async () => {
      const f = fakeAe({ saved: true });
      onlyQueued(f, 1);
      const file = f.list[0].mods[0].file.fsName;
      fs.writeFileSync(file, "old render");
      const old = new Date(Date.now() - 3_600_000);
      fs.utimesSync(file, old, old);
      const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true, overwrite: true });
      expect(out).toMatchObject({ ok: true, started: true });
      const s0 = await status(f.ctx, { job_id: out.job_id });
      expect(s0.outputs[0]).toMatchObject({ exists: true, stale: true });
      expect(s0.stale_note).toMatch(/OLDER than the hand-over/);
      expect(s0.stale_note).toMatch(/_1/);
      expect(s0.other_extension_files).toBeUndefined();

      const later = new Date(Date.now() + 5_000);
      const suffixed = path.join(f.outDir, "alpha_1.mp4");
      fs.writeFileSync(suffixed, "new render");
      fs.utimesSync(suffixed, later, later);
      const other = path.join(f.outDir, "alpha_2.mov");
      fs.writeFileSync(other, "new");
      fs.utimesSync(other, later, later);
      fs.writeFileSync(path.join(f.outDir, "alpha_final.mp4"), "unrelated");
      const s1 = await status(f.ctx, { job_id: out.job_id });
      const names = (s1.other_extension_files ?? []).map((x: any) => path.basename(x.file)).sort();
      expect(names).toEqual(["alpha_1.mp4", "alpha_2.mov"]);
      expect(s1.outputs[0].stale).toBe(true);
    });

    it("a file written after the hand-over is not stale", async () => {
      const f = fakeAe({ saved: true });
      onlyQueued(f, 1);
      const out = await ame(f.ctx, { start_now: true, whole_ame_queue_ok: true });
      const file = f.list[0].mods[0].file.fsName;
      const later = new Date(Date.now() + 5_000);
      fs.writeFileSync(file, "fresh");
      fs.utimesSync(file, later, later);
      const s = await status(f.ctx, { job_id: out.job_id });
      expect(s.outputs[0].exists).toBe(true);
      expect(s.outputs[0].stale).toBeUndefined();
      expect(s.stale_note).toBeUndefined();
    });

    it("otherExtensionFiles takes _<n> files of any extension but not _name files", () => {
      const dir = tmp();
      const file = path.join(dir, "shot.mp4");
      const since = Date.now() - 1000;
      for (const n of ["shot_1.mp4", "shot_12.mov", "shot.mov", "shot_x.mp4", "shot_1a.mp4", "other_1.mp4"]) fs.writeFileSync(path.join(dir, n), "z");
      expect(otherExtensionFiles(file, since).map((x) => path.basename(x.file)).sort()).toEqual(["shot.mov", "shot_1.mp4", "shot_12.mov"]);
    });
  });

  describe("6: the failure sink", () => {
    const sinkLines = (f: ReturnType<typeof fakeAe>) => {
      const lines: string[] = [];
      (f.ctx as any).log = (level: string, msg: string) => lines.push(`[${level}] ${msg}`);
      return lines;
    };

    it("a render the user stopped (finished, ok false) writes exactly one line", async () => {
      const f = fakeAe();
      const lines = sinkLines(f);
      f.behaviour.mode = "stopped";
      const out = await start(f.ctx, { item_indexes: [1] });
      const rec = await finish(f.ctx, out);
      expect(rec.state).toBe("finished");
      expect(rec.ok).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[err\] job ae_render_queue_render rqjob_\S+ failed: .*USER_STOPPED/);
      await status(f.ctx);
      expect(lines).toHaveLength(1);
    });

    it("a render that finished ok writes none", async () => {
      const f = fakeAe();
      const lines = sinkLines(f);
      const out = await start(f.ctx);
      await finish(f.ctx, out);
      expect(lines).toEqual([]);
    });

    it("a read-back timeout makes the job unknown (not finished) and writes one line", async () => {
      const f = fakeAe();
      const lines = sinkLines(f);
      const realEval = f.ctx.bridge.evalRaw.bind(f.ctx.bridge);
      (f.ctx.bridge as any).evalRaw = async (p: any) => {
        if (String(p.id).includes("_after")) throw new BridgeError({ kind: "timeout", message: "read timed out" });
        return realEval(p);
      };
      const out = await start(f.ctx, { item_indexes: [2] });
      const rec = await finish(f.ctx, out);
      expect(rec.state).toBe("unknown");
      expect(rec.ok).toBe(false);
      expect(rec.result?.read_back_error).toMatch(/timed out/);
      expect(rec.restore?.state).toBe("pending");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/ended unknown/);
      expect(renderGate.active()).toMatchObject({ state: "unknown", cause: "read_back_timeout" });
    });

    it("jobs a restart turned into lost or unknown are reported once when a sink is set", () => {
      const dir = tmp();
      const file = path.join(dir, "jobs.json");
      const first = new RenderJobStore(file);
      const base = { op_id: "o", max_hours: 1, project_path: "p", overwrite: false, items: [], started_at: "2026-01-01T00:00:00.000Z" };
      first.create({ ...base, job_id: "j_ae", state: "running" });
      first.create({ ...base, job_id: "j_ame", state: "running", engine: "media_encoder", started_at: "2026-01-01T00:00:01.000Z" });
      first.create({ ...base, job_id: "j_ok", state: "finished", ok: true, started_at: "2026-01-01T00:00:02.000Z" });
      const second = new RenderJobStore(file);
      expect(second.get("j_ae")?.state).toBe("lost");
      expect(second.get("j_ame")?.state).toBe("unknown");
      const lines: string[] = [];
      bindJobFailureLog(second, (l, m) => lines.push(`[${l}] ${m}`));
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).toMatch(/j_ae ended unknown/);
      expect(lines.join("\n")).toMatch(/j_ame ended unknown/);
      bindJobFailureLog(second, (l, m) => lines.push(`[${l}] ${m}`));
      second.update("j_ae", { note: "again" });
      expect(lines).toHaveLength(2);
      // A third start finds the file as it was left: those jobs are not new failures.
      const third = new RenderJobStore(file);
      const lines3: string[] = [];
      bindJobFailureLog(third, (l, m) => lines3.push(m));
      expect(lines3).toEqual([]);
    });

    it("the status tool binds the sink, so a lost job is reported on the first status call", async () => {
      const f = fakeAe();
      const lines = sinkLines(f);
      const store = storeFor(f.ctx);
      store.create({ job_id: "j_lost", op_id: "o", state: "running", started_at: "2026-01-01T00:00:00.000Z", max_hours: 1, project_path: "p", overwrite: false, items: [] });
      resetRenderJobStores();
      const st = await status(f.ctx);
      expect(st.state).toBe("lost");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/j_lost ended unknown/);
    });
  });

  describe("7: the Media Encoder install check", () => {
    it("builds C:\\Program Files\\Adobe with its backslash (the old literal lost it)", () => {
      expect(ameRootCandidates("win32", {})).toEqual(["C:\\Program Files\\Adobe"]);
      expect(ameRootCandidates("win32", { ProgramFiles: "D:\\PF" })).toEqual(["D:\\PF\\Adobe", "C:\\Program Files\\Adobe"]);
      expect(ameRootCandidates("darwin", {})).toEqual(["/Applications"]);
      expect(ameRootCandidates("linux", {})).toEqual([]);
    });

    it("finds a Media Encoder folder beside After Effects' own install folder (a custom location)", () => {
      const dir = tmp();
      const adobe = path.join(dir, "Adobe");
      const appPath = path.join(adobe, "Adobe After Effects 2026", "Support Files");
      fs.mkdirSync(appPath, { recursive: true });
      expect(ameNearApp(appPath)).toBe(false);
      fs.mkdirSync(path.join(adobe, "Adobe Media Encoder 2026"));
      expect(ameNearApp(appPath)).toBe(true);
      expect(ameNearApp(null)).toBe(false);
      expect(ameNearApp("")).toBe(false);
      expect(ameNearApp(path.join(dir, "nowhere", "x"))).toBe(false);
    });

    it("the host returns After Effects' Folder.appPackage path, or null", () => {
      const f = fakeAe();
      expect(JSON.parse(JSON.stringify(f.A.rqeditAmeState({}))).app_path).toBeNull();
      Object.assign(f.G, { Folder: { appPackage: { fsName: "D:\\Adobe\\Adobe After Effects 2026\\Support Files" } } });
      expect(JSON.parse(JSON.stringify(f.A.rqeditAmeState({}))).app_path).toBe("D:\\Adobe\\Adobe After Effects 2026\\Support Files");
    });

    it("the handler passes the app path to the check and refuses only when neither place has it", async () => {
      const f = fakeAe({ saved: true });
      rqrenderDeps.ameInstalled = () => false;
      Object.assign(f.G, { Folder: { appPackage: { fsName: "D:\\Adobe\\Adobe After Effects 2026\\Support Files" } } });
      const seen: unknown[] = [];
      rqrenderDeps.ameNearApp = (p) => {
        seen.push(p);
        return false;
      };
      const out = await ame(f.ctx);
      expect(out.refused[0].code).toBe("ame_not_installed");
      expect(out.refused[0].message).toContain("D:\\Adobe\\Adobe After Effects 2026\\Support Files");
      expect(seen).toEqual(["D:\\Adobe\\Adobe After Effects 2026\\Support Files"]);
    });
  });

  describe("8: the status gives restore_how while items still need queuing", () => {
    it("a partial restore with items left says restore_pending and gives restore_how", async () => {
      const f = fakeAe();
      f.behaviour.during = () => {
        f.list[0].mods[0].file = new FakeFile(path.join(f.outDir, "alpha-other.mp4"));
        f.list.splice(2, 1);
      };
      const out = await start(f.ctx, { item_indexes: [2] });
      await finish(f.ctx, out);
      const st = await status(f.ctx);
      expect(st.restore.state).toBe("partial");
      expect(st.restore_pending).toBe(true);
      expect(st.restore_how).toMatch(/ae_render_queue_edit/);
    });

    it("a restore that finished leaves neither", async () => {
      const f = fakeAe();
      const out = await start(f.ctx, { item_indexes: [2] });
      await finish(f.ctx, out);
      const st = await status(f.ctx);
      expect(st.restore_pending).toBeUndefined();
      expect(st.restore_how).toBeUndefined();
    });
  });

  describe("10: a running Media Encoder hand-over is not described as the AE render lock", () => {
    it("says After Effects is not locked and gives no Stop text", async () => {
      const f = fakeAe({ saved: true });
      storeFor(f.ctx).create({ job_id: "j_ame", op_id: "o", state: "running", engine: "media_encoder", started_at: new Date().toISOString(), max_hours: 12, project_path: SAVED_PATH, overwrite: false, items: [] });
      const st = await status(f.ctx);
      expect(st.state).toBe("running");
      expect(st.engine).toBe("media_encoder");
      expect(st.message).toMatch(/hands the queue to Adobe Media Encoder/);
      expect(st.message).toMatch(/NOT render-locked/);
      expect(st.message).not.toMatch(/can't reach After Effects/);
      expect(st.stop).toBeUndefined();
      expect(st.sign_of_life).toBeUndefined();
    });

    it("a plain AE render still reads as the lock", async () => {
      const f = fakeAe();
      storeFor(f.ctx).create({ job_id: "j_ae", op_id: "o", state: "running", started_at: new Date().toISOString(), max_hours: 12, project_path: "p", overwrite: false, items: [] });
      const st = await status(f.ctx);
      expect(st.message).toMatch(/can't reach After Effects/);
      expect(st.stop).toBeDefined();
    });
  });
});
