import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeBriefSchema,
  AeTasteSchema,
  BRIEF_QUESTIONS,
  briefPath,
  briefTools,
  checkSwatchPath,
  convertSwatches,
  labToSrgb,
  mergeBrandColors,
  mergeBrief,
  missingFields,
  swatchToColor,
} from "../src/tools/ext/brief.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-brief-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => briefTools.find((t) => t.name === name)!;

/** A context whose AE reports `projectPath` as the open project. */
function ctxFor(projectPath: string, settings?: SettingsStore): ToolContext {
  return {
    bridge: {
      newOpId: () => "op_test",
      evalRaw: async ({ script }: { script: string }) => {
        if (!script.startsWith("__chromaAe.status(")) throw new Error(`Unexpected script: ${script}`);
        return { ok: true, result: { project_path: projectPath }, durationMs: 1 };
      },
    },
    settings,
  } as unknown as ToolContext;
}

describe("ae_brief", () => {
  it("is registered with ae_taste", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_brief")).toBe(true);
    expect(ALL_TOOLS.some((t) => t.name === "ae_taste")).toBe(true);
  });

  it("keeps the brief next to the .aep", () => {
    expect(briefPath(path.join("C:", "jobs", "Shot 010.aep"))).toBe(path.join("C:", "jobs", "Shot 010.brief.json"));
  });

  it("starts empty, with a question for every missing field", async () => {
    const aep = path.join(tempDir(), "Shot.aep");
    const out = await tool("ae_brief").handler(AeBriefSchema.parse({}), ctxFor(aep));
    expect(out).toMatchObject({ ok: true, exists: false, saved: false, brief: null });
    expect(out.missing).toEqual(["goal", "audience", "format", "feel", "references", "brand_colors", "fonts", "do_not_change"]);
    const feel = out.questions.find((q: any) => q.field === "feel");
    expect(feel).toMatchObject({ multi_select: true });
    expect(feel.options.length).toBeGreaterThan(2);
  });

  it("saves answers, merges later ones, and clears a field given an empty value", async () => {
    const aep = path.join(tempDir(), "Shot.aep");
    const ctx = ctxFor(aep);
    await tool("ae_brief").handler(
      AeBriefSchema.parse({ set: { goal: "Launch teaser", feel: ["bold", "premium"], fonts: ["Inter"] }, expect: { project_path: aep } }),
      ctx
    );
    const out = await tool("ae_brief").handler(
      AeBriefSchema.parse({ set: { feel: ["calm"], fonts: [] }, expect: { project_path: aep } }),
      ctx
    );
    expect(out.saved).toBe(true);
    expect(out.brief).toMatchObject({ goal: "Launch teaser", feel: ["calm"] });
    expect(out.brief.fonts).toBeUndefined();
    expect(out.missing).toContain("fonts");
    expect(JSON.parse(fs.readFileSync(briefPath(aep), "utf8")).goal).toBe("Launch teaser");
  });

  it("refuses to save next to a different project, and has no brief for an unsaved one", async () => {
    const aep = path.join(tempDir(), "Shot.aep");
    const wrong = await tool("ae_brief").handler(
      AeBriefSchema.parse({ set: { goal: "x" }, expect: { project_path: path.join(tempDir(), "Other.aep") } }),
      ctxFor(aep)
    );
    expect(wrong).toMatchObject({ ok: false, error: "guard" });
    expect(fs.existsSync(briefPath(aep))).toBe(false);
    await expect(tool("ae_brief").handler(AeBriefSchema.parse({}), ctxFor("<unsaved>"))).resolves.toMatchObject({
      ok: false,
      error: "unsaved_project",
    });
  });

  it("needs expect to save, and checks colour codes", () => {
    expect(AeBriefSchema.safeParse({ set: { goal: "x" } }).success).toBe(false);
    expect(AeBriefSchema.safeParse({ set: { brand_colors: ["#FF8800"] }, expect: { project_path: "C:/a.aep" } }).success).toBe(true);
    expect(AeBriefSchema.safeParse({ set: { brand_colors: ["orange"] }, expect: { project_path: "C:/a.aep" } }).success).toBe(false);
  });

  it("merges without touching fields that were not given", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const merged = mergeBrief({ goal: "a", notes: "keep" }, { goal: "b" }, now);
    expect(merged).toEqual({ goal: "b", notes: "keep", updated_at: "2026-10-29T12:00:00.000Z" });
    expect(missingFields(merged)).not.toContain("goal");
    expect(Object.keys(BRIEF_QUESTIONS)).toEqual(missingFields(null));
  });
});

describe("ae_taste", () => {
  it("reads the defaults, saves changes across restarts, and treats a linear curve as no preference", async () => {
    const file = path.join(tempDir(), "settings.json");
    const settings = new SettingsStore(file);
    const t = tool("ae_taste");
    const first = await t.handler(AeTasteSchema.parse({}), ctxFor("<unsaved>", settings));
    expect(first.taste).toEqual({ preferred_ease: null, allow_linear_non_motion: false, avoid_overshoot: false, notes: "" });

    await t.handler(
      AeTasteSchema.parse({ set: { preferred_ease: [0.2, 0, 0, 1], avoid_overshoot: true, notes: "Snappy, no bounce" } }),
      ctxFor("<unsaved>", settings)
    );
    const reloaded = new SettingsStore(file).get();
    expect(reloaded.taste).toEqual({ preferred_ease: [0.2, 0, 0, 1], allow_linear_non_motion: false, avoid_overshoot: true, notes: "Snappy, no bounce" });
    expect(reloaded.auto_checkpoint).toEqual({ enabled: true, max_mb: 250 });

    const cleared = await t.handler(AeTasteSchema.parse({ set: { preferred_ease: [0, 0, 1, 1] } }), ctxFor("<unsaved>", settings));
    expect(cleared.taste.preferred_ease).toBeNull();
  });

  it("ignores a broken curve on disk", () => {
    const file = path.join(tempDir(), "settings.json");
    fs.writeFileSync(file, JSON.stringify({ taste: { preferred_ease: [2, 0, 0, 1], avoid_overshoot: "yes" } }));
    expect(new SettingsStore(file).get().taste).toEqual({ preferred_ease: null, allow_linear_non_motion: false, avoid_overshoot: false, notes: "" });
  });

  it("rejects curves outside 0..1 in x", () => {
    expect(AeTasteSchema.safeParse({ set: { preferred_ease: [1.5, 0, 0, 1] } }).success).toBe(false);
  });
});

// ---------- import_swatches ----------

function swatchCtx(projectPath: string, values: unknown[], calls: Array<{ fn: string; args: unknown }> = []): ToolContext {
  return {
    bridge: {
      newOpId: () => "op_test",
      evalRaw: async () => ({ ok: true, result: { project_path: projectPath }, durationMs: 1 }),
      callHost: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        if (fn !== "briefParseSwatches") throw new Error(`Unexpected host call ${fn}`);
        return { ok: true, result: { majorVersion: 1, minorVersion: 0, count: values.length, truncated: false, values }, durationMs: 1 };
      },
    },
  } as unknown as ToolContext;
}

function aseFile(dir: string, name = "palette.ase"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from("ASEF"));
  return file;
}

const SWATCHES = [
  { type: "RGB", r: 1, g: 0.5, b: 0 },
  { type: "Gray", value: 0.5 },
  { type: "CMYK", c: 0, m: 1, y: 1, k: 0 },
  { type: "LAB", L: 1, a: 0, b: 0 },
  { type: "RGB", r: 1, g: 0.5, b: 0 },
  { type: "HSB", h: 0.1 },
];

describe("swatch conversion", () => {
  it("converts RGB and Gray exactly and flags CMYK and LAB approximate", () => {
    expect(swatchToColor({ type: "RGB", r: 1, g: 0.5, b: 0 })).toEqual({ hex: "#ff8000", approximate: false });
    expect(swatchToColor({ type: "Gray", value: 0 })).toEqual({ hex: "#000000", approximate: false });
    expect(swatchToColor({ type: "CMYK", c: 0, m: 1, y: 1, k: 0 })).toEqual({ hex: "#ff0000", approximate: true });
    expect(swatchToColor({ type: "CMYK", c: 0, m: 0, y: 0, k: 1 })).toEqual({ hex: "#000000", approximate: true });
    expect(swatchToColor({ type: "LAB", L: 1, a: 0, b: 0 })).toEqual({ hex: "#ffffff", approximate: true });
    expect(swatchToColor({ type: "LAB", L: 0, a: 0, b: 0 })).toEqual({ hex: "#000000", approximate: true });
  });

  it("scales LAB L from 0..1 to 0..100 and clamps out-of-gamut colours", () => {
    const mid = swatchToColor({ type: "LAB", L: 0.5, a: 0, b: 0 }) as { hex: string };
    // L* 50 is about sRGB 119 (0x77).
    expect(mid.hex).toMatch(/^#7[6-8]7[6-8]7[6-8]$/);
    expect(labToSrgb(50, 0, 0).out_of_gamut).toBe(false);
    const vivid = swatchToColor({ type: "LAB", L: 0.5, a: 120, b: 120 });
    expect(vivid).toMatchObject({ approximate: true, out_of_gamut: true });
  });

  it("explains swatches it cannot convert", () => {
    expect(swatchToColor({ type: "HSB" })).toContain("not supported");
    expect(swatchToColor({ type: "RGB", r: 1 })).toContain("missing");
  });

  it("de-duplicates, keeps file order and lists skipped swatches", () => {
    const out = convertSwatches(SWATCHES as any);
    expect(out.colors).toEqual(["#ff8000", "#808080", "#ff0000", "#ffffff"]);
    expect(out.duplicates_removed).toBe(1);
    expect(out.skipped).toEqual([{ index: 6, type: "HSB", reason: expect.stringContaining("not supported") }]);
    expect(out.approximate_count).toBe(2);
    expect(out.swatches[2]).toMatchObject({ index: 3, type: "CMYK", approximate: true });
  });

  it("merges without dropping existing colours and caps at the limit", () => {
    const m = mergeBrandColors(["#FF8000", "#111111"], ["#ff8000", "#222222", "#333333"], 3);
    expect(m.merged).toEqual(["#FF8000", "#111111", "#222222"]);
    expect(m.added).toEqual(["#222222"]);
    expect(m.already_present).toEqual(["#ff8000"]);
    expect(m.not_added).toEqual(["#333333"]);
  });

  it("checks the path before asking AE", () => {
    const dir = tempDir();
    expect(checkSwatchPath("palette.ase")).toContain("absolute");
    expect(checkSwatchPath(path.join(dir, "x.png"))).toContain(".ase");
    expect(checkSwatchPath(path.join(dir, "missing.ase"))).toContain("No file");
    fs.writeFileSync(path.join(dir, "empty.ase"), "");
    expect(checkSwatchPath(path.join(dir, "empty.ase"))).toContain("empty");
    expect(checkSwatchPath(aseFile(dir))).toBeNull();
  });
});

describe("ae_brief import_swatches", () => {
  it("lists the colours and saves nothing without confirm", async () => {
    const dir = tempDir();
    const aep = path.join(dir, "Shot.aep");
    const calls: Array<{ fn: string; args: unknown }> = [];
    const out = await tool("ae_brief").handler(AeBriefSchema.parse({ import_swatches: { path: aseFile(dir) } }), swatchCtx(aep, SWATCHES, calls));
    expect(calls).toEqual([{ fn: "briefParseSwatches", args: { path: aseFile(dir) } }]);
    expect(out).toMatchObject({ ok: true, saved: false, exists: false });
    expect(out.swatch_import).toMatchObject({ colors: ["#ff8000", "#808080", "#ff0000", "#ffffff"], confirmed: false, approximate_count: 2, duplicates_removed: 1 });
    expect(out.swatch_import.next).toContain("ae_ask_user");
    expect(fs.existsSync(briefPath(aep))).toBe(false);
  });

  it("previews even for an unsaved project, but refuses to save one", async () => {
    const dir = tempDir();
    const file = aseFile(dir);
    const preview = await tool("ae_brief").handler(AeBriefSchema.parse({ import_swatches: { path: file } }), swatchCtx("<unsaved>", SWATCHES));
    expect(preview.ok).toBe(true);
    expect(preview.swatch_import.colors).toHaveLength(4);
    const save = await tool("ae_brief").handler(
      AeBriefSchema.parse({ import_swatches: { path: file, confirm: true }, expect: { project_path: "<unsaved>" } }),
      swatchCtx("<unsaved>", SWATCHES)
    );
    expect(save).toMatchObject({ ok: false, error: "unsaved_project" });
  });

  it("merges into brand_colors on confirm and keeps what was there", async () => {
    const dir = tempDir();
    const aep = path.join(dir, "Shot.aep");
    const ctx = swatchCtx(aep, SWATCHES);
    await tool("ae_brief").handler(AeBriefSchema.parse({ set: { goal: "Teaser", brand_colors: ["#FF8000", "#123456"] }, expect: { project_path: aep } }), ctx);
    const out = await tool("ae_brief").handler(
      AeBriefSchema.parse({ import_swatches: { path: aseFile(dir), confirm: true }, expect: { project_path: aep } }),
      ctx
    );
    expect(out.saved).toBe(true);
    expect(out.brief.brand_colors).toEqual(["#FF8000", "#123456", "#808080", "#ff0000", "#ffffff"]);
    expect(out.brief.goal).toBe("Teaser");
    expect(out.swatch_import).toMatchObject({ confirmed: true, added: ["#808080", "#ff0000", "#ffffff"], already_present: ["#ff8000"], not_added: [] });
    expect(JSON.parse(fs.readFileSync(briefPath(aep), "utf8")).brand_colors).toHaveLength(5);
  });

  it("needs expect to confirm, and refuses the wrong project", async () => {
    expect(AeBriefSchema.safeParse({ import_swatches: { path: "C:/a.ase", confirm: true } }).success).toBe(false);
    expect(AeBriefSchema.safeParse({ import_swatches: { path: "C:/a.ase" } }).success).toBe(true);
    const dir = tempDir();
    const aep = path.join(dir, "Shot.aep");
    const out = await tool("ae_brief").handler(
      AeBriefSchema.parse({ import_swatches: { path: aseFile(dir), confirm: true }, expect: { project_path: path.join(dir, "Other.aep") } }),
      swatchCtx(aep, SWATCHES)
    );
    expect(out).toMatchObject({ ok: false, error: "guard" });
    expect(fs.existsSync(briefPath(aep))).toBe(false);
  });

  it("reports a bad file or a host failure instead of throwing", async () => {
    const dir = tempDir();
    const aep = path.join(dir, "Shot.aep");
    const bad = await tool("ae_brief").handler(AeBriefSchema.parse({ import_swatches: { path: path.join(dir, "nope.ase") } }), swatchCtx(aep, []));
    expect(bad).toMatchObject({ ok: false, error: "bad_swatch_file" });
    const ctx = swatchCtx(aep, []);
    (ctx.bridge as any).callHost = async () => {
      throw new Error("could not read");
    };
    const failed = await tool("ae_brief").handler(AeBriefSchema.parse({ import_swatches: { path: aseFile(dir) } }), ctx);
    expect(failed).toMatchObject({ ok: false, error: "swatch_parse_failed", message: "could not read" });
  });
});

describe("brief.jsx", () => {
  function host(parse: ((f: unknown) => unknown) | undefined) {
    const project = new FakeProject();
    return loadHost(project, ["brief.jsx"], parse ? { parseSwatchFile: parse } : {});
  }

  it("returns the raw swatch values from app.parseSwatchFile without an undo group", () => {
    const file = aseFile(tempDir());
    const { A, undo } = host(() => ({
      majorVersion: 1,
      minorVersion: 0,
      values: [
        { type: "RGB", r: 1, g: 0, b: 0 },
        { type: "LAB", L: 0.5, a: 10, b: -20 },
        { type: "Gray", value: 0.25 },
      ],
    }));
    const r = A.briefParseSwatches({ path: file });
    expect(r).toMatchObject({ majorVersion: 1, minorVersion: 0, count: 3, truncated: false });
    expect(r.values[1]).toEqual({ type: "LAB", L: 0.5, a: 10, b: -20 });
    expect(r.values[2]).toEqual({ type: "Gray", value: 0.25 });
    expect(undo.begun).toBe(0);
  });

  it("bounds the list at 500 and says so", () => {
    const file = aseFile(tempDir());
    const values = Array.from({ length: 600 }, () => ({ type: "Gray", value: 0.1 }));
    const { A } = host(() => ({ majorVersion: 1, minorVersion: 0, values }));
    const r = A.briefParseSwatches({ path: file });
    expect(r.values).toHaveLength(500);
    expect(r).toMatchObject({ count: 600, truncated: true });
  });

  it("fails clearly when the file is missing, AE cannot parse it, or the member is absent", () => {
    const file = aseFile(tempDir());
    expect(() => host(() => ({ values: [] })).A.briefParseSwatches({ path: path.join(tempDir(), "no.ase") })).toThrow("No swatch file");
    expect(() =>
      host(() => {
        throw new Error("bad ase");
      }).A.briefParseSwatches({ path: file })
    ).toThrow("could not read the swatch file: bad ase");
    expect(() => host(undefined).A.briefParseSwatches({ path: file })).toThrow("no app.parseSwatchFile");
  });
});
