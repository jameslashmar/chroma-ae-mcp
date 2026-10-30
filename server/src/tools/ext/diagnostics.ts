/**
 * server/src/tools/ext/diagnostics.ts
 *
 * ae_diagnostics: one file with what is needed to triage a stuck or failing
 * session: versions, the service's eval queue and what is in flight, the
 * write queue, quarantine, settings, AE's own status (if it answers within a
 * few seconds; nothing is aborted), popups AE has open, and the end of the
 * service log. The token never goes in: it is redacted from the log.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { buildJsxCall } from "../../jsx.js";
import { dataDirOf, type ToolContext, type ToolDefinition } from "../common.js";
import { formatBackupTimestamp } from "../mutate.js";
import { describeBlockingDialogs } from "./dialogs.js";

export type ServiceInfo = Record<string, unknown> & {
  logPath?: string;
  rotatedLogPath?: string;
  tokenPath?: string;
};

const AE_STATUS_WAIT_MS = 5000;
const DEFAULT_LOG_LINES = 300;

export const AeDiagnosticsSchema = z.object({
  log_lines: z.number().int().min(0).max(5000).optional().describe(`Lines from the end of the service log. Default ${DEFAULT_LOG_LINES}.`),
  include_dialogs: z.boolean().optional().describe("Read AE's open popups (Windows and macOS; default true)."),
});

/** Replaces every occurrence of `secret` (and Bearer values) with a marker. */
export function redact(text: string, secret: string | null): string {
  let out = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
}

export function tailLines(text: string, n: number): string {
  if (n <= 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

function readIfExists(p: string | undefined): string {
  if (!p) return "";
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** One outstanding status eval per context: a stuck AE doesn't collect a queue of them. */
const pendingStatus = new WeakMap<ToolContext, Promise<{ answered: boolean; status?: unknown; error?: string }>>();

/** Waits for AE's status up to `ms`; the eval is never aborted, only no longer waited for. */
async function aeStatusWithin(ctx: ToolContext, ms: number): Promise<{ answered: boolean; status?: unknown; error?: string }> {
  let call = pendingStatus.get(ctx);
  if (!call) {
    call = ctx.bridge
    .evalRaw({
      id: `${ctx.bridge.newOpId()}_diag`,
      script: buildJsxCall("status", {}),
      label: "ae_diagnostics (status)",
      mutates: false,
      toolName: "ae_diagnostics",
    })
    .then((r) => ({ answered: true, status: r.result }))
    .catch((err: unknown) => ({ answered: true, error: err instanceof Error ? err.message : String(err) }));
    const mine = call;
    pendingStatus.set(ctx, mine);
    void mine.then(() => {
      if (pendingStatus.get(ctx) === mine) pendingStatus.delete(ctx);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ answered: boolean; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ answered: false, error: `AE did not answer within ${ms / 1000} s (busy with a script or render, or a popup is open).` }),
      ms
    );
  });
  try {
    return await Promise.race([call, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DiagnosticsResult {
  path: string;
  summary: Record<string, unknown>;
}

export async function writeDiagnostics(
  ctx: ToolContext,
  serviceInfo: ServiceInfo | undefined,
  opts: { logLines?: number; includeDialogs?: boolean; aeWaitMs?: number } = {}
): Promise<DiagnosticsResult> {
  const now = new Date();
  const token = readIfExists(serviceInfo?.tokenPath).trim() || null;
  const ae = await aeStatusWithin(ctx, opts.aeWaitMs ?? AE_STATUS_WAIT_MS);
  const dialogs = opts.includeDialogs === false ? [] : await describeBlockingDialogs();
  const quarantine = ctx.quarantine.list();
  const logText = readIfExists(serviceInfo?.rotatedLogPath) + readIfExists(serviceInfo?.logPath);
  const log = redact(tailLines(logText, opts.logLines ?? DEFAULT_LOG_LINES), token);
  const { tokenPath: _omit, ...service } = serviceInfo ?? {};

  const summary = {
    created_at: now.toISOString(),
    ae_answered: ae.answered,
    service_in_flight: (service as { inFlight?: unknown }).inFlight ?? null,
    write_queue: { depth: ctx.queue.depth, in_flight: ctx.queue.inFlight },
    quarantined: quarantine.length,
    open_dialogs: dialogs.length,
  };
  const sections: Array<[string, unknown]> = [
    ["Summary", summary],
    ["Service", service],
    ["After Effects", ae],
    ["Quarantine", quarantine],
    ["Settings", ctx.settings?.get() ?? null],
    ["Open popups", dialogs.map((d) => ({ ...(d as object), screenshot_path: (d as { screenshot_path?: string }).screenshot_path }))],
    ["System", { platform: process.platform, release: os.release(), arch: process.arch, node: process.version }],
  ];
  const md = [
    `# chroma-ae-mcp diagnostics, ${now.toISOString()}`,
    "",
    "The token is not included. Attach this file when reporting a problem.",
    "",
    ...sections.flatMap(([title, value]) => [`## ${title}`, "", "```json", redact(JSON.stringify(value, null, 2), token), "```", ""]),
    `## Service log (last ${opts.logLines ?? DEFAULT_LOG_LINES} lines)`,
    "",
    "```",
    log,
    "```",
    "",
  ].join("\n");

  const dir = path.join(dataDirOf(ctx), "diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  const stem = `chroma-ae-diagnostics_${formatBackupTimestamp(now)}`;
  let file = path.join(dir, `${stem}.md`);
  for (let n = 2; ; n++) {
    try {
      fs.writeFileSync(file, md, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
      file = path.join(dir, `${stem}-${n}.md`);
    }
  }
  return { path: file, summary };
}

export const diagnosticsTools: ToolDefinition<any>[] = [
  {
    name: "ae_diagnostics",
    description:
      "Write a diagnostics file for triage when automation is stuck or failing: versions, the service's eval queue and what is in flight (and for how long), the write queue, quarantine, settings, AE's status (if AE answers within 5 s; nothing is aborted), AE's open popups, and the end of the service log. " +
      "The token is redacted. Returns the file's path and a summary; the user can attach the file to a bug report. Never touches the AE project.",
    schema: AeDiagnosticsSchema,
    handler: async (args: z.infer<typeof AeDiagnosticsSchema>, ctx) => {
      const res = await writeDiagnostics(ctx, ctx.serviceInfo?.(), { logLines: args.log_lines, includeDialogs: args.include_dialogs });
      return { ok: true, ...res };
    },
  },
];
