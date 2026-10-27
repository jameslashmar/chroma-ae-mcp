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
  extractKeyframeEaseCheck,
} from "../src/tools/ext/animate.js";

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
          replacedWithSeq = forceAlpha;
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

      // 3. Test importFootage with sequence: true (forceAlphabetical)
      const importRes = A.importFootage({
        paths: ["C:/seq/frame_0001.png"],
        sequence: true,
        fps: 30,
        target_folder_id: 9,
        expect: { project_path: "C:/proj/anim.aep" },
      });
      expect(importRes.item_ids).toEqual([201]);
      expect(importedOptions[0].sequence).toBe(true);
      expect(importedOptions[0].forceAlphabetical).toBe(true);

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
      expect(mockFootage.footageMissing).toBe(false);
    });
  });
});
