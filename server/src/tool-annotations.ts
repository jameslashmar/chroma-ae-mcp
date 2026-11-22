/**
 * server/src/tool-annotations.ts
 *
 * MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) for every tool,
 * so a client can decide what to run without asking (reads) and what to flag (destructive writes).
 * They are hints for the client's permission prompts, never a safety boundary: the target guard,
 * checkpoints and quarantine still apply to every call.
 *
 * A tool whose behaviour depends on its arguments (read or write by `action`, a dry run by default)
 * is annotated for the worst case it allows.
 *
 * Defaults in the MCP spec: readOnlyHint false, destructiveHint true, idempotentHint false,
 * openWorldHint true. Only values that differ from those are sent, so the lists stay small.
 */

import { isWriteTool } from "./write-tools.js";
import { familyTool } from "./tool-families.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Not write tools (no `expect`, no checkpoint), but they change something: state, UI, processes, files, or send data out. */
const SIDE_EFFECTS = new Set([
  "ae_acknowledge", // clears a quarantine entry
  "ae_auto_checkpoint", // changes the setting when given values
  "ae_ask_user", // opens the panel and waits for the user
  "ae_taste",
  "ae_taste_baseline",
  "ae_learn_taste",
  "ae_taste_rules",
  "ae_aerender_cancel", // kills a process
  "ae_render_batch_cancel",
  "ae_dialog_respond", // presses a button in After Effects
  "ae_diagnostics", // writes a diagnostics file
  "ae_open_panel", // toggles a panel
  "ae_transcribe", // uploads audio to ElevenLabs
  "ae_captions_export", // writes (and may overwrite) a sidecar file
  "ae_collect_report",
]);

/** Write tools that only read (the `expect` guard is there so the answer is about the right project). */
const READS_WITH_GUARD = new Set(["ae_checkpoint_list", "ae_deliver_status"]);

/**
 * Tools that only add (a comp, layer, effect, marker, file, process) or work on temporary copies they
 * remove again: they never overwrite or delete what the user made.
 */
const ADDITIVE = new Set([
  // add to the project
  "ae_checkpoint_create",
  "ae_render_queue_add",
  "ae_render_queue_duplicate",
  "ae_import_footage",
  "ae_import_assets",
  "ae_add_effect",
  "ae_add_markers",
  "ae_create_layer",
  "ae_create_comp",
  "ae_build_from_data",
  "ae_reframe",
  "ae_rig_add_controls",
  "ae_camera_rig",
  "ae_text_backdrop",
  "ae_text_animator",
  "ae_shape",
  "ae_path_operator",
  "ae_path_connector",
  "ae_key_greenscreen",
  "ae_garbage_matte",
  "ae_caf_prep",
  "ae_cleanplate_setup",
  "ae_inpaint_plate",
  "ae_stabilize",
  "ae_stabilize_roundtrip",
  "ae_screen_replace",
  "ae_track_point",
  "ae_track_multi",
  "ae_variants",
  // start background work whose output goes to new files
  "ae_aerender_start",
  "ae_render_batch",
  "ae_render_batch_resume",
  // measure on temporary copies, removed again
  "ae_audio_analyze",
  "ae_loudness_check",
  "ae_render_templates",
  "ae_verify_render",
  "ae_scrub_check",
  "ae_check_legibility",
  "ae_explain_layer_proof",
  "ae_patch_check",
  "ae_region_stats",
  "ae_cleanplate_pick",
  "ae_screen_corners",
  // state that is not the user's work
  "ae_acknowledge",
  "ae_auto_checkpoint",
  "ae_ask_user",
  "ae_taste",
  "ae_taste_baseline",
  "ae_learn_taste",
  "ae_taste_rules",
  "ae_diagnostics",
  "ae_open_panel",
  "ae_transcribe",
  "ae_collect_report",
  "ae_view",
]);

/** Calling again with the same arguments leaves the same state (setters, saves, settings). */
const IDEMPOTENT = new Set([
  "ae_set_property",
  "ae_set_text",
  "ae_set_keyframe_ease",
  "ae_set_track_matte",
  "ae_batch_set",
  "ae_comp_settings",
  "ae_project_settings",
  "ae_set_footage_interpretation",
  "ae_footage_proxy",
  "ae_rig_unlink",
  "ae_remove_markers",
  "ae_save",
  "ae_auto_checkpoint",
  "ae_taste",
  "ae_acknowledge",
  "ae_view",
]);

/** The only tools that reach outside this machine. */
const OPEN_WORLD = new Set(["ae_transcribe"]);

export function annotationsFor(name: string): ToolAnnotations {
  const fam = familyTool(name);
  if (fam) {
    const each = fam.members.map((m) => memberAnnotations(m.tool.name));
    const out: ToolAnnotations = {};
    if (each.every((a) => a.readOnlyHint === true)) out.readOnlyHint = true;
    else {
      if (each.every((a) => a.readOnlyHint === true || a.destructiveHint === false)) out.destructiveHint = false;
      if (each.every((a) => a.readOnlyHint === true || a.idempotentHint === true)) out.idempotentHint = true;
    }
    if (each.every((a) => a.openWorldHint === false)) out.openWorldHint = false;
    return out;
  }
  return memberAnnotations(name);
}

function memberAnnotations(name: string): ToolAnnotations {
  const readOnly = READS_WITH_GUARD.has(name) || (!isWriteTool(name) && !SIDE_EFFECTS.has(name));
  const out: ToolAnnotations = {};
  if (readOnly) out.readOnlyHint = true;
  else {
    if (ADDITIVE.has(name)) out.destructiveHint = false;
    if (IDEMPOTENT.has(name)) out.idempotentHint = true;
  }
  if (!OPEN_WORLD.has(name)) out.openWorldHint = false;
  return out;
}

/** Every name in the lists above, for the test that keeps them in step with the registry. */
export const ANNOTATION_LISTS = { SIDE_EFFECTS, READS_WITH_GUARD, ADDITIVE, IDEMPOTENT, OPEN_WORLD };
