/**
 * server/src/tools/ext/compsettings.ts
 *
 * Comp-level settings no other tool reaches:
 * - ae_get_comp_settings: reads motion blur (shutter, samples), frame blending,
 *   renderer and the installed renderers, draft 3D, resolution factor,
 *   background colour, shy, preserve nested, display start, work area and
 *   guides; optionally compares size, fps, length and motion blur with a brief
 * - ae_comp_settings: sets any of them and adds, moves or removes guides, as
 *   one guarded write with a read-back in a separate evalScript. It also does
 *   the Composition Settings dialog edits: name, resize around an anchor,
 *   pixel aspect, frame rate, drop frame, length (extending the layers that ran
 *   to the old end) and trim to the work area. On AE 26.5+ guides take colour,
 *   pinned and a percentage position.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read shape ----------

export interface GuideInfo {
  index: number;
  /** Raw integer from AE: its meaning differs between AE versions, so compare `orientation` instead. */
  orientation_type?: number;
  /** Raw integer from AE: its meaning differs between AE versions, so compare `position_kind` instead. */
  position_type?: number;
  /** Stable form of orientation_type, mapped through AE's enum constants. */
  orientation?: "horizontal" | "vertical";
  /** Stable form of position_type: pixels or percent of the comp. */
  position_kind?: "pixel" | "percentage";
  position?: number;
  pinned?: boolean;
  color?: number[];
}

export interface LayerState {
  id: number;
  index: number;
  in?: number;
  out?: number;
  start?: number;
  position?: number[];
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
  pixel_aspect?: number;
  drop_frame?: boolean;
  /** Per layer in/out/start and Position (x, y), only when the read was asked for it. */
  layer_state?: LayerState[];
  layer_state_truncated?: boolean;
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

export const ANCHORS = ["center", "top_left", "top", "top_right", "left", "right", "bottom_left", "bottom", "bottom_right"] as const;
export type Anchor = (typeof ANCHORS)[number];

export const CompSizeSchema = z
  .object({
    width: z.number().int().min(4).max(30000),
    height: z.number().int().min(4).max(30000),
    anchor: z
      .enum(ANCHORS)
      .default("center")
      .describe(
        "Which part of the old frame stays put, like the Anchor grid in Composition Settings (default center). Top-level layers (and their keyframes), cameras, lights and pixel guides move by the difference; parented layers follow their parents."
      ),
  })
  .strict();

export const CompDurationSchema = z
  .object({
    seconds: z.number().positive().max(10800).optional().describe("New length in seconds, at most 10800 (3 hours)."),
    frames: z.number().int().min(1).max(1069200).optional().describe("New length in frames at the comp's frame rate after this call (so frame_rate in the same call counts)."),
    extend_layers: z
      .boolean()
      .default(true)
      .describe(
        "When the comp gets longer: layers whose out point sat at the old end move to the new end. Footage and nested comps without time remap that end sooner are left alone and listed under duration_change.skipped."
      ),
  })
  .strict()
  .refine((d) => (d.seconds === undefined) !== (d.frames === undefined), { message: "Give duration.seconds or duration.frames, not both." });

export const CompSettingsValuesSchema = z
  .object({
    name: z.string().min(1).max(255).optional().describe("Rename the comp."),
    size: CompSizeSchema.optional().describe(
      "Resize the comp around an anchor. A scripted resize pins layers to the top-left; this moves every top-level layer's Position (keys included, separated dimensions too) by the anchor's share of the change. Layers with a Position expression and audio-only layers are skipped and listed in resize.layers_skipped."
    ),
    pixel_aspect: z.number().min(0.01).max(100).optional().describe("Pixel aspect ratio, 0.01..100 (1 is square pixels)."),
    frame_rate: z
      .number()
      .min(1)
      .max(99)
      .optional()
      .describe("Frame rate, 1..99. Keyframes that now fall between frames are not moved; they are counted and sampled in keys_off_frame."),
    duration: CompDurationSchema.optional().describe("New comp length, in seconds or frames, optionally extending the layers that ran to the old end."),
    drop_frame: z.boolean().optional().describe("Drop-frame timecode. true is only accepted at 29.97 or 59.94 fps (the rate after this call); false always works."),
    trim_to_work_area: z
      .literal(true)
      .optional()
      .describe(
        "Trim the comp to its work area: every layer (locked ones too, locked again afterwards) and comp marker shifts back by the work area start, the comp becomes as long as the work area, the work area restarts at 0 and the displayed timecode is kept. Markers outside the new length are dropped. Not combinable with duration, work_area or display_start_*."
      ),
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
      .strict()
      .refine((w) => w.start !== undefined || w.duration !== undefined, { message: "work_area needs start or duration." })
      .optional()
      .describe("Work area. start + duration must not pass the comp's length; the tool refuses it before touching AE."),
  })
  .strict()
  .refine((s) => !(s.display_start_time !== undefined && s.display_start_frame !== undefined), {
    message: "Give display_start_time or display_start_frame, not both.",
  })
  .refine(
    (s) => !s.trim_to_work_area || (s.duration === undefined && s.work_area === undefined && s.display_start_time === undefined && s.display_start_frame === undefined),
    { message: "trim_to_work_area can't be combined with duration, work_area or display_start_*." }
  );

export const GuideOpSchema = z
  .object({
    action: z.enum(["add", "set", "remove"]),
    orientation: z.enum(["horizontal", "vertical"]).optional().describe("add: the new guide's direction."),
    index: z.number().int().min(0).optional().describe("set / remove: 0-based index of the guide, as ae_get_comp_settings lists it at that step."),
    position: z
      .number()
      .min(-100000)
      .max(100000)
      .optional()
      .describe("add / set: position from the comp's top-left, in pixels (or percent of the comp when position_type is percentage). Guide positions are in the comp's size AFTER any size change in the same call."),
    color: Color3.optional().describe("add / set, AE 26.5+: guide colour [r, g, b] in 0..1. Refused on older builds."),
    pinned: z
      .boolean()
      .optional()
      .describe("add / set, AE 26.5+: pins the guide to the bottom or right edge so it keeps its distance from that edge on a resize. This is not a lock. Refused on older builds."),
    position_type: z
      .enum(["pixel", "percentage"])
      .optional()
      .describe("add / set, AE 26.5+: whether position is in pixels or percent of the comp. Refused on older builds."),
  })
  .strict()
  .refine((g) => g.action !== "add" || (g.orientation !== undefined && g.position !== undefined && g.index === undefined), {
    message: "add needs orientation and position, and no index.",
  })
  .refine((g) => g.action !== "set" || (g.index !== undefined && g.position !== undefined && g.orientation === undefined), {
    message: "set needs index and position (a guide can't change direction).",
  })
  .refine(
    (g) =>
      g.action !== "remove" ||
      (g.index !== undefined && g.position === undefined && g.orientation === undefined && g.color === undefined && g.pinned === undefined && g.position_type === undefined),
    { message: "remove needs only an index." }
  );

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

/** The share of a size change each anchor leaves on the left/top side: [x, y], 0 = pinned left/top, 1 = pinned right/bottom. */
const ANCHOR_FRACTIONS: Record<Anchor, [number, number]> = {
  center: [0.5, 0.5],
  top_left: [0, 0],
  top: [0.5, 0],
  top_right: [1, 0],
  left: [0, 0.5],
  right: [1, 0.5],
  bottom_left: [0, 1],
  bottom: [0.5, 1],
  bottom_right: [1, 1],
};

/** How far top-level layers and pixel guides move for a resize around an anchor (the host does the same sums). */
export function anchorDelta(from: { width: number; height: number }, to: { width: number; height: number }, anchor: Anchor = "center"): { dx: number; dy: number } {
  const f = ANCHOR_FRACTIONS[anchor];
  return { dx: (to.width - from.width) * f[0], dy: (to.height - from.height) * f[1] };
}

/** AE only offers drop-frame timecode at 29.97 and 59.94 fps. */
export function isDropFrameRate(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.005 || Math.abs(fps - 59.94) < 0.005;
}

/** The comp length in seconds a duration argument means at a frame rate. */
export function durationSeconds(d: { seconds?: number; frames?: number }, fps: number): number | null {
  if (d.seconds !== undefined) return d.seconds;
  if (d.frames !== undefined && fps > 0) return d.frames / fps;
  return null;
}

/**
 * Orientation word for a raw guide orientation integer. The integers differ between AE versions, so
 * the enum constants win when AE has them; the legacy meaning (0 horizontal, 1 vertical) is only for
 * builds without the enum. Mirrors the host (compsettings.jsx, fingerprint.jsx).
 */
export function guideOrientationName(raw: number, enumValues?: { HORIZONTAL?: number; VERTICAL?: number }): "horizontal" | "vertical" | null {
  if (enumValues) {
    if (enumValues.HORIZONTAL !== undefined && raw === enumValues.HORIZONTAL) return "horizontal";
    if (enumValues.VERTICAL !== undefined && raw === enumValues.VERTICAL) return "vertical";
    return null;
  }
  if (raw === 0) return "horizontal";
  if (raw === 1) return "vertical";
  return null;
}

/** Position kind for a raw guide position type integer, same rule as guideOrientationName. */
export function guidePositionKindName(raw: number, enumValues?: { PIXEL?: number; PERCENTAGE?: number }): "pixel" | "percentage" | null {
  if (enumValues) {
    if (enumValues.PIXEL !== undefined && raw === enumValues.PIXEL) return "pixel";
    if (enumValues.PERCENTAGE !== undefined && raw === enumValues.PERCENTAGE) return "percentage";
    return null;
  }
  if (raw === 0) return "pixel";
  if (raw === 1) return "percentage";
  return null;
}

export interface SimGuide {
  orientation?: string;
  orientation_type?: number;
  position_type?: number;
  position_kind?: string;
  position?: number;
  color?: number[];
  pinned?: boolean;
  added?: boolean;
}

export interface GuideStep {
  action: string;
  index?: number;
  position?: number;
  orientation?: string;
  orientation_type?: number;
  position_kind?: string;
  color?: number[];
  pinned?: boolean;
}

/**
 * Applies guide operations to a guide list the way AE does: add appends, set moves, remove shifts the rest down.
 * `touched[i]` says whether a step wrote guide i (added it or set it).
 */
function runGuideSteps(before: SimGuide[], applied: GuideStep[]): { list: SimGuide[]; touched: boolean[] } {
  const list: SimGuide[] = before.map((g) => ({ ...g }));
  const touched: boolean[] = list.map(() => false);
  for (const step of applied) {
    if (step.action === "add") {
      list.push({
        orientation_type: step.orientation_type,
        orientation: step.orientation,
        position: step.position,
        position_kind: step.position_kind,
        color: step.color,
        pinned: step.pinned,
        added: true,
      });
      touched.push(true);
    } else if (step.action === "set" && step.index !== undefined && list[step.index]) {
      const g = list[step.index];
      g.position = step.position;
      touched[step.index] = true;
      if (step.position_kind !== undefined) g.position_kind = step.position_kind;
      if (step.color !== undefined) g.color = step.color;
      if (step.pinned !== undefined) g.pinned = step.pinned;
    } else if (step.action === "remove" && step.index !== undefined) {
      list.splice(step.index, 1);
      touched.splice(step.index, 1);
    }
  }
  return { list, touched };
}

/** Applies guide operations to a guide list the way AE does: add appends, set moves, remove shifts the rest down. */
export function simulateGuides(before: SimGuide[], applied: GuideStep[]): SimGuide[] {
  return runGuideSteps(before, applied).list;
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

const layerMap = (list: LayerState[] | undefined) => new Map((list ?? []).map((l) => [l.id, l] as const));

/** Checks the read-back of the dialog edits: name, size (and where layers went), PAR, fps, drop frame, length, trim. */
function checkDialogEdits(
  m: ReceiptMismatch[],
  s: NonNullable<SettingsArgs["settings"]>,
  before: CompSettingsInfo | null,
  after: CompSettingsInfo,
  written: Record<string, any>,
  missing: (key: string) => void
): void {
  const frameTol = (after.frame_duration || 0.05) * 1.01 + 1e-6;
  if (s.name !== undefined) expectThat(m, after.name === s.name, "settings.name", s.name, after.name, "Name differs");
  if (s.size !== undefined) {
    expectThat(m, after.width === s.size.width, "settings.size.width", s.size.width, after.width, "Width differs");
    expectThat(m, after.height === s.size.height, "settings.size.height", s.size.height, after.height, "Height differs");
  }
  if (s.pixel_aspect !== undefined) {
    if (after.pixel_aspect === undefined) missing("pixel_aspect");
    else expectThat(m, Math.abs(after.pixel_aspect - s.pixel_aspect) <= 0.0001, "settings.pixel_aspect", s.pixel_aspect, after.pixel_aspect, "Pixel aspect differs");
  }
  if (s.frame_rate !== undefined) {
    expectThat(m, Math.abs(after.fps - s.frame_rate) <= 0.001, "settings.frame_rate", s.frame_rate, after.fps, "Frame rate differs");
  }
  if (s.drop_frame !== undefined) {
    if (after.drop_frame === undefined) missing("drop_frame");
    else expectThat(m, after.drop_frame === s.drop_frame, "settings.drop_frame", s.drop_frame, after.drop_frame, "Drop frame differs");
  }
  const clamped = (written.duration_change as { work_area_clamped?: { to: { start: number; duration: number } } } | undefined)?.work_area_clamped;
  if (clamped && after.work_area) {
    expectThat(m, Math.abs(after.work_area.start - clamped.to.start) <= frameTol, "settings.duration.work_area.start", clamped.to.start, after.work_area.start, "The work area did not fit into the shorter comp");
    expectThat(m, Math.abs(after.work_area.duration - clamped.to.duration) <= frameTol * 2, "settings.duration.work_area.duration", clamped.to.duration, after.work_area.duration, "The work area did not fit into the shorter comp");
  }
  if (s.duration !== undefined) {
    const to = (written.duration_change?.to as number | undefined) ?? before?.duration;
    if (to !== undefined) expectThat(m, Math.abs(after.duration - to) <= frameTol, "settings.duration", to, after.duration, "Comp length differs");
  }
  if (s.trim_to_work_area && written.trim) {
    const want = written.trim.new_duration as number;
    expectThat(m, Math.abs(after.duration - want) <= frameTol, "settings.trim_to_work_area.duration", want, after.duration, "Trimmed length differs from the work area");
    if (after.work_area) {
      expectThat(m, Math.abs(after.work_area.start) <= frameTol, "settings.trim_to_work_area.work_area_start", 0, after.work_area.start, "Work area should restart at 0");
    }
    const shown = written.trim.display_start_time as number | null | undefined;
    if (shown !== null && shown !== undefined) {
      if (after.display_start_time === undefined) missing("display_start_time");
      else expectThat(m, Math.abs(after.display_start_time - shown) <= frameTol, "settings.trim_to_work_area.display_start_time", shown, after.display_start_time, "The displayed timecode was not kept");
    }
  }

  // Layer timing and positions, from the read that asked for layer_state.
  if (!before?.layer_state || !after.layer_state || before.layer_state_truncated || after.layer_state_truncated) return;
  const was = layerMap(before.layer_state);
  const now = layerMap(after.layer_state);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  if (written.resize) {
    const moved = new Map<number, { dx: number; dy: number }>();
    for (const e of (written.moved_layers as Array<{ id: number; dx: number; dy: number }> | undefined) ?? []) moved.set(e.id, e);
    const capped = written.moved_layers_truncated === true;
    // Layers the host left alone (a Position expression drives them, or they are audio-only) may still change with the comp size.
    const left = new Set<number>(((written.resize as { layers_skipped?: Array<{ id: number }> }).layers_skipped ?? []).map((e) => e.id));
    for (const [id, b] of was) {
      if (left.has(id)) continue;
      const a = now.get(id);
      if (!a || !b.position || !a.position) continue;
      const mv = moved.get(id);
      if (mv) {
        const want = [b.position[0] + mv.dx, b.position[1] + mv.dy];
        expectThat(m, near(a.position[0], want[0], 0.01) && near(a.position[1], want[1], 0.01), `layers[${id}].position`, want, a.position, "The layer did not move by the anchor shift");
      } else if (!capped) {
        expectThat(m, near(a.position[0], b.position[0], 0.01) && near(a.position[1], b.position[1], 0.01), `layers[${id}].position`, b.position, a.position, "The layer moved though the resize did not move it");
      }
    }
  }
  const change = written.duration_change as { extended?: Array<{ id: number; to: number }>; skipped?: Array<{ id: number }> } | undefined;
  if (change) {
    for (const e of change.extended ?? []) {
      const a = now.get(e.id);
      if (a?.out !== undefined) expectThat(m, near(a.out, e.to, frameTol), `layers[${e.id}].out`, e.to, a.out, "The layer's out point did not move to the new end");
    }
    for (const e of change.skipped ?? []) {
      const a = now.get(e.id);
      const b = was.get(e.id);
      if (a?.out !== undefined && b?.out !== undefined) expectThat(m, near(a.out, b.out, frameTol), `layers[${e.id}].out`, b.out, a.out, "A layer that was meant to stay changed its out point");
    }
  }
  if (written.trim) {
    const by = written.trim.shifted_by as number;
    for (const [id, b] of was) {
      const a = now.get(id);
      if (!a) continue;
      if (a.in !== undefined && b.in !== undefined) expectThat(m, near(a.in, b.in - by, frameTol), `layers[${id}].in`, rounded(b.in - by), a.in, "The layer's in point did not shift with the trim");
      if (a.out !== undefined && b.out !== undefined) expectThat(m, near(a.out, b.out - by, frameTol), `layers[${id}].out`, rounded(b.out - by), a.out, "The layer's out point did not shift with the trim");
    }
  }
}

const rounded = (n: number) => Math.round(n * 1e6) / 1e6;

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

  checkDialogEdits(m, s, before, after, written, missing);

  // Guides: the list AE should hold after the operations (the user's guide steps run first, then the resize's guide shifts).
  const shifts = (written.guide_shifts as GuideStep[] | undefined) ?? [];
  const applied = (written.guides_applied as GuideStep[] | undefined) ?? [];
  if ((args.guides && args.guides.length > 0) || shifts.length > 0) {
    if (args.guides && args.guides.length > 0 && applied.length !== args.guides.length) {
      m.push({ path: "guides", expected: args.guides.length, actual: applied.length, message: "The host applied a different number of guide operations" });
    }
    if (before && !before.guides_truncated && !after.guides_truncated && !unreadable.has("guides")) {
      const { list: want, touched } = runGuideSteps(before.guides, [...applied, ...shifts]);
      expectThat(m, after.guide_count === want.length, "guides.length", want.length, after.guide_count, "Guide count differs");
      if (after.guide_count === want.length) {
        // Positions are written in pixels. Whether a guide's position is comparable is
        // decided per guide: skipped only when the expected and the read-back position
        // type are both known and differ. A pinned guide no step wrote is left to AE on a
        // resize (its distance from the far edge is kept), so its position is not compared then.
        // A pinned guide the user wrote is written again after the resize, so it is compared.
        const resized = written.resize !== undefined;
        want.forEach((g, i) => {
          const got = after.guides[i];
          if (!got) return;
          const kindsDiffer = g.position_kind !== undefined && got.position_kind !== undefined && g.position_kind !== got.position_kind;
          const leftToAe = resized && g.pinned === true && !touched[i];
          if (!kindsDiffer && !leftToAe && g.position !== undefined && got.position !== undefined) {
            expectThat(m, Math.abs(got.position - g.position) <= 0.01, `guides[${i}].position`, g.position, got.position, "Guide position differs");
          }
          // The stable words come first; the raw integers only when a side has no words (older host, older stored data).
          if (g.orientation !== undefined && got.orientation !== undefined) {
            expectThat(m, got.orientation === g.orientation, `guides[${i}].orientation`, g.orientation, got.orientation, "Guide direction differs");
          } else if (g.orientation_type !== undefined && got.orientation_type !== undefined) {
            expectThat(m, got.orientation_type === g.orientation_type, `guides[${i}].orientation_type`, g.orientation_type, got.orientation_type, "Guide direction differs");
          }
          if (g.position_kind !== undefined && got.position_kind !== undefined) {
            expectThat(m, got.position_kind === g.position_kind, `guides[${i}].position_kind`, g.position_kind, got.position_kind, "Guide position type differs");
          }
          if (g.color !== undefined && got.color !== undefined) {
            expectThat(m, sameList(got.color, g.color, 0.004), `guides[${i}].color`, g.color, got.color, "Guide colour differs");
          }
          if (g.pinned !== undefined && got.pinned !== undefined) {
            expectThat(m, got.pinned === g.pinned, `guides[${i}].pinned`, g.pinned, got.pinned, "Guide pinned state differs");
          }
        });
      }
    }
  }

  // Nothing else should have moved. Linked pairs (start time / frame) are skipped when either was set.
  if (before) {
    const asked = (k: string) => (s as Record<string, unknown>)[k] !== undefined;
    // The start frame is start time * rate, so it moves with a new frame rate too.
    const skipFrames = FRAME_KEYS.some(asked) || asked("trim_to_work_area") || asked("frame_rate");
    const watched: Array<keyof CompSettingsInfo> = [...BOOL_KEYS, ...INT_KEYS, "renderer", "name", "pixel_aspect"];
    if (!asked("frame_rate")) watched.push("drop_frame");
    if (!skipFrames) watched.push("display_start_frame");
    for (const key of watched) {
      if (asked(key as string)) continue;
      if (before[key] !== undefined && after[key] !== undefined && before[key] !== after[key]) {
        m.push({ path: `settings.${String(key)}`, expected: before[key], actual: after[key], message: `${String(key)} changed too, though it was not asked for` });
      }
    }
    for (const key of ["width", "height", "fps", "duration"] as const) {
      if (key === "width" || key === "height") {
        if (asked("size")) continue;
      } else if (key === "fps") {
        if (asked("frame_rate")) continue;
      } else if (asked("duration") || asked("trim_to_work_area")) {
        continue;
      } else if (asked("frame_rate")) {
        // AE snaps the length to the new frame grid.
        expectThat(m, Math.abs(before[key] - after[key]) <= (after.frame_duration || 0.05) * 1.01 + 1e-6, key, before[key], after[key], `The comp's ${key} changed`);
        continue;
      }
      expectThat(m, before[key] === after[key], key, before[key], after[key], `The comp's ${key} changed`);
    }
    if (!asked("resolution_factor") && before.resolution_factor && after.resolution_factor && !sameList(after.resolution_factor, before.resolution_factor)) {
      m.push({ path: "settings.resolution_factor", expected: before.resolution_factor, actual: after.resolution_factor, message: "resolution_factor changed too, though it was not asked for" });
    }
  }
  return m;
}

// ---------- tools ----------

/** The dialog edits that move layers need per-layer timing and Position in both reads. */
const needsLayerState = (args: SettingsArgs) => {
  const st = args.settings;
  return st !== undefined && (st.size !== undefined || st.duration !== undefined || st.trim_to_work_area === true);
};

/** Resize, frame rate, length and trim can touch hundreds of layers and keys: give AE the long timeout. */
const slowEdit = (args: SettingsArgs) => {
  const st = args.settings;
  return st !== undefined && (st.size !== undefined || st.frame_rate !== undefined || st.duration !== undefined || st.trim_to_work_area === true);
};

const keysOf = (args: SettingsArgs) => {
  const keys = Object.keys(args.settings ?? {}).filter((k) => (args.settings as Record<string, unknown>)[k] !== undefined);
  if (args.guides && args.guides.length > 0) keys.push("guides");
  return keys;
};

const pick = (w: Record<string, unknown>, keys: string[]) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (w[k] !== undefined) out[k] = w[k];
  return out;
};

/** The per-layer state is for the receipt check, not for the agent's result. */
const stripLayerState = (after: unknown) => {
  if (!after || typeof after !== "object") return after;
  const { layer_state: _a, layer_state_truncated: _b, ...rest } = after as Record<string, unknown>;
  return rest;
};

export const compsettingsTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_comp_settings",
    description:
      "Read a comp's own settings: motion blur (switch, shutter angle and phase, samples, adaptive limit), frame blending, renderer and the renderers this comp offers, draft 3D, resolution factor, background colour, " +
      "hide shy, preserve nested frame rate / resolution, display start time and frame, work area, pixel aspect, drop frame, and its guides (0-based index, `orientation` horizontal/vertical, `position_kind` pixel/percentage, position; on 26.5 also colour and pinned). " +
      "Each guide also carries AE's raw `orientation_type` / `position_type` integers, which mean different things on different AE versions: use the words. " +
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
      "resolution factor, background colour, hide shy, preserve nested frame rate / resolution, display start (time or frame), work area, and add, move or remove the comp's guides " +
      "(on AE 26.5+ guides also take colour, pinned and a percentage position_type; older builds refuse those). It also does the Composition Settings dialog edits: name; " +
      "size {width, height, anchor} (resizes around an anchor and moves the Position of every top-level layer except those with a Position expression and audio-only layers, which are skipped and listed in resize.layers_skipped; keys included, plus cameras, lights and pixel guides, so content keeps its place); pixel_aspect; frame_rate " +
      "(keys that now sit between frames are counted in keys_off_frame, not moved); drop_frame (29.97 / 59.94 only); duration {seconds | frames, extend_layers} " +
      "(layers that ran to the old end follow the new end; footage that ends sooner is left alone and listed); trim_to_work_area (shifts every layer, locked ones too, and the comp markers, keeps the displayed timecode). " +
      "Guide positions in the same call are in the comp's new size (a pinned guide you add or set in the same call as a size change is written again after the resize). " +
      "Everything runs in one undo group guarded by `expect`. Every value is range-checked before After Effects is touched, and the work area is refused if it would pass the comp's length. " +
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
        read: () => ({ host: "compsettingsRead", args: needsLayerState(args) ? { comp_id: args.comp_id, layer_state: true } : { comp_id: args.comp_id } }),
        write: {
          host: "compsettingsApply",
          args: { comp_id: args.comp_id, settings: args.settings, guides: args.guides, label: "Comp settings" },
          ...(slowEdit(args) ? { timeoutMs: SLOW_TIMEOUT_MS } : {}),
        },
        check: (before, after, w) => compSettingsMismatches(args, before, after, w),
        present: (_before, after, w) => ({
          comp_id: args.comp_id,
          changed: w.changed,
          settings: stripLayerState(after),
          guide_api: w.guide_api,
          ...(w.no_op ? { no_op: true } : {}),
          ...pick(w, ["resize", "duration_change", "keys_off_frame", "trim", "notes"]),
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
