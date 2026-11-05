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

  constructor(filePath: string = defaultAerenderJobsFilePath()) {
    this.filePath = filePath;
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

/**
 * Spawns one background aerender, logs it to <job>.log and tracks it in the
 * registry until it exits. ae_aerender_start and the render-batch runner both
 * go through here, so a job behaves the same whichever started it.
 */
export function launchAerenderJob(p: LaunchAerenderParams): AerenderJobRecord {
  const registry = p.registry;
  const spawnFn = p.spawn;
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

  let logFd: number | null = null;
  try {
    logFd = fs.openSync(logPath, "a");
  } catch {
    logFd = null;
  }

  const stdioConfig: childProcess.StdioOptions =
    logFd !== null ? ["ignore", logFd, logFd] : "pipe";

  const child = spawnFn(p.aerender_path, cliArgs, {
    windowsHide: true,
    detached: true,
    stdio: stdioConfig,
  });

  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore
    }
  }

  // If a test spawn mock returns readable stdout/stderr streams, append to logPath
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

  const initialRecord: AerenderJobRecord = {
    job_id: jobId,
    pid: typeof child.pid === "number" ? child.pid : null,
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

  registry.register(initialRecord, child);

  child.on("error", (err: Error) => {
    try {
      fs.appendFileSync(
        logPath,
        `\nAERENDER SPAWN ERROR: ${err.message}\n`
      );
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

  child.on(
    "exit",
    (code: number | null, signal: NodeJS.Signals | null) => {
      const current = registry.get(jobId);
      if (current?.cancelled) {
        registry.update(jobId, {
          state: "failed",
          exit_code: code ?? current.exit_code,
          signal: signal ?? current.signal,
          finished_at:
            current.finished_at ?? new Date().toISOString(),
        });
        return;
      }
      // aerender can exit 0 after a fatal error (measured: a missing
      // output-module template logs "aerender ERROR:" and exits 0), so
      // the log decides as well as the exit code.
      let logError: string | null = null;
      try {
        const m = /^aerender ERROR:?\s*(.*)$/im.exec(
          fs.readFileSync(logPath, "utf8")
        );
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
    }
  );

  if (typeof child.unref === "function") {
    child.unref();
  }
  return initialRecord;
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
      .describe("aerender -v: 'errors' logs only errors, 'errors_and_progress' (aerender's own default) also the PROGRESS lines that ae_aerender_status turns into a percent. Leave it out to keep the progress."),
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
        "Check the status of a background `aerender` job (`running`, `succeeded`, `failed`), parsing `PROGRESS` lines from `<job>.log` for frame progress, exit code, and the log tail. A job started with rq_index / whole_queue also reports rq_index, item_comp_id and output_paths; with several queue items rendering in a row the percent can be null while frames still count. " +
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
        "Cancel a running background `aerender` job by `job_id`, terminating the process and marking the job as `failed` (`cancelled: true`). After a restart only a pid that is positively an aerender is killed; when the process lookup cannot tell, nothing is killed, the job stays running and the result says `kill_unconfirmed: true`. " +
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
