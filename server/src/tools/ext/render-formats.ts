/**
 * server/src/tools/ext/render-formats.ts
 *
 * What each output module template writes, so an agent can turn "a web H.264", "a master with alpha"
 * or "a TIFF sequence" into a template name, and the render tools can give the output the right
 * extension.
 *
 * A script cannot read or set an output module's codec (Format is read-only and no setting names the
 * codec, measured on AE 26.2.1), so nothing here claims a codec: each template is measured as it is
 * (format, alpha, sequence, audio, depth; H.264 bitrate from its name) by panel/host/ext/production.jsx
 * renderFormatCatalog on a temporary render-queue item. Templates are machine-wide preferences, so the
 * catalog is kept per After Effects version, in memory and in render-formats.json in the data folder:
 * aerender (which needs a clean project) can then use it without a temporary item.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultDataDir } from "../../quarantine.js";

export interface FormatEntry {
  name: string;
  format?: string;
  extension?: string | null;
  video?: boolean;
  alpha?: boolean;
  alpha_only?: boolean;
  sequence?: boolean;
  audio?: string;
  depth?: string;
  bitrate_mbps?: number;
  error?: string;
}

export interface FormatCatalog {
  ae_version: string;
  measured_at: string;
  templates: FormatEntry[];
}

/** Template names grouped by what they write, for picking one by intent. Each list may hold several: the agent picks by name. */
export interface FormatIntents {
  h264: Array<{ name: string; bitrate_mbps?: number }>;
  quicktime: string[];
  quicktime_alpha: string[];
  image_sequence: Array<{ name: string; extension: string | null | undefined; alpha: boolean }>;
  audio_only: string[];
  alpha_only: string[];
  other: string[];
}

const memory = new Map<string, FormatCatalog>();

/** Where the cache file lives when no data dir is given; tests point it at a temporary folder. */
export const renderFormatsDeps: { dataDir: string | undefined } = { dataDir: undefined };

function cachePath(dataDir?: string): string {
  return path.join(dataDir ?? renderFormatsDeps.dataDir ?? defaultDataDir(), "render-formats.json");
}

export function rememberCatalog(cat: FormatCatalog, dataDir?: string): void {
  memory.set(cat.ae_version, cat);
  try {
    const file = cachePath(dataDir);
    let all: Record<string, FormatCatalog> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      all = {};
    }
    all[cat.ae_version] = cat;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 1), "utf8");
  } catch {
    // The memory copy still serves this session.
  }
}

export function cachedCatalog(aeVersion: string | undefined, dataDir?: string): FormatCatalog | null {
  if (!aeVersion) return null;
  const hit = memory.get(aeVersion);
  if (hit) return hit;
  try {
    const all = JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8")) as Record<string, FormatCatalog>;
    const cat = all[aeVersion];
    if (cat && Array.isArray(cat.templates)) {
      memory.set(aeVersion, cat);
      return cat;
    }
  } catch {
    // no cache yet
  }
  return null;
}

/** The newest catalog on record, any version (template formats rarely change between versions). */
export function latestCatalog(dataDir?: string): FormatCatalog | null {
  let all: FormatCatalog[] = [...memory.values()];
  try {
    all = all.concat(Object.values(JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8")) as Record<string, FormatCatalog>));
  } catch {
    // no cache file
  }
  return all.filter((c) => c && Array.isArray(c.templates)).sort((a, b) => String(b.measured_at).localeCompare(String(a.measured_at)))[0] ?? null;
}

/** The catalog for the After Effects this server talks to (serviceInfo's aeVersion), else the newest one. */
export function catalogFor(ctx: { serviceInfo?: () => Record<string, unknown>; dataDir?: string }): FormatCatalog | null {
  const v = ctx.serviceInfo?.()?.aeVersion;
  return cachedCatalog(typeof v === "string" ? v : undefined, ctx.dataDir) ?? latestCatalog(ctx.dataDir);
}

/** For tests: the memory copies and the cache file in renderFormatsDeps.dataDir. */
export function forgetCatalogs(): void {
  memory.clear();
  if (renderFormatsDeps.dataDir) fs.rmSync(cachePath(renderFormatsDeps.dataDir), { force: true });
}

export function intentsOf(templates: FormatEntry[]): FormatIntents {
  const out: FormatIntents = { h264: [], quicktime: [], quicktime_alpha: [], image_sequence: [], audio_only: [], alpha_only: [], other: [] };
  for (const t of templates) {
    if (t.error || !t.format) continue;
    if (t.video === false) out.audio_only.push(t.name);
    else if (t.alpha_only) out.alpha_only.push(t.name);
    else if (/^H\.264$/i.test(t.format)) out.h264.push({ name: t.name, ...(t.bitrate_mbps !== undefined ? { bitrate_mbps: t.bitrate_mbps } : {}) });
    else if (/^QuickTime$/i.test(t.format)) (t.alpha ? out.quicktime_alpha : out.quicktime).push(t.name);
    else if (t.sequence) out.image_sequence.push({ name: t.name, extension: t.extension, alpha: t.alpha === true });
    else out.other.push(t.name);
  }
  out.h264.sort((a, b) => (a.bitrate_mbps ?? 0) - (b.bitrate_mbps ?? 0));
  return out;
}

export function entryFor(cat: FormatCatalog | null, template: string | undefined): FormatEntry | null {
  if (!cat || !template) return null;
  const want = template.toLowerCase();
  return cat.templates.find((t) => t.name.toLowerCase() === want) ?? null;
}

export interface PathAdjustment {
  from: string;
  to: string;
  why: string;
}

/**
 * The output path a template will really write: AE names the file after the module's format
 * (an .avi path with an H.264 module comes out as .mp4), and a still sequence needs a frame-number
 * pattern. Null when the path already fits, or nothing is known about the template.
 */
export function adjustOutputPath(outputPath: string, entry: FormatEntry | null): PathAdjustment | null {
  if (!entry || !entry.extension || entry.error) return null;
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  let base = path.basename(outputPath, ext);
  const reasons: string[] = [];
  if (ext.replace(/^\./, "").toLowerCase() !== entry.extension) reasons.push(`"${entry.name}" writes ${entry.format} (.${entry.extension})`);
  if (entry.sequence && !/\[#+\]/.test(base)) {
    base = `${base}_[#####]`;
    reasons.push("a still sequence needs a frame-number pattern");
  }
  if (!reasons.length) return null;
  const to = path.join(dir, `${base}.${entry.extension}`);
  return { from: outputPath, to, why: reasons.join("; ") };
}
