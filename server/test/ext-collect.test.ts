import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCollectFilesSchema,
  AeCollectRelinkSchema,
  AeCollectReportSchema,
  buildMappings,
  collectTools,
  Crc32,
  diffManifests,
  diffReports,
  expectedRelink,
  formatBytes,
  matchFrames,
  planCollect,
  readZipDirectory,
  relinkMismatches,
  renderReportMarkdown,
  resolveSource,
  safeSegment,
  sourceKey,
  splitFrameName,
  verifyItemMismatches,
  verifyZip,
  writeZip,
  zipStamp,
  type FootageEntry,
  type Manifest,
  type ResolvedSource,
  type VersionReport,
} from "../src/tools/ext/collect.js";
import { FakeFootage, FakeProject, FileSource, GUARD, loadHost, SolidSource } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "chroma-collect-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const tool = (name: string) => collectTools.find((t) => t.name === name)!;
const sha1 = (b: Buffer | string) => crypto.createHash("sha1").update(b).digest("hex");

type Handler = (args: any, script: string) => unknown;

/** A PanelHost whose AE answers each host function from a handler; records every call. */
function fakeAe(handlers: Record<string, Handler>, project = { path: "<unsaved>", dirty: false }) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dir = tmp("chroma-collect-q-");
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: project.path, comp_id: null, comp_is_valid: true, dirty: project.dirty }, durationMs: 1 };
      }
      const h = handlers[fn];
      if (!h) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: h(args, script), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

// ---------- a project on disk to collect ----------

const bytesOf = (n: number, seed: string) => Buffer.from(seed.repeat(Math.ceil(n / seed.length)).slice(0, n));

interface Scene {
  root: string;
  aep: string;
  dest: string;
  entries: FootageEntry[];
  handlers: Record<string, Handler>;
}

function makeScene(): Scene {
  const root = tmp();
  const projDir = path.join(root, "proj");
  const media = path.join(root, "media");
  const seq = path.join(root, "shot_v001");
  const proxyDir = path.join(root, "proxies");
  for (const d of [projDir, media, seq, proxyDir]) fs.mkdirSync(d, { recursive: true });
  const aep = path.join(projDir, "Show.aep");
  fs.writeFileSync(aep, bytesOf(3000, "AEP-"));
  fs.writeFileSync(path.join(media, "plate.mov"), bytesOf(5000, "mov"));
  fs.writeFileSync(path.join(media, "logo.png"), bytesOf(700, "png"));
  fs.writeFileSync(path.join(proxyDir, "plate_proxy.mov"), bytesOf(900, "prx"));
  for (const n of ["0001", "0002", "0003", "0005"]) fs.writeFileSync(path.join(seq, `shot_v001.${n}.exr`), bytesOf(400, n));
  const entries: FootageEntry[] = [
    { item_id: 1, name: "plate.mov", file: path.join(media, "plate.mov"), sequence: false, missing: false, used_in: 2, bin: ["Plates"], proxy: { file: path.join(proxyDir, "plate_proxy.mov"), sequence: false, in_use: true } },
    { item_id: 2, name: "plate again", file: path.join(media, "plate.mov"), sequence: false, missing: false, used_in: 1, bin: ["Other"], proxy: null },
    { item_id: 3, name: "shot", file: path.join(seq, "shot_v001.0002.exr"), sequence: true, missing: false, used_in: 1, bin: [], proxy: null },
    { item_id: 4, name: "gone.mov", file: path.join(media, "gone.mov"), sequence: false, missing: true, used_in: 1, bin: [], proxy: null },
    { item_id: 5, name: "logo.png", file: path.join(media, "logo.png"), sequence: false, missing: false, used_in: 0, bin: ["Plates"], proxy: null },
  ];
  const handlers: Record<string, Handler> = {
    collectState: () => ({ project_path: aep, saved: true, dirty: false, num_items: 9, ae: { version: "26.2.1", build_number: 77 } }),
    collectFootage: () => ({
      project_path: aep,
      dirty: false,
      offset: 0,
      total: entries.length,
      next_offset: null,
      items: entries,
      no_file: [
        { item_id: 8, name: "Black Solid", kind: "solid" },
        { item_id: 9, name: "Missing", kind: "placeholder" },
      ],
    }),
    collectInfo: () => ({
      project_path: aep,
      dirty: false,
      ae: { version: "26.2.1", build_number: 77, os: "Windows" },
      num_items: 9,
      num_comps: 1,
      comps: [{ id: 20, name: "Main", width: 1920, height: 1080, fps: 25, duration: 10, num_layers: 3 }],
      comps_truncated: false,
      effects: [{ match_name: "ADBE Gaussian Blur 2", name: "Gaussian Blur", count: 2 }],
      expressions: { count: 4, truncated: false },
      layers_capped: false,
      render_outputs: [{ item: 1, comp: "Main", status: "DONE", output_module: "Lossless", file: path.join(media, "plate.mov") }],
      render_outputs_truncated: false,
    }),
    fontsInUse: () => ({ fonts: [{ font: "ArialMT", uses: 3, missing: false }] }),
  };
  return { root, aep, dest: path.join(root, "out", "_collect"), entries, handlers };
}

const expectArg = (s: Scene) => ({ project_path: s.aep });

// ---------- schemas ----------

describe("collect schemas", () => {
  it("ae_collect_files needs nothing, and bounds max_seconds", () => {
    expect(AeCollectFilesSchema.safeParse({}).success).toBe(true);
    expect(AeCollectFilesSchema.safeParse({ max_seconds: 1 }).success).toBe(false);
    expect(AeCollectFilesSchema.safeParse({ report: "html" }).success).toBe(false);
  });

  it("ae_collect_relink needs confirm_close_project: true and expect", () => {
    const ok = { confirm_close_project: true, expect: { project_path: "C:/a.aep" } };
    expect(AeCollectRelinkSchema.safeParse(ok).success).toBe(true);
    expect(AeCollectRelinkSchema.safeParse({ ...ok, confirm_close_project: false }).success).toBe(false);
    expect(AeCollectRelinkSchema.safeParse({ confirm_close_project: true }).success).toBe(false);
    expect(AeCollectRelinkSchema.safeParse({ ...ok, reduce_to_comp_ids: [] }).success).toBe(false);
  });

  it("ae_collect_report takes a format", () => {
    expect(AeCollectReportSchema.safeParse({ format: "json" }).success).toBe(true);
    expect(AeCollectReportSchema.safeParse({ format: "pdf" }).success).toBe(false);
  });

  it("exports three tools, the mutating one ending with the safety guidance", () => {
    expect(collectTools.map((t) => t.name)).toEqual(["ae_collect_files", "ae_collect_relink", "ae_collect_report"]);
    expect(tool("ae_collect_relink").description).toContain("Jay may be editing live");
  });
});

// ---------- pure logic ----------

describe("names and sequences", () => {
  it("makes legal segments", () => {
    expect(safeSegment('a:b*c?.mov')).toBe("a_b_c_.mov");
    expect(safeSegment("CON.txt")).toBe("_CON.txt");
    expect(safeSegment("name. ")).toBe("name");
    expect(safeSegment("..")).toBe("_");
    expect(safeSegment("x".repeat(300) + ".exr").length).toBe(120);
    expect(safeSegment("x".repeat(300) + ".exr").endsWith(".exr")).toBe(true);
  });

  it("splits a frame name at the last run of digits before the extension", () => {
    expect(splitFrameName("shot_v003.0001.exr")).toEqual({ prefix: "shot_v003.", digits: "0001", suffix: ".exr" });
    expect(splitFrameName("frame12.png")).toEqual({ prefix: "frame", digits: "12", suffix: ".png" });
    expect(splitFrameName("plate.mov")).toBeNull();
    // Text may follow the frame number.
    expect(splitFrameName("shot_0001_beauty.exr")).toEqual({ prefix: "shot_", digits: "0001", suffix: "_beauty.exr" });
    expect(splitFrameName("plate_001_L.png")).toEqual({ prefix: "plate_", digits: "001", suffix: "_L.png" });
    expect(splitFrameName("plate_v2_0007.exr")).toEqual({ prefix: "plate_v2_", digits: "0007", suffix: ".exr" });
  });

  it("finds the frames of a sequence whose name continues after the number", async () => {
    const dir = tmp();
    for (const n of ["0001", "0002", "0003"]) fs.writeFileSync(path.join(dir, `shot_${n}_beauty.exr`), "x");
    fs.writeFileSync(path.join(dir, "shot_0001_depth.exr"), "x");
    const r = await resolveSource(path.join(dir, "shot_0002_beauty.exr"), true);
    expect(r.files.map((f) => path.basename(f.path))).toEqual(["shot_0001_beauty.exr", "shot_0002_beauty.exr", "shot_0003_beauty.exr"]);
    expect(r.warning).toBeUndefined();
  });

  it("warns when a sequence resolves to a single file", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "only.0001.exr"), "x");
    fs.writeFileSync(path.join(dir, "named.exr"), "x");
    expect((await resolveSource(path.join(dir, "only.0001.exr"), true)).warning).toMatch(/only one frame/);
    expect((await resolveSource(path.join(dir, "named.exr"), true)).warning).toMatch(/no frame number/);
    expect((await resolveSource(path.join(dir, "named.exr"), false)).warning).toBeUndefined();
  });

  it("matches the frames of one pattern, padded or not", () => {
    const names = ["a.0001.exr", "a.0002.exr", "a.0010.exr", "b.0001.exr", "a.0003.png", "a.12.exr", "notes.txt"];
    expect(matchFrames(names, "a.0002.exr", false).map((f) => f.name)).toEqual(["a.0001.exr", "a.0002.exr", "a.0010.exr"]);
    const unpadded = ["f1.png", "f2.png", "f10.png", "f01.png"];
    expect(matchFrames(unpadded, "f2.png", false).map((f) => f.number)).toEqual([1, 2, 10]);
    expect(matchFrames(["A.0001.EXR", "a.0002.exr"], "a.0002.exr", true)).toHaveLength(2);
    expect(matchFrames(["A.0001.EXR", "a.0002.exr"], "a.0002.exr", false)).toHaveLength(1);
  });

  it("keys any frame of a sequence the same", () => {
    expect(sourceKey("C:/s/a.0001.exr", true)).toBe(sourceKey("C:\\s\\a.0042.exr", true));
    expect(sourceKey("C:/s/a.0001.exr", false)).not.toBe(sourceKey("C:/s/a.0042.exr", false));
  });

  it("resolves a sequence from the folder, with its gaps", async () => {
    const s = makeScene();
    const r = await resolveSource(s.entries[2].file, true);
    expect(r.files).toHaveLength(4);
    expect(r.frames).toEqual({ count: 4, first: 1, last: 5, gaps: 1 });
    expect((await resolveSource(path.join(s.root, "nope.mov"), false)).error).toMatch(/not on disk/);
  });
});

describe("planCollect", () => {
  const resolvedFor = async (entries: FootageEntry[]) => {
    const m = new Map<string, ResolvedSource>();
    for (const e of entries) {
      m.set(sourceKey(e.file, e.sequence), await resolveSource(e.file, e.sequence));
      if (e.proxy) m.set(sourceKey(e.proxy.file, e.proxy.sequence), await resolveSource(e.proxy.file, e.proxy.sequence));
    }
    return m;
  };

  it("lays out bins, proxies and sequences, and collects a shared file once", async () => {
    const s = makeScene();
    const plan = planCollect(s.entries, await resolvedFor(s.entries));
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "_Footage/Plates/logo.png",
      "_Footage/Plates/plate.mov",
      "_Footage/_Proxies/Plates/plate_proxy.mov",
      "_Footage/shot_v001/shot_v001.0001.exr",
      "_Footage/shot_v001/shot_v001.0002.exr",
      "_Footage/shot_v001/shot_v001.0003.exr",
      "_Footage/shot_v001/shot_v001.0005.exr",
    ]);
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].item_ids.sort()).toEqual([1, 2]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatchObject({ item_ids: [4], problem: "the file is not on disk" });
    expect(plan.gaps).toHaveLength(1);
    expect(plan.bytes).toBe(5000 + 700 + 900 + 4 * 400);
    const main = plan.sources.find((x) => x.item_ids.includes(1) && x.role === "main")!;
    expect(main.item_ids.sort()).toEqual([1, 2]);
    expect(main.dest_first).toBe("_Footage/Plates/plate.mov");
  });

  it("leaves out unused footage and proxies on request", async () => {
    const s = makeScene();
    const plan = planCollect(s.entries, await resolvedFor(s.entries), { only_used: true, include_proxies: false });
    expect(plan.skipped_unused).toBe(1);
    expect(plan.files.map((f) => f.path)).not.toContain("_Footage/Plates/logo.png");
    expect(plan.files.some((f) => f.path.includes("_Proxies"))).toBe(false);
  });

  it("renames files and sequence folders that would collide", () => {
    const f = (n: number, file: string, seq = false): FootageEntry => ({ item_id: n, name: String(n), file, sequence: seq, missing: false, used_in: 1, bin: ["B"], proxy: null });
    const entries = [f(1, "C:/a/take.mov"), f(2, "C:/b/take.mov"), f(3, "C:/x/seq/f.0001.png", true), f(4, "C:/y/seq/f.0001.png", true)];
    const one = (file: string): ResolvedSource => ({ files: [{ path: file, bytes: 10, mtimeMs: 1 }] });
    const resolved = new Map<string, ResolvedSource>();
    for (const e of entries) resolved.set(sourceKey(e.file, e.sequence), one(e.file));
    const plan = planCollect(entries, resolved);
    expect(plan.files.map((x) => x.path)).toEqual(["_Footage/B/take.mov", "_Footage/B/take_2.mov", "_Footage/B/seq/f.0001.png", "_Footage/B/seq_2/f.0001.png"]);
  });

  it("writes an unsplittable sequence to the path it planned, even when names collide", () => {
    const f = (n: number, file: string): FootageEntry => ({ item_id: n, name: String(n), file, sequence: true, missing: false, used_in: 1, bin: [], proxy: null });
    const entries = [f(1, "C:/a/still.exr"), f(2, "C:/b/still.exr")];
    const one = (file: string): ResolvedSource => ({ files: [{ path: file, bytes: 10, mtimeMs: 1 }], warning: "no frame number" });
    const resolved = new Map<string, ResolvedSource>();
    for (const e of entries) resolved.set(sourceKey(e.file, e.sequence), one(e.file));
    const plan = planCollect(entries, resolved);
    expect(plan.files.map((x) => x.path)).toEqual(["_Footage/still.exr", "_Footage/still_2.exr"]);
    expect(plan.sources.map((x) => x.dest_first)).toEqual(plan.files.map((x) => x.path));
    expect(plan.warnings).toEqual(["no frame number", "no frame number"]);
  });
});

describe("Crc32 and formatBytes", () => {
  it("matches the CRC32 check value, in pieces too", () => {
    expect(new Crc32().update(Buffer.from("123456789")).value).toBe(0xcbf43926);
    expect(new Crc32().update(Buffer.from("1234")).update(Buffer.from("56789")).value).toBe(0xcbf43926);
    expect(new Crc32().value).toBe(0);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});

describe("zip writer", () => {
  const files = (dir: string) => {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.mov");
    const c = path.join(dir, "empty.dat");
    fs.writeFileSync(a, bytesOf(50_000, "hello zip "));
    fs.writeFileSync(b, crypto.randomBytes(20_000));
    fs.writeFileSync(c, "");
    return [a, b, c];
  };

  it("writes, reads back and verifies stored, deflated and empty entries", async () => {
    const dir = tmp();
    const [a, b, c] = files(dir);
    const zip = path.join(dir, "out.zip");
    const res = await writeZip(zip, [
      { name: "root/a.txt", file: a, mtime: new Date() },
      { name: "root/b.mov", file: b, mtime: new Date() },
      { name: "root/empty.dat", file: c, mtime: new Date() },
      { name: "root/note.txt", data: Buffer.from("note ü"), mtime: new Date() },
    ]);
    expect(res).toMatchObject({ entries: 4, zip64: false });
    const dirInfo = await readZipDirectory(zip);
    const byName = Object.fromEntries(dirInfo.entries.map((e) => [e.name, e]));
    expect(byName["root/a.txt"].method).toBe(8);
    expect(byName["root/a.txt"].csize).toBeLessThan(byName["root/a.txt"].usize);
    expect(byName["root/b.mov"].method).toBe(0);
    expect(byName["root/note.txt"].crc).toBe(new Crc32().update(Buffer.from("note ü")).value);
    const expected = new Map([
      ["root/a.txt", { bytes: 50_000, sha1: sha1(fs.readFileSync(a)) }],
      ["root/b.mov", { bytes: 20_000, sha1: sha1(fs.readFileSync(b)) }],
    ]);
    expect(await verifyZip(zip, expected)).toMatchObject({ ok: true, entries: 4, errors: [] });
  });

  it("writes ZIP64 records and reads them back", async () => {
    const dir = tmp();
    const [a, b] = files(dir);
    const zip = path.join(dir, "z64.zip");
    const res = await writeZip(zip, [{ name: "a.txt", file: a, mtime: new Date() }, { name: "b.mov", file: b, mtime: new Date() }], { forceZip64: true });
    expect(res.zip64).toBe(true);
    const info = await readZipDirectory(zip);
    expect(info.zip64).toBe(true);
    expect(info.entries.map((e) => e.usize)).toEqual([50_000, 20_000]);
    expect((await verifyZip(zip)).ok).toBe(true);
  });

  it("catches a corrupted entry and a missing one", async () => {
    const dir = tmp();
    const [a, b] = files(dir);
    const zip = path.join(dir, "bad.zip");
    await writeZip(zip, [{ name: "a.txt", file: a, mtime: new Date() }, { name: "b.mov", file: b, mtime: new Date() }]);
    const entry = (await readZipDirectory(zip)).entries.find((e) => e.name === "b.mov")!;
    const buf = fs.readFileSync(zip);
    buf[entry.offset + 30 + 5 + 100] ^= 0xff; // a byte inside b.mov's stored data
    fs.writeFileSync(zip, buf);
    const v = await verifyZip(zip, new Map([["gone.txt", { bytes: 1, sha1: null }]]));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("b.mov") && /CRC32/.test(e))).toBe(true);
    expect(v.errors.some((e) => e.startsWith("gone.txt"))).toBe(true);
  });

  it("says so for a file that isn't a zip", async () => {
    const dir = tmp();
    const p = path.join(dir, "x.zip");
    fs.writeFileSync(p, "not a zip at all");
    expect((await verifyZip(p)).ok).toBe(false);
  });
});

describe("manifest helpers", () => {
  const manifest = (over: Partial<Manifest> = {}): Manifest => ({
    version: 1,
    created: "t",
    updated: "t",
    complete: true,
    project: { path: "C:/p/Show.aep", name: "Show.aep" },
    ae: null,
    options: { only_used: false, include_proxies: true },
    relinked: false,
    sources: [
      { role: "main", sequence: false, ae_files: ["C:/m/a.mov"], item_ids: [1], dest_first: "_Footage/a.mov" },
      { role: "main", sequence: true, ae_files: ["C:/s/f.0002.exr", "C:/s/f.0003.exr"], item_ids: [2, 3], dest_first: "_Footage/s/f.0001.exr" },
      { role: "proxy", sequence: false, ae_files: ["C:/m/p.mov"], item_ids: [1], dest_first: "" },
    ],
    files: [
      { source: "C:/m/a.mov", path: "_Footage/a.mov", bytes: 10, mtime_ms: 1, sha1: "x", role: "main", item_ids: [1] },
      { source: "C:/p/Show.aep", path: "Show.aep", bytes: 5, mtime_ms: 1, sha1: "y", role: "project", item_ids: [] },
    ],
    not_collected: [],
    ...over,
  });

  it("maps every path AE reports to its collected file, skipping sources with nothing collected", () => {
    const m = buildMappings(manifest(), path.join("D:", "out"));
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ from: "C:/m/a.mov", to: path.join("D:", "out", "_Footage", "a.mov"), sequence: false, role: "main", item_ids: [1] });
    expect(m[1].item_ids).toEqual([2, 3]);
    expect(m[1].to).toBe(m[2].to);
    expect(m[1].sequence).toBe(true);
  });

  it("diffs a collect against the last one, leaving the .aep out", () => {
    const d = diffManifests(manifest(), [
      { source: "C:/m/a.mov", bytes: 11 },
      { source: "C:/m/new.mov", bytes: 1 },
    ]);
    expect(d).toEqual({ added: ["C:/m/new.mov"], removed: [], changed: ["C:/m/a.mov"] });
    expect(diffManifests(null, [])).toBeNull();
  });

  it("flags what a relink left wrong", () => {
    const relink = { project_path: "x", relinked: 3, proxies_relinked: 0, removed_unused: null, reduced: null, errors: [], errors_total: 0 };
    const original = "C:/p/Show.aep";
    expect(relinkMismatches(original, { num_items: 9 }, { project_path: original, dirty: false, num_items: 9 }, { phaseError: null, restoreError: null, relink, trimmed: false })).toEqual([]);
    const bad = relinkMismatches(original, { num_items: 9 }, { project_path: "C:/out/Show.aep", dirty: true, num_items: 8 }, { phaseError: "boom", restoreError: "no", relink: { ...relink, errors_total: 2 }, trimmed: false });
    expect(bad.map((x) => x.path).sort()).toEqual(["dirty", "num_items", "project_path", "relink", "relink.errors", "reopen"]);
    // A trimmed copy doesn't change the original's item count: a changed original is a mismatch.
    const trimmed = relinkMismatches(original, { num_items: 9 }, { project_path: original, dirty: false, num_items: 4 }, { phaseError: null, restoreError: null, relink, trimmed: true });
    expect(trimmed.map((x) => x.path)).toEqual(["num_items"]);
    expect(relinkMismatches(original, { num_items: 9 }, { project_path: original, dirty: false, num_items: 9 }, { phaseError: null, restoreError: null, relink, trimmed: true })).toEqual([]);
  });

  describe("verifyItemMismatches", () => {
    const item = { item_id: 1, name: "Plate", to: "D:/out/a.mov", sequence: false, proxy_to: "D:/out/p.mov", proxy_sequence: false, use_proxy: true };
    const relink = (items: any[]) => ({ project_path: "x", relinked: items.length, proxies_relinked: 0, removed_unused: null, reduced: null, errors: [], errors_total: 0, items });
    const good = { item_id: 1, found: true, name: "Plate", file: "D:\\out\\a.mov", proxy_file: "D:\\out\\p.mov", use_proxy: true };
    const verify = (checks: any[]) => ({ checked: 1, pointing_at_collected: 1, elsewhere: [], item_checks: checks });

    it("passes when every item reads back as intended (paths compared across slashes)", () => {
      expect(verifyItemMismatches(relink([item]), verify([good]), false)).toEqual([]);
    });

    it("flags an item still on the old file, a changed name, a proxy not relinked and a flipped proxy switch", () => {
      const m = verifyItemMismatches(relink([item]), verify([{ ...good, file: "D:/old/a.mov", name: "a.mov", proxy_file: "D:/old/p.mov", use_proxy: false }]), false);
      expect(m.map((x) => x.path).sort()).toEqual(["items.1.file", "items.1.name", "items.1.proxy", "items.1.use_proxy"]);
    });

    it("compares a sequence by its folder, and skips items a trim removed", () => {
      const seq = { ...item, item_id: 2, name: "Seq", to: "D:/out/s/f.0001.exr", sequence: true, proxy_to: null };
      const checks = [{ ...good, item_id: 2, name: "Seq", file: "D:/out/s/f.0007.exr", proxy_file: null }, { item_id: 1, found: false, name: null, file: null, proxy_file: null, use_proxy: null }];
      expect(verifyItemMismatches(relink([item, seq]), verify(checks), true)).toEqual([]);
      expect(verifyItemMismatches(relink([item, seq]), verify(checks), false).map((x) => x.path)).toEqual(["items.1"]);
    });

    it("says so when the relink gave no per-item results or the read-back lacks an item", () => {
      expect(verifyItemMismatches({ ...relink([]), relinked: 3 }, verify([]), false)[0].path).toBe("verify");
      expect(verifyItemMismatches(relink([item]), verify([]), false)[0].path).toBe("items.1");
    });

    it("flags a collected item the relink never touched, unless the host listed it as failed", () => {
      const expected = { main: [1, 2, 3], proxy: [1, 4] };
      const itemTwo = { ...item, item_id: 2, name: "Two", to: "D:/out/b.mov", proxy_to: null };
      const checks = [good, { ...good, item_id: 2, name: "Two", file: "D:/out/b.mov", proxy_file: null }];
      const m = verifyItemMismatches(relink([item, itemTwo]), verify(checks), false, expected);
      expect(m.map((x) => x.path).sort()).toEqual(["items.3.missing", "items.4.proxy_missing"]);
      const withErrors = { ...relink([item, itemTwo]), errors: [{ item_id: 3, name: "Three", role: "layered", message: "by hand" }, { item_id: 4, name: "Four", role: "proxy", message: "no" }], errors_total: 2 };
      expect(verifyItemMismatches(withErrors, verify(checks), false, expected)).toEqual([]);
      // A truncated list can't be compared: only the truncation is reported.
      expect(verifyItemMismatches({ ...relink([item]), items_truncated: true }, verify([good]), false, expected).map((x) => x.path)).toEqual(["verify.items"]);
    });

    it("works out the expected ids from the manifest: sources with a collected file only", () => {
      const m = {
        sources: [
          { role: "main", sequence: false, ae_files: [], item_ids: [1, 2], dest_first: "a" },
          { role: "main", sequence: false, ae_files: [], item_ids: [9], dest_first: "" },
          { role: "proxy", sequence: false, ae_files: [], item_ids: [1], dest_first: "p" },
        ],
      } as unknown as Manifest;
      expect(expectedRelink(m)).toEqual({ main: [1, 2], proxy: [1] });
    });

    it("caps the list and counts the rest", () => {
      const items = Array.from({ length: 60 }, (_, i) => ({ ...item, item_id: i + 1, proxy_to: null }));
      const checks = items.map((x) => ({ ...good, item_id: x.item_id, file: "D:/old.mov", proxy_file: null }));
      const m = verifyItemMismatches(relink(items), verify(checks), false);
      expect(m).toHaveLength(51);
      expect(m[50]).toMatchObject({ path: "items", actual: 60 });
    });
  });
});

describe("report", () => {
  const base = (over: Partial<VersionReport> = {}): VersionReport => ({
    generated: "2026-11-03T10:00:00.000Z",
    project: { path: "C:/p/Show.aep", name: "Show.aep", bytes: 2048, mtime: "2026-11-03T09:00:00.000Z" },
    ae: { version: "26.2.1", build_number: 77, os: "Windows 11" },
    comps: [{ id: 1, name: "Main", width: 1920, height: 1080, fps: 25, duration: 10, num_layers: 3 }],
    comps_truncated: false,
    footage: [{ item_id: 1, name: "plate.mov", file: "C:/m/plate.mov", bin: [], sequence: false, missing: false, used_in: 2, bytes: 5000, proxy: null }],
    footage_truncated: false,
    fonts: [{ font: "ArialMT", uses: 2, missing: false }],
    effects: [{ match_name: "ADBE Gaussian Blur 2", name: "Gaussian Blur", count: 2 }],
    expressions: { count: 4, truncated: false },
    render_outputs: [{ comp: "Main", status: "DONE", output_module: "Lossless", file: "C:/r/main.mov", exists: true, bytes: 100, mtime: null, newer_than_project: false, sha1: "abc" }],
    checkpoints: { dir: "C:/p/_mcp_checkpoints", count: 2, latest: ["a.aep"] },
    collect: null,
    not_collected: ["Fonts"],
    changes_since_last_report: null,
    ...over,
  });

  it("renders a delivery note", () => {
    const md = renderReportMarkdown(base());
    expect(md).toContain("# Show.aep - delivery note");
    expect(md).toContain("After Effects 26.2.1 (build 77)");
    expect(md).toContain("| Main | 1920x1080 | 25 | 10.00 s | 3 |");
    expect(md).toContain("sha1 abc");
    expect(md).toContain("older than the saved project");
    expect(md).toContain("Expressions: 4");
  });

  it("diffs against the last report", () => {
    const prev = base({ footage: [], comps: [{ id: 9, name: "Old", width: 1, height: 1, fps: 1, duration: 1, num_layers: 0 }] });
    const d = diffReports(prev, base()) as Record<string, unknown>;
    expect(d.footage_added).toEqual(["C:/m/plate.mov"]);
    expect(d.comps_added).toEqual(["Main"]);
    expect(d.comps_removed).toEqual(["Old"]);
    expect(diffReports(null, base())).toBeNull();
  });
});

// ---------- the tools, over a fake bridge ----------

describe("ae_collect_files", () => {
  it("does a dry run by default and touches neither AE nor the disk", async () => {
    const s = makeScene();
    const { ctx, calls } = fakeAe(s.handlers);
    const out: any = await tool("ae_collect_files").handler(AeCollectFilesSchema.parse({ dest: s.dest, expect: expectArg(s) }), ctx);
    expect(out).toMatchObject({ dry_run: true, files: 7, bytes: 8200, problems_total: 1, shared_files_total: 1, solids: 1 });
    expect(out.total_bytes).toBe(8200 + 3000);
    expect(out.placeholders).toHaveLength(1);
    expect(out.sequences_with_gaps).toHaveLength(1);
    expect(out.not_collected.length).toBeGreaterThan(0);
    expect(fs.existsSync(s.dest)).toBe(false);
    expect(calls.every((c) => ["collectState", "collectFootage"].includes(c.fn))).toBe(true);
  });

  it("refuses an unsaved or dirty project, a wrong guard, and the project's own folder", async () => {
    const s = makeScene();
    const dirty = fakeAe({ ...s.handlers, collectState: () => ({ project_path: s.aep, saved: true, dirty: true, num_items: 1, ae: {} }), collectFootage: () => ({ project_path: s.aep, dirty: true, total: 0, next_offset: null, items: [], no_file: [] }) });
    expect(await tool("ae_collect_files").handler({}, dirty.ctx)).toMatchObject({ ok: false, error: "bad_args" });
    const unsaved = fakeAe({ ...s.handlers, collectState: () => ({ project_path: "<unsaved>", saved: false, dirty: false, num_items: 1, ae: {} }) });
    expect(await tool("ae_collect_files").handler({}, unsaved.ctx)).toMatchObject({ ok: false });
    const open = fakeAe(s.handlers);
    await expect(tool("ae_collect_files").handler({ expect: { project_path: "C:/other.aep" } }, open.ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(await tool("ae_collect_files").handler({ dest: path.dirname(s.aep), dry_run: false }, open.ctx)).toMatchObject({ ok: false });
  });

  it("copies with a sha1 manifest, resumes, and heals a deleted file", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const run = (extra: Record<string, unknown> = {}) => tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none", ...extra }, ctx) as Promise<any>;
    const first = await run();
    expect(first).toMatchObject({ complete: true, copied_files: 7, resumed_files: 0, errors_total: 0, files_total: 7 });
    expect(fs.readFileSync(path.join(s.dest, "_Footage", "Plates", "plate.mov"))).toEqual(bytesOf(5000, "mov"));
    expect(fs.existsSync(path.join(s.dest, "Show.aep"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.complete).toBe(true);
    const plate = manifest.files.find((f) => f.path === "_Footage/Plates/plate.mov")!;
    expect(plate.sha1).toBe(sha1(bytesOf(5000, "mov")));
    expect(manifest.files.find((f) => f.role === "project")?.sha1).toBe(sha1(fs.readFileSync(s.aep)));
    expect(manifest.sources.find((x) => x.sequence)?.ae_files).toEqual([s.entries[2].file]);
    expect(fs.readdirSync(path.join(s.dest, "_Footage", "Plates")).some((n) => n.endsWith(".part"))).toBe(false);

    const second = await run();
    expect(second).toMatchObject({ complete: true, copied_files: 0, resumed_files: 7 });
    fs.rmSync(path.join(s.dest, "_Footage", "shot_v001", "shot_v001.0003.exr"));
    const third = await run();
    expect(third).toMatchObject({ copied_files: 1, resumed_files: 6, complete: true });
    expect(third.changes_since_last_collect).toEqual({ added: [], removed: [], changed: [] });
  });

  it("reports files that can't be written as errors and finishes the rest", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    // A first collect, then a file where the Plates folder should go: the two files in that bin can't be created.
    await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx);
    fs.rmSync(path.join(s.dest, "_Footage", "Plates"), { recursive: true });
    fs.writeFileSync(path.join(s.dest, "_Footage", "Plates"), "in the way");
    const out: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx);
    expect(out.complete).toBe(false);
    expect(out.errors_total).toBe(2);
    expect(out.errors.map((e: any) => e.path).sort()).toEqual(["_Footage/Plates/logo.png", "_Footage/Plates/plate.mov"]);
    expect(out.files_done).toBe(5);
    expect(out.remaining).toBe(0);
    expect(out.next).toMatch(/failed/);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).complete).toBe(false);
    fs.rmSync(path.join(s.dest, "_Footage", "Plates"));
    const again: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx);
    expect(again).toMatchObject({ complete: true, copied_files: 2, resumed_files: 5 });
  });

  it("writes a verified zip and the report when complete", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const out: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, zip: true }, ctx);
    expect(out.complete).toBe(true);
    expect(out.zip).toMatchObject({ ok: true, verified: true, verify_errors: [] });
    expect(out.report.path).toBe(path.join(s.dest, "collect-report.md"));
    const names = (await readZipDirectory(`${s.dest}.zip`)).entries.map((e) => e.name);
    expect(names).toContain("_collect/_Footage/Plates/plate.mov");
    expect(names).toContain("_collect/Show.aep");
    expect(names).toContain("_collect/manifest.json");
    expect(fs.readFileSync(path.join(s.dest, "collect-report.md"), "utf8")).toContain("delivery note");
  });

  it("does not write a zip again that already verified against the same manifest, and rewrites it when a file changed", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const run = () => tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, zip: true, report: "none" }, ctx) as Promise<any>;
    const first = await run();
    expect(first.zip).toMatchObject({ ok: true, verified: true });
    expect(first.zip.up_to_date).toBeUndefined();
    const zipPath = `${s.dest}.zip`;
    const when = new Date(Date.now() - 3_600_000);
    fs.utimesSync(zipPath, when, when);
    const second = await run();
    expect(second.zip).toMatchObject({ ok: true, verified: true, up_to_date: true });
    expect(Math.abs(fs.statSync(zipPath).mtimeMs - when.getTime())).toBeLessThan(2000);
    // A source file changed: the next call copies it and writes the zip again.
    fs.writeFileSync(path.join(s.root, "media", "logo.png"), bytesOf(701, "png"));
    const third = await run();
    expect(third.zip).toMatchObject({ ok: true, verified: true });
    expect(third.zip.up_to_date).toBeUndefined();
    expect(fs.statSync(zipPath).mtimeMs).toBeGreaterThan(when.getTime() + 60_000);
  });

  it("stamps a zip by the files and hashes in the manifest", () => {
    const m = { files: [{ path: "b", bytes: 1, sha1: "x" }, { path: "a", bytes: 2, sha1: "y" }] } as unknown as Manifest;
    const swapped = { files: [...m.files].reverse() } as unknown as Manifest;
    expect(zipStamp(m)).toBe(zipStamp(swapped));
    expect(zipStamp(m)).not.toBe(zipStamp({ files: [{ path: "b", bytes: 1, sha1: "z" }, m.files[1]] } as unknown as Manifest));
  });

  it("refuses a relative dest (schema and direct call)", async () => {
    expect(AeCollectFilesSchema.safeParse({ dest: "out/_collect" }).success).toBe(false);
    expect(AeCollectRelinkSchema.safeParse({ dest: "out", confirm_close_project: true, expect: { project_path: "C:/a.aep" } }).success).toBe(false);
    expect(AeCollectReportSchema.safeParse({ dest: "out" }).success).toBe(false);
    expect(AeCollectFilesSchema.safeParse({ dest: path.join(os.tmpdir(), "x") }).success).toBe(true);
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    expect(await tool("ae_collect_files").handler({ dest: "out/_collect", dry_run: false }, ctx)).toMatchObject({ ok: false, message: expect.stringContaining("absolute") });
    expect(await tool("ae_collect_report").handler({ dest: "out" }, ctx)).toMatchObject({ ok: false, message: expect.stringContaining("absolute") });
  });

  it("will not write into a folder that is not a previous collect, and warns in the dry run", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    fs.mkdirSync(s.dest, { recursive: true });
    const old = path.join(s.dest, "Show.aep");
    fs.writeFileSync(old, "an older version the user keeps here");
    const refused: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx);
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("no manifest.json") });
    expect(fs.readFileSync(old, "utf8")).toBe("an older version the user keeps here");
    expect(fs.existsSync(path.join(s.dest, "_Footage"))).toBe(false);
    const dry: any = await tool("ae_collect_files").handler({ dest: s.dest }, ctx);
    expect(dry.dry_run).toBe(true);
    expect(dry.warnings.some((w: string) => /no manifest\.json/.test(w))).toBe(true);
    // A folder that holds a collect of another project is refused as well.
    const other = makeScene();
    const o = fakeAe(other.handlers);
    await tool("ae_collect_files").handler({ dest: other.dest, dry_run: false, report: "none" }, o.ctx);
    const wrong = fakeAe({ ...s.handlers, collectState: () => ({ project_path: s.aep, saved: true, dirty: false, num_items: 9, ae: {} }) });
    const manifestPath = path.join(other.dest, "manifest.json");
    const mm = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mm.project.path = path.join(other.root, "elsewhere", "Other.aep");
    fs.writeFileSync(manifestPath, JSON.stringify(mm));
    expect(await tool("ae_collect_files").handler({ dest: other.dest, dry_run: false }, wrong.ctx)).toMatchObject({ ok: false, message: expect.stringContaining("not of this project") });
  });

  it("leaves a file alone that a previous collect did not put there, and reports the conflict", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const run = () => tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx) as Promise<any>;
    await run();
    const mine = path.join(s.dest, "_Footage", "Plates", "logo.png");
    // The user's own file replaces ours, with a different size; and a new unrelated file sits where a new source will go.
    fs.rmSync(mine);
    fs.writeFileSync(mine, "the user's own logo");
    const manifestFile = path.join(s.dest, "manifest.json");
    const mf = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
    mf.files.find((f) => f.path === "_Footage/Plates/logo.png")!.sha1 = null;
    fs.writeFileSync(manifestFile, JSON.stringify(mf));
    const out = await run();
    expect(out.complete).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ path: "_Footage/Plates/logo.png", message: expect.stringContaining("conflict") });
    expect(fs.readFileSync(mine, "utf8")).toBe("the user's own logo");
    // The manifest written after the conflict does not claim the file either.
    const again = await run();
    expect(again.errors).toHaveLength(1);
    expect(fs.readFileSync(mine, "utf8")).toBe("the user's own logo");
  });

  it("lists missing footage and items with no path in the dry run", async () => {
    const s = makeScene();
    s.handlers.collectFootage = () => ({
      project_path: s.aep,
      dirty: false,
      offset: 0,
      total: 2,
      next_offset: null,
      items: [{ item_id: 4, name: "gone.mov", file: path.join(s.root, "media", "gone.mov"), sequence: false, missing: true, used_in: 1, bin: [], proxy: null }],
      no_file: [
        { item_id: 8, name: "Black Solid", kind: "solid" },
        { item_id: 9, name: "Placeholder", kind: "placeholder" },
        { item_id: 10, name: "Mystery", kind: "none" },
      ],
    });
    const { ctx } = fakeAe(s.handlers);
    const out: any = await tool("ae_collect_files").handler({ dest: s.dest }, ctx);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatchObject({ item_ids: [4], problem: "the file is not on disk" });
    expect(out.no_file_items).toEqual([{ item_id: 10, name: "Mystery", kind: "none" }]);
    expect(out.no_file_items_total).toBe(1);
    expect(out.placeholders_total).toBe(1);
    expect(out.warnings.some((w: string) => /no file path/.test(w))).toBe(true);
  });

  it("refuses a project when AE would not say whether it is dirty", async () => {
    const s = makeScene();
    const { ctx } = fakeAe({ ...s.handlers, collectState: () => ({ project_path: s.aep, saved: true, dirty: null, num_items: 1, ae: {} }) });
    expect(await tool("ae_collect_files").handler({ dest: s.dest }, ctx)).toMatchObject({ ok: false, message: expect.stringContaining("would not say") });
  });
});

describe("ae_collect_files: wave 3 fixes", () => {
  it("collects into the default folder after ae_collect_report wrote its report there", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const def = path.join(path.dirname(s.aep), "_collect");
    const rep: any = await tool("ae_collect_report").handler({}, ctx);
    expect(rep.written).toBe(path.join(def, "collect-report.md"));
    const out: any = await tool("ae_collect_files").handler({ dry_run: false, report: "none" }, ctx);
    expect(out).not.toMatchObject({ ok: false });
    expect(out).toMatchObject({ complete: true, dest: def });
    // A folder with something else in it is still refused.
    const other = path.join(s.root, "full");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "collect-report.md"), "x");
    fs.writeFileSync(path.join(other, "mine.txt"), "x");
    expect(await tool("ae_collect_files").handler({ dest: other, dry_run: false }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("leaves a zip it did not write alone and says so", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    fs.mkdirSync(path.dirname(s.dest), { recursive: true });
    fs.writeFileSync(`${s.dest}.zip`, "somebody elses delivery");
    const out: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, zip: true, report: "none" }, ctx);
    expect(out.complete).toBe(true);
    expect(out.zip).toMatchObject({ ok: false, status: "conflict" });
    expect(fs.readFileSync(`${s.dest}.zip`, "utf8")).toBe("somebody elses delivery");
    expect(fs.existsSync(`${s.dest}.zip.stamp`)).toBe(false);
    // Once it is moved away the zip is written, and later runs may replace their own.
    fs.rmSync(`${s.dest}.zip`);
    const next: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, zip: true, report: "none" }, ctx);
    expect(next.zip).toMatchObject({ ok: true, verified: true });
    fs.writeFileSync(path.join(s.root, "media", "logo.png"), bytesOf(701, "png"));
    const again: any = await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, zip: true, report: "none" }, ctx);
    expect(again.zip).toMatchObject({ ok: true, verified: true });
  });

  it("answers busy to a second copying call in the same folder, and frees the folder afterwards", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const run = () => tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, ctx) as Promise<any>;
    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(1);
    expect(results.filter((r) => r.complete === true)).toHaveLength(1);
    expect(await run()).toMatchObject({ complete: true });
  });

  it("keeps the report of the last delivery as the diff baseline when a call changes nothing", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const run = () => tool("ae_collect_files").handler({ dest: s.dest, dry_run: false }, ctx) as Promise<any>;
    const first = await run();
    expect(first.report.unchanged).toBeUndefined();
    const jsonPath = path.join(s.dest, "collect-report.json");
    const before = fs.readFileSync(jsonPath, "utf8");
    const second = await run();
    expect(second.report).toMatchObject({ unchanged: true });
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(before);
    // A footage file changed: the report is made again.
    fs.writeFileSync(path.join(s.root, "media", "logo.png"), bytesOf(701, "png"));
    const third = await run();
    expect(third.report.unchanged).toBeUndefined();
    expect(fs.readFileSync(jsonPath, "utf8")).not.toBe(before);
  });

  it("keeps a proxy-only comp entry with used_in 0 when only_used is set", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "comp_proxy.mov"), "proxy bytes");
    const entry: FootageEntry = { item_id: 31, name: "Comp 2", file: path.join(dir, "comp_proxy.mov"), sequence: false, missing: false, used_in: 0, bin: [], proxy: { file: path.join(dir, "comp_proxy.mov"), sequence: false, in_use: true }, proxy_only: true };
    const resolved = new Map<string, ResolvedSource>([[sourceKey(entry.file, false), await resolveSource(entry.file, false)]]);
    const plan = planCollect([entry], resolved, { only_used: true });
    expect(plan.skipped_unused).toBe(0);
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({ role: "proxy", item_ids: [31] });
  });

  it("plans the proxy of a comp as a proxy-only entry", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "comp_proxy.mov"), "proxy bytes");
    const entry: FootageEntry = { item_id: 30, name: "Comp 1", file: path.join(dir, "comp_proxy.mov"), sequence: false, missing: false, used_in: 1, bin: ["Comps"], proxy: { file: path.join(dir, "comp_proxy.mov"), sequence: false, in_use: true }, proxy_only: true };
    const resolved = new Map<string, ResolvedSource>([[sourceKey(entry.file, false), await resolveSource(entry.file, false)]]);
    const plan = planCollect([entry], resolved, {});
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({ role: "proxy", item_ids: [30], dest_first: "_Footage/_Proxies/Comps/comp_proxy.mov" });
    expect(plan.files.map((f) => f.path)).toEqual(["_Footage/_Proxies/Comps/comp_proxy.mov"]);
    expect(planCollect([entry], resolved, { include_proxies: false }).sources).toHaveLength(0);
  });
});

describe("ae_collect_report", () => {
  it("reports an image-sequence render output by its frames, not as missing", async () => {
    const s = makeScene();
    const out = path.join(s.root, "renders");
    fs.mkdirSync(out);
    for (const n of ["00001", "00002", "00003"]) fs.writeFileSync(path.join(out, `main_${n}.png`), bytesOf(100, n));
    fs.writeFileSync(path.join(out, "other_00001.png"), "x");
    const { ctx } = fakeAe({
      ...s.handlers,
      collectInfo: () => ({
        project_path: s.aep, dirty: false, ae: {}, num_items: 9, num_comps: 1, comps: [], comps_truncated: false, effects: [], expressions: { count: 0, truncated: false }, layers_capped: false, render_outputs_truncated: false,
        render_outputs: [
          { item: 1, comp: "Main", status: "DONE", output_module: "PNG", file: path.join(out, "main_[#####].png") },
          { item: 2, comp: "Main", status: "DONE", output_module: "PNG", file: path.join(out, "gone_[###].png") },
        ],
      }),
    });
    const res: any = await tool("ae_collect_report").handler({ dest: s.dest, format: "json", write: false }, ctx);
    expect(res.report.render_outputs[0]).toMatchObject({ exists: true, bytes: 300, frames: 3, sha1: null });
    expect(res.report.render_outputs[0].note).toMatch(/image sequence: 3 frame/);
    expect(res.report.render_outputs[1]).toMatchObject({ exists: false, frames: 0 });
    expect(res.report.render_outputs[1].note).toMatch(/no frames/);
  });

  it("builds and writes the report, then diffs against it", async () => {
    const s = makeScene();
    const { ctx } = fakeAe(s.handlers);
    const first: any = await tool("ae_collect_report").handler({ dest: s.dest }, ctx);
    expect(first.written).toBe(path.join(s.dest, "collect-report.md"));
    expect(first.markdown).toContain("Gaussian Blur");
    expect(first.markdown).toContain("ArialMT");
    expect(first.markdown).toContain("sha1 " + sha1(bytesOf(5000, "mov")));
    s.entries.push({ ...s.entries[4], item_id: 6, name: "new.png", file: path.join(s.root, "media", "logo.png") });
    s.entries.splice(3, 1);
    const second: any = await tool("ae_collect_report").handler({ dest: s.dest, format: "json", write: false }, ctx);
    expect(second.report.changes_since_last_report.footage_removed).toEqual([s.entries.length ? path.join(s.root, "media", "gone.mov") : ""]);
    expect(second.report.render_outputs[0]).toMatchObject({ exists: true, bytes: 5000 });
  });

  it("survives fontsInUse failing", async () => {
    const s = makeScene();
    const { ctx } = fakeAe({ ...s.handlers, fontsInUse: () => { throw new Error("no fonts here"); } });
    const out: any = await tool("ae_collect_report").handler({ dest: s.dest, write: false, format: "json" }, ctx);
    expect(out.report.fonts.error).toMatch(/Fonts could not be read/);
  });
});

describe("ae_collect_relink", () => {
  // What the relink of the scene's two relinkable items reports, and what a faithful read-back says about them.
  const relinked = (s: Scene) => [
    { item_id: 1, name: "plate.mov", to: path.join(s.dest, "_Footage", "Plates", "plate.mov"), sequence: false, proxy_to: path.join(s.dest, "_Footage", "_Proxies", "Plates", "plate_proxy.mov"), proxy_sequence: false, use_proxy: true },
    { item_id: 2, name: "plate again", to: path.join(s.dest, "_Footage", "Plates", "plate.mov"), sequence: false, proxy_to: null, proxy_sequence: false, use_proxy: false },
    { item_id: 3, name: "shot", to: path.join(s.dest, "_Footage", "shot_v001", "shot_v001.0001.exr"), sequence: true, proxy_to: null, proxy_sequence: false, use_proxy: false },
    { item_id: 5, name: "logo.png", to: path.join(s.dest, "_Footage", "Plates", "logo.png"), sequence: false, proxy_to: null, proxy_sequence: false, use_proxy: false },
  ];
  const echoChecks = (items: any[]) =>
    items.map((i) => ({ item_id: i.item_id, found: true, name: i.name, file: i.to, proxy_file: i.proxy_to, use_proxy: i.use_proxy }));

  async function collected(extraHandlers: Record<string, Handler> = {}) {
    const s = makeScene();
    const first = fakeAe(s.handlers);
    await tool("ae_collect_files").handler({ dest: s.dest, dry_run: false, report: "none" }, first.ctx);
    const switches: any[] = [];
    let open = s.aep;
    const handlers: Record<string, Handler> = {
      ...s.handlers,
      collectState: () => ({ project_path: open, saved: true, dirty: false, num_items: 9, ae: {} }),
      collectSwitch: (a) => {
        switches.push(a);
        open = a.to_path;
        return { closed: "x", saved: a.save_first === true, project_path: open, dirty: false, num_items: 9 };
      },
      collectRelink: () => ({ project_path: open, relinked: 4, proxies_relinked: 1, removed_unused: null, reduced: null, errors: [], errors_total: 0, items: relinked(s) }),
      // The copy reads back as the relink intended, except gone.mov, which was never collected.
      collectVerify: (a) => ({ project_path: open, dirty: false, checked: 4, pointing_at_collected: 3, elsewhere: [{ item_id: 4, name: "gone.mov", file: "x" }], elsewhere_total: 1, elsewhere_truncated: false, item_checks: echoChecks(a.items) }),
      ...extraHandlers,
    };
    const ae = fakeAe(handlers, { path: s.aep, dirty: false });
    return { s, ae, switches };
  }
  const args = (s: Scene, extra: Record<string, unknown> = {}) => AeCollectRelinkSchema.parse({ dest: s.dest, confirm_close_project: true, expect: expectArg(s), ...extra });

  it("opens the copy, relinks, reads back separately, and reopens the original", async () => {
    const { s, ae, switches } = await collected();
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(ae.calls.map((c) => c.fn)).toEqual(["checkGuard", "collectState", "collectSwitch", "collectRelink", "collectVerify", "collectSwitch", "collectState"]);
    expect(switches[0]).toMatchObject({ to_path: path.join(s.dest, "Show.aep"), expect_open: [s.aep] });
    expect(switches[0].save_first).toBeUndefined();
    expect(switches[1]).toMatchObject({ to_path: s.aep, save_first: true, discard_changes: false });
    const relinkCall = ae.calls.find((c) => c.fn === "collectRelink")!.args;
    expect(relinkCall.expect.project_path).toBe(path.join(s.dest, "Show.aep"));
    expect(relinkCall.mappings.length).toBe(4);
    expect(relinkCall.mappings.find((m: any) => m.role === "proxy").to).toBe(path.join(s.dest, "_Footage", "_Proxies", "Plates", "plate_proxy.mov"));
    expect(relinkCall.mappings.find((m: any) => m.sequence).to).toBe(path.join(s.dest, "_Footage", "shot_v001", "shot_v001.0001.exr"));
    expect(relinkCall.remove_unused).toBe(false);
    expect(out).toMatchObject({ applied: true, original_reopened: true, relinked: 4, proxies_relinked: 1 });
    expect(out.receipt.matches).toBe(true);
    expect(out.in_copy.elsewhere).toHaveLength(1);
    expect(out.in_copy).not.toHaveProperty("item_checks");
    expect(out).toMatchObject({ copy_saved: true });
    // The read-back asked about each relinked item.
    expect(ae.calls.find((c) => c.fn === "collectVerify")!.args.items).toHaveLength(4);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.relinked).toBe(true);
    // A relinked copy is not copied over by the next collect, and not relinked twice.
    expect(await tool("ae_collect_relink").handler(args(s), ae.ctx)).toMatchObject({ ok: false });
  });

  it("fails the receipt when the read-back disagrees with the relink, and keeps the manifest unrelinked", async () => {
    const { s, ae } = await collected({
      collectVerify: (a) => ({
        project_path: "x",
        dirty: false,
        checked: 4,
        pointing_at_collected: 3,
        elsewhere: [],
        item_checks: [
          // Item 1: still on the old file, renamed, and the proxy switch flipped.
          { item_id: 1, found: true, name: "plate.mov (copy)", file: "D:/old/plate.mov", proxy_file: "D:/old/plate_proxy.mov", use_proxy: false },
          ...echoChecks(a.items.slice(1)),
        ],
      }),
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(expect.arrayContaining(["items.1.file", "items.1.name", "items.1.proxy", "items.1.use_proxy"]));
    expect(out.original_reopened).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("fails the receipt when nothing was relinked in the copy at all", async () => {
    const { s, ae } = await collected({
      collectVerify: (a) => ({ project_path: "x", dirty: false, checked: 2, pointing_at_collected: 0, elsewhere: [], item_checks: a.items.map((i: any) => ({ item_id: i.item_id, found: true, name: i.name, file: "D:/old.mov", proxy_file: null, use_proxy: i.use_proxy })) }),
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => m.path === "items.1.file")).toBe(true);
  });

  it("does not claim a relinked copy that was never saved", async () => {
    const { s, ae } = await collected({
      collectSwitch: (a) => {
        if (a.to_path === s.aep) return { closed: "x", saved: false, project_path: s.aep, dirty: false, num_items: 9 };
        return { closed: "x", saved: false, project_path: a.to_path, dirty: false, num_items: 9 };
      },
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.copy_saved).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => m.path === "copy.saved")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("keeps a failed read-back apart from a failed relink, and discards the copy", async () => {
    const { s, ae, switches } = await collected({
      collectVerify: () => {
        throw new Error("read timed out");
      },
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths).toContain("read_back");
    expect(paths).not.toContain("relink");
    const readBack = out.receipt.mismatches.find((m: any) => m.path === "read_back");
    expect(readBack.message).toMatch(/discarded unsaved because it could not be verified/);
    expect(switches[1]).toMatchObject({ save_first: false, discard_changes: true });
    expect(out.relinked).toBe(4);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("refuses without a complete manifest, with unsaved changes, and for an unknown comp", async () => {
    const s = makeScene();
    const none = fakeAe(s.handlers, { path: s.aep, dirty: false });
    expect(await tool("ae_collect_relink").handler(args(s), none.ctx)).toMatchObject({ ok: false, message: expect.stringContaining("No manifest") });

    const { s: s2, ae } = await collected({ collectInfo: () => ({ comps: [{ id: 20, name: "Main" }], comps_truncated: false }) });
    expect(await tool("ae_collect_relink").handler(args(s2, { reduce_to_comp_ids: [99] }), ae.ctx)).toMatchObject({ ok: false, message: expect.stringContaining("No comp with id 99") });
    expect(ae.calls.some((c) => c.fn === "collectSwitch")).toBe(false);

    const dirty = fakeAe({ ...s2.handlers }, { path: s2.aep, dirty: true });
    expect(await tool("ae_collect_relink").handler(args(s2), dirty.ctx)).toMatchObject({ ok: false, message: expect.stringContaining("unsaved") });
    expect(dirty.calls.some((c) => c.fn === "collectSwitch")).toBe(false);
  });

  it("passes the trim options and a comp's name", async () => {
    const { s, ae } = await collected({ collectInfo: () => ({ comps: [{ id: 20, name: "Main" }], comps_truncated: false }) });
    const out: any = await tool("ae_collect_relink").handler(args(s, { remove_unused: true, reduce_to_comp_ids: [20] }), ae.ctx);
    const call = ae.calls.find((c) => c.fn === "collectRelink")!.args;
    expect(call).toMatchObject({ remove_unused: true, reduce_to: [{ id: 20, name: "Main" }] });
    expect(out.applied).toBe(true);
  });

  it("brings the original back without saving the copy when the relink fails", async () => {
    const { s, ae, switches } = await collected({
      collectRelink: () => {
        throw new Error("AE said no");
      },
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(switches).toHaveLength(2);
    expect(switches[1]).toMatchObject({ to_path: s.aep, save_first: false, discard_changes: true });
    expect(out.applied).toBe(true);
    expect(out.original_reopened).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("relink");
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("does not mark the copy relinked when the host left a collected item out of its result", async () => {
    const { s, ae } = await collected({
      // Item 5 (logo.png) is not found in the copy by id or path: the host skips it silently.
      collectRelink: () => ({ project_path: "x", relinked: 3, proxies_relinked: 1, removed_unused: null, reduced: null, errors: [], errors_total: 0, items: relinked(s).filter((i) => i.item_id !== 5) }),
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("items.5.missing");
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("does not mark the copy relinked when some item failed in the host", async () => {
    const { s, ae } = await collected({
      collectRelink: () => ({ project_path: "x", relinked: 4, proxies_relinked: 1, removed_unused: null, reduced: null, errors: [{ item_id: 99, name: "x", role: "trim", message: "reduceProject: nope" }], errors_total: 1, items: relinked(s) }),
    });
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.copy_saved).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("gives the host the item ids of each mapping, to find items by id in the copy", async () => {
    const { s, ae } = await collected();
    await tool("ae_collect_relink").handler(args(s), ae.ctx);
    const mappings = ae.calls.find((c) => c.fn === "collectRelink")!.args.mappings;
    expect(mappings.find((m: any) => m.role === "main" && !m.sequence && /plate\.mov$/.test(m.from)).item_ids).toEqual([1, 2]);
    expect(mappings.find((m: any) => m.role === "proxy").item_ids).toEqual([1]);
  });

  it("discards the copy and reopens the original when saving the copy throws", async () => {
    let open = "";
    const switches: any[] = [];
    const { s, ae } = await collected({
      collectState: () => ({ project_path: open, saved: true, dirty: false, num_items: 9, ae: {} }),
      collectSwitch: (a) => {
        switches.push(a);
        // The save-first switch back throws before it closes anything: the copy stays open.
        if (a.save_first === true) throw new Error("the destination is read-only");
        open = a.to_path;
        return { closed: "x", saved: false, project_path: open, dirty: false, num_items: 9 };
      },
    });
    open = s.aep;
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(switches.map((x) => [x.to_path === s.aep ? "original" : "copy", x.save_first === true, x.discard_changes === true])).toEqual([
      ["copy", false, false],
      ["original", true, false],
      ["original", false, true],
    ]);
    expect(out.original_reopened).toBe(true);
    expect(out.copy_saved).toBe(false);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths).toContain("copy.saved");
    expect(paths).not.toContain("reopen");
    expect(out.receipt.mismatches.find((m: any) => m.path === "copy.saved").message).toMatch(/read-only/);
    expect(JSON.parse(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8")).relinked).toBe(false);
  });

  it("marks the session as reopened once the first switch ran, also when it throws", async () => {
    const dir = tmp("chroma-collect-session-");
    try {
      const tracker = installSessionTracking({ dataDir: dir });
      const ok = await collected();
      expect(tracker.reopenedAt()).toBeNull();
      await tool("ae_collect_relink").handler(args(ok.s), ok.ae.ctx);
      expect(tracker.reopenedAt()).not.toBeNull();
    } finally {
      resetSessionTracking();
    }
    const dir2 = tmp("chroma-collect-session-");
    try {
      const tracker = installSessionTracking({ dataDir: dir2 });
      const refused = await collected({
        collectSwitch: () => {
          throw new Error("Refusing to close a project with unsaved changes");
        },
      });
      await expect(tool("ae_collect_relink").handler(args(refused.s), refused.ae.ctx)).rejects.toThrow(/unsaved changes/);
      expect(tracker.reopenedAt()).not.toBeNull();
    } finally {
      resetSessionTracking();
    }
  });

  it("rethrows when opening the copy was refused before anything closed, and reports a failed reopen", async () => {
    const refused = await collected({
      collectSwitch: () => {
        throw new Error("Refusing to close a project with unsaved changes");
      },
    });
    await expect(tool("ae_collect_relink").handler(args(refused.s), refused.ae.ctx)).rejects.toThrow(/unsaved changes/);
    expect(refused.ae.calls.filter((c) => c.fn === "collectSwitch")).toHaveLength(1);

    let n = 0;
    let open = "";
    const stuck = await collected();
    const s = stuck.s;
    const ae = fakeAe(
      {
        ...s.handlers,
        collectState: () => ({ project_path: n === 0 ? s.aep : open, saved: true, dirty: false, num_items: 9, ae: {} }),
        collectSwitch: (a) => {
          n++;
          if (a.to_path === s.aep) throw new Error("open failed");
          open = a.to_path;
          return { closed: "x", saved: false, project_path: open, dirty: false, num_items: 9 };
        },
        collectRelink: () => ({ project_path: open, relinked: 1, proxies_relinked: 0, removed_unused: null, reduced: null, errors: [], errors_total: 0 }),
        collectVerify: () => ({ project_path: open, dirty: false, checked: 1, pointing_at_collected: 1, elsewhere: [] }),
      },
      { path: s.aep, dirty: false }
    );
    const out: any = await tool("ae_collect_relink").handler(args(s), ae.ctx);
    expect(out.original_reopened).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => /could not be reopened/.test(m.message))).toBe(true);
  });
});

// ---------- the host functions under node:vm ----------

describe("collect.jsx", () => {
  const makeFootage = (project: FakeProject, name: string, file: string, folder?: any, opts: { isStill?: boolean } = {}) => {
    const f = project.addFootage(name, 10, 10, Object.assign(new FileSource(), { isStill: opts.isStill ?? true, file: { fsName: file } }), folder);
    f.file = { fsName: file };
    // replace() on a real item takes the name from the new file.
    const real = f as any;
    real.replace = (nf: { fsName: string }) => {
      real.file = { fsName: nf.fsName };
      real.name = path.basename(nf.fsName);
    };
    real.replaceWithSequence = (nf: { fsName: string }, force: boolean) => {
      real.sequenceForce = force;
      real.replace(nf);
    };
    return real as FakeFootage & Record<string, any>;
  };

  function scene() {
    const dir = tmp();
    const files = {
      a: path.join(dir, "a.mov"),
      aNew: path.join(dir, "new_a.mov"),
      b: path.join(dir, "b.png"),
      bNew: path.join(dir, "new_b.png"),
      p: path.join(dir, "a_prox.mov"),
      pNew: path.join(dir, "new_prox.mov"),
    };
    for (const f of Object.values(files)) fs.writeFileSync(f, "x");
    const project = new FakeProject();
    const bin = project.addFolder("Plates");
    const sub = project.addFolder("Deep", bin);
    const a = makeFootage(project, "Hero Plate", files.a, sub, { isStill: false });
    a.proxySource = { file: { fsName: files.p }, isStill: false };
    a.useProxy = false;
    a.setProxy = (f: { fsName: string }) => {
      a.proxySource = { file: { fsName: f.fsName }, isStill: false };
      a.useProxy = true;
    };
    const b = makeFootage(project, "Logo", files.b);
    project.addFootage("Solid 1", 10, 10, new SolidSource());
    const comp = project.addComp("Main");
    comp.layers.addSolid([0, 0, 0], "BG", 10, 10, 1);
    (comp.stack[0] as any).source = a;
    return { dir, files, project, a, b, comp };
  }

  it("collectState and collectFootage read the project without changing it", () => {
    const { project, files, a } = scene();
    const { A, G } = loadHost(project, ["collect.jsx"]);
    G.app.buildName = "Release";
    G.app.buildNumber = 77;
    project.file = { fsName: path.join(path.dirname(files.a), "Show.aep") };
    const s = A.collectState();
    expect(s).toMatchObject({ saved: true, dirty: false, ae: { version: "26.2.1", build_name: "Release", build_number: 77 } });
    const page = A.collectFootage({});
    expect(page.total).toBe(4);
    expect(page.items.map((i: any) => i.name)).toEqual(["Hero Plate", "Logo"]);
    expect(page.no_file.map((n: any) => [n.name, n.kind])).toEqual([["Solid 1", "solid"], ["BG", "solid"]]);
    const hero = page.items[0];
    expect(hero.bin).toEqual(["Plates", "Deep"]);
    expect(hero.sequence).toBe(false);
    expect(hero.proxy).toEqual({ file: files.p, sequence: false, in_use: false });
    expect(hero.used_in).toBe(1);
    expect(page.items[1].proxy).toBeNull();
    expect(a.useProxy).toBe(false);
    expect(project.dirty).toBe(false);
  });

  it("collectFootage lists an item AE reports as missing through missingFootagePath", () => {
    const { project, dir } = scene();
    const gone = path.join(dir, "gone.mov");
    const lost = project.addFootage("Lost", 10, 10, Object.assign(new FileSource(), { isStill: false, file: null, missingFootagePath: gone }));
    (lost as any).file = null;
    (lost as any).footageMissing = true;
    const mystery = project.addFootage("Mystery", 10, 10, Object.assign(new FileSource(), { isStill: false, file: null }));
    (mystery as any).file = null;
    const { A } = loadHost(project, ["collect.jsx"]);
    const page = A.collectFootage({});
    const entry = page.items.find((i: any) => i.name === "Lost");
    expect(entry).toMatchObject({ file: gone, missing: true, sequence: false });
    // Not missing and no path: reported as having no file, with its kind.
    expect(page.no_file.map((n: any) => [n.name, n.kind])).toContainEqual(["Mystery", "none"]);
    expect(page.no_file.map((n: any) => n.name)).not.toContain("Lost");
  });

  it("reads dirty as null when AE would not say", () => {
    const { project, files } = scene();
    const { A } = loadHost(project, ["collect.jsx"]);
    Object.defineProperty(project, "dirty", {
      get() {
        throw new Error("no");
      },
      configurable: true,
    });
    expect(A.collectState().dirty).toBeNull();
    expect(A.collectFootage({}).dirty).toBeNull();
    (project as any).file = { fsName: "C:/x/Orig.aep" };
    expect(() => A.collectSwitch({ to_path: files.a, expect_open: ["C:/x/Orig.aep"] })).toThrow(/unsaved changes/);
  });

  it("collectFootage pages by ordinal and treats a moving still-image file as a sequence", () => {
    const { project, dir } = scene();
    makeFootage(project, "frames", path.join(dir, "f.0001.exr"), undefined, { isStill: false });
    const { A } = loadHost(project, ["collect.jsx"]);
    const p1 = A.collectFootage({ offset: 0, limit: 3 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next_offset).toBe(3);
    const p2 = A.collectFootage({ offset: 3, limit: 3 });
    expect(p2.next_offset).toBeNull();
    expect(p2.items.map((i: any) => [i.name, i.sequence])).toEqual([["frames", true]]);
  });

  it("collectFootage reports a moving .c4d or .vob as a single file, not a sequence", () => {
    const { project, dir } = scene();
    makeFootage(project, "cineware", path.join(dir, "scene_v003.c4d"), undefined, { isStill: false });
    makeFootage(project, "dvd", path.join(dir, "VTS_01_1.VOB"), undefined, { isStill: false });
    const { A } = loadHost(project, ["collect.jsx"]);
    const res = A.collectFootage({ offset: 0, limit: 50 });
    const byName: any = {};
    for (const i of res.items) byName[i.name] = i.sequence;
    expect(byName.cineware).toBe(false);
    expect(byName.dvd).toBe(false);
  });

  it("collectRelink points items at the collected files, keeping names and the proxy switch", () => {
    const { project, files, a, b, comp } = scene();
    const { A, undo } = loadHost(project, ["collect.jsx"]);
    project.file = { fsName: path.join(path.dirname(files.a), "Copy.aep") };
    (project as any).removeUnusedFootage = () => 1;
    const res = A.collectRelink({
      expect: { project_path: project.file.fsName },
      mappings: [
        { from: files.a, to: files.aNew, sequence: false, role: "main" },
        { from: files.b, to: files.bNew, sequence: false, role: "main" },
        { from: files.p, to: files.pNew, sequence: false, role: "proxy" },
      ],
      remove_unused: true,
    });
    expect(res).toMatchObject({ relinked: 2, proxies_relinked: 1, removed_unused: 1, errors_total: 0 });
    expect(a.file.fsName).toBe(files.aNew);
    expect(a.name).toBe("Hero Plate");
    expect(b.name).toBe("Logo");
    expect(a.proxySource.file.fsName).toBe(files.pNew);
    expect(a.useProxy).toBe(false);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(comp.numLayers).toBe(1);
    // The result says what each relinked item should read back as.
    expect(res.items).toEqual([
      { item_id: a.id, name: "Hero Plate", to: files.aNew, sequence: false, proxy_to: files.pNew, proxy_sequence: false, use_proxy: false },
      { item_id: b.id, name: "Logo", to: files.bNew, sequence: false, proxy_to: null, proxy_sequence: false, use_proxy: false },
    ]);
    // Read back in a separate call.
    const v = A.collectVerify({ mappings: [{ from: files.a, to: files.aNew, sequence: false, role: "main" }, { from: files.b, to: files.bNew, sequence: false, role: "main" }] });
    expect(v).toMatchObject({ checked: 2, pointing_at_collected: 2, elsewhere: [], elsewhere_total: 0, elsewhere_truncated: false });
  });

  it("collectVerify reads each relinked item's name, file, proxy file and proxy switch", () => {
    const { project, files, a, b } = scene();
    const { A } = loadHost(project, ["collect.jsx"]);
    a.useProxy = true;
    const v = A.collectVerify({ mappings: [], items: [{ item_id: a.id }, { item_id: b.id }, { item_id: 999999 }] });
    expect(v.item_checks).toEqual([
      { item_id: a.id, found: true, name: "Hero Plate", file: files.a, proxy_file: files.p, use_proxy: true },
      { item_id: b.id, found: true, name: "Logo", file: files.b, proxy_file: null, use_proxy: false },
      { item_id: 999999, found: false, name: null, file: null, proxy_file: null, use_proxy: null },
    ]);
    expect(v.elsewhere_total).toBe(2);
    expect(v.elsewhere_truncated).toBe(false);
    expect(project.dirty).toBe(false);
  });

  it("collectVerify says when its elsewhere list was cut", () => {
    const { project, dir } = scene();
    for (let i = 0; i < 510; i++) makeFootage(project, `f${i}`, path.join(dir, `f${i}.mov`), undefined, { isStill: false });
    const { A } = loadHost(project, ["collect.jsx"]);
    const v = A.collectVerify({ mappings: [] });
    expect(v.elsewhere).toHaveLength(500);
    expect(v.elsewhere_total).toBe(512);
    expect(v.elsewhere_truncated).toBe(true);
  });

  it("collectRelink reports a replace() that was silently a no-op through the verify read-back", () => {
    const { project, files, a } = scene();
    const { A } = loadHost(project, ["collect.jsx"]);
    a.replace = () => undefined;
    const res = A.collectRelink({ expect: GUARD, mappings: [{ from: files.a, to: files.aNew, sequence: false, role: "main" }] });
    expect(res.relinked).toBe(1);
    const v = A.collectVerify({ mappings: [{ from: files.a, to: files.aNew, sequence: false, role: "main" }], items: res.items });
    expect(verifyItemMismatches(res as any, v as any, false).map((m) => m.path)).toEqual(["items." + a.id + ".file"]);
  });

  it("collectRelink replaces sequences as sequences, numbered, and keeps a proxy that was on", () => {
    const { project, dir } = scene();
    const seq = makeFootage(project, "Shot", path.join(dir, "s.0002.exr"), undefined, { isStill: false });
    fs.writeFileSync(path.join(dir, "s.0002.exr"), "x");
    fs.writeFileSync(path.join(dir, "n.0001.exr"), "x");
    seq.proxySource = { file: { fsName: path.join(dir, "a_prox.mov") }, isStill: false };
    seq.useProxy = true;
    seq.setProxy = () => {
      seq.useProxy = true;
    };
    seq.setProxyWithSequence = (_f: unknown, force: boolean) => {
      seq.proxyForce = force;
      seq.useProxy = true;
    };
    const { A } = loadHost(project, ["collect.jsx"]);
    const res = A.collectRelink({
      expect: GUARD,
      mappings: [
        { from: path.join(dir, "s.0002.exr"), to: path.join(dir, "n.0001.exr"), sequence: true, role: "main" },
        { from: path.join(dir, "a_prox.mov"), to: path.join(dir, "n.0001.exr"), sequence: true, role: "proxy" },
      ],
    });
    expect(res.relinked).toBe(1);
    expect(seq.sequenceForce).toBe(false);
    expect(seq.name).toBe("Shot");
    expect(seq.proxyForce).toBe(false);
    expect(res.proxies_relinked).toBeGreaterThanOrEqual(1);
    expect(seq.useProxy).toBe(true);
  });

  it("collectRelink validates before changing anything and collects per-item errors", () => {
    const { project, files, a } = scene();
    const { A, undo } = loadHost(project, ["collect.jsx"]);
    const map = (to: string) => [{ from: files.a, to, sequence: false, role: "main" }];
    expect(() => A.collectRelink({ expect: { project_path: "C:/other.aep" }, mappings: map(files.aNew) })).toThrow(/Target guard refused/);
    expect(() => A.collectRelink({ expect: GUARD, mappings: map(path.join(path.dirname(files.a), "missing.mov")) })).toThrow(/does not exist/);
    expect(() => A.collectRelink({ expect: GUARD, mappings: [{ from: files.a, to: files.aNew, sequence: false, role: "other" }] })).toThrow(/role/);
    expect(() => A.collectRelink({ expect: GUARD, mappings: map(files.aNew), reduce_to: [{ id: 999999, name: "Nope" }] })).toThrow(/no comp/);
    expect(a.file.fsName).toBe(files.a);
    expect(undo.begun).toBe(0);
    a.replace = () => {
      throw new Error("replace failed");
    };
    const res = A.collectRelink({ expect: GUARD, mappings: map(files.aNew) });
    expect(res).toMatchObject({ relinked: 0, errors_total: 1 });
    expect(res.errors[0]).toMatchObject({ role: "main", name: "Hero Plate", message: "replace failed" });
    expect(undo.ended).toBe(1);
  });

  it("collectSwitch closes without prompting, saves first only when asked, and checks what is open", () => {
    const { project, dir } = scene();
    const other = new FakeProject();
    other.file = { fsName: path.join(dir, "Copy.aep") };
    fs.writeFileSync(path.join(dir, "Copy.aep"), "x");
    project.file = { fsName: path.join(dir, "Orig.aep") };
    const { A, G } = loadHost(project, ["collect.jsx"]);
    G.CloseOptions = { DO_NOT_SAVE_CHANGES: 11, PROMPT_TO_SAVE_CHANGES: 12 };
    const log: string[] = [];
    (project as any).close = (opt: number) => log.push(`close ${opt}`);
    (project as any).save = () => log.push("save");
    G.app.open = () => {
      G.app.project = other;
    };
    const to = path.join(dir, "Copy.aep");
    expect(() => A.collectSwitch({ to_path: to, expect_open: [path.join(dir, "Else.aep")] })).toThrow(/not the one this switch expects/);
    expect(() => A.collectSwitch({ to_path: to })).toThrow(/expect_open/);
    expect(() => A.collectSwitch({ to_path: path.join(dir, "nope.aep"), expect_open: [project.file!.fsName] })).toThrow(/does not exist/);
    project.dirty = true;
    expect(() => A.collectSwitch({ to_path: to, expect_open: [project.file!.fsName] })).toThrow(/unsaved changes/);
    expect(log).toEqual([]);
    const res = A.collectSwitch({ to_path: to, expect_open: [project.file!.fsName.toUpperCase()], save_first: true });
    expect(log).toEqual(["save", "close 11"]);
    expect(res).toMatchObject({ saved: true, project_path: other.file!.fsName });
  });

  it("collectInfo names the render queue status and says when the effects list was cut", () => {
    const { project, comp, files } = scene() as any;
    const { A, G } = loadHost(project, ["collect.jsx"]);
    G.RQItemStatus = { WILL_CONTINUE: 3010, NEEDS_OUTPUT: 3011, UNQUEUED: 3012, QUEUED: 3013, RENDERING: 3014, USER_STOPPED: 3015, ERR_STOPPED: 3016, DONE: 3017 };
    const item = project.renderQueue.items.add(comp as any);
    (item as any).numOutputModules = 1;
    (item as any).status = 3017;
    (item as any).outputModule = () => ({ file: { fsName: "C:/r/main.mov" }, name: "Lossless" });
    const q = project.renderQueue.items.add(comp as any);
    (q as any).numOutputModules = 1;
    (q as any).status = 4242;
    (q as any).outputModule = () => ({ file: null, name: "x" });
    const effects = comp.stack[0].property("ADBE Effect Parade") as any;
    for (let i = 0; i < 505; i++) effects.props.push({ name: `Fx ${i}`, matchName: `ADBE Fx ${i}` });
    const info = A.collectInfo({});
    expect(info.render_outputs.map((o: any) => o.status)).toEqual(["DONE", "4242"]);
    expect(info.effects).toHaveLength(500);
    expect(info.effects_total).toBe(505);
    expect(info.effects_truncated).toBe(true);
    void files;
  });

  it("collectFootage calls a moving source a sequence when its extension is a known image format, or unknown with a frame number in the name", () => {
    const { project, dir } = scene();
    const names = ["a.0001.sgi", "b.0001.dng", "c.0001.jp2", "d.0001.pct", "e.0001.cr2", "f.mp4", "g.wav", "h.mxf", "i.0001.rla", "x.0001.foo", "clip.foo", "robot_v2.glb", "model2.obj"];
    for (const n of names) makeFootage(project, n, path.join(dir, n), undefined, { isStill: false });
    makeFootage(project, "still.sgi", path.join(dir, "still.sgi"), undefined, { isStill: true });
    const { A } = loadHost(project, ["collect.jsx"]);
    const seqOf: Record<string, boolean> = {};
    for (const i of A.collectFootage({}).items) seqOf[i.name] = i.sequence;
    expect(names.filter((n) => seqOf[n])).toEqual(["a.0001.sgi", "b.0001.dng", "c.0001.jp2", "d.0001.pct", "e.0001.cr2", "i.0001.rla", "x.0001.foo"]);
    expect(seqOf["still.sgi"]).toBe(false);
  });

  it("collectRelink finds items by id when the copy reports another path than the original", () => {
    const { project, files, a, b } = scene();
    const { A } = loadHost(project, ["collect.jsx"]);
    // The copy reports different paths from the ones the manifest recorded.
    const res = A.collectRelink({
      expect: GUARD,
      mappings: [
        { from: "D:/original/hero.mov", to: files.aNew, sequence: false, role: "main", item_ids: [a.id] },
        { from: "D:/original/logo.png", to: files.bNew, sequence: false, role: "main", item_ids: [b.id] },
      ],
    });
    expect(res).toMatchObject({ relinked: 2, errors_total: 0 });
    expect(a.file.fsName).toBe(files.aNew);
    expect(b.file.fsName).toBe(files.bNew);
    expect(res.items.map((i: any) => i.item_id)).toEqual([a.id, b.id]);
  });

  it("collectRelink keeps a sequence frame and a still of the same disk file apart", () => {
    const { project, dir } = scene();
    const frame = path.join(dir, "shot.0001.exr");
    fs.writeFileSync(frame, "x");
    const seq = makeFootage(project, "Seq", frame, undefined, { isStill: false });
    const still = makeFootage(project, "Still", frame, undefined, { isStill: true });
    const { A } = loadHost(project, ["collect.jsx"]);
    const res = A.collectRelink({
      expect: GUARD,
      mappings: [
        { from: frame, to: path.join(dir, "new.0001.exr"), sequence: true, role: "main" },
        { from: frame, to: path.join(dir, "new_still.exr"), sequence: false, role: "main" },
      ].map((m) => ({ ...m, to: (fs.writeFileSync(m.to, "x"), m.to) })),
    });
    expect(res.errors_total).toBe(0);
    expect(seq.sequenceForce).toBe(false);
    expect(seq.file.fsName).toBe(path.join(dir, "new.0001.exr"));
    expect(still.sequenceForce).toBeUndefined();
    expect(still.file.fsName).toBe(path.join(dir, "new_still.exr"));
  });

  it("collectRelink leaves layered files alone and lists them to relink by hand", () => {
    const { project, dir, files } = scene();
    const psd = path.join(dir, "art.psd");
    const newPsd = path.join(dir, "new_art.psd");
    fs.writeFileSync(psd, "x");
    fs.writeFileSync(newPsd, "x");
    const l1 = makeFootage(project, "Layer 1/art.psd", psd);
    const l2 = makeFootage(project, "Layer 2/art.psd", psd);
    const solo = makeFootage(project, "Background/flat.psd", path.join(dir, "flat.psd"));
    const flat = makeFootage(project, "plain.psd", path.join(dir, "plain.psd"));
    for (const f of ["flat.psd", "plain.psd"]) fs.writeFileSync(path.join(dir, f), "x");
    const calls: string[] = [];
    for (const it of [l1, l2, solo, flat]) it.replace = () => calls.push(it.name);
    const { A } = loadHost(project, ["collect.jsx"]);
    const res = A.collectRelink({
      expect: GUARD,
      mappings: [
        { from: psd, to: newPsd, sequence: false, role: "main" },
        { from: path.join(dir, "flat.psd"), to: newPsd, sequence: false, role: "main" },
        { from: path.join(dir, "plain.psd"), to: newPsd, sequence: false, role: "main" },
        { from: files.a, to: files.aNew, sequence: false, role: "main" },
      ],
    });
    expect(calls).toEqual(["plain.psd"]);
    expect(res.relinked).toBe(2);
    expect(res.errors_total).toBe(3);
    expect(res.errors.map((e: any) => [e.item_id, e.role])).toEqual([[l1.id, "layered"], [l2.id, "layered"], [solo.id, "layered"]]);
    expect(res.errors[0].message).toMatch(/relink by hand/);
  });

  it("collectFootage lists a comp with a proxy, and collectRelink relinks that proxy", () => {
    const { project, dir, comp } = scene();
    const prox = path.join(dir, "comp_prox.mov");
    const newProx = path.join(dir, "new_comp_prox.mov");
    fs.writeFileSync(prox, "x");
    fs.writeFileSync(newProx, "x");
    const c = comp as any;
    c.proxySource = { file: { fsName: prox }, isStill: false };
    c.useProxy = true;
    c.setProxy = (f: { fsName: string }) => {
      c.proxySource = { file: { fsName: f.fsName }, isStill: false };
      c.useProxy = true;
    };
    project.addComp("No proxy");
    const { A } = loadHost(project, ["collect.jsx"]);
    const page = A.collectFootage({});
    const entry = page.items.find((i: any) => i.proxy_only);
    expect(entry).toMatchObject({ item_id: c.id, name: "Main", file: prox, proxy: { file: prox, in_use: true } });
    expect(page.items.filter((i: any) => i.proxy_only)).toHaveLength(1);
    const res = A.collectRelink({ expect: GUARD, mappings: [{ from: prox, to: newProx, sequence: false, role: "proxy", item_ids: [c.id] }] });
    expect(res).toMatchObject({ relinked: 0, proxies_relinked: 1, errors_total: 0 });
    expect(c.proxySource.file.fsName).toBe(newProx);
    expect(c.useProxy).toBe(true);
    const v = A.collectVerify({ mappings: [], items: res.items });
    expect(v.item_checks[0]).toMatchObject({ item_id: c.id, found: true, proxy_file: newProx, use_proxy: true });
  });

  it("collectInfo lists comps, effects and expressions, and the render queue outputs", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["collect.jsx"]);
    const layer = comp.stack[0];
    const effects = layer.property("ADBE Effect Parade") as any;
    effects.props.push({ name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2" }, { name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2" });
    const opacity = layer.transform("ADBE Opacity");
    opacity.expression = "wiggle(1,10)";
    opacity.expressionEnabled = true;
    const item = project.renderQueue.items.add(comp as any);
    (item as any).numOutputModules = 1;
    (item as any).status = "QUEUED";
    (item as any).outputModule = () => ({ file: { fsName: "C:/r/main.mov" }, name: "Lossless" });
    const info = A.collectInfo({});
    expect(info.comps).toMatchObject([{ name: "Main", width: 640, height: 360 }]);
    expect(info.effects).toEqual([{ match_name: "ADBE Gaussian Blur 2", name: "Gaussian Blur", count: 2 }]);
    expect(info.expressions).toEqual({ count: 1, truncated: false });
    expect(info.render_outputs).toEqual([{ item: 1, comp: "Main", status: "QUEUED", output_module: "Lossless", file: "C:/r/main.mov" }]);
    expect(info.effects_truncated).toBe(false);
    const quick = A.collectInfo({ scan: false });
    expect(quick.effects).toEqual([]);
    expect(quick.comps).toHaveLength(1);
  });
});
