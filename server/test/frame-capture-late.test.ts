/**
 * captureCompFrame on a slow render (a heavy 3D comp): saveFrameToPng returns at once and leaves
 * the PNG at 0 bytes, or creates no file at all (AE 26.3), until the render ends. A second
 * saveFrameToPng must never be sent while the first may still be rendering: on AE 26.3 that second
 * call crashed AE (PR #19). Only a stale frame (a whole PNG older than the request) is retried.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { captureCompFrame, frameCaptureDeps } from "../src/tools/ext/frames.js";
import { resetUnwrittenFrame, unwrittenFrameDeps, unwrittenFrameHold } from "../src/tools/render.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e5274fd70000000049454e44ae426082",
  "hex"
);

let dir: string;
const saved = { ...frameCaptureDeps };
const savedHold = { ...unwrittenFrameDeps };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-late-"));
  // Wide margins against the fake's own timers, so a loaded CI machine does not flip these tests.
  frameCaptureDeps.lateWriteMs = 3000;
  frameCaptureDeps.settleAfterFailMs = 3000;
});
afterEach(() => {
  Object.assign(frameCaptureDeps, saved);
  Object.assign(unwrittenFrameDeps, savedHold);
  resetUnwrittenFrame();
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

/** A bridge whose snapshotFrame creates no file at all until the render ends `fillAfterMs` later (never when null), as seen on AE 26.3. */
function unwrittenAe(fillAfterMs: Array<number | null>) {
  const sent: string[] = [];
  const ctx = {
    bridge: {
      evalRaw: async ({ script }: { script: string }) => {
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, -1));
        const n = sent.push(args.output_path) - 1;
        const wait = fillAfterMs[n] ?? null;
        if (wait !== null) setTimeout(() => fs.writeFileSync(args.output_path, PNG_BYTES), wait);
        return { result: {} };
      },
    },
  } as unknown as ToolContext;
  return { ctx, sent };
}

/** A bridge that hands back AE's cached frame on the first call (a whole PNG dated before the request), a fresh one after. */
function staleAe() {
  const sent: string[] = [];
  const ctx = {
    bridge: {
      evalRaw: async ({ script }: { script: string }) => {
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, -1));
        const n = sent.push(args.output_path) - 1;
        fs.writeFileSync(args.output_path, PNG_BYTES);
        if (n === 0) {
          const old = new Date(Date.now() - 60_000);
          fs.utimesSync(args.output_path, old, old);
        }
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

  it("a file left empty is not retried: no second render, and it says why", async () => {
    const { ctx, sent } = slowAe([null, 50]);
    const t0 = Date.now();
    const err = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 150 }).catch((e) => e);
    expect(sent).toHaveLength(1);
    expect(String(err.message)).toMatch(/did not write the frame of comp 7 at 1s.*not asked again.*restart After Effects/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(frameCaptureDeps.lateWriteMs - 200);
  });

  it("a stale frame (a whole PNG older than the request) is still retried once, with the time nudge", async () => {
    const { ctx, sent } = staleAe();
    const snap = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100 });
    expect(sent).toHaveLength(2);
    expect(snap.path).toBe(sent[1]);
    expect(snap.time).toBeCloseTo(1.001, 6);
    expect(unwrittenFrameHold()).toBeNull();
  });
});

describe("captureCompFrame when the render has not created its file yet (AE 26.3)", { timeout: 20000 }, () => {
  it("waits for the first render instead of sending a second over it", async () => {
    const { ctx, sent } = unwrittenAe([300]);
    const snap = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 150 });
    expect(sent).toHaveLength(1);
    expect(snap.path).toBe(sent[0]);
    expect(snap.time).toBe(1);
  });

  it("never retries a frame with no file: the second saveFrameToPng is what crashed AE 26.3", async () => {
    const { ctx, sent } = unwrittenAe([null, 50]);
    const err = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 150, toolName: "ae_annotate_frame" }).catch((e) => e);
    expect(sent).toHaveLength(1);
    expect(String(err.message)).toMatch(/did not write the frame/);
  });

  it("holds every later frame render until the missing file appears, then lets the next one go", async () => {
    const { ctx, sent } = unwrittenAe([null, 0]);
    await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100, toolName: "ae_annotate_frame" }).catch(() => null);
    expect(sent).toHaveLength(1);
    const hold = unwrittenFrameHold();
    expect(hold).toMatchObject({ error: "frame_render_pending", comp_id: 7, time: 1 });
    expect(hold!.message).toMatch(/Nothing was rendered.*ae_annotate_frame\(7 @ 1s\).*crashed After Effects 26\.3/);
    // Another tool, another comp: still not sent to AE.
    const err = await captureCompFrame({ ctx, opId: "op2", compId: 9, time: 2, frameIndex: 0, framesDir: dir, waitMs: 100 }).catch((e) => e);
    expect(String(err.message)).toMatch(/Nothing was rendered/);
    expect(sent).toHaveLength(1);
    // AE writes the first frame after all: the hold ends and the next render goes.
    fs.writeFileSync(sent[0], PNG_BYTES);
    const snap = await captureCompFrame({ ctx, opId: "op3", compId: 9, time: 2, frameIndex: 0, framesDir: dir, waitMs: 100 });
    expect(sent).toHaveLength(2);
    expect(snap.path).toBe(sent[1]);
  });

  it("the hold ends on its own after holdMs when the file never comes", async () => {
    unwrittenFrameDeps.holdMs = 200;
    const { ctx, sent } = unwrittenAe([null, 0]);
    await captureCompFrame({ ctx, opId: "op", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 250));
    expect(unwrittenFrameHold()).toBeNull();
    const snap = await captureCompFrame({ ctx, opId: "op2", compId: 7, time: 1, frameIndex: 0, framesDir: dir, waitMs: 100 });
    expect(snap.path).toBe(sent[1]);
  });
});
