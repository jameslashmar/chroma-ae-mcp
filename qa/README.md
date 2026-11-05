# Chroma AE QA Harness

Automated After Effects ExtendScript test harness for VoxMark and Gulp, built on the `chroma-ae-mcp` CEP HTTP bridge (`http://127.0.0.1:7790`).

## Requirements

- **Node.js 20+** (plain ESM, zero external dependencies)
- **After Effects** running with the `chroma-ae-mcp` CEP service extension loaded
- **Project Isolation Precondition:** AE must have either:
  1. An **unsaved and empty** project open (`!app.project.file` and `app.project.numItems === 0`), or
  2. A project saved under a path containing `/_work/qa`.

If any other project is open, `runner.js` refuses to start and never closes or modifies it.

## Layout

- `qa/client.js` — Reads the bearer token from `%LOCALAPPDATA%/chroma-ae-mcp/token` and calls `/health`, `/eval`, and raw `/eval` (`raw: true`, which evaluates scripts at ExtendScript global scope without the function/try wrapper so `$.evalFile` defines global functions).
- `qa/runner.js` — Enforces the isolation guard, resets the QA project per scenario (`app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` → `app.newProject()`), never suppresses dialogs (Jay's rule; a blocking popup is read and reported), creates and opens the scenario composition in the viewer, loads product JSX via raw `$.evalFile`, runs the scenario action, runs assertions via separate `evalScript` reads, and writes reports to `qa/out/`.
- `qa/assert.js` — Assertion helpers for markers, layers, project items, frame pixels, and timestamps (with frame or second tolerance).
- `qa/report.js` — Writes `qa/out/junit.xml` (JUnit XML) and `qa/out/report.md` (Markdown report).
- `qa/scenarios/voxmark/` — VoxMark scenarios 1–3:
  - `01-markers-speakers.mjs` — `createCompMarkers` marker comments, durations, speaker label colours (`VOXMARK_LABEL_CYCLE`), and hidden `voxmarkVoice` / `voxmarkText` parameters.
  - `02-edit-in-place.mjs` — `updateMarkerTextAtTime` in-place caption edit and preservation of neighbouring markers.
  - `03-selective-purge.mjs` — `removeMarkersAtTimes` selective removal of transcript markers while preserving a user marker.

## Running Scenarios against After Effects

```bash
# Run all default VoxMark scenarios
node qa/runner.js

# Run a specific scenario directory or file
node qa/runner.js qa/scenarios/voxmark/01-markers-speakers.mjs
```

Reports are written to `qa/out/junit.xml` and `qa/out/report.md`.

## Live smoke test of the MCP tools

`qa/smoke-mcp.mjs` calls every chroma-ae-mcp tool through the panel's MCP endpoint (`POST /mcp`) against the After Effects on this machine:
- It builds its own comp, names the untitled project with `ae_save` `save_as` (`ae_run_jsx` refuses `project.save` now), and runs each write tool, checking the auto checkpoint each one reports.
- It runs `ae_motion_review` before and after `ae_set_keyframe_ease` easy-eases the linear Dot, so the review, fix and re-review loop is covered.
- It runs each read tool, plus a five-frame background `aerender`.
- It takes about a minute for the tools up to 0.4. The waves 1-3 steps (below) add a render batch, a delivery run, a file collect and a project close and reopen, and the waves 4-5 steps add track, patch and inpaint renders of a few frames each, so the whole run takes several minutes.

```bash
node qa/smoke-mcp.mjs                       # work dir: <tmp>/_work/qa/mcp-smoke/<stamp>
node qa/smoke-mcp.mjs --dir D:/_work/qa/smoke
```

- It uses the same isolation guard as `runner.js`, so it refuses to start if anything but an empty, QA-owned or `/_work/qa` project is open.
- The project it leaves open sits under `/_work/qa`, so it can be run again straight away.
- Results go to `qa/out/smoke.json`, and the exit code is 1 on any failure.
- `ae_ui_screenshot` passes when AE is minimized too, because it then reports `ae_minimized` instead of an image.
- It covers the skills (a project skill saved, listed and run into its own comp), data builds, a 9:16 reframe, the asset import and diagnostics. The global skills folder and the asset watcher setting are left alone.

### Waves 1-3 steps

The 69 tools added in waves 1-3 (layer ops, multi-comp apply, annotate, comp settings, preflight, session changes, captions, rig and recipes, fit text, stagger, time remap, camera, explain, describe, scrub, footage interpretation, paths, memory, render queue edits, render batch, collect, deliver, loudness, legibility, variants, learn taste, project session) have steps in the smoke test. **No wave 1-3 tool has run in a live After Effects**; the steps come from the tools' schemas and results, so expect to adjust some arguments and checks on the first run.

- Each group works in a scratch comp of its own (`Wave Work`, `Wave Ops`, `Wave Captions`, `Wave Remap`, `Wave Cam`, `Wave Legibility`, `Wave Variants`, `MC A`, `MC B`), so the Smoke, Layers and Audio comps keep what the older checks read.
- The block before the first plain `ae_save` (the `save_as` at the top takes no checkpoint) holds the authoring and read tools. Loudness (it renders the Audio comp with aerender) comes after the reads.
- A late block after the aerender and verify steps holds what renders for a while or changes the open project, in this order: scrub of the rendered PNG, render queue edits (the queue is cut back to its first item), render batch, delivery chain, collect (files, zip, report, relink), the memory purges that can drop the undo history, and project session. `ae_collect_relink` closes the project and reopens it; `ae_project_session` is last (the wave 5 `ae_save` `save_as` and `increment` steps sit inside it, between `new` and `close`), and it should end with an empty untitled project open, which the isolation guard accepts on the next run. If AE will not report the project's dirty flag, the smoke discards its own scratch project to get there; if that fails, Smoke.aep stays open, which the guard also accepts.
- Steps that this scratch project cannot support are logged as `SKIP` with the reason, listed under `skipped` in `qa/out/smoke.json`, and do not count as failures: footage interpretation of video (alpha, fields, pulldown, conform, loop: the project has stills and a WAV only), the comp loudness measure when AE has no AIFF 48 kHz output module template, a spec apply that this AE cannot meet, the render batch and delivery chain when there is no PNG or Lossless output module template, a cancel of a running batch (too short to catch), the `ram` memory purge on an AE older than 24.3, the session-changes checks when session tracking is off, and the `all` memory purge (it wipes the disk cache).
- The dry runs, refusals and read tools need nothing special. Writes check `applied` and `receipt.matches`.
- Not covered by any step: `ae_acknowledge`, `ae_aerender_cancel`, `ae_checkpoint_revert`, `ae_dialog_respond` and `ae_open_panel` (older tools that need a person, a dialog or a long job).
- **First live run (AE 26.2.1) corrections.** `ae_import_assets` ages its still for real (a 2.5 s wait): `fs.utimesSync` moves only mtime, while the importer also counts ctime and birthtime, so the file still looked half-written and nothing was imported. `ae_export_mogrt` is called without `allow_font_dialog`; the scene's Space Grotesk is installed locally, not from Adobe Fonts, so the tool must refuse and name the font (that refusal is the pass; AE would otherwise open a modal "fonts were not synced from Adobe" dialog that blocks the whole queue). `ae_render_queue_apply_spec` passes when the only skipped key is Channels `RGB` (an H.264 template has no Channels key); any other skipped key, such as Audio Sample Rate or Output Audio, fails the step. `ae_dialogs` shows the OK of an AE-painted dialog as `OK` (OCR reads `0K`, kept as `raw_name`); a two-button AE-painted dialog can only be cancelled unattended.
- `ae_learn_taste` and `ae_taste_baseline` write to the server's learn-taste ledger (not the project) and `ae_taste_rules` is only called to be refused or listed, so no taste rule is saved. Each run adds a baseline to that ledger, which keeps 20, so it can push out the user's oldest baseline; run the smoke against a server with its own data dir to avoid that.

### Waves 4-5 steps

The 18 compositing tools of wave 4 (planar tracking, stabilize, clean plate, inpaint, mattes, patch fits, patch check, screen replacement) and the 6 new tools of wave 5 (`ae_create_comp`, `ae_project_items`, `ae_project_settings`, `ae_view`, `ae_keyframes_transform`, `ae_detect_cuts`), with the wave 5 extensions of older tools, have steps in the smoke test. **None of them has run in a live After Effects.** The arguments come from the current zod schemas (every call was also validated against them offline, with a fake endpoint, which only proves the arguments are accepted); the checks on results are first guesses, so expect to adjust some on the first run. The build handoffs were only a start: some of their steps used helpers that do not exist (`ae_undo`, `ae_comp_create`) or arguments that changed.

- **One shared plate.** A scene step builds `W4 Plate Src` (640 x 360: fractal noise and twelve bright or dark squares) and shot comps of 480 x 270 in which that plate pans 16 px over half a second: `W4 Planar`, `W4 Stab`, `W4 Clean`, `W4 Inpaint`, `W4 Matte` and `W4 Locked` (its plate is locked, for a refusal). Three more comps cover what the moving plate cannot: `W4 CloneSrc` (the same plate with no keys, because `clone_offset` refuses a plate with animated transform keys), and `W4 Moving Src` with `W4 StabV` (the plate pans inside a precomp that sits on an unkeyed layer, so the picture moves while the layer has no keys; the stabilize residual check tracks and locks that one). `W4 Screen` holds a dark plate, a lighter 160 x 90 screen that pans and an insert comp. Tracks cover 0 to 0.2 s (6 frames), so each tracking call is a few renders. There is no undo tool, so each group has a shot of its own, and the stabilize group has a fresh plate for each call that refuses a plate that already has keys or effects.
- **Wave 5 comps.** `W5 Ops` (layer ops, masks, batch expressions), `W5 Alt` (a second solid to swap in), `W5 FX` (effects, shapes, views), `W5 Key` (keyframe transforms), `W5 Text`, `W5 3D` and `W5 Settings` (comp settings, resized, retimed and trimmed). Comps made by `ae_create_comp` are deleted again with `ae_project_items`; the placeholder is deleted too, so the collect and relink steps later see no missing footage.
- **Order.** The wave 4 and 5 steps sit after the learn-taste step and before the first plain `ae_save` (the `save_as` at the top takes no checkpoint), so they take no new auto checkpoint (the checkpoint list check counts them). The fonts replace (not undoable, needs a clean saved project and a checkpoint) comes right after the first `ae_save` of the late block. The batch plan with queue items runs inside the render queue block. The queue item flag, `aerender` with `rq_index`, its verify and the queue item removal come after that block and before the render batch. `ae_save` `save_as` and `increment` come last, from the untitled project that `ae_project_session` `new` makes, and the final close expects the incremented file (`SmokeSaveAs_v003.aep`): nothing after them uses `Smoke.aep`.
- **Gated steps.** A step that depends on an AE version, a font or a plug-in passes when it works, is logged as `SKIP` when AE or the tool refuses with the host's own words for the missing version or API (the pattern is tested against the refusal text only, not the whole reply), and fails otherwise, so any other refusal reads as FAIL: guide colour, pinned guides and the Set Matte stage (26.5), meshes, the focus options of the camera and the layer picker labels (26.3 / 26.0), vertical text (24.2), key labels (22.6), the environment light (24.3), a variable font axis (a font that is not variable is also logged as `SKIP`; the scratch text layer uses the default font), the unknown font refusals (need `app.fonts`, AE 24.0), the real font replace (24.5) and Scene Edit Detection (22.3).
- **Skipped by design, logged as `SKIP`.** AE Tracker data as a track source; `ae_cleanplate_setup` with source `still` and `reload` (they need a painted PNG); the Content-Aware Fill itself (no scripting API; `ae_caf_prep` and `find_fill` are covered); `ae_detect_cuts` modes that write (the project has no video with cuts; `list` is tried on a pre-comp layer and a text layer is refused); `ae_import_footage` `import_as` from a PSD or AI file (a script cannot write one; a PNG is refused); `ae_set_essential_graphics` `set_media` and the media slot `add` (need a template comp and a parent comp); `ae_render_templates` `save` (a template goes into the user's AE preferences; only the refusal is checked); `ae_remove_keyframes` with `keys: selected` on a real selection (only its dry run with no selection is covered; `ae_keyframes_transform` with `keys: selected` is tried on two keys that `ae_view` selects).
- **Live checks to read off the results.** The guide layer question for `ae_stabilize_roundtrip` (`picture_change` must be 0 and `guide_plate_renders_suspected` must not be set; if it is, build the rig with `guide_mode` `opacity_switch`), the effect parameter tables (`param_tables` of `ae_stabilize`, the `pin.param_table` of `ae_screen_replace` and `ae_track_read`: CC Power Pin and Corner Pin point order, Levels, Exposure and grain parameters), the Wiggly and Expression selector children of `ae_text_animator`, and the Final Output menu items of the grain effects (`viewing_mode_index`).
- **Left on the machine.** The inpaint stills in `<project> chroma plates/`, the stored tracks under `%LOCALAPPDATA%/chroma-ae-mcp/tracks` and the patch fit chunk state. The unsafe skill that is refused is never saved.

## Live job for a self-hosted runner

`qa/ci-live.mjs` is what `.github/workflows/ae-live.yml` runs on a runner with After Effects (`docs/CI-RUNNER.md`). It waits for the panel service, checks that the CEP extension points at this checkout, reloads the service through its debug port (8097) so this checkout's bundle and `host/ext/*.jsx` load, then runs the smoke test in a fresh `_work/qa/ci/<stamp>` folder.

```bash
node qa/ci-live.mjs --wait 300 [--start-ae "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe"]
```

## Running Offline Unit Tests

```bash
node --test qa/test/harness.test.mjs
```
