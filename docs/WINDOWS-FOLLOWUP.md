# Windows follow-up for the macOS work of 2026-11-22

A session on a Mac (AE 26.2.1, Apple silicon) ran the live checks there for the first time and changed code that also runs on Windows. Everything below passed on the Mac: unit tests, the ES3 lint, `qa/live-reliability.mjs` 10/10, `qa/smoke-mcp.mjs` 573 of 574 with a render inside AE (the one failure was the keep-alive reset fixed in item 6). This page lists what to run and check on Windows before the change goes to `main`.

## What changed

| Area | Files | On Windows |
|---|---|---|
| Write outcomes: failed writes say `not_applied` or `unknown` with `next_steps`; successes say `applied` / `no_op` | `panel/host/core.jsx` (touched flag, `A.refuse`, `A.touch`), `panel/client/service.js` (resets the flag per eval), `server/src/host.ts`, `panel-host.ts`, `bridge.ts`, `tools/ext/write-runner.ts`, `tool-call.ts` | Same code |
| `A.touch()` before writes that have no undo group | `core.jsx` (`save`, `rqAdd`), `ext/collect`, `fingerprint`, `memory`, `projectsession`, `cleanplate`, `production`, `rqedit`, `view` | Same code |
| Idempotency keys for write tools, `ae_recent_ops` | `server/src/idempotency.ts`, `write-tools.ts`, `tool-call.ts`, `tools/quarantine.ts` | Same code |
| `ae_batch_set` reports chunks already written when a later one fails | `tools/ext/production.ts` | Same code |
| Frame grabs wait for a PNG still being written, never overlap a second render | `tools/ext/frames.ts`, `tools/render.ts` | Same code; the 26.3 crash it targets was seen on Windows |
| `ae_detect_cuts` refuses a pre-comp layer before asking AE | `panel/host/ext/timeline.jsx` | **Check item 1** |
| aerender: the file AE wrote under another extension is found | `tools/ext/aerender.ts` | Check item 3 |
| `Connection: close` on every reply of the panel service | `panel/client/service.js` | Check item 6 |
| `/health` reports `extensionDir`; `qa/ci-live.mjs` refuses a second copy of the extension and checks the folder AE loaded | `service.js`, `qa/ci-live.mjs` | Same code |
| macOS only: popup reading, preset folder, `ae_ui_screenshot`, `scripts/install-dev-mac.sh`, a macOS CI job | `panel/tools/ae-dialogs-mac.js`, `ae-window-mac.js`, `host/ext/effects.jsx`, `tools/ext/panels.ts`, `.github/workflows/ae-live.yml` | The preset lookup only adds a fallback |
| Smoke: video fixtures (ffmpeg), a variable font, cleanplate still/reload, track refusals, the render-in-AE steps | `qa/smoke-mcp.mjs` | Check item 7 |

## Run, in order

```powershell
cd server; npm ci; npm run build; npm test; npm run bundle; cd ..
node scripts/lint-jsx.mjs
pwsh scripts/install-dev.ps1        # then RESTART After Effects: core.jsx and service.js changed, a panel reload is not enough
node qa/cep-freeze-check.mjs        # item 5
node qa/live-reliability.mjs        # with an unsaved scratch project open; expect 10/10
node qa/smoke-mcp.mjs --dir <a fresh ..._work\qa\ folder>
$env:CHROMA_SMOKE_RENDER_IN_AE=1; node qa/smoke-mcp.mjs --dir <another fresh folder>   # once, with nothing else to do in AE
```

## Check on Windows

1. **Scene Edit Detection on a pre-comp layer.** AE 26.2.1 on macOS refuses it ("Unable to call doSceneEditDetection because the layer ... is not video layer"), so the host now refuses pre-comps up front. Before trusting that on Windows, ask AE directly in a scratch project (raw eval, nothing saved):
   ```
   var c = app.project.items.addComp("p", 320, 180, 1, 3, 25); var inner = app.project.items.addComp("i", 320, 180, 1, 3, 25);
   inner.layers.addSolid([1,0,0], "s", 320, 180, 1); var l = c.layers.add(inner); try { l.doSceneEditDetection(SceneEditDetectionMode.NONE).toString() } catch (e) { "refused: " + e }
   ```
   If Windows AE accepts it, make the refusal in `timeline.jsx` macOS-only (or version-gated) and change the smoke step "a pre-comp layer is refused" to expect the old behaviour there.
2. **AE misses a cut right after a semi-transparent shot** (macOS measurement: three shots with 60% alpha gave 1 cut instead of 2; the same shots opaque gave 2). The smoke uses the opaque clip for cuts. Worth knowing for the tool description if Windows behaves the same.
3. **aerender output under another extension.** On the Mac the default output module is H.264, so `smoke.avi` came out as `smoke.mp4`; the job now records the real file (`requested_output_path`, `output_note`). On Windows the default is Lossless AVI: run `ae_aerender_start` with `output_path` ending in `.mov` and no template, and check `ae_aerender_status` names the `.avi` that was written and `ae_verify_render` with the job id finds it.
4. **`ae_annotate_frame` on a 3D comp, AE 26.3 (PRISM).** The crash could not be reproduced on 26.2.1 (even 200 extruded layers at 4K render a frame in 1.4 s, and the PNG is complete when the eval returns). On 26.3, run the smoke step "ae_annotate_frame (a 3D comp)" and a heavy 3D comp; if a frame takes longer than 10 s the server now waits for it instead of sending a second render. Report whether AE still dies on the next call.
5. **Does CEP freeze during a long ExtendScript on Windows?** On the Mac it does: `qa/cep-freeze-check.mjs` shows `/health` answering only when the eval ends. That means the "busy" refusals (ae-activity.ts, about 1 s) cannot be fast on macOS: every call waits for the running eval. If Windows keeps answering, the busy design holds there and macOS needs its own answer (see the proposal in the review: run the MCP server outside the CEP page). Record the script's RESULT line on Windows.
6. **`Connection: close`.** Fixes a reset seen on the Mac: during a long eval the frozen page let Node's 5 s keep-alive timer close a socket a client had just reused (3 of 3 requests died with ECONNRESET before, 0 of 3 after). Check Claude Desktop (Store build too) and Claude Code through the relay still work: `server/test/stdio-relay.test.ts`, then one real tool call from each.
7. **Smoke on Windows.** New steps: video fixtures need ffmpeg on PATH (`winget install Gyan.FFmpeg`; without it those steps are skipped as before). The variable-font steps look for Bahnschrift on Windows; the W5Text step now passes whether its font is variable (Space Grotesk applies the axis) or not. Expect more checks than the 526 of the last Windows evidence.
8. **A second copy of the extension.** CEP loads every folder in `%APPDATA%\Adobe\CEP\extensions` (and the system CEP folder) that carries the id `london.chroma.aemcp`; on the Mac a moved-aside ZXP copy was loaded instead of the dev link and the tests ran the wrong code. `qa/ci-live.mjs` now refuses to run with a second copy in the user folder and checks `/health`'s `extensionDir`; check the system-wide folder by hand (DEVELOP.md: "a system-wide install hides the dev junction").
9. **Compositing calibration on Windows.** `qa/calibrate-compositing.mjs` (docs/CALIBRATION.md) measured the compositing tools on the Mac. Run it once on Windows with any photograph or clip that has texture: `node qa/calibrate-compositing.mjs --plate <file> --dir D:/_work/qa/calibrate` (ffmpeg on PATH). The 3D projection stage should read 0.000 px (it compares the maths with AE's own `toComp`, so it is the same everywhere); compare the rest with the Mac table, above all the Add Grain curve (`grain_curve`: Size 0.25 -> correlation 0.00, Size 1 -> 0.68, sigma per Intensity 8.6 and 2.6), which `ae_patch_grain` now relies on. If Windows differs, the curve in `patchfit.ts` (`ADD_GRAIN_CURVE`) needs a per-platform table.
10. **New and changed tools to try once on Windows:** `ae_camera_solve_check`, `ae_color_match_element`, `ae_matte_check`, `ae_patch_check` slip with `region_track`, `ae_patch_grain`'s measured Size, `ae_cleanplate_setup` reload's `painted_check` and the Corner-Pinned `clone_offset`, the track summaries' `lens`, the tool families (`ae_track { action: ... }`), and `ae_scene_3d_report` / `ae_annotate_frame include_3d` with a rotated camera (the rotation order was wrong before; it was up to 470 px off).

## Then

When all of this is green, commit, and produce the evidence on the commit: `node qa/live-evidence.mjs --notes <notes.json>` (an unsaved, empty AE project, a few minutes). A manual record from the Mac to include in the notes:

```json
{ "tool": "stdio-relay", "check": "full and core tools/list over 64 KB arrive whole on macOS against the live panel", "result": "pass",
  "notes": "panel/tools/stdio-relay.cjs from b68236d, Node 20.20.2, AE 26.2.1. 5 cases x 3 runs, all exit 0 and valid JSON: claude-code -> 180 tools, 806,881 chars; claude-ai and local-agent-mode-chroma-ae -> 36 tools, 80,744 chars; CHROMA_AE_MCP_TOOLSET=full with claude-ai -> 180; =core with claude-code -> 36. Windows reference: core 80,570, full 805,359." }
```

## Results on Windows, 2026-11-22

Emre's Windows PC, AE 26.2.1, Node 22.23.2, branch `mac/live-fixes-2026-11-22` (first run on `1159b80`, then rebased onto `b3a9b2a`). Two bugs were found and fixed on the way (`5b903d1`, `a4d01e1`); see `docs/HANDOVER.md`. Build, 5976 unit tests and the ES3 lint (0 issues) pass; `qa/live-reliability.mjs` 10/10.

1. **Pre-comp scene edit detection:** AE 26.2.1 on Windows refuses it too ("... is not video layer"). The up-front refusal in `timeline.jsx` is right on both; no change.
2. **Cut after a semi-transparent shot:** same as macOS. `shots_alpha.mov` (ProRes 4444, 60% alpha) gives 1 cut, `shots_opaque.mov` gives 2.
3. **aerender output under another extension:** not run. aerender is refused up front with `too_many_cep_extensions` (six other auto-starting CEP extensions on this PC; at least two must be turned off). Still unverified on Windows.
4. **`ae_annotate_frame` on a 3D comp, AE 26.3:** not run, AE 26.3 is not installed here. On 26.2.1 the smoke step passes.
5. **CEP freeze:** Windows keeps answering. RESULT: "the service keeps answering while AE runs ExtendScript." A 7 s eval (7.7 s) and a 12 s eval (13.3 s): `/health` in 3 ms on a new connection, 2 ms on a reused one, no reset. The busy refusals hold on Windows; macOS needs its own answer.
6. **`Connection: close`:** `stdio-relay.test.ts` passes. Dev relay as an MCP client: `claude-ai` 36 tools, 81,087 characters, 67 ms; `claude-code` 134 tools, 796,505 characters, 84 ms; inside the Claude Desktop Microsoft Store package 36 tools, 72 ms. Claude Code's HTTP connection made every call of the session without a reset. The Desktop app itself was not opened for a call.
7. **Smoke:** 578 checks (526 in the last Windows evidence). ffmpeg video fixtures, Bahnschrift variable font and the W5Text step pass. Failures are only the 12 aerender-family checks (item 3's cause).
8. **Second copy of the extension:** the system-wide folder held the released 0.7.4 panel, which CEP loaded in place of the dev link. It was moved out for the run and back afterwards. `qa/ci-live.mjs` scans only the user folder and does not see it; the `/health` `extensionDir` check does.
9. **Calibration:** projection 0.001 px max (Mac 0.000); the Add Grain curve is the same as the Mac's to two decimals, so no per-platform `ADD_GRAIN_CURVE`. Plate and other numbers in `docs/CALIBRATION.md`.
10. **New tools:** all ran in smoke wave 6 and the calibration and passed. Wave 6: projection 0.0006 px, solve check mean 0.028 px, element colour match left 1.17 levels, slip along `region_track` 0.029 px, matte check clean and the copy removed.

**Then (evidence):** `6a3637e`, `qa/live-evidence.mjs` on `de8388a`: 566/578 passed, 13 skipped, the 12 aerender failures explained in the notes, the in-AE render passed (2 items DONE, 5 frames, fps and size match).
