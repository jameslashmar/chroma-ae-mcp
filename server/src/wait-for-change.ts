/**
 * Waits for a job to change, so one status call can replace several polls.
 *
 * Node only: it never touches After Effects, never takes the AE queue or the lease, and holds no
 * lock. It keeps ONE pending timer at a time (a short re-check, re-armed until the deadline) and an
 * optional wake-up from the job store, so a state change ends the wait at once and an output file
 * that appears is seen within one tick. There is no busy loop.
 */

export const MAX_WAIT_SECONDS = 30;
/** How often a wait looks at the disk for a file that appeared (a state change wakes it sooner). */
export const WAIT_TICK_MS = 1000;

export interface WaitOptions {
  /** Seconds to wait at most; clamped to 0..MAX_WAIT_SECONDS. */
  seconds: number;
  /** True once the thing being waited for happened (state changed, a file appeared). */
  changed: () => boolean;
  /** Registers a wake-up callback with the job store; returns the function that removes it. */
  subscribe?: (wake: () => void) => () => void;
  tickMs?: number;
}

export interface WaitResult {
  waited_ms: number;
  /** True when it ended because `changed()` became true, false when the time ran out. */
  changed: boolean;
}

export function clampWaitSeconds(seconds: number | undefined): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, seconds);
}

export function waitForChange(opts: WaitOptions): Promise<WaitResult> {
  const seconds = clampWaitSeconds(opts.seconds);
  const started = Date.now();
  if (seconds === 0) return Promise.resolve({ waited_ms: 0, changed: false });
  const deadline = started + seconds * 1000;
  const tickMs = opts.tickMs ?? WAIT_TICK_MS;

  return new Promise<WaitResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let done = false;

    const finish = (changed: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        unsubscribe?.();
      } catch {
        // a wake-up that cannot be removed must not break the answer
      }
      resolve({ waited_ms: Math.max(0, Date.now() - started), changed });
    };

    const arm = (): void => {
      if (done) return;
      if (timer) clearTimeout(timer);
      const left = deadline - Date.now();
      timer = setTimeout(check, Math.max(0, Math.min(tickMs, left)));
    };

    const check = (): void => {
      // Also called by a store wake-up while the re-check timer is pending: drop it, so only one timer ever exists.
      if (timer) clearTimeout(timer);
      timer = null;
      if (done) return;
      let changed = false;
      try {
        changed = opts.changed();
      } catch {
        changed = false;
      }
      if (changed) return finish(true);
      if (Date.now() >= deadline) return finish(false);
      arm();
    };

    if (opts.subscribe) unsubscribe = opts.subscribe(() => check());
    arm();
  });
}
