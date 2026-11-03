import { describe, expect, it } from "vitest";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

// Tool groups are built in their own files and registered by hand in
// tools/ext/index.ts: this catches one that was left out, or a write tool
// missing from the automatic checkpoints.
const READS = ["ae_annotate_frame", "ae_get_comp_settings", "ae_preflight", "ae_session_changes"];
const WRITES_WITH_CHECKPOINT = ["ae_layer_ops", "ae_comp_settings"];
// Runs other write tools, which take their own checkpoints.
const ORCHESTRATORS = ["ae_multi_comp_apply"];

describe("tool registration", () => {
  it("lists every tool once", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers the wave 1 tools, with checkpoints on the writes", () => {
    for (const name of [...READS, ...WRITES_WITH_CHECKPOINT, ...ORCHESTRATORS]) {
      expect(ALL_TOOLS.some((t) => t.name === name), name).toBe(true);
    }
    for (const name of WRITES_WITH_CHECKPOINT) expect(AUTO_CHECKPOINT_TOOLS, name).toContain(name);
    for (const name of [...READS, ...ORCHESTRATORS]) expect(AUTO_CHECKPOINT_TOOLS, name).not.toContain(name);
  });

  it("names every checkpointed tool that exists", () => {
    for (const name of AUTO_CHECKPOINT_TOOLS) expect(ALL_TOOLS.some((t) => t.name === name), name).toBe(true);
  });
});
