/**
 * The asset scan and the explicit file list stat only the first and the last frames of a sequence, never every frame:
 * the watcher scans on a 5 s tick on the service thread, and a stat per frame was 12 s per scan at 100,000 files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ stat: 0, ageMs: null as null | ((file: string) => number) }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const statSync = (...args: unknown[]) => {
    counter.stat++;
    const st = (real.statSync as (...a: unknown[]) => any)(...args);
    if (counter.ageMs && typeof args[0] === "string") {
      const t = Date.now() - counter.ageMs(args[0]);
      return { ...st, mtimeMs: t, ctimeMs: t, birthtimeMs: t, isFile: () => st.isFile() };
    }
    return st;
  };
  return { ...real, statSync, default: { ...real, statSync } };
});
import { candidatesFromPaths, MAX_SINGLE_STATS, scanAssets, type ScanStats } from "../src/assets.js";

const dirs: string[] = [];
afterEach(() => {
  counter.ageMs = null;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sequenceFolder(frames: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-stat-"));
  dirs.push(dir);
  for (let i = 1; i <= frames; i++) fs.writeFileSync(path.join(dir, `shot_${String(i).padStart(5, "0")}.exr`), "");
  return dir;
}

describe("stat calls", () => {
  it("scanAssets stats the first and the last 8 frames of a sequence, not every frame", () => {
    const dir = sequenceFolder(300);
    counter.stat = 0;
    const out = scanAssets(dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sequence: true, frames: 300, firstFrame: 1, lastFrame: 300 });
    expect(counter.stat).toBeLessThanOrEqual(9);
    expect(counter.stat).toBeGreaterThanOrEqual(1);
  });

  it("a sequence still being written is still seen as new: the newest frame is one of the sampled ones", () => {
    const dir = sequenceFolder(40);
    const out = scanAssets(dir);
    expect(Date.now() - out[0].arrivedMs).toBeLessThan(60_000);
  });

  it("candidatesFromPaths stats a whole folder's frames no more than the sample", () => {
    const dir = sequenceFolder(300);
    counter.stat = 0;
    const { candidates } = candidatesFromPaths([path.join(dir, "shot_00001.exr")]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sequence: true, frames: 300 });
    // 1 for the file asked for, then the first and last 8 (the first is among the sample).
    expect(counter.stat).toBeLessThanOrEqual(10);
  });

  it("frames landing late in the middle (a gap re-render) keep the sequence settling, though the last 8 are old", () => {
    const dir = sequenceFolder(100);
    // Frame 40 never arrived and 41 landed a second ago; every other frame is an hour old.
    fs.rmSync(path.join(dir, "shot_00040.exr"));
    counter.ageMs = (file) => (path.basename(file) === "shot_00041.exr" ? 1_000 : 3_600_000);
    const out = scanAssets(dir);
    expect(out).toHaveLength(1);
    expect(Date.now() - out[0].arrivedMs).toBeLessThan(10_000);
    // The same through an explicit file list.
    const listed = candidatesFromPaths([path.join(dir, "shot_00001.exr")]);
    expect(Date.now() - listed.candidates[0].arrivedMs).toBeLessThan(10_000);
  });

  it("a scan stats at most MAX_SINGLE_STATS single files and counts the rest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-singles-"));
    dirs.push(dir);
    for (let i = 0; i < MAX_SINGLE_STATS + 40; i++) fs.writeFileSync(path.join(dir, `pic_${i}_x.png`), "");
    counter.stat = 0;
    const stats: ScanStats = { files_seen: 0, truncated: false };
    const out = scanAssets(dir, { stats });
    expect(counter.stat).toBeLessThanOrEqual(MAX_SINGLE_STATS);
    expect(out).toHaveLength(MAX_SINGLE_STATS);
    expect(stats.unchecked_singles).toBe(40);
  }, 60_000);

  it("explicit paths into one big sequence list the folder once per group, not once per path", () => {
    const dir = sequenceFolder(60);
    const paths = Array.from({ length: 30 }, (_v, i) => path.join(dir, `shot_${String(i + 1).padStart(5, "0")}.exr`));
    const { candidates } = candidatesFromPaths(paths);
    expect(candidates).toHaveLength(1);
  });
});
