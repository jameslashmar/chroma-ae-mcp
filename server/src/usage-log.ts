import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { dataDirOf, type ToolContext } from "./tools/common.js";

/**
 * A local usage log: one JSON line per tool call in `<data dir>/usage/usage-YYYY-MM.jsonl`
 * (local month). It exists to learn which tools are missing or failing. What a line keeps:
 *   - always: time, day, tool name, duration, ok (false only for an MCP error), toolset, client, via;
 *   - on an MCP error: `error_kind` and `error`, the message with quoted strings, file paths and
 *     long digit runs removed (see `sanitizeError`), so argument values do not end up in it;
 *   - when a tool returned an object with `ok: false` without throwing: `result_ok: false`, and
 *     `result_kind` (its code or kind) and `result_error` (sanitised the same way) when present;
 *   - `ae_run_jsx`: the `label` the caller wrote (the user's own wording, kept on purpose), `mutates`
 *     and the code length (never the code);
 *   - `ae_search_tools`: the `query` (the user's own wording, kept on purpose), the `group`, `hits`,
 *     and the best hit's name (`top`) and score (`top_score`).
 *   - every call: `result_chars`, the length of the text returned to the client (a number, never the text),
 *     so the report can show which tools send the biggest results.
 * No other argument and no result is recorded. The file stays on the machine, and nothing here
 * may throw into a tool call. Lines are appended through a small async queue.
 * `CHROMA_AE_MCP_USAGE_LOG=off` turns it off. Read it with panel/tools/usage-report.cjs.
 */

export const USAGE_DIR_NAME = "usage";
export const RETENTION_MONTHS = 3;
export const MAX_ERROR = 160;
export const MAX_LABEL = 120;
export const MAX_QUERY = 80;
export const MAX_TOOL = 80;
/** Lines waiting to be written; past this the newest are dropped and counted. */
export const MAX_QUEUED = 1000;

export interface UsageEntry {
  tool: string;
  ms: number;
  ok: boolean;
  /** Failure only: the BridgeError kind, invalid_args, unknown_tool or error. */
  errorKind?: string;
  /** Failure only: the message (sanitised by recordUsage). */
  error?: string;
  /** The call returned an object with `ok: false` instead of throwing. `ok` stays true (no MCP error). */
  resultOk?: boolean;
  resultKind?: string;
  resultError?: string;
  /** The time the call waited on purpose (wait_seconds), from the output's numeric `waited_ms`. A count only. */
  waitedMs?: number;
  /** The length of the text returned to the client (all text parts), a count only. */
  resultChars?: number;
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
  group?: string;
  hits?: number;
  /** ae_search_tools only: the best hit's name and score (a query search only). */
  top?: string;
  topScore?: number;
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

/**
 * A message with what could be the user's data removed: quoted strings ("..." '...' and curly
 * quotes) become "…", Windows (drive and UNC) and POSIX paths become <path>, digit runs of 5 or
 * more become #. It removes the usual carriers (names, paths, values); free text is not guaranteed.
 */
export function sanitizeError(text: unknown): string {
  let t = String(text ?? "");
  // A quote opens only after a non-word character and an apostrophe closes only before a non-word one, so "can't" survives.
  t = t.replace(/(^|[^\w])"[^"\n]*"/g, '$1"…"');
  t = t.replace(/(^|[^\w])“[^”\n]*”/g, '$1"…"');
  t = t.replace(/(^|[^\w])'[^'\n]*'(?!\w)/g, '$1"…"');
  t = t.replace(/(^|[^\w])‘[^’\n]*’/g, '$1"…"');
  // A drive path may hold spaces inside its folders (a segment ends at a slash) and in its file name
  // (read up to a short extension); UNC and POSIX paths the same. Over-redacting is the safe side.
  t = t.replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*(?:[^\\/:*?"<>|\r\n,;]{0,60}?\.[A-Za-z0-9]{1,5}\b|[^\\/:*?"<>|\s,;]*)/g, "<path>");
  t = t.replace(/\\\\[^\s\\/]+(?:[\\/][^\\/:*?"<>|\r\n]+[\\/])*(?:[\\/]?(?:[^\\/:*?"<>|\r\n,;]{0,60}?\.[A-Za-z0-9]{1,5}\b|[^\\/:*?"<>|\s,;]*))/g, "<path>");
  t = t.replace(/(^|[\s(\[=,;:])~?\/(?:[^\/\r\n"'`<>|,;]+\/)*(?:[^\/\r\n"'`<>|,;]{0,60}?\.[A-Za-z0-9]{1,5}\b|[^\s\/"'`<>|,;)\]]*)/g, "$1<path>");
  t = t.replace(/\d{5,}/g, "#");
  return clip(t, MAX_ERROR);
}

/** The characters of text in a tool response ({ content: [{ type: "text", text }] }); 0 when it has none. */
export function resultCharsOf(result: unknown): number {
  try {
    const content = (result as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const part of content) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === "string") n += text.length;
    }
    return n;
  } catch {
    return 0;
  }
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

/**
 * The result-level failure of a tool that returned `{ ok: false, ... }` without throwing, else
 * undefined. `kind` is the first of `code`, `kind`, `refused[0].code` that is a string; `error`
 * is the `error` string (or an `error.message`). recordUsage sanitises the error on write.
 */
export function resultFailureOf(output: unknown): { kind?: string; error?: string } | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const o = output as Record<string, unknown>;
  if (o.ok !== false) return undefined;
  let kind: string | undefined;
  const first = Array.isArray(o.refused) ? o.refused[0] : undefined;
  const refusedCode = first && typeof first === "object" ? (first as { code?: unknown }).code : undefined;
  for (const c of [o.code, o.kind, refusedCode]) {
    if (typeof c === "string" && c) {
      kind = clip(c, 40);
      break;
    }
  }
  let error: string | undefined;
  if (typeof o.error === "string") error = o.error;
  else if (o.error && typeof o.error === "object" && typeof (o.error as { message?: unknown }).message === "string") {
    error = (o.error as { message: string }).message;
  }
  return { kind, error };
}

let prunedDirs = new Set<string>();
const madeDirs = new Set<string>();

interface QueuedLine {
  dir: string;
  file: string;
  text: string;
  now: Date;
}
let queue: QueuedLine[] = [];
let draining: Promise<void> | null = null;
let droppedLines = 0;

/** Lines dropped because the queue was full (since the process started or the last reset). */
export function droppedUsageLines(): number {
  return droppedLines;
}

/** Test hook: forget which directories were pruned or made, and empty the queue. */
export function resetUsageLogForTests(): void {
  prunedDirs = new Set<string>();
  madeDirs.clear();
  queue = [];
  droppedLines = 0;
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

function startDrain(): void {
  if (draining) return;
  draining = (async () => {
    try {
      while (queue.length > 0) {
        const item = queue.shift() as QueuedLine;
        try {
          if (!madeDirs.has(item.dir)) {
            await fsp.mkdir(item.dir, { recursive: true });
            madeDirs.add(item.dir);
            pruneOld(item.dir, item.now);
          }
          await fsp.appendFile(path.join(item.dir, item.file), item.text);
        } catch {
          // The log must never hurt a tool call; this line is lost. The folder may have been
          // deleted, so make it again for the next line.
          madeDirs.delete(item.dir);
        }
      }
    } finally {
      draining = null;
    }
  })();
}

/** Resolves when every queued line has been written (or has failed). For tests and shutdown; never rejects. */
export async function flushUsageLog(): Promise<void> {
  while (draining || queue.length > 0) {
    if (draining) await draining;
    else startDrain();
  }
}

/** Queue one line for the log. Never throws and never waits for the disk. */
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
      line.error = sanitizeError(entry.error ?? "");
    }
    if (entry.resultOk === false) {
      line.result_ok = false;
      if (entry.resultKind) line.result_kind = clip(entry.resultKind, 40);
      if (entry.resultError) line.result_error = sanitizeError(entry.resultError);
    }
    if (entry.waitedMs !== undefined && Number.isFinite(entry.waitedMs) && entry.waitedMs > 0) line.waited_ms = Math.round(entry.waitedMs);
    if (entry.resultChars !== undefined && Number.isFinite(entry.resultChars)) line.result_chars = Math.max(0, Math.round(entry.resultChars));
    if (entry.toolset) line.toolset = clip(entry.toolset, 10);
    if (entry.client) line.client = clip(entry.client, 40);
    if (entry.via) line.via = entry.via;
    if (entry.label !== undefined) line.label = clip(entry.label, MAX_LABEL);
    if (entry.mutates !== undefined) line.mutates = entry.mutates;
    if (entry.codeChars !== undefined) line.code_chars = entry.codeChars;
    if (entry.query !== undefined) line.query = clip(entry.query, MAX_QUERY);
    if (entry.group !== undefined) line.group = clip(entry.group, 40);
    if (entry.hits !== undefined) line.hits = entry.hits;
    if (entry.top !== undefined) line.top = clip(entry.top, MAX_TOOL);
    if (entry.topScore !== undefined && Number.isFinite(entry.topScore)) {
      line.top_score = Math.round(entry.topScore * 100) / 100;
    }

    if (queue.length >= MAX_QUEUED) {
      droppedLines++;
      return;
    }
    queue.push({
      dir: path.join(dataDirOf(ctx), USAGE_DIR_NAME),
      file: `usage-${monthOf(now)}.jsonl`,
      text: JSON.stringify(line) + "\n",
      now,
    });
    startDrain();
  } catch {
    /* the log must never hurt a tool call */
  }
}
