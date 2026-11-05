# The spec: MOTION.md

Every piece gets a `MOTION.md` beside its project (in AE projects, next to the `.aep`). It turns
the brief's adjectives into numbers, and it is what the review checks against. Read an existing
one before touching the piece; if the brand has one, copy it in and only add the piece's beats.

Fill every field. Where the answer is unknown, write `ASK ME`; never invent a colour or a fact.

```markdown
# MOTION.md: <piece name>

## Goal
One sentence: what the viewer feels or knows at the end.
Audience: ...   Platform: ...   Sound: on / off by default

## Format
Size: 1920x1080 | 1080x1920 | 1080x1350 | 1080x1080     Fps: 24 | 25 | 30 | 60
Length: ... s    Music: ... BPM (or none)    Safe zones: see type-and-layout.md for the format

## Register
brand film / premium     (UI micro | brand film | energetic | handmade; at most a 90/10 mix)

## Motion language
Signature ease: (0.4, 0, 0.2, 1)  for about 80 % of moves
Arrival ease: expo out    Exit ease: cubic in, 40-50 % shorter than entrances
Camera ease: sine in-out
Durations: short 300 ms / medium 500 ms / long 800 ms   (in frames: ... / ... / ...)
Stagger: words 80 ms, items 60 ms, group total about 500 ms
Overshoot: 0 % (position and scale only, never opacity, colour or numbers)
Entrance pattern: mask reveal from below
Transitions: primary = <kind> for most seams; accents = <kind>, <kind>; hard cuts at most 1/3
Motion blur: fast moves only

## Look
Colours (hex, with a role each): background ..., text ..., accent ..., data ...
Type: display <font> <weight>, body <font> <weight>; title ... px, body ... px, floor 2.6 % of short side
Texture: grain / none     Background: never flat #000

## Facts
The approved names, dates and numbers. Nothing else appears on screen.
Sample data: labelled "illustrative data" on every frame it appears.

## Banned
Five things this piece must never do (start from review.md "Looks generated").

## Beats
| # | Time (s or beats) | Role | On screen | Hero frame at | Enter / lock / exit / bridge | Sound |
|---|---|---|---|---|---|---|
| 1 | 0-1.2 | hook | ... | 0.8 | ... | hit at 0.8 |

## Checks
The measured checks in review.md that apply, and any extra ones for this piece.
```

## Brand defaults

For Chroma's own pieces, the register is brand film, premium: signature ease (0.4, 0, 0.2, 1),
no overshoot, no glow or bounce, type still once landed, colours and fonts from
`chroma-brand-guidelines`, and the brand's spectrum used once per piece.
