# Live checklist for a supervised session

Everything below is built and unit-tested against fakes. **None of it has run in real After Effects.** Work through it in order, with the user present, on a throwaway project (never a client project). Tick an item only after you saw it happen; write what you saw next to anything that disagrees with the code or the docs.

## A. Render in AE

- [ ] The panel bundle is built (`npm run bundle`) and the dev panel loads it.
- [ ] A throwaway saved project and a render of a few seconds.
- [ ] `ae_render_queue_render` end to end: job id at once, status, output files, `ae_verify_render`.
- [ ] The Stop button during a render: what the job reads afterwards, whether the gate lifts.
- [ ] An hours-long eval (a render that runs long): the gate stays shut, nothing is resent, nothing times out wrongly.
- [ ] The overwrite prompt when the output file exists.
- [ ] `render()` on an unsaved project.
- [ ] `ae_ask_user` during a render.
- [ ] `sequence_check: warn` shows its warning and the render still runs; `block` leaves the queue unchanged.

## B. Core toolset

- [ ] The panel's Claude Desktop button (never clicked in a real panel), then Desktop restarted.
- [ ] How many tools Desktop shows (expect 36: 33 core tools and the 3 meta-tools).
- [ ] Whether Desktop lets a model call a tool name that is not listed.
- [ ] `ae_search_tools`, `ae_get_tool_schema` and `ae_invoke_tool` from Desktop.
- [ ] Whether a real host honours `additionalProperties: false`.

## C. Dialogs

- [ ] A tall single-OK warning shows one OK with `default: true`; `ae_dialog_respond` closes it with method `post_enter` and AE does not take focus (this decides whether SendKeys is ever built).
- [ ] Real `ae_dialogs` output: the `ocr_lines` JSON shape, one-word lines stay arrays, `win_rect`, `analysis_png` reaching TypeScript, and the 3x OCR boxes line up with the PNG.
- [ ] `win_rect` matches `GetWindowRect` in respond (a false `dialog_changed` means the compare needs loosening).
- [ ] A second list writes `dialog_<handle>.png` while another reads it.
- [ ] The `-Key` path on a real dialog: AfterFX process check, `IsWindowEnabled`, unusual titles, `-ExpectRect`.
- [ ] Stacked dialogs: the list order really is topmost first.
- [ ] OK + Cancel font dialog: OK is pressed only when the ring is on OK.
- [ ] Save / Don't Save / Cancel: Don't Save gives `button_not_default`.
- [ ] Yes / No / Cancel: No is refused.
- [ ] "Replace existing file?" OK / Cancel: OK needs both flags.
- [ ] The ring colour in light and medium UI brightness.
- [ ] A dialog with real (UI Automation) buttons under another dialog is refused as `dialog_not_topmost`; one whose window is disabled gives `dialog_not_enabled` (the PowerShell check has no unit test).
- [ ] The disabled-button case (a progress dialog's Cancel).
- [ ] OK or Yes on a real-button (UI Automation) dialog saying "will be lost" or "replace" is refused without both flags; the same on macOS.
- [ ] A lone ringed OK saying "removed from the queue" is answered; a ringed OK with a second, unread button is gated as destructive text.
- [ ] Cancel works while a percentage moves.
- [ ] `dialogs/` no longer grows by one PNG per call.

## D. AE busy

- [ ] Open a modal popup during one of our long tools, then `ae_status` and another tool answer in about 1 s (the popup read once costs up to 4 s).
- [ ] A call arriving before the tool is 15 s old is refused within about 5 s.
- [ ] The first refusal's popup read time.
- [ ] A manual render: does `evalScript` block at all, and how late is the answer (the biggest unknown).
- [ ] A legitimate 20+ s read, then another tool: it waits and is not refused.
- [ ] An eval of ours without a lease (asset watcher status, an `ae_import_assets` footage read) stuck behind a popup: the next call is refused at once, not after the eval timeout, and a write is not quarantined; the same eval during a long operation with no popup is waited for.
- [ ] `ae_status` returns within 10 s with the popup read, the detail eval and the GPU probe all slow (time it).
- [ ] A guarded write after a slow session snapshot goes ahead.
- [ ] After a popup is answered the next call works with no restart and no quarantine.
- [ ] Kill a capture eval midway and confirm the temp comp is removed.

## E. Startup

- [ ] Whether signed installs contain `META-INF/signatures.xml`.
- [ ] Which CSXS version each AE reads for `PlayerDebugMode`.
- [ ] What `getSystemPath("hostApplication")` returns.
- [ ] How an aerender engine looks in the process list.
- [ ] Two AEs: the log names the owner, and the loser's panel says "Other AE has the connection".
- [ ] AE 2024 is reported as unsupported.
- [ ] A stale-token 401 gives `token_rejected`.
- [ ] `service.js` and `common.js` run under CEP's Node 17.7.2.

## F. Frames

- [ ] `FootageItem.file` for a sequence whose first frame is not 0001.
- [ ] Whether `duration x frameRate` equals AE's frame count (decides `short`, `sparse`, `ae_range_differs`, and lone-frame `unknown`).
- [ ] The real "missing frames" popup text against `missing_ranges`.
- [ ] Transient gaps from multi-frame EXR renders, and the 30 s settle for outside renderers.
- [ ] 5k and 100k folders on Dropbox and on a NAS: wall time, responsiveness, and the budget holds with a hung share.
- [ ] A sequence whose interior frames arrive late (a gap re-render, a split farm) while the last 8 are old reads as still arriving in the watcher and in `ae_import_assets`.
- [ ] 20k single files in a watched folder: scan time on the 5 s tick stays small; above 5,000 the rest is reported as not checked.
- [ ] A Smart Sync stat does not download the file.
- [ ] Clock skew on SMB shares, calibrating the 5 s allowance.
- [ ] A dead share: two sequence checks in a row end at the budget, the third returns at once with the inputs unchecked, and file reads elsewhere stay responsive; the gate opens again when the share answers.
- [ ] A footage listing page on a very large project stays within its own timeout, far under 120 s.
- [ ] `ae_scrub_check` / `ae_verify_render` after a capture or read timeout: the imported item and temp comp are removed once AE answers.

## G. GPU

- [ ] Task Manager matches `used_pct`.
- [ ] Which counter instance is which adapter.
- [ ] The real process names of Cinema 4D, Commandline, Redshift, Houdini and Resolve.
- [ ] Whether the per-process overshoot is constant.
- [ ] The probe cost during a render.
- [ ] A warning in a real `ae_aerender_start` with Cinema 4D open.
- [ ] Non-English Windows: apps still list (and the render tools name them), the GPU is unreadable, and `ae_memory_status` says so.
- [ ] With no GPU counters (non-English Windows, macOS) a render tool still names a running Cinema 4D or similar, without a figure.
- [ ] The 85 % and 93 % thresholds.

## H. Import

- [ ] One Ctrl+Z removes a whole import and interpret of 3 or more items.
- [ ] `sequence: true` with `forceAlphabetical = false` on an EXR folder with a gap gives a placeholder and the right frame count.
- [ ] `conformFrameRate` right after import changes the duration, and the separate read-back agrees.
- [ ] Alpha ignore, premultiplied with a colour, and guess.
- [ ] Skip reasons for a PNG sequence without alpha and for a still given a frame rate.
- [ ] A damaged frame: does AE throw or open a dialog.
- [ ] 100+ items on a network or Dropbox folder: `max_seconds` stops before the bridge timeout.
- [ ] `target_folder_id` into an existing bin with subfolder mirroring.
- [ ] The watcher still imports a new file in `_assets/`.
- [ ] `app.project.itemByID` returns the live item after `importFile` and a move.
- [ ] A 5000-frame EXR folder scans in reasonable time.

## I. Layout

- [ ] FIRST: `copyToComp` on a CameraLayer, including a Cinema 4D camera. Check zoom, position, point of interest, keyframes, expressions, orientation, rotation, name, where it lands, and that exactly one new layer appears.
- [ ] A camera's point of interest is the Anchor Point stream, and `autoOrient` gives a two-node camera.
- [ ] Mask vertices via `valueAtTime(t, false)` on keyed masks.
- [ ] The box matches the viewer for a rotated and scaled layer.
- [ ] `PlaceholderSource` on a real missing-footage layer.
- [ ] A 100-layer template read: time, and the undo list stays empty.
- [ ] One Ctrl+Z reverts the whole layout.
- [ ] Rollback after a forced failure leaves no stray comps and leaves the project as found.
- [ ] `Mask.remove()` and re-adding keep the layer valid; INTERSECT hides everything outside the region.
- [ ] Fill plus a clip mask has no spill; contain leaves the bars.
- [ ] Feed comps nested at about 100% are pixel-aligned.
- [ ] `moveBefore` / `moveAfter` with a guide layer in between.
- [ ] `setValue([x, y])` on Anchor, Position and Scale of a 2D layer leaves z as expected.
- [ ] A separated Position reads through `ADBE Position`, and `ADBE Position_0` / `_1` exist.
- [ ] A parent's children move when the parent is filled.
- [ ] `comp.layer(i).parent.id` works.
- [ ] A 4K master with 20 or more feeds: write time.
