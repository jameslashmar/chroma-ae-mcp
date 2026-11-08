import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const report = require("../../panel/tools/usage-report.cjs") as {
  summarize: (entries: any[], opts?: any) => any;
  render: (summary: any) => string;
  parseLines: (text: string) => { entries: any[]; skipped: number };
  normalizeLabel: (label: string) => string;
  readDir: (dir: string) => { entries: any[]; skipped: number; missing: boolean };
};

const NOW = new Date(2026, 10, 7, 12, 0, 0);

function entry(day: string, tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: `${day}T10:00:00.000Z`, day, tool, ms: 100, ok: true, ...extra };
}

describe("usage report summarize", () => {
  it("counts calls per day and keeps only the period", () => {
    const s = report.summarize(
      [entry("2026-11-07", "tool_a"), entry("2026-11-07", "tool_b"), entry("2026-11-05", "tool_a"), entry("2026-10-01", "tool_a")],
      { days: 7, now: NOW }
    );
    expect(s.total).toBe(3);
    expect(s.perDay).toEqual([["2026-11-05", 1], ["2026-11-07", 2]]);
    expect(s.from).toBe("2026-11-01");
    expect(s.topTools[0]).toMatchObject({ tool: "tool_a", calls: 2 });
  });

  it("reports failures with rate and kinds, and busy refusals", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "tool_a"),
        entry("2026-11-07", "tool_a", { ok: false, error_kind: "queued", error: "busy" }),
        entry("2026-11-07", "tool_a", { ok: false, error_kind: "queued", error: "busy" }),
        entry("2026-11-07", "tool_a", { ok: false, error_kind: "timeout", error: "slow" }),
        entry("2026-11-07", "tool_b", { ok: false, error_kind: "invalid_args", error: "bad" }),
      ],
      { now: NOW }
    );
    expect(s.failed).toBe(4);
    expect(s.failing[0]).toMatchObject({ tool: "tool_a", fails: 3, calls: 4 });
    expect(s.failing[0].failRate).toBeCloseTo(0.75);
    expect(s.failing[0].kinds[0]).toEqual(["queued", 2]);
    expect(s.busy.total).toBe(2);
    expect(s.busy.byTool).toEqual([["tool_a", 2]]);
  });

  it("gives median and p95 only for tools with 5 or more calls", () => {
    const rows: any[] = [];
    for (let i = 1; i <= 20; i++) rows.push(entry("2026-11-07", "slow_tool", { ms: i * 10 }));
    for (let i = 0; i < 4; i++) rows.push(entry("2026-11-07", "rare_tool", { ms: 9999 }));
    const s = report.summarize(rows, { now: NOW });
    expect(s.slowest).toHaveLength(1);
    expect(s.slowest[0]).toMatchObject({ tool: "slow_tool", medianMs: 100, p95Ms: 190 });
  });

  it("subtracts waited_ms from the time of a call, so waiting is not slowness", () => {
    const rows: any[] = [];
    for (let i = 0; i < 5; i++) rows.push(entry("2026-11-07", "waiter", { ms: 20_000 + i, waited_ms: 19_900 }));
    for (let i = 0; i < 5; i++) rows.push(entry("2026-11-07", "plain", { ms: 500 }));
    const s = report.summarize(rows, { now: NOW });
    expect(s.slowest[0]).toMatchObject({ tool: "plain", medianMs: 500 });
    expect(s.slowest[1]).toMatchObject({ tool: "waiter", medianMs: 102 });
    expect(report.render(s)).toMatch(/ms - waited_ms/);
  });

  it("lists the largest results by tool: median and max, only tools with 3 or more sized calls", () => {
    const rows: any[] = [];
    for (const n of [1000, 3000, 2000]) rows.push(entry("2026-11-07", "big_tool", { result_chars: n }));
    for (const n of [10, 20, 30, 40]) rows.push(entry("2026-11-07", "small_tool", { result_chars: n }));
    for (const n of [99999, 99999]) rows.push(entry("2026-11-07", "rare_tool", { result_chars: n }));
    rows.push(entry("2026-11-07", "old_tool"), entry("2026-11-07", "old_tool"), entry("2026-11-07", "old_tool"));
    const s = report.summarize(rows, { now: NOW });
    expect(s.largest.map((r: any) => r.tool)).toEqual(["big_tool", "small_tool"]);
    expect(s.largest[0]).toMatchObject({ medianChars: 2000, maxChars: 3000, sized: 3 });
    expect(s.largest[1]).toMatchObject({ medianChars: 20, maxChars: 40, sized: 4 });
    const text = report.render(s);
    expect(text).toContain("## Largest results by tool");
    expect(text).toContain("- big_tool: median 2000 chars, max 3000 chars (3 calls)");
    expect(text).not.toContain("rare_tool: median");
  });

  it("groups ae_run_jsx labels after lower-casing and stripping digits and quotes", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "ae_run_jsx", { label: "Set opacity 50 on 'Title'", mutates: true, code_chars: 100 }),
        entry("2026-11-07", "ae_run_jsx", { label: 'set opacity 75 on "title"', mutates: true, code_chars: 300 }),
        entry("2026-11-06", "ae_run_jsx", { label: "List layers", mutates: false, code_chars: 50 }),
        entry("2026-11-06", "ae_run_jsx", { mutates: false, code_chars: 10 }),
      ],
      { now: NOW }
    );
    expect(s.runJsx).toMatchObject({ count: 4, reads: 2, writes: 2, avgCodeChars: 115 });
    expect(s.runJsx.labels[0]).toEqual(["set opacity on title", 2]);
    expect(s.runJsx.labels.map((l: any) => l[0])).toContain("(no label)");
  });

  it("lists ae_search_tools queries that found nothing", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "ae_search_tools", { query: "Wobble Thing", hits: 0 }),
        entry("2026-11-07", "ae_search_tools", { query: "wobble thing", hits: 0 }),
        entry("2026-11-07", "ae_search_tools", { query: "layers", hits: 5 }),
      ],
      { now: NOW }
    );
    expect(s.emptySearches).toEqual([["wobble thing", 2]]);
  });

  it("lists searches with a weak best hit as well as searches with no hits", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "ae_search_tools", { query: "make coffee", hits: 11, top: "ae_layout_apply", top_score: 3.21 }),
        entry("2026-11-07", "ae_search_tools", { query: "Make Coffee", hits: 11, top: "ae_layout_apply", top_score: 3.21 }),
        entry("2026-11-07", "ae_search_tools", { query: "track a point", hits: 66, top: "ae_track_point", top_score: 9.42 }),
        entry("2026-11-07", "ae_search_tools", { group: "tracking", hits: 6 }),
        entry("2026-11-07", "ae_search_tools", { query: "zzzz", hits: 0 }),
      ],
      { now: NOW }
    );
    expect(s.emptySearches).toEqual([["zzzz", 1]]);
    expect(s.weakSearches).toEqual([["make coffee (best: ae_layout_apply, score 3.21)", 2]]);
    const text = report.render(s);
    expect(text).toContain("only a weak match");
    expect(text).toContain("- 2 x make coffee (best: ae_layout_apply, score 3.21)");
  });

  it("counts a result with ok: false as a failure and says so", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "tool_a"),
        entry("2026-11-07", "tool_a", { result_ok: false, result_kind: "refused", result_error: "no" }),
        entry("2026-11-07", "tool_a", { result_ok: false }),
        entry("2026-11-07", "tool_b", { ok: false, error_kind: "error", error: "x" }),
      ],
      { now: NOW }
    );
    expect(s.total).toBe(4);
    expect(s.failed).toBe(3);
    expect(s.resultFailed).toBe(2);
    expect(s.failing[0]).toMatchObject({ tool: "tool_a", fails: 2, calls: 3, resultFails: 2 });
    expect(s.failing[0].kinds).toEqual([["result:refused", 1], ["result:unspecified", 1]]);
    const text = report.render(s);
    expect(text).toContain("Failed includes 2 call(s) that returned ok: false without an MCP error.");
    expect(text).toContain("result:refused 1");
  });

  it("starts with a line saying the report holds the user's own wording", () => {
    const text = report.render(report.summarize([entry("2026-11-07", "tool_a")], { now: NOW }));
    expect(text.split("\n")[0]).toMatch(/not for pasting publicly/);
  });

  it("counts calls per client, with entries that have no client under (unknown)", () => {
    const s = report.summarize(
      [
        entry("2026-11-07", "tool_a", { client: "claude-ai" }),
        entry("2026-11-07", "tool_b", { client: "claude-ai" }),
        entry("2026-11-07", "tool_a", { client: "cursor" }),
        entry("2026-11-07", "tool_a"),
        entry("2026-10-01", "tool_a", { client: "old" }),
      ],
      { now: NOW }
    );
    expect(s.perClient).toEqual([["claude-ai", 2], ["(unknown)", 1], ["cursor", 1]]);
    const text = report.render(s);
    expect(text).toContain("## Calls per client");
    expect(text).toContain("- claude-ai: 2");
    expect(text).toContain("- (unknown): 1");
  });

  it("counts unreadable lines and never crashes on them", () => {
    const parsed = report.parseLines('{"tool":"tool_a","day":"2026-11-07","ok":true,"ms":1}\nnot json\n[1,2]\n{"no_tool":1}\n\n');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped).toBe(3);
    const s = report.summarize([...parsed.entries, null, 7, { tool: 5 }], { now: NOW, skipped: parsed.skipped });
    expect(s.unreadable).toBe(6);
    expect(() => report.render(s)).not.toThrow();
  });

  it("renders plain text within about 150 lines and handles an empty period", () => {
    const rows: any[] = [];
    for (let i = 0; i < 200; i++) rows.push(entry("2026-11-07", "tool_" + (i % 60), { ok: i % 3 !== 0, error_kind: "error", ms: i }));
    for (let i = 0; i < 80; i++) rows.push(entry("2026-11-07", "ae_run_jsx", { label: "job " + String.fromCharCode(97 + (i % 26)) + i }));
    const text = report.render(report.summarize(rows, { now: NOW }));
    expect(text.split("\n").length).toBeLessThanOrEqual(160);
    expect(report.render(report.summarize([], { now: NOW }))).toContain("No calls in this period.");
  });

  it("reads a directory of monthly files and reports a missing one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-report-"));
    try {
      fs.writeFileSync(path.join(dir, "usage-2026-11.jsonl"), '{"tool":"tool_a","day":"2026-11-07","ok":true,"ms":1}\nbroken\n');
      fs.writeFileSync(path.join(dir, "other.txt"), "ignored");
      const read = report.readDir(dir);
      expect(read.entries).toHaveLength(1);
      expect(read.skipped).toBe(1);
      expect(report.readDir(path.join(dir, "missing")).missing).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
