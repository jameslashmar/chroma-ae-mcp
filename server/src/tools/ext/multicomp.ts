/**
 * server/src/tools/ext/multicomp.ts
 *
 * One guarded fix across many comps:
 * - ae_multi_comp_apply: runs an existing typed write tool (ae_set_property,
 *   ae_add_effect, ae_batch_set, ...) on every comp a selector names (ids, a
 *   name pattern, a folder, or the comps nested inside a comp). It is a
 *   meta-tool: each comp goes through the target tool's own handler, so the
 *   guard, automatic checkpoint, undo group and separate-evalScript
 *   read-back all stay the target tool's. This file adds the target list
 *   (frozen in a job record next to the .aep), the per-comp ok / skipped /
 *   failed table, an optional fingerprint hash before and after, and resume.
 *
 * Why the job is not one undo step: an undo group can't span evalScripts, so
 * N comps are N undo steps. The way back across the whole job is the
 * checkpoint (one copy of the last save covers writes made between two saves).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { pathsMatchForGuard } from "../../jsx.js";
import { QuarantineBlockedError } from "../../quarantine.js";
import { QueueWaitError } from "../../queue.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";

// ---------- schema ----------

/**
 * The typed write tools a job may run. Each takes comp_id and expect and is a
 * guarded write on its own. ae_run_jsx and ae_skill_run are deliberately not
 * here: free-form scripts can't be checked per comp.
 */
export const MULTICOMP_WRITE_TOOLS = [
  "ae_set_property",
  "ae_set_text",
  "ae_add_effect",
  "ae_set_effect",
  "ae_remove_effect",
  "ae_apply_preset",
  "ae_batch_set",
  "ae_create_layer",
  "ae_set_track_matte",
  "ae_add_markers",
  "ae_remove_markers",
  "ae_remove_keyframes",
  "ae_set_keyframe_ease",
  "ae_mask",
  "ae_text_animator",
  "ae_shape",
  "ae_align",
  "ae_layer_ops",
  "ae_comp_settings",
] as const;

export const MAX_JOB_COMPS = 200;
const KEPT_JOBS = 20;
const TABLE_LIMIT = 500;

export const AeMultiCompApplySchema = z
  .object({
    op: z
      .object({
        tool: z.enum(MULTICOMP_WRITE_TOOLS).describe("The write tool to run on each comp."),
        args: z
          .record(z.string(), z.unknown())
          .describe(
            "That tool's arguments WITHOUT comp_id and expect: both are filled in for each comp. " +
              "Layers must be picked by name (or by the tool's other comp-independent fields): an index or id selector means a different layer in every comp, so it is refused for more than one comp."
          ),
      })
      .optional()
      .describe("What to run on every comp. Required unless resume_job_id is given."),
    comp_ids: z.array(z.number().int()).min(1).max(MAX_JOB_COMPS).optional().describe("Explicit CompItem ids."),
    folder_id: z.number().int().optional().describe("Every comp in this project folder, subfolders included (a FolderItem id)."),
    nested_in: z
      .number()
      .int()
      .optional()
      .describe("Every comp nested inside this comp, at any depth (found through its precomp layers; the comp itself is not included)."),
    name_pattern: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "A regular expression the comp name must match (unanchored; use ^ and $ to anchor). Alone it searches every comp in the project; " +
          "with comp_ids, folder_id or nested_in it narrows that set. Use '.' to name every comp on purpose."
      ),
    case_insensitive: z.boolean().optional().describe("Match name_pattern ignoring case."),
    exclude_ids: z.array(z.number().int()).max(MAX_JOB_COMPS).optional().describe("Comp ids to leave out of the selection."),
    max_comps: z
      .number()
      .int()
      .min(1)
      .max(MAX_JOB_COMPS)
      .optional()
      .describe(`Refuse (writing nothing) if the selection is larger than this. Default 100, at most ${MAX_JOB_COMPS}.`),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "Resolve the comps, validate the op's arguments against each, and check that the layers it names exist, without writing. " +
          "Shallow: it can't show value changes, except for ae_batch_set whose own validation pass runs for each comp."
      ),
    on_failure: z
      .enum(["stop", "continue"])
      .optional()
      .describe(
        "What a failing comp does to the rest. Default 'stop': the remaining comps stay pending and the job can be resumed. " +
          "A guard failure, a failed read-back, a timeout or quarantine stops the job either way. Nothing is retried within a run."
      ),
    fingerprints: z
      .boolean()
      .optional()
      .describe("Hash each comp's fingerprint before and after (two deep reads per comp, up to 5000 properties each) and report whether it changed. Default false."),
    pause_ms: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe("Pause after each comp that was written, so AE's UI keeps up and the queue is free for other callers. Default 250."),
    resume_job_id: z
      .string()
      .regex(/^mc_[a-z0-9_]+$/)
      .optional()
      .describe(
        "Continue an earlier job from its record (<project>.jobs.json): the frozen comp list and op are reused, so op and the selectors must be left out. " +
          "Comps that are still pending run; failed ones run again only with retry_failed."
      ),
    retry_failed: z
      .boolean()
      .optional()
      .describe("With resume_job_id: run comps that failed again. A failed comp may be half-written, so check it first."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.resume_job_id !== undefined) !== (v.op !== undefined), {
    message: "Give op (a new job) or resume_job_id (continue one), not both and not neither.",
  })
  .refine(
    (v) =>
      v.resume_job_id === undefined ||
      (v.comp_ids === undefined && v.folder_id === undefined && v.nested_in === undefined && v.name_pattern === undefined && v.exclude_ids === undefined),
    { message: "resume_job_id reuses the job's frozen comp list: leave out comp_ids, folder_id, nested_in, name_pattern and exclude_ids." }
  )
  .refine((v) => v.resume_job_id !== undefined || v.comp_ids !== undefined || v.folder_id !== undefined || v.nested_in !== undefined || v.name_pattern !== undefined, {
    message: "Name the comps: comp_ids, folder_id, nested_in or name_pattern ('.' for every comp).",
  })
  .refine((v) => [v.comp_ids, v.folder_id, v.nested_in].filter((x) => x !== undefined).length <= 1, {
    message: "Give at most one of comp_ids, folder_id and nested_in.",
  })
  .refine((v) => v.retry_failed === undefined || v.resume_job_id !== undefined, { message: "retry_failed applies with resume_job_id only." })
  .refine((v) => !v.op || (!("comp_id" in v.op.args) && !("expect" in v.op.args)), {
    message: "op.args must not contain comp_id or expect: the tool fills them in for each comp.",
  })
  .refine((v) => !v.op || !("dry_run" in v.op.args), {
    message: "op.args must not contain dry_run: it would turn the job into a preview that writes nothing. Use the top-level dry_run of ae_multi_comp_apply.",
  })
  .refine(
    (v) => {
      if (v.name_pattern === undefined) return true;
      try {
        new RegExp(v.name_pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "name_pattern is not a valid regular expression." }
  )
  // The pattern runs inside ExtendScript, where a runaway match freezes AE and cannot be
  // aborted. A quantified group that itself holds a quantifier, like (a+)+, is the classic one.
  .refine((v) => v.name_pattern === undefined || !/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(v.name_pattern), {
    message: "name_pattern has a quantified group that holds a quantifier (like (a+)+), which can freeze After Effects. Simplify it.",
  });

export type AeMultiCompApplyArgs = z.infer<typeof AeMultiCompApplySchema>;

// ---------- pure logic ----------

/** Argument names that hold a layer selector ({index|id|name}) in the write tools. */
const LAYER_KEYS = new Set(["layer", "layers", "parent", "matte", "above", "below", "target", "targets", "relative_to"]);

export interface SelectorScan {
  /** Paths of selectors that name a layer by index or id: different layers in every comp. */
  positional: string[];
  /** Names layers are picked by; each must exist in a comp for the op to run there. */
  names: string[];
}

/** Finds the layer selectors in a tool's arguments (anything under a LAYER_KEYS key, at any depth). */
export function scanLayerSelectors(args: unknown): SelectorScan {
  const positional: string[] = [];
  const names = new Set<string>();
  const walk = (value: unknown, where: string, isSelector: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${where}[${i}]`, isSelector));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (isSelector && (obj.index !== undefined || obj.id !== undefined || obj.name !== undefined)) {
      if (obj.index !== undefined || obj.id !== undefined) positional.push(where);
      else if (typeof obj.name === "string") names.add(obj.name);
      return;
    }
    for (const [k, v] of Object.entries(obj)) walk(v, where ? `${where}.${k}` : k, LAYER_KEYS.has(k));
  };
  walk(args, "", false);
  return { positional, names: [...names] };
}

export type CompStatus = "pending" | "in_flight" | "ok" | "skipped" | "failed" | "unverified";

export interface JobComp {
  comp_id: number;
  name: string;
  status: CompStatus;
  reason?: string;
  error?: string;
  /** Whether the write reached the project: unknown after an AE-side error. */
  applied?: boolean | "unknown";
  receipt_matches?: boolean;
  mismatches?: Array<{ path: string; message: string }>;
  fingerprint_before?: string;
  fingerprint_after?: string;
  changed?: boolean;
  fingerprint_note?: string;
  duration_ms?: number;
  /** Undo steps the write made (an ae_batch_set comp is one per chunk). */
  undo_steps?: number;
  /** What the user changed in AE since the last write, as the inner write reported it. */
  user_changed?: string;
}

export interface JobRecord {
  id: string;
  created_at: string;
  updated_at: string;
  state: "running" | "stopped" | "done";
  stop_reason?: string;
  project_path: string;
  tool: string;
  args: Record<string, unknown>;
  on_failure: "stop" | "continue";
  fingerprints: boolean;
  pause_ms: number;
  /** How the comps were chosen, for the record (the list below is what runs). */
  selection: Record<string, unknown>;
  comps: JobComp[];
  checkpoint?: unknown;
  /** Why the first checkpoint attempt made no copy, kept while no real copy exists. */
  checkpoint_skipped_reason?: string;
}

export interface Outcome {
  status: CompStatus;
  error?: string;
  reason?: string;
  applied?: boolean | "unknown";
  receipt_matches?: boolean;
  mismatches?: Array<{ path: string; message: string }>;
}

const shortMismatches = (list: unknown) =>
  (Array.isArray(list) ? list : []).slice(0, 5).map((m: any) => ({ path: String(m?.path ?? ""), message: String(m?.message ?? "").slice(0, 300) }));

/** Turns a write tool's result into a per-comp outcome. */
export function classifyResult(res: unknown): Outcome {
  if (res === null || typeof res !== "object") return { status: "ok" };
  const r = res as Record<string, any>;
  // ae_batch_set reports matches / mismatches at the top level, the runGuardedWrite tools in a receipt.
  const mismatches: unknown[] = Array.isArray(r.receipt?.mismatches) ? r.receipt.mismatches : Array.isArray(r.mismatches) ? r.mismatches : [];
  const matches: unknown = r.receipt ? r.receipt.matches : r.matches;
  const readBackFailed = r.error === "read_back_failed" || mismatches.some((m: any) => m?.path === "read_back");
  if (readBackFailed) {
    return {
      status: "unverified",
      error: "read_back_failed",
      applied: true,
      reason: "The write was applied but its read-back failed; not resent.",
      mismatches: shortMismatches(mismatches.filter((m: any) => m?.path === "read_back")),
    };
  }
  if (r.ok === false || typeof r.error === "string") {
    let applied: boolean | "unknown" = "unknown";
    if (r.applied === true || (typeof r.done === "number" && r.done > 0)) applied = true;
    else if (r.applied === false || r.error === "bad_args" || r.error === "not_found") applied = false;
    return { status: "failed", error: String(r.error ?? "failed"), reason: typeof r.message === "string" ? r.message.slice(0, 500) : undefined, applied };
  }
  if (matches === false) {
    return {
      status: "failed",
      error: "receipt_mismatch",
      applied: true,
      receipt_matches: false,
      reason: "The write was applied but the read-back differs from what was asked.",
      mismatches: shortMismatches(mismatches),
    };
  }
  const out: Outcome = { status: "ok" };
  if (matches !== undefined) out.receipt_matches = matches === true;
  return out;
}

/** What a thrown error means for the job: the outcome, and whether the whole job must stop. */
export function classifyError(err: unknown): { outcome: Outcome; fatal: boolean } {
  if (err instanceof QuarantineBlockedError) {
    return { outcome: { status: "failed", error: "quarantine", reason: err.message.slice(0, 500), applied: false }, fatal: true };
  }
  if (err instanceof BridgeError) {
    const reason = err.message.slice(0, 500);
    if (err.kind === "guard") return { outcome: { status: "failed", error: "guard", reason, applied: false }, fatal: true };
    if (err.kind === "queued") return { outcome: { status: "failed", error: "queued", reason, applied: false }, fatal: true };
    if (err.kind === "evalscript_error") return { outcome: { status: "failed", error: "evalscript_error", reason, applied: "unknown" }, fatal: false };
    // A timeout or an unreachable AE: the script may still be running or a popup may be open.
    return { outcome: { status: "failed", error: err.kind, reason, applied: "unknown" }, fatal: true };
  }
  // An unrecognised error can come from the inner tool after its write, so it is not known to be safe to resend.
  return { outcome: { status: "failed", error: "error", reason: (err instanceof Error ? err.message : String(err)).slice(0, 500), applied: "unknown" }, fatal: false };
}

export function summarize(comps: JobComp[]): Record<CompStatus, number> {
  const s: Record<CompStatus, number> = { pending: 0, in_flight: 0, ok: 0, skipped: 0, failed: 0, unverified: 0 };
  for (const c of comps) s[c.status]++;
  return s;
}

/** A short stable hash of a fingerprint, so a job record can hold many without the fingerprint store's 20-entry limit. */
export function hashFingerprint(fp: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(fp)).digest("hex").slice(0, 16);
}

// ---------- job store ----------

/** `<project>.jobs.json` next to the .aep. */
export function jobsPath(projectPath: string): string {
  return path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}.jobs.json`);
}

// Jobs of this server process, for unsaved projects and for a job file that can't be written.
const memoryJobs = new Map<string, JobRecord>();
const activeJobs = new Set<string>();

function rememberJob(job: JobRecord): void {
  memoryJobs.delete(job.id);
  memoryJobs.set(job.id, job);
  while (memoryJobs.size > KEPT_JOBS) {
    const oldest = memoryJobs.keys().next().value;
    if (oldest === undefined) break;
    memoryJobs.delete(oldest);
  }
}

export function clearJobMemory(): void {
  memoryJobs.clear();
  activeJobs.clear();
}

function readJobFile(file: string): { jobs: JobRecord[] } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [] };
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.jobs)) return parsed as { jobs: JobRecord[] };
  } catch {
    /* falls through to the aside below */
  }
  // Never overwrite a file that can't be parsed: keep it beside the new one.
  fs.renameSync(file, `${file}.${Date.now()}.bak`);
  return { jobs: [] };
}

/** Saves a job (replacing its earlier copy). Never throws: returns the file written, or why not. */
export function saveJob(job: JobRecord): { file: string | null; error?: string } {
  job.updated_at = new Date().toISOString();
  rememberJob(job);
  if (job.project_path === "<unsaved>") return { file: null };
  const file = jobsPath(job.project_path);
  try {
    const store = readJobFile(file) ?? { jobs: [] };
    store.jobs = store.jobs.filter((j) => j.id !== job.id);
    store.jobs.push(job);
    if (store.jobs.length > KEPT_JOBS) store.jobs = store.jobs.slice(-KEPT_JOBS);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, file);
    return { file };
  } catch (e) {
    return { file: null, error: (e as Error).message };
  }
}

export function loadJob(projectPath: string, id: string): JobRecord | null {
  if (projectPath !== "<unsaved>") {
    try {
      const found = readJobFile(jobsPath(projectPath))?.jobs.find((j) => j.id === id);
      if (found) return found;
    } catch {
      /* fall back to this process's copy */
    }
  }
  return memoryJobs.get(id) ?? null;
}

function newJobId(): string {
  return `mc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

// ---------- tool lookup ----------

type ToolLookup = (name: string) => Promise<ToolDefinition<any> | undefined>;

// Loaded on first use: the registry imports the tool groups, this one included.
const registryLookup: ToolLookup = async (name) => {
  const { ALL_TOOLS } = await import("../registry.js");
  return ALL_TOOLS.find((t) => t.name === name);
};
let lookupTool: ToolLookup = registryLookup;

/** Tests swap the registry for a set of fake write tools; call with no argument to restore it. */
export function setToolLookup(fn?: ToolLookup): void {
  lookupTool = fn ?? registryLookup;
}

// ---------- handler ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ResolvedComps {
  comps: Array<{ id: number; name: string }>;
  matched: number;
  missing_ids: number[];
  truncated: boolean;
  partial: boolean;
  /** Set by the host when expect.project_path no longer matches the open project. */
  guard_failed?: boolean;
  project_path?: string | null;
}

interface ProbeResult {
  guard_failed?: boolean;
  project_path?: string | null;
  comps: Array<{ id: number; exists: boolean; name: string | null; found: Record<string, number> }>;
}

interface PlanEntry {
  action: "run" | "skip" | "fail";
  reason?: string;
}

/** Decides per comp, from a probe, whether the op can run: the comp exists and every named layer is there once. */
export function planFromProbe(comps: JobComp[], names: string[], probe: ProbeResult["comps"]): Map<number, PlanEntry> {
  const byId = new Map(probe.map((p) => [p.id, p]));
  const plan = new Map<number, PlanEntry>();
  for (const c of comps) {
    const p = byId.get(c.comp_id);
    if (!p || !p.exists) {
      plan.set(c.comp_id, { action: "skip", reason: "The comp no longer exists." });
      continue;
    }
    const missing = names.filter((n) => (p.found[n] ?? 0) === 0);
    if (missing.length > 0) {
      plan.set(c.comp_id, { action: "skip", reason: `No layer named ${missing.map((n) => `"${n}"`).join(", ")} in this comp.` });
      continue;
    }
    const ambiguous = names.filter((n) => (p.found[n] ?? 0) > 1);
    if (ambiguous.length > 0) {
      plan.set(c.comp_id, { action: "fail", reason: `Several layers are named ${ambiguous.map((n) => `"${n}"`).join(", ")} in this comp, so the name doesn't pick one.` });
      continue;
    }
    plan.set(c.comp_id, { action: "run" });
  }
  return plan;
}

/** A checkpoint result that names a real copy; autoCheckpoint also answers {status:"skipped"} when it made none. */
function isRealCheckpoint(c: unknown): boolean {
  if (c === null || typeof c !== "object") return false;
  const st = (c as { status?: unknown }).status;
  return st === "created" || st === "reused";
}

const PROBE_NAME_LIMIT = 50;

const call = <T>(ctx: ToolContext, fn: string, args: unknown, label: string) =>
  ctx.bridge.callHost<T>(fn, args, { label, mutates: false, toolName: "ae_multi_comp_apply" }).then((r) => r.result);

/** The host checked expect in the same evalScript that listed the comps and the open project had changed. */
function guardChanged(opId: string, expect: { project_path: string }, actual: string | null | undefined): BridgeError {
  return new BridgeError({
    kind: "guard",
    op_id: opId,
    message: `Target guard refused the job: expected project_path "${expect.project_path}", but After Effects has "${actual ?? "<unsaved>"}" open. Nothing was written; stop and re-read state.`,
    expected: expect,
    actual: { project_path: actual ?? "<unsaved>", comp_id: null },
  });
}

const bad = (message: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: "bad_args", applied: false, message, ...extra });

export async function multiCompApply(args: AeMultiCompApplyArgs, ctx: ToolContext) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();

  // The project must be the one the caller expects before anything is resolved or run.
  let guard;
  try {
    guard = await ctx.queue.run("ae_multi_comp_apply (guard)", () => verifyTargetGuard(ctx, { project_path: args.expect.project_path }, opId));
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
  const projectPath = guard.project_path ?? args.expect.project_path;

  // ----- the job: a frozen comp list and op, new or from a record -----
  let job: JobRecord;
  let resuming = false;
  if (args.resume_job_id !== undefined) {
    const found = loadJob(projectPath, args.resume_job_id);
    if (!found) return { ok: false, error: "unknown_job", applied: false, message: `No job ${args.resume_job_id} for this project (looked in ${projectPath === "<unsaved>" ? "this server's memory" : jobsPath(projectPath)}).` };
    if (!pathsMatchForGuard(found.project_path, projectPath)) {
      return { ok: false, error: "wrong_project", applied: false, message: `Job ${found.id} belongs to ${found.project_path}, but ${projectPath} is open.` };
    }
    if (activeJobs.has(found.id)) return { ok: false, error: "job_running", applied: false, message: `Job ${found.id} is running right now.` };
    job = found;
    resuming = true;
    // A comp left in flight was being written when AE or the panel died: it may be half done, so it is reported, not run again.
    for (const c of job.comps) {
      if (c.status === "in_flight") {
        Object.assign(c, {
          status: "unverified" as CompStatus,
          error: "interrupted",
          applied: "unknown",
          reason: "The write was in progress when the job was interrupted (AE or the panel may have crashed). It may be fully, partly or not applied: inspect this comp before running it again. retry_failed runs it again.",
        });
      }
    }
    if (args.on_failure) job.on_failure = args.on_failure;
    if (args.fingerprints !== undefined) job.fingerprints = args.fingerprints;
    if (args.pause_ms !== undefined) job.pause_ms = args.pause_ms;
  } else {
    const op = args.op!;
    const resolved = await call<ResolvedComps>(
      ctx,
      "multicompResolve",
      { ids: args.comp_ids, folder_id: args.folder_id, nested_in: args.nested_in, name_pattern: args.name_pattern, case_insensitive: args.case_insensitive, exclude_ids: args.exclude_ids, expect: { project_path: args.expect.project_path } },
      "ae_multi_comp_apply (resolve comps)"
    );
    if (resolved.guard_failed) throw guardChanged(opId, args.expect, resolved.project_path);
    if (resolved.missing_ids.length > 0) {
      return { ok: false, error: "not_found", applied: false, message: `Not comps in this project: ${resolved.missing_ids.join(", ")}. Nothing was written.`, missing_ids: resolved.missing_ids };
    }
    if (resolved.truncated) {
      return bad(`The selection matches ${resolved.matched} comps, more than the ${TABLE_LIMIT} a job can list. Narrow it with folder_id, nested_in, name_pattern or comp_ids. Nothing was written.`, { matched: resolved.matched });
    }
    if (resolved.partial) {
      return bad("The scan of the project was cut short, so the selection may be incomplete. Narrow it with folder_id, nested_in or comp_ids. Nothing was written.");
    }
    if (resolved.comps.length === 0) {
      return { ok: false, error: "no_comps", applied: false, message: "The selection matches no comps. Nothing was written." };
    }
    const limit = args.max_comps ?? 100;
    if (resolved.comps.length > limit) {
      return bad(`The selection is ${resolved.comps.length} comps, over max_comps ${limit}. Narrow it or raise max_comps (at most ${MAX_JOB_COMPS}). Nothing was written.`, { matched: resolved.comps.length });
    }
    job = {
      id: newJobId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      state: "running",
      project_path: projectPath,
      tool: op.tool,
      args: op.args,
      on_failure: args.on_failure ?? "stop",
      fingerprints: args.fingerprints ?? false,
      pause_ms: args.pause_ms ?? 250,
      selection: {
        comp_ids: args.comp_ids,
        folder_id: args.folder_id,
        nested_in: args.nested_in,
        name_pattern: args.name_pattern,
        case_insensitive: args.case_insensitive,
        exclude_ids: args.exclude_ids,
      },
      comps: resolved.comps.map((c) => ({ comp_id: c.id, name: c.name, status: "pending" as CompStatus })),
    };
  }

  // ----- validate everything that can fail before any comp is written -----
  const tool = await lookupTool(job.tool);
  if (!tool) return bad(`The write tool ${job.tool} is not available on this server. Nothing was written.`);
  const scan = scanLayerSelectors(job.args);
  if (job.comps.length > 1 && scan.positional.length > 0) {
    return bad(
      `Layer selectors by index or id (${scan.positional.join(", ")}) pick a different layer in every comp. Select layers by name for more than one comp. Nothing was written.`
    );
  }
  const parsedByComp = new Map<number, unknown>();
  const invalid: Array<{ comp_id: number; message: string }> = [];
  for (const c of job.comps) {
    const parsed = tool.schema.safeParse({ ...job.args, comp_id: c.comp_id, expect: { project_path: args.expect.project_path, comp_id: c.comp_id } });
    if (parsed.success) parsedByComp.set(c.comp_id, parsed.data);
    else invalid.push({ comp_id: c.comp_id, message: parsed.error.issues.slice(0, 3).map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") });
  }
  if (invalid.length > 0) {
    return bad(`${job.tool} rejects its arguments (${invalid[0].message}). Nothing was written.`, { invalid: invalid.slice(0, 20), invalid_count: invalid.length });
  }

  // Comps to run now: pending ones, plus failed ones when asked on resume.
  const todo = job.comps.filter(
    (c) => c.status === "pending" || (resuming && args.retry_failed === true && (c.status === "failed" || (c.status === "unverified" && c.error === "interrupted")))
  );
  let probe: ProbeResult["comps"] = [];
  if (todo.length) {
    // The host probes at most PROBE_NAME_LIMIT names per call, so a long list goes in chunks whose `found` maps are merged.
    const nameChunks: string[][] = [];
    for (let i = 0; i < scan.names.length; i += PROBE_NAME_LIMIT) nameChunks.push(scan.names.slice(i, i + PROBE_NAME_LIMIT));
    if (nameChunks.length === 0) nameChunks.push([]);
    for (const chunk of nameChunks) {
      const probed = await call<ProbeResult>(
        ctx,
        "multicompProbe",
        { comp_ids: todo.map((c) => c.comp_id), layer_names: chunk, expect: { project_path: args.expect.project_path } },
        "ae_multi_comp_apply (probe layers)"
      );
      if (probed.guard_failed) throw guardChanged(opId, args.expect, probed.project_path);
      if (probe.length === 0) {
        probe = probed.comps.map((p) => ({ ...p, found: { ...p.found } }));
      } else {
        const byId = new Map(probe.map((p) => [p.id, p]));
        for (const p of probed.comps) {
          const into = byId.get(p.id);
          if (into) Object.assign(into.found, p.found);
        }
      }
    }
  }
  const plan = planFromProbe(todo, scan.names, probe);

  // ----- dry run: the plan, nothing written, no job record -----
  if (args.dry_run) {
    const validation = new Map<number, string>();
    if (job.tool === "ae_batch_set" || job.tool === "ae_set_property") {
      for (const c of todo) {
        if (plan.get(c.comp_id)?.action !== "run") continue;
        const parsedArgs = (parsedByComp.get(c.comp_id) ?? {}) as { ops?: unknown[]; chunk_size?: number; layer?: unknown; path?: unknown; value?: unknown; keyframes?: unknown; expression?: unknown; expression_enabled?: unknown; allow_substitute?: unknown };
        // ae_set_property is a one-op batch: the same validation checks that the layer and the property path exist in this comp.
        const ops: unknown[] =
          job.tool === "ae_batch_set"
            ? parsedArgs.ops ?? []
            : [{ layer: parsedArgs.layer, path: parsedArgs.path, ...(parsedArgs.value !== undefined ? { value: parsedArgs.value } : {}), ...(parsedArgs.keyframes !== undefined ? { keyframes: parsedArgs.keyframes } : {}), ...(parsedArgs.expression !== undefined ? { expression: parsedArgs.expression } : {}), ...(parsedArgs.expression_enabled !== undefined ? { expression_enabled: parsedArgs.expression_enabled } : {}), ...(parsedArgs.allow_substitute !== undefined ? { allow_substitute: parsedArgs.allow_substitute } : {}) }];
        const size = parsedArgs.chunk_size ?? 500;
        for (let start = 0; start < ops.length; start += size) {
          const check = await call<{ ok: boolean; error?: string }>(
            ctx,
            "batchValidate",
            { comp_id: c.comp_id, ops: ops.slice(start, start + size), base: start, allow_substitute: parsedArgs.allow_substitute === true },
            `ae_multi_comp_apply (check ${c.name})`
          );
          if (check && check.ok === false) {
            validation.set(c.comp_id, check.error ?? "An op is invalid");
            break;
          }
        }
      }
    }
    const rows = job.comps.slice(0, TABLE_LIMIT).map((c) => {
      const p = plan.get(c.comp_id);
      if (!p) return { comp_id: c.comp_id, name: c.name, plan: "done", status: c.status };
      const v = validation.get(c.comp_id);
      if (v) return { comp_id: c.comp_id, name: c.name, plan: "fail", reason: v };
      return { comp_id: c.comp_id, name: c.name, plan: p.action, ...(p.reason ? { reason: p.reason } : {}) };
    });
    return {
      ok: true,
      dry_run: true,
      applied: false,
      tool: job.tool,
      ...(resuming ? { job_id: job.id } : {}),
      comps: rows,
      would_run: rows.filter((r) => r.plan === "run").length,
      would_skip: rows.filter((r) => r.plan === "skip").length,
      would_fail: rows.filter((r) => r.plan === "fail").length,
      truncated: job.comps.length > TABLE_LIMIT,
      depth: job.tool === "ae_batch_set" || job.tool === "ae_set_property" ? "validated" : "targets_and_selectors",
      note:
        job.tool === "ae_batch_set" || job.tool === "ae_set_property"
          ? "Each comp's layers and property paths were checked by the batch validation pass; values are not compared."
          : "Shallow dry run: the comps, the arguments and the named layers are checked, not what the write would change.",
    };
  }

  // ----- the run -----
  job.state = "running";
  delete job.stop_reason;
  let store = saveJob(job);
  activeJobs.add(job.id);
  let stoppedAt: { comp_id: number; name: string } | null = null;
  const writtenNow: JobComp[] = [];
  try {
    let wrote = false;
    for (const entry of todo) {
      const p = plan.get(entry.comp_id) ?? { action: "run" as const };
      if (p.action === "skip") {
        Object.assign(entry, { status: "skipped" as CompStatus, reason: p.reason });
        store = saveJob(job);
        continue;
      }
      if (p.action === "fail") {
        Object.assign(entry, { status: "failed" as CompStatus, error: "ambiguous_layer", reason: p.reason, applied: false });
        store = saveJob(job);
        if (job.on_failure === "stop") {
          stoppedAt = { comp_id: entry.comp_id, name: entry.name };
          job.stop_reason = `Comp "${entry.name}" failed: ${p.reason}`;
          break;
        }
        continue;
      }
      if (wrote && job.pause_ms > 0) await sleep(job.pause_ms);
      // A retry starts clean.
      for (const k of ["reason", "error", "applied", "receipt_matches", "mismatches", "fingerprint_before", "fingerprint_after", "changed", "fingerprint_note", "undo_steps", "user_changed"] as const) delete entry[k];
      const started = Date.now();
      let capped = false;
      if (job.fingerprints) {
        try {
          const fp = await call<{ truncated?: boolean } | null>(ctx, "compFingerprint", { comp_id: entry.comp_id }, `ae_multi_comp_apply (fingerprint ${entry.name})`);
          if (fp?.truncated === true) capped = true;
          entry.fingerprint_before = hashFingerprint(fp);
        } catch (e) {
          entry.fingerprint_note = `Fingerprint before failed: ${(e as Error).message}`.slice(0, 300);
        }
      }
      let outcome: Outcome;
      let fatal = false;
      let checkpoint: unknown;
      let skippedCheckpoint: unknown;
      let userChanged: string | undefined;
      let undoSteps: number | undefined;
      // Marked before the write starts, so a crash during it leaves a record that says the comp may be half done.
      entry.status = "in_flight";
      store = saveJob(job);
      try {
        // The target tool's own guarded write: guard, checkpoint, before read, write, separate read-back, receipt.
        const result = await tool.handler(parsedByComp.get(entry.comp_id), ctx);
        outcome = classifyResult(result);
        const r = result as { checkpoint?: unknown; chunks?: Array<{ checkpoint?: unknown; done?: number }>; user_changed?: unknown } | null;
        // ae_batch_set reports one checkpoint per chunk, not one at the top.
        const candidates: unknown[] = [r?.checkpoint];
        if (Array.isArray(r?.chunks)) for (const ch of r.chunks) candidates.push(ch?.checkpoint);
        checkpoint = candidates.find(isRealCheckpoint);
        skippedCheckpoint = candidates.find((c) => c !== undefined && c !== null && !isRealCheckpoint(c));
        if (typeof r?.user_changed === "string" && r.user_changed.length > 0) userChanged = r.user_changed.slice(0, 500);
        if (Array.isArray(r?.chunks)) undoSteps = Math.max(1, r.chunks.filter((ch) => (ch?.done ?? 0) > 0).length);
        wrote = true;
      } catch (err) {
        const c = classifyError(err);
        outcome = c.outcome;
        fatal = c.fatal;
        wrote = wrote || outcome.applied !== false;
      }
      // Once the write may have happened, nothing below may throw.
      if (job.checkpoint === undefined && checkpoint !== undefined) {
        job.checkpoint = checkpoint;
        delete job.checkpoint_skipped_reason;
      } else if (job.checkpoint === undefined && job.checkpoint_skipped_reason === undefined && skippedCheckpoint !== undefined) {
        const reason = (skippedCheckpoint as { reason?: unknown }).reason;
        job.checkpoint_skipped_reason = typeof reason === "string" && reason ? reason.slice(0, 300) : "The automatic checkpoint made no copy.";
      }
      if (job.fingerprints && outcome.applied !== false) {
        try {
          const fpAfter = await call<{ truncated?: boolean } | null>(ctx, "compFingerprint", { comp_id: entry.comp_id }, `ae_multi_comp_apply (fingerprint after ${entry.name})`);
          if (fpAfter?.truncated === true) capped = true;
          entry.fingerprint_after = hashFingerprint(fpAfter);
          // A capped read cannot see changes past the cap, so it never says unchanged.
          if (capped) entry.fingerprint_note = `${entry.fingerprint_note ? `${entry.fingerprint_note}; ` : ""}fingerprint capped; changes past the cap are not seen`.slice(0, 300);
          else if (entry.fingerprint_before !== undefined) entry.changed = entry.fingerprint_before !== entry.fingerprint_after;
        } catch (e) {
          entry.fingerprint_note = `${entry.fingerprint_note ? `${entry.fingerprint_note}; ` : ""}Fingerprint after failed: ${(e as Error).message}`.slice(0, 300);
        }
      }
      Object.assign(entry, outcome, { duration_ms: Date.now() - started });
      if (userChanged !== undefined) entry.user_changed = userChanged;
      if (undoSteps !== undefined) entry.undo_steps = undoSteps;
      if (entry.applied === true || outcome.status === "ok") writtenNow.push(entry);
      store = saveJob(job);
      if (outcome.status === "unverified" || fatal) {
        stoppedAt = { comp_id: entry.comp_id, name: entry.name };
        job.stop_reason =
          outcome.status === "unverified"
            ? `Comp "${entry.name}": the write was applied but its read-back failed (often a popup in AE). Inspect it before resuming.`
            : `Comp "${entry.name}": ${outcome.error} (${outcome.reason ?? "no detail"}). Stopped whatever on_failure says.`;
        break;
      }
      if (outcome.status === "failed" && job.on_failure === "stop") {
        stoppedAt = { comp_id: entry.comp_id, name: entry.name };
        job.stop_reason = `Comp "${entry.name}" failed: ${outcome.error}${outcome.reason ? ` (${outcome.reason})` : ""}.`;
        break;
      }
    }
  } finally {
    activeJobs.delete(job.id);
  }
  const summary = summarize(job.comps);
  const interrupted = job.comps.filter((c) => c.status === "unverified" && c.error === "interrupted");
  job.state = stoppedAt || summary.pending > 0 || interrupted.length > 0 ? "stopped" : "done";
  if (job.state === "stopped" && !job.stop_reason) {
    job.stop_reason =
      interrupted.length > 0
        ? `${interrupted.length} comp(s) were being written when the job was interrupted and may be half done: ${interrupted.slice(0, 5).map((c) => `"${c.name}"`).join(", ")}. Inspect them; retry_failed runs them again.`
        : "Comps left pending.";
  }
  store = saveJob(job);

  // applied and the undo count describe this call only; job_applied covers comps written by earlier calls too.
  const jobApplied = job.comps.some((c) => c.applied === true || c.status === "ok");
  const anyApplied = writtenNow.length > 0;
  const written = writtenNow;
  const undoSteps = written.reduce((n, c) => n + (c.undo_steps ?? 1), 0);
  const userChangedList = job.comps.filter((c) => c.user_changed).slice(0, 20).map((c) => ({ comp_id: c.comp_id, name: c.name, user_changed: c.user_changed }));
  const clean = summary.failed === 0 && summary.unverified === 0 && summary.pending === 0;
  return {
    ok: clean,
    ...(clean ? {} : { error: stoppedAt ? "job_stopped" : "comps_failed" }),
    applied: anyApplied,
    job_applied: jobApplied,
    job_id: job.id,
    state: job.state,
    tool: job.tool,
    summary,
    ...(stoppedAt ? { stopped_at: stoppedAt } : {}),
    ...(job.state === "stopped" && job.stop_reason ? { message: job.stop_reason } : {}),
    comps: job.comps.slice(0, TABLE_LIMIT).map((c) => ({ ...c })),
    truncated: job.comps.length > TABLE_LIMIT,
    checkpoint: job.checkpoint ?? null,
    checkpoint_note:
      job.checkpoint === undefined || job.checkpoint === null
        ? `No automatic checkpoint copy was made for this job${job.checkpoint_skipped_reason ? ` (${job.checkpoint_skipped_reason})` : ""}, so there is no copy of the last save to go back to; only Ctrl+Z undoes it.`
        : "One automatic checkpoint (a copy of the last save) covers the whole job when the project wasn't saved between comps; it is the way back across all comps. ae_checkpoint_revert restores it.",
    undo_note: `Each written comp is its own undo step, and an ae_batch_set comp has one per chunk (an undo group can't span evalScripts): ${undoSteps} step${undoSteps === 1 ? "" : "s"} of Ctrl+Z to undo by hand, from ${written.length} comp${written.length === 1 ? "" : "s"} written in this call.`,
    ...(userChangedList.length > 0 ? { user_changed: userChangedList } : {}),
    job_file: store.file,
    ...jobFileNotes(job, store),
    ...(job.state === "stopped"
      ? { resume: `Call ae_multi_comp_apply again with resume_job_id "${job.id}" to run the ${summary.pending} pending comp(s)${summary.failed ? "; add retry_failed to run the failed ones again" : ""}.` }
      : {}),
  };
}

function jobFileNotes(job: JobRecord, store: { file: string | null; error?: string }): Record<string, unknown> {
  if (store.error) {
    return { job_file_error: store.error, job_file_note: "The job could not be written next to the project; it is kept in this server's memory only." };
  }
  if (job.project_path === "<unsaved>") {
    return { job_file_note: "The project is unsaved, so the job is kept in this server's memory only; save the project to keep it beside the .aep." };
  }
  return {};
}

// ---------- tools ----------

export const multicompTools: ToolDefinition<any>[] = [
  {
    name: "ae_multi_comp_apply",
    description:
      `Run one existing guarded write (${MULTICOMP_WRITE_TOOLS.join(", ")}) ` +
      "on many comps in one call: pick the comps by comp_ids, a folder_id (subfolders included), nested_in (every comp inside a comp) or a name_pattern, and give op {tool, args} without comp_id and expect. " +
      "Each comp goes through that tool's own handler, so its guard, undo group and separate-evalScript read-back stay in force, and comps are written one at a time with a pause so AE's UI keeps up. " +
      "The result is a per-comp table (ok, skipped, failed, unverified) with an optional fingerprint hash before and after. " +
      "Layers must be picked by name (index and id selectors are refused for more than one comp); a comp without the named layer is skipped, not failed. " +
      "The comp list is frozen in <project>.jobs.json at the start; a stopped job (on_failure 'stop', a guard failure, a failed read-back) resumes with resume_job_id. Nothing is retried within a run. " +
      "Each comp is its own undo step; the way back across the whole job is the automatic checkpoint (ae_checkpoint_revert). dry_run resolves the comps and checks arguments and layer names without writing. " +
      "It sets no comp size, length or frame rate: no typed write tool does that yet. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMultiCompApplySchema,
    handler: multiCompApply,
  },
];
