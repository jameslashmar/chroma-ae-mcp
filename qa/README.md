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

## Running Offline Unit Tests

```bash
node --test qa/test/harness.test.mjs
```
