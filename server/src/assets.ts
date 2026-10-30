/**
 * server/src/assets.ts
 *
 * Asset staging: generated or delivered files (renders, stills, voice-overs)
 * land in a folder next to the project, `<project dir>/_assets/` by default,
 * and are imported into an `_Assets` bin whose subfolders mirror the folder's.
 * This module scans the folder; the import itself runs in AE (assets.jsx).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_ASSET_FOLDER = "_assets";
export const DEFAULT_ASSET_BIN = "_Assets";

/** What AE imports as footage; anything else in the folder is ignored. */
const IMPORTABLE = new Set([
  "png", "jpg", "jpeg", "tif", "tiff", "psd", "exr", "dpx", "tga", "bmp", "gif", "svg", "ai", "eps", "pdf",
  "mov", "mp4", "m4v", "avi", "mxf", "webm", "mpg", "mpeg",
  "wav", "mp3", "aif", "aiff", "m4a", "aac",
]);
const SEQUENCE_EXT = new Set(["png", "jpg", "jpeg", "tif", "tiff", "exr", "dpx", "tga", "psd", "bmp"]);
const SEQ_RE = /^(.*?)(\d+)\.([A-Za-z0-9]+)$/;
/** A numbered group is a sequence only with at least this many frames and 3-7 digit numbers. */
const MIN_SEQUENCE_FRAMES = 3;
const MIN_DIGITS = 3;
const MAX_DIGITS = 7;
const MAX_FILES = 5000;
const MAX_DEPTH = 6;

export interface AssetCandidate {
  /** File AE imports (the first frame for a sequence). */
  path: string;
  /** Bin path under the asset bin, from the file's folder, e.g. ["flora", "stills"]. */
  subfolder: string[];
  sequence: boolean;
  frames?: number;
  /** Newest modification time among the file (or frames), ms. Used for "still being written". */
  mtimeMs: number;
  /**
   * When the file (newest frame) arrived: the latest of mtime, ctime and birthtime, ms.
   * Copies that keep an old mtime still get a fresh ctime or birthtime.
   */
  arrivedMs: number;
}

function ext(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/**
 * Lists importable files under `root`, grouping numbered stills (name_0001.png,
 * name_0002.png ...) into one sequence entry. Hidden files and folders whose
 * names start with "." or "_" (except the root) are skipped.
 */
export function scanAssets(root: string, opts: { recursive?: boolean; sequences?: boolean } = {}): AssetCandidate[] {
  const recursive = opts.recursive !== false;
  const sequences = opts.sequences !== false;
  const out: AssetCandidate[] = [];
  let count = 0;
  const walk = (dir: string, rel: string[], depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: Array<{ name: string; full: string; mtimeMs: number; arrivedMs: number }> = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < MAX_DEPTH && !e.name.startsWith("_")) walk(full, [...rel, e.name], depth + 1);
        continue;
      }
      if (!e.isFile() || !IMPORTABLE.has(ext(e.name)) || ++count > MAX_FILES) continue;
      let mtimeMs = 0;
      let arrivedMs = 0;
      try {
        const st = fs.statSync(full);
        mtimeMs = st.mtimeMs;
        arrivedMs = Math.max(st.mtimeMs, st.ctimeMs || 0, st.birthtimeMs || 0);
      } catch {
        continue;
      }
      files.push({ name: e.name, full, mtimeMs, arrivedMs });
    }
    const groups = new Map<string, typeof files>();
    const singles: typeof files = [];
    for (const f of files) {
      const m = sequences ? SEQ_RE.exec(f.name) : null;
      // Frames: 3-7 digits, not a version number (v002).
      if (m && SEQUENCE_EXT.has(m[3].toLowerCase()) && m[2].length >= MIN_DIGITS && m[2].length <= MAX_DIGITS && !/[vV]$/.test(m[1])) {
        const key = `${m[1]}\u0000${m[2].length}\u0000${m[3].toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), f]);
      } else singles.push(f);
    }
    for (const g of groups.values()) {
      if (g.length < MIN_SEQUENCE_FRAMES) {
        singles.push(...g);
        continue;
      }
      out.push({
        path: g[0].full,
        subfolder: rel,
        sequence: true,
        frames: g.length,
        mtimeMs: Math.max(...g.map((f) => f.mtimeMs)),
        arrivedMs: Math.max(...g.map((f) => f.arrivedMs)),
      });
    }
    for (const f of singles) out.push({ path: f.full, subfolder: rel, sequence: false, mtimeMs: f.mtimeMs, arrivedMs: f.arrivedMs });
  };
  walk(root, [], 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function normPath(p: string): string {
  const s = p.replace(/\\/g, "/").normalize("NFC");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Splits candidates into new ones, ones already in the project (by file
 * path; a sequence counts as imported when its first frame is), and ones
 * still being written (changed within `settleMs`, or `sequenceSettleMs` for sequences).
 */
export function pickNewAssets(
  candidates: AssetCandidate[],
  inProject: string[],
  now: number,
  settleMs: number,
  sequenceSettleMs: number = settleMs
): { fresh: AssetCandidate[]; already: AssetCandidate[]; settling: AssetCandidate[] } {
  const have = new Set(inProject.map(normPath));
  const fresh: AssetCandidate[] = [];
  const already: AssetCandidate[] = [];
  const settling: AssetCandidate[] = [];
  for (const c of candidates) {
    if (have.has(normPath(c.path))) already.push(c);
    else if (now - c.mtimeMs < (c.sequence ? sequenceSettleMs : settleMs)) settling.push(c);
    else fresh.push(c);
  }
  return { fresh, already, settling };
}
