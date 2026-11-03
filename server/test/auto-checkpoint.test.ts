import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { AUTO_CHECKPOINT_TOOLS, receiptsTools } from "../src/tools/ext/receipts.js";
import { AeRunJsxSchema, autoCheckpoint, mutateTools, resetAutoCheckpointMemory } from "../src/tools/mutate.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-autocp-"));
  tmpDirs.push(dir);
  return dir;
}

/** A saved project on disk, plus a context whose settings live next to it. */
function project(content = "aep v1") {
  const dir = makeTempDir();
  const aep = path.join(dir, "Shot 010.aep");
  fs.writeFileSync(aep, content);
  const settings = new SettingsStore(path.join(dir, "data", "settings.json"));
  const ctx = { settings } as unknown as ToolContext;
  return { dir, aep, settings, ctx, checkpointDir: path.join(dir, "_mcp_checkpoints") };
}

/** Rewrites the project as a save would, with a later mtime. */
function resave(aep: string, content: string): void {
  fs.writeFileSync(aep, content);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(aep, later, later);
}

beforeEach(() => resetAutoCheckpointMemory());

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("starts from the defaults, persists changes and ignores a corrupt file", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);

    store.updateAutoCheckpoint({ enabled: false });
    expect(new SettingsStore(file).get().auto_checkpoint).toEqual({ enabled: false, max_mb: 250 });

    store.updateAutoCheckpoint({ max_mb: 40 });
    expect(new SettingsStore(file).get().auto_checkpoint).toEqual({ enabled: false, max_mb: 40 });

    fs.writeFileSync(file, "{not json");
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("autoCheckpoint", () => {
  it("logs one 'Checkpoint saved' line per copy, which the panel counts", async () => {
    const { aep, ctx } = project();
    const lines: string[] = [];
    ctx.log = (level, msg) => lines.push(`${level} ${msg}`);
    const guard = { project_path: aep, dirty: false };

    await autoCheckpoint(ctx, guard, "ae_set_text");
    await autoCheckpoint(ctx, guard, "ae_set_text"); // reused: same save, no new copy
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok Checkpoint saved before ae_set_text: Shot 010_\d{8}-\d{6}_auto-ae_set_text\.aep$/);
  });

  it("copies the saved project once per save, and again after the next save", async () => {
    const { aep, ctx, checkpointDir } = project();
    const guard = { project_path: aep, dirty: false };

    const first = await autoCheckpoint(ctx, guard, "ae_set_property");
    expect(first.status).toBe("created");
    expect(path.dirname(first.path!)).toBe(checkpointDir);
    expect(path.basename(first.path!)).toMatch(/^Shot 010_\d{8}-\d{6}_auto-ae_set_property\.aep$/);
    expect(fs.readFileSync(first.path!, "utf8")).toBe("aep v1");
    expect(first.unsaved_changes_not_included).toBeUndefined();

    const second = await autoCheckpoint(ctx, guard, "ae_set_text");
    expect(second).toEqual({ status: "reused", path: first.path });

    resave(aep, "aep v2");
    const third = await autoCheckpoint(ctx, guard, "ae_set_text");
    expect(third.status).toBe("created");
    expect(third.path).not.toBe(first.path);
    expect(fs.readFileSync(third.path!, "utf8")).toBe("aep v2");
    expect(fs.readdirSync(checkpointDir)).toHaveLength(2);
  });

  it("never overwrites an earlier checkpoint made in the same second", async () => {
    const { aep, ctx } = project();
    const a = await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx");
    resave(aep, "aep v2");
    const b = await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx");
    expect(a.path).not.toBe(b.path);
    expect(fs.readFileSync(a.path!, "utf8")).toBe("aep v1");
  });

  it("says when unsaved changes are left out", async () => {
    const { aep, ctx } = project();
    const res = await autoCheckpoint(ctx, { project_path: aep, dirty: true }, "ae_run_jsx");
    expect(res).toMatchObject({ status: "created", unsaved_changes_not_included: true });
    const reused = await autoCheckpoint(ctx, { project_path: aep, dirty: true }, "ae_run_jsx");
    expect(reused).toMatchObject({ status: "reused", unsaved_changes_not_included: true });
  });

  it("makes a new copy when the last one was deleted", async () => {
    const { aep, ctx } = project();
    const first = await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx");
    fs.rmSync(first.path!);
    const again = await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx");
    expect(again.status).toBe("created");
    expect(fs.existsSync(again.path!)).toBe(true);
  });

  it("skips unsaved projects, missing files, oversized files and when turned off", async () => {
    const { aep, ctx, settings, checkpointDir } = project("x".repeat(2048));

    expect(await autoCheckpoint(ctx, { project_path: "<unsaved>" }, "ae_run_jsx")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/never been saved/),
    });
    expect(await autoCheckpoint(ctx, { project_path: aep + ".gone" }, "ae_run_jsx")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/not on disk/),
    });

    settings.updateAutoCheckpoint({ max_mb: 0.001 });
    expect(await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/over the 0.001 MB limit/),
    });

    settings.updateAutoCheckpoint({ enabled: false, max_mb: 250 });
    expect(await autoCheckpoint(ctx, { project_path: aep }, "ae_run_jsx")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/off/),
    });
    expect(fs.existsSync(checkpointDir)).toBe(false);
  });

  it("uses the defaults when the context has no settings store", async () => {
    const { aep } = project();
    const res = await autoCheckpoint({} as ToolContext, { project_path: aep }, "ae_run_jsx");
    expect(res.status).toBe("created");
  });
});

describe("write tools take a checkpoint before they write", () => {
  function fakeAe(aep: string, dirty: boolean) {
    const dir = makeTempDir();
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    const order: string[] = [];
    const host = new PanelHost({
      evalScript: async (script) => {
        if (script.includes("__chromaAe.checkGuard(")) {
          order.push("guard");
          return { ok: true, result: { ok: true, project_path: aep, comp_id: null, comp_is_valid: true, dirty }, durationMs: 1 };
        }
        if (script.includes("__chromaAe.runUserJsx(")) {
          const cpDir = path.join(path.dirname(aep), "_mcp_checkpoints");
          order.push(fs.existsSync(cpDir) && fs.readdirSync(cpDir).length > 0 ? "write (checkpoint on disk)" : "write");
          return { ok: true, result: { done: true }, durationMs: 1 };
        }
        if (script.includes("__chromaAe.status(")) {
          return { ok: true, result: { project_path: aep, dirty }, durationMs: 1 };
        }
        return { ok: true, result: {}, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine, settings };
    return { ctx, order, settings };
  }

  it("ae_run_jsx copies the saved project before the write and reports it", async () => {
    const { aep } = project();
    const { ctx, order } = fakeAe(aep, true);
    const tool = mutateTools.find((t) => t.name === "ae_run_jsx")!;
    const res = (await tool.handler(
      AeRunJsxSchema.parse({ code: "return 1;", mutates: true, label: "test", expect: { project_path: aep } }),
      ctx
    )) as Record<string, any>;

    expect(order).toEqual(["guard", "write (checkpoint on disk)"]);
    expect(res.applied).toBe(true);
    expect(res.checkpoint).toMatchObject({ status: "created", unsaved_changes_not_included: true });
    expect(fs.existsSync(res.checkpoint.path)).toBe(true);
  });

  it("ae_auto_checkpoint reads and changes the settings, and ae_checkpoint_list marks auto copies", async () => {
    const { aep } = project();
    const { ctx, settings } = fakeAe(aep, false);
    const tool = receiptsTools.find((t) => t.name === "ae_auto_checkpoint")!;

    const read = (await tool.handler({}, ctx)) as Record<string, any>;
    expect(read).toMatchObject({ changed: false, auto_checkpoint: { enabled: true, max_mb: 250 } });
    expect(read.applies_to).toEqual(AUTO_CHECKPOINT_TOOLS);

    const off = (await tool.handler({ enabled: false, max_mb: 50 }, ctx)) as Record<string, any>;
    expect(off).toMatchObject({ changed: true, auto_checkpoint: { enabled: false, max_mb: 50 } });
    expect(JSON.parse(fs.readFileSync(settings.path, "utf8")).auto_checkpoint).toEqual({ enabled: false, max_mb: 50 });

    settings.updateAutoCheckpoint({ enabled: true });
    await autoCheckpoint(ctx, { project_path: aep }, "ae_set_property");
    fs.writeFileSync(path.join(path.dirname(aep), "_mcp_checkpoints", "Shot 010_20261029-101500_before-batch.aep"), "manual");
    const list = receiptsTools.find((t) => t.name === "ae_checkpoint_list")!;
    const listed = (await list.handler({ expect: { project_path: aep } }, ctx)) as Record<string, any>;
    const byAuto = Object.fromEntries(listed.checkpoints.map((c: any) => [c.name.includes("_auto-") ? "auto" : "manual", c.auto]));
    expect(byAuto).toEqual({ auto: true, manual: false });
  });

  it("every tool in AUTO_CHECKPOINT_TOOLS exists", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of AUTO_CHECKPOINT_TOOLS) expect(names.has(name)).toBe(true);
    expect(names.has("ae_auto_checkpoint")).toBe(true);
  });
});
