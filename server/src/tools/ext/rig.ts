/**
 * server/src/tools/ext/rig.ts
 *
 * Rigging tools: make a comp tweakable with Expression Controls and link
 * properties to them, each write read back in a separate evalScript:
 * - ae_rig_add_controls: slider, angle, checkbox, colour, point, 3D point,
 *   layer and dropdown controls on a layer (or on a null made for them)
 * - ae_rig_link / ae_rig_unlink: link properties to a control with a
 *   generated expression, optionally remapped, or clear that expression
 * - ae_rig_rename: rename a control, then repair the expressions that named it
 * - ae_rig_list (read): every control in a comp with the expressions that
 *   reference it
 * - ae_expr_recipe / ae_expr_recipes: a curated expression recipe applied to
 *   a property with the controls it needs, and the catalogue of recipes
 *
 * Generated expressions read a control as effect("Name")(1): the parameter's
 * display name ("Slider") is translated by AE's language, index 1 is not.
 * The expressions themselves are built in the host (panel/host/ext/rig.jsx),
 * because the right variant depends on the property's value type and the
 * project's expression engine, which only AE knows. This file holds what
 * Node can know: the schemas, the recipe catalogue (control names, defaults
 * and parameters), and the read-back checks.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type LayerSelector,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- control kinds ----------

export const CONTROL_KINDS = ["slider", "angle", "checkbox", "color", "point", "point3d", "layer", "dropdown"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** The effect match names; the control's value is parameter 1 of each. */
export const CONTROL_MATCH_NAMES: Record<ControlKind, string> = {
  slider: "ADBE Slider Control",
  angle: "ADBE Angle Control",
  checkbox: "ADBE Checkbox Control",
  color: "ADBE Color Control",
  point: "ADBE Point Control",
  point3d: "ADBE Point3D Control",
  layer: "ADBE Layer Control",
  dropdown: "ADBE Dropdown Control",
};

/**
 * AE 26.2 reports the dropdown it adds under ADBE Dropdown Control as a pseudo effect whose
 * match name (Pseudo/@@ plus a code) is not constant: it differs from one dropdown to the next
 * (seen live). The host tells a dropdown by its parameter (isDropdownEffect), so here any
 * Pseudo/@@ name fits a dropdown, together with the documented one. Every other kind keeps its own name.
 */
function matchNameFits(kind: ControlKind, matchName: string | undefined): boolean {
  if (matchName === CONTROL_MATCH_NAMES[kind]) return true;
  return kind === "dropdown" && typeof matchName === "string" && matchName.startsWith("Pseudo/@@");
}

/** AE's Slider Control takes -1,000,000 to 1,000,000 (to confirm live); angles are wider. */
const MAX_SLIDER = 1_000_000;
const MAX_ANGLE = 1_000_000_000;

/** Names go inside double quotes in expressions: no quote, backslash or line break. */
const SAFE_NAME = /^[^"\\\r\n\t]+$/;

const ControlName = z
  .string()
  .min(1)
  .max(200)
  .regex(SAFE_NAME, "A control name can't hold a quote, backslash or line break (expressions name it in double quotes).");

const PathSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(20)
  .describe("Property path from the layer root, by name or match name (e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Transform', 'Position']).");

// ---------- control specs ----------

export const ControlSpecSchema = z
  .object({
    name: ControlName.describe("The effect's name. Expressions find the control by it; it must be unique on its layer."),
    kind: z.enum(CONTROL_KINDS).describe("slider, angle (degrees), checkbox, color, point (2D), point3d, layer (a layer picker) or dropdown."),
    value: z
      .union([z.number(), z.boolean(), z.array(z.number()).min(2).max(4)])
      .optional()
      .describe(
        "Starting value: a number (slider, angle), true/false (checkbox), [r, g, b] or [r, g, b, a] in 0..1 (color), [x, y] (point), [x, y, z] (point3d), " +
          "or the 1-based item number (dropdown). Left alone when omitted."
      ),
    items: z.array(z.string().min(1).max(200)).min(1).max(100).optional().describe("Dropdown items: unique, no backslash; '(-' makes a separator. AE 17.0.1+."),
    layer: LayerSelectorSchema.optional().describe("Layer control: the layer to pick. Omit for none."),
  })
  .superRefine((spec, ctx) => {
    const problem = controlSpecProblem(spec);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export type ControlSpec = z.infer<typeof ControlSpecSchema>;

/** Why a control spec is unusable, or null. The host checks the same rules again before it touches AE. */
export function controlSpecProblem(spec: {
  name: string;
  kind: ControlKind;
  value?: unknown;
  items?: string[];
  layer?: unknown;
}): string | null {
  const { kind, value, items } = spec;
  const has = value !== undefined && value !== null;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (kind !== "dropdown" && items !== undefined) return `items apply to dropdown controls only (${spec.name}).`;
  if (kind !== "layer" && spec.layer !== undefined) return `layer applies to layer controls only (${spec.name}).`;
  if (kind === "slider" || kind === "angle") {
    const lim = kind === "slider" ? MAX_SLIDER : MAX_ANGLE;
    if (has && (!finite(value) || Math.abs(value) > lim)) return `${spec.name}: the value must be a number within +-${lim}.`;
  } else if (kind === "checkbox") {
    if (has && typeof value !== "boolean" && value !== 0 && value !== 1) return `${spec.name}: the value must be true or false.`;
  } else if (kind === "color") {
    if (has) {
      if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return `${spec.name}: a colour is [r, g, b] or [r, g, b, a].`;
      if (!value.every((n) => finite(n) && n >= 0 && n <= 1)) return `${spec.name}: colour values are numbers in 0..1.`;
    }
  } else if (kind === "point" || kind === "point3d") {
    const want = kind === "point" ? 2 : 3;
    if (has && (!Array.isArray(value) || value.length !== want || !value.every(finite))) return `${spec.name}: the value must be ${want} finite numbers.`;
  } else if (kind === "layer") {
    if (has) return `${spec.name}: a layer control takes a layer selector, not a value.`;
  } else if (kind === "dropdown") {
    if (!items || items.length === 0) return `${spec.name}: a dropdown needs items.`;
    const real = items.filter((i) => i !== "(-");
    if (new Set(real).size !== real.length) return `${spec.name}: dropdown items must be unique.`;
    if (items.some((i) => i.includes("\\"))) return `${spec.name}: dropdown items can't hold a backslash.`;
    if (has) {
      if (!finite(value) || !Number.isInteger(value) || value < 1 || value > items.length) return `${spec.name}: the value must be an item number from 1 to ${items.length}.`;
      if (items[value - 1] === "(-") return `${spec.name}: the value points at a separator.`;
    }
  }
  return null;
}

/** The value a control should read back as, or undefined when none was set. */
export function expectedControlValue(spec: ControlSpec): number | number[] | undefined {
  const v = spec.value;
  if (v === undefined) return undefined;
  if (spec.kind === "checkbox") return v === true || v === 1 ? 1 : 0;
  if (spec.kind === "color" && Array.isArray(v)) return [v[0], v[1], v[2], v.length === 4 ? v[3] : 1];
  return v as number | number[];
}

const close = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

export function valuesMatch(expected: number | number[], actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => typeof actual[i] === "number" && close(e, actual[i] as number));
  }
  if (typeof actual === "boolean") return close(expected, actual ? 1 : 0);
  return typeof actual === "number" && close(expected, actual);
}

// ---------- read-back shapes ----------

interface PropState {
  found: boolean;
  layer_id?: number;
  path?: string[];
  dims?: string;
  expression?: string;
  enabled?: boolean;
  error?: string | null;
  num_keys?: number;
  message?: string;
}

interface ControlState {
  found: boolean;
  layer_id?: number;
  name: string;
  kind?: string | null;
  match_name?: string;
  value?: unknown;
  items?: unknown;
  items_truncated?: boolean;
  layer_target?: { index: number; id: number; name: string };
  message?: string;
}

interface RefEntry {
  layer_id: number;
  layer_name: string;
  path: string;
  match_path: string[];
  expression: string;
  error?: string | null;
}

interface ScanState {
  found: boolean;
  name: string;
  count: number;
  references: RefEntry[];
  truncated: boolean;
}

interface RigState {
  props: PropState[];
  controls: ControlState[];
  scans: ScanState[];
  scan_truncated?: boolean;
}

const stateOf = (v: unknown): RigState | null => (v && typeof v === "object" ? (v as RigState) : null);

interface StateQuery {
  props?: Array<{ layer: LayerSelector; path: string[] }>;
  controls?: Array<{ layer: LayerSelector; name: string }>;
  scans?: Array<{ layer: LayerSelector; name: string }>;
}

/** The read-back: expressions, controls and references by name, in their own evalScript. */
const stateRead = (compId: number, q: StateQuery) => ({ host: "rigState", args: { comp_id: compId, ...q } });

const sameText = (a: string, b: string) => a.replace(/\r\n?|\n/g, "\n") === b.replace(/\r\n?|\n/g, "\n");

/** A property's expression after the write: the text we set, switched on, with no error. */
export function expressionMismatches(m: ReceiptMismatch[], label: string, expected: string, state: PropState | undefined, afterCapped = false): void {
  if (!state || !state.found) {
    if (!afterCapped) m.push({ path: `${label}`, expected, actual: undefined, message: state?.message ?? "The property is not in the read-back" });
    return;
  }
  expectThat(m, typeof state.expression === "string" && sameText(state.expression, expected), `${label}.expression`, expected, state.expression, "The expression read back differs from the one set");
  expectThat(m, state.enabled !== false, `${label}.expressionEnabled`, true, state.enabled, "The expression is switched off");
  if (state.error) m.push({ path: `${label}.expressionError`, expected: null, actual: state.error, message: `AE reports an expression error: ${state.error}` });
}

/** A control after adding it: it is there, of the right kind, with the value and items asked for. */
export function controlMismatches(
  m: ReceiptMismatch[],
  label: string,
  spec: ControlSpec,
  state: ControlState | undefined,
  checkValue = true,
  targetLayerId?: number | null
): void {
  if (!state || !state.found) {
    m.push({ path: label, expected: spec.name, actual: undefined, message: state?.message ?? `Control "${spec.name}" is not in the read-back` });
    return;
  }
  expectThat(m, state.kind === spec.kind, `${label}.kind`, spec.kind, state.kind, "The control is of another kind");
  expectThat(m, matchNameFits(spec.kind, state.match_name), `${label}.match_name`, CONTROL_MATCH_NAMES[spec.kind], state.match_name, "The control's effect differs");
  if (!checkValue) return;
  const want = expectedControlValue(spec);
  if (want !== undefined) expectThat(m, valuesMatch(want, state.value), `${label}.value`, want, state.value, "The control's value differs");
  if (spec.kind === "dropdown" && spec.items && Array.isArray(state.items)) {
    // A read capped by the host holds only the first items: compare those.
    const want = state.items_truncated ? spec.items.slice(0, state.items.length) : spec.items;
    expectThat(m, JSON.stringify(state.items) === JSON.stringify(want), `${label}.items`, want, state.items, "The dropdown items differ");
  }
  if (spec.kind === "layer" && spec.layer) {
    // The host resolves the picked layer to an id before any null is added; the value is that layer's index now.
    const wantId = targetLayerId ?? (spec.layer as { id?: number }).id;
    if (wantId !== undefined && wantId !== null) {
      expectThat(m, state.layer_target?.id === wantId, `${label}.layer`, wantId, state.layer_target?.id, "The Layer Control points at another layer than the one asked for");
    }
  }
}

// ---------- ae_rig_add_controls ----------

export const AeRigAddControlsSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The layer that holds the controls: usually a controller null."),
    create_if_missing: z
      .boolean()
      .optional()
      .describe("With the layer given by name: make a null with that name when no layer has it (named, at the top). Default false."),
    controls: z.array(ControlSpecSchema).min(1).max(50).describe("The controls to add, in order."),
    expect: ExpectSchema,
  })
  .refine((v) => new Set(v.controls.map((c) => c.name)).size === v.controls.length, { message: "Control names must be unique." })
  .refine((v) => v.create_if_missing !== true || v.layer.name !== undefined, { message: "create_if_missing needs the layer given by name." });

type AddArgs = z.infer<typeof AeRigAddControlsSchema>;

interface AddWritten {
  controls?: Array<{ name: string; target_layer_id?: number | null }>;
  [k: string]: unknown;
}

export function addControlsMismatches(args: AddArgs, afterRaw: unknown, written?: AddWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = stateOf(afterRaw);
  if (!after) return m;
  args.controls.forEach((spec, i) => {
    const made = written?.controls?.find((c) => c.name === spec.name);
    controlMismatches(m, `controls[${i}]`, spec, after.controls[i], true, made?.target_layer_id);
  });
  return m;
}

// ---------- ae_rig_link / ae_rig_unlink ----------

export const RemapSchema = z
  .object({
    in_min: z.number().finite(),
    in_max: z.number().finite(),
    out_min: z.number().finite(),
    out_max: z.number().finite(),
    clamp: z.boolean().optional().describe("Default true: linear() clamps to the output range. False continues the line past it."),
  })
  .refine((r) => r.in_min !== r.in_max, { message: "in_min and in_max must differ." })
  .describe("Map the control's range onto another with linear().");

export const LinkSpecSchema = z.object({
  layer: LayerSelectorSchema.describe("The layer that owns the property."),
  path: PathSchema,
  control: z
    .object({
      name: ControlName,
      layer: LayerSelectorSchema.optional().describe("The layer that holds the control. Default: the property's own layer."),
    })
    .describe("The control to read."),
  remap: RemapSchema.optional().describe("Slider, angle, checkbox and dropdown controls only."),
  multiplier: z.number().finite().optional().describe("Multiplied in after the remap. Slider, angle, checkbox, dropdown, point and 3D point controls."),
  axis: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe("A scalar control on a 2D or 3D property: drive only this component (0 = x) and leave the others as they are. Default: every component."),
});

export const AeRigLinkSchema = z.object({
  comp_id: z.number().int(),
  links: z.array(LinkSpecSchema).min(1).max(100),
  replace: z.boolean().optional().describe("Overwrite a property's existing expression. Default false: the tool refuses before changing anything."),
  expect: ExpectSchema,
});

type LinkArgs = z.infer<typeof AeRigLinkSchema>;

interface LinkWritten {
  links?: Array<{ layer_id: number; path: string[]; expression: string; control: { layer_id: number; name: string } }>;
  [k: string]: unknown;
}

export function linkMismatches(written: LinkWritten, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = stateOf(afterRaw);
  if (!after) return m;
  (written.links ?? []).forEach((l, i) => expressionMismatches(m, `links[${i}]`, l.expression, after.props[i]));
  return m;
}

export const AeRigUnlinkSchema = z.object({
  comp_id: z.number().int(),
  targets: z
    .array(
      z.object({
        layer: LayerSelectorSchema,
        path: PathSchema,
        control_name: ControlName.optional().describe("Only clear the expression when it names this control; otherwise it is skipped and reported."),
      })
    )
    .min(1)
    .max(100),
  expect: ExpectSchema,
});

type UnlinkArgs = z.infer<typeof AeRigUnlinkSchema>;

interface UnlinkWritten {
  unlinked?: Array<{ layer_id: number; path: string[] }>;
  [k: string]: unknown;
}

export function unlinkMismatches(written: UnlinkWritten, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = stateOf(afterRaw);
  if (!after) return m;
  (written.unlinked ?? []).forEach((u, i) => {
    const s = after.props[i];
    if (!s || !s.found) {
      m.push({ path: `unlinked[${i}]`, expected: "a property", actual: undefined, message: s?.message ?? "The property is not in the read-back" });
      return;
    }
    expectThat(m, (s.expression ?? "") === "", `unlinked[${i}].expression`, "", s.expression, "The property still has an expression");
  });
  return m;
}

// ---------- ae_rig_rename ----------

export const AeRigRenameSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.describe("The layer that holds the control."),
  control: ControlName.describe("The control's current name."),
  new_name: ControlName,
  expect: ExpectSchema,
});

type RenameArgs = z.infer<typeof AeRigRenameSchema>;

export function renameMismatches(args: RenameArgs, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stateOf(beforeRaw);
  const after = stateOf(afterRaw);
  if (!after) return m;
  const now = after.controls[0];
  if (!now || !now.found) {
    m.push({ path: "control", expected: args.new_name, actual: undefined, message: `No control named "${args.new_name}" in the read-back` });
  } else {
    const was = before?.controls[0];
    if (was?.found) expectThat(m, now.kind === was.kind, "control.kind", was.kind, now.kind, "The control's kind changed");
  }
  const stale = after.scans[0];
  const named = after.scans[1];
  const had = before?.scans[0];
  if (stale && stale.count > 0) {
    for (const r of stale.references) {
      m.push({
        path: `${r.layer_name} > ${r.path}`,
        expected: `effect("${args.new_name}")`,
        actual: r.expression,
        message: `This expression still names the old control "${args.control}". The rename swaps the name only where it can place the reference (layer("Holder").effect(..), the holder layer's own effect(..), a variable assigned once), and AE does not update the rest; edit it by hand`,
      });
    }
    if (stale.truncated) m.push({ path: "references", expected: 0, actual: stale.count, message: `${stale.count} expressions still name the old control (first ${stale.references.length} listed)` });
  }
  if (had && named && had.found && !had.truncated && !named.truncated && !stale?.truncated) {
    expectThat(m, named.count >= had.count, "references", had.count, named.count, "Fewer expressions name the control now than before the rename");
  }
  if (named) {
    const key = (r: RefEntry) => `${r.layer_id}|${r.match_path.join("/")}`;
    const wasBroken = new Set((had?.references ?? []).filter((r) => r.error).map(key));
    const known = new Set((had?.references ?? []).map(key));
    for (const r of named.references) {
      // The before scan lists 50 references: past that cap an earlier error can't be told from a new one.
      if (had?.truncated && !known.has(key(r))) continue;
      if (r.error && !wasBroken.has(key(r))) {
        m.push({ path: `${r.layer_name} > ${r.path}`, expected: null, actual: r.error, message: `AE reports an expression error after the rename: ${r.error}` });
      }
    }
  }
  return m;
}

// ---------- ae_rig_list ----------

export const AeRigListSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.optional().describe("Only this layer's controls. Default: every layer (the first 500)."),
  include_references: z
    .boolean()
    .optional()
    .describe("Default true: for each control, the expressions that name it (a text search, with their expressionError)."),
});

// ---------- recipe catalogue ----------

export type Dims = "1d" | "2d" | "3d" | "color" | "text";

interface RecipeControl {
  key: string;
  /** Appended to the name prefix: "Wiggle" + "Frequency". Empty: the prefix is the whole name. */
  label: string;
  kind: ControlKind;
  value: number | number[];
  describe: string;
}

interface RecipeParam {
  key: string;
  type: "enum" | "int" | "string" | "number_or_list";
  options?: string[];
  default?: string | number;
  required?: boolean;
  max?: number;
  describe: string;
}

export interface RecipeInfo {
  name: string;
  label: string;
  summary: string;
  dims: Dims[];
  controls: RecipeControl[];
  params: RecipeParam[];
  needs_source?: boolean;
}

const slider = (key: string, label: string, value: number, describe: string): RecipeControl => ({ key, label, kind: "slider", value, describe });

export const RECIPES: RecipeInfo[] = [
  {
    name: "wiggle",
    label: "Wiggle",
    summary: "wiggle() with its frequency and amount on controls. On colours the amount is divided by 100.",
    dims: ["1d", "2d", "3d", "color"],
    controls: [slider("frequency", "Frequency", 2, "Wiggles per second."), slider("amount", "Amount", 20, "How far, in the property's units.")],
    params: [],
  },
  {
    name: "overshoot",
    label: "Overshoot",
    summary: "A damped sine after the last keyframe it passed: the keys settle with a springy overshoot.",
    dims: ["1d", "2d", "3d", "color"],
    controls: [
      slider("amplitude", "Amplitude", 0.1, "Overshoot size, as a fraction of the speed into the key."),
      slider("frequency", "Frequency", 2, "Oscillations per second."),
      slider("decay", "Decay", 8, "How fast it dies away."),
    ],
    params: [],
  },
  {
    name: "bounce",
    label: "Bounce",
    summary: "A ball-style bounce after the last keyframe passed, losing energy on each bounce. Not for colours.",
    dims: ["1d", "2d", "3d"],
    controls: [
      slider("elasticity", "Elasticity", 0.7, "Energy kept per bounce, 0 to 0.99."),
      slider("gravity", "Gravity", 5000, "Pull, in units per second squared."),
      slider("max_bounces", "Max Bounces", 9, "Bounces before it comes to rest."),
    ],
    params: [],
  },
  {
    name: "loop",
    label: "Loop",
    summary: "loopOut or loopIn of a chosen type. No controls. Needs two or more keyframes to do anything.",
    dims: ["1d", "2d", "3d", "color"],
    controls: [],
    params: [
      { key: "loop_type", type: "enum", options: ["cycle", "pingpong", "offset", "continue"], default: "cycle", describe: "The loop type." },
      { key: "direction", type: "enum", options: ["out", "in"], default: "out", describe: "loopOut (after the last key) or loopIn (before the first)." },
      { key: "keyframes", type: "int", default: 0, describe: "Keyframes in the loop; 0 for all." },
    ],
  },
  {
    name: "follow_delay",
    label: "Follow",
    summary: "The same property of another layer, delayed in time (a trailing follower). Needs `source`.",
    dims: ["1d", "2d", "3d", "color"],
    needs_source: true,
    controls: [slider("delay", "Delay", 0.1, "Seconds behind the source.")],
    params: [],
  },
  {
    name: "auto_fade",
    label: "Fade",
    summary: "Fade in from the layer's in point and out to its out point (meant for Opacity).",
    dims: ["1d"],
    controls: [slider("fade_in", "In", 0.5, "Seconds to fade in."), slider("fade_out", "Out", 0.5, "Seconds to fade out.")],
    params: [],
  },
  {
    name: "count_up",
    label: "Count",
    summary: "Source Text counting from a start to an end number, with thousands separators, decimals, a prefix and a suffix.",
    dims: ["text"],
    controls: [
      slider("start", "Start", 0, "The number at the layer's in point."),
      slider("end", "End", 1000, "The number reached after the duration."),
      slider("duration", "Duration", 2, "Seconds to count."),
      slider("decimals", "Decimals", 0, "Decimal places (0 to 20; higher values are clamped to 20)."),
    ],
    params: [
      { key: "separator", type: "string", default: ",", max: 3, describe: "Thousands separator ('' for none)." },
      { key: "prefix", type: "string", default: "", max: 50, describe: "Text before the number." },
      { key: "suffix", type: "string", default: "", max: 50, describe: "Text after the number." },
      { key: "easing", type: "enum", options: ["linear", "ease"], default: "linear", describe: "How the count moves." },
    ],
  },
  {
    name: "master_scale",
    label: "Master Scale",
    summary: "The property's own value times a percentage slider (100 = unchanged). Works on Scale, or any number.",
    dims: ["1d", "2d", "3d"],
    controls: [slider("amount", "", 100, "Percent of the property's value.")],
    params: [],
  },
  {
    name: "tint_color",
    label: "Tint",
    summary: "Mix the property's colour toward a colour control by a percentage slider.",
    dims: ["color"],
    controls: [
      { key: "color", label: "Color", kind: "color", value: [1, 0, 0, 1], describe: "The colour to mix in." },
      slider("amount", "Amount", 100, "0 keeps the property's colour, 100 is the control's."),
    ],
    params: [],
  },
  {
    name: "ease_between",
    label: "Ease",
    summary: "Ease the property from one value to another as a 0 to 100 progress slider moves. `from` and `to` are numbers matching the property's dimensions.",
    dims: ["1d", "2d", "3d"],
    controls: [slider("progress", "Progress", 0, "0 is `from`, 100 is `to`.")],
    params: [
      { key: "from", type: "number_or_list", required: true, describe: "The value at progress 0: a number, or a list for 2D and 3D properties." },
      { key: "to", type: "number_or_list", required: true, describe: "The value at progress 100." },
    ],
  },
  {
    name: "follow_text",
    label: "Text Box",
    summary: "A shape's Size that hugs a text layer's text, plus padding. Needs `source` (the text layer).",
    dims: ["2d"],
    needs_source: true,
    controls: [slider("padding", "Padding", 20, "Pixels added on every side.")],
    params: [],
  },
  {
    name: "follow_text_position",
    label: "Text Anchor",
    summary: "A Position that sits at the centre of a text layer's text (in comp space). Needs `source`. No controls.",
    dims: ["2d", "3d"],
    needs_source: true,
    controls: [],
    params: [],
  },
];

export const RECIPE_NAMES = RECIPES.map((r) => r.name) as [string, ...string[]];

export const recipeByName = (name: string) => RECIPES.find((r) => r.name === name);

/** A control's name: the prefix, then the recipe's label for it ("Wiggle Frequency"). */
export function recipeControlName(prefix: string, label: string): string {
  return label ? `${prefix} ${label}` : prefix;
}

type ParamValue = string | number | number[];

/** Checks a recipe's params against its catalogue entry and fills the defaults. */
export function resolveRecipeParams(recipe: RecipeInfo, given: Record<string, ParamValue> | undefined): { ok: true; params: Record<string, ParamValue> } | { ok: false; message: string } {
  const g = given ?? {};
  const known = new Set(recipe.params.map((p) => p.key));
  for (const k of Object.keys(g)) {
    if (!known.has(k)) return { ok: false, message: `Recipe ${recipe.name} has no parameter "${k}" (it takes: ${recipe.params.map((p) => p.key).join(", ") || "none"}).` };
  }
  const out: Record<string, ParamValue> = {};
  for (const p of recipe.params) {
    let v: ParamValue | undefined = g[p.key];
    if (v === undefined) {
      if (p.required) return { ok: false, message: `Recipe ${recipe.name} needs the parameter "${p.key}": ${p.describe}` };
      v = p.default;
    }
    if (v === undefined) continue;
    if (p.type === "enum") {
      if (typeof v !== "string" || !p.options?.includes(v)) return { ok: false, message: `${p.key} must be one of: ${p.options?.join(", ")}.` };
    } else if (p.type === "int") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, message: `${p.key} must be a whole number, 0 or more.` };
    } else if (p.type === "string") {
      if (typeof v !== "string" || v.length > (p.max ?? 50)) return { ok: false, message: `${p.key} must be text of at most ${p.max ?? 50} characters.` };
    } else {
      const ok = (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)));
      if (!ok) return { ok: false, message: `${p.key} must be a number, or 2 or 3 numbers for a 2D or 3D property.` };
    }
    out[p.key] = v;
  }
  return { ok: true, params: out };
}

export interface PlannedControl {
  key: string;
  name: string;
  kind: ControlKind;
  value: number | number[];
}

/** The controls a recipe call creates or reuses, named and valued (the caller's `values` win). */
export function planRecipeControls(
  recipe: RecipeInfo,
  prefix: string | undefined,
  values: Record<string, number | number[]> | undefined
): { ok: true; controls: PlannedControl[] } | { ok: false; message: string } {
  const v = values ?? {};
  const keys = new Set(recipe.controls.map((c) => c.key));
  for (const k of Object.keys(v)) {
    if (!keys.has(k)) return { ok: false, message: `Recipe ${recipe.name} has no control "${k}" (controls: ${[...keys].join(", ") || "none"}).` };
  }
  const p = prefix ?? recipe.label;
  const controls: PlannedControl[] = [];
  for (const c of recipe.controls) {
    const value = v[c.key] ?? c.value;
    const name = recipeControlName(p, c.label);
    const problem = controlSpecProblem({ name, kind: c.kind, value: value as never });
    if (problem) return { ok: false, message: problem };
    if (!SAFE_NAME.test(name) || name.length > 200) return { ok: false, message: `The control name "${name}" is not usable (1 to 200 characters, no quote, backslash or line break).` };
    controls.push({ key: c.key, name, kind: c.kind, value });
  }
  return { ok: true, controls };
}

export const AeExprRecipeSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.describe("The layer that owns the property."),
  path: PathSchema,
  recipe: z.enum(RECIPE_NAMES).describe("A recipe from ae_expr_recipes."),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.number())])).optional().describe("The recipe's parameters (see ae_expr_recipes); defaults fill the rest."),
  controller: LayerSelectorSchema.optional().describe("The layer that holds the controls. Default: the property's own layer."),
  source: LayerSelectorSchema.optional().describe("The layer the recipe follows (follow_delay, follow_text, follow_text_position)."),
  name_prefix: ControlName.optional().describe("Control names are '<prefix> <label>'. Default: the recipe's own, e.g. 'Wiggle'. Controls already on the controller with the same name and kind are reused."),
  values: z.record(z.string(), z.union([z.number(), z.array(z.number())])).optional().describe("Starting values for new controls, by control key (e.g. {frequency: 4})."),
  replace: z.boolean().optional().describe("Overwrite the property's existing expression. Default false."),
  expect: ExpectSchema,
});

type RecipeArgs = z.infer<typeof AeExprRecipeSchema>;

interface RecipeWritten {
  target?: { layer_id: number; path: string[] };
  controls?: Array<{ layer_id: number; name: string; kind: string; key: string }>;
  controls_created?: string[];
  expression?: string;
  [k: string]: unknown;
}

export function recipeMismatches(planned: PlannedControl[], written: RecipeWritten, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = stateOf(afterRaw);
  if (!after) return m;
  expressionMismatches(m, "target", written.expression ?? "", after.props[0]);
  const created = new Set(written.controls_created ?? []);
  planned.forEach((c, i) => {
    const spec = { name: c.name, kind: c.kind, value: c.value } as ControlSpec;
    // A reused control keeps the value it had.
    controlMismatches(m, `controls[${i}]`, spec, after.controls[i], created.has(c.name));
  });
  return m;
}

// ---------- tools ----------

const ADD_DESC =
  "Add named Expression Controls (slider, angle, checkbox, color, point, point3d, layer, dropdown) to a layer, with starting values, in one undo group guarded by `expect`. " +
  "With create_if_missing and the layer given by name, a null of that name is made when no layer has it. A dropdown's items are set after the effect is added (AE 17.0.1+). " +
  "Names must be unique on the layer and hold no quote or backslash. Everything is validated before AE is touched, and a failure part-way takes back what the call added. " +
  "The read-back (a separate evalScript) checks each control exists with its kind, value and dropdown items (items read back on AE 26+ only). ";

const LINK_DESC =
  "Link properties to Expression Controls with a generated expression, in one undo group guarded by `expect`. The expression reads the control as effect(\"Name\")(1) " +
  "(thisComp.layer(\"Holder\").effect(...) from another layer): the parameter's display name is translated by AE's language, so it is never used. " +
  "The variant follows the property's value type: a slider/angle/checkbox/dropdown drives a 1D property directly, or every (or one, with `axis`) component of a 2D/3D one; " +
  "a colour control drives colours; a point drives 2D (3D keeps z) and a 3D point drives 3D (2D drops z). `remap` maps the range with linear() and `multiplier` scales it. " +
  "Refuses a property that already has an expression unless replace is true, and a pairing that makes no sense. Same-comp links only; layers are found by name, so the holder's name must be unique. " +
  "The read-back (a separate evalScript) forces each expression to evaluate and checks the text, that it is on, and that expressionError is empty. ";

/** Layers the before read cannot name by id: selectors only. */
const sel = (s: LayerSelector): LayerSelector => s;

export const rigTools: ToolDefinition<any>[] = [
  {
    name: "ae_rig_add_controls",
    description: ADD_DESC + AGENT_SAFETY_GUIDANCE,
    schema: AeRigAddControlsSchema,
    handler: (args: AddArgs, ctx: ToolContext) =>
      runGuardedWrite<AddWritten & { layer?: { id?: number } }>(ctx, {
        toolName: "ae_rig_add_controls",
        label: `ae_rig_add_controls(${args.controls.length})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return stateRead(args.comp_id, { controls: args.controls.map((c) => ({ layer: sel(args.layer), name: c.name })) });
          const id = (w?.layer as { id?: number } | undefined)?.id;
          if (id === undefined) return null;
          return stateRead(args.comp_id, { controls: args.controls.map((c) => ({ layer: { id }, name: c.name })) });
        },
        write: {
          host: "rigAddControls",
          args: { comp_id: args.comp_id, layer: args.layer, create_if_missing: args.create_if_missing, controls: args.controls, label: "Add expression controls" },
        },
        check: (_before, after, w) => addControlsMismatches(args, after, w),
      }),
  },
  {
    name: "ae_rig_link",
    description: LINK_DESC + AGENT_SAFETY_GUIDANCE,
    schema: AeRigLinkSchema,
    handler: (args: LinkArgs, ctx: ToolContext) =>
      runGuardedWrite<LinkWritten>(ctx, {
        toolName: "ae_rig_link",
        label: `ae_rig_link(${args.links.length})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return stateRead(args.comp_id, { props: args.links.map((l) => ({ layer: sel(l.layer), path: l.path })) });
          return stateRead(args.comp_id, { props: (w?.links ?? []).map((l) => ({ layer: { id: l.layer_id }, path: l.path })) });
        },
        write: { host: "rigLink", args: { comp_id: args.comp_id, links: args.links, replace: args.replace, label: "Link properties to controls" } },
        check: (_before, after, w) => linkMismatches(w, after),
      }),
  },
  {
    name: "ae_rig_unlink",
    description:
      "Clear the expression of linked properties (the property goes back to its own stored value or keyframes), in one undo group guarded by `expect`. " +
      "With control_name a property is cleared only if its expression names that control; the rest are skipped and listed. " +
      "The read-back (a separate evalScript) checks each cleared property has no expression. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRigUnlinkSchema,
    handler: (args: UnlinkArgs, ctx: ToolContext) =>
      runGuardedWrite<UnlinkWritten>(ctx, {
        toolName: "ae_rig_unlink",
        label: `ae_rig_unlink(${args.targets.length})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return stateRead(args.comp_id, { props: args.targets.map((t) => ({ layer: sel(t.layer), path: t.path })) });
          return stateRead(args.comp_id, { props: (w?.unlinked ?? []).map((u) => ({ layer: { id: u.layer_id }, path: u.path })) });
        },
        write: { host: "rigUnlink", args: { comp_id: args.comp_id, targets: args.targets, label: "Unlink properties" } },
        check: (_before, after, w) => unlinkMismatches(w, after),
      }),
  },
  {
    name: "ae_rig_rename",
    description:
      "Rename an Expression Control without breaking the expressions that name it, in one undo group guarded by `expect`. " +
      "Order: set the effect's name; then swap the quoted name in this comp's expressions (effect('Old') -> effect('New'), either quote style) at the spots that surely reach this control: layer('Holder').effect(..), a bare effect( or thisLayer.effect( on the holder layer, or a variable assigned once to the holder layer. AE does not update references itself (seen live) and Project.autoFixExpressions ignores effect('Old') text. " +
      "A reference it cannot place (a variable with several assignments, a layer index) or an expression AE refuses is left as written and counted in references_unresolved; for those, and when the scan was capped, it makes them evaluate and calls Project.autoFixExpressions with the bare old and new names, which is project-wide and changes only expressions that error now and hold the old name. " +
      "Expressions in other comps (comp('X').layer('Holder').effect('Old')) are not scanned or changed (other_comps_scanned: false). Setting an expression also switches it back on if it was disabled. The read-back (a separate evalScript) searches every expression in this comp: any that still names the old control, or that errors now, is a receipt mismatch you must fix by hand. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRigRenameSchema,
    handler: (args: RenameArgs, ctx: ToolContext) =>
      runGuardedWrite(ctx, {
        toolName: "ae_rig_rename",
        label: `ae_rig_rename("${args.control}" -> "${args.new_name}")`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") {
            return stateRead(args.comp_id, { controls: [{ layer: args.layer, name: args.control }], scans: [{ layer: args.layer, name: args.control }] });
          }
          const id = (w?.layer as { id?: number } | undefined)?.id;
          if (id === undefined) return null;
          return stateRead(args.comp_id, {
            controls: [{ layer: { id }, name: args.new_name }],
            scans: [
              { layer: { id }, name: args.control },
              { layer: { id }, name: args.new_name },
            ],
          });
        },
        write: { host: "rigRename", args: { comp_id: args.comp_id, layer: args.layer, control: args.control, new_name: args.new_name, label: "Rename control" } },
        check: (before, after) => renameMismatches(args, before, after),
        present: (_before, after, w) => {
          const capped = (after as { scan_truncated?: boolean } | null | undefined)?.scan_truncated === true;
          if (!capped) return w;
          return {
            ...w,
            scan_truncated: true,
            warning: "The reference scan was capped (500 layers or 20000 properties): references past the cap were not checked, so a clean receipt does not prove none are left. Search the rest by hand",
          };
        },
      }),
  },
  {
    name: "ae_rig_list",
    description:
      "List every Expression Control in a comp (or on one layer): layer, name, kind, value (dropdown items on AE 26+), and the expressions that reference it with their expressionError. " +
      "The references come from a text search for effect(\"Name\") (and layer(\"Holder\") across layers); expressions that reach a control through a variable or a layer index are not found. " +
      "Changes nothing in AE: expressions are forced to evaluate with valueAtTime, which moves no time. Lists stop at 500 (truncated: true).",
    schema: AeRigListSchema,
    handler: async (args: z.infer<typeof AeRigListSchema>, ctx: ToolContext) => {
      const res = await ctx.bridge.callHost("rigList", { comp_id: args.comp_id, layer: args.layer, include_references: args.include_references }, {
        label: `ae_rig_list(${args.comp_id})`,
        mutates: false,
        toolName: "ae_rig_list",
      });
      return res.result;
    },
  },
  {
    name: "ae_expr_recipes",
    description:
      "List the expression recipes ae_expr_recipe can apply: wiggle, overshoot, bounce, loop, follow_delay, auto_fade, count_up, master_scale, tint_color, ease_between, follow_text, follow_text_position. " +
      "For each: what it does, the property types it fits (1d, 2d, 3d, color, text), the controls it creates with their default values, and its parameters. Does not talk to After Effects.",
    schema: z.object({ recipe: z.enum(RECIPE_NAMES).optional().describe("Only this recipe.") }),
    handler: async (args: { recipe?: string }) => {
      const list = RECIPES.filter((r) => !args.recipe || r.name === args.recipe).map((r) => ({
        ...r,
        control_names: r.controls.map((c) => ({ key: c.key, name: recipeControlName(r.label, c.label) })),
      }));
      return { recipes: list, note: "Control names use the recipe's label as the prefix unless name_prefix is given." };
    },
  },
  {
    name: "ae_expr_recipe",
    description:
      "Apply a curated expression recipe to a property, with the Expression Controls it needs, in one undo group guarded by `expect`. See ae_expr_recipes for the list. " +
      "The host picks the variant from the property's value type (1D, 2D, 3D, colour, text), refuses a property the recipe doesn't fit, and reports the project's expression engine; the expressions use only syntax both engines accept. " +
      "Controls are named '<name_prefix> <label>' on `controller` (default the property's own layer); one with the same name and kind is reused, so several properties can share a rig. " +
      "Refuses a property that already has an expression unless replace is true. Nothing is created if any check fails, and a failure part-way takes back what the call added. " +
      "The read-back (a separate evalScript) forces the expression to evaluate and checks its text, that it is on, that expressionError is empty, and the new controls' values. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeExprRecipeSchema,
    handler: async (args: RecipeArgs, ctx: ToolContext) => {
      const info = recipeByName(args.recipe);
      if (!info) return { ok: false, error: "bad_args", message: `Unknown recipe "${args.recipe}".` };
      const params = resolveRecipeParams(info, args.params);
      if (!params.ok) return { ok: false, error: "bad_args", message: params.message };
      const plan = planRecipeControls(info, args.name_prefix, args.values);
      if (!plan.ok) return { ok: false, error: "bad_args", message: plan.message };
      if (info.needs_source && !args.source) return { ok: false, error: "bad_args", message: `Recipe ${info.name} needs \`source\`: the layer it follows.` };
      if (!info.needs_source && args.source) return { ok: false, error: "bad_args", message: `Recipe ${info.name} doesn't use \`source\`.` };
      const holder = args.controller ?? args.layer;
      return runGuardedWrite<RecipeWritten>(ctx, {
        toolName: "ae_expr_recipe",
        label: `ae_expr_recipe(${args.recipe})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") {
            return stateRead(args.comp_id, {
              props: [{ layer: args.layer, path: args.path }],
              controls: plan.controls.map((c) => ({ layer: holder, name: c.name })),
            });
          }
          const t = w?.target;
          if (!t) return null;
          return stateRead(args.comp_id, {
            props: [{ layer: { id: t.layer_id }, path: t.path }],
            controls: (w?.controls ?? []).map((c) => ({ layer: { id: c.layer_id }, name: c.name })),
          });
        },
        write: {
          host: "rigRecipe",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            path: args.path,
            recipe: args.recipe,
            params: params.params,
            controller: args.controller,
            source: args.source,
            controls: plan.controls.map((c) => ({ key: c.key, name: c.name, kind: c.kind, value: c.value })),
            replace: args.replace,
            label: `Expression recipe: ${args.recipe}`,
          },
        },
        check: (_before, after, w) => recipeMismatches(plan.controls, w, after),
      });
    },
  },
];
