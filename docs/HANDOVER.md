# Handover: AE control and roadmap P2, 2026-10-29 to 2026-10-30

This picks up where the work stands after two sessions with Emre on the Windows PC:
- what was built;
- how it was checked;
- what the code review found and what changed because of it;
- what is still open.

Everything here is on GitHub as stacked pull requests; nothing is merged yet.

## Where it is

| PR | Branch | Base | What |
|---|---|---|---|
| #1 | `feat/motion-preview` | `main` | `ae_contact_sheet`, `ae_motion_graph`, scaled snapshots |
| #2 | `feat/auto-checkpoints` | #1 | automatic checkpoints before every write, minimized-AE screenshots, the live smoke test |
| #3 | `feat/motion-review` | #2 | `ae_motion_review` with easy-ease fixes |
| #4 | `feat/ae-control` | #3 | Claude Desktop relay, `ae_ask_user` and curve easing, effect tools, `ae_brief` and `ae_taste`, `ae_track_point`, `ae_key_greenscreen` |
| #5 | `feat/roadmap-p2` | #4 | this round: skills, data builds, reframe, asset import, diagnostics, panel registration, macOS popups, runner prep |

**Merging:**
- Merge in order, #1 to #5.
- After #1 lands, rebase the rest onto `main` and retarget each PR.
- The earlier PRs were merged by rebase, which keeps the topic commits.

**The user's ground rules** (they apply to anything built on this):
- Everything happens inside After Effects. No outside tools such as SAM, OpenCV or Python.
- Popups are never suppressed.
- Jay commits and pushes, or says when to.

**#5's commits:**

Each commit builds, passes its tests and has an up-to-date bundle on its own.

| Commit | Topic |
|---|---|
| `7d49ead` | AE skills |
| `26e3a5f` | `ae_build_from_data` and `ae_reframe` |
| `2a48631` | `ae_import_assets` with a watcher, and `ae_diagnostics` |
| `19634b4` | panel registration and Save diagnostics |
| `f2d2086` | macOS popups |
| last | runner prep, smoke checks, docs and this file |

## What #5 adds (tools 48 → 55)

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
1. Merge #1 to #5 in order, then cut a release. Bump `VERSION` and run `scripts/package.ps1`; the new files under `panel/tools` ship automatically.
2. On a Mac:
   - try `ae_dialogs` and `ae_dialog_respond` on a Save prompt;
   - check the panel's Register chips;
   - run the smoke test.
3. Set up the AE runner and turn on `push` for `ae-live.yml`.
4. Write the VoxMark 4–5 and Gulp scenarios on a machine with those repos.
5. From `docs/FEATURES.md`, P2 candidates are audio waveform and beat cues (inside AE, from the render), track mattes and layer creation tools, and roving keys in `ae_motion_review`.
