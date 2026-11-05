import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeCreateCompSchema,
  AeProjectItemsSchema,
  copiedCompWarnings,
  createCompMismatches,
  findItemReferences,
  idsOfOps,
  newExpressionErrors,
  normaliseOps,
  opProblems,
  parseBgColor,
  projectItemsMismatches,
  projectitemsTools,
  referencesToRenamed,
  renamedReferenceWarnings,
  type CreatePlan,
  type ScanExpression,
} from "../src/tools/ext/projectitems.js";
import { FakeComp, FakeFolder, FakeFootage, FakeLayer, FakeProject, FileSource, GUARD, loadHost, SolidSource } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => projectitemsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-projectitems-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

// ---------- pure logic ----------

describe("parseBgColor", () => {
  it("reads hex and unit triples, and refuses anything else", () => {
    expect(parseBgColor("#ff8000")).toEqual([1, 0.501961, 0]);
    expect(parseBgColor("#f00")).toEqual([1, 0, 0]);
    expect(parseBgColor([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(parseBgColor([0.1, 2, 0.3])).toBeNull();
    expect(parseBgColor("red")).toBeNull();
    expect(parseBgColor("#12345")).toBeNull();
  });
});

describe("findItemReferences", () => {
  it("finds comp() and footage() names, quotes and thisProject receivers, and skips comments", () => {
    const text = 'a = comp("Intro").layer(1);\nb = thisProject.footage(\'Clip A\');\n// comp("Gone")\n/* footage("Old") */ c = "comp(\\"in string\\")"; mycomp("X")';
    expect(findItemReferences(text)).toEqual([
      { kind: "comp", name: "Intro" },
      { kind: "footage", name: "Clip A" },
    ]);
  });
});

const ex = (text: string, extra: Partial<ScanExpression> = {}): ScanExpression => ({
  comp_id: 5,
  comp_name: "Main copy",
  layer_id: 9,
  layer_index: 1,
  layer_name: "Pre",
  path: "Transform > Position",
  text,
  enabled: true,
  ...extra,
});

describe("copiedCompWarnings", () => {
  it("flags comp() references that still name an original, not ones naming other comps or disabled expressions", () => {
    const w = copiedCompWarnings(
      [ex('comp("Inner").layer(1).position'), ex('comp("Other").layer(1).position'), ex('comp("Inner").layer(1)', { enabled: false })],
      ["Main", "Inner"]
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "copied_comp_reference", reference: 'comp("Inner")', comp_id: 5 });
  });

  it("notes a cut expression as a partial scan", () => {
    const w = copiedCompWarnings([ex("x", { text_truncated: true })], ["Inner"]);
    expect(w.map((x) => x.kind)).toEqual(["partial_scan"]);
  });
});

describe("renamed references", () => {
  const renames = [{ kind: "comp" as const, from: "Intro", to: "Opener" }];
  it("counts expressions that read the old name", () => {
    expect(referencesToRenamed([ex('comp("Intro").layer(1)'), ex('comp("Opener")'), ex('footage("Intro")')], renames)).toHaveLength(1);
  });

  it("warns only when no item of that kind carries the old name any more", () => {
    const names = { comp: ["Opener", "Main"], footage: ["Intro"], truncated: false };
    const w = renamedReferenceWarnings([ex('comp("Intro").layer(1)'), ex('footage("Intro")')], renames, names);
    expect(w.map((x) => x.reference)).toEqual(['comp("Intro")']);
    // Another comp took the old name: the expression still evaluates.
    expect(renamedReferenceWarnings([ex('comp("Intro")')], renames, { comp: ["Intro"], footage: [], truncated: false })).toEqual([]);
  });

  it("judges nothing without the full name list", () => {
    expect(renamedReferenceWarnings([ex('comp("Intro")')], renames, { comp: [], footage: [], truncated: true })).toEqual([]);
    expect(renamedReferenceWarnings([ex('comp("Intro")')], renames, undefined)).toEqual([]);
  });
});

describe("newExpressionErrors", () => {
  const entry = (id: number, error: string) => ({ layer: { id, name: `L${id}` }, path: ["Position"], error });
  it("keeps the errors that appeared with the write", () => {
    const before = [{ comp_id: 1, results: [entry(1, "old problem")] }];
    const after = [{ comp_id: 1, comp_name: "A", results: [entry(1, "old problem"), entry(2, "comp not found")] }];
    expect(newExpressionErrors(before, after)).toEqual([{ comp_id: 1, comp_name: "A", errors: [{ layer: { id: 2, name: "L2" }, path: ["Position"], error: "comp not found" }] }]);
  });
});

// ---------- schemas ----------

describe("AeCreateCompSchema", () => {
  const base = { mode: "new", width: 1920, height: 1080, fps: 25, duration: 5, expect: expectArg };

  it("needs size, fps and a length for a new comp, in seconds or frames but not both", () => {
    expect(AeCreateCompSchema.safeParse(base).success).toBe(true);
    expect(AeCreateCompSchema.safeParse({ ...base, duration: undefined, duration_frames: 125 }).success).toBe(true);
    expect(AeCreateCompSchema.safeParse({ ...base, duration_frames: 125 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, duration: undefined }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, fps: undefined }).success).toBe(false);
  });

  it("range-checks size, fps, duration and pixel aspect", () => {
    expect(AeCreateCompSchema.safeParse({ ...base, width: 3 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, width: 30001 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, fps: 100 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, duration: 10801 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, pixel_aspect: 0.001 }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, bg_color: "nope" }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ ...base, bg_color: "#102030" }).success).toBe(true);
  });

  it("keeps each mode's fields to that mode", () => {
    expect(AeCreateCompSchema.safeParse({ mode: "from_footage", expect: expectArg }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ mode: "from_footage", item_id: 4, expect: expectArg }).success).toBe(true);
    expect(AeCreateCompSchema.safeParse({ mode: "duplicate", expect: expectArg }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ mode: "duplicate", comp_id: 4, width: 100, expect: expectArg }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ mode: "duplicate", comp_id: 4, max_comps: 10, expect: expectArg }).success).toBe(false);
    expect(AeCreateCompSchema.safeParse({ mode: "duplicate", comp_id: 4, deep: true, max_comps: 10, expect: expectArg }).success).toBe(true);
    expect(AeCreateCompSchema.safeParse({ ...base, comp_id: 4 }).success).toBe(false);
  });
});

describe("AeProjectItemsSchema", () => {
  it("takes one action with its fields, or a list of ops, not both", () => {
    expect(AeProjectItemsSchema.safeParse({ action: "create_folder", name: "A", expect: expectArg }).success).toBe(true);
    expect(AeProjectItemsSchema.safeParse({ expect: expectArg }).success).toBe(false);
    expect(AeProjectItemsSchema.safeParse({ ops: [{ action: "create_folder", name: "A" }], expect: expectArg }).success).toBe(true);
    expect(AeProjectItemsSchema.safeParse({ action: "create_folder", name: "A", ops: [{ action: "create_folder", name: "B" }], expect: expectArg }).success).toBe(false);
    expect(AeProjectItemsSchema.safeParse({ ops: [], expect: expectArg }).success).toBe(false);
  });

  it("checks each action's required and foreign fields, also inside ops", () => {
    const ok = (v: Record<string, unknown>) => AeProjectItemsSchema.safeParse({ ...v, expect: expectArg }).success;
    expect(ok({ action: "move", item_ids: [1] })).toBe(true);
    expect(ok({ action: "move" })).toBe(false);
    expect(ok({ action: "move", item_ids: [1], folder_id: 2, folder_path: "A/B" })).toBe(false);
    expect(ok({ action: "label", item_ids: [1], label: 17 })).toBe(false);
    expect(ok({ action: "label", item_ids: [1], label: 16 })).toBe(true);
    expect(ok({ action: "label", item_ids: [1] })).toBe(false);
    expect(ok({ action: "comment", item_ids: [1], text: "" })).toBe(true);
    expect(ok({ action: "delete", item_ids: [1], find: "x" })).toBe(false);
    expect(ok({ action: "rename", item_id: 1, name: "B" })).toBe(true);
    expect(ok({ action: "rename", item_id: 1 })).toBe(false);
    expect(ok({ action: "rename", item_ids: [1, 2], find: "a", replace: "" })).toBe(true);
    expect(ok({ action: "rename", item_ids: [1, 2], find: "(", replace: "", regex: true })).toBe(false);
    expect(ok({ action: "rename", item_id: 1, name: "B", item_ids: [2], find: "a", replace: "b" })).toBe(false);
    expect(ok({ ops: [{ action: "label", item_ids: [1] }] })).toBe(false);
    expect(ok({ action: "organize", preset: "by_kind", bins: { comps: "Main" } })).toBe(true);
    expect(ok({ action: "remove_empty_folders" })).toBe(true);
  });

  it("normalises both forms to the same list of ops", () => {
    const one = AeProjectItemsSchema.parse({ action: "move", item_ids: [3, 4], folder_id: 9, expect: expectArg });
    expect(normaliseOps(one)).toEqual([{ action: "move", item_ids: [3, 4], folder_id: 9 }]);
    const many = AeProjectItemsSchema.parse({ ops: [{ action: "create_folder", name: "A" }, { action: "delete", item_ids: [1], force: true }], expect: expectArg });
    expect(normaliseOps(many)).toEqual([{ action: "create_folder", name: "A" }, { action: "delete", item_ids: [1], force: true }]);
    expect(idsOfOps(normaliseOps(many))).toEqual([1]);
  });

  it("opProblems names the field", () => {
    expect(opProblems({ action: "create_folder" }).map((p) => p.path)).toEqual(["name"]);
  });
});

describe("tool descriptions", () => {
  it("end with the agent safety guidance and take expect", () => {
    for (const t of projectitemsTools) {
      expect(t.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    }
    expect(projectitemsTools.map((t) => t.name)).toEqual(["ae_create_comp", "ae_project_items"]);
  });
});

// ---------- receipt checks ----------

describe("createCompMismatches", () => {
  const plan: CreatePlan = {
    mode: "new",
    refusals: [],
    warnings: [],
    add_layer: false,
    deep: false,
    would_create_total: 1,
    would_create: [{ role: "new", name: "Main", settings: { width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 5, bg_color: [1, 0, 0] } }],
  };
  const good = { id: 7, kind: "comp" as const, name: "Main", parent_id: 1, width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 5, bg_color: [1, 0, 0], num_layers: 0 };
  const read = (item: Record<string, unknown>) => ({ items: [item], count: 1, truncated: false, root_id: 1 });
  const written = { created: [{ id: 7, name: "Main" }] };

  it("accepts a comp that matches the plan", () => {
    expect(createCompMismatches(plan, null, read(good), written)).toEqual([]);
  });

  it("flags a size, a length off by more than a frame, a wrong folder and a missing comp", () => {
    const bad = { ...good, width: 1280, duration: 5.2, parent_id: 99 };
    expect(createCompMismatches(plan, null, read(bad), written).map((m) => m.path)).toEqual(["comps[0].width", "comps[0].duration", "comps[0].folder"]);
    expect(createCompMismatches(plan, null, read({ id: 7, missing: true }), written).map((m) => m.path)).toEqual(["comps[0]"]);
  });

  it("expects a copy to keep its source's settings and layer count", () => {
    const dupPlan: CreatePlan = { ...plan, mode: "duplicate", would_create: [{ role: "root", name: null, source_id: 3, folder_id: 1 }] };
    const before = read({ id: 3, kind: "comp", name: "Src", parent_id: 1, width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 5, num_layers: 4 });
    const after = read({ ...good, num_layers: 3 });
    expect(createCompMismatches(dupPlan, before, after, { created: [{ id: 7, name: "Src 2", source_id: 3 }] }).map((m) => m.path)).toEqual(["comps[0].num_layers"]);
  });
});

describe("projectItemsMismatches", () => {
  const read = (items: Array<Record<string, unknown>>) => ({ items, count: items.length, truncated: false });

  it("checks names, folders, labels, comments and deletions, and reports host failures", () => {
    const after = read([
      { id: 1, kind: "folder", name: "Bin", parent_id: 0 },
      { id: 2, kind: "comp", name: "Wrong", parent_id: 5, label: 3, comment: "x" },
      { id: 3, missing: true },
      { id: 4, kind: "comp", name: "Still here", parent_id: 0 },
    ]);
    const w = {
      created_folders: [{ virtual_id: -1, id: 1, name: "Bin", parent_id: 0 }],
      moved: [{ id: 2, folder_id: 1 }],
      renamed: [{ id: 2, from: "A", to: "B", kind: "comp" }],
      labelled: [{ id: 2, label: 5 }],
      commented: [{ id: 2, text: "y" }],
      deleted: [
        { id: 3, name: "Gone", kind: "comp" },
        { id: 4, name: "Still here", kind: "comp" },
      ],
      failed: [{ op: 1, type: "move", id: 9, message: "nope" }],
    };
    expect(projectItemsMismatches(null, after, w).map((m) => m.path)).toEqual([
      "moved[0].parent",
      "renamed[0].name",
      "labelled[0].label",
      "commented[0].comment",
      "deleted[1]",
      "failed[0]",
    ]);
  });

  it("judges only the last state of an item that one call touched twice", () => {
    const after = read([
      { id: 2, kind: "comp", name: "Final", parent_id: 8, label: 4, comment: "second" },
      { id: 8, kind: "folder", name: "F2", parent_id: 0 },
    ]);
    const w = {
      moved: [{ id: 2, folder_id: 7 }, { id: 2, folder_id: 8 }],
      renamed: [{ id: 2, from: "A", to: "Mid", kind: "comp" }, { id: 2, from: "Mid", to: "Final", kind: "comp" }],
      labelled: [{ id: 2, label: 1 }, { id: 2, label: 4 }],
      commented: [{ id: 2 }, { id: 2 }],
    };
    const ops = [
      { action: "comment", item_ids: [2], text: "first" },
      { action: "comment", item_ids: [2], text: "second" },
    ] as any;
    expect(projectItemsMismatches(null, after, w, ops)).toEqual([]);
    // The last entry still counts.
    const bad = projectItemsMismatches(null, read([{ id: 2, kind: "comp", name: "Final", parent_id: 7, label: 4, comment: "first" }]), w, ops);
    expect(bad.map((x) => x.path)).toEqual(["moved[1].parent", "commented[1].comment"]);
  });

  it("skips what a later delete removed and checks that the folder's contents are gone", () => {
    const w = {
      moved: [{ id: 2, folder_id: 7 }],
      renamed: [{ id: 2, from: "A", to: "B", kind: "comp" }],
      deleted: [{ id: 7, name: "F", kind: "folder", contained: 2, contained_ids: [2, 3] }],
    };
    const gone = read([{ id: 7, missing: true }, { id: 2, missing: true }, { id: 3, missing: true }]);
    expect(projectItemsMismatches(null, gone, w)).toEqual([]);
    const still = read([{ id: 7, missing: true }, { id: 2, missing: true }, { id: 3, kind: "comp", name: "Left", parent_id: 0 }]);
    expect(projectItemsMismatches(null, still, w).map((x) => x.path)).toEqual(["deleted[0].contained[1]"]);
  });

  it("does not judge items the read left out", () => {
    expect(projectItemsMismatches(null, read([]), { moved: [{ id: 2, folder_id: 1 }], deleted: [{ id: 3, name: "x", kind: "comp" }] })).toEqual([]);
  });
});

// ---------- the guarded flows with a fake bridge ----------

const emptyPlan = {
  actions: [],
  actions_total: 0,
  actions_truncated: false,
  counts: {},
  refusals: [],
  skipped: [],
  warnings: [],
  renames: [],
  renames_total: 0,
  used_items: [],
  render_queue_items_removed: [],
  fix_expressions: true,
  fix_expressions_available: true,
};

describe("ae_create_comp flow", () => {
  const newPlan = {
    mode: "new",
    refusals: [],
    warnings: [],
    add_layer: false,
    deep: false,
    would_create_total: 1,
    would_create: [{ role: "new", name: "Main", settings: { width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 5, bg_color: [1, 0, 0] } }],
  };
  const made = { id: 7, kind: "comp", name: "Main", parent_id: 1, width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 5, bg_color: [1, 0, 0], num_layers: 0 };

  it("plans, guards, reads, writes and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      projectitemsCreateCompPlan: [newPlan],
      projectitemsReadItems: [{ items: [], count: 0, truncated: false, root_id: 1 }, { items: [made], count: 1, truncated: false, root_id: 1 }],
      projectitemsCreateComp: [{ mode: "new", created: [{ id: 7, name: "Main", role: "new" }], created_ids: [7], layers_relinked: 0, layer_added: false }],
    });
    const args = AeCreateCompSchema.parse({ mode: "new", name: "Main", width: 1920, height: 1080, fps: 25, duration: 5, bg_color: "#ff0000", expect: expectArg });
    const out: any = await tool("ae_create_comp").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsCreateCompPlan", "checkGuard", "projectitemsReadItems", "projectitemsCreateComp", "projectitemsReadItems"]);
    expect(calls[3]!.script).toContain('"expect"');
    expect(calls[3]!.script).toContain('"bg_color":[1,0,0]');
    expect(out.receipt.matches).toBe(true);
    expect(out.comps[0]).toMatchObject({ id: 7, name: "Main", width: 1920 });
  });

  it("refuses before any guard or write when the host's plan has refusals", async () => {
    const { ctx, calls } = fakeAe({ projectitemsCreateCompPlan: [{ ...newPlan, refusals: ["width must be an integer in 4..30000 (got 3)"], would_create: [] }] });
    const args = AeCreateCompSchema.parse({ mode: "new", width: 1920, height: 1080, fps: 25, duration: 5, expect: expectArg });
    const out: any = await tool("ae_create_comp").handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "refused", applied: false });
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsCreateCompPlan"]);
  });

  it("makes a deep duplicate a dry run by default and lists copies that would still read the originals", async () => {
    const plan = {
      mode: "duplicate",
      refusals: [],
      warnings: [],
      add_layer: false,
      deep: true,
      would_create_total: 2,
      would_create: [
        { role: "root", name: "Main copy", source_id: 3, source_name: "Main", folder_id: 1, layers_to_relink: 1 },
        { role: "nested", name: "Inner copy", source_id: 4, source_name: "Inner", folder_id: 1, layers_to_relink: 0 },
      ],
      expressions: [ex('comp("Inner").layer(1).position', { comp_id: 3, comp_name: "Main" })],
    };
    const { ctx, calls } = fakeAe({ projectitemsCreateCompPlan: [plan] });
    const args = AeCreateCompSchema.parse({ mode: "duplicate", comp_id: 3, deep: true, expect: expectArg });
    const out: any = await tool("ae_create_comp").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsCreateCompPlan"]);
    expect(out).toMatchObject({ ok: true, applied: false, dry_run: true, would_create_total: 2 });
    expect(out.stale_comp_references.map((w: { reference: string }) => w.reference)).toEqual(['comp("Inner")']);
    expect(out.expressions).toBeUndefined();
  });

  it("checks a deep duplicate's copies for comp() references after the write, without throwing if that read fails", async () => {
    const plan = {
      mode: "duplicate",
      refusals: [],
      warnings: [],
      add_layer: false,
      deep: true,
      would_create_total: 1,
      would_create: [{ role: "root", name: "Main copy", source_id: 3, source_name: "Main", folder_id: 1 }],
    };
    const src = { id: 3, kind: "comp", name: "Main", parent_id: 1, width: 640, height: 360, pixel_aspect: 1, fps: 25, duration: 3, num_layers: 2 };
    const copy = { ...src, id: 8, name: "Main copy" };
    const { ctx, calls } = fakeAe({
      projectitemsCreateCompPlan: [plan],
      projectitemsReadItems: [{ items: [src], count: 1, truncated: false }, { items: [copy], count: 1, truncated: false }],
      projectitemsCreateComp: [{ mode: "duplicate", deep: true, created: [{ id: 8, name: "Main copy", source_id: 3, source_name: "Main", role: "root" }], created_ids: [8], layers_relinked: 1 }],
    });
    const args = AeCreateCompSchema.parse({ mode: "duplicate", comp_id: 3, deep: true, dry_run: false, expect: expectArg });
    const out: any = await tool("ae_create_comp").handler(args, ctx);
    // The scan after the write is not scripted, so it fails; the result still comes back.
    expect(calls.at(-1)!.fn).toBe("projectitemsReadItems");
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.stale_comp_references).toBeUndefined();
  });
});

describe("ae_project_items flow", () => {
  const folder = { items: [], count: 0, truncated: false, root_id: 1 };

  it("is a dry run by default and changes nothing", async () => {
    const plan = { ...emptyPlan, actions: [{ type: "create_folder", id: -1, name: "A", parent_id: 1, op: 1 }], actions_total: 1, counts: { create_folder: 1 } };
    const { ctx, calls } = fakeAe({ projectitemsPlan: [plan] });
    const args = AeProjectItemsSchema.parse({ action: "create_folder", name: "A", expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsPlan"]);
    expect(out).toMatchObject({ ok: true, applied: false, dry_run: true, actions_total: 1 });
  });

  it("returns refusals and writes nothing", async () => {
    const plan = { ...emptyPlan, refusals: [{ op: 1, action: "delete", message: '"Clip" (id 4) is used in 1 comp(s)' }] };
    const { ctx, calls } = fakeAe({ projectitemsPlan: [plan] });
    const args = AeProjectItemsSchema.parse({ action: "delete", item_ids: [4], dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "refused", applied: false });
    expect(out.message).toContain("is used in 1 comp(s)");
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsPlan"]);
  });

  it("says applied: false when the host re-plans at write time and refuses", async () => {
    const plan = { ...emptyPlan, actions: [{ type: "label", ids: [4], label: 5, op: 1 }], actions_total: 1, counts: { label: 1 } };
    const { ctx } = fakeAe({
      projectitemsPlan: [plan],
      projectitemsReadItems: [folder, { items: [], count: 0, truncated: false }],
      projectitemsApply: [{ no_op: true, refused: true, refusals: [{ op: 1, action: "label", message: "item 4 is gone" }] }],
    });
    const args = AeProjectItemsSchema.parse({ action: "label", item_ids: [4], label: 5, dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "refused", applied: false });
    expect(out.message).toMatch(/Nothing was changed/);
  });

  it("returns no_op without a checkpoint or a write when nothing would change", async () => {
    const plan = { ...emptyPlan, skipped: [{ op: 1, action: "label", message: "Every selected item already has label 3" }] };
    const { ctx, calls } = fakeAe({ projectitemsPlan: [plan] });
    const args = AeProjectItemsSchema.parse({ action: "label", item_ids: [4], label: 3, dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(out).toMatchObject({ ok: true, applied: false, no_op: true });
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsPlan"]);
  });

  it("applies through the guarded write and reads the touched items back", async () => {
    const plan = { ...emptyPlan, actions: [{ type: "label", ids: [4], label: 5, op: 1 }], actions_total: 1, counts: { label: 1 } };
    const { ctx, calls } = fakeAe({
      projectitemsPlan: [plan],
      projectitemsReadItems: [folder, { items: [{ id: 4, kind: "comp", name: "A", parent_id: 1, label: 5 }], count: 1, truncated: false }],
      projectitemsApply: [{ no_op: false, labelled: [{ id: 4, label: 5 }], failed: [] }],
    });
    const args = AeProjectItemsSchema.parse({ action: "label", item_ids: [4], label: 5, dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["projectitemsPlan", "checkGuard", "projectitemsReadItems", "projectitemsApply", "projectitemsReadItems"]);
    expect(calls[4]!.script).toContain('"ids":[4]');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("repairs and then checks comp(\"Old\") references after a comp rename, in separate reads", async () => {
    const plan = { ...emptyPlan, actions: [{ type: "rename", id: 4, from: "Intro", to: "Opener", kind: "comp", op: 1 }], actions_total: 1, counts: { rename: 1 }, renames: [{ id: 4, kind: "comp", from: "Intro", to: "Opener" }], renames_total: 1 };
    const before = { items: [], count: 0, truncated: false, expressions: [ex('comp("Intro").layer(1)', { comp_id: 2 })], item_names: { comp: ["Intro", "Main"], footage: [], truncated: false } };
    const after = { items: [], count: 0, truncated: false, expressions: [ex('comp("Intro").layer(1)', { comp_id: 2 })], item_names: { comp: ["Opener", "Main"], footage: [], truncated: false } };
    const { ctx, calls } = fakeAe({
      projectitemsPlan: [plan],
      projectitemsReadItems: [
        before,
        folder,
        { items: [{ id: 4, kind: "comp", name: "Opener", parent_id: 1 }], count: 1, truncated: false },
        after,
      ],
      projectitemsApply: [{ no_op: false, renamed: [{ id: 4, from: "Intro", to: "Opener", kind: "comp" }], name_fixes_attempted: 1, failed: [] }],
      validateExpressions: [
        { comp_id: 2, comp_name: "Main", results: [] },
        { comp_id: 2, comp_name: "Main", results: [{ layer: { id: 9, name: "Pre" }, path: ["Position"], error: "Couldn't find comp" }] },
      ],
    });
    const args = AeProjectItemsSchema.parse({ action: "rename", item_id: 4, name: "Opener", dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual([
      "projectitemsPlan",
      "projectitemsReadItems",
      "validateExpressions",
      "checkGuard",
      "projectitemsReadItems",
      "projectitemsApply",
      "projectitemsReadItems",
      "projectitemsReadItems",
      "validateExpressions",
    ]);
    expect(out.receipt.matches).toBe(true);
    expect(out.expression_references.expressions_naming_renamed_items).toBe(1);
    expect(out.expression_references.unresolved_name_references.map((w: { reference: string }) => w.reference)).toEqual(['comp("Intro")']);
    expect(out.expression_references.new_expression_errors[0].errors[0].error).toBe("Couldn't find comp");
  });

  it("puts a failed step into the receipt instead of throwing", async () => {
    const plan = { ...emptyPlan, actions: [{ type: "move", ids: [4], folder_id: 9, op: 1 }], actions_total: 1, counts: { move: 1 } };
    const { ctx } = fakeAe({
      projectitemsPlan: [plan],
      projectitemsReadItems: [folder, { items: [{ id: 4, kind: "comp", name: "A", parent_id: 1 }], count: 1, truncated: false }],
      projectitemsApply: [{ no_op: false, moved: [], failed: [{ op: 1, type: "move", id: 4, message: "AE refused" }] }],
    });
    const args = AeProjectItemsSchema.parse({ action: "move", item_ids: [4], folder_id: 9, dry_run: false, expect: expectArg });
    const out: any = await tool("ae_project_items").handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("failed[0]");
  });
});

// ---------- the host under node:vm ----------

/** Gives fake items what AE's Item has: label, comment and usedIn; folders that remove their contents; precomp layers that track their source. */
function decorate(it: any, project: FakeProject) {
  it.label = 0;
  it.comment = "";
  if (it instanceof FakeComp) {
    it.bgColor = [0, 0, 0];
    Object.defineProperty(it, "usedIn", {
      get: () => project.all.filter((c): c is FakeComp => c instanceof FakeComp && c.stack.some((l) => l.source === it)),
    });
    it.duplicate = () => {
      const d = project.addComp(`${it.name}`, it.width, it.height, it.duration);
      decorate(d, project);
      d.pixelAspect = it.pixelAspect;
      d.frameRate = it.frameRate;
      d.bgColor = it.bgColor;
      d.parentFolder = it.parentFolder;
      d.stack = it.stack.map((l: FakeLayer) => {
        const n = new FakeLayer(d, l.name);
        n.source = l.source;
        n.locked = l.locked;
        decorateLayer(n);
        return n;
      });
      return d;
    };
  }
  if (it instanceof FakeFolder) {
    const base = it.remove.bind(it);
    it.remove = () => {
      const kill = (f: FakeFolder) => {
        for (const k of f.children as any[]) {
          if (k instanceof FakeFolder) kill(k);
          project.all = project.all.filter((x) => x !== k);
        }
      };
      kill(it);
      // Items nested in a removed comp's users lose those layers, as in AE.
      base();
    };
  }
  if (it instanceof FakeFootage) {
    (it as any).frameRate = 0;
  }
  const removeBase = it.remove?.bind(it);
  if (it instanceof FakeComp || it instanceof FakeFootage) {
    it.remove = () => {
      for (const c of project.all) {
        if (c instanceof FakeComp) c.stack = c.stack.filter((l) => l.source !== it);
      }
      removeBase();
    };
  }
  return it;
}

function decorateLayer(l: FakeLayer) {
  (l as any).replaceSource = (src: any) => {
    // AE renames a layer that carried its source's name.
    if (l.name === (l.source as any)?.name) l.name = src.name;
    l.source = src;
  };
  return l;
}

function world() {
  const project = new FakeProject();
  (project as any).items = {
    addComp: (name: string, w: number, h: number, pa: number, dur: number, fps: number) => {
      const c = project.addComp(name, w, h, dur);
      c.pixelAspect = pa;
      c.frameRate = fps;
      return decorate(c, project);
    },
    addFolder: (name: string) => decorate(project.addFolder(name), project),
  };
  (project as any).autoFixExpressions = (a: string, b: string) => {
    fixes.push([a, b]);
  };
  const fixes: string[][] = [];
  const mkComp = (name: string, w = 640, h = 360, dur = 3, folder?: FakeFolder) => {
    const c = decorate(project.addComp(name, w, h, dur, folder), project) as FakeComp;
    c.frameRate = 25;
    return c;
  };
  const mkFolder = (name: string, parent?: FakeFolder) => decorate(project.addFolder(name, parent), project) as FakeFolder;
  const mkFootage = (name: string, w = 1920, h = 1080, opts: { still?: boolean; dur?: number; fps?: number; folder?: FakeFolder } = {}) => {
    const src = Object.assign(new FileSource(), { isStill: opts.still === true });
    const f = decorate(project.addFootage(name, w, h, src, opts.folder), project) as FakeFootage;
    Object.assign(f, { duration: opts.still ? 0 : (opts.dur ?? 4), frameRate: opts.still ? 0 : (opts.fps ?? 25), pixelAspect: 1, hasVideo: true });
    return f;
  };
  const useIn = (comp: FakeComp, item: any, name?: string) => {
    const l = decorateLayer(comp.layers.add!(item) as FakeLayer);
    if (name) l.name = name;
    return l;
  };
  const host = loadHost(project, ["projectitems.jsx"]);
  const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  return { project, fixes, mkComp, mkFolder, mkFootage, useIn, ...host, plain };
}

const kidsOfRoot = (p: FakeProject) => p.rootFolder.children.map((c: any) => c.name);

describe("projectitems.jsx: ae_create_comp", () => {
  it("makes a new comp with the settings, background and folder in one undo group", () => {
    const w = world();
    const bin = w.mkFolder("Comps");
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "new", name: "Main", width: 1920, height: 1080, pixel_aspect: 1, fps: 30, duration: 5, bg_color: [0.1, 0.2, 0.3], target_folder_id: bin.id, expect: GUARD }));
    const made = w.project.itemByID(out.created[0].id) as any;
    expect(made).toMatchObject({ name: "Main", width: 1920, height: 1080, duration: 5, frameRate: 30 });
    expect(made.bgColor).toEqual([0.1, 0.2, 0.3]);
    expect(made.parentFolder).toBe(bin);
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("converts duration_frames, names unique, and refuses out-of-range settings before the undo group", () => {
    const w = world();
    w.mkComp("Main");
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "new", name: "Main", unique_name: true, width: 640, height: 360, fps: 25, duration_frames: 50, expect: GUARD }));
    expect(out.created[0].name).toBe("Main 2");
    expect((w.project.itemByID(out.created[0].id) as any).duration).toBe(2);
    const begun = w.undo.begun;
    for (const bad of [{ width: 3 }, { height: 30001 }, { fps: 100 }, { duration: 10801 }, { pixel_aspect: 101 }, { bg_color: [2, 0, 0] }]) {
      expect(() => w.A.projectitemsCreateComp({ mode: "new", name: "X", width: 640, height: 360, fps: 25, duration: 2, ...bad, expect: GUARD })).toThrow(/Refused/);
    }
    expect(w.undo.begun).toBe(begun);
    expect(w.project.numItems).toBe(2);
  });

  it("refuses when the guard does not match", () => {
    const w = world();
    expect(() => w.A.projectitemsCreateComp({ mode: "new", width: 640, height: 360, fps: 25, duration: 2, expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
    expect(w.undo.begun).toBe(0);
  });

  it("builds a comp from footage like New Comp from Footage and adds the layer", () => {
    const w = world();
    const clip = w.mkFootage("shot_a.mov", 1280, 720, { dur: 4, fps: 24 });
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "from_footage", item_id: clip.id, expect: GUARD }));
    const made = w.project.itemByID(out.created[0].id) as FakeComp;
    expect(made).toMatchObject({ name: "shot_a", width: 1280, height: 720, duration: 4, frameRate: 24 });
    expect(made.numLayers).toBe(1);
    expect(made.layer(1)!.source).toBe(clip);
    expect(out.layer_added).toBe(true);
    const bare = w.plain(w.A.projectitemsCreateComp({ mode: "from_footage", item_id: clip.id, add_layer: false, unique_name: true, expect: GUARD }));
    expect((w.project.itemByID(bare.created[0].id) as FakeComp).numLayers).toBe(0);
    expect(bare.created[0].name).toBe("shot_a 2");
  });

  it("needs a duration and fps for a still, and refuses audio without a size", () => {
    const w = world();
    const still = w.mkFootage("logo.png", 800, 600, { still: true });
    const plan = w.plain(w.A.projectitemsCreateCompPlan({ mode: "from_footage", item_id: still.id }));
    expect(plan.refusals.join(" ")).toMatch(/give fps/);
    expect(plan.refusals.join(" ")).toMatch(/give duration/);
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "from_footage", item_id: still.id, fps: 25, duration_frames: 75, expect: GUARD }));
    expect((w.project.itemByID(out.created[0].id) as FakeComp).duration).toBe(3);
    const audio = w.mkFootage("vo.wav", 0, 0);
    (audio as any).hasVideo = false;
    expect(w.plain(w.A.projectitemsCreateCompPlan({ mode: "from_footage", item_id: audio.id })).refusals.join(" ")).toMatch(/no video/);
    expect(w.plain(w.A.projectitemsCreateCompPlan({ mode: "from_footage", item_id: w.mkComp("C").id })).refusals.join(" ")).toMatch(/not a footage item/);
  });

  it("duplicates a comp into its source's folder, with a suffix", () => {
    const w = world();
    const bin = w.mkFolder("Bin");
    const src = w.mkComp("Main", 640, 360, 3, bin);
    w.useIn(src, w.mkFootage("a.mov"));
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: src.id, name_suffix: " v2", expect: GUARD }));
    const copy = w.project.itemByID(out.created[0].id) as FakeComp;
    expect(copy.name).toBe("Main v2");
    expect(copy.parentFolder).toBe(bin);
    expect(copy.numLayers).toBe(1);
    const moved = w.plain(w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: src.id, name: "Elsewhere", target_folder_id: w.project.rootFolder.id, expect: GUARD }));
    expect((w.project.itemByID(moved.created[0].id) as FakeComp).parentFolder).toBe(w.project.rootFolder);
  });

  function tree() {
    const w = world();
    const c = w.mkComp("C");
    const b = w.mkComp("B");
    const a = w.mkComp("A");
    w.useIn(b, c);
    w.useIn(a, b);
    w.useIn(a, c);
    w.useIn(a, w.mkFootage("f.mov"));
    return { w, a, b, c };
  }

  it("deep duplicate copies each nested comp once and relinks the copies to each other", () => {
    const { w, a, b, c } = tree();
    const out = w.plain(w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: a.id, deep: true, expect: GUARD }));
    expect(out.created).toHaveLength(3);
    expect(out.layers_relinked).toBe(3);
    const byName = (n: string) => w.project.all.find((x: any) => x.name === n) as FakeComp;
    const [a2, b2, c2] = [byName("A copy"), byName("B copy"), byName("C copy")];
    const src = (comp: FakeComp, i: number) => (comp.layer(i)!.source as FakeComp).id;
    expect(src(a2, 2)).toBe(c2.id);
    expect(src(a2, 3)).toBe(b2.id);
    expect(src(b2, 1)).toBe(c2.id);
    // The originals are untouched, and the copied layers keep their names for layer("Name") expressions.
    expect(src(a, 3)).toBe(b.id);
    expect(src(b, 1)).toBe(c.id);
    expect(a2.layer(3)!.name).toBe("B");
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
    // A second deep copy makes unique names.
    const again = w.plain(w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: a.id, deep: true, expect: GUARD }));
    expect(again.created.map((x: { name: string }) => x.name).sort()).toEqual(["A copy 2", "B copy 2", "C copy 2"]);
  });

  it("deep plan lists the copies and the expressions that read the originals; the cap and locked layers refuse", () => {
    const { w, a, b } = tree();
    const exprProp = a.layer(1)!.transform("ADBE Position");
    exprProp.expression = 'comp("B").layer(1).transform.position';
    exprProp.expressionEnabled = true;
    const plan = w.plain(w.A.projectitemsCreateCompPlan({ mode: "duplicate", comp_id: a.id, deep: true }));
    expect(plan.would_create.map((e: { source_name: string }) => e.source_name)).toEqual(["A", "C", "B"]);
    expect(plan.expressions.map((e: ScanExpression) => e.text)).toEqual(['comp("B").layer(1).transform.position']);
    expect(copiedCompWarnings(plan.expressions, plan.would_create.map((e: { source_name: string }) => e.source_name))).toHaveLength(1);
    const capped = w.plain(w.A.projectitemsCreateCompPlan({ mode: "duplicate", comp_id: a.id, deep: true, max_comps: 2 }));
    expect(capped.refusals.join(" ")).toMatch(/more than 2 comps/);
    b.layer(1)!.locked = true;
    const locked = w.plain(w.A.projectitemsCreateCompPlan({ mode: "duplicate", comp_id: a.id, deep: true }));
    expect(locked.refusals.join(" ")).toMatch(/locked/);
    const begun = w.undo.begun;
    expect(() => w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: a.id, deep: true, expect: GUARD })).toThrow(/locked/);
    expect(w.undo.begun).toBe(begun);
  });

  it("takes back the copies if a step fails inside the undo group", () => {
    const { w, a } = tree();
    const before = w.project.numItems;
    // Make the third relink throw.
    let calls = 0;
    const real = (a as any).duplicate;
    (a as any).duplicate = () => {
      const d = real.call(a);
      for (const l of d.stack) {
        l.replaceSource = () => {
          calls++;
          throw new Error("replaceSource failed");
        };
      }
      return d;
    };
    expect(() => w.A.projectitemsCreateComp({ mode: "duplicate", comp_id: a.id, deep: true, expect: GUARD })).toThrow(/replaceSource failed/);
    expect(calls).toBeGreaterThan(0);
    expect(w.project.numItems).toBe(before);
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
  });
});

describe("projectitems.jsx: readItems", () => {
  it("summarises items, marks missing ids, and scans expressions that name comps or footage", () => {
    const w = world();
    const bin = w.mkFolder("Bin");
    const comp = w.mkComp("Main", 640, 360, 3, bin);
    const clip = w.mkFootage("a.mov");
    w.useIn(comp, clip);
    comp.layer(1)!.transform("ADBE Position").expression = 'comp("Other").layer(1).position';
    comp.layer(1)!.transform("ADBE Opacity").expression = "wiggle(1, 2)";
    const out = w.plain(w.A.projectitemsReadItems({ ids: [comp.id, clip.id, bin.id, 99999], scan_expressions: true }));
    expect(out.items[0]).toMatchObject({ id: comp.id, kind: "comp", name: "Main", parent_id: bin.id, width: 640, num_layers: 1 });
    expect(out.items[1]).toMatchObject({ kind: "footage", subkind: "footage", used_in_count: 1 });
    expect(out.items[2]).toMatchObject({ kind: "folder", num_items: 1 });
    expect(out.items[3]).toEqual({ id: 99999, missing: true });
    expect(out.expressions).toHaveLength(1);
    expect(out.expressions[0]).toMatchObject({ comp_id: comp.id, layer_name: "a.mov", text: 'comp("Other").layer(1).position' });
    expect(out.item_names).toEqual({ comp: ["Main"], footage: ["a.mov"], truncated: false });
    expect(w.undo.begun).toBe(0);
  });
});

describe("projectitems.jsx: ae_project_items plan and apply", () => {
  const run = (w: ReturnType<typeof world>, ops: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => w.plain(w.A.projectitemsApply({ ops, expect: GUARD, ...extra }));
  const plan = (w: ReturnType<typeof world>, ops: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => w.plain(w.A.projectitemsPlan({ ops, ...extra }));

  it("creates folders and moves items in order, including a folder_path that does not exist yet", () => {
    const w = world();
    const a = w.mkComp("A");
    const b = w.mkComp("B");
    const p = plan(w, [{ action: "move", item_ids: [a.id, b.id], folder_path: "Shots/Day1" }]);
    expect(p.actions.map((x: { type: string }) => x.type)).toEqual(["create_folder", "create_folder", "move"]);
    expect(p.counts).toMatchObject({ create_folder: 2, move: 2 });
    expect(w.project.numItems).toBe(2);
    const out = run(w, [{ action: "move", item_ids: [a.id, b.id], folder_path: "Shots/Day1" }]);
    expect(out.created_folders).toHaveLength(2);
    const day1 = w.project.all.find((x: any) => x.name === "Day1") as FakeFolder;
    expect(a.parentFolder).toBe(day1);
    expect(day1.parentFolder?.name).toBe("Shots");
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
    // The same call again finds the folders and has nothing left to move.
    expect(run(w, [{ action: "move", item_ids: [a.id, b.id], folder_path: "Shots/Day1" }]).no_op).toBe(true);
  });

  it("refuses moving a folder into itself or its own child, and the root, before the undo group", () => {
    const w = world();
    const outer = w.mkFolder("Outer");
    const inner = w.mkFolder("Inner", outer);
    const into = plan(w, [{ action: "move", item_ids: [outer.id], folder_id: inner.id }]);
    expect(into.refusals[0].message).toMatch(/that is inside it/);
    expect(plan(w, [{ action: "move", item_ids: [outer.id], folder_id: outer.id }]).refusals[0].message).toMatch(/into itself/);
    expect(plan(w, [{ action: "move", item_ids: [w.project.rootFolder.id], folder_id: inner.id }]).refusals[0].message).toMatch(/root/);
    const out = run(w, [{ action: "move", item_ids: [outer.id], folder_id: inner.id }]);
    expect(out).toMatchObject({ no_op: true, refused: true });
    expect(w.undo.begun).toBe(0);
    expect(outer.parentFolder).toBe(w.project.rootFolder);
  });

  it("renames one item or many, then repairs expressions in the same undo group", () => {
    const w = world();
    const a = w.mkComp("Intro 1");
    const b = w.mkComp("Intro 2");
    const f = w.mkFolder("Intro bin");
    const out = run(w, [{ action: "rename", item_ids: [a.id, b.id, f.id], find: "Intro", replace: "Scene" }]);
    expect(out.renamed.map((r: { to: string }) => r.to)).toEqual(["Scene 1", "Scene 2", "Scene bin"]);
    expect(a.name).toBe("Scene 1");
    // Folders have no expression references, so only the two comps are repaired, and after every rename.
    expect(w.fixes).toEqual([['"Intro 1"', '"Scene 1"'], ["'Intro 1'", "'Scene 1'"], ['"Intro 2"', '"Scene 2"'], ["'Intro 2'", "'Scene 2'"]]);
    expect(out.name_fixes_attempted).toBe(2);
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
    const single = run(w, [{ action: "rename", item_id: a.id, name: "Hero" }], { fix_expressions: false });
    expect(a.name).toBe("Hero");
    expect(w.fixes).toHaveLength(4);
    expect(single.name_fixes_attempted).toBe(0);
  });

  it("refuses to act on a folder the same call creates", () => {
    const w = world();
    const a = w.mkComp("Intro");
    for (const op of [
      { action: "label", item_ids: [-1], label: 3 },
      { action: "rename", item_id: -1, name: "Z" },
      { action: "delete", item_ids: [-1] },
      { action: "comment", item_ids: [-1], text: "x" },
      { action: "move", item_ids: [-1], folder_id: w.project.rootFolder.id },
    ]) {
      const p = plan(w, [{ action: "create_folder", name: "X" }, op]);
      expect(p.refusals[0].message).toMatch(/folder this call creates/);
    }
    // a virtual folder is still a fine destination
    expect(plan(w, [{ action: "create_folder", name: "X" }, { action: "move", item_ids: [a.id], folder_id: -1 }]).refusals).toEqual([]);
  });

  it("renames with a regular expression, skips unchanged names and refuses an empty result", () => {
    const w = world();
    const a = w.mkComp("shot_010");
    const b = w.mkComp("other");
    const out = run(w, [{ action: "rename", item_ids: [a.id, b.id], find: "shot_(\\d+)", replace: "S$1", regex: true }]);
    expect(out.renamed.map((r: { to: string }) => r.to)).toEqual(["S010"]);
    expect(b.name).toBe("other");
    expect(plan(w, [{ action: "rename", item_ids: [a.id], find: "S010", replace: "" }]).refusals[0].message).toMatch(/non-empty/);
    expect(plan(w, [{ action: "rename", item_ids: [a.id], find: "(", replace: "x", regex: true }]).refusals[0].message).toMatch(/regular expression/);
    expect(plan(w, [{ action: "rename", item_id: a.id, name: "S010" }]).skipped[0].message).toMatch(/already/);
  });

  it("warns when this AE has no autoFixExpressions", () => {
    const w = world();
    const a = w.mkComp("A");
    delete (w.project as any).autoFixExpressions;
    const p = plan(w, [{ action: "rename", item_id: a.id, name: "B" }]);
    expect(p.fix_expressions_available).toBe(false);
    expect(p.warnings.join(" ")).toMatch(/no Project.autoFixExpressions/);
    const out = run(w, [{ action: "rename", item_id: a.id, name: "B" }]);
    expect(out.name_fixes_attempted).toBe(0);
    expect(out.fix_expressions_available).toBe(false);
  });

  it("sets labels and comments, range-checks the label and skips what already holds", () => {
    const w = world();
    const a = w.mkComp("A");
    const b = w.mkComp("B");
    b.label = 5;
    const out = run(w, [
      { action: "label", item_ids: [a.id, b.id], label: 5 },
      { action: "comment", item_ids: [a.id], text: "final" },
    ]);
    expect(out.labelled).toEqual([{ id: a.id, label: 5 }]);
    expect((a as any).label).toBe(5);
    expect((a as any).comment).toBe("final");
    expect(plan(w, [{ action: "label", item_ids: [a.id], label: 17 }]).refusals[0].message).toMatch(/0\.\.16/);
    expect(run(w, [{ action: "comment", item_ids: [a.id], text: "final" }]).no_op).toBe(true);
    expect(run(w, [{ action: "comment", item_ids: [a.id], text: "" }]).commented).toEqual([{ id: a.id }]);
  });

  it("deletes unused items, lists the render queue items that go with a comp, and refuses used items", () => {
    const w = world();
    const used = w.mkFootage("used.mov");
    const free = w.mkFootage("free.mov");
    const main = w.mkComp("Main");
    const spare = w.mkComp("Spare");
    w.useIn(main, used);
    w.project.renderQueue.items.add(spare);
    const refused = plan(w, [{ action: "delete", item_ids: [used.id, free.id] }]);
    expect(refused.refusals[0].message).toMatch(/used in 1 comp/);
    expect(refused.refusals[0].message).toContain('"Main"');
    expect(refused.used_items[0]).toMatchObject({ id: used.id, used_in: [{ id: main.id, name: "Main" }] });
    const ok = plan(w, [{ action: "delete", item_ids: [free.id, spare.id] }]);
    expect(ok.refusals).toEqual([]);
    expect(ok.render_queue_items_removed).toMatchObject([{ rq_index: 1, comp_id: spare.id, comp_name: "Spare" }]);
    const out = run(w, [{ action: "delete", item_ids: [free.id, spare.id] }]);
    expect(out.deleted.map((d: { name: string }) => d.name)).toEqual(["free.mov", "Spare"]);
    expect(w.project.itemByID(free.id)).toBeNull();
    expect(w.project.itemByID(used.id)).not.toBeNull();
    expect(plan(w, [{ action: "delete", item_ids: [w.project.rootFolder.id] }]).refusals[0].message).toMatch(/root/);
  });

  it("organize works inside parent_id: loose means loose in that folder, not the root", () => {
    const w = world();
    const rootComp = w.mkComp("RootComp");
    const work = w.mkFolder("Work");
    const inWork = w.mkComp("InWork", 640, 360, 3, work);
    const elsewhere = w.mkFolder("Elsewhere");
    const other = w.mkComp("Other", 640, 360, 3, elsewhere);
    const out = run(w, [{ action: "organize", preset: "by_kind", parent_id: work.id }]);
    expect(out.created_folders.map((f: { name: string }) => f.name)).toEqual(["Comps"]);
    expect((inWork.parentFolder as FakeFolder).name).toBe("Comps");
    expect(((inWork.parentFolder as FakeFolder).parentFolder as FakeFolder).name).toBe("Work");
    expect((rootComp.parentFolder as FakeFolder).name).not.toBe("Comps");
    expect(other.parentFolder).toBe(elsewhere);
    // Without skipping, every item below parent_id moves; items outside it stay.
    const w2 = world();
    const work2 = w2.mkFolder("Work");
    const sub = w2.mkFolder("Sub", work2);
    const deep = w2.mkComp("Deep", 640, 360, 3, sub);
    const out2 = w2.mkComp("OutsideWork");
    run(w2, [{ action: "organize", preset: "by_kind", parent_id: work2.id, skip_items_already_in_folders: false }]);
    expect((deep.parentFolder as FakeFolder).name).toBe("Comps");
    expect(out2.parentFolder).not.toBe(deep.parentFolder);
    expect((out2.parentFolder as FakeFolder).name).not.toBe("Comps");
  });

  it("does not echo comment text in the write result", () => {
    const w = world();
    const a = w.mkComp("A");
    const out = run(w, [{ action: "comment", item_ids: [a.id], text: "x".repeat(5000) }]);
    expect(out.commented).toEqual([{ id: a.id }]);
    expect(out.renames).toBeUndefined();
  });

  it("refuses a non-empty folder without force, and checks used items inside it recursively", () => {
    const w = world();
    const bin = w.mkFolder("Bin");
    const nested = w.mkFolder("Nested", bin);
    const clip = w.mkFootage("deep.mov", 1920, 1080, { folder: nested });
    const main = w.mkComp("Main");
    w.useIn(main, clip);
    expect(plan(w, [{ action: "delete", item_ids: [bin.id] }]).refusals[0].message).toMatch(/force: true/);
    const forced = plan(w, [{ action: "delete", item_ids: [bin.id], force: true }]);
    expect(forced.refusals[0].message).toMatch(/"deep.mov".*used in 1 comp/);
    expect(run(w, [{ action: "delete", item_ids: [bin.id], force: true }])).toMatchObject({ no_op: true, refused: true });
    expect(w.project.itemByID(clip.id)).not.toBeNull();
    // Once the user comp goes too (it is outside the folder, so it is its own deletion), the folder can go.
    w.useIn(main, w.mkFootage("free.mov"));
    main.stack = main.stack.filter((l) => l.source !== clip);
    const out = run(w, [{ action: "delete", item_ids: [bin.id], force: true }]);
    expect(out.deleted).toEqual([{ id: bin.id, name: "Bin", kind: "folder", contained: 2, contained_ids: [nested.id, clip.id] }]);
    expect(w.project.itemByID(clip.id)).toBeNull();
  });

  it("lets a delete take both a comp and the footage it uses when both are in the deletion", () => {
    const w = world();
    const clip = w.mkFootage("a.mov");
    const main = w.mkComp("Main");
    w.useIn(main, clip);
    expect(plan(w, [{ action: "delete", item_ids: [clip.id] }]).refusals).toHaveLength(1);
    expect(plan(w, [{ action: "delete", item_ids: [clip.id, main.id] }]).refusals).toEqual([]);
  });

  it("organizes loose items by kind, reusing a bin that exists and leaving foldered items alone", () => {
    const w = world();
    const pre = w.mkComp("Pre");
    const main = w.mkComp("Main");
    w.useIn(main, pre);
    w.mkFootage("v.mov");
    w.mkFootage("s.png", 100, 100, { still: true });
    const audio = w.mkFootage("a.wav");
    (audio as any).hasVideo = false;
    (audio as any).hasAudio = true;
    const solidItem = w.project.addFootage("Solid 1", 640, 360, new SolidSource());
    decorate(solidItem, w.project);
    const comps = w.mkFolder("Comps");
    const foldered = w.mkComp("InFolder", 640, 360, 3, comps);
    const p = plan(w, [{ action: "organize", preset: "by_kind" }]);
    expect(p.actions.filter((a: { type: string }) => a.type === "create_folder").map((a: { name: string }) => a.name).sort()).toEqual(["Audio", "Footage", "Precomps", "Solids", "Stills"]);
    const out = run(w, [{ action: "organize", preset: "by_kind", bins: { footage: "Media" } }]);
    expect(out.created_folders.map((f: { name: string }) => f.name).sort()).toEqual(["Audio", "Media", "Precomps", "Solids", "Stills"]);
    const inBin = (name: string) => ((w.project.all.find((x: any) => x.name === name) as any).parentFolder as FakeFolder).name;
    expect(inBin("Pre")).toBe("Precomps");
    expect(inBin("Main")).toBe("Comps");
    expect(inBin("v.mov")).toBe("Media");
    expect(inBin("s.png")).toBe("Stills");
    expect(inBin("a.wav")).toBe("Audio");
    expect(inBin("Solid 1")).toBe("Solids");
    expect(foldered.parentFolder).toBe(comps);
    expect(w.project.all.filter((x: any) => x.name === "Comps")).toHaveLength(1);
    expect(kidsOfRoot(w.project).sort()).toEqual(["Audio", "Comps", "Media", "Precomps", "Solids", "Stills"]);
    expect(run(w, [{ action: "organize" }]).no_op).toBe(true);
  });

  it("removes empty folders repeatedly, so a folder of empty folders goes too, and never the root or full folders", () => {
    const w = world();
    const a = w.mkFolder("A");
    w.mkFolder("A1", a);
    const b = w.mkFolder("B");
    w.mkComp("Keep", 640, 360, 3, b);
    w.mkFolder("Empty");
    const p = plan(w, [{ action: "remove_empty_folders" }]);
    expect(p.actions.map((x: { name: string }) => x.name).sort()).toEqual(["A", "A1", "Empty"]);
    const out = run(w, [{ action: "remove_empty_folders" }]);
    expect(out.deleted).toHaveLength(3);
    expect(kidsOfRoot(w.project)).toEqual(["B"]);
    expect(run(w, [{ action: "remove_empty_folders" }]).no_op).toBe(true);
  });

  it("plans later operations on what earlier ones make, and a dry plan does not touch the project", () => {
    const w = world();
    const a = w.mkComp("A");
    const p = plan(w, [
      { action: "create_folder", name: "New" },
      { action: "label", item_ids: [a.id], label: 2 },
      { action: "delete", item_ids: [a.id] },
      { action: "comment", item_ids: [a.id], text: "x" },
    ]);
    expect(p.refusals).toHaveLength(1);
    expect(p.refusals[0]).toMatchObject({ op: 4, action: "comment" });
    expect(w.project.numItems).toBe(1);
    expect((a as any).label).toBe(0);
    expect(w.undo.begun).toBe(0);
  });

  it("refuses an unknown item id and a non-folder destination", () => {
    const w = world();
    const a = w.mkComp("A");
    const b = w.mkComp("B");
    expect(plan(w, [{ action: "label", item_ids: [123456], label: 1 }]).refusals[0].message).toMatch(/No item with id 123456/);
    expect(plan(w, [{ action: "move", item_ids: [a.id], folder_id: b.id }]).refusals[0].message).toMatch(/not a folder/);
    expect(() => w.A.projectitemsApply({ ops: [{ action: "label", item_ids: [a.id], label: 1 }], expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
  });

  it("carries on past a step AE refuses and reports it", () => {
    const w = world();
    const a = w.mkComp("A");
    const b = w.mkComp("B");
    Object.defineProperty(a, "comment", { get: () => "", set: () => { throw new Error("locked item"); } });
    const out = run(w, [{ action: "comment", item_ids: [a.id, b.id], text: "hi" }]);
    expect(out.commented).toEqual([{ id: b.id }]);
    expect(out.failed).toMatchObject([{ type: "comment", id: a.id, message: "locked item" }]);
    expect(w.undo).toEqual({ begun: 1, ended: 1 });
  });
});
