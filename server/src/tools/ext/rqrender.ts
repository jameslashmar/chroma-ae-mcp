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
import { AGENT_SAFETY_GUIDANCE, dataDirOf, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { getDefaultAerenderRegistry, type AerenderJobRegistry } from "./aerender.js";
import { listBlockingDialogs } from "./dialogs.js";
import { BatchStore, outputsOf } from "./renderbatch.js";
import { pathKey, type ItemRead, type QueueRead } from "./rqedit.js";
import { noteUiWrite } from "./session.js";

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
  "The user stops it with the Stop button in After Effects' Render Queue panel; the item then reads USER_STOPPED. " +
  "A script can stop a render only from an onStatusChanged or app.onError callback set up before render() starts (RenderQueue.stopRendering, AE Scripting Guide); this tool sets none up, so it cannot stop the render, and render() does not return until the render is over. " +
  "Whether After Effects' UI stays clickable during a render started by script is not measured, so on a dirty project ask the user to save first.";

// ---------- job record ----------

export type RenderJobState = "running" | "finished" | "failed" | "unknown" | "lost";

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

// ---------- the job store (JSON on disk, mirrored synchronously) ----------

export class RenderJobStore {
  private readonly jobs = new Map<string, RenderJobRecord>();
  private readonly settled = new Map<string, Promise<void>>();
  /** Sizes seen by the last status call, to say whether files grew since. Memory only. */
  readonly lastSeen = new Map<string, { bytes: number; at: number }>();

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
        if (rec.state === "running") {
          rec.state = "lost";
          rec.finished_at = new Date().toISOString();
          rec.note =
            "The panel service restarted while this render was running, so nobody is tracking it any more. " +
            "After Effects may still be rendering, or may have finished or stopped: look at After Effects' Render Queue panel and at the output files. Nothing was resent.";
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
      const keep = this.list().slice(-MAX_JOBS_KEPT);
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
    this.jobs.set(jobId, { ...cur, ...patch, job_id: cur.job_id });
    this.save();
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
  readBackTimeoutMs: READ_BACK_TIMEOUT_MS,
  stillRenderingMaxMs: STILL_RENDERING_MAX_MS,
  stillRenderingPollMs: STILL_RENDERING_POLL_MS,
};

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
export function planStart(queue: QueueRead | null, overwrite: boolean, live: LiveOutput[] = []): StartPlan {
  const refusals: StartRefusal[] = [];
  const warnings: string[] = [];
  const items: JobItem[] = [];
  if (!queue) {
    return {
      items,
      refusals: [{ code: "nothing_queued", message: "The Render Queue could not be read." }],
      warnings,
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
  const queued = queue.items.filter((i: ItemRead) => i.status === "queued");
  for (const it of queue.items) {
    if (it.status === "needs_output" && it.render === true) {
      refusals.push({
        code: "needs_output",
        item_index: it.index,
        message: `Render Queue item ${it.index} (${it.comp_name ?? "comp " + it.comp_id}) is checked to render but has no output (NEEDS_OUTPUT), so Render would stop at it. Give it an output file with ae_render_queue_edit (output_modules[].file) or uncheck it. Nothing was started.`,
      });
    }
  }
  if (queued.length === 0) {
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
          message: `${where}: ${sequence ? `${stat.frame_count} frame(s) of ${m.file} already exist` : `${m.file} already exists`}. Nothing is deleted. Change the file, or pass overwrite: true (whether After Effects then prompts or silently overwrites is not measured).`,
        });
      }
      job.outputs.push({ item_index: it.index, comp_id: it.comp_id, module: m.index, file: m.file, sequence });
    }
    items.push(job);
  }
  return { items, refusals, warnings };
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
  overwrite: z.boolean().optional().describe("Allow output files that already exist. Default false: the call is refused if any queued output already exists. Nothing is ever deleted by this tool; whether After Effects then prompts or silently overwrites is not measured."),
  expect: ExpectSchema,
});

export const AeRenderQueueRenderStatusSchema = z.object({
  job_id: z.string().min(1).max(100).optional().describe("A job id from ae_render_queue_render. Default: the running job, else the newest."),
  include_dialogs: z.boolean().default(true).optional().describe("Also list popups blocking After Effects (read from outside AE; screenshots are not taken). Default true."),
});

type RenderArgs = z.infer<typeof AeRenderQueueRenderSchema>;
type StatusArgs = z.infer<typeof AeRenderQueueRenderStatusSchema>;

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
}

/**
 * Sends the long render eval, then reads the result. Never throws: every
 * failure goes into the job record. Releases the lease; opens the gate unless
 * the render's outcome is unknown (then the gate stays shut).
 */
export async function runRenderJob(p: RunParams): Promise<void> {
  const { ctx, store, jobId, opId, items } = p;
  let keepGate = false;
  try {
    // The tool's reply goes out first; the call that keeps After Effects busy starts one macrotask later.
    await rqrenderDeps.defer();
    let evalProblem: { kind: string; message: string } | null = null;
    try {
      await ctx.bridge.evalRaw({
        id: opId,
        script: buildJsxCall("rqeditRender", {}),
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

    const judged = judgeResult(items, read, readBackError);
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
    if (evalProblem) {
      store.update(jobId, {
        state: "failed",
        finished_at: new Date().toISOString(),
        ok: false,
        error: clip(evalProblem.message),
        summary: `After Effects raised an error from the render call: ${clip(evalProblem.message)}. ${judged.summary}`,
        result: judged.result,
      });
    } else {
      store.update(jobId, { state: "finished", finished_at: new Date().toISOString(), ok: judged.ok, summary: judged.summary, result: judged.result });
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

// ---------- status ----------

function elapsedSeconds(rec: RenderJobRecord, nowMs: number): number {
  const start = Date.parse(rec.started_at);
  const end = rec.state === "running" || !rec.finished_at ? nowMs : Date.parse(rec.finished_at);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
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
  const gate = renderGate.active();
  if (gate) {
    out.gate = { job_id: gate.job_id, state: gate.state, ...(gate.cause ? { cause: gate.cause } : {}) };
    out.gate_note =
      "Other tools are refused while this gate is shut. If After Effects no longer renders and it does not clear, restarting After Effects clears it; " +
      "the user can also press Clear render lock in the Chroma AE MCP panel (shown only while the gate is shut).";
  }

  if (rec.state === "running") {
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
      "Prefer `ae_aerender_start` when it works: this render keeps After Effects busy for its whole length, and the user cannot work in it. TELL THE USER FIRST that After Effects will be busy until the render ends, and on a dirty project ASK THEM TO SAVE FIRST (the Stop button's behaviour is not measured). " +
      "NEVER ask the user to press Render in the Render Queue panel: call this instead. " +
      "While it renders After Effects cannot answer anything else: every other tool that needs AE (reads and writes, also ae_open_panel and ae_list_panels) is refused at once with a message saying so, and nothing is sent to it. " +
      "These keep working: `ae_render_queue_render_status` (state, elapsed, output files, any blocking popup; it never touches AE), `ae_dialogs`, `ae_dialog_respond`, `ae_diagnostics`; `ae_status` answers with the render state; `ae_ask_user` still queues its question for the panel but does not try to open the panel. Poll the status tool, not AE. " +
      "Works only inside the After Effects panel service (not the dev stdio server). If the panel service is reloaded during a render, its port stays closed until the render ends (the service waits for After Effects before it listens), and the job then reads `lost`. " +
      "Checked in one read before anything starts, and the call is refused with the reasons if: the queue is already rendering; no item is QUEUED; more than 100 items are QUEUED or the read was cut short; an item that is checked to render has no output (NEEDS_OUTPUT); an output module has no file; two outputs are the same file; a running aerender job or render batch is going to write the same file; its folder and that folder's parent do not exist (a missing folder under an existing parent only warns, since \"Save in subfolder\" can make it at render time; nothing is created); or an output file already exists (unless `overwrite: true`; nothing is ever deleted, and whether After Effects then prompts is not measured). " +
      "A queued aerender job or batch item is held (not started) while the render runs. " +
      "When the render call ends, a separate read gets every item's status (DONE, ERR_STOPPED, USER_STOPPED) and elapsed time, and the files on disk are checked; the job keeps the result. Then run `ae_verify_render` on one real output file or frame (not a [#####] path). If After Effects still reports rendering after the call returns, the gate stays shut and the read is repeated for up to 30 minutes, then the job reads unknown. " +
      "`max_hours` (1-48, default 12) is how long the call may take. At that limit the outcome is UNKNOWN: the job says so, nothing is resent or stopped, and tools stay refused until the panel service has nothing in flight again. If After Effects no longer renders and the lock does not clear, restarting After Effects clears it. " +
      `Stopping: ${STOP_TEXT} ` +
      "Jobs are kept on disk; if the service restarts during a render the job reads `lost` and you must look at After Effects. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueRenderSchema,
    handler: async (args: RenderArgs, ctx: ToolContext) => {
      ctx.quarantine.assertClear();
      if (!ctx.serviceInfo) {
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
      const gate = renderGate.active();
      if (gate) {
        return { ok: false, started: false, refused: [{ code: "already_rendering", message: renderGateMessage(gate) }], job_id: gate.job_id };
      }
      const maxHours = args.max_hours ?? 12;
      const opId = ctx.bridge.newOpId();
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
        const plan = planStart(readRes.result ?? null, args.overwrite === true, live);
        if (plan.refusals.length > 0) {
          return {
            ok: false,
            started: false,
            refused: plan.refusals,
            message: "Nothing was started. Fix the reasons above and call again.",
          };
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
          items: plan.items,
        });
        // From here the gate is shut: waiting tools are dropped now, later ones are refused at the door.
        const info = { job_id: jobId, op_id: opId, started_at: startedAt };
        beginRenderGate(store, info, lease);
        ctx.queue.rejectWaiting(() => new BridgeError({ kind: "queued", message: renderGateMessage({ ...info, state: "rendering" }) }));
        const timeoutMs = renderTimeoutMs(maxHours);
        handedOff = true;
        const run = runRenderJob({ ctx, store, jobId, opId, lease, timeoutMs, items: plan.items });
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
          ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
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
      "After the end it gives each item's status (DONE, ERR_STOPPED, USER_STOPPED), its elapsed time and a verdict, and suggests ae_verify_render. A job `lost` was cut off by a service restart: look at After Effects. `unknown` means the render call hit its time limit, its read-back timed out, or After Effects kept reporting that it renders. While the gate is shut the answer says that restarting After Effects clears it if AE no longer renders. Changes nothing.",
    schema: AeRenderQueueRenderStatusSchema,
    handler: async (args: StatusArgs, ctx: ToolContext) => {
      const store = storeFor(ctx);
      const rec = args.job_id ? store.get(args.job_id) : store.latest();
      if (!rec) {
        return {
          ok: false,
          error: args.job_id ? "unknown_job" : "no_jobs",
          message: args.job_id ? `No render job ${args.job_id}.` : "No render has been started with ae_render_queue_render yet.",
          ...(renderGate.active() ? { gate: renderGate.active() } : {}),
        };
      }
      return describeJob(ctx, store, rec, args.include_dialogs !== false);
    },
  },
];
