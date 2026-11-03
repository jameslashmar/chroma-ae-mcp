import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, MAX_LIST_ENTRIES } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { checkpointDirFor, formatBackupTimestamp, verifyTargetGuard } from "../mutate.js";

export interface FingerprintKeyframe {
  time: number;
  value: unknown;
}

export interface FingerprintPropertyLeaf {
  kind?: "property";
  name: string;
  matchName?: string;
  propertyIndex?: number;
  path?: string;
  value?: unknown;
  numKeys?: number;
  keyframes?: FingerprintKeyframe[];
  expression?: string;
  expressionEnabled?: boolean;
  truncated?: boolean;
}

export interface FingerprintPropertyGroup {
  kind: "group";
  name: string;
  matchName?: string;
  propertyIndex?: number;
  path?: string;
  numProperties?: number;
  properties?: FingerprintPropertyNode[];
  truncated?: boolean;
}

export type FingerprintPropertyNode =
  | FingerprintPropertyLeaf
  | FingerprintPropertyGroup;

export interface FingerprintLayer {
  id: number;
  index: number;
  name: string;
  type?: string;
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  enabled?: boolean;
  locked?: boolean;
  label?: number;
  parent?: number | null;
  parentId?: number | null;
  solo?: boolean;
  threeDLayer?: boolean;
  blendingMode?: string | null;
  trackMatteType?: string | null;
  sourceId?: number | null;
  truncated?: boolean;
  properties?: FingerprintPropertyNode[] | Record<string, FingerprintPropertyLeaf>;
}

export interface CompFingerprint {
  comp_id: number;
  name: string;
  width?: number;
  height?: number;
  pixelAspect?: number;
  fps?: number;
  duration?: number;
  workAreaStart?: number;
  workAreaDuration?: number;
  bgColor?: unknown;
  numLayers?: number;
  markers?: unknown[];
  propertyCount?: number;
  truncated?: boolean;
  layers: FingerprintLayer[];
}

export interface FingerprintChangeEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export interface FingerprintDiffItem {
  path: string;
  kind: "layer" | "property";
  id?: number;
  name?: string;
  index?: number;
  type?: string;
  matchName?: string;
  value?: unknown;
}

export interface FingerprintDiffResult {
  changed: FingerprintChangeEntry[];
  added: FingerprintDiffItem[];
  removed: FingerprintDiffItem[];
}

const DIFF_EPSILON = 1e-5;

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= DIFF_EPSILON;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in bObj)) return false;
      if (!valuesEqual(aObj[k], bObj[k])) return false;
    }
    return true;
  }
  return false;
}

function collectLeafProperties(
  nodes: FingerprintPropertyNode[] | Record<string, FingerprintPropertyLeaf> | undefined,
  prefix: string,
  out: Map<string, FingerprintPropertyLeaf>
): void {
  if (!nodes) return;

  if (!Array.isArray(nodes)) {
    for (const [key, leaf] of Object.entries(nodes)) {
      const p = leaf.path ?? `${prefix}/${key}`;
      out.set(p, leaf);
    }
    return;
  }

  for (const node of nodes) {
    const seg = node.matchName || node.name || String(node.propertyIndex ?? "");
    const nodePath = node.path ?? `${prefix}/${seg}`;
    if (
      node.kind === "group" ||
      ("properties" in node && Array.isArray(node.properties))
    ) {
      const grp = node as FingerprintPropertyGroup;
      collectLeafProperties(grp.properties, nodePath, out);
    } else {
      out.set(nodePath, node as FingerprintPropertyLeaf);
    }
  }
}

const COMP_SCALAR_FIELDS: Array<keyof CompFingerprint> = [
  "name",
  "width",
  "height",
  "pixelAspect",
  "fps",
  "duration",
  "workAreaStart",
  "workAreaDuration",
  "bgColor",
  "markers",
];

const LAYER_SCALAR_FIELDS: Array<keyof FingerprintLayer> = [
  "name",
  "index",
  "type",
  "inPoint",
  "outPoint",
  "startTime",
  "enabled",
  "locked",
  "label",
  "parent",
  "parentId",
  "solo",
  "threeDLayer",
  "blendingMode",
  "trackMatteType",
  "sourceId",
];

/**
 * Pure diff between two composition fingerprints.
 * Returns `{ changed: [{ path, before, after }], added, removed }`.
 */
export function diffFingerprints(
  before: CompFingerprint,
  after: CompFingerprint
): FingerprintDiffResult {
  const changed: FingerprintChangeEntry[] = [];
  const added: FingerprintDiffItem[] = [];
  const removed: FingerprintDiffItem[] = [];

  for (const field of COMP_SCALAR_FIELDS) {
    const bVal = before[field];
    const aVal = after[field];
    if (bVal === undefined && aVal === undefined) continue;
    if (!valuesEqual(bVal, aVal)) {
      changed.push({
        path: `comp.${String(field)}`,
        before: bVal,
        after: aVal,
      });
    }
  }

  const beforeLayers = Array.isArray(before.layers) ? before.layers : [];
  const afterLayers = Array.isArray(after.layers) ? after.layers : [];

  const beforeById = new Map<number, FingerprintLayer>();
  for (const l of beforeLayers) {
    beforeById.set(l.id, l);
  }

  const afterById = new Map<number, FingerprintLayer>();
  for (const l of afterLayers) {
    afterById.set(l.id, l);
  }

  for (const bLayer of beforeLayers) {
    if (!afterById.has(bLayer.id)) {
      removed.push({
        path: `layer[${bLayer.id}]`,
        kind: "layer",
        id: bLayer.id,
        name: bLayer.name,
        index: bLayer.index,
        type: bLayer.type,
      });
    }
  }

  for (const aLayer of afterLayers) {
    const bLayer = beforeById.get(aLayer.id);
    const layerPrefix = `layer[${aLayer.id}]`;
    if (!bLayer) {
      added.push({
        path: layerPrefix,
        kind: "layer",
        id: aLayer.id,
        name: aLayer.name,
        index: aLayer.index,
        type: aLayer.type,
      });
      continue;
    }

    for (const field of LAYER_SCALAR_FIELDS) {
      const bVal = bLayer[field];
      const aVal = aLayer[field];
      if (bVal === undefined && aVal === undefined) continue;
      if (!valuesEqual(bVal, aVal)) {
        changed.push({
          path: `${layerPrefix}.${String(field)}`,
          before: bVal,
          after: aVal,
        });
      }
    }

    const bProps = new Map<string, FingerprintPropertyLeaf>();
    const aProps = new Map<string, FingerprintPropertyLeaf>();
    collectLeafProperties(bLayer.properties, layerPrefix, bProps);
    collectLeafProperties(aLayer.properties, layerPrefix, aProps);

    for (const [propPath, bProp] of bProps.entries()) {
      if (!aProps.has(propPath)) {
        removed.push({
          path: propPath,
          kind: "property",
          name: bProp.name,
          matchName: bProp.matchName,
          value: bProp.value,
        });
      }
    }

    for (const [propPath, aProp] of aProps.entries()) {
      const bProp = bProps.get(propPath);
      if (!bProp) {
        added.push({
          path: propPath,
          kind: "property",
          name: aProp.name,
          matchName: aProp.matchName,
          value: aProp.value,
        });
        continue;
      }

      if (!valuesEqual(bProp.value, aProp.value)) {
        changed.push({
          path: `${propPath}.value`,
          before: bProp.value,
          after: aProp.value,
        });
      }

      const bNumKeys = bProp.numKeys ?? 0;
      const aNumKeys = aProp.numKeys ?? 0;
      if (bNumKeys !== aNumKeys) {
        changed.push({
          path: `${propPath}.numKeys`,
          before: bNumKeys,
          after: aNumKeys,
        });
      }

      const bKeys = bProp.keyframes ?? [];
      const aKeys = aProp.keyframes ?? [];
      if (!valuesEqual(bKeys, aKeys)) {
        changed.push({
          path: `${propPath}.keyframes`,
          before: bKeys,
          after: aKeys,
        });
      }

      const bExpr = bProp.expression ?? "";
      const aExpr = aProp.expression ?? "";
      if (bExpr !== aExpr) {
        changed.push({
          path: `${propPath}.expression`,
          before: bExpr,
          after: aExpr,
        });
      }

      const bExprEnabled = Boolean(bProp.expressionEnabled);
      const aExprEnabled = Boolean(aProp.expressionEnabled);
      if (bExprEnabled !== aExprEnabled) {
        changed.push({
          path: `${propPath}.expressionEnabled`,
          before: bExprEnabled,
          after: aExprEnabled,
        });
      }
    }
  }

  return { changed, added, removed };
}

// ---------- In-memory fingerprint store (bounded to 20 entries) ----------

export const MAX_STORED_FINGERPRINTS = 20;

export interface StoredFingerprintEntry {
  id: string;
  comp_id: number;
  created_at: string;
  fingerprint: CompFingerprint;
}

const fingerprintStore = new Map<string, StoredFingerprintEntry>();
let nextFingerprintSeq = 1;

export function storeFingerprint(fp: CompFingerprint): StoredFingerprintEntry {
  const id = `fp_${nextFingerprintSeq++}`;
  const entry: StoredFingerprintEntry = {
    id,
    comp_id: fp.comp_id,
    created_at: new Date().toISOString(),
    fingerprint: fp,
  };
  fingerprintStore.set(id, entry);

  while (fingerprintStore.size > MAX_STORED_FINGERPRINTS) {
    const oldestKey = fingerprintStore.keys().next().value;
    if (oldestKey === undefined) break;
    fingerprintStore.delete(oldestKey);
  }

  return entry;
}

export function getStoredFingerprint(
  id: string
): StoredFingerprintEntry | undefined {
  return fingerprintStore.get(id);
}

export function clearStoredFingerprints(): void {
  fingerprintStore.clear();
  nextFingerprintSeq = 1;
}

export function getStoredFingerprintCount(): number {
  return fingerprintStore.size;
}

export function sanitizeCheckpointLabel(label?: string): string {
  const raw = (label ?? "checkpoint").trim();
  if (!raw) return "checkpoint";
  let cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "checkpoint";
  // A manual label starting with "auto-" would produce a filename
  // (`<name>_<stamp>_auto-<label>.aep`) indistinguishable from an automatic
  // checkpoint's own naming, so ae_checkpoint_list's filename-based `auto`
  // detection (see AUTO_CHECKPOINT_TOOLS below) would misclassify it.
  if (/^auto-/i.test(cleaned)) cleaned = `manual-${cleaned}`;
  return cleaned;
}

// ---------- Zod Schemas ----------

export const AeCompFingerprintSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID to fingerprint."),
});

export const AeCompDiffSchema = z.object({
  before_id: z
    .string()
    .min(1)
    .describe("The fingerprint ID previously returned by `ae_comp_fingerprint`."),
  comp_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Target CompItem ID to fingerprint and compare against `before_id` (defaults to the comp_id stored on `before_id`)."
    ),
});

export const AeCheckpointCreateSchema = z.object({
  expect: ExpectSchema,
  label: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Optional label included in the checkpoint filename `<name>_<yyyyMMdd-HHmmss>_<label>.aep`."
    ),
});

export const AeCheckpointListSchema = z.object({
  expect: ExpectSchema,
});

export const AeAutoCheckpointSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe("Turn automatic checkpoints on or off. Omit to leave unchanged."),
  max_mb: z
    .number()
    .positive()
    .max(100000)
    .optional()
    .describe("Skip projects whose .aep is larger than this many megabytes (default 250). Omit to leave unchanged."),
});

/** Write tools that copy the saved project before they run (see autoCheckpoint in mutate.ts). */
export const AUTO_CHECKPOINT_TOOLS = [
  "ae_run_jsx",
  "ae_set_property",
  "ae_set_keyframe_ease",
  "ae_set_text",
  "ae_import_footage",
  "ae_replace_footage",
  "ae_render_queue_add",
  "ae_add_effect",
  "ae_set_effect",
  "ae_remove_effect",
  "ae_apply_preset",
  "ae_track_point",
  "ae_key_greenscreen",
  "ae_skill_run",
  "ae_build_from_data",
  "ae_reframe",
  "ae_import_assets",
  "ae_create_layer",
  "ae_precompose",
  "ae_set_track_matte",
  "ae_add_markers",
  "ae_remove_markers",
  "ae_cue_keys",
  "ae_remove_keyframes",
  "ae_shape",
  "ae_set_essential_graphics",
  "ae_render_templates",
  "ae_version_footage",
  "ae_batch_set",
  "ae_mask",
  "ae_text_animator",
  "ae_align",
  "ae_purge_unused",
  "ae_verify_render",
];

export const AeCheckpointRevertSchema = z.object({
  expect: ExpectSchema,
  checkpoint_path: z
    .string()
    .min(1)
    .describe("Absolute path to the `.aep` checkpoint file to open."),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      "Must be true to close and revert when the currently open project has unsaved changes (`dirty: true`)."
    ),
});

// ---------- Tools ----------

export const receiptsTools: ToolDefinition<any>[] = [
  {
    name: "ae_comp_fingerprint",
    description:
      "Read a deep, bounded fingerprint of a composition (every layer's settings and every property's value, numKeys, keyframe times/values, and expression, up to depth 6 and 5000 properties). " +
      "Stores the fingerprint in server memory (retaining the 20 most recent) and returns its `id` and summary for use with `ae_comp_diff`. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCompFingerprintSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost<CompFingerprint>(
        "compFingerprint",
        { comp_id: args.comp_id },
        {
          label: `ae_comp_fingerprint(${args.comp_id})`,
          mutates: false,
          toolName: "ae_comp_fingerprint",
        }
      );

      const fp = res.result;
      const entry = storeFingerprint(fp);
      const layers = Array.isArray(fp.layers) ? fp.layers : [];

      return {
        id: entry.id,
        comp_id: fp.comp_id,
        name: fp.name,
        created_at: entry.created_at,
        stored_count: fingerprintStore.size,
        summary: {
          comp_id: fp.comp_id,
          name: fp.name,
          width: fp.width,
          height: fp.height,
          fps: fp.fps,
          duration: fp.duration,
          numLayers: fp.numLayers ?? layers.length,
          layerCount: layers.length,
          propertyCount: fp.propertyCount ?? 0,
          truncated: Boolean(fp.truncated),
        },
      };
    },
  },
  {
    name: "ae_comp_diff",
    description:
      "Take a fresh composition fingerprint in a separate evalScript and return the exact property/layer diff (`{changed, added, removed}`) against a stored `before_id` fingerprint. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCompDiffSchema,
    handler: async (args, ctx) => {
      const beforeEntry = getStoredFingerprint(args.before_id);
      if (!beforeEntry) {
        throw new BridgeError({
          kind: "evalscript_error",
          message: `Unknown or evicted fingerprint before_id "${args.before_id}". Take a new fingerprint with ae_comp_fingerprint first.`,
        });
      }

      const compId = args.comp_id ?? beforeEntry.comp_id;
      const res = await ctx.bridge.callHost<CompFingerprint>(
        "compFingerprint",
        { comp_id: compId },
        {
          label: `ae_comp_diff(${compId})`,
          mutates: false,
          toolName: "ae_comp_diff",
        }
      );

      const afterFp = res.result;
      const afterEntry = storeFingerprint(afterFp);
      const diff = diffFingerprints(beforeEntry.fingerprint, afterFp);

      return {
        before_id: beforeEntry.id,
        after_id: afterEntry.id,
        comp_id: compId,
        truncated: Boolean(beforeEntry.fingerprint.truncated || afterFp.truncated),
        changed: diff.changed,
        added: diff.added,
        removed: diff.removed,
        diff,
      };
    },
  },
  {
    name: "ae_checkpoint_create",
    description:
      "Create an `.aep` checkpoint of the currently saved project by copying the file on disk with Node fs to `<projectdir>/_mcp_checkpoints/<name>_<yyyyMMdd-HHmmss>_<label>.aep`. " +
      "Never uses After Effects Save As so the active project path is never retargeted. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointCreateSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();

      try {
        return await ctx.queue.run("ae_checkpoint_create", async () => {
          ctx.quarantine.assertClear();

          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath =
            guardInfo.project_path ?? args.expect.project_path;

          if (actualProjectPath === "<unsaved>") {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message:
                "Cannot create a checkpoint for an unsaved project (<unsaved>). Save the project in After Effects first.",
              expected: args.expect,
              actual: { project_path: "<unsaved>" },
            });
          }

          if (!fs.existsSync(actualProjectPath)) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: `Cannot create a checkpoint because the project file does not exist on disk: "${actualProjectPath}". Save the project first.`,
              expected: args.expect,
              actual: { project_path: actualProjectPath },
            });
          }

          const ext = path.extname(actualProjectPath) || ".aep";
          const baseName = path.basename(actualProjectPath, ext);
          const checkpointDir = checkpointDirFor(actualProjectPath);
          fs.mkdirSync(checkpointDir, { recursive: true });

          const stamp = formatBackupTimestamp(new Date());
          const safeLabel = sanitizeCheckpointLabel(args.label);
          const checkpointFileName = `${baseName}_${stamp}_${safeLabel}${ext}`;
          const checkpointPath = path.join(checkpointDir, checkpointFileName);

          fs.copyFileSync(actualProjectPath, checkpointPath);
          const stat = fs.statSync(checkpointPath);

          const receipt = buildReceipt({
            before: {
              project_path: actualProjectPath,
              checkpoint_exists: false,
            },
            after: {
              project_path: actualProjectPath,
              checkpoint_path: checkpointPath,
              checkpoint_exists: true,
              size: stat.size,
            },
            expected: {
              checkpoint_exists: true,
            },
            actualForExpected: {
              checkpoint_exists: fs.existsSync(checkpointPath),
            },
          });

          return {
            op_id: opId,
            applied: true as const,
            project_path: actualProjectPath,
            checkpoint_path: checkpointPath,
            label: safeLabel,
            size: stat.size,
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
    name: "ae_checkpoint_list",
    description:
      "List `.aep` checkpoint files in `<projectdir>/_mcp_checkpoints`, guarded by `expect`. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointListSchema,
    handler: async (args, ctx) => {
      const opId = ctx.bridge.newOpId();
      const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
      const actualProjectPath =
        guardInfo.project_path ?? args.expect.project_path;

      if (actualProjectPath === "<unsaved>") {
        throw new BridgeError({
          kind: "guard",
          op_id: opId,
          message:
            "Cannot list checkpoints for an unsaved project (<unsaved>).",
          expected: args.expect,
          actual: { project_path: "<unsaved>" },
        });
      }

      const checkpointDir = checkpointDirFor(actualProjectPath);

      if (!fs.existsSync(checkpointDir)) {
        return {
          project_path: actualProjectPath,
          checkpoint_dir: checkpointDir,
          checkpoints: [],
          truncated: false,
        };
      }

      const entries = fs
        .readdirSync(checkpointDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".aep"));

      const items = entries
        .map((e) => {
          const fullPath = path.join(checkpointDir, e.name);
          const stat = fs.statSync(fullPath);
          return {
            name: e.name,
            path: fullPath,
            auto: /_auto-[A-Za-z0-9_]+(-\d+)?\.aepx?$/i.test(e.name),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            created_at: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

      const truncated = items.length > MAX_LIST_ENTRIES;
      const bounded = items
        .slice(0, MAX_LIST_ENTRIES)
        .map(({ mtimeMs: _m, ...rest }) => rest);

      return {
        project_path: actualProjectPath,
        checkpoint_dir: checkpointDir,
        checkpoints: bounded,
        truncated,
      };
    },
  },
  {
    name: "ae_auto_checkpoint",
    description:
      `Read or change automatic checkpoints. Before every write (${AUTO_CHECKPOINT_TOOLS.join(", ")}; ae_run_jsx only with mutates: true), the server copies the saved .aep to \`<projectdir>/_mcp_checkpoints/<name>_<stamp>_auto-<tool>.aep\` and reports it as \`checkpoint\` in the write's result. ` +
      "ae_checkpoint_list shows them (`auto: true`) and ae_checkpoint_revert opens one. " +
      "AE can't write its unsaved state to another file without retargeting the project, so the copy is the LAST SAVE: when AE has unsaved changes, `checkpoint.unsaved_changes_not_included` is true. Writes between two saves share one copy. Unsaved projects and projects over `max_mb` are skipped, and a failed copy never blocks the write. " +
      "Call with no arguments to read the settings. Change them only when the user asks (for example, to turn checkpoints off for a very large project); they persist across restarts. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAutoCheckpointSchema,
    handler: async (args: z.infer<typeof AeAutoCheckpointSchema>, ctx) => {
      if (!ctx.settings) {
        throw new BridgeError({
          kind: "evalscript_error",
          message: "This server has no settings store, so auto checkpoints use the defaults and can't be changed.",
        });
      }
      const changed = args.enabled !== undefined || args.max_mb !== undefined;
      const settings = changed
        ? ctx.settings.updateAutoCheckpoint({ enabled: args.enabled, max_mb: args.max_mb })
        : ctx.settings.get();
      return {
        changed,
        auto_checkpoint: settings.auto_checkpoint,
        applies_to: AUTO_CHECKPOINT_TOOLS,
        settings_path: ctx.settings.path,
      };
    },
  },
  {
    name: "ae_checkpoint_revert",
    description:
      "Revert to a checkpoint `.aep` file using `openProject` (closes current project with `CloseOptions.DO_NOT_SAVE_CHANGES` only when allowed and calls `app.open`). " +
      "Refuses if the open project is dirty unless `discard_changes: true` is explicitly passed. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointRevertSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();

      try {
        return await ctx.queue.run("ae_checkpoint_revert", async () => {
          ctx.quarantine.assertClear();

          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath =
            guardInfo.project_path ?? args.expect.project_path;

          if (!fs.existsSync(args.checkpoint_path)) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: `Checkpoint file does not exist on disk: "${args.checkpoint_path}".`,
              expected: { checkpoint_path: args.checkpoint_path },
              actual: { exists: false },
            });
          }

          const beforeStatus = await ctx.bridge.evalRaw<{
            project_path?: string;
            dirty?: boolean;
          }>({
            id: `${opId}_before`,
            script: buildJsxCall("status", {}),
            label: "ae_checkpoint_revert (before status)",
            mutates: false,
            toolName: "ae_checkpoint_revert",
          });

          const isDirty = Boolean(beforeStatus.result?.dirty);
          const discardChanges = Boolean(args.discard_changes);

          if (isDirty && !discardChanges) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message:
                "Refusing to revert checkpoint: the open project has unsaved changes (dirty: true) and discard_changes is not true.",
              expected: { dirty: false, discard_changes: true },
              actual: {
                project_path: actualProjectPath,
                dirty: true,
              },
            });
          }

          const openResp = await ctx.bridge.evalRaw<{
            project_path?: string;
            dirty?: boolean;
          }>({
            id: opId,
            script: buildJsxCall("openProject", {
              path: args.checkpoint_path,
              discard_changes: discardChanges,
              expect: args.expect,
            }),
            label: "ae_checkpoint_revert",
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_checkpoint_revert",
          });

          // Separate evalScript for read-back verification
          const afterStatus = await ctx.bridge.evalRaw<{
            project_path?: string;
            dirty?: boolean;
          }>({
            id: `${opId}_after`,
            script: buildJsxCall("status", {}),
            label: "ae_checkpoint_revert (after status)",
            mutates: false,
            toolName: "ae_checkpoint_revert",
          });

          const reopenedPath =
            afterStatus.result?.project_path ??
            openResp.result?.project_path ??
            args.checkpoint_path;

          const receipt = buildReceipt({
            before: beforeStatus.result ?? {
              project_path: actualProjectPath,
              dirty: isDirty,
            },
            after: afterStatus.result ?? {
              project_path: reopenedPath,
              dirty: false,
            },
            expected: {
              project_path: args.checkpoint_path,
            },
            actualForExpected: {
              project_path: reopenedPath,
            },
          });

          return {
            op_id: opId,
            applied: true as const,
            previous_project_path: actualProjectPath,
            project_path: reopenedPath,
            checkpoint_path: args.checkpoint_path,
            discarded_changes: isDirty && discardChanges,
            result: openResp.result,
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

export const fingerprintTools = receiptsTools;
export default receiptsTools;
