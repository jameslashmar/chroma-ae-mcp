# Choreography, cameras and transitions

## Groups

- **One hero per moment.** The hero leads, with the largest displacement. Everything else is
  secondary or still; dim non-heroes to 40-60 % opacity when the hero needs the stage.
- **Density:** with three or more elements, at most a third move at the same time. Two or three
  moving things at once is the attention budget.
- **Distance:** nothing travels more than a third of the frame without an intermediate key or an
  arc.
- **One origin direction** for a group. Counter-motion, when used, runs at 20-30 % of the main
  speed.
- **Shared trigger:** elements meant to start together start within 50 ms of each other.
- **Overlap:** start the next element when the previous is 30-50 % done. Methodical work uses 0 %
  overlap, brisk 25 %, fluid 50 %, rapid 75 %.
- **Resolve:** 100-200 ms of stillness after the group lands, then the next idea.
- **Containers first:** a shell opens before its content arrives; text waits until there is room.
- **Shared elements travel:** a title that moves from one layout to another is the same layer
  moving, never a duplicate fading in.
- **Depth by speed:** foreground 1.0x, mid 0.5x, background 0.2x, far 0.1x. One vanishing point
  for every layer.

## Stagger

| Kind | Delay | Total |
|---|---|---|
| Letters | 1 frame | |
| Words | 60-120 ms | |
| List items, cards, rows | 40-80 ms | |
| Bars in a chart | 60-100 ms, fills 0.8-1.2 s | |
| Micro (UI) | 20-40 ms | under 200 ms |
| Standard | 50-100 ms | under 400 ms |
| Dramatic | 100-200 ms | under 600 ms |

- A group's total stagger stays near 500 ms so it reads as one beat; longer than that and it
  reads as a list being read out.
- Order by importance, not by layer order. Patterns: from the centre, from the edges, seeded
  random. Same ease for the whole group; only the start times differ.
- Path draws: stagger segments at 70-80 % of a segment's duration so the line reads as one stroke;
  draw with linear for a pen-like trace.
- Per-word kinetic type: the slide distance can decay per word (80, 60, 50, 25, 12 px), as if the
  camera is settling.

## Scene shape

Build 0-30 %, breathe 30-70 % (one small thing alive), resolve 70-100 %. The breathe phase is
where a hold must still show one sign of life (a progress creep, a light sweep, a slow drift on
the background), never a title that keeps moving.

**Loops** (stings, covers, GIFs): move 0-2.2 s, hold 2.2-6.6 s, return 6.6-8.0 s on an 8 s loop;
the last frame equals frame 0 exactly, and the return eases back rather than snapping. For a GIF,
rotate the loop so the first frame is the finished picture. For a short B-roll cut, keep only the
active move (about 1.4 s) and hold the end.

## Cameras

- One camera, or one parent null, carries the move; the content never moves to fake a camera.
- A camera move eases in-out (sine or quad). Phased moves (pull back, focus, push) step in scale,
  with a very slow continuous drift so the frame is never dead still while the camera is "on".
- Punch-in or Ken Burns: scale and position on a wrapper or precomp, never on the footage layer
  itself. A still image on screen gets at least a 1.00 to 1.04 scale over its beat.
- Rack focus: blur and dim the off-focus layers; the change runs with the push, in the same
  window.
- A late, slow push-in that starts after the viewer has read the frame looks generated. Push
  while the eye is still arriving.

## Transitions

**Principle:** the outgoing and incoming motion happen at the same time and the motion is the
handoff. Do not fade out, then fade in. Only the final scene has an exit of its own.

- **Velocity match:** cut at the fastest frame. The exit eases in, the entry eases out, and the
  speeds on either side of the cut agree within about 5 %. Direction, axis and the sign of any
  scale change match across the cut (a push stays a push).
- **One current:** pick the film's dominant seam direction and never run two consecutive seams in
  opposite directions.
- **Variety with a cause:** 3-5 kinds per film, each with something on screen that causes it.
  One primary kind for 60-70 % of seams, one or two accents. At most a third of seams are hard
  cuts. Never crossfade between two different worlds.
- **Placement:** the opening transition is the most distinctive (0.4-0.6 s); between related
  points use the primary (about 0.3 s); a topic change uses a different kind; the climax is the
  boldest and fastest; the wind-down is gentle (0.5-0.7 s); the outro is the slowest and simplest
  (0.6-1.0 s).

| Energy | Duration | Ease | Blur crossfade |
|---|---|---|---|
| Calm | 0.5-0.8 s | sine in-out | 20-30 px over 0.8-1.2 s |
| Medium | 0.3-0.5 s | quad or cubic | 8-15 px over 0.4-0.6 s |
| High | 0.15-0.3 s | quart or expo | 3-6 px over 0.2-0.3 s |

Presets: instant 0.15 s · snappy 0.2 s · smooth 0.4 s · dramatic 0.5 s · gentle 0.6 s · luxe
0.7 s.

**Recipes**
- **Whip:** exit 400 px with 24 px blur over 0.3 s on cubic in; entry from the other side with the
  blur clearing over 0.3 s. A short smear version is 0.13-0.3 s.
- **Zoom-through:** exit scale 1.0 to 1.2 with 10 px blur (text) or 18-20 px (full frame) over
  0.2 s, cubic in; entry scale 0.75 to 1.0 over 0.5 s, expo out. Through a button: track to it
  over 0.6 s, then scale 8 % to 250 % over 0.35 s on a strong ease in.
- **Object becomes the world:** the object grows over about 0.65 s while the surroundings blur
  15 px.
- **Morph:** one shape becomes the next meaning over about 0.2 s, cubic out, with a horizontal
  blur from 12 px to 0. A shape changing is premium; two pictures crossfading is cheap. Leave a
  faint ghost of the start state when it helps the read.
- **Cut the curve:** partial travel of about 12 % of the frame (230 px at 1920), exit quart in
  over 0.2-0.4 s, entry quart out.
- **Colour flood:** about 0.4 s, sine or quad in-out.
- **Dip cut:** darken the outgoing frame about 40 % for 3 frames, then hard cut.
- **Iris from a click:** 0.15 s.
- **Velocity-matched blur cut:** exit 0.33 s quad in with blur to 30 px; entry 1.0 s quad out from
  30 px.
- Blinds: calm 4 horizontal or 6 vertical; medium 6-8 or 8; high 12-16 or 16. Avoid visible
  repeating patterns (tiles, grids, dot arrays) as transitions; organic noise is fine.

**Feedback mapping:** "too fast" usually means slow the zooms and pans to about 0.7x, not
everything. "Feels like slides" means enter the next scene through an object already on screen.

## Motion primitives by meaning

Choose the device by what the moment means, not from a menu of effects:

| Meaning | Device |
|---|---|
| Disclosure, reveal | mask or matte reveal (not opacity) |
| A route, a process, a connection | path draw |
| One scene replacing another | clip or shape wipe with a real midpoint |
| A list | stagger, with a hold after it |
| A number | count up, then lock; the number is the largest thing on screen |
| A change of state | morph, or the same element moving |
| Emphasis | a highlight band swept on after the text lands, or one scale pulse to about 1.12 |

Lines and connectors are anchored at both ends to something with a job, or replaced by a signal
on the component itself (a dot, an edge highlight, a progress strip).
