import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { renderGate, renderGateMessage } from "../src/render-gate.js";
import type { ToolContext } from "../src/tools/common.js";
import { followQueue, resetFollowState, somethingToFollow } from "../src/tools/ext/rqfollow.js";
import { renderTools } from "../src/tools/render.js";

const statusTool = renderTools.find((t) => t.name === "ae_render_queue_status")!;

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rqfollow-"));
  tmpDirs.push(d);
  return d;
};
beforeEach(() => {
  resetFollowState();
  renderGate.reset();
});
afterEach(() => {
  resetFollowState();
  renderGate.reset();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Call {
  fn: string;
  opts: { timeoutMs?: number; label?: string };
}

/** A bridge stub: callHost answers from `answers`; a function answer may throw. */
function stubCtx(answers: Record<string, () => unknown>) {
  const calls: Call[] = [];
  const bridge = {
    callHost: async (fn: string, _args: unknown, opts: Call["opts"]) => {
      calls.push({ fn, opts });
      const a = answers[fn];
      if (!a) throw new Error(`no answer for ${fn}`);
      return { result: a() };
    },
  };
  return { ctx: { bridge } as unknown as ToolContext, calls };
}

const queueRead = (file: string) => ({
  numItems: 1,
  rendering: true,
  items: [{ index: 1, comp_id: 5, comp_name: "Main", status: "rendering", output_modules: [{ index: 1, file }] }],
});

describe("ae_render_queue_status: the first read keeps its old wait", () => {
  it("asks rqStatus without a shortened timeout (the follow read keeps its short one)", async () => {
    const { ctx, calls } = stubCtx({
      rqStatus: () => ({ numItems: 1, rendering: true, items: [{ index: 1, status: "rendering", render: true }] }),
      rqeditRead: () => queueRead(path.join(tmp(), "a.mov")),
    });
    await statusTool.handler({}, ctx);
    const first = calls.find((c) => c.fn === "rqStatus")!;
    expect(first.opts.timeoutMs).toBeUndefined();
    const second = calls.find((c) => c.fn === "rqeditRead")!;
    expect(typeof second.opts.timeoutMs).toBe("number");
  });
});

describe("ae_render_queue_status: no second read when nothing renders or is about to", () => {
  it("skips the follow read for an idle queue (nothing rendering, no Render box checked)", async () => {
    const idle = { numItems: 2, rendering: false, items: [{ index: 1, status: "done", render: false }, { index: 2, status: "unqueued", render: false }] };
    const { ctx, calls } = stubCtx({ rqStatus: () => idle, rqeditRead: () => queueRead("x") });
    const res: any = await statusTool.handler({}, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["rqStatus"]);
    expect(res).toEqual(idle);
    expect(res.follow).toBeUndefined();
  });

  it("reads again when the queue renders, when an item is rendering, or when an item has its Render box checked", async () => {
    for (const status of [
      { numItems: 1, rendering: true, items: [] },
      { numItems: 1, rendering: false, items: [{ index: 1, status: "rendering", render: false }] },
      { numItems: 1, rendering: false, items: [{ index: 1, status: "4", render: true }] },
    ]) {
      resetFollowState();
      const { ctx, calls } = stubCtx({ rqStatus: () => status, rqeditRead: () => queueRead(path.join(tmp(), "a.mov")) });
      const res: any = await statusTool.handler({}, ctx);
      expect(calls.map((c) => c.fn)).toEqual(["rqStatus", "rqeditRead"]);
      expect(res.follow).toBeDefined();
    }
  });

  it("somethingToFollow judges the answer only", () => {
    expect(somethingToFollow({ rendering: false, items: [] })).toBe(false);
    expect(somethingToFollow({ rendering: false })).toBe(false);
    expect(somethingToFollow({ rendering: true })).toBe(true);
    expect(somethingToFollow({ items: [{ render: true }] })).toBe(true);
  });
});

describe("ae_render_queue_status: when AE does not answer, the note says why", () => {
  const busy = { numItems: 1, rendering: true, items: [{ index: 1, status: "rendering", render: true }] };

  it("names the render gate's message (the job and ae_render_queue_render_status) from the refused first read", async () => {
    const dir = tmp();
    let gateOn = false;
    const info = { job_id: "rqjob_gate", op_id: "o", started_at: "2026-01-01T00:00:00.000Z", state: "rendering" as const };
    const { ctx } = stubCtx({
      rqStatus: () => {
        if (gateOn) throw new BridgeError({ kind: "queued", message: renderGateMessage(info) });
        return busy;
      },
      rqeditRead: () => queueRead(path.join(dir, "a.mov")),
    });
    // Nothing earlier and AE refused: the error is the tool's, as it was.
    gateOn = true;
    await expect(statusTool.handler({}, ctx)).rejects.toThrow(/rqjob_gate/);
    gateOn = false;
    await statusTool.handler({}, ctx);
    gateOn = true;
    const res: any = await statusTool.handler({}, ctx);
    expect(res).toMatchObject({ ok: true, answered_from_earlier_read: true });
    expect(res.follow.from_earlier_read).toBe(true);
    expect(res.follow.note).toMatch(/rqjob_gate/);
    expect(res.follow.note).toMatch(/ae_render_queue_render_status/);
    expect(res.follow.note).toMatch(/queued:/);
    expect(res.follow.note).toMatch(/was not asked/);
  });

  it("names the timeout when the first read timed out", async () => {
    let down = false;
    const { ctx } = stubCtx({
      rqStatus: () => {
        if (down) throw new BridgeError({ kind: "timeout", message: "timed out after 120000 ms" });
        return busy;
      },
      rqeditRead: () => queueRead(path.join(tmp(), "a.mov")),
    });
    await statusTool.handler({}, ctx);
    down = true;
    const res: any = await statusTool.handler({}, ctx);
    expect(res.follow.note).toMatch(/did not answer in time/);
    expect(res.follow.note).toMatch(/timeout: timed out after 120000 ms/);
  });

  it("names the follow read's own error when the first read worked but the second failed", async () => {
    const { ctx } = stubCtx({
      rqStatus: () => busy,
      rqeditRead: () => {
        throw new BridgeError({ kind: "timeout", message: "follow read timed out" });
      },
    });
    // An earlier successful follow is needed for the fallback.
    const ok = stubCtx({ rqStatus: () => busy, rqeditRead: () => queueRead(path.join(tmp(), "a.mov")) });
    await statusTool.handler({}, ok.ctx);
    const res: any = await statusTool.handler({}, ctx);
    expect(res.numItems).toBe(1);
    expect(res.follow.from_earlier_read).toBe(true);
    expect(res.follow.note).toMatch(/follow read timed out/);
  });

  it("followQueue without an error still answers with the old wording", async () => {
    const dir = tmp();
    const ok = stubCtx({ rqStatus: () => busy, rqeditRead: () => queueRead(path.join(dir, "a.mov")) });
    await followQueue(ok.ctx, busy, "t");
    const res = await followQueue(ok.ctx, null, "t");
    expect((res!.follow.note as string)).toMatch(/did not answer in time/);
  });
});

describe("ae_render_queue_status: a finished item stays in follow for one more check", () => {
  type It = { index: number; comp_name: string; status: string; file: string };
  const readOf = (items: It[]) => ({
    numItems: items.length,
    items: items.map((i) => ({ index: i.index, comp_id: i.index, comp_name: i.comp_name, status: i.status, output_modules: [{ index: 1, file: i.file }] })),
  });
  /** A queue whose items the test changes between calls. */
  function liveQueue(items: It[]) {
    const stub = stubCtx({
      rqStatus: () => ({ numItems: items.length, rendering: items.some((i) => i.status === "rendering"), items: items.map((i) => ({ index: i.index, status: i.status, render: i.status === "rendering" })) }),
      rqeditRead: () => readOf(items),
    });
    return { ...stub, call: async (): Promise<any> => statusTool.handler({}, stub.ctx) };
  }

  it("a DONE item shows once more with its final size, final status and finished: true, then is gone", async () => {
    const f = path.join(tmp(), "a.mov");
    fs.writeFileSync(f, "x".repeat(10));
    const items: It[] = [{ index: 1, comp_name: "Main", status: "rendering", file: f }];
    const q = liveQueue(items);
    const r1 = await q.call();
    expect(r1.follow.items[0].finished).toBeUndefined();
    fs.writeFileSync(f, "x".repeat(50));
    items[0].status = "done";
    const r2 = await q.call();
    expect(r2.follow.items).toHaveLength(1);
    expect(r2.follow.items[0]).toMatchObject({ index: 1, status: "done", finished: true });
    expect(r2.follow.items[0].outputs[0]).toMatchObject({ bytes: 50, grew_since_last_check: true });
    const r3 = await q.call();
    expect(r3.follow).toBeUndefined();
  });

  it("a failed or user-stopped item likewise", async () => {
    const dir = tmp();
    const items: It[] = [
      { index: 1, comp_name: "A", status: "rendering", file: path.join(dir, "a.mov") },
      { index: 2, comp_name: "B", status: "queued", file: path.join(dir, "b.mov") },
    ];
    const q = liveQueue(items);
    await q.call();
    items[0].status = "err_stopped";
    items[1].status = "user_stopped";
    const r2 = await q.call();
    expect(r2.follow.items.map((i: any) => [i.index, i.status, i.finished])).toEqual([
      [1, "err_stopped", true],
      [2, "user_stopped", true],
    ]);
    expect((await q.call()).follow).toBeUndefined();
  });

  it("an item that was never followed and is already done is not added", async () => {
    const dir = tmp();
    const items: It[] = [
      { index: 1, comp_name: "Old", status: "done", file: path.join(dir, "old.mov") },
      { index: 2, comp_name: "Now", status: "rendering", file: path.join(dir, "now.mov") },
    ];
    const q = liveQueue(items);
    const r1 = await q.call();
    expect(r1.follow.items.map((i: any) => i.index)).toEqual([2]);
    items[1].status = "done";
    const r2 = await q.call();
    expect(r2.follow.items.map((i: any) => [i.index, i.finished])).toEqual([[2, true]]);
  });

  it("several items at once: finished ones are marked, those still rendering are not, and only the finished ones drop out next time", async () => {
    const dir = tmp();
    const items: It[] = [1, 2, 3].map((n) => ({ index: n, comp_name: `C${n}`, status: "rendering", file: path.join(dir, `${n}.mov`) }));
    const q = liveQueue(items);
    await q.call();
    items[0].status = "done";
    items[2].status = "err_stopped";
    const r2 = await q.call();
    expect(r2.follow.items.map((i: any) => [i.index, i.finished ?? false])).toEqual([
      [2, false],
      [1, true],
      [3, true],
    ]);
    const r3 = await q.call();
    expect(r3.follow.items.map((i: any) => i.index)).toEqual([2]);
    items[1].status = "done";
    const r4 = await q.call();
    expect(r4.follow.items.map((i: any) => [i.index, i.finished])).toEqual([[2, true]]);
    expect((await q.call()).follow).toBeUndefined();
  });

});
