import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLOW_TIMEOUT_MS } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeProjectSessionSchema,
  autosaveDue,
  autosaveTick,
  countAgentWrites,
  countUnsavedWrites,
  disablePolicyForSwitch,
  emptyProjectMismatches,
  leaveVerdict,
  MAX_POLICY_BACKUPS,
  openMismatches,
  openNotes,
  prefsMismatches,
  projectsessionTools,
  recoveryDirs,
  scanRecoveryFiles,
  setAutosavePolicy,
  stopAutosavePolicy,
  type ProjectState,
} from "../src/tools/ext/projectsession.js";
import { getSessionTracker, installSessionTracking, resetSessionTracking, type UndoStep } from "../src/tools/ext/session.js";
import { FakeFootage, FakeProject, FileSource, GUARD, loadHost, PlaceholderSource } from "./support/fake-ae.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-projsess-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  stopAutosavePolicy();
  resetSessionTracking();
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = projectsessionTools[0];
const parse = (v: unknown) => AeProjectSessionSchema.safeParse(v);

const state = (over: Partial<ProjectState> = {}): ProjectState => ({
  project_path: "<unsaved>",
  dirty: false,
  num_items: 0,
  missing_footage: { count: 0, placeholders: 0, scanned: 0, truncated: false, paths: [] },
  active_item: null,
  save_project_on_crash: true,
  ae_version: "26.2.1",
  ...over,
});

type Scripted = unknown | Error;

/** A PanelHost whose AE answers from a script of results per host function; checkGuard reports `guardPath`. */
function fakeAe(results: Record<string, Scripted[]>, guardPath = "<unsaved>") {
  const calls: Array<{ fn: string; script: string; timeoutMs?: number }> = [];
  const dir = tmp();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: guardPath, comp_id: null, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      if (next instanceof Error) throw next;
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, dir };
}

const fns = (calls: Array<{ fn: string }>) => calls.map((c) => c.fn);

describe("ae_project_session schema", () => {
  it("is a mutating tool that takes expect and ends with the safety guidance", () => {
    expect(tool.name).toBe("ae_project_session");
    expect(tool.description).toContain("IMPORTANT: (1) Always re-read project/comp state");
    expect(parse({ action: "recover" }).success).toBe(true);
    expect(parse({ action: "autosave" }).success).toBe(true);
  });

  it("needs expect and a path for open, expect for new and close", () => {
    expect(parse({ action: "open", path: "C:/p/a.aep" }).success).toBe(false);
    expect(parse({ action: "open", expect: GUARD }).success).toBe(false);
    expect(parse({ action: "open", path: "C:/p/a.aep", expect: GUARD }).success).toBe(true);
    expect(parse({ action: "open", path: "relative/a.aep", expect: GUARD }).success).toBe(false);
    expect(parse({ action: "new" }).success).toBe(false);
    expect(parse({ action: "new", expect: GUARD, if_dirty: "discard" }).success).toBe(false);
    expect(parse({ action: "new", expect: GUARD, if_dirty: "discard", user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "close", expect: GUARD, if_dirty: "save" }).success).toBe(true);
    expect(parse({ action: "close", expect: GUARD }).success).toBe(true);
    expect(parse({ action: "close", expect: GUARD, if_dirty: "maybe" }).success).toBe(false);
  });

  it("keeps each option to its action", () => {
    expect(parse({ action: "close", expect: GUARD, path: "C:/p/a.aep" }).success).toBe(false);
    expect(parse({ action: "open", expect: GUARD, path: "C:/p/a.aep", limit: 5 }).success).toBe(false);
    expect(parse({ action: "recover", limit: 5 }).success).toBe(true);
    expect(parse({ action: "recover", path: "C:/p/a.aep" }).success).toBe(false);
    expect(parse({ action: "recover", path: "C:/p/a.aep", expect: GUARD }).success).toBe(true);
    expect(parse({ action: "autosave", if_dirty: "ask" }).success).toBe(false);
    expect(parse({ action: "new", expect: GUARD, probe: [{ section: "a", key: "b" }] }).success).toBe(false);
  });

  it("makes changing Auto-Save an explicit, confirmed step", () => {
    expect(parse({ action: "autosave", expect: GUARD, set: { interval_minutes: 5 } }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, set: { interval_minutes: 5 }, user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "autosave", set: { interval_minutes: 5 }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, set: {}, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, set: { interval_minutes: 0 }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_writes: 10 } }).success).toBe(false);
    expect(parse({ action: "autosave", policy: { enabled: true, after_writes: 10 }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_writes: 10 }, user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_writes: 200 }, user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_writes: 201 }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_minutes: 1 }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_minutes: 5 }, user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "autosave", expect: GUARD, policy: { enabled: true }, user_confirmed: true }).success).toBe(false);
    expect(parse({ action: "autosave", policy: { enabled: false } }).success).toBe(true);
    expect(parse({ action: "autosave", expect: GUARD, set: { enabled: true }, policy: { enabled: false }, user_confirmed: true }).success).toBe(false);
  });
});

describe("pure logic", () => {
  it("leaveVerdict asks before leaving unsaved work and never guesses", () => {
    expect(leaveVerdict(false, undefined, "C:/p/a.aep")).toEqual({ proceed: true });
    expect(leaveVerdict(true, undefined, "C:/p/a.aep").proceed).toBe(false);
    expect(leaveVerdict(true, "ask", "C:/p/a.aep").proceed).toBe(false);
    expect(leaveVerdict(null, "ask", "C:/p/a.aep").reason).toContain("would not say");
    expect(leaveVerdict(true, "discard", "<unsaved>").proceed).toBe(true);
    expect(leaveVerdict(null, "discard", "C:/p/a.aep").proceed).toBe(true);
    expect(leaveVerdict(true, "save", "C:/p/a.aep").proceed).toBe(true);
    const untitled = leaveVerdict(true, "save", "<unsaved>");
    expect(untitled.proceed).toBe(false);
    expect(untitled.reason).toContain("never been saved");
  });

  it("recoveryDirs finds the Auto-Save folder, backups and checkpoints, also from inside a checkpoint folder", () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, "Adobe After Effects 2026 Auto-Save"));
    fs.mkdirSync(path.join(base, "Other"));
    const dirs = recoveryDirs(path.join(base, "show.aep"));
    expect(dirs.map((d) => [d.source, path.basename(d.dir)])).toEqual([
      ["auto_save", "Adobe After Effects 2026 Auto-Save"],
      ["backup", "_mcp_backups"],
      ["checkpoint", "_mcp_checkpoints"],
    ]);
    const fromCheckpoint = recoveryDirs(path.join(base, "_mcp_checkpoints", "show_x.aep"));
    expect(fromCheckpoint.find((d) => d.source === "backup")?.dir).toBe(path.join(base, "_mcp_backups"));
    expect(recoveryDirs("<unsaved>")).toEqual([]);
    const custom = recoveryDirs("<unsaved>", undefined, "D:/saves");
    expect(custom).toEqual([{ source: "auto_save", dir: "D:/saves" }]);
    expect(recoveryDirs("<unsaved>", base).map((d) => d.source)).toEqual(["auto_save", "backup", "checkpoint"]);
  });

  it("scanRecoveryFiles lists project files newest first and flags files newer than the project", () => {
    const base = tmp();
    const auto = path.join(base, "Adobe After Effects Auto-Save");
    const backups = path.join(base, "_mcp_backups");
    fs.mkdirSync(auto);
    fs.mkdirSync(backups);
    const make = (p: string, ageMin: number) => {
      fs.writeFileSync(p, "x");
      const t = new Date(Date.now() - ageMin * 60_000);
      fs.utimesSync(p, t, t);
    };
    make(path.join(auto, "show-auto-save 1.aep"), 5);
    make(path.join(backups, "show_old.aep"), 90);
    make(path.join(backups, "notes.txt"), 1);
    make(path.join(backups, "show_x.aepx"), 30);
    const projectMtime = Date.now() - 20 * 60_000;
    const files = scanRecoveryFiles(
      [
        { source: "auto_save", dir: auto },
        { source: "backup", dir: backups },
        { source: "checkpoint", dir: path.join(base, "missing") },
      ],
      projectMtime,
      Date.now()
    );
    expect(files.map((f) => f.name)).toEqual(["show-auto-save 1.aep", "show_x.aepx", "show_old.aep"]);
    expect(files.map((f) => f.newer_than_project)).toEqual([true, false, false]);
    expect(files[0]).toMatchObject({ source: "auto_save", age_minutes: 5, size: 1 });
    expect(scanRecoveryFiles([{ source: "backup", dir: backups }], null, Date.now()).every((f) => !f.newer_than_project)).toBe(true);
  });

  it("countUnsavedWrites counts the agent's writes after the last save, not its own session steps", () => {
    const step = (tool: string, at: number, project_path = "C:/p/a.aep"): UndoStep => ({
      op_id: String(at),
      tool,
      label: tool,
      at: new Date(at).toISOString(),
      project_path,
      service_id: "s",
      revision_after: null,
      checkpoint: null,
    });
    const steps = [step("ae_set_property", 1000), step("ae_create_layer", 3000), step("ae_project_session", 4000), step("ae_create_layer", 5000, "C:/other.aep")];
    expect(countUnsavedWrites(steps, "C:/p/a.aep", 0)).toBe(2);
    expect(countUnsavedWrites(steps, "c:\\p\\a.aep", 2000)).toBe(process.platform === "win32" ? 1 : 0);
    expect(countUnsavedWrites(steps, "C:/p/a.aep", 9000)).toBe(0);
  });

  it("autosaveDue fires on the write count or the minutes, never when off", () => {
    expect(autosaveDue({ enabled: false, after_writes: 1 }, 5, 99).due).toBe(false);
    expect(autosaveDue({ enabled: true, after_writes: 5 }, 4, 1).due).toBe(false);
    expect(autosaveDue({ enabled: true, after_writes: 5 }, 5, 1).why).toContain("5 unsaved writes");
    expect(autosaveDue({ enabled: true, after_minutes: 10 }, null, 9.9).due).toBe(false);
    expect(autosaveDue({ enabled: true, after_minutes: 10 }, null, 10).why).toContain("10 minutes");
    expect(autosaveDue({ enabled: true, after_writes: 5 }, null, 100).due).toBe(false);
  });

  it("read-back checks name what is wrong", () => {
    const ok = state({ project_path: "C:/p/a.aep" });
    expect(openMismatches("C:/p/a.aep", { applied: true, opened: true }, ok)).toEqual([]);
    expect(openMismatches("C:/p/a.aep", { applied: false }, null)).toEqual([]);
    expect(openMismatches("C:/p/a.aep", { applied: true, opened: false, error: "boom" }, state()).map((m) => m.path)).toEqual(["opened", "project_path"]);
    // A dirty flag right after opening is a note, not a mismatch.
    expect(openMismatches("C:/p/a.aep", { applied: true, opened: true }, { ...ok, dirty: true })).toEqual([]);
    expect(openNotes({ applied: true, opened: true }, { ...ok, dirty: true })[0]).toContain("unsaved changes right after opening");
    // An older-version file opens as an untitled project: noted, not a mismatch.
    expect(openMismatches("C:/p/a.aep", { applied: true, opened: true }, state())).toEqual([]);
    expect(openNotes({ applied: true, opened: true }, state())[0]).toContain("converted from an older version");
    expect(openNotes({ applied: true, opened: false }, state())).toEqual([]);
    expect(openMismatches("C:/p/a.aep", { applied: true, opened: true }, state({ project_path: "C:/else.aep" })).map((m) => m.path)).toEqual(["project_path"]);
    expect(emptyProjectMismatches("new", { applied: true, created: true }, state())).toEqual([]);
    expect(emptyProjectMismatches("close", { applied: true, closed: true }, state({ project_path: "C:/p/a.aep", num_items: 3 })).map((m) => m.path)).toEqual(["project_path"]);
    // A template project has items; that alone is fine.
    expect(emptyProjectMismatches("new", { applied: true, created: true }, state({ num_items: 6 }))).toEqual([]);
    expect(emptyProjectMismatches("close", { applied: false }, null)).toEqual([]);
    const prefs = {
      fields: { enabled: { section: "s", key: "k", type: "long", pref_type: "independent", value: 1 }, interval_minutes: { section: "s", key: "i", type: "long", pref_type: "independent", value: 7 } },
      probed: [],
      save_project_on_crash: true,
      prefs_available: true,
    };
    const written = { applied: true, saved_to_disk: true, written: [{ field: "enabled", value: true }, { field: "interval_minutes", value: 5 }] };
    expect(prefsMismatches(written, prefs).map((m) => m.path)).toEqual(["fields.interval_minutes"]);
    expect(prefsMismatches({ ...written, saved_to_disk: false }, null).map((m) => m.path)).toEqual(["saved_to_disk"]);
    expect(prefsMismatches({ ...written, failed: [{ field: "max_versions", error: "no" }] }, prefs).map((m) => m.path)).toEqual(["failed.max_versions", "fields.interval_minutes"]);
  });
});

describe("guarded flow with a fake bridge", () => {
  const P = "C:/proj/show.aep";

  it("returns needs_user for a dirty project without writing or touching AE", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({ projectsessionRead: [state({ project_path: P, dirty: true })] }, P);
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: { project_path: P } }).data!, ctx);
    expect(res).toMatchObject({ applied: false, needs_user: true, options: ["save", "discard", "cancel"], dirty: true });
    expect(fns(calls)).toEqual(["projectsessionRead"]);
  });

  it("refuses 'save' for a project that has no file, and asks instead", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({ projectsessionRead: [state({ dirty: true })] });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: GUARD, if_dirty: "save" }).data!, ctx);
    expect(res.needs_user).toBe(true);
    expect(res.reason).toContain("never been saved");
    expect(fns(calls)).toEqual(["projectsessionRead"]);
  });

  it("opens a clean project: guard, before read, write, separate after read, matching receipt", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({
      projectsessionRead: [state(), state(), state({ project_path: target, num_items: 4, missing_footage: { count: 1, placeholders: 0, scanned: 4, truncated: false, paths: [{ id: 3, name: "a.mov", path: "D:/a.mov" }] } })],
      projectsessionOpen: [{ applied: true, opened: true, project_path: target, dirty: false }],
    });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, ctx);
    expect(fns(calls)).toEqual(["projectsessionRead", "checkGuard", "projectsessionRead", "projectsessionOpen", "projectsessionRead"]);
    expect(calls[3].script).toContain('"if_dirty":"ask"');
    expect(res).toMatchObject({ applied: true, opened: true, action: "open" });
    expect(res.project).toMatchObject({ project_path: target, num_items: 4, dirty: false });
    expect(res.missing_footage.count).toBe(1);
    expect(res.receipt.matches).toBe(true);
  });

  it("carries an explicit discard to the host and flags a read-back that shows another project", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe(
      {
        projectsessionRead: [state({ project_path: P, dirty: true }), state({ project_path: P, dirty: true }), state({ project_path: "C:/else.aep" })],
        projectsessionOpen: [{ applied: true, opened: true, discarded_previous: true, project_path: "C:/else.aep", dirty: false }],
      },
      P
    );
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: { project_path: P }, if_dirty: "discard", user_confirmed: true }).data!, ctx);
    expect(calls.find((c) => c.fn === "projectsessionOpen")!.script).toContain('"if_dirty":"discard"');
    expect(res.applied).toBe(true);
    expect(res.receipt.matches).toBe(false);
    expect(res.receipt.mismatches.map((m: any) => m.path)).toContain("project_path");
  });

  it("does not throw when the read-back fails after the write", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx } = fakeAe({
      projectsessionRead: [state(), state(), new Error("AE stuck")],
      projectsessionOpen: [{ applied: true, opened: true }],
    });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, ctx);
    expect(res.applied).toBe(true);
    expect(res.receipt.matches).toBe(false);
    expect(res.receipt.mismatches[0].message).toContain("Do not resend");
  });

  it("reports a project that did not open as not applied-by-host, with a mismatch", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx } = fakeAe({
      projectsessionRead: [state(), state(), state()],
      projectsessionOpen: [{ applied: false, opened: false, cancelled: true, message: "The open project was not closed, so nothing was opened." }],
    });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, ctx);
    expect(res.applied).toBe(false);
    expect(res.cancelled).toBe(true);
  });

  it("refuses a missing file before touching AE", async () => {
    const { ctx, calls } = fakeAe({ projectsessionRead: [state()] });
    await expect(tool.handler(parse({ action: "open", path: path.join(tmp(), "nope.aep"), expect: GUARD }).data!, ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(fns(calls)).toEqual(["projectsessionRead"]);
  });

  it("refuses to run on a guard mismatch", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({ projectsessionRead: [state({ project_path: P }), state({ project_path: P })] }, P);
    await expect(tool.handler(parse({ action: "close", expect: { project_path: "C:/else.aep" } }).data!, ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(fns(calls)).not.toContain("projectsessionClose");
  });

  it("closes and creates projects and checks the empty project that is left", async () => {
    const closed = fakeAe({
      projectsessionRead: [state(), state(), state()],
      projectsessionClose: [{ applied: true, closed: true }],
    });
    const res: any = await tool.handler(parse({ action: "close", expect: GUARD }).data!, closed.ctx);
    expect(res).toMatchObject({ applied: true, closed: true, action: "close" });
    expect(res.receipt.matches).toBe(true);
    const created = fakeAe({
      projectsessionRead: [state(), state(), state({ num_items: 2 })],
      projectsessionNew: [{ applied: true, created: true }],
    });
    const res2: any = await tool.handler(parse({ action: "new", expect: GUARD }).data!, created.ctx);
    expect(res2.receipt.matches).toBe(true);
    expect(res2.project.num_items).toBe(2);
  });

  it("recover lists the newest files and opens only a listed one", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "x");
    fs.mkdirSync(path.join(base, "_mcp_backups"));
    const backup = path.join(base, "_mcp_backups", "show_20260101-000000.aep");
    fs.writeFileSync(backup, "x");
    const listed = fakeAe({ projectsessionRead: [state({ project_path: projectFile, dirty: false })] }, projectFile);
    const res: any = await tool.handler(parse({ action: "recover" }).data!, listed.ctx);
    expect(res.files.map((f: any) => f.path)).toEqual([backup]);
    expect(res.searched.find((s: any) => s.source === "backup").exists).toBe(true);
    expect(res.truncated).toBe(false);

    const stranger = path.join(base, "other.aep");
    fs.writeFileSync(stranger, "x");
    const bad = fakeAe({ projectsessionRead: [state({ project_path: projectFile })] }, projectFile);
    await expect(tool.handler(parse({ action: "recover", path: stranger, expect: { project_path: projectFile } }).data!, bad.ctx)).rejects.toMatchObject({ kind: "guard" });

    const open = fakeAe(
      {
        projectsessionRead: [state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: backup })],
        projectsessionOpen: [{ applied: true, opened: true }],
      },
      projectFile
    );
    const opened: any = await tool.handler(parse({ action: "recover", path: backup, expect: { project_path: projectFile } }).data!, open.ctx);
    expect(opened.opened).toBe(true);
    expect(opened.recovered_from.source).toBe("backup");
    expect(opened.receipt.matches).toBe(true);
  });

  it("autosave reads the preferences, names the keys it could not find, and shows the policy", async () => {
    const hit = { section: "Auto-Save", key: "Auto-Save Interval", type: "long", pref_type: "independent", value: 20 };
    const { ctx } = fakeAe({
      projectsessionPrefs: [{ fields: { enabled: null, interval_minutes: hit, max_versions: null }, probed: [], save_project_on_crash: true, prefs_available: true }],
      projectsessionRead: [state({ project_path: "C:/p/a.aep" })],
    });
    const res: any = await tool.handler(parse({ action: "autosave" }).data!, ctx);
    expect(res.not_found).toEqual(["enabled", "max_versions"]);
    expect(res.auto_save.save_project_on_crash).toBe(true);
    expect(res.policy).toMatchObject({ enabled: false, persists_across_restart: false });
    expect(res.hint).toContain("undocumented");
  });

  it("autosave set is a guarded write that reads the preferences back", async () => {
    const hit = (key: string, value: number) => ({ section: "Auto-Save", key, type: "long", pref_type: "independent", value });
    const before = { fields: { enabled: hit("E", 0), interval_minutes: hit("I", 20) }, probed: [], save_project_on_crash: true, prefs_available: true };
    const after = { fields: { enabled: hit("E", 1), interval_minutes: hit("I", 7) }, probed: [], save_project_on_crash: true, prefs_available: true };
    const { ctx, calls } = fakeAe({
      projectsessionPrefs: [before, after],
      projectsessionPrefsSet: [{ applied: true, saved_to_disk: true, written: [{ field: "enabled", value: true }, { field: "interval_minutes", value: 5 }] }],
    });
    const res: any = await tool.handler(
      parse({ action: "autosave", expect: GUARD, set: { enabled: true, interval_minutes: 5 }, user_confirmed: true }).data!,
      ctx
    );
    expect(fns(calls)).toEqual(["checkGuard", "projectsessionPrefs", "projectsessionPrefsSet", "projectsessionPrefs"]);
    expect(res.note).toContain("next launch");
    expect(res.receipt.mismatches.map((m: any) => m.path)).toEqual(["fields.interval_minutes"]);
  });
});

describe("timed save policy", () => {
  const P = "C:/proj/show.aep";
  const steps = (n: number): UndoStep[] =>
    Array.from({ length: n }, (_, i) => ({
      op_id: `o${i}`,
      tool: "ae_set_property",
      label: "x",
      at: new Date(10_000 + i).toISOString(),
      project_path: P,
      service_id: "s",
      revision_after: null,
      checkpoint: null,
    }));
  const deps = (over: Record<string, unknown> = {}) => {
    const saved: string[] = [];
    return {
      saved,
      deps: {
        now: () => 100_000,
        dialogs: async () => [] as unknown[] | null,
        steps: () => steps(3),
        fileMtimeMs: () => 5_000,
        save: async (_c: ToolContext, p: string) => {
          saved.push(p);
        },
        ...over,
      },
    };
  };
  const opState = (st: Partial<ProjectState>) => ({ project_path: P, dirty: true, ...st });

  it("saves only the enabled project, when saved, dirty, idle, dialog-free and over a threshold", async () => {
    const run = async (st: Partial<ProjectState>, over: Record<string, unknown> = {}, policy: Record<string, unknown> = { enabled: true, after_writes: 3 }) => {
      stopAutosavePolicy();
      const { ctx, calls } = fakeAe({ projectsessionState: [opState(st)] });
      setAutosavePolicy(ctx, { project_path: P, ...policy } as any, { now: () => 100_000 });
      const d = deps(over);
      const res = await autosaveTick(ctx, d.deps);
      return { res, saved: d.saved, calls };
    };
    // setAutosavePolicy starts a timer (cleared by the next run and afterEach); the tests drive autosaveTick directly.

    const first = await run({});
    expect(first.res).toEqual({ saved: true });
    expect(fns(first.calls)).toEqual(["projectsessionState"]);
    expect((await run({ project_path: "<unsaved>" })).res.skipped).toContain("never been saved");
    expect((await run({ project_path: "C:/proj/other.aep" })).res.skipped).toContain("different project");
    expect((await run({ dirty: false })).res.skipped).toContain("no unsaved changes");
    expect((await run({ dirty: null })).res.skipped).toContain("no unsaved changes");
    const byTime = await run({}, { steps: () => steps(0), fileMtimeMs: () => 0, now: () => 100_000 + 6 * 60_000 }, { enabled: true, after_writes: 99, after_minutes: 5 });
    expect(byTime.res.saved).toBe(true);
    expect(byTime.saved).toEqual([P]);
  });

  it("stays off After Effects until a threshold is reached and no dialog is open", async () => {
    const below = fakeAe({ projectsessionState: [opState({})] });
    setAutosavePolicy(below.ctx, { enabled: true, project_path: P, after_writes: 3 });
    expect((await autosaveTick(below.ctx, deps({ steps: () => steps(2) }).deps)).skipped).toContain("threshold");
    expect(below.calls).toHaveLength(0);

    const dialog = fakeAe({ projectsessionState: [opState({})] });
    setAutosavePolicy(dialog.ctx, { enabled: true, project_path: P, after_writes: 3 });
    expect((await autosaveTick(dialog.ctx, deps({ dialogs: async () => [{ title: "Save?" }] }).deps)).skipped).toContain("dialog");
    expect(dialog.calls).toHaveLength(0);

    // A dialog list that fails is not "no dialog".
    const unknown = fakeAe({ projectsessionState: [opState({})] });
    setAutosavePolicy(unknown.ctx, { enabled: true, project_path: P, after_writes: 3 });
    const d = deps({ dialogs: async () => null });
    expect((await autosaveTick(unknown.ctx, d.deps)).skipped).toContain("could not be listed");
    expect(unknown.calls).toHaveLength(0);
    expect(d.saved).toEqual([]);
  });

  it("does nothing when a write is queued or running, or the policy is off", async () => {
    const { ctx, calls } = fakeAe({ projectsessionState: [opState({})] });
    setAutosavePolicy(ctx, { enabled: true, project_path: P, after_writes: 1 });
    const d = deps();
    const release = await ctx.queue.acquire("some write");
    const busy = await autosaveTick(ctx, d.deps);
    release.release();
    expect(busy.skipped).toContain("in flight");
    expect(calls).toHaveLength(0);
    stopAutosavePolicy();
    expect((await autosaveTick(ctx, d.deps)).skipped).toBe("The policy is off.");
    expect(d.saved).toEqual([]);
  });

  it("a failing save is reported and does not throw", async () => {
    const { ctx } = fakeAe({ projectsessionState: [opState({})] });
    setAutosavePolicy(ctx, { enabled: true, project_path: P, after_writes: 1 });
    const d = deps({ save: async () => { throw new Error("disk full"); } });
    const res = await autosaveTick(ctx, d.deps);
    expect(res.saved).toBe(false);
    expect(res.skipped).toContain("disk full");
  });

  it("keeps only its own latest backups", async () => {
    const removed: string[] = [];
    let n = 0;
    for (let i = 0; i < MAX_POLICY_BACKUPS + 2; i++) {
      const { ctx } = fakeAe({ projectsessionState: [opState({})] });
      if (i === 0) setAutosavePolicy(ctx, { enabled: true, project_path: P, after_writes: 1 });
      const fresh: UndoStep[] = steps(3).map((st) => ({ ...st, at: new Date(200_000 + i * 1000).toISOString() }));
      const d = deps({ save: async () => ({ backup_path: `b${n++}.aep` }), removeFile: (f: string) => removed.push(f), now: () => 100_000 + i * 1000, steps: () => fresh });
      expect((await autosaveTick(ctx, d.deps)).saved).toBe(true);
    }
    expect(removed).toEqual(["b0.aep", "b1.aep"]);
  });

  it("enabling needs the open saved project named in expect; disabling touches nothing", async () => {
    vi.useFakeTimers();
    const ok = fakeAe({ projectsessionRead: [state({ project_path: P })] });
    const on: any = await tool.handler(parse({ action: "autosave", expect: { project_path: P }, policy: { enabled: true, after_writes: 4, after_minutes: 15 }, user_confirmed: true }).data!, ok.ctx);
    expect(on.policy).toMatchObject({ enabled: true, project_path: P, after_writes: 4, after_minutes: 15, persists_across_restart: false, max_backups: MAX_POLICY_BACKUPS });
    expect(vi.getTimerCount()).toBe(1);
    const off: any = await tool.handler(parse({ action: "autosave", policy: { enabled: false } }).data!, ok.ctx);
    expect(off.policy.enabled).toBe(false);
    expect(fns(ok.calls)).toEqual(["projectsessionRead"]);
    expect(vi.getTimerCount()).toBe(0);

    const wrong = fakeAe({ projectsessionRead: [state({ project_path: P })] });
    await expect(
      tool.handler(parse({ action: "autosave", expect: { project_path: "C:/else.aep" }, policy: { enabled: true, after_writes: 4 }, user_confirmed: true }).data!, wrong.ctx)
    ).rejects.toMatchObject({ kind: "guard" });
    const unsaved = fakeAe({ projectsessionRead: [state()] });
    await expect(
      tool.handler(parse({ action: "autosave", expect: GUARD, policy: { enabled: true, after_writes: 4 }, user_confirmed: true }).data!, unsaved.ctx)
    ).rejects.toMatchObject({ kind: "guard" });
    expect(vi.getTimerCount()).toBe(0);
    const down = fakeAe({ projectsessionRead: [new Error("AE down")] });
    await expect(
      tool.handler(parse({ action: "autosave", expect: { project_path: P }, policy: { enabled: true, after_writes: 4 }, user_confirmed: true }).data!, down.ctx)
    ).rejects.toThrow("AE down");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns itself off when another project is opened through this tool", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx } = fakeAe(
      {
        projectsessionRead: [state({ project_path: P }), state({ project_path: P }), state({ project_path: P }), state({ project_path: target })],
        projectsessionOpen: [{ applied: true, opened: true }],
      },
      P
    );
    setAutosavePolicy(ctx, { enabled: true, project_path: P, after_writes: 1 });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: { project_path: P } }).data!, ctx);
    expect(res.policy_disabled).toContain("turned off");
    expect(disablePolicyForSwitch()).toBe(false);
  });
});

describe("if_dirty save", () => {
  it("copies the project to _mcp_backups before the host closes it with a save", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "work");
    const target = path.join(base, "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe(
      {
        projectsessionRead: [state({ project_path: projectFile, dirty: true }), state({ project_path: projectFile, dirty: true }), state({ project_path: target })],
        projectsessionOpen: [{ applied: true, opened: true, saved_previous: true }],
      },
      projectFile
    );
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: { project_path: projectFile }, if_dirty: "save" }).data!, ctx);
    expect(fns(calls)).toContain("projectsessionOpen");
    expect(res.backup_path).toContain("_mcp_backups");
    expect(path.basename(res.backup_path)).toMatch(/^show_\d{8}-\d{6}\.aep$/);
    expect(fs.readFileSync(res.backup_path, "utf8")).toBe("work");
  });

  it("stops before the write when the backup cannot be made", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "work");
    fs.writeFileSync(path.join(base, "_mcp_backups"), "a file where the folder should be");
    const target = path.join(base, "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({ projectsessionRead: [state({ project_path: projectFile, dirty: true })] }, projectFile);
    await expect(tool.handler(parse({ action: "open", path: target, expect: { project_path: projectFile }, if_dirty: "save" }).data!, ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(fns(calls)).toEqual(["projectsessionRead"]);
  });
});

// ---------- the host functions under node:vm ----------

function hostScene(opts: { file?: string | null; dirty?: boolean } = {}) {
  const project = new FakeProject();
  project.file = opts.file === undefined ? null : opts.file === null ? null : { fsName: opts.file, exists: true };
  project.dirty = opts.dirty ?? false;
  const closes: number[] = [];
  const CloseOptions = { DO_NOT_SAVE_CHANGES: 1, PROMPT_TO_SAVE_CHANGES: 2, SAVE_CHANGES: 3 };
  const opened: string[] = [];
  const h: any = {};
  const host = loadHost(project, ["projectsession.jsx"], {
    saveProjectOnCrash: true,
    open: (f: { fsName: string }) => {
      opened.push(f.fsName);
      if (h.openResult === null) return null;
      if (h.openThrows) throw new Error("cannot open");
      if (h.openThrowsOnce && opened.length === 1) throw new Error("cannot open");
      const next = new FakeProject();
      next.file = { fsName: f.fsName };
      host.G.app.project = next;
      return next;
    },
    newProject: () => {
      const next = new FakeProject();
      host.G.app.project = next;
      return next;
    },
  });
  host.G.CloseOptions = CloseOptions;
  (project as any).close = (mode: number) => {
    closes.push(mode);
    if (h.closeResult === false) return false;
    const next = new FakeProject();
    host.G.app.project = next;
    return true;
  };
  // The write host functions refuse a call without expect; the scene's own path is the default here.
  const rawA = host.A;
  const A: any = new Proxy(rawA, {
    get(t: any, k: string) {
      const f = t[k];
      if (typeof f === "function" && /^projectsession(Open|New|Close|PrefsSet)$/.test(k)) {
        return (args: any) => {
          const cur = host.G.app.project.file;
          return f({ expect: { project_path: cur ? cur.fsName : "<unsaved>" }, backup_taken: true, ...(args || {}) });
        };
      }
      return f;
    },
  });
  return { ...host, A, rawA, project, closes, opened, h, CloseOptions };
}

describe("projectsession.jsx", () => {
  it("reads the project: path, dirty flag, items and missing footage (placeholders apart)", () => {
    const { A, project } = hostScene({ file: "C:/p/a.aep", dirty: true });
    project.addComp("Main");
    const lost = project.addFootage("lost.mov", 10, 10, Object.assign(new FileSource(), { missingFootagePath: "D:/gone/lost.mov" }));
    lost.footageMissing = true;
    const ph = project.addFootage("ph", 10, 10, new PlaceholderSource());
    ph.footageMissing = true;
    project.addFootage("fine.mov", 10, 10);
    const r = A.projectsessionRead({});
    expect(r).toMatchObject({ project_path: "C:/p/a.aep", dirty: true, num_items: 4, save_project_on_crash: true, ae_version: "26.2.1" });
    expect(r.missing_footage).toMatchObject({ count: 1, placeholders: 1, scanned: 4, truncated: false });
    expect(r.missing_footage.paths).toEqual([{ id: lost.id, name: "lost.mov", path: "D:/gone/lost.mov" }]);
  });

  it("reports an unreadable dirty flag as null", () => {
    const { A, project } = hostScene({ file: "C:/p/a.aep" });
    Object.defineProperty(project, "dirty", { get() { throw new Error("no"); } });
    expect(A.projectsessionRead({}).dirty).toBeNull();
  });

  it("opens a project on a clean session, closing the old one with the prompting mode", () => {
    const dir = tmp();
    const target = path.join(dir, "next.aep");
    fs.writeFileSync(target, "x");
    const { A, G, closes, opened, CloseOptions, undo } = hostScene({ file: "C:/p/a.aep", dirty: false });
    const out = A.projectsessionOpen({ path: target, expect: { project_path: "C:/p/a.aep" } });
    expect(out).toMatchObject({ applied: true, opened: true, closed_previous: true, discarded_previous: false, project_path: target, dirty: false });
    expect(closes).toEqual([CloseOptions.PROMPT_TO_SAVE_CHANGES]);
    expect(opened).toEqual([target]);
    expect(G.app.project.file.fsName).toBe(target);
    expect(undo.begun).toBe(0);
  });

  it("returns needs_user for unsaved changes and leaves everything alone", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { A, closes, opened } = hostScene({ file: "C:/p/a.aep", dirty: true });
    const out = A.projectsessionOpen({ path: target });
    expect(out).toMatchObject({ applied: false, needs_user: true, dirty: true, project_path: "C:/p/a.aep", options: ["save", "discard", "cancel"] });
    expect(closes).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("closes with SAVE_CHANGES on save and DO_NOT_SAVE_CHANGES only on an explicit discard", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const saved = hostScene({ file: "C:/p/a.aep", dirty: true });
    const s = saved.A.projectsessionOpen({ path: target, if_dirty: "save" });
    expect(saved.closes).toEqual([saved.CloseOptions.SAVE_CHANGES]);
    expect(s).toMatchObject({ saved_previous: true, discarded_previous: false, opened: true });
    const dropped = hostScene({ file: "C:/p/a.aep", dirty: true });
    const d = dropped.A.projectsessionOpen({ path: target, if_dirty: "discard" });
    expect(dropped.closes).toEqual([dropped.CloseOptions.DO_NOT_SAVE_CHANGES]);
    expect(d).toMatchObject({ saved_previous: false, discarded_previous: true });
    const untitled = hostScene({ file: null, dirty: true });
    const u = untitled.A.projectsessionOpen({ path: target, if_dirty: "save" });
    expect(u).toMatchObject({ applied: false, needs_user: true });
    expect(u.reason).toContain("never been saved");
    expect(untitled.closes).toEqual([]);
  });

  it("refuses to save over the file without a backup, and marks every write host no_op", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const nobackup = hostScene({ file: "C:/p/a.aep", dirty: true });
    const out = nobackup.A.projectsessionOpen({ path: target, if_dirty: "save", backup_taken: false });
    expect(out).toMatchObject({ applied: false, needs_user: true, no_op: true });
    expect(out.reason).toContain("_mcp_backups");
    expect(nobackup.closes).toEqual([]);
    const ok = hostScene({ file: "C:/p/a.aep", dirty: false });
    expect(ok.A.projectsessionOpen({ path: target }).no_op).toBe(true);
    expect(hostScene({ file: "C:/p/a.aep" }).A.projectsessionNew({}).no_op).toBe(true);
    expect(hostScene({ file: "C:/p/a.aep" }).A.projectsessionClose({}).no_op).toBe(true);
    expect(hostScene({ file: "C:/p/a.aep", dirty: true }).A.projectsessionClose({}).no_op).toBe(true);
    expect(hostScene({ file: "C:/p/a.aep" }).A.projectsessionPrefsSet({ set: { enabled: true } }).no_op).toBe(true);
  });

  it("puts the previous project back when the new one fails to open", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const failed = hostScene({ file: "C:/p/a.aep", dirty: false });
    failed.h.openThrowsOnce = true;
    const out = failed.A.projectsessionOpen({ path: target });
    expect(out).toMatchObject({ opened: false, error: "cannot open", restored_previous: true, project_path: "C:/p/a.aep" });
    expect(failed.opened).toEqual([target, "C:/p/a.aep"]);
    const never = hostScene({ file: "C:/p/a.aep", dirty: true });
    never.h.openThrowsOnce = true;
    const dropped = never.A.projectsessionOpen({ path: target, if_dirty: "discard" });
    expect(dropped.restored_previous).toBeUndefined();
    expect(never.opened).toEqual([target]);
    const stuck = hostScene({ file: "C:/p/a.aep", dirty: false });
    stuck.h.openThrows = true;
    expect(stuck.A.projectsessionOpen({ path: target }).restored_previous).toBe(false);
  });

  it("uses no ES3 reserved words as property names", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../panel/host/ext/projectsession.jsx"), "utf8");
    expect(src).not.toMatch(/\.short|short\s*:/);
  });

  it("treats an unreadable dirty flag as unsaved work", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { A, project, closes } = hostScene({ file: "C:/p/a.aep" });
    Object.defineProperty(project, "dirty", { get() { throw new Error("no"); } });
    const out = A.projectsessionOpen({ path: target });
    expect(out).toMatchObject({ applied: false, needs_user: true, dirty: null });
    expect(closes).toEqual([]);
  });

  it("validates before closing anything", () => {
    const { A, closes } = hostScene({ file: "C:/p/a.aep" });
    expect(() => A.projectsessionOpen({})).toThrow(/requires path/);
    expect(() => A.projectsessionOpen({ path: path.join(tmp(), "x.txt") })).toThrow(/Only \.aep/);
    expect(() => A.projectsessionOpen({ path: path.join(tmp(), "missing.aep") })).toThrow(/does not exist/);
    expect(() => A.projectsessionOpen({ path: "x.aep", expect: { project_path: "C:/else.aep" } })).toThrow(/guard/i);
    expect(() => A.projectsessionOpen({ path: "x.aep", if_dirty: "maybe" })).toThrow();
    expect(closes).toEqual([]);
  });

  it("reports a cancelled close, a cancelled open and a failed open without throwing", () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const cancelled = hostScene({ file: "C:/p/a.aep" });
    cancelled.h.closeResult = false;
    expect(cancelled.A.projectsessionOpen({ path: target })).toMatchObject({ applied: false, opened: false, cancelled: true, project_path: "C:/p/a.aep" });
    expect(cancelled.opened).toEqual([]);
    const nulled = hostScene({ file: "C:/p/a.aep" });
    nulled.h.openResult = null;
    expect(nulled.A.projectsessionOpen({ path: target })).toMatchObject({ applied: true, opened: false, cancelled: true });
    const thrown = hostScene({ file: "C:/p/a.aep" });
    thrown.h.openThrows = true;
    expect(thrown.A.projectsessionOpen({ path: target })).toMatchObject({ applied: true, opened: false, error: "cannot open" });
  });

  it("creates a new project and closes the open one", () => {
    const made = hostScene({ file: "C:/p/a.aep", dirty: false });
    expect(made.A.projectsessionNew({})).toMatchObject({ applied: true, created: true, project_path: "<unsaved>", dirty: false });
    const blocked = hostScene({ file: "C:/p/a.aep", dirty: true });
    expect(blocked.A.projectsessionNew({})).toMatchObject({ applied: false, needs_user: true });
    expect(blocked.closes).toEqual([]);
    const discarded = hostScene({ file: "C:/p/a.aep", dirty: true });
    expect(discarded.A.projectsessionNew({ if_dirty: "discard" })).toMatchObject({ applied: true, created: true, discarded_previous: true });
    expect(discarded.closes).toEqual([discarded.CloseOptions.DO_NOT_SAVE_CHANGES]);
    const stuck = hostScene({ file: "C:/p/a.aep" });
    stuck.h.closeResult = false;
    expect(stuck.A.projectsessionNew({})).toMatchObject({ applied: false, created: false, cancelled: true });
  });

  it("closes the project", () => {
    const clean = hostScene({ file: "C:/p/a.aep", dirty: false });
    expect(clean.A.projectsessionClose({ expect: { project_path: "C:/p/a.aep" } })).toMatchObject({ applied: true, closed: true, project_path: "<unsaved>" });
    const dirty = hostScene({ file: "C:/p/a.aep", dirty: true });
    expect(dirty.A.projectsessionClose({})).toMatchObject({ applied: false, needs_user: true });
    const saved = hostScene({ file: "C:/p/a.aep", dirty: true });
    expect(saved.A.projectsessionClose({ if_dirty: "save" })).toMatchObject({ applied: true, saved_previous: true });
    expect(saved.closes).toEqual([saved.CloseOptions.SAVE_CHANGES]);
  });

  /** An app.preferences that holds values under (section, key) for the independent pref type only. */
  function withPrefs(h: ReturnType<typeof hostScene>, values: Record<string, unknown>) {
    const store: Record<string, unknown> = { ...values };
    const writes: Array<[string, string, unknown]> = [];
    let disk = 0;
    h.G.PREFType = { PREF_Type_MACHINE_INDEPENDENT: 1, PREF_Type_MACHINE_SPECIFIC: 2 };
    const id = (s: string, k: string) => `${s}|${k}`;
    h.G.app.preferences = {
      havePref: (s: string, k: string, t: number) => t === 1 && id(s, k) in store,
      getPrefAsLong: (s: string, k: string) => {
        if (typeof store[id(s, k)] !== "number") throw new Error("wrong type");
        return store[id(s, k)];
      },
      getPrefAsBool: (s: string, k: string) => {
        if (typeof store[id(s, k)] !== "boolean") throw new Error("wrong type");
        return store[id(s, k)];
      },
      getPrefAsFloat: () => { throw new Error("wrong type"); },
      getPrefAsString: (s: string, k: string) => store[id(s, k)],
      savePrefAsLong: (s: string, k: string, v: number) => { store[id(s, k)] = v; writes.push([s, k, v]); },
      savePrefAsBool: (s: string, k: string, v: boolean) => { store[id(s, k)] = v; writes.push([s, k, v]); },
      saveToDisk: () => { disk++; },
    };
    return { store, writes, disks: () => disk };
  }

  it("finds Auto-Save keys by probing, with their types, and looks up extra names", () => {
    const h = hostScene({ file: "C:/p/a.aep" });
    withPrefs(h, { "Auto-Save|Auto-Save Enabled": true, "Auto Save|Interval": 20, "Elsewhere|Thing": 3 });
    const r = h.A.projectsessionPrefs({ probe: [{ section: "Elsewhere", key: "Thing", type: "long" }, { section: "Elsewhere", key: "Nope" }] });
    expect(r.prefs_available).toBe(true);
    expect(r.save_project_on_crash).toBe(true);
    expect(r.fields.enabled).toMatchObject({ section: "Auto-Save", key: "Auto-Save Enabled", type: "bool", pref_type: "independent", value: true });
    expect(r.fields.interval_minutes).toMatchObject({ section: "Auto Save", key: "Interval", type: "long", value: 20 });
    expect(r.fields.max_versions).toBeNull();
    expect(r.probed).toEqual([
      { section: "Elsewhere", key: "Thing", requested_type: "long", found: true, value: 3, pref_type: "independent", truncated: false },
      { section: "Elsewhere", key: "Nope", requested_type: "long", found: false, value: null, pref_type: null, truncated: false },
    ]);
  });

  it("works without the PREFType enum and without app.preferences", () => {
    const h = hostScene({ file: "C:/p/a.aep" });
    expect(h.A.projectsessionPrefs({}).prefs_available).toBe(false);
    h.G.app.preferences = {
      havePref: (_s: string, k: string, t?: number) => t === undefined && k === "Interval",
      getPrefAsLong: () => 9,
      getPrefAsBool: () => { throw new Error("wrong type"); },
    };
    expect(h.A.projectsessionPrefs({}).fields.interval_minutes).toMatchObject({ value: 9, pref_type: "default" });
  });

  it("writes only keys that were found, all or nothing, validated first", () => {
    const h = hostScene({ file: null });
    const prefs = withPrefs(h, { "Auto-Save|Auto-Save Enabled": false, "Auto-Save|Auto-Save Interval": 20 });
    const ok = h.A.projectsessionPrefsSet({ set: { enabled: true, interval_minutes: 5 }, expect: GUARD });
    expect(ok).toMatchObject({ applied: true, saved_to_disk: true });
    expect(ok.written.map((w: any) => [w.field, w.value])).toEqual([["enabled", true], ["interval_minutes", 5]]);
    expect(prefs.store["Auto-Save|Auto-Save Enabled"]).toBe(true);
    expect(prefs.disks()).toBe(1);

    const before = prefs.writes.length;
    const partial = h.A.projectsessionPrefsSet({ set: { interval_minutes: 9, max_versions: 3 }, expect: GUARD });
    expect(partial).toMatchObject({ applied: false, not_found: ["max_versions"] });
    expect(prefs.writes.length).toBe(before);

    expect(() => h.A.projectsessionPrefsSet({ set: { interval_minutes: 0 } })).toThrow(/interval_minutes/);
    expect(() => h.A.projectsessionPrefsSet({ set: { interval_minutes: 2.5 } })).toThrow(/interval_minutes/);
    expect(() => h.A.projectsessionPrefsSet({ set: { enabled: "yes" } })).toThrow(/enabled/);
    expect(() => h.A.projectsessionPrefsSet({ set: {} })).toThrow(/nothing to change/);
    expect(() => h.A.projectsessionPrefsSet({ set: { enabled: true }, expect: { project_path: "C:/else.aep" } })).toThrow(/guard/i);
    expect(prefs.writes.length).toBe(before);
  });

  it("writes a long-typed enabled flag as 0 or 1", () => {
    const h = hostScene({ file: null });
    const prefs = withPrefs(h, { "Auto-Save|Enabled": 0 });
    h.A.projectsessionPrefsSet({ set: { enabled: true } });
    expect(prefs.store["Auto-Save|Enabled"]).toBe(1);
  });

  it("reports a failing saveToDisk after the keys were written", () => {
    const h = hostScene({ file: null });
    withPrefs(h, { "Auto-Save|Auto-Save Interval": 20 });
    h.G.app.preferences.saveToDisk = () => { throw new Error("read-only"); };
    expect(h.A.projectsessionPrefsSet({ set: { interval_minutes: 5 } })).toMatchObject({ applied: true, saved_to_disk: false, error: "read-only" });
  });
});

describe("projectsession.jsx review fixes", () => {
  it("refuses every write without expect, before looking at anything else", () => {
    const h = hostScene({ file: "C:/p/a.aep" });
    expect(() => h.rawA.projectsessionOpen({ path: "x.txt" })).toThrow(/no expect\.project_path/);
    expect(() => h.rawA.projectsessionOpen()).toThrow(/no expect\.project_path/);
    expect(() => h.rawA.projectsessionNew({})).toThrow(/no expect\.project_path/);
    expect(() => h.rawA.projectsessionClose({ if_dirty: "discard" })).toThrow(/no expect\.project_path/);
    expect(() => h.rawA.projectsessionPrefsSet({ set: { enabled: true } })).toThrow(/no expect\.project_path/);
    expect(h.closes).toEqual([]);
  });

  it("reads only path and dirty for the policy tick", () => {
    const { rawA, project } = hostScene({ file: "C:/p/a.aep", dirty: true });
    project.addComp("Main");
    expect(rawA.projectsessionState({})).toEqual({ project_path: "C:/p/a.aep", dirty: true });
  });

  it("does not take the generic Enabled key from the general section", () => {
    const h = hostScene({ file: null });
    const prefs = {
      store: { "Main Pref Section|Enabled": 1, "Main Pref Section|Interval": 4, "Main Pref Section|Auto-Save Interval": 20 } as Record<string, number>,
      writes: [] as string[],
    };
    h.G.PREFType = { PREF_Type_MACHINE_INDEPENDENT: 1, PREF_Type_MACHINE_SPECIFIC: 2 };
    h.G.app.preferences = {
      havePref: (s: string, k: string, t: number) => t === 1 && `${s}|${k}` in prefs.store,
      getPrefAsLong: (s: string, k: string) => prefs.store[`${s}|${k}`],
      getPrefAsBool: () => { throw new Error("wrong type"); },
      savePrefAsLong: (s: string, k: string, v: number) => { prefs.store[`${s}|${k}`] = v; prefs.writes.push(`${s}|${k}`); },
      saveToDisk: () => {},
    };
    const r = h.A.projectsessionPrefs({});
    expect(r.fields.enabled).toBeNull();
    expect(r.fields.interval_minutes).toMatchObject({ section: "Main Pref Section", key: "Auto-Save Interval", value: 20 });
    const set = h.A.projectsessionPrefsSet({ set: { enabled: true } });
    expect(set).toMatchObject({ applied: false, not_found: ["enabled"] });
    expect(prefs.writes).toEqual([]);
  });

  it("reports a refused preference write instead of throwing, and still saves what was written", () => {
    const h = hostScene({ file: null });
    const store: Record<string, number> = { "Auto-Save|Auto-Save Interval": 20, "Auto-Save|Auto-Save Maximum Versions": 5 };
    let disk = 0;
    h.G.PREFType = { PREF_Type_MACHINE_INDEPENDENT: 1, PREF_Type_MACHINE_SPECIFIC: 2 };
    h.G.app.preferences = {
      havePref: (s: string, k: string, t: number) => t === 1 && `${s}|${k}` in store,
      getPrefAsLong: (s: string, k: string) => store[`${s}|${k}`],
      getPrefAsBool: () => { throw new Error("wrong type"); },
      savePrefAsLong: (s: string, k: string, v: number) => {
        if (k.indexOf("Maximum") >= 0) throw new Error("refused");
        store[`${s}|${k}`] = v;
      },
      saveToDisk: () => { disk++; },
    };
    const out = h.A.projectsessionPrefsSet({ set: { interval_minutes: 5, max_versions: 9 } });
    expect(out).toMatchObject({ applied: true, saved_to_disk: true });
    expect(out.written.map((w: any) => w.field)).toEqual(["interval_minutes"]);
    expect(out.failed).toEqual([{ field: "max_versions", section: "Auto-Save", key: "Auto-Save Maximum Versions", error: "refused" }]);
    expect(disk).toBe(1);
    const none = h.A.projectsessionPrefsSet({ set: { max_versions: 9 } });
    expect(none).toMatchObject({ applied: false });
    expect(none.failed).toHaveLength(1);
    expect(disk).toBe(1);
  });

  it("bounds long probed string values", () => {
    const h = hostScene({ file: null });
    h.G.PREFType = { PREF_Type_MACHINE_INDEPENDENT: 1, PREF_Type_MACHINE_SPECIFIC: 2 };
    h.G.app.preferences = {
      havePref: (s: string, k: string, t: number) => t === 1 && s === "X" && k === "Long",
      getPrefAsString: () => "a".repeat(30000),
    };
    const r = h.A.projectsessionPrefs({ probe: [{ section: "X", key: "Long", type: "string" }] });
    expect(r.probed[0].value.length).toBe(20000);
    expect(r.probed[0].truncated).toBe(true);
  });
});

describe("recover marks and notes", () => {
  it("marks files of the open project first, flags a capped scan, and warns that the opened file is the recovery copy", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "x");
    fs.mkdirSync(path.join(base, "_mcp_backups"));
    const mine = path.join(base, "_mcp_backups", "show_20260101-000000.aep");
    const other = path.join(base, "_mcp_backups", "other_20260102-000000.aep");
    fs.writeFileSync(mine, "x");
    fs.writeFileSync(other, "x");
    const t = new Date(Date.now() - 3_600_000);
    fs.utimesSync(mine, t, t);
    const listed = fakeAe({ projectsessionRead: [state({ project_path: projectFile })] }, projectFile);
    const res: any = await tool.handler(parse({ action: "recover" }).data!, listed.ctx);
    expect(res.files.map((f: any) => [path.basename(f.path), f.same_project])).toEqual([
      ["show_20260101-000000.aep", true],
      ["other_20260102-000000.aep", false],
    ]);
    expect(res.scan_truncated).toBe(false);

    const info = { capped_dirs: [] as string[] };
    const dir = path.join(base, "many");
    fs.mkdirSync(dir);
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(dir, `f${i}.aep`), "");
    scanRecoveryFiles([{ source: "backup", dir }], null, Date.now(), info);
    expect(info.capped_dirs).toEqual([dir]);

    const open = fakeAe(
      {
        projectsessionRead: [state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: mine })],
        projectsessionOpen: [{ applied: true, opened: true }],
      },
      projectFile
    );
    const opened: any = await tool.handler(parse({ action: "recover", path: mine, expect: { project_path: projectFile } }).data!, open.ctx);
    expect(opened.note).toContain("recovery copy");
  });
});

describe("review fixes (server)", () => {
  const P = "C:/proj/show.aep";
  const openState = (target: string) => state({ project_path: target });

  it("validates absolute folders and the project file type, and wants the user's yes for discard", () => {
    expect(parse({ action: "recover", project_dir: "relative/dir" }).success).toBe(false);
    expect(parse({ action: "recover", auto_save_dir: "relative/dir" }).success).toBe(false);
    expect(parse({ action: "recover", project_dir: "C:/p", auto_save_dir: "D:/saves" }).success).toBe(true);
    expect(parse({ action: "open", path: "C:/p/notes.txt", expect: GUARD }).success).toBe(false);
    expect(parse({ action: "open", path: "C:/p/a.AEPX", expect: GUARD }).success).toBe(true);
    expect(parse({ action: "recover", path: "C:/p/x.txt", expect: GUARD }).success).toBe(false);
    expect(parse({ action: "open", path: "C:/p/a.aep", expect: GUARD, if_dirty: "discard" }).success).toBe(false);
    expect(parse({ action: "close", expect: GUARD, if_dirty: "discard", user_confirmed: false }).success).toBe(false);
    expect(parse({ action: "close", expect: GUARD, if_dirty: "discard", user_confirmed: true }).success).toBe(true);
    expect(parse({ action: "recover", path: "C:/p/a.aep", expect: GUARD, if_dirty: "discard", user_confirmed: true }).success).toBe(true);
  });

  it("describes what the code does", () => {
    expect(tool.description).not.toContain("times out.recover");
    expect(tool.description).toContain("opens, creates or closes");
    expect(tool.description).toContain("user_confirmed");
  });

  it("gives the open write the slow timeout", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx, calls } = fakeAe({
      projectsessionRead: [state(), state(), openState(target)],
      projectsessionOpen: [{ applied: true, opened: true, no_op: true }],
    });
    const spy = vi.spyOn(ctx.bridge, "evalRaw");
    await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, ctx);
    const write = spy.mock.calls.map((c) => c[0]).find((c) => c.script.includes("projectsessionOpen"));
    expect(write!.timeoutMs).toBe(SLOW_TIMEOUT_MS);
    expect(calls.some((c) => c.fn === "projectsessionOpen")).toBe(true);
    expect(SLOW_TIMEOUT_MS).toBe(600_000);
  });

  it("tells the session tracker about an open, and adds no undo step for it", async () => {
    const tracker = installSessionTracking({ dataDir: tmp() });
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const open = fakeAe({
      projectsessionRead: [state(), state(), openState(target)],
      projectsessionOpen: [{ applied: true, opened: true, closed_previous: true, no_op: true }],
      sessionSnapshot: [{}],
    });
    expect(tracker.reopenedAt()).toBeNull();
    await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, open.ctx);
    expect(tracker.reopenedAt()).not.toBeNull();
    expect(tracker.steps()).toEqual([]);
    expect(tracker.agentWritesSince("<unsaved>", null)).toEqual([]);
  });

  it("marks a close, and a write that threw after it may have closed the project, but not a needs_user or a refusal", async () => {
    const tracker = installSessionTracking({ dataDir: tmp() });
    const close = fakeAe({
      projectsessionRead: [state(), state(), state()],
      projectsessionClose: [{ applied: true, closed: true, no_op: true }],
      sessionSnapshot: [{}],
    });
    await tool.handler(parse({ action: "close", expect: GUARD }).data!, close.ctx);
    expect(tracker.reopenedAt()).not.toBeNull();

    resetSessionTracking();
    const t2 = installSessionTracking({ dataDir: tmp() });
    const asks = fakeAe({ projectsessionRead: [state({ project_path: P, dirty: true })] }, P);
    await tool.handler(parse({ action: "close", expect: { project_path: P } }).data!, asks.ctx);
    expect(t2.reopenedAt()).toBeNull();

    const refused = fakeAe({ projectsessionRead: [state({ project_path: P })] }, P);
    await expect(tool.handler(parse({ action: "close", expect: { project_path: "C:/else.aep" } }).data!, refused.ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(t2.reopenedAt()).toBeNull();

    const timedOut = fakeAe({ projectsessionRead: [state(), state()], projectsessionClose: [new Error("timed out")] });
    await expect(tool.handler(parse({ action: "close", expect: GUARD }).data!, timedOut.ctx)).rejects.toThrow();
    expect(getSessionTracker()!.reopenedAt()).not.toBeNull();
  });

  it("refuses a different open project as a guard error before asking, backing up or writing", async () => {
    const base = tmp();
    const other = path.join(base, "b.aep");
    fs.writeFileSync(other, "work");
    const { ctx, calls } = fakeAe({ projectsessionRead: [state({ project_path: other, dirty: true })] }, other);
    await expect(tool.handler(parse({ action: "close", expect: { project_path: P }, if_dirty: "save" }).data!, ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(fns(calls)).toEqual(["projectsessionRead"]);
    expect(fs.existsSync(path.join(base, "_mcp_backups"))).toBe(false);
  });

  it("backs up for if_dirty save even when the project read as clean, and tells the host", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "work");
    const { ctx, calls } = fakeAe(
      {
        projectsessionRead: [state({ project_path: projectFile, dirty: false }), state({ project_path: projectFile }), state()],
        projectsessionClose: [{ applied: true, closed: true, saved_previous: true, no_op: true }],
      },
      projectFile
    );
    const res: any = await tool.handler(parse({ action: "close", expect: { project_path: projectFile }, if_dirty: "save" }).data!, ctx);
    expect(res.backup_path).toContain("_mcp_backups");
    expect(fs.readFileSync(res.backup_path, "utf8")).toBe("work");
    expect(calls.find((c) => c.fn === "projectsessionClose")!.script).toContain('"backup_taken":true');
  });

  it("reports the read-back path and dirty flag, not the write's own", async () => {
    const target = path.join(tmp(), "next.aep");
    fs.writeFileSync(target, "x");
    const { ctx } = fakeAe({
      projectsessionRead: [state(), state(), state({ project_path: target, dirty: false })],
      projectsessionOpen: [{ applied: true, opened: true, project_path: "C:/stale.aep", dirty: true, no_op: true }],
    });
    const res: any = await tool.handler(parse({ action: "open", path: target, expect: GUARD }).data!, ctx);
    expect(res.project_path).toBe(target);
    expect(res.dirty).toBe(false);
    expect(res.project.project_path).toBe(target);
  });

  it("recover does not call the original a recovery copy when nothing was opened", async () => {
    const base = tmp();
    const projectFile = path.join(base, "show.aep");
    fs.writeFileSync(projectFile, "x");
    fs.mkdirSync(path.join(base, "_mcp_backups"));
    const mine = path.join(base, "_mcp_backups", "show_20260101-000000.aep");
    fs.writeFileSync(mine, "x");
    const dirty = fakeAe({ projectsessionRead: [state({ project_path: projectFile, dirty: true }), state({ project_path: projectFile, dirty: true })] }, projectFile);
    const asked: any = await tool.handler(parse({ action: "recover", path: mine, expect: { project_path: projectFile } }).data!, dirty.ctx);
    expect(asked.needs_user).toBe(true);
    expect(asked.recovered_from).toBeUndefined();
    expect(asked.note).toBeUndefined();
    expect(asked.recover_target).toBe(mine);

    const failed = fakeAe(
      {
        projectsessionRead: [state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: projectFile }), state({ project_path: projectFile })],
        projectsessionOpen: [{ applied: true, opened: false, error: "cannot open", closed_previous: true, no_op: true }],
      },
      projectFile
    );
    const res: any = await tool.handler(parse({ action: "recover", path: mine, expect: { project_path: projectFile } }).data!, failed.ctx);
    expect(res.recovered_from).toBeUndefined();
    expect(res.note).toBeUndefined();
  });
});

describe("timed save accounting", () => {
  const P = "C:/proj/show.aep";
  it("does not count a save whose receipt did not match", async () => {
    stopAutosavePolicy();
    const { ctx } = fakeAe({ projectsessionState: [{ project_path: P, dirty: true }] });
    setAutosavePolicy(ctx, { enabled: true, project_path: P, after_minutes: 5 }, { now: () => 0 });
    const res = await autosaveTick(ctx, {
      now: () => 6 * 60_000,
      dialogs: async () => [],
      steps: () => [],
      fileMtimeMs: () => 0,
      save: async () => ({ receipt: { matches: false, mismatches: [{ message: "dirty is still true" }] } }),
    });
    expect(res.saved).toBe(false);
    expect(res.skipped).toContain("dirty is still true");
    const ok = fakeAe({ projectsessionState: [{ project_path: P, dirty: true }] });
    const good = await autosaveTick(ok.ctx, {
      now: () => 6 * 60_000,
      dialogs: async () => [],
      steps: () => [],
      fileMtimeMs: () => 0,
      save: async () => ({ receipt: { matches: true, mismatches: [] } }),
    });
    expect(good.saved).toBe(true);
  });

  it("counts unguarded agent writes from the write log, not the undo steps", async () => {
    expect(
      countAgentWrites([
        { at: "x", op_id: "1", tool: "ae_add_effect", guarded: false },
        { at: "x", op_id: "2", tool: "ae_save", guarded: true },
        { at: "x", op_id: "3", tool: "ae_project_session", guarded: true },
        { at: "x", op_id: "4", tool: "ae_set_text", guarded: false },
      ])
    ).toBe(2);
    const tracker = installSessionTracking({ dataDir: tmp() });
    tracker.noteAgentWrite(P, { op_id: "a", tool: "ae_add_effect", guarded: false });
    tracker.noteAgentWrite(P, { op_id: "b", tool: "ae_set_text", guarded: false });
    stopAutosavePolicy();
    const { ctx } = fakeAe({ projectsessionState: [{ project_path: P, dirty: true }] });
    setAutosavePolicy(ctx, { enabled: true, project_path: P, after_writes: 2 }, { now: () => 0 });
    const res = await autosaveTick(ctx, { now: () => 100_000, dialogs: async () => [], fileMtimeMs: () => 5_000, save: async () => ({}) });
    expect(res).toEqual({ saved: true });
  });
});

void FakeFootage;

describe("untitled projects point at ae_save save_as", () => {
  it("leaveVerdict's reason for saving an untitled project names save_as", () => {
    const v = leaveVerdict(true, "save", "<unsaved>");
    expect(v.proceed).toBe(false);
    expect(v.reason).toContain("save_as: { path }");
    expect(v.reason).not.toContain("Save it once in After Effects");
  });

  it("the tool description says how to save a project made with new", () => {
    expect(tool.description).toContain("ae_save and save_as: { path }");
  });
});
