import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../host.js";
import { buildJsxCall, normalizeGuardPath, pathsMatchForGuard } from "../jsx.js";
import { buildReceipt } from "../receipts.js";
import { QueueWaitError } from "../queue.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { recordRunJsx } from "../skills.js";
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
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Property path from the layer root (e.g. ['Transform', 'Opacity'] or ['ADBE Transform Group', 'ADBE Opacity'])."
      ),
    value: z
      .unknown()
      .optional()
      .describe("Static value to set on the property (when not keyframed)."),
    keyframes: z
      .array(KeyframeItemSchema)
      .optional()
      .describe("Keyframes to set on the property."),
    expression: z
      .string()
      .optional()
      .describe("Expression string to assign to the property."),
    expect: ExpectSchema,
  })
  .refine(
    (val) =>
      val.value !== undefined ||
      (val.keyframes !== undefined && val.keyframes.length > 0) ||
      val.expression !== undefined,
    {
      message:
        "ae_set_property requires at least one of `value`, `keyframes`, or `expression`.",
    }
  );

export const AeSaveSchema = z.object({
  expect: ExpectSchema,
  backup: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      "If true (default), the server copies the existing .aep file to <project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep before calling app.project.save()."
    ),
});

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
// writes between two saves makes one copy, not one per write.
const lastAutoCheckpoint = new Map<string, { size: number; mtimeMs: number; path: string }>();

export function resetAutoCheckpointMemory(): void {
  lastAutoCheckpoint.clear();
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

  // guard.dirty is boolean | null -- null means AE couldn't say (reading
  // app.project.dirty threw). Treating null the same as false would tell
  // the caller the checkpoint is known-complete when it's actually unknown;
  // the honest, conservative answer is to warn for both true and null.
  const unsaved = guard.dirty !== false ? { unsaved_changes_not_included: true } : {};
  const key = normalizeGuardPath(projectPath);
  const last = lastAutoCheckpoint.get(key);
  if (last && last.size === stat.size && last.mtimeMs === stat.mtimeMs && fs.existsSync(last.path)) {
    return { status: "reused", path: last.path, ...unsaved };
  }

  const ext = path.extname(projectPath) || ".aep";
  const dir = path.join(path.dirname(projectPath), "_mcp_checkpoints");
  const stem = `${path.basename(projectPath, ext)}_${formatBackupTimestamp(new Date())}_auto-${toolName}`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    let target = path.join(dir, `${stem}${ext}`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem}-${n}${ext}`);
    await fs.promises.copyFile(projectPath, target, fs.constants.COPYFILE_EXCL);
    lastAutoCheckpoint.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, path: target });
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
      "The result's `op_id` can be passed to ae_skill_save to keep a script that worked as a reusable skill. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRunJsxSchema,
    handler: async (args, ctx) => {
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

          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("snapshotForReceipt", {
              comp_id: expect.comp_id,
            }),
            label: `${args.label} (before snapshot)`,
            mutates: false,
            toolName: "ae_run_jsx",
          });

          const writeResp = await ctx.bridge.evalRaw({
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

          // Separate evalScript for read-back (reads in the same script as a write return stale values)
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("snapshotForReceipt", {
              comp_id: expect.comp_id,
            }),
            label: `${args.label} (after snapshot)`,
            mutates: false,
            toolName: "ae_run_jsx",
          });

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
          });
          recordRunJsx({ op_id: opId, label: args.label, code: args.code, mutates: true, at: new Date().toISOString() });

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            checkpoint,
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
  {
    name: "ae_set_property",
    description:
      "Mutate a layer property's value, keyframes, or expression within one undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. " +
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

          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getLayerProps", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              depth: 1,
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_property",
          });

          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("setProperty", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              value: args.value,
              keyframes: args.keyframes,
              expression: args.expression,
              expect: effectiveExpect,
            }),
            label,
            mutates: true,
            toolName: "ae_set_property",
          });

          // Separate evalScript for read-back
          const afterSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("getLayerProps", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              depth: 1,
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_property",
          });

          const expectedCheck: Record<string, unknown> = {};
          const actualCheck: Record<string, unknown> = {};
          const afterObj = (afterSnap.result ?? {}) as Record<string, unknown>;
          const propObj =
            afterObj.property && typeof afterObj.property === "object"
              ? (afterObj.property as Record<string, unknown>)
              : afterObj;

          if (args.value !== undefined) {
            expectedCheck.value = args.value;
            actualCheck.value = propObj.value;
          }
          if (args.expression !== undefined) {
            expectedCheck.expression = args.expression;
            actualCheck.expression = propObj.expression;
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
          });

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            checkpoint,
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
  {
    name: "ae_save",
    description:
      "Save the current After Effects project (`app.project.save()`). " +
      "If `backup` is true (default), the server first copies the existing .aep on disk using Node fs to `<project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep`, " +
      "and returns both paths and sizes. Never uses save-as for backups so the open project is not retargeted. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSaveSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const doBackup = args.backup ?? true;

      try {
        return await ctx.queue.run("ae_save", async () => {
          ctx.quarantine.assertClear();

          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath =
            guardInfo.project_path ?? args.expect.project_path;

          if (actualProjectPath === "<unsaved>") {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message:
                "Cannot run ae_save on an unsaved project (<unsaved>). Save the project once in After Effects first.",
              expected: args.expect,
              actual: { project_path: "<unsaved>" },
            });
          }

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

          // Separate read-back evalScript to verify project is saved (dirty === false)
          const afterStatus = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("status", {}),
            label: "ae_save (after status)",
            mutates: false,
            toolName: "ae_save",
          });

          const savedSize = fs.existsSync(actualProjectPath)
            ? fs.statSync(actualProjectPath).size
            : null;

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
