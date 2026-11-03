/**
 * server/src/tools/ext/production.ts
 *
 * Production tools:
 * - ae_get_essential_graphics / ae_set_essential_graphics: a comp's
 *   Essential Graphics template (controllers, name) and a precomp layer's
 *   overrides
 * - ae_render_templates: render-settings and output-module template names
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
      .enum(["add", "rename", "template_name", "set_override"])
      .describe("add: a property to this comp's template; rename: a controller; template_name: the template's name; set_override: a precomp layer's Essential Property."),
    layer: LayerSelectorSchema.optional().describe("add: the layer holding the property; set_override: the precomp layer."),
    path: PathSchema.optional().describe("add: the property's path from the layer."),
    index: z.number().int().positive().optional().describe("rename: the controller's 1-based index."),
    name: z.string().min(1).max(200).optional().describe("add: the controller's name (optional); rename and template_name: the new name; set_override: the Essential Property's name."),
    value: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]).optional().describe("set_override: the value (text for a source text property)."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (v.action === "add") need(v.layer !== undefined && v.path !== undefined, "add needs layer and path.");
    if (v.action === "rename") need(v.index !== undefined && v.name !== undefined, "rename needs index and name.");
    if (v.action === "template_name") need(v.name !== undefined, "template_name needs name.");
    if (v.action === "set_override") need(v.layer !== undefined && v.name !== undefined && v.value !== undefined, "set_override needs layer, name and value.");
  });

interface EgpState {
  template_name: string | null;
  controllers: Array<{ index: number; name: string | null }>;
  overrides?: Array<{ index: number; name: string; value?: unknown }>;
}

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
  } else {
    const o = after.overrides?.find((x) => x.name === args.name);
    const actual = typeof args.value === "string" && o?.value && typeof o.value === "object" ? (o.value as { text?: string }).text : o?.value;
    if (!o) m.push({ path: `overrides.${args.name}`, expected: args.value, actual: undefined, message: "Essential Property not in the read-back" });
    else compareValues(args.value, Array.isArray(args.value) && Array.isArray(actual) ? actual.slice(0, args.value.length) : actual, `overrides.${args.name}`, m);
  }
  return m;
}

// ---------- render templates ----------

export const AeRenderTemplatesSchema = z.object({
  allow_temp: z
    .boolean()
    .optional()
    .describe("With an empty render queue, add a temporary item to read the names from and remove it again. That marks the project changed (save before aerender). Needs expect."),
  comp_id: z.number().int().optional().describe("The comp for the temporary item. Default the first comp."),
  expect: ExpectSchema.optional(),
});

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
    value: z.unknown().optional().describe("A static value (or the value at the comp's current time on an animated property)."),
    keyframes: z.array(KeyframeItemSchema).max(100).optional(),
    expression: z.string().max(20000).optional(),
  })
  .refine((o) => o.value !== undefined || (o.keyframes?.length ?? 0) > 0 || o.expression !== undefined, { message: "Each op sets a value, keyframes or an expression." });

export const AeBatchSetSchema = z.object({
  comp_id: z.number().int(),
  ops: z.array(BatchOpSchema).min(1).max(5000),
  chunk_size: z.number().int().min(1).max(500).optional().describe("Ops per undo group (default and maximum 500)."),
  expect: ExpectSchema,
});

type BatchOp = z.infer<typeof BatchOpSchema>;

interface BatchRead {
  time: number;
  results: Array<{ op: number; numKeys?: number; value?: unknown; keys?: Array<{ time: number; value: unknown; missing?: boolean }>; expression?: string; error?: string }>;
}

const readOps = (ops: BatchOp[]) => ops.map((o) => ({ layer: o.layer, path: o.path, ...(o.keyframes?.length ? { times: o.keyframes.map((k) => k.time) } : {}) }));

function trimTo(want: unknown, got: unknown): unknown {
  if (Array.isArray(want) && Array.isArray(got)) return got.slice(0, want.length);
  if (typeof want === "string" && got && typeof got === "object" && "text" in (got as object)) return (got as { text: string }).text;
  return got;
}

export function batchMismatches(ops: BatchOp[], afterRaw: unknown, offset: number): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as BatchRead | null;
  if (!after) return m;
  ops.forEach((op, i) => {
    const r = after.results[i];
    const label = `ops[${offset + i + 1}]`;
    if (!r || r.error) {
      m.push({ path: label, expected: "read-back", actual: r?.error, message: `Op ${offset + i + 1} could not be read back` });
      return;
    }
    if (op.expression !== undefined) expectThat(m, r.expression === op.expression, `${label}.expression`, op.expression, r.expression, "Expression differs");
    if (op.value !== undefined && !op.keyframes?.length && (r.numKeys ?? 0) === 0 && op.expression === undefined) {
      compareValues(op.value, trimTo(op.value, r.value), `${label}.value`, m);
    }
    for (const k of op.keyframes ?? []) {
      const got = r.keys?.find((x) => Math.abs(x.time - k.time) < 0.0005);
      if (!got || got.missing) m.push({ path: `${label}.keys@${k.time}`, expected: k.value, actual: undefined, message: `No key at ${k.time}s` });
      else compareValues(k.value, trimTo(k.value, got.value), `${label}.keys@${k.time}`, m);
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
      "Read a comp's Essential Graphics template: its name and controllers (index and name). With a precomp layer, also that layer's overrides (Essential Properties) and their values. Read-only.",
    schema: AeGetEssentialGraphicsSchema,
    handler: async (args: z.infer<typeof AeGetEssentialGraphicsSchema>, ctx) =>
      (await ctx.bridge.callHost("egpRead", { comp_id: args.comp_id, layer: args.layer }, { label: "ae_get_essential_graphics", mutates: false, toolName: "ae_get_essential_graphics" })).result,
  },
  {
    name: "ae_set_essential_graphics",
    description:
      "Change Essential Graphics in one undo group guarded by `expect`: add a layer property to the comp's template (optionally named), rename a controller, name the template, " +
      "or set an override (Essential Property) on a precomp layer of a templated comp: text as a string, numbers, colours or points as arrays. " +
      "The read-back (a separate evalScript) checks the controller count and names, the template name, or the override's value. Export the template with ae_export_mogrt. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetEssentialGraphicsSchema,
    handler: (args: z.infer<typeof AeSetEssentialGraphicsSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_set_essential_graphics",
        label: `ae_set_essential_graphics(${args.action})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "egpRead", args: { comp_id: args.comp_id, layer: args.action === "set_override" ? args.layer : undefined } }),
        write: {
          host: "egpEdit",
          args: { comp_id: args.comp_id, action: args.action, layer: args.layer, path: args.path, index: args.index, name: args.name, value: args.value, label: "Essential Graphics" },
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
      `Says whether '${DEFAULT_AUDIO_TEMPLATE}', the audio template ae_audio_analyze uses by default, is there.`,
    schema: AeRenderTemplatesSchema,
    handler: async (args: z.infer<typeof AeRenderTemplatesSchema>, ctx: ToolContext) => {
      type Templates = { source: string; render_settings: string[]; output_modules: string[]; needs_item?: boolean };
      let res: Templates;
      if (args.allow_temp) {
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
      } else {
        res = (await ctx.bridge.callHost<Templates>("renderTemplates", {}, { label: "ae_render_templates", mutates: false, toolName: "ae_render_templates" })).result;
        if (res.needs_item) {
          return { ok: false, error: "empty_queue", message: "The render queue is empty. Add an item (ae_render_queue_add), or call again with allow_temp and expect." };
        }
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
        return { ok: true, ...(args.dry_run ? { dry_run: true } : {}), checked: report.length, outdated: outdated.length, items: args.update ? outdated : report };
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
          logPath = appendVersionLog(files.project_path, entries);
        } catch {
          logPath = undefined;
        }
      }
      return { ...out, items: outdated, ...(logPath ? { log_path: logPath } : { log_path: null }) };
    },
  },
  {
    name: "ae_batch_set",
    description:
      "Set many properties at once (values, keyframes or expressions on any layers of one comp): every layer and property is found before anything is written, " +
      "then each chunk of up to 500 ops is one undo group guarded by `expect`, with a short pause between chunks so AE's UI keeps up. " +
      "The read-back (a separate evalScript per chunk) checks every value, key and expression. A failing op stops the batch and says which. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeBatchSetSchema,
    handler: async (args: z.infer<typeof AeBatchSetSchema>, ctx: ToolContext) => {
      const size = args.chunk_size ?? 500;
      const chunks: Array<Record<string, unknown>> = [];
      let done = 0;
      const mismatches: ReceiptMismatch[] = [];
      for (let start = 0; start < args.ops.length; start += size) {
        const ops = args.ops.slice(start, start + size);
        if (start > 0) await sleep(250);
        const res = (await runGuardedWrite(ctx, {
          toolName: "ae_batch_set",
          label: `ae_batch_set(${start + 1}-${start + ops.length} of ${args.ops.length})`,
          expect: args.expect,
          compId: args.comp_id,
          read: () => ({ host: "batchRead", args: { comp_id: args.comp_id, ops: readOps(ops) } }),
          write: { host: "batchSet", args: { comp_id: args.comp_id, ops, label: `Batch set ${start + 1}-${start + ops.length}` } },
          check: (_before, after, w) => (w.failed_at ? [] : batchMismatches(ops, after, start)),
          present: (_before, _after, w) => ({ written: w }),
        })) as unknown as { written: { done: number; failed_at?: number; error?: string }; receipt: { matches: boolean; mismatches: ReceiptMismatch[] }; checkpoint: unknown };
        done += res.written.done;
        mismatches.push(...res.receipt.mismatches);
        chunks.push({ ops: `${start + 1}-${start + ops.length}`, done: res.written.done, matches: res.receipt.matches, checkpoint: res.checkpoint });
        if (res.written.failed_at) {
          return {
            ok: false,
            error: "op_failed",
            failed_op: start + res.written.failed_at,
            message: `Op ${start + res.written.failed_at} failed: ${res.written.error}. Ops before it in this chunk were applied (one undo step); later chunks were not run.`,
            done,
            chunks,
          };
        }
      }
      return { ok: true, applied: true, done, chunks, matches: mismatches.length === 0, mismatches: mismatches.slice(0, 50), mismatches_truncated: mismatches.length > 50 };
    },
  },
];
