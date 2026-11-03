/**
 * server/src/tools/ext/compsettings.ts
 *
 * Comp-level settings no other tool reaches:
 * - ae_get_comp_settings: reads motion blur (shutter, samples), frame blending,
 *   renderer and the installed renderers, draft 3D, resolution factor,
 *   background colour, shy, preserve nested, display start, work area and
 *   guides; optionally compares size, fps, length and motion blur with a brief
 * - ae_comp_settings: sets any of them and adds, moves or removes guides, as
 *   one guarded write with a read-back in a separate evalScript
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read shape ----------

export interface GuideInfo {
  index: number;
  orientation_type?: number;
  position_type?: number;
  position?: number;
  pinned?: boolean;
  color?: number[];
}

export interface CompSettingsInfo {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  frame_duration: number;
  duration: number;
  motion_blur?: boolean;
  shutter_angle?: number;
  shutter_phase?: number;
  motion_blur_samples?: number;
  motion_blur_adaptive_limit?: number;
  frame_blending?: boolean;
  draft_3d?: boolean;
  hide_shy_layers?: boolean;
  preserve_nested_frame_rate?: boolean;
  preserve_nested_resolution?: boolean;
  display_start_time?: number;
  display_start_frame?: number;
  renderer?: string;
  renderers?: string[];
  resolution_factor?: number[];
  background_color?: number[];
  work_area?: { start: number; duration: number };
  guides: GuideInfo[];
  guide_count: number;
  guides_truncated?: boolean;
  /** Settings this AE build did not let the host read. */
  unreadable?: string[];
  ae_version?: string;
}

const infoOf = (v: unknown): CompSettingsInfo | null => (v && typeof v === "object" ? (v as CompSettingsInfo) : null);

// ---------- schemas ----------

const Color3 = z.array(z.number().min(0).max(1)).length(3);

export const CompSettingsValuesSchema = z
  .object({
    motion_blur: z.boolean().optional().describe("The comp's Enable Motion Blur switch. Layers still need their own motion blur switch on."),
    shutter_angle: z.number().int().min(0).max(720).optional().describe("Shutter angle in degrees, 0..720."),
    shutter_phase: z.number().int().min(-360).max(360).optional().describe("Shutter phase in degrees, -360..360."),
    motion_blur_samples: z.number().int().min(2).max(64).optional().describe("Samples per frame for motion blur, 2..64."),
    motion_blur_adaptive_limit: z.number().int().min(16).max(256).optional().describe("Adaptive sample limit for motion blur, 16..256."),
    frame_blending: z.boolean().optional().describe("The comp's Enable Frame Blending switch (layers still need their own frame blending mode)."),
    renderer: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Renderer, by the exact string ae_get_comp_settings lists in `renderers` (internal names, not the UI labels). The tool refuses a renderer the comp doesn't offer."
      ),
    draft_3d: z.boolean().optional().describe("Draft 3D switch."),
    resolution_factor: z
      .array(z.number().int().min(1).max(99))
      .length(2)
      .optional()
      .describe(
        "Comp resolution as [x, y] divisors: [1, 1] is Full, [2, 2] Half. This changes what ae_snapshot_frame and other renders produce until it is put back."
      ),
    background_color: Color3.optional().describe("Comp background colour [r, g, b] in 0..1."),
    hide_shy_layers: z.boolean().optional().describe("Hide Shy Layers switch."),
    preserve_nested_frame_rate: z.boolean().optional(),
    preserve_nested_resolution: z.boolean().optional(),
    display_start_time: z.number().min(-10800).max(86339).optional().describe("Comp start time in seconds (the timecode shown at the comp's first frame)."),
    display_start_frame: z.number().int().optional().describe(
        "Comp start frame (AE 17.1+). Give this or display_start_time, not both. Frame * the comp's frame duration must land in -10800..86339 s; the tool checks that against the comp's rate and refuses before touching AE."
      ),
    work_area: z
      .object({
        start: z.number().min(0).optional().describe("Work area start in seconds."),
        duration: z.number().positive().optional().describe("Work area length in seconds, at least one frame."),
      })
      .refine((w) => w.start !== undefined || w.duration !== undefined, { message: "work_area needs start or duration." })
      .optional()
      .describe("Work area. start + duration must not pass the comp's length; the tool refuses it before touching AE."),
  })
  .strict()
  .refine((s) => !(s.display_start_time !== undefined && s.display_start_frame !== undefined), {
    message: "Give display_start_time or display_start_frame, not both.",
  });

export const GuideOpSchema = z
  .object({
    action: z.enum(["add", "set", "remove"]),
    orientation: z.enum(["horizontal", "vertical"]).optional().describe("add: the new guide's direction."),
    index: z.number().int().min(0).optional().describe("set / remove: 0-based index of the guide, as ae_get_comp_settings lists it at that step."),
    position: z.number().min(-100000).max(100000).optional().describe("add / set: position in pixels from the comp's top-left."),
  })
  .refine((g) => g.action !== "add" || (g.orientation !== undefined && g.position !== undefined && g.index === undefined), {
    message: "add needs orientation and position, and no index.",
  })
  .refine((g) => g.action !== "set" || (g.index !== undefined && g.position !== undefined && g.orientation === undefined), {
    message: "set needs index and position (a guide can't change direction).",
  })
  .refine((g) => g.action !== "remove" || (g.index !== undefined && g.position === undefined && g.orientation === undefined), {
    message: "remove needs only an index.",
  });

export const AeCompSettingsSchema = z
  .object({
    comp_id: z.number().int(),
    settings: CompSettingsValuesSchema.optional().describe("Switches and values to set. Anything left out stays as it is."),
    guides: z
      .array(GuideOpSchema)
      .max(100)
      .optional()
      .describe(
        "Guide operations, applied in order; each index refers to the list as it is at that step (a remove shifts the later guides down by one)."
      ),
    expect: ExpectSchema,
  })
  .refine((v) => (v.settings !== undefined && Object.keys(v.settings).length > 0) || (v.guides !== undefined && v.guides.length > 0), {
    message: "Give at least one setting or guide operation.",
  });

export const AeGetCompSettingsSchema = z.object({
  comp_id: z.number().int(),
  match: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      duration_s: z.number().positive().optional(),
      motion_blur: z.boolean().optional(),
    })
    .strict()
    .optional()
    .describe("A brief's format (same field names as ae_brief: width, height, fps, duration_s) plus motion_blur. The result lists each field that differs."),
});

// ---------- pure logic ----------

export interface BriefDifference {
  field: string;
  wanted: unknown;
  actual: unknown;
}

type MatchArgs = NonNullable<z.infer<typeof AeGetCompSettingsSchema>["match"]>;

/** Compares a comp's settings with a brief's format; AE snaps lengths to frames, so duration gets a frame of slack. */
export function compareToBrief(info: CompSettingsInfo, match: MatchArgs): BriefDifference[] {
  const out: BriefDifference[] = [];
  if (match.width !== undefined && info.width !== match.width) out.push({ field: "width", wanted: match.width, actual: info.width });
  if (match.height !== undefined && info.height !== match.height) out.push({ field: "height", wanted: match.height, actual: info.height });
  if (match.fps !== undefined && Math.abs(info.fps - match.fps) > 0.001) out.push({ field: "fps", wanted: match.fps, actual: info.fps });
  if (match.duration_s !== undefined) {
    const tol = (info.frame_duration || 1 / (info.fps || 25)) * 1.01 + 1e-6;
    if (Math.abs(info.duration - match.duration_s) > tol) out.push({ field: "duration_s", wanted: match.duration_s, actual: info.duration });
  }
  if (match.motion_blur !== undefined && info.motion_blur !== match.motion_blur) {
    out.push({ field: "motion_blur", wanted: match.motion_blur, actual: info.motion_blur ?? null });
  }
  return out;
}

/** Applies guide operations to a guide list the way AE does: add appends, set moves, remove shifts the rest down. */
export function simulateGuides(
  before: Array<{ orientation_type?: number; position?: number }>,
  applied: Array<{ action: string; index?: number; position?: number; orientation_type?: number }>
): Array<{ orientation_type?: number; position?: number; added?: boolean }> {
  const list: Array<{ orientation_type?: number; position?: number; added?: boolean }> = before.map((g) => ({ ...g }));
  for (const step of applied) {
    if (step.action === "add") list.push({ orientation_type: step.orientation_type, position: step.position, added: true });
    else if (step.action === "set" && step.index !== undefined && list[step.index]) list[step.index].position = step.position;
    else if (step.action === "remove" && step.index !== undefined) list.splice(step.index, 1);
  }
  return list;
}

type SettingsArgs = z.infer<typeof AeCompSettingsSchema>;

const BOOL_KEYS = [
  "motion_blur",
  "frame_blending",
  "draft_3d",
  "hide_shy_layers",
  "preserve_nested_frame_rate",
  "preserve_nested_resolution",
] as const;
const INT_KEYS = ["shutter_angle", "shutter_phase", "motion_blur_samples", "motion_blur_adaptive_limit"] as const;
const FRAME_KEYS = ["display_start_time", "display_start_frame"] as const;

const sameList = (a: unknown, b: number[], tol = 0) =>
  Array.isArray(a) && a.length === b.length && b.every((v, i) => Math.abs((a[i] as number) - v) <= tol);

/** What the read after the write should show, checked against what was asked. */
export function compSettingsMismatches(args: SettingsArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = infoOf(beforeRaw);
  const after = infoOf(afterRaw);
  if (!after) return m;
  const s: NonNullable<SettingsArgs["settings"]> = args.settings ?? {};
  const unreadable = new Set(after.unreadable ?? []);
  const missing = (key: string) => {
    m.push({ path: `settings.${key}`, expected: (s as Record<string, unknown>)[key], actual: undefined, message: "This setting could not be read back" });
  };

  for (const key of BOOL_KEYS) {
    if (s[key] === undefined) continue;
    if (after[key] === undefined) missing(key);
    else expectThat(m, after[key] === s[key], `settings.${key}`, s[key], after[key], "Setting differs");
  }
  for (const key of INT_KEYS) {
    if (s[key] === undefined) continue;
    if (after[key] === undefined) missing(key);
    else expectThat(m, after[key] === s[key], `settings.${key}`, s[key], after[key], "Setting differs (AE may have clamped it against a related value)");
  }
  // Start time and start frame are one value; AE snaps it to a frame.
  const frameTol = (after.frame_duration || 0.05) * 1.01 + 1e-6;
  if (s.display_start_time !== undefined) {
    if (after.display_start_time === undefined) missing("display_start_time");
    else expectThat(m, Math.abs(after.display_start_time - s.display_start_time) <= frameTol, "settings.display_start_time", s.display_start_time, after.display_start_time, "Start time differs");
  }
  if (s.display_start_frame !== undefined) {
    if (after.display_start_frame === undefined) missing("display_start_frame");
    else expectThat(m, after.display_start_frame === s.display_start_frame, "settings.display_start_frame", s.display_start_frame, after.display_start_frame, "Start frame differs");
  }
  if (s.renderer !== undefined) {
    if (unreadable.has("renderer") || after.renderer === undefined) missing("renderer");
    else expectThat(m, after.renderer === s.renderer, "settings.renderer", s.renderer, after.renderer, "Renderer differs");
  }
  if (s.resolution_factor !== undefined) {
    if (after.resolution_factor === undefined) missing("resolution_factor");
    else expectThat(m, sameList(after.resolution_factor, s.resolution_factor), "settings.resolution_factor", s.resolution_factor, after.resolution_factor, "Resolution factor differs");
  }
  if (s.background_color !== undefined) {
    if (after.background_color === undefined) missing("background_color");
    else expectThat(m, sameList(after.background_color, s.background_color, 0.004), "settings.background_color", s.background_color, after.background_color, "Background colour differs");
  }
  if (s.work_area !== undefined) {
    // The host reports the area it wrote (after filling in what was left out and clamping float overshoot).
    const want = (written.work_area as { start: number; duration: number } | undefined) ?? undefined;
    if (!want) {
      m.push({ path: "settings.work_area", expected: s.work_area, actual: after.work_area, message: "The host did not report the work area it wrote" });
    } else if (!after.work_area) {
      missing("work_area");
    } else {
      expectThat(m, Math.abs(after.work_area.start - want.start) <= frameTol, "settings.work_area.start", want.start, after.work_area.start, "Work area start differs");
      expectThat(m, Math.abs(after.work_area.duration - want.duration) <= frameTol * 2, "settings.work_area.duration", want.duration, after.work_area.duration, "Work area length differs");
    }
  }

  // Guides: the list AE should hold after the operations.
  const applied = (written.guides_applied as Array<{ action: string; index?: number; position?: number; orientation_type?: number }> | undefined) ?? [];
  if (args.guides && args.guides.length > 0) {
    if (applied.length !== args.guides.length) {
      m.push({ path: "guides", expected: args.guides.length, actual: applied.length, message: "The host applied a different number of guide operations" });
    }
    if (before && !before.guides_truncated && !after.guides_truncated && !unreadable.has("guides")) {
      const want = simulateGuides(before.guides, applied);
      expectThat(m, after.guide_count === want.length, "guides.length", want.length, after.guide_count, "Guide count differs");
      if (after.guide_count === want.length) {
        // Positions are written in pixels. On builds where guides can be positioned in
        // percent, a guide whose position type differs from the one the added guides
        // read back with is not comparable, so it is skipped.
        const addedIdx = want.findIndex((g) => g.added);
        const pixelType = addedIdx >= 0 ? after.guides[addedIdx]?.position_type : undefined;
        want.forEach((g, i) => {
          const got = after.guides[i];
          if (!got) return;
          const comparable = pixelType === undefined || got.position_type === undefined || got.position_type === pixelType;
          if (comparable && g.position !== undefined && got.position !== undefined) {
            expectThat(m, Math.abs(got.position - g.position) <= 0.01, `guides[${i}].position`, g.position, got.position, "Guide position differs");
          }
          if (g.orientation_type !== undefined && got.orientation_type !== undefined) {
            expectThat(m, got.orientation_type === g.orientation_type, `guides[${i}].orientation_type`, g.orientation_type, got.orientation_type, "Guide direction differs");
          }
        });
      }
    }
  }

  // Nothing else should have moved. Linked pairs (start time / frame) are skipped when either was set.
  if (before) {
    const asked = (k: string) => (s as Record<string, unknown>)[k] !== undefined;
    const skipFrames = FRAME_KEYS.some(asked);
    const watched: Array<keyof CompSettingsInfo> = [...BOOL_KEYS, ...INT_KEYS, "renderer"];
    if (!skipFrames) watched.push("display_start_frame");
    for (const key of watched) {
      if (asked(key as string)) continue;
      if (before[key] !== undefined && after[key] !== undefined && before[key] !== after[key]) {
        m.push({ path: `settings.${String(key)}`, expected: before[key], actual: after[key], message: `${String(key)} changed too, though it was not asked for` });
      }
    }
    for (const key of ["width", "height", "fps", "duration"] as const) {
      expectThat(m, before[key] === after[key], key, before[key], after[key], `The comp's ${key} changed`);
    }
    if (!asked("resolution_factor") && before.resolution_factor && after.resolution_factor && !sameList(after.resolution_factor, before.resolution_factor)) {
      m.push({ path: "settings.resolution_factor", expected: before.resolution_factor, actual: after.resolution_factor, message: "resolution_factor changed too, though it was not asked for" });
    }
  }
  return m;
}

// ---------- tools ----------

const keysOf = (args: SettingsArgs) => {
  const keys = Object.keys(args.settings ?? {}).filter((k) => (args.settings as Record<string, unknown>)[k] !== undefined);
  if (args.guides && args.guides.length > 0) keys.push("guides");
  return keys;
};

export const compsettingsTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_comp_settings",
    description:
      "Read a comp's own settings: motion blur (switch, shutter angle and phase, samples, adaptive limit), frame blending, renderer and the renderers this comp offers, draft 3D, resolution factor, background colour, " +
      "hide shy, preserve nested frame rate and resolution, display start time and frame, work area, and its guides (0-based index, direction, position). " +
      "Pass `match` (width, height, fps, duration_s, motion_blur) to list the fields that differ from a brief. Changes nothing in After Effects. Settings this AE build can't read are listed in `unreadable`.",
    schema: AeGetCompSettingsSchema,
    handler: async (args: z.infer<typeof AeGetCompSettingsSchema>, ctx) => {
      const res = await ctx.bridge.callHost<CompSettingsInfo>(
        "compsettingsRead",
        { comp_id: args.comp_id },
        { label: `ae_get_comp_settings(${args.comp_id})`, mutates: false, toolName: "ae_get_comp_settings" }
      );
      if (!args.match) return res.result;
      const differences = compareToBrief(res.result, args.match);
      return { ...res.result, match: { ok: differences.length === 0, differences } };
    },
  },
  {
    name: "ae_comp_settings",
    description:
      "Set comp-level switches: motion blur on/off, shutter angle and phase, samples per frame and adaptive limit, frame blending, renderer (validated against the comp's installed renderers), draft 3D, " +
      "resolution factor, background colour, hide shy, preserve nested frame rate / resolution, display start (time or frame), work area, and add, move or remove the comp's guides, " +
      "in one undo group guarded by `expect`. Every value is range-checked before After Effects is touched, and the work area is refused if it would pass the comp's length. " +
      "resolution_factor changes what snapshots and renders produce until it is put back; the result flags it. " +
      "The read-back (a separate evalScript) checks each setting, the guide list, and that nothing you did not ask for changed. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCompSettingsSchema,
    handler: (args: SettingsArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_comp_settings",
        label: `ae_comp_settings(${keysOf(args).join(", ")})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "compsettingsRead", args: { comp_id: args.comp_id } }),
        write: {
          host: "compsettingsApply",
          args: { comp_id: args.comp_id, settings: args.settings, guides: args.guides, label: "Comp settings" },
        },
        check: (before, after, w) => compSettingsMismatches(args, before, after, w),
        present: (_before, after, w) => ({
          comp_id: args.comp_id,
          changed: w.changed,
          settings: after,
          guide_api: w.guide_api,
          ...(w.guide_orientation_unverified
            ? { guide_orientation_unverified: true, note: "This build may use different guide orientation integers; the direction of the added guides was not verified." }
            : {}),
          ...(w.resolution_factor_written
            ? { warning: "resolution_factor was changed: snapshots and renders use it until it is set back (the comp's previous value is in the receipt's before)." }
            : {}),
        }),
      }),
  },
];
