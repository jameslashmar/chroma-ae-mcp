import { zodToJsonSchema } from "./schema.js";
import { AGENT_SAFETY_GUIDANCE, type ToolDefinition } from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";

/**
 * Toolsets.
 *
 * - "full" (the default): tools/list returns ALL_TOOLS exactly as the tools define themselves.
 * - "core": a small list for hosts that load every tool schema into context (Claude Desktop):
 *   the CORE_TOOL_NAMES with trimmed text, plus three meta-tools (ae_search_tools,
 *   ae_get_tool_schema, ae_invoke_tool) that reach the rest. The Zod schemas and the full
 *   definitions are never touched; validation is always against the full schema.
 *
 * The header the relay sends on every request is X-Chroma-Toolset.
 */

export type Toolset = "full" | "core";
export const TOOLSET_HEADER = "x-chroma-toolset";
/** The relay sends the MCP client's name here (sanitised, at most 40 characters); the usage log records it. */
export const CLIENT_HEADER = "x-chroma-client";
export const TOOLSET_ENV = "CHROMA_AE_MCP_TOOLSET";

/** "core" -> core, undefined / "" / "full" -> full, anything else -> full with `invalid` set. */
export function parseToolset(value: unknown): { toolset: Toolset; invalid: boolean } {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return { toolset: "full", invalid: false };
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "full") return { toolset: "full", invalid: false };
  if (v === "core") return { toolset: "core", invalid: false };
  return { toolset: "full", invalid: true };
}

// ---------- groups ----------

export interface ToolGroup {
  blurb: string;
  tools: string[];
}

/**
 * Every tool in ALL_TOOLS belongs to exactly one group (test/toolsets.test.ts fails for a tool
 * without one). Blurbs are under 100 characters. Keep a group at about 30 tools at most.
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = {
  inspect: {
    blurb: "Read-only views of the project, comps, layers, keyframes, effects and cuts.",
    tools: [
      "ae_status", "ae_get_project", "ae_get_comp", "ae_comp_tree", "ae_get_layer_props", "ae_get_layer_full",
      "ae_find_layers", "ae_get_keyframes", "ae_get_markers", "ae_get_comp_settings", "ae_get_time_remap",
      "ae_list_effects", "ae_list_presets", "ae_project_items", "ae_describe_comp", "ae_explain_layer",
      "ae_explain_layer_proof", "ae_comp_fingerprint", "ae_comp_diff", "ae_scene_3d_report",
      "ae_get_footage_interpretation", "ae_validate_expressions", "ae_detect_cuts",
    ],
  },
  edit: {
    blurb: "Set properties, create layers and comps, layer operations, masks, shapes, markers, batch edits.",
    tools: [
      "ae_set_property", "ae_batch_set", "ae_create_layer", "ae_create_comp", "ae_layer_ops", "ae_precompose",
      "ae_set_track_matte", "ae_align", "ae_multi_comp_apply", "ae_build_from_data", "ae_reframe",
      "ae_add_markers", "ae_remove_markers", "ae_mask", "ae_shape", "ae_layout_apply",
    ],
  },
  project: {
    blurb: "Import and replace footage, interpretation, proxies, versions, save, comp and project settings.",
    tools: [
      "ae_import_footage", "ae_import_assets", "ae_replace_footage", "ae_set_footage_interpretation",
      "ae_footage_proxy", "ae_version_footage", "ae_save", "ae_comp_settings", "ae_project_settings",
      "ae_purge_unused",
    ],
  },
  effects: {
    blurb: "Add, change and remove effects, apply presets, key a green screen.",
    tools: ["ae_add_effect", "ae_set_effect", "ae_remove_effect", "ae_apply_preset", "ae_key_greenscreen"],
  },
  text: {
    blurb: "Text layers: content and styling, animators, fitting, measuring, backdrops, fonts, legibility.",
    tools: [
      "ae_set_text", "ae_text_animator", "ae_fit_text", "ae_measure_text", "ae_text_backdrop", "ae_fonts",
      "ae_check_text_overlap", "ae_estimate_legibility", "ae_check_legibility",
    ],
  },
  motion: {
    blurb: "Keyframe easing and retiming, staggers, time remap, graphs, timing checks, 3D camera rigs.",
    tools: [
      "ae_set_keyframe_ease", "ae_keyframes_transform", "ae_remove_keyframes", "ae_time_remap", "ae_stagger",
      "ae_stagger_layout", "ae_motion_graph", "ae_timing_check", "ae_camera_rig",
    ],
  },
  rig_paths: {
    blurb: "Rigs and controls, shape and mask paths, expression recipes, Essential Graphics, .mogrt.",
    tools: [
      "ae_rig_add_controls", "ae_rig_link", "ae_rig_unlink", "ae_rig_rename", "ae_rig_list", "ae_path_read",
      "ae_path_write", "ae_path_operator", "ae_path_link", "ae_path_connector", "ae_get_essential_graphics",
      "ae_set_essential_graphics", "ae_export_mogrt", "ae_expr_recipes", "ae_expr_recipe",
    ],
  },
  tracking_patching: {
    blurb: "Tracking, stabilizing, object removal (clean plates, inpaint), patches, screen replacement.",
    tools: [
      "ae_track_point", "ae_track_multi", "ae_track_read", "ae_track_apply", "ae_patch_check",
      "ae_patch_color_match", "ae_patch_grain", "ae_patch_finish", "ae_region_stats", "ae_stabilize",
      "ae_stabilize_roundtrip", "ae_cleanplate_pick", "ae_cleanplate_setup", "ae_inpaint_plate",
      "ae_mask_follow", "ae_garbage_matte", "ae_caf_prep", "ae_screen_corners", "ae_screen_replace",
    ],
  },
  render: {
    blurb: "Render queue, rendering in After Effects or with aerender, batches, templates, verify.",
    tools: [
      "ae_render_queue_add", "ae_render_queue_status", "ae_render_queue_inspect", "ae_render_queue_edit",
      "ae_render_queue_duplicate", "ae_render_queue_apply_spec", "ae_render_queue_render",
      "ae_render_queue_render_status", "ae_render_templates", "ae_aerender_start", "ae_aerender_status",
      "ae_aerender_cancel", "ae_render_batch_plan", "ae_render_batch", "ae_render_batch_status",
      "ae_render_batch_resume", "ae_render_batch_cancel", "ae_verify_render",
    ],
  },
  delivery: {
    blurb: "Delivery specs and recipes, preflight, house style, collecting and relinking files.",
    tools: [
      "ae_delivery_specs", "ae_check_delivery_file", "ae_deliver_recipe", "ae_deliver_step",
      "ae_deliver_status", "ae_preflight", "ae_house_style_check", "ae_collect_files", "ae_collect_relink",
      "ae_collect_report",
    ],
  },
  captions_audio: {
    blurb: "Captions (plan, build, read, export, QA), transcription, audio analysis, loudness, cue keys.",
    tools: [
      "ae_captions_plan", "ae_captions", "ae_captions_read", "ae_transcribe", "ae_captions_export",
      "ae_captions_qa", "ae_audio_analyze", "ae_cue_keys", "ae_loudness_check", "ae_loudness_apply",
    ],
  },
  review: {
    blurb: "Look at the work: stills, contact sheets, annotated frames, motion review, brief and taste.",
    tools: [
      "ae_snapshot_frame", "ae_contact_sheet", "ae_annotate_frame", "ae_compare_frames", "ae_scrub_check",
      "ae_motion_review", "ae_brief", "ae_taste", "ae_taste_baseline", "ae_taste_rules", "ae_learn_taste",
    ],
  },
  safety: {
    blurb: "Quarantine, checkpoints, variants, session changes and project sessions (open, new, close).",
    tools: [
      "ae_quarantine_status", "ae_acknowledge", "ae_checkpoint_create", "ae_checkpoint_list",
      "ae_auto_checkpoint", "ae_checkpoint_revert", "ae_variants", "ae_variants_pick", "ae_variants_discard",
      "ae_session_changes", "ae_project_session",
    ],
  },
  app: {
    blurb: "ExtendScript, dialogs, questions to the user, diagnostics, memory, panels, skills, viewer.",
    tools: [
      "ae_run_jsx", "ae_dialogs", "ae_dialog_respond", "ae_ask_user", "ae_diagnostics", "ae_memory_status",
      "ae_memory_purge", "ae_list_panels", "ae_open_panel", "ae_ui_screenshot", "ae_view", "ae_skill_list",
      "ae_skill_save", "ae_skill_run",
    ],
  },
};

const GROUP_BY_TOOL = new Map<string, string>();
for (const [group, def] of Object.entries(TOOL_GROUPS)) {
  for (const name of def.tools) GROUP_BY_TOOL.set(name, group);
}

export function groupOf(toolName: string): string | undefined {
  return GROUP_BY_TOOL.get(toolName);
}

/** Extra search words for tools whose description does not use the words people reach for. */
export const SEARCH_HINTS: Record<string, string> = {
  ae_layout_apply: "layout screens regions wall floor atlas template fit comp into rectangle copy camera place feed",
  ae_cleanplate_setup: "remove object person wire rig logo from shot paint out hide",
  ae_cleanplate_pick: "remove object person wire rig logo from shot paint out hide",
  ae_inpaint_plate: "remove object person wire rig logo from shot paint out fill hole",
  ae_caf_prep: "remove object from shot content aware fill paint out",
  ae_garbage_matte: "remove unwanted garbage mask outside",
  ae_render_queue_render: "render inside after effects without aerender export video file",
  ae_aerender_start: "render background aerender export video file command line",
  ae_preflight: "missing frames gaps sequence exr",
  ae_render_queue_add: "render export queue output",
  ae_screen_replace: "replace phone tv monitor screen content corner pin",
  ae_track_point: "track follow motion tracker point attach",
  ae_stabilize: "stabilize shaky camera smooth",
  ae_transcribe: "speech to text subtitles whisper",
  ae_captions: "subtitles lower thirds speech words",
};

// ---------- core list ----------

export const CORE_TOOL_NAMES: readonly string[] = [
  "ae_status", "ae_get_project", "ae_get_comp", "ae_comp_tree", "ae_get_layer_props", "ae_find_layers",
  "ae_get_keyframes", "ae_set_property", "ae_batch_set", "ae_set_text", "ae_create_layer", "ae_create_comp",
  "ae_layer_ops", "ae_import_footage", "ae_add_effect", "ae_set_effect", "ae_save", "ae_snapshot_frame",
  "ae_run_jsx", "ae_dialogs", "ae_dialog_respond", "ae_skill_run", "ae_multi_comp_apply",
  "ae_render_queue_add", "ae_render_queue_edit", "ae_render_queue_status", "ae_render_queue_render",
  "ae_render_queue_render_status", "ae_render_templates", "ae_aerender_start", "ae_aerender_status",
  "ae_set_footage_interpretation", "ae_import_assets",
];

export const META_TOOL_NAMES = ["ae_search_tools", "ae_get_tool_schema", "ae_invoke_tool"] as const;

// ---------- trimmed text ----------

type Json = Record<string, unknown>;

const SCHEMA_POINTER = "More: ae_get_tool_schema.";

/** Hand-written summaries for the core tools whose first sentence is not enough. */
export const CORE_DESCRIPTION_OVERRIDES: Record<string, string> = {
  ae_run_jsx:
    "Run ExtendScript (function body; `return` a value). With `mutates: true` it needs `expect`, runs in one undo group and returns a before/after receipt. ES3 only (no let/const/arrows, no chained ternaries). A best-effort safety lint (a guard rail, not a sandbox) refuses system.callSystem, file writes and deletes, dialogs and quitting. app.executeCommand silently does nothing through CEP: use DOM methods. Prefer a dedicated tool when one exists.",
  ae_render_queue_render:
    "Start After Effects' OWN render of the queued items (like pressing Render), returning a job id at once; poll ae_render_queue_render_status. AE stays busy until it ends and other AE tools are refused: tell the user first, save a dirty project, prefer ae_aerender_start. Never ask the user to press Render. `engine: \"media_encoder\"` queues the SAVED project in Media Encoder (AE stays free; the user checks the preset and presses Start): ask the user first, then `user_confirmed: true`; offer only if aerender did not start or a long render would lock AE. `item_indexes` renders only those items (not with media_encoder), else ALL queued; items it unchecked that could not be queued again are listed as pending_restores and block a new item_indexes render. Tell the user any `resource_warnings` / `sequence_check`.",
  ae_aerender_start:
    "Start a background aerender process for a saved, non-dirty project. One source: comp_name + output_path, rq_index + item_comp_id (a queued, saved item), or whole_queue. Returns a job id; follow with ae_aerender_status. `continue_on_missing_footage` renders anyway (colour bars for missing footage). If it cannot run, use ae_render_queue_render. Tell the user any `resource_warnings` / `sequence_check`.",
  ae_aerender_status:
    "Status of a background aerender job (running, succeeded, failed): frame progress, exit code, log tail and output paths. Never touches After Effects. `wait_seconds` (0-30) waits for a state change or an output file, so one call replaces several polls.",
  ae_render_queue_render_status:
    "State, elapsed time and output files (exists, bytes, mtime) of a render from ae_render_queue_render. Never touches AE. A Media Encoder job shows grew_since_last_check per file, never finished: confirm with ae_verify_render. `wait_seconds` (0-30) waits for a state change or an output file, so one call replaces several polls.",
  ae_render_templates:
    "List render-settings and output-module template names; action save stores a queue item's settings or module as a named template (NOT undoable, needs `expect`).",
  ae_dialogs:
    "READ-ONLY. List modal dialogs open in After Effects (title, text, kind, buttons (default marked), screenshot path, caused_by_op) from outside AE's blocked thread. Popups are never suppressed: answer only dialogs our own operation caused, with ae_dialog_respond; else ask the user.",
  ae_dialog_respond:
    "Press a button in an open After Effects modal dialog by its handle. Answer only dialogs our own operation caused. An AE-painted dialog is answered only with Cancel (No and Close beside a Cancel are refused), or with its default (outlined) button when that is OK/Yes/Continue; OK on text about replacing, losing, removing or erasing needs both allow_destructive and a user_instruction; it must have been listed with ae_dialogs first and is re-read right before the key. Tell the user what the dialog said; otherwise ask them.",
  ae_save:
    "Save the open project (backup copy first by default). `save_as: { path, overwrite? }` saves under a new .aep path (the only way to save an untitled project); `increment: true` the next free _vNNN. Both retarget the open project.",
  ae_create_comp:
    "Create a comp: mode 'new' (width, height, fps, duration...), 'from_footage' or 'duplicate' (deep duplicate is a DRY RUN unless dry_run: false). Guarded by `expect`.",
  ae_multi_comp_apply:
    "Run one guarded write tool (op {tool, args}, without comp_id and expect) on many comps picked by comp_ids, folder_id, nested_in or name_pattern. Each comp goes through that tool's own guard and is its own undo step (the way back is the automatic checkpoint); per-comp result table. dry_run resolves the comps first.",
  ae_skill_run:
    "Run a saved AE skill: its numbered steps run in one evalScript (one undo step). Writing skills need `expect`; pass what varies in `args`. List skills with ae_skill_list.",
  ae_comp_tree:
    "Read how comps nest: with no comp_id every comp with its use counts, depth and render-queue state, plus the top-level and unused comps; with comp_id what that comp contains and where it is used. Read-only.",
  ae_get_project:
    "Read the project item tree (id, name, type, folder; comps with size, fps, duration; footage with path and missing flag). Filter by kind, name or missing, sort, and page with offset/limit.",
  ae_get_layer_props:
    "Read a layer's property tree: matchName, name, value, numKeys, expression. `meta: true` adds what each property accepts (type, min/max, units); `shape_values: true` gives path and marker values.",
  ae_get_keyframes:
    "Read a property's keyframes: time, value, interpolation, temporal ease per side, spatial tangents, continuity flags and roving. Read-only; at most 500 keys per call (`truncated` says more exist).",
  ae_set_property:
    "Set a layer property's value, keyframes or expression in one undo group, guarded by `expect`, with a read-back receipt. Everything is validated before the group opens. Paths are { vertices, inTangents?, outTangents?, closed? }; markers go through keyframes.",
  ae_batch_set:
    "Set many properties on layers of one comp in one call (values, keyframes, expressions, paths, markers). Everything is validated first, then written in chunks of up to 500 ops, each one undo group guarded by `expect`, with read-back; a font that is not installed refuses the batch unless allow_substitute.",
  ae_set_text:
    "Update a text layer's string and styling (font, size, tracking, leading, colours, justification; `ranges` / `paragraphs` style parts; `style`: caps, baseline, kerning, scale...) in one undo group guarded by `expect`. A font that is not installed is refused.",
  ae_create_layer:
    "Create a layer in a comp: solid, null, adjustment, text, shape, camera, light, footage, precomp or mesh, with name, length, start, 3D, parent and stack position, in one undo group guarded by `expect`. Text takes `font`; lights `light_type`; meshes `mesh_type`.",
  ae_layer_ops:
    "Layer edits by `action`: parent, reorder, sort, duplicate, delete, trim, rename, switches (shy, solo, lock, 3D, blend mode, label...), replace_source and more. One undo group guarded by `expect`. For solids, `scope: layer_only` makes a new solid item; `solid_settings` changes the item and so every layer using it.",
  ae_import_footage:
    "Import footage files or an image sequence (PSD/AI as a comp, or a whole project, via import_as) into the project and an optional folder, guarded by `expect`; returns the new item_ids. Many files go through ae_import_assets. Importing may raise dialogs: they are never suppressed, read them with ae_dialogs.",
  ae_import_assets:
    "Batch import: scan a folder or pass `paths`, set interpretation with a shared `interpret` and per-pattern `rules`, all in one undo step, dry run first. Sequences count as one item; files already in the project are skipped; `max_seconds` stops a long batch and lists the rest. Guarded by `expect`. Without this tool a model imports one file at a time with ae_import_footage.",
  ae_snapshot_frame:
    "Render one frame of a comp to a PNG under the data dir's frames folder and return its path (`scale` or `max_size` to shrink). The file is checked fresh; `stale_frame` means After Effects returned an old frame. `save_to` with `frames` or `times` keeps full-size frames in a folder.",
  ae_render_queue_edit:
    "Edit a Render Queue item in one undo group guarded by `expect`: render-settings template, time span, queued flag, output module template/file/post-render action, add/remove modules; or remove items (`remove`, or `remove_filter` by status: use dry_run first). Refused while the queue renders.",
  ae_set_footage_interpretation:
    "Set footage interpretation without the dialog, one undo group guarded by expect: alpha, fields, pulldown, conform_frame_rate, loop, pixel_aspect. One item (item_id) or many (item_ids, up to 200, with overrides per item; strict, the default, refuses all if one item can't take its settings, strict:false writes the rest). Checked before AE is touched; read back in a separate call.",
  ae_add_effect:
    "Add an effect to a layer by match name (find it with ae_list_effects), optionally renamed and with static parameter values, in one undo group guarded by `expect`. Returns the effect index and every parameter, read back separately. An effect AE refuses a value for is taken out again.",
  ae_status:
    "Read panel health, AE version, project path ('<unsaved>' if none), dirty flag, active comp, selected layers and the quarantine list. `detail: true` adds the active item, selected properties, viewer, GPU and warnings. Call first; the selection can change, so act on explicit ids. If AE is busy it answers at once with `ae_answered:false` and `busy` (why, popups, how long), within 10 s at most, instead of waiting.",
};

function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const space = slice.lastIndexOf(" ");
  return (space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,;:(\-]+$/, "") + "...";
}

/** The first sentence or two of a text, up to `max` characters, without a trailing full stop issue. */
export function firstSentences(text: string, max: number, fill = false): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // fill: keep as much as fits (for untyped values, where the text is the only contract).
  if (fill) return cutAt(flat, max);
  // A sentence ends at ". " followed by an upper-case letter or a backtick, but not after e.g. / i.e.
  const sentences: string[] = [];
  let start = 0;
  const re = /([.!?])\s+(?=[A-Z`'(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const piece = flat.slice(start, m.index + 1);
    if (/(?:e\.g|i\.e|etc|vs)\.$/.test(piece) || /\b[A-Z]\.$/.test(piece)) continue;
    sentences.push(piece);
    start = m.index + m[0].length;
  }
  if (start < flat.length) sentences.push(flat.slice(start));
  let out = "";
  for (const s of sentences) {
    if (out && out.length + 1 + s.length > max) break;
    out = out ? out + " " + s : s;
    if (out.length >= max * 0.6) break;
  }
  return cutAt(out || flat, max);
}

export function stripSafety(description: string): string {
  return description.split(AGENT_SAFETY_GUIDANCE).join("").replace(/\s+$/, "");
}

export function carriesSafetyText(tool: ToolDefinition<any>): boolean {
  return tool.description.includes(AGENT_SAFETY_GUIDANCE);
}

const TOOL_DESC_MAX = 260;
const PROP_DESC_MAX = 64;
const PROP_DESC_MAX_UNTYPED = 250;
/** Properties whose whole text is the contract (path = tool.property.sub[]): kept longer. */
const CORE_PROPERTY_CAPS: Record<string, number> = {
  "ae_create_layer.mesh_options": 600,
  "ae_layer_ops.scope": 300,
  "ae_set_property.value": 400,
  "ae_batch_set.ops[].value": 400,
  "ae_add_effect.params[].value": 400,
  "ae_set_effect.params[].value": 400,
};

export function trimToolDescription(tool: ToolDefinition<any>): string {
  const override = CORE_DESCRIPTION_OVERRIDES[tool.name];
  const body = override ?? firstSentences(stripSafety(tool.description), TOOL_DESC_MAX);
  return `${body} ${SCHEMA_POINTER}`;
}

/**
 * Same structure, shorter text: every `description` under a schema node is cut to its first
 * clause. Property names, types, enums, required lists, items and nested properties are copied
 * as they are. `properties` keys are names, never descriptions.
 */
export function trimSchema(node: unknown, path = ""): unknown {
  if (Array.isArray(node)) return node.map((n) => trimSchema(n, path));
  if (node === null || typeof node !== "object") return node;
  const src = node as Json;
  const out: Json = {};
  // zodToJsonSchema emits `{}` for unions, records and literals, so for these (and for arrays of them)
  // the description is the only contract: keep much more of it.
  const itemsUntyped =
    src.type === "array" && src.items !== null && typeof src.items === "object" && Object.keys(src.items as object).filter((k) => k !== "description").length === 0;
  const untyped = (src.type === undefined && src.enum === undefined && src.properties === undefined) || itemsUntyped;
  for (const [key, value] of Object.entries(src)) {
    if (key === "description" && typeof value === "string") {
      const cap = CORE_PROPERTY_CAPS[path];
      const text = cap !== undefined
        ? firstSentences(value, cap, true)
        : untyped
          ? firstSentences(value, PROP_DESC_MAX_UNTYPED, true)
          : firstSentences(value, PROP_DESC_MAX);
      if (text) out.description = text;
    } else if (key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const props: Json = {};
      for (const [name, sub] of Object.entries(value as Json)) props[name] = trimSchema(sub, path ? `${path}.${name}` : name);
      out.properties = props;
    } else if (key === "items") {
      out.items = trimSchema(value, `${path}[]`);
    } else {
      out[key] = trimSchema(value, path);
    }
  }
  return out;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export function fullListEntry(t: ToolDefinition<any>): ListedTool {
  return { name: t.name, description: t.description, inputSchema: zodToJsonSchema(t.schema) };
}

export function trimmedListEntry(t: ToolDefinition<any>): ListedTool {
  return { name: t.name, description: trimToolDescription(t), inputSchema: trimSchema(zodToJsonSchema(t.schema), t.name) };
}

export function coreTools(): ToolDefinition<any>[] {
  const byName = new Map(ALL_TOOLS.map((t) => [t.name, t] as const));
  const out: ToolDefinition<any>[] = [];
  for (const name of CORE_TOOL_NAMES) {
    const t = byName.get(name);
    if (t) out.push(t);
  }
  return out;
}

// ---------- instructions (core mode) ----------

export function groupCounts(): Array<{ group: string; blurb: string; tools: number }> {
  return Object.entries(TOOL_GROUPS).map(([group, def]) => ({ group, blurb: def.blurb, tools: def.tools.length }));
}

export function coreInstructions(): string {
  const lines = groupCounts().map((g) => `- ${g.group} (${g.tools}): ${g.blurb}`);
  return [
    `Chroma AE MCP drives Adobe After Effects. ${AGENT_SAFETY_GUIDANCE}`,
    "",
    `This list shows ${CORE_TOOL_NAMES.length} everyday tools; ${ALL_TOOLS.length} exist in all. The rest are reached through three tools. ae_search_tools and ae_get_tool_schema never touch After Effects, so they work while it is busy or blocked; ae_invoke_tool runs a tool like any other, so it is refused while AE is rendering, and with a busy message while a popup or a long operation holds AE (ae_status says why):`,
    "- ae_search_tools { query?, pattern?, group?, limit?, offset?, detail? }: find tools by keywords, a name fragment (^ and $ anchor it; not a regex) or a group. An empty call lists the groups.",
    "- ae_get_tool_schema { name | names }: full description (with the safety text) and schema of up to 5 tools. Read it before a tool's first use.",
    "- ae_invoke_tool { name, arguments }: call any tool by name, exactly like calling it directly. Put the tool's arguments under `arguments`.",
    "Tools shown in this list can be called directly. Every tool that changes the project takes `expect` (project_path, optional comp_id); copy project_path from ae_status.",
    "",
    "Tool groups:",
    ...lines,
  ].join("\n");
}

// ---------- search ----------

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "from", "with", "and", "or", "my", "me", "i", "it", "is", "this",
  "that", "how", "do", "can", "some", "something", "into", "by", "at", "as", "be", "tool", "tools", "ae",
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 3 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

function propertyNames(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) propertyNames(n, out, depth + 1);
    return;
  }
  const src = node as Json;
  const props = src.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [name, sub] of Object.entries(props as Json)) {
      out.add(name);
      propertyNames(sub, out, depth + 1);
    }
  }
  if (src.items) propertyNames(src.items, out, depth + 1);
}

interface IndexedTool {
  tool: ToolDefinition<any>;
  group: string;
  tf: Map<string, number>;
  length: number;
}

const FIELD_WEIGHT = { name: 5, hints: 3, group: 2, props: 2, desc: 1 };

let searchIndex: { built: number; docs: IndexedTool[]; df: Map<string, number>; avg: number } | null = null;

function buildIndex() {
  if (searchIndex && searchIndex.built === ALL_TOOLS.length) return searchIndex;
  const docs: IndexedTool[] = [];
  const df = new Map<string, number>();
  for (const tool of ALL_TOOLS) {
    const group = groupOf(tool.name) ?? "other";
    const props = new Set<string>();
    propertyNames(zodToJsonSchema(tool.schema), props);
    const tf = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const tok of tokenize(text)) tf.set(tok, (tf.get(tok) ?? 0) + weight);
    };
    add(tool.name.replace(/^ae_/, ""), FIELD_WEIGHT.name);
    add(SEARCH_HINTS[tool.name] ?? "", FIELD_WEIGHT.hints);
    add(group, FIELD_WEIGHT.group);
    add([...props].join(" "), FIELD_WEIGHT.props);
    add(stripSafety(tool.description), FIELD_WEIGHT.desc);
    let length = 0;
    for (const v of tf.values()) length += v;
    for (const tok of tf.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
    docs.push({ tool, group, tf, length });
  }
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  searchIndex = { built: ALL_TOOLS.length, docs, df, avg };
  return searchIndex;
}

/** BM25 over the weighted fields (name, hints, group, property names, description). */
export function rankTools(query: string, candidates?: Set<string>): Array<{ tool: ToolDefinition<any>; group: string; score: number }> {
  const idx = buildIndex();
  const terms = [...new Set(tokenize(query))];
  const N = idx.docs.length;
  const k1 = 1.4;
  const b = 0.6;
  const scored: Array<{ tool: ToolDefinition<any>; group: string; score: number }> = [];
  for (const doc of idx.docs) {
    if (candidates && !candidates.has(doc.tool.name)) continue;
    let score = 0;
    for (const term of terms) {
      const f = doc.tf.get(term) ?? 0;
      if (!f) continue;
      const n = idx.df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / idx.avg));
    }
    // A query word inside the tool name is a strong signal (track -> ae_track_point).
    const bare = doc.tool.name.replace(/^ae_/, "");
    const rawTerms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    for (const w of rawTerms) if (bare.includes(w)) score += 1.5;
    if (score > 0) scored.push({ tool: doc.tool, group: doc.group, score });
  }
  scored.sort((a, b2) => b2.score - a.score || a.tool.name.localeCompare(b2.tool.name));
  return scored;
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The closest tool names to a name that does not exist. */
export function closestToolNames(name: string, count = 5): string[] {
  const wanted = name.slice(0, 80).toLowerCase().replace(/^ae_/, "");
  const scored = ALL_TOOLS.map((t) => {
    const bare = t.name.replace(/^ae_/, "");
    let score = editDistance(wanted, bare);
    if (bare.includes(wanted) || wanted.includes(bare)) score = Math.min(score, 1 + Math.abs(bare.length - wanted.length) / 10);
    return { name: t.name, score };
  });
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, count).map((s) => s.name);
}
