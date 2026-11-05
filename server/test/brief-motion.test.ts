import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { AeBriefSchema, BRIEF_QUESTIONS, briefPath, briefTools, loadMotionSpec, mergeBrief, missingFields } from "../src/tools/ext/brief.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-brief-motion-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = briefTools.find((t) => t.name === "ae_brief")!;

function ctxFor(projectPath: string): ToolContext {
  return {
    bridge: {
      newOpId: () => "op_test",
      evalRaw: async () => ({ ok: true, result: { project_path: projectPath }, durationMs: 1 }),
    },
  } as unknown as ToolContext;
}

const now = new Date("2026-11-05T12:00:00Z");
const saveArgs = (aep: string, motion: any) => AeBriefSchema.parse({ set: { motion }, expect: { project_path: aep } });

describe("ae_brief motion", () => {
  it("merges motion one level deep and clears sub-fields or the whole spec when empty", () => {
    const base = mergeBrief(null, { goal: "g", motion: { register: "energetic", facts: ["A"], beats: [{ start_s: 0, end_s: 2 }] } }, now);
    const a = mergeBrief(base, { motion: { platform: "reels_9_16" } }, now);
    expect(a.motion).toEqual({ register: "energetic", facts: ["A"], beats: [{ start_s: 0, end_s: 2 }], platform: "reels_9_16" });
    expect(a.goal).toBe("g");
    const b = mergeBrief(a, { motion: { facts: [], beats: [{ start_s: 1, end_s: 3 }] } }, now);
    expect(b.motion).toEqual({ register: "energetic", platform: "reels_9_16", beats: [{ start_s: 1, end_s: 3 }] });
    expect(mergeBrief(b, { motion: {} }, now).motion).toBeUndefined();
    expect(mergeBrief({ motion: { register: "handmade" } }, { motion: { register: undefined, platform: "square_1_1" } }, now).motion).toEqual({
      register: "handmade",
      platform: "square_1_1",
    });
    expect(mergeBrief({ motion: { entrance_pattern: "rise" } }, { motion: { entrance_pattern: "" } }, now).motion).toBeUndefined();
  });

  it("returns motion as stored plus motion_resolved, and saves through the tool", async () => {
    const aep = path.join(tempDir(), "Shot.aep");
    const ctx = ctxFor(aep);
    await tool.handler(saveArgs(aep, { register: "energetic", platform: "reels_9_16" }), ctx);
    const out = await tool.handler(saveArgs(aep, { max_same_ease: 3 }), ctx);
    expect(out.motion).toEqual({ register: "energetic", platform: "reels_9_16", max_same_ease: 3 });
    expect(out.motion_resolved.register).toBe("energetic");
    expect(out.motion_resolved.overshoot_max_pct).toBe(25);
    expect(out.motion_resolved.platform).toBe("reels_9_16");
    expect([...out.motion_resolved.from_brief].sort()).toEqual(["max_same_ease", "platform"]);
    const none = await tool.handler(AeBriefSchema.parse({}), ctxFor(path.join(tempDir(), "N.aep")));
    expect(none.motion).toBeNull();
    expect(none.motion_resolved).toMatchObject({ register: "brand_film", from_brief: [] });
  });

  it("asks for the register only while nothing in motion is set", async () => {
    expect(missingFields(null)).toContain("motion");
    expect(missingFields({ motion: {} })).toContain("motion");
    expect(missingFields({ motion: { platform: "square_1_1" } })).not.toContain("motion");
    expect(BRIEF_QUESTIONS.motion.options!.map((o) => o.id)).toEqual(["ui_micro", "brand_film", "energetic", "handmade"]);
    const aep = path.join(tempDir(), "Shot.aep");
    const out = await tool.handler(saveArgs(aep, { register: "handmade" }), ctxFor(aep));
    expect(out.missing).not.toContain("motion");
    expect(out.questions.some((x: any) => x.field === "motion")).toBe(false);
  });

  it("rejects a bad motion patch with a clear error", () => {
    const bad = (motion: any) => AeBriefSchema.safeParse({ set: { motion }, expect: { project_path: "C:/a.aep" } });
    expect(bad({ register: "loud" }).success).toBe(false);
    const beat = bad({ beats: [{ start_s: 3, end_s: 2 }] });
    expect(beat.success).toBe(false);
    expect(JSON.stringify(!beat.success && beat.error.issues)).toContain("end_s > start_s");
    const hero = bad({ beats: [{ start_s: 0, end_s: 2, hero_s: 5 }] });
    expect(hero.success).toBe(false);
    expect(JSON.stringify(!hero.success && hero.error.issues)).toContain("hero_s");
    expect(bad({ beats: [{ start_s: 0, end_s: 2, hero_s: 1.5 }] }).success).toBe(true);
  });

  it("loadMotionSpec falls back to defaults with no project, no brief or a malformed motion, and reads a saved one", async () => {
    expect(await loadMotionSpec(ctxFor("<unsaved>"))).toMatchObject({ register: "brand_film", from_brief: [] });
    const failing = {
      bridge: {
        newOpId: () => "x",
        evalRaw: async () => {
          throw new Error("AE down");
        },
      },
    } as unknown as ToolContext;
    expect(await loadMotionSpec(failing)).toMatchObject({ register: "brand_film", brief_path: null });

    const aep = path.join(tempDir(), "Shot.aep");
    expect(await loadMotionSpec(ctxFor(aep))).toMatchObject({ register: "brand_film", brief_path: null });
    fs.writeFileSync(briefPath(aep), JSON.stringify({ goal: "x" }));
    expect(await loadMotionSpec(ctxFor(aep))).toMatchObject({ register: "brand_film", from_brief: [], brief_path: briefPath(aep) });

    fs.writeFileSync(briefPath(aep), JSON.stringify({ motion: { register: "handmade", platform: "feed_4_5" } }));
    expect(await loadMotionSpec(ctxFor(aep))).toMatchObject({ register: "handmade", platform: "feed_4_5", from_brief: ["platform"] });

    fs.writeFileSync(briefPath(aep), JSON.stringify({ motion: { register: "nonsense" } }));
    expect(await loadMotionSpec(ctxFor(aep))).toMatchObject({ register: "brand_film", from_brief: [] });
  });
});
