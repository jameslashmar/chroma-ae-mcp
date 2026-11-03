/**
 * Once a write's evalScript has returned, its change is in the project. A
 * read-back that fails after that (a timeout, a popup, a host error) must be
 * reported in the receipt, not thrown: a bare error makes the caller resend
 * the write. These tests make every read after the write fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { readAfterWrite } from "../src/tools/read-back.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A fake AE where every host call after the write fails. The write is the
 * first call carrying `expect` (reads never do); `writes` lists its result.
 */
function aeFailingAfterWrite(projectPath: string, writeResult: unknown = {}) {
  const calls: string[] = [];
  let written = false;
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-rb-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: projectPath, comp_id: 1, comp_is_valid: true, dirty: false }, durationMs: 1 };
      }
      if (written) return { ok: false, error: { message: "Read-back blew up", kind: "runtime" } };
      if (script.includes('"expect"')) {
        written = true;
        return { ok: true, result: writeResult, durationMs: 1 };
      }
      return { ok: true, result: { items: [], keyframes: [], effects: [], numItems: 0 }, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, wasWritten: () => written };
}

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

function expectAppliedWithReadBackFailure(out: any) {
  expect(out.applied).toBe(true);
  expect(typeof out.op_id).toBe("string");
  expect(out.receipt.matches).toBe(false);
  const rb = out.receipt.mismatches.find((m: { path: string }) => m.path === "read_back");
  expect(rb?.message).toMatch(/was applied.*Do not resend/);
  expect(rb?.message).toMatch(/Read-back blew up/);
}

const guard = { project_path: "<unsaved>" };
const layer = { name: "Ball" };

describe("readAfterWrite", () => {
  it("returns the value, or a mismatch instead of throwing", async () => {
    expect(await readAfterWrite("op1", async () => 5)).toEqual({ value: 5, failure: null });
    const bad = await readAfterWrite("op1", async () => {
      throw new Error("nope");
    });
    expect(bad.value).toBeNull();
    expect(bad.failure?.message).toMatch(/op op1.*nope/);
  });
});

describe("a failing read-back after an applied write is reported, not thrown", () => {
  const cases: Array<[string, Record<string, unknown>, unknown?]> = [
    ["ae_run_jsx", { code: "return 1;", mutates: true, label: "t", expect: guard }],
    ["ae_set_property", { comp_id: 1, layer, path: ["ADBE Transform Group", "ADBE Opacity"], value: 50, expect: guard }],
    ["ae_set_keyframe_ease", { comp_id: 1, layer, path: ["ADBE Transform Group", "ADBE Position"], ease: "easy_ease", expect: guard }],
    ["ae_set_text", { comp_id: 1, layer, text: "Hi", expect: guard }],
    ["ae_import_footage", { paths: ["C:/media/a.png"], expect: guard }, { item_ids: [42], items: [] }],
    ["ae_replace_footage", { item_id: 42, path: "C:/media/b.png", expect: guard }],
    ["ae_add_effect", { comp_id: 1, layer, effect: "ADBE Gaussian Blur 2", expect: guard }, { index: 1, name: "Gaussian Blur" }],
    ["ae_remove_effect", { comp_id: 1, layer, effect: { index: 1 }, expect: guard }],
    ["ae_render_queue_add", { comp_id: 1, output_path: "C:/renders/a.mov", expect: guard }, { index: 1 }],
    ["ae_create_layer", { comp_id: 1, type: "null", expect: guard }, { index: 1, id: 7 }],
  ];

  for (const [name, args, writeResult] of cases) {
    it(name, async () => {
      const t = tool(name);
      const { ctx, wasWritten } = aeFailingAfterWrite("<unsaved>", writeResult ?? {});
      const out = (await t.handler(t.schema.parse(args), ctx)) as any;
      expect(wasWritten()).toBe(true);
      expectAppliedWithReadBackFailure(out);
      if (name === "ae_import_footage") expect(out.item_ids).toEqual([42]);
    });
  }

  it("ae_save", async () => {
    const aep = path.join(tempDir("chroma-rb-save-"), "Job.aep");
    fs.writeFileSync(aep, "aep");
    const t = tool("ae_save");
    const { ctx, wasWritten } = aeFailingAfterWrite(aep);
    const out = (await t.handler(t.schema.parse({ expect: { project_path: aep } }), ctx)) as any;
    expect(wasWritten()).toBe(true);
    expectAppliedWithReadBackFailure(out);
    expect(out.backup_path).toBeTruthy();
  });
});
