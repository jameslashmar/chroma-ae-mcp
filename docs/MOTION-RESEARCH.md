# Motion-design research: what to add to the MCP

Research done 2026-11-05 on eight public motion-design agent skills: LottieFiles
motion-design-skill, charlie947 motion-graphics-skills, HeyGen's HyperFrames skills
(hyperframes-animation, hyperframes-core, general-video, motion-graphics), Sunwood's
hyperframes-motion-reel, and geekjourneyx's hyperframes-motion-director. Their guidance was
merged into a standalone skill, `chroma-motion-director`, in the chroma-skills repo (sources and
licences in its `NOTICE.md`; geekjourneyx's is AGPL-3.0, so only its ideas were used, in our
own words).

This file is the other half: what the sources suggest the MCP itself should do. Nothing here is
built yet. Each item says what exists today, what to add, and why.

## What the MCP already covers

| Research idea | Already in the MCP |
|---|---|
| Flag linear, abrupt, overshooting and sub-frame keys | `ae_motion_review` |
| Ease from a cubic-bezier | `ae_set_keyframe_ease` (`curve: [x1, y1, x2, y2]`) |
| Stagger by importance, centre-out, seeded random | `ae_stagger` (orders and an ease on the offsets) |
| Key to beats and onsets | `ae_audio_analyze` + `ae_cue_keys` |
| Contact sheets at chosen times, blank-frame flags | `ae_contact_sheet` |
| Brief beside the project, missing-field questions | `ae_brief` (`<name>.brief.json`) |
| Brand fonts and colours, minimum text size, title safe | `ae_house_style_check` |
| Real contrast of text against its background | `ae_check_legibility` |
| Text overlap, fit, measurement | `ae_check_text_overlap`, `ae_fit_text`, `ae_measure_text` |
| Overshoot, bounce, loops, count-ups as expressions | `ae_expr_recipe` |
| Loudness, delivery file checks, render verification | `ae_loudness_check`, `ae_check_delivery_file`, `ae_verify_render` |
| Captions in the safe area | `ae_captions`, `ae_reframe` margins |
| Per-project learned rules | `ae_learn_taste`, `ae_taste_rules` |

## Proposed additions, in priority order

### 1. Serve the skill through the MCP (high value, small)

The server exposes only tools: no MCP prompts or resources. Every client (Claude Desktop,
Cursor, Codex) gets the 173 tools but none of the know-how about using them well.

- Add MCP **prompts**: `motion_director` (the process and core rules), `motion_review` (the
  measure-then-look loop and note format). Add **resources** for the reference tables (timing and
  easing, choreography, type and layout, captions and sound, the "looks generated" list).
- Ship them from the skill's files at build time, so there is one source.

### 2. Motion spec in the brief (high value, medium)

The research's strongest shared idea is "adjectives into numbers" before building. `ae_brief`
already stores goal, feel and brand; extend it with a `motion` block rather than a second file:
register (UI micro, brand film, energetic, handmade), signature ease, three-tier duration
palette, stagger, overshoot budget, entrance pattern, transition kinds, banned list, beats (time,
role, text, hero-frame time) and the approved facts list. The checks below then read their
thresholds from it, falling back to the register's defaults.

### 3. Extend `ae_motion_review` with choreography checks (high value, medium)

All computable from keyframes, with no render:

- **Ease monotony:** more than two tweens in the comp, or in one scene, with the same ease and
  duration (the clearest "generated" tell).
- **Wrong direction:** an entrance that eases in, an exit that eases out.
- **Entrance/exit ratio:** exits not 40-50 % shorter than their entrances.
- **First move at frame 0** of a scene or layer in-point.
- **Overshoot on opacity, colour or a counting number** (raise from info to a finding for these).
- **Stagger spread:** sibling start offsets outside the bands for their kind, or a group total
  well over 500 ms.
- **Density:** more than a third of a group moving at once.
- **Landed text still moving:** scale or position keys, or a `wiggle`/`loopOut` expression, on a
  text layer after its entrance.
- **Long tweens:** spatial tweens over 2 s that are not camera or ambient.
- **Severity tiers** matching the skill (critical / high / medium) and thresholds from the brief's
  motion spec.

### 4. Timeline checks: reading time, dead stretches, first frame (high value, medium)

A new read-only `ae_timing_check` (or part of `ae_preflight`):

- **Unread lines:** each text layer's on-screen time against 0.5 s + 0.3 s per word (last line
  2 s), using in/out points, opacity and Source Text keys.
- **Dead stretches:** spans over 3 s where nothing is keyed or changing (from keyframes and
  layer in/outs; optionally confirmed by frame diffs).
- **First frame empty:** frame 0 black, empty or a lone logo (render one frame; `ae_snapshot_frame`).
- **Silent film:** over 15 s with no audio layer.
- **Facts:** text on screen that is not in the brief's approved list.

### 5. Platform safe zones and the 2.6 % floor (medium value, small)

`ae_house_style_check` checks a minimum size and title safe. Add named platform presets from the
research: 9:16 reels (keep text between y 168 and 1330, out of the right 120 px action rail,
CTA above the bottom 15 %, title above 22 %), 16:9 captions 80-120 px from the bottom, lower
thirds in the bottom 30 %. Make the default minimum text size 2.6 % of the comp's short side
instead of a fixed pixel value.

### 6. Seam tools for cuts (medium value, medium)

- **Seam strip:** `ae_contact_sheet` with a `seams` mode that finds the cuts (layer in/out
  boundaries in a sequence comp, or `ae_detect_cuts` on footage) and samples −0.2 s to +0.2 s
  around each.
- **Seam check:** across each cut, compare the outgoing and incoming layers' speed, direction,
  axis and scale sign at the cut frame; flag a fade-out-then-fade-in, a mismatch over about 5 %,
  or a jump in position or colour.

### 7. Named eases and motion presets (medium value, small)

`ae_set_keyframe_ease` already accepts a bezier. Add named curves (premium, standard, expo out,
quart out, exit, in-out, camera) and register presets, so the AI writes `ease: "premium"` rather
than numbers it might misremember; and an `overshoot` option that adds a settle key for
back/spring eases, which a two-key AE ease cannot express.

### 8. Beat grid (medium value, small)

`ae_cue_keys` keys to detected beats. Add a `ae_beat_grid` that writes beat and bar markers
from a BPM and offset, computing each beat from its index (no accumulated rounding), and a snap
option that moves chosen keys and cuts to the nearest beat or half beat.

### 9. Transition and scene recipes (larger, later)

Recipes the research gives exact numbers for, built from existing write tools:

- Transitions between two layers at a cut, velocity-matched: whip, zoom-through, cut the curve,
  dip cut, colour flood, blur swap.
- Scenes: lower third (bar wipe, text up, hold, out; alpha), stat count-up with label after the
  lock, highlight band swept on after the text lands, logo draw-on, kinetic beat slam driven by
  beat markers.
- Background ambient (breathing 0.98-1.02 over 2-4 s, float ±5-15 px with unsynced periods),
  refusing text and UI layers.

### 10. Loop and delivery helpers (lower)

- Loop seam: compare the last frame with frame 0 (`ae_compare_frames`) and report the diff; a
  "nothing moves" check from the biggest change against frame 0.
- Phone-size review: `ae_contact_sheet` at 360 px wide.
- Delivery presets for social (H.264 high, yuv420p, limited-range BT.709, AAC, faststart),
  checked by `ae_check_delivery_file`.

## Not taken

- ESC Tools (Element Supply Co. AEGP): dropped on 2026-11-05. It patches After Effects' own code
  at run time (vtables, click handlers), not a regular SDK plugin, and its licence forbids
  bundling it.
- HTML, GSAP and HyperFrames runtime rules: they don't apply to AE.
