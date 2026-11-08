/**
 * server/src/tools/ext/rqrender.ts
 *
 * Starts After Effects' own render of the queued Render Queue items, the same
 * as pressing Render, for the cases aerender cannot do (it fails to start on
 * some machines, or the project is unsaved):
 * - ae_render_queue_render: checks the queue in one read, then starts the
 *   render in the background and returns a job id AT ONCE.
 * - ae_render_queue_render_status: Node only (no evalScript): state, elapsed,
 *   the output files on disk, any blocking dialog.
 *
 * How it works. RenderQueue.render() only returns when the render ends, so the
 * host function rqeditRender is one very long evalScript. A background
 * promise sends it with a long timeout and holds the single-writer queue lease
 * for the whole render. The evalScript is never aborted. While it runs
 * After Effects cannot answer anything else, so render-gate.ts refuses every
 * other eval at once (a BridgeError, nothing sent, no quarantine). When the
 * eval returns, a SEPARATE evalScript reads each item's status and elapsed
 * time, Node checks each output file, and the job record keeps the result.
 * If the timeout is reached first the outcome is unknown: the job says so,
 * nothing is resent and the gate stays shut until the panel service has
 * nothing in flight again.
 *
 * item_indexes: render() renders every QUEUED item, so the other QUEUED items are unchecked first (host rqeditHold, one undo
 * group, confirmed by a separate read; the list is saved in the job record before the write) and checked again after the
 * render, also a failed one (rqeditRelease, a separate evalScript, only items still UNQUEUED with the same index, comp and
 * files). When the outcome is unknown the record keeps restore.state "pending" and the status says how to finish it.
 *
 * Jobs are kept in <data dir>/renders/rq-render-jobs.json. A job still
 * "running" in that file when a service starts was cut off by a restart: it is
 * reported as "lost" (After Effects may still be rendering: look at it).
 *
 * Only the panel service runs it (ctx.serviceInfo is set there): the dev stdio
 * path reaches the panel with fetch, whose 300 s headers timeout would read a
 * long render as "unreachable" and open the gate mid-render.
 *
 * Not measured in real After Effects: whether its UI stays clickable during a
 * script-started render (Stop button), whether an existing output file makes
 * AE prompt with overwrite: true, what render() does on an unsaved project,
 * whether "Save in subfolder" makes its folder at render time.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError, type QueueLease } from "../../queue.js";
import { renderGate, renderGateMessage } from "../../render-gate.js";
import { resourceWarningsForRender } from "../../system-resources.js";
import { AGENT_SAFETY_GUIDANCE, dataDirOf, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { getDefaultAerenderRegistry, type AerenderJobRegistry } from "./aerender.js";
import { listBlockingDialogs } from "./dialogs.js";
import { BatchStore, outputsOf } from "./renderbatch.js";
import { pathKey, type ItemRead, type QueueRead } from "./rqedit.js";
import { blockCode, dirsOfFiles, runSequenceCheck, sequenceBlockMessage, SequenceCheckSchema } from "./seqcheck.js";
import { noteUiWrite } from "./session.js";
import { clampWaitSeconds, waitForChange } from "../../wait-for-change.js";

// ---------- constants ----------

const MAX_JOBS_KEPT = 30;
const MAX_OUTPUT_FILES_STAT = 20_000;
/** The most queued items one call renders (render() renders all of them, so more is refused). */
const MAX_ITEMS = 100;
/** How long the read-back is repeated while After Effects still says it renders. */
const STILL_RENDERING_MAX_MS = 30 * 60_000;
const STILL_RENDERING_POLL_MS = 5_000;
/** setTimeout's limit; 48 h is far below it. */
const MAX_TIMEOUT_MS = 2_147_000_000;
const READ_BACK_TIMEOUT_MS = 120_000;
const MAX_TEXT = 2000;
export const RQ_RENDER_JOBS_FILE = "rq-render-jobs.json";
const STOP_TEXT =
  "Measured live (AE 26.3, 2026-11-07, over Remote Desktop): a render started by script LOCKS After Effects' UI for its whole length, so the user could NOT reach the Stop button; ending After Effects was the only way out. " +
  "A script can stop a render only from an onStatusChanged or app.onError callback set up before render() starts (RenderQueue.stopRendering, AE Scripting Guide); this tool sets none up, so it cannot stop the render, and render() does not return until the render is over. " +
  "So keep these renders short, save a dirty project first, and prefer ae_aerender_start for long renders (or, if the user agrees, engine \"media_encoder\"). A long 1080p H.264 output grew After Effects past 79 GB of RAM without writing a frame; ProRes of the same comp rendered fine.";

// ---------- job record ----------

/** queued_in_media_encoder: the items wait in AME's queue (start_now false) until the user presses Start there. handed_to_media_encoder: AME was told to start (start_now true). After Effects gets no progress from either. */
export type RenderJobState = "running" | "finished" | "failed" | "unknown" | "lost" | "queued_in_media_encoder" | "handed_to_media_encoder";

export type RenderEngine = "after_effects" | "media_encoder";

export interface JobOutput {
  item_index: number;
  comp_id: number;
  module: number;
  file: string;
  sequence: boolean;
}

export interface JobItem {
  index: number;
  comp_id: number;
  comp_name?: string;
  outputs: JobOutput[];
}

export interface JobItemResult {
  index: number;
  comp_id: number | null;
  comp_name?: string;
  status: string | null;
  elapsed_seconds?: number;
  comp_matches?: boolean;
  error?: string;
}

export interface OutputStat {
  item_index: number;
  module: number;
  file: string;
  sequence: boolean;
  folder_exists: boolean;
  exists: boolean;
  bytes: number;
  mtime: string | null;
  frame_count?: number;
  truncated?: boolean;
}

export interface RenderJobResult {
  item_statuses: JobItemResult[];
  outputs: OutputStat[];
  /** The read-back evalScript failed or timed out: the statuses are not known. */
  read_back_error?: string;
}

/** A Render Queue item that was unchecked to render only the chosen ones: index, comp id and output files identify it again. */
export interface HeldItem {
  index: number;
  comp_id: number;
  comp_name?: string;
  files: string[];
}

export interface NotRestored extends HeldItem {
  /** already_queued (nothing to do), moved, gone, changed, error, read_back_mismatch */
  code: string;
  reason: string;
  now_at?: number;
}

/** pending: not yet queued again (also after a failed or unknown attempt); restored: all done; partial: some could not be. */
export type RestoreState = "pending" | "restored" | "partial" | "failed" | "unknown";

export interface RestoreRecord {
  state: RestoreState;
  held: HeldItem[];
  restored: HeldItem[];
  not_restored: NotRestored[];
  error?: string;
}

export interface RenderJobRecord {
  job_id: string;
  op_id: string;
  state: RenderJobState;
  started_at: string;
  finished_at?: string;
  max_hours: number;
  project_path: string;
  overwrite: boolean;
  items: JobItem[];
  /** item_indexes of the call: only these items were rendered, the other QUEUED items were unchecked meanwhile. */
  only_item_indexes?: number[];
  /** The items unchecked for this job and what became of them. Kept on disk so a restart or a crash does not lose it. */
  restore?: RestoreRecord;
  /** Absent = "after_effects". With "media_encoder" the render runs in Adobe Media Encoder from the SAVED project. */
  engine?: RenderEngine;
  /** media_encoder: when queueInAME returned. */
  handed_at?: string;
  /** media_encoder: the item statuses right after queueInAME (a separate read; for the live check). */
  ame_item_statuses?: JobItemResult[];
  /** True when every queued item is DONE and every output exists with bytes (set with state "finished"). */
  ok?: boolean;
  summary?: string;
  error?: string;
  note?: string;
  result?: RenderJobResult;
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "..." : s;
}

/** The held items that were not queued again (an item found already QUEUED needs nothing). */
export function restoreLeft(r: RestoreRecord): HeldItem[] {
  const done = new Set(r.restored.map((x) => x.index));
  for (const n of r.not_restored) if (n.code === "already_queued") done.add(n.index);
  return r.held.filter((h) => !done.has(h.index));
}

/** A restore that did not finish cleanly (pending, unknown or failed) and has items left. */
function restoreUnfinished(j: RenderJobRecord): boolean {
  const r = j.restore;
  if (!r || (r.state !== "pending" && r.state !== "unknown" && r.state !== "failed")) return false;
  return restoreLeft(r).length > 0;
}

export interface PendingRestore {
  job_id: string;
  job_state: RenderJobState;
  restore_state: RestoreState;
  left: HeldItem[];
}

// ---------- the job store (JSON on disk, mirrored synchronously) ----------

export class RenderJobStore {
  private readonly jobs = new Map<string, RenderJobRecord>();
  private readonly settled = new Map<string, Promise<void>>();
  /** Sizes seen by the last status call, to say whether files grew since. Memory only. */
  readonly lastSeen = new Map<string, { bytes: number; at: number }>();
  private sink: ((rec: RenderJobRecord) => void) | null = null;
  /** Wake-ups for waiting status calls (wait_seconds); called after every update. */
  private readonly listeners = new Set<() => void>();
  private readonly reported = new Set<string>();
  /** Jobs that load() turned into "lost" or "unknown" before any sink was set; reported once when it is. */
  private readonly unreported: string[] = [];

  /**
   * Called once per job when it ends failed, unknown, lost, or finished with ok false; the tool points it at the service
   * log (bindJobFailureLog). Setting it also reports the jobs a restart turned into lost / unknown.
   */
  get failureSink(): ((rec: RenderJobRecord) => void) | null {
    return this.sink;
  }

  set failureSink(fn: ((rec: RenderJobRecord) => void) | null) {
    this.sink = fn;
    if (!fn) return;
    for (const id of this.unreported.splice(0)) {
      const rec = this.jobs.get(id);
      if (rec) this.report(rec);
    }
  }

  private report(rec: RenderJobRecord): void {
    if (this.reported.has(rec.job_id) || !this.sink) return;
    this.reported.add(rec.job_id);
    try {
      this.sink(rec);
    } catch {
      // a log line must never break a render job
    }
  }

  constructor(readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { jobs?: unknown };
      const list = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      let changed = false;
      for (const raw of list) {
        if (!raw || typeof raw !== "object" || typeof (raw as RenderJobRecord).job_id !== "string") continue;
        const rec = { ...(raw as RenderJobRecord) };
        // This process did not start it: the render it began is not tracked by anyone now.
        if (rec.state === "running" && rec.engine === "media_encoder") {
          // The hand-over was cut off before it finished: nothing says AME got the items.
          rec.state = "unknown";
          rec.finished_at = new Date().toISOString();
          rec.note =
            "The panel service restarted while this job was being handed to Media Encoder, so it is not known whether Media Encoder got it. " +
            "Look at Media Encoder's queue and at After Effects' Render Queue (items unchecked for this job may still need queuing again: see restore). Nothing was resent.";
          this.unreported.push(rec.job_id);
          changed = true;
        } else if (rec.state === "running") {
          rec.state = "lost";
          rec.finished_at = new Date().toISOString();
          rec.note =
            "The panel service restarted while this render was running, so nobody is tracking it any more. " +
            "After Effects may still be rendering, or may have finished or stopped: look at After Effects' Render Queue panel and at the output files. Nothing was resent.";
          this.unreported.push(rec.job_id);
          changed = true;
        }
        this.jobs.set(rec.job_id, rec);
      }
      if (changed) this.save();
    } catch {
      // An unreadable file is the same as no jobs.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // The newest jobs, plus any older job that still has items to put back (its record is the only list of them).
      const all = this.list();
      const recent = new Set(all.slice(-MAX_JOBS_KEPT).map((j) => j.job_id));
      const keep = all.filter((j) => recent.has(j.job_id) || restoreUnfinished(j));
      const payload = JSON.stringify({ jobs: keep }, null, 2);
      const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
      try {
        fs.writeFileSync(tmp, payload, "utf8");
        fs.renameSync(tmp, this.filePath);
      } catch {
        fs.writeFileSync(this.filePath, payload, "utf8");
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // ignore
        }
      }
    } catch {
      // The record is also in memory; a disk failure must not stop a render.
    }
  }

  /** Calls `wake` after every job update; returns the function that stops it. */
  onUpdate(wake: () => void): () => void {
    this.listeners.add(wake);
    return () => {
      this.listeners.delete(wake);
    };
  }

  list(): RenderJobRecord[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  get(jobId: string): RenderJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  create(rec: RenderJobRecord): void {
    this.jobs.set(rec.job_id, { ...rec });
    this.save();
  }

  update(jobId: string, patch: Partial<RenderJobRecord>): void {
    const cur = this.jobs.get(jobId);
    if (!cur) return;
    const next = { ...cur, ...patch, job_id: cur.job_id };
    this.jobs.set(jobId, next);
    this.save();
    for (const wake of Array.from(this.listeners)) {
      try {
        wake();
      } catch {
        // a waiting status call must never break a render job
      }
    }
    if (next.state === "failed" || next.state === "unknown" || next.state === "lost" || (next.state === "finished" && next.ok === false)) this.report(next);
  }

  /** Jobs whose held-back items may still be unchecked (restore pending, unknown or failed, with items left). */
  pendingRestores(): PendingRestore[] {
    const out: PendingRestore[] = [];
    for (const j of this.list()) {
      if (!j.restore || !restoreUnfinished(j)) continue;
      out.push({ job_id: j.job_id, job_state: j.state, restore_state: j.restore.state, left: restoreLeft(j.restore) });
    }
    return out;
  }

  /** Forgets a job that was refused before its render began and left nothing to restore. */
  discard(jobId: string): void {
    if (this.jobs.delete(jobId)) this.save();
  }

  /** The running job, else the newest one. */
  latest(): RenderJobRecord | undefined {
    const all = this.list();
    return all.find((j) => j.state === "running") ?? all[all.length - 1];
  }

  trackSettled(jobId: string, p: Promise<void>): void {
    this.settled.set(jobId, p);
  }

  /** Resolves when the background run of a job has finished (for tests). */
  done(jobId: string): Promise<void> {
    return this.settled.get(jobId) ?? Promise.resolve();
  }
}

const stores = new Map<string, RenderJobStore>();

/** The eval timeout for max_hours, below setTimeout's limit. */
export function renderTimeoutMs(maxHours: number): number {
  return Math.min(Math.round(maxHours * 3_600_000), MAX_TIMEOUT_MS);
}

export function jobsFileFor(ctx: ToolContext): string {
  return path.join(dataDirOf(ctx), "renders", RQ_RENDER_JOBS_FILE);
}

export function storeFor(ctx: ToolContext): RenderJobStore {
  const file = jobsFileFor(ctx);
  let s = stores.get(file);
  if (!s) {
    s = new RenderJobStore(file);
    stores.set(file, s);
  }
  return s;
}

/** For tests: forget the cached stores, as a service restart does. */
export function resetRenderJobStores(): void {
  stores.clear();
}

/** Seams for tests. */
export const rqrenderDeps = {
  listDialogs: listBlockingDialogs,
  /** Outputs that running aerender jobs and batches are going to write. */
  liveOutputs: (): LiveOutput[] => liveOutputsFrom(getDefaultAerenderRegistry()),
  /** One macrotask, so the tool's reply is sent before the render eval is. */
  defer: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0)),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
  /** Is Adobe Media Encoder installed? (folder "Adobe Media Encoder*" under Program Files\Adobe, or /Applications). */
  ameInstalled: (): boolean => ameInstalledOnDisk(),
  /** Is there an "Adobe Media Encoder*" folder next to After Effects' own install folder (appPath = Folder.appPackage)? */
  ameNearApp: (appPath: string | null | undefined): boolean => ameNearApp(appPath),
  /** AME's last-used preset from its prefs on disk (null when not readable). */
  readAmePreset: (): AmePresetRead | null => readAmePreset(),
  readBackTimeoutMs: READ_BACK_TIMEOUT_MS,
  stillRenderingMaxMs: STILL_RENDERING_MAX_MS,
  stillRenderingPollMs: STILL_RENDERING_POLL_MS,
};

// ---------- Media Encoder install check ----------

/** The folders where Adobe usually installs Media Encoder. */
export function ameRootCandidates(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  const roots: string[] = [];
  if (platform === "win32") {
    for (const v of [env["ProgramFiles"], env["ProgramW6432"], "C:\\Program Files"]) {
      if (v) roots.push(path.win32.join(v, "Adobe"));
    }
  } else if (platform === "darwin") {
    roots.push("/Applications");
  }
  return roots;
}

/** True when `dir` holds a folder named "Adobe Media Encoder*". Never throws. */
function hasAmeFolder(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => /^adobe media encoder/i.test(n));
  } catch {
    return false;
  }
}

/** True when a folder named "Adobe Media Encoder*" exists where Adobe usually installs it. Never throws. */
export function ameInstalledOnDisk(): boolean {
  return ameRootCandidates().some((r) => hasAmeFolder(r));
}

/**
 * True when a folder named "Adobe Media Encoder*" sits next to After Effects' own install folder (a custom install
 * location). `appPath` is After Effects' Folder.appPackage; its folder and up to three parents are each checked
 * for an "Adobe Media Encoder*" sibling. Never throws.
 */
export function ameNearApp(appPath: string | null | undefined): boolean {
  if (typeof appPath !== "string" || appPath.length === 0) return false;
  try {
    let cur = appPath;
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (hasAmeFolder(parent)) return true;
      cur = parent;
    }
  } catch {
    // not readable
  }
  return false;
}

/**
 * Files in the output's folder that Media Encoder may have written instead of `file`, and that appeared or changed since
 * `sinceMs`: the same base name with another extension, or the base name with `_<n>` added (what Media Encoder does to
 * avoid overwriting, with any extension). At most 10, at most 20,000 names looked at. Never throws.
 */
export function otherExtensionFiles(file: string, sinceMs: number): Array<{ file: string; bytes: number; mtime: string }> {
  const out: Array<{ file: string; bytes: number; mtime: string }> = [];
  try {
    if (isSequencePath(file)) return out;
    const dir = path.dirname(file);
    const base = path.basename(file);
    const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    let scanned = 0;
    for (const name of fs.readdirSync(dir)) {
      if (++scanned > 20_000 || out.length >= 10) break;
      if (name.toLowerCase() === base.toLowerCase()) continue;
      const dot = name.lastIndexOf(".");
      if (dot <= 0) continue;
      const nameStem = name.slice(0, dot).toLowerCase();
      const want = stem.toLowerCase();
      const suffixed = nameStem.startsWith(want + "_") && /^\d+$/.test(nameStem.slice(want.length + 1));
      if (nameStem !== want && !suffixed) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ file: path.join(dir, name), bytes: st.size, mtime: st.mtime.toISOString() });
      } catch {
        // vanished
      }
    }
  } catch {
    // folder unreadable
  }
  return out;
}

// ---------- output files on disk ----------

const SEQ_TOKEN = /\[(#+)\]/;

export function isSequencePath(p: string): boolean {
  return SEQ_TOKEN.test(path.basename(p));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The regex that matches the frames of an AE sequence name such as `shot_[#####].png`. */
export function sequenceRegex(fileName: string): RegExp {
  const m = SEQ_TOKEN.exec(fileName);
  if (!m) return new RegExp(`^${escapeRe(fileName)}$`, "i");
  const before = fileName.slice(0, m.index);
  const after = fileName.slice(m.index + m[0].length);
  return new RegExp(`^${escapeRe(before)}\\d{${m[1].length},}${escapeRe(after)}$`, "i");
}

/** What is on disk for one output: never throws. */
export function statOutput(o: { item_index: number; module: number; file: string; sequence?: boolean }): OutputStat {
  const dir = path.dirname(o.file);
  const sequence = o.sequence ?? isSequencePath(o.file);
  const out: OutputStat = {
    item_index: o.item_index,
    module: o.module,
    file: o.file,
    sequence,
    folder_exists: false,
    exists: false,
    bytes: 0,
    mtime: null,
  };
  try {
    out.folder_exists = fs.statSync(dir).isDirectory();
  } catch {
    return out;
  }
  try {
    if (!sequence) {
      const st = fs.statSync(o.file);
      if (st.isFile()) {
        out.exists = true;
        out.bytes = st.size;
        out.mtime = st.mtime.toISOString();
      }
      return out;
    }
    const re = sequenceRegex(path.basename(o.file));
    let frames = 0;
    let bytes = 0;
    let newest = 0;
    let statted = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!re.test(name)) continue;
      frames++;
      if (statted >= MAX_OUTPUT_FILES_STAT) {
        out.truncated = true;
        continue;
      }
      statted++;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // a frame that vanished between the listing and the stat
      }
    }
    out.frame_count = frames;
    out.exists = frames > 0;
    out.bytes = bytes;
    out.mtime = newest > 0 ? new Date(newest).toISOString() : null;
  } catch {
    // leave what was found
  }
  return out;
}

// ---------- the start checks ----------

export interface StartRefusal {
  code:
    | "already_rendering"
    | "nothing_queued"
    | "no_output_file"
    | "needs_output"
    | "folder_missing"
    | "output_exists"
    | "too_many_items"
    | "queue_truncated"
    | "duplicate_output"
    | "output_in_use"
    | "item_not_found"
    | "item_not_queued"
    | "item_comp_mismatch"
    | "bad_item_indexes"
    | "hold_failed"
    | "user_confirmation_needed"
    | "project_unsaved"
    | "ame_unavailable"
    | "ame_not_installed"
    | "ame_handover_unknown"
    | "item_indexes_with_media_encoder"
    | "restore_pending"
    | "not_in_panel";
  message: string;
  item_index?: number;
  file?: string;
}

export interface StartPlan {
  items: JobItem[];
  refusals: StartRefusal[];
  /** Things that do not stop the render but the caller should know. */
  warnings: string[];
  /** With item_indexes: the other QUEUED items, to be unchecked for the render and checked again after it. */
  hold: HeldItem[];
}

/** The items a call names (item_indexes, with comp_ids in the same order when given). */
export interface OnlyItems {
  indexes: number[];
  comp_ids?: number[];
}

/** An output file that a running aerender job or an unfinished batch item is going to write ("" file: outputs unknown). */
export interface LiveOutput {
  file: string;
  owner: string;
}

/** The outputs of aerender jobs that run and of batch items that have not finished. Never throws. */
export function liveOutputsFrom(registry: AerenderJobRegistry): LiveOutput[] {
  const out: LiveOutput[] = [];
  try {
    for (const j of registry.list()) {
      if (j.state !== "running") continue;
      const files = j.output_paths && j.output_paths.length > 0 ? j.output_paths : j.output_path ? [j.output_path] : [];
      const real = files.filter((f) => typeof f === "string" && f.length > 0 && !f.startsWith("<"));
      if (j.whole_queue === true && real.length === 0) {
        out.push({ file: "", owner: `aerender job ${j.job_id} (it renders the whole Render Queue)` });
      }
      for (const f of real) out.push({ file: f, owner: `aerender job ${j.job_id}` });
    }
  } catch {
    // an unreadable registry is no information
  }
  try {
    const store = new BatchStore(path.join(registry.rendersDir, "batches"));
    for (const b of store.list(20)) {
      if (b.state !== "running") continue;
      for (const it of b.items) {
        if (it.state !== "pending" && it.state !== "running") continue;
        for (const f of outputsOf(it)) out.push({ file: f, owner: `render batch ${b.batch_id}` });
      }
    }
  } catch {
    // see above
  }
  return out;
}

/** Judges the Render Queue read (rqeditRead) against what ae_render_queue_render needs. Pure apart from fs. */
export function planStart(queue: QueueRead | null, overwrite: boolean, live: LiveOutput[] = [], only?: OnlyItems): StartPlan {
  const refusals: StartRefusal[] = [];
  const warnings: string[] = [];
  const items: JobItem[] = [];
  const hold: HeldItem[] = [];
  if (!queue) {
    return {
      items,
      refusals: [{ code: "nothing_queued", message: "The Render Queue could not be read." }],
      warnings,
      hold,
    };
  }
  if (queue.rendering === true) {
    refusals.push({ code: "already_rendering", message: "After Effects' Render Queue is already rendering (started by a person or another tool). Nothing was started." });
  }
  if (queue.truncated === true) {
    refusals.push({
      code: "queue_truncated",
      message: `The Render Queue read stopped at ${queue.items.length} of ${queue.numItems} items, so the rest were not checked and render() would still render them. Nothing was started. Remove or unqueue items first.`,
    });
  }
  let queued = queue.items.filter((i: ItemRead) => i.status === "queued");
  if (only) {
    // Only the named items render; each must be QUEUED, then every other QUEUED item is held back.
    const chosen: ItemRead[] = [];
    const seenIdx = new Set<number>();
    only.indexes.forEach((n, k) => {
      if (seenIdx.has(n)) return;
      seenIdx.add(n);
      const it = queue.items.find((i: ItemRead) => i.index === n);
      if (!it) {
        refusals.push({ code: "item_not_found", item_index: n, message: `Render Queue item ${n} does not exist (the queue has ${queue.numItems}). Nothing was started.` });
        return;
      }
      const want = only.comp_ids?.[k];
      if (want !== undefined && it.comp_id !== want) {
        refusals.push({
          code: "item_comp_mismatch",
          item_index: n,
          message: `Render Queue item ${n} is comp ${it.comp_id} (${it.comp_name ?? "?"}), not ${want}. The queue changed; read it again with ae_render_queue_inspect. Nothing was started.`,
        });
        return;
      }
      if (it.status !== "queued") {
        refusals.push({
          code: "item_not_queued",
          item_index: n,
          message: `Render Queue item ${n} (${it.comp_name ?? "comp " + it.comp_id}) is ${it.status ?? "not known"}, not QUEUED, so it cannot be rendered. Queue it with ae_render_queue_edit (queued: true). A finished (DONE) item cannot be queued again: duplicate it with ae_render_queue_duplicate. Nothing was started.`,
        });
        return;
      }
      chosen.push(it);
    });
    queued = chosen;
    for (const it of queue.items) {
      if (it.status !== "queued" || chosen.includes(it)) continue;
      hold.push({
        index: it.index,
        comp_id: it.comp_id,
        ...(it.comp_name !== undefined ? { comp_name: it.comp_name } : {}),
        files: (it.output_modules ?? []).map((m) => (typeof m.file === "string" ? m.file : "")),
      });
    }
  }
  for (const it of queue.items) {
    if (it.status === "needs_output" && it.render === true) {
      refusals.push({
        code: "needs_output",
        item_index: it.index,
        message: `Render Queue item ${it.index} (${it.comp_name ?? "comp " + it.comp_id}) is checked to render but has no output (NEEDS_OUTPUT), so Render would stop at it. Give it an output file with ae_render_queue_edit (output_modules[].file) or uncheck it. Nothing was started.`,
      });
    }
  }
  if (queued.length === 0 && !only) {
    refusals.push({
      code: "nothing_queued",
      message:
        "No Render Queue item is QUEUED, so Render would do nothing. Queue one with ae_render_queue_edit (queued: true) or add one with ae_render_queue_add. " +
        "A finished (DONE) item cannot be queued again (After Effects locks it): make a fresh copy of it with ae_render_queue_duplicate.",
    });
  }
  if (queued.length > MAX_ITEMS) {
    refusals.push({
      code: "too_many_items",
      message: `${queued.length} items are QUEUED; this tool checks and reports at most ${MAX_ITEMS}, and render() renders all of them. Nothing was started. Unqueue some items.`,
    });
  }
  const seen = new Map<string, string>();
  const liveByKey = new Map<string, string>();
  let liveUnknown: string | null = null;
  for (const l of live) {
    if (l.file === "") liveUnknown = l.owner;
    else liveByKey.set(pathKey(l.file), l.owner);
  }
  if (liveUnknown) {
    refusals.push({ code: "output_in_use", message: `${liveUnknown} is running, so its outputs are not known and could be the same files. Wait for it or cancel it. Nothing was started.` });
  }
  for (const it of queued.slice(0, MAX_ITEMS)) {
    const job: JobItem = { index: it.index, comp_id: it.comp_id, comp_name: it.comp_name, outputs: [] };
    if (it.output_modules_truncated === true) {
      refusals.push({
        code: "queue_truncated",
        item_index: it.index,
        message: `Render Queue item ${it.index} has more output modules than were read, so the unread ones were not checked. Nothing was started. Remove extra output modules.`,
      });
    }
    for (const m of it.output_modules ?? []) {
      const where = `Render Queue item ${it.index} (${it.comp_name ?? "comp " + it.comp_id}) output module ${m.index}`;
      if (typeof m.file !== "string" || m.file.length === 0) {
        refusals.push({ code: "no_output_file", item_index: it.index, message: `${where} has no output file. Give it one with ae_render_queue_edit (output_modules[].file).` });
        continue;
      }
      const key = pathKey(m.file);
      const earlier = seen.get(key);
      if (earlier) {
        refusals.push({
          code: "duplicate_output",
          item_index: it.index,
          file: m.file,
          message: `${where} writes the same file as ${earlier} (${m.file}); they would overwrite each other. Give each its own file with ae_render_queue_edit.`,
        });
      } else {
        seen.set(key, where);
      }
      const owner = liveByKey.get(key);
      if (owner) {
        refusals.push({ code: "output_in_use", item_index: it.index, file: m.file, message: `${where}: ${owner} is going to write ${m.file}. Wait for it, cancel it, or change the file. Nothing was started.` });
      }
      const sequence = isSequencePath(m.file);
      const stat = statOutput({ item_index: it.index, module: m.index, file: m.file, sequence });
      if (!stat.folder_exists) {
        const dir = path.dirname(m.file);
        let parentExists = false;
        try {
          parentExists = fs.statSync(path.dirname(dir)).isDirectory();
        } catch {
          parentExists = false;
        }
        if (!parentExists) {
          refusals.push({ code: "folder_missing", item_index: it.index, file: m.file, message: `${where}: the folder ${dir} and its parent do not exist. Nothing is created for you; make the folder or change the file.` });
          continue;
        }
        // "Save in subfolder" in an output module makes its folder when the render starts, so a missing folder under an existing parent is not refused.
        warnings.push(
          `${where}: the folder ${dir} does not exist yet, but its parent does. After Effects can make a subfolder at render time ("Save in subfolder"), so this is not refused; if it does not, the render stops at this item. Nothing is created for you.`
        );
      } else if (stat.exists && !overwrite) {
        refusals.push({
          code: "output_exists",
          item_index: it.index,
          file: m.file,
          message: `${where}: ${sequence ? `${stat.frame_count} frame(s) of ${m.file} already exist` : `${m.file} already exists`}. Nothing is deleted. Change the file, or pass overwrite: true (After Effects then asks "Overwrite?" and the render waits until it is answered).`,
        });
      }
      job.outputs.push({ item_index: it.index, comp_id: it.comp_id, module: m.index, file: m.file, sequence });
    }
    items.push(job);
  }
  return { items, refusals, warnings, hold };
}

// ---------- reading the result ----------

interface ResultRead {
  rendering?: boolean;
  numItems?: number;
  items?: Array<{ index: number; comp_id: number | null; comp_name?: string; status: string | null; comp_matches?: boolean; elapsed_seconds?: number; error?: string }>;
}

/** After Effects says the render is not over: the queue is rendering, or an item is RENDERING or WILL_CONTINUE. */
export function stillRendering(read: ResultRead | null): boolean {
  if (!read) return false;
  if (read.rendering === true) return true;
  return (read.items ?? []).some((r) => r.status === "rendering" || r.status === "will_continue");
}

/** Turns the item statuses and the files on disk into the job's verdict. Pure apart from fs. */
export function judgeResult(items: JobItem[], read: ResultRead | null, readBackError?: string): { result: RenderJobResult; ok: boolean; summary: string } {
  const statuses: JobItemResult[] = [];
  for (const it of items) {
    const row = read?.items?.find((r) => r.index === it.index);
    statuses.push({
      index: it.index,
      comp_id: row?.comp_id ?? null,
      comp_name: row?.comp_name ?? it.comp_name,
      status: row?.status ?? null,
      ...(typeof row?.elapsed_seconds === "number" ? { elapsed_seconds: row.elapsed_seconds } : {}),
      ...(row && row.comp_matches === false ? { comp_matches: false } : {}),
      ...(row?.error ? { error: clip(row.error) } : {}),
    });
  }
  const outputs: OutputStat[] = [];
  for (const it of items) for (const o of it.outputs) outputs.push(statOutput(o));
  const result: RenderJobResult = { item_statuses: statuses, outputs, ...(readBackError ? { read_back_error: clip(readBackError) } : {}) };

  if (!read) {
    return { result, ok: false, summary: `The render call returned, but the item statuses could not be read back (${clip(readBackError ?? "no answer")}). Look at After Effects' Render Queue panel; the output files on disk are listed.` };
  }
  if (stillRendering(read)) {
    return { result, ok: false, summary: "After Effects still reports that it is rendering (the Render Queue, or an item is RENDERING or WILL_CONTINUE), so the render is not over. Look at After Effects." };
  }
  const bad = statuses.filter((s) => s.status !== "done");
  const stopped = statuses.filter((s) => s.status === "user_stopped");
  const errored = statuses.filter((s) => s.status === "err_stopped");
  const emptyOutputs = outputs.filter((o) => !o.exists || o.bytes <= 0);
  const moved = statuses.filter((s) => s.comp_matches === false);
  if (moved.length > 0) {
    return { result, ok: false, summary: "The Render Queue changed during the render (an item now holds a different comp), so the statuses may not be the ones started. Look at After Effects." };
  }
  if (errored.length > 0) {
    return { result, ok: false, summary: `Stopped by an error on item(s) ${errored.map((s) => s.index).join(", ")} (ERR_STOPPED). See the render log in After Effects; ae_verify_render can check what was written.` };
  }
  if (stopped.length > 0) {
    return { result, ok: false, summary: `Stopped by the user on item(s) ${stopped.map((s) => s.index).join(", ")} (USER_STOPPED). Files already written are on disk (see outputs).` };
  }
  if (bad.length > 0) {
    return { result, ok: false, summary: `Item(s) ${bad.map((s) => `${s.index} (${s.status ?? "unknown"})`).join(", ")} did not reach DONE.` };
  }
  if (emptyOutputs.length > 0) {
    return { result, ok: false, summary: `Every item reads DONE, but ${emptyOutputs.length} output(s) are missing or empty on disk (see outputs). Look at After Effects and check the output path.` };
  }
  return { result, ok: true, summary: `All ${statuses.length} item(s) reached DONE and every output exists on disk.` };
}

// ---------- schemas ----------

export const AeRenderQueueRenderSchema = z.object({
  max_hours: z
    .number()
    .min(1)
    .max(48)
    .default(12)
    .describe("The most hours the render call may take before the job reports its outcome as unknown (1-48, default 12). A render that is still going then keeps running in After Effects; nothing is resent and nothing is stopped."),
  overwrite: z.boolean().optional().describe("Allow output files that already exist. Default false: the call is refused if any queued output already exists. Nothing is ever deleted by this tool. After Effects then asks \"<file> already exists. Overwrite?\" (OK / Cancel) for each and the render waits on it (measured, AE 26.3): OK there is a destructive answer that needs the user's instruction, and Cancel leaves the item QUEUED and the file as it was."),
  item_indexes: z
    .array(z.number().int().min(1).max(500))
    .min(1)
    .max(MAX_ITEMS)
    .optional()
    .describe(
      "Render only these QUEUED items (1-based, as ae_render_queue_inspect shows). Without it After Effects renders EVERY QUEUED item. The other QUEUED items have their Render box unchecked before the render and checked again after it, also when it failed or was stopped. When After Effects cannot be reached afterwards (outcome unknown, lost, or a Media Encoder hand-over timeout) they stay unchecked: the record keeps the list and the status gives restore_how. A later item_indexes render is refused (restore_pending) while an earlier job still has items to put back. Not with engine media_encoder."
    ),
  comp_ids: z
    .array(z.number().int())
    .min(1)
    .max(MAX_ITEMS)
    .optional()
    .describe("With item_indexes: the comp id each index must hold, same order; refused on a mismatch."),
  start_now: z.boolean().optional().describe("media_encoder: true starts AME's WHOLE queue at once, including items the user queued there themselves, each with AME's LAST preset. Needs whole_ame_queue_ok: true. Default false: items wait for the user to press Start."),
  whole_ame_queue_ok: z.boolean().optional().describe("media_encoder with start_now: true only: the user agreed that EVERY item waiting in Media Encoder's queue starts, not only the ones handed over now. Without it start_now is refused."),
  engine: z
    .enum(["after_effects", "media_encoder"])
    .optional()
    .describe("media_encoder: Adobe Media Encoder renders the SAVED project, AE stays free; needs user_confirmed. Default after_effects."),
  user_confirmed: z.boolean().optional().describe("True after the user agreed to Media Encoder."),
  sequence_check: SequenceCheckSchema,
  expect: ExpectSchema,
});

export const AeRenderQueueRenderStatusSchema = z.object({
  job_id: z.string().min(1).max(100).optional().describe("A job id from ae_render_queue_render. Default: the running job, else the newest."),
  include_dialogs: z.boolean().default(true).optional().describe("Also list popups blocking After Effects (read from outside AE; screenshots are not taken). Default true."),
  wait_seconds: z
    .number()
    .min(0)
    .max(30)
    .default(0)
    .optional()
    .describe("Wait up to this many seconds (0-30, default 0) for the job's state (or restore state) to change, then answer. An output file appearing ends the wait only for a Media Encoder job, whose state never changes; the reply says waited_ms. Never touches After Effects."),
});

type RenderArgs = z.infer<typeof AeRenderQueueRenderSchema>;
type StatusArgs = z.infer<typeof AeRenderQueueRenderStatusSchema>;

// ---------- holding the other items back, and putting them back ----------

interface HoldResult {
  held?: Array<{ index: number }>;
  errors?: string[];
}

interface ReleaseResult {
  restored?: Array<{ index: number; comp_id: number; files: string[] }>;
  not_restored?: Array<{ index: number; comp_id: number; files: string[]; code: string; reason: string; now_at?: number }>;
  errors?: string[];
}

export interface RestoreOutcome {
  state: RestoreState;
  restored: HeldItem[];
  not_restored: NotRestored[];
  error?: string;
  timedOut?: boolean;
}

const stripHeld = (h: HeldItem) => ({ index: h.index, comp_id: h.comp_id, files: h.files });

/** What a restore leaves: "restored" when every held item is queued again or was queued already. */
function restoreStateOf(held: HeldItem[], restored: HeldItem[], notRestored: NotRestored[], error?: string): RestoreState {
  const benign = notRestored.filter((n) => n.code === "already_queued").length;
  if (!error && restored.length + benign === held.length && notRestored.length === benign) return "restored";
  return "partial";
}

/**
 * Checks the Render box again on the held items that are still UNQUEUED and still match (index, comp id,
 * output files), in one evalScript, then reads them back in another. Never throws. A failed eval leaves the
 * state "failed" (or "unknown" after a timeout) and the items as they were.
 */
export async function restoreHeld(ctx: ToolContext, idBase: string, held: HeldItem[]): Promise<RestoreOutcome> {
  if (held.length === 0) return { state: "restored", restored: [], not_restored: [] };
  const names = new Map(held.map((h) => [h.index, h.comp_name] as const));
  const named = <T extends { index: number }>(x: T): T & { comp_name?: string } => {
    const n = names.get(x.index);
    return n !== undefined ? { ...x, comp_name: n } : x;
  };
  let rel: ReleaseResult | null = null;
  try {
    const res = await ctx.bridge.evalRaw<ReleaseResult>({
      id: idBase,
      script: buildJsxCall("rqeditRelease", { items: held.map(stripHeld) }),
      label: "ae_render_queue_render (queue the held-back items again)",
      mutates: true,
      mustSend: true,
      toolName: "ae_render_queue_render",
      timeoutMs: rqrenderDeps.readBackTimeoutMs,
    });
    rel = (res.result ?? null) as ReleaseResult | null;
  } catch (err) {
    const timedOut = err instanceof BridgeError && err.kind === "timeout";
    return { state: timedOut ? "unknown" : "failed", restored: [], not_restored: [], error: clip(errMessage(err)), ...(timedOut ? { timedOut: true } : {}) };
  }
  let restored: HeldItem[] = (rel?.restored ?? []).map((r) => named({ index: r.index, comp_id: r.comp_id, files: r.files }));
  const notRestored: NotRestored[] = (rel?.not_restored ?? []).map((r) => named({ ...r }));
  let error = rel?.errors && rel.errors.length > 0 ? clip(rel.errors.join("; ")) : undefined;
  if (restored.length > 0) {
    // A separate read: a read in the write's own script would give stale values.
    try {
      const back = await ctx.bridge.evalRaw<QueueRead>({
        id: `${idBase}read`,
        script: buildJsxCall("rqeditRead", { item_indexes: restored.map((r) => r.index), settings: false }),
        label: "ae_render_queue_render (read-back of the restore)",
        mutates: false,
        toolName: "ae_render_queue_render",
        timeoutMs: rqrenderDeps.readBackTimeoutMs,
      });
      const rows = back.result?.items ?? [];
      const bad = restored.filter((r) => rows.find((x) => x.index === r.index)?.status !== "queued");
      if (bad.length > 0) {
        for (const b of bad) notRestored.push({ ...b, code: "read_back_mismatch", reason: "the read-back after checking its Render box does not say QUEUED" });
        restored = restored.filter((r) => !bad.includes(r));
      }
    } catch (err) {
      error = clip(`${error ? error + "; " : ""}the read-back of the restore failed (${errMessage(err)}): look at the Render Queue`);
    }
  }
  return { state: restoreStateOf(held, restored, notRestored, error), restored, not_restored: notRestored, ...(error ? { error } : {}) };
}

/** After the hold: the chosen items QUEUED, every other item not QUEUED. Returns the problem, or null. */
function holdProblem(read: QueueRead | null, plan: StartPlan, numItems: number | undefined): string | null {
  if (!read) return "the queue could not be read back";
  const chosen = new Set(plan.items.map((i) => i.index));
  if (numItems !== undefined && read.numItems !== numItems) return `the queue now has ${read.numItems} items, not ${numItems}`;
  for (const it of read.items) {
    if (chosen.has(it.index) && it.status !== "queued") return `item ${it.index} (to render) reads ${it.status ?? "unknown"}, not QUEUED`;
    if (!chosen.has(it.index) && it.status === "queued") return `item ${it.index} is still QUEUED`;
  }
  for (const c of chosen) if (!read.items.some((i) => i.index === c)) return `item ${c} was not in the read-back`;
  return null;
}

/**
 * Unchecks the other QUEUED items in one undo group, then reads the queue in a separate evalScript to confirm only
 * the chosen items are QUEUED. On any problem it puts back what it changed. Never throws.
 */
async function holdOthers(
  ctx: ToolContext,
  opId: string,
  plan: StartPlan,
  numItems: number | undefined
): Promise<{ ok: true } | { ok: false; problem: string; outcome: RestoreOutcome; wrote: boolean }> {
  let problem: string | null = null;
  // rqeditHold throws only before it writes (a refused door, a host guard, a bad argument), so an eval that failed that way wrote nothing.
  let wrote = true;
  try {
    const res = await ctx.bridge.evalRaw<HoldResult>({
      id: `${opId}_hold`,
      script: buildJsxCall("rqeditHold", {
        keep: plan.items.map((i) => ({ index: i.index, comp_id: i.comp_id })),
        hold: plan.hold.map(stripHeld),
      }),
      label: "ae_render_queue_render (uncheck the other queued items)",
      mutates: true,
      toolName: "ae_render_queue_render",
    });
    const errs = res.result?.errors ?? [];
    if (errs.length > 0) problem = `After Effects refused to uncheck: ${errs.join("; ")}`;
  } catch (err) {
    problem = errMessage(err);
    if (err instanceof BridgeError && err.kind !== "timeout" && err.kind !== "unreachable") wrote = false;
  }
  if (problem !== null && !wrote) {
    return { ok: false, problem: clip(problem), outcome: { state: "restored", restored: [], not_restored: [] }, wrote: false };
  }
  if (problem === null) {
    try {
      const back = await ctx.bridge.evalRaw<QueueRead>({
        id: `${opId}_holdread`,
        script: buildJsxCall("rqeditRead", { settings: false }),
        label: "ae_render_queue_render (read-back of the hold)",
        mutates: false,
        toolName: "ae_render_queue_render",
      });
      const bad = holdProblem((back.result ?? null) as QueueRead | null, plan, numItems);
      if (bad) problem = `the read-back does not show only the chosen items QUEUED: ${bad}`;
    } catch (err) {
      problem = `the read-back failed: ${errMessage(err)}`;
    }
  }
  if (problem === null) return { ok: true };
  const outcome = await restoreHeld(ctx, `${opId}_unhold`, plan.hold);
  return { ok: false, problem: clip(problem), outcome, wrote: true };
}

/** Holds the other QUEUED items back; returns the refusal to send when that failed (the job record is discarded or marked failed), else null. */
async function holdOrRefuse(ctx: ToolContext, store: RenderJobStore, jobId: string, opId: string, plan: StartPlan, numItems: number | undefined): Promise<Record<string, unknown> | null> {
  bindJobFailureLog(store, ctx.log);
  const h = await holdOthers(ctx, opId, plan, numItems);
  if (h.ok) return null;
  const clean = h.outcome.state === "restored";
  if (clean) {
    store.discard(jobId);
  } else {
    store.update(jobId, {
      state: "failed",
      finished_at: new Date().toISOString(),
      ok: false,
      error: h.problem,
      restore: { state: h.outcome.state, held: plan.hold, restored: h.outcome.restored, not_restored: h.outcome.not_restored, ...(h.outcome.error ? { error: h.outcome.error } : {}) },
      summary: `Nothing was rendered. The other queued items could not be unchecked cleanly (${h.problem}) and putting them back failed in part. ${restoreSummary({ state: h.outcome.state, held: plan.hold, restored: h.outcome.restored, not_restored: h.outcome.not_restored, ...(h.outcome.error ? { error: h.outcome.error } : {}) })}`,
    });
  }
  return {
    ok: false,
    started: false,
    refused: [
      {
        code: "hold_failed",
        message: `The other queued items could not be unchecked, so nothing was rendered: ${h.problem}. ${
          !h.wrote ? "Nothing was unchecked." : clean ? "Everything that was unchecked is QUEUED again." : "Some items could not be put back; see restore and call ae_render_queue_inspect."
        }`,
      },
    ],
    ...(clean ? {} : { job_id: jobId, restore: h.outcome, restore_how: RESTORE_HOW }),
  };
}

// ---------- the background run ----------

/**
 * Shuts the gate for a job. When an "unknown" gate lifts later, the job record says the statuses
 * may never have been read. The user's "Clear render lock" (RenderGate.clear) marks the job
 * unknown and frees the queue lease, which the job would otherwise hold until its eval returns.
 */
export function beginRenderGate(store: RenderJobStore, info: { job_id: string; op_id: string; started_at: string }, lease?: QueueLease): void {
  renderGate.begin(
    info,
    () =>
      store.update(info.job_id, {
        note:
          "The panel has nothing in flight again, so After Effects answers; the item statuses may never have been read. " +
          "Look at After Effects' Render Queue panel and the output files, and call ae_render_queue_inspect.",
      }),
    () => {
      const cur = store.get(info.job_id);
      store.update(info.job_id, {
        ...(cur && cur.state === "running" ? { state: "unknown" as const, finished_at: new Date().toISOString() } : {}),
        note:
          "The user cleared the render lock in the panel. Nothing was resent or stopped; After Effects may still be rendering. " +
          "Look at After Effects' Render Queue panel and the output files.",
      });
      lease?.release();
    }
  );
}

/** Sends one [ERR] line to the service log when a job of this store ends failed, unknown, lost, or finished with ok false (panel/client/common.js, JOB_LINE, counts it). */
export function bindJobFailureLog(store: RenderJobStore, log: ((level: string, msg: string) => void) | undefined): void {
  if (!log) return;
  store.failureSink = (rec) => {
    const reason = rec.error || rec.summary || rec.note || "no reason recorded";
    // The panel's JOB_LINE (client/common.js) knows only "failed" and "ended unknown": a lost job is an unknown outcome; a finished one that is not ok failed.
    const word = rec.state === "unknown" || rec.state === "lost" ? "ended unknown" : "failed";
    log("err", `job ae_render_queue_render ${rec.job_id} ${word}: ${reason.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RunParams {
  ctx: ToolContext;
  store: RenderJobStore;
  jobId: string;
  opId: string;
  lease: QueueLease;
  timeoutMs: number;
  items: JobItem[];
  /** With item_indexes: the number of QUEUED items the render must find (the chosen ones), checked inside the render's own eval. */
  expectedQueued?: number;
}

/**
 * Sends the long render eval, then reads the result. Never throws: every
 * failure goes into the job record. Releases the lease; opens the gate unless
 * the render's outcome is unknown (then the gate stays shut).
 */
export async function runRenderJob(p: RunParams): Promise<void> {
  const { ctx, store, jobId, opId, items } = p;
  bindJobFailureLog(store, ctx.log);
  let keepGate = false;
  try {
    // The tool's reply goes out first; the call that keeps After Effects busy starts one macrotask later.
    await rqrenderDeps.defer();
    let evalProblem: { kind: string; message: string } | null = null;
    try {
      await ctx.bridge.evalRaw({
        id: opId,
        script: buildJsxCall("rqeditRender", p.expectedQueued !== undefined ? { expected_queued: p.expectedQueued } : {}),
        label: "ae_render_queue_render (render)",
        mutates: true,
        toolName: "ae_render_queue_render",
        timeoutMs: p.timeoutMs,
      });
    } catch (err) {
      evalProblem = { kind: err instanceof BridgeError ? err.kind : "other", message: errMessage(err) };
    }

    if (evalProblem && evalProblem.kind === "timeout") {
      // The evalScript is still running inside After Effects and is never aborted.
      keepGate = true;
      renderGate.markUnknown("render_timeout");
      store.update(jobId, {
        state: "unknown",
        finished_at: new Date().toISOString(),
        error: clip(evalProblem.message),
        note:
          "The render call reached its time limit, so its outcome is unknown. After Effects may still be rendering. Nothing was resent and nothing was stopped. " +
          "Look at After Effects' Render Queue panel; other tools stay refused until the panel service has nothing in flight again. If After Effects no longer renders, restarting it clears this.",
      });
      return;
    }
    if (evalProblem && evalProblem.kind === "unreachable") {
      store.update(jobId, {
        state: "unknown",
        finished_at: new Date().toISOString(),
        error: clip(evalProblem.message),
        note: "The panel could not be reached while the render ran, so its outcome is unknown. Look at After Effects. Nothing was resent.",
      });
      return;
    }

    // The render call returned (or the host function raised an error): read what happened in a SEPARATE evalScript.
    // While After Effects still says it renders, the gate stays shut and the read is repeated (bounded).
    let read: ResultRead | null = null;
    let readBackError: string | undefined;
    let stillGoing = false;
    let readBackTimedOut = false;
    const deadline = rqrenderDeps.now() + rqrenderDeps.stillRenderingMaxMs;
    for (let n = 1; ; n++) {
      try {
        const res = await ctx.bridge.evalRaw<ResultRead>({
          id: n === 1 ? `${opId}_after` : `${opId}_after${n}`,
          script: buildJsxCall("rqeditRenderResult", { indexes: items.map((i) => i.index), comp_ids: items.map((i) => i.comp_id) }),
          label: "ae_render_queue_render (read-back)",
          mutates: false,
          toolName: "ae_render_queue_render",
          timeoutMs: rqrenderDeps.readBackTimeoutMs,
        });
        read = (res.result ?? null) as ResultRead | null;
      } catch (err) {
        read = null;
        readBackError = errMessage(err);
        if (err instanceof BridgeError && err.kind === "timeout") {
          keepGate = true;
          readBackTimedOut = true;
          renderGate.markUnknown("read_back_timeout");
        }
        break;
      }
      if (!stillRendering(read)) break;
      if (rqrenderDeps.now() >= deadline) {
        stillGoing = true;
        break;
      }
      await rqrenderDeps.sleep(rqrenderDeps.stillRenderingPollMs);
    }

    // The other QUEUED items that were unchecked go back to QUEUED now, whatever the render did (a SEPARATE evalScript).
    // Not while the outcome is unknown: AE may still be rendering, and the record keeps the list as pending.
    let restorePatch: Partial<RenderJobRecord> = {};
    const held = store.get(jobId)?.restore;
    if (held && held.held.length > 0 && !keepGate && !stillGoing) {
      const out = await restoreHeld(ctx, `${opId}_restore`, held.held);
      if (out.timedOut) {
        keepGate = true;
        renderGate.markUnknown("read_back_timeout");
      }
      restorePatch = { restore: { state: out.state, held: held.held, restored: out.restored, not_restored: out.not_restored, ...(out.error ? { error: out.error } : {}) } };
    }
    const judged = judgeResult(items, read, readBackError);
    if (restorePatch.restore) judged.summary += " " + restoreSummary(restorePatch.restore);
    if (stillGoing) {
      keepGate = true;
      renderGate.markUnknown("still_rendering");
      store.update(jobId, {
        state: "unknown",
        finished_at: new Date().toISOString(),
        ok: false,
        summary: judged.summary,
        result: judged.result,
        note:
          "The render call returned, but After Effects kept reporting that it is rendering, so the outcome is unknown and other tools stay refused. " +
          "Look at After Effects' Render Queue panel. If it no longer renders, restarting After Effects (or the user's Clear render lock button in the panel) clears this.",
      });
      return;
    }
    if (readBackTimedOut) {
      // The read of the result did not answer: the statuses are not known, so the outcome is unknown (not "finished"), and the gate stays shut.
      store.update(jobId, {
        state: "unknown",
        finished_at: new Date().toISOString(),
        ok: false,
        ...(evalProblem ? { error: clip(evalProblem.message) } : {}),
        summary: judged.summary,
        result: judged.result,
        note:
          "The render call returned, but the read of its result timed out, so the outcome is unknown and other tools stay refused until the panel service has nothing in flight again. " +
          "Look at After Effects' Render Queue panel and the output files. Items unchecked for this job were not queued again: see restore.",
      });
      return;
    }
    if (evalProblem) {
      store.update(jobId, {
        state: "failed",
        finished_at: new Date().toISOString(),
        ok: false,
        error: clip(evalProblem.message),
        summary: `After Effects raised an error from the render call: ${clip(evalProblem.message)}. ${judged.summary}`,
        result: judged.result,
        ...restorePatch,
      });
    } else {
      store.update(jobId, { state: "finished", finished_at: new Date().toISOString(), ok: judged.ok, summary: judged.summary, result: judged.result, ...restorePatch });
    }

    // The render changed the Render Queue (statuses, DONE items): take the new state as the session baseline, still behind the gate,
    // so the next write does not report the render as the user's change.
    if (read && !keepGate) {
      try {
        const rec = store.get(jobId);
        await noteUiWrite(ctx, {
          opId: `${opId}_rebase`,
          toolName: "ae_render_queue_render",
          label: "ae_render_queue_render (session baseline)",
          expect: { project_path: rec?.project_path ?? "<unsaved>" },
        });
      } catch {
        // bookkeeping only
      }
    }
  } catch (err) {
    try {
      store.update(jobId, { state: "failed", finished_at: new Date().toISOString(), ok: false, error: clip(errMessage(err)), summary: "The render job's bookkeeping failed; look at After Effects and the output files." });
    } catch {
      // nothing more can be done
    }
  } finally {
    if (!keepGate) renderGate.end(jobId);
    p.lease.release();
  }
}

/** One sentence on what became of the items held back for the render. */
export function restoreSummary(r: RestoreRecord): string {
  const where = (xs: HeldItem[]) => xs.map((x) => `${x.index} (${x.comp_name ?? "comp " + x.comp_id})`).join(", ");
  if (r.state === "restored") {
    return r.restored.length > 0 ? `The ${r.restored.length} other item(s) that were unchecked for this render are QUEUED again: ${where(r.restored)}.` : "The other items that were unchecked for this render were already QUEUED again.";
  }
  const parts: string[] = [];
  if (r.restored.length > 0) parts.push(`queued again: ${where(r.restored)}`);
  const left = r.not_restored.filter((n) => n.code !== "already_queued");
  if (left.length > 0) parts.push(`NOT queued again: ${left.map((n) => `${n.index} (${n.comp_name ?? "comp " + n.comp_id}): ${n.reason}`).join("; ")}`);
  if (r.error) parts.push(`error: ${r.error}`);
  if (r.restored.length === 0 && left.length === 0) parts.push("no item was queued again");
  return `Restore of the items unchecked for this render: ${parts.join(" | ")}.`;
}

const RESTORE_HOW =
  "Items in restore.held that are not in restore.restored were unchecked by this tool and may still be UNQUEUED. Once After Effects is idle and answers, call ae_render_queue_inspect, and for each such item whose index, comp_id and output file still match and that reads UNQUEUED, call ae_render_queue_edit with item_index, comp_id and queued: true. Leave any item that no longer matches: someone changed it.";

// ---------- restores an earlier job left undone ----------

/**
 * Of the held items that earlier jobs did not queue again, those the current queue read still shows UNQUEUED at their
 * index with the same comp and output files (so a new item_indexes render would take them for the user's own UNQUEUED
 * items). A job whose items are all queued again, moved, changed or gone since has nothing to wait for: its record is
 * closed as "partial" so it stops being reported.
 */
export function stillWaitingRestores(store: RenderJobStore, queue: QueueRead | null): PendingRestore[] {
  const out: PendingRestore[] = [];
  for (const pr of store.pendingRestores()) {
    const waiting = queue
      ? pr.left.filter((h) => {
          const it = queue.items.find((i: ItemRead) => i.index === h.index);
          if (!it || it.comp_id !== h.comp_id || it.status !== "unqueued") return false;
          const files = (it.output_modules ?? []).map((m) => (typeof m.file === "string" ? m.file : ""));
          return files.length === h.files.length && files.every((f, k) => pathKey(f) === pathKey(h.files[k]));
        })
      : pr.left;
    if (waiting.length > 0) {
      out.push({ ...pr, left: waiting });
      continue;
    }
    const rec = store.get(pr.job_id);
    if (queue && rec?.restore) {
      store.update(pr.job_id, {
        restore: {
          ...rec.restore,
          state: "partial",
          not_restored: [
            ...rec.restore.not_restored,
            ...pr.left.map((h) => ({ ...h, code: "resolved", reason: "no longer UNQUEUED at its index with the same comp and output files (queued again, changed, moved or removed since)" })),
          ],
        },
      });
    }
  }
  return out;
}

const pendingRestoresOut = (list: PendingRestore[]) =>
  list.length > 0
    ? {
        pending_restores: list.map((w) => ({ job_id: w.job_id, job_state: w.job_state, restore_state: w.restore_state, items: w.left })),
        restore_how: RESTORE_HOW,
      }
    : {};

// ---------- the Media Encoder hand-over (opt-in engine) ----------

const AME_CALL_TIMEOUT_MS = 120_000;

const AME_REFUSAL_ASK =
  "Ask the user first, then call again with user_confirmed: true. Say to them: After Effects stays free while it renders; " +
  "Media Encoder renders the SAVED project, so changes made after the last save are not in it; Media Encoder may take a moment to open; it uses its own last-used preset, so the format may differ from After Effects' output module (measured 2026-11-08: ProRes 4444 .mov instead of the module's H.264 .mp4), so check the preset and format in Media Encoder's queue before pressing Start; other items already in Media Encoder's queue start too when you press Start.";

/** What AME's preferences say it last used for After Effects items (best effort, read only). */
export interface AmePresetRead {
  /** The preset's display name, e.g. "Apple ProRes 4444". */
  name: string;
  /** Preset folder as AME shows it, e.g. "System Presets/Broadcast/Apple ProRes" (may be empty). */
  folder?: string;
  /** AME's format code of the preset as four letters, e.g. "MooV" (QuickTime) or "H264". */
  format_code?: string;
  /** File extensions that format writes, when the code is one we know. */
  extensions?: string[];
  /** The AMEPrefs.xml it came from. */
  source_file: string;
  /** When AME last wrote that file. AME writes prefs when a setting changes or on exit, so while it runs this can lag. */
  source_mtime?: string;
}

const FORMAT_EXTENSIONS: Record<string, string[]> = { MooV: ["mov"], H264: ["mp4", "m4v"] };

function fourCC(n: number): string | undefined {
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) return undefined;
  const s = String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  return /^[\x20-\x7e]{4}$/.test(s) ? s : undefined;
}

/** The AME preference folders to try, newest version first: Documents/Adobe/Adobe Media Encoder/<version>. */
function amePrefDirs(home: string): string[] {
  const base = path.join(home, "Documents", "Adobe", "Adobe Media Encoder");
  try {
    return fs
      .readdirSync(base)
      .filter((n) => /^\d+(\.\d+)*$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => path.join(base, n));
  } catch {
    return [];
  }
}

/**
 * Reads AME's "Preset Preference" (the id of the preset it last used) from AMEPrefs.xml and looks the id up in
 * PresetCache.xml / PresetUserCache.xml for its name. Read only; returns null when anything is missing or unreadable
 * (never throws, never guesses). Uses the newest version folder that has AMEPrefs.xml.
 */
export function readAmePreset(home: string = process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""): AmePresetRead | null {
  try {
    if (!home) return null;
    for (const dir of amePrefDirs(home)) {
      const prefs = path.join(dir, "AMEPrefs.xml");
      let xml: string;
      let mtime: string | undefined;
      try {
        const st = fs.statSync(prefs);
        if (!st.isFile() || st.size > 2_000_000) continue;
        xml = fs.readFileSync(prefs, "utf8");
        mtime = st.mtime.toISOString();
      } catch {
        continue;
      }
      const id = /<key>Preset Preference<\/key>\s*<ustring>([0-9a-fA-F-]{36})<\/ustring>/.exec(xml)?.[1];
      if (!id) continue;
      for (const cacheName of ["PresetUserCache.xml", "PresetCache.xml"]) {
        let cache: string;
        try {
          const cp = path.join(dir, cacheName);
          if (fs.statSync(cp).size > 20_000_000) continue;
          cache = fs.readFileSync(cp, "utf8");
        } catch {
          continue;
        }
        const at = cache.toLowerCase().indexOf(`<presetid>${id.toLowerCase()}</presetid>`);
        if (at < 0) continue;
        // The entry is one <Key>...</Key> block; its fields sit on both sides of PresetID.
        const start = cache.lastIndexOf("<Key ", at);
        const end = cache.indexOf("</Key>", at);
        const block = start >= 0 && end > start ? cache.slice(start, end) : "";
        let name = /<PresetName>([\s\S]*?)<\/PresetName>/.exec(block)?.[1]?.trim();
        const loc = name ? /^\(\$\$\$\/[^=]*=([\s\S]*)\)$/.exec(name) : null;
        if (loc?.[1]) name = loc[1];
        if (!name) continue;
        name = name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const folder = /<FolderDisplayPath>([\s\S]*?)<\/FolderDisplayPath>/.exec(block)?.[1]?.trim().replace(/&amp;/g, "&");
        const code = fourCC(Number(/<PresetFileType>(\d+)<\/PresetFileType>/.exec(block)?.[1]));
        const exts = code ? FORMAT_EXTENSIONS[code] : undefined;
        return {
          name: name.slice(0, 200),
          ...(folder ? { folder: folder.slice(0, 200) } : {}),
          ...(code ? { format_code: code } : {}),
          ...(exts ? { extensions: exts } : {}),
          source_file: prefs,
          ...(mtime ? { source_mtime: mtime } : {}),
        };
      }
    }
  } catch {
    // unreadable prefs are no information
  }
  return null;
}

const AME_PRESET_WARNING =
  "Media Encoder applies its own last-used preset to the handed-over items, not the output module's format (measured 2026-11-08: ProRes 4444 .mov instead of the module's H.264 .mp4).";

/** The warnings and the format facts for a hand-over. Never throws. */
export function ameHandOverNotes(plan: StartPlan): { warnings: string[]; asked_for: Array<{ item_index: number; module: number; extension: string }>; ame_preset: AmePresetRead | { read: false; reason: string } } {
  const warnings: string[] = [AME_PRESET_WARNING];
  const asked: Array<{ item_index: number; module: number; extension: string }> = [];
  for (const it of plan.items) {
    for (const o of it.outputs) {
      const ext = path.extname(o.file).replace(/^\./, "").toLowerCase();
      asked.push({ item_index: o.item_index, module: o.module, extension: ext || (o.sequence ? "(image sequence)" : "") });
    }
  }
  let preset: AmePresetRead | null = null;
  try {
    preset = rqrenderDeps.readAmePreset();
  } catch {
    preset = null;
  }
  if (!preset) {
    warnings.push("The preset Media Encoder will use could not be read from its preferences, so it is not known. Check the format in Media Encoder's queue before pressing Start.");
    return { warnings, asked_for: asked, ame_preset: { read: false, reason: "AME's preferences (Documents/Adobe/Adobe Media Encoder/<version>/AMEPrefs.xml) were missing, unreadable or had no last preset" } };
  }
  const wanted = Array.from(new Set(asked.map((a) => a.extension).filter((e) => e !== "")));
  if (preset.extensions) {
    const bad = wanted.filter((e) => !preset!.extensions!.includes(e));
    if (bad.length > 0) {
      warnings.push(
        `Media Encoder's last-used preset is "${preset.name}" (${preset.format_code}, writes .${preset.extensions.join("/.")}), but the output module(s) ask for .${bad.join(", .")}: the file will not be what the output module asked for. Change the preset in Media Encoder's queue before pressing Start.`
      );
    }
  } else {
    warnings.push(
      `Media Encoder's last-used preset reads "${preset.name}"${preset.folder ? ` (${preset.folder})` : ""}; the output module(s) ask for ${wanted.length > 0 ? "." + wanted.join(", .") : "another format"}. Check they match in Media Encoder's queue before pressing Start. This preference can lag while Media Encoder is open.`
    );
  }
  return { warnings, asked_for: asked, ame_preset: preset };
}

export interface AmeParams {
  ctx: ToolContext;
  store: RenderJobStore;
  jobId: string;
  opId: string;
  plan: StartPlan;
  maxHours: number;
  startNow: boolean;
}

/**
 * queueInAME(true) returns at once (Media Encoder renders on its own), so this runs inside the tool call while it holds the
 * lease and sets NO render gate. Then the item statuses are read in a separate evalScript. Never throws; every failure
 * goes into the job record. item_indexes is refused with this engine, so nothing is held back and nothing is restored here.
 */
export async function handOffToMediaEncoder(p: AmeParams): Promise<Record<string, unknown>> {
  const { ctx, store, jobId, opId, plan } = p;
  bindJobFailureLog(store, ctx.log);
  let problem: { kind: string; message: string } | null = null;
  try {
    await ctx.bridge.evalRaw({
      id: `${opId}_ame`,
      script: buildJsxCall("rqeditQueueInAme", { expected_queued: plan.items.length, start_now: p.startNow }),
      label: "ae_render_queue_render (Queue in Media Encoder)",
      mutates: true,
      toolName: "ae_render_queue_render",
      timeoutMs: AME_CALL_TIMEOUT_MS,
    });
  } catch (err) {
    problem = { kind: err instanceof BridgeError ? err.kind : "other", message: errMessage(err) };
  }
  const timedOut = problem !== null && problem.kind === "timeout";

  // What the items read right after the hand-over: a separate evalScript, for the record (the live check has no answer yet).
  let statuses: JobItemResult[] | undefined;
  if (!timedOut) {
    try {
      const res = await ctx.bridge.evalRaw<ResultRead>({
        id: `${opId}_after`,
        script: buildJsxCall("rqeditRenderResult", { indexes: plan.items.map((i) => i.index), comp_ids: plan.items.map((i) => i.comp_id) }),
        label: "ae_render_queue_render (read-back after Queue in Media Encoder)",
        mutates: false,
        toolName: "ae_render_queue_render",
        timeoutMs: rqrenderDeps.readBackTimeoutMs,
      });
      const read = (res.result ?? null) as ResultRead | null;
      statuses = plan.items.map((it) => {
        const row = read?.items?.find((r) => r.index === it.index);
        return {
          index: it.index,
          comp_id: row?.comp_id ?? null,
          comp_name: row?.comp_name ?? it.comp_name,
          status: row?.status ?? null,
          ...(row?.error ? { error: clip(row.error) } : {}),
        };
      });
    } catch {
      statuses = undefined;
    }
  }

  const now = new Date().toISOString();

  if (problem) {
    store.update(jobId, {
      state: timedOut ? "unknown" : "failed",
      finished_at: now,
      ok: false,
      error: clip(problem.message),
      summary: timedOut
        ? "The call that hands the queue to Media Encoder did not answer in time, so it is not known whether Media Encoder got it. Look at Media Encoder and After Effects. Nothing was resent."
        : `Nothing was handed to Media Encoder: ${clip(problem.message)}.`,
      ...(statuses ? { ame_item_statuses: statuses } : {}),
    });
    if (timedOut) {
      // The hand-over eval is still queued behind After Effects and may yet run: this is not "not started", and nothing may be sent again.
      return {
        ok: false,
        started: "unknown",
        job_id: jobId,
        engine: "media_encoder",
        refused: [
          {
            code: "ame_handover_unknown",
            message:
              "The call that hands the queue to Media Encoder did not answer in time, so it is NOT KNOWN whether Media Encoder got the items (the call may still run when After Effects is free). " +
              "Do not call ae_render_queue_render again. Look at Media Encoder's queue and at After Effects' Render Queue, then call ae_render_queue_render_status.",
          },
        ],
      };
    }
    return {
      ok: false,
      started: false,
      job_id: jobId,
      engine: "media_encoder",
      refused: [{ code: "ame_unavailable", message: `Media Encoder was not started: ${clip(problem.message)}.` }],
    };
  }

  const finalState = p.startNow ? ("handed_to_media_encoder" as const) : ("queued_in_media_encoder" as const);
  store.update(jobId, {
    state: finalState,
    handed_at: now,
    summary: p.startNow
      ? `Handed to Adobe Media Encoder, which started rendering the saved project on its own with its last-used preset. After Effects gets no progress from it: confirm with ae_verify_render once the output file stops growing.`
      : `Queued in Adobe Media Encoder; nothing renders until the user presses Start there. Ask the user to check the preset and format in Media Encoder's queue first; other items already in its queue start too when Start is pressed.`,
    ...(statuses ? { ame_item_statuses: statuses } : {}),
  });
  try {
    const rec = store.get(jobId);
    await noteUiWrite(ctx, {
      opId: `${opId}_rebase`,
      toolName: "ae_render_queue_render",
      label: "ae_render_queue_render (session baseline)",
      expect: { project_path: rec?.project_path ?? "<unsaved>" },
    });
  } catch {
    // bookkeeping only
  }
  let notes: ReturnType<typeof ameHandOverNotes> | null = null;
  try {
    notes = ameHandOverNotes(plan);
  } catch {
    notes = null;
  }
  return {
    ok: true,
    started: true,
    engine: "media_encoder",
    job_id: jobId,
    state: finalState,
    start_now: p.startNow,
    warnings: notes ? [...plan.warnings, ...notes.warnings] : [...plan.warnings, AME_PRESET_WARNING, "Check the format in Media Encoder's queue before pressing Start."],
    ...(notes ? { output_module_asked_for: notes.asked_for, ame_preset: notes.ame_preset } : {}),
    started_at: store.get(jobId)?.started_at,
    project_path: store.get(jobId)?.project_path,
    renders: "the SAVED project file in Adobe Media Encoder; changes made after the last save are not in it",
    items: plan.items,
    ...(statuses ? { item_statuses_after_hand_over: statuses } : {}),
    note: p.startNow
      ? "start_now was true: Media Encoder started its queue with its last-used preset. After Effects is NOT locked and other tools work. It may take a moment to open; the format may differ from the output module's (measured 2026-11-08: ProRes 4444 .mov instead of H.264 .mp4), and every other item already waiting in Media Encoder's queue started too. After Effects may show the handed items unchecked (UNQUEUED) a moment later. " +
        "After Effects gets no progress or end signal: poll ae_render_queue_render_status (output files, bytes, whether they grew, files with another extension). Never say it finished from this call: confirm with ae_verify_render once the file stops growing."
      : "The items were put in Media Encoder's queue and WAIT there; nothing renders yet. Ask the user to open Media Encoder, check the preset and format of each item (it uses its last-used preset, not necessarily the output module's: measured 2026-11-08, ProRes 4444 .mov instead of H.264 .mp4) and press Start; other items already in Media Encoder's queue start too when Start is pressed. After Effects may show the handed items unchecked (UNQUEUED) a moment later. " +
        "After Effects is NOT locked. Once the user has pressed Start, poll ae_render_queue_render_status (output files, bytes, growth, files with another extension); confirm with ae_verify_render once the file stops growing.",
  };
}

// ---------- status ----------

function elapsedSeconds(rec: RenderJobRecord, nowMs: number): number {
  const start = Date.parse(rec.started_at);
  const end = rec.state === "running" || !rec.finished_at ? nowMs : Date.parse(rec.finished_at);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
}

/** What a waiting status call watches in a job: its state and restore state; for a Media Encoder job (whose state never changes) also which output files exist. */
function jobSignature(rec: RenderJobRecord): string {
  if (rec.engine !== "media_encoder") return `${rec.state}|${rec.restore?.state ?? ""}`;
  const files = rec.items.flatMap((it) => it.outputs.map((o) => (statOutput(o).exists ? "1" : "0")));
  return `${rec.state}|${rec.restore?.state ?? ""}|${files.join("")}`;
}

const WAITABLE_STATES = new Set<string>(["running", "queued_in_media_encoder", "handed_to_media_encoder"]);

/**
 * wait_seconds for the status tool: waits until the job's state (or restore state) differs from what it was when the call came in,
 * (for a Media Encoder job: or an output file appears), or the time ends. A job that is already over is not waited for. Returns null when no wait was asked.
 */
async function waitForJob(store: RenderJobStore, jobId: string, seconds: number | undefined): Promise<{ waited_ms: number } | null> {
  const wait = clampWaitSeconds(seconds);
  if (wait === 0) return null;
  const start = store.get(jobId);
  if (!start || !WAITABLE_STATES.has(start.state)) return { waited_ms: 0 };
  const baseline = jobSignature(start);
  const res = await waitForChange({
    seconds: wait,
    subscribe: (wake) => store.onUpdate(wake),
    changed: () => {
      const cur = store.get(jobId);
      return !cur || jobSignature(cur) !== baseline;
    },
  });
  return { waited_ms: res.waited_ms };
}

export async function describeJob(ctx: ToolContext, store: RenderJobStore, rec: RenderJobRecord, includeDialogs: boolean, now: () => number = Date.now): Promise<Record<string, unknown>> {
  const nowMs = now();
  const outputs: OutputStat[] = [];
  for (const it of rec.items) for (const o of it.outputs) outputs.push(statOutput(o));
  const totalBytes = outputs.reduce((n, o) => n + o.bytes, 0);
  const startMs = Date.parse(rec.started_at);
  const writtenSince = outputs.filter((o) => o.mtime !== null && Date.parse(o.mtime) >= startMs).length;
  const prev = store.lastSeen.get(rec.job_id);
  store.lastSeen.set(rec.job_id, { bytes: totalBytes, at: nowMs });

  const out: Record<string, unknown> = {
    ok: true,
    job_id: rec.job_id,
    state: rec.state,
    started_at: rec.started_at,
    ...(rec.finished_at ? { finished_at: rec.finished_at } : {}),
    elapsed_seconds: elapsedSeconds(rec, nowMs),
    max_hours: rec.max_hours,
    project_path: rec.project_path,
    items: rec.items.map((i) => ({ index: i.index, comp_id: i.comp_id, comp_name: i.comp_name })),
    outputs,
  };
  if (rec.only_item_indexes) out.only_item_indexes = rec.only_item_indexes;
  if (rec.restore && rec.restore.held.length > 0) {
    out.restore = rec.restore;
    if (rec.state === "running") {
      out.restore_note = `${rec.restore.held.length} other QUEUED item(s) are unchecked while this renders and are checked again when it ends.`;
    } else if (rec.restore.state === "restored") {
      out.restore_summary = restoreSummary(rec.restore);
    } else {
      // Items left = held and neither queued again nor found queued already; the state alone can say "partial" while some still need queuing.
      out.restore_pending = restoreLeft(rec.restore).length > 0;
      out.restore_summary = restoreSummary(rec.restore);
      out.restore_how = RESTORE_HOW;
    }
  }
  const gate = renderGate.active();
  if (gate) {
    out.gate = { job_id: gate.job_id, state: gate.state, ...(gate.cause ? { cause: gate.cause } : {}) };
    out.gate_note =
      "Other tools are refused while this gate is shut. If After Effects no longer renders and it does not clear, restarting After Effects clears it; " +
      "the user can also press Clear render lock in the Chroma AE MCP panel (shown only while the gate is shut).";
  }

  if (rec.engine === "media_encoder") out.engine = "media_encoder";
  if (rec.state === "handed_to_media_encoder" || rec.state === "queued_in_media_encoder") {
    // Per output file: did it grow since the last status call? (memory only; null on the first call)
    // Another extension of the same name that appeared or changed after the hand-over: AME's preset may write another format.
    const since = rec.handed_at ? Date.parse(rec.handed_at) : Date.parse(rec.started_at);
    let anyStale = false;
    out.outputs = outputs.map((o) => {
      const key = `${rec.job_id}|${o.item_index}|${o.module}`;
      const before = store.lastSeen.get(key);
      store.lastSeen.set(key, { bytes: o.bytes, at: nowMs });
      // A file older than the hand-over is the one from before (overwrite: true), not Media Encoder's result.
      const stale = o.exists && o.mtime !== null && Number.isFinite(since) && Date.parse(o.mtime) < since;
      if (stale) anyStale = true;
      return { ...o, grew_since_last_check: before ? o.bytes > before.bytes : null, ...(stale ? { stale: true } : {}) };
    });
    if (anyStale) {
      out.stale_note =
        "An output marked stale is OLDER than the hand-over: it is the file that was there before, not Media Encoder's result. Media Encoder does not overwrite: it may write the new file under another name (the name with _1, _2 added) or in another format, see other_extension_files. " +
        "Do not treat a stale file as the render.";
    }
    const others: Array<{ file: string; bytes: number; mtime: string }> = [];
    for (const it of rec.items) {
      for (const o of it.outputs) {
        for (const f of otherExtensionFiles(o.file, Number.isFinite(since) ? since : 0)) {
          if (others.length < 10) others.push(f);
        }
      }
    }
    if (others.length > 0) {
      out.other_extension_files = others;
      out.other_extension_note =
        "Files with the same name and another extension, or the same name with _1, _2 added (Media Encoder's way of not overwriting), appeared after the hand-over: Media Encoder may have used its own preset (another format) or avoided an existing file. Check them with ae_verify_render.";
    }
    out.files_written_since_start = writtenSince;
    if (rec.handed_at) out.handed_at = rec.handed_at;
    if (rec.summary) out.summary = rec.summary;
    if (rec.ame_item_statuses) out.item_statuses_after_hand_over = rec.ame_item_statuses;
    out.message = rec.state === "queued_in_media_encoder"
      ? "Queued in Adobe Media Encoder; it waits there until the user checks the preset and format and presses Start. Nothing may be rendering yet (the files below stay absent until then). After Effects is free and gets no progress, so this tool NEVER says the render finished. Once the user pressed Start, watch exists, bytes and grew_since_last_check, then confirm with ae_verify_render when a file stops growing."
      : "Handed to Adobe Media Encoder. After Effects is free and gets no progress from it, so this tool NEVER says the render finished. " +
      "Watch the output files: exists, bytes and grew_since_last_check (null on the first call; call again a little later). " +
      "Once a file exists and has stopped growing on two checks apart, confirm it with ae_verify_render (one real file or frame). Media Encoder's own window shows its queue.";
  } else if (rec.state === "running" && rec.engine === "media_encoder") {
    out.message =
      "The call that hands the queue to Adobe Media Encoder is still in progress (it normally returns in seconds). After Effects is NOT render-locked and other tools work. " +
      "If this stays running for long, the hand-over is stuck: look at Media Encoder's queue and at After Effects; nothing is resent.";
  } else if (rec.state === "running") {
    out.sign_of_life = {
      files_written_since_start: writtenSince,
      total_bytes: totalBytes,
      ...(prev ? { grew_since_last_check: totalBytes > prev.bytes, seconds_since_last_check: Math.round((nowMs - prev.at) / 1000) } : {}),
      note: "After Effects gives no percentage while it renders for a script. A new or growing output file is a sign of life, not progress; a movie may only be written at the end.",
    };
    out.message = "Rendering. Other tools can't reach After Effects until it ends; this tool does not touch it.";
    out.stop = STOP_TEXT;
  } else {
    if (rec.ok !== undefined) out.render_ok = rec.ok;
    if (rec.summary) out.summary = rec.summary;
    if (rec.error) out.error = rec.error;
    if (rec.note) out.note = rec.note;
    if (rec.result) {
      out.item_statuses = rec.result.item_statuses;
      if (rec.result.read_back_error) out.read_back_error = rec.result.read_back_error;
    }
    if (rec.state === "finished" || rec.state === "failed") {
      out.next =
        "Check one real output frame or file with ae_verify_render (path: a single existing file, with expect) once the gate is open; " +
        "an image sequence path with [#####] is not a file, so give one real frame such as the first.";
    }
  }

  if (includeDialogs) {
    try {
      const d = await rqrenderDeps.listDialogs({ screenshots: false });
      if (d.ok) out.dialogs = (d.dialogs ?? []).slice(0, 20);
      else out.dialogs_error = clip(d.error ?? "could not be read");
      if (d.ok && (d.dialogs?.length ?? 0) > 0) {
        out.dialogs_note = "A popup is open in After Effects. Read it with ae_dialogs; answer with ae_dialog_respond only under the user's rules. Never suppressed.";
      }
    } catch (err) {
      out.dialogs_error = clip(errMessage(err));
    }
  }
  return out;
}

// ---------- tools ----------

export const rqrenderTools: ToolDefinition<any>[] = [
  {
    name: "ae_render_queue_render",
    description:
      "Start After Effects' OWN render of the queued Render Queue items, the same as pressing Render, and return AT ONCE with a job id, the items and their output files. " +
      "Use it when `ae_aerender_start` fails or cannot be used (it never started on some machines), when the user asks for it, or for an UNSAVED or dirty project: it renders the open project exactly as it is now, no save needed. " +
      "Prefer `ae_aerender_start` when it works: this render keeps After Effects busy for its whole length, and the user cannot work in it. TELL THE USER FIRST that After Effects will be busy until the render ends, and on a dirty project ASK THEM TO SAVE FIRST: After Effects' UI is locked for the whole render and the Stop button cannot be reached (measured), so a render cannot be stopped short of ending After Effects. Keep these renders short. " +
      "NEVER ask the user to press Render in the Render Queue panel: call this instead. " +
      "While it renders After Effects cannot answer anything else: every other tool that needs AE (reads and writes, also ae_open_panel and ae_list_panels) is refused at once with a message saying so, and nothing is sent to it. " +
      "These keep working: `ae_render_queue_render_status` (state, elapsed, output files, any blocking popup; it never touches AE), `ae_dialogs`, `ae_dialog_respond`, `ae_diagnostics`; `ae_status` answers with the render state; `ae_ask_user` still queues its question for the panel but does not try to open the panel. Poll the status tool, not AE. " +
      "Works only inside the After Effects panel service (not the dev stdio server). If the panel service is reloaded during a render, its port stays closed until the render ends (the service waits for After Effects before it listens), and the job then reads `lost`. " +
      "Checked in one read before anything starts, and the call is refused with the reasons if: the queue is already rendering; no item is QUEUED; more than 100 items are QUEUED or the read was cut short; an item that is checked to render has no output (NEEDS_OUTPUT); an output module has no file; two outputs are the same file; a running aerender job or render batch is going to write the same file; its folder and that folder's parent do not exist (a missing folder under an existing parent only warns, since \"Save in subfolder\" can make it at render time; nothing is created); or an output file already exists (unless `overwrite: true`; nothing is ever deleted, and After Effects then asks \"<file> already exists. Overwrite?\" (OK / Cancel) for each and the render waits on it (measured, AE 26.3): OK there is a destructive answer that needs the user's instruction, and Cancel leaves the item QUEUED and the file as it was). " +
      "A queued aerender job or batch item is held (not started) while the render runs. " +
      "When the render call ends, a separate read gets every item's status (DONE, ERR_STOPPED, USER_STOPPED) and elapsed time, and the files on disk are checked; the job keeps the result. Then run `ae_verify_render` on one real output file or frame (not a [#####] path). If After Effects still reports rendering after the call returns, the gate stays shut and the read is repeated for up to 30 minutes, then the job reads unknown. " +
      "Before it starts it also checks the project's image sequences for missing frames and reads the GPU: the result may hold `sequence_check` (a warning, the render still starts; `sequence_check: \"block\"` refuses (also when the check could not finish), \"off\" skips) and `resource_warnings` (GPU nearly full, or another app such as Cinema 4D running). If `resource_warnings` is present, tell the user before continuing. " +
      "`max_hours` (1-48, default 12) is how long the call may take. At that limit the outcome is UNKNOWN: the job says so, nothing is resent or stopped, and tools stay refused until the panel service has nothing in flight again. If After Effects no longer renders and the lock does not clear, restarting After Effects clears it. " +
      `Stopping: ${STOP_TEXT} ` +
      "Jobs are kept on disk; if the service restarts during a render the job reads `lost` and you must look at After Effects. " +
      "`item_indexes` (with `comp_ids`) renders only those QUEUED items: without it After Effects renders EVERY QUEUED item. The other QUEUED items are unchecked just before and checked again after the render (also when it failed or was stopped); the status lists what was restored and what could not be (moved, deleted, changed). When After Effects cannot be asked afterwards (the outcome is unknown, the job is lost after a restart, or the restore itself failed or timed out) they STAY unchecked: the job record keeps them, the status and every later render call list them as pending_restores with restore_how, and a new item_indexes render is refused (restore_pending) until they are queued again. " +
      "`engine: \"media_encoder\"` (opt-in, per render): puts the queue in Adobe Media Encoder (RenderQueue.queueInAME) so After Effects stays FREE: no render gate, the call returns in seconds, other tools keep working. Offer it ONLY when `ae_aerender_start` did not start, a long render would lock After Effects, or a long H.264 render (one ran After Effects out of memory); ASK THE USER first and pass `user_confirmed: true` only after they agree (say: AE stays free; Media Encoder renders the SAVED project so later changes are not in it; it may take a moment to open). By default (`start_now` false) the items only WAIT in Media Encoder's queue (state `queued_in_media_encoder`): tell the user to check the preset and format there and press Start, because Media Encoder applies its LAST-used preset, not the output module's (measured 2026-11-08: ProRes 4444 .mov instead of the module's H.264 .mp4). After the hand-over AE unchecks the handed items a moment later (they read UNQUEUED), while a read right after it still says QUEUED. `start_now: true` starts EVERY item waiting in Media Encoder's queue, including the user's own, with its last preset, so it is refused (`whole_ame_queue_not_confirmed`) unless `whole_ame_queue_ok: true` is also passed after the user agreed to that; prefer the default. Refused without `user_confirmed`, when Media Encoder is not installed (`ame_not_installed`: no folder in the usual Adobe places or next to After Effects' own install folder), with unsaved changes (ae_save first), when `canQueueInAME` is false/missing, or with `item_indexes` (`item_indexes_with_media_encoder`: the hold and restore would change the project that was just checked as saved; queue only the wanted item with ae_render_queue_edit, save, then hand over); the same output, folder and sequence checks apply. If the hand-over call times out the answer says started \"unknown\" (`ame_handover_unknown`): do not call again, look at Media Encoder and After Effects. Progress is unknown to After Effects: `ae_render_queue_render_status` reports `handed_to_media_encoder` and each file's exists/bytes/grew_since_last_check, never \"finished\"; confirm with `ae_verify_render` once the file stops growing. The status also lists files with the same name and another extension that appeared after the hand-over. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueRenderSchema,
    handler: async (args: RenderArgs, ctx: ToolContext) => {
      ctx.quarantine.assertClear();
      const viaAme = args.engine === "media_encoder";
      if (viaAme && args.user_confirmed !== true) {
        return {
          ok: false,
          started: false,
          engine: "media_encoder",
          refused: [{ code: "user_confirmation_needed", message: `Rendering in Adobe Media Encoder needs the user's OK for this render. Nothing was started. ${AME_REFUSAL_ASK}` }],
          warnings: [AME_PRESET_WARNING + " The result will name the preset Media Encoder holds when it can be read, and the format each output module asked for."],
        };
      }
      if (viaAme && args.start_now === true && args.whole_ame_queue_ok !== true) {
        return {
          ok: false,
          started: false,
          engine: "media_encoder",
          refused: [
            {
              code: "whole_ame_queue_not_confirmed",
              message:
                "start_now: true starts EVERY item waiting in Media Encoder's queue, including items the user queued there themselves (measured 2026-11-08: an item the user had left there earlier was in the queue), each with Media Encoder's last-used preset. Nothing was started. Leave start_now off (the items wait and the user presses Start after checking the preset and format), or ask the user and pass whole_ame_queue_ok: true.",
            },
          ],
        };
      }
      if (viaAme && args.item_indexes) {
        return {
          ok: false,
          started: false,
          engine: "media_encoder",
          refused: [
            {
              code: "item_indexes_with_media_encoder",
              message:
                "item_indexes cannot be combined with engine media_encoder for now: holding the other items back and putting them back change the project (two undo groups) right after it was checked as saved, so the next Media Encoder call would need a save again. " +
                "Queue only the wanted item(s) with ae_render_queue_edit (queued true/false), save with ae_save, then call again without item_indexes. Nothing was started.",
            },
          ],
        };
      }
      // Checked on disk now; if the usual folders do not have it, the After Effects install folder is checked after rqeditAmeState (a custom install location).
      const ameInUsualPlace = viaAme ? rqrenderDeps.ameInstalled() : true;
      if (!viaAme && !ctx.serviceInfo) {
        return {
          ok: false,
          started: false,
          refused: [
            {
              code: "not_in_panel",
              message:
                "This tool runs only inside the After Effects panel service. The dev stdio server reaches the panel with fetch, whose 300 s timeout would read a long render as unreachable and lift the render gate mid-render. Nothing was started.",
            },
          ],
        };
      }
      const store = storeFor(ctx);
      bindJobFailureLog(store, ctx.log);
      const gate = renderGate.active();
      if (gate) {
        return { ok: false, started: false, refused: [{ code: "already_rendering", message: renderGateMessage(gate) }], job_id: gate.job_id };
      }
      const maxHours = args.max_hours ?? 12;
      const opId = ctx.bridge.newOpId();
      // Before the lease: the probe takes about a second and must not hold the queue.
      const resourceWarnings = await resourceWarningsForRender();
      let lease: QueueLease;
      try {
        lease = await ctx.queue.acquire("ae_render_queue_render");
      } catch (err) {
        if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        throw err;
      }
      let handedOff = false;
      try {
        const guard = await verifyTargetGuard(ctx, args.expect, opId);
        if (viaAme && (guard.project_path === undefined || guard.project_path === "<unsaved>" || guard.dirty !== false)) {
          return {
            ok: false,
            started: false,
            engine: "media_encoder",
            refused: [
              {
                code: "project_unsaved",
                message:
                  guard.project_path === "<unsaved>" || guard.project_path === undefined
                    ? "The project has never been saved, and Media Encoder reads the saved file. Save it with ae_save first. Nothing was started."
                    : "The project has unsaved changes (or After Effects would not say), and Media Encoder reads the saved file, so they would not be in the render. Save first with ae_save, then call again. Nothing was started.",
              },
            ],
          };
        }
        const readRes = await ctx.bridge.evalRaw<QueueRead>({
          id: `${opId}_read`,
          script: buildJsxCall("rqeditRead", { settings: false }),
          label: "ae_render_queue_render (read)",
          mutates: false,
          toolName: "ae_render_queue_render",
        });
        let live: LiveOutput[] = [];
        try {
          live = rqrenderDeps.liveOutputs();
        } catch {
          live = [];
        }
        const only: OnlyItems | undefined = args.item_indexes ? { indexes: args.item_indexes, ...(args.comp_ids ? { comp_ids: args.comp_ids } : {}) } : undefined;
        if (!only && args.comp_ids) {
          return { ok: false, started: false, refused: [{ code: "bad_item_indexes", message: "comp_ids needs item_indexes. Nothing was started." }] };
        }
        if (only?.comp_ids && only.comp_ids.length !== only.indexes.length) {
          return {
            ok: false,
            started: false,
            refused: [{ code: "bad_item_indexes", message: `comp_ids has ${only.comp_ids.length} entries but item_indexes has ${only.indexes.length}: give one comp id per index, in the same order. Nothing was started.` }],
          };
        }
        const plan = planStart(readRes.result ?? null, args.overwrite === true, live, only);
        if (plan.refusals.length > 0) {
          return {
            ok: false,
            started: false,
            refused: plan.refusals,
            message: "Nothing was started. Fix the reasons above and call again.",
          };
        }
        // Items an earlier job unchecked and never queued again: a new item_indexes render would take them for the user's own UNQUEUED items.
        const waiting = stillWaitingRestores(store, readRes.result ?? null);
        if (only && waiting.length > 0) {
          return {
            ok: false,
            started: false,
            refused: [
              {
                code: "restore_pending",
                message:
                  "An earlier render job unchecked other QUEUED items and they were never queued again (see pending_restores). With item_indexes they would be taken for items you left UNQUEUED and stay out of this render for good. " +
                  "Queue them again first (restore_how), or render without item_indexes. Nothing was started.",
              },
            ],
            ...pendingRestoresOut(waiting),
          };
        }
        const pendingExtra = pendingRestoresOut(waiting);
        // Image sequences with missing frames: a warning by default, a refusal only with sequence_check "block".
        const seq = await runSequenceCheck(ctx, args.sequence_check, { opId, toolName: "ae_render_queue_render", liveDirs: dirsOfFiles(live.map((l) => l.file)) });
        if (seq.block && seq.check) {
          return {
            ok: false,
            started: false,
            refused: [{ code: blockCode(seq.check), message: sequenceBlockMessage("ae_render_queue_render", seq.check) }],
            sequence_check: seq.check,
            message: seq.check.with_gaps > 0 ? "Nothing was started. Fix the missing frames, or call again with sequence_check \"warn\" or \"off\"." : "Nothing was started. The sequence check could not finish; try again, or call again with sequence_check \"warn\" or \"off\".",
          };
        }

        if (viaAme) {
          // canQueueInAME is true only with QUEUED items and an available AME command; a missing property means an old or odd AE.
          const ameRes = await ctx.bridge.evalRaw<{ can_queue_in_ame: boolean | null; has_queue_in_ame?: boolean; app_path?: string | null }>({
            id: `${opId}_ame_state`,
            script: buildJsxCall("rqeditAmeState", {}),
            label: "ae_render_queue_render (can the queue go to Media Encoder)",
            mutates: false,
            toolName: "ae_render_queue_render",
          });
          if (!ameInUsualPlace && !rqrenderDeps.ameNearApp(ameRes.result?.app_path)) {
            return {
              ok: false,
              started: false,
              engine: "media_encoder",
              refused: [
                {
                  code: "ame_not_installed",
                  message:
                    "Adobe Media Encoder does not seem to be installed: no \"Adobe Media Encoder*\" folder under C:\\Program Files\\Adobe, in /Applications, or next to After Effects' own install folder" +
                    (ameRes.result?.app_path ? ` (${ameRes.result.app_path})` : "") +
                    ". Nothing was started. Render inside After Effects instead (engine after_effects).",
                },
              ],
            };
          }
          const can = ameRes.result?.can_queue_in_ame;
          if (can !== true) {
            return {
              ok: false,
              started: false,
              engine: "media_encoder",
              refused: [
                {
                  code: "ame_unavailable",
                  message:
                    can === false
                      ? "After Effects says renderQueue.canQueueInAME is false: Adobe Media Encoder cannot take the queue (it is not installed or not available to this After Effects, or no item is QUEUED). Nothing was started. Render inside After Effects instead (engine after_effects) or install Media Encoder."
                      : "This After Effects has no renderQueue.canQueueInAME (it needs After Effects 14.0 / CC 2017 or later), so the queue cannot go to Media Encoder. Nothing was started. Render inside After Effects instead.",
                },
              ],
            };
          }
        }

        const jobId = `rqjob_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const startedAt = new Date().toISOString();
        const projectPath = guard.project_path ?? args.expect.project_path;
        store.create({
          job_id: jobId,
          op_id: opId,
          state: "running",
          started_at: startedAt,
          max_hours: maxHours,
          project_path: projectPath,
          overwrite: args.overwrite === true,
          ...(viaAme ? { engine: "media_encoder" as const } : {}),
          items: plan.items,
          ...(only ? { only_item_indexes: plan.items.map((i) => i.index) } : {}),
          // Written BEFORE anything is unchecked, so a crash between the write and the render still leaves the list.
          ...(plan.hold.length > 0 ? { restore: { state: "pending" as const, held: plan.hold, restored: [], not_restored: [] } } : {}),
        });
        if (plan.hold.length > 0) {
          const refusal = await holdOrRefuse(ctx, store, jobId, opId, plan, readRes.result?.numItems);
          if (refusal) return refusal;
        }
        if (viaAme) {
          // No gate: the call returns at once and After Effects stays free.
          return { ...(await handOffToMediaEncoder({ ctx, store, jobId, opId, plan, maxHours, startNow: args.start_now === true })), ...pendingExtra };
        }
        // From here the gate is shut: waiting tools are dropped now, later ones are refused at the door.
        const info = { job_id: jobId, op_id: opId, started_at: startedAt };
        beginRenderGate(store, info, lease);
        ctx.queue.rejectWaiting(() => new BridgeError({ kind: "queued", message: renderGateMessage({ ...info, state: "rendering" }) }));
        const timeoutMs = renderTimeoutMs(maxHours);
        handedOff = true;
        const run = runRenderJob({ ctx, store, jobId, opId, lease, timeoutMs, items: plan.items, ...(only ? { expectedQueued: plan.items.length } : {}) });
        store.trackSettled(jobId, run);
        void run.catch(() => undefined);

        return {
          ok: true,
          started: true,
          job_id: jobId,
          state: "running",
          started_at: startedAt,
          max_hours: maxHours,
          project_path: projectPath,
          renders: "the open project exactly as it is now (unsaved or dirty changes included)",
          items: plan.items,
          ...(plan.hold.length > 0
            ? {
                held_back: plan.hold,
                held_back_note: `Only the item(s) above render. ${plan.hold.length} other QUEUED item(s) are unchecked now and checked again when the render ends, also if it fails or is stopped; if After Effects cannot be asked then (unknown or lost outcome) they stay unchecked and ae_render_queue_render_status gives pending_restores / restore_how. ae_render_queue_render_status reports what was restored.`,
              }
            : {}),
          ...(plan.warnings.length > 0 || seq.warnings.length > 0 ? { warnings: [...plan.warnings, ...seq.warnings] } : {}),
          ...(seq.check ? { sequence_check: seq.check } : {}),
          ...(resourceWarnings.length > 0 ? { resource_warnings: resourceWarnings } : {}),
          ...pendingExtra,
          note:
            "The render runs in After Effects in the background of this call. After Effects is busy until it ends and the user cannot work in it; every other AE tool is refused meanwhile. " +
            "Poll ae_render_queue_render_status (it never touches AE). " +
            STOP_TEXT,
        };
      } finally {
        if (!handedOff) lease.release();
      }
    },
  },
  {
    name: "ae_render_queue_render_status",
    description:
      "Where a render started by ae_render_queue_render is: state (running, finished, failed, unknown, lost), elapsed time, and for every output file whether it exists, its bytes and mtime and, for an image sequence, the frame count; plus any popup blocking After Effects (screenshots are not taken). " +
      "It NEVER touches After Effects (no evalScript), so it answers during the render. While it renders, After Effects gives no percentage: a new or growing file is a sign of life, not progress. " +
      "For a job in Media Encoder (`queued_in_media_encoder` or `handed_to_media_encoder`) it lists each output's exists, bytes and `grew_since_last_check` and never claims it finished: confirm with ae_verify_render once the file stops growing. After the end of an AE render it gives each item's status (DONE, ERR_STOPPED, USER_STOPPED), its elapsed time and a verdict, and suggests ae_verify_render. A job `lost` was cut off by a service restart: look at After Effects. `unknown` means the render call hit its time limit, its read-back timed out, or After Effects kept reporting that it renders. While the gate is shut the answer says that restarting After Effects clears it if AE no longer renders. Changes nothing. " +
      "`wait_seconds` (0-30, default 0) waits for the job's state (or restore state) to change before answering (an output file appearing does not end the wait for an After Effects job, since the file exists long before the render is over; for a Media Encoder job, whose state never changes, it does) (the reply has `waited_ms`): one call with wait_seconds replaces several polls. It never touches After Effects and holds neither the AE queue nor the render lock.",
    schema: AeRenderQueueRenderStatusSchema,
    handler: async (args: StatusArgs, ctx: ToolContext) => {
      const store = storeFor(ctx);
      bindJobFailureLog(store, ctx.log);
      const rec = args.job_id ? store.get(args.job_id) : store.latest();
      if (!rec) {
        return {
          ok: false,
          error: args.job_id ? "unknown_job" : "no_jobs",
          message: args.job_id ? `No render job ${args.job_id}.` : "No render has been started with ae_render_queue_render yet.",
          ...(renderGate.active() ? { gate: renderGate.active() } : {}),
        };
      }
      // Waits for a change from what the job was when this call came in; holds neither the AE queue nor the lease.
      const waited = await waitForJob(store, rec.job_id, args.wait_seconds);
      const current = store.get(rec.job_id) ?? rec;
      const described = await describeJob(ctx, store, current, args.include_dialogs !== false);
      if (waited) described.waited_ms = waited.waited_ms;
      if (args.job_id) return described;
      // Without a job id the newest job is shown: an earlier job's unfinished restore must not be hidden behind it.
      const others = store.pendingRestores().filter((p) => p.job_id !== current.job_id);
      return { ...described, ...pendingRestoresOut(others) };
    },
  },
];
