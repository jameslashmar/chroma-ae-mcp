import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall, pathsMatchForGuard } from "../../jsx.js";
import { defaultDataDir } from "../../quarantine.js";
import { QueueWaitError } from "../../queue.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { preflightRefusal, runPreflightGate, type GateSummary } from "./preflight.js";

export const WINDOWS_FALLBACK_AERENDER =
  "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe";
export const MACOS_FALLBACK_AERENDER =
  "/Applications/Adobe After Effects 2026/aerender";

export type AerenderJobState = "running" | "succeeded" | "failed";

export interface AerenderJobRecord {
  job_id: string;
  pid: number | null;
  state: AerenderJobState;
  exit_code: number | null;
  signal: string | null;
  cancelled: boolean;
  project_path: string;
  /** The comp rendered; for an rq_index job the item's comp name, for whole_queue "<render queue>". */
  comp_name: string;
  /** The -output path; for an rq_index / whole_queue job the first output module's path (the item brings its own). */
  output_path: string;
  output_module_template?: string;
  render_settings_template?: string;
  /** For an rq_index job: the item's frame range read at launch (not passed to aerender). */
  start_frame?: number;
  end_frame?: number;
  aerender_path: string;
  args: string[];
  log_path: string;
  started_at: string;
  finished_at: string | null;
  error?: string;
  /** 1-based Render Queue index of the item rendered (-rqindex). */
  rq_index?: number;
  /** The CompItem id the item was guarded with. */
  item_comp_id?: number;
  /** The whole Render Queue was rendered (no -comp, no -rqindex). */
  whole_queue?: boolean;
  /** Every output module file the render is expected to write (rq_index / whole_queue jobs). */
  output_paths?: string[];
  /** CompItem id of the rendered comp, when known. */
  comp_id?: number;
  /**
   * Where the start is. "queued": the job has not been spawned yet (state stays
   * "running" so existing readers keep waiting): it waits for an earlier aerender job,
   * the cool-down after one, or an AfterFX.com engine of an earlier job, or it waits to
   * be started again after the startup watchdog stopped an attempt. "spawned": the
   * aerender process was started. Absent on records written before this existed.
   */
  phase?: "queued" | "spawned";
  /** While queued: why the start is held back. */
  queued_reason?: string;
  /** How many times aerender was spawned for this job (the startup watchdog retries up to twice). */
  start_attempts?: number;
  /** When the job was queued instead of started at once. */
  queued_at?: string;
}

export interface AerenderProgressInfo {
  current_frame: number | null;
  last_frame: number | null;
  frames_completed: number;
  start_frame: number | null;
  end_frame: number | null;
  total_frames: number | null;
  percent: number | null;
  progress_lines_count: number;
  last_progress_line: string | null;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: childProcess.SpawnOptions
) => childProcess.ChildProcess;

export function defaultRendersDir(): string {
  return path.join(defaultDataDir(), "renders");
}

export function defaultAerenderJobsFilePath(): string {
  return path.join(defaultRendersDir(), "jobs.json");
}

/**
 * Resolves the `aerender` executable path:
 * - On Windows: looks for `aerender.exe` in the same folder as `AfterFX.exe`
 *   (from `afterFxPath` or standard Adobe After Effects install folders matching `aeVersion`),
 *   falling back to `C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe`.
 * - On macOS: looks for `aerender` in the `.app` bundle's parent folder
 *   (e.g. `/Applications/Adobe After Effects 2026/aerender`).
 */
export function resolveAerenderPath(options?: {
  platform?: NodeJS.Platform;
  afterFxPath?: string | null;
  aeVersion?: string | null;
  existsSync?: (p: string) => boolean;
}): string {
  const platform = options?.platform ?? process.platform;
  const exists = options?.existsSync ?? fs.existsSync;
  const afterFxPath = options?.afterFxPath?.trim();

  // Derive release year from aeVersion major (e.g. "26.0x68" -> 2026, "25.1" -> 2025)
  let versionYear: number | null = null;
  if (options?.aeVersion) {
    const m = /^(\d+)/.exec(options.aeVersion.trim());
    if (m) {
      const major = parseInt(m[1], 10);
      if (major >= 20 && major <= 40) {
        versionYear = 2000 + major;
      }
    }
  }

  if (platform === "darwin") {
    if (afterFxPath) {
      const norm = afterFxPath.replace(/\\/g, "/");
      const appIdx = norm.toLowerCase().indexOf(".app");
      if (appIdx !== -1) {
        // Parent folder of `<something>.app`
        const appBundlePath = norm.slice(0, appIdx + 4);
        const parentDir = path.posix.dirname(appBundlePath);
        const candidate = path.posix.join(parentDir, "aerender");
        if (exists(candidate)) {
          return candidate;
        }
        return candidate;
      }
      const dir = path.posix.dirname(norm);
      const candidate = path.posix.join(dir, "aerender");
      if (exists(candidate)) {
        return candidate;
      }
    }

    const years = versionYear
      ? [versionYear, 2026, 2025, 2024]
      : [2026, 2025, 2024];
    for (const yr of years) {
      const appParent = `/Applications/Adobe After Effects ${yr}`;
      const candidate = `${appParent}/aerender`;
      if (exists(candidate)) {
        return candidate;
      }
    }
    return MACOS_FALLBACK_AERENDER;
  }

  // Windows (default)
  if (afterFxPath) {
    const norm = afterFxPath.replace(/\\/g, "/");
    const dir = norm.toLowerCase().endsWith(".exe")
      ? path.posix.dirname(norm)
      : norm.replace(/\/+$/, "");
    const candidate = `${dir}/aerender.exe`;
    if (exists(candidate)) {
      return candidate;
    }
    return candidate;
  }

  // Check if process.execPath itself is inside an After Effects Support Files folder
  if (typeof process.execPath === "string" && process.execPath.length > 0) {
    const execDir = path.dirname(process.execPath).replace(/\\/g, "/");
    if (exists(`${execDir}/AfterFX.exe`) && exists(`${execDir}/aerender.exe`)) {
      return `${execDir}/aerender.exe`;
    }
  }

  const years = versionYear
    ? [versionYear, 2026, 2025, 2024]
    : [2026, 2025, 2024];
  for (const yr of years) {
    const supportDir = `C:/Program Files/Adobe/Adobe After Effects ${yr}/Support Files`;
    const candidate = `${supportDir}/aerender.exe`;
    if (exists(`${supportDir}/AfterFX.exe`) || exists(candidate)) {
      return candidate;
    }
  }

  return WINDOWS_FALLBACK_AERENDER;
}

export type AerenderLogLevel = "errors" | "errors_and_progress";

/** Optional aerender flags that apply to every source (comp, rq_index, whole_queue). */
export interface AerenderExtraFlags {
  /** -continueOnMissingFootage: render on although footage is missing (aerender otherwise stops). */
  continue_on_missing_footage?: boolean;
  /** -mem_usage <image cache %> <max memory %>. */
  mem_usage?: { image_cache_percent: number; max_mem_percent: number };
  /** -v ERRORS | ERRORS_AND_PROGRESS. Left out: aerender's own default (ERRORS_AND_PROGRESS), which the progress parsing needs. */
  log_level?: AerenderLogLevel;
  /** -sound ON | OFF: play a sound when the render ends. */
  sound?: boolean;
}

/**
 * Builds the CLI argument vector for `aerender`. Three sources: -comp (with
 * -output), -rqindex N (one Render Queue item, its own outputs) or neither (the
 * whole queue). Never adds -reuse: that would render inside the interactive After
 * Effects and block the bridge.
 */
export function buildAerenderArgs(
  params: {
    project_path: string;
    comp_name?: string;
    output_path?: string;
    output_module_template?: string;
    render_settings_template?: string;
    start_frame?: number;
    end_frame?: number;
    /** Adds -mfr ON <percent>: Multi-Frame Rendering capped at this share of the CPU (AE 22+). */
    max_cpu_percent?: number;
    /** Render this 1-based Render Queue item (-rqindex) instead of a comp. */
    rq_index?: number;
    /** Render the whole queue: neither -comp nor -rqindex. */
    whole_queue?: boolean;
  } & AerenderExtraFlags
): string[] {
  const cliArgs: string[] = ["-project", params.project_path];
  if (params.rq_index !== undefined) {
    cliArgs.push("-rqindex", String(params.rq_index));
  } else if (params.whole_queue !== true) {
    if (params.comp_name !== undefined) cliArgs.push("-comp", params.comp_name);
    if (params.output_path !== undefined) cliArgs.push("-output", params.output_path);
  }
  if (params.render_settings_template) {
    cliArgs.push("-RStemplate", params.render_settings_template);
  }
  if (params.output_module_template) {
    cliArgs.push("-OMtemplate", params.output_module_template);
  }
  if (params.start_frame !== undefined) {
    cliArgs.push("-s", String(params.start_frame));
  }
  if (params.end_frame !== undefined) {
    cliArgs.push("-e", String(params.end_frame));
  }
  if (params.max_cpu_percent !== undefined) {
    cliArgs.push("-mfr", "ON", String(params.max_cpu_percent));
  }
  if (params.continue_on_missing_footage === true) {
    cliArgs.push("-continueOnMissingFootage");
  }
  if (params.mem_usage !== undefined) {
    cliArgs.push("-mem_usage", String(params.mem_usage.image_cache_percent), String(params.mem_usage.max_mem_percent));
  }
  if (params.log_level !== undefined) {
    cliArgs.push("-v", params.log_level === "errors" ? "ERRORS" : "ERRORS_AND_PROGRESS");
  }
  if (params.sound !== undefined) {
    cliArgs.push("-sound", params.sound ? "ON" : "OFF");
  }
  return cliArgs;
}

/**
 * Parses `PROGRESS:` lines emitted by `aerender` to compute frame progress.
 *
 * Typical `aerender` frame lines look like:
 *   `PROGRESS:  0:00:01:12 (42): 0 Seconds`
 *   `PROGRESS:  00;00;00;05 (6): 1 Seconds`
 *   `PROGRESS:  (10): 0 Seconds`
 * Also supports `PROGRESS: Frame 42 of 100` or `PROGRESS: 42/100`.
 */
export function parseAerenderProgress(
  logText: string,
  meta?: {
    start_frame?: number;
    end_frame?: number;
    state?: AerenderJobState;
  }
): AerenderProgressInfo {
  const lines = logText.split(/\r?\n/);
  const renderedFrames: number[] = [];
  const seenFrames = new Set<number>();
  let progressLinesCount = 0;
  let lastProgressLine: string | null = null;
  let inferredTotalFrames: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!/^PROGRESS:/i.test(line)) {
      continue;
    }
    progressLinesCount++;
    lastProgressLine = line;

    // 1. Standard aerender frame line: `PROGRESS: 0:00:01:12 (42): 0 Seconds`
    const parenMatch = /^PROGRESS:\s*(?:[0-9:;.]+\s*)?\((\d+)\)\s*:/i.exec(
      line
    );
    if (parenMatch) {
      const frameNum = parseInt(parenMatch[1], 10);
      if (!Number.isNaN(frameNum)) {
        renderedFrames.push(frameNum);
        seenFrames.add(frameNum);
      }
      continue;
    }

    // 2. Alternate format: `PROGRESS: Frame 42 of 100` or `PROGRESS: 42/100`
    // Only "Frame N of M" or a bare "N/M": aerender's start line carries a date
    // ("10/27/2026 1:45:00 PM") that a looser pattern reads as frame 10 of 27.
    const fracMatch =
      /^PROGRESS:\s*(?:frame\s+(\d+)\s+of\s+(\d+)|(\d+)\s*\/\s*(\d+))\s*$/i.exec(line);
    if (fracMatch) {
      const frameNum = parseInt(fracMatch[1] ?? fracMatch[3], 10);
      const totalNum = parseInt(fracMatch[2] ?? fracMatch[4], 10);
      if (!Number.isNaN(frameNum)) {
        renderedFrames.push(frameNum);
        seenFrames.add(frameNum);
      }
      if (!Number.isNaN(totalNum) && totalNum > 0) {
        inferredTotalFrames = totalNum;
      }
    }
  }

  const currentFrame =
    renderedFrames.length > 0
      ? renderedFrames[renderedFrames.length - 1]
      : null;

  const startFrame =
    meta?.start_frame !== undefined
      ? meta.start_frame
      : renderedFrames.length > 0
      ? renderedFrames[0]
      : null;

  const endFrame = meta?.end_frame !== undefined ? meta.end_frame : null;

  const totalFrames =
    meta?.start_frame !== undefined &&
    meta?.end_frame !== undefined &&
    meta.end_frame >= meta.start_frame
      ? meta.end_frame - meta.start_frame + 1
      : inferredTotalFrames;

  const framesCompleted = seenFrames.size;

  let percent: number | null = null;
  if (totalFrames !== null && totalFrames > 0) {
    if (meta?.state === "succeeded") {
      percent = 100;
    } else if (
      currentFrame !== null &&
      startFrame !== null &&
      currentFrame >= startFrame
    ) {
      const doneBySpan = Math.max(
        framesCompleted,
        currentFrame - startFrame + 1
      );
      percent = Math.min(
        100,
        Math.max(0, Math.round((doneBySpan / totalFrames) * 10000) / 100)
      );
    } else {
      percent = Math.min(
        100,
        Math.max(0, Math.round((framesCompleted / totalFrames) * 10000) / 100)
      );
    }
  } else if (meta?.state === "succeeded") {
    percent = 100;
  }

  return {
    current_frame: currentFrame,
    last_frame: currentFrame,
    frames_completed: framesCompleted,
    start_frame: startFrame,
    end_frame: endFrame,
    total_frames: totalFrames,
    percent,
    progress_lines_count: progressLinesCount,
    last_progress_line: lastProgressLine,
  };
}

/**
 * Reads the tail of a log file (up to `maxLines` lines and `maxChars` characters).
 */
export function readLogTail(
  logPath: string,
  maxLines: number = 60,
  maxChars: number = 16_000
): { fullText: string; tail: string } {
  try {
    if (!fs.existsSync(logPath)) {
      return { fullText: "", tail: "" };
    }
    const fullText = fs.readFileSync(logPath, "utf8");
    const lines = fullText.split(/\r?\n/);
    // Drop trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const tailLines = lines.slice(-maxLines);
    let tail = tailLines.join("\n");
    if (tail.length > maxChars) {
      tail = tail.slice(-maxChars);
    }
    return { fullText, tail };
  } catch {
    return { fullText: "", tail: "" };
  }
}

/**
 * In-memory registry of background `aerender` jobs, mirrored synchronously
 * to a JSON file on disk (`%LOCALAPPDATA%\chroma-ae-mcp\renders\jobs.json`).
 */
export class AerenderJobRegistry {
  private readonly filePath: string;
  private readonly jobs: Map<string, AerenderJobRecord> = new Map();
  private readonly procs: Map<string, childProcess.ChildProcess> = new Map();
  /** The start gate and startup watchdog of this registry's jobs (see AerenderStartGate). */
  readonly gate: AerenderStartGate;

  constructor(filePath: string = defaultAerenderJobsFilePath(), gate?: Partial<AerenderGateOptions>) {
    this.filePath = filePath;
    this.gate = new AerenderStartGate(this, gate);
    this.loadFromDisk();
  }

  get path(): string {
    return this.filePath;
  }

  get rendersDir(): string {
    return path.dirname(this.filePath);
  }

  newJobId(): string {
    return `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  list(): AerenderJobRecord[] {
    return Array.from(this.jobs.values());
  }

  get(jobId: string): AerenderJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  getProcess(jobId: string): childProcess.ChildProcess | undefined {
    return this.procs.get(jobId);
  }

  register(
    record: AerenderJobRecord,
    proc?: childProcess.ChildProcess
  ): AerenderJobRecord {
    this.jobs.set(record.job_id, { ...record });
    if (proc) {
      this.procs.set(record.job_id, proc);
    }
    this.saveToDisk();
    return this.jobs.get(record.job_id)!;
  }

  /** Replaces (or, with undefined, drops) the live process handle of a job; the startup watchdog uses it between attempts. */
  setProcess(jobId: string, proc: childProcess.ChildProcess | undefined): void {
    if (proc) this.procs.set(jobId, proc);
    else this.procs.delete(jobId);
  }

  update(
    jobId: string,
    patch: Partial<AerenderJobRecord>
  ): AerenderJobRecord | undefined {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return undefined;
    }
    const updated: AerenderJobRecord = {
      ...existing,
      ...patch,
      job_id: existing.job_id,
    };
    this.jobs.set(jobId, updated);
    if (updated.state !== "running") {
      this.procs.delete(jobId);
    }
    this.saveToDisk();
    // Whatever ended the job (exit, error, cancel, an interrupted mark), the gate learns of it here.
    if (existing.state === "running" && updated.state !== "running") this.gate.noteEnded(jobId);
    return updated;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { jobs?: unknown }).jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : [];
      for (const item of list) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as AerenderJobRecord).job_id === "string"
        ) {
          const rec = item as AerenderJobRecord;
          // A job that was still waiting to start when the server went away never will.
          if (rec.state === "running" && rec.phase === "queued") {
            this.jobs.set(rec.job_id, {
              ...rec,
              state: "failed",
              error: "the server stopped while this job was queued; aerender was never started for it",
              finished_at: rec.finished_at ?? new Date().toISOString(),
            });
            continue;
          }
          this.jobs.set(rec.job_id, { ...rec });
        }
      }
    } catch {
      // Ignore unreadable mirror on startup
    }
  }

  private saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ jobs: this.list() }, null, 2);
    const tmpFile = `${this.filePath}.tmp-${process.pid}-${crypto
      .randomBytes(3)
      .toString("hex")}`;
    try {
      fs.writeFileSync(tmpFile, payload, { encoding: "utf8" });
      fs.renameSync(tmpFile, this.filePath);
    } catch {
      fs.writeFileSync(this.filePath, payload, { encoding: "utf8" });
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

let defaultRegistry: AerenderJobRegistry | null = null;

export function getDefaultAerenderRegistry(): AerenderJobRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new AerenderJobRegistry();
  }
  return defaultRegistry;
}

// ---------- Render Queue sources (-rqindex / whole queue) ----------

/** One output module of a Render Queue item, as rqeditRead reports it. */
export interface RqOutputRead {
  index: number;
  name?: string | null;
  file?: string | null;
}

/** A Render Queue item, as rqeditRead (or renderbatchRead) reports it. Status is a lower-case RQItemStatus name. */
export interface RqItemRead {
  index: number;
  comp_id: number;
  comp_name?: string;
  status?: string;
  render?: boolean;
  comp_frame_rate?: number;
  comp_duration?: number;
  time_span_start?: number;
  time_span_duration?: number;
  skip_frames?: number;
  num_output_modules?: number;
  output_modules?: RqOutputRead[];
  output_modules_truncated?: boolean;
}

export interface RqFrameRange {
  start_frame: number;
  end_frame: number;
}

/** What a rq_index / whole_queue start resolved to. */
export interface RqSelection {
  comp_name: string;
  comp_id?: number;
  comp_ids: number[];
  item_indexes: number[];
  outputs: string[];
  frame_range?: RqFrameRange;
  warnings: string[];
}

export type RqRefusal = { ok: false; code: string; message: string; expected?: unknown; actual?: unknown };

/** Why an item in this status cannot be rendered by -rqindex, with the tool that fixes it. */
export function rqStatusRefusal(index: number, status: string | undefined): string {
  const head = `Render Queue item ${index} is ${(status ?? "unknown").toUpperCase()}`;
  switch (status) {
    case "unqueued":
      return `${head}: its Render checkbox is off, so aerender would skip it. Queue it with ae_render_queue_edit (queued: true), save with ae_save, then start again.`;
    case "needs_output":
      return `${head}: it has no valid output file. Give it one with ae_render_queue_edit (output_modules[].file), queue it (queued: true), save with ae_save, then start again.`;
    case "done":
      return `${head}: it already rendered and After Effects locks it. Make a queued copy with ae_render_queue_duplicate, save with ae_save, then start again.`;
    case "rendering":
      return `${head}: the interactive After Effects is rendering it. Wait for it to finish or stop it there first.`;
    default:
      return `${head}, not QUEUED. Only a QUEUED item renders; queue it with ae_render_queue_edit (queued: true) and save with ae_save first.`;
  }
}

/** The item's time span as aerender frame numbers, or undefined when it cannot be told (no frame rate, or skip frames change the count). */
export function itemFrameRange(item: RqItemRead): RqFrameRange | undefined {
  const fps = item.comp_frame_rate;
  const start = item.time_span_start;
  const dur = item.time_span_duration;
  if (typeof fps !== "number" || !(fps > 0) || typeof start !== "number" || typeof dur !== "number" || !(dur > 0)) return undefined;
  if (typeof item.skip_frames === "number" && item.skip_frames > 0) return undefined;
  const s = Math.max(0, Math.round(start * fps));
  const n = Math.max(1, Math.round(dur * fps));
  return { start_frame: s, end_frame: s + n - 1 };
}

/** Every output module file of an item; modules without a file are listed in `missing`. */
export function itemOutputs(item: RqItemRead): { paths: string[]; missing: number[] } {
  const paths: string[] = [];
  const missing: number[] = [];
  for (const o of item.output_modules ?? []) {
    if (typeof o.file === "string" && o.file.length > 0) paths.push(o.file);
    else missing.push(o.index);
  }
  return { paths, missing };
}

/**
 * Checks one Render Queue item against the guard before aerender -rqindex:
 * it exists, is the comp the caller expected, passes the optional comp name
 * guard, is QUEUED and has a file for every output module.
 */
export function selectRqItem(
  read: { numItems?: number; items?: RqItemRead[] } | null | undefined,
  want: { rq_index: number; item_comp_id: number; comp_name?: string }
): { ok: true; selection: RqSelection } | RqRefusal {
  const item = read?.items?.find((i) => i.index === want.rq_index);
  if (!item) {
    return { ok: false, code: "rq_item_not_found", message: `No Render Queue item ${want.rq_index} (the queue has ${read?.numItems ?? 0}). Read it with ae_render_queue_inspect.` };
  }
  if (item.comp_id !== want.item_comp_id) {
    return {
      ok: false,
      code: "rq_item_comp_mismatch",
      message: `Render Queue item ${want.rq_index} is comp ${item.comp_id} ("${item.comp_name ?? "?"}"), not ${want.item_comp_id}. The queue changed since you read it; read it again.`,
      expected: want.item_comp_id,
      actual: item.comp_id,
    };
  }
  if (want.comp_name !== undefined && item.comp_name !== want.comp_name) {
    return {
      ok: false,
      code: "rq_item_name_mismatch",
      message: `Render Queue item ${want.rq_index} is comp "${item.comp_name ?? "?"}", but comp_name says "${want.comp_name}".`,
      expected: want.comp_name,
      actual: item.comp_name,
    };
  }
  if (item.status !== "queued") return { ok: false, code: "rq_item_not_queued", message: rqStatusRefusal(item.index, item.status) };
  const { paths, missing } = itemOutputs(item);
  if (missing.length > 0 || paths.length === 0) {
    return { ok: false, code: "rq_item_no_output", message: `Render Queue item ${want.rq_index} has no output file on output module(s) ${missing.join(", ") || "1"}. Give it one with ae_render_queue_edit first.` };
  }
  const warnings: string[] = [];
  if (item.output_modules_truncated) warnings.push("The item has more output modules than were read; only the first ones are listed as expected outputs.");
  const range = itemFrameRange(item);
  return {
    ok: true,
    selection: {
      comp_name: item.comp_name ?? "",
      comp_id: item.comp_id,
      comp_ids: [item.comp_id],
      item_indexes: [item.index],
      outputs: paths,
      ...(range ? { frame_range: range } : {}),
      warnings,
    },
  };
}

/** The QUEUED items a whole-queue aerender would render and the files they write; refuses when none are queued. */
export function selectWholeQueue(read: { numItems?: number; items?: RqItemRead[]; truncated?: boolean } | null | undefined): { ok: true; selection: RqSelection } | RqRefusal {
  const items = read?.items ?? [];
  const queued = items.filter((i) => i.status === "queued");
  if (queued.length === 0) {
    const others = items.filter((i) => i.status !== "queued").length;
    return {
      ok: false,
      code: "rq_queue_empty",
      message: `No item in the Render Queue is QUEUED (${items.length} item(s), ${others} not queued), so aerender would render nothing. Queue items with ae_render_queue_edit (queued: true) and save with ae_save first.`,
    };
  }
  const outputs: string[] = [];
  const warnings: string[] = [];
  for (const i of queued) {
    const { paths, missing } = itemOutputs(i);
    if (missing.length > 0 || paths.length === 0) {
      return { ok: false, code: "rq_item_no_output", message: `Queued Render Queue item ${i.index} has no output file on output module(s) ${missing.join(", ") || "1"}. Give it one with ae_render_queue_edit first.` };
    }
    outputs.push(...paths);
  }
  const skipped = items.length - queued.length;
  if (skipped > 0) warnings.push(`${skipped} item(s) are not QUEUED and will not render (UNQUEUED, DONE and the like are skipped by aerender).`);
  if (read?.truncated) warnings.push("The Render Queue was read only up to its first 500 items.");
  return {
    ok: true,
    selection: {
      comp_name: "<render queue>",
      comp_ids: Array.from(new Set(queued.map((i) => i.comp_id))),
      item_indexes: queued.map((i) => i.index),
      outputs: outputs.slice(0, 500),
      warnings,
    },
  };
}

export interface LaunchAerenderParams extends AerenderExtraFlags {
  registry: AerenderJobRegistry;
  spawn: SpawnLike;
  aerender_path: string;
  project_path: string;
  /** Optional for an rq_index / whole_queue job (the record then names the item's comp, or "<render queue>"). */
  comp_name?: string;
  output_path?: string;
  output_module_template?: string;
  render_settings_template?: string;
  start_frame?: number;
  end_frame?: number;
  /** aerender -mfr ON <percent> (AE 22+): Multi-Frame Rendering capped at this share of the CPU. */
  max_cpu_percent?: number;
  /** aerender -rqindex N: render this Render Queue item with its own outputs. */
  rq_index?: number;
  /** The comp id the rq_index was guarded with. */
  item_comp_id?: number;
  /** Render the whole queue (no -comp, no -rqindex). */
  whole_queue?: boolean;
  /** Every output file the render writes (rq_index / whole_queue); their folders are made first. */
  output_paths?: string[];
  /** CompItem id of the rendered comp, for the record. */
  comp_id?: number;
  /** The item's frame range, for the record and the progress only; not passed to aerender. */
  frame_range?: RqFrameRange;
}

// ---------- Start gate and startup watchdog ----------

/** An AfterFX.com process (the engine aerender starts) as the process list shows it. */
export interface AerenderEngineInfo {
  pid: number;
  ppid: number;
  command: string;
  /** CPU time the process has used so far (kernel + user), in ms; absent or null where the list cannot tell. */
  cpu_ms?: number | null;
}

/** What a process-list query answers: the engines, or null when the query failed or timed out ("could not tell"). */
export type AerenderEngineList = AerenderEngineInfo[] | null;

export interface AerenderGateOptions {
  /** How many aerender jobs of the registry may run at once (1: a job never starts while another is starting or running). */
  max_running: number;
  /** How long after the last aerender exit the next one may start. */
  cool_down_ms: number;
  /**
   * How long after a spawn the watchdog first looks at a job that has shown no render
   * PROGRESS line (any "PROGRESS:" line except aerender's "Launching After Effects...").
   * It does not stop the job for that alone: it takes two samples of the CPU time of the
   * job's own AfterFX.com engine, sample_gap_ms apart, and stops the job only when the
   * engine is gone or idle in both. A working engine is never stopped, however long it takes.
   */
  startup_limit_ms: number;
  /** Time between the two CPU-time samples of one check, and between rechecks of a job that was judged to be working. */
  sample_gap_ms: number;
  /** An engine whose CPU time grew by less than this share of the elapsed time between two samples counts as idle. */
  idle_cpu_ratio: number;
  /** After a job shows render progress (or when its log has no progress lines), how often its engine is looked at. */
  slow_check_ms: number;
  /** A job past its start whose engine has been gone this long, with aerender neither exited nor logging, is failed so it does not hold the slot for ever. */
  dead_engine_ms: number;
  /** How many times a hung start is retried (so up to 1 + this many spawns). */
  max_start_retries: number;
  /** How long a queued job waits for an earlier job's AfterFX.com engine to end before it fails. */
  engine_wait_ms: number;
  /** How often a queued job re-checks the gate. */
  poll_ms: number;
  /** How long the gate reuses a process-list answer; the poll never queries more often than this. */
  engine_cache_ms: number;
  now: () => number;
  /** A timer that does not keep the process alive. */
  set_timer: (fn: () => void, ms: number) => unknown;
  clear_timer: (handle: unknown) => void;
  /**
   * Every AfterFX.com process with its parent pid, CPU time and command line. May be async
   * (the default runs the process query without blocking Node). null: could not tell.
   */
  list_engines: () => AerenderEngineList | Promise<AerenderEngineList>;
  /** Whether list_engines can see engines here (Windows). Where it cannot, the gate does not look. */
  engines_known: boolean;
  /** Ends one process by pid. */
  kill_pid: (pid: number) => void;
}

/**
 * Measured on Windows (After Effects 26.2, a 5-frame PNG render): the render PROGRESS
 * line of a healthy start came within 11 s of the spawn (a cold start was under 30 s),
 * and the AfterFX.com engine of every job ended 12 to 16 s after its spawn, so the
 * engine can still be shutting down when the next job starts. Hung starts were of three
 * kinds: no launch line and an engine that exited after about 12 s, no launch line and
 * an engine that sat idle, and the launch line followed by an engine that exited after
 * about 12 s; in each one aerender then never wrote another line and never exited.
 * What was never seen to hang is a live engine that is working, so that is never stopped.
 */
export const DEFAULT_GATE_COOL_DOWN_MS = 20_000;
export const DEFAULT_GATE_STARTUP_LIMIT_MS = 45_000;
export const DEFAULT_GATE_SAMPLE_GAP_MS = 10_000;
export const DEFAULT_GATE_SLOW_CHECK_MS = 60_000;
export const DEFAULT_GATE_DEAD_ENGINE_MS = 300_000;

/** Runs a program without blocking Node and resolves with what it printed (utf8); rejects on a failure or a timeout. */
function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cp = childProcess.execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
    try {
      cp.stdin?.end();
    } catch {
      // nothing to close
    }
  });
}

/**
 * Every AfterFX.com process with its parent pid, CPU time and command line, asked
 * without blocking Node (the panel's thread also serves HTTP and the evalScript
 * callbacks). [] when none runs; null when it could not be told (not Windows, or the
 * query failed or timed out). PowerShell is told to print UTF-8, so a non-ASCII project
 * path in a command line comes back intact.
 */
export async function listEnginesAsync(
  run: (file: string, args: string[], timeoutMs: number) => Promise<string> = execFileText,
  platform: NodeJS.Platform = process.platform
): Promise<AerenderEngineList> {
  if (platform !== "win32") return null;
  try {
    // A cheap image-name check first: the slower process query only runs when an engine exists.
    const quick = await run("tasklist", ["/FI", "IMAGENAME eq AfterFX.com", "/FO", "CSV", "/NH"], 5000);
    if (!/"AfterFX\.com"/i.test(quick)) return [];
    const script =
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='AfterFX.com'\" | ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.ParentProcessId.ToString() + [char]9 + ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime).ToString() + [char]9 + $_.CommandLine }";
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
    const list: AerenderEngineInfo[] = [];
    for (const line of out.split(String.fromCharCode(10))) {
      const parts = line.replace(/\r$/, "").split(String.fromCharCode(9));
      const pid = parseInt(parts[0] ?? "", 10);
      const ppid = parseInt(parts[1] ?? "", 10);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const ticks = Number(parts[2] ?? "");
      // Win32_Process counts CPU time in 100 ns units.
      list.push({ pid, ppid, cpu_ms: Number.isFinite(ticks) && (parts[2] ?? "") !== "" ? ticks / 10_000 : null, command: parts.slice(3).join(String.fromCharCode(9)) });
    }
    return list;
  } catch {
    return null;
  }
}

function defaultGateOptions(): AerenderGateOptions {
  return {
    max_running: 1,
    cool_down_ms: DEFAULT_GATE_COOL_DOWN_MS,
    startup_limit_ms: DEFAULT_GATE_STARTUP_LIMIT_MS,
    sample_gap_ms: DEFAULT_GATE_SAMPLE_GAP_MS,
    idle_cpu_ratio: 0.01,
    slow_check_ms: DEFAULT_GATE_SLOW_CHECK_MS,
    dead_engine_ms: DEFAULT_GATE_DEAD_ENGINE_MS,
    max_start_retries: 2,
    engine_wait_ms: 120_000,
    poll_ms: 1000,
    engine_cache_ms: 5000,
    now: () => Date.now(),
    set_timer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t === "object" && t !== null && typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
      return t;
    },
    clear_timer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    list_engines: () => listEnginesAsync(),
    engines_known: process.platform === "win32",
    kill_pid: (pid) => {
      process.kill(pid);
    },
  };
}

/** One spawn attempt; the watchdog marks it stopped so its late exit event is ignored. */
interface StartAttempt {
  stopped: boolean;
}

/** One process-list answer and when its query started and finished (gate clock). */
interface EngineSample {
  list: AerenderEngineList;
  startedMs: number;
  atMs: number;
}

/** The first of the two CPU-time looks at a job's own engines. */
interface FirstLook {
  atMs: number;
  engines: Array<{ pid: number; cpu_ms: number | null }>;
}

/** What a job's own engines did between two looks. */
type CpuVerdict = "none" | "gone" | "idle" | "working" | "unknown";

/** What the gate keeps for a job it started or queued in this process. */
interface StartCtl {
  jobId: string;
  p: LaunchAerenderParams;
  cliArgs: string[];
  logPath: string;
  /** Spawns so far. */
  attempt: number;
  child: childProcess.ChildProcess | null;
  att: StartAttempt | null;
  logOffset: number;
  attemptStartMs: number;
  watchTimer: unknown;
  spawned: boolean;
  /** Pids of this job's attempts the watchdog stopped (an engine of theirs that survived is still this job's). */
  pastPids: number[];
  /** True until the job shows render progress; false from the start for log_level "errors", which prints none. */
  startPhase: boolean;
  /** The first CPU-time look of the current start check, while it waits for the second. */
  first: FirstLook | null;
  /** Since when the engine has been gone with a silent log (after the start). */
  deadSinceMs: number | null;
  /** The log size at the last slow check, -1 before the first. */
  slowLogSize: number;
  /** What holds this job back as the head of the queue (an engine pid, or "unknown"), and since when. */
  blockKey: string | null;
  blockSinceMs: number;
}

interface GateBlocker {
  text: string;
  engine?: AerenderEngineInfo;
  engineJob?: string;
  /** Whose engine it is: a job still running (no handle here, e.g. after a restart), a job that ended, or an attempt the watchdog stopped. */
  kind?: "running" | "ended" | "attempt";
  /** The process list could not be read: keep waiting for an answer. */
  unknown?: boolean;
  /** An answer is on its way. */
  pending?: boolean;
}

function normPath(s: string): string {
  return s.toLowerCase().split(String.fromCharCode(92, 92)).join("/").split(String.fromCharCode(92)).join("/");
}

/**
 * An aerender whose start hangs never writes another line and never exits (observed
 * right after another job, and later on its own as well). The gate starts a job only when no other
 * aerender job of the registry is running, the last one exited at least cool_down_ms
 * ago, and no AfterFX.com engine of an earlier job of the registry is alive; until
 * then the job is queued (state stays "running", phase "queued") and Node timers, not
 * the evalScript queue, wait for it.
 *
 * The watchdog only stops a job it is sure is hung. startup_limit_ms after a spawn, a job
 * with no render PROGRESS line gets two samples of the CPU time of its own AfterFX.com
 * engine (the process whose parent is that aerender), sample_gap_ms apart. It is stopped
 * (that aerender and that engine, nothing else) and started again, up to
 * max_start_retries times, only when the engine is gone or idle in both samples; an engine
 * that is working is never stopped, and "could not tell" (a failed process query) is
 * "keep waiting". A job that shows progress, or one run with log_level "errors" (no
 * PROGRESS lines to read), gets a slow check instead: if its engine is gone for
 * dead_engine_ms while aerender neither exits nor logs, it is failed so it cannot hold
 * the only slot for ever. Process queries run asynchronously and their answer is cached.
 */
export class AerenderStartGate {
  readonly opts: AerenderGateOptions;
  private readonly ctls = new Map<string, StartCtl>();
  private readonly queue: StartCtl[] = [];
  private pumpTimer: unknown = null;
  private lastEndMs = Number.NEGATIVE_INFINITY;
  private latest: EngineSample | null = null;
  private queryBusy = false;
  private sampleWaiters: Array<{ since: number; cb: (s: EngineSample) => void }> = [];
  private pumpRefreshing = false;
  /** The answer a pump asked for, kept for the pump that follows it (whatever its age). */
  private arrived: EngineSample | null = null;

  constructor(private readonly registry: AerenderJobRegistry, opts?: Partial<AerenderGateOptions>) {
    this.opts = { ...defaultGateOptions(), ...(opts ?? {}) };
  }

  /** Jobs of this process that wait for their start. */
  queuedJobIds(): string[] {
    return this.queue.map((c) => c.jobId);
  }

  /** Called by the registry when a job leaves "running", however it ended. */
  noteEnded(jobId: string): void {
    const ctl = this.ctls.get(jobId);
    if (!ctl) return;
    if (ctl.spawned) this.lastEndMs = this.opts.now();
    this.clearWatch(ctl);
    ctl.child = null;
    this.ctls.delete(jobId);
    const qi = this.queue.indexOf(ctl);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (this.queue.length === 0) this.stopPump();
  }

  // ---------- Process-list queries (asynchronous, one at a time, cached) ----------

  /** Runs a process-list query that starts now (or after the one in flight) and hands its answer to cb. */
  private queryEngines(cb: (s: EngineSample) => void): void {
    this.sampleWaiters.push({ since: this.opts.now(), cb });
    this.runQuery();
  }

  private runQuery(): void {
    if (this.queryBusy || this.sampleWaiters.length === 0) return;
    this.queryBusy = true;
    const startedMs = this.opts.now();
    const done = (list: AerenderEngineList): void => {
      this.queryBusy = false;
      const sample: EngineSample = { list, startedMs, atMs: this.opts.now() };
      this.latest = sample;
      // Only a query that started after a request answers it (an older one in flight may predate what the caller needs to see).
      const ready = this.sampleWaiters.filter((w) => w.since <= startedMs);
      this.sampleWaiters = this.sampleWaiters.filter((w) => w.since > startedMs);
      for (const w of ready) {
        try {
          w.cb(sample);
        } catch {
          // one waiter must not stop the others
        }
      }
      if (this.sampleWaiters.length > 0) this.runQuery();
    };
    let result: AerenderEngineList | Promise<AerenderEngineList>;
    try {
      result = this.opts.list_engines();
    } catch {
      result = null;
    }
    if (result !== null && !Array.isArray(result) && typeof (result as Promise<AerenderEngineList>).then === "function") {
      (result as Promise<AerenderEngineList>).then(
        (list) => done(Array.isArray(list) ? list : null),
        () => done(null)
      );
    } else {
      done(Array.isArray(result) ? result : null);
    }
  }

  /**
   * The latest process-list answer when it is younger than engine_cache_ms; otherwise asks
   * for a new one in the background (at most one request waits at a time) and returns null.
   * The queue poll calls this once a second and never waits for, or repeats, the query.
   */
  private freshSample(): EngineSample | null {
    const take = (): EngineSample | null => {
      const s = this.arrived;
      this.arrived = null;
      // An answer nobody picked up long ago is stale: ask again.
      return s !== null && this.opts.now() - s.atMs <= Math.max(this.opts.engine_cache_ms, 5000) ? s : null;
    };
    const fromRequest = take();
    if (fromRequest !== null) return fromRequest;
    const latest = this.latest;
    if (latest !== null && this.opts.now() - latest.atMs < this.opts.engine_cache_ms) return latest;
    if (!this.pumpRefreshing) {
      this.pumpRefreshing = true;
      this.queryEngines((sample) => {
        this.pumpRefreshing = false;
        this.arrived = sample;
        if (this.queue.length > 0) this.schedulePump(0);
      });
      // A synchronous list answers before queryEngines returns.
      return take();
    }
    return null;
  }

  /** Whether an engine of an earlier job could be alive: only then does the gate look at the process list. */
  private enginesRelevant(): boolean {
    if (!this.opts.engines_known) return false;
    if (Number.isFinite(this.lastEndMs)) return true;
    for (const c of this.ctls.values()) if (c.pastPids.length > 0) return true;
    const horizon = Date.now() - 600_000;
    for (const j of this.registry.list()) {
      if (typeof j.pid !== "number") continue;
      if (j.state === "running") return true;
      const fin = j.finished_at ? Date.parse(j.finished_at) : Number.NaN;
      if (!Number.isNaN(fin) && fin >= horizon) return true;
    }
    return false;
  }

  private blocker(): GateBlocker | null {
    let running = 0;
    let firstRunning = "";
    for (const c of this.ctls.values()) {
      if (c.child !== null) {
        running++;
        if (firstRunning === "") firstRunning = c.jobId;
      }
    }
    if (running >= this.opts.max_running) return { text: `aerender job ${firstRunning} is still running` };
    const sinceEnd = this.opts.now() - this.lastEndMs;
    if (sinceEnd < this.opts.cool_down_ms) {
      return { text: `cool-down after the last aerender exit (${Math.ceil((this.opts.cool_down_ms - sinceEnd) / 1000)} s left)` };
    }
    if (!this.enginesRelevant()) return null;
    const sample = this.freshSample();
    if (sample === null) return { text: "checking whether an AfterFX.com engine of an earlier job is still alive", pending: true };
    if (sample.list === null) {
      return { text: "could not read the process list to tell whether an AfterFX.com engine of an earlier job is still alive; waiting", unknown: true };
    }
    const jobs = this.registry.list();
    for (const e of sample.list) {
      for (const j of jobs) {
        if (j.pid !== e.ppid) continue;
        const live = this.registry.getProcess(j.job_id) !== undefined;
        // A job of this server that is running is a legitimate concurrent job, not a leftover.
        if (live && j.state === "running") continue;
        // Without a live handle (an older server run) the pid may have been reused: the project in the command line must agree.
        if (!live && e.command !== "" && !normPath(e.command).includes(normPath(j.project_path))) continue;
        if (j.state === "running") {
          return { text: `the AfterFX.com engine (pid ${e.pid}) of job ${j.job_id} is still alive (that job is still running)`, engine: e, engineJob: j.job_id, kind: "running" };
        }
        return { text: `the AfterFX.com engine (pid ${e.pid}) of job ${j.job_id} is still alive`, engine: e, engineJob: j.job_id, kind: "ended" };
      }
      for (const c of this.ctls.values()) {
        if (c.pastPids.indexOf(e.ppid) >= 0) {
          return { text: `the AfterFX.com engine (pid ${e.pid}) of an earlier attempt of job ${c.jobId} is still alive`, engine: e, engineJob: c.jobId, kind: "attempt" };
        }
      }
    }
    return null;
  }

  private note(ctl: StartCtl, text: string): void {
    try {
      fs.appendFileSync(ctl.logPath, `\n${text}\n`);
    } catch {
      // the log is a convenience
    }
  }

  /** Spawns one attempt. Throws what spawn throws. */
  private spawnProcess(ctl: StartCtl): childProcess.ChildProcess {
    let size = 0;
    try {
      size = fs.statSync(ctl.logPath).size;
    } catch {
      size = 0;
    }
    let logFd: number | null = null;
    try {
      logFd = fs.openSync(ctl.logPath, "a");
    } catch {
      logFd = null;
    }
    const stdioConfig: childProcess.StdioOptions = logFd !== null ? ["ignore", logFd, logFd] : "pipe";
    let child: childProcess.ChildProcess;
    try {
      child = ctl.p.spawn(ctl.p.aerender_path, ctl.cliArgs, { windowsHide: true, detached: true, stdio: stdioConfig });
    } finally {
      if (logFd !== null) {
        try {
          fs.closeSync(logFd);
        } catch {
          // ignore
        }
      }
    }
    ctl.attempt++;
    ctl.spawned = true;
    ctl.logOffset = size;
    ctl.attemptStartMs = this.opts.now();
    // If a test spawn mock returns readable stdout/stderr streams, append to the log.
    const logPath = ctl.logPath;
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        try {
          fs.appendFileSync(logPath, chunk);
        } catch {
          // ignore
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        try {
          fs.appendFileSync(logPath, chunk);
        } catch {
          // ignore
        }
      });
    }
    return child;
  }

  /** Wires the exit handling and the watchdog of a spawned attempt. */
  private attach(ctl: StartCtl, child: childProcess.ChildProcess): void {
    const registry = this.registry;
    const jobId = ctl.jobId;
    const logPath = ctl.logPath;
    const att: StartAttempt = { stopped: false };
    ctl.child = child;
    ctl.att = att;

    child.on("error", (err: Error) => {
      if (att.stopped) return;
      try {
        fs.appendFileSync(logPath, `\nAERENDER SPAWN ERROR: ${err.message}\n`);
      } catch {
        // ignore
      }
      const current = registry.get(jobId);
      registry.update(jobId, {
        state: "failed",
        exit_code: current?.exit_code ?? -1,
        error: err.message,
        finished_at: new Date().toISOString(),
      });
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (att.stopped) return;
      const current = registry.get(jobId);
      if (current?.cancelled) {
        registry.update(jobId, {
          state: "failed",
          exit_code: code ?? current.exit_code,
          signal: signal ?? current.signal,
          finished_at: current.finished_at ?? new Date().toISOString(),
        });
        return;
      }
      // aerender can exit 0 after a fatal error (measured: a missing
      // output-module template logs "aerender ERROR:" and exits 0), so
      // the log decides as well as the exit code.
      let logError: string | null = null;
      try {
        const m = /^aerender ERROR:?\s*(.*)$/im.exec(fs.readFileSync(logPath, "utf8"));
        if (m) logError = m[1].trim() || "aerender ERROR";
      } catch {
        logError = null;
      }
      const succeeded = code === 0 && logError === null;
      registry.update(jobId, {
        state: succeeded ? "succeeded" : "failed",
        ...(logError ? { error: logError } : {}),
        exit_code: code,
        signal: signal ?? null,
        finished_at: new Date().toISOString(),
      });
    });

    this.clearWatch(ctl);
    ctl.first = null;
    ctl.deadSinceMs = null;
    ctl.slowLogSize = -1;
    // log_level "errors" prints no PROGRESS lines, so the log says nothing about a start: only the slow, engine-based check applies.
    ctl.startPhase = ctl.p.log_level !== "errors";
    if (this.opts.engines_known) this.armWatch(ctl, att, ctl.startPhase ? this.opts.startup_limit_ms : this.opts.slow_check_ms);

    if (typeof child.unref === "function") {
      child.unref();
    }
  }

  private clearWatch(ctl: StartCtl): void {
    if (ctl.watchTimer !== null) {
      this.opts.clear_timer(ctl.watchTimer);
      ctl.watchTimer = null;
    }
  }

  private armWatch(ctl: StartCtl, att: StartAttempt, ms: number): void {
    this.clearWatch(ctl);
    ctl.watchTimer = this.opts.set_timer(() => this.onWatch(ctl, att), ms);
  }

  private watchValid(ctl: StartCtl, att: StartAttempt): boolean {
    return !att.stopped && ctl.att === att && ctl.child !== null && this.registry.get(ctl.jobId)?.state === "running";
  }

  /** What this attempt's log shows: nothing, only the launch line, or a render PROGRESS line. */
  private progressState(ctl: StartCtl): "none" | "launching" | "rendering" {
    let text = "";
    try {
      text = fs.readFileSync(ctl.logPath).subarray(ctl.logOffset).toString("utf8");
    } catch {
      return "none";
    }
    let state: "none" | "launching" | "rendering" = "none";
    for (const line of text.split(String.fromCharCode(10))) {
      if (!/^PROGRESS:/i.test(line)) continue;
      if (/^PROGRESS:\s*Launching After Effects/i.test(line)) state = "launching";
      else return "rendering";
    }
    return state;
  }

  /** The job shows render progress: from now on only the slow check applies. */
  private toSlow(ctl: StartCtl, att: StartAttempt): void {
    ctl.startPhase = false;
    ctl.first = null;
    this.armWatch(ctl, att, this.opts.slow_check_ms);
  }

  /** A watch timer fired: ask for a fresh process list and judge the job with it. */
  private onWatch(ctl: StartCtl, att: StartAttempt): void {
    ctl.watchTimer = null;
    if (!this.watchValid(ctl, att)) return;
    if (ctl.startPhase && ctl.first === null && this.progressState(ctl) === "rendering") {
      this.toSlow(ctl, att);
      return;
    }
    this.queryEngines((s) => this.judge(ctl, att, s));
  }

  private judge(ctl: StartCtl, att: StartAttempt, s: EngineSample): void {
    if (!this.watchValid(ctl, att)) return;
    const child = ctl.child;
    const pid = child !== null && typeof child.pid === "number" ? child.pid : null;
    if (child === null || pid === null || s.list === null) {
      // Could not tell: keep waiting, never stop a job on it.
      ctl.first = null;
      this.armWatch(ctl, att, ctl.startPhase ? this.opts.sample_gap_ms : this.opts.slow_check_ms);
      return;
    }
    const own = s.list.filter((e) => e.ppid === pid);
    if (ctl.startPhase) this.judgeStart(ctl, att, child, pid, own, s);
    else this.judgeSlow(ctl, att, child, pid, own, s);
  }

  private cpuVerdict(first: FirstLook, now: Array<{ pid: number; cpu_ms: number | null }>, atMs: number): CpuVerdict {
    if (now.length === 0) return first.engines.length === 0 ? "none" : "gone";
    if (first.engines.length === 0) return "working"; // an engine appeared since the first look
    const elapsed = atMs - first.atMs;
    if (elapsed <= 0) return "unknown";
    for (const e of now) {
      const before = first.engines.find((f) => f.pid === e.pid);
      if (!before) return "working"; // a different engine
      if (e.cpu_ms === null || before.cpu_ms === null) return "unknown";
      const delta = e.cpu_ms - before.cpu_ms;
      if (delta < 0) return "unknown";
      if (delta > this.opts.idle_cpu_ratio * elapsed) return "working";
    }
    return "idle";
  }

  /**
   * The start check: no render PROGRESS line yet. Two looks at the job's own engine, sample_gap_ms
   * apart. Stopped only when the engine is absent, gone or idle in both; anything else keeps waiting.
   */
  private judgeStart(ctl: StartCtl, att: StartAttempt, child: childProcess.ChildProcess, pid: number, own: AerenderEngineInfo[], s: EngineSample): void {
    if (this.progressState(ctl) === "rendering") {
      this.toSlow(ctl, att);
      return;
    }
    const mine = own.map((e) => ({ pid: e.pid, cpu_ms: typeof e.cpu_ms === "number" ? e.cpu_ms : null }));
    const first = ctl.first;
    if (first === null) {
      ctl.first = { atMs: s.atMs, engines: mine };
      this.armWatch(ctl, att, this.opts.sample_gap_ms);
      return;
    }
    ctl.first = null;
    const verdict = this.cpuVerdict(first, mine, s.atMs);
    if (verdict === "none" || verdict === "gone" || verdict === "idle") {
      const elapsedS = Math.round((s.atMs - first.atMs) / 1000);
      let why = "it had no AfterFX.com engine";
      if (verdict === "gone") why = "its AfterFX.com engine had exited";
      else if (verdict === "idle") why = `its AfterFX.com engine was idle (its CPU time did not grow over ${elapsedS} s)`;
      this.stopAttempt(ctl, att, child, pid, own, why);
      return;
    }
    // Working, or not clear: keep waiting and look again later.
    this.armWatch(ctl, att, Math.max(this.opts.sample_gap_ms, this.opts.startup_limit_ms / 2));
  }

  /**
   * The slow check, after the start (or for log_level "errors"): an engine that is gone while
   * aerender neither exits nor logs for dead_engine_ms would hold the only slot for ever.
   */
  private judgeSlow(ctl: StartCtl, att: StartAttempt, child: childProcess.ChildProcess, pid: number, own: AerenderEngineInfo[], s: EngineSample): void {
    let size = -1;
    try {
      size = fs.statSync(ctl.logPath).size;
    } catch {
      size = -1;
    }
    const grew = ctl.slowLogSize >= 0 && size !== ctl.slowLogSize;
    ctl.slowLogSize = size;
    if (own.length > 0 || grew) ctl.deadSinceMs = null;
    else if (ctl.deadSinceMs === null) ctl.deadSinceMs = s.atMs;
    if (ctl.deadSinceMs !== null && s.atMs - ctl.deadSinceMs >= this.opts.dead_engine_ms) {
      const minutes = Math.max(1, Math.round((s.atMs - ctl.deadSinceMs) / 60_000));
      att.stopped = true;
      ctl.child = null;
      ctl.pastPids.push(pid);
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.lastEndMs = this.opts.now();
      const message = `aerender stopped working: its own AfterFX.com engine has been gone for ${minutes} min while aerender (pid ${pid}) neither exited nor wrote to its log. It was stopped so it no longer holds the render slot. The render is incomplete; check the output and start it again.`;
      this.note(ctl, `AERENDER WATCHDOG: ${message}`);
      this.registry.update(ctl.jobId, { state: "failed", error: message, finished_at: new Date().toISOString() });
      return;
    }
    this.armWatch(ctl, att, this.opts.slow_check_ms);
  }

  /**
   * The engine is gone or idle and no render PROGRESS line came: this attempt's aerender is
   * stopped together with the AfterFX.com process whose parent pid is that aerender (never
   * another engine, never AfterFX.exe), and the job is queued for another attempt, or failed
   * after the last.
   */
  private stopAttempt(ctl: StartCtl, att: StartAttempt, child: childProcess.ChildProcess, pid: number, own: AerenderEngineInfo[], why: string): void {
    att.stopped = true;
    ctl.child = null;
    ctl.pastPids.push(pid);
    const killedEngines: number[] = [];
    for (const e of own) {
      try {
        this.opts.kill_pid(e.pid);
        killedEngines.push(e.pid);
      } catch {
        // already gone
      }
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.lastEndMs = this.opts.now();
    const waitedS = Math.round((this.opts.now() - ctl.attemptStartMs) / 1000);
    const what = `stopped aerender pid ${pid}${killedEngines.length > 0 ? ` and its AfterFX.com engine pid ${killedEngines.join(", ")}` : " (no AfterFX.com engine of its own was left to stop)"}`;
    const attempts = ctl.attempt;
    if (attempts <= this.opts.max_start_retries) {
      this.note(ctl, `AERENDER WATCHDOG: no render PROGRESS line ${waitedS} s after attempt ${attempts} was spawned and ${why}; ${what}; starting again (attempt ${attempts + 1} of ${this.opts.max_start_retries + 1}) after the cool-down.`);
      this.registry.setProcess(ctl.jobId, undefined);
      this.registry.update(ctl.jobId, {
        pid: null,
        phase: "queued",
        queued_reason: `attempt ${attempts} showed no render PROGRESS line after ${waitedS} s and ${why}; it was stopped; waiting to start again`,
        start_attempts: attempts,
      });
      ctl.blockKey = null;
      this.queue.unshift(ctl);
      this.schedulePump(0);
      return;
    }
    const message = `aerender never started rendering: its log showed no render PROGRESS line (nothing after "Launching After Effects...") on each of ${attempts} attempts, and each time its own AfterFX.com engine was gone or idle (last attempt: ${why}). Each time its aerender and that engine were stopped (${what.replace(/^stopped /, "")} on the last). Check that After Effects is not blocked by a dialog and that no other aerender is starting, then run it again.`;
    this.note(ctl, `AERENDER WATCHDOG: ${message}`);
    this.registry.update(ctl.jobId, {
      state: "failed",
      error: message,
      start_attempts: attempts,
      finished_at: new Date().toISOString(),
    });
  }

  /**
   * Ends the AfterFX.com engines whose parent is `pid` (a cancelled job's aerender), so a
   * leftover engine does not block every later job. Asks for a fresh process list in the
   * background; "could not tell" ends nothing.
   */
  stopEnginesOf(pid: number | undefined | null, logPath: string): void {
    if (typeof pid !== "number" || pid <= 0 || !this.opts.engines_known) return;
    this.queryEngines((s) => {
      if (s.list === null) return;
      const killed: number[] = [];
      for (const e of s.list) {
        if (e.ppid !== pid) continue;
        try {
          this.opts.kill_pid(e.pid);
          killed.push(e.pid);
        } catch {
          // already gone
        }
      }
      if (killed.length > 0) {
        try {
          fs.appendFileSync(logPath, `\nAERENDER CANCEL: also ended its AfterFX.com engine pid ${killed.join(", ")}\n`);
        } catch {
          // the log is a convenience
        }
      }
    });
  }

  private stopPump(): void {
    if (this.pumpTimer !== null) {
      this.opts.clear_timer(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private schedulePump(ms: number): void {
    this.stopPump();
    this.pumpTimer = this.opts.set_timer(() => {
      this.pumpTimer = null;
      this.pump();
    }, ms);
  }

  /** Starts the head of the queue when the gate is clear; the rest wait their turn. */
  pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const now = this.opts.now();
      const b = this.blocker();
      // How long this job, as the head of the queue, has been held back by the same engine (or by an unreadable process list).
      // A pending answer says nothing new about the gate: the clock and the reason stay as they were.
      // The key names the owner and its kind, so time spent behind a running job's engine does not count once that job ends.
      let key: string | null = null;
      if (b !== null && b.engine) key = `engine:${b.engine.pid}:${b.kind ?? ""}:${b.engineJob ?? ""}`;
      else if (b !== null && b.unknown) key = "unknown";
      if (!(b !== null && b.pending) && key !== head.blockKey) {
        head.blockKey = key;
        head.blockSinceMs = now;
      }
      if (b === null) {
        this.queue.shift();
        this.startQueued(head);
        continue;
      }
      const waitedMs = now - head.blockSinceMs;
      if (b.engine && b.kind !== "running" && waitedMs > this.opts.engine_wait_ms) {
        this.queue.shift();
        const message = this.engineWaitMessage(head, b, Math.round(waitedMs / 1000));
        this.note(head, `AERENDER QUEUE: ${message}`);
        this.registry.update(head.jobId, { state: "failed", error: message, finished_at: new Date().toISOString() });
        continue;
      }
      if (b.unknown && waitedMs > this.opts.engine_wait_ms) {
        // The process list stayed unreadable: starting is the old behaviour, and the watchdog still guards the start.
        this.note(head, `AERENDER QUEUE: the process list could not be read for ${Math.round(waitedMs / 1000)} s; starting without knowing whether an earlier engine is alive.`);
        this.queue.shift();
        this.startQueued(head);
        continue;
      }
      const job = this.registry.get(head.jobId);
      // A refresh in flight keeps an answer already given about an engine or the process list; a cool-down or running-job reason is out of date by then.
      const keepKnown = b.pending === true && !!job && /AfterFX\.com engine|process list/.test(job.queued_reason ?? "");
      if (job && !keepKnown && job.queued_reason !== b.text && !/waiting to start again/.test(job.queued_reason ?? "")) {
        this.registry.update(head.jobId, { queued_reason: b.text });
      }
      break;
    }
    if (this.queue.length > 0) this.schedulePump(this.opts.poll_ms);
  }

  private engineWaitMessage(head: StartCtl, b: GateBlocker, waitedS: number): string {
    const pid = b.engine?.pid ?? 0;
    const tail = "end it yourself (Task Manager), then start the render again.";
    if (b.kind === "attempt" && b.engineJob === head.jobId) {
      return `aerender was not started: the AfterFX.com engine (pid ${pid}) of an earlier attempt of this job is still alive ${waitedS} s after the watchdog stopped that attempt (its engine was ended then and survived). It is not ended again; ${tail}`;
    }
    if (b.kind === "attempt") {
      return `aerender was not started: ${b.text}, ${waitedS} s after this job began to wait for it. That process belongs to another job and is not touched; ${tail}`;
    }
    return `aerender was not started: ${b.text}, ${waitedS} s after this job began to wait for it. That process is not this job's and is not touched; ${tail}`;
  }

  private startQueued(ctl: StartCtl): void {
    let child: childProcess.ChildProcess;
    try {
      child = this.spawnProcess(ctl);
    } catch (err) {
      const message = `could not start aerender: ${err instanceof Error ? err.message : String(err)}`;
      this.note(ctl, `AERENDER SPAWN ERROR: ${message}`);
      this.registry.update(ctl.jobId, { state: "failed", error: message, finished_at: new Date().toISOString() });
      return;
    }
    this.registry.setProcess(ctl.jobId, child);
    const first = (this.registry.get(ctl.jobId)?.start_attempts ?? 0) === 0;
    this.registry.update(ctl.jobId, {
      pid: typeof child.pid === "number" ? child.pid : null,
      phase: "spawned",
      queued_reason: undefined,
      start_attempts: ctl.attempt,
      ...(first ? { started_at: new Date().toISOString() } : {}),
    });
    this.attach(ctl, child);
  }

  /**
   * Starts the job now when the gate is clear and nothing is queued ahead of it (the
   * spawn happens before this returns, as it always did); otherwise registers it as
   * queued and lets the pump start it. A spawn that throws on the immediate path
   * throws from here with nothing registered.
   */
  start(p: LaunchAerenderParams, jobId: string, logPath: string, cliArgs: string[], record: AerenderJobRecord): AerenderJobRecord {
    const ctl: StartCtl = {
      jobId,
      p,
      cliArgs,
      logPath,
      attempt: 0,
      child: null,
      att: null,
      logOffset: 0,
      attemptStartMs: 0,
      watchTimer: null,
      spawned: false,
      pastPids: [],
      startPhase: true,
      first: null,
      deadSinceMs: null,
      slowLogSize: -1,
      blockKey: null,
      blockSinceMs: 0,
    };
    const blocker: GateBlocker | null = this.queue.length === 0 ? this.blocker() : { text: "waiting for earlier queued aerender jobs" };
    if (blocker === null) {
      const child = this.spawnProcess(ctl);
      const registered = this.registry.register(
        { ...record, pid: typeof child.pid === "number" ? child.pid : null, phase: "spawned", start_attempts: ctl.attempt },
        child
      );
      this.ctls.set(jobId, ctl);
      this.attach(ctl, child);
      return registered;
    }
    const registered = this.registry.register({
      ...record,
      pid: null,
      phase: "queued",
      queued_reason: blocker.text,
      queued_at: new Date().toISOString(),
      start_attempts: 0,
    });
    this.ctls.set(jobId, ctl);
    this.queue.push(ctl);
    this.note(ctl, `AERENDER QUEUED: ${blocker.text}. It starts when aerender can start safely (one job at a time, ${Math.round(this.opts.cool_down_ms / 1000)} s after the last one, no AfterFX.com engine of an earlier job alive).`);
    this.schedulePump(this.opts.poll_ms);
    return registered;
  }
}

/**
 * Starts one background aerender, logs it to <job>.log and tracks it in the
 * registry until it exits. ae_aerender_start and the render-batch runner both
 * go through here, so a job behaves the same whichever started it. The registry's
 * start gate may hold the job back (phase "queued", state "running", pid null)
 * and its startup watchdog may restart a start that hangs; see AerenderStartGate.
 */
export function launchAerenderJob(p: LaunchAerenderParams): AerenderJobRecord {
  const registry = p.registry;
  const jobId = registry.newJobId();
  const rendersDir = registry.rendersDir;
  fs.mkdirSync(rendersDir, { recursive: true });
  // The output folders are made here (the -output folder, or every output module's folder of a queue item).
  const outPaths = p.output_paths && p.output_paths.length > 0 ? p.output_paths : p.output_path !== undefined ? [p.output_path] : [];
  for (const out of outPaths) {
    const outDir = path.dirname(out);
    if (outDir && outDir !== ".") {
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch {
        // Output dir may be on a virtual path in tests
      }
    }
  }

  const logPath = path.join(rendersDir, `${jobId}.log`);
  fs.writeFileSync(logPath, "", { encoding: "utf8" });

  const cliArgs = buildAerenderArgs({
    project_path: p.project_path,
    comp_name: p.comp_name,
    output_path: p.output_path,
    output_module_template: p.output_module_template,
    render_settings_template: p.render_settings_template,
    start_frame: p.start_frame,
    end_frame: p.end_frame,
    max_cpu_percent: p.max_cpu_percent,
    rq_index: p.rq_index,
    whole_queue: p.whole_queue,
    continue_on_missing_footage: p.continue_on_missing_footage,
    mem_usage: p.mem_usage,
    log_level: p.log_level,
    sound: p.sound,
  });

  const initialRecord: AerenderJobRecord = {
    job_id: jobId,
    pid: null,
    state: "running",
    exit_code: null,
    signal: null,
    cancelled: false,
    project_path: p.project_path,
    comp_name: p.comp_name ?? (p.whole_queue === true ? "<render queue>" : ""),
    output_path: p.output_path ?? p.output_paths?.[0] ?? "",
    ...(p.output_module_template
      ? { output_module_template: p.output_module_template }
      : {}),
    ...(p.render_settings_template
      ? { render_settings_template: p.render_settings_template }
      : {}),
    ...(p.start_frame !== undefined
      ? { start_frame: p.start_frame }
      : p.frame_range
      ? { start_frame: p.frame_range.start_frame }
      : {}),
    ...(p.end_frame !== undefined
      ? { end_frame: p.end_frame }
      : p.frame_range
      ? { end_frame: p.frame_range.end_frame }
      : {}),
    ...(p.rq_index !== undefined ? { rq_index: p.rq_index } : {}),
    ...(p.item_comp_id !== undefined ? { item_comp_id: p.item_comp_id } : {}),
    ...(p.whole_queue === true ? { whole_queue: true } : {}),
    ...(p.output_paths && p.output_paths.length > 0 ? { output_paths: p.output_paths } : {}),
    ...(p.comp_id !== undefined ? { comp_id: p.comp_id } : {}),
    aerender_path: p.aerender_path,
    args: cliArgs,
    log_path: logPath,
    started_at: new Date().toISOString(),
    finished_at: null,
  };

  return registry.gate.start(p, jobId, logPath, cliArgs, initialRecord);
}


/**
 * Whether `pid` is a running process whose image is aerender. A pid from the
 * registry after a restart or reboot may belong to anything else by now (pids
 * are reused quickly on Windows), so a kill or a liveness test by pid alone is
 * not safe. Three answers: true (it is an aerender), false (positively another
 * image, or no such process), null (could not tell: the lookup threw, timed
 * out or printed something unexpected). Windows asks tasklist, macOS ps (where
 * aerender may hand off to aerendercore, so both names count). A kill acts on
 * true only; a liveness test treats null as alive. The start time is not
 * compared (neither tool gives it cheaply).
 */
export function isAerenderProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => string = (file, args) =>
    String(childProcess.execFileSync(file, args, { windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }))
): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (platform === "win32") {
      const out = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const lines = out.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.length > 0);
      let sawRow = false;
      for (const l of lines) {
        const m = /^"([^"]*)","(\d+)"/.exec(l);
        if (m === null) continue;
        sawRow = true;
        if (m[2] === String(pid)) return /^aerender(?:\.exe)?$/i.test(m[1]);
      }
      if (sawRow) return false;
      if (/^INFO:/i.test(lines[0] ?? "")) return false;
      return null;
    }
    const out = run("ps", ["-p", String(pid), "-o", "comm="]).trim();
    if (out === "") return null;
    return /(^|\/)aerender(core)?$/i.test(out);
  } catch {
    return null;
  }
}

/** True when another registry job with a live process handle in this server owns `pid` (a reused pid must not be mistaken for an old job's). */
export function pidHeldByLiveJob(registry: AerenderJobRegistry, pid: number, exceptJobId?: string): boolean {
  return registry.list().some((j) => j.job_id !== exceptJobId && j.pid === pid && registry.getProcess(j.job_id) !== undefined);
}

/** What the pid-based kill did: killed (signal sent to a positive aerender), other (the pid is held by another live job or positively not an aerender, so ours is gone), unknown (identity could not be told, nothing was signalled). */
export type PidKillOutcome = "killed" | "other" | "unknown";

/** Test seams for the default pid kill. */
export interface CancelHooks {
  identify?: (pid: number) => boolean | null;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
}

/**
 * Stops a running job: terminates its process (or, after a restart, the pid
 * from the registry, but only when the pid is positively an aerender and no
 * other job with a live handle in this server holds it), notes the cancel in
 * the log and marks the job failed with cancelled: true. When the pid's
 * identity could not be told (the lookup failed), nothing is killed and the job
 * stays 'running' with kill_unconfirmed: true, so a later resume still refuses
 * instead of starting a second aerender on the same output. ae_aerender_cancel
 * and the render-batch cancel share it.
 */
export function cancelAerenderJob(
  registry: AerenderJobRegistry,
  job: AerenderJobRecord,
  killProcess?: (pid: number, signal?: string | number) => void,
  by = "ae_aerender_cancel",
  hooks: CancelHooks = {}
): AerenderJobRecord & { kill_unconfirmed?: boolean } {
  const proc = registry.getProcess(job.job_id);
  if (proc) {
    // Its own AfterFX.com engine would outlive it and block every later job (the gate waits for a leftover engine), so it goes too.
    registry.gate.stopEnginesOf(typeof proc.pid === "number" ? proc.pid : job.pid, job.log_path);
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore if already dead
    }
  } else if (typeof job.pid === "number" && job.pid > 0) {
    let outcome: PidKillOutcome = "killed";
    if (killProcess) {
      try {
        killProcess(job.pid, "SIGTERM");
      } catch {
        // ignore ESRCH if process already exited
      }
    } else {
      // Without a live handle the pid is only trusted when it still is an aerender.
      if (pidHeldByLiveJob(registry, job.pid, job.job_id)) outcome = "other";
      else {
        const identity = (hooks.identify ?? ((p: number) => isAerenderProcess(p)))(job.pid);
        if (identity === true) {
          try {
            (hooks.signal ?? ((p: number, sig: NodeJS.Signals) => { process.kill(p, sig); }))(job.pid, "SIGTERM");
          } catch {
            // ignore ESRCH if process already exited
          }
        } else if (identity === false) outcome = "other";
        else outcome = "unknown";
      }
    }
    if (outcome === "unknown") {
      try {
        fs.appendFileSync(
          job.log_path,
          `
AERENDER CANCEL by ${by} at ${new Date().toISOString()} could not confirm that pid ${job.pid} is this job's aerender; nothing was killed and the job stays running.
`
        );
      } catch {
        // ignore
      }
      return { ...(registry.get(job.job_id) ?? job), kill_unconfirmed: true };
    }
  }

  try {
    fs.appendFileSync(
      job.log_path,
      `
AERENDER CANCELLED by ${by} at ${new Date().toISOString()}
`
    );
  } catch {
    // ignore
  }

  return registry.update(job.job_id, {
    state: "failed",
    cancelled: true,
    finished_at: new Date().toISOString(),
  })!;
}

export const AeAerenderStartSchema = z
  .object({
    expect: ExpectSchema,
    comp_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of the composition to render (aerender -comp). Needed, with output_path, unless rq_index or whole_queue picks the source. With rq_index it is an extra guard: it must equal the queue item's comp name."
      ),
    output_path: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute output file path for aerender (-output). Required with comp_name; refused with rq_index / whole_queue (the queue items bring their own output files)."),
    rq_index: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Render this 1-based Render Queue item (aerender -rqindex) with all its output modules and its own render settings: the way to render items built with ae_render_queue_edit, ae_render_queue_duplicate or ae_render_queue_apply_spec. Needs item_comp_id. The project must be saved and not dirty (aerender reads the saved file, so items added since the last save are not in it), and the item must be QUEUED (ae_render_queue_edit queued: true, then ae_save). Indexes shift when items are added or removed: read the queue right before."
      ),
    item_comp_id: z
      .number()
      .int()
      .optional()
      .describe("With rq_index: the CompItem id the queue item at rq_index must have (ae_render_queue_inspect shows it). The tool refuses when the item at that index is another comp."),
    whole_queue: z
      .boolean()
      .optional()
      .describe("Render every QUEUED item of the Render Queue in one aerender run (no -comp, no -rqindex). Refused when nothing is queued. The project must be saved and not dirty."),
    output_module_template: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Output Module template name (-OMtemplate). Not with rq_index / whole_queue: the queue item's own output modules are used."),
    render_settings_template: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Render Settings template name (-RStemplate). Not with rq_index / whole_queue: the queue item's own render settings are used."),
    start_frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Optional start frame index (-s). Not with rq_index / whole_queue (the item's time span applies)."),
    end_frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Optional end frame index (-e). Not with rq_index / whole_queue (the item's time span applies)."),
    preflight: z
      .boolean()
      .optional()
      .describe(
        "Run the ae_preflight delivery check on this comp (by name; for rq_index / whole_queue the queue item's comp or comps, by id) and the comps it nests first, and refuse to start if it finds a blocker (missing footage or fonts, expressions in error, comp not found). Nothing is started when it refuses. Default false."
      ),
    continue_on_missing_footage: z
      .boolean()
      .optional()
      .describe("Pass -continueOnMissingFootage: render although footage is missing (aerender otherwise stops with an error). The missing footage shows as placeholder color bars in the output. Default false."),
    mem_usage: z
      .object({
        image_cache_percent: z.number().int().min(1).max(100).describe("Share of RAM for the image cache, percent."),
        max_mem_percent: z.number().int().min(1).max(100).describe("Share of RAM After Effects may use in all, percent."),
      })
      .optional()
      .describe("Pass -mem_usage <image_cache_percent> <max_mem_percent>: caps the memory aerender uses."),
    log_level: z
      .enum(["errors", "errors_and_progress"])
      .optional()
      .describe("aerender -v: 'errors' logs only errors, 'errors_and_progress' (aerender's own default) also the PROGRESS lines that ae_aerender_status turns into a percent. Leave it out to keep the progress. With 'errors' there are no PROGRESS lines, so ae_aerender_status shows no percent and the startup watchdog (which restarts a hung start) is off for that job; only the slow dead-engine check applies."),
    sound: z.boolean().optional().describe("Pass -sound ON or OFF: play a sound when the render finishes. Leave out to keep aerender's default."),
  })
  .superRefine((val, ctx) => {
    const issue = (p: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message });
    if (val.start_frame !== undefined && val.end_frame !== undefined && val.end_frame < val.start_frame) {
      issue("end_frame", "`end_frame` must be >= `start_frame`.");
    }
    const fromQueue = val.rq_index !== undefined || val.whole_queue === true;
    if (val.whole_queue === true && val.rq_index !== undefined) {
      issue("whole_queue", "Give one source: `whole_queue` or `rq_index`, not both.");
    }
    if (val.whole_queue === true && val.comp_name !== undefined) {
      issue("comp_name", "`comp_name` does not go with `whole_queue`: the whole queue is rendered. Give one source.");
    }
    if (val.item_comp_id !== undefined && val.rq_index === undefined) {
      issue("item_comp_id", "`item_comp_id` goes with `rq_index`.");
    }
    if (val.rq_index !== undefined && val.item_comp_id === undefined) {
      issue("item_comp_id", "`rq_index` needs `item_comp_id`, the comp id the item must have, so a shifted queue cannot render the wrong item (ae_render_queue_inspect shows it).");
    }
    if (fromQueue) {
      for (const k of ["output_path", "output_module_template", "render_settings_template", "start_frame", "end_frame"] as const) {
        if (val[k] !== undefined) {
          issue(k, `\`${k}\` is refused with \`rq_index\` / \`whole_queue\`: it would override what the queue item holds. Change the item with ae_render_queue_edit instead.`);
        }
      }
    } else {
      if (val.comp_name === undefined) issue("comp_name", "Required: the comp to render, unless `rq_index` or `whole_queue` is given.");
      if (val.output_path === undefined) issue("output_path", "Required with `comp_name`.");
    }
  });

export type AeAerenderStartArgs = z.infer<typeof AeAerenderStartSchema>;

export const AeAerenderStatusSchema = z.object({
  job_id: z.string().min(1).describe("Background aerender job ID."),
});

export type AeAerenderStatusArgs = z.infer<typeof AeAerenderStatusSchema>;

export const AeAerenderCancelSchema = z.object({
  job_id: z.string().min(1).describe("Background aerender job ID to cancel."),
});

export type AeAerenderCancelArgs = z.infer<typeof AeAerenderCancelSchema>;

export interface AerenderToolsOptions {
  registry?: AerenderJobRegistry;
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
  afterFxPath?: string;
  existsSync?: (p: string) => boolean;
  killProcess?: (pid: number, signal?: string | number) => void;
  /** Test seams for the pid identity check and signal used by the default kill. */
  cancelHooks?: CancelHooks;
}

/**
 * Creates the `aerender` tool definitions with optional dependency injection
 * for unit testing (custom job registry, spawn mock, platform/path overrides).
 */
export function createAerenderTools(
  options: AerenderToolsOptions = {}
): ToolDefinition<any>[] {
  const getRegistry = (): AerenderJobRegistry =>
    options.registry ?? getDefaultAerenderRegistry();
  const spawnFn: SpawnLike = options.spawn ?? childProcess.spawn;

  return [
    {
      name: "ae_aerender_start",
      description:
        "Start a background `aerender` process (`windowsHide: true`, detached) for a saved, non-dirty After Effects project (with preflight: true, after an ae_preflight delivery check that refuses on a blocker), logging stdout/stderr to `%LOCALAPPDATA%\\chroma-ae-mcp\\renders\\<job>.log` and tracking the job in a JSON-mirrored registry. " +
        "Exactly one source: comp_name with output_path (aerender -comp), rq_index with item_comp_id (-rqindex: one existing Render Queue item with all its output modules and its own settings, the way to render items built with ae_render_queue_edit / _duplicate / _apply_spec) or whole_queue (every QUEUED item). " +
        "A queue source needs a saved, non-dirty project (aerender reads the saved file: items added since the last save are not in it), the item QUEUED (ae_render_queue_edit queued: true, then ae_save) and its comp id matching item_comp_id; it is re-read through ae_render_queue_inspect's reader right before the spawn and refused with the reason otherwise. " +
        "output_path, templates and start/end frames are refused with a queue source (they would override the item). The result lists output_paths, every file the render should write; ae_verify_render with the job_id checks them all. " +
        "Also: continue_on_missing_footage (-continueOnMissingFootage), mem_usage (-mem_usage), log_level (-v; leave it out to keep the PROGRESS lines) and sound (-sound). Never uses -reuse. " +
        "Start gate: only one aerender job of this server runs at a time, a new one starts at least 20 s after the last one exited, and not while an AfterFX.com engine of an earlier job of this server is still alive (so a new aerender does not start while the last one's engine is still shutting down). A job that has to wait is not refused: it returns state \"running\" with phase \"queued\" (pid null, queued_reason says why) and starts by itself on a Node timer, without holding the After Effects queue; ae_aerender_status shows phase and start_attempts. If an earlier job's engine is still alive 120 s after the job began to wait for it, the queued job fails and names that process, which is not touched (an engine of a job that is still running never fails the wait). " +
        "Startup watchdog: a job whose log shows no render PROGRESS line (any PROGRESS line other than aerender's \"Launching After Effects...\") 45 s after its aerender was spawned is looked at: the CPU time of its own AfterFX.com engine (the process whose parent is that aerender) is sampled twice, 10 s apart. Only a job whose engine is gone or idle in both samples is stopped (that aerender and that engine, nothing else; never AfterFX.exe or another engine) and started again, at most twice; after the third attempt it is failed with an error that says what happened. An engine that is working (a big project opening slowly) is never stopped, however long it takes, and when the process list cannot be read the job keeps waiting. A job that shows render progress is not touched by it; with log_level \"errors\" (no PROGRESS lines to read) the start watchdog is off. After the start every job gets a slow check once a minute: if its engine has been gone for 5 minutes while aerender neither exits nor writes to its log, the job is failed, so a dead engine cannot hold the only slot for ever. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderStartSchema,
      handler: async (args: AeAerenderStartArgs, ctx: ToolContext) => {
        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const registry = getRegistry();
        const fromQueue = args.rq_index !== undefined || args.whole_queue === true;
        const compName = args.comp_name ?? "";
        const labelOf = args.whole_queue === true ? "whole queue" : args.rq_index !== undefined ? `rq ${args.rq_index}` : compName;

        try {
          return await ctx.queue.run(
            `ae_aerender_start(${labelOf})`,
            async () => {
              ctx.quarantine.assertClear();

              // Verify project saved and not dirty via the `status` host function
              // evalRaw, not callHost: we already hold the queue lease, and
              // callHost would wait for it forever.
              const statusResp = await ctx.bridge.evalRaw<{
                aeVersion?: string;
                project_path?: string;
                dirty?: boolean;
                afterfx_path?: string;
                app_path?: string;
              }>({
                id: `${opId}_status`,
                script: buildJsxCall("status", {}),
                label: "ae_aerender_start (status)",
                mutates: false,
                toolName: "ae_aerender_start",
              });

              const statusInfo = statusResp.result ?? {};
              const actualProjectPath =
                statusInfo.project_path ?? "<unsaved>";

              if (
                actualProjectPath === "<unsaved>" ||
                args.expect.project_path === "<unsaved>"
              ) {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message:
                    "Cannot start aerender on an unsaved project (<unsaved>). Save the project to disk first.",
                  expected: {
                    project_path: args.expect.project_path,
                    dirty: false,
                  },
                  actual: {
                    project_path: actualProjectPath,
                    dirty: Boolean(statusInfo.dirty),
                  },
                });
              }

              if (
                !pathsMatchForGuard(
                  args.expect.project_path,
                  actualProjectPath
                )
              ) {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message: `Target guard refused ae_aerender_start: expected project_path "${args.expect.project_path}", but After Effects has "${actualProjectPath}" open.`,
                  expected: args.expect,
                  actual: {
                    project_path: actualProjectPath,
                    dirty: Boolean(statusInfo.dirty),
                  },
                });
              }

              if (statusInfo.dirty === true) {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message:
                    fromQueue
                      ? "Cannot start aerender because the open project has unsaved changes (dirty: true). aerender reads the saved file, so Render Queue items added or queued since the last save are not in it: run ae_save first."
                      : "Cannot start aerender because the open project has unsaved changes (dirty: true). Call ae_save first so aerender renders the latest state on disk.",
                  expected: {
                    project_path: args.expect.project_path,
                    dirty: false,
                  },
                  actual: {
                    project_path: actualProjectPath,
                    dirty: true,
                  },
                });
              }

              if (args.expect.comp_id !== undefined) {
                await verifyTargetGuard(ctx, args.expect, opId);
              }

              // A queue source: read the queue now, in its own evalScript, right before
              // the spawn (indexes shift when items are added or removed).
              let rq: RqSelection | undefined;
              if (fromQueue) {
                const queueResp = await ctx.bridge.evalRaw<{ numItems?: number; items?: RqItemRead[]; truncated?: boolean }>({
                  id: `${opId}_rq`,
                  script: buildJsxCall("rqeditRead", {
                    item_indexes: args.rq_index !== undefined ? [args.rq_index] : undefined,
                    settings: false,
                  }),
                  label: "ae_aerender_start (render queue)",
                  mutates: false,
                  toolName: "ae_aerender_start",
                });
                const picked =
                  args.rq_index !== undefined
                    ? selectRqItem(queueResp.result, { rq_index: args.rq_index, item_comp_id: args.item_comp_id as number, comp_name: args.comp_name })
                    : selectWholeQueue(queueResp.result);
                if (!picked.ok) {
                  throw new BridgeError({
                    kind: "guard",
                    op_id: opId,
                    message: `ae_aerender_start refused: ${picked.message}`,
                    expected: picked.expected ?? { rq_index: args.rq_index, item_comp_id: args.item_comp_id, status: "queued" },
                    actual: picked.actual ?? { code: picked.code },
                  });
                }
                rq = picked.selection;
              }

              // Read-only, before anything is created or spawned. The tool makes
              // the output folder itself, so the folder is not checked.
              let preflight: GateSummary | undefined;
              if (args.preflight) {
                const gate = await runPreflightGate(
                  ctx,
                  rq
                    ? { toolName: "ae_aerender_start", opId, comp_ids: rq.comp_ids }
                    : { toolName: "ae_aerender_start", opId, comp_names: [compName] }
                );
                if (gate.blocked) return preflightRefusal("ae_aerender_start", gate.summary);
                preflight = gate.summary;
              }

              const aerenderBin = resolveAerenderPath({
                platform: options.platform,
                afterFxPath:
                  options.afterFxPath ??
                  statusInfo.afterfx_path ??
                  statusInfo.app_path,
                aeVersion: statusInfo.aeVersion,
                existsSync: options.existsSync,
              });

              const initialRecord = launchAerenderJob({
                registry,
                spawn: spawnFn,
                aerender_path: aerenderBin,
                project_path: actualProjectPath,
                ...(rq
                  ? {
                      comp_name: rq.comp_name,
                      rq_index: args.rq_index,
                      item_comp_id: args.item_comp_id,
                      whole_queue: args.whole_queue === true ? true : undefined,
                      output_paths: rq.outputs,
                      comp_id: rq.comp_id,
                      frame_range: rq.frame_range,
                    }
                  : {
                      comp_name: compName,
                      output_path: args.output_path,
                      output_module_template: args.output_module_template,
                      render_settings_template: args.render_settings_template,
                      start_frame: args.start_frame,
                      end_frame: args.end_frame,
                    }),
                continue_on_missing_footage: args.continue_on_missing_footage,
                mem_usage: args.mem_usage,
                log_level: args.log_level,
                sound: args.sound,
              });

              return {
                ok: true,
                op_id: opId,
                job_id: initialRecord.job_id,
                pid: initialRecord.pid,
                state: initialRecord.state,
                ...(initialRecord.phase ? { phase: initialRecord.phase } : {}),
                ...(initialRecord.queued_reason ? { queued_reason: initialRecord.queued_reason } : {}),
                project_path: initialRecord.project_path,
                comp_name: initialRecord.comp_name,
                output_path: initialRecord.output_path,
                aerender_path: initialRecord.aerender_path,
                args: initialRecord.args,
                log_path: initialRecord.log_path,
                started_at: initialRecord.started_at,
                ...(rq
                  ? {
                      source: args.whole_queue === true ? "whole_queue" : "rq_index",
                      ...(args.rq_index !== undefined ? { rq_index: args.rq_index, item_comp_id: args.item_comp_id } : { queued_items: rq.item_indexes }),
                      output_paths: rq.outputs,
                      ...(rq.frame_range ? { frame_range: rq.frame_range } : {}),
                      ...(rq.warnings.length > 0 ? { warnings: rq.warnings } : {}),
                    }
                  : {}),
                ...(preflight ? { preflight } : {}),
              };
            }
          );
        } catch (err) {
          if (err instanceof QueueWaitError) {
            throw new BridgeError({
              kind: "queued",
              op_id: opId,
              message: err.message,
            });
          }
          throw err;
        }
      },
    },
    {
      name: "ae_aerender_status",
      description:
        "Check the status of a background `aerender` job (`running`, `succeeded`, `failed`; a running job with phase \"queued\" has not been spawned yet and says why in queued_reason, start_attempts counts the spawns the startup watchdog made), parsing `PROGRESS` lines from `<job>.log` for frame progress, exit code, and the log tail. A job started with rq_index / whole_queue also reports rq_index, item_comp_id and output_paths; with several queue items rendering in a row the percent can be null while frames still count. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderStatusSchema,
      handler: async (args: AeAerenderStatusArgs) => {
        const registry = getRegistry();
        const job = registry.get(args.job_id);
        if (!job) {
          throw new Error(`No aerender job found with job_id "${args.job_id}".`);
        }

        const { fullText, tail } = readLogTail(job.log_path);
        const progress = parseAerenderProgress(fullText, {
          start_frame: job.start_frame,
          end_frame: job.end_frame,
          state: job.state,
        });

        return {
          ok: true,
          job_id: job.job_id,
          pid: job.pid,
          state: job.state,
          exit_code: job.exit_code,
          signal: job.signal,
          cancelled: job.cancelled,
          project_path: job.project_path,
          comp_name: job.comp_name,
          output_path: job.output_path,
          aerender_path: job.aerender_path,
          log_path: job.log_path,
          started_at: job.started_at,
          finished_at: job.finished_at,
          ...(job.phase ? { phase: job.phase } : {}),
          ...(job.queued_reason ? { queued_reason: job.queued_reason } : {}),
          ...(job.start_attempts !== undefined ? { start_attempts: job.start_attempts } : {}),
          ...(job.error ? { error: job.error } : {}),
          ...(job.rq_index !== undefined ? { rq_index: job.rq_index } : {}),
          ...(job.item_comp_id !== undefined ? { item_comp_id: job.item_comp_id } : {}),
          ...(job.whole_queue === true ? { whole_queue: true } : {}),
          ...(job.comp_id !== undefined ? { comp_id: job.comp_id } : {}),
          ...(job.output_paths ? { output_paths: job.output_paths } : {}),
          progress,
          current_frame: progress.current_frame,
          frames_completed: progress.frames_completed,
          total_frames: progress.total_frames,
          percent: progress.percent,
          log_tail: tail,
        };
      },
    },
    {
      name: "ae_aerender_cancel",
      description:
        "Cancel a running background `aerender` job by `job_id`, terminating the process and marking the job as `failed` (`cancelled: true`); the AfterFX.com engine whose parent is that aerender is ended too, so a leftover engine does not hold up later jobs. After a restart only a pid that is positively an aerender is killed; when the process lookup cannot tell, nothing is killed, the job stays running and the result says `kill_unconfirmed: true`. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderCancelSchema,
      handler: async (args: AeAerenderCancelArgs) => {
        const registry = getRegistry();
        const job = registry.get(args.job_id);
        if (!job) {
          throw new Error(`No aerender job found with job_id "${args.job_id}".`);
        }

        if (job.state !== "running") {
          return {
            ok: true,
            job_id: job.job_id,
            state: job.state,
            exit_code: job.exit_code,
            cancelled: Boolean(job.cancelled),
            already_finished: true,
          };
        }

        const updated = cancelAerenderJob(registry, job, options.killProcess, "ae_aerender_cancel", options.cancelHooks);

        if (updated.kill_unconfirmed) {
          return {
            ok: true,
            job_id: updated.job_id,
            pid: updated.pid,
            state: updated.state,
            exit_code: updated.exit_code,
            cancelled: false,
            kill_unconfirmed: true,
            advice: `Could not confirm that pid ${updated.pid} is this job's aerender (the process lookup failed), so nothing was killed and the job stays running. Check the process yourself (Task Manager / Activity Monitor), then try again.`,
          };
        }

        return {
          ok: true,
          job_id: updated.job_id,
          pid: updated.pid,
          state: updated.state,
          exit_code: updated.exit_code,
          cancelled: true,
          finished_at: updated.finished_at,
        };
      },
    },
  ];
}

export const aerenderTools: ToolDefinition<any>[] = createAerenderTools();
