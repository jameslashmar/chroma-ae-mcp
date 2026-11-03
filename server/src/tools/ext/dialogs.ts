import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { z } from "zod";
import { defaultDataDir } from "../../quarantine.js";
import { AGENT_SAFETY_GUIDANCE, type ToolDefinition } from "../common.js";

export const JAY_DIALOG_RULES =
  "Jay's dialog rules: (1) Popups are NEVER suppressed (never call app.beginSuppressDialogs). " +
  "(2) Answer ONLY dialogs that our own operation caused (caused_by_op is non-null), unless Jay gave an explicit user_instruction. " +
  "(3) Destructive answers (Save, Don't Save, Replace, Delete, Overwrite, Discard, Remove, Revert) require BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay's explicit instruction.";

export const DESTRUCTIVE_BUTTON_PATTERN =
  /save|don't save|dont save|replace|delete|overwrite|discard|remove|revert/i;

export const DIALOG_EXEC_TIMEOUT_MS = 15_000;
export const MAX_DIALOG_TEXT_CHARS = 4_000;

export interface DialogButton {
  name: string;
  automationId: string;
  enabled: boolean;
}

export interface DialogCheckbox {
  name: string;
  checked: boolean;
}

export interface DialogBoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawPs1Dialog {
  handle: number;
  title?: string;
  class?: string;
  isModal?: boolean;
  text?: string;
  buttons?: Array<{
    name?: string;
    automationId?: string;
    enabled?: boolean;
  }>;
  checkboxes?: Array<{
    name?: string;
    checked?: boolean;
  }>;
  boundingRect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  screenshot?: string | null;
}

export interface EnrichedDialog {
  handle: number;
  title: string;
  class: string;
  isModal: boolean;
  text: string;
  buttons: DialogButton[];
  checkboxes: DialogCheckbox[];
  boundingRect: DialogBoundingRect;
  screenshot: string | null;
  first_seen: string;
  caused_by_op: string | null;
}

export type Ps1ListOutput =
  | {
      ok: true;
      ae_pid?: number | null;
      dialogs: RawPs1Dialog[];
    }
  | {
      ok: false;
      error: string;
    };

export type Ps1RespondOutput =
  | {
      ok: true;
      handle?: number;
      pressed: string;
      checked?: string | null;
      closed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

interface SeenDialogMeta {
  handle: number;
  first_seen: string;
  caused_by_op: string | null;
  title: string;
  text: string;
}

export type Ps1RunnerFn = (args: string[]) => Promise<string>;

interface DialogsRuntimeOverrides {
  platform?: NodeJS.Platform;
  ps1Runner?: Ps1RunnerFn;
  dialogsDir?: string;
  scriptPath?: string | null;
  nowIso?: () => string;
  /** Replaces the osascript run of ae-dialogs-mac.js on macOS (tests). */
  macRunner?: Ps1RunnerFn;
}

const inFlightOps: string[] = [];
const seenDialogs = new Map<number, SeenDialogMeta>();
let runtimeOverrides: DialogsRuntimeOverrides = {};

/**
 * Records that an operation with `opId` has started in After Effects.
 * Any modal dialog first discovered while `opId` is in flight will have
 * `caused_by_op` set to `opId`.
 */
export function noteOpStarted(opId: string): void {
  if (!opId || typeof opId !== "string") return;
  const existingIdx = inFlightOps.indexOf(opId);
  if (existingIdx !== -1) {
    inFlightOps.splice(existingIdx, 1);
  }
  inFlightOps.push(opId);
}

/**
 * Records that an operation with `opId` has finished.
 */
export function noteOpFinished(opId: string): void {
  if (!opId || typeof opId !== "string") return;
  const idx = inFlightOps.indexOf(opId);
  if (idx !== -1) {
    inFlightOps.splice(idx, 1);
  }
}

/**
 * Returns the currently in-flight operation ID (most recently started), or null.
 */
export function getCurrentInFlightOp(): string | null {
  return inFlightOps.length > 0 ? inFlightOps[inFlightOps.length - 1] : null;
}

/**
 * Test helper to configure runtime overrides (platform, runner, directory, clock).
 */
export function setDialogsTestOverrides(
  overrides: DialogsRuntimeOverrides
): void {
  runtimeOverrides = { ...overrides };
}

/**
 * Test helper to reset in-flight ops, seen dialogs, and test overrides.
 */
export function resetDialogsState(): void {
  inFlightOps.length = 0;
  seenDialogs.clear();
  runtimeOverrides = {};
}

/**
 * Test helper to seed or inspect seen dialog tracking metadata.
 */
export function recordDialogSeenForTest(meta: {
  handle: number;
  caused_by_op: string | null;
  first_seen?: string;
  title?: string;
  text?: string;
}): void {
  seenDialogs.set(meta.handle, {
    handle: meta.handle,
    first_seen: meta.first_seen ?? currentNowIso(),
    caused_by_op: meta.caused_by_op,
    title: meta.title ?? "",
    text: meta.text ?? "",
  });
}

function currentPlatform(): NodeJS.Platform {
  return runtimeOverrides.platform ?? process.platform;
}

/** Windows reads popups with UI Automation (ae-dialogs.ps1), macOS with System Events (ae-dialogs-mac.js). */
function dialogsSupported(): boolean {
  const p = currentPlatform();
  return p === "win32" || p === "darwin";
}

function currentNowIso(): string {
  return runtimeOverrides.nowIso
    ? runtimeOverrides.nowIso()
    : new Date().toISOString();
}

export function defaultDialogsDir(): string {
  if (runtimeOverrides.dialogsDir) {
    return runtimeOverrides.dialogsDir;
  }
  return path.join(defaultDataDir(), "dialogs");
}

function getRuntimeBaseDir(): string {
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) {
      return __dirname;
    }
  } catch {
    // Ignore in pure ESM environments where __dirname is not defined
  }
  try {
    if (
      typeof import.meta?.url === "string" &&
      import.meta.url.startsWith("file:")
    ) {
      return path.dirname(url.fileURLToPath(import.meta.url));
    }
  } catch {
    // Ignore
  }
  return process.cwd();
}

/**
 * Searches upwards from `startDir` (and `process.cwd()`) for
 * `panel/tools/ae-dialogs.ps1` or `tools/ae-dialogs.ps1`.
 */
export function locateDialogsPs1Script(startDir?: string): string | null {
  if (runtimeOverrides.scriptPath !== undefined) {
    return runtimeOverrides.scriptPath;
  }
  return locateToolScript("ae-dialogs.ps1", startDir);
}

/** Searches upwards for `panel/tools/<fileName>` or `tools/<fileName>`. */
export function locateToolScript(fileName: string, startDir?: string): string | null {
  const rootsToSearch = [startDir ?? getRuntimeBaseDir(), process.cwd()];
  const visited = new Set<string>();

  for (const start of rootsToSearch) {
    let dir = path.resolve(start);
    while (!visited.has(dir)) {
      visited.add(dir);
      const candidateA = path.join(dir, "panel", "tools", fileName);
      if (fs.existsSync(candidateA)) {
        return candidateA;
      }
      const candidateB = path.join(dir, "tools", fileName);
      if (fs.existsSync(candidateB)) {
        return candidateB;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * Parses a single-line JSON output from `ae-dialogs.ps1`.
 * Searches from the last non-empty line in stdout to tolerate any banner/warning noise.
 */
export function parsePs1JsonOutput<T extends { ok: boolean }>(
  stdout: string
): T {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "empty_ps1_output",
    } as unknown as T;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { ok?: unknown }).ok === "boolean"
      ) {
        return parsed as T;
      }
    } catch {
      // Try earlier line
    }
  }

  try {
    const parsedWhole = JSON.parse(trimmed) as unknown;
    if (
      parsedWhole &&
      typeof parsedWhole === "object" &&
      typeof (parsedWhole as { ok?: unknown }).ok === "boolean"
    ) {
      return parsedWhole as T;
    }
  } catch {
    // Fall through
  }

  return {
    ok: false,
    error: `invalid_ps1_json: ${trimmed.slice(0, 200)}`,
  } as unknown as T;
}

function normalizeRawDialog(
  raw: RawPs1Dialog,
  meta: SeenDialogMeta
): EnrichedDialog {
  const rawText = typeof raw.text === "string" ? raw.text : "";
  const boundedText =
    rawText.length > MAX_DIALOG_TEXT_CHARS
      ? rawText.slice(0, MAX_DIALOG_TEXT_CHARS)
      : rawText;

  const rawButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  const buttons: DialogButton[] = rawButtons.map((b) => ({
    name: typeof b?.name === "string" ? b.name : "",
    automationId: typeof b?.automationId === "string" ? b.automationId : "",
    enabled: Boolean(b?.enabled ?? true),
  }));

  const rawCheckboxes = Array.isArray(raw.checkboxes) ? raw.checkboxes : [];
  const checkboxes: DialogCheckbox[] = rawCheckboxes.map((c) => ({
    name: typeof c?.name === "string" ? c.name : "",
    checked: Boolean(c?.checked),
  }));

  const r = raw.boundingRect ?? raw.rect ?? {};
  const boundingRect: DialogBoundingRect = {
    x: typeof r.x === "number" ? r.x : 0,
    y: typeof r.y === "number" ? r.y : 0,
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
  };

  return {
    handle: Number(raw.handle),
    title: typeof raw.title === "string" ? raw.title : "",
    class: typeof raw.class === "string" ? raw.class : "",
    isModal: Boolean(raw.isModal),
    text: boundedText,
    buttons,
    checkboxes,
    boundingRect,
    screenshot: typeof raw.screenshot === "string" ? raw.screenshot : null,
    first_seen: meta.first_seen,
    caused_by_op: meta.caused_by_op,
  };
}

/**
 * Enriches raw dialog entries from `ae-dialogs.ps1` with `first_seen` and `caused_by_op`,
 * preserving tracking across polls while a dialog handle remains open and pruning closed handles.
 */
export function enrichDialogsList(rawDialogs: RawPs1Dialog[]): EnrichedDialog[] {
  const activeHandles = new Set<number>();
  const now = currentNowIso();
  const inFlight = getCurrentInFlightOp();
  const result: EnrichedDialog[] = [];

  for (const raw of rawDialogs) {
    const handle = Number(raw?.handle);
    if (!Number.isFinite(handle) || handle <= 0) continue;
    activeHandles.add(handle);

    let meta = seenDialogs.get(handle);
    const title = typeof raw.title === "string" ? raw.title : "";
    const text =
      typeof raw.text === "string"
        ? raw.text.slice(0, MAX_DIALOG_TEXT_CHARS)
        : "";

    if (!meta) {
      meta = {
        handle,
        first_seen: now,
        caused_by_op: inFlight,
        title,
        text,
      };
      seenDialogs.set(handle, meta);
    } else {
      if (title) meta.title = title;
      if (text) meta.text = text;
    }

    result.push(normalizeRawDialog(raw, meta));
  }

  for (const existingHandle of Array.from(seenDialogs.keys())) {
    if (!activeHandles.has(existingHandle)) {
      seenDialogs.delete(existingHandle);
    }
  }

  return result;
}

function runPowerShellScript(ps1Args: string[]): Promise<string> {
  if (runtimeOverrides.ps1Runner) {
    return runtimeOverrides.ps1Runner(ps1Args);
  }

  const scriptPath = locateDialogsPs1Script();
  if (!scriptPath) {
    return Promise.resolve(
      JSON.stringify({
        ok: false,
        error: "ae_dialogs_ps1_not_found",
      })
    );
  }

  const fullArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...ps1Args,
  ];

  return new Promise<string>((resolve) => {
    execFile(
      "powershell.exe",
      fullArgs,
      {
        windowsHide: true,
        timeout: DIALOG_EXEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout.trim() : "";
        if (outStr.length > 0) {
          resolve(outStr);
          return;
        }
        const errMsg =
          err instanceof Error
            ? err.message
            : typeof stderr === "string" && stderr.trim().length > 0
            ? stderr.trim()
            : "powershell_exec_failed";
        resolve(
          JSON.stringify({
            ok: false,
            error: errMsg,
          })
        );
      }
    );
  });
}

/** Runs ae-dialogs-mac.js with osascript (JavaScript for Automation) on macOS. */
function runMacScript(args: string[]): Promise<string> {
  if (runtimeOverrides.macRunner) {
    return runtimeOverrides.macRunner(args);
  }
  const scriptPath = locateToolScript("ae-dialogs-mac.js");
  if (!scriptPath) {
    return Promise.resolve(JSON.stringify({ ok: false, error: "ae_dialogs_mac_script_not_found" }));
  }
  return new Promise<string>((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", scriptPath, ...args],
      { timeout: DIALOG_EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout.trim() : "";
        if (outStr.length > 0) {
          resolve(outStr);
          return;
        }
        const errMsg =
          typeof stderr === "string" && stderr.trim().length > 0
            ? stderr.trim()
            : err instanceof Error
            ? err.message
            : "osascript_exec_failed";
        resolve(JSON.stringify({ ok: false, error: errMsg }));
      }
    );
  });
}

export function isDestructiveButton(buttonName: string): boolean {
  return DESTRUCTIVE_BUTTON_PATTERN.test(buttonName ?? "");
}

export interface RespondPolicyCheckResult {
  allowed: boolean;
  error?: string;
  message?: string;
}

/**
 * Evaluates Jay's dialog response safety rules before clicking any button.
 */
export function evaluateRespondPolicy(params: {
  button: string;
  caused_by_op: string | null;
  allow_destructive?: boolean;
  user_instruction?: string;
}): RespondPolicyCheckResult {
  const hasUserInstruction =
    typeof params.user_instruction === "string" &&
    params.user_instruction.trim().length > 0;

  if (params.caused_by_op === null && !hasUserInstruction) {
    return {
      allowed: false,
      error: "refused_not_caused_by_our_op",
      message:
        "Refused to respond to dialog: caused_by_op is null (dialog was not caused by our own in-flight operation) and no non-empty user_instruction quoting Jay was provided.",
    };
  }

  if (isDestructiveButton(params.button)) {
    if (params.allow_destructive !== true || !hasUserInstruction) {
      return {
        allowed: false,
        error: "refused_destructive_button",
        message:
          `Refused to click destructive button "${params.button}": buttons matching ` +
          `${DESTRUCTIVE_BUTTON_PATTERN.toString()} require BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay's explicit instruction.`,
      };
    }
  }

  return { allowed: true };
}

function appendResponseLog(entry: {
  time: string;
  handle: number;
  title: string;
  text_excerpt: string;
  button: string;
  check?: string;
  reason: string;
  op: string | null;
  allow_destructive: boolean;
  user_instruction?: string;
  result: unknown;
}): void {
  const dir = defaultDialogsDir();
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "responses.jsonl");
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
  });
}

async function listDialogsInternal(opts: {
  screenshots: boolean;
}): Promise<
  | {
      ok: true;
      ae_pid: number | null;
      dialogs: EnrichedDialog[];
    }
  | {
      ok: false;
      error: string;
    }
> {
  if (!dialogsSupported()) {
    return {
      ok: false,
      error: "not_implemented_on_this_os",
    };
  }

  if (currentPlatform() === "darwin") {
    const macParsed = parsePs1JsonOutput<Ps1ListOutput>(await runMacScript(["list"]));
    if (!macParsed.ok) {
      return { ok: false, error: macParsed.error || "dialog_list_failed" };
    }
    return {
      ok: true,
      ae_pid: macParsed.ae_pid ?? null,
      dialogs: enrichDialogsList(Array.isArray(macParsed.dialogs) ? macParsed.dialogs : []),
    };
  }

  const psArgs = ["-Mode", "list"];
  if (opts.screenshots) {
    const dir = defaultDialogsDir();
    fs.mkdirSync(dir, { recursive: true });
    psArgs.push("-ScreenshotDir", dir);
  }

  const rawStdout = await runPowerShellScript(psArgs);
  const parsed = parsePs1JsonOutput<Ps1ListOutput>(rawStdout);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error || "dialog_list_failed",
    };
  }

  const rawList = Array.isArray(parsed.dialogs) ? parsed.dialogs : [];
  const enriched = enrichDialogsList(rawList);

  return {
    ok: true,
    ae_pid: parsed.ae_pid ?? null,
    dialogs: enriched,
  };
}

/**
 * Open dialogs without swallowing a failure: `ok: false` means the list could
 * not be read, which a caller must not take as "no dialog". Never throws.
 */
export async function listBlockingDialogs(opts: { screenshots: boolean }): Promise<{ ok: boolean; dialogs?: object[]; error?: string }> {
  try {
    const res = await listDialogsInternal(opts);
    return res.ok ? { ok: true, dialogs: res.dialogs } : { ok: false, error: res.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Helper for Claude to wire into the evalScript timeout path in `panel-host.ts`.
 * Returns currently open modal/blocking dialogs in After Effects (or `[]` on non-Windows/error).
 */
export async function describeBlockingDialogs(): Promise<object[]> {
  try {
    const res = await listDialogsInternal({ screenshots: true });
    if (!res.ok) {
      return [];
    }
    return res.dialogs;
  } catch {
    return [];
  }
}

export const AeDialogsSchema = z.object({
  screenshots: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      "Whether to capture a PNG screenshot of each open dialog into %LOCALAPPDATA%/chroma-ae-mcp/dialogs/ (default: true)."
    ),
});

export const AeDialogRespondSchema = z.object({
  handle: z
    .number()
    .int()
    .positive()
    .describe("NativeWindowHandle (HWND) of the dialog to respond to."),
  button: z
    .string()
    .min(1)
    .describe(
      "Exact button name (case-insensitive) to press via UIA InvokePattern."
    ),
  check: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional checkbox name to toggle on before pressing the button."
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "Clear explanation of why this dialog is being answered and why this button was chosen."
    ),
  allow_destructive: z
    .boolean()
    .default(false)
    .optional()
    .describe(
      "Must be true (along with user_instruction) to press destructive buttons matching /save|don't save|dont save|replace|delete|overwrite|discard|remove|revert/i."
    ),
  user_instruction: z
    .string()
    .optional()
    .describe(
      "Verbatim quote of Jay's explicit instruction authorizing answering an external dialog or pressing a destructive button."
    ),
});

export const dialogsTools: ToolDefinition<any>[] = [
  {
    name: "ae_dialogs",
    description:
      "READ-ONLY. Lists modal/popup dialogs currently open in After Effects from outside AE's blocked ExtendScript thread (Windows: UI Automation; macOS: System Events, which needs Accessibility permission for After Effects and gives no screenshots), returning handle, title, class, text, buttons, checkboxes, boundingRect, screenshot path (in %LOCALAPPDATA%/chroma-ae-mcp/dialogs/), first_seen, and caused_by_op. AE paints many dialogs itself, so UI Automation sees no text or buttons in them; then text and button labels come from OCR of the screenshot (text_source: \"ocr\", which may contain small misreads such as 0K for OK). Look at the screenshot when in doubt. " +
      JAY_DIALOG_RULES +
      " " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeDialogsSchema,
    handler: async (args) => {
      if (!dialogsSupported()) {
        return {
          ok: false,
          error: "not_implemented_on_this_os",
        };
      }

      const screenshots = args.screenshots ?? true;
      return await listDialogsInternal({ screenshots });
    },
  },
  {
    name: "ae_dialog_respond",
    description:
      "Responds to an open After Effects modal dialog by its handle using Windows UI Automation, or on macOS the button's AXPress through System Events (never brings windows to the foreground or moves the mouse; on macOS the handle is window index * 100 + sheet index and the dialog's title must be unchanged). For AE-painted dialogs (OCR buttons), only two answers are possible without focusing AE: Cancel/No/Close (sent as Escape) and OK/Yes/Continue when it is the dialog's ONLY button (sent as Enter). Anything else returns button_not_answerable: ask Jay to answer it. Logs every response to %LOCALAPPDATA%/chroma-ae-mcp/dialogs/responses.jsonl. " +
      JAY_DIALOG_RULES +
      " " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeDialogRespondSchema,
    handler: async (args) => {
      if (!dialogsSupported()) {
        return {
          ok: false,
          error: "not_implemented_on_this_os",
        };
      }

      let meta = seenDialogs.get(args.handle);
      if (!meta) {
        await listDialogsInternal({ screenshots: false });
        meta = seenDialogs.get(args.handle);
      }

      const causedByOp = meta ? meta.caused_by_op : getCurrentInFlightOp();
      const policy = evaluateRespondPolicy({
        button: args.button,
        caused_by_op: causedByOp,
        allow_destructive: args.allow_destructive ?? false,
        user_instruction: args.user_instruction,
      });

      if (!policy.allowed) {
        return {
          ok: false,
          error: policy.error ?? "refused_by_policy",
          message: policy.message,
          handle: args.handle,
          button: args.button,
          caused_by_op: causedByOp,
        };
      }

      let rawStdout: string;
      if (currentPlatform() === "darwin") {
        // The title and the start of the text guard against another window having taken this index.
        rawStdout = await runMacScript(["respond", String(args.handle), args.button, args.check ?? "", meta?.title ?? "", (meta?.text ?? "").slice(0, 200)]);
      } else {
        const psArgs = [
          "-Mode",
          "respond",
          "-Handle",
          String(args.handle),
          "-Button",
          args.button,
        ];
        if (args.check) {
          psArgs.push("-Check", args.check);
        }
        rawStdout = await runPowerShellScript(psArgs);
      }
      const parsed = parsePs1JsonOutput<Ps1RespondOutput>(rawStdout);

      const logTime = currentNowIso();
      const title = meta?.title ?? "";
      const textExcerpt = (meta?.text ?? "").slice(0, 500);

      appendResponseLog({
        time: logTime,
        handle: args.handle,
        title,
        text_excerpt: textExcerpt,
        button: args.button,
        check: args.check,
        reason: args.reason,
        op: causedByOp,
        allow_destructive: Boolean(args.allow_destructive),
        user_instruction: args.user_instruction,
        result: parsed,
      });

      if (parsed.ok && parsed.closed) {
        seenDialogs.delete(args.handle);
      }

      return parsed;
    },
  },
];
