import { describe, expect, it } from "vitest";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

// Tool groups are built in their own files and registered by hand in
// tools/ext/index.ts: this catches one that was left out, or a write tool
// missing from the automatic checkpoints.
const READS = [
  "ae_annotate_frame", "ae_get_comp_settings", "ae_preflight", "ae_session_changes",
  "ae_captions_plan", "ae_captions_read", "ae_rig_list", "ae_expr_recipes", "ae_measure_text", "ae_get_time_remap",
  "ae_scene_3d_report", "ae_explain_layer", "ae_describe_comp", "ae_get_footage_interpretation", "ae_path_read",
  "ae_memory_status",
];
const WRITES_WITH_CHECKPOINT = [
  "ae_layer_ops", "ae_comp_settings",
  "ae_captions",
  "ae_rig_add_controls",
  "ae_rig_link",
  "ae_rig_unlink",
  "ae_rig_rename",
  "ae_expr_recipe",
  "ae_fit_text",
  "ae_text_backdrop",
  "ae_stagger",
  "ae_stagger_layout",
  "ae_time_remap",
  "ae_camera_rig",
  "ae_explain_layer_proof",
  "ae_scrub_check",
  "ae_set_footage_interpretation",
  "ae_footage_proxy",
  "ae_path_write",
  "ae_path_operator",
  "ae_path_link",
  "ae_path_connector",
];
// Changes AE's caches, not the project: nothing to checkpoint.
const WRITES_WITHOUT_CHECKPOINT = ["ae_memory_purge"];
// Runs other write tools, which take their own checkpoints.
const ORCHESTRATORS = ["ae_multi_comp_apply"];

describe("tool registration", () => {
  it("lists every tool once", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers the new tools, with checkpoints on the project writes", () => {
    for (const name of [...READS, ...WRITES_WITH_CHECKPOINT, ...WRITES_WITHOUT_CHECKPOINT, ...ORCHESTRATORS]) {
      expect(ALL_TOOLS.some((t) => t.name === name), name).toBe(true);
    }
    for (const name of WRITES_WITH_CHECKPOINT) expect(AUTO_CHECKPOINT_TOOLS, name).toContain(name);
    for (const name of [...READS, ...WRITES_WITHOUT_CHECKPOINT, ...ORCHESTRATORS]) expect(AUTO_CHECKPOINT_TOOLS, name).not.toContain(name);
  });

  it("names every checkpointed tool that exists", () => {
    for (const name of AUTO_CHECKPOINT_TOOLS) expect(ALL_TOOLS.some((t) => t.name === name), name).toBe(true);
  });
});
