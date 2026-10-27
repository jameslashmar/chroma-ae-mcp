export type QueueErrorKind = "queued";

export class QueueWaitError extends Error {
  readonly kind: QueueErrorKind = "queued";
  readonly op: string;
  readonly waitedMs: number;
  readonly behindOp: string;

  constructor(op: string, waitedMs: number, behindOp: string) {
    super(
      `Operation "${op}" waited ${Math.round(waitedMs / 1000)}s in the server queue behind "${behindOp}" and was dropped before being sent to After Effects. Nothing was executed; it is safe to retry once the queue drains.`
    );
    this.name = "QueueWaitError";
    this.op = op;
    this.waitedMs = waitedMs;
    this.behindOp = behindOp;
  }
}

export interface QueueLease {
  readonly op: string;
  readonly waitedMs: number;
  readonly queuedBehind: string | null;
  release(): void;
}

interface Waiter {
  op: string;
  enqueuedAt: number;
  behind: string;
  done: boolean;
  resolve: (lease: QueueLease) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const DEFAULT_MAX_WAIT_MS = 600_000;

/**
 * Single-writer FIFO queue for all After Effects operations (both reads and writes,
 * because ExtendScript is single-threaded).
 */
export class SingleWriterQueue {
  private holder: string | null = null;
  private waiting: Waiter[] = [];
  private readonly maxWaitMs: number;

  constructor(opts: { maxWaitMs?: number } = {}) {
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  get depth(): number {
    return this.waiting.filter((w) => !w.done).length;
  }

  get inFlight(): string | null {
    return this.holder;
  }

  acquire(op: string): Promise<QueueLease> {
    if (this.holder === null && this.depth === 0) {
      this.holder = op;
      return Promise.resolve(this.createLease(op, 0, null));
    }

    const behind =
      this.holder ??
      this.waiting.find((w) => !w.done)?.op ??
      "unknown";

    return new Promise<QueueLease>((resolve, reject) => {
      const waiter: Waiter = {
        op,
        enqueuedAt: Date.now(),
        behind,
        done: false,
        resolve,
        reject,
        cleanup: () => {},
      };

      const timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        waiter.cleanup();
        reject(new QueueWaitError(op, this.maxWaitMs, waiter.behind));
        this.pump();
      }, this.maxWaitMs);
      timer.unref?.();

      waiter.cleanup = () => {
        clearTimeout(timer);
      };

      this.waiting.push(waiter);
    });
  }

  async run<T>(op: string, fn: (lease: QueueLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(op);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  private createLease(
    op: string,
    waitedMs: number,
    queuedBehind: string | null
  ): QueueLease {
    let released = false;
    return {
      op,
      waitedMs,
      queuedBehind,
      release: () => {
        if (released) return;
        released = true;
        this.holder = null;
        this.pump();
      },
    };
  }

  private pump(): void {
    if (this.holder !== null) return;
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (next.done) continue;
      next.done = true;
      next.cleanup();
      this.holder = next.op;
      const waitedMs = Date.now() - next.enqueuedAt;
      next.resolve(this.createLease(next.op, waitedMs, next.behind));
      return;
    }
  }
}
