import { describe, expect, it } from "vitest";

// The panel's tiles, reply-time chart and Log are built from service.log lines.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const common = require("../../panel/client/common.js");

describe("panel session stats (panel/client/common.js)", () => {
  it("parses tool, checkpoint and session-start lines, and ignores the rest", () => {
    expect(common.parseToolLine("[14:02:14] [OK] tool ae_create_layer ok (120ms)")).toEqual({
      kind: "tool", time: "14:02:14", tool: "ae_create_layer", ok: true, ms: 120, error: "",
    });
    expect(common.parseToolLine("[14:02:20] [ERR] tool ae_get_comp failed (12ms): comp 99 not found")).toMatchObject({
      kind: "tool", ok: false, ms: 12, error: "comp 99 not found",
    });
    expect(common.parseToolLine("[14:02:15] [OK] Checkpoint saved before ae_set_text: Shot_20261103-140215_auto-ae_set_text.aep")).toEqual({
      kind: "checkpoint", time: "14:02:15", tool: "ae_set_text", file: "Shot_20261103-140215_auto-ae_set_text.aep",
    });
    expect(common.parseToolLine("[09:13:00] [OK] Listening on http://127.0.0.1:7790")).toEqual({ kind: "session" });
    expect(common.parseToolLine("[14:02:14] [OK] <- ae_create_layer (comp) [7] ok (84ms)")).toBeNull();
    expect(common.parseToolLine("[14:02:14] Token loaded from C:\\x")).toBeNull();
  });

  it("counts the session, resets at a new 'Listening on', and keeps the last 20 reply times", () => {
    const stats = common.createSessionStats(50);
    stats.ingest("[09:00:00] [OK] tool old_tool ok (5ms)");
    stats.ingest("[09:13:00] [OK] Listening on http://127.0.0.1:7790");
    for (let i = 1; i <= 22; i++) stats.ingest(`[10:00:00] [OK] tool ae_t${i} ok (${i * 10}ms)`);
    stats.ingest("[10:01:00] [ERR] tool ae_bad failed (999ms): boom");
    stats.ingest("[10:01:01] [OK] Checkpoint saved before ae_set_text: a.aep");

    const snap = stats.snapshot();
    expect(snap.calls).toBe(23);
    expect(snap.errors).toBe(1);
    expect(snap.checkpoints).toBe(1);
    expect(snap.recentMs).toHaveLength(20);
    expect(snap.recentMs[19]).toBe(999);
    expect(snap.slowest).toBe("ae_bad");
    expect(snap.medianMs).toBe(135); // last 20: 40..220 by tens plus 999, middle pair 130 and 140
    expect(snap.entries).toHaveLength(24);
    expect(snap.entries[0].tool).toBe("ae_t1");
  });

  it("bounds the Log entries but not the counters", () => {
    const stats = common.createSessionStats(3);
    for (let i = 0; i < 5; i++) stats.ingest(`[10:00:0${i}] [OK] tool ae_x ok (1ms)`);
    const snap = stats.snapshot();
    expect(snap.calls).toBe(5);
    expect(snap.entries).toHaveLength(3);
    expect(snap.medianMs).toBe(1);
  });
});
