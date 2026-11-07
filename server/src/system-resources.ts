/**
 * server/src/system-resources.ts
 *
 * Warns before a heavy render when the GPU is nearly full or another app that
 * keeps a lot of GPU memory (Cinema 4D, Blender, Houdini ...) is running.
 *
 * - Windows: panel/tools/resource-probe.ps1 reads the GPU memory counters and
 *   the process list (no install, no elevation, nothing about After Effects).
 * - macOS: only the process list (`ps`); no GPU figure, so no GPU warning.
 * - Anything else, or a probe that fails: an empty report, no error text.
 *
 * It never uses the eval queue or the bridge, so it works while After Effects
 * is busy, and it never throws. Results are cached for 10 s and one probe
 * runs at a time. Warnings are advice only: no tool refuses because of them.
 *
 * The thresholds are guesses to calibrate on a live machine. The per-process
 * counter can read more than the card holds (measured), so it ranks apps and
 * is never printed above the card's total.
 *
 * Not measured live: process names of the apps, which counter instance is
 * which adapter (the largest total is paired with the busiest adapter).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { powershellExe } from "./win-exe.js";

// ---------- constants ----------

/** Adapter use at or above this share of its memory: level "warn". Guess. */
export const GPU_WARN_FRACTION = 0.85;
/** At or above this share, or with less free than GPU_HIGH_FREE_MB: level "high". Guess. */
export const GPU_HIGH_FRACTION = 0.93;
export const GPU_HIGH_FREE_MB = 1536;
/** A listed app that holds at least this much GPU memory is worth a warning even when the card has room. Guess. */
export const APP_GPU_WARN_MB = 1024;
export const CACHE_MS = 10_000;
export const PROBE_TIMEOUT_MS = 5000;

/** Other apps that compete for the GPU. Process names, case-insensitive. Names are from memory: verify live. */
export const GPU_HEAVY_APPS: Array<{ label: string; match: RegExp; generic?: boolean }> = [
  { label: "Cinema 4D", match: /^Cinema 4D$/i },
  { label: "Cinema 4D (Commandline renderer)", match: /^Commandline$/i, generic: true },
  { label: "Cinema 4D (c4dpy)", match: /^c4dpy$/i },
  { label: "Redshift", match: /^redshift/i },
  { label: "Blender", match: /^blender$/i },
  { label: "Houdini", match: /^(houdini|houdinifx|hbatch|husk)$/i },
  { label: "Maya", match: /^(maya|mayabatch)$/i },
  { label: "Unreal Engine", match: /^UnrealEditor/i },
  { label: "DaVinci Resolve", match: /^Resolve$/i },
  { label: "Premiere Pro", match: /^Adobe Premiere Pro$/i },
  { label: "Media Encoder", match: /^Adobe Media Encoder$/i },
];
/** After Effects' own processes: listed, never a competitor. */
export const AE_PROCESSES = /^(AfterFX|aerender)$/i;

// ---------- shapes ----------

export interface RawProbe {
  /** The probe ran. The GPU counters may still be missing (see `counters`); the process list is used either way. */
  ok: boolean;
  /** false: the GPU counters could not be read (older Windows, or localized counter names). Absent: as `ok`. */
  counters?: boolean;
  error?: string;
  adapters: Array<{ luid: string; used_mb: number }>;
  totals: Array<{ name: string; total_mb: number }>;
  processes: Array<{ pid: number; name: string; gpu_mb: number | null }>;
}

export type ResourceLevel = "ok" | "warn" | "high";

export interface GpuReading {
  adapter: string | null;
  used_mb: number;
  total_mb: number | null;
  used_pct: number | null;
  level: ResourceLevel;
}

export interface HeavyApp {
  name: string;
  label: string;
  pid: number;
  /** Only when it is believable (not above what the adapter uses). The per-process counter can read more than the card holds. */
  gpu_mb?: number;
  /** The process reported a GPU figure that cannot be true; it is kept out and only used to rank. */
  gpu_figure_unreliable?: true;
  /** After Effects' own process. */
  ae?: boolean;
  /** Only a generic process name matched. */
  possibly?: boolean;
}

export interface ResourceReport {
  /** GPU counters were readable. */
  supported: boolean;
  sampled_at: string;
  gpu: GpuReading | null;
  heavy_apps: HeavyApp[];
  warnings: string[];
  level: ResourceLevel;
  /** After Effects holds most of the GPU memory that is in use (no other app does). */
  ae_holds_most: boolean;
  probe_error?: string;
}

const EMPTY = (now: number, error?: string): ResourceReport => ({
  supported: false,
  sampled_at: new Date(now).toISOString(),
  gpu: null,
  heavy_apps: [],
  warnings: [],
  level: "ok",
  ae_holds_most: false,
  ...(error ? { probe_error: error.slice(0, 200) } : {}),
});

// ---------- pure logic ----------

const gb = (mb: number) => (mb / 1024).toFixed(1);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface ClassifyOptions {
  now?: number;
}

/** Turns a probe's raw reading into the report. Pure; never throws. */
export function classifyResources(raw: RawProbe | null | undefined, opts: ClassifyOptions = {}): ResourceReport {
  const now = opts.now ?? Date.now();
  if (!raw) return EMPTY(now);

  const countersOk = raw.counters !== false && raw.ok === true;
  const adapters = countersOk ? (Array.isArray(raw.adapters) ? raw.adapters : []).filter((a) => num(a?.used_mb) !== null) : [];
  const totals = (Array.isArray(raw.totals) ? raw.totals : []).filter((t) => num(t?.total_mb) !== null && (t.total_mb as number) > 0);
  let gpu: GpuReading | null = null;
  if (adapters.length > 0) {
    const busiest = adapters.reduce((a, b) => (b.used_mb > a.used_mb ? b : a));
    // The counter instances carry no name, so an adapter cannot be matched to a memory total. A percentage is given only when
    // there is exactly one total and the busiest adapter uses no more than it; with two cards, or a figure above the card, none.
    const only = totals.length === 1 && busiest.used_mb <= totals[0].total_mb ? totals[0] : null;
    const pct = only ? busiest.used_mb / only.total_mb : null;
    let level: ResourceLevel = "ok";
    if (pct !== null && only) {
      if (pct >= GPU_HIGH_FRACTION) level = "high";
      else if (pct >= GPU_WARN_FRACTION) level = only.total_mb - busiest.used_mb < GPU_HIGH_FREE_MB ? "high" : "warn";
    }
    gpu = {
      adapter: only ? only.name : null,
      used_mb: Math.round(busiest.used_mb),
      total_mb: only ? Math.round(only.total_mb) : null,
      used_pct: pct !== null ? Math.round(pct * 1000) / 10 : null,
      level,
    };
  }

  // Per-process figures: believable only when they do not exceed what the adapter uses; otherwise they only rank.
  const believable = (mb: number | null) => gpu !== null && mb !== null && mb <= gpu.used_mb;
  const ranked: Array<{ app: HeavyApp; mb: number | null }> = [];
  for (const p of Array.isArray(raw.processes) ? raw.processes : []) {
    if (!p || typeof p.name !== "string" || typeof p.pid !== "number") continue;
    const mb = num(p.gpu_mb);
    const ae = AE_PROCESSES.test(p.name);
    const hit = ae ? null : GPU_HEAVY_APPS.find((a) => a.match.test(p.name));
    if (!ae && !hit) continue;
    const app: HeavyApp = ae ? { name: p.name, label: "After Effects", pid: p.pid, ae: true } : { name: p.name, label: (hit as { label: string }).label, pid: p.pid, ...(hit?.generic ? { possibly: true } : {}) };
    if (mb !== null) {
      if (believable(mb)) app.gpu_mb = Math.round(mb);
      else app.gpu_figure_unreliable = true;
    }
    ranked.push({ app, mb });
  }
  ranked.sort((a, b) => (b.mb ?? -1) - (a.mb ?? -1));
  const heavy = ranked.slice(0, 20).map((x) => x.app);

  const aeMb = Math.max(0, ...heavy.filter((a) => a.ae).map((a) => a.gpu_mb ?? 0));
  const otherMb = Math.max(0, ...heavy.filter((a) => !a.ae).map((a) => a.gpu_mb ?? 0));
  const aeHolds = gpu !== null && aeMb > 0 && aeMb >= otherMb && aeMb >= 0.5 * gpu.used_mb;

  const level: ResourceLevel = gpu ? gpu.level : "ok";
  const report: ResourceReport = {
    supported: gpu !== null,
    sampled_at: new Date(now).toISOString(),
    gpu,
    heavy_apps: heavy,
    warnings: [],
    level,
    ae_holds_most: aeHolds,
    ...(raw.error ? { probe_error: raw.error.slice(0, 200) } : {}),
  };
  report.warnings = buildWarnings(report, "render");
  return report;
}

function buildWarnings(r: ResourceReport, purpose: "status" | "render"): string[] {
  const out: string[] = [];
  const gpu = r.gpu;
  const others = r.heavy_apps.filter((a) => a.ae !== true);
  const aeTop = Math.max(0, ...r.heavy_apps.filter((a) => a.ae === true).map((a) => a.gpu_mb ?? 0));
  const pressure = gpu !== null && gpu.level !== "ok";
  // Named as the one holding the largest share only when its figure is believable, big, and more than After Effects' own.
  const top = others.find((a) => a.gpu_mb !== undefined && a.gpu_mb >= APP_GPU_WARN_MB && a.gpu_mb > aeTop) ?? null;

  if (gpu && pressure && gpu.total_mb !== null && gpu.used_pct !== null) {
    let line = `GPU memory is ${Math.round(gpu.used_pct)} % full (${gb(gpu.used_mb)} of ${gb(gpu.total_mb)} GB).`;
    if (top) line += ` ${top.label} (pid ${top.pid})${top.possibly ? " possibly" : ""} is running and holds the largest share.`;
    else if (r.ae_holds_most) line += " After Effects itself holds most of it.";
    if (purpose === "render") line += others.length > 0 ? " A render now may be slow or fail. Close or pause the other app, or tell me to go on." : " A render now may be slow or fail. Tell me to go on, or free GPU memory first.";
    else line += " A heavy render now may be slow or fail.";
    out.push(line);
  }
  // No GPU reading (other-language Windows, macOS, no counters): the process list still works, so a render still hears that
  // another heavy renderer is running, without any figure.
  const unread = gpu === null && purpose === "render";
  for (const a of others) {
    const big = a.gpu_mb !== undefined && a.gpu_mb >= APP_GPU_WARN_MB;
    if (!big && !pressure && !unread) continue;
    if (top && a === top && out.length > 0) continue; // already named above
    const use = a.gpu_mb !== undefined ? ` and uses about ${gb(a.gpu_mb)} GB of GPU memory` : "";
    const noFigure = unread ? " Its GPU use could not be read on this machine; a render now may be slow or fail." : "";
    out.push(`${a.label} is running (pid ${a.pid})${a.possibly ? ", possibly" : ""}${use}.${noFigure}`);
    if (out.length >= 4) break;
  }
  return out;
}

/** The warning lines for a purpose: "render" ends with what to do, "status" is plain. */
export function resourceWarnings(report: ResourceReport, purpose: "status" | "render"): string[] {
  try {
    return buildWarnings(report, purpose);
  } catch {
    return [];
  }
}

// ---------- the probe ----------

export interface ResourceDeps {
  /** Runs the platform's probe. May throw or return null: both mean no reading. */
  run: (platform: NodeJS.Platform) => Promise<RawProbe | null>;
  now: () => number;
  platform: () => NodeJS.Platform;
}

export function locateProbe(): string | null {
  const starts: string[] = [];
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) starts.push(__dirname);
  } catch {
    // ESM: no __dirname
  }
  try {
    if (typeof import.meta?.url === "string" && import.meta.url.startsWith("file:")) starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundled without import.meta
  }
  starts.push(process.cwd());
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = path.resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      for (const rel of [path.join("panel", "tools"), "tools"]) {
        const p = path.join(dir, rel, "resource-probe.ps1");
        if (fs.existsSync(p)) return p;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (_err, stdout) => resolve(typeof stdout === "string" ? stdout : ""));
  });
}

/** The last line of the output that parses as a JSON object. */
export function parseProbeOutput(text: string): RawProbe | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].charAt(0) !== "{") continue;
    try {
      const v = JSON.parse(lines[i]) as Record<string, unknown>;
      const arr = (x: unknown) => (Array.isArray(x) ? x : x && typeof x === "object" ? [x] : []);
      return {
        ok: v.ok === true,
        ...(typeof v.counters === "boolean" ? { counters: v.counters } : {}),
        ...(typeof v.error === "string" ? { error: v.error } : {}),
        adapters: arr(v.adapters) as RawProbe["adapters"],
        totals: arr(v.totals) as RawProbe["totals"],
        processes: arr(v.processes) as RawProbe["processes"],
      };
    } catch {
      // not JSON
    }
  }
  return null;
}

/** The apps from a `ps -axo pid=,comm=` listing whose name matches. */
export function parsePsOutput(text: string, pattern: RegExp): RawProbe["processes"] {
  const processes: RawProbe["processes"] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = path.basename(m[2].trim());
    if (pattern.test(name)) processes.push({ pid: Number(m[1]), name, gpu_mb: null });
    if (processes.length >= 50) break;
  }
  return processes;
}

/** The probe of each platform. Tests replace `resourceDeps.run` (test/setup-resources.ts does it for every test file). */
export async function defaultRun(platform: NodeJS.Platform): Promise<RawProbe | null> {
  const pattern = [...GPU_HEAVY_APPS.map((a) => a.match.source), AE_PROCESSES.source].join("|");
  if (platform === "win32") {
    const script = locateProbe();
    if (!script) return null;
    return parseProbeOutput(await execText(powershellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Pattern", pattern]));
  }
  if (platform === "darwin") {
    // No GPU figure on macOS: ok, with no adapters.
    return { ok: true, counters: false, adapters: [], totals: [], processes: parsePsOutput(await execText("ps", ["-axo", "pid=,comm="]), new RegExp(pattern, "i")) };
  }
  return null;
}

export const resourceDeps: ResourceDeps = {
  run: defaultRun,
  now: () => Date.now(),
  platform: () => process.platform,
};

let cached: { at: number; report: ResourceReport } | null = null;
let inflight: Promise<ResourceReport> | null = null;

/** Test hook: forget the cache. */
export function resetResourceCache(): void {
  cached = null;
  inflight = null;
}

/**
 * The current report. Cached for 10 s, one probe at a time, 5 s at most, and
 * never throws: a failed probe gives an empty report. Does not use the eval queue.
 */
export async function readResources(): Promise<ResourceReport> {
  const now = resourceDeps.now();
  if (cached && now - cached.at < CACHE_MS) return cached.report;
  if (inflight) return inflight;
  inflight = (async (): Promise<ResourceReport> => {
    let report: ResourceReport;
    try {
      const platform = resourceDeps.platform();
      if (platform !== "win32" && platform !== "darwin") report = EMPTY(resourceDeps.now());
      else {
        let timer: NodeJS.Timeout | undefined;
        const raw = await Promise.race([
          resourceDeps.run(platform).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS + 500);
          }),
        ]);
        if (timer) clearTimeout(timer);
        report = classifyResources(raw, { now: resourceDeps.now() });
      }
    } catch {
      report = EMPTY(resourceDeps.now());
    }
    cached = { at: resourceDeps.now(), report };
    return report;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** For a render tool: the warning lines to put in `resource_warnings`, empty when nothing applies. Never throws. */
export async function resourceWarningsForRender(): Promise<string[]> {
  try {
    return resourceWarnings(await readResources(), "render");
  } catch {
    return [];
  }
}

/**
 * For ae_status { detail: true }, as `detail.resources`: the report with the
 * status wording of its warnings. Never throws and answers within about 5 s
 * (cached for 10 s); a machine without counters gives `supported: false` and no text.
 */
export async function resourcesForStatus(): Promise<ResourceReport> {
  try {
    const r = await readResources();
    return { ...r, warnings: resourceWarnings(r, "status") };
  } catch {
    return EMPTY(Date.now());
  }
}
