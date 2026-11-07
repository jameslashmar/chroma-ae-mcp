/**
 * server/src/seqscan.ts
 *
 * Finds the frames an image sequence is missing, from the folder alone. No
 * After Effects, no tool context: the file system is injected (`SeqIo`), so
 * the cost rules can be tested with a counting fake.
 *
 * What counts as a frame: a file name whose LAST digit run sits directly
 * before the extension (`beauty.0001.exr`, `shot_0001.png`). So
 * `shot_0001_v2.exr` is frame 2 of the sequence `shot_0001_v`, and a name
 * with text AFTER the number (`shot_0001_beauty.exr`) is not matched at all:
 * the check counts it as unchecked instead of calling it complete.
 * (server/src/assets.ts uses the same rule; collect.ts has a looser one on
 * purpose, see collect.ts `splitFrameName`.)
 *
 * Width rule: a number that starts with 0 and has more than one digit is
 * padded, and only names with that width belong to its sequence; numbers
 * without a leading zero (`frame1 ... frame100`) share one sequence whatever
 * their width. A padded width also takes the longer numbers past its range
 * (`shot_099`, `shot_1000`), and it is not taken for padding at all when
 * shorter unpadded numbers of the same name exist (a stray `frame01.png`
 * beside `frame1 ... frame200`).
 *
 * Only gaps BETWEEN the first and last frame on disk are found. A sequence
 * that starts late or ends early looks complete from a folder listing; when
 * After Effects' own frame count is known and larger, the sequence is flagged
 * "short" (a guess).
 *
 * Cost rules (all enforced in `checkSequences`):
 * - one directory listing per directory, shared by every sequence in it, cut
 *   at `maxEntries` names (opendir stops early, a huge folder is not read whole);
 * - never a `stat` per frame: at most STAT_SAMPLE_HIGH + 1 stats per sequence
 *   (the highest-numbered frames, and the frame just above the first gap);
 * - EVERY listing and stat is raced against the time budget that is left: a
 *   call that never returns is abandoned (it keeps running in the background,
 *   Node cannot cancel fs calls) and counted as unchecked. Two directories at
 *   a time, and while HUNG_FS_LIMIT or more abandoned calls are still stuck (a count kept across checks) no new
 *   fs call is started at all: the inputs are unchecked at once. Repeated checks of a dead share would otherwise
 *   fill libuv's thread pool and stall the whole server's file reads;
 * - plain async fs only, so the panel's Node (17.7.2) keeps answering.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------- parsing and grouping ----------

export interface ParsedFrame {
  prefix: string;
  digits: string;
  suffix: string;
}

const FRAME_RE = /^(.*?)(\d+)(\.[^./\\]+)$/;
const MAX_DIGITS = 15;

/** The frame number in a file name, or null when the name is not a frame. Digits longer than 15 are not frames (stays exact below 2^53). */
export function parseFrameName(name: string): ParsedFrame | null {
  const m = FRAME_RE.exec(name);
  if (!m) return null;
  if (m[2].length > MAX_DIGITS) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3] };
}

const isPaddedDigits = (digits: string): boolean => digits.length > 1 && digits.charAt(0) === "0";

export interface SeqGroup {
  /** dir-free key: prefix + suffix + width ("*" when unpadded), normalised and case-folded when the compare is. */
  key: string;
  prefix: string;
  suffix: string;
  digits: number;
  padded: boolean;
  /** "prefix[####]suffix"; "[#]" when unpadded. */
  pattern: string;
  /** Sorted, distinct frame numbers. */
  numbers: number[];
  first: number;
  last: number;
  on_disk: number;
  missing: number;
  missing_ranges: Array<[number, number]>;
  ranges_truncated: boolean;
}

export interface GroupOptions {
  caseInsensitive?: boolean;
  maxRanges?: number;
}

export const DEFAULT_MAX_RANGES = 20;

/** Where the gaps are in a sorted list of distinct numbers. `missing` is exact even when the ranges are cut at `maxRanges`. */
export function missingRanges(sorted: number[], maxRanges: number): { missing: number; ranges: Array<[number, number]>; truncated: boolean } {
  const ranges: Array<[number, number]> = [];
  let missing = 0;
  let truncated = false;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1] - 1;
    if (gap <= 0) continue;
    missing += gap;
    if (ranges.length < maxRanges) ranges.push([sorted[i - 1] + 1, sorted[i] - 1]);
    else truncated = true;
  }
  return { missing, ranges, truncated };
}

/** "0120, 0300-0312, ..." padded to `digits` (0: unpadded), cut at `maxChars` with a trailing "...". */
export function formatRanges(ranges: Array<[number, number]>, digits: number, maxChars: number): string {
  const pad = (n: number) => (digits > 0 ? String(n).padStart(digits, "0") : String(n));
  let out = "";
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    const part = a === b ? pad(a) : `${pad(a)}-${pad(b)}`;
    const next = out === "" ? part : `${out}, ${part}`;
    if (next.length > maxChars) return out === "" ? `${part.slice(0, Math.max(0, maxChars - 3))}...` : `${out}, ...`;
    out = next;
  }
  return out;
}

/** Unicode-normalised (macOS lists names decomposed, After Effects paths are composed) and, when asked, lower case. */
const fold = (s: string, ci: boolean) => {
  const n = s.normalize("NFC");
  return ci ? n.toLowerCase() : n;
};

function patternOf(prefix: string, suffix: string, digits: number, padded: boolean): string {
  return `${prefix}[${padded ? "#".repeat(digits) : "#"}]${suffix}`;
}

/** The padded widths of one name stem that really are padding, and the width a number joins. */
function paddedWidthsOf(leadingZeroWidths: Set<number>, shortestPlain: number): number[] {
  // A width is padding unless a shorter number WITHOUT a leading zero exists (frame1 beside frame01).
  return [...leadingZeroWidths].filter((w) => shortestPlain >= w).sort((a, b) => a - b);
}

/** The group width for one number: its own padded width, the largest padded width it overflows, or null (unpadded). */
function widthFor(digits: string, padded: number[]): number | null {
  if (isPaddedDigits(digits)) return padded.includes(digits.length) ? digits.length : null;
  let best: number | null = null;
  for (const w of padded) if (w <= digits.length) best = w;
  return best;
}

/** Groups file names into sequences. Pure, O(n log n). Names that are not frames are ignored. */
export function groupFrames(names: string[], opts: GroupOptions = {}): SeqGroup[] {
  const ci = opts.caseInsensitive === true;
  const maxRanges = opts.maxRanges ?? DEFAULT_MAX_RANGES;
  const parsed: Array<{ p: ParsedFrame; stem: string }> = [];
  const zeroWidths = new Map<string, Set<number>>();
  const shortestPlain = new Map<string, number>();
  for (const name of names) {
    const p = parseFrameName(name);
    if (!p) continue;
    const stem = fold(p.prefix, ci) + "\u0000" + fold(p.suffix, ci);
    parsed.push({ p, stem });
    if (isPaddedDigits(p.digits)) {
      let set = zeroWidths.get(stem);
      if (!set) zeroWidths.set(stem, (set = new Set()));
      set.add(p.digits.length);
    } else {
      const cur = shortestPlain.get(stem);
      if (cur === undefined || p.digits.length < cur) shortestPlain.set(stem, p.digits.length);
    }
  }
  const paddedByStem = new Map<string, number[]>();
  for (const [stem, widths] of zeroWidths) paddedByStem.set(stem, paddedWidthsOf(widths, shortestPlain.get(stem) ?? Infinity));
  interface Acc { prefix: string; suffix: string; digits: number; padded: boolean; nums: number[] }
  const groups = new Map<string, Acc>();
  for (const { p, stem } of parsed) {
    const w = widthFor(p.digits, paddedByStem.get(stem) ?? []);
    const padded = w !== null;
    const key = `${stem}\u0000${padded ? w : "*"}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { prefix: p.prefix, suffix: p.suffix, digits: padded ? (w as number) : p.digits.length, padded, nums: [] }));
    g.nums.push(Number(p.digits));
    if (!padded && p.digits.length < g.digits) g.digits = p.digits.length;
  }
  const out: SeqGroup[] = [];
  for (const [key, g] of groups) {
    g.nums.sort((a, b) => a - b);
    const numbers: number[] = [];
    for (const n of g.nums) if (numbers.length === 0 || numbers[numbers.length - 1] !== n) numbers.push(n);
    const gaps = missingRanges(numbers, maxRanges);
    out.push({
      key,
      prefix: g.prefix,
      suffix: g.suffix,
      digits: g.digits,
      padded: g.padded,
      pattern: patternOf(g.prefix, g.suffix, g.digits, g.padded),
      numbers,
      first: numbers[0],
      last: numbers[numbers.length - 1],
      on_disk: numbers.length,
      missing: gaps.missing,
      missing_ranges: gaps.ranges,
      ranges_truncated: gaps.truncated,
    });
  }
  out.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return out;
}

/** The group a file name belongs to, or null. */
export function findGroup(groups: SeqGroup[], fileName: string, opts: GroupOptions = {}): SeqGroup | null {
  const ci = opts.caseInsensitive === true;
  const p = parseFrameName(fileName);
  if (!p) return null;
  const prefix = fold(p.prefix, ci);
  const suffix = fold(p.suffix, ci);
  const same = groups.filter((g) => fold(g.prefix, ci) === prefix && fold(g.suffix, ci) === suffix);
  const padded = same.filter((g) => g.padded).map((g) => g.digits);
  const w = widthFor(p.digits, padded);
  if (w !== null) return same.find((g) => g.padded && g.digits === w) ?? null;
  return same.find((g) => !g.padded) ?? null;
}

/** The file name of frame `n` in a group. */
export function frameName(g: Pick<SeqGroup, "prefix" | "suffix" | "digits" | "padded">, n: number): string {
  return g.prefix + (g.padded ? String(n).padStart(g.digits, "0") : String(n)) + g.suffix;
}

// ---------- checking folders ----------

export interface SeqInput {
  /** The path After Effects reports for the footage (normally its first frame). */
  file: string;
  item_id?: number;
  name?: string;
  /** After Effects' own frame count (duration * frame rate), a guess at what it built the item from. */
  ae_frames?: number;
}

export interface SeqStat {
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface SeqListing {
  names: string[];
  /** More than `limit` names: the listing was cut. */
  truncated: boolean;
}

export interface SeqIo {
  /** At most `limit` names; `truncated` when there were more. */
  readdir(dir: string, limit: number): Promise<SeqListing>;
  stat(file: string): Promise<SeqStat>;
  now(): number;
}

export interface SeqOptions {
  /** Time budget for every listing and stat together. Default 4000. */
  budgetMs?: number;
  /** A newest frame younger than this many seconds means the sequence is still being written. Default 30. */
  settleS?: number;
  maxRanges?: number;
  /** Most names read from one directory. Default 200000. */
  maxEntries?: number;
  /** Directories read at once. Default 2. */
  concurrency?: number;
  /** Folders a known render writes into (running aerender jobs). */
  liveDirs?: string[];
  caseInsensitive?: boolean;
}

export type SeqState = "complete" | "gaps" | "sparse" | "short" | "unknown" | "writing" | "single_frame" | "unreadable";

export interface SeqRow {
  pattern: string;
  dir: string;
  item_ids: number[];
  item_names: string[];
  first?: number;
  last?: number;
  on_disk?: number;
  missing: number;
  missing_ranges: Array<[number, number]>;
  ranges_truncated: boolean;
  /** At most 400 characters. */
  missing_text: string;
  /**
   * gaps: frames missing, not being written. sparse: numbering gaps but After Effects counts about the files on disk
   * (every-nth-frame sequence, alphabetical import): a note. short: the folder holds fewer frames than After Effects
   * counts (a guess). unknown: not known whether it is still being written (time budget). writing: still being written.
   */
  state: SeqState;
  newest_age_s: number | null;
  /** Still being written (the gaps, if any, may fill in). */
  writing: boolean;
  writing_reason?: string;
  ae_frames?: number;
  ae_range_differs?: boolean;
  hint?: string;
  dir_hint?: string;
  /** state unreadable: why. */
  reason?: string;
}

export interface SeqReport {
  /** Sequences looked at (rows with a folder listing). */
  checked: number;
  /** In state gaps (not being written). */
  with_gaps: number;
  writing: number;
  unreadable: number;
  sparse: number;
  short: number;
  /** Gaps found, but the time ran out before the frame times could be read. */
  unknown_age: number;
  /** Anything not looked at or only partly looked at: time budget, too many entries, unreadable folder, a name that could not be matched. */
  incomplete: boolean;
  /** The hung-fs gate was shut during this check: file checks are paused until the stuck calls settle or the panel restarts. */
  fs_paused?: boolean;
  /** At most 100, the most missing frames first. */
  sequences: SeqRow[];
  sequences_total: number;
  /** Inputs not looked at (first 10 named). */
  unchecked: string[];
  unchecked_count: number;
  truncated: boolean;
  notes: string[];
  elapsed_ms: number;
}

export const MAX_ROWS = 100;
export const MAX_TEXT_CHARS = 400;
export const STAT_SAMPLE_HIGH = 8;
/** File times this far ahead of the clock are clock skew and count as "just now"; further ahead they are ignored. */
export const CLOCK_SKEW_S = 5;
const MAX_ITEMS_PER_ROW = 10;
const MAX_UNCHECKED_NAMED = 10;

const CLOUD_SEGMENT = /^(dropbox|onedrive|icloud|google ?drive)\b/i;

/** A heuristic on the path: gaps in a synced folder can be files that have not synced yet. */
export function cloudHint(dir: string): string | undefined {
  for (const seg of dir.split(/[\\/]+/)) if (CLOUD_SEGMENT.test(seg)) return "cloud-synced folder: gaps may be unsynced files";
  return undefined;
}

const normDir = (d: string, ci: boolean) => fold(path.resolve(d).replace(/[\\/]+$/, ""), ci);

interface RowAcc {
  group: SeqGroup | null;
  dir: string;
  ids: Set<number>;
  names: string[];
  aeFrames?: number;
  firstInputFile: string;
}

function emptyRow(over: Partial<SeqRow> & { pattern: string; dir: string; state: SeqState }): SeqRow {
  return { item_ids: [], item_names: [], missing: 0, missing_ranges: [], ranges_truncated: false, missing_text: "", newest_age_s: null, writing: false, ...over };
}

type Raced<T> = { done: true; value: T } | { done: false };

/** fs calls that were given up on (budget spent) and have not settled yet. Node cannot cancel them, so they hold a thread-pool thread. */
let hungFsCalls = 0;
/** At this many stuck fs calls, no further fs call is started. */
export const HUNG_FS_LIMIT = 2;
/** What a report says when the gate is shut: the checks were not tried, and why. */
export const FS_PAUSED_NOTE =
  "File checks are paused: earlier ones never returned, most likely a network share that is not answering. Restarting the panel (or After Effects) clears it; until then sequences are not checked.";

/** For tests and diagnostics. */
export function hungFsCallCount(): number {
  return hungFsCalls;
}
/** For tests: forget the count. */
export function resetHungFsCalls(): void {
  hungFsCalls = 0;
}

/** The result of `fn()` if it comes back within `ms`; otherwise "not done". The call itself is not cancelled. */
function within<T>(fn: () => Promise<T>, ms: number): Promise<Raced<T>> {
  // Too many calls already stuck: start nothing (the caller counts the input as unchecked).
  if (hungFsCalls >= HUNG_FS_LIMIT) return Promise.resolve({ done: false });
  return new Promise<Raced<T>>((resolve, reject) => {
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      reject(err);
      return;
    }
    let abandoned = false;
    const settled = (): void => {
      if (abandoned) hungFsCalls = Math.max(0, hungFsCalls - 1);
      abandoned = false;
    };
    if (ms <= 0) {
      abandoned = true;
      hungFsCalls++;
      p.then(settled, settled);
      resolve({ done: false });
      return;
    }
    const timer = setTimeout(() => {
      abandoned = true;
      hungFsCalls++;
      resolve({ done: false });
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        settled();
        resolve({ done: true, value });
      },
      (err) => {
        clearTimeout(timer);
        settled();
        reject(err);
      }
    );
  });
}

/**
 * Checks the sequences behind the given footage. Never throws: a folder that
 * cannot be read is a row with state "unreadable", a budget that runs out
 * leaves inputs "unchecked".
 */
export async function checkSequences(inputs: SeqInput[], io: SeqIo, opts: SeqOptions = {}): Promise<SeqReport> {
  const started = io.now();
  const budget = opts.budgetMs ?? 4000;
  const settleS = opts.settleS ?? 30;
  const maxRanges = Math.max(1, opts.maxRanges ?? DEFAULT_MAX_RANGES);
  const maxEntries = opts.maxEntries ?? 200_000;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const ci = opts.caseInsensitive ?? (process.platform === "win32" || process.platform === "darwin");
  const liveDirs = new Set((opts.liveDirs ?? []).map((d) => normDir(d, ci)));
  const remaining = () => budget - (io.now() - started);

  const rows: SeqRow[] = [];
  const unchecked: string[] = [];
  let uncheckedCount = 0;
  let futureIgnored = 0;
  let unmatchedNames = 0;
  const notes: string[] = [];

  const skip = (label: string) => {
    uncheckedCount++;
    if (unchecked.length < MAX_UNCHECKED_NAMED) unchecked.push(label);
  };

  // Inputs by directory. A name with text after the number cannot be matched: it is unchecked, never "complete".
  const byDir = new Map<string, SeqInput[]>();
  for (const inp of inputs) {
    if (!inp.file) continue;
    if (!parseFrameName(path.basename(inp.file))) {
      unmatchedNames++;
      skip(inp.name ?? path.basename(inp.file));
      continue;
    }
    const dir = path.dirname(inp.file);
    const list = byDir.get(dir);
    if (list) list.push(inp);
    else byDir.set(dir, [inp]);
  }

  async function doDir(dir: string, list: SeqInput[]): Promise<void> {
    const skipAll = () => {
      for (const i of list) skip(i.name ?? i.file);
    };
    if (remaining() <= 0) return skipAll();
    let names: string[];
    try {
      const listed = await within(() => io.readdir(dir, maxEntries), remaining());
      if (!listed.done) return skipAll();
      if (listed.value.truncated) {
        const reason = `too many entries (more than ${maxEntries})`;
        rows.push(...rowsForInputs(list, (inp) => emptyRow({ pattern: path.basename(inp.file), dir, state: "unreadable", reason })));
        return;
      }
      names = listed.value.names;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const reason = code === "ENOENT" || code === "ENOTDIR" ? "folder not found" : `cannot list the folder (${err instanceof Error ? err.message : String(err)})`.slice(0, 300);
      rows.push(...rowsForInputs(list, (inp) => emptyRow({ pattern: path.basename(inp.file), dir, state: "unreadable", reason })));
      return;
    }
    const groups = groupFrames(names, { caseInsensitive: ci, maxRanges });
    const accs = new Map<string, RowAcc>();
    for (const inp of list) {
      const g = findGroup(groups, path.basename(inp.file), { caseInsensitive: ci });
      const key = g ? g.key : `?${path.basename(inp.file)}`;
      let a = accs.get(key);
      if (!a) accs.set(key, (a = { group: g, dir, ids: new Set(), names: [], firstInputFile: inp.file }));
      if (typeof inp.item_id === "number") a.ids.add(inp.item_id);
      if (inp.name && a.names.length < MAX_ITEMS_PER_ROW && !a.names.includes(inp.name)) a.names.push(inp.name);
      if (a.aeFrames === undefined && typeof inp.ae_frames === "number") a.aeFrames = inp.ae_frames;
    }
    const cloud = cloudHint(dir);
    const dirLive = liveDirs.has(normDir(dir, ci));
    for (const a of accs.values()) {
      const g = a.group;
      if (!g) {
        // The file AE points at is not in the listing (renamed or moved since).
        rows.push(emptyRow({ pattern: path.basename(a.firstInputFile), dir, state: "unreadable", reason: "the footage's own file is not in the folder listing", item_ids: [...a.ids].slice(0, MAX_ITEMS_PER_ROW), item_names: a.names }));
        continue;
      }
      // One frame matched but After Effects counts a sequence: the name was probably not understood (shot_0001_v2.exr).
      if (g.on_disk === 1 && a.aeFrames !== undefined && a.aeFrames > 1) {
        unmatchedNames++;
        skip(a.names[0] ?? path.basename(a.firstInputFile));
        continue;
      }
      // Newest frame time, from at most STAT_SAMPLE_HIGH + 1 stats, each raced against the budget left.
      const sample = g.numbers.slice(-STAT_SAMPLE_HIGH);
      if (g.missing > 0) {
        const firstGapAbove = g.numbers.find((n, i) => i > 0 && n - g.numbers[i - 1] > 1);
        if (firstGapAbove !== undefined && !sample.includes(firstGapAbove)) sample.push(firstGapAbove);
      }
      let newest: number | null = null;
      let statAbandoned = false;
      for (const n of sample) {
        if (remaining() <= 0) break;
        try {
          const r = await within(() => io.stat(path.join(dir, frameName(g, n))), remaining());
          if (!r.done) {
            statAbandoned = true;
            break;
          }
          const s = r.value;
          const t = Math.max(s.mtimeMs, s.ctimeMs, s.birthtimeMs);
          if (!Number.isFinite(t)) continue;
          if ((t - io.now()) / 1000 > CLOCK_SKEW_S) {
            futureIgnored++;
            continue;
          }
          if (newest === null || t > newest) newest = t;
        } catch {
          // a frame removed meanwhile gives no time
        }
      }
      const ageKnown = newest !== null;
      const ageS = newest === null ? null : Math.max(0, Math.round(((io.now() - newest) / 1000) * 10) / 10);
      let writing = false;
      let writingReason: string | undefined;
      if (ageS !== null && ageS < settleS) {
        writing = true;
        writingReason = `the newest frame is ${ageS} s old (under ${settleS} s)`;
      } else if (dirLive) {
        writing = true;
        writingReason = "a render started by this server writes into this folder";
      }
      const span = g.last - g.first + 1;
      const aeShort = a.aeFrames !== undefined && a.aeFrames - span > 1;
      let state: SeqState;
      if (writing) state = "writing";
      else if ((g.missing > 0 || aeShort || statAbandoned) && !ageKnown) state = "unknown";
      else if (g.missing > 0) state = a.aeFrames !== undefined && g.missing > 1 && Math.abs(a.aeFrames - g.on_disk) <= 1 && a.aeFrames < span - 1 ? "sparse" : "gaps";
      else if (aeShort) state = "short";
      else if (g.on_disk === 1) state = "single_frame";
      else state = "complete";
      const row: SeqRow = {
        pattern: g.pattern,
        dir,
        item_ids: [...a.ids].slice(0, MAX_ITEMS_PER_ROW),
        item_names: a.names,
        first: g.first,
        last: g.last,
        on_disk: g.on_disk,
        missing: g.missing,
        missing_ranges: g.missing_ranges,
        ranges_truncated: g.ranges_truncated,
        missing_text: formatRanges(g.missing_ranges, g.padded ? g.digits : 0, MAX_TEXT_CHARS),
        state,
        newest_age_s: ageS,
        writing,
        ...(writingReason ? { writing_reason: writingReason } : {}),
        ...(cloud ? { dir_hint: cloud } : {}),
      };
      if (a.aeFrames !== undefined) {
        row.ae_frames = a.aeFrames;
        if (Math.abs(a.aeFrames - span) > 1) {
          row.ae_range_differs = true;
          row.hint =
            a.aeFrames > span
              ? `After Effects counts about ${a.aeFrames} frames but the folder holds ${g.first}-${g.last}: trailing or leading frames may be missing, or the footage was built from an earlier file list (a guess from AE's duration, not measured)`
              : `After Effects counts about ${a.aeFrames} frames and the folder holds ${g.first}-${g.last}: the footage may have been built from an earlier file list (reload with ae_replace_footage; a guess, not measured)`;
        }
      }
      rows.push(row);
    }
  }

  // A small worker pool over the directories.
  const queue = [...byDir.entries()];
  let next = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= queue.length) return;
          try {
            await doDir(queue[i][0], queue[i][1]);
          } catch (err) {
            // a bug must not lose the other folders
            rows.push(emptyRow({ pattern: queue[i][0], dir: queue[i][0], state: "unreadable", reason: err instanceof Error ? err.message.slice(0, 300) : "unexpected error" }));
          }
        }
      })()
    );
  }
  await Promise.all(workers);

  rows.sort((a, b) => b.missing - a.missing || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  const shown = rows.slice(0, MAX_ROWS);
  const count = (s: SeqState) => rows.filter((r) => r.state === s).length;
  const unreadable = count("unreadable");
  const unknownAge = count("unknown");
  const fsPaused = hungFsCalls >= HUNG_FS_LIMIT;
  if (fsPaused) notes.unshift(FS_PAUSED_NOTE);
  const incomplete = uncheckedCount > 0 || unreadable > 0 || unknownAge > 0;
  if (uncheckedCount > 0) notes.push(`${uncheckedCount} footage item${uncheckedCount === 1 ? " was" : "s were"} not checked (time budget, or a file name that could not be matched).`);
  if (unmatchedNames > 0) notes.push(`${unmatchedNames} file name${unmatchedNames === 1 ? " has" : "s have"} text after the frame number or no other frame next to ${unmatchedNames === 1 ? "it" : "them"}, so the sequence could not be matched; they were not called complete.`);
  if (unknownAge > 0) notes.push(`${unknownAge} sequence${unknownAge === 1 ? "" : "s"} with gaps could not be checked for "still being written" (time budget): not known whether the gaps will fill in.`);
  if (futureIgnored > 0) notes.push(`${futureIgnored} file time${futureIgnored === 1 ? " is" : "s are"} in the future (clock skew) and was ignored.`);
  notes.push("Only gaps between the first and last frame on disk are found; a sequence that starts late or ends early looks complete unless After Effects' frame count says otherwise (a guess).");
  notes.push(`A render this server did not start (another app, a farm) is only recognised by a newest frame under ${settleS} s old; frames that take longer than that to render look finished.`);
  return {
    checked: rows.length - unreadable,
    with_gaps: count("gaps"),
    writing: count("writing"),
    unreadable,
    sparse: count("sparse"),
    short: count("short"),
    unknown_age: unknownAge,
    incomplete: incomplete || fsPaused,
    ...(fsPaused ? { fs_paused: true } : {}),
    sequences: shown,
    sequences_total: rows.length,
    unchecked,
    unchecked_count: uncheckedCount,
    truncated: rows.length > shown.length,
    notes,
    elapsed_ms: io.now() - started,
  };
}

function rowsForInputs(list: SeqInput[], make: (inp: SeqInput) => SeqRow): SeqRow[] {
  // One row per distinct file name in the directory, items merged.
  const byName = new Map<string, SeqRow>();
  for (const inp of list) {
    const key = path.basename(inp.file);
    let r = byName.get(key);
    if (!r) byName.set(key, (r = make(inp)));
    if (typeof inp.item_id === "number" && r.item_ids.length < MAX_ITEMS_PER_ROW && !r.item_ids.includes(inp.item_id)) r.item_ids.push(inp.item_id);
    if (inp.name && r.item_names.length < MAX_ITEMS_PER_ROW && !r.item_names.includes(inp.name)) r.item_names.push(inp.name);
  }
  return [...byName.values()];
}

// ---------- the real file system ----------

export const nodeSeqIo: SeqIo = {
  /** opendir with an early stop, so a folder with millions of names is not listed whole. */
  readdir: async (dir, limit) => {
    const d = await fs.promises.opendir(dir);
    const names: string[] = [];
    let truncated = false;
    try {
      for await (const ent of d) {
        if (names.length >= limit) {
          truncated = true;
          break;
        }
        if (!ent.isDirectory()) names.push(ent.name);
      }
    } finally {
      await d.close().catch(() => undefined);
    }
    return { names, truncated };
  },
  stat: async (file) => {
    const s = await fs.promises.stat(file);
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs };
  },
  now: () => Date.now(),
};

/** Seams: the file system every sequence check reads, and the folders known renders write into (set by aerender.ts). */
export const seqscanDeps: { io: SeqIo; liveDirs: () => string[] } = { io: nodeSeqIo, liveDirs: () => [] };
