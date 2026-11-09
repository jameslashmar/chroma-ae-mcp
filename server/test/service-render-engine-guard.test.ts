import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);

type Verdict = { start: boolean; kind: string; reason: string };
const common = require(path.join(repoRoot, "panel", "client", "common.js")) as {
  GUARD_PROBE_SCRIPT: string;
  GUARD_TIMEOUT_MS: number;
  GUARD_FORCE_ENV: string;
  isGuardOverridden: (env: Record<string, string | undefined>) => boolean;
  decideServiceStart: (input: { probe?: unknown; env?: Record<string, string | undefined> }) => Verdict;
};

/** The panel service's state dir under a temp home, as common.js resolveStateDir picks it on this platform. */
function stateDirUnder(home: string): string {
  if (process.platform === "win32") return path.join(home, "chroma-ae-mcp");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "chroma-ae-mcp");
  return path.join(home, ".chroma-ae-mcp");
}

describe("render-engine guard: pure decision", () => {
  it("stops only on the exact render-engine answer", () => {
    const v = common.decideServiceStart({ probe: "chroma-guard:render-engine", env: {} });
    expect(v.start).toBe(false);
    expect(v.kind).toBe("render-engine");
  });

  it("starts when the host says it is interactive", () => {
    const v = common.decideServiceStart({ probe: "chroma-guard:interactive", env: {} });
    expect(v).toMatchObject({ start: true, kind: "interactive" });
  });

  it("fails open when the check returned nothing or something odd", () => {
    for (const probe of [undefined, null, "", "   ", "EvalScript error.", "chroma-guard:unknown", "undefined", "true", "garbage"]) {
      const v = common.decideServiceStart({ probe, env: {} });
      expect(v.start, `probe ${JSON.stringify(probe)}`).toBe(true);
      expect(v.kind).toBe("unknown");
    }
    expect(common.decideServiceStart({}).start).toBe(true);
    expect(common.decideServiceStart({ probe: "chroma-guard:render-engine" }).start).toBe(false);
  });

  it("ignores whitespace around the answer", () => {
    expect(common.decideServiceStart({ probe: "  chroma-guard:render-engine\n", env: {} }).start).toBe(false);
  });

  it("lets CHROMA_AE_MCP_FORCE_START=1 override even a render-engine answer", () => {
    const env = { [common.GUARD_FORCE_ENV]: "1" };
    expect(common.isGuardOverridden(env)).toBe(true);
    const v = common.decideServiceStart({ probe: "chroma-guard:render-engine", env });
    expect(v).toMatchObject({ start: true, kind: "forced" });
    expect(common.isGuardOverridden({ [common.GUARD_FORCE_ENV]: "0" })).toBe(false);
    expect(common.isGuardOverridden({})).toBe(false);
  });
});

describe("render-engine guard: the ExtendScript probe", () => {
  it("is plain ES3 text (no let/const/arrows/template strings, no JSON, no ternaries)", () => {
    expect(common.GUARD_PROBE_SCRIPT).not.toMatch(/\b(let|const|class)\b|=>|`|JSON\.|\?[^']*:/);
  });

  function run(app: unknown, defineApp = true): string {
    const sandbox: Record<string, unknown> = {};
    if (defineApp) sandbox.app = app;
    return vm.runInNewContext(common.GUARD_PROBE_SCRIPT, sandbox) as string;
  }

  it("answers render-engine, interactive or unknown and never throws", () => {
    expect(run({ isRenderEngine: true })).toBe("chroma-guard:render-engine");
    expect(run({ isRenderEngine: false })).toBe("chroma-guard:interactive");
    expect(run({})).toBe("chroma-guard:unknown");
    expect(run(null)).toBe("chroma-guard:unknown");
    expect(run(undefined, false)).toBe("chroma-guard:unknown");
    const throwing = {
      get isRenderEngine(): boolean {
        throw new Error("boom");
      },
    };
    expect(run(throwing)).toBe("chroma-guard:unknown");
  });

  it("feeds the decision correctly end to end", () => {
    expect(common.decideServiceStart({ probe: run({ isRenderEngine: true }), env: {} }).start).toBe(false);
    expect(common.decideServiceStart({ probe: run({ isRenderEngine: false }), env: {} }).start).toBe(true);
  });
});

// ---- service.js with a fake CSInterface ----

type Cb = (raw: string) => void;
const servicePath = path.join(repoRoot, "panel", "client", "service.js");

describe("render-engine guard: service boot", () => {
  let stateRoot = "";
  let calls: Array<{ script: string; cb: Cb }> = [];
  let service: { shutdown: () => void } | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-guard-"));
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.LOCALAPPDATA = stateRoot;
    process.env.HOME = stateRoot;
    process.env.USERPROFILE = stateRoot;
    delete process.env.CHROMA_AE_MCP_FORCE_START;
    process.env.CHROMA_AE_MCP_PORT = "47911";
    calls = [];
    class FakeCSInterface {
      evalScript(script: string, cb: Cb): void {
        calls.push({ script, cb });
      }
      getSystemPath(): string {
        return "file:///" + path.join(repoRoot, "panel").replace(/\\/g, "/");
      }
      getHostEnvironment(): { appVersion: string } {
        return { appVersion: "26.0" };
      }
    }
    (globalThis as Record<string, unknown>).window = {
      CSInterface: FakeCSInterface,
      ChromaAeCommon: common,
      addEventListener: () => {},
    };
  });

  afterEach(() => {
    try {
      service?.shutdown();
    } catch {
      /* ignore */
    }
    service = null;
    delete (globalThis as Record<string, unknown>).window;
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.useRealTimers();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  function loadService(): void {
    delete require.cache[servicePath];
    service = require(servicePath) as { shutdown: () => void };
  }
  const stateDir = () => stateDirUnder(stateRoot);
  const readLog = () => {
    try {
      return fs.readFileSync(path.join(stateDir(), "service.log"), "utf8");
    } catch {
      return "";
    }
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it("asks one cheap question first and does nothing else in a render engine", async () => {
    loadService();
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(common.GUARD_PROBE_SCRIPT);
    calls[0].cb("chroma-guard:render-engine");
    for (let i = 0; i < 20; i++) await tick();
    expect(calls).toHaveLength(1); // no boot script, no core.jsx, no later polling
    expect(fs.existsSync(path.join(stateDir(), "token"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir(), "frames"))).toBe(false);
    expect(readLog()).toContain("Render engine detected");
    expect(readLog()).not.toContain("Listening");
  });

  it("boots the host files in the real AE (interactive answer)", async () => {
    loadService();
    calls[0].cb("chroma-guard:interactive");
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].script).toContain("core.jsx");
    service!.shutdown(); // before the port is bound
    expect(fs.existsSync(path.join(stateDir(), "token"))).toBe(true);
  });

  it.each([["empty", ""], ["error text", "EvalScript error."], ["undefined", "undefined"]])(
    "carries on as before when the check returns %s",
    async (_name, answer) => {
      loadService();
      calls[0].cb(answer);
      await tick();
      expect(calls).toHaveLength(2);
      expect(calls[1].script).toContain("core.jsx");
      expect(readLog()).toContain("starting");
      service!.shutdown();
    }
  );

  it("carries on after the timeout, and a late render-engine answer still stops it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    loadService();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(common.GUARD_TIMEOUT_MS + 1);
    await tick();
    expect(calls).toHaveLength(2); // fail open: boot script sent behind the probe
    calls[0].cb("chroma-guard:render-engine"); // the probe finally answers
    expect(readLog()).toContain("answered late");
    calls[1].cb("26.0|ok");
    for (let i = 0; i < 10; i++) await tick();
    expect(readLog()).not.toContain("Listening"); // shut down, never bound
  });

  it("skips the probe when CHROMA_AE_MCP_FORCE_START=1", async () => {
    process.env.CHROMA_AE_MCP_FORCE_START = "1";
    loadService();
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toContain("core.jsx");
    service!.shutdown();
  });

  it("with the port taken: logs once, queues no extra evalScript, loads no MCP bundle", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(47911, "127.0.0.1", resolve));
    try {
      loadService();
      calls[0].cb("chroma-guard:interactive");
      await tick();
      expect(calls).toHaveLength(2);
      calls[1].cb("26.0|ok");
      for (let i = 0; i < 200 && !readLog().includes("EADDRINUSE"); i++) await new Promise((r) => setTimeout(r, 10));
      expect(readLog()).toContain("EADDRINUSE");
      expect(readLog()).not.toContain("Listening");
      expect(readLog()).not.toContain("MCP bundle"); // asset watcher not created
      expect(calls).toHaveLength(2); // nothing polls evalScript while waiting for the port
    } finally {
      service?.shutdown();
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe("service shutdown stops the MCP bundle's background work", () => {
  let root = "";
  let extDir = "";
  let service: { shutdown: () => void } | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const rec = () => (globalThis as Record<string, any>).__fakeMcp as { created: number; stops: number; watcherStops: number };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-stop-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.LOCALAPPDATA = root;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.CHROMA_AE_MCP_FORCE_START;
    process.env.CHROMA_AE_MCP_PORT = "47913";
    (globalThis as Record<string, any>).__fakeMcp = { created: 0, stops: 0, watcherStops: 0 };
    class FakeCSInterface {
      evalScript(): void {}
      getSystemPath(): string {
        return "file:///" + extDir.split(path.sep).join("/");
      }
      getHostEnvironment(): { appVersion: string } {
        return { appVersion: "26.0" };
      }
    }
    (globalThis as Record<string, unknown>).window = { CSInterface: FakeCSInterface, ChromaAeCommon: common, addEventListener: () => {} };
  });

  afterEach(() => {
    try {
      service?.shutdown();
    } catch {
      /* ignore */
    }
    service = null;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).__fakeMcp;
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Boots the service against a fake MCP bundle, waits until it owns the port and has loaded it, and returns. */
  async function bootWithBundle(withStop: boolean): Promise<void> {
    fs.writeFileSync(
      path.join(extDir, "client", "mcp-bundle.cjs"),
      [
        "exports.createPanelMcp = function () {",
        "  var rec = globalThis.__fakeMcp; rec.created++;",
        "  var api = { handleHttp: function () {}, asks: {}, ctx: {}, assetWatcher: { stop: function () { rec.watcherStops++; } } };",
        withStop ? "  api.stop = function () { rec.stops++; };" : "",
        "  return api;",
        "};",
      ].join("\n")
    );
    delete require.cache[servicePath];
    service = require(servicePath) as { shutdown: () => void };
    for (let i = 0; i < 400 && rec().created === 0; i++) await new Promise((r) => setTimeout(r, 10));
  }

  it("calls the bundle's stop() so the asset watcher stops polling evalScript", async () => {
    // Skip the probe: the override makes the service start at once.
    process.env.CHROMA_AE_MCP_FORCE_START = "1";
    await bootWithBundle(true);
    expect(rec().created).toBe(1);
    service!.shutdown();
    expect(rec().stops).toBe(1);
  });

  it("falls back to assetWatcher.stop() for a bundle built before stop() existed", async () => {
    process.env.CHROMA_AE_MCP_FORCE_START = "1";
    await bootWithBundle(false);
    expect(rec().created).toBe(1);
    service!.shutdown();
    expect(rec().watcherStops).toBe(1);
  });
});

describe("service routes while the render gate is shut", () => {
  let root = "";
  let extDir = "";
  let service: { shutdown: () => void } | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const PORT = 47917;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-lock-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.LOCALAPPDATA = root;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.CHROMA_AE_MCP_FORCE_START = "1";
    process.env.CHROMA_AE_MCP_PORT = String(PORT);
    (globalThis as Record<string, any>).__fakeLock = { lock: null, cleared: 0 };
    class FakeCSInterface {
      evalScript(): void {}
      getSystemPath(): string {
        return "file:///" + extDir.split(path.sep).join("/");
      }
      getHostEnvironment(): { appVersion: string } {
        return { appVersion: "26.0" };
      }
    }
    (globalThis as Record<string, unknown>).window = { CSInterface: FakeCSInterface, ChromaAeCommon: common, addEventListener: () => {} };
    fs.writeFileSync(
      path.join(extDir, "client", "mcp-bundle.cjs"),
      [
        "exports.createPanelMcp = function () {",
        "  var st = globalThis.__fakeLock;",
        "  return {",
        "    handleHttp: function () {}, asks: {}, ctx: {}, assetWatcher: { stop: function () {} }, stop: function () {},",
        "    renderLock: function () { return st.lock; },",
        "    clearRenderLock: function () { st.cleared++; var l = st.lock; st.lock = null; return l ? l.info : null; }",
        "  };",
        "};",
      ].join("\n")
    );
  });

  afterEach(() => {
    try {
      service?.shutdown();
    } catch {
      /* ignore */
    }
    service = null;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).__fakeLock;
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const st = () => (globalThis as Record<string, any>).__fakeLock as { lock: any; cleared: number };

  async function boot(): Promise<string> {
    delete require.cache[servicePath];
    service = require(servicePath) as { shutdown: () => void };
    const tokenFile = path.join(stateDirUnder(root), "token");
    for (let i = 0; i < 300; i++) {
      try {
        const t = fs.readFileSync(tokenFile, "utf8").trim();
        if (t) {
          // The port is bound once /health answers.
          const r = await call("GET", "/health", t).catch(() => null);
          if (r && r.status === 200) return t;
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("service did not start");
  }

  function call(method: string, route: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: route, method, headers: { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, json: data });
            }
          });
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  it("POST /eval is refused at once while the gate is shut, and /health reports the lock", async () => {
    const token = await boot();
    st().lock = { info: { job_id: "rqjob_1", state: "rendering" }, message: "After Effects is rendering (job rqjob_1)." };
    const evalRes = await call("POST", "/eval", token, { id: "x", script: "1", label: "t" });
    expect(evalRes.json).toMatchObject({ id: "x", ok: false, error: { kind: "queued" } });
    expect(evalRes.json.error.message).toMatch(/rendering/);
    const health = await call("GET", "/health", token);
    expect(health.json.renderLock).toEqual({ job_id: "rqjob_1", state: "rendering" });
    expect(health.json.busy).toBe(false); // nothing was queued behind the render
    st().lock = null;
    expect((await call("GET", "/health", token)).json.renderLock).toBeNull();
  });

  it("POST /admin/clear-render-lock clears it for the user and says what it cleared", async () => {
    const token = await boot();
    st().lock = { info: { job_id: "rqjob_2", state: "unknown" }, message: "m" };
    const res = await call("POST", "/admin/clear-render-lock", token, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, cleared: { job_id: "rqjob_2" } });
    expect(st().cleared).toBe(1);
    const again = await call("POST", "/admin/clear-render-lock", token, {});
    expect(again.json).toMatchObject({ ok: true, cleared: null });
  });

  it("the panel shows the Clear render lock button only from the health answer", () => {
    const html = fs.readFileSync(path.join(repoRoot, "panel", "client", "index.html"), "utf8");
    expect(html).toMatch(/id="clear-render-lock-btn"[^>]*hidden/);
    const js = fs.readFileSync(path.join(repoRoot, "panel", "client", "panel.js"), "utf8");
    expect(js).toMatch(/body\.renderLock/);
    expect(js).toMatch(/\/admin\/clear-render-lock/);
  });
});
