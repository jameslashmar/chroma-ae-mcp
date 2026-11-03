/**
 * server/src/tools/ext/markers.ts
 *
 * Marker tools:
 * - ae_get_markers: a comp's or a layer's markers (read-only)
 * - ae_add_markers: many markers in one undo group, from a list or from a
 *   transcript (SRT, VTT, ElevenLabs or Whisper JSON): VO to markers, one per
 *   segment, sentence or word, a label colour per speaker
 * - ae_remove_markers: all, a time range, a comment match, or indexes
 *
 * Both writes have a dry run that touches nothing in AE.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { parseTranscript, detectFormat, transcriptCues, TranscriptError, type MarkerCue } from "../../transcript.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

export const MAX_MARKERS_PER_CALL = 500;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
/** Marker times read back within this of what was written count as the same. */
const TIME_TOLERANCE = 0.0015;
/** Placed times closer than this are surely one key (float noise); further apart AE may keep two. */
const SAME_KEY = 1e-6;
/** The host's listMarkers cuts strings at this length and adds the suffix (clip in markers.jsx). */
const READ_CLIP = 2000;
const READ_CLIP_SUFFIX = " ...[truncated]";

// ---------- schemas ----------

export const MarkerInputSchema = z.object({
  time: z.number().min(0).describe("Seconds, in comp time (or the layer's own time with relative_to 'layer')."),
  comment: z.string().max(5000).optional(),
  duration: z
    .number()
    .min(0)
    .optional()
    .describe("Marker length in seconds. With relative_to 'layer' it is scaled by the layer's stretch, like the time."),
  label: z.number().int().min(0).max(16).optional().describe("Label colour 0..16 (0 none)."),
  chapter: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
});

export const TranscriptInputSchema = z
  .object({
    path: z.string().min(1).optional().describe("Absolute path of a .srt, .vtt or .json transcript."),
    text: z.string().max(MAX_TRANSCRIPT_BYTES).optional().describe("The transcript itself, instead of a path."),
    format: z.enum(["srt", "vtt", "json"]).optional().describe("Default: from the file extension or the content."),
    unit: z.enum(["segment", "sentence", "word"]).optional().describe("One marker per segment (default), sentence or word."),
    speaker_labels: z.boolean().optional().describe("A label colour per speaker. Default true."),
    offset: z.number().finite().optional().describe("Seconds added to every transcript time. A cue must not end up before 0."),
  })
  .refine((t) => (t.path === undefined) !== (t.text === undefined), { message: "Give the transcript's path or its text, not both." });

const TargetFields = {
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.optional().describe("Markers on this layer. Default: the comp's own markers."),
};

export const AeGetMarkersSchema = z.object(TargetFields);

export const AeAddMarkersSchema = z
  .object({
    ...TargetFields,
    markers: z.array(MarkerInputSchema).min(1).max(MAX_MARKERS_PER_CALL).optional(),
    transcript: TranscriptInputSchema.optional(),
    relative_to: z
      .enum(["comp", "layer"])
      .optional()
      .describe("'layer': times are in the layer's own time (startTime and stretch applied; time remapping is not). Default 'layer' for a transcript on a layer, else 'comp'."),
    dry_run: z.boolean().optional().describe("Return the markers that would be added without touching AE."),
    expect: ExpectSchema.optional().describe((ExpectSchema.description ?? "") + " Required unless dry_run."),
  })
  .refine((v) => (v.markers === undefined) !== (v.transcript === undefined), { message: "Give markers or a transcript." })
  .refine((v) => v.relative_to !== "layer" || v.layer !== undefined, { message: "relative_to 'layer' needs a layer." })
  .refine((v) => v.dry_run === true || v.expect !== undefined, { message: "Adding needs expect; pass dry_run to only preview." });

export const AeRemoveMarkersSchema = z
  .object({
    ...TargetFields,
    all: z.boolean().optional(),
    start: z.number().optional().describe("Remove markers at or after this time (comp seconds)."),
    end: z.number().optional().describe("Remove markers at or before this time."),
    comment_contains: z.string().min(1).optional().describe("Case-insensitive; combined with start/end when given."),
    indexes: z.array(z.number().int().positive()).max(MAX_MARKERS_PER_CALL).optional().describe("1-based marker indexes."),
    dry_run: z.boolean().optional().describe("List the markers that would go without touching AE."),
    expect: ExpectSchema.optional().describe((ExpectSchema.description ?? "") + " Required unless dry_run."),
  })
  .refine((v) => v.dry_run === true || v.expect !== undefined, { message: "Removing needs expect; pass dry_run to only preview." })
  .refine((v) => v.all === true || v.start !== undefined || v.end !== undefined || v.comment_contains !== undefined || (v.indexes?.length ?? 0) > 0, {
    message: "Say which markers: all, start/end, comment_contains, or indexes.",
  });

// ---------- read-back ----------

export interface MarkerEntry {
  index: number;
  time: number;
  duration: number;
  comment: string;
  label?: number;
  chapter?: string;
  url?: string;
}

export interface MarkerList {
  target: "comp" | "layer";
  numMarkers: number;
  markers: MarkerEntry[];
  truncated: boolean;
  layer?: { index: number; id: number; name: string; startTime: number; stretch: number };
}

const listOf = (v: unknown): MarkerList | null => (v && typeof v === "object" ? (v as MarkerList) : null);
const near = (a: number, b: number) => Math.abs(a - b) <= TIME_TOLERANCE;

/** Turns a transcript argument into marker cues. Throws TranscriptError with a readable message. */
export function cuesFromTranscript(t: z.infer<typeof TranscriptInputSchema>): MarkerCue[] {
  let text = t.text;
  if (t.path !== undefined) {
    if (!path.isAbsolute(t.path)) throw new TranscriptError(`Transcript path must be absolute: ${t.path}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(t.path);
    } catch {
      throw new TranscriptError(`No transcript at ${t.path}`);
    }
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new TranscriptError(`Transcript is over 5 MB: ${t.path}`);
    text = fs.readFileSync(t.path, "utf8").replace(/^﻿/, "");
  }
  const segments = parseTranscript(text ?? "", t.format ?? detectFormat(text ?? "", t.path));
  return transcriptCues(segments, { unit: t.unit, speaker_labels: t.speaker_labels, offset: t.offset });
}

/** A string as listMarkers returns it (cut at READ_CLIP, once). */
function asReadBack(str: string): string {
  if (str.length <= READ_CLIP) return str;
  if (str.length === READ_CLIP + READ_CLIP_SUFFIX.length && str.endsWith(READ_CLIP_SUFFIX)) return str;
  return str.slice(0, READ_CLIP) + READ_CLIP_SUFFIX;
}

interface PlacedMarker {
  time: number;
  comment: string;
  duration?: number;
  label?: number;
  label_failed?: boolean;
  chapter?: string;
  url?: string;
}

export function addMarkersMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = listOf(beforeRaw);
  const after = listOf(afterRaw);
  const placed = (written.placed as PlacedMarker[] | undefined) ?? [];
  if (!before || !after) return m;
  // AE's rule for when two close times stay two markers isn't known, so the count may
  // fall anywhere between "close times merge" (loose) and "every distinct time is a key" (strict).
  const countFresh = (same: (a: number, b: number) => boolean) => {
    const fresh: number[] = [];
    for (const p of placed) {
      if (before.markers.some((b) => same(b.time, p.time))) continue;
      if (fresh.some((t) => same(t, p.time))) continue;
      fresh.push(p.time);
    }
    return fresh.length;
  };
  if (!before.truncated) {
    const lo = before.numMarkers + countFresh(near);
    const hi = before.numMarkers + countFresh((a, b) => Math.abs(a - b) <= SAME_KEY);
    expectThat(m, after.numMarkers >= lo && after.numMarkers <= hi, "numMarkers", lo === hi ? lo : `${lo}..${hi}`, after.numMarkers, "Marker count is not what adding should give");
  }
  if (after.truncated) return m;
  // The last write at a time wins, so check each time against its last entry.
  const lastAt = new Map<number, PlacedMarker>();
  for (const p of placed) {
    const key = [...lastAt.keys()].find((t) => Math.abs(t - p.time) <= SAME_KEY) ?? p.time;
    lastAt.set(key, p);
  }
  const nearest = (time: number) => {
    let best: MarkerEntry | undefined;
    for (const x of after.markers) {
      if (near(x.time, time) && (!best || Math.abs(x.time - time) < Math.abs(best.time - time))) best = x;
    }
    return best;
  };
  const found = [...lastAt].map(([time, p]) => ({ time, p, got: nearest(time) }));
  const rawFrame = written.frame_duration;
  const frame = typeof rawFrame === "number" && rawFrame > 0 ? rawFrame : 0;
  const durTol = Math.max(TIME_TOLERANCE, frame / 2) + 1e-9;
  for (const { time, p, got } of found) {
    if (!got) {
      m.push({ path: `markers@${time}`, expected: p.comment, actual: undefined, message: `No marker at ${time}s` });
      continue;
    }
    // Two close times that AE kept as one marker: the marker holds the later write's values.
    const merged = found.filter((f) => f.got === got);
    if (merged.length > 1) {
      if (merged[0].time !== time) continue;
      const ok = merged.some((f) => asReadBack(f.p.comment) === got.comment);
      expectThat(m, ok, `markers@${time}.comment`, asReadBack(p.comment), got.comment, `Marker at ${time}s has another comment`);
      continue;
    }
    const want = asReadBack(p.comment);
    expectThat(m, got.comment === want, `markers@${time}.comment`, want, got.comment, `Marker at ${time}s has another comment`);
    if (p.label_failed) m.push({ path: `markers@${time}.label`, expected: p.label, actual: got.label, message: `AE refused the label at ${time}s` });
    else if (p.label !== undefined && got.label !== undefined) {
      expectThat(m, got.label === p.label, `markers@${time}.label`, p.label, got.label, `Marker at ${time}s has another label colour`);
    }
    if (p.duration !== undefined) {
      expectThat(m, Math.abs((got.duration ?? 0) - p.duration) <= durTol, `markers@${time}.duration`, p.duration, got.duration, `Marker at ${time}s has another duration`);
    }
    if (p.chapter) expectThat(m, got.chapter === p.chapter, `markers@${time}.chapter`, p.chapter, got.chapter, `Marker at ${time}s has another chapter`);
    if (p.url) expectThat(m, got.url === p.url, `markers@${time}.url`, p.url, got.url, `Marker at ${time}s has another URL`);
  }
  return m;
}

export function removeMarkersMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = listOf(beforeRaw);
  const after = listOf(afterRaw);
  const removed = (written.removed as MarkerEntry[] | undefined) ?? [];
  if (!before || !after) return m;
  // `removed` holds at most 500 entries; removed_count is how many went in all.
  const count = typeof written.removed_count === "number" ? written.removed_count : removed.length;
  const want = before.numMarkers - count;
  expectThat(m, after.numMarkers === want, "numMarkers", want, after.numMarkers, "Marker count did not drop by the number removed");
  for (const r of removed) {
    if (after.markers.some((x) => near(x.time, r.time) && x.comment === r.comment)) {
      m.push({ path: `markers@${r.time}`, expected: "removed", actual: r.comment, message: `Marker at ${r.time}s is still there` });
    }
  }
  return m;
}

/** Requested 1-based indexes past the last marker. */
function unmatchedIndexes(indexes: number[] | undefined, numMarkers: number | undefined): number[] {
  if (numMarkers === undefined) return [];
  return (indexes ?? []).filter((i) => i > numMarkers);
}

/** What ae_remove_markers would take out of a list, for the dry run (mirrors removeMarkers in markers.jsx). */
export function selectForRemoval(list: MarkerEntry[], args: z.infer<typeof AeRemoveMarkersSchema>): MarkerEntry[] {
  const needle = args.comment_contains?.toLowerCase();
  const inRange = (t: number) => (args.start === undefined || t >= args.start - 0.0005) && (args.end === undefined || t <= args.end + 0.0005);
  return list.filter((x) => {
    if (args.all) return true;
    if (args.indexes?.includes(x.index)) return true;
    if (needle !== undefined) return inRange(x.time) && x.comment.toLowerCase().includes(needle);
    if (args.start !== undefined || args.end !== undefined) return inRange(x.time);
    return false;
  });
}

// ---------- tools ----------

const listRead = (compId: number, layer: unknown) => ({ host: "listMarkers", args: layer ? { comp_id: compId, layer } : { comp_id: compId } });

export const markersTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_markers",
    description:
      "List a comp's markers, or a layer's (time, duration, comment, label colour, chapter, URL). Read-only; at most 500, with truncated: true beyond.",
    schema: AeGetMarkersSchema,
    handler: async (args: z.infer<typeof AeGetMarkersSchema>, ctx) => {
      const res = await ctx.bridge.callHost("listMarkers", args.layer ? { comp_id: args.comp_id, layer: args.layer } : { comp_id: args.comp_id }, {
        label: "ae_get_markers",
        mutates: false,
        toolName: "ae_get_markers",
      });
      return res.result;
    },
  },
  {
    name: "ae_add_markers",
    description:
      "Add markers to a comp or a layer in one undo group guarded by `expect`: from a list (time, comment, duration, label colour, chapter, URL), " +
      "or from a transcript (VO to markers): SRT, WebVTT, ElevenLabs speech-to-text JSON (`words`), Whisper-style JSON (`segments`), one marker per segment, sentence or word, " +
      "with the text as the comment, the spoken length as the duration and a label colour per speaker. Transcript times are taken as the layer's own time when a layer is given. " +
      "The beats and onsets from ae_audio_analyze go in as a list. A marker at a time that already has one replaces it, as in AE. " +
      "dry_run returns the markers without touching AE. The read-back (a separate evalScript) checks the count and each marker's comment, label colour, duration, chapter and URL. " +
      "With relative_to 'layer' the duration is scaled by the layer's stretch, like the time. expect is required unless dry_run. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAddMarkersSchema,
    handler: async (args: z.infer<typeof AeAddMarkersSchema>, ctx) => {
      let cues: Array<z.infer<typeof MarkerInputSchema>>;
      try {
        cues = args.markers ?? cuesFromTranscript(args.transcript!).map(({ speaker, ...c }) => c);
      } catch (err) {
        if (err instanceof TranscriptError) return { ok: false, error: "bad_transcript", message: err.message };
        throw err;
      }
      // Transcript cues skip MarkerInputSchema, so a negative offset can put a cue before 0.
      const early = cues.findIndex((c) => !(c.time >= 0));
      if (early >= 0) {
        const count = cues.filter((c) => !(c.time >= 0)).length;
        return {
          ok: false,
          error: "bad_args",
          message: `${count} of ${cues.length} markers would land before 0s (the first at ${cues[early].time}s). Use a smaller negative offset or trim the transcript; nothing was added.`,
        };
      }
      if (cues.length > MAX_MARKERS_PER_CALL) {
        return {
          ok: false,
          error: "too_many",
          message: `${cues.length} markers; at most ${MAX_MARKERS_PER_CALL} per call. Use unit 'segment' or 'sentence', or split the transcript.`,
        };
      }
      const relativeTo = args.relative_to ?? (args.transcript && args.layer ? "layer" : "comp");
      if (args.dry_run) {
        return { ok: true, dry_run: true, target: args.layer ? "layer" : "comp", relative_to: relativeTo, count: cues.length, markers: cues };
      }
      return runGuardedWrite(ctx, {
        toolName: "ae_add_markers",
        label: `ae_add_markers(${cues.length})`,
        expect: args.expect!,
        compId: args.comp_id,
        read: () => listRead(args.comp_id, args.layer),
        write: {
          host: "addMarkers",
          args: { comp_id: args.comp_id, layer: args.layer, markers: cues, relative_to: relativeTo, label: `Add ${cues.length} markers` },
        },
        check: addMarkersMismatches,
        present: (_before, after, w) => ({
          target: w.target,
          relative_to: relativeTo,
          added: ((w.placed as unknown[]) ?? []).length,
          replaced: w.replaced,
          numMarkers: listOf(after)?.numMarkers,
        }),
      });
    },
  },
  {
    name: "ae_remove_markers",
    description:
      "Remove a comp's or a layer's markers in one undo group guarded by `expect`: all, those in a time range, those whose comment contains a text (within the range if given), or by index. " +
      "dry_run lists what would go without touching AE. The read-back (a separate evalScript) checks the count and that the removed markers are gone. " +
      "`removed` lists at most 500 (removed_count has the total); indexes that match no marker come back as unmatched_indexes. expect is required unless dry_run. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRemoveMarkersSchema,
    handler: async (args: z.infer<typeof AeRemoveMarkersSchema>, ctx) => {
      if (args.dry_run) {
        const res = await ctx.bridge.callHost<MarkerList>("listMarkers", args.layer ? { comp_id: args.comp_id, layer: args.layer } : { comp_id: args.comp_id }, {
          label: "ae_remove_markers (dry run)",
          mutates: false,
          toolName: "ae_remove_markers",
        });
        const would = selectForRemoval(res.result.markers, args);
        const unmatched = unmatchedIndexes(args.indexes, res.result.numMarkers);
        if (!res.result.truncated) {
          return {
            ok: true,
            dry_run: true,
            count: would.length,
            markers: would,
            truncated: false,
            ...(unmatched.length ? { unmatched_indexes: unmatched } : {}),
          };
        }
        // Only the first markers can be listed. Requested indexes past them still go, and all,
        // a range or a comment match can take more than the list shows: say so instead of a short count.
        const listed = res.result.markers.length;
        const beyond = (args.indexes ?? []).filter((i) => i > listed && i <= res.result.numMarkers);
        const exact = !args.all && args.start === undefined && args.end === undefined && args.comment_contains === undefined;
        return {
          ok: true,
          dry_run: true,
          ...(exact ? { count: would.length + beyond.length } : { count_at_least: would.length + beyond.length }),
          markers: would,
          ...(beyond.length ? { beyond_list: beyond } : {}),
          truncated: true,
          note: `Only the first ${listed} of ${res.result.numMarkers} markers can be previewed; markers past them that match are removed too.`,
          ...(unmatched.length ? { unmatched_indexes: unmatched } : {}),
        };
      }
      return runGuardedWrite(ctx, {
        toolName: "ae_remove_markers",
        label: "ae_remove_markers",
        expect: args.expect!,
        compId: args.comp_id,
        read: () => listRead(args.comp_id, args.layer),
        write: {
          host: "removeMarkers",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            all: args.all,
            start: args.start,
            end: args.end,
            comment_contains: args.comment_contains,
            indexes: args.indexes,
            label: "Remove markers",
          },
        },
        check: removeMarkersMismatches,
        present: (before, after, w) => {
          const unmatched = unmatchedIndexes(args.indexes, listOf(before)?.numMarkers);
          const count = typeof w.removed_count === "number" ? w.removed_count : ((w.removed as unknown[]) ?? []).length;
          return {
            target: w.target,
            removed: w.removed,
            removed_count: count,
            removed_truncated: w.removed_truncated === true,
            numMarkers: listOf(after)?.numMarkers,
            ...(unmatched.length ? { unmatched_indexes: unmatched } : {}),
            ...(count === 0 ? { warning: "No marker matched; nothing was removed." } : {}),
          };
        },
      });
    },
  },
];
