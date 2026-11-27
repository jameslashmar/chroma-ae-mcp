# Task bench results

## 2026-11-27: AE 27.0x78 (Windows), Claude Code 2.1.332, core toolset

The first run. Every task passed; the two failed calls were recovered by Claude itself:

- T11: `idempotency_key_reused`, a key from an earlier session in another project. Fixed in the same PR: keys are now scoped to the project.
- T15: `ae_render_templates` on an empty queue. It needs `allow_temp`, which the message names.

Cost for the same one-line question, measured the same day: $0.27 with the core toolset, $2.35 with the full one (136 tool schemas, about 143k tokens sent with every request).


15/15 passed. Toolset core, model claude-opus-5-5. Total $3.30, 124 tool calls (2 failed), 8 min.

| Task | Result | Tool calls (failed) | Turns | Cost | Time |
|---|---|---|---|---|---|
| T01-title Title card: new comp with centred text | pass | 10 (0) | 11 | $0.32 | 30 s |
| T02-fade Fade a layer in and out | pass | 5 (0) | 6 | $0.13 | 21 s |
| T03-pop Scale pop with overshoot | pass | 11 (0) | 12 | $0.36 | 55 s |
| T04-slide Slide in from the left with ease-out | pass | 13 (0) | 14 | $0.27 | 39 s |
| T05-stagger Staggered fade-in of five layers | pass | 6 (0) | 7 | $0.15 | 25 s |
| T06-shadow Drop shadow effect with settings | pass | 4 (0) | 5 | $0.12 | 16 s |
| T07-color Change a solid's colour (checked on the rendered pixel) | pass | 4 (0) | 5 | $0.11 | 12 s |
| T08-precompose Precompose five layers | pass | 5 (0) | 6 | $0.12 | 12 s |
| T09-null Null controller parenting without a jump | pass | 8 (0) | 9 | $0.23 | 31 s |
| T10-mask Feathered elliptical mask | pass | 6 (0) | 7 | $0.14 | 12 s |
| T11-trim Trim a layer | pass | 6 (1) | 7 | $0.14 | 20 s |
| T12-rotate Continuous rotation | pass | 7 (0) | 8 | $0.15 | 20 s |
| T13-captions Captions from an SRT file | pass | 9 (0) | 10 | $0.29 | 23 s |
| T14-track Track a moving square and attach a layer | pass | 19 (0) | 20 | $0.49 | 83 s |
| T15-render Render one second as a PNG sequence | pass | 11 (1) | 12 | $0.28 | 58 s |

### T01-title: pass

Prompt: Create a new 1920x1080 composition called 'Title Card', 6 seconds long at 25 fps. Put the text 'Hello World' in the middle of the frame, in white, 120 px.

- ok size 1920x1080: 1920x1080
- ok 6 s: 6
- ok 25 fps: 25
- ok text 'Hello World': "Hello World"
- ok 120 px: 120
- ok white: [1,1,1]
- ok centred (±40 px): 960, 540

Tools: ae_status, ae_get_project, ae_get_tool_schema, ae_create_comp, ae_create_layer, ae_set_text, ae_run_jsx, ae_snapshot_frame, ae_save, Read

Claude said: I made a new comp called "Title Card" (1920×1080, 25 fps, 6 seconds) with "Hello World" in white at 120 px, centered on the frame, and saved the project. The text is set in Times New Roman, the default font, because you didn't name one. In my preview frame the background showed as white instead of t

### T02-fade: pass

Prompt: In the 'Main' comp, make the 'Logo' layer fade in over the first second and fade out over the last second.

- ok transparent at 0 s: 0
- ok half-way at 0.5 s: 50
- ok opaque from 1 s to 9 s: 100, 100, 100
- ok half-way at 9.5 s: 50
- ok transparent at the end: 4

Tools: ae_status, ae_get_comp, ae_get_layer_props, ae_set_property, ae_save

Claude said: I keyframed the 'Logo' opacity in 'Main' to fade in from 0% to 100% over 0–1s and out from 100% to 0% over 9–10s, and saved the project. The last frame, at 9.96s, still shows about 4% opacity because the final keyframe sits at the 10s end.

### T03-pop: pass

Prompt: Make the 'Logo' layer in 'Main' pop in at 1 second: scale it from 0% to 100% in half a second with a little overshoot, then let it settle.

- ok not visible before 1 s: 0
- ok about 0% at 1 s: 0
- ok overshoots past 100% (but not wildly): 110
- ok settles at 100% by 2.4-3 s: 100, 100

Tools: ae_status, ae_plan, ae_get_layer_props, ae_get_comp, ae_get_tool_schema, ae_set_property, ae_invoke_tool, ae_invoke_tool, ae_invoke_tool, ae_invoke_tool, ae_save

Claude said: I keyed the 'Logo' layer's Scale in 'Main' to go from 0% at 1.0 s, overshoot to 110% at 1.32 s and ease back to settle at 100% at 1.5 s, then saved the project; the 1.5 s key falls between two frames at 25 fps, and the 10% overshoot is my choice for "a little."

### T04-slide: pass

Prompt: Slide the 'Card' layer in 'Main' in from off the left edge of the frame to the centre over the first second, easing out at the end.

- ok off the left edge at 0 s (right edge ≤ 20 px): -20
- ok centred at 1 s: 960, 540
- ok stays centred: 960
- ok eases out (slower at the end than at the start): start 69.22 px/frame, end 1.03

Tools: ae_status, ae_plan, ae_get_comp, ae_get_layer_props, ae_get_project, ae_set_property, ae_get_tool_schema, ae_invoke_tool, ae_snapshot_frame, ae_snapshot_frame, Read, Read, ae_save

Claude said: I keyframed the Card's Position in Main so it starts fully off the left edge at 0 s (x = −320, which fits the 600 px card) and reaches the centre (960, 540) at 1 s, with an ease-out (speed 0, 75% influence) on the last key; I checked frames at 0 s and 0.4 s and saved the project.

### T05-stagger: pass

Prompt: Make the five 'Item' text layers in 'Main' fade in one after another, 0.2 seconds apart, each fade lasting 0.5 seconds, starting with Item 1 at 0 seconds.

- ok Item 1 fades in from 0 s to 0.5 s: 0 / 0 / 50 / 100 / 100
- ok Item 2 fades in from 0.2 s to 0.7 s: 0 / 0 / 50 / 100 / 100
- ok Item 3 fades in from 0.4 s to 0.9 s: 0 / 0 / 50 / 100 / 100
- ok Item 4 fades in from 0.6 s to 1.1 s: 0 / 0 / 50 / 100 / 100
- ok Item 5 fades in from 0.8 s to 1.3 s: 0 / 0 / 50 / 100 / 100

Tools: ae_status, ae_get_project, ae_get_comp, ae_run_jsx, ae_batch_set, ae_run_jsx

Claude said: I added linear Opacity keyframes from 0% to 100% on the five Item layers in 'Main', and read them back to confirm: Item 1 fades over 0–0.5s, Item 2 over 0.2–0.7s, Item 3 over 0.4–0.9s, Item 4 over 0.6–1.1s and Item 5 over 0.8–1.3s. Each fade lasts 0.5s, but at 25fps that's 12.5 frames, so the end ke

### T06-shadow: pass

Prompt: Add a drop shadow to the 'Logo' layer in 'Main', with 50% opacity and a distance of 10.

- ok Drop Shadow on: true
- ok opacity 50%: 127.5
- ok distance 10: 10

Tools: ae_status, ae_get_project, ae_add_effect, ae_save

Claude said: I added a Drop Shadow effect to the 'Logo' layer in 'Main' with 50% opacity and a distance of 10, then saved the project. After Effects stores that opacity as 127.5 on its 0–255 scale.

### T07-color: pass

Prompt: Change the colour of the 'BG' solid in 'Main' to #1E90FF.

- ok pixel is #1E90FF (30,144,255) ±6: 30,144,255

Tools: ae_status, ae_get_project, ae_layer_ops, ae_layer_ops

Claude said: I changed the 'BG' solid in 'Main' from grey (0.5, 0.5, 0.5) to #1E90FF (30, 144, 255), and the read-back confirms the new colour; no other layer uses that solid and the project hasn't been saved.

### T08-precompose: pass

Prompt: Precompose the layers 'Item 1' to 'Item 5' in 'Main' into a new composition called 'List'.

- ok comp 'List' exists: yes
- ok 'List' holds Item 1-5: Item 1, Item 2, Item 3, Item 4, Item 5
- ok 'Main' uses 'List' instead of the five layers: uses List: true, text items left: 0

Tools: ae_status, ae_search_tools, ae_get_tool_schema, ae_get_comp, ae_invoke_tool

Claude said: I precomposed 'Item 1' to 'Item 5' from 'Main' into a new comp called 'List' (1920×1080, 10 s, layers in their original order), and 'Main' now holds only the 'List' precomp layer at index 1; the change is not saved yet.

### T09-null: pass

Prompt: Add a null called 'Controller' to 'Main' and parent all five 'Item' text layers to it, without them moving on screen.

- ok Item 1 parented, still at (960, 350): parented true, at 960, 350
- ok Item 2 parented, still at (960, 460): parented true, at 960, 460
- ok Item 3 parented, still at (960, 570): parented true, at 960, 570
- ok Item 4 parented, still at (960, 680): parented true, at 960, 680
- ok Item 5 parented, still at (960, 790): parented true, at 960, 790

Tools: ae_status, ae_get_project, ae_get_comp, ae_run_jsx, ae_create_layer, ae_layer_ops, ae_run_jsx, ae_save

Claude said: I added a 'Controller' null at the centre of 'Main' (960, 540) and parented Item 1–5 to it; all five are still exactly where they were on screen (x 960, y 350 to 790), and I saved the project.

### T10-mask: pass

Prompt: Add an elliptical mask to the 'Photo' layer in 'Main' that fills the layer, with a 20 px feather.

- ok an ellipse (4 curved vertices): 4 vertices, tangents 883.66
- ok fills the 800x800 layer (±40 px): 0, 800, 0, 800
- ok 20 px feather: 20, 20
- ok not inverted: false

Tools: ae_status, ae_search_tools, ae_get_tool_schema, ae_get_comp, ae_run_jsx, ae_invoke_tool

Claude said: I added an elliptical mask called "Ellipse Mask" to the 'Photo' layer in 'Main': it covers the full 800×800 layer (box 0, 0, 800, 800), is set to Add with a 20 px feather, and the read-back matches.

### T11-trim: pass

Prompt: Trim the 'Clip' layer in 'Main' so it starts at 2 seconds and ends at 5 seconds.

- ok starts at 2 s: 2
- ok ends at 5 s: 5

Failed tool calls:
- ae_layer_ops: {"kind":"evalscript_error","code":"idempotency_key_reused","outcome":"not_applied","message":"idempotency_key \"t11-trim-clip-2-5\" was already used for a ae_la

Tools: ae_status, ae_get_project, ae_get_comp, ae_layer_ops!, ae_layer_ops, ae_save

Claude said: I trimmed the 'Clip' layer in 'Main' so it now runs from 2 s to 5 s instead of 0–10 s; I checked the layer afterwards and saved the project, with a backup of the previous version in `_mcp_backups`.

### T12-rotate: pass

Prompt: Make the 'Gear' layer in 'Main' rotate continuously at 90 degrees per second for the whole comp.

- ok 90°/s (180° at 2 s, 360° at 4 s): 180, 360
- ok still turning at the end: 896.4

Tools: ae_status, ae_get_project, ae_get_comp, ae_get_layer_props, ae_set_property, ae_run_jsx, ae_save

Claude said: The 'Gear' layer in 'Main' now turns at a steady 90° per second for the whole 10-second comp, using two linear Rotation keyframes (0° at 0s, 900° at 10s); I checked it reads 225° at 2.5s and 450° at 5s, and saved the project.

### T13-captions: pass

Prompt: Add captions to the 'Main' comp from the subtitle file <path>

- ok cue 1 shown at 1 s: "Welcome to the show"
- ok nothing shown in the gap at 2.25 s: ""
- ok cue 2 shown at 3.25 s: "This is a caption test"
- ok cue 3 shown at 5.25 s: "Thanks for watching"

Tools: ae_status, ae_search_tools, Read, ae_get_tool_schema, ae_get_comp, ae_invoke_tool, ae_snapshot_frame, Read, ae_save

Claude said: I added the 3 subtitles from `subtitles.srt` to the 'Main' comp as white, centred text layers at the bottom ("Caption 001" 0.52–2.0 s, "002" 2.52–4.0 s, "003" 4.52–6.0 s), checked a rendered frame and saved the project. Each caption starts 0.02 s after the file's time because 0.5 s doesn't fall on a

### T14-track: pass

Prompt: In the 'Track' comp, track the white square moving across the 'Plate' footage and make the 'Label' layer follow it.

- ok moves with the square by 1.48 s (+434.13 px ±15): 434
- ok moves with the square by 2.96 s (+868.27 px ±15): 868
- ok no vertical drift (≤10 px): 0

Tools: ae_status, ae_plan, ae_get_tool_schema, ae_get_comp, ae_get_layer_props, ae_snapshot_frame, Read, ae_snapshot_frame, ae_snapshot_frame, Read, Read, ae_invoke_tool, ae_invoke_tool, ae_run_jsx, ae_snapshot_frame, ae_snapshot_frame, Read, Read, ae_save

Claude said: I tracked the white square in 'Plate' and keyed 'Label' to follow it, centred 10 px above the square; I moved the label from its original spot at 640,200 so it wouldn't run off the right edge, and the project is saved. - **Track:** the square was found on all 75 frames. It moves straight right, abou

### T15-render: pass

Prompt: Render the first second of the 'Main' comp as a PNG sequence into the folder <path>

- ok 25 PNG frames (24-26): 25
- ok 1920x1080: 1920x1080

Failed tool calls:
- ae_render_templates: {"ok":false,"code":"empty_queue","error":"empty_queue","message":"The render queue is empty. Add an item (ae_render_queue_add), or call again with allow_temp an

Tools: ae_status, ae_get_project, ae_get_tool_schema, ae_get_comp, ae_render_templates!, ae_render_templates, ae_run_jsx, ae_save, ae_aerender_start, ae_aerender_status, ae_run_jsx

Claude said: I rendered the first second of 'Main' (frames 0–24 at 25 fps) with aerender and the PNG template, and it wrote all 25 frames, `Main_0000.png` through `Main_0024.png`, into `<path>
