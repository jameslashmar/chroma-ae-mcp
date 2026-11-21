import { describe, expect, it } from "vitest";
import { CEP_AUTOSTART_LIMIT, cepAutostartRefusal, createAerenderTools, resetCepAutostartCache } from "../src/tools/ext/aerender.js";

const OWN = { id: "london.chroma.aemcp.panel", folder: "chroma" };
const others = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `vendor.tool${i}.panel`, folder: `tool${i}` }));

describe("cepAutostartRefusal", () => {
  it("lets aerender start below the limit, with an empty list, and with the override", () => {
    expect(CEP_AUTOSTART_LIMIT).toBe(6);
    expect(cepAutostartRefusal("ae_aerender_start", false, [])).toBeNull();
    expect(cepAutostartRefusal("ae_aerender_start", false, [OWN, ...others(4)])).toBeNull();
    expect(cepAutostartRefusal("ae_aerender_start", true, [OWN, ...others(9)])).toBeNull();
  });

  it("refuses at 6, counting our own extension, and names the others but not ours", () => {
    const list = [OWN, ...others(5)];
    const r = cepAutostartRefusal("ae_aerender_start", undefined, list)!;
    expect(r).toMatchObject({ ok: false, error: "too_many_cep_extensions", applied: false, cep_autostart: list });
    expect(r.message).toContain("6 CEP extensions start by themselves");
    expect(r.message).toContain("ae_render_queue_render");
    expect(r.message).toContain("allow_many_cep_extensions: true");
    expect(r.message).toContain("vendor.tool4.panel");
    expect(r.message).not.toContain("london.chroma.aemcp");
  });

  it("shortens a long list", () => {
    const r = cepAutostartRefusal("ae_render_batch", false, others(14))!;
    expect(r.message).toContain("and 4 more");
    expect(r.message).not.toContain("vendor.tool10.panel");
  });
});

describe("ae_aerender_start with many auto-starting CEP extensions", () => {
  it("refuses before touching After Effects or spawning anything", async () => {
    resetCepAutostartCache([OWN, ...others(6)]);
    let spawned = 0;
    const tool = createAerenderTools({ spawn: (() => { spawned++; throw new Error("no spawn"); }) as never }).find((t) => t.name === "ae_aerender_start")!;
    const ctx = {
      quarantine: { assertClear: () => {} },
      bridge: { newOpId: () => "op1", evalRaw: async () => { throw new Error("no AE call expected"); } },
      queue: { run: async () => { throw new Error("no queue expected"); } },
      log: () => {},
    };
    const out = await tool.handler({ expect: { project_path: "C:/w/p.aep" }, comp_name: "Main", output_path: "C:/w/out.mov" }, ctx as never);
    expect(out).toMatchObject({ ok: false, error: "too_many_cep_extensions" });
    expect(spawned).toBe(0);
  });
});
