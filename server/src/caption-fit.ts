/**
 * server/src/caption-fit.ts
 *
 * Fitting captions that were measured wider than the safe area (ae_captions `fit`).
 * Node can't measure glyphs, so ae_captions writes the planner's lines, reads the
 * extents back in a separate evalScript, and this works out what to change:
 * first break the caption into more lines (the planner's grammar-aware breaker,
 * with a characters-per-line derived from the measured pixels per character),
 * then scale the caption's font size down, never below a floor.
 * Pure: nothing here touches After Effects.
 */

import { breakLines } from "./transcript.js";

/** Font sizes are never scaled below this share of the base size. */
export const FIT_MIN_SCALE = 0.7;

/**
 * Captions are placed by baseline, so descenders (commas, g, p, y) may hang below the safe bottom by design. The host's
 * outside_safe flag (rectInfo and wordsEntry in captions.jsx) allows this share of the font size below the safe bottom;
 * the fit judges the same way: width against the safe width only, never the descenders.
 */
export const DESCENDER_SHARE = 0.3;

export type FitMode = "rebreak" | "shrink" | "none" | undefined;

/** One measured caption (a layer in layers mode, one key in single mode). */
export interface FitCandidate {
  /** Caption number (layers mode) or 1-based key index (single mode). */
  index: number;
  name: string;
  /** The widest line's ink width in px, as After Effects measured it. */
  width: number;
  font_size: number;
  lines: string[];
}

export interface FitArea {
  /** Comp width in px. */
  comp_width: number;
  /** Safe margins in px. */
  left: number;
  right: number;
  /** Safe width in px. */
  width: number;
  justification: "left" | "center" | "right";
  /** Pixels a background box reaches past the text on each side. */
  box_padding?: number;
}

/** The width the text itself may take: centred text must stay inside the narrower of the two margins. */
export function availableWidth(a: FitArea): number {
  const pad = (a.box_padding ?? 0) * 2;
  if (a.justification === "center") return a.comp_width - 2 * Math.max(a.left, a.right) - pad;
  return a.width - pad;
}

/** Why a caption the host flagged outside_safe is outside, by the same criterion the fit uses. */
export function outsideReason(c: Pick<FitCandidate, "width">, area: FitArea): "too_wide" | "position" {
  return c.width > availableWidth(area) + 0.5 ? "too_wide" : "position";
}

/** True when the measured text (and its box) is wider than the space it has. */
export function isTooWide(c: FitCandidate, area: FitArea): boolean {
  return c.width > availableWidth(area) + 0.5;
}

/**
 * The lines a too-wide caption would be set in: broken for the characters per line the measured
 * pixels per character allow. Null when that cannot work: no change, more lines than allowed,
 * or a word that alone is wider than the space.
 */
export function rebreakLines(c: FitCandidate, area: FitArea, maxLines: number): string[] | null {
  const avail = availableWidth(area);
  const longest = Math.max(...c.lines.map((l) => l.length), 1);
  const pxPerChar = c.width / longest;
  if (!(pxPerChar > 0) || !(avail > 0)) return null;
  // A little under the estimate: a shorter line of the same text can measure wider per character.
  const cpl = Math.floor((avail / pxPerChar) * 0.97);
  const words = c.lines.join(" ").split(/\s+/).filter(Boolean);
  if (cpl < 4 || words.some((w) => w.length > cpl)) return null;
  const lines = breakLines(words, cpl);
  if (lines.length > maxLines || lines.some((l) => l.length > cpl)) return null;
  if (lines.length === c.lines.length && lines.every((l, i) => l === c.lines[i])) return null;
  return lines;
}

/** The font size that makes a too-wide caption fit, kept at or above the floor (then `fits` is false when it still would not). */
export function shrinkSize(c: FitCandidate, area: FitArea, baseSize: number): { font_size: number; fits: boolean } | null {
  const avail = availableWidth(area);
  if (!(c.width > 0) || !(avail > 0)) return null;
  const want = Math.floor(c.font_size * (avail / c.width) * 0.995);
  const floor = Math.max(1, Math.ceil(baseSize * FIT_MIN_SCALE));
  if (want >= c.font_size) return null;
  if (want >= floor) return { font_size: want, fits: true };
  if (floor >= c.font_size) return null;
  return { font_size: floor, fits: (c.width * floor) / c.font_size <= avail + 0.5 };
}

export interface RefitEntry {
  name: string;
  action: "rebreak" | "shrink";
  from: unknown;
  to: unknown;
}
