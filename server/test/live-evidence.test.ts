import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { decide, namesTool, problemsWith, SCHEMA, toolNamesIn } from "../../scripts/check-live-evidence.mjs";

const SHA = "a".repeat(40);
const good = () => ({
  schema: SCHEMA,
  sourceCommit: SHA,
  ae: { version: "26.3", extLoadFailures: [] },
  smoke: { total: 3, passed: 2, fatal: null, checked: ["ae_ping", "ae_new_tool (write)", "ae_render"], failed: [{ tool: "ae_render", note: "aerender idle" }], skipped: [] },
  manual: [],
  explainedFailures: { ae_render: "known aerender start hang, docs/HANDOVER.md" },
});
const facts = { isAncestor: true, changedSince: ["qa/evidence/aaaaaaaaaaaa.json", "README.md"] };

describe("live evidence check", () => {
  it("needs nothing when no After Effects code changed", () => {
    const r = decide(["README.md", ".github/workflows/ci.yml", "server/test/x.test.ts"], [], new Set());
    expect(r).toMatchObject({ ok: true, needed: false });
  });

  it("refuses AE code changes with no report", () => {
    const r = decide(["panel/host/core.jsx"], [], new Set());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/qa\/live-evidence\.mjs/);
  });

  it("treats server source, panel tools, client scripts and the manifest as AE code", () => {
    for (const f of ["server/src/tools/x.ts", "panel/tools/stdio-relay.cjs", "panel/client/panel.js", "panel/client/index.html", "panel/CSXS/manifest.xml"]) {
      expect(decide([f], [], new Set()).needed).toBe(true);
    }
    expect(decide(["panel/client/style.css"], [], new Set()).needed).toBe(false);
  });

  it("accepts a good report with every failure explained", () => {
    const r = decide(["server/src/a.ts"], [{ path: "qa/evidence/a.json", report: good(), facts }], new Set(["ae_new_tool"]));
    expect(r).toMatchObject({ ok: true, used: "qa/evidence/a.json" });
  });

  it("refuses code changed after the tested commit", () => {
    const p = problemsWith(good(), { isAncestor: true, changedSince: ["server/src/a.ts"] }, new Set());
    expect(p.join(" ")).toMatch(/changed after the tested commit/);
  });

  it("refuses a commit outside the PR's history", () => {
    expect(problemsWith(good(), { isAncestor: false }, new Set()).join(" ")).toMatch(/not in this PR's history/);
  });

  it("refuses unexplained failures, a fatal stop and a missing AE version", () => {
    const rep = good();
    rep.explainedFailures = {};
    rep.smoke.fatal = "guard refused";
    rep.ae.version = "";
    const p = problemsWith(rep, facts, new Set()).join(" | ");
    expect(p).toMatch(/without an explanation/);
    expect(p).toMatch(/stopped early/);
    expect(p).toMatch(/ae\.version/);
  });

  it("refuses a new tool nothing checked, and accepts a manual check naming it", () => {
    expect(problemsWith(good(), facts, new Set(["ae_other"])).join(" ")).toMatch(/ae_other/);
    const rep = good();
    rep.manual = [{ tool: "ae_other", check: "queued in Media Encoder", result: "pass" }];
    expect(problemsWith(rep, facts, new Set(["ae_other"]))).toEqual([]);
  });

  it("needs notes on a failed manual check", () => {
    const rep = good();
    rep.manual = [{ check: "dialog answered", result: "fail" }];
    expect(problemsWith(rep, facts, new Set()).join(" ")).toMatch(/failed without notes/);
  });

  it("matches tool names exactly, not by prefix", () => {
    expect(namesTool("ae_render (5 frames)", "ae_render")).toBe(true);
    expect(namesTool("ae_render_batch", "ae_render")).toBe(false);
    expect([...toolNamesIn('x name: "ae_a_b", y name: "ae_c" name: "other"')]).toEqual(["ae_a_b", "ae_c"]);
  });
});
