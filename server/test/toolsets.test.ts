import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  handleRpc,
  listTools,
  type JsonRpcSuccessResponse,
} from "../src/mcp-rpc.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { lintJsxSafety } from "../src/jsx-safety-lint.js";
import { zodToJsonSchema } from "../src/schema.js";
import { META_TOOLS, NAME_MAX, SCHEMA_OUTPUT_SOFT_MAX, SEARCH_OUTPUT_MAX, nameMatcher } from "../src/meta-tools.js";
import {
  CORE_DESCRIPTION_OVERRIDES,
  CORE_TOOL_NAMES,
  META_TOOL_NAMES,
  SEARCH_HINTS,
  TOOL_GROUPS,
  closestToolNames,
  coreInstructions,
  groupOf,
  parseToolset,
  trimSchema,
} from "../src/toolsets.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../src/tools/common.js";

/** The size budget for the core tools/list JSON plus the core `instructions` (about 20k tokens). */
const CORE_BUDGET_CHARS = 84_000;

/** A bridge that fails the test if anything reaches After Effects. */
function noAeCtx(log?: (level: string, msg: string) => void): ToolContext {
  const boom = () => {
    throw new Error("the bridge must not be called");
  };
  const bridge = { newOpId: boom, evalRaw: boom, callHost: boom, health: boom } as unknown as ToolContext["bridge"];
  const queue = { run: boom, acquire: boom } as unknown as ToolContext["queue"];
  const quarantine = { assertClear: boom, list: boom, add: boom } as unknown as ToolContext["quarantine"];
  return { bridge, queue, quarantine, log };
}

async function rpc(method: string, params: unknown, ctx: ToolContext, toolset?: string, id = 1) {
  const res = (await handleRpc({ jsonrpc: "2.0", id, method, params }, ctx, { toolset })) as JsonRpcSuccessResponse;
  return res.result as any;
}

const callResultText = (r: any): string => r.content.map((c: any) => c.text).join("\n");

// ---------- groups ----------

describe("tool groups", () => {
  it("puts every tool in ALL_TOOLS in exactly one group", () => {
    const seen = new Map<string, string[]>();
    for (const [group, def] of Object.entries(TOOL_GROUPS)) {
      for (const name of def.tools) seen.set(name, [...(seen.get(name) ?? []), group]);
    }
    const ungrouped = ALL_TOOLS.filter((t) => !seen.has(t.name)).map((t) => t.name);
    expect(ungrouped, `add these tools to a group in server/src/toolsets.ts: ${ungrouped.join(", ")}`).toEqual([]);
    const twice = [...seen].filter(([, g]) => g.length > 1).map(([n, g]) => `${n}: ${g.join(", ")}`);
    expect(twice).toEqual([]);
    const unknown = [...seen.keys()].filter((n) => !ALL_TOOLS.some((t) => t.name === n));
    expect(unknown, "a group lists a tool that does not exist").toEqual([]);
    for (const t of ALL_TOOLS) expect(groupOf(t.name)).toBeTruthy();
  });

  it("keeps each group small and gives it a one-line blurb under 100 characters", () => {
    for (const [name, def] of Object.entries(TOOL_GROUPS)) {
      expect(def.tools.length, name).toBeGreaterThan(0);
      expect(def.tools.length, `${name} has too many tools; split it`).toBeLessThanOrEqual(30);
      expect(def.blurb.length, name).toBeGreaterThan(10);
      expect(def.blurb.length, name).toBeLessThan(100);
      expect(def.blurb).not.toContain("\n");
    }
  });

  it("only refers to real tools in the search hints and description overrides", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const n of Object.keys(SEARCH_HINTS)) expect(names.has(n), n).toBe(true);
    for (const n of Object.keys(CORE_DESCRIPTION_OVERRIDES)) expect(CORE_TOOL_NAMES).toContain(n);
  });
});

// ---------- the core list ----------

describe("core name list", () => {
  it("names only tools that exist, once each, and none of the meta-tools", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(CORE_TOOL_NAMES).toHaveLength(33);
    expect(new Set(CORE_TOOL_NAMES).size).toBe(CORE_TOOL_NAMES.length);
    for (const n of CORE_TOOL_NAMES) expect(names.has(n), n).toBe(true);
    for (const m of META_TOOL_NAMES) expect(names.has(m), m).toBe(false);
  });
});

describe("toolset choice", () => {
  it("reads core, full, nothing and bad values", () => {
    expect(parseToolset("core")).toEqual({ toolset: "core", invalid: false });
    expect(parseToolset(" CORE ")).toEqual({ toolset: "core", invalid: false });
    expect(parseToolset(["core"])).toEqual({ toolset: "core", invalid: false });
    expect(parseToolset(undefined)).toEqual({ toolset: "full", invalid: false });
    expect(parseToolset("")).toEqual({ toolset: "full", invalid: false });
    expect(parseToolset("full")).toEqual({ toolset: "full", invalid: false });
    expect(parseToolset("tiny")).toEqual({ toolset: "full", invalid: true });
  });
});

describe("full toolset", () => {
  it("is exactly ALL_TOOLS: same names, order and text, no meta-tools, no instructions", async () => {
    const expected = ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: zodToJsonSchema(t.schema) }));
    for (const toolset of [undefined, "full", "bogus", ""]) {
      const result = await rpc("tools/list", undefined, noAeCtx(), toolset);
      expect(result.tools).toEqual(expected);
      expect(JSON.stringify(result.tools)).toBe(JSON.stringify(expected));
      const names: string[] = result.tools.map((t: any) => t.name);
      for (const m of META_TOOL_NAMES) expect(names).not.toContain(m);
      const init = await rpc("initialize", { protocolVersion: "2025-06-18" }, noAeCtx(), toolset);
      expect(init).not.toHaveProperty("instructions");
    }
    expect(ALL_TOOLS.map((t) => t.name)).not.toContain("ae_search_tools");
    expect(listTools("full")).toEqual(expected);
  });
});

describe("core toolset list", () => {
  it("lists the three meta-tools, then the core tools in the agreed order", async () => {
    const result = await rpc("tools/list", undefined, noAeCtx(), "core");
    const names: string[] = result.tools.map((t: any) => t.name);
    expect(names).toEqual([...META_TOOL_NAMES, ...CORE_TOOL_NAMES]);
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
  });

  it("stays inside the size budget: list JSON plus instructions", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" }, noAeCtx(), "core");
    const listChars = JSON.stringify(list).length;
    const instructionChars = (init.instructions as string).length;
    expect(instructionChars).toBeLessThan(4000);
    expect(listChars + instructionChars, `core list ${listChars} + instructions ${instructionChars}`).toBeLessThanOrEqual(CORE_BUDGET_CHARS);
    // And it really is a lot smaller than the full list.
    const full = JSON.stringify(await rpc("tools/list", undefined, noAeCtx(), "full")).length;
    expect(listChars).toBeLessThan(full / 8);
  });

  it("keeps the safety text once, in the instructions, and not in every tool", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" }, noAeCtx(), "core");
    expect(init.instructions).toContain(AGENT_SAFETY_GUIDANCE);
    expect(init.instructions.split(AGENT_SAFETY_GUIDANCE)).toHaveLength(2);
    for (const g of Object.keys(TOOL_GROUPS)) expect(init.instructions).toContain(g);
    for (const m of META_TOOL_NAMES) expect(init.instructions).toContain(m);
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    for (const t of list.tools) {
      if (t.name === "ae_invoke_tool") continue;
      expect(t.description, t.name).not.toContain(AGENT_SAFETY_GUIDANCE);
    }
    expect(coreInstructions()).toBe(init.instructions);
  });

  it("says in ae_search_tools itself that many more tools exist and how to reach them", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    const search = list.tools.find((t: any) => t.name === "ae_search_tools");
    expect(search.description).toContain(String(ALL_TOOLS.length));
    expect(search.description).toContain("ae_get_tool_schema");
    expect(search.description).toContain("ae_invoke_tool");
  });

  it("points every trimmed tool at ae_get_tool_schema", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    for (const t of list.tools.filter((x: any) => CORE_TOOL_NAMES.includes(x.name))) {
      expect(t.description, t.name).toContain("ae_get_tool_schema");
    }
  });
});

// ---------- trimmed schemas keep the structure ----------

/** Fails when `trimmed` lost a property, type, enum, required entry or any non-text key of `full`. */
function sameStructure(full: unknown, trimmed: unknown, at: string): string[] {
  const problems: string[] = [];
  if (Array.isArray(full)) {
    if (!Array.isArray(trimmed) || trimmed.length !== full.length) return [`${at}: array changed`];
    full.forEach((f, i) => problems.push(...sameStructure(f, trimmed[i], `${at}[${i}]`)));
    return problems;
  }
  if (full === null || typeof full !== "object") {
    return JSON.stringify(full) === JSON.stringify(trimmed) ? [] : [`${at}: ${JSON.stringify(full)} became ${JSON.stringify(trimmed)}`];
  }
  if (trimmed === null || typeof trimmed !== "object" || Array.isArray(trimmed)) return [`${at}: not an object any more`];
  const f = full as Record<string, unknown>;
  const t = trimmed as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    if (key === "description" && typeof f[key] === "string") continue; // text may shrink
    if (!(key in t)) {
      problems.push(`${at}.${key} is missing`);
      continue;
    }
    if (key === "properties") {
      const fp = f.properties as Record<string, unknown>;
      const tp = t.properties as Record<string, unknown>;
      if (JSON.stringify(Object.keys(fp)) !== JSON.stringify(Object.keys(tp))) problems.push(`${at}.properties: names or order changed`);
      for (const name of Object.keys(fp)) problems.push(...sameStructure(fp[name], tp[name], `${at}.properties.${name}`));
    } else {
      problems.push(...sameStructure(f[key], t[key], `${at}.${key}`));
    }
  }
  for (const key of Object.keys(t)) {
    if (!(key in f)) problems.push(`${at}.${key} was added`);
  }
  return problems;
}

describe("trimmed schemas", () => {
  it("keep every property, type, enum, required and nested structure of the full schema, for all core tools", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    const byName = new Map<string, any>(list.tools.map((t: any) => [t.name, t]));
    let propertyCount = 0;
    for (const name of CORE_TOOL_NAMES) {
      const full = zodToJsonSchema(ALL_TOOLS.find((t) => t.name === name)!.schema);
      const trimmed = byName.get(name).inputSchema;
      expect(sameStructure(full, trimmed, name), name).toEqual([]);
      propertyCount += JSON.stringify(full).split('"type"').length;
    }
    expect(propertyCount).toBeGreaterThan(200); // the walk really covered something
  });

  it("really shortens text, never uses $ref, and trims untyped descriptions less hard", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    expect(JSON.stringify(list)).not.toContain("$ref");
    const long = { type: "string", description: "x".repeat(400) + ". More." };
    expect(((trimSchema(long) as any).description as string).length).toBeLessThan(80);
    const untyped = { description: "word ".repeat(100) };
    expect(((trimSchema(untyped) as any).description as string).length).toBeGreaterThan(100);
    // A property that is itself called "description" is a name, not text.
    const named = { type: "object", properties: { description: { type: "string", description: "The text." } } };
    expect(trimSchema(named)).toEqual(named);
  });

  it("do not change the Zod schemas: a call checked against the full schema still gets its full errors", async () => {
    const before = JSON.stringify(zodToJsonSchema(ALL_TOOLS.find((t) => t.name === "ae_set_property")!.schema));
    await rpc("tools/list", undefined, noAeCtx(), "core");
    const after = JSON.stringify(zodToJsonSchema(ALL_TOOLS.find((t) => t.name === "ae_set_property")!.schema));
    expect(after).toBe(before);
    const bad = await rpc("tools/call", { name: "ae_set_property", arguments: {} }, noAeCtx(), "core");
    expect(bad.isError).toBe(true);
    expect(callResultText(bad)).toContain("Invalid arguments for ae_set_property");
  });
});

// ---------- meta-tools ----------

describe("ae_get_tool_schema", () => {
  it("returns the full description (with the safety text) and the full input schema", async () => {
    const withSafety = ALL_TOOLS.filter((t) => t.description.includes(AGENT_SAFETY_GUIDANCE));
    expect(withSafety.length).toBeGreaterThan(100);
    const names = ["ae_get_comp", "ae_set_property", "ae_render_queue_status"];
    const res = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { names } }, noAeCtx(), "core");
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(callResultText(res));
    expect(body.tools.map((t: any) => t.name)).toEqual(names);
    for (const t of body.tools) {
      const real = ALL_TOOLS.find((x) => x.name === t.name)!;
      expect(t.description).toBe(real.description);
      expect(t.description).toContain(AGENT_SAFETY_GUIDANCE);
      expect(t.inputSchema).toEqual(zodToJsonSchema(real.schema));
      expect(t.group).toBe(groupOf(t.name));
    }
  });

  it("carries the safety text for every tool that has it, and accepts one name or up to five", async () => {
    for (const t of ALL_TOOLS.filter((x) => x.description.includes(AGENT_SAFETY_GUIDANCE)).slice(0, 40)) {
      const res = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { name: t.name } }, noAeCtx());
      expect(JSON.parse(callResultText(res)).tools[0].description).toContain(AGENT_SAFETY_GUIDANCE);
    }
    const six = ["ae_status", "ae_save", "ae_mask", "ae_shape", "ae_align", "ae_fonts"];
    const tooMany = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { names: six } }, noAeCtx());
    expect(tooMany.isError).toBe(true);
    const none = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: {} }, noAeCtx());
    expect(none.isError).toBe(true);
  });

  it("reports unknown names with the closest real ones", async () => {
    const res = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { names: ["ae_status", "ae_captionz"] } }, noAeCtx());
    const body = JSON.parse(callResultText(res));
    expect(body.tools).toHaveLength(1);
    expect(body.not_found[0].name).toBe("ae_captionz");
    expect(body.not_found[0].closest[0]).toBe("ae_captions");
    const allWrong = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { name: "nope_nope" } }, noAeCtx());
    expect(allWrong.isError).toBe(true);
    expect(callResultText(allWrong)).toContain("Closest");
  });
});

describe("ae_get_tool_schema size and name limits", () => {
  it("returns the first tool whole, stops adding past 40,000 characters and lists the rest in `omitted`", async () => {
    const big = ["ae_set_text", "ae_layer_ops", "ae_create_layer", "ae_render_queue_edit", "ae_aerender_start"];
    const res = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { names: big } }, noAeCtx());
    const body = JSON.parse(callResultText(res));
    expect(body.tools[0].name).toBe("ae_set_text");
    expect(body.tools[0].inputSchema).toEqual(zodToJsonSchema(ALL_TOOLS.find((t) => t.name === "ae_set_text")!.schema));
    expect(body.omitted.length).toBeGreaterThan(0);
    expect([...body.tools.map((t: any) => t.name), ...body.omitted].sort()).toEqual([...big].sort());
    expect(body.omitted_note).toContain(String(SCHEMA_OUTPUT_SOFT_MAX));
    // One tool alone is never cut, however large.
    const one = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { name: "ae_set_text" } }, noAeCtx());
    expect(JSON.parse(callResultText(one)).omitted).toBeUndefined();
  });

  it("refuses names over 80 characters in every meta-tool, quickly, without echoing them", async () => {
    const huge = "x".repeat(1_000_000);
    const t0 = Date.now();
    for (const [tool, args] of [
      ["ae_get_tool_schema", { name: huge }],
      ["ae_get_tool_schema", { names: ["ae_status", huge] }],
      ["ae_invoke_tool", { name: huge }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await rpc("tools/call", { name: tool, arguments: args }, noAeCtx());
      expect(res.isError, tool).toBe(true);
      expect(callResultText(res).length).toBeLessThan(1000);
    }
    expect(Date.now() - t0).toBeLessThan(2000);
    const edge = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { name: "x".repeat(NAME_MAX) } }, noAeCtx());
    expect(callResultText(edge)).toContain("Unknown tool");
    const over = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { name: "x".repeat(NAME_MAX + 1) } }, noAeCtx());
    expect(callResultText(over)).toContain("Invalid arguments");
    // A direct call with a huge unknown name does not echo it all either.
    const direct = await rpc("tools/call", { name: huge, arguments: {} }, noAeCtx());
    expect(callResultText(direct).length).toBeLessThan(300);
  });

  it("cannot forge a service.log line through a tool name", async () => {
    const logs: string[] = [];
    const ctx = noAeCtx((level, msg) => logs.push(`${level} ${msg}`));
    const forged = "x\n[10:00:00] [OK] tool ae_status ok (1ms)";
    for (const [tool, args] of [
      ["ae_invoke_tool", { name: forged }],
      ["ae_get_tool_schema", { name: forged }],
      ["ae_search_tools", { group: forged }],
      ["ae_invoke_tool", { name: "ae_search_tools" }],
    ] as Array<[string, Record<string, unknown>]>) {
      await rpc("tools/call", { name: tool, arguments: args }, ctx);
    }
    await rpc("tools/call", { name: forged, arguments: {} }, ctx);
    expect(logs.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const common = require("../../panel/client/common.js");
    for (const l of logs) {
      expect(l, l).not.toMatch(/[\r\n\u2028\u2029]/);
      // What the panel would see in service.log: one line, and no tool line for a tool that never ran.
      const parsed = common.parseToolLine("[10:00:00] [OK] " + l.replace(/^\w+ /, ""));
      if (parsed && parsed.kind === "tool") expect(parsed.tool).not.toBe("ae_status");
    }
  });
});

describe("ae_search_tools with a schema too big for one reply", () => {
  const fake: ToolDefinition<any> = {
    name: "ae_zz_big_schema",
    description: "A fake tool with a very large input schema.",
    schema: z.object(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field_${i}`, z.string().describe("x".repeat(60))]))),
    handler: async () => ({}),
  };
  afterEach(() => {
    const i = ALL_TOOLS.indexOf(fake);
    if (i >= 0) ALL_TOOLS.splice(i, 1);
  });

  it("drops the schema, says so, and still stays under 20,000 characters", async () => {
    ALL_TOOLS.push(fake);
    const res = await rpc("tools/call", { name: "ae_search_tools", arguments: { pattern: "^ae_zz_big_schema$", detail: "schema" } }, noAeCtx());
    const text = callResultText(res);
    expect(text.length).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX);
    const body = JSON.parse(text);
    expect(body.matches[0].name).toBe("ae_zz_big_schema");
    expect(body.matches[0].inputSchema).toBeUndefined();
    expect(body.schema_omitted).toContain("ae_get_tool_schema");
  });
});

describe("strict meta-tool arguments", () => {
  it("ae_invoke_tool does not silently drop misplaced fields: it says to use `arguments`", async () => {
    let ran = 0;
    const ctx = noAeCtx();
    (ctx as any).bridge = { newOpId: () => "op", callHost: async () => { ran++; return { id: "op", result: {}, durationMs: 1 }; }, evalRaw: async () => ({}) };
    for (const args of [
      { name: "ae_get_comp", args: { comp_id: 1 } },
      { name: "ae_get_comp", comp_id: 1 },
      { name: "ae_get_comp", arguments: { comp_id: 1 }, extra: true },
    ]) {
      const res = await rpc("tools/call", { name: "ae_invoke_tool", arguments: args }, ctx, "core");
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(callResultText(res)).toContain("under `arguments`");
    }
    expect(ran).toBe(0);
    const g = await rpc("tools/call", { name: "ae_get_tool_schema", arguments: { tool: "ae_status" } }, noAeCtx());
    expect(g.isError).toBe(true);
    expect(callResultText(g)).toContain("Allowed fields");
  });
});

describe("core text keeps what a caller needs", () => {
  const coreList = async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    return new Map<string, any>(list.tools.map((t: any) => [t.name, t]));
  };
  const find = (schema: any, pathParts: string[]): any => {
    let node = schema;
    for (const p of pathParts) node = p === "[]" ? node.items : node.properties[p];
    return node;
  };

  it("keeps the contract of union and any-item values: path index, value shapes, popups, layer pickers, mesh options", async () => {
    const c = await coreList();
    expect(find(c.get("ae_set_property").inputSchema, ["path"]).description).toContain("number is a 1-based index");
    const value = find(c.get("ae_set_property").inputSchema, ["value"]).description as string;
    expect(value).toContain("0-1");
    expect(value).toContain("Source Text takes a string or {");
    expect(value).toContain("checked before anything changes");
    const batchValue = find(c.get("ae_batch_set").inputSchema, ["ops", "[]", "value"]).description as string;
    expect(batchValue).toContain("vertices");
    expect(batchValue).toContain("checked against the property's own min and max");
    for (const tool of ["ae_add_effect", "ae_set_effect"]) {
      const v = find(c.get(tool).inputSchema, ["params", "[]", "value"]).description as string;
      expect(v, tool).toContain("1-based item number");
      expect(v, tool).toContain("0 for none");
      expect(v, tool).toContain("0..1");
    }
    expect(find(c.get("ae_create_layer").inputSchema, ["mesh_options"]).description).toContain("cylinder: radius, height, sides");
  });

  it("keeps the warnings that were cut: missing-footage colour bars, remove_filter dry run, undo steps per comp, solid scope", async () => {
    const c = await coreList();
    expect(c.get("ae_aerender_start").description).toContain("colour bars");
    expect(c.get("ae_render_queue_edit").description).toContain("use dry_run first");
    expect(c.get("ae_multi_comp_apply").description).toContain("its own undo step");
    expect(c.get("ae_layer_ops").description).toContain("layer_only");
    const scope = find(c.get("ae_layer_ops").inputSchema, ["scope"]);
    expect(scope.description ?? "").toContain("Required when the solid is also used by layers outside the selection");
  });

  it("has no hand-written or auto-cut core description that ends in an ellipsis", async () => {
    const c = await coreList();
    for (const name of CORE_TOOL_NAMES) {
      const d = c.get(name).description as string;
      expect(d.replace(/ More: ae_get_tool_schema\.$/, ""), name).not.toMatch(/\.\.\.$/);
    }
  });

  it("claims only what lintJsxSafety really does in the ae_run_jsx text", async () => {
    const text = (await coreList()).get("ae_run_jsx").description as string;
    // It must not say the lint refuses app.executeCommand: it does not (the call silently does nothing in CEP).
    expect(lintJsxSafety("app.executeCommand(2004);", { mutates: true })).toEqual([]);
    const refusing = text.split("app.executeCommand")[0];
    expect(refusing).not.toMatch(/refuses[^.]*executeCommand/);
    expect(text).toMatch(/executeCommand silently does nothing/);
    expect(text).toContain("guard rail, not a sandbox");
    // Everything it does claim to refuse, the lint refuses.
    const claims: Array<[RegExp, string]> = [
      [/system\.callSystem/, "system.callSystem('dir');"],
      [/file writes/, "var f = new File('C:/x.txt'); f.open('w'); f.write('a');"],
      [/dialogs/, "alert('hi');"],
      [/quitting/, "app.quit();"],
    ];
    for (const [claim, code] of claims) {
      expect(text, String(claim)).toMatch(claim);
      const findings = lintJsxSafety(code, { mutates: true });
      expect(findings.some((f) => f.severity === "refuse"), code).toBe(true);
    }
  });

  it("does not say the invoke path works while AE is busy", async () => {
    const init = (await rpc("initialize", {}, noAeCtx(), "core")).instructions as string;
    expect(init).toMatch(/ae_invoke_tool runs a tool like any other/);
    expect(init).not.toMatch(/three tools that never touch After Effects/);
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    const invoke = list.tools.find((t: any) => t.name === "ae_invoke_tool").description as string;
    expect(invoke).toContain("refused while AE renders");
    for (const n of ["ae_search_tools", "ae_get_tool_schema"]) {
      expect(list.tools.find((t: any) => t.name === n).description).toContain("Never touches After Effects");
    }
    expect(invoke).not.toContain("Never touches After Effects");
  });
});

describe("ae_search_tools", () => {
  const search = async (args: Record<string, unknown>) => {
    const res = await rpc("tools/call", { name: "ae_search_tools", arguments: args }, noAeCtx(), "core");
    return { res, body: res.isError ? null : JSON.parse(callResultText(res)) };
  };
  const top = (body: any, n = 3): string[] => body.matches.slice(0, n).map((m: any) => m.name);

  it("lists the groups with counts for an empty call", async () => {
    const { body } = await search({});
    expect(body.total_tools).toBe(ALL_TOOLS.length);
    expect(body.groups.map((g: any) => g.group)).toEqual(Object.keys(TOOL_GROUPS));
    expect(body.groups.reduce((a: number, g: any) => a + g.tools, 0)).toBe(ALL_TOOLS.length);
    for (const g of body.groups) expect(g.blurb.length).toBeGreaterThan(0);
  });

  it("finds the expected tool for natural phrases", async () => {
    expect(top((await search({ query: "remove something from a shot" })).body, 4)).toEqual(
      expect.arrayContaining([expect.stringMatching(/ae_(inpaint_plate|cleanplate_setup|cleanplate_pick|caf_prep)/)])
    );
    expect(top((await search({ query: "track" })).body)).toContain("ae_track_point");
    expect(top((await search({ query: "captions" })).body)).toContain("ae_captions");
    expect(top((await search({ query: "render in after effects" })).body)).toContain("ae_render_queue_render");
    expect(top((await search({ query: "replace the screen of a phone" })).body)).toContain("ae_screen_replace");
    expect(top((await search({ query: "loudness" })).body)).toContain("ae_loudness_check");
  });

  it("filters by group and by name pattern, and combines them with a query", async () => {
    const g = (await search({ group: "captions_audio", limit: 20 })).body;
    expect(g.matches.map((m: any) => m.name).sort()).toEqual([...TOOL_GROUPS.captions_audio.tools].sort());
    const p = (await search({ pattern: "^ae_track_" })).body;
    expect(p.matches.map((m: any) => m.name).sort()).toEqual(["ae_track_apply", "ae_track_multi", "ae_track_point", "ae_track_read"]);
    const both = (await search({ group: "render", query: "template" })).body;
    expect(both.matches.every((m: any) => groupOf(m.name) === "render")).toBe(true);
    expect(both.matches[0].name).toBe("ae_render_templates");
    expect((await search({ group: "nonsense" })).res.isError).toBe(true);
    // The pattern is a literal fragment, not a regex: ^ anchors the start, $ the end.
    expect((await search({ pattern: "(" })).body.matches).toEqual([]);
    expect((await search({ pattern: "layer$" })).body.matches.map((m: any) => m.name)).toEqual(
      ALL_TOOLS.map((t) => t.name).filter((n) => n.endsWith("layer"))
    );
    expect((await search({ pattern: "^ae_status$" })).body.matches.map((m: any) => m.name)).toEqual(["ae_status"]);
    expect((await search({ pattern: "AE_TRACK_P" })).body.matches.map((m: any) => m.name)).toEqual(["ae_track_point"]);
    // Group names that are only inherited object keys are not groups.
    for (const g of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = await search({ group: g });
      expect(r.res.isError, g).toBe(true);
      expect(callResultText(r.res)).toContain("Unknown group");
    }
  });

  it("returns at once for a pattern that would hang a regex engine", async () => {
    const evil = "^(([a-z_]+)+)+!";
    const t0 = Date.now();
    const r = await search({ pattern: evil });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.body.matches).toEqual([]);
    const long = "a".repeat(30) + "!";
    const t1 = Date.now();
    nameMatcher("^(a+)+$")(long);
    expect(Date.now() - t1).toBeLessThan(50);
  });

  it("marks which results can be called directly and which need ae_invoke_tool", async () => {
    const { body } = await search({ query: "track point stabilize render", limit: 20 });
    for (const m of body.matches) {
      expect(m.call).toBe(CORE_TOOL_NAMES.includes(m.name) ? "direct" : "ae_invoke_tool");
    }
  });

  it("respects limit (default 8, max 20), detail schema, and an output cap of 20,000 characters", async () => {
    expect((await search({ query: "layer" })).body.matches).toHaveLength(8);
    expect((await search({ query: "layer", limit: 3 })).body.matches).toHaveLength(3);
    expect((await search({ query: "layer", limit: 21 })).res.isError).toBe(true);
    const withSchema = (await search({ query: "layer", limit: 3, detail: "schema" })).body;
    expect(withSchema.matches[0].inputSchema.type).toBe("object");
    const big = await search({ pattern: "^ae_", limit: 20, detail: "schema" });
    expect(callResultText(big.res).length).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX);
    expect(big.body.truncated || big.body.returned === 20).toBe(true);
  });

  it("keeps every reply under 20,000 characters, whichever fields it carries", async () => {
    // The exact input that overran the cap before the size check covered `more` and `next`.
    const edge = await search({ detail: "schema", limit: 4, pattern: "layer", query: "captions track mask" });
    expect(callResultText(edge.res).length).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX);
    let cut = 0;
    let worst = 0;
    const queries = [undefined, "layer", "captions track mask", "render", "text font", "effect keyframe", "mask path shape"];
    const patterns = [undefined, "layer", "^ae_", "set", "_"];
    const groups = [undefined, "edit", "inspect", "render", "tracking_patching"];
    for (const query of queries) {
      for (const pattern of patterns) {
        for (const group of groups) {
          for (const limit of [1, 4, 8, 12, 20]) {
            for (const offset of [0, 3]) {
              if (!query && !pattern && !group) continue;
              const args: Record<string, unknown> = { detail: "schema", limit, offset };
              if (query) args.query = query;
              if (pattern) args.pattern = pattern;
              if (group) args.group = group;
              const r = await search(args);
              const len = callResultText(r.res).length;
              worst = Math.max(worst, len);
              expect(len, JSON.stringify(args)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX);
              if (r.body.truncated) {
                cut++;
                expect(r.body.more, JSON.stringify(args)).toContain("cut at");
                expect(r.body.next_offset).toBe(offset + r.body.returned);
              }
            }
          }
        }
      }
    }
    expect(cut).toBeGreaterThan(10); // the size cap really was hit by the sweep
    expect(worst).toBeGreaterThan(15_000);
  });

  it("names the right reason: size cut versus plain paging", async () => {
    const plain = (await search({ query: "layer", limit: 3 })).body;
    expect(plain.truncated).toBeUndefined();
    expect(plain.more).toContain("offset 3");
    expect(plain.more).not.toContain("cut at");
    expect(plain.next_offset).toBe(3);
  });

  it("pages with offset, so a group over 20 tools can be listed in full", async () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(40);
    const names: string[] = [];
    let offset = 0;
    for (let i = 0; i < 20 && offset !== undefined; i++) {
      const { body } = await search({ pattern: "ae_", limit: 20, offset });
      names.push(...body.matches.map((m: any) => m.name));
      offset = body.next_offset;
    }
    expect(names).toEqual(ALL_TOOLS.map((t) => t.name));
    expect((await search({ group: "inspect", limit: 20, offset: 20 })).body.matches.map((m: any) => m.name)).toEqual(
      ALL_TOOLS.map((t) => t.name).filter((n) => TOOL_GROUPS.inspect.tools.includes(n)).slice(20)
    );
    expect((await search({ query: "layer", offset: 5000 })).res.isError).toBe(true);
  });

  it("describes limit and offset as bounded integers in its input schema, and is strict about other fields", async () => {
    const list = await rpc("tools/list", undefined, noAeCtx(), "core");
    const props = list.tools.find((t: any) => t.name === "ae_search_tools").inputSchema.properties;
    expect(props.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    expect(props.offset).toMatchObject({ type: "integer", minimum: 0 });
    const typo = await search({ querry: "x" });
    expect(typo.res.isError).toBe(true);
    expect(callResultText(typo.res)).toContain("Allowed fields");
  });

  it("says so when nothing matches", async () => {
    const { body } = await search({ query: "zzzzqqqq" });
    expect(body.matches).toEqual([]);
    expect(body.hint).toBeTruthy();
  });
});

describe("meta-tools never touch After Effects", () => {
  it("answer with a bridge, queue and quarantine that fail if they are used", async () => {
    const ctx = noAeCtx();
    const calls: Array<[string, unknown]> = [
      ["ae_search_tools", {}],
      ["ae_search_tools", { query: "track" }],
      ["ae_get_tool_schema", { name: "ae_status" }],
      ["ae_invoke_tool", { name: "ae_search_tools" }],
      ["ae_invoke_tool", { name: "no_such_tool" }],
      ["ae_invoke_tool", { name: "ae_set_property", arguments: {} }],
    ];
    for (const toolset of ["core", "full"]) {
      for (const [name, args] of calls) {
        const res = await rpc("tools/call", { name, arguments: args }, ctx, toolset);
        expect(callResultText(res)).not.toContain("the bridge must not be called");
      }
    }
  });

  it("are callable in the full toolset too, but only listed in core", async () => {
    const res = await rpc("tools/call", { name: "ae_search_tools", arguments: { query: "captions" } }, noAeCtx(), "full");
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(callResultText(res)).matches.length).toBeGreaterThan(0);
    expect(META_TOOLS.map((m) => m.name)).toEqual([...META_TOOL_NAMES]);
  });

  it("validates its own arguments", async () => {
    const res = await rpc("tools/call", { name: "ae_search_tools", arguments: { limit: "many" } }, noAeCtx());
    expect(res.isError).toBe(true);
    expect(callResultText(res)).toContain("Invalid arguments for ae_search_tools");
  });
});

// ---------- ae_invoke_tool == tools/call ----------

describe("ae_invoke_tool", () => {
  const added: ToolDefinition<any>[] = [];
  afterEach(() => {
    for (const t of added.splice(0)) {
      const i = ALL_TOOLS.indexOf(t);
      if (i >= 0) ALL_TOOLS.splice(i, 1);
    }
  });
  function addFake(name: string, schema: z.ZodTypeAny, handler: ToolDefinition<any>["handler"]): ToolDefinition<any> {
    const t: ToolDefinition<any> = { name, description: `fake ${name}`, schema, handler };
    ALL_TOOLS.push(t);
    added.push(t);
    return t;
  }

  async function both(name: string, args: Record<string, unknown>, ctx: ToolContext) {
    const direct = await rpc("tools/call", { name, arguments: args }, ctx, "full");
    const viaInvoke = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name, arguments: args } }, ctx, "core");
    return { direct, viaInvoke };
  }

  it("returns exactly what tools/call returns: success, validation error, isError and an image-bearing result", async () => {
    addFake("ae_test_ok", z.object({ n: z.number() }), async (a: { n: number }) => ({ doubled: a.n * 2 }));
    addFake("ae_test_throws", z.object({}), async () => {
      throw new Error("AE said no");
    });
    addFake("ae_test_image", z.object({}), async () => ({
      image: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=".repeat(50) },
      path: "C:/frames/x.png",
    }));

    const ctx = noAeCtx();
    const ok = await both("ae_test_ok", { n: 21 }, ctx);
    expect(ok.viaInvoke).toEqual(ok.direct);
    expect(JSON.parse(callResultText(ok.viaInvoke))).toEqual({ doubled: 42 });

    const invalid = await both("ae_test_ok", { n: "x" }, ctx);
    expect(invalid.viaInvoke).toEqual(invalid.direct);
    expect(invalid.viaInvoke.isError).toBe(true);
    expect(callResultText(invalid.viaInvoke)).toContain("Invalid arguments for ae_test_ok");

    const realInvalid = await both("ae_set_property", {}, ctx);
    expect(realInvalid.viaInvoke).toEqual(realInvalid.direct);
    expect(realInvalid.viaInvoke.isError).toBe(true);

    const thrown = await both("ae_test_throws", {}, ctx);
    expect(thrown.viaInvoke).toEqual(thrown.direct);
    expect(thrown.viaInvoke.isError).toBe(true);
    expect(callResultText(thrown.viaInvoke)).toContain("AE said no");

    const image = await both("ae_test_image", {}, ctx);
    expect(image.viaInvoke).toEqual(image.direct);
    expect(callResultText(image.viaInvoke)).toContain("image/png");
  });

  it("passes omitted arguments as an empty object, like tools/call", async () => {
    addFake("ae_test_empty", z.object({ x: z.number().optional() }), async (a: unknown) => ({ got: a }));
    const viaInvoke = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name: "ae_test_empty" } }, noAeCtx(), "core");
    const direct = await rpc("tools/call", { name: "ae_test_empty" }, noAeCtx(), "core");
    expect(viaInvoke).toEqual(direct);
  });

  it("shows the INNER tool name to the bridge, the service log and the panel's log parser", async () => {
    const seen: Array<{ fn: string; toolName?: string; label: string }> = [];
    const logs: string[] = [];
    const ctx = noAeCtx((level, msg) => logs.push(`${level} ${msg}`));
    (ctx as any).bridge = {
      newOpId: () => "op",
      evalRaw: async () => {
        throw new Error("unexpected evalRaw");
      },
      callHost: async (fn: string, _args: unknown, opts: { toolName?: string; label: string }) => {
        seen.push({ fn, toolName: opts.toolName, label: opts.label });
        return { id: "op", result: { id: 10, name: "Hero" }, durationMs: 1 };
      },
    };

    const res = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name: "ae_get_comp", arguments: { comp_id: 10 } } }, ctx, "core");
    expect(JSON.parse(callResultText(res))).toEqual({ id: 10, name: "Hero" });
    expect(seen).toEqual([{ fn: "getComp", toolName: "ae_get_comp", label: "ae_get_comp(10)" }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^ok tool ae_get_comp ok \(\d+ms\)$/);
    expect(logs.join("\n")).not.toContain("ae_invoke_tool");

    // The panel's Log and tiles parse exactly this line.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const common = require("../../panel/client/common.js");
    const parsed = common.parseToolLine("[10:00:00] [OK] tool ae_get_comp ok (5ms)");
    expect(parsed.tool).toBe("ae_get_comp");
  });

  it("logs a failing inner call under the inner name too", async () => {
    const logs: string[] = [];
    const ctx = noAeCtx((level, msg) => logs.push(`${level} ${msg}`));
    const res = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name: "ae_get_comp", arguments: { comp_id: 10 } } }, ctx, "core");
    expect(res.isError).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^err tool ae_get_comp failed/);
  });

  it("refuses a meta-tool as the target", async () => {
    for (const name of META_TOOL_NAMES) {
      const res = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name, arguments: {} } }, noAeCtx(), "core");
      expect(res.isError).toBe(true);
      expect(callResultText(res)).toContain("meta-tool");
    }
  });

  it("gives the closest names for an unknown tool", async () => {
    const res = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name: "ae_captoins" } }, noAeCtx(), "core");
    expect(res.isError).toBe(true);
    const text = callResultText(res);
    expect(text).toContain("Unknown tool: ae_captoins");
    expect(text).toContain("ae_captions");
    expect(closestToolNames("ae_trak_point")[0]).toBe("ae_track_point");
  });

  it("needs a name and an object for arguments", async () => {
    const noName = await rpc("tools/call", { name: "ae_invoke_tool", arguments: {} }, noAeCtx(), "core");
    expect(noName.isError).toBe(true);
    const strArgs = await rpc("tools/call", { name: "ae_invoke_tool", arguments: { name: "ae_status", arguments: "{}" } }, noAeCtx(), "core");
    expect(strArgs.isError).toBe(true);
  });
});

describe("direct tools/call in the core toolset", () => {
  it("still runs a tool that is not in the core list", async () => {
    expect(CORE_TOOL_NAMES).not.toContain("ae_track_read");
    const seen: string[] = [];
    const ctx = noAeCtx();
    (ctx as any).bridge = {
      newOpId: () => "op",
      callHost: async (fn: string, _a: unknown, opts: { toolName?: string }) => {
        seen.push(`${fn}:${opts.toolName}`);
        return { id: "op", result: {}, durationMs: 1 };
      },
      evalRaw: async () => {
        throw new Error("no");
      },
    };
    const res = await rpc("tools/call", { name: "ae_get_comp_settings", arguments: { comp_id: 1 } }, ctx, "core");
    expect(CORE_TOOL_NAMES).not.toContain("ae_get_comp_settings");
    // Unknown names still say so; a real unlisted one is dispatched (it reaches the handler, not "Unknown tool").
    expect(callResultText(res)).not.toContain("Unknown tool");
    // The unlisted tool really ran: it reached the bridge under its own name.
    expect(seen).toEqual(["compsettingsRead:ae_get_comp_settings"]);
    const unknown = await rpc("tools/call", { name: "no_such_tool", arguments: {} }, ctx, "core");
    expect(callResultText(unknown)).toContain("Unknown tool: no_such_tool");
  });
});

describe("X-Chroma-Toolset header through the panel's HTTP handler", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function makeMcp(logs: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-toolset-"));
    dirs.push(dir);
    return createPanelMcp({
      evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }),
      dataDir: dir,
      watchAssets: false,
      sessionTracking: false,
      log: (level: string, msg: string) => logs.push(`${level} ${msg}`),
    } as any);
  }
  async function send(mcp: ReturnType<typeof makeMcp>, headers: Record<string, string>, body: unknown) {
    let out = "";
    const res: any = { statusCode: 0, writableEnded: false, setHeader() {}, end(b?: string) { out = b ?? ""; this.writableEnded = true; } };
    await mcp.handleHttp({ method: "POST", url: "/mcp", headers }, res, JSON.stringify(body));
    return JSON.parse(out);
  }
  async function post(headers: Record<string, string>, body: unknown, logs: string[] = []) {
    const mcp = makeMcp(logs);
    try {
      return await send(mcp, headers, body);
    } finally {
      mcp.stop();
    }
  }
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("serves the core list for core and the full list for no header, full or a bad value", async () => {
    const core = await post({ "x-chroma-toolset": "core" }, list);
    expect(core.result.tools.map((t: any) => t.name)).toEqual([...META_TOOL_NAMES, ...CORE_TOOL_NAMES]);
    for (const headers of [{}, { "x-chroma-toolset": "full" }, { "x-chroma-toolset": "tiny" }]) {
      const full = await post(headers, list);
      expect(full.result.tools).toHaveLength(ALL_TOOLS.length);
    }
    const init = await post({ "x-chroma-toolset": "core" }, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(init.result.instructions).toContain("ae_search_tools");
  });

  it("logs a bad toolset once per value, however many requests carry it", async () => {
    const logs: string[] = [];
    const mcp = makeMcp(logs);
    try {
      for (let i = 0; i < 5; i++) await send(mcp, { "x-chroma-toolset": "tiny" }, list);
      expect(logs.filter((l) => l.includes("Unknown toolset"))).toHaveLength(1);
      await send(mcp, { "x-chroma-toolset": "huge" }, list);
      await send(mcp, { "x-chroma-toolset": "huge" }, list);
      expect(logs.filter((l) => l.includes("Unknown toolset"))).toHaveLength(2);
      await send(mcp, { "x-chroma-toolset": "core" }, list);
      await send(mcp, {}, list);
      expect(logs.filter((l) => l.includes("Unknown toolset"))).toHaveLength(2);
    } finally {
      mcp.stop();
    }
  });
});
