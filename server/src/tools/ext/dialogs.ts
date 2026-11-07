import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { PNG } from "pngjs";
import { z } from "zod";
import { defaultDataDir } from "../../quarantine.js";
import { AGENT_SAFETY_GUIDANCE, type ToolDefinition } from "../common.js";
import { analysePaintedDialog, type OcrLine, type PngPixels } from "./dialog-geometry.js";
import { powershellExe } from "../../win-exe.js";

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
  /** "ocr" when the label was read from a screenshot (the dialog is painted by AE itself). */
  source?: string;
  /** The label as OCR read it, only when it was corrected (0K -> OK). */
  raw_name?: string;
  /** True on the default button of an AE-painted dialog (outlined in blue; Enter presses it). */
  default?: boolean;
}

/** What can be answered without a person, for a dialog AE painted itself (OCR buttons). */
export interface UnattendedAnswers {
  /** Buttons that can be pressed without focusing AE. */
  answerable: string[];
  /** The default button (what Enter presses), when it was identified. */
  default_button?: string | null;
  /** Plain statement of what is and is not possible. */
  note: string;
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
  /** The window's DPI from GetDpiForWindow (96 = 100 %); 0 or missing when unknown. */
  dpi?: number;
  title?: string;
  class?: string;
  isModal?: boolean;
  text?: string;
  text_source?: string;
  buttons?: Array<{
    name?: string;
    automationId?: string;
    enabled?: boolean;
    source?: string;
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
  /** AE-painted dialog: the OCR lines with word boxes (ae-dialogs.ps1); the buttons are derived here. */
  ocr_lines?: OcrLine[] | null;
  /** A screenshot kept only for the analysis (no screenshot directory); deleted after it is read. */
  analysis_png?: string | null;
  /** GetWindowRect as "left,top,right,bottom" (ae-dialogs.ps1); passed back as -ExpectRect. */
  win_rect?: string;
}

/** "info": one OK-like button, nothing to decide. "destructive": a button that loses work. "question": anything else. Advisory; the policy does not read it. */
export type DialogKind = "info" | "question" | "destructive";

export interface EnrichedDialog {
  handle: number;
  /** The window's DPI from GetDpiForWindow (96 = 100 %); 0 or missing when unknown. */
  dpi?: number;
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
  text_source?: string;
  /** Only for AE-painted dialogs (OCR buttons): which buttons ae_dialog_respond can press. */
  unattended?: UnattendedAnswers;
  /** AE-painted dialog: the label of the default button (what Enter presses), or null when it is not known. */
  default_button?: string | null;
  /** How the default was found: "ring" (blue outline in the screenshot) or "only_button". */
  default_source?: "ring" | "only_button" | null;
  /** Painted dialog with one button read: the button row shows another pill that was not read (so there are more buttons than listed). */
  other_pill_unread?: boolean;
  kind: DialogKind;
  window_rect?: string;
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
  /** The window's DPI from GetDpiForWindow (96 = 100 %); 0 or missing when unknown. */
  dpi?: number;
  first_seen: string;
  caused_by_op: string | null;
  title: string;
  text: string;
  /** True when AE painted the dialog itself: ae_dialog_respond re-reads it and posts a key. */
  painted?: boolean;
  default_button?: string | null;
  /** The button labels as listed, joined with "|". */
  buttons?: string;
  /** What changes the identity of the dialog behind this handle (title, text without digits, buttons). */
  signature?: string;
  /** What the AGENT was last shown by ae_dialogs. Only that handler writes it: a background list must not reset it. */
  shown?: ShownSnapshot;
}

interface ShownSnapshot {
  title: string;
  text: string;
  buttons: string;
  default_button: string | null;
  rect: string;
  /** The agent was shown an AE-painted dialog (OCR buttons). */
  painted: boolean;
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
  /** The window's DPI from GetDpiForWindow (96 = 100 %); 0 or missing when unknown. */
  dpi?: number;
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

/**
 * OCR reads the letter O of "OK" as the digit zero ("0K"). Corrects that one label; any other
 * label is returned unchanged.
 */
export function normalizeOcrLabel(name: string): string {
  const t = (name ?? "").trim();
  if (/^0k$/i.test(t)) return "OK";
  return name;
}

const CANCEL_LIKE = /^(cancel|no|close)$/;
const OK_LIKE = /^(ok|yes|continue)$/;

/** The label the way ae-dialogs.ps1 (Get-NormalizedLabel) compares it: lower-case, 0 read as o, anything but letters and spaces dropped. */
function psLabel(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/0/g, "o").replace(/[^a-z ]/g, "").trim();
}

/**
 * What ae_dialog_respond can press in an AE-painted dialog without focusing AE: Cancel/No/Close are
 * sent as Escape; the DEFAULT button (outlined, `default: true`) or a lone button is sent as Enter when
 * it is OK/Yes/Continue. A dialog whose default could not be identified (no outline found, or no
 * screenshot) can only be cancelled unattended.
 */
export function unattendedAnswers(buttons: DialogButton[]): UnattendedAnswers {
  const labels = buttons.map((b) => psLabel(b.name));
  const answerable: string[] = [];
  const viaEscape: string[] = [];
  let viaEnter: string | null = null;
  const hasCancel = labels.includes("cancel");
  for (let i = 0; i < labels.length; i++) {
    // Escape answers Cancel: with a Cancel on the row, No and Close would be reported pressed but Cancel would be.
    if (CANCEL_LIKE.test(labels[i]) && (labels[i] === "cancel" || !hasCancel)) {
      answerable.push(normalizeOcrLabel(buttons[i].name));
      viaEscape.push(normalizeOcrLabel(buttons[i].name));
    }
  }
  let defaultIdx = buttons.findIndex((b) => b.default === true);
  if (defaultIdx === -1 && buttons.length === 1 && buttons[0].default === undefined) defaultIdx = 0;
  const defaultName = defaultIdx >= 0 ? normalizeOcrLabel(buttons[defaultIdx].name) : null;
  if (defaultIdx >= 0 && OK_LIKE.test(labels[defaultIdx])) {
    answerable.push(normalizeOcrLabel(buttons[defaultIdx].name));
    viaEnter = normalizeOcrLabel(buttons[defaultIdx].name);
  }
  const outlined = buttons.length > 1;
  let note: string;
  if (answerable.length === 0) {
    note = "AE painted this dialog itself and none of its buttons can be pressed without focusing AE: ask the user to answer it.";
  } else if (viaEnter !== null) {
    const which = outlined ? 'its default button "' + viaEnter + '" (outlined)' : 'its only button "' + viaEnter + '"';
    note = "AE painted this dialog itself; " + which + " is answered with Enter";
    if (viaEscape.length > 0) note += ' and "' + viaEscape.join('", "') + '" with Escape';
    note += outlined ? ". Any other button needs the user." : ".";
  } else if (labels.length === 1) {
    note = 'AE painted this dialog itself; its only button "' + viaEscape[0] + '" is answered with Escape.';
  } else if (defaultName !== null) {
    note =
      'AE painted this dialog itself; its default button is "' + defaultName + '", which is not OK, Yes or Continue. ' +
      "Only Cancel/No/Close can be pressed (sent as Escape), so it can only be cancelled unattended; ask the user for anything else.";
  } else {
    note =
      "AE painted this dialog itself and its default button could not be identified. Without focusing AE only Cancel/No/Close can be pressed (sent as Escape), " +
      "so it can only be cancelled unattended; ask the user to click OK or Yes.";
  }
  return { answerable, default_button: defaultName, note };
}

/** What the buttons of a listed dialog say about it (advisory). */
export function dialogKind(buttons: DialogButton[], checkboxes: DialogCheckbox[]): DialogKind {
  if (buttons.some((b) => DESTRUCTIVE_BUTTON_PATTERN.test(b.name ?? ""))) return "destructive";
  if (buttons.length === 1 && checkboxes.length === 0 && OK_LIKE.test(psLabel(buttons[0].name))) return "info";
  return "question";
}

/** Letters and digits of any script only: two OCR reads of the same dialog compare equal even when spacing differs. `ignoreDigits` drops the numbers too (a progress percent moves). */
function textKey(text: string, ignoreDigits = false): string {
  const t = (text ?? "").toLowerCase();
  return ignoreDigits ? t.replace(/[^\p{L}]/gu, "") : t.replace(/[^\p{L}\p{N}]/gu, "");
}

/** A body that talks about replacing or losing something: answering OK on such a dialog is a destructive answer. */
export const DESTRUCTIVE_BODY_PATTERN = /\b(replac|overwrit|delet|discard|revert|remov|eras|lose\b|losing\b|lost\b)/i;

const MAX_PNG_BYTES = 4 * 1024 * 1024;

/** Reads a dialog screenshot for the geometry analysis. Null when it is missing, too big or not a PNG. */
function readPngPixels(file: string | null | undefined): PngPixels | null {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_PNG_BYTES) return null;
    const png = PNG.sync.read(fs.readFileSync(file));
    return { width: png.width, height: png.height, data: png.data };
  } catch {
    return null;
  }
}

function sanitizeOcrLines(value: unknown): OcrLine[] {
  if (!Array.isArray(value)) return [];
  const out: OcrLine[] = [];
  for (const l of value.slice(-60)) {
    const words = Array.isArray(l?.words) ? l.words : [];
    out.push({
      text: typeof l?.text === "string" ? l.text : "",
      words: words.map((w: any) => ({
        text: typeof w?.text === "string" ? w.text : "",
        x: Number(w?.x),
        y: Number(w?.y),
        w: Number(w?.w),
        h: Number(w?.h),
      })),
    });
  }
  return out;
}

function normalizeRawDialog(
  raw: RawPs1Dialog,
  meta: SeenDialogMeta
): EnrichedDialog {
  const rawText = typeof raw.text === "string" ? raw.text : "";
  let boundedText =
    rawText.length > MAX_DIALOG_TEXT_CHARS
      ? rawText.slice(0, MAX_DIALOG_TEXT_CHARS)
      : rawText;

  const r = raw.boundingRect ?? raw.rect ?? {};
  const boundingRect: DialogBoundingRect = {
    x: typeof r.x === "number" ? r.x : 0,
    y: typeof r.y === "number" ? r.y : 0,
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
  };

  let buttons: DialogButton[];
  let defaultButton: string | null = null;
  let defaultSource: "ring" | "only_button" | null = null;
  let otherPillUnread: boolean | undefined;
  let painted = false;
  if (Array.isArray(raw.ocr_lines)) {
    // AE painted this dialog: find the button row and the default button from the OCR boxes and the screenshot.
    painted = true;
    const shot = typeof raw.screenshot === "string" ? raw.screenshot : typeof raw.analysis_png === "string" ? raw.analysis_png : null;
    const pixels = readPngPixels(shot);
    if (typeof raw.analysis_png === "string" && raw.analysis_png.length > 0) {
      try {
        fs.unlinkSync(raw.analysis_png);
      } catch {
        // already gone
      }
    }
    const analysis = analysePaintedDialog(sanitizeOcrLines(raw.ocr_lines), pixels, {
      width: boundingRect.width,
      height: boundingRect.height,
      scale: typeof raw.dpi === "number" && raw.dpi >= 96 && raw.dpi <= 96 * 5 ? raw.dpi / 96 : 1,
    });
    buttons = analysis.buttons.map((b) => {
      const name = normalizeOcrLabel(b.name);
      const btn: DialogButton = { name, automationId: "", enabled: true, source: "ocr" };
      if (name !== b.name) btn.raw_name = b.name;
      if (b.default !== undefined) btn.default = b.default;
      return btn;
    });
    defaultButton = analysis.default_index !== null ? buttons[analysis.default_index].name : null;
    defaultSource = analysis.default_source;
    otherPillUnread = analysis.other_pill_unread;
    // The text above the buttons; when no button row was accepted the whole OCR text stays.
    if (analysis.buttons.length > 0 && raw.text_source === "ocr") {
      boundedText = analysis.body_text.slice(0, MAX_DIALOG_TEXT_CHARS);
    }
  } else {
    const rawButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
    buttons = rawButtons.map((b) => {
      const rawName = typeof b?.name === "string" ? b.name : "";
      const fromOcr = b?.source === "ocr";
      const name = fromOcr ? normalizeOcrLabel(rawName) : rawName;
      const btn: DialogButton = {
        name,
        automationId: typeof b?.automationId === "string" ? b.automationId : "",
        enabled: Boolean(b?.enabled ?? true),
      };
      if (fromOcr) btn.source = "ocr";
      if (fromOcr && name !== rawName) btn.raw_name = rawName;
      return btn;
    });
    // OCR buttons only come with ocr_lines (handled above); an older script's buttons without them are not treated as painted.
    painted = buttons.length > 0 && buttons.every((b) => b.source === "ocr");
  }

  const rawCheckboxes = Array.isArray(raw.checkboxes) ? raw.checkboxes : [];
  const checkboxes: DialogCheckbox[] = rawCheckboxes.map((c) => ({
    name: typeof c?.name === "string" ? c.name : "",
    checked: Boolean(c?.checked),
  }));

  const out: EnrichedDialog = {
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
    kind: dialogKind(buttons, checkboxes),
  };
  if (typeof raw.win_rect === "string" && raw.win_rect.length > 0) out.window_rect = raw.win_rect;
  if (typeof raw.text_source === "string") out.text_source = raw.text_source;
  if (painted) {
    out.unattended = unattendedAnswers(buttons);
    out.default_button = defaultButton;
    out.default_source = defaultSource;
    if (otherPillUnread !== undefined) out.other_pill_unread = otherPillUnread;
  }
  return out;
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

    let nd = normalizeRawDialog(raw, meta);
    // Another dialog (or changed content) behind the same handle is a new dialog: first_seen and caused_by_op start over.
    const signature = [nd.title, textKey(nd.text, true), nd.buttons.map((b) => b.name).join("|")].join("\u0001");
    if (meta.signature !== undefined && meta.signature !== signature) {
      meta.first_seen = now;
      meta.caused_by_op = inFlight;
      nd = normalizeRawDialog(raw, meta);
    }
    meta.signature = signature;
    meta.title = nd.title;
    meta.painted = nd.unattended !== undefined;
    meta.default_button = nd.default_button ?? null;
    meta.buttons = nd.buttons.map((b) => b.name).join("|");
    if (nd.text) meta.text = nd.text;
    result.push(nd);
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
      powershellExe(),
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
  /** The window's DPI from GetDpiForWindow (96 = 100 %); 0 or missing when unknown. */
  dpi?: number;
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
      "Whether to capture a PNG screenshot of each open dialog into %LOCALAPPDATA%/chroma-ae-mcp/dialogs/ (default: true). One file per dialog handle, overwritten on each call."
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
      "Exact button name (case-insensitive). A dialog with real buttons: pressed through UI Automation. An AE-painted dialog: its default button (default_button in ae_dialogs) or Cancel/No/Close."
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


type PaintedDecision =
  | { action: "escape" | "enter"; pressed: string }
  | { action: "refuse"; error: "button_not_default" | "button_not_answerable"; message: string };

/**
 * Which key answers `want` in an AE-painted dialog, from the freshly read button row:
 * Escape for Cancel/No/Close (when that label is on the dialog), Enter for the default button when it
 * is OK/Yes/Continue (the default is the outlined one, or the lone button). Anything else is refused,
 * and a refusal says whether the dialog's default is known.
 */
export function decidePaintedKey(buttons: DialogButton[], want: string): PaintedDecision {
  const wantL = psLabel(want);
  const idx = buttons.findIndex((b) => psLabel(b.name) === wantL);
  if (idx === -1) {
    const names = buttons.map((b) => b.name);
    return {
      action: "refuse",
      error: "button_not_answerable",
      message:
        `"${want}" was NOT pressed: no button with that label was found on the dialog (read: ${names.length > 0 ? names.map((n) => `"${n}"`).join(", ") : "none"}). ` +
        "AE painted this dialog itself: ask the user to answer it.",
    };
  }
  const found = buttons[idx];
  if (CANCEL_LIKE.test(wantL)) {
    // Escape answers Cancel. "No" or "Close" next to a Cancel would report pressed:"No" while Cancel was answered.
    if (wantL !== "cancel" && buttons.some((b) => psLabel(b.name) === "cancel")) {
      return {
        action: "refuse",
        error: "button_not_answerable",
        message:
          `"${found.name}" was NOT pressed: this dialog also has a Cancel button, and the only key that can be sent for it (Escape) answers Cancel. ` +
          "Ask the user to click it.",
      };
    }
    return { action: "escape", pressed: found.name };
  }

  let defaultIdx = buttons.findIndex((b) => b.default === true);
  if (defaultIdx === -1 && buttons.length === 1 && buttons[0].default === undefined) defaultIdx = 0;
  if (defaultIdx === idx) {
    if (OK_LIKE.test(wantL)) return { action: "enter", pressed: found.name };
    return {
      action: "refuse",
      error: "button_not_answerable",
      message:
        `"${found.name}" is the default button but it is not OK, Yes or Continue, so it was NOT pressed. ` +
        "Only OK/Yes/Continue (when default) and Cancel/No/Close can be answered without focusing AE: ask the user.",
    };
  }
  if (defaultIdx >= 0) {
    const d = buttons[defaultIdx].name;
    return {
      action: "refuse",
      error: "button_not_default",
      message:
        `"${found.name}" was NOT pressed: it is not the default button of this AE-painted dialog (the default, outlined button is "${d}"), ` +
        "and only the default button or Cancel can be answered without focusing AE. Ask the user to click it.",
    };
  }
  return {
    action: "refuse",
    error: "button_not_answerable",
    message: `"${found.name}" was NOT pressed. ` + unattendedAnswers(buttons).note,
  };
}

const RESULT_TEXT_CHARS = 500;

export const dialogsTools: ToolDefinition<any>[] = [
  {
    name: "ae_dialogs",
    description:
      "READ-ONLY. Lists modal/popup dialogs currently open in After Effects from outside AE's blocked ExtendScript thread (Windows: UI Automation; macOS: System Events, which needs Accessibility permission for After Effects and gives no screenshots), returning handle, title, class, text, buttons, checkboxes, boundingRect, screenshot path (in %LOCALAPPDATA%/chroma-ae-mcp/dialogs/), first_seen, caused_by_op and kind (info: one OK button, nothing to decide; question; destructive: a button that loses work; advisory only). AE paints many dialogs itself, so UI Automation sees no text or buttons in them; then text and button labels come from OCR of the screenshot (text_source: \"ocr\"; the usual misread 0K is corrected to OK and the original kept as raw_name, other misreads are possible). The button row is the bottom row of the dialog only (a wrapped last line of the message is never a button) and the DEFAULT button is the one outlined in blue (buttons[].default, default_button, default_source \"ring\" or \"only_button\"; null when no outline was found). For those dialogs `unattended` lists the buttons ae_dialog_respond can press: Cancel/No/Close, and the default button when it is OK/Yes/Continue. Look at the screenshot when in doubt. " +
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
      const res = await listDialogsInternal({ screenshots });
      if (res.ok) {
        // What the agent is shown is the baseline ae_dialog_respond compares with. Only this handler sets it:
        // a background list (timeout diagnostics, other tools) must not move it.
        for (const d of res.dialogs) {
          const m = seenDialogs.get(d.handle);
          if (m) {
            m.shown = {
              title: d.title,
              text: d.text,
              buttons: d.buttons.map((b) => b.name).join("|"),
              default_button: d.default_button ?? null,
              rect: d.window_rect ?? "",
              painted: d.unattended !== undefined,
            };
          }
        }
      }
      return res;
    },
  },
  {
    name: "ae_dialog_respond",
    description:
      "Responds to an open After Effects modal dialog by its handle using Windows UI Automation, or on macOS the button's AXPress through System Events (never brings windows to the foreground or moves the mouse; on macOS the handle is window index * 100 + sheet index and the dialog's title must be unchanged). For AE-painted dialogs (OCR buttons) two answers are possible without focusing AE: Cancel/No/Close (sent as Escape) and the DEFAULT button (outlined in blue, see default_button in ae_dialogs; a lone button is its own default) when it is OK/Yes/Continue (sent as Enter). The dialog is read again just before the key and refused with dialog_changed when its title, text, buttons or default differ from what ae_dialogs showed. A button that is not the default returns button_not_default (with the default named), any other case button_not_answerable: both mean it was NOT pressed, so ask Jay to click it. The result carries dialog.title and dialog.text (what the popup said, for example how many frames are missing) and a message: tell Jay what you dismissed. If the key did not close the dialog (closed: false) nothing else is tried: ask Jay. Logs every response to %LOCALAPPDATA%/chroma-ae-mcp/dialogs/responses.jsonl. " +
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
      // Windows: a handle that is not an open AE dialog is never answered (not even through UI Automation).
      if (!meta && currentPlatform() !== "darwin") {
        return { ok: false, error: "dialog_gone", message: `"${args.button}" was NOT pressed: no open After Effects dialog has this handle.`, handle: args.handle, button: args.button };
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

      // A dialog with real buttons (UI Automation, or macOS): OK / Yes / Continue on text about replacing or losing something needs
      // both destructive flags, as on a painted dialog (which has its own gate below, after the fresh read). A lone OK is harmless.
      if (!(meta?.painted || meta?.shown?.painted)) {
        const buttonCount = meta?.buttons ? meta.buttons.split("|").length : 0;
        if (
          buttonCount > 1 &&
          OK_LIKE.test(psLabel(args.button)) &&
          DESTRUCTIVE_BODY_PATTERN.test(meta?.text ?? "") &&
          !(args.allow_destructive === true && (args.user_instruction ?? "").trim().length > 0)
        ) {
          return {
            ok: false,
            error: "refused_destructive_dialog",
            message: `"${args.button}" was NOT pressed: the text of this dialog talks about replacing, overwriting, deleting, discarding, removing, erasing or losing something, so OK or Yes on it needs BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay.`,
            handle: args.handle,
            button: args.button,
          };
        }
      }
      let parsed: Ps1RespondOutput | Record<string, unknown>;
      let shown: EnrichedDialog | null = null;
      if (currentPlatform() === "darwin") {
        // The title and the start of the text guard against another window having taken this index.
        const rawStdout = await runMacScript(["respond", String(args.handle), args.button, args.check ?? "", meta?.title ?? "", (meta?.text ?? "").slice(0, 200)]);
        parsed = parsePs1JsonOutput<Ps1RespondOutput>(rawStdout);
      } else {
        const psArgs = ["-Mode", "respond", "-Handle", String(args.handle), "-Button", args.button];
        let early: Record<string, unknown> | null = null;
        const refuse = (error: string, message: string, extra: Record<string, unknown> = {}) => {
          early = { ok: false, error, message: `"${args.button}" was NOT pressed: ${message}`, handle: args.handle, button: args.button, ...extra };
        };
        if (meta?.painted || meta?.shown?.painted) {
          // AE painted this dialog. Compare with what ae_dialogs showed the agent (title, text, buttons, default,
          // rect), after a fresh read (screenshot, OCR, button row, default) right before the key.
          const seen = meta.shown;
          if (!seen) {
            refuse("dialog_not_listed", "ae_dialogs has not shown this dialog yet. Call ae_dialogs, read it, then answer.");
          } else {
            const fresh = await listDialogsInternal({ screenshots: true });
            if (!fresh.ok) {
              early = { ok: false, error: fresh.error, handle: args.handle, button: args.button };
            } else {
              const d = fresh.dialogs.find((x) => x.handle === args.handle);
              if (!d) {
                early = { ok: false, error: "dialog_gone", handle: args.handle, button: args.button };
              } else if (d.unattended === undefined) {
                refuse("dialog_changed", "this window is no longer an AE-painted dialog the way ae_dialogs showed it. List the dialogs again.");
              } else {
                shown = d;
                const cancelOnly = psLabel(args.button) === "cancel";
                const sameText = textKey(d.text, cancelOnly) === textKey(seen.text, cancelOnly);
                if (
                  d.title !== seen.title ||
                  !sameText ||
                  d.buttons.map((b) => b.name).join("|") !== seen.buttons ||
                  (d.default_button ?? null) !== seen.default_button ||
                  (d.window_rect ?? "") !== seen.rect
                ) {
                  refuse("dialog_changed", "this dialog is not the one ae_dialogs showed (its title, text, buttons, default button or position differ now). List the dialogs again.");
                } else if (fresh.dialogs.length > 1 && fresh.dialogs[0].handle !== args.handle) {
                  refuse("dialog_not_topmost", `another dialog is open above this one ("${fresh.dialogs[0].title}"). Answer the topmost dialog first, or ask the user.`);
                } else {
                  const decision = decidePaintedKey(d.buttons, args.button);
                  if (decision.action === "refuse") {
                    early = {
                      ok: false,
                      error: decision.error,
                      message: decision.message,
                      handle: args.handle,
                      button: args.button,
                      ocr_buttons: d.buttons.map((b) => b.name),
                      default_button: d.default_button ?? null,
                      ...(d.unattended ? { unattended: d.unattended } : {}),
                    };
                  } else if (args.check) {
                    refuse("checkbox_not_found", "an AE-painted dialog has no checkbox that can be toggled without focusing AE.");
                  } else if (decision.action === "enter" && (d.buttons.length > 1 || d.other_pill_unread === true) && DESTRUCTIVE_BODY_PATTERN.test(d.text) && !(args.allow_destructive === true && (args.user_instruction ?? "").trim().length > 0)) {
                    refuse(
                      "refused_destructive_dialog",
                      `the text of this dialog talks about replacing, overwriting, deleting, discarding or losing something, so OK on it needs BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay.`
                    );
                  } else {
                    // A key posted to the dialog's own window; AE keeps its focus state. A focus-taking
                    // fallback (SendKeys) is NOT built: see ae-dialogs.ps1. If the dialog does not close,
                    // the result says closed:false and the caller asks the user.
                    psArgs.push("-Key", decision.action);
                    if (d.title === "") psArgs.push("-ExpectEmptyTitle");
                    else psArgs.push("-ExpectTitle", d.title);
                    if (d.window_rect) psArgs.push("-ExpectRect", d.window_rect);
                  }
                }
              }
            }
          }
        } else {
          // A dialog with real (UI Automation) buttons: the same two guards as the painted path. Only the topmost
          // dialog is answered (the list is topmost first); the script refuses a window that is not enabled.
          const fresh = await listDialogsInternal({ screenshots: false });
          if (fresh.ok && fresh.dialogs.length > 1 && fresh.dialogs[0].handle !== args.handle && fresh.dialogs.some((x) => x.handle === args.handle)) {
            refuse("dialog_not_topmost", `another dialog is open above this one ("${fresh.dialogs[0].title}"). Answer the topmost dialog first, or ask the user.`);
          } else if (args.check) {
            psArgs.push("-Check", args.check);
          }
        }
        parsed = early ?? parsePs1JsonOutput<Ps1RespondOutput>(await runPowerShellScript(psArgs));
      }

      const logTime = currentNowIso();
      const title = shown?.title ?? meta?.title ?? "";
      const textExcerpt = (shown?.text ?? meta?.text ?? "").slice(0, RESULT_TEXT_CHARS);

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

      const res = parsed as { ok?: boolean; error?: string; closed?: boolean; message?: string; method?: string; pressed?: string; ocr_buttons?: unknown };
      const ok = res.ok === true;
      const closed = res.closed === true;
      if (ok && closed) {
        seenDialogs.delete(args.handle);
      }

      if (!ok && res.error === "button_not_answerable" && !res.message) {
        // Say plainly what the AE-painted dialog allows, instead of leaving the caller to guess.
        const ocr = res.ocr_buttons;
        const names = Array.isArray(ocr) ? ocr.filter((n): n is string => typeof n === "string").map(normalizeOcrLabel) : [];
        const fixed: DialogButton[] = names.map((n) => ({ name: n, automationId: "", enabled: true }));
        const un = fixed.length > 0 ? unattendedAnswers(fixed) : undefined;
        const why = un ? un.note : "AE painted this dialog itself and it cannot be answered without focusing AE: ask the user to answer it.";
        return { ...parsed, ocr_buttons: names, ...(un ? { unattended: un } : {}), message: `"${args.button}" was NOT pressed. ${why}` };
      }

      if (ok && shown && res.method) {
        const said = shown.text.slice(0, RESULT_TEXT_CHARS);
        const pressed = res.pressed ?? args.button;
        const message = closed
          ? `Pressed "${pressed}" (${res.method}) on the AE dialog "${shown.title}". It said: ${said} Tell the user what it said.`
          : `Sent the key (${res.method}) for "${pressed}" but the dialog "${shown.title}" did not close within 3 s. Nothing else was tried: ask the user. It said: ${said}`;
        return {
          ...parsed,
          dialog: { title: shown.title, text: said },
          default_button: shown.default_button ?? null,
          message,
        };
      }

      return parsed;
    },
  },
];
