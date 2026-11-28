import { powershellExe } from "../../win-exe.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defaultDataDir } from "../../quarantine.js";
import { renderGate } from "../../render-gate.js";
import {
  AGENT_SAFETY_GUIDANCE,
  type CepExtensionInfo,
  type ToolDefinition,
} from "../common.js";
import { locateDialogsPs1Script, locateToolScript, parsePs1JsonOutput } from "./dialogs.js";

export const CURATED_NATIVE_PANELS = [
  "Align",
  "Audio",
  "Brushes",
  "Character",
  "Content-Aware Fill",
  "Effects & Presets",
  "Essential Graphics",
  "Essential Properties",
  "Info",
  "Learn",
  "Libraries",
  "Lumetri Scopes",
  "Mask Interpolation",
  "Media Browser",
  "Motion Sketch",
  "Paint",
  "Paragraph",
  "Preview",
  "Progress",
  "Properties",
  "Smoother",
  "Tracker",
  "Wiggler",
] as const;

export type NativePanelName = (typeof CURATED_NATIVE_PANELS)[number];

export interface Ps1ScreenshotOutputSuccess {
  ok: true;
  path: string;
  width: number;
  height: number;
  handle?: number;
}

export interface Ps1ScreenshotOutputError {
  ok: false;
  error: string;
}

export type Ps1ScreenshotOutput =
  | Ps1ScreenshotOutputSuccess
  | Ps1ScreenshotOutputError;

export type Ps1RunnerFn = (args: string[]) => Promise<string>;

interface PanelsRuntimeOverrides {
  platform?: NodeJS.Platform;
  ps1Runner?: Ps1RunnerFn;
  /** Replaces the macOS window lookup and capture (tests). */
  macCapture?: (outDir: string) => Promise<Record<string, unknown>>;
  uiDir?: string;
  scriptPath?: string | null;
}

let runtimeOverrides: PanelsRuntimeOverrides = {};

export function setPanelsTestOverrides(
  overrides: PanelsRuntimeOverrides
): void {
  runtimeOverrides = { ...overrides };
}

export function resetPanelsTestOverrides(): void {
  runtimeOverrides = {};
}

function currentPlatform(): NodeJS.Platform {
  return runtimeOverrides.platform ?? process.platform;
}

export function defaultUiDir(): string {
  if (runtimeOverrides.uiDir) {
    return runtimeOverrides.uiDir;
  }
  return path.join(defaultDataDir(), "ui");
}

export function parseCepExtensions(raw: string | unknown[]): CepExtensionInfo[] {
  let list: unknown[];
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null
    )
    .map((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : id;
      const entry: CepExtensionInfo = { id, name };
      if (typeof item.mainPath === "string") entry.mainPath = item.mainPath;
      if (typeof item.type === "string") entry.type = item.type;
      return entry;
    });
}

function execText(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = typeof stdout === "string" ? stdout.trim() : "";
      if (err && !out) resolve({ ok: false, stdout: "", error: (typeof stderr === "string" && stderr.trim()) || (err instanceof Error ? err.message : String(err)) });
      else resolve({ ok: true, stdout: out });
    });
  });
}

/** Width and height from a PNG's IHDR chunk, or null. */
export function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * macOS: finds After Effects' main window through CoreGraphics (panel/tools/ae-window-mac.js) and
 * records that one window with `screencapture -x -o -l <id>`, which neither activates AE nor
 * moves anything. Needs Screen Recording permission for After Effects (the panel's app).
 */
async function captureMacMainWindow(outDir: string): Promise<Record<string, unknown>> {
  if (runtimeOverrides.macCapture) return runtimeOverrides.macCapture(outDir);
  const script = locateToolScript("ae-window-mac.js");
  if (!script) return { ok: false, error: "ae_window_mac_script_not_found" };
  // Two tries: the window id can change while AE redraws (a workspace change, a panel opening), and a capture
  // started just then fails with "could not create image from window" (seen once in a live smoke run).
  let lastError = "screencapture_failed";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const found = await execText("osascript", ["-l", "JavaScript", script, "main"]);
    if (!found.ok) return { ok: false, error: found.error ?? "osascript_exec_failed" };
    const info = parsePs1JsonOutput<{ ok: boolean; error?: string; can_record?: boolean; locked?: boolean; asleep?: boolean; window?: { window_id: number; onscreen: boolean } }>(found.stdout);
    if (info.locked === true || info.asleep === true) return { ok: false, error: "screen_locked_or_asleep" };
    if (!info.ok || !info.window) return { ok: false, error: info.error ?? "ae_window_not_found" };
    if (info.can_record === false) return { ok: false, error: "screen_recording_permission_needed" };
    if (!info.window.onscreen) return { ok: false, error: "ae_minimized" };
    const out = path.join(outDir, `ae_main_${Date.now()}.png`);
    const shot = await execText("/usr/sbin/screencapture", ["-x", "-o", "-l", String(info.window.window_id), out]);
    const size = pngSize(out);
    if (shot.ok && size) return { ok: true, path: out, width: size.width, height: size.height };
    lastError = shot.error ? `screencapture_failed: ${shot.error}` : "screencapture_failed";
    try {
      fs.rmSync(out, { force: true });
    } catch {}
    if (attempt === 1) await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: lastError };
}

function runPowerShellScript(ps1Args: string[]): Promise<string> {
  if (runtimeOverrides.ps1Runner) {
    return runtimeOverrides.ps1Runner(ps1Args);
  }

  const scriptPath =
    runtimeOverrides.scriptPath !== undefined
      ? runtimeOverrides.scriptPath
      : locateDialogsPs1Script();

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
        timeout: 15_000,
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

export const AeListPanelsSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe(
      "Optional filter: 'native' for native panels only, 'extensions' for CEP extensions only, or a search substring matching panel names or IDs."
    ),
});

export const AeOpenPanelSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Native After Effects panel name from the Window menu (e.g. 'Effects & Presets', 'Align', 'Character'). NOTE: Window menu commands toggle the panel (open if closed, close if open) and scripting cannot query their open state. Opening a native panel requires allow_toggle: true after visually verifying via ae_ui_screenshot that the panel is currently closed."
      ),
    extension_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "ID of a CEP extension to open (e.g. 'london.chroma.aemcp.panel'). Opening a CEP extension never toggles."
      ),
    allow_toggle: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Must be set to true to execute native Window menu panel commands. Because Window menu commands toggle (they close the panel if it is already open) and scripting cannot detect panel state, you must first take a screenshot with ae_ui_screenshot to verify the panel is closed before passing allow_toggle: true."
      ),
  })
  .refine((val) => Boolean(val.name || val.extension_id), {
    message:
      "Must specify either 'name' (for a native panel) or 'extension_id' (for a CEP extension).",
  });

export const AeUiScreenshotSchema = z.object({});

export const panelsTools: ToolDefinition<any>[] = [
  {
    name: "ae_list_panels",
    description:
      "READ-ONLY. Lists installed CEP extensions and native After Effects Window-menu panels with their ExtendScript command IDs (cmdId). Note: Native Window-menu commands toggle and their open/closed state cannot be queried via scripting; use ae_ui_screenshot to verify visibility. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeListPanelsSchema,
    handler: async (args, ctx) => {
      // Calls CEP directly and then After Effects: not proven safe while a render holds AE.
      renderGate.check();
      if (!ctx.cep) {
        return { ok: false, error: "cep_unavailable" };
      }

      // 1. CEP extensions excluding london.chroma.aemcp.service
      const rawExts = await ctx.cep.listExtensions();
      const allExts = (Array.isArray(rawExts) ? rawExts : [])
        .filter(
          (ext) => ext && ext.id && ext.id !== "london.chroma.aemcp.service"
        )
        .map((ext) => ({
          id: ext.id,
          name: ext.name || ext.id,
        }));

      // 2. Curated native panels queried in ONE ExtendScript call
      const jsxScript =
        "(function(){\n" +
        "var names=" +
        JSON.stringify(CURATED_NATIVE_PANELS) +
        ";\n" +
        "var out=[];\n" +
        "for(var i=0;i<names.length;i++){\n" +
        "var id=app.findMenuCommandId(names[i]);\n" +
        "if(id!==0){\n" +
        "out.push({name:names[i],cmdId:id});\n" +
        "}\n" +
        "}\n" +
        "return out;\n" +
        "})()";

      const nativeRes = await ctx.bridge.evalRaw<
        Array<{ name: string; cmdId: number }>
      >({
        id: ctx.bridge.newOpId(),
        script: jsxScript,
        label: "ae_list_panels(native)",
        mutates: false,
        toolName: "ae_list_panels",
      });

      const allNative = Array.isArray(nativeRes.result)
        ? nativeRes.result
        : [];

      // 3. Apply filter if present
      const filter =
        typeof args.filter === "string" ? args.filter.trim() : "";
      if (filter.length > 0) {
        const lowerFilter = filter.toLowerCase();
        if (lowerFilter === "native") {
          return {
            ok: true,
            extensions: [],
            native: allNative,
          };
        }
        if (lowerFilter === "extensions" || lowerFilter === "extension") {
          return {
            ok: true,
            extensions: allExts,
            native: [],
          };
        }
        return {
          ok: true,
          extensions: allExts.filter(
            (e) =>
              e.name.toLowerCase().includes(lowerFilter) ||
              e.id.toLowerCase().includes(lowerFilter)
          ),
          native: allNative.filter((n) =>
            n.name.toLowerCase().includes(lowerFilter)
          ),
        };
      }

      return {
        ok: true,
        extensions: allExts,
        native: allNative,
      };
    },
  },
  {
    name: "ae_open_panel",
    description:
      "Opens an After Effects CEP extension or native Window-menu panel. CEP extensions (via extension_id) open directly and never toggle. IMPORTANT: Native Window-menu commands (via name) toggle (calling them when already open will close the panel). To prevent accidental closure, opening a native panel without allow_toggle: true is refused. First use ae_ui_screenshot to verify the panel is closed, then pass allow_toggle: true. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeOpenPanelSchema,
    handler: async (args, ctx) => {
      // Calls CEP directly (extension_id) or After Effects (name): not proven safe while a render holds AE.
      renderGate.check();
      if (args.extension_id) {
        if (!ctx.cep) {
          return { ok: false, error: "cep_unavailable" };
        }
        const opened = await ctx.cep.openExtension(args.extension_id);
        return {
          ok: true,
          extension_id: args.extension_id,
          opened: Boolean(opened),
        };
      }

      if (args.name) {
        if (args.allow_toggle !== true) {
          return {
            ok: false,
            error: "refused_toggle_risk",
            message:
              `Refused to execute Window menu command for "${args.name}": Window-menu commands toggle After Effects panels and scripting cannot query whether the panel is currently open or closed. ` +
              `Executing this command when the panel is already open will close it. ` +
              `First use ae_ui_screenshot to verify that "${args.name}" is closed, then call ae_open_panel with allow_toggle: true.`,
          };
        }

        const jsxScript =
          "(function(){\n" +
          "var cmdId=app.findMenuCommandId(" +
          JSON.stringify(args.name) +
          ");\n" +
          "if(!cmdId||cmdId===0){\n" +
          "return {ok:false,error:'unknown_menu_command'};\n" +
          "}\n" +
          "app.executeCommand(cmdId);\n" +
          "return {ok:true,cmdId:cmdId};\n" +
          "})()";

        const res = await ctx.bridge.evalRaw<{
          ok: boolean;
          cmdId?: number;
          error?: string;
        }>({
          id: ctx.bridge.newOpId(),
          script: jsxScript,
          label: `ae_open_panel(${args.name})`,
          mutates: false,
          toolName: "ae_open_panel",
        });

        if (!res.result || !res.result.ok) {
          return {
            ok: false,
            error: res.result?.error || "command_failed",
            name: args.name,
            message: `Menu command "${args.name}" was not recognized by After Effects (findMenuCommandId returned 0).`,
          };
        }

        return {
          ok: true,
          cmdId: res.result.cmdId,
          executed: true,
          note: "Window commands toggle; verify with ae_ui_screenshot",
        };
      }

      return {
        ok: false,
        error: "invalid_arguments",
        message:
          "Must specify either 'name' (for a native panel) or 'extension_id' (for a CEP extension).",
      };
    },
  },
  {
    name: "ae_ui_screenshot",
    description:
      "READ-ONLY. Captures a PNG screenshot of After Effects' main window (Windows: window class AE_CApplication_* via Win32 PrintWindow; macOS: screencapture of that one window) into the data dir's ui/ folder without bringing the window to the foreground or activating it. Returns { ok: true, path, width, height }. Use this to visually verify panel open/closed visibility because native Window-menu commands toggle and their state cannot be read via scripting. " +
      "When AE is minimized (on macOS also: on another desktop) it returns `error: 'ae_minimized'` instead of an image: ask the user to restore the window (this tool never does). On macOS `screen_recording_permission_needed` means After Effects needs Screen Recording in System Settings > Privacy & Security. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeUiScreenshotSchema,
    handler: async () => {
      const platform = currentPlatform();
      if (platform !== "win32" && platform !== "darwin") {
        return {
          ok: false,
          error: "not_implemented_on_this_os",
        };
      }

      const outDir = defaultUiDir();
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch {}

      if (platform === "darwin") {
        const r = await captureMacMainWindow(outDir);
        if (r.ok === true) return { ok: true, path: r.path, width: r.width, height: r.height };
        if (r.error === "ae_minimized") {
          return {
            ok: false,
            error: "ae_minimized",
            message: "The After Effects window is minimized or on another desktop, so macOS has nothing to capture. Ask the user to bring it back, then try again.",
          };
        }
        if (r.error === "screen_locked_or_asleep") {
          return {
            ok: false,
            error: "screen_locked_or_asleep",
            message: "The Mac's screen is locked or its display is asleep, so macOS gives no image of any window. Try again when the user is back at the screen.",
          };
        }
        if (r.error === "screen_recording_permission_needed") {
          return {
            ok: false,
            error: "screen_recording_permission_needed",
            message: "macOS needs Screen Recording permission for After Effects: System Settings > Privacy & Security > Screen Recording, turn on After Effects, then restart it.",
          };
        }
        return { ok: false, error: String(r.error ?? "screenshot_failed") };
      }

      const rawStdout = await runPowerShellScript([
        "-Mode",
        "screenshot-main",
        "-OutDir",
        outDir,
      ]);

      const parsed = parsePs1JsonOutput<Ps1ScreenshotOutput>(rawStdout);

      if (!parsed.ok) {
        if (parsed.error === "ae_minimized") {
          return {
            ok: false,
            error: "ae_minimized",
            message:
              "After Effects is minimized, so Windows only draws its title bar. Ask the user to restore the AE window, then try again.",
          };
        }
        return {
          ok: false,
          error: parsed.error || "screenshot_failed",
        };
      }

      return {
        ok: true,
        path: parsed.path,
        width: parsed.width,
        height: parsed.height,
      };
    },
  },
];
