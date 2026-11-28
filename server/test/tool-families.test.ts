/**
 * Tool families (tool-families.ts): one listed tool with `action` in place of a run of tools, the old
 * names still answering, each action validated and run by its member tool.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resetIdempotency } from "../src/idempotency.js";
import { handleRpc, listTools } from "../src/mcp-rpc.js";
import { annotationsFor } from "../src/tool-annotations.js";
import { callTool, findTool } from "../src/tool-call.js";
import { FAMILIES, familyOf, familyTool, familyTools, listedTools } from "../src/tool-families.js";
import { CORE_TOOL_NAMES } from "../src/toolsets.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../src/tools/common.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { isWriteTool } from "../src/write-tools.js";

const ctx = { bridge: {}, queue: {}, quarantine: {} } as unknown as ToolContext;
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("the real families", () => {
  it("every member exists, belongs to one family, and the family name is free or the default member's", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    const seen = new Map<string, string>();
    for (const f of FAMILIES) {
      const actions = f.actions.map(([a]) => a);
      expect(new Set(actions).size, f.name).toBe(actions.length);
      for (const [, member] of f.actions) {
        expect(names.has(member), `${f.name}: ${member}`).toBe(true);
        expect(seen.get(member), member).toBeUndefined();
        seen.set(member, f.name);
      }
      // A family may only take the name of the member it runs when no action is given.
      if (names.has(f.name)) {
        expect(f.default, f.name).toBeDefined();
        expect(f.actions.find(([a]) => a === f.default)?.[1]).toBe(f.name);
      } else {
        expect(f.default, f.name).toBeUndefined();
      }
    }
    expect(familyTools()).toHaveLength(FAMILIES.length);
  });

  it("the full list shows each family once, where its first member was, and none of its members", () => {
    const listed = listedTools().map((t) => t.name);
    expect(new Set(listed).size).toBe(listed.length);
    for (const f of familyTools()) {
      expect(listed).toContain(f.name);
      for (const m of f.members) if (m.tool.name !== f.name) expect(listed).not.toContain(m.tool.name);
    }
    expect(listed.length).toBe(ALL_TOOLS.length - FAMILIES.reduce((a, f) => a + f.actions.length - 1, 0));
    // ae_track sits between the plain tools that were around ae_track_point.
    const at = ALL_TOOLS.findIndex((t) => t.name === "ae_track_point");
    const prev = ALL_TOOLS.slice(0, at).reverse().find((t) => !familyOf(t.name))!.name;
    const next = ALL_TOOLS.slice(at + 1).find((t) => !familyOf(t.name))!.name;
    expect(listed.indexOf(prev)).toBeLessThan(listed.indexOf("ae_track"));
    expect(listed.indexOf("ae_track")).toBeLessThan(listed.indexOf(next));
    expect(listTools("full").map((t) => t.name)).toEqual(listed);
  });

  it("the core list is unchanged: its member tools, no families", () => {
    const core = listTools("core").map((t) => t.name);
    for (const n of CORE_TOOL_NAMES) expect(core).toContain(n);
    for (const f of familyTools()) if (!CORE_TOOL_NAMES.includes(f.name)) expect(core).not.toContain(f.name);
  });

  it("old names still answer, and a family is found under its own name", () => {
    for (const f of familyTools()) {
      expect(findTool(f.name)).toBe(f);
      for (const m of f.members) if (m.tool.name !== f.name) expect(findTool(m.tool.name)).toBe(m.tool);
    }
  });

  it("the description names every action and its old tool, with the safety text once", () => {
    const f = familyTool("ae_render_queue")!;
    for (const m of f.members) expect(f.description).toContain(`- ${m.action} (${m.tool.name}): `);
    expect(familyTool("ae_deliver")!.description).toContain("- step (ae_deliver_step), its own `action` given as `step_action`: ");
    expect(f.description.split(AGENT_SAFETY_GUIDANCE).length - 1).toBe(1);
    for (const fam of familyTools()) expect(fam.description.split(AGENT_SAFETY_GUIDANCE).length - 1, fam.name).toBeLessThanOrEqual(1);
  });

  it("the merged schema: an action enum, every member's fields, and which actions take a field", () => {
    const s = familyTool("ae_track")!.inputJsonSchema as any;
    expect(s.properties.action.enum).toEqual(["point", "multi", "read", "apply"]);
    expect(s.required).toEqual(["action"]);
    expect(s.properties.expect).toBeDefined();
    // ae_captions keeps working without an action, so it requires none.
    const c = familyTool("ae_captions")!.inputJsonSchema as any;
    expect(c.required).toBeUndefined();
    expect(c.properties.action.description).toContain("Default build");
    for (const [k, v] of Object.entries<any>(s.properties)) {
      if (k === "action") continue;
      if (typeof v.description === "string" && v.description.startsWith("[")) expect(v.description).toMatch(/^\[(point|multi|read|apply)(, (point|multi|read|apply))*\]/);
    }
  });

  it("the family's action is always its own enum; a member's own action field is <action>_action", () => {
    for (const f of familyTools()) {
      const p = (f.inputJsonSchema as any).properties;
      expect(p.action.enum, f.name).toEqual(f.members.map((m) => m.action));
    }
    const d = (familyTool("ae_deliver")!.inputJsonSchema as any).properties;
    expect(d.step_action.enum).toEqual(["start", "next", "retry", "skip", "cancel"]);
    expect(d.step_action.description).toMatch(/^\[step\]/);
    expect(d.recipe_action.enum).toEqual(["list", "get", "set", "delete"]);
    for (const [fam, field] of [["ae_taste", "rules_action"], ["ae_stabilize", "roundtrip_action"], ["ae_cleanplate", "setup_action"]]) {
      expect((familyTool(fam)!.inputJsonSchema as any).properties[field], `${fam}.${field}`).toBeDefined();
    }
  });

  it("annotations take the worst case of the members", () => {
    // ae_dialog: list reads, respond presses a button.
    expect(annotationsFor("ae_dialog").readOnlyHint).toBeUndefined();
    expect(annotationsFor("ae_dialogs").readOnlyHint).toBe(true);
    // ae_checkpoint: revert overwrites the project.
    expect(annotationsFor("ae_checkpoint").destructiveHint).toBeUndefined();
    expect(annotationsFor("ae_checkpoint_create").destructiveHint).toBe(false);
    for (const f of familyTools()) expect(annotationsFor(f.name).openWorldHint === false).toBe(f.members.every((m) => annotationsFor(m.tool.name).openWorldHint === false));
  });

  it("a family is a write tool when any action is", () => {
    for (const f of familyTools()) expect(isWriteTool(f.name), f.name).toBe(f.members.some((m) => isWriteTool(m.tool.name)));
    expect(isWriteTool("ae_checkpoint")).toBe(true);
  });
});

describe("dispatch", () => {
  const calls: Array<[string, unknown]> = [];
  let tools: ToolDefinition<any>[] = [];

  const tool = (name: string, schema: z.ZodTypeAny): ToolDefinition<any> => ({
    name,
    description: `${name} does a thing. ${AGENT_SAFETY_GUIDANCE}`,
    schema,
    handler: async (args) => {
      calls.push([name, args]);
      return { ran: name, args };
    },
  });

  beforeEach(() => {
    calls.length = 0;
    resetIdempotency();
    FAMILIES.push({ name: "ae_zz_fam", title: "A test family.", actions: [["one", "ae_zz_fam"], ["two", "ae_zz_fam_two"]], default: "one" });
    tools = [
      tool("ae_zz_fam", z.object({ size: z.number().optional(), mode: z.enum(["a", "b"]).optional() })),
      tool("ae_zz_fam_two", z.object({ comp_id: z.number().int(), mode: z.number().optional(), action: z.enum(["build", "remove"]).optional(), expect: z.object({ project_path: z.string() }) })),
    ];
    ALL_TOOLS.push(...tools);
  });
  afterEach(() => {
    FAMILIES.splice(FAMILIES.findIndex((f) => f.name === "ae_zz_fam"), 1);
    for (const t of tools) ALL_TOOLS.splice(ALL_TOOLS.indexOf(t), 1);
  });

  it("runs the action's member with its own arguments; no action runs the default", async () => {
    const two = await callTool("ae_zz_fam", { action: "two", comp_id: 3, expect: { project_path: "<unsaved>" } }, ctx);
    expect(body(two)).toMatchObject({ ok: true, ran: "ae_zz_fam_two", args: { comp_id: 3 } });
    expect(calls[0][1]).not.toHaveProperty("action");
    const one = await callTool("ae_zz_fam", { size: 2 }, ctx);
    expect(body(one)).toMatchObject({ ok: true, ran: "ae_zz_fam", args: { size: 2 } });
  });

  it("a member's own action field goes through as <action>_action", async () => {
    const r = await callTool("ae_zz_fam", { action: "two", two_action: "remove", comp_id: 3, expect: { project_path: "<unsaved>" } }, ctx);
    expect(body(r)).toMatchObject({ ok: true, ran: "ae_zz_fam_two", args: { action: "remove", comp_id: 3 } });
    expect(calls[0][1]).not.toHaveProperty("two_action");
    // The family's action is never mistaken for the member's.
    const wrong = await callTool("ae_zz_fam", { action: "remove", comp_id: 3, expect: { project_path: "<unsaved>" } }, ctx);
    expect(wrong.isError).toBe(true);
    // Under its old name the member takes its own action as before.
    const old = await callTool("ae_zz_fam_two", { action: "build", comp_id: 3, expect: { project_path: "<unsaved>" } }, ctx);
    expect(body(old)).toMatchObject({ ran: "ae_zz_fam_two", args: { action: "build" } });
  });

  it("the old member name still runs on its own", async () => {
    const r = await callTool("ae_zz_fam_two", { comp_id: 4, expect: { project_path: "<unsaved>" } }, ctx);
    expect(body(r)).toMatchObject({ ok: true, ran: "ae_zz_fam_two" });
  });

  it("bad arguments are checked against the member's schema and say which action", async () => {
    const r = await callTool("ae_zz_fam", { action: "two", comp_id: "x", expect: { project_path: "<unsaved>" } }, ctx);
    expect(r.isError).toBe(true);
    expect(body(r).message ?? r.content[0].text).toMatch(/action two, as ae_zz_fam_two/);
    const bad = await callTool("ae_zz_fam", { action: "three" }, ctx);
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("lists the family with a merged schema and the members' text", async () => {
    const res: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx, { toolset: "full" });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("ae_zz_fam");
    expect(names).not.toContain("ae_zz_fam_two");
    const fam = res.result.tools.find((t: any) => t.name === "ae_zz_fam");
    expect(fam.description).toContain("- one (ae_zz_fam): ae_zz_fam does a thing.");
    expect(fam.description).toContain("- two (ae_zz_fam_two), its own `action` given as `two_action`: ae_zz_fam_two does a thing.");
    const p = fam.inputSchema.properties;
    expect(p.action.enum).toEqual(["one", "two"]);
    expect(p.two_action.enum).toEqual(["build", "remove"]);
    expect(p.size.description).toMatch(/^\[one\]/);
    expect(p.comp_id.description).toMatch(/^\[two\]/);
    expect(p.mode.anyOf).toHaveLength(2); // the two members disagree on the type
    expect(p.idempotency_key).toBeDefined(); // a write, because ae_zz_fam_two takes expect
    expect(fam.inputSchema.required).toBeUndefined();
  });

  it("an idempotency key on the family returns the first answer for a resend", async () => {
    const args = { action: "two", comp_id: 5, expect: { project_path: "<unsaved>" }, idempotency_key: "k-1" };
    const first = body(await callTool("ae_zz_fam", args, ctx));
    const again = body(await callTool("ae_zz_fam", args, ctx));
    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ ran: "ae_zz_fam_two" });
    expect(first.ran).toBe("ae_zz_fam_two");
  });
});
