import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { panelsTools, resetPanelsTestOverrides, setPanelsTestOverrides } from "../src/tools/ext/panels.js";

const tool = (name: string) => panelsTools.find((t) => t.name === name)!;
const baseCtx = {} as unknown as ToolContext;

describe("ext/panels", () => {
  it("reports cep_unavailable without a CEP bridge", async () => {
    const res = (await tool("ae_list_panels").handler({}, baseCtx)) as { ok: boolean; error: string };
    expect(res).toMatchObject({ ok: false, error: "cep_unavailable" });
  });

  it("refuses a native panel without allow_toggle, before touching AE", async () => {
    let evalCalls = 0;
    const ctx = {
      cep: { listExtensions: () => [], openExtension: () => true },
      bridge: { evalRaw: async () => { evalCalls++; return { id: "x", ok: true, result: {}, durationMs: 1 }; } },
    } as unknown as ToolContext;
    const out = await tool("ae_open_panel")
      .handler({ name: "Effects & Presets" }, ctx)
      .then((r) => r as Record<string, unknown>, (e) => ({ thrown: String(e) }));
    expect(JSON.stringify(out)).toMatch(/allow_toggle/);
    expect(evalCalls).toBe(0);
  });

  it("opens a CEP extension directly", async () => {
    const opened: string[] = [];
    const ctx = {
      cep: {
        listExtensions: () => [{ id: "com.example.panel", name: "Example" }],
        openExtension: (id: string) => { opened.push(id); return true; },
      },
    } as unknown as ToolContext;
    await tool("ae_open_panel").handler({ extension_id: "com.example.panel" }, ctx);
    expect(opened).toEqual(["com.example.panel"]);
  });

  describe("ae_ui_screenshot", () => {
    afterEach(() => resetPanelsTestOverrides());

    it("asks for the window to be restored when AE is minimized, instead of returning a title-bar stub", async () => {
      setPanelsTestOverrides({
        platform: "win32",
        uiDir: os.tmpdir(),
        ps1Runner: async () => JSON.stringify({ ok: false, error: "ae_minimized" }),
      });
      const res = (await tool("ae_ui_screenshot").handler({}, baseCtx)) as Record<string, unknown>;
      expect(res).toMatchObject({ ok: false, error: "ae_minimized" });
      expect(String(res.message)).toMatch(/restore the AE window/);
    });

    it("passes a capture through", async () => {
      setPanelsTestOverrides({
        platform: "win32",
        uiDir: os.tmpdir(),
        ps1Runner: async () => JSON.stringify({ ok: true, path: "C:/ui/ae_main_1.png", width: 1920, height: 1040 }),
      });
      const res = await tool("ae_ui_screenshot").handler({}, baseCtx);
      expect(res).toEqual({ ok: true, path: "C:/ui/ae_main_1.png", width: 1920, height: 1040 });
    });
  });
});
