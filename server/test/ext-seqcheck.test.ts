import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import type { ToolContext } from "../src/tools/common.js";
import { blockingSequences, dirsOfFiles, liveDirsFromJobs, runSequenceCheck, sequenceBlockMessage, sequenceReport, sequenceWarnings } from "../src/tools/ext/seqcheck.js";
import { footagePage, makeSequence, useOldFiles } from "./support/seq-fixtures.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-seqcheck-"));
  tmpDirs.push(d);
  return d;
};
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A context whose bridge answers preflightItems from `pages` and records every host function. */
function ctxWith(pages: unknown[] | ((fn: string) => unknown)) {
  const calls: string[] = [];
  let n = 0;
  const bridge = {
    evalRaw: async (p: { script: string }) => {
      const fn = p.script.slice("__chromaAe.".length, p.script.indexOf("("));
      calls.push(fn);
      if (typeof pages === "function") return { ok: true, result: pages(fn), durationMs: 1 };
      return { ok: true, result: pages[Math.min(n++, pages.length - 1)], durationMs: 1 };
    },
  };
  return { ctx: { bridge } as unknown as ToolContext, calls };
}

const opts = { opId: "op_1", toolName: "ae_render_queue_render" };

describe("sequenceReport", () => {
  it("each listing page of the footage is sent with a timeout of its own, far under the default 120 s", async () => {
    const timeouts: Array<number | undefined> = [];
    const bridge = {
      evalRaw: async (p: { timeoutMs?: number }) => {
        timeouts.push(p.timeoutMs);
        return { ok: true, result: footagePage([]), durationMs: 1 };
      },
    };
    await sequenceReport({ bridge } as unknown as ToolContext, opts);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThanOrEqual(6000);
    expect(timeouts[0]).toBeLessThanOrEqual(20_000);
  });

  it("finds the gap, names the scope honestly and reads nothing but the footage list", async () => {
    const dir = tmp();
    const first = makeSequence(path.join(dir, "exr"), { skip: [7, 8, 12] });
    const ok = makeSequence(path.join(dir, "ok"), { prefix: "B." });
    const old = useOldFiles();
    restore = old.restore;
    const { ctx, calls } = ctxWith([footagePage([{ file: first, name: "A beauty" }, { file: ok, name: "B" }, { file: path.join(dir, "x.mov"), sequence: false }])]);
    const c = await sequenceReport(ctx, opts);
    expect(calls).toEqual(["preflightItems"]);
    expect(c.scope).toBe("footage_used_by_any_comp");
    expect(c.scope_note).toMatch(/not only the comps about to render/);
    expect(c).toMatchObject({ checked: 2, with_gaps: 1, writing: 0, incomplete: false });
    expect(c.sequences).toHaveLength(1);
    expect(c.sequences[0]).toMatchObject({ state: "gaps", missing: 3, missing_text: "0007-0008, 0012", item_names: ["A beauty"] });
    expect(old.log.readdir).toHaveLength(2);
  });

  it("leaves out a footage file that is missing, and footage no comp uses", async () => {
    const dir = tmp();
    const first = makeSequence(dir, { skip: [3] });
    const old = useOldFiles();
    restore = old.restore;
    const { ctx } = ctxWith([footagePage([{ file: first, missing: true }, { file: first, used_n: 0, id: 9 }])]);
    const c = await sequenceReport(ctx, opts);
    expect(c.checked).toBe(0);
    expect(old.log.readdir).toEqual([]);
  });

  it("follows the pages and stops at 20", async () => {
    const dir = tmp();
    const first = makeSequence(dir);
    const old = useOldFiles();
    restore = old.restore;
    let pageNo = 0;
    const { ctx, calls } = ctxWith(() => ({ ...footagePage([{ file: first }]), next_offset: ++pageNo * 150 }));
    const c = await sequenceReport(ctx, opts);
    expect(calls).toHaveLength(20);
    expect(c.incomplete).toBe(true);
    expect(c.notes.join(" ")).toMatch(/first 3000 project items/);
  });

  it("does not throw when the host has no preflightItems; it says the check did not run", async () => {
    const bridge = {
      evalRaw: async () => {
        throw new BridgeError({ kind: "evalscript_error", message: "A.preflightItems is not a function" });
      },
    };
    const c = await sequenceReport({ bridge } as unknown as ToolContext, opts);
    expect(c.incomplete).toBe(true);
    expect(c.error).toMatch(/not a function/);
    expect(sequenceWarnings(c)[0]).toMatch(/Sequence check incomplete/);
  });

  it("lets a stuck bridge through, as every other read does", async () => {
    const bridge = {
      evalRaw: async () => {
        throw new BridgeError({ kind: "timeout", message: "timed out" });
      },
    };
    await expect(sequenceReport({ bridge } as unknown as ToolContext, opts)).rejects.toThrow(/timed out/);
  });
});

describe("modes", () => {
  async function gappy() {
    const dir = tmp();
    const first = makeSequence(dir, { skip: [5] });
    const old = useOldFiles();
    restore = old.restore;
    return { first, old, ...ctxWith([footagePage([{ file: first }])]) };
  }

  it("warn (default): a warning line, no block", async () => {
    const g = await gappy();
    const r = await runSequenceCheck(g.ctx, undefined, opts);
    expect(r.block).toBe(false);
    expect(r.check?.with_gaps).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/1 image sequence has missing frames/);
    expect(r.warnings[0]).toMatch(/0005/);
    expect(r.warnings[0]).toMatch(/not stopped/);
  });

  it("off: no host call and no folder read", async () => {
    const g = await gappy();
    const r = await runSequenceCheck(g.ctx, "off", opts);
    expect(r).toEqual({ warnings: [], block: false });
    expect(g.calls).toEqual([]);
    expect(g.old.log.readdir).toEqual([]);
  });

  it("block: refuses on gaps, with a message that names the way out", async () => {
    const g = await gappy();
    const r = await runSequenceCheck(g.ctx, "block", opts);
    expect(r.block).toBe(true);
    expect(blockingSequences(r.check!)).toHaveLength(1);
    expect(sequenceBlockMessage("ae_aerender_start", r.check!)).toMatch(/refused.*missing frames.*Nothing was started.*sequence_check "warn" \(it only warns and proceeds\) or "off"/);
  });

  it("block: a sequence still being written never blocks, and is reported as writing", async () => {
    const dir = tmp();
    const first = makeSequence(dir, { skip: [5] });
    const fresh = useOldFiles(2); // newest frame 2 s old
    restore = fresh.restore;
    const { ctx } = ctxWith([footagePage([{ file: first }])]);
    const r = await runSequenceCheck(ctx, "block", opts);
    expect(r.block).toBe(false);
    expect(r.check).toMatchObject({ with_gaps: 0, writing: 1 });
    expect(r.check!.sequences[0].state).toBe("writing");
    expect(r.warnings.join(" ")).toMatch(/still being written/);
    expect(r.warnings.join(" ")).not.toMatch(/missing frames in the project/);
  });

  it("a folder a running render writes into counts as writing", async () => {
    const dir = tmp();
    const first = makeSequence(dir, { skip: [5] });
    const old = useOldFiles();
    restore = old.restore;
    const { ctx } = ctxWith([footagePage([{ file: first }])]);
    const r = await runSequenceCheck(ctx, "warn", { ...opts, liveDirs: [dir] });
    expect(r.check!.sequences[0].state).toBe("writing");
  });
});

describe("helpers", () => {
  it("dirsOfFiles skips placeholders; liveDirsFromJobs reads only running jobs", () => {
    expect(dirsOfFiles(["C:/out/a.mov", "<queue>", ""])).toEqual([path.dirname("C:/out/a.mov")]);
    expect(
      liveDirsFromJobs([
        { state: "running", output_paths: ["C:/r1/f.[####].exr"] },
        { state: "running", output_path: "C:/r2/x.mov" },
        { state: "succeeded", output_path: "C:/r3/y.mov" },
      ])
    ).toEqual([path.dirname("C:/r1/f.[####].exr"), path.dirname("C:/r2/x.mov")]);
  });
});

// ---------- repair round ----------

import { listSequenceInputs, prepareSequenceCheck, finishSequenceCheck, blockReasons, sequenceStepFrom } from "../src/tools/ext/seqcheck.js";
import { FS_PAUSED_NOTE, seqscanDeps, type SeqIo } from "../src/seqscan.js";

/** Fake folders: `stat` answers with the age that `ageOf` gives for the path. */
function fakeFolders(dirs: Record<string, string[]>, ageOf: (file: string) => number): SeqIo {
  return {
    readdir: async (dir, limit) => ({ names: (dirs[dir] ?? []).slice(0, limit), truncated: (dirs[dir] ?? []).length > limit }),
    stat: async (file) => {
      const t = Date.now() - ageOf(file) * 1000;
      return { mtimeMs: t, ctimeMs: t, birthtimeMs: t };
    },
    now: () => Date.now(),
  };
}
const aFrames = (n: number, skip: number[] = []) => Array.from({ length: n }, (_, i) => i + 1).filter((i) => !skip.includes(i)).map((i) => `A.${String(i).padStart(4, "0")}.exr`);

describe("block sees past the rows a result lists", () => {
  it("25 sequences still being written plus one damaged plate: with_gaps 1, block true, a readable warning", async () => {
    const dirs: Record<string, string[]> = { "/plate": aFrames(50, [7]) };
    const files = [{ file: "/plate/A.0001.exr", name: "plate" }];
    for (let i = 0; i < 25; i++) {
      dirs[`/w${i}`] = aFrames(50, [7]);
      files.push({ file: `/w${i}/A.0001.exr`, name: `writing${i}` });
    }
    const before = seqscanDeps.io;
    seqscanDeps.io = fakeFolders(dirs, (f) => (f.includes("plate") ? 3600 : 2));
    restore = () => {
      seqscanDeps.io = before;
    };
    const { ctx } = ctxWith([footagePage(files)]);
    const r = await runSequenceCheck(ctx, "block", opts);
    expect(r.check).toMatchObject({ with_gaps: 1, writing: 25 });
    expect(r.block).toBe(true);
    expect(r.check!.sequences[0]).toMatchObject({ state: "gaps" }); // gap rows come first in the list
    expect(r.check!.truncated).toBe(true);
    const text = r.warnings.join(" ");
    expect(text).toMatch(/1 image sequence has missing frames in the project: "plate": 1 frame missing between 1 and 50/);
    expect(text).not.toMatch(/project: ;|project: \./);
    expect(r.blockMessage).toMatch(/plate/);
  });
});

describe("an incomplete check says so", () => {
  it("warns on an unreadable folder, a name it could not match and a cut listing; block refuses and warn proceeds", async () => {
    const before = seqscanDeps.io;
    seqscanDeps.io = fakeFolders({ "/ok": aFrames(10) }, () => 3600);
    restore = () => {
      seqscanDeps.io = before;
    };
    const files = [{ file: "/ok/A.0001.exr", name: "fine" }, { file: "/gone/A.0001.exr", name: "gone" }, { file: "/ok/shot_0001_beauty.exr", name: "beauty" }];
    const warn = await runSequenceCheck(ctxWith([footagePage(files)]).ctx, "warn", opts);
    expect(warn.block).toBe(false);
    expect(warn.check).toMatchObject({ unreadable: 1, unchecked_count: 1, incomplete: true });
    expect(warn.warnings.join(" ")).toMatch(/Sequence check incomplete: 1 sequence folder could not be read; 1 footage item not checked/);
    const block = await runSequenceCheck(ctxWith([footagePage(files)]).ctx, "block", opts);
    expect(block.block).toBe(true);
    expect(blockReasons(block.check!).join(" ")).toMatch(/could not be read.*not checked/);
    expect(block.blockMessage).toMatch(/"warn" \(it only warns and proceeds\)/);
  });

  it("a sequence whose age is unknown (time ran out after the listing) is not a gap, but block refuses it as an incomplete check", async () => {
    const before = seqscanDeps.io;
    seqscanDeps.io = { ...fakeFolders({ "/p": aFrames(50, [7]) }, () => 3600), stat: () => new Promise<never>(() => undefined) };
    restore = () => {
      seqscanDeps.io = before;
    };
    const t = Date.now();
    const prep = await prepareSequenceCheck(ctxWith([footagePage([{ file: "/p/A.0001.exr", name: "p" }])]).ctx, { ...opts, budgetMs: 300 });
    const c = await finishSequenceCheck(prep, { ...opts, budgetMs: 300 });
    expect(Date.now() - t).toBeLessThan(3500);
    expect(c).toMatchObject({ with_gaps: 0, unknown_age: 1, incomplete: true });
    expect(blockReasons(c).join(" ")).toMatch(/could not be dated/);
    expect(sequenceWarnings(c).join(" ")).toMatch(/time ran out before it could be read whether they are still being written/);
  });

  it("a check paused by the hung-fs gate says so in the warnings and in the block refusal, with the cure", () => {
    const base = { scope: "footage_used_by_any_comp", checked: 0, with_gaps: 0, writing: 0, unreadable: 0, sparse: 0, short: 0, unknown_age: 0, sequences: [], sequences_total: 0, unchecked: [], unchecked_count: 2, truncated: false, elapsed_ms: 1 };
    const c: any = { ...base, incomplete: true, fs_paused: true, notes: [FS_PAUSED_NOTE] };
    expect(sequenceWarnings(c).join(" ")).toMatch(/paused.*never returned.*Restarting the panel/);
    expect(blockReasons(c).join(" ")).toMatch(/paused.*never returned.*Restarting the panel/);
    expect(sequenceBlockMessage("ae_render_queue_render", c)).toMatch(/Restarting the panel/);
  });

  it("block refuses every incomplete check, whatever cut it (listing time limit, item cap)", () => {
    const base = { scope: "footage_used_by_any_comp", checked: 3, with_gaps: 0, writing: 0, unreadable: 0, sparse: 0, short: 0, unknown_age: 0, sequences: [], sequences_total: 0, unchecked: [], unchecked_count: 0, truncated: false, elapsed_ms: 1 };
    for (const note of ["The project listing was cut at the time limit.", "Only the first 3000 project items were listed."]) {
      const c: any = { ...base, incomplete: true, notes: [note] };
      expect(blockReasons(c).join(" ")).toContain(note);
      expect(sequenceStepFrom("block", "ae_render_queue_render", c).block).toBe(true);
      expect(sequenceStepFrom("warn", "ae_render_queue_render", c).block).toBe(false);
    }
    expect(blockReasons({ ...base, incomplete: false, notes: [] } as any)).toEqual([]);
  });

  it("an unknown sequence with an unreadable neighbour still blocks, for the neighbour", async () => {
    const c = await (async () => {
      const before = seqscanDeps.io;
      seqscanDeps.io = fakeFolders({}, () => 3600);
      restore = () => {
        seqscanDeps.io = before;
      };
      return sequenceReport(ctxWith([footagePage([{ file: "/missing/A.0001.exr" }])]).ctx, opts);
    })();
    expect(blockReasons(c).join(" ")).toMatch(/could not be read/);
  });
});

describe("the footage listing has one deadline", () => {
  it("stops after the page in flight once the deadline has passed", async () => {
    let pageNo = 0;
    const { ctx, calls } = ctxWith(() => ({ ...footagePage([]), next_offset: ++pageNo * 150 }));
    const call = async (fn: string, args: Record<string, unknown>) => (await (ctx.bridge as any).evalRaw({ script: "__chromaAe." + fn + "(" + JSON.stringify(args) + ")" })).result;
    const r = await listSequenceInputs(call as never, Date.now() - 1);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ complete: false });
    expect(r.reason).toMatch(/time limit/);
  });
});

describe("tolerant mode (aerender, the batch) turns any bridge failure into an error in the result", () => {
  const failing = (kind: string) => ({
    evalRaw: async () => {
      throw new BridgeError({ kind: kind as never, message: "x " + kind });
    },
  });
  it("tolerant returns the error; the default still throws (ae_render_queue_render)", async () => {
    const tolerant = await sequenceReport({ bridge: failing("timeout") } as unknown as ToolContext, { ...opts, tolerant: true });
    expect(tolerant).toMatchObject({ incomplete: true, error: expect.stringContaining("timeout") });
    await expect(sequenceReport({ bridge: failing("timeout") } as unknown as ToolContext, opts)).rejects.toThrow(/timeout/);
    const queued = await sequenceReport({ bridge: failing("queued") } as unknown as ToolContext, { ...opts, tolerant: true });
    expect(queued.error).toMatch(/queued/);
  });
});
