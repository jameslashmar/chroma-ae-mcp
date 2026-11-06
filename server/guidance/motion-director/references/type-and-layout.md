# Type, layout and colour

## Sizes

**Floor:** readable text is at least 2.6 % of the frame's short side: 28 px at 1080, 50 px at
1920 wide in a vertical. Check every text layer at its smallest scale on screen.

| Role | Landscape 1920x1080 | Notes |
|---|---|---|
| Hero word | fills 60-90 % of the width | 1-2 words |
| Title | 4-9 % of frame height (64-120 px) | at most 6 words a line |
| Quiet line, subtitle | 2.5-4 % of height | |
| Body | 28-42 px | 1-2 lines |
| Label | 18-24 px only if it is not meant to be read; otherwise 28 px+ | |

- Portrait type is landscape × 1.3 (titles × 1.35, stats × 1.4).
- Social feed headlines 90 px or more on 1080 wide; full-screen viewing headlines 60 px+, body
  20 px+ is the absolute floor and only for viewing at full size.
- Vertical title tiers by line length (1080x1920): 1 short line 118-156 px, line height
  0.95-1.05 · a longer single line 96-118 px · two short lines 78-96 px · two longer lines
  62-78 px · three lines or legal copy 48-62 px. Support text 30-44 px, CTA 28-40 px. 24-48 px
  between title and support, 40-72 px between support and CTA, at least 72 px from a text block to
  the edge of its field.
- Tracking at display sizes −0.03 to −0.05 em. Weight contrast 300 against 900, not 400 against
  700. Light text on dark: body weight about 350 and line height 0.05-0.1 more.
- Numbers that count use tabular figures and round to the displayed precision.
- Never let the text box be wider than the frame allows: fit it (`ae_fit_text`), don't rely on
  manual line breaks in body copy.

## Reading time

- Hold a line 0.5 s + 0.3 s per word. The last line holds at least 2 s. A one- or two-word chapter
  line can hold 0.4 s. A key element stays readable at least 0.3 s even in a montage.
- A typographer's check: 3 s on screen must be readable in 2.
- One line on screen at a time for titles (explainers can run to about 10 words).
- Text is still before it has to be read. A landed title does not drift, breathe or scale.
- Exit with a 0.13-0.25 s blur-out or a mirrored move, not a long fade.

## Copy on screen

- One idea per beat. Short, strong words; at most about five words on screen for social.
- Kinetic type: 3-7 words a scene, 1-2 emphasis words, scenes tagged hook, build, punch, resolve.
- On-screen text is shorter than the voiceover saying it.
- Avoid launch clichés in copy: "introducing", "meet", "unlock", "seamless", "supercharge".

## Safe zones

| Format | Keep text and logos |
|---|---|
| Any | inside an 80 % title-safe box (10 % in from each edge) |
| 16:9 captions | 80-120 px above the bottom |
| 9:16 reels and shorts (1080x1920) | safe on TikTok, Reels and Shorts: x 120-888, y 288-1248 (approximate, from ad specs; per-app zones in the `captions` skill); below y 840 keep clear of the right rail (end text by x 780); headline around y 360-520 |
| 9:16 promo layout | CTA, subtitles and proof above the bottom 15 %; the main title above the bottom 22 %; avoid the top 8-10 % |
| Lower third | inside the bottom 30 %, inside title-safe |
| Picture-in-picture | inset 28 px from the edges |

Below y 1248 on a vertical, only texture.

## Layout

- The hero of a shot fills at least 40 % of frame height or width (60-70 % for a single-object
  shot). Small objects floating in empty space look like a template.
- At least three layers per scene: background, content, accents. Two focal points at most. Anchor
  things to edges rather than centring everything.
- Write the layout as rectangles before building: text box, subject box, quiet zone, safe bottom,
  motion bounds. A vertical text side often takes 42-48 % of the width as a quiet zone with the
  subject opposite it, or the subject in the central 60 %.
- Three or more beats with the same text box, the same entrance and the same rhythm look like
  slides; change one of them.
- Hook frames on short vertical pieces put the text impact in the centre or upper centre; keep
  the lower half for CTA, proof and subject.
- Overshooting or pulsing elements need clearance at their largest size.
- Data: one number at a time, the biggest thing on screen, with a proportional visual (bar, ring).
  Related stats share one visual space; only the value changes. Build a chart in reading order:
  axis, reference line, data drawing in, one annotation. Highlight one series and grey the rest.
  Avoid pie charts, dual axes, legends, gridlines and dashboards of six or more panels. Values
  never change during a morph between chart types. Lines are drawn, not faded in.

## Colour

- Never a flat #000 background, and no full-screen linear gradients on dark: they band in H.264.
  Use a solid with a glow, or a radial.
- Atmosphere sits at 15-25 % opacity; 5 % vanishes after compression. Focal elements at full
  saturation. Tint the neutrals.
- Contrast for text meets WCAG AA (4.5:1 body, 3:1 large).
- Move into the "success" colour rather than starting there; flash an error colour, then settle.
- Over footage, pick the text blend by the brightness behind it: under 60 (of 255) screen, 60-180
  overlay, over 180 normal with an opaque colour. Plain subtitles over anything brighter than 60
  get a 30-40 % scrim sized to the text, never a full-width bar.
