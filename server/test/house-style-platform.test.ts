import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_PRESET_IDS, safeRect } from "../src/motion-spec.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeHouseStyleCheckSchema, layoutTools, platformAspectWarning } from "../src/tools/ext/layout.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string, args: any) => unknown) {
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-hs-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "{}");
      return { ok: true, result: answer(fn, args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  return { bridge: host, queue, quarantine } as ToolContext;
}

const tool = layoutTools.find((t) => t.name === "ae_house_style_check")!;

type Rect = [number, number, number, number];
interface L {
  name: string;
  rect: Rect;
  kind?: "text" | "shape";
  size?: number;
}

/** Runs the tool on a comp of w x h with the given layers; `motion` goes in the brief when set. */
async function run(w: number, h: number, layers: L[], args: Record<string, unknown> = {}, motion?: unknown) {
  const dir = tempDir("chroma-hs-");
  const aep = path.join(dir, "Job.aep");
  fs.writeFileSync(path.join(dir, "Job.brief.json"), JSON.stringify({ brand_colors: ["#ff0000"], fonts: ["Gotham"], ...(motion ? { motion } : {}) }));
  const scanLayers = layers.map((l, i) => ({
    index: i + 1,
    id: i + 1,
    name: l.name,
    kind: l.kind ?? "text",
    enabled: true,
    ...((l.kind ?? "text") === "text" ? { font: "Gotham-Book", family: "Gotham", font_size: l.size ?? 60, colours: [] } : { colours: [] }),
  }));
  const ctx = fakeAe((fn, a) => {
    if (fn === "status") return { project_path: aep };
    if (fn === "styleScan") return { width: w, height: h, time: 1, layers: scanLayers };
    const l = layers[a.layer.id - 1];
    return { layer: { index: a.layer.id, id: a.layer.id, name: l.name }, kind: l.kind ?? "text", checkable: true, reason: null, samples: [{ time: 1, visible: true, rect: l.rect }] };
  });
  return tool.handler(AeHouseStyleCheckSchema.parse({ comp_id: 1, ...args }), ctx) as Promise<any>;
}

const kinds = (out: any) => out.findings.map((f: any) => f.kind).sort();

describe("ae_house_style_check platform presets", () => {
  it("resolves argument, then the brief's platform, then title safe", async () => {
    const mid: L = { name: "Mid", rect: [400, 700, 600, 800] };
    const low: L = { name: "Low", rect: [150, 1400, 500, 1480] };
    const noBrief = await run(1080, 1920, [mid, low]);
    expect(noBrief.platform).toMatchObject({ preset: "title_safe", source: "default" });
    expect(kinds(noBrief)).toEqual([]);
    const fromBrief = await run(1080, 1920, [mid, low], {}, { platform: "reels_9_16" });
    expect(fromBrief.platform).toMatchObject({ preset: "reels_9_16", source: "brief" });
    expect(kinds(fromBrief)).toEqual(["below_platform_ui"]);
    const arg = await run(1080, 1920, [mid, low], { platform: "title_safe" }, { platform: "reels_9_16" });
    expect(arg.platform).toMatchObject({ preset: "title_safe", source: "argument" });
    expect(kinds(arg)).toEqual([]);
    const argOver = await run(1080, 1920, [mid, low], { platform: "reels_9_16" }, { platform: "title_safe" });
    expect(kinds(argOver)).toEqual(["below_platform_ui"]);
  });

  it("a register default platform (not set by the brief) does not switch the box", async () => {
    const out = await run(1080, 1920, [{ name: "Low", rect: [150, 1400, 500, 1480] }], {}, { register: "energetic" });
    expect(out.platform).toMatchObject({ preset: "title_safe", source: "default" });
  });

  it("applies each preset's box on a matching comp", async () => {
    const comps: Record<string, [number, number]> = {
      title_safe: [1920, 1080],
      landscape_16_9: [1920, 1080],
      reels_9_16: [1080, 1920],
      promo_9_16: [1080, 1920],
      feed_4_5: [1080, 1350],
      square_1_1: [1080, 1080],
    };
    for (const id of PLATFORM_PRESET_IDS) {
      const [w, h] = comps[id];
      const box = safeRect(id, w, h);
      const inside: L = { name: "In", rect: [box.left + 10, box.top + 10, box.left + 110, box.top + 60] };
      const left: L = { name: "Out", rect: [box.left - 30, box.top + 100, box.left + 100, box.top + 150] };
      const out = await run(w, h, [inside, left], { platform: id });
      expect(out.findings.some((f: any) => f.kind === "platform_aspect_mismatch")).toBe(false);
      if (id === "title_safe") {
        expect(kinds(out)).toEqual(["outside_safe"]);
      } else {
        expect(kinds(out)).toEqual(["outside_platform_safe"]);
        const f = out.findings.find((x: any) => x.kind === "outside_platform_safe");
        expect(f.layer.name).toBe("Out");
        expect(f.preset).toBe(id);
        expect(f.message).toMatch(/left by 30 px/);
      }
    }
  });

  it("flags the reels bottom band and right rail separately, for text and logos", async () => {
    const out = await run(
      1080,
      1920,
      [
        { name: "Caption", rect: [100, 1400, 600, 1500] },
        { name: "Handle", rect: [900, 800, 1060, 860] },
        { name: "Brand logo", kind: "shape", rect: [80, 1500, 280, 1560] },
        { name: "Fine", rect: [100, 600, 500, 700] },
      ],
      { platform: "reels_9_16" }
    );
    const by = (k: string) => out.findings.filter((f: any) => f.kind === k).map((f: any) => f.layer.name);
    expect(by("below_platform_ui")).toEqual(["Caption", "Brand logo"]);
    expect(by("in_action_rail")).toEqual(["Handle"]);
    expect(by("outside_platform_safe")).toEqual([]);
    expect(out.findings.find((f: any) => f.layer.name === "Caption").message).toMatch(/below the platform UI line \(y 1330\) by 170 px/);
    expect(out.findings.find((f: any) => f.layer.name === "Handle").message).toMatch(/action rail.*by 100 px/);
  });

  it("warns once when the comp's shape does not match the preset", async () => {
    const out = await run(1920, 1080, [{ name: "T", rect: [900, 500, 1000, 560] }], { platform: "reels_9_16" });
    expect(out.findings.filter((f: any) => f.kind === "platform_aspect_mismatch")).toHaveLength(1);
    expect(out.ok).toBe(true);
    expect(platformAspectWarning("reels_9_16", 1080, 1920)).toBeNull();
    expect(platformAspectWarning("title_safe", 1920, 1080)).toBeNull();
  });
});

describe("ae_house_style_check text floor", () => {
  it("defaults to 2.6 % of the short side", async () => {
    const out = await run(1920, 1080, [
      { name: "Small", rect: [900, 500, 1000, 540], size: 25 },
      { name: "Ok", rect: [900, 600, 1000, 640], size: 30 },
    ]);
    expect(out.findings.filter((f: any) => f.kind === "small_text").map((f: any) => f.layer.name)).toEqual(["Small"]);
    expect(out.min_text).toEqual({ px: 28.1, source: "default" });
    expect(out.findings.find((f: any) => f.kind === "small_text").message).toMatch(/2\.6 % of the 1080 px short side/);
  });

  it("takes the brief's min_text_pct", async () => {
    const out = await run(1920, 1080, [{ name: "T", rect: [900, 500, 1000, 540], size: 40 }], {}, { min_text_pct: 5 });
    expect(out.min_text).toEqual({ px: 54, source: "brief" });
    expect(kinds(out)).toEqual(["small_text"]);
  });

  it("lets an explicit min_font_size win over the relative floor", async () => {
    const small: L = { name: "T", rect: [900, 500, 1000, 540], size: 25 };
    const lower = await run(1920, 1080, [small], { min_font_size: 20 });
    expect(kinds(lower)).toEqual([]);
    expect(lower.min_text).toEqual({ px: 20, source: "argument" });
    const higher = await run(1920, 1080, [{ ...small, size: 40 }], { min_font_size: 50 });
    expect(kinds(higher)).toEqual(["small_text"]);
    expect(higher.findings[0].message).toMatch(/under the 50 px minimum\./);
  });
});

describe("ae_house_style_check backward compatibility", () => {
  it("keeps the old result shape and title-safe findings without a platform", async () => {
    const out = await run(640, 360, [{ name: "Title", rect: [10, 150, 300, 200], size: 18 }], { title_safe: 0.2 });
    expect(out).toMatchObject({ ok: true, clean: false, used: { fonts: ["Gotham"], from_brief: true } });
    expect(kinds(out)).toEqual(["outside_safe"]);
    expect(out.counts).toBeDefined();
    expect(out.checked).toEqual({ text: 1, shape: 0, solid: 0 });
  });
});
