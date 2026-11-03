/**
 * server/src/tools/ext/memory.ts
 *
 * Memory tools:
 * - ae_memory_status: app.memoryInUse, the panel's Node memory and the
 *   system's free RAM, best-effort preference values, and a pre-flight warning
 *   before a heavy batch or render. Read-only.
 * - ae_memory_purge: app.purge, a guarded write with a memory reading before
 *   and after in separate evalScripts. RAM-only targets by default; undo and
 *   "all caches" (which wipes the disk cache since AE 24.3) each need a saved
 *   project and an explicit confirm flag the agent gets from the user.
 *
 * Nothing here is verified against a live AE: how app.memoryInUse relates to
 * Task Manager, what the cache preference keys are, and whether a purge shows
 * a popup are measured on a real run, so the tools report numbers and never
 * judge a purge by whether memory dropped.
 */

import * as os from "node:os";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

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
          "ram and all may also clear the undo history (unmeasured); the result then says undo_history_may_be_cleared."
      ),
    only_above_mb: z
      .number()
      .min(0)
      .optional()
      .describe("Purge only when app.memoryInUse is above this many megabytes; otherwise do nothing (purged: false). For a watchdog between the chunks of a long job."),
    confirm_undo_purge: z
      .boolean()
      .optional()
      .describe("Required true for target undo. Set it only after the user said yes (ask with ae_ask_user); the project must be saved first (ae_save)."),
    confirm_disk_cache_wipe: z
      .boolean()
      .optional()
      .describe("Required true for target all. Set it only after the user said yes; the disk cache can take hours to rebuild. Use ram to keep it."),
    expect: ExpectSchema,
  })
  .refine((v) => v.target !== "undo" || v.confirm_undo_purge === true, {
    message: "Purging undo needs confirm_undo_purge: true, after the user said yes (it removes the whole undo history).",
  })
  .refine((v) => v.target !== "all" || v.confirm_disk_cache_wipe === true, {
    message: "Purging all caches needs confirm_disk_cache_wipe: true, after the user said yes (it also wipes the disk cache).",
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
  return { ready: warnings.length === 0, warnings };
}

/**
 * Whether a watchdog between job chunks should purge now. A missing reading
 * never purges: the purge throws away the user's RAM preview.
 */
export function shouldPurgeBetweenChunks(memoryInUseBytes: number | null, thresholdMb: number): boolean {
  return memoryInUseBytes !== null && memoryInUseBytes > thresholdMb * MB;
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
      const preflight = preflightWarnings({
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
      "ram and all MAY also clear the Edit > Undo history (not yet measured): the result reports undo_history_cleared: null and undo_history_may_be_cleared: true, so tell the user Ctrl+Z may be gone, and save first when undo matters. " +
      "target undo removes the whole Edit > Undo history: it needs a saved project (ae_save), confirm_undo_purge: true, and the user's yes through ae_ask_user first; afterwards Ctrl+Z cannot undo earlier steps, so tell the user. This tool takes no checkpoint (the saved .aep is the current state; only checkpoints taken earlier, see ae_checkpoint list, hold earlier states). " +
      "target all also wipes the disk cache (hours to rebuild): confirm_disk_cache_wipe: true after the user's yes. " +
      "only_above_mb makes it a watchdog: nothing is purged unless memory is above that. The receipt reports memory before and after; memory not dropping is not an error. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMemoryPurgeSchema,
    handler: (args: z.infer<typeof AeMemoryPurgeSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_memory_purge",
        label: `ae_memory_purge(${args.target})`,
        expect: args.expect,
        read: () => ({ host: "memoryRead", args: {} }),
        write: {
          host: "memoryPurge",
          args: {
            target: args.target,
            only_above_mb: args.only_above_mb,
            confirm_undo_purge: args.confirm_undo_purge,
            confirm_disk_cache_wipe: args.confirm_disk_cache_wipe,
          },
        },
        check: (before, after, w) => purgeMismatches(args, before, after, w),
        present: (beforeRaw, afterRaw, w) => {
          const before = readOf(beforeRaw);
          const after = readOf(afterRaw);
          const b = before?.memory_in_use_bytes ?? null;
          const a = after?.memory_in_use_bytes ?? null;
          const warnings: string[] = [];
          if (w.undo_history_cleared === true) {
            warnings.push(
              "The undo history is gone: Ctrl+Z cannot undo anything done before this purge. The saved .aep is the current state; only checkpoints taken earlier (ae_checkpoint list) hold earlier states."
            );
          } else if (w.purged === true && w.undo_history_may_be_cleared === true) {
            warnings.push("This purge target may also have cleared the Edit > Undo history (not yet measured). Do not assume Ctrl+Z still works for earlier steps.");
          }
          if (w.disk_cache_cleared === true) warnings.push("The disk cache was wiped; previews will re-render.");
          if (w.purged === true && (w.target === "image" || w.target === "ram" || w.target === "all")) warnings.push("The RAM preview was dropped with the caches.");
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
        },
      }),
  },
];
