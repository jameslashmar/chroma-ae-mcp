# Timing and easing

## Durations

**By element (UI register):** tooltip 80-120 ms · button or toggle 120-180 ms · icon
150-250 ms · card 200-350 ms · modal 300-400 ms · page 400-600 ms · dramatic reveal
600-1200 ms · ambient loop 2-20 s. Hover under 100 ms, press under 150 ms, settle 200-300 ms,
error shake 300-400 ms with 2-3 swings of ±10-15 px.

**By speed tier (film register):** fast 0.15-0.3 s (energy) · medium 0.3-0.5 s · slow
0.5-0.8 s (luxury) · very slow 0.8-2.0 s (cinematic). A fast move across the frame is
0.3-0.6 s. A premium reveal is 0.8-1.6 s. A tween over 2.0 s is usually too slow unless it is a
camera drift or an ambient loop.

**By distance:** scale the base duration by 0.8x at 50 px, 1.0x at 100 px, 1.3x at 200 px,
1.6x at 400 px, 1.8-2.0x across the full frame.

**By material:** rigid 1.2x and no overshoot · elastic 0.8x and 15-25 % · fluid 1.5x and 5 % ·
paper 1.0x and 3-5 % · gas 2.0x and none · glass 0.9x and none.

**Exits** are 40-50 % shorter than the entrance (0.4 s in, 0.25 s out) and ease in. **Landing
is longer than leaving.** If entrances feel snappy to the point of glitching, slow the whole
piece by about 1 s before tuning single moves.

## Brand identity in three constants

A piece (or a brand) has one **signature ease** used for about 80 % of moves, a **three-tier
duration palette** (for example 200 / 300 / 450 ms) and **one entrance pattern**. Everything else
is an accent. Write all three in the spec.

| Archetype | Durations | Signature ease | Overshoot |
|---|---|---|---|
| Premium | 350-600 ms | (0.4, 0, 0.2, 1) | 0 % |
| Corporate | 200-400 ms | (0.2, 0, 0, 1) | 0-3 % |
| Playful | 150-300 ms | back out | 10-20 % |
| Energetic | 100-250 ms | expo out | 15-30 % |

## Ease by role

| Role | Ease | Bezier |
|---|---|---|
| Arrival, hero or title | expo out / quart out | (0.16, 1, 0.3, 1) / (0.25, 1, 0.5, 1) |
| Ordinary arrival | quad or cubic out | (0.2, 0, 0, 1) |
| Exit | cubic in | (0.3, 0, 1, 1) |
| Move between positions | cubic in-out | (0.65, 0, 0.35, 1) |
| Camera, colour flood, crossfade | sine or quad in-out | (0.37, 0, 0.63, 1) |
| Zoom-through, push into a cut | cubic in, strong | (0.5, 0, 0.75, 0) |
| Ambient loop | sine in-out | (0.37, 0, 0.63, 1) |
| Typing, counters, stepped looks | hold keys / steps | n/a |
| Rotation, progress, timers | linear | (0, 0, 1, 1) |

Named presets worth keeping: Material standard (0.2, 0, 0, 1), emphasised (0.05, 0.7, 0.1, 1),
decelerate (0, 0, 0, 1), accelerate (0.3, 0, 1, 1); Apple (0.25, 0.1, 0.25, 1); gentle float
(0.4, 0, 0.2, 1).

**Emotion to motion:** joy, back out at 200-400 ms · calm, sine at 500-1000 ms · urgency, ease
out at 100-200 ms · sadness, cubic in-out at 600-1200 ms · surprise, expo out at 150-300 ms ·
elegance, (0.4, 0, 0.2, 1) at 400-700 ms. Angular paths read tense, curved friendly, rising
growth, horizontal progress.

## Springs and overshoot

- Damping ratio 1.0 never bounces · 0.7-0.85 premium · 0.4-0.6 playful · under 0.3 cartoon.
- Back-out strength: 1.2 elegant · 1.7-2.0 the usual pop · 2.5 playful.
- Overshoot budget by context: success 5-10 % · feedback 2-5 % · celebration 15-25 % · error 0 %
  · premium 0 %.
- Only position and scale may overshoot. Opacity, colour and counting numbers never do (an
  overshooting number reads as wrong data).
- Press and release: scale 0.88 / 0.92 / 0.96 (dramatic / default / subtle), never below 0.85 or
  above 0.98; press straight in, release on a spring.

## Classic principles, with numbers

- **Anticipation:** 100-200 ms at 10-20 % of the move, opposite direction. Skip it on moves
  under 150 ms.
- **Squash and stretch:** squash [1.2, 0.8], stretch [0.85, 1.15]; impact 2-4 frames, recovery
  4-8 frames. Keep volume roughly constant.
- **Follow-through:** children lag 50-150 ms; trailing parts stop 100-200 ms after the lead.
- **Arcs:** push the path midpoint 10-20 px off the straight line.
- **Exaggeration:** playful 15-25 % · energetic 20-30 % · corporate 0-5 % · premium 0 %.
- **Layers of motion:** primary at 100 % amplitude; secondary at 30-50 %, 50-100 ms later, on a
  different ease; ambient at 10-20 % (only on backgrounds, never on titles or UI).

## Ambient (backgrounds only)

Breathing scale 0.98-1.02 over 2-4 s (beyond ±5 % it demands attention) · float ±5-15 px over
3-5 s, with layered periods such as 3.5 / 4.0 / 5.5 s so elements never sync · gradient shift
8-20 s · shimmer sweep 1.5-2.5 s with 2-5 s between sweeps · slow background orbit 3-5° a
second · fewer than 20 particles · ambient energy at most 20 % of the primary motion.

## Motion blur

Only on fast, short moves (slams, whips, scale punches). Blur peaks at the fastest frame and
reaches 0 at the settle, on the same ease and window as the move: 6-12 px on text-sized
elements, 15-20 px full-frame, horizontal-only on a horizontal move. Never on text being read,
slow moves or fades.

## Milliseconds to frames

| ms | 24 fps | 25 fps | 30 fps | 60 fps |
|---|---|---|---|---|
| 100 | 2.4 → 2 | 2.5 → 3 | 3 | 6 |
| 150 | 3.6 → 4 | 3.75 → 4 | 4.5 → 5 | 9 |
| 200 | 4.8 → 5 | 5 | 6 | 12 |
| 250 | 6 | 6.25 → 6 | 7.5 → 8 | 15 |
| 300 | 7.2 → 7 | 7.5 → 8 | 9 | 18 |
| 400 | 9.6 → 10 | 10 | 12 | 24 |
| 500 | 12 | 12.5 → 13 | 15 | 30 |
| 800 | 19.2 → 19 | 20 | 24 | 48 |
| 1000 | 24 | 25 | 30 | 60 |

Round to whole frames and keep keys on whole frames (sub-frame keys render unpredictably).
Under 24 fps a 100 ms move is two frames and reads as a cut; give it at least three.

**Beat grid:** frames per beat = fps × 60 / BPM. Compute beat *n* as `round(n × fps × 60 / BPM)`,
never by adding a rounded beat repeatedly: at 128 BPM and 30 fps that drifts 2 frames in 32
beats. Cut on the beat, change layout on the bar.

## Cubic-bezier to After Effects keyframe ease

A bezier (x1, y1, x2, y2) between key A and key B, with the value changing by Δ over duration D
(so the average speed is Δ / D):

- **A, outgoing:** influence = x1 × 100 %, speed = (y1 / x1) × Δ / D.
- **B, incoming:** influence = (1 − x2) × 100 %, speed = ((1 − y2) / (1 − x2)) × Δ / D.

AE influence must be between 0.1 % and 100 %. A bezier with y outside 0-1 (back, elastic) has no
two-key equivalent: add an overshoot key (for example 105 % at 70 % of the time, then settle) or
use a spring expression.

| Ease | A out (influence / speed) | B in (influence / speed) |
|---|---|---|
| AE Easy Ease | 33.33 % / 0 | 33.33 % / 0 |
| (0.2, 0, 0, 1) standard | 20 % / 0 | 100 % / 0 |
| (0.4, 0, 0.2, 1) premium | 40 % / 0 | 80 % / 0 |
| (0.16, 1, 0.3, 1) expo out | 16 % / 6.25 × avg | 70 % / 0 |
| (0.25, 1, 0.5, 1) quart out | 25 % / 4 × avg | 50 % / 0 |
| (0.3, 0, 1, 1) exit | 30 % / 0 | 0.1 % / 2-3 × avg (it leaves at speed; match the next shot's entry speed) |
| (0.65, 0, 0.35, 1) in-out | 65 % / 0 | 65 % / 0 |

For multi-dimensional spatial properties, apply the ease to the speed graph (the whole move),
not per axis, unless the dimensions are separated.
