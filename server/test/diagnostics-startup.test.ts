import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { writeDiagnostics } from "../src/tools/ext/diagnostics.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const TOKEN = "c".repeat(64);

function ctxFor(dataDir: string, host?: PanelHost): ToolContext {
  const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
  const queue = new SingleWriterQueue();
  const bridge = host ?? new PanelHost({ evalScript: () => new Promise(() => {}), queue, quarantine });
  return { bridge, queue, quarantine, dataDir, settings: new SettingsStore(path.join(dataDir, "settings.json")) };
}

const INSTANCE = { pid: 321, ae_label: "2026", ae_version: "26.0", host_path: "C:\\AE", port: 7790, started_at: "2026-11-06T20:33:51.000Z" };

describe("ae_diagnostics: the Startup section", () => {
  it("has the instance and the startup check, and the token is nowhere", async () => {
    const dataDir = tempDir("chroma-diag-start-");
    fs.writeFileSync(path.join(dataDir, "token"), TOKEN);
    const res = await writeDiagnostics(
      ctxFor(dataDir),
      {
        instance: INSTANCE,
        tokenPath: path.join(dataDir, "token"),
        logPath: path.join(dataDir, "service.log"),
      },
      {
        aeWaitMs: 20,
        includeDialogs: false,
        // The check's own text could carry the token if a probe leaked it: redaction must still hold.
        startupCheck: async () => ({
          code: "other_ae_holds_port",
          ok: false,
          message: `held by After Effects 2025 (Bearer ${TOKEN})`,
          fix: ["Close one."],
          facts_summary: ["service port: 127.0.0.1:7790"],
        }),
      }
    );
    const text = fs.readFileSync(res.path, "utf8");
    expect(text).toContain("## Startup");
    const section = text.slice(text.indexOf("## Startup"), text.indexOf("## After Effects"));
    expect(section).toContain('"ae_label": "2026"');
    expect(section).toContain('"code": "other_ae_holds_port"');
    expect(res.summary.startup_code).toBe("other_ae_holds_port");
    expect(text).not.toContain(TOKEN);
  });

  it("says what went wrong when the check fails or is slow, and still writes the file", async () => {
    const dataDir = tempDir("chroma-diag-start-");
    const failed = await writeDiagnostics(ctxFor(dataDir), { instance: INSTANCE }, {
      aeWaitMs: 20,
      includeDialogs: false,
      startupCheck: async () => {
        throw new Error("relay-diagnose.cjs was not found");
      },
    });
    expect(fs.readFileSync(failed.path, "utf8")).toContain("relay-diagnose.cjs was not found");
    expect(failed.summary.startup_code).toBeNull();
  });

  it("runs no check for a context without a service instance (the existing callers) and can be switched off", async () => {
    const dataDir = tempDir("chroma-diag-start-");
    const off = await writeDiagnostics(ctxFor(dataDir), { instance: INSTANCE }, { aeWaitMs: 20, includeDialogs: false, startupCheck: false });
    const offText = fs.readFileSync(off.path, "utf8");
    expect(offText).toContain("## Startup");
    expect(offText).not.toContain('"check"');
    expect(off.summary.startup_code).toBeNull();
    // No instance in the service info: nothing is run by default (no process, no socket).
    const none = await writeDiagnostics(ctxFor(dataDir), { panelVersion: "0.6.0" }, { aeWaitMs: 20, includeDialogs: false });
    expect(fs.readFileSync(none.path, "utf8")).not.toContain('"check"');
    expect(none.summary.startup_code).toBeNull();
  });

  it("by default loads panel/tools/relay-diagnose.cjs and runs it (quick mode, in an empty home)", async () => {
    const dataDir = tempDir("chroma-diag-start-");
    const home = tempDir("chroma-diag-home-");
    const keys = ["CHROMA_AE_MCP_DIAGNOSE", "APPDATA", "LOCALAPPDATA", "HOME", "USERPROFILE", "CommonProgramFiles(x86)", "CommonProgramFiles"];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    process.env.CHROMA_AE_MCP_DIAGNOSE = "quick";
    for (const k of keys.slice(1)) process.env[k] = home;
    try {
      const res = await writeDiagnostics(
        ctxFor(dataDir),
        { instance: INSTANCE, port: 1, tokenPath: path.join(dataDir, "token") },
        { aeWaitMs: 20, includeDialogs: false }
      );
      const text = fs.readFileSync(res.path, "utf8");
      // Port 1 answers nothing, and the temp home has no panel: a real decision came back.
      expect(res.summary.startup_code).toMatch(/^(panel_not_installed|no_token|service_down)$/);
      expect(text).toContain('"facts_summary"');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("ae_diagnostics while AE is busy", () => {
  it("does not queue a status eval behind a stuck AE, and reports ae_answered false with the busy reason", async () => {
    const dataDir = tempDir("chroma-diag-busy-");
    const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
    const queue = new SingleWriterQueue();
    let sent = 0;
    const serviceInfo = () => ({ inFlight: { id: "mcp_1", label: "ae_export_mogrt", runningMs: 36 * 60_000 }, evalQueueDepth: 0 });
    const host = new PanelHost({
      evalScript: () => {
        sent++;
        return new Promise(() => {});
      },
      queue,
      quarantine,
      serviceInfo,
      busyDialogs: async () => [],
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir, serviceInfo, settings: new SettingsStore(path.join(dataDir, "settings.json")) };
    const res = await writeDiagnostics(ctx, serviceInfo(), { aeWaitMs: 2000, includeDialogs: false, startupCheck: false });
    expect(sent).toBe(0);
    expect(res.summary.ae_answered).toBe(false);
    const text = fs.readFileSync(res.path, "utf8");
    expect(text).toContain("After Effects is busy");
    expect(text).toContain("ae_export_mogrt");
  });
});
