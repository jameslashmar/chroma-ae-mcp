/**
 * server/src/tools/ext/memory.ts
 *
 * Memory tools:
 * - ae_memory_status: app.memoryInUse, the panel's Node memory and the
 *   system's free RAM, best-effort preference values, and a pre-flight warning
 *   before a heavy batch or render. Read-only.
 * - ae_memory_purge: app.purge, a guarded write with a memory reading before
 *   and after in separate evalScripts. image and snapshot need nothing; ram, undo
 *   and all need a saved, clean project and confirm_undo_purge; all (which wipes
 *   the disk cache since AE 24.3) also needs confirm_disk_cache_wipe. The flags
 *   come from the user.
 *
 * Nothing here is verified against a live AE: how app.memoryInUse relates to
 * Task Manager, what the cache preference keys are, and whether a purge shows
 * a popup are measured on a real run, so the tools report numbers and never
 * judge a purge by whether memory dropped.
 */

import * as os from "node:os";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { readResources, resourceWarnings, type ResourceReport } from "../../system-resources.js";
import { buildReceipt } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ExpectGuard, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { readBackMismatch } from "../read-back.js";
import { beginInflight, endInflight, getSessionTracker, noteBeforeWrite, SNAPSHOT_TIMEOUT_MS, type SessionSnapshot } from "./session.js";
import { expectThat } from "./write-runner.js";

const MB = 1048576;

// ---------- read shape ----------

export interface PrefEntry {
  section: string;
  key: string;
  type: string;
  pref_file?: string | null;
  exists: boolean;
  value: number | string | boolean | null;
  error?: string;
}

export interface MemoryRead {
  ae_version: string | null;
  /** Bytes, from app.memoryInUse; null when AE gave none. */
  memory_in_use_bytes: number | null;
  project_path: string;
  dirty: boolean | null;
  purge_targets_available: Record<string, boolean>;
  prefs: PrefEntry[];
}

const readOf = (v: unknown): MemoryRead | null => (v && typeof v === "object" ? (v as MemoryRead) : null);

// ---------- schemas ----------

const PURGE_TARGETS = ["image", "snapshot", "ram", "undo", "all"] as const;

const PREF_FILES = [
  "machine_specific",
  "machine_independent",
  "machine_independent_render",
  "machine_independent_output",
  "machine_independent_composition",
  "machine_specific_text",
  "machine_specific_paint",
] as const;

const PrefRequestSchema = z.object({
  section: z.string().min(1).max(200).describe("Preference section, as in AE's Prefs file."),
  key: z.string().min(1).max(200),
  type: z.enum(["long", "string", "bool", "float"]).optional().describe("How to read it. Default long."),
  pref_file: z
    .enum(PREF_FILES)
    .optional()
    .describe("Which preference file (PREFType) the key lives in. Default machine_specific; the Memory & Cache keys' file is unmeasured, so try another when exists is false."),
});

export const AeMemoryStatusSchema = z.object({
  prefs: z
    .array(PrefRequestSchema)
    .max(20)
    .optional()
    .describe(
      "Preference keys to read (app.preferences, read-only). AE documents no key names for Memory & Cache or the disk cache, so the caller names them; " +
        "a key AE does not have comes back with exists: false."
    ),
  warn_above_mb: z
    .number()
    .positive()
    .optional()
    .describe("Pre-flight: warn when app.memoryInUse is above this many megabytes."),
  min_free_mb: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe("Pre-flight: warn when the system's free RAM is below this many megabytes. Default 1024."),
});

export const AeMemoryPurgeSchema = z
  .object({
    target: z
      .enum(PURGE_TARGETS)
      .describe(
        "image: the image cache. snapshot: the snapshot cache. ram: every RAM cache (PurgeTarget.ALL_MEMORY_CACHES, AE 24.3+), disk cache kept. " +
          "undo: the Edit > Undo history, which cannot be brought back. all: PurgeTarget.ALL_CACHES, RAM and the disk cache. " +
          "ram and all may also clear the undo history (unmeasured); the result then says undo_history_may_be_cleared, and ram is gated like undo."
      ),
    only_above_mb: z
      .number()
      .min(0)
      .optional()
      .describe("Purge only when app.memoryInUse is above this many megabytes; otherwise do nothing (purged: false). For a watchdog between the chunks of a long job."),
    confirm_undo_purge: z
      .boolean()
      .optional()
      .describe("Required true for target undo, ram and all (ram and all may also clear the undo history). Set it only after the user said yes (ask with ae_ask_user); the project must be saved first (ae_save)."),
    confirm_disk_cache_wipe: z
      .boolean()
      .optional()
      .describe("Required true for target all, together with confirm_undo_purge. Set it only after the user said yes; the disk cache can take hours to rebuild and the Edit > Undo history may be cleared too. Use ram to keep the disk cache."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.target !== "undo" && v.target !== "ram" && v.target !== "all") || v.confirm_undo_purge === true, {
    message: "Purging undo, ram or all needs confirm_undo_purge: true, after the user said yes (undo removes the whole undo history; ram and all may). Use image or snapshot to keep it.",
  })
  .refine((v) => v.target !== "all" || v.confirm_disk_cache_wipe === true, {
    message: "Purging all caches needs confirm_disk_cache_wipe: true, after the user said yes (it also wipes the disk cache, and may clear the Edit > Undo history).",
  });

// ---------- pure logic ----------

export interface ServerMemory {
  /** The panel's own Node process, not After Effects. */
  panel_rss_bytes: number;
  panel_heap_used_bytes: number;
  system_free_bytes: number;
  system_total_bytes: number;
}

export function readServerMemory(): ServerMemory {
  const u = process.memoryUsage();
  return {
    panel_rss_bytes: u.rss,
    panel_heap_used_bytes: u.heapUsed,
    system_free_bytes: os.freemem(),
    system_total_bytes: os.totalmem(),
  };
}

export interface PreflightInput {
  aeBytes: number | null;
  freeBytes: number;
  warnAboveMb?: number;
  minFreeMb?: number;
  /** The GPU and other-app reading (system-resources.ts); absent: no GPU check. */
  resources?: ResourceReport;
}

export const DEFAULT_MIN_FREE_MB = 1024;

/** Warnings before a heavy job; `ready` is false when any of them applies. */
export function preflightWarnings(input: PreflightInput): { ready: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const minFree = input.minFreeMb ?? DEFAULT_MIN_FREE_MB;
  const freeMb = input.freeBytes / MB;
  if (freeMb < minFree) {
    warnings.push(`The system has ${Math.round(freeMb)} MB of free RAM, below ${minFree} MB. Close other apps or purge before a heavy batch or render.`);
  }
  if (input.warnAboveMb !== undefined) {
    if (input.aeBytes === null) {
      warnings.push("After Effects gave no app.memoryInUse reading, so warn_above_mb could not be checked.");
    } else if (input.aeBytes / MB > input.warnAboveMb) {
      warnings.push(
        `After Effects uses ${Math.round(input.aeBytes / MB)} MB, above ${input.warnAboveMb} MB. ae_memory_purge with target image or ram frees RAM caches (it also drops the RAM preview).`
      );
    }
  }
  // The GPU (only when the caller passed a report, i.e. asked for a pre-flight): its warnings are added after the RAM ones.
  // Level "high" makes the pre-flight not ready, "warn" only adds the text, and so does After Effects holding most of the VRAM
  // itself (closing another app would not help). A GPU that could not be read is said so: ready is not silently true.
  const memoryProblems = warnings.length;
  const r = input.resources;
  let gpuBlocks = false;
  if (r) {
    warnings.push(...resourceWarnings(r, "status"));
    gpuBlocks = r.level === "high" && !r.ae_holds_most;
    if (!r.supported) warnings.push(`GPU memory could not be read${r.probe_error ? ` (${r.probe_error})` : " on this system"}, so it was not checked.`);
  }
  return { ready: memoryProblems === 0 && !gpuBlocks, warnings };
}

/** What the receipt checks after a purge: the project is the same one, and the host did what it reported. */
export function purgeMismatches(args: z.infer<typeof AeMemoryPurgeSchema>, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = readOf(beforeRaw);
  const after = readOf(afterRaw);
  if (before && after) {
    expectThat(m, after.project_path === before.project_path, "project_path", before.project_path, after.project_path, "A different project is open after the purge");
    // A purge never touches the project, so a project that was clean must still be.
    // (Whether AE marks it dirty anyway is unmeasured; the host does not undo-group the purge.)
    if (before.dirty === false) expectThat(m, after.dirty === false, "dirty", false, after.dirty, "The purge left the project with unsaved changes");
  }
  expectThat(m, written.target === args.target, "target", args.target, written.target, "The host purged another target");
  if (args.only_above_mb === undefined) expectThat(m, written.purged === true, "purged", true, written.purged, "The host did not purge");
  return m;
}

// ---------- tools ----------

export const memoryTools: ToolDefinition<any>[] = [
  {
    name: "ae_memory_status",
    description:
      "Memory report: After Effects' app.memoryInUse, the panel's Node memory (not AE's), the system's free and total RAM, which purge targets this AE supports, " +
      "and any preference keys you name (Memory & Cache keys are undocumented; a missing key reads exists: false). " +
      "Give warn_above_mb and/or min_free_mb for a pre-flight check before a heavy batch or render: `preflight.ready` is false with the reasons in `warnings`. " +
      "With warn_above_mb or min_free_mb the pre-flight also reads GPU memory and the process list (Windows; macOS lists apps only): GPU memory nearly full (`ready` false from 93 %, unless After Effects itself holds it), or another app such as Cinema 4D or Blender running, adds a warning, and a GPU that could not be read is said so; tell the user. " +
      "Read-only: changes nothing in AE. app.memoryInUse's relation to Task Manager is unmeasured, so treat it as a trend.",
    schema: AeMemoryStatusSchema,
    handler: async (args: z.infer<typeof AeMemoryStatusSchema>, ctx) => {
      const res = await ctx.bridge.callHost<MemoryRead>("memoryRead", { prefs: args.prefs }, {
        label: "ae_memory_status",
        mutates: false,
        toolName: "ae_memory_status",
      });
      const ae = res.result;
      const server = readServerMemory();
      // The GPU probe takes about a second: only when the caller asked for a pre-flight check.
      const wantsPreflight = args.warn_above_mb !== undefined || args.min_free_mb !== undefined;
      const resources = wantsPreflight ? await readResources() : undefined;
      const preflight = preflightWarnings({
        resources,
        aeBytes: ae?.memory_in_use_bytes ?? null,
        freeBytes: server.system_free_bytes,
        warnAboveMb: args.warn_above_mb,
        minFreeMb: args.min_free_mb,
      });
      return { ae, server, preflight };
    },
  },
  {
    name: "ae_memory_purge",
    description:
      "Purge After Effects caches with app.purge, in a guarded write with memory read before and after (separate evalScripts). " +
      "target image / snapshot free RAM caches only; ram = every memory cache (AE 24.3+; the disk cache stays). image and ram also drop the user's RAM preview. " +
      "ram and all MAY also clear the Edit > Undo history (not yet measured): the result reports undo_history_cleared: null and undo_history_may_be_cleared: true, so tell the user Ctrl+Z may be gone. " +
      "So ram is gated like undo: a saved project with no unsaved changes (ae_save), confirm_undo_purge: true, and the user's yes through ae_ask_user first. Use image or snapshot to keep undo without asking. " +
      "target undo removes the whole Edit > Undo history: the same gate; afterwards Ctrl+Z cannot undo earlier steps, so tell the user. " +
      "A purge that cleared undo (target undo) is recorded, so ae_session_changes lists earlier steps as not_reachable; one that may have cleared it (ram, all) is recorded too, and those steps stay possibly_reachable with a warning. A purge itself is never listed as an undo step. " +
      "This tool takes no automatic checkpoint (a purge changes no project data; the saved .aep is the current state, and only checkpoints taken earlier, see ae_checkpoint list, hold earlier states). " +
      "target all also wipes the disk cache (hours to rebuild) and may clear undo, so it needs confirm_disk_cache_wipe: true and confirm_undo_purge: true after the user's yes to both, on a saved project. " +
      "only_above_mb makes one call a watchdog: nothing is purged unless memory is above that. There is no automatic watchdog inside ae_batch_set; call this between chunks yourself (target image needs no confirm). " +
      "The receipt reports memory before and after; memory not dropping is not an error. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMemoryPurgeSchema,
    handler: (args: z.infer<typeof AeMemoryPurgeSchema>, ctx) => runPurge(args, ctx),
  },
];

// ---------- the purge write ----------

/** What the purge itself says about undo, the disk cache and the RAM preview. Built from the write's result, so it survives a failed read-back. */
export function purgeWarnings(w: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (w.undo_history_cleared === true) {
    warnings.push(
      "The undo history is gone: Ctrl+Z cannot undo anything done before this purge. The saved .aep is the current state; only checkpoints taken earlier (ae_checkpoint list) hold earlier states. Tell the user."
    );
  } else if (w.purged === true && w.undo_history_may_be_cleared === true) {
    warnings.push("This purge target may also have cleared the Edit > Undo history (not yet measured). Do not assume Ctrl+Z still works for earlier steps; tell the user.");
  }
  if (w.disk_cache_cleared === true) warnings.push("The disk cache was wiped; previews will re-render.");
  if (w.purged === true && (w.target === "image" || w.target === "ram" || w.target === "all")) warnings.push("The RAM preview was dropped with the caches.");
  return warnings;
}

/**
 * Tells the session tracker the undo history is (or may be) gone:
 * ae_session_changes then lists earlier steps as not_reachable (target undo)
 * or warns that they may be gone (ram, all). Never throws.
 */
function noteUndoPurged(w: Record<string, unknown>): void {
  if (w.purged !== true) return;
  if (w.undo_history_cleared !== true && w.undo_history_may_be_cleared !== true) return;
  try {
    getSessionTracker()?.markUndoPurged(new Date().toISOString(), w.undo_history_cleared === true);
  } catch {
    // Bookkeeping only.
  }
}

/**
 * Moves the session baseline past this purge (so the next guarded write does
 * not report the same user change again) without adding an undo step. Skipped
 * when the read-back failed or the tracker says AE is likely stuck. Never throws.
 */
async function moveBaseline(ctx: ToolContext, opId: string, toolName: string, label: string, expect: ExpectGuard, readBackOk: boolean): Promise<void> {
  try {
    const t = getSessionTracker();
    if (!t) return;
    const blocked = t.takeSkipAfter(opId);
    if (!readBackOk || blocked) return;
    const res = await ctx.bridge.evalRaw<SessionSnapshot>({
      id: `${opId}_session`,
      script: buildJsxCall("sessionSnapshot", { comp_ids: t.compsToRead(expect.project_path, [expect.comp_id]) }),
      label: `${label} (session after)`,
      mutates: false,
      toolName,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const snap = res.result;
    if (snap && typeof snap === "object" && typeof snap.project_path === "string") t.record(snap, { op_id: opId, tool: toolName });
  } catch {
    // Bookkeeping only.
  }
}

function presentPurge(beforeRaw: unknown, afterRaw: unknown, w: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const b = readOf(beforeRaw)?.memory_in_use_bytes ?? null;
  const a = readOf(afterRaw)?.memory_in_use_bytes ?? null;
  return {
    target: w.target,
    purge_constant: w.purge_constant,
    purged: w.purged,
    skipped_reason: w.skipped_reason,
    undo_history_cleared: w.undo_history_cleared,
    undo_history_may_be_cleared: w.undo_history_may_be_cleared ?? false,
    disk_cache_cleared: w.disk_cache_cleared,
    memory_in_use_bytes: { before: b, after: a, freed: b !== null && a !== null ? b - a : null },
    warnings,
  };
}

/**
 * A guarded write like runGuardedWrite (guard, before read, one host call,
 * read-back in a separate evalScript, receipt), except that a purge takes no
 * checkpoint (it changes no project data, and the saved .aep is the current
 * state) and adds no undo step (it is not undo-grouped, so Ctrl+Z cannot reach
 * it). It records a purge that cleared undo for ae_session_changes.
 */
async function runPurge(args: z.infer<typeof AeMemoryPurgeSchema>, ctx: ToolContext) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const toolName = "ae_memory_purge";
  const label = `ae_memory_purge(${args.target})`;
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id };
  const readOnce = async (phase: "before" | "after") => {
    const res = await ctx.bridge.evalRaw({
      id: `${opId}_${phase}`,
      script: buildJsxCall("memoryRead", {}),
      label: `${label} (${phase})`,
      mutates: false,
      toolName,
    });
    return res.result ?? null;
  };
  try {
    return await ctx.queue.run(label, async () => {
      ctx.quarantine.assertClear();
      await verifyTargetGuard(ctx, expect, opId);
      const checkpoint = { status: "skipped" as const, reason: "A cache purge changes no project data, so it takes no checkpoint." };
      const note = { opId, toolName, label, expect, checkpoint: null };
      const sessionFields = await noteBeforeWrite(ctx, note);
      const before = await readOnce("before");
      beginInflight(note);
      let write;
      try {
        write = await ctx.bridge.evalRaw<Record<string, unknown>>({
          id: opId,
          script: buildJsxCall("memoryPurge", {
            target: args.target,
            only_above_mb: args.only_above_mb,
            confirm_undo_purge: args.confirm_undo_purge,
            confirm_disk_cache_wipe: args.confirm_disk_cache_wipe,
            expect,
          }),
          label,
          mutates: true,
          toolName,
        });
      } finally {
        endInflight(opId);
      }
      const written = (write.result ?? {}) as Record<string, unknown>;
      // From here the purge is applied: nothing below may throw.
      const warnings = purgeWarnings(written);
      noteUndoPurged(written);
      try {
        const tracker = getSessionTracker();
        tracker?.commitReported(opId);
      } catch {
        // Bookkeeping only.
      }
      let after: unknown = null;
      let failure: ReceiptMismatch | null = null;
      try {
        after = await readOnce("after");
      } catch (err) {
        failure = readBackMismatch(opId, "the read-back failed", err);
      }
      await moveBaseline(ctx, opId, toolName, label, expect, failure === null);
      let custom: ReceiptMismatch[];
      let shown: Record<string, unknown>;
      if (failure) {
        custom = [failure];
        shown = { ...written, warnings };
      } else {
        try {
          custom = purgeMismatches(args, before, after, written);
          shown = presentPurge(before, after, written, warnings);
        } catch (err) {
          custom = [readBackMismatch(opId, "checking the read-back failed", err)];
          shown = { ...written, warnings };
        }
      }
      const receipt = buildReceipt({ before, after, customMismatches: custom });
      return { op_id: opId, applied: true as const, ...shown, checkpoint, receipt, ...sessionFields };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}
