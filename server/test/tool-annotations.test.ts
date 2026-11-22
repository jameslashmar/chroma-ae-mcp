import { describe, expect, it } from "vitest";
import { listTools } from "../src/mcp-rpc.js";
import { ANNOTATION_LISTS, annotationsFor } from "../src/tool-annotations.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { isWriteTool } from "../src/write-tools.js";

const names = new Set(ALL_TOOLS.map((t) => t.name));

describe("tool annotations", () => {
  it("every name in the lists is a real tool (a typo would silently mislabel one)", () => {
    for (const [list, set] of Object.entries(ANNOTATION_LISTS)) {
      for (const n of set) expect(names.has(n), `${list}: ${n}`).toBe(true);
    }
  });

  it("reads are read-only and local; writes never claim to be read-only", () => {
    for (const t of ALL_TOOLS) {
      const a = annotationsFor(t.name);
      if (isWriteTool(t.name) && !ANNOTATION_LISTS.READS_WITH_GUARD.has(t.name)) expect(a.readOnlyHint, t.name).toBeUndefined();
    }
    expect(annotationsFor("ae_get_comp")).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(annotationsFor("ae_checkpoint_list").readOnlyHint).toBe(true);
  });

  it("tools that change things without being write tools are not read-only", () => {
    // Presses a button, kills a process, uploads audio, opens a panel.
    for (const n of ["ae_dialog_respond", "ae_aerender_cancel", "ae_render_batch_cancel", "ae_transcribe", "ae_open_panel", "ae_taste_rules"]) {
      expect(annotationsFor(n).readOnlyHint, n).toBeUndefined();
    }
    expect(annotationsFor("ae_dialog_respond").destructiveHint).toBeUndefined(); // destructive (the default)
    expect(annotationsFor("ae_transcribe").openWorldHint).toBeUndefined(); // reaches ElevenLabs (the default, true)
  });

  it("additive tools say so, overwriting ones stay destructive, setters are idempotent", () => {
    expect(annotationsFor("ae_create_layer")).toEqual({ destructiveHint: false, openWorldHint: false });
    expect(annotationsFor("ae_layer_ops")).toEqual({ openWorldHint: false });
    expect(annotationsFor("ae_project_session")).toEqual({ openWorldHint: false });
    expect(annotationsFor("ae_set_property")).toEqual({ idempotentHint: true, openWorldHint: false });
  });

  it("every tools/list entry carries annotations, full and core", () => {
    for (const toolset of ["full", "core"] as const) {
      for (const e of listTools(toolset)) expect(e.annotations, `${toolset}: ${e.name}`).toBeDefined();
    }
    const core = listTools("core");
    expect(core.find((e) => e.name === "ae_search_tools")?.annotations?.readOnlyHint).toBe(true);
    expect(core.find((e) => e.name === "ae_invoke_tool")?.annotations?.readOnlyHint).toBeUndefined();
  });
});
