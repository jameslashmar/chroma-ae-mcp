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
  mergeBrief,
  missingFields,
} from "../src/tools/ext/brief.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

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
