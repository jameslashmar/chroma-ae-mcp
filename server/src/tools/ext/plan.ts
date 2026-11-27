/**
 * server/src/tools/ext/plan.ts
 *
 * ae_plan: read before a task. Given the user's request (in their own words and language) and the
 * kind of task, it reads the open project (host planContext, one read) and returns what it took the
 * request to mean (the comp and layers it resolved), the questions whose answers would change the
 * work (with options from the project and a default each), a plan of steps with the tool for each,
 * extra steps worth offering, and hazards (the AE 26.3 render hang).
 *
 * The server has no language model of its own: the client's model understands the request and
 * passes the intent and the layer names it mentions; this tool adds what only the project knows.
 *
 * Questions follow the user's choice in the panel ("Ask first", off by default): off, no question
 * is asked and the defaults are used and listed as assumptions; on, the agent asks them (choices
 * through ae_ask_user, open ones in the chat), one at a time, and calls ae_plan again with answers.
 */

import { z } from "zod";
import type { SettingsStore } from "../../settings.js";
import { type ToolContext, type ToolDefinition } from "../common.js";

export const PLAN_INTENTS = ["animate", "text", "track", "key", "cleanup", "color", "compose_3d", "render", "review", "edit", "other"] as const;
export type PlanIntent = (typeof PLAN_INTENTS)[number];

export const AePlanSchema = z.object({
  request: z.string().min(1).max(4000).describe("The user's request, in their words and language."),
  intent: z
    .enum(PLAN_INTENTS)
    .optional()
    .describe(
      "The kind of task, as you read the request (track: pin to a moving surface; key: green screen; cleanup: paint out; edit: change what is there). Default: guessed from English words."
    ),
  comp_id: z.number().int().optional().describe("Default: the active comp, else the only one."),
  layers: z.array(z.string().min(1).max(200)).max(20).optional().describe("Layer names the request mentions."),
  answers: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Answers to an earlier call's questions: {question id: option value or text}."),
});
export type AePlanArgs = z.infer<typeof AePlanSchema>;

// ---------- what the host reads ----------

export interface PlanLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  three_d: boolean;
  enabled: boolean;
  locked: boolean;
  selected: boolean;
  keyed: string[];
  effects: number;
}

export interface PlanContext {
  project_path: string;
  dirty: boolean | null;
  ae_version: string;
  comps: Array<{ id: number; name: string; width: number; height: number; fps: number; duration: number; num_layers: number; active: boolean }>;
  comps_total: number;
  comp: {
    id: number;
    name: string;
    why: "given" | "active" | "only";
    width: number;
    height: number;
    fps: number;
    duration: number;
    work_area: [number, number];
    time: number;
    renderer: string;
    layers: PlanLayer[];
    layers_total: number;
    selected_layers: number[];
    selected_properties: Array<{ layer: string | null; name: string; match_name: string; keys: number }>;
    render_hazard: { comp_id: number; comp_name: string; light: string; layer: string } | null;
  } | null;
  comp_not_found: boolean;
  render_queue: { items: number; queued: number };
}

// ---------- the plan ----------

export interface PlanOption {
  value: string;
  label: string;
  detail?: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  why: string;
  /** choice: ae_ask_user with these options; ease: ae_ask_user kind 'ease'; open: ask in the chat. */
  kind: "choice" | "ease" | "open";
  options?: PlanOption[];
  default: string;
}

export interface PlanStep {
  tool: string;
  does: string;
}

export interface PlanExtra {
  title: string;
  tool: string;
  why: string;
  /** try: safe to run (read-only or undoable); ask: offer it first. */
  run: "try" | "ask";
}

/** Tools the plans name; a test checks every one is registered. */
export const PLAN_TOOLS = new Set<string>();
const step = (tool: string, does: string): PlanStep => {
  PLAN_TOOLS.add(tool);
  return { tool, does };
};
const extra = (title: string, tool: string, why: string, run: "try" | "ask"): PlanExtra => {
  PLAN_TOOLS.add(tool);
  return { title, tool, why, run };
};

const KEYWORDS: Array<[PlanIntent, RegExp]> = [
  ["render", /\b(render|export|deliver|output|encode)/i],
  ["track", /\b(track|stick|pin|attach|follow)/i],
  ["key", /\b(green ?screen|blue ?screen|chroma ?key|keying|key out)/i],
  ["cleanup", /\b(remove|clean ?up|paint out|erase|wire|rig removal)/i],
  ["text", /\b(text|title|caption|subtitle|font|lower third|typography)/i],
  ["compose_3d", /\b(3d|camera|light|depth|parallax)/i],
  ["color", /\b(colou?r|grade|grading|lut|match)/i],
  ["animate", /\b(animat|move|motion|keyframe|ease|bounce|slide|fade|pop|spin)/i],
  ["review", /\b(review|critique|feedback|look at|check)/i],
];

export function guessIntent(request: string): PlanIntent {
  for (const [intent, re] of KEYWORDS) if (re.test(request)) return intent;
  return "other";
}

/** The intents that change one or more layers, and so need to know which. */
const NEEDS_LAYER: Partial<Record<PlanIntent, (l: PlanLayer) => boolean>> = {
  animate: (l) => l.kind !== "camera" && l.kind !== "light",
  key: (l) => l.kind === "footage" || l.kind === "precomp" || l.kind === "av",
  cleanup: (l) => l.kind === "footage" || l.kind === "precomp" || l.kind === "av",
  color: (l) => l.kind !== "camera" && l.kind !== "light" && l.kind !== "null",
  track: (l) => l.kind !== "camera" && l.kind !== "light" && l.kind !== "null",
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, " ").trim();

/** The layers the request names (exact name first, then a name containing it), else the selected ones. */
export function resolveLayers(ctx: PlanContext, names: string[] | undefined): { layers: PlanLayer[]; unknown: string[]; from: "named" | "selected" | "none" } {
  const all = ctx.comp?.layers ?? [];
  if (names && names.length) {
    const found: PlanLayer[] = [];
    const unknown: string[] = [];
    for (const n of names) {
      const w = norm(n);
      const hit = all.find((l) => norm(l.name) === w) ?? all.find((l) => norm(l.name).includes(w));
      if (hit) {
        if (!found.includes(hit)) found.push(hit);
      } else unknown.push(n);
    }
    if (found.length) return { layers: found, unknown, from: "named" };
    return { layers: all.filter((l) => l.selected), unknown, from: all.some((l) => l.selected) ? "selected" : "none" };
  }
  const sel = all.filter((l) => l.selected);
  return { layers: sel, unknown: [], from: sel.length ? "selected" : "none" };
}

const sec = (s: number) => `${Number(s.toFixed(2))} s`;

/** Steps and extras for each kind of task. Every tool named is a real one (tested). */
function recipe(intent: PlanIntent, a: { many: boolean; hazard: boolean }): { steps: PlanStep[]; extras: PlanExtra[] } {
  switch (intent) {
    case "animate":
      return {
        steps: [
          step("ae_get_layer_props", "read the property and any keys already on it"),
          step("ae_set_property", "set the keyframes (times, values)"),
          step("ae_set_keyframe_ease", "give them the feel (ease curve)"),
          step("ae_motion_review", "check spacing, speed jumps and the rest pose"),
        ],
        extras: [
          extra("Show the move as frames", "ae_contact_sheet", "the user sees the timing before judging it", "try"),
          ...(a.many ? [extra("Offset the layers in time", "ae_stagger", "several layers move: a stagger reads better than all at once", "ask")] : []),
          extra("Save the project's motion language", "ae_brief", "durations and eases stay the same across the project", "ask"),
        ],
      };
    case "text":
      return {
        steps: [
          step("ae_fonts", "check the font exists and has every character of the text (action check, with text)"),
          step("ae_create_layer", "make the text layer, or ae_set_text to change one"),
          step("ae_fit_text", "fit it to its box or the safe area"),
          step("ae_check_legibility", "check it reads over the picture"),
        ],
        extras: [
          extra("Animate it in", "ae_text_animator", "a reveal by character, word or line", "ask"),
          extra("Check overlaps with other text", "ae_check_text_overlap", "titles stacked in one comp", "try"),
        ],
      };
    case "track":
      return {
        steps: [
          step("ae_track_multi", "track points on the surface, with preview: look at the contact sheet"),
          step("ae_track_apply", "write it to the layer (corner_pin for a flat insert, transform to follow); follow model_advice with refit_model when the corners shake"),
          step("ae_patch_check", "render a few frames and measure slip against the plate"),
        ],
        extras: [
          extra("Steady a track that shakes", "ae_track_apply", "smooth_frames 1-2, or refit_model as model_advice says", "ask"),
          extra("Stabilize the shot instead", "ae_stabilize", "when the goal is a steady picture, not an insert", "ask"),
        ],
      };
    case "key":
      return {
        steps: [
          step("ae_key_greenscreen", "Keylight, Key Cleaner and Spill Suppressor, with a measured check"),
          step("ae_matte_check", "holes, edge chatter and a see-through core on rendered frames"),
        ],
        extras: [extra("Match the subject to the new background", "ae_color_match_element", "levels from pairs of element and plate areas", "ask")],
      };
    case "cleanup":
      return {
        steps: [
          step("ae_cleanplate_setup", "a clean plate to paint from, held to the shot's motion"),
          step("ae_patch_check", "measure slip, seam and edge of the patch on rendered frames"),
        ],
        extras: [
          extra("Fill from the frames around it", "ae_inpaint_plate", "the area shows in other frames", "ask"),
          extra("Match the grain", "ae_patch_grain", "a clean patch looks pasted on a grainy plate", "try"),
        ],
      };
    case "color":
      return {
        steps: [
          step("ae_list_effects", "find the effect to use"),
          step("ae_add_effect", "add it"),
          step("ae_set_effect", "set its values"),
          step("ae_compare_frames", "compare before and after"),
        ],
        extras: [extra("Match an element to its plate", "ae_color_match_element", "measured levels instead of eyeballing", "ask")],
      };
    case "compose_3d":
      return {
        steps: [
          step("ae_scene_3d_report", "where the camera, lights and layers are, by depth"),
          step("ae_camera_rig", "a camera with a controller, or retune the one there"),
          step("ae_create_layer", "lights, meshes and 3D layers"),
          step("ae_annotate_frame", "a frame with the layers labelled (include_3d)"),
        ],
        extras: a.hazard ? [] : [extra("Depth spread for parallax", "ae_camera_rig", "spread: layers at different depths, scaled to keep their size", "ask")],
      };
    case "render":
      return {
        steps: [
          step("ae_preflight", "missing footage, fonts, expressions with errors, empty comps"),
          step("ae_save", "the render reads the saved project"),
          step("ae_render_templates", "the output modules this AE has"),
          step("ae_render_queue_add", "queue the comp with the output path and template"),
          step("ae_aerender_start", "render in the background (or ae_render_queue_render inside AE)"),
          step("ae_verify_render", "check the file: frames, size, fps, audio"),
        ],
        extras: [
          extra("Check against a delivery spec", "ae_check_delivery_file", "broadcast or platform specs", "try"),
          extra("Collect the project with its files", "ae_collect_files", "hand-off or archive", "ask"),
        ],
      };
    case "review":
      return {
        steps: [
          step("ae_describe_comp", "what is in the comp and when"),
          step("ae_motion_review", "motion problems: speed jumps, linear keys, cut-off moves"),
          step("ae_contact_sheet", "frames to look at"),
          step("ae_timing_check", "holds, dead stretches, reading time"),
        ],
        extras: [
          extra("Check the house style", "ae_house_style_check", "the project's brief and taste rules", "try"),
          extra("Check text legibility", "ae_check_legibility", "text over busy picture", "try"),
        ],
      };
    case "edit":
      return {
        steps: [
          step("ae_get_layer_props", "read what is there"),
          step("ae_set_property", "change it (or ae_layer_ops for layer order, duplicate, delete)"),
          step("ae_comp_diff", "say what changed"),
        ],
        extras: [extra("Show the result", "ae_snapshot_frame", "a frame after the change", "try")],
      };
    default:
      return {
        steps: [step("ae_describe_comp", "what is in the comp"), step("ae_search_tools", "find the tools for the task (query: the user's words)")],
        extras: [],
      };
  }
}

const EASES: PlanOption[] = [
  { value: "gentle", label: "Gentle", detail: "[0.25, 0.1, 0.25, 1]" },
  { value: "snappy", label: "Snappy", detail: "[0.2, 0, 0, 1]" },
  { value: "expo_out", label: "Fast out, soft landing", detail: "[0.16, 1, 0.3, 1]" },
];

/** Builds the plan from the request, the project read and the user's "Ask first" choice. Pure. */
export function buildPlan(args: AePlanArgs, ctx: PlanContext, askFirst: boolean): Record<string, unknown> {
  const answers = args.answers ?? {};
  const intent: PlanIntent = args.intent ?? guessIntent(args.request);
  const questions: PlanQuestion[] = [];
  const notes: string[] = [];
  const hazards: string[] = [];
  const comp = ctx.comp;

  if (ctx.comp_not_found) notes.push(`Comp ${args.comp_id} is not in the project.`);
  if (!comp) {
    if (ctx.comps_total === 0) notes.push("The project has no comp yet: the first step makes one (ae_create_comp).");
    else {
      const named = ctx.comps.filter((c) => args.request.toLowerCase().includes(c.name.toLowerCase()) && c.name.length > 2);
      const pool = (named.length ? named : ctx.comps).slice(0, 8);
      questions.push({
        id: "comp",
        question: "Which comp is this about?",
        why: `${ctx.comps_total} comps and none is open in the viewer.`,
        kind: "choice",
        options: pool.map((c) => ({ value: String(c.id), label: c.name, detail: `${c.width}x${c.height}, ${c.fps} fps, ${sec(c.duration)}, ${c.num_layers} layers` })),
        default: String(pool[0].id),
      });
    }
  }

  const res = resolveLayers(ctx, args.layers);
  if (res.unknown.length) notes.push(`No layer named ${res.unknown.map((n) => `"${n}"`).join(", ")} in "${comp?.name ?? "the comp"}".`);
  const fits = NEEDS_LAYER[intent];
  if (comp && fits && res.layers.length === 0) {
    const cands = comp.layers.filter(fits);
    if (cands.length === 1) {
      res.layers.push(cands[0]);
      notes.push(`"${cands[0].name}" is the only layer this can apply to.`);
    } else if (cands.length > 1) {
      questions.push({
        id: "layer",
        question: intent === "track" ? "Which layer should follow the surface?" : "Which layer is this about?",
        why: "None is named in the request or selected.",
        kind: "choice",
        options: cands.slice(0, 8).map((l) => ({ value: String(l.index), label: l.name, detail: `${l.kind}${l.three_d ? ", 3D" : ""}${l.keyed.length ? ", keyed: " + l.keyed.join(", ") : ""}` })),
        default: String(cands[0].index),
      });
    }
  }

  if (intent === "animate") {
    const keyed = res.layers.filter((l) => l.keyed.length);
    if (keyed.length) {
      questions.push({
        id: "existing_keys",
        question: `${keyed.map((l) => `"${l.name}"`).join(", ")} already has keyframes (${[...new Set(keyed.flatMap((l) => l.keyed))].join(", ")}). Keep them and add, or replace them?`,
        why: "Replacing removes the move that is there now.",
        kind: "choice",
        options: [
          { value: "keep", label: "Keep them, add the new keys" },
          { value: "replace", label: "Replace them" },
        ],
        default: "keep",
      });
    }
    const fps = comp?.fps ?? 25;
    questions.push({
      id: "duration",
      question: "How long should the move take?",
      why: "Timing changes the feel more than anything else.",
      kind: "choice",
      options: [0.5, 1, 2].map((s) => ({ value: String(s), label: sec(s), detail: `${Math.round(s * fps)} frames at ${fps} fps` })),
      default: "1",
    });
    questions.push({ id: "feel", question: "What should the move feel like?", why: "The ease curve sets the feel.", kind: "ease", options: EASES, default: "gentle" });
  }
  if (intent === "text") {
    questions.push({ id: "text", question: "What should the text say, exactly?", why: "The font is checked against every character of it.", kind: "open", default: "the text in the request" });
  }
  if (intent === "track") {
    questions.push({ id: "surface", question: "Which surface should it stick to (where in the frame)?", why: "The points go on that surface only; points off it make the track slide.", kind: "open", default: "the surface the request names" });
  }
  if (intent === "render") {
    questions.push({
      id: "format",
      question: "What should the file be?",
      why: "The output module decides the codec and the extension.",
      kind: "choice",
      options: [
        { value: "h264", label: "H.264 MP4 (review, web)" },
        { value: "prores", label: "ProRes MOV (editing, grading)" },
        { value: "png_sequence", label: "PNG sequence (frames)" },
      ],
      default: "h264",
    });
    if (comp && (comp.work_area[0] > 0.001 || Math.abs(comp.work_area[1] - comp.duration) > 0.001)) {
      questions.push({
        id: "range",
        question: `Render the work area (${sec(comp.work_area[0])} to ${sec(comp.work_area[0] + comp.work_area[1])}) or the whole comp (${sec(comp.duration)})?`,
        why: "The work area is shorter than the comp.",
        kind: "choice",
        options: [
          { value: "work_area", label: "Work area" },
          { value: "whole", label: "Whole comp" },
        ],
        default: "whole",
      });
    }
  }

  if (comp?.render_hazard) {
    const h = comp.render_hazard;
    hazards.push(
      `After Effects ${ctx.ae_version} never finishes rendering "${h.comp_name}": the light "${h.light}" takes its image from a layer and "${h.layer}" is a 3D layer it lights. Frames and renders of it are refused before AE renders; for a frame, the user clears that light's Source or switches it off.`
    );
  }

  const writes = intent !== "review";
  const extrasBefore: PlanExtra[] = [];
  if (writes && ctx.project_path === "<unsaved>") {
    extrasBefore.push(extra("Save the project first", "ae_save", "an unsaved project gets no checkpoint, so a write cannot be rolled back", "ask"));
  } else if (writes && ctx.dirty) {
    extrasBefore.push(extra("Checkpoint before the change", "ae_checkpoint_create", "the project has unsaved changes; a checkpoint keeps the way back", "try"));
  }

  const { steps, extras } = recipe(intent, { many: res.layers.length > 1, hazard: !!comp?.render_hazard });

  // The user's answers take the place of their questions.
  const answered: Record<string, unknown> = {};
  const open: PlanQuestion[] = [];
  for (const q of questions) {
    if (answers[q.id] !== undefined) answered[q.id] = answers[q.id];
    else open.push(q);
  }
  const labelOf = (q: PlanQuestion, v: string) => q.options?.find((o) => o.value === v)?.label ?? v;
  const assumptions = askFirst ? [] : open.map((q) => ({ id: q.id, assumed: labelOf(q, q.default), value: q.default, because: q.why }));

  const understood: Record<string, unknown> = {
    intent,
    intent_from: args.intent ? "given" : "guessed",
    comp: comp ? { id: comp.id, name: comp.name, from: comp.why, size: [comp.width, comp.height], fps: comp.fps, duration: comp.duration, renderer: comp.renderer } : null,
    layers: res.layers.map((l) => ({ index: l.index, name: l.name, kind: l.kind, keyed: l.keyed })),
    layers_from: res.layers.length ? res.from : "none",
    ...(comp?.selected_properties.length ? { selected_properties: comp.selected_properties } : {}),
  };

  const next = askFirst
    ? open.length
      ? "Ask these in the user's language, one at a time: choice and ease questions with ae_ask_user (question and options as given, kind 'ease' for feel), open ones in the chat. Skip any the request already answers. Then call ae_plan again with answers {id: value}, or go ahead with the defaults for the ones left."
      : "Nothing left to ask: go ahead with the plan."
    : "Ask first is off (the user's choice in the Chroma panel): ask nothing. Go ahead with the plan and the assumptions; tell the user the assumptions in one short line, so they can correct you.";

  return {
    ok: true,
    action: "plan",
    ask_first: askFirst,
    understood,
    ...(Object.keys(answered).length ? { answered } : {}),
    questions: askFirst ? open : [],
    assumptions,
    plan: [...extrasBefore.filter((e) => e.run === "try").map((e) => ({ tool: e.tool, does: e.title.toLowerCase() })), ...steps],
    extras: [...extrasBefore.filter((e) => e.run === "ask"), ...extras],
    ...(hazards.length ? { hazards } : {}),
    ...(notes.length ? { notes } : {}),
    project: { path: ctx.project_path, dirty: ctx.dirty, ae_version: ctx.ae_version, comps: ctx.comps_total, render_queue: ctx.render_queue },
    next,
  };
}

function askFirstOf(settings: SettingsStore | undefined): boolean {
  return settings ? settings.get().plan.ask_first === true : false;
}

export const planTools: ToolDefinition<any>[] = [
  {
    name: "ae_plan",
    description:
      "Call it first for a new task. Pass the user's request (their words and language), the intent you read in it, and the layer names it mentions. It reads the open project once and returns: what it took the request to mean (comp and layers resolved from the active comp and the selection), a plan of steps with the tool for each, extras worth offering (marked try: safe to run, or ask: offer first), and hazards. " +
      "Questions follow the user's choice in the Chroma panel (Ask first, off by default). Off: questions is empty and the defaults are listed as assumptions; go ahead and tell the user them in one line. On: questions lists what would change the work, each with options from the project and a default; ask them one at a time (ae_ask_user for choices, the chat for open ones), then call again with answers to get the plan with them. Read-only: it never changes the project.",
    schema: AePlanSchema,
    handler: async (args: AePlanArgs, ctx: ToolContext) => {
      const answered = args.answers?.comp;
      const compId = args.comp_id ?? (answered !== undefined && Number.isFinite(Number(answered)) ? Number(answered) : undefined);
      const res = await ctx.bridge.callHost<PlanContext>("planContext", compId !== undefined ? { comp_id: compId } : {}, { label: "ae_plan", mutates: false, toolName: "ae_plan" });
      return buildPlan({ ...args, ...(compId !== undefined ? { comp_id: compId } : {}) }, res.result, askFirstOf(ctx.settings));
    },
  },
];
