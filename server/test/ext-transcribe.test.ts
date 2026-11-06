import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseTranscript } from "../src/transcript.js";
import { createElevenLabsEngine, createKeyResolver, lookupElevenLabsKey, TranscribeError } from "../src/transcribe.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeTranscribeSchema, createTranscribeTools } from "../src/tools/ext/transcribe.js";

const KEY = "FAKE-elevenlabs-key-for-tests-0001";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const SCRIBE = {
  language_code: "eng",
  language_probability: 0.98,
  text: "Hello there. Hi!",
  words: [
    { text: "Hello", start: 0.1, end: 0.5, type: "word", speaker_id: "speaker_0" },
    { text: " ", start: 0.5, end: 0.6, type: "spacing", speaker_id: "speaker_0" },
    { text: "there.", start: 0.6, end: 1.0, type: "word", speaker_id: "speaker_0" },
    { text: "(laughter)", start: 1.0, end: 1.4, type: "audio_event", speaker_id: "speaker_1" },
    { text: "Hi!", start: 1.5, end: 1.9, type: "word", speaker_id: "speaker_1" },
  ],
};

interface Seen {
  options: Record<string, any>;
  body: Buffer;
}

/** A stand-in for https.request: records what is sent, answers with the given status and body. */
function fakeRequest(status: number, responseBody: string, seen: Seen[] = []): any {
  return (options: any, cb: (res: any) => void) => {
    const chunks: Buffer[] = [];
    const req: any = new Writable({
      write(chunk, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
      final(done) {
        seen.push({ options, body: Buffer.concat(chunks) });
        const res: any = new PassThrough();
        res.statusCode = status;
        cb(res);
        res.end(responseBody);
        done();
      },
    });
    req.setTimeout = () => req;
    return req;
  };
}

const writeAudio = (dir: string, name = "talk.wav", bytes = "RIFFfakeaudiobytes") => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};

const engineWith = (status: number, body: string, seen: Seen[] = []) =>
  createElevenLabsEngine({ getKey: async () => KEY, request: fakeRequest(status, body, seen) });

const noProject: ToolContext = { bridge: { callHost: async () => { throw new Error("no AE"); } } } as unknown as ToolContext;
const withProject = (info: Record<string, unknown>, status?: Record<string, unknown>): ToolContext =>
  ({
    bridge: {
      callHost: async (fn: string) => {
        if (fn === "audioCompInfo") return { result: info };
        if (fn === "status" && status) return { result: status };
        throw new Error(`unexpected ${fn}`);
      },
    },
  }) as unknown as ToolContext;

const run = (tools: ReturnType<typeof createTranscribeTools>, args: object, ctx: ToolContext) =>
  tools[0].handler(AeTranscribeSchema.parse({ confirm_upload: true, ...args }), ctx) as Promise<any>;

describe("AeTranscribeSchema", () => {
  it("refuses a missing or false confirm_upload", () => {
    expect(AeTranscribeSchema.safeParse({ path: "/a.wav" }).success).toBe(false);
    expect(AeTranscribeSchema.safeParse({ path: "/a.wav", confirm_upload: false }).success).toBe(false);
    expect(AeTranscribeSchema.safeParse({ path: "/a.wav", confirm_upload: true }).success).toBe(true);
  });
  it("needs exactly one source", () => {
    expect(AeTranscribeSchema.safeParse({ confirm_upload: true }).success).toBe(false);
    expect(AeTranscribeSchema.safeParse({ confirm_upload: true, path: "/a.wav", comp_id: 1 }).success).toBe(false);
  });
});

describe("ae_transcribe with a file path", () => {
  it("uploads multipart with the key in a header, writes the raw response, and never leaks the key", async () => {
    const dir = tempDir("chroma-tr-");
    const seen: Seen[] = [];
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE), seen) } });
    const out = await run(tools, { path: writeAudio(dir), language: "en", num_speakers: 2 }, noProject);
    expect(out).toMatchObject({
      ok: true,
      state: "done",
      engine: "elevenlabs",
      model: "scribe_v1",
      offset: 0,
      language_code: "eng",
      words: 3,
      speakers: ["speaker_0", "speaker_1"],
      audio_events: 1,
      duration_s: 1.9,
      preview: "Hello there. Hi!",
    });
    expect(out.transcript_path).toBe(path.join(dir, "talk.elevenlabs.json"));
    expect(out.next).toContain("offset: 0");
    expect(JSON.parse(fs.readFileSync(out.transcript_path, "utf8"))).toEqual(SCRIBE);

    expect(seen[0].options.headers["xi-api-key"]).toBe(KEY);
    expect(seen[0].options.path).toBe("/v1/speech-to-text");
    const body = seen[0].body.toString("latin1");
    for (const f of ["model_id", "language_code", "diarize", "num_speakers", "tag_audio_events", "timestamps_granularity"]) {
      expect(body).toContain(`name="${f}"`);
    }
    expect(body).toContain("scribe_v1");
    expect(body).toContain("RIFFfakeaudiobytes");
    expect(body).toContain('filename="talk.wav"');
    expect(Number(seen[0].options.headers["Content-Length"])).toBe(seen[0].body.length);
    expect(body).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("writes JSON that parseTranscript reads into words with speakers", async () => {
    const dir = tempDir("chroma-tr-parse-");
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE)) } });
    const out = await run(tools, { path: writeAudio(dir) }, noProject);
    const segs = parseTranscript(fs.readFileSync(out.transcript_path, "utf8"));
    const words = segs.flatMap((s) => s.words ?? []);
    expect(words.map((w) => w.text)).toEqual(["Hello", "there.", "Hi!"]);
    expect(words.map((w) => w.speaker)).toEqual(["speaker_0", "speaker_0", "speaker_1"]);
  });

  it("never overwrites: a taken name gets ' 2', then ' 3'", async () => {
    const dir = tempDir("chroma-tr-name-");
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE)) } });
    const file = writeAudio(dir);
    const a = await run(tools, { path: file }, noProject);
    const b = await run(tools, { path: file }, noProject);
    const c = await run(tools, { path: file }, noProject);
    expect(path.basename(a.transcript_path)).toBe("talk.elevenlabs.json");
    expect(path.basename(b.transcript_path)).toBe("talk 2.elevenlabs.json");
    expect(path.basename(c.transcript_path)).toBe("talk 3.elevenlabs.json");
    const custom = path.join(dir, "mine.json");
    fs.writeFileSync(custom, "keep");
    const d = await run(tools, { path: file, out_path: custom }, noProject);
    expect(path.basename(d.transcript_path)).toBe("mine 2.json");
    expect(fs.readFileSync(custom, "utf8")).toBe("keep");
  });

  it("puts the file in the project's captions folder when AE has a saved project", async () => {
    const dir = tempDir("chroma-tr-proj-");
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE)) } });
    const proj = path.join(dir, "Job.aep");
    const out = await run(tools, { path: writeAudio(dir) }, withProject({}, { project_path: proj }));
    expect(out.transcript_path).toBe(path.join(dir, "Job chroma captions", "talk.elevenlabs.json"));
  });

  it("refuses a missing file, a wrong extension and a file over the cap", async () => {
    const dir = tempDir("chroma-tr-bad-");
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, "{}") }, maxBytes: 10 });
    expect(await run(tools, { path: path.join(dir, "nope.wav") }, noProject)).toMatchObject({ ok: false, error: "bad_path" });
    const txt = path.join(dir, "a.txt");
    fs.writeFileSync(txt, "x");
    expect(await run(tools, { path: txt }, noProject)).toMatchObject({ ok: false, error: "bad_path" });
    expect(await run(tools, { path: writeAudio(dir, "big.wav", "x".repeat(50)) }, noProject)).toMatchObject({ ok: false, error: "too_large" });
  });

  it("reports API errors with the status and no key", async () => {
    const dir = tempDir("chroma-tr-err-");
    const file = writeAudio(dir);
    for (const [status, body] of [
      [401, JSON.stringify({ detail: { status: "invalid_api_key", message: `Invalid API key ${KEY}` } })],
      [422, JSON.stringify({ detail: "Unsupported file" })],
    ] as const) {
      const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(status, body) } });
      const out = await run(tools, { path: file }, noProject);
      expect(out).toMatchObject({ ok: false, error: "api_error", http_status: status });
      expect(out.message).toContain(String(status));
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });

  it("calls a 200 without a words array bad_response", async () => {
    const dir = tempDir("chroma-tr-bad2-");
    const file = writeAudio(dir);
    for (const body of [JSON.stringify({ text: "hi" }), "not json"]) {
      const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, body) } });
      expect(await run(tools, { path: file }, noProject)).toMatchObject({ ok: false, error: "bad_response" });
    }
  });

  it("reports a network failure as upload_failed without the key", async () => {
    const dir = tempDir("chroma-tr-net-");
    const request: any = () => {
      const req: any = new Writable({ write(_c, _e, d) { d(); }, final(d) { d(); req.emit("error", new Error(`ECONNRESET ${KEY}`)); } });
      req.setTimeout = () => req;
      return req;
    };
    const tools = createTranscribeTools({ engines: { elevenlabs: createElevenLabsEngine({ getKey: async () => KEY, request }) } });
    const out = await run(tools, { path: writeAudio(dir) }, noProject);
    expect(out).toMatchObject({ ok: false, error: "upload_failed" });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("returns no_api_key naming the variable when none is set", async () => {
    const dir = tempDir("chroma-tr-nokey-");
    const getKey = createKeyResolver({ env: {}, platform: "linux" });
    const tools = createTranscribeTools({ engines: { elevenlabs: createElevenLabsEngine({ getKey, request: fakeRequest(200, "{}") }) } });
    const out = await run(tools, { path: writeAudio(dir) }, noProject);
    expect(out).toMatchObject({ ok: false, error: "no_api_key" });
    expect(out.message).toContain("ELEVENLABS_API_KEY");
  });

  it("an unknown job_id is refused", async () => {
    const tools = createTranscribeTools({ engines: { elevenlabs: engineWith(200, "{}") } });
    expect(await run(tools, { job_id: "nope" }, noProject)).toMatchObject({ ok: false, error: "unknown_job" });
  });
});

describe("ae_transcribe with a comp", () => {
  const info = (extra: object = {}) => ({
    comp_id: 4,
    name: "Interview",
    name_unique: true,
    duration: 4,
    fps: 25,
    frame_duration: 0.04,
    display_start_time: 0,
    audio_layers: [{ index: 1, name: "VO" }],
    project_path: "",
    dirty: false,
    ...extra,
  });

  it("renders then uploads, with job states over two calls, and writes next to the project", async () => {
    const root = tempDir("chroma-tr-comp-");
    const proj = path.join(root, "Spot.aep");
    const started: Array<Record<string, unknown>> = [];
    let state: "running" | "succeeded" = "running";
    let output = "";
    const seen: Seen[] = [];
    const tools = createTranscribeTools({
      engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE), seen) },
      rendersDir: () => root,
      pollMs: 5,
      startRender: async (args) => {
        started.push(args);
        output = String(args.output_path);
        return { ok: true, job_id: "render_1" };
      },
      getJob: () => ({ state, output_path: output, log_path: "x.log" }),
    });
    const ctx = withProject(info({ project_path: proj }));
    const first = await run(tools, { comp_id: 4, wait_s: 0 }, ctx);
    expect(first).toMatchObject({ ok: true, state: "rendering" });
    expect(started[0]).toMatchObject({ comp_name: "Interview", output_module_template: "AIFF 48kHz", start_frame: 0, end_frame: 99, expect: { project_path: proj } });
    fs.writeFileSync(output, "FORMfakeaiff");
    state = "succeeded";
    const second = await run(tools, { job_id: first.job_id, wait_s: 5 }, ctx);
    expect(second).toMatchObject({ ok: true, state: "done", offset: 0, words: 3 });
    expect(second.transcript_path).toBe(path.join(root, "Spot chroma captions", "Interview.elevenlabs.json"));
    expect(seen[0].body.toString("latin1")).toContain("FORMfakeaiff");
    // The finished job answers again with the same result.
    expect(await run(tools, { job_id: first.job_id, wait_s: 0 }, ctx)).toMatchObject({ state: "done", transcript_path: second.transcript_path });
  });

  it("reports a failed render, and refuses a shared name or a comp without sound", async () => {
    const root = tempDir("chroma-tr-comp2-");
    const tools = createTranscribeTools({
      engines: { elevenlabs: engineWith(200, "{}") },
      rendersDir: () => root,
      pollMs: 5,
      startRender: async () => ({ ok: true, job_id: "r" }),
      getJob: () => ({ state: "failed", output_path: "x", error: "template missing", log_path: "x.log" }),
    });
    const proj = path.join(root, "P.aep");
    expect(await run(tools, { comp_id: 4, wait_s: 5 }, withProject(info({ project_path: proj })))).toMatchObject({ ok: false, error: "render_failed" });
    expect(await run(tools, { comp_id: 4 }, withProject(info({ name_unique: false, project_path: proj })))).toMatchObject({ ok: false, error: "ambiguous_comp" });
    expect(await run(tools, { comp_id: 4 }, withProject(info({ audio_layers: [], project_path: proj })))).toMatchObject({ ok: false, error: "no_audio" });
  });
});

describe("API key lookup", () => {
  it("prefers the environment", async () => {
    let called = false;
    const key = await lookupElevenLabsKey({ env: { ELEVENLABS_API_KEY: " envkey " }, platform: "win32", execFile: async () => { called = true; return ""; } });
    expect(key).toBe("envkey");
    expect(called).toBe(false);
  });

  it("reads the Windows User variable with reg query when the environment has none", async () => {
    const calls: string[][] = [];
    const key = await lookupElevenLabsKey({
      env: {},
      platform: "win32",
      execFile: async (file, args) => {
        calls.push([file, ...args]);
        return "\r\nHKEY_CURRENT_USER\\Environment\r\n    ELEVENLABS_API_KEY    REG_SZ    regkey123\r\n\r\n";
      },
    });
    expect(key).toBe("regkey123");
    expect(calls[0]).toEqual(["reg", "query", "HKCU\\Environment", "/v", "ELEVENLABS_API_KEY"]);
    const expand = await lookupElevenLabsKey({ env: {}, platform: "win32", execFile: async () => "    ELEVENLABS_API_KEY    REG_EXPAND_SZ    k2\r\n" });
    expect(expand).toBe("k2");
    expect(await lookupElevenLabsKey({ env: {}, platform: "win32", execFile: async () => { throw new Error("not found"); } })).toBeUndefined();
  });

  it("reads ~/.zprofile on macOS, stripping quotes", async () => {
    const read = (p: string) => (p.endsWith(".zprofile") ? `export PATH=x\nexport ELEVENLABS_API_KEY="zkey"\n` : undefined);
    expect(await lookupElevenLabsKey({ env: {}, platform: "darwin", readFile: read, home: "/Users/j" })).toBe("zkey");
    expect(await lookupElevenLabsKey({ env: {}, platform: "darwin", readFile: () => undefined })).toBeUndefined();
  });

  it("does not look in the registry or zprofile on other platforms, and caches the found key", async () => {
    expect(await lookupElevenLabsKey({ env: {}, platform: "linux", execFile: async () => "ELEVENLABS_API_KEY REG_SZ x" })).toBeUndefined();
    let n = 0;
    const resolve = createKeyResolver({ env: {}, platform: "win32", execFile: async () => { n++; return "ELEVENLABS_API_KEY    REG_SZ    cached"; } });
    expect(await resolve()).toBe("cached");
    expect(await resolve()).toBe("cached");
    expect(n).toBe(1);
    await expect(createKeyResolver({ env: {}, platform: "linux" })()).rejects.toBeInstanceOf(TranscribeError);
  });
});

// ---------- the comp's one footage file, uploaded as it is ----------

import { FakeFootage, FakeGroup, FakeProject, FakeProperty, FileSource, PropertyValueType, loadHost, type FakeLayer } from "./support/fake-ae.js";

describe("ae_transcribe with a comp whose sound is one footage file", () => {
  /** A comp with one audio footage layer over the fake AE; the tool's host calls run the real host JSX. */
  function scene(file: string, tweak: (layer: FakeLayer, footage: FakeFootage) => void = () => {}) {
    const project = new FakeProject();
    project.file = { fsName: path.join(path.dirname(file), "Spot.aep") };
    const comp = project.addComp("Interview", 1920, 1080, 20);
    comp.frameRate = 25;
    const footage = project.addFootage("talk.wav", 0, 0, Object.assign(new FileSource(), {}));
    (footage as any).file = { fsName: file, exists: true };
    footage.duration = 12;
    const layer = comp.layers.add(footage) as FakeLayer;
    layer.hasAudio = true;
    layer.audioEnabled = true;
    layer.outPoint = 12;
    layer.group.props.push(new FakeGroup("Audio", "ADBE Audio Group", [new FakeProperty("Audio Levels", "ADBE Audio Levels", PropertyValueType.TwoD, [0, 0])]));
    tweak(layer, footage);
    const host = loadHost(project, ["captions.jsx", "audio.jsx"]);
    const calls: string[] = [];
    const ctx = {
      bridge: {
        callHost: async (fn: string, args: unknown) => {
          calls.push(fn);
          if (fn === "status") return { result: { project_path: path.join(path.dirname(file), "Spot.aep") } };
          return { result: JSON.parse(JSON.stringify(host.G.__chromaAe[fn](args))) };
        },
      },
    } as unknown as ToolContext;
    return { project, comp, layer, footage, ctx, calls };
  }

  const tools = (seen: Seen[], renders: Array<Record<string, unknown>> = []) =>
    createTranscribeTools({
      engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE), seen) },
      rendersDir: () => tempDir("chroma-tr-renders-"),
      startRender: async (a) => {
        renders.push(a);
        return { ok: true, job_id: "r1" };
      },
      getJob: () => ({ state: "failed", output_path: "x", error: "aerender never started", log_path: "x.log" }),
    });

  it("uploads the file itself, offset = the layer's start time, and says source footage_file (no render)", async () => {
    const dir = tempDir("chroma-tr-fg-");
    const file = writeAudio(dir, "talk.wav", "RIFFthefootage");
    const { comp, ctx } = scene(file, (l) => {
      l.startTime = 2.5;
      l.inPoint = 2.5;
      l.outPoint = 14.5;
    });
    const seen: Seen[] = [];
    const renders: Array<Record<string, unknown>> = [];
    const out = await run(tools(seen, renders), { comp_id: comp.id, wait_s: 5 }, ctx);
    expect(out).toMatchObject({ ok: true, state: "done", source: "footage_file", offset: 2.5, source_file: file });
    expect(out.next).toContain("offset: 2.5");
    expect(out.audible_in_file).toBeUndefined();
    expect(renders).toHaveLength(0);
    expect(seen[0].body.toString("latin1")).toContain("RIFFthefootage");
    expect(out.layer).toMatchObject({ name: "talk.wav", start_time: 2.5 });
  });

  it("a layer trimmed at the in point still uses the file: offset stays the start time and the audible window is in file time", async () => {
    const file = writeAudio(tempDir("chroma-tr-fg2-"));
    const { comp, ctx } = scene(file, (l) => {
      l.startTime = 1;
      l.inPoint = 4;
      l.outPoint = 9;
    });
    const out = await run(tools([]), { comp_id: comp.id, wait_s: 5 }, ctx);
    expect(out).toMatchObject({ ok: true, source: "footage_file", offset: 1, audible_in_file: { from_s: 3, to_s: 8 } });
    expect(out.next).toContain("from_s: 3, to_s: 8");
  });

  it.each([
    ["time remap", (l: FakeLayer) => ((l as any).timeRemapEnabled = true), /time remapping/],
    ["a stretch", (l: FakeLayer) => (l.stretch = 50), /time-stretched/],
    ["an effect", (l: FakeLayer) => (l.group.props.find((p) => p.name === "Effects") as FakeGroup).props.push(new FakeGroup("Delay", "ADBE Delay", [])), /effect/],
    ["keyed Audio Levels", (l: FakeLayer) => (((l.group.props.find((p) => p.name === "Audio") as FakeGroup).props[0] as FakeProperty).setValueAtTime(0, [0, 0])), /keyframes/],
    ["Audio Levels at -6 dB", (l: FakeLayer) => (((l.group.props.find((p) => p.name === "Audio") as FakeGroup).props[0] as FakeProperty).setValue([-6, -6])), /0 dB/],
  ])("falls back to the aerender path for %s, and says why", async (_name, tweak, why) => {
    const file = writeAudio(tempDir("chroma-tr-fg3-"));
    const { comp, ctx } = scene(file, tweak as any);
    const renders: Array<Record<string, unknown>> = [];
    const out = await run(tools([], renders), { comp_id: comp.id, wait_s: 5 }, ctx);
    expect(renders).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, error: "render_failed" });
    // The skipped reason travels with a successful render; here the render fails, so look at the host's verdict directly.
    const verdict = (await ctx.bridge.callHost("captionsAudioSource", { comp_id: comp.id }, {} as any)).result as any;
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(why);
  });

  it("two audible layers, a precomp source, a format ElevenLabs does not take, or footage_shortcut false all render instead", async () => {
    const dir = tempDir("chroma-tr-fg4-");
    const two = scene(writeAudio(dir, "a.wav"));
    const second = two.comp.layers.add(two.footage) as FakeLayer;
    second.hasAudio = true;
    const r1: Array<Record<string, unknown>> = [];
    await run(tools([], r1), { comp_id: two.comp.id, wait_s: 5 }, two.ctx);
    expect(r1).toHaveLength(1);

    const odd = scene(writeAudio(dir, "voice.xyz"));
    const r2: Array<Record<string, unknown>> = [];
    await run(tools([], r2), { comp_id: odd.comp.id, wait_s: 5 }, odd.ctx);
    expect(r2).toHaveLength(1);

    const off = scene(writeAudio(dir, "b.wav"));
    const r3: Array<Record<string, unknown>> = [];
    await run(tools([], r3), { comp_id: off.comp.id, wait_s: 5, footage_shortcut: false }, off.ctx);
    expect(r3).toHaveLength(1);
    expect(off.calls).not.toContain("captionsAudioSource");

    const inner = scene(writeAudio(dir, "c.wav"));
    const pre = inner.project.addComp("Pre", 100, 100, 5);
    inner.comp.layers.add(pre);
    (inner.comp.stack.find((l) => l.source === inner.footage) as FakeLayer).audioEnabled = false;
    (inner.comp.stack[0] as FakeLayer).hasAudio = true;
    const r4: Array<Record<string, unknown>> = [];
    await run(tools([], r4), { comp_id: inner.comp.id, wait_s: 5 }, inner.ctx);
    expect(r4).toHaveLength(1);
  });

  it("a successful render after a skipped shortcut reports footage_shortcut_skipped and source render", async () => {
    const root = tempDir("chroma-tr-fg5-");
    const file = writeAudio(root);
    const { comp, ctx } = scene(file, (l) => (l.stretch = 50));
    let output = "";
    const t = createTranscribeTools({
      engines: { elevenlabs: engineWith(200, JSON.stringify(SCRIBE)) },
      rendersDir: () => root,
      pollMs: 5,
      startRender: async (a) => {
        output = String(a.output_path);
        fs.writeFileSync(output, "FORMfake");
        return { ok: true, job_id: "r" };
      },
      getJob: () => ({ state: "succeeded", output_path: output, log_path: "x.log" }),
    });
    const out = await run(t, { comp_id: comp.id, wait_s: 5 }, ctx);
    expect(out).toMatchObject({ ok: true, source: "render" });
    expect(out.footage_shortcut_skipped.join(" ")).toMatch(/time-stretched/);
  });
});
