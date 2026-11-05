/**
 * server/src/tools/ext/production.ts
 *
 * Production tools:
 * - ae_get_essential_graphics / ae_set_essential_graphics: a comp's
 *   Essential Graphics template (controllers, name) and a precomp layer's
 *   overrides
 * - ae_render_templates: render-settings and output-module template names,
 *   and saving a queue item's settings or output module as a named template
 * - ae_version_footage: which footage has newer versions on disk, and
 *   swapping to them, logged next to the .aep
 * - ae_batch_set: many property writes in one undo group per 500, checked
 *   before anything changes, with a pause between chunks so AE stays usable
 */

import { z } from "zod";
import { normalizeGuardPath } from "../../jsx.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { appendVersionLog, planVersion, versionToken, type VersionLogEntry } from "../../versions.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { KeyframeItemSchema } from "../mutate.js";
import { DEFAULT_AUDIO_TEMPLATE } from "./audio.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const PathSchema = z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1);

// ---------- Essential Graphics ----------

export const AeGetEssentialGraphicsSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.optional().describe("A precomp layer in this comp: also list its overrides (Essential Properties)."),
});

export const AeSetEssentialGraphicsSchema = z
  .object({
    comp_id: z.number().int(),
    action: z
      .enum(["add", "rename", "template_name", "set_override", "set_media"])
      .describe(
        "add: a property (or a layer's media) to this comp's template; rename: a controller; template_name: the template's name; set_override: a precomp layer's Essential Property value; " +
          "set_media: replace the footage or comp behind a media-replacement Essential Property (Property.setAlternateSource, AE 18+), checked with isMediaReplacementCompatible."
      ),
    layer: LayerSelectorSchema.optional().describe("add: the layer holding the property; set_override and set_media: the precomp layer."),
    path: PathSchema.optional().describe(
      "add: the property's path from the layer. Leave it out to add the layer's own media slot (media replacement) when this AE can (the call says so when it cannot; canAdd is checked first, never a dialog)."
    ),
    index: z.number().int().positive().optional().describe("rename: the controller's 1-based index."),
    name: z.string().min(1).max(200).optional().describe("add: the controller's name (optional); rename and template_name: the new name; set_override and set_media: the Essential Property's name (groups are searched too)."),
    item_id: z.number().int().optional().describe("set_media: the project item (footage or comp) to put behind the slot."),
    value: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]).optional().describe("set_override: the value (text for a source text property)."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (v.action === "add") need(v.layer !== undefined, "add needs layer (and path, unless it adds the layer's media slot).");
    if (v.action === "rename") need(v.index !== undefined && v.name !== undefined, "rename needs index and name.");
    if (v.action === "template_name") need(v.name !== undefined, "template_name needs name.");
    if (v.action === "set_override") need(v.layer !== undefined && v.name !== undefined && v.value !== undefined, "set_override needs layer, name and value.");
    if (v.action === "set_media") need(v.layer !== undefined && v.name !== undefined && v.item_id !== undefined, "set_media needs layer, name and item_id.");
  });

export interface EgpOverride {
  index: number;
  name: string;
  /** Only groups say so; a property has no kind. */
  kind?: "group";
  value?: unknown;
  /** Where the value comes from (Property.essentialPropertySource, AE 22): a property or a layer, described, or null. */
  source?: { kind: "property" | "layer"; layer_id?: number; layer_name?: string; name?: string; match_name?: string; path?: Array<string | number> } | null;
  can_set_alternate_source?: boolean;
  alternate_source_id?: number;
  children?: EgpOverride[];
}

interface EgpState {
  template_name: string | null;
  controllers: Array<{ index: number; name: string | null }>;
  overrides?: EgpOverride[];
  overrides_truncated?: boolean;
}

/** Every override, groups included, depth first. */
export function flattenOverrides(list: EgpOverride[] | undefined): EgpOverride[] {
  const out: EgpOverride[] = [];
  for (const o of list ?? []) {
    out.push(o);
    if (o.children) out.push(...flattenOverrides(o.children));
  }
  return out;
}

/** The host's lookup order: a direct child of that level first, then each group in turn. Groups are never the answer. */
export function findOverrideLike(list: EgpOverride[] | undefined, name: string): EgpOverride | undefined {
  const direct = (list ?? []).find((x) => x.name === name && x.kind !== "group");
  if (direct) return direct;
  for (const g of list ?? []) {
    if (g.kind !== "group" || !g.children) continue;
    const hit = findOverrideLike(g.children, name);
    if (hit) return hit;
  }
  return undefined;
}

/** A checkbox reads back as 0 or 1, so a boolean is compared as the number AE reports. */
const asAe = (v: unknown): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v);

export function egpMismatches(args: z.infer<typeof AeSetEssentialGraphicsSchema>, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as EgpState | null;
  const after = afterRaw as EgpState | null;
  if (!before || !after) return m;
  if (args.action === "add") {
    const want = before.controllers.length + 1;
    expectThat(m, after.controllers.length === want, "controllers.length", want, after.controllers.length, "The template did not gain a controller");
    if (args.name) expectThat(m, after.controllers.some((c) => c.name === args.name), "controllers.name", args.name, after.controllers.map((c) => c.name), "No controller with that name");
  } else if (args.action === "rename") {
    const c = after.controllers.find((x) => x.index === args.index);
    expectThat(m, c?.name === args.name, `controllers[${args.index}].name`, args.name, c?.name, "Controller name differs");
  } else if (args.action === "template_name") {
    expectThat(m, after.template_name === args.name, "template_name", args.name, after.template_name, "Template name differs");
  } else if (args.action === "set_media") {
    const o = findOverrideLike(after.overrides, args.name ?? "");
    if (!o) m.push({ path: `overrides.${args.name}`, expected: args.item_id, actual: undefined, message: "Essential Property not in the read-back" });
    else expectThat(m, o.alternate_source_id === args.item_id, `overrides.${args.name}.alternate_source_id`, args.item_id, o.alternate_source_id, "The slot's media is not the item that was set");
  } else {
    const o = findOverrideLike(after.overrides, args.name ?? "");
    const actual = typeof args.value === "string" && o?.value && typeof o.value === "object" ? (o.value as { text?: string }).text : o?.value;
    if (!o) m.push({ path: `overrides.${args.name}`, expected: args.value, actual: undefined, message: "Essential Property not in the read-back" });
    else compareValues(asAe(args.value), asAe(Array.isArray(args.value) && Array.isArray(actual) ? actual.slice(0, args.value.length) : actual), `overrides.${args.name}`, m);
  }
  return m;
}

// ---------- render templates ----------

export const AeRenderTemplatesSchema = z
  .object({
    action: z
      .enum(["list", "save"])
      .optional()
      .describe("list (default): the template names. save: store a queue item's render settings or one of its output modules as a named template (needs kind, item_index, item_comp_id, name and expect)."),
    allow_temp: z
      .boolean()
      .optional()
      .describe("list: with an empty render queue, add a temporary item to read the names from and remove it again. That marks the project changed (save before aerender). Needs expect."),
    comp_id: z.number().int().optional().describe("list: the comp for the temporary item. Default the first comp."),
    kind: z.enum(["render_settings", "output_module"]).optional().describe("save: what to store."),
    item_index: z.number().int().positive().optional().describe("save: the render-queue item's 1-based index."),
    item_comp_id: z.number().int().optional().describe("save: the comp that item renders. The call refuses when the queue moved and that index renders another comp."),
    om_index: z.number().int().positive().optional().describe("save, output_module: the output module's 1-based index on that item."),
    name: z.string().min(1).max(255).optional().describe("save: the template's name. Not empty or blank."),
    allow_replace: z.boolean().optional().describe("save: let a template of that name (case-insensitive) be overwritten. Default false: the call refuses."),
    expect: ExpectSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action !== "save") return;
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    need(v.kind !== undefined, "save needs kind.");
    need(v.item_index !== undefined && v.item_comp_id !== undefined, "save needs item_index and item_comp_id.");
    need(v.name !== undefined && v.name.trim() !== "", "save needs a name that is not blank.");
    need(v.kind !== "output_module" || v.om_index !== undefined, "save with kind output_module needs om_index.");
    need(v.expect !== undefined, "save needs expect.");
  });

interface QueueTemplates {
  item: { index: number; comp_id: number; comp_name: string | null; status: string | null };
  kind: string;
  om_index?: number;
  templates: string[];
  count: number;
  truncated: boolean;
  name?: string;
  exists?: boolean;
}

/** The read-back for a save: the name is now in the list, and was not before (unless it was replaced). */
export function saveTemplateMismatches(args: z.infer<typeof AeRenderTemplatesSchema>, before: QueueTemplates | null, after: QueueTemplates | null, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after || !args.name) return m;
  const want = args.name.toLowerCase();
  const has = (t: QueueTemplates | null) => (t?.templates ?? []).some((x) => x.toLowerCase() === want);
  // A list capped at 500 names may hide the new one: say nothing rather than flag a correct save.
  if (after.truncated && !has(after)) return m;
  expectThat(m, has(after), "templates", `contains "${args.name}"`, `${after.count} templates, none named that`, `The template "${args.name}" is not in the list after saving`);
  if (has(after) && before && !has(before) && written.replaced === true) {
    m.push({ path: "templates", expected: "new name", actual: "replaced", message: "The host reported a replaced template that was not in the list before" });
  }
  return m;
}

export const SAVE_TEMPLATE_NOTE =
  "Templates are machine-wide preferences: they outlive the project, apply to every project on this machine, and cannot be deleted or renamed by script. " +
  "They may not reach aerender (ae_render_batch) until After Effects writes its preferences (unmeasured): check with a test render before relying on one.";

// ---------- versions ----------

export const AeVersionFootageSchema = z
  .object({
    item_ids: z.array(z.number().int()).max(500).optional().describe("Footage items to check or update. Default: every footage item with a file."),
    version: z.number().int().min(0).optional().describe("Swap to this version instead of the latest (one item only)."),
    update: z.boolean().optional().describe("Swap the items to the newer version. Default false: only report. Needs expect."),
    dry_run: z.boolean().optional().describe("With update: show what would change without touching AE."),
    expect: ExpectSchema.optional(),
  })
  .refine((v) => !v.update || v.expect !== undefined, { message: "update needs expect." })
  .refine((v) => v.version === undefined || v.item_ids?.length === 1, { message: "version needs exactly one item." });

interface FootageFile {
  item_id: number;
  name: string;
  file: string;
  missing: boolean;
  sequence: boolean;
  used_in: number;
}

interface FootageFiles {
  project_path: string;
  items: FootageFile[];
  truncated?: boolean;
}

/** For a sequence AE may report another frame, so compare the folder and the version. */
export function sameFootage(a: string, b: string, sequence: boolean): boolean {
  const norm = (p: string) => normalizeGuardPath(p);
  if (!sequence) return norm(a) === norm(b);
  const dir = (p: string) => norm(p).replace(/[\\/][^\\/]*$/, "");
  const ver = (p: string) => versionToken(p.split(/[\\/]/).pop() ?? "")?.number ?? null;
  return dir(a) === dir(b) && ver(a) === ver(b);
}

// ---------- batch ----------

export const BatchOpSchema = z
  .object({
    layer: LayerSelectorSchema,
    path: PathSchema,
    value: z
      .unknown()
      .optional()
      .describe(
        "A static value (or the value at the comp's current time on an animated property). A path (Mask Path, Path, any Shape property) takes {vertices: [[x,y]...], inTangents?: [[x,y]...], outTangents?, closed?}; " +
          "numbers are checked against the property's own min and max before anything is written. A marker is a key: give it as keyframes [{ time, value: { comment, duration?, label?, ... } }]."
      ),
    keyframes: z.array(KeyframeItemSchema).max(100).optional(),
    expression: z.string().max(20000).optional(),
    expression_enabled: z.boolean().optional().describe("Switch the expression on or off. Setting `expression` already switches it on. The read-back evaluates the expression once and a broken one is a mismatch (expression_error)."),
  })
  .refine((o) => o.value !== null, { message: "value can't be null." })
  .refine((o) => o.value !== undefined || (o.keyframes?.length ?? 0) > 0 || o.expression !== undefined || o.expression_enabled !== undefined, { message: "Each op sets a value, keyframes or an expression." })
  .refine((o) => (o.keyframes ?? []).every((k) => k.value !== undefined && k.value !== null), { message: "Each keyframe needs a value." });

export const AeBatchSetSchema = z.object({
  comp_id: z.number().int(),
  ops: z.array(BatchOpSchema).min(1).max(5000),
  chunk_size: z.number().int().min(1).max(500).optional().describe("Ops per undo group (default and maximum 500)."),
  allow_substitute: z.boolean().optional().describe("Write a Source Text font name that is not installed as it is (After Effects then substitutes). Default false: such a font refuses the whole batch."),
  expect: ExpectSchema,
});

type BatchOp = z.infer<typeof BatchOpSchema>;

interface BatchRead {
  time: number;
  results: Array<{
    op: number;
    numKeys?: number;
    value?: unknown;
    keys?: Array<{ time: number; value: unknown; missing?: boolean }>;
    expression?: string;
    expression_enabled?: boolean;
    expression_error?: string;
    error?: string;
  }>;
}

// Only the properties an op wrote an expression (or switched one on or off) on are evaluated in the read-back.
const readOps = (ops: BatchOp[]) =>
  ops.map((o) => ({
    layer: o.layer,
    path: o.path,
    ...(o.keyframes?.length ? { times: o.keyframes.map((k) => k.time) } : {}),
    ...(o.expression !== undefined || o.expression_enabled !== undefined ? { check_expression: true } : {}),
  }));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isShapeSpec = (v: unknown): v is { vertices: number[][]; inTangents?: number[][]; outTangents?: number[][]; closed?: boolean } => isObject(v) && Array.isArray(v.vertices);
type MarkerSpec = { comment?: string; duration?: number; label?: number; chapter?: string; url?: string; cuePointName?: string };
const MARKER_FIELDS = ["comment", "duration", "label", "chapter", "url", "cuePointName", "frameTarget", "protectedRegion"];
const isMarkerSpec = (v: unknown): v is MarkerSpec => isObject(v) && !Array.isArray(v.vertices) && MARKER_FIELDS.some((f) => f in v);

const closeEnough = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-5 * Math.abs(a);

/** A path written as {vertices, ...} against the Shape the read-back serialised. Tangents are compared only when given. */
export function shapeValueMismatches(want: { vertices: number[][]; inTangents?: number[][]; outTangents?: number[][]; closed?: boolean }, got: unknown, path: string): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!isObject(got) || !Array.isArray(got.vertices)) {
    m.push({ path, expected: "a path", actual: got, message: "The path could not be read back as a shape" });
    return m;
  }
  const gotVerts = got.vertices as number[][];
  const total = typeof got.num_vertices === "number" ? got.num_vertices : gotVerts.length;
  if (total !== want.vertices.length) {
    m.push({ path: `${path}.vertices.length`, expected: want.vertices.length, actual: total, message: "The path has a different number of vertices" });
    return m;
  }
  const lists: Array<["vertices" | "inTangents" | "outTangents", number[][] | undefined]> = [["vertices", want.vertices], ["inTangents", want.inTangents], ["outTangents", want.outTangents]];
  for (const [key, wantList] of lists) {
    if (!wantList) continue;
    const gotList = got[key] as number[][] | undefined;
    if (!Array.isArray(gotList)) continue;
    // A read-back capped at 500 vertices compares the vertices it has.
    for (let i = 0; i < wantList.length && i < gotList.length; i++) {
      if (!closeEnough(wantList[i][0], gotList[i][0]) || !closeEnough(wantList[i][1], gotList[i][1])) {
        m.push({ path: `${path}.${key}[${i}]`, expected: wantList[i], actual: gotList[i], message: `Path ${key} point ${i} differs` });
        break;
      }
    }
  }
  if (want.closed !== undefined && typeof got.closed === "boolean") {
    expectThat(m, got.closed === want.closed, `${path}.closed`, want.closed, got.closed, "The path's closed flag differs");
  }
  return m;
}

/** A marker written as {comment, duration, ...} against the MarkerValue the read-back serialised. */
export function markerValueMismatches(want: MarkerSpec, got: unknown, path: string): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!isObject(got)) {
    m.push({ path, expected: "a marker", actual: got, message: "The marker could not be read back" });
    return m;
  }
  if (want.comment !== undefined) expectThat(m, got.comment === want.comment, `${path}.comment`, want.comment, got.comment, "Marker comment differs");
  if (typeof want.duration === "number") expectThat(m, typeof got.duration === "number" && Math.abs(got.duration - want.duration) < 0.001, `${path}.duration`, want.duration, got.duration, "Marker duration differs");
  if (typeof want.label === "number" && typeof got.label === "number") expectThat(m, got.label === want.label, `${path}.label`, want.label, got.label, "Marker label differs");
  for (const f of ["chapter", "url", "cuePointName"] as const) {
    if (typeof want[f] === "string") expectThat(m, got[f] === want[f], `${path}.${f}`, want[f], got[f], `Marker ${f} differs`);
  }
  return m;
}

function trimTo(want: unknown, got: unknown): unknown {
  if (Array.isArray(want) && Array.isArray(got)) return got.slice(0, want.length);
  if (typeof want === "string" && got && typeof got === "object" && "text" in (got as object)) return (got as { text: string }).text;
  return got;
}

/**
 * The read-back of a text document carries only its text (production.jsx plain()), so a { text, font } write is
 * compared on the keys the read-back has. The font is checked only before the write (installed, or allow_substitute);
 * it and every other style key (fontSize, fillColor, ...) are never read back or compared.
 */
function wantedKeys(want: unknown, got: unknown): unknown {
  if (isObject(want) && isObject(got) && Object.keys(got).length === 1 && "text" in got) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(got)) if (key in want) out[key] = want[key];
    return out;
  }
  return want;
}

export function batchMismatches(ops: BatchOp[], afterRaw: unknown, offset: number): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as BatchRead | null;
  if (!after) return m;
  // Two ops on one property in the same chunk: the read-back only shows the last write.
  const propKey = (o: BatchOp) => JSON.stringify([o.layer, o.path]);
  // Selectors are compared literally: {index:1} and {name:'A'} count as different properties.
  const lastExpr = new Map<string, number>();
  const lastValue = new Map<string, number>();
  const lastExprState = new Map<string, number>();
  ops.forEach((o, i) => {
    const k = propKey(o);
    if (o.expression !== undefined || o.expression_enabled !== undefined) lastExprState.set(k, i);
    if (o.expression !== undefined) lastExpr.set(k, i);
    if (o.expression !== undefined || o.value != null || (o.keyframes?.length ?? 0) > 0) lastValue.set(k, i);
  });
  ops.forEach((op, i) => {
    const r = after.results[i];
    const label = `ops[${offset + i + 1}]`;
    if (!r || r.error) {
      m.push({ path: label, expected: "read-back", actual: r?.error, message: `Op ${offset + i + 1} could not be read back` });
      return;
    }
    const finalExpr = lastExpr.get(propKey(op)) === i;
    const final = lastValue.get(propKey(op)) === i;
    if (finalExpr && op.expression !== undefined) expectThat(m, r.expression === op.expression, `${label}.expression`, op.expression, r.expression, "Expression differs");
    if (lastExprState.get(propKey(op)) === i) {
      // An expression that errors makes AE switch it off: the error says why, so the enabled flag is not flagged on top of it.
      // Switching an expression off is how a broken one is silenced: its leftover error is not a mismatch then.
      const meantOn = op.expression_enabled === true || (op.expression !== undefined && op.expression_enabled !== false);
      if (r.expression_error && meantOn) {
        m.push({ path: `${label}.expression_error`, expected: "no error", actual: r.expression_error, message: `Op ${offset + i + 1}'s expression is broken: ${r.expression_error}` });
      } else if (op.expression_enabled !== undefined && r.expression_enabled !== undefined) {
        expectThat(m, r.expression_enabled === op.expression_enabled, `${label}.expression_enabled`, op.expression_enabled, r.expression_enabled, "Expression on/off differs");
      }
    }
    if (final && op.value != null && !op.keyframes?.length && (r.numKeys ?? 0) === 0 && op.expression === undefined) {
      if (isShapeSpec(op.value)) m.push(...shapeValueMismatches(op.value, r.value, `${label}.value`));
      else compareValues(asAe(wantedKeys(op.value, r.value)), asAe(trimTo(op.value, r.value)), `${label}.value`, m);
    }
    for (const k of op.keyframes ?? []) {
      const got = r.keys?.find((x) => Math.abs(x.time - k.time) < 0.0005);
      if (!got || got.missing) m.push({ path: `${label}.keys@${k.time}`, expected: k.value, actual: undefined, message: `No key at ${k.time}s` });
      else if (isShapeSpec(k.value)) m.push(...shapeValueMismatches(k.value, got.value, `${label}.keys@${k.time}`));
      else if (isMarkerSpec(k.value)) m.push(...markerValueMismatches(k.value, got.value, `${label}.keys@${k.time}`));
      else if (typeof k.value === "string" && isObject(got.value) && "comment" in got.value) m.push(...markerValueMismatches({ comment: k.value }, got.value, `${label}.keys@${k.time}`));
      else compareValues(asAe(wantedKeys(k.value, got.value)), asAe(trimTo(k.value, got.value)), `${label}.keys@${k.time}`, m);
    }
  });
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tools ----------

export const productionTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_essential_graphics",
    description:
      "Read a comp's Essential Graphics template: its name and controllers (index and name). With a precomp layer, also that layer's overrides (Essential Properties) and their values, groups included (as children), " +
      "each with where it comes from (source: the property or layer it drives, Property.essentialPropertySource, AE 22+, described never raw) and, for a media-replacement slot, can_set_alternate_source and alternate_source_id. Read-only.",
    schema: AeGetEssentialGraphicsSchema,
    handler: async (args: z.infer<typeof AeGetEssentialGraphicsSchema>, ctx) =>
      (await ctx.bridge.callHost("egpRead", { comp_id: args.comp_id, layer: args.layer }, { label: "ae_get_essential_graphics", mutates: false, toolName: "ae_get_essential_graphics" })).result,
  },
  {
    name: "ae_set_essential_graphics",
    description:
      "Change Essential Graphics in one undo group guarded by `expect`: add a layer property (or, without a path, the layer's media slot) to the comp's template (optionally named), rename a controller, name the template, " +
      "set an override (Essential Property) on a precomp layer of a templated comp: text as a string, numbers, colours or points as arrays, " +
      "or set_media: put another footage item or comp behind a media-replacement override (versioning, localisation), after a compatibility check. " +
      "The read-back (a separate evalScript) checks the controller count and names, the template name, the override's value or its media. Export the template with ae_export_mogrt. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetEssentialGraphicsSchema,
    handler: (args: z.infer<typeof AeSetEssentialGraphicsSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_set_essential_graphics",
        label: `ae_set_essential_graphics(${args.action})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "egpRead", args: { comp_id: args.comp_id, layer: args.action === "set_override" || args.action === "set_media" ? args.layer : undefined } }),
        write: {
          host: "egpEdit",
          args: { comp_id: args.comp_id, action: args.action, layer: args.layer, path: args.path, index: args.index, name: args.name, value: args.value, item_id: args.item_id, label: "Essential Graphics" },
        },
        check: (before, after) => egpMismatches(args, before, after),
        present: (_before, after) => ({ essential_graphics: after }),
      }),
  },
  {
    name: "ae_render_templates",
    description:
      "List the render-settings and output-module template names this AE has (built-in and the user's), read from a render-queue item: an existing one changes nothing; " +
      "with an empty queue, allow_temp adds a temporary item and removes it (the project is then marked changed: save before aerender). " +
      `Says whether '${DEFAULT_AUDIO_TEMPLATE}', the audio template ae_audio_analyze uses by default, is there. ` +
      "With action save it stores a render-queue item's render settings or one of its output modules as a named template (RenderQueueItem / OutputModule.saveAsTemplate) guarded by `expect`; it is NOT undoable (a machine-wide preference, not a project change: Edit > Undo (Ctrl+Z) does not remove it and neither does ae_checkpoint_revert): " +
      "the item is checked by index and comp id, a blank name is refused, a name that already exists is refused unless allow_replace, and the read-back (a separate evalScript) checks the name is in the list. " +
      "Templates are machine-wide preferences, outlive the project and cannot be deleted or renamed by script; they may not reach aerender until After Effects flushes its preferences (unmeasured). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRenderTemplatesSchema,
    handler: async (args: z.infer<typeof AeRenderTemplatesSchema>, ctx: ToolContext) => {
      if (args.action === "save") {
        if (!args.expect) return { ok: false, error: "bad_args", message: "save needs expect." };
        if (!args.kind || args.item_index === undefined || args.item_comp_id === undefined) {
          return { ok: false, error: "bad_args", message: "save needs kind, item_index and item_comp_id." };
        }
        if (typeof args.name !== "string" || args.name.trim() === "") return { ok: false, error: "bad_args", message: "save needs a name that is not blank." };
        if (args.kind === "output_module" && args.om_index === undefined) return { ok: false, error: "bad_args", message: "save with kind output_module needs om_index." };
        const target = { kind: args.kind, item_index: args.item_index, item_comp_id: args.item_comp_id, om_index: args.om_index };
        return runGuardedWrite(ctx, {
          toolName: "ae_render_templates",
          label: `ae_render_templates(save ${args.kind} "${args.name}")`,
          expect: args.expect,
          undoable: false,
          read: () => ({ host: "exploreRqTemplates", args: { ...target, name: args.name } }),
          write: { host: "exploreSaveTemplate", args: { ...target, name: args.name, allow_replace: args.allow_replace } },
          check: (before, after, w) => saveTemplateMismatches(args, before as QueueTemplates | null, after as QueueTemplates | null, w),
          present: (_before, after, w) => ({ saved: w.saved, kind: args.kind, replaced: w.replaced === true, templates: (after as QueueTemplates | null)?.templates, note: SAVE_TEMPLATE_NOTE }),
        });
      }
      type Templates = { source: string; render_settings: string[]; output_modules: string[]; needs_item?: boolean };
      // Look first: an existing item answers with no guard, no checkpoint and no change.
      let res = (await ctx.bridge.callHost<Templates>("renderTemplates", {}, { label: "ae_render_templates", mutates: false, toolName: "ae_render_templates" })).result;
      if (res.needs_item) {
        if (!args.allow_temp) {
          return { ok: false, error: "empty_queue", message: "The render queue is empty. Add an item (ae_render_queue_add), or call again with allow_temp and expect." };
        }
        if (!args.expect) return { ok: false, error: "bad_args", message: "allow_temp needs expect." };
        const out = await runGuardedWrite(ctx, {
          toolName: "ae_render_templates",
          label: "ae_render_templates (temporary item)",
          expect: args.expect,
          read: () => ({ host: "rqStatus", args: {} }),
          write: { host: "renderTemplates", args: { allow_temp: true, comp_id: args.comp_id, label: "Read render templates" } },
          check: (before, after) => {
            const n = (s: unknown) => (s as { numItems?: number } | null)?.numItems;
            return n(before) === n(after) ? [] : [{ path: "renderQueue.numItems", expected: n(before), actual: n(after), message: "The temporary render-queue item was not removed" }];
          },
        });
        res = out as unknown as Templates;
      }
      return { ...res, audio_template_found: res.output_modules.includes(DEFAULT_AUDIO_TEMPLATE) };
    },
  },
  {
    name: "ae_version_footage",
    description:
      "Shot versioning. Reports which footage items have a newer version on disk (the last v<number> in the file name, or in the folder name for sequences in versioned folders), " +
      "and with update swaps them to the latest (or a given version) in one undo group guarded by `expect`, keeping the item, so every comp using it follows. " +
      "Image sequences are swapped as sequences. Each swap is logged in <project>.versions.json next to the .aep. dry_run shows the plan without touching AE. " +
      "The read-back (a separate evalScript) checks each item now points at the new file. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeVersionFootageSchema,
    handler: async (args: z.infer<typeof AeVersionFootageSchema>, ctx: ToolContext) => {
      const files = (
        await ctx.bridge.callHost<FootageFiles>("footageFiles", { item_ids: args.item_ids }, { label: "ae_version_footage (files)", mutates: false, toolName: "ae_version_footage" })
      ).result;
      const found = new Set(files.items.map((f) => f.item_id));
      const missingIds = (args.item_ids ?? []).filter((id) => !found.has(id));
      if (args.item_ids?.length && missingIds.length === args.item_ids.length) {
        return { ok: false, error: "not_found", message: `No footage item with a file has id ${missingIds.join(", ")}`, missing_ids: missingIds };
      }
      const extra = {
        ...(files.truncated ? { truncated: true, truncated_note: "More than 500 footage items have a file; only the first 500 were checked. Pass item_ids for the rest." } : {}),
        ...(missingIds.length ? { missing_ids: missingIds } : {}),
      };
      const report = files.items.map((f) => {
        const plan = planVersion(f.file, f.sequence, args.version);
        return {
          item_id: f.item_id,
          name: f.name,
          sequence: f.sequence,
          file: f.file,
          current: plan.current,
          latest: plan.latest,
          newer: plan.newer,
          ...(plan.target ? { target: plan.target.path, target_version: plan.target.version } : {}),
        };
      });
      const outdated = report.filter((r) => r.newer);
      if (args.version !== undefined && report[0] && report[0].target === undefined) {
        return { ok: false, error: "no_such_version", message: `No v${args.version} found next to ${report[0].file}`, items: report };
      }
      if (!args.update || args.dry_run || outdated.length === 0) {
        return { ok: true, ...(args.dry_run ? { dry_run: true } : {}), checked: report.length, outdated: outdated.length, ...extra, items: args.update ? outdated : report };
      }
      const jobs = outdated.map((r) => ({ item_id: r.item_id, path: r.target as string, sequence: r.sequence }));
      const ids = jobs.map((j) => j.item_id);
      const out = (await runGuardedWrite(ctx, {
        toolName: "ae_version_footage",
        label: `ae_version_footage(${jobs.length})`,
        expect: args.expect!,
        read: () => ({ host: "footageFiles", args: { item_ids: ids } }),
        write: { host: "versionFootage", args: { items: jobs, label: `Version up ${jobs.length} footage item${jobs.length === 1 ? "" : "s"}` } },
        check: (_before, after) => {
          const m: ReceiptMismatch[] = [];
          const now = (after as FootageFiles | null)?.items ?? [];
          for (const j of jobs) {
            const got = now.find((x) => x.item_id === j.item_id);
            if (!got || !sameFootage(got.file, j.path, j.sequence)) {
              m.push({ path: `items[${j.item_id}].file`, expected: j.path, actual: got?.file, message: `Item ${j.item_id} does not point at the new version` });
            }
          }
          return m;
        },
        present: (_before, _after, w) => ({ replaced: w.replaced }),
      })) as Record<string, unknown>;
      let logPath: string | undefined;
      const logNotes: { aside?: string } = {};
      let logError: string | undefined;
      if (files.project_path !== "<unsaved>") {
        const entries: VersionLogEntry[] = outdated.map((r) => ({
          at: new Date().toISOString(),
          item_id: r.item_id,
          name: r.name,
          from: r.file,
          to: r.target as string,
          from_version: r.current,
          to_version: r.target_version as number,
        }));
        try {
          logPath = appendVersionLog(files.project_path, entries, logNotes);
        } catch (e) {
          logPath = undefined;
          logError = (e as Error).message;
        }
      }
      return { ...out, ...extra, items: outdated, ...(logPath ? { log_path: logPath } : { log_path: null }),
        ...(logNotes.aside ? { log_aside: logNotes.aside, log_note: "The existing versions log could not be read as JSON; it was kept as log_aside and a new log was started." } : {}),
        ...(logError ? { log_error: logError } : {}),
      };
    },
  },
  {
    name: "ae_batch_set",
    description:
      "Set many properties at once (values, keyframes or expressions on any layers of one comp, including paths as {vertices, inTangents, outTangents, closed} and markers as keyframed {comment, duration, ...}): every layer, property, number range and path in every chunk is checked by a read-only pass before anything is written, " +
      "a Source Text font that is not installed refuses the batch unless allow_substitute is true; then each chunk of up to 500 ops is one undo group guarded by `expect`, with a short pause between chunks so AE's UI keeps up. " +
      "The read-back (a separate evalScript per chunk) checks every value, key and expression, except that for a Source Text value only the text is compared (the font and other style keys are not read back, so they are not checked), and evaluates the expressions it wrote once: a broken one is reported as expression_error in the receipt, not as applied. A failing op stops the batch and says which. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeBatchSetSchema,
    handler: async (args: z.infer<typeof AeBatchSetSchema>, ctx: ToolContext) => {
      const size = args.chunk_size ?? 500;
      const chunks: Array<Record<string, unknown>> = [];
      let done = 0;
      const mismatches: ReceiptMismatch[] = [];
      // A read-only pass over every chunk first, so a bad layer or path in op 1200 stops the batch before op 1 is written.
      for (let start = 0; start < args.ops.length; start += size) {
        const ops = args.ops.slice(start, start + size);
        const check = (
          await ctx.bridge.callHost<{ ok: boolean; error?: string }>(
            "batchValidate",
            { comp_id: args.comp_id, ops, base: start, allow_substitute: args.allow_substitute },
            { label: `ae_batch_set (check ${start + 1}-${start + ops.length} of ${args.ops.length})`, mutates: false, toolName: "ae_batch_set" }
          )
        ).result;
        if (check && check.ok === false) {
          return { ok: false, error: "bad_args", applied: false, done: 0, message: `${check.error ?? "An op is invalid"}. Nothing was written.` };
        }
      }
      for (let start = 0; start < args.ops.length; start += size) {
        const ops = args.ops.slice(start, start + size);
        if (start > 0) await sleep(250);
        const res = (await runGuardedWrite(ctx, {
          toolName: "ae_batch_set",
          label: `ae_batch_set(${start + 1}-${start + ops.length} of ${args.ops.length})`,
          expect: args.expect,
          compId: args.comp_id,
          read: () => ({ host: "batchRead", args: { comp_id: args.comp_id, ops: readOps(ops) } }),
          write: { host: "batchSet", args: { comp_id: args.comp_id, ops, base: start, allow_substitute: args.allow_substitute, label: `Batch set ${start + 1}-${start + ops.length}` } },
          check: (_before, after, w) => (w.failed_at ? [] : batchMismatches(ops, after, start)),
        })) as unknown as { done?: number; failed_at?: number; error?: string; receipt: { matches: boolean; mismatches: ReceiptMismatch[] }; checkpoint: unknown };
        // runGuardedWrite spreads the write's own result at the top level, also when the read-back failed.
        const chunkDone = typeof res.done === "number" ? res.done : 0;
        done += chunkDone;
        mismatches.push(...res.receipt.mismatches);
        chunks.push({ ops: `${start + 1}-${start + ops.length}`, done: chunkDone, matches: res.receipt.matches, checkpoint: res.checkpoint });
        if (res.failed_at) {
          return {
            ok: false,
            error: "op_failed",
            failed_op: start + res.failed_at,
            message: `Op ${start + res.failed_at} failed: ${res.error}. Ops before it in this chunk were applied (one undo step); later chunks were not run.`,
            done,
            chunks,
          };
        }
        if (res.receipt.mismatches.some((m) => m.path === "read_back")) {
          // Often a popup blocking AE: don't pile more writes on top.
          return {
            ok: false,
            error: "read_back_failed",
            applied: true,
            done,
            chunks,
            mismatches: res.receipt.mismatches.filter((m) => m.path === "read_back"),
            message: `Ops ${start + 1}-${start + ops.length} were applied but their read-back failed; later chunks were not run. Do not resend; inspect the state with a read tool.`,
          };
        }
      }
      return { ok: true, applied: true, done, chunks, matches: mismatches.length === 0, mismatches: mismatches.slice(0, 50), mismatches_truncated: mismatches.length > 50 };
    },
  },
];
