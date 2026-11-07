import { z } from "zod";
import { BUSY_REFUSE_AFTER_MS, describeBusy, describePopupBlock, type AeBusyReport, type BusySources } from "../ae-activity.js";
import { BridgeError } from "../host.js";
import { renderGate } from "../render-gate.js";
import { resourcesForStatus } from "../system-resources.js";
import {
  AGENT_SAFETY_GUIDANCE,
  LayerSelectorSchema,
  type ToolContext,
  type ToolDefinition,
} from "./common.js";

export const AeStatusSchema = z.object({
  detail: z
    .boolean()
    .optional()
    .describe(
      "Also read what the user is working with and the environment, under `detail`: the active item of any kind, the Project panel selection, the active comp's time and frame, the selected properties (each with a path ae_set_property accepts, and its selected keys), the viewer, tool, build, UI language, GPU, OS, project revision and whether rendering is disabled. Default false: the reply is then unchanged."
    ),
});

export const AeGetProjectSchema = z.object({
  folder_id: z
    .number()
    .int()
    .optional()
    .describe("Optional folder item ID to start traversal from (defaults to root)."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum folder traversal depth. Default 3 for the tree; 20 (every level) for a filtered, sorted or paged list."),
  type: z
    .enum(["comp", "footage", "solid", "folder", "placeholder"])
    .optional()
    .describe("Only items of this kind (a flat, paged list). Footage excludes solids and placeholders."),
  name_contains: z.string().min(1).optional().describe("Only items whose name contains this (case-insensitive)."),
  missing_only: z.boolean().optional().describe("Only footage whose file is missing (placeholders are not included; use type placeholder)."),
  sort: z.enum(["tree", "name", "id"]).optional().describe("Order of a filtered or paged list. Default tree (the folder walk)."),
  offset: z.number().int().min(0).optional().describe("Skip this many matches (paging; see next_offset)."),
  limit: z.number().int().min(1).max(500).optional().describe("At most this many items (default and maximum 500)."),
});

const PagingFields = {
  offset: z.number().int().min(0).optional().describe("Skip this many layers (paging; see next_offset)."),
  limit: z.number().int().min(1).max(500).optional().describe("At most this many layers (default and maximum 500)."),
};

export const AeGetCompSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID to inspect."),
  name_contains: z.string().min(1).optional().describe("Only layers whose name contains this (case-insensitive)."),
  ...PagingFields,
});

export const AeGetLayerPropsSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID containing the layer."),
  layer: LayerSelectorSchema,
  path: z
    .array(z.union([z.string(), z.number().int().min(1)]))
    .optional()
    .describe(
      "Optional property group path (e.g. ['ADBE Transform Group', 'ADBE Opacity'] or ['Transform', 'Opacity'])."
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .optional()
    .describe("Depth of property tree traversal (default: 2)."),
  meta: z
    .boolean()
    .optional()
    .describe(
      "Add `meta` to every property: value_type, units, min and max, spatial, can_vary, can_expression, is_modified, separation (is_leader, dimensions_separated, is_follower, followers), and on AE 26 the dropdown items and value_text. Also gives Shape and MarkerValue values as data, and the full TextDocument (every attribute, with `mixed` listing the ones that read as mixed). Default false: payloads stay small."
    ),
  shape_values: z
    .boolean()
    .optional()
    .describe(
      "Give mask/shape path values (vertices, inTangents, outTangents, closed; at most 500 vertices, with the feather point count) and marker values (comment, duration, chapter, url, frameTarget, cuePointName, label, protectedRegion, params) as data instead of '[Shape]' / '[MarkerValue]'. Default false."
    ),
});

/**
 * ae_status answers within STATUS_DEADLINE_MS in all, on every path (popup read, the status eval, the detail eval
 * and the GPU read included); a slower AE is reported as busy. The status eval is not aborted: it keeps its place
 * and its own (longer) limit. Budget: the eval gets STATUS_WAIT_MS, a late answer is then explained with a popup
 * read that gets what is left minus STATUS_TAIL_MS (the health read and the reply).
 */
const STATUS_DEADLINE_MS = 10_000;
const STATUS_WAIT_MS = 6_000;
const STATUS_TAIL_MS = 700;
/** The most the `/health` read of the busy replies may take. */
const HEALTH_WAIT_MS = 500;

function busySourcesOf(ctx: ToolContext): BusySources {
  const bridge = ctx.bridge as unknown as {
    busyState?: () => { sentActive: number; abandoned: number };
    busyThreshold?: () => number;
    busyDialogReader?: () => (() => Promise<object[]>) | undefined;
  };
  return {
    serviceInfo: ctx.serviceInfo,
    queue: ctx.queue,
    busyState: typeof bridge.busyState === "function" ? () => bridge.busyState!() : undefined,
    thresholdMs: typeof bridge.busyThreshold === "function" ? bridge.busyThreshold() : undefined,
    readDialogs: typeof bridge.busyDialogReader === "function" ? bridge.busyDialogReader() : undefined,
  };
}

/** How long the service's eval in flight has run, or null. */
function serviceRunningMs(ctx: ToolContext): number | null {
  try {
    const f = ctx.serviceInfo?.().inFlight as { runningMs?: unknown } | null | undefined;
    return f && typeof f.runningMs === "number" ? f.runningMs : null;
  } catch {
    return null;
  }
}

/** The promise's value, or "late" when it is not there after `ms`. The promise is left running; its rejection is swallowed. */
async function within<T>(ms: number, p: Promise<T>): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  try {
    return await Promise.race([
      p,
      new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The service's instance block (which AE owns it), when the service says. */
function readInstance(ctx: ToolContext): unknown {
  try {
    return ctx.serviceInfo?.().instance;
  } catch {
    return undefined;
  }
}

function fallbackBusy(cause: unknown): AeBusyReport {
  const why = cause instanceof Error ? cause.message : String(cause);
  return {
    busy: true,
    cause: "unknown",
    running_ms: null,
    in_flight: null,
    waiting_in_service: 0,
    abandoned_ours: 0,
    server_queue: { holder: null, depth: 0 },
    render_gate: null,
    dialogs: [],
    message: `After Effects did not answer: ${why}`,
    next_steps: ["Ask the user to look at After Effects (a popup, a script or a render may hold it).", "Call ae_status again in about 30 s."],
    check_again_in_s: 30,
  };
}

export const readTools: ToolDefinition<any>[] = [
  {
    name: "ae_status",
    description:
      "Read panel health (/health), AE version, current project path (or '<unsaved>'), dirty flag, active comp {id, name}, selected layers, and the server quarantine list. " +
      "With `detail: true` it adds `detail`: the active item of any kind (a footage or folder too), the Project panel selection, the active comp's time and frame and work area, the selected properties as {layer_id, layer_index, path, name, match_name, is_group, selected_keys} (path is the format ae_set_property takes), the viewer, tool, build, UI language, GPU, OS and project revision, plus warnings (rendering disabled makes ae_snapshot_frame, ae_contact_sheet and ae_ui_screenshot show stale or blank frames) and `missing` (members this AE version does not have). detail.resources: GPU memory use and other renderers running; tell the user if it carries warnings. Selection can change between this read and a write: act on explicit ids and indexes with `expect`. " +
      "If AE is busy this answers at once with ae_answered false and `busy` (why, popups, how long) instead of waiting. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStatusSchema,
    handler: async (args, ctx) => {
      const t0 = Date.now();
      const deadline = t0 + STATUS_DEADLINE_MS;
      const left = (): number => deadline - Date.now();
      /** The popup read budget for a busy reply made now: what is left of the deadline, less the tail. */
      const dialogBudget = (): number => Math.max(300, left() - STATUS_TAIL_MS);
      const sources = busySourcesOf(ctx);
      const health = async (): Promise<Record<string, unknown> | null> => {
        if (ctx.bridge.health) {
          const h = await within(Math.max(100, Math.min(HEALTH_WAIT_MS, left() - 150)), ctx.bridge.health().catch(() => null));
          return h === "late" ? null : (h as Record<string, unknown> | null);
        }
        const instance = readInstance(ctx);
        return { ok: true, transport: "panel" as const, ...(instance ? { instance } : {}) };
      };
      // The GPU read needs neither the queue nor AE: start it now, so it runs beside the evals, and bound it at the end.
      const resourcesRead: Promise<unknown> | null = args.detail === true ? resourcesForStatus().catch(() => null) : null;
      // After Effects cannot answer (a render, a popup, a long script, an earlier call still running in it):
      // say why at once, send nothing to it.
      const rendering = renderGate.active();
      const busy = await describeBusy(sources, { withDialogs: true, dialogBudgetMs: dialogBudget() });
      if (busy) {
        return {
          health: await health(),
          ae_answered: false,
          ...(rendering
            ? { rendering: { job_id: rendering.job_id, op_id: rendering.op_id, started_at: rendering.started_at, state: rendering.state } }
            : {}),
          busy,
          message: busy.message,
          quarantine: ctx.quarantine.list(),
        };
      }
      // The service has had an eval of ours in flight for the threshold. With our tool holding the lease (a
      // popup or a long script inside it) the status eval would only wait behind it: say so now. Without a
      // lease (the asset watcher, a footage read) only an open popup says so; a long operation with no popup
      // is waited for like any other.
      const threshold = sources.thresholdMs ?? BUSY_REFUSE_AFTER_MS;
      const running = serviceRunningMs(ctx);
      if (running !== null && running >= threshold) {
        const report = ctx.queue?.inFlight
          ? await describeBusy(sources, { withDialogs: true, force: true, dialogBudgetMs: dialogBudget() })
          : await describePopupBlock(sources, { dialogBudgetMs: dialogBudget() });
        if (report) {
          return {
            health: await health(),
            ae_answered: false,
            busy: report,
            message: report.message,
            quarantine: ctx.quarantine.list(),
          };
        }
      }
      // AE looked free, but the call below can still be refused or time out (it may have become busy meanwhile).
      const busyShape = async (cause: unknown, requestSent: boolean) => {
        const report: AeBusyReport =
          (await describeBusy(sources, { withDialogs: true, force: true, requestSent, dialogBudgetMs: dialogBudget() })) ?? fallbackBusy(cause);
        return {
          health: await health(),
          ae_answered: false,
          busy: report,
          message: report.message,
          quarantine: ctx.quarantine.list(),
        };
      };
      let hostStatus: { result: Record<string, unknown> };
      // What the earlier steps spent (a popup read) comes off the eval's wait, so the whole stays inside the deadline.
      const evalWait = Math.max(300, Math.min(STATUS_WAIT_MS, left() - STATUS_TAIL_MS - 300));
      try {
        const got = await within(
          evalWait,
          ctx.bridge.callHost<Record<string, unknown>>("status", {}, { label: "ae_status", mutates: false, toolName: "ae_status" })
        );
        // Sent only when the status eval holds the lease (or there is no lease); queued behind another holder it sent nothing.
        if (got === "late") return busyShape(new Error(`AE did not answer within ${Math.round(evalWait / 100) / 10} s`), !(ctx.queue?.inFlight && ctx.queue.inFlight !== "ae_status"));
        hostStatus = got;
      } catch (err) {
        if (err instanceof BridgeError && (err.kind === "queued" || err.kind === "timeout")) return busyShape(err, err.kind === "timeout");
        throw err;
      }
      let detail: Record<string, unknown> | undefined;
      if (args.detail === true) {
        // A second, separate read; the base reply must not depend on it.
        try {
          // What is left of the deadline, less the tail and the time the GPU read may still need.
          const wait = Math.max(0, left() - STATUS_TAIL_MS - 1500);
          const d =
            wait < 300
              ? "late"
              : await within(
                  wait,
                  ctx.bridge.callHost<Record<string, unknown>>("statusDetail", {}, { label: "ae_status (detail)", mutates: false, toolName: "ae_status" })
                );
          detail = d === "late" ? { error: "AE did not answer the detail read in time (ae_status answers within 10 s in all)" } : (d.result ?? {});
          // GPU memory and other renderers: reads no AE, uses no queue, never throws; started above, bounded here.
          const res = await within(Math.max(200, left() - STATUS_TAIL_MS), resourcesRead as Promise<unknown>);
          detail.resources = res === "late" || res === null ? { supported: false, error: "the GPU read did not finish in time" } : res;
        } catch (err) {
          detail = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        health: await health(),
        ...(hostStatus.result ?? {}),
        quarantine: ctx.quarantine.list(),
        ...(detail ? { detail } : {}),
      };
    },
  },
  {
    name: "ae_get_project",
    description:
      "Read the project item tree: id, name, typeName, parent folder id; compositions include width, height, fps, duration; footage items include file path and missing: true when the file is gone (a placeholder has placeholder: true instead). " +
      "For big projects, filter by kind, name or missing footage, sort, and page with offset/limit: the result then has total and next_offset (and walks every folder level unless depth is given). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetProjectSchema,
    handler: async (args, ctx) => {
      const sort = args.sort === "tree" ? undefined : args.sort;
      // Same test as the host: any filter, sort or paging gives the flat list, which walks every level.
      const flat = !!(args.type || args.name_contains || args.missing_only || sort || args.offset !== undefined || args.limit !== undefined);
      const res = await ctx.bridge.callHost(
        "getProject",
        {
          folder_id: args.folder_id,
          depth: flat ? args.depth ?? 20 : args.depth ?? 3,
          type: args.type,
          name_contains: args.name_contains,
          missing_only: args.missing_only,
          sort,
          offset: args.offset,
          limit: args.limit,
        },
        {
          label: "ae_get_project",
          mutates: false,
          toolName: "ae_get_project",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_get_comp",
    description:
      "Read composition settings, work area, and layers (index, name, id, type, in/out, parent, enabled, solo, locked, label, 3D, blending mode, track matte). " +
      "Comps with more than 500 layers page with offset/limit (next_offset says where to continue); name_contains filters the layers. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetCompSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "getComp",
        { comp_id: args.comp_id, name_contains: args.name_contains, offset: args.offset, limit: args.limit },
        {
          label: `ae_get_comp(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_comp",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_get_layer_props",
    description:
      "Read a layer's property tree with matchName, name, value (serialised), numKeys, expression, and expressionEnabled. " +
      "`meta: true` adds what each property accepts (value type, units, min/max, spatial, separation, dropdown items), full text documents and path/marker values; `shape_values: true` gives just the path and marker values. " +
      "Mask and shape path keys are written with ae_set_property as { vertices, inTangents?, outTangents?, closed? } (ae_path_write keeps feather points and can change the vertex count). " +
      "Text path options live under 'ADBE Text Path Options' (Path is a mask-index dropdown, 0 = none, the mask must be on the same text layer; also Reverse Path, Perpendicular To Path, Force Alignment, First Margin, Last Margin): check the exact child match names with meta before writing. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetLayerPropsSchema,
    handler: async (args, ctx) => {
      const depth = args.depth ?? 2;
      const res = await ctx.bridge.callHost(
        "getLayerProps",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          path: args.path,
          depth,
          meta: args.meta,
          shape_values: args.shape_values,
        },
        {
          label: `ae_get_layer_props(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_layer_props",
        }
      );
      return res.result;
    },
  },
];
