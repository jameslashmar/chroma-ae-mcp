/**
 * server/src/tools/ext/deliver.ts
 *
 * A delivery pipeline that stops at the first blocker and can be resumed:
 * preflight, house style, save, render, verify the render, scrub check,
 * loudness, collect. It is a small state machine over tools that already
 * exist, not a prompt: a prompt keeps no state, can't refuse to go on past a
 * blocker and can't resume after a crash.
 * - ae_deliver_recipe: the stage list per client (list, get, set, delete),
 *   kept in <project>.deliver.json next to the .aep
 * - ae_deliver_step: start a run from a recipe, then next / retry / skip /
 *   cancel. Each call runs stages until one blocks, waits (a render is in
 *   flight) or max_stages is reached. A stage is one existing tool, run
 *   through its own handler, so its guard, undo group and read-back stay the
 *   tool's. This file adds the order, the stop rule, the checkpoint before
 *   writing stages, the per-stage verdict and the written record.
 * - ae_deliver_status: the run's table and a report to hand to the client
 *
 * Tools are looked up by name at run time. A stage whose tool isn't
 * registered (ae_render_batch, ae_loudness_check and ae_collect_files come
 * from other groups) is reported as "unavailable"; an optional stage goes
 * on, a required one stops the run.
 *
 * Why a run is not one undo step: each stage is its own evalScript (an undo
 * group can't span them). The way back is the checkpoint taken before each
 * stage that writes (ae_checkpoint_revert).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { QuarantineBlockedError } from "../../quarantine.js";
import { QueueWaitError } from "../../queue.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";

/** The delivery tools guard on the project only: a comp_id in expect would be accepted and never checked, so it is refused. */
const DeliverExpectSchema = ExpectSchema.omit({ comp_id: true })
  .strict()
  .describe("Target guard verified before anything runs: the open project must be project_path (expect.comp_id is not accepted here; the recipe's comp is checked by the recipe). Refuses with kind:'guard' on mismatch.");

// ---------- stage catalogue ----------

export const STAGE_KINDS = ["preflight", "house_style", "checkpoint", "save", "render", "verify", "scrub", "loudness", "collect"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

interface KindInfo {
  /** Tools a stage of this kind may run; the first is the default. Anything else is refused, so a recipe can't run a free-form script. */
  tools: readonly string[];
  /** The stage changes the project (or the .aep on disk), so a checkpoint comes first. */
  writes: boolean;
  /** Runs once per file the render stage produced. */
  per_output: boolean;
  /** An unavailable tool doesn't stop the run. */
  optional: boolean;
  /** Which of the render's outputs the tool takes, first one present wins. */
  output_keys: readonly ("job_id" | "path")[];
  /** Arguments filled in from the recipe's comp when the recipe's stage args leave them out. */
  fill: readonly ("comp_id" | "comp_name" | "comp_ids" | "comps")[];
  /** Keep the comp argument when an output is given too (verify compares the render with the comp; scrub takes comp_id or path, not both). */
  fill_with_output: boolean;
  /** What a per-output stage does when the render named no files. */
  no_output: "comp" | "blocked" | "warn";
}

export const KIND_INFO: Record<StageKind, KindInfo> = {
  preflight: { tools: ["ae_preflight"], writes: false, per_output: false, optional: false, output_keys: [], fill: ["comp_ids"], fill_with_output: false, no_output: "comp" },
  house_style: { tools: ["ae_house_style_check"], writes: false, per_output: false, optional: true, output_keys: [], fill: ["comp_id"], fill_with_output: false, no_output: "comp" },
  checkpoint: { tools: ["ae_checkpoint_create"], writes: false, per_output: false, optional: false, output_keys: [], fill: [], fill_with_output: false, no_output: "comp" },
  save: { tools: ["ae_save"], writes: true, per_output: false, optional: false, output_keys: [], fill: [], fill_with_output: false, no_output: "comp" },
  render: { tools: ["ae_render_batch", "ae_aerender_start"], writes: true, per_output: false, optional: false, output_keys: [], fill: ["comp_id", "comp_name", "comps"], fill_with_output: false, no_output: "comp" },
  verify: { tools: ["ae_verify_render"], writes: true, per_output: true, optional: false, output_keys: ["job_id", "path"], fill: ["comp_id"], fill_with_output: true, no_output: "blocked" },
  scrub: { tools: ["ae_scrub_check"], writes: true, per_output: true, optional: true, output_keys: ["path"], fill: ["comp_id"], fill_with_output: false, no_output: "comp" },
  loudness: { tools: ["ae_loudness_check"], writes: false, per_output: false, optional: true, output_keys: [], fill: ["comp_id"], fill_with_output: false, no_output: "comp" },
  collect: { tools: ["ae_collect_files"], writes: true, per_output: false, optional: true, output_keys: [], fill: ["comp_id"], fill_with_output: false, no_output: "comp" },
};

export const MAX_STAGES = 20;
/** The most files a run follows: ae_render_batch allows 500 items, and a file nobody checks must not pass unnoticed. */
export const MAX_OUTPUTS = 500;
const MAX_SHOWN = 40;
const KEPT_RUNS = 20;
const MAX_FINDINGS = 10;
const MAX_PREFLIGHT_CALLS = 8;
const MAX_COLLECT_CALLS = 4;
const STRING_LIMIT = 20000;

// ---------- schema ----------

const StageIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lower-case letters, digits and underscores, starting with a letter");

export const DeliverStageSchema = z
  .object({
    kind: z
      .enum(STAGE_KINDS)
      .describe(
        "What the stage does: preflight (ae_preflight delivery gate), house_style (ae_house_style_check), checkpoint (ae_checkpoint_create), save (ae_save), render (ae_render_batch, or ae_aerender_start), " +
          "verify (ae_verify_render on each rendered file), scrub (ae_scrub_check on each rendered file), loudness (ae_loudness_check on the comp's audio; needs a saved project), collect (ae_collect_files; needs args.dest and a saved project)."
      ),
    id: StageIdSchema.optional().describe("Name of the stage in the run table and for retry / skip. Default: the kind. Needed when a kind appears twice (two renders, say)."),
    tool: z
      .string()
      .regex(/^ae_[a-z0-9_]+$/)
      .optional()
      .describe("Run another tool for this kind. Only the tools listed for the kind are accepted (render: ae_render_batch or ae_aerender_start). Default: the kind's first tool."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The tool's arguments, WITHOUT expect (added for you). comp_id, comp_name and comp_ids are filled from the recipe's comp when the tool takes them and you leave them out. " +
          "A render stage needs its outputs here (ae_render_batch: output_dir and specs; comps is filled from the recipe's comp); the stages after it read the files it reports. A collect stage needs dest (dry_run defaults to false here)."
      ),
    optional: z.boolean().optional().describe("Go on when the stage's tool is not registered on this server. Default: true for house_style, scrub, loudness and collect, false for the rest. A blocker always stops the run."),
    per_output: z.boolean().optional().describe("Run once for each file the render stage produced (verify and scrub do by default), with job_id or path filled in."),
    fail_on: z.enum(["blocker", "warning"]).optional().describe("What stops the run. Default 'blocker'; 'warning' makes this stage's warnings stop it too (a strict client)."),
    checkpoint: z.boolean().optional().describe("Force a checkpoint before this stage on or off. Default: follows the recipe's checkpoint_mode (on for stages that write)."),
  })
  .superRefine((v, ctx) => {
    if (v.tool !== undefined && !KIND_INFO[v.kind].tools.includes(v.tool)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tool"], message: `A ${v.kind} stage runs ${KIND_INFO[v.kind].tools.join(" or ")}, not ${v.tool}.` });
    }
    if (v.args && "expect" in v.args) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args"], message: "args must not contain expect: the guard is added for you." });
    }
  });

export type DeliverStageInput = z.infer<typeof DeliverStageSchema>;

export const CHECKPOINT_MODES = ["each_write", "start", "none"] as const;
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];

const RecipeNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/, "letters, digits, space, _ . - (at most 60)")
  .describe("The recipe's name, usually the client or the channel ('Acme YouTube').");

function duplicateStageIds(stages: DeliverStageInput[] | undefined): string[] {
  if (!stages) return [];
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of stages) {
    const id = s.id ?? s.kind;
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

export const AeDeliverRecipeSchema = z
  .object({
    action: z
      .enum(["list", "get", "set", "delete"])
      .describe("list: the recipes in <project>.deliver.json. get: one recipe with its stages and whether each tool is available. set: create or change a recipe. delete: remove one (runs already made are kept)."),
    name: RecipeNameSchema.optional(),
    comp_id: z.number().int().optional().describe("set: the comp to deliver (a CompItem id). Checked now; the stages that take a comp get it unless their args say otherwise."),
    stages: z
      .array(DeliverStageSchema)
      .min(1)
      .max(MAX_STAGES)
      .optional()
      .describe(
        "set: the stages, run in this order. Left out on a new recipe: preflight, house_style, save, render, verify, scrub, save (save_final), loudness, collect. Left out on an existing recipe: its stages are kept. " +
          "A stage needs the tool it runs: the render stage in particular needs its args."
      ),
    checkpoint_mode: z
      .enum(CHECKPOINT_MODES)
      .optional()
      .describe("set: each_write (default) takes a checkpoint (a copy of the saved .aep) before each stage that writes, reusing one when the file hasn't changed; start: once before the first such stage; none."),
    notes: z.string().max(1000).optional().describe("set: free text kept with the recipe (the client's spec, say)."),
    expect: DeliverExpectSchema,
  })
  .refine((v) => v.action === "list" || v.name !== undefined, { message: "get, set and delete need name." })
  .refine((v) => duplicateStageIds(v.stages).length === 0, { message: "Two stages share an id: give each repeated kind its own id." })
  .refine((v) => v.action === "set" || (v.comp_id === undefined && v.stages === undefined && v.checkpoint_mode === undefined && v.notes === undefined), {
    message: "comp_id, stages, checkpoint_mode and notes apply to set only.",
  });

export type AeDeliverRecipeArgs = z.infer<typeof AeDeliverRecipeSchema>;

export const AeDeliverStepSchema = z
  .object({
    action: z
      .enum(["start", "next", "retry", "skip", "cancel"])
      .describe(
        "start: a new run from a recipe, then stages run until one blocks or waits. next: continue the run (polls a render that is in flight first). " +
          "retry: run the stopped stage again, after you fixed what it reported. skip: pass the stopped stage with a written acknowledgement (only when Jay accepts what it found). cancel: stop the run and any render it started."
      ),
    recipe: RecipeNameSchema.optional().describe("start: which recipe."),
    run_id: z
      .string()
      .regex(/^dl_[a-z0-9_]+$/)
      .optional()
      .describe("The run. Default: the latest run that is not done or cancelled."),
    stage: StageIdSchema.optional().describe("retry / skip: the stopped stage's id. Optional; it must be the stage the run stopped at."),
    acknowledge: z.string().min(5).max(500).optional().describe("skip: why the stopped stage may be passed (kept in the record and the report). Never skip a blocker on your own: ask Jay."),
    max_stages: z.number().int().min(1).max(MAX_STAGES).optional().describe("Run at most this many stages in this call. Default: until one blocks, waits or the recipe ends."),
    dry_run: z.boolean().optional().describe("start: show the stages, their tools and whether each is available, check the arguments that don't depend on the render, and write nothing."),
    expect: DeliverExpectSchema,
  })
  .refine((v) => v.action !== "start" || v.recipe !== undefined, { message: "start needs recipe." })
  .refine((v) => v.action === "start" || v.recipe === undefined, { message: "recipe applies to start only; the other actions use run_id." })
  .refine((v) => v.action !== "skip" || (v.acknowledge !== undefined), { message: "skip needs acknowledge." })
  .refine((v) => v.action === "skip" || v.acknowledge === undefined, { message: "acknowledge applies to skip only." })
  .refine((v) => v.action === "retry" || v.action === "skip" || v.stage === undefined, { message: "stage applies to retry and skip." })
  .refine((v) => v.action === "start" || v.dry_run === undefined, { message: "dry_run applies to start only." });

export type AeDeliverStepArgs = z.infer<typeof AeDeliverStepSchema>;

export const AeDeliverStatusSchema = z.object({
  run_id: z
    .string()
    .regex(/^dl_[a-z0-9_]+$/)
    .optional()
    .describe("The run to show. Default: the latest run."),
  list: z.boolean().optional().describe("List the runs (newest first) instead of showing one."),
  expect: DeliverExpectSchema,
});

export type AeDeliverStatusArgs = z.infer<typeof AeDeliverStatusSchema>;

// ---------- records ----------

export interface StageDef {
  id: string;
  kind: StageKind;
  tool: string;
  args: Record<string, unknown>;
  optional: boolean;
  per_output: boolean;
  fail_on: "blocker" | "warning";
  checkpoint?: boolean;
}

export interface Recipe {
  name: string;
  comp_id?: number;
  checkpoint_mode: CheckpointMode;
  notes?: string;
  stages: StageDef[];
  updated_at: string;
}

export type StageStatus = "pending" | "in_flight" | "running" | "ok" | "warn" | "blocked" | "error" | "unavailable" | "skipped";
export type RunState = "in_progress" | "waiting" | "blocked" | "done" | "cancelled";

export interface Finding {
  severity: string;
  message: string;
  where?: string;
}

export interface ChildState {
  output: string;
  status: "ok" | "warn" | "blocked" | "skipped";
  summary: string;
}

export interface StageCheckpoint {
  status: "created" | "reused" | "skipped" | "unavailable";
  path?: string;
  note?: string;
}

export interface StageState {
  id: string;
  kind: StageKind;
  tool: string;
  def: StageDef;
  status: StageStatus;
  summary?: string;
  findings?: Finding[];
  children?: ChildState[];
  job_ids?: string[];
  /** The ae_render_batch batch a render stage follows. */
  batch_id?: string;
  /** A background job (render, batch, audio render) of this stage may still be running. */
  live?: boolean;
  checkpoint?: StageCheckpoint;
  attempts: number;
  /** An error or refusal kind when the stage did not finish cleanly. */
  error?: string;
  acknowledged?: string;
  /** Whether the tool's write reached the project: unknown after an error. */
  applied?: boolean | "unknown";
  started_at?: string;
  finished_at?: string;
}

export interface OutputRef {
  job_id?: string;
  path?: string;
  /** A numbered-frames pattern ([####]): it has no single file to open. */
  sequence?: boolean;
  /** The comp the file was rendered from (render batch items name it). */
  comp?: string;
}

export interface Run {
  id: string;
  recipe: string;
  comp_id?: number;
  comp_name?: string;
  project_path: string;
  ae_version?: string;
  checkpoint_mode: CheckpointMode;
  created_at: string;
  updated_at: string;
  state: RunState;
  stop_reason?: string;
  /** Whether the project had unsaved changes when the run finished (its own stages can cause that). */
  project_dirty_at_end?: boolean;
  stages: StageState[];
  outputs: OutputRef[];
  checkpoints_taken: number;
  last_checkpoint?: { stamp: string; path?: string };
}

export interface Store {
  version: 1;
  recipes: Recipe[];
  runs: Run[];
}

// ---------- pure logic ----------

const clip = (s: unknown, n = 500): string => {
  const str = typeof s === "string" ? s : String(s);
  return str.length > n ? `${str.slice(0, n)}...` : str;
};

/** The recipe a new client starts from. */
export function defaultStages(): DeliverStageInput[] {
  // verify and scrub import and remove files, which marks the project changed; the second save puts it back
  // to clean, because the loudness check and the collect both refuse a project with unsaved changes.
  return [
    { kind: "preflight" },
    { kind: "house_style" },
    { kind: "save" },
    { kind: "render" },
    { kind: "verify" },
    { kind: "scrub" },
    { kind: "save", id: "save_final", checkpoint: false },
    { kind: "loudness" },
    { kind: "collect", args: { dry_run: false } },
  ];
}

export function normalizeStages(stages: DeliverStageInput[]): StageDef[] {
  return stages.map((s) => {
    const info = KIND_INFO[s.kind];
    const def: StageDef = {
      id: s.id ?? s.kind,
      kind: s.kind,
      tool: s.tool ?? info.tools[0],
      args: { ...(s.args ?? {}) },
      optional: s.optional ?? info.optional,
      per_output: s.per_output ?? info.per_output,
      fail_on: s.fail_on ?? "blocker",
    };
    if (s.checkpoint !== undefined) def.checkpoint = s.checkpoint;
    return def;
  });
}

/** Whether a checkpoint comes before this stage. */
export function checkpointDue(mode: CheckpointMode, def: StageDef, takenSoFar: number): boolean {
  if (def.kind === "checkpoint") return false;
  if (def.checkpoint !== undefined) return def.checkpoint;
  if (mode === "none") return false;
  if (!KIND_INFO[def.kind].writes) return false;
  if (mode === "start") return takenSoFar === 0;
  return true;
}

const SEQUENCE_PATTERN = /\[#+\]/;

export interface Classified {
  status: "ok" | "warn" | "blocked";
  summary: string;
  findings: Finding[];
  /** The write was applied but couldn't be confirmed: do not run it again blindly. */
  unverified?: boolean;
  /** The tool said its write reached the project. */
  applied?: boolean;
  /** A background job was started and the tool's answer is not final yet. */
  running?: boolean;
}

function findingsOf(res: Record<string, any>): Finding[] {
  // ae_render_batch refuses a plan with errors[] (code, message, comp or item), not findings[].
  const planErrors: unknown[] = Array.isArray(res.errors)
    ? res.errors.map((e: any) =>
        e && typeof e === "object" ? { severity: "blocker", message: e.message ?? e.code, where: typeof e.comp === "string" ? e.comp : e.item !== undefined ? `item ${String(e.item)}` : undefined } : e
      )
    : [];
  const list: unknown[] = [...(Array.isArray(res.findings) ? res.findings : []), ...planErrors];
  const out: Finding[] = [];
  for (const f of list) {
    if (out.length >= MAX_FINDINGS) break;
    if (f === null || typeof f !== "object") continue;
    const o = f as Record<string, any>;
    const message = o.message ?? o.msg ?? o.what;
    if (message === undefined) continue;
    let where: string | undefined;
    if (typeof o.where === "string") where = o.where;
    else if (o.where && typeof o.where === "object") where = o.where.layer ?? o.where.item ?? o.where.comp ?? o.where.path;
    else if (typeof o.layer === "string") where = o.layer;
    else if (typeof o.time === "number") where = `t=${o.time}s`;
    out.push({ severity: String(o.severity ?? "note"), message: clip(message, 300), ...(where !== undefined ? { where: clip(where, 200) } : {}) });
  }
  return out;
}

function countsText(counts: unknown): string {
  if (counts === null || typeof counts !== "object") return "";
  return Object.entries(counts as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}

/** Text naming what a verify or scrub left in the project (or could not confirm gone), or null. */
function leftoverOf(kind: StageKind, r: Record<string, any>, problems: any[]): string | null {
  const stray = "Inspect the project and remove it before the run goes on (it would be saved into the .aep and collected); retry is refused, skip needs an acknowledgement.";
  if (kind === "scrub") {
    const st = r.imported_state;
    const left = r.left_in_project;
    if (st === "left" || st === "unknown" || (left && typeof left === "object" && st !== "kept_in_use")) {
      const ids = left && typeof left === "object" ? ` (item ${String(left.item_id)}${left.comp_id !== undefined ? `, comp ${String(left.comp_id)}` : ""})` : "";
      return `The scrub check ${st === "unknown" ? "could not confirm it removed" : "left"} its temporary comp and imported render in the project${ids}. ${stray}`;
    }
  }
  if (kind === "verify") {
    const st = r.imported_item_state;
    if (st === "left" || st === "unknown") {
      return `The verify ${st === "unknown" ? "could not confirm it removed" : "left"} the imported render in the project${r.imported_item !== undefined && r.imported_item !== null ? ` (item ${String(r.imported_item)})` : ""}. ${stray}`;
    }
  }
  if ((kind === "scrub" || kind === "verify") && problems.some((m) => m?.path === "cleanup")) {
    return `The ${kind} could not clean up after itself: ${clip(problems.find((m) => m?.path === "cleanup")?.message ?? "cleanup failed", 200)} ${stray}`;
  }
  return null;
}

/**
 * What a stage's tool result means for the run: ok (go on), warn (go on, listed in the report)
 * or blocked (stop). Written against the result shapes of the tools a stage runs; a tool this
 * file doesn't know (loudness, collect) is read through the fields most tools share.
 */
export function classifyStageResult(kind: StageKind, res: unknown): Classified {
  if (res === null || typeof res !== "object") return { status: "ok", summary: "done", findings: [] };
  const r = res as Record<string, any>;
  const mismatches: any[] = Array.isArray(r.receipt?.mismatches) ? r.receipt.mismatches : Array.isArray(r.mismatches) ? r.mismatches : [];
  const problems: any[] = Array.isArray(r.problems) ? r.problems : [];
  // verify and scrub import a render and take it out again: one that is still in the project would be saved into the client's .aep and collected.
  const leftover = leftoverOf(kind, r, problems);
  if (leftover) return { status: "blocked", unverified: true, summary: leftover, findings: findingsOf(r) };
  if (r.error === "read_back_failed" || mismatches.some((m) => m?.path === "read_back") || problems.some((m) => m?.path === "read_back")) {
    return {
      status: "blocked",
      unverified: true,
      summary: "The step was applied but its read-back failed (often a popup in AE). Inspect the project before running it again.",
      findings: [],
    };
  }
  if (kind === "loudness" && r.ok === false && r.error === "no_audio") {
    return { status: "warn", summary: `No audio to measure: ${clip(r.message ?? "the comp has no layer with audio switched on", 300)}`, findings: [] };
  }
  if (r.ok === false || typeof r.error === "string") {
    const error = typeof r.error === "string" ? r.error : "failed";
    const message = typeof r.message === "string" ? ` ${clip(r.message, 400)}` : "";
    // A tool that failed after its write reached the project (verify's read_failed, say): do not run it again blindly.
    const reached = r.applied === true;
    return { status: "blocked", summary: `${error}:${message}`.trim(), findings: findingsOf(r), ...(reached ? { unverified: true, applied: true } : {}) };
  }
  if (r.receipt?.matches === false || r.matches === false) {
    if (kind === "verify") {
      const failed: any[] = (Array.isArray(r.checks) ? r.checks : []).filter((c: any) => c && c.ok === false);
      const text = failed.map((c) => `${c.what}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`).join("; ");
      return {
        status: "blocked",
        summary: `The render does not match the comp${text ? ` (${clip(text, 400)})` : ""}.`,
        findings: failed.slice(0, MAX_FINDINGS).map((c) => ({ severity: "blocker", message: clip(`${c.what}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}${c.note ? ` (${c.note})` : ""}`, 300) })),
      };
    }
    return { status: "blocked", summary: "The read-back differs from what was asked.", findings: mismatches.slice(0, MAX_FINDINGS).map((m) => ({ severity: "blocker", message: clip(m?.message ?? "mismatch", 300) })) };
  }
  const findings = findingsOf(r);
  const counts = countsText(r.counts);
  if (kind === "loudness") {
    // The audio is still rendering: the answer comes later, from the same job.
    if (r.verdict === undefined && r.state === "rendering" && typeof r.job_id === "string") {
      return { status: "ok", running: true, summary: "The audio is still rendering.", findings: [] };
    }
    if (r.verdict !== null && typeof r.verdict === "object") {
      const v = r.verdict as Record<string, any>;
      const advice = Array.isArray(v.advice) && typeof v.advice[0] === "string" ? ` ${clip(v.advice[0], 300)}` : "";
      const lufs = typeof r.measurement?.integrated_lufs === "number" ? `${r.measurement.integrated_lufs} LUFS` : "";
      const tp = typeof r.measurement?.true_peak_dbtp === "number" ? `, true peak ${r.measurement.true_peak_dbtp} dBTP` : "";
      if (v.measurable === false) return { status: "blocked", summary: `The loudness could not be measured (silent or below the gate).${advice}`, findings };
      if (v.passes === false) {
        const why = v.loudness_ok === false ? "loudness off target" : v.true_peak_ok === false ? "true peak over the ceiling" : "does not meet the target";
        return { status: "blocked", summary: `Loudness fails: ${why}${lufs ? ` (${lufs}${tp})` : ""}.${advice}`, findings };
      }
      return { status: "ok", summary: `loudness ok${lufs ? `: ${lufs}${tp}` : ""}`, findings };
    }
  }
  if (kind === "collect") {
    if (r.complete === false) {
      const errs = typeof r.errors_total === "number" && r.errors_total > 0 ? ` ${r.errors_total} file(s) failed.` : "";
      const left = typeof r.remaining === "number" && r.remaining > 0 ? ` ${r.remaining} file(s) left.` : "";
      return { status: "blocked", summary: `The collect is not complete.${errs}${left} Retry continues it with the same arguments.`, findings };
    }
    if (r.dry_run === true) return { status: "warn", summary: "Dry run: nothing was copied. Set dry_run false in the collect stage's args.", findings };
    const zip = r.zip && typeof r.zip === "object" ? (r.zip as Record<string, any>) : null;
    if (zip && zip.ok !== true) {
      const why = zip.status === "running" ? "is still being written in the background; retry asks again for the result" : `failed: ${clip(zip.message ?? zip.error ?? "it did not verify against the manifest", 300)}`;
      return { status: "blocked", summary: `The files were copied but the zip ${why}.`, findings };
    }
    if (zip && zip.verified === false) {
      return { status: "blocked", summary: `The files were copied but the zip did not verify against the manifest${Array.isArray(zip.verify_errors) && zip.verify_errors[0] ? `: ${clip(zip.verify_errors[0], 200)}` : ""}.`, findings };
    }
    const gaps: string[] = [];
    if (typeof r.problems_total === "number" && r.problems_total > 0) gaps.push(`${r.problems_total} problem(s) with the footage`);
    if (typeof r.no_file_items_total === "number" && r.no_file_items_total > 0) gaps.push(`${r.no_file_items_total} item(s) with no file`);
    if (Array.isArray(r.sequences_with_gaps) && r.sequences_with_gaps.length > 0) gaps.push(`${r.sequences_with_gaps.length} sequence(s) with gaps`);
    if (r.report && typeof r.report === "object" && typeof r.report.error === "string") gaps.push(`the report was not written (${clip(r.report.error, 150)})`);
    const copied = `collected${typeof r.files_total === "number" ? ` ${r.files_total} file(s)` : ""}`;
    if (gaps.length > 0) return { status: "warn", summary: `${copied}, but ${gaps.join("; ")}`, findings };
    return { status: "ok", summary: copied, findings };
  }
  if (typeof r.verdict === "string") {
    const v = r.verdict;
    if (v === "blocked" || v === "fail" || v === "failed") return { status: "blocked", summary: `${v}${counts ? ` (${counts})` : ""}`, findings };
    if (v === "warnings" || v === "warn") return { status: "warn", summary: `${v}${counts ? ` (${counts})` : ""}`, findings };
    if (v === "incomplete") {
      // A delivery gate that did not cover the whole project has not cleared it.
      if (kind === "preflight") return { status: "blocked", summary: "The preflight did not cover the whole project, so blockers may be missing from it. Run it again.", findings };
      return { status: "warn", summary: "The check did not finish, so blockers may be missing from it.", findings };
    }
    return { status: "ok", summary: `${v}${counts ? ` (${counts})` : ""}`, findings };
  }
  if (r.pass === false) return { status: "blocked", summary: "The check did not pass.", findings };
  if (kind === "house_style") {
    const c = r.counts && typeof r.counts === "object" ? (r.counts as Record<string, number>) : {};
    if ((c.medium ?? 0) > 0 || (c.low ?? 0) > 0) return { status: "warn", summary: `house style: ${counts}`, findings };
    return { status: "ok", summary: r.clean === true ? "house style: clean" : `house style: ${counts || "no findings"}`, findings };
  }
  if (kind === "verify") {
    return { status: "ok", summary: "The render matches the comp.", findings };
  }
  if (r.clean === false) return { status: "warn", summary: counts || "findings", findings };
  return { status: "ok", summary: counts ? `ok (${counts})` : "ok", findings };
}

const STATUS_RANK: Record<"ok" | "warn" | "blocked", number> = { ok: 0, warn: 1, blocked: 2 };

export function worstOf(statuses: Array<"ok" | "warn" | "blocked" | "skipped">): "ok" | "warn" | "blocked" {
  let worst: "ok" | "warn" | "blocked" = "ok";
  for (const s of statuses) {
    if (s === "skipped") continue;
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

/** A stage with fail_on 'warning' stops on a warning. */
export function applyFailOn(c: Classified, def: StageDef): Classified {
  if (def.fail_on === "warning" && c.status === "warn") return { ...c, status: "blocked", summary: `${c.summary} (this stage stops on warnings)` };
  return c;
}

/** The aerender job ids a render tool's result names (job_id, job_ids, or jobs[].job_id). */
export function extractJobIds(res: unknown): string[] {
  if (res === null || typeof res !== "object") return [];
  const r = res as Record<string, any>;
  const ids: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && !ids.includes(v)) ids.push(v);
  };
  add(r.job_id);
  if (Array.isArray(r.job_ids)) r.job_ids.forEach(add);
  if (Array.isArray(r.jobs)) for (const j of r.jobs) if (j && typeof j === "object") add((j as Record<string, unknown>).job_id);
  return ids.slice(0, MAX_OUTPUTS);
}

/** The batch a render tool started (ae_render_batch answers with batch_id and items[], not job ids). */
export function extractBatchId(res: unknown): string | undefined {
  if (res === null || typeof res !== "object") return undefined;
  const id = (res as Record<string, unknown>).batch_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The files of a finished batch's items: rendered ones, and ones an existing file stood in for ('skipped'). */
export function batchOutputs(items: unknown): OutputRef[] {
  if (!Array.isArray(items)) return [];
  const out: OutputRef[] = [];
  for (const it of items) {
    if (it === null || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (o.state !== "succeeded" && o.state !== "skipped") continue;
    if (typeof o.output_path !== "string" || o.output_path.length === 0) continue;
    if (out.some((x) => x.path === o.output_path)) continue;
    out.push({
      path: o.output_path,
      ...(typeof o.job_id === "string" ? { job_id: o.job_id } : {}),
      ...(typeof o.comp === "string" && o.comp.length > 0 ? { comp: o.comp } : {}),
      ...(SEQUENCE_PATTERN.test(o.output_path) ? { sequence: true } : {}),
    });
  }
  return out.slice(0, MAX_OUTPUTS);
}

/** The files a render tool's result names (output_path, outputs[], files[], jobs[].output_path). */
export function extractOutputs(res: unknown): OutputRef[] {
  if (res === null || typeof res !== "object") return [];
  const r = res as Record<string, any>;
  const out: OutputRef[] = [];
  const add = (p: unknown, jobId?: unknown) => {
    if (typeof p !== "string" || p.length === 0) return;
    if (out.some((o) => o.path === p)) return;
    out.push({ path: p, ...(typeof jobId === "string" ? { job_id: jobId } : {}), ...(SEQUENCE_PATTERN.test(p) ? { sequence: true } : {}) });
  };
  add(r.output_path, r.job_id);
  for (const key of ["outputs", "files", "jobs", "renders"]) {
    if (!Array.isArray(r[key])) continue;
    for (const o of r[key]) {
      if (typeof o === "string") add(o);
      else if (o && typeof o === "object") add(o.path ?? o.output_path ?? o.file, o.job_id);
    }
  }
  return out.slice(0, MAX_OUTPUTS);
}

/** What a per-output stage passes for one output, or null when the tool can't take it (an image-sequence pattern has no one file). */
export function outputArgsFor(kind: StageKind, output: OutputRef): Record<string, unknown> | null {
  for (const key of KIND_INFO[kind].output_keys) {
    if (key === "job_id" && output.job_id) return { job_id: output.job_id };
    if (key === "path" && output.path && !output.sequence) return { path: output.path };
  }
  return null;
}

export function outputLabel(o: OutputRef): string {
  return o.path ?? o.job_id ?? "output";
}

/** Whether a stage lets the run go on. */
export function passes(s: StageState): boolean {
  return s.status === "ok" || s.status === "warn" || s.status === "skipped" || (s.status === "unavailable" && s.def.optional);
}

/**
 * Whether next should look at the stage's background job again: it is running, or it stopped on a
 * failed look (job_unknown / unavailable) or on a failed render that may be resumed.
 */
export function isPollable(s: StageState): boolean {
  if (s.kind !== "render" && s.kind !== "loudness") return false;
  if (!s.batch_id && !(s.job_ids && s.job_ids.length > 0)) return false;
  if (s.status === "running") return true;
  if (s.status === "error") return s.error === "job_unknown" || s.error === "unavailable";
  if (s.status === "blocked") return s.error === "render_failed" || s.error === "batch_stopped";
  return false;
}

/** Stage kinds whose tool can be run again after an unconfirmed write without doing the write twice. */
const REPEATABLE_KINDS: ReadonlySet<StageKind> = new Set<StageKind>(["preflight", "house_style", "checkpoint", "save", "loudness", "collect"]);

/** Why a stored stage definition must not run, or null. Recipes in <project>.deliver.json are not trusted: a stage runs only the tools its kind lists. */
export function validateStageDef(def: unknown): string | null {
  if (def === null || typeof def !== "object") return "The stage definition is not an object.";
  const d = def as Record<string, unknown>;
  const info = typeof d.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_INFO, d.kind) ? KIND_INFO[d.kind as StageKind] : undefined;
  if (!info) return `Unknown stage kind "${String(d.kind)}".`;
  if (typeof d.tool !== "string" || !info.tools.includes(d.tool)) return `A ${String(d.kind)} stage runs ${info.tools.join(" or ")}, not "${String(d.tool)}".`;
  if (typeof d.id !== "string" || !StageIdSchema.safeParse(d.id).success) return "The stage id is not valid.";
  if (d.args === null || typeof d.args !== "object" || Array.isArray(d.args)) return "The stage args are not an object.";
  if ("expect" in (d.args as Record<string, unknown>)) return "The stage args contain expect: the guard is added for you.";
  return null;
}

/** A problem with a stage's args that needs no tool to see (the collect stage's folder), or null. */
export function stagePrecheck(def: StageDef): string | null {
  if (def.kind === "collect" && (typeof def.args.dest !== "string" || def.args.dest.length === 0)) {
    return "The collect stage needs args.dest (an absolute folder for the copy). Set it in the recipe, then retry.";
  }
  return null;
}

/** The stage the run is at: the first one that has not passed. */
export function currentStage(run: Run): StageState | undefined {
  return run.stages.find((s) => !passes(s));
}

export function deriveState(run: Run): RunState {
  if (run.state === "cancelled") return "cancelled";
  const cur = currentStage(run);
  if (!cur) return "done";
  if (cur.status === "running") return "waiting";
  if (cur.status === "pending") return "in_progress";
  return "blocked";
}

export function summarizeStages(stages: StageState[]): Record<StageStatus, number> {
  const s: Record<StageStatus, number> = { pending: 0, in_flight: 0, running: 0, ok: 0, warn: 0, blocked: 0, error: 0, unavailable: 0, skipped: 0 };
  for (const st of stages) s[st.status]++;
  return s;
}

export function describeError(err: unknown): { error: string; message: string; applied: boolean | "unknown" } {
  if (err instanceof QuarantineBlockedError) return { error: "quarantine", message: clip(err.message), applied: false };
  if (err instanceof QueueWaitError) return { error: "queued", message: clip(err.message), applied: false };
  if (err instanceof BridgeError) {
    // A guard refusal and a queue wait happen before the tool writes; a timeout or a lost AE may come after.
    if (err.kind === "guard" || err.kind === "queued") return { error: err.kind, message: clip(err.message), applied: false };
    return { error: err.kind, message: clip(err.message), applied: "unknown" };
  }
  return { error: "error", message: clip(err instanceof Error ? err.message : String(err)), applied: "unknown" };
}

/** What to do next, in words. */
export function nextHint(run: Run): string {
  const cur = currentStage(run);
  if (run.state === "cancelled") return "The run was cancelled. Start a new one with action 'start'.";
  if (!cur) return "Delivery is complete. Show Jay the report; the files are listed under outputs.";
  if (run.state === "waiting") return `Stage "${cur.id}" is still running. Call ae_deliver_step with action 'next' again to check it.`;
  if (run.state === "blocked") {
    if (isPollable(cur) && cur.status !== "running") {
      if (cur.batch_id) {
        return `Stopped at stage "${cur.id}". Fix the cause, call ae_render_batch_resume (it keeps the items that finished), then ae_deliver_step with action 'next' to follow the batch again. 'retry' is refused for a batch: a new one would see the files this one wrote as someone else's recent files.`;
      }
      return `Stopped at stage "${cur.id}". Call ae_deliver_step with action 'next' to check its render or audio job again. 'retry' starts a new one, and is refused while the old one may still be running.`;
    }
    if (cur.status === "unavailable") return `Stage "${cur.id}" needs ${cur.tool}, which this server doesn't have. Make it optional in the recipe and retry, or skip it with an acknowledgement if Jay agrees.`;
    return `Stopped at stage "${cur.id}". Fix what it reports, then call ae_deliver_step with action 'retry'. Skip it (action 'skip', with acknowledge) only if Jay accepts what it found.`;
  }
  return "Call ae_deliver_step with action 'next' to run the remaining stages.";
}

export function renderReport(run: Run): string {
  const head: string[] = [];
  head.push(`Delivery report: ${run.recipe}`);
  head.push(`Run ${run.id}, ${run.state}. Project ${run.project_path}${run.comp_name ? `, comp "${run.comp_name}"` : ""}${run.ae_version ? `, After Effects ${run.ae_version}` : ""}.`);
  head.push(`Started ${run.created_at}, last change ${run.updated_at}.`);
  if (run.stop_reason) head.push(`Stopped: ${clip(run.stop_reason, 600)}`);
  head.push("");
  head.push("Stages");
  // Child rows are clipped short and the rows per stage shrink with the number of stages, so the Outputs list below always fits.
  const withKids = run.stages.filter((s) => (s.children ?? []).length > 0).length;
  const perStage = Math.max(5, Math.min(MAX_SHOWN, Math.floor((MAX_SHOWN * 2) / Math.max(1, withKids))));
  const row = (c: ChildState): string => `    ${clip(c.output, 120)}: ${c.status}${c.summary ? ` - ${clip(c.summary, 120)}` : ""}`;
  const outs: string[] = [];
  if (run.outputs.length > 0) {
    outs.push("");
    outs.push("Outputs");
    for (const o of run.outputs.slice(0, MAX_SHOWN * 2)) outs.push(`- ${clip(o.path ?? "(no path)", 150)}${o.job_id ? ` (job ${o.job_id})` : ""}`);
    if (run.outputs.length > MAX_SHOWN * 2) outs.push(`and ${run.outputs.length - MAX_SHOWN * 2} more (${run.outputs.length} in all)`);
  }
  const headText = head.join("\n");
  const outsText = outs.join("\n");
  // The Outputs list is kept whole. Stage lines fill what is left by priority, for every stage
  // before the next tier: status lines, then findings, then rows that are not ok, then ok rows.
  // Whatever does not fit is counted in the stage's "and N more" line.
  let room = Math.max(0, STRING_LIMIT - headText.length - outsText.length - 80 - run.stages.length * 40);
  const take = (line: string): boolean => {
    if (line.length + 1 > room) return false;
    room -= line.length + 1;
    return true;
  };
  const blocks = run.stages.map((s) => {
    const kids = s.children ?? [];
    const bad = kids.filter((c) => c.status !== "ok").slice(0, perStage);
    const good = kids.filter((c) => c.status === "ok").slice(0, Math.max(0, perStage - bad.length));
    return { s, kids, bad, good, top: [] as string[], findings: [] as string[], badShown: [] as string[], goodShown: [] as string[] };
  });
  for (const b of blocks) {
    const lines = [`- ${b.s.id} (${b.s.tool}): ${b.s.status}${b.s.summary ? ` - ${clip(b.s.summary, 400)}` : ""}`];
    if (b.s.acknowledged) lines.push(`    accepted by hand: ${clip(b.s.acknowledged, 300)}`);
    if (b.s.checkpoint && b.s.checkpoint.path) lines.push(`    checkpoint ${b.s.checkpoint.status}: ${clip(b.s.checkpoint.path, 200)}`);
    for (const l of lines) if (take(l)) b.top.push(l);
  }
  for (const b of blocks) {
    for (const f of (b.s.findings ?? []).slice(0, 5)) {
      const l = `    [${f.severity}] ${clip(f.message, 200)}${f.where ? ` (${clip(f.where, 100)})` : ""}`;
      if (take(l)) b.findings.push(l);
    }
  }
  for (const b of blocks) for (const c of b.bad) if (take(row(c))) b.badShown.push(row(c));
  for (const b of blocks) for (const c of b.good) if (take(row(c))) b.goodShown.push(row(c));
  const stages: string[] = [];
  for (const b of blocks) {
    stages.push(...b.top, ...b.badShown, ...b.goodShown);
    const hidden = b.kids.length - b.badShown.length - b.goodShown.length;
    if (hidden > 0) stages.push(`    and ${hidden} more (${b.kids.length} in all)`);
    stages.push(...b.findings);
  }
  const text = [headText, stages.join("\n"), ...(outsText ? [outsText] : [])].join("\n");
  return text.length > STRING_LIMIT ? `${text.slice(0, STRING_LIMIT)}\n[report cut at ${STRING_LIMIT} characters]` : text;
}

/** Whether a tool's schema takes a key (an unknown schema shape counts as yes). */
export function schemaAcceptsKey(schema: z.ZodTypeAny, key: string): boolean {
  let s: any = schema;
  for (let i = 0; i < 10 && s && s._def && s._def.typeName === "ZodEffects"; i++) s = s._def.schema;
  if (s && s._def && s._def.typeName === "ZodObject" && typeof s.shape === "object") return key in s.shape;
  return true;
}

// ---------- store ----------

/** `<project>.deliver.json` next to the .aep. */
export function deliverPath(projectPath: string): string {
  return path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}.deliver.json`);
}

// Stores of this server process: an unsaved project has no file, and a file that can't be written still has its runs.
const memoryStores = new Map<string, Store>();
/** Projects whose newest store could not be written: the memory copy is newer than the file until a write succeeds. */
const unsavedStores = new Set<string>();
const activeRuns = new Set<string>();

export function clearDeliverMemory(): void {
  memoryStores.clear();
  unsavedStores.clear();
  activeRuns.clear();
}

const emptyStore = (): Store => ({ version: 1, recipes: [], runs: [] });

/** The state file exists but could not be read (Dropbox holding it, a permission error). Saving over it would lose every recipe and run in it. */
export class StoreUnreadableError extends Error {
  readonly kind = "state_file_unreadable";
  constructor(file: string, cause: unknown) {
    super(`The delivery record ${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was run or written; try again when the file is free.`);
  }
}

function unreadable(err: unknown) {
  if (err instanceof StoreUnreadableError) return { ok: false, error: err.kind, applied: false, message: err.message };
  throw err;
}

function readStoreFile(file: string): Store | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.recipes) && Array.isArray(parsed.runs)) return { version: 1, recipes: parsed.recipes, runs: parsed.runs };
  } catch {
    /* falls through to the aside below */
  }
  // Never overwrite a file that can't be parsed: keep it beside the new one.
  fs.renameSync(file, `${file}.${Date.now()}.bak`);
  return null;
}

export function loadStore(projectPath: string): Store {
  // A store the last save could not write is newer than the file: keep using it, and try the write again.
  if (projectPath !== "<unsaved>" && unsavedStores.has(projectPath)) {
    const newer = memoryStores.get(projectPath);
    if (newer) {
      saveStore(projectPath, newer);
      return newer;
    }
  }
  if (projectPath !== "<unsaved>") {
    const file = deliverPath(projectPath);
    let found: Store | null;
    try {
      found = readStoreFile(file);
    } catch (e) {
      // Only a file that is not there falls back to an empty store. Any other failure stops the call.
      throw new StoreUnreadableError(file, e);
    }
    if (found) {
      memoryStores.set(projectPath, found);
      return found;
    }
  }
  const mem = memoryStores.get(projectPath);
  if (mem) return mem;
  const fresh = emptyStore();
  memoryStores.set(projectPath, fresh);
  return fresh;
}

/** Saves the store. Never throws: returns the file written, or why not. */
export function saveStore(projectPath: string, store: Store): { file: string | null; error?: string } {
  if (store.runs.length > KEPT_RUNS) store.runs = store.runs.slice(-KEPT_RUNS);
  memoryStores.set(projectPath, store);
  if (projectPath === "<unsaved>") return { file: null };
  const file = deliverPath(projectPath);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, file);
    unsavedStores.delete(projectPath);
    return { file };
  } catch (e) {
    unsavedStores.add(projectPath);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    return { file: null, error: (e as Error).message };
  }
}

function storeNotes(projectPath: string, saved: { file: string | null; error?: string }): Record<string, unknown> {
  if (saved.error) return { state_file_error: saved.error, state_file_note: "The record could not be written next to the project; it is kept in this server's memory only." };
  if (projectPath === "<unsaved>") return { state_file_note: "The project is unsaved, so the record is kept in this server's memory only; save the project to keep it beside the .aep." };
  return {};
}

function newRunId(): string {
  return `dl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

// ---------- tool lookup ----------

type ToolLookup = (name: string) => Promise<ToolDefinition<any> | undefined>;

// Loaded on first use: the registry imports the tool groups, this one included.
const registryLookup: ToolLookup = async (name) => {
  const { ALL_TOOLS } = await import("../registry.js");
  return ALL_TOOLS.find((t) => t.name === name);
};
let lookupTool: ToolLookup = registryLookup;

/** Tests swap the registry for a set of fake tools; call with no argument to restore it. */
export function setDeliverToolLookup(fn?: ToolLookup): void {
  lookupTool = fn ?? registryLookup;
}

// ---------- reading the project ----------

export interface ProjectRead {
  guard_failed?: boolean;
  project_path: string;
  saved?: boolean;
  dirty?: boolean;
  ae_version?: string;
  comp?: { id: number; name: string; width: number; height: number; fps: number; duration: number } | null;
  comp_found?: boolean | null;
  comps?: Array<{ id: number; name: string }> | null;
  render_queue?: { num_items: number; items: Array<{ index: number; comp_id: number | null; comp_name: string | null; status: string | null; outputs: Array<string | null> }> };
}

async function readProject(ctx: ToolContext, toolName: string, projectPath: string, extra: Record<string, unknown> = {}): Promise<ProjectRead> {
  const res = await ctx.bridge.callHost<ProjectRead>("deliverRead", { ...extra, expect: { project_path: projectPath } }, { label: `${toolName} (read project)`, mutates: false, toolName });
  const read = res.result;
  if (read.guard_failed) {
    throw new BridgeError({
      kind: "guard",
      op_id: ctx.bridge.newOpId(),
      message: `Target guard refused ${toolName}: expected project_path "${projectPath}", but After Effects has "${read.project_path ?? "<unsaved>"}" open. Nothing was run; stop and re-read state.`,
      expected: { project_path: projectPath },
      actual: { project_path: read.project_path ?? "<unsaved>", comp_id: null },
    });
  }
  return read;
}

const bad = (message: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: "bad_args", applied: false, message, ...extra });

// ---------- recipe tool ----------

async function availability(def: StageDef): Promise<{ available: boolean; note?: string }> {
  const invalid = validateStageDef(def);
  if (invalid) return { available: false, note: `invalid_stage: ${invalid}` };
  const tool = await lookupTool(def.tool);
  if (!tool) return { available: false, note: `${def.tool} is not registered on this server.` };
  return { available: true };
}

export async function deliverRecipe(args: AeDeliverRecipeArgs, ctx: ToolContext) {
  const project = await readProject(ctx, "ae_deliver_recipe", args.expect.project_path, args.action === "set" && args.comp_id !== undefined ? { comp_id: args.comp_id } : {});
  const projectPath = project.project_path ?? args.expect.project_path;
  let store: Store;
  try {
    store = loadStore(projectPath);
  } catch (e) {
    return unreadable(e);
  }
  const open = (name: string) => store.runs.filter((r) => r.recipe === name && r.state !== "done" && r.state !== "cancelled").map((r) => r.id);

  if (args.action === "list") {
    return {
      ok: true,
      recipes: store.recipes.map((r) => ({ name: r.name, comp_id: r.comp_id ?? null, stages: r.stages.map((s) => s.id), checkpoint_mode: r.checkpoint_mode, updated_at: r.updated_at, open_runs: open(r.name) })),
      state_file: projectPath === "<unsaved>" ? null : deliverPath(projectPath),
    };
  }
  const name = args.name!;
  const existing = store.recipes.find((r) => r.name === name);
  if (args.action === "get") {
    if (!existing) return { ok: false, error: "not_found", message: `No recipe "${name}" in this project.`, known: store.recipes.map((r) => r.name) };
    const stages = [];
    for (const s of existing.stages) stages.push({ ...s, ...(await availability(s)) });
    return { ok: true, recipe: { ...existing, stages }, open_runs: open(name) };
  }
  if (args.action === "delete") {
    if (!existing) return { ok: false, error: "not_found", applied: false, message: `No recipe "${name}" in this project.` };
    try {
      store = loadStore(projectPath);
    } catch (e) {
      return unreadable(e);
    }
    store.recipes = store.recipes.filter((r) => r.name !== name);
    const saved = saveStore(projectPath, store);
    return { ok: true, applied: true, deleted: name, kept_runs: store.runs.filter((r) => r.recipe === name).length, state_file: saved.file, ...storeNotes(projectPath, saved) };
  }

  // set: check everything before anything is written
  if (args.comp_id !== undefined && project.comp_found === false) {
    return { ok: false, error: "not_found", applied: false, message: `Comp ${args.comp_id} is not a comp in this project. Nothing was written.` };
  }
  const stages = args.stages ? normalizeStages(args.stages) : existing ? existing.stages : normalizeStages(defaultStages());
  const recipe: Recipe = {
    name,
    ...(args.comp_id !== undefined ? { comp_id: args.comp_id } : existing?.comp_id !== undefined ? { comp_id: existing.comp_id } : {}),
    checkpoint_mode: args.checkpoint_mode ?? existing?.checkpoint_mode ?? "each_write",
    ...(args.notes !== undefined ? { notes: args.notes } : existing?.notes !== undefined ? { notes: existing.notes } : {}),
    stages,
    updated_at: new Date().toISOString(),
  };
  const warnings: string[] = [];
  for (const s of stages) {
    const a = await availability(s);
    if (!a.available) warnings.push(`${s.id}: ${a.note}${s.optional ? " The run will go on without it." : " The run will stop at it until the tool exists or the stage is made optional."}`);
    if (s.kind === "render" && Object.keys(s.args).length === 0) warnings.push(`${s.id}: no args. The render stage needs its outputs (files, templates) in args, or the tool will refuse it.`);
    if (s.kind === "collect" && stagePrecheck(s)) warnings.push(`${s.id}: no args.dest. The collect stage needs the folder to copy into; the run stops at it until the recipe names one.`);
  }
  if (recipe.comp_id === undefined) warnings.push("No comp_id: stages that take a comp get none, so they use their tool's own default or refuse.");
  // Runs stepped while the tools above were looked up are in the file now: change only the recipes of the newest record.
  try {
    store = loadStore(projectPath);
  } catch (e) {
    return unreadable(e);
  }
  store.recipes = store.recipes.filter((r) => r.name !== name);
  store.recipes.push(recipe);
  const saved = saveStore(projectPath, store);
  return { ok: true, applied: true, recipe, replaced: existing !== undefined, ...(warnings.length ? { warnings } : {}), state_file: saved.file, ...storeNotes(projectPath, saved) };
}

// ---------- running stages ----------

export interface Env {
  ctx: ToolContext;
  run: Run;
  store: Store;
  saved: { file: string | null; error?: string };
}

function persist(env: Env): void {
  env.run.updated_at = new Date().toISOString();
  const projectPath = env.run.project_path;
  // Recipes changed, and other runs stepped, since this call loaded the record: write them back as they are now, with only this run replaced.
  if (projectPath !== "<unsaved>" && !unsavedStores.has(projectPath)) {
    try {
      const fresh = readStoreFile(deliverPath(projectPath));
      if (fresh) {
        const own = env.run;
        env.store.recipes = fresh.recipes;
        env.store.runs = fresh.runs.some((r) => r.id === own.id) ? fresh.runs.map((r) => (r.id === own.id ? own : r)) : [...fresh.runs, own];
      }
    } catch {
      /* the write below reports a file that cannot be used */
    }
  }
  env.saved = saveStore(projectPath, env.store);
}

function expectOf(env: Env) {
  return { project_path: env.run.project_path };
}

function fileStamp(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Errors thrown by the comp-list read in a per-output stage: a failed read, so the stage's write state stays as it was. */
const lookupErrors = new WeakSet<object>();

function setError(st: StageState, err: unknown): void {
  const d = describeError(err);
  st.status = "error";
  st.error = d.error;
  st.applied = d.applied;
  st.summary = d.message;
}

/** Builds a stage's arguments: the recipe's, the comp fills, the guard. */
export function buildStageArgs(
  def: StageDef,
  tool: ToolDefinition<any>,
  run: Pick<Run, "comp_id" | "comp_name" | "project_path">,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const info = KIND_INFO[def.kind];
  const args: Record<string, unknown> = { ...def.args };
  const withOutput = Object.keys(extra).length > 0;
  // ae_loudness_check takes exactly one of comp_id, job_id and audio_path: a stage that names its own target gets no comp.
  const ownTarget = def.kind === "loudness" && (args.audio_path !== undefined || args.job_id !== undefined);
  if (!ownTarget && (!withOutput || info.fill_with_output)) {
    const fills: Record<string, unknown> = {
      comp_id: run.comp_id,
      comp_name: run.comp_name,
      comp_ids: run.comp_id !== undefined ? [run.comp_id] : undefined,
      // ae_render_batch takes comp names
      comps: run.comp_name !== undefined ? [run.comp_name] : undefined,
    };
    for (const key of info.fill) {
      // A job names its own comp (a batch may render reframed copies of the recipe's comp): comparing it with the recipe's would fail a correct render.
      if (key === "comp_id" && def.kind === "verify" && extra.job_id !== undefined) continue;
      if (args[key] === undefined && fills[key] !== undefined && schemaAcceptsKey(tool.schema, key)) args[key] = fills[key];
    }
  }
  Object.assign(args, extra);
  // ae_collect_files defaults to a dry run, which copies nothing: a delivery stage means to copy.
  if (def.kind === "collect" && args.dry_run === undefined && schemaAcceptsKey(tool.schema, "dry_run")) args.dry_run = false;
  if (schemaAcceptsKey(tool.schema, "expect")) args.expect = { project_path: run.project_path };
  if (def.kind === "checkpoint" && args.label === undefined) args.label = "deliver";
  return args;
}

/** Runs one tool for a stage (or one output of it) and says what its result means. */
async function invoke(env: Env, tool: ToolDefinition<any>, def: StageDef, extra: Record<string, unknown> = {}): Promise<{ outcome: Classified; raw: unknown }> {
  const precheck = stagePrecheck(def);
  if (precheck) return { outcome: { status: "blocked", summary: precheck, findings: [] }, raw: null };
  const args = buildStageArgs(def, tool, env.run, extra);
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "args"}: ${i.message}`)
      .join("; ");
    return { outcome: { status: "blocked", summary: `${def.tool} rejects the stage's arguments (${clip(why, 300)}). Fix them in the recipe and retry.`, findings: [] }, raw: null };
  }
  let raw: any = await tool.handler(parsed.data, env.ctx);
  // The preflight reads in slices: follow its cursor so the gate covers the whole project.
  if (def.kind === "preflight") {
    for (let i = 0; i < MAX_PREFLIGHT_CALLS && raw && typeof raw === "object" && typeof raw.cursor === "string" && raw.complete === false; i++) {
      // max_slices and budget_ms are the only options a continued scan takes anew: keep the recipe's limits on every call.
      const limits: Record<string, unknown> = {};
      for (const k of ["max_slices", "budget_ms"]) if (def.args[k] !== undefined) limits[k] = def.args[k];
      const next = tool.schema.safeParse({ ...limits, cursor: raw.cursor });
      if (!next.success) break;
      raw = await tool.handler(next.data, env.ctx);
    }
  }
  // The collect copies for max_seconds per call and says so when it stopped early: ask again, as it tells us to.
  if (def.kind === "collect") {
    // The zip is written in the background after a complete copy: asking again returns its result.
    const again = (x: any) =>
      x && typeof x === "object" && ((x.complete === false && !(x.errors_total > 0) && x.remaining > 0) || (x.complete === true && x.zip && typeof x.zip === "object" && x.zip.ok === false && x.zip.status === "running"));
    for (let i = 1; i < MAX_COLLECT_CALLS && again(raw); i++) {
      raw = await tool.handler(parsed.data, env.ctx);
    }
  }
  let outcome = applyFailOn(classifyStageResult(def.kind, raw), def);
  if (raw && typeof raw === "object" && raw.applied === true && outcome.applied === undefined) outcome = { ...outcome, applied: true };
  return { outcome, raw };
}

/** Takes the checkpoint before a stage. Returns true when the stage must not run. */
async function maybeCheckpoint(env: Env, st: StageState): Promise<boolean> {
  const def = st.def;
  if (!checkpointDue(env.run.checkpoint_mode, def, env.run.checkpoints_taken)) return false;
  if (env.run.project_path === "<unsaved>") {
    st.checkpoint = { status: "skipped", note: "The project is unsaved: there is no file to copy." };
    return false;
  }
  const stamp = fileStamp(env.run.project_path);
  if (stamp !== null && env.run.last_checkpoint?.stamp === stamp) {
    st.checkpoint = { status: "reused", path: env.run.last_checkpoint.path, note: "The saved file hasn't changed since the last checkpoint." };
    env.run.checkpoints_taken++;
    return false;
  }
  const tool = await lookupTool("ae_checkpoint_create");
  if (!tool) {
    st.checkpoint = { status: "unavailable", note: "ae_checkpoint_create is not registered; this stage runs without a checkpoint." };
    return false;
  }
  try {
    const parsed = tool.schema.safeParse({ expect: expectOf(env), label: `deliver ${st.id}`.slice(0, 80) });
    if (!parsed.success) throw new Error("ae_checkpoint_create rejected its arguments");
    const r: any = await tool.handler(parsed.data, env.ctx);
    if (r && typeof r === "object" && (r.ok === false || typeof r.error === "string")) throw new Error(clip(r.message ?? r.error));
    const p = typeof r?.checkpoint_path === "string" ? r.checkpoint_path : undefined;
    st.checkpoint = { status: "created", ...(p ? { path: p } : {}) };
    env.run.checkpoints_taken++;
    if (stamp !== null) env.run.last_checkpoint = { stamp, path: p };
    return false;
  } catch (err) {
    // No checkpoint means no way back: the stage that would write does not run.
    setError(st, err);
    st.applied = false;
    st.summary = `The checkpoint before this stage failed, so the stage did not run: ${st.summary}`;
    return true;
  }
}

async function runPerOutput(env: Env, st: StageState, tool: ToolDefinition<any>): Promise<void> {
  const def = st.def;
  const info = KIND_INFO[def.kind];
  const outputs = env.run.outputs;
  if (outputs.length === 0) {
    if (info.no_output === "comp") {
      const { outcome } = await invoke(env, tool, def);
      Object.assign(st, { status: outcome.status, summary: `no render files to check; ran on the comp: ${outcome.summary}`, findings: outcome.findings });
      return;
    }
    const why = "The render stage reported no output files, so there is nothing to check. Give the render stage args that name its outputs, or this stage args.path.";
    Object.assign(st, { status: info.no_output === "blocked" ? "blocked" : "warn", summary: why, findings: [] });
    return;
  }
  const children: ChildState[] = [];
  const findings: Finding[] = [];
  let unverified = false;
  // name -> comp ids, read once when a file of another comp than the recipe's has to be verified by path
  let compsByName: Map<string, number[]> | undefined;
  let compsCut = false;
  let inLookup = false;
  for (const out of outputs.slice(0, MAX_OUTPUTS)) {
    const extra = outputArgsFor(def.kind, out);
    if (!extra) {
      children.push({ output: outputLabel(out), status: "skipped", summary: "an image-sequence pattern has no single file for this tool" });
      continue;
    }
    // One output failing to run is that output's result; the others still run, then the stage reports the worst.
    try {
      // A file by path is compared with the comp it was rendered from, which a reframed copy makes another comp than the recipe's.
      if (def.kind === "verify" && def.args.comp_id === undefined && extra.job_id === undefined && out.comp !== undefined && out.comp !== env.run.comp_name) {
        if (!compsByName) {
          inLookup = true;
          const read = await readProject(env.ctx, "ae_deliver_step", env.run.project_path, { list_comps: true });
          inLookup = false;
          compsCut = (read as { truncated?: boolean }).truncated === true;
          compsByName = new Map();
          for (const c of read.comps ?? []) compsByName.set(c.name, [...(compsByName.get(c.name) ?? []), c.id]);
        }
        const ids = compsByName.get(out.comp) ?? [];
        if (ids.length !== 1) {
          children.push({
            output: outputLabel(out),
            status: "blocked",
            summary: clip(`unchecked: it was rendered from comp "${out.comp}", which ${ids.length === 0 ? (compsCut ? "was not found in the comp list, which the host cut short" : "is not in the project") : "has several comps of that name"}. Set args.comp_id on the verify stage or check the file by hand.`, 300),
          });
          continue;
        }
        extra.comp_id = ids[0];
      }
      const { outcome } = await invoke(env, tool, def, extra);
      children.push({ output: outputLabel(out), status: outcome.status, summary: clip(outcome.summary, 300) });
      findings.push(...outcome.findings);
      if (outcome.unverified) unverified = true;
      if (outcome.applied) st.applied = true;
    } catch (err) {
      const d = describeError(err);
      const lookupFailed = inLookup;
      inLookup = false;
      children.push({ output: outputLabel(out), status: "blocked", summary: clip(`${d.error}: ${d.message}`, 300) });
      // The tool's import may have happened before it failed: the stage is not run again blindly.
      // (a failed comp lookup is a read: nothing was written)
      if (d.applied === "unknown" && !lookupFailed && st.applied !== true) st.applied = "unknown";
      // A lost bridge or a guard failure is not one file's problem.
      if ((err instanceof BridgeError && err.kind !== "evalscript_error") || err instanceof QuarantineBlockedError || err instanceof QueueWaitError) {
        if (lookupFailed && typeof err === "object" && err !== null) lookupErrors.add(err);
        st.children = children;
        if (unverified) st.error = "read_back_failed";
        throw err;
      }
    }
  }
  const worst = worstOf(children.map((c) => c.status));
  const counts = ["ok", "warn", "blocked", "skipped"].map((k) => [k, children.filter((c) => c.status === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ");
  st.children = children;
  st.findings = findings.slice(0, MAX_FINDINGS);
  st.status = worst === "blocked" ? "blocked" : worst;
  st.summary = `${children.length} output${children.length === 1 ? "" : "s"}: ${counts}`;
  if (def.fail_on === "warning" && st.status === "warn") {
    st.status = "blocked";
    st.summary += " (this stage stops on warnings)";
  }
  if (unverified) st.error = "read_back_failed";
  if (children.every((c) => c.status === "skipped")) {
    st.status = "warn";
    st.summary = "None of the outputs can be opened by path (image-sequence patterns).";
  }
}

/** A stage that names its own file or comp is not run once per rendered file. */
function hasOwnTarget(def: StageDef): boolean {
  if (def.args.path !== undefined || def.args.job_id !== undefined) return true;
  // scrub takes comp_id or path, never both; verify compares a file with a comp, so comp_id goes with each file
  return !KIND_INFO[def.kind].fill_with_output && def.args.comp_id !== undefined;
}

async function execute(env: Env, st: StageState, tool: ToolDefinition<any>): Promise<void> {
  const def = st.def;
  if (def.per_output && !hasOwnTarget(def) && KIND_INFO[def.kind].output_keys.length > 0) {
    await runPerOutput(env, st, tool);
    return;
  }
  const { outcome, raw } = await invoke(env, tool, def);
  st.status = outcome.status;
  st.summary = outcome.summary;
  st.findings = outcome.findings;
  if (outcome.applied) st.applied = true;
  if (outcome.unverified) st.error = "read_back_failed";
  if (def.kind === "loudness" && outcome.running && raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).job_id === "string") {
    // The audio render outlasted the tool's wait: follow its job like a render.
    st.status = "running";
    st.job_ids = [(raw as Record<string, string>).job_id];
    st.live = true;
    st.summary = "The audio is rendering; next checks it.";
    return;
  }
  if (def.kind === "render" && outcome.status !== "blocked") {
    const jobs = extractJobIds(raw);
    const outs = extractOutputs(raw);
    const batchId = extractBatchId(raw);
    if (batchId !== undefined) {
      // ae_render_batch renders in the background: its items are not files yet. They are read when the batch has finished.
      st.status = "running";
      st.batch_id = batchId;
      st.live = true;
      st.summary = `started render batch ${batchId}`;
      env.run.outputs = [];
    } else if (jobs.length > 0) {
      st.status = "running";
      st.job_ids = jobs;
      st.live = true;
      st.summary = `started ${jobs.length} render job${jobs.length === 1 ? "" : "s"}`;
      env.run.outputs = jobs.map((j) => outs.find((o) => o.job_id === j) ?? { job_id: j });
    } else if (outs.length > 0) {
      env.run.outputs = outs;
    } else {
      st.status = "warn";
      st.summary = `${outcome.summary} The render reported no job ids or output files, so verify, scrub and loudness have no file to check unless their args name one.`;
    }
  }
}

async function runStage(env: Env, st: StageState): Promise<void> {
  const def = st.def;
  st.attempts++;
  st.started_at = new Date().toISOString();
  for (const k of ["summary", "findings", "children", "error", "applied", "checkpoint", "finished_at", "job_ids", "batch_id", "live"] as const) delete st[k];
  // A recipe file is not trusted: a stage runs only the tools its kind lists, whoever wrote the file.
  const invalid = validateStageDef(def);
  if (invalid) {
    Object.assign(st, { status: "blocked", error: "invalid_stage", applied: false, summary: `invalid_stage: ${clip(invalid, 300)} The stage was not run. Fix the recipe with ae_deliver_recipe and retry.` });
    st.finished_at = new Date().toISOString();
    return;
  }
  const tool = await lookupTool(def.tool);
  if (!tool) {
    st.status = "unavailable";
    st.summary = `${def.tool} is not registered on this server${def.optional ? "; this stage is optional, so the run goes on." : "; the run stops here until the tool exists or the stage is made optional."}`;
    st.finished_at = new Date().toISOString();
    return;
  }
  // Marked before anything runs, so a crash leaves a record saying the stage may be half done.
  st.status = "in_flight";
  persist(env);
  try {
    if (await maybeCheckpoint(env, st)) {
      st.finished_at = new Date().toISOString();
      return;
    }
    await execute(env, st, tool);
  } catch (err) {
    // An earlier output's write that reached the project (or could not be confirmed) is not forgotten because a later one threw.
    const keptUnverified = st.error === "read_back_failed";
    const keptApplied = st.applied;
    setError(st, err);
    if (keptUnverified) st.error = "read_back_failed";
    // a failed comp-list read wrote nothing: the write state is what it was before
    if (typeof err === "object" && err !== null && lookupErrors.has(err)) st.applied = keptApplied;
    // true beats "unknown", which beats false
    if (keptApplied === true) st.applied = true;
    else if (keptApplied === "unknown" && st.applied !== true) st.applied = "unknown";
  }
  st.finished_at = new Date().toISOString();
}

/** Looks at the background job a render or loudness stage started. */
async function pollRender(env: Env, st: StageState): Promise<void> {
  // A stage that stopped on a failed look, or on a failed render, is looked at again from the running state.
  st.status = "running";
  delete st.error;
  if (st.kind === "loudness") return pollLoudness(env, st);
  if (st.batch_id) return pollBatch(env, st);
  return pollJobs(env, st);
}

/** Follows the audio render behind a loudness check until the tool gives a verdict. */
async function pollLoudness(env: Env, st: StageState): Promise<void> {
  const tool = await lookupTool(st.def.tool);
  const jobId = st.job_ids?.[0];
  if (!tool || !jobId) {
    Object.assign(st, { status: "error", error: "unavailable", summary: `${st.def.tool} is not registered, so the audio render can't be followed. Skip this stage with an acknowledgement if Jay agrees.` });
    return;
  }
  const args: Record<string, unknown> = { job_id: jobId, wait_seconds: 10 };
  for (const k of ["standard", "target_lufs", "true_peak_max_db", "tolerance_lu"]) if (st.def.args[k] !== undefined) args[k] = st.def.args[k];
  try {
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new Error(`${st.def.tool} rejected the job id`);
    const raw: any = await tool.handler(parsed.data, env.ctx);
    const outcome = applyFailOn(classifyStageResult("loudness", raw), st.def);
    if (outcome.running) {
      st.summary = "The audio is still rendering.";
      return;
    }
    st.live = false;
    st.status = outcome.status;
    st.summary = outcome.summary;
    st.findings = outcome.findings;
    st.finished_at = new Date().toISOString();
  } catch (err) {
    Object.assign(st, { status: "error", error: "job_unknown", summary: clip(`Could not read the audio render ${jobId}: ${describeError(err).message}. Check it with ${st.def.tool} (job_id), then retry or skip.`, 400) });
  }
}

/** Follows an ae_render_batch batch; when it has finished, its items become the run's outputs. */
async function pollBatch(env: Env, st: StageState): Promise<void> {
  const batchId = st.batch_id as string;
  const status = await lookupTool("ae_render_batch_status");
  if (!status) {
    Object.assign(st, { status: "error", error: "unavailable", summary: "ae_render_batch_status is not registered, so the render batch can't be followed. Check the batch by hand, then skip this stage with an acknowledgement." });
    return;
  }
  let r: any;
  try {
    const parsed = status.schema.safeParse({ batch_id: batchId });
    if (!parsed.success) throw new Error("ae_render_batch_status rejected the batch id");
    r = await status.handler(parsed.data, env.ctx);
  } catch (err) {
    Object.assign(st, { status: "error", error: "job_unknown", summary: clip(`Could not read render batch ${batchId}: ${describeError(err).message}. Check it with ae_render_batch_status.`, 400) });
    return;
  }
  if (r === null || typeof r !== "object" || r.ok === false) {
    const why = r && typeof r === "object" && typeof r.message === "string" ? r.message : "no answer";
    Object.assign(st, { status: "error", error: "job_unknown", summary: clip(`Could not read render batch ${batchId}: ${why}`, 400) });
    return;
  }
  const items: any[] = Array.isArray(r.items) ? r.items : [];
  const itemStatus = (state: unknown): ChildState["status"] => {
    if (state === "failed" || state === "cancelled") return "blocked";
    if (state === "skipped") return "warn";
    return "ok";
  };
  st.children = items.slice(0, MAX_OUTPUTS).map((i) => ({
    output: typeof i?.output_path === "string" ? i.output_path : `item ${String(i?.index)}`,
    status: itemStatus(i?.state),
    summary: clip(`${String(i?.state)}${typeof i?.percent === "number" ? ` ${Math.round(i.percent)}%` : ""}${typeof i?.error === "string" ? `: ${i.error}` : ""}`, 300),
  }));
  const done = items.filter((i) => i?.state === "succeeded").length;
  const failedItems = items.filter((i) => i?.state === "failed" || i?.state === "cancelled");
  const state = String(r.state);
  if (state === "running") {
    st.live = true;
    const pct = items.filter((i) => i?.state === "running" && typeof i.percent === "number").map((i) => i.percent as number);
    st.summary = `${done} of ${items.length} render item${items.length === 1 ? "" : "s"} finished${pct.length ? ` (running at ${Math.round(pct.reduce((a, b) => a + b, 0) / pct.length)}%)` : ""}${failedItems.length ? `, ${failedItems.length} failed` : ""}`;
    if (r.runner_active === false) st.summary += ". This server is not driving the batch (it restarted): call ae_render_batch_resume, then next";
    return;
  }
  st.live = r.runner_active === true;
  if (state === "succeeded") {
    const outs = batchOutputs(items);
    const skipped = items.filter((i) => i?.state === "skipped").length;
    env.run.outputs = outs;
    st.job_ids = items.map((i) => i?.job_id).filter((j): j is string => typeof j === "string").slice(0, MAX_OUTPUTS);
    if (outs.length === 0) {
      Object.assign(st, { status: "warn", summary: "The batch finished but none of its items produced a file, so verify, scrub and loudness have nothing to check unless their args name one." });
    } else if (skipped > 0) {
      Object.assign(st, { status: "warn", summary: `${items.length} render item${items.length === 1 ? "" : "s"} finished; ${skipped} stood on a file that already existed (if_output_exists), so it was not rendered now` });
    } else {
      Object.assign(st, { status: "ok", summary: `${items.length} render item${items.length === 1 ? "" : "s"} finished` });
    }
    st.finished_at = new Date().toISOString();
    return;
  }
  // failed, stopped or cancelled: the files that did render stay the run's outputs, so a skip with an acknowledgement goes on with them
  env.run.outputs = batchOutputs(items);
  const first = failedItems[0];
  const detail = first ? ` Item ${String(first.index)} (${String(first.comp ?? "")}/${String(first.spec ?? "")}): ${String(first.error ?? first.state)}.` : "";
  const tail = " Fix the cause, then call ae_render_batch_resume and ae_deliver_step next; retry is refused for a batch (a new one would treat these files as someone else's recent files).";
  Object.assign(st, {
    status: "blocked",
    error: state === "failed" ? "render_failed" : "batch_stopped",
    summary: clip(`Render batch ${batchId} ${state}.${detail}${tail}`, 600),
  });
}

/** Follows the aerender jobs a render stage started. */
async function pollJobs(env: Env, st: StageState): Promise<void> {
  const status = await lookupTool("ae_aerender_status");
  if (!status) {
    Object.assign(st, { status: "error", error: "unavailable", summary: "ae_aerender_status is not registered, so the render can't be followed. Check the jobs by hand, then skip this stage with an acknowledgement." });
    return;
  }
  const states: Array<{ job_id: string; state: string; percent?: number; output_path?: string; exit_code?: unknown; log_tail?: string; error?: string }> = [];
  for (const id of st.job_ids ?? []) {
    try {
      const parsed = status.schema.safeParse({ job_id: id });
      if (!parsed.success) throw new Error("ae_aerender_status rejected the job id");
      const r: any = await status.handler(parsed.data, env.ctx);
      states.push({ job_id: id, state: String(r?.state ?? "unknown"), percent: typeof r?.percent === "number" ? r.percent : undefined, output_path: typeof r?.output_path === "string" ? r.output_path : undefined, exit_code: r?.exit_code, log_tail: typeof r?.log_tail === "string" ? r.log_tail : undefined });
    } catch (err) {
      states.push({ job_id: id, state: "unknown", error: describeError(err).message });
    }
  }
  for (const s of states) {
    if (s.output_path) {
      const o: OutputRef = { job_id: s.job_id, path: s.output_path, ...(SEQUENCE_PATTERN.test(s.output_path) ? { sequence: true } : {}) };
      const at = env.run.outputs.findIndex((x) => x.job_id === s.job_id);
      if (at >= 0) env.run.outputs[at] = o;
      else env.run.outputs.push(o);
    }
  }
  const failed = states.filter((s) => s.state === "failed");
  const unknown = states.filter((s) => s.state === "unknown");
  const running = states.filter((s) => s.state === "running");
  // Jobs that are running (or unreadable) may still be writing their files.
  st.live = running.length > 0 || unknown.length > 0;
  st.children = states.map((s) => ({
    output: s.output_path ?? s.job_id,
    status: s.state === "succeeded" ? "ok" : s.state === "running" ? "ok" : "blocked",
    summary: s.error ?? `${s.state}${s.percent !== undefined ? ` ${Math.round(s.percent)}%` : ""}`,
  }));
  if (failed.length > 0) {
    const f = failed[0];
    Object.assign(st, { status: "blocked", error: "render_failed", summary: clip(`Render job ${f.job_id} failed (exit code ${String(f.exit_code)}). ${f.log_tail ? `Log tail: ${f.log_tail}` : ""}`, 600) });
  } else if (unknown.length > 0) {
    Object.assign(st, { status: "error", error: "job_unknown", summary: clip(`Could not read render job ${unknown[0].job_id}: ${unknown[0].error ?? "unknown state"}. Check it by hand.`, 400) });
  } else if (running.length > 0) {
    const pct = running.map((s) => s.percent).filter((p): p is number => typeof p === "number");
    st.summary = `${running.length} of ${states.length} render job${states.length === 1 ? "" : "s"} still running${pct.length ? ` (${Math.round(pct.reduce((a, b) => a + b, 0) / pct.length)}%)` : ""}`;
  } else {
    st.status = "ok";
    st.summary = `${states.length} render job${states.length === 1 ? "" : "s"} finished`;
    st.finished_at = new Date().toISOString();
  }
}

/** Runs stages until one blocks, waits or the budget is used. */
export async function advance(env: Env, maxStages: number): Promise<void> {
  let ran = 0;
  for (;;) {
    const st = currentStage(env.run);
    if (!st) break;
    if (isPollable(st)) {
      await pollRender(env, st);
      persist(env);
      if (!passes(st)) break;
      continue;
    }
    if (st.status !== "pending") break;
    if (ran >= maxStages) break;
    await runStage(env, st);
    ran++;
    persist(env);
    if (!passes(st)) break;
  }
  env.run.state = deriveState(env.run);
  const cur = currentStage(env.run);
  if (env.run.state === "blocked" && cur) env.run.stop_reason = `Stage "${cur.id}": ${cur.status}${cur.summary ? ` - ${cur.summary}` : ""}`;
  else delete env.run.stop_reason;
  persist(env);
}

// ---------- step tool ----------

/** The per-file rows of a stage, with the problems first when there are more than fit. */
function boundedChildren(children: ChildState[]): ChildState[] {
  if (children.length <= MAX_SHOWN) return children;
  const rank = (c: ChildState) => (c.status === "blocked" ? 0 : c.status === "warn" ? 1 : 2);
  return children
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, MAX_SHOWN)
    .map((x) => x.c);
}

function stageRow(s: StageState) {
  return {
    id: s.id,
    kind: s.kind,
    tool: s.tool,
    status: s.status,
    ...(s.summary ? { summary: s.summary } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.applied !== undefined ? { applied: s.applied } : {}),
    ...(s.findings && s.findings.length ? { findings: s.findings } : {}),
    ...(s.children && s.children.length ? { outputs: boundedChildren(s.children) } : {}),
    ...(s.children && s.children.length > MAX_SHOWN ? { outputs_total: s.children.length } : {}),
    ...(s.job_ids ? { job_ids: s.job_ids.slice(0, MAX_SHOWN) } : {}),
    ...(s.batch_id ? { batch_id: s.batch_id } : {}),
    ...(s.checkpoint ? { checkpoint: s.checkpoint } : {}),
    ...(s.acknowledged ? { acknowledged: s.acknowledged } : {}),
    attempts: s.attempts,
  };
}

function present(env: Env, extra: Record<string, unknown> = {}) {
  const run = env.run;
  const cur = currentStage(run);
  const blocked = run.state === "blocked";
  return {
    ok: !blocked,
    ...(blocked ? { error: "delivery_blocked" } : {}),
    run_id: run.id,
    recipe: run.recipe,
    state: run.state,
    summary: summarizeStages(run.stages),
    ...(cur ? { stopped_at: cur.id } : {}),
    ...(run.stop_reason ? { message: run.stop_reason } : {}),
    stages: run.stages.map(stageRow),
    outputs: run.outputs.slice(0, MAX_SHOWN * 2),
    ...(run.outputs.length > MAX_SHOWN * 2 ? { outputs_total: run.outputs.length } : {}),
    next: nextHint(run),
    ...(run.state === "done" || blocked ? { report: renderReport(run) } : {}),
    state_file: env.saved.file,
    ...storeNotes(run.project_path, env.saved),
    ...extra,
  };
}

function findRun(store: Store, runId: string | undefined): Run | undefined {
  if (runId !== undefined) return store.runs.find((r) => r.id === runId);
  for (let i = store.runs.length - 1; i >= 0; i--) {
    const r = store.runs[i];
    if (r.state !== "done" && r.state !== "cancelled") return r;
  }
  return undefined;
}

export async function deliverStep(args: AeDeliverStepArgs, ctx: ToolContext) {
  ctx.quarantine.assertClear();
  const wantComp = args.action === "start";
  let recipeForComp: Recipe | undefined;
  if (args.action === "start") {
    try {
      recipeForComp = loadStore(args.expect.project_path).recipes.find((r) => r.name === args.recipe);
    } catch (e) {
      return unreadable(e);
    }
  }
  const project = await readProject(ctx, "ae_deliver_step", args.expect.project_path, { ...(wantComp && recipeForComp?.comp_id !== undefined ? { comp_id: recipeForComp.comp_id } : {}) });
  const projectPath = project.project_path ?? args.expect.project_path;
  let store: Store;
  try {
    store = loadStore(projectPath);
  } catch (e) {
    return unreadable(e);
  }
  const maxStages = args.max_stages ?? MAX_STAGES;

  // ----- start -----
  if (args.action === "start") {
    const recipe = store.recipes.find((r) => r.name === args.recipe);
    if (!recipe) return { ok: false, error: "not_found", applied: false, message: `No recipe "${args.recipe}" in this project. Make one with ae_deliver_recipe (action 'set').`, known: store.recipes.map((r) => r.name) };
    if (recipe.comp_id !== undefined && project.comp_found === false) {
      return { ok: false, error: "not_found", applied: false, message: `The recipe's comp ${recipe.comp_id} is not a comp in this project any more. Update the recipe. Nothing was run.` };
    }
    const openRun = store.runs.find((r) => r.recipe === recipe.name && r.state !== "done" && r.state !== "cancelled");
    if (openRun && !args.dry_run) {
      return { ok: false, error: "run_open", applied: false, run_id: openRun.id, message: `Run ${openRun.id} of "${recipe.name}" is still open (${openRun.state}). Continue it with 'next', or end it with 'cancel', before starting another.` };
    }
    const run: Run = {
      id: newRunId(),
      recipe: recipe.name,
      ...(recipe.comp_id !== undefined ? { comp_id: recipe.comp_id } : {}),
      ...(project.comp ? { comp_name: project.comp.name } : {}),
      project_path: projectPath,
      ...(project.ae_version ? { ae_version: project.ae_version } : {}),
      checkpoint_mode: recipe.checkpoint_mode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      state: "in_progress",
      stages: recipe.stages.map((def) => ({ id: def.id, kind: def.kind, tool: def.tool, def: JSON.parse(JSON.stringify(def)) as StageDef, status: "pending" as StageStatus, attempts: 0 })),
      outputs: [],
      checkpoints_taken: 0,
    };
    if (args.dry_run) {
      const plan = [];
      let plannedCheckpoints = 0;
      for (const s of run.stages) {
        const invalid = validateStageDef(s.def);
        if (invalid) {
          plan.push({ id: s.id, kind: s.kind, tool: s.tool, available: false, valid: false, stops_run_if_unavailable: true, args_valid: false, args_note: `invalid_stage: ${invalid}` });
          continue;
        }
        const tool = await lookupTool(s.tool);
        let argsOk: boolean | "deferred" = "deferred";
        let argsNote: string | undefined;
        const waitsForOutput = s.def.per_output && !hasOwnTarget(s.def) && KIND_INFO[s.kind].output_keys.length > 0;
        const precheck = stagePrecheck(s.def);
        if (precheck) {
          argsOk = false;
          argsNote = precheck;
        } else if (tool && !waitsForOutput) {
          const parsed = tool.schema.safeParse(buildStageArgs(s.def, tool, run));
          argsOk = parsed.success;
          if (!parsed.success) argsNote = parsed.error.issues.slice(0, 2).map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
        }
        const planCheckpoint = () => {
          const due = checkpointDue(run.checkpoint_mode, s.def, plannedCheckpoints);
          if (due) plannedCheckpoints++;
          return due;
        };
        plan.push({
          id: s.id,
          kind: s.kind,
          tool: s.tool,
          available: tool !== undefined,
          stops_run_if_unavailable: !s.def.optional,
          args_valid: argsOk,
          ...(argsNote ? { args_note: argsNote } : {}),
          per_output: s.def.per_output,
          checkpoint_before: planCheckpoint(),
          fail_on: s.def.fail_on,
        });
      }
      return { ok: true, dry_run: true, applied: false, recipe: recipe.name, comp: project.comp ?? null, project_dirty: project.dirty ?? null, stages: plan, note: "Nothing was run or written. Arguments of per-output stages are checked when the render's files are known." };
    }
    store.runs.push(run);
    const env: Env = { ctx, run, store, saved: { file: null } };
    persist(env);
    return await drive(env, maxStages);
  }

  // ----- the other actions work on an existing run -----
  const run = findRun(store, args.run_id);
  if (!run) {
    return { ok: false, error: "unknown_run", applied: false, message: args.run_id ? `No run ${args.run_id} for this project.` : "No open run for this project. Start one with action 'start'." };
  }
  if (!pathsEqual(run.project_path, projectPath)) {
    return { ok: false, error: "wrong_project", applied: false, message: `Run ${run.id} belongs to ${run.project_path}, but ${projectPath} is open.` };
  }
  if (activeRuns.has(run.id)) return { ok: false, error: "run_busy", applied: false, message: `Run ${run.id} is executing a stage right now.` };
  const env: Env = { ctx, run, store, saved: { file: null } };

  // A stage left in flight was running when AE or the panel died: it may be half done, so it is reported, not run again.
  for (const s of run.stages) {
    if (s.status === "in_flight") {
      Object.assign(s, { status: "error", error: "interrupted", applied: "unknown", summary: "The stage was running when the run was interrupted (AE or the panel may have crashed). It may be fully, partly or not applied: inspect the project, then retry or skip it." });
    }
  }

  if (run.state === "cancelled") {
    return { ok: false, error: "run_cancelled", applied: false, run_id: run.id, message: "This run was cancelled. Start a new one with action 'start'." };
  }

  if (args.action === "cancel") {
    const notes: string[] = [];
    for (const s of run.stages) {
      // A stage that stopped on a failed look may still have jobs running: they are cancelled too.
      if (s.status !== "running" && s.live !== true) continue;
      if (s.batch_id) {
        try {
          const cancelBatch = await lookupTool("ae_render_batch_cancel");
          if (!cancelBatch) throw new Error("ae_render_batch_cancel is not registered");
          const parsed = cancelBatch.schema.safeParse({ batch_id: s.batch_id });
          if (!parsed.success) throw new Error("rejected the batch id");
          const answer: any = await cancelBatch.handler(parsed.data, ctx);
          const unconfirmed = answer && typeof answer === "object" && Array.isArray(answer.kill_unconfirmed) ? answer.kill_unconfirmed.length : 0;
          if (answer && typeof answer === "object" && answer.cancelled === true && unconfirmed > 0) {
            notes.push(`render batch ${s.batch_id} is cancelled, but ${unconfirmed} aerender process(es) could not be confirmed stopped and may still be writing; check them with ae_render_batch_status, then ae_aerender_cancel or stop them by hand`);
          } else if (answer && typeof answer === "object" && answer.cancelled === true) notes.push(`cancelled render batch ${s.batch_id}`);
          else if (answer && typeof answer === "object" && answer.already_finished === true) notes.push(`render batch ${s.batch_id} had already finished (${String(answer.state)}); nothing to cancel`);
          else if (answer && typeof answer === "object" && answer.ok === false) notes.push(`render batch ${s.batch_id} was not cancelled: ${String(answer.error ?? "refused")}${typeof answer.message === "string" ? ` (${clip(answer.message, 200)})` : ""}`);
          else notes.push(`render batch ${s.batch_id}: ae_render_batch_cancel did not say it cancelled anything; check it with ae_render_batch_status`);
        } catch (err) {
          notes.push(`could not cancel render batch ${s.batch_id}: ${describeError(err).message}`);
        }
      } else {
        const cancel = await lookupTool("ae_aerender_cancel");
        for (const id of s.job_ids ?? []) {
          try {
            if (!cancel) throw new Error("ae_aerender_cancel is not registered");
            const parsed = cancel.schema.safeParse({ job_id: id });
            if (!parsed.success) throw new Error("rejected the job id");
            const answer: any = await cancel.handler(parsed.data, ctx);
            if (answer && typeof answer === "object" && answer.kill_unconfirmed === true) {
              notes.push(`render job ${id} could not be confirmed stopped and may still be writing; check it with ae_aerender_status, or stop the process by hand`);
            } else if (answer && typeof answer === "object" && answer.already_finished === true) {
              notes.push(`render job ${id} had already finished (${String(answer.state)}); nothing to cancel`);
            } else {
              notes.push(`cancelled render job ${id}`);
            }
          } catch (err) {
            notes.push(`could not cancel render job ${id}: ${describeError(err).message}`);
          }
        }
      }
      Object.assign(s, { status: "skipped", live: false, summary: "cancelled with the run" });
    }
    run.state = "cancelled";
    run.stop_reason = "Cancelled.";
    persist(env);
    return present(env, { ok: true, cancel_notes: notes });
  }

  const stopped = currentStage(run);
  if (!stopped) {
    run.state = "done";
    persist(env);
    return present(env, { ok: true, note: "Every stage has passed already." });
  }

  if (args.action === "retry" || args.action === "skip") {
    if (args.stage !== undefined && args.stage !== stopped.id) {
      return { ok: false, error: "wrong_stage", applied: false, run_id: run.id, message: `The run is at stage "${stopped.id}", not "${args.stage}". Only the stopped stage can be retried or skipped; to redo an earlier one, start a new run.` };
    }
    if (stopped.status === "running") {
      return { ok: false, error: "still_running", applied: false, run_id: run.id, message: `Stage "${stopped.id}" is still running. Use 'next' to follow it or 'cancel' to end the run.` };
    }
    if (stopped.status === "pending") {
      return { ok: false, error: "not_stopped", applied: false, run_id: run.id, message: `Stage "${stopped.id}" has not run yet. Use 'next'.` };
    }
  }
  if (args.action === "retry") {
    // A second render would start new jobs while the old ones may still be writing the same files.
    if (stopped.live === true && (stopped.batch_id || (stopped.job_ids && stopped.job_ids.length > 0))) {
      return {
        ok: false,
        error: "jobs_may_be_running",
        applied: false,
        run_id: run.id,
        message: `Stage "${stopped.id}" started background jobs that may still be running. Use 'next' to look at them again, or 'cancel' to end the run and its jobs, before starting them again.`,
      };
    }
    // A render batch is continued with ae_render_batch_resume: a new batch would see the files the old one wrote as someone else's recent files.
    if (stopped.kind === "render" && stopped.batch_id) {
      return {
        ok: false,
        error: "use_resume",
        applied: false,
        run_id: run.id,
        message: `Stage "${stopped.id}" follows render batch ${stopped.batch_id}. Call ae_render_batch_resume (it keeps the items that finished and runs the rest), then 'next'. A new batch would treat the files this one wrote as someone else's recent files. To give up on it, 'cancel' the run, or 'skip' the stage with an acknowledgement.`,
      };
    }
    // A write that reached the project, or may have, and could not be confirmed is not repeated blindly.
    if ((stopped.error === "read_back_failed" || stopped.applied === "unknown" || (stopped.applied === true && stopped.kind !== "render")) && !REPEATABLE_KINDS.has(stopped.kind)) {
      return {
        ok: false,
        error: "unverified_write",
        applied: false,
        run_id: run.id,
        message: `Stage "${stopped.id}" changed the project, or may have, and its result could not be confirmed, so running it again could do it twice (an imported check item may still be in the project). Inspect the project, then 'skip' it with an acknowledgement, or 'cancel' the run.`,
      };
    }
  }

  if (args.action === "skip") {
    stopped.acknowledged = args.acknowledge;
    stopped.summary = `skipped (was ${stopped.status}${stopped.summary ? `: ${clip(stopped.summary, 200)}` : ""})`;
    stopped.status = "skipped";
    stopped.finished_at = new Date().toISOString();
    persist(env);
    return await drive(env, maxStages);
  }

  if (args.action === "retry") {
    // The recipe may have been fixed since the run began: this stage takes its current definition.
    const current = store.recipes.find((r) => r.name === run.recipe)?.stages.find((d) => d.id === stopped.id && d.kind === stopped.kind);
    if (current) {
      stopped.def = JSON.parse(JSON.stringify(current)) as StageDef;
      stopped.tool = current.tool;
    }
    stopped.status = "pending";
  }

  // next (and retry, after it reset the stage)
  return await drive(env, maxStages);
}

function pathsEqual(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
}

async function drive(env: Env, maxStages: number) {
  activeRuns.add(env.run.id);
  try {
    await advance(env, maxStages);
  } finally {
    activeRuns.delete(env.run.id);
  }
  // Whether the project is clean now: the status tool tells apart changes the run made from later ones.
  if (env.run.state === "done" && env.run.project_dirty_at_end === undefined) {
    try {
      const p = await readProject(env.ctx, "ae_deliver_step", env.run.project_path);
      env.run.project_dirty_at_end = p.dirty === true;
      persist(env);
    } catch {
      /* the run is finished either way */
    }
  }
  return present(env);
}

// ---------- status tool ----------

export async function deliverStatus(args: AeDeliverStatusArgs, ctx: ToolContext) {
  const project = await readProject(ctx, "ae_deliver_status", args.expect.project_path);
  const projectPath = project.project_path ?? args.expect.project_path;
  let store: Store;
  try {
    store = loadStore(projectPath);
  } catch (e) {
    return unreadable(e);
  }
  if (args.list) {
    return {
      ok: true,
      runs: store.runs
        .slice()
        .reverse()
        .map((r) => ({ run_id: r.id, recipe: r.recipe, state: r.state, created_at: r.created_at, updated_at: r.updated_at, summary: summarizeStages(r.stages) })),
      state_file: projectPath === "<unsaved>" ? null : deliverPath(projectPath),
    };
  }
  const run = args.run_id ? store.runs.find((r) => r.id === args.run_id) : store.runs[store.runs.length - 1];
  if (!run) return { ok: false, error: "unknown_run", message: args.run_id ? `No run ${args.run_id} for this project.` : "No delivery run in this project yet." };
  const env: Env = { ctx, run, store, saved: { file: projectPath === "<unsaved>" ? null : deliverPath(projectPath) } };
  return present(env, {
    ok: true,
    error: undefined,
    report: renderReport(run),
    project: { dirty: project.dirty ?? null, saved: project.saved ?? null },
    ...(run.state === "done" && project.dirty
      ? run.project_dirty_at_end === true
        ? { note: "The delivery ended with unsaved changes made by its own stages (a verify or scrub imports and removes a file). Save the project before relying on the file on disk." }
        : { note: "The project has unsaved changes made after this delivery ran; the delivered files may not match it." }
      : {}),
  });
}

// ---------- tools ----------

export const deliverTools: ToolDefinition<any>[] = [
  {
    name: "ae_deliver_recipe",
    description:
      "The delivery recipe for a client or channel: an ordered list of stages (preflight, house_style, save, render, verify, scrub, save, loudness, collect) kept in <project>.deliver.json next to the .aep. " +
      "action 'list' / 'get' read it ('get' also says whether each stage's tool exists on this server), 'set' creates or changes one (comp_id, stages, checkpoint_mode, notes; a new recipe without stages gets the default nine), 'delete' removes one. " +
      "The render stage needs its outputs in args (ae_render_batch: output_dir and specs; the run follows the batch to the end), the collect stage needs dest. Verify and scrub leave the project changed, so the default recipe saves again before loudness and collect, which refuse a changed project. Edit a recipe per client; a run in progress takes the edited definition of a stage when that stage is retried. Changes nothing in After Effects. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeDeliverRecipeSchema,
    handler: deliverRecipe,
  },
  {
    name: "ae_deliver_step",
    description:
      "Run a delivery recipe one safe step at a time. 'start' makes a run from a recipe and runs its stages in order until one blocks, a render is in flight or max_stages is reached; " +
      "'next' continues (it follows a render that is running first), 'retry' runs the stopped stage again after you fixed what it reported, 'skip' passes it with a written acknowledgement (only when Jay accepts it), 'cancel' ends the run and its render. " +
      "Each stage is an existing tool run through its own handler (guard, undo group and read-back stay that tool's); a checkpoint is taken before each stage that writes. A blocker stops the run; a warning is listed and the run goes on. " +
      "A tool that isn't registered is reported as 'unavailable' (optional stages go on). The run is recorded in <project>.deliver.json, so it survives a restart, and every call returns the stage table and, when done or stopped, a report. " +
      "dry_run on start shows the plan without running it. Each stage is its own undo step; the way back is the checkpoint (ae_checkpoint_revert). " +
      "A verify or scrub that leaves its imported render or temporary comp in the project, or can't confirm it removed them, blocks the run and can't be retried (inspect, then skip). A collect with a zip waits for the zip and blocks if it failed. A render batch is not retried (use ae_render_batch_resume, then next). Up to 500 rendered files are followed; long lists are cut to 40 rows with outputs_total. expect takes project_path only. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeDeliverStepSchema,
    handler: deliverStep,
  },
  {
    name: "ae_deliver_status",
    description:
      "Show a delivery run: the stage table (status, findings, per-file results), the files it produced, what to do next and a plain-text report to hand to the client. " +
      "Default the latest run; list: true lists the runs. Reads the record next to the .aep; changes nothing in After Effects.",
    schema: AeDeliverStatusSchema,
    handler: deliverStatus,
  },
];
