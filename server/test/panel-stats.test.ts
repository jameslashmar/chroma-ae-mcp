import { describe, expect, it } from "vitest";

// The panel's tiles, reply-time chart and Log are built from service.log lines.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const common = require("../../panel/client/common.js");

describe("panel session stats (panel/client/common.js)", () => {
  it("parses tool, checkpoint, session-start and service lines", () => {
    expect(common.parseToolLine("[14:02:14] [OK] tool ae_create_layer ok (120ms)")).toEqual({
      kind: "tool", time: "14:02:14", tool: "ae_create_layer", ok: true, ms: 120, error: "",
    });
    expect(common.parseToolLine("[14:02:20] [ERR] tool ae_get_comp failed (12ms): comp 99 not found")).toMatchObject({
      kind: "tool", ok: false, ms: 12, error: "comp 99 not found",
    });
    expect(common.parseToolLine("[14:02:15] [OK] Checkpoint saved before ae_set_text: Shot_20261103-140215_auto-ae_set_text.aep")).toEqual({
      kind: "checkpoint", time: "14:02:15", tool: "ae_set_text", file: "Shot_20261103-140215_auto-ae_set_text.aep",
    });
    expect(common.parseToolLine("[09:13:00] [OK] Listening on http://127.0.0.1:7790")).toEqual({
      kind: "session", time: "09:13:00", level: "ok", title: "Server started", detail: "port 7790",
    });
    expect(common.parseToolLine("[09:12:58] [OK] Loaded MCP bundle (mcp-bundle.cjs)")).toEqual({
      kind: "event", time: "09:12:58", level: "ok", title: "MCP tools loaded", detail: "mcp-bundle.cjs",
    });
    expect(common.parseToolLine("[09:12:59] [OK] Loaded host/core.jsx (__chromaAe ready)")).toMatchObject({
      kind: "event", title: "After Effects scripting ready",
    });
    expect(common.parseToolLine("[09:14:00] [WARN] Rejected unauthorized request to /mcp")).toMatchObject({
      kind: "event", level: "warn", title: "Rejected unauthorized request to /mcp",
    });
    // One row per tool call already; the per-evalScript lines stay in the raw log.
    expect(common.parseToolLine("[14:02:14] [OK] <- ae_create_layer (comp) [7] ok (84ms)")).toBeNull();
    // No level tag: not a service line.
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
    expect(snap.entries).toHaveLength(25); // "Server started" + 23 calls + 1 checkpoint
    expect(snap.entries[0].title).toBe("Server started");
    expect(snap.entries[1].tool).toBe("ae_t1");
  });

  it("keeps a session's start-up lines and drops the previous session's", () => {
    const stats = common.createSessionStats(50);
    stats.ingest("[08:00:00] [OK] Token loaded from C:\\old\\token");
    stats.ingest("[08:00:01] [OK] Listening on http://127.0.0.1:7790");
    stats.ingest("[08:30:00] [WARN] Rejected unauthorized request to /mcp");
    stats.ingest("[09:12:57] [OK] Token loaded from C:\\x\\token");
    stats.ingest("[09:12:58] [OK] Loaded MCP bundle (mcp-bundle.cjs)");
    stats.ingest("[09:12:59] [OK] Loaded host/core.jsx (__chromaAe ready)");
    stats.ingest("[09:13:00] [OK] Listening on http://127.0.0.1:7790");
    const titles = stats.snapshot().entries.map((e: { title: string }) => e.title);
    expect(titles).toEqual(["Token loaded", "MCP tools loaded", "After Effects scripting ready", "Server started"]);
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

describe("panel updates (panel/client/common.js)", () => {
  const release = {
    tag_name: "v0.4.1",
    html_url: "https://github.com/jameslashmar/chroma-ae-mcp/releases/tag/v0.4.1",
    body: "Signed ZXP.\n\nSHA256 `" + "ab".repeat(32) + "`",
    assets: [
      { name: "notes.txt", browser_download_url: "https://example.invalid/notes.txt" },
      { name: "chroma-ae-mcp-0.4.1.zxp", browser_download_url: "https://example.invalid/a.zxp", size: 1234 },
    ],
  };

  it("compares x.y.z versions", () => {
    expect(common.compareVersions("0.4.1", "0.4.0")).toBe(1);
    expect(common.compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(common.compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(common.compareVersions("0.3.9", "0.4.0")).toBe(-1);
    expect(common.compareVersions("0.5.0", "unknown")).toBe(0);
  });

  it("picks the .zxp and its SHA256 from the latest release", () => {
    expect(common.parseLatestRelease(release)).toEqual({
      version: "0.4.1",
      notesUrl: release.html_url,
      fileName: "chroma-ae-mcp-0.4.1.zxp",
      url: "https://example.invalid/a.zxp",
      size: 1234,
      sha256: "ab".repeat(32),
    });
  });

  it("prefers the asset digest over the notes", () => {
    const withDigest = { ...release, assets: [{ ...release.assets[1], digest: "sha256:" + "cd".repeat(32) }] };
    expect(common.parseLatestRelease(withDigest).sha256).toBe("cd".repeat(32));
  });

  it("returns null for a release with no .zxp, a prerelease, or a bad tag", () => {
    expect(common.parseLatestRelease({ ...release, assets: [release.assets[0]] })).toBeNull();
    expect(common.parseLatestRelease({ ...release, prerelease: true })).toBeNull();
    expect(common.parseLatestRelease({ ...release, tag_name: "nightly" })).toBeNull();
    expect(common.parseLatestRelease(null)).toBeNull();
  });
});
