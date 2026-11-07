import { describe, expect, it, vi } from "vitest";
import { QueueWaitError, SingleWriterQueue } from "../src/queue.js";

describe("SingleWriterQueue", () => {
  it("executes operations strictly in FIFO order", async () => {
    const queue = new SingleWriterQueue({ maxWaitMs: 5000 });
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const p1 = queue.run("op1", async (lease) => {
      expect(lease.queuedBehind).toBeNull();
      order.push("start:op1");
      await firstGate;
      order.push("end:op1");
      return 1;
    });

    const p2 = queue.run("op2", async (lease) => {
      expect(lease.queuedBehind).toBe("op1");
      order.push("start:op2");
      order.push("end:op2");
      return 2;
    });

    const p3 = queue.run("op3", async (lease) => {
      expect(lease.queuedBehind).toBe("op1");
      order.push("start:op3");
      order.push("end:op3");
      return 3;
    });

    expect(queue.inFlight).toBe("op1");
    expect(queue.depth).toBe(2);

    releaseFirst();
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([
      "start:op1",
      "end:op1",
      "start:op2",
      "end:op2",
      "start:op3",
      "end:op3",
    ]);
    expect(queue.inFlight).toBeNull();
    expect(queue.depth).toBe(0);
  });

  it("times out a queued waiter with QueueWaitError (kind: 'queued') without running it", async () => {
    const queue = new SingleWriterQueue({ maxWaitMs: 30 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const p1 = queue.run("slow_op", async () => {
      await firstGate;
      return "done";
    });

    let secondRan = false;
    const p2 = queue.run(" impatient_op", async () => {
      secondRan = true;
      return "should not run";
    });

    await expect(p2).rejects.toThrow(QueueWaitError);
    try {
      await p2;
    } catch (err) {
      expect((err as QueueWaitError).kind).toBe("queued");
    }
    expect(secondRan).toBe(false);

    releaseFirst();
    await expect(p1).resolves.toBe("done");
  });
});

describe("SingleWriterQueue: who holds it and for how long", () => {
  it("snapshot names the holder, since when, and the depth", async () => {
    const queue = new SingleWriterQueue({ maxWaitMs: 5000 });
    expect(queue.snapshot()).toEqual({ holder: null, holderSince: null, depth: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const before = Date.now();
    const p1 = queue.run("op1", () => gate);
    const p2 = queue.run("op2", async () => {});
    const snap = queue.snapshot();
    expect(snap.holder).toBe("op1");
    expect(snap.holderSince).toBeGreaterThanOrEqual(before);
    expect(snap.depth).toBe(1);
    release();
    await Promise.all([p1, p2]);
    expect(queue.snapshot()).toEqual({ holder: null, holderSince: null, depth: 0 });
  });

  it("the wait error says how long the holder has been running", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SingleWriterQueue({ maxWaitMs: 9 * 60_000 });
      void queue.run("ae_export_mogrt", () => new Promise<void>(() => {}));
      const waiting = queue.run("ae_get_comp", async () => {});
      const caught = waiting.catch((e) => e);
      await vi.advanceTimersByTimeAsync(9 * 60_000 + 1);
      const err = (await caught) as QueueWaitError;
      expect(err).toBeInstanceOf(QueueWaitError);
      expect(err.message).toContain('behind "ae_export_mogrt" (running 9 min)');
      expect(err.behindRunningMs).toBeGreaterThanOrEqual(9 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SingleWriterQueue: the wait guard", () => {
  it("refuses a waiter the guard objects to, drops it from the queue, and leaves the holder alone", async () => {
    const queue = new SingleWriterQueue({ maxWaitMs: 5000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = queue.run("holder", () => gate);
    queue.setWaitGuard(async (op) => (op === "waiter" ? new Error("popup is open") : null));
    let ran = false;
    const waiter = queue.run("waiter", async () => {
      ran = true;
    });
    await expect(waiter).rejects.toThrow("popup is open");
    expect(ran).toBe(false);
    expect(queue.depth).toBe(0);
    expect(queue.inFlight).toBe("holder");
    // An operation the guard lets through still waits its turn.
    const ok = queue.run("fine", async () => "done");
    release();
    await holder;
    await expect(ok).resolves.toBe("done");
  });

  it("is not asked when nothing has to wait", async () => {
    const queue = new SingleWriterQueue();
    let asked = 0;
    queue.setWaitGuard(async () => {
      asked++;
      return null;
    });
    await queue.run("alone", async () => {});
    expect(asked).toBe(0);
  });

  it("a guard that throws does not refuse anyone", async () => {
    const queue = new SingleWriterQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = queue.run("holder", () => gate);
    queue.setWaitGuard(async () => {
      throw new Error("probe failed");
    });
    const next = queue.run("next", async () => "ran");
    await new Promise((r) => setTimeout(r, 20));
    release();
    await holder;
    await expect(next).resolves.toBe("ran");
  });
});
