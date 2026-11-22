import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { adjustOutputPath, cachedCatalog, entryFor, forgetCatalogs, intentsOf, rememberCatalog, type FormatCatalog } from "../src/tools/ext/render-formats.js";
import { renderTools } from "../src/tools/render.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rf-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// As measured on AE 26.2.1, macOS (production.jsx renderFormatCatalog).
const catalog: FormatCatalog = {
  ae_version: "26.2.1x2",
  measured_at: "2026-11-22T15:00:00.000Z",
  templates: [
    { name: "AIFF 48kHz", format: "AIFF", extension: "aif", video: false, alpha: true, sequence: false },
    { name: "Alpha Only", format: "QuickTime", extension: "mov", video: true, alpha: true, alpha_only: true, sequence: false },
    { name: "H.264 - Match Render Settings - 40 Mbps", format: "H.264", extension: "mp4", video: true, alpha: false, sequence: false, bitrate_mbps: 40 },
    { name: "H.264 - Match Render Settings -  5 Mbps", format: "H.264", extension: "mp4", video: true, alpha: false, sequence: false, bitrate_mbps: 5 },
    { name: "High Quality", format: "QuickTime", extension: "mov", video: true, alpha: false, sequence: false },
    { name: "High Quality with Alpha", format: "QuickTime", extension: "mov", video: true, alpha: true, sequence: false },
    { name: "Lossless", format: "QuickTime", extension: "mov", video: true, alpha: false, sequence: false },
    { name: "TIFF Sequence with Alpha", format: "TIFF Sequence", extension: "tif", video: true, alpha: true, sequence: true },
  ],
};

describe("render formats", () => {
  it("groups template names by what they write, H.264 by bitrate", () => {
    const i = intentsOf(catalog.templates);
    expect(i.h264.map((x) => x.bitrate_mbps)).toEqual([5, 40]);
    expect(i.quicktime).toEqual(["High Quality", "Lossless"]); // two candidates: the agent picks by name
    expect(i.quicktime_alpha).toEqual(["High Quality with Alpha"]);
    expect(i.alpha_only).toEqual(["Alpha Only"]);
    expect(i.audio_only).toEqual(["AIFF 48kHz"]);
    expect(i.image_sequence).toEqual([{ name: "TIFF Sequence with Alpha", extension: "tif", alpha: true }]);
  });

  it("fits the output path to the template: extension, and a frame pattern for sequences", () => {
    const h264 = entryFor(catalog, "h.264 - match render settings - 40 mbps");
    expect(adjustOutputPath("/r/out.avi", h264)).toMatchObject({ from: "/r/out.avi", to: path.join("/r", "out.mp4") });
    expect(adjustOutputPath("/r/out.mp4", h264)).toBeNull();
    const tiff = entryFor(catalog, "TIFF Sequence with Alpha");
    expect(adjustOutputPath("/r/shot.mov", tiff)?.to).toBe(path.join("/r", "shot_[#####].tif"));
    expect(adjustOutputPath("/r/shot_[####].tif", tiff)).toBeNull();
    expect(adjustOutputPath("/r/out.avi", entryFor(catalog, "No Such Template"))).toBeNull();
  });

  it("keeps the catalog per AE version on disk", () => {
    const dir = tmp();
    rememberCatalog(catalog, dir);
    forgetCatalogs();
    expect(cachedCatalog("26.2.1x2", dir)?.templates).toHaveLength(catalog.templates.length);
    expect(cachedCatalog("27.0", dir)).toBeNull();
  });

  it("ae_render_queue_add sends AE the path the template really writes, and says so", async () => {
    const dir = tmp();
    rememberCatalog(catalog, dir);
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "q.json"));
    const sent: Array<{ fn: string; args: any }> = [];
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, -1) || "{}");
        sent.push({ fn, args });
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
        if (fn === "rqStatus") return { ok: true, result: { numItems: sent.filter((s) => s.fn === "rqAdd").length, items: [] }, durationMs: 1 };
        return { ok: true, result: { index: 1 }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir, serviceInfo: () => ({ aeVersion: "26.2.1x2" }) };
    const tool = renderTools.find((t) => t.name === "ae_render_queue_add")!;
    const out: any = await tool.handler(
      { comp_id: 1, output_path: "/r/out.avi", output_module_template: "H.264 - Match Render Settings - 40 Mbps", expect: { project_path: "<unsaved>" } },
      ctx
    );
    expect(sent.find((s) => s.fn === "rqAdd")?.args.output_path).toBe(path.join("/r", "out.mp4"));
    expect(out.output_path_adjusted).toMatchObject({ from: "/r/out.avi", to: path.join("/r", "out.mp4") });
  });
});
