# Handover: 0.4, roadmap P2 and P3, 2026-11-03 to 2026-11-04

Emre asked for every remaining P2 item and the P3 items that stay inside After Effects, in the recommended order, then decided against a live After Effects test. A multi-agent code review and its fixes stood in for it. This section covers:
- what was built;
- how it was checked, and what has **not** been checked;
- the AE behaviours the code relies on that nobody has measured.

Everything is on the local branch `feat/roadmap-0.4`, off `main` at `6f72ea6` (0.3.0). It has not been pushed to this repo.

## Where it is

| Commit | What | Tools added |
|---|---|---|
| `878e1ff` | Tests: the stdio relay tests get 20 s (they timed out under a full parallel run) | – |
| `7221e49` | Layers | `ae_create_layer`, `ae_precompose`, `ae_set_track_matte` |
| `d4ed954` | Audio and markers | `ae_audio_analyze`, `ae_cue_keys`, `ae_get_markers`, `ae_add_markers`, `ae_remove_markers` |
| `5b90e95` | Animation | `ae_get_keyframes`, `ae_remove_keyframes`; `rove_between` on `ae_set_keyframe_ease`; roving fixes and rest bounds in `ae_motion_review` |
| `c1132de` | Reads | `ae_comp_tree`, `ae_fonts`; filters and paging on `ae_get_project` and `ae_get_comp` |
| `ca14892` | Production | `ae_shape`, `ae_get_essential_graphics`, `ae_set_essential_graphics`, `ae_render_templates`, `ae_version_footage`, `ae_batch_set` |
| `33e2549` | P3 | `ae_mask`, `ae_text_animator`, `ae_align`, `ae_purge_unused`, `ae_export_mogrt`, `ae_house_style_check` |
| `e7d11b2` | Render check and docs | `ae_verify_render` |
| `b03eaac` | The server's version numbers follow `VERSION` (they read 0.1.0, 0.2.0 and 0.2.1); `test/version.test.ts` keeps them together | – |
| `285c693` | The review's fixes, and the same read-back fix for the 0.3 tools | – |
| (last) | These docs | – |

Tools: 55 → 80. Unit tests: 258 → 610 (50 files).

**Shared pieces:**
- `server/src/tools/ext/write-runner.ts`: the guarded write as one function (guard, checkpoint, before read, write, separate after read, receipt). All new write tools use it.
- `server/src/tools/read-back.ts`: once a write's evalScript has returned, the tool must not throw. A failed read-back, or a failed check of it, becomes a `read_back` mismatch saying the write was applied and not to resend. The 0.4 tools get this through write-runner, and the 0.3 write tools now use it too (see below).
- `server/test/support/fake-ae.ts`: a small simulated AE DOM. `host-jsx*.test.ts`, the `fix-*.test.ts` files and `review-followup.test.ts` run `panel/host/ext/*.jsx` under `node:vm` against it. It follows AE where the host code depends on it, and it is not AE.
- Pure modules with their own tests: `audio.ts` (decoding and analysis), `transcript.ts`, `versions.ts`, `style.ts`.

## How it was checked

- `npm run build`, `npm test` (610 passing), `node scripts/lint-jsx.mjs` (21 files, 0 issues), `npm run bundle`, and `scripts/check-bundle.cjs` (80 tools over the in-panel MCP) on Node 22 and on AE's Node 17.7.2. All green.
- **Code review** (the user's pattern: Sonnet finds, Opus verifies):
  - 17 Sonnet finders covered 10 areas, each with a host lens and a server lens. Separate finders took the audio DSP, the fake DOM's fidelity and the smoke test's sequence.
  - Two Opus verifiers per finding tried to refute it, one by tracing the code and one by checking the AE, Node and ES3 premise.
  - Result: 106 findings, 91 confirmed, 9 refuted, 2 depending on live AE, 1 disputed (decided by the lead).
  - Sonnet agents fixed them in 8 disjoint file groups, and Opus checked each group's diff. A repair round fixed what the checks found.
  - A final Opus pass over the result found 17 more, the worst being a write that still threw after it was applied. The lead fixed those.
  - 223 + 23 + 10 agents in all.
- **What the review changed in the 0.3 tools:** the same unguarded read-back was in ae_run_jsx, ae_set_property, ae_save, ae_set_keyframe_ease, ae_set_text, ae_import_footage, ae_replace_footage, the effect tools, ae_render_queue_add, ae_import_assets, ae_build_from_data, ae_reframe, ae_skill_run, ae_checkpoint_revert, ae_track_point and ae_key_greenscreen. All of them now report a failed read-back instead of throwing after the change is made. Image sequences are imported and replaced with Force alphabetical order off (numbered order, placeholders for gaps, AE's default), as `ae_import_assets` already did.
- **Not run in After Effects.** Emre decided a live test is not needed. The smoke test (`qa/smoke-mcp.mjs`) still has a step for every new tool (99 checks, up from 54), for whenever someone runs it.

## AE behaviours relied on but not measured

The code is written to work either way where it could be, but these are guesses until AE answers them:
1. **Track mattes:** whether `setTrackMatte` turns the matte's video off by itself. The tool turns it off either way.
2. **`ae_audio_analyze`:**
   - that AE 26 ships an output-module template named exactly `AIFF 48kHz` (`ae_render_templates` says);
   - that aerender keeps the `.aif` extension;
   - that `-s`/`-e` count from the comp's display start frame (the tool adds it).
3. **Markers:**
   - whether marker times come back within 1.5 ms of what was written;
   - whether a layer marker's duration is stored in layer or comp seconds (the tool scales it by the stretch, like the time).
4. **Match names nobody has used here yet:**
   - text animators (`ADBE Text Position 3D`, `ADBE Text Scale 3D`, `ADBE Text Fill Color`, `ADBE Text Range Type2`, `ADBE Text Range Shape`, `ADBE Text Levels Max Ease`);
   - masks (`ADBE Mask Offset` for expansion);
   - precomp overrides (`ADBE Layer Overrides`).
5. **Text animators:** whether a scripted `addProperty("ADBE Text Animator")` comes with its own Range Selector. The tool adds one and edits the first, so a default one would leave an unused second.
6. **Essential Graphics:**
   - `addToMotionGraphicsTemplateAs` and `setMotionGraphicsControllerName` on AE 26;
   - the value types of overrides (text overrides as a TextDocument).
7. **`ae_export_mogrt`:** the `exportAsMotionGraphicsTemplate(overwrite, path)` signature, and whether AE raises a dialog. If it does, the call times out and names the dialog. Read it with `ae_dialogs`; never suppress it.
8. **Roving:** which keys AE refuses to rove. `setRovingAtKey` failures are collected and reported, not assumed.
9. **Rest bounds and `ae_align`:** `sourceRectAtTime` on solids and footage, and the sign of rotation in the box maths.
10. **`ae_fonts`:** `app.fonts.missingOrSubstitutedFonts` and `fontObject.isSubstitute` on AE 26.
11. **`ae_verify_render`:** an imported image sequence's default frame rate (the tool conforms it to the comp's), and the frame count from `duration * frameRate`.
12. **`ae_render_templates` with `allow_temp`:** it adds and removes a render-queue item. Check that this leaves only an undo step and a changed flag.

If someone runs the smoke test, fix what fails. Add the measured behaviour to `docs/BUILDERS.md`, and put the facts an agent needs into the tool descriptions.

## Not done, and why

- **A live AE run:** Emre's call.
- **Deadline submission and the Premiere round trip:** both leave After Effects, which is out of scope (Emre's rule: everything through AE itself). `ae_export_mogrt` covers the template side of a Premiere handoff.
- **VO transcription:** `ae_add_markers` places what a transcript says (SRT, VTT, ElevenLabs, Whisper). Producing the transcript stays outside, as VoxMark does today.
- **Render verification uses AE, not ffprobe** (no outside tools): `ae_verify_render` imports the render back and removes it again. That is two undo steps and a changed project, as its result says.
- **Left for when a job needs them:**
  - typed tools to parent, reorder, duplicate and delete layers (`ae_run_jsx` does these today);
  - single-layer snapshots;
  - matching a reference frame;
  - audio levels and fades;
  - a project JSON export;
  - several AE instances;
  - failure recovery by id.
- **Failure paths with no direct test:** `ae_skill_run`, `ae_track_point` and `ae_key_greenscreen`. Their guards are small and type-checked.

## Suggested next steps

1. Push the branch to the private copy and open a PR there, so GitHub's CI runs both jobs on a clean Windows machine (Node 20, and AE's Node 17.7.2).
2. ~~Decide whether to release 0.4.0 untested in AE.~~ Released as v0.4.0 on 2026-11-03 without a live AE run, together with the new panel (below). Run the smoke test (`qa/ci-live.mjs`) and open the panel in AE 26 next.
3. On a Mac: the macOS popup reading still open from 0.3.

## The 0.4.0 panel (2026-11-03)

Built from the panel design canvas (designs #21 to #24): session tiles (tool calls, queued, errors, median reply, checkpoints), a chart of the last 20 reply times, Register with as a four-way control, a full-width Copy setup command, and a Log that is closed, open below the tiles, or fills the panel (the corner-arrows button; the choice is kept in `localStorage`).

- **Where the numbers come from.** The server now writes one service-log line per MCP tool call (`tool <name> ok (<ms>ms)` or `tool <name> failed (<ms>ms): <why>`, in `mcp-rpc.ts`) and one per automatic checkpoint (`Checkpoint saved before <tool>: <file>`, in `tools/mutate.ts`, through the new `ctx.log`). `panel/client/common.js` (`parseToolLine`, `createSessionStats`) turns them into the tiles and the Log; a session starts at the service's `Listening on` line. Tested in `server/test/panel-stats.test.ts`.
- **Left out of the designs:** per-entry Undo (nothing on the server can undo one call's change; checkpoints and AE's own Undo still work) and plain-English descriptions of each call (the Log shows the tool name). New token and Save diagnostics stay, as small links under Copy setup command.
- **Not yet seen in AE.** The README screenshots are the real `index.html` and `style.css` rendered in headless Chrome with sample data.

---

# Handover: AE control and roadmap P2, 2026-10-29 to 2026-10-30

This picks up where the work stands after two sessions with Emre on the Windows PC:
- what was built;
- how it was checked;
- what the code review found and what changed because of it;
- what is still open.

Everything here is on GitHub as stacked pull requests. Jay merged #1 into `main` on 2026-10-30, with a fix commit on top (`c8bd645`), and rebased #3 and #4 onto it; #6 was rebased onto that #4 (`feat/ae-control` at `5013831`) the same day.

## Where it is

| PR | Branch | Base | What |
|---|---|---|---|
| #1 (merged) | `feat/motion-preview` | `main` | `ae_contact_sheet`, `ae_motion_graph`, scaled snapshots |
| #2 | `feat/auto-checkpoints` | #1 | automatic checkpoints before every write, minimized-AE screenshots, the live smoke test |
| #3 | `feat/motion-review` | #2 | `ae_motion_review` with easy-ease fixes |
| #4 | `feat/ae-control` | #3 | Claude Desktop relay, `ae_ask_user` and curve easing, effect tools, `ae_brief` and `ae_taste`, `ae_track_point`, `ae_key_greenscreen` |
| #6 | `feat/roadmap-p2` | #4 | this round: skills, data builds, reframe, asset import, diagnostics, panel registration, macOS popups, runner prep |

**Merging:**
- Merge in order: #1, #2, #3, #4, then #6. Number 5 was never used: GitHub skipped it.
- #1 is in `main`. When #2 merges, retarget #3 to `main`, and so on down the stack, rebasing each onto the new base. `mcp-bundle.cjs` conflicts in a rebase are resolved by running `npm run bundle` in `server/` at that commit, never by merging the text.
- The earlier PRs were merged by rebase, which keeps the topic commits.

**Heads-up: `main`'s CI is red** since the #1 merge (run 41069493864).
- The cause: `c8bd645` changed `motion.ts`, `motion.jsx` and `render.ts` without `npm run bundle`, so the "Panel bundle is up to date" step fails.
- The fix: run `npm run bundle` in `server/` on `main` (or in the next PR to land there) and commit `panel/client/mcp-bundle.cjs`.
- #6 is not affected: it carries a bundle built from its own sources, and its CI is green.

**The user's ground rules** (they apply to anything built on this):
- Everything happens inside After Effects. No outside tools such as SAM, OpenCV or Python.
- Popups are never suppressed.
- Jay commits and pushes, or says when to.

**#6's commits:**

Each commit builds, passes its tests and has an up-to-date bundle on its own.

| Commit | Topic |
|---|---|
| `f8de083` | AE skills |
| `87400b7` | `ae_build_from_data` and `ae_reframe` |
| `21f3dde` | `ae_import_assets` with a watcher, and `ae_diagnostics` |
| `d7c7563` | panel registration and Save diagnostics |
| `b98f7d9` | macOS popups |
| `a237d78` | runner prep, smoke checks, docs and this file |

## What #6 adds (tools 48 → 55)

| Area | Tools and files | What it does |
|---|---|---|
| Skills | `ae_skill_list`, `ae_skill_save`, `ae_skill_run`; `server/src/skills.ts`, `server/src/es3-lint.ts`, `tools/ext/skills.ts`, `panel/host/ext/skills.jsx` | Reusable recipes kept as `SKILL.md` plus `1.jsx`, `2.jsx` (see the notes below). |
| Data builds | `ae_build_from_data`; `tools/ext/data.ts`, `panel/host/ext/data.jsx` | One copy of a template comp per CSV or JSON row (see the notes below). |
| Social reframe | `ae_reframe`; `tools/ext/reframe.ts`, `panel/host/ext/reframe.jsx` | Copies a comp to 16:9, 1:1, 4:5, 9:16 or any size (see the notes below). |
| Assets | `ae_import_assets`, `AssetWatcher`; `server/src/assets.ts`, `tools/ext/assets.ts`, `panel/host/ext/assets.jsx` | `_assets/` next to the .aep goes into an `_Assets` bin, with subfolders mirrored. |
| Diagnostics | `ae_diagnostics`; `tools/ext/diagnostics.ts`, `POST /admin/diagnostics` in `service.js`, the panel's **Save diagnostics** button | One markdown file in `<data dir>/diagnostics/` (see the notes below). |
| Registration | `panel/tools/register.cjs`, the panel's **Register with** chips | Claude Code goes through its CLI (`claude mcp add --scope user`). Claude Desktop, Cursor and Codex get the stdio relay, so their configs never hold the token (see the notes below). |
| macOS popups | `panel/tools/ae-dialogs-mac.js`; the darwin branch in `tools/ext/dialogs.ts` | `ae_dialogs` and `ae_dialog_respond` through System Events (JXA via `osascript`). Handle = window index × 100 + sheet index. |
| Live runner | `.github/workflows/ae-live.yml` (manual), `qa/ci-live.mjs`, `docs/CI-RUNNER.md` | A self-hosted Windows runner labelled `after-effects` (see the notes below). |

**Skills:**
- Project skills live in `ae-skills/` next to the .aep; global ones in `<data dir>/skills/`.
- A working `ae_run_jsx` can be saved by its `op_id`, which `ae_run_jsx` now returns.
- A run is one evalScript, so it is one undo group.
- Steps compile in `core.jsx`'s scope, through the new `A.compileInCore`, the same as `ae_run_jsx`.

**Data builds:**
- Text, numbers, colours and footage come from columns.
- Every cell is checked against the template's properties before AE is touched.
- Text that runs off the frame is flagged.
- `in_place` updates a single comp, such as a chart.

**Social reframe:**
- Backgrounds cover the new frame.
- Other top-level layers and controller nulls, measured together with their children, are pinned to the nearest edge of the safe area at their resting pose, and shrunk to fit.
- Track mattes follow their layer; audio is left alone.
- A guide layer shows the safe area, and the read-back lists what is still outside it.

**Assets:**
- Numbered stills become sequences: 3 or more frames, 3 to 7 digits, not `_v002` versions.
- Already-imported files are skipped.
- `watch: true` polls every 5 s with `quiet:` evals, which are not logged unless they fail.

**Diagnostics:**
- The file holds versions, what is in flight and for how long, the queues, quarantine, settings, popups and the end of the log.
- The token is redacted.
- It waits for AE for up to 5 s and never aborts the eval.

**Registration:**
- Changed configs are backed up once, as `<file>.chroma-bak`.
- Regenerate token registers Claude Code again.
- CLI calls are asynchronous, so the panel stays responsive.

**Live runner:**
- `ci-live.mjs` checks the CEP extension points at the checkout.
- It reloads the panel service through its debug port (8097), and waits for the "Listening" log line.
- It then runs the smoke test.

**Shared changes:**
- `ToolContext` has `dataDir` and `serviceInfo`.
- `core.jsx` exposes `A.plainResult` and `A.compileInCore`.
- `settings.json` has `asset_watch`.
- `scripts/lint-jsx.mjs` got the same regex-versus-division fix as `es3-lint.ts`.

## How it was checked

**Unit tests:**
- 257 pass in 26 files (202 before this round).
- The JSX lint is clean on 11 files.
- The bundle check sees 55 tools on Node 22. CI also runs it on CEP's Node 17.7.2.

**Live smoke** (`qa/smoke-mcp.mjs`, AE 26.2.1, Windows):
- 53 checks, including every new tool.
- In the last run `aerender` stalled before "Launching After Effects", the known flake. A retry of the same render produced all 5 frames.
- An earlier run on the same code before the review fixes, and `qa/ci-live.mjs` end to end, were 53/53.

**Live scenes:**
- **Skills:**
  - a captured `ae_run_jsx` re-run as a project skill;
  - `args`, `prev` and `results` passed between steps;
  - non-ES3 code refused;
  - a failing step reported with its step and line.
- **Data:**
  - three language rows, with the long Turkish title flagged as off the frame;
  - a chart bar set in place;
  - `1,5` refused with a hint to use a point.
- **Reframe to 9:16, 1:1 and 4:5:**
  - a background covered the frame;
  - a controller null with a wide child was shrunk as a group;
  - a text track matte stayed aligned with its plate (checked in rendered frames);
  - a slide-in lower third was pinned at rest, not mid-slide;
  - an audio layer was left alone.
- **Assets:** a 4-frame sequence went into `_Assets/flora/renders`; the watcher imported a dropped file in 3 s.
- **Panel:**
  - the chips show the right state, with Claude Code and Claude Desktop registered on this PC;
  - Save diagnostics writes the file;
  - the Cursor and Codex chips were tested only against a fake home, because neither client is installed here.

## Code review (2026-10-30)

**Method:**
- Five Sonnet reviewers each read one area of the uncommitted diff.
- Opus checked every finding against the code, reproduced the lint ones, and measured the AE questions live.
- The same reviewers fixed the confirmed findings, and Opus re-ran everything above.

**Found and fixed:**
- **Skills:**
  - A skill marked `mutates: false` ran unguarded even when its steps wrote. Now any run given `expect` is guarded, checkpointed and one undo group.
  - The ES3 lint mistook a regex after `return` for division and the reverse, after `i++ /`. Both let a later `let` through. The same bug in `scripts/lint-jsx.mjs` is fixed too.
  - Steps compiled in a different scope from `ae_run_jsx`.
  - A step's size was limited in characters on save but in bytes on read, so large non-ASCII steps vanished.
  - Smaller fixes:
    - stale numbered steps are cleared;
    - the folder name is the skill's identity;
    - Windows device names (`con`, `nul` ...) are refused;
    - `args_example` keeps its spacing;
    - an unreadable skill is reported instead of thrown.
- **Data:**
  - `1,5` was split into a list, and a bad row aborted the build halfway. Cells are now validated against the template (dimensions, colour, key count, footage), and a row error names the row and what was already built.
  - Smaller fixes:
    - every key is read back for multi-key writes;
    - off-frame text is measured at its resting pose;
    - a quoted empty CSV cell isn't dropped;
    - name patterns resolve in one pass.
- **Reframe:**
  - Children of controller nulls were never measured or reported.
  - Track mattes moved independently of their layer.
  - Animated layers were pinned at their mid-point.
  - Audio layers were treated as points.
  - A lone `width` was ignored, and sizes over 30000 reached AE.
- **Assets:**
  - Files copied in with old dates (Windows Explorer keeps them) were never auto-imported. Arrival is now the newest of mtime, ctime and birth time.
  - `logo_v002`/`logo_v003` were merged into a sequence.
  - A watcher tick and a manual import could import the same file twice. The project is now re-read inside the write lease.
  - A render still writing frames was imported half done.
  - Smaller fixes:
    - the watcher backs off when AE fails;
    - `dry_run` no longer creates the folder;
    - turning watch on twice no longer resets it;
    - paths are NFC-normalised.
- **Diagnostics:** two saves in one second overwrote each other, and repeated saves queued extra status evals.
- **Registration:**
  - The backup was overwritten on every write, losing the original.
  - A failed `claude mcp add` deleted the working entry. The old one is now restored.
  - Codex TOML with a commented header, or another form of the entry, got a duplicate table.
  - The CLI blocked the panel.
  - Smaller fixes: tokens are redacted everywhere; comments in JSON get a readable error; symlinked configs are written through.
- **macOS popups:**
  - The "closed" check could never be false.
  - A sheet with an empty title could be confused with another window at the same index. The listed text is now a second guard.
  - Error -1719 was always read as a missing permission.
- **CI:** a multi-line pwsh step only failed on its last command. The smoke test couldn't re-run into a fixed `--dir`. A service reload wasn't confirmed.

**Checked and not a bug:**
- Audio-only layers do have a Transform group in scripting.
- A separated Position reads fine through `ADBE Position`. Both were measured on AE 26.2.1.

**Left as is:** both are low-impact edge cases.
- A skill error raised inside other code reports that code's line number.
- Frames of one sequence with mixed padding form two groups.

## Not done, and why
- **QA scenarios VoxMark 4–5 and Gulp 1–5:** the AFX-VoxMark and AFX_Gulp repos aren't on this PC.
- **macOS popup reading:** written and unit-tested with a mocked runner, never run on a Mac. It needs Accessibility (and Automation > System Events) permission for After Effects. Try `ae_dialogs` with a Save prompt open.
- **The self-hosted runner:** not registered. A machine and a repo admin are needed (`docs/CI-RUNNER.md`). The runner must run in the logged-on session, not as a service. The workflow stays manual until it is green a few times.
- **Obsidian capture:** skipped, because `OBSIDIAN_API_KEY` isn't set on this PC.

## Where to find things
- **Data dir** (`%LOCALAPPDATA%\chroma-ae-mcp`, `~/Library/Application Support/chroma-ae-mcp`): token, `settings.json` (auto checkpoints, taste, asset watch), `service.log`, `diagnostics/`, `skills/`, `frames/`, `renders/`, `dialogs/`, `relay-tools-cache.json`.
- **Next to a project:**
  - `<name>.brief.json` (`ae_brief`);
  - `ae-skills/` (project skills);
  - `_assets/` (staging);
  - `_mcp_checkpoints/` (auto and manual checkpoints);
  - `_mcp_backups/` (copies taken by `ae_save`).
- **Trap rules measured on AE 26:** `docs/BUILDERS.md`. Feature status: `docs/FEATURES.md`.
- **Live test:** `node qa/smoke-mcp.mjs --dir <fresh dir under a /_work/qa/ path>`. On a runner: `node qa/ci-live.mjs`.
- **Reload after a bundle or `host/ext/*.jsx` change:** reload the service page at `http://localhost:8097` (CDP `Runtime.evaluate location.reload()`), with no AE restart needed. After a `core.jsx` change, clear `$.global.__chromaAe` first.

## Suggested next steps
1. Merge #1 to #4 and then #6, in order, then cut a release. Bump `VERSION` and run `scripts/package.ps1`; the new files under `panel/tools` ship automatically.
2. On a Mac:
   - try `ae_dialogs` and `ae_dialog_respond` on a Save prompt;
   - check the panel's Register chips;
   - run the smoke test.
3. Set up the AE runner and turn on `push` for `ae-live.yml`.
4. Write the VoxMark 4–5 and Gulp scenarios on a machine with those repos.
5. From `docs/FEATURES.md`, P2 candidates are audio waveform and beat cues (inside AE, from the render), track mattes and layer creation tools, and roving keys in `ae_motion_review`.
