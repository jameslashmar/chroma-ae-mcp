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
  comp_name: string;
  output_path: string;
  output_module_template?: string;
  render_settings_template?: string;
  start_frame?: number;
  end_frame?: number;
  aerender_path: string;
  args: string[];
  log_path: string;
  started_at: string;
  finished_at: string | null;
  error?: string;
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

/**
 * Builds the CLI argument vector for `aerender`.
 */
export function buildAerenderArgs(params: {
  project_path: string;
  comp_name: string;
  output_path: string;
  output_module_template?: string;
  render_settings_template?: string;
  start_frame?: number;
  end_frame?: number;
}): string[] {
  const cliArgs: string[] = [
    "-project",
    params.project_path,
    "-comp",
    params.comp_name,
    "-output",
    params.output_path,
  ];
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

export const AeAerenderStartSchema = z
  .object({
    expect: ExpectSchema,
    comp_name: z
      .string()
      .min(1)
      .describe("Name of the composition to render."),
    output_path: z
      .string()
      .min(1)
      .describe("Absolute output file path for aerender (-output)."),
    output_module_template: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Output Module template name (-OMtemplate)."),
    render_settings_template: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Render Settings template name (-RStemplate)."),
    start_frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Optional start frame index (-s)."),
    end_frame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Optional end frame index (-e)."),
    preflight: z
      .boolean()
      .optional()
      .describe(
        "Run the ae_preflight delivery check on this comp (by name) and the comps it nests first, and refuse to start if it finds a blocker (missing footage or fonts, expressions in error, comp not found). Nothing is started when it refuses. Default false."
      ),
  })
  .superRefine((val, ctx) => {
    if (
      val.start_frame !== undefined &&
      val.end_frame !== undefined &&
      val.end_frame < val.start_frame
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_frame"],
        message: "`end_frame` must be >= `start_frame`.",
      });
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
        AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderStartSchema,
      handler: async (args: AeAerenderStartArgs, ctx: ToolContext) => {
        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const registry = getRegistry();

        try {
          return await ctx.queue.run(
            `ae_aerender_start(${args.comp_name})`,
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
                    "Cannot start aerender because the open project has unsaved changes (dirty: true). Call ae_save first so aerender renders the latest state on disk.",
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

              // Read-only, before anything is created or spawned. The tool makes
              // the output folder itself, so the folder is not checked.
              let preflight: GateSummary | undefined;
              if (args.preflight) {
                const gate = await runPreflightGate(ctx, {
                  toolName: "ae_aerender_start",
                  opId,
                  comp_names: [args.comp_name],
                });
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

              const jobId = registry.newJobId();
              const rendersDir = registry.rendersDir;
              fs.mkdirSync(rendersDir, { recursive: true });
              const outDir = path.dirname(args.output_path);
              if (outDir && outDir !== ".") {
                try {
                  fs.mkdirSync(outDir, { recursive: true });
                } catch {
                  // Output dir may be on a virtual path in tests
                }
              }

              const logPath = path.join(rendersDir, `${jobId}.log`);
              fs.writeFileSync(logPath, "", { encoding: "utf8" });

              const cliArgs = buildAerenderArgs({
                project_path: actualProjectPath,
                comp_name: args.comp_name,
                output_path: args.output_path,
                output_module_template: args.output_module_template,
                render_settings_template: args.render_settings_template,
                start_frame: args.start_frame,
                end_frame: args.end_frame,
              });

              let logFd: number | null = null;
              try {
                logFd = fs.openSync(logPath, "a");
              } catch {
                logFd = null;
              }

              const stdioConfig: childProcess.StdioOptions =
                logFd !== null ? ["ignore", logFd, logFd] : "pipe";

              const child = spawnFn(aerenderBin, cliArgs, {
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
                project_path: actualProjectPath,
                comp_name: args.comp_name,
                output_path: args.output_path,
                ...(args.output_module_template
                  ? { output_module_template: args.output_module_template }
                  : {}),
                ...(args.render_settings_template
                  ? { render_settings_template: args.render_settings_template }
                  : {}),
                ...(args.start_frame !== undefined
                  ? { start_frame: args.start_frame }
                  : {}),
                ...(args.end_frame !== undefined
                  ? { end_frame: args.end_frame }
                  : {}),
                aerender_path: aerenderBin,
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

              return {
                ok: true,
                op_id: opId,
                job_id: jobId,
                pid: initialRecord.pid,
                state: initialRecord.state,
                project_path: initialRecord.project_path,
                comp_name: initialRecord.comp_name,
                output_path: initialRecord.output_path,
                aerender_path: initialRecord.aerender_path,
                args: initialRecord.args,
                log_path: initialRecord.log_path,
                started_at: initialRecord.started_at,
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
        "Check the status of a background `aerender` job (`running`, `succeeded`, `failed`), parsing `PROGRESS` lines from `<job>.log` for frame progress, exit code, and the log tail. " +
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
        "Cancel a running background `aerender` job by `job_id`, terminating the process and marking the job as `failed` (`cancelled: true`). " +
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

        const proc = registry.getProcess(args.job_id);
        if (proc) {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore if already dead
          }
        } else if (typeof job.pid === "number" && job.pid > 0) {
          const killFn =
            options.killProcess ??
            ((pid: number, sig?: string | number) =>
              process.kill(pid, sig as NodeJS.Signals | undefined));
          try {
            killFn(job.pid, "SIGTERM");
          } catch {
            // ignore ESRCH if process already exited
          }
        }

        try {
          fs.appendFileSync(
            job.log_path,
            `\nAERENDER CANCELLED by ae_aerender_cancel at ${new Date().toISOString()}\n`
          );
        } catch {
          // ignore
        }

        const updated = registry.update(args.job_id, {
          state: "failed",
          cancelled: true,
          finished_at: new Date().toISOString(),
        })!;

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
