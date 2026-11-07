# Handover: 0.4 waves 4 and 5, 2026-11-03 to 2026-11-05

## Render in After Effects, 2026-11-07 (`feat/render-in-ae`)

Why: aerender (`ae_aerender_start`) fails to start on this PC most of the time (see "Open problem: aerender" below), and the only other way to start a render, `RenderQueue.render()`, is refused in `ae_run_jsx` because it blocks the bridge. Agents therefore told the user to press Render. Now they call a tool.

- **`ae_render_queue_render`** (`server/src/tools/ext/rqrender.ts`, host `rqeditRender` / `rqeditRenderResult` in `panel/host/ext/rqedit.jsx`): starts AE's own render of the queued items and RETURNS AT ONCE with a job id. A read inside the queue lease first refuses a queue that is rendering, nothing QUEUED, an output with no file, a missing folder, or an existing file (unless `overwrite`; nothing is ever deleted or created). It renders the open project as it is (unsaved or dirty is fine: one advantage over aerender). A background promise then sends one long mutating evalScript (`render()` only returns when the render ends; `max_hours` 1-48, default 12) and holds the queue lease for the whole render. No undo group, no checkpoint.
- **`ae_render_queue_render_status`**: a Node-only read (no evalScript): state, elapsed, per output exists / bytes / mtime / frame count, popups through `listBlockingDialogs({ screenshots: false })`. After the end the item statuses and `ae_verify_render`.
- **The render gate** (`server/src/render-gate.ts`): while the render runs AE cannot answer, so every other eval is refused at once with a `queued`-kind BridgeError ("After Effects is rendering (job X, started ...)"), at two doors: `SingleWriterQueue.acquire` (callHost, `runGuardedWrite`, every `ctx.queue.run`; waiters already queued are dropped) and `evalRaw` of both transports. Nothing is sent to AE, nothing is quarantined, nothing counts as an applied write. `ae_status` answers with the render state; `ae_diagnostics` reports `render_gate`; the asset watcher skips quietly; the session bridge hook leaves the render's own eval alone. The render eval has no quarantine on timeout and no write-ahead record (it changes no project data).
- **Timeout**: the job reads `unknown`, nothing is resent or stopped, and the gate stays shut (state "unknown") until the panel service reports nothing in flight (`serviceInfo().inFlight === null`), then lifts and notes that the statuses were never read.
- **Still rendering / stuck gate**: if the read-back says the queue or an item is RENDERING or WILL_CONTINUE, the gate stays shut and the read repeats (5 s, up to 30 min), then the job reads `unknown` with a gate the idle probe does not lift. The refusal message and the status tool say that restarting AE clears a gate AE no longer needs; the panel footer shows a user-only "Clear render lock" button (two clicks, `POST /admin/clear-render-lock`) only while the gate is shut. Only the panel service runs the tool (`ctx.serviceInfo`); `POST /eval` is refused while the gate is shut; a queued aerender / batch spawn is held by the aerender start gate meanwhile. The start check also refuses more than 100 QUEUED items or a cut-short read, NEEDS_OUTPUT items checked to render, duplicate outputs, and outputs a running aerender job or batch is going to write. After the read-back the session baseline is re-taken so the next write does not report the render as the user's change.
- **Restart**: jobs are in `<data dir>/renders/rq-render-jobs.json`; one still "running" when a service starts is `lost` ("look at After Effects").
- **Texts**: the `ae_run_jsx` lint, its description, the skills text and the aerender "never started rendering" message now name `ae_render_queue_render`. `renderQueue.render` stays refused in `ae_run_jsx`.
- **Checked**: build, unit tests (a fake bridge whose render eval resolves later, the gate, no quarantine, a failed read-back, a timeout, a restart, status without evalRaw) and the JSX lint. `qa/smoke-mcp.mjs` has an opt-in step (`CHROMA_SMOKE_RENDER_IN_AE=1`). **Nothing here has run in After Effects.** The panel bundle (`panel/client/mcp-bundle.cjs`) was not rebuilt: run `npm run bundle` in `server/` before installing.
- **Not measured in AE**: see the `rqrender` entry in the list of behaviours relied on but not measured (further down).

## Captions branch, 2026-11-06 (`feat/captions`)

Caption standards, QA, export and transcription, built on the captions tools. Build, 4969 unit
tests and the JSX lint (0 issues) pass; 177 tools in 54 groups. **Nothing here has run in After
Effects yet.**

- **Planner and standards** (`server/src/caption-standards.ts`, `caption-plan-options.ts`,
  `caption-rules.ts`, `caption-cleanup.ts`, `caption-formats.ts`): `ae_captions_plan` groups words
  into captions to a standard (`netflix_adult`, `netflix_kids`, `bbc`, `dcmp`, `social_9x16`),
  fixes what breaks it (`fix: false` only reports), and takes shot changes (`cut_times`), clean-up,
  social chunking (`max_words`, `single_word`), speakers, SDH and grammar-aware line breaks.
- **QA and export** (`server/src/caption-qa.ts`, `tools/ext/captionsio.ts`): `ae_captions_qa`
  lints a .srt, .vtt, plan or the comp's caption layers (read-only). `ae_captions_export` writes
  SRT, WebVTT or TTML (IMSC 1.1 text profile) and reads the file back to check the cue count.
- **Transcription** (`server/src/transcribe.ts`, `tools/ext/transcribe.ts`): `ae_transcribe` sends
  a comp's audio, or a file, to ElevenLabs Scribe and writes the raw response to a transcript file.
  It uploads client audio to a third-party US service, so it needs `confirm_upload: true`.
- **`ae_captions`** (`tools/ext/captions.ts`, `panel/host/ext/captions.jsx`): modes `layers`,
  `single`, `words` and `template`; looks `pop`, `pill_slide` and `fill_sweep`; speaker colours;
  `parent_to_null`, `precompose`, `make_template` for a MOGRT.
- **Safe areas, one source of truth** (`server/src/motion-spec.ts`, `PLATFORM_PRESETS`):
  `reels_9_16` is now the box safe on all three apps (1080x1920: x 120-888, y 288-1248). New
  presets: `tiktok_9_16`, `instagram_reels_9_16`, `youtube_shorts_9_16`. These are approximate,
  from ad specs and third-party templates; re-check yearly.
- **Behaviour change:** `ae_captions` on a 9:16 comp now defaults to `reels_9_16` (it was: bottom
  20% clear). `ae_house_style_check`'s reels findings moved with the preset.
- **Guidance** (`server/guidance/captions/`, `server/guidance/motion-director/`): the `captions`
  skill is served as the `captions` prompt and resources (`chroma-ae://guidance/captions/...`);
  `node scripts/sync-guidance.mjs` now syncs both skills. The motion-director `## Captions`
  section was rewritten in our own words (the original was close to HyperFrames, Apache-2.0) and
  now points to the captions skill. HyperFrames is credited in `server/guidance/motion-director/NOTICE.md`,
  and `ATTRIBUTION.md` gains sections 3 and 4.
- **How it was checked:** build, 4969 unit tests and JSX lint (0 issues). Host JSX ran against the
  fake AE DOM only. ElevenLabs was never called (HTTP mocked).

- **Live-test fixes, 2026-11-06 (After Effects 26.3)** (all covered by unit tests on the fake AE; the live
  behaviour is unverified):
  - `ae_captions` **`fit`** (`server/src/caption-fit.ts`, `captionsFit` in `captions.jsx`): layers and
    single mode. The write is read back in a separate evalScript; a caption measured wider than the safe
    area (centred text: the frame less twice the wider margin, less the box padding) is re-broken with
    `breakLines` at the characters per line its pixels per character allow (up to `max_lines`; in single
    mode up to the tallest caption, since the layer is placed for it), measured again, then scaled down
    (floor 70% of the base size, kept as a warning beyond). Result: `refit: [{ name, action, from, to }]`,
    `fit: { passes, receipts_ok }`, the final `outside_safe`. Not for words, template, or look
    `pill_slide`; `fill_sweep` is only scaled. `fit` = `rebreak` | `shrink` | `none`; default both in that
    order. Paragraph (box) text is skipped. `ae_captions_qa` from layers now reads with the same margins
    as `ae_captions` (a 9:16 comp's reels box).
  - **Stutters**: `the, the` now collapses (comma only; emphatic words such as `no, no` and `very, very`,
    and sentence ends, stay).
  - **Template mode**: `make_template` sizes the text from the target comp (6% of its short side), takes
    `lines` (default 2) and grows a comp too short for them; instances are moved so the template's caption
    sits where layers mode puts it (bottom of the safe area, or `layout.position`) whatever the line
    count, and a warning says when the template comp would cut a caption's lower lines off at its edge.
    Line breaks go in as `\r`. The cause of "only the first line shows" was the template comp's bottom
    edge cutting the lines below the first baseline; unverified live.
  - **Social chunking**: a full `max_words` chunk may take one extra word or pass its last word on to
    the next chunk to avoid a weak end, prefers punctuation and pauses, and avoids a chunk that cannot
    stay up the minimum time; the fix pass may merge up to `max_words + 1`.
  - **`ae_captions_qa` without `frame_rate`**: inferred from the cue times (lowest of 23.976, 24, 25,
    29.97, 30, 50, 59.94, 60 that every time sits on within 1 ms); `frame_rate_inferred` says so. When
    none fits, 24 fps with a half-frame gap tolerance (and a warning).
  - **`ae_transcribe` with `comp_id`**: `captionsAudioSource` (read only) checks that the comp has one
    audible footage layer with no time remap, stretch, effects or Audio Levels change; then the file is
    uploaded directly (`source: "footage_file"`, `offset` = the layer's start time, `audible_in_file`
    when the layer trims it, passed on in `next` as `from_s`/`to_s`). `footage_shortcut: false` forces
    aerender; the reasons for skipping come back as `footage_shortcut_skipped`.
  - **Words mode spacing**: `sourceRectAtTime` measures ink, which ignores trailing spaces and starts at
    each glyph's left side bearing, so ink widths (and ink widths of prefixes) never added up to the typeset
    line. `measureLineAdvances` (`captions.jsx`) now measures, in ONE layer (left justified, same style and
    time, text put back): the sentinel "|" alone, each word alone (its left bearing) and every prefix as
    "w1 .. wk |"; prefix less sentinel is the advance of the words and spaces before it (the sentinel's
    bearing and the first glyph's cancel). A word layer's text origin = line origin + that advance, and the
    line is centred/justified by its advance width, so gaps are the typeset ones whatever the glyphs'
    bearings. The measured space is only the fallback (with a warning). The `reels_9_16` rail warning in
    words mode is real: the union of the word layers' bounds is judged, and a centred caption wider than
    600 px on a 1080 frame reaches past 72% of the width.
  - **Words mode re-chunk (stale measure)**: AE answers `sourceRectAtTime` with the previous text's rect in the script that changed the text, so a re-run that re-chunked (max_words 3 -> 4) laid reused word layers out from stale widths and garbled the render (a second identical run was clean). Now a caption whose word layers differ in count or text from the new words gets all-new word layers (the old ones are removed at the end and listed in `removed`; `created`/`removed` stay truthful); identical captions keep their layers. Cost: a hand-restyled word layer of a changed caption is rebuilt in the base style. Test: `host-jsx-captions-rechunk.test.ts` (models the stale measure).
  - **Descender tolerance**: words mode `outside_safe` (union box) allows 0.3 x the word layers' font size
    below the safe bottom, as layers mode did; `caption-fit.ts` exports `DESCENDER_SHARE` and the fit
    judges the same way (width only). `outside_safe` entries from `fit` carry `reason`: `too_wide` or
    `position` (a flag that is not about width: lines or placement).
  - **Planner, short chunks**: with `fix` on, a caption under the minimum duration (or over max cps) that
    cannot grow into a gap merges with the better neighbour (same speaker, no cut; the cleaner break at the
    far side) even past `max_words`, up to `2 x max_words` and the standard's lines and characters per
    line: change `action: "merged_over_max_words"`, rule `min_duration` or `cps`. Judged at the out-time
    `enforceGaps` will leave (it used to drop a caption under the minimum after the merge pass). Not for
    `single_word`.
  - **Template fit** (`fit` not `none`, template mode): `captionsTemplateMeasure` (host; one undo group)
    adds a temporary text layer to the template comp with the template's caption text document, sets
    each caption's lines in it, reads `sourceRectAtTime` and removes the layer, so the template is left as
    it was. Node (`fitTemplateCaptions`) compares the widest line (times the caption layer's scale) with
    the template comp's width less its box padding; wider captions are re-broken (up to `max_lines` /
    the standard's lines, and no more than the mapped line fields) BEFORE the write, measured again, and
    still-too-wide ones come back as `template_overflow: [{ name, width, template_width }]` with a warning.
    Result: `refit` (action `rebreak`), `template_fit: { method, template_width }`. If the temporary layer
    cannot be made it estimates from the sample text's pixels per character (`method: "estimated"`).

**Unverified live (check in AE)**

- Words mode layout: `sourceRectAtTime` right after setting the text and the sentinel-based advances
  (gaps equal between all pairs, e.g. "Rover Defender", "hero shots"); the left-justified bearing.
- Template fit: the temporary text layer in the template comp (added, measured, removed; one undo step)
  and that its widths match the instance on screen (animators, expressions or scale on the template's
  text change the real width); a template with several text layers measures with `Caption` or the first.
- `fit`: the second `captionsRead` after `captionsFit` sees the new text and size; a very wide display
  face at the floor size; the box layer following a rebreak.
- `ae_transcribe` footage shortcut: `FootageItem.file` and `File.exists` on real footage, solo and
  mute rules, and an audio layer from a video file.
- Template mode: Essential Properties on a fresh precomp instance, the controller names, and
  `startTime`/`in`/`out` with a short template comp.
- `parent_to_null`: world positions.
- `precompose`: the return value, and a re-run into the precomp.
- Looks: fractional Index selectors for `pop`; Characters Excluding Spaces and line breaks for
  `fill_sweep`; pill position in parent space; `setTemporalEaseAtKey` dims.
- `fauxItalic` on keyed Source Text.
- `make_template`: controllers via `addToMotionGraphicsTemplateAs`, and a Fill effect surviving
  into Premiere.
- `ae_transcribe` against the real ElevenLabs API: model `scribe_v1`, field names, response shape,
  and the Windows User environment variable lookup (check with `reg query`).

**Deviations from the plan**

- `ae_captions_export` default file name is `captions.<ext>`, unless the comp is the active comp
  (`captionsRead` returns no comp name).
- Transcription runs on the whole comp.
- Clean-up defaults (music tokens, 0.05 s) apply only when a `cleanup` object is passed.
- Grammar-aware line breaks are on by default. This changes some existing line breaks.

- **Review:** two fresh Sonnet reviewers (planner/timing/exports; host JSX/ES3/undo rules), each given
  the diff only, then two fix rounds. Planner: a later cut undid an earlier cut's snap; linger and gap
  closing carried captions across a cut; in-times snapped onto a cut after their words had ended
  (overlaps, zero gaps); ae_captions planned on an assumed 24 fps grid (now reads the comp's rate);
  single_word split names; "I." missed in sentence case; strip_punctuation glued "and/or"; any short
  word after a number counted as a unit; hyphen pairs ignored max_words; QA warned on captions that
  end before a cut; sound-events-only transcripts were refused. A 12,000-transcript fuzz (all
  standards, five frame rates, random cuts) finds no overlap, short gap or unreported straddle. Host:
  a read of a layer after precompose moved it ("Object is invalid" inside the undo group); animator
  groups held across remove(); words mode ignored new line breaks; stale speaker colour/italic on
  re-runs; a moved control null shifted parented captions (now refused); template fields validated
  after earlier instances were changed (now before); pop wiped user keys (now refused); unbounded name
  lists. The fake AE can now invalidate stale references (`strictRefs`).

## Motion guidance branch, 2026-11-06 (`feat/motion-guidance`)

Items 1-5 of `docs/MOTION-RESEARCH.md`, built by five Sonnet agents in separate worktrees, then
reviewed by four fresh Sonnet reviewers and fixed (four fix rounds). Build, 4660 unit tests and
the JSX lint pass; 174 tools. **Nothing here has run in After Effects yet.**

- **Motion spec** (`server/src/motion-spec.ts`): a project's motion language as numbers, stored as
  the brief's `motion` field (`ae_brief`). Registers `ui_micro`, `brand_film` (default),
  `energetic`, `handmade` supply the defaults. `loadMotionSpec(ctx)` (brief.ts) reads the open
  project's spec; a malformed stored spec keeps its valid fields and returns a `warning`.
  `motion` merges one level deep; `motion: {}` clears it.
- **Prompts and resources**: `mcp-rpc.ts` serves the chroma-motion-director skill as MCP prompts
  (`motion_director`, `motion_review`) and resources (`chroma-ae://guidance/motion-director/...`).
  The text is in `server/guidance/motion-director/`, compiled into
  `server/src/guidance/content.generated.ts`; `node scripts/sync-guidance.mjs` refreshes both from
  `~/.claude/skills/chroma-motion-director`, and a test fails when they drift. The stdio relay
  advertises the same capabilities while AE is closed and serves cached prompt and resource lists
  (one cache file per list). After a list reply it also fetches every resource and prompt into
  `relay-contents-cache.json` (each prompt twice, once with a marker argument), so
  `resources/read` and `prompts/get` work offline with exactly the panel's text.
- **`ae_motion_review` choreography** (`choreography.ts`): ease monotony, entrance and exit
  direction, exit/entrance ratio, a move on a layer's first frame, stagger spread and evenness,
  density, landed text still moving, long tweens, and overshoot on opacity, colour or counting
  numbers. A real stagger counts as one gesture for monotony and density; cameras, lights and
  nulls are skipped for direction checks; position or scale overshoot up to 2 % stays info.
  Overshoot keyed by hand (0 -> 115 -> 100: a key past where the move settles, then a return of
  at most 35 % of the move) is measured too, one finding per key.
- **`ae_timing_check`** (new, read-only; `timing.ts`, `host/ext/timing.jsx`): unread lines,
  dead stretches, blank first frame (renders one frame), audio-free stretches over 15 s, and
  on-screen numbers or names not in `motion.facts` (P0 only for an unapproved price or
  percentage). Host reads are capped (500 layers, 3000 properties, 20000 keys); a capped layer
  counts as changing from the cut-off, so it never invents a dead stretch. Any enabled expression
  marks its layer as changing (a known false negative).
- **`ae_house_style_check`**: `platform` presets (title_safe, landscape_16_9, reels_9_16 with the
  bottom UI band and right rail, promo_9_16, feed_4_5, square_1_1) for text and logo layers
  (footage, precomp, shape or solid named with the word "logo"). The text-size check stays off
  unless `min_font_size`, a platform, or the brief's `min_text_pct`/`platform` asks for it, so
  existing results don't change.

Checked live on AE 26 (PRISM, 2026-11-06): the three checks on 16:9, 9:16 and a choreography
test comp, with and without a brief `motion` block; prompts and resources over HTTP; the relay
with AE running and closed. The live run found the keyed-overshoot gap and the offline-read gap,
both fixed above and re-checked in AE. Test project: Dropbox
`ClaudeProjects/chroma-ae-mcp/_work/live-check-motion/`.

## Live smoke, 2026-11-05 (read this first)

`qa/smoke-mcp.mjs` ran on After Effects 26.2.1 on Windows, on a generated scratch project. Four runs: 112 of 501, 466 of 522, 518 of 527, 519 of 526. So statements below that a tool "has not run in AE" are out of date for what the smoke covers. The smoke checks that tools work and read back correctly; it does not judge how good a result looks, and it uses no real footage, so tracker, clean plate, grain and colour match quality on real shots is still untested.

What the live runs found that the fake AE could not show:
- ExtendScript refuses ES3 reserved words that node:vm accepts (`var short`, an unquoted `delete` key). One such file used to stop every later ext file loading; the service now loads each file in its own try/catch and the linter refuses them.
- Removing the last Time Remap key hides the property, so new keys are written before old ones go.
- AE pre-lists hidden children (text selectors, stroke dashes): `canAddProperty` tells what must be added first.
- Dropdown controls have a per-instance `Pseudo/@@` match name: recognise them by `isDropdownEffect`.
- Renaming an effect by script does not update expressions; `autoFixExpressions` only takes bare names.
- `exportAsMotionGraphicsTemplate` opens a modal dialog for fonts not from Adobe Fonts.

**Lead on the aerender problem (2026-11-05, PRISM, AE 26.3):** four manual aerender runs all started and opened the project in 7-29 s, but in 3 of 4 aerender exited and left its `AfterFX.com` engine idle (0 CPU, about 2.4 GB) for good. The gate waited 120 s for such an engine and then failed the next job, and a fresh aerender started beside an idle one may be what hangs. The server now ends a job's own engine 10 s after its aerender exits (`ENGINE_EXIT_GRACE_MS`). Not tried yet: a second aerender started while an idle engine is alive, which would confirm the cause.

**Open problem: aerender.** The 7 remaining failures are all aerender jobs that never start rendering: the log stops at the version line or the launch line, and the `AfterFX.com` engine is idle or gone. In the last run 3 of 7 jobs worked. Most manual runs hung too, including with AE closed, which points away from the MCP's code, but the cause is not proven. Two guesses did not hold: "started too soon after the previous job" and "our service boots inside the engine". It worked on 2026-10-30. Not tried yet: a restart of the machine, and turning off the other CEP extensions the engine loads. Until it is solved, jobs fail cleanly after 3 attempts instead of hanging, and `ae_render_batch` runs one aerender at a time.

AE-painted dialogs (Crash Repair, save prompts) cannot be answered by `ae_dialog_respond` when they have several buttons; a person, or focusing AE and sending Enter for the default button, has to do it.

After wave 3, Emre asked for compositing tools: remove something from a shot, track it, fix a single frame and track the fix back. That became wave 4. A coverage audit of the AE Scripting Guide against the tools then found 28 gaps (6 new tools, 22 extensions; its first two defect fixes, `eea1e63`, were committed before the wave 4 commit); Emre chose to build all of them as wave 5. Same branch `feat/roadmap-0.4`, one commit per wave. Emre again decided against a live After Effects test for now. **None of the wave 4 or wave 5 tools has run in After Effects**, and the live smoke run that is coming has never happened: expect to adjust some arguments and checks on the first pass. This section covers:
- what was added;
- how it was checked;
- the AE behaviours the code relies on that nobody has measured;
- what is impossible by script, and what the `ae_run_jsx` lint refuses on purpose;
- what was not done, and what to do next.

Nothing from waves 1 to 5 is pushed or released. The waves 1-3 section below is still right for those waves; its counts stop at 149 tools.

## Where it is

| Commit | What | Tools |
|---|---|---|
| `eea1e63` | Two defects the audit found, committed before wave 4: `ae_mask` told agents to animate a mask path with `ae_set_property` (it does not turn vertex lists into a Shape; it now points to `ae_path_write` with `time`), and the AE 26.5 guide fallback passed a plain object instead of `new GuideOptions()` | - |
| `0db20b2` | Wave 4: compositing, 8 groups | 149 -> 167 |
| `13acae2` | Wave 5: the audit's gaps, 14 groups | 167 -> 173 |

Unit tests: 2406 (78 files) -> 4373 (96 files).

Each wave 4 group has the usual three files (`panel/host/ext/<group>.jsx`, `server/src/tools/ext/<group>.ts`, `server/test/ext-<group>.test.ts`). The wave 5 groups mostly extend files that already exist.

**Wave 4** (`planar`, `patchcheck`, `stabilize`, `cleanplate`, `inpaint`, `mattes`, `patchfit`, `screenrep`)

| Group | Tools |
|---|---|
| planar | `ae_track_multi`, `ae_track_read`, `ae_track_apply` |
| patchcheck | `ae_patch_check`, `ae_region_stats` |
| stabilize | `ae_stabilize`, `ae_stabilize_roundtrip` |
| cleanplate | `ae_cleanplate_pick`, `ae_cleanplate_setup` |
| inpaint | `ae_inpaint_plate` |
| mattes | `ae_mask_follow`, `ae_garbage_matte`, `ae_caf_prep` |
| patchfit | `ae_patch_color_match`, `ae_patch_grain`, `ae_patch_finish` |
| screenrep | `ae_screen_corners`, `ae_screen_replace` |

`ae_track_point` keeps its behaviour. `planar` and `patchcheck` were built first because the rest use their tracker, track store and region maths.

**Wave 5: new tools**

| Group | Tools |
|---|---|
| projectitems | `ae_create_comp`, `ae_project_items` |
| projectsettings | `ae_project_settings` (and `import_swatches` on `ae_brief`) |
| view | `ae_view` |
| timeline | `ae_keyframes_transform`, `ae_detect_cuts` (and extensions of `ae_get_keyframes`, `ae_remove_keyframes`, markers) |

**Wave 5: extensions** (no new tool)

| Group | What changed |
|---|---|
| w5core | `ae_run_jsx` and skills get a safety lint; `ae_save` gets `save_as` and `increment`; `ae_status` gets `detail`; `ae_get_layer_props` gets `meta`; `ae_set_property` takes path and marker values, checks fonts and puts expression errors in the receipt |
| w5render | `ae_aerender_start` renders a queue item (`rq_index`) or the whole queue; `ae_render_queue_edit` sets the queued flag and removes items; batches take `queue_items` |
| w5layerops | `ae_layer_ops`: split, replace source, separate or unify Position, solid changes, more switches |
| w5compsettings | `ae_comp_settings`: name, anchored resize, pixel aspect, frame rate, drop frame, length, trim to work area, guides on 26.5 |
| w5animate | `ae_set_text` typography, paragraphs and box options; `ae_import_footage` `import_as` and `range`; `ae_set_keyframe_ease` per-key flags; `ae_replace_footage` `reload` |
| w5fonts | `ae_fonts` search, check, replace; font and glyph checks in the text tools and `ae_preflight`; `ae_measure_text` lines |
| w5masks | `ae_mask` and `ae_text_animator` options |
| w5shapefx | `ae_set_effect` move, duplicate, popups by label, input layer and stage; `ae_shape` strokes, gradients, groups; `ae_path_operator` operators; layer-style route in `ae_add_effect` |
| w5scene3d | `ae_create_layer` lights and parametric meshes; `ae_camera_rig` retunes a camera; `ae_scene_3d_report` lights and models |
| w5props | `ae_get_layer_full` opt-ins; `ae_validate_expressions` `fix`; `ae_purge_unused` `consolidate` and `reduce_to_comp_ids`; Essential Graphics media slots; `ae_render_templates` `save`; `ae_batch_set` paths and markers |

**Shared pieces these waves added or lean on:**
- `server/src/tools/ext/planar.ts`, `planar-math.ts`, `region-math.ts`: the track store (`loadTrack`, `saveTrack`, `resolveTrackSource`), `withIsolatedPlate`, `resolveEffectParams`, `blurrinessFromSigma`, `platesFolderFor`, `createRenderBudget`, `layerSpaceMatrices`, `trackSummary`, `drawTrackSheet`, the homography, region, ring and noise maths. All the wave 4 groups import them. Rules for using them are in `docs/BUILDERS.md`.
- `panel/host/ext/planar.jsx`: `planarIsolateBegin` / `planarIsolateEnd`, `planarLayerSpace`, `planarWriteRaw`, `planarApply`, `planarRead`, `planarEffectSlot` (colour, degrain, blur, pin, motion blur order on a patch layer), `planarKeys`, `planarComp`.
- `runGuardedWrite` takes `undoable: false`: the write is logged as an agent write, but `ae_session_changes` does not list it as an undo step. Used by `ae_fonts` replace and `ae_render_templates` save.
- `scripts/lint-jsx.mjs` also refuses any non-ASCII character in `panel/host/**/*.jsx`.
- `core.jsx` has `statusDetail` and `fontsResolve`, and the helpers `propertyPath` / `resolvePropertyPath` that give `ae_status`, `ae_view`, `ae_keyframes_transform` and `ae_set_property` the same property paths. `session.ts` has `noteUiWrite` for UI-only writes (`ae_view`).
- `ae_save` `save_as` and `increment` move the open project to another file; the session tracker is told.

## What the tools keep on disk

- Data dir `tracks/`: the planar track store, `<track_id>.json`, newest 200 kept. Re-basing never overwrites a stored track (a track re-based on another `ref_time` is saved under a new id); `continue_track_id` adds frames to its own file.
- Data dir `patchfit/`: the state of a chunked `ae_patch_color_match` (`continue_id`), newest 50 kept.
- Data dir `frames/`: the contact sheets, previews and graphs the compositing tools render (as the older frame tools do).
- Next to a saved project, `<name> chroma plates/`: the stills `ae_cleanplate_setup` renders and the PNGs `ae_inpaint_plate` writes (and its preview). Never over an existing file (` 2`, `_2` is added). Needs a saved project; the folder is made only after the guard has passed.
- Temporary comps while a tool runs: `_chroma_plate_...` (the isolated plate) and `chroma-patchcheck-copy ...`. Removed in the same call; if a removal fails the result says so and names the comp.
- `<project>_vNNN.aep` from `ae_save` `increment`; `_mcp_backups/` also holds the copy `ae_save` makes before a `save_as` overwrite.

## How it was checked

- **Builds:** Sonnet agents, one per group, from a written spec each. The specs for wave 5 came from the Scripting Guide audit. Each group came with a handoff (tools, smoke steps, README rows, unmeasured behaviours, edits outside its files).
- **Wave 4 reviews:** Opus checked each group through an AE lens and a server lens, then the groups together with an end-to-end chain check and a shared-code check. 123 issues, 5 of them high. They were fixed, checked again, repaired and confirmed by Opus.
- **Wave 5 reviews:** the same pattern plus a backward-compatibility check of the extended tools: 65 issues, 1 high. Fixed, checked, repaired, confirmed.
- **A repair report claimed tests that were not on disk.** An Opus confirm round caught it. Treat a repair report as a claim, and look at the diff.
- **Tests:** 4373 in 96 files, with the host code run under `node:vm` against `server/test/support/fake-ae.ts`. Many wave 4 and 5 tests patch the fake locally for the members they need (selection, fonts, enums, guides, effects); the fake follows the Scripting Guide, and it is not AE.
- **JSX lint:** `node scripts/lint-jsx.mjs`, 0 issues (61 files, run for this update).
- **Bundle:** `scripts/check-bundle.cjs` over the in-panel MCP at 173 tools, on Node 22 and on AE's Node 17.7.2.
- **Not run in After Effects.** The result fields that exist to show a wrong guess: `read_back` mismatches, `unverified`, `limits_unverified`, `param_table` / `param_tables` (the effect parameter names a tool used and how it found them), `needs_fix`, `sampled N of M frames`.
- **Smoke test:** at the time of writing `qa/smoke-mcp.mjs` has steps for waves 1-3 (144 of 149 tools) and none for waves 4 and 5; those are written as a separate step (see `git log` and `qa/README.md`). Like the earlier ones, they are written from the schemas and have never run.

## AE behaviours relied on but not measured

Each line is a guess the code makes or works around. Where the code can work either way it does, and the read-back reports a mismatch. Deduplicated, and only what the code in `13acae2` still relies on. Grouped by tool group.

**Shared by the wave 4 tools (rendering, effects, keys)**
- `saveFrameToPng` at full size returns the comp's size (the tools scale by image width over comp width; a different size is refused), and writes sRGB display values with colour management on (OCIO, 16 / 32 bpc, linear blending). Bit depth and linear blending are read and reported.
- A render of a fresh `comp.duplicate()` is not a cached frame (`captureCompFrame` retries once with a time nudge). A guide layer, or a layer switched off, is left out of the render.
- Render speed per frame at 1080p / 4K, and every render budget default (track 250 frames / 90 s, patch check 160 / 90 s, region stats 100 / 90 s, clean-plate pick 80 / 120 s, colour match 150 / 90 s), are guesses.
- Tracker settings on real footage: `pre_blur`, the RANSAC distance, the 75% lost threshold for a cut, the search radius capped at 100 px (no pyramid).
- Every threshold in the measuring tools (seam, noise, frozen grain, slip search 16 px, pops, clean-plate scoring) was tuned on synthetic images. Pops report `not_measurable` on shots over about 72 frames unless neighbouring frames are sampled: `every_n: 1` over a short `start` / `end` stretch, or a higher `max_samples`.
- Node 17.7.2 handles the 512 MB inpaint sample budget; run time of inpaint at 1080p / 4K and for holes near the 25% cap; event-loop yields keep the panel responsive.
- `Property.moveTo(index)` exists on effect groups and takes the final 1-based index; `addProperty` appends an effect at the bottom. If `moveTo` is missing the effect stays where it was put and the result says so.
- `setValuesAtTimes` takes `[x, y]` for a 2D Position / Scale and for pin points, and arrays of Shape objects on Mask Shape (about 1000, with feather arrays; without them the tool retries and reports `feather_points_dropped`). New keys are set linear explicitly.
- Hard limits (`hasMin` / `hasMax`) of Position, Scale, Rotation, pin points, Mask Feather and Expansion; a freshly added pin point's limits cannot be read first (`limits_unverified`).
- `Position.dimensionsSeparated` is readable and `ADBE Position_0/_1` exist; separated Position is refused by freeze and clone.
- The `Gaussian Blur` Blurriness is 2.5 per pixel of sigma (`BLURRINESS_PER_SIGMA`), a first estimate to calibrate.

**planar**
- The AE Tracker's match names (`ADBE MTrackers` > `ADBE MTracker` > `ADBE MTracker Pt` > `ADBE MTracker Pt Feature Center` / `... Confidence`), Feature Center in layer space with a top-left origin, Confidence 0 to 100.
- Corner Pin point order (`ADBE Corner Pin-0001..0004` = UL, UR, LL, LR is inferred) and CC Power Pin's point names (Top Left, Top Right, Bottom Left, Bottom Right) with an index fallback; the table used is returned.
- Setting `layer.enabled` on audio-only, camera and light layers (the code skips layers without video).
- A time-remapped or nested-frame-rate plate gives frames on the track's time grid.

**patchcheck**
- `Mask Path` `valueAtTime` returns a Shape (vertices, tangents, closed) in layer space; `maskMode` equals `MaskMode.ADD`; `mask.inverted` exists; sampling 8 steps per segment matches what renders (feather and expansion are not included).
- `sourceRectAtTime` through transforms and parents matches the patch's visible pixels (masked or 3D patches need an explicit `region`).
- A track's `H` maps reference-frame comp px to the frame's comp px, so the region is given as it looks at `ref_time` (tested against stored tracks, not a real Corner Pin).
- `comp.duplicate()` keeps layer indexes (the copy's layer names are checked, a half-made copy is removed); image sizes at lower resolution factors scale the polygons correctly.
- The similarity-fitted slip stays accurate on strongly perspective shots.

**stabilize**
- The Transform effect (`ADBE Geometry2`) and Motion Tile (`ADBE Tile`) parameter names and order (mapped by English display name with an index fallback; the table is returned in `param_tables`), and that a Motion Tile with output above 100% keeps the layer's pixel coordinates.
- A guide layer inside a nested comp is left out of the parent's render and of `saveFrameToPng`. This decides `ae_stabilize_roundtrip`; the fallback `guide_mode: "opacity_switch"` uses a Checkbox Control and an opacity expression `comp(...).layer(...).effect(...)("Checkbox")` that is also unmeasured. Check this first.
- `Layer.copyToComp` returns void and puts the copy at layer 1 of the work comp; undo after `copyToComp` on a layer with effects has crashed AE before.
- `comp.layers.add(workComp)` defaults (start, in, out are set explicitly); Anchor Point on a 2D layer reads `[x, y, z]`; a Stabilize effect keeps its custom name through save and load.
- The residual-motion check is accurate to a few tenths of a pixel on half-size snapshots.

**cleanplate and inpaint**
- Precomposing a time-remapped duplicate keeps its single hold key, and removing every other Time Remap key leaves Time Remap on with one key.
- `importFile` of the rendered or written PNG gets an sRGB interpretation with no premultiply surprise in 8 / 16 / 32 bpc and linear-blending projects.
- A precomp made by `precompose` is centred (the host resets anchor and position); `LayerSamplingQuality.BICUBIC`, `FrameBlendingType.NO_FRAME_BLEND` and `layer.motionBlur` are settable on it (each in a try).
- The index a script-added mask receives (re-resolved by `propertyIndex`); setting `inPoint` / `outPoint` after shifting `startTime` restores a shifted clone's extent.
- The motion-compensated time clone stays aligned on a pan (only the region-centre shift is compensated, not rotation or zoom).
- `FileSource.reload()` raises no dialog and clears `footageMissing`; `FileSource.isStill` is true for an imported single PNG; `Layer.enabled = false` on an unlocked holdout succeeds.
- `saveFrameToPng` of the isolated copy has straight alpha where the plate does not cover the frame (alpha below 250 counts as invalid); `comp.layers.add(footageItem)` of a PNG keeps the source rect equal to the PNG size so mask vertices line up.
- `place_in_comp` `mode: "auto"` only guesses a patch precomp from the word PATCH anywhere in the comp name (set off by spaces, underscores, dots or dashes); use `mode` and `offset_px` for padded work comps and read the rig's pad offset first.
- The temporal fill on real parallax and moving objects (ring gain / offset fit, tolerance 10 gray levels, spread 12) is first-guess.

**mattes**
- A track-matte layer with its video switch off still mattes (documented for 23.0+), one matte layer can feed several targets, a locked matte accepts `setTrackMatte`, and `setTrackMatte` may switch the matte's video off itself (the host sets `enabled` afterwards either way).
- Simple Choker's match names (`ADBE Simple Choker-0002`, then `Choke Matte` by name); `app.effects` lists `matchName` in this host (otherwise the choke is attempted).
- `addSolid` with `comp.pixelAspect` and `moveBefore` put the matte exactly above the topmost target; `Layer.isTrackMatte` reads.
- A script-set work area (shrink, set start, set duration) snaps as expected, and `workAreaDuration` accepts start + duration at exactly `comp.duration` (clamped, restored on failure).
- `MaskMotionBlur` enum names and mask `locked`; `featherTypes` assignment on an existing mask.
- The speed of one `setValuesAtTimes` with up to 100k vertex keys (the cap is 300k points per call).
- Content-Aware Fill's generated layer and folder names ("Fill"; `find_fill` matches loosely and says so).

**patchfit**
- Levels (`ADBE Pro Levels2`) and Exposure (`ADBE Exposure2`) parameter names, mapped by display name (no index fallback for Levels, so a renamed or non-English parameter fails with the list the effect has); the unit of Levels values (0..1, 0..255 or 0..32768 by bit depth, found by reading Red Input White); Exposure `Channels` 2 is Individual Channels and `Bypass Linear Light Conversion` takes 1.
- Add Grain (`VISINF Grain Implant`), Match Grain (`VISINF Grain Duplication`) and Remove Grain (`VISINF Grain Removal`): parameter names, the Viewing Mode menu index of Final Output (guessed 3, 5 and 4; `viewing_mode_index` overrides Add and Match Grain, `degrain_viewing_mode_index` overrides Remove Grain), Match Grain's input layer (`setInputLayerAndStage` on 26.5, else `setValue(layer index)`), and Add Grain's noise per unit of Intensity (placeholder 20 gray levels per 1.0, corrected by the tuning rounds).
- CC Force Motion Blur's `Override Shutter Angle` and `Shutter Angle`; `CompItem.shutterAngle` rounds to whole degrees; Median `Radius`.
- `setTrackMatte(patch, ALPHA)` on the new adjustment layer leaves the patch's video on (the host switches it back on); a solid's `startTime` / `outPoint` / `inPoint` setters accept the order used; a checkbox reads 0/1 or a boolean.
- A 3000-frame colour match takes one render per frame (about 0.3 to 1 s at 1080p) plus 8 + 8 verification renders.

**screenrep**
- CC Power Pin has an `Expansion` parameter that takes a percentage (else the corners are pushed out in the keys, `pin.expansion.mode: "values"`); a failed `addProperty('CC Power Pin')` throws, which triggers the Corner Pin fallback.
- Levels (`ADBE Pro Levels2`, then `ADBE Easy Levels2`) parameter names and whether it works on linear values with linear blending on (`app.project.linearizeWorkingSpace` readable; unreadable counts as false); how `saveFrameToPng` encodes frames with a linearized working space.
- `comp.layers.add(precomp)` anchor and position (set explicitly); `Layer.duplicate()` puts the copy directly above and carries the plate's audio (moved and muted explicitly); `layers.add(footageItem, duration)` applies the duration to stills only; `setTrackMatte` leaves the insert visible; a `startTime` set before keys keeps comp-time keys.
- Setting `comp.motionBlur = true` for `transform_pin` is acceptable on the user's comp (reported as `comp_switch_turned_on`).
- The aspect estimate from one perspective view (square pixels, principal point at the comp centre) is accurate on real noisy corners; edge softness and the competing-edge threshold were tuned on synthetic images.

**w5core**
- A top-level property group (Transform) has `parentProperty === null` and `propertyDepth` 0 only for the layer; two fetched references to one Property compare equal (else `A.resolvePropertyPath` matches by `matchName` and `propertyIndex`).
- `selectedProperties` on the comp and on layers, `selectedKeys` as 1-based key indexes, whether group nodes are included; `app.activeViewer`'s shape and whether reading it moves focus.
- Enum names: AE's enum objects may list no keys for `for..in`, so `enumNameOf` also tries a list of known names and falls back to the raw value.
- Font APIs: `designAxesData` member names, `writingScripts`, the shape of `getCTScriptForString` and `getDefaultFontForCTScript`, `fontsDuplicateByPostScriptName`, what `getFontsByPostScriptName` returns for an uninstalled font, the 6000-font / 1500 ms near-match scan, `'name' in doc` on a TextDocument.
- `Property.propertyParameters` / `valueText` return shape; separation leader and follower indexes; `hasMin` on colour and 3D properties; AE rejects path keys with different vertex counts.
- `Project.save(File)` into a read-only folder raises a dialog, and AE does not append `.aep` itself (the server requires it).
- A broken expression leaves `expressionError` populated after `expressionEnabled = false` and `valueAtTime(comp.time, false)`.
- `core.jsx` loads live now that it is ASCII.

**w5render**
- `aerender -rqindex` renders an item (never an unqueued one: the tool refuses), accepts `-output`, `-OMtemplate`, `-RStemplate`, `-s`, `-e` alongside it (the schema refuses them until measured), and what the log, exit code and `PROGRESS` numbering look like with several output modules or items.
- The flag spellings `-mem_usage`, `-continueOnMissingFootage`, `-v ERRORS`, `-sound ON|OFF`.
- aerender creates missing output folders (the launcher makes every module's folder); a frame-rate override in render settings does not change the frame count `ae_verify_render` expects.
- `RenderQueueItem.render = true` without a valid output reads back `NEEDS_OUTPUT`; `RenderQueueItem.remove()` is one undo step.
- The frozen project copy keeps the queue items exactly as the live project had them.

**projectitems**
- `CompItem.duplicate()` names the copy and keeps its folder (the host sets both for deep copies); `AVLayer.replaceSource(copy, false)` may rename a layer (the host restores the name).
- New Comp from Footage strips the extension (the tool strips a 2 to 5 character one); `FootageItem.frameRate` and `duration` are 0 for stills.
- `FolderItem.remove()` deletes the folder's contents; `Project.autoFixExpressions` takes quoted old and new names and rewrites single-quoted references too; `ItemCollection.addFolder` creates in the root and `parentFolder = rootFolder` works; `Item.usedIn` is right for comps nested through comps; `Item.label` and `Item.comment` exist.
- A long ops list (about 50 ops x 500 ids) stays under the bridge's response size after bounding.

**w5layerops**
- `Layer.stretch` accepts -9900..9900 on cameras, lights and nulls, and a negative stretch moves in and out points as assumed.
- `environmentLayer` on a non-Advanced-3D comp throws, is ignored or is accepted (the code probes and the receipt checks); `AutoOrientType.CHARACTERS_TOWARD_CAMERA` exists and needs `threeDPerChar`; `frameBlendingType` is writable on solids, text and shape layers.
- `Layer.duplicate()` keeps an explicit track matte and lands directly above the original.
- `dimensionsSeparated` writes keep the followers' keys; `getSeparationFollower` is 0-based.
- `SolidSource.color`, `FootageItem.width` / `height` / `name` are writable on a solid; `addSolid` + `remove()` + `replaceSource` leaves the new solid in the Solids folder; `replaceSource` keeps the anchor point numbers, and fails for nulls, text, shape, camera, light and model layers; renaming a shared solid renames layers that follow its name; `usedIn` exists on solids.

**w5compsettings**
- A scripted `comp.width` / `height` change keeps layers at the same pixel position from the top-left (the anchored shift assumes it); `setValueAtKey` on a spatial Position key keeps the key's tangents.
- A camera's or light's point of interest is `ADBE Anchor Point`; point lights hide it as ambient lights do.
- Writing `layer.startTime` on a locked layer needs the unlock (the code unlocks and relocks); AE's own Trim Comp to Work Area leaves `displayStartTime` as old + `workAreaStart` (the menu command cannot run through CEP, so only a live comparison shows it).
- `GuideOptions` field names (`orientation`, `position`, `positionType`, `color`, `pinned`), the `GuidePositionType` members (`PIXEL`, `PERCENTAGE`), `addGuide(opts)` and `setGuide(index, opts)` argument order, `getGuideAsObject` field names, bare identifiers resolving; legacy position-type meaning (0 pixel, 1 percentage); pinned guides stay put on a scripted resize.
- `comp.markerProperty` keeps comment, duration, chapter and URL when markers are re-added; a `comp.duration` shorter than the work area is clamped by AE; `comp.frameRate` takes 29.97 exactly or snaps to 30000/1001 (tolerance 0.001); the work-area order shrink, move, shrink works.

**projectsettings**
- Project settings can be undone with Ctrl+Z through `beginUndoGroup` (this is why a checkpoint is taken first when auto checkpoints are on).
- `for..in` over `TimeDisplayType`, `FramesCountType`, `FeetFramesFilmType`, `FootageTimecodeDisplayStartType` and `GpuAccelType` lists their members (the Guide's spelling is added as a fallback); `FeetFramesFilmType` is the right global; what `availableGPUAccelTypes` holds.
- The expression engines are exactly `extendscript` and `javascript-1.0`, and switching re-evaluates existing expressions at once.
- Which colour-management members exist (`ocioConfigFile`, `displayColorSpace`, `lutInterpolationMethod`); a bad `working_space` or `working_gamma` really throws; `displayStartFrame` takes only 0 or 1; `workingGamma` reads back as float32.
- `app.parseSwatchFile` returns the object the Guide describes, with LAB L in 0..1.

**view**
- `openInViewer`, `Viewer.setActive` and `View.setActive` steal keyboard focus through CEP; `app.activeViewer` is null or stale while a panel has focus (the tool then reports "no active viewer" and skips the options).
- After `openInViewer`, `app.project.activeItem` is the opened item; what `AVLayer.openInViewer` returns for footage, text and shape layers; `openInEssentialGraphics` returns nothing.
- `Viewer.views` and `activeViewIndex` are 0-based; the `ViewOptions` members (`channels`, `fastPreview`, guides, rulers) are writable with the `ChannelType` and `FastPreviewType` enums; reading `fastPreview` throws in the Layer and Footage panels (skipped and listed in `missing`); fast preview "draft" is refused on `ADBE Advanced 3d`.
- `CompItem.time` writes mark the project dirty and may land on the undo stack (`dirty_before` / `dirty_after` are returned).
- Selecting a property, `setSelectedAtKey` or `Item.selected` leaves the layer selection and `activeItem` alone (project items are applied first, then `open`), and `setSelectedAtKey` works when the layer is not selected or the comp is not open.
- `noteUiWrite` stops `ae_session_changes` from reporting the selection and time change; the Viewer returned by `openInViewer` compares `===` to `app.activeViewer` (else `options_verifiable` reads false).

**timeline**
- `AVLayer.doSceneEditDetection` returns an array of floats in comp time, may show a progress dialog, blocks the bridge for as long as it takes (`SLOW_TIMEOUT_MS`, 600 s), may push its own undo step when it finds nothing, and `SPLIT` / `SPLIT_PRECOMP` keep the original layer's id for the first shot.
- `Layer.selectedProperties` lists leaf properties with selected keys, and `Property.selectedKeys` returns 1-based indexes; `A.propertyPath` paths resolve for them.
- `getSeparationFollower(dim)` for separated Position: dimension indexes 0..2, the leader has no keys, a Z follower on a 2D layer is keyless or null.
- AE's sign convention for `KeyframeEase.speed`: the reverse negates and swaps non-spatial speeds and only swaps spatial ones; a scale divides speed by the factor and keeps influence. A wrong convention shows as ease mismatches in the read-back.
- Label and selection survive `removeKey` + `setValueAtTime`; AE retimes roving keys when other keys move.
- `MarkerValue` has `frameTarget`, `eventCuePoint`, `protectedRegion`, `getParameters` / `setParameters`; `setValueAtTime` at the same time replaces a marker in place.
- `timeline.jsx` reads `A.__keys` from `stagger.jsx` at call time and relies on the name-order load.

**w5animate**
- `TextDocument.tsume`, `horizontalScale` and `verticalScale` take 0-1 or 0-100 (values are sent as given; the typed read-back shows which).
- The 24.x enum constant names (`FontBaselineOption`, `DigitSet`, `BaselineDirection`, `Direction`, `LineOrientation`, `BoxVerticalAlignment`, `BoxAutoFitPolicy`, `BoxFirstBaselineAlignment`, `LeadingType`) are found by exact name, then by pattern, then loosely; a miss is refused with the members the build has.
- Writing `leading` switches `autoLeading` off and a numeric `kerning` switches `autoKernType` to none; `boxInsetSpacing` is a 4-number array (order unknown); `doc.fontObject = FontObject` sticks on a copy (else `doc.font` is used); `boxText` / `pointText` read on the copy.
- Paragraph-wide attributes through `paragraphRange()` were not attempted: spacing, indents and justification are whole-document only.
- `ImportOptions.rangeStart` / `rangeEnd` (undocumented) work; a PSD imported as a comp may raise a layer-options dialog, an .aep may raise missing-font, footage or conversion dialogs (reported, never suppressed); `canImportAs(ImportAsType.COMP)` is true for PSD and AI; what `COMP_CROPPED_LAYERS` builds.
- `keyLabel` (22.6), `setLabelAtKey` and `setSpatialTangentsAtKey` (with auto-bezier switched off first, other side untouched); roving works only on spatial properties; AE leaves a roving key's ease alone.
- `FileSource.reload()` on a missing file throws or leaves `footageMissing` true, and may dirty the project.
- Limits: text with very many paragraphs or ranges fits the bridge (50 paragraph entries, 200 spans).

**w5fonts**
- `Project.usedFonts` entry shape (read defensively: font, locations as numbers or `{layerID, layerTimeD | layerTimes | times | time}`); `Project.layerByID` and `Layer.containingComp`.
- `Project.replaceFont(from, to, noFontLocking)` takes the FontObject from `usedFonts` for a missing from-font, returns exactly `false` when nothing changed, and `usedFonts` is refreshed by the next evalScript.
- `TextDocument.composedLineRange(i)` is zero-based with `characterStart` / `characterEnd` (end exclusive), `baselineLocs` has 4 floats per line with max-float sentinels for empty lines.
- `FontObject.writingScripts` holds `CTScript` values; `app.fonts.allFonts` scan speed (bounded at 8000 fonts or 2.5 s, then `scan_truncated`); `fontID`, `location` and native names per build.
- `characterRange(i, i+1).font` gives the PostScript name for one character (per-run glyph check, 1500 characters per 30-layer slice); `hasGlyphsFor` counts line breaks as present; `fontsWithDefaultDesignAxes` and `postScriptNameForDesignVector`; `app.project.dirty` is readable.

**w5masks**
- The wiggly selector's child match names (`ADBE Text Wiggly Mode`, `... Max Amount`, `... Min Amount`, `... Temporal Freq`, `... Character Correlation`, `... Temporal Phase`, `... Spatial Phase`, `... Wiggly Lock Dim`, `... Wiggly Random Seed`) and the expression selector's (`ADBE Text Expressible Amount`) were written from memory; resolved by match name, then display name; a miss lists the real children and rolls the animator back. Needs a live probe.
- The range selector's Advanced match names (`ADBE Text Selector Mode`, `... Max Amount`, `... Smoothness`, `... Random Seed`), the animator's character alignment / range / value / offset, `ADBE Text Variable Font Spacing`, `ADBE Text Track Type`, `ADBE Text Character Change Type`, and `ADBE Text Index Start / End / Offset` once Units is Index.
- Menu orders: selector Mode (add, subtract, intersect, min, max, difference = 1..6), Units (percentage, index), Anchor Point Grouping (character, word, line, all); Fill & Stroke, Inter-Character Blending and Tracking Type are exposed as raw menu indexes.
- A new `ADBE Text Animator` comes with no range selector (the code uses the index of the one it adds).
- `PropertyBase.duplicate` on a mask: where the copy lands and what it is named; `moveTo` semantics on masks; a locked mask or layer refuses script writes (refused before the undo group anyway).
- `MaskFeatherFalloff.FFO_LINEAR` / `FFO_SMOOTH`, `MaskMotionBlur.SAME_AS_LAYER` / `ON` / `OFF`; setting `rotoBezier` recomputes tangents.
- `addVariableFontAxis(tag)`: its return value, where the property lands, and that it works only on the animator Properties group; an expression on the expression selector's Amount reports `expressionError`.

**w5shapefx**
- `PropertyBase.duplicate()` returns an object whose `propertyIndex` says where the copy landed (else `duplicate_located: false`); `moveTo(newIndex)` on an effect or shape content means the position after the move.
- `Property.inputLayerAndStage` returns `[layerIndex, stage]`; `getInputStageCycleSafeLimit` is the highest layer index allowed (only recorded and used to refuse a layer above it); the stage values 0 / -1 / -2 match `LayerInputStageType`; restoring the previous pair works.
- `propertyParameters` returns strings for built-in effect popups, not only for Dropdown Menu Control (else the tool asks for the number).
- `canAddProperty` / `addProperty` on `ADBE Layer Styles` works for the ten style names (likely menu-only), and the slot match names end in `/enabled`.
- Stroke dashes: `addProperty('ADBE Vector Stroke Dash 1')` on `ADBE Vector Stroke Dashes`, with Gap and Offset added separately.
- Enum values: Line Cap (1 butt, 2 round, 3 projecting), Line Join (1 miter, 2 round, 3 bevel), Fill Rule (1 non-zero, 2 even-odd), gradient type (1 linear, 2 radial), Merge mode order, Points menus (corner 1, smooth 2); ranges taper 0..100, highlight length -100..100, miter limit at least 1 (other values are not range-checked).
- Wiggle Transform's own Transform group children; a gradient's colour stops are writable (left at the default ramp); AE inserts new stroke, fill and operator items at the end of a group.

**w5scene3d**
- Light option match names beyond the Guide's list (`ADBE Light Cone Feather 2`, `ADBE Casts Shadows`, `ADBE Light Shadow Darkness`, `ADBE Light Shadow Diffusion`); Casts Shadows is set with 1/0; an option not found is skipped and named in `warnings`.
- `LightType.ENVIRONMENT` needs `lightSource` in the same call; the comp renderer strings (`ADBE Calder` = Advanced 3D, `ADBE Advanced 3d` = Classic 3D, tested as a substring "advanced"); environment lights and model layers render only in Advanced 3D (the warnings say "likely"); the AE 24.3-25.1 environment source must be a .hdr or .exr (checked by file name).
- `ParametricMeshType` members (cube, sphere, plane, torus, cone, cylinder), `parametricMeshOptions` and `parametricBevelOptions` are read, changed and reassigned whole, their units and ranges, and whether `threeDLayer` must be set on a mesh.
- `ThreeDModelLayer` / `ParametricMeshLayer` report `reflect.name` equal to the class name; `addVerticalText` / `addVerticalBoxText` (24.2) signatures, with no orientation to read back.
- The 26.3 Advanced 3D camera options (`ADBE Camera Focus Area Width`, `ADBE Camera Near Far Blur Multiplier`), with a display-name scan fallback; Depth of Field `setValue(1)`; `autoOrient` switching one and two node on an existing camera and what happens to the point of interest.
- An environment light exposes shadow options; `addLight` with no type is a point light.

**w5props**
- `AVLayer.sourcePointToComp` / `compPointToSource` take no time argument and convert at the comp's current time (the reply warns when `bounds.time` differs and never moves `comp.time`); on text layers it returns the first character's corner only.
- `Property.essentialPropertySource` returns a Property, an AVLayer or null; `propertyGroup(propertyDepth)` reaches the layer.
- `Project.consolidateFootage` merges only what the plan lists (file-based footage with identical interpretation; pixel aspect, `isStill`, duration and frame rate keep items apart), and returns the removed count; `Project.reduceProject` keeps exactly the dependencies the comp-tree walk finds (expression name lookups, proxies and folders are not traced) and is one undo step.
- `Project.autoFixExpressions` registers an undo step inside `A.withUndo` and touches only broken expressions.
- `isMediaReplacementCompatible` takes the new item and reads as a Boolean; `setAlternateSource` accepts a comp as well as footage; `Layer.canAddToMotionGraphicsTemplate` / `addToMotionGraphicsTemplate` exist for media slots and may open a dialog (never suppressed).
- `saveAsTemplate`: a built-in name may be overwritten silently (the tool requires `allow_replace`), it dirties the project, and when the preferences reach aerender in `ae_render_batch`.

## Impossible by script, and what is used instead

| Cannot be done by script | What is used instead |
|---|---|
| Content-Aware Fill (the panel: method, lighting correction, range, Generate) | `ae_inpaint_plate` makes a clean plate in Node (temporal median over tracked frames, diffusion or patch fill). `ae_caf_prep` sets up what a script can (a tracked Subtract mask, expansion, work area), gives the exact panel steps for the one click only the user can make, and `find_fill` finds the layer CAF generated |
| Roto Brush and Track Mask (strokes, propagation, Freeze) | `ae_mask_follow` and `ae_garbage_matte` follow planar motion only. A moving person or hand needs the user's own roto layer, used as `matte_layer` or a holdout. Screens are keyed with `ae_key_greenscreen` |
| Mocha AE (running it, reading its project data) | The user tracks in Mocha and uses Create Track Data; `ae_track_read` reads the Corner Pin or CC Power Pin keys that leaves. `ae_track_multi` tracks planes inside the MCP |
| Warp Stabilizer VFX (starting, waiting for or reading the analysis) | `ae_stabilize` from a track made by `ae_track_multi` or read by `ae_track_read` |
| The 3D Camera Tracker solve | `ae_track_read` reads keys made from it; nothing reads the solve itself |
| AE's Tracker panel and Track Motion (driving them) | `ae_track_point` and `ae_track_multi`; `ae_track_read` reads the points an AE Tracker already made |
| Clone Stamp and other paint strokes | `ae_cleanplate_setup` builds a freeze, still, spatial or time clone patch; the user paints inside the PATCH precomp and `action: "reload"` takes a painted still |
| Menu commands such as Trim Comp to Work Area through `app.executeCommand` (it does nothing through CEP except Window-menu panels) | Native DOM methods; `ae_comp_settings` trims to the work area itself |
| Custom-data effect parameters (Colorama's Output Cycle, the Curves curve) | An expression link, a saved .ffx preset, or the effect's own preset menu (older finding) |
| A mask path from a vertex list through `ae_set_property` (it does not make a Shape) | `ae_path_write` with `time` |
| A protected region on a layer marker | Comp markers only; the host refuses it up front |
| Writing a gradient's colour stops in `ae_shape` | Not known to be possible; the stops stay at the default ramp |
| Layer styles through `addProperty` | Unproven: the route is tried and, if AE refuses, the tool says to apply an .ffx preset saved from AE |

## Refused on purpose by the `ae_run_jsx` lint

These calls exist in ExtendScript. `server/src/jsx-safety-lint.ts` refuses them in `ae_run_jsx` because they block the bridge, leave After Effects, or have a safer dedicated tool. This is policy, not a missing API.

| Refused call | Why, and what is used instead |
|---|---|
| `RenderQueue.render` (and pause / stop, Media Encoder queueing) from `ae_run_jsx` | `ae_render_queue_render` (AE's own render of the queued items as a tracked job, with a gate that refuses other tools meanwhile), `ae_aerender_start` (a comp, `rq_index` or `whole_queue`) and `ae_render_batch` (background processes). Refused in `ae_run_jsx` because a bare `render()` blocks the bridge for the whole render with no job, no gate and no way to report; Media Encoder queueing leaves AE. A script can stop a render only from an `onStatusChanged` or `app.onError` callback set up before `render()` starts (AE Scripting Guide, `RenderQueue.stopRendering`); `ae_render_queue_render` sets none up, so the user presses Stop in AE |
| Opening, closing and creating projects, `Project.save(file)` from `ae_run_jsx` | `ae_project_session`, and `ae_save` with `save_as` or `increment`. Refused because they swap the project without the unsaved-changes check, can open a dialog, and skip the backup copy, the overwrite checks and the session record |
| Dialogs, file writes and deletes, sockets, running programs, quitting, `$.sleep`, `app.purge`, Team Project calls from `ae_run_jsx` | Refused because they block the bridge, leave AE or need the user's yes. The lint names the tool: `ae_ask_user`, `ae_dialogs`, `ae_memory_purge`, the dedicated tools. Not a sandbox: `eval()` of a built string and `obj['member']` get through |

## Not done, and why

- **A live AE run:** Emre's call; the smoke run is coming, and the first run will likely need adjusted arguments.
- **Smoke steps for waves 4 and 5:** see the check list above.
- **`ae_comp_diff` and the guide format:** `ae_comp_fingerprint` now stores guides as words (`horizontal` / `vertical`, `pixel` / `percentage`). A diff against a fingerprint taken before the change shows one `comp.guides` difference that is only the format. Take a fresh "before". A note in the `ae_comp_diff` output was suggested and not added.
- **`ae_keyframes_transform` in `ae_multi_comp_apply`:** not added. `keys: "selected"` resolves against the active comp only.
- **A moving person or hand as a holdout, and a deforming mask:** needs the user's own roto (see above).
- **Calibration:** every threshold and first estimate in the measuring tools (Blurriness per sigma, grain noise per intensity, seam and slip thresholds, budgets) waits for real footage.
- **Optional `fake-ae.ts` additions** the builders listed (selection, fonts, enums, guides, effect factories). The tests patch the fake locally, so nothing is missing; moving the patches into the shared fake would let the next group reuse them.
- **Deadline submission and the Premiere round trip:** unchanged, out of scope.

## Suggested next steps

1. Run the live smoke in a scratch project (a copy of a real one is better) on AE 26.2.1: `node qa/smoke-mcp.mjs --dir <fresh dir under a /_work/qa/ path>`. Fix what fails, add each measured behaviour to `docs/BUILDERS.md`, and put the facts an agent needs into the tool descriptions.
2. Check these first, because other tools build on them or a wrong guess does damage:
   - **the guide layer in a nested comp** (`ae_stabilize_roundtrip`): whether it stays out of the parent's render and of `saveFrameToPng`. Do this before the other wave 4 steps; it decides `guide_mode`.
   - **`saveFrameToPng` size and colour** on a 1080p comp: every compositing tool maps pixels through it.
   - **effect parameter tables** (`param_table`, `param_tables`) of Corner Pin, CC Power Pin, Levels, Exposure, Transform, Motion Tile, Add / Match / Remove Grain: eyeball them once; the match names are guesses.
   - **`ae_track_multi` then `ae_track_apply`** onto a Corner Pin on a shot you know: the point order, and that the preview sheet agrees.
   - **the temporary comps** (`ae_track_multi` with `isolate_layers`, `ae_region_stats` with `hide_layers`, `ae_patch_check`): two undo entries, the copy gone, a fresh render each time.
   - **`ae_save` `save_as` and `increment`:** the session tracker after the project moved, and no dialog.
   - **`ae_fonts` replace:** `Project.replaceFont` with a substituted from-font, and that `ae_session_changes` does not list it as an undo step.
   - **`ae_project_settings`:** whether Ctrl+Z undoes a bit-depth or colour-space change (the checkpoint is the safety net when it was taken; the result's `checkpoint` is null if it was skipped).
   - **`ae_aerender_start` `rq_index`:** `-rqindex` with a queued item, then the whole queue.
   - **`ae_view`:** that it takes no focus, and that `restore` puts the state back.
   - **`ae_detect_cuts`** on a short flattened clip first; a long one blocks AE.
3. Then the 0.4 steps below (push to the private copy for CI, decide on 0.4.0, bump versions together).

---

# Handover: 0.4 waves 1-3, 2026-11-03 onward

> Waves 4 and 5 came after this section: see the section above it (`# Handover: 0.4 waves 4 and 5`). The counts below (149 tools, 2406 tests) stop at wave 3.

After the 0.4 roadmap work below, Emre asked for about 27 more tool groups, ranked from research, built in three waves on the same branch `feat/roadmap-0.4`. One commit per wave, and one more for waves 1 and 2 for the fixes an Opus re-check found. Emre again decided against a live After Effects test. **None of the wave 1-3 tools has run in After Effects.** This section covers:
- what was added;
- how it was checked;
- the AE behaviours the code relies on that nobody has measured;
- what was not built, and what to do next.

Nothing is pushed. Nothing here is released.

## Where it is

| Commit | Wave | Groups |
|---|---|---|
| `3beab78` | 1 | layer ops, multi-comp apply, annotated frames, comp settings, preflight, session changes |
| `47bd90e` | 1 | fixes from an Opus re-check |
| `3d26ee0` | 2 | captions, rigs, text fitting, staggering, time remap, camera, layer diagnosis, scrub check, footage interpretation, paths, memory, comp description |
| `ef8056e` | 2 | fixes from an Opus re-check |
| `77df0d0` | 3 | render queue edits, batch render, collect, delivery, loudness, legibility, variants, taste learning, project session |

Tools: 80 -> 87 (wave 1) -> 120 (wave 2) -> 149 (wave 3). Unit tests: 610 -> 929 -> 1635 -> 2406 in 78 files (50 files before).

Each group has the same three files: `panel/host/ext/<group>.jsx`, `server/src/tools/ext/<group>.ts` and `server/test/ext-<group>.test.ts`.

**Wave 1** (`layerops`, `multicomp`, `annotate`, `compsettings`, `preflight`, `session`)

| Group | Tools |
|---|---|
| layerops | `ae_layer_ops` (parent, reorder, sort, duplicate, delete, trim, rename, switches) |
| multicomp | `ae_multi_comp_apply` |
| annotate | `ae_annotate_frame` |
| compsettings | `ae_get_comp_settings`, `ae_comp_settings` |
| preflight | `ae_preflight` |
| session | `ae_session_changes`, and a `user_changed` line on every write receipt |

**Wave 2** (`captions`, `rig`, `fittext`, `stagger`, `timeremap`, `camera`, `explain`, `describe`, `scrub`, `interpret`, `paths`, `memory`)

| Group | Tools |
|---|---|
| captions | `ae_captions_plan`, `ae_captions`, `ae_captions_read` |
| rig | `ae_rig_add_controls`, `ae_rig_link`, `ae_rig_unlink`, `ae_rig_rename`, `ae_rig_list`, `ae_expr_recipes`, `ae_expr_recipe` |
| fittext | `ae_measure_text`, `ae_fit_text`, `ae_text_backdrop`; style ranges in `ae_set_text` |
| stagger | `ae_stagger`, `ae_stagger_layout` |
| timeremap | `ae_get_time_remap`, `ae_time_remap` |
| camera | `ae_camera_rig`, `ae_scene_3d_report` |
| explain | `ae_explain_layer`, `ae_explain_layer_proof` |
| describe | `ae_describe_comp` |
| scrub | `ae_scrub_check` |
| interpret | `ae_get_footage_interpretation`, `ae_set_footage_interpretation`, `ae_footage_proxy` |
| paths | `ae_path_read`, `ae_path_write`, `ae_path_operator`, `ae_path_link`, `ae_path_connector` |
| memory | `ae_memory_status`, `ae_memory_purge` |

**Wave 3** (`rqedit`, `renderbatch`, `collect`, `deliver`, `loudness`, `legibility`, `variants`, `learntaste`, `projectsession`)

| Group | Tools |
|---|---|
| rqedit | `ae_render_queue_inspect`, `ae_render_queue_edit`, `ae_render_queue_duplicate`, `ae_delivery_specs`, `ae_render_queue_apply_spec`, `ae_check_delivery_file` |
| renderbatch | `ae_render_batch_plan`, `ae_render_batch`, `ae_render_batch_status`, `ae_render_batch_resume`, `ae_render_batch_cancel` |
| collect | `ae_collect_files`, `ae_collect_relink`, `ae_collect_report` |
| deliver | `ae_deliver_recipe`, `ae_deliver_step`, `ae_deliver_status` |
| loudness | `ae_loudness_check`, `ae_loudness_apply` |
| legibility | `ae_check_text_overlap`, `ae_estimate_legibility`, `ae_check_legibility` |
| variants | `ae_variants`, `ae_variants_pick`, `ae_variants_discard` |
| learntaste | `ae_taste_baseline`, `ae_learn_taste`, `ae_taste_rules` |
| projectsession | `ae_project_session` |

**Shared pieces these waves added or lean on:**
- `server/src/tools/ext/session.ts`: the session tracker. After each guarded write it keeps a snapshot, writes a write-ahead record while the write runs (a record left at the next start becomes a quarantine entry), and logs every agent write per project (`agentWritesSince`). `installSessionTracking()` and `installSessionBridgeHook(bridge)` run at startup. `ae_learn_taste` and `ae_project_session` read the write log.
- `write-runner.ts`: `HostCall.timeoutMs` for slow writes, and `no_op: true` from a host means no undo step is recorded.
- A tool that closes or reopens a project calls `markReopened()` so earlier undo steps are reported as gone (`ae_collect_relink`, `ae_project_session`). The bridge hook does the same for any write whose script calls `openProject(`.
- Write tools that touch a locked layer, a keyframed property or a missing sub-property refuse before the undo group, and look a property up again after `addProperty`.

## How it was checked

- **Builds:** each wave was built by Sonnet agents, one per group, from a written spec, and each group came with a handoff (smoke steps, unmeasured behaviours, README rows).
- **Reviews:** each group was checked by Opus through two lenses (the AE host side and the server side), repaired, and checked again. Wave 3 also had two cross-group checks. After the wave 1 and wave 2 commits an Opus re-check of the repairs found 36 issues (8 medium) and 62 issues (2 high); those were fixed and checked again in `47bd90e` and `ef8056e`.
- **Tests:** 2406 tests in 78 files, with the host code run under `node:vm` against `server/test/support/fake-ae.ts`. The fake follows AE where the code depends on it, and it is not AE.
- **JSX lint:** `node scripts/lint-jsx.mjs` over `panel/host/**/*.jsx`.
- **Bundle:** `scripts/check-bundle.cjs` over the in-panel MCP on Node 22 and on AE's Node 17.7.2 (149 tools, both passing, run before the wave 3 commit; the wave 2 fixes were also checked alone, at 120 tools).
- **Not run in After Effects.** The tool descriptions say what a result proves. The read-backs, receipts and the `unverified` states are there so a wrong guess about AE shows up in a result and not as a silent bad edit.

## AE behaviours relied on but not measured

Each line is a guess the code makes or works around. Where the code can work either way it does, and the read-back reports a mismatch. Grouped by tool group, one line each.

**layerops**
- A removed Layer object throws on every property read (the code does not read layers after `remove()`).
- The blend mode enum is spelled `SILHOUETE_ALPHA` or `SILHOUETTE_ALPHA` (both are tried).
- A refused trim setter leaves earlier setters applied; the code restores the times and reports `partial_ids` if it cannot.
- `copyToComp` puts new copies on top of the destination.

**multicomp**
- `compFingerprint` truncates at 500 layers / 5000 properties as in the tests.
- A crash mid-job leaves `<project>.jobs.json` readable (atomic rename, `in_flight` saved before each inner write).
- Property paths from display names work in every language (match names are recommended).

**annotate**
- `guideLayer` is readable through CEP (read in a try, false on failure).
- A soloed audio-only layer, camera or light does not hide other layers.

**compsettings**
- AE refuses or ignores a renderer that is not in `comp.renderers` (the tool validates first).
- `motionBlurSamplesPerFrame` is clamped to the adaptive limit (write order: limit, samples, limit).
- The guide API of AE 26.5+: which form exists, whether a guide orientation enum is exposed, and the position type values.
- `displayStartFrame` takes -10800..86339 s at frame granularity.

**preflight**
- Which built-in effects AE hides from `app.effects` (Paint, Puppet, Roto Brush): an allow-list covers the known ones.
- `valueAtTime` on CUSTOM_VALUE or NO_VALUE properties, and on an expression in error (throw, or only `expressionError`); both paths are handled.
- AE creates a missing output folder at render time (a low-confidence warning).
- `proxySource` / `useProxy` on a comp.

**session**
- `Project.revision`: when AE 26 exposes it and what moves it. Only a hint.
- The cost of `sessionSnapshot` on huge projects (two snapshots per guarded write).
- A CEP service reload and a Save As leave the undo stack alone; `app.buildNumber` changes only when AE restarts or updates.
- Wrapping `bridge.evalRaw` catches every tool path in the real PanelHost.

**captions**
- `boxTextPos` is readable, and Position minus `boxTextPos` is the box's top-left corner (falls back to `sourceRectAtTime` and the anchor when it is absent).
- A Range Selector with Units = Index, Based On = Words and hold-keyed Index Start/End = (i, i+1) highlights exactly word i; Index End is exclusive; the Index properties exist right after Units is switched.
- `setInterpolationTypeAtKey(HOLD)` is accepted on selector Start/End.
- Text animators can be removed with `property(i).remove()` through CEP.
- `setValueAtTime` times are comp time when a layer's `startTime` is not 0 (new layers start at 0).
- `TextDocument.justification` sticks after `setValue` (checked in the read-back).
- One evalScript makes 500 captions inside the bridge timeout.
- `sourceRectAtTime` gives usable extents for the safe-area test.

**rig**
- Layer Control's value can be set with a layer index and reads back as that index.
- Slider and angle control limits (the code assumes +-1,000,000 and 1e9).
- `setPropertyParameters` on a Dropdown Control keeps the effect reference valid (the host looks the effect up again by index).
- `autoFixExpressions` updates expressions after an effect rename, and reaches other comps.
- Each recipe evaluates the same under the `javascript-1.0` and `extendscript` engines (array maths in bounce, overshoot, velocity, follow-text).

**fittext**
- `characterRange` on a text document copy reflects a new `.text`; the end index is exclusive or inclusive (the code adapts).
- `sourceRectAtTime` returns glyph bounds or the box for box text; `boxOverflow` and `autoLeading` exist on the running build (probed).
- Point-text width is near-linear in font size on AE 26 (one correction pass).
- A Scale expression that reads its own layer's `sourceRectAtTime` evaluates without a cycle (the backdrop).
- A whole-document `fontSize` write may wipe per-range sizes (runs are scaled one by one instead).

**stagger**
- `setTemporalEaseAtKey` and `setSpatialTangentsAtKey` clear auto-bezier themselves; one bezier side does not change the other.
- AE merges keys that round to the same frame the way `Math.round(t / frameDuration)` predicts; key times are comp time.
- `keyLabel`, `setLabelAtKey` and `keySelected` exist (AE 22.6+).
- Writing `layer.startTime` carries keys, markers and time-remap keys as the UI does.
- Roving keys after a rebuild: where AE puts them and which it refuses.
- A rebuild of up to 1000 keys stays one undo step.

**timeremap**
- Ease speed on Time Remap is source seconds per comp second (only the bezier ramp depends on it; the default method is `per_frame`).
- Setting `timeRemapEnabled` adds keys of its own; the tool removes them and writes its own.
- `loopOut("cycle")` repeats the clip without a repeated or dropped frame at the seam.
- A remap value at the full source duration is accepted, and shows blank (the tool clamps one frame below).
- `setValuesAtTimes` takes 100 to 3000 values on a Time Remap property.
- How `layer.stretch` moves `inPoint`, `outPoint` and `startTime`.

**camera**
- The camera's point of interest is `ADBE Point of Interest` (falls back to `ADBE Anchor Point`).
- The sign of X/Y rotation (inherited from `annotate`), and a parented two-node camera's point of interest.
- Setting `autoOrient` to no auto-orient hides the Point of Interest.
- The zoom set by script matches the Camera Settings dialog for the comp's film size.
- The Focus Distance expression lands on the target's sharp plane in Classic and Advanced 3D.
- The new camera is the active one (the top-most enabled camera inside its range).

**explain**
- `layer.solo = true` on the copy's target renders it with the other soloed layers.
- `comp.duplicate()` keeps `trackMatteLayer` links; `Layer.activeAtTime` and `isTrackMatte` exist.
- A matte layer with its video switch off still mattes.
- `comp.duplicate()` and `item.remove()` leave exactly two undo entries.
- The behind-camera maths holds for two-node and unrotated one-node cameras only (others go to `unchecked`).

**describe**
- `valueAtTime(t, false)` returns the value after expressions; the expression and overshoot sampling depend on it.
- A layer-picking effect parameter (`LAYER_INDEX`) returns the 1-based layer index, 0 for None.
- The beat clustering reads well on real comps (thresholds not judged on real files).
- The cost of the property walk on 300-500 layer comps, and the readability of the Gantt picture at 100+ layers.

**scrub**
- Properties read right after `conformFrameRate` in the same script are stale (the code does not depend on it).
- `conformFrameRate` keeps the frame count; frame rates 100..999 are accepted.
- `saveFrameToPng` on a temporary comp returns the right decoded frame for H.264 and ProRes (the guard checks mtime and size only).
- Sampling at frame start + 0.25 frame lands on the intended source frame at 23.976 and 29.97.
- The default thresholds (pop, frozen, flicker) suit real motion design; they are tunable per call.
- `comp.remove()` then `item.remove()` leaves no trace (two undo steps and a changed project).

**interpret**
- `conformFrameRate` reads back as 0 or the native rate after setting 0 (both accepted).
- Every `SetProxy*` call sets `useProxy` true.
- The Proxy Use string from `getSettings(STRING)`; if the key is absent the result says `proxy_use_unreadable`.
- `guessAlphaMode()` and `guessPulldown()` do not raise a modal dialog.
- `pixelAspect` is writable on every footage kind; the enum key names (`AlphaMode`, `PulldownPhase`, ...) match.
- A failed multi-step write restores old values (best effort per step).

**paths**
- Repeater Order values (above 1, below 2): the read-back cannot tell them apart, so the result carries `order_mapping: "unverified"`. Check once by hand.
- Match names and values for Trim Type, Offset Line Join and the Repeater Transform children (the result lists `transform_children`).
- A new operator lands at the end of a vectors group; `moveTo` exists.
- `valueAtTime(comp.time, true)` returns the pre-expression path.
- `setValueAtTime` on a keyed path keeps interpolation and ease (the host restores them).
- A path with a different vertex count throws or loses feather points (refused unless `allow_feather_loss`).
- The connector's `fromComp(toComp(...))` lands on the endpoints, and setting `path.expression` raises no dialog.

**memory**
- Whether `ALL_MEMORY_CACHES` and `ALL_CACHES` clear the undo history; the result says `undo_history_may_be_cleared`.
- `app.purge(UNDO_CACHES)` raises no confirm dialog through CEP.
- Which preference file and section hold the cache settings (the tool only reads keys the caller names).
- `app.project.dirty` reads as a boolean (anything else counts as unsaved and refuses).
- `app.memoryInUse` matches Task Manager.

**rqedit**
- The `STRING_SETTABLE` key names and value types per render setting and output module (the spec library's names come from a community dump).
- `setSettings` throws, returns false or ignores an unknown key; keys stay settable after `applyTemplate` changes the format.
- Where `RenderQueueItem.duplicate()` puts the copy, and whether it copies the output module paths (the tool finds the copy from queue signatures and gives each its own file).
- The output file path round-trips through `fsName` including the `[#####]` token.
- Template names like `H.264 - Match Render Settings - 15 Mbps` and `Apple ProRes 422 HQ` exist on the machine.
- Editing a DONE item is allowed; output module numbering after `remove()`.
- `Folder.getFiles(mask)` finds frames for the overwrite refusal; file names arrive URI-encoded.

**rqrender** (`ae_render_queue_render`)
- The Render Queue panel (Stop button) stays usable while a script-started `render()` runs.
- `render()` keeps one evalScript open for hours without CEP or the panel cutting it off; `status`, `elapsedSeconds` and the output files read as expected afterwards.
- With `overwrite: true`, whether AE prompts about an existing file or overwrites it silently.
- What `render()` does on an unsaved project (a Save dialog is possible; `ae_dialogs` reads it).
- A popup during the render can be read by `ae_dialogs` (it reads from outside AE).
- The stdio relay (`dist/index.js` stdio to the panel) reaches the panel with `http.request` and no timeout, posting to `/mcp`; it was not measured for a request that long. The dev stdio server (`BridgeClient`, Node fetch, 300 s headers timeout) would read a long render as unreachable, so `ae_render_queue_render` is refused there (no `ctx.serviceInfo`) and `POST /eval` is refused while the gate is shut.
- Whether "Save in subfolder" makes its folder at render time (a missing folder under an existing parent is only a warning).
- A service reload during a render: port 7790 stays closed until the render ends (`ensureCoreJsxLoaded` waits on AE before `tryListen`); the job reads `lost`. Boot order is unchanged.
- Whether `ae_open_panel` / `ae_list_panels` (direct `__adobe_cep__` calls) block during a render: they are refused while the gate is shut; `ae_ask_user` skips only its panel-open call.

**renderbatch**
- `aerender -s/-e` count from 0 or from the display start (the plan warns for a non-zero display start).
- Whether aerender overwrites an existing output or fails (the tool protects recent files itself).
- How often aerender flushes PROGRESS lines to the log (`stall_minutes` default 15 is advice only).
- `-mfr ON <percent>` works on AE 26 (default cap 50 is a guess).
- Relative footage paths resolve from the copied .aep in the batch folder.
- A detached aerender outlives a panel restart; resume decides by pid liveness.
- A bad template shows up as `aerender ERROR` in the log when the queue was empty at plan time.

**collect**
- `FootageItem.replace()` / `replaceWithSequence()` keep a custom item name and `useProxy`; the code restores both and checks.
- `setProxy()` turns the proxy on (restored, then checked).
- `app.open()` on the copy with missing footage raises a modal dialog that blocks the bridge until `ae_dialogs` answers it.
- Footage item ids stay stable in a saved copy (the relink matches by file path instead).
- A sequence's reported file is one frame of the same folder and pattern; `replaceWithSequence(file, false)` keeps order and placeholders.
- `removeUnusedFootage` / `reduceProject` keep comps that only expressions reference.
- Throughput of copy, sha1 and zip on multi-GB files in the panel's Node 17, and ZIP64 on real huge files.
- The cost of close, open copy, relink, save, close, reopen original on a large project.

**deliver**
- `ae_render_batch`, `ae_loudness_check` and `ae_collect_files` return the shapes the stage classifier expects, and accept `comp_id`, `comp_name`, `expect` and `path`.
- `ae_verify_render` and `ae_scrub_check` mark the project changed even though they remove what they import (the second save stage assumes they do).
- A Dropbox-held `.deliver.json` fails with a non-ENOENT error (EBUSY, EPERM).
- Real timing of a YouTube plus Instagram batch with verification while the person keeps editing.

**loudness**
- Audio Levels `hasMin`/`minValue` and `hasMax`/`maxValue` (the tests assume -192 and +24 dB), and whether a TwoD property gives a number or a pair.
- `Property.setValueAtKey` exists and keeps the key's interpolation (falls back to `setValueAtTime` only if absent).
- `setValueAtTime` at the layer's in and out points creates keys at those times, and replaces a key at an existing time.
- `hasAudio` is true for precomp layers whose comp has sound, and they have their own Audio Levels.
- Accuracy against a real render (a -23 dBFS 997 Hz tone should read -23.0 LUFS +-0.1); the true-peak filter is a 12-tap approximation.
- Run time and memory on a 20-minute stereo render in Node 17 (about 460 MB of samples).
- The stock `AIFF 48kHz` template is 16-bit stereo; re-measuring after `ae_loudness_apply` needs `ae_save` and a second render.

**legibility**
- `saveFrameToPng` writes sRGB values with colour management on (the notes say so).
- A render of a fresh `comp.duplicate()` with a layer disabled is not a cached frame (an unchanged frame is reported inconclusive).
- The diff mask copes with antialiasing, motion blur, grain and shadows (sensitivity 0.02 and colour tolerance 26/255 are guesses; a heavy drop shadow can push a pass to inconclusive).
- `sourceRectAtTime` for box text against point text; animators that move characters are not reflected.
- `CharacterRange.fillColor` reads null when mixed.
- Duplicate plus remove leaves nothing behind (the receipt checks item and temp comp counts).

**variants**
- `CompItem.duplicate()` shares nested precomp sources.
- Layer index and name map 1:1 between a comp and its duplicate (checked, rolled back on mismatch).
- One `A.withUndo` around duplicate, folder move and all writes is one undo entry; so is promote or discard.
- `saveFrameToPng` on a duplicated, non-active comp returns new pixels.
- `setTemporalEaseAtKey` on roving keys.
- Spatial ease speeds use straight-line length, so they are approximate (only influence and interpolation are verified).
- The ask flow end to end in the real panel.

**learntaste**
- `app.project.revision` goes up for scripted writes; used only as a hint (a lower revision marks a reopen or revert).
- A user Ctrl+Z of an agent write shows as an ordinary diff, not a rejection.
- `keyInTemporalEase` / `keyOutTemporalEase` read sensibly for every transform property; roving keys may read differently.
- `Property.dimensionsSeparated` is readable on `ADBE Position`.
- The 20000-key budget and its `truncated` flag on a large comp.
- The edge-margin check uses Position, not text bounds, so it is approximate for non-default anchors.

**projectsession**
- The Auto-Save preference section, key names and PREFType file (the host probes several; `probe` lets the agent pass others).
- `savePrefAs*` plus `saveToDisk` changes the running Auto-Save, or only the next launch.
- Which dialogs `app.open` raises, whether evalScript blocks until they are answered, and whether `ae_dialogs` sees them.
- `Project.close`, `app.newProject()` and `app.open()` return as the code expects through CEP, and the bridge stays healthy.
- `Project.save()` from the timed policy does not interrupt typing or dragging.
- The Auto-Save folder name matches `/^Adobe After Effects.*Auto-Save$/`.
- A project converted from an older version reads as untitled.

## Not done, and why

- **`ae_keyframe_edit`:** not in the ranked list. Use `ae_set_property`, `ae_set_keyframe_ease`, `ae_remove_keyframes` and `ae_stagger` (copy and offset keys).
- **Full MarkerValue for markers** (cue points, chapters, frame targets, URLs): not in the list. The marker tools take a comment, duration and label colour.
- **`ae_visual_receipt`:** not in the list. `ae_annotate_frame` and `ae_snapshot_frame` cover frames.
- **Deadline submission and the Premiere round trip:** both leave After Effects, which is out of scope (Emre's rule). `ae_export_mogrt` covers the template side of a Premiere handoff.
- **A live AE run:** Emre's call.
- **Still left for when a job needs them:** the P3 rows in `docs/FEATURES.md` (single-layer snapshots, matching a reference frame, a project JSON export, several AE instances, failure recovery by id).

## Suggested next steps

1. Run a live smoke in a scratch project (a copy of a real one is better), on AE 26.2.1, before any release. Start with `node qa/smoke-mcp.mjs --dir <fresh dir under a /_work/qa/ path>`; it has steps for 144 of the 149 tools, waves 1-3 included (written from the schemas, never run; `qa/README.md` lists what it skips and why, and the first live run will likely need some arguments and checks adjusted).
2. Watch these first, because other tools build on them or a wrong guess does damage:
   - **session tracking:** `ae_session_changes` after two or three writes, a Save As and a service reload. Every write receipt now depends on its snapshots.
   - **`comp.duplicate()` tools** (`ae_explain_layer_proof`, `ae_check_legibility`, `ae_variants`): the undo entries left, the temporary comp removed, `saveFrameToPng` returning fresh pixels.
   - **`ae_project_session` and `ae_collect_relink`:** they close and reopen projects. Try on a throwaway project; watch for modal dialogs and read them with `ae_dialogs`.
   - **`ae_render_batch`:** the `-s/-e` frame counting on a comp with a display start, and an orphaned aerender after a panel restart.
   - **Key rebuilds** (`ae_stagger`, `ae_time_remap`, `ae_path_write`, `ae_loudness_apply`): the separate read-back is where a wrong guess about ease or interpolation shows.
   - **`ae_loudness_check`:** a -23 dBFS tone against -23.0 LUFS.
   - **`ae_path_operator`:** set Repeater Composite to Above by hand and read it, to settle `order_mapping`.
3. Fix what fails. Add each measured behaviour to `docs/BUILDERS.md`, and put the facts an agent needs into the tool descriptions.
4. Then the 0.4 steps below (push to the private copy for CI, decide on 0.4.0, bump versions together).

---

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
   - **v0.4.1 released the same day** with the panel changes below (update button, one-AI Register with that twirls closed, service events in the Log, links in a footer). Jay previewed the panel in AE 26.3 on PRISM through the dev junction before the release. Update itself is first tried when 0.4.2 ships.
3. On a Mac: the macOS popup reading still open from 0.3.

## The 0.4.0 panel (2026-11-03)

Built from the panel design canvas (designs #21 to #24): session tiles (tool calls, queued, errors, median reply, checkpoints), a chart of the last 20 reply times, Register with as a four-way control, a full-width Copy setup command, and a Log that is closed, open below the tiles, or fills the panel (the corner-arrows button; the choice is kept in `localStorage`).

- **Where the numbers come from.** The server now writes one service-log line per MCP tool call (`tool <name> ok (<ms>ms)` or `tool <name> failed (<ms>ms): <why>`, in `mcp-rpc.ts`) and one per automatic checkpoint (`Checkpoint saved before <tool>: <file>`, in `tools/mutate.ts`, through the new `ctx.log`). `panel/client/common.js` (`parseToolLine`, `createSessionStats`) turns them into the tiles and the Log; a session starts at the service's `Listening on` line. Tested in `server/test/panel-stats.test.ts`.
- **Left out of the designs:** per-entry Undo (nothing on the server can undo one call's change; checkpoints and AE's own Undo still work) and plain-English descriptions of each call (the Log shows the tool name). New token and Save diagnostics stay, as small links (now in the footer under the Log).
- **The Log shows service events too** (added after Jay's first look in AE, where a fresh session showed only "Nothing yet" and a green raw log): server started, token loaded, MCP tools loaded, AE scripting ready, warnings and errors, in plain words (`describeEvent` in `common.js`). Per-evalScript `<-` lines stay in the raw log only. A new session keeps the start-up lines written in the 60 s before its `Listening on`. Panel messages (`logUi`) go through the same parser, so register results and update steps appear too.
- **Register with picks one AI** (Jay: one at a time, then copy that AI's command). The chips are a radio group (choice kept in `localStorage` as `chroma-ae-mcp.client`); Copy uses `register.cjs` `setupText`: `claude mcp add ...` with the token for Claude Code, `codex mcp add chroma-ae -- <node> <relay>` for Codex, and the `"chroma-ae": {command, args}` entry for Claude Desktop and Cursor. The one-click config writing (`setRegistered`) is no longer on the chips; it stays for re-registering Claude Code after New token.
- **Register with twirls down** (Jay: only needed once). It starts closed when any AI is already set up, open when none is, and keeps the user's own choice after a click (`chroma-ae-mcp.registerOpen`). Closed, it shows which AIs are set up. New token, Save diagnostics and Check for updates sit in a footer at the very bottom of the panel, under the Log (visible in every Log state, hidden while a question is open).
- **Update button.** `panel.js` ("Update from the latest GitHub release") fetches `releases/latest` 8 s after start and on Check for updates; `common.js` `parseLatestRelease` picks the `.zxp` and its SHA256 (the asset `digest`, else a 64-hex string in the release notes, so keep the SHA256 in the notes). Update downloads to `~/Downloads` (redirects followed), refuses on a SHA256 mismatch or a missing hash, then opens the file with `explorer.exe` / `open` so the registered ZXP installer runs. It does not unpack over its own extension folder: that needs admin for the shared CEP folder and could delete through a dev junction. A junctioned (dev) install shows the notice without the button. Checked against the live v0.4.0 release (download and hash match); not yet clicked inside AE.
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
