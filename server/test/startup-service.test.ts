import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const servicePath = path.join(repoRoot, "panel", "client", "service.js");
const common = require(path.join(repoRoot, "panel", "client", "common.js")) as {
  buildInstanceInfo: (env: unknown, hostPath: string | null, port: number, paths: { stateDir: string }, extra?: { pid?: number; startedAt?: string }) => Record<string, any>;
  aeLabelFromPath: (p: string) => string | null;
  aeLabelFromVersion: (v: string) => string | null;
  getPaths: (dir?: string) => Record<string, string>;
};

describe("buildInstanceInfo (pure)", () => {
  it("names the AE from its install path, falls back to the version, and has no user or machine name field", () => {
    const info = common.buildInstanceInfo(
      { appName: "AEFT", appVersion: "26.0.0x45" },
      "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files",
      7790,
      { stateDir: "C:\\data" },
      { pid: 4242, startedAt: "2026-11-06T20:33:51.000Z" }
    );
    expect(info).toMatchObject({
      pid: 4242,
      started_at: "2026-11-06T20:33:51.000Z",
      ae_version: "26.0.0x45",
      ae_label: "2026",
      host_path: "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files",
      host_name: "AEFT",
      port: 7790,
      state_dir: "C:\\data",
    });
    expect(Object.keys(info).sort()).toEqual(
      ["ae_label", "ae_version", "host_name", "host_path", "panel_version", "pid", "port", "started_at", "state_dir"].sort()
    );
    expect(common.buildInstanceInfo({ appVersion: "25.2" }, null, 1, { stateDir: "x" }).ae_label).toBe("2025");
    expect(common.buildInstanceInfo({}, "/Applications/Adobe After Effects (Beta)/x", 1, { stateDir: "x" }).ae_label).toBe("Beta");
    expect(common.buildInstanceInfo(null, null, 1, { stateDir: "x" }).ae_label).toBeNull();
  });

  it("labels from paths and versions", () => {
    expect(common.aeLabelFromPath("C:\\Program Files\\Adobe\\Adobe After Effects 2025\\x")).toBe("2025");
    expect(common.aeLabelFromPath("nothing")).toBeNull();
    expect(common.aeLabelFromVersion("26.2.1")).toBe("2026");
    expect(common.aeLabelFromVersion("junk")).toBeNull();
  });
});

// ---- service.js with a fake CSInterface, a fake MCP bundle and real sockets ----

type Cb = (raw: string) => void;
type Handle = { shutdown: () => void };

describe("service: which After Effects owns the port", () => {
  let root = "";
  let extDir = "";
  let started: Handle[] = [];
  const blockers: http.Server[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const g = globalThis as Record<string, any>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-owner-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "host"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "host", "core.jsx"), "// fake");
    // The MCP bundle is faked: this test is about the port, not the tools. It records what it was given.
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
  });

  afterEach(async () => {
    for (const s of started.splice(0)) {
      try {
        s.shutdown();
      } catch {
        /* ignore */
      }
    }
    for (const b of blockers.splice(0)) await new Promise((r) => b.close(r));
    delete g.window;
    delete g.__fakeMcpOpts;
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stateDir = () => path.join(root, "chroma-ae-mcp");
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

  /** Starts one service as an After Effects of the given version and install path would. */
  async function startService(opts: { port: number; appVersion: string; hostPath: string }): Promise<Handle> {
    process.env.CHROMA_AE_MCP_PORT = String(opts.port);
    const calls: Array<{ script: string; cb: Cb }> = [];
    class FakeCSInterface {
      evalScript(script: string, cb: Cb): void {
        calls.push({ script, cb });
      }
      getSystemPath(which: string): string {
        if (which === "hostApplication") return opts.hostPath;
        return "file:///" + extDir.split(path.sep).join("/");
      }
      getHostEnvironment(): { appName: string; appVersion: string } {
        return { appName: "AEFT", appVersion: opts.appVersion };
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
    calls[1].cb(`${opts.appVersion}|ok`);
    return handle;
  }

  const AE2026 = "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files";
  const AE2025 = "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files";

  function getHealth(port: number): Promise<{ status: number; body: any }> {
    const token = fs.readFileSync(path.join(stateDir(), "token"), "utf8").trim();
    return new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/health", headers: { Authorization: `Bearer ${token}` } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        })
        .on("error", reject);
    });
  }

  it("/health carries the instance block; owner.json is written on listen and removed on shutdown", async () => {
    const port = 47931;
    const service = await startService({ port, appVersion: "26.0", hostPath: AE2026 });
    await until(() => readLog().includes("Listening on"));
    const { status, body } = await getHealth(port);
    expect(status).toBe(200);
    expect(body.instance).toMatchObject({
      ae_label: "2026",
      ae_version: "26.0",
      host_path: AE2026,
      host_name: "AEFT",
      port,
      state_dir: stateDir(),
    });
    expect(typeof body.instance.pid).toBe("number");
    expect(typeof body.instance.started_at).toBe("string");

    const ownerFile = path.join(stateDir(), "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    expect(owner.instance).toEqual(body.instance);
    expect(typeof owner.written_at).toBe("string");
    expect(fs.readdirSync(stateDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // The bundle gets the same block through serviceInfo (ae_diagnostics and ae_status read it).
    const info = g.__fakeMcpOpts[0].serviceInfo();
    expect(info.instance).toEqual(body.instance);
    expect(info.hostPath).toBe(AE2026);

    service.shutdown();
    expect(fs.existsSync(ownerFile)).toBe(false);
  });

  it("a second After Effects that loses the port names the owner once, not every 5 s", async () => {
    const port = 47932;
    await startService({ port, appVersion: "26.0", hostPath: AE2026 });
    await until(() => readLog().includes("Listening on"));

    // Fake timers while the loser starts, so its 5 s bind retry is ours to fire.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await startService({ port, appVersion: "25.2", hostPath: AE2025 });
    const wait = async (ms: number, cond: () => boolean = () => false) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !cond()) await new Promise((r) => setImmediate(r));
    };
    await wait(4000, () => readLog().includes("is held by"));
    const line = readLog().split("\n").find((l) => l.includes("is held by"))!;
    expect(line).toContain(`Port ${port} is held by After Effects 2026 (service pid `);
    expect(line).toContain("this After Effects 2025 is not serving MCP");
    expect(line).toContain("[WARN]");
    expect(readLog()).toContain("EADDRINUSE");

    // The bind retry fires (5 s later) and fails again; the owner is not asked again within 5 minutes.
    vi.advanceTimersByTime(5001);
    await wait(600);
    vi.advanceTimersByTime(5001);
    await wait(600);
    vi.useRealTimers();
    expect(readLog().split("\n").filter((l) => l.includes("is held by"))).toHaveLength(1);
    // The loser never loaded the MCP bundle (no asset watcher).
    expect(g.__fakeMcpOpts).toHaveLength(1);
  });

  it("names a program that is not Chroma AE MCP", async () => {
    const port = 47933;
    const blocker = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("nope");
    });
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", () => r()));
    await startService({ port, appVersion: "26.0", hostPath: AE2026 });
    await until(() => readLog().includes("another program"));
    expect(readLog()).toContain(`Port ${port} is used by another program (HTTP 404), not by Chroma AE MCP`);
  });

  it("says a service that answers 401 is another Chroma AE MCP service with a different token", async () => {
    const port = 47934;
    const blocker = http.createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { kind: "auth", message: "Missing or invalid Bearer token" } }));
    });
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", () => r()));
    await startService({ port, appVersion: "26.0", hostPath: AE2026 });
    await until(() => readLog().includes("rejected this token"));
    expect(readLog()).toContain("is held by another Chroma AE MCP service that rejected this token");
  });

  it("keeps the plain EADDRINUSE line and adds nothing when the port holder never answers", async () => {
    const port = 47935;
    const blocker = http.createServer(); // accepts, never answers
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", () => r()));
    await startService({ port, appVersion: "26.0", hostPath: AE2026 });
    await until(() => readLog().includes("EADDRINUSE"));
    await new Promise((r) => setTimeout(r, 1800)); // the probe gives up after 1.5 s
    expect(readLog()).not.toContain("is held by");
    expect(readLog()).not.toContain("another program");
  });
});
