# Roadmap and status

Priorities and reasons are in `docs/FEATURES.md`; the "Atom" items come from `docs/ATOM-REVIEW.md`.

## Test status (0.5.0)

- **173 tools.** On top of 0.4.1's 80: three waves of 69 more (layer ops, captions, rigs, render batches, delivery checks and so on), then wave 4 (18 compositing tools: planar tracking, stabilizing, removing things from a shot, patch fitting and checks, screen replacement) and wave 5 (6 new tools and many extensions of existing ones, from an audit of the AE Scripting Guide). All of it passes the build, 4531 unit tests (102 files) and the ExtendScript lint, its host code runs against a simulated AE DOM, and the bundle runs on AE's Node 17.7.2. Every wave went through multi-agent code reviews with fix rounds (106 findings in the first, 123 in wave 4, 65 in wave 5, and others). **Live smoke** (`qa/smoke-mcp.mjs`, AE 26.2.1 on Windows, a generated scratch project): 519 of 526 checks passed, 17 skipped; the bugs the first runs found are fixed. Not run on macOS, and it doesn't judge visual quality or use real footage. **The 7 failures are all aerender jobs that never start rendering** (cause not proven; see `docs/HANDOVER.md`): jobs now fail cleanly after 3 attempts, and `ae_render_batch` runs one aerender at a time. On PRISM (AE 26.3) aerender started every time but often left its engine idle after exiting, which blocked the next job; the server now ends that engine 10 s after aerender exits. Whether that was the cause is not yet confirmed. `docs/HANDOVER.md` lists the AE behaviours the tools rely on.
- The 80 tools up to 0.4.1: the 55 from 0.3 were live-tested on AE 26.2.1 (Windows) and the panel has been opened in AE 26.3.
- CI runs the build, the unit tests, the ExtendScript lint, and the in-panel MCP end to end on AE's own Node (17.7.2).
- macOS should work but is untested. Popup reading on macOS is written and unit-tested, but has not been run on a Mac.

## Next

Planned on 2026-11-08 after reading premiere-pro-mcp's commits up to v1.30.0 (MIT: port with its copyright notice). Sizes are rough: S small, M medium.

**0.8.0: reliability**
- [ ] **Write outcomes** (S/M; premiere-pro-mcp `src/workflows/mutation-receipt.ts`, 0716cc8d, 3cffd793). Today a throw part-way through a write leaves the partial changes (`A.withUndo` in `panel/host/core.jsx` closes the group in `finally`) and the server returns a bare `evalscript_error`. Add `A.refuse(code, msg)` for checks before anything is touched (`outcome: "not_applied"`), map any other write error to `outcome: "unknown"` with next steps (one Ctrl+Z, `ae_comp_diff`, the checkpoint), and put `outcome` on success too. Check whether a failure in a later chunk of `ae_batch_set`, `ae_render_batch` or `ae_multi_comp_apply` still reports the chunks that committed.
- [ ] **Idempotency keys and recent operations** (S/M; `src/workflows/idempotency.ts`, 08f6ddda, 77e45529). Quarantine covers our own timeouts, but a client that gives up and resends runs the write twice. An optional `idempotency_key` handled once in `tools/ext/write-runner.ts` (SHA-256 of key and arguments, 200 entries, 1 h, module-level so every request shares it), and an `ae_recent_ops` read tool.
- [ ] **Tool groups** (S; `src/workflows/tool-packs.ts`, b4699c66, c15fb464). `CHROMA_AE_MCP_TOOLSET` takes `full`, `core` or group names from `TOOL_GROUPS` (`core,render,captions`); `CHROMA_AE_MCP_TOOL_LIST` names tools; unknown names stop startup with a clear error.
- [ ] The three items left open by the 0.7.0 live check (below): stopping a render in AE, long H.264 renders, the rest of the checklist.
- [ ] **zod 4.** `npm audit` reports a high-severity advisory in zod 3 (memory exhaustion on oversized constrained collections, fixed only in 4.6.6+). The server listens on localhost behind a token, so the exposure is small, but every tool schema has to move.
- [ ] Dev tooling: vitest 2 and esbuild 0.24 carry advisories (dev only, not shipped in the panel); move to current majors.

**0.9.0: delivery checks**
- [ ] **Sampled-frame render check** (M; `verify_temporal_render_artifact`). `ae_verify_render sample_frames: N` renders N frames of the imported output and of the comp and diffs them with the `ae_compare_frames` code.
- [ ] **Broadcast-safe check** (M; `inspect_rendered_video_scopes`). `ae_broadcast_safe_check` on PNG samples: luma outside 16–235, chroma and saturation over EBU R103, share and position of the pixels, Broadcast Colors as the fix. 8-bit samples can't support HDR claims; say so.
- [ ] **Codec and colour tags without ffprobe** (M). A pure-JS MP4/MOV atom reader: `stsd` fourcc (apch, ap4h, avc1), `colr` nclc, size, `mdhd` rate, bitrate, alpha. Closes `ae_check_delivery_file`'s codec gap.
- [ ] **MOGRT contents** (S/M; theirs only checks the ZIP header). Unzip with Node zlib, read the definition JSON, list exposed controls and compare with `ae_get_essential_graphics`.

**Later**
- [ ] A folder watcher for Cinema 4D and render outputs (`manage_media_watch`, 8463ea30) that reports new sequences and versions and offers `ae_version_footage`; it never imports by itself.
- [ ] `ae_can_execute {tool, args}` (`can_execute`): schema, quarantine, render gate, AE busy and guard, without running.
- [ ] Compact schemas with a session guard (96438c2d): only if measuring shows `expect` costs a lot across the tool list.

Not taken: timeline prediction and post-condition checks (`ae_comp_diff` covers AE), interlacing and letterbox detection (comp renders are progressive; both need ffmpeg), their in-memory export jobs (ours persist and resume), EDL/AAF/OMF/OTIO, telemetry.

## Open

Found by the live smoke run on AE 26.3x87 (Windows, `main` after PR #11, 2026-11-08). 405 of 410 passed before AE crashed:
- [ ] **`ae_annotate_frame` on a 3D comp crashes AE** (first). `saveFrameToPng` gave no fresh PNG, also after the retry at +0.001 s ("did not produce a fresh non-empty PNG for comp 754"). AE died on the next call (`ae_get_layer_full`), and the smoke test stopped with `ECONNRESET`. Check the 3D renderer (Advanced 3D / Mercury) path in the frame grab, and whether a stale-frame failure should stop before the next call.
- [ ] **`ae_camera_rig` focus options on 26.3**: "Unable to call “setValue” because of parameter 1. Value is not an array". A 26.3 property that takes an array where we write a number.
- [ ] **Cube mesh layer on 26.3** (`ae_create_layer type: mesh`): mesh width and height are missing from the read-back or differ. Units and ranges are undocumented; measure them in AE.
- [ ] **`ae_motion_review` after roving** reports "1 medium on Mover", and **`ae_describe_comp` with `layout: true`** reports 1 region for 1 layer. Both fail the same way on 26.2.1 (Emre's PR #11 evidence) and 26.3, so they are bugs on `main`, not version quirks.
- [ ] **Render Queue `follow` block** (PR #11): checked during a render started by hand on 26.3. It answered in about 250 ms throughout and saw the output grow (22 → 483 MB). A finished item drops out of `follow` at once, so its final size isn't reported: worth keeping done items for one more check.
- [ ] **Claude Desktop gets the full toolset, not core** (PR #11). The Store build of Desktop sends `clientInfo.name` `local-agent-mode-chroma-ae` (apparently `local-agent-mode-<server name>`), not `claude-ai`, so `stdio-relay.cjs`'s exact match misses. Match the prefix too, after checking what the non-Store build and Cowork send.

- [ ] **Live AE run of 0.4:** run the smoke test (`qa/ci-live.mjs`) for the 25 new tools.
- [ ] **Try Update for real** when 0.4.2 comes out, from an installed 0.4.1.
- [ ] **aerender jobs that never start:** 7 of the last smoke run's jobs hung at the version or launch line (AE 26.2.1). Lead: engines left idle after aerender exits, now ended by the server; confirm by starting a second aerender beside an idle engine, then rerun the smoke test. Still fails after an AE restart (2026-11-08); a machine restart untried. **Measured lead (2026-11-08, AE 26.2.1, Windows): the headless engine exits.** aerender spawns `AfterFX.com`; about 5-10 s in it starts every auto-starting CEP extension (7 `CEPHtmlEngine.exe` children), its CPU stops and it exits (AE's crash reporter logged a fatal event with `headless: true`, `processName: AfterFX.com`, `secondsRunning: 8`). aerender never notices and only prints its version line, so the watchdog stopped each attempt after 59 s (3 attempts, about 3.5 min). Controlled test, 2 runs per case, extension folders moved aside: all 7 auto-starting extensions present failed both times; none present rendered in 5 s both times; any single one present rendered both times (all 7 tried). So it is the extensions together, not one of them. Second round (2 runs each): FAIL with all 7 present and with all but our own (6); OK with the Overlord pair only (2), the LaForge pair only (2), all but the Overlord pair (5), all but the LaForge pair (5), all but AEUX and Anubis (5), three (3), any single one (7 cases, round 1) and none. So no single extension and no pair causes it and ours is not needed for it: every set of 6 or 7 failed and every tested set of 5 or fewer rendered. The advice is therefore generic (turn off the auto-starting extensions you do not need until it renders); no extension name is in code. The server now fails an attempt at once when its engine is seen gone (`engine_exit_after_ms`, `cep_children_max`) and lists the auto-starting extensions (`cep_autostart`).
- [ ] **macOS popup reading:** written (`panel/tools/ae-dialogs-mac.js`, through System Events, needing Accessibility permission for After Effects); not yet tried on a Mac.
- [ ] **A self-hosted CI runner** on a machine with AE. The workflow and `qa/ci-live.mjs` are ready; a runner has to be set up and registered.
- [ ] **Render in AE can't be stopped** (PR #10 live check, 2026-11-07): a render started by `ae_render_queue_render` locked AE's UI, so the Stop button couldn't be reached (seen over phone Remote Desktop; confirm at a desk). Options: an `onStatusChanged` callback that can call `stopRendering`, or a hard length cap.
- [ ] **Long H.264 renders in AE ran out of memory:** two 3-minute 1080p H.264 renders grew AE to 33 and 79 GB without writing a frame (one crashed AE); ProRes of the same comps was fine. Find out whether that is AE's H.264 path; warn or refuse long H.264 in `ae_render_queue_render`.
- [ ] **Rest of `qa/LIVE-CHECKLIST.md`:** Claude Desktop with the core toolset, one Ctrl+Z of a layout, layout rollback, a Cinema 4D camera through `copyToComp`, and sections E, F and G.
- [ ] **QA:** VoxMark scenarios 4–5 (they need generated WAV fixtures), then Gulp scenarios 1–5. They need the VoxMark and Gulp repos on the machine that runs them.

- [ ] **Follow-ups from the busy, dialog, pre-check and layout work (none of it has run in After Effects yet; see `qa/LIVE-CHECKLIST.md`):**
  - a service-side drop of queued items after N s;
  - a busy door in the HTTP `bridge.ts`;
  - rate-limiting identical refused calls;
  - limiting sequence gaps to AE's range once `file` = first frame is confirmed;
  - tightening `caused_by_op` so reads and quiet polls get no credit.

**Out of scope:** Deadline submission and the Premiere round trip: both leave After Effects.

**Left for when a job needs them:** single-layer snapshots, matching a reference frame, a project JSON export, several AE instances, and failure recovery by id. Layer ops, audio levels and fades and the rest of the earlier list are now typed tools.

## Done

**Done in 0.3.0:** automatic checkpoints around every write, the AE skills bundle, one-click registration, asset staging with auto-import, social reframe, data-driven builds and the diagnostics bundle (all from the Atom review), plus motion preview and review, curve easing, asking the user, effects and presets, brief and taste, point tracking and green-screen keying.

**Done in 0.4.1:** the panel updates itself from GitHub releases; Register with picks one AI and copies that AI's own setup (a command for Claude Code and Codex, a config entry for Claude Desktop and Cursor) and twirls closed once something is set up; the Log shows the service's own events as well as tool calls; New token, Save diagnostics and Check for updates moved to the bottom.

**Done in 0.4.0 (reviewed, not yet run in AE):** a new panel (session tiles, reply-time chart, and a Log that opens below them or fills the panel), every P2 item and the in-scope P3 items:
- layers: create, precompose, track mattes, align and distribute;
- audio: analysis from an aerender pass, cue keys, VO markers from a transcript;
- animation: keyframe read and removal, markers, roving fixes and rest bounds in `ae_motion_review`;
- reads: comp tree, fonts, paged project and comp reads;
- production: shape contents, Essential Graphics and MOGRT export, render templates, shot versioning, chunked batches;
- P3: masks, text animators, purge unused, house style checks;
- render verification by importing into AE instead of ffprobe.

**Done in 0.7.2** (#15, #17):
- the stdio relay waits for its output to flush before exiting: on macOS a reply over 64 KB (the full tool list) was cut off when the host closed stdin;
- the unit tests pass on macOS, and no longer write into the real data folder there (`~/Library/Application Support/chroma-ae-mcp`).

**Done in 0.7.1** (Emre's PRs #11 and #14, live-checked on AE 26.3):
- a usage log on the machine (tool, time, outcome, size, toolset, client; no arguments or results; `CHROMA_AE_MCP_USAGE_LOG=off`) and `panel/tools/usage-report.cjs` to sum it up;
- `ae_render_queue_render` renders only chosen items (`item_indexes`), or hands the queue to Media Encoder with the user's OK (`engine: media_encoder`), with a warning naming Media Encoder's last-used preset when it differs from the output module;
- `ae_render_queue_status` follows a render the user started (output files, sizes, growth), and shows a finished item once with its final size; status calls take `wait_seconds`;
- the stdio relay gives every client the core toolset except Claude Code, which gets the full list (`CHROMA_AE_MCP_TOOLSET` still wins);
- `ae_snapshot_frame save_to` saves full-resolution PNGs; tool results are 8-46% smaller; `ae_run_jsx` refuses non-ES3 code before AE sees it;
- fixes: `ae_motion_review` no longer flags its own roving fix, and an aerender attempt that dies when 6 or more auto-starting CEP extensions load fails fast with that diagnosis.

**Done in 0.7.0** (Emre's PR #10, live-checked on AE 26.3):
- render inside After Effects (`ae_render_queue_render`, `ae_render_queue_render_status`) for when aerender can't run, with pre-checks for missing frames, existing outputs and busy GPUs;
- a core tool list for Claude Desktop (`CHROMA_AE_MCP_TOOLSET=core`: 33 tools plus search, schema and invoke gateways) and a panel button that sets it;
- AE-busy refusals instead of long queues, startup diagnosis in the relay, safer popup answers (scaled displays fixed in the live check);
- batch import with interpretation and rules (gapped sequences are skipped with their ranges), many-item interpretation;
- layouts: `ae_describe_comp layout: true` and `ae_layout_apply` (regions, fill / contain, clip masks, feed comps, camera copies).

**Done in 0.6.0:**
- motion guidance: the chroma-motion-director skill served as MCP prompts and resources (also through the stdio relay while AE is closed), `ae_brief` motion specs read by `ae_motion_review` (choreography, keyed overshoot), `ae_timing_check` and `ae_house_style_check` (platform safe zones);
- captions: standards that fix timing, grammar-aware breaks, cut snapping, clean-up, word-by-word and template output, speaker colours and SDH labels, looks, automatic fit, and three new tools: `ae_transcribe` (ElevenLabs Scribe), `ae_captions_export` (SRT, VTT, TTML) and `ae_captions_qa`; the standalone `captions` skill is served as guidance too;
- relicensed to AGPL-3.0-only.

**Done in 0.5.0:**
- waves 1 to 3 (69 tools): layer ops, multi-comp apply, annotated frames, preflight, captions, rigs, text fitting, staggering, time remap, cameras, diagnosis, paths, render queue edits and batches, collect and deliver, loudness, legibility, variants, taste learning, project sessions;
- wave 4 (18 tools): planar tracking, stabilizing, clean plates, inpainting, mattes, patch fitting and checks, screen replacement;
- wave 5 (6 tools and extensions of existing ones): `ae_create_comp`, `ae_project_items`, `ae_project_settings`, `ae_view`, `ae_keyframes_transform`, `ae_detect_cuts`, and the 28 gaps the audit found.
