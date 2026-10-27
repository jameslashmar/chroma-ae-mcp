import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { panelsTools } from "../src/tools/ext/panels.js";

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
});
