/**
 * server/src/tools/ext/collect.ts
 *
 * Collect Files without AE's dialog:
 * - ae_collect_files: a dry run (sizes, duplicates, what can't be collected)
 *   and then the real copy. The saved .aep is copied with Node fs, never
 *   Project.save(File) (that is save-as and retargets the open project), the
 *   footage and proxies go to _Footage/<bin path>, de-duplicated, with a sha1
 *   manifest. A call works for max_seconds and is resumable: call it again.
 *   Optionally writes a verified .zip (ZIP64, streamed) and a report.
 * - ae_collect_relink: the separate, explicitly asked-for step that points
 *   the COPY at the collected files. That means opening the copy, so it closes
 *   the user's project (never saving, never prompting), relinks, saves the
 *   copy and reopens the original. Undo history and open viewers are lost.
 * - ae_collect_report: the version report (AE build, comps, footage with
 *   sizes, fonts, effects, expressions, render outputs with sha1, checkpoints,
 *   changes since the last report) as markdown or JSON, doubling as a delivery note.
 *
 * Fonts, and files that effects or 3D layers point to (LUTs, glTF assets,
 * plug-in assets), can't be found through the DOM: they are listed as not collected.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import { formatRanges, missingRanges } from "../../seqscan.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { checkpointDirFor, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";
import { getSessionTracker } from "./session.js";
import { expectThat } from "./write-runner.js";

const MAX_LIST = 500;
/** Missing-frame ranges kept per sequence. */
const MAX_GAP_RANGES = 20;
const MAX_TEXT = 20_000;
const WIN_OR_MAC = process.platform === "win32" || process.platform === "darwin";

// ---------- schemas ----------

const DestSchema = z
  .string()
  .min(1)
  .refine((p) => path.isAbsolute(p), "dest must be an absolute path")
  .optional()
  .describe("The collect folder (absolute). Default: _collect next to the .aep. The .aep copy, _Footage/, manifest.json and the report go in it.");

export const AeCollectFilesSchema = z.object({
  dest: DestSchema,
  dry_run: z
    .boolean()
    .optional()
    .describe("Default true: report total bytes, the files, duplicates and what can't be collected, and copy nothing. Pass false to copy."),
  only_used: z.boolean().optional().describe("Leave out footage no comp uses (used_in 0). Default false."),
  include_proxies: z.boolean().optional().describe("Collect proxy files too. Default true."),
  max_seconds: z
    .number()
    .min(5)
    .max(600)
    .optional()
    .describe("How long one call copies before it stops between files and says what is left (default 50). Call again with the same arguments to continue."),
  restart: z
    .boolean()
    .optional()
    .describe("Copy the .aep again and ignore the manifest. Needed after a relink if the project changed since: a relinked copy is otherwise kept."),
  zip: z
    .boolean()
    .optional()
    .describe("When the collect is complete, also write <dest>.zip (ZIP64, streamed, stored for already-compressed media) and verify it by reading it back against the manifest."),
  report: z.enum(["markdown", "json", "none"]).optional().describe("Write the version report next to the manifest when complete. Default markdown."),
  expect: ExpectSchema.optional().describe("If given, the open project must match, or the call refuses."),
});

export const AeCollectRelinkSchema = z.object({
  dest: DestSchema,
  confirm_close_project: z
    .literal(true)
    .describe("Must be true. Relinking opens the copy, so the open project is closed without saving and reopened afterwards: its undo history and open viewers are lost."),
  remove_unused: z.boolean().optional().describe("Remove footage no comp uses from the COPY (removeUnusedFootage). Default: true when the collect used only_used."),
  reduce_to_comp_ids: z.array(z.number().int()).min(1).max(500).optional().describe("Reduce the COPY to these comps and what they use (reduceProject)."),
  expect: ExpectSchema,
});

export const AeCollectReportSchema = z.object({
  dest: DestSchema,
  format: z.enum(["markdown", "json"]).optional().describe("What to return. Default markdown."),
  write: z.boolean().optional().describe("Write collect-report.md (or .json) and the .json used for the next 'changes since' diff into dest. Default true; dest is created."),
  hash_outputs: z.boolean().optional().describe("sha1 the render outputs on disk (up to 512 MB each). Default true."),
  max_seconds: z
    .number()
    .min(5)
    .max(600)
    .optional()
    .describe("How long hashing the render outputs may take (default 50). Outputs not hashed by then say so in their note; call again to hash them."),
});

// ---------- pure helpers ----------

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

/** A path as a comparison key: forward slashes, case-folded where the file system is. */
export function pathKey(p: string, caseInsensitive = WIN_OR_MAC): string {
  const s = p.replace(/\\/g, "/");
  return caseInsensitive ? s.toLowerCase() : s;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file or folder name that is legal on Windows and macOS, keeping the extension. */
export function safeSegment(name: string, max = 120): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") s = "_";
  const ext = path.extname(s);
  const stem = ext ? s.slice(0, -ext.length) : s;
  const room = Math.max(1, max - ext.length);
  let out = (stem.length > room ? stem.slice(0, room) : stem) + ext;
  if (RESERVED.test(stem)) out = `_${out}`;
  return out;
}

export interface FrameName {
  prefix: string;
  digits: string;
  suffix: string;
}

/**
 * The frame number of a sequence file name: the last run of digits in the stem,
 * which may be followed by text before the extension (shot_0001_beauty.exr).
 * This is looser on purpose than server/src/seqscan.ts and assets.ts, where the
 * number must sit directly before the extension: collecting must not leave out
 * a file AE points at. Unifying the two would change what gets collected.
 */
export function splitFrameName(name: string): FrameName | null {
  const m = /^(.*?)(\d+)(\D*\.[^.]+)$/.exec(name);
  return m ? { prefix: m[1], digits: m[2], suffix: m[3] } : null;
}

/**
 * The frames of the sequence `base` belongs to among `names` (one folder's
 * listing), numerically ordered. A heuristic: AE's DOM has no frame list, so
 * it is the same prefix and extension with a number in between, the same
 * digit count when the pattern is zero-padded.
 */
export function matchFrames(names: string[], base: string, caseInsensitive = WIN_OR_MAC): Array<{ name: string; number: number }> {
  const own = splitFrameName(base);
  if (!own) return [];
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const padded = (d: string) => d.length > 1 && d.startsWith("0");
  const out: Array<{ name: string; number: number }> = [];
  for (const n of names) {
    const f = splitFrameName(n);
    if (!f || fold(f.prefix) !== fold(own.prefix) || fold(f.suffix) !== fold(own.suffix)) continue;
    const sameWidth = f.digits.length === own.digits.length;
    if (!sameWidth && (padded(own.digits) || padded(f.digits))) continue;
    out.push({ name: n, number: Number(f.digits) });
  }
  return out.sort((a, b) => a.number - b.number);
}

export interface SourceFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ResolvedSource {
  files: SourceFile[];
  error?: string;
  /** Something the user should know: a sequence that resolved to one file. */
  warning?: string;
  /** Sequences: the frames found, by number. */
  frames?: { count: number; first: number; last: number; gaps: number; missing_ranges: Array<[number, number]>; ranges_truncated: boolean; digits: number };
}

const statFile = async (p: string): Promise<SourceFile> => {
  const st = await fs.promises.stat(p);
  if (!st.isFile()) throw new Error("not a file");
  return { path: p, bytes: st.size, mtimeMs: st.mtimeMs };
};

/** What is on disk for a footage file; a sequence is every frame of its pattern in the folder. */
export async function resolveSource(file: string, sequence: boolean): Promise<ResolvedSource> {
  let warning: string | undefined;
  if (sequence && splitFrameName(path.basename(file))) {
    const dir = path.dirname(file);
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      names = [];
    }
    const frames = matchFrames(names, path.basename(file));
    if (frames.length > 0) {
      const files: SourceFile[] = [];
      try {
        for (let i = 0; i < frames.length; i += 64) {
          files.push(...(await Promise.all(frames.slice(i, i + 64).map((f) => statFile(path.join(dir, f.name))))));
        }
      } catch (err) {
        return { files: [], error: `a frame could not be read: ${err instanceof Error ? err.message : String(err)}` };
      }
      const first = frames[0].number;
      const last = frames[frames.length - 1].number;
      const distinct = new Set(frames.map((f) => f.number)).size;
      const numbers = [...new Set(frames.map((f) => f.number))];
      const where = missingRanges(numbers, MAX_GAP_RANGES);
      const own = splitFrameName(path.basename(file));
      const digits = own && own.digits.length > 1 && own.digits.startsWith("0") ? own.digits.length : 0;
      const res: ResolvedSource = {
        files,
        frames: { count: frames.length, first, last, gaps: Math.max(0, last - first + 1 - distinct), missing_ranges: where.ranges, ranges_truncated: where.truncated, digits },
      };
      if (files.length === 1) res.warning = `${path.basename(file)} is an image sequence in AE but only one frame was found next to it: one file is collected`;
      return res;
    }
    warning = `the frames next to ${path.basename(file)} could not be listed: only this file is collected`;
  } else if (sequence) {
    warning = `${path.basename(file)} is an image sequence in AE but its name has no frame number: only this file is collected`;
  }
  try {
    const one: ResolvedSource = { files: [await statFile(file)] };
    if (warning) one.warning = warning;
    return one;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { files: [], error: code === "ENOENT" ? "the file is not on disk" : `the file could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface FootageEntry {
  item_id: number;
  name: string;
  file: string;
  sequence: boolean;
  missing: boolean;
  used_in: number;
  bin: string[];
  proxy: { file: string; sequence: boolean; in_use: boolean } | null;
  /** A comp with a proxy file: only the proxy is collected (file is the proxy's). */
  proxy_only?: boolean;
}

export interface FootagePage {
  project_path: string;
  /** null when AE would not say. */
  dirty: boolean | null;
  offset: number;
  total: number;
  next_offset: number | null;
  items: FootageEntry[];
  no_file: Array<{ item_id: number; name: string; kind: string }>;
}

export type Role = "main" | "proxy";

export interface PlanSource {
  key: string;
  role: Role;
  sequence: boolean;
  /** Every file path AE reports for the group's items (a sequence may report different frames). */
  ae_files: string[];
  item_ids: number[];
  /** The collected path of the first file, relative to dest. */
  dest_first: string;
  resolved: ResolvedSource;
}

export interface PlanFile {
  source: string;
  /** Relative to dest, forward slashes. */
  path: string;
  bytes: number;
  mtime_ms: number;
  role: Role;
  item_ids: number[];
}

export interface Plan {
  sources: PlanSource[];
  files: PlanFile[];
  bytes: number;
  /** Footage files more than one item uses: collected once. */
  shared: Array<{ file: string; item_ids: number[] }>;
  problems: Array<{ item_ids: number[]; file: string; role: Role; problem: string }>;
  gaps: Array<{ file: string; missing_frames: number; first: number; last: number; missing_ranges: Array<[number, number]>; missing_text: string }>;
  skipped_unused: number;
  /** Sequences that resolved to a single file, and the like. */
  warnings: string[];
}

/** A sequence group's key: the folder and frame pattern, so any frame of it finds the same group. */
export function sourceKey(file: string, sequence: boolean): string {
  const f = sequence ? splitFrameName(path.basename(file)) : null;
  if (!f) return pathKey(file);
  return `${pathKey(path.dirname(file))}/${pathKey(f.prefix)}#${pathKey(f.suffix)}`;
}

/**
 * Where each footage file and proxy goes: _Footage/<bin path>/<file> (proxies
 * under _Footage/_Proxies), a sequence in a folder named after its own. One
 * disk file used by several items is collected once; names that would
 * collide get _2, _3. `resolved` maps sourceKey to what is on disk.
 */
export function planCollect(
  entries: FootageEntry[],
  resolved: Map<string, ResolvedSource>,
  opts: { only_used?: boolean; include_proxies?: boolean } = {}
): Plan {
  type Ref = { role: Role; file: string; sequence: boolean; bin: string[]; item_id: number };
  const refs: Ref[] = [];
  let skippedUnused = 0;
  for (const e of entries) {
    if (opts.only_used && e.used_in === 0 && !e.proxy_only) {
      skippedUnused++;
      continue;
    }
    if (e.proxy_only) continue;
    refs.push({ role: "main", file: e.file, sequence: e.sequence, bin: e.bin, item_id: e.item_id });
  }
  if (opts.include_proxies !== false) {
    for (const e of entries) {
      if (e.proxy && !(opts.only_used && e.used_in === 0 && !e.proxy_only)) {
        refs.push({ role: "proxy", file: e.proxy.file, sequence: e.proxy.sequence, bin: e.bin, item_id: e.item_id });
      }
    }
  }
  // Mains first, so a file that is both footage and a proxy lands with the footage.
  const groups = new Map<string, PlanSource>();
  const physical = new Map<string, { dest_dir: string; dest_first: string }>();
  const takenDirs = new Set<string>();
  const takenFiles = new Set<string>();
  const unique = (taken: Set<string>, rel: string, split: (r: string) => [string, string]): string => {
    let candidate = rel;
    for (let n = 2; taken.has(pathKey(candidate)); n++) {
      const [stem, ext] = split(rel);
      candidate = `${stem}_${n}${ext}`;
    }
    taken.add(pathKey(candidate));
    return candidate;
  };
  const plan: Plan = { sources: [], files: [], bytes: 0, shared: [], problems: [], gaps: [], skipped_unused: skippedUnused, warnings: [] };
  const sharedBy = new Map<string, { file: string; item_ids: Set<number> }>();

  for (const ref of refs) {
    const key = sourceKey(ref.file, ref.sequence);
    const gkey = `${key}|${ref.role}`;
    let g = groups.get(gkey);
    const res = resolved.get(key) ?? { files: [], error: "not resolved" };
    if (!g) {
      let phys = physical.get(key);
      if (!phys) {
        const binDir = [...(ref.role === "proxy" ? ["_Proxies"] : []), ...ref.bin.map((b) => safeSegment(b))].join("/");
        const base = `_Footage${binDir ? `/${binDir}` : ""}`;
        let destDir = base;
        let destFirst = "";
        if (res.files.length > 0) {
          if (ref.sequence && res.files.length >= 1 && splitFrameName(path.basename(ref.file))) {
            const folder = unique(takenDirs, `${base}/${safeSegment(path.basename(path.dirname(ref.file)) || "sequence")}`, (r) => [r, ""]);
            destDir = folder;
            destFirst = `${folder}/${safeSegment(path.basename(res.files[0].path))}`;
          } else {
            const rel = unique(takenFiles, `${base}/${safeSegment(path.basename(ref.file))}`, (r) => {
              const ext = path.extname(r);
              return [ext ? r.slice(0, -ext.length) : r, ext];
            });
            destFirst = rel;
            destDir = path.posix.dirname(rel);
          }
        }
        phys = { dest_dir: destDir, dest_first: destFirst };
        physical.set(key, phys);
      }
      g = {
        key,
        role: ref.role,
        sequence: ref.sequence,
        ae_files: [],
        item_ids: [],
        dest_first: phys.dest_first,
        resolved: res,
      };
      groups.set(gkey, g);
      plan.sources.push(g);
    }
    if (!g.ae_files.includes(ref.file)) g.ae_files.push(ref.file);
    if (!g.item_ids.includes(ref.item_id)) g.item_ids.push(ref.item_id);
    const sh = sharedBy.get(key) ?? { file: ref.file, item_ids: new Set<number>() };
    sh.item_ids.add(ref.item_id);
    sharedBy.set(key, sh);
  }

  const emitted = new Set<string>();
  const warned = new Set<string>();
  for (const g of plan.sources) {
    const res = g.resolved;
    if (res.error || res.files.length === 0) {
      plan.problems.push({ item_ids: g.item_ids, file: g.ae_files[0], role: g.role, problem: res.error ?? "no files found" });
      continue;
    }
    if (res.warning && !warned.has(g.key)) {
      warned.add(g.key);
      plan.warnings.push(res.warning);
    }
    if (res.frames && res.frames.gaps > 0) {
      plan.gaps.push({
        file: g.ae_files[0],
        missing_frames: res.frames.gaps,
        first: res.frames.first,
        last: res.frames.last,
        missing_ranges: res.frames.missing_ranges,
        missing_text: formatRanges(res.frames.missing_ranges, res.frames.digits, 400) + (res.frames.ranges_truncated ? ", ..." : ""),
      });
    }
    if (emitted.has(g.key)) continue;
    emitted.add(g.key);
    const phys = physical.get(g.key);
    const dir = phys?.dest_dir ?? "_Footage";
    const ids = new Set<number>();
    for (const other of plan.sources) if (other.key === g.key) other.item_ids.forEach((i) => ids.add(i));
    const roleOf: Role = plan.sources.some((o) => o.key === g.key && o.role === "main") ? "main" : "proxy";
    for (let i = 0; i < res.files.length; i++) {
      const f = res.files[i];
      // One file: exactly the path planned for it, so dest_first and the written file always agree.
      const rel = res.files.length === 1 ? g.dest_first : `${dir}/${safeSegment(path.basename(f.path))}`;
      plan.files.push({ source: f.path, path: rel, bytes: f.bytes, mtime_ms: f.mtimeMs, role: roleOf, item_ids: [...ids] });
      plan.bytes += f.bytes;
    }
  }
  for (const s of sharedBy.values()) if (s.item_ids.size > 1) plan.shared.push({ file: s.file, item_ids: [...s.item_ids] });
  return plan;
}

// ---------- CRC32 and the ZIP writer ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 by hand: Node 17 has no zlib.crc32. */
export class Crc32 {
  private c = 0xffffffff;
  update(buf: Uint8Array): this {
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    this.c = c;
    return this;
  }
  get value(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

/** Media that is already compressed: stored, not deflated. */
const STORED_EXT = new Set([
  ".mov", ".mp4", ".m4v", ".mxf", ".avi", ".mkv", ".webm", ".r3d", ".braw", ".exr", ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".zip", ".gz", ".7z", ".rar", ".heic", ".jp2",
]);

export interface ZipInput {
  /** The name inside the zip, forward slashes. */
  name: string;
  /** A file on disk, or the bytes. */
  file?: string;
  data?: Buffer;
  mtime: Date;
}

export interface ZipResult {
  path: string;
  entries: number;
  bytes: number;
  zip64: boolean;
}

const U32_MAX = 0xffffffff;
const ZIP64_AT = 0x7fffffff;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ZipOut {
  offset = 0;
  private ws: fs.WriteStream;
  private failure: Error | null = null;
  constructor(p: string) {
    this.ws = fs.createWriteStream(p);
    this.ws.on("error", (e) => {
      this.failure = e;
    });
  }
  write(buf: Buffer): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.offset += buf.length;
    return new Promise((res, rej) => this.ws.write(buf, (e) => (e ? rej(e) : res())));
  }
  close(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((res, rej) => {
      this.ws.end((e?: Error | null) => (e || this.failure ? rej(e ?? this.failure) : res()));
    });
  }
}

interface CentralRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  zip64: boolean;
}

/**
 * A streamed ZIP: sizes and CRCs go in data descriptors, so a file is read once
 * and never held in memory. ZIP64 records are written for an entry of 2 GB or
 * more, an offset past 4 GB, more than 65,535 entries or a central directory
 * past 4 GB (forceZip64 makes every record ZIP64, for tests).
 */
export async function writeZip(zipPath: string, inputs: ZipInput[], opts: { forceZip64?: boolean } = {}): Promise<ZipResult> {
  const part = `${zipPath}.part`;
  const out = new ZipOut(part);
  const central: CentralRecord[] = [];
  try {
    for (const input of inputs) {
      const name = Buffer.from(input.name, "utf8");
      if (name.length > 0xffff) throw new Error(`zip name too long: ${input.name.slice(0, 80)}`);
      const size = input.data ? input.data.length : (await fs.promises.stat(input.file as string)).size;
      const zip64 = opts.forceZip64 === true || size >= ZIP64_AT;
      const ext = path.extname(input.name).toLowerCase();
      const method = STORED_EXT.has(ext) || size === 0 ? 0 : 8;
      const { time, date } = dosDateTime(input.mtime);
      const offset = out.offset;
      const flags = 0x0808; // data descriptor, UTF-8 names
      const extra = Buffer.alloc(zip64 ? 20 : 0);
      if (zip64) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(16, 2);
      }
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(zip64 ? 45 : 20, 4);
      h.writeUInt16LE(flags, 6);
      h.writeUInt16LE(method, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      h.writeUInt32LE(0, 14);
      h.writeUInt32LE(zip64 ? U32_MAX : 0, 18);
      h.writeUInt32LE(zip64 ? U32_MAX : 0, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(extra.length, 28);
      await out.write(Buffer.concat([h, name, extra]));

      const crc = new Crc32();
      let usize = 0;
      let csize = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc.update(chunk);
          usize += chunk.length;
          cb(null, chunk);
        },
      });
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          csize += chunk.length;
          out.write(chunk).then(() => cb(), cb);
        },
      });
      const source = input.data ? Readable.from([input.data]) : fs.createReadStream(input.file as string);
      if (method === 8) await pipeline(source, counter, zlib.createDeflateRaw({ level: 6 }), sink);
      else await pipeline(source, counter, sink);
      if (!zip64 && (usize >= U32_MAX || csize >= U32_MAX)) throw new Error(`${input.name} grew past 4 GB while it was zipped`);

      const d = Buffer.alloc(zip64 ? 24 : 16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc.value, 4);
      if (zip64) {
        d.writeBigUInt64LE(BigInt(csize), 8);
        d.writeBigUInt64LE(BigInt(usize), 16);
      } else {
        d.writeUInt32LE(csize, 8);
        d.writeUInt32LE(usize, 12);
      }
      await out.write(d);
      central.push({ name, method, time, date, crc: crc.value, csize, usize, offset, zip64 });
    }

    const cdStart = out.offset;
    for (const r of central) {
      const big = r.zip64 || r.offset >= U32_MAX;
      const extra = Buffer.alloc(big ? 28 : 0);
      if (big) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(r.usize), 4);
        extra.writeBigUInt64LE(BigInt(r.csize), 12);
        extra.writeBigUInt64LE(BigInt(r.offset), 20);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(45, 4);
      c.writeUInt16LE(big ? 45 : 20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(r.method, 10);
      c.writeUInt16LE(r.time, 12);
      c.writeUInt16LE(r.date, 14);
      c.writeUInt32LE(r.crc, 16);
      c.writeUInt32LE(big ? U32_MAX : r.csize, 20);
      c.writeUInt32LE(big ? U32_MAX : r.usize, 24);
      c.writeUInt16LE(r.name.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(big ? U32_MAX : r.offset, 42);
      await out.write(Buffer.concat([c, r.name, extra]));
    }
    const cdSize = out.offset - cdStart;
    const needZip64 = opts.forceZip64 === true || central.length >= 0xffff || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (needZip64) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(central.length), 24);
      z.writeBigUInt64LE(BigInt(central.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(out.offset), 8);
      loc.writeUInt32LE(1, 16);
      await out.write(Buffer.concat([z, loc]));
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(needZip64 ? 0xffff : central.length, 8);
    e.writeUInt16LE(needZip64 ? 0xffff : central.length, 10);
    e.writeUInt32LE(needZip64 ? U32_MAX : cdSize, 12);
    e.writeUInt32LE(needZip64 ? U32_MAX : cdStart, 16);
    await out.write(e);
    const total = out.offset;
    await out.close();
    await fs.promises.rename(part, zipPath);
    return { path: zipPath, entries: central.length, bytes: total, zip64: needZip64 || central.some((r) => r.zip64) };
  } catch (err) {
    await out.close().catch(() => undefined);
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface ZipEntryInfo {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/** Reads a zip's central directory (ZIP64 included). */
export async function readZipDirectory(zipPath: string): Promise<{ entries: ZipEntryInfo[]; zip64: boolean }> {
  const fh = await fs.promises.open(zipPath, "r");
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("no end-of-central-directory record");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let zip64 = false;
    if (count === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
      if (eocd < 20 || tail.readUInt32LE(eocd - 20) !== 0x07064b50) throw new Error("ZIP64 locator missing");
      const z64At = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, z64At);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 end record missing");
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
      zip64 = true;
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory record ${i + 1}`);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === U32_MAX) {
            usize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (csize === U32_MAX) {
            csize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === U32_MAX) offset = Number(cd.readBigUInt64LE(q));
          zip64 = true;
        }
        x += 4 + len;
      }
      entries.push({ name, method, crc, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, zip64 };
  } finally {
    await fh.close();
  }
}

export interface ZipVerification {
  ok: boolean;
  entries: number;
  zip64: boolean;
  errors: string[];
}

/**
 * Reads a zip back: every entry is inflated and its CRC32, size and (given
 * `expected`) sha1 compared. Streams, so nothing large is held in memory.
 */
export async function verifyZip(zipPath: string, expected?: Map<string, { bytes: number; sha1: string | null }>): Promise<ZipVerification> {
  const errors: string[] = [];
  const note = (m: string) => {
    if (errors.length < 50) errors.push(m);
  };
  let dir: Awaited<ReturnType<typeof readZipDirectory>>;
  try {
    dir = await readZipDirectory(zipPath);
  } catch (err) {
    return { ok: false, entries: 0, zip64: false, errors: [`the central directory could not be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const fh = await fs.promises.open(zipPath, "r");
  const seen = new Set<string>();
  try {
    for (const e of dir.entries) {
      seen.add(e.name);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) {
        note(`${e.name}: no local header at its offset`);
        continue;
      }
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const crc = new Crc32();
      const sha = crypto.createHash("sha1");
      let n = 0;
      try {
        if (e.csize > 0) {
          const raw = fs.createReadStream(zipPath, { start, end: start + e.csize - 1 });
          const stream = e.method === 8 ? raw.pipe(zlib.createInflateRaw()) : e.method === 0 ? raw : null;
          if (!stream) {
            note(`${e.name}: unsupported method ${e.method}`);
            continue;
          }
          if (e.method === 8) raw.on("error", (err) => stream.destroy(err));
          for await (const chunk of stream) {
            crc.update(chunk as Buffer);
            sha.update(chunk as Buffer);
            n += (chunk as Buffer).length;
          }
        }
      } catch (err) {
        note(`${e.name}: could not be read back: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (crc.value !== e.crc) note(`${e.name}: CRC32 differs`);
      if (n !== e.usize) note(`${e.name}: size ${n} is not the recorded ${e.usize}`);
      const want = expected?.get(e.name);
      if (want) {
        if (want.bytes !== n) note(`${e.name}: ${n} bytes, the manifest has ${want.bytes}`);
        else if (want.sha1 && want.sha1 !== sha.digest("hex")) note(`${e.name}: sha1 differs from the manifest`);
      }
    }
  } finally {
    await fh.close();
  }
  if (expected) {
    for (const name of expected.keys()) if (!seen.has(name)) note(`${name}: missing from the zip`);
  }
  return { ok: errors.length === 0, entries: dir.entries.length, zip64: dir.zip64, errors };
}

// ---------- copying ----------

export async function sha1File(p: string): Promise<string> {
  const h = crypto.createHash("sha1");
  await pipeline(
    fs.createReadStream(p),
    new Writable({
      write(chunk, _enc, cb) {
        h.update(chunk);
        cb();
      },
    })
  );
  return h.digest("hex");
}

/** Copies through a .part file, hashing as it goes; the file appears whole or not at all. */
export async function copyHashed(src: string, dest: string, mtimeMs: number): Promise<{ sha1: string; bytes: number }> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = crypto.createHash("sha1");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(part));
    await fs.promises.rename(part, dest);
    const when = new Date(mtimeMs);
    await fs.promises.utimes(dest, when, when).catch(() => undefined);
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
  return { sha1: hash.digest("hex"), bytes };
}

// ---------- manifest ----------

export interface ManifestFile {
  source: string;
  path: string;
  bytes: number;
  mtime_ms: number;
  sha1: string | null;
  role: Role | "project";
  item_ids: number[];
}

export interface ManifestSource {
  role: Role;
  sequence: boolean;
  ae_files: string[];
  item_ids: number[];
  dest_first: string;
  frames?: ResolvedSource["frames"];
}

export interface Manifest {
  version: 1;
  created: string;
  updated: string;
  complete: boolean;
  project: { path: string; name: string };
  ae: Record<string, unknown> | null;
  options: { only_used: boolean; include_proxies: boolean };
  /** True once ae_collect_relink has pointed the copy at the collected files. */
  relinked: boolean;
  sources: ManifestSource[];
  files: ManifestFile[];
  not_collected: string[];
}

export const NOT_COLLECTED = [
  "Fonts: the DOM can't list font files. ae_fonts names the fonts the project uses; install them on the receiving machine.",
  "Files that effects or 3D layers point to (LUTs in Apply Color LUT or Lumetri, glTF .bin files and textures, textures inside .c4d, plug-in assets): the DOM doesn't list them. AE's own Collect Files has the same gap.",
  "Scripts, presets, expression-referenced files and anything the project reaches by absolute path through a script.",
];

/**
 * The mappings ae_collect_relink gives the host: each path AE reports → its
 * collected file, with the item ids that use it. The host finds items by id
 * (stored in the .aep, so it survives the copy) and falls back to the path.
 */
export function buildMappings(m: Manifest, dest: string): Array<{ from: string; to: string; sequence: boolean; role: Role; item_ids: number[] }> {
  const out: Array<{ from: string; to: string; sequence: boolean; role: Role; item_ids: number[] }> = [];
  for (const s of m.sources) {
    if (!s.dest_first) continue;
    const to = path.join(dest, ...s.dest_first.split("/"));
    for (const from of s.ae_files) out.push({ from, to, sequence: s.sequence, role: s.role, item_ids: s.item_ids });
  }
  return out;
}

export function manifestPath(dest: string): string {
  return path.join(dest, "manifest.json");
}

async function readManifest(dest: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fs.promises.readFile(manifestPath(dest), "utf8")) as Manifest;
    return m && m.version === 1 && Array.isArray(m.files) && Array.isArray(m.sources) ? m : null;
  } catch {
    return null;
  }
}

async function writeFileAtomic(p: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, p);
}

/** What changed in the footage between two collects: by source file. */
export function diffManifests(prev: Manifest | null, files: Array<{ source: string; bytes: number }>): { added: string[]; removed: string[]; changed: string[] } | null {
  if (!prev) return null;
  const before = new Map(prev.files.filter((f) => f.role !== "project").map((f) => [pathKey(f.source), f.bytes]));
  const now = new Map(files.map((f) => [pathKey(f.source), f.bytes]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const f of files) {
    const was = before.get(pathKey(f.source));
    if (was === undefined) added.push(f.source);
    else if (was !== f.bytes) changed.push(f.source);
  }
  const removed = prev.files.filter((f) => f.role !== "project" && !now.has(pathKey(f.source))).map((f) => f.source);
  return { added: added.slice(0, MAX_LIST), removed: removed.slice(0, MAX_LIST), changed: changed.slice(0, MAX_LIST) };
}

// ---------- host reads ----------

interface ProjectState {
  project_path: string;
  saved: boolean;
  /** null when AE would not say: only false counts as clean. */
  dirty: boolean | null;
  num_items: number;
  ae: Record<string, unknown>;
}

interface InfoRead {
  project_path: string;
  dirty: boolean | null;
  ae: Record<string, unknown>;
  num_items: number;
  num_comps: number;
  comps: Array<{ id: number; name: string; width: number; height: number; fps: number; duration: number; num_layers: number }>;
  comps_truncated: boolean;
  effects: Array<{ match_name: string; name: string; count: number }>;
  effects_total?: number;
  effects_truncated?: boolean;
  expressions: { count: number; truncated: boolean };
  layers_capped: boolean;
  render_outputs: Array<{ item: number; comp: string | null; status: string | null; output_module: string | null; file: string | null }>;
  render_outputs_truncated: boolean;
}

const read = <T>(ctx: ToolContext, fn: string, args: unknown, toolName: string) =>
  ctx.bridge.callHost<T>(fn, args, { label: `${toolName} (${fn})`, mutates: false, toolName }).then((r) => r.result);

async function readAllFootage(ctx: ToolContext, toolName: string): Promise<{ entries: FootageEntry[]; noFile: FootagePage["no_file"]; project_path: string; dirty: boolean | null }> {
  const entries: FootageEntry[] = [];
  const noFile: FootagePage["no_file"] = [];
  let offset: number | null = 0;
  let path0 = "<unsaved>";
  let dirty: boolean | null = false;
  for (let page = 0; offset !== null && page < 400; page++) {
    const res: FootagePage = await read<FootagePage>(ctx, "collectFootage", { offset, limit: MAX_LIST }, toolName);
    entries.push(...res.items);
    noFile.push(...res.no_file);
    path0 = res.project_path;
    dirty = res.dirty;
    offset = res.next_offset;
  }
  return { entries, noFile, project_path: path0, dirty };
}

async function resolveAll(entries: FootageEntry[], opts: { include_proxies?: boolean; only_used?: boolean }): Promise<Map<string, ResolvedSource>> {
  const todo = new Map<string, { file: string; sequence: boolean }>();
  for (const e of entries) {
    if (opts.only_used && e.used_in === 0 && !e.proxy_only) continue;
    if (!e.proxy_only) todo.set(sourceKey(e.file, e.sequence), { file: e.file, sequence: e.sequence });
    if (e.proxy && opts.include_proxies !== false) todo.set(sourceKey(e.proxy.file, e.proxy.sequence), { file: e.proxy.file, sequence: e.proxy.sequence });
  }
  const list = [...todo.entries()];
  const out = new Map<string, ResolvedSource>();
  for (let i = 0; i < list.length; i += 8) {
    const batch = list.slice(i, i + 8);
    const res = await Promise.all(batch.map(([, v]) => resolveSource(v.file, v.sequence)));
    batch.forEach(([k], j) => out.set(k, res[j]));
  }
  return out;
}

function destFolder(project: string, dest?: string): string {
  return path.resolve(dest ?? path.join(path.dirname(project), "_collect"));
}

const bad = (message: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, error: "bad_args", message, ...extra });

/** The schema checks this too; handlers called directly (and a relative path through any route) get the same answer. */
function destProblem(dest: string | undefined): string | null {
  if (dest !== undefined && !path.isAbsolute(dest)) return `dest must be an absolute path (got "${dest}"): a relative one would resolve against the panel's own working folder.`;
  return null;
}

const OWN_REPORT_FILES = new Set(["collect-report.md", "collect-report.json", "collect-report.md.tmp", "collect-report.json.tmp"]);

/** What is at dest: a collect of this tool leaves a manifest.json; anything else in there is not ours to overwrite. */
async function inspectDest(dest: string): Promise<{ exists: boolean; isDir: boolean; empty: boolean; manifest: Manifest | null }> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(dest);
  } catch {
    return { exists: false, isDir: false, empty: true, manifest: null };
  }
  if (!st.isDirectory()) return { exists: true, isDir: false, empty: false, manifest: null };
  const names = await fs.promises.readdir(dest).catch(() => [] as string[]);
  // A folder holding only the report files of ae_collect_report (written before any collect) is still free to collect into.
  const onlyOwnReports = names.length > 0 && names.every((n) => OWN_REPORT_FILES.has(n.toLowerCase()));
  return { exists: true, isDir: true, empty: names.length === 0 || onlyOwnReports, manifest: await readManifest(dest) };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Refuses to carry on when the project hasn't been saved or has changed since: the .aep on disk is what gets copied. */
function savedProblem(state: { project_path: string; dirty: boolean | null }): string | null {
  if (state.project_path === "<unsaved>") return "The project has never been saved, so there is no .aep to copy. Name it first with ae_save and save_as: { path }.";
  if (state.dirty !== false) return "The project has unsaved changes (or After Effects would not say). The .aep on disk is what gets copied, so save first (ae_save) and call again.";
  return null;
}

// ---------- ae_collect_files ----------

type FilesArgs = z.infer<typeof AeCollectFilesSchema>;

function summarisePlan(plan: Plan, noFile: FootagePage["no_file"], extraWarnings: string[] = []) {
  const placeholders = noFile.filter((n) => n.kind === "placeholder");
  const noPath = noFile.filter((n) => n.kind === "none");
  const warnings = [...extraWarnings, ...plan.warnings];
  if (noPath.length) warnings.push(`${noPath.length} footage item(s) have no file path in AE and are not solids or placeholders (see no_file_items): nothing can be collected for them.`);
  if (plan.gaps.length) warnings.push(`${plan.gaps.length} image sequence(s) have gaps in their numbering (found by file name, not from AE): the missing frames stay missing.`);
  return {
    sources: plan.sources.length,
    files: plan.files.length,
    bytes: plan.bytes,
    bytes_human: formatBytes(plan.bytes),
    shared_files: plan.shared.slice(0, MAX_LIST),
    shared_files_total: plan.shared.length,
    skipped_unused: plan.skipped_unused,
    problems: plan.problems.slice(0, MAX_LIST),
    problems_total: plan.problems.length,
    sequences_with_gaps: plan.gaps.slice(0, MAX_LIST),
    placeholders: placeholders.slice(0, MAX_LIST),
    placeholders_total: placeholders.length,
    no_file_items: noPath.slice(0, MAX_LIST),
    no_file_items_total: noPath.length,
    solids: noFile.filter((n) => n.kind === "solid").length,
    warnings,
    not_collected: NOT_COLLECTED,
  };
}

/** Folders a copying ae_collect_files call is working in: a second call there would stream the same .part files. */
const collectLocks = new Set<string>();

async function collectFiles(args: FilesArgs, ctx: ToolContext) {
  const hold: { release?: () => void } = {};
  try {
    return await collectFilesBody(args, ctx, hold);
  } finally {
    hold.release?.();
  }
}

async function collectFilesBody(args: FilesArgs, ctx: ToolContext, hold: { release?: () => void }) {
  const tool = "ae_collect_files";
  ctx.quarantine.assertClear();
  const state = await read<ProjectState>(ctx, "collectState", {}, tool);
  if (args.expect && pathKey(args.expect.project_path) !== pathKey(state.project_path)) {
    throw new BridgeError({
      kind: "guard",
      message: `Target guard refused: expected project_path "${args.expect.project_path}", but After Effects has "${state.project_path}" open. Stop and re-read state.`,
      expected: args.expect,
      actual: { project_path: state.project_path },
    });
  }
  const problem = savedProblem(state);
  if (problem) return bad(problem);
  const project = state.project_path;
  if (!fs.existsSync(project)) return bad(`The project file is not on disk: ${project}`);
  const badDest = destProblem(args.dest);
  if (badDest) return bad(badDest);
  const dest = destFolder(project, args.dest);
  const aepDest = path.join(dest, path.basename(project));
  if (pathKey(aepDest) === pathKey(project)) return bad("dest is the project's own folder: the copy would overwrite the .aep. Pick another folder.");
  const dry = args.dry_run !== false;
  // Only a folder this tool made (it has a manifest of this project), or an empty or new one, is written into.
  const destInfo = await inspectDest(dest);
  let destIssue: string | null = null;
  if (destInfo.exists && !destInfo.isDir) destIssue = `dest is a file, not a folder: ${dest}`;
  else if (destInfo.exists && !destInfo.empty && !destInfo.manifest) {
    destIssue = `dest ${dest} is not empty and has no manifest.json from this tool, so it is not a previous collect. Pick a new or empty folder: nothing there is overwritten.`;
  } else if (destInfo.manifest && pathKey(destInfo.manifest.project.path) !== pathKey(project)) {
    destIssue = `dest ${dest} holds a collect of ${destInfo.manifest.project.path}, not of this project. Pick another folder.`;
  }
  if (destIssue && !dry) return bad(destIssue);

  if (!dry) {
    // One copying call per folder: a retry after a client timeout must not stream the same .part files at the same time.
    const lockKey = pathKey(dest);
    if (collectLocks.has(lockKey)) {
      return { ok: false as const, error: "busy", status: "busy", message: `Another ae_collect_files call is still copying into ${dest}. Wait for it to finish, then call again with the same arguments.` };
    }
    collectLocks.add(lockKey);
    hold.release = () => {
      collectLocks.delete(lockKey);
    };
    // A zip of this folder is being written and read back: the files it reads must not be copied over. Wait for it, nothing more.
    const running = zipJobs.get(lockKey);
    if (running && running.state === "running") {
      await Promise.race([running.promise, sleep(Math.max(1000, (args.max_seconds ?? 50) * 1000))]);
      if (running.state === "running") {
        return {
          dry_run: false,
          complete: destInfo.manifest?.complete === true,
          project_path: project,
          dest,
          zip: { ok: false, status: "running", path: `${dest}.zip`, message: "The zip is still being written (and read back to verify it) in the background. Nothing was copied this call; call ae_collect_files again with the same arguments to get the result." },
          next: "The zip is still running. Call again with the same arguments.",
        };
      }
    }
  }

  const foot = await readAllFootage(ctx, tool);
  const resolved = await resolveAll(foot.entries, args);
  const plan = planCollect(foot.entries, resolved, args);
  const warnings: string[] = [];
  if (destIssue) warnings.push(destIssue);
  const longest = plan.files.reduce((n, f) => Math.max(n, path.join(dest, f.path).length), 0);
  if (process.platform === "win32" && longest > 240) warnings.push(`Some collected paths are ${longest} characters long; Windows may refuse paths past 259. Pick a shorter dest.`);
  const sameFolder = plan.files.filter((f) => pathKey(path.join(dest, f.path)) === pathKey(f.source));
  if (sameFolder.length) warnings.push(`${sameFolder.length} file(s) already sit at their collected path: they are left alone.`);
  const projectBytes = fs.statSync(project).size;
  const summary = summarisePlan(plan, foot.noFile, warnings);

  if (dry) {
    return {
      dry_run: true,
      project_path: project,
      dest,
      project_bytes: projectBytes,
      total_bytes: plan.bytes + projectBytes,
      total_human: formatBytes(plan.bytes + projectBytes),
      ...summary,
      files_preview: plan.files.slice(0, MAX_LIST).map((f) => ({ source: f.source, path: f.path, bytes: f.bytes })),
      files_truncated: plan.files.length > MAX_LIST,
      next: "Call again with dry_run: false to copy.",
    };
  }

  // ---- the copy ----
  const prev = args.restart ? null : destInfo.manifest;
  // Files a previous collect of ours put there (it hashed them): the only ones a copy may replace.
  const owned = new Set((destInfo.manifest?.files ?? []).filter((f) => f.sha1).map((f) => pathKey(f.path)));
  const keepAep = !!prev?.relinked && pathKey(prev.project.path) === pathKey(project);
  const t0 = Date.now();
  const deadline = t0 + (args.max_seconds ?? 50) * 1000;
  await fs.promises.mkdir(dest, { recursive: true });

  const aepStat = fs.statSync(project);
  let aepNote: string;
  if (keepAep) {
    aepNote = "kept: the copy there is already relinked (restart: true copies the .aep again)";
  } else {
    await copyHashed(project, aepDest, aepStat.mtimeMs);
    aepNote = "copied";
  }

  const prevSha = new Map((prev?.files ?? []).filter((f) => f.sha1).map((f) => [f.path, f]));
  const files: ManifestFile[] = plan.files.map((f) => ({ ...f, sha1: null }));
  const errors: Array<{ path: string; message: string }> = [];
  let copied = 0;
  let resumed = 0;
  let copiedBytes = 0;
  let stoppedEarly = false;
  const writeManifest = async (complete: boolean) => {
    const m: Manifest = {
      version: 1,
      created: prev?.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
      complete,
      project: { path: project, name: path.basename(project) },
      ae: state.ae,
      options: { only_used: args.only_used === true, include_proxies: args.include_proxies !== false },
      relinked: keepAep,
      sources: plan.sources.map((s) => ({
        role: s.role,
        sequence: s.sequence,
        ae_files: s.ae_files,
        item_ids: s.item_ids,
        dest_first: s.dest_first,
        frames: s.resolved.frames,
      })),
      files: [...files, { source: project, path: path.basename(project), bytes: fs.existsSync(aepDest) ? fs.statSync(aepDest).size : 0, mtime_ms: aepStat.mtimeMs, sha1: null, role: "project", item_ids: [] }],
      not_collected: NOT_COLLECTED,
    };
    await writeFileAtomic(manifestPath(dest), JSON.stringify(m));
    return m;
  };

  // Written before the first file: a crash leaves a manifest, so the next call knows this folder is ours.
  await writeManifest(false);

  for (const f of files) {
    if (Date.now() > deadline) {
      stoppedEarly = true;
      break;
    }
    const target = path.join(dest, ...f.path.split("/"));
    try {
      if (pathKey(target) === pathKey(f.source)) {
        f.sha1 = await sha1File(f.source);
        continue;
      }
      const st = await fs.promises.stat(target).catch(() => null);
      if (st && st.size === f.bytes && Math.abs(st.mtimeMs - f.mtime_ms) < 2000) {
        const was = prevSha.get(f.path);
        f.sha1 = was && was.bytes === f.bytes ? was.sha1 : await sha1File(target);
        resumed++;
        continue;
      }
      if (st && !owned.has(pathKey(f.path))) {
        errors.push({ path: f.path, message: "conflict: a different file is already there and no previous collect put it there. It was left alone; move it away and call again." });
        continue;
      }
      const got = await copyHashed(f.source, target, f.mtime_ms);
      if (got.bytes !== f.bytes) throw new Error(`the source changed while it was copied (${got.bytes} bytes, expected ${f.bytes})`);
      f.sha1 = got.sha1;
      copied++;
      copiedBytes += got.bytes;
    } catch (err) {
      errors.push({ path: f.path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = files.filter((f) => f.sha1).length;
  const complete = !stoppedEarly && errors.length === 0 && done === files.length;
  // Remember what the first run left: the manifest is rewritten even when stopped, so a later call resumes.
  const manifest = await writeManifest(complete);
  const changes = diffManifests(prev, plan.files);

  let reportInfo: Record<string, unknown> | null = null;
  let zipInfo: Record<string, unknown> | null = null;
  if (complete) {
    // The .aep may have been relinked since: hash what is there now.
    const aepEntry = manifest.files.find((f) => f.role === "project");
    if (aepEntry && fs.existsSync(aepDest)) {
      aepEntry.sha1 = await sha1File(aepDest);
      aepEntry.bytes = fs.statSync(aepDest).size;
      await writeFileAtomic(manifestPath(dest), JSON.stringify(manifest));
    }
    if (args.report !== "none") {
      try {
        const file = path.join(dest, args.report === "json" ? "collect-report.json" : "collect-report.md");
        // collect-report.json is the baseline for "changes since the last report": a call that changed nothing (polling a zip, hashing more outputs) must not reset it.
        const lastStamp = await fs.promises
          .readFile(path.join(dest, "collect-report.json"), "utf8")
          .then((t) => (JSON.parse(t) as Partial<VersionReport>).collect_stamp ?? null)
          .catch(() => null);
        if (lastStamp !== null && lastStamp === zipStamp(manifest) && fs.existsSync(file)) {
          reportInfo = { path: file, unchanged: true, note: "The collect has not changed since the last report: it was kept as the baseline for the next diff." };
        } else {
          const r = await buildReport(ctx, { dest, hash_outputs: true, manifest, deadline }, tool);
          await writeFileAtomic(file, args.report === "json" ? JSON.stringify(r, null, 2) : renderReportMarkdown(r));
          await writeFileAtomic(path.join(dest, "collect-report.json"), JSON.stringify(r, null, 2));
          reportInfo = { path: file };
        }
      } catch (err) {
        reportInfo = { error: `The report could not be written: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (args.zip) {
      try {
        zipInfo = await zipStep(dest, manifest, deadline);
      } catch (err) {
        zipInfo = { ok: false, error: `The zip could not be written: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  return {
    dry_run: false,
    complete,
    project_path: project,
    dest,
    aep: { path: aepDest, status: aepNote },
    copied_files: copied,
    copied_bytes: copiedBytes,
    resumed_files: resumed,
    files_done: done,
    files_total: files.length,
    remaining: files.length - done - errors.length,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, MAX_LIST),
    errors_total: errors.length,
    manifest: manifestPath(dest),
    changes_since_last_collect: changes,
    report: reportInfo,
    zip: zipInfo,
    ...summary,
    next: complete
      ? "Done. ae_collect_relink points the copy at these files (it closes and reopens the open project)."
      : stoppedEarly
        ? "Stopped at max_seconds. Call again with the same arguments to continue."
        : "Some files failed (see errors). Fix them and call again.",
  };
}

/** What the zip holds, as far as the manifest says: the files with their sizes and sha1s, so an unchanged collect has the same stamp. */
export function zipStamp(m: Manifest): string {
  const rows = m.files.map((f) => [f.path, f.bytes, f.sha1] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}

interface ZipJob {
  stamp: string;
  state: "running" | "done";
  promise: Promise<void>;
  result: Record<string, unknown> | null;
}
const zipJobs = new Map<string, ZipJob>();

/**
 * The zip for a complete collect. It runs as a background job (the call waits
 * for it only until its deadline), so a multi-GB zip can't hold the call past
 * a client timeout: call again to collect the result. A zip that already
 * verified against the same manifest is left alone.
 */
async function zipStep(dest: string, manifest: Manifest, deadline: number): Promise<Record<string, unknown>> {
  const zipPath = `${dest}.zip`;
  const stampPath = `${zipPath}.stamp`;
  const stamp = zipStamp(manifest);
  const key = pathKey(dest);
  let job = zipJobs.get(key);
  if (job && job.stamp !== stamp) {
    // A job for an older state of this folder: never hand its result back as the current one.
    if (job.state === "running") {
      await Promise.race([job.promise, sleep(Math.max(1000, deadline - Date.now()))]);
      if (job.state === "running") {
        return { ok: false, status: "running", path: zipPath, message: "A zip of an earlier state of this collect is still being written. Call ae_collect_files again with the same arguments once it is done; a new zip is written then." };
      }
    }
    zipJobs.delete(key);
    job = undefined;
  }
  if (!job) {
    const stored = await fs.promises.readFile(stampPath, "utf8").catch(() => null);
    const st = stored !== null && stored.trim() === stamp ? await fs.promises.stat(zipPath).catch(() => null) : null;
    if (st) {
      return { ok: true, path: zipPath, bytes: st.size, bytes_human: formatBytes(st.size), verified: true, verify_errors: [], up_to_date: true, note: "The zip already verified against this manifest: it was not written again." };
    }
    // A zip at <dest>.zip that this tool never wrote (it leaves a .stamp beside every zip it starts) belongs to the user.
    if (stored === null && fs.existsSync(zipPath)) {
      return { ok: false, status: "conflict", path: zipPath, error: "conflict", message: `${zipPath} already exists and was not written by this tool, so it was left alone. Move or rename it and call again.` };
    }
    const fresh: ZipJob = { stamp, state: "running", promise: Promise.resolve(), result: null };
    fresh.promise = zipCollect(dest, manifest, stamp).then(
      (r) => {
        fresh.state = "done";
        fresh.result = r;
      },
      (err) => {
        fresh.state = "done";
        fresh.result = { ok: false, error: `The zip could not be written: ${err instanceof Error ? err.message : String(err)}` };
      }
    );
    zipJobs.set(key, fresh);
    job = fresh;
  }
  if (job.state === "running") {
    await Promise.race([job.promise, sleep(Math.max(1000, deadline - Date.now()))]);
  }
  if (job.state === "running") {
    return { ok: false, status: "running", path: zipPath, message: "The zip is still being written (and read back to verify it) in the background. Call ae_collect_files again with the same arguments to get the result." };
  }
  zipJobs.delete(key);
  return job.result ?? { ok: false, error: "The zip job ended without a result." };
}

async function zipCollect(dest: string, manifest: Manifest, stamp: string) {
  const root = path.basename(dest);
  const zipPath = `${dest}.zip`;
  const inputs: ZipInput[] = [];
  const expected = new Map<string, { bytes: number; sha1: string | null }>();
  for (const f of manifest.files) {
    const abs = path.join(dest, ...f.path.split("/"));
    const st = await fs.promises.stat(abs);
    const name = `${root}/${f.path}`;
    inputs.push({ name, file: abs, mtime: st.mtime });
    expected.set(name, { bytes: st.size, sha1: f.sha1 });
  }
  for (const extra of ["manifest.json", "collect-report.md", "collect-report.json"]) {
    const abs = path.join(dest, extra);
    if (fs.existsSync(abs)) inputs.push({ name: `${root}/${extra}`, file: abs, mtime: fs.statSync(abs).mtime });
  }
  // Marks the zip as ours from here on (a failed or half-verified one may be replaced by the next try).
  await writeFileAtomic(`${zipPath}.stamp`, `pending ${stamp}`);
  const written = await writeZip(zipPath, inputs);
  const check = await verifyZip(zipPath, expected);
  if (check.ok) await writeFileAtomic(`${zipPath}.stamp`, stamp);
  return { ok: check.ok, path: zipPath, entries: written.entries, bytes: written.bytes, bytes_human: formatBytes(written.bytes), zip64: written.zip64, verified: check.ok, verify_errors: check.errors };
}

// ---------- the version report ----------

export interface VersionReport {
  generated: string;
  project: { path: string; name: string; bytes: number | null; mtime: string | null };
  ae: Record<string, unknown>;
  comps: InfoRead["comps"];
  comps_truncated: boolean;
  footage: Array<{
    item_id: number;
    name: string;
    file: string;
    bin: string[];
    sequence: boolean;
    missing: boolean;
    used_in: number;
    bytes: number | null;
    frames?: ResolvedSource["frames"];
    problem?: string;
    proxy: { file: string; in_use: boolean } | null;
  }>;
  footage_truncated: boolean;
  fonts: Array<{ font: string; uses?: number; missing?: boolean | null }> | { error: string };
  effects: InfoRead["effects"];
  effects_truncated?: boolean;
  expressions: InfoRead["expressions"];
  /** Render outputs left unhashed because the time ran out. */
  outputs_not_hashed?: number;
  render_outputs: Array<{
    comp: string | null;
    status: string | null;
    output_module: string | null;
    file: string | null;
    exists: boolean;
    bytes: number | null;
    mtime: string | null;
    newer_than_project: boolean | null;
    sha1: string | null;
    note?: string;
    /** An image-sequence output (a [###] pattern): its frame count. */
    frames?: number;
  }>;
  checkpoints: { dir: string; count: number; latest: string[] };
  collect: { dest: string; complete: boolean; files: number; relinked: boolean; updated: string } | null;
  /** The manifest stamp this report was made for: a later collect with the same stamp keeps this report as the diff baseline. */
  collect_stamp?: string | null;
  not_collected: string[];
  changes_since_last_report: Record<string, unknown> | null;
}

const HASH_LIMIT = 512 * 1024 * 1024;

/** AE writes an image-sequence output as name_[#####].ext: the run of # is the frame number's width. */
const FRAME_TOKEN = /\[(#+)\]/;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The frames on disk for a [#####] output pattern: count, total bytes, oldest and newest mtime. */
async function statSequenceOutput(pattern: string): Promise<{ frames: number; bytes: number; oldest: number; newest: number }> {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const m = FRAME_TOKEN.exec(base) as RegExpExecArray;
  const re = new RegExp(`^${escapeRe(base.slice(0, m.index))}\\d{${m[1].length},}${escapeRe(base.slice(m.index + m[0].length))}$`, WIN_OR_MAC ? "i" : "");
  const names = await fs.promises.readdir(dir);
  let frames = 0;
  let bytes = 0;
  let oldest = Infinity;
  let newest = 0;
  for (const n of names) {
    if (!re.test(n)) continue;
    const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
    if (!st || !st.isFile()) continue;
    frames++;
    bytes += st.size;
    oldest = Math.min(oldest, st.mtimeMs);
    newest = Math.max(newest, st.mtimeMs);
  }
  return { frames, bytes, oldest: frames > 0 ? oldest : 0, newest };
}

export function diffReports(prev: Partial<VersionReport> | null, cur: VersionReport): Record<string, unknown> | null {
  if (!prev || !prev.generated) return null;
  const pf = new Map((prev.footage ?? []).map((f) => [pathKey(f.file), f.bytes]));
  const cf = new Map(cur.footage.map((f) => [pathKey(f.file), f.bytes]));
  const added = cur.footage.filter((f) => !pf.has(pathKey(f.file))).map((f) => f.file);
  const removed = (prev.footage ?? []).filter((f) => !cf.has(pathKey(f.file))).map((f) => f.file);
  const changed = cur.footage.filter((f) => pf.has(pathKey(f.file)) && pf.get(pathKey(f.file)) !== f.bytes).map((f) => f.file);
  const pc = new Set((prev.comps ?? []).map((c) => c.name));
  const cc = new Set(cur.comps.map((c) => c.name));
  return {
    since: prev.generated,
    footage_added: added.slice(0, MAX_LIST),
    footage_removed: removed.slice(0, MAX_LIST),
    footage_changed: changed.slice(0, MAX_LIST),
    comps_added: [...cc].filter((n) => !pc.has(n)).slice(0, MAX_LIST),
    comps_removed: [...pc].filter((n) => !cc.has(n)).slice(0, MAX_LIST),
    expressions_before: prev.expressions?.count ?? null,
    expressions_now: cur.expressions.count,
  };
}

async function buildReport(
  ctx: ToolContext,
  opts: { dest: string; hash_outputs: boolean; manifest?: Manifest | null; deadline?: number },
  toolName: string
): Promise<VersionReport> {
  const info = await read<InfoRead>(ctx, "collectInfo", {}, toolName);
  const foot = await readAllFootage(ctx, toolName);
  const project = info.project_path;
  let pStat: fs.Stats | null = null;
  try {
    pStat = project === "<unsaved>" ? null : fs.statSync(project);
  } catch {
    pStat = null;
  }
  // Comps that only have a proxy are not footage: they are left out of the footage table.
  const footEntries = foot.entries.filter((e) => !e.proxy_only);
  const resolved = await resolveAll(footEntries, { include_proxies: false });
  const footage = footEntries.slice(0, MAX_LIST).map((e) => {
    const r = resolved.get(sourceKey(e.file, e.sequence));
    return {
      item_id: e.item_id,
      name: e.name,
      file: e.file,
      bin: e.bin,
      sequence: e.sequence,
      missing: e.missing,
      used_in: e.used_in,
      bytes: r && r.files.length ? r.files.reduce((n, f) => n + f.bytes, 0) : null,
      ...(r?.frames ? { frames: r.frames } : {}),
      ...(r?.error ? { problem: r.error } : {}),
      proxy: e.proxy ? { file: e.proxy.file, in_use: e.proxy.in_use } : null,
    };
  });
  let fonts: VersionReport["fonts"];
  try {
    const f = await read<{ fonts?: Array<{ font: string; uses?: number; missing?: boolean | null }> }>(ctx, "fontsInUse", {}, toolName);
    fonts = (f.fonts ?? []).slice(0, MAX_LIST);
  } catch (err) {
    fonts = { error: `Fonts could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const outputs: VersionReport["render_outputs"] = [];
  let notHashed = 0;
  for (const o of info.render_outputs.slice(0, MAX_LIST)) {
    const row: VersionReport["render_outputs"][number] = { comp: o.comp, status: o.status, output_module: o.output_module, file: o.file, exists: false, bytes: null, mtime: null, newer_than_project: null, sha1: null };
    if (o.file && FRAME_TOKEN.test(path.basename(o.file))) {
      // An image-sequence output: comp_[#####].png is a pattern, not a file. Count the frames it produced.
      try {
        const seqInfo = await statSequenceOutput(o.file);
        row.frames = seqInfo.frames;
        row.exists = seqInfo.frames > 0;
        row.bytes = seqInfo.bytes;
        row.mtime = seqInfo.newest > 0 ? new Date(seqInfo.newest).toISOString() : null;
        row.newer_than_project = pStat && seqInfo.frames > 0 ? seqInfo.oldest >= pStat.mtimeMs : null;
        row.note = seqInfo.frames > 0 ? `image sequence: ${seqInfo.frames} frame(s), frames not hashed` : "no frames of this image sequence are on disk";
      } catch {
        row.note = "the folder of this image sequence is not on disk";
      }
    } else if (o.file) {
      try {
        const st = await fs.promises.stat(o.file);
        row.exists = st.isFile();
        row.bytes = st.size;
        row.mtime = st.mtime.toISOString();
        row.newer_than_project = pStat ? st.mtimeMs >= pStat.mtimeMs : null;
        if (row.exists && opts.hash_outputs) {
          if (opts.deadline !== undefined && Date.now() > opts.deadline) {
            row.note = "not hashed: max_seconds ran out (call again to hash it)";
            notHashed++;
          } else if (st.size <= HASH_LIMIT) row.sha1 = await sha1File(o.file);
          else row.note = `larger than ${formatBytes(HASH_LIMIT)}: not hashed`;
        }
        if (row.exists && st.size === 0) row.note = "the file is empty";
      } catch {
        row.note = "the file is not on disk";
      }
    }
    outputs.push(row);
  }
  let checkpoints: VersionReport["checkpoints"] = { dir: "", count: 0, latest: [] };
  if (project !== "<unsaved>") {
    const dir = checkpointDirFor(project);
    try {
      const names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".aep")).sort();
      checkpoints = { dir, count: names.length, latest: names.slice(-5).reverse() };
    } catch {
      checkpoints = { dir, count: 0, latest: [] };
    }
  }
  const m = opts.manifest === undefined ? await readManifest(opts.dest) : opts.manifest;
  const report: VersionReport = {
    generated: new Date().toISOString(),
    project: { path: project, name: path.basename(project), bytes: pStat?.size ?? null, mtime: pStat ? pStat.mtime.toISOString() : null },
    ae: info.ae,
    comps: info.comps,
    comps_truncated: info.comps_truncated,
    footage,
    footage_truncated: footEntries.length > MAX_LIST,
    fonts,
    effects: info.effects,
    effects_truncated: info.effects_truncated === true,
    expressions: info.expressions,
    outputs_not_hashed: notHashed,
    render_outputs: outputs,
    checkpoints,
    collect: m ? { dest: opts.dest, complete: m.complete, files: m.files.length, relinked: m.relinked, updated: m.updated } : null,
    collect_stamp: m ? zipStamp(m) : null,
    not_collected: NOT_COLLECTED,
    changes_since_last_report: null,
  };
  let prev: Partial<VersionReport> | null = null;
  try {
    prev = JSON.parse(await fs.promises.readFile(path.join(opts.dest, "collect-report.json"), "utf8"));
  } catch {
    prev = null;
  }
  report.changes_since_last_report = diffReports(prev, report);
  return report;
}

export function renderReportMarkdown(r: VersionReport): string {
  const L: string[] = [];
  const ae = r.ae as { version?: string; build_name?: string; build_number?: number; os?: string };
  L.push(`# ${r.project.name} - delivery note`, "");
  L.push(`Generated ${r.generated}`, "");
  L.push("## Project", "");
  L.push(`- File: \`${r.project.path}\`${r.project.bytes !== null ? ` (${formatBytes(r.project.bytes)}, saved ${r.project.mtime})` : ""}`);
  L.push(`- After Effects ${ae.version ?? "?"}${ae.build_number !== undefined ? ` (build ${ae.build_number}${ae.build_name ? `, ${ae.build_name}` : ""})` : ""}${ae.os ? ` on ${ae.os}` : ""}`);
  if (r.collect) L.push(`- Collected into \`${r.collect.dest}\`: ${r.collect.files} files, ${r.collect.complete ? "complete" : "incomplete"}${r.collect.relinked ? ", relinked" : ""}`);
  L.push("", `## Comps (${r.comps.length}${r.comps_truncated ? "+" : ""})`, "");
  L.push("| Comp | Size | Frame rate | Duration | Layers |", "| --- | --- | --- | --- | --- |");
  for (const c of r.comps) L.push(`| ${c.name} | ${c.width}x${c.height} | ${c.fps} | ${c.duration.toFixed(2)} s | ${c.num_layers} |`);
  L.push("", `## Footage (${r.footage.length}${r.footage_truncated ? "+" : ""})`, "");
  L.push("| Name | File | Size | Used in | Notes |", "| --- | --- | --- | --- | --- |");
  for (const f of r.footage) {
    const notes = [f.missing ? "missing in AE" : "", f.problem ?? "", f.sequence ? `sequence${f.frames ? `, ${f.frames.count} frames${f.frames.gaps ? `, ${f.frames.gaps} missing` : ""}` : ""}` : "", f.proxy ? "proxy" : ""].filter(Boolean).join("; ");
    L.push(`| ${f.name} | \`${f.file}\` | ${f.bytes === null ? "?" : formatBytes(f.bytes)} | ${f.used_in} | ${notes} |`);
  }
  L.push("", "## Fonts", "");
  if (Array.isArray(r.fonts)) {
    if (r.fonts.length === 0) L.push("None found.");
    for (const f of r.fonts) L.push(`- ${f.font}${f.uses !== undefined ? ` (${f.uses} use${f.uses === 1 ? "" : "s"})` : ""}${f.missing ? " - missing on this machine" : ""}`);
  } else {
    L.push(r.fonts.error);
  }
  L.push("", "## Effects and expressions", "");
  L.push(`- Expressions: ${r.expressions.count}${r.expressions.truncated ? " (partial: the scan stopped at its limit)" : ""}`);
  for (const e of r.effects) L.push(`- ${e.name} (\`${e.match_name}\`) x ${e.count}`);
  if (r.effects_truncated) L.push("- (the effects list was cut at 500 kinds)");
  L.push("", "## Render outputs", "");
  if (r.render_outputs.length === 0) L.push("The render queue is empty.");
  for (const o of r.render_outputs) {
    const verdict = !o.file ? "no file" : !o.exists ? "NOT ON DISK" : o.bytes === 0 ? "EMPTY" : o.newer_than_project === false ? "older than the saved project" : "ok";
    L.push(`- ${o.comp ?? "?"} (${o.output_module ?? "?"}): ${o.file ?? "no file"} - ${verdict}${o.bytes !== null ? `, ${formatBytes(o.bytes)}` : ""}${o.sha1 ? `, sha1 ${o.sha1}` : ""}${o.note ? ` (${o.note})` : ""}`);
  }
  L.push("", "## Checkpoints", "");
  L.push(`${r.checkpoints.count} in \`${r.checkpoints.dir || "-"}\`${r.checkpoints.latest.length ? `; latest: ${r.checkpoints.latest.join(", ")}` : ""}`);
  if (r.changes_since_last_report) {
    const c = r.changes_since_last_report as Record<string, unknown[]>;
    L.push("", `## Changes since ${String(r.changes_since_last_report.since)}`, "");
    for (const k of ["footage_added", "footage_removed", "footage_changed", "comps_added", "comps_removed"]) {
      const v = c[k] ?? [];
      if (v.length) L.push(`- ${k.replace("_", " ")}: ${v.join(", ")}`);
    }
  }
  L.push("", "## Not collected", "");
  for (const n of r.not_collected) L.push(`- ${n}`);
  return L.join("\n") + "\n";
}

async function reportHandler(args: z.infer<typeof AeCollectReportSchema>, ctx: ToolContext) {
  const tool = "ae_collect_report";
  const badDest = destProblem(args.dest);
  if (badDest) return bad(badDest);
  const state = await read<ProjectState>(ctx, "collectState", {}, tool);
  if (state.project_path === "<unsaved>" && !args.dest) return bad("The project has never been saved: give dest.");
  const dest = destFolder(state.project_path, args.dest);
  const report = await buildReport(ctx, { dest, hash_outputs: args.hash_outputs !== false, deadline: Date.now() + (args.max_seconds ?? 50) * 1000 }, tool);
  const format = args.format ?? "markdown";
  let written: string | null = null;
  let writeError: string | null = null;
  if (args.write !== false) {
    try {
      written = path.join(dest, format === "json" ? "collect-report.json" : "collect-report.md");
      await writeFileAtomic(written, format === "json" ? JSON.stringify(report, null, 2) : renderReportMarkdown(report));
      await writeFileAtomic(path.join(dest, "collect-report.json"), JSON.stringify(report, null, 2));
    } catch (err) {
      writeError = `The report could not be written: ${err instanceof Error ? err.message : String(err)}`;
      written = null;
    }
  }
  if (format === "json") return { format, written, write_error: writeError, report };
  const text = renderReportMarkdown(report);
  return {
    format,
    written,
    write_error: writeError,
    markdown: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
    truncated: text.length > MAX_TEXT,
  };
}

// ---------- ae_collect_relink ----------

function markReopenedSafely(): void {
  try {
    getSessionTracker()?.markReopened();
  } catch {
    // Session tracking must never break a relink.
  }
}

type RelinkArgs = z.infer<typeof AeCollectRelinkSchema>;

interface SwitchResult {
  closed: string;
  saved: boolean;
  project_path: string;
  dirty: boolean;
  num_items: number;
}

/** One relinked item: what it should read back as. */
export interface RelinkedItem {
  item_id: number;
  name: string;
  /** The collected file the main source should point at (null when only the proxy was relinked). */
  to: string | null;
  sequence: boolean;
  proxy_to: string | null;
  proxy_sequence: boolean;
  /** The proxy switch before the relink: it must not change. */
  use_proxy: boolean;
}

export interface ItemCheck {
  item_id: number;
  found: boolean;
  name: string | null;
  file: string | null;
  proxy_file: string | null;
  use_proxy: boolean | null;
}

interface RelinkResult {
  project_path: string;
  relinked: number;
  proxies_relinked: number;
  removed_unused: number | null;
  reduced: number | null;
  errors: Array<{ item_id: number | null; name: string | null; role: string; message: string }>;
  errors_total: number;
  items?: RelinkedItem[];
  items_truncated?: boolean;
}

interface VerifyResult {
  checked: number;
  pointing_at_collected: number;
  elsewhere: Array<{ item_id: number; name: string; file: string }>;
  elsewhere_total?: number;
  elsewhere_truncated?: boolean;
  item_checks?: ItemCheck[];
}

const MAX_ITEM_MISMATCHES = 50;

/** The item ids a complete relink must have touched: what the manifest collected files for. */
export interface ExpectedRelink {
  main: number[];
  proxy: number[];
}

export function expectedRelink(m: Manifest): ExpectedRelink {
  const main = new Set<number>();
  const proxy = new Set<number>();
  for (const src of m.sources) {
    if (!src.dest_first) continue;
    const into = src.role === "main" ? main : proxy;
    for (const id of src.item_ids) into.add(id);
  }
  return { main: [...main], proxy: [...proxy] };
}

function pointsAt(actual: string | null, to: string, sequence: boolean): boolean {
  if (!actual) return false;
  const a = pathKey(actual);
  const t = pathKey(to);
  if (a === t) return true;
  // A sequence reports one of its frames: the same folder is the same sequence.
  return sequence && a.replace(/\/[^/]*$/, "") === t.replace(/\/[^/]*$/, "");
}

/**
 * Compares what the host read back from the relinked copy (a separate
 * evalScript) with what each relinked item should be: pointing at its
 * collected file, with its old name and its old proxy switch. `trimmed`: the
 * copy had unused footage removed or was reduced, so an item may be gone.
 */
export function verifyItemMismatches(relink: RelinkResult, verify: VerifyResult, trimmed: boolean, expected?: ExpectedRelink): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const items = relink.items ?? [];
  if (items.length === 0 && relink.relinked + relink.proxies_relinked > 0) {
    m.push({ path: "verify", expected: "a per-item result from the relink", actual: null, message: "The relink reported success but gave no per-item results, so nothing could be checked against the read-back." });
    return m;
  }
  if (relink.items_truncated) m.push({ path: "verify.items", expected: "every relinked item checked", actual: items.length, message: `Only the first ${items.length} relinked items were checked against the read-back.` });
  const checks = new Map((verify.item_checks ?? []).map((c) => [c.item_id, c]));
  const found: ReceiptMismatch[] = [];
  const note = (p: string, exp: unknown, actual: unknown, message: string) => found.push({ path: p, expected: exp, actual, message });
  if (expected && !relink.items_truncated) {
    // Items the manifest collected that the host never touched (it did not find them in the copy, or what it found did not match): they still point at the original footage.
    const mainDone = new Set(items.filter((i) => i.to !== null).map((i) => i.item_id));
    const proxyDone = new Set(items.filter((i) => i.proxy_to !== null).map((i) => i.item_id));
    const failed = new Set(relink.errors.filter((e) => e.item_id !== null).map((e) => `${e.role}:${e.item_id}`));
    for (const id of expected.main) {
      if (!mainDone.has(id) && !failed.has(`main:${id}`) && !failed.has(`layered:${id}`)) {
        note(`items.${id}.missing`, "relinked in the copy", null, `item ${id} was collected but the relink did not find or relink it in the copy: it still points at the original footage`);
      }
    }
    for (const id of expected.proxy) {
      if (!proxyDone.has(id) && !failed.has(`proxy:${id}`)) {
        note(`items.${id}.proxy_missing`, "proxy relinked in the copy", null, `item ${id}'s proxy was collected but the relink did not find or relink it in the copy: it still points at the original proxy`);
      }
    }
  }
  for (const it of items) {
    const c = checks.get(it.item_id);
    const label = `"${it.name}" (item ${it.item_id})`;
    if (!c) {
      note(`items.${it.item_id}`, "read back", null, `${label} was not in the read-back`);
      continue;
    }
    if (!c.found) {
      if (!trimmed) note(`items.${it.item_id}`, "present in the copy", "gone", `${label} is gone from the copy`);
      continue;
    }
    if (c.name !== it.name) note(`items.${it.item_id}.name`, it.name, c.name, `${label}: the name changed to "${c.name}"`);
    if (it.to && !pointsAt(c.file, it.to, it.sequence)) note(`items.${it.item_id}.file`, it.to, c.file, `${label} does not point at its collected file`);
    if (it.proxy_to && !pointsAt(c.proxy_file, it.proxy_to, it.proxy_sequence)) note(`items.${it.item_id}.proxy`, it.proxy_to, c.proxy_file, `${label}: the proxy does not point at its collected file`);
    if (c.use_proxy !== null && c.use_proxy !== it.use_proxy) note(`items.${it.item_id}.use_proxy`, it.use_proxy, c.use_proxy, `${label}: the proxy switch changed (relinking switched it ${c.use_proxy ? "on" : "off"})`);
  }
  m.push(...found.slice(0, MAX_ITEM_MISMATCHES));
  if (found.length > MAX_ITEM_MISMATCHES) {
    m.push({ path: "items", expected: 0, actual: found.length, message: `${found.length - MAX_ITEM_MISMATCHES} more relinked item(s) differ from what the relink intended` });
  }
  return m;
}

/** Compares the state the original project comes back in with the one it left in. */
export function relinkMismatches(
  original: string,
  before: Pick<ProjectState, "num_items"> | null,
  after: Pick<ProjectState, "project_path" | "dirty" | "num_items"> | null,
  extra: { phaseError: string | null; restoreError: string | null; relink: RelinkResult | null; trimmed?: boolean }
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (extra.phaseError) m.push({ path: "relink", expected: "the copy relinked and saved", actual: extra.phaseError, message: `Relinking the copy failed: ${extra.phaseError}. The copy was not saved.` });
  if (extra.restoreError) {
    m.push({ path: "reopen", expected: original, actual: null, message: `The original project could not be reopened: ${extra.restoreError}. Open ${original} by hand (File > Open); it was not changed.` });
  }
  if (extra.relink && extra.relink.errors_total > 0) {
    m.push({ path: "relink.errors", expected: 0, actual: extra.relink.errors_total, message: `${extra.relink.errors_total} item(s) could not be relinked or trimmed in the copy (see relink.errors)` });
  }
  if (after) {
    expectThat(m, pathKey(after.project_path) === pathKey(original), "project_path", original, after.project_path, "The original project is not the open one again");
    expectThat(m, after.dirty === false, "dirty", false, after.dirty, "The reopened original has unsaved changes");
    // Trimming (remove_unused, reduce_to) only touches the copy: the original keeps every item.
    if (before) expectThat(m, after.num_items === before.num_items, "num_items", before.num_items, after.num_items, "The reopened original has a different number of items");
  }
  return m;
}

async function relinkHandler(args: RelinkArgs, ctx: ToolContext) {
  const tool = "ae_collect_relink";
  ctx.quarantine.assertClear();
  const original = args.expect.project_path;
  if (original === "<unsaved>") return bad("The project has never been saved: there is nothing to collect or reopen.");
  const badDest = destProblem(args.dest);
  if (badDest) return bad(badDest);
  const dest = destFolder(original, args.dest);
  const manifest = await readManifest(dest);
  if (!manifest) return bad(`No manifest in ${dest}. Run ae_collect_files with dry_run false first.`);
  if (!manifest.complete) return bad("The collect is not complete. Call ae_collect_files again until it says complete.");
  if (pathKey(manifest.project.path) !== pathKey(original)) return bad(`The collect in ${dest} is of ${manifest.project.path}, not the open project.`);
  const copyPath = path.join(dest, manifest.project.name);
  if (!fs.existsSync(copyPath)) return bad(`The .aep copy is not at ${copyPath}.`);
  if (manifest.relinked) return bad("The copy is already relinked. Run ae_collect_files with restart: true to copy the .aep again first.");
  const mappings = buildMappings(manifest, dest);
  if (mappings.length === 0) return bad("The manifest has nothing to relink.");
  const missing = mappings.filter((x) => !fs.existsSync(x.to));
  if (missing.length) return bad(`${missing.length} collected file(s) are missing from ${dest}: ${missing[0].to}`, { missing: missing.slice(0, 20).map((x) => x.to) });

  let reduceTo: Array<{ id: number; name: string }> | undefined;
  if (args.reduce_to_comp_ids?.length) {
    const info = await read<InfoRead>(ctx, "collectInfo", { scan: false }, tool);
    reduceTo = [];
    for (const id of args.reduce_to_comp_ids) {
      const c = info.comps.find((x) => x.id === id);
      if (!c) return bad(`No comp with id ${id}${info.comps_truncated ? " in the first 500 comps" : ""}.`);
      reduceTo.push({ id, name: c.name });
    }
  }
  const removeUnused = args.remove_unused ?? manifest.options.only_used;
  const trimmed = removeUnused || !!reduceTo;
  const opId = ctx.bridge.newOpId();
  let seq = 0;
  const host = <T>(fn: string, a: unknown, mutates: boolean, mustSend = false) =>
    ctx.bridge.evalRaw<T>({
      id: `${opId}_${++seq}`,
      script: buildJsxCall(fn, a),
      label: `${tool} (${fn})`,
      // A close and open of a big project is slow: wait, never abort an evalScript in flight.
      timeoutMs: SLOW_TIMEOUT_MS,
      mutates,
      mustSend,
      toolName: tool,
    });

  try {
    return await ctx.queue.run(tool, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, args.expect, opId);
      if (guard.dirty !== false) {
        return bad("The project has unsaved changes (or AE could not say). Save it first (ae_save): relinking closes it without saving.");
      }
      const before = (await host<ProjectState>("collectState", {}, false)).result;

      // Kept apart: opening or relinking failed (the relink is not done) versus the read-back failed (it may have worked).
      let phaseError: string | null = null;
      let verifyError: string | null = null;
      let relink: RelinkResult | null = null;
      let verify: VerifyResult | null = null;
      try {
        await host<SwitchResult>("collectSwitch", { to_path: copyPath, expect_open: [original], label: "Open the collected copy" }, true);
      } catch (err) {
        // Closed but not opened, or refused before closing? Only the first leaves the original shut.
        const st = await host<ProjectState>("collectState", {}, false).then((r) => r.result).catch(() => null);
        if (st && pathKey(st.project_path) === pathKey(original)) throw err;
        phaseError = err instanceof Error ? err.message : String(err);
      } finally {
        // The bridge hook only sees openProject(): this tool closes and opens projects itself, so earlier undo steps are gone (also after a throw or timeout).
        markReopenedSafely();
      }
      if (!phaseError) {
        try {
          relink = (
            await host<RelinkResult>(
              "collectRelink",
              { expect: { project_path: copyPath }, mappings, remove_unused: removeUnused, reduce_to: reduceTo, label: "Relink collected footage" },
              true
            )
          ).result;
        } catch (err) {
          phaseError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!phaseError && relink) {
        try {
          // Read back in its own evalScript.
          verify = (await host<VerifyResult>("collectVerify", { mappings, items: relink.items ?? [] }, false)).result;
        } catch (err) {
          verifyError = err instanceof Error ? err.message : String(err);
        }
      }

      // From here the user's project is closed: always try to bring it back, and never throw.
      // The copy is saved only when the relink ran and the read-back could be made.
      const relinkOk = !phaseError && !verifyError && relink !== null && verify !== null;
      let restoreError: string | null = null;
      let reopened: SwitchResult | null = null;
      let saveError: string | null = null;
      try {
        reopened = (
          await host<SwitchResult>(
            "collectSwitch",
            { to_path: original, expect_open: [copyPath, "<unsaved>"], save_first: relinkOk, discard_changes: !relinkOk, label: "Reopen the original project" },
            true,
            true
          )
        ).result;
      } catch (err) {
        restoreError = err instanceof Error ? err.message : String(err);
        if (relinkOk) {
          // Saving the copy can throw before anything closes (read-only or full disk): then the copy is still open. Discard it and bring the original back.
          const st = await host<ProjectState>("collectState", {}, false, true).then((r) => r.result).catch(() => null);
          if (st && pathKey(st.project_path) === pathKey(copyPath)) {
            try {
              reopened = (
                await host<SwitchResult>(
                  "collectSwitch",
                  { to_path: original, expect_open: [copyPath, "<unsaved>"], save_first: false, discard_changes: true, label: "Reopen the original project (copy not saved)" },
                  true,
                  true
                )
              ).result;
              saveError = restoreError;
              restoreError = null;
            } catch (err2) {
              restoreError = err2 instanceof Error ? err2.message : String(err2);
            }
          }
        }
      } finally {
        markReopenedSafely();
      }
      const afterRead = await readAfterWrite(opId, async () => (await host<ProjectState>("collectState", {}, false)).result);
      const mismatches = relinkMismatches(original, before, afterRead.value, { phaseError, restoreError, relink, trimmed });
      if (afterRead.failure) mismatches.push(afterRead.failure);
      if (verifyError) {
        mismatches.push({
          path: "read_back",
          expected: "a read-back of the relinked copy",
          actual: null,
          message: `The relink ran in the copy but reading it back failed (${verifyError}). The copy was discarded unsaved because it could not be verified; the original is unchanged. Run ae_collect_relink again.`,
        });
      }
      const itemMismatches = relinkOk && relink && verify ? verifyItemMismatches(relink, verify, trimmed, expectedRelink(manifest)) : [];
      mismatches.push(...itemMismatches);
      const copySaved = relinkOk && reopened !== null && reopened.saved === true;
      if (relinkOk && !copySaved) {
        mismatches.push({
          path: "copy.saved",
          expected: "the relinked copy saved",
          actual: reopened ? reopened.saved : null,
          message: `The relinked copy was not saved (${saveError ? `the save failed: ${saveError}` : "the save or the switch back failed"}), so the file on disk is not relinked. The manifest still says relinked: false.`,
        });
      }
      // Marked relinked only when the copy was saved, nothing failed in the host (errors_total) and every collected item read back as intended.
      if (copySaved && itemMismatches.length === 0 && (relink?.errors_total ?? 0) === 0) {
        try {
          const m2: Manifest = { ...manifest, relinked: true, updated: new Date().toISOString() };
          const aep = m2.files.find((f) => f.role === "project");
          if (aep) {
            aep.sha1 = await sha1File(copyPath);
            aep.bytes = fs.statSync(copyPath).size;
          }
          await writeFileAtomic(manifestPath(dest), JSON.stringify(m2));
        } catch (err) {
          mismatches.push({ path: "manifest", expected: "relinked: true", actual: null, message: `The copy is relinked but the manifest could not be updated: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
      const receipt = buildReceipt({ before, after: afterRead.value, customMismatches: mismatches });
      return {
        op_id: opId,
        applied: true as const,
        copy_path: copyPath,
        copy_saved: copySaved,
        original_reopened: !restoreError && !!afterRead.value && pathKey(afterRead.value.project_path) === pathKey(original),
        relinked: relink?.relinked ?? 0,
        proxies_relinked: relink?.proxies_relinked ?? 0,
        removed_unused: relink?.removed_unused ?? null,
        reduced: relink?.reduced ?? null,
        errors: relink?.errors ?? [],
        errors_total: relink?.errors_total ?? 0,
        in_copy: verify
          ? {
              checked: verify.checked,
              pointing_at_collected: verify.pointing_at_collected,
              elsewhere: verify.elsewhere,
              elsewhere_total: verify.elsewhere_total ?? verify.elsewhere.length,
              elsewhere_truncated: verify.elsewhere_truncated === true,
            }
          : null,
        lost: "The undo history and open viewers of the original project (it was closed and reopened).",
        receipt,
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

// ---------- tools ----------

export const collectTools: ToolDefinition<any>[] = [
  {
    name: "ae_collect_files",
    description:
      "Collect Files without AE's dialog. Default is a DRY RUN: total bytes, the files, shared footage (collected once), missing files, sequences with gaps, and what can't be collected (fonts, files that effects point to). " +
      "With dry_run false it copies the saved .aep (Node fs, never save-as) and every footage file and proxy into <dest>/_Footage/<bin path>, with a manifest.json of sources, new paths, bytes and sha1. " +
      "The project must be saved with no unsaved changes. A call works for max_seconds (default 50) and is resumable: call again with the same arguments. " +
      "With zip, a complete collect also gets <dest>.zip (ZIP64, streamed, verified by reading it back) and with report the version report. Image sequences are found by file name (AE's DOM has no frame list). " +
      "dest must be absolute and either new, empty or a previous collect of this project: nothing else is overwritten (a file already at a collected path is reported as a conflict). A zip runs in the background past max_seconds: call again for the result (nothing is copied while it runs). An existing <dest>.zip this tool did not write is left alone and reported as a conflict. One copying call per folder at a time (a second gets status busy). Proxies of comps are collected too. The report is rewritten only when the collect changed. " +
      "It changes nothing in AE; relinking the copy is the separate ae_collect_relink.",
    schema: AeCollectFilesSchema,
    handler: (args: FilesArgs, ctx) => collectFiles(args, ctx),
  },
  {
    name: "ae_collect_relink",
    description:
      "Point the COPY made by ae_collect_files at the collected footage. Relinking needs the copy open, so this CLOSES the open project without saving, opens the copy, relinks " +
      "(replace / replaceWithSequence(file, false) / setProxy, keeping item names and proxy on/off), optionally removes unused footage or reduces the copy to chosen comps, saves the copy and reopens the original. " +
      "The undo history and open viewers of the original are lost, and AE may raise a missing-footage dialog that blocks until it is answered (ae_dialogs, ae_dialog_respond). " +
      "Needs confirm_close_project: true and a project with no unsaved changes. The original .aep is never modified. The read-back (a separate evalScript) checks the original is open again and unchanged, and that every relinked item points at its collected file and kept its name and proxy switch; the copy counts as relinked only if it was saved, no item failed, and every collected item (found in the copy by item id, then by path) read back right. Layered PSD/AI items are not replaced (replace() would flatten them): they are listed as errors to relink by hand. Comp proxies are relinked too. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCollectRelinkSchema,
    handler: (args: RelinkArgs, ctx) => relinkHandler(args, ctx),
  },
  {
    name: "ae_collect_report",
    description:
      "The version report, doubling as a delivery note: AE version and build, comps with their specs, footage with sizes and frame counts, fonts, effects, expression count, render-queue outputs " +
      "(on disk, size, sha1, newer than the saved project), checkpoints, what is not collected, and what changed since the last report. Markdown or JSON; written next to the manifest by default. Read-only in AE.",
    schema: AeCollectReportSchema,
    handler: (args: z.infer<typeof AeCollectReportSchema>, ctx) => reportHandler(args, ctx),
  },
];
