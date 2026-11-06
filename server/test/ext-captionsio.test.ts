import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { inferFrameRate } from "../src/caption-qa.js";
import type { CaptionsRead, ReadCaption } from "../src/tools/ext/captions.js";
import { AeCaptionsExportSchema, AeCaptionsQaSchema, captionsioTools, cuesFromRead } from "../src/tools/ext/captionsio.js";

const tmpDirs: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-captionsio-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => captionsioTools.find((t) => t.name === name)!;

const SRT = `1
00:00:01,000 --> 00:00:03,000
Welcome to the show everyone

2
00:00:03,500 --> 00:00:05,000
Today we talk captions
`;

const rc = (n: number, text: string, inP: number, outP: number, extra: Partial<ReadCaption> = {}): ReadCaption => ({
  number: n,
  name: `Caption ${String(n).padStart(3, "0")}`,
  id: 100 + n,
  index: n,
  kind: "text",
  inPoint: inP,
  outPoint: outP,
  text,
  justification: "center",
  ...extra,
});

const readOf = (captions: ReadCaption[], extra: Partial<CaptionsRead> = {}): CaptionsRead => ({
  comp_id: 1,
  width: 1080,
  height: 1920,
  frameDuration: 0.04,
  safe: { left: 64, right: 64, top: 230, bottom: 384, width: 952 },
  mode: "layers",
  captions,
  boxes: [],
  total_captions: captions.length,
  total_boxes: 0,
  truncated: false,
  ...extra,
});

/** A bridge that answers status and captionsRead only; anything else throws. */
function fakeAe(results: { status?: unknown; captionsRead?: unknown }) {
  const calls: string[] = [];
  const dir = mkTmp();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "status" && results.status !== undefined) return { ok: true, result: results.status, durationMs: 1 };
      if (fn === "captionsRead" && results.captionsRead !== undefined) return { ok: true, result: results.captionsRead, durationMs: 1 };
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const noAe = {} as ToolContext;
const run = (name: string, schema: { parse: (x: unknown) => unknown }, input: unknown, ctx: ToolContext = noAe) =>
  tool(name).handler(schema.parse(input) as never, ctx) as Promise<Record<string, any>>;
const exportTool = (input: unknown, ctx?: ToolContext) => run("ae_captions_export", AeCaptionsExportSchema, input, ctx);
const qaTool = (input: unknown, ctx?: ToolContext) => run("ae_captions_qa", AeCaptionsQaSchema, input, ctx);

describe("schemas", () => {
  it("export needs exactly one of transcript and from_layers, and a format", () => {
    expect(AeCaptionsExportSchema.safeParse({ format: "srt", transcript: { text: SRT } }).success).toBe(true);
    expect(AeCaptionsExportSchema.safeParse({ format: "srt", from_layers: { comp_id: 1 } }).success).toBe(true);
    expect(AeCaptionsExportSchema.safeParse({ format: "srt" }).success).toBe(false);
    expect(AeCaptionsExportSchema.safeParse({ format: "srt", transcript: { text: SRT }, from_layers: { comp_id: 1 } }).success).toBe(false);
    expect(AeCaptionsExportSchema.safeParse({ transcript: { text: SRT } }).success).toBe(false);
  });
  it("qa needs exactly one source", () => {
    expect(AeCaptionsQaSchema.safeParse({ text: SRT }).success).toBe(true);
    expect(AeCaptionsQaSchema.safeParse({}).success).toBe(false);
    expect(AeCaptionsQaSchema.safeParse({ text: SRT, file: { path: "C:/x.srt" } }).success).toBe(false);
  });
});

describe("cuesFromRead", () => {
  it("takes line, alignment and the safe-area flags from the layers", () => {
    const { cues } = cuesFromRead(
      readOf([
        rc(1, "Hello\rthere", 1, 3, { rect: { left: 0, top: -40, width: 300, height: 90 }, position: [540, 1500], justification: "left" }),
        rc(2, "Wide", 4, 5, { outside_safe: true }),
      ])
    );
    expect(cues[0].lines).toEqual(["Hello", "there"]);
    expect(cues[0].position).toEqual({ line_pct: 76.04, align: "start" });
    expect(cues[1]).toMatchObject({ n: 2, outside_safe: true, position: { align: "center" } });
  });
  it("reads single mode from the hold keys", () => {
    const { cues } = cuesFromRead(
      readOf([rc(1, "A", 0, 10, { keys: [{ time: 1, text: "A\rB" }, { time: 2, text: "" }, { time: 3, text: "C" }] })], { mode: "single" })
    );
    expect(cues.map((c) => [c.start, c.end, c.lines])).toEqual([[1, 2, ["A", "B"]], [3, 10, ["C"]]]);
  });
});

describe("ae_captions_export", () => {
  it("writes a plan to an explicit path and verifies it", async () => {
    const dir = mkTmp();
    const p = path.join(dir, "out.srt");
    const r = await exportTool({ format: "srt", transcript: { text: SRT }, path: p, frame_rate: 25 });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ path: p, format: "srt", source: "transcript", cues: 2 });
    expect(r.bytes).toBe(fs.statSync(p).size);
    const body = fs.readFileSync(p, "utf8");
    expect(body.startsWith("1\r\n00:00:01,000 --> ")).toBe(true);
    expect(body).toContain("\r\n\r\n2\r\n");
    expect(r.preview.split("\n")).toHaveLength(2);
  });

  it("writes vtt and ttml with their extensions", async () => {
    const dir = mkTmp();
    const v = await exportTool({ format: "vtt", transcript: { text: SRT }, path: path.join(dir, "a.vtt"), position: { line_pct: 85 } });
    expect(v.ok).toBe(true);
    expect(fs.readFileSync(v.path, "utf8")).toMatch(/^WEBVTT\n\n00:00:01.000 --> 00:00:03.250 line:85% position:50% align:center/);
    const t = await exportTool({ format: "ttml", transcript: { text: SRT }, path: path.join(dir, "a.xml") });
    expect(t.ok).toBe(true);
    expect(fs.readFileSync(t.path, "utf8")).toContain("<tt ");
    expect(t.cues).toBe(2);
  });

  it("refuses an explicit path that exists without overwrite, and replaces it with overwrite", async () => {
    const dir = mkTmp();
    const p = path.join(dir, "x.srt");
    fs.writeFileSync(p, "keep me");
    const refused = await exportTool({ format: "srt", transcript: { text: SRT }, path: p });
    expect(refused).toMatchObject({ ok: false, error: "exists" });
    expect(fs.readFileSync(p, "utf8")).toBe("keep me");
    const done = await exportTool({ format: "srt", transcript: { text: SRT }, path: p, overwrite: true });
    expect(done.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).not.toBe("keep me");
  });

  it("refuses a relative path or a wrong extension before anything is read or written", async () => {
    const dir = mkTmp();
    expect(await exportTool({ format: "srt", transcript: { text: SRT }, path: "out.srt" })).toMatchObject({ ok: false, error: "bad_path" });
    expect(await exportTool({ format: "vtt", transcript: { text: SRT }, path: path.join(dir, "a.srt") })).toMatchObject({ ok: false, error: "bad_path" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports a bad transcript and writes nothing", async () => {
    const dir = mkTmp();
    const r = await exportTool({ format: "srt", transcript: { text: "not a transcript" }, path: path.join(dir, "a.srt") });
    expect(r).toMatchObject({ ok: false, error: "bad_transcript" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("from_layers: default path next to the project, numbered when taken", async () => {
    const dir = mkTmp();
    const project = path.join(dir, "Spot.aep");
    const layers = readOf([rc(1, "Hello\rthere", 1, 3), rc(2, "Second", 4, 5)]);
    const status = { aeVersion: "25", project_path: project, active_comp: { id: 1, name: "Main: v2" } };
    const a = fakeAe({ status, captionsRead: layers });
    const first = await exportTool({ format: "srt", from_layers: { comp_id: 1 } }, a.ctx);
    expect(first.ok).toBe(true);
    expect(first.source).toBe("layers");
    expect(first.path).toBe(path.join(dir, "Spot chroma captions", "Main_ v2.srt"));
    expect(a.calls).toEqual(["captionsRead", "status"]);
    const b = fakeAe({ status, captionsRead: layers });
    const second = await exportTool({ format: "srt", from_layers: { comp_id: 1 } }, b.ctx);
    expect(second.path).toBe(path.join(dir, "Spot chroma captions", "Main_ v2 2.srt"));
    const c = fakeAe({ status, captionsRead: layers });
    const third = await exportTool({ format: "srt", from_layers: { comp_id: 1 } }, c.ctx);
    expect(third.path).toMatch(/Main_ v2 3\.srt$/);
    expect(fs.readFileSync(first.path, "utf8")).toContain("Hello\r\nthere");
  });

  it("from_layers: says truncated, and nothing is written for an unsaved project", async () => {
    const dir = mkTmp();
    const many = readOf([rc(1, "One", 0, 1)], { truncated: true, total_captions: 900 });
    const ok = await exportTool({ format: "vtt", from_layers: { comp_id: 1 }, path: path.join(dir, "a.vtt") }, fakeAe({ captionsRead: many }).ctx);
    expect(ok.truncated).toBe(true);
    expect(ok.warnings.join(" ")).toContain("900");
    const unsaved = await exportTool(
      { format: "srt", from_layers: { comp_id: 1 } },
      fakeAe({ status: { project_path: "<unsaved>", active_comp: null }, captionsRead: readOf([rc(1, "One", 0, 1)]) }).ctx
    );
    expect(unsaved).toMatchObject({ ok: false, error: "unsaved_project" });
  });

  it("a plan source with no path asks After Effects for the project and names the file captions", async () => {
    const dir = mkTmp();
    const { ctx } = fakeAe({ status: { project_path: path.join(dir, "P.aep"), active_comp: null } });
    const r = await exportTool({ format: "srt", transcript: { text: SRT } }, ctx);
    expect(r.path).toBe(path.join(dir, "P chroma captions", "captions.srt"));
  });

  it("fails cleanly with no path and no After Effects", async () => {
    const r = await exportTool({ format: "srt", transcript: { text: SRT } }, noAe);
    expect(r.ok).toBe(false);
  });

  it("from_layers with no layers writes nothing", async () => {
    const dir = mkTmp();
    const r = await exportTool({ format: "srt", from_layers: { comp_id: 1 }, path: path.join(dir, "a.srt") }, fakeAe({ captionsRead: readOf([]) }).ctx);
    expect(r).toMatchObject({ ok: false, error: "no_captions" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("ae_captions_qa", () => {
  const BAD = `1
00:00:01,000 --> 00:00:01,500
This is far too much text for half a second of screen time

2
00:00:01,520 --> 00:00:04,000
Fine.
`;

  it("lints text and reports counts and issues", async () => {
    const r = await qaTool({ text: BAD });
    expect(r.ok).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.cues).toBe(2);
    expect(r.counts.cps).toBe(1);
    expect(r.counts.min_duration).toBe(1);
    expect(r.counts.gap).toBe(1);
    // Every time sits on a 50 fps frame, so that is the rate inferred (and 1 frame is under the 2 a gap needs).
    expect(r.frame_rate).toBe(50);
    expect(r.frame_rate_inferred).toBe(true);
    expect(r.warnings.join(" ")).toContain("50 fps");
    expect(r.issues[0]).toMatchObject({ n: 1, severity: "error" });
  });

  it("infers the frame rate from the cue times: a 2-frame gap at 30 fps is not an error", async () => {
    const t30 = `1
00:00:01,000 --> 00:00:02,000
First caption here.

2
00:00:02,067 --> 00:00:03,000
Second caption here.

3
00:00:03,067 --> 00:00:04,967
Third caption here.
`;
    const r = await qaTool({ text: t30 });
    expect(r.frame_rate).toBe(30);
    expect(r.frame_rate_inferred).toBe(true);
    expect(r.counts.gap).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("inferred 30 fps");
    // An explicit rate wins and is not called inferred.
    const given = await qaTool({ text: t30, frame_rate: 24 });
    expect(given.frame_rate).toBe(24);
    expect(given.frame_rate_inferred).toBeUndefined();
    expect(given.counts.gap).toBe(2);
  });

  it("falls back to 24 fps with a half-frame tolerance when no rate fits, and says so", async () => {
    const odd = `1
00:00:01,013 --> 00:00:02,000
First caption here.

2
00:00:02,067 --> 00:00:04,001
Second caption here.
`;
    const r = await qaTool({ text: odd });
    expect(r.frame_rate).toBe(24);
    expect(r.frame_rate_inferred).toBe(false);
    expect(r.counts.gap).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("half-frame tolerance");
  });

  it("inferFrameRate prefers the lowest rate every time sits on", () => {
    expect(inferFrameRate([1, 2, 3])).toBe(24);
    expect(inferFrameRate([0.04, 1.2])).toBe(25);
    expect(inferFrameRate([1.001, 2.002])).toBe(23.976);
    expect(inferFrameRate([1201 / 60, 0.5])).toBe(60);
    expect(inferFrameRate([0.123, 0.456])).toBeNull();
    expect(inferFrameRate([])).toBeNull();
  });

  it("lints a file, and refuses relative, wrong-type, missing and oversized ones", async () => {
    const dir = mkTmp();
    const p = path.join(dir, "a.vtt");
    fs.writeFileSync(p, "WEBVTT\n\n00:01.000 --> 00:03.000\nA perfectly fine caption.\n");
    const r = await qaTool({ file: { path: p }, frame_rate: 25 });
    expect(r).toMatchObject({ ok: true, pass: true, cues: 1, frame_rate: 25 });
    expect(await qaTool({ file: { path: "a.srt" } })).toMatchObject({ error: "bad_path" });
    expect(await qaTool({ file: { path: path.join(dir, "a.txt") } })).toMatchObject({ error: "bad_path" });
    expect(await qaTool({ file: { path: path.join(dir, "nope.srt") } })).toMatchObject({ error: "not_found" });
    const big = path.join(dir, "big.srt");
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 32));
    expect(await qaTool({ file: { path: big } })).toMatchObject({ error: "too_big" });
  });

  it("lints a plan with a standard and cut times", async () => {
    const r = await qaTool({ transcript: { text: SRT }, standard: "social_9x16", cut_times: [2] });
    expect(r.source).toBe("transcript");
    expect(r.standard).toBe("social_9x16");
    // The planner snaps captions to the cut, so the plan it lints has nothing straddling it.
    expect(r.counts.shot_change ?? 0).toBe(0);
  });

  it("lints layers with the comp's frame rate and the safe area", async () => {
    const layers = readOf([rc(1, "Fine caption.", 1, 3, { outside_safe: true }), rc(2, "Next one.", 3.04, 5)], { frameDuration: 1 / 30 });
    const r = await qaTool({ from_layers: { comp_id: 1 }, standard: "netflix_adult" }, fakeAe({ captionsRead: layers }).ctx);
    expect(r.frame_rate).toBe(30);
    expect(r.counts.safe_zone).toBe(1);
    expect(r.counts.gap).toBe(1);
    expect(r.pass).toBe(false);
  });

  it("reports a bad transcript", async () => {
    expect(await qaTool({ transcript: { text: "nope" } })).toMatchObject({ ok: false, error: "bad_transcript" });
  });
});
