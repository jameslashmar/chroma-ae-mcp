/**
 * server/src/tools/ext/view.ts
 *
 * ae_view: how an agent hands work back to the user. One call may open an item
 * in the viewer, the Layer panel or Essential Graphics, park the comp time,
 * select layers / properties / keyframes / project items, and set viewer
 * options (zoom, exposure, channels, checkerboards, fast preview, guides,
 * rulers). Every reply carries the previous state, and `restore` puts it back.
 *
 * These are UI-state writes, not project edits: no undo group in the host, no
 * checkpoint, not in AUTO_CHECKPOINT_TOOLS. The expect guard still applies and
 * the read-back runs in a separate evalScript. Afterwards the session baseline
 * is refreshed with noteUiWrite (ext/session.ts), so ae_session_changes does
 * not report the agent's own time or selection change as the user's.
 */

import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { readBackMismatch } from "../read-back.js";
import { beginInflight, endInflight, noteBeforeWrite, noteUiWrite } from "./session.js";
import { expectThat, type HostCall } from "./write-runner.js";

// ---------- schemas ----------

export const VIEW_CHANNELS = [
  "rgb",
  "red",
  "green",
  "blue",
  "alpha",
  "rgb_straight",
  "red_colorize",
  "green_colorize",
  "blue_colorize",
  "alpha_boundary",
  "alpha_overlay",
] as const;

export const VIEW_FAST_PREVIEWS = ["off", "adaptive_resolution", "draft", "fast_draft", "wireframe"] as const;

/** Same format as ae_set_property paths and ae_status selected_properties: match names, or a child's name / index under an indexed group. */
export const ViewPathSchema = z
  .array(z.union([z.string().min(1), z.number().int().positive()]))
  .min(1)
  .max(30)
  .describe("Property path from the layer, as in ae_set_property and ae_status selected_properties, e.g. ['ADBE Transform Group','ADBE Position'].");

const OpenSchema = z
  .object({
    in: z
      .enum(["viewer", "layer", "essential_graphics"])
      .describe(
        "'viewer': the Composition or Footage viewer (comp or footage item). 'layer': the Layer panel for one layer (AE opens nothing for text and shape layers and says so). " +
          "'essential_graphics': the Essential Graphics panel for a comp (AE 15.0+)."
      ),
    item_id: z
      .number()
      .int()
      .optional()
      .describe("The project item to open (a comp or footage item). With in 'layer': the comp holding the layer. Default: comp_id."),
    layer: LayerSelectorSchema.optional().describe("With in 'layer': the layer to open."),
    if_not_active: z
      .boolean()
      .optional()
      .describe("With in 'viewer': skip opening when the item is already the active item, so the user's focus is left alone."),
  })
  .refine((o) => (o.in === "layer" ? o.layer !== undefined : o.layer === undefined), {
    message: "layer goes with in: 'layer' (and only there).",
  });

const TimeSchema = z
  .object({
    time: z.number().optional().describe("Comp time in seconds."),
    frame: z.number().int().min(0).optional().describe("Frame number counted from the comp's start (frame 0 is time 0)."),
  })
  .refine((t) => (t.time === undefined) !== (t.frame === undefined), { message: "Give exactly one of time or frame." })
  .describe("Park the comp's current time. Snapped to a frame and clamped to the comp (the reply says when it was clamped).");

const SelectSchema = z
  .object({
    layers: z.array(LayerSelectorSchema).max(500).optional().describe("Layers of comp_id to select (id, index or name). An empty list with deselect_others clears the layer selection."),
    properties: z
      .array(z.object({ layer: LayerSelectorSchema, path: ViewPathSchema }))
      .max(100)
      .optional()
      .describe("Properties or property groups to select."),
    keys: z
      .array(
        z.object({
          layer: LayerSelectorSchema,
          path: ViewPathSchema,
          indexes: z.array(z.number().int().positive()).min(1).max(200).describe("1-based keyframe indexes."),
        })
      )
      .max(100)
      .optional()
      .describe("Keyframes to select (Property.setSelectedAtKey). The property is selected too."),
    items: z.array(z.number().int()).max(500).optional().describe("Project items to select in the Project panel. Selecting items can leave app.project.activeItem null in AE."),
    deselect_others: z
      .boolean()
      .optional()
      .describe(
        "Default true: for each kind you give (layers, properties/keys, items), what else is selected of that kind is deselected first. " +
          "Keys are deselected on the named properties only."
      ),
  })
  .refine((s) => s.layers !== undefined || s.properties !== undefined || s.keys !== undefined || s.items !== undefined, {
    message: "select needs at least one of layers, properties, keys or items.",
  });

const ViewerOptionsSchema = z
  .object({
    view_index: z.number().int().min(0).max(8).optional().describe("Which view of a multi-view viewer (0-based). Default the active view."),
    zoom: z.number().min(0.01).max(16).optional().describe("Zoom ratio, 1 = 100%."),
    exposure: z.number().min(-40).max(40).optional().describe("Viewer exposure in stops."),
    channels: z.enum(VIEW_CHANNELS).optional().describe("Channel display: 'alpha' shows the matte, 'alpha_overlay' the alpha as a colour overlay."),
    checkerboards: z.boolean().optional().describe("The transparency grid."),
    fast_preview: z
      .enum(VIEW_FAST_PREVIEWS)
      .optional()
      .describe("Fast Previews mode (AE 12.0+). Composition viewers only (AE throws in the Layer and Footage panels); 'draft' is refused in a Classic 3D comp."),
    guides_visibility: z.boolean().optional().describe("Show guides (AE 16.1+)."),
    guides_locked: z.boolean().optional().describe("Lock guides (AE 16.1+)."),
    guides_snap: z.boolean().optional().describe("Snap to guides (AE 16.1+)."),
    rulers: z.boolean().optional().describe("Show rulers (AE 16.1+)."),
  })
  .refine((v) => Object.entries(v).some(([k, val]) => k !== "view_index" && val !== undefined), {
    message: "viewer_options needs at least one option besides view_index.",
  });

const ViewStateSchema = z
  .object({
    active_item: z.object({ id: z.number().int() }).passthrough().nullable().optional(),
    comp: z.object({ id: z.number().int(), time: z.number().nullable().optional() }).passthrough().nullable().optional(),
    selected_layers: z.array(z.number().int()).max(500).optional(),
    selected_layers_truncated: z.boolean().optional(),
    selected_properties: z
      .array(
        z
          .object({
            layer_id: z.number().int(),
            path: ViewPathSchema,
            is_group: z.boolean().optional(),
            selected_keys: z.array(z.number().int().positive()).max(200).optional(),
          })
          .passthrough()
      )
      .max(100)
      .optional(),
    selected_properties_truncated: z.boolean().optional(),
    selected_keys_truncated: z.boolean().optional(),
    selected_items: z.array(z.number().int()).max(500).optional(),
    selected_items_truncated: z.boolean().optional(),
    viewer: z
      .object({ type: z.string().optional(), active_view_index: z.number().int().nullable().optional(), options_view_index: z.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    view_options: z.record(z.union([z.number(), z.boolean(), z.string(), z.null()])).nullable().optional(),
  })
  .passthrough();

export const AeViewSchema = z
  .object({
    comp_id: z
      .number()
      .int()
      .optional()
      .describe("The comp that time, layer / property / key selection and the state report apply to. Also the comp the target guard checks."),
    open: OpenSchema.optional().describe("Open an item. This takes focus (as clicking it would); without `open` and `focus` the tool never does."),
    time: TimeSchema.optional(),
    select: SelectSchema.optional(),
    viewer_options: ViewerOptionsSchema.optional().describe("Viewer settings on the active viewer. Needs a viewer: AE may report none while a panel has focus."),
    restore: ViewStateSchema.optional().describe(
      "The `previous_state` an earlier ae_view reply returned. Puts back the comp time, the layer / property / key / item selection and the view options, " +
        "and reopens the previous active item in a viewer only if it is no longer the active one (that takes focus). Parts that no longer exist (a deleted comp, layer or item) are skipped and listed in `skipped`; " +
        "the comp is not guarded unless expect.comp_id is given. Use it alone, with expect (and focus)."
    ),
    focus: z
      .boolean()
      .optional()
      .describe("Default false. True activates the viewer (Viewer.setActive), which steals keyboard focus while the user works. Leave it off unless the user should see the change now."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const acts = [v.open, v.time, v.select, v.viewer_options].filter((x) => x !== undefined).length;
    if (v.restore !== undefined) {
      if (acts > 0 || v.comp_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restore is used on its own (with expect and focus only)." });
      }
      return;
    }
    if (acts === 0 && v.focus !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give at least one of open, time, select, viewer_options, restore or focus: true." });
    }
    if (v.time !== undefined && v.comp_id === undefined && v.open?.item_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "time needs comp_id (or open.item_id of a comp)." });
    }
    const s = v.select;
    if (s && (s.layers !== undefined || s.properties !== undefined || s.keys !== undefined) && v.comp_id === undefined && v.open?.item_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Selecting layers, properties or keys needs comp_id (or open.item_id of a comp)." });
    }
    if (v.open && v.open.in !== "layer" && v.open.item_id === undefined && v.comp_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "open needs item_id (or comp_id)." });
    }
    if (v.open && v.open.in === "layer" && v.open.item_id === undefined && v.comp_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Opening a layer needs its comp: open.item_id or comp_id." });
    }
  });

export type ViewArgs = z.infer<typeof AeViewSchema>;
type SelectArgs = z.infer<typeof SelectSchema>;
type OpenArgs = z.infer<typeof OpenSchema>;
type ViewerOptionsArgs = z.infer<typeof ViewerOptionsSchema>;

// ---------- state shape (what viewState returns) ----------

export interface ViewStateProp {
  layer_id: number;
  layer_index?: number;
  path: Array<string | number>;
  name?: string;
  is_group?: boolean;
  selected_keys: number[];
}

export interface ViewState {
  active_item: { id: number; name?: string; kind?: string } | null;
  comp: { id: number; name?: string; time: number | null; frame?: number | null; frame_rate?: number | null } | null;
  selected_layers: number[];
  selected_layers_truncated?: boolean;
  selected_properties: ViewStateProp[];
  selected_properties_truncated?: boolean;
  selected_keys_truncated?: boolean;
  selected_items: number[];
  selected_items_truncated?: boolean;
  viewer: { type?: string; maximized?: boolean | null; view_count?: number | null; active_view_index?: number | null; options_view_index?: number | null } | null;
  view_options: Record<string, number | boolean | string | null> | null;
  dirty: boolean | null;
  missing: string[];
}

/** What viewApply receives: the tool's arguments, with `restore` already turned into the same operations. */
export interface EffectiveView {
  comp_id?: number;
  open?: OpenArgs;
  time?: { time?: number; frame?: number };
  select?: SelectArgs;
  viewer_options?: ViewerOptionsArgs;
  focus?: boolean;
  /** Set by the handler for a restore: viewApply then skips (not fails) what no longer fits: a comp, item, layer, key or option that is gone. */
  restore?: boolean;
  /** The viewer type the saved options were read from (restore only). */
  viewer_type?: string;
}

const VIEW_OPTION_KEYS = ["zoom", "exposure", "channels", "checkerboards", "fast_preview", "guides_visibility", "guides_locked", "guides_snap", "rulers"] as const;

const asState = (v: unknown): ViewState | null => (v && typeof v === "object" ? (v as ViewState) : null);

/** Turns a previous_state into the operations that put it back. Pure. */
export function restoreToArgs(prev: z.infer<typeof ViewStateSchema> | ViewState): EffectiveView {
  const p = prev as Partial<ViewState> & Record<string, unknown>;
  const out: EffectiveView = {};
  const truncated =
    p.selected_layers_truncated === true ||
    p.selected_properties_truncated === true ||
    p.selected_keys_truncated === true ||
    p.selected_items_truncated === true;
  const comp = p.comp ?? null;
  if (comp) {
    out.comp_id = comp.id;
    if (typeof comp.time === "number") out.time = { time: comp.time };
    const select: SelectArgs = { deselect_others: !truncated };
    select.layers = (p.selected_layers ?? []).map((id) => ({ id }));
    const props = p.selected_properties ?? [];
    select.properties = props.map((e) => ({ layer: { id: e.layer_id }, path: e.path }));
    const withKeys = props.filter((e) => e.is_group !== true && (e.selected_keys?.length ?? 0) > 0);
    if (withKeys.length) select.keys = withKeys.map((e) => ({ layer: { id: e.layer_id }, path: e.path, indexes: e.selected_keys }));
    out.select = select;
  }
  if (p.selected_items) {
    out.select = { ...(out.select ?? { deselect_others: !truncated }), items: p.selected_items };
  }
  const active = p.active_item;
  if (active && (active.kind === "comp" || active.kind === "footage")) {
    out.open = { in: "viewer", item_id: active.id, if_not_active: true };
  }
  const opts = p.view_options;
  if (opts) {
    const vo: Record<string, unknown> = {};
    for (const k of VIEW_OPTION_KEYS) {
      const val = opts[k];
      if (val === null || val === undefined) continue;
      if (k === "fast_preview" && p.viewer?.type !== "comp") continue;
      vo[k] = val;
    }
    if (Object.keys(vo).length) {
      // the options were read from options_view_index (the view a call named), else from the active view
      const idx = typeof p.viewer?.options_view_index === "number" ? p.viewer.options_view_index : p.viewer?.active_view_index;
      if (typeof idx === "number") vo.view_index = idx;
      out.viewer_options = vo as ViewerOptionsArgs;
    }
  }
  return out;
}

// ---------- checks ----------

interface Written extends Record<string, unknown> {
  comp_id?: number | null;
  opened?: { in?: string; item_id?: number | null; opened?: boolean; skipped?: string } | null;
  time?: { applied?: number; error?: string } | null;
  layers?: number[] | null;
  properties?: Array<{ layer_id: number; path: Array<string | number> }> | null;
  keys?: Array<{ layer_id: number; path: Array<string | number>; indexes: number[] }> | null;
  items?: number[] | null;
  deselect_others?: boolean | null;
  options_applied?: Record<string, unknown> | null;
  options_target?: string;
  options_verifiable?: boolean;
  skipped?: Array<{ what: string; reason: string }>;
  warnings?: string[];
  changed?: number;
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const hasAll = (have: number[], want: number[]) => want.every((x) => have.includes(x));
const pathKey = (p: Array<string | number>) => JSON.stringify(p);

export function viewMismatches(eff: EffectiveView, afterRaw: unknown, w: Written): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = asState(afterRaw);
  if (!after) return m;
  const skippedWhat = new Set((w.skipped ?? []).map((s) => s.what));

  if (w.opened?.opened === true && w.opened.in === "viewer" && w.opened.item_id !== null && w.opened.item_id !== undefined) {
    expectThat(m, after.active_item?.id === w.opened.item_id, "active_item.id", w.opened.item_id, after.active_item?.id, "The opened item is not the active item");
  }
  if (w.time && typeof w.time.applied === "number" && !w.time.error) {
    const actual = after.comp?.time;
    expectThat(m, typeof actual === "number" && Math.abs(actual - w.time.applied) <= 0.001, "comp.time", w.time.applied, actual, "The comp time differs");
  }
  if (w.layers && !after.selected_layers_truncated) {
    const ok = w.deselect_others === false ? hasAll(after.selected_layers, w.layers) : sameSet(after.selected_layers, w.layers);
    expectThat(m, ok, "selected_layers", w.layers, after.selected_layers, "The layer selection differs");
  }
  if (w.properties && !after.selected_properties_truncated) {
    for (const want of w.properties) {
      const found = after.selected_properties.find((e) => e.layer_id === want.layer_id && pathKey(e.path) === pathKey(want.path));
      expectThat(m, found !== undefined, "selected_properties", want, undefined, "A property is not selected");
    }
  }
  if (w.keys && !after.selected_properties_truncated && !after.selected_keys_truncated) {
    for (const want of w.keys) {
      const found = after.selected_properties.find((e) => e.layer_id === want.layer_id && pathKey(e.path) === pathKey(want.path));
      const have = found?.selected_keys ?? [];
      const ok = w.deselect_others === false ? hasAll(have, want.indexes) : sameSet(have, want.indexes);
      expectThat(m, ok, "selected_keys", want, have, "The selected keyframes differ");
    }
  }
  if (w.items && !after.selected_items_truncated) {
    const ok = w.deselect_others === false ? hasAll(after.selected_items, w.items) : sameSet(after.selected_items, w.items);
    expectThat(m, ok, "selected_items", w.items, after.selected_items, "The project item selection differs");
  }
  if (w.options_applied && w.options_target === "opened_viewer" && w.options_verifiable === false) {
    expectThat(m, false, "view_options", w.options_applied, undefined, "The options went to the viewer that open returned, which is not app.activeViewer, so the read-back cannot confirm them (unverifiable)");
  } else if (w.options_applied && after.view_options) {
    for (const [key, want] of Object.entries(w.options_applied)) {
      if (skippedWhat.has(key)) continue;
      const have = after.view_options[key];
      let ok: boolean;
      if (typeof want === "number" && typeof have === "number") ok = Math.abs(want - have) <= Math.max(1e-3, Math.abs(want) * 1e-3);
      else ok = have === want;
      expectThat(m, ok, `view_options.${key}`, want, have, "A viewer option differs");
    }
  } else if (w.options_applied && !after.view_options) {
    const unconfirmed = Object.keys(w.options_applied).filter((k) => !skippedWhat.has(k));
    if (unconfirmed.length) {
      expectThat(m, false, "view_options", w.options_applied, undefined, "The read-back found no active viewer, so the options could not be confirmed (unverified)");
    }
  }
  return m;
}

// ---------- UI-state write ----------

/** The reply when the read-back failed: the before state is still handed back, so the agent can restore. */
function withPrevious(written: Written, before: unknown): Record<string, unknown> {
  return { ...written, previous_state: before, dirty_before: asState(before)?.dirty ?? null };
}

/**
 * The guarded flow of write-runner.ts for a write that edits no project:
 * quarantine check, target guard, before read, the write, a separate after
 * read, receipt. No checkpoint, and the session baseline is refreshed with
 * noteUiWrite so the agent's own time / selection change is not the user's.
 */
async function runUiWrite(
  ctx: ToolContext,
  spec: {
    toolName: string;
    label: string;
    expect: ExpectGuard;
    compId?: number;
    read: (phase: "before" | "after", written?: Written) => HostCall;
    write: HostCall;
    check: (after: unknown, written: Written) => ReceiptMismatch[];
    present: (before: unknown, after: unknown, written: Written) => Record<string, unknown>;
  }
) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect: ExpectGuard = { project_path: spec.expect.project_path, comp_id: spec.expect.comp_id ?? spec.compId };
  const read = async (phase: "before" | "after", written?: Written) => {
    const call = spec.read(phase, written);
    const res = await ctx.bridge.evalRaw({
      id: `${opId}_${phase}`,
      script: buildJsxCall(call.host, call.args),
      label: `${spec.label} (${phase})`,
      mutates: false,
      toolName: spec.toolName,
      timeoutMs: call.timeoutMs,
    });
    return res.result ?? null;
  };

  try {
    return await ctx.queue.run(spec.label, async () => {
      ctx.quarantine.assertClear();
      await verifyTargetGuard(ctx, expect, opId);
      const note = { opId, toolName: spec.toolName, label: spec.label, expect, checkpoint: null };
      const sessionFields = await noteBeforeWrite(ctx, note);
      const before = await read("before");
      beginInflight(note);
      let write;
      try {
        write = await ctx.bridge.evalRaw<Written>({
          id: opId,
          script: buildJsxCall(spec.write.host, { ...spec.write.args, expect }),
          label: spec.label,
          mutates: true,
          toolName: spec.toolName,
          timeoutMs: spec.write.timeoutMs,
        });
      } finally {
        endInflight(opId);
      }
      const written = (write.result ?? {}) as Written;
      // From here the write is applied: nothing below may throw.
      let after: unknown = null;
      let failure: ReceiptMismatch | null = null;
      try {
        after = await read("after", written);
      } catch (err) {
        failure = readBackMismatch(opId, "the read-back failed", err);
      }
      let custom: ReceiptMismatch[] = [];
      let shown: Record<string, unknown> = written;
      if (!failure) {
        try {
          custom = spec.check(after, written);
          shown = spec.present(before, after, written);
        } catch (err) {
          custom = [readBackMismatch(opId, "checking the read-back failed", err)];
          shown = withPrevious(written, before);
        }
      } else {
        custom = [failure];
        shown = withPrevious(written, before);
      }
      const receipt = buildReceipt({ before, after, customMismatches: custom });
      await noteUiWrite(ctx, note, { skipRead: !!failure });
      return { op_id: opId, applied: true as const, ...shown, receipt, ...sessionFields };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

// ---------- tool ----------

const labelOf = (a: ViewArgs): string => {
  if (a.restore) return "ae_view(restore)";
  const parts: string[] = [];
  if (a.open) parts.push(`open ${a.open.in}`);
  if (a.time) parts.push("time");
  if (a.select) parts.push("select");
  if (a.viewer_options) parts.push("viewer_options");
  if (a.focus) parts.push("focus");
  return `ae_view(${parts.join(", ")})`;
};

export const viewTools: ToolDefinition<any>[] = [
  {
    name: "ae_view",
    description:
      "Hand work back to the user: open a comp or footage item in the viewer, a layer in the Layer panel or a comp in Essential Graphics (`open`), park the comp's playhead on a frame (`time`, snapped and clamped), " +
      "select layers, properties, keyframes or project items (`select`, the same property paths as ae_set_property and ae_status), and set viewer options (`viewer_options`: zoom, exposure, channels such as alpha, the transparency grid, fast preview, guides, rulers). " +
      "One call may combine them, applied in this order: project items, open, time, layers, properties and keys, viewer options, focus. " +
      "Every reply returns `previous_state` (active item, comp time, selections, view options); send it back as `restore` to undo the hand-off. " +
      "It never takes focus unless `open` or `focus: true` is given (those steal keyboard focus while the user works). " +
      "This is UI state, not a project edit: no undo step, no checkpoint, and ae_session_changes does not report it as the user's change. Members newer than AE 22 are version-guarded and reported in `skipped` / `missing`. " +
      "The read-back (a separate evalScript) checks the time, selections and options. Note that AE may report no active viewer while a panel has focus, and that comp.time may mark the project dirty (dirty_before / dirty_after are returned). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeViewSchema,
    handler: (args: ViewArgs, ctx) => {
      const eff: EffectiveView = args.restore
        ? {
            ...restoreToArgs(args.restore),
            ...(args.focus !== undefined ? { focus: args.focus } : {}),
            restore: true,
            ...(typeof args.restore.viewer?.type === "string" ? { viewer_type: args.restore.viewer.type } : {}),
          }
        : {
            comp_id: args.comp_id,
            open: args.open,
            time: args.time,
            select: args.select,
            viewer_options: args.viewer_options,
            focus: args.focus,
          };
      // a restore is not guarded against the saved comp (it may have been deleted since): only a caller-given expect.comp_id guards the comp
      const compFor = args.restore ? undefined : eff.comp_id;
      // the comp the call changes: comp_id, else the item `open` names (previous_state describes this comp)
      const readComp = eff.comp_id ?? eff.open?.item_id;
      return runUiWrite(ctx, {
        toolName: "ae_view",
        label: labelOf(args),
        expect: args.expect,
        compId: compFor,
        read: (phase, w) => {
          const readArgs: Record<string, unknown> = {};
          const id = phase === "after" ? (w?.comp_id ?? readComp) : readComp;
          if (id !== undefined && id !== null) readArgs.comp_id = id;
          if (eff.viewer_options?.view_index !== undefined) readArgs.view_index = eff.viewer_options.view_index;
          return { host: "viewState", args: readArgs };
        },
        write: {
          host: "viewApply",
          args: {
            comp_id: eff.comp_id,
            open: eff.open,
            time: eff.time,
            select: eff.select,
            viewer_options: eff.viewer_options,
            focus: eff.focus,
            restore: eff.restore,
            viewer_type: eff.viewer_type,
          },
        },
        check: (after, w) => viewMismatches(eff, after, w),
        present: (before, after, w) => {
          const b = asState(before);
          const a = asState(after);
          const out: Record<string, unknown> = {
            comp_id: w.comp_id,
            opened: w.opened,
            time: w.time,
            selected: { layers: w.layers, properties: w.properties, keys: w.keys, items: w.items, deselect_others: w.deselect_others },
            viewer_options: w.options_applied,
            options_target: w.options_target ?? null,
            skipped: w.skipped,
            warnings: w.warnings,
            changed: w.changed,
            previous_state: before,
            state: after,
            dirty_before: b?.dirty ?? null,
            dirty_after: a?.dirty ?? null,
          };
          if (w.no_op === true) out.no_op = true;
          if (w.focused === true) out.focused = true;
          if (a && a.missing.length) out.missing = a.missing;
          return out;
        },
      });
    },
  },
];
