import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve(__dirname, "../../panel/tools/relay-diagnose.cjs");
const diag = require(SCRIPT) as {
  diagnose: (o?: Record<string, unknown>) => Promise<any>;
  gather: (o?: Record<string, unknown>) => Promise<any>;
  decide: (f: any) => { code: string; ok: boolean; message: string; fix: string[]; facts_summary: string[] };
  formatReport: (r: any) => string;
  resetCache: () => void;
  parseWindowsProcesses: (s: string) => any[] | null;
  parseMacProcesses: (s: string) => any[];
  aeLabelFromPath: (p: string) => string | null;
};

const TOKEN = "a".repeat(64);
const tmpDirs: string[] = [];
const servers: http.Server[] = [];

beforeEach(() => diag.resetCache());
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function proc(label: string, pid: number, extra: Record<string, unknown> = {}) {
  const major = /^\d{4}$/.test(label) ? Number(label) - 2000 : null;
  return {
    pid,
    path: `C:\\Program Files\\Adobe\\Adobe After Effects ${label === "Beta" ? "(Beta)" : label}\\Support Files\\AfterFX.exe`,
    label,
    major,
    started_at: "2026-11-06T20:33:51.000Z",
    engine: false,
    ...extra,
  };
}

/** Facts for a healthy machine; each test changes what it needs. */
function facts(over: Record<string, unknown> = {}) {
  return {
    now: 1_000_000_000,
    platform: "win32",
    port: 7790,
    quick: false,
    state_dir: "C:\\data\\chroma-ae-mcp",
    token: { present: true, valid: true },
    owner: { present: false },
    health: { status: null, error: "ECONNREFUSED", json: false, chroma: false, instance: null },
    processes: { interactive: [proc("2026", 18420)], engines: [] },
    installed: ["2024", "2025", "2026", "Beta"],
    panel: { installed: true, dir: "C:\\ext\\london.chroma.aemcp", version: "0.6.0" },
    debug_mode: { "11": false, "12": true, "13": true },
    port_holder: null,
    probes_failed: [],
    ...over,
  };
}

const chromaHealth = (over: Record<string, unknown> = {}) => ({
  status: 200,
  error: null,
  json: true,
  chroma: true,
  instance: { pid: 9120, ae_label: "2025", host_path: "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files", started_at: "2026-11-06T20:42:16.000Z" },
  ae_version: "25.2",
  busy: false,
  in_flight: null,
  ...over,
});

describe("decide: one case per code, each message carries its fix", () => {
  const cases: Array<{ code: string; facts: Record<string, unknown>; says: RegExp; fixSays: RegExp }> = [
    {
      code: "ok",
      facts: { health: chromaHealth(), processes: { interactive: [proc("2025", 9120)], engines: [] } },
      says: /connected to After Effects 2025/,
      fixSays: /^$/,
    },
    {
      code: "no_token",
      facts: { token: { present: false, valid: false }, health: { status: null, error: "ECONNREFUSED" } },
      says: /never started on this machine/,
      fixSays: /open Window > Extensions > Chroma AE MCP once/,
    },
    {
      code: "panel_not_installed",
      facts: { panel: { installed: false, dir: "C:\\Users\\x\\AppData\\Roaming\\Adobe\\CEP\\extensions\\london.chroma.aemcp", version: null } },
      says: /panel is not installed/,
      fixSays: /install-dev\.ps1/,
    },
    {
      code: "ae_not_running",
      facts: { processes: { interactive: [], engines: [proc("2026", 77, { engine: true })] } },
      says: /After Effects is not running \(installed: 2024, 2025, 2026, Beta; supported: 2025 and newer\)/,
      fixSays: /Start After Effects 2025 or newer/,
    },
    {
      code: "only_unsupported_ae",
      facts: { processes: { interactive: [proc("2024", 4040)], engines: [] } },
      says: /After Effects 2024 \(pid 4040\) is running, but the panel needs After Effects 2025 or newer/,
      fixSays: /2025, 2026 or Beta/,
    },
    {
      code: "debug_mode_off",
      facts: { debug_mode: { "11": false, "12": false, "13": false }, panel: { installed: true, dir: "x", version: "0.6.0", signed: false } },
      says: /unsigned panels are blocked/,
      fixSays: /PlayerDebugMode=1/,
    },
    {
      code: "service_down",
      facts: {},
      says: /After Effects 2026 \(pid 18420\) is running, but the service is not listening on 127\.0\.0\.1:7790\. \(CSXS\.12 PlayerDebugMode is set\.\)/,
      fixSays: /Open Window > Extensions > Chroma AE MCP once/,
    },
    {
      code: "port_other_program",
      facts: { health: { status: 404, error: null, json: false, chroma: false, instance: null }, port_holder: { pid: 555, name: "nginx" } },
      says: /127\.0\.0\.1:7790 is used by nginx \(pid 555\)/,
      fixSays: /CHROMA_AE_MCP_PORT/,
    },
    {
      code: "token_rejected",
      facts: { health: { status: 401, error: null, json: true, chroma: false, auth_error: true, instance: null } },
      says: /rejected the token/,
      fixSays: /Regenerate the token/,
    },
    {
      code: "other_ae_holds_port",
      facts: {
        health: chromaHealth(),
        processes: { interactive: [proc("2026", 18420), proc("2025", 9120)], engines: [] },
      },
      says: /held by After Effects 2025 \(pid 9120, since \d\d:\d\d\)\. After Effects 2026 \(pid 18420\) is also running and cannot serve MCP\./,
      fixSays: /Close one/,
    },
    {
      code: "service_busy",
      facts: {
        health: chromaHealth({ busy: true, in_flight: { label: "ae_export_mogrt", started_at: 1_000_000_000 - 40 * 60_000 } }),
        processes: { interactive: [proc("2025", 9120)], engines: [] },
      },
      says: /busy for 40 min with "ae_export_mogrt"/,
      fixSays: /ae_status/,
    },
  ];

  for (const c of cases) {
    it(c.code, () => {
      const res = diag.decide(facts(c.facts));
      expect(res.code).toBe(c.code);
      expect(res.ok).toBe(c.code === "ok");
      expect(res.message).toMatch(c.says);
      expect(res.fix.join(" ")).toMatch(c.fixSays);
      expect(res.facts_summary.length).toBeGreaterThan(0);
    });
  }

  it("covers every code the spec lists", () => {
    expect(cases.map((c) => c.code).sort()).toEqual(
      [
        "ae_not_running",
        "debug_mode_off",
        "no_token",
        "ok",
        "only_unsupported_ae",
        "other_ae_holds_port",
        "panel_not_installed",
        "port_other_program",
        "service_busy",
        "service_down",
        "token_rejected",
      ].sort()
    );
  });

  it("a render engine is not the user's After Effects", () => {
    const res = diag.decide(facts({ processes: { interactive: [], engines: [proc("2026", 77, { engine: true })] } }));
    expect(res.code).toBe("ae_not_running");
    expect(res.facts_summary.join("\n")).toContain("render engines (not counted)");
  });

  it("a running service that is not busy for long is ok even with a busy flag", () => {
    const res = diag.decide(
      facts({ health: chromaHealth({ busy: true, in_flight: { label: "x", started_at: 1_000_000_000 - 5_000 } }), processes: { interactive: [proc("2025", 9120)], engines: [] } })
    );
    expect(res.code).toBe("ok");
  });

  it("a stale owner file (pid gone, or old) is not 'starting'", () => {
    expect(diag.decide(facts({ owner: { present: true, instance: { pid: 1 }, pid_alive: false, age_ms: 5_000 } })).code).toBe("service_down");
    expect(diag.decide(facts({ owner: { present: true, instance: { pid: 1 }, pid_alive: true, age_ms: 5 * 60_000 } })).code).toBe("service_down");
  });

  it("without a process list (quick mode) a closed port is service_down, never 'not running'", () => {
    expect(diag.decide(facts({ processes: null, quick: true })).code).toBe("service_down");
  });

  it("formatReport shows the message, the fix and what was found", () => {
    const text = diag.formatReport(diag.decide(facts()));
    expect(text).toContain("Problem: service_down");
    expect(text).toContain("What to do:");
    expect(text).toContain("What was found:");
    expect(text).toContain("After Effects running: After Effects 2026 (pid 18420)");
  });
});

describe("process lists", () => {
  it("parses one object or an array from PowerShell, and spots a render engine by its command line", () => {
    const one = JSON.stringify({
      ProcessId: 18420,
      ExecutablePath: "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe",
      CommandLine: '"C:\\...\\AfterFX.exe"',
      Started: "2026-11-06T20:33:51.0000000+01:00",
    });
    const [a] = diag.parseWindowsProcesses(one)!;
    expect(a).toMatchObject({ pid: 18420, label: "2026", major: 26, engine: false });
    const two = JSON.stringify([
      { ProcessId: 1, ExecutablePath: "C:\\Program Files\\Adobe\\Adobe After Effects (Beta)\\Support Files\\AfterFX.exe", CommandLine: "AfterFX.exe" },
      { ProcessId: 2, ExecutablePath: "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe", CommandLine: "AfterFX.exe -noui -s x" },
    ]);
    const list = diag.parseWindowsProcesses(two)!;
    expect(list[0]).toMatchObject({ label: "Beta", major: null, engine: false });
    expect(list[1]).toMatchObject({ label: "2025", engine: true });
    expect(diag.parseWindowsProcesses("")).toEqual([]);
    expect(diag.parseWindowsProcesses("not json")).toBeNull();
  });

  it("parses ps output on macOS", () => {
    const line =
      "  4242 Fri Nov  6 20:33:51 2026 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects\n  1 Mon Jan  1 00:00:00 2026 /sbin/launchd";
    const list = diag.parseMacProcesses(line);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pid: 4242, label: "2026", engine: false });
  });

  it("reads the label from a path", () => {
    expect(diag.aeLabelFromPath("C:\\Program Files\\Adobe\\Adobe After Effects 2025\\x")).toBe("2025");
    expect(diag.aeLabelFromPath("/Applications/Adobe After Effects (Beta)/x")).toBe("Beta");
    expect(diag.aeLabelFromPath("C:\\other\\x")).toBeNull();
  });
});

describe("gather with injected probes (no process is started, no socket opened)", () => {
  function emptyHome() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-diag-"));
    tmpDirs.push(dir);
    return dir;
  }
  const noExec = async () => {
    throw new Error("no process may be started in quick mode");
  };

  it("never puts the token in a fact, and sends it to /health only", async () => {
    const dir = emptyHome();
    fs.writeFileSync(path.join(dir, "token"), TOKEN);
    const sent: Array<{ port: number; token: string }> = [];
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      quick: true,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir },
      exec: noExec,
      httpGet: async (port: number, token: string) => {
        sent.push({ port, token });
        return { status: 200, text: JSON.stringify({ ok: true, startedBy: "service", aeVersion: "26.0", instance: { pid: 5, ae_label: "2026" } }) };
      },
    });
    expect(sent).toEqual([{ port: 7790, token: TOKEN }]);
    expect(JSON.stringify(f)).not.toContain(TOKEN);
    expect(f.token).toEqual({ present: true, valid: true });
    expect(f.health).toMatchObject({ status: 200, chroma: true, instance: { pid: 5, ae_label: "2026" } });
    expect(f.processes).toBeNull();
  });

  it("reads AE processes, PlayerDebugMode and the port holder through the injected exec", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const dir = emptyHome();
    const exec = async (file: string, args: string[]) => {
      if (process.platform === "win32") {
        if (/powershell/i.test(file) && args.join(" ").includes("Win32_Process")) {
          return {
            stdout: JSON.stringify([
              { ProcessId: 18420, ExecutablePath: "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe", CommandLine: "AfterFX.exe" },
            ]),
          };
        }
        if (/reg\.exe$/i.test(file)) {
          if (args.join(" ").includes("CSXS.11")) throw Object.assign(new Error("not found"), { code: 1 });
          return { stdout: "    PlayerDebugMode    REG_SZ    1\r\n" };
        }
        if (/netstat\.exe$/i.test(file)) return { stdout: "  TCP    127.0.0.1:7790    0.0.0.0:0    LISTENING    555\r\n" };
        if (/powershell/i.test(file)) return { stdout: "nginx\r\n" };
      } else {
        if (file === "/bin/ps") return { stdout: "  4242 Fri Nov  6 20:33:51 2026 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects\n" };
        if (file === "/usr/bin/defaults") {
          if (args.join(" ").includes("CSXS.11")) throw Object.assign(new Error("does not exist"), { code: 1 });
          return { stdout: "1\n" };
        }
        if (file === "/usr/sbin/lsof") return { stdout: "p555\ncnginx\n" };
      }
      throw new Error("unexpected " + file);
    };
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir },
      exec,
      httpGet: async () => ({ status: 404, text: "<html>" }),
    });
    expect(f.processes.interactive).toHaveLength(1);
    expect(f.processes.interactive[0].label).toBe("2026");
    expect(f.debug_mode).toEqual({ "11": false, "12": true, "13": true });
    expect(f.port_holder).toMatchObject({ pid: 555, name: "nginx" });
    expect(diag.decide(f).code).toBe("port_other_program");
  });

  it("a probe that throws gives a degraded result, never an exception", async () => {
    const dir = emptyHome();
    fs.writeFileSync(path.join(dir, "token"), TOKEN);
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir },
      exec: async () => {
        throw new Error("powershell is blocked");
      },
      httpGet: async () => {
        throw new Error("socket exploded");
      },
    });
    expect(f.health).toBeNull();
    expect(f.probes_failed.join(" ")).toContain("socket exploded");
    expect(() => diag.decide(f)).not.toThrow();
    expect(diag.decide(f).ok).toBe(false);
  });

  it("diagnose is cached for 15 s: a second call runs no probe", async () => {
    const dir = emptyHome();
    let gets = 0;
    const opts = {
      dataDir: dir,
      port: 7790,
      quick: true,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir },
      exec: noExec,
      httpGet: async () => {
        gets++;
        return { error: "ECONNREFUSED" };
      },
    };
    const a = await diag.diagnose(opts);
    const b = await diag.diagnose(opts);
    expect(gets).toBe(1);
    expect(b).toBe(a);
    await diag.diagnose({ ...opts, fresh: true });
    expect(gets).toBe(2);
  });

  it("reads owner.json (who wrote it, whether that process lives); a closed port with it is still service_down", async () => {
    const dir = emptyHome();
    fs.writeFileSync(path.join(dir, "token"), TOKEN);
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ instance: { pid: process.pid, ae_label: "2026" }, written_at: new Date().toISOString() }));
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      quick: true,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir },
      exec: noExec,
      httpGet: async () => ({ error: "ECONNREFUSED" }),
    });
    expect(f.owner).toMatchObject({ present: true, pid_alive: true });
    expect(diag.decide({ ...f, panel: { installed: true } }).code).toBe("service_down");
  });

  // ---------- repair round ----------

  const NO_ENV = (dir: string) => ({ APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir });

  it("a signed package with AE running and the service down is service_down, never 'run the dev script'", () => {
    const base = { debug_mode: { "11": false, "12": false, "13": false } };
    const signed = diag.decide(facts({ ...base, panel: { installed: true, dir: "x", version: "0.6.0", signed: true } }));
    expect(signed.code).toBe("service_down");
    expect(JSON.stringify(signed)).not.toContain("install-dev");
    // A signed install does not need PlayerDebugMode: the fix must not send the user to it.
    expect(signed.fix.join(" ") + signed.message).not.toContain("PlayerDebugMode");
    expect(diag.decide(facts({ ...base, panel: { installed: true, dir: "x", version: "0.6.0", signed: null } })).fix.join(" ")).toContain("PlayerDebugMode");
    // Unknown: the check does not claim the debug flag is the cause.
    expect(diag.decide(facts({ ...base, panel: { installed: true, dir: "x", version: "0.6.0", signed: null } })).code).toBe("service_down");
    expect(diag.decide(facts({ ...base, panel: { installed: true, dir: "x", version: "0.6.0", signed: false } })).code).toBe("debug_mode_off");
  });

  it("tells a signed install from a development one by the package signature, the junction and the .debug file", async () => {
    const dir = emptyHome();
    const ext = path.join(dir, "Adobe", "CEP", "extensions", "london.chroma.aemcp");
    const run = async () =>
      (await diag.gather({ dataDir: dir, port: 7790, quick: true, env: NO_ENV(dir), exec: noExec, httpGet: async () => ({ error: "ECONNREFUSED" }) })).panel;
    if (process.platform !== "win32") {
      // The CEP folder differs per platform; the check below needs the Windows layout.
      return;
    }
    fs.mkdirSync(path.join(ext, "META-INF"), { recursive: true });
    fs.writeFileSync(path.join(ext, "META-INF", "signatures.xml"), "<x/>");
    expect(await run()).toMatchObject({ installed: true, signed: true });
    fs.rmSync(path.join(ext, "META-INF"), { recursive: true });
    expect(await run()).toMatchObject({ installed: true, signed: null });
    fs.writeFileSync(path.join(ext, ".debug"), "x");
    expect(await run()).toMatchObject({ signed: false });
    fs.rmSync(ext, { recursive: true });
    const target = path.join(dir, "repo-panel");
    fs.mkdirSync(target);
    fs.symlinkSync(target, ext, "junction");
    expect(await run()).toMatchObject({ signed: false });
  });

  it("a 401 that is not the service's auth error is another program, not token_rejected", () => {
    const other = diag.decide(facts({ health: { status: 401, error: null, json: false, chroma: false, auth_error: false, instance: null }, port_holder: { pid: 9, name: "proxy" } }));
    expect(other.code).toBe("port_other_program");
    const ours = diag.decide(facts({ health: { status: 401, error: null, json: true, chroma: false, auth_error: true, instance: null } }));
    expect(ours.code).toBe("token_rejected");
  });

  it("summarises the 401 body the way service.js sends it", async () => {
    const dir = emptyHome();
    const get = (text: string) => diag.gather({ dataDir: dir, port: 7790, quick: true, env: NO_ENV(dir), exec: noExec, httpGet: async () => ({ status: 401, text }) });
    expect((await get(JSON.stringify({ ok: false, error: { kind: "auth", message: "Missing or invalid Bearer token" } }))).health.auth_error).toBe(true);
    expect((await get("<html>Unauthorized</html>")).health.auth_error).toBe(false);
    expect((await get(JSON.stringify({ error: { kind: "other" } }))).health.auth_error).toBe(false);
  });

  it("no answer on the port but a program holding it is port_other_program", () => {
    const res = diag.decide(facts({ port_holder: { pid: 555, name: "nginx" } }));
    expect(res.code).toBe("port_other_program");
    expect(res.message).toContain("nginx (pid 555)");
  });

  it("starts only programs given by absolute path under the system folder", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const dir = emptyHome();
    const seen: string[] = [];
    await diag.gather({
      dataDir: dir,
      port: 7790,
      env: NO_ENV(dir),
      exec: async (file: string) => {
        seen.push(file);
        throw Object.assign(new Error("x"), { code: 1 });
      },
      httpGet: async () => ({ status: 404, text: "x" }),
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) expect(path.isAbsolute(f), f).toBe(true);
    if (process.platform === "win32") {
      const root = (process.env.SystemRoot || process.env.windir || "C:\\Windows").toLowerCase();
      for (const f of seen) expect(f.toLowerCase().startsWith(path.join(root, "system32").toLowerCase()), f).toBe(true);
    }
  });

  it("looks in both Common Files folders for a system-wide install", async () => {
    if (process.platform !== "win32") return;
    const dir = emptyHome();
    const x86 = path.join(dir, "x86");
    const x64 = path.join(dir, "x64");
    fs.mkdirSync(path.join(x64, "Adobe", "CEP", "extensions", "london.chroma.aemcp"), { recursive: true });
    fs.mkdirSync(x86, { recursive: true });
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      quick: true,
      env: { APPDATA: dir, LOCALAPPDATA: dir, "CommonProgramFiles(x86)": x86, CommonProgramFiles: x64 },
      exec: noExec,
      httpGet: async () => ({ error: "ECONNREFUSED" }),
    });
    expect(f.panel.installed).toBe(true);
    expect(f.panel.dir).toContain("x64");
  });

  it("a probe that runs past the budget costs only itself: the facts already gathered stay", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const dir = emptyHome();
    fs.writeFileSync(path.join(dir, "token"), TOKEN);
    const f = await diag.gather({
      dataDir: dir,
      port: 7790,
      budgetMs: 150,
      env: NO_ENV(dir),
      exec: () => new Promise(() => {}), // the process list never comes back
      httpGet: async () => ({ status: 200, text: JSON.stringify({ ok: true, startedBy: "service", aeVersion: "26.0", instance: { pid: 5, ae_label: "2026" } }) }),
    });
    expect(f.health).toMatchObject({ chroma: true });
    expect(f.token).toEqual({ present: true, valid: true });
    expect(f.panel).not.toBeNull();
    expect(f.probes_failed.join(" ")).toContain("timed out");
  });
});

describe("the command line", () => {
  async function closedPort(): Promise<number> {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
  }

  function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = childProcess.spawn(process.execPath, [SCRIPT, ...args], {
        env: { ...process.env, CHROMA_AE_MCP_DIAGNOSE: "quick", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  function home() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-diag-cli-"));
    tmpDirs.push(dir);
    const dataDir = process.platform === "win32" ? path.join(dir, "chroma-ae-mcp") : process.platform === "darwin" ? path.join(dir, "Library", "Application Support", "chroma-ae-mcp") : path.join(dir, ".chroma-ae-mcp");
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { LOCALAPPDATA: dir, APPDATA: dir, HOME: dir, USERPROFILE: dir, "CommonProgramFiles(x86)": dir, CommonProgramFiles: dir };
    return { dir, dataDir, env };
  }

  it("exits 2 and prints the report when something is wrong", async () => {
    const h = home();
    const res = await run({ ...h.env, CHROMA_AE_MCP_PORT: String(await closedPort()) });
    expect(res.code).toBe(2);
    expect(res.out).toContain("Problem: ");
    expect(res.out).toContain("What to do:");
  });

  it("--json prints the same decision as data, without the facts' token or the full facts", async () => {
    const h = home();
    const res = await run({ ...h.env, CHROMA_AE_MCP_PORT: String(await closedPort()) }, ["--json"]);
    const parsed = JSON.parse(res.out);
    expect(res.code).toBe(2);
    expect(parsed).toMatchObject({ ok: false });
    expect(typeof parsed.code).toBe("string");
    expect(parsed.facts).toBeUndefined();
  });

  it("exits 0 when the service answers and nothing is wrong", async () => {
    const h = home();
    fs.writeFileSync(path.join(h.dataDir, "token"), TOKEN);
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, startedBy: "service", aeVersion: "26.0", instance: { pid: 5, ae_label: "2026" } }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const res = await run({ ...h.env, CHROMA_AE_MCP_PORT: String(port) });
    expect(res.out).toContain("OK (ok)");
    expect(res.code).toBe(0);
    expect(seen).toEqual(["Bearer " + TOKEN]);
    expect(res.out).not.toContain(TOKEN);
  });
});
