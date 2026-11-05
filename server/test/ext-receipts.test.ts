import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import {
  clearStoredFingerprints,
  diffFingerprints,
  getStoredFingerprint,
  getStoredFingerprintCount,
  MAX_STORED_FINGERPRINTS,
  receiptsTools,
  type CompFingerprint,
} from "../src/tools/ext/receipts.js";

function findTool(name: string): ToolDefinition<any> {
  const tool = receiptsTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

describe("ext/receipts (G1)", () => {
  const tmpDirs: string[] = [];

  function makeTempDir(prefix = "chroma-ae-receipts-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeContext(
    evalImpl: (
      script: string,
      label: string
    ) => Promise<{ ok: true; result: unknown; durationMs: number }>
  ): { ctx: ToolContext; calls: Array<{ script: string; label: string }> } {
    const calls: Array<{ script: string; label: string }> = [];
    const dir = makeTempDir();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    const bridge = new PanelHost({
      evalScript: async (script, label) => {
        calls.push({ script, label });
        return evalImpl(script, label);
      },
      queue,
      quarantine,
    });
    return {
      ctx: { bridge, queue, quarantine },
      calls,
    };
  }

  beforeEach(() => {
    clearStoredFingerprints();
  });

  afterEach(() => {
    clearStoredFingerprints();
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  describe("diffFingerprints (pure TS)", () => {
    const baseFp: CompFingerprint = {
      comp_id: 10,
      name: "Hero Comp",
      width: 1920,
      height: 1080,
      fps: 24,
      duration: 10,
      numLayers: 2,
      propertyCount: 4,
      truncated: false,
      layers: [
        {
          id: 101,
          index: 1,
          name: "Title",
          type: "TextLayer",
          inPoint: 0,
          outPoint: 10,
          startTime: 0,
          enabled: true,
          parentId: null,
          properties: [
            {
              kind: "group",
              name: "Transform",
              matchName: "ADBE Transform Group",
              path: "layer[101]/ADBE Transform Group",
              properties: [
                {
                  kind: "property",
                  name: "Opacity",
                  matchName: "ADBE Opacity",
                  path: "layer[101]/ADBE Transform Group/ADBE Opacity",
                  value: 100,
                  numKeys: 0,
                  keyframes: [],
                  expression: "",
                  expressionEnabled: false,
                },
                {
                  kind: "property",
                  name: "Position",
                  matchName: "ADBE Position",
                  path: "layer[101]/ADBE Transform Group/ADBE Position",
                  value: [960, 540],
                  numKeys: 2,
                  keyframes: [
                    { time: 0, value: [960, 600] },
                    { time: 1, value: [960, 540] },
                  ],
                  expression: "",
                  expressionEnabled: false,
                },
              ],
            },
          ],
        },
        {
          id: 102,
          index: 2,
          name: "BG",
          type: "AVLayer",
          inPoint: 0,
          outPoint: 10,
          startTime: 0,
          enabled: true,
          parentId: null,
          properties: [],
        },
      ],
    };

    it("returns empty changed, added, removed when fingerprints match within float epsilon", () => {
      const clone: CompFingerprint = JSON.parse(JSON.stringify(baseFp));
      clone.duration = 10 + 1e-7;
      const diff = diffFingerprints(baseFp, clone);
      expect(diff).toEqual({
        changed: [],
        added: [],
        removed: [],
      });
    });

    it("detects changed layer settings, property values, keyframes, expressions, added/removed layers and properties", () => {
      const afterFp: CompFingerprint = JSON.parse(JSON.stringify(baseFp));
      afterFp.duration = 12;

      // Modify layer 101
      const layer101 = afterFp.layers[0];
      layer101.inPoint = 0.5;
      const trGroup = (layer101.properties as any[])[0];
      const opacityProp = trGroup.properties[0];
      opacityProp.value = 75;
      opacityProp.expression = "wiggle(2, 10)";
      opacityProp.expressionEnabled = true;

      const posProp = trGroup.properties[1];
      posProp.numKeys = 3;
      posProp.keyframes.push({ time: 2, value: [960, 500] });

      // Add a new property to layer 101
      trGroup.properties.push({
        kind: "property",
        name: "Rotation",
        matchName: "ADBE Rotate Z",
        path: "layer[101]/ADBE Transform Group/ADBE Rotate Z",
        value: 15,
        numKeys: 0,
        keyframes: [],
        expression: "",
        expressionEnabled: false,
      });

      // Remove layer 102 and add layer 103
      afterFp.layers.splice(1, 1, {
        id: 103,
        index: 2,
        name: "Overlay",
        type: "ShapeLayer",
        inPoint: 0,
        outPoint: 12,
        startTime: 0,
        enabled: true,
        parentId: 101,
        properties: [],
      });

      const diff = diffFingerprints(baseFp, afterFp);

      expect(diff.changed).toEqual([
        { path: "comp.duration", before: 10, after: 12 },
        { path: "layer[101].inPoint", before: 0, after: 0.5 },
        {
          path: "layer[101]/ADBE Transform Group/ADBE Opacity.value",
          before: 100,
          after: 75,
        },
        {
          path: "layer[101]/ADBE Transform Group/ADBE Opacity.expression",
          before: "",
          after: "wiggle(2, 10)",
        },
        {
          path: "layer[101]/ADBE Transform Group/ADBE Opacity.expressionEnabled",
          before: false,
          after: true,
        },
        {
          path: "layer[101]/ADBE Transform Group/ADBE Position.numKeys",
          before: 2,
          after: 3,
        },
        {
          path: "layer[101]/ADBE Transform Group/ADBE Position.keyframes",
          before: [
            { time: 0, value: [960, 600] },
            { time: 1, value: [960, 540] },
          ],
          after: [
            { time: 0, value: [960, 600] },
            { time: 1, value: [960, 540] },
            { time: 2, value: [960, 500] },
          ],
        },
      ]);

      expect(diff.added).toEqual([
        {
          path: "layer[101]/ADBE Transform Group/ADBE Rotate Z",
          kind: "property",
          name: "Rotation",
          matchName: "ADBE Rotate Z",
          value: 15,
        },
        {
          path: "layer[103]",
          kind: "layer",
          id: 103,
          name: "Overlay",
          index: 2,
          type: "ShapeLayer",
        },
      ]);

      expect(diff.removed).toEqual([
        {
          path: "layer[102]",
          kind: "layer",
          id: 102,
          name: "BG",
          index: 2,
          type: "AVLayer",
        },
      ]);
    });
  });

  describe("guide fingerprints use stable words (compsettings group)", () => {
    const fp = (guides: unknown[]): CompFingerprint => ({
      comp_id: 10,
      name: "G",
      width: 1920,
      height: 1080,
      fps: 25,
      duration: 4,
      numLayers: 0,
      propertyCount: 0,
      truncated: false,
      layers: [],
      guides,
    });

    it("sees no difference between two reads that use the words, whatever integers AE used", () => {
      const a = fp([{ orientation: "vertical", position: 300, position_kind: "pixel" }]);
      const b = fp([{ orientation: "vertical", position: 300, position_kind: "pixel" }]);
      expect(diffFingerprints(a, b)).toEqual({ changed: [], added: [], removed: [] });
    });

    it("reports a dropFrame change", () => {
      const a = { ...fp([]), dropFrame: false };
      const b = { ...fp([]), dropFrame: true };
      expect(diffFingerprints(a, b).changed).toEqual([{ path: "comp.dropFrame", before: false, after: true }]);
    });

    it("reports a moved or re-oriented guide", () => {
      const a = fp([{ orientation: "vertical", position: 300, position_kind: "pixel" }]);
      const b = fp([{ orientation: "horizontal", position: 300, position_kind: "pixel" }]);
      expect(diffFingerprints(a, b).changed.map((c) => c.path)).toEqual(["comp.guides"]);
    });

    it("shows a fingerprint stored before the change (raw integers) as a one-off guide difference", () => {
      const old = fp([{ orientationType: 1, position: 300 }]);
      const now = fp([{ orientation: "vertical", position: 300, position_kind: "pixel" }]);
      const diff = diffFingerprints(old, now);
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]).toMatchObject({ path: "comp.guides", before: [{ orientationType: 1, position: 300 }] });
    });
  });

  describe("ae_comp_fingerprint and ae_comp_diff", () => {
    it("stores up to 20 fingerprints in server memory and diffs a stored fingerprint against a fresh eval", async () => {
      const fpTool = findTool("ae_comp_fingerprint");
      const diffTool = findTool("ae_comp_diff");

      let currentOpacity = 100;
      const { ctx, calls } = makeContext(async () => ({
        ok: true,
        durationMs: 5,
        result: {
          comp_id: 7,
          name: "Shot 01",
          width: 1920,
          height: 1080,
          fps: 25,
          duration: 5,
          numLayers: 1,
          propertyCount: 1,
          truncated: false,
          layers: [
            {
              id: 1,
              index: 1,
              name: "Card",
              type: "AVLayer",
              properties: [
                {
                  kind: "property",
                  name: "Opacity",
                  matchName: "ADBE Opacity",
                  path: "layer[1]/ADBE Transform Group/ADBE Opacity",
                  value: currentOpacity,
                  numKeys: 0,
                  keyframes: [],
                  expression: "",
                  expressionEnabled: false,
                },
              ],
            },
          ],
        } satisfies CompFingerprint,
      }));

      const first = (await fpTool.handler(
        fpTool.schema.parse({ comp_id: 7 }),
        ctx
      )) as Record<string, any>;

      expect(first.id).toBe("fp_1");
      expect(first.summary).toMatchObject({
        comp_id: 7,
        name: "Shot 01",
        propertyCount: 1,
        truncated: false,
      });

      // Mutate simulated state and run ae_comp_diff
      currentOpacity = 42;
      const diffRes = (await diffTool.handler(
        diffTool.schema.parse({ before_id: first.id, comp_id: 7 }),
        ctx
      )) as Record<string, any>;

      expect(diffRes.before_id).toBe("fp_1");
      expect(diffRes.after_id).toBe("fp_2");
      expect(diffRes.changed).toEqual([
        {
          path: "layer[1]/ADBE Transform Group/ADBE Opacity.value",
          before: 100,
          after: 42,
        },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0].script).toBe('__chromaAe.compFingerprint({"comp_id":7})');
      expect(calls[1].script).toBe('__chromaAe.compFingerprint({"comp_id":7})');

      // Verify store cap of 20
      for (let i = 0; i < 25; i++) {
        await fpTool.handler({ comp_id: 7 }, ctx);
      }
      expect(getStoredFingerprintCount()).toBe(MAX_STORED_FINGERPRINTS);
      expect(getStoredFingerprint("fp_1")).toBeUndefined();

      await expect(
        diffTool.handler({ before_id: "fp_1", comp_id: 7 }, ctx)
      ).rejects.toThrow(BridgeError);
    });
  });

  describe("ae_checkpoint_create, ae_checkpoint_list, ae_checkpoint_revert", () => {
    it("creates .aep checkpoints with Node fs, lists them, refuses dirty revert unless discard_changes is true, and opens checkpoint", async () => {
      const projDir = makeTempDir("chroma-ae-proj-");
      const projPath = path.join(projDir, "spots.aep");
      fs.writeFileSync(projPath, "FAKE_AEP_V1", "utf8");

      const createTool = findTool("ae_checkpoint_create");
      const listTool = findTool("ae_checkpoint_list");
      const revertTool = findTool("ae_checkpoint_revert");

      let hostDirty = true;
      let activeProjectPath = projPath;

      const { ctx, calls } = makeContext(async (script) => {
        if (script.startsWith("__chromaAe.checkGuard(")) {
          return {
            ok: true,
            durationMs: 2,
            result: {
              ok: true,
              project_path: activeProjectPath,
              comp_id: null,
              comp_is_valid: true,
            },
          };
        }
        if (script.startsWith("__chromaAe.status(")) {
          return {
            ok: true,
            durationMs: 2,
            result: {
              project_path: activeProjectPath,
              dirty: hostDirty,
            },
          };
        }
        if (script.startsWith("__chromaAe.openProject(")) {
          const jsonArg = script.slice(
            "__chromaAe.openProject(".length,
            -1
          );
          const parsed = JSON.parse(jsonArg) as {
            path: string;
            discard_changes?: boolean;
          };
          activeProjectPath = parsed.path;
          hostDirty = false;
          return {
            ok: true,
            durationMs: 10,
            result: {
              project_path: activeProjectPath,
              dirty: false,
            },
          };
        }
        throw new Error(`Unexpected script: ${script}`);
      });

      const expectGuard = { project_path: projPath };

      // 1. Create checkpoint
      const created = (await createTool.handler(
        createTool.schema.parse({
          expect: expectGuard,
          label: "before-batch",
        }),
        ctx
      )) as Record<string, any>;

      expect(created.applied).toBe(true);
      expect(created.checkpoint_path).toMatch(
        /_mcp_checkpoints[\\/]spots_\d{8}-\d{6}_before-batch\.aep$/
      );
      expect(fs.existsSync(created.checkpoint_path)).toBe(true);
      expect(fs.readFileSync(created.checkpoint_path, "utf8")).toBe(
        "FAKE_AEP_V1"
      );
      expect(created.receipt.matches).toBe(true);

      // 2. List checkpoints
      const listed = (await listTool.handler(
        listTool.schema.parse({ expect: expectGuard }),
        ctx
      )) as Record<string, any>;

      expect(listed.checkpoints).toHaveLength(1);
      expect(listed.checkpoints[0].path).toBe(created.checkpoint_path);

      // 3. Revert while dirty without discard_changes -> refused with kind:'guard'
      await expect(
        revertTool.handler(
          revertTool.schema.parse({
            expect: expectGuard,
            checkpoint_path: created.checkpoint_path,
          }),
          ctx
        )
      ).rejects.toMatchObject({
        kind: "guard",
      });

      // Ensure openProject was NOT called when dirty without discard_changes
      expect(
        calls.some((c) => c.script.startsWith("__chromaAe.openProject("))
      ).toBe(false);

      // 4. Revert with discard_changes: true -> succeeds and calls openProject + separate status read-back
      const reverted = (await revertTool.handler(
        revertTool.schema.parse({
          expect: expectGuard,
          checkpoint_path: created.checkpoint_path,
          discard_changes: true,
        }),
        ctx
      )) as Record<string, any>;

      expect(reverted.applied).toBe(true);
      expect(reverted.project_path).toBe(created.checkpoint_path);
      expect(reverted.discarded_changes).toBe(true);
      expect(reverted.receipt.matches).toBe(true);
      expect(
        calls.some((c) => c.script.startsWith("__chromaAe.openProject("))
      ).toBe(true);
    });

    it("refuses ae_checkpoint_create when the project is <unsaved>", async () => {
      const createTool = findTool("ae_checkpoint_create");
      const { ctx } = makeContext(async () => ({
        ok: true,
        durationMs: 2,
        result: {
          ok: true,
          project_path: "<unsaved>",
          comp_id: null,
          comp_is_valid: true,
        },
      }));

      await expect(
        createTool.handler(
          createTool.schema.parse({
            expect: { project_path: "<unsaved>" },
            label: "try-unsaved",
          }),
          ctx
        )
      ).rejects.toMatchObject({
        kind: "guard",
      });
    });
  });
});
