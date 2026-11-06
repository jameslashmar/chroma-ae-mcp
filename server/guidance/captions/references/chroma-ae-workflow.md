# Doing it with the chroma-ae MCP tools

Tool names are exact. Read each tool's own description for its full input shape; this page
says when to use which.

| Tool | Does |
|---|---|
| `ae_transcribe` | ElevenLabs Scribe word-level transcript of a comp's audio (rendered in the background) or an audio/video file. Uploads client audio to a third-party US service: ask first, then `confirm_upload: true`. Returns `transcript_path` and `offset` for the planner |
| `ae_captions_plan` | chunks, breaks and times words against a standard; returns the plan, the `changes` and the `violations`. Writes nothing |
| `ae_detect_cuts` | finds shot changes; `mode: "list"` returns the cut times for `cut_times` |
| `ae_captions` | writes captions to the comp (guarded, one undo step) |
| `ae_captions_read` | reads existing captions back: text, timing, extents against the safe area |
| `ae_captions_qa` | lints an SRT/VTT file, a plan or the caption layers against a standard |
| `ae_captions_export` | writes an SRT, VTT or TTML sidecar, by default next to the project |
| `ae_export_mogrt` | exports a template comp (from `ae_captions` `make_template`) as a .mogrt for Premiere |

## ae_captions_plan options (ae_captions takes the same)

| Option | Values and use |
|---|---|
| `standard` | `netflix_adult`, `netflix_kids`, `bbc`, `dcmp`, `social_9x16`: sets the limits and turns on fixing |
| `fix` | default true with a standard: extend, then merge, then split; `false` only reports |
| `min_gap_frames`, `close_gaps_under` | gap rules (default 2 frames; gaps under 0.5 s close to 2 frames) |
| `cut_times` | shot changes from `ae_detect_cuts` (comp seconds); in/out times respect them |
| `cleanup` | `drop_after_s`, `drop_music_tokens`, `min_word_s`, `remove_fillers`, `remove_stutters`, `glossary`, `case`, `strip_punctuation` |
| `max_words` | cap on words per caption (phrase chunks) |
| `single_word` | one word at a time (hooks only); short words merge, names and numbers stay whole |
| `highlight_lead_frames` | how many frames early a word highlight starts (default 1) |
| `speaker_style` | `color` (BBC order), `hyphen` (two speakers, one caption), `label` (`NAME: `); `speaker_names`, `speaker_colors` |
| `accessibility` | never colour alone: adds a label at each speaker change when `speaker_style` is `color` |
| `sdh` | `sound_events` (default on: `[laughter]` captions from ElevenLabs audio events), `lyric_ranges` (italic, music notes) |
| `transcript.offset` | the `offset` that `ae_transcribe` returns |

## ae_captions modes

| `mode` | Result | Use for |
|---|---|---|
| `layers` | one text layer per caption | most work; easy to edit and animate per caption |
| `single` | one text layer whose text changes over time | clean timeline, simple styles |
| `words` | one layer per word, laid out as the caption; words build on as spoken | per-word animation |
| `template` | one instance per caption of an Essential Graphics template comp, its fields (e.g. "Line 1", "Line 2") filled | brand-styled designs |

Other options: `platform` (`reels_9_16` = safe on all three apps, the 9:16 default; `tiktok_9_16`,
`instagram_reels_9_16`, `youtube_shorts_9_16`), `parent_to_null` (one null moves the whole set),
`precompose`, `match: "time"` (update existing captions by time instead of by name), `highlight`
(the current word), `look` (`pop`, `pill_slide`, `fill_sweep`, with `look_options`), `box` (the
backing box; 60% opacity or more), and `make_template` (a styled caption comp with Essential
Graphics controllers, then `ae_save` and `ae_export_mogrt` for Premiere).

## Recommended workflow

1. `ae_transcribe` (after asking) or take the client's SRT.
2. Read the transcript; fix the problems in `asr.md`.
3. `ae_detect_cuts` with `mode: list` to get `cut_times`.
4. `ae_captions_plan` with a standard, `cut_times`, `cleanup`, and the chunking options.
5. Read the changes and the violations. Decide the rewordings a human has to make.
6. `ae_captions` to write (layers, single, words or template), with the platform zone and box.
7. `ae_captions_read` to confirm what is in the comp, then `ae_captions_qa` against the standard.
8. `ae_captions_export` for the SRT or VTT sidecar.
9. Look at frames: `ae_contact_sheet` or `ae_snapshot_frame` at the first caption, the busiest,
   a cut, and the last. Check at phone width.

## Other tools

- Remotion: `@remotion/captions` defines a `Caption` type and parsers; `createTikTokStyleCaptions`
  groups words into pages that switch on a time window (a combine-tokens-within-milliseconds
  setting controls chunk size). See the [Remotion captions docs](https://www.remotion.dev/docs/captions)
  and the `remotion-captions` skill. It does not enforce a broadcast standard; run the numbers
  from this skill over its output.
- HyperFrames ([heygen-com/hyperframes](https://github.com/heygen-com/hyperframes), Apache-2.0)
  has a `transcribe` command that writes word timings (and `--to srt` or `--to vtt` sidecars) and a
  caption-style registry. Its default model translates non-English speech to English; pass the
  model and language explicitly (`asr.md`).
