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

## Then

When all of this is green, commit, and produce the evidence on the commit: `node qa/live-evidence.mjs --notes <notes.json>` (an unsaved, empty AE project, a few minutes). A manual record from the Mac to include in the notes:

```json
{ "tool": "stdio-relay", "check": "full and core tools/list over 64 KB arrive whole on macOS against the live panel", "result": "pass",
  "notes": "panel/tools/stdio-relay.cjs from b68236d, Node 20.20.2, AE 26.2.1. 5 cases x 3 runs, all exit 0 and valid JSON: claude-code -> 180 tools, 806,881 chars; claude-ai and local-agent-mode-chroma-ae -> 36 tools, 80,744 chars; CHROMA_AE_MCP_TOOLSET=full with claude-ai -> 180; =core with claude-code -> 36. Windows reference: core 80,570, full 805,359." }
```
