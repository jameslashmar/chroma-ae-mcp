/**
 * server/src/caption-rules.ts
 *
 * The timing passes buildCaptions (transcript.ts) runs on a caption list: hold and
 * extend out-times, fix a standard's violations (extend, then merge, then split),
 * close gaps, keep a minimum gap, and keep captions off shot changes. Pure: nothing
 * here touches AE. Every change is recorded so the plan can list what moved and why.
 *
 * Times are comp-time seconds. Frame-based rules use `frame` (1/fps); the caller
 * has already settled on a frame rate (the comp's, or an assumed 24).
 */
import type { PlanChange, PlanViolation } from "./caption-plan-options.js";
import { breakPenalty, cpsOf, isWeakEnd, wpmOf, type CaptionStandard } from "./caption-standards.js";
import type { Caption } from "./transcript.js";

const EPS = 1e-6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** A caption while it is being planned: the public fields plus what the passes need. */
export interface WorkCap extends Caption {
  /** Grammar text per word (before case and punctuation changes). */
  gram: string[];
  /** Speaker per word (a hyphen caption holds two). */
  spk: Array<string | undefined>;
  /** "NAME:" prefix for the first line, counted in the line length. */
  label?: string;
  /** Hyphen caption: the index in `words` where the second speaker's turn starts. */
  turns?: number;
  /** Not merged or split by the passes (hyphen captions). */
  locked?: boolean;
  /** The caption's first word start and last word end before frame snapping, offset applied. */
  rawStart: number;
  rawLastEnd: number;
}

export interface RuleSettings {
  frame: number;
  snap: (t: number) => number;
  maxChars: number;
  maxLines: number;
  minDur: number;
  maxDur: number;
  linger: number;
  /** Minimum gap between captions, seconds. */
  minGapT: number;
  /** Gaps shorter than this (and longer than minGapT) close to minGapT; 0 is off. */
  closeUnder: number;
  cutZone: number;
  /** Shot changes, comp-time seconds, frame-snapped and sorted. */
  cuts: number[];
  std?: CaptionStandard;
  fix: boolean;
  maxWords?: number;
  singleWord: boolean;
  /** Lines for a caption's words (label, lyric marks, grammar-aware breaks). */
  layout: (c: WorkCap) => string[];
}

export class Rec {
  items: Array<{ cap: WorkCap; rule: PlanChange["rule"]; action: PlanChange["action"]; detail: string }> = [];
  add(cap: WorkCap, rule: PlanChange["rule"], action: PlanChange["action"], detail: string) {
    this.items.push({ cap, rule, action, detail });
  }
  redirect(from: WorkCap, to: WorkCap) {
    for (const it of this.items) if (it.cap === from) it.cap = to;
  }
}

export const lastWord = (c: WorkCap) => c.words[c.words.length - 1];

// ---------- parts ----------

function part(c: WorkCap, from: number, to: number, S: RuleSettings, first: boolean): WorkCap {
  const words = c.words.slice(from, to);
  const p: WorkCap = {
    ...c,
    words,
    gram: c.gram.slice(from, to),
    spk: c.spk.slice(from, to),
    start: first ? c.start : words[0].start,
    end: c.end,
    rawStart: first ? c.rawStart : words[0].start,
    rawLastEnd: to === c.words.length ? c.rawLastEnd : words[words.length - 1].end,
    lines: [],
  };
  if (!first) delete p.label;
  delete p.turns;
  p.lines = S.layout(p);
  return p;
}

function mergeCaps(a: WorkCap, b: WorkCap, S: RuleSettings): WorkCap {
  const m: WorkCap = {
    ...a,
    words: [...a.words, ...b.words],
    gram: [...a.gram, ...b.gram],
    spk: [...a.spk, ...b.spk],
    end: b.end,
    rawLastEnd: b.rawLastEnd,
    lines: [],
  };
  m.lines = S.layout(m);
  return m;
}

// ---------- end times ----------

/** What the reading-speed limits ask of a caption: seconds on screen at least, and which limit asked. */
function readingNeed(c: WorkCap, S: RuleSettings): { dur: number; rule: PlanChange["rule"] } {
  const std = S.std;
  if (!std || c.kind === "sound") return { dur: 0, rule: "cps" };
  const chars = c.lines.join(" ").length;
  const words = c.words.length;
  let dur = 0;
  let rule: PlanChange["rule"] = "cps";
  if (std.max_cps) dur = chars / std.max_cps;
  if (std.max_wpm && (words * 60) / std.max_wpm > dur) {
    dur = (words * 60) / std.max_wpm;
    rule = "cps";
  }
  if (std.min_s_per_word && words * std.min_s_per_word > dur) {
    dur = words * std.min_s_per_word;
    rule = "min_duration";
  }
  return { dur, rule };
}

/** The out-time for a caption: held past its last word and for the minimum, never into the next caption. */
export function endFor(c: WorkCap, next: WorkCap | undefined, S: RuleSettings): number {
  const last = lastWord(c);
  let want = Math.max(c.rawLastEnd + S.linger, c.rawStart + S.minDur);
  // Half a frame of margin so rounding to a frame cannot drop it back under the limit.
  if (S.std && S.fix) want = Math.max(want, c.start + readingNeed(c, S).dur + S.frame * 0.5);
  let limit = Infinity;
  if (next) limit = next.start - S.minGapT;
  if (S.std) limit = Math.min(limit, Math.max(c.rawStart + S.maxDur, c.rawLastEnd));
  let end = Math.min(want, limit);
  if (end < c.rawLastEnd) end = Math.min(c.rawLastEnd, next ? next.start : Infinity);
  end = S.snap(end);
  if (end <= last.start) end = S.snap(last.start + S.frame);
  return end;
}

export function settleEnds(caps: WorkCap[], S: RuleSettings) {
  for (let i = 0; i < caps.length; i++) caps[i].end = endFor(caps[i], caps[i + 1], S);
}

// ---------- shot changes ----------

const cutInside = (S: RuleSettings, s: number, e: number) => S.cuts.some((c) => c > s + EPS && c < e - EPS);

/** Splits a caption whose words fall on both sides of a cut, when both halves can stand on their own. */
export function splitAtCuts(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  if (!S.cuts.length) return;
  const gapT = Math.max(S.minGapT, S.frame);
  const tol = S.frame * 0.5 + EPS;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.locked || c.kind === "sound" || c.words.length < 2) continue;
    const span = lastWord(c).end - c.words[0].start;
    if (span < 2 * S.minDur - EPS) continue;
    for (const cut of S.cuts) {
      const k = c.words.findIndex((w) => w.start >= cut - EPS);
      if (k > 0 && c.words[k - 1].start < cut - EPS) {
        // The first half ends 2 frames before the cut, so it can be on screen only that long. A sliver
        // (a lone weak word, or less than the minimum) is not worth a caption: the in-time snap moves
        // its words onto the cut instead.
        const room = cut - gapT - c.start;
        if (room < S.minDur - tol) continue;
        if (k === 1 && isWeakEnd(c.gram[0], c.gram[1])) continue;
        // The second half is held past its last word, but a lone weak word is not a caption either.
        if (c.words.length - k === 1 && isWeakEnd(c.gram[k], "x")) continue;
        const a = part(c, 0, k, S, true);
        const b = part(c, k, c.words.length, S, false);
        caps.splice(i, 1, a, b);
        rec.redirect(c, a);
        rec.add(a, "shot_change", "split", `split at the cut at ${r3(cut)} s so no caption straddles it`);
        i--; // look at the first half again: it may hold another cut
        break;
      }
    }
  }
}

/**
 * Moves an in-time onto a cut that is within the zone (before it, or a few frames after it).
 * Never past the end of the caption's own words, never closer than the minimum gap to the
 * caption before, and a word never ends before it starts.
 */
export function snapInTimes(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  if (!S.cuts.length) return;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const prev = caps[i - 1];
    const first = c.words[0];
    // Already on a cut (the pass runs twice): leave it, or it would walk back to an earlier cut.
    if (S.cuts.some((x) => Math.abs(x - c.start) < EPS)) continue;
    let best: number | undefined;
    let shift = false;
    for (const cut of S.cuts) {
      if (Math.abs(cut - c.start) > S.cutZone + EPS || Math.abs(cut - c.start) < EPS) continue;
      let late = false;
      if (cut < c.start) {
        // The cut is before the caption: start on the cut, if the caption before is done by then.
        if (prev && cut < lastWord(prev).end + S.minGapT - EPS) continue;
      } else {
        // The cut is just after the first word starts: a few frames late is fine, more is not.
        if (cut - first.start > 3 * S.frame + EPS) continue;
        if (c.words[1] && c.words[1].start < cut + S.frame - EPS) continue;
        if (prev && cut < lastWord(prev).end + S.minGapT - EPS) continue;
        if (cut > first.end - S.frame + EPS) {
          // The first word is over before the cut. A caption of one word stays where it is (it ends
          // before the cut); one that goes on after the cut starts on it, with that word shown late.
          if (c.words.length < 2) continue;
          late = true;
        }
      }
      if (best === undefined || Math.abs(cut - c.start) < Math.abs(best - c.start)) {
        best = cut;
        shift = late;
      }
    }
    if (best === undefined) continue;
    const from = c.start;
    c.start = best;
    c.rawStart = best;
    if (best > first.start) {
      first.start = best;
      if (shift && first.end < best + S.frame) first.end = best + S.frame;
    }
    rec.add(c, "shot_change", "moved_in", `in-time moved from ${r3(from)} s onto the cut at ${r3(best)} s`);
  }
}

/**
 * Out-times: 2 frames before a cut, or at least the zone after it. Cuts are taken in order and a
 * caption never grows back across a cut it has already been cut short at; a caption whose words
 * are over before a cut ends before it, however long the hold or the gap closing made it.
 */
export function cutOutTimes(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  if (!S.cuts.length) return;
  const gapT = Math.max(S.minGapT, S.frame);
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const next = caps[i + 1];
    const last = lastWord(c);
    const floor = S.snap(last.start + S.frame);
    for (const cut of S.cuts) {
      if (cut <= c.start + EPS) continue;
      if (c.end <= cut + EPS) {
        if (cut - c.end < S.cutZone - EPS) {
          let ne = S.snap(cut - gapT);
          if (ne < floor) ne = floor;
          // Into the gap only as far as the next caption allows.
          if (next && ne > next.start - S.minGapT) ne = Math.max(c.end, S.snap(next.start - S.minGapT));
          if (ne < cut - EPS && Math.abs(ne - c.end) > EPS) {
            rec.add(c, "shot_change", ne > c.end ? "extended" : "moved_out", `out-time moved from ${r3(c.end)} s to ${r3(ne)} s, ${Math.round(gapT / S.frame)} frame(s) before the cut at ${r3(cut)} s`);
            c.end = ne;
          }
        }
        break;
      }
      // The caption spans this cut.
      const from = c.end;
      if (last.end <= cut + EPS) {
        c.end = Math.max(floor, S.snap(cut - gapT));
        rec.add(c, "shot_change", "moved_out", `out-time moved from ${r3(from)} s to ${r3(c.end)} s, before the cut at ${r3(cut)} s`);
        if (c.end <= cut + EPS) break;
        continue;
      }
      // The words run over the cut: hold the caption the zone past it, if that is allowed.
      if (c.end - cut >= S.cutZone - EPS) continue;
      const target = S.snap(cut + S.cutZone);
      let lim = next ? next.start - S.minGapT : Infinity;
      const after = S.cuts.find((x) => x > cut + EPS);
      if (after !== undefined && after - gapT < lim) lim = after - gapT;
      if (S.std) lim = Math.min(lim, c.rawStart + S.maxDur);
      if (lim >= target - EPS) {
        c.end = target;
        rec.add(c, "shot_change", "extended", `out-time extended from ${r3(from)} s to ${r3(target)} s, ${S.cutZone} s past the cut at ${r3(cut)} s`);
      } else {
        c.end = Math.max(floor, S.snap(cut - gapT));
        rec.add(c, "shot_change", "moved_out", `out-time moved from ${r3(from)} s to ${r3(c.end)} s: no room to hold ${S.cutZone} s past the cut at ${r3(cut)} s`);
        if (c.end <= cut + EPS) break;
      }
    }
  }
}

// ---------- fixing a standard ----------

/** The reading and duration limits a caption breaks at its current out-time. */
export function timingIssues(c: WorkCap, S: RuleSettings): Array<PlanChange["rule"]> {
  const std = S.std;
  if (!std) return [];
  const out: Array<PlanChange["rule"]> = [];
  const dur = c.end - c.start;
  const tol = S.frame * 0.5 + EPS;
  if (dur < S.minDur - tol) out.push("min_duration");
  if (c.kind === "sound") return out;
  const lines = c.lines;
  if (std.max_cps && cpsOf(lines, c.start, c.end) > std.max_cps + 1e-6) out.push("cps");
  else if (std.max_wpm && wpmOf(lines, c.start, c.end) > std.max_wpm + 1e-6) out.push("cps");
  else if (std.min_s_per_word && dur < c.words.length * std.min_s_per_word - tol) out.push("min_duration");
  return out;
}

function canMerge(a: WorkCap, b: WorkCap, S: RuleSettings, wordLimit?: number): boolean {
  if (a.locked || b.locked || S.singleWord) return false;
  if (a.kind === "sound" || a.kind !== b.kind) return false;
  if (a.speaker !== b.speaker || b.label) return false;
  // A word limit gives way by one word when the merge cures a timing problem (the caller checks that it does).
  if (S.maxWords && a.words.length + b.words.length > (wordLimit ?? S.maxWords + 1)) return false;
  if (cutInside(S, a.start, lastWord(b).end)) return false;
  return lastWord(b).end - a.words[0].start <= S.maxDur + EPS;
}

const fits = (c: WorkCap, S: RuleSettings) => c.lines.length <= S.maxLines && c.lines.every((l) => l.length <= S.maxChars);

/**
 * A too-short or too-fast caption joins a neighbour when that cures it and the result still fits. The word limit gives way by
 * one word first; a caption still under the standard that way (its neighbours are full, and its out-time cannot grow into the
 * gap) joins the better neighbour even past max_words, up to twice the limit, as long as the lines and characters per line
 * of the standard hold (action "merged_over_max_words"). The better neighbour is the one with the same speaker and no cut
 * between that leaves the cleaner break (no weak end, no sentence cut in two) at the far side.
 */
export function mergePass(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  // enforceGaps later pulls an out-time back to the minimum gap before the next caption; judge the caption by that end.
  const issuesOf = (c: WorkCap, next: WorkCap | undefined) => {
    if (next && S.minGapT > 0 && next.start - c.end < S.minGapT - EPS) {
      const end = Math.max(S.snap(next.start - S.minGapT), S.snap(lastWord(c).start + S.frame));
      if (end < c.end - EPS) return timingIssues({ ...c, end }, S);
    }
    return timingIssues(c, S);
  };
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.locked || c.kind === "sound") continue;
    const issues = issuesOf(c, caps[i + 1]);
    if (!issues.length) continue;
    const pick = (wordLimit: number | undefined) => {
      let best: { j: number; m: WorkCap; k: number; cost: number } | undefined;
      for (const j of [i, i - 1]) {
        if (j < 0 || j + 1 >= caps.length) continue;
        const a = caps[j];
        const b = caps[j + 1];
        if (!canMerge(a, b, S, wordLimit)) continue;
        const m = mergeCaps(a, b, S);
        if (!fits(m, S)) continue;
        m.end = endFor(m, caps[j + 2], S);
        const k = issuesOf(m, caps[j + 2]).length;
        if (k >= issues.length) continue;
        // The break the merge leaves at the far side: a weak end or a cut sentence costs.
        const outerL = caps[j - 1];
        const outerR = caps[j + 2];
        let cost = 0;
        if (outerR && outerR.kind === m.kind && outerR.speaker === m.speaker) cost += breakPenalty(m.gram[m.gram.length - 1], outerR.gram[0], "caption");
        if (outerL && outerL.kind === m.kind && outerL.speaker === m.speaker) cost += breakPenalty(outerL.gram[outerL.gram.length - 1], m.gram[0], "caption");
        if (!best || k < best.k || (k === best.k && cost < best.cost - 1e-9)) best = { j, m, k, cost };
      }
      return best;
    };
    let over = false;
    let best = pick(undefined);
    if (!best && S.maxWords) {
      best = pick(2 * S.maxWords);
      over = best !== undefined;
    }
    if (!best) continue;
    const a = caps[best.j];
    const b = caps[best.j + 1];
    caps.splice(best.j, 2, best.m);
    rec.redirect(a, best.m);
    rec.redirect(b, best.m);
    const why = issues[0] === "cps" ? "too fast to read" : "too short";
    if (over) rec.add(best.m, issues[0], "merged_over_max_words", `merged captions ${best.j + 1} and ${best.j + 2} (${why}) into ${best.m.words.length} words, past max_words ${S.maxWords}: no neighbour could take it within the limit and its out-time could not grow; the result fits ${S.maxLines} line(s) of ${S.maxChars}`);
    else rec.add(best.m, issues[0], "merged", `merged captions ${best.j + 1} and ${best.j + 2} (${why}); the result fits ${S.maxLines} line(s) of ${S.maxChars}`);
    i = Math.max(-1, best.j - 1);
  }
}

/** A caption over the duration or line limits splits at the best grammatical point near its middle. */
export function splitPass(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.locked || c.kind === "sound" || c.words.length < 2) continue;
    const reasons: Array<PlanChange["rule"]> = [];
    if (lastWord(c).end - c.words[0].start > S.maxDur + EPS) reasons.push("max_duration");
    if (c.lines.length > S.maxLines) reasons.push("lines");
    else if (c.lines.some((l) => l.length > S.maxChars)) reasons.push("cpl");
    if (!reasons.length) continue;
    const n = c.words.length;
    const lo = n >= 4 ? Math.ceil(n * 0.25) : 1;
    const hi = n >= 4 ? Math.floor(n * 0.75) : n - 1;
    let bestK = Math.max(1, Math.min(n - 1, Math.round(n / 2)));
    let bestCost = Infinity;
    for (let k = Math.max(1, lo); k <= Math.min(n - 1, hi); k++) {
      const cost = breakPenalty(c.gram[k - 1], c.gram[k], "caption") + (4 * Math.abs(k - n / 2)) / n;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestK = k;
      }
    }
    const a = part(c, 0, bestK, S, true);
    const b = part(c, bestK, n, S, false);
    caps.splice(i, 1, a, b);
    rec.redirect(c, a);
    rec.add(a, reasons[0], "split", `split before "${c.words[bestK].text}" (${reasons[0] === "max_duration" ? "over the maximum duration" : reasons[0] === "lines" ? "over the line limit" : "a line over the character limit"})`);
    i--;
  }
}

// ---------- gaps ----------

/** A gap just over the minimum but under `closeUnder` closes to the minimum: a flicker reads as a glitch. */
export function closeGaps(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  if (S.closeUnder <= 0) return;
  for (let i = 0; i + 1 < caps.length; i++) {
    const c = caps[i];
    const next = caps[i + 1];
    const gap = next.start - c.end;
    if (gap <= S.minGapT + EPS || gap >= S.closeUnder - EPS) continue;
    const ne = S.snap(next.start - S.minGapT);
    if (ne <= c.end + EPS) continue;
    if (S.std && ne - c.rawStart > S.maxDur + EPS) continue;
    // Never carry a caption toward a cut: it must end 2 frames before it, whatever the gap.
    const gapT = Math.max(S.minGapT, S.frame);
    if (S.cuts.some((x) => x > c.start + EPS && x > c.end - EPS && x < ne + gapT - EPS)) continue;
    rec.add(c, "close_gap", "closed_gap", `gap of ${Math.round(gap / S.frame)} frames to the next caption closed to ${Math.round(S.minGapT / S.frame)}`);
    c.end = ne;
  }
}

/** Keeps the minimum gap by shortening the earlier out-time (not below its last word start + 1 frame) and clears overlaps. */
export function enforceGaps(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  for (let i = 0; i + 1 < caps.length; i++) {
    const c = caps[i];
    const next = caps[i + 1];
    if (S.minGapT > 0 && next.start - c.end < S.minGapT - EPS) {
      const ne = Math.max(S.snap(next.start - S.minGapT), S.snap(lastWord(c).start + S.frame));
      if (ne < c.end - EPS) {
        rec.add(c, "gap", "shortened", `out-time moved from ${r3(c.end)} s to ${r3(ne)} s to leave ${Math.round(S.minGapT / S.frame)} frames before the next caption`);
        c.end = ne;
      }
    }
    if (c.end > next.start) c.end = Math.max(c.start + S.frame, next.start);
  }
}

/** Notes captions held past their last word by more than the linger, for a standard's duration or speed. */
export function recordExtensions(caps: WorkCap[], S: RuleSettings, rec: Rec) {
  if (!S.std || !S.fix) return;
  for (const c of caps) {
    if (rec.items.some((it) => it.cap === c && it.action === "extended")) continue;
    const held = c.rawLastEnd + S.linger;
    if (c.end <= held + S.frame * 0.5 + EPS) continue;
    const need = readingNeed(c, S);
    const byReading = c.start + need.dur + S.frame * 0.5 >= c.rawStart + S.minDur;
    const rule: PlanChange["rule"] = byReading ? need.rule : "min_duration";
    rec.add(c, rule, "extended", `out-time extended to ${r3(c.end)} s (${r3(c.end - lastWord(c).end)} s after the last word) into the gap`);
  }
}

// ---------- violations ----------

export function findViolations(caps: WorkCap[], S: RuleSettings): PlanViolation[] {
  const std = S.std;
  if (!std) return [];
  const out: PlanViolation[] = [];
  const tol = S.frame * 0.25 + EPS;
  caps.forEach((c, i) => {
    const n = i + 1;
    const next = caps[i + 1];
    const dur = c.end - c.start;
    for (const rule of timingIssues(c, S)) {
      if (rule === "min_duration") out.push({ n, rule, detail: `on screen ${r3(dur)} s; the minimum is ${r3(S.minDur)} s${std.min_s_per_word ? ` (and ${std.min_s_per_word} s per word)` : ""}` });
      else out.push({ n, rule: "cps", detail: std.max_cps ? `${Math.round(cpsOf(c.lines, c.start, c.end) * 10) / 10} characters per second; the limit is ${std.max_cps}` : `${Math.round(wpmOf(c.lines, c.start, c.end))} words per minute; the limit is ${std.max_wpm}` });
    }
    if (dur > S.maxDur + tol) out.push({ n, rule: "max_duration", detail: `on screen ${r3(dur)} s; the maximum is ${r3(S.maxDur)} s` });
    const wide = c.lines.filter((l) => l.length > S.maxChars);
    if (wide.length) out.push({ n, rule: "cpl", detail: `a line is ${Math.max(...wide.map((l) => l.length))} characters; the limit is ${S.maxChars}` });
    if (c.lines.length > S.maxLines) out.push({ n, rule: "lines", detail: `${c.lines.length} lines; the limit is ${S.maxLines}` });
    if (next) {
      if (next.start < c.end - tol) out.push({ n, rule: "overlap", detail: `ends at ${r3(c.end)} s, after the next caption starts (${r3(next.start)} s)` });
      else if (S.minGapT > 0 && next.start - c.end < S.minGapT - tol) out.push({ n, rule: "gap", detail: `${Math.round((next.start - c.end) / S.frame)} frame(s) before the next caption; the minimum is ${Math.round(S.minGapT / S.frame)}` });
    }
    if (S.cuts.some((x) => x > c.start + tol && x < c.end - tol)) out.push({ n, rule: "shot_change", detail: "the caption is on screen across a shot change" });
    if (c.kind !== "sound") {
      c.lines.forEach((line, k) => {
        const toks = line.split(" ");
        const lastTok = toks[toks.length - 1];
        const following = c.lines[k + 1] ? c.lines[k + 1].split(" ")[0] : undefined;
        if (following !== undefined && isWeakEnd(lastTok, following)) out.push({ n, rule: "grammar", detail: `line ${k + 1} ends on "${lastTok}"` });
      });
      const g = c.gram[c.gram.length - 1];
      if (next && next.kind === c.kind && next.speaker === c.speaker && next.start - lastWord(c).end < 1 && isWeakEnd(g, next.gram[0])) out.push({ n, rule: "grammar", detail: `the caption ends on "${g}" and the sentence goes on in the next` });
    }
  });
  return out;
}
