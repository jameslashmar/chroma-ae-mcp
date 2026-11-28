# Safety model

How the MCP keeps a live After Effects session safe while a person is editing in it. The short version is in the [README](../README.md#safety).

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
  - A read that has to render only the plate (`isolate_layers` on `ae_track_multi` and `ae_screen_corners`, `isolate` on `ae_cleanplate_pick`, or `hide_layers` on `ae_region_stats`, which switches the listed layers off instead) makes a temporary comp and removes it again in the same call. That is a write, so it needs `expect`, takes a checkpoint and obeys the quarantine. `ae_patch_check` always does it.
  - `ae_view` only changes what the user sees (selection, playhead, viewer options). It makes no undo step and no checkpoint, and hands back a `previous_state` to restore.
- **Not everything can be undone.** `ae_fonts` replace is not undoable with Ctrl+Z, so it refuses without a checkpoint and says so in the result. `ae_render_templates` with `action: "save"` stores a machine-wide preference that neither Ctrl+Z nor a checkpoint reverts. `ae_project_settings` takes a checkpoint first when auto checkpoints are on (the result's `checkpoint` is null if it was skipped: auto checkpoints off, an unsaved project, or a file over the size limit), because some settings may not undo.
- **Popups are never suppressed** (Jay's rule).
  - `ae_dialogs` reads AE's modal popups (title, text, buttons, screenshot) from outside AE's scripting thread, with OCR for the dialogs AE paints itself.
  - A timeout names any popup that is blocking AE.
  - `ae_dialog_respond` answers only popups our own operation caused, and refuses Save, Don't Save, Replace, Delete or Discard without an explicit instruction from the user. Every answer is logged.
  - The panel service watches for popups as they appear (`server/src/popups.ts`).
    - A popup our own operation raised with one OK-like button is pressed at once, so the operation goes on. There is nothing to decide.
    - Every other popup is asked about: in the panel ("After Effects asks", with its screenshot and its buttons as the options), and in the client too when it takes questions. The user's pick is pressed through `ae_dialog_respond`'s checks, quoting the pick as the user's instruction.
    - On a popup AE painted itself, every button whose label was read on its pill is offered: Cancel goes as Escape, the default OK as Enter, any other (Don't Save, Resolve Fonts, Skip...) as a click posted to the popup's own window at its label. AE is not focused and the mouse pointer does not move. A button whose place could not be read is named, not offered: the user clicks it in AE. Destructive buttons still need the user's explicit instruction.
    - Progress windows (only Cancel / Stop, or no button while our operation runs) are left alone.
    - Whatever happened is reported once on the agent's next tool result (`popups`): what the popup said, what was pressed and by whom, or that it closed in AE. The agent tells the user. For a missing font it offers `ae_fonts check_files`; for missing files, `ae_collect_relink`.
- **Locked-down bridge.** It binds to localhost only. Every request needs the Bearer token, stored in a folder only the current user can read. Any request with an `Origin` header (from a browser) is rejected, and the `Host` header is checked strictly.
