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

function parseCueBlocks(text: string, isVtt: boolean): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
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
    let textOut = body;
    // VTT voice spans "<v Name>" were stripped above; read them from the raw block.
    const voice = isVtt ? /<v(?:\.[^ >]+)?\s+([^>]+)>/.exec(lines.slice(arrow + 1).join("\n")) : null;
    if (voice) speaker = voice[1].trim();
    else {
      // "NAME: text" speaker prefixes, common in SRT exports.
      const m = /^([A-Z][\w .'-]{0,30}):\s+(.+)$/s.exec(body);
      if (m) {
        speaker = m[1].trim();
        textOut = m[2].trim();
      }
    }
    out.push({ text: textOut, start: parseTimecode(a), end: parseTimecode(b), ...(speaker ? { speaker } : {}) });
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
