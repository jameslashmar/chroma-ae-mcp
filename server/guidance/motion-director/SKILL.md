---
name: chroma-motion-director
description: Direct and build motion pieces end to end: brief, numeric spec, still frames, choreography, sound, review and delivery, with measured timing, easing, stagger, transition, type, caption and audio rules. Use for any motion graphics, launch or promo film, social reel, explainer, title sequence, logo sting, lower third, stat or chart animation, kinetic type, or motion review, whether it is built in After Effects (through the chroma-ae MCP), Remotion, HyperFrames, Lottie or code. Also use to critique motion ("it feels robotic / cheap / like slides / too fast") and to turn adjectives into numbers. Trigger phrases: 'motion', 'animate', 'animation', 'promo', 'launch video', 'reel', 'sting', 'lower third', 'kinetic type', 'title sequence', 'explainer', 'easing', 'stagger', 'transition', 'make it feel premium', 'review this animation'.
metadata:
  version: "1.0.0"
  sources: see NOTICE.md
---

# Chroma motion director

One skill for directing motion, from a one-line brief to a delivered file. It merges eight
public skills (see `NOTICE.md`) and resolves where they disagree. The numbers are the point:
every rule below is meant to be measured, not admired.

**Load only what the task needs:**

| Task | Read |
|---|---|
| Any new piece | this file, then `references/spec.md` |
| Timing, easing, springs, ms to frames, AE ease values | `references/timing-and-easing.md` |
| Groups, stagger, cameras, transitions between scenes | `references/choreography.md` |
| Text sizes, reading time, safe zones, layout, colour | `references/type-and-layout.md` |
| Structure, beat shares, pacing, scene recipes | `references/story-and-pacing.md` |
| Music, voice, sound effects, levels, captions | `references/sound-and-captions.md` |
| Checking a piece, writing notes, the "looks generated" list | `references/review.md` |

For anything made for Chroma, `chroma-brand-guidelines` sets the look (palette, type, voice);
this skill sets the motion. In After Effects, drive the work through the `chroma-ae` MCP tools
(`ae_motion_review`, `ae_contact_sheet`, `ae_check_legibility`, `ae_set_keyframe_ease`,
`ae_stagger`, `ae_loudness_check` and so on) rather than raw JSX.

## The process

Six gates. Do not skip one because the brief is short; shrink it instead.

1. **Brief, then stop.** One sentence of intent (what the viewer should feel or know at the
   end), the audience, the format (size, fps, length, platform), the single message, the arc,
   and what must not happen. Ask at most one clarifying question; where something is unknown,
   write `ASK ME` rather than guess (never guess a hex colour or a fact). Show the beat sheet and
   wait for a yes before building.
2. **Spec: adjectives into numbers.** Write the piece's `MOTION.md` from
   `references/spec.md`: register, signature ease, a three-tier duration palette, stagger,
   overshoot budget, colour roles, type sizes, safe zones, the banned list, and the beat table.
   "Premium" means 350-600 ms, ease (0.4, 0, 0.2, 1), no overshoot; it does not mean "nice".
   A project that already has a `MOTION.md` or brand file: read it first and follow it.
3. **Stills before motion.** Build the end state of every beat as a still and check it: one
   hero, readable at phone size, inside the safe zones, nothing touching an edge it shouldn't.
   Animate *from and to* those stills. A frame that fails as a still will not be saved by motion.
4. **Choreograph.** One primary motion idea per scene, at most one supporting motion, one
   signature moment per film. Ease by role, stagger by importance, overlap the next element when
   the last is 30-50 % done, hand scenes off without fading out. Drive cuts and hits from one
   beat grid when there is music.
5. **Review: measure, then look.** Run the measured checks first (`references/review.md`), then
   contact sheets: each beat's start and middle, a strip across every cut (−0.2 s to +0.2 s), and
   the beat frames at phone width (360 px). Notes are `t=4.2s · where · problem → exact change ·
   what stays`, ranked P0/P1/P2. Report only what you actually saw; say so when there is nothing.
6. **Deliver and verify the file.** Check the rendered file, not the preview: duration, fps,
   size, codec, colour range, loudness, frame 0 (it is the thumbnail: never black, never a lone
   logo). State what was measured and what was only looked at.

**Revisions:** one change per note. Keep the motion, timing and approved parts exactly as they
are, and say what changed. Build exactly what was asked; offer extras instead of adding them.

## Pick a register first

Most conflicts between the sources disappear once the register is fixed. Pick one per piece
(a 90/10 mix at most) and write it in the spec.

| Register | Use for | Durations | Overshoot | Stagger, total | Character |
|---|---|---|---|---|---|
| **UI micro** | product UI in a demo, buttons, toggles, cards | 80-450 ms | 0-5 % | 20-60 ms, under 400 ms | quick, functional, no bounce on UI |
| **Brand film** (default) | launches, promos, reels, titles, stings | moves 300-800 ms, reveals 0.8-1.6 s | 0 % premium, 3-10 % energetic | 40-120 ms, about 500 ms | arrive slow, leave clean, still when landed |
| **Energetic** | social hooks, sport, music-led cuts | 150-400 ms | 10-25 % on position or scale only | 30-60 ms | beat-driven, hard accents, contrast of pace |
| **Handmade** | editorial, explainer, collage, Vox-like | on twos (hold each pose 2 frames at 24 fps) | none | per element, loose | stepped, tactile, never smooth corporate easing |

Chroma's own work defaults to **brand film, premium**: no overshoot, no glow, no bounce,
landed type dead still.

## Core rules (the short version)

**Easing**
- Out for arrivals, in for exits, in-out for moves between positions and for camera. Linear only
  for rotation, progress, timers and genuinely mechanical motion.
- Use at least three different eases in a piece; no more than two tweens with the same ease and
  duration in a scene. Everything on one ease at 0.5 s is the clearest sign of generated motion.
- Arrivals take long-tailed ease-outs (expo or quart out). Exits are 40-50 % shorter than
  entrances and ease in.
- Springs: damping ratio 0.7-0.85 reads premium, 0.4-0.6 playful, under 0.3 cartoon. Position
  and scale may overshoot; opacity, colour and numbers never do.

**Choreography**
- One hero per moment; at most a third of a group moves at once. Dim the others to 40-60 %.
- Stagger by importance, not by layer order: letters 1 frame apart, words 60-120 ms, list items
  40-80 ms, and keep a group's total stagger near 500 ms so it reads as one beat.
- Nothing travels more than a third of the frame without an intermediate key or an arc.
- After a group resolves, leave 100-200 ms of stillness; a landed title stays dead still.
- First move 0.1-0.3 s in, never at frame 0 of a scene unless it is a cut-in.

**Transitions**
- Hand off, don't fade out then in: the outgoing and incoming motion happen together, with the
  ease mirrored across the seam (in on the way out, out on the way in) and the fastest frames at
  the cut. Match direction, axis and the sign of any scale change across the cut.
- Three to five kinds of transition per film, each with a cause on screen. One primary for
  60-70 % of seams. At most a third are hard cuts. Never crossfade between two different worlds.
- Every transition has a midpoint frame worth looking at. A blank midpoint is a failure.

**Type**
- Readable text is at least 2.6 % of the frame's short side (28 px at 1080). Titles 4-9 % of
  frame height; hero words can fill 60-90 % of the width.
- Hold a line 0.5 s + 0.3 s per word; the last line at least 2 s; at most 6 words a line.
- Text is still before it has to be read. Animate text with a device (mask, split, scan,
  compress, assemble, path handoff), not opacity plus a 20 px slide on everything.

**Pace**
- The hook is readable by 0.8-1.2 s; frame 0 is never empty. Something new every 2-4 s.
  Alternate dense and still beats; the slowest scene is about three times the fastest.
- Over 3 s with nothing changing is a dead stretch. Any single treatment goes stale after about
  6 s.

**Sound**
- Voice leads; music sits about 14 % under it and is carved around it, not just ducked. Social
  mixes at −16 to −14 LUFS, peaks at −1 dBTP or lower. A hit's peak lands one frame after its
  picture. Effects only for real on-screen causes.

**Content**
- Every name, date and number on screen comes from an approved list. Sample data carries a
  visible "illustrative data" label.
- Deletion test for every element: if removing it changes nothing, remove it.

## Working in After Effects

- Convert ms to frames at the comp's frame rate before keying (200 ms is 6 f at 30 fps, 4.8 f
  at 24, so round to 5 and say so). Beat frames come from the beat index, never accumulated.
- Cubic-bezier eases become AE keyframe influence and speed: the table is in
  `references/timing-and-easing.md`. Apply them with `ae_set_keyframe_ease`; check them with
  `ae_motion_review` (linear keys, abrupt starts and stops, overshoot, speed jumps).
- Seed every random (`seedRandom(n, true)` in expressions) so any frame renders the same.
- Use `ae_contact_sheet` for the sheets in step 5, `ae_check_legibility` and `ae_measure_text`
  for type, `ae_loudness_check` for levels, `ae_check_delivery_file` on the render.
