import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normPath, pickNewAssets, scanAssets } from "../src/assets.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeImportAssetsSchema, AssetWatcher, SETTLE_MS, assetsTools } from "../src/tools/ext/assets.js";
import { pickEnvironment, redact, tailLines, writeDiagnostics } from "../src/tools/ext/diagnostics.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function touch(file: string, ageMs = 60_000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

/** Fake AE: status/footage answers come from `state`; everything else from `results`. */
function fakeAe(state: { project: string; footage: string[] }, results: Record<string, unknown[]> = {}, dataDir = tempDir("chroma-assets-data-")) {
  const calls: Array<{ fn: string; args: any }> = [];
  const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
  const queue = new SingleWriterQueue();
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "status") return { ok: true, result: { project_path: state.project }, durationMs: 1 };
      if (fn === "footagePaths") return { ok: true, result: { project_path: state.project, paths: state.footage }, durationMs: 1 };
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: state.project, comp_is_valid: true }, durationMs: 1 };
      if (fn === "importAssets") {
        const imported = args.items.map((it: any, i: number) => ({ path: it.path, item_id: 100 + i, name: path.basename(it.path), type: "Footage", sequence: it.sequence }));
        state.footage.push(...imported.map((i: any) => i.path));
        return { ok: true, result: { bin_id: 1, imported, failed: [] }, durationMs: 1 };
      }
      if (fn === "assetBinContents") return { ok: true, result: { items: state.footage.map((p, i) => ({ item_id: i, bin: "_Assets/", name: path.basename(p), path: p })) }, durationMs: 1 };
      const q = results[fn];
      if (!q || q.length === 0) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: q.shift(), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const settings = new SettingsStore(path.join(dataDir, "settings.json"));
  const ctx: ToolContext = { bridge: host, queue, quarantine, settings, dataDir };
  return { ctx, calls, settings };
}

describe("asset scanning", () => {
  it("groups numbered stills into sequences, keeps singles, mirrors subfolders, skips _ and . folders", () => {
    const root = tempDir("chroma-assets-");
    for (let i = 1; i <= 3; i++) touch(path.join(root, "renders", `shot_${String(i).padStart(4, "0")}.png`));
    touch(path.join(root, "logo.png"));
    touch(path.join(root, "vo.wav"));
    touch(path.join(root, "notes.txt"));
    touch(path.join(root, "frame_0001.png"));
    touch(path.join(root, "_old", "skip.png"));
    touch(path.join(root, ".cache", "skip.png"));
    const found = scanAssets(root);
    const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
    expect(found.map((c) => [rel(c.path), c.subfolder.join("/"), c.sequence, c.frames ?? 1])).toEqual([
      ["frame_0001.png", "", false, 1],
      ["logo.png", "", false, 1],
      ["renders/shot_0001.png", "renders", true, 3],
      ["vo.wav", "", false, 1],
    ]);
    expect(scanAssets(root, { sequences: false }).filter((c) => c.subfolder[0] === "renders")).toHaveLength(3);
    expect(scanAssets(root, { recursive: false }).some((c) => c.subfolder.length > 0)).toBe(false);
  });

  it("keeps versions, 2-frame groups and out-of-range numbers as singles", () => {
    const root = tempDir("chroma-assets-");
    touch(path.join(root, "logo_v002.png"));
    touch(path.join(root, "logo_v003.png"));
    touch(path.join(root, "pair_0001.png"));
    touch(path.join(root, "pair_0002.png"));
    touch(path.join(root, "d_20240101.png"));
    touch(path.join(root, "d_20240102.png"));
    touch(path.join(root, "d_20240103.png"));
    const found = scanAssets(root);
    expect(found.every((c) => !c.sequence)).toBe(true);
    expect(found).toHaveLength(7);
  });

  it("splits new files from ones already imported and ones still being written", () => {
    const now = Date.now();
    const c = (p: string, age: number, sequence = false) => ({ path: p, subfolder: [], sequence, mtimeMs: now - age, arrivedMs: now - age });
    const out = pickNewAssets([c("C:/a/One.png", 10_000), c("C:/a/two.png", 10_000), c("C:/a/three.png", 500)], ["c:\\A\\one.png"], now, 2000);
    if (process.platform === "win32") expect(out.already.map((x) => x.path)).toEqual(["C:/a/One.png"]);
    expect(out.settling.map((x) => x.path)).toEqual(["C:/a/three.png"]);
    const seq = pickNewAssets([c("C:/a/s_0001.png", 5000, true), c("C:/a/one.png", 5000)], [], now, 2000, 10_000);
    expect(seq.settling.map((x) => x.path)).toEqual(["C:/a/s_0001.png"]);
    expect(seq.fresh.map((x) => x.path)).toEqual(["C:/a/one.png"]);
    expect(normPath("C:\\X\\y.png")).toBe(process.platform === "win32" ? "c:/x/y.png" : "C:/X/y.png");
  });
});

describe("ae_import_assets", () => {
  it("is registered with automatic checkpoints", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_import_assets")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_import_assets");
  });

  it("imports only what is new into the bin, guarded, and reads the bin back", async () => {
    const dir = tempDir("chroma-assets-proj-");
    const project = path.join(dir, "Show.aep");
    touch(path.join(dir, "_assets", "a.png"));
    touch(path.join(dir, "_assets", "flora", "b.jpg"));
    const state = { project, footage: [path.join(dir, "_assets", "a.png")] };
    const { ctx, calls } = fakeAe(state);
    // The settle check now keys off arrivedMs (real ctime/birthtime), not
    // the backdated mtime touch() sets -- Node has no portable way to
    // backdate ctime/birthtime, so a real wait past SETTLE_MS is needed to
    // simulate "this file finished arriving a while ago".
    await new Promise((r) => setTimeout(r, SETTLE_MS + 100));
    const out: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ expect: { project_path: project } }), ctx);
    expect(out.ok).toBe(true);
    expect(out.already_in_project).toBe(1);
    expect(out.imported.map((i: any) => i.name)).toEqual(["b.jpg"]);
    expect(out.receipt.matches).toBe(true);
    const write = calls.find((c) => c.fn === "importAssets")!.args;
    expect(write.bin).toBe("_Assets");
    expect(write.items).toEqual([{ path: path.join(dir, "_assets", "flora", "b.jpg").replace(/\\/g, "/"), subfolder: ["flora"], sequence: false }]);

    const again: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ expect: { project_path: project } }), ctx);
    expect(again.imported).toEqual([]);
    expect(again.already_in_project).toBe(2);
  });

  it("refuses another project, and turns the watcher on and off", async () => {
    const dir = tempDir("chroma-assets-proj-");
    const project = path.join(dir, "Show.aep");
    const { ctx, settings } = fakeAe({ project, footage: [] });
    const dry: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ dry_run: true, expect: { project_path: project } }), ctx);
    expect(dry.ok).toBe(true);
    expect(dry.to_import).toEqual([]);
    expect(fs.existsSync(path.join(dir, "_assets"))).toBe(false);
    const wrong: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ expect: { project_path: path.join(dir, "Other.aep") } }), ctx);
    expect(wrong.error).toBe("guard");
    const on: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ watch: true, dry_run: true, expect: { project_path: project } }), ctx);
    expect(on.watch.enabled).toBe(true);
    const since = settings.get().asset_watch.since;
    expect(since).not.toBeNull();
    await assetsTools[0].handler(AeImportAssetsSchema.parse({ watch: true, dry_run: true, expect: { project_path: project } }), ctx);
    expect(settings.get().asset_watch.since).toBe(since);
    expect(fs.existsSync(path.join(dir, "_assets"))).toBe(true);
    await assetsTools[0].handler(AeImportAssetsSchema.parse({ watch: false, dry_run: true, expect: { project_path: project } }), ctx);
    expect(settings.get().asset_watch).toEqual({ enabled: false, since: null, recursive: true, sequences: true });
  });

  it("the watcher does nothing while off, then imports files that arrive after it was turned on", async () => {
    const dir = tempDir("chroma-assets-proj-");
    const project = path.join(dir, "Show.aep");
    const state = { project, footage: [] as string[] };
    const { ctx, calls, settings } = fakeAe(state);
    const logs: string[] = [];
    const watcher = new AssetWatcher(ctx, { log: (_l, m) => logs.push(m) });
    expect(await watcher.tick()).toBeNull();
    expect(calls).toHaveLength(0);

    touch(path.join(dir, "_assets", "before.png"), 120_000);
    await new Promise((r) => setTimeout(r, 60));
    settings.updateAssetWatch({ enabled: true, since: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 60));
    // Old (backdated) mtime, but it arrives (real ctime/birthtime) after
    // watching began, same as a copy that preserves an old source mtime.
    // The settle check keys off that real arrival time, so -- unlike the
    // raw-mtime check this replaced -- it is NOT treated as already settled
    // just because its mtime looks old; it needs real time to pass too,
    // same as writing.png below. Wait past SETTLE_MS so it genuinely has.
    touch(path.join(dir, "_assets", "new.png"), 10_000);
    await new Promise((r) => setTimeout(r, SETTLE_MS + 100));
    // Arrives right before the tick: still (correctly) judged as settling.
    touch(path.join(dir, "_assets", "writing.png"), 0);
    const res = await watcher.tick();
    expect(res).toEqual({ imported: 1, failed: 0 });
    expect(state.footage.map((p) => path.basename(p))).toEqual(["new.png"]);
    expect(logs[0]).toMatch(/imported 1 file/);
    expect(calls.find((c) => c.fn === "status")).toBeDefined();

    // writing.png has now genuinely settled (real time has passed), so this
    // tick imports it; the one after has nothing left to do.
    const before = calls.length;
    touch(path.join(dir, "_assets", "writing.png"), 10_000);
    await new Promise((r) => setTimeout(r, SETTLE_MS + 100));
    expect(await watcher.tick()).toEqual({ imported: 1, failed: 0 });
    expect(await watcher.tick()).toBeNull();
    expect(calls.slice(before).filter((c) => c.fn === "footagePaths")).toHaveLength(2);
  });
});

describe("watcher backoff", () => {
  it("logs the first failure once, skips ticks, and logs recovery", async () => {
    const dir = tempDir("chroma-assets-proj-");
    const state = { project: path.join(dir, "Show.aep"), footage: [] as string[] };
    const { ctx, calls, settings } = fakeAe(state);
    settings.updateAssetWatch({ enabled: true, since: new Date(0).toISOString() });
    let t = 1_000_000;
    let broken = true;
    const origEval = ctx.bridge.evalRaw.bind(ctx.bridge);
    (ctx.bridge as any).evalRaw = (a: any) => (broken ? Promise.reject(new Error("AE busy")) : origEval(a));
    const logs: string[] = [];
    const w = new AssetWatcher(ctx, { log: (l, m) => logs.push(l + ":" + m), now: () => t });
    await w.tick();
    await w.tick();
    expect(logs).toHaveLength(1);
    t += 5000;
    await w.tick();
    t += 5000;
    await w.tick();
    expect(logs).toHaveLength(1);
    broken = false;
    t += 60_000;
    await w.tick();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/working again/);
    expect(calls.some((c) => c.fn === "status")).toBe(true);
  });
});

describe("ae_diagnostics", () => {
  it("redacts the token and Bearer values, and tails the log", () => {
    const token = "a".repeat(64);
    expect(redact(`Authorization: Bearer ${token} and ${token}`, token)).toBe("Authorization: Bearer [redacted] and [redacted]");
    expect(tailLines("1\n2\n3\n", 2)).toBe("2\n3");
    expect(tailLines("1\n2", 0)).toBe("");
  });

  it("writes one file without the token, and doesn't wait on an AE that never answers", async () => {
    const dataDir = tempDir("chroma-diag-");
    const token = "b".repeat(64);
    fs.writeFileSync(path.join(dataDir, "token"), token);
    fs.writeFileSync(path.join(dataDir, "service.log"), `line 1\n-> call with Bearer ${token}\nlast line\n`);
    const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    const host = new PanelHost({ evalScript: () => new Promise(() => {}), queue, quarantine });
    const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir, settings: new SettingsStore(path.join(dataDir, "settings.json")) };
    const res = await writeDiagnostics(
      ctx,
      { panelVersion: "0.2.1", inFlight: { label: "stuck", runningMs: 9000 }, logPath: path.join(dataDir, "service.log"), tokenPath: path.join(dataDir, "token") },
      { aeWaitMs: 50, includeDialogs: false }
    );
    const text = fs.readFileSync(res.path, "utf8");
    expect(res.summary.ae_answered).toBe(false);
    expect(res.summary.service_in_flight).toEqual({ label: "stuck", runningMs: 9000 });
    expect(text).toContain("last line");
    expect(text).not.toContain(token);
    expect(text).not.toContain("tokenPath");
    expect(path.dirname(res.path)).toBe(path.join(dataDir, "diagnostics"));

    // Same second: a second file with a suffix, and only one status eval was queued.
    const again = await writeDiagnostics(ctx, undefined, { aeWaitMs: 50, includeDialogs: false });
    expect(again.path).not.toBe(res.path);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(path.extname(again.path)).toBe(".md");
  });
});

describe("ae_diagnostics environment", () => {
  it("picks the environment fields and never a user or machine name", () => {
    const env = pickEnvironment({
      active_item: { id: 1 },
      build: { name: "26.2", number: 7 },
      iso_language: "de_DE",
      rendering_disabled: true,
      gpu: { available: ["METAL"], project: "METAL" },
      os: "Windows 11",
      userName: "someone",
      machineName: "HOST",
      warnings: ["w"],
    });
    expect(Object.keys(env).sort()).toEqual(["build", "gpu", "iso_language", "os", "rendering_disabled", "warnings"]);
    expect(pickEnvironment(null)).toEqual({});
  });

  it("asks AE for the environment after its status and writes it into the file", async () => {
    const dataDir = tempDir("chroma-diag-env-");
    const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    const seen: string[] = [];
    const host = new PanelHost({
      evalScript: async (script) => {
        seen.push(script.slice("__chromaAe.".length, script.indexOf("(")));
        if (script.startsWith("__chromaAe.statusDetail(")) {
          return { ok: true, result: { build: { name: "26.2" }, iso_language: "fr_FR", rendering_disabled: true, gpu: { available: [] }, os: "Windows 11", userName: "no" }, durationMs: 1 };
        }
        return { ok: true, result: { project_path: "<unsaved>" }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir, settings: new SettingsStore(path.join(dataDir, "settings.json")) };
    const res = await writeDiagnostics(ctx, undefined, { includeDialogs: false });
    expect(seen).toEqual(["status", "statusDetail"]);
    const text = fs.readFileSync(res.path, "utf8");
    expect(text).toContain('"iso_language": "fr_FR"');
    expect(text).toContain('"rendering_disabled": true');
    expect(text).not.toContain("userName");
  });

  it("still writes the file when the environment read fails", async () => {
    const dataDir = tempDir("chroma-diag-env-");
    const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    const host = new PanelHost({
      evalScript: async (script) => {
        if (script.startsWith("__chromaAe.statusDetail(")) throw new Error("no such function");
        return { ok: true, result: { project_path: "<unsaved>" }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir, settings: new SettingsStore(path.join(dataDir, "settings.json")) };
    const res = await writeDiagnostics(ctx, undefined, { includeDialogs: false });
    expect(res.summary.ae_answered).toBe(true);
    expect(fs.readFileSync(res.path, "utf8")).toContain("no such function");
  });
});
