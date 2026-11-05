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
      const speaker = o.speaker ?? o.speaker_id;
      return [
        {
          text: String(o.text ?? "").trim(),
          start,
          end,
          ...(speaker !== undefined && speaker !== null ? { speaker: String(speaker) } : {}),
          ...(words && words.length ? { words } : {}),
        },
      ];
    });
  }
  if (Array.isArray(obj?.words)) return segmentWords(wordsFrom(obj.words as unknown[]));
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
}

export interface Caption {
  /** Seconds on the timeline (offset applied, frame-rounded when a frame rate was given). */
  start: number;
  end: number;
  /** The words in order, one line per entry. Joined with spaces they are `words`. */
  lines: string[];
  words: CaptionWord[];
  speaker?: string;
}

export interface CaptionOptions {
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
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

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

/**
 * Breaks words into the fewest lines of at most `maxChars` characters, with the lines as even as
 * possible (a two-line caption is split near the middle, not greedily). Character counts only:
 * Node can't measure glyphs, so a proportional font can still run wider than the count suggests.
 */
export function breakLines(words: string[], maxChars: number): string[] {
  if (!words.length) return [];
  const lens = words.map((w) => w.length);
  const n = greedyLineCount(lens, maxChars);
  if (n <= 1) return [words.join(" ")];
  const lineLen = (i: number, j: number) => lens.slice(i, j).reduce((a, b) => a + b, 0) + (j - i - 1);
  const cost = (i: number, j: number) => {
    const len = lineLen(i, j);
    if (len > maxChars) return j - i === 1 ? (len - maxChars) ** 2 : Infinity;
    return (maxChars - len) ** 2;
  };
  // best[k][j]: cheapest way to set the first j words in k lines.
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(words.length + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let j = k; j <= words.length; j++) {
      for (let i = k - 1; i < j; i++) {
        const c = best[k - 1][i] + cost(i, j);
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

const snap = (t: number, fps?: number) => (fps ? Math.round(t * fps) / fps : round3(t));

/**
 * Transcript segments to captions: words are grouped at a speaker change, a pause, a sentence end
 * once the caption has some length, or when the line, line-count or duration limits would be
 * broken; each caption is line-broken, held for its minimum length (up to the next caption) and
 * rounded to whole frames without overlapping the next. Pure: nothing here touches AE.
 */
export function buildCaptions(segments: TranscriptSegment[], opts: CaptionOptions = {}): CaptionPlan {
  const maxChars = opts.max_chars_per_line ?? 32;
  const maxLines = opts.max_lines ?? 2;
  const minDur = opts.min_duration ?? 1;
  const maxDur = opts.max_duration ?? 6;
  const linger = opts.linger ?? 0.25;
  const pause = opts.pause_break ?? 0.7;
  const offset = opts.offset ?? 0;
  const fps = opts.frame_rate;
  const frame = fps ? 1 / fps : 0.001;
  const warnings: string[] = [];
  let estimated = false;

  // A subtitle cue (SRT, VTT: no word times) is already a caption, so a new caption starts at each one.
  const all: TranscriptWord[] = [];
  const cueStarts = new Set<TranscriptWord>();
  for (const seg of segments) {
    const t = timedWords(seg);
    if (t.estimated && t.words.length) {
      estimated = true;
      cueStarts.add(t.words[0]);
    }
    all.push(...t.words);
  }
  if (!all.length) throw new TranscriptError("The transcript has no words to caption");

  const groups: TranscriptWord[][] = [];
  let cur: TranscriptWord[] = [];
  const chars = (ws: TranscriptWord[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);
  for (const w of all) {
    const prev = cur[cur.length - 1];
    let split = false;
    if (prev) {
      const next = [...cur, w];
      if (w.speaker !== prev.speaker || cueStarts.has(w)) split = true;
      else if (w.start - prev.end > pause) split = true;
      else if (w.end - cur[0].start > maxDur) split = true;
      else if (greedyLineCount(next.map((x) => x.text.length), maxChars) > maxLines) split = true;
      else if (SENTENCE_END.test(prev.text) && chars(cur) >= maxChars * 0.4) split = true;
    }
    if (split) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const captions: Caption[] = groups.map((g, i) => {
    const nextStart = i + 1 < groups.length ? groups[i + 1][0].start : Infinity;
    const lastEnd = g[g.length - 1].end;
    // Held a little past the last word and for the minimum length, never into the next caption.
    let end = Math.max(lastEnd + linger, g[0].start + minDur);
    end = Math.min(end, nextStart);
    if (end < lastEnd) end = Math.min(lastEnd, nextStart);
    const cap: Caption = {
      start: g[0].start + offset,
      end: end + offset,
      lines: breakLines(
        g.map((w) => w.text),
        maxChars
      ),
      words: g.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
    };
    if (g[0].speaker !== undefined) cap.speaker = g[0].speaker;
    return cap;
  });

  // Whole frames, in order, never overlapping, every word at least a frame after the one before.
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    c.start = snap(c.start, fps);
    c.end = snap(c.end, fps);
    if (i > 0 && c.start < captions[i - 1].end) captions[i - 1].end = Math.max(captions[i - 1].start + frame, c.start);
    if (c.end < c.start + frame) c.end = snap(c.start + frame, fps);
    let t = c.start;
    for (const w of c.words) {
      w.start = Math.max(snap(w.start, fps), t);
      w.end = Math.max(snap(w.end, fps), w.start);
      t = w.start + (fps ? frame : 0);
    }
    const lastStart = c.words[c.words.length - 1].start;
    if (c.end <= lastStart) c.end = snap(lastStart + frame, fps);
  }
  for (let i = 0; i + 1 < captions.length; i++) {
    if (captions[i].end > captions[i + 1].start) captions[i].end = Math.max(captions[i].start + frame, captions[i + 1].start);
  }

  if (estimated) {
    warnings.push("Some word times are estimates (SRT and VTT carry line times only): the word highlight follows character share, not the voice. A JSON transcript with word times is exact.");
  }
  const fast = captions.filter((c) => c.lines.join(" ").length / Math.max(c.end - c.start, 0.001) > 21).length;
  if (fast) warnings.push(`${fast} caption${fast === 1 ? " is" : "s are"} faster than 21 characters per second; raise max_lines or max_chars_per_line, or lower max_duration.`);
  const wide = captions.filter((c) => c.lines.some((l) => l.length > maxChars)).length;
  if (wide) warnings.push(`${wide} caption${wide === 1 ? " has" : "s have"} a single word longer than max_chars_per_line.`);
  return { captions, estimated_word_times: estimated, warnings };
}
