import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { renderGate } from "../src/render-gate.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeRenderQueueRenderSchema,
  AeRenderQueueRenderStatusSchema,
  RenderJobStore,
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
beforeEach(() => {
  rqrenderDeps.ameInstalled = () => true;
  renderGate.reset();
  resetRenderJobStores();
});
afterEach(() => {
  rqrenderDeps.ameInstalled = realAmeInstalled;
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

  it("refuses with ame_not_installed before anything is read or written", async () => {
    const f = fakeAe({ saved: true });
    rqrenderDeps.ameInstalled = () => false;
    const out = await ame(f.ctx);
    expect(out.refused[0].code).toBe("ame_not_installed");
    expect(f.calls).toHaveLength(0);
    expect(f.rq.ameCalls).toEqual([]);
    expect(storeFor(f.ctx).list()).toEqual([]);
  });

  it("the consent text names the preset risk", async () => {
    const f = fakeAe({ saved: true });
    const out = await start(f.ctx, { engine: "media_encoder", expect: { project_path: SAVED_PATH } });
    expect(out.refused[0].message).toMatch(/last-used preset/);
  });

  it("start_now true: calls queueInAME(true), sets no render gate, and does not call render()", async () => {
    const f = fakeAe({ saved: true });
    let gateDuring: unknown = "unset";
    f.behaviour.duringAme = () => {
      gateDuring = renderGate.active();
    };
    const out = await ame(f.ctx, { start_now: true });
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

  it("item_indexes: holds the others, queueInAME sees only the chosen item, then releases them in a separate evalScript", async () => {
    const f = fakeAe({ saved: true });
    let during: string[] = [];
    f.behaviour.duringAme = () => {
      during = f.states();
    };
    const out = await ame(f.ctx, { item_indexes: [2], comp_ids: [f.list[1].comp.id], start_now: true });
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.held_back.map((h: any) => h.index)).toEqual([1, 3]);
    expect(during).toEqual(["unqueued", "queued", "unqueued"]);
    expect(f.rq.ameCalls).toEqual([true]);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    expect(f.list.map((i) => i.render)).toEqual([true, true, true]);
    expect(calledFns(f)).toEqual(["rqeditRead", "rqeditAmeState", "rqeditHold", "rqeditRead", "rqeditQueueInAme", "rqeditRenderResult", "rqeditRelease", "rqeditRead"]);
    expect(f.calls.find((c) => c.fn === "rqeditQueueInAme")!.script).toContain('"expected_queued":1');
    expect(f.undo.begun).toBe(2);
    expect(f.undo.ended).toBe(2);
    const rec = storeFor(f.ctx).get(out.job_id)!;
    expect(rec.state).toBe("handed_to_media_encoder");
    expect(rec.only_item_indexes).toEqual([2]);
    expect(rec.restore?.state).toBe("restored");
    expect(rec.summary).toMatch(/QUEUED again/);
    expect(renderGate.active()).toBeNull();
  });

  it("item_indexes: releases the held items even when queueInAME fails", async () => {
    const f = fakeAe({ saved: true });
    f.behaviour.ameThrows = true;
    const out = await ame(f.ctx, { item_indexes: [1] });
    expect(out.ok).toBe(false);
    expect(f.states()).toEqual(["queued", "queued", "queued"]);
    expect(storeFor(f.ctx).get(out.job_id)!.restore?.state).toBe("restored");
  });

  it("status: handed_to_media_encoder, per-file exists/bytes and growth, never finished", async () => {
    const f = fakeAe({ saved: true });
    const out = await ame(f.ctx, { item_indexes: [1], start_now: true });
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
    const out = await ame(f.ctx, { item_indexes: [1], start_now: true });
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
    const out = await ame(f.ctx, { start_now: true });
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
