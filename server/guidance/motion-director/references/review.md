# Review: measure, then look

Trust the numbers over your eye, then use your eye for what numbers can't see.

## 1. Measure

Run these before anyone watches it. Each has a fix.

| Check | Fails when | In AE (chroma-ae) |
|---|---|---|
| Linear spatial keys | position, scale or rotation of a non-mechanical element moves at constant speed | `ae_motion_review` |
| Abrupt start or stop | speed jumps from or to zero without an ease | `ae_motion_review` |
| One ease everywhere | more than two tweens in a scene share the same ease and duration | `ae_get_keyframes` across layers |
| Wrong direction | an entrance eases in, or an exit eases out | `ae_get_keyframes` |
| Overshoot where it shouldn't | opacity, colour or a counting number overshoots | `ae_motion_review` |
| Exit too long | an exit is not 40-50 % shorter than its entrance | keyframe spans |
| Stagger | sibling start offsets outside the table, or the group spread far over 500 ms | `ae_stagger` plan / keyframe starts |
| Density | more than a third of a group moving at once | keyframe overlap |
| First move at 0 | a scene's first move starts on its first frame | keyframe starts |
| Unread line | a text layer is on screen for less than 0.5 s + 0.3 s per word | text layer in/out and word count |
| Text below the floor | text under 2.6 % of the short side at its smallest on-screen scale | `ae_check_legibility`, `ae_measure_text` |
| Outside safe zones | text or logo outside title-safe or the platform's bands | `ae_check_legibility`, `ae_house_style_check` |
| Overlap | text overlapping text or the subject | `ae_check_text_overlap` |
| Dead stretch | over 3 s with nothing changing | per-frame change across the timeline |
| First frame empty | frame 0 is black, empty or a lone logo | `ae_snapshot_frame` at 0 |
| Silent film | over 15 s with no sound | `ae_audio_analyze` |
| Loudness | outside −16 to −14 LUFS or peaks over −1 dBTP | `ae_loudness_check` |
| Loop seam | the last frame of a loop differs from frame 0 | `ae_compare_frames` |
| Nothing moves | the biggest change against frame 0 is near zero in a "motion" piece | `ae_compare_frames` |
| Late or out of order | an element appears after its intended time, or before one it should follow | markers against layer in-points |
| Facts | a name or number on screen isn't on the approved list | text layers against the list |
| Delivery | duration, fps, size, codec, colour range or audio streams differ from the spec | `ae_check_delivery_file`, `ae_verify_render` |

## 2. Look

Three contact sheets:

1. **Beats:** each scene just after it starts, at its middle, and at every beat or hit.
2. **Seams:** a strip across every cut, from −0.2 s to +0.2 s. Look for a jump in position,
   scale or colour at the seam, a speed mismatch, and a blank midpoint.
3. **Phone:** the beat frames at 360 px wide, with the sound off.

Describe each beat frame as a stranger would, in one sentence. Ask: does it read as what it is?
Does the subject separate from the background? Is anything you'd have to explain? Would the
pictures alone tell the story? Then the screenshot test: a good motion piece loses meaning when
reduced to stills; slides don't.

Use the rendered file for this, not the preview: the two can differ. Pull the same frames from
the render and compare them.

## 3. Write notes

One line each:

```
t=4.2s · headline · lands then keeps scaling → stop the scale key at 4.0s · keep the ease and timing
```

Rank them **P0** (breaks the read), **P1** (weakens it), **P2** (polish). Don't score out of 10.
Report only what you actually saw; if there is nothing, say so. If the film feels busy, remove a
third of the motion before adding anything.

Optionally ask a fresh agent to critique from only the brief and the sheets, without seeing the
build, then compare.

End with a short delivery note: the calls made, what was measured and what was only looked at,
the weakest shot, and any warnings deliberately kept and why. Every "pass" names the frame and
time it was checked on.

## 4. Learn

Each defect found late gets a cause and a rule: add it to the project's `MOTION.md` banned list
or to the checks above, so it is caught earlier next time. The AE MCP's `ae_learn_taste` and
`ae_taste_rules` keep these per project.

## Looks generated

The tells. Any of these in a piece needs a reason.

- Everything fades and slides up; every scene enters the same way; the same ease at 0.5 s on
  everything.
- Titles that keep drifting, breathing or scaling after they land; floating or pulsing loops on
  titles or UI as fake life.
- Bounce on UI; click rings; typewriter headlines (typing belongs inside an input box); glow and
  bloom as decoration; gradients on text.
- A dark void with small centred things; purple-to-blue backgrounds; glass cards; three cards in a
  row; grids of KPI tiles; HUD corners; a logo docked in a corner.
- Grey placeholder bars, stock icons, emoji, clip art, rockets and sparkles.
- A late, slow push-in after the frame has been read.
- Crossfades between unrelated worlds; a fade out then a fade in at every cut.
- A pie chart, a legend, gridlines.

## Symptoms to fixes

| It feels | Try |
|---|---|
| Robotic | ease every spatial key, add arcs, offset starts by 50-150 ms |
| Cheap or flat | a secondary layer, follow-through, 3-10 % overshoot on position or scale (not in premium) |
| Too slow | shorten holds before shortening moves; check the duration tier for the register |
| Too fast | slow the zooms and pans to about 0.7x, leave the rest |
| Like slides | enter each scene through an object already on screen; vary the entrances |
| Busy or distracting | one hero per moment; remove a third of the motion |
| No personality | pick a register and a signature ease and use it for 80 % of moves |
| Inconsistent | one duration palette, one entrance pattern, the same ease family per group |
