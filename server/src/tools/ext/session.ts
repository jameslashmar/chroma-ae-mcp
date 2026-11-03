/**
 * server/src/tools/ext/session.ts
 *
 * ae_session_changes: what the user changed in After Effects since the
 * agent's last write, what a crash left unfinished, and which of the agent's
 * undo steps Ctrl+Z can no longer reach.
 *
 * How it works:
 * - After each guarded write the server keeps a compact snapshot (project
 *   path, dirty flag, item ids, active item, and per touched comp the layer
 *   count, selection, work area, time and a hash of the layer stack) from the
 *   sessionSnapshot host function. The tool, and a short `user_changed` line
 *   on every write receipt, diff the live state against it.
 * - Before each write a record is written to disk (inflight-ops.json) and
 *   removed when the write's evalScript returns. AE takes the service down
 *   with it, so a record left behind at the next start is a write whose
 *   outcome is unknown: it goes into quarantine (never retried) and is shown
 *   here.
 * - AE has no API that reads the undo stack. The tool can prove an undo step
 *   unreachable (another project, a restart, a revision that went back) and
 *   otherwise says only "possibly reachable". It always points to the
 *   checkpoint.
 *
 * Tracking is off until installSessionTracking() runs (the lead calls it at
 * startup); write-runner.ts and mutate.ts call the note* hooks, which do
 * nothing before that. Tools that call evalRaw/callHost with mutates:true
 * without the guarded path are covered by installSessionBridgeHook(bridge),
 * which the lead also calls at startup. Every hook swallows its own errors: a
 * bookkeeping failure must never fail or repeat a write.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { SLOW_TIMEOUT_MS, type HostTransport } from "../../host.js";
import { buildJsxCall, pathsMatchForGuard } from "../../jsx.js";
import type { QuarantineStore } from "../../quarantine.js";
import { type ExpectGuard, type ToolContext, type ToolDefinition } from "../common.js";

// ---------- snapshot shape (what sessionSnapshot returns) ----------

export interface SessionCompState {
  id: number;
  name?: string;
  /** The comp was asked for but is not in the project (deleted, or another project). */
  missing?: boolean;
  num_layers?: number;
  selected?: number[];
  selected_truncated?: boolean;
  work_area_start?: number | null;
  work_area_duration?: number | null;
  time?: number | null;
  hash?: string;
  hash_truncated?: boolean;
}

export interface SessionSnapshot {
  project_path: string;
  dirty: boolean | null;
  /** Project.revision: documented, behaviour unmeasured. A hint, null when AE gives none. */
  revision: number | null;
  num_items: number;
  item_ids: number[];
  items_truncated: boolean;
  active_item: { id: number; name: string; kind: string } | null;
  ae_version: string | null;
  build: string | null;
  render_queue: { num_items: number; queued: number; rendering: number } | null;
  comps: SessionCompState[];
}

/** A snapshot as the server keeps it. */
export interface StoredSnapshot extends SessionSnapshot {
  taken_at: string;
  /** The write it was taken after; null for a rebase. */
  op_id: string | null;
  tool: string;
  /** Which run of the service took it; a different one means AE or the panel restarted. */
  service_id: string;
}

export interface UndoStep {
  op_id: string;
  tool: string;
  label: string;
  at: string;
  project_path: string;
  service_id: string;
  revision_after: number | null;
  checkpoint: string | null;
  /** The AE build when the step was made; a different build now means AE was restarted or updated. */
  build?: string | null;
  /** Up to 100 project item ids when the step was made, to tell a Save As from another project. */
  item_ids?: number[];
  num_items?: number;
}

export interface InflightOp {
  op_id: string;
  tool: string;
  label: string;
  project_path: string;
  comp_id: number | null;
  started_at: string;
  pid: number;
  service_id: string;
  /** Hash of the comp's layer stack at the last snapshot, to compare against later. */
  last_known_hash: string | null;
}

export interface InterruptedOp extends InflightOp {
  recovered_at: string;
  reason: string;
  /** The op went into quarantine, so ae_acknowledge is how it gets handled. */
  quarantined?: boolean;
}

const MAX_SNAPSHOTS = 10;
const MAX_STEPS = 200;
const MAX_TOUCHED = 20;
const MAX_OP_PROJECTS = 200;
const MAX_INTERRUPTED = 20;
const MAX_SHOWN_IDS = 100;
const MAX_STEP_ITEM_IDS = 100;
const MAX_PENDING_LINES = 10;
const MAX_AGENT_WRITES = 200;
/** A snapshot read inside a write only stops waiting after this long (never aborts the evalScript): a stuck AE must not hold the queue for the 120 s default. */
export const SNAPSHOT_TIMEOUT_MS = 8_000;
const UNSAVED = "<unsaved>";
const UNKNOWN_PROJECT = "<unknown>";
/** A write cannot run longer than the largest eval timeout; a record older than this is dead whatever its pid says. */
const MAX_INFLIGHT_AGE_MS = SLOW_TIMEOUT_MS + 5 * 60_000;

// ---------- pure logic: diffing ----------

export interface CompChange {
  id: number;
  name: string | null;
  status: "changed" | "unchanged" | "removed" | "no_baseline";
  layers: { before: number | null; now: number | null };
  /** The layer ids, order, names or in/out points differ (the hash, or the count). */
  stack_changed: boolean;
  selection_changed: boolean;
  selection_now: number[];
  work_area_changed: boolean;
  /** The current time moved. A hint: scrubbing is not an edit. */
  time_changed: boolean;
}

export interface SessionDiff {
  /** Anything that matters to the next write changed (hints alone do not count). */
  changed: boolean;
  project_swapped: boolean;
  previous_path: string;
  current_path: string;
  service_restarted: boolean;
  ae_build_changed: boolean;
  /** The revision went back: the project was reopened or reverted (unmeasured signal). */
  reopened_or_reverted_suspected: boolean;
  items: {
    /** False when either list was capped: only the counts are compared. */
    exact: boolean;
    count_before: number;
    count_now: number;
    added: number[];
    removed: number[];
    added_count: number;
    removed_count: number;
  } | null;
  active_item: { before: SessionSnapshot["active_item"]; now: SessionSnapshot["active_item"] } | null;
  render_queue_changed: boolean;
  comps: CompChange[];
  hints: {
    dirty: { before: boolean | null; now: boolean | null } | null;
    revision_delta: number | null;
    time_changed_comps: number[];
  };
  /** One line for a write receipt; null when nothing changed. */
  user_changed: string | null;
}

/**
 * Two "<unsaved>" snapshots are one project only while most item ids carry
 * over. After File > New, or an AE restart into a new project, the ids hardly
 * overlap. Capped lists cannot be judged, so they count as the same.
 */
function unsavedItemsDiffer(prevIds: number[] | undefined, live: SessionSnapshot, prevTruncated = false): boolean {
  if (!prevIds || prevIds.length === 0 || prevTruncated || live.items_truncated) return false;
  const now = new Set(live.item_ids);
  const kept = prevIds.filter((id) => now.has(id)).length;
  return kept < Math.ceil(prevIds.length * 0.5);
}

function sameList(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

function diffComp(prev: SessionCompState | undefined, live: SessionCompState): CompChange {
  const base: CompChange = {
    id: live.id,
    name: live.name ?? prev?.name ?? null,
    status: "unchanged",
    layers: { before: prev?.num_layers ?? null, now: live.num_layers ?? null },
    stack_changed: false,
    selection_changed: false,
    selection_now: live.selected ?? [],
    work_area_changed: false,
    time_changed: false,
  };
  if (live.missing) {
    // Gone from the project; if the baseline never had it either, there is nothing to compare.
    return { ...base, status: prev && !prev.missing ? "removed" : "no_baseline" };
  }
  if (!prev || prev.missing) return { ...base, status: "no_baseline" };

  const countChanged = prev.num_layers !== live.num_layers;
  // A capped hash covers only the first layers; compare it only when both were capped alike.
  const hashComparable = !!prev.hash && !!live.hash && !!prev.hash_truncated === !!live.hash_truncated;
  base.stack_changed = countChanged || (hashComparable && prev.hash !== live.hash);
  base.selection_changed = !sameList(prev.selected ?? [], live.selected ?? []);
  base.work_area_changed = prev.work_area_start !== live.work_area_start || prev.work_area_duration !== live.work_area_duration;
  base.time_changed = prev.time !== live.time;
  base.status = base.stack_changed || base.selection_changed || base.work_area_changed ? "changed" : "unchanged";
  return base;
}

function describeComp(c: CompChange): string | null {
  const label = `comp ${c.id}${c.name ? ` "${c.name}"` : ""}`;
  if (c.status === "removed") return `${label} is gone`;
  if (c.status !== "changed") return null;
  const parts: string[] = [];
  if (c.layers.before !== c.layers.now && c.layers.before !== null && c.layers.now !== null) {
    parts.push(`layers ${c.layers.before} -> ${c.layers.now}`);
  } else if (c.stack_changed) {
    parts.push("layer stack edited");
  }
  if (c.selection_changed) parts.push("selection changed");
  if (c.work_area_changed) parts.push("work area changed");
  return `${label}: ${parts.join(", ")}`;
}

/**
 * What differs between the stored snapshot and the live state. A baseline
 * from another project yields only the swap: nothing else is comparable.
 */
export function diffSnapshots(prev: StoredSnapshot, live: SessionSnapshot, serviceId: string): SessionDiff {
  const bothUnsaved = prev.project_path === UNSAVED && live.project_path === UNSAVED;
  const swapped = !pathsMatchForGuard(prev.project_path, live.project_path) || (bothUnsaved && unsavedItemsDiffer(prev.item_ids, live, prev.items_truncated));
  const restarted = prev.service_id !== serviceId;
  const buildChanged = !!prev.build && !!live.build && prev.build !== live.build;
  const reopened = !swapped && prev.revision !== null && live.revision !== null && live.revision < prev.revision;

  const diff: SessionDiff = {
    changed: false,
    project_swapped: swapped,
    previous_path: prev.project_path,
    current_path: live.project_path,
    service_restarted: restarted,
    ae_build_changed: buildChanged,
    reopened_or_reverted_suspected: reopened,
    items: null,
    active_item: null,
    render_queue_changed: false,
    comps: [],
    hints: { dirty: null, revision_delta: null, time_changed_comps: [] },
    user_changed: null,
  };

  if (!swapped) {
    const exact = !prev.items_truncated && !live.items_truncated;
    const before = new Set(prev.item_ids);
    const now = new Set(live.item_ids);
    const added = exact ? live.item_ids.filter((id) => !before.has(id)) : [];
    const removed = exact ? prev.item_ids.filter((id) => !now.has(id)) : [];
    const countsDiffer = prev.num_items !== live.num_items;
    if (countsDiffer || added.length || removed.length) {
      diff.items = {
        exact,
        count_before: prev.num_items,
        count_now: live.num_items,
        added: added.slice(0, MAX_SHOWN_IDS),
        removed: removed.slice(0, MAX_SHOWN_IDS),
        added_count: added.length,
        removed_count: removed.length,
      };
    }
    if ((prev.active_item?.id ?? null) !== (live.active_item?.id ?? null)) {
      diff.active_item = { before: prev.active_item, now: live.active_item };
    }
    diff.render_queue_changed =
      !!prev.render_queue &&
      !!live.render_queue &&
      (prev.render_queue.num_items !== live.render_queue.num_items ||
        prev.render_queue.queued !== live.render_queue.queued ||
        prev.render_queue.rendering !== live.render_queue.rendering);
    const prevComps = new Map(prev.comps.map((c) => [c.id, c]));
    diff.comps = live.comps.map((c) => diffComp(prevComps.get(c.id), c));
    diff.hints.time_changed_comps = diff.comps.filter((c) => c.time_changed).map((c) => c.id);
    if (prev.dirty !== live.dirty) diff.hints.dirty = { before: prev.dirty, now: live.dirty };
    if (prev.revision !== null && live.revision !== null) diff.hints.revision_delta = live.revision - prev.revision;
  }

  diff.changed =
    swapped ||
    restarted ||
    buildChanged ||
    reopened ||
    !!diff.items ||
    !!diff.active_item ||
    diff.render_queue_changed ||
    diff.comps.some((c) => c.status === "changed" || c.status === "removed");

  const lines: string[] = [];
  if (swapped) lines.push(`another project is open now (was ${prev.project_path}, now ${live.project_path})`);
  if (restarted || buildChanged) lines.push("After Effects or the panel service restarted since the last write");
  if (reopened) lines.push("the project looks reopened or reverted (its revision went back)");
  if (diff.items) {
    const i = diff.items;
    lines.push(i.exact ? `project items +${i.added_count} -${i.removed_count}` : `project items ${i.count_before} -> ${i.count_now}`);
  }
  for (const c of diff.comps) {
    const d = describeComp(c);
    if (d) lines.push(d);
  }
  if (diff.active_item) {
    const n = diff.active_item.now;
    lines.push(n ? `active item is now ${n.kind} ${n.id} "${n.name}"` : "no item is active now");
  }
  if (diff.render_queue_changed) lines.push("render queue changed");
  diff.user_changed = lines.length ? `Since the last write: ${lines.join("; ")}.` : null;
  return diff;
}

// ---------- pure logic: undo reach ----------

export type UndoReach = "not_reachable" | "possibly_reachable";

/**
 * Whether Ctrl+Z can still reach a step. AE exposes no undo history, so this
 * can prove "no" (another project, a new AE build, a revision that went back) and
 * otherwise says only "possibly": the user's own undos, the Levels of Undo
 * limit and Edit > Purge are invisible to scripts.
 */
export function undoReach(
  step: UndoStep,
  live: SessionSnapshot,
  serviceId: string,
  opts: { reopenedAt?: string | null; undoPurge?: UndoPurge } = {}
): { reach: UndoReach; why: string } {
  // A project the server itself closed and reopened (checkpoint revert, open) lost its undo history, whatever path or ids it has now.
  const reopenedMs = opts.reopenedAt ? Date.parse(opts.reopenedAt) : NaN;
  const stepMs = Date.parse(step.at);
  if (Number.isFinite(reopenedMs) && Number.isFinite(stepMs) && stepMs < reopenedMs) {
    return {
      reach: "not_reachable",
      why: "the project was closed and reopened after this step (a checkpoint revert or open); After Effects clears the undo history when a project closes",
    };
  }
  const after = (at: string | null | undefined): boolean => {
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) && Number.isFinite(stepMs) && stepMs < ms;
  };
  if (after(opts.undoPurge?.purgedAt)) {
    return { reach: "not_reachable", why: "the undo history was purged after this step (ae_memory_purge target undo)" };
  }
  let prefix = "";
  // A ram or all purge may have cleared it too (not measured): say so, without claiming it is gone.
  if (after(opts.undoPurge?.maybePurgedAt)) prefix = "a cache purge after this step (ae_memory_purge ram or all) may have cleared the undo history; ";
  if (step.project_path === UNSAVED && live.project_path === UNSAVED && unsavedItemsDiffer(step.item_ids, live)) {
    return { reach: "not_reachable", why: "another unsaved project is open (its items hardly overlap the step's)" };
  }
  if (!pathsMatchForGuard(step.project_path, live.project_path)) {
    if (!looksLikeSaveAs(step, live)) {
      return { reach: "not_reachable", why: `another project is open (the step was made in ${step.project_path})` };
    }
    prefix += `the project path changed (${step.project_path} -> ${live.project_path}) but its items match, so this is probably a Save As and the undo history may have survived; `;
  }
  if (step.build && live.build && step.build !== live.build) {
    return { reach: "not_reachable", why: "the After Effects build changed, so it was restarted or updated; AE keeps no undo history across a restart" };
  }
  if (step.revision_after !== null && live.revision !== null && live.revision < step.revision_after) {
    return { reach: "not_reachable", why: "the project revision went back: it was reopened or reverted" };
  }
  if (step.service_id !== serviceId) {
    return {
      reach: "possibly_reachable",
      why: `${prefix}the panel service restarted since this step; if After Effects itself restarted the step is gone, but a service reload alone leaves AE's undo stack intact`,
    };
  }
  return {
    reach: "possibly_reachable",
    why: `${prefix}nothing proves it is gone, but the tool cannot see the undo stack (your own undos, the Levels of Undo limit and Edit > Purge are invisible)`,
  };
}

/** The same project under a new path: nearly all of the step's item ids are still there, at about the same count. */
function looksLikeSaveAs(step: UndoStep, live: SessionSnapshot): boolean {
  const ids = step.item_ids;
  if (!ids || ids.length === 0 || typeof step.num_items !== "number" || live.items_truncated) return false;
  const now = new Set(live.item_ids);
  const kept = ids.filter((id) => now.has(id)).length;
  const countClose = Math.abs(live.num_items - step.num_items) <= Math.max(1, Math.round(step.num_items * 0.1));
  return countClose && kept >= Math.ceil(ids.length * 0.9);
}

// ---------- persistence and the tracker ----------

interface StateFile {
  last_key: string | null;
  snapshots: Record<string, StoredSnapshot>;
  touched: Record<string, number[]>;
  steps: UndoStep[];
  op_projects: Record<string, string>;
  interrupted: InterruptedOp[];
  /** When a tool last closed and reopened a project: undo steps before it are gone. */
  reopened_at: string | null;
  /** The last ae_memory_purge that cleared the undo history (target undo). */
  undo_purged_at: string | null;
  /** The last one that may have cleared it (ram, all: not measured). */
  undo_maybe_purged_at: string | null;
  /** Every agent write per project, guarded or not; undo steps cover only guarded ones. */
  agent_writes: Record<string, AgentWrite[]>;
}

export interface AgentWrite {
  at: string;
  op_id: string;
  tool: string;
  /** False for a write the bridge hook saw (no receipt, no undo step). */
  guarded: boolean;
}

export interface UndoPurge {
  purgedAt?: string | null;
  maybePurgedAt?: string | null;
}

const emptyState = (): StateFile => ({
  last_key: null,
  snapshots: {},
  touched: {},
  steps: [],
  op_projects: {},
  interrupted: [],
  reopened_at: null,
  undo_purged_at: null,
  undo_maybe_purged_at: null,
  agent_writes: {},
});

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keeps what a saved state file holds only where its shape is right; anything else starts empty. Never throws. */
function sanitizeState(saved: unknown): StateFile {
  const out = emptyState();
  if (!isPlainObject(saved)) return out;
  if (isPlainObject(saved.snapshots)) {
    for (const [k, v] of Object.entries(saved.snapshots)) {
      if (isPlainObject(v) && typeof v.project_path === "string" && Array.isArray(v.item_ids) && Array.isArray(v.comps)) {
        out.snapshots[k] = v as unknown as StoredSnapshot;
      }
    }
  }
  if (typeof saved.last_key === "string" && out.snapshots[saved.last_key]) out.last_key = saved.last_key;
  if (isPlainObject(saved.touched)) {
    for (const [k, v] of Object.entries(saved.touched)) if (Array.isArray(v)) out.touched[k] = v.filter((x): x is number => typeof x === "number");
  }
  if (Array.isArray(saved.steps)) {
    out.steps = saved.steps.filter((x): x is UndoStep => isPlainObject(x) && typeof x.op_id === "string" && typeof x.at === "string");
  }
  if (isPlainObject(saved.op_projects)) {
    for (const [k, v] of Object.entries(saved.op_projects)) if (typeof v === "string") out.op_projects[k] = v;
  }
  if (Array.isArray(saved.interrupted)) {
    out.interrupted = saved.interrupted.filter((x): x is InterruptedOp => isPlainObject(x) && typeof x.op_id === "string" && typeof x.project_path === "string");
  }
  if (typeof saved.reopened_at === "string") out.reopened_at = saved.reopened_at;
  if (typeof saved.undo_purged_at === "string") out.undo_purged_at = saved.undo_purged_at;
  if (typeof saved.undo_maybe_purged_at === "string") out.undo_maybe_purged_at = saved.undo_maybe_purged_at;
  if (isPlainObject(saved.agent_writes)) {
    for (const [k, v] of Object.entries(saved.agent_writes)) {
      if (!Array.isArray(v)) continue;
      out.agent_writes[k] = v.filter((x): x is AgentWrite => isPlainObject(x) && typeof x.at === "string" && typeof x.op_id === "string" && typeof x.tool === "string");
    }
  }
  return out;
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // Bookkeeping only; a failed save must not touch a write.
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const keyOf = (projectPath: string) => (process.platform === "win32" ? projectPath.replace(/\\/g, "/").toLowerCase() : projectPath);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TrackerOptions {
  dataDir: string;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  /** Where the aerender job store keeps jobs.json. Default: the store's own default path. */
  rendersJobsFile?: string;
  /** Overrides the age after which a foreign in-flight record counts as dead. */
  maxInflightAgeMs?: number;
}

export class SessionTracker {
  /** Op ids whose write-ahead record this process holds right now (guarded writes and the bridge hook share it). */
  private readonly active = new Set<string>();
  /** What the user changed before an unguarded write; a guarded write reports it, so the baseline update cannot swallow it. */
  private pendingLines: string[] = [];
  private pendingDropped = 0;
  /** The pending lines each write's receipt carries; they leave pending only once the write is done (commitReported). */
  private readonly reported = new Map<string, { lines: string[]; dropped: number }>();
  /** Writes whose before-snapshot failed or timed out: AE is likely blocked, so their after-snapshot is skipped. */
  private readonly skipAfter = new Set<string>();
  readonly rendersJobsFile: string | null;
  private readonly maxInflightAgeMs: number;
  readonly serviceId = crypto.randomBytes(6).toString("hex");
  readonly statePath: string;
  readonly inflightPath: string;
  readonly dataDir: string;
  private state: StateFile;
  private readonly now: () => Date;
  private readonly alive: (pid: number) => boolean;
  private readonly pid: number;

  constructor(opts: TrackerOptions) {
    this.dataDir = opts.dataDir;
    this.statePath = path.join(opts.dataDir, "session-state.json");
    this.inflightPath = path.join(opts.dataDir, "inflight-ops.json");
    this.now = opts.now ?? (() => new Date());
    this.alive = opts.isPidAlive ?? pidAlive;
    this.pid = opts.pid ?? process.pid;
    this.rendersJobsFile = opts.rendersJobsFile ?? null;
    this.maxInflightAgeMs = opts.maxInflightAgeMs ?? MAX_INFLIGHT_AGE_MS;
    this.state = sanitizeState(readJson<unknown>(this.statePath));
  }

  get pendingUserChanged(): string | null {
    if (this.pendingLines.length === 0) return null;
    const note = this.pendingDropped > 0 ? ` (${this.pendingDropped} earlier change line(s) dropped)` : "";
    return this.pendingLines.join(" ") + note;
  }

  /** Null clears; a string replaces the lines with that one. */
  set pendingUserChanged(value: string | null) {
    this.pendingLines = value ? [value] : [];
    this.pendingDropped = 0;
  }

  /** Adds a line unless pending has it already; keeps the last MAX_PENDING_LINES. */
  addPending(line: string): void {
    if (this.pendingLines.some((l) => l.includes(line))) return;
    this.pendingLines.push(line);
    while (this.pendingLines.length > MAX_PENDING_LINES) {
      this.pendingLines.shift();
      this.pendingDropped++;
    }
  }

  /** The pending lines a receipt is about to carry; they stay pending until commitReported. */
  takePendingFor(opId: string): { lines: string[]; note: string } {
    const lines = [...this.pendingLines];
    const dropped = lines.length > 0 ? this.pendingDropped : 0;
    this.reported.set(opId, { lines, dropped });
    for (const old of [...this.reported.keys()].slice(0, Math.max(0, this.reported.size - 50))) this.reported.delete(old);
    return { lines, note: dropped > 0 ? ` (${dropped} earlier change line(s) dropped)` : "" };
  }

  /** The write's result is being returned: the pending lines it carried have been reported. */
  commitReported(opId: string): void {
    const rep = this.reported.get(opId);
    this.reported.delete(opId);
    if (!rep) return;
    const lines = rep.lines;
    this.pendingDropped = Math.max(0, this.pendingDropped - rep.dropped);
    this.pendingLines = this.pendingLines.filter((l) => !lines.includes(l));
    if (this.pendingLines.length === 0) this.pendingDropped = 0;
  }

  markSkipAfter(opId: string): void {
    this.skipAfter.add(opId);
    for (const old of [...this.skipAfter].slice(0, Math.max(0, this.skipAfter.size - 50))) this.skipAfter.delete(old);
  }

  takeSkipAfter(opId: string): boolean {
    return this.skipAfter.delete(opId);
  }

  /** A tool closed and reopened a project (checkpoint revert, open): earlier undo steps are gone. */
  markReopened(): void {
    this.state.reopened_at = this.now().toISOString();
    this.save();
  }

  reopenedAt(): string | null {
    return this.state.reopened_at;
  }

  /** ae_memory_purge cleared the undo history (certain: target undo) or may have (ram, all). */
  markUndoPurged(at: string, certain: boolean): void {
    if (certain) this.state.undo_purged_at = at;
    else this.state.undo_maybe_purged_at = at;
    this.save();
  }

  undoPurge(): UndoPurge {
    return { purgedAt: this.state.undo_purged_at, maybePurgedAt: this.state.undo_maybe_purged_at };
  }

  /** Logs an agent write to a project: guarded writes from noteAfterWrite, the rest from the bridge hook. */
  noteAgentWrite(projectPath: string, w: { op_id: string; tool: string; guarded: boolean }): void {
    const key = keyOf(projectPath);
    const list = this.state.agent_writes[key] ?? [];
    list.push({ at: this.now().toISOString(), ...w });
    delete this.state.agent_writes[key]; // re-insert last: keeps insertion order as recency
    this.state.agent_writes[key] = list.slice(-MAX_AGENT_WRITES);
    const keys = Object.keys(this.state.agent_writes);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SNAPSHOTS))) delete this.state.agent_writes[old];
    this.save();
  }

  /**
   * The agent's writes to a project after `since` (an ISO time; all kept ones
   * when null), oldest first. Unlike steps() it includes writes that are not
   * undo steps (imports, effects, text, keyframe ease, ...).
   */
  agentWritesSince(projectPath: string, since: string | null): AgentWrite[] {
    const list = this.state.agent_writes[keyOf(projectPath)] ?? [];
    const ms = since ? Date.parse(since) : NaN;
    return Number.isFinite(ms) ? list.filter((w) => Date.parse(w.at) > ms) : list.slice();
  }

  private save(): void {
    writeJson(this.statePath, this.state);
  }

  baselineFor(projectPath: string): StoredSnapshot | null {
    return this.state.snapshots[keyOf(projectPath)] ?? null;
  }

  lastBaseline(): StoredSnapshot | null {
    return this.state.last_key ? this.state.snapshots[this.state.last_key] ?? null : null;
  }

  /** Comps worth reading again for a project: the ones writes touched. */
  touchedComps(projectPath: string): number[] {
    return this.state.touched[keyOf(projectPath)] ?? [];
  }

  /** Comp ids for a snapshot: the given ones plus those already tracked for the project. */
  compsToRead(projectPath: string | null, extra: Array<number | undefined | null>): number[] {
    return this.compsToReadDetailed(projectPath, extra).ids;
  }

  /** As compsToRead, and how many ids the cap dropped (the given ones come first, so they are the last to go). */
  compsToReadDetailed(projectPath: string | null, extra: Array<number | undefined | null>): { ids: number[]; dropped: number } {
    const ids = new Set<number>();
    for (const id of extra) if (typeof id === "number") ids.add(id);
    const known = projectPath ? this.touchedComps(projectPath) : (this.lastBaseline()?.comps ?? []).map((c) => c.id);
    for (const id of known) ids.add(id);
    const all = [...ids];
    return { ids: all.slice(0, MAX_TOUCHED), dropped: Math.max(0, all.length - MAX_TOUCHED) };
  }

  /** Whether the path is the project the last write (or rebase) was in. True when there is no baseline yet. */
  isLastProject(projectPath: string): boolean {
    return this.state.last_key === null || this.state.last_key === keyOf(projectPath);
  }

  /** Whether this process holds a write-ahead record for the op. */
  isInflight(opId: string): boolean {
    return this.active.has(opId);
  }

  /** Stores a snapshot as the new baseline for its project. */
  record(snap: SessionSnapshot, meta: { op_id: string | null; tool: string }): StoredSnapshot {
    const stored: StoredSnapshot = { ...snap, taken_at: this.now().toISOString(), op_id: meta.op_id, tool: meta.tool, service_id: this.serviceId };
    const key = keyOf(snap.project_path);
    delete this.state.snapshots[key]; // re-insert last: keeps insertion order as recency
    this.state.snapshots[key] = stored;
    this.state.last_key = key;
    const keys = Object.keys(this.state.snapshots);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SNAPSHOTS))) {
      delete this.state.snapshots[old];
      delete this.state.touched[old];
    }
    const touched = new Set(this.state.touched[key] ?? []);
    for (const c of snap.comps) if (!c.missing) touched.add(c.id);
    this.state.touched[key] = [...touched].slice(-MAX_TOUCHED);
    this.save();
    return stored;
  }

  addStep(step: UndoStep): void {
    this.state.steps.push(step);
    if (this.state.steps.length > MAX_STEPS) this.state.steps.splice(0, this.state.steps.length - MAX_STEPS);
    this.save();
  }

  steps(): UndoStep[] {
    return this.state.steps;
  }

  interrupted(): InterruptedOp[] {
    return this.state.interrupted;
  }

  projectOfOp(opId: string): string | null {
    return this.state.op_projects[opId] ?? null;
  }

  // ----- write-ahead record -----

  private readInflight(): InflightOp[] {
    const raw = readJson<{ ops?: InflightOp[] }>(this.inflightPath);
    return raw && Array.isArray(raw.ops) ? raw.ops.filter((o) => o && typeof o.op_id === "string") : [];
  }

  /** Written before a write's evalScript. Also remembers which project the op was for. */
  begin(op: Omit<InflightOp, "pid" | "service_id" | "started_at">): void {
    const record: InflightOp = { ...op, pid: this.pid, service_id: this.serviceId, started_at: this.now().toISOString() };
    writeJson(this.inflightPath, { ops: [...this.readInflight().filter((o) => o.op_id !== op.op_id), record] });
    this.active.add(op.op_id);
    // An op that started before any project was known has no project to compare against later.
    if (op.project_path !== UNKNOWN_PROJECT) this.state.op_projects[op.op_id] = op.project_path;
    const ids = Object.keys(this.state.op_projects);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_OP_PROJECTS))) delete this.state.op_projects[old];
    this.save();
  }

  /** Removed once the evalScript has returned (or failed with a known outcome). */
  end(opId: string): void {
    this.active.delete(opId);
    const rest = this.readInflight().filter((o) => o.op_id !== opId);
    if (rest.length) writeJson(this.inflightPath, { ops: rest });
    else {
      try {
        fs.rmSync(this.inflightPath, { force: true });
      } catch {
        // see writeJson
      }
    }
  }

  /**
   * At start: a record left by a service that is gone is a write whose
   * outcome is unknown. It goes into quarantine (so ae_acknowledge handles
   * it and nothing is retried) and into the interrupted list. A record from
   * another live process (a second server sharing the data dir) is left alone.
   */
  recoverInterrupted(quarantine: QuarantineStore | undefined): InterruptedOp[] {
    const found: InterruptedOp[] = [];
    const keep: InflightOp[] = [];
    const nowMs = this.now().getTime();
    for (const op of this.readInflight()) {
      // Windows reuses pids: an old record whose pid something else now holds is still dead.
      // A live write cannot outlast the largest eval timeout, so age settles it.
      const startedMs = Date.parse(op.started_at);
      const tooOld = Number.isFinite(startedMs) && nowMs - startedMs > this.maxInflightAgeMs;
      const foreignAlive = op.pid !== this.pid && !tooOld && this.alive(op.pid);
      const ownCurrent = op.pid === this.pid && op.service_id === this.serviceId;
      if (foreignAlive || ownCurrent) {
        keep.push(op);
        continue;
      }
      const where = op.project_path === UNKNOWN_PROJECT ? "" : ` (project ${op.project_path})`;
      const reason =
        `After Effects or its panel service went down while this write was in flight${where}; ` +
        `whether it was applied is unknown. Do not retry it: inspect the project (ae_comp_diff against the last checkpoint, ae_checkpoint_list), then ae_acknowledge.`;
      let quarantined = false;
      if (quarantine) {
        try {
          if (!quarantine.get(op.op_id)) quarantine.add({ op_id: op.op_id, tool: op.tool, label: op.label, reason });
          quarantined = true;
        } catch {
          // The interrupted list below still reports it.
        }
      }
      found.push({ ...op, recovered_at: this.now().toISOString(), reason, quarantined });
    }
    if (found.length || keep.length !== this.readInflight().length) {
      if (keep.length) writeJson(this.inflightPath, { ops: keep });
      else {
        try {
          fs.rmSync(this.inflightPath, { force: true });
        } catch {
          // see writeJson
        }
      }
    }
    if (found.length) {
      this.state.interrupted = [...this.state.interrupted, ...found].slice(-MAX_INTERRUPTED);
      this.save();
    }
    return found;
  }

  /** The last baseline hash for a comp, to compare an interrupted op's comp against. */
  lastKnownHash(projectPath: string, compId: number | null | undefined): string | null {
    if (typeof compId !== "number") return null;
    return this.baselineFor(projectPath)?.comps.find((c) => c.id === compId)?.hash ?? null;
  }
}

// ---------- the process-wide tracker and the write hooks ----------

let tracker: SessionTracker | null = null;

/** Turns tracking on. Run once at startup; recovers writes a restart interrupted. */
export function installSessionTracking(opts: { dataDir: string; quarantine?: QuarantineStore } & Partial<TrackerOptions>): SessionTracker {
  const t = new SessionTracker({
    dataDir: opts.dataDir,
    now: opts.now,
    isPidAlive: opts.isPidAlive,
    pid: opts.pid,
    rendersJobsFile: opts.rendersJobsFile,
    maxInflightAgeMs: opts.maxInflightAgeMs,
  });
  tracker = t;
  try {
    t.recoverInterrupted(opts.quarantine);
  } catch {
    // Recovery is bookkeeping; the tracker works without it.
  }
  return t;
}

export function getSessionTracker(): SessionTracker | null {
  return tracker;
}

/** For tests. */
export function resetSessionTracking(): void {
  tracker = null;
}

type EvalRaw = HostTransport["evalRaw"];

async function readSnapshot(
  ctx: { bridge: { evalRaw: EvalRaw } },
  opId: string,
  phase: string,
  toolName: string,
  compIds: number[]
): Promise<SessionSnapshot | null> {
  const res = await ctx.bridge.evalRaw<SessionSnapshot>({
    id: `${opId}_${phase}`,
    script: buildJsxCall("sessionSnapshot", { comp_ids: compIds }),
    label: `${toolName} (session ${phase})`,
    mutates: false,
    toolName,
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  const snap = res.result;
  return snap && typeof snap === "object" && typeof (snap as SessionSnapshot).project_path === "string" ? snap : null;
}

export interface WriteInfo {
  opId: string;
  toolName: string;
  label: string;
  expect: ExpectGuard;
  checkpoint?: string | null;
}

/**
 * Before a write, inside the queue lease: what the user changed since the
 * last write, as the fields to add to the result. Never throws.
 */
export async function noteBeforeWrite(ctx: ToolContext, info: WriteInfo): Promise<{ user_changed?: string }> {
  if (!tracker) return {};
  const t = tracker;
  try {
    // Changes found before an unguarded write (see installSessionBridgeHook) ride on this receipt.
    // They stay pending until noteAfterWrite: if the write is refused or throws, the next receipt still has them.
    const taken = t.takePendingFor(info.opId);
    const lines = [...taken.lines];
    let found: string | null = null;
    const prev = t.baselineFor(info.expect.project_path) ?? t.lastBaseline();
    if (prev) {
      try {
        const live = await readSnapshot(ctx, info.opId, "before", info.toolName, t.compsToRead(info.expect.project_path, [info.expect.comp_id]));
        if (live) found = diffSnapshots(prev, live, t.serviceId).user_changed;
      } catch {
        // AE is likely blocked: the write goes on, and its after-snapshot is skipped.
        t.markSkipAfter(info.opId);
      }
    }
    if (found && !lines.some((l) => l.includes(found!))) lines.push(found);
    return lines.length ? { user_changed: lines.join(" ") + taken.note } : {};
  } catch {
    return {};
  }
}

/** Written before the write's evalScript; see SessionTracker.begin. Never throws. */
export function beginInflight(info: WriteInfo): void {
  if (!tracker) return;
  try {
    tracker.begin({
      op_id: info.opId,
      tool: info.toolName,
      label: info.label,
      project_path: info.expect.project_path,
      comp_id: info.expect.comp_id ?? null,
      last_known_hash: tracker.lastKnownHash(info.expect.project_path, info.expect.comp_id),
    });
  } catch {
    // see above
  }
}

/** Removes the write-ahead record once the evalScript has returned. Never throws. */
export function endInflight(opId: string): void {
  if (!tracker) return;
  try {
    tracker.end(opId);
  } catch {
    // see above
  }
}

/**
 * After an applied write (and its read-back), inside the queue lease: the
 * new baseline and the undo step (none when `addStep` is false: the write
 * changed nothing, so it opened no undo group). Never throws.
 */
export async function noteAfterWrite(ctx: ToolContext, info: WriteInfo, opts: { skipRead?: boolean; addStep?: boolean } = {}): Promise<void> {
  if (!tracker) return;
  const t = tracker;
  try {
    // The receipt is about to be returned, so the pending lines it carried have been reported.
    t.commitReported(info.opId);
  } catch {
    // see above
  }
  if (opts.addStep !== false) {
    try {
      t.noteAgentWrite(info.expect.project_path, { op_id: info.opId, tool: info.toolName, guarded: true });
    } catch {
      // see above
    }
  }
  try {
    // A failed read-back or a before-snapshot that failed means AE is likely stuck: no more reads behind it.
    const blocked = t.takeSkipAfter(info.opId);
    if (opts.skipRead || blocked) return;
    const compIds = t.compsToRead(info.expect.project_path, [info.expect.comp_id]);
    const snap = await readSnapshot(ctx, info.opId, "after", info.toolName, compIds);
    if (!snap) return;
    t.record(snap, { op_id: info.opId, tool: info.toolName });
    if (opts.addStep === false) return;
    t.addStep({
      op_id: info.opId,
      tool: info.toolName,
      label: info.label,
      at: new Date().toISOString(),
      project_path: snap.project_path,
      service_id: t.serviceId,
      revision_after: snap.revision,
      checkpoint: info.checkpoint ?? null,
      build: snap.build,
      item_ids: snap.item_ids.slice(0, MAX_STEP_ITEM_IDS),
      num_items: snap.num_items,
    });
  } catch {
    // see above
  }
}

/**
 * Reads the open project. The first read asks for the comps of the last
 * write's project; when another project is open and has touched comps of its
 * own, a second read asks for those, so they are compared too.
 */
async function readOpenProject(
  t: SessionTracker,
  read: (compIds: number[]) => Promise<SessionSnapshot | null>,
  extra: number[]
): Promise<{ snap: SessionSnapshot; dropped: number } | null> {
  const first = t.compsToReadDetailed(null, extra);
  const snap = await read(first.ids);
  if (!snap) return null;
  if (!t.isLastProject(snap.project_path) && t.touchedComps(snap.project_path).length > 0) {
    const second = t.compsToReadDetailed(snap.project_path, extra);
    const again = await read(second.ids);
    if (again) return { snap: again, dropped: second.dropped };
  }
  return { snap, dropped: first.dropped };
}

function markReopenedSafely(t: SessionTracker): void {
  try {
    t.markReopened();
  } catch {
    // Bookkeeping only.
  }
}

/**
 * Covers every mutating eval that is not a guarded write. Many tools call
 * evalRaw or callHost with mutates:true directly (imports, effects, text,
 * keyframe ease, footage, save, checkpoint revert, render queue, ...). Without
 * this the baseline would still show the state before such a write, and the
 * next comparison would report the agent's own change as the user's. For each
 * one the hook (a) compares the live state with the baseline first and keeps
 * what it finds for the next guarded write's user_changed, (b) writes the
 * write-ahead record, so a crash during it is recovered, and (c) takes a new
 * baseline afterwards. Guarded writes (runGuardedWrite, ae_run_jsx,
 * ae_set_property) already did their own and are skipped, because their
 * record exists before their evalRaw.
 *
 * The lead calls this once at startup with the bridge, after
 * installSessionTracking. It wraps bridge.evalRaw on the instance, so the
 * bridge's own callHost goes through it. Returns a function that undoes it.
 * Unguarded writes add no undo step: the tool cannot tell which are undoable.
 */
export function installSessionBridgeHook(bridge: HostTransport): () => void {
  const target = bridge as unknown as { evalRaw: EvalRaw };
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "evalRaw");
  const ownOriginal = target.evalRaw;
  const original: EvalRaw = target.evalRaw.bind(bridge);
  const hooked = (async (p: Parameters<EvalRaw>[0]) => {
    const t = tracker;
    if (!t || p.mutates !== true) return original(p);
    const opensProject = typeof p.script === "string" && p.script.includes("openProject(");
    if (t.isInflight(p.id)) {
      // A guarded write already did its own bookkeeping; only the reopen marker is the hook's.
      try {
        return await original(p);
      } finally {
        // A thrown or timed-out open may already have closed the project: it counts as a reopen too.
        if (opensProject) markReopenedSafely(t);
      }
    }
    const toolName = p.toolName ?? "unknown";
    const raw = { bridge: { evalRaw: original } };
    const read = (phase: string) => (ids: number[]) => readSnapshot(raw, p.id, phase, toolName, ids);
    let projectPath = UNKNOWN_PROJECT;
    let skipAfter = false;
    try {
      const prev = t.lastBaseline();
      if (prev) {
        projectPath = prev.project_path;
        try {
          const live = await readOpenProject(t, read("before"), []);
          if (live) {
            projectPath = live.snap.project_path;
            const base = t.baselineFor(live.snap.project_path) ?? prev;
            const line = diffSnapshots(base, live.snap, t.serviceId).user_changed;
            if (line) t.addPending(line);
          } else {
            skipAfter = true;
          }
        } catch {
          // AE is likely blocked (timeout or unreachable): send the write, but do not queue an after-snapshot behind it.
          skipAfter = true;
        }
      }
      t.begin({ op_id: p.id, tool: toolName, label: p.label, project_path: projectPath, comp_id: null, last_known_hash: null });
    } catch {
      // Bookkeeping must not stop the write.
    }
    let res;
    try {
      res = await original(p);
    } finally {
      try {
        t.end(p.id);
      } catch {
        // see above
      }
      if (opensProject) markReopenedSafely(t);
    }
    let writtenTo = projectPath;
    if (!skipAfter) {
      try {
        const after = await readOpenProject(t, read("after"), []);
        if (after) {
          t.record(after.snap, { op_id: p.id, tool: toolName });
          writtenTo = after.snap.project_path;
        }
      } catch {
        // see above
      }
    }
    try {
      // A write that threw may still have changed something; only a returned one is logged, like a guarded write.
      if (writtenTo !== UNKNOWN_PROJECT) t.noteAgentWrite(writtenTo, { op_id: p.id, tool: toolName, guarded: false });
    } catch {
      // see above
    }
    return res;
  }) as EvalRaw;
  target.evalRaw = hooked;
  return () => {
    if (target.evalRaw !== hooked) return;
    if (hadOwn) target.evalRaw = ownOriginal;
    else delete (target as { evalRaw?: EvalRaw }).evalRaw;
  };
}

// ---------- the tool ----------

export const AeSessionChangesSchema = z.object({
  comp_ids: z
    .array(z.number().int())
    .max(MAX_TOUCHED)
    .optional()
    .describe(
      `Extra comps to compare besides the ones the agent's writes touched and the active comp. Optional, at most ${MAX_TOUCHED}; ` +
        "when more comps are tracked than fit, the output says how many were not read (comps_not_read)."
    ),
  include_undo_steps: z.boolean().optional().describe("List the agent's recent undo steps and whether Ctrl+Z can still reach them. Default true."),
  max_undo_steps: z.number().int().min(1).max(50).optional().describe("How many recent steps to list. Default 10."),
  rebase: z
    .boolean()
    .optional()
    .describe(
      "After reporting, take the live state as the new baseline, so the next call (and the next write receipt) shows only newer changes. " +
        "Changes nothing in After Effects; it only moves this server's baseline. Default false."
    ),
});

type SessionArgs = z.infer<typeof AeSessionChangesSchema>;

interface QuarantineView {
  op_id: string;
  tool: string;
  label: string;
  quarantined_at: string;
  reason: string;
  project_path: string | null;
  /** The op belongs to a project that is not the one open now. */
  stale: boolean;
}

interface RenderJobView {
  job_id: string;
  state: string;
  project_path: string;
  comp_name: string;
  pid: number | null;
  pid_alive: boolean | null;
  /** Recorded as running, but its process is gone: it did not finish. */
  orphaned: boolean;
}

function readRenderJobs(jobsFile: string, alive: (pid: number) => boolean): RenderJobView[] {
  const raw = readJson<{ jobs?: Array<Record<string, unknown>> }>(jobsFile);
  if (!raw || !Array.isArray(raw.jobs)) return [];
  const out: RenderJobView[] = [];
  for (const j of raw.jobs) {
    if (j.state !== "running") continue;
    const pid = typeof j.pid === "number" && j.pid > 0 ? j.pid : null;
    const pidIsAlive = pid === null ? null : alive(pid);
    out.push({
      job_id: String(j.job_id),
      state: "running",
      project_path: String(j.project_path ?? ""),
      comp_name: String(j.comp_name ?? ""),
      pid,
      pid_alive: pidIsAlive,
      orphaned: pidIsAlive === false,
    });
  }
  return out.slice(0, 500);
}

const REVISION_NOTE =
  "Project.revision is documented but its triggers (script writes, selection, time scrubs) and its reset on reopen are unmeasured; it is reported as a hint, never as proof.";

export const sessionTools: ToolDefinition<any>[] = [
  {
    name: "ae_session_changes",
    description:
      "What changed in After Effects since the agent's last write, and what a restart left unfinished. " +
      "Compares the live project against the snapshot kept after each of the agent's writes: another project open, items added or removed, " +
      "the active item, and for each touched comp the layer count, a hash of the layer stack, the selection and the work area. " +
      "Also lists writes that were in flight when AE or the panel service went down (their outcome is unknown: quarantined, never retried; " +
      "each shows whether its comp's layer stack differs from the last snapshot; inspect, then ae_acknowledge; acknowledged ones move to acknowledged_interrupted_ops), " +
      "quarantined ops that belong to a project that is not open, 'running' aerender jobs whose process is gone, " +
      "and the agent's recent undo steps with whether Ctrl+Z can still reach them. " +
      "Guarded writes carry the same comparison as a short user_changed line on their receipt. " +
      "Read-only: nothing in After Effects is changed (not time, selection or the active item). " +
      "Honest limits: AE has no API that reads the undo stack, so a step is 'not_reachable' only when provably gone (another project, a new AE build, a revision that went back) and otherwise 'possibly_reachable'; " +
      "a revert to an identical saved state looks like no change. " +
      "Writes by tools that do not go through the guarded write path are only covered when the server installed the session bridge hook (installSessionBridgeHook); " +
      "without it, user_changed may include changes made by the agent's own non-guarded tools (imports, effects, text, footage, save, render queue). " +
      "Prefer the checkpoint (ae_checkpoint_list, ae_checkpoint_revert) over telling the user to press Ctrl+Z. " +
      "Before the first write after a start there is no baseline; pass rebase:true to start one.",
    schema: AeSessionChangesSchema,
    handler: async (args: SessionArgs, ctx) => {
      const t = tracker;
      if (!t) {
        // Tracking was not installed (stdio server, or sessionTracking:false): do not turn it on from a read.
        const res = await ctx.bridge.callHost<SessionSnapshot>(
          "sessionSnapshot",
          { comp_ids: args.comp_ids ?? [] },
          { label: "ae_session_changes", mutates: false, toolName: "ae_session_changes" }
        );
        const snapNow = res.result;
        return {
          tracking_enabled: false,
          live: snapNow
            ? {
                project_path: snapNow.project_path,
                dirty: snapNow.dirty,
                revision: snapNow.revision,
                num_items: snapNow.num_items,
                active_item: snapNow.active_item,
                ae_version: snapNow.ae_version,
                build: snapNow.build,
                render_queue: snapNow.render_queue,
                comps: snapNow.comps,
              }
            : null,
          baseline: null,
          changes: null,
          undo_steps: [],
          interrupted_ops: [],
          quarantine: ctx.quarantine.list(),
          notes: [
            "Session tracking is off in this server (no baseline, no undo steps, no write-ahead records), so nothing is compared. The live state above is all this tool can give.",
          ],
        };
      }
      const last = t.lastBaseline();
      const extra = args.comp_ids ?? [];
      const readIds = async (ids: number[]) => {
        const res = await ctx.bridge.callHost<SessionSnapshot>(
          "sessionSnapshot",
          { comp_ids: ids },
          { label: "ae_session_changes", mutates: false, toolName: "ae_session_changes" }
        );
        return res.result;
      };
      // The first read asks for the last write's project; if another project is open, a second asks for its own touched comps.
      const opened = await readOpenProject(t, readIds, extra);
      if (!opened) throw new Error("sessionSnapshot returned no project state");
      let live = opened.snap;
      let dropped = opened.dropped;

      // Interrupted writes in the open project: read their comps too, to compare against the hash recorded at the time.
      const wantedCompIds = t
        .interrupted()
        .filter((o) => typeof o.comp_id === "number" && pathsMatchForGuard(o.project_path, live.project_path))
        .map((o) => o.comp_id as number);
      const haveIds = new Set(live.comps.map((c) => c.id));
      const missingIds = wantedCompIds.filter((id) => !haveIds.has(id));
      if (missingIds.length > 0) {
        const ids = [...new Set([...live.comps.map((c) => c.id), ...missingIds])];
        const again = await readSnapshotOrNull(readIds, ids);
        if (again) live = again;
      }

      const prev = t.baselineFor(live.project_path) ?? last;
      const diff = prev ? diffSnapshots(prev, live, t.serviceId) : null;
      const projectSwitched = !!last && !pathsMatchForGuard(last.project_path, live.project_path);

      const quarantine: QuarantineView[] = ctx.quarantine.list().map((e) => {
        const project = t.projectOfOp(e.op_id);
        return { ...e, project_path: project, stale: project !== null && project !== UNKNOWN_PROJECT && !pathsMatchForGuard(project, live.project_path) };
      });

      const interrupted = t.interrupted().map((o) => {
        const acknowledged = o.quarantined !== false && !ctx.quarantine.get(o.op_id);
        const inOpen = pathsMatchForGuard(o.project_path, live.project_path);
        const c = inOpen && typeof o.comp_id === "number" ? live.comps.find((x) => x.id === o.comp_id) : undefined;
        const hashNow = c && !c.missing && c.hash && !c.hash_truncated ? c.hash : null;
        return {
          ...o,
          acknowledged,
          in_open_project: inOpen,
          hash_now: hashNow,
          comp_found: c ? !c.missing : null,
          stack_changed_since_record: o.last_known_hash && hashNow ? o.last_known_hash !== hashNow : null,
        };
      });
      const interruptedOps = interrupted.filter((o) => !o.acknowledged);
      const acknowledgedOps = interrupted.filter((o) => o.acknowledged);

      const steps =
        args.include_undo_steps === false
          ? undefined
          : t
              .steps()
              .slice(-(args.max_undo_steps ?? 10))
              .reverse()
              .map(({ item_ids, ...s }) => ({ ...s, ...undoReach({ ...s, item_ids }, live, t.serviceId, { reopenedAt: t.reopenedAt(), undoPurge: t.undoPurge() }) }));

      let jobsFile = t.rendersJobsFile;
      if (!jobsFile) {
        // Loaded here, not at the top: aerender.ts imports mutate.ts, which imports this module.
        const { defaultAerenderJobsFilePath } = await import("./aerender.js");
        jobsFile = defaultAerenderJobsFilePath();
      }
      const jobs = readRenderJobs(jobsFile, pidAlive);
      const notes = [REVISION_NOTE];
      if (!prev) notes.push("No write has been recorded yet, so there is nothing to compare. Pass rebase:true to take a baseline now.");
      if (projectSwitched) {
        notes.push(
          `The open project (${live.project_path}) is not the one the last write was in (${last!.project_path}); the comparison uses the open project's own baseline` +
            (t.baselineFor(live.project_path) ? "." : ", and it has none, so nothing is compared.")
        );
      }
      if (dropped > 0) notes.push(`${dropped} tracked comp(s) were not read because at most ${MAX_TOUCHED} are read at once (comps_not_read).`);
      if (quarantine.some((q) => q.stale)) notes.push("A quarantined op belongs to a project that is not open; it still blocks writes until ae_acknowledge.");
      if (interruptedOps.length > 0) {
        notes.push("A write was interrupted and its outcome is unknown: do not retry it. Inspect the project, then ae_acknowledge its op_id.");
      }

      const pendingUserChanged = t.pendingUserChanged;
      if (args.rebase) {
        t.record(live, { op_id: null, tool: "ae_session_changes (rebase)" });
        t.pendingUserChanged = null;
      }

      return {
        tracking_enabled: true,
        live: {
          project_path: live.project_path,
          dirty: live.dirty,
          revision: live.revision,
          num_items: live.num_items,
          active_item: live.active_item,
          ae_version: live.ae_version,
          build: live.build,
          render_queue: live.render_queue,
          comps: live.comps,
        },
        baseline: prev ? { taken_at: prev.taken_at, op_id: prev.op_id, tool: prev.tool, project_path: prev.project_path } : null,
        last_write_project: last ? last.project_path : null,
        project_switched_since_last_write: projectSwitched,
        comps_not_read: dropped,
        changes: diff,
        pending_user_changes: pendingUserChanged,
        interrupted_ops: interruptedOps,
        acknowledged_interrupted_ops: acknowledgedOps,
        quarantine,
        render_jobs_running: jobs,
        undo_steps: steps,
        rebased: args.rebase === true,
        notes,
      };
    },
  },
];

async function readSnapshotOrNull(read: (ids: number[]) => Promise<SessionSnapshot | null>, ids: number[]): Promise<SessionSnapshot | null> {
  try {
    return await read(ids);
  } catch {
    return null;
  }
}
