# Sound and captions

## Voice

- Narration runs 2.2-2.5 words a second. A scene of about 9 s carries about 19 words, 26 at most.
  A 30-90 s piece is about 155 words or fewer.
- Script first, then real timings: the recorded (or synthesised) voice's word timestamps set the
  scene boundaries, not the written estimate. If the voice runs longer than the picture, trim the
  script; never stretch the motion to fill.
- Write numbers as they are spoken.

## Music and effects

- Voice leads. Music under voice sits at about 14 % volume and is **carved** (an EQ dip where the
  voice lives, around 1-4 kHz), not just ducked. Drop the score entirely while the voice must be
  heard clearly.
- Music enters on its strongest bar and ends on a bar line with a short fade. Looping beds: 0.4 s
  fade in, 1.5 s fade out. Anything over 15 s that tells a story gets a bed plus effects.
- Effects only for real causes on screen: a click, a whoosh on a cut, a key tick, a pop, one
  riser into the payoff. Each hit sits 3-6 dB above the bed. Rotate two or three takes of a
  repeated sound.
- Timing: a sound's peak lands one frame after its picture. A move that lands on a hit starts
  40-190 ms early; a reaction starts 0-45 ms after it.
- A bed whose energy is mostly under 150 Hz disappears on phone speakers.
- A generated score is possible in code (low bed, a hit per shot, a lift at the end): kick as a
  falling sine, hats as filtered noise, an impact as sub plus noise with a short decay.
- Audio-reactive motion stays micro: text and logos pulse at most 5 % in scale, backgrounds
  10-30 %. No equaliser bars, no strobing.
- Never claim a beat analysis that did not happen; a hand-made beat map is fine if it says so.

## Levels

| Target | Value |
|---|---|
| Social and web mix | −16 to −14 LUFS integrated |
| True peak | −1 dBTP or lower |
| Speech level in a clean recording | roughly −26 to −16 dB |
| Broadcast | the platform's spec (EBU R128 −23 LUFS, ATSC A/85 −24 LKFS) |

EQ starting points: high-pass at 80 Hz for rumble; reduce mud at 250 Hz, −3 dB, Q 1.2; reduce
boxiness at 400 Hz, −3 dB; clarity at 3 kHz, +2.5 dB; soften harshness at 3.2 kHz, −3 dB.
Subtract before adding; the limiter goes last.

## Captions

- Group 2-3 words for high energy, 3-5 conversational, 4-6 calm. Break at the end of a sentence,
  at a pause of 150 ms or more, or at the word limit.
- One group on screen at a time. A group appears at or before its first word and leaves at or
  after its last. The first caption starts 0.1-0.3 s in. Exit is a 0.12 s fade, then gone.
- Never time two words as one entry.
- Speech-to-text tools invent words over silence ("Thank you."): drop words that start inside a
  trailing silence (silence below about −35 dB for 0.6 s or more).
- Captions sit inside an 80 % title-safe box: 80-120 px from the bottom on 16:9, about 600-700 px
  from the bottom on a 9:16 (above the platform UI).
- Over footage, text partly behind a speaker reads best at 30-55 % covered; under 15 % it floats,
  over 65 % it is eaten. Blend and scrim rules are in `type-and-layout.md`.

## Review with and without sound

Three passes: **silent** (can the story be followed with the sound off, at phone size?),
**audio** (do the hits land on their causes?), **frame** (is each hit frame readable as a
still?). Say which of these were measured and which were only judged by eye or ear; a loudness
reading is a measurement, "the mix sounds fine" is not.
