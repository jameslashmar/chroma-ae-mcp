import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { layersTools } from "../src/tools/ext/layers.js";
import { mutateTools } from "../src/tools/mutate.js";
import {
  AeSessionChangesSchema,
  diffSnapshots,
  getSessionTracker,
  installSessionBridgeHook,
  installSessionTracking,
  resetSessionTracking,
  SNAPSHOT_TIMEOUT_MS,
  SessionTracker,
  sessionTools,
  undoReach,
  type SessionCompState,
  type SessionSnapshot,
  type StoredSnapshot,
  type UndoStep,
} from "../src/tools/ext/session.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-session-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  resetSessionTracking();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = sessionTools[0];
const SERVICE = "svc-1";

const comp = (id: number, extra: Partial<SessionCompState> = {}): SessionCompState => ({
  id,
  name: `Comp ${id}`,
  num_layers: 3,
  selected: [],
  work_area_start: 0,
  work_area_duration: 4,
  time: 0,
  hash: "aaaa1111",
  ...extra,
});

const snap = (extra: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  project_path: "C:/p/show.aep",
  dirty: true,
  revision: 10,
  num_items: 3,
  item_ids: [1, 2, 3],
  items_truncated: false,
  active_item: { id: 5, name: "Main", kind: "comp" },
  ae_version: "26.2.1",
  build: "100",
  render_queue: { num_items: 0, queued: 0, rendering: 0 },
  comps: [comp(5, { name: "Main" })],
  ...extra,
});

const stored = (extra: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  ...snap(),
  taken_at: "2026-11-03T10:00:00.000Z",
  op_id: "op_1",
  tool: "ae_create_layer",
  service_id: SERVICE,
  ...extra,
});

describe("AeSessionChangesSchema", () => {
  it("takes optional comps, undo options and rebase, and rejects bad values", () => {
    expect(AeSessionChangesSchema.safeParse({}).success).toBe(true);
    expect(AeSessionChangesSchema.safeParse({ comp_ids: [1, 2], include_undo_steps: false, max_undo_steps: 5, rebase: true }).success).toBe(true);
    expect(AeSessionChangesSchema.safeParse({ max_undo_steps: 0 }).success).toBe(false);
    expect(AeSessionChangesSchema.safeParse({ comp_ids: [1.5] }).success).toBe(false);
  });

  it("is read-only: it does not take expect", () => {
    expect(Object.keys(AeSessionChangesSchema.shape)).not.toContain("expect");
    expect(tool.name).toBe("ae_session_changes");
  });
});

describe("diffSnapshots", () => {
  it("reports nothing when nothing changed", () => {
    const d = diffSnapshots(stored(), snap(), SERVICE);
    expect(d.changed).toBe(false);
    expect(d.user_changed).toBeNull();
  });

  it("sees an edited layer stack, a new layer and a changed selection", () => {
    const edited = diffSnapshots(stored(), snap({ comps: [comp(5, { name: "Main", hash: "bbbb2222" })] }), SERVICE);
    expect(edited.comps[0]).toMatchObject({ status: "changed", stack_changed: true });
    expect(edited.user_changed).toContain('comp 5 "Main": layer stack edited');
    const added = diffSnapshots(stored(), snap({ comps: [comp(5, { name: "Main", num_layers: 4, hash: "cccc" })] }), SERVICE);
    expect(added.user_changed).toContain("layers 3 -> 4");
    const sel = diffSnapshots(stored(), snap({ comps: [comp(5, { name: "Main", selected: [9] })] }), SERVICE);
    expect(sel.comps[0].selection_changed).toBe(true);
    expect(sel.changed).toBe(true);
  });

  it("treats a moved playhead and the dirty flag as hints, not changes", () => {
    const d = diffSnapshots(stored(), snap({ dirty: false, revision: 14, comps: [comp(5, { name: "Main", time: 2 })] }), SERVICE);
    expect(d.changed).toBe(false);
    expect(d.hints).toEqual({ dirty: { before: true, now: false }, revision_delta: 4, time_changed_comps: [5] });
  });

  it("flags another project and does not compare anything else", () => {
    const d = diffSnapshots(stored(), snap({ project_path: "C:/p/other.aep", item_ids: [9], num_items: 1 }), SERVICE);
    expect(d.project_swapped).toBe(true);
    expect(d.items).toBeNull();
    expect(d.user_changed).toContain("another project is open");
  });

  it("matches the same path spelled differently (separators, case on Windows)", () => {
    const d = diffSnapshots(stored({ project_path: "C:\\p\\Show.aep" }), snap({ project_path: "C:/p/Show.aep" }), SERVICE);
    expect(d.project_swapped).toBe(false);
  });

  it("lists added and removed items by id, or only counts when a list was capped", () => {
    const d = diffSnapshots(stored(), snap({ item_ids: [2, 3, 4, 5], num_items: 4 }), SERVICE);
    expect(d.items).toMatchObject({ exact: true, added: [4, 5], removed: [1], added_count: 2, removed_count: 1 });
    expect(d.user_changed).toContain("project items +2 -1");
    const capped = diffSnapshots(stored({ items_truncated: true }), snap({ item_ids: [7], num_items: 5 }), SERVICE);
    expect(capped.items).toMatchObject({ exact: false, added: [], removed: [], count_before: 3, count_now: 5 });
    expect(capped.user_changed).toContain("3 -> 5");
  });

  it("notices a deleted comp, a new active item, a restart and a revision that went back", () => {
    const d = diffSnapshots(stored(), snap({ comps: [{ id: 5, missing: true }], active_item: { id: 6, name: "Other", kind: "comp" }, revision: 2 }), "svc-2");
    expect(d.comps[0].status).toBe("removed");
    expect(d.active_item?.now?.id).toBe(6);
    expect(d.service_restarted).toBe(true);
    expect(d.reopened_or_reverted_suspected).toBe(true);
    expect(d.user_changed).toContain("comp 5 \"Main\" is gone");
    expect(d.user_changed).toContain("restarted");
  });

  it("does not judge a comp the baseline never had, or compare a hash capped differently", () => {
    const d = diffSnapshots(stored(), snap({ comps: [comp(5, { name: "Main" }), comp(8)] }), SERVICE);
    expect(d.comps.find((c) => c.id === 8)?.status).toBe("no_baseline");
    expect(d.changed).toBe(false);
    const capped = diffSnapshots(stored(), snap({ comps: [comp(5, { name: "Main", hash: "zzzz", hash_truncated: true })] }), SERVICE);
    expect(capped.comps[0].stack_changed).toBe(false);
  });

  it("ignores a missing revision on either side", () => {
    const d = diffSnapshots(stored({ revision: null }), snap({ revision: 1 }), SERVICE);
    expect(d.reopened_or_reverted_suspected).toBe(false);
    expect(d.hints.revision_delta).toBeNull();
  });
});

describe("undoReach", () => {
  const step = (extra: Partial<UndoStep> = {}): UndoStep => ({
    op_id: "op_1",
    tool: "ae_create_layer",
    label: "ae_create_layer",
    at: "2026-11-03T10:00:00.000Z",
    project_path: "C:/p/show.aep",
    service_id: SERVICE,
    revision_after: 10,
    checkpoint: "C:/p/_mcp_backups/show.aep",
    ...extra,
  });

  it("never says reachable, only possibly", () => {
    expect(undoReach(step(), snap(), SERVICE).reach).toBe("possibly_reachable");
  });

  it("proves a step gone after another project, a restart or a revision reset", () => {
    expect(undoReach(step(), snap({ project_path: "C:/p/other.aep" }), SERVICE)).toMatchObject({ reach: "not_reachable" });
    expect(undoReach(step({ build: "99" }), snap(), SERVICE).why).toContain("build changed");
    expect(undoReach(step(), snap({ revision: 3 }), SERVICE).why).toContain("revision");
    expect(undoReach(step({ revision_after: null }), snap({ revision: 3 }), SERVICE).reach).toBe("possibly_reachable");
  });
});

describe("undoReach, service reload and Save As", () => {
  const step = (extra: Partial<UndoStep> = {}): UndoStep => ({
    op_id: "op_1",
    tool: "x",
    label: "x",
    at: "2026-11-03T10:00:00.000Z",
    project_path: "<unsaved>",
    service_id: SERVICE,
    revision_after: null,
    checkpoint: null,
    build: "100",
    item_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    num_items: 10,
    ...extra,
  });
  const live = (extra: Partial<SessionSnapshot> = {}) =>
    snap({ project_path: "<unsaved>", num_items: 10, item_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ...extra });

  it("treats a service restart alone as possibly reachable: a CEP reload leaves the AE undo stack alone", () => {
    const r = undoReach(step(), live(), "svc-2");
    expect(r.reach).toBe("possibly_reachable");
    expect(r.why).toContain("panel service restarted");
  });

  it("calls a new path with the same items a likely Save As, and a different item set another project", () => {
    const saved = undoReach(step(), live({ project_path: "C:/p/saved.aep" }), SERVICE);
    expect(saved.reach).toBe("possibly_reachable");
    expect(saved.why).toContain("Save As");
    const other = undoReach(step(), live({ project_path: "C:/p/other.aep", item_ids: [41, 42, 43], num_items: 3 }), SERVICE);
    expect(other.reach).toBe("not_reachable");
    // No item record on the step (an older state file): no basis for Save As.
    expect(undoReach(step({ item_ids: undefined, num_items: undefined }), live({ project_path: "C:/p/saved.aep" }), SERVICE).reach).toBe("not_reachable");
  });
});

describe("SessionTracker write-ahead record", () => {
  it("treats an old record as dead even when its pid is alive (pid reuse)", () => {
    const dir = tmp();
    const early = new Date("2026-11-03T10:00:00.000Z");
    const old = new SessionTracker({ dataDir: dir, pid: 111, now: () => early });
    old.begin({ op_id: "op_old", tool: "t", label: "l", project_path: "p", comp_id: null, last_known_hash: null });
    const store = new QuarantineStore(path.join(dir, "q.json"));
    const later = new Date(early.getTime() + 60 * 60_000);
    const fresh = new SessionTracker({ dataDir: dir, pid: 222, isPidAlive: () => true, now: () => later });
    expect(fresh.recoverInterrupted(store).map((o) => o.op_id)).toEqual(["op_old"]);
    expect(store.get("op_old")).toBeDefined();
    // Within the age limit a live foreign pid still means a live write.
    const young = new SessionTracker({ dataDir: dir, pid: 111, now: () => early });
    young.begin({ op_id: "op_live", tool: "t", label: "l", project_path: "p", comp_id: null, last_known_hash: null });
    const soon = new SessionTracker({ dataDir: dir, pid: 222, isPidAlive: () => true, now: () => new Date(early.getTime() + 60_000) });
    expect(soon.recoverInterrupted(store)).toEqual([]);
  });

  it("recovers an op a dead service left behind into quarantine, once", () => {
    const dir = tmp();
    const first = new SessionTracker({ dataDir: dir, pid: 111 });
    first.begin({ op_id: "op_9", tool: "ae_create_layer", label: "make layer", project_path: "C:/p/show.aep", comp_id: 5, last_known_hash: "aaaa" });
    expect(fs.existsSync(first.inflightPath)).toBe(true);

    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const second = new SessionTracker({ dataDir: dir, pid: 222, isPidAlive: () => false });
    const found = second.recoverInterrupted(quarantine);
    expect(found.map((o) => o.op_id)).toEqual(["op_9"]);
    expect(found[0]).toMatchObject({ project_path: "C:/p/show.aep", last_known_hash: "aaaa" });
    expect(quarantine.get("op_9")?.reason).toContain("Do not retry");
    expect(fs.existsSync(second.inflightPath)).toBe(false);
    expect(second.recoverInterrupted(quarantine)).toEqual([]);
    // The interrupted list and the op's project survive another restart.
    const third = new SessionTracker({ dataDir: dir, pid: 333 });
    expect(third.interrupted().map((o) => o.op_id)).toEqual(["op_9"]);
    expect(third.projectOfOp("op_9")).toBe("C:/p/show.aep");
  });

  it("leaves another live process's record alone", () => {
    const dir = tmp();
    new SessionTracker({ dataDir: dir, pid: 111 }).begin({ op_id: "op_1", tool: "t", label: "l", project_path: "<unsaved>", comp_id: null, last_known_hash: null });
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const other = new SessionTracker({ dataDir: dir, pid: 222, isPidAlive: (pid) => pid === 111 });
    expect(other.recoverInterrupted(quarantine)).toEqual([]);
    expect(quarantine.isQuarantined).toBe(false);
    expect(fs.existsSync(other.inflightPath)).toBe(true);
  });

  it("end() clears the record and keeps other ops' records", () => {
    const dir = tmp();
    const t = new SessionTracker({ dataDir: dir });
    t.begin({ op_id: "a", tool: "t", label: "l", project_path: "p", comp_id: null, last_known_hash: null });
    t.begin({ op_id: "b", tool: "t", label: "l", project_path: "p", comp_id: null, last_known_hash: null });
    t.end("a");
    expect(JSON.parse(fs.readFileSync(t.inflightPath, "utf8")).ops.map((o: { op_id: string }) => o.op_id)).toEqual(["b"]);
    t.end("b");
    expect(fs.existsSync(t.inflightPath)).toBe(false);
  });

  it("keeps baselines per project and across a restart", () => {
    const dir = tmp();
    const t = new SessionTracker({ dataDir: dir });
    t.record(snap(), { op_id: "op_1", tool: "x" });
    t.record(snap({ project_path: "C:/p/other.aep" }), { op_id: "op_2", tool: "x" });
    expect(t.baselineFor("C:/p/show.aep")?.op_id).toBe("op_1");
    expect(t.baselineFor("C:/p/other.aep")?.op_id).toBe("op_2");
    if (process.platform === "win32") expect(t.baselineFor("c:\\P\\SHOW.aep")?.op_id).toBe("op_1");
    expect(t.baselineFor("C:/p/nope.aep")).toBeNull();
    expect(t.lastBaseline()?.project_path).toBe("C:/p/other.aep");
    const again = new SessionTracker({ dataDir: dir });
    expect(again.lastBaseline()?.op_id).toBe("op_2");
    expect(again.serviceId).not.toBe(t.serviceId);
  });
});

// ---------- the write flow with tracking on ----------

type Handler = (script: string) => unknown;

/** A PanelHost whose AE answers each host function from a handler, recording the order. */
function fakeAe(handlers: Record<string, Handler>, dir: string) {
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const h = handlers[fn];
      if (!h) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: h(script), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir };
  return { ctx, calls, quarantine };
}

const stack = (n: number) => ({
  comp_id: 1,
  name: "Main",
  numLayers: n,
  layers: Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    id: 10 + i,
    name: i === 0 && n === 2 ? "Ctrl" : `L${i}`,
    kind: i === 0 && n === 2 ? "null" : "solid",
    enabled: true,
    parent: null,
    trackMatte: { type: "none", layer: null },
  })),
});

const createTool = layersTools.find((t) => t.name === "ae_create_layer")!;
const createArgs = () => createTool.schema.parse({ comp_id: 1, type: "null", name: "Ctrl", expect: { project_path: "<unsaved>" } });
const unsavedSnap = (extra: Partial<SessionSnapshot> = {}) => snap({ project_path: "<unsaved>", comps: [comp(1, { name: "Main" })], ...extra });

describe("guarded write with session tracking", () => {
  it("adds no calls and no fields while tracking is off", async () => {
    const { ctx, calls } = fakeAe(
      { layerStack: () => stack(1), createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }) },
      tmp()
    );
    const out: any = await createTool.handler(createArgs(), ctx);
    expect(calls).toEqual(["checkGuard", "layerStack", "createLayer", "layerStack"]);
    expect(out.user_changed).toBeUndefined();
    expect(getSessionTracker()).toBeNull();
  });

  it("keeps a baseline after a write, reports the user's edit on the next, and holds a record during the write", async () => {
    const dir = tmp();
    let sessionReads = 0;
    let recordDuringWrite: unknown = null;
    let layers = 1;
    const { ctx, calls } = fakeAe(
      {
        layerStack: () => stack(layers + 1 > 2 ? 2 : layers + 1),
        createLayer: () => {
          recordDuringWrite = fs.existsSync(path.join(dir, "inflight-ops.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "inflight-ops.json"), "utf8")) : null;
          layers++;
          return { index: 1, id: 11, name: "Ctrl", kind: "null" };
        },
        sessionSnapshot: () => {
          sessionReads++;
          // 1st read: after write 1. 2nd and 3rd: before and after write 2, where the user added a layer.
          return sessionReads === 1 ? unsavedSnap() : unsavedSnap({ comps: [comp(1, { name: "Main", num_layers: 4, hash: "changed" })] });
        },
      },
      dir
    );
    installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });

    // Write 1: no baseline yet, so no before-read of the session; one after-read.
    const first: any = await createTool.handler(createArgs(), ctx);
    expect(calls).toEqual(["checkGuard", "layerStack", "createLayer", "layerStack", "sessionSnapshot"]);
    expect(first.user_changed).toBeUndefined();
    expect(recordDuringWrite).toMatchObject({ ops: [{ tool: "ae_create_layer", project_path: "<unsaved>" }] });
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);

    // Write 2: the before-read finds the user's change; the write result still reports normally.
    calls.length = 0;
    layers = 1;
    const second: any = await createTool.handler(createArgs(), ctx);
    expect(calls).toEqual(["checkGuard", "sessionSnapshot", "layerStack", "createLayer", "layerStack", "sessionSnapshot"]);
    expect(second.applied).toBe(true);
    expect(second.user_changed).toContain("layers 3 -> 4");
    expect(getSessionTracker()!.steps().map((s) => s.tool)).toEqual(["ae_create_layer", "ae_create_layer"]);
  });

  it("clears the record when the write fails with a known outcome, and never fails the write over bookkeeping", async () => {
    const dir = tmp();
    const { ctx } = fakeAe(
      {
        layerStack: () => stack(1),
        createLayer: () => {
          throw new Error("host said no");
        },
        sessionSnapshot: () => {
          throw new Error("snapshot broke");
        },
      },
      dir
    );
    installSessionTracking({ dataDir: dir });
    await expect(createTool.handler(createArgs(), ctx)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);

    // A write that succeeds while the snapshot read fails still returns its result.
    const ok = fakeAe({ layerStack: () => stack(1), createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }), sessionSnapshot: () => { throw new Error("snapshot broke"); } }, dir);
    const out: any = await createTool.handler(createArgs(), ok.ctx);
    expect(out.applied).toBe(true);
  });
});

// ---------- the tool ----------

describe("ae_session_changes", () => {
  it("reports no baseline, then a change after rebase", async () => {
    const dir = tmp();
    let live = unsavedSnap();
    const { ctx, calls } = fakeAe({ sessionSnapshot: () => live }, dir);
    installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });

    const empty: any = await tool.handler(AeSessionChangesSchema.parse({ rebase: true }), ctx);
    expect(calls).toEqual(["sessionSnapshot"]);
    expect(empty.baseline).toBeNull();
    expect(empty.changes).toBeNull();
    expect(empty.notes.join(" ")).toContain("No write has been recorded");
    expect(empty.rebased).toBe(true);

    live = unsavedSnap({ comps: [comp(1, { name: "Main", selected: [4] })], item_ids: [1, 2, 3, 4], num_items: 4 });
    const next: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(next.baseline.tool).toContain("rebase");
    expect(next.changes.changed).toBe(true);
    expect(next.changes.comps[0].selection_changed).toBe(true);
    expect(next.changes.items.added).toEqual([4]);
  });

  it("lists interrupted ops, flags a stale quarantine entry and an orphaned render job", async () => {
    const dir = tmp();
    new SessionTracker({ dataDir: dir, pid: 111 }).begin({ op_id: "op_old", tool: "ae_create_layer", label: "make", project_path: "C:/p/old.aep", comp_id: 3, last_known_hash: null });
    fs.mkdirSync(path.join(dir, "renders"));
    fs.writeFileSync(
      path.join(dir, "renders", "jobs.json"),
      JSON.stringify({
        jobs: [
          { job_id: "job_a", state: "running", pid: 2147483000, project_path: "C:/p/old.aep", comp_name: "Main" },
          { job_id: "job_b", state: "succeeded", pid: 1 },
        ],
      })
    );
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap() }, dir);
    installSessionTracking({
      dataDir: dir,
      quarantine: ctx.quarantine,
      pid: 222,
      isPidAlive: () => false,
      rendersJobsFile: path.join(dir, "renders", "jobs.json"),
    });

    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(out.interrupted_ops.map((o: { op_id: string }) => o.op_id)).toEqual(["op_old"]);
    expect(out.quarantine).toMatchObject([{ op_id: "op_old", project_path: "C:/p/old.aep", stale: true }]);
    expect(out.notes.join(" ")).toContain("not open");
    expect(out.render_jobs_running).toHaveLength(1);
    expect(out.render_jobs_running[0]).toMatchObject({ job_id: "job_a", orphaned: true });
  });

  it("lists undo steps newest first with their reach, and can leave them out", async () => {
    const dir = tmp();
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap() }, dir);
    const t = installSessionTracking({ dataDir: dir });
    const step = (op: string, projectPath: string): UndoStep => ({ op_id: op, tool: "x", label: op, at: "2026-11-03T10:00:00.000Z", project_path: projectPath, service_id: t.serviceId, revision_after: null, checkpoint: null });
    t.addStep(step("op_a", "<unsaved>"));
    t.addStep(step("op_b", "C:/p/gone.aep"));
    const out: any = await tool.handler(AeSessionChangesSchema.parse({ max_undo_steps: 5 }), ctx);
    expect(out.undo_steps.map((s: { op_id: string; reach: string }) => [s.op_id, s.reach])).toEqual([
      ["op_b", "not_reachable"],
      ["op_a", "possibly_reachable"],
    ]);
    const none: any = await tool.handler(AeSessionChangesSchema.parse({ include_undo_steps: false }), ctx);
    expect(none.undo_steps).toBeUndefined();
  });
});

// ---------- the host function under node:vm ----------

describe("session.jsx", () => {
  function scene() {
    const project = new FakeProject();
    const main = project.addComp("Main", 640, 360, 4);
    project.addComp("Other", 320, 180, 2);
    const A = loadHost(project, ["layers.jsx", "session.jsx"]).A;
    A.createLayer({ comp_id: main.id, type: "null", name: "Ctrl", expect: { project_path: "<unsaved>" } });
    A.createLayer({ comp_id: main.id, type: "solid", name: "BG", expect: { project_path: "<unsaved>" } });
    return { project, main, A };
  }

  it("reads the project, the active comp and its layer stack", () => {
    const { project, main, A } = scene();
    (project as any).activeItem = main;
    (main as any).selectedLayers = [main.layer(1)];
    main.time = 1.5;
    const s = A.sessionSnapshot({});
    expect(s).toMatchObject({ project_path: "<unsaved>", dirty: false, revision: null, num_items: 3, items_truncated: false });
    expect(s.item_ids).toHaveLength(s.num_items);
    expect(s.active_item).toMatchObject({ id: main.id, kind: "comp" });
    expect(s.comps).toHaveLength(1);
    expect(s.comps[0]).toMatchObject({ id: main.id, num_layers: 2, selected: [main.layer(1)!.id], time: 1.5, work_area_duration: 4 });
    expect(s.comps[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes the hash when a layer is renamed or moved, not when only time moves", () => {
    const { main, A } = scene();
    const hash = () => A.sessionSnapshot({ comp_ids: [main.id] }).comps[0].hash;
    const h0 = hash();
    main.time = 2;
    expect(hash()).toBe(h0);
    main.layer(1)!.name = "Renamed";
    const h1 = hash();
    expect(h1).not.toBe(h0);
    main.layer(1)!.moveToEnd();
    const h2 = hash();
    expect(h2).not.toBe(h1);
    main.layer(1)!.outPoint = 1;
    const h3 = hash();
    expect(h3).not.toBe(h2);
    main.layer(1)!.inPoint = 0.5;
    expect(hash()).not.toBe(h3);
  });

  it("reads the asked-for comps, marks a missing one, and keeps the active comp once", () => {
    const { project, main, A } = scene();
    (project as any).activeItem = main;
    const other = project.all.find((x) => x.name === "Other")!;
    const s = A.sessionSnapshot({ comp_ids: [main.id, other.id, 99999] });
    expect(s.comps.map((c: { id: number }) => c.id)).toEqual([main.id, other.id, 99999]);
    expect(s.comps[2]).toMatchObject({ id: 99999, missing: true });
  });

  it("copes with a project that has no active item, no revision and no selectedLayers", () => {
    const { A } = scene();
    const s = A.sessionSnapshot({});
    expect(s.active_item).toBeNull();
    expect(s.comps).toEqual([]);
    expect(s.render_queue).toMatchObject({ num_items: 0 });
  });

  it("reports Project.revision when AE gives one, and the build when it has one", () => {
    const project = new FakeProject();
    project.addComp("Main");
    (project as any).revision = 42;
    const { A } = loadHost(project, ["session.jsx"], { buildNumber: 77 });
    expect(A.sessionSnapshot({})).toMatchObject({ revision: 42, build: "77", ae_version: "26.2.1" });
  });

  it("changes nothing: no undo group, no state touched", () => {
    const { project, main, A } = scene();
    (project as any).activeItem = main;
    main.time = 3;
    const before = JSON.stringify({ t: main.time, n: main.numLayers, names: main.stack.map((l) => l.name) });
    const undoState = loadHost(project, ["session.jsx"]);
    undoState.A.sessionSnapshot({ comp_ids: [main.id] });
    expect(undoState.undo).toEqual({ begun: 0, ended: 0 });
    expect(JSON.stringify({ t: main.time, n: main.numLayers, names: main.stack.map((l) => l.name) })).toBe(before);
    expect((project as any).activeItem).toBe(main);
  });
});

// ---------- the fixes from review ----------

const argIds = (script: string): number[] => JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")"))).comp_ids ?? [];
const compsFor = (script: string, make: (id: number) => SessionCompState | { id: number; missing: true }) => argIds(script).map(make);

describe("ae_session_changes, comp ids", () => {
  it("accepts at most 20 comp ids, the most one snapshot reads", () => {
    expect(AeSessionChangesSchema.safeParse({ comp_ids: Array.from({ length: 20 }, (_, i) => i) }).success).toBe(true);
    expect(AeSessionChangesSchema.safeParse({ comp_ids: Array.from({ length: 21 }, (_, i) => i) }).success).toBe(false);
  });

  it("says how many tracked comps did not fit in one read", async () => {
    const dir = tmp();
    const { ctx } = fakeAe(
      { sessionSnapshot: (script) => unsavedSnap({ comps: compsFor(script, (id) => comp(id)) as SessionCompState[] }) },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap({ comps: Array.from({ length: 24 }, (_, i) => comp(100 + i)) }), { op_id: "op_1", tool: "x" });
    const out: any = await tool.handler(AeSessionChangesSchema.parse({ comp_ids: [1, 2] }), ctx);
    expect(out.comps_not_read).toBe(6);
    expect(out.live.comps).toHaveLength(20);
    expect(out.live.comps.slice(0, 2).map((c: { id: number }) => c.id)).toEqual([1, 2]);
    expect(out.notes.join(" ")).toContain("comps_not_read");
  });
});

describe("ae_session_changes, another project open", () => {
  it("reads the open project's own touched comps and says it differs from the last write's project", async () => {
    const dir = tmp();
    const reads: number[][] = [];
    const { ctx } = fakeAe(
      {
        sessionSnapshot: (script) => {
          reads.push(argIds(script));
          return snap({
            project_path: "C:/p/b.aep",
            comps: compsFor(script, (id) => (id === 7 ? comp(7, { hash: "edited" }) : { id, missing: true })) as SessionCompState[],
          });
        },
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(snap({ project_path: "C:/p/b.aep", comps: [comp(7)] }), { op_id: "op_b", tool: "x" });
    t.record(snap({ project_path: "C:/p/a.aep", comps: [comp(1)] }), { op_id: "op_a", tool: "x" });

    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(reads).toEqual([[1], [7]]);
    expect(out.project_switched_since_last_write).toBe(true);
    expect(out.last_write_project).toBe("C:/p/a.aep");
    expect(out.baseline.op_id).toBe("op_b");
    expect(out.changes.project_swapped).toBe(false);
    expect(out.changes.comps.find((c: { id: number }) => c.id === 7)).toMatchObject({ status: "changed", stack_changed: true });
    expect(out.notes.join(" ")).toContain("not the one the last write was in");
  });

  it("does not read twice when the open project is the last write's", async () => {
    const dir = tmp();
    const reads: number[][] = [];
    const { ctx } = fakeAe(
      {
        sessionSnapshot: (script) => {
          reads.push(argIds(script));
          return snap({ comps: [comp(5)] });
        },
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(snap(), { op_id: "op_1", tool: "x" });
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(reads).toHaveLength(1);
    expect(out.project_switched_since_last_write).toBe(false);
  });
});

describe("ae_session_changes, interrupted ops", () => {
  it("compares the interrupted op's comp with the hash recorded, and moves acknowledged ops out", async () => {
    const dir = tmp();
    new SessionTracker({ dataDir: dir, pid: 111 }).begin({
      op_id: "op_cut",
      tool: "ae_create_layer",
      label: "make",
      project_path: "<unsaved>",
      comp_id: 3,
      last_known_hash: "aaaa1111",
    });
    const { ctx, quarantine } = fakeAe(
      { sessionSnapshot: (script) => unsavedSnap({ comps: compsFor(script, (id) => comp(id, { hash: "bbbb2222" })) as SessionCompState[] }) },
      dir
    );
    installSessionTracking({ dataDir: dir, quarantine, pid: 222, isPidAlive: () => false });

    const first: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(first.interrupted_ops).toHaveLength(1);
    expect(first.interrupted_ops[0]).toMatchObject({
      op_id: "op_cut",
      acknowledged: false,
      in_open_project: true,
      comp_found: true,
      hash_now: "bbbb2222",
      stack_changed_since_record: true,
    });
    expect(first.acknowledged_interrupted_ops).toEqual([]);
    expect(first.notes.join(" ")).toContain("do not retry");

    quarantine.acknowledge("op_cut", "checked", "test");
    const second: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(second.interrupted_ops).toEqual([]);
    expect(second.acknowledged_interrupted_ops.map((o: { op_id: string }) => o.op_id)).toEqual(["op_cut"]);
  });

  it("gives no hash comparison for an op in another project", async () => {
    const dir = tmp();
    new SessionTracker({ dataDir: dir, pid: 111 }).begin({ op_id: "op_x", tool: "t", label: "l", project_path: "C:/p/old.aep", comp_id: 3, last_known_hash: "aaaa1111" });
    const { ctx, quarantine } = fakeAe({ sessionSnapshot: () => unsavedSnap() }, dir);
    installSessionTracking({ dataDir: dir, quarantine, pid: 222, isPidAlive: () => false });
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(out.interrupted_ops[0]).toMatchObject({ in_open_project: false, hash_now: null, stack_changed_since_record: null });
  });
});

describe("render jobs file", () => {
  it("reads jobs.json from the configured path, not from under the data dir", async () => {
    const dir = tmp();
    const elsewhere = path.join(tmp(), "jobs.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ jobs: [{ job_id: "job_z", state: "running", pid: 2147483000, project_path: "p", comp_name: "C" }] }));
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap() }, dir);
    installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine, rendersJobsFile: elsewhere, isPidAlive: () => false });
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(out.render_jobs_running.map((j: { job_id: string }) => j.job_id)).toEqual(["job_z"]);
  });
});

describe("the other guarded writes", () => {
  const byName = (n: string) => mutateTools.find((t) => t.name === n)!;

  it("ae_set_property keeps a record during the write, reads the session around it and reports the user's edit", async () => {
    const dir = tmp();
    let reads = 0;
    let record: unknown = null;
    const { ctx, calls } = fakeAe(
      {
        getLayerProps: () => ({}),
        setProperty: () => {
          record = fs.existsSync(path.join(dir, "inflight-ops.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "inflight-ops.json"), "utf8")) : null;
          return {};
        },
        sessionSnapshot: () => (++reads === 1 ? unsavedSnap() : unsavedSnap({ comps: [comp(1, { name: "Main", num_layers: 9, hash: "user" })] })),
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    reads = 1;
    const args = byName("ae_set_property").schema.parse({ comp_id: 1, layer: { index: 1 }, path: ["Transform", "Opacity"], value: 50, expect: { project_path: "<unsaved>" } });
    const out: any = await byName("ae_set_property").handler(args, ctx);
    expect(calls.filter((c) => c === "sessionSnapshot")).toHaveLength(2);
    expect(record).toMatchObject({ ops: [{ tool: "ae_set_property" }] });
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);
    expect(out.user_changed).toContain("layers 3 -> 9");
    expect(t.lastBaseline()?.tool).toBe("ae_set_property");
  });

  it("ae_run_jsx (mutating) does the same", async () => {
    const dir = tmp();
    let reads = 0;
    let record: unknown = null;
    const { ctx, calls } = fakeAe(
      {
        snapshotForReceipt: () => ({}),
        runUserJsx: () => {
          record = fs.existsSync(path.join(dir, "inflight-ops.json"));
          return { ok: true };
        },
        sessionSnapshot: () => (++reads === 1 ? unsavedSnap() : unsavedSnap({ comps: [comp(1, { name: "Main", num_layers: 7, hash: "user" })] })),
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    reads = 1;
    const args = byName("ae_run_jsx").schema.parse({ code: "1", mutates: true, label: "do it", expect: { project_path: "<unsaved>", comp_id: 1 } });
    const out: any = await byName("ae_run_jsx").handler(args, ctx);
    expect(calls.filter((c) => c === "sessionSnapshot")).toHaveLength(2);
    expect(record).toBe(true);
    expect(out.user_changed).toContain("layers 3 -> 7");
    expect(t.steps().map((s) => s.tool)).toEqual(["ae_run_jsx"]);
  });
});

describe("installSessionBridgeHook (unguarded mutating tools)", () => {
  function setup(snapshots: SessionSnapshot[]) {
    const dir = tmp();
    const order: string[] = [];
    let n = 0;
    let recordDuring = false;
    const { ctx } = fakeAe(
      {
        sessionSnapshot: () => {
          order.push("snapshot");
          return snapshots[Math.min(n++, snapshots.length - 1)];
        },
        importFile: () => {
          order.push("write");
          recordDuring = fs.existsSync(path.join(dir, "inflight-ops.json"));
          return { ok: true };
        },
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    const write = () => ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "ae_import_assets" });
    return { ctx, t, order, write, dir, recordDuring: () => recordDuring };
  }

  it("moves the baseline after an unguarded write, so the agent's own change is not reported as the user's", async () => {
    const s0 = unsavedSnap();
    const s1 = unsavedSnap({ num_items: 4, item_ids: [1, 2, 3, 4] });
    const { t, write, order, recordDuring, dir } = setup([s0, s1]);
    t.record(s0, { op_id: "op_0", tool: "x" });
    await write();
    expect(order).toEqual(["snapshot", "write", "snapshot"]);
    expect(recordDuring()).toBe(true);
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);
    expect(t.lastBaseline()).toMatchObject({ num_items: 4, tool: "ae_import_assets" });
    expect(diffSnapshots(t.lastBaseline()!, s1, t.serviceId).user_changed).toBeNull();
    expect(t.pendingUserChanged).toBeNull();
  });

  it("keeps what the user changed before the unguarded write for the next guarded receipt", async () => {
    const s0 = unsavedSnap();
    const edited = unsavedSnap({ comps: [comp(1, { name: "Main", num_layers: 8, hash: "user" })] });
    const { t, write } = setup([edited, edited]);
    t.record(s0, { op_id: "op_0", tool: "x" });
    await write();
    expect(t.pendingUserChanged).toContain("layers 3 -> 8");
  });

  it("skips guarded writes, which already keep their own record", async () => {
    const dir = tmp();
    const { ctx, calls } = fakeAe(
      {
        layerStack: () => stack(1),
        createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }),
        sessionSnapshot: () => unsavedSnap(),
      },
      dir
    );
    installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    await createTool.handler(createArgs(), ctx);
    // One after-read from the guarded flow, none from the hook.
    expect(calls.filter((c) => c === "sessionSnapshot")).toHaveLength(1);
  });

  it("clears the record when the write fails, and the unhook restores the bridge", async () => {
    const dir = tmp();
    const { ctx } = fakeAe(
      {
        sessionSnapshot: () => unsavedSnap(),
        importFile: () => {
          throw new Error("no");
        },
      },
      dir
    );
    installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    const before = ctx.bridge.evalRaw;
    const unhook = installSessionBridgeHook(ctx.bridge);
    expect(ctx.bridge.evalRaw).not.toBe(before);
    await expect(ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "ae_import_assets" })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);
    unhook();
    expect(ctx.bridge.evalRaw).toBe(before);
  });

  it("does nothing with tracking off", async () => {
    const dir = tmp();
    const { ctx, calls } = fakeAe({ sessionSnapshot: () => unsavedSnap(), importFile: () => ({}) }, dir);
    installSessionBridgeHook(ctx.bridge);
    await ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "t" });
    expect(calls).toEqual(["importFile"]);
  });
});

describe("session.jsx hash budget", () => {
  it("hashes whole comps within a total budget and skips the rest instead of hashing part of them", () => {
    const project = new FakeProject();
    const big = project.addComp("Big", 640, 360, 4);
    const small = project.addComp("Small", 640, 360, 4);
    const { A } = loadHost(project, ["layers.jsx", "session.jsx"]);
    for (let i = 0; i < 3; i++) A.createLayer({ comp_id: small.id, type: "null", name: `S${i}`, expect: { project_path: "<unsaved>" } });
    // Make the big comp look huge without creating 5000 layers.
    Object.defineProperty(big, "numLayers", { get: () => 5001 });
    const s = A.sessionSnapshot({ comp_ids: [big.id, small.id] });
    const b = s.comps.find((c: { id: number }) => c.id === big.id);
    const sm = s.comps.find((c: { id: number }) => c.id === small.id);
    expect(b).toMatchObject({ num_layers: 5001, hash: "", hash_truncated: true });
    expect(sm.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(sm.hash_truncated).toBe(false);
  });
});

// ---------- review fixes ----------

describe("undo reach after a reopen, and unsaved projects", () => {
  const step = (extra: Partial<UndoStep> = {}): UndoStep => ({
    op_id: "op_1",
    tool: "x",
    label: "x",
    at: "2020-01-01T00:00:00.000Z",
    project_path: "C:/p/show.aep",
    service_id: SERVICE,
    revision_after: null,
    checkpoint: null,
    build: "100",
    item_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    num_items: 10,
    ...extra,
  });
  const live = (extra: Partial<SessionSnapshot> = {}) =>
    snap({ project_path: "C:/p/_mcp_backups/show.aep", num_items: 10, item_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ...extra });

  it("checkpoint revert, then the same item ids at a new path: not reachable", () => {
    // Without the marker the item match reads as a Save As.
    expect(undoReach(step(), live(), SERVICE).reach).toBe("possibly_reachable");
    const r = undoReach(step(), live(), SERVICE, { reopenedAt: "2020-06-01T00:00:00.000Z" });
    expect(r.reach).toBe("not_reachable");
    expect(r.why).toContain("reopened");
    // Even at the same path.
    expect(undoReach(step(), live({ project_path: "C:/p/show.aep" }), SERVICE, { reopenedAt: "2020-06-01T00:00:00.000Z" }).reach).toBe("not_reachable");
    // A step made after the reopen is not affected.
    const later = step({ at: "2021-01-01T00:00:00.000Z", project_path: "C:/p/_mcp_backups/show.aep" });
    expect(undoReach(later, live(), SERVICE, { reopenedAt: "2020-06-01T00:00:00.000Z" }).reach).toBe("possibly_reachable");
  });

  it("treats two unsaved projects with hardly any shared items as different projects", () => {
    const other = snap({ project_path: "<unsaved>", item_ids: [41, 42, 43], num_items: 3 });
    const d = diffSnapshots(stored({ project_path: "<unsaved>" }), other, SERVICE);
    expect(d.project_swapped).toBe(true);
    expect(d.items).toBeNull();
    const same = diffSnapshots(stored({ project_path: "<unsaved>" }), snap({ project_path: "<unsaved>", item_ids: [1, 2, 3, 4], num_items: 4 }), SERVICE);
    expect(same.project_swapped).toBe(false);
    expect(same.items).toMatchObject({ added: [4] });
    const r = undoReach(step({ project_path: "<unsaved>" }), snap({ project_path: "<unsaved>", item_ids: [41, 42, 43], num_items: 3 }), SERVICE);
    expect(r.reach).toBe("not_reachable");
  });

  it("the bridge hook marks a project reopen, and ae_session_changes then proves older steps gone", async () => {
    const dir = tmp();
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap(), openProject: () => ({ ok: true }) }, dir);
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    t.addStep({ ...step({ project_path: "<unsaved>" }), item_ids: [1, 2, 3], num_items: 3 });
    expect(t.reopenedAt()).toBeNull();
    await ctx.bridge.callHost("openProject" as never, {}, { label: "revert", mutates: true, toolName: "ae_checkpoint_revert" });
    expect(t.reopenedAt()).not.toBeNull();
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(out.undo_steps[0]).toMatchObject({ reach: "not_reachable" });
  });

  it("marks the reopen even when the open itself throws, so older steps still read not_reachable", async () => {
    const dir = tmp();
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap(), openProject: () => { throw new Error("modal dialog"); } }, dir);
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    t.addStep({ ...step({ project_path: "<unsaved>" }), item_ids: [1, 2, 3], num_items: 3 });
    await expect(ctx.bridge.callHost("openProject" as never, {}, { label: "revert", mutates: true, toolName: "ae_checkpoint_revert" })).rejects.toThrow();
    expect(t.reopenedAt()).not.toBeNull();
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(out.undo_steps[0]).toMatchObject({ reach: "not_reachable" });
  });
});

describe("tracker bookkeeping", () => {
  it("tells a receipt how many pending change lines were dropped, and forgets the count once reported", () => {
    const t = new SessionTracker({ dataDir: tmp() });
    for (let i = 0; i < 13; i++) t.addPending(`change number ${i}`);
    const taken = t.takePendingFor("op_1");
    expect(taken.lines.length).toBeLessThan(13);
    expect(taken.note).toMatch(/\(\d+ earlier change line\(s\) dropped\)/);
    t.commitReported("op_1");
    expect(t.pendingUserChanged).toBeNull();
    t.addPending("fresh");
    expect(t.takePendingFor("op_2").note).toBe("");
  });

  it("does not remember an unknown project as an op's project, so its quarantine entry is not called stale", () => {
    const t = new SessionTracker({ dataDir: tmp() });
    t.begin({ op_id: "op_u", tool: "ae_import_assets", label: "import", project_path: "<unknown>", comp_id: null, last_known_hash: null });
    t.begin({ op_id: "op_k", tool: "x", label: "x", project_path: "C:/p/show.aep", comp_id: null, last_known_hash: null });
    expect(t.projectOfOp("op_u")).toBeNull();
    expect(t.projectOfOp("op_k")).toBe("C:/p/show.aep");
  });

  it("starts empty from a state file of the wrong shape, and installing never throws", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "session-state.json"), JSON.stringify({ last_key: "k", snapshots: null, touched: [], steps: "x", op_projects: 5, interrupted: {} }));
    const t = new SessionTracker({ dataDir: dir });
    expect(t.lastBaseline()).toBeNull();
    expect(t.steps()).toEqual([]);
    expect(t.interrupted()).toEqual([]);
    expect(() => installSessionTracking({ dataDir: dir })).not.toThrow();
    fs.writeFileSync(path.join(dir, "session-state.json"), JSON.stringify({ snapshots: { a: { project_path: 1 } }, last_key: "a" }));
    expect(new SessionTracker({ dataDir: dir }).lastBaseline()).toBeNull();
  });

  it("caps the pending user-change lines and drops duplicates", () => {
    const t = new SessionTracker({ dataDir: tmp() });
    t.addPending("Since the last write: a.");
    t.addPending("Since the last write: a.");
    expect(t.pendingUserChanged).toBe("Since the last write: a.");
    for (let i = 0; i < 15; i++) t.addPending(`Since the last write: change ${i}.`);
    const text = t.pendingUserChanged!;
    expect(text).toContain("change 14");
    expect(text).not.toContain("change 0.");
    expect(text).toContain("earlier change line(s) dropped");
  });

  it("drops a project's touched comps when its baseline is evicted", () => {
    const t = new SessionTracker({ dataDir: tmp() });
    for (let i = 0; i < 12; i++) t.record(snap({ project_path: `C:/p/proj${i}.aep` }), { op_id: `op_${i}`, tool: "x" });
    expect(t.baselineFor("C:/p/proj0.aep")).toBeNull();
    expect(t.touchedComps("C:/p/proj0.aep")).toEqual([]);
    expect(t.touchedComps("C:/p/proj11.aep")).toEqual([5]);
  });
});

describe("session snapshots around a write", () => {
  const withTimeouts = (ctx: ToolContext) => {
    const seen: Array<{ fn: string; timeoutMs: number | undefined }> = [];
    const bridge = ctx.bridge as unknown as { evalRaw: (p: any) => Promise<unknown> };
    const orig = bridge.evalRaw.bind(bridge);
    bridge.evalRaw = (p: any) => {
      const script = String(p.script);
      seen.push({ fn: script.slice("__chromaAe.".length, script.indexOf("(")), timeoutMs: p.timeoutMs });
      return orig(p);
    };
    return seen;
  };

  it("gives the session snapshot reads a short timeout", async () => {
    const dir = tmp();
    const { ctx } = fakeAe(
      { layerStack: () => stack(1), createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }), sessionSnapshot: () => unsavedSnap() },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    const seen = withTimeouts(ctx);
    await createTool.handler(createArgs(), ctx);
    const snaps = seen.filter((s) => s.fn === "sessionSnapshot");
    expect(snaps).toHaveLength(2);
    for (const s of snaps) {
      expect(s.timeoutMs).toBe(SNAPSHOT_TIMEOUT_MS);
      expect(s.timeoutMs!).toBeLessThanOrEqual(15_000);
    }
  });

  it("skips the after-snapshot when the read-back failed", async () => {
    const dir = tmp();
    let stacks = 0;
    const { ctx, calls } = fakeAe(
      {
        layerStack: () => {
          if (++stacks > 1) throw new Error("AE is blocked");
          return stack(1);
        },
        createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }),
        sessionSnapshot: () => unsavedSnap(),
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    const out: any = await createTool.handler(createArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(JSON.stringify(out.receipt)).toContain("read_back");
    // Only the before-snapshot ran; no step and no new baseline.
    expect(calls.filter((c) => c === "sessionSnapshot")).toHaveLength(1);
    expect(t.steps()).toEqual([]);
    expect(t.lastBaseline()?.op_id).toBe("op_0");
  });

  it("skips the after-snapshot when the before-snapshot failed", async () => {
    const dir = tmp();
    const { ctx, calls } = fakeAe(
      {
        layerStack: () => stack(1),
        createLayer: () => ({ index: 1, id: 11, name: "Ctrl", kind: "null" }),
        sessionSnapshot: () => {
          throw new Error("timed out");
        },
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    const out: any = await createTool.handler(createArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(calls.filter((c) => c === "sessionSnapshot")).toHaveLength(1);
  });

  it("the hook skips its after-snapshot when its before-snapshot failed", async () => {
    const dir = tmp();
    const { ctx, calls } = fakeAe(
      {
        sessionSnapshot: () => {
          throw new Error("timed out");
        },
        importFile: () => ({ ok: true }),
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    await ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "ae_import_assets" });
    expect(calls).toEqual(["sessionSnapshot", "importFile"]);
    expect(fs.existsSync(path.join(dir, "inflight-ops.json"))).toBe(false);
  });

  it("the hook's first write with no baseline stores no project for the op", async () => {
    const dir = tmp();
    const { ctx } = fakeAe({ sessionSnapshot: () => unsavedSnap(), importFile: () => ({ ok: true }) }, dir);
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    await ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "ae_import_assets" });
    expect(Object.keys((t as any).state.op_projects)).toEqual([]);
  });
});

describe("pending user changes", () => {
  const edited = () => unsavedSnap({ comps: [comp(1, { name: "Main", num_layers: 8, hash: "user" })] });

  function setup() {
    const dir = tmp();
    let failCreate = true;
    const { ctx } = fakeAe(
      {
        layerStack: () => stack(1),
        createLayer: () => {
          if (failCreate) throw new Error("refused");
          return { index: 1, id: 11, name: "Ctrl", kind: "null" };
        },
        importFile: () => ({ ok: true }),
        sessionSnapshot: () => edited(),
      },
      dir
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    installSessionBridgeHook(ctx.bridge);
    t.record(unsavedSnap(), { op_id: "op_0", tool: "x" });
    return {
      ctx,
      t,
      allowCreate: () => {
        failCreate = false;
      },
    };
  }

  it("keeps the line when the guarded write fails, and clears it once a result carried it", async () => {
    const { ctx, t, allowCreate } = setup();
    await ctx.bridge.callHost("importFile" as never, {}, { label: "import", mutates: true, toolName: "ae_import_assets" });
    expect(t.pendingUserChanged).toContain("layers 3 -> 8");

    await expect(createTool.handler(createArgs(), ctx)).rejects.toThrow();
    expect(t.pendingUserChanged).toContain("layers 3 -> 8");

    allowCreate();
    const out: any = await createTool.handler(createArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.user_changed).toContain("layers 3 -> 8");
    expect(t.pendingUserChanged).toBeNull();
    const next: any = await createTool.handler(createArgs(), ctx);
    expect(next.user_changed).toBeUndefined();
  });

  it("does not repeat a change that is both pending and in the fresh diff", async () => {
    const { ctx, t, allowCreate } = setup();
    t.addPending(diffSnapshots(t.lastBaseline()!, edited(), t.serviceId).user_changed!);
    allowCreate();
    const out: any = await createTool.handler(createArgs(), ctx);
    expect(out.user_changed.match(/layers 3 -> 8/g)).toHaveLength(1);
  });
});

describe("ae_session_changes with tracking off", () => {
  it("does not install tracking from a read", async () => {
    const dir = tmp();
    const { ctx, calls } = fakeAe({ sessionSnapshot: () => unsavedSnap() }, dir);
    expect(getSessionTracker()).toBeNull();
    const out: any = await tool.handler(AeSessionChangesSchema.parse({}), ctx);
    expect(getSessionTracker()).toBeNull();
    expect(out.tracking_enabled).toBe(false);
    expect(out.live.project_path).toBe("<unsaved>");
    expect(out.undo_steps).toEqual([]);
    expect(out.notes.join(" ")).toContain("tracking is off");
    expect(calls).toEqual(["sessionSnapshot"]);
    expect(fs.existsSync(path.join(dir, "session-state.json"))).toBe(false);
  });
});

describe("session.jsx, bounded lists and deterministic hashing", () => {
  it("caps item_ids at 500 and says so", () => {
    const project = new FakeProject();
    for (let i = 0; i < 503; i++) project.addComp(`C${i}`, 64, 64, 1);
    const { A } = loadHost(project, ["layers.jsx", "session.jsx"]);
    const s = A.sessionSnapshot({});
    expect(s.num_items).toBe(503);
    expect(s.item_ids).toHaveLength(500);
    expect(s.items_truncated).toBe(true);
  });

  it("spends the hash budget in comp id order, whatever order the comps are asked in, and returns them in the asked order", () => {
    const project = new FakeProject();
    const a = project.addComp("A", 640, 360, 4);
    const b = project.addComp("B", 640, 360, 4);
    expect(a.id).toBeLessThan(b.id);
    const { A } = loadHost(project, ["layers.jsx", "session.jsx"]);
    for (let i = 0; i < 3; i++) A.createLayer({ comp_id: b.id, type: "null", name: "M" + i, expect: { project_path: "<unsaved>" } });
    // A reports 4998 layers (a stub keeps the hash loop cheap); with B's 3 the total is over the 5000 budget.
    Object.defineProperty(a, "numLayers", { get: () => 4998, configurable: true });
    (a as any).layer = (i: number) => ({ id: i, name: "L", inPoint: 0, outPoint: 1 });
    const x = A.sessionSnapshot({ comp_ids: [a.id, b.id] });
    const y = A.sessionSnapshot({ comp_ids: [b.id, a.id] });
    expect(y.comps.map((c: { id: number }) => c.id)).toEqual([b.id, a.id]);
    const get = (s: any, id: number) => s.comps.find((c: { id: number }) => c.id === id);
    for (const s of [x, y]) {
      expect(get(s, a.id).hash_truncated).toBe(false);
      expect(get(s, a.id).hash).not.toBe("");
      expect(get(s, b.id).hash_truncated).toBe(true);
      expect(get(s, b.id).hash).toBe("");
    }
    expect(get(x, a.id).hash).toBe(get(y, a.id).hash);
  });
});
