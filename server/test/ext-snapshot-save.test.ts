import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AeSnapshotFrameSchema, pngWaitDeps, renderTools } from "../src/tools/render.js";
import { sanitizeCompName, savedFrameName } from "../src/tools/ext/frame-save.js";

const tool = renderTools.find((t) => t.name === "ae_snapshot_frame")!;

function pngBytes(w: number, h: number, shade: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i] = shade;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const tmp: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;
const origHome = process.env.HOME;
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-snapsave-"));
  tmp.push(d);
  return d;
}
beforeEach(() => {
  process.env.LOCALAPPDATA = process.env.HOME = tempDir();
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake AE: getComp answers the comp, snapshotFrame writes a PNG unless `skip` says to leave it out. */
function fakeAe(opts: { name?: string; fps?: number; duration?: number; skip?: (call: number, time: number) => boolean } = {}) {
  const dir = tempDir();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const snaps: Array<{ time: number; output_path: string }> = [];
  let n = 0;
  const host = new PanelHost({
    evalScript: async (script) => {
      if (script.includes("__chromaAe.getComp(")) {
        return { ok: true, result: { id: 7, name: opts.name ?? "Plate Comp", fps: opts.fps ?? 25, duration: opts.duration ?? 4, width: 64, height: 36 }, durationMs: 1 };
      }
      const m = /"output_path":"([^"]+)"/.exec(script)!;
      const outPath = JSON.parse(`"${m[1]}"`) as string;
      const time = Number(/"time":([0-9.eE+-]+)/.exec(script)![1]);
      snaps.push({ time, output_path: outPath });
      if (!opts.skip?.(n++, time)) fs.writeFileSync(outPath, pngBytes(64, 36, Math.round(time * 10)));
      return { ok: true, result: { path: outPath, time, width: 64, height: 36 }, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const run = (args: Record<string, unknown>) =>
    tool.handler(AeSnapshotFrameSchema.parse({ comp_id: 7, ...args }), { bridge: host, queue, quarantine }) as Promise<Record<string, any>>;
  return { run, snaps };
}

describe("ae_snapshot_frame save_to", () => {
  it("names the files <comp>_<frame>.png, sanitised and zero-padded", () => {
    expect(sanitizeCompName('Main: A/B? "x"')).toBe("Main_ A_B_ _x_");
    expect(sanitizeCompName("CON")).toBe("_CON");
    expect(sanitizeCompName("  ... ")).toBe("comp");
    expect(sanitizeCompName("a".repeat(200))).toHaveLength(80);
    expect(savedFrameName("Plate", 12, 99)).toBe("Plate_0012.png");
    expect(savedFrameName("Plate", 12, 123456)).toBe("Plate_000012.png");
  });

  it("saves frames at full resolution into the folder and reports path, bytes, frame and time", async () => {
    const out = tempDir();
    const ae = fakeAe({ name: "Shot/01" });
    const res = await ae.run({ save_to: { folder: out }, frames: [50, 0] });
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ comp_id: 7, comp_name: "Shot/01", fps: 25 });
    expect(res.saved.map((s: any) => [path.basename(s.path), s.frame, s.time])).toEqual([
      ["Shot_01_0050.png", 50, 2],
      ["Shot_01_0000.png", 0, 0],
    ]);
    for (const s of res.saved) {
      expect(path.dirname(s.path)).toBe(out);
      expect(s.bytes).toBe(fs.statSync(s.path).size);
      expect(PNG.sync.read(fs.readFileSync(s.path)).width).toBe(64);
    }
    expect(fs.readdirSync(out).sort()).toEqual(["Shot_01_0000.png", "Shot_01_0050.png"]);
    // the temporary renders were moved, not left behind
    for (const s of ae.snaps) expect(fs.existsSync(s.output_path)).toBe(false);
  });

  it("takes times to the nearest frame and drops duplicates", async () => {
    const out = tempDir();
    const res = await fakeAe().run({ save_to: { folder: out }, times: [1, 1.01, 2] });
    expect(res.saved.map((s: any) => s.frame)).toEqual([25, 50]);
  });

  it("refuses an existing file before rendering anything, and replaces it with overwrite", async () => {
    const out = tempDir();
    fs.writeFileSync(path.join(out, "Plate Comp_0010.png"), "old");
    const ae = fakeAe();
    const refused = await ae.run({ save_to: { folder: out }, frames: [5, 10] });
    expect(refused).toMatchObject({ ok: false, error: "file_exists" });
    expect(refused.existing).toEqual([path.join(out, "Plate Comp_0010.png")]);
    expect(ae.snaps).toHaveLength(0);
    expect(fs.readdirSync(out)).toEqual(["Plate Comp_0010.png"]);

    const res = await ae.run({ save_to: { folder: out, overwrite: true }, frames: [5, 10] });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(out, "Plate Comp_0010.png")).length).toBeGreaterThan(3);
  });

  it("refuses a relative folder, a missing folder (not created) and a file", async () => {
    const ae = fakeAe();
    expect(await ae.run({ save_to: { folder: "plates" }, frames: [0] })).toMatchObject({ ok: false, error: "folder_not_absolute" });
    const missing = path.join(tempDir(), "nope");
    expect(await ae.run({ save_to: { folder: missing }, frames: [0] })).toMatchObject({ ok: false, error: "folder_missing" });
    expect(fs.existsSync(missing)).toBe(false);
    const file = path.join(tempDir(), "f.txt");
    fs.writeFileSync(file, "x");
    expect(await ae.run({ save_to: { folder: file }, frames: [0] })).toMatchObject({ ok: false, error: "folder_not_a_folder" });
    expect(ae.snaps).toHaveLength(0);
  });

  it("refuses frames outside the comp, mixed arguments and a missing time, and bounds the list at 50", async () => {
    const out = tempDir();
    const ae = fakeAe();
    expect(await ae.run({ save_to: { folder: out }, frames: [0, 100] })).toMatchObject({ ok: false, error: "frames_out_of_range" });
    expect(await ae.run({ save_to: { folder: out }, frames: [0], times: [1] })).toMatchObject({ ok: false, error: "frames_or_times" });
    expect(await ae.run({ save_to: { folder: out }, frames: [0], time: 1 })).toMatchObject({ ok: false, error: "time_with_save_to" });
    expect(await ae.run({ frames: [0] })).toMatchObject({ ok: false, error: "save_to_required" });
    expect(await ae.run({})).toMatchObject({ ok: false, error: "time_required" });
    expect(ae.snaps).toHaveLength(0);
    expect(AeSnapshotFrameSchema.safeParse({ comp_id: 7, save_to: { folder: out }, frames: Array.from({ length: 51 }, (_, i) => i) }).success).toBe(false);
    expect(AeSnapshotFrameSchema.safeParse({ comp_id: 7, save_to: { folder: out }, frames: Array.from({ length: 50 }, (_, i) => i) }).success).toBe(true);
  });

  describe("the stale-frame guard", () => {
    const saved = { i: pngWaitDeps.intervalMs, t: pngWaitDeps.timeoutMs };
    afterEach(() => {
      pngWaitDeps.intervalMs = saved.i;
      pngWaitDeps.timeoutMs = saved.t;
    });

    it("retries a stale frame once with a time nudge and reports the time that was rendered", async () => {
      pngWaitDeps.timeoutMs = 60;
      const out = tempDir();
      const ae = fakeAe({ skip: (call) => call === 0 });
      const res = await ae.run({ save_to: { folder: out }, frames: [25] });
      expect(res.ok).toBe(true);
      expect(ae.snaps).toHaveLength(2);
      expect(ae.snaps[1].time).toBeCloseTo(1.001, 6);
      expect(res.saved[0]).toMatchObject({ frame: 25 });
      expect(res.saved[0].time).toBeCloseTo(1.001, 6);
    });

    it("reports a frame that stays stale in failed and still saves the others", async () => {
      pngWaitDeps.timeoutMs = 60;
      const out = tempDir();
      const ae = fakeAe({ skip: (_c, time) => Math.abs(time - 1) < 0.01 });
      const res = await ae.run({ save_to: { folder: out }, frames: [25, 50] });
      expect(res).toMatchObject({ ok: false, error: "some_frames_not_saved" });
      expect(res.saved.map((s: any) => s.frame)).toEqual([50]);
      expect(res.failed.map((f: any) => f.frame)).toEqual([25]);
      expect(fs.readdirSync(out)).toEqual(["Plate Comp_0050.png"]);
    });
  });
});
