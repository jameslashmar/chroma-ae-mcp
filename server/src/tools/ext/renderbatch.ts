/**
 * server/src/tools/ext/renderbatch.ts
 *
 * Render batches: one job (comps x specs) becomes many aerender runs, one
 * after another from a frozen copy of the saved project.
 * - ae_render_batch_plan: read-only dry run. Expands the job, checks comp
 *   names are unique, template names exist, outputs don't collide or sit in
 *   _mcp_backups / _mcp_checkpoints, and reports free space.
 * - ae_render_batch: guards the open project, optionally runs the
 *   delivery preflight, copies the saved .aep into the batch folder and
 *   starts a background runner that renders the items.
 * - ae_render_batch_status: state, per-item progress, ETA, stall warnings.
 * - ae_render_batch_resume: continues a stopped or interrupted batch, keeping
 *   items whose output still verifies.
 * - ae_render_batch_cancel: stops the running aerender processes and the batch.
 *
 * A job can also name existing Render Queue items (queue_items: { rq_index,
 * item_comp_id }): each renders through aerender -rqindex with all its output
 * modules and its own settings, and the plan and the governor count every
 * output file. The frozen copy holds the queue as saved, so the project must be
 * saved and not dirty; each index is checked (comp id, QUEUED, outputs) against
 * the live queue of that clean project when the batch starts.
 *
 * Nothing here changes the After Effects project: the renders run in aerender
 * child processes on the Node side and the runner never takes the eval queue.
 * The state lives in <renders dir>/batches/<batch id>/batch.json.
 *
 * The governor, before every item starts: the output volume's free space
 * (PowerShell Get-PSDrive on Windows, df elsewhere; a UNC path is reported
 * "unknown", never "ok"), a file that would be overwritten (recent files are
 * protected, _mcp_backups / _mcp_checkpoints never are written to), and, while
 * an item runs, a stall detector that only advises ae_aerender_cancel.
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall, pathsMatchForGuard } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import {
  cancelAerenderJob,
  type CancelHooks,
  getDefaultAerenderRegistry,
  isAerenderProcess,
  itemOutputs,
  pidHeldByLiveJob,
  launchAerenderJob,
  parseAerenderProgress,
  readLogTail,
  resolveAerenderPath,
  selectRqItem,
  type AerenderJobRecord,
  type AerenderJobRegistry,
  type RqItemRead,
  type SpawnLike,
} from "./aerender.js";
import { preflightRefusal, runPreflightGate, type GateSummary } from "./preflight.js";

const MAX_ITEMS = 500;
const MAX_STRING = 20_000;
const GIB = 1024 * 1024 * 1024;
/** Clock slop when judging "written after the item started" (file systems round mtimes). */
const MTIME_SLOP_MS = 2000;

// ---------- schemas ----------

const TOKENS = ["comp", "spec", "date", "n"];
const WIN_OR_POSIX_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\|\/)/;

export const BatchSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9._-]+$/, "Spec names use letters, digits, '.', '_' and '-' only (they go into file names).")
    .describe(
      "Short name of this render spec, e.g. 'h264' or 'prores'. It fills the {spec} token in the file name. This is a free-form label, not an ae_delivery_specs id: a name like 'youtube_1080p' here does not apply that spec's resize, channels or audio."
    ),
  render_settings_template: z
    .string()
    .min(1)
    .optional()
    .describe("Render Settings template name (aerender -RStemplate). Omit to use the settings of the comp's queued render-queue item when it has one (the plan reports it), otherwise After Effects' defaults."),
  output_module_template: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Output Module template name (aerender -OMtemplate), e.g. the installed template an ae_delivery_specs entry names. Omit to use the output module of the comp's queued render-queue item when it has one, otherwise After Effects' default (H.264 in recent versions). A size change needs a reframed comp or a template that resizes."
    ),
  extension: z
    .string()
    .regex(/^[A-Za-z0-9]{1,8}$/, "Extension without the dot, e.g. 'mp4'.")
    .optional()
    .describe("File extension for this spec, without the dot. It must match what the Output Module template writes. Falls back to the job's extension. A spec with no output_module_template and no extension (here or on the job) is refused: the plan would have to guess the file name."),
  sequence: z
    .boolean()
    .optional()
    .describe("The spec writes an image sequence: the file name gets a [#####] frame token (name.[#####].png) and the result is verified as a set of numbered files."),
});

export type BatchSpec = z.infer<typeof BatchSpecSchema>;

export const BatchQueueItemSchema = z.object({
  rq_index: z.number().int().min(1).max(500).describe("1-based Render Queue index of the item to render (aerender -rqindex). It renders with all its output modules and its own settings."),
  item_comp_id: z.number().int().describe("The CompItem id the item at rq_index must have (ae_render_queue_inspect shows it). The plan and the start refuse when the item there is another comp: indexes shift when the queue changes."),
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9._-]+$/, "Names use letters, digits, '.', '_' and '-' only.")
    .optional()
    .describe("Label for this item in the plan and status (default 'rq<index>')."),
});

export type BatchQueueItem = z.infer<typeof BatchQueueItemSchema>;

const jobFields = {
  comps: z
    .array(z.string().min(1).max(255))
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Names of the comps to render. aerender selects a comp by name, so each name must belong to exactly one comp in the project. For other sizes, make the copies first with ae_reframe and list their names here: a size is just another comp. Give comps, queue_items or both."
    ),
  queue_items: z
    .array(BatchQueueItemSchema)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Existing Render Queue items to render through aerender -rqindex, each with ALL its output modules (H.264 + ProRes + PNG built with ae_render_queue_edit / _duplicate / _apply_spec) and its own render settings; specs, name_template, extension and time_span do not apply to them (the item holds its output files and time span). Every output file is counted in the overwrite check, and free space is measured on the volume of each item's output modules (output_dir is not used for them). Needs a saved, not dirty project and each item QUEUED with its comp id matching item_comp_id. Item outputs may not sit in _mcp_backups / _mcp_checkpoints."
    ),
  specs: z
    .array(BatchSpecSchema)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Render specs: free-form {name, render_settings_template, output_module_template, extension, sequence} objects, not ae_delivery_specs ids (those carry a resize, channels and audio that aerender cannot apply here; pass the installed template an entry names as output_module_template). Every comp is rendered once per spec. Omit for one render per comp with After Effects' default templates (or the comp's queued item); an extension is then required."
    ),
  output_dir: z.string().min(1).describe("Absolute folder the renders go into (created when missing). Never a folder named _mcp_backups or _mcp_checkpoints."),
  name_template: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("File name without extension, with tokens {comp}, {spec}, {date} (YYYYMMDD) and {n} (item number, two digits). Default '{comp}_{spec}'. Characters Windows forbids in file names become '_'."),
  extension: z
    .string()
    .regex(/^[A-Za-z0-9]{1,8}$/, "Extension without the dot, e.g. 'mov'.")
    .optional()
    .describe("Default file extension, without the dot, for specs that give none ('mov' is the name guessed when this is left out, and the plan refuses that for a spec without an output_module_template). A spec's own extension wins."),
  time_span: z
    .enum(["comp", "work_area", "template"])
    .optional()
    .describe(
      "Which frames each item renders. 'comp' (default) passes -s/-e for the whole comp; 'work_area' for the comp's work area; 'template' passes neither and lets the render-settings template decide (the ETA then uses the comp length as a guess)."
    ),
};

const policyFields = {
  if_output_exists: z
    .enum(["protect_recent", "skip", "overwrite"])
    .optional()
    .describe(
      "What to do when an output file already exists. 'protect_recent' (default) refuses an item whose file was written in the last protect_recent_minutes and overwrites older ones; 'skip' leaves any existing non-empty file alone and marks the item skipped (a partial file left by this batch's own earlier attempt is not left alone: that item renders again); 'overwrite' always renders. A file in _mcp_backups / _mcp_checkpoints is never written."
    ),
  protect_recent_minutes: z.number().int().min(1).max(100_000).optional().describe("How recent counts as 'recent' for protect_recent. Default 60."),
  min_free_gb: z.number().min(0).max(100_000).optional().describe("Free space (GB) that must remain on the output volume after an item's estimated size. Default 2."),
  on_unknown_space: z
    .enum(["continue", "stop"])
    .optional()
    .describe("When free space can't be measured (a UNC path or a failed lookup): 'continue' (default) renders and flags it, 'stop' blocks the item. Unknown is never reported as ok."),
};

const runFields = {
  concurrency: z.number().int().min(1).max(4).optional().describe("aerender processes at once. Default 1, so the live After Effects session isn't starved. The limit counts every aerender job this server runs (other batches and ae_aerender_start jobs too); an item waits while the limit is used up."),
  max_cpu_percent: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Share of the CPU for the whole batch, split evenly over the concurrent aerender processes (each gets floor(max_cpu_percent / concurrency), at least 1, as aerender -mfr ON <percent>, After Effects 22+). Default 50. How far -mfr limits the CPU is not measured."
    ),
  on_error: z.enum(["stop", "continue"]).optional().describe("A failed item stops the batch ('stop', default; resume retries it) or the batch goes on with the next item ('continue')."),
  stall_minutes: z.number().int().min(1).max(10_000).optional().describe("Minutes without log or output growth before a running item is flagged as stalled (advice only, nothing is cancelled). Default 15."),
};

function refineJob(
  val: { comps?: string[]; queue_items?: BatchQueueItem[]; specs?: BatchSpec[]; output_dir: string; name_template?: string },
  ctx: z.RefinementCtx
): void {
  const comps = val.comps ?? [];
  const queueItems = val.queue_items ?? [];
  if (comps.length === 0 && queueItems.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comps"], message: "Give comps, queue_items or both." });
  }
  if (new Set(comps).size !== comps.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comps"], message: "Comp names must be unique in the list." });
  }
  if (new Set(queueItems.map((q) => q.rq_index)).size !== queueItems.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["queue_items"], message: "A Render Queue index is listed twice." });
  }
  const queueNames = queueItems.map((q) => (q.name ?? `rq${q.rq_index}`).toLowerCase());
  if (new Set(queueNames).size !== queueNames.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["queue_items"], message: "Queue item names must be unique." });
  }
  const specNames = (val.specs ?? []).map((s) => s.name.toLowerCase());
  if (new Set(specNames).size !== specNames.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["specs"], message: "Spec names must be unique." });
  }
  if (!WIN_OR_POSIX_ABSOLUTE.test(val.output_dir)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output_dir"], message: "`output_dir` must be an absolute path." });
  }
  for (const m of (val.name_template ?? "").matchAll(/\{([^{}]*)\}/g)) {
    if (!TOKENS.includes(m[1])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name_template"], message: `Unknown token {${m[1]}}. Use ${TOKENS.map((t) => `{${t}}`).join(", ")}.` });
    }
  }
}

export const AeRenderBatchPlanSchema = z.object({ ...jobFields, ...policyFields }).superRefine(refineJob);
export type AeRenderBatchPlanArgs = z.infer<typeof AeRenderBatchPlanSchema>;

export const AeRenderBatchStartSchema = z
  .object({
    expect: ExpectSchema,
    ...jobFields,
    ...policyFields,
    ...runFields,
    preflight: z.boolean().optional().describe("Run the ae_preflight delivery check on the listed comps once, before anything is copied or started, and refuse on a blocker. Default true."),
    allow_dirty: z
      .boolean()
      .optional()
      .describe("Render the last saved state although the open project has unsaved changes. Default false: the tool refuses and asks for ae_save first, so the frozen copy holds what you see."),
    freeze_location: z
      .enum(["batch_folder", "project_folder"])
      .optional()
      .describe(
        "Where the frozen copy of the .aep goes. 'batch_folder' (default) keeps it with batch.json; 'project_folder' puts it beside the original .aep as <name>.mcp_<batch id>.aep (so a relative footage path resolves from the same folder; whether it does is not measured) and deletes it when the batch ends succeeded. In a synced folder it is synced while it exists."
      ),
  })
  .superRefine(refineJob);
export type AeRenderBatchStartArgs = z.infer<typeof AeRenderBatchStartSchema>;

const BATCH_ID_RE = /^batch_\d+_[0-9a-f]{6}$/;
const BatchIdSchema = z.string().regex(BATCH_ID_RE, "batch_id must look like batch_<digits>_<6 hex>, as returned by ae_render_batch.");

export const AeRenderBatchStatusSchema = z.object({
  batch_id: BatchIdSchema.optional().describe("Batch to report. Omit to list the most recent batches."),
  include_free_space: z.boolean().optional().describe("Also measure free space now on every volume the batch writes to (each Render Queue item's own output volumes, and output_dir only when the batch has comp items; runs a PowerShell or df lookup). Reports the worst as free_space, and free_space_volumes when there is more than one. Default false."),
});
export type AeRenderBatchStatusArgs = z.infer<typeof AeRenderBatchStatusSchema>;

export const AeRenderBatchResumeSchema = z.object({
  expect: ExpectSchema,
  batch_id: BatchIdSchema.describe("Batch to continue."),
  concurrency: runFields.concurrency,
  max_cpu_percent: runFields.max_cpu_percent,
  on_error: runFields.on_error,
  stall_minutes: runFields.stall_minutes,
  if_output_exists: policyFields.if_output_exists,
});
export type AeRenderBatchResumeArgs = z.infer<typeof AeRenderBatchResumeSchema>;

export const AeRenderBatchCancelSchema = z.object({
  batch_id: BatchIdSchema.describe("Batch to cancel. Running aerender processes are terminated; finished renders are kept."),
});
export type AeRenderBatchCancelArgs = z.infer<typeof AeRenderBatchCancelSchema>;

// ---------- shapes ----------

export interface CompRead {
  name: string;
  count: number;
  id?: number;
  width?: number;
  height?: number;
  frame_rate?: number;
  duration?: number;
  work_area_start?: number | null;
  work_area_duration?: number | null;
  display_start_time?: number | null;
  /** The comp's first QUEUED render-queue item: aerender -comp renders that one and, without templates, uses its settings and all its output modules. */
  queued_item?: { item_index: number; num_output_modules: number; output_files: Array<string | null> };
}

/** A Render Queue item the job names by index, as renderbatchRead reports it (index is the rq_index). */
export interface QueueItemRead extends RqItemRead {
  found?: boolean;
  error?: string;
}

export interface RenderbatchRead {
  ae_version?: string;
  project_path: string;
  dirty: boolean;
  comp_total: number;
  comps: CompRead[];
  templates: { source: string; render_settings: string[]; output_modules: string[] };
  truncated?: boolean;
  /** The Render Queue items named by queue_items (only read when the job names some). */
  queue_items?: QueueItemRead[];
  queue_total?: number;
  queue_error?: string;
}

export interface JobInput {
  comps: string[];
  /** Existing Render Queue items rendered through aerender -rqindex. */
  queue_items: BatchQueueItem[];
  specs: BatchSpec[];
  output_dir: string;
  name_template: string;
  extension: string;
  /** True when the caller named an extension (the job's own); false when 'mov' is only a guess. */
  extension_given?: boolean;
  time_span: "comp" | "work_area" | "template";
}

export interface PlannedItem {
  index: number;
  comp_name: string;
  spec_name: string;
  render_settings_template?: string;
  output_module_template?: string;
  output_path: string;
  start_frame?: number;
  end_frame?: number;
  /** Frames the item will render (an estimate for time_span 'template'); null when the comp couldn't be read. */
  frames: number | null;
  /** Render Queue item rendered through aerender -rqindex (then output_path is its first output and output_paths lists them all). */
  rq_index?: number;
  item_comp_id?: number;
  /** Every output file of a Render Queue item. */
  output_paths?: string[];
}

export interface PlanProblem {
  code: string;
  message: string;
  item?: number;
  comp?: string;
}

export type ItemState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type BatchState = "running" | "succeeded" | "failed" | "stopped" | "cancelled";

export interface BatchItem extends PlannedItem {
  state: ItemState;
  attempts: number;
  job_id?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  note?: string;
  output_bytes?: number;
  /** Frames found on disk for an image-sequence item. */
  output_files?: number;
  percent?: number | null;
  frames_completed?: number;
  stalled?: boolean;
  stall_noted?: boolean;
  overwrote?: boolean;
  activity?: { sig: string; changed_ms: number };
}

export interface BatchOptions {
  concurrency: number;
  max_cpu_percent: number;
  on_error: "stop" | "continue";
  stall_minutes: number;
  if_output_exists: "protect_recent" | "skip" | "overwrite";
  protect_recent_minutes: number;
  min_free_gb: number;
  on_unknown_space: "continue" | "stop";
  aerender_path: string;
}

export type SpaceStatus = "ok" | "low" | "unknown";

export interface SpaceCheck {
  dir: string;
  status: SpaceStatus;
  free_bytes: number | null;
  needed_bytes: number | null;
  checked_at: string;
}

export interface BatchRecord {
  batch_id: string;
  state: BatchState;
  created_at: string;
  finished_at: string | null;
  cancel_requested: boolean;
  project_path: string;
  frozen_project: string;
  /** The frozen copy sits beside the project and is deleted once the batch ends succeeded. */
  frozen_temporary?: boolean;
  batch_dir: string;
  output_dir: string;
  options: BatchOptions;
  items: BatchItem[];
  warnings: string[];
  notices: string[];
  free_space?: SpaceCheck;
  preflight?: GateSummary;
}

// ---------- pure logic ----------

const clip = (s: string): string => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
const errText = (e: unknown): string => clip(e instanceof Error ? e.message : String(e));

/** File-name safe: Windows' forbidden characters and control characters become '_'; no trailing dots or spaces. */
export function sanitizeFileToken(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned : "_";
}

export function isSequencePath(p: string): boolean {
  return /\[#+\]/.test(path.basename(p.replace(/\\/g, "/")));
}

/** Joins a folder and a file name in the folder's own separator style, so a Windows path stays a Windows path on any host. */
export function joinOutput(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function dateStamp(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function outputNameFor(job: JobInput, compName: string, spec: BatchSpec, n: number, now: number): string {
  const base = job.name_template.replace(/\{(comp|spec|date|n)\}/g, (_m, token: string) => {
    if (token === "comp") return sanitizeFileToken(compName);
    if (token === "spec") return sanitizeFileToken(spec.name);
    if (token === "date") return dateStamp(now);
    return String(n).padStart(2, "0");
  });
  const stem = sanitizeFileToken(base);
  const ext = spec.extension ?? job.extension;
  return spec.sequence ? `${stem}.[#####].${ext}` : `${stem}.${ext}`;
}

/** Fills the job's defaults. */
export function normaliseJob(args: {
  comps?: string[];
  queue_items?: BatchQueueItem[];
  specs?: BatchSpec[];
  output_dir: string;
  name_template?: string;
  extension?: string;
  time_span?: JobInput["time_span"];
}): JobInput {
  return {
    comps: args.comps ?? [],
    queue_items: args.queue_items ?? [],
    specs: args.specs && args.specs.length > 0 ? args.specs : [{ name: "default" }],
    output_dir: args.output_dir,
    name_template: args.name_template ?? "{comp}_{spec}",
    extension: args.extension ?? "mov",
    extension_given: args.extension !== undefined,
    time_span: args.time_span ?? "comp",
  };
}

/** The frames an item renders: aerender's -s/-e and a count for the ETA. */
export function framesFor(info: CompRead | undefined, span: JobInput["time_span"]): { start?: number; end?: number; frames: number | null } {
  const fps = info?.frame_rate;
  const dur = info?.duration;
  if (!info || !fps || !dur || !(fps > 0) || !(dur > 0)) return { frames: null };
  const whole = Math.max(1, Math.round(dur * fps));
  if (span === "template") return { frames: whole };
  if (span === "work_area") {
    const ws = info.work_area_start;
    const wd = info.work_area_duration;
    if (typeof ws === "number" && typeof wd === "number" && wd > 0) {
      const start = Math.max(0, Math.round(ws * fps));
      const frames = Math.max(1, Math.round(wd * fps));
      return { start, end: start + frames - 1, frames };
    }
  }
  return { start: 0, end: whole - 1, frames: whole };
}

/** Every output file an item writes: its Render Queue item's modules, or its one output. */
export function outputsOf(item: Pick<PlannedItem, "output_path" | "output_paths">): string[] {
  if (item.output_paths && item.output_paths.length > 0) return item.output_paths;
  return item.output_path ? [item.output_path] : [];
}

/** The folder of a file path (either separator); "" when there is none. A file at the root of a drive or of "/" keeps the root ("E:/", "/"). */
export function folderOf(p: string): string {
  const m = /^(.*)([\\/])[^\\/]*$/.exec(p);
  if (!m) return "";
  if (m[1] === "") return m[2];
  if (/^[A-Za-z]:$/.test(m[1])) return m[1] + m[2];
  return m[1];
}

/** One key per volume: the drive letter, or the folder itself for a UNC or POSIX path. */
function volumeKeyOf(dir: string): string {
  return driveLetterOf(dir + "/") ?? dir;
}

/**
 * Whether two folders may share a volume. Only two different drive letters are known to be apart; a UNC or
 * POSIX path cannot be placed on a volume from its text, so it stays conservative and counts as the same one.
 */
export function mayShareVolume(a: string, b: string): boolean {
  const la = driveLetterOf(a + "/");
  const lb = driveLetterOf(b + "/");
  return la === null || lb === null || la === lb;
}

/**
 * The folders whose volumes an item writes to. A Render Queue item writes to its own output-module
 * paths (any volume); every other item writes under the batch output folder.
 */
export function spaceDirsOf(item: Pick<PlannedItem, "output_path" | "output_paths" | "rq_index">, outputDir: string): string[] {
  if (item.rq_index === undefined) return [outputDir];
  const seen: Record<string, boolean> = {};
  const dirs: string[] = [];
  for (const out of outputsOf(item)) {
    const d = folderOf(out) || outputDir;
    const k = volumeKeyOf(d);
    if (seen[k]) continue;
    seen[k] = true;
    dirs.push(d);
  }
  return dirs.length > 0 ? dirs : [outputDir];
}

/**
 * The distinct volumes a batch writes to, one folder each: every Render Queue item's own output
 * volumes, plus the batch output folder only when some item (a comp item) writes under it, or when
 * there are no items at all (so the list is never empty).
 */
export function batchSpaceDirs(items: Array<Pick<PlannedItem, "output_path" | "output_paths" | "rq_index">>, outputDir: string): string[] {
  const seen: Record<string, boolean> = {};
  const dirs: string[] = [];
  const add = (d: string) => {
    const k = volumeKeyOf(d);
    if (seen[k]) return;
    seen[k] = true;
    dirs.push(d);
  };
  if (items.length === 0 || items.some((it) => it.rq_index === undefined)) add(outputDir);
  for (const it of items) if (it.rq_index !== undefined) for (const d of spaceDirsOf(it, outputDir)) add(d);
  return dirs;
}

/** Frames a Render Queue item renders, from its time span and frame rate (skip frames thin them); null when unknown. */
export function queueItemFrames(q: RqItemRead | undefined): number | null {
  if (!q || typeof q.comp_frame_rate !== "number" || !(q.comp_frame_rate > 0)) return null;
  const dur = q.time_span_duration ?? q.comp_duration;
  if (typeof dur !== "number" || !(dur > 0)) return null;
  const skip = typeof q.skip_frames === "number" && q.skip_frames > 0 ? q.skip_frames + 1 : 1;
  return Math.max(1, Math.round((dur * q.comp_frame_rate) / skip));
}

/**
 * Comps outer, specs inner, then the Render Queue items. Items for a comp that couldn't be read still appear (frames null) so the plan can name the problem.
 * A Render Queue item takes its comp name and output files from the queue read (queueReads); its index, not the comp name, selects it.
 */
export function expandItems(job: JobInput, reads: CompRead[], now: number, queueReads: QueueItemRead[] = []): PlannedItem[] {
  const byName = new Map(reads.map((c) => [c.name, c]));
  const items: PlannedItem[] = [];
  for (const comp of job.comps) {
    const info = byName.get(comp);
    const f = framesFor(info && info.count === 1 ? info : undefined, job.time_span);
    for (const spec of job.specs) {
      const index = items.length + 1;
      items.push({
        index,
        comp_name: comp,
        spec_name: spec.name,
        ...(spec.render_settings_template ? { render_settings_template: spec.render_settings_template } : {}),
        ...(spec.output_module_template ? { output_module_template: spec.output_module_template } : {}),
        output_path: joinOutput(job.output_dir, outputNameFor(job, comp, spec, index, now)),
        ...(f.start !== undefined ? { start_frame: f.start } : {}),
        ...(f.end !== undefined ? { end_frame: f.end } : {}),
        frames: f.frames,
      });
    }
  }
  for (const q of job.queue_items) {
    const rd = queueReads.find((r) => r.index === q.rq_index && r.found !== false);
    const outs = rd ? itemOutputs(rd).paths : [];
    items.push({
      index: items.length + 1,
      comp_name: rd?.comp_name ?? "",
      spec_name: q.name ?? `rq${q.rq_index}`,
      rq_index: q.rq_index,
      item_comp_id: q.item_comp_id,
      output_path: outs[0] ?? "",
      output_paths: outs,
      frames: queueItemFrames(rd),
    });
  }
  return items;
}

/** Why an output path must never be written, or null. */
export function protectedReason(outputPath: string, projectPaths: string[] = []): string | null {
  const norm = outputPath.replace(/\\/g, "/").toLowerCase();
  for (const seg of norm.split("/")) {
    if (seg === "_mcp_backups" || seg === "_mcp_checkpoints") return `it is inside ${seg}, which holds the MCP's own backups`;
  }
  for (const p of projectPaths) {
    if (p && p !== "<unsaved>" && p.replace(/\\/g, "/").toLowerCase() === norm) return "it is the project file itself";
  }
  return null;
}

/** Everything wrong with a plan that stops it from running, plus softer warnings. */
export function validatePlan(
  job: JobInput,
  read: RenderbatchRead | null,
  items: PlannedItem[],
  projectPaths: string[] = []
): { errors: PlanProblem[]; warnings: string[] } {
  const errors: PlanProblem[] = [];
  const warnings: string[] = [];
  if (read) {
    if (job.queue_items.length > 0) {
      if (read.dirty) {
        errors.push({
          code: "queue_items_need_saved_project",
          message: "The open project has unsaved changes. aerender reads the saved file, so Render Queue items added or queued since the last save are not in it: run ae_save, then plan again.",
        });
      }
      if (read.queue_error) warnings.push(`The Render Queue items could not all be read: ${read.queue_error}`);
      for (const q of job.queue_items) {
        const rd = read.queue_items?.find((r) => r.index === q.rq_index && r.found !== false);
        const picked = selectRqItem({ numItems: read.queue_total ?? 0, items: rd ? [rd] : [] }, { rq_index: q.rq_index, item_comp_id: q.item_comp_id });
        if (!picked.ok) {
          errors.push({ code: picked.code, comp: rd?.comp_name, message: `Queue item ${q.rq_index}: ${picked.message}` });
          continue;
        }
        for (const w of picked.selection.warnings) warnings.push(`Queue item ${q.rq_index}: ${w}`);
        for (const f of picked.selection.outputs) {
          const why = protectedReason(f, projectPaths);
          if (why) errors.push({ code: "output_protected", comp: rd?.comp_name, message: `Queue item ${q.rq_index} would write ${f}, but ${why}.` });
        }
      }
    }
    for (const name of job.comps) {
      const c = read.comps.find((x) => x.name === name);
      if (!c || c.count === 0) errors.push({ code: "comp_not_found", comp: name, message: `No comp named "${name}" in the project.` });
      else if (c.count > 1) {
        errors.push({ code: "comp_name_ambiguous", comp: name, message: `${c.count} comps are named "${name}"; aerender selects by name. Rename them so the name is unique.` });
      } else if (!c.frame_rate || !c.duration) {
        warnings.push(`Comp "${name}": frame rate or duration unreadable; its ETA and frame range are unknown.`);
      }
      if (c && c.count === 1 && c.queued_item) {
        const q = c.queued_item;
        const files = q.output_files.filter((f): f is string => typeof f === "string");
        if (q.num_output_modules > 1) {
          errors.push({
            code: "queued_item_extra_output_modules",
            comp: name,
            message: `Comp "${name}" already has a queued item in the render queue with ${q.num_output_modules} output modules (${files.slice(0, 5).join(", ")}). aerender renders that item, so every module writes to the path stored in the project, outside output_dir, where nothing here checks for overwrites. Take the item out of the render queue (or remove its extra output modules), save, and plan again.`,
          });
          for (const f of files.slice(1)) {
            const why = protectedReason(f, projectPaths);
            if (why) errors.push({ code: "output_protected", comp: name, message: `A queued output module of "${name}" would write ${f}, but ${why}.` });
          }
        }
        const missing = job.specs.filter((sp) => !sp.render_settings_template || !sp.output_module_template).map((sp) => sp.name);
        if (missing.length > 0) {
          warnings.push(`Comp "${name}" has a queued render-queue item. aerender renders that item, so spec(s) ${missing.join(", ")} (which leave out a template) use its render settings and output module, which may differ from the defaults (resolution, frame rate, codec).`);
        }
      }
      if (c && c.count === 1 && typeof c.display_start_time === "number" && c.display_start_time !== 0 && (job.time_span === "comp" || job.time_span === "work_area")) {
        warnings.push(`Comp "${name}" has a non-zero display start time (${c.display_start_time}s): whether aerender's -s/-e frames count from 0 or from that start is unconfirmed, so the rendered range may be shifted. Consider time_span 'template' for this comp.`);
      }
    }
    const rsKnown = read.templates.source !== "none" && read.templates.render_settings.length > 0;
    const omKnown = read.templates.source !== "none" && read.templates.output_modules.length > 0;
    if (read.templates.source === "none") {
      warnings.push("Template names were not checked: the render queue is empty, and reading them would need a temporary item (which marks the project changed). An unknown template fails that item with 'aerender ERROR' in its log.");
    } else {
      if (!rsKnown && job.specs.some((sp) => sp.render_settings_template)) warnings.push("Render-settings template names could not be read, so they were not checked. An unknown template fails that item with 'aerender ERROR' in its log.");
      if (!omKnown && job.specs.some((sp) => sp.output_module_template)) warnings.push("Output-module template names could not be read, so they were not checked. An unknown template fails that item with 'aerender ERROR' in its log.");
      for (const spec of job.specs) {
        if (rsKnown && spec.render_settings_template && !read.templates.render_settings.includes(spec.render_settings_template)) {
          errors.push({ code: "template_not_found", message: `Spec "${spec.name}": no render-settings template "${spec.render_settings_template}". Known: ${read.templates.render_settings.slice(0, 20).join(", ")}.` });
        }
        if (omKnown && spec.output_module_template && !read.templates.output_modules.includes(spec.output_module_template)) {
          errors.push({ code: "template_not_found", message: `Spec "${spec.name}": no output-module template "${spec.output_module_template}". Known: ${read.templates.output_modules.slice(0, 20).join(", ")}.` });
        }
      }
    }
    if (read.truncated) warnings.push("The comp list was capped; some names were not checked.");
  }
  for (const spec of job.comps.length === 0 ? [] : job.specs) {
    if (spec.extension !== undefined || job.extension_given) continue;
    if (!spec.output_module_template) {
      errors.push({
        code: "extension_required",
        message: `Spec "${spec.name}" has no output_module_template and no extension (nor does the job), so the file name would be a guess ('.${job.extension}'; recent After Effects versions default to H.264, .mp4). Give the spec or the job an extension that matches what is rendered.`,
      });
    } else {
      warnings.push(`Spec "${spec.name}" has no extension, so the file name ends in '.${job.extension}' (a default, not read from the template). Give it the extension the output-module template writes, or the batch fails verifying a file that rendered under another name.`);
    }
  }
  const seen = new Map<string, number>();
  for (const it of items) {
    for (const out of outputsOf(it)) {
      const key = out.replace(/\\/g, "/").toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined) {
        const who = prev === it.index ? `Item ${it.index} writes the same file from two output modules` : `Items ${prev} and ${it.index} write the same file`;
        errors.push({ code: "output_collision", item: it.index, message: `${who} (${out}). Add {comp}, {spec} or {n} to name_template, or give the queue items different output files.` });
      } else seen.set(key, it.index);
      // A Render Queue item's outputs are checked with its own message above.
      if (it.rq_index === undefined) {
        const why = protectedReason(out, projectPaths);
        if (why) errors.push({ code: "output_protected", item: it.index, message: `Item ${it.index} would write ${out}, but ${why}.` });
      }
    }
  }
  if (job.time_span === "template") warnings.push("time_span 'template': no -s/-e is passed, so progress and ETA are estimated from the comp length.");
  return { errors, warnings };
}

export interface ExistingOutput {
  exists: boolean;
  bytes: number;
  newest_mtime_ms: number | null;
  /** Every file the output stands for (one, or the numbered frames of a sequence). */
  files: Array<{ mtime_ms: number; size: number }>;
}

function sequenceRegex(base: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${base.split(/\[#+\]/).map(esc).join("\\d+")}$`, "i");
}

/** The files an output path stands for: itself, or the numbered files of a sequence. */
function outputFiles(outputPath: string): string[] {
  try {
    if (isSequencePath(outputPath)) {
      const norm = path.sep === "\\" ? outputPath : outputPath.replace(/\\/g, "/");
      const dir = path.dirname(norm);
      const re = sequenceRegex(path.basename(norm));
      return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n));
    }
    return fs.existsSync(outputPath) ? [outputPath] : [];
  } catch {
    return [];
  }
}

export function inspectOutput(outputPath: string): ExistingOutput {
  let bytes = 0;
  let newest: number | null = null;
  let count = 0;
  const files: ExistingOutput["files"] = [];
  for (const f of outputFiles(outputPath)) {
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) continue;
      count++;
      files.push({ mtime_ms: st.mtimeMs, size: st.size });
      bytes += st.size;
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // a file that vanished between the listing and the stat doesn't count
    }
  }
  return { exists: count > 0, bytes, newest_mtime_ms: newest, files };
}

/** The files of several outputs together (a Render Queue item writes one per output module). */
export function inspectOutputs(paths: string[]): ExistingOutput {
  if (paths.length === 1) return inspectOutput(paths[0]);
  let bytes = 0;
  let newest: number | null = null;
  let any = false;
  const files: ExistingOutput["files"] = [];
  for (const p of paths) {
    const o = inspectOutput(p);
    if (!o.exists) continue;
    any = true;
    bytes += o.bytes;
    files.push(...o.files);
    if (o.newest_mtime_ms !== null && (newest === null || o.newest_mtime_ms > newest)) newest = o.newest_mtime_ms;
  }
  return { exists: any, bytes, newest_mtime_ms: newest, files };
}

/**
 * An output counts as rendered when it exists, has bytes, and (with sinceMs) was written after the item started.
 * For an image sequence only the frames written since then count, and with expectFrames their number must match it
 * (frames left by an earlier render of the same name never make a short render pass).
 */
export function verifyOutput(outputPath: string, sinceMs: number | null, expectFrames: number | null = null): { ok: boolean; bytes: number; files?: number; reason?: string } {
  const o = inspectOutput(outputPath);
  if (!o.exists) return { ok: false, bytes: 0, reason: "the output file does not exist" };
  if (o.bytes <= 0) return { ok: false, bytes: 0, reason: "the output file is empty" };
  const floor = sinceMs === null ? null : sinceMs - MTIME_SLOP_MS;
  if (isSequencePath(outputPath)) {
    const fresh = floor === null ? o.files : o.files.filter((f) => f.mtime_ms >= floor);
    const bytes = fresh.reduce((sum, f) => sum + f.size, 0);
    if (fresh.length === 0) return { ok: false, bytes: o.bytes, files: 0, reason: "no frame of the sequence is newer than the item's start (aerender did not write it)" };
    if (expectFrames !== null && expectFrames > 0 && fresh.length !== expectFrames) {
      return { ok: false, bytes, files: fresh.length, reason: `${fresh.length} of ${expectFrames} frames of the sequence were written` };
    }
    if (bytes <= 0) return { ok: false, bytes: 0, files: fresh.length, reason: "the written frames are empty" };
    return { ok: true, bytes, files: fresh.length };
  }
  if (floor !== null && (o.newest_mtime_ms ?? 0) < floor) {
    return { ok: false, bytes: o.bytes, reason: "the output file is older than the item's start (aerender did not write it)" };
  }
  return { ok: true, bytes: o.bytes };
}

/** verifyOutput for every output of an item: a Render Queue item is rendered only when each of its output modules' files is. */
export function verifyOutputs(item: Pick<PlannedItem, "output_path" | "output_paths">, sinceMs: number | null, expectFrames: number | null = null): { ok: boolean; bytes: number; files?: number; reason?: string } {
  const paths = outputsOf(item);
  if (paths.length <= 1) return verifyOutput(paths[0] ?? item.output_path, sinceMs, expectFrames);
  let bytes = 0;
  let files = 0;
  let sawFiles = false;
  for (const p of paths) {
    const v = verifyOutput(p, sinceMs, null);
    if (!v.ok) return { ok: false, bytes, reason: `${p}: ${v.reason}` };
    bytes += v.bytes;
    if (v.files !== undefined) {
      files += v.files;
      sawFiles = true;
    }
  }
  return { ok: true, bytes, ...(sawFiles ? { files } : {}) };
}

export function spaceStatus(freeBytes: number | null, neededBytes: number | null, minFreeGb: number): SpaceStatus {
  if (freeBytes === null) return "unknown";
  return freeBytes - (neededBytes ?? 0) >= minFreeGb * GIB ? "ok" : "low";
}

/** Bytes per frame from this batch's finished items of the same spec, scaled to the item (+10%); null without history. */
export function estimateBytes(items: BatchItem[], item: PlannedItem): number | null {
  if (!item.frames) return null;
  let bytes = 0;
  let frames = 0;
  for (const i of items) {
    if (i.state === "succeeded" && i.spec_name === item.spec_name && i.frames && i.output_bytes) {
      bytes += i.output_bytes;
      frames += i.frames;
    }
  }
  if (frames === 0) return null;
  return Math.round((bytes / frames) * item.frames * 1.1);
}

/** `df -Pk` output to free bytes (the Available column of the last line). */
export function parseDfAvailableBytes(text: string): number | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(lines[i]);
    if (m) return parseInt(m[3], 10) * 1024;
  }
  return null;
}

/** The drive letter of a Windows path, or null for a UNC path or a relative one. */
export function driveLetterOf(p: string): string | null {
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  return m ? m[1].toUpperCase() : null;
}

type RunFile = (file: string, args: string[]) => Promise<string>;

const defaultRunFile: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/**
 * Free bytes on the volume holding `dir`. Windows asks PowerShell's
 * Get-PSDrive (wmic is gone on Windows 11 24H2; Node 17 has no fs.statfs);
 * a UNC path answers null, which callers report as "unknown".
 */
export async function getFreeBytes(dir: string, platform: NodeJS.Platform = process.platform, run: RunFile = defaultRunFile): Promise<number | null> {
  try {
    if (platform === "win32") {
      const letter = driveLetterOf(dir);
      if (!letter) return null;
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-PSDrive -Name ${letter}).Free`]);
      const text = out.trim();
      if (!/^\d+$/.test(text)) return null;
      const n = Number(text);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    // The nearest folder that exists: the output folder is made by the first render.
    let probe = dir;
    while (probe && !fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    return parseDfAvailableBytes(await run("df", ["-Pk", probe]));
  } catch {
    return null;
  }
}

export interface Eta {
  eta_seconds: number | null;
  eta_at: string | null;
  basis: string;
}

/** Seconds left: running items by their own progress, pending ones by this batch's seconds-per-frame so far. */
export function computeEta(b: BatchRecord, nowMs: number): Eta {
  let secs = 0;
  let frames = 0;
  for (const i of b.items) {
    if (i.state === "succeeded" && i.frames && i.started_at && i.finished_at) {
      const d = (Date.parse(i.finished_at) - Date.parse(i.started_at)) / 1000;
      if (d > 0) {
        secs += d;
        frames += i.frames;
      }
    }
  }
  const spf = frames > 0 ? secs / frames : null;
  const running = b.items.filter((i) => i.state === "running");
  const pending = b.items.filter((i) => i.state === "pending");
  if (running.length === 0 && pending.length === 0) return { eta_seconds: 0, eta_at: null, basis: "nothing left to render" };
  let unknown = false;
  let longestRunning = 0;
  for (const i of running) {
    const started = i.started_at ? Date.parse(i.started_at) : NaN;
    if (typeof i.percent === "number" && i.percent > 0 && !Number.isNaN(started)) {
      longestRunning = Math.max(longestRunning, ((nowMs - started) / 1000) * ((100 - i.percent) / i.percent));
    } else if (spf !== null && i.frames) {
      longestRunning = Math.max(longestRunning, spf * i.frames);
    } else unknown = true;
  }
  let pendingSecs = 0;
  for (const i of pending) {
    if (spf !== null && i.frames) pendingSecs += spf * i.frames;
    else unknown = true;
  }
  if (unknown) return { eta_seconds: null, eta_at: null, basis: "not enough finished items or frame counts yet" };
  const total = Math.round(longestRunning + pendingSecs / Math.max(1, b.options.concurrency));
  return { eta_seconds: total, eta_at: new Date(nowMs + total * 1000).toISOString(), basis: "running items' progress plus seconds per frame of the finished ones" };
}

export function countStates(items: BatchItem[]): Record<ItemState, number> {
  const c: Record<ItemState, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const i of items) c[i.state]++;
  return c;
}

/** True when the aerender log says the composition finished (used to adopt an item whose runner died). */
function logFinished(logPath: string): boolean {
  const { fullText } = readLogTail(logPath);
  return /Finished composition/i.test(fullText) && !/^aerender ERROR/im.test(fullText);
}

// ---------- store ----------

export class BatchStore {
  private readonly cache = new Map<string, BatchRecord>();
  constructor(readonly dir: string) {}

  newId(): string {
    return `batch_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  }

  batchDir(id: string): string {
    return path.join(this.dir, id);
  }

  jsonPath(id: string): string {
    return path.join(this.batchDir(id), "batch.json");
  }

  save(b: BatchRecord): void {
    this.cache.set(b.batch_id, b);
    const file = this.jsonPath(b.batch_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    const payload = JSON.stringify(b, null, 2);
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, payload, "utf8");
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
    }
  }

  /** Drops a batch that never started: the cached record and its folder. */
  forget(id: string): void {
    this.cache.delete(id);
    if (!BATCH_ID_RE.test(id)) return;
    try {
      fs.rmSync(this.batchDir(id), { recursive: true, force: true });
    } catch {
      // nothing more to clean up
    }
  }

  get(id: string): BatchRecord | undefined {
    if (!BATCH_ID_RE.test(id)) return undefined;
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const b = JSON.parse(fs.readFileSync(this.jsonPath(id), "utf8")) as BatchRecord;
      if (b && typeof b.batch_id === "string") {
        this.cache.set(id, b);
        return b;
      }
    } catch {
      // unknown or unreadable
    }
    return undefined;
  }

  /** Newest first. */
  list(limit = 20): BatchRecord[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.dir).filter((n) => n.startsWith("batch_"));
    } catch {
      ids = [];
    }
    ids.sort().reverse();
    const out: BatchRecord[] = [];
    for (const id of ids) {
      const b = this.get(id);
      if (b) out.push(b);
      if (out.length >= limit) break;
    }
    return out;
  }
}

// ---------- runner ----------

export interface RunnerDeps {
  registry: AerenderJobRegistry;
  spawn: SpawnLike;
  now: () => number;
  getFreeBytes: (dir: string) => Promise<number | null>;
  isPidAlive: (pid: number, jobId?: string) => boolean;
  killProcess?: (pid: number, signal?: string | number) => void;
  cancelHooks?: CancelHooks;
}

/** Updates one running item from its job: progress, output growth, stall flag. */
function refreshRunning(item: BatchItem, job: AerenderJobRecord, now: number, stallMs: number): void {
  const { fullText } = readLogTail(job.log_path);
  const p = parseAerenderProgress(fullText, { start_frame: job.start_frame, end_frame: job.end_frame, state: job.state });
  let percent = p.percent;
  if (percent === null && item.frames && p.frames_completed > 0) percent = Math.min(100, Math.round((p.frames_completed / item.frames) * 10000) / 100);
  item.percent = percent;
  item.frames_completed = p.frames_completed;
  let outBytes = 0;
  for (const out of outputsOf(item)) {
    try {
      outBytes += fs.existsSync(out) && !isSequencePath(out) ? fs.statSync(out).size : 0;
    } catch {
      // a file that vanished counts as zero
    }
  }
  const sig = `${fullText.length}|${p.progress_lines_count}|${outBytes}`;
  if (!item.activity || item.activity.sig !== sig) item.activity = { sig, changed_ms: now };
  item.stalled = job.state === "running" && now - item.activity.changed_ms >= stallMs;
  if (!item.stalled) item.stall_noted = false;
}

export class BatchRunner {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: BatchStore,
    private readonly deps: RunnerDeps,
    private readonly opts: { tickMs: number; autoTick: boolean } = { tickMs: 5000, autoTick: true }
  ) {}

  isActive(id: string): boolean {
    return this.timers.has(id) || this.busy.has(id);
  }

  /** Marks the batch as driven by this process, ticks once now, and keeps ticking. */
  async begin(id: string): Promise<BatchRecord | undefined> {
    if (this.opts.autoTick && !this.timers.has(id)) {
      const t = setInterval(() => {
        this.tick(id).catch(() => {});
      }, this.opts.tickMs);
      if (typeof t.unref === "function") t.unref();
      this.timers.set(id, t);
    }
    return this.tick(id);
  }

  private stopTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
  }

  async tick(id: string): Promise<BatchRecord | undefined> {
    const b = this.store.get(id);
    if (!b) {
      this.stopTimer(id);
      return undefined;
    }
    if (b.state !== "running") {
      this.stopTimer(id);
      return b;
    }
    if (this.busy.has(id)) return b;
    this.busy.add(id);
    try {
      await this.step(b);
    } catch (err) {
      // A runner bug must not leave a batch looking healthy: say so and stop it.
      b.notices.push(`The runner stopped on an error: ${errText(err)}`);
      b.state = "stopped";
      b.finished_at = new Date(this.deps.now()).toISOString();
    } finally {
      this.busy.delete(id);
      if ((b.state as BatchState) === "succeeded" && b.frozen_temporary) {
        b.frozen_temporary = false;
        try {
          fs.rmSync(b.frozen_project, { force: true });
          b.notices.push(`Every item finished; the frozen project copy ${b.frozen_project} was deleted.`);
        } catch (err) {
          b.notices.push(`Every item finished, but the frozen project copy ${b.frozen_project} could not be deleted (${errText(err)}).`);
        }
      }
      try {
        this.store.save(b);
      } catch (err) {
        const note = `The batch state could not be saved to disk (${errText(err)}); it is kept in memory only.`;
        if (!b.notices.includes(note)) b.notices.push(note);
      }
      if (b.state !== "running") this.stopTimer(id);
    }
    return b;
  }

  private stopping(b: BatchRecord): boolean {
    return b.cancel_requested || (b.options.on_error === "stop" && b.items.some((i) => i.state === "failed" || i.state === "cancelled"));
  }

  private async step(b: BatchRecord): Promise<void> {
    const now = this.deps.now();
    const stallMs = b.options.stall_minutes * 60_000;

    for (const item of b.items.filter((i) => i.state === "running")) {
      const job = item.job_id ? this.deps.registry.get(item.job_id) : undefined;
      if (!job) {
        this.fail(item, "the aerender job record is gone", now);
        continue;
      }
      refreshRunning(item, job, now, stallMs);
      if (item.stalled && !item.stall_noted) {
        item.stall_noted = true;
        b.notices.push(
          `Item ${item.index} (${item.comp_name}, ${item.spec_name}) shows no log or output growth for ${b.options.stall_minutes} minutes (job ${job.job_id}). It may be stuck on a slow frame; check ae_aerender_status and call ae_aerender_cancel if it is. The batch does not cancel it for you.`
        );
      }
      if (job.state === "running") continue;
      item.finished_at = job.finished_at ?? new Date(now).toISOString();
      if (job.cancelled) {
        item.state = "cancelled";
        item.error = "cancelled";
      } else if (job.state === "succeeded") {
        const v = verifyOutputs(item, item.started_at ? Date.parse(item.started_at) : null, expectedFrames(item));
        if (v.ok) {
          item.state = "succeeded";
          item.output_bytes = v.bytes;
          if (v.files !== undefined) item.output_files = v.files;
          item.percent = 100;
          item.stalled = false;
        } else this.fail(item, `aerender exited cleanly but ${v.reason}`, now);
      } else {
        this.fail(item, job.error ? clip(job.error) : `aerender exited with code ${job.exit_code ?? "unknown"}${job.signal ? ` (${job.signal})` : ""}; see ${job.log_path}`, now);
      }
    }

    let waitingForOthers = false;
    while (!this.stopping(b)) {
      const own = b.items.filter((i) => i.state === "running").length;
      const others = this.othersRunning(b);
      if (own + others >= b.options.concurrency) {
        waitingForOthers = own === 0 && others > 0 && b.items.some((i) => i.state === "pending");
        break;
      }
      const next = b.items.find((i) => i.state === "pending");
      if (!next) break;
      await this.startItem(b, next, now);
    }

    if (b.items.some((i) => i.state === "running")) return;
    if (waitingForOthers && b.state === "running" && !b.cancel_requested) {
      const note = "Waiting: the concurrency limit is used up by aerender jobs that are not part of this batch (another batch or ae_aerender_start). The next item starts when one of them ends.";
      if (!b.notices.includes(note)) b.notices.push(note);
      return;
    }
    const counts = countStates(b.items);
    if (b.cancel_requested) b.state = "cancelled";
    else if (counts.pending > 0) b.state = "stopped";
    else b.state = counts.failed > 0 || counts.cancelled > 0 ? "failed" : "succeeded";
    b.finished_at = new Date(now).toISOString();
  }

  /** Running aerender jobs of this process that no item of this batch owns (other batches, ae_aerender_start). */
  private othersRunning(b: BatchRecord): number {
    const own = new Set(b.items.map((i) => i.job_id).filter((j): j is string => typeof j === "string"));
    return this.deps.registry.list().filter((j) => j.state === "running" && !own.has(j.job_id) && this.deps.registry.getProcess(j.job_id) !== undefined).length;
  }

  private fail(item: BatchItem, why: string, now: number): void {
    item.state = "failed";
    item.error = why;
    item.finished_at = new Date(now).toISOString();
  }

  /** The governor, then the launch. Any refusal fails the item with the reason; nothing is thrown. */
  private async startItem(b: BatchRecord, item: BatchItem, now: number): Promise<void> {
    const o = b.options;
    for (const out of outputsOf(item)) {
      const why = protectedReason(out, [b.project_path, b.frozen_project]);
      if (why) return this.fail(item, `blocked: ${why}`, now);
    }

    const existing = inspectOutputs(outputsOf(item));
    if (existing.exists) {
      // A file an earlier attempt of this item left behind is this batch's own.
      const ours = item.attempts > 0;
      if (o.if_output_exists === "skip" && existing.bytes > 0 && !ours) {
        item.state = "skipped";
        item.note = "the output already exists; left alone (if_output_exists: skip)";
        item.output_bytes = existing.bytes;
        item.finished_at = new Date(now).toISOString();
        return;
      }
      const ageMin = existing.newest_mtime_ms === null ? Infinity : (now - existing.newest_mtime_ms) / 60_000;
      if (o.if_output_exists === "protect_recent" && !ours && ageMin < o.protect_recent_minutes) {
        return this.fail(item, `blocked: ${item.output_path} was written ${Math.max(0, Math.round(ageMin))} minutes ago (protect_recent_minutes ${o.protect_recent_minutes}). Use another name, wait, or set if_output_exists to 'overwrite' or 'skip'.`, now);
      }
      item.overwrote = true;
    }

    const spaceDirs = spaceDirsOf(item, b.output_dir);
    const frees: Array<number | null> = [];
    for (const d of spaceDirs) frees.push(await this.deps.getFreeBytes(d));
    // A cancel (or a stop) that landed during the await must not be followed by a launch.
    if (b.cancel_requested || b.state !== "running") return;
    const needed = estimateBytes(b.items, item);
    let status: SpaceCheck["status"] = "ok";
    let free: number | null = null;
    let reserved = 0;
    let shownDir = spaceDirs[0];
    let worst = -1;
    for (let di = 0; di < spaceDirs.length; di++) {
      // Items already running will still write: their estimated sizes are not free space either.
      let res = 0;
      for (const r of b.items) {
        if (r.state !== "running" || r === item) continue;
        if (spaceDirsOf(r, b.output_dir).some((rd) => mayShareVolume(rd, spaceDirs[di]))) res += estimateBytes(b.items, r) ?? 0;
      }
      const f = frees[di];
      const st = spaceStatus(f === null ? null : Math.max(0, f - res), needed, o.min_free_gb);
      const rank = st === "low" ? 2 : st === "unknown" ? 1 : 0;
      if (rank > worst) {
        worst = rank;
        status = st;
        free = f;
        reserved = res;
        shownDir = spaceDirs[di];
      }
    }
    b.free_space = { dir: shownDir, status, free_bytes: free, needed_bytes: needed, checked_at: new Date(now).toISOString() };
    if (status === "low") {
      return this.fail(item, `blocked: only ${((free ?? 0) / GIB).toFixed(1)} GB free on the output volume of ${shownDir}${reserved > 0 ? ` (${(Math.max(0, (free ?? 0) - reserved) / GIB).toFixed(1)} GB after ${(reserved / GIB).toFixed(1)} GB reserved for running items)` : ""}; this item needs about ${(((needed ?? 0) / GIB)).toFixed(1)} GB plus ${o.min_free_gb} GB spare.`, now);
    }
    if (status === "unknown") {
      if (o.on_unknown_space === "stop") return this.fail(item, "blocked: free space on the output volume could not be measured (on_unknown_space: stop)", now);
      const note = `Free space on ${shownDir} could not be measured (a network path or a failed lookup); rendering anyway. It is not known to be ok.`;
      if (!b.notices.includes(note)) b.notices.push(note);
    }

    try {
      const cpu = Math.max(1, Math.floor(o.max_cpu_percent / Math.max(1, o.concurrency)));
      // A Render Queue item renders through -rqindex with its own outputs and settings: no -comp, -output, templates or -s/-e.
      const rec =
        item.rq_index !== undefined
          ? launchAerenderJob({
              registry: this.deps.registry,
              spawn: this.deps.spawn,
              aerender_path: o.aerender_path,
              project_path: b.frozen_project,
              comp_name: item.comp_name,
              rq_index: item.rq_index,
              item_comp_id: item.item_comp_id,
              comp_id: item.item_comp_id,
              output_paths: outputsOf(item),
              max_cpu_percent: cpu,
            })
          : launchAerenderJob({
              registry: this.deps.registry,
              spawn: this.deps.spawn,
              aerender_path: o.aerender_path,
              project_path: b.frozen_project,
              comp_name: item.comp_name,
              output_path: item.output_path,
              output_module_template: item.output_module_template,
              render_settings_template: item.render_settings_template,
              start_frame: item.start_frame,
              end_frame: item.end_frame,
              max_cpu_percent: cpu,
            });
      item.state = "running";
      item.attempts++;
      item.job_id = rec.job_id;
      item.started_at = rec.started_at;
      item.finished_at = undefined;
      item.error = undefined;
      item.percent = 0;
      item.stalled = false;
      item.stall_noted = false;
      item.activity = { sig: "", changed_ms: now };
    } catch (err) {
      this.fail(item, `could not start aerender: ${errText(err)}`, now);
    }
  }

  /** Cancels a batch: kills what runs, ends the batch. Finished renders stay. */
  cancel(b: BatchRecord): void {
    b.cancel_requested = true;
    const now = new Date(this.deps.now()).toISOString();
    for (const item of b.items.filter((i) => i.state === "running")) {
      const job = item.job_id ? this.deps.registry.get(item.job_id) : undefined;
      if (job && job.state === "running") {
        const res = cancelAerenderJob(this.deps.registry, job, this.deps.killProcess, "ae_render_batch_cancel", this.deps.cancelHooks);
        if (res.kill_unconfirmed) {
          // Nothing was killed: the item stays running so a resume still refuses while that aerender may be writing.
          item.note = "cancel not confirmed: the aerender process could not be identified, so it was not killed";
          b.notices.push(`Item ${item.index} (job ${job.job_id}, pid ${job.pid}): the cancel could not confirm the process is an aerender, so nothing was killed and the job stays running. Check the process, then call ae_aerender_cancel for the job; ae_render_batch_resume refuses until it is gone.`);
          continue;
        }
      }
      item.state = "cancelled";
      item.error = "cancelled";
      item.stalled = false;
      item.finished_at = now;
    }
    b.state = "cancelled";
    b.finished_at = now;
    this.stopTimer(b.batch_id);
    try {
      this.store.save(b);
    } catch (err) {
      b.notices.push(`The cancelled state could not be saved to disk (${errText(err)}).`);
    }
  }

  /**
   * Gets a stopped or interrupted batch ready to run again: finished renders
   * that still verify stay, and so do items skipped on purpose (their files
   * were left alone deliberately and a resume must not overwrite them); an item
   * whose runner died is adopted when its job ended cleanly or its log says it
   * finished; everything else goes back to pending. Returns a refusal when an
   * aerender of the batch is still alive (the pid must still be an aerender).
   */
  reconcile(b: BatchRecord): { ok: true; recovered: number; reset: number; kept: number; skipped_kept: number } | { ok: false; message: string } {
    let recovered = 0;
    let reset = 0;
    let kept = 0;
    let skippedKept = 0;
    for (const item of b.items) {
      if (item.state === "running") {
        const job = item.job_id ? this.deps.registry.get(item.job_id) : undefined;
        if (job && job.state === "running" && typeof job.pid === "number" && this.deps.isPidAlive(job.pid, job.job_id)) {
          return { ok: false, message: `Item ${item.index} still has a live aerender (job ${job.job_id}, pid ${job.pid}). ${b.state === "cancelled" ? "The batch is already cancelled: stop it with ae_aerender_cancel on that job, or end the process by hand, then resume." : "Wait for it, or stop it with ae_render_batch_cancel / ae_aerender_cancel, then resume."}` };
        }
      }
    }
    for (const item of b.items) {
      if (item.state === "succeeded") {
        const v = verifyOutputs(item, item.started_at ? Date.parse(item.started_at) : null, expectedFrames(item));
        if (v.ok) {
          kept++;
          continue;
        }
        item.note = `rendered again: ${v.reason}`;
      } else if (item.state === "skipped") {
        if (verifyOutputs(item, null).ok) {
          kept++;
          skippedKept++;
          continue;
        }
        item.note = "rendered: the file it had left alone is gone";
      } else if (item.state === "running") {
        const job = item.job_id ? this.deps.registry.get(item.job_id) : undefined;
        const v = verifyOutputs(item, item.started_at ? Date.parse(item.started_at) : null, expectedFrames(item));
        // A clean exit (no 'aerender ERROR') is enough; the log wording is only the test for a job the dead runner never saw end.
        if (job && v.ok && (job.state === "succeeded" || (job.state === "running" && logFinished(job.log_path)))) {
          item.state = "succeeded";
          item.output_bytes = v.bytes;
          if (v.files !== undefined) item.output_files = v.files;
          item.percent = 100;
          item.finished_at = job.finished_at ?? new Date(this.deps.now()).toISOString();
          item.note = "finished while the runner was away; adopted on resume";
          recovered++;
          continue;
        }
        if (job && job.state === "running") {
          // Its process is gone (or the pid is no aerender any more): the registry must not call it running or let a cancel kill that pid.
          this.deps.registry.update(job.job_id, { state: "failed", error: "interrupted: its aerender process is gone", finished_at: new Date(this.deps.now()).toISOString() });
        }
        item.note = "interrupted; rendered again";
      }
      item.state = "pending";
      item.error = undefined;
      item.job_id = undefined;
      item.finished_at = undefined;
      item.percent = undefined;
      item.output_files = undefined;
      item.stalled = false;
      item.stall_noted = false;
      item.activity = undefined;
      reset++;
    }
    b.state = "running";
    b.cancel_requested = false;
    b.finished_at = null;
    return { ok: true, recovered, reset, kept, skipped_kept: skippedKept };
  }
}

/** The frame count a sequence item must reach: only when -s/-e fixed the range (for 'template' the count is a guess). */
function expectedFrames(item: BatchItem): number | null {
  return item.start_frame !== undefined && isSequencePath(item.output_path) ? item.frames : null;
}

// ---------- views ----------

function itemView(i: BatchItem) {
  return {
    index: i.index,
    comp: i.comp_name,
    spec: i.spec_name,
    state: i.state,
    output_path: i.output_path,
    ...(i.rq_index !== undefined ? { rq_index: i.rq_index, output_paths: outputsOf(i) } : {}),
    frames: i.frames,
    ...(i.percent !== undefined ? { percent: i.percent } : {}),
    ...(i.job_id ? { job_id: i.job_id } : {}),
    ...(i.error ? { error: i.error } : {}),
    ...(i.note ? { note: i.note } : {}),
    ...(i.output_bytes !== undefined ? { output_bytes: i.output_bytes } : {}),
    ...(i.output_files !== undefined ? { output_files: i.output_files } : {}),
    ...(i.stalled ? { stalled: true } : {}),
    ...(i.overwrote ? { overwrote_existing: true } : {}),
  };
}

function batchSummary(b: BatchRecord) {
  return {
    batch_id: b.batch_id,
    state: b.state,
    created_at: b.created_at,
    finished_at: b.finished_at,
    output_dir: b.output_dir,
    counts: countStates(b.items),
    total: b.items.length,
  };
}

// ---------- tools ----------

export interface RenderbatchOptions {
  registry?: AerenderJobRegistry;
  store?: BatchStore;
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
  afterFxPath?: string;
  existsSync?: (p: string) => boolean;
  now?: () => number;
  getFreeBytes?: (dir: string) => Promise<number | null>;
  isPidAlive?: (pid: number, jobId?: string) => boolean;
  killProcess?: (pid: number, signal?: string | number) => void;
  /** Test seams for the pid identity check and signal in cancel. */
  cancelHooks?: CancelHooks;
  tickMs?: number;
  /** Tests turn the background timer off and call runner.tick themselves. */
  autoTick?: boolean;
}

/**
 * Liveness of a registry pid. Dead only when the pid does not exist (ESRCH), or
 * the identity check positively found another image, or another job with a live
 * handle in this server holds the number. When the identity could not be told
 * (null) the pid counts as alive, so reconcile refuses and asks rather than
 * starting a second aerender on the same output.
 */
export const defaultIsPidAlive = (pid: number, registry?: AerenderJobRegistry, jobId?: string, identify: (pid: number) => boolean | null = (p) => isAerenderProcess(p)): boolean => {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (registry && pidHeldByLiveJob(registry, pid, jobId)) return false;
  return identify(pid) !== false;
};

function resolveOptions(
  a: Partial<Record<keyof Omit<BatchOptions, "aerender_path">, unknown>>,
  aerenderPath: string,
  base?: BatchOptions
): BatchOptions {
  const pick = <T,>(v: unknown, fallback: T): T => (v === undefined ? fallback : (v as T));
  return {
    concurrency: pick(a.concurrency, base?.concurrency ?? 1),
    max_cpu_percent: pick(a.max_cpu_percent, base?.max_cpu_percent ?? 50),
    on_error: pick(a.on_error, base?.on_error ?? "stop"),
    stall_minutes: pick(a.stall_minutes, base?.stall_minutes ?? 15),
    if_output_exists: pick(a.if_output_exists, base?.if_output_exists ?? "protect_recent"),
    protect_recent_minutes: pick(a.protect_recent_minutes, base?.protect_recent_minutes ?? 60),
    min_free_gb: pick(a.min_free_gb, base?.min_free_gb ?? 2),
    on_unknown_space: pick(a.on_unknown_space, base?.on_unknown_space ?? "continue"),
    aerender_path: aerenderPath,
  };
}

/** What renderbatchRead is asked: the comp names, and the Render Queue indexes when the job names some. */
function readArgs(job: JobInput): Record<string, unknown> {
  return { comp_names: job.comps, ...(job.queue_items.length > 0 ? { rq_items: job.queue_items.map((q) => ({ rq_index: q.rq_index })) } : {}) };
}

/** Modified time and size of a file, to notice that it changed between two looks. */
function fileSig(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
}

export function createRenderbatch(options: RenderbatchOptions = {}) {
  const getRegistry = (): AerenderJobRegistry => options.registry ?? getDefaultAerenderRegistry();
  const now = options.now ?? (() => Date.now());
  const freeBytes = options.getFreeBytes ?? ((dir: string) => getFreeBytes(dir, options.platform));
  let storeInstance: BatchStore | null = options.store ?? null;
  let runnerInstance: BatchRunner | null = null;
  const getStore = (): BatchStore => {
    if (!storeInstance) storeInstance = new BatchStore(path.join(getRegistry().rendersDir, "batches"));
    return storeInstance;
  };
  const pidAlive = options.isPidAlive ?? ((pid: number, jobId?: string) => defaultIsPidAlive(pid, getRegistry(), jobId));
  const getRunner = (): BatchRunner => {
    if (!runnerInstance) {
      runnerInstance = new BatchRunner(
        getStore(),
        {
          registry: getRegistry(),
          spawn: options.spawn ?? childProcess.spawn,
          now,
          getFreeBytes: freeBytes,
          isPidAlive: pidAlive,
          killProcess: options.killProcess,
          cancelHooks: options.cancelHooks,
        },
        { tickMs: options.tickMs ?? 5000, autoTick: options.autoTick ?? true }
      );
    }
    return runnerInstance;
  };

  const queued = (err: unknown, opId: string): never => {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  };

  /** Free space for the plan: the output folder, no estimate yet. */
  const planSpace = async (dir: string, minFreeGb: number): Promise<SpaceCheck> => {
    const free = await freeBytes(dir);
    return { dir, status: spaceStatus(free, null, minFreeGb), free_bytes: free, needed_bytes: null, checked_at: new Date(now()).toISOString() };
  };

  /** Free space on every volume the items write to; `space` is the worst row (low, then unknown, then ok). */
  const measureBatchSpace = async (
    items: Array<Pick<PlannedItem, "output_path" | "output_paths" | "rq_index">>,
    outputDir: string,
    minFreeGb: number
  ): Promise<{ space: SpaceCheck; rows: SpaceCheck[] }> => {
    const rows: SpaceCheck[] = [];
    for (const d of batchSpaceDirs(items, outputDir)) rows.push(await planSpace(d, minFreeGb));
    let space = rows[0];
    for (const r of rows) if (space.status !== "low" && (r.status === "low" || (r.status === "unknown" && space.status === "ok"))) space = r;
    return { space, rows };
  };

  const describeExisting = (items: PlannedItem[], policy: BatchOptions) =>
    items.map((it) => {
      const ex = inspectOutputs(outputsOf(it));
      const age = ex.newest_mtime_ms === null ? null : Math.max(0, Math.round((now() - ex.newest_mtime_ms) / 60_000));
      const blocks = ex.exists && policy.if_output_exists === "protect_recent" && age !== null && age < policy.protect_recent_minutes;
      return { index: it.index, exists: ex.exists, bytes: ex.bytes, age_minutes: age, ...(blocks ? { would_block: true } : {}) };
    });

  const tools: ToolDefinition<any>[] = [
    {
      name: "ae_render_batch_plan",
      description:
        "Dry run for a render batch. Expands comps x specs into items (comps outer, specs inner), names each output from name_template, and checks (queue_items are existing Render Queue items rendered through aerender -rqindex with all their output modules: each is checked for its comp id, QUEUED status and an output file on every module, the project must be saved and not dirty, and every output file is counted in the collision and overwrite checks, and free space is measured on each queue item's own output volumes): every comp name exists exactly once (aerender selects by name), the template names exist (when the render queue has an item to read them from), no two items write the same file, no output sits in _mcp_backups / _mcp_checkpoints, which outputs already exist and would be protected, and the output volume's free space ('unknown' for a UNC path, never 'ok'). " +
        "Changes nothing in After Effects or on disk. Run it before ae_render_batch; valid:false lists what to fix.",
      schema: AeRenderBatchPlanSchema,
      handler: async (args: AeRenderBatchPlanArgs, ctx: ToolContext) => {
        const job = normaliseJob(args);
        const read = (
          await ctx.bridge.callHost<RenderbatchRead>("renderbatchRead", readArgs(job), { label: "ae_render_batch_plan", mutates: false, toolName: "ae_render_batch_plan" })
        ).result;
        const items = expandItems(job, read.comps, now(), read.queue_items);
        const { errors, warnings } = validatePlan(job, read, items, [read.project_path]);
        const policy = resolveOptions(args, "");
        const { space, rows: spaceRows } = await measureBatchSpace(items, job.output_dir, policy.min_free_gb);
        if (space.status === "unknown") warnings.push("Free space on the output volume could not be measured; it is reported as unknown, not ok.");
        if (read.dirty) warnings.push("The open project has unsaved changes. ae_render_batch renders the saved file and asks for ae_save first.");
        if (read.project_path === "<unsaved>") errors.push({ code: "project_unsaved", message: "The project has never been saved; save it so there is a file to render." });
        const existing = describeExisting(items, policy);
        return {
          ok: true,
          valid: errors.length === 0,
          project_path: read.project_path,
          dirty: read.dirty,
          item_count: items.length,
          items: items.slice(0, MAX_ITEMS).map((it) => ({ ...it, existing: existing.find((e) => e.index === it.index) })),
          errors,
          warnings,
          free_space: space,
          ...(spaceRows.length > 1 ? { free_space_volumes: spaceRows } : {}),
          templates_checked: read.templates.source !== "none",
        };
      },
    },
    {
      name: "ae_render_batch",
      description:
        "Start a render batch: comps x specs (and/or existing Render Queue items from queue_items, each rendered with all its output modules through aerender -rqindex; they need a saved, not dirty project, QUEUED items and matching comp ids, checked when the batch starts) rendered one after another by background aerender processes from a frozen copy of the saved project (so later edits and saves don't leak in), given a share of the CPU (-mfr ON <max_cpu_percent>, default 50, split over the concurrent processes) and one process at a time by default (the limit counts every aerender job this server runs). " +
        "Refuses, changing nothing, when the project has unsaved changes (call ae_save first, or allow_dirty to render the saved file), the plan is invalid (see ae_render_batch_plan), or the delivery preflight finds a blocker (preflight, default true). " +
        "Before each item the runner checks free space on the output volume, will not overwrite a recently written file (if_output_exists) or write into _mcp_backups / _mcp_checkpoints, and flags an item with no progress for stall_minutes (advice only; cancel with ae_aerender_cancel). " +
        "State is kept in batch.json; poll ae_render_batch_status, continue a stopped batch with ae_render_batch_resume. Does not change the After Effects project. " +
        "Not measured yet: whether footage paths resolve from the frozen copy, how far the -mfr cap limits the CPU, and whether aerender overwrites an existing file silently. A comp with a queued render-queue item renders with that item's settings when a spec leaves out its templates, and extra output modules on it are refused. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeRenderBatchStartSchema,
      handler: async (args: AeRenderBatchStartArgs, ctx: ToolContext) => {
        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const job = normaliseJob(args);
        type Ready =
          | { ok: false; [k: string]: unknown }
          | { ok: true; project_path: string; aerenderBin: string; items: PlannedItem[]; warnings: string[]; preflight?: GateSummary; project_sig: string | null };
        let ready: Ready;
        try {
          ready = await ctx.queue.run(`ae_render_batch(${job.comps.length} comps${job.queue_items.length > 0 ? `, ${job.queue_items.length} queue items` : ""})`, async (): Promise<Ready> => {
            ctx.quarantine.assertClear();
            const statusResp = await ctx.bridge.evalRaw<{ aeVersion?: string; project_path?: string; dirty?: boolean; afterfx_path?: string; app_path?: string }>({
              id: `${opId}_status`,
              script: buildJsxCall("status", {}),
              label: "ae_render_batch (status)",
              mutates: false,
              toolName: "ae_render_batch",
            });
            const st = statusResp.result ?? {};
            const projectPath = st.project_path ?? "<unsaved>";
            if (projectPath === "<unsaved>" || args.expect.project_path === "<unsaved>") {
              throw new BridgeError({
                kind: "guard",
                op_id: opId,
                message: "Cannot start a render batch on an unsaved project (<unsaved>). Save the project to disk first.",
                expected: { project_path: args.expect.project_path, dirty: false },
                actual: { project_path: projectPath, dirty: Boolean(st.dirty) },
              });
            }
            if (!pathsMatchForGuard(args.expect.project_path, projectPath)) {
              throw new BridgeError({
                kind: "guard",
                op_id: opId,
                message: `Target guard refused ae_render_batch: expected project_path "${args.expect.project_path}", but After Effects has "${projectPath}" open.`,
                expected: args.expect,
                actual: { project_path: projectPath, dirty: Boolean(st.dirty) },
              });
            }
            if (st.dirty === true && !args.allow_dirty) {
              throw new BridgeError({
                kind: "guard",
                op_id: opId,
                message: "Cannot start a render batch because the open project has unsaved changes (dirty: true). Call ae_save first so the batch renders what you see, or pass allow_dirty to render the last saved file.",
                expected: { project_path: args.expect.project_path, dirty: false },
                actual: { project_path: projectPath, dirty: true },
              });
            }
            if (args.expect.comp_id !== undefined) await verifyTargetGuard(ctx, args.expect, opId);

            // The queue indexes are checked against this live, clean project; the frozen copy must still be this file when it is made.
            const projectSig = job.queue_items.length > 0 ? fileSig(projectPath) : null;
            const read = (
              await ctx.bridge.evalRaw<RenderbatchRead>({
                id: `${opId}_read`,
                script: buildJsxCall("renderbatchRead", readArgs(job)),
                label: "ae_render_batch (comps)",
                mutates: false,
                toolName: "ae_render_batch",
              })
            ).result as RenderbatchRead;
            const items = expandItems(job, read.comps, now(), read.queue_items);
            const { errors, warnings } = validatePlan(job, read, items, [projectPath]);
            if (errors.length > 0) {
              return {
                ok: false,
                error: "plan_invalid",
                applied: false,
                message: `The plan has ${errors.length} problem${errors.length === 1 ? "" : "s"}; nothing was started. Fix them (ae_render_batch_plan shows the full plan).`,
                errors,
                warnings,
              };
            }
            let preflight: GateSummary | undefined;
            if (args.preflight !== false) {
              const queueCompIds = job.queue_items.map((q) => q.item_comp_id);
              const gate = await runPreflightGate(ctx, {
                toolName: "ae_render_batch",
                opId,
                comp_names: job.comps.length > 0 ? job.comps : undefined,
                ...(queueCompIds.length > 0 ? { comp_ids: queueCompIds } : {}),
              });
              if (gate.blocked) return preflightRefusal("ae_render_batch", gate.summary);
              preflight = gate.summary;
            }
            const aerenderBin = resolveAerenderPath({
              platform: options.platform,
              afterFxPath: options.afterFxPath ?? st.afterfx_path ?? st.app_path,
              aeVersion: st.aeVersion,
              existsSync: options.existsSync,
            });
            if (st.dirty === true) warnings.push("The project had unsaved changes; the batch renders the last saved file on disk.");
            return { ok: true, project_path: projectPath, aerenderBin, items, warnings, preflight, project_sig: projectSig };
          });
        } catch (err) {
          return queued(err, opId);
        }
        if (!ready.ok) return ready;

        // Node only from here: the eval queue is free while the project is copied.
        const store = getStore();
        const batchId = store.newId();
        const batchDir = store.batchDir(batchId);
        const ext = path.extname(ready.project_path) || ".aep";
        const beside = args.freeze_location === "project_folder";
        const frozenDir = beside ? path.dirname(ready.project_path) : batchDir;
        const frozen = path.join(frozenDir, beside ? `${path.basename(ready.project_path, ext)}.mcp_${batchId}${ext}` : `${path.basename(ready.project_path, ext)}${ext}`);
        try {
          fs.mkdirSync(frozenDir, { recursive: true });
          fs.copyFileSync(ready.project_path, frozen);
        } catch (err) {
          return { ok: false, error: "freeze_failed", applied: false, message: `Could not copy the project to ${frozen}: ${errText(err)}. Nothing was started.` };
        }
        // Render Queue indexes were read from the project as it was; a save between the read and the copy would put another queue in the frozen file.
        if (ready.project_sig !== null && fileSig(ready.project_path) !== ready.project_sig) {
          try {
            if (beside) fs.rmSync(frozen, { force: true });
          } catch {
            // nothing more to clean up
          }
          store.forget(batchId);
          return { ok: false, error: "project_changed", applied: false, message: "The project file was saved while the batch was starting, so the Render Queue indexes just checked may not match the frozen copy. Nothing was started; plan and start again." };
        }
        const batch: BatchRecord = {
          batch_id: batchId,
          state: "running",
          created_at: new Date(now()).toISOString(),
          finished_at: null,
          cancel_requested: false,
          project_path: ready.project_path,
          frozen_project: frozen,
          ...(beside ? { frozen_temporary: true } : {}),
          batch_dir: batchDir,
          output_dir: job.output_dir,
          options: resolveOptions(args, ready.aerenderBin),
          items: ready.items.map((it) => ({ ...it, state: "pending" as const, attempts: 0 })),
          warnings: ready.warnings,
          notices: [],
          ...(ready.preflight ? { preflight: ready.preflight } : {}),
        };
        try {
          store.save(batch);
        } catch (err) {
          try {
            if (beside) fs.rmSync(frozen, { force: true });
          } catch {
            // nothing more to clean up
          }
          store.forget(batchId);
          return { ok: false, error: "state_save_failed", applied: false, message: `The batch state could not be saved (${errText(err)}); the frozen copy was removed and nothing was started.` };
        }
        let after: BatchRecord = batch;
        let saveNotice: string | undefined;
        try {
          after = (await getRunner().begin(batchId)) ?? batch;
        } catch (err) {
          saveNotice = `The batch started, but its state could not be saved: ${errText(err)}`;
        }
        return {
          ok: true,
          applied: true,
          op_id: opId,
          batch_id: batchId,
          state: after.state,
          batch_json: store.jsonPath(batchId),
          frozen_project: frozen,
          ...(beside ? { frozen_temporary: true } : {}),
          options: after.options,
          counts: countStates(after.items),
          items: after.items.slice(0, MAX_ITEMS).map(itemView),
          warnings: after.warnings,
          notices: saveNotice ? [...after.notices, saveNotice] : after.notices,
          ...(ready.preflight ? { preflight: ready.preflight } : {}),
          next: "Poll ae_render_batch_status with this batch_id. The renders run in the background; the After Effects project is untouched.",
        };
      },
    },
    {
      name: "ae_render_batch_status",
      description:
        "State of a render batch: per-item state, percent, output size and error, counts, an ETA (running items' progress plus seconds-per-frame of the finished ones), stall warnings, notices, and whether this server is still driving the batch (runner_active; false after a panel restart: call ae_render_batch_resume). " +
        "Without batch_id it lists recent batches. Read-only: nothing is started, cancelled or changed.",
      schema: AeRenderBatchStatusSchema,
      handler: async (args: AeRenderBatchStatusArgs) => {
        const store = getStore();
        if (!args.batch_id) {
          return { ok: true, batches: store.list(20).map(batchSummary) };
        }
        const stored = store.get(args.batch_id);
        if (!stored) return { ok: false, error: "not_found", message: `No render batch "${args.batch_id}".` };
        const t = now();
        // A copy: refreshing progress for the view must not touch the stored record.
        const b = JSON.parse(JSON.stringify(stored)) as BatchRecord;
        const registry = getRegistry();
        for (const item of b.items.filter((i) => i.state === "running")) {
          const job = item.job_id ? registry.get(item.job_id) : undefined;
          if (job) refreshRunning(item, job, t, b.options.stall_minutes * 60_000);
        }
        const runnerActive = getRunner().isActive(b.batch_id);
        const measured = args.include_free_space ? await measureBatchSpace(b.items, b.output_dir, b.options.min_free_gb) : null;
        const space = measured ? measured.space : b.free_space;
        // A running item whose job has no process handle here and no live aerender behind its pid is orphaned (restart, reboot), not stalled.
        const orphaned = b.items.filter((i) => {
          if (i.state !== "running" || !i.job_id) return false;
          const job = registry.get(i.job_id);
          return job !== undefined && job.state === "running" && registry.getProcess(job.job_id) === undefined && !(typeof job.pid === "number" && pidAlive(job.pid, job.job_id));
        });
        const orphanIdx = new Set(orphaned.map((i) => i.index));
        const stalled = b.items
          .filter((i) => i.state === "running" && i.stalled && !orphanIdx.has(i.index))
          .map((i) => ({ index: i.index, job_id: i.job_id, advice: "No progress for a while: check ae_aerender_status, then ae_aerender_cancel if it is stuck." }));
        return {
          ok: true,
          batch_id: b.batch_id,
          state: b.state,
          runner_active: runnerActive,
          ...(b.state === "running" && !runnerActive
            ? { advice: "This server is not driving the batch (it restarted since). Call ae_render_batch_resume to continue; finished renders are kept." }
            : {}),
          created_at: b.created_at,
          finished_at: b.finished_at,
          project_path: b.project_path,
          frozen_project: b.frozen_project,
          output_dir: b.output_dir,
          options: b.options,
          counts: countStates(b.items),
          eta: computeEta(b, t),
          items: b.items.slice(0, MAX_ITEMS).map(itemView),
          stalled,
          ...(orphaned.length > 0
            ? { orphaned: orphaned.map((i) => ({ index: i.index, job_id: i.job_id, advice: "Its aerender process is gone (the server or the machine restarted). Call ae_render_batch_resume; do not cancel it by pid." })) }
            : {}),
          warnings: b.warnings,
          notices: b.notices.slice(-50),
          ...(space ? { free_space: space } : {}),
          ...(measured && measured.rows.length > 1 ? { free_space_volumes: measured.rows } : {}),
          batch_json: store.jsonPath(b.batch_id),
        };
      },
    },
    {
      name: "ae_render_batch_resume",
      description:
        "Continue a stopped, failed or interrupted render batch from its frozen project copy. Items that finished and whose output still verifies (exists, not empty, written after the item started; an image sequence must have all its frames) are kept, and so are items skipped on purpose (if_output_exists 'skip': their files are never overwritten by a resume, whatever policy it passes); an item whose runner died is adopted when its aerender ended cleanly or its log says it finished; failed, cancelled and unstarted items run again, a failed item's partial file included. " +
        "Takes expect so the right project is open, refuses while an aerender of the batch is still alive, and can change concurrency, max_cpu_percent, on_error, stall_minutes and if_output_exists for the rest of the run. Does not change the After Effects project. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeRenderBatchResumeSchema,
      handler: async (args: AeRenderBatchResumeArgs, ctx: ToolContext) => {
        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const store = getStore();
        const batch = store.get(args.batch_id);
        if (!batch) return { ok: false, error: "not_found", applied: false, message: `No render batch "${args.batch_id}".` };
        try {
          await ctx.queue.run("ae_render_batch_resume", async () => {
            ctx.quarantine.assertClear();
            await verifyTargetGuard(ctx, args.expect, opId);
            if (!pathsMatchForGuard(args.expect.project_path, batch.project_path)) {
              throw new BridgeError({
                kind: "guard",
                op_id: opId,
                message: `Target guard refused ae_render_batch_resume: batch ${batch.batch_id} belongs to "${batch.project_path}", but expect.project_path is "${args.expect.project_path}".`,
                expected: args.expect,
                actual: { project_path: batch.project_path },
              });
            }
          });
        } catch (err) {
          return queued(err, opId);
        }
        if (!fs.existsSync(batch.frozen_project)) {
          return { ok: false, error: "frozen_project_missing", applied: false, message: `The frozen project copy ${batch.frozen_project} is gone; start a new batch.` };
        }
        const runner = getRunner();
        if (batch.state === "running" && runner.isActive(batch.batch_id)) {
          return { ok: false, error: "already_running", applied: false, message: "This batch is already running under this server." };
        }
        const rec = runner.reconcile(batch);
        if (!rec.ok) return { ok: false, error: "still_running", applied: false, message: rec.message };
        batch.options = resolveOptions(args, batch.options.aerender_path, batch.options);
        batch.notices.push(`Resumed at ${new Date(now()).toISOString()}: ${rec.kept} kept (${rec.skipped_kept} of them skipped on purpose), ${rec.recovered} adopted, ${rec.reset} to render again.`);
        try {
          store.save(batch);
        } catch (err) {
          // Nothing drives the batch: it must not claim to be running.
          batch.state = "stopped";
          batch.notices.push(`The resume could not be saved to disk (${errText(err)}); nothing was started.`);
          return { ok: false, error: "state_save_failed", applied: false, message: `The batch state could not be saved (${errText(err)}); nothing was started. Resume again once the disk problem is fixed.` };
        }
        let after: BatchRecord = batch;
        let saveNotice: string | undefined;
        try {
          after = (await runner.begin(batch.batch_id)) ?? batch;
        } catch (err) {
          saveNotice = `The batch resumed, but its state could not be saved: ${errText(err)}`;
        }
        return {
          ok: true,
          applied: true,
          op_id: opId,
          batch_id: after.batch_id,
          state: after.state,
          kept: rec.kept,
          skipped_kept: rec.skipped_kept,
          recovered: rec.recovered,
          reset: rec.reset,
          counts: countStates(after.items),
          items: after.items.slice(0, MAX_ITEMS).map(itemView),
          notices: (saveNotice ? [...after.notices, saveNotice] : after.notices).slice(-50),
        };
      },
    },
    {
      name: "ae_render_batch_cancel",
      description:
        "Cancel a render batch: terminates its running aerender processes (those items become cancelled) and ends the batch; an item whose process cannot be identified is not killed and stays running (see notices; resume refuses until it is gone); renders already finished are kept and ae_render_batch_resume can pick the rest up later. Does not change the After Effects project. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeRenderBatchCancelSchema,
      handler: async (args: AeRenderBatchCancelArgs) => {
        const store = getStore();
        const b = store.get(args.batch_id);
        if (!b) return { ok: false, error: "not_found", message: `No render batch "${args.batch_id}".` };
        if (b.state !== "running") return { ok: true, batch_id: b.batch_id, state: b.state, already_finished: true, counts: countStates(b.items) };
        getRunner().cancel(b);
        const unconfirmed = b.items.filter((i) => i.state === "running").map((i) => ({ index: i.index, job_id: i.job_id }));
        return { ok: true, batch_id: b.batch_id, state: b.state, cancelled: true, ...(unconfirmed.length > 0 ? { kill_unconfirmed: unconfirmed, notices: b.notices.slice(-10) } : {}), counts: countStates(b.items), items: b.items.slice(0, MAX_ITEMS).map(itemView) };
      },
    },
  ];

  return { tools, getRunner, getStore };
}

export function createRenderbatchTools(options: RenderbatchOptions = {}): ToolDefinition<any>[] {
  return createRenderbatch(options).tools;
}

export const renderbatchTools: ToolDefinition<any>[] = createRenderbatchTools();
