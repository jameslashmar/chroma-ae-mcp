# Feature list and gap analysis

Last updated: 2026-10-27, after the v0.1 live smoke test.

This file answers two questions: what we have, and what to add next. For the things to add, it also says what to borrow from the community AE MCP servers we surveyed. Every source repo is **MIT**. Borrowed code keeps its notice in `ATTRIBUTION.md`, and each borrowed file says which file it came from.

**Status key:** ✅ has a typed tool · 🟡 possible today through `ae_run_jsx` (ExtendScript can do it) · ❌ needs new code outside ExtendScript (in the server or panel's Node side), because ExtendScript cannot read pixels, run a background process without freezing AE, or decode audio. None of these needs Adobe's C++ SDK.
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

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Panel health, AE version, active comp, selection | ✅ `ae_status` | (done) | |
| Target guard (project path + comp id) | ✅ | (done) | |
| One undo step per write | ✅ | (done) | |
| Before/after receipts, read back separately | ✅ | (done) | |
| Quarantine for writes with unknown outcomes | ✅ | (done) | |
| **`.aep` checkpoint and revert**: copy the saved project before a risky batch, list checkpoints, reopen one | 🟡 (`File.copy` + `app.open` work in JSX; the value is in doing it safely and consistently) | **P1** | JUNKDOGE `plugin/host/mcp/checkpoint-ops.js`, `checkpoint-store.js` (copies with `copyFileSync`). We already copy before `ae_save`, so this generalises that. |
| **Comp fingerprint and diff**: a hash of every layer, property and keyframe, so a receipt can say *exactly* what changed | 🟡 our receipt covers transform only | **P1** | Engine-Room `packages/jsx/snapshot.jsx` (`_comp_fingerprint`, `_comp_diff`; a pure diff that can be tested without AE) |
| **Batch with one undo group, and chunked long jobs** (≤500 ops in one group; larger jobs yield in chunks so AE's UI doesn't freeze) | 🟡 | **P2** | Engine-Room `packages/jsx/batch.jsx` (`run_batch`, `_continue_job`, `_get_job`) |
| Failure recovery: retry a failed exec by recovery id, without resending | ❌ | P3 | JUNKDOGE `ae_execRecover`. Our quarantine covers the safety half already. |
| Multiple AE instances (bind to a project path) | ❌ | P3 | JUNKDOGE `ae_instances` and `ae_workspace` (`docs/MULTI_INSTANCE_EXECUTION_PLAN.md`) |
| Saved-snippet library (store a working JSX as a reusable tool) | ❌ | P3 | JUNKDOGE `ae_toolSave`, `ae_toolUse`, `ae_toolSearch`. A Claude skill holding recipes may do the job more simply. |
| Panel-hosted MCP over HTTP, signed ZXP, copyable setup command, stable token | ❌ | **P1** (packaging) | Engine-Room and JUNKDOGE both host MCP in the panel. Signing reuses VoxMark's `sign.ps1`. See the install discussion in the vault. |

## 2. Reading the project

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Item tree (folders, comps, footage) | ✅ `ae_get_project` | (done) | |
| Comp settings and layer list | ✅ `ae_get_comp` | (done) | |
| Layer property tree | ✅ `ae_get_layer_props` | (done) | |
| **Full layer dump in one call**: transform, effects with every param, masks, text document, shape contents, expressions, keyframes with easing, bounded by section | 🟡 partial | **P1** | Engine-Room `packages/jsx/explore.jsx` `get_layer_full`, which its authors call "the whole reason this MCP exists". It has `include` sections plus `maxKeyframes` and `shapeDepth` bounds. |
| **Find layers across comps** (by name, type, effect, expression, or source) | 🟡 | **P1** | Engine-Room `explore.jsx` `find_layers` |
| Comp tree / precomp graph (which comps nest which, and where a comp is used) | 🟡 | P2 | Engine-Room `get_comp_tree` |
| **Effect catalogue**: the installed effects with matchNames, so the agent stops guessing names | 🟡 | **P1** | Engine-Room `list_available_effects`; kumo `operations/effect.ts` (`project.list_effects`) |
| Project export to JSON (a structural snapshot for diffing between sessions) | 🟡 | P3 | kumo `operations/project.ts` (`ae_project_export_json`) |
| Fonts in use, and missing fonts | 🟡 | P2 | kumo `operations/font.ts` |
| Paginated, filtered reads for very large projects | 🟡 | P2 | JUNKDOGE `ae_read` (paginate, sort, filter) |

## 3. Layers, properties and animation

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Set a value, keyframes or an expression, with read-back | ✅ `ae_set_property` | (done) | |
| **Keyframe easing**: temporal ease (speed and influence), spatial tangents, interpolation per key, roving | 🟡 the trap-prone part | **P1** | Engine-Room `keyframes.jsx` (`set_temporal_ease`, `set_spatial_tangents`, `set_interpolation`); kumo `operations/keyframe.ts` |
| Remove keyframes (a range or all), and read keyframes with easing | 🟡 | P2 | Engine-Room `remove_keyframe`, `get_keyframes` |
| **Expression validation**: force-evaluate and report expression errors per property | 🟡 (JSX can force-evaluate each property and read `expressionError`; nothing does it for a whole comp yet) | **P1** | JUNKDOGE `plugin/jsx/templates/validate_expressions.jsx` (`ae_validateExpressions`) |
| Create layers (solid, null, adjustment, text, shape, camera, light, precomp, footage) | 🟡 | P2 | One `ae_create_layer` covering every type, modelled on Engine-Room's `create_*_layer` ops |
| Parent, reorder, duplicate, delete layers | 🟡 | P3 | Engine-Room `parent_layer`, `reorder_layer`, `duplicate_layer`. Simple in JSX. |
| Precompose, with the right "move attributes" behaviour | 🟡 | P2 | a-y-ibrahim `precompose-layers`, Engine-Room `create_precomp_layer` |
| Layout: align and distribute | 🟡 | P3 | kumo `operations/layout.ts`; a-y-ibrahim `center-layers` |
| Track mattes (AE 23+ layer-based mattes) | 🟡 | P2 | JUNKDOGE `ae_setLayerTrackMatte` and `ae_clearLayerTrackMatte`. The API changed in AE 23, which is a trap. |
| Markers (layer and comp), single and in bulk | 🟡 | P2 | Engine-Room `add_marker`, `remove_marker`; a-y-ibrahim `add-markers-bulk`. Overlaps VoxMark. |

## 4. Effects, text, shapes and masks

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Add or remove an effect, set params by matchName, enable or disable | 🟡 | P2 | Engine-Room `add_effect`, `set_effect_param`, `set_effect_enabled`; kumo `effect.ts` |
| Apply an animation preset (.ffx) | 🟡 | P3 | a-y-ibrahim `apply-preset`, `search-presets` |
| **Text**: set the text, its style (font, size, tracking, leading, fill, stroke), paragraph and box text. TextDocument round-trip traps. | 🟡 | **P1** | kumo `operations/text.ts` (1,099 lines, the most complete); Engine-Room `text.jsx` plus the TextDocument notes in `fragile-areas-ae.md` |
| Text animators | 🟡 | P3 | Engine-Room `add_text_animator` |
| Shape layers: add contents, set paths, set shape properties | 🟡 | P2 | Engine-Room `shapes.jsx`; kumo `operations/shape.ts`, `shape-contents.ts` |
| Masks: add, set path, feather, mode | 🟡 | P3 | Engine-Room `add_mask`, `set_mask`; kumo `operations/mask.ts` |

## 5. Footage and templates

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| **Import footage and image sequences**, into a target folder | 🟡 | **P1** | Engine-Room `footage.jsx` (`import_footage`; includes an SVG viewBox check). Gulp's sequence detection is ours already. |
| **Replace and relink footage** (versioning: a stable name with the latest render behind it) | 🟡 | **P1** | a-y-ibrahim `relink-footage`. Matches the "stable filename per shot" pipeline idea from the Premiere notes. |
| Purge unused footage and solids | 🟡 | P3 | Engine-Room `purge_unused_footage` |
| **Template population**: fill text and footage placeholders from data (CSV or JSON), one comp per row | 🟡 | **P2** | a-y-ibrahim `populate-template`, `animate-from-data`, `localize-comp` |
| Essential Graphics properties (read and set) | 🟡 | P2 | kumo `operations/egp.ts` |
| Export MOGRT | 🟡 (`exportAsMotionGraphicsTemplate`) | P3 | Engine-Room `mogrt.jsx` (checks preconditions, saves, suppresses dialogs, exports outside the undo group). Pairs with premiere-pro-mcp's MOGRT handoff. |

## 6. Vision and QC

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Frame snapshot, checked for freshness | ✅ `ae_snapshot_frame` | (done) | |
| Scaled snapshot that doesn't touch the comp (resize the PNG on the server, not in AE) | ✅ `ae_snapshot_frame` `scale` / `max_size` (pure-JS area resize; the full render stays as `full_path`) | (done) | |
| **Frame compare and sampling**: diff two frames, sample a time range, detect a blank or black frame | ✅ `ae_compare_frames`, `ae_contact_sheet` | (done) | JUNKDOGE `ae_previewFrame` (sample a range, compare two frames, pixel diff) |
| Single-layer snapshot (solo-free) | 🟡 (JSX, but soloing touches the undo stack; needs care) | P3 | Engine-Room `vision.jsx` `screenshot_layer` |
| Contact sheet of a comp (N frames tiled) | ✅ `ae_contact_sheet` (labelled tiles, checkerboard alpha, blank frames outlined in red) | (done) | a-y-ibrahim `contact-sheet`. Mirrors premiere-pro-mcp's `generate_media_contact_sheet`. |
| Motion graph of one property: value and speed over time, easing per keyframe pair, overshoot | ✅ `ae_motion_graph` (samples with `valueAtTime`, so expressions count) | (done) | Our own. |
| Match to a reference frame | ❌ | P3 | a-y-ibrahim `match-reference` |

## 7. Audio

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Audio levels and waveform analysis (beats, peaks) | ❌ | P2 | a-y-ibrahim `analyze-audio-waveform`, `src/lib/audio-reactive.ts`; Engine-Room `audio.jsx` |
| Place animation cues from audio (markers or keys on beats) | ❌ | P2 | Engine-Room `place_audio_cues` (it has a dry run that leaves no undo step); a-y-ibrahim `animate-to-audio` |
| Set audio levels and fades | 🟡 | P3 | a-y-ibrahim `set-audio-levels` |

## 8. Render and delivery

| Capability | Status | Priority | Borrow from |
|---|---|---|---|
| Add to the render queue, and read its status | ✅ | (done) | |
| List the render-settings and output-module templates | 🟡 | P2 | premiere-pro-mcp's `inspect_after_effects_render_templates` already does this, so match its shape. |
| **Background render with `aerender`** (doesn't block AE's UI; progress, log, exit code) | ❌ | **P1** | a-y-ibrahim `render-aerender`; kumo `operations/render.ts`. The Deadline farm is the bigger option later. |
| Verify the output (duration, frame count, codec) with ffprobe | ❌ | P2 | Use the global ffprobe, the way the Archiver's `convert/verify.rs` does |
| Submit to Deadline | ❌ | P3 | Our own Deadline setup (vault: *Deadline render farm server*) |

## 9. Workflow tools (Chroma-specific, nobody has these)

| Capability | Priority | Notes |
|---|---|---|
| VO to markers (VoxMark's engine as a tool) | P2 | Reuse AFX VoxMark's transcript-to-marker logic. It avoids rebuilding what we already ship. |
| Shot versioning: swap a shot's footage for the latest version and log the change | P2 | Builds on replace/relink, plus the Premiere naming convention. |
| Premiere round trip: send a comp to Premiere, bring renders back | P3 | `premiere-pro-mcp` already has the AE handoff tools; pair with them. |
| House style / brand checks (fonts, colours, safe areas) | P3 | Engine-Room `get_house_style` and `set_house_style` is the model. Chroma brand tokens come from the `chroma-brand-guidelines` skill. |

## Proposed P1 slice (v0.2)

These are ordered so each step makes the next one safer.

1. **Comp fingerprint/diff in every receipt.** Borrow Engine-Room `snapshot.jsx`. Receipts then show every change, not just transforms.
2. **`.aep` checkpoint and revert.** Borrow JUNKDOGE `checkpoint-ops.js`. This is the safety net before batches.
3. **`ae_get_layer_full` and `ae_find_layers`.** Borrow Engine-Room `explore.jsx`. Fewer, richer reads.
4. **`ae_list_effects`** (catalogue with matchNames). Borrow Engine-Room and kumo.
5. **`ae_validate_expressions`.** Borrow JUNKDOGE `validate_expressions.jsx`.
6. **Keyframe easing tools.** Borrow Engine-Room `keyframes.jsx`.
7. **Text set/style with TextDocument handling.** Borrow kumo `text.ts` and Engine-Room's notes.
8. **Footage import and replace/relink.**
9. **`ae_compare_frames`** (sample a range, pixel diff). Borrow JUNKDOGE `ae_previewFrame`.
10. **`aerender` background render.** Borrow a-y-ibrahim and kumo `render.ts`.
11. **Packaging:** panel-hosted HTTP MCP, signed ZXP, Copy setup command.

Each item ships with a live AE check, added to the smoke test. v0.1 found two AE behaviours the docs don't mention: `saveFrameToPng` writes asynchronously, and changing `resolutionFactor` adds undo steps.

## From the Atom review (2026-10-27, `docs/ATOM-REVIEW.md`)

| Idea | Why | Effort | Priority |
|---|---|---|---|
| **Automatic checkpoints around writes.** Copy the .aep before (and optionally after) every mutating tool call, with a setting to turn it off for big projects. Branch, never overwrite, on revert. | Atom does this per change. We have only manual `ae_checkpoint_*`. With it, every write can be undone across sessions. | S | P1 |
| **AE skills bundle:** `SKILL.md` plus `1.jsx`, `2.jsx`, scoped to the project (`<project>/…/skills/`) or global. Add an `ae_skill_run` tool, and an `ae_skill_save` tool that captures a working `ae_run_jsx`. | This is the format Atom proved, and it matches Claude Code's own skills. It replaces our P3 "saved-snippet library". Good for house rigs, lower thirds and kinetic type. | M | P2 |
| **One-click registration:** the panel runs `claude mcp add …` itself (the Claude Code CLI), with toggles for Codex and Cursor. | Removes the copy and paste step from installs. | S | P2 |
| **Asset staging plus auto-import.** Generated assets (Flora, Higgsfield, ElevenLabs, renders) land in a known folder and are imported into an `_Assets` bin. | Atom auto-imports generated images. We already generate elsewhere, so the value is in the import pipeline. | S | P2 |
| **Social reframe:** duplicate a comp to 16:9, 1:1 and 9:16, re-anchor controllers, apply safe areas. | A common Atom workflow, and real time saved on social cut-downs. | M | P2 |
| **Data-driven builds from CSV/JSON** (charts, localisation). | Strengthens the planned template population. | S (recipes) | P2 |
| **Diagnostics bundle:** logs, quarantine state, AE version and popups in one file. | Faster triage when automation is blocked. | S | P3 |
| **Access tiers** like Atom's Adobe Only / Project Folder / Full Access. | Probably **not needed**: our MCP exposes no shell or file tools, and Claude Code has its own permissions. Note it, don't build it. | – | – |

**Not copying:**
- an in-panel chat (Claude Code is the client);
- API keys pasted into the panel (keys stay in 1Password and env vars);
- turning off revert confirmations.
