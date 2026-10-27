import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeFindLayersSchema,
  AeGetLayerFullSchema,
  AeListEffectsSchema,
  AeValidateExpressionsSchema,
  exploreTools,
} from "../src/tools/ext/explore.js";

describe("exploreTools (Task G2)", () => {
  const tmpDirs: string[] = [];

  function makeCtx(
    onEval: (script: string, label: string) => unknown
  ): {
    ctx: ToolContext;
    calls: Array<{ script: string; label: string }>;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-explore-"));
    tmpDirs.push(dir);
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    const calls: Array<{ script: string; label: string }> = [];

    const bridge = new PanelHost({
      evalScript: async (script, label) => {
        calls.push({ script, label });
        const result = await onEval(script, label);
        return {
          ok: true,
          result,
          durationMs: 5,
        };
      },
      queue,
      quarantine,
    });

    return {
      ctx: { bridge, queue, quarantine },
      calls,
    };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function findTool(name: string) {
    const tool = exploreTools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Missing tool ${name}`);
    }
    return tool;
  }

  describe("schemas", () => {
    it("validates AeGetLayerFullSchema defaults and bounds", () => {
      const parsed = AeGetLayerFullSchema.parse({
        comp_id: 10,
        layer: { index: 1 },
      });
      expect(parsed.comp_id).toBe(10);
      expect(parsed.max_keyframes).toBe(100);
      expect(parsed.shape_depth).toBe(4);
      expect(parsed.include).toBeUndefined();

      const withInclude = AeGetLayerFullSchema.parse({
        comp_id: 10,
        layer: { name: "Hero" },
        include: ["transform", "effects", "markers"],
        max_keyframes: 50,
        shape_depth: 6,
      });
      expect(withInclude.include).toEqual(["transform", "effects", "markers"]);
      expect(withInclude.max_keyframes).toBe(50);
      expect(withInclude.shape_depth).toBe(6);

      expect(() =>
        AeGetLayerFullSchema.parse({
          comp_id: 10,
          layer: {},
        })
      ).toThrow();

      expect(() =>
        AeGetLayerFullSchema.parse({
          comp_id: 10,
          layer: { id: 2 },
          include: ["not_a_section"],
        })
      ).toThrow();
    });

    it("validates AeFindLayersSchema defaults and filters", () => {
      const parsed = AeFindLayersSchema.parse({});
      expect(parsed.limit).toBe(200);

      const full = AeFindLayersSchema.parse({
        comp_id: 5,
        name_contains: "Title",
        type: "text",
        has_effect_match_name: "ADBE Glo2",
        has_expression: true,
        source_id: 99,
        limit: 100,
      });
      expect(full).toEqual({
        comp_id: 5,
        name_contains: "Title",
        type: "text",
        has_effect_match_name: "ADBE Glo2",
        has_expression: true,
        source_id: 99,
        limit: 100,
      });

      expect(() => AeFindLayersSchema.parse({ limit: 0 })).toThrow();
      expect(() => AeFindLayersSchema.parse({ limit: 501 })).toThrow();
    });

    it("validates AeListEffectsSchema", () => {
      expect(AeListEffectsSchema.parse({})).toEqual({});
      expect(AeListEffectsSchema.parse({ filter: "Blur" })).toEqual({
        filter: "Blur",
      });
    });

    it("validates AeValidateExpressionsSchema", () => {
      const minimal = AeValidateExpressionsSchema.parse({ comp_id: 12 });
      expect(minimal).toEqual({ comp_id: 12 });

      const full = AeValidateExpressionsSchema.parse({
        comp_id: 12,
        layer: { name: "Controller" },
        time: 2.5,
      });
      expect(full).toEqual({
        comp_id: 12,
        layer: { name: "Controller" },
        time: 2.5,
      });
    });
  });

  describe("tool handlers (read-only host calls)", () => {
    it("calls getLayerFull with defaults and runs even when quarantine has entries", async () => {
      const { ctx, calls } = makeCtx(() => ({
        comp_id: 7,
        layer: { index: 1, id: 101, name: "Logo" },
        transform: { properties: [], truncated: false },
      }));

      // Read-only tools must not be blocked by quarantine
      ctx.quarantine.add({
        op_id: "op_prev_timeout",
        tool: "ae_set_property",
        label: "prev write",
        timestamp: new Date().toISOString(),
        reason: "timeout",
      });

      const tool = findTool("ae_get_layer_full");
      const args = AeGetLayerFullSchema.parse({
        comp_id: 7,
        layer: { index: 1 },
        include: ["transform"],
      });
      const res = await tool.handler(args, ctx);

      expect(res).toEqual({
        comp_id: 7,
        layer: { index: 1, id: 101, name: "Logo" },
        transform: { properties: [], truncated: false },
      });
      expect(calls).toEqual([
        {
          script:
            '__chromaAe.getLayerFull({"comp_id":7,"layer":{"index":1},"include":["transform"],"max_keyframes":100,"shape_depth":4})',
          label: "ae_get_layer_full(7)",
        },
      ]);
    });

    it("calls findLayers across all comps or a single comp", async () => {
      const { ctx, calls } = makeCtx(() => ({
        total_matched: 1,
        limit: 200,
        truncated: false,
        matches: [
          {
            comp_id: 3,
            comp_name: "Main",
            layer: { index: 2, id: 11, name: "Headline", type: "TextLayer" },
          },
        ],
      }));

      const tool = findTool("ae_find_layers");
      const args = AeFindLayersSchema.parse({
        name_contains: "Head",
        type: "text",
        has_expression: true,
      });
      const res = await tool.handler(args, ctx);

      expect(res).toMatchObject({ total_matched: 1, truncated: false });
      expect(calls).toEqual([
        {
          script:
            '__chromaAe.findLayers({"name_contains":"Head","type":"text","has_expression":true,"limit":200})',
          label: "ae_find_layers(all)",
        },
      ]);
    });

    it("calls listEffects with optional filter", async () => {
      const { ctx, calls } = makeCtx(() => ({
        total_installed: 250,
        count: 1,
        truncated: false,
        effects: [
          {
            displayName: "Gaussian Blur",
            matchName: "ADBE Gaussian Blur 2",
            category: "Blur & Sharpen",
            version: "2.0",
          },
        ],
      }));

      const tool = findTool("ae_list_effects");
      const res = await tool.handler({ filter: "Gaussian" }, ctx);

      expect(res).toMatchObject({ count: 1 });
      expect(calls).toEqual([
        {
          script: '__chromaAe.listEffects({"filter":"Gaussian"})',
          label: "ae_list_effects(Gaussian)",
        },
      ]);
    });

    it("calls validateExpressions with comp_id, optional layer, and time", async () => {
      const { ctx, calls } = makeCtx(() => ({
        comp_id: 9,
        comp_name: "Test Comp",
        time: 1.5,
        total_expressions: 1,
        error_count: 1,
        truncated: false,
        results: [
          {
            layer: { index: 1, id: 50, name: "Null 1" },
            path: ["Transform", "Position"],
            expression: "wiggle(5, 20)",
            expressionEnabled: true,
            error: "",
          },
        ],
      }));

      const tool = findTool("ae_validate_expressions");
      const res = await tool.handler(
        { comp_id: 9, layer: { name: "Null 1" }, time: 1.5 },
        ctx
      );

      expect(res).toMatchObject({ comp_id: 9, total_expressions: 1 });
      expect(calls).toEqual([
        {
          script:
            '__chromaAe.validateExpressions({"comp_id":9,"layer":{"name":"Null 1"},"time":1.5})',
          label: "ae_validate_expressions(9)",
        },
      ]);
    });
  });

  describe("panel/host/ext/explore.jsx host implementation in simulated AE DOM", () => {
    function createSimulatedAeEnv() {
      class CompItem {}
      class TextDocument {
        text: string;
        font = "Inter-Bold";
        fontSize = 48;
        fillColor = [1, 1, 1];
        justification = "CENTER_JUSTIFY";
        constructor(text: string) {
          this.text = text;
        }
      }
      class Shape {
        closed = true;
        vertices = [
          [0, 0],
          [100, 0],
          [100, 100],
        ];
        inTangents = [
          [0, 0],
          [0, 0],
          [0, 0],
        ];
        outTangents = [
          [0, 0],
          [0, 0],
          [0, 0],
        ];
      }
      class MarkerValue {
        comment: string;
        duration = 0.5;
        chapter = "";
        url = "";
        frameTarget = "";
        cuePointName = "";
        protectedRegion = false;
        label = 1;
        constructor(comment: string) {
          this.comment = comment;
        }
        getParameters() {
          return { speaker: "Alice" };
        }
      }
      class SolidSource {}

      const PropertyType = {
        PROPERTY: 1,
        INDEXED_GROUP: 2,
        NAMED_GROUP: 3,
      };
      const KeyframeInterpolationType = {
        LINEAR: 6612,
        BEZIER: 6613,
        HOLD: 6614,
      };

      let expressionEnabledSetterCalls = 0;
      let compTimeSetterCalls = 0;
      const valueAtTimeCalls: Array<{
        propName: string;
        time: number;
        preExpression: boolean;
      }> = [];

      function makeLeafProp(opts: {
        name: string;
        matchName: string;
        propertyIndex?: number;
        value?: unknown;
        expression?: string;
        expressionEnabled?: boolean;
        expressionError?: string;
        evalThrows?: string;
        keyframes?: Array<{ time: number; value: unknown }>;
      }) {
        const kfs = opts.keyframes ?? [];
        let _exprEnabled = opts.expressionEnabled ?? Boolean(opts.expression);
        return {
          name: opts.name,
          matchName: opts.matchName,
          propertyIndex: opts.propertyIndex ?? 1,
          propertyType: PropertyType.PROPERTY,
          value: opts.value ?? 100,
          numKeys: kfs.length,
          canSetExpression: true,
          expression: opts.expression ?? "",
          get expressionEnabled() {
            return _exprEnabled;
          },
          set expressionEnabled(v: boolean) {
            expressionEnabledSetterCalls++;
            _exprEnabled = v;
          },
          expressionError: opts.expressionError ?? "",
          keyTime: (k: number) => kfs[k - 1].time,
          keyValue: (k: number) => kfs[k - 1].value,
          keyInInterpolationType: () => KeyframeInterpolationType.BEZIER,
          keyOutInterpolationType: () => KeyframeInterpolationType.BEZIER,
          keyInTemporalEase: () => [{ speed: 0, influence: 33.3 }],
          keyOutTemporalEase: () => [{ speed: 0, influence: 33.3 }],
          keyInSpatialTangent: () => [0, 0],
          keyOutSpatialTangent: () => [0, 0],
          keyTemporalContinuous: () => false,
          keyTemporalAutoBezier: () => false,
          keyRoving: () => false,
          valueAtTime: (t: number, preExpr: boolean) => {
            valueAtTimeCalls.push({
              propName: opts.name,
              time: t,
              preExpression: preExpr,
            });
            if (opts.evalThrows) {
              throw new Error(opts.evalThrows);
            }
            return opts.value ?? 100;
          },
        };
      }

      function makeGroup(
        name: string,
        matchName: string,
        children: Array<Record<string, any>>
      ) {
        return {
          name,
          matchName,
          propertyIndex: 1,
          propertyType: PropertyType.NAMED_GROUP,
          enabled: true,
          numProperties: children.length,
          property: (key: number | string) => {
            if (typeof key === "number") {
              return children[key - 1] ?? null;
            }
            return (
              children.find((c) => c.matchName === key || c.name === key) ??
              null
            );
          },
        };
      }

      const posProp = makeLeafProp({
        name: "Position",
        matchName: "ADBE Position",
        value: [960, 540],
        expression: "wiggle(2, 50)",
        expressionEnabled: true,
        expressionError: "",
        keyframes: [
          { time: 0, value: [0, 540] },
          { time: 1, value: [960, 540] },
        ],
      });

      const opacityProp = makeLeafProp({
        name: "Opacity",
        matchName: "ADBE Opacity",
        value: 80,
        expression: "badVar + 1",
        expressionEnabled: false,
        expressionError: "ReferenceError: badVar is not defined",
        evalThrows: "ReferenceError: badVar is not defined",
      });

      const transformGroup = makeGroup("Transform", "ADBE Transform Group", [
        posProp,
        opacityProp,
      ]);

      const blurParam = makeLeafProp({
        name: "Blurriness",
        matchName: "ADBE Gaussian Blur 2-0001",
        value: 15,
      });
      const blurEffect = makeGroup("Gaussian Blur", "ADBE Gaussian Blur 2", [
        blurParam,
      ]);
      const effectsGroup = makeGroup("Effects", "ADBE Effect Parade", [
        blurEffect,
      ]);

      const maskShapeProp = makeLeafProp({
        name: "Mask Path",
        matchName: "ADBE Mask Shape",
        value: new Shape(),
      });
      const maskFeatherProp = makeLeafProp({
        name: "Mask Feather",
        matchName: "ADBE Mask Feather",
        value: [5, 5],
      });
      const maskOpacityProp = makeLeafProp({
        name: "Mask Opacity",
        matchName: "ADBE Mask Opacity",
        value: 100,
      });
      const maskOffsetProp = makeLeafProp({
        name: "Mask Expansion",
        matchName: "ADBE Mask Offset",
        value: 0,
      });
      const maskAtom = {
        ...makeGroup("Mask 1", "ADBE Mask Atom", [
          maskShapeProp,
          maskFeatherProp,
          maskOpacityProp,
          maskOffsetProp,
        ]),
        inverted: false,
        rotoBezier: false,
        maskMode: "MaskMode.ADD",
      };
      const masksGroup = makeGroup("Masks", "ADBE Mask Parade", [maskAtom]);

      const sourceTextProp = makeLeafProp({
        name: "Source Text",
        matchName: "ADBE Text Document",
        value: new TextDocument("Hello Chroma"),
      });
      const textAnimators = makeGroup("Animators", "ADBE Text Animators", []);
      const textGroup = makeGroup("Text", "ADBE Text Properties", [
        sourceTextProp,
        textAnimators,
      ]);

      const vectorPathProp = makeLeafProp({
        name: "Path",
        matchName: "ADBE Vector Shape",
        value: new Shape(),
      });
      const vectorShapeGroup = makeGroup(
        "Path 1",
        "ADBE Vector Shape - Group",
        [vectorPathProp]
      );
      const shapesGroup = makeGroup("Contents", "ADBE Root Vectors Group", [
        vectorShapeGroup,
      ]);

      const markerProp = makeLeafProp({
        name: "Marker",
        matchName: "ADBE Marker",
        keyframes: [{ time: 0.5, value: new MarkerValue("Beat 1") }],
      });

      const layerTopProps = [
        transformGroup,
        effectsGroup,
        masksGroup,
        textGroup,
        shapesGroup,
        markerProp,
      ];

      const layer1 = {
        index: 1,
        id: 101,
        name: "Hero Text",
        reflect: { name: "TextLayer" },
        inPoint: 0,
        outPoint: 5,
        startTime: 0,
        stretch: 100,
        enabled: true,
        locked: false,
        label: 2,
        parent: null,
        shy: false,
        solo: false,
        nullLayer: false,
        adjustmentLayer: false,
        threeDLayer: false,
        motionBlur: false,
        effectsActive: true,
        blendingMode: "BlendingMode.NORMAL",
        trackMatteType: "TrackMatteType.NO_TRACK_MATTE",
        source: { id: 500, name: "Hero Source" },
        comment: "Main title",
        marker: markerProp,
        numProperties: layerTopProps.length,
        property: (key: number | string) => {
          if (typeof key === "number") {
            return layerTopProps[key - 1] ?? null;
          }
          return (
            layerTopProps.find((p) => p.matchName === key || p.name === key) ??
            null
          );
        },
      };

      const comp = Object.assign(new CompItem(), {
        id: 42,
        name: "Main Comp",
        width: 1920,
        height: 1080,
        frameRate: 30,
        duration: 10,
        get time() {
          return 1.25;
        },
        set time(_v: number) {
          compTimeSetterCalls++;
        },
        numLayers: 1,
        layer: (sel: number | string) => {
          if (typeof sel === "number") return sel === 1 ? layer1 : null;
          return sel === layer1.name ? layer1 : null;
        },
      });

      const globalObj: Record<string, any> = {
        __chromaAe: {},
        CompItem,
        TextDocument,
        Shape,
        MarkerValue,
        SolidSource,
        PropertyType,
        KeyframeInterpolationType,
        app: {
          project: {
            numItems: 1,
            item: (i: number) => (i === 1 ? comp : null),
            itemByID: (id: number) => (id === 42 ? comp : null),
          },
          effects: [
            {
              displayName: "Gaussian Blur",
              matchName: "ADBE Gaussian Blur 2",
              category: "Blur & Sharpen",
              version: "2.0",
            },
            {
              displayName: "Glow",
              matchName: "ADBE Glo2",
              category: "Stylize",
              version: "1.0",
            },
          ],
        },
      };
      globalObj.$ = { os: "Windows", global: globalObj };

      const jsxSource = fs.readFileSync(
        path.resolve(__dirname, "../../panel/host/ext/explore.jsx"),
        "utf8"
      );
      vm.runInNewContext(jsxSource, globalObj);

      return {
        A: globalObj.__chromaAe,
        getExpressionEnabledSetterCalls: () => expressionEnabledSetterCalls,
        getCompTimeSetterCalls: () => compTimeSetterCalls,
        valueAtTimeCalls,
      };
    }

    it("executes getLayerFull and populates all 8 bounded sections", () => {
      const { A } = createSimulatedAeEnv();
      const res = A.getLayerFull({
        comp_id: 42,
        layer: { index: 1 },
      });

      expect(res.comp_id).toBe(42);
      expect(res.layer.name).toBe("Hero Text");
      expect(res.layer.kind).toBe("text");
      expect(res.transform.properties).toHaveLength(2);
      expect(res.effects.numEffects).toBe(1);
      expect(res.effects.effects[0].matchName).toBe("ADBE Gaussian Blur 2");
      expect(res.masks.numMasks).toBe(1);
      expect(res.masks.masks[0].maskPath.value.vertices).toHaveLength(3);
      expect(res.text.sourceText.value.text).toBe("Hello Chroma");
      expect(res.shapes.matchName).toBe("ADBE Root Vectors Group");
      expect(res.expressions.count).toBe(2);
      expect(res.keyframes.count).toBe(2); // Position + Marker
      expect(res.markers.numKeys).toBe(1);
      expect(res.markers.markers[0].comment).toBe("Beat 1");
    });

    it("executes findLayers with filters across comps", () => {
      const { A } = createSimulatedAeEnv();

      const matched = A.findLayers({
        name_contains: "hero",
        type: "text",
        has_effect_match_name: "ADBE Gaussian Blur 2",
        has_expression: true,
        source_id: 500,
      });
      expect(matched.total_matched).toBe(1);
      expect(matched.matches[0].layer.id).toBe(101);

      const noMatch = A.findLayers({
        has_effect_match_name: "ADBE NonExistent",
      });
      expect(noMatch.total_matched).toBe(0);
    });

    it("executes listEffects and filters by displayName, matchName, or category", () => {
      const { A } = createSimulatedAeEnv();

      const all = A.listEffects({});
      expect(all.total_installed).toBe(2);
      expect(all.count).toBe(2);

      const filtered = A.listEffects({ filter: "glo2" });
      expect(filtered.count).toBe(1);
      expect(filtered.effects[0].displayName).toBe("Glow");
    });

    it("executes validateExpressions using valueAtTime(t, false) without ever toggling expressionEnabled or mutating comp.time", () => {
      const {
        A,
        getExpressionEnabledSetterCalls,
        getCompTimeSetterCalls,
        valueAtTimeCalls,
      } = createSimulatedAeEnv();

      const res = A.validateExpressions({
        comp_id: 42,
        time: 3.5,
      });

      expect(getExpressionEnabledSetterCalls()).toBe(0);
      expect(getCompTimeSetterCalls()).toBe(0);
      expect(valueAtTimeCalls).toEqual([
        { propName: "Position", time: 3.5, preExpression: false },
        { propName: "Opacity", time: 3.5, preExpression: false },
      ]);
      expect(res.total_expressions).toBe(2);
      expect(res.error_count).toBe(1);
      expect(res.results).toEqual([
        {
          layer: { index: 1, id: 101, name: "Hero Text" },
          path: ["Transform", "Position"],
          expression: "wiggle(2, 50)",
          expressionEnabled: true,
          error: "",
        },
        {
          layer: { index: 1, id: 101, name: "Hero Text" },
          path: ["Transform", "Opacity"],
          expression: "badVar + 1",
          expressionEnabled: false,
          error: "ReferenceError: badVar is not defined",
        },
      ]);
    });
  });
});
