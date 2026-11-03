# Feature list and gap analysis

Last updated: 2026-11-03: the 0.4 work (branch `feat/roadmap-0.4`, unreleased): every P2 item and the in-scope P3 items, plus render verification inside AE (80 tools), and then three more waves of tools (149 in all). Wave 1: layer ops, multi-comp apply, annotated frames, comp settings, preflight, session changes. Wave 2: captions, rigs, text fitting, staggering, time remap, camera, layer diagnosis, comp description, scrub check, footage, paths, memory. Wave 3: render queue edits, batch render, collect, delivery, loudness, legibility, variants, taste learning, project session. The new tools pass the build, unit tests and lint, and their host code runs against a simulated AE DOM, and went through multi-agent code reviews with fix rounds (see `docs/HANDOVER.md`), but **they have not been run in After Effects** (the user decided against a live test). Rows marked ✅ (0.4) are in that state, waves 1-3 included. Earlier: 0.3.0 (2026-10-30) added skills, data-driven builds, social reframe, asset import, diagnostics, registration and macOS popup reading; 0.2 (2026-10-29) the P1 slice below.

This file answers two questions: what we have, and what to add next. For the things to add, it also says what to borrow from the community AE MCP servers we surveyed. Every source repo is **MIT**. Borrowed code keeps its notice in `ATTRIBUTION.md`, and each borrowed file says which file it came from.

**Status key:** ✅ has a typed tool · ✅ (0.4) built (0.4 and waves 1-3), not yet live-tested · 🟡 possible today through `ae_run_jsx` (ExtendScript can do it) · ❌ needs new code outside ExtendScript (in the server or panel's Node side), because ExtendScript cannot read pixels, run a background process without freezing AE, or decode audio. None of these needs Adobe's C++ SDK. · ⛔ out of scope: it leaves After Effects (the user's rule).
**Priority:** **P1** next release · **P2** soon · **P3** only when a job needs it

Design rule (from `SPEC.md`): add a typed tool only when it brings something `ae_run_jsx` cannot. Examples:
- **verification:** a read-back, a stale-value check, a pixel check;
- **safety:** a guard, a checkpoint, undo-stack hygiene;
- **a known AE trap:** the tool encodes the workaround;
- **large, bounded reads:** paging and truncation.

Everything else stays in `ae_run_jsx`.

## Sources surveyed

| Repo | Tools | What it is good for |
|---|---|---|
| **Engine-Room-Games/after-effects-mcp** | ~65 ops (`packages/jsx/*.jsx`) | The best-engineered reads (`get_layer_full`, `find_layers`), comp fingerprint/diff, keyframe easing, batch jobs, MOGRT export, audio cues. Has measured AE 26 fragile-areas docs. |
| **JUNKDOGE-JOE/after-effects-mcp** | 13 public tools | `.aep` checkpoint and revert, expression validation, frame preview and compare, failure recovery, a saved-tool library. |
| **kumoproductions/mcp-aftereffects** | ~30 operation modules behind `ae_do` | Broad typed coverage: text, shapes, masks, layout, Essential Graphics, fonts, project JSON export/import, effect catalogue. |
| **a-y-ibrahim/after-effects-mcp** | 55 tools | Production helpers: aerender, contact sheet, audio waveform and audio-driven animation, data-driven animation, template population, localisation, relink. |
| VolksRat71/after-effects-mcp-vision | 16 tools | Layout and template ideas. Thin. |
| Dakkshin/after-effects-mcp | 8 tools | Nothing worth borrowing. |

## 1. Bridge, safety and session

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Panel health, AE version, active comp, selection | ✅ `ae_status` | (done) | |
| Target guard (project path + comp id) | ✅ | (done) | |
| One undo step per write | ✅ | (done) | 0.4 tools go through one shared runner (`tools/ext/write-runner.ts`): guard, checkpoint, before read, write, separate after read, receipt. |
| Before/after receipts, read back separately | ✅ | (done) | |
| Quarantine for writes with unknown outcomes | ✅ | (done) | |
| `.aep` checkpoint and revert | ✅ `ae_checkpoint_*`, automatic before every write | (done) | JUNKDOGE `checkpoint-ops.js` was the model. |
| Comp fingerprint and diff | ✅ `ae_comp_fingerprint`, `ae_comp_diff` | (done) | Engine-Room `snapshot.jsx`. |
| Batch with one undo group, and chunked long jobs | ✅ (0.4) `ae_batch_set`: every layer and property found before anything is written; up to 500 ops per undo group, a pause between chunks; every value, key and expression read back; a failing op stops the batch and names itself. | (done) | Engine-Room `batch.jsx` was the model. |
| Failure recovery: retry a failed exec by recovery id, without resending | ❌ | P3 | JUNKDOGE `ae_execRecover`. Our quarantine covers the safety half already, and `ae_session_changes` lists writes a crash left unfinished. |
| Multiple AE instances (bind to a project path) | ❌ | P3 | JUNKDOGE `ae_instances` and `ae_workspace`. |
| Saved-snippet library (store a working JSX as a reusable tool) | ✅ `ae_skill_save`, `ae_skill_run`, `ae_skill_list`: SKILL.md plus numbered steps, per project (`ae-skills/` next to the .aep) or global. A working `ae_run_jsx` is kept by its `op_id`. | (done) | Atom's skills format; JUNKDOGE `ae_toolSave` was the earlier idea. |
| What the user changed since the agent's last write, writes a crash left unfinished, and which undo steps Ctrl+Z can no longer reach | ✅ (0.4) `ae_session_changes`: a snapshot after each guarded write, diffed against the live project; a short `user_changed` line on every write receipt; an interrupted write goes into quarantine. AE has no API for the undo stack, so it proves "unreachable" only (other project, restart, a revision that went back) and otherwise says "possibly reachable". | (done) | Our own. |
| One tool across many comps, with a job record | ✅ (0.4) `ae_multi_comp_apply`: one whitelisted guarded write tool over comp ids, a folder, nested comps or a name pattern; an ok/skipped/failed/unverified row per comp, a frozen job in `<project>.jobs.json`, `resume_job_id`, dry run. | (done) | Our own. |
| Project session: open, close, save policy, Auto-Save | ✅ (0.4) `ae_project_session`. A tool that closes or reopens a project tells the session tracker, so earlier undo steps are reported as gone. | (done) | |
| Memory and cache | ✅ (0.4) `ae_memory_status`, `ae_memory_purge`: memory in use, preferences by key, purge of image, snapshot, RAM or undo caches, or all (undo, ram and all need a saved, clean project and the user's yes). | (done) | |
| Panel-hosted MCP over HTTP, signed ZXP, copyable setup command, stable token | ✅ (0.2) | (done) | See `docs/V02-PANEL-MCP.md`. |

## 2. Reading the project

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Item tree (folders, comps, footage) | ✅ `ae_get_project` | (done) | |
| Comp settings and layer list | ✅ `ae_get_comp` | (done) | |
| Layer property tree | ✅ `ae_get_layer_props` | (done) | |
| Full layer dump in one call | ✅ `ae_get_layer_full` | (done) | Engine-Room `explore.jsx`. |
| Find layers across comps | ✅ `ae_find_layers` | (done) | Engine-Room `explore.jsx`. |
| Comp tree / precomp graph | ✅ (0.4) `ae_comp_tree`: every comp's users, contents, nesting depth and render-queue membership, top-level and unused comps; or one comp's tree down and where it is used, up. | (done) | Engine-Room `get_comp_tree`. |
| Effect catalogue | ✅ `ae_list_effects` | (done) | |
| Comp settings: read and write | ✅ (0.4) `ae_get_comp_settings`, `ae_comp_settings`: size, rate, duration, display start, motion blur, renderer, guides | (done) | |
| Check before render (missing footage, fonts and effects, expression errors, output paths) | ✅ (0.4) `ae_preflight`: blockers and warnings from a read-only pass | (done) | |
| What a comp does, in words | ✅ (0.4) `ae_describe_comp`: beats, moves, expression behaviour and a Gantt picture of layer timing; paged for big comps | (done) | Our own. |
| Why a layer does not show | ✅ (0.4) `ae_explain_layer` (findings from the DOM), `ae_explain_layer_proof` (renders a copy with and without the layer to confirm) | (done) | Our own. |
| 3D scene report | ✅ (0.4) `ae_scene_3d_report`: depth order, behind-camera, off-canvas layers | (done) | |
| Annotated frame | ✅ (0.4) `ae_annotate_frame`: a rendered frame with each layer's outline and tag | (done) | |
| Footage interpretation and proxies | ✅ (0.4) `ae_get_footage_interpretation`, `ae_set_footage_interpretation`, `ae_footage_proxy`: alpha, frame rate, pulldown, pixel aspect, proxy set and use | (done) | |
| Shape and mask paths | ✅ (0.4) `ae_path_read`, `ae_path_write`: vertices, tangents, feather, per key | (done) | |
| Project export to JSON | 🟡 | P3 | kumo `operations/project.ts`. |
| Fonts in use, and missing fonts | ✅ (0.4) `ae_fonts`: keyframed source text included; missing from AE 24+'s `fontObject.isSubstitute` and `app.fonts.missingOrSubstitutedFonts`, `missing_known: false` before that. | (done) | kumo `operations/font.ts`. |
| Paginated, filtered reads for very large projects | ✅ (0.4) `ae_get_project` (kind, name, missing footage, sort, offset/limit with total and next_offset) and `ae_get_comp` (layers past 500, name filter). Kinds are told apart by class: `typeName` is localised. | (done) | JUNKDOGE `ae_read`. |

## 3. Layers, properties and animation

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Set a value, keyframes or an expression, with read-back | ✅ `ae_set_property` | (done) | |
| Keyframe easing | ✅ `ae_set_keyframe_ease`: presets, speed and influence, or a CSS cubic-bezier `curve`. ✅ (0.4) `rove_between` roves the keys between the first and last given key (spatial properties only, refused before the undo group otherwise). | (done) | Engine-Room `keyframes.jsx`. |
| Remove keyframes, and read keyframes with easing | ✅ (0.4) `ae_get_keyframes` (ease named per side, tangents, roving, auto-bezier), `ae_remove_keyframes` (all, some or a range; with every key gone the value at `static_value_at` stays, default the current time as AE's stopwatch) | (done) | Engine-Room `remove_keyframe`, `get_keyframes`. |
| Expression validation | ✅ `ae_validate_expressions` | (done) | JUNKDOGE `validate_expressions.jsx`. |
| Create layers | ✅ (0.4) `ae_create_layer`: solid, null, adjustment, text (point or box), shape, camera, light, footage, precomp; name, length, start, 3D, parent, placement | (done) | Engine-Room `create_*_layer`. |
| Parent, reorder, duplicate, delete layers | ✅ (0.4) `ae_layer_ops`: parent, reorder, sort, duplicate, delete, trim, rename and switches; dry run; locked layers refused unless `unlock_locked`; warns about `layer(index)` expressions | (done) | Placement and parenting at creation are in `ae_create_layer`. |
| Precompose | ✅ (0.4) `ae_precompose`: AE's one-layer rule for leaving attributes is refused before AE is touched; the new comp is read back. | (done) | a-y-ibrahim `precompose-layers`. |
| Layout: align and distribute | ✅ (0.4) `ae_align`: to the comp, action or title safe, or the layers' box; distribute centres. 2D unparented layers; animated positions only with `shift_keys`. | (done) | kumo `operations/layout.ts`. |
| Track mattes (AE 23+ layer-based mattes) | ✅ (0.4) `ae_set_track_matte`: `setTrackMatte` on AE 23+, so any layer can be the matte; on older AE the layer directly above, refused otherwise. The matte's video goes off as in AE's UI. | (done) | JUNKDOGE `ae_setLayerTrackMatte`. |
| Stagger layers, or copy and offset keys | ✅ (0.4) `ae_stagger`, `ae_stagger_layout`: every key read back | (done) | |
| Time remap, speed ramps, freeze, loop | ✅ (0.4) `ae_get_time_remap`, `ae_time_remap` | (done) | |
| Expression controls and links | ✅ (0.4) `ae_rig_add_controls`, `ae_rig_link`, `ae_rig_unlink`, `ae_rig_rename`, `ae_rig_list`; recipes in `ae_expr_recipes`, `ae_expr_recipe` | (done) | |
| Camera rigs | ✅ (0.4) `ae_camera_rig`: one- or two-node camera with a controller null, focus and aperture | (done) | |
| Shape path operators and links | ✅ (0.4) `ae_path_operator` (trim, repeater, offset, ...), `ae_path_link`, `ae_path_connector` (a line between two layers) | (done) | |
| Learn from the user's edits | ✅ (0.4) `ae_taste_baseline`, `ae_learn_taste`, `ae_taste_rules`: what the user changed after the agent's work, as taste rules the user confirms | (done) | Builds on `ae_taste`. |
| Try versions side by side | ✅ (0.4) `ae_variants`, `ae_variants_pick`, `ae_variants_discard`: copies of a comp with different edits, frames to compare, one picked and the rest removed | (done) | |
| Markers (layer and comp), single and in bulk | ✅ (0.4) `ae_get_markers`, `ae_add_markers`, `ae_remove_markers` | (done) | Engine-Room `add_marker`; a-y-ibrahim `add-markers-bulk`. |

## 4. Effects, text, shapes and masks

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Add or remove an effect, set params by matchName, enable or disable | ✅ `ae_add_effect`, `ae_set_effect`, `ae_remove_effect`. Parameters of custom data (Colorama's Output Cycle, the Curves curve) can't be read or set by script ("CUSTOM_VALUE has not been implemented", AE 26.2.1): they are listed `settable: false`. Measured routes in, all inside AE: an expression linking to the same parameter of a hand-set effect (`linkable_by_expression`; the render matched pixel for pixel), a saved .ffx preset, or the effect's own preset menu (Colorama's Use Preset Palette is settable). | (done) | Engine-Room `add_effect`, `set_effect_param`, `set_effect_enabled`; kumo `effect.ts` |
| Apply an animation preset (.ffx) | ✅ `ae_apply_preset` (selects the target alone, then restores the selection; works without the comp being active), `ae_list_presets` (User Presets of every installed AE version, then AE's own) | (done) | a-y-ibrahim `apply-preset`, `search-presets` |
| Text: set the text and its style | ✅ `ae_set_text` | (done) | kumo `operations/text.ts`. |
| Captions | ✅ (0.4) `ae_captions_plan`, `ae_captions`, `ae_captions_read`: caption layers from a transcript, with word highlight and safe-area placement | (done) | |
| Measure and fit text, text backdrop | ✅ (0.4) `ae_measure_text`, `ae_fit_text`, `ae_text_backdrop`; `ae_set_text` also takes style ranges | (done) | |
| Text animators | ✅ (0.4) `ae_text_animator`: position, scale, rotation, opacity, fill colour, tracking, blur through a range selector; optional keyframed reveal | (done) | Engine-Room `add_text_animator`. |
| Shape layers: add contents, set paths, set shape properties | ✅ (0.4) `ae_shape`: rectangle, ellipse, star, polygon, free path, with fill and stroke; remove contents. Properties are set with `ae_set_property` on their path. | (done) | Engine-Room `shapes.jsx`; kumo `shape.ts`. |
| Masks: add, set path, feather, mode | ✅ (0.4) `ae_mask`: rectangle, ellipse or path; mode, inversion, feather, opacity, expansion | (done) | Engine-Room `add_mask`; kumo `mask.ts`. |

## 5. Footage and templates

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Import footage and image sequences | ✅ `ae_import_footage`, `ae_import_assets` | (done) | |
| Replace and relink footage | ✅ `ae_replace_footage` | (done) | |
| Collect files, reduce the project, relink | ✅ (0.4) `ae_collect_files` (a resumable copy with a sha1 manifest; the optional zip runs in the background), `ae_collect_relink`, `ae_collect_report` | (done) | |
| Purge unused footage and solids | ✅ (0.4) `ae_purge_unused`: a list by default; `apply` removes after checking each item is still unused; empty folders on request; comps never | (done) | Engine-Room `purge_unused_footage`. |
| **Template population**: fill text and footage placeholders from data (CSV or JSON), one comp per row | ✅ `ae_build_from_data`: text (style kept), numbers and lists (on the last key of an animated property by default, for charts), colours and footage per row; every cell checked before AE is touched; text that runs off the frame is flagged in the read-back. | (done) | a-y-ibrahim `populate-template`, `animate-from-data`, `localize-comp` |
| Essential Graphics properties (read and set) | ✅ (0.4) `ae_get_essential_graphics`, `ae_set_essential_graphics`: controllers, template name, add a property, rename, overrides on a precomp layer | (done) | kumo `operations/egp.ts`. |
| Export MOGRT | ✅ (0.4) `ae_export_mogrt`: from a saved, unchanged project; dialogs are never suppressed; the file is checked on disk | (done) | Engine-Room `mogrt.jsx` suppresses dialogs; we don't (Jay's rule). |

## 6. Vision and QC

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Frame snapshot, checked for freshness | ✅ `ae_snapshot_frame` | (done) | |
| Scaled snapshot that doesn't touch the comp (resize the PNG on the server, not in AE) | ✅ `ae_snapshot_frame` `scale` / `max_size` (pure-JS area resize; the full render stays as `full_path`) | (done) | |
| **Frame compare and sampling**: diff two frames, sample a time range, detect a blank or black frame | ✅ `ae_compare_frames`, `ae_contact_sheet` | (done) | JUNKDOGE `ae_previewFrame` (sample a range, compare two frames, pixel diff) |
| Single-layer snapshot (solo-free) | 🟡 (soloing touches the undo stack) | P3 | Engine-Room `screenshot_layer`. |
| Contact sheet of a comp (N frames tiled) | ✅ `ae_contact_sheet` (labelled tiles, checkerboard alpha, blank frames outlined in red) | (done) | a-y-ibrahim `contact-sheet`. Mirrors premiere-pro-mcp's `generate_media_contact_sheet`. |
| Motion graph of one property: value and speed over time, easing per keyframe pair, overshoot | ✅ `ae_motion_graph` (samples with `valueAtTime`, so expressions count) | (done) | Our own. |
| **Motion review of a whole comp**: what an animator would flag, with fixes | ✅ `ae_motion_review`. It covers linear moves, starts and stops at full speed, speed jolts at a key, overshoot (info), and keys between frames. Most findings carry a ready `ae_set_keyframe_ease` easy-ease call, so the agent can review, fix (with the user's OK) and review again. Expression-driven properties are sampled past their last key, so a settle isn't called a dead stop. ✅ (0.4): a linear run through middle keys of a spatial property gets a fix that roves them (`rove_between`); roving keys aren't called "between frames"; where animated layers come to rest, their box is checked against the frame (`cut_off`) and the safe areas (`outside_safe`), with a `suggested_shift`. | (done) | Our own. Next: roving middle keys (the easy-ease fix leaves a slight speed dip at them), frame and safe-area bounds. |
| Match to a reference frame | ❌ | P3 | a-y-ibrahim `match-reference`. |
| **Point tracking** | ✅ `ae_track_point`: NCC pattern matching with sub-pixel refinement on frames AE renders, adapting the pattern below 80% confidence like AE's tracker; stops when the point is lost; optional null with one key per frame. On a 75-frame eased curve: worst error 0.036 px, about 250 ms a frame (AE 26.2.1). AE's own Track Motion can't be driven from scripts, and no outside tool is used (the user's rule). | (done) | Our own. |
| **Green screen keying with a check** | ✅ `ae_key_greenscreen`: detects the screen colour, applies Keylight, Key Cleaner and Advanced Spill Suppressor (Ultra: Standard crushed a navy subject's blue, measured), then measures screen left, holes, spill and recoloured subject against frames rendered before the key, with ready `ae_set_effect` fixes. Roto Brush can't be scripted; rough masks for non-screen shots were ruled out by the user. | (done) | Our own. |
| Scrub check for footage (freezes, pops, flicker) | ✅ (0.4) `ae_scrub_check`: frame pairs rendered in AE and compared | (done) | |
| Text legibility and overlap | ✅ (0.4) `ae_check_text_overlap`, `ae_estimate_legibility`, `ae_check_legibility`: `ae_check_text_overlap` finds text boxes that overlap (from the DOM, no render); `ae_estimate_legibility` is a quick estimate from one render and the DOM fill colour; `ae_check_legibility` measures WCAG contrast against frames rendered with and without the text | (done) | |
| House style / brand checks | ✅ (0.4) `ae_house_style_check`: fonts against the brief's, missing fonts, small text, colours of text, shapes and solids within a delta E (CIE76, Lab) of a brand colour, text inside title safe | (done) | Engine-Room `get_house_style` was the model; the brand comes from `ae_brief`. |

## 7. Audio

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Audio levels and waveform analysis (beats, peaks) | ✅ (0.4) `ae_audio_analyze`: aerender renders the comp's audio ('AIFF 48kHz' by default) in the background; the server decodes it (WAV, AIFF, AIFC in plain JS) and finds the level, onsets (spectral flux), tempo (autocorrelation, prior at 120 BPM), beats (Ellis' dynamic programming) and the loudest hits | (done) | a-y-ibrahim `analyze-audio-waveform`; Engine-Room `audio.jsx`. |
| Place animation cues from audio | ✅ (0.4) `ae_add_markers` (beats as markers), `ae_cue_keys` (a pulse on a property at each cue; dry run) | (done) | Engine-Room `place_audio_cues`. |
| Set audio levels and fades | ✅ (0.4) `ae_loudness_apply` (gain and fades, keys read back) | (done) | a-y-ibrahim `set-audio-levels`. |
| Loudness measurement | ✅ (0.4) `ae_loudness_check`: integrated, short-term and momentary LUFS, loudness range and true peak, from an aerender audio render decoded in plain JS | (done) | Our own. |

## 8. Render and delivery

| Capability | Status | Priority | Notes |
|---|---|---|---|
| Add to the render queue, and read its status | ✅ | (done) | |
| List the render-settings and output-module templates | ✅ (0.4) `ae_render_templates`: from an existing queue item, or a temporary one that is removed | (done) | |
| Background render with `aerender` | ✅ `ae_aerender_start`, `_status`, `_cancel` | (done) | |
| Verify the output (duration, frame count, codec) | ✅ (0.4) `ae_verify_render`: imports the render back into AE and checks frames, frame rate, size and audio against the comp or the aerender job; the item is removed again. Not ffprobe: no outside tools. | (done) | |
| Inspect and edit render queue items, duplicate, apply a spec | ✅ (0.4) `ae_render_queue_inspect`, `ae_render_queue_edit`, `ae_render_queue_duplicate`, `ae_delivery_specs`, `ae_render_queue_apply_spec`, `ae_check_delivery_file` | (done) | The platform size limits in the spec library are approximate. |
| Batch render in the background, with resume | ✅ (0.4) `ae_render_batch_plan`, `ae_render_batch`, `ae_render_batch_status`, `ae_render_batch_resume`, `ae_render_batch_cancel` | (done) | |
| Delivery recipe: render, check, verify, collect in stages | ✅ (0.4) `ae_deliver_recipe`, `ae_deliver_step`, `ae_deliver_status` | (done) | |
| Submit to Deadline | ⛔ | – | Leaves After Effects. |

## 9. Workflow tools (Chroma-specific)

| Capability | Status | Notes |
|---|---|---|
| VO to markers | ✅ (0.4) `ae_add_markers` with a transcript: SRT, WebVTT, ElevenLabs JSON, Whisper JSON; per segment, sentence or word; a label colour per speaker | The transcription itself happens outside (VoxMark's ElevenLabs step); this places what the transcript says. |
| Shot versioning | ✅ (0.4) `ae_version_footage`: the last v<number> in the file name, or the folder name for sequences in versioned folders; swapped in one undo group and logged in `<project>.versions.json` | |
| Premiere round trip | ⛔ | Leaves After Effects. `ae_export_mogrt` covers the template side. |
| House style / brand checks | ✅ (0.4) see section 6 | |
| **Ask the user in the panel** (`ae_ask_user`): buttons, pictures per option, or ease curves with a moving preview and draggable handles | ✅ (done) | Choices are shown rather than described. The answer goes straight into a tool call (a curve into `ae_set_keyframe_ease`). Questions live in the service; the panel polls `/ask`. |
| **Brief and taste** (`ae_brief`, `ae_taste`) | ✅ (done) | The brief sits next to the .aep (`<name>.brief.json`) and returns questions for what is missing. Taste is per user, across projects; `ae_motion_review` uses the preferred ease's handle lengths in its fixes, can leave deliberate linear fades alone, and can treat overshoot as unwanted. |

## The P1 slice (v0.2): done

Every item shipped in 0.2: comp fingerprint/diff in receipts, `.aep` checkpoints, `ae_get_layer_full` and `ae_find_layers`, `ae_list_effects`, `ae_validate_expressions`, keyframe easing, text set and style, footage import and replace, `ae_compare_frames`, `aerender`, and the panel-hosted MCP with a signed ZXP.

## From the Atom review (2026-10-27, `docs/ATOM-REVIEW.md`)

| Idea | Why | Effort | Priority |
|---|---|---|---|
| **Automatic checkpoints around writes.** Copy the .aep before (and optionally after) every mutating tool call, with a setting to turn it off for big projects. Branch, never overwrite, on revert. | Atom does this per change. We have only manual `ae_checkpoint_*`. With it, every write can be undone across sessions. | S | ✅ Done. The copy is the last save, because AE has no way to write its unsaved state to another file without retargeting the project (measured on AE 26.2.1; the undocumented `app.project.serializeToXML` takes an unknown enum). Writes between two saves share one copy. `ae_auto_checkpoint` sets it. |
| **AE skills bundle:** `SKILL.md` plus `1.jsx`, `2.jsx`, scoped to the project (`<project>/…/skills/`) or global. Add an `ae_skill_run` tool, and an `ae_skill_save` tool that captures a working `ae_run_jsx`. | This is the format Atom proved, and it matches Claude Code's own skills. It replaces our P3 "saved-snippet library". Good for house rigs, lower thirds and kinetic type. | M | ✅ Done. Each step sees `args`, `prev` and `results`; a run is one evalScript, so one undo group. Steps are linted for ES3 on save and before a run. |
| **One-click registration:** the panel runs `claude mcp add …` itself (the Claude Code CLI), with toggles for Codex and Cursor. | Removes the copy and paste step from installs. | S | ✅ Done (`panel/tools/register.cjs`). Claude Desktop, Cursor and Codex get the stdio relay, so their configs never hold the token; Claude Code is registered again after a token change. |
| **Asset staging plus auto-import.** Generated assets (Flora, Higgsfield, ElevenLabs, renders) land in a known folder and are imported into an `_Assets` bin. | Atom auto-imports generated images. We already generate elsewhere, so the value is in the import pipeline. | S | ✅ Done: `ae_import_assets` (`_assets/` next to the .aep, mirrored into `_Assets`, sequences detected) and an opt-in watcher whose polling stays out of the log. |
| **Social reframe:** duplicate a comp to 16:9, 1:1 and 9:16, re-anchor controllers, apply safe areas. | A common Atom workflow, and real time saved on social cut-downs. | M | ✅ Done: `ae_reframe`. Backgrounds cover; other top-level layers and controller nulls pin to the nearest edge or centre of the safe area and shrink to fit; 9:16 margins leave room for platform UI. |
| **Data-driven builds from CSV/JSON** (charts, localisation). | Strengthens the planned template population. | S (recipes) | ✅ Done: `ae_build_from_data`. |
| **Diagnostics bundle:** logs, quarantine state, AE version and popups in one file. | Faster triage when automation is blocked. | S | ✅ Done: `ae_diagnostics` and the panel's Save diagnostics button. It waits 5 s for AE and never aborts the eval. |
| **Access tiers** like Atom's Adobe Only / Project Folder / Full Access. | Probably **not needed**: our MCP exposes no shell or file tools, and Claude Code has its own permissions. Note it, don't build it. | – | – |

**Not copying:**
- an in-panel chat (Claude Code is the client);
- API keys pasted into the panel (keys stay in 1Password and env vars);
- turning off revert confirmations.
