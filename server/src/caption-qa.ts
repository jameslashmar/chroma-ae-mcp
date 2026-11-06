// QA rule set after github/awesome-copilot skills/caption-qa (MIT); reimplemented in TypeScript against our own standards table.
/**
 * server/src/caption-qa.ts
 *
 * Lints a list of captions against a caption standard (caption-standards.ts):
 * reading speed, line length, line count, time on screen, gaps, overlaps,
 * grammar of the breaks, shot changes and (for caption layers) the safe area.
 * Pure: the tools turn files, plans and layers into QaCue lists first.
 */
import { bareWord, CAPTION_STANDARDS, weakEndReason, type CaptionStandardId } from "./caption-standards.js";

export interface QaCue {
  /** 1-based number as the caption is known to the user. */
  n: number;
  start: number;
  end: number;
  /** Displayed text lines, markup already removed. */
  lines: string[];
  outside_safe?: boolean;
  first_outside_safe?: number;
}

export type QaRule =
  | "cps"
  | "wpm"
  | "min_s_per_word"
  | "cpl"
  | "lines"
  | "min_duration"
  | "max_duration"
  | "gap"
  | "overlap"
  | "grammar"
  | "shot_change"
  | "safe_zone"
  | "empty"
  | "bad_timing";

export interface QaIssue {
  n: number;
  rule: QaRule;
  severity: "error" | "warning";
  start: number;
  end: number;
  detail: string;
}

export interface QaOptions {
  standard?: CaptionStandardId;
  frame_rate: number;
  cut_times?: number[];
  max_issues?: number;
  /** Frames a gap may fall short of the minimum before it is an error. Default 0.05; wider when the frame rate is only a guess. */
  gap_tolerance_frames?: number;
}

export interface QaReport {
  standard: CaptionStandardId;
  label: string;
  frame_rate: number;
  cues: number;
  pass: boolean;
  counts: Record<string, number>;
  issues: QaIssue[];
  truncated: boolean;
}

const MS = 0.001;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const wordsIn = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** The frame rates a cue file is likely to have been timed at, lowest first. */
export const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/**
 * The lowest common frame rate whose frame boundaries every given time sits on (within 1 ms), or null when none
 * fits (times typed by hand, or off a grid). Needs at least one time that is not 0.
 */
export function inferFrameRate(times: number[]): number | null {
  const ts = times.filter((t) => Number.isFinite(t) && t > 0);
  if (!ts.length) return null;
  for (const fps of COMMON_FRAME_RATES) {
    if (ts.every((t) => Math.abs(t * fps - Math.round(t * fps)) / fps <= 0.001 + 1e-9)) return fps;
  }
  return null;
}

export function lintCaptions(cues: QaCue[], opts: QaOptions): QaReport {
  const std = CAPTION_STANDARDS[opts.standard ?? "netflix_adult"];
  const fps = opts.frame_rate > 0 ? opts.frame_rate : 24;
  const frame = 1 / fps;
  const gapTol = opts.gap_tolerance_frames ?? 0.05;
  const cuts = [...(opts.cut_times ?? [])].sort((a, b) => a - b);
  const all: QaIssue[] = [];
  const add = (c: QaCue, rule: QaRule, severity: "error" | "warning", detail: string) =>
    all.push({ n: c.n, rule, severity, start: r3(c.start), end: r3(c.end), detail });

  cues.forEach((c, i) => {
    const next = cues[i + 1];
    const lines = c.lines.filter((l) => l.trim().length > 0);
    const text = lines.join(" ");
    const dur = c.end - c.start;

    if (!(c.end > c.start)) add(c, "bad_timing", "error", `Ends at ${r3(c.end)} s, not after its start ${r3(c.start)} s.`);
    if (!text.trim()) add(c, "empty", "error", "No text.");

    if (dur > 0 && text.trim()) {
      const chars = text.length;
      const words = wordsIn(text).length;
      if (std.max_cps !== undefined) {
        const cps = chars / dur;
        if (cps > std.max_cps + 0.05) add(c, "cps", "error", `${r2(cps)} characters a second (limit ${std.max_cps}).`);
      }
      if (std.max_wpm !== undefined) {
        const wpm = (words * 60) / dur;
        if (wpm > std.max_wpm + 0.5) add(c, "wpm", "error", `${Math.round(wpm)} words a minute (limit ${std.max_wpm}).`);
      }
      if (std.min_s_per_word !== undefined && words > 0 && dur / words < std.min_s_per_word - MS) {
        add(c, "min_s_per_word", "warning", `${r2(dur / words)} s a word (guidance at least ${std.min_s_per_word}).`);
      }
      if (dur + MS < std.min_duration_s) add(c, "min_duration", "error", `On screen ${r2(dur)} s (at least ${r2(std.min_duration_s)} s).`);
      if (dur - MS > std.max_duration_s) add(c, "max_duration", "error", `On screen ${r2(dur)} s (at most ${std.max_duration_s} s).`);
    }

    lines.forEach((l, li) => {
      if (l.length > std.max_cpl) add(c, "cpl", "error", `Line ${li + 1} is ${l.length} characters (limit ${std.max_cpl}).`);
    });
    if (lines.length > std.max_lines) add(c, "lines", "error", `${lines.length} lines (limit ${std.max_lines}).`);

    // Grammar: a line break, or the caption's end, that splits a phrase.
    for (let li = 0; li + 1 < lines.length; li++) {
      const lw = lines[li].split(/\s+/).filter(Boolean);
      const nw = lines[li + 1].split(/\s+/).filter(Boolean);
      if (!lw.length || !nw.length) continue;
      const why = weakEndReason(lw[lw.length - 1], nw[0]);
      if (why) add(c, "grammar", "warning", `Line ${li + 1} ${why} ("${bareWord(lw[lw.length - 1])}").`);
    }
    if (next && lines.length) {
      const lw = lines[lines.length - 1].split(/\s+/).filter(Boolean);
      const nextLine = next.lines.find((l) => l.trim().length > 0);
      const nw = nextLine ? nextLine.split(/\s+/).filter(Boolean) : [];
      // After a long silence the next caption starts a fresh thought, so a pause that long is not a split.
      if (lw.length && nw.length && next.start - c.end <= 1.5) {
        const why = weakEndReason(lw[lw.length - 1], nw[0]);
        if (why) add(c, "grammar", "warning", `The caption ${why} ("${bareWord(lw[lw.length - 1])}") and the next one carries on.`);
      }
    }

    // Gap and overlap to the next caption.
    if (next) {
      const gap = next.start - c.end;
      if (gap < -1e-6) {
        add(c, "overlap", "error", `Overlaps caption ${next.n} by ${r3(-gap)} s.`);
      } else {
        const frames = gap * fps;
        if (frames < std.min_gap_frames - gapTol) {
          add(c, "gap", "error", `${r2(frames)} frames before caption ${next.n} (at least ${std.min_gap_frames} at ${r2(fps)} fps).`);
        } else if (gap < std.close_gap_under_s - MS && frames > std.min_gap_frames + 0.05 && !cuts.some((x) => x > c.end - frame / 2 && x < next.start + frame / 2)) {
          add(c, "gap", "warning", `${r3(gap)} s before caption ${next.n}; a gap this short should close to ${std.min_gap_frames} frames.`);
        }
      }
    }

    // Shot changes (one finding per caption).
    if (c.end > c.start) {
      const tol = frame / 2;
      const minGap = std.min_gap_frames * frame;
      for (const cut of cuts) {
        if (c.start < cut - tol && c.end > cut + tol) {
          add(c, "shot_change", "warning", `Straddles the cut at ${r3(cut)} s.`);
          break;
        }
        // A caption that ends 2 frames before the cut never shows across it, so a close in-time is fine.
        if (c.start < cut - tol && c.start > cut - std.cut_zone_s + tol && c.end > cut - minGap + tol) {
          add(c, "shot_change", "warning", `In-time is ${r2(cut - c.start)} s before the cut at ${r3(cut)} s; put it on the cut or at least ${std.cut_zone_s} s before.`);
          break;
        }
        if (c.start < cut - tol && c.end > cut - minGap + tol && c.end <= cut + tol) {
          add(c, "shot_change", "warning", `Out-time is ${r2(cut - c.end)} s before the cut at ${r3(cut)} s; end it ${std.min_gap_frames} frames before the cut.`);
          break;
        }
      }
    }

    if (c.outside_safe || c.first_outside_safe !== undefined) {
      add(c, "safe_zone", "error", c.first_outside_safe !== undefined ? `Text runs outside the safe area (first at ${r3(c.first_outside_safe)} s).` : "Text runs outside the safe area.");
    }
  });

  const counts: Record<string, number> = {};
  for (const i of all) counts[i.rule] = (counts[i.rule] ?? 0) + 1;
  const max = Math.min(Math.max(opts.max_issues ?? 200, 1), 500);
  return {
    standard: std.id,
    label: std.label,
    frame_rate: fps,
    cues: cues.length,
    pass: !all.some((i) => i.severity === "error"),
    counts,
    issues: all.slice(0, max),
    truncated: all.length > max,
  };
}
