/**
 * server/src/transcript.ts
 *
 * Transcripts to marker cues, for VO markers:
 * - parseTranscript: SRT, WebVTT, or JSON (ElevenLabs speech-to-text with
 *   `words`, Whisper-style `segments` with optional `words`, or a plain array
 *   of {text, start, end})
 * - transcriptCues: one cue per segment, sentence or word, with the speaker
 *   mapped to an AE label colour
 *
 * - buildCaptions: words grouped into line-broken, frame-timed captions
 *
 * The transcription itself happens outside this server; this only places
 * what a transcript already says.
 */
import { cleanupWords, type CleanWord } from "./caption-cleanup.js";
import type { CaptionKind, CaptionStandardId, CleanupReport, PlanChange, PlanOptions, PlanViolation } from "./caption-plan-options.js";
import {
  closeGaps,
  cutOutTimes,
  enforceGaps,
  findViolations,
  mergePass,
  recordExtensions,
  Rec,
  settleEnds,
  snapInTimes,
  splitAtCuts,
  splitPass,
  type RuleSettings,
  type WorkCap,
} from "./caption-rules.js";
import { breakPenalty, CAPTION_STANDARDS, SPEAKER_COLORS } from "./caption-standards.js";


export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  speaker?: string;
  words?: TranscriptWord[];
  /**
   * Sound events the transcript carries (ElevenLabs `audio_event` entries such as "(laughter)").
   * Only the captions path reads them; marker cues ignore them.
   */
  sound_events?: TranscriptWord[];
}

export type TranscriptFormat = "srt" | "vtt" | "json";
export type CueUnit = "segment" | "sentence" | "word";

export interface MarkerCue {
  time: number;
  duration: number;
  comment: string;
  speaker?: string;
  /** AE marker label 1..16; one per speaker. */
  label?: number;
}

export class TranscriptError extends Error {}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** "01:02:03,456", "01:02:03.456", "02:03.456" or "123.4" to seconds. */
export function parseTimecode(s: string): number {
  const t = s.trim().replace(",", ".");
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) {
    throw new TranscriptError(`Bad timecode "${s}"`);
  }
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Matches "NAME: text" at the start of a cue body. */
const SPEAKER_PREFIX = /^([A-Z][\w .'-]{0,30}):\s+(.+)$/s;

/** All capitals ("ANNA", "DR. SMITH"): the usual way subtitle exports write a speaker. */
const isAllCaps = (name: string) => /[A-Z]/.test(name) && name === name.toUpperCase();

function parseCueBlocks(text: string, isVtt: boolean): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  // "NAME: text" prefix candidates, decided once the whole file is read.
  const candidates: Array<{ seg: TranscriptSegment; name: string; rest: string }> = [];
  let untagged = 0;
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const arrow = lines.findIndex((l) => l.includes("-->"));
    if (arrow < 0) continue;
    const [a, rest] = lines[arrow].split("-->");
    // VTT cue settings follow the end time ("00:02.000 align:start").
    const b = rest.trim().split(/\s+/)[0];
    const body = lines
      .slice(arrow + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!body) continue;
    let speaker: string | undefined;
    // VTT voice spans "<v Name>" were stripped above; read them from the raw block.
    const voice = isVtt ? /<v(?:\.[^ >]+)?\s+([^>]+)>/.exec(lines.slice(arrow + 1).join("\n")) : null;
    if (voice) speaker = voice[1].trim();
    const seg: TranscriptSegment = { text: body, start: parseTimecode(a), end: parseTimecode(b), ...(speaker ? { speaker } : {}) };
    if (!voice) {
      untagged++;
      const m = SPEAKER_PREFIX.exec(body);
      if (m) candidates.push({ seg, name: m[1].trim(), rest: m[2].trim() });
    }
    out.push(seg);
  }
  // A prefix is a speaker when it is all caps, or when most cues in the file carry a
  // prefix and this one repeats. Otherwise "Note: ..." or "Step 1: ..." keeps its text.
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const mostlyPrefixed = candidates.length * 2 > untagged;
  for (const c of candidates) {
    if (isAllCaps(c.name) || (mostlyPrefixed && (counts.get(c.name) ?? 0) >= 2)) {
      c.seg.speaker = c.name;
      c.seg.text = c.rest;
    }
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function wordsFrom(list: unknown[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const w of list) {
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    // ElevenLabs marks gaps and sounds with type "spacing" / "audio_event".
    if (o.type !== undefined && o.type !== "word") continue;
    const text = String(o.text ?? o.word ?? "").trim();
    const start = num(o.start);
    const end = num(o.end);
    if (!text || start === undefined || end === undefined) continue;
    const speaker = o.speaker_id ?? o.speaker;
    words.push({ text, start, end, ...(speaker !== undefined && speaker !== null ? { speaker: String(speaker) } : {}) });
  }
  return words;
}

/** ElevenLabs `audio_event` entries: "(laughter)", "(music)". Kept for the captions path only. */
function eventsFrom(list: unknown[]): TranscriptWord[] {
  const events: TranscriptWord[] = [];
  for (const w of list) {
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    if (o.type !== "audio_event") continue;
    const text = String(o.text ?? o.word ?? "").trim();
    const start = num(o.start);
    const end = num(o.end);
    if (!text || start === undefined || end === undefined) continue;
    const speaker = o.speaker_id ?? o.speaker;
    events.push({ text, start, end, ...(speaker !== undefined && speaker !== null ? { speaker: String(speaker) } : {}) });
  }
  return events;
}

/** Groups words into segments at a speaker change or a pause longer than `gap` seconds. */
export function segmentWords(words: TranscriptWord[], gap = 0.8): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      text: cur.map((w) => w.text).join(" "),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      ...(cur[0].speaker !== undefined ? { speaker: cur[0].speaker } : {}),
      words: cur,
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.speaker !== prev.speaker || w.start - prev.end > gap)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

function parseJson(text: string): TranscriptSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new TranscriptError(`Transcript is not valid JSON: ${(err as Error).message}`);
  }
  const obj = data as Record<string, unknown>;
  if (Array.isArray(data)) {
    const segs: TranscriptSegment[] = [];
    for (const s of data) {
      const o = s as Record<string, unknown>;
      const start = num(o?.start);
      const end = num(o?.end);
      const t = String(o?.text ?? o?.word ?? "").trim();
      if (t && start !== undefined && end !== undefined) {
        const speaker = o.speaker ?? o.speaker_id;
        segs.push({ text: t, start, end, ...(speaker !== undefined && speaker !== null ? { speaker: String(speaker) } : {}) });
      }
    }
    return segs;
  }
  if (Array.isArray(obj?.segments)) {
    return (obj.segments as unknown[]).flatMap((s) => {
      const o = s as Record<string, unknown>;
      const start = num(o?.start);
      const end = num(o?.end);
      if (start === undefined || end === undefined) return [];
      const words = Array.isArray(o.words) ? wordsFrom(o.words as unknown[]) : undefined;
      const events = Array.isArray(o.words) ? eventsFrom(o.words as unknown[]) : [];
      const speaker = o.speaker ?? o.speaker_id;
      return [
        {
          text: String(o.text ?? "").trim(),
          start,
          end,
          ...(speaker !== undefined && speaker !== null ? { speaker: String(speaker) } : {}),
          ...(words && words.length ? { words } : {}),
          ...(events.length ? { sound_events: events } : {}),
        },
      ];
    });
  }
  if (Array.isArray(obj?.words)) {
    const segs = segmentWords(wordsFrom(obj.words as unknown[]));
    // Each sound event goes with the last segment that started before it (the first, when none did).
    for (const ev of eventsFrom(obj.words as unknown[])) {
      let host = segs[0];
      for (const sg of segs) if (sg.start <= ev.start) host = sg;
      if (host) (host.sound_events ??= []).push(ev);
    }
    return segs;
  }
  throw new TranscriptError("JSON transcript needs `words`, `segments`, or an array of {text, start, end}");
}

export function detectFormat(text: string, hint?: string): TranscriptFormat {
  const h = (hint ?? "").toLowerCase();
  if (h.endsWith("srt")) return "srt";
  if (h.endsWith("vtt")) return "vtt";
  if (h.endsWith("json")) return "json";
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("WEBVTT")) return "vtt";
  return "srt";
}

export function parseTranscript(text: string, format?: TranscriptFormat): TranscriptSegment[] {
  const f = format ?? detectFormat(text);
  const segs = f === "json" ? parseJson(text) : parseCueBlocks(text, f === "vtt");
  if (!segs.length) throw new TranscriptError(`No timed lines found in the ${f.toUpperCase()} transcript`);
  return segs.sort((a, b) => a.start - b.start);
}

/**
 * parseTranscript for the captions path. A JSON transcript holding only sound events (ElevenLabs
 * `audio_event` entries, no words) is not an error here: it comes back as one segment with no
 * words and the events, which buildCaptions turns into sound captions. Marker cues keep using
 * parseTranscript, which still refuses such a file.
 */
export function parseCaptionTranscript(text: string, format?: TranscriptFormat): TranscriptSegment[] {
  try {
    return parseTranscript(text, format);
  } catch (err) {
    const f = format ?? detectFormat(text);
    if (f !== "json") throw err;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw err;
    }
    const list = Array.isArray(data) ? data : Array.isArray((data as Record<string, unknown>)?.words) ? ((data as Record<string, unknown>).words as unknown[]) : [];
    const events = eventsFrom(list).sort((a, b) => a.start - b.start);
    if (!events.length) throw err;
    return [{ text: "", start: events[0].start, end: Math.max(...events.map((e) => e.end)), sound_events: events }];
  }
}

/** Splits a segment into sentences, timed by its words when it has them, else by character share. */
function sentencesOf(seg: TranscriptSegment): TranscriptSegment[] {
  if (seg.words && seg.words.length) {
    const out: TranscriptSegment[] = [];
    let cur: TranscriptWord[] = [];
    for (const w of seg.words) {
      cur.push(w);
      if (/[.!?…]["')\]]?$/.test(w.text)) {
        out.push({ text: cur.map((x) => x.text).join(" "), start: cur[0].start, end: w.end, speaker: seg.speaker });
        cur = [];
      }
    }
    if (cur.length) out.push({ text: cur.map((x) => x.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end, speaker: seg.speaker });
    return out;
  }
  const parts = seg.text.match(/[^.!?…]+[.!?…]+["')\]]?|[^.!?…]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [seg.text];
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const span = seg.end - seg.start;
  let t = seg.start;
  return parts.map((p) => {
    const d = (span * p.length) / total;
    const s = { text: p, start: t, end: t + d, speaker: seg.speaker };
    t += d;
    return s;
  });
}

function wordsOf(seg: TranscriptSegment): TranscriptSegment[] {
  if (seg.words && seg.words.length) return seg.words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker ?? seg.speaker }));
  // No word timings: spread the words across the segment by character share.
  const words = seg.text.split(/\s+/).filter(Boolean);
  const total = words.reduce((n, w) => n + w.length, 0) || 1;
  const span = seg.end - seg.start;
  let t = seg.start;
  return words.map((w) => {
    const d = (span * w.length) / total;
    const s = { text: w, start: t, end: t + d, speaker: seg.speaker };
    t += d;
    return s;
  });
}

export function transcriptCues(
  segments: TranscriptSegment[],
  opts: { unit?: CueUnit; speaker_labels?: boolean; offset?: number; max_chars?: number } = {}
): MarkerCue[] {
  const unit = opts.unit ?? "segment";
  const pieces = segments.flatMap((s) => {
    if (unit === "word") return wordsOf(s);
    if (unit === "sentence") return sentencesOf(s);
    return [s];
  });
  const speakers: string[] = [];
  const maxChars = opts.max_chars ?? 2000;
  return pieces.map((p) => {
    const cue: MarkerCue = {
      time: round3(p.start + (opts.offset ?? 0)),
      duration: round3(Math.max(0, p.end - p.start)),
      comment: p.text.length > maxChars ? p.text.slice(0, maxChars) + "…" : p.text,
    };
    if (p.speaker !== undefined) {
      cue.speaker = p.speaker;
      if (opts.speaker_labels !== false) {
        let i = speakers.indexOf(p.speaker);
        if (i < 0) i = speakers.push(p.speaker) - 1;
        // AE's labels 1..16; skip 0 (None).
        cue.label = (i % 16) + 1;
      }
    }
    return cue;
  });
}

// ---------- captions ----------

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  /**
   * When the highlight switches to this word: `start` minus highlight_lead_frames, never before the
   * caption's start or the previous word's show_at. Always set by buildCaptions.
   */
  show_at?: number;
}

export interface Caption {
  /** Seconds on the timeline (offset applied, frame-rounded when a frame rate was given). */
  start: number;
  end: number;
  /** The words in order, one line per entry. Joined with spaces they are `words`. */
  lines: string[];
  words: CaptionWord[];
  speaker?: string;
  /** "speech" (default), "sound" (an SDH sound event such as [laughter]) or "lyric" (sung: italic, wrapped in music notes). */
  kind?: CaptionKind;
  /** 0-based order in which the caption's speaker first appears. */
  speaker_index?: number;
  /** Hex colour for this caption's speaker; only with speaker_style "color". */
  color?: string;
  /** Lyrics are italic. */
  italic?: boolean;
}

export interface CaptionOptions extends PlanOptions {
  max_chars_per_line?: number;
  max_lines?: number;
  /** A caption stays up at least this long when the next one allows it. */
  min_duration?: number;
  max_duration?: number;
  /** Seconds a caption stays after its last word, within the gap to the next. */
  linger?: number;
  /** A pause between words longer than this starts a new caption. */
  pause_break?: number;
  offset?: number;
  /** Rounds every time to a whole frame. Without it times are only rounded to 1 ms. */
  frame_rate?: number;
}

export interface CaptionPlan {
  captions: Caption[];
  /** True when some words had no times of their own and were spread over their segment by character share. */
  estimated_word_times: boolean;
  warnings: string[];
  /** The standard the plan was made for, when one was asked for. */
  standard?: CaptionStandardId;
  /** What the planner changed to meet the standard or the shot-change rules. Always present. */
  changes: PlanChange[];
  /** Rules still broken after fixing (only with a standard). Always present. */
  violations: PlanViolation[];
  /** What clean-up did; present when a `cleanup` option was given. */
  cleanup?: CleanupReport;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;
const MUSIC = "♪";

/** A segment's words with times; words without their own times are spread over the segment by character share. */
export function timedWords(seg: TranscriptSegment): { words: TranscriptWord[]; estimated: boolean } {
  const estimated = !(seg.words && seg.words.length);
  const raw: TranscriptWord[] = wordsOf(seg).map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
  }));
  // AE counts words by whitespace, so a "word" holding spaces becomes several, sharing its time.
  const out: TranscriptWord[] = [];
  for (const w of raw) {
    const parts = w.text.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      if (parts.length === 1) out.push({ ...w, text: parts[0] });
      continue;
    }
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = w.start;
    for (const p of parts) {
      const d = ((w.end - w.start) * p.length) / total;
      out.push({ ...w, text: p, start: t, end: t + d });
      t += d;
    }
  }
  return { words: out, estimated };
}

/** Lines a greedy fill needs for these word lengths. A word longer than the line still takes a line to itself. */
export function greedyLineCount(lengths: number[], maxChars: number): number {
  let lines = 0;
  let len = 0;
  for (const n of lengths) {
    if (lines === 0) {
      lines = 1;
      len = n;
    } else if (len + 1 + n <= maxChars) {
      len += 1 + n;
    } else {
      lines++;
      len = n;
    }
  }
  return lines;
}

function greedyLines(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface BreakOptions {
  /** Text to judge each word's grammar by when `words` carry decoration (labels, music notes). Same length as `words`. */
  gram?: string[];
  /** Weigh grammar (no line ending on an article, preposition, conjunction ...). Default true. */
  grammar?: boolean;
  /** Prefer the lower line longer when two layouts cost about the same. Default true. */
  bottom_heavy?: boolean;
}

/**
 * Breaks words into the fewest lines of at most `maxChars` characters, with the lines as even as
 * possible (a two-line caption is split near the middle, not greedily). A line should not end on
 * an article, preposition, conjunction, auxiliary, a subject pronoun before its verb, a first name
 * before a surname or a number before its unit when another break is nearby: each break costs its
 * grammar penalty (caption-standards breakPenalty) next to the evenness cost, and a layout with the
 * lower line shorter costs a little extra. Character counts only: Node can't measure glyphs, so a
 * proportional font can still run wider than the count suggests.
 */
export function breakLines(words: string[], maxChars: number, opts: BreakOptions = {}): string[] {
  if (!words.length) return [];
  const lens = words.map((w) => w.length);
  const n = greedyLineCount(lens, maxChars);
  if (n <= 1) return [words.join(" ")];
  const gram = opts.gram ?? words;
  const useGrammar = opts.grammar !== false;
  const bottomHeavy = opts.bottom_heavy !== false;
  // One penalty point is worth a fortieth of a full-width line's evenness cost.
  const unit = (maxChars * maxChars) / 40;
  const lineLen = (i: number, j: number) => lens.slice(i, j).reduce((a, b) => a + b, 0) + (j - i - 1);
  const cost = (i: number, j: number) => {
    const len = lineLen(i, j);
    let c: number;
    if (len > maxChars) c = j - i === 1 ? (len - maxChars) ** 2 : Infinity;
    else c = (maxChars - len) ** 2;
    if (useGrammar && j < words.length) c += unit * breakPenalty(gram[j - 1], gram[j], "line");
    return c;
  };
  // best[k][j]: cheapest way to set the first j words in k lines.
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let j = k; j <= words.length; j++) {
      for (let i = k - 1; i < j; i++) {
        let c = best[k - 1][i] + cost(i, j);
        if (bottomHeavy && k >= 2 && j === words.length && lineLen(i, j) < lineLen(from[k - 1][i], i)) c += 0.6 * unit;
        if (c < best[k][j]) {
          best[k][j] = c;
          from[k][j] = i;
        }
      }
    }
  }
  if (!Number.isFinite(best[n][words.length])) return greedyLines(words, maxChars);
  const lines: string[] = [];
  let j = words.length;
  for (let k = n; k >= 1; k--) {
    const i = from[k][j];
    lines.unshift(words.slice(i, j).join(" "));
    j = i;
  }
  return lines;
}

const snapTo = (t: number, fps?: number) => (fps ? Math.round(t * fps) / fps : round3(t));

/** Text for a sound event: "(Laughter)" and "[laughter]" both become "[laughter]". Undefined when nothing is left. */
function soundText(raw: string): string | undefined {
  const inner = raw.replace(/^[\s[(]+|[\s\])]+$/g, "").trim().toLowerCase();
  return inner ? `[${inner}]` : undefined;
}

/** Pulls words wholly in [square brackets] (also a run of several) out of the speech into sound events. */
function takeBracketEvents(words: CleanWord[]): { words: CleanWord[]; events: TranscriptWord[] } {
  const kept: CleanWord[] = [];
  const events: TranscriptWord[] = [];
  let carry = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.text.startsWith("[")) {
      let j = i;
      while (j < words.length && j - i < 8 && !words[j].text.endsWith("]")) j++;
      if (j < words.length && words[j].text.endsWith("]") && j - i < 8) {
        events.push({ text: words.slice(i, j + 1).map((x) => x.text).join(" "), start: w.start, end: words[j].end });
        if (words[i].cue_start) carry = true;
        i = j;
        continue;
      }
    }
    kept.push(carry && !w.cue_start ? { ...w, cue_start: true } : w);
    carry = false;
  }
  return { words: kept, events };
}

interface Group {
  words: CleanWord[];
  kind: CaptionKind;
  label?: string;
  /** Turn boundary for a hyphen caption. */
  turns?: number;
  notes: Array<{ rule: PlanChange["rule"]; action: PlanChange["action"]; detail: string }>;
}

/**
 * Transcript segments to captions: words are grouped at a speaker change, a pause, a sentence end
 * once the caption has some length, or when the line, line-count or duration limits would be
 * broken; each caption is line-broken, held for its minimum length (up to the next caption) and
 * rounded to whole frames without overlapping the next. With a `standard` its limits become the
 * defaults and violations are fixed (see caption-rules.ts); `cut_times`, `cleanup`, social
 * chunking, speakers and SDH are described in caption-plan-options.ts. Pure: nothing here touches AE.
 */
export function buildCaptions(segments: TranscriptSegment[], opts: CaptionOptions = {}): CaptionPlan {
  const std = opts.standard ? CAPTION_STANDARDS[opts.standard] : undefined;
  const fix = std ? opts.fix !== false : false;
  const maxChars = opts.max_chars_per_line ?? std?.max_cpl ?? 32;
  const maxLines = opts.max_lines ?? std?.max_lines ?? 2;
  const minDur = opts.min_duration ?? std?.min_duration_s ?? 1;
  const maxDur = opts.max_duration ?? std?.max_duration_s ?? 6;
  const linger = opts.linger ?? std?.linger_s ?? 0.25;
  const pause = opts.pause_break ?? 0.7;
  const offset = opts.offset ?? 0;
  const minGapFrames = opts.min_gap_frames ?? (std ? std.min_gap_frames : 0);
  const closeUnder = opts.close_gaps_under ?? (std && fix ? std.close_gap_under_s : 0);
  const cutZone = std?.cut_zone_s ?? 0.5;
  const rawCuts = opts.cut_times ?? [];
  const warnings: string[] = [];
  let estimated = false;

  // Frame rules need a frame rate; without one, 24 is assumed (and said).
  let fps = opts.frame_rate;
  if (!fps && (std || minGapFrames > 0 || closeUnder > 0 || rawCuts.length)) {
    fps = 24;
    warnings.push("No frame rate was given, so the frame-based rules (minimum gap, closing gaps, shot changes) assume 24 fps. Pass the comp's frame rate for exact frames.");
  }
  const frame = fps ? 1 / fps : 0.001;
  const snap = (t: number) => snapTo(t, fps);
  const leadFrame = 1 / (fps ?? 24);
  const lead = (opts.highlight_lead_frames ?? 1) * leadFrame;
  const sdhSound = opts.sdh?.sound_events !== false;
  const speakerStyle = opts.speaker_style ?? "none";
  const labelMode = speakerStyle === "label" || (speakerStyle === "color" && opts.accessibility === true);
  const nameOf = (id: string) => opts.speaker_names?.[id] ?? id.toUpperCase();

  // A subtitle cue (SRT, VTT: no word times) is already a caption, so a new caption starts at each one.
  let all: CleanWord[] = [];
  let events: TranscriptWord[] = [];
  for (const seg of segments) {
    const t = timedWords(seg);
    let words: CleanWord[] = t.words.map((w) => (t.estimated ? { ...w, estimated: true } : { ...w }));
    if (t.estimated && words.length) {
      estimated = true;
      words[0] = { ...words[0], cue_start: true };
    }
    if (sdhSound) {
      const taken = takeBracketEvents(words);
      words = taken.words;
      events.push(...taken.events);
      for (const ev of seg.sound_events ?? []) events.push(ev);
    }
    all.push(...words);
  }

  let cleanupReport: CleanupReport | undefined;
  if (opts.cleanup) {
    const r = cleanupWords(all, opts.cleanup);
    all = r.words;
    cleanupReport = r.report;
    if (opts.cleanup.drop_after_s !== undefined) {
      const limit = opts.cleanup.drop_after_s;
      const before = events.length;
      events = events.filter((e) => e.start < limit);
      cleanupReport.dropped_after_end += before - events.length;
    }
  }
  events = events.sort((a, b) => a.start - b.start).filter((e) => soundText(e.text) !== undefined);
  if (!all.length && !events.length) throw new TranscriptError("The transcript has no words to caption");

  const lyricRanges = opts.sdh?.lyric_ranges ?? [];
  const kindOf = (w: CleanWord): CaptionKind => {
    const mid = (w.start + w.end) / 2;
    return lyricRanges.some((r) => mid >= r.start && mid < r.end) ? "lyric" : "speech";
  };
  const isSentEnd = (w: CleanWord) => w.sentence_end ?? SENTENCE_END.test(w.text);
  const gramOf = (w: CleanWord) => w.gram ?? w.text;

  /** The tokens a caption's lines are broken from: the words, with a speaker label and lyric notes counted in. */
  const tokensOf = (texts: string[], label: string | undefined, kind: CaptionKind): string[] => {
    const t = texts.slice();
    if (kind === "lyric" && t.length) {
      t[0] = `${MUSIC} ${t[0]}`;
      t[t.length - 1] = `${t[t.length - 1]} ${MUSIC}`;
    }
    if (label && t.length) t[0] = `${label} ${t[0]}`;
    return t;
  };
  const bottomHeavy = std ? std.bottom_heavy : true;
  const layout = (c: WorkCap): string[] => {
    const texts = c.words.map((w) => w.text);
    if (c.kind === "sound") return [texts.join(" ")];
    if (c.turns !== undefined) return ["- " + texts.slice(0, c.turns).join(" "), "- " + texts.slice(c.turns).join(" ")];
    return breakLines(tokensOf(texts, c.label, c.kind ?? "speech"), maxChars, { gram: c.gram, bottom_heavy: bottomHeavy });
  };

  // ----- grouping -----
  const groups: Group[] = [];
  let cur: CleanWord[] = [];
  let curKind: CaptionKind = "speech";
  let curLabel: string | undefined;
  let lastSpeaker: string | undefined;
  let ei = 0;
  const flush = () => {
    if (cur.length) groups.push({ words: cur, kind: curKind, ...(curLabel ? { label: curLabel } : {}), notes: [] });
    cur = [];
    curLabel = undefined;
  };
  const pushEvents = (before: number) => {
    while (ei < events.length && events[ei].start <= before) {
      flush();
      const ev = events[ei++];
      groups.push({ words: [{ text: soundText(ev.text)!, start: ev.start, end: ev.end }], kind: "sound", notes: [] });
    }
  };
  const tokenLens = (ws: CleanWord[], label: string | undefined, kind: CaptionKind) => tokensOf(ws.map((x) => x.text), label, kind).map((t) => t.length);
  const overflows = (ws: CleanWord[]) => ws[ws.length - 1].end - ws[0].start > maxDur || greedyLineCount(tokenLens(ws, curLabel, curKind), maxChars) > maxLines;
  const chars = (ws: CleanWord[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);

  /** How many of `ws` stay in the caption that is closed: the best grammatical break among the last few words. */
  const bestSplit = (ws: CleanWord[], next: CleanWord): number => {
    if (ws.length < 3) return ws.length;
    let bestK = ws.length;
    let bestCost = Infinity;
    for (let k = ws.length; k >= Math.max(2, ws.length - 4); k--) {
      const after = k < ws.length ? ws[k] : next;
      const cost = breakPenalty(gramOf(ws[k - 1]), gramOf(after), "caption") + 0.3 * (ws.length - k);
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestK = k;
      }
    }
    return bestK;
  };

  /** True when `b` may share a caption with `a` as far as speaker, kind, cue and pause go (not the length limits). */
  const joinable = (a: CleanWord, b: CleanWord) => b.speaker === a.speaker && !b.cue_start && kindOf(b) === kindOf(a) && b.start - a.end <= pause;

  /**
   * A max_words chunk is full and `w` is next: how many of cur + w close the chunk. Usually all of cur (a break before w),
   * but a chunk may take one extra word, or hand its last word to the next chunk, when that avoids ending on a weak word
   * (article, preposition, conjunction, auxiliary, first name) or a chunk that cannot stay up the minimum time. A break at
   * punctuation or a pause is preferred.
   */
  const wordBreak = (ws: CleanWord[], wi: number): number => {
    const cap = opts.max_words!;
    const line = [...ws, all[wi]];
    const after = all[wi + 1];
    const timed = fix && std !== undefined;
    let bestK = ws.length;
    let bestCost = Infinity;
    for (const k of [ws.length, ws.length + 1, ws.length - 1]) {
      if (k < 1 || k > cap + 1) continue;
      if (k === ws.length + 1 && overflows(line)) continue;
      const a = line[k - 1];
      const b = line[k] ?? after;
      // A speaker change, cue start or long pause breaks there anyway, so it costs nothing.
      let cost = b === undefined || !joinable(a, b) ? 0 : breakPenalty(gramOf(a), gramOf(b), "caption");
      if (b !== undefined && b.start - a.end >= 0.2) cost -= 1;
      if (k > cap) cost += 1.5; // an extra word must buy a real gain: a weak end or a too-short chunk
      else if (k < ws.length) cost += 0.3;
      if (timed && b !== undefined && b.start - line[0].start < minDur - frame * 0.5) cost += 3;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestK = k;
      }
    }
    return bestK;
  };

  for (let wi = 0; wi < all.length; wi++) {
    const w = all[wi];
    pushEvents(w.start);
    const prev = cur[cur.length - 1];
    const kind = kindOf(w);
    let hard = false;
    let soft = false;
    let wordFull = false;
    if (prev) {
      if (w.speaker !== prev.speaker || w.cue_start || kind !== curKind) hard = true;
      else if (w.start - prev.end > pause) hard = true;
      else if (opts.single_word) hard = true;
      else if (opts.max_words && cur.length >= opts.max_words) wordFull = true;
      else if (overflows([...cur, w])) soft = true;
      else if (isSentEnd(prev) && chars(cur) >= maxChars * 0.4) hard = true;
    }
    if (wordFull) {
      const k = wordBreak(cur, wi);
      if (k > cur.length) {
        // The chunk takes w as its extra word and closes.
        cur.push(w);
        lastSpeaker = w.speaker;
        flush();
        continue;
      }
      groups.push({ words: cur.slice(0, k), kind: curKind, ...(curLabel ? { label: curLabel } : {}), notes: [] });
      cur = cur.slice(k);
      curLabel = undefined;
    } else if (soft) {
      let first = true;
      while (cur.length && overflows([...cur, w])) {
        const k = first ? bestSplit(cur, w) : cur.length;
        first = false;
        groups.push({ words: cur.slice(0, k), kind: curKind, ...(curLabel ? { label: curLabel } : {}), notes: [] });
        cur = cur.slice(k);
        curLabel = undefined;
      }
    } else if (hard) flush();
    if (!cur.length) {
      curKind = kind;
      curLabel = labelMode && w.speaker !== undefined && w.speaker !== lastSpeaker ? `${nameOf(w.speaker)}:` : undefined;
    }
    lastSpeaker = w.speaker;
    cur.push(w);
  }
  flush();
  pushEvents(Infinity);

  // Social chunking: a very short word, a number and its unit, a first name and a surname show together.
  if (opts.single_word) {
    const shortT = 8 * leadFrame;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.kind === "sound") continue;
      while (g.words.length < 3 && i + 1 < groups.length) {
        const last = g.words[g.words.length - 1];
        const nxt = groups[i + 1];
        if (nxt.kind !== g.kind || nxt.label || nxt.words[0].speaker !== last.speaker || nxt.words[0].cue_start) break;
        if (nxt.words[0].start - last.end > pause || isSentEnd(last)) break;
        const isShort = last.end - last.start < shortT - 1e-9;
        const joined = breakPenalty(gramOf(last), gramOf(nxt.words[0]), "line") >= 8;
        if (!isShort && !joined) break;
        // A merge for shortness alone must not split a pair that belongs together at its new end
        // ("Anna | Smith", "The | 10 km"); a joined pair merges whatever its length.
        if (!joined) {
          const after = groups[i + 2];
          const tail = nxt.words[nxt.words.length - 1];
          if (after && after.kind === g.kind && !after.label && after.words[0].speaker === tail.speaker && !after.words[0].cue_start && breakPenalty(gramOf(tail), gramOf(after.words[0]), "line") >= 8) break;
        }
        g.notes.push({
          rule: "single_word",
          action: "merged",
          detail: isShort ? `"${last.text}" is under 8 frames, so it shows with "${nxt.words[0].text}"` : `"${last.text} ${nxt.words[0].text}" stay together`,
        });
        g.words = [...g.words, ...nxt.words];
        groups.splice(i + 1, 1);
      }
    }
  }

  // Hyphen style: two short turns by different speakers share a two-line caption.
  // A word limit applies to the pair as a whole, and a one-word-per-caption look has no pairs.
  if (speakerStyle === "hyphen" && maxLines >= 2 && !opts.single_word) {
    const maxCps = std?.max_cps ?? 21;
    const maxWpm = std?.max_wpm;
    for (let i = 0; i + 1 < groups.length; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      if (a.kind !== "speech" || b.kind !== "speech" || a.turns !== undefined) continue;
      const sa = a.words[0].speaker;
      const sb = b.words[0].speaker;
      if (sa === undefined || sb === undefined || sa === sb) continue;
      const ta = "- " + a.words.map((w) => w.text).join(" ");
      const tb = "- " + b.words.map((w) => w.text).join(" ");
      if (ta.length > maxChars || tb.length > maxChars) continue;
      if (opts.max_words && a.words.length + b.words.length > opts.max_words) continue;
      const span = b.words[b.words.length - 1].end - a.words[0].start;
      if (span > maxDur || b.words[0].start - a.words[a.words.length - 1].end > pause) continue;
      const hold = Math.max(span, minDur);
      if ((ta.length + 1 + tb.length) / hold > maxCps) continue;
      if (maxWpm && ((a.words.length + b.words.length) * 60) / hold > maxWpm) continue;
      groups.splice(i, 2, { words: [...a.words, ...b.words], kind: "speech", ...(a.label ? { label: a.label } : {}), turns: a.words.length, notes: [] });
    }
  }

  // ----- captions -----
  const speakerIds: string[] = [];
  const caps: WorkCap[] = groups.map((g) => {
    const first = g.words[0];
    const lastW = g.words[g.words.length - 1];
    const cap: WorkCap = {
      start: snap(first.start + offset),
      end: 0,
      lines: [],
      words: g.words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
      kind: g.kind,
      gram: g.words.map(gramOf),
      spk: g.words.map((w) => w.speaker),
      rawStart: first.start + offset,
      rawLastEnd: lastW.end + offset,
    };
    if (first.speaker !== undefined && g.kind !== "sound") cap.speaker = first.speaker;
    if (g.label) cap.label = g.label;
    if (g.turns !== undefined) {
      cap.turns = g.turns;
      cap.locked = true;
    }
    if (g.kind === "lyric") cap.italic = true;
    return cap;
  });

  // Whole frames, in order, every word at least a frame after the one before.
  for (const c of caps) {
    let t = c.start;
    for (const w of c.words) {
      w.start = Math.max(snap(w.start), t);
      w.end = Math.max(snap(w.end), w.start);
      t = w.start + (fps ? frame : 0);
    }
    c.lines = layout(c);
  }

  // ----- rules -----
  const cuts = [...new Set(rawCuts.map(snap))].sort((a, b) => a - b);
  const S: RuleSettings = {
    frame,
    snap,
    maxChars,
    maxLines,
    minDur,
    maxDur,
    linger,
    minGapT: minGapFrames * frame,
    closeUnder,
    cutZone,
    cuts,
    std,
    fix,
    maxWords: opts.max_words,
    singleWord: opts.single_word === true,
    layout,
  };
  const rec = new Rec();
  groups.forEach((g, i) => {
    for (const nt of g.notes) rec.add(caps[i], nt.rule, nt.action, nt.detail);
  });

  splitAtCuts(caps, S, rec);
  snapInTimes(caps, S, rec);
  settleEnds(caps, S);
  if (fix) {
    for (let pass = 0; pass < 4; pass++) {
      const before = caps.length;
      mergePass(caps, S, rec);
      splitPass(caps, S, rec);
      settleEnds(caps, S);
      if (caps.length === before) break;
    }
    snapInTimes(caps, S, rec);
    settleEnds(caps, S);
  }
  closeGaps(caps, S, rec);
  cutOutTimes(caps, S, rec);
  enforceGaps(caps, S, rec);
  for (const c of caps) {
    const lastStart = c.words[c.words.length - 1].start;
    if (c.end <= lastStart) c.end = snap(lastStart + frame);
  }
  recordExtensions(caps, S, rec);
  const violations = findViolations(caps, S);

  // ----- speakers, show_at -----
  for (const c of caps) {
    if (c.speaker !== undefined) {
      let idx = speakerIds.indexOf(c.speaker);
      if (idx < 0) idx = speakerIds.push(c.speaker) - 1;
      c.speaker_index = idx;
      if (speakerStyle === "color") {
        const palette: readonly string[] = opts.speaker_colors && opts.speaker_colors.length ? opts.speaker_colors : SPEAKER_COLORS;
        c.color = palette[idx % palette.length];
      }
    }
    let floor = c.start;
    for (const w of c.words) {
      const at = snap(Math.max(w.start - lead, floor));
      w.show_at = Math.min(at, w.start);
      floor = Math.max(floor, w.show_at);
    }
  }

  const changes: PlanChange[] = [];
  for (const it of rec.items) {
    const n = caps.indexOf(it.cap) + 1;
    if (n > 0) changes.push({ n, rule: it.rule, action: it.action, detail: it.detail });
  }
  changes.sort((a, b) => a.n - b.n);

  const captions: Caption[] = caps.map((c) => {
    const { gram: _g, spk: _s, label: _l, turns: _t, locked: _k, rawStart: _a, rawLastEnd: _b, ...pub } = c;
    return pub;
  });

  if (estimated) {
    warnings.push("Some word times are estimates (SRT and VTT carry line times only): the word highlight follows character share, not the voice. A JSON transcript with word times is exact.");
  }
  if (!std) {
    const fast = captions.filter((c) => c.lines.join(" ").length / Math.max(c.end - c.start, 0.001) > 21).length;
    if (fast) warnings.push(`${fast} caption${fast === 1 ? " is" : "s are"} faster than 21 characters per second; raise max_lines or max_chars_per_line, or lower max_duration.`);
  }
  const wide = captions.filter((c) => c.lines.some((l) => l.length > maxChars)).length;
  if (wide) warnings.push(`${wide} caption${wide === 1 ? " has" : "s have"} a single word longer than max_chars_per_line.`);
  return {
    captions,
    estimated_word_times: estimated,
    warnings,
    ...(std ? { standard: std.id } : {}),
    changes,
    violations,
    ...(cleanupReport ? { cleanup: cleanupReport } : {}),
  };
}
