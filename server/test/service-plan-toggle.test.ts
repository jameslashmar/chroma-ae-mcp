/**
 * The panel's "Ask first" button: GET / POST /admin/plan on the real service.js, with a fake
 * CSInterface and a fake MCP bundle holding the setting (the harness of service-serving-toggle.test.ts).
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

describe("service: the panel's Ask first button", () => {
  let root = "";
  let extDir = "";
  let started: Handle[] = [];
  let calls: Array<{ script: string; cb: Cb }> = [];
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const g = globalThis as Record<string, any>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-askfirst-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "host"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "host", "core.jsx"), "// fake");
    fs.writeFileSync(
      path.join(extDir, "client", "mcp-bundle.cjs"),
      process.env.CHROMA_TEST_OLD_BUNDLE === "1" ? "module.exports = { createPanelMcp: function () { return { handleHttp: function () {}, stop: function () {}, renderLock: function () { return null; } }; } };" : "module.exports = { createPanelMcp: function (opts) { var ask = false; return { handleHttp: function () {}, stop: function () {}, renderLock: function () { return null; }, planSettings: function () { return { ask_first: ask }; }, setAskFirst: function (on) { ask = on; return { ask_first: ask }; } }; } };"
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

  it("is off by default, switches on and off, and refuses a bad body", async () => {
    const port = 47951;
    await startService(port);
    expect((await request(port, "GET", "/admin/plan")).body).toEqual({ ok: true, ask_first: false });
    const on = await request(port, "POST", "/admin/plan", { ask_first: true });
    expect(on).toEqual({ status: 200, body: { ok: true, ask_first: true } });
    expect((await request(port, "GET", "/admin/plan")).body.ask_first).toBe(true);
    expect(readLog()).toContain("Ask first on");
    const off = await request(port, "POST", "/admin/plan", { ask_first: false });
    expect(off.body.ask_first).toBe(false);
    const bad = await request(port, "POST", "/admin/plan", { ask_first: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("ask_first");
  });

  it("answers 503 with a bundle that has no Ask first (an older panel bundle)", async () => {
    process.env.CHROMA_TEST_OLD_BUNDLE = "1";
    try {
      const port = 47952;
      // the bundle is written in beforeEach; write the old one again for this test
      fs.writeFileSync(path.join(extDir, "client", "mcp-bundle.cjs"), "module.exports = { createPanelMcp: function () { return { handleHttp: function () {}, stop: function () {}, renderLock: function () { return null; } }; } };");
      await startService(port);
      const r = await request(port, "GET", "/admin/plan");
      expect(r.status).toBe(503);
    } finally {
      delete process.env.CHROMA_TEST_OLD_BUNDLE;
    }
  });
});
