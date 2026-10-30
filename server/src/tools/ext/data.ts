/**
 * server/src/tools/ext/data.ts
 *
 * ae_build_from_data: data-driven builds. A template comp is copied once per
 * row of CSV or JSON data (or set in place from one row), with text, values,
 * colours and footage taken from the row's columns. For localisation (one row
 * per language), versioned lower thirds, and charts whose bars or sliders are
 * driven by numbers.
 *
 * The data is parsed and every cell checked on the server before AE is
 * touched; the write is one undo group; the mapped values are read back in a
 * separate evalScript, with text that now runs off the frame flagged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, compareValues, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";

// ---------- data ----------

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

/** RFC 4180 CSV: quoted fields, "" inside quotes, CRLF or LF, first row is the header. */
export function parseCsv(text: string): Row[] {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let quotedInRecord = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A lone empty field is a blank line, unless it was written as "" (an empty cell).
    if (!(record.length === 1 && record[0] === "" && !quotedInRecord)) records.push(record);
    record = [];
    quotedInRecord = false;
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      quotedInRecord = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      endRecord();
      if (c === "\r" && src[i + 1] === "\n") i++;
    } else {
      field += c;
    }
    i++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || record.length > 0) endRecord();
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim());
  return records.slice(1).map((r) => {
    const row: Row = {};
    header.forEach((h, idx) => {
      row[h] = r[idx] ?? "";
    });
    return row;
  });
}

export function parseDataFile(filePath: string): Row[] {
  const text = fs.readFileSync(filePath, "utf8");
  if (/\.csv$/i.test(filePath)) return parseCsv(text);
  const parsed = JSON.parse(text.replace(/^﻿/, "")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    throw new Error("JSON data must be an array of objects, or { rows: [...] }");
  }
  return rows as Row[];
}

// ---------- cell values ----------

export type Target = "text" | "value" | "color" | "footage";

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function toNumber(s: string): number | undefined {
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return undefined;
  return Number(t.replace(/%$/, ""));
}

/** A cell as the value AE needs for `target`, or an error message. */
export function cellValue(target: Target, cell: unknown): { value: unknown } | { error: string } {
  if (target === "text") return { value: String(cell) };
  if (target === "footage") {
    const p = String(cell).trim();
    if (!path.isAbsolute(p)) return { error: `"${p}" is not an absolute path` };
    if (!fs.existsSync(p)) return { error: `file not found: ${p}` };
    return { value: p.replace(/\\/g, "/") };
  }
  if (target === "color") {
    if (Array.isArray(cell) && cell.length >= 3 && cell.every((n) => typeof n === "number")) {
      return { value: cell.length === 3 ? [...cell, 1] : cell.slice(0, 4) };
    }
    const m = /^#?([0-9a-f]{6})$/i.exec(String(cell).trim());
    if (!m) return { error: `"${String(cell)}" is not a #rrggbb colour` };
    const n = parseInt(m[1], 16);
    return { value: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1] };
  }
  if (typeof cell === "number") return { value: cell };
  if (typeof cell === "boolean") return { value: cell ? 1 : 0 };
  if (Array.isArray(cell) && cell.every((n) => typeof n === "number")) return { value: cell };
  const s = String(cell).trim().replace(/^\[|\]$/g, "");
  if (/^(true|false)$/i.test(s)) return { value: /^true$/i.test(s) ? 1 : 0 };
  const parts = s.split(/[,;]\s*|\s+/).filter((x) => x !== "");
  const nums = parts.map(toNumber);
  if (nums.length === 0 || nums.some((n) => n === undefined)) return { error: `"${String(cell)}" is not a number or a list of numbers` };
  return { value: nums.length === 1 ? nums[0] : nums };
}

/** Fills {{column}}, {{#}} (1-based row number) and {{template}} in a comp name pattern. */
export function fillName(pattern: string, row: Row, rowNumber: number, templateName: string): string {
  // One pass, so text that came from a cell or the template name is never read as a placeholder.
  const name = pattern
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key: string) => {
      if (key === "#") return String(rowNumber);
      if (key === "template") return templateName;
      const v = row[key];
      return v === undefined || v === null ? "" : String(v);
    })
    .trim();
  return name === "" ? `${templateName} - ${rowNumber}` : name;
}

// ---------- schema ----------

export const DataMappingSchema = z
  .object({
    column: z.string().min(1).describe("Column (CSV header or JSON key) the value comes from."),
    layer: LayerSelectorSchema.describe("Layer in the template comp (by name is usual; names must be unique)."),
    target: z
      .enum(["text", "value", "color", "footage"])
      .describe(
        "text: the layer's Source Text (style kept; every text key if keyed). value: a number or list (\"100, 50\") on `path`. color: #rrggbb on `path`. footage: an absolute file path, imported once and swapped in with replaceSource."
      ),
    path: z
      .array(z.string().min(1))
      .optional()
      .describe("For value and color: property path by match name or name, e.g. ['ADBE Effect Parade', 'Bar Height', 'ADBE Slider Control-0001'] or ['ADBE Transform Group', 'ADBE Scale']."),
    keyframe: z
      .union([z.enum(["last", "first", "all"]), z.number().int().positive()])
      .optional()
      .describe("For animated properties: which key takes the value. Default 'last' (a bar that grows to the data value)."),
  })
  .refine((m) => m.target === "text" || m.target === "footage" || (m.path !== undefined && m.path.length > 0), {
    message: "value and color mappings need a path",
  });

export const AeBuildFromDataSchema = z
  .object({
    template_comp_id: z.number().int().describe("The comp to copy for each row."),
    rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(200).optional().describe("The data, one object per row."),
    data_path: z.string().min(1).optional().describe("Or an absolute path to a .csv (header row first) or .json (array of objects) file."),
    mapping: z.array(DataMappingSchema).min(1).max(50),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Name pattern for each copy: {{column}}, {{#}} (row number), {{template}}. Default '{{template}} - {{#}}'."),
    folder: z.string().min(1).max(200).optional().describe("Project folder for the copies (and imported footage). Default '<template> (data)'."),
    in_place: z.boolean().optional().describe("Set the template comp itself from a single row instead of copying it, e.g. to update a chart."),
    dry_run: z.boolean().optional().describe("Check the data and mapping against the template and report what would be built, without writing."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.rows === undefined) !== (v.data_path === undefined), { message: "Give either rows or data_path." });

type Args = z.infer<typeof AeBuildFromDataSchema>;

interface PreparedRow {
  row: number;
  name: string;
  values: unknown[];
}

export function prepareRows(
  rows: Row[],
  mapping: Args["mapping"],
  namePattern: string,
  templateName: string
): { prepared: PreparedRow[]; problems: string[]; skipped: string[] } {
  const problems: string[] = [];
  const skipped: string[] = [];
  const columns = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const m of mapping) {
    if (rows.length > 0 && !columns.has(m.column)) problems.push(`column "${m.column}" is not in the data (columns: ${[...columns].join(", ")})`);
  }
  const prepared = rows.map((r, i) => {
    const values = mapping.map((m) => {
      const cell = r[m.column];
      if (isBlank(cell)) {
        if (columns.has(m.column)) skipped.push(`row ${i + 1}: "${m.column}" is empty, so the template's value stays`);
        return null;
      }
      const v = cellValue(m.target, cell);
      if ("error" in v) {
        problems.push(`row ${i + 1}, "${m.column}": ${v.error}`);
        return null;
      }
      return v.value;
    });
    return { row: i + 1, name: fillName(namePattern, r, i + 1, templateName), values };
  });
  return { prepared, problems, skipped };
}

interface ReadValue {
  text?: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  footage?: string | null;
  value?: unknown;
  /** Every key the write went to, with each key's value, when the property is animated. */
  keys?: number[];
  key_values?: unknown[];
}

interface ReadComp {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  values: ReadValue[];
}

function normText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function checkBuild(
  prepared: PreparedRow[],
  mapping: Args["mapping"],
  read: ReadComp[]
): { mismatches: ReceiptMismatch[]; off_frame: Array<{ comp: string; layer: string; bounds: ReadValue["bounds"] }> } {
  const mismatches: ReceiptMismatch[] = [];
  const offFrame: Array<{ comp: string; layer: string; bounds: ReadValue["bounds"] }> = [];
  read.forEach((c, ci) => {
    const row = prepared[ci];
    mapping.forEach((m, mi) => {
      const expected = row?.values[mi];
      const got = c.values[mi] ?? {};
      const where = `${c.name}.${m.column}`;
      // Cells left empty keep the template's value, so there is nothing to check or flag for them.
      if (expected === null || expected === undefined) return;
      if (m.target === "text") {
        if (got.bounds) {
          const b = got.bounds;
          if (b.left < -0.5 || b.top < -0.5 || b.right > c.width + 0.5 || b.bottom > c.height + 0.5) {
            offFrame.push({ comp: c.name, layer: m.column, bounds: b });
          }
        }
        if (normText(String(got.text ?? "")) !== normText(String(expected))) {
          mismatches.push({ path: where, expected, actual: got.text, message: `Text of ${where} reads back differently` });
        }
      } else if (m.target === "footage") {
        const a = String(got.footage ?? "").replace(/\\/g, "/").toLowerCase();
        if (a !== String(expected).toLowerCase()) {
          mismatches.push({ path: where, expected, actual: got.footage, message: `Footage of ${where} reads back differently` });
        }
      } else {
        // Every key the write went to is checked, not just the first.
        const values = got.key_values && got.key_values.length > 0 ? got.key_values : [got.value];
        values.forEach((gv, ki) => {
          // AE keeps Scale and Position three-dimensional on 2D layers: [100, 75] reads back as [100, 75, 100].
          const actual = Array.isArray(expected) && Array.isArray(gv) && gv.length > expected.length ? gv.slice(0, expected.length) : gv;
          const label = values.length > 1 ? `${where}[key ${got.keys?.[ki] ?? ki + 1}]` : where;
          compareValues(expected, actual, label, mismatches);
        });
      }
    });
  });
  return { mismatches, off_frame: offFrame };
}

/** What the template offers for one mapping, from the host's inspectDataMapping. */
export interface MappingInspection {
  kind?: "text" | "footage" | "property";
  /** Numbers the property takes: 1, 2, 3, or 4 for a colour; 0 when it takes none (a shape path, a group...). */
  dims?: number;
  is_color?: boolean;
  num_keys?: number;
  can_take_footage?: boolean;
  error?: string;
}

/**
 * Checks the prepared cells against what the template's properties take, so a
 * list on a slider or a colour on a scale is refused before AE is touched.
 */
export function validateAgainstTemplate(
  rows: Row[],
  prepared: PreparedRow[],
  mapping: Args["mapping"],
  inspected: Array<MappingInspection | undefined>
): string[] {
  const problems: string[] = [];
  mapping.forEach((m, mi) => {
    const insp = inspected[mi];
    if (!insp) return;
    const label = `mapping ${mi + 1} ("${m.column}")`;
    if (insp.error) {
      problems.push(`${label}: ${insp.error}`);
      return;
    }
    if (!prepared.some((p) => p.values[mi] !== null && p.values[mi] !== undefined)) return;
    if (m.target === "footage") {
      if (!insp.can_take_footage) problems.push(`${label}: layer "${m.layer.name ?? m.layer.index ?? m.layer.id}" can't take footage (it needs a footage, solid or precomp layer)`);
      return;
    }
    if (m.target === "text") return;
    const where = (m.path ?? []).join(" > ");
    const dims = insp.dims ?? 0;
    if (m.target === "color" && !insp.is_color) {
      problems.push(`${label}: ${where} is not a colour property`);
      return;
    }
    if (dims === 0) {
      problems.push(`${label}: ${where} doesn't take numbers`);
      return;
    }
    if (typeof m.keyframe === "number" && (insp.num_keys ?? 0) > 0 && m.keyframe > (insp.num_keys ?? 0)) {
      problems.push(`${label}: keyframe ${m.keyframe} is past the last of ${insp.num_keys} keys on ${where}`);
    }
    if (m.target === "color") return;
    prepared.forEach((p) => {
      const v = p.values[mi];
      if (v === null || v === undefined) return;
      const raw = String(rows[p.row - 1]?.[m.column]);
      const at = `row ${p.row}, "${m.column}"`;
      if (Array.isArray(v)) {
        if (dims === 1) {
          problems.push(`${at}: "${raw}" reads as a list of ${v.length} numbers; for a decimal use a point, 1.5`);
        } else if (v.length !== dims && !(dims === 3 && v.length === 2)) {
          problems.push(`${at}: "${raw}" has ${v.length} numbers, but ${where} takes ${dims}`);
        }
      } else if (dims > 1) {
        problems.push(`${at}: "${raw}" is a single number, but ${where} takes ${dims} (e.g. "100, 75")`);
      }
    });
  });
  return problems;
}

async function inspectMapping(ctx: ToolContext, compId: number, mapping: Array<Record<string, unknown>>) {
  const res = await ctx.bridge.evalRaw<{ mappings: MappingInspection[] }>({
    id: `${ctx.bridge.newOpId()}_data_inspect`,
    script: buildJsxCall("inspectDataMapping", { template_comp_id: compId, mapping }),
    label: "ae_build_from_data (inspect mapping)",
    mutates: false,
    toolName: "ae_build_from_data",
  });
  return res.result?.mappings ?? [];
}

async function templateInfo(ctx: ToolContext, compId: number) {
  const res = await ctx.bridge.evalRaw<{ name: string }>({
    id: `${ctx.bridge.newOpId()}_data_template`,
    script: buildJsxCall("getComp", { comp_id: compId }),
    label: "ae_build_from_data (template)",
    mutates: false,
    toolName: "ae_build_from_data",
  });
  return res.result;
}

// ---------- tool ----------

export const dataTools: ToolDefinition<any>[] = [
  {
    name: "ae_build_from_data",
    description:
      "Build comps from data (CSV or JSON): one copy of a template comp per row, named from the row, with text, numbers, colours and footage set from its columns. For localisation (a row per language), versions of a lower third or end card, and charts whose bars, sliders or labels are driven by numbers. " +
      "`in_place` sets the template itself from one row (to update a chart). Animated properties get the value on their last key by default (a bar that grows to the number); `keyframe` picks another. Empty cells keep the template's value. " +
      "Every cell is checked before AE is touched (bad numbers, colours, missing files are refused with the row); `dry_run` reports the plan without writing. The build is one undo group guarded by `expect`, with an auto checkpoint; the values are read back in a separate evalScript, and text that now runs off the frame is listed in `off_frame`. Up to 200 rows a call. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeBuildFromDataSchema,
    handler: async (args: Args, ctx) => {
      let rows: Row[];
      if (args.data_path) {
        if (!path.isAbsolute(args.data_path) || !fs.existsSync(args.data_path)) {
          return { ok: false, error: "bad_data", message: `Not an existing absolute path: ${args.data_path}` };
        }
        try {
          rows = parseDataFile(args.data_path);
        } catch (err) {
          return { ok: false, error: "bad_data", message: err instanceof Error ? err.message : String(err) };
        }
        if (rows.length > 200) {
          return { ok: false, error: "too_many_rows", message: `${rows.length} rows; build up to 200 a call (split the file).` };
        }
      } else {
        rows = args.rows!;
      }
      if (rows.length === 0) return { ok: false, error: "bad_data", message: "The data has no rows." };
      if (args.in_place && rows.length !== 1) {
        return { ok: false, error: "bad_args", message: "in_place sets the template from exactly one row." };
      }

      const template = await templateInfo(ctx, args.template_comp_id);
      const templateName = template?.name ?? `comp ${args.template_comp_id}`;
      const { prepared, problems, skipped } = prepareRows(rows, args.mapping, args.name ?? "{{template}} - {{#}}", templateName);
      const mapping = args.mapping.map((m) => ({ layer: m.layer, target: m.target, path: m.path, keyframe: m.keyframe }));
      // What the template's properties take (read-only), so a wrong shape of cell is refused before AE is written.
      const inspected = await inspectMapping(ctx, args.template_comp_id, mapping);
      problems.push(...validateAgainstTemplate(rows, prepared, args.mapping, inspected));
      if (problems.length > 0) {
        return { ok: false, error: "bad_data", message: "Some cells can't be used; nothing was built.", problems };
      }
      const folder = args.in_place ? undefined : args.folder ?? `${templateName} (data)`;
      if (args.dry_run) {
        return {
          ok: true,
          dry_run: true,
          template: templateName,
          folder,
          comps: prepared.map((p) => ({ row: p.row, name: args.in_place ? templateName : p.name, values: p.values })),
          skipped,
        };
      }

      ctx.quarantine.assertClear();
      const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.template_comp_id };
      const opId = ctx.bridge.newOpId();
      const projectSnapshot = (suffix: string) =>
        ctx.bridge.evalRaw({
          id: `${opId}_${suffix}`,
          script: buildJsxCall("snapshotForReceipt", {}),
          label: `ae_build_from_data (${suffix} snapshot)`,
          mutates: false,
          toolName: "ae_build_from_data",
        });
      try {
        return await ctx.queue.run("ae_build_from_data", async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_build_from_data");
          const before = await projectSnapshot("before");
          const write = await ctx.bridge.evalRaw<{
            folder_id: number | null;
            mapping: Array<{ index: number; layer_name: string; target: string; path?: string[]; keyframe?: unknown }>;
            comps: Array<{ comp_id: number; name: string; row: number; notes: string[] }>;
          }>({
            id: opId,
            script: buildJsxCall("buildFromData", {
              expect,
              template_comp_id: args.template_comp_id,
              mapping,
              rows: prepared.map((p) => ({ row: p.row, name: p.name, values: p.values })),
              folder_name: folder,
              in_place: args.in_place === true,
            }),
            label: `ae_build_from_data(${prepared.length})`,
            mutates: true,
            toolName: "ae_build_from_data",
          });
          const built = write.result;
          // Separate evalScripts for the read-back.
          const after = await projectSnapshot("after");
          const read = await ctx.bridge.evalRaw<{ comps: ReadComp[] }>({
            id: `${opId}_read`,
            script: buildJsxCall("readDataBuild", { comp_ids: built.comps.map((c) => c.comp_id), mapping: built.mapping }),
            label: "ae_build_from_data (read back)",
            mutates: false,
            toolName: "ae_build_from_data",
          });
          const { mismatches, off_frame } = checkBuild(prepared, args.mapping, read.result.comps);
          return {
            ok: true,
            op_id: opId,
            applied: true as const,
            folder_id: built.folder_id,
            comps: built.comps,
            skipped,
            off_frame,
            checkpoint,
            receipt: buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches }),
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    },
  },
];
