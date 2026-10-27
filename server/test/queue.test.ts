import { describe, expect, it } from "vitest";
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
