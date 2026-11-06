---
name: captions
description: Make, check and ship captions and subtitles that meet a published standard: transcribe, chunk, time, break lines, style, QA and export. Use for captions, subtitles, SDH, closed captions, open captions, burn-in, SRT, VTT, WebVTT, TTML, IMSC, SCC, karaoke captions, word highlight, kinetic captions, social captions, TikTok / Reels / Shorts captions, transcript, transcribe, Whisper, ElevenLabs Scribe, reading speed, cps, line breaks, caption QA, safe zone, Netflix / BBC / DCMP / Ofcom standards, accessibility and WCAG, in After Effects (chroma-ae MCP), Premiere, Remotion, HyperFrames or any other tool. Trigger phrases: 'add captions', 'subtitle this', 'caption this reel', 'burn in subtitles', 'make an SRT', 'check these captions', 'too fast to read', 'TikTok captions', 'word by word captions', 'accessible captions'.
metadata:
  version: "1.0.0"
  sources: see NOTICE.md
---

# Captions

One skill for turning speech into captions that people can read, from a transcript to a delivered
file. The rules are numbers from published guides, so a caption can be measured, not admired.
Written in Chroma's own words; sources and licences are in `NOTICE.md`.

**Load only what the task needs:**

| Task | Read |
|---|---|
| Which limits apply; sources and links | `references/standards.md` |
| Chunking, timing, gaps, line breaks, shot changes | `references/timing-and-breaks.md` |
| Sound events, speakers, colours, music, contrast | `references/sdh-and-speakers.md` |
| 9:16 reels, shorts, word highlight, platform zones | `references/social-and-platforms.md` |
| Transcribing, Whisper and Scribe failure modes, clean-up | `references/asr.md` |
| SRT, WebVTT, TTML/IMSC, SCC, sidecars, After Effects limits | `references/formats.md` |
| Doing it with the chroma-ae MCP tools, Remotion, HyperFrames | `references/chroma-ae-workflow.md` |

For motion rules around captions (beats, keeping them out of the action), see
`chroma-motion-director` (`references/sound-and-captions.md`). This skill owns the caption rules.

## Pick the destination first

No target means no answer to "are these captions OK?". Ask, or state the default you used.

| Destination | Standard | Notes |
|---|---|---|
| Netflix, streaming, most online video | Netflix English (adult) | the default when nothing is named |
| Children's programmes | Netflix English (children's) | 17 cps instead of 20 |
| UK broadcast and iPlayer-style delivery | BBC | words per minute, 37 characters broadcast |
| US education, training, e-learning | DCMP Captioning Key | 32 characters, slower rates |
| 9:16 social (TikTok, Reels, Shorts) | house social preset | short chunks, platform safe zones |
| Legal or accessibility claim | WCAG 2.x plus the above | 1.2.2 (A) prerecorded, 1.2.4 (AA) live |

## Key numbers

| Rule | Netflix adult | Netflix kids | BBC | DCMP |
|---|---|---|---|---|
| Reading speed | 20 cps | 17 cps | 160-180 wpm (about 0.33 s a word) | 130-160 wpm by level |
| Characters per line | 42 | 42 | 37 broadcast; online 68% of a 16:9 frame | 32 |
| Lines | 2 | 2 | 2 | 2 |
| Shortest caption | 20 frames at 24 fps (5/6 s) | same | not fixed | 40 frames |
| Longest caption | 7 s | 7 s | not fixed | 6 s |
| Gap between captions | 2 frames minimum | same | if a pause is left, 1 s or more (1.5 s better) | not fixed |

Full table with links: `references/standards.md`.

Always:
- Appear on speech onset (or a frame or two before); linger about 0.5 s after speech where space allows.
- Two lines at most, bottom-heavy (the lower line longer) when both are needed.
- Break at grammar, not at the character count (`references/timing-and-breaks.md`).
- Colour is never the only cue for a speaker (colour-blind viewers, monochrome sets).
- Text contrast 4.5:1 or better; a black box behind the text at 60% opacity or more (75% over busy footage).
- Ship a plain sidecar (SRT or VTT) next to any burned-in version.
- Review every name, number and brand word by eye. Speech-to-text gets them wrong with confidence.

## The workflow

Seven steps. In After Effects each maps to a chroma-ae tool (`references/chroma-ae-workflow.md`).

1. **Destination and style.** Standard preset, caption kind (subtitle-style, phrase chunks, single
   word), language, SDH or dialogue only.
2. **Transcribe, or take the client's file.** Transcribing with Scribe sends the audio to a
   third-party service: ask first. A supplied SRT or VTT skips this step.
3. **Read the transcript.** Invented lines over silence or music, wrong language, lost
   punctuation, names. Fix before chunking, not after (`references/asr.md`).
4. **Plan against the standard, with cut times.** Chunk, break, time, merge, then list what
   changed and what still violates. Give the planner the shot changes so it can respect them.
5. **Review the plan.** Read the change list and every violation. A violation that retiming
   cannot fix is a rewording decision for a human; never silently cut the speaker's words.
6. **Write the captions** into the comp (layers, one layer, per word, or a template), inside the
   platform safe zones, with a backing box if the footage is busy.
7. **Check, export, look.** Read them back, lint against the standard again, export the sidecar,
   then look at frames (first caption, a two-line caption, the fastest caption, a cut, the last
   caption) at phone width. Say which checks were measured and which were only looked at.

## Chunking modes

| Mode | Shape | Use for | Avoid for |
|---|---|---|---|
| Subtitle-style | 1-2 lines, a full phrase, standard limits | dialogue, interviews, anything going to a platform or broadcaster | nothing; the safe default |
| Phrase chunks | 2-4 words at a time, capped with `max_words` | punchy social edits, product films, explainers | fast speech with long sentences |
| Single word | one word at a time | very short hooks and slogans (under about 8 words) | anything longer; fast speech |

Single-word display hurts comprehension: no word lands next to its neighbours, viewers who read
ahead lose the line, and fast speech flashes words for under 8 frames. Two to four words is the
working minimum for speech. Merge any word shorter than 8 frames into its neighbour. Keep numbers
with their units ("40 per cent", "3 million") and names together. Start a word highlight a frame
or two early so it reads as in sync, not late.

## Common mistakes

- Using 42 characters per line for 9:16 social; a portrait phone line holds about 25 (`references/social-and-platforms.md`).
- Burning in with no sidecar. Nobody can then fix a typo, translate, or search the text.
- Trusting word timestamps to the frame; they drift 50-100 ms.
- Ending a line on "the", "of", "and", "to", "I", or splitting a first name from its surname.
- Captions over the platform UI (bottom 660-672 px, right-hand button column on 1080x1920).
- Red and green speaker colours with no label.
- Fitting the reading speed but ignoring the cut: a caption that straddles a shot change by two frames flashes.
