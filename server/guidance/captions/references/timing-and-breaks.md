# Timing, breaks and shot changes

## Order of operations

1. Chunk the words into captions (by sentence, pause or word cap).
2. Break each caption into lines.
3. Set in and out times from the words, then apply the limits (cps, minimum, maximum).
4. Fix gaps and shot changes last, since they move times by frames.

## Chunking

- Break at a sentence end, at a pause of 150 ms or more, or at the word cap, whichever comes first.
- Subtitle-style: fill to the line limits (42 characters, 2 lines on Netflix). Phrase chunks: 2-4
  words, set with `max_words`. Single word: only for a short hook.
- Merge any word shorter than 8 frames into its neighbour so it does not flash.
- Keep numbers with units, names together, and a title with its name ("Dr Patel").
- Never time two words as one entry; per-word highlights need one entry per word.
- Highlight a frame or two early (`highlight_lead_frames`): a highlight that lands on the word
  looks late.

## Timing

- In: the speech onset, or up to 2 frames before. Never later than the first word.
- Out: the end of speech plus a linger of about 0.5 s where space allows, but never over the
  next caption's in-time minus the gap, and never past the speaker leaving the shot.
- BBC: do not anticipate speech by more than 1.5 s or hang on for more than 1.5 s after it.
- Minimum duration: 20 frames at 24 fps (Netflix), 40 frames (DCMP). A one-word caption still
  gets the minimum.
- Maximum: 7 s (Netflix), 6 s (DCMP). Split a long one at a clause boundary.
- Reading speed: if a caption is over the limit, extend its out-time into the gap or linger
  first, then pull its in-time earlier (by no more than about 0.5 s), then split or trim wording
  last. Retime before rewording.
- Frame maths at 24 fps: 1 frame = 41.7 ms, 2 frames = 83 ms, 12 frames = 0.5 s.

## Gaps

- Minimum gap between two captions: 2 frames (Netflix).
- Gaps of 3-11 frames at 24 fps: close them to 2 frames, so the caption does not blink.
- Gaps of 12 frames or more (0.5 s) are real pauses. BBC says if you leave a pause gap it should
  be 1 s at least, better 1.5 s, since shorter gaps look jerky.
- Never overlap two captions in time unless they carry different speakers and the format allows
  simultaneous cues.

## Shot changes

Cut times come from `ae_detect_cuts` (or the editor's edit list).

| Case | Rule (Netflix) |
|---|---|
| In-time near a cut | on the cut frame, or at least 12 frames (0.5 s) away from it |
| Out-time near a cut | 2 frames before the cut, or at least 0.5 s after it |
| Caption spanning a cut | acceptable when the speech spans it; otherwise snap the out-time to 2 frames before |

A caption that starts 3 frames after a cut, or ends 2 frames after one, flickers against the new
shot. Snap to the cut or move well clear of it.

## Line breaks

- One line if it fits. Two lines only when needed or when the speaker switches.
- Bottom-heavy: when both lines are used, make the lower line longer, so the top one does not
  cover the picture more than needed. Pyramids are fine; inverted ones are not.
- Break at the highest grammatical boundary available, in this order: after a sentence end or
  strong punctuation; before a conjunction or relative pronoun; before a preposition phrase; between
  subject and verb phrase only if nothing better.
- Never end a line on: an article (a, an, the), a preposition (of, to, in, on, with), a
  conjunction (and, but, or), an auxiliary (is, was, have, will), or a subject pronoun that
  comes before its verb (I, he, she, we, they, you).
- Never split a first name from its surname, a number from its unit, a phrasal verb ("give up")
  or a hyphenated compound.
- Do not break the caption in the middle of a quoted title or a name of a thing.
- The planner scores candidate breaks with `breakPenalty` / `isWeakEnd`; a violation of the
  weak-ending rule is reported, not hidden.
- If a break cannot be made well within the character limit, re-chunk (shorter caption) before
  breaking badly.
