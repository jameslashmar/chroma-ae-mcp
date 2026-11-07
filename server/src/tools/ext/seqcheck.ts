/**
 * server/src/tools/ext/seqcheck.ts
 *
 * The pre-render check for image sequences with missing frames, shared by
 * ae_render_queue_render, ae_aerender_start and ae_render_batch.
 *
 * - The host lists the project's footage (preflightItems pages, reads only);
 *   Node reads each sequence's folder (server/src/seqscan.ts). The two steps
 *   are split: `prepareSequenceCheck` talks to AE and needs the caller's queue
 *   lease; `finishSequenceCheck` only reads folders and can run after the
 *   lease is released (aerender and the batch do that; ae_render_queue_render
 *   must keep its lease until the render ends, so it runs both inside).
 * - It WARNS by default and does not refuse for what it finds, unless the caller asks for
 *   sequence_check "block": then it refuses on gaps (not on a sequence still
 *   being written) and also when it could not finish. "warn" never refuses for a
 *   finding. One exception, in ae_render_queue_render only: a footage listing that fails in AE throws
 *   (its render eval would queue behind the abandoned one), warn or block alike.
 * - Scope: every sequence that some comp uses. It does not walk the comps
 *   about to render (that needs the layer scan, ae_preflight's delivery
 *   scope), so it can warn about a sequence the render does not touch; the
 *   result says so in `scope`.
 */

import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { checkSequences, FS_PAUSED_NOTE, seqscanDeps, type SeqInput, type SeqReport, type SeqRow } from "../../seqscan.js";
import type { ToolContext } from "../common.js";
import { makeScanCall, type ItemsPage, type ScanCall } from "./preflight.js";

export const SequenceCheckSchema = z
  .enum(["warn", "off", "block"])
  .optional()
  .describe("Image sequences with missing frames: warn (default) lists them in the result and starts anyway, off skips the check, block refuses to start (also when the check could not finish). warn never refuses for what the check finds (ae_render_queue_render still throws if AE fails to list the footage). A sequence still being written is reported as writing and never blocks.");

export type SequenceCheckMode = "warn" | "off" | "block";

const ITEM_PAGES_MAX = 20;
const ITEMS_PER_PAGE = 150;
/** The pre-render budget: listing the footage plus reading the folders. */
export const PRE_RENDER_BUDGET_MS = 4000;
/** Listing the footage may use this share of it. */
const LIST_SHARE = 0.6;
/** The most one listing page of the footage may take: about twice the whole check budget, never under 6 s. */
export const LIST_PAGE_TIMEOUT_MS = (budgetMs: number): number => Math.max(6000, Math.round(budgetMs * 2));
/** Rows kept in a render tool's result. */
const RESULT_ROWS = 20;

export interface SequenceCheckResult {
  /** What was looked at, said plainly. */
  scope: "footage_used_by_any_comp";
  scope_note: string;
  checked: number;
  with_gaps: number;
  writing: number;
  unreadable: number;
  sparse: number;
  short: number;
  unknown_age: number;
  incomplete: boolean;
  /** File checks are paused (earlier fs calls never returned). */
  fs_paused?: boolean;
  /** Gaps first, then short, unknown, unreadable, writing and sparse; complete ones are only counted. */
  sequences: SeqRow[];
  /** More rows than the result lists. */
  truncated: boolean;
  unchecked_count: number;
  notes: string[];
  /** Set when the footage could not be listed. */
  error?: string;
}

const SCOPE_NOTE =
  "Checks every image sequence that some comp uses, not only the comps about to render, so it can warn about a sequence this render does not touch. ae_preflight (delivery) narrows it to the comps being rendered.";

/** The folders a known render writes into, from the files it will write. */
export function dirsOfFiles(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (typeof f === "string" && f.length > 0 && !f.startsWith("<")) out.push(path.dirname(f));
  }
  return out;
}

/** Structural view of an aerender registry, so this file does not import aerender.ts. */
export function liveDirsFromJobs(jobs: Array<{ state: string; output_path?: string; output_paths?: string[] }>): string[] {
  const files: string[] = [];
  try {
    for (const j of jobs) {
      if (j.state !== "running") continue;
      if (j.output_paths && j.output_paths.length > 0) files.push(...j.output_paths);
      else if (j.output_path) files.push(j.output_path);
    }
  } catch {
    // an unreadable registry is no information
  }
  return dirsOfFiles(files);
}

/** The footage a project listing holds that is an image sequence AE can read. Stops at the deadline (a page in flight is finished). */
export async function listSequenceInputs(call: ScanCall, deadline: number = Number.POSITIVE_INFINITY): Promise<{ inputs: SeqInput[]; complete: boolean; reason?: string }> {
  const inputs: SeqInput[] = [];
  let offset = 0;
  for (let page = 0; page < ITEM_PAGES_MAX; page++) {
    const res = await call<ItemsPage>("preflightItems", { offset, limit: ITEMS_PER_PAGE }, `sequences: items from ${offset}`);
    for (const f of res?.footage ?? []) {
      if (f.kind === "footage" && f.sequence === true && !f.missing && f.file && f.used_n > 0) {
        inputs.push({ file: f.file, item_id: f.id, name: f.name, ...(typeof f.ae_frames === "number" ? { ae_frames: f.ae_frames } : {}) });
      }
    }
    if (typeof res?.next_offset !== "number") return { inputs, complete: true };
    offset = res.next_offset;
    if (Date.now() >= deadline) return { inputs, complete: false, reason: "The project listing was cut at the time limit." };
  }
  return { inputs, complete: false, reason: `Only the first ${ITEM_PAGES_MAX * ITEMS_PER_PAGE} project items were listed.` };
}

const ROW_ORDER: Record<string, number> = { gaps: 0, short: 1, unknown: 2, unreadable: 3, writing: 4, sparse: 5 };

function slim(report: SeqReport, extraNotes: string[], error?: string): SequenceCheckResult {
  const rows = report.sequences
    .filter((r) => r.state in ROW_ORDER)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ROW_ORDER[a.r.state] - ROW_ORDER[b.r.state] || a.i - b.i)
    .map((x) => x.r);
  return {
    scope: "footage_used_by_any_comp",
    scope_note: SCOPE_NOTE,
    checked: report.checked,
    with_gaps: report.with_gaps,
    writing: report.writing,
    unreadable: report.unreadable,
    sparse: report.sparse,
    short: report.short,
    unknown_age: report.unknown_age,
    incomplete: report.incomplete || extraNotes.length > 0 || error !== undefined,
    ...(report.fs_paused ? { fs_paused: true } : {}),
    sequences: rows.slice(0, RESULT_ROWS),
    truncated: rows.length > RESULT_ROWS || report.truncated,
    unchecked_count: report.unchecked_count,
    notes: [...extraNotes, ...report.notes],
    ...(error ? { error } : {}),
  };
}

const EMPTY_REPORT: SeqReport = {
  checked: 0, with_gaps: 0, writing: 0, unreadable: 0, sparse: 0, short: 0, unknown_age: 0, incomplete: true,
  sequences: [], sequences_total: 0, unchecked: [], unchecked_count: 0, truncated: false, notes: [], elapsed_ms: 0,
};

export interface SequenceReportOptions {
  opId: string;
  toolName: string;
  budgetMs?: number;
  /** Folders a running render of this server writes into; default: what aerender.ts registered. */
  liveDirs?: string[];
  /**
   * true: any bridge failure while listing the footage becomes an `error` in the result instead of a throw. For a tool that does not
   * need AE after this step (aerender, the batch). ae_render_queue_render keeps the throw: its render eval would queue behind an abandoned one.
   */
  tolerant?: boolean;
}

export interface PreparedSequenceCheck {
  inputs: SeqInput[];
  extraNotes: string[];
  error?: string;
  startedAt: number;
}

/** Step 1, needs the queue lease: lists the footage through the host. Never throws for a host that lacks the function. */
export async function prepareSequenceCheck(ctx: ToolContext, o: SequenceReportOptions): Promise<PreparedSequenceCheck> {
  const startedAt = Date.now();
  const budget = o.budgetMs ?? PRE_RENDER_BUDGET_MS;
  // A listing page is one eval in AE; with the default 120 s limit a single slow page could far overrun the budget.
  const call = makeScanCall(ctx, o.opId, o.toolName, LIST_PAGE_TIMEOUT_MS(budget));
  try {
    const listed = await listSequenceInputs(call, startedAt + budget * LIST_SHARE);
    return { inputs: listed.inputs, extraNotes: listed.reason ? [listed.reason] : [], startedAt };
  } catch (err) {
    if (err instanceof BridgeError && (err.kind === "evalscript_error" || o.tolerant === true)) {
      return { inputs: [], extraNotes: ["The footage list could not be read, so sequences were not checked."], error: err.message.slice(0, 300), startedAt };
    }
    throw err;
  }
}

/** Step 2, needs no After Effects: reads the folders. */
export async function finishSequenceCheck(prep: PreparedSequenceCheck, o: SequenceReportOptions): Promise<SequenceCheckResult> {
  if (prep.error !== undefined) return slim(EMPTY_REPORT, prep.extraNotes, prep.error);
  const budget = o.budgetMs ?? PRE_RENDER_BUDGET_MS;
  const left = Math.max(1000, budget - (Date.now() - prep.startedAt));
  const report = await checkSequences(prep.inputs, seqscanDeps.io, { budgetMs: left, liveDirs: o.liveDirs ?? seqscanDeps.liveDirs() });
  return slim(report, prep.extraNotes);
}

/** Both steps, inside the caller's lease. */
export async function sequenceReport(ctx: ToolContext, o: SequenceReportOptions): Promise<SequenceCheckResult> {
  return finishSequenceCheck(await prepareSequenceCheck(ctx, o), o);
}

function nameOf(r: SeqRow): string {
  return r.item_names[0] ?? r.pattern;
}

/** Lines for a result's `warnings`: gaps, then everything that is not as it should be. */
export function sequenceWarnings(c: SequenceCheckResult): string[] {
  const out: string[] = [];
  const rows = (s: string) => c.sequences.filter((r) => r.state === s);
  if (c.with_gaps > 0) {
    const parts = rows("gaps").slice(0, 3).map((r) => `"${nameOf(r)}": ${r.missing} frame${r.missing === 1 ? "" : "s"} missing between ${r.first} and ${r.last}${r.missing_text ? ` (${r.missing_text.slice(0, 120)})` : ""}`);
    out.push(
      `${c.with_gaps} image sequence${c.with_gaps === 1 ? " has" : "s have"} missing frames in the project${parts.length ? `: ${parts.join("; ")}${c.with_gaps > parts.length ? "; ..." : ""}` : ""}. ` +
        "After Effects shows missing frames as color bars or its missing-frames popup. The render was not stopped (sequence_check)."
    );
  }
  if (c.short > 0) {
    const r = rows("short")[0];
    out.push(
      `${c.short} image sequence${c.short === 1 ? " holds" : "s hold"} fewer frames than After Effects counts${r ? ` (e.g. "${nameOf(r)}": AE about ${r.ae_frames}, folder ${r.first}-${r.last})` : ""}: trailing frames may have been lost. A guess from the footage duration.`
    );
  }
  if (c.unknown_age > 0) {
    out.push(`${c.unknown_age} image sequence${c.unknown_age === 1 ? " has" : "s have"} gaps, but the time ran out before it could be read whether they are still being written.`);
  }
  if (c.writing > 0) {
    const w = rows("writing")[0];
    out.push(
      `${c.writing} image sequence${c.writing === 1 ? " is" : "s are"} still being written (${w?.writing_reason ?? "recently written"}); ` +
        "frames below the highest written frame may not be there yet (a multi-frame render writes out of order). Rendering from it now can miss frames."
    );
  }
  if (c.error !== undefined || c.unreadable > 0 || c.unchecked_count > 0 || (c.incomplete && c.unknown_age === 0)) {
    const why: string[] = [];
    if (c.error) why.push(c.error);
    if (c.unreadable > 0) why.push(`${c.unreadable} sequence folder${c.unreadable === 1 ? "" : "s"} could not be read`);
    if (c.unchecked_count > 0) why.push(`${c.unchecked_count} footage item${c.unchecked_count === 1 ? "" : "s"} not checked`);
    if (c.fs_paused) why.push(FS_PAUSED_NOTE);
    if (why.length === 0) why.push(c.notes[0] ?? "not everything was reached");
    out.push(`Sequence check incomplete: ${why.join("; ")}.`);
  }
  return out;
}

/** The sequences a "block" refuses on: gaps that are not being written. */
export function blockingSequences(c: SequenceCheckResult): SeqRow[] {
  return c.sequences.filter((r) => r.state === "gaps");
}

/** Why "block" refuses, empty when it does not: gaps, or a check that could not finish. A sequence still being written never blocks. */
export function blockReasons(c: SequenceCheckResult): string[] {
  const why: string[] = [];
  if (c.with_gaps > 0) {
    const first = blockingSequences(c)[0];
    why.push(`${c.with_gaps} image sequence${c.with_gaps === 1 ? " has" : "s have"} missing frames${first ? ` (e.g. "${nameOf(first)}": ${first.missing} missing, ${first.missing_text})` : ""}`);
  }
  if (c.error) why.push(`the footage could not be checked (${c.error})`);
  if (c.unreadable > 0) why.push(`${c.unreadable} sequence folder${c.unreadable === 1 ? "" : "s"} could not be read`);
  if (c.unchecked_count > 0) why.push(`${c.unchecked_count} footage item${c.unchecked_count === 1 ? " was" : "s were"} not checked (time budget or an unmatched file name)`);
  if (c.fs_paused) why.push(FS_PAUSED_NOTE);
  if (c.unknown_age > 0) why.push(`${c.unknown_age} sequence${c.unknown_age === 1 ? " has" : "s have"} gaps or a short count but could not be dated (time ran out), so it is not known whether ${c.unknown_age === 1 ? "it is" : "they are"} still being written`);
  // Any other incomplete check (a listing cut at the time limit or the item cap, a stat that never returned): block refuses it too.
  if (why.length === 0 && c.incomplete) why.push(`the check did not finish (${c.notes[0] ?? "not everything was reached"})`);
  return why;
}

/** The refusal code: sequence_gaps when frames are missing, sequence_check_incomplete when the check could not finish. */
export function blockCode(c: SequenceCheckResult): "sequence_gaps" | "sequence_check_incomplete" {
  return c.with_gaps > 0 ? "sequence_gaps" : "sequence_check_incomplete";
}

/** The text of a "block" refusal. */
export function sequenceBlockMessage(toolName: string, c: SequenceCheckResult): string {
  const what = c.with_gaps > 0 ? "Fix the missing frames" : "The check could not finish (see the reasons); try again, or fix what it names";
  return `${toolName} refused (sequence_check "block"): ${blockReasons(c).join("; ")}. Nothing was started. ${what}, or call again with sequence_check "warn" (it only warns and proceeds) or "off".`;
}

export interface SequenceStepResult {
  check?: SequenceCheckResult;
  warnings: string[];
  block: boolean;
  blockMessage?: string;
}

/** Turns a finished check into the step's result for a mode. */
export function sequenceStepFrom(mode: SequenceCheckMode | undefined, toolName: string, check: SequenceCheckResult): SequenceStepResult {
  const block = mode === "block" && blockReasons(check).length > 0;
  return { check, warnings: sequenceWarnings(check), block, ...(block ? { blockMessage: sequenceBlockMessage(toolName, check) } : {}) };
}

/**
 * The whole step inside the caller's lease, unless mode is "off".
 * `check` goes into the tool's result, `warnings` into its warnings.
 */
export async function runSequenceCheck(ctx: ToolContext, mode: SequenceCheckMode | undefined, o: SequenceReportOptions): Promise<SequenceStepResult> {
  if (mode === "off") return { warnings: [], block: false };
  return sequenceStepFrom(mode, o.toolName, await sequenceReport(ctx, o));
}
