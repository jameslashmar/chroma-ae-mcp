import { describe, expect, it } from "vitest";
import { splitFrameName } from "../src/tools/ext/collect.js";
import {
  checkSequences,
  cloudHint,
  findGroup,
  formatRanges,
  frameName,
  groupFrames,
  missingRanges,
  parseFrameName,
  STAT_SAMPLE_HIGH,
  type SeqIo,
  type SeqStat,
} from "../src/seqscan.js";

const pad = (n: number, w = 4) => String(n).padStart(w, "0");
const frames = (prefix: string, from: number, to: number, ext = "exr", w = 4, skip: number[] = []) => {
  const out: string[] = [];
  for (let n = from; n <= to; n++) if (!skip.includes(n)) out.push(`${prefix}${pad(n, w)}.${ext}`);
  return out;
};

describe("missingRanges", () => {
  it("finds the exact ranges between the first and last frame", () => {
    expect(missingRanges([1, 2, 3, 7, 8, 10], 20)).toEqual({ missing: 4, ranges: [[4, 6], [9, 9]], truncated: false });
  });
  it("reports nothing before the first or after the last frame (a late start looks complete)", () => {
    expect(missingRanges([40, 41, 42], 20)).toEqual({ missing: 0, ranges: [], truncated: false });
  });
  it("keeps `missing` exact when the ranges are cut", () => {
    const nums: number[] = [];
    for (let i = 0; i < 100; i++) nums.push(i * 3); // 99 gaps of 2 frames
    const r = missingRanges(nums, 5);
    expect(r.missing).toBe(198);
    expect(r.ranges).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
  it("handles 100k numbers quickly", () => {
    const nums: number[] = [];
    for (let i = 0; i < 100_000; i++) if (i % 997 !== 0) nums.push(i);
    const t = Date.now();
    const r = missingRanges(nums, 20);
    expect(Date.now() - t).toBeLessThan(100);
    expect(r.missing).toBeGreaterThan(0);
  });
});

describe("formatRanges", () => {
  it("pads to the sequence's width and cuts at maxChars", () => {
    expect(formatRanges([[120, 120], [300, 312]], 4, 400)).toBe("0120, 0300-0312");
    expect(formatRanges([[1, 1], [5, 6]], 0, 400)).toBe("1, 5-6");
    const long = formatRanges(Array.from({ length: 200 }, (_, i) => [i * 3 + 1, i * 3 + 1] as [number, number]), 4, 60);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("parseFrameName and groupFrames", () => {
  it("takes the last digit run directly before the extension", () => {
    expect(parseFrameName("beauty.0001.exr")).toEqual({ prefix: "beauty.", digits: "0001", suffix: ".exr" });
    expect(parseFrameName("a1b2.exr")).toEqual({ prefix: "a1b", digits: "2", suffix: ".exr" });
    expect(parseFrameName("shot_0001_beauty.exr")).toBeNull(); // text after the number: not a frame here
    expect(parseFrameName("shot_0001_v2.exr")).toEqual({ prefix: "shot_0001_v", digits: "2", suffix: ".exr" }); // the LAST digit run counts
    expect(parseFrameName("notes.txt")).toBeNull();
    expect(parseFrameName(`x${"1".repeat(16)}.exr`)).toBeNull();
  });

  it("keeps two passes in one folder apart and does not mix padded widths", () => {
    const names = [...frames("A_beauty.", 1, 3), ...frames("A_depth.", 1, 3), ...frames("old_", 1, 3, "png", 3), ...frames("old_", 1, 2, "png", 4)];
    const g = groupFrames(names);
    const byPattern = Object.fromEntries(g.map((x) => [x.pattern, x.on_disk]));
    expect(byPattern).toEqual({ "A_beauty.[####].exr": 3, "A_depth.[####].exr": 3, "old_[###].png": 3, "old_[####].png": 2 });
  });

  it("lets an unpadded sequence cross widths (frame9, frame10, frame100)", () => {
    const g = groupFrames(["frame8.png", "frame9.png", "frame10.png", "frame11.png", "frame100.png"]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ padded: false, first: 8, last: 100, on_disk: 5, pattern: "frame[#].png" });
    expect(g[0].missing).toBe(100 - 8 + 1 - 5);
  });

  it("joins shot_1000 to the width-4 sequence of shot_0999", () => {
    const g = groupFrames(["shot_0998.png", "shot_0999.png", "shot_1000.png", "shot_1001.png"]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ padded: true, digits: 4, first: 998, last: 1001, missing: 0 });
  });

  it("is case-insensitive only when asked", () => {
    expect(groupFrames(["A_0001.exr", "a_0002.exr"], { caseInsensitive: true })).toHaveLength(1);
    expect(groupFrames(["A_0001.exr", "a_0002.exr"], { caseInsensitive: false })).toHaveLength(2);
  });

  it("finds the group of a file and builds frame names", () => {
    const g = groupFrames(frames("A.", 1, 5, "exr", 4, [3]));
    expect(findGroup(g, "A.0002.exr")).toBe(g[0]);
    expect(findGroup(g, "B.0002.exr")).toBeNull();
    expect(frameName(g[0], 12)).toBe("A.0012.exr");
  });

  it("follows a different rule than collect.ts on purpose", () => {
    // collect.ts allows text after the number so that it never leaves out a file AE points at; the sequence check does not.
    expect(splitFrameName("shot_0001_beauty.exr")).not.toBeNull();
    expect(parseFrameName("shot_0001_beauty.exr")).toBeNull();
  });
});

// ---------- a counting fake file system ----------

function fakeIo(dirs: Record<string, string[]>, opts: { ageS?: (name: string) => number; now?: number; readdirCost?: number } = {}) {
  let clock = opts.now ?? 1_000_000_000;
  const log = { readdir: [] as string[], stat: [] as string[], limit: [] as number[] };
  const io: SeqIo = {
    async readdir(dir, limit) {
      log.readdir.push(dir);
      log.limit.push(limit);
      clock += opts.readdirCost ?? 0;
      const list = dirs[dir];
      if (!list) throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      return { names: list.slice(0, limit), truncated: list.length > limit };
    },
    async stat(file): Promise<SeqStat> {
      log.stat.push(file);
      const age = opts.ageS ? opts.ageS(file) : 3600;
      const t = clock - age * 1000;
      return { mtimeMs: t, ctimeMs: t, birthtimeMs: t };
    },
    now: () => clock,
  };
  return { io, log };
}

const D = "/proj/render";
const inp = (prefix: string, n: number, ext = "exr", id = 1) => ({ file: `${D}/${prefix}${pad(n)}.${ext}`, item_id: id, name: `${prefix}[####].${ext}` });

describe("checkSequences cost rules", () => {
  it("reads a directory once for all the sequences in it", async () => {
    const names = [...frames("A_beauty.", 1, 50), ...frames("A_depth.", 1, 50), ...frames("A_alpha.", 1, 50)];
    const { io, log } = fakeIo({ [D]: names });
    const rep = await checkSequences([inp("A_beauty.", 1, "exr", 1), inp("A_depth.", 1, "exr", 2), inp("A_alpha.", 1, "exr", 3)], io, { caseInsensitive: false });
    expect(log.readdir).toEqual([D]);
    expect(rep.checked).toBe(3);
    expect(rep.sequences.every((r) => r.state === "complete")).toBe(true);
  });

  it("stats at most a few frames per sequence, never one per frame", async () => {
    const { io, log } = fakeIo({ [D]: frames("A.", 1, 10_000, "exr", 4, [5000]) });
    const rep = await checkSequences([inp("A.", 1)], io, { caseInsensitive: false });
    expect(log.stat.length).toBeLessThanOrEqual(STAT_SAMPLE_HIGH + 1);
    expect(rep.sequences[0]).toMatchObject({ state: "gaps", missing: 1, missing_ranges: [[5000, 5000]], missing_text: "5000" });
  });

  it("reports a directory with too many names instead of guessing", async () => {
    const big = Array.from({ length: 300_000 }, (_, i) => `A.${String(i).padStart(7, "0")}.exr`);
    const { io, log } = fakeIo({ [D]: big });
    const rep = await checkSequences([{ file: `${D}/A.0000001.exr`, item_id: 1 }], io, { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "unreadable" });
    expect(rep.sequences[0].reason).toMatch(/too many entries/);
    expect(rep.incomplete).toBe(true);
    expect(log.stat).toEqual([]);
    expect(log.limit).toEqual([200_000]); // the listing is cut at the cap, not read whole
  });

  it("counts what the time budget did not reach", async () => {
    const dirs: Record<string, string[]> = {};
    const inputs = [];
    for (let i = 0; i < 6; i++) {
      dirs[`/d${i}`] = frames("A.", 1, 5);
      inputs.push({ file: `/d${i}/A.0001.exr`, item_id: i, name: `n${i}` });
    }
    const { io, log } = fakeIo(dirs, { readdirCost: 400 });
    const rep = await checkSequences(inputs, io, { budgetMs: 1000, concurrency: 1, caseInsensitive: false });
    expect(log.readdir.length).toBeLessThan(6);
    expect(rep.unchecked_count).toBe(6 - log.readdir.length);
    expect(rep.incomplete).toBe(true);
    expect(rep.notes.join(" ")).toMatch(/not checked/);
  });

  it("says a folder is not found, and a file that is not in the listing", async () => {
    const { io } = fakeIo({ [D]: frames("A.", 1, 5) });
    const rep = await checkSequences([{ file: "/nope/A.0001.exr", item_id: 1 }, { file: `${D}/Z.0001.exr`, item_id: 2 }], io, { caseInsensitive: false });
    const reasons = rep.sequences.map((r) => r.reason).sort();
    expect(reasons).toEqual(["folder not found", "the footage's own file is not in the folder listing"]);
    expect(rep.unreadable).toBe(2);
  });

  it("merges items that point at the same sequence", async () => {
    const { io } = fakeIo({ [D]: frames("A.", 1, 5, "exr", 4, [3]) });
    const rep = await checkSequences([inp("A.", 1, "exr", 7), inp("A.", 2, "exr", 8)], io, { caseInsensitive: false });
    expect(rep.sequences).toHaveLength(1);
    expect(rep.sequences[0].item_ids).toEqual([7, 8]);
  });
});

describe("checkSequences writing detection", () => {
  const gappy = frames("A.", 1, 100, "exr", 4, [40, 41]);
  it("calls a sequence with a fresh newest frame writing, not damaged", async () => {
    const { io } = fakeIo({ [D]: gappy }, { ageS: () => 5 });
    const rep = await checkSequences([inp("A.", 1)], io, { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "writing", writing: true, missing: 2, missing_text: "0040-0041" });
    expect(rep.sequences[0].writing_reason).toMatch(/5 s old/);
    expect(rep.with_gaps).toBe(0);
    expect(rep.writing).toBe(1);
  });
  it("calls an old sequence with gaps gaps", async () => {
    const { io } = fakeIo({ [D]: gappy }, { ageS: () => 120 });
    const rep = await checkSequences([inp("A.", 1)], io, { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "gaps", writing: false, newest_age_s: 120 });
    expect(rep.with_gaps).toBe(1);
  });
  it("counts a folder a known render writes into as writing, whatever the age", async () => {
    const { io } = fakeIo({ [D]: gappy }, { ageS: () => 3600 });
    const rep = await checkSequences([inp("A.", 1)], io, { caseInsensitive: false, liveDirs: [D] });
    expect(rep.sequences[0]).toMatchObject({ state: "writing" });
    expect(rep.sequences[0].writing_reason).toMatch(/render/);
  });
  it("samples the frame just above a gap, so an out-of-order filler counts", async () => {
    const names = frames("A.", 1, 100, "exr", 4, [10]);
    // only frame 11 (just above the gap) is fresh; the top frames are old
    const { io } = fakeIo({ [D]: names }, { ageS: (f) => (f.endsWith("A.0011.exr") ? 2 : 3600) });
    const rep = await checkSequences([inp("A.", 1)], io, { caseInsensitive: false });
    expect(rep.sequences[0].state).toBe("writing");
  });
  it("puts a single frame in its own state", async () => {
    const { io } = fakeIo({ [D]: ["logo_0001.png"] });
    const rep = await checkSequences([{ file: `${D}/logo_0001.png` }], io, { caseInsensitive: false });
    expect(rep.sequences[0].state).toBe("single_frame");
  });
  it("flags AE's frame count when it differs from the folder", async () => {
    const { io } = fakeIo({ [D]: frames("A.", 1, 100) });
    const rep = await checkSequences([{ ...inp("A.", 1), ae_frames: 60 }], io, { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ ae_frames: 60, ae_range_differs: true });
    expect(rep.sequences[0].hint).toMatch(/earlier file list/);
    const same = await checkSequences([{ ...inp("A.", 1), ae_frames: 101 }], io, { caseInsensitive: false });
    expect(same.sequences[0].ae_range_differs).toBeUndefined();
  });
});

describe("checkSequences output bounds", () => {
  it("keeps 100 rows, 20 ranges, 400 chars of text and a small result", async () => {
    const dirs: Record<string, string[]> = {};
    const inputs = [];
    for (let i = 0; i < 500; i++) {
      // every other frame missing: 1,000 ranges a sequence
      const list: string[] = [];
      for (let n = 1; n <= 2000; n += 2) list.push(`S${i}.${pad(n)}.exr`);
      dirs[`/b${i}`] = list;
      inputs.push({ file: `/b${i}/S${i}.0001.exr`, item_id: i, name: `S${i}` });
    }
    const { io } = fakeIo(dirs);
    const rep = await checkSequences(inputs, io, { budgetMs: 60_000, caseInsensitive: false });
    expect(rep.sequences).toHaveLength(100);
    expect(rep.truncated).toBe(true);
    expect(rep.sequences_total).toBe(500);
    for (const r of rep.sequences) {
      expect(r.missing_ranges.length).toBeLessThanOrEqual(20);
      expect(r.missing_text.length).toBeLessThanOrEqual(400);
      expect(r.missing).toBe(999);
      expect(r.ranges_truncated).toBe(true);
    }
    expect(JSON.stringify(rep).length).toBeLessThan(64 * 1024);
  });
});

describe("cloudHint", () => {
  it("recognises synced folders by a path segment", () => {
    expect(cloudHint("C:\\Users\\a\\Dropbox\\proj\\renders")).toMatch(/unsynced/);
    expect(cloudHint("/Users/a/Library/CloudStorage/OneDrive-Acme/x")).toMatch(/unsynced/);
    expect(cloudHint("D:\\renders")).toBeUndefined();
  });
});

// ---------- repair round: the budget, honest "complete", false missing ----------

import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { FS_PAUSED_NOTE, hungFsCallCount, nodeSeqIo, resetHungFsCalls } from "../src/seqscan.js";

const never = () => new Promise<never>(() => undefined);
const realIo = (over: Partial<SeqIo>, dirs: Record<string, string[]> = {}): SeqIo => ({
  readdir: async (dir, limit) => {
    const list = dirs[dir] ?? [];
    return { names: list.slice(0, limit), truncated: list.length > limit };
  },
  stat: async () => {
    const t = Date.now() - 3600_000;
    return { mtimeMs: t, ctimeMs: t, birthtimeMs: t };
  },
  now: () => Date.now(),
  ...over,
});

describe("checkSequences: the time budget holds against calls that never return", () => {
  it("a gapless sequence whose stat never returned is unknown, not complete, and the check is incomplete", async () => {
    const rep = await checkSequences([inp("A.", 1)], realIo({ stat: never }, { [D]: frames("A.", 1, 50) }), { budgetMs: 200, caseInsensitive: false });
    expect(rep.sequences[0].state).toBe("unknown");
    expect(rep).toMatchObject({ unknown_age: 1, incomplete: true, with_gaps: 0 });
  });

  it("a late settle after the count was reset cannot take it below zero", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<{ names: string[]; truncated: boolean }>((ok) => {
      release = () => ok({ names: [], truncated: false });
    });
    await checkSequences([{ file: "/x/A.0001.exr", name: "a" }], realIo({ readdir: () => slow }), { budgetMs: 100, caseInsensitive: false });
    expect(hungFsCallCount()).toBe(1);
    resetHungFsCalls();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(hungFsCallCount()).toBe(0);
  });

  it("with the gate shut the report says file checks are paused, why, and how to clear it", async () => {
    const hang = () => new Promise<never>(() => undefined);
    await checkSequences([{ file: "/x/A.0001.exr", name: "a" }, { file: "/y/A.0001.exr", name: "b" }], realIo({ readdir: hang }), { budgetMs: 100, caseInsensitive: false });
    const rep = await checkSequences([{ file: "/z/A.0001.exr", name: "c" }], realIo({}), { budgetMs: 100, caseInsensitive: false });
    expect(rep.fs_paused).toBe(true);
    expect(rep.incomplete).toBe(true);
    expect(rep.notes[0]).toBe(FS_PAUSED_NOTE);
    expect(rep.notes[0]).toMatch(/network share.*Restarting the panel/);
  });

  it("two abandoned fs calls close the gate: the next check starts no fs call at all, and the gate opens as the calls settle", async () => {
    const released: Array<() => void> = [];
    const hang = () => new Promise<never>((_ok, _no) => void 0);
    let calls = 0;
    const stuckIo = realIo({ readdir: () => { calls++; return hang(); } });
    // Two folders, two workers: both listings hang and are abandoned at the budget.
    const two = [{ file: "/x/A.0001.exr", name: "a" }, { file: "/y/A.0001.exr", name: "b" }];
    await checkSequences(two, stuckIo, { budgetMs: 150, caseInsensitive: false });
    expect(calls).toBe(2);
    expect(hungFsCallCount()).toBe(2);
    // A later check: nothing is started, every input is unchecked at once.
    const t = Date.now();
    const fresh = realIo({ readdir: () => { calls++; return Promise.resolve({ names: [], truncated: false }); } });
    const rep = await checkSequences([{ file: "/z/A.0001.exr", name: "c" }], fresh, { budgetMs: 5000, caseInsensitive: false });
    expect(calls).toBe(2);
    expect(Date.now() - t).toBeLessThan(500);
    expect(rep.unchecked_count).toBe(1);
    // The calls settle: the count goes back down and fs calls start again.
    const slow = [0, 1].map(() => new Promise<{ names: string[]; truncated: boolean }>((ok) => released.push(() => ok({ names: [], truncated: false }))));
    resetHungFsCalls();
    let n = 0;
    await checkSequences(two, realIo({ readdir: () => slow[n++] }), { budgetMs: 150, caseInsensitive: false });
    expect(hungFsCallCount()).toBe(2);
    for (const r of released) r();
    await new Promise((r) => setTimeout(r, 20));
    expect(hungFsCallCount()).toBe(0);
    await checkSequences([{ file: "/z/A.0001.exr", name: "c" }], fresh, { budgetMs: 5000, caseInsensitive: false });
    expect(calls).toBe(3); // the two hung ones and this one
  });

  it("a readdir that never returns is abandoned at the budget and counted as unchecked", async () => {
    const t = Date.now();
    const rep = await checkSequences([{ file: `${D}/A.0001.exr`, item_id: 1, name: "stuck" }], realIo({ readdir: never }), { budgetMs: 200, caseInsensitive: false });
    const took = Date.now() - t;
    expect(took).toBeLessThan(1500);
    expect(rep.unchecked_count).toBe(1);
    expect(rep.unchecked).toEqual(["stuck"]);
    expect(rep.incomplete).toBe(true);
    expect(rep.sequences).toEqual([]);
  });

  it("a stat that never returns leaves gaps with an unknown age: state unknown, not gaps, not counted as with_gaps", async () => {
    const t = Date.now();
    const io = realIo({ stat: never }, { [D]: frames("A.", 1, 50, "exr", 4, [10]) });
    const rep = await checkSequences([inp("A.", 1)], io, { budgetMs: 200, caseInsensitive: false });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(rep.sequences[0]).toMatchObject({ state: "unknown", missing: 1, newest_age_s: null });
    expect(rep.with_gaps).toBe(0);
    expect(rep.unknown_age).toBe(1);
    expect(rep.incomplete).toBe(true);
    expect(rep.notes.join(" ")).toMatch(/still being written/);
  });

  it("slow but finishing calls are measured against real time: later directories are not reached", async () => {
    const dirs: Record<string, string[]> = {};
    const inputs = [];
    for (let i = 0; i < 4; i++) {
      dirs[`/s${i}`] = frames("A.", 1, 5);
      inputs.push({ file: `/s${i}/A.0001.exr`, name: `n${i}` });
    }
    const io = realIo({ readdir: (dir, limit) => new Promise((r) => setTimeout(() => r({ names: (dirs[dir] ?? []).slice(0, limit), truncated: false }), 150)) }, dirs);
    const t = Date.now();
    const rep = await checkSequences(inputs, io, { budgetMs: 250, concurrency: 1, caseInsensitive: false });
    expect(Date.now() - t).toBeLessThan(1200);
    expect(rep.unchecked_count).toBeGreaterThan(0);
    expect(rep.checked).toBeLessThan(4);
  });

  it("reads at most two directories at once by default", async () => {
    let live = 0;
    let max = 0;
    const dirs: Record<string, string[]> = {};
    const inputs = [];
    for (let i = 0; i < 6; i++) {
      dirs[`/c${i}`] = frames("A.", 1, 3);
      inputs.push({ file: `/c${i}/A.0001.exr` });
    }
    const io = realIo(
      {
        readdir: async (dir, limit) => {
          live++;
          max = Math.max(max, live);
          await new Promise((r) => setTimeout(r, 15));
          live--;
          return { names: dirs[dir].slice(0, limit), truncated: false };
        },
      },
      dirs
    );
    await checkSequences(inputs, io, { caseInsensitive: false });
    expect(max).toBe(2);
  });

  it("the real listing stops early on a big folder (opendir), without reading it whole", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "chroma-seqopendir-"));
    try {
      for (let i = 0; i < 60; i++) nodeFs.writeFileSync(nodePath.join(dir, `A.${String(i).padStart(4, "0")}.exr`), "x");
      const cut = await nodeSeqIo.readdir(dir, 10);
      expect(cut.names).toHaveLength(10);
      expect(cut.truncated).toBe(true);
      const whole = await nodeSeqIo.readdir(dir, 100);
      expect(whole.names).toHaveLength(60);
      expect(whole.truncated).toBe(false);
      await expect(nodeSeqIo.readdir(nodePath.join(dir, "nope"), 10)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkSequences: a name it cannot match is never complete", () => {
  it("text after the frame number is unchecked and makes the check incomplete", async () => {
    const io = realIo({}, { [D]: ["shot_0001_beauty.exr", "shot_0002_beauty.exr", "shot_0004_beauty.exr"] });
    const rep = await checkSequences([{ file: `${D}/shot_0001_beauty.exr`, name: "beauty" }], io, { caseInsensitive: false });
    expect(rep).toMatchObject({ checked: 0, unchecked_count: 1, incomplete: true, with_gaps: 0 });
    expect(rep.unchecked).toEqual(["beauty"]);
    expect(rep.notes.join(" ")).toMatch(/text after the frame number/);
  });

  it("a one-frame group while After Effects counts a sequence (shot_0001_v2.exr) is unchecked, not dropped", async () => {
    const lone = realIo({}, { [D]: ["shot_0001_v2.exr", "shot_0001_beauty.exr"] });
    const rep = await checkSequences([{ file: `${D}/shot_0001_v2.exr`, name: "v2", ae_frames: 100 }], lone, { caseInsensitive: false });
    expect(rep).toMatchObject({ checked: 0, unchecked_count: 1, incomplete: true });
    // v1..v3 do form a sequence named shot_0001_v: that one is found
    const trio = realIo({}, { [D]: ["shot_0001_v1.exr", "shot_0001_v2.exr", "shot_0001_v3.exr"] });
    const ok = await checkSequences([{ file: `${D}/shot_0001_v2.exr`, name: "v2" }], trio, { caseInsensitive: false });
    expect(ok.sequences[0]).toMatchObject({ state: "complete", on_disk: 3 });
    // a genuine single still keeps its own state
    const still = await checkSequences([{ file: `${D}/logo_0001.png`, ae_frames: 1 }], realIo({}, { [D]: ["logo_0001.png"] }), { caseInsensitive: false });
    expect(still.sequences[0].state).toBe("single_frame");
  });
});

describe("groupFrames: false missing frames", () => {
  it("a stray frame01.png beside frame1 ... frame200 is not read as a padded width-2 sequence", () => {
    const names = ["frame01.png", ...Array.from({ length: 200 }, (_, i) => `frame${i + 1}.png`)];
    const g = groupFrames(names);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ padded: false, first: 1, last: 200, missing: 0 });
  });

  it("a padded width runs on past its range, and a gap beyond 999 is found from the first frame", async () => {
    const names = [...frames("shot_", 1, 999, "png", 3), ...frames("shot_", 1000, 1100, "png", 4, [1050])];
    const g = groupFrames(names);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ padded: true, digits: 3, first: 1, last: 1100, missing: 1, missing_ranges: [[1050, 1050]] });
    const rep = await checkSequences([{ file: `${D}/shot_001.png` }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ missing: 1, missing_text: "1050", state: "gaps" });
  });

  it("a name decomposed by macOS (NFD) matches the composed name After Effects reports", async () => {
    const nfc = "café_0001.png";
    const names = ["café_0001.png", "café_0002.png", "café_0004.png"];
    expect(names[0]).not.toBe(nfc);
    const rep = await checkSequences([{ file: `${D}/${nfc}` }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "gaps", missing: 1 });
    expect(groupFrames(names, { caseInsensitive: false })).toHaveLength(1);
  });
});

describe("checkSequences: what After Effects counts", () => {
  it("numbering gaps while AE counts about the files on disk are a sparse sequence, not missing frames", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `S.${pad(i * 2 + 1)}.exr`); // every second frame
    const sparse = await checkSequences([{ file: `${D}/S.0001.exr`, ae_frames: 50 }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(sparse.sequences[0].state).toBe("sparse");
    expect(sparse.with_gaps).toBe(0);
    expect(sparse.sparse).toBe(1);
    // AE counting the full range: the gaps are real
    const real = await checkSequences([{ file: `${D}/S.0001.exr`, ae_frames: 99 }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(real.sequences[0].state).toBe("gaps");
    expect(real.with_gaps).toBe(1);
  });

  it("one missing frame is a gap even when AE counts the same as the files on disk (50 numbers, one gone, AE says 50)", async () => {
    const names = frames("S.", 1, 50, "exr", 4, [10]);
    const rep = await checkSequences([{ file: `${D}/S.0001.exr`, ae_frames: 50 }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "gaps", missing: 1, on_disk: 49 });
    expect(rep.with_gaps).toBe(1);
    expect(rep.sparse).toBe(0);
  });

  it("one missing number with AE counting two fewer than the span is still a gap, not sparse (needs more than one missing)", async () => {
    const names = frames("S.", 1, 50, "exr", 4, [10]);
    const rep = await checkSequences([{ file: `${D}/S.0001.exr`, ae_frames: 48 }], realIo({}, { [D]: names }), { caseInsensitive: false });
    expect(rep.sequences[0].state).toBe("gaps");
    expect(rep.with_gaps).toBe(1);
  });

  it("lost trailing frames (AE expects 540, disk holds 1-300) are a short sequence, kept in the rows, with the note", async () => {
    const rep = await checkSequences([{ file: `${D}/A.0001.exr`, name: "plate", ae_frames: 540 }], realIo({}, { [D]: frames("A.", 1, 300) }), { caseInsensitive: false });
    expect(rep.sequences[0]).toMatchObject({ state: "short", missing: 0, ae_frames: 540, ae_range_differs: true });
    expect(rep.short).toBe(1);
    expect(rep.with_gaps).toBe(0);
    expect(rep.notes.join(" ")).toMatch(/Only gaps between the first and last frame/);
  });
});

describe("checkSequences: file times", () => {
  it("a file time far in the future is clock skew, not writing; a few seconds ahead still is", async () => {
    const at = (ms: number) => async () => ({ mtimeMs: Date.now() + ms, ctimeMs: Date.now() + ms, birthtimeMs: Date.now() + ms });
    const gappy = { [D]: frames("A.", 1, 20, "exr", 4, [5]) };
    const rep = await checkSequences([inp("A.", 1)], realIo({ stat: at(3600_000) }, gappy), { caseInsensitive: false });
    expect(rep.sequences[0].state).toBe("unknown");
    expect(rep.notes.join(" ")).toMatch(/in the future/);
    const skew = await checkSequences([inp("A.", 1)], realIo({ stat: at(2000) }, gappy), { caseInsensitive: false });
    expect(skew.sequences[0].state).toBe("writing");
  });
});
