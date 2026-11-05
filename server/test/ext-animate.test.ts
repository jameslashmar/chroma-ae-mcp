import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import {
  QuarantineBlockedError,
  QuarantineStore,
} from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import {
  AGENT_SAFETY_GUIDANCE,
  type ToolContext,
  type ToolDefinition,
} from "../src/tools/common.js";
import {
  AeImportFootageSchema,
  AeReplaceFootageSchema,
  AeSetKeyframeEaseSchema,
  AeSetTextSchema,
  animateTools,
  clampInfluenceValue,
  createdItemIds,
  extractKeyframeEaseCheck,
  extrasRecomputeEase,
  importCreatedFields,
  keyExtrasConflict,
  keyExtrasMismatches,
  layoutChanged,
  pickKeyExtras,
  reloadChanges,
  resolveTargetKeys,
  typedTextChecks,
  rovingSkipKeys,
  usesTypedText,
} from "../src/tools/ext/animate.js";
import { FakeProject, GUARD, ImportOptions, loadHost } from "./support/fake-ae.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTool(name: string): ToolDefinition<any> {
  const found = animateTools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`Tool not found: ${name}`);
  }
  return found;
}

describe("Task G3 animate tools (ext-animate)", () => {
  const tmpDirs: string[] = [];

  function makeTempQuarantine(): QuarantineStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-animate-"));
    tmpDirs.push(dir);
    return new QuarantineStore(path.join(dir, "quarantine.json"));
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  describe("Tool definitions and Zod schemas", () => {
    it("exports all 4 animate tools with AGENT_SAFETY_GUIDANCE in descriptions", () => {
      expect(animateTools.map((t) => t.name)).toEqual([
        "ae_set_keyframe_ease",
        "ae_set_text",
        "ae_import_footage",
        "ae_replace_footage",
      ]);
      for (const tool of animateTools) {
        expect(tool.description).toContain(AGENT_SAFETY_GUIDANCE);
      }
    });

    it("validates AeSetKeyframeEaseSchema presets and explicit ease objects", () => {
      const validPreset = AeSetKeyframeEaseSchema.safeParse({
        comp_id: 10,
        layer: { index: 1 },
        path: ["ADBE Transform Group", "ADBE Opacity"],
        ease: "easy_ease",
        expect: { project_path: "C:/proj/test.aep", comp_id: 10 },
      });
      expect(validPreset.success).toBe(true);

      const validCustom = AeSetKeyframeEaseSchema.safeParse({
        comp_id: 10,
        layer: { name: "Hero" },
        path: ["ADBE Transform Group", "ADBE Scale"],
        keys: [1, 2],
        ease: {
          in: { speed: 0, influence: 75 },
          out: { speed: 0, influence: 50 },
        },
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(validCustom.success).toBe(true);

      const invalidInfluence = AeSetKeyframeEaseSchema.safeParse({
        comp_id: 10,
        layer: { id: 5 },
        path: ["Transform", "Opacity"],
        ease: {
          in: { speed: 0, influence: 150 },
          out: { speed: 0, influence: 50 },
        },
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(invalidInfluence.success).toBe(false);
    });

    it("validates AeSetTextSchema requires text or non-empty style", () => {
      const emptyCall = AeSetTextSchema.safeParse({
        comp_id: 1,
        layer: { index: 1 },
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(emptyCall.success).toBe(false);

      const emptyStyleCall = AeSetTextSchema.safeParse({
        comp_id: 1,
        layer: { index: 1 },
        style: {},
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(emptyStyleCall.success).toBe(false);

      const validTextOnly = AeSetTextSchema.safeParse({
        comp_id: 1,
        layer: { index: 1 },
        text: "Hello Chroma",
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(validTextOnly.success).toBe(true);

      const validStyleOnly = AeSetTextSchema.safeParse({
        comp_id: 1,
        layer: { id: 99 },
        style: {
          font: "Inter-Bold",
          fontSize: 64,
          tracking: 20,
          leading: 72,
          fillColor: [1, 0.5, 0],
          strokeColor: [0, 0, 0],
          strokeWidth: 2,
          applyFill: true,
          applyStroke: true,
          justification: "center",
        },
        expect: { project_path: "C:/proj/test.aep" },
      });
      expect(validStyleOnly.success).toBe(true);
    });

    it("validates AeImportFootageSchema and AeReplaceFootageSchema", () => {
      expect(
        AeImportFootageSchema.safeParse({
          paths: ["C:/media/shot01.mov"],
          sequence: false,
          fps: 24,
          target_folder_id: 3,
          expect: { project_path: "C:/proj/test.aep" },
        }).success
      ).toBe(true);

      expect(
        AeImportFootageSchema.safeParse({
          paths: [],
          expect: { project_path: "C:/proj/test.aep" },
        }).success
      ).toBe(false);

      expect(
        AeReplaceFootageSchema.safeParse({
          item_id: 42,
          path: "C:/media/shot01_v02.mov",
          sequence: false,
          expect: { project_path: "C:/proj/test.aep" },
        }).success
      ).toBe(true);
    });
  });

  describe("Pure helpers", () => {
    it("clamps influence values into [0.1, 100]", () => {
      expect(clampInfluenceValue(0)).toBe(0.1);
      expect(clampInfluenceValue(50)).toBe(50);
      expect(clampInfluenceValue(120)).toBe(100);
    });

    it("extracts keyframe ease checks for presets and custom eases", () => {
      const snap = {
        numKeys: 2,
        keyframes: [
          {
            keyIndex: 1,
            inInterp: "bezier",
            outInterp: "bezier",
            easeIn: [
              { speed: 0, influence: 33.333333 },
              { speed: 0, influence: 33.333333 },
            ],
            easeOut: [
              { speed: 0, influence: 33.333333 },
              { speed: 0, influence: 33.333333 },
            ],
          },
          {
            keyIndex: 2,
            inInterp: "hold",
            outInterp: "hold",
            easeIn: [{ speed: 0, influence: 0.1 }],
            easeOut: [{ speed: 0, influence: 0.1 }],
          },
        ],
      };

      const checkEasy = extractKeyframeEaseCheck("easy_ease", [1], snap);
      expect(checkEasy?.expected).toEqual({
        keyframes: [
          {
            keyIndex: 1,
            inInterp: "bezier",
            outInterp: "bezier",
            easeIn: [
              { speed: 0, influence: 33.333333 },
              { speed: 0, influence: 33.333333 },
            ],
            easeOut: [
              { speed: 0, influence: 33.333333 },
              { speed: 0, influence: 33.333333 },
            ],
          },
        ],
      });

      const checkHold = extractKeyframeEaseCheck("hold", [2], snap);
      expect(checkHold?.expected).toEqual({
        keyframes: [
          {
            keyIndex: 2,
            inInterp: "hold",
            outInterp: "hold",
          },
        ],
      });
    });
  });

  describe("Guard, separate read-back evals, and receipt flow via PanelHost", () => {
    it("ae_set_keyframe_ease executes guard, before-read, write, and separate after-read", async () => {
      const calls: Array<{ script: string; label: string }> = [];
      const quarantine = makeTempQuarantine();
      const queue = new SingleWriterQueue();
      let getEaseCallCount = 0;

      const host = new PanelHost({
        evalScript: async (script, label) => {
          calls.push({ script, label });
          if (script.startsWith("__chromaAe.checkGuard(")) {
            return {
              ok: true,
              result: {
                ok: true,
                project_path: "C:\\proj\\anim.aep",
                comp_id: 10,
                comp_is_valid: true,
              },
              durationMs: 2,
            };
          }
          if (script.startsWith("__chromaAe.getKeyframeEase(")) {
            getEaseCallCount += 1;
            if (getEaseCallCount === 1) {
              return {
                ok: true,
                result: {
                  numKeys: 2,
                  keyframes: [
                    {
                      keyIndex: 1,
                      time: 0,
                      value: 0,
                      inInterp: "linear",
                      outInterp: "linear",
                      easeIn: [{ speed: 0, influence: 0.1 }],
                      easeOut: [{ speed: 0, influence: 0.1 }],
                    },
                    {
                      keyIndex: 2,
                      time: 1,
                      value: 100,
                      inInterp: "linear",
                      outInterp: "linear",
                      easeIn: [{ speed: 0, influence: 0.1 }],
                      easeOut: [{ speed: 0, influence: 0.1 }],
                    },
                  ],
                },
                durationMs: 3,
              };
            }
            return {
              ok: true,
              result: {
                numKeys: 2,
                keyframes: [
                  {
                    keyIndex: 1,
                    time: 0,
                    value: 0,
                    inInterp: "bezier",
                    outInterp: "bezier",
                    easeIn: [{ speed: 0, influence: 80 }],
                    easeOut: [{ speed: 0, influence: 60 }],
                  },
                  {
                    keyIndex: 2,
                    time: 1,
                    value: 100,
                    inInterp: "bezier",
                    outInterp: "bezier",
                    easeIn: [{ speed: 0, influence: 80 }],
                    easeOut: [{ speed: 0, influence: 60 }],
                  },
                ],
              },
              durationMs: 3,
            };
          }
          if (script.startsWith("__chromaAe.setKeyframeEase(")) {
            return {
              ok: true,
              result: {
                comp_id: 10,
                layer_id: 1,
                keysUpdated: [1, 2],
                numKeys: 2,
                easeDimensions: 1,
                mode: "custom",
              },
              durationMs: 5,
            };
          }
          throw new Error(`Unexpected script: ${script}`);
        },
        queue,
        quarantine,
      });

      const ctx: ToolContext = { bridge: host, queue, quarantine };
      const tool = getTool("ae_set_keyframe_ease");

      const out = (await tool.handler(
        {
          comp_id: 10,
          layer: { index: 1 },
          path: ["ADBE Transform Group", "ADBE Opacity"],
          ease: {
            in: { speed: 0, influence: 80 },
            out: { speed: 0, influence: 60 },
          },
          expect: { project_path: "C:/proj/anim.aep" },
        },
        ctx
      )) as Record<string, any>;

      expect(out.applied).toBe(true);
      expect(out.receipt.matches).toBe(true);
      expect(out.receipt.mismatches).toEqual([]);
      expect(calls.map((c) => c.script.split("(")[0])).toEqual([
        "__chromaAe.checkGuard",
        "__chromaAe.getKeyframeEase",
        "__chromaAe.setKeyframeEase",
        "__chromaAe.getKeyframeEase",
      ]);
    });

    it("ae_set_text runs separate before/after reads and detects justification drift in receipt", async () => {
      const quarantine = makeTempQuarantine();
      const queue = new SingleWriterQueue();
      let getTextCount = 0;

      const host = new PanelHost({
        evalScript: async (script) => {
          if (script.startsWith("__chromaAe.checkGuard(")) {
            return {
              ok: true,
              result: {
                ok: true,
                project_path: "C:/proj/anim.aep",
                comp_id: 5,
                comp_is_valid: true,
              },
              durationMs: 1,
            };
          }
          if (script.startsWith("__chromaAe.getTextDocument(")) {
            getTextCount += 1;
            if (getTextCount === 1) {
              return {
                ok: true,
                result: {
                  comp_id: 5,
                  layer_id: 2,
                  document: {
                    text: "Old Title",
                    font: "ArialMT",
                    fontSize: 48,
                    justification: "left",
                  },
                },
                durationMs: 2,
              };
            }
            return {
              ok: true,
              result: {
                comp_id: 5,
                layer_id: 2,
                document: {
                  text: "New Title",
                  font: "Inter-Bold",
                  fontSize: 72,
                  fillColor: [1, 1, 1],
                  justification: "center",
                },
              },
              durationMs: 2,
            };
          }
          if (script.startsWith("__chromaAe.setText(")) {
            return {
              ok: true,
              result: {
                comp_id: 5,
                layer_id: 2,
                applied: ["text", "font", "fontSize", "fillColor", "justification"],
                justification: "center",
                justificationReasserted: false,
              },
              durationMs: 4,
            };
          }
          throw new Error(`Unexpected script: ${script}`);
        },
        queue,
        quarantine,
      });

      const ctx: ToolContext = { bridge: host, queue, quarantine };
      const tool = getTool("ae_set_text");

      const out = (await tool.handler(
        {
          comp_id: 5,
          layer: { id: 2 },
          text: "New Title",
          style: {
            font: "Inter-Bold",
            fontSize: 72,
            fillColor: [1, 1, 1],
            justification: "center",
          },
          expect: { project_path: "C:/proj/anim.aep", comp_id: 5 },
        },
        ctx
      )) as Record<string, any>;

      expect(out.applied).toBe(true);
      expect(out.receipt.matches).toBe(true);
      expect(out.result.justificationReasserted).toBe(false);
    });

    it("ae_import_footage returns new item_ids and verifies them in a separate after-read", async () => {
      const quarantine = makeTempQuarantine();
      const queue = new SingleWriterQueue();
      let getItemsCall = 0;

      const host = new PanelHost({
        evalScript: async (script) => {
          if (script.startsWith("__chromaAe.checkGuard(")) {
            return {
              ok: true,
              result: { ok: true, project_path: "C:/proj/anim.aep" },
              durationMs: 1,
            };
          }
          if (script.startsWith("__chromaAe.getFootageItems(")) {
            getItemsCall += 1;
            if (getItemsCall === 1) {
              return {
                ok: true,
                result: {
                  project_path: "C:/proj/anim.aep",
                  numItems: 2,
                  item_ids: [1, 2],
                },
                durationMs: 2,
              };
            }
            return {
              ok: true,
              result: {
                project_path: "C:/proj/anim.aep",
                numItems: 4,
                item_ids: [101, 102],
                items: [
                  { id: 101, name: "a.png", file: "C:/media/a.png", footageMissing: false },
                  { id: 102, name: "b.png", file: "C:/media/b.png", footageMissing: false },
                ],
              },
              durationMs: 2,
            };
          }
          if (script.startsWith("__chromaAe.importFootage(")) {
            return {
              ok: true,
              result: {
                item_ids: [101, 102],
                items: [
                  { id: 101, name: "a.png", file: "C:/media/a.png", footageMissing: false },
                  { id: 102, name: "b.png", file: "C:/media/b.png", footageMissing: false },
                ],
                sequence: false,
                target_folder_id: 2,
              },
              durationMs: 10,
            };
          }
          throw new Error(`Unexpected script: ${script}`);
        },
        queue,
        quarantine,
      });

      const ctx: ToolContext = { bridge: host, queue, quarantine };
      const tool = getTool("ae_import_footage");

      const out = (await tool.handler(
        {
          paths: ["C:/media/a.png", "C:/media/b.png"],
          sequence: false,
          fps: 25,
          target_folder_id: 2,
          expect: { project_path: "C:/proj/anim.aep" },
        },
        ctx
      )) as Record<string, any>;

      expect(out.applied).toBe(true);
      expect(out.item_ids).toEqual([101, 102]);
      expect(out.receipt.matches).toBe(true);
    });

    it("ae_replace_footage returns before/after file paths and footageMissing with receipt verification", async () => {
      const quarantine = makeTempQuarantine();
      const queue = new SingleWriterQueue();
      let getItemCall = 0;

      const host = new PanelHost({
        evalScript: async (script) => {
          if (script.startsWith("__chromaAe.checkGuard(")) {
            return {
              ok: true,
              result: { ok: true, project_path: "C:/proj/anim.aep" },
              durationMs: 1,
            };
          }
          if (script.startsWith("__chromaAe.getFootageItem(")) {
            getItemCall += 1;
            if (getItemCall === 1) {
              return {
                ok: true,
                result: {
                  item_id: 55,
                  name: "shot_v01.mov",
                  file: "C:\\renders\\shot_v01.mov",
                  footageMissing: true,
                },
                durationMs: 2,
              };
            }
            return {
              ok: true,
              result: {
                item_id: 55,
                name: "shot_v02.mov",
                file: "C:\\renders\\shot_v02.mov",
                footageMissing: false,
              },
              durationMs: 2,
            };
          }
          if (script.startsWith("__chromaAe.replaceFootage(")) {
            return {
              ok: true,
              result: {
                item_id: 55,
                name: "shot_v02.mov",
                sequence: false,
                before_file: "C:\\renders\\shot_v01.mov",
                before_footage_missing: true,
                requested_path: "C:\\renders\\shot_v02.mov",
              },
              durationMs: 8,
            };
          }
          throw new Error(`Unexpected script: ${script}`);
        },
        queue,
        quarantine,
      });

      const ctx: ToolContext = { bridge: host, queue, quarantine };
      const tool = getTool("ae_replace_footage");

      const out = (await tool.handler(
        {
          item_id: 55,
          path: "C:/renders/shot_v02.mov",
          sequence: false,
          expect: { project_path: "C:/proj/anim.aep" },
        },
        ctx
      )) as Record<string, any>;

      expect(out.applied).toBe(true);
      expect(out.before_path).toBe("C:\\renders\\shot_v01.mov");
      expect(out.after_path).toBe("C:\\renders\\shot_v02.mov");
      expect(out.before_footage_missing).toBe(true);
      expect(out.footageMissing).toBe(false);
      expect(out.receipt.matches).toBe(true);
    });

    it("refuses mutations when target guard mismatches or when quarantine is active", async () => {
      const quarantine = makeTempQuarantine();
      const queue = new SingleWriterQueue();
      const seenScripts: string[] = [];

      const host = new PanelHost({
        evalScript: async (script) => {
          seenScripts.push(script);
          return {
            ok: true,
            result: {
              ok: false,
              project_path: "C:/proj/other.aep",
              comp_id: 1,
              comp_is_valid: true,
            },
            durationMs: 1,
          };
        },
        queue,
        quarantine,
      });

      const ctx: ToolContext = { bridge: host, queue, quarantine };
      const replaceTool = getTool("ae_replace_footage");

      await expect(
        replaceTool.handler(
          {
            item_id: 55,
            path: "C:/renders/shot_v02.mov",
            expect: { project_path: "C:/proj/expected.aep" },
          },
          ctx
        )
      ).rejects.toThrow(BridgeError);

      expect(seenScripts).toHaveLength(1);
      expect(seenScripts[0]).toMatch(/^__chromaAe\.checkGuard\(/);

      // Now place an entry in quarantine and verify all 4 tools refuse before calling evalScript
      quarantine.add({
        op_id: "op_timed_out",
        tool: "ae_set_text",
        label: "timed out op",
        reason: "Timed out",
      });
      seenScripts.length = 0;

      for (const tool of animateTools) {
        await expect(
          tool.handler(
            {
              comp_id: 1,
              layer: { index: 1 },
              path: ["Transform", "Opacity"],
              ease: "easy_ease",
              text: "hi",
              paths: ["C:/a.mov"],
              item_id: 1,
              expect: { project_path: "C:/proj/expected.aep" },
            },
            ctx
          )
        ).rejects.toThrow(QuarantineBlockedError);
      }
      expect(seenScripts).toHaveLength(0);
    });
  });

  describe("ExtendScript host file (panel/host/ext/animate.jsx)", () => {
    const jsxPath = path.resolve(
      __dirname,
      "../../panel/host/ext/animate.jsx"
    );

    it("passes ES3 syntax and chained-ternary checks", () => {
      const source = fs.readFileSync(jsxPath, "utf8");
      // Strip comments and strings
      const stripped = source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");

      expect(stripped).not.toMatch(/\blet\b/);
      expect(stripped).not.toMatch(/\bconst\b/);
      expect(stripped).not.toMatch(/\bclass\b/);
      expect(stripped).not.toMatch(/=>/);
      expect(stripped).not.toContain("`");
      expect(stripped).not.toContain("?");
    });

    it("executes setKeyframeEase (with 1-2-3-4 ladder), setText (with justification re-assertion), importFootage, and replaceFootage in mock AE", () => {
      const source = fs.readFileSync(jsxPath, "utf8");

      const A: Record<string, any> = {
        withUndo: (_label: string, fn: () => unknown) => fn(),
        checkGuard: () => ({
          ok: true,
          project_path: "C:/proj/anim.aep",
          comp_id: 1,
          comp_is_valid: true,
        }),
      };

      class MockCompItem {}
      class MockFootageItem {}
      class MockFolderItem {}
      class MockTextDocument {}

      class MockKeyframeEase {
        speed: number;
        influence: number;
        constructor(speed: number, influence: number) {
          this.speed = speed;
          this.influence = influence;
        }
      }

      const importedOptions: any[] = [];
      class MockImportOptions {
        file: any;
        sequence = false;
        forceAlphabetical = false;
        constructor(file: any) {
          this.file = file;
          importedOptions.push(this);
        }
      }

      class MockFile {
        fsName: string;
        exists = true;
        constructor(p: string) {
          this.fsName = p;
        }
      }

      // Property that rejects 2D derived ease and only accepts 3D ease (tests the 1-2-3-4 ladder)
      const easeCalls: Array<{ keyIndex: number; dims: number }> = [];
      const mockScaleProp = {
        name: "Scale",
        matchName: "ADBE Scale",
        propertyType: 6212,
        propertyValueType: 6416, // TwoD (derives 2 first, then falls back to 1, 3, 4)
        isSpatial: false,
        numKeys: 2,
        keyTime: (k: number) => k,
        keyValue: () => [100, 100],
        keyInInterpolationType: () => 6613,
        keyOutInterpolationType: () => 6613,
        keyInTemporalEase: () => [new MockKeyframeEase(0, 33.333333)],
        keyOutTemporalEase: () => [new MockKeyframeEase(0, 33.333333)],
        setTemporalEaseAtKey: (
          k: number,
          inArr: MockKeyframeEase[],
          _outArr: MockKeyframeEase[]
        ) => {
          if (inArr.length !== 3) {
            throw new Error("Mock AE requires 3 dimensions for Scale");
          }
          easeCalls.push({ keyIndex: k, dims: inArr.length });
        },
        setInterpolationTypeAtKey: () => {},
      };

      // Source Text property that drops justification on first setValue (issue #93) and sticks on second setValue
      let setValueCount = 0;
      const textDocState = Object.assign(new MockTextDocument(), {
        text: "Initial",
        font: "ArialMT",
        fontSize: 32,
        tracking: 0,
        leading: 36,
        applyFill: true,
        fillColor: [1, 1, 1],
        applyStroke: false,
        strokeColor: [0, 0, 0],
        strokeWidth: 0,
        justification: 7413, // LEFT_JUSTIFY
      });

      const mockSourceTextProp = {
        numKeys: 0,
        get value() {
          return Object.assign(new MockTextDocument(), textDocState);
        },
        setValue: (d: any) => {
          setValueCount += 1;
          textDocState.text = d.text;
          textDocState.font = d.font;
          textDocState.fontSize = d.fontSize;
          // Simulate AE 26 dropping LEFT_JUSTIFY -> CENTER_JUSTIFY on the first round-trip
          if (setValueCount === 1) {
            textDocState.justification = 7415; // CENTER_JUSTIFY
          } else {
            textDocState.justification = d.justification;
          }
        },
      };

      const mockLayer = {
        id: 11,
        index: 1,
        name: "Title Layer",
        property: (name: string) => {
          if (name === "Scale") return mockScaleProp;
          if (name === "Source Text") return mockSourceTextProp;
          return null;
        },
      };

      const mockComp = Object.assign(new MockCompItem(), {
        id: 1,
        name: "Main",
        time: 0,
        numLayers: 1,
        layer: () => mockLayer,
      });

      let replacedWithSeq = false;
      let replacedForceAlpha: boolean | null = null;
      const mockFootage = Object.assign(new MockFootageItem(), {
        id: 77,
        name: "clip.mov",
        typeName: "Footage",
        file: { fsName: "C:/old/clip.mov" },
        footageMissing: true,
        width: 1920,
        height: 1080,
        duration: 5,
        frameRate: 24,
        mainSource: { conformFrameRate: 24 },
        replace: function (f: MockFile) {
          this.file = f;
          this.footageMissing = false;
        },
        replaceWithSequence: function (f: MockFile, forceAlpha: boolean) {
          replacedWithSeq = true;
          replacedForceAlpha = forceAlpha;
          this.file = f;
          this.footageMissing = false;
        },
      });

      const mockFolder = Object.assign(new MockFolderItem(), {
        id: 9,
        name: "Assets",
      });

      let nextId = 200;
      const mockApp = {
        project: {
          file: { fsName: "C:/proj/anim.aep" },
          numItems: 2,
          itemByID: (id: number) => {
            if (id === 1) return mockComp;
            if (id === 77) return mockFootage;
            if (id === 9) return mockFolder;
            return null;
          },
          importFile: (io: MockImportOptions) => {
            nextId += 1;
            return Object.assign(new MockFootageItem(), {
              id: nextId,
              name: io.file.fsName,
              typeName: "Footage",
              file: io.file,
              footageMissing: false,
              width: 1920,
              height: 1080,
              duration: 2,
              frameRate: 24,
              mainSource: { conformFrameRate: 24 },
              parentFolder: null,
            });
          },
        },
      };

      const run = new Function(
        "$",
        "app",
        "CompItem",
        "FootageItem",
        "FolderItem",
        "TextDocument",
        "PropertyType",
        "PropertyValueType",
        "KeyframeInterpolationType",
        "KeyframeEase",
        "ParagraphJustification",
        "ImportOptions",
        "File",
        source
      );

      run(
        { global: { __chromaAe: A } },
        mockApp,
        MockCompItem,
        MockFootageItem,
        MockFolderItem,
        MockTextDocument,
        { PROPERTY: 6212 },
        {
          OneD: 6417,
          TwoD: 6416,
          TwoD_SPATIAL: 6415,
          ThreeD: 6414,
          ThreeD_SPATIAL: 6413,
          COLOR: 6418,
        },
        { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
        MockKeyframeEase,
        {
          LEFT_JUSTIFY: 7413,
          RIGHT_JUSTIFY: 7414,
          CENTER_JUSTIFY: 7415,
        },
        MockImportOptions,
        MockFile
      );

      // 1. Test setKeyframeEase 1-2-3-4 fallback ladder
      const easeRes = A.setKeyframeEase({
        comp_id: 1,
        layer: { index: 1 },
        path: ["Scale"],
        ease: "easy_ease",
        expect: { project_path: "C:/proj/anim.aep", comp_id: 1 },
      });
      expect(easeRes.easeDimensions).toBe(3);
      expect(easeCalls).toEqual([
        { keyIndex: 1, dims: 3 },
        { keyIndex: 2, dims: 3 },
      ]);

      // 2. Test setText round-trip with justification re-assertion
      const textRes = A.setText({
        comp_id: 1,
        layer: { index: 1 },
        text: "Updated Text",
        expect: { project_path: "C:/proj/anim.aep", comp_id: 1 },
      });
      expect(textRes.justification).toBe("left");
      expect(textRes.justificationReasserted).toBe(true);
      expect(textDocState.text).toBe("Updated Text");
      expect(textDocState.justification).toBe(7413);

      // 3. Test importFootage with sequence: true (numbered order, forceAlphabetical off)
      const importRes = A.importFootage({
        paths: ["C:/seq/frame_0001.png"],
        sequence: true,
        fps: 30,
        target_folder_id: 9,
        expect: { project_path: "C:/proj/anim.aep" },
      });
      expect(importRes.item_ids).toEqual([201]);
      expect(importedOptions[0].sequence).toBe(true);
      expect(importedOptions[0].forceAlphabetical).toBe(false);

      // 4. Test replaceFootage with sequence: true
      const replaceRes = A.replaceFootage({
        item_id: 77,
        path: "C:/new/seq_0001.exr",
        sequence: true,
        expect: { project_path: "C:/proj/anim.aep" },
      });
      expect(replaceRes.before_file).toBe("C:/old/clip.mov");
      expect(replaceRes.before_footage_missing).toBe(true);
      expect(replacedWithSeq).toBe(true);
      // Numbered order with placeholders for gaps, not Force alphabetical order.
      expect(replacedForceAlpha).toBe(false);
      expect(mockFootage.footageMissing).toBe(false);
    });
  });
});

// ======================================================================
// Wave 5 "animate": typography/paragraph/box and font checks in ae_set_text,
// import_as / range / placeholders in ae_import_footage, per-key extras in
// ae_set_keyframe_ease, reload in ae_replace_footage.
// ======================================================================

const expectArg = { project_path: "<unsaved>" };
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

/** A PanelHost whose AE answers from a script of results per host function, recording each call. */
function scriptedAe(results: Record<string, unknown[]>, fail: Record<string, string> = {}) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-animate-w5-"));
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      if (fail[fn]) return { ok: false, error: { message: fail[fn], kind: "runtime" } };
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("wave 5 animate: schemas", () => {
  const base = { comp_id: 1, layer: { name: "T" }, expect: expectArg };

  it("ae_set_text takes typography, paragraph, box and paragraphs calls", () => {
    for (const extra of [
      { style: { caps: "all", baseline: "superscript", kerning: "optical", ligature: false } },
      { style: { kerning: 25 } },
      { style: { font: { family: "Inter", style: "Bold" } } },
      { style: { font: { postscript: "Inter-Bold" } }, allow_substitute: true },
      { paragraph: { justify: "full_center", space_after: 12, direction: "rtl", composer: "universal" } },
      { box: { size: [600, 200], vertical_align: "top", auto_fit: "height_precise" } },
      { paragraphs: [{ index: 1, style: { fillColor: [1, 0, 0] } }, { match: "NOW", occurrence: "first", style: { fauxBold: true } }] },
    ]) {
      expect(AeSetTextSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(true);
    }
  });

  it("ae_set_text rejects bad typography values and contradictions", () => {
    for (const extra of [
      { style: { caps: "title" } },
      { style: { tsume: 101 } },
      { style: { kerning: "wide" } },
      { style: { leading: 40, auto_leading: true } },
      { style: { justification: "left" }, paragraph: { justify: "full" } },
      { box: {} },
      { box: { size: [100.5, 20] } },
      { box: { size: [0, 20] } },
      { box: { first_baseline: "ascent", first_baseline_min: 4 } },
      { paragraph: {} },
      { paragraph: { composer: "adobe" } },
      { paragraphs: [{ style: { fauxBold: true } }] },
      { paragraphs: [{ index: 0, match: "x", style: { fauxBold: true } }] },
      { paragraphs: [{ index: 0, occurrence: "first", style: { fauxBold: true } }] },
    ]) {
      expect(AeSetTextSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(AeSetTextSchema.safeParse({ ...base, style: { leading: 40, auto_leading: false } }).success).toBe(true);
  });

  it("ae_set_keyframe_ease takes per-key settings with or without an ease", () => {
    const k = { comp_id: 1, layer: { index: 1 }, path: ["Transform", "Position"], expect: expectArg };
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, in_interp: "linear", out_interp: "bezier", keys: [2] }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, ease: "easy_ease", roving: true, keys: [2] }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, in_tangent: [10, 0], out_tangent: [10, 0, 0], keys: "selected" }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, label: 5, temporal_auto_bezier: true }).success).toBe(true);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k }).success).toBe(false);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, label: 17 }).success).toBe(false);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, in_tangent: [1, 2, 3, 4] }).success).toBe(false);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, in_interp: "ease" }).success).toBe(false);
    expect(AeSetKeyframeEaseSchema.safeParse({ ...k, ease: "linear", keys: "all" }).success).toBe(false);
  });

  it("ae_import_footage takes import_as, range, placeholders and checks how they combine", () => {
    const e = { expect: expectArg };
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.psd"], import_as: "comp_cropped_layers", target_folder_id: 4, ...e }).success).toBe(true);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.aep"], import_as: "project", ...e }).success).toBe(true);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a_0001.png"], sequence: true, range: { start: 10, end: 20 }, ...e }).success).toBe(true);
    expect(
      AeImportFootageSchema.safeParse({ placeholders: [{ name: "Plate", width: 1920, height: 1080, fps: 24, duration: 5 }], ...e }).success
    ).toBe(true);
    expect(AeImportFootageSchema.safeParse({ ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], import_as: "layers", ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], range: { start: 1, end: 2 }, ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], sequence: true, range: { start: 5, end: 2 }, ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], sequence: true, range: { start: 1, end: 2 }, force_alphabetical: true, ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], sequence: true, import_as: "comp", ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ paths: ["C:/a.png"], force_alphabetical: true, ...e }).success).toBe(false);
    expect(AeImportFootageSchema.safeParse({ placeholders: [{ name: "P", width: 0, height: 10, fps: 24, duration: 1 }], ...e }).success).toBe(false);
  });

  it("ae_replace_footage separates replace from reload", () => {
    const e = { expect: expectArg };
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", item_ids: [3, 4], ...e }).success).toBe(true);
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", folder_id: 2, ...e }).success).toBe(true);
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", item_id: 3, ...e }).success).toBe(true);
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", ...e }).success).toBe(false);
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", item_ids: [1], folder_id: 2, ...e }).success).toBe(false);
    expect(AeReplaceFootageSchema.safeParse({ action: "reload", item_id: 3, path: "C:/x.mov", ...e }).success).toBe(false);
    expect(AeReplaceFootageSchema.safeParse({ item_id: 3, ...e }).success).toBe(false);
    expect(AeReplaceFootageSchema.safeParse({ item_id: 3, path: "C:/x.mov", folder_id: 2, ...e }).success).toBe(false);
  });
});

describe("wave 5 animate: pure logic", () => {
  it("usesTypedText only for the new options", () => {
    expect(usesTypedText({ style: { fontSize: 40, justification: "left" } })).toBe(false);
    expect(usesTypedText({ style: { caps: "all" } })).toBe(true);
    expect(usesTypedText({ paragraph: { justify: "full" } })).toBe(true);
    expect(usesTypedText({ box: { size: [1, 1] } })).toBe(true);
    expect(usesTypedText({ paragraphs: [] })).toBe(true);
  });

  it("roving keys are left out of the ease check, and a capped read marks missing keys unverified", () => {
    expect(rovingSkipKeys({ roving: [2], extras: { roving: [3, 2] } }).sort()).toEqual([2, 3]);
    expect(rovingSkipKeys(undefined)).toEqual([]);
    const snap = {
      keyframes: [
        { keyIndex: 1, inInterp: "bezier", outInterp: "bezier", easeIn: [{ speed: 0, influence: 33 }], easeOut: [{ speed: 0, influence: 33 }] },
        { keyIndex: 2, inInterp: "bezier", outInterp: "bezier", easeIn: [{ speed: 9, influence: 50 }], easeOut: [{ speed: 9, influence: 50 }] },
      ],
    };
    const check = extractKeyframeEaseCheck("easy_ease", [1, 2], snap, rovingSkipKeys({ extras: { roving: [2] } }));
    expect(JSON.stringify(check)).not.toContain('"keyIndex":2');
    const capped = keyExtrasMismatches({ label: 3 }, [900], { keyframes: [], truncated: true });
    expect(capped.mismatches).toEqual([]);
    expect(capped.unverified).toEqual(["keyframes[900]"]);
    expect(keyExtrasMismatches({ label: 3 }, [900], { keyframes: [] }).mismatches).toHaveLength(1);
  });

  it("typedTextChecks compares by name and treats mixed or missing as unverified", () => {
    const set = { typography: { caps: "all", ligature: false, kerning_value: 20 }, paragraph: { space_after: 12 }, box: { size: [600, 200] } };
    const after = {
      typography: { caps: "all", ligature: true },
      paragraph: { space_after: 12, justify: "full" },
      box: { size: [600, 200] },
      mixed: ["typography.kerning_value"],
    };
    const r = typedTextChecks(set, "full", after);
    expect(r.expected).toEqual({
      "typography.caps": "all",
      "typography.ligature": false,
      "paragraph.space_after": 12,
      "paragraph.justify": "full",
      "box.size": [600, 200],
    });
    expect(r.actual["typography.ligature"]).toBe(true);
    expect(r.unverified).toEqual(["typography.kerning_value"]);
    const none = typedTextChecks({ typography: { caps: "all" } }, undefined, {});
    expect(none.expected).toEqual({});
    expect(none.unverified).toEqual(["typography.caps"]);
  });

  it("layoutChanged compares the measured extent and the line count", () => {
    const rect = (h: number) => ({ top: 0, left: 0, width: 100, height: h });
    expect(layoutChanged({ source_rect: rect(100) }, { source_rect: rect(160) })).toBe(true);
    expect(layoutChanged({ source_rect: rect(100) }, { source_rect: rect(100.2) })).toBe(false);
    expect(layoutChanged({ composed_line_count: 2 }, { composed_line_count: 3 })).toBe(true);
    expect(layoutChanged(undefined, { source_rect: rect(1) })).toBe(null);
  });

  it("keyExtrasConflict catches contradictions before anything is sent", () => {
    expect(keyExtrasConflict("easy_ease", { in_interp: "linear" }, undefined)).toContain("differs");
    expect(keyExtrasConflict({ curve: [0.2, 0, 0.8, 1] }, { out_interp: "bezier" }, undefined)).toBeNull();
    expect(keyExtrasConflict("linear", { in_interp: "linear", out_interp: "linear" }, undefined)).toBeNull();
    expect(keyExtrasConflict(undefined, { in_interp: "linear", out_interp: "bezier" }, undefined)).toBeNull();
    expect(keyExtrasConflict("easy_ease", { roving: true }, true)).toContain("rove_between");
    expect(keyExtrasConflict(undefined, { spatial_auto_bezier: true, in_tangent: [1, 2] }, undefined)).toContain("auto_bezier");
    expect(keyExtrasConflict(undefined, { temporal_auto_bezier: true, temporal_continuous: false }, undefined)).toContain("implies");
    expect(keyExtrasConflict("easy_ease", undefined, undefined)).toBeNull();
  });

  it("keyExtrasMismatches flags wrong values and leaves unreadable ones unverified", () => {
    const after = {
      keyframes: [
        { keyIndex: 2, inInterp: "linear", outInterp: "bezier", inTangent: [10, 0, 0], roving: true, temporalContinuous: false },
      ],
    };
    const ok = keyExtrasMismatches({ in_interp: "linear", out_interp: "bezier", in_tangent: [10, 0, 0], roving: true }, [2], after);
    expect(ok.mismatches).toEqual([]);
    const bad = keyExtrasMismatches({ out_interp: "hold", in_tangent: [11, 0, 0], temporal_continuous: true, label: 3, spatial_continuous: true }, [2, 5], after);
    const paths = bad.mismatches.map((m) => m.path);
    expect(paths).toContain("keyframes[2].outInterp");
    expect(paths).toContain("keyframes[2].inTangent");
    expect(paths).toContain("keyframes[2].temporalContinuous");
    expect(paths).toContain("keyframes[5]");
    expect(bad.unverified).toContain("keyframes[2].label");
    expect(bad.unverified).toContain("keyframes[2].spatialContinuous");
    expect(paths).not.toContain("keyframes[2].label");
  });

  it("resolveTargetKeys reads the timeline selection from the key snapshot", () => {
    const snap = { keyframes: [{ keyIndex: 1, selected: false }, { keyIndex: 2, selected: true }, { keyIndex: 3, selected: true }] };
    expect(resolveTargetKeys("selected", snap)).toEqual({ keys: [2, 3] });
    expect(resolveTargetKeys([1], snap)).toEqual({ keys: [1] });
    expect(resolveTargetKeys(undefined, snap)).toEqual({ keys: undefined });
    expect(resolveTargetKeys("selected", { keyframes: [{ keyIndex: 1, selected: false }] })).toHaveProperty("error");
    expect(resolveTargetKeys("selected", { keyframes: [{ keyIndex: 1 }] })).toHaveProperty("error");
  });

  it("extractKeyframeEaseCheck has nothing to check without an ease, and extras that recompute ease are flagged", () => {
    expect(extractKeyframeEaseCheck(undefined, [1], { keyframes: [{ keyIndex: 1 }] })).toBeNull();
    expect(extrasRecomputeEase({ temporal_continuous: true })).toBe(true);
    expect(extrasRecomputeEase({ temporal_auto_bezier: true })).toBe(true);
    expect(extrasRecomputeEase({ spatial_continuous: true, roving: true })).toBe(false);
    expect(extrasRecomputeEase(undefined)).toBe(false);
    expect(pickKeyExtras({ ease: "linear", label: 3, roving: false })).toEqual({ label: 3, roving: false });
    expect(pickKeyExtras({ ease: "linear" })).toBeUndefined();
  });

  it("createdItemIds and importCreatedFields read what import_as created", () => {
    expect(createdItemIds({ item_ids: [5] })).toEqual([]);
    expect(createdItemIds({ item_ids: [5], new_comp_ids: [5], new_folder_ids: [6, 7] })).toEqual([5, 6, 7]);
    expect(importCreatedFields({ new_comp_ids: [5], main_comp_id: 5, created_folder_id: 6, notes: ["x"], other: 1 })).toEqual({
      new_comp_ids: [5],
      main_comp_id: 5,
      created_folder_id: 6,
      notes: ["x"],
    });
  });

  it("reloadChanges lists the items whose size or duration moved", () => {
    const before = [
      { item_id: 1, name: "a", width: 1920, height: 1080, duration: 5, frameRate: 24 },
      { item_id: 2, name: "b", width: 100, height: 100, duration: 2, frameRate: 25 },
    ];
    const after = [
      { item_id: 1, name: "a", width: 1920, height: 1080, duration: 7.5, frameRate: 24 },
      { item_id: 2, name: "b", width: 100, height: 100, duration: 2, frameRate: 25 },
    ];
    const changed = reloadChanges(before, after, [1, 2]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ item_id: 1, changed: ["duration"] });
  });
});

describe("wave 5 animate: guarded-write flow with a fake bridge", () => {
  const tool = (name: string) => animateTools.find((t) => t.name === name)!;
  const doc = { text: "Hello", font: "ArialMT", fontSize: 72, applyFill: true, fillColor: [1, 1, 1], justification: "left" };

  it("ae_set_text with typography reads the typed state and compares each option by name", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getTextDocument: [
        { document: doc, typography: { caps: "normal" }, paragraph: { justify: "left" }, box: {}, mixed: [], measure: { source_rect: { top: 0, left: 0, width: 100, height: 50 } } },
        {
          document: doc,
          typography: { caps: "all", ligature: true },
          paragraph: { justify: "full_center", space_after: 12 },
          box: {},
          mixed: [],
          measure: { source_rect: { top: 0, left: 0, width: 100, height: 90 } },
        },
      ],
      setText: [
        {
          applied: ["caps", "ligature", "justification", "space_after"],
          set: { typography: { caps: "all", ligature: false }, paragraph: { space_after: 12 }, box: {} },
          notes: ["x"],
        },
      ],
    });
    const args = AeSetTextSchema.parse({
      comp_id: 1,
      layer: { name: "T" },
      style: { caps: "all", ligature: false },
      paragraph: { justify: "full_center", space_after: 12 },
      expect: expectArg,
    });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "getTextDocument", "setText", "getTextDocument"]);
    expect(calls[1].script).toContain('"typography":true');
    expect(calls[1].script).toContain('"measure":true');
    expect(calls[3].script).toContain('"typography":true');
    expect(calls[2].script).toContain('"caps":"all"');
    expect(calls[2].script).toContain('"justify":"full_center"');
    // ligature was asked off but reads on: the one mismatch; justify, caps and spacing match.
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(["expected.typography.ligature"]);
    expect(out.layout.rewrapped).toBe(true);
  });

  it("ae_set_text counts a mixed value as unknown, not as a mismatch", async () => {
    const { ctx, cleanup } = scriptedAe({
      getTextDocument: [
        { document: doc, typography: {}, paragraph: {}, box: {}, mixed: [] },
        { document: doc, typography: {}, paragraph: { justify: "left" }, box: {}, mixed: ["typography.horizontal_scale"] },
      ],
      setText: [{ applied: ["horizontal_scale"], set: { typography: { horizontal_scale: 0.9 }, paragraph: {}, box: {} } }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { horizontal_scale: 0.9 }, expect: expectArg });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(out.receipt.matches).toBe(true);
    expect(out.unverified).toEqual(["typography.horizontal_scale"]);
  });

  it("ae_set_text leaves style.faux_bold to a range that starts at 0 and sets fauxBold itself", async () => {
    const { ctx, cleanup } = scriptedAe({
      getTextDocument: [
        { document: doc, typography: { faux_bold: false }, paragraph: {}, box: {}, mixed: [], ranges: [] },
        { document: doc, typography: { faux_bold: false }, paragraph: {}, box: {}, mixed: [], ranges: [{ start: 0, end: 3, style: { fauxBold: false } }] },
      ],
      setText: [
        {
          applied: ["faux_bold"],
          set: { typography: { faux_bold: true }, paragraph: {}, box: {} },
          ranges: [{ start: 0, end: 3, style: { fauxBold: false } }],
        },
      ],
    });
    const args = AeSetTextSchema.parse({
      comp_id: 1,
      layer: { name: "T" },
      style: { faux_bold: true },
      ranges: [{ start: 0, end: 3, style: { fauxBold: false } }],
      expect: expectArg,
    });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
    expect(out.unverified).toContain("typography.faux_bold");
  });

  it("ae_set_text keeps its old read scripts when no new option is used", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getTextDocument: [{ document: doc }, { document: { ...doc, fontSize: 40 } }],
      setText: [{ applied: ["fontSize"] }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { fontSize: 40 }, expect: expectArg });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(calls[1].script).not.toContain("typography");
    expect(calls[1].script).not.toContain("measure");
    expect(out.layout).toBeUndefined();
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_set_text expects the font the host resolved and flags a substituted font", async () => {
    const { ctx, cleanup } = scriptedAe({
      getTextDocument: [{ document: doc }, { document: { ...doc, font: "Inter-Bold", fontObject: { postscript: "Inter-Bold", is_substitute: true } } }],
      setText: [{ applied: ["font"], fonts: { document: { postscript: "Inter-Bold", family: "Inter", style: "Bold", checked: true }, ranges: [] } }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { font: { family: "Inter", style: "Bold" } }, expect: expectArg });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(["font"]);

    const again = scriptedAe({
      getTextDocument: [{ document: doc }, { document: { ...doc, font: "Ghost", fontObject: { postscript: "Ghost", is_substitute: true } } }],
      setText: [{ applied: ["font"], warnings: ["no glyphs"] }],
    });
    const allowed = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { font: "Ghost" }, allow_substitute: true, expect: expectArg });
    const out2: any = await tool("ae_set_text").handler(allowed, again.ctx);
    again.cleanup();
    expect(out2.receipt.matches).toBe(true);
    expect(out2.warnings).toHaveLength(2);
  });

  it("ae_set_text reports a failed read-back instead of throwing after the write", async () => {
    const { ctx, cleanup } = scriptedAe({ getTextDocument: [{ document: doc }], setText: [{ applied: ["caps"], set: { typography: { caps: "all" } } }] }, {});
    // the second getTextDocument has nothing scripted: the fake throws, which readAfterWrite must catch.
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { caps: "all" }, expect: expectArg });
    const out: any = await tool("ae_set_text").handler(args, ctx);
    cleanup();
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("ae_set_keyframe_ease with only per-key settings calls animateKeyExtras and verifies them", async () => {
    const snap = (extra: Record<string, unknown>) => ({
      name: "Position",
      isSpatial: true,
      numKeys: 3,
      keyframes: [
        { keyIndex: 1, time: 0, value: [0, 0, 0], inInterp: "bezier", outInterp: "bezier", easeIn: [], easeOut: [], selected: false },
        { keyIndex: 2, time: 1, value: [10, 0, 0], inInterp: "bezier", outInterp: "bezier", easeIn: [], easeOut: [], selected: true, ...extra },
        { keyIndex: 3, time: 2, value: [20, 0, 0], inInterp: "bezier", outInterp: "bezier", easeIn: [], easeOut: [], selected: false },
      ],
    });
    const { ctx, calls, cleanup } = scriptedAe({
      getKeyframeEase: [snap({}), snap({ inInterp: "linear", outInterp: "bezier", label: 4 })],
      animateKeyExtras: [{ keysUpdated: [2], mode: "extras", extras: { applied: ["interpolation", "label"], roving: [], roving_failed: [] } }],
    });
    const args = AeSetKeyframeEaseSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      path: ["Transform", "Position"],
      keys: "selected",
      in_interp: "linear",
      out_interp: "bezier",
      label: 4,
      expect: expectArg,
    });
    const out: any = await tool("ae_set_keyframe_ease").handler(args, ctx);
    cleanup();
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "getKeyframeEase", "animateKeyExtras", "getKeyframeEase"]);
    expect(calls[2].script).toContain('"keys":[2]');
    expect(calls[2].script).toContain('"in_interp":"linear"');
    expect(out.keys_resolved).toEqual([2]);
    expect(out.receipt.matches).toBe(true);

    const bad = scriptedAe({
      getKeyframeEase: [snap({}), snap({ inInterp: "bezier", outInterp: "bezier", label: 0 })],
      animateKeyExtras: [{ keysUpdated: [2], mode: "extras", extras: { applied: [], roving: [], roving_failed: [] } }],
    });
    const out2: any = await tool("ae_set_keyframe_ease").handler(args, bad.ctx);
    bad.cleanup();
    expect(out2.receipt.matches).toBe(false);
    expect(out2.receipt.mismatches.map((m: any) => m.path).sort()).toEqual(["keyframes[2].inInterp", "keyframes[2].label"]);
  });

  it("ae_set_keyframe_ease refuses keys 'selected' when none are selected, before writing", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getKeyframeEase: [{ numKeys: 2, keyframes: [{ keyIndex: 1, selected: false }, { keyIndex: 2, selected: false }] }],
    });
    const args = AeSetKeyframeEaseSchema.parse({ comp_id: 1, layer: { index: 1 }, path: ["Transform", "Position"], keys: "selected", ease: "easy_ease", expect: expectArg });
    const out: any = await tool("ae_set_keyframe_ease").handler(args, ctx);
    cleanup();
    expect(out.ok).toBe(false);
    expect(out.message).toContain("No keys are selected");
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "getKeyframeEase"]);
  });

  it("ae_set_keyframe_ease refuses contradictory settings before touching AE", async () => {
    const { ctx, calls, cleanup } = scriptedAe({});
    const args = AeSetKeyframeEaseSchema.parse({ comp_id: 1, layer: { index: 1 }, path: ["Transform", "Position"], ease: "easy_ease", in_interp: "hold", expect: expectArg });
    const out: any = await tool("ae_set_keyframe_ease").handler(args, ctx);
    cleanup();
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("ae_set_keyframe_ease with an ease and temporal continuity skips the ease check and says so", async () => {
    const key = (n: number) => ({ keyIndex: n, time: n, value: 0, inInterp: "bezier", outInterp: "bezier", easeIn: [{ speed: 0, influence: 70 }], easeOut: [{ speed: 5, influence: 20 }], temporalContinuous: true });
    const { ctx, calls, cleanup } = scriptedAe({
      getKeyframeEase: [{ numKeys: 2, keyframes: [key(1), key(2)] }, { numKeys: 2, keyframes: [key(1), key(2)] }],
      setKeyframeEase: [{ keysUpdated: [1, 2], roving: [], extras: { applied: ["temporal_continuous"], roving: [], roving_failed: [] } }],
    });
    const args = AeSetKeyframeEaseSchema.parse({ comp_id: 1, layer: { index: 1 }, path: ["Transform", "Opacity"], ease: "easy_ease", temporal_continuous: true, expect: expectArg });
    const out: any = await tool("ae_set_keyframe_ease").handler(args, ctx);
    cleanup();
    expect(calls[2].script).toContain('"extras":{"temporal_continuous":true}');
    expect(out.receipt.matches).toBe(true);
    expect(out.notes[0]).toContain("not checked");
  });

  it("ae_import_footage import_as comp reads back the comp and the folder it created", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getFootageItems: [
        { item_ids: [1] },
        { item_ids: [11, 12, 13], items: [] },
      ],
      importFootage: [
        {
          item_ids: [11],
          items: [{ id: 11, typeName: "Composition" }],
          import_as: "comp",
          new_comp_ids: [11],
          new_folder_ids: [12],
          main_comp_id: 11,
          created_folder_id: 12,
          notes: [],
        },
      ],
    });
    const args = AeImportFootageSchema.parse({ paths: ["C:/art/logo.psd"], import_as: "comp", expect: expectArg });
    const out: any = await tool("ae_import_footage").handler(args, ctx);
    cleanup();
    // The footage layer (13) is not in the created list, so the read-back asks for 11 and 12 only.
    expect(calls[2].script).toContain('"import_as":"comp"');
    expect(calls[3].script).toContain('"item_ids":[11,12]');
    expect(out.new_comp_ids).toEqual([11]);
    expect(out.main_comp_id).toBe(11);
    expect(out.created_folder_id).toBe(12);
    expect(out.receipt.matches).toBe(false);
  });

  it("ae_import_footage import_as comp passes when everything created is found", async () => {
    const { ctx, cleanup } = scriptedAe({
      getFootageItems: [{ item_ids: [1] }, { item_ids: [11, 12], items: [] }],
      importFootage: [{ item_ids: [11], items: [], new_comp_ids: [11], new_folder_ids: [12], main_comp_id: 11, created_folder_id: 12 }],
    });
    const args = AeImportFootageSchema.parse({ paths: ["C:/art/logo.psd"], import_as: "comp", expect: expectArg });
    const out: any = await tool("ae_import_footage").handler(args, ctx);
    cleanup();
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_import_footage counts placeholders with the files", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getFootageItems: [{ item_ids: [] }, { item_ids: [21, 22], items: [] }],
      importFootage: [{ item_ids: [21, 22], items: [], placeholder_ids: [22] }],
    });
    const args = AeImportFootageSchema.parse({
      paths: ["C:/a.mov"],
      placeholders: [{ name: "Plate", width: 1920, height: 1080, fps: 24, duration: 5 }],
      expect: expectArg,
    });
    const out: any = await tool("ae_import_footage").handler(args, ctx);
    cleanup();
    expect(calls[2].script).toContain('"placeholders":[{"name":"Plate"');
    expect(out.placeholder_ids).toEqual([22]);
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_import_footage keeps its old write script for a plain import", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getFootageItems: [{ item_ids: [] }, { item_ids: [5], items: [] }],
      importFootage: [{ item_ids: [5], items: [] }],
    });
    const args = AeImportFootageSchema.parse({ paths: ["C:/a.mov"], sequence: true, fps: 24, expect: expectArg });
    await tool("ae_import_footage").handler(args, ctx);
    cleanup();
    expect(calls[2].script).not.toContain("import_as");
    expect(calls[2].script).not.toContain("range");
    expect(calls[2].script).not.toContain("placeholders");
  });

  it("ae_replace_footage reload reads, reloads and reports what changed", async () => {
    const item = (duration: number) => ({ item_id: 7, name: "plate.mov", width: 1920, height: 1080, duration, frameRate: 24, footageMissing: false, reloadable: true });
    const { ctx, calls, cleanup } = scriptedAe({
      animateReloadTargets: [{ items: [item(5)] }, { items: [item(8)] }],
      animateReloadFootage: [{ item_ids: [7], reloaded: [7], skipped: [{ item_id: 9, name: "solid", reason: "its source is not a file" }] }],
    });
    const args = AeReplaceFootageSchema.parse({ action: "reload", folder_id: 3, expect: expectArg });
    const out: any = await tool("ae_replace_footage").handler(args, ctx);
    cleanup();
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "animateReloadTargets", "animateReloadFootage", "animateReloadTargets"]);
    expect(calls[1].script).toContain('"folder_id":3');
    expect(calls[3].script).toContain('"item_ids":[7]');
    expect(out.reloaded).toEqual([7]);
    expect(out.changed_items).toHaveLength(1);
    expect(out.changed_items[0]).toMatchObject({ item_id: 7, changed: ["duration"] });
    expect(out.skipped).toHaveLength(1);
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_replace_footage reload flags an item that is still missing and returns no_op when nothing could reload", async () => {
    const missing = { item_id: 7, name: "plate.mov", width: 1920, height: 1080, duration: 5, frameRate: 24, footageMissing: true };
    const a = scriptedAe({
      animateReloadTargets: [{ items: [{ ...missing, footageMissing: false }] }, { items: [missing] }],
      animateReloadFootage: [{ item_ids: [7], reloaded: [7], skipped: [], failed: [{ item_id: 8, name: "x", error: "boom" }] }],
    });
    const out: any = await tool("ae_replace_footage").handler(AeReplaceFootageSchema.parse({ action: "reload", item_id: 7, expect: expectArg }), a.ctx);
    a.cleanup();
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path).sort()).toEqual(["items[7].footageMissing", "items[8].reload"]);

    const b = scriptedAe({
      animateReloadTargets: [{ items: [] }],
      animateReloadFootage: [{ no_op: true, item_ids: [], reloaded: [], skipped: [{ item_id: 9, name: "solid", reason: "its source is not a file" }] }],
    });
    const out2: any = await tool("ae_replace_footage").handler(AeReplaceFootageSchema.parse({ action: "reload", folder_id: 3, expect: expectArg }), b.ctx);
    expect(out2.no_op).toBe(true);
    expect(b.calls.map((c) => c.fn)).toEqual(["checkGuard", "animateReloadTargets", "animateReloadFootage"]);
    b.cleanup();
  });

  it("ae_replace_footage keeps replacing when no action is given", async () => {
    const { ctx, calls, cleanup } = scriptedAe({
      getFootageItem: [{ file: "C:/old.mov", footageMissing: true }, { file: "C:/new.mov", footageMissing: false }],
      replaceFootage: [{ item_id: 5, before_file: "C:/old.mov", requested_path: "C:/new.mov" }],
    });
    const out: any = await tool("ae_replace_footage").handler(
      AeReplaceFootageSchema.parse({ item_id: 5, path: "C:/new.mov", expect: expectArg }),
      ctx
    );
    cleanup();
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "getFootageItem", "replaceFootage", "getFootageItem"]);
    expect(out.receipt.matches).toBe(true);
  });
});

// ---------- the host functions under node:vm ----------

const PJ_ENUM = {
  LEFT_JUSTIFY: 7413,
  RIGHT_JUSTIFY: 7414,
  CENTER_JUSTIFY: 7415,
  FULL_JUSTIFY_LASTLINE_LEFT: 7416,
  FULL_JUSTIFY_LASTLINE_RIGHT: 7417,
  FULL_JUSTIFY_LASTLINE_CENTER: 7418,
  FULL_JUSTIFY_LASTLINE_FULL: 7419,
};

const TEXT_ENUMS = {
  ParagraphJustification: PJ_ENUM,
  FontCapsOption: { FONT_NORMAL_CAPS: 1, FONT_SMALL_CAPS: 2, FONT_ALL_CAPS: 3, FONT_ALL_SMALL_CAPS: 4 },
  FontBaselineOption: { FONT_NORMAL_BASELINE: 11, FONT_SUPERSCRIPT: 12, FONT_SUBSCRIPT: 13 },
  AutoKernType: { NO_AUTO_KERN: 21, METRIC_KERN: 22, OPTICAL_KERN: 23 },
  LineJoinType: { LINE_JOIN_MITER: 31, LINE_JOIN_ROUND: 32, LINE_JOIN_BEVEL: 33 },
  LeadingType: { ROMAN_LEADING_TYPE: 41, JAPANESE_LEADING_TYPE: 42 },
  Direction: { LEFT_TO_RIGHT_DIRECTION: 51, RIGHT_TO_LEFT_DIRECTION: 52 },
  ComposerEngine: { UNIVERSAL_TYPE_ENGINE: 61 },
  BoxVerticalAlignment: { TOP_BOX_ALIGN: 71, CENTER_BOX_ALIGN: 72, BOTTOM_BOX_ALIGN: 73, JUSTIFY_BOX_ALIGN: 74 },
  BoxAutoFitPolicy: { NONE_FIT: 81, HEIGHT_CURSOR_FIT: 82, HEIGHT_PRECISE_FIT: 83, HEIGHT_BASELINE_FIT: 84 },
  BoxFirstBaselineAlignment: { ASCENT_ALIGN: 91, CAP_HEIGHT_ALIGN: 92, LEADING_ALIGN: 93 },
  LineOrientation: { HORIZONTAL: 101, VERTICAL_RIGHT_TO_LEFT: 102, VERTICAL_LEFT_TO_RIGHT: 103 },
  DigitSet: { DEFAULT_DIGITS: 111, ARABIC_DIGITS: 112, HINDI_DIGITS: 113 },
  BaselineDirection: { BASELINE_WITH_STREAM: 121, BASELINE_VERTICAL_ROTATED: 122, BASELINE_VERTICAL_CROSS_STREAM: 123 },
};

const CHAR_KEYS = ["font", "fontSize", "tracking", "baselineShift", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "fauxBold", "fauxItalic"];

/** A TextDocument for the vm host: every 24.x member as a plain field, copy on read, per-character styles for ranges. */
class TDoc {
  font = "ArialMT";
  fontSize = 72;
  tracking = 0;
  leading = 0;
  applyFill = true;
  fillColor = [1, 1, 1];
  applyStroke = false;
  strokeColor = [0, 0, 0];
  strokeWidth = 0;
  justification = PJ_ENUM.LEFT_JUSTIFY;
  fontObject: any = { isSubstitute: false, postScriptName: "ArialMT", familyName: "Arial", styleName: "Regular" };
  fontCapsOption = 1;
  fontBaselineOption = 11;
  autoKernType = 22;
  kerning = 0;
  ligature = true;
  noBreak = false;
  horizontalScale = 1;
  verticalScale = 1;
  tsume = 0;
  strokeOverFill = false;
  lineJoinType = 31;
  autoLeading = true;
  digitSet = 111;
  baselineDirection = 121;
  lineOrientation = 101;
  fauxBold = false;
  fauxItalic = false;
  spaceBefore = 0;
  spaceAfter = 0;
  firstLineIndent = 0;
  startIndent = 0;
  endIndent = 0;
  everyLineComposer = false;
  hangingRoman = false;
  autoHyphenate = false;
  leadingType = 41;
  direction = 51;
  composerEngine = 61;
  pointText = false;
  boxText = true;
  boxTextSize: number[] = [400, 200];
  boxTextPos: number[] = [0, 0];
  boxVerticalAlignment = 71;
  boxAutoFitPolicy = 81;
  boxInsetSpacing: number[] = [0, 0, 0, 0];
  boxFirstBaselineAlignment = 91;
  boxFirstBaselineAlignmentMinimum = 0;
  chars: any[] = [];
  /** Members this fake AE lacks (an older build): never copied out. */
  omit: string[] = [];
  private value = "";
  constructor(text: string) {
    this.setText(text);
  }
  setText(t: string) {
    this.value = t;
    this.chars = Array.from(t, (_c, i) => this.chars[i] ?? { fillColor: [1, 1, 1], fauxBold: false });
  }
  get text() {
    return this.value;
  }
  set text(v: string) {
    this.setText(v);
  }
  characterRange(start: number, end: number) {
    if (start < 0 || end <= start || end > this.value.length) throw new Error("Invalid character range");
    return new TRange(this, start, end);
  }
  clone(): TDoc {
    const d = new TDoc(this.value);
    Object.assign(d, JSON.parse(JSON.stringify({ ...this, value: undefined, chars: undefined })));
    for (const k of this.omit) delete (d as any)[k];
    d.chars = JSON.parse(JSON.stringify(this.chars));
    return d;
  }
  assignFrom(d: any) {
    for (const k of Object.keys(d)) {
      if (typeof d[k] === "function" || k === "chars") continue;
      (this as any)[k] = d[k] !== null && typeof d[k] === "object" ? JSON.parse(JSON.stringify(d[k])) : d[k];
    }
    this.chars = JSON.parse(JSON.stringify(d.chars));
    this.value = d.value;
  }
}
class TRange {
  constructor(private d: TDoc, private s: number, private e: number) {}
  get text() {
    return this.d.text.substring(this.s, this.e);
  }
}
for (const k of CHAR_KEYS) {
  Object.defineProperty(TRange.prototype, k, {
    get(this: any) {
      const vals = this.d.chars.slice(this.s, this.e).map((c: any) => JSON.stringify(c[k]));
      return vals.every((v: string) => v === vals[0]) && vals[0] !== undefined ? JSON.parse(vals[0]) : undefined;
    },
    set(this: any, v: unknown) {
      for (let i = this.s; i < this.e; i++) this.d.chars[i][k] = v;
    },
  });
}

function textScene(opts: { text?: string; omit?: string[]; point?: boolean; fonts?: any } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const state = new TDoc(opts.text ?? "Hello world");
  state.omit = opts.omit ?? [];
  for (const k of state.omit) delete (state as any)[k];
  if (opts.point) {
    state.pointText = true;
    state.boxText = false;
  }
  const layer = comp.layers.addText(state.text) as any;
  layer.name = "Title";
  const prop = (layer.property("ADBE Text Properties") as any).property("ADBE Text Document");
  const log = { setValue: 0 };
  Object.defineProperty(prop, "value", { get: () => state.clone(), configurable: true });
  prop.setValue = (d: any) => {
    log.setValue++;
    state.assignFrom(d);
  };
  const host = loadHost(project, ["animate.jsx"], opts.fonts ? { fonts: opts.fonts } : {});
  Object.assign(host.G, TEXT_ENUMS);
  return { project, comp, layer, state, log, ...host };
}

const sel = (comp: any) => ({ comp_id: comp.id, layer: { name: "Title" }, expect: GUARD });

describe("wave 5 animate: ae_set_text host (typography, paragraph, box)", () => {
  it("writes the character options and reads them back by name", () => {
    const { A, comp, state, undo } = textScene();
    const res = plain(
      A.setText({
        ...sel(comp),
        style: { caps: "all", baseline: "superscript", kerning: "optical", ligature: false, no_break: true, horizontal_scale: 0.9, stroke_over_fill: true, line_join: "round", faux_bold: true, line_orientation: "horizontal" },
      })
    );
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(state.fontCapsOption).toBe(3);
    expect(state.fontBaselineOption).toBe(12);
    expect(state.autoKernType).toBe(23);
    expect(state.ligature).toBe(false);
    expect(state.noBreak).toBe(true);
    expect(state.horizontalScale).toBe(0.9);
    expect(state.strokeOverFill).toBe(true);
    expect(state.lineJoinType).toBe(32);
    expect(state.fauxBold).toBe(true);
    expect(res.applied).toEqual(expect.arrayContaining(["caps", "baseline", "kerning", "ligature", "faux_bold"]));
    expect(res.set.typography).toMatchObject({ caps: "all", baseline: "superscript", kerning_mode: "optical", ligature: false, horizontal_scale: 0.9, line_join: "round" });

    const read = plain(A.getTextDocument({ ...sel(comp), typography: true, measure: true }));
    expect(read.typography).toMatchObject({ caps: "all", baseline: "superscript", kerning_mode: "optical", ligature: false, no_break: true, line_join: "round", faux_bold: true });
    expect(read.mixed).toEqual([]);
    // additive: the old fields stay, the full TextDocument read adds fontObject and more
    expect(read.document).toMatchObject({ text: "Hello world", font: "ArialMT", fontSize: 72, justification: "left" });
    expect(read.document.fontObject).toMatchObject({ postscript: "ArialMT", is_substitute: false });
  });

  it("a numeric kerning is noted, and leading switches auto leading off in the receipt", () => {
    const { A, comp, state } = textScene();
    const res = plain(A.setText({ ...sel(comp), style: { kerning: 40, leading: 90 } }));
    expect(state.kerning).toBe(40);
    expect(res.set.typography).toMatchObject({ kerning_value: 40, auto_leading: false });
    expect(res.notes.join(" ")).toContain("automatic kerning");
    expect(res.notes.join(" ")).toContain("auto leading off");
  });

  it("refuses leading together with auto_leading true, and a name this build lacks, without opening an undo group", () => {
    const { A, comp, undo, log } = textScene();
    expect(() => A.setText({ ...sel(comp), style: { leading: 90, auto_leading: true } })).toThrow(/contradict/);
    expect(() => A.setText({ ...sel(comp), style: { digit_set: "klingon" } })).toThrow(/is not a member of DigitSet here \(it has: .*ARABIC_DIGITS/);
    expect(() => A.setText({ ...sel(comp), style: { digit_set: "arabic" } })).not.toThrow();
    expect(undo.begun).toBe(1);
    expect(log.setValue).toBe(1);
  });

  it("refuses on an older AE with the version, before anything is written", () => {
    const { A, comp, state, undo, log } = textScene({ omit: ["fontBaselineOption", "boxTextSize"] });
    expect(() => A.setText({ ...sel(comp), text: "New", style: { caps: "all", baseline: "subscript" } })).toThrow(/style\.baseline needs After Effects 24\.0.*TextDocument\.fontBaselineOption/);
    expect(() => A.setText({ ...sel(comp), box: { size: [100, 50] } })).toThrow(/24\.6/);
    expect(undo.begun).toBe(0);
    expect(log.setValue).toBe(0);
    expect(state.text).toBe("Hello world");
    expect(state.fontCapsOption).toBe(1);
  });

  it("paragraph options: full justification keeps the re-assert pass, spacing, indents and RTL", () => {
    const { A, comp, state } = textScene();
    const res = plain(A.setText({ ...sel(comp), paragraph: { justify: "full_center", space_before: 6, space_after: 12, first_line_indent: -10, start_indent: 20, end_indent: 4, every_line_composer: true, hanging_roman: true, auto_hyphenate: true, leading_type: "japanese", direction: "rtl", composer: "universal" } }));
    expect(state.justification).toBe(PJ_ENUM.FULL_JUSTIFY_LASTLINE_CENTER);
    expect(state.spaceBefore).toBe(6);
    expect(state.spaceAfter).toBe(12);
    expect(state.firstLineIndent).toBe(-10);
    expect(state.direction).toBe(52);
    expect(state.leadingType).toBe(42);
    expect(state.composerEngine).toBe(61);
    expect(res.justification).toBe("full_center");
    expect(res.justify).toBe("full_center");
    expect(res.notes.join(" ")).toContain("one-way");
    const read = plain(A.getTextDocument({ ...sel(comp), typography: true }));
    expect(read.paragraph).toMatchObject({ justify: "full_center", space_after: 12, direction: "rtl", leading_type: "japanese", composer: "universal" });
  });

  it("refuses both justification keys at once", () => {
    const { A, comp, undo } = textScene();
    expect(() => A.setText({ ...sel(comp), style: { justification: "left" }, paragraph: { justify: "full" } })).toThrow(/give one of them/);
    expect(undo.begun).toBe(0);
  });

  it("box options: size, alignment, inset and first baseline, then a rewrap measure", () => {
    const { A, comp, state } = textScene();
    const res = plain(A.setText({ ...sel(comp), box: { size: [600, 220], position: [10, 20], vertical_align: "center", inset: 8, first_baseline: "cap_height" } }));
    expect(state.boxTextSize).toEqual([600, 220]);
    expect(state.boxTextPos).toEqual([10, 20]);
    expect(state.boxVerticalAlignment).toBe(72);
    expect(state.boxInsetSpacing).toEqual([8, 8, 8, 8]);
    expect(state.boxFirstBaselineAlignment).toBe(92);
    expect(res.set.box).toMatchObject({ size: [600, 220], inset: [8, 8, 8, 8] });
    const read = plain(A.getTextDocument({ ...sel(comp), typography: true, measure: true }));
    expect(read.box).toMatchObject({ size: [600, 220], position: [10, 20], inset: [8, 8, 8, 8], box_text: true, point_text: false, vertical_align: "center" });
    expect(read.measure.box_size).toEqual([600, 220]);
  });

  it("enum options are stored by their normalised name so the receipt matches, and an ambiguous partial name is refused", () => {
    const { A, comp, state, G } = textScene();
    (G as any).DigitSet = { DEFAULT_DIGITS: 111, ARABIC_DIGITS: 112, ARABIC_DIGITS_RTL: 114, HINDI_DIGITS: 113 };
    expect(() => A.setText({ ...sel(comp), style: { digit_set: "arabic" } })).toThrow(/matches several members of DigitSet.*ARABIC_DIGITS_RTL/);
    const res = plain(A.setText({ ...sel(comp), style: { digit_set: "Arabic_Digits" }, box: { first_baseline: "cap_height" } }));
    expect(state.digitSet).toBe(112);
    expect(res.set.typography.digit_set).toBe("arabic_digits");
    expect(res.set.box.first_baseline).toBe("cap_height_align");
    const after = plain(A.getTextDocument({ ...sel(comp), typography: true }));
    const checks = typedTextChecks(res.set, undefined, after);
    expect(checks.unverified).toEqual([]);
    for (const k of Object.keys(checks.expected)) expect(checks.actual[k]).toEqual(checks.expected[k]);
    expect(checks.expected["typography.digit_set"]).toBe("arabic_digits");
    expect(checks.expected["box.first_baseline"]).toBe("cap_height_align");
  });

  it("box refusals: point text, auto fit without top alignment, a wrong inset length, size, baseline conflict", () => {
    const point = textScene({ point: true });
    expect(() => point.A.setText({ ...sel(point.comp), box: { size: [100, 50] } })).toThrow(/point text/);
    expect(point.undo.begun).toBe(0);

    const s = textScene();
    s.state.boxVerticalAlignment = 72;
    expect(() => s.A.setText({ ...sel(s.comp), box: { auto_fit: "height_precise" } })).toThrow(/vertical_align "top"/);
    expect(() => s.A.setText({ ...sel(s.comp), box: { vertical_align: "top", auto_fit: "height_precise" } })).not.toThrow();
    expect(s.state.boxAutoFitPolicy).toBe(83);
    expect(() => s.A.setText({ ...sel(s.comp), box: { inset: [1, 2] } })).toThrow(/needs 4 numbers/);
    expect(() => s.A.setText({ ...sel(s.comp), box: { size: [0, 5] } })).toThrow(/whole numbers from 1/);
    expect(() => s.A.setText({ ...sel(s.comp), box: { first_baseline: "ascent", first_baseline_min: 3 } })).toThrow(/disables/);
    expect(() => s.A.setText({ ...sel(s.comp), box: { first_baseline: "nonsense" } })).toThrow(/not a member of BoxFirstBaselineAlignment/);
  });

  it("paragraphs: character styles per paragraph by index or by a word they contain", () => {
    const { A, comp, state } = textScene({ text: "First line\rSecond NOW line\rThird" });
    const res = plain(A.setText({ ...sel(comp), paragraphs: [{ index: 0, style: { fillColor: [1, 0, 0] } }, { match: "NOW", style: { fauxBold: true } }] }));
    expect(res.ranges.map((r: any) => [r.start, r.end])).toEqual([[0, 10], [11, 26]]);
    expect(state.chars[0].fillColor).toEqual([1, 0, 0]);
    expect(state.chars[5].fillColor).toEqual([1, 0, 0]);
    expect(state.chars[10].fillColor).toEqual([1, 1, 1]);
    expect(state.chars[12].fauxBold).toBe(true);
    expect(state.chars[26].fauxBold).toBe(false);
    expect(() => A.setText({ ...sel(comp), paragraphs: [{ index: 9, style: { fauxBold: true } }] })).toThrow(/does not exist/);
    expect(() => A.setText({ ...sel(comp), paragraphs: [{ match: "zzz", style: { fauxBold: true } }] })).toThrow(/no paragraph contains/);
    // a paragraph and a range that overlap and set the same field are refused, as ranges are
    expect(() =>
      A.setText({ ...sel(comp), ranges: [{ start: 2, end: 5, style: { fillColor: [0, 1, 0] } }], paragraphs: [{ index: 0, style: { fillColor: [1, 0, 0] } }] })
    ).toThrow(/overlap/);
  });

  it("paragraphs on an AE without characterRange are refused before the write", () => {
    const { A, comp, state, undo } = textScene();
    const orig = TDoc.prototype.characterRange;
    try {
      (TDoc.prototype as any).characterRange = undefined;
      expect(() => A.setText({ ...sel(comp), paragraphs: [{ index: 0, style: { fauxBold: true } }] })).toThrow(/24\.3/);
    } finally {
      TDoc.prototype.characterRange = orig;
    }
    expect(undo.begun).toBe(0);
    expect(state.chars.every((c: any) => c.fauxBold === false)).toBe(true);
  });
});

class FakeFont {
  isSubstitute = false;
  hasDesignAxes = false;
  designAxesData: any[] = [];
  fontID = 1;
  nativeFamilyName: string;
  constructor(public postScriptName: string, public familyName: string, public styleName: string, public glyphs?: string) {
    this.nativeFamilyName = familyName;
  }
  get fullName() {
    return `${this.familyName} ${this.styleName}`;
  }
  hasGlyphsFor(text: string) {
    if (this.glyphs === undefined) return true;
    return [...text].every((c) => this.glyphs!.includes(c));
  }
}

function fontsFixture() {
  const inter = new FakeFont("Inter-Bold", "Inter", "Bold");
  const interReg = new FakeFont("Inter-Regular", "Inter", "Regular", "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const ghost = new FakeFont("GhostFont", "Ghost", "Regular");
  ghost.isSubstitute = true;
  const all = [inter, interReg, ghost];
  return {
    inter,
    fonts: {
      allFonts: [[inter, interReg], [ghost]],
      getFontsByPostScriptName: (ps: string) => all.filter((f) => f.postScriptName === ps),
      getFontsByFamilyNameAndStyleName: (fam: string, st: string) => all.filter((f) => f.familyName === fam && f.styleName === st),
    },
  };
}

describe("wave 5 animate: ae_set_text host (font check)", () => {
  it("resolves {family, style} and a PostScript name, writing the resolved name as fontObject", () => {
    const { fonts, inter } = fontsFixture();
    const { A, comp, state } = textScene({ fonts });
    const res = plain(A.setText({ ...sel(comp), style: { font: { family: "Inter", style: "Bold" } } }));
    expect(res.fonts.document).toMatchObject({ postscript: "Inter-Bold", family: "Inter", style: "Bold", checked: true });
    expect(state.fontObject.postScriptName).toBe(inter.postScriptName);
    const res2 = plain(A.setText({ ...sel(comp), style: { font: { postscript: "Inter-Regular" } } }));
    expect(res2.fonts.document.postscript).toBe("Inter-Regular");
  });

  it("refuses an unknown font with the near matches, and allow_substitute writes the name anyway", () => {
    const { fonts } = fontsFixture();
    const { A, comp, state, undo } = textScene({ fonts });
    expect(() => A.setText({ ...sel(comp), style: { font: "Inter-Bld" } })).toThrow(/No installed font matches "Inter-Bld".*Inter-Bold/);
    expect(undo.begun).toBe(0);
    expect(state.font).toBe("ArialMT");
    expect(() => A.setText({ ...sel(comp), style: { font: { family: "Nope", style: "Regular" } }, allow_substitute: true })).toThrow(/needs a PostScript name/);
    const res = plain(A.setText({ ...sel(comp), style: { font: "Inter-Bld" }, allow_substitute: true }));
    expect(state.font).toBe("Inter-Bld");
    expect(res.fonts.document).toMatchObject({ postscript: "Inter-Bld", unresolved: true });
    // a font AE would substitute is refused too
    expect(() => A.setText({ ...sel(comp), style: { font: "GhostFont" } })).toThrow(/substitute/);
  });

  it("checks a range font the same way and writes its resolved name", () => {
    const { fonts } = fontsFixture();
    const { A, comp, state } = textScene({ fonts, text: "GO NOW" });
    expect(() => A.setText({ ...sel(comp), ranges: [{ match: "NOW", style: { font: "Nope-Bold" } }] })).toThrow(/Range 0 font/);
    const res = plain(A.setText({ ...sel(comp), ranges: [{ match: "NOW", style: { font: { family: "Inter", style: "Bold" } } }] }));
    expect(res.ranges[0].style.font).toBe("Inter-Bold");
    expect(res.fonts.ranges[0]).toMatchObject({ range: 0, font: { postscript: "Inter-Bold" } });
    expect(state.chars[4].font).toBe("Inter-Bold");
  });

  it("warns about glyphs the font lacks in the new text, without refusing", () => {
    const { fonts } = fontsFixture();
    const { A, comp } = textScene({ fonts });
    const res = plain(A.setText({ ...sel(comp), text: "Şğ ok", style: { font: "Inter-Regular" } }));
    expect(res.warnings.join(" ")).toContain("Inter-Regular has no glyphs for");
    expect(res.warnings.join(" ")).toContain("Ş");
    const clean = plain(A.setText({ ...sel(comp), text: "plain", style: { font: "Inter-Regular" } }));
    expect(clean.warnings).toBeUndefined();
  });

  it("without app.fonts the PostScript name is written as before, and family+style needs app.fonts", () => {
    const { A, comp, state } = textScene();
    const res = plain(A.setText({ ...sel(comp), style: { font: "AnyName" } }));
    expect(state.font).toBe("AnyName");
    expect(res.fonts.document).toMatchObject({ postscript: "AnyName", checked: false });
    expect(() => A.setText({ ...sel(comp), style: { font: { family: "Inter", style: "Bold" } } })).toThrow(/needs After Effects 24/);
  });
});

/** A Position property with three keys and the AE 22.6+ key methods the fake lacks. */
function keyScene(opts: { noLabel?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const layer = comp.layers.addNull(4) as any;
  const pos = layer.transform("Position") as any;
  pos.setValueAtTime(0, [0, 0, 0]);
  pos.setValueAtTime(1, [100, 0, 0]);
  pos.setValueAtTime(2, [200, 0, 0]);
  const opacity = layer.transform("Opacity") as any;
  opacity.setValueAtTime(0, 0);
  opacity.setValueAtTime(1, 100);
  const calls: string[] = [];
  const store: Record<string, any> = { label: {}, selected: [2], inT: {}, outT: {}, sc: {}, sab: {}, tc: {}, tab: {} };
  const patch = (p: any) => {
    p.isInterpolationTypeValid = (t: number) => !(p.name === "Opacity" && t === 999);
    p.setSpatialTangentsAtKey = (k: number, i: number[], o: number[]) => {
      calls.push(`tangents ${k}`);
      store.inT[k] = Array.from(i);
      store.outT[k] = Array.from(o);
    };
    p.keyInSpatialTangent = (k: number) => store.inT[k] ?? [0, 0, 0];
    p.keyOutSpatialTangent = (k: number) => store.outT[k] ?? [0, 0, 0];
    p.setSpatialContinuousAtKey = (k: number, v: boolean) => {
      calls.push(`sc ${k}`);
      store.sc[k] = v;
    };
    p.keySpatialContinuous = (k: number) => store.sc[k] === true;
    p.setSpatialAutoBezierAtKey = (k: number, v: boolean) => {
      calls.push(`sab ${k} ${v}`);
      store.sab[k] = v;
    };
    p.keySpatialAutoBezier = (k: number) => store.sab[k] === true;
    p.setTemporalContinuousAtKey = (k: number, v: boolean) => {
      calls.push(`tc ${k}`);
      store.tc[k] = v;
    };
    p.keyTemporalContinuous = (k: number) => store.tc[k] === true;
    p.setTemporalAutoBezierAtKey = (k: number, v: boolean) => {
      calls.push(`tab ${k}`);
      store.tab[k] = v;
    };
    p.keyTemporalAutoBezier = (k: number) => store.tab[k] === true;
    const origRove = p.setRovingAtKey.bind(p);
    p.setRovingAtKey = (k: number, v: boolean) => {
      calls.push(`rove ${k}`);
      origRove(k, v);
    };
    const origInterp = p.setInterpolationTypeAtKey.bind(p);
    p.setInterpolationTypeAtKey = (k: number, i: number, o: number) => {
      calls.push(`interp ${k}`);
      origInterp(k, i, o);
    };
    if (!opts.noLabel) {
      p.setLabelAtKey = (k: number, v: number) => {
        calls.push(`label ${k}`);
        store.label[k] = v;
      };
      p.keyLabel = (k: number) => store.label[k] ?? 0;
    }
    Object.defineProperty(p, "selectedKeys", { get: () => store.selected, configurable: true });
  };
  patch(pos);
  patch(opacity);
  const host = loadHost(project, ["animate.jsx"]);
  return { project, comp, layer, pos, opacity, calls, store, ...host };
}

const KS = (comp: any, path: string[]) => ({ comp_id: comp.id, layer: { index: 1 }, path, expect: GUARD });
const POS = ["ADBE Transform Group", "ADBE Position"];

describe("wave 5 animate: ae_set_keyframe_ease host (per-key extras)", () => {
  it("different in and out interpolation, then tangents, continuity, label and roving last", () => {
    const { A, comp, pos, calls, undo } = keyScene();
    const res = plain(
      A.animateKeyExtras({
        ...KS(comp, POS),
        keys: [2],
        extras: { in_interp: "linear", out_interp: "bezier", in_tangent: [10, 0, 0], out_tangent: [20, 0, 0], spatial_continuous: false, temporal_continuous: true, label: 5, roving: true },
      })
    );
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(calls).toEqual(["interp 2", "tc 2", "sc 2", "sab 2 false", "tangents 2", "label 2", "rove 2"]);
    expect(pos.keyInInterpolationType(2)).toBe(6612);
    expect(pos.keyOutInterpolationType(2)).toBe(6613);
    expect(res.extras.applied).toEqual(["interpolation", "temporal_continuous", "in_tangent", "out_tangent", "spatial_continuous", "label", "roving"]);
    expect(res.extras.roving).toEqual([2]);
    expect(pos.keyRoving(2)).toBe(true);

    const read = plain(A.getKeyframeEase({ comp_id: comp.id, layer: { index: 1 }, path: POS }));
    const k2 = read.keyframes[1];
    expect(k2).toMatchObject({ inInterp: "linear", outInterp: "bezier", inTangent: [10, 0, 0], outTangent: [20, 0, 0], temporalContinuous: true, label: 5, selected: true, roving: true });
    expect(read.keyframes[0]).toMatchObject({ selected: false, label: 0 });
  });

  it("refuses before the undo group: spatial-only settings on a non-spatial property, tangent length, first key roving, hold-only interpolation, labels on old AE", () => {
    const s = keyScene();
    const OPA = ["ADBE Transform Group", "ADBE Opacity"];
    const run = (path: string[], extras: any, keys: number[] = [2]) => s.A.animateKeyExtras({ ...KS(s.comp, path), keys, extras });
    expect(() => run(OPA, { in_tangent: [1, 2] })).toThrow(/spatial properties only/);
    expect(() => run(OPA, { roving: true })).toThrow(/spatial properties only/);
    expect(() => run(POS, { in_tangent: [1, 2] })).toThrow(/needs 3 numbers/);
    expect(() => run(POS, { roving: true }, [1])).toThrow(/first and last keys/);
    expect(() => run(POS, { roving: true }, [3])).toThrow(/first and last keys/);
    expect(() => run(POS, { spatial_auto_bezier: true, in_tangent: [1, 2, 3] })).toThrow(/auto bezier/);
    expect(() => run(POS, { temporal_auto_bezier: true, temporal_continuous: false })).toThrow(/implies/);
    expect(() => run(POS, { label: 20 })).toThrow(/0 to 16/);
    expect(() => run(POS, { in_interp: "wavy" })).toThrow(/'linear', 'bezier' or 'hold'/);
    expect(() => s.A.animateKeyExtras({ ...KS(s.comp, POS), keys: [9], extras: { label: 1 } })).toThrow(/out of range/);
    expect(s.undo.begun).toBe(0);
    expect(s.calls).toEqual([]);

    const old = keyScene({ noLabel: true });
    expect(() => old.A.animateKeyExtras({ ...KS(old.comp, POS), keys: [2], extras: { label: 3 } })).toThrow(/22\.6/);
    expect(old.undo.begun).toBe(0);
    const read = plain(old.A.getKeyframeEase({ comp_id: old.comp.id, layer: { index: 1 }, path: POS }));
    expect(read.keyframes[0].label).toBeUndefined();
  });

  it("a property that refuses an interpolation type is refused up front", () => {
    const s = keyScene();
    s.pos.isInterpolationTypeValid = () => false;
    expect(() => s.A.animateKeyExtras({ ...KS(s.comp, POS), keys: [2], extras: { out_interp: "bezier" } })).toThrow(/does not accept that interpolation/);
    expect(s.undo.begun).toBe(0);
  });

  it("setKeyframeEase applies extras after the ease and keeps the old result fields", () => {
    const { A, comp, calls, pos } = keyScene();
    const res = plain(A.setKeyframeEase({ ...KS(comp, POS), keys: [2], ease: "easy_ease", extras: { spatial_continuous: true, label: 2 } }));
    expect(res.mode).toBe("easy_ease");
    expect(res.keysUpdated).toEqual([2]);
    expect(res.extras.applied).toEqual(["spatial_continuous", "label"]);
    expect(calls).toEqual(["interp 2", "sc 2", "label 2"]);
    expect(pos.keyInInterpolationType(2)).toBe(6613);
    // an ease with a different interpolation is a conflict
    expect(() => A.setKeyframeEase({ ...KS(comp, POS), keys: [2], ease: "linear", extras: { out_interp: "bezier" } })).toThrow(/can't differ/);
    expect(() => A.setKeyframeEase({ ...KS(comp, POS), keys: [1, 3], ease: "easy_ease", rove_between: true, extras: { roving: true } })).toThrow(/both set roving/);
  });

  it("setKeyframeEaseSides applies extras to the keys it eases", () => {
    const { A, comp, calls } = keyScene();
    const res = plain(
      A.setKeyframeEaseSides({
        ...KS(comp, ["ADBE Transform Group", "ADBE Opacity"]),
        sides: [{ key: 1, out: [{ speed: 0, influence: 50 }] }, { key: 2, in: [{ speed: 0, influence: 50 }] }],
        extras: { temporal_continuous: false, label: 1 },
      })
    );
    expect(res.mode).toBe("curve");
    expect(res.extras.applied).toEqual(["temporal_continuous", "label"]);
    expect(calls.filter((c) => c.startsWith("label"))).toEqual(["label 1", "label 2"]);
  });

  it("a roving key AE will not move is reported, not thrown", () => {
    const s = keyScene();
    s.pos.setRovingAtKey = () => {
      throw new Error("AE refuses");
    };
    const res = plain(s.A.animateKeyExtras({ ...KS(s.comp, POS), keys: [2], extras: { roving: true } }));
    expect(res.extras.roving_failed).toEqual([2]);
    expect(s.undo.ended).toBe(1);
  });
});

/** Import scene: a project whose importFile builds comps, folders and footage like a PSD import would. */
function importScene() {
  const project = new FakeProject();
  const root = project.addFolder("Assets");
  const host = loadHost(project, ["animate.jsx"]);
  const { G } = host;
  G.ImportAsType = { FOOTAGE: 1, COMP: 2, COMP_CROPPED_LAYERS: 3, PROJECT: 4 };
  const asked: any[] = [];
  const allowed: Record<string, number[]> = { "psd": [1, 2, 3], "aep": [4] };
  G.ImportOptions = class extends (ImportOptions as any) {
    importAs: number | undefined;
    rangeStart: number | undefined;
    rangeEnd: number | undefined;
    forceAlphabetical = false;
    canImportAs(t: number) {
      const ext = String(this.file.fsName).split(".").pop() as string;
      return (allowed[ext] ?? [1]).includes(t);
    }
  };
  const origImport = project.importFile.bind(project);
  (project as any).importFile = (io: any) => {
    asked.push({ importAs: io.importAs, sequence: io.sequence, forceAlphabetical: io.forceAlphabetical, rangeStart: io.rangeStart, rangeEnd: io.rangeEnd });
    if (io.importAs === 2 || io.importAs === 3) {
      const folder = project.addFolder("art Layers");
      project.addFootage("bg", 100, 100, new (G.FileSource as any)(), folder);
      project.addFootage("fg", 100, 100, new (G.FileSource as any)(), folder);
      return project.addComp("art", 100, 100, 5);
    }
    if (io.importAs === 4) {
      const folder = project.addFolder("scene.aep");
      project.addComp("inner", 100, 100, 3, folder);
      return folder;
    }
    return origImport(io);
  };
  const placeholders: any[] = [];
  (project as any).importPlaceholder = (name: string, w: number, h: number, fps: number, dur: number) => {
    placeholders.push({ name, w, h, fps, dur });
    const f = project.addFootage(name, w, h, new (G.PlaceholderSource as any)());
    Object.assign(f, { frameRate: fps, duration: dur });
    return f;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-animate-import-"));
  const file = (n: string) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, "x");
    return p;
  };
  return { project, root, asked, placeholders, file, dir, ...host };
}

describe("wave 5 animate: ae_import_footage host (import_as, range, placeholders)", () => {
  it("import_as comp returns the comp and folder it created and moves them into the target folder", () => {
    const s = importScene();
    const res = plain(s.A.importFootage({ paths: [s.file("art.psd")], import_as: "comp", target_folder_id: s.root.id, expect: GUARD }));
    expect(s.asked[0].importAs).toBe(2);
    expect(res.new_comp_ids).toHaveLength(1);
    expect(res.new_folder_ids).toHaveLength(1);
    expect(res.main_comp_id).toBe(res.new_comp_ids[0]);
    expect(res.created_folder_id).toBe(res.new_folder_ids[0]);
    expect(res.created_item_count).toBe(4);
    expect(res.import_as).toBe("comp");
    expect(res.item_ids).toEqual([res.main_comp_id]);
    expect(res.items[0]).toMatchObject({ width: 100, height: 100, duration: 5 });
    // the top created items (comp and layers folder) are in the target folder; the footage stays in its folder
    const comp = s.project.itemByID(res.main_comp_id);
    const folder = s.project.itemByID(res.created_folder_id);
    expect(comp.parentFolder).toBe(s.root);
    expect(folder.parentFolder).toBe(s.root);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("import_as comp_cropped_layers and project are asked of canImportAs first; a refused type lists what the file allows", () => {
    const s = importScene();
    const r = plain(s.A.importFootage({ paths: [s.file("art.psd")], import_as: "comp_cropped_layers", expect: GUARD }));
    expect(s.asked[0].importAs).toBe(3);
    expect(r.new_comp_ids).toHaveLength(1);
    const before = s.project.numItems;
    expect(() => s.A.importFootage({ paths: [s.file("plain.png"), s.file("art.psd")], import_as: "comp", expect: GUARD })).toThrow(/plain\.png can't be imported as comp \(this file allows: footage\); nothing was imported/);
    expect(s.project.numItems).toBe(before);
    expect(s.undo.begun).toBe(1);
    const proj = plain(s.A.importFootage({ paths: [s.file("scene.aep")], import_as: "project", expect: GUARD }));
    expect(proj.new_folder_ids).toHaveLength(1);
    expect(proj.notes.join(" ")).toContain("ae_dialogs");
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("an .aep imported as footage still carries the dialog hint, and a plain import adds no new fields", () => {
    const s = importScene();
    const aep = plain(s.A.importFootage({ paths: [s.file("scene.aep")], expect: GUARD }));
    expect(aep.notes[0]).toContain("never suppresses");
    const plainRes = plain(s.A.importFootage({ paths: [s.file("clip.mov")], expect: GUARD }));
    expect(Object.keys(plainRes).sort()).toEqual(["item_ids", "items", "sequence", "target_folder_id"]);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("range and force_alphabetical reach ImportOptions for a sequence, and a combination After Effects throws on is refused", () => {
    const s = importScene();
    s.A.importFootage({ paths: [s.file("seq_0001.png")], sequence: true, range: { start: 5, end: 12 }, expect: GUARD });
    expect(s.asked[0]).toMatchObject({ sequence: true, forceAlphabetical: false, rangeStart: 5, rangeEnd: 12 });
    s.A.importFootage({ paths: [s.file("seq2_0001.png")], sequence: true, force_alphabetical: true, expect: GUARD });
    expect(s.asked[1]).toMatchObject({ forceAlphabetical: true, rangeStart: undefined });
    expect(() => s.A.importFootage({ paths: [s.file("seq3_0001.png")], sequence: true, force_alphabetical: true, range: { start: 1, end: 2 }, expect: GUARD })).toThrow(/force_alphabetical/);
    expect(() => s.A.importFootage({ paths: [s.file("a.png")], range: { start: 1, end: 2 }, expect: GUARD })).toThrow(/sequence: true/);
    expect(() => s.A.importFootage({ paths: [s.file("b.png")], sequence: true, range: { start: 4, end: 2 }, expect: GUARD })).toThrow(/start <= end/);
    expect(() => s.A.importFootage({ paths: [s.file("c.psd")], sequence: true, import_as: "comp", expect: GUARD })).toThrow(/can't be combined with sequence/);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("placeholders alone or with files, into the target folder, validated before anything is imported", () => {
    const s = importScene();
    const res = plain(
      s.A.importFootage({
        placeholders: [{ name: "Plate A", width: 1920, height: 1080, fps: 24, duration: 5 }],
        target_folder_id: s.root.id,
        expect: GUARD,
      })
    );
    expect(res.placeholder_ids).toHaveLength(1);
    expect(res.item_ids).toEqual(res.placeholder_ids);
    expect(s.project.itemByID(res.placeholder_ids[0]).parentFolder).toBe(s.root);
    expect(s.placeholders[0]).toMatchObject({ name: "Plate A", w: 1920, h: 1080, fps: 24, dur: 5 });
    const both = plain(s.A.importFootage({ paths: [s.file("one.mov")], placeholders: [{ name: "B", width: 10, height: 10, fps: 25, duration: 1 }], expect: GUARD }));
    expect(both.item_ids).toHaveLength(2);
    const before = s.undo.begun;
    expect(() => s.A.importFootage({ paths: [s.file("two.mov")], placeholders: [{ name: "C", width: 10.5, height: 10, fps: 25, duration: 1 }], expect: GUARD })).toThrow(/width must be a whole number/);
    expect(() => s.A.importFootage({ expect: GUARD })).toThrow(/non-empty paths array/);
    expect(s.undo.begun).toBe(before);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });
});

describe("wave 5 animate: ae_replace_footage host (reload)", () => {
  function reloadScene() {
    const project = new FakeProject();
    const folder = project.addFolder("Plates");
    const inner = project.addFolder("Inner", folder);
    const reloads: number[] = [];
    const host = loadHost(project, ["animate.jsx"]);
    const FS = host.G.FileSource as any;
    const mk = (name: string, f: any, w = 100, extra: Record<string, unknown> = {}) => {
      const src = Object.assign(new FS(), { reload: () => reloads.push(item.id) });
      const item: any = project.addFootage(name, w, 100, src, f);
      Object.assign(item, { duration: 5, frameRate: 24, file: { fsName: `C:/${name}` }, ...extra });
      return item;
    };
    const a = mk("a.mov", folder);
    const b = mk("b.mov", inner);
    const solid = project.addFootage("solid", 10, 10, new (host.G.SolidSource as any)(), folder);
    const placeholder = project.addFootage("ph", 10, 10, new (host.G.PlaceholderSource as any)(), folder);
    const proxied = mk("c.mov", folder, 100, { useProxy: true });
    const comp = project.addComp("Comp", 100, 100, 5, folder);
    return { project, folder, a, b, solid, placeholder, proxied, comp, reloads, ...host };
  }

  it("reload under a folder reloads file footage in nested folders and skips solids, placeholders and proxies", () => {
    const s = reloadScene();
    const res = plain(s.A.animateReloadFootage({ folder_id: s.folder.id, expect: GUARD }));
    expect(res.reloaded.sort()).toEqual([s.a.id, s.b.id].sort());
    expect(s.reloads.sort()).toEqual([s.a.id, s.b.id].sort());
    expect(res.skipped.map((x: any) => x.name).sort()).toEqual(["c.mov", "ph", "solid"]);
    expect(res.skipped.find((x: any) => x.name === "c.mov").reason).toContain("proxy");
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("explicit ids that cannot be reloaded refuse the whole call before the undo group", () => {
    const s = reloadScene();
    expect(() => s.A.animateReloadFootage({ item_ids: [s.a.id, s.proxied.id], expect: GUARD })).toThrow(/proxy.*nothing was reloaded/);
    expect(() => s.A.animateReloadFootage({ item_ids: [s.a.id, s.solid.id], expect: GUARD })).toThrow(/not a file/);
    expect(() => s.A.animateReloadFootage({ item_ids: [s.comp.id], expect: GUARD })).toThrow(/not a FootageItem/);
    expect(() => s.A.animateReloadFootage({ item_ids: [99999], expect: GUARD })).toThrow(/No project item/);
    expect(() => s.A.animateReloadFootage({ expect: GUARD })).toThrow(/item_ids or folder_id/);
    expect(s.reloads).toEqual([]);
    expect(s.undo.begun).toBe(0);
  });

  it("returns no_op without an undo group when nothing is reloadable, and reports a reload that throws", () => {
    const s = reloadScene();
    const emptyFolder = s.project.addFolder("Empty");
    const noop = plain(s.A.animateReloadFootage({ folder_id: emptyFolder.id, expect: GUARD }));
    expect(noop.no_op).toBe(true);
    expect(s.undo.begun).toBe(0);
    (s.a.mainSource as any).reload = () => {
      throw new Error("file gone");
    };
    const partial = plain(s.A.animateReloadFootage({ item_ids: [s.a.id, s.b.id], expect: GUARD }));
    expect(partial.reloaded).toEqual([s.b.id]);
    expect(partial.failed[0]).toMatchObject({ item_id: s.a.id });
    expect(partial.failed[0].error).toContain("file gone");
  });

  it("animateReloadTargets is a read: it lists size, duration and why an item is not reloadable", () => {
    const s = reloadScene();
    const res = plain(s.A.animateReloadTargets({ folder_id: s.folder.id }));
    const byName = Object.fromEntries(res.items.map((i: any) => [i.name, i]));
    expect(byName["a.mov"]).toMatchObject({ reloadable: true, width: 100, duration: 5, frameRate: 24, footageMissing: false });
    expect(byName["solid"]).toMatchObject({ reloadable: false });
    expect(byName["solid"].reason).toContain("not a file");
    expect(byName["c.mov"].reason).toContain("proxy");
    expect(s.undo.begun).toBe(0);
    expect(s.reloads).toEqual([]);
  });
});

describe("wave 5 animate: fix round", () => {
  it("placeholders keep to the Scripting Guide limits and are refused before any file is imported", () => {
    const s = importScene();
    const before = s.undo.begun;
    const itemsBefore = s.project.numItems;
    const bad = [
      { name: "A", width: 2, height: 100, fps: 24, duration: 1 },
      { name: "B", width: 100, height: 3, fps: 24, duration: 1 },
      { name: "C", width: 100, height: 100, fps: 120, duration: 1 },
      { name: "D", width: 100, height: 100, fps: 0.5, duration: 1 },
      { name: "E", width: 100, height: 100, fps: 24, duration: 10801 },
    ];
    for (const ph of bad) {
      expect(() => s.A.importFootage({ paths: [s.file("one.mov")], placeholders: [ph], expect: GUARD })).toThrow(/bad_args|must be/);
      expect(AeImportFootageSchema.safeParse({ placeholders: [ph], expect: GUARD }).success).toBe(false);
    }
    expect(s.undo.begun).toBe(before);
    expect(s.project.numItems).toBe(itemsBefore);
    expect(() => s.A.importFootage({ placeholders: [{ name: "Ok", width: 4, height: 4, fps: 99, duration: 0 }], expect: GUARD })).not.toThrow();
    expect(AeImportFootageSchema.safeParse({ placeholders: [{ name: "Ok", width: 4, height: 4, fps: 99, duration: 0 }], expect: GUARD }).success).toBe(true);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  it("box.size together with a height auto_fit, and an array inset on a one-number inset, are refused before the undo group", () => {
    const a = textScene();
    expect(() => a.A.setText({ ...sel(a.comp), box: { size: [500, 100], vertical_align: "top", auto_fit: "height_precise" } })).toThrow(/contradict/);
    expect(a.undo.begun).toBe(0);
    const b = textScene();
    (b.state as any).boxInsetSpacing = 5;
    expect(() => b.A.setText({ ...sel(b.comp), box: { inset: [1, 2, 3, 4] } })).toThrow(/one number for box\.inset/);
    expect(b.undo.begun).toBe(0);
    expect(() => b.A.setText({ ...sel(b.comp), box: { inset: 7 } })).not.toThrow();
    expect((b.state as any).boxInsetSpacing).toBe(7);
  });

  it("box.size is refused when the layer already has a height auto_fit, and allowed with auto_fit none", () => {
    const a = textScene();
    (a.state as any).boxAutoFitPolicy = 83;
    expect(() => a.A.setText({ ...sel(a.comp), box: { size: [500, 100] } })).toThrow(/already has box\.auto_fit "height_precise"/);
    expect(a.undo.begun).toBe(0);
    expect(() => a.A.setText({ ...sel(a.comp), box: { size: [500, 100], auto_fit: "none" } })).not.toThrow();
    expect((a.state as any).boxTextSize).toEqual([500, 100]);
    const b = textScene();
    expect(() => b.A.setText({ ...sel(b.comp), box: { size: [500, 100] } })).not.toThrow();
  });

  it("box_overflow comes from TextDocument.boxOverflow when AE has it", () => {
    const s = textScene();
    (s.state as any).boxOverflow = true;
    const read = plain(s.A.getTextDocument({ ...sel(s.comp), typography: true, measure: true }));
    expect(read.measure.box_overflow).toBe(true);
    (s.state as any).boxOverflow = false;
    const read2 = plain(s.A.getTextDocument({ ...sel(s.comp), typography: true, measure: true }));
    expect(read2.measure.box_overflow).toBe(false);
  });

  it("faux_bold / faux_italic covered by a range starting at 0 are left to that range's read-back", () => {
    const set = { typography: { faux_bold: true, faux_italic: true } };
    const after = { typography: { faux_bold: false, faux_italic: false } };
    const plainCheck = typedTextChecks(set, undefined, after);
    expect(plainCheck.expected["typography.faux_bold"]).toBe(true);
    const covered = typedTextChecks(set, undefined, after, ["typography.faux_bold"]);
    expect(covered.expected["typography.faux_bold"]).toBeUndefined();
    expect(covered.unverified).toEqual(["typography.faux_bold"]);
    expect(covered.expected["typography.faux_italic"]).toBe(true);
  });
  it("a curve with in_interp / out_interp 'bezier' also sets the sides the curve leaves alone", () => {
    const { A, comp } = keyScene();
    const OPA = ["ADBE Transform Group", "ADBE Opacity"];
    const before = plain(A.getKeyframeEase({ comp_id: comp.id, layer: { index: 1 }, path: OPA }));
    expect(before.keyframes[0].inInterp).not.toBe("bezier");
    A.setKeyframeEaseSides({
      ...KS(comp, OPA),
      sides: [{ key: 1, out: [{ speed: 0, influence: 50 }] }, { key: 2, in: [{ speed: 0, influence: 50 }] }],
      extras: { in_interp: "bezier", out_interp: "bezier" },
    });
    const after = plain(A.getKeyframeEase({ comp_id: comp.id, layer: { index: 1 }, path: OPA }));
    for (const k of after.keyframes) {
      expect(k.inInterp).toBe("bezier");
      expect(k.outInterp).toBe("bezier");
    }
  });
});
