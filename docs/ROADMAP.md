# Roadmap and status

Priorities and reasons are in `docs/FEATURES.md`; the "Atom" items come from `docs/ATOM-REVIEW.md`.

## Test status (0.5.0)

- **173 tools.** On top of 0.4.1's 80: three waves of 69 more (layer ops, captions, rigs, render batches, delivery checks and so on), then wave 4 (18 compositing tools: planar tracking, stabilizing, removing things from a shot, patch fitting and checks, screen replacement) and wave 5 (6 new tools and many extensions of existing ones, from an audit of the AE Scripting Guide). All of it passes the build, 4531 unit tests (102 files) and the ExtendScript lint, its host code runs against a simulated AE DOM, and the bundle runs on AE's Node 17.7.2. Every wave went through multi-agent code reviews with fix rounds (106 findings in the first, 123 in wave 4, 65 in wave 5, and others). **Live smoke** (`qa/smoke-mcp.mjs`, AE 26.2.1 on Windows, a generated scratch project): 519 of 526 checks passed, 17 skipped; the bugs the first runs found are fixed. Not run on macOS, and it doesn't judge visual quality or use real footage. **The 7 failures are all aerender jobs that never start rendering** (cause not proven; see `docs/HANDOVER.md`): jobs now fail cleanly after 3 attempts, and `ae_render_batch` runs one aerender at a time. On PRISM (AE 26.3) aerender started every time but often left its engine idle after exiting, which blocked the next job; the server now ends that engine 10 s after aerender exits. Whether that was the cause is not yet confirmed. `docs/HANDOVER.md` lists the AE behaviours the tools rely on.
- The 80 tools up to 0.4.1: the 55 from 0.3 were live-tested on AE 26.2.1 (Windows) and the panel has been opened in AE 26.3.
- CI runs the build, the unit tests, the ExtendScript lint, and the in-panel MCP end to end on AE's own Node (17.7.2).
- macOS should work but is untested. Popup reading on macOS is written and unit-tested, but has not been run on a Mac.

## Open

- [ ] **Live AE run of 0.4:** run the smoke test (`qa/ci-live.mjs`) for the 25 new tools.
- [ ] **Try Update for real** when 0.4.2 comes out, from an installed 0.4.1.
- [ ] **aerender jobs that never start:** 7 of the last smoke run's jobs hung at the version or launch line (AE 26.2.1). Lead: engines left idle after aerender exits, now ended by the server; confirm by starting a second aerender beside an idle engine, then rerun the smoke test.
- [ ] **macOS popup reading:** written (`panel/tools/ae-dialogs-mac.js`, through System Events, needing Accessibility permission for After Effects); not yet tried on a Mac.
- [ ] **A self-hosted CI runner** on a machine with AE. The workflow and `qa/ci-live.mjs` are ready; a runner has to be set up and registered.
- [ ] **QA:** VoxMark scenarios 4–5 (they need generated WAV fixtures), then Gulp scenarios 1–5. They need the VoxMark and Gulp repos on the machine that runs them.

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

**Done in 0.5.0:**
- waves 1 to 3 (69 tools): layer ops, multi-comp apply, annotated frames, preflight, captions, rigs, text fitting, staggering, time remap, cameras, diagnosis, paths, render queue edits and batches, collect and deliver, loudness, legibility, variants, taste learning, project sessions;
- wave 4 (18 tools): planar tracking, stabilizing, clean plates, inpainting, mattes, patch fitting and checks, screen replacement;
- wave 5 (6 tools and extensions of existing ones): `ae_create_comp`, `ae_project_items`, `ae_project_settings`, `ae_view`, `ae_keyframes_transform`, `ae_detect_cuts`, and the 28 gaps the audit found.
