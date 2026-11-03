# chroma-ae-mcp

An MCP server that lets Claude Code, Claude Desktop, Cursor and Codex drive **Adobe After Effects 2026** (AE 26.x, CEP 12) safely, alongside a person who is editing live. It runs **inside After Effects** and starts with it, so there is no separate server to install or run.

This is an internal Chroma tool, not a consumer product.

> **Status: v0.3.0, released 2026-10-30** (signed ZXP on the [v0.3.0 release](https://github.com/jameslashmar/chroma-ae-mcp/releases/tag/v0.3.0)).
> - 55 tools, live-tested on AE 26.2.1 (Windows). The live smoke test exercises every tool.
> - CI runs the build, 258 unit tests, the ExtendScript lint, and the in-panel MCP end to end on AE's own Node (17.7.2).
> - macOS should work but is untested. Popup reading on macOS is written and unit-tested, but has not been run on a Mac.
>
> **Next: 0.4, unreleased** (branch `feat/roadmap-0.4`). 80 tools: the 25 new ones (layers, audio, markers, keyframes, shapes, masks, Essential Graphics, versions, layout, house style, render checks) pass the build, the unit tests and the ExtendScript lint, and their host code runs against a simulated AE DOM. **They have not been run in After Effects yet**; the live smoke test covers each of them and is the next step.

## What it can do

- **Read** the project, comps, layers, effects and keyframes, in bounded, paged calls.
- **Write** values, keyframes, expressions, text, footage and effects. Every write is guarded, one undo step, checkpointed and read back.
- **Look at motion**: render frames, tile them into contact sheets, graph a property's value and speed, and review a comp's animation the way an animator would, with ready easing fixes.
- **Produce versions**: one comp per CSV/JSON row, social reframes to 16:9, 1:1, 4:5 and 9:16, assets dropped in a folder imported into a bin, and saved recipes ("skills") for house rigs and lower thirds.
- **Track and key** inside AE: a sub-pixel point tracker and a measured green-screen key, with nothing extra installed.
- **Build** layers of every kind, precomps, track mattes (AE 23+ layer mattes), shape contents, masks and text animators, align and distribute, and set hundreds of properties in one undo step.
- **Work to sound**: render a comp's audio in the background and read its level, hits, tempo and beats; put markers or pulses on the beats; turn a transcript into VO markers.
- **Deliver**: check a render by importing it back, version shots up to the latest file on disk, build Essential Graphics templates and export MOGRTs, purge unused items, and check a comp against the brief's fonts, brand colours and safe areas.
- **Ask the user** in the panel, with buttons, pictures or ease curves they can reshape, and remember the project brief and their motion taste.
- **Render** through the render queue or `aerender` in the background, **read and answer popups**, and **save a diagnostics file** when something is stuck.

---

## Install (users)

1. **Install the ZXP.** Download `chroma-ae-mcp-<version>.zxp` from the latest release and install it with the [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/) (or Anastasiy's). The certificate is self-signed ("Chroma AE MCP"), so expect a one-time warning.
2. **Start After Effects.** The MCP service starts by itself, invisibly, about 30 s after launch.
3. **Open Window > Extensions > Chroma AE MCP.** The status panel should show **READY**.
4. **Register your clients.** Under **Register with**, click each one you use: **Claude Code**, **Claude Desktop**, **Cursor**, **Codex**. A tick means it is registered; clicking again removes it.
5. **Restart the client** (in Claude Code, `/mcp`). The `ae_*` tools appear.

**What you need:** Claude Code needs nothing but AE: the MCP runs on the Node built into AE's CEP. Claude Desktop, Cursor and Codex go through a small stdio relay, which needs Node 16 or later on the machine.

**The token** belongs to this machine and survives restarts. **Regenerate token** in the panel replaces it, and Claude Code's user-scope `chroma-ae` entry is registered again automatically. The relay clients read the token themselves and need nothing.

### Registering by hand

**Claude Code.** **Copy setup command** in the panel gives this, to paste into a terminal:

```
claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:7790/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop (Chat and Cowork), Cursor, Codex.** These can only launch a command, so they use the relay that ships with the panel. For Claude Desktop, open Settings > Developer > Edit Config, add this under `mcpServers`, then quit Claude Desktop from the tray and reopen it:

```json
"chroma-ae": {
  "command": "node",
  "args": ["<CEP extensions>/london.chroma.aemcp/tools/stdio-relay.cjs"]
}
```

- `<CEP extensions>` is `%APPDATA%\Adobe\CEP\extensions` on Windows (escape backslashes as `\\` in JSON) and `~/Library/Application Support/Adobe/CEP/extensions` on macOS.
- The relay forwards to the same `/mcp` as Claude Code, so every client shares one write queue.
- While AE is closed the tools stay listed, and calling one says to start AE.
- The panel's buttons back up each config file as `<file>.chroma-bak` before changing it.

---

## How it works

```
Claude Code ───────────HTTP /mcp (Bearer)──► london.chroma.aemcp.service   (hidden CEP extension, starts with AE)
Claude Desktop, Cursor,                       ├─ MCP endpoint (stateless JSON-RPC, no SDK: AE's Node 17 is too old for it)
Codex ──stdio──► tools/stdio-relay.cjs ───┘   ├─ single-writer queue · guard · quarantine · receipts · checkpoints
                                              ├─ questions for the user (ae_ask_user), served to the panel on /ask
                                              ├─ Node side: PNG and audio decode and analysis, aerender jobs, popups, asset watcher
                                              └─ evalScript ──► host/core.jsx + host/ext/*.jsx (ExtendScript)
                                            london.chroma.aemcp.panel   (Window > Extensions: status, log, register, questions, diagnostics)
```

**Why a thin guarded listener?** AE's ExtendScript DOM is complete, so `ae_run_jsx` can do almost anything. The typed tools exist where they add something `ae_run_jsx` cannot:
- verification (read-back, stale-frame checks, pixel checks);
- safety (guard, checkpoints, undo hygiene);
- a known AE trap, encoded once;
- large bounded reads;
- work ExtendScript can't do at all (pixel analysis, tracking, background renders).

## Safety model

- **Target guard.** Every write names the `project_path` (and `comp_id`) it expects. If AE has something else open, the write is refused before anything changes (`kind: "guard"`). A guard failure means stop and re-read the state, not retry.
- **One undo step per write.** The undo group begins and ends inside one evalScript, so one Ctrl+Z backs out a whole tool call.
- **Automatic checkpoints.** Before every write, the saved `.aep` is copied to `<projectdir>/_mcp_checkpoints/` (`..._auto-<tool>.aep`).
  - The copy is the last save: AE can't write its unsaved state to another file without retargeting the project. When AE has unsaved changes, or can't say, the write's `checkpoint` says so.
  - Writes between two saves share one copy. Unsaved projects and projects over the size limit (250 MB by default) are skipped. `ae_auto_checkpoint` turns it off or changes the limit.
  - `ae_checkpoint_revert` opens the checkpoint file itself, not a copy, so saving afterwards overwrites that checkpoint. Make a new checkpoint first if you need to keep it.
- **Receipts.** Writes return a before/after comparison, read back in a *separate* evalScript, because AE returns stale values when a read follows a write in the same script. `ae_comp_fingerprint` and `ae_comp_diff` show every changed property and keyframe.
- **Quarantine.** A write that times out has an unknown outcome. It is quarantined, and further writes are blocked until someone inspects the state and calls `ae_acknowledge`. Nothing is retried automatically.
- **Never kills AE mid-script.** Aborting an evalScript wedges the ExtendScript bridge, so calls queue and wait.
- **Read tools change nothing,** not even a comp's resolution: that would land on the user's undo stack (measured).
- **Popups are never suppressed** (Jay's rule).
  - `ae_dialogs` reads AE's modal popups (title, text, buttons, screenshot) from outside AE's scripting thread, with OCR for the dialogs AE paints itself.
  - A timeout names any popup that is blocking AE.
  - `ae_dialog_respond` answers only popups our own operation caused, and refuses Save, Don't Save, Replace, Delete or Discard without an explicit instruction from the user. Every answer is logged.
- **Locked-down bridge.** It binds to localhost only. Every request needs the Bearer token, stored in a folder only the current user can read. Any request with an `Origin` header (from a browser) is rejected, and the `Host` header is checked strictly.

---

## Tools (80)

| Group | Tools |
|---|---|
| Status & control | `ae_status`, `ae_quarantine_status`, `ae_acknowledge` |
| Read | `ae_get_project` and `ae_get_comp` (filtered and paged for big projects), `ae_get_layer_props`, `ae_get_layer_full`, `ae_find_layers`, `ae_list_effects`, `ae_validate_expressions`, `ae_comp_tree` (what nests what, where a comp is used, unused comps), `ae_fonts` (fonts in use and missing ones) |
| Script | `ae_run_jsx`: a read, or a guarded write with a receipt |
| Write | `ae_set_property` (value, keyframes or expression), `ae_set_keyframe_ease` (presets, explicit speed and influence, or a CSS-style `curve` shaped onto each segment; `rove_between` makes the middle keys roving), `ae_set_text`, `ae_import_footage`, `ae_replace_footage`, `ae_batch_set` (values, keys or expressions on many layers: everything is found before anything is written, 500 ops per undo step) |
| Layers | `ae_create_layer` (solid, null, adjustment, text, shape, camera, light, footage, precomp; named, parented and placed), `ae_precompose`, `ae_set_track_matte` (any layer as the matte on AE 23+; the layer above on older AE, refused otherwise), `ae_align` (to the comp, a safe area or the layers' box; or distribute) |
| Shapes, masks & text | `ae_shape` (rectangle, ellipse, star, polygon or a free path, with fill and stroke), `ae_mask` (rectangle, ellipse or path; mode, feather, opacity, expansion, invert), `ae_text_animator` (properties through a range selector, optionally a keyframed reveal) |
| Keyframes & markers | `ae_get_keyframes` (ease named per side, tangents, roving), `ae_remove_keyframes` (all, some or a range; the kept value is chosen), `ae_get_markers`, `ae_add_markers` (a list, or a transcript: SRT, VTT, ElevenLabs or Whisper JSON, per segment, sentence or word, a colour per speaker), `ae_remove_markers` |
| Audio | `ae_audio_analyze` (the comp's sound rendered by aerender in the background, then level, onsets, tempo, beats and the loudest hits, all in comp time; or a WAV/AIFF by path), `ae_cue_keys` (a pulse on a property at each beat or onset) |
| Effects | `ae_add_effect`, `ae_set_effect`, `ae_remove_effect`, `ae_apply_preset` (.ffx), `ae_list_presets`. Parameters scripts can't set (Colorama's Output Cycle, the Curves curve) are listed as `settable: false`; a preset saved from AE carries them. |
| Motion | `ae_contact_sheet` (up to 24 frames in one labelled PNG), `ae_motion_graph` (value and speed of one property, with the easing per key pair), `ae_motion_review` (linear moves, dead starts and stops, speed jolts, overshoot, keys between frames, and where layers come to rest against the frame and safe areas; most findings come with a ready `ae_set_keyframe_ease` fix in the user's preferred ease, roving the middle keys of a spatial move) |
| Frames | `ae_snapshot_frame` (rendered at full size, shrunk on the server to `scale` or `max_size`), `ae_compare_frames` (pixel diff; flags blank, black or transparent frames) |
| Tracking & keying | `ae_track_point` (a sub-pixel point tracker that writes the path to a null; within 0.04 px on a test shot), `ae_key_greenscreen` (Keylight, Key Cleaner and Spill Suppressor, then a measured check for screen left, holes, spill and recoloured subject, with ready fixes and a before/after preview) |
| Builds | `ae_build_from_data` (a copy of a template comp per CSV or JSON row; every cell checked against the template before AE is touched; text that runs off the frame is flagged), `ae_reframe` (16:9, 1:1, 4:5, 9:16 or any size: backgrounds cover, other layers and controller nulls pin to the safe area at rest, mattes follow, a guide layer shows the safe area, and anything still outside it is listed) |
| Assets | `ae_import_assets`: files in `_assets/` next to the .aep go into an `_Assets` bin with subfolders mirrored and numbered stills as sequences; files already imported are skipped. `watch: true` imports new arrivals automatically. |
| Skills | `ae_skill_list`, `ae_skill_save`, `ae_skill_run`: `SKILL.md` plus numbered ExtendScript steps, per project (`ae-skills/` next to the .aep) or global. A working `ae_run_jsx` can be saved by its `op_id`. Steps are checked for ES3; a run is one undo group, and is always guarded and checkpointed when given `expect`. |
| Ask & context | `ae_ask_user` (a question in the panel with buttons, pictures, or ease curves to preview and drag; waits for the answer), `ae_brief` (the project's goal, audience, format, feel and no-go areas, kept next to the .aep), `ae_taste` (the user's motion preferences across projects; `ae_motion_review` follows them) |
| Receipts & safety | `ae_comp_fingerprint`, `ae_comp_diff`, `ae_checkpoint_create`, `ae_checkpoint_list`, `ae_checkpoint_revert`, `ae_auto_checkpoint`, `ae_save` (copies the .aep first; never save-as) |
| Render | `ae_render_queue_add`, `ae_render_queue_status`, `ae_render_templates`, `ae_aerender_start`, `ae_aerender_status`, `ae_aerender_cancel` (background; success is judged from the log as well as the exit code), `ae_verify_render` (imports the render back and checks its frames, frame rate, size and audio against the comp or the job; no ffprobe) |
| Delivery | `ae_version_footage` (newer versions on disk, swapped and logged next to the .aep), `ae_get_essential_graphics`, `ae_set_essential_graphics`, `ae_export_mogrt`, `ae_purge_unused`, `ae_house_style_check` (fonts, brand colours by delta E, small text, title safe) |
| Popups | `ae_dialogs`, `ae_dialog_respond` (Windows through UI Automation; macOS through System Events, which needs Accessibility permission for After Effects) |
| Diagnostics | `ae_diagnostics`: one file for triage with versions, what is in flight and for how long, queue, quarantine, settings, popups and the end of the log, token redacted. The panel's **Save diagnostics** button writes the same file. |
| UI | `ae_list_panels`, `ae_open_panel`, `ae_ui_screenshot` |

Each tool's schema and description, as the agent sees them, live in `server/src/tools/`.

**Native panels.** CEP extensions open directly. AE's own Window-menu panels open through `app.executeCommand`, which does work through CEP (measured), but those commands **toggle**, so `ae_open_panel` refuses a native panel unless `allow_toggle` is set after checking with `ae_ui_screenshot`.

**Where it keeps things.**
- Data dir (`%LOCALAPPDATA%\chroma-ae-mcp`, `~/Library/Application Support/chroma-ae-mcp`): token, `settings.json` (auto checkpoints, taste, asset watch), `service.log`, `diagnostics/`, global `skills/`, `frames/`, `renders/`.
- Next to a project: `<name>.brief.json`, `<name>.versions.json` (`ae_version_footage`'s log), `ae-skills/`, `_assets/`, `_mcp_checkpoints/`, `_mcp_backups/` (copies taken by `ae_save`).
- Audio renders for `ae_audio_analyze` go to `renders/audio/` in the data dir.

---

## Develop (Chroma)

```powershell
cd server; npm install; npm run build; npm test; npm run bundle   # bundle -> panel/client/mcp-bundle.cjs
node scripts/lint-jsx.mjs                                         # ES3 + no chained ternaries in panel/host
pwsh scripts/install-dev.ps1                                      # junction panel/ into CEP extensions, PlayerDebugMode=1
node qa/smoke-mcp.mjs --dir <a fresh /_work/qa/ folder>           # live: every tool against the running AE
```

- Read `CLAUDE.md` and `docs/BUILDERS.md` before writing code: they hold the ExtendScript rules and the AE 26 traps we have measured.
- Restart AE after any manifest change. For code changes, reload the service page at `http://localhost:8097` (the panel is on `8096`); no AE restart is needed. After a `core.jsx` change, clear `$.global.__chromaAe` first.
- Commit the output of `npm run bundle`: CI checks that the bundle is up to date.
- Host code can be tested without AE: `server/test/support/fake-ae.ts` is a small simulated AE DOM, and `host-jsx*.test.ts` run `panel/host/*.jsx` against it under `node:vm`. It follows AE where the host code depends on it; the live smoke test is still the proof.
- **Never install the ZXP on a machine that has the dev junction.** An installer could delete through it into the repo. Run `install-dev.ps1 -Uninstall` first.

**Releasing:**
1. Bump `VERSION`.
2. Put `ZXPSignCmd.exe` in `build/` (gitignored). Copies live in `AFX-VoxMark/build/` and `AFX_Gulp/builds/signing/win/`.
3. Run `op-sa op run --env-file scripts/release.env -- pwsh -NoProfile -File scripts/package.ps1`. It stages the panel, stamps the version, signs, verifies and prints the SHA256. The certificate passphrase is in 1Password: Release Signing / "Chroma AE MCP ZXP cert".
4. Tag `vX.Y.Z` on the build commit, then create the GitHub release with the `.zxp` and its SHA256.

## QA

- **Live smoke test** (`qa/smoke-mcp.mjs`): every tool against a running AE in a throwaway project. It refuses to start unless AE has an empty, QA-owned or `/_work/qa` project open.
- **Product scenarios** (`qa/runner.js`): runs a product's real ExtendScript (**VoxMark**, **Gulp**) in a real AE against throwaway projects, loading it the way the product does, and asserts AE state in separate calls.
  ```
  node qa/runner.js qa/scenarios/voxmark      # report: qa/out/report.md + junit.xml
  ```
- **Self-hosted runner** (`qa/ci-live.mjs`, `.github/workflows/ae-live.yml`): runs the smoke test on a machine with AE. Ready, but no runner is registered yet (`docs/CI-RUNNER.md`).

Details in `qa/README.md` and `docs/QA-HARNESS.md`.

## Troubleshooting

- **Tools fail with `unreachable`:** is AE running and the service up? The status panel shows READY, and `curl -H "Authorization: Bearer <token>" http://127.0.0.1:7790/health` answers. The service starts about 30 s after AE launches.
- **401 errors:** the token was regenerated. Click **Claude Code** under Register with (twice if it is ticked), or paste the setup command again.
- **Something is stuck:** click **Save diagnostics** in the panel (or ask for `ae_diagnostics`) and read the file it names: it says which eval is in flight, for how long, and which popup is open.
- **A call times out:** the message names any popup blocking AE. Answer it in AE, or with `ae_dialog_respond` under the rules above, then check the state and `ae_acknowledge` the op.
- **Port 7790 is busy:** the service retries every 5 s and never starts a second server. Check that an old AE instance isn't still running.
- **Windows Firewall prompt when rendering:** `aerender` starts a background AE. Renders don't need network access, so cancelling the prompt is fine.
- **The ZXP installer can't parse the package:** `ExtensionManifest Version` must be the manifest *schema* version (7.0), not the CEP version (12.0).
- **Blank panel or JavaScript errors:** open `http://localhost:8097` (service) or `8096` (panel) in Chrome or Edge.

## Roadmap

Priorities and reasons are in `docs/FEATURES.md`; the "Atom" items come from `docs/ATOM-REVIEW.md`.

**Done in 0.3.0:** automatic checkpoints around every write, the AE skills bundle, one-click registration, asset staging with auto-import, social reframe, data-driven builds and the diagnostics bundle (all from the Atom review), plus motion preview and review, curve easing, asking the user, effects and presets, brief and taste, point tracking and green-screen keying.

**Built for 0.4 (unreleased, not yet live-tested):** every P2 item and the in-scope P3 items:
- layers: create, precompose, track mattes, align and distribute;
- audio: analysis from an aerender pass, cue keys, VO markers from a transcript;
- animation: keyframe read and removal, markers, roving fixes and rest bounds in `ae_motion_review`;
- reads: comp tree, fonts, paged project and comp reads;
- production: shape contents, Essential Graphics and MOGRT export, render templates, shot versioning, chunked batches;
- P3: masks, text animators, purge unused, house style checks;
- render verification by importing into AE instead of ffprobe.

**Open:**
- [ ] **Run 0.4 in After Effects:** the live smoke test covers every new tool; then release.
- [ ] **macOS popup reading:** written (`panel/tools/ae-dialogs-mac.js`, through System Events, needing Accessibility permission for After Effects); not yet tried on a Mac.
- [ ] **A self-hosted CI runner** on a machine with AE. The workflow and `qa/ci-live.mjs` are ready; a runner has to be set up and registered.
- [ ] **QA:** VoxMark scenarios 4–5 (they need generated WAV fixtures), then Gulp scenarios 1–5. They need the VoxMark and Gulp repos on the machine that runs them.

**Out of scope:** Deadline submission and the Premiere round trip: both leave After Effects.

**Left for when a job needs them:** parent, reorder, duplicate and delete layers as typed tools (`ae_run_jsx` does them today), single-layer snapshots, matching a reference frame, audio levels and fades, a project JSON export, several AE instances, and failure recovery by id.

## Docs

- `SPEC.md`: the original design.
- `CLAUDE.md`: the ExtendScript and CEP rules every change must follow, and how to verify a change.
- `docs/BUILDERS.md`: how to add a tool group, with the AE 26 behaviour we have measured. Read it before writing code.
- `docs/FEATURES.md`: the full feature list, the gaps, and what to borrow.
- `docs/V02-PANEL-MCP.md`: how the MCP runs inside the panel.
- `docs/QA-HARNESS.md`: the QA harness plan.
- `docs/CI-RUNNER.md`: setting up the self-hosted runner with After Effects.
- `docs/HANDOVER.md`: notes from the 0.3.0 and 0.4 work: what each package added, how it was checked, and what was left open.

## Credits

Ideas and small pieces are borrowed (MIT) from [Engine-Room-Games/after-effects-mcp](https://github.com/Engine-Room-Games/after-effects-mcp) and [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp). See `ATTRIBUTION.md`.
