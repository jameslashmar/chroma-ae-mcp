/**
 * server/src/tools/ext/assets.ts
 *
 * Asset staging and import:
 * - ae_import_assets: imports what is new in the asset folder
 *   (`<project dir>/_assets/` by default) into the `_Assets` bin, mirroring
 *   subfolders, with numbered stills as sequences; or turns the watcher on/off
 * - AssetWatcher: while on, polls the open project's asset folder and imports
 *   files that arrive, through the same guarded, checkpointed write
 *
 * Files still being written (changed in the last 2 s; sequences 10 s) wait for the next look.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_ASSET_BIN,
  DEFAULT_ASSET_FOLDER,
  normPath,
  pickNewAssets,
  scanAssets,
  type AssetCandidate,
} from "../../assets.js";
import { BridgeError } from "../../host.js";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";

export const SETTLE_MS = 2000;
/** Sequences are renders in progress: wait longer after the newest frame. */
const SEQUENCE_SETTLE_MS = 10_000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60_000;
const MAX_IMPORT = 200;

export const AeImportAssetsSchema = z.object({
  folder: z
    .string()
    .min(1)
    .optional()
    .describe(`Absolute folder to import from. Default: ${DEFAULT_ASSET_FOLDER}/ next to the open .aep (created if missing).`),
  bin: z.string().min(1).max(200).optional().describe(`Project folder to import into; subfolders mirror the asset folder's. Default '${DEFAULT_ASSET_BIN}'.`),
  recursive: z.boolean().optional().describe("Include subfolders (except ones starting with _ or .). Default true."),
  sequences: z.boolean().optional().describe("Import numbered stills (shot_0001.png ...) as one sequence. Default true."),
  dry_run: z.boolean().optional().describe("List what would be imported without importing."),
  watch: z
    .boolean()
    .optional()
    .describe(`Turn auto-import on or off: while on, files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported into ${DEFAULT_ASSET_BIN} within seconds. Persists across restarts.`),
  expect: z
    .object({ project_path: z.string().min(1) })
    .describe("The open project's path; the import is refused if another project is open."),
});

type Args = z.infer<typeof AeImportAssetsSchema>;

interface ImportOutcome {
  ok: true;
  folder: string;
  bin: string;
  imported: Array<{ path: string; item_id: number; name: string; type: string; sequence: boolean }>;
  failed: Array<{ path: string; error: string }>;
  already_in_project: number;
  still_writing: string[];
  op_id?: string;
  checkpoint?: unknown;
  receipt?: unknown;
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
  return { path: c.path.replace(/\\/g, "/"), subfolder: c.subfolder, sequence: c.sequence };
}

/** Guarded, checkpointed import of `fresh`, read back in a separate evalScript. */
export async function importAssetFiles(
  ctx: ToolContext,
  projectPath: string,
  bin: string,
  fresh: AssetCandidate[],
  toolName: string
): Promise<{ op_id: string; imported: ImportOutcome["imported"]; failed: ImportOutcome["failed"]; checkpoint: unknown; receipt: unknown }> {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect = { project_path: projectPath };
  const noop = { op_id: opId, imported: [], failed: [], checkpoint: null, receipt: null };
  const readBin = (suffix: string) =>
    ctx.bridge.evalRaw<{ items: Array<{ item_id: number; bin: string; name: string; path: string | null }> }>({
      id: `${opId}_${suffix}`,
      script: buildJsxCall("assetBinContents", { bin }),
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
      const before = await readBin("before");
      const write = await ctx.bridge.evalRaw<{ bin_id: number; imported: ImportOutcome["imported"]; failed: ImportOutcome["failed"] }>({
        id: opId,
        script: buildJsxCall("importAssets", { expect, bin, items: todo.map(plan) }),
        label: `${toolName}: import ${todo.length} file(s) into ${bin}`,
        mutates: true,
        toolName,
      });
      // Separate evalScript for the read-back.
      const after = await readBin("after");
      const inBin = new Set((after.result?.items ?? []).map((i) => (i.path ? normPath(i.path) : "")));
      const mismatches: ReceiptMismatch[] = write.result.imported
        .filter((i) => !inBin.has(normPath(i.path)))
        .map((i) => ({ path: `bin.${i.name}`, expected: i.path, actual: undefined, message: `${i.name} is not in ${bin} after the import` }));
      return {
        op_id: opId,
        imported: write.result.imported,
        failed: write.result.failed,
        checkpoint,
        receipt: buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches }),
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
      const candidates = scanAssets(folder, { recursive: settings.recursive, sequences: settings.sequences }).filter(
        (c) => !seen.has(normPath(c.path)) && c.arrivedMs >= since
      );
      if (candidates.length === 0) return null;
      const inProject = await readFootagePaths(this.ctx, "quiet: asset watch (footage)", "asset_watch");
      const now = (this.opts.now ?? Date.now)();
      const { fresh, already } = pickNewAssets(candidates, inProject.paths, now, SETTLE_MS, SEQUENCE_SETTLE_MS);
      for (const c of already) seen.add(normPath(c.path));
      if (fresh.length === 0) return null;
      const res = await importAssetFiles(this.ctx, projectPath, DEFAULT_ASSET_BIN, fresh.slice(0, MAX_IMPORT), "asset_watch");
      for (const i of res.imported) seen.add(normPath(i.path));
      for (const f of res.failed) seen.add(normPath(f.path));
      this.opts.log?.("ok", `Asset watch imported ${res.imported.length} file(s) into ${DEFAULT_ASSET_BIN}${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      return { imported: res.imported.length, failed: res.failed.length };
    }
  }
}

export const assetsTools: ToolDefinition<any>[] = [
  {
    name: "ae_import_assets",
    description:
      `Import staged assets: files in the asset folder (${DEFAULT_ASSET_FOLDER}/ next to the open .aep unless \`folder\` says otherwise) that are not in the project yet go into the ${DEFAULT_ASSET_BIN} bin, with subfolders mirrored and numbered stills (shot_0001.png ...; at least 3 frames, 3-7 digits, not v002-style versions) as one sequence, which waits until 10 s after its newest frame so a render in progress is not imported half-done. ` +
      "Save generated or delivered files (images, renders, voice-overs) there, then call this; files already in the project are skipped, and files still being written wait. " +
      `\`watch: true\` turns on auto-import: files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported within seconds, until \`watch: false\` (turn it on only when the user wants it). ` +
      "The import is one undo group guarded by `expect`, with an auto checkpoint, and the bin is read back in a separate evalScript. " +
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
      if (projectPath === "<unsaved>" && !args.folder) {
        return { ok: false, error: "unsaved_project", message: "The project has not been saved, so it has no asset folder. Save it, or pass an absolute folder.", watch };
      }
      const folder = args.folder ?? path.join(path.dirname(projectPath), DEFAULT_ASSET_FOLDER);
      if (!path.isAbsolute(folder)) return { ok: false, error: "bad_args", message: `folder must be absolute: ${folder}` };
      // A dry run never creates the folder; a real import or watch:true does.
      if (!args.folder && (!args.dry_run || args.watch === true)) fs.mkdirSync(folder, { recursive: true });
      const bin = args.bin ?? DEFAULT_ASSET_BIN;
      if (!fs.existsSync(folder)) {
        if (args.dry_run) {
          return { ok: true, folder, bin, already_in_project: 0, still_writing: [], ...(watch ? { watch } : {}), dry_run: true, to_import: [], imported: [], failed: [] };
        }
        return { ok: false, error: "not_found", message: `No such folder: ${folder}` };
      }

      const candidates = scanAssets(folder, { recursive: args.recursive, sequences: args.sequences });
      const { fresh, already, settling } = pickNewAssets(candidates, current.paths, Date.now(), SETTLE_MS, SEQUENCE_SETTLE_MS);
      const base = {
        ok: true as const,
        folder,
        bin,
        already_in_project: already.length,
        still_writing: settling.map((c) => c.path),
        ...(watch ? { watch } : {}),
      };
      if (args.dry_run || fresh.length === 0) {
        return {
          ...base,
          dry_run: args.dry_run === true,
          to_import: fresh.map((c) => ({ ...plan(c), frames: c.frames })),
          imported: [],
          failed: [],
        };
      }
      if (fresh.length > MAX_IMPORT) {
        return { ok: false, error: "too_many", message: `${fresh.length} new files; import up to ${MAX_IMPORT} a call (use a subfolder as \`folder\`).` };
      }
      const res = await importAssetFiles(ctx, projectPath, bin, fresh, "ae_import_assets");
      return { ...base, ...res };
    },
  },
];
