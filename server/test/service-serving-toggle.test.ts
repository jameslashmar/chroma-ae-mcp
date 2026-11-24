/**
 * The panel's Start/Stop button: POST /admin/serving on the real service.js, with a fake
 * CSInterface, a fake MCP bundle and real sockets (the harness of startup-service.test.ts).
 * Stopped: evals are refused with kind "queued" before they reach After Effects, waiting calls are
 * refused, the call in flight finishes, and the port stays held.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const servicePath = path.join(repoRoot, "panel", "client", "service.js");

function stateDirUnder(home: string): string {
  if (process.platform === "win32") return path.join(home, "chroma-ae-mcp");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "chroma-ae-mcp");
  return path.join(home, ".chroma-ae-mcp");
}

type Cb = (raw: string) => void;
type Handle = { shutdown: () => void };
type Reply = { status: number; body: any };

const AE2026 = "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files";

describe("service: the panel's Start/Stop button", () => {
  let root = "";
  let extDir = "";
  let started: Handle[] = [];
  let calls: Array<{ script: string; cb: Cb }> = [];
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const g = globalThis as Record<string, any>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-serving-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "host"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "host", "core.jsx"), "// fake");
    fs.writeFileSync(
      path.join(extDir, "client", "mcp-bundle.cjs"),
      "module.exports = { createPanelMcp: function (opts) { (globalThis.__fakeMcpOpts = globalThis.__fakeMcpOpts || []).push(opts); return { handleHttp: function () {}, stop: function () {}, renderLock: function () { return null; } }; } };"
    );
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.LOCALAPPDATA = root;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.CHROMA_AE_MCP_FORCE_START;
    g.__fakeMcpOpts = [];
    started = [];
    calls = [];
  });

  afterEach(() => {
    for (const s of started.splice(0)) {
      try {
        s.shutdown();
      } catch {
        /* ignore */
      }
    }
    delete g.window;
    delete g.__fakeMcpOpts;
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stateDir = () => stateDirUnder(root);
  const readLog = () => {
    try {
      return fs.readFileSync(path.join(stateDir(), "service.log"), "utf8");
    } catch {
      return "";
    }
  };
  const until = async (cond: () => boolean, ms = 4000) => {
    for (let i = 0; i < ms / 10 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  async function startService(port: number): Promise<Handle> {
    process.env.CHROMA_AE_MCP_PORT = String(port);
    class FakeCSInterface {
      evalScript(script: string, cb: Cb): void {
        calls.push({ script, cb });
      }
      getSystemPath(which: string): string {
        if (which === "hostApplication") return AE2026;
        return "file:///" + extDir.split(path.sep).join("/");
      }
      getHostEnvironment(): { appName: string; appVersion: string } {
        return { appName: "AEFT", appVersion: "26.0" };
      }
    }
    g.window = {
      CSInterface: FakeCSInterface,
      SystemPath: { EXTENSION: "extension", HOST_APPLICATION: "hostApplication" },
      ChromaAeCommon: require(path.join(repoRoot, "panel", "client", "common.js")),
      addEventListener: () => {},
    };
    delete require.cache[servicePath];
    const handle = require(servicePath) as Handle;
    started.push(handle);
    await until(() => calls.length >= 1);
    calls[0].cb("chroma-guard:interactive");
    await until(() => calls.length >= 2);
    calls[1].cb("26.0|ok");
    await until(() => readLog().includes("Listening on"));
    return handle;
  }

  function request(port: number, method: string, route: string, body?: unknown): Promise<Reply> {
    const token = fs.readFileSync(path.join(stateDir(), "token"), "utf8").trim();
    const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: route,
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  const evalBody = (id: string, label = "test eval") => ({ id, script: "1", label });
  /** Answers the newest evalScript call as core.jsx's wrapper would. */
  const answerLast = (result: unknown) => calls[calls.length - 1].cb(JSON.stringify({ ok: true, result }));

  it("Stop refuses evals before they reach After Effects; Start lets them through again", async () => {
    const port = 47941;
    await startService(port);

    const before = await request(port, "GET", "/health");
    expect(before.body).toMatchObject({ ok: true, serving: true, stoppedAt: null });

    const stop = await request(port, "POST", "/admin/serving", { serving: false });
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(true);
    expect(stop.body.serving).toBe(false);
    expect(typeof stop.body.stoppedAt).toBe("string");
    expect((await request(port, "GET", "/health")).body).toMatchObject({ serving: false });
    expect(readLog()).toContain("MCP stopped from the panel");

    const evalsBefore = calls.length;
    const refused = await request(port, "POST", "/eval", evalBody("e1"));
    expect(refused.body).toMatchObject({ id: "e1", ok: false, error: { kind: "queued" } });
    expect(refused.body.error.message).toContain("Stop button");
    expect(refused.body.error.message).toContain("Nothing ran");
    expect(calls.length).toBe(evalsBefore);
    expect(readLog()).toContain("Refused test eval [e1]: the MCP is stopped in the panel");

    // The panel's own routes still answer while stopped.
    expect((await request(port, "GET", "/ask")).status).toBe(200);

    const start = await request(port, "POST", "/admin/serving", { serving: true });
    expect(start.body).toMatchObject({ ok: true, serving: true, stoppedAt: null });
    expect(readLog()).toContain("MCP started from the panel");

    const pending = request(port, "POST", "/eval", evalBody("e2"));
    await until(() => calls.length === evalsBefore + 1);
    answerLast({ value: 7 });
    expect((await pending).body).toMatchObject({ id: "e2", ok: true, result: { value: 7 } });
  });

  it("Stop refuses the calls waiting their turn and lets the one in flight finish", async () => {
    const port = 47942;
    await startService(port);
    const evalsBefore = calls.length;

    const running = request(port, "POST", "/eval", evalBody("run", "long write"));
    await until(() => calls.length === evalsBefore + 1);
    const waiting = request(port, "POST", "/eval", evalBody("wait", "queued read"));
    await until(() => ((g.__fakeMcpOpts[0].serviceInfo().evalQueueDepth as number) ?? 0) === 1);

    await request(port, "POST", "/admin/serving", { serving: false });
    const refused = await waiting;
    expect(refused.body).toMatchObject({ id: "wait", ok: false, error: { kind: "queued" } });
    expect(readLog()).toContain("1 waiting call(s) refused; long write is finishing");

    const health = await request(port, "GET", "/health");
    expect(health.body).toMatchObject({ serving: false, busy: true, queueDepth: 0 });

    // The in-flight eval was never aborted: its answer still reaches its caller.
    answerLast({ done: true });
    expect((await running).body).toMatchObject({ id: "run", ok: true, result: { done: true } });
    expect(calls.length).toBe(evalsBefore + 1);
  });

  it("refuses the MCP bundle's evals too, without a log line for quiet background polls", async () => {
    const port = 47943;
    await startService(port);
    const opts = g.__fakeMcpOpts[0];
    expect(opts.serviceInfo().serving).toBe(true);

    await request(port, "POST", "/admin/serving", { serving: false });
    expect(opts.serviceInfo().serving).toBe(false);
    const evalsBefore = calls.length;
    const linesBefore = readLog().split("\n").length;

    const quiet = await opts.evalScript("1", "quiet: asset watch (status)");
    expect(quiet).toMatchObject({ ok: false, error: { kind: "queued" } });
    expect(readLog().split("\n").length).toBe(linesBefore);

    const loud = await opts.evalScript("1", "ae_set_property");
    expect(loud).toMatchObject({ ok: false, error: { kind: "queued" } });
    expect(readLog()).toContain("Refused ae_set_property");
    expect(calls.length).toBe(evalsBefore);
  });

  it("rejects a body without a boolean serving, and a repeat of the current state changes nothing", async () => {
    const port = 47944;
    await startService(port);
    expect((await request(port, "POST", "/admin/serving", { serving: "no" })).status).toBe(400);
    expect((await request(port, "POST", "/admin/serving", "not json")).status).toBe(400);
    expect((await request(port, "GET", "/health")).body.serving).toBe(true);

    const again = await request(port, "POST", "/admin/serving", { serving: true });
    expect(again.body).toMatchObject({ ok: true, serving: true });
    expect(readLog()).not.toContain("MCP started from the panel");
  });

  it("needs the token like every other route", async () => {
    const port = 47945;
    await startService(port);
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/admin/serving", method: "POST" }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ serving: false }));
    });
    expect(res).toBe(401);
    expect((await request(port, "GET", "/health")).body.serving).toBe(true);
  });
});
