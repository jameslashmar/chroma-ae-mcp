import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { inventoryTools } from "../src/tools/ext/inventory.js";
import { AeGetCompSchema, AeGetProjectSchema, readTools } from "../src/tools/read.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string) => unknown) {
  const scripts: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inv-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      scripts.push(script);
      return { ok: true, result: answer(script.slice("__chromaAe.".length, script.indexOf("("))), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, scripts };
}

describe("inventory tools", () => {
  it("are registered", () => {
    for (const name of ["ae_comp_tree", "ae_fonts"]) expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
  });

  it("ae_fonts can list only the missing fonts", async () => {
    const { ctx } = fakeAe(() => ({ fonts: [{ font: "A", missing: false }, { font: "B", missing: true }, { font: "C", missing: null }], missing: ["B"] }));
    const out = await inventoryTools.find((t) => t.name === "ae_fonts")!.handler({ missing_only: true }, ctx);
    expect(out.fonts.map((f: { font: string }) => f.font)).toEqual(["B"]);
  });

  it("ae_comp_tree passes the comp and depth through", async () => {
    const { ctx, scripts } = fakeAe(() => ({ comp: { id: 5 } }));
    await inventoryTools.find((t) => t.name === "ae_comp_tree")!.handler({ comp_id: 5, depth: 3 }, ctx);
    expect(scripts[0]).toContain('compTree({"comp_id":5,"depth":3})');
  });
});

describe("paged reads", () => {
  it("ae_get_project walks every level when filtering, unless a depth is given", async () => {
    const { ctx, scripts } = fakeAe(() => ({ items: [] }));
    const tool = readTools.find((t) => t.name === "ae_get_project")!;
    await tool.handler(AeGetProjectSchema.parse({ type: "footage", sort: "name", limit: 50 }), ctx);
    expect(scripts[0]).toContain('"depth":20');
    expect(scripts[0]).toContain('"type":"footage"');
    expect(scripts[0]).toContain('"sort":"name"');
    await tool.handler(AeGetProjectSchema.parse({}), ctx);
    expect(scripts[1]).toContain('getProject({"depth":3})');
  });

  it("ae_get_comp passes paging and the name filter", async () => {
    const { ctx, scripts } = fakeAe(() => ({ layers: [] }));
    await readTools.find((t) => t.name === "ae_get_comp")!.handler(AeGetCompSchema.parse({ comp_id: 1, offset: 500, limit: 100, name_contains: "bg" }), ctx);
    expect(scripts[0]).toContain('"name_contains":"bg","offset":500,"limit":100');
    expect(AeGetCompSchema.safeParse({ comp_id: 1, limit: 501 }).success).toBe(false);
  });
});
