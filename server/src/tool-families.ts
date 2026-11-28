/**
 * server/src/tool-families.ts
 *
 * Tool families: one listed tool per family with an `action` field (ae_render_queue { action: "add" })
 * in place of a run of separate tools (ae_render_queue_add, _edit, _inspect, ...). Fewer, clearer tools
 * for the agent to choose between, and the safety text once per family instead of once per tool.
 *
 * Nothing breaks: the member tools stay registered (ALL_TOOLS is unchanged) and callable by their old
 * names, directly or through ae_invoke_tool; only the full tools/list and the search show the family
 * instead. Each action is validated with its member's own schema and run by its member's own handler,
 * so refinements, errors, checkpoints and receipts are exactly the member's. Five families share their
 * name with a member (ae_captions, ae_render_batch, ae_taste, ae_variants, ae_stabilize): called without
 * `action` they do what that tool always did.
 *
 * A member with an `action` field of its own (ae_deliver_step, ae_taste_rules, ...) takes it as
 * `<its action>_action` in the family: ae_deliver { action: "step", step_action: "next" } runs
 * ae_deliver_step { action: "next" }.
 *
 * The core list (Claude Desktop) keeps listing its member tools: its size budget is tight, and those
 * clients find the families through ae_search_tools.
 */

import { z } from "zod";
import { zodToJsonSchema } from "./schema.js";
import { AGENT_SAFETY_GUIDANCE, type ToolDefinition } from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";

interface FamilySpec {
  name: string;
  title: string;
  /** action -> member tool name, in the order they are listed. */
  actions: Array<[string, string]>;
  /** The action used when none is given: only for a family that shares its name with that member. */
  default?: string;
}

export const FAMILIES: FamilySpec[] = [
  { name: "ae_render_queue", title: "The Render Queue: add, read, edit, duplicate, apply delivery specs, render inside After Effects.", actions: [["add", "ae_render_queue_add"], ["status", "ae_render_queue_status"], ["inspect", "ae_render_queue_inspect"], ["edit", "ae_render_queue_edit"], ["duplicate", "ae_render_queue_duplicate"], ["apply_spec", "ae_render_queue_apply_spec"], ["render", "ae_render_queue_render"], ["render_status", "ae_render_queue_render_status"]] },
  { name: "ae_render_batch", title: "Render batches with aerender: plan, start, follow, resume, cancel.", actions: [["start", "ae_render_batch"], ["plan", "ae_render_batch_plan"], ["status", "ae_render_batch_status"], ["resume", "ae_render_batch_resume"], ["cancel", "ae_render_batch_cancel"]], default: "start" },
  { name: "ae_aerender", title: "One background aerender job: start, follow, cancel.", actions: [["start", "ae_aerender_start"], ["status", "ae_aerender_status"], ["cancel", "ae_aerender_cancel"]] },
  { name: "ae_captions", title: "Captions: plan, build, read, export, check.", actions: [["build", "ae_captions"], ["plan", "ae_captions_plan"], ["read", "ae_captions_read"], ["export", "ae_captions_export"], ["qa", "ae_captions_qa"]], default: "build" },
  { name: "ae_rig", title: "Expression Controls rigs: add controls, link, unlink, rename, list.", actions: [["add_controls", "ae_rig_add_controls"], ["link", "ae_rig_link"], ["unlink", "ae_rig_unlink"], ["rename", "ae_rig_rename"], ["list", "ae_rig_list"]] },
  { name: "ae_path", title: "Mask and shape paths: read, write, path operators, links, connectors.", actions: [["read", "ae_path_read"], ["write", "ae_path_write"], ["operator", "ae_path_operator"], ["link", "ae_path_link"], ["connector", "ae_path_connector"]] },
  { name: "ae_track", title: "Tracking inside the MCP: one point, 1-8 points (planar), read a track, apply it.", actions: [["point", "ae_track_point"], ["multi", "ae_track_multi"], ["read", "ae_track_read"], ["apply", "ae_track_apply"]] },
  { name: "ae_patch", title: "Patches that sit in the plate: check, colour match, grain, finish.", actions: [["check", "ae_patch_check"], ["color_match", "ae_patch_color_match"], ["grain", "ae_patch_grain"], ["finish", "ae_patch_finish"]] },
  { name: "ae_checkpoint", title: "Project checkpoints (.aep copies): create, list, revert.", actions: [["create", "ae_checkpoint_create"], ["list", "ae_checkpoint_list"], ["revert", "ae_checkpoint_revert"]] },
  { name: "ae_skill", title: "AE skills (reusable recipes): list, save, run.", actions: [["list", "ae_skill_list"], ["save", "ae_skill_save"], ["run", "ae_skill_run"]] },
  { name: "ae_taste", title: "The user's motion taste: read or set it, baseline a comp, learn from their changes, rules.", actions: [["prefs", "ae_taste"], ["baseline", "ae_taste_baseline"], ["learn", "ae_learn_taste"], ["rules", "ae_taste_rules"]], default: "prefs" },
  { name: "ae_variants", title: "Variants of a change on copies: make them, apply the pick, discard.", actions: [["create", "ae_variants"], ["pick", "ae_variants_pick"], ["discard", "ae_variants_discard"]], default: "create" },
  { name: "ae_dialog", title: "After Effects popups: list them, answer one.", actions: [["list", "ae_dialogs"], ["respond", "ae_dialog_respond"]] },
  { name: "ae_deliver", title: "Delivery: specs, recipes, run a recipe step by step, its status.", actions: [["specs", "ae_delivery_specs"], ["recipe", "ae_deliver_recipe"], ["step", "ae_deliver_step"], ["status", "ae_deliver_status"]] },
  { name: "ae_collect", title: "Collect files without the dialog: collect, relink the copy, report.", actions: [["files", "ae_collect_files"], ["relink", "ae_collect_relink"], ["report", "ae_collect_report"]] },
  { name: "ae_loudness", title: "Loudness: measure, then change the level.", actions: [["check", "ae_loudness_check"], ["apply", "ae_loudness_apply"]] },
  { name: "ae_stabilize", title: "Stabilizing a plate: apply from a track, or the stabilize-fix-unstabilize rig.", actions: [["apply", "ae_stabilize"], ["roundtrip", "ae_stabilize_roundtrip"]], default: "apply" },
  { name: "ae_cleanplate", title: "Clean plates for removals: pick the reference frame, build the patch rig.", actions: [["pick", "ae_cleanplate_pick"], ["setup", "ae_cleanplate_setup"]] },
  { name: "ae_screen", title: "Screen replacement: snap the corners, replace the screen.", actions: [["corners", "ae_screen_corners"], ["replace", "ae_screen_replace"]] },
];

export interface FamilyTool extends ToolDefinition<any> {
  /** The family's actions and their member tools. */
  members: Array<{ action: string; tool: ToolDefinition<any> }>;
  inputJsonSchema: Record<string, unknown>;
}

type Json = Record<string, unknown>;

/** A member's own `action` field, as the family takes it. */
export function ownActionField(action: string): string {
  return `${action}_action`;
}

function hasOwnAction(tool: ToolDefinition<any>): boolean {
  const props = (zodToJsonSchema(tool.schema) as { properties?: Json }).properties ?? {};
  return Object.prototype.hasOwnProperty.call(props, "action");
}

function stripSafety(text: string): string {
  return text.split(AGENT_SAFETY_GUIDANCE).join("").replace(/\s+$/, "");
}

/** All members' properties in one schema; a property some actions do not take says which do. */
function mergeSchemas(spec: FamilySpec, members: Array<{ action: string; tool: ToolDefinition<any> }>): Json {
  const props: Record<string, { variants: unknown[]; actions: string[] }> = {};
  for (const m of members) {
    const s = zodToJsonSchema(m.tool.schema) as { properties?: Json };
    for (const [own, v] of Object.entries(s.properties ?? {})) {
      const k = own === "action" ? ownActionField(m.action) : own;
      const entry = (props[k] ??= { variants: [], actions: [] });
      entry.actions.push(m.action);
      if (!entry.variants.some((x) => JSON.stringify(x) === JSON.stringify(v))) entry.variants.push(v);
    }
  }
  const all = members.map((m) => m.action);
  const out: Json = {
    action: {
      type: "string",
      enum: all,
      description: spec.default ? `What to do. Default ${spec.default} (what ${spec.name} did before it was a family).` : "What to do.",
    },
  };
  for (const [k, e] of Object.entries(props)) {
    let node: Json = e.variants.length === 1 ? { ...(e.variants[0] as Json) } : { anyOf: e.variants };
    if (e.actions.length < all.length) {
      const note = `[${e.actions.join(", ")}]`;
      node = { ...node, description: typeof node.description === "string" ? `${note} ${node.description}` : note };
    }
    out[k] = node;
  }
  return { type: "object", properties: out, ...(spec.default ? {} : { required: ["action"] }) };
}

function buildFamily(spec: FamilySpec, byName: Map<string, ToolDefinition<any>>): FamilyTool | null {
  const members = spec.actions.map(([action, name]) => ({ action, tool: byName.get(name) })).filter((m): m is { action: string; tool: ToolDefinition<any> } => !!m.tool);
  if (members.length !== spec.actions.length) return null; // a member is missing: keep the old tools listed
  const anySafety = members.some((m) => m.tool.description.includes(AGENT_SAFETY_GUIDANCE));
  const description =
    `${spec.title} One tool for ${members.length} actions: pick one with \`action\`` +
    (spec.default ? ` (default ${spec.default})` : "") +
    `. Each action takes the arguments of the tool it replaced (named in brackets), which still answers under that name.\n` +
    members
      .map((m) => `- ${m.action} (${m.tool.name})${hasOwnAction(m.tool) ? `, its own \`action\` given as \`${ownActionField(m.action)}\`` : ""}: ${stripSafety(m.tool.description)}`)
      .join("\n") +
    (anySafety ? `\n${AGENT_SAFETY_GUIDANCE}` : "");
  const actions = members.map((m) => m.action) as [string, ...string[]];
  const schema = z.object({ action: spec.default ? z.enum(actions).optional() : z.enum(actions) }).passthrough();
  const tool: FamilyTool = {
    name: spec.name,
    description,
    schema,
    members,
    inputJsonSchema: mergeSchemas(spec, members),
    handler: async (args: Record<string, unknown>, ctx) => {
      const { action: chosen, ...rest } = args;
      const action = (chosen as string | undefined) ?? spec.default;
      const member = members.find((m) => m.action === action);
      if (!member) throw new Error(`Invalid arguments for ${spec.name}: action must be one of ${actions.join(", ")}`);
      // The member's own action field travels as <action>_action.
      const own = ownActionField(member.action);
      if (Object.prototype.hasOwnProperty.call(rest, own)) {
        rest.action = rest[own];
        delete rest[own];
      }
      const parsed = member.tool.schema.safeParse(rest);
      if (!parsed.success) {
        throw new Error(
          `Invalid arguments for ${spec.name} (action ${action}, as ${member.tool.name}): ${parsed.error.issues.map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`
        );
      }
      return member.tool.handler(parsed.data, ctx);
    },
  };
  return tool;
}

let built: { key: string; families: FamilyTool[]; members: Set<string>; byName: Map<string, FamilyTool>; memberOf: Map<string, FamilyTool> } | null = null;

function registryKey(): string {
  return `${ALL_TOOLS.length}:${ALL_TOOLS[ALL_TOOLS.length - 1]?.name ?? ""}`;
}

function families() {
  if (built && built.key === registryKey()) return built;
  const byName = new Map(ALL_TOOLS.map((t) => [t.name, t] as const));
  const list = FAMILIES.map((f) => buildFamily(f, byName)).filter((f): f is FamilyTool => !!f);
  const members = new Set<string>();
  const memberOf = new Map<string, FamilyTool>();
  for (const f of list) for (const m of f.members) {
    members.add(m.tool.name);
    memberOf.set(m.tool.name, f);
  }
  built = { key: registryKey(), families: list, members, byName: new Map(list.map((f) => [f.name, f] as const)), memberOf };
  return built;
}

export function familyTools(): FamilyTool[] {
  return families().families;
}

/** The family tool of that name, if there is one. */
export function familyTool(name: string): FamilyTool | undefined {
  return families().byName.get(name);
}

/** The family a member tool belongs to. */
export function familyOf(memberName: string): FamilyTool | undefined {
  return families().memberOf.get(memberName);
}

/** What the full list and the search show: every tool that is not a family member, then the families. */
export function listedTools(): ToolDefinition<any>[] {
  const f = families();
  const listed: ToolDefinition<any>[] = [];
  const placed = new Set<string>();
  for (const t of ALL_TOOLS) {
    if (!f.members.has(t.name)) listed.push(t);
    else {
      // The family takes the place of its first member in the registry, so the list keeps its order.
      const fam = f.memberOf.get(t.name)!;
      if (!placed.has(fam.name)) {
        placed.add(fam.name);
        listed.push(fam);
      }
    }
  }
  return listed;
}
