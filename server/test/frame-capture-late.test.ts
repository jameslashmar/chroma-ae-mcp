/**
 * captureCompFrame on a slow render (a heavy 3D comp): saveFrameToPng returns at once and leaves
 * the PNG at 0 bytes until the render ends. A second saveFrameToPng must not be sent while the
 * first is still being written, and a final failure waits for a render still in progress.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { captureCompFrame, frameCaptureDeps } from "../src/tools/ext/frames.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e5274fd70000000049454e44ae426082",
  "hex"
);

let dir: string;
const saved = { ...frameCaptureDeps };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-late-"));
  // Wide margins against the fake's own timers, so a loaded CI machine does not flip these tests.
  frameCaptureDeps.lateWriteMs = 3000;
  frameCaptureDeps.settleAfterFailMs = 3000;
});
afterEach(() => {
  Object.assign(frameCaptureDeps, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A bridge whose snapshotFrame makes the file at 0 bytes and fills it `fillAfterMs` later (never when null). */
function slowAe(fillAfterMs: Array<number | null>) {
  const sent: string[] = [];
  const ctx = {
    bridge: {
      evalRaw: async ({ script }: { script: string }) => {
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, -1));
        const n = sent.push(args.output_path) - 1;
        fs.writeFileSync(args.output_path, "");
        const wait = fillAfterMs[n] ?? null;
        if (wait !== null) setTimeout(() => fs.writeFileSync(args.output_path, PNG_BYTES), wait);
        return { result: {} };
      },
    },
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("captureCompFrame with a slow render", { timeout: 20000 }, () => {
  it("waits for a first render still being written instead of sending a second", async () => {
    const { ctx, sent } = slowAe([300]);
    const snap = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 150 });
    expect(sent).toHaveLength(1);
    expect(snap.path).toBe(sent[0]);
    expect(fs.statSync(snap.path).size).toBeGreaterThan(0);
  });

  it("retries as before when the first file never fills, and uses the retry", async () => {
    const { ctx, sent } = slowAe([null, 50]);
    const snap = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 150 });
    expect(sent).toHaveLength(2);
    expect(snap.path).toBe(sent[1]);
    expect(snap.time).toBeCloseTo(1.001, 6);
  });

  it("after a final failure it gives the pending render time, says so, and sends nothing more", async () => {
    const { ctx, sent } = slowAe([null, null]);
    const t0 = Date.now();
    const err = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100 }).catch((e) => e);
    expect(sent).toHaveLength(2);
    expect(String(err.message)).toMatch(/still writing the frame; waited \d+ s .*ae_status/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(frameCaptureDeps.settleAfterFailMs - 200);
  });

  it("a late write during that wait is used rather than failing", async () => {
    const { ctx, sent } = slowAe([null, 300]);
    const snap = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100 });
    expect(sent).toHaveLength(2);
    expect(snap.path).toBe(sent[1]);
  });
});
