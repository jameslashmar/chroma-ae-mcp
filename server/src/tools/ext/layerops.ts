/**
 * server/src/tools/ext/layerops.ts
 *
 * ae_layer_ops: the everyday layer edits in one typed, guarded call, with a
 * dry run first and the layer stack before and after:
 * - parent / unparent (keeping the on-screen position, or jumping on request)
 * - reorder (to the beginning or end, before or after a layer) and sort
 * - duplicate (in place, or copyToComp into another comp) and delete
 * - trim in and out points, or move the start time
 * - rename by find and replace, or by a template with a counter
 * - layer switches: shy, solo, lock, guide, video, collapse, 3D, motion blur,
 *   quality, sampling quality, blend mode, label
 *
 * AE does not rewrite layer(3) in an expression when the stack changes, and
 * the expression never errors: it silently points at another layer. So the
 * structural actions read every expression in the comp before and after (in
 * separate evalScript calls) and warn about the references that moved. The
 * scan is a static one on the expression text, done here in Node.
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

// ---------- read-back shape ----------

export interface OpsLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  parent: number | null;
  parent_id?: number | null;
  shy?: boolean;
  solo?: boolean;
  locked?: boolean;
  guide?: boolean;
  label?: number;
  threeD?: boolean;
  motionBlur?: boolean;
  collapse?: boolean;
  quality?: string;
  samplingQuality?: string;
  blendMode?: string;
}

export interface OpsExpression {
  layer_id: number;
  layer_index: number;
  layer_name: string;
  path: string;
  text: string;
  enabled: boolean;
  /** True when the host cut the text at its string bound: a scan of it is partial. */
  text_truncated?: boolean;
  text_length?: number;
}

export interface OpsStack {
  comp_id: number;
  name: string;
  numLayers: number;
  frameDuration?: number;
  /** True when the host listed fewer layers than the comp has (its cap is 500). */
  truncated?: boolean;
  layers: OpsLayer[];
  expressions?: OpsExpression[];
  expressions_truncated?: boolean;
  with_comp?: OpsStack;
}

const stackOf = (v: unknown): OpsStack | null => (v && typeof v === "object" && Array.isArray((v as OpsStack).layers) ? (v as OpsStack) : null);
const byId = (stack: OpsStack | null, id: unknown) => stack?.layers.find((l) => l.id === id);

/** The host lists the first 500 layers plus any asked for by id or index; a layer outside the list can't be judged. */
const capped = (stack: OpsStack | null) => !!stack && (stack.truncated === true || stack.numLayers > stack.layers.length);

// ---------- schemas ----------

export const OPS_ACTIONS = ["parent", "reorder", "sort", "duplicate", "delete", "trim", "rename", "switches"] as const;
export const BLEND_MODES = [
  "normal", "dissolve", "dancing_dissolve", "darken", "multiply", "color_burn", "classic_color_burn", "linear_burn", "darker_color",
  "add", "lighten", "screen", "color_dodge", "classic_color_dodge", "linear_dodge", "lighter_color", "overlay", "soft_light",
  "hard_light", "linear_light", "vivid_light", "pin_light", "hard_mix", "difference", "classic_difference", "exclusion",
  "subtract", "divide", "hue", "saturation", "color", "luminosity", "stencil_alpha", "stencil_luma", "silhouette_alpha",
  "silhouette_luma", "alpha_add", "luminescent_premul",
] as const;
const LAYER_KINDS = ["solid", "null", "adjustment", "text", "shape", "camera", "light", "footage", "precomp", "audio"] as const;

export const WhereSchema = z
  .object({
    label: z.number().int().min(0).max(16).optional().describe("Label colour index 0-16 (0 is none)."),
    kind: z.enum(LAYER_KINDS).optional().describe("Layer kind."),
    name_contains: z.string().min(1).optional().describe("Case-insensitive part of the layer name."),
    shy: z.boolean().optional(),
    locked: z.boolean().optional(),
    enabled: z.boolean().optional().describe("The video (eye) switch."),
    has_parent: z.boolean().optional(),
  })
  .describe("Narrows the layers (or, with no `layers`, the whole stack) to those that match every field given.");

/** The parameters each action takes besides the common ones. Anything else is refused, so a wrong guess is not silently ignored. */
const ACTION_FIELDS: Record<(typeof OPS_ACTIONS)[number], readonly string[]> = {
  parent: ["parent", "unparent", "keep_position"],
  reorder: ["move_to", "relative_to"],
  sort: ["sort_by", "descending"],
  duplicate: ["count", "to_comp_id"],
  delete: [],
  trim: ["in_point", "out_point", "start_time"],
  rename: ["find", "replace", "case_sensitive", "template", "start_number", "number_pad", "fix_name_references"],
  switches: [
    "shy", "solo", "locked", "guide", "enabled", "collapse_transformations", "three_d", "motion_blur",
    "quality", "sampling_quality", "blend_mode", "label_color",
  ],
};
const ALL_ACTION_FIELDS = [...new Set(Object.values(ACTION_FIELDS).flat())];
const SWITCH_FIELDS = ACTION_FIELDS.switches;

const BaseObject = z.object({
  action: z.enum(OPS_ACTIONS).describe("What to do. Each action takes its own parameters below; parameters of other actions are refused."),
  comp_id: z.number().int(),
  layers: z.array(LayerSelectorSchema).min(1).max(500).optional().describe("The layers to work on, by id, index or unique name. Every action but sort needs `layers` or `where`; sort defaults to the whole stack."),
  where: WhereSchema.optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe("Plan only: returns what would change (and the layer(index) expressions that would break) and writes nothing, no undo step, no checkpoint. Do this first."),
  unlock_locked: z
    .boolean()
    .optional()
    .describe("Locked layers refuse edits. false (default): the call is refused when a locked layer would be edited. true: unlock them, edit, and lock them again in the same undo group."),

  // parent
  parent: LayerSelectorSchema.optional().describe("parent: the new parent layer."),
  unparent: z.boolean().optional().describe("parent: remove the parent instead."),
  keep_position: z
    .boolean()
    .optional()
    .describe("parent: default true: assigning layer.parent, AE offsets the child's transform so nothing moves on screen. false: setParentWithJump keeps the child's own values, so it jumps."),

  // reorder
  move_to: z.enum(["beginning", "end", "before", "after"]).optional().describe("reorder: where the layers go. They keep their order among themselves."),
  relative_to: LayerSelectorSchema.optional().describe("reorder: the layer to go before or after (move_to before or after)."),

  // sort
  sort_by: z.enum(["name", "start_time", "in_point", "out_point", "z", "label", "index"]).optional().describe("sort: the key. name is natural and case-insensitive (Layer 2 before Layer 10); z is the Position z at the current time. The sorted layers fill the slots the selection held, smallest key on top."),
  descending: z.boolean().optional().describe("sort: largest key first."),

  // duplicate
  count: z.number().int().min(1).max(50).optional().describe("duplicate: copies of each layer, in the same comp. Default 1."),
  to_comp_id: z.number().int().optional().describe("duplicate: copy the layers into this comp with copyToComp (one copy each, on top there) instead of in place."),

  // trim
  in_point: z.number().min(-36000).max(36000).optional().describe("trim: the layer's new in point, in comp seconds."),
  out_point: z.number().min(-36000).max(36000).optional().describe("trim: the layer's new out point, in comp seconds."),
  start_time: z.number().min(-36000).max(36000).optional().describe("trim: move the layer so its start time is this, in comp seconds. In and out move with it, then in_point and out_point apply."),

  // rename
  find: z.string().min(1).max(200).optional().describe("rename: text to find in each name (literal, every occurrence)."),
  replace: z.string().max(200).optional().describe("rename: what to put instead. Default empty."),
  case_sensitive: z.boolean().optional().describe("rename: match case in find. Default false."),
  template: z.string().min(1).max(200).optional().describe("rename: the new name, with {name} (the name after find/replace), {n} (a counter over the selected layers in stack order) and {index} (the layer's index)."),
  start_number: z.number().int().min(0).max(1000000).optional().describe("rename: where {n} starts. Default 1."),
  number_pad: z.number().int().min(0).max(8).optional().describe("rename: digits {n} and {index} are padded to with zeros. Default 0."),
  fix_name_references: z
    .boolean()
    .optional()
    .describe("rename: afterwards run Project.autoFixExpressions for each old name, which repairs name references in expressions that now error. It works on the whole project and only touches broken expressions."),

  // switches
  shy: z.boolean().optional(),
  solo: z.boolean().optional(),
  locked: z.boolean().optional().describe("switches: lock or unlock the layers."),
  guide: z.boolean().optional().describe("switches: guide layer."),
  enabled: z.boolean().optional().describe("switches: the video (eye) switch."),
  collapse_transformations: z.boolean().optional().describe("switches: collapse transformations / continuously rasterize. Precomp and vector layers only; others are skipped."),
  three_d: z.boolean().optional().describe("switches: the 3D switch. Cameras, lights and audio-only layers are skipped."),
  motion_blur: z.boolean().optional(),
  quality: z.enum(["best", "draft", "wireframe"]).optional(),
  sampling_quality: z.enum(["bilinear", "bicubic"]).optional(),
  blend_mode: z.enum(BLEND_MODES).optional(),
  label_color: z.number().int().min(0).max(16).optional().describe("switches: label colour index 0-16 (AE's custom label colours can't be set by script)."),

  expect: ExpectSchema,
});

type OpsArgs = z.infer<typeof BaseObject>;

export const AeLayerOpsSchema = BaseObject.superRefine((v, ctx) => {
  const bad = (message: string, path?: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: path ? [path] : undefined });
  const allowed = new Set(ACTION_FIELDS[v.action]);
  for (const key of ALL_ACTION_FIELDS) {
    if (!allowed.has(key) && (v as Record<string, unknown>)[key] !== undefined) bad(`${key} does not apply to the ${v.action} action.`, key);
  }
  if (v.action !== "sort" && v.layers === undefined && v.where === undefined) bad(`${v.action} needs layers or where.`, "layers");
  if (v.where !== undefined && Object.values(v.where).every((x) => x === undefined)) bad("where is empty; give at least one field.", "where");
  if (v.action === "parent") {
    if (v.unparent && v.parent) bad("Give parent or unparent, not both.", "parent");
    if (!v.unparent && !v.parent) bad("parent needs the new parent layer, or unparent: true.", "parent");
    if (v.unparent && v.keep_position === false) bad("keep_position false needs a new parent; unparent: true keeps the position.", "keep_position");
  }
  if (v.action === "reorder") {
    if (!v.move_to) bad("reorder needs move_to.", "move_to");
    if ((v.move_to === "before" || v.move_to === "after") && !v.relative_to) bad(`move_to ${v.move_to} needs relative_to.`, "relative_to");
    if ((v.move_to === "beginning" || v.move_to === "end") && v.relative_to) bad("relative_to goes with move_to before or after.", "relative_to");
  }
  if (v.action === "sort" && !v.sort_by) bad("sort needs sort_by.", "sort_by");
  if (v.action === "duplicate" && v.to_comp_id !== undefined) {
    if (v.to_comp_id === v.comp_id) bad("to_comp_id is the same comp; leave it out to duplicate in place.", "to_comp_id");
    if (v.count !== undefined && v.count > 1) bad("count above 1 works for duplicates in the same comp only.", "count");
  }
  if (v.action === "trim") {
    if (v.in_point === undefined && v.out_point === undefined && v.start_time === undefined) bad("trim needs in_point, out_point or start_time.", "in_point");
    if (v.in_point !== undefined && v.out_point !== undefined && v.in_point >= v.out_point) bad("in_point must be before out_point.", "in_point");
  }
  if (v.action === "rename") {
    if (v.find === undefined && v.template === undefined) bad("rename needs find (with replace) or template.", "find");
    if (v.replace !== undefined && v.find === undefined) bad("replace goes with find.", "replace");
  }
  if (v.action === "switches" && SWITCH_FIELDS.every((k) => (v as Record<string, unknown>)[k] === undefined)) {
    bad(`switches needs at least one of: ${SWITCH_FIELDS.join(", ")}.`, "shy");
  }
});

// ---------- expression scan (static text, in Node) ----------

/** Comments blanked (strings kept), and a second copy with string contents blanked as well. Same length, so offsets line up. */
function maskExpression(text: string): { noComments: string; codeOnly: string } {
  let noComments = "";
  let codeOnly = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote) {
      if (c === "\\" && i + 1 < text.length) {
        noComments += c + next!;
        codeOnly += "  ";
        i += 2;
        continue;
      }
      const closing = c === quote;
      if (closing) quote = "";
      noComments += c;
      codeOnly += closing ? c : " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      noComments += c;
      codeOnly += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        noComments += " ";
        codeOnly += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) {
        const blank = text[i] === "\n" || text[i] === "\r" ? text[i]! : " ";
        noComments += blank;
        codeOnly += blank;
      }
      continue;
    }
    noComments += c;
    codeOnly += c;
    i++;
  }
  return { noComments, codeOnly };
}

/** Whether a layer(...) call at `at` in the masked code reads this comp: bare layer(, or thisComp.layer(. comp("x").layer( and other receivers are other comps. */
function readsThisComp(code: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (j < 0) return true;
  if (code[j] === ".") {
    const before = code.slice(0, j).trimEnd();
    return /(?:^|[^\w$.])thisComp$/.test(before);
  }
  return !/[\w$]/.test(code[j]!);
}

export interface IndexReference {
  /** The literal index, or the offset from the layer's own index for relative references. */
  value: number;
  relative: boolean;
  /** For a relative reference: false when the argument is index arithmetic this scan can't evaluate. */
  parsed: boolean;
  start: number;
  end: number;
  text: string;
}

/** layer(3), thisComp.layer(3) and layer(index - 1) in an expression's code. */
export function findIndexReferences(expression: string): IndexReference[] {
  const { codeOnly } = maskExpression(expression);
  const out: IndexReference[] = [];
  const re = /layer\s*\(([^()]*)\)/g;
  for (let m = re.exec(codeOnly); m !== null; m = re.exec(codeOnly)) {
    if (!readsThisComp(codeOnly, m.index)) continue;
    const arg = m[1]!.trim();
    const full = m[0];
    const argStart = m.index + full.indexOf("(") + 1;
    if (/^\d+$/.test(arg)) {
      out.push({ value: Number(arg), relative: false, parsed: true, start: argStart, end: argStart + m[1]!.length, text: full });
    } else if (/\bindex\b/.test(arg)) {
      const rel = /^(?:thisLayer\s*\.\s*)?index\s*(?:([+-])\s*(\d+))?$/.exec(arg);
      if (rel) {
        const delta = rel[1] ? (rel[1] === "-" ? -Number(rel[2]) : Number(rel[2])) : 0;
        out.push({ value: delta, relative: true, parsed: true, start: argStart, end: argStart + m[1]!.length, text: full });
      } else {
        out.push({ value: 0, relative: true, parsed: false, start: argStart, end: argStart + m[1]!.length, text: full });
      }
    }
  }
  return out;
}

/** layer("Name") and thisComp.layer('Name') in an expression: the names it refers to. */
export function findNameReferences(expression: string): string[] {
  const { noComments, codeOnly } = maskExpression(expression);
  const out: string[] = [];
  const re = /layer\s*\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;
  for (let m = re.exec(noComments); m !== null; m = re.exec(noComments)) {
    if (!readsThisComp(codeOnly, m.index)) continue;
    out.push(m[2]!.replace(/\\(["'\\])/g, "$1"));
  }
  return out;
}

export interface ExpressionWarning {
  layer_id: number;
  layer_name: string;
  path: string;
  kind: "index" | "relative_index" | "relative_index_unparsed" | "name" | "partial_scan" | "copied_reference";
  reference: string;
  was?: { index: number; layer_id: number; layer_name: string };
  /** What the reference reads after the change: the layer now at that index, or null when there is none. */
  now?: { index: number; layer_id: number; layer_name: string } | null;
  message: string;
  /** The expression with moved index references rewritten to the new indexes. Name references are the sturdier fix: layer("Name"). */
  suggested_expression?: string;
}

/**
 * Where each layer id goes: its new index, or null when it is gone. Ids that are
 * absent are unknown (past the host's list) and are not judged.
 */
export type IndexMap = Map<number, number | null>;

/** The index map of the stack the write left. */
export function indexMapFromStack(before: OpsStack, after: OpsStack): IndexMap {
  const map: IndexMap = new Map();
  const complete = !capped(after);
  for (const l of before.layers) {
    const now = after.layers.find((x) => x.id === l.id);
    if (now) map.set(l.id, now.index);
    else if (complete) map.set(l.id, null);
  }
  return map;
}

/** The index map the planned order gives. null entries are layers the action will add. */
export function indexMapFromOrder(before: OpsStack, order: Array<number | null>, truncated: boolean): IndexMap {
  const map: IndexMap = new Map();
  const at = new Map<number, number>();
  order.forEach((id, i) => {
    if (id !== null) at.set(id, i + 1);
  });
  for (const l of before.layers) {
    const now = at.get(l.id);
    if (now !== undefined) map.set(l.id, now);
    else if (!truncated) map.set(l.id, null);
  }
  return map;
}

const MAX_WARNINGS = 100;

function partialScanWarning(ex: OpsExpression): ExpressionWarning {
  return {
    layer_id: ex.layer_id,
    layer_name: ex.layer_name,
    path: ex.path,
    kind: "partial_scan",
    reference: "",
    message: `The expression on "${ex.layer_name}" (${ex.path}) is ${ex.text_length ?? "longer than the bound"} characters and was read only in part, so layer(index) references past the cut were not checked. No rewrite is suggested for it.`,
  };
}

/**
 * layer(N) references that point at another layer after the change. AE never
 * reports these (the expression still evaluates), so they are found from the
 * expression text and the layer each index meant before.
 * `occupant` names the layer now at an index, when the new stack is known.
 */
export function indexReferenceWarnings(
  before: OpsStack,
  map: IndexMap,
  occupant: (index: number) => { layer_id: number; layer_name: string } | undefined
): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  const idAt = new Map<number, OpsLayer>();
  for (const l of before.layers) idAt.set(l.index, l);
  for (const ex of before.expressions ?? []) {
    if (!ex.enabled) continue;
    if (out.length >= MAX_WARNINGS) break;
    if (!map.has(ex.layer_id) || map.get(ex.layer_id) === null) continue; // the owner is gone or unknown
    if (ex.text_truncated) out.push(partialScanWarning(ex));
    const ownerOld = ex.layer_index;
    const ownerNew = map.get(ex.layer_id) as number;
    const edits: Array<{ start: number; end: number; to: number }> = [];
    const found: ExpressionWarning[] = [];
    for (const ref of findIndexReferences(ex.text)) {
      if (ref.relative && !ref.parsed) {
        if (ownerOld !== ownerNew) {
          found.push({
            layer_id: ex.layer_id,
            layer_name: ex.layer_name,
            path: ex.path,
            kind: "relative_index_unparsed",
            reference: ref.text,
            message: `${ref.text} uses index arithmetic this scan can't evaluate, and its layer moved from ${ownerOld} to ${ownerNew}: check what it points at.`,
          });
        }
        continue;
      }
      const oldIndex = ref.relative ? ownerOld + ref.value : ref.value;
      const target = idAt.get(oldIndex);
      if (!target) continue; // pointed past the stack: it already errored or meant nothing
      if (!map.has(target.id)) continue;
      const newTarget = map.get(target.id) as number | null;
      const readsIndex = ref.relative ? ownerNew + ref.value : ref.value;
      const kind = ref.relative ? "relative_index" : "index";
      const was = { index: oldIndex, layer_id: target.id, layer_name: target.name };
      if (newTarget === null) {
        const occ = occupant(readsIndex);
        found.push({
          layer_id: ex.layer_id,
          layer_name: ex.layer_name,
          path: ex.path,
          kind,
          reference: ref.text,
          was,
          now: occ ? { index: readsIndex, ...occ } : null,
          message: `${ref.text} pointed at "${target.name}", which is deleted; it now reads ${occ ? `"${occ.layer_name}"` : "no layer"}.`,
        });
      } else if (newTarget !== readsIndex) {
        const occ = occupant(readsIndex);
        found.push({
          layer_id: ex.layer_id,
          layer_name: ex.layer_name,
          path: ex.path,
          kind,
          reference: ref.text,
          was,
          now: occ ? { index: readsIndex, ...occ } : null,
          message: `${ref.text} pointed at "${target.name}", which is now at index ${newTarget}; it reads ${occ ? `"${occ.layer_name}"` : "index " + readsIndex} instead.`,
        });
        if (!ref.relative) edits.push({ start: ref.start, end: ref.end, to: newTarget });
      }
    }
    if (found.length > 0) {
      let suggestion: string | undefined;
      // A cut expression is never offered as a replacement: applying it would destroy the rest.
      if (edits.length > 0 && !ex.text_truncated) {
        suggestion = ex.text;
        for (const e of [...edits].sort((a, b) => b.start - a.start)) suggestion = suggestion.slice(0, e.start) + String(e.to) + suggestion.slice(e.end);
        for (const f of found) f.suggested_expression = suggestion;
      }
      out.push(...found);
    }
  }
  return out.slice(0, MAX_WARNINGS);
}

/**
 * layer("Old") references to a layer that was renamed and that no layer carries
 * any more. AE may rewrite these itself on rename (not measured); this finds the
 * ones it left.
 */
export function nameReferenceWarnings(after: OpsStack, renames: Array<{ id: number; from: string; to: string }>): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  if (capped(after)) return out;
  const names = new Set(after.layers.map((l) => l.name));
  const renamed = new Map(renames.map((r) => [r.from, r.to]));
  for (const ex of after.expressions ?? []) {
    if (!ex.enabled) continue;
    if (ex.text_truncated && out.length < MAX_WARNINGS) out.push(partialScanWarning(ex));
    for (const ref of findNameReferences(ex.text)) {
      if (!renamed.has(ref) || names.has(ref)) continue;
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "name",
        reference: `layer("${ref}")`,
        message: `layer("${ref}") refers to a layer renamed to "${renamed.get(ref)}"; no layer has the old name now. Repair it with fix_name_references or ae_batch_set.`,
      });
    }
  }
  return out;
}

// ---------- receipt checks ----------

interface Written extends Record<string, unknown> {
  action?: string;
  targets?: Array<{ id: number }>;
  applied_ids?: number[];
  moved_ids?: number[];
  parent_id?: number | null;
  order_after?: Array<number | null>;
  order_truncated?: boolean;
  duplicates?: Array<{ source_id: number; id: number; name: string }>;
  duplicates_total?: number;
  deleted?: Array<{ id: number; name: string }>;
  deleted_total?: number;
  trims?: Array<{ id: number; start_time: number; in_point: number; out_point: number }>;
  partial_ids?: number[];
  renames?: Array<{ id: number; from: string; to: string }>;
  changes?: Array<{ id: number; key: string; from: unknown; to: unknown }>;
  to_comp_id?: number;
  no_op?: boolean;
}

/** The switch each `switches` key lands in on a read-back layer. */
const SWITCH_FIELD: Record<string, keyof OpsLayer> = {
  shy: "shy",
  solo: "solo",
  locked: "locked",
  guide: "guide",
  enabled: "enabled",
  collapse_transformations: "collapse",
  three_d: "threeD",
  motion_blur: "motionBlur",
  quality: "quality",
  sampling_quality: "samplingQuality",
  blend_mode: "blendMode",
  label_color: "label",
};

/** The fields of a layer no action here changes by itself: if one differs, the write touched a layer it shouldn't have. */
const BYSTANDER_FIELDS = ["name", "enabled", "shy", "solo", "locked", "label", "guide", "threeD", "motionBlur", "blendMode"] as const;

export function layerOpsMismatches(args: Pick<OpsArgs, "action">, beforeRaw: unknown, afterRaw: unknown, w: Written): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stackOf(beforeRaw);
  const after = stackOf(afterRaw);
  if (!before || !after || w.no_op) return m;
  const complete = !capped(before) && !capped(after);
  const touched = new Set<number>();
  for (const t of w.targets ?? []) touched.add(t.id);
  for (const d of w.duplicates ?? []) touched.add(d.id);
  if (typeof w.parent_id === "number") touched.add(w.parent_id);

  const grew = (w.action === "duplicate" && w.to_comp_id === undefined ? (w.duplicates_total ?? w.duplicates?.length ?? 0) : 0) - (w.action === "delete" ? (w.deleted_total ?? w.deleted?.length ?? 0) : 0);
  expectThat(m, after.numLayers === before.numLayers + grew, "numLayers", before.numLayers + grew, after.numLayers, "Layer count is not what the action should leave");

  if (args.action === "parent") {
    for (const id of w.applied_ids ?? []) {
      const l = byId(after, id);
      if (!l) {
        if (!complete) continue;
        m.push({ path: `layer[${id}]`, expected: "present", actual: undefined, message: "A re-parented layer is not in the read-back" });
        continue;
      }
      if (w.parent_id === null || w.parent_id === undefined) {
        expectThat(m, l.parent === null, `layer[${l.name}].parent`, null, l.parent, "The layer still has a parent");
      } else {
        const p = byId(after, w.parent_id);
        if (p || complete) expectThat(m, p !== undefined && l.parent === p.index, `layer[${l.name}].parent`, p?.index, l.parent, "Parent differs");
      }
    }
  }

  if (args.action === "reorder" || args.action === "sort") {
    const want = w.order_after ?? [];
    const got = after.layers.map((l) => l.id);
    const n = Math.min(want.length, got.length, 500);
    const same = want.slice(0, n).every((id, i) => id === got[i]);
    expectThat(m, same, "order", want.slice(0, n), got.slice(0, n), "The layer order is not what the action planned");
  }

  if (args.action === "duplicate") {
    const target = w.to_comp_id !== undefined ? after.with_comp : after;
    const targetBefore = w.to_comp_id !== undefined ? before.with_comp : before;
    for (const d of w.duplicates ?? []) {
      const l = byId(target ?? null, d.id);
      if (!l && !capped(target ?? null)) m.push({ path: `duplicate[${d.id}]`, expected: "present", actual: undefined, message: "A copy is not in the read-back" });
    }
    if (w.to_comp_id !== undefined) {
      const want = (targetBefore?.numLayers ?? 0) + (w.duplicates_total ?? w.duplicates?.length ?? 0);
      expectThat(m, target !== undefined && targetBefore !== undefined && target.numLayers === want, "to_comp.numLayers", want, target?.numLayers, "The destination comp did not grow by the copies");
    }
  }

  if (args.action === "delete") {
    for (const d of w.deleted ?? []) {
      if (complete) expectThat(m, byId(after, d.id) === undefined, `deleted[${d.id}]`, "gone", "still there", `"${d.name}" is still in the comp`);
    }
  }

  if (args.action === "trim") {
    const tol = (after.frameDuration ?? 0.05) * 1.01 + 1e-6;
    const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
    for (const t of w.trims ?? []) {
      if (!w.applied_ids?.includes(t.id)) {
        // Skipped or half applied: every time must still be the planned one or the one it had.
        const lb = byId(before, t.id);
        const la = byId(after, t.id);
        if (!la || !lb) continue;
        const pairs: Array<[string, number | undefined, number | undefined, number]> = [
          ["startTime", la.startTime, lb.startTime, t.start_time],
          ["inPoint", la.inPoint, lb.inPoint, t.in_point],
          ["outPoint", la.outPoint, lb.outPoint, t.out_point],
        ];
        for (const [field, got, was, planned] of pairs) {
          if (got === undefined || was === undefined) continue;
          if (!near(got, was) && !near(got, planned)) {
            m.push({ path: `layer[${la.name}].${field}`, expected: was, actual: got, message: `"${la.name}" was reported as not trimmed but its ${field} changed` });
          }
        }
        if (w.partial_ids?.includes(t.id)) {
          m.push({ path: `layer[${la.name}]`, expected: "untouched", actual: "partly trimmed", message: `AE refused part of the trim of "${la.name}" and the layer could not be put back; check its times` });
        }
        continue;
      }
      const l = byId(after, t.id);
      if (!l) continue;
      if (l.startTime !== undefined) expectThat(m, Math.abs(l.startTime - t.start_time) <= tol, `layer[${l.name}].startTime`, t.start_time, l.startTime, "Start time differs (AE did not take it, or clamped it)");
      if (l.inPoint !== undefined) expectThat(m, Math.abs(l.inPoint - t.in_point) <= tol, `layer[${l.name}].inPoint`, t.in_point, l.inPoint, "In point differs (AE clamps it to the source)");
      if (l.outPoint !== undefined) expectThat(m, Math.abs(l.outPoint - t.out_point) <= tol, `layer[${l.name}].outPoint`, t.out_point, l.outPoint, "Out point differs (AE clamps it to the source)");
    }
  }

  if (args.action === "rename") {
    for (const r of w.renames ?? []) {
      if (!w.applied_ids?.includes(r.id)) continue;
      const l = byId(after, r.id);
      if (l) expectThat(m, l.name === r.to, `layer[${r.id}].name`, r.to, l.name, "Name differs");
    }
  }

  if (args.action === "switches") {
    for (const c of w.changes ?? []) {
      const l = byId(after, c.id);
      const field = SWITCH_FIELD[c.key];
      if (!l || !field) continue;
      expectThat(m, l[field] === c.to, `layer[${l.name}].${c.key}`, c.to, l[field], "Switch differs");
    }
  }

  // Layers the action did not name must come out as they went in.
  if (complete) {
    for (const l of after.layers) {
      if (touched.has(l.id)) continue;
      const was = byId(before, l.id);
      if (!was) continue;
      for (const f of BYSTANDER_FIELDS) {
        if (was[f] !== undefined && l[f] !== undefined && was[f] !== l[f]) {
          m.push({ path: `layers[${l.name}].${f}`, expected: was[f], actual: l[f], message: `"${l.name}" was not part of the action but its ${f} changed` });
        }
      }
    }
  }
  return m;
}

// ---------- tool ----------

const STRUCTURAL: ReadonlyArray<OpsArgs["action"]> = ["reorder", "sort", "duplicate", "delete", "rename"];

const uniq = (v: Array<number | undefined | null>): number[] => [...new Set(v.filter((n): n is number => typeof n === "number"))].slice(0, 50);

function selectorRefs(sels: Array<LayerSelector | undefined>): { ids: number[]; indexes: number[] } {
  const ids: Array<number | undefined> = [];
  const indexes: Array<number | undefined> = [];
  for (const s of sels) {
    if (!s) continue;
    ids.push(s.id);
    indexes.push(s.index);
  }
  return { ids: uniq(ids), indexes: uniq(indexes) };
}

/** A read of the comp: layers, and the comp's expressions when the action can move layer(index) references. */
function opsRead(args: OpsArgs, extraIds: Array<number | undefined | null> = [], phase: "before" | "after" = "before") {
  const refs = selectorRefs([...(args.layers ?? []), args.parent, args.relative_to]);
  const call: Record<string, unknown> = { comp_id: args.comp_id };
  // The after scan is only used by rename (name references left behind); the other actions judge from the before text.
  if (STRUCTURAL.includes(args.action) && (phase === "before" || args.action === "rename")) call.scan_expressions = true;
  if (args.to_comp_id !== undefined) call.with_comp_id = args.to_comp_id;
  const ids = uniq([...refs.ids, ...extraIds]);
  if (ids.length) call.include_ids = ids;
  if (refs.indexes.length) call.include_indexes = refs.indexes;
  return { host: "layeropsRead", args: call };
}

/** The host's arguments: everything the action takes, without the tool-only flags. */
function hostArgs(args: OpsArgs): Record<string, unknown> {
  const { dry_run: _dry, expect: _expect, ...rest } = args;
  return rest;
}

const compact = (stack: OpsStack | null) =>
  stack && {
    numLayers: stack.numLayers,
    truncated: capped(stack) || undefined,
    layers: stack.layers.map((l) => ({ index: l.index, id: l.id, name: l.name, kind: l.kind, parent: l.parent })),
  };

async function dryRun(args: OpsArgs, ctx: ToolContext) {
  const label = `ae_layer_ops(${args.action}, dry run)`;
  const base = { mutates: false, toolName: "ae_layer_ops" };
  const read = opsRead(args);
  const beforeRes = await ctx.bridge.callHost<OpsStack>(read.host, read.args, { label: `${label} (read)`, ...base });
  const planRes = await ctx.bridge.callHost<Written>("layeropsPlan", hostArgs(args), { label, ...base });
  const plan = planRes.result;
  const before = stackOf(beforeRes.result);
  let would_break: ExpressionWarning[] | undefined;
  if (before && Array.isArray(plan.order_after)) {
    const map = indexMapFromOrder(before, plan.order_after, plan.order_truncated === true);
    const nameOf = new Map(before.layers.map((l) => [l.id, l.name]));
    would_break = indexReferenceWarnings(before, map, (index) => {
      const id = plan.order_after![index - 1];
      return typeof id === "number" ? { layer_id: id, layer_name: nameOf.get(id) ?? "" } : undefined;
    });
  }
  return {
    ...plan,
    dry_run: true,
    stack: compact(before),
    would_break_expressions: would_break,
    expressions_scanned: before?.expressions ? before.expressions.length : undefined,
    expressions_truncated: before?.expressions_truncated || undefined,
    note: "Nothing was changed. Run the same call without dry_run to apply it.",
  };
}

/**
 * duplicate into another comp: the copies land on top there and push every layer
 * down, so the destination's layer(index) references can read another layer; and
 * the copies' own layer(...) references now resolve against the destination.
 */
export function copiedToCompWarnings(before: OpsStack, after: OpsStack, w: Written): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  const destBefore = before.with_comp;
  const destAfter = after.with_comp;
  if (destBefore && destAfter) {
    const map = indexMapFromStack(destBefore, destAfter);
    const byIndex = new Map(destAfter.layers.map((l) => [l.index, l]));
    out.push(
      ...indexReferenceWarnings(destBefore, map, (index) => {
        const l = byIndex.get(index);
        return l ? { layer_id: l.id, layer_name: l.name } : undefined;
      })
    );
  }
  const copied = new Set((w.duplicates ?? []).map((d) => d.source_id));
  for (const ex of before.expressions ?? []) {
    if (!copied.has(ex.layer_id) || !ex.enabled) continue;
    if (ex.text_truncated) out.push(partialScanWarning(ex));
    const refs = [...findIndexReferences(ex.text).map((r) => r.text), ...findNameReferences(ex.text).map((n) => `layer("${n}")`)];
    for (const reference of refs) {
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "copied_reference",
        reference,
        message: `${reference} on "${ex.layer_name}" was copied to the destination comp, where it reads that comp's layers, not the ones it meant here. Check the copy.`,
      });
    }
  }
  return out.slice(0, MAX_WARNINGS);
}

export const layeropsTools: ToolDefinition<any>[] = [
  {
    name: "ae_layer_ops",
    description:
      "Everyday layer edits in one call: action parent (assigns layer.parent, so the child keeps its on-screen position; keep_position false uses setParentWithJump and the layer jumps), " +
      "reorder (beginning, end, before or after a layer), sort (by name, start time, in or out point, z, label), duplicate (in place, or copyToComp into another comp), delete, " +
      "trim (in point, out point, start time), rename (find and replace, or a template with a padded counter) and switches (shy, solo, locked, guide, enabled, collapse transformations, 3D, motion blur, quality, sampling quality, blend mode, label colour). " +
      "Pick the layers with `layers` and/or `where` (label, kind, name part, switches). Layer types a switch does not fit (cameras and lights have no motion blur, 3D is always on) are skipped and listed, not errors. " +
      "Locked layers are refused unless unlock_locked is true, which unlocks and relocks them in the same undo group. " +
      "dry_run returns the plan with nothing written. " +
      "AE does not rewrite layer(3) in expressions when layers move and never reports it: reorder, sort, duplicate, delete and rename read every expression in the comp before and after and return expression_warnings for index references that now read another layer (and name references left behind by a rename), with a suggested rewrite. " +
      "The write is one undo group guarded by `expect`; the read-back (a separate evalScript) checks parents, order, counts, times, names and switches, and that other layers did not change, and returns the stack before and after. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeLayerOpsSchema,
    handler: async (args: OpsArgs, ctx) => {
      if (args.dry_run) return dryRun(args, ctx);
      return runGuardedWrite<Written>(ctx, {
        toolName: "ae_layer_ops",
        label: `ae_layer_ops(${args.action})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return opsRead(args);
          const ids: Array<number | null | undefined> = [];
          for (const t of w?.targets ?? []) ids.push(t.id);
          for (const d of w?.duplicates ?? []) ids.push(d.id);
          ids.push(w?.parent_id);
          return opsRead(args, ids, "after");
        },
        write: { host: "layeropsApply", args: { ...hostArgs(args), label: `Layer ops: ${args.action}` } },
        check: (before, after, w) => layerOpsMismatches(args, before, after, w),
        present: (beforeRaw, afterRaw, w) => {
          const before = stackOf(beforeRaw);
          const after = stackOf(afterRaw);
          let expression_warnings: ExpressionWarning[] = [];
          if (before && after && !w.no_op && STRUCTURAL.includes(args.action)) {
            const map = indexMapFromStack(before, after);
            const byIndex = new Map(after.layers.map((l) => [l.index, l]));
            expression_warnings = indexReferenceWarnings(before, map, (index) => {
              const l = byIndex.get(index);
              return l ? { layer_id: l.id, layer_name: l.name } : undefined;
            });
            if (args.action === "rename") expression_warnings.push(...nameReferenceWarnings(after, w.renames ?? []));
            if (args.action === "duplicate" && args.to_comp_id !== undefined) {
              expression_warnings.push(...copiedToCompWarnings(before, after, w));
            }
          }
          const { order_after: _order, ...rest } = w;
          return {
            ...rest,
            stack_before: compact(before),
            stack_after: compact(after),
            expression_warnings,
            expressions_truncated: before?.expressions_truncated || undefined,
          };
        },
      });
    },
  },
];
