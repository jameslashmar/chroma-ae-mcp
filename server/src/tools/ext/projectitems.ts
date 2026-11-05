/**
 * server/src/tools/ext/projectitems.ts
 *
 * Project panel tools, guarded writes with a read-back of the items in a
 * separate evalScript:
 * - ae_create_comp: a new comp from settings, a comp from a footage item (New
 *   Comp from Footage), or a copy of a comp, optionally deep (every nested
 *   precomp copied once and the copies relinked to each other)
 * - ae_project_items: folders, move, rename (with comp("Name") and
 *   footage("Name") expression repair), label, comment, delete (refusing used
 *   items), organize by kind and remove empty folders; a dry run by default
 *
 * The host plans on a copy of the project tree and replays that plan, so the
 * dry run and the write agree. Both tools plan first (a read), refuse before
 * any undo group opens, and take the automatic checkpoint through
 * runGuardedWrite.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read-back shape ----------

export interface ItemSummary {
  id: number;
  kind?: "folder" | "comp" | "footage" | "other";
  missing?: boolean;
  is_root?: boolean;
  name?: string;
  parent_id?: number | null;
  label?: number | null;
  comment?: string | null;
  width?: number;
  height?: number;
  pixel_aspect?: number;
  fps?: number;
  duration?: number;
  bg_color?: number[];
  num_layers?: number;
  num_items?: number;
  subkind?: string;
  used_in_count?: number;
}

export interface ItemsRead {
  root_id?: number;
  num_items?: number;
  items: ItemSummary[];
  count: number;
  truncated: boolean;
  expressions?: ScanExpression[];
  expressions_truncated?: boolean;
  comps_scanned?: number;
  item_names?: { comp: string[]; footage: string[]; truncated: boolean };
}

export interface ScanExpression {
  comp_id: number;
  comp_name: string;
  layer_id: number;
  layer_index: number;
  layer_name: string;
  path: string;
  text: string;
  enabled: boolean;
  text_truncated?: boolean;
}

const itemsOf = (v: unknown): ItemsRead | null => (v && typeof v === "object" && Array.isArray((v as ItemsRead).items) ? (v as ItemsRead) : null);
const findItem = (read: ItemsRead | null, id: unknown) => read?.items.find((i) => i.id === id);

// ---------- pure helpers ----------

const MAX_WARNINGS = 100;

/** "#rrggbb", "#rgb" or [r, g, b] in 0..1, as [r, g, b] in 0..1. Null when it isn't a colour. */
export function parseBgColor(v: unknown): [number, number, number] | null {
  if (typeof v === "string") {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
    const short = /^#?([0-9a-fA-F]{3})$/.exec(v.trim());
    let hex: string | null = null;
    if (m) hex = m[1]!;
    else if (short) hex = short[1]!.split("").map((c) => c + c).join("");
    if (hex === null) return null;
    const n = (i: number) => Math.round((parseInt(hex!.slice(i, i + 2), 16) / 255) * 1e6) / 1e6;
    return [n(0), n(2), n(4)];
  }
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1)) {
    return [v[0] as number, v[1] as number, v[2] as number];
  }
  return null;
}

/** An expression with comments blanked and strings kept; same length. */
function blankComments(text: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote) {
      if (c === "\\" && i + 1 < text.length) {
        out += c + next!;
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" || text[i] === "\r" ? text[i]! : " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface ItemReference {
  kind: "comp" | "footage";
  name: string;
}

/** comp("Name") and footage("Name") (also thisProject.comp / footage) in an expression: the item names it reads. */
export function findItemReferences(expression: string): ItemReference[] {
  const code = blankComments(expression);
  const out: ItemReference[] = [];
  const re = /\b(comp|footage)\s*\(\s*(["'])((?:\\.|(?!\2)[^\\])*)\2\s*\)/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    out.push({ kind: m[1] as "comp" | "footage", name: m[3]!.replace(/\\(["'\\])/g, "$1") });
  }
  return out;
}

export interface ReferenceWarning {
  comp_id: number;
  comp_name: string;
  layer_id: number;
  layer_name: string;
  path: string;
  kind: "copied_comp_reference" | "renamed_item_reference" | "partial_scan";
  reference: string;
  message: string;
}

const warnPartial = (ex: ScanExpression): ReferenceWarning => ({
  comp_id: ex.comp_id,
  comp_name: ex.comp_name,
  layer_id: ex.layer_id,
  layer_name: ex.layer_name,
  path: ex.path,
  kind: "partial_scan",
  reference: "",
  message: "This expression is longer than the scan limit, so references in its tail were not checked.",
});

/**
 * comp("Name") references in the copied comps that still name an original comp:
 * the copy reads the original, not its sibling copy.
 */
export function copiedCompWarnings(expressions: ScanExpression[], originalNames: string[]): ReferenceWarning[] {
  const names = new Set(originalNames);
  const out: ReferenceWarning[] = [];
  for (const ex of expressions) {
    if (!ex.enabled) continue;
    if (ex.text_truncated && out.length < MAX_WARNINGS) out.push(warnPartial(ex));
    for (const ref of findItemReferences(ex.text)) {
      if (ref.kind !== "comp" || !names.has(ref.name)) continue;
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        comp_id: ex.comp_id,
        comp_name: ex.comp_name,
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "copied_comp_reference",
        reference: `comp("${ref.name}")`,
        message: `comp("${ref.name}") still points at the original comp, not its copy. Repoint it with ae_batch_set or ae_set_property if the copy should read the copy.`,
      });
    }
  }
  return out;
}

export interface RenamePair {
  id?: number;
  kind: "comp" | "footage";
  from: string;
  to: string;
}

/** Expressions that read a renamed item by its old name. */
export function referencesToRenamed(expressions: ScanExpression[], renames: RenamePair[]): Array<{ ex: ScanExpression; ref: ItemReference }> {
  const out: Array<{ ex: ScanExpression; ref: ItemReference }> = [];
  for (const ex of expressions) {
    for (const ref of findItemReferences(ex.text)) {
      if (renames.some((r) => r.kind === ref.kind && r.from === ref.name)) out.push({ ex, ref });
    }
  }
  return out;
}

/**
 * References to an old name that no item of that kind carries any more (so the
 * expression errors): what autoFixExpressions left behind. Without the full
 * name list nothing is judged.
 */
export function renamedReferenceWarnings(
  expressions: ScanExpression[],
  renames: RenamePair[],
  names: ItemsRead["item_names"] | undefined
): ReferenceWarning[] {
  const out: ReferenceWarning[] = [];
  if (!names || names.truncated) return out;
  const current = { comp: new Set(names.comp), footage: new Set(names.footage) };
  const to = new Map(renames.map((r) => [`${r.kind}:${r.from}`, r.to]));
  for (const ex of expressions) {
    if (!ex.enabled) continue;
    if (ex.text_truncated && out.length < MAX_WARNINGS) out.push(warnPartial(ex));
    for (const ref of findItemReferences(ex.text)) {
      const renamedTo = to.get(`${ref.kind}:${ref.name}`);
      if (renamedTo === undefined || current[ref.kind].has(ref.name)) continue;
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        comp_id: ex.comp_id,
        comp_name: ex.comp_name,
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "renamed_item_reference",
        reference: `${ref.kind}("${ref.name}")`,
        message: `${ref.kind}("${ref.name}") refers to an item renamed to "${renamedTo}"; no ${ref.kind} item has the old name now, so the expression errors. Repair it with ae_batch_set or ae_set_property.`,
      });
    }
  }
  return out;
}

export interface ExpressionErrorEntry {
  layer?: { index?: number; id?: number; name?: string };
  path?: string[];
  error?: string;
}

interface ValidateResult {
  comp_id: number;
  comp_name?: string;
  error_count?: number;
  results?: Array<ExpressionErrorEntry & { expression?: string }>;
}

const errorKey = (e: ExpressionErrorEntry) => `${e.layer?.id}|${(e.path ?? []).join(">")}`;

/** Errors present after the write that were not there before it. */
export function newExpressionErrors(before: ValidateResult[], after: ValidateResult[]): Array<{ comp_id: number; comp_name?: string; errors: ExpressionErrorEntry[] }> {
  const had = new Set<string>();
  for (const b of before) {
    for (const r of b.results ?? []) if (r.error) had.add(`${b.comp_id}|${errorKey(r)}`);
  }
  const out: Array<{ comp_id: number; comp_name?: string; errors: ExpressionErrorEntry[] }> = [];
  for (const a of after) {
    const fresh = (a.results ?? [])
      .filter((r) => r.error && !had.has(`${a.comp_id}|${errorKey(r)}`))
      .map((r) => ({ layer: r.layer, path: r.path, error: r.error }));
    if (fresh.length > 0) out.push({ comp_id: a.comp_id, comp_name: a.comp_name, errors: fresh.slice(0, 20) });
  }
  return out;
}

// ---------- ae_create_comp: schema ----------

const COMP_MODES = ["new", "from_footage", "duplicate"] as const;

const ColorInput = z.union([z.string().min(4).max(7), z.array(z.number().min(0).max(1)).length(3)]);

export const AeCreateCompSchema = z
  .object({
    mode: z.enum(COMP_MODES).describe("new: make a comp from settings. from_footage: make a comp the size, pixel aspect, frame rate and length of a footage item, as New Comp from Footage does. duplicate: copy a comp."),
    name: z.string().min(1).max(255).optional().describe("Comp name. new: default 'Comp'. from_footage: default the footage name without its extension. duplicate: default AE's own copy name (or the source name plus name_suffix)."),
    width: z.number().int().min(4).max(30000).optional().describe("new: width in pixels (4-30000, required). from_footage: overrides the footage's width."),
    height: z.number().int().min(4).max(30000).optional().describe("new: height in pixels (4-30000, required). from_footage: overrides the footage's height."),
    pixel_aspect: z.number().min(0.01).max(100).optional().describe("Pixel aspect ratio, 0.01-100. Default 1 (new) or the footage's (from_footage)."),
    fps: z.number().min(1).max(99).optional().describe("Frame rate, 1-99 (new: required; from_footage: default the footage's, required for stills)."),
    duration: z.number().positive().max(10800).optional().describe("Length in SECONDS, above 0 and at most 10800 (3 hours). new: this or duration_frames is required. from_footage: default the footage's length; stills (length 0) need it."),
    duration_frames: z.number().int().positive().optional().describe("Length in FRAMES instead of seconds (converted with the frame rate). Not both."),
    bg_color: ColorInput.optional().describe("Background colour: [r, g, b] in 0..1 or '#rrggbb'. Default AE's (black)."),
    item_id: z.number().int().optional().describe("from_footage: the footage item to build the comp from."),
    add_layer: z.boolean().optional().describe("from_footage: add the footage as a layer of the new comp. Default true."),
    comp_id: z.number().int().optional().describe("duplicate: the comp to copy."),
    deep: z.boolean().optional().describe("duplicate: also copy every comp nested in it (once each, even when used twice) and point the copies' precomp layers at each other, as True Comp Duplicator does. Defaults to a DRY RUN: pass dry_run false to do it."),
    name_suffix: z.string().max(100).optional().describe("duplicate: added to the source name for the copy (deep: for every copy; default ' copy' there). Names are made unique in the project for deep copies."),
    max_comps: z.number().int().min(1).max(500).optional().describe("duplicate deep: refuse when the tree holds more comps than this. Default 50."),
    target_folder_id: z.number().int().optional().describe("Project folder for the new comp(s). Default the root; a duplicate keeps its source's folder."),
    unique_name: z.boolean().optional().describe("Add ' 2', ' 3'... when the name is already used by another item in the project. Default false (true when the name is derived)."),
    dry_run: z.boolean().optional().describe("true: report what would be made and every refusal, change nothing. Default false, except deep duplicates (default true)."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const bad = (message: string, path: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (v.duration !== undefined && v.duration_frames !== undefined) bad("Give duration (seconds) or duration_frames, not both.", "duration_frames");
    if (v.bg_color !== undefined && parseBgColor(v.bg_color) === null) bad("bg_color must be [r, g, b] in 0..1 or '#rrggbb'.", "bg_color");
    if (v.mode === "new") {
      for (const k of ["width", "height", "fps"] as const) if (v[k] === undefined) bad(`new needs ${k}.`, k);
      if (v.duration === undefined && v.duration_frames === undefined) bad("new needs duration (seconds) or duration_frames.", "duration");
    }
    if (v.mode === "from_footage" && v.item_id === undefined) bad("from_footage needs item_id.", "item_id");
    if (v.mode === "duplicate" && v.comp_id === undefined) bad("duplicate needs comp_id.", "comp_id");
    if (v.mode !== "from_footage") {
      if (v.item_id !== undefined) bad("item_id applies to from_footage only.", "item_id");
      if (v.add_layer !== undefined) bad("add_layer applies to from_footage only.", "add_layer");
    }
    if (v.mode !== "duplicate") {
      for (const k of ["comp_id", "deep", "name_suffix", "max_comps"] as const) if (v[k] !== undefined) bad(`${k} applies to duplicate only.`, k);
    } else {
      for (const k of ["width", "height", "pixel_aspect", "fps", "duration", "duration_frames", "bg_color"] as const) {
        if (v[k] !== undefined) bad(`${k} does not apply to duplicate: a copy keeps its source's settings.`, k);
      }
      if (v.max_comps !== undefined && v.deep !== true) bad("max_comps goes with deep: true.", "max_comps");
    }
  });

type CreateArgs = z.infer<typeof AeCreateCompSchema>;

interface PlanEntry {
  role: string;
  name: string | null;
  settings?: { width: number; height: number; pixel_aspect: number; fps: number; duration: number; bg_color?: number[] | null };
  source_id?: number;
  source_name?: string;
  folder_id?: number;
  layers_to_relink?: number;
}

export interface CreatePlan {
  mode: string;
  refusals: string[];
  warnings: string[];
  would_create: PlanEntry[];
  would_create_total: number;
  add_layer: boolean;
  deep: boolean;
  expressions?: ScanExpression[];
  expressions_truncated?: boolean;
}

interface CreatedComp {
  id: number;
  name: string;
  role?: string;
  source_id?: number;
  source_name?: string;
}

interface CreateWritten extends Record<string, unknown> {
  mode?: string;
  deep?: boolean;
  created?: CreatedComp[];
  created_ids?: number[];
  layers_relinked?: number;
  layer_added?: boolean;
  warnings?: string[];
}

/** Host arguments of a create call, without the tool-only flags. */
function createHostArgs(args: CreateArgs): Record<string, unknown> {
  const { dry_run: _dry, expect: _expect, bg_color, ...rest } = args;
  return { ...rest, bg_color: bg_color === undefined ? undefined : parseBgColor(bg_color) };
}

/** What the new comps must look like in the read-back. */
export function createCompMismatches(plan: CreatePlan, beforeRaw: unknown, afterRaw: unknown, w: CreateWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = itemsOf(beforeRaw);
  const after = itemsOf(afterRaw);
  if (!after) return m;
  const created = w.created ?? [];
  expectThat(m, created.length === plan.would_create.length, "created", plan.would_create.length, created.length, "The host made a different number of comps than planned");
  created.forEach((c, i) => {
    const entry = plan.would_create.find((e) => e.source_id !== undefined && e.source_id === c.source_id) ?? plan.would_create[i];
    const got = findItem(after, c.id);
    const at = `comps[${i}]`;
    if (!got || got.missing) {
      if (!after.truncated) m.push({ path: at, expected: c.id, actual: undefined, message: "The new comp is not in the read-back" });
      return;
    }
    expectThat(m, got.kind === "comp", `${at}.kind`, "comp", got.kind, "The new item is not a comp");
    const src = entry?.source_id !== undefined ? findItem(before, entry.source_id) : undefined;
    if (entry?.name) expectThat(m, got.name === entry.name, `${at}.name`, entry.name, got.name, "Name differs");
    const s = entry?.settings;
    // A duplicate keeps its source's settings.
    const want = s ?? (src && src.kind === "comp" ? { width: src.width, height: src.height, pixel_aspect: src.pixel_aspect, fps: src.fps, duration: src.duration, bg_color: src.bg_color } : undefined);
    if (want) {
      if (want.width !== undefined) expectThat(m, got.width === want.width, `${at}.width`, want.width, got.width, "Width differs");
      if (want.height !== undefined) expectThat(m, got.height === want.height, `${at}.height`, want.height, got.height, "Height differs");
      if (want.pixel_aspect !== undefined && got.pixel_aspect !== undefined) {
        expectThat(m, Math.abs(got.pixel_aspect - want.pixel_aspect) < 1e-3, `${at}.pixel_aspect`, want.pixel_aspect, got.pixel_aspect, "Pixel aspect differs");
      }
      if (want.fps !== undefined && got.fps !== undefined) expectThat(m, Math.abs(got.fps - want.fps) < 0.01, `${at}.fps`, want.fps, got.fps, "Frame rate differs");
      if (want.duration !== undefined && got.duration !== undefined && want.fps) {
        // AE snaps a length to whole frames.
        expectThat(m, Math.abs(got.duration - want.duration) <= 1 / want.fps + 1e-6, `${at}.duration`, want.duration, got.duration, "Length differs by more than a frame");
      }
      if (want.bg_color && got.bg_color) {
        expectThat(m, want.bg_color.every((x, k) => Math.abs(x - (got.bg_color![k] ?? 0)) < 2e-3), `${at}.bg_color`, want.bg_color, got.bg_color, "Background colour differs");
      }
    }
    if (entry?.folder_id !== undefined) expectThat(m, got.parent_id === entry.folder_id, `${at}.folder`, entry.folder_id, got.parent_id, "The comp is in another folder");
    else if (plan.mode !== "duplicate" && after.root_id !== undefined) expectThat(m, got.parent_id === after.root_id, `${at}.folder`, after.root_id, got.parent_id, "The comp is not in the project root");
    if (plan.mode === "from_footage") {
      const wantLayers = plan.add_layer ? 1 : 0;
      expectThat(m, got.num_layers === wantLayers, `${at}.num_layers`, wantLayers, got.num_layers, "Layer count differs");
    } else if (plan.mode === "new") {
      expectThat(m, got.num_layers === 0, `${at}.num_layers`, 0, got.num_layers, "A new comp should be empty");
    } else if (src && src.num_layers !== undefined) {
      expectThat(m, got.num_layers === src.num_layers, `${at}.num_layers`, src.num_layers, got.num_layers, "The copy has another number of layers than its source");
    }
  });
  return m;
}

/** The host reads at most this many ids; callers flag the rest as unread. */
const MAX_READ_IDS = 500;

const readItems = (ids: Array<number | undefined>, extra: Record<string, unknown> = {}) => ({
  host: "projectitemsReadItems",
  args: { ids: [...new Set(ids.filter((n): n is number => typeof n === "number"))].slice(0, MAX_READ_IDS), ...extra },
});

async function hostRead<T>(ctx: ToolContext, fn: string, args: Record<string, unknown>, toolName: string, label: string): Promise<T> {
  const res = await ctx.bridge.callHost<T>(fn, args, { label, mutates: false, toolName });
  return res.result;
}

/** A read after an applied write; never throws. */
async function softRead<T>(ctx: ToolContext, fn: string, args: Record<string, unknown>, toolName: string, label: string): Promise<T | null> {
  try {
    return await hostRead<T>(ctx, fn, args, toolName, label);
  } catch {
    return null;
  }
}

async function createComp(args: CreateArgs, ctx: ToolContext) {
  const toolName = "ae_create_comp";
  const dry = args.dry_run ?? (args.mode === "duplicate" && args.deep === true);
  if (!dry) ctx.quarantine.assertClear();
  const hostArgs = createHostArgs(args);
  const label = `ae_create_comp(${args.mode}${dry ? ", dry run" : ""})`;
  const plan = await hostRead<CreatePlan>(ctx, "projectitemsCreateCompPlan", hostArgs, toolName, label);
  const originals = plan.would_create.map((e) => e.source_name).filter((n): n is string => typeof n === "string");
  const { expressions, expressions_truncated, ...planShown } = plan;
  if (plan.refusals.length > 0) {
    return { ok: false, error: "refused", applied: false, dry_run: dry || undefined, message: `Nothing was changed: ${plan.refusals.join("; ")}`, ...planShown };
  }
  if (dry) {
    const stale = plan.deep ? copiedCompWarnings(expressions ?? [], originals) : undefined;
    return {
      ok: true,
      applied: false,
      dry_run: true,
      ...planShown,
      stale_comp_references: stale,
      scan_truncated: expressions_truncated || undefined,
      note: "Nothing was changed. Run the same call with dry_run: false to apply it.",
    };
  }
  const sourceIds = plan.would_create.map((e) => e.source_id);
  const out = await runGuardedWrite<CreateWritten>(ctx, {
    toolName,
    label,
    expect: args.expect,
    compId: args.mode === "duplicate" ? args.comp_id : undefined,
    read: (phase, w) => {
      if (phase === "before") return readItems([...sourceIds, args.target_folder_id]);
      return readItems(w?.created_ids ?? []);
    },
    write: { host: "projectitemsCreateComp", args: { ...hostArgs, label: `Create comp (${args.mode})` } },
    check: (before, after, w) => createCompMismatches(plan, before, after, w),
    present: (_before, after, w) => {
      const read = itemsOf(after);
      return {
        mode: w.mode,
        deep: w.deep,
        comps: (w.created ?? []).map((c) => ({ ...(findItem(read, c.id) ?? { id: c.id, name: c.name }), role: c.role, source_id: c.source_id, source_name: c.source_name })),
        layers_relinked: w.layers_relinked,
        layer_added: w.layer_added,
        warnings: w.warnings?.length ? w.warnings : undefined,
      };
    },
  });
  // The write is in the project: nothing below may throw.
  let stale: ReferenceWarning[] | undefined;
  let scanTruncated: boolean | undefined;
  // The write's own ids are there even when the read-back failed and present() did not run.
  const createdIds = (out as { comps?: Array<{ id: number }> }).comps?.map((c) => c.id) ?? (out as { created_ids?: number[] }).created_ids ?? [];
  if (args.mode === "duplicate" && createdIds.length > 0) {
    const scan = await softRead<ItemsRead>(ctx, "projectitemsReadItems", { ids: [], scan_expressions: true, expression_comp_ids: createdIds }, toolName, `${label} (references)`);
    if (scan?.expressions) {
      stale = copiedCompWarnings(scan.expressions, originals);
      scanTruncated = scan.expressions_truncated || undefined;
    }
  }
  return { ...out, stale_comp_references: stale, scan_truncated: scanTruncated };
}

// ---------- ae_project_items: schema ----------

const OP_ACTIONS = ["create_folder", "move", "rename", "label", "comment", "delete", "organize", "remove_empty_folders"] as const;

const ACTION_FIELDS: Record<(typeof OP_ACTIONS)[number], string[]> = {
  create_folder: ["name", "parent_id"],
  move: ["item_ids", "folder_id", "folder_path"],
  rename: ["item_id", "name", "item_ids", "find", "replace", "regex"],
  label: ["item_ids", "label"],
  comment: ["item_ids", "text"],
  delete: ["item_ids", "force"],
  organize: ["preset", "bins", "skip_items_already_in_folders", "parent_id"],
  remove_empty_folders: ["parent_id"],
};
const ALL_OP_FIELDS = [...new Set(Object.values(ACTION_FIELDS).flat())];

const ItemIds = z.array(z.number().int()).min(1).max(500);

const BinsSchema = z
  .object({
    comps: z.string().max(255).optional(),
    precomps: z.string().max(255).optional(),
    footage: z.string().max(255).optional(),
    stills: z.string().max(255).optional(),
    audio: z.string().max(255).optional(),
    solids: z.string().max(255).optional(),
  })
  .describe("organize: the folder name for each kind (defaults Comps, Precomps, Footage, Stills, Audio, Solids). An empty string leaves that kind where it is.");

const opFields = {
  name: z.string().min(1).max(255).optional().describe("create_folder: the folder's name. rename (one item): the new name."),
  parent_id: z.number().int().optional().describe("create_folder: the folder to create it in. organize and remove_empty_folders: the folder to work in. Default the project root."),
  item_ids: ItemIds.optional().describe("move, rename (with find), label, comment, delete: project item ids (ae_get_project lists them)."),
  item_id: z.number().int().optional().describe("rename: the one item to rename (with name)."),
  folder_id: z.number().int().optional().describe("move: the destination folder. Default the root (or folder_path)."),
  folder_path: z.string().min(1).max(1000).optional().describe("move: a destination as 'Parent/Child' folder names from the root; folders that don't exist are made (the dry run lists them). Instead of folder_id."),
  find: z.string().min(1).max(255).optional().describe("rename: text to find in each name of item_ids (literal unless regex)."),
  replace: z.string().max(255).optional().describe("rename: what to put instead (with regex, $1 etc. work). May be empty."),
  regex: z.boolean().optional().describe("rename: find is a regular expression (every match is replaced)."),
  label: z.number().int().min(0).max(16).optional().describe("label: the label colour index, 0 (none) to 16."),
  text: z.string().max(20000).optional().describe("comment: the comment text; an empty string clears it."),
  force: z.boolean().optional().describe("delete: also delete non-empty folders with everything in them. Used items are refused either way."),
  preset: z.literal("by_kind").optional().describe("organize: the only preset, sorting loose items into bins by kind."),
  bins: BinsSchema.optional(),
  skip_items_already_in_folders: z.boolean().optional().describe("organize: leave items that already sit in a folder alone (default true: only loose root items move)."),
};

const OpSchema = z
  .object({ action: z.enum(OP_ACTIONS).describe("The operation."), ...opFields })
  .describe("One project panel operation: an action and the fields that action takes.");

export const AeProjectItemsSchema = z
  .object({
    action: z.enum(OP_ACTIONS).optional().describe("A single operation (instead of ops): create_folder {name, parent_id}; move {item_ids, folder_id | folder_path}; rename {item_id, name} or {item_ids, find, replace, regex}; label {item_ids, label}; comment {item_ids, text}; delete {item_ids, force}; organize {preset, bins, skip_items_already_in_folders, parent_id}; remove_empty_folders {parent_id}."),
    ...opFields,
    ops: z.array(OpSchema).min(1).max(50).optional().describe("Several operations applied in order, planned together (a later one sees the folders an earlier one makes). Give these or a single action, not both."),
    fix_expressions: z.boolean().optional().describe("Renaming a comp or footage item: afterwards run Project.autoFixExpressions(old, new) in the same undo group so comp(\"Old\") and footage(\"Old\") expressions that now error are repaired. It acts on the whole project and only touches broken expressions. Default true."),
    dry_run: z.boolean().optional().describe("Default TRUE: report the plan and every refusal and change nothing. Pass false to apply it."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const bad = (message: string, path: Array<string | number>) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const flatKeys = ALL_OP_FIELDS.filter((k) => (v as Record<string, unknown>)[k] !== undefined);
    if (v.ops !== undefined) {
      if (v.action !== undefined || flatKeys.length > 0) bad("Give ops or a single action with its fields, not both.", ["ops"]);
      v.ops.forEach((op, i) => opProblems(op).forEach((p) => bad(p.message, ["ops", i, p.path])));
      return;
    }
    if (v.action === undefined) {
      bad("Give action (one operation) or ops (a list).", ["action"]);
      return;
    }
    opProblems({ action: v.action, ...pickOpFields(v) }).forEach((p) => bad(p.message, [p.path]));
  });

type AnyOp = { action: (typeof OP_ACTIONS)[number] } & Record<string, unknown>;
export type ProjectItemsArgs = z.infer<typeof AeProjectItemsSchema>;

function pickOpFields(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALL_OP_FIELDS) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

/** Problems with one operation's fields: fields the action doesn't take, and missing ones. */
export function opProblems(op: AnyOp): Array<{ message: string; path: string }> {
  const out: Array<{ message: string; path: string }> = [];
  const bad = (message: string, path: string) => out.push({ message, path });
  const allowed = new Set(ACTION_FIELDS[op.action]);
  for (const k of ALL_OP_FIELDS) {
    if (!allowed.has(k) && op[k] !== undefined) bad(`${k} does not apply to the ${op.action} action.`, k);
  }
  const has = (k: string) => op[k] !== undefined;
  if (op.action === "create_folder" && !has("name")) bad("create_folder needs name.", "name");
  if (op.action === "move") {
    if (!has("item_ids")) bad("move needs item_ids.", "item_ids");
    if (has("folder_id") && has("folder_path")) bad("Give folder_id or folder_path, not both.", "folder_path");
  }
  if (op.action === "rename") {
    const single = has("item_id") || has("name");
    const bulk = has("item_ids") || has("find") || has("replace") || has("regex");
    if (single && bulk) bad("rename takes item_id and name, or item_ids with find and replace, not both.", "item_id");
    else if (single) {
      if (!has("item_id") || !has("name")) bad("rename of one item needs item_id and name.", "name");
    } else if (bulk) {
      if (!has("item_ids") || !has("find") || !has("replace")) bad("rename of several items needs item_ids, find and replace.", "find");
      if (has("regex") && op.regex === true && typeof op.find === "string") {
        try {
          new RegExp(op.find);
        } catch (e) {
          bad(`find is not a valid regular expression: ${(e as Error).message}`, "find");
        }
      }
    } else {
      bad("rename needs item_id and name, or item_ids with find and replace.", "item_id");
    }
  }
  if (op.action === "label") {
    if (!has("item_ids")) bad("label needs item_ids.", "item_ids");
    if (!has("label")) bad("label needs label (0-16).", "label");
  }
  if (op.action === "comment") {
    if (!has("item_ids")) bad("comment needs item_ids.", "item_ids");
    if (!has("text")) bad("comment needs text.", "text");
  }
  if (op.action === "delete" && !has("item_ids")) bad("delete needs item_ids.", "item_ids");
  return out;
}

/** The ordered operations a call asks for, whichever form it used. */
export function normaliseOps(args: ProjectItemsArgs): AnyOp[] {
  if (args.ops !== undefined) return args.ops.map((op) => ({ action: op.action, ...pickOpFields(op as Record<string, unknown>) }));
  return [{ action: args.action!, ...pickOpFields(args as Record<string, unknown>) }];
}

// ---------- ae_project_items: plan, checks ----------

interface ItemAction {
  type: "create_folder" | "move" | "rename" | "label" | "comment" | "delete";
  op?: number;
  id?: number;
  ids?: number[];
  name?: string;
  parent_id?: number;
  folder_id?: number;
  from?: string;
  to?: string;
  kind?: string;
  label?: number;
  text?: string;
  contained?: number;
}

export interface ItemsPlan {
  actions: ItemAction[];
  actions_total: number;
  actions_truncated: boolean;
  counts: Record<string, number>;
  refusals: Array<{ op: number; action: string; message: string }>;
  skipped: Array<{ op: number; action: string; message: string }>;
  warnings: string[];
  renames: RenamePair[];
  renames_total: number;
  used_items: Array<{ id: number; name: string; used_in: Array<{ id: number; name: string }> }>;
  render_queue_items_removed: Array<{ rq_index: number; status: string | null; comp_id: number; comp_name: string }>;
  fix_expressions: boolean;
  fix_expressions_available: boolean;
}

interface ItemsWritten extends Record<string, unknown> {
  no_op?: boolean;
  refused?: boolean;
  refusals?: unknown[];
  created_folders?: Array<{ virtual_id: number; id: number; name: string; parent_id: number }>;
  moved?: Array<{ id: number; folder_id: number }>;
  renamed?: Array<{ id: number; from: string; to: string; kind: string }>;
  labelled?: Array<{ id: number; label: number }>;
  commented?: Array<{ id: number; text?: string }>;
  deleted?: Array<{ id: number; name: string; kind: string; contained?: number; contained_ids?: number[]; contained_ids_truncated?: boolean }>;
  truncated?: boolean;
  failed?: Array<{ op: number; type: string; id?: number; message: string }>;
  name_fixes_attempted?: number;
  fix_expressions_available?: boolean;
}

/** Ids a call names in its operations: the read before the write looks at these. */
export function idsOfOps(ops: AnyOp[]): number[] {
  const ids: number[] = [];
  for (const op of ops) {
    for (const k of ["item_id", "folder_id", "parent_id"]) if (typeof op[k] === "number") ids.push(op[k] as number);
    if (Array.isArray(op.item_ids)) ids.push(...(op.item_ids as number[]));
  }
  return [...new Set(ids)].slice(0, 500);
}

/** The entries of a list in application order that are the last for their id, with their index. */
function lastPerId<T extends { id: number }>(list: T[]): Array<{ x: T; i: number }> {
  const last = new Map<number, number>();
  list.forEach((x, i) => last.set(x.id, i));
  return list.map((x, i) => ({ x, i })).filter((e) => last.get(e.x.id) === e.i);
}

/**
 * What the plan promised, checked against the items read after the write.
 * Operations run in order and one call may touch an item twice, so only the
 * last expected state of each id is judged, and an item that a later delete
 * removed (or that sat in a force-deleted folder) is judged only by being gone.
 * ops, when given, supplies the comment texts (the host does not echo them).
 */
export function projectItemsMismatches(beforeRaw: unknown, afterRaw: unknown, w: ItemsWritten, ops?: AnyOp[]): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = itemsOf(afterRaw);
  if (!after) return m;
  void beforeRaw;
  // Items past the read's cap are not judged.
  const judged = (id: number) => findItem(after, id);
  const gone = new Set<number>();
  for (const d of w.deleted ?? []) {
    gone.add(d.id);
    for (const c of d.contained_ids ?? []) gone.add(c);
  }
  const commentText = new Map<number, string>();
  for (const op of ops ?? []) {
    if (op.action === "comment" && Array.isArray(op.item_ids) && typeof op.text === "string") for (const id of op.item_ids as number[]) commentText.set(id, op.text);
  }
  (w.created_folders ?? []).forEach((f, i) => {
    if (gone.has(f.id)) return;
    const got = judged(f.id);
    if (!got) return;
    if (got.missing) return void m.push({ path: `created_folders[${i}]`, expected: f.name, actual: undefined, message: "The new folder is not in the read-back" });
    expectThat(m, got.kind === "folder", `created_folders[${i}].kind`, "folder", got.kind, "The new item is not a folder");
    expectThat(m, got.name === f.name, `created_folders[${i}].name`, f.name, got.name, "Folder name differs");
    expectThat(m, got.parent_id === f.parent_id, `created_folders[${i}].parent`, f.parent_id, got.parent_id, "The folder is in another folder");
  });
  lastPerId(w.moved ?? []).forEach(({ x: mv, i }) => {
    if (gone.has(mv.id)) return;
    const got = judged(mv.id);
    if (!got) return;
    if (got.missing) return void m.push({ path: `moved[${i}]`, expected: mv.id, actual: undefined, message: "A moved item is gone" });
    expectThat(m, got.parent_id === mv.folder_id, `moved[${i}].parent`, mv.folder_id, got.parent_id, `"${got.name}" is not in the destination folder`);
  });
  lastPerId(w.renamed ?? []).forEach(({ x: r, i }) => {
    if (gone.has(r.id)) return;
    const got = judged(r.id);
    if (!got || got.missing) return;
    expectThat(m, got.name === r.to, `renamed[${i}].name`, r.to, got.name, "Name differs");
  });
  lastPerId(w.labelled ?? []).forEach(({ x: l, i }) => {
    if (gone.has(l.id)) return;
    const got = judged(l.id);
    if (!got || got.missing || got.label === null || got.label === undefined) return;
    expectThat(m, got.label === l.label, `labelled[${i}].label`, l.label, got.label, "Label differs");
  });
  lastPerId(w.commented ?? []).forEach(({ x: c, i }) => {
    if (gone.has(c.id)) return;
    const got = judged(c.id);
    if (!got || got.missing || got.comment === null || got.comment === undefined) return;
    const want = commentText.get(c.id) ?? c.text;
    if (want === undefined) return;
    expectThat(m, got.comment === want, `commented[${i}].comment`, want, got.comment, "Comment differs");
  });
  (w.deleted ?? []).forEach((d, i) => {
    const got = judged(d.id);
    if (!got) return;
    expectThat(m, got.missing === true, `deleted[${i}]`, "gone", got.name, `"${d.name}" is still in the project`);
    (d.contained_ids ?? []).forEach((cid, j) => {
      const inner = judged(cid);
      if (!inner) return;
      expectThat(m, inner.missing === true, `deleted[${i}].contained[${j}]`, "gone", inner.name, `An item inside the deleted folder "${d.name}" is still in the project`);
    });
  });
  (w.failed ?? []).forEach((f, i) => {
    m.push({ path: `failed[${i}]`, expected: `${f.type} applied`, actual: f.message, message: `AE refused one step (${f.type}${f.id !== undefined ? ` on item ${f.id}` : ""}): ${f.message}` });
  });
  return m;
}

/** Ids to read after the write: everything it touched. */
function touchedIds(w: ItemsWritten | undefined): number[] {
  if (!w) return [];
  const ids: number[] = [];
  for (const f of w.created_folders ?? []) ids.push(f.id, f.parent_id);
  for (const x of w.moved ?? []) ids.push(x.id, x.folder_id);
  for (const x of w.renamed ?? []) ids.push(x.id);
  for (const x of w.labelled ?? []) ids.push(x.id);
  for (const x of w.commented ?? []) ids.push(x.id);
  for (const x of w.deleted ?? []) ids.push(x.id, ...(x.contained_ids ?? []));
  return [...new Set(ids)];
}

/** Comps whose expressions are re-validated after a rename; the report says when more were affected. */
const MAX_VALIDATED_COMPS = 10;

async function validateComps(ctx: ToolContext, compIds: number[], toolName: string, when: string): Promise<ValidateResult[]> {
  const out: ValidateResult[] = [];
  for (const id of compIds.slice(0, MAX_VALIDATED_COMPS)) {
    const r = await softRead<ValidateResult>(ctx, "validateExpressions", { comp_id: id }, toolName, `${toolName} (validate expressions, ${when})`);
    if (r) out.push(r);
  }
  return out;
}

async function projectItems(args: ProjectItemsArgs, ctx: ToolContext) {
  const toolName = "ae_project_items";
  const dry = args.dry_run !== false;
  if (!dry) ctx.quarantine.assertClear();
  const ops = normaliseOps(args);
  const fixOn = args.fix_expressions !== false;
  const hostArgs = { ops, fix_expressions: fixOn };
  const label = `ae_project_items(${ops.map((o) => o.action).join(", ")}${dry ? ", dry run" : ""})`;
  const plan = await hostRead<ItemsPlan>(ctx, "projectitemsPlan", hostArgs, toolName, label);

  // References to the names a rename takes away, for the dry run and to compare after the write.
  const renames = plan.renames ?? [];
  const wantScan = renames.length > 0;
  const beforeScan = wantScan ? await softRead<ItemsRead>(ctx, "projectitemsReadItems", { ids: [], scan_expressions: true }, toolName, `${label} (references)`) : null;
  const refsBefore = beforeScan?.expressions ? referencesToRenamed(beforeScan.expressions, renames) : [];
  const affectedComps = [...new Set(refsBefore.map((r) => r.ex.comp_id))];
  const referenceReport = wantScan
    ? {
        expressions_naming_renamed_items: refsBefore.length,
        comps: affectedComps.length,
        validated_comps: Math.min(affectedComps.length, MAX_VALIDATED_COMPS),
        validate_truncated: affectedComps.length > MAX_VALIDATED_COMPS || undefined,
        examples: refsBefore.slice(0, 10).map((r) => ({ comp: r.ex.comp_name, layer: r.ex.layer_name, path: r.ex.path, reference: `${r.ref.kind}("${r.ref.name}")` })),
        scan_truncated: beforeScan ? beforeScan.expressions_truncated || undefined : undefined,
        scan_failed: beforeScan ? undefined : true,
        fix: fixOn && plan.fix_expressions_available ? "Project.autoFixExpressions repairs the ones that error after the rename" : "not repaired",
      }
    : undefined;

  if (plan.refusals.length > 0) {
    return {
      ok: false,
      error: "refused",
      applied: false,
      dry_run: dry || undefined,
      message: `Nothing was changed: ${plan.refusals.map((r) => `[${r.action} #${r.op}] ${r.message}`).join(" ")}`,
      ...plan,
    };
  }
  if (dry) {
    return {
      ok: true,
      applied: false,
      dry_run: true,
      ...plan,
      expression_references: referenceReport,
      note: "Nothing was changed. Run the same call with dry_run: false to apply it.",
    };
  }
  if (plan.actions_total === 0) {
    return { ok: true, applied: false, no_op: true, message: "Nothing to do: every operation was already in effect.", skipped: plan.skipped, counts: plan.counts };
  }

  const validateBefore = affectedComps.length > 0 ? await validateComps(ctx, affectedComps, toolName, "before") : [];
  const out = await runGuardedWrite<ItemsWritten>(ctx, {
    toolName,
    label,
    expect: args.expect,
    read: (phase, w) => (phase === "before" ? readItems(idsOfOps(ops)) : readItems(touchedIds(w))),
    write: { host: "projectitemsApply", args: { ...hostArgs, label: "Project items" } },
    check: (before, after, w) => projectItemsMismatches(before, after, w, ops),
    present: (_before, after, w) => {
      const read = itemsOf(after);
      const total = (name: string, list?: unknown[]): number => ((w as Record<string, unknown>)[`${name}_total`] as number | undefined) ?? list?.length ?? 0;
      const totals: Record<string, number> = {};
      for (const [name, list] of [["created_folders", w.created_folders], ["moved", w.moved], ["renamed", w.renamed], ["labelled", w.labelled], ["commented", w.commented], ["deleted", w.deleted], ["failed", w.failed]] as Array<[string, unknown[] | undefined]>) {
        if (list && total(name, list) > list.length) totals[`${name}_total`] = total(name, list);
      }
      return {
        ...totals,
        truncated: w.truncated || undefined,
        no_op: w.no_op,
        refused: w.refused,
        refusals: w.refusals,
        created_folders: w.created_folders,
        moved: w.moved && w.moved.length > 50 ? { count: total("moved", w.moved), folder_ids: [...new Set(w.moved.map((x) => x.folder_id))].slice(0, 100) } : w.moved,
        renamed: w.renamed?.slice(0, 500),
        labelled: w.labelled && w.labelled.length > 50 ? { count: total("labelled", w.labelled) } : w.labelled,
        commented: w.commented && w.commented.length > 50 ? { count: total("commented", w.commented) } : w.commented?.map((c) => ({ id: c.id })),
        deleted: w.deleted?.slice(0, 500).map(({ contained_ids, contained_ids_truncated: _t, ...d }) => ({ ...d, contained_ids_count: contained_ids?.length || undefined })),
        failed: w.failed?.length ? w.failed.slice(0, 500) : undefined,
        skipped: plan.skipped.length ? plan.skipped : undefined,
        render_queue_items_removed: plan.render_queue_items_removed.length ? plan.render_queue_items_removed : undefined,
        name_fixes_attempted: w.name_fixes_attempted,
        warnings: plan.warnings.length ? plan.warnings : undefined,
        items_unread: (read && read.truncated) || touchedIds(w).length > MAX_READ_IDS ? true : undefined,
      };
    },
  });
  if ((out as ItemsWritten).refused === true) {
    // The project changed between the plan and the write; nothing was written.
    return { ...out, ok: false, error: "refused", applied: false, message: "Nothing was changed: the project changed between the plan and the write; re-run the dry run." };
  }

  // After the write nothing may throw: references and expression errors are best-effort reads.
  let after: Record<string, unknown> | undefined;
  const renamedDone = (out as ItemsWritten).renamed ?? [];
  const doneRenames = renames.filter((r) => renamedDone.some((x) => x.id === r.id));
  if (doneRenames.length > 0) {
    const scan = await softRead<ItemsRead>(ctx, "projectitemsReadItems", { ids: [], scan_expressions: true }, toolName, `${label} (references after)`);
    const unresolved = scan?.expressions ? renamedReferenceWarnings(scan.expressions, doneRenames, scan.item_names) : [];
    const validateAfter = affectedComps.length > 0 ? await validateComps(ctx, affectedComps, toolName, "after") : [];
    after = {
      unresolved_name_references: unresolved,
      new_expression_errors: affectedComps.length > 0 ? newExpressionErrors(validateBefore, validateAfter) : undefined,
      references_scan_failed: scan ? undefined : true,
      references_scan_truncated: scan?.expressions_truncated || undefined,
    };
  }
  return { ...out, expression_references: referenceReport ? { ...referenceReport, ...after } : undefined };
}

// ---------- tools ----------

export const projectitemsTools: ToolDefinition<any>[] = [
  {
    name: "ae_create_comp",
    description:
      "Make a comp, which no other tool does: mode 'new' from width, height, fps, duration (seconds, or duration_frames), pixel_aspect and bg_color; 'from_footage' from a footage item, copying its size, pixel aspect, frame rate and length like New Comp from Footage (stills need duration) and adding the footage as a layer; 'duplicate' to copy a comp, optionally deep (every nested precomp copied once and relinked, up to max_comps, default 50). " +
      "The new comp goes in target_folder_id (default the root; a duplicate keeps its source's folder). Settings are range-checked before anything changes (size 4-30000, fps 1-99, duration up to 10800 s, pixel aspect 0.01-100). A deep duplicate is a DRY RUN unless you pass dry_run: false, and lists the comps it would copy. " +
      "Expressions in copies that read comp(\"Name\") still point at the original comps; the result lists them in stale_comp_references. The comp is not opened in a viewer (ae_view does that). " +
      "The read-back (a separate evalScript) checks each new comp's size, pixel aspect, frame rate, length, background, folder and layer count. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCreateCompSchema,
    handler: (args: CreateArgs, ctx) => createComp(args, ctx),
  },
  {
    name: "ae_project_items",
    description:
      "Project panel housekeeping, planned on a copy of the project tree first: create_folder, move (refusing a folder into itself or its own child), rename (one item, or find/replace over several, literal or regex; comps and footage get their comp(\"Old\") / footage(\"Old\") expressions repaired with Project.autoFixExpressions after the rename, project-wide, only for expressions that now error), " +
      "label (0-16), comment, delete, organize (loose items into Comps / Precomps / Footage / Stills / Audio / Solids bins) and remove_empty_folders. Give one action with its fields, or ops to apply several in order. " +
      "dry_run is TRUE by default: you get the plan, every refusal and the render queue items a delete would remove; pass dry_run: false to apply it in one undo group. " +
      "delete refuses any comp or footage item that is used in a comp outside the deletion (its layers would vanish), checked inside folders too, refuses the root, and refuses a non-empty folder unless force: true. " +
      "After comp renames the tool re-validates the expressions of the affected comps in a separate call and reports new errors. Selection is ae_view's job. " +
      "The read-back (a separate evalScript) checks every item's name, folder, label and comment, and that deleted items are gone. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeProjectItemsSchema,
    handler: (args: ProjectItemsArgs, ctx) => projectItems(args, ctx),
  },
];
