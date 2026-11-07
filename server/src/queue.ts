import { renderGate } from "./render-gate.js";

export type QueueErrorKind = "queued";

function formatRunning(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

export class QueueWaitError extends Error {
  readonly kind: QueueErrorKind = "queued";
  readonly op: string;
  readonly waitedMs: number;
  readonly behindOp: string;

  /** How long the operation it waited behind had held the queue, when it was the holder. */
  readonly behindRunningMs?: number;

  constructor(op: string, waitedMs: number, behindOp: string, behindRunningMs?: number) {
    super(
      `Operation "${op}" waited ${Math.round(waitedMs / 1000)}s in the server queue behind "${behindOp}"${
        behindRunningMs !== undefined ? ` (running ${formatRunning(behindRunningMs)})` : ""
      } and was dropped before being sent to After Effects. Nothing was executed; it is safe to retry once the queue drains.`
    );
    this.behindRunningMs = behindRunningMs;
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
/** How often a waiter asks the wait guard again. */
const GUARD_RECHECK_MS = 5_000;

/**
 * Called for an operation that has to wait for the lease, once at once and then every few seconds
 * while it waits. Returns an error to refuse it (it is then dropped from the queue, nothing sent), or null to keep waiting.
 */
export type QueueWaitGuard = (op: string) => Promise<Error | null>;

/**
 * Single-writer FIFO queue for all After Effects operations (both reads and writes,
 * because ExtendScript is single-threaded).
 */
export class SingleWriterQueue {
  private holder: string | null = null;
  private holderSince: number | null = null;
  private waiting: Waiter[] = [];
  private readonly maxWaitMs: number;
  private guard: QueueWaitGuard | null = null;

  /** The panel host sets it: a waiter is refused while a popup blocks AE (see ae-activity.describePopupBlock). */
  setWaitGuard(guard: QueueWaitGuard | null): void {
    this.guard = guard;
  }

  constructor(opts: { maxWaitMs?: number } = {}) {
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  get depth(): number {
    return this.waiting.filter((w) => !w.done).length;
  }

  get inFlight(): string | null {
    return this.holder;
  }

  /** Who holds the queue, since when (epoch ms), and how many wait. Read-only; changes nothing. */
  snapshot(): { holder: string | null; holderSince: number | null; depth: number } {
    return { holder: this.holder, holderSince: this.holderSince, depth: this.depth };
  }

  acquire(op: string): Promise<QueueLease> {
    // While After Effects renders for ae_render_queue_render nothing else can reach it:
    // refuse now instead of waiting behind the render's lease (see render-gate.ts).
    try {
      renderGate.check();
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.holder === null && this.depth === 0) {
      this.holder = op;
      this.holderSince = Date.now();
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
        const runningMs =
          this.holder !== null && this.holder === waiter.behind && this.holderSince !== null
            ? Date.now() - this.holderSince
            : undefined;
        reject(new QueueWaitError(op, this.maxWaitMs, waiter.behind, runningMs));
        this.pump();
      }, this.maxWaitMs);
      timer.unref?.();

      waiter.cleanup = () => {
        clearTimeout(timer);
      };

      this.waiting.push(waiter);

      const guard = this.guard;
      if (guard) {
        let checking = false;
        const check = (): void => {
          if (waiter.done || checking) return;
          checking = true;
          guard(op)
            .catch(() => null)
            .then((refusal) => {
              checking = false;
              if (!refusal || waiter.done) return;
              waiter.done = true;
              waiter.cleanup();
              reject(refusal);
            });
        };
        const every = setInterval(check, GUARD_RECHECK_MS);
        every.unref?.();
        const baseCleanup = waiter.cleanup;
        waiter.cleanup = () => {
          baseCleanup();
          clearInterval(every);
        };
        check();
      }
    });
  }

  /**
   * Drops every operation still waiting for its turn (never the holder). Used when a render
   * takes the queue for hours: they would otherwise wait out the 600 s limit for nothing.
   */
  rejectWaiting(makeError: (op: string) => Error): number {
    let n = 0;
    for (const w of this.waiting) {
      if (w.done) continue;
      w.done = true;
      w.cleanup();
      w.reject(makeError(w.op));
      n++;
    }
    this.waiting = [];
    return n;
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
        this.holderSince = null;
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
      this.holderSince = Date.now();
      const waitedMs = Date.now() - next.enqueuedAt;
      next.resolve(this.createLease(next.op, waitedMs, next.behind));
      return;
    }
  }
}
