/**
 * server/src/versions.ts
 *
 * Finding newer versions of a footage file on disk, for shot versioning:
 * - a movie or still: `shot010_comp_v003.mov` -> `shot010_comp_v004.mov` in
 *   the same folder
 * - a sequence in one folder: `shot010_v003.0001.exr` -> the first frame of
 *   `shot010_v004.####.exr`
 * - a sequence in versioned folders: `shot010_v003/shot010_v003.0001.exr`
 *   -> the first frame in the sibling `shot010_v004/`
 * The version is the last `v` + digits in the name (`_v3`, `.v012`, `-V7`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface VersionToken {
  /** Text before the digits, including the v. */
  before: string;
  number: number;
  digits: number;
  after: string;
}

const VERSION_RE = /(^|[^A-Za-z0-9])([vV])(\d{1,5})(?=$|[^0-9])/g;

/** The last version token in a name, or null. */
export function versionToken(name: string): VersionToken | null {
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  VERSION_RE.lastIndex = 0;
  while ((m = VERSION_RE.exec(name))) last = m;
  if (!last) return null;
  const start = last.index + last[1].length;
  return {
    before: name.slice(0, start + 1),
    number: Number(last[3]),
    digits: last[3].length,
    after: name.slice(start + 1 + last[3].length),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name's pattern with the version (and, for sequences, the frame number) left open. */
function namePattern(name: string, sequence: boolean): { re: RegExp; frameAware: boolean } | null {
  const tok = versionToken(name);
  if (!tok) return null;
  let after = escapeRe(tok.after);
  let frameAware = false;
  if (sequence) {
    // The last run of digits before the extension is the frame number.
    const fm = /^(.*?)(\d+)(\.[^.]+)$/.exec(tok.after);
    if (fm) {
      after = `${escapeRe(fm[1])}\\d+${escapeRe(fm[3])}`;
      frameAware = true;
    }
  }
  return { re: new RegExp(`^${escapeRe(tok.before)}(\\d{1,5})${after}$`, process.platform === "win32" ? "i" : ""), frameAware };
}

export interface VersionCandidate {
  version: number;
  path: string;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every version of `file` on disk, oldest first; for a sequence each version's first frame. */
export function findVersions(file: string, sequence: boolean): { current: number | null; versions: VersionCandidate[] } {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const own = versionToken(base);
  const dirName = path.basename(dir);
  const dirTok = versionToken(dirName);
  const byVersion = new Map<number, string[]>();
  const add = (v: number, p: string) => byVersion.set(v, [...(byVersion.get(v) ?? []), p]);

  // The folder is the version only when the file has no version of its own or the two agree
  // ('shot_v003/shot_v003.0001.exr'); a 'show_v2/shot010_v003.0001.exr' is versioned by its file name.
  if (dirTok && sequence && (!own || own.number === dirTok.number)) {
    // Versioned folders: look at the siblings of the folder.
    const parent = path.dirname(dir);
    const dirRe = new RegExp(`^${escapeRe(dirTok.before)}(\\d{1,5})${escapeRe(dirTok.after)}$`, process.platform === "win32" ? "i" : "");
    for (const sib of listDir(parent)) {
      const m = dirRe.exec(sib);
      if (!m) continue;
      // A versioned folder holds that version's frames: the files with the same extension.
      const ext = path.extname(base).toLowerCase();
      for (const f of listDir(path.join(parent, sib))) {
        if (path.extname(f).toLowerCase() === ext) add(Number(m[1]), path.join(parent, sib, f));
      }
    }
    return { current: dirTok.number, versions: firstOfEach(byVersion) };
  }
  if (!own) return { current: null, versions: [] };
  const pat = namePattern(base, sequence);
  if (!pat) return { current: null, versions: [] };
  for (const n of listDir(dir)) {
    const m = pat.re.exec(n);
    if (m) add(Number(m[1]), path.join(dir, n));
  }
  return { current: own.number, versions: firstOfEach(byVersion) };
}

function firstOfEach(byVersion: Map<number, string[]>): VersionCandidate[] {
  return [...byVersion.entries()]
    .map(([version, files]) => ({ version, path: files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] }))
    .sort((a, b) => a.version - b.version);
}

export interface VersionPlan {
  current: number | null;
  latest: number | null;
  target: VersionCandidate | null;
  newer: boolean;
}

/** What to swap to: the requested version, or the latest one newer than the current. */
export function planVersion(file: string, sequence: boolean, want?: number): VersionPlan {
  const { current, versions } = findVersions(file, sequence);
  const latest = versions.length ? versions[versions.length - 1].version : null;
  const target = want !== undefined ? versions.find((v) => v.version === want) ?? null : versions[versions.length - 1] ?? null;
  // Without a requested version only a higher one is newer: with the current file gone from disk the
  // latest found can be older than current, and that is not an update. A requested version may be a rollback.
  const newer = target !== null && current !== null && (want !== undefined ? target.version !== current : target.version > current);
  return { current, latest, target, newer };
}

export interface VersionLogEntry {
  at: string;
  item_id: number;
  name: string;
  from: string | null;
  to: string;
  from_version: number | null;
  to_version: number;
}

/** `<project>.versions.json` next to the .aep: every swap, newest last. */
export function versionLogPath(projectPath: string): string {
  const ext = path.extname(projectPath);
  return path.join(path.dirname(projectPath), `${path.basename(projectPath, ext)}.versions.json`);
}

/**
 * Appends to the log. A log that can't be parsed is never overwritten: it is
 * renamed to `<log>.<time>.bak` (its path goes in `notes.aside`) and a new log
 * starts. A log that can't be read at all (locked, no access) throws.
 */
export function appendVersionLog(projectPath: string, entries: VersionLogEntry[], notes?: { aside?: string }): string {
  const file = versionLogPath(projectPath);
  let log: { entries: VersionLogEntry[] } = { entries: [] };
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null) {
    let parsed: { entries?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed && Array.isArray(parsed.entries)) {
      log = parsed as { entries: VersionLogEntry[] };
    } else {
      const aside = `${file}.${Date.now()}.bak`;
      fs.renameSync(file, aside);
      if (notes) notes.aside = aside;
    }
  }
  log.entries.push(...entries);
  // Write beside it and rename into place, so a crash can't leave half a log.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, file);
  return file;
}
