# SDH, speakers and contrast

SDH (subtitles for the deaf and hard of hearing) adds what the ear gets and the eye does not.
Plain captions carry dialogue only. State which you are making.

## Sound events

- In square brackets, lower case: [door slams], [phone buzzing], [applause].
- Only sounds that matter to the story or the mood. Not every footstep.
- Put it on its own caption or its own line, timed to the sound.
- Off-screen speech: the speaker's name in brackets before it, or a colour, plus position if
  the format allows. Narrator: [Narrator] or the narrator colour.
- Tone only where the words do not carry it: [sarcastically], [whispering].
- Do not describe the picture.

## Music

- Song lyrics: italic, with a music note (a note symbol) at the start of each caption and at the
  end of the last line of the lyric.
- Instrumental that matters: [tense music] or [upbeat music playing].
- Silence that matters: [silence]. Rare.

## Speakers

- Two people in one caption: a hyphen at the start of each line, one speaker per line.
- A new speaker starts a new caption where it can, so the colour or label change is clear.
- Name labels ("MARCUS:") on first appearance when the speaker is off-screen or unclear.

### Speaker colours

BBC's order for identifying speakers is white first, then yellow, cyan, green:

| Order | Colour | Hex |
|---|---|---|
| 1 | white | #FFFFFF |
| 2 | yellow | #FFFF00 |
| 3 | cyan | #00FFFF |
| 4 | green | #00FF00 |

By BBC convention a narrator takes yellow. Reuse a colour for the same person through the whole
piece.

Colour must never be the only cue. About 1 man in 12 has a colour-vision deficiency, and many
players and monochrome displays drop colour. Pair every colour with a label, a hyphen, or a
position. Chroma's `speaker_style` option in `ae_captions_plan` takes a colour, label or dash
style; for accessibility work use a combination.

## Contrast

Text against its background: 4.5:1 or better (WCAG 1.4.3; large text 3:1). Over moving footage,
put a box behind the text rather than hoping the picture behaves.

White text over a black box, WCAG contrast ratio by box opacity. Computed with the WCAG
luminance formula for a pure white backdrop behind the box, which is the worst case (a bright
sky or a white wall):

| Box opacity | Contrast | Verdict |
|---|---|---|
| 50% | about 4.0:1 | fails 4.5:1 |
| 60% | about 5.7:1 | passes |
| 75% | about 10.4:1 | passes with margin |

Over a mid-tone image (a mid-grey around sRGB 128), the same boxes score higher: 50% gives
about 10.4:1, so the table is a conservative guide. In practice, the box is not the only
variable: the picture changes under it. Use 60% as the floor and 75% for busy or bright
footage. A box also makes captions readable for viewers with low vision. Outline plus drop
shadow with no box usually fails over bright areas.

The box covers the text block plus padding. Do not stretch it to full width: it hides picture.
