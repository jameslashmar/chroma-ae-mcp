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
/**
 * Importable files one scan will look at. Frames are grouped into sequences before
 * anything is judged, so a long sequence is one candidate; only a tree with more
 * files than this is cut short, and the folders it cut are marked `incomplete`.
 */
export const MAX_SCAN_FILES = 100_000;
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
  /** Frame numbers of the first and last frame found, for a sequence (frames missing in between are not counted). */
  firstFrame?: number;
  lastFrame?: number;
  /** The interpretation settings resolved for this file (shared + matching rules); set by the import tool. */
  interpret?: Record<string, unknown>;
  /** The scan stopped at its file limit in this candidate's folder: a sequence here may be missing frames. */
  incomplete?: boolean;
}

/** What a scan saw. `truncated` means more importable files than the limit: the result is incomplete. */
export interface ScanStats {
  /** Importable files seen (counted past the limit too). */
  files_seen: number;
  truncated: boolean;
  /** Folders (relative, "" for the root) where files were skipped at the limit; at most 20. */
  incomplete_dirs?: string[];
  /** Single files left out because a scan stats at most MAX_SINGLE_STATS of them. */
  unchecked_singles?: number;
}

function ext(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** How many of a sequence's last frames are stat-ed besides the first (the newest frame decides "still being written"). */
const STAT_LAST_FRAMES = 8;

/** Frames beside the first this many gaps are stat-ed too: frames landing late in the middle (a re-render, a split farm) must read as still arriving. */
const STAT_GAPS = 4;
/** Single files stat-ed per scan. The scan runs on the service thread every few seconds; the rest are left out and counted in the stats. */
export const MAX_SINGLE_STATS = 5_000;

type Timed = { full: string; mtimeMs: number; arrivedMs: number; name?: string };

/** Reads one file's times into it. False when the file cannot be stat-ed (gone, or the share is not answering). */
function statFile(f: Timed): boolean {
  try {
    const st = fs.statSync(f.full);
    f.mtimeMs = st.mtimeMs;
    f.arrivedMs = Math.max(st.mtimeMs, st.ctimeMs || 0, st.birthtimeMs || 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest times over the first frame, the last STAT_LAST_FRAMES frames and the frames either side of the first STAT_GAPS gaps
 * in the numbering of a sequence (names in order), or null when none could be read. A stat per frame was 12 s per scan at 100,000 files on the service thread.
 */
function statSample(g: Timed[]): { mtimeMs: number; arrivedMs: number } | null {
  const pick = new Set<Timed>([g[0], ...g.slice(-STAT_LAST_FRAMES)]);
  let gaps = 0;
  let prev: number | null = null;
  for (let i = 0; i < g.length && gaps < STAT_GAPS; i++) {
    const n = g[i].name !== undefined ? Number(SEQ_RE.exec(g[i].name as string)?.[2]) : NaN;
    if (!Number.isFinite(n)) {
      prev = null;
      continue;
    }
    if (prev !== null && n - prev > 1) {
      pick.add(g[i]);
      pick.add(g[i - 1]);
      gaps++;
    }
    prev = n;
  }
  let mtimeMs = 0;
  let arrivedMs = 0;
  let any = false;
  for (const f of pick) {
    if (!statFile(f)) continue;
    any = true;
    mtimeMs = Math.max(mtimeMs, f.mtimeMs);
    arrivedMs = Math.max(arrivedMs, f.arrivedMs);
  }
  return any ? { mtimeMs, arrivedMs } : null;
}

/**
 * Lists importable files under `root`, grouping numbered stills (name_0001.png,
 * name_0002.png ...) into one sequence entry. Hidden files and folders whose
 * names start with "." or "_" (except the root) are skipped.
 */
export function scanAssets(
  root: string,
  opts: { recursive?: boolean; sequences?: boolean; maxFiles?: number; stats?: ScanStats } = {}
): AssetCandidate[] {
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;
  const recursive = opts.recursive !== false;
  const sequences = opts.sequences !== false;
  const out: AssetCandidate[] = [];
  let count = 0;
  let singleStats = 0;
  let uncheckedSingles = 0;
  const cutDirs = new Set<string>();
  const walk = (dir: string, rel: string[], depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: Array<{ name: string; full: string; mtimeMs: number; arrivedMs: number }> = [];
    const relKey = rel.join("/");
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < MAX_DEPTH && !e.name.startsWith("_")) walk(full, [...rel, e.name], depth + 1);
        continue;
      }
      if (!e.isFile() || !IMPORTABLE.has(ext(e.name))) continue;
      if (++count > maxFiles) {
        cutDirs.add(relKey);
        continue;
      }
      // No stat yet: a sequence stats only its first and last frames (below); a single file stats itself.
      files.push({ name: e.name, full, mtimeMs: 0, arrivedMs: 0 });
    }
    const groups = new Map<string, typeof files>();
    const singles: typeof files = [];
    for (const f of files) {
      const m = sequences ? SEQ_RE.exec(f.name) : null;
      // Frames: 3-7 digits, not a version number (v002).
      if (m && SEQUENCE_EXT.has(m[3].toLowerCase()) && m[2].length >= MIN_DIGITS && m[2].length <= MAX_DIGITS && !/[vV]$/.test(m[1])) {
        const key = `${m[1]}\u0000${m[2].length}\u0000${m[3].toLowerCase()}`;
        const list = groups.get(key);
        if (list) list.push(f);
        else groups.set(key, [f]);
      } else singles.push(f);
    }
    for (const g of groups.values()) {
      if (g.length < MIN_SEQUENCE_FRAMES) {
        singles.push(...g);
        continue;
      }
      const times = statSample(g);
      if (!times) continue; // not one sampled frame could be read: left out, as a file that vanished was
      out.push({
        path: g[0].full,
        subfolder: rel,
        sequence: true,
        frames: g.length,
        mtimeMs: times.mtimeMs,
        arrivedMs: times.arrivedMs,
        firstFrame: Number(SEQ_RE.exec(g[0].name)?.[2]),
        lastFrame: Number(SEQ_RE.exec(g[g.length - 1].name)?.[2]),
      });
    }
    for (const f of singles) {
      if (++singleStats > MAX_SINGLE_STATS) {
        uncheckedSingles++;
        continue;
      }
      if (!statFile(f)) continue;
      out.push({ path: f.full, subfolder: rel, sequence: false, mtimeMs: f.mtimeMs, arrivedMs: f.arrivedMs });
    }
  };
  walk(root, [], 0);
  if (opts.stats) {
    opts.stats.files_seen = count;
    opts.stats.truncated = count > maxFiles;
    opts.stats.incomplete_dirs = [...cutDirs].slice(0, 20);
    if (uncheckedSingles > 0) opts.stats.unchecked_singles = uncheckedSingles;
  }
  // A folder where the limit cut files may hold a sequence with missing frames: mark it.
  if (cutDirs.size > 0) for (const c of out) if (cutDirs.has(c.subfolder.join("/"))) c.incomplete = true;
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
    // arrivedMs (latest of mtime/ctime/birthtime), not raw mtimeMs: a copy
    // or sync delivery that preserves an old source mtime still gets a
    // fresh ctime/birthtime, and settling on mtimeMs alone would judge it
    // "already settled" and import it while the delivery is still in
    // progress -- the exact half-done-import bug arrivedMs exists to catch.
    else if (now - c.arrivedMs < (c.sequence ? sequenceSettleMs : settleMs)) settling.push(c);
    else fresh.push(c);
  }
  return { fresh, already, settling };
}

// ---------- explicit file lists ----------

/** Whether a file name is one frame of a numbered sequence (3-7 digits before an image extension, not a v002 version). */
export function sequenceKey(name: string): { key: string; digits: string } | null {
  const m = SEQ_RE.exec(name);
  if (!m || !SEQUENCE_EXT.has(m[3].toLowerCase()) || m[2].length < MIN_DIGITS || m[2].length > MAX_DIGITS || /[vV]$/.test(m[1])) return null;
  return { key: `${m[1]}\u0000${m[2].length}\u0000${m[3].toLowerCase()}`, digits: m[2] };
}

type DirFile = { name: string; full: string; mtimeMs: number; arrivedMs: number };

/**
 * Turns an explicit list of files into candidates, with the scan's rule for
 * sequences: a name that ends in 3-7 digits, an image extension, and at least
 * 3 frames like it in the same folder. A frame that is not the first of its
 * group is replaced by the first, and `given` keeps what was asked for.
 * Files that do not exist or are not importable are returned in `missing`.
 */
export function candidatesFromPaths(
  paths: string[],
  opts: { sequences?: boolean; root?: string } = {}
): { candidates: Array<AssetCandidate & { given?: string }>; missing: Array<{ path: string; error: string }> } {
  const candidates: Array<AssetCandidate & { given?: string }> = [];
  const missing: Array<{ path: string; error: string }> = [];
  const seen = new Set<string>();
  const dirCache = new Map<string, DirFile[]>();
  const groupCache = new Map<string, DirFile[]>();
  const listDir = (dir: string): DirFile[] => {
    let hit = dirCache.get(dir);
    if (!hit) {
      hit = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!e.isFile()) continue;
          // Names only: a sequence is stat-ed on its first and last frames when it is used (statSample).
          hit.push({ name: e.name, full: path.join(dir, e.name), mtimeMs: 0, arrivedMs: 0 });
        }
      } catch {
        /* unreadable */
      }
      dirCache.set(dir, hit);
    }
    return hit;
  };
  for (const given of paths) {
    const full = path.resolve(given);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      missing.push({ path: given, error: "file not found" });
      continue;
    }
    if (!st.isFile()) {
      missing.push({ path: given, error: "not a file" });
      continue;
    }
    if (!IMPORTABLE.has(ext(full))) {
      missing.push({ path: given, error: `.${ext(full) || "(none)"} is not a type this tool imports` });
      continue;
    }
    const subfolder = opts.root ? path.relative(opts.root, path.dirname(full)).split(path.sep).filter((x) => x && x !== "..") : [];
    const key = sequenceKey(path.basename(full));
    if (opts.sequences !== false && key) {
      const groupKey = `${path.dirname(full)}|${key.key}`;
      let group = groupCache.get(groupKey);
      if (!group) {
        group = listDir(path.dirname(full)).filter((f) => sequenceKey(f.name)?.key === key.key);
        groupCache.set(groupKey, group);
      }
      if (group.length >= MIN_SEQUENCE_FRAMES) {
        const first = group[0];
        const dedupe = normPath(first.full);
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        // If no sampled frame can be read, the file that was asked for (already stat-ed above) stands in.
        const times = statSample(group) ?? { mtimeMs: st.mtimeMs, arrivedMs: Math.max(st.mtimeMs, st.ctimeMs || 0, st.birthtimeMs || 0) };
        candidates.push({
          path: first.full,
          subfolder,
          sequence: true,
          frames: group.length,
          mtimeMs: times.mtimeMs,
          arrivedMs: times.arrivedMs,
          firstFrame: Number(sequenceKey(first.name)?.digits),
          lastFrame: Number(sequenceKey(group[group.length - 1].name)?.digits),
          ...(normPath(first.full) !== normPath(full) ? { given } : {}),
        });
        continue;
      }
    }
    const dedupe = normPath(full);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    candidates.push({ path: full, subfolder, sequence: false, mtimeMs: st.mtimeMs, arrivedMs: Math.max(st.mtimeMs, st.ctimeMs || 0, st.birthtimeMs || 0) });
  }
  return { candidates, missing };
}

// ---------- interpretation rules ----------

export interface ImportRule {
  match: { name_glob?: string; ext?: string[]; sequence?: boolean; subfolder_glob?: string };
  interpret: Record<string, unknown>;
}

/** `*` and `?` only, case-insensitive, whole-string. */
export function globToRegExp(glob: string): RegExp {
  let body = "";
  for (const c of glob) {
    if (c === "*") body += ".*";
    else if (c === "?") body += ".";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`, "i");
}

/** What a rule's `name_glob` is matched against: the first frame's file name, with the frame number removed for a sequence (`shot_0001.exr` is `shot_.exr`). */
export function ruleName(c: Pick<AssetCandidate, "path" | "sequence">): string {
  const base = path.basename(c.path);
  if (!c.sequence) return base;
  const m = SEQ_RE.exec(base);
  return m ? `${m[1]}.${m[3]}` : base;
}

export function ruleMatches(rule: ImportRule, c: Pick<AssetCandidate, "path" | "sequence" | "subfolder">): boolean {
  const m = rule.match;
  if (m.sequence !== undefined && m.sequence !== c.sequence) return false;
  if (m.ext && !m.ext.some((e) => e.replace(/^\./, "").toLowerCase() === ext(c.path))) return false;
  if (m.name_glob !== undefined && !globToRegExp(m.name_glob).test(ruleName(c))) return false;
  if (m.subfolder_glob !== undefined && !globToRegExp(m.subfolder_glob).test(c.subfolder.join("/"))) return false;
  return true;
}

/**
 * The settings for one candidate: the shared ones, each field replaced by the
 * first matching rule that sets it. Returns undefined when nothing applies.
 */
export function resolveInterpret(
  c: Pick<AssetCandidate, "path" | "sequence" | "subfolder">,
  shared: Record<string, unknown> | undefined,
  rules: ImportRule[] | undefined
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...(shared ?? {}) };
  const fromRule = new Set<string>();
  for (const rule of rules ?? []) {
    if (!ruleMatches(rule, c)) continue;
    for (const [k, v] of Object.entries(rule.interpret)) {
      if (v === undefined || fromRule.has(k)) continue;
      out[k] = v;
      fromRule.add(k);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------- result shaping ----------

export const IMPORT_ROWS = 100;
export const IMPORT_PATHS = 20;

interface ImportedRow {
  path: string;
  interpretation?: { applied?: string[]; skipped?: unknown[]; error?: string };
}
interface FailedRow {
  path: string;
  stage?: string;
  error: string;
}

/** Bounds the lists of an import result and counts what happened. Pure. */
export function shapeImportResult<I extends ImportedRow, F extends FailedRow>(input: {
  requested: number;
  imported: I[];
  failed: F[];
  skipped_existing?: number;
  still_writing?: number;
  not_attempted?: number;
}) {
  const failedImport = input.failed.filter((f) => f.stage !== "interpret").length;
  const interpretFailed = input.failed.length - failedImport;
  let applied = 0;
  let skipped = 0;
  for (const i of input.imported) {
    if (i.interpretation?.applied && i.interpretation.applied.length > 0) applied++;
    if (i.interpretation?.skipped && i.interpretation.skipped.length > 0) skipped++;
  }
  return {
    summary: {
      requested: input.requested,
      imported: input.imported.length,
      failed: failedImport,
      skipped_existing: input.skipped_existing ?? 0,
      still_writing: input.still_writing ?? 0,
      not_attempted: input.not_attempted ?? 0,
      interpretation_applied: applied,
      interpretation_skipped: skipped,
      interpretation_failed: interpretFailed,
    },
    imported: input.imported.slice(0, IMPORT_ROWS),
    imported_total: input.imported.length,
    imported_truncated: input.imported.length > IMPORT_ROWS,
    failed: input.failed.slice(0, IMPORT_ROWS),
    failed_total: input.failed.length,
    failed_truncated: input.failed.length > IMPORT_ROWS,
  };
}
