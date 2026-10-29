import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeAddEffectSchema,
  AeSetEffectSchema,
  effectsTools,
  expectedParamValue,
  findPresets,
  paramMismatches,
} from "../src/tools/ext/effects.js";
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

const tool = (name: string) => effectsTools.find((t) => t.name === name)!;

const blur = (value: number, enabled = true, name = "Gaussian Blur") => ({
  index: 1,
  name,
  matchName: "ADBE Gaussian Blur 2",
  enabled,
  params: [
    { index: 1, name: "Blurriness", matchName: "ADBE Gaussian Blur 2-0001", path: ["Blurriness"], type: "1d", settable: true, value },
    { index: 3, name: "Repeat Edge Pixels", matchName: "ADBE Gaussian Blur 2-0003", path: ["Repeat Edge Pixels"], type: "1d", settable: true, value: 1 },
  ],
});

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: string[] = [];
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-fx-q-"), "quarantine.json"));
  const queue = new SingleWriterQueue();
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const queueForFn = results[fn];
      if (!queueForFn || queueForFn.length === 0) throw new Error(`Unexpected script: ${script}`);
      const next = queueForFn.shift();
      if (next instanceof Error) return { ok: false, error: { message: next.message, kind: "runtime" } };
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const base = { comp_id: 1, layer: { name: "Plate" }, expect: { project_path: "<unsaved>" } };

describe("effect tools", () => {
  it("are registered and take automatic checkpoints", () => {
    for (const name of ["ae_add_effect", "ae_set_effect", "ae_remove_effect", "ae_apply_preset", "ae_list_presets"]) {
      expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
    }
    for (const name of ["ae_add_effect", "ae_set_effect", "ae_remove_effect", "ae_apply_preset"]) {
      expect(AUTO_CHECKPOINT_TOOLS).toContain(name);
    }
  });

  it("ae_add_effect guards, reads before, writes, reads back separately, and checks the params", async () => {
    const { ctx, calls } = fakeAe({
      listLayerEffects: [{ effects: [] }, { effects: [blur(25)] }],
      addEffect: [{ index: 1, name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", params_set: [{ param: "Blurriness", how: "value" }, { param: "Repeat Edge Pixels", how: "value" }] }],
    });
    const args = AeAddEffectSchema.parse({ ...base, effect: "ADBE Gaussian Blur 2", params: [{ param: "Blurriness", value: 25 }, { param: "Repeat Edge Pixels", value: true }] });
    const out = await tool("ae_add_effect").handler(args, ctx);
    expect(calls).toEqual(["checkGuard", "listLayerEffects", "addEffect", "listLayerEffects"]);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.effect.name).toBe("Gaussian Blur");
    expect(out.checkpoint).toMatchObject({ status: "skipped" });
  });

  it("ae_add_effect flags a parameter that read back differently", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [{ effects: [] }, { effects: [blur(10)] }],
      addEffect: [{ index: 1, name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", params_set: [{ param: "Blurriness", how: "value" }] }],
    });
    const out = await tool("ae_add_effect").handler(AeAddEffectSchema.parse({ ...base, effect: "Gaussian Blur", params: [{ param: "Blurriness", value: 25 }] }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("params.Blurriness");
  });

  it("ae_set_effect checks enabled and the new name", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [{ effects: [blur(25)] }, { effects: [blur(25, false, "Soft")] }],
      setEffect: [{ index: 1, name: "Soft", matchName: "ADBE Gaussian Blur 2", enabled: false, params_set: [] }],
    });
    const out = await tool("ae_set_effect").handler(AeSetEffectSchema.parse({ ...base, effect: { name: "Gaussian Blur" }, enabled: false, name: "Soft" }), ctx);
    expect(out.receipt.matches).toBe(true);
    expect(out.effect).toMatchObject({ name: "Soft", enabled: false });
  });

  it("ae_set_effect needs something to change", () => {
    expect(AeSetEffectSchema.safeParse({ ...base, effect: { index: 1 } }).success).toBe(false);
    expect(AeSetEffectSchema.safeParse({ ...base, effect: {}, enabled: true }).success).toBe(false);
  });

  it("ae_remove_effect confirms one effect fewer", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [{ effects: [blur(25)] }, { effects: [] }],
      removeEffect: [{ removed: { index: 1, name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2" } }],
    });
    const out = await tool("ae_remove_effect").handler({ ...base, effect: { index: 1 } }, ctx);
    expect(out.receipt.matches).toBe(true);
    expect(out.removed.name).toBe("Gaussian Blur");
    expect(out.remaining).toEqual([]);
  });

  it("ae_apply_preset reports the effects it added, and refuses a missing file before touching AE", async () => {
    const dir = tempDir("chroma-fx-preset-");
    const ffx = path.join(dir, "Look.ffx");
    fs.writeFileSync(ffx, "RIFX");
    const { ctx, calls } = fakeAe({
      listLayerEffects: [
        { effects: [blur(25)] },
        { effects: [blur(25), { index: 2, name: "Colorama", matchName: "APC Colorama", enabled: true, params: [] }] },
      ],
      applyPreset: [{ preset: ffx, layers_added: 0 }],
    });
    const out = await tool("ae_apply_preset").handler({ ...base, preset_path: ffx }, ctx);
    expect(out.effects_added).toEqual([{ index: 2, name: "Colorama", matchName: "APC Colorama" }]);
    expect(out.receipt.matches).toBe(true);

    const before = calls.length;
    const missing = await tool("ae_apply_preset").handler({ ...base, preset_path: path.join(dir, "Gone.ffx") }, ctx);
    expect(missing).toMatchObject({ ok: false, error: "bad_preset" });
    expect(calls.length).toBe(before);
  });
});

describe("parameter read-back", () => {
  it("expects AE's form of booleans and RGB colors", () => {
    expect(expectedParamValue("1d", true)).toBe(1);
    expect(expectedParamValue("1d", false)).toBe(0);
    expect(expectedParamValue("color", [1, 0, 0])).toEqual([1, 0, 0, 1]);
    expect(expectedParamValue("2d", [10, 20])).toEqual([10, 20]);
  });

  it("finds parameters by name, match name or top-level index, and skips ones set at the current time", () => {
    const fx = blur(25);
    expect(paramMismatches(fx, [{ param: "ADBE Gaussian Blur 2-0001", value: 25 }], undefined)).toEqual([]);
    expect(paramMismatches(fx, [{ param: 1, value: 25 }], undefined)).toEqual([]);
    expect(paramMismatches(fx, [{ param: 1, value: 30 }], [{ param: "Blurriness", how: "value_at_current_time" }])).toEqual([]);
    expect(paramMismatches(fx, [{ param: "Nope", value: 1 }], undefined)[0].message).toMatch(/not found/);
  });
});

describe("findPresets", () => {
  function presetTree() {
    const root = tempDir("chroma-fx-tree-");
    const user = path.join(root, "User Presets");
    const app = path.join(root, "Presets");
    fs.mkdirSync(path.join(app, "Transitions - Wipes"), { recursive: true });
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, "70s_FX.ffx"), "x");
    fs.writeFileSync(path.join(app, "Transitions - Wipes", "Band Wipe.ffx"), "x");
    fs.writeFileSync(path.join(app, "Transitions - Wipes", "notes.txt"), "x");
    return [
      { kind: "app", path: app },
      { kind: "user", path: user },
    ];
  }

  it("lists user presets first, with their category", () => {
    const { presets, scanned } = findPresets(presetTree(), undefined, "all");
    expect(scanned).toBe(2);
    expect(presets.map((p) => [p.source, p.name, p.category])).toEqual([
      ["user", "70s_FX", "User Presets"],
      ["app", "Band Wipe", "Transitions - Wipes"],
    ]);
  });

  it("filters by text in the category or name, and by source", () => {
    const folders = presetTree();
    expect(findPresets(folders, "wipes", "all").presets.map((p) => p.name)).toEqual(["Band Wipe"]);
    expect(findPresets(folders, "70S", "all").presets.map((p) => p.name)).toEqual(["70s_FX"]);
    expect(findPresets(folders, undefined, "app").presets.every((p) => p.source === "app")).toBe(true);
  });

  it("tolerates a folder that does not exist", () => {
    expect(findPresets([{ kind: "user", path: path.join(os.tmpdir(), "no-such-presets-dir") }], undefined, "all").presets).toEqual([]);
  });
});
