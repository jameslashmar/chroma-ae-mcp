/**
 * server/src/tools/ext/projectsettings.ts
 *
 * ae_project_settings: the Project Settings dialog's values.
 * - Without `set` it reads them: bit depth, working colour space (with the
 *   profile list AE offers), gamma, linear blending, expression engine, time
 *   display, frame counting, display start frame, feet+frames, footage timecode
 *   start, transparency grid thumbnails, GPU acceleration (with the types this
 *   machine offers), and a probe for colour-management members the Guide does
 *   not document (reported as found or not found, never assumed).
 * - With `set` it writes them as one guarded write (checkpoint first, a
 *   separate read-back), after validating every value before the undo group.
 *   After an expression engine switch it scans the comps' expressions for new
 *   errors.
 *
 * ae_preflight points its project_spec fixes here with
 * `set: { bits_per_channel | working_space | expression_engine }`: keep those names.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read shape ----------

export interface ProjectSettingsInfo {
  bits_per_channel?: number;
  working_space?: string;
  working_gamma?: number;
  linear_blending?: boolean;
  linearize_working_space?: boolean;
  compensate_for_scene_referred_profiles?: boolean;
  expression_engine?: string;
  time_display_type?: string;
  frames_count_type?: string;
  display_start_frame?: number;
  project_path?: string;
  frames_use_feet_frames?: boolean;
  feet_frames_film_type?: string;
  footage_timecode_display_start_type?: string;
  transparency_grid_thumbnails?: boolean;
  gpu_accel_type?: string;
  list_color_profiles: string[];
  list_color_profiles_truncated?: boolean;
  available_gpu_types: string[];
  probed: { found: Record<string, unknown>; not_found: string[] };
  /** Members this AE build did not let the host read (older AE, or a member that does not exist). */
  unreadable: string[];
  ae_version?: string;
  comps?: Array<{ id: number; name: string }>;
  comps_truncated?: boolean;
}

const infoOf = (v: unknown): ProjectSettingsInfo | null => (v && typeof v === "object" ? (v as ProjectSettingsInfo) : null);

export const SETTING_KEYS = [
  "bits_per_channel",
  "working_space",
  "working_gamma",
  "linear_blending",
  "linearize_working_space",
  "compensate_for_scene_referred_profiles",
  "expression_engine",
  "time_display_type",
  "frames_count_type",
  "display_start_frame",
  "frames_use_feet_frames",
  "feet_frames_film_type",
  "footage_timecode_display_start_type",
  "transparency_grid_thumbnails",
  "gpu_accel_type",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

// ---------- schemas ----------

const enumName = (what: string) =>
  z
    .string()
    .min(1)
    .max(60)
    .describe(`${what} The read lists lower-case names; case is ignored when you give one, but any other name is refused.`);

/** The reported name of a frame counting value ('FC_START_1' and 'start_1' both give 'start_1'). */
function canonFramesCount(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const l = v.toLowerCase();
  return l.indexOf("fc_") === 0 ? l.substring(3) : l;
}

export const ProjectSettingsValuesSchema = z
  .object({
    bits_per_channel: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional().describe("Colour depth: 8, 16 or 32 bits per channel."),
    working_space: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Working colour space, by the exact string the read lists in `list_color_profiles` (case and spacing included). '' sets None. The tool refuses any other string before touching After Effects."
      ),
    working_gamma: z
      .union([z.literal(2.2), z.literal(2.4)])
      .optional()
      .describe("Working gamma, 2.2 or 2.4 (AE throws on any other value). Only meaningful with working_space '' (None): refused while a working space is set."),
    linear_blending: z.boolean().optional().describe("Blend colours with a linear gamma of 1.0 (Linearize / Blend Colors Using 1.0 Gamma)."),
    linearize_working_space: z.boolean().optional().describe("Linearize Working Space (AE 16.0+). The result says when this AE does not have it."),
    compensate_for_scene_referred_profiles: z
      .boolean()
      .optional()
      .describe("Compensate for Scene-referred Profiles (AE 16.0+). The result says when this AE does not have it."),
    expression_engine: z
      .enum(["extendscript", "javascript-1.0"])
      .optional()
      .describe(
        "Expression engine: 'extendscript' (Legacy ExtendScript) or 'javascript-1.0' (JavaScript). Switching can break existing expressions: the result then lists NEW expression errors in the project's comps (up to 10 comps checked)."
      ),
    time_display_type: enumName("Time display style, e.g. 'timecode' or 'frames'.").optional(),
    frames_count_type: enumName(
      "Frame counting: 'start_0', 'start_1' or 'timecode_conversion'. 'timecode_conversion' resets display_start_frame (the result reports it), so it can't be combined with display_start_frame in one call."
    ).optional(),
    display_start_frame: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .describe(
        "0 or 1: another way to set the Frame Count menu to start_0 or start_1. Don't combine it with a frames_count_type that disagrees (start_0 with 0, start_1 with 1), nor with 'timecode_conversion'."
      ),
    frames_use_feet_frames: z.boolean().optional().describe("Show frames as feet + frames."),
    feet_frames_film_type: enumName("Film type for feet + frames, e.g. 'mm16' or 'mm35'.").optional(),
    footage_timecode_display_start_type: enumName("Footage start timecode display: 'start_0' or 'use_source_media'.").optional(),
    transparency_grid_thumbnails: z.boolean().optional().describe("Show thumbnails with the transparency grid."),
    gpu_accel_type: enumName(
      "GPU acceleration, by a name the read lists in `available_gpu_types` (the tool refuses a type this machine does not offer). Changing it can make After Effects re-initialise the GPU, which may take a moment."
    ).optional(),
  })
  .strict()
  .refine((s) => Object.values(s).some((v) => v !== undefined), { message: "set needs at least one setting." })
  .refine((s) => !(typeof s.working_gamma === "number" && typeof s.working_space === "string" && s.working_space !== ""), {
    message: "working_gamma is ignored once a working space is set: give working_space '' with it, or leave the gamma out.",
  })
  .refine((s) => !(canonFramesCount(s.frames_count_type) === "timecode_conversion" && s.display_start_frame !== undefined), {
    message: "frames_count_type 'timecode_conversion' resets display_start_frame: leave display_start_frame out.",
  })
  .refine(
    (s) => {
      const c = canonFramesCount(s.frames_count_type);
      if (s.display_start_frame === undefined || (c !== "start_0" && c !== "start_1")) return true;
      return (c === "start_0" ? 0 : 1) === s.display_start_frame;
    },
    { message: "frames_count_type and display_start_frame set the same Frame Count menu and disagree: use start_0 with 0 and start_1 with 1, or give only one." }
  );

export type ProjectSettingsValues = z.infer<typeof ProjectSettingsValuesSchema>;

export const AeProjectSettingsSchema = z
  .object({
    set: ProjectSettingsValuesSchema.optional().describe("Settings to change (snake_case, enum values as strings). Leave it out to read every setting."),
    expect: ExpectSchema.optional().describe("Required with `set`: the open project's path, so the change lands in the right project."),
    check_comps: z
      .array(z.number().int())
      .max(20)
      .optional()
      .describe("With an expression_engine change: the comp ids whose expressions are scanned for new errors. Default: the first 10 comps in the project."),
  })
  .refine((v) => !v.set || v.expect !== undefined, { message: "Changing project settings needs expect.project_path." })
  .refine((v) => v.set?.expression_engine !== undefined || v.check_comps === undefined, { message: "check_comps applies to an expression_engine change only." });

type Args = z.infer<typeof AeProjectSettingsSchema>;

// ---------- pure logic ----------

// AE may store the gamma as a float32 (2.2 reads back as 2.2000000477).
const GAMMA_TOL = 1e-4;

const sameValue = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < GAMMA_TOL : a === b;

const askedKeys = (set: ProjectSettingsValues): SettingKey[] => SETTING_KEYS.filter((k) => set[k] !== undefined);

export interface WriteResult extends Record<string, unknown> {
  no_op?: boolean;
  changed?: Array<{ key: string; from: unknown; to: unknown }>;
  unchanged?: string[];
  failed?: Array<{ key: string; message: string }>;
  display_start_frame_reset?: boolean;
  expression_engine_changed?: boolean;
}

/** Settings the read-back should show, checked against what was asked. */
export function projectSettingsMismatches(set: ProjectSettingsValues, afterRaw: unknown, written: WriteResult): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  for (const f of written.failed ?? []) {
    m.push({ path: `set.${f.key}`, expected: (set as Record<string, unknown>)[f.key], actual: f.message, message: `After Effects refused ${f.key}: ${f.message}` });
  }
  const after = infoOf(afterRaw);
  if (!after) return m;
  const failedKeys = new Set((written.failed ?? []).map((f) => f.key));
  for (const key of askedKeys(set)) {
    if (failedKeys.has(key)) continue;
    const want = set[key];
    const got = after[key];
    if (got === undefined) {
      m.push({ path: `set.${key}`, expected: want, actual: undefined, message: "This setting could not be read back" });
      continue;
    }
    const wantNorm = typeof want === "string" && key !== "working_space" ? want.toLowerCase() : want;
    expectThat(m, sameValue(got, wantNorm), `set.${key}`, want, got, "Setting differs");
  }
  if (set.display_start_frame !== undefined && set.frames_count_type === undefined && !failedKeys.has("display_start_frame")) {
    const wantType = set.display_start_frame === 1 ? "start_1" : "start_0";
    const gotType = after.frames_count_type;
    if (gotType !== undefined) {
      expectThat(m, gotType === wantType, "set.display_start_frame", set.display_start_frame, gotType, `Frame Count menu is '${String(gotType)}', not '${wantType}'`);
    }
  }
  return m;
}

/** Settings that moved though they were not asked for (AE links some of them), for the report. */
export function sideEffects(set: ProjectSettingsValues, beforeRaw: unknown, afterRaw: unknown): Array<{ key: string; from: unknown; to: unknown }> {
  const before = infoOf(beforeRaw);
  const after = infoOf(afterRaw);
  if (!before || !after) return [];
  const asked = new Set<string>(askedKeys(set));
  const out: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const key of SETTING_KEYS) {
    if (asked.has(key)) continue;
    if (before[key] !== undefined && after[key] !== undefined && !sameValue(before[key], after[key])) {
      out.push({ key, from: before[key], to: after[key] });
    }
  }
  return out;
}

// ---------- expression scan after an engine switch ----------

interface ExprEntry {
  layer?: { index?: number; id?: number; name?: string };
  path?: string[];
  error?: string;
}
interface ValidateResult {
  comp_id: number;
  comp_name?: string;
  error_count?: number;
  results?: ExprEntry[];
  truncated?: boolean;
}

const MAX_SCANNED_COMPS = 10;
const exprKey = (compId: number, e: ExprEntry) => `${compId}|${e.layer?.id}|${(e.path ?? []).join(">")}`;

/** Expression errors present after the engine switch that were not there before it. */
export function newExpressionErrors(before: ValidateResult[], after: ValidateResult[]) {
  const had = new Set<string>();
  for (const b of before) for (const r of b.results ?? []) if (r.error) had.add(exprKey(b.comp_id, r));
  const out: Array<{ comp_id: number; comp_name?: string; errors: Array<{ layer?: ExprEntry["layer"]; path?: string[]; error?: string }> }> = [];
  for (const a of after) {
    const fresh = (a.results ?? []).filter((r) => r.error && !had.has(exprKey(a.comp_id, r))).map((r) => ({ layer: r.layer, path: r.path, error: r.error }));
    if (fresh.length > 0) out.push({ comp_id: a.comp_id, comp_name: a.comp_name, errors: fresh.slice(0, 20) });
  }
  return out;
}

async function softRead<T>(ctx: ToolContext, fn: string, args: Record<string, unknown>, label: string): Promise<T | null> {
  try {
    const res = await ctx.bridge.callHost<T>(fn, args, { label, mutates: false, toolName: "ae_project_settings" });
    return res.result;
  } catch {
    return null;
  }
}

async function scanComps(ctx: ToolContext, ids: number[], when: string): Promise<ValidateResult[]> {
  const out: ValidateResult[] = [];
  for (const id of ids) {
    const r = await softRead<ValidateResult>(ctx, "validateExpressions", { comp_id: id }, `ae_project_settings (validate expressions, ${when})`);
    if (r) out.push(r);
  }
  return out;
}

// ---------- tool ----------

async function readSettings(ctx: ToolContext) {
  const res = await ctx.bridge.callHost<ProjectSettingsInfo>(
    "projectsettingsRead",
    {},
    { label: "ae_project_settings (read)", mutates: false, toolName: "ae_project_settings" }
  );
  return { ok: true, ...res.result };
}

async function writeSettings(args: Args, ctx: ToolContext) {
  const set = args.set as ProjectSettingsValues;
  const keys = askedKeys(set);
  const wantEngine = set.expression_engine !== undefined;

  // Before an engine switch: which comps there are and which expressions already fail.
  let compIds: number[] = [];
  let compsTotal = 0;
  let compsTruncated = false;
  let scanBefore: ValidateResult[] | null = null;
  // A read-only guard check first, so a wrong expect doesn't scan the wrong project's comps.
  let guardOk = true;
  if (wantEngine) {
    const g = await softRead<{ ok?: boolean }>(ctx, "checkGuard", { expect: args.expect }, "ae_project_settings (guard before scan)");
    if (g && g.ok === false) guardOk = false;
  }
  if (wantEngine && guardOk) {
    const pre = await softRead<ProjectSettingsInfo>(ctx, "projectsettingsRead", { comps: true }, "ae_project_settings (comps before engine switch)");
    if (pre?.comps) {
      compsTotal = pre.comps.length;
      compsTruncated = pre.comps_truncated === true;
      compIds = args.check_comps ?? pre.comps.slice(0, MAX_SCANNED_COMPS).map((c) => c.id);
    } else if (args.check_comps) {
      compIds = args.check_comps;
    }
    if (pre && pre.expression_engine !== set.expression_engine && compIds.length > 0) {
      scanBefore = await scanComps(ctx, compIds, "before");
    }
  }

  const out = await runGuardedWrite<WriteResult>(ctx, {
    toolName: "ae_project_settings",
    label: `ae_project_settings(${keys.join(", ")})`,
    expect: args.expect!,
    read: () => ({ host: "projectsettingsRead", args: {} }),
    write: { host: "projectsettingsApply", args: { set, label: "Project settings" } },
    check: (_before, after, w) => projectSettingsMismatches(set, after, w),
    present: (before, after, w) => {
      const notes: string[] = [];
      if (w.no_op) notes.push("Every requested value was already set: nothing was changed.");
      if (w.display_start_frame_reset) notes.push("frames_count_type 'timecode_conversion' reset display_start_frame; read settings.display_start_frame for the new value.");
      if (set.gpu_accel_type !== undefined && !w.no_op) notes.push("Changing gpu_accel_type can make After Effects re-initialise the GPU; renders may be slow for a moment.");
      const side = sideEffects(set, before, after);
      return {
        changed: w.changed ?? [],
        unchanged: w.unchanged ?? [],
        failed: w.failed ?? [],
        ...(w.no_op ? { no_op: true } : {}),
        display_start_frame_reset: w.display_start_frame_reset === true,
        expression_engine_changed: w.expression_engine_changed === true,
        settings: after,
        ...(side.length > 0 ? { side_effects: side } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      };
    },
  });

  // The write is applied: nothing below may throw.
  if ((out as { expression_engine_changed?: boolean }).expression_engine_changed === true) {
    try {
      const scanAfter = compIds.length > 0 ? await scanComps(ctx, compIds, "after") : [];
      const fresh = newExpressionErrors(scanBefore ?? [], scanAfter);
      return {
        ...out,
        expression_check: {
          comps_checked: scanAfter.length,
          comps_in_project: compsTotal || undefined,
          comps_not_checked: compsTruncated || (compsTotal > compIds.length && !args.check_comps) ? true : undefined,
          compared_with_before: scanBefore !== null,
          new_error_comps: fresh,
          new_error_count: fresh.reduce((n, c) => n + c.errors.length, 0),
          note:
            scanBefore === null
              ? "The comps' expressions could not be scanned before the switch, so every error found is listed."
              : "Errors that already existed before the switch are not listed.",
        },
      };
    } catch {
      return { ...out, expression_check: { failed: true, note: "The expression scan failed; run validateExpressions on the comps by hand." } };
    }
  }
  return out;
}

export const projectsettingsTools: ToolDefinition<any>[] = [
  {
    name: "ae_project_settings",
    description:
      "Read or change the project's own settings (Project Settings dialog). Without `set` it only reads: bit depth, working colour space plus every profile string AE offers (list_color_profiles), working gamma (2.2 or 2.4, ignored once a working space is set), linear blending, " +
      "linearize working space and compensate for scene-referred profiles (AE 16.0+), expression engine, time display type, frame counting (start_0 / start_1 / timecode_conversion), display start frame, feet+frames, footage timecode start, transparency grid thumbnails, " +
      "and GPU acceleration with the types this machine offers (available_gpu_types). `probed` lists colour-management members (OCIO, ACES, display colour space, LUT interpolation) found or not found on this build; they are not documented, so none is assumed to exist. " +
      "With `set` ({ bits_per_channel, working_space, expression_engine, ... }) it changes them in one undo group, checkpointing first because some settings may not be undoable. " +
      "Every value is checked before After Effects is touched: working_space must match a listed profile exactly, working_gamma only 2.2 or 2.4 and only with working_space '', gpu_accel_type must be available here, and a member this AE version lacks is reported instead of guessed. " +
      "frames_count_type 'timecode_conversion' resets display_start_frame (reported). After an expression_engine switch the result lists NEW expression errors in the project's comps. The read-back (a separate evalScript) checks each setting and lists side effects. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeProjectSettingsSchema,
    handler: async (args: Args, ctx) => (args.set ? writeSettings(args, ctx) : readSettings(ctx)),
  },
];
