import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../host.js";
import { buildJsxCall, normalizeGuardPath, pathsMatchForGuard } from "../jsx.js";
import { lintJsxSafety, safetyRefusalMessage } from "../jsx-safety-lint.js";
import { buildReceipt, type ReceiptMismatch } from "../receipts.js";
import { QueueWaitError } from "../queue.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { recordRunJsx } from "../skills.js";
import { readAfterWrite } from "./read-back.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite, noteProjectRetarget } from "./ext/session.js";

/**
 * Called after ae_save save_as / increment moved the open project to another file. A hook returns a sentence
 * for the result when it changed something (projectsession.ts uses it to turn its timed save off). Hooks never
 * throw out of here.
 */
export type ProjectRetargetHook = (oldPath: string, newPath: string) => string | null;
const retargetHooks: ProjectRetargetHook[] = [];
export function registerProjectRetargetHook(hook: ProjectRetargetHook): void {
  if (!retargetHooks.includes(hook)) retargetHooks.push(hook);
}
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolContext,
  type ToolDefinition,
} from "./common.js";

export const KeyframeItemSchema = z.object({
  time: z.number().describe("Keyframe time in seconds."),
  value: z.unknown().describe("Keyframe value at `time`."),
  interp: z
    .enum(["linear", "bezier", "hold"])
    .optional()
    .describe("Optional interpolation mode ('linear', 'bezier', or 'hold')."),
});

export const AeRunJsxSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe(
        "Body of an ExtendScript function to run; use `return <value>` to return a result. Errors map back to the line in `code`."
      ),
    mutates: z
      .boolean()
      .describe(
        "True if the script mutates After Effects state (wraps in an undo group, requires `expect`, and records a before/after receipt)."
      ),
    label: z
      .string()
      .min(1)
      .describe("Human-readable label for the undo group and panel log."),
    expect: ExpectSchema.optional().describe(
      "Required when `mutates` is true. Verifies project_path and optional comp_id before running."
    ),
  })
  .superRefine((val, ctx) => {
    if (val.mutates && !val.expect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expect"],
        message: "`expect` is required when `mutates` is true.",
      });
    }
  });

export const AeSetPropertySchema = z
  .object({
    comp_id: z.number().int().describe("Target CompItem ID."),
    layer: LayerSelectorSchema,
    path: z
      .array(z.union([z.string().min(1), z.number().int().min(1)]))
      .min(1)
      .describe(
        "Property path from the layer root (e.g. ['Transform', 'Opacity'] or ['ADBE Transform Group', 'ADBE Opacity']). A number is a 1-based index inside an indexed group (masks, effects, shape contents), as ae_status detail gives when two siblings share a name."
      ),
    value: z
      .unknown()
      .optional()
      .describe(
        "Static value to set on the property (when not keyframed; on a keyframed property it sets a key at the comp's current time). " +
          "Numbers for a one-dimensional property, [x, y] / [x, y, z] arrays for the others, [r, g, b] or [r, g, b, a] (0-1) for a colour: the count and the property's min/max are checked before anything changes. " +
          "Source Text takes a string or { text, font (PostScript name), fontSize, fillColor }. " +
          "A mask or shape path (ADBE Mask Shape, ADBE Vector Shape) takes { vertices: [[x, y], ...], inTangents?: [[x, y], ...], outTangents?: [[x, y], ...], closed?: boolean } (missing tangents are zeros; every path key needs the same vertex count; ae_path_write keeps feather points and can change the vertex count). " +
          "A marker is written as a keyframe: keyframes: [{ time, value: { comment, duration?, chapter?, url?, frameTarget?, cuePointName?, label?, protectedRegion?, params? } }]."
      ),
    keyframes: z
      .array(KeyframeItemSchema)
      .optional()
      .describe("Keyframes to set on the property."),
    expression: z
      .string()
      .optional()
      .describe("Expression string to assign to the property. The read-back evaluates it once and reports `expression_error` (a non-empty one is a receipt mismatch)."),
    expression_enabled: z
      .boolean()
      .optional()
      .describe("Switch the property's expression on or off. Assigning `expression` already switches it on; use this alone to toggle an existing one."),
    allow_substitute: z
      .boolean()
      .optional()
      .describe("Source Text only: write a font name that is not installed anyway (After Effects then substitutes silently). Default false: an unknown font is refused with near matches."),
    expect: ExpectSchema,
  })
  .refine(
    (val) =>
      val.value !== undefined ||
      (val.keyframes !== undefined && val.keyframes.length > 0) ||
      val.expression !== undefined ||
      val.expression_enabled !== undefined,
    {
      message:
        "ae_set_property requires at least one of `value`, `keyframes`, or `expression` (or `expression_enabled`).",
    }
  );

const MAX_PATH_VERTICES = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * What a write is expected to read back as. A string written to Source Text
 * reads back as a document ({ text, ... }); a path written with missing
 * tangents reads back with zero tangents, and past 500 vertices the read-back
 * is cut, so the expectation is cut the same way. Everything else is as given.
 */
export function normaliseExpectedValue(expected: unknown, actual: unknown): unknown {
  if (typeof expected === "string" && isRecord(actual) && "text" in actual) return { text: expected };
  // A colour is written as [r, g, b] or [r, g, b, a] but AE reads it back with four numbers.
  if (
    Array.isArray(expected) &&
    Array.isArray(actual) &&
    expected.length === 3 &&
    actual.length === 4 &&
    expected.every((n) => typeof n === "number") &&
    typeof actual[3] === "number"
  ) {
    return [...expected, actual[3]];
  }
  if (isRecord(expected) && isRecord(actual) && Array.isArray(expected.vertices) && Array.isArray(actual.vertices)) {
    const zeros = (n: number) => Array.from({ length: n }, () => [0, 0]);
    const n = expected.vertices.length;
    const cut = (v: unknown[]) => (actual.truncated === true ? v.slice(0, MAX_PATH_VERTICES) : v);
    return {
      vertices: cut(expected.vertices),
      inTangents: cut(Array.isArray(expected.inTangents) ? expected.inTangents : zeros(n)),
      outTangents: cut(Array.isArray(expected.outTangents) ? expected.outTangents : zeros(n)),
      closed: expected.closed !== false,
    };
  }
  return expected;
}

/** Why a save_as path cannot be used before anything touches the disk, or null. */
export function saveAsPathProblem(p: string): string | null {
  if (!path.isAbsolute(p)) return `save_as.path must be an absolute path, got "${p}".`;
  if (path.extname(p).toLowerCase() !== ".aep") return `save_as.path must end in .aep, got "${p}".`;
  const parts = path.normalize(p).split(/[\\/]+/);
  if (parts.some((seg) => seg.toLowerCase() === "_mcp_backups")) {
    return "save_as.path cannot be inside a _mcp_backups folder: those hold the server's own backups.";
  }
  return null;
}

export const AeSaveSchema = z
  .object({
    expect: ExpectSchema,
    backup: z
      .boolean()
      .default(true)
      .optional()
      .describe(
        "If true (default), the server copies the existing .aep file to <project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep before calling app.project.save(). With save_as, the same copy is made of a file that save_as overwrites."
      ),
    save_as: z
      .object({
        path: z
          .string()
          .min(1)
          .describe("Absolute path of the new .aep. Its folder must already exist (ae_save never creates folders)."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace a file that already exists at `path`. Default false: an existing file is refused."),
      })
      .optional()
      .describe(
        "Save the open project under a new name (Save As). Works for an untitled project, which a plain save cannot. The open project then points at the new file; the old file, its checkpoints and its _mcp_backups stay with the old path, untouched."
      ),
    increment: z
      .boolean()
      .optional()
      .describe(
        "Increment and Save: save as the next free <name>_vNNN.aep in the same folder (name_v001 -> name_v002; a name with no _vNNN suffix gets _v002). Never overwrites. Needs a saved project. Not with save_as."
      ),
  })
  .superRefine((val, ctx) => {
    if (val.save_as && val.increment) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["increment"], message: "Give either save_as or increment, not both." });
    }
    if (val.save_as) {
      const problem = saveAsPathProblem(val.save_as.path);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["save_as", "path"], message: problem });
    }
  });

/**
 * The next free `<name>_vNNN.aep` beside a saved project: one more than the
 * highest _vNNN of that name already in the folder (and than this file's own).
 * `listing` is the folder's file names (read from disk when left out).
 */
export function nextIncrementPath(projectPath: string, listing?: string[]): string {
  const dir = path.dirname(projectPath);
  const ext = path.extname(projectPath) || ".aep";
  const stem = path.basename(projectPath, path.extname(projectPath));
  const m = /^(.*)_v(\d+)$/i.exec(stem);
  const base = m ? m[1] : stem;
  const width = m ? Math.max(3, m[2].length) : 3;
  let n = m ? parseInt(m[2], 10) : 1;
  const names = listing ?? fs.readdirSync(dir);
  const escaped = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped(base) + "_v(\\d+)" + escaped(ext) + "$", "i");
  const taken = new Set(names.map((f) => f.toLowerCase()));
  for (const f of names) {
    const fm = re.exec(f);
    if (fm) n = Math.max(n, parseInt(fm[1], 10));
  }
  let name: string;
  do {
    n++;
    name = `${base}_v${String(n).padStart(width, "0")}${ext}`;
  } while (taken.has(name.toLowerCase()));
  return path.join(dir, name);
}

/** Checks the disk for a save_as target (the pure checks are saveAsPathProblem). Throws; nothing has been written. */
export function checkSaveAsTarget(target: string, overwrite: boolean): void {
  const problem = saveAsPathProblem(target);
  if (problem) throw new Error(problem);
  let dirOk = false;
  try {
    dirOk = fs.statSync(path.dirname(target)).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    throw new Error(`The folder "${path.dirname(target)}" does not exist. ae_save never creates folders: make it first, or pick another path.`);
  }
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) throw new Error(`"${target}" is a folder, not a project file.`);
    if (!overwrite) {
      throw new Error(`"${target}" already exists. Pass save_as.overwrite: true to replace it, or choose another name (or use increment).`);
    }
  }
}

interface GuardCheckResult {
  ok?: boolean;
  project_path?: string;
  comp_id?: number | null;
  comp_is_valid?: boolean;
  /** Unsaved changes in the open project (null when AE couldn't say). */
  dirty?: boolean | null;
}

/**
 * Verifies the target guard inside an active queue lease.
 * Checks both server-side path normalisation and host-side `checkGuard`.
 */
export async function verifyTargetGuard(
  ctx: ToolContext,
  expect: ExpectGuard,
  opId: string
): Promise<GuardCheckResult> {
  const resp = await ctx.bridge.evalRaw<GuardCheckResult>({
    id: `${opId}_guard`,
    script: buildJsxCall("checkGuard", { expect }),
    label: "checkGuard",
    mutates: false,
    toolName: "checkGuard",
  });

  const res = resp.result ?? {};
  const actualPath = res.project_path ?? "<unsaved>";

  if (!pathsMatchForGuard(expect.project_path, actualPath)) {
    throw new BridgeError({
      kind: "guard",
      op_id: opId,
      message: `Target guard refused mutation: expected project_path "${expect.project_path}", but After Effects has "${actualPath}" open. Jay may be editing live — stop and re-read state, do not retry blindly.`,
      expected: expect,
      actual: {
        project_path: actualPath,
        comp_id: res.comp_id ?? null,
      },
    });
  }

  if (expect.comp_id !== undefined && res.comp_is_valid === false) {
    throw new BridgeError({
      kind: "guard",
      op_id: opId,
      message: `Target guard refused mutation: expected comp_id ${expect.comp_id} to be a CompItem, but it was not found or is not a CompItem. Stop and re-read state.`,
      expected: expect,
      actual: {
        project_path: actualPath,
        comp_id: res.comp_id ?? null,
      },
    });
  }

  return res;
}

export function formatBackupTimestamp(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

export interface AutoCheckpointResult {
  /**
   * created: copied now. reused: the saved file hasn't changed since the
   * last auto checkpoint, which still holds it. skipped: see `reason`.
   */
  status: "created" | "reused" | "skipped";
  path?: string;
  reason?: string;
  /**
   * True when AE had unsaved changes: the checkpoint holds the last save,
   * not what is open in AE right now.
   */
  unsaved_changes_not_included?: boolean;
}

// Saved-file state of the last auto checkpoint per project, so a run of
// writes between two saves makes one copy, not one per write. Capped and
// evicted oldest-first so a long-running server that touches many different
// projects over days/weeks doesn't grow this map without bound.
const MAX_TRACKED_PROJECTS = 200;
const lastAutoCheckpoint = new Map<string, { size: number; mtimeMs: number; path: string }>();

function rememberAutoCheckpoint(key: string, entry: { size: number; mtimeMs: number; path: string }): void {
  lastAutoCheckpoint.delete(key); // re-insert at the end (most-recently-used)
  lastAutoCheckpoint.set(key, entry);
  while (lastAutoCheckpoint.size > MAX_TRACKED_PROJECTS) {
    const oldestKey = lastAutoCheckpoint.keys().next().value;
    if (oldestKey === undefined) break;
    lastAutoCheckpoint.delete(oldestKey);
  }
}

export function resetAutoCheckpointMemory(): void {
  lastAutoCheckpoint.clear();
}

/**
 * The `_mcp_checkpoints` directory for a project path. If the path is
 * already inside a `_mcp_checkpoints` directory (e.g. the project now open
 * because of an earlier ae_checkpoint_revert, which opens the checkpoint
 * file itself rather than a copy of it), reuses that same directory instead
 * of nesting `_mcp_checkpoints/_mcp_checkpoints/` inside it.
 */
export function checkpointDirFor(projectPath: string): string {
  const dir = path.dirname(projectPath);
  return path.basename(dir) === "_mcp_checkpoints" ? dir : path.join(dir, "_mcp_checkpoints");
}

/**
 * Copies the saved project to `<projectdir>/_mcp_checkpoints/<name>_<stamp>_auto-<tool>.aep`
 * before a write, so the write can be undone across sessions with
 * ae_checkpoint_revert. AE can't write its in-memory state to another file
 * without retargeting the project (Save As), so this copies the last save
 * and says so when there are unsaved changes. Call it inside the queue
 * lease, after the target guard passes. It never throws: a failed copy is
 * reported as skipped and the write goes ahead.
 */
export async function autoCheckpoint(
  ctx: ToolContext,
  guard: GuardCheckResult,
  toolName: string
): Promise<AutoCheckpointResult> {
  const settings = ctx.settings?.get().auto_checkpoint ?? DEFAULT_SETTINGS.auto_checkpoint;
  if (!settings.enabled) {
    return { status: "skipped", reason: "Auto checkpoints are off (see ae_auto_checkpoint)." };
  }
  const projectPath = guard.project_path ?? "<unsaved>";
  if (projectPath === "<unsaved>") {
    return { status: "skipped", reason: "The project has never been saved, so there is no file to copy." };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(projectPath);
  } catch {
    return { status: "skipped", reason: `The project file is not on disk: "${projectPath}".` };
  }
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb > settings.max_mb) {
    return {
      status: "skipped",
      reason: `The project file is ${sizeMb.toFixed(0)} MB, over the ${settings.max_mb} MB limit (see ae_auto_checkpoint).`,
    };
  }

  // dirty is `true`, `false`, or `null` (AE couldn't say). Only a confirmed
  // `false` means the checkpoint is known-complete; treat unknown the same
  // as dirty, since it's the one case most worth flagging.
  const unsaved = guard.dirty === false ? {} : { unsaved_changes_not_included: true };
  const key = normalizeGuardPath(projectPath);
  const last = lastAutoCheckpoint.get(key);
  if (last && last.size === stat.size && last.mtimeMs === stat.mtimeMs && fs.existsSync(last.path)) {
    rememberAutoCheckpoint(key, last);
    return { status: "reused", path: last.path, ...unsaved };
  }

  const ext = path.extname(projectPath) || ".aep";
  const dir = checkpointDirFor(projectPath);
  const stem = `${path.basename(projectPath, ext)}_${formatBackupTimestamp(new Date())}_auto-${toolName}`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    let target = path.join(dir, `${stem}${ext}`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem}-${n}${ext}`);
    await fs.promises.copyFile(projectPath, target, fs.constants.COPYFILE_EXCL);
    rememberAutoCheckpoint(key, { size: stat.size, mtimeMs: stat.mtimeMs, path: target });
    // The panel counts these lines for its Checkpoints tile (panel/client/common.js).
    ctx.log?.("ok", `Checkpoint saved before ${toolName}: ${path.basename(target)}`);
    return { status: "created", path: target, ...unsaved };
  } catch (err) {
    return {
      status: "skipped",
      reason: `Copying the project failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const mutateTools: ToolDefinition<any>[] = [
  {
    name: "ae_run_jsx",
    description:
      "Execute ExtendScript code (the body of a function; use `return` to return a value). " +
      "When `mutates: true`, `expect` is required, the script runs inside a single undo group (`label`), " +
      "and a separate read-back evalScript produces a before/after receipt of `expect.comp_id` (or project summary). " +
      "Note: `app.executeCommand` silently does nothing through CEP; use DOM methods instead (e.g. `layer.duplicate()`). " +
      "Never use chained ternaries (`a ? b : c ? d : e`) in ExtendScript as it parses them left-associatively; use `if/else`. " +
      "A static safety lint runs first and refuses code that calls members which break the hard limits, naming the dedicated tool each time: " +
      "system.callSystem, File/Folder .execute, file writes and deletes (File/Folder remove, rename, copy, create, write, open for writing), " +
      "dialogs (alert, confirm, prompt, File.openDialog, ScriptUI; use ae_ask_user, never app.beginSuppressDialogs, see ae_dialogs), sockets, $.evalFile, #include, $.sleep, " +
      "app.quit/restart, app.scheduleTask, app.watchFolder, app.newProject/open/openFast and project.close (use ae_project_session), project.save() in any form (use ae_save, with save_as for another file), File properties such as item.file.remove(), " +
      "renderQueue.render (use ae_aerender_start), app.purge (use ae_memory_purge), Team Project methods. " +
      "With `mutates: false` it also refuses writes (setValue, addProperty, layers.add, remove, duplicate, ...): set `mutates: true` and `expect`. " +
      "The lint is a best-effort guard rail, not a sandbox: eval() of a built string or obj['member'] is not caught, and you remain responsible for what the code does. " +
      "The result's `op_id` can be passed to ae_skill_save to keep a script that worked as a reusable skill. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRunJsxSchema,
    handler: async (args, ctx) => {
      // Before any evalScript and before the queue: a refused script never reaches After Effects.
      const unsafe = lintJsxSafety(args.code, { mutates: args.mutates });
      if (unsafe.length > 0) {
        throw new BridgeError({
          kind: "evalscript_error",
          message: safetyRefusalMessage(unsafe, "ae_run_jsx code"),
          line: unsafe[0].line,
          actual: unsafe,
        });
      }
      if (!args.mutates) {
        const res = await ctx.bridge.callHost(
          "runUserJsx",
          {
            code: args.code,
            mutates: false,
            label: args.label,
          },
          {
            label: `ae_run_jsx: ${args.label}`,
            mutates: false,
            toolName: "ae_run_jsx",
          }
        );
        recordRunJsx({ op_id: res.id, label: args.label, code: args.code, mutates: false, at: new Date().toISOString() });
        return { op_id: res.id, result: res.result };
      }

      // Mutating path
      ctx.quarantine.assertClear();
      const expect = args.expect!;
      const opId = ctx.bridge.newOpId();

      try {
        return await ctx.queue.run(`ae_run_jsx: ${args.label}`, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_run_jsx");

          const note = { opId, toolName: "ae_run_jsx", label: args.label, expect, checkpoint: checkpoint?.path ?? null };
          const sessionFields = await noteBeforeWrite(ctx, note);
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("snapshotForReceipt", {
              comp_id: expect.comp_id,
            }),
            label: `${args.label} (before snapshot)`,
            mutates: false,
            toolName: "ae_run_jsx",
          });

          beginInflight(note);
          let writeResp;
          try {
            writeResp = await ctx.bridge.evalRaw({
              id: opId,
              script: buildJsxCall("runUserJsx", {
                code: args.code,
                mutates: true,
                label: args.label,
                expect,
              }),
              label: args.label,
              mutates: true,
              toolName: "ae_run_jsx",
            });
          } finally {
            endInflight(opId);
          }

          // Separate evalScript for read-back (reads in the same script as a write return stale values).
          // The write is applied from here on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw({
              id: `${opId}_after`,
              script: buildJsxCall("snapshotForReceipt", {
                comp_id: expect.comp_id,
              }),
              label: `${args.label} (after snapshot)`,
              mutates: false,
              toolName: "ae_run_jsx",
            })
          );

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterRead.value?.result ?? null,
            customMismatches: afterRead.failure ? [afterRead.failure] : undefined,
          });
          recordRunJsx({ op_id: opId, label: args.label, code: args.code, mutates: true, at: new Date().toISOString() });
          await noteAfterWrite(ctx, note, { skipRead: !!afterRead.failure });

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            checkpoint,
            receipt,
            ...sessionFields,
          };
        });
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
    name: "ae_set_property",
    description:
      "Mutate a layer property's value, keyframes, or expression within one undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. " +
      "Everything that can fail is checked before the undo group opens: the value's dimension count and the property's min/max, a path value's shape, a marker written as a plain value, separated dimensions (write the X/Y followers), a font that is not installed (refused with near matches unless allow_substitute), and path keys with different vertex counts. " +
      "For paths use { vertices, inTangents?, outTangents?, closed? } (see `value`); for markers use keyframes. " +
      "An expression is evaluated once in the read-back: `expression_error` carries After Effects' message and a non-empty one is a receipt mismatch, and so is an assigned expression that reads back as switched off, even with no error text. `expression_enabled` switches an expression on or off. " +
      "Read what a property accepts first with ae_get_layer_props meta: true (value type, units, min, max, separation, dropdown items). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetPropertySchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_property(${args.path.join(".")})`;

      // Ensure expect.comp_id defaults to args.comp_id if not explicitly set
      const effectiveExpect: ExpectGuard = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id,
      };

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_property");

          const note = { opId, toolName: "ae_set_property", label, expect: effectiveExpect, checkpoint: checkpoint?.path ?? null };
          const sessionFields = await noteBeforeWrite(ctx, note);
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getLayerProps", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              depth: 1,
              shape_values: true,
              text_full: true,
              value_only: true,
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_property",
          });

          const wroteExpression = args.expression !== undefined || args.expression_enabled === true;
          beginInflight(note);
          let writeResp;
          try {
            writeResp = await ctx.bridge.evalRaw({
              id: opId,
              script: buildJsxCall("setProperty", {
                comp_id: args.comp_id,
                layer: args.layer,
                path: args.path,
                value: args.value,
                keyframes: args.keyframes,
                expression: args.expression,
                expression_enabled: args.expression_enabled,
                allow_substitute: args.allow_substitute,
                expect: effectiveExpect,
              }),
              label,
              mutates: true,
              toolName: "ae_set_property",
            });
          } finally {
            endInflight(opId);
          }

          // Separate evalScript for read-back. The write is applied from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("getLayerProps", {
                comp_id: args.comp_id,
                layer: args.layer,
                path: args.path,
                depth: 1,
                shape_values: true,
                text_full: true,
                value_only: true,
                expression_error: wroteExpression,
              }),
              label: `${label} (after)`,
              mutates: false,
              toolName: "ae_set_property",
            })
          );
          // A host that changed nothing opened no undo group, so it is no undo step.
          const noop = (writeResp.result as { no_op?: unknown } | null | undefined)?.no_op === true;
          if (afterRead.failure) {
            await noteAfterWrite(ctx, note, { skipRead: true, addStep: !noop });
            return {
              op_id: opId,
              applied: true as const,
              result: writeResp.result,
              checkpoint,
              receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
              ...sessionFields,
            };
          }
          const afterSnap = afterRead.value!;

          const expectedCheck: Record<string, unknown> = {};
          const actualCheck: Record<string, unknown> = {};
          const afterObj = (afterSnap.result ?? {}) as Record<string, unknown>;
          const propObj =
            afterObj.property && typeof afterObj.property === "object"
              ? (afterObj.property as Record<string, unknown>)
              : afterObj;

          if (args.value !== undefined) {
            expectedCheck.value = normaliseExpectedValue(args.value, propObj.value);
            actualCheck.value = propObj.value;
          }
          if (args.expression !== undefined) {
            expectedCheck.expression = args.expression;
            actualCheck.expression = propObj.expression;
          }
          if (args.expression_enabled !== undefined) {
            expectedCheck.expressionEnabled = args.expression_enabled;
            actualCheck.expressionEnabled = propObj.expressionEnabled;
          }
          // An expression that errors still reads back as applied: ask for the error itself.
          const expressionError = typeof propObj.expressionError === "string" ? propObj.expressionError : null;
          const customMismatches: ReceiptMismatch[] = [];
          if (wroteExpression && expressionError) {
            customMismatches.push({
              path: "expressionError",
              expected: "",
              actual: expressionError,
              message: `The expression has an error: ${expressionError}`,
            });
          }
          // A bad expression switches itself off in AE: the string reads back as written, the switch does not.
          if (
            typeof args.expression === "string" &&
            args.expression.length > 0 &&
            args.expression_enabled !== false &&
            propObj.expressionEnabled === false
          ) {
            customMismatches.push({
              path: "expressionEnabled",
              expected: true,
              actual: false,
              message: "The expression was assigned but After Effects switched it off" + (expressionError ? ": " + expressionError : "."),
            });
          }
          // A font that was written but is a substitute now: After Effects swapped it without a word.
          const fontObject = isRecord(propObj.value) && isRecord(propObj.value.fontObject) ? propObj.value.fontObject : null;
          const wroteFont = isRecord(args.value) && typeof args.value.font === "string";
          const fontSubstituted = wroteFont && fontObject !== null && fontObject.is_substitute === true;
          if (fontSubstituted && args.allow_substitute !== true) {
            customMismatches.push({
              path: "value.fontObject.is_substitute",
              expected: false,
              actual: true,
              message: `After Effects substituted the font "${(args.value as { font: string }).font}": it is not installed.`,
            });
          }
          if (args.keyframes !== undefined) {
            expectedCheck.numKeys = args.keyframes.length;
            actualCheck.numKeys =
              typeof propObj.numKeys === "number"
                ? propObj.numKeys
                : Array.isArray(propObj.keyframes)
                ? propObj.keyframes.length
                : undefined;
          }

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected:
              Object.keys(expectedCheck).length > 0 ? expectedCheck : undefined,
            actualForExpected:
              Object.keys(expectedCheck).length > 0 ? actualCheck : undefined,
            customMismatches: customMismatches.length > 0 ? customMismatches : undefined,
          });

          await noteAfterWrite(ctx, note, { addStep: !noop });
          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            ...(wroteExpression ? { expression_error: expressionError ?? "" } : {}),
            ...(fontSubstituted ? { font_substituted: true } : {}),
            checkpoint,
            receipt,
            ...sessionFields,
          };
        });
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
    name: "ae_save",
    description:
      "Save the current After Effects project (`app.project.save()`). " +
      "If `backup` is true (default), the server first copies the existing .aep on disk using Node fs to `<project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep`, " +
      "and returns both paths and sizes. Never uses save-as for backups so the open project is not retargeted. " +
      "A plain save needs a project that already has a file. " +
      "`save_as: { path, overwrite? }` saves the open project under a new absolute .aep path (Save As), which is the only way to save an untitled project (for example one made by ae_project_session new). " +
      "`increment: true` is Increment and Save: it saves as the next free <name>_vNNN.aep in the same folder (name_v001 -> name_v002, a name with no suffix gets _v002), never overwriting. " +
      "Both retarget the open project to the new file: the old file stays untouched on disk, and its checkpoints and _mcp_backups stay with the old path. A timed-save policy enabled for the old path is turned off, and the result says so in `policy_disabled`. " +
      "The folder must exist, the file must not exist unless overwrite is true, and the path cannot be inside a _mcp_backups folder. " +
      "The result is read back in a separate call: the open project's path is the new one, it is not dirty, and the file on disk is non-empty and fresh. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSaveSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const doBackup = args.backup ?? true;
      const saveAs = args.save_as as { path: string; overwrite?: boolean } | undefined;
      const increment = args.increment === true;
      const retarget = !!saveAs || increment;

      try {
        return await ctx.queue.run("ae_save", async () => {
          ctx.quarantine.assertClear();

          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath =
            guardInfo.project_path ?? args.expect.project_path;

          if (!retarget && actualProjectPath === "<unsaved>") {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message:
                "Cannot run ae_save on an unsaved project (<unsaved>): it has no file to save to. Use ae_save with save_as: { path } to give it a name.",
              expected: args.expect,
              actual: { project_path: "<unsaved>" },
            });
          }
          if (retarget) return await saveElsewhere(ctx, args, opId, actualProjectPath, saveAs, increment, doBackup);

          let backupPath: string | null = null;
          let backupSize: number | null = null;
          let beforeSize: number | null = null;

          if (fs.existsSync(actualProjectPath)) {
            beforeSize = fs.statSync(actualProjectPath).size;
            if (doBackup) {
              const projDir = path.dirname(actualProjectPath);
              const ext = path.extname(actualProjectPath) || ".aep";
              const baseName = path.basename(actualProjectPath, ext);
              const backupDir = path.join(projDir, "_mcp_backups");
              fs.mkdirSync(backupDir, { recursive: true });
              const stamp = formatBackupTimestamp(new Date());
              backupPath = path.join(backupDir, `${baseName}_${stamp}${ext}`);
              fs.copyFileSync(actualProjectPath, backupPath);
              backupSize = fs.statSync(backupPath).size;
            }
          }

          const saveResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("save", {
              expect: args.expect,
            }),
            label: "ae_save",
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_save",
          });

          // Separate read-back evalScript to verify project is saved (dirty === false).
          // The save has happened, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("status", {}),
              label: "ae_save (after status)",
              mutates: false,
              toolName: "ae_save",
            })
          );
          let savedSize: number | null = null;
          try {
            savedSize = fs.existsSync(actualProjectPath) ? fs.statSync(actualProjectPath).size : null;
          } catch {
            savedSize = null;
          }
          if (afterRead.failure) {
            return {
              op_id: opId,
              applied: true as const,
              project_path: actualProjectPath,
              project_size: savedSize,
              backup_path: backupPath,
              backup_size: backupSize,
              result: saveResp.result,
              receipt: buildReceipt({
                before: { project_path: actualProjectPath, size: beforeSize },
                after: null,
                customMismatches: [afterRead.failure],
              }),
            };
          }
          const afterStatus = afterRead.value!;

          const receipt = buildReceipt({
            before: {
              project_path: actualProjectPath,
              size: beforeSize,
            },
            after: {
              project_path: actualProjectPath,
              size: savedSize,
              dirty: afterStatus.result?.dirty ?? false,
            },
            expected: { dirty: false },
            actualForExpected: {
              dirty: afterStatus.result?.dirty ?? false,
            },
          });

          return {
            op_id: opId,
            applied: true as const,
            project_path: actualProjectPath,
            project_size: savedSize,
            backup_path: backupPath,
            backup_size: backupSize,
            result: saveResp.result,
            receipt,
          };
        });
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
];

/**
 * ae_save with save_as or increment, inside the queue lease after the guard.
 * Everything that can fail is checked before the save; once the save's
 * evalScript has returned nothing here throws.
 */
async function saveElsewhere(
  ctx: ToolContext,
  args: z.infer<typeof AeSaveSchema>,
  opId: string,
  oldPath: string,
  saveAs: { path: string; overwrite?: boolean } | undefined,
  increment: boolean,
  doBackup: boolean
) {
  let target: string;
  let overwrite = false;
  if (increment) {
    if (oldPath === "<unsaved>") {
      throw new Error("ae_save increment needs a project that has been saved once. Use save_as: { path } to name this one.");
    }
    if (path.extname(oldPath).toLowerCase() !== ".aep") {
      throw new Error("ae_save increment works on .aep projects; use save_as with a .aep path for this one.");
    }
    target = nextIncrementPath(oldPath);
  } else {
    target = path.normalize(saveAs!.path);
    overwrite = saveAs!.overwrite === true;
  }
  checkSaveAsTarget(target, overwrite);

  // A file the save replaces is copied away first; the old project file is never touched.
  let backupPath: string | null = null;
  let backupSize: number | null = null;
  if (fs.existsSync(target) && doBackup) {
    const ext = path.extname(target) || ".aep";
    const backupDir = path.join(path.dirname(target), "_mcp_backups");
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `${path.basename(target, ext)}_${formatBackupTimestamp(new Date())}${ext}`);
    fs.copyFileSync(target, backupPath);
    backupSize = fs.statSync(backupPath).size;
  }

  const label = increment ? "ae_save (increment)" : "ae_save (save as)";
  const note = { opId, toolName: "ae_save", label, expect: args.expect, checkpoint: null };
  const sessionFields = await noteBeforeWrite(ctx, note);
  const requestedAt = Date.now();
  beginInflight(note);
  let saveResp;
  try {
    saveResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
      id: opId,
      script: buildJsxCall("save", { expect: args.expect, save_as_path: target }),
      label,
      timeoutMs: SLOW_TIMEOUT_MS,
      mutates: true,
      toolName: "ae_save",
    });
  } finally {
    endInflight(opId);
  }

  // From here the project has been saved to the new file: a failed read is reported, never thrown.
  const afterRead = await readAfterWrite(opId, () =>
    ctx.bridge.evalRaw<Record<string, unknown>>({
      id: `${opId}_after`,
      script: buildJsxCall("status", {}),
      label: `${label} (after status)`,
      mutates: false,
      toolName: "ae_save",
    })
  );
  let size: number | null = null;
  let fresh = false;
  try {
    const st = fs.statSync(target);
    size = st.size;
    // A little slack for coarse file-system clocks.
    fresh = st.size > 0 && st.mtimeMs >= requestedAt - 2000;
  } catch {
    size = null;
  }

  // The open project now points at the target: take a fresh baseline for it, so the next guarded write
  // is not reported as another project being open. The save is not an undo step.
  noteProjectRetarget(oldPath, target);
  await noteAfterWrite(ctx, { ...note, expect: { project_path: target, comp_id: args.expect.comp_id } }, { addStep: false, skipRead: !!afterRead.failure });
  const hookNotes: string[] = [];
  for (const hook of retargetHooks) {
    try {
      const said = hook(oldPath, target);
      if (said) hookNotes.push(said);
    } catch {
      // The save is done; a hook must not undo that.
    }
  }

  const base = {
    op_id: opId,
    applied: true as const,
    project_path: target,
    previous_project_path: oldPath,
    project_size: size,
    backup_path: backupPath,
    backup_size: backupSize,
    result: saveResp.result,
    ...(hookNotes.length > 0 ? { policy_disabled: hookNotes.join(" ") } : {}),
    note:
      `The open project now points at ${target}. ` +
      (oldPath === "<unsaved>"
        ? "It had no file before."
        : `The old file ${oldPath} is untouched; its checkpoints and _mcp_backups stay with it.`),
    ...sessionFields,
  };
  if (afterRead.failure) {
    return {
      ...base,
      receipt: buildReceipt({ before: { project_path: oldPath }, after: null, customMismatches: [afterRead.failure] }),
    };
  }
  const status = afterRead.value!.result ?? {};
  const openPath = typeof status.project_path === "string" ? status.project_path : "<unsaved>";
  return {
    ...base,
    receipt: buildReceipt({
      before: { project_path: oldPath },
      after: { project_path: openPath, size, dirty: status.dirty ?? false, file_written: fresh },
      expected: { project_path: target, dirty: false, file_written: true },
      actualForExpected: {
        project_path: pathsMatchForGuard(target, openPath) ? target : openPath,
        dirty: status.dirty ?? false,
        file_written: fresh,
      },
    }),
  };
}
