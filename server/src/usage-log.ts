import * as fs from "node:fs";
import * as path from "node:path";
import { dataDirOf, type ToolContext } from "./tools/common.js";

/**
 * A local usage log: one JSON line per tool call in `<data dir>/usage/usage-YYYY-MM.jsonl`
 * (local month). It exists to learn which tools are missing or failing. It records the tool,
 * the time, the outcome and (for two tools) a label or a search query; never any other
 * argument or result. It stays on the machine, and nothing here may throw into a tool call.
 * `CHROMA_AE_MCP_USAGE_LOG=off` turns it off. Read it with panel/tools/usage-report.cjs.
 */

export const USAGE_DIR_NAME = "usage";
export const RETENTION_MONTHS = 3;
export const MAX_ERROR = 160;
export const MAX_LABEL = 120;
export const MAX_QUERY = 80;
export const MAX_TOOL = 80;

export interface UsageEntry {
  tool: string;
  ms: number;
  ok: boolean;
  /** Failure only: the BridgeError kind, invalid_args, unknown_tool or error. */
  errorKind?: string;
  /** Failure only: the message. */
  error?: string;
  toolset?: string;
  /** The MCP client's name from the X-Chroma-Client header (clipped to 40). */
  client?: string;
  via?: "direct" | "ae_invoke_tool";
  /** ae_run_jsx only. */
  label?: string;
  mutates?: boolean;
  codeChars?: number;
  /** ae_search_tools only. */
  query?: string;
  hits?: number;
}

export function usageLogEnabled(): boolean {
  const v = process.env.CHROMA_AE_MCP_USAGE_LOG;
  if (v === undefined) return true;
  return v.trim().toLowerCase() !== "off";
}

/** One line of plain text, cut to `max` characters. */
export function clip(text: unknown, max: number): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
    .trim()
    .slice(0, max);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function monthOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function dayOf(d: Date): string {
  return `${monthOf(d)}-${pad(d.getDate())}`;
}

/** The error kind of a thrown value: its string `kind` (BridgeError, QueueWaitError, QuarantineBlockedError), else its string `code` (PlanarError and similar), else "error". */
export function errorKindOf(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { kind?: unknown; code?: unknown };
    if (typeof e.kind === "string" && e.kind) return clip(e.kind, 40);
    if (typeof e.code === "string" && e.code) return clip(e.code, 40);
  }
  return "error";
}

export function errorTextOf(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), MAX_ERROR);
}

/** The extra fields for ae_run_jsx, from raw or parsed arguments. Only label, mutates and code length. */
export function runJsxFields(args: unknown): Pick<UsageEntry, "label" | "mutates" | "codeChars"> {
  const out: Pick<UsageEntry, "label" | "mutates" | "codeChars"> = {};
  if (!args || typeof args !== "object") return out;
  const a = args as Record<string, unknown>;
  if (typeof a.label === "string") out.label = clip(a.label, MAX_LABEL);
  if (typeof a.mutates === "boolean") out.mutates = a.mutates;
  if (typeof a.code === "string") out.codeChars = a.code.length;
  return out;
}

let prunedDirs = new Set<string>();

/** Test hook: forget which directories were already pruned. */
export function resetUsageLogForTests(): void {
  prunedDirs = new Set<string>();
}

function pruneOld(dir: string, now: Date): void {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  try {
    const cutoff = new Date(now.getFullYear(), now.getMonth() - RETENTION_MONTHS, 1);
    const keepFrom = monthOf(cutoff);
    for (const name of fs.readdirSync(dir)) {
      const m = /^usage-(\d{4}-\d{2})\.jsonl$/.exec(name);
      if (m && m[1] < keepFrom) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* leave it */
        }
      }
    }
  } catch {
    /* no directory yet, or unreadable */
  }
}

/** Append one line. Never throws. */
export function recordUsage(ctx: ToolContext, entry: UsageEntry, now: Date = new Date()): void {
  try {
    if (!usageLogEnabled()) return;
    const line: Record<string, unknown> = {
      ts: now.toISOString(),
      day: dayOf(now),
      tool: clip(entry.tool, MAX_TOOL),
      ms: Math.max(0, Math.round(Number.isFinite(entry.ms) ? entry.ms : 0)),
      ok: entry.ok,
    };
    if (!entry.ok) {
      line.error_kind = clip(entry.errorKind || "error", 40);
      line.error = clip(entry.error ?? "", MAX_ERROR);
    }
    if (entry.toolset) line.toolset = clip(entry.toolset, 10);
    if (entry.client) line.client = clip(entry.client, 40);
    if (entry.via) line.via = entry.via;
    if (entry.label !== undefined) line.label = clip(entry.label, MAX_LABEL);
    if (entry.mutates !== undefined) line.mutates = entry.mutates;
    if (entry.codeChars !== undefined) line.code_chars = entry.codeChars;
    if (entry.query !== undefined) line.query = clip(entry.query, MAX_QUERY);
    if (entry.hits !== undefined) line.hits = entry.hits;

    const dir = path.join(dataDirOf(ctx), USAGE_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    pruneOld(dir, now);
    fs.appendFileSync(path.join(dir, `usage-${monthOf(now)}.jsonl`), JSON.stringify(line) + "\n");
  } catch {
    /* the log must never hurt a tool call */
  }
}
