# Handover: 0.4 waves 1-3, 2026-11-03 onward

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
2. Decide whether to release 0.4.0 untested in AE, or after a smoke run.
3. If releasing: bump `VERSION`, `server/package.json`, `server/package-lock.json` and `SERVER_VERSION` together; then run `scripts/package.ps1`, tag and create the release.
4. On a Mac: the macOS popup reading still open from 0.3.

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
