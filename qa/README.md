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
- It builds its own comp, saves it, and runs each write tool, checking the auto checkpoint each one reports.
- It runs `ae_motion_review` before and after `ae_set_keyframe_ease` easy-eases the linear Dot, so the review, fix and re-review loop is covered.
- It runs each read tool, plus a five-frame background `aerender`.
- It takes about a minute for the tools up to 0.4. The waves 1-3 steps (below) add a render batch, a delivery run, a file collect and a project close and reopen, so the whole run takes several minutes.

```bash
node qa/smoke-mcp.mjs                       # work dir: <tmp>/_work/qa/mcp-smoke/<stamp>
node qa/smoke-mcp.mjs --dir D:/_work/qa/smoke
```

- It uses the same isolation guard as `runner.js`, so it refuses to start if anything but an empty, QA-owned or `/_work/qa` project is open.
- The project it leaves open sits under `/_work/qa`, so it can be run again straight away.
- Results go to `qa/out/smoke.json`, and the exit code is 1 on any failure.
- `ae_ui_screenshot` passes when AE is minimized too, because it then reports `ae_minimized` instead of an image.
- It covers the skills (a project skill saved, listed and run into its own comp), data builds, a 9:16 reframe, the asset import and diagnostics. The global skills folder and the asset watcher setting are left alone.

### Waves 1-3 steps (not run live yet)

The 69 tools added in waves 1-3 (layer ops, multi-comp apply, annotate, comp settings, preflight, session changes, captions, rig and recipes, fit text, stagger, time remap, camera, explain, describe, scrub, footage interpretation, paths, memory, render queue edits, render batch, collect, deliver, loudness, legibility, variants, learn taste, project session) have steps in the smoke test. **No wave 1-3 tool has run in a live After Effects**; the steps come from the tools' schemas and results, so expect to adjust some arguments and checks on the first run.

- Each group works in a scratch comp of its own (`Wave Work`, `Wave Ops`, `Wave Captions`, `Wave Remap`, `Wave Cam`, `Wave Legibility`, `Wave Variants`, `MC A`, `MC B`), so the Smoke, Layers and Audio comps keep what the older checks read.
- The block before the first `ae_save` holds the authoring and read tools. Loudness (it renders the Audio comp with aerender) comes after the reads.
- A late block after the aerender and verify steps holds what renders for a while or changes the open project, in this order: scrub of the rendered PNG, render queue edits (the queue is cut back to its first item), render batch, delivery chain, collect (files, zip, report, relink), the memory purges that can drop the undo history, and project session. `ae_collect_relink` closes the project and reopens it; `ae_project_session` is last, and it should end with an empty untitled project open, which the isolation guard accepts on the next run. If AE will not report the project's dirty flag, the smoke discards its own scratch project to get there; if that fails, Smoke.aep stays open, which the guard also accepts.
- Steps that this scratch project cannot support are logged as `SKIP` with the reason, listed under `skipped` in `qa/out/smoke.json`, and do not count as failures: footage interpretation of video (alpha, fields, pulldown, conform, loop: the project has stills and a WAV only), the comp loudness measure when AE has no AIFF 48 kHz output module template, a spec apply that this AE cannot meet, the render batch and delivery chain when there is no PNG or Lossless output module template, a cancel of a running batch (too short to catch), the `ram` memory purge on an AE older than 24.3, the session-changes checks when session tracking is off, and the `all` memory purge (it wipes the disk cache).
- The dry runs, refusals and read tools need nothing special. Writes check `applied` and `receipt.matches`.
- Not covered by any step: `ae_acknowledge`, `ae_aerender_cancel`, `ae_checkpoint_revert`, `ae_dialog_respond` and `ae_open_panel` (older tools that need a person, a dialog or a long job).
- `ae_learn_taste` and `ae_taste_baseline` write to the server's learn-taste ledger (not the project) and `ae_taste_rules` is only called to be refused or listed, so no taste rule is saved. Each run adds a baseline to that ledger, which keeps 20, so it can push out the user's oldest baseline; run the smoke against a server with its own data dir to avoid that.

## Live job for a self-hosted runner

`qa/ci-live.mjs` is what `.github/workflows/ae-live.yml` runs on a runner with After Effects (`docs/CI-RUNNER.md`). It waits for the panel service, checks that the CEP extension points at this checkout, reloads the service through its debug port (8097) so this checkout's bundle and `host/ext/*.jsx` load, then runs the smoke test in a fresh `_work/qa/ci/<stamp>` folder.

```bash
node qa/ci-live.mjs --wait 300 [--start-ae "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe"]
```

## Running Offline Unit Tests

```bash
node --test qa/test/harness.test.mjs
```
