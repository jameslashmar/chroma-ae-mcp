/**
 * The Dynamic Link guard: the hidden After Effects that Premiere Pro or Media Encoder starts to
 * render linked comps ("AfterFX.exe -m", parent dynamiclinkmanager.exe, no window) must not serve
 * MCP. On 2026-11-24 one started before the After Effects on screen, took port 7790, and agents
 * drove it unseen. The Windows rows below are the real chains read that day.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const servicePath = path.join(repoRoot, "panel", "client", "service.js");
const common = require(path.join(repoRoot, "panel", "client", "common.js")) as Record<string, any>;

type Row = { pid: number; ppid: number; name: string };
const rows = (text: string): Row[] => common.parseProcessRows(text);

// The hidden copy's CEP engine, its After Effects, and Premiere's dynamiclinkmanager (whose parent had exited).
const HIDDEN_WIN = ["45240 56520 CEPHtmlEngine.exe", "56520 72656 CEPHtmlEngine.exe", "72656 26612 AfterFX.exe", "26612 24584 dynamiclinkmanager.exe"].join("\r\n");
// The After Effects on screen, started from Explorer.
const ONSCREEN_WIN = ["11204 5312 CEPHtmlEngine.exe", "5312 59548 CEPHtmlEngine.exe", "59548 15288 AfterFX.exe", "15288 15236 explorer.exe"].join("\r\n");
// macOS, as `ps -A -o pid=,ppid=,comm=` prints it (full paths with spaces). Not seen live yet.
const MAC = [
  "    1     0 /sbin/launchd",
  "  700     1 /Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026",
  "  710   700 /Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS/dynamiclinkmanager",
  "  800   710 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
  "  810   800 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine",
  "  820   810 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/CEPHtmlEngine.app/Contents/Frameworks/CEPHtmlEngine Helper (Renderer).app/Contents/MacOS/CEPHtmlEngine Helper (Renderer)",
  "  900     1 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
  "  910   900 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine",
  "  920   910 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/Frameworks/CEPHtmlEngine.app/Contents/Frameworks/CEPHtmlEngine Helper (Renderer).app/Contents/MacOS/CEPHtmlEngine Helper (Renderer)",
].join("\n");

describe("Dynamic Link guard: pure decision", () => {
  it("spots the hidden copy Premiere started, from its CEP engine up", () => {
    const v = common.decideDynamicLink(rows(HIDDEN_WIN), 45240);
    expect(v.dynamicLink).toBe(true);
    expect(v.reason).toContain("AfterFX.exe pid 72656 was started by dynamiclinkmanager.exe pid 26612");
  });

  it("lets the After Effects started from Explorer through", () => {
    const v = common.decideDynamicLink(rows(ONSCREEN_WIN), 11204);
    expect(v).toMatchObject({ dynamicLink: false });
    expect(v.reason).toContain("AfterFX.exe pid 59548 was started by explorer.exe pid 15288");
  });

  it("reads macOS ps rows with paths and spaces", () => {
    expect(common.decideDynamicLink(rows(MAC), 820).dynamicLink).toBe(true);
    const own = common.decideDynamicLink(rows(MAC), 920);
    expect(own.dynamicLink).toBe(false);
    expect(own.reason).toContain("After Effects pid 900 was started by launchd pid 1");
  });

  it("is not Dynamic Link when no After Effects is above, the parent has exited, or the table is empty", () => {
    expect(common.decideDynamicLink(rows("10 5 node.exe\n5 1 explorer.exe"), 10)).toMatchObject({ dynamicLink: false, reason: "no After Effects process found above pid 10" });
    expect(common.decideDynamicLink(rows("10 9 CEPHtmlEngine.exe\n9 8 AfterFX.exe"), 10).reason).toContain("started by an exited process pid 8");
    expect(common.decideDynamicLink([], 10).dynamicLink).toBe(false);
  });

  it("stops on a loop in the table instead of spinning", () => {
    expect(common.decideDynamicLink(rows("10 11 a.exe\n11 10 b.exe"), 10).dynamicLink).toBe(false);
    expect(common.decideDynamicLink(rows("10 10 a.exe"), 10).dynamicLink).toBe(false);
  });

  it("matches process names exactly, not by substring", () => {
    expect(common.isAeProcessName("AfterFX.exe")).toBe(true);
    expect(common.isAeProcessName("C:\\x\\AfterFX.exe")).toBe(true);
    expect(common.isAeProcessName("AfterFX.com")).toBe(false); // aerender's engine: the render-engine guard's job
    expect(common.isAeProcessName("After Effects Render Engine")).toBe(false);
    expect(common.isDynamicLinkParentName("dynamiclinkmanager.exe")).toBe(true);
    expect(common.isDynamicLinkParentName("/Applications/x/dynamiclinkmanager")).toBe(true);
    expect(common.isDynamicLinkParentName("Adobe Premiere Pro.exe")).toBe(false);
  });

  it("fails open when the process table cannot be read", async () => {
    const v = await new Promise<any>((r) => common.checkDynamicLinkLaunch(10, r, (_pid: number, cb: any) => cb(new Error("spawn EACCES"), "")));
    expect(v).toMatchObject({ dynamicLink: false, error: "spawn EACCES" });
  });
});

describe("Dynamic Link guard: reading this machine's processes", () => {
  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "walks up from this test's own process and finds it is not After Effects",
    async () => {
      const text = await new Promise<string>((resolve, reject) =>
        common.readProcessChain(process.pid, (err: Error | null, out: string) => (err ? reject(err) : resolve(out)))
      );
      const table = rows(text);
      const own = table.find((r) => r.pid === process.pid);
      expect(own).toBeDefined();
      expect(own!.ppid).toBe(process.ppid);
      expect(common.decideDynamicLink(table, process.pid).dynamicLink).toBe(false);
    },
    20000
  );
});

// ---- service.js boot with a fake CSInterface inside "CEP" (window.__adobe_cep__) ----

type Cb = (raw: string) => void;

describe("Dynamic Link guard: service boot", () => {
  let root = "";
  let extDir = "";
  let started: Array<{ shutdown: () => void }> = [];
  let calls: Array<{ script: string; cb: Cb }> = [];
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["LOCALAPPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_FORCE_START"];
  const g = globalThis as Record<string, any>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-dl-"));
    extDir = path.join(root, "ext");
    fs.mkdirSync(path.join(extDir, "client"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "host"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "host", "core.jsx"), "// fake");
    fs.writeFileSync(
      path.join(extDir, "client", "mcp-bundle.cjs"),
      "module.exports = { createPanelMcp: function () { return { handleHttp: function () {}, stop: function () {}, renderLock: function () { return null; } }; } };"
    );
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.LOCALAPPDATA = root;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.CHROMA_AE_MCP_FORCE_START;
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
    delete require.cache[servicePath];
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stateDir = () =>
    process.platform === "win32"
      ? path.join(root, "chroma-ae-mcp")
      : process.platform === "darwin"
        ? path.join(root, "Library", "Application Support", "chroma-ae-mcp")
        : path.join(root, ".chroma-ae-mcp");
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
  const portFree = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });

  /** Boots service.js as CEP would; `chain` is what the process lookup answers (or an Error). */
  function boot(port: number, chain: string | Error, opts: { cep?: boolean } = {}) {
    process.env.CHROMA_AE_MCP_PORT = String(port);
    const lookups: number[] = [];
    class FakeCSInterface {
      evalScript(script: string, cb: Cb): void {
        calls.push({ script, cb });
      }
      getSystemPath(which: string): string {
        if (which === "hostApplication") return "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files";
        return "file:///" + extDir.split(path.sep).join("/");
      }
      getHostEnvironment() {
        return { appName: "AEFT", appVersion: "26.0" };
      }
    }
    const stubbed = {
      ...common,
      checkDynamicLinkLaunch: (_pid: number, cb: (v: unknown) => void) => {
        lookups.push(_pid);
        // The real decision on a fake table: walk from the hidden copy's engine pid.
        common.checkDynamicLinkLaunch(45240, cb, (_p: number, done: (e: Error | null, t: string) => void) =>
          setTimeout(() => (chain instanceof Error ? done(chain, "") : done(null, chain)), 20)
        );
      },
    };
    g.window = {
      CSInterface: FakeCSInterface,
      SystemPath: { EXTENSION: "extension", HOST_APPLICATION: "hostApplication" },
      ChromaAeCommon: stubbed,
      addEventListener: () => {},
      ...(opts.cep === false ? {} : { __adobe_cep__: {} }),
    };
    delete require.cache[servicePath];
    started.push(require(servicePath));
    return { lookups };
  }

  it("the hidden copy stops before the token, the host files and the port", async () => {
    const port = 47951;
    const { lookups } = boot(port, HIDDEN_WIN);
    await until(() => calls.length >= 1);
    expect(lookups).toEqual([process.pid]);
    calls[0].cb("chroma-guard:interactive"); // a Dynamic Link copy says it is not a render engine
    await until(() => readLog().includes("Dynamic Link copy of After Effects"));
    expect(readLog()).toContain("AfterFX.exe pid 72656 was started by dynamiclinkmanager.exe pid 26612");
    expect(readLog()).toContain("Chroma AE MCP service not started");
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(1); // no core.jsx boot
    expect(fs.existsSync(path.join(stateDir(), "token"))).toBe(false);
    expect(readLog()).not.toContain("Listening on");
    expect(await portFree(port)).toBe(true);
  });

  it("the After Effects on screen starts as before", async () => {
    const port = 47952;
    boot(port, ONSCREEN_WIN);
    await until(() => calls.length >= 1);
    calls[0].cb("chroma-guard:interactive");
    await until(() => calls.length >= 2);
    calls[1].cb("26.0|ok");
    await until(() => readLog().includes("Listening on"));
    expect(readLog()).not.toContain("Dynamic Link");
  });

  it("starts, and says so, when the lookup fails", async () => {
    const port = 47953;
    boot(port, new Error("powershell timed out"));
    await until(() => calls.length >= 1);
    calls[0].cb("chroma-guard:interactive");
    await until(() => calls.length >= 2);
    calls[1].cb("26.0|ok");
    await until(() => readLog().includes("Listening on"));
    expect(readLog()).toContain("Dynamic Link check could not run (powershell timed out); starting");
  });

  it("is skipped outside CEP and with CHROMA_AE_MCP_FORCE_START=1", async () => {
    const outside = boot(47954, HIDDEN_WIN, { cep: false });
    await until(() => calls.length >= 1);
    calls[0].cb("chroma-guard:interactive");
    await until(() => calls.length >= 2);
    calls[1].cb("26.0|ok");
    await until(() => readLog().includes("Listening on"));
    expect(outside.lookups).toEqual([]);
    started.splice(0).forEach((s) => s.shutdown());
    calls = [];

    process.env.CHROMA_AE_MCP_FORCE_START = "1";
    const forced = boot(47955, HIDDEN_WIN);
    await until(() => calls.length >= 1);
    calls[0].cb("26.0|ok"); // forced: no probe, straight to the core.jsx boot
    await until(() => readLog().split("Listening on").length === 3);
    expect(forced.lookups).toEqual([]);
  });
});
