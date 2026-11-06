/**
 * server/src/caption-plan-options.ts
 *
 * The planner options shared by ae_captions_plan, ae_captions, ae_captions_export
 * and ae_captions_qa: a standard preset, shot changes, transcript clean-up,
 * social chunking, speakers and SDH. The schemas live here so every tool takes
 * the same fields; buildCaptions (transcript.ts) does the work.
 */
import { z } from "zod";
import { CAPTION_STANDARD_IDS, type CaptionStandardId } from "./caption-standards.js";

export const CleanupSchema = z
  .object({
    drop_after_s: z.number().min(0).optional().describe("Drop words that start at or after this time (seconds, transcript time): ASR often invents words in trailing silence or music. Give the audio's end."),
    drop_music_tokens: z.boolean().optional().describe("Drop words that are only music notes (♪), the replacement character (�) or other symbol-only tokens. Default true."),
    min_word_s: z.number().min(0).max(0.5).optional().describe("Drop words shorter than this (seconds); ASR leaves near-zero spans where it guessed. Default 0.05; 0 keeps all."),
    remove_fillers: z.boolean().optional().describe("Remove filler words (um, uh, erm, er, ah, hmm, mm, mhm). Default false."),
    filler_words: z.array(z.string().min(1).max(30)).max(100).optional().describe("Your own filler list instead of the default."),
    remove_stutters: z.boolean().optional().describe("Collapse stutters and repeats ('I- I', 'the the') into one word. Default false."),
    glossary: z
      .array(z.object({ find: z.string().min(1).max(100), replace: z.string().max(100), case_sensitive: z.boolean().optional() }))
      .max(500)
      .optional()
      .describe("Whole-word find and replace, in order (brand names, spellings ASR gets wrong). A phrase may span words."),
    case: z.enum(["as_is", "upper", "sentence"]).optional().describe("Case of the caption text. Default as_is."),
    strip_punctuation: z.boolean().optional().describe("Remove punctuation from the caption text (apostrophes inside words stay). Sentence ends are still used for grouping. Default false."),
  })
  .describe("Transcript clean-up before captions are made. The result's `cleanup` counts what changed.");

export const TimeRangeSchema = z.object({ start: z.number().min(0), end: z.number().min(0) }).refine((r) => r.end > r.start, { message: "end must be after start" });

export const SdhSchema = z
  .object({
    sound_events: z.boolean().optional().describe("Keep sound events (ElevenLabs audio_event entries, or words in square brackets) as their own captions in [lower-case brackets]. Default true."),
    lyric_ranges: z.array(TimeRangeSchema).max(200).optional().describe("Sung passages (transcript time): their captions are marked lyric (italic, wrapped in ♪)."),
  })
  .describe("Subtitles for the deaf and hard of hearing: sound events and lyrics.");

export const PlanOptionFields = {
  standard: z
    .enum(CAPTION_STANDARD_IDS)
    .optional()
    .describe(
      "A caption standard: netflix_adult (20 cps, 42 cpl, 2 lines, 5/6 s to 7 s, 2-frame gaps), netflix_kids (17 cps), bbc (180 wpm, 0.33 s per word, 37 cpl), dcmp (32 cpl, 40 frames to 6 s), social_9x16 (25 cpl, 3 lines). " +
        "Sets the defaults for line length, lines, durations, gaps and linger (explicit fields still win) and turns on fixing: out-times extend into the gap, then short captions merge, then long ones split. The result lists every change and any violation left."
    ),
  fix: z.boolean().optional().describe("With a standard: fix what breaks it (default true). false only reports violations."),
  min_gap_frames: z.number().int().min(0).max(12).optional().describe("Frames between captions at least. Default 2 with a standard, else 0."),
  close_gaps_under: z.number().min(0).max(2).optional().describe("Seconds: a gap shorter than this (and longer than the minimum) closes to min_gap_frames. Default the standard's (0.5 s), else off."),
  cut_times: z
    .array(z.number().min(0))
    .max(5000)
    .optional()
    .describe("Shot changes, seconds in comp time (ae_detect_cuts mode list gives them). Captions don't straddle a cut: an in-time moves onto the cut or at least 0.5 s before it, an out-time to 2 frames before it or at least 0.5 s after."),
  cleanup: CleanupSchema.optional(),
  max_words: z.number().int().min(1).max(30).optional().describe("Words per caption at most (social chunking)."),
  single_word: z.boolean().optional().describe("One word per caption (social style): a word shorter than 8 frames merges into the next, and a number with its unit or a first name with a surname stays together."),
  highlight_lead_frames: z.number().int().min(0).max(6).optional().describe("The highlighted word switches this many frames before the voice (reads as in sync). Default 1."),
  speaker_style: z
    .enum(["none", "color", "hyphen", "label"])
    .optional()
    .describe("How a speaker change shows: color (BBC order white, yellow, cyan, green per speaker), hyphen (two speakers in one caption, each line starting '- '), label ('NAME: ' at each change). Default none."),
  speaker_colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(16).optional().describe("Colours per speaker in order of first appearance instead of the BBC order."),
  speaker_names: z.record(z.string().max(60)).optional().describe("Display names for speaker ids (e.g. {\"speaker_0\": \"ANNA\"}), for labels."),
  accessibility: z.boolean().optional().describe("Never use colour as the only cue: with speaker_style color, a label is added at each speaker change too. Default false."),
  sdh: SdhSchema.optional(),
};

export const PlanOptionsSchema = z.object(PlanOptionFields);
export type PlanOptions = z.infer<typeof PlanOptionsSchema>;

/** The planner fields of a tool call's arguments (drops everything else). */
export function pickPlanOptions(args: Record<string, unknown>): PlanOptions {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(PlanOptionFields)) if (args[k] !== undefined) out[k] = args[k];
  return out as PlanOptions;
}

/** What the planner changed to meet the standard (or the clean-up / snapping rules). */
export interface PlanChange {
  /** 1-based caption number in the final plan (after merges and splits). */
  n: number;
  rule: "min_duration" | "max_duration" | "cps" | "cpl" | "lines" | "gap" | "close_gap" | "shot_change" | "linger" | "single_word" | "max_words" | "overlap";
  action: "extended" | "shortened" | "merged" | "split" | "moved_in" | "moved_out" | "closed_gap" | "opened_gap" | "merged_over_max_words";
  detail: string;
}

/** A rule still broken after fixing (or with fix: false). */
export interface PlanViolation {
  n: number;
  rule: PlanChange["rule"] | "grammar";
  detail: string;
}

export interface CleanupReport {
  dropped_after_end: number;
  dropped_music_tokens: number;
  dropped_short: number;
  fillers_removed: number;
  stutters_removed: number;
  glossary_replacements: number;
}

export type CaptionKind = "speech" | "sound" | "lyric";

export type { CaptionStandardId };
