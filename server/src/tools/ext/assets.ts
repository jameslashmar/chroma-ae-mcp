/**
 * server/src/tools/ext/assets.ts
 *
 * Asset staging and import:
 * - ae_import_assets: imports what is new in the asset folder
 *   (`<project dir>/_assets/` by default), or an explicit list of files, into
 *   the `_Assets` bin (or a project folder by id), mirroring subfolders, with
 *   numbered stills as sequences, and sets each item's interpretation
 *   (shared settings plus rules by name / extension / sequence / subfolder)
 *   in the same undo step; or turns the watcher on/off
 * - AssetWatcher: while on, polls the open project's asset folder and imports
 *   files that arrive, through the same guarded, checkpointed write
 *
 * Files still being written (changed in the last 2 s; sequences 10 s) wait for the next look.
 * Footage colour profiles are not scriptable, so there is no colour setting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_ASSET_BIN,
  DEFAULT_ASSET_FOLDER,
  IMPORT_PATHS,
  MAX_SCAN_FILES,
  MAX_SINGLE_STATS,
  candidatesFromPaths,
  normPath,
  pickNewAssets,
  resolveInterpret,
  scanAssets,
  shapeImportResult,
  type AssetCandidate,
  type ImportRule,
  type ScanStats,
} from "../../assets.js";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { renderGate } from "../../render-gate.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";
import { InterpretSettingsSchema, interpretMismatches, type InterpretRead } from "./interpret.js";

export const SETTLE_MS = 2000;
/** The settle time the tool and the watcher use. Production keeps SETTLE_MS; a test that must age files past it sets a short one. */
export const assetDeps = { settleMs: SETTLE_MS };
/** Sequences are renders in progress: wait longer after the newest frame. */
const SEQUENCE_SETTLE_MS = 10_000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60_000;
const MAX_IMPORT = 200;
const DRY_RUN_ROWS = 200;
const LIST_ROWS = 100;
const MAX_CHECKS = 50;

const RuleSchema = z
  .object({
    match: z
      .object({
        name_glob: z.string().min(1).max(200).optional().describe("File name pattern, * and ? only, not case-sensitive. For a sequence the frame number is removed first: shot_0001.exr is matched as shot_.exr, so shot_* matches."),
        ext: z.array(z.string().min(1).max(10)).min(1).max(20).optional().describe("Extensions without the dot, e.g. [\"exr\", \"png\"]."),
        sequence: z.boolean().optional().describe("true: only sequences. false: only single files."),
        subfolder_glob: z.string().min(1).max(200).optional().describe("Pattern for the file's subfolder under the folder, joined with / (empty for files at the top)."),
      })
      .strict()
      .describe("All the keys given must match; an empty match matches every file."),
    interpret: InterpretSettingsSchema,
  })
  .strict();

export const AeImportAssetsSchema = z
  .object({
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(`Absolute folder to import from. Default: ${DEFAULT_ASSET_FOLDER}/ next to the open .aep (created if missing).`),
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe("Import exactly these files (absolute paths; a numbered frame stands for its sequence) instead of scanning a folder. Not with folder or watch."),
    bin: z.string().min(1).max(200).optional().describe(`Project folder to import into, by name; subfolders mirror the asset folder's. Default '${DEFAULT_ASSET_BIN}'.`),
    target_folder_id: z.number().int().optional().describe("Import into this existing project folder (its item id) instead of a bin by name. Not with bin."),
    recursive: z.boolean().optional().describe("Include subfolders (except ones starting with _ or .). Default true."),
    sequences: z.boolean().optional().describe("Import numbered stills (shot_0001.png ...) as one sequence. Default true."),
    interpret: InterpretSettingsSchema.optional().describe("Interpretation applied to every imported item, in the same undo step: alpha, field separation, pulldown, conform_frame_rate, loop, pixel_aspect. A setting an item can't take (alpha on a file without alpha, a frame rate on a still) is skipped and listed per item. Colour profiles are not scriptable."),
    rules: z.array(RuleSchema).max(20).optional().describe("Per-file interpretation: for each setting the first rule whose match fits wins over `interpret`."),
    max_seconds: z.number().min(5).max(110).optional().describe("Time budget, checked between files (default 45). What is left is listed under not_attempted_paths; call again to continue."),
    allow_writing: z.boolean().optional().describe("With paths: import files changed in the last 2 s (sequences 10 s) too. Default false: they wait, as in a folder scan."),
    missing_frames: z
      .enum(["skip", "import"])
      .optional()
      .describe(
        "Image sequences with frames missing between the first and last frame. skip (default): left out and listed under missing_frames with the exact ranges, because After Effects stops the import with a modal 'is missing N frames' warning that waits until someone answers it. import: imported anyway; the warning then appears and blocks AE until it is answered (ae_dialogs reads it; its only button is OK)."
      ),
    dry_run: z.boolean().optional().describe("List what would be imported, with the interpretation each file would get, without importing."),
    watch: z
      .boolean()
      .optional()
      .describe(`Turn auto-import on or off: while on, files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported into ${DEFAULT_ASSET_BIN} within seconds. Persists across restarts.`),
    expect: z
      .object({ project_path: z.string().min(1) })
      .describe("The open project's path; the import is refused if another project is open."),
  })
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (v.paths && v.folder) bad("Give paths or folder, not both.");
    if (v.paths && v.watch !== undefined) bad("watch goes with the asset folder, not with paths.");
    if (v.watch !== undefined && v.bin !== undefined) bad("watch imports into the default bin; bin does not apply to it. Run an import with bin, or turn watch on without it.");
    if (v.watch !== undefined && v.max_seconds !== undefined) bad("max_seconds does not apply to watch: the watcher imports on its own schedule. Leave it out, or run an import with max_seconds.");
    if (v.paths && v.recursive !== undefined) bad("recursive goes with a folder scan: files given in paths are not searched for in subfolders.");
    if (v.target_folder_id !== undefined && v.bin !== undefined) bad("Give bin or target_folder_id, not both.");
    if (v.watch !== undefined && (v.interpret || v.rules)) bad("The watcher imports without interpretation; run an import with interpret / rules instead.");
    if (v.allow_writing !== undefined && !v.paths) bad("allow_writing goes with paths.");
    if (v.paths && v.rules?.some((r) => r.match.subfolder_glob !== undefined)) bad("rules with subfolder_glob need a folder scan: files given in paths have no subfolder.");
  });

type Args = z.infer<typeof AeImportAssetsSchema>;

interface ImportRow {
  path: string;
  item_id: number;
  name: string;
  type: string;
  sequence: boolean;
  note?: string;
  frames?: number;
  interpretation?: { applied?: string[]; skipped?: unknown[]; error?: string; use?: Record<string, unknown> };
}
interface FailedRow {
  path: string;
  error: string;
  stage?: string;
  item_id?: number;
}

interface ImportOutcome {
  op_id: string;
  imported: ImportRow[];
  failed: FailedRow[];
  not_attempted: number;
  not_attempted_paths: string[];
  folder_id?: number;
  checkpoint: unknown;
  receipt: unknown;
}

async function readFootagePaths(ctx: ToolContext, label: string, toolName: string) {
  const res = await ctx.bridge.evalRaw<{ project_path: string; paths: string[] }>({
    id: `${ctx.bridge.newOpId()}_footage`,
    script: buildJsxCall("footagePaths", {}),
    label,
    mutates: false,
    toolName,
  });
  return res.result;
}

function plan(c: AssetCandidate) {
  return { path: c.path.replace(/\\/g, "/"), subfolder: c.subfolder, sequence: c.sequence, ...(c.interpret ? { interpret: c.interpret } : {}) };
}

/** Guarded, checkpointed import of `fresh`, read back in a separate evalScript. */
export async function importAssetFiles(
  ctx: ToolContext,
  projectPath: string,
  bin: string,
  fresh: AssetCandidate[],
  toolName: string,
  options: { targetFolderId?: number; maxSeconds?: number } = {}
): Promise<ImportOutcome> {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect = { project_path: projectPath };
  const noop: ImportOutcome = { op_id: opId, imported: [], failed: [], not_attempted: 0, not_attempted_paths: [], checkpoint: null, receipt: null };
  const where = options.targetFolderId !== undefined ? `folder #${options.targetFolderId}` : bin;
  // Only the files this call is about are read back, not the whole bin: a bin that has collected
  // thousands of items would otherwise be read (and capped) every time.
  const readBin = (suffix: string, only: string[]) =>
    ctx.bridge.evalRaw<{ items: Array<{ item_id: number; bin: string; name: string; path: string | null }>; truncated?: boolean }>({
      id: `${opId}_${suffix}`,
      script: buildJsxCall("assetBinContents", { bin, folder_id: options.targetFolderId, only_paths: only }),
      label: `${toolName} (${suffix} bin)`,
      mutates: false,
      toolName,
    });
  try {
    return await ctx.queue.run(`${toolName}: import ${fresh.length}`, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expect, opId);
      // Re-read the project's footage inside the lease: another import may have run since the caller looked.
      const current = await readFootagePaths(ctx, `${toolName} (footage, recheck)`, toolName);
      const have = new Set((current.paths ?? []).map(normPath));
      const todo = fresh.filter((c) => !have.has(normPath(c.path)));
      if (todo.length === 0) return noop;
      const checkpoint = await autoCheckpoint(ctx, guard, toolName);
      const before = await readBin("before", todo.map((c) => c.path));
      const write = await ctx.bridge.evalRaw<{
        bin_id: number;
        folder_id?: number;
        imported: ImportRow[];
        failed: FailedRow[];
        not_attempted?: number;
        not_attempted_paths?: string[];
      }>({
        id: opId,
        script: buildJsxCall("importAssets", {
          expect,
          bin,
          target_folder_id: options.targetFolderId,
          max_seconds: options.maxSeconds,
          items: todo.map(plan),
        }),
        label: `${toolName}: import ${todo.length} file(s) into ${where}`,
        mutates: true,
        toolName,
        timeoutMs: SLOW_TIMEOUT_MS,
      });
      // Separate evalScript for the read-back. The import is applied from
      // here on, so a failed read is reported, never thrown.
      const afterRead = await readAfterWrite(opId, () => readBin("after", todo.map((c) => c.path)));
      const after = afterRead.value?.result ?? null;
      const inBin = new Set((after?.items ?? []).map((i) => (i.path ? normPath(i.path) : "")));
      const mismatches: ReceiptMismatch[] = afterRead.failure
        ? [afterRead.failure]
        : after?.truncated
          ? []
          : write.result.imported
              .filter((i) => !inBin.has(normPath(i.path)))
              .map((i) => ({ path: `bin.${i.name}`, expected: i.path, actual: undefined, message: `${i.name} is not in ${where} after the import` }));

      // Interpretation read-back, also a separate evalScript: every setting that was applied is checked.
      const applied = write.result.imported.filter((i) => i.interpretation?.use && Object.keys(i.interpretation.use).length > 0).slice(0, 200);
      if (applied.length > 0) {
        const interpRead = await readAfterWrite(opId, () =>
          ctx.bridge.evalRaw<InterpretRead>({
            id: `${opId}_interp`,
            script: buildJsxCall("interpretRead", { item_ids: applied.map((i) => i.item_id), include_render_queue: false }),
            label: `${toolName} (interpretation read-back)`,
            mutates: false,
            toolName,
          })
        );
        if (interpRead.failure) {
          mismatches.push(interpRead.failure);
        } else {
          let more = 0;
          for (const row of applied) {
            const found = interpretMismatches({ item_id: row.item_id, ...(row.interpretation?.use as object) }, null, interpRead.value?.result);
            for (const x of found) {
              if (mismatches.length < MAX_CHECKS) mismatches.push({ ...x, path: `interpretation[${row.item_id}].${x.path}` });
              else more++;
            }
          }
          if (more > 0) mismatches.push({ path: "interpretation", expected: "no more mismatches", actual: more, message: `${more} more mismatch(es) not listed` });
        }
      }
      // `use` was only for the check above.
      const imported = write.result.imported.map((i) => {
        if (!i.interpretation) return i;
        const { use: _use, ...rest } = i.interpretation;
        return { ...i, interpretation: rest };
      });
      const folderId = write.result.folder_id ?? write.result.bin_id;
      return {
        op_id: opId,
        imported,
        failed: write.result.failed,
        not_attempted: write.result.not_attempted ?? 0,
        not_attempted_paths: write.result.not_attempted_paths ?? [],
        folder_id: folderId,
        checkpoint,
        receipt: buildReceipt({ before: before.result, after, customMismatches: mismatches }),
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

/**
 * Imports files that arrive in `<project dir>/_assets/` while the setting is
 * on. Polls every few seconds with quiet evalScripts (not logged unless they
 * fail); an import is an ordinary guarded write and shows in the log.
 */
export class AssetWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private failures = 0;
  private skipUntil = 0;
  /** Files already imported or found in the project, per project, so they are not asked about again. */
  private readonly seen = new Map<string, Set<string>>();
  /** Folders already reported as cut by the scan limit, so the log gets one line per folder. */
  private readonly tooBig = new Set<string>();

  constructor(
    private readonly ctx: ToolContext,
    private readonly opts: { intervalMs?: number; log?: (level: string, msg: string) => void; now?: () => number } = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 5000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the asset folder; returns what it imported (for tests and the log). */
  async tick(): Promise<{ imported: number; failed: number } | null> {
    const settings = this.ctx.settings?.get().asset_watch;
    if (!settings?.enabled || this.busy) return null;
    if (this.ctx.quarantine.isQuarantined) return null;
    // After Effects is busy rendering for ae_render_queue_render: skip quietly, nothing is sent.
    if (renderGate.active()) return null;
    const clock = this.opts.now ?? Date.now;
    if (clock() < this.skipUntil) return null;
    this.busy = true;
    try {
      const out = await this.look(settings);
      if (this.failures > 0) {
        this.failures = 0;
        this.skipUntil = 0;
        this.opts.log?.("ok", "Asset watch is working again");
      }
      return out;
    } catch (err) {
      // A render started while this look was running: not a failure of the watcher.
      if (renderGate.active()) return null;
      this.failures++;
      this.skipUntil = clock() + Math.min(BACKOFF_BASE_MS * Math.pow(2, this.failures - 1), BACKOFF_MAX_MS);
      if (this.failures === 1) this.opts.log?.("warn", `Asset watch: ${err instanceof Error ? err.message : String(err)} (retrying with backoff)`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async look(settings: { enabled: boolean; since: string | null; recursive?: boolean; sequences?: boolean }): Promise<{ imported: number; failed: number } | null> {
    {
      const status = await this.ctx.bridge.evalRaw<{ project_path: string }>({
        id: `${this.ctx.bridge.newOpId()}_watch`,
        script: buildJsxCall("status", {}),
        label: "quiet: asset watch (status)",
        mutates: false,
        toolName: "asset_watch",
      });
      const projectPath = status.result?.project_path ?? "<unsaved>";
      if (projectPath === "<unsaved>") return null;
      const folder = path.join(path.dirname(projectPath), DEFAULT_ASSET_FOLDER);
      if (!fs.existsSync(folder)) return null;
      const key = normalizeGuardPath(projectPath);
      const seen = this.seen.get(key) ?? new Set<string>();
      this.seen.set(key, seen);
      const since = settings.since ? Date.parse(settings.since) : 0;
      // Reuse the recursive/sequences choice ae_import_assets was called
      // with when watch was turned on, instead of always defaulting both
      // to true -- otherwise watch:true silently ignores a non-default
      // recursive:false/sequences:false the user explicitly asked for.
      const stats: ScanStats = { files_seen: 0, truncated: false };
      const scanned = scanAssets(folder, { recursive: settings.recursive, sequences: settings.sequences, stats });
      // Frames are grouped into sequences before anything is counted, so a long sequence is one
      // candidate. Only a tree past the scan limit is cut; the folders it cut are skipped (their
      // sequences could be missing frames), everything else still imports, and the log says what was skipped.
      const skippedIncomplete = scanned.filter((c) => c.incomplete);
      if (stats.truncated) {
        if (!this.tooBig.has(key)) {
          this.tooBig.add(key);
          this.opts.log?.("warn", `Asset watch: ${folder} holds ${stats.files_seen} importable files, more than the ${MAX_SCAN_FILES} a scan covers; ${skippedIncomplete.length} candidate(s) in the cut folders (${(stats.incomplete_dirs ?? []).join(", ") || "root"}) are skipped until the folder is split, everything else is imported`);
        }
      } else {
        this.tooBig.delete(key);
      }
      if (stats.unchecked_singles) {
        const sk = `singles:${key}`;
        if (!this.tooBig.has(sk)) {
          this.tooBig.add(sk);
          this.opts.log?.("warn", `Asset watch: ${folder} holds more than ${MAX_SINGLE_STATS} single files; ${stats.unchecked_singles} were not looked at (a scan checks at most ${MAX_SINGLE_STATS}). Split the folder.`);
        }
      }
      const candidates = scanned.filter((c) => !c.incomplete).filter((c) => !seen.has(normPath(c.path)) && c.arrivedMs >= since);
      if (candidates.length === 0) return null;
      const inProject = await readFootagePaths(this.ctx, "quiet: asset watch (footage)", "asset_watch");
      const now = (this.opts.now ?? Date.now)();
      const picked = pickNewAssets(candidates, inProject.paths, now, assetDeps.settleMs, SEQUENCE_SETTLE_MS);
      const { already } = picked;
      for (const c of already) seen.add(normPath(c.path));
      // A sequence with missing frames would stop AE behind its modal "is missing N frames" warning with no one
      // there to answer it: it waits (not marked seen) until the gap is filled, and the log says so once per gap.
      for (const c of picked.fresh) {
        if (!c.missing) continue;
        const gk = `gap:${normPath(c.path)}:${c.missing.count}`;
        if (this.tooBig.has(gk)) continue;
        this.tooBig.add(gk);
        this.opts.log?.("warn", `Asset watch: ${c.path} is missing ${c.missing.count} frame(s); it is imported once they arrive (or import it with ae_import_assets missing_frames: "import")`);
      }
      const fresh = picked.fresh.filter((c) => !c.missing);
      if (fresh.length === 0) return null;
      const res = await importAssetFiles(this.ctx, projectPath, DEFAULT_ASSET_BIN, fresh.slice(0, MAX_IMPORT), "asset_watch");
      for (const i of res.imported) seen.add(normPath(i.path));
      for (const f of res.failed) seen.add(normPath(f.path));
      this.opts.log?.("ok", `Asset watch imported ${res.imported.length} file(s) into ${DEFAULT_ASSET_BIN}${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      // The host stops between files after its time budget (45 s); what is left is not in `seen`, so the next look takes it.
      if (res.not_attempted > 0) this.opts.log?.("warn", `Asset watch stopped at the host's time budget: ${res.not_attempted} file(s) wait for the next look`);
      if (fresh.length > MAX_IMPORT) this.opts.log?.("warn", `Asset watch: ${fresh.length - MAX_IMPORT} more new file(s) wait for the next look (${MAX_IMPORT} are imported a time)`);
      return { imported: res.imported.length, failed: res.failed.length };
    }
  }
}

const dryRow = (c: AssetCandidate & { given?: string }) => ({
  ...plan(c),
  ...(c.frames !== undefined ? { frames: c.frames } : {}),
  ...(c.firstFrame !== undefined ? { first_frame: c.firstFrame, last_frame: c.lastFrame } : {}),
  ...(c.given ? { given: c.given } : {}),
  ...(c.missing ? { missing: c.missing.count } : {}),
});

export const assetsTools: ToolDefinition<any>[] = [
  {
    name: "ae_import_assets",
    description:
      `Import staged assets: files in the asset folder (${DEFAULT_ASSET_FOLDER}/ next to the open .aep unless \`folder\` says otherwise), or exactly the files in \`paths\`, that are not in the project yet go into the ${DEFAULT_ASSET_BIN} bin (\`bin\`, or an existing project folder by \`target_folder_id\`), with subfolders mirrored and numbered stills (shot_0001.png ...; at least 3 frames, 3-7 digits, not v002-style versions) as one sequence, which waits until 10 s after its newest frame so a render in progress is not imported half-done. ` +
      "Save generated or delivered files (images, renders, voice-overs) there, then call this; files already in the project are skipped, and files still being written wait. " +
      "`interpret` (alpha, field separation, pulldown, conform_frame_rate, loop, pixel_aspect) and `rules` (by name pattern, extension, sequence or subfolder) set each file's interpretation in the same undo step: a setting a file can't take (alpha on a file without alpha, a frame rate on a still) is skipped and listed on its row, and a failed interpretation never fails the import. Footage colour profiles are not scriptable; the project's working space is in ae_project_settings. " +
      "More than 200 new files (frames of a sequence count as one) are refused with a report: use a subfolder as `folder`, or `paths`. A tree with more than 100000 importable files is cut by the scan; the folders it cut are left out and listed under incomplete_folders. `max_seconds` (default 45) is checked between files: a long batch stops there, may be two undo steps, and lists the rest under not_attempted_paths; call again to continue (imported files are skipped). A file that throws is listed under failed with its stage (import or interpret) and the files before it stay imported in the same undo step. The lists are capped at 100 rows with totals. A sequence with frames missing between its first and last frame is left out and listed under missing_frames with the ranges, because After Effects would stop the import with a modal warning (missing_frames: \"import\" imports it anyway). After Effects dialogs are never suppressed: read them with ae_dialogs. " +
      `\`watch: true\` turns on auto-import: files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported within seconds, until \`watch: false\` (turn it on only when the user wants it; it imports without interpretation). ` +
      "The import is one undo group guarded by `expect`, with an auto checkpoint, and the bin and each applied setting are read back in separate evalScripts. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeImportAssetsSchema,
    handler: async (args: Args, ctx) => {
      const current = await readFootagePaths(ctx, "ae_import_assets (footage)", "ae_import_assets");
      const projectPath = current.project_path;
      if (normalizeGuardPath(args.expect.project_path) !== normalizeGuardPath(projectPath)) {
        return { ok: false, error: "guard", message: `The open project is ${projectPath}, not ${args.expect.project_path}. Re-read state; nothing was imported.` };
      }
      let watch: unknown;
      if (args.watch !== undefined) {
        if (!ctx.settings) return { ok: false, error: "no_settings", message: "This server has no settings store, so the watcher can't be set." };
        const prev = ctx.settings.get().asset_watch;
        let since: string | null = null;
        if (args.watch) since = prev.enabled && prev.since ? prev.since : new Date().toISOString();
        const s = ctx.settings.updateAssetWatch({
          enabled: args.watch,
          since,
          recursive: args.recursive ?? true,
          sequences: args.sequences ?? true,
        });
        watch = { ...s.asset_watch, folder: DEFAULT_ASSET_FOLDER, bin: DEFAULT_ASSET_BIN, note: args.watch ? "Files changed from now on are imported automatically." : "Auto-import is off." };
      }
      const bin = args.bin ?? DEFAULT_ASSET_BIN;
      const interpretWanted = args.interpret !== undefined || args.rules !== undefined;

      let folder: string | undefined;
      let scanStats: ScanStats | undefined;
      let candidates: Array<AssetCandidate & { given?: string }>;
      const scanFailed: FailedRow[] = [];
      if (args.paths) {
        for (const p of args.paths) if (!path.isAbsolute(p)) return { ok: false, error: "bad_args", message: `paths must be absolute: ${p}` };
        const found = candidatesFromPaths(args.paths, { sequences: args.sequences });
        candidates = found.candidates;
        for (const m of found.missing) scanFailed.push({ path: m.path, stage: "scan", error: m.error });
      } else {
        if (projectPath === "<unsaved>" && !args.folder) {
          return { ok: false, error: "unsaved_project", message: "The project has not been saved, so it has no asset folder. Save it, or pass an absolute folder.", watch };
        }
        folder = args.folder ?? path.join(path.dirname(projectPath), DEFAULT_ASSET_FOLDER);
        if (!path.isAbsolute(folder)) return { ok: false, error: "bad_args", message: `folder must be absolute: ${folder}` };
        // A dry run never creates the folder; a real import or watch:true does.
        if (!args.folder && (!args.dry_run || args.watch === true)) fs.mkdirSync(folder, { recursive: true });
        if (!fs.existsSync(folder)) {
          if (args.dry_run) {
            return { ok: true, folder, bin, already_in_project: 0, still_writing: [], ...(watch ? { watch } : {}), dry_run: true, to_import: [], imported: [], failed: [] };
          }
          return { ok: false, error: "not_found", message: `No such folder: ${folder}` };
        }
        const stats: ScanStats = { files_seen: 0, truncated: false };
        candidates = scanAssets(folder, { recursive: args.recursive, sequences: args.sequences, stats });
        scanStats = stats;
        // Candidates in a folder the scan limit cut may be sequences with missing frames: leave them out, and say so.
        candidates = candidates.filter((c) => !c.incomplete);
      }

      const settle = args.paths && args.allow_writing === true ? Number.NEGATIVE_INFINITY : assetDeps.settleMs;
      const sequenceSettle = args.paths && args.allow_writing === true ? Number.NEGATIVE_INFINITY : SEQUENCE_SETTLE_MS;
      const picked = pickNewAssets(candidates, current.paths, Date.now(), settle, sequenceSettle);
      const { already, settling } = picked;
      // Resolve each file's interpretation; a bad combination refuses the call before anything is written.
      const shared = args.interpret as Record<string, unknown> | undefined;
      const rules = args.rules as ImportRule[] | undefined;
      // A sequence with missing frames stops the import behind AE's modal "is missing N frames" warning
      // (seen live, AE 26.3): it is left out unless missing_frames is "import".
      const gapped = args.missing_frames === "import" ? [] : picked.fresh.filter((c) => c.missing);
      const fresh = picked.fresh
        .filter((c) => gapped.indexOf(c) === -1)
        .map((c) => {
          const interpret = interpretWanted ? resolveInterpret(c, shared, rules) : undefined;
          return interpret ? { ...c, interpret } : c;
        });
      const gapRows = gapped.slice(0, LIST_ROWS).map((c) => ({
        path: c.path,
        frames: c.frames,
        first_frame: c.firstFrame,
        last_frame: c.lastFrame,
        missing: c.missing?.count,
        missing_ranges: (c.missing?.ranges ?? []).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ") + (c.missing?.truncated ? ", ..." : ""),
      }));
      const importedGapped = args.missing_frames === "import" ? picked.fresh.filter((c) => c.missing) : [];
      for (const c of fresh) {
        if (!c.interpret) continue;
        const ok = InterpretSettingsSchema.safeParse(c.interpret);
        if (!ok.success) {
          return {
            ok: false,
            error: "bad_args",
            message: `The settings that apply to ${c.path} don't fit together: ${ok.error.issues.map((i) => i.message).join("; ")}. Nothing was imported.`,
          };
        }
      }
      const base = {
        ok: true as const,
        ...(folder ? { folder } : {}),
        bin,
        ...(args.target_folder_id !== undefined ? { target_folder_id: args.target_folder_id } : {}),
        already_in_project: already.length,
        still_writing: settling.slice(0, LIST_ROWS).map((c) => c.path),
        ...(settling.length > LIST_ROWS ? { still_writing_total: settling.length } : {}),
        ...(scanStats?.truncated
          ? {
              scan_truncated: true,
              files_seen: scanStats.files_seen,
              scan_limit: MAX_SCAN_FILES,
              incomplete_folders: scanStats.incomplete_dirs ?? [],
              scan_message: `${folder} holds ${scanStats.files_seen} importable files, more than the ${MAX_SCAN_FILES} one scan covers. Folders the limit cut (${(scanStats.incomplete_dirs ?? []).join(", ") || "the top folder"}) were left out because a sequence there could be missing frames; the rest is listed. Point \`folder\` at a subfolder, or list files with \`paths\`.`,
            }
          : {}),
        ...(scanStats?.unchecked_singles
          ? {
              singles_not_checked: scanStats.unchecked_singles,
              singles_message: `${scanStats.unchecked_singles} single file(s) were not looked at: a scan checks at most ${MAX_SINGLE_STATS} single files. Use a subfolder as \`folder\`, or \`paths\`.`,
            }
          : {}),
        ...(watch ? { watch } : {}),
        ...(gapped.length > 0
          ? {
              missing_frames: gapRows,
              ...(gapped.length > LIST_ROWS ? { missing_frames_total: gapped.length } : {}),
              missing_frames_message: `${gapped.length} sequence(s) have frames missing and were not imported: After Effects would stop the import with a modal "is missing N frames" warning. Re-render the missing frames, or call again with missing_frames: "import" and answer the warning (ae_dialogs).`,
            }
          : {}),
        ...(importedGapped.length > 0 && !args.dry_run
          ? { missing_frames_note: `${importedGapped.length} sequence(s) with missing frames are imported: After Effects shows an "is missing N frames" warning for each, and the import waits until it is answered. Read it with ae_dialogs.` }
          : {}),
      };
      if (args.dry_run || fresh.length === 0) {
        const empty = shapeImportResult({ requested: fresh.length + scanFailed.length, imported: [], failed: scanFailed, skipped_existing: already.length, still_writing: settling.length });
        return {
          ...base,
          summary: empty.summary,
          dry_run: args.dry_run === true,
          to_import: fresh.slice(0, DRY_RUN_ROWS).map(dryRow),
          to_import_total: fresh.length,
          to_import_truncated: fresh.length > DRY_RUN_ROWS,
          ...(fresh.length > MAX_IMPORT ? { over_limit: `${fresh.length} new files; a real import takes up to ${MAX_IMPORT} a call.` } : {}),
          imported: [],
          failed: scanFailed,
        };
      }
      if (fresh.length > MAX_IMPORT) {
        return { ok: false, error: "too_many", message: `${fresh.length} new files; import up to ${MAX_IMPORT} a call (use a subfolder as \`folder\`, or paths).` };
      }
      const res = await importAssetFiles(ctx, projectPath, bin, fresh, "ae_import_assets", {
        targetFolderId: args.target_folder_id,
        maxSeconds: args.max_seconds,
      });
      // Add what only the scan knows (frame counts) to the rows.
      const info = new Map(fresh.map((c) => [normPath(c.path), c]));
      const imported = res.imported.map((i) => {
        const c = info.get(normPath(i.path));
        return c?.frames !== undefined ? { ...i, frames: c.frames, ...(c.firstFrame !== undefined ? { first_frame: c.firstFrame, last_frame: c.lastFrame } : {}) } : i;
      });
      const shaped = shapeImportResult({
        requested: fresh.length + scanFailed.length,
        imported,
        failed: [...scanFailed, ...res.failed],
        skipped_existing: already.length,
        still_writing: settling.length,
        not_attempted: res.not_attempted,
      });
      return {
        ...base,
        op_id: res.op_id,
        ...shaped,
        ...(res.folder_id !== undefined ? { folder_id: res.folder_id } : {}),
        not_attempted: res.not_attempted,
        not_attempted_paths: res.not_attempted_paths.slice(0, IMPORT_PATHS),
        ...(res.not_attempted > 0
          ? { message: `Stopped at the time budget: ${res.not_attempted} file(s) were not started. Call again with the same arguments to continue; files already in the project are skipped. This import and the next are separate undo steps.` }
          : {}),
        checkpoint: res.checkpoint,
        receipt: res.receipt,
      };
    },
  },
];
