/**
 * server/src/tools/ext/projectsession.ts
 *
 * ae_project_session: open, create, close and recover projects without losing
 * work, and report (or, after asking, change) After Effects' own Auto-Save.
 *
 * - open / new / close: the host reads project.dirty first. A project with
 *   unsaved changes returns `needs_user` (save, discard or cancel) and nothing
 *   is touched; AE's save prompt is never suppressed. `if_dirty: "save"` copies
 *   the .aep to _mcp_backups in Node first, then closes with SAVE_CHANGES;
 *   `"discard"` closes with DO_NOT_SAVE_CHANGES. A separate
 *   evalScript then reads the open project back (path, dirty, item count,
 *   missing footage). They are guarded writes, so the session tracker (ext/
 *   session.ts) takes the new project as its baseline.
 * - recover: lists the newest .aep/.aepx files by modified time in AE's
 *   Auto-Save folder next to the project, `_mcp_backups` and
 *   `_mcp_checkpoints`; with `path` it opens one of them (same unsaved-work
 *   rules as open).
 * - autosave: reads AE's Auto-Save preferences (the key names are not
 *   documented, so the host probes likely ones and reports what it found),
 *   sets them only when the user said yes, and keeps an opt-in server policy:
 *   after N unsaved writes or M minutes the server takes an ae_save (backup
 *   first), but only for the project it was enabled for, when that project has
 *   been saved before, is dirty, no dialog is open and nothing is queued or
 *   running. The policy lives in server memory (it ends when the server
 *   restarts) and keeps only its own latest backups.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { pathsMatchForGuard } from "../../jsx.js";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  type ExpectGuard,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { formatBackupTimestamp, mutateTools, registerProjectRetargetHook } from "../mutate.js";
import { listBlockingDialogs } from "./dialogs.js";
import { getSessionTracker, type AgentWrite, type UndoStep } from "./session.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- shapes ----------

export interface MissingFootage {
  count: number;
  placeholders: number;
  scanned: number;
  truncated: boolean;
  paths: Array<{ id: number; name: string; path: string | null }>;
}

/** What projectsessionRead returns. */
export interface ProjectState {
  project_path: string;
  /** Project.dirty is undocumented; null when AE would not say. */
  dirty: boolean | null;
  num_items: number;
  missing_footage: MissingFootage | null;
  active_item: { id: number; name: string; kind: string } | null;
  save_project_on_crash: boolean | null;
  ae_version: string | null;
}

export interface PrefHit {
  section: string;
  key: string;
  type: "bool" | "long" | "float" | "string";
  pref_type: string;
  value: unknown;
}

/** What projectsessionPrefs returns. */
export interface AutoSavePrefs {
  fields: { enabled?: PrefHit | null; interval_minutes?: PrefHit | null; max_versions?: PrefHit | null };
  probed: Array<{ section: string; key: string; requested_type: string; found: boolean; value: unknown; pref_type: string | null }>;
  save_project_on_crash: boolean | null;
  prefs_available: boolean;
}

export type RecoverySource = "auto_save" | "backup" | "checkpoint";

export interface RecoveryFile {
  source: RecoverySource;
  name: string;
  path: string;
  size: number;
  modified_at: string;
  age_minutes: number;
  /** Modified after the project file on disk: it may hold work the saved file lacks. */
  newer_than_project: boolean;
  /** The file name starts with the open project's base name; null when the project has no file. */
  same_project: boolean | null;
}

/** Filled by scanRecoveryFiles: folders where the per-folder file cap stopped the scan. */
export interface ScanInfo {
  capped_dirs: string[];
}

// ---------- schemas ----------

const ACTIONS = ["open", "new", "close", "recover", "autosave"] as const;
const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\/|\\\\)/;
export const MAX_RECOVERY_FILES = 100;
const MAX_SCAN_PER_DIR = 5000;
export const MIN_POLICY_MINUTES = 5;
/** How many of its own backups the timed save keeps. */
export const MAX_POLICY_BACKUPS = 10;
export const AUTO_SAVE_FOLDER = /^Adobe After Effects.*Auto-Save$/i;

const SetPrefsSchema = z
  .object({
    enabled: z.boolean().optional().describe("Turn AE's Auto-Save on or off."),
    interval_minutes: z.number().int().min(1).max(1440).optional().describe("Save every N minutes."),
    max_versions: z.number().int().min(1).max(1000).optional().describe("Maximum project versions to keep."),
  })
  .refine((s) => s.enabled !== undefined || s.interval_minutes !== undefined || s.max_versions !== undefined, {
    message: "set needs at least one of enabled, interval_minutes, max_versions.",
  });

const PolicySchema = z
  .object({
    enabled: z.boolean().describe("Turn the server's timed save on or off."),
    after_writes: z.number().int().min(1).max(200).optional().describe("Save once this many agent writes are unsaved (1-200: the write log holds only the latest 200 writes per project)."),
    after_minutes: z.number().min(MIN_POLICY_MINUTES).max(240).optional().describe("Save once this many minutes have passed since the last save. At least 5: every timed save also copies the whole .aep to _mcp_backups."),
  })
  .refine((p) => !p.enabled || p.after_writes !== undefined || p.after_minutes !== undefined, {
    message: "Turning the policy on needs after_writes, after_minutes or both.",
  });

const ProbeSchema = z.object({
  section: z.string().min(1).max(200),
  key: z.string().min(1).max(200),
  type: z.enum(["bool", "long", "float", "string"]).optional().describe("Default long."),
});

export const AeProjectSessionSchema = z
  .object({
    action: z.enum(ACTIONS).describe(
      "open: open a project file. new: create an empty project. close: close the open project. " +
        "recover: list the newest Auto-Save, backup and checkpoint files (add `path` to open one). " +
        "autosave: read AE's Auto-Save preferences and the server's timed-save policy; change them with `set` or `policy`."
    ),
    expect: ExpectSchema.optional().describe(
      "Required for open, new, close, recover with `path`, and autosave with `set` or an enabled `policy`. Not needed for reads."
    ),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("open: the absolute path of the .aep or .aepx to open. recover: one of the files recover listed, to open."),
    if_dirty: z
      .enum(["ask", "save", "discard"])
      .optional()
      .describe(
        "What to do when the open project has unsaved changes (or AE won't say). Default 'ask': nothing happens and the result has needs_user. " +
          "Ask the user first (ae_ask_user), then call again with 'save' (closes with a save; the project must have a file) or 'discard' (throws the unsaved changes away; use it only on an explicit yes)."
      ),
    project_dir: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("recover: the folder to search when the open project has never been saved (or none is open)."),
    auto_save_dir: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("recover: a custom Auto-Save folder, if the user set one in Preferences."),
    limit: z.number().int().min(1).max(MAX_RECOVERY_FILES).optional().describe("recover: how many files to list. Default 20."),
    set: SetPrefsSchema.optional().describe(
      "autosave: change AE's Auto-Save preferences. Only keys the read found are written, and AE may apply them only at its next launch."
    ),
    policy: PolicySchema.optional().describe(
      "autosave: the opt-in server policy that saves the project after N unsaved writes or M minutes. It overwrites the user's .aep while they edit, so enable it only on request."
    ),
    probe: z.array(ProbeSchema).max(20).optional().describe("autosave: extra preference section/key pairs to look up, to find the real Auto-Save names."),
    user_confirmed: z
      .boolean()
      .optional()
      .describe("Must be true to use autosave `set`, to enable autosave `policy`, and to use if_dirty 'discard' (open, new, close, recover). Set it only after the user said yes."),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const mutating =
      v.action === "open" ||
      v.action === "new" ||
      v.action === "close" ||
      (v.action === "recover" && v.path !== undefined) ||
      (v.action === "autosave" && v.set !== undefined);
    if (mutating && !v.expect) issue("expect is required for this action.");
    if (v.action === "autosave" && v.policy?.enabled === true && !v.expect) {
      issue("Enabling the policy needs expect.project_path: the policy saves only that project.");
    }
    if (v.action === "open") {
      if (!v.path) issue("open needs path.");
    }
    if (v.path !== undefined && v.action !== "open" && v.action !== "recover") issue("path applies to open and recover only.");
    if (v.path !== undefined && !ABSOLUTE_PATH.test(v.path)) issue("path must be absolute.");
    if (v.path !== undefined && (v.action === "open" || v.action === "recover") && !/\.aepx?$/i.test(v.path)) issue("path must be an .aep or .aepx file.");
    if (v.project_dir !== undefined && !ABSOLUTE_PATH.test(v.project_dir)) issue("project_dir must be absolute.");
    if (v.auto_save_dir !== undefined && !ABSOLUTE_PATH.test(v.auto_save_dir)) issue("auto_save_dir must be absolute.");
    if (v.if_dirty !== undefined && !["open", "new", "close", "recover"].includes(v.action)) issue("if_dirty applies to open, new, close and recover.");
    if ((v.project_dir !== undefined || v.auto_save_dir !== undefined || v.limit !== undefined) && v.action !== "recover") {
      issue("project_dir, auto_save_dir and limit apply to recover only.");
    }
    if ((v.set !== undefined || v.policy !== undefined || v.probe !== undefined) && v.action !== "autosave") {
      issue("set, policy and probe apply to autosave only.");
    }
    if (v.if_dirty === "discard" && v.user_confirmed !== true) {
      issue("if_dirty 'discard' throws away unsaved changes: ask the user first (ae_ask_user), then call again with user_confirmed: true.");
    }
    if (v.set !== undefined && v.policy !== undefined) issue("Give set or policy, not both.");
    if (v.set !== undefined && v.user_confirmed !== true) issue("set needs user_confirmed: true, after the user said yes.");
    if (v.policy?.enabled === true && v.user_confirmed !== true) issue("Enabling the policy needs user_confirmed: true, after the user said yes.");
  });

export type AeProjectSessionArgs = z.infer<typeof AeProjectSessionSchema>;

// ---------- pure logic ----------

export interface LeaveVerdict {
  proceed: boolean;
  reason?: string;
}

/**
 * Whether the open project may be left behind. A clean project always may.
 * One with unsaved changes (or an unknown flag) needs an explicit save or
 * discard; saving also needs a file to save to. The host re-checks this.
 */
export function leaveVerdict(dirty: boolean | null, ifDirty: "ask" | "save" | "discard" | undefined, projectPath: string): LeaveVerdict {
  if (dirty === false) return { proceed: true };
  const policy = ifDirty ?? "ask";
  if (policy === "discard") return { proceed: true };
  if (policy === "save") {
    if (projectPath === "<unsaved>") {
      return { proceed: false, reason: "The project has never been saved, so it has no file to save to. Name it with ae_save and save_as: { path }, or discard it." };
    }
    return { proceed: true };
  }
  return {
    proceed: false,
    reason: dirty === null ? "After Effects would not say whether the open project has unsaved changes." : "The open project has unsaved changes.",
  };
}

/** The folders recover searches for a project: Auto-Save, backups and checkpoints. */
export function recoveryDirs(
  projectPath: string,
  projectDir?: string,
  autoSaveDir?: string
): Array<{ source: RecoverySource; dir: string }> {
  const out: Array<{ source: RecoverySource; dir: string }> = [];
  let base: string | null = null;
  if (projectDir) {
    base = projectDir;
  } else if (projectPath !== "<unsaved>") {
    // A project opened from a backup or checkpoint folder belongs to the folder above it.
    let dir = path.dirname(projectPath);
    const leaf = path.basename(dir);
    if (leaf === "_mcp_checkpoints" || leaf === "_mcp_backups" || AUTO_SAVE_FOLDER.test(leaf)) dir = path.dirname(dir);
    base = dir;
  }
  if (autoSaveDir) out.push({ source: "auto_save", dir: autoSaveDir });
  if (base) {
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && AUTO_SAVE_FOLDER.test(e.name)) out.push({ source: "auto_save", dir: path.join(base, e.name) });
      }
    } catch {
      // An unreadable folder just has no auto-save folder to list.
    }
    out.push({ source: "backup", dir: path.join(base, "_mcp_backups") });
    out.push({ source: "checkpoint", dir: path.join(base, "_mcp_checkpoints") });
  }
  return out;
}

/** Project files in the given folders, newest first. Never throws. */
export function scanRecoveryFiles(
  dirs: Array<{ source: RecoverySource; dir: string }>,
  projectFileMtimeMs: number | null,
  nowMs: number,
  info?: ScanInfo
): RecoveryFile[] {
  const files: Array<RecoveryFile & { mtimeMs: number }> = [];
  const seen = new Set<string>();
  for (const { source, dir } of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let n = 0;
    for (const e of entries) {
      if (!e.isFile() || !/\.aepx?$/i.test(e.name)) continue;
      if (++n > MAX_SCAN_PER_DIR) {
        info?.capped_dirs.push(dir);
        break;
      }
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const st = fs.statSync(full);
        files.push({
          source,
          name: e.name,
          path: full,
          size: st.size,
          modified_at: st.mtime.toISOString(),
          age_minutes: Math.max(0, Math.round((nowMs - st.mtimeMs) / 60_000)),
          newer_than_project: projectFileMtimeMs !== null && st.mtimeMs > projectFileMtimeMs,
          same_project: null,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // A file that vanished between readdir and stat is skipped.
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return files.map(({ mtimeMs: _m, ...rest }) => rest);
}

/**
 * Agent writes to `projectPath` since `sinceMs`, from the session tracker's
 * undo steps. This tool's own steps (open, new, close, preferences) are not
 * edits to the project. The panel can show it as a badge.
 */
export function countUnsavedWrites(steps: UndoStep[], projectPath: string, sinceMs: number): number {
  let n = 0;
  for (const s of steps) {
    if (s.tool === "ae_project_session") continue;
    if (!pathsMatchForGuard(projectPath, s.project_path)) continue;
    const at = Date.parse(s.at);
    if (Number.isFinite(at) && at > sinceMs) n++;
  }
  return n;
}

/** Agent writes (guarded or not) to a project, from the tracker's write log; saves and this tool's own calls are not edits. */
export function countAgentWrites(writes: AgentWrite[]): number {
  return writes.filter((w) => w.tool !== "ae_project_session" && w.tool !== "ae_save").length;
}

export interface AutoSavePolicy {
  enabled: boolean;
  /** The project the policy was enabled for: it saves no other. */
  project_path?: string;
  after_writes?: number;
  after_minutes?: number;
}

/** Whether the policy says to save now. The caller has already checked dirty, saved-before, dialogs and the queue. */
export function autosaveDue(
  policy: AutoSavePolicy,
  unsavedWrites: number | null,
  minutesSinceSave: number
): { due: boolean; why?: string } {
  if (!policy.enabled) return { due: false };
  if (policy.after_writes !== undefined && unsavedWrites !== null && unsavedWrites >= policy.after_writes) {
    return { due: true, why: `${unsavedWrites} unsaved writes (limit ${policy.after_writes})` };
  }
  if (policy.after_minutes !== undefined && minutesSinceSave >= policy.after_minutes) {
    return { due: true, why: `${Math.floor(minutesSinceSave)} minutes since the last save (limit ${policy.after_minutes})` };
  }
  return { due: false };
}

// ---------- checks ----------

const summary = (s: ProjectState | null) =>
  s ? { project_path: s.project_path, dirty: s.dirty, num_items: s.num_items } : null;

const stateOf = (v: unknown): ProjectState | null => (v && typeof v === "object" ? (v as ProjectState) : null);

/** Notes for an open that read back oddly but may be correct. */
export function openNotes(written: Record<string, unknown>, after: unknown): string[] {
  const notes: string[] = [];
  const s = stateOf(after);
  if (!s || written.applied === false || written.opened !== true) return notes;
  if (s.project_path === "<unsaved>") {
    notes.push(
      "After Effects opened the file but the project has no path: it was most likely converted from an older version. Save As (to a new name) before working on it."
    );
  }
  if (s.dirty === true) {
    notes.push(
      "The project reads as having unsaved changes right after opening (After Effects may have substituted missing fonts or footage). Not treated as a failure; check ae_dialogs and the missing footage before saving."
    );
  }
  return notes;
}

/** The read-back after open: the path AE reports is the one asked for. A converted (untitled) project and a dirty flag are notes, not mismatches. */
export function openMismatches(target: string, written: Record<string, unknown>, after: unknown): ReceiptMismatch[] {
  const out: ReceiptMismatch[] = [];
  if (written.applied === false) return out;
  const s = stateOf(after);
  expectThat(out, written.opened === true, "opened", true, written.opened, `app.open did not open the project${written.error ? `: ${String(written.error)}` : "."}`);
  if (!s) return out;
  const converted = written.opened === true && s.project_path === "<unsaved>";
  if (!converted) {
    expectThat(out, pathsMatchForGuard(target, s.project_path), "project_path", target, s.project_path, "The open project is not the file that was asked for.");
  }
  return out;
}

/** The read-back after new or close: an untitled project is open. Its item count is information: a "New Project loads template" preference gives it items. */
export function emptyProjectMismatches(kind: "new" | "close", written: Record<string, unknown>, after: unknown): ReceiptMismatch[] {
  const out: ReceiptMismatch[] = [];
  if (written.applied === false) return out;
  const flag = kind === "new" ? written.created : written.closed;
  expectThat(out, flag === true, kind === "new" ? "created" : "closed", true, flag, `The project was not ${kind === "new" ? "created" : "closed"}${written.error ? `: ${String(written.error)}` : "."}`);
  const s = stateOf(after);
  if (!s) return out;
  expectThat(out, s.project_path === "<unsaved>", "project_path", "<unsaved>", s.project_path, "A project with a file is still open.");
  return out;
}

/** The read-back after preferences were set: each written field reads back the value written. */
export function prefsMismatches(written: Record<string, unknown>, after: unknown): ReceiptMismatch[] {
  const out: ReceiptMismatch[] = [];
  if (written.applied === false) return out;
  const prefs = after && typeof after === "object" ? (after as AutoSavePrefs) : null;
  const list = Array.isArray(written.written) ? (written.written as Array<{ field: string; value: unknown }>) : [];
  const failed = Array.isArray(written.failed) ? (written.failed as Array<{ field: string; error?: string }>) : [];
  for (const f of failed) {
    out.push({ path: `failed.${f.field}`, expected: "written", actual: "refused", message: `After Effects refused the ${f.field} preference${f.error ? `: ${f.error}` : "."}` });
  }
  if (written.saved_to_disk === false) {
    out.push({ path: "saved_to_disk", expected: true, actual: false, message: `saveToDisk failed${written.error ? `: ${String(written.error)}` : "."}` });
  }
  if (!prefs) return out;
  for (const w of list) {
    const hit = (prefs.fields as Record<string, PrefHit | null | undefined>)[w.field];
    // A long-typed "enabled" reads back as 0 or 1.
    const want = hit?.type === "long" && typeof w.value === "boolean" ? (w.value ? 1 : 0) : w.value;
    expectThat(out, !!hit && hit.value === want, `fields.${w.field}`, want, hit?.value, `The ${w.field} preference does not read back the value written.`);
  }
  return out;
}

// ---------- the timed-save policy ----------

interface PolicyState {
  policy: AutoSavePolicy;
  started_at: number;
  timer: ReturnType<typeof setInterval> | null;
  ctx: ToolContext | null;
  ticking: boolean;
  auto_saves: number;
  last_auto_save_at: number | null;
  last_skip: string | null;
  last_error: string | null;
  /** Whether the last timed save's receipt matched; null before the first. */
  last_save_matched: boolean | null;
  /** Backups the policy itself made, oldest first; it prunes beyond MAX_POLICY_BACKUPS. */
  own_backups: string[];
}

const TOOL = "ae_project_session";
const TICK_MS = 30_000;

const policyState: PolicyState = {
  policy: { enabled: false },
  started_at: 0,
  timer: null,
  ctx: null,
  ticking: false,
  auto_saves: 0,
  last_auto_save_at: null,
  last_skip: null,
  last_error: null,
  last_save_matched: null,
  own_backups: [],
};

export interface TickDeps {
  now?: () => number;
  /** Open dialogs, or null when they cannot be listed (the tick then does nothing). */
  dialogs?: () => Promise<unknown[] | null>;
  steps?: () => UndoStep[];
  fileMtimeMs?: (p: string) => number | null;
  save?: (ctx: ToolContext, projectPath: string) => Promise<unknown>;
  removeFile?: (p: string) => void;
}

const defaultMtime = (p: string): number | null => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/** Open dialogs without screenshots; null when the list failed, so the tick is skipped instead of reading as "no dialog". */
const defaultDialogs = async (): Promise<unknown[] | null> => {
  const res = await listBlockingDialogs({ screenshots: false });
  return res.ok ? (res.dialogs ?? []) : null;
};

const defaultSave = async (ctx: ToolContext, projectPath: string) => {
  const save = mutateTools.find((t) => t.name === "ae_save");
  if (!save) throw new Error("ae_save is not registered.");
  return save.handler({ expect: { project_path: projectPath }, backup: true }, ctx);
};

/** The unsaved-write count and minutes since the last save for a project. */
function sinceSave(projectPath: string, deps: TickDeps) {
  const now = (deps.now ?? Date.now)();
  const mtime = (deps.fileMtimeMs ?? defaultMtime)(projectPath);
  const since = Math.max(mtime ?? 0, policyState.last_auto_save_at ?? 0);
  let writes: number | null = null;
  if (deps.steps) {
    writes = countUnsavedWrites(deps.steps(), projectPath, since);
  } else {
    // The write log covers unguarded writes (effects, text, imports...) that leave no undo step.
    const tracker = getSessionTracker();
    if (tracker) writes = countAgentWrites(tracker.agentWritesSince(projectPath, since > 0 ? new Date(since).toISOString() : null));
  }
  return {
    writes,
    minutes: (now - Math.max(since, policyState.started_at)) / 60_000,
  };
}

/** Remembers the backup a timed save made and deletes the policy's own oldest ones beyond the cap. */
function keepOwnBackups(saved: unknown, deps: TickDeps): void {
  const bp = saved && typeof saved === "object" ? (saved as { backup_path?: unknown }).backup_path : null;
  if (typeof bp !== "string" || bp.length === 0) return;
  policyState.own_backups.push(bp);
  const remove = deps.removeFile ?? ((f: string) => fs.unlinkSync(f));
  while (policyState.own_backups.length > MAX_POLICY_BACKUPS) {
    const old = policyState.own_backups.shift() as string;
    try {
      remove(old);
    } catch {
      // A backup that is already gone needs no deleting.
    }
  }
}

/**
 * One look at whether the policy should save. The checks that need no After
 * Effects come first (policy on, nothing queued, a threshold reached for the
 * project the policy was enabled for); dialogs are checked before any
 * evalScript, because an evalScript behind a modal dialog would hold the queue
 * until it times out. Then a light read confirms the same saved, dirty project
 * is open. Never throws.
 */
export async function autosaveTick(ctx: ToolContext, deps: TickDeps = {}): Promise<{ saved: boolean; skipped?: string }> {
  const skip = (reason: string) => {
    policyState.last_skip = reason;
    return { saved: false as const, skipped: reason };
  };
  const busy = () => ctx.queue.inFlight !== null || ctx.queue.depth > 0;
  try {
    const target = policyState.policy.project_path;
    if (!policyState.policy.enabled) return skip("The policy is off.");
    if (!target) return skip("The policy has no project to save.");
    if (ctx.quarantine.isQuarantined) return skip("Writes are quarantined.");
    if (busy()) return skip("A write or read is in flight or queued.");
    const { writes, minutes } = sinceSave(target, deps);
    const due = autosaveDue(policyState.policy, writes, minutes);
    if (!due.due) return skip("No threshold reached.");
    const dialogs = await (deps.dialogs ?? defaultDialogs)();
    if (dialogs === null) return skip("Open dialogs could not be listed, so After Effects was not touched.");
    if (dialogs.length > 0) return skip("A dialog is open in After Effects.");
    // The checks above awaited: something may have queued meanwhile.
    if (busy()) return skip("A write or read is in flight or queued.");
    const read = await ctx.bridge.callHost<Pick<ProjectState, "project_path" | "dirty">>("projectsessionState", {}, {
      label: "quiet:ae_project_session (autosave check)",
      mutates: false,
      toolName: TOOL,
    });
    const state = read.result;
    if (state.project_path === "<unsaved>") return skip("The project has never been saved.");
    if (!pathsMatchForGuard(target, state.project_path)) return skip("A different project is open than the one the policy was enabled for.");
    if (state.dirty !== true) return skip("The project has no unsaved changes.");
    if (busy()) return skip("A write or read is in flight or queued.");
    const saved = await (deps.save ?? defaultSave)(ctx, target);
    keepOwnBackups(saved, deps);
    const receipt = saved && typeof saved === "object" ? (saved as { receipt?: { matches?: unknown; mismatches?: unknown } }).receipt : undefined;
    if (receipt && receipt.matches === false) {
      // The save did not take (dirty still true, or the read-back failed): not an auto-save, and the minutes clock keeps running.
      const first = Array.isArray(receipt.mismatches) ? (receipt.mismatches[0] as { message?: unknown } | undefined) : undefined;
      policyState.last_save_matched = false;
      policyState.last_error = `The timed save's receipt did not match${typeof first?.message === "string" ? `: ${first.message}` : "."}`;
      return skip(policyState.last_error);
    }
    policyState.auto_saves++;
    policyState.last_auto_save_at = (deps.now ?? Date.now)();
    policyState.last_skip = null;
    policyState.last_error = null;
    policyState.last_save_matched = receipt ? true : null;
    return { saved: true };
  } catch (err) {
    policyState.last_error = err instanceof Error ? err.message : String(err);
    return skip(`The check failed: ${policyState.last_error}`);
  }
}

/** Turns the timed save on or off. The timer is unref'd so it never keeps the server alive. */
export function setAutosavePolicy(ctx: ToolContext, policy: AutoSavePolicy, deps: TickDeps = {}): void {
  if (policyState.timer) clearInterval(policyState.timer);
  policyState.timer = null;
  policyState.policy = policy;
  policyState.ctx = ctx;
  if (!policy.enabled) return;
  policyState.started_at = (deps.now ?? Date.now)();
  policyState.last_skip = null;
  policyState.own_backups = [];
  policyState.timer = setInterval(() => {
    if (policyState.ticking) return;
    policyState.ticking = true;
    void autosaveTick(ctx, deps).finally(() => {
      policyState.ticking = false;
    });
  }, TICK_MS);
  policyState.timer.unref?.();
}

/** Turns the policy off because another project was opened or created. True when it was on. */
export function disablePolicyForSwitch(): boolean {
  if (!policyState.policy.enabled) return false;
  if (policyState.timer) clearInterval(policyState.timer);
  policyState.timer = null;
  policyState.policy = { enabled: false };
  policyState.last_skip = "Turned off: this tool opened, created or closed a project.";
  return true;
}

// ae_save save_as / increment points the open project at a new file; the timed save was for the old one.
registerProjectRetargetHook((oldPath, newPath) => {
  const target = policyState.policy.project_path;
  if (!policyState.policy.enabled || !target || !pathsMatchForGuard(target, oldPath)) return null;
  // Save As onto the same file (overwrite) did not move the project: the policy is still for it.
  if (pathsMatchForGuard(oldPath, newPath)) return null;
  if (policyState.timer) clearInterval(policyState.timer);
  policyState.timer = null;
  policyState.policy = { enabled: false };
  policyState.last_skip = "Turned off: ae_save moved the open project to another file.";
  return "The timed-save policy was turned off because ae_save moved the open project to another file; it only saves the project it was enabled for. Enable it again for the new file if the user still wants it.";
});

/** For tests and shutdown. */
export function stopAutosavePolicy(): void {
  if (policyState.timer) clearInterval(policyState.timer);
  policyState.timer = null;
  policyState.policy = { enabled: false };
  policyState.ctx = null;
  policyState.ticking = false;
  policyState.auto_saves = 0;
  policyState.last_auto_save_at = null;
  policyState.last_skip = null;
  policyState.last_error = null;
  policyState.last_save_matched = null;
  policyState.own_backups = [];
}

function policyStatus(deps: TickDeps = {}) {
  const target = policyState.policy.project_path;
  const writes = policyState.policy.enabled && target ? sinceSave(target, deps).writes : null;
  return {
    ...policyState.policy,
    // Writes the agent made since the last save; null without session tracking or an enabled policy.
    unsaved_writes: writes,
    auto_saves: policyState.auto_saves,
    last_auto_save_at: policyState.last_auto_save_at ? new Date(policyState.last_auto_save_at).toISOString() : null,
    last_skip: policyState.last_skip,
    last_error: policyState.last_error,
    last_save_matched: policyState.last_save_matched,
    backups_kept: policyState.own_backups.length,
    max_backups: MAX_POLICY_BACKUPS,
    backup_note: `Each timed save copies the whole .aep into _mcp_backups; the policy deletes its own oldest copies beyond ${MAX_POLICY_BACKUPS}.`,
    persists_across_restart: false,
  };
}

// ---------- handlers ----------

async function readState(ctx: ToolContext, label: string): Promise<ProjectState> {
  const res = await ctx.bridge.callHost<ProjectState>("projectsessionRead", {}, { label, mutates: false, toolName: TOOL });
  return res.result;
}

function needsUserResult(state: ProjectState, reason: string) {
  return {
    applied: false as const,
    needs_user: true as const,
    reason,
    dirty: state.dirty,
    project_path: state.project_path,
    options: ["save", "discard", "cancel"],
    message:
      "Ask the user: save the changes, discard them, or cancel. Then call again with if_dirty: 'save' or 'discard', or stop for 'cancel'. Nothing was changed.",
  };
}

/** open / new / close through the guarded write, after the unsaved-work check. */
async function leaveAndRun(ctx: ToolContext, args: AeProjectSessionArgs, kind: "open" | "new" | "close", target?: string) {
  ctx.quarantine.assertClear();
  const expect = args.expect as ExpectGuard;
  const state = await readState(ctx, `${TOOL} (${kind} check)`);
  // Guard first: a different project than expect names gets a guard error, not a
  // needs_user about someone else's changes, and no backup of its file.
  if (!pathsMatchForGuard(expect.project_path, state.project_path)) {
    throw new BridgeError({
      kind: "guard",
      message: "Target guard refused mutation: the open project does not match expect.project_path. Stop and re-read state.",
      expected: { project_path: expect.project_path },
      actual: { project_path: state.project_path },
    });
  }
  const verdict = leaveVerdict(state.dirty, args.if_dirty, state.project_path);
  if (!verdict.proceed) return needsUserResult(state, verdict.reason ?? "The open project has unsaved changes.");
  if (kind === "open" && target && !fs.existsSync(target)) {
    throw new BridgeError({ kind: "guard", message: `Project file does not exist on disk: "${target}".`, expected: { path: target }, actual: { exists: false } });
  }

  const hostName = kind === "open" ? "projectsessionOpen" : kind === "new" ? "projectsessionNew" : "projectsessionClose";

  // if_dirty "save" overwrites the user's file: copy it to _mcp_backups first,
  // like ae_save does, whatever the dirty flag said a moment ago (the user may
  // edit before the write runs, and the host then saves). A copy that fails
  // stops the call before anything changes.
  let backupPath: string | null = null;
  if (args.if_dirty === "save") backupPath = backupProjectFile(state.project_path);

  const hostArgs: Record<string, unknown> = { if_dirty: args.if_dirty ?? "ask", backup_taken: backupPath !== null };
  if (kind === "open") hostArgs.path = target;
  // A big project, or a dialog the user answers slowly, takes longer than the default timeout.
  const write = { host: hostName, args: hostArgs, timeoutMs: SLOW_TIMEOUT_MS };

  let result: Record<string, unknown>;
  try {
    result = await runGuardedWrite<Record<string, unknown>>(ctx, {
      toolName: TOOL,
      label: `${TOOL}(${kind})`,
      expect,
      read: () => ({ host: "projectsessionRead", args: {} }),
      write,
      check: (_before, after, written) => {
        if (kind === "open") return openMismatches(target as string, written, after);
        return emptyProjectMismatches(kind, written, after);
      },
      present: (before, after, written) => {
        const now = stateOf(after);
        return {
          ...written,
          // The write's own script read these; the separate read-back is the trusted value.
          ...(now ? { project_path: now.project_path, dirty: now.dirty } : {}),
          action: kind,
          backup_path: backupPath,
          notes: kind === "open" ? openNotes(written, after) : [],
          project: summary(now),
          previous_project: summary(stateOf(before)),
          missing_footage: now?.missing_footage ?? null,
          baseline: "the open project is the baseline ae_session_changes compares against from now on",
        };
      },
    });
  } catch (err) {
    // A timed-out or failed write may already have closed the project. A refused one (guard, queue) touched nothing.
    if (!(err instanceof BridgeError && (err.kind === "guard" || err.kind === "queued"))) markReopened();
    throw err;
  }
  if (result.closed_previous === true || result.closed === true) markReopened();
  // A different project is open now: the timed save was for the old one.
  if (result.applied !== false && disablePolicyForSwitch()) {
    return { ...result, policy_disabled: "The timed-save policy was turned off because this tool opened, created or closed a project. Enable it again for this project if the user still wants it." };
  }
  return result;
}

/** Opening or closing a project clears After Effects' undo history: tell the session tracker. Never throws. */
function markReopened(): void {
  try {
    getSessionTracker()?.markReopened();
  } catch {
    // Bookkeeping only.
  }
}

/** Copies the project file to <project dir>/_mcp_backups, named like ae_save's backups. Throws if it can't (nothing has changed yet). */
function backupProjectFile(projectPath: string): string | null {
  if (projectPath === "<unsaved>" || !fs.existsSync(projectPath)) return null;
  try {
    const ext = path.extname(projectPath) || ".aep";
    const base = path.basename(projectPath, ext);
    const dir = path.join(path.dirname(projectPath), "_mcp_backups");
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${base}_${formatBackupTimestamp(new Date())}`;
    let target = path.join(dir, `${stem}${ext}`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem}-${n}${ext}`);
    fs.copyFileSync(projectPath, target);
    return target;
  } catch (err) {
    throw new BridgeError({
      kind: "guard",
      message: `Could not back up the project before saving it, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`,
      expected: { backup: true },
      actual: { backup: false },
    });
  }
}

async function recover(ctx: ToolContext, args: AeProjectSessionArgs) {
  const state = await readState(ctx, `${TOOL} (recover list)`);
  const dirs = recoveryDirs(state.project_path, args.project_dir, args.auto_save_dir);
  let projectMtime: number | null = null;
  if (state.project_path !== "<unsaved>") {
    try {
      projectMtime = fs.statSync(state.project_path).mtimeMs;
    } catch {
      projectMtime = null;
    }
  }
  const scan: ScanInfo = { capped_dirs: [] };
  const files = scanRecoveryFiles(dirs, projectMtime, Date.now(), scan);
  // The Auto-Save folder and _mcp_backups can hold other projects' files: mark this project's, and list them first.
  const base = state.project_path === "<unsaved>" ? null : path.basename(state.project_path, path.extname(state.project_path)).toLowerCase();
  for (const f of files) f.same_project = base === null ? null : f.name.toLowerCase().startsWith(base);
  if (base !== null) {
    const ordered = [...files.filter((f) => f.same_project), ...files.filter((f) => !f.same_project)];
    files.splice(0, files.length, ...ordered);
  }

  if (args.path) {
    const listed = files.find((f) => pathsMatchForGuard(args.path as string, f.path));
    if (!listed) {
      throw new BridgeError({
        kind: "guard",
        message: "That file is not one recover lists. Call recover without `path` and pick from its files.",
        expected: { path: args.path },
        actual: { listed: files.slice(0, 5).map((f) => f.path) },
      });
    }
    const opened = await leaveAndRun(ctx, args, "open", listed.path);
    const o = opened as { applied?: unknown; opened?: unknown };
    if (o.applied === false || o.opened !== true) return { ...opened, recover_target: listed.path };
    return {
      ...opened,
      recovered_from: { source: listed.source, name: listed.name, modified_at: listed.modified_at },
      note: "The open project is the recovery copy, not the original. Ask the user to Save As over the original or to a new name before working on it: otherwise ae_save, timed saves and auto checkpoints write into the recovery folder.",
    };
  }

  const limit = args.limit ?? 20;
  return {
    project_path: state.project_path,
    dirty: state.dirty,
    searched: dirs.map((d) => ({ source: d.source, dir: d.dir, exists: fs.existsSync(d.dir) })),
    files: files.slice(0, limit),
    total: files.length,
    truncated: files.length > limit,
    scan_truncated: scan.capped_dirs.length > 0,
    capped_dirs: scan.capped_dirs,
    hint:
      dirs.length === 0
        ? "The open project has never been saved: pass project_dir (the folder it would be in) or auto_save_dir."
        : "Pick a file and call recover again with its `path` to open it. Files with newer_than_project may hold work the saved project lacks; same_project is true for files named after the open project (the others belong to other projects).",
  };
}

async function autosave(ctx: ToolContext, args: AeProjectSessionArgs) {
  if (args.policy) {
    const p = args.policy;
    if (!p.enabled) {
      setAutosavePolicy(ctx, { enabled: false });
      return { action: "autosave", changed: "policy", policy: policyStatus() };
    }
    // The policy saves one project: the one named in expect, which must be the open, saved one.
    const target = (args.expect as ExpectGuard).project_path;
    const state = await readState(ctx, `${TOOL} (policy target)`);
    if (state.project_path === "<unsaved>" || !pathsMatchForGuard(target, state.project_path)) {
      throw new BridgeError({
        kind: "guard",
        message:
          state.project_path === "<unsaved>"
            ? "The open project has never been saved, so a timed save has no file to write. Name it first with ae_save and save_as: { path }."
            : "expect.project_path is not the open project. The timed save is tied to one project: re-read the state and try again.",
        expected: { project_path: target },
        actual: { project_path: state.project_path },
      });
    }
    setAutosavePolicy(ctx, { enabled: true, project_path: state.project_path, after_writes: p.after_writes, after_minutes: p.after_minutes });
    return { action: "autosave", changed: "policy", policy: policyStatus() };
  }

  if (args.set) {
    ctx.quarantine.assertClear();
    const expect = args.expect as ExpectGuard;
    const result = await runGuardedWrite<Record<string, unknown>>(ctx, {
      toolName: TOOL,
      label: `${TOOL}(autosave set)`,
      expect,
      read: () => ({ host: "projectsessionPrefs", args: {} }),
      write: { host: "projectsessionPrefsSet", args: { set: args.set } },
      check: (_before, after, written) => prefsMismatches(written, after),
      present: (_before, after, written) => ({
        ...written,
        action: "autosave",
        auto_save: after,
        note: "After Effects may read these preferences only at its next launch. The read-back shows what the preferences hold, not what the running session uses.",
      }),
    });
    return result;
  }

  const prefs = await ctx.bridge.callHost<AutoSavePrefs>("projectsessionPrefs", { probe: args.probe ?? [] }, {
    label: `${TOOL} (autosave read)`,
    mutates: false,
    toolName: TOOL,
  });
  const state = await readState(ctx, `${TOOL} (autosave state)`);
  const p = prefs.result;
  const notFound = (["enabled", "interval_minutes", "max_versions"] as const).filter((f) => !p.fields[f]);
  return {
    action: "autosave",
    project_path: state.project_path,
    dirty: state.dirty,
    auto_save: p,
    not_found: notFound,
    policy: policyStatus(),
    hint:
      notFound.length > 0
        ? "Some Auto-Save preference keys were not found under the names probed (they are undocumented). Pass `probe` to look up others, or ask the user to check Edit > Preferences > Auto-Save."
        : "AE's own Auto-Save writes rolling copies without touching the project file; prefer it. Ask the user before changing it.",
  };
}

// ---------- tool ----------

export const projectsessionTools: ToolDefinition<any>[] = [
  {
    name: "ae_project_session",
    description:
      "Open, create, close and recover After Effects projects without losing work, and manage AE's Auto-Save. " +
      "open / new / close read the unsaved-changes flag first. With unsaved changes the result is `needs_user` (save, discard or cancel) and nothing is touched: ask the user (ae_ask_user), then repeat with `if_dirty: 'save'` or `'discard'`. The save prompt is never suppressed; if AE raises a dialog (missing footage or fonts, a file converted from an older version), it blocks until answered, so read it with ae_dialogs and answer through the user or ae_dialog_respond. " +
      "After open, a separate read-back reports the open path, dirty flag, item count and missing footage (`missing_footage.count`, with paths), and the session tracker takes the project as its new baseline. Opening, creating or closing a project ends the undo history of the old one (Ctrl+Z cannot reach earlier steps), and these calls add no undo step. A file that fails to open leaves an untitled project; the host then re-opens the previous file when it was clean or just saved (`restored_previous`). `if_dirty: 'save'` first copies the .aep to `_mcp_backups` (`backup_path`) and then closes with a save (the host refuses to save without that copy). `if_dirty: 'discard'` also needs `user_confirmed: true`, set only after the user said yes. open and recover `path` and recover `project_dir` / `auto_save_dir` must be absolute; open and recover `path` must end in .aep or .aepx. The write may take up to 10 minutes (a very large project, or a dialog the user answers slowly) before it times out. " +
      "recover lists the newest .aep/.aepx files (by modified time) in AE's Auto-Save folder next to the project, `_mcp_backups` and `_mcp_checkpoints`; repeat with `path` to open one. A custom Auto-Save folder is passed as `auto_save_dir`. " +
      "autosave with no `set` or `policy` reads AE's Auto-Save preferences (the key names are undocumented: the host probes likely ones and says which it found; add `probe` to look up others) and `saveProjectOnCrash`. `set` changes found keys only after the user said yes (`user_confirmed: true`), and AE may apply them at its next launch. `policy` is an opt-in server timer (needs `expect.project_path`, the open saved project, which it is tied to; M is at least 5 minutes) that saves after N unsaved writes or M minutes (ae_save, backup first), only when that project is still open, has been saved before, is dirty, nothing is queued or running and no dialog is open. It overwrites the user's .aep while they edit and writes a full copy to `_mcp_backups` each time (it deletes its own oldest copies beyond 10, only those made since it was last enabled in this server session), so enable it only on request. It turns itself off when this tool opens, creates or closes a project (including re-opening the same one), stays in server memory, and reports `unsaved_writes` (the agent's writes since the last save, from the session write log when session tracking is on, else null) and `last_save_matched`; a timed save whose receipt does not match is not counted. " +
      "A project made with `new` has no file yet: name and save it with ae_save and save_as: { path } (a plain ae_save cannot save it). " +
      "Mutating actions take `expect`. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeProjectSessionSchema,
    handler: async (args: AeProjectSessionArgs, ctx: ToolContext) => {
      switch (args.action) {
        case "open":
          return leaveAndRun(ctx, args, "open", args.path);
        case "new":
          return leaveAndRun(ctx, args, "new");
        case "close":
          return leaveAndRun(ctx, args, "close");
        case "recover":
          return recover(ctx, args);
        default:
          return autosave(ctx, args);
      }
    },
  },
];
