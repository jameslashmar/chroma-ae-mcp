import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeMemoryPurgeSchema,
  AeMemoryStatusSchema,
  memoryTools,
  preflightWarnings,
  purgeMismatches,
  readServerMemory,
  shouldPurgeBetweenChunks,
  type MemoryRead,
} from "../src/tools/ext/memory.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => memoryTools.find((t) => t.name === name)!;
const MB = 1048576;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-memory-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const read = (bytes: number | null, extra: Partial<MemoryRead> = {}): MemoryRead => ({
  ae_version: "26.2.1",
  memory_in_use_bytes: bytes,
  project_path: "<unsaved>",
  dirty: false,
  purge_targets_available: { image: true, snapshot: true, ram: true, undo: true, all: true },
  prefs: [],
  ...extra,
});

describe("schemas", () => {
  it("status takes optional prefs and thresholds, and bounds the prefs list", () => {
    expect(AeMemoryStatusSchema.safeParse({}).success).toBe(true);
    expect(AeMemoryStatusSchema.safeParse({ prefs: [{ section: "S", key: "K", type: "string" }], warn_above_mb: 8000 }).success).toBe(true);
    expect(AeMemoryStatusSchema.safeParse({ prefs: [{ section: "S", key: "K", type: "double" }] }).success).toBe(false);
    expect(AeMemoryStatusSchema.safeParse({ prefs: Array.from({ length: 21 }, () => ({ section: "S", key: "K" })) }).success).toBe(false);
    expect(AeMemoryStatusSchema.safeParse({ warn_above_mb: 0 }).success).toBe(false);
  });

  it("purge needs expect, a known target, and the confirm flag for undo and all", () => {
    expect(AeMemoryPurgeSchema.safeParse({ target: "ram" }).success).toBe(false);
    expect(AeMemoryPurgeSchema.safeParse({ target: "ram", expect: expectArg }).success).toBe(true);
    expect(AeMemoryPurgeSchema.safeParse({ target: "gpu", expect: expectArg }).success).toBe(false);
    expect(AeMemoryPurgeSchema.safeParse({ target: "undo", expect: expectArg }).success).toBe(false);
    expect(AeMemoryPurgeSchema.safeParse({ target: "undo", confirm_undo_purge: true, expect: expectArg }).success).toBe(true);
    expect(AeMemoryPurgeSchema.safeParse({ target: "all", confirm_undo_purge: true, expect: expectArg }).success).toBe(false);
    expect(AeMemoryPurgeSchema.safeParse({ target: "all", confirm_disk_cache_wipe: true, expect: expectArg }).success).toBe(true);
  });

  it("exports the two tools, with the safety guidance on the write", () => {
    expect(memoryTools.map((t) => t.name)).toEqual(["ae_memory_status", "ae_memory_purge"]);
    expect(tool("ae_memory_purge").description).toContain("IMPORTANT");
  });
});

describe("pure logic", () => {
  it("warns on low free RAM by default and on AE memory above the threshold", () => {
    expect(preflightWarnings({ aeBytes: 2000 * MB, freeBytes: 8000 * MB })).toEqual({ ready: true, warnings: [] });
    expect(preflightWarnings({ aeBytes: 2000 * MB, freeBytes: 500 * MB }).ready).toBe(false);
    expect(preflightWarnings({ aeBytes: 2000 * MB, freeBytes: 500 * MB, minFreeMb: 256 }).ready).toBe(true);
    const w = preflightWarnings({ aeBytes: 9000 * MB, freeBytes: 8000 * MB, warnAboveMb: 8000 });
    expect(w.ready).toBe(false);
    expect(w.warnings[0]).toContain("9000 MB");
  });

  it("says so when AE gave no reading to check the threshold against", () => {
    const w = preflightWarnings({ aeBytes: null, freeBytes: 8000 * MB, warnAboveMb: 8000 });
    expect(w.ready).toBe(false);
    expect(w.warnings[0]).toContain("no app.memoryInUse");
  });

  it("purges between chunks only above the threshold and never without a reading", () => {
    expect(shouldPurgeBetweenChunks(5000 * MB, 4000)).toBe(true);
    expect(shouldPurgeBetweenChunks(3000 * MB, 4000)).toBe(false);
    expect(shouldPurgeBetweenChunks(null, 4000)).toBe(false);
  });

  it("reads the server's own memory and the system's", () => {
    const m = readServerMemory();
    expect(m.panel_rss_bytes).toBeGreaterThan(0);
    expect(m.system_total_bytes).toBeGreaterThanOrEqual(m.system_free_bytes);
  });

  it("flags a changed project and a purge the host did not do", () => {
    const args = AeMemoryPurgeSchema.parse({ target: "ram", expect: expectArg });
    expect(purgeMismatches(args, read(1), read(1), { target: "ram", purged: true })).toEqual([]);
    expect(purgeMismatches(args, read(1), read(1, { project_path: "C:/x.aep", dirty: true }), { target: "ram", purged: false }).map((m) => m.path)).toEqual([
      "project_path",
      "dirty",
      "purged",
    ]);
    const watchdog = AeMemoryPurgeSchema.parse({ target: "image", only_above_mb: 1000, expect: expectArg });
    expect(purgeMismatches(watchdog, read(1), read(1), { target: "image", purged: false })).toEqual([]);
  });
});

describe("tools with a fake bridge", () => {
  it("ae_memory_status reads AE once and adds the panel's numbers and the pre-flight", async () => {
    const { ctx, calls } = fakeAe({ memoryRead: [read(6000 * MB)] });
    const args = AeMemoryStatusSchema.parse({ warn_above_mb: 5000, prefs: [{ section: "S", key: "K" }] });
    const out = (await tool("ae_memory_status").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["memoryRead"]);
    expect(calls[0].script).toContain('"section":"S"');
    expect(out.ae.memory_in_use_bytes).toBe(6000 * MB);
    expect(out.server.panel_rss_bytes).toBeGreaterThan(0);
    expect(out.preflight.warnings.some((w: string) => w.includes("6000 MB"))).toBe(true);
  });

  it("ae_memory_purge guards, reads, purges, and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      memoryRead: [read(6000 * MB), read(2000 * MB)],
      memoryPurge: [{ target: "ram", purge_constant: "ALL_MEMORY_CACHES", purged: true, skipped_reason: null, undo_history_cleared: false, disk_cache_cleared: false }],
    });
    const args = AeMemoryPurgeSchema.parse({ target: "ram", expect: expectArg });
    const out = (await tool("ae_memory_purge").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "memoryRead", "memoryPurge", "memoryRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out.receipt.matches).toBe(true);
    expect(out.memory_in_use_bytes).toEqual({ before: 6000 * MB, after: 2000 * MB, freed: 4000 * MB });
    expect(out.warnings.some((w: string) => w.includes("RAM preview"))).toBe(true);
  });

  it("an undo purge says Ctrl+Z is gone, and memory not dropping is not a mismatch", async () => {
    const { ctx } = fakeAe({
      memoryRead: [read(1000 * MB), read(1000 * MB)],
      memoryPurge: [{ target: "undo", purge_constant: "UNDO_CACHES", purged: true, skipped_reason: null, undo_history_cleared: true, disk_cache_cleared: false }],
    });
    const args = AeMemoryPurgeSchema.parse({ target: "undo", confirm_undo_purge: true, expect: expectArg });
    const out = (await tool("ae_memory_purge").handler(args, ctx)) as any;
    expect(out.undo_history_cleared).toBe(true);
    expect(out.warnings[0]).toContain("Ctrl+Z");
    expect(out.receipt.matches).toBe(true);
  });

  it("a failed read-back goes into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      memoryRead: [read(1000 * MB)],
      memoryPurge: [{ target: "image", purge_constant: "IMAGE_CACHES", purged: true, skipped_reason: null, undo_history_cleared: false, disk_cache_cleared: false }],
    });
    const args = AeMemoryPurgeSchema.parse({ target: "image", expect: expectArg });
    const out = (await tool("ae_memory_purge").handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.purged).toBe(true);
  });
});

// ---------- host functions under node:vm ----------

const SAVED = { project_path: "C:/Work/job.aep" };

function host(opts: { saved?: boolean; withRam?: boolean; memory?: number | null } = {}) {
  const project = new FakeProject();
  if (opts.saved) project.file = { fsName: SAVED.project_path };
  const purged: number[] = [];
  const prefs: Record<string, unknown> = { "Mem|Cache": 4096, "Mem|Path": "D:/cache", "Mem|On": 1 };
  const h = loadHost(project, ["memory.jsx"], {
    memoryInUse: opts.memory === undefined ? 3000 * MB : opts.memory,
    purge: (v: number) => purged.push(v),
    preferences: {
      havePref: (s: string, k: string) => `${s}|${k}` in prefs,
      getPrefAsLong: (s: string, k: string) => Number(prefs[`${s}|${k}`]),
      getPrefAsString: (s: string, k: string) => String(prefs[`${s}|${k}`]),
      getPrefAsBool: (s: string, k: string) => Boolean(prefs[`${s}|${k}`]),
      getPrefAsFloat: (s: string, k: string) => Number(prefs[`${s}|${k}`]),
    },
  });
  const consts: Record<string, number> = { IMAGE_CACHES: 1, SNAPSHOT_CACHES: 2, UNDO_CACHES: 3, ALL_CACHES: 4 };
  if (opts.withRam !== false) consts.ALL_MEMORY_CACHES = 5;
  h.G.PurgeTarget = consts;
  return { ...h, project, purged };
}

describe("memory.jsx", () => {
  it("reports memory, the project state, and which purge targets exist", () => {
    const { A } = host({ withRam: false });
    const r = A.memoryRead({});
    expect(r.memory_in_use_bytes).toBe(3000 * MB);
    expect(r.project_path).toBe("<unsaved>");
    expect(r.dirty).toBe(false);
    expect(r.purge_targets_available).toMatchObject({ image: true, ram: false, undo: true });
  });

  it("gives null for a memory reading AE does not give", () => {
    const { A } = host({ memory: null });
    expect(A.memoryRead({}).memory_in_use_bytes).toBeNull();
  });

  it("reads named preferences by type and reports a missing key as exists: false", () => {
    const { A } = host();
    const r = A.memoryRead({
      prefs: [
        { section: "Mem", key: "Cache" },
        { section: "Mem", key: "Path", type: "string" },
        { section: "Mem", key: "On", type: "bool" },
        { section: "Mem", key: "Nope" },
      ],
    });
    expect(r.prefs.map((p: any) => [p.exists, p.value])).toEqual([
      [true, 4096],
      [true, "D:/cache"],
      [true, true],
      [false, null],
    ]);
  });

  it("refuses bad preference requests before reading", () => {
    const { A } = host();
    expect(() => A.memoryRead({ prefs: [{ section: "", key: "k" }] })).toThrow(/needs a section and a key/);
    expect(() => A.memoryRead({ prefs: [{ section: "S", key: "k", type: "double" }] })).toThrow(/type must be/);
    expect(() => A.memoryRead({ prefs: new Array(21).fill({ section: "S", key: "k" }) })).toThrow(/at most 20/);
  });

  it("purges RAM caches without an undo group and says undo may be cleared", () => {
    const { A, undo, purged } = host();
    const r = A.memoryPurge({ target: "ram", expect: GUARD });
    expect(r).toMatchObject({ purged: true, purge_constant: "ALL_MEMORY_CACHES", undo_history_cleared: null, undo_history_may_be_cleared: true, disk_cache_cleared: false });
    expect(purged).toEqual([5]);
    expect(undo.begun).toBe(0);
    const img = A.memoryPurge({ target: "image", expect: GUARD });
    expect(img).toMatchObject({ undo_history_cleared: false, undo_history_may_be_cleared: false });
    expect(undo.begun).toBe(0);
  });

  it("treats an unreadable dirty flag as not clean", () => {
    const { A, project, purged } = host({ saved: true });
    (project as any).dirty = undefined;
    expect(A.memoryRead({}).dirty).toBeNull();
    expect(() => A.memoryPurge({ target: "undo", confirm_undo_purge: true, expect: SAVED })).toThrow(/unsaved changes/);
    expect(purged).toEqual([]);
  });

  it("reads a preference from a named pref file and refuses an unknown one", () => {
    const { A, G } = host();
    G.PREFType = { PREF_Type_MACHINE_INDEPENDENT: 7 };
    const seen: unknown[][] = [];
    const base = G.app.preferences;
    G.app.preferences = { ...base, havePref: (...a: unknown[]) => (seen.push(a), true), getPrefAsLong: () => 9 };
    const r = A.memoryRead({ prefs: [{ section: "S", key: "K", pref_file: "machine_independent" }, { section: "S", key: "K", pref_file: "machine_independent_output" }] });
    expect(seen[0]).toEqual(["S", "K", 7]);
    expect(r.prefs[0]).toMatchObject({ exists: true, value: 9, pref_file: "machine_independent" });
    expect(r.prefs[1].error).toMatch(/no PREFType/);
    expect(() => A.memoryRead({ prefs: [{ section: "S", key: "K", pref_file: "bogus" }] })).toThrow(/pref_file must be/);
  });

  it("refuses ram on an AE without ALL_MEMORY_CACHES before purging", () => {
    const { A, purged, undo } = host({ withRam: false });
    expect(() => A.memoryPurge({ target: "ram", expect: GUARD })).toThrow(/AE 24\.3\+/);
    expect(purged).toEqual([]);
    expect(undo.begun).toBe(0);
  });

  it("refuses a bad target, a bad threshold and a guard mismatch", () => {
    const { A, purged } = host();
    expect(() => A.memoryPurge({ target: "gpu", expect: GUARD })).toThrow(/target must be/);
    expect(() => A.memoryPurge({ target: "image", only_above_mb: -1, expect: GUARD })).toThrow(/only_above_mb/);
    expect(() => A.memoryPurge({ target: "image", expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(purged).toEqual([]);
  });

  it("purges undo only with the confirm flag, a saved project and no unsaved changes", () => {
    const { A, project, purged, undo } = host({ saved: true });
    expect(() => A.memoryPurge({ target: "undo", expect: SAVED })).toThrow(/confirm_undo_purge/);
    project.dirty = true;
    expect(() => A.memoryPurge({ target: "undo", confirm_undo_purge: true, expect: SAVED })).toThrow(/unsaved changes/);
    expect(purged).toEqual([]);
    project.dirty = false;
    const r = A.memoryPurge({ target: "undo", confirm_undo_purge: true, expect: SAVED });
    expect(r).toMatchObject({ purged: true, undo_history_cleared: true });
    expect(purged).toEqual([3]);
    expect(undo.begun).toBe(0);
  });

  it("refuses undo and all on a project that was never saved", () => {
    const { A, purged } = host();
    expect(() => A.memoryPurge({ target: "undo", confirm_undo_purge: true, expect: GUARD })).toThrow(/never been saved/);
    expect(() => A.memoryPurge({ target: "all", confirm_disk_cache_wipe: true, expect: GUARD })).toThrow(/never been saved/);
    expect(purged).toEqual([]);
  });

  it("wipes all caches only with its own confirm flag", () => {
    const { A, purged } = host({ saved: true });
    expect(() => A.memoryPurge({ target: "all", confirm_undo_purge: true, expect: SAVED })).toThrow(/confirm_disk_cache_wipe/);
    const r = A.memoryPurge({ target: "all", confirm_disk_cache_wipe: true, expect: SAVED });
    expect(r).toMatchObject({ purged: true, disk_cache_cleared: true, undo_history_cleared: null });
    expect(purged).toEqual([4]);
  });

  it("only_above_mb skips below the threshold and when AE gives no reading", () => {
    const low = host();
    expect(low.A.memoryPurge({ target: "image", only_above_mb: 4000, expect: GUARD })).toMatchObject({ purged: false, skipped_reason: "below_threshold" });
    expect(low.purged).toEqual([]);
    expect(low.undo.begun).toBe(0);
    const none = host({ memory: null });
    expect(none.A.memoryPurge({ target: "image", only_above_mb: 1, expect: GUARD })).toMatchObject({ purged: false, skipped_reason: "memory_unavailable" });
    const high = host();
    expect(high.A.memoryPurge({ target: "image", only_above_mb: 1000, expect: GUARD })).toMatchObject({ purged: true });
    expect(high.purged).toEqual([1]);
  });
});
