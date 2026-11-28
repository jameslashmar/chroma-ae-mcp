---
name: ae-live-session
description: "How to work in After Effects through the chroma-ae MCP while a person is editing the same project live: inspect before writing, target guards (expect), checkpoints and undo, write outcomes (applied, no_op, not_applied, unknown) and the quarantine, idempotency keys, the single-writer queue and busy or Stop refusals, popups and the dialog rules (ae_dialogs, ae_dialog_respond), asking the user (ae_plan, ae_ask_user), long renders (render queue, aerender, render lock, the AE 26.3 render hang), and saving. Load at the start of any session that changes an open After Effects project, after a timeout, busy, queued, guard or Stop refusal, when a popup appears, before starting a render or saving, or when the user says they are working in After Effects at the same time."
metadata:
  version: "1.0.0"
---

# Working in After Effects beside a person

The user is probably editing the same project while you work. They can move a layer, open a dialog
or press Stop at any moment. The server is built for that: every write is guarded, checkpointed and
read back. Your job is to keep its assumptions true: look first, change one thing at a time, say
what you did, and stop when the state is not what you thought.

## Which tools are close at hand

Core tools (always in the list) include `ae_plan`, `ae_status`, `ae_get_project`, `ae_get_comp`,
`ae_comp_tree`, `ae_get_layer_props`, `ae_find_layers`, `ae_get_keyframes`, `ae_set_property`,
`ae_batch_set`, `ae_set_text`, `ae_create_layer`, `ae_create_comp`, `ae_layer_ops`,
`ae_import_footage`, `ae_add_effect`, `ae_set_effect`, `ae_save`, `ae_snapshot_frame`, `ae_run_jsx`,
`ae_dialogs`, `ae_dialog_respond`, `ae_skill_run`, `ae_render_queue_add`, `ae_render_queue_edit`,
`ae_render_queue_status`, `ae_render_queue_render`, `ae_render_queue_render_status`,
`ae_aerender_start`, `ae_aerender_status`, and the three meta-tools.

Not in the core list, so reach them with `ae_search_tools { query }` or `{ pattern: "^ae_checkpoint" }`,
then `ae_invoke_tool { name, arguments }` (full schema from `ae_get_tool_schema { name }`):
`ae_session_changes`, `ae_checkpoint_create`, `ae_checkpoint_list`, `ae_checkpoint_revert`,
`ae_auto_checkpoint`, `ae_comp_fingerprint`, `ae_comp_diff`, `ae_recent_ops`, `ae_quarantine_status`,
`ae_acknowledge`, `ae_ask_user`, `ae_project_session`, `ae_verify_render`. Clients on the full toolset
(HTTP header `X-Chroma-Toolset: full`, or `CHROMA_AE_MCP_TOOLSET=full` for the relay) see all of them
listed; some appear there as one tool with an `action` field (`ae_checkpoint { action: "create" |
"list" | "revert" }`). The old names still work.

`ae_search_tools` and `ae_get_tool_schema` never touch After Effects, so they answer while it is busy.

## 1. Inspect before you write

1. Start a new task with `ae_plan { request, intent?, comp_id?, layers?, answers? }`. It reads the open
   project once and returns what it took the request to mean, questions whose answers change the work,
   a plan with a tool per step and hazards. Whether you ask the questions or use its stated defaults
   follows the user's "Ask first" button in the panel; the result says which.
2. `ae_status` gives the open project's path (a marker if never saved: copy it exactly), the dirty flag, the active
   comp, selected layers and the quarantine list. `detail: true` adds the Project panel selection, the
   time, selected properties and warnings. Selection can change between this read and your write, so
   act on explicit ids and indexes, not on "the selected layer".
3. Read what you will touch: `ae_comp_tree`, `ae_find_layers`, `ae_get_comp`, `ae_get_layer_props`
   (`meta: true` for what a property accepts), `ae_get_keyframes`. Read tools change nothing, not even
   time or selection.
4. After your first write, `ae_session_changes` (or the `user_changed` line on each later write result)
   tells you what the user changed since your last write: another project open, items added or
   removed, layers added or edited, selection or work area changed, a restart. If it says anything
   changed, re-read before writing. `rebase: true` moves its baseline to now. Before your first write
   there is no baseline.
5. Every write names its target: `expect: { project_path, comp_id? }`, copied from `ae_status`. If AE
   has something else open, the write is refused with `kind: "guard"` and nothing changes. A guard
   failure means stop and re-read, never retry with the same expectations.

## 2. Checkpoints and undo

- **Automatic.** Before each write the server copies the saved `.aep` to
  `<projectdir>/_mcp_checkpoints/<name>_<stamp>_auto-<tool>.aep` and puts it in the result as
  `checkpoint`. It is the last save. If the user has unsaved work, `checkpoint.unsaved_changes_not_included`
  is true and the copy lacks it. Writes between two saves share one copy. Unsaved projects and files
  over 250 MB are skipped (`ae_auto_checkpoint { enabled?, max_mb? }`; change it only if the user asks).
- **Manual.** `ae_checkpoint_create { expect, label? }` before something large. `ae_checkpoint_list
  { expect }` lists them.
- **Receipts.** Each write returns a `receipt` read back in a separate call: what differs before and
  after. A mismatch in it means the write did not do what you meant. `ae_comp_fingerprint { comp_id }`
  (returns an `id`) then `ae_comp_diff { before_id }` show every changed property for a stretch of work.
- **One undo step per call.** The user's Ctrl+Z (Cmd+Z on macOS) takes back a whole tool call. Saves,
  project open and close, renders and font replacement have no undo step.
- **Prefer the checkpoint to asking the user to press Ctrl+Z.** AE exposes no undo history, so
  `ae_session_changes` can only say an undo step is "not_reachable" (provably gone) or "possibly_reachable".
- `ae_checkpoint_revert { expect, checkpoint_path, discard_changes? }` opens the checkpoint file itself.
  It refuses when the project has unsaved changes unless `discard_changes: true`: that throws the user's
  work away, so ask first. Saving afterwards overwrites that checkpoint; make a new one if you need it.

## 3. Write outcomes

Every write result has `ok` and, for writes, `outcome`:

| `outcome` | Meaning | What you do |
|---|---|---|
| `applied` | It ran and was read back. | Check `receipt`. Tell the user in a line. |
| `no_op` | It ran and changed nothing (already the way you asked). | Do not repeat it. |
| `partial` | Part of a batch applied (`ae_batch_set`: earlier ops or chunks applied, a later one failed; see `done` and `failed_chunk`). | Do not rerun the whole batch. Re-read state and send only what is left. |
| `not_applied` | Refused before anything changed: invalid arguments, a failed guard, quarantine, a busy or queued refusal. | Fix the cause (the message names it), then call again. |
| `unknown` | The call timed out or failed after sending. Part of it may be in the project. | Never resend. Read state, then decide. |

`next_steps` in a result is a list of what to do next (for `unknown`: read the state with `ae_comp_diff`
or the read tools, one Ctrl+Z removes the call's undo group, the checkpoint holds the project as it
was). Follow it.

**The quarantine.** A write that times out is quarantined and every other write is refused (`kind:
"quarantined"`) until it is cleared. Reads still work. To clear it: `ae_status` (lists it), inspect the
project with read tools, then `ae_acknowledge { op_id, note }` where `note` says what you found. A write
that was in flight when AE or the panel service went down is quarantined the same way and shown by
`ae_session_changes`. Nothing is retried automatically. `ae_recent_ops` lists the last 200 writes with
their outcomes, so after a lost reply you can see whether one ran.

## 4. Idempotency keys

Give every write a fresh `idempotency_key` (a string up to 128 characters, such as `"dim-bg-comp7-v1"`).
Every tool that takes `expect` or checkpoints has it, ae_run_jsx and ae_skill_run included.

- Same key, same arguments, same client and same project: the second call returns the first answer with
  `idempotent_replay: true` and `first_called_at`, and does not run again. If the first is still running,
  the second waits for it.
- Same key with different arguments: refused with `code: "idempotency_key_reused"`, `outcome:
  "not_applied"`. Use a new key for a new write.
- A result that changed nothing (`not_applied`, a guard, queued or quarantine refusal, invalid
  arguments) is not kept, so sending it again after fixing the cause runs it. Anything else is kept,
  an `unknown` result included: resending it gets the same `unknown` back. That is deliberate.
- Keys are scoped to the tool, the client and `expect.project_path`; at most 200 are kept, for one hour.
- Name keys after what the write does. A reused name in another project is a new write.

## 5. Busy, queued and Stop

- **One writer.** The server runs one operation at a time, reads and writes alike, in order. A call
  that waits more than 600 s is dropped with `kind: "queued"` and nothing ran. Wait for your own call
  to finish before sending the next.
- **Busy.** If a popup, someone else's script or a manual render has held AE for 15 s or more, calls
  are refused at once with `kind: "queued"` and `actual.busy` (`cause`: `rendering`, `dialog_open`,
  `script_running` or `unknown`; the popups; `next_steps`). Nothing was sent. Read the popups with
  `ae_dialogs`, tell the user what holds AE, and call `ae_status` (it answers at once, with `busy`) after
  about 30 s. Never retry in a loop.
- **Timeouts.** A call waits 120 s for AE. On timeout the call is not cancelled: it may still be running
  or may have finished. A timed-out write is `unknown` and quarantined (section 3). Later calls are
  refused as busy until AE finishes it.
- **Stop.** The panel has a Start/Stop button at the top. While the user has stopped it, every call is
  refused before it reaches AE, with `kind: "queued"` and a message that starts "The user stopped the MCP
  in After Effects". Calls waiting in the queue are refused too; the one already running finishes.
  Tell the user in one line, stop calling tools, and wait until they say they have pressed Start. Do not
  retry. Reads are refused as well, so verify state after Start, before any resend of a write.

## 6. Popups

AE shows modal popups (missing fonts, overwrite warnings, "file not found"). They block its scripting
thread. Popups are never suppressed.

- **The watcher.** The panel service watches for them. A popup raised by your own call with one OK-like
  button is pressed at once, because your call would wait on it. Progress windows (Cancel or Stop only)
  are left alone. Any other popup is put to the user in the panel ("After Effects asks", with a
  screenshot and its buttons), and in the client too when the client takes questions (section 7).
- **Reports.** What happened is added once to your next tool result as `popups`: `pressed_for_you`,
  `answered_by_user`, `closed_in_after_effects` or `open` (with `handle`, `buttons`, and buttons marked
  `only_in_after_effects` that the user must click). Tell the user in a line what each popup said and
  what was pressed. For a missing font offer `ae_fonts` with `check_files`; for missing files,
  `ae_collect_relink`.
- **`ae_dialogs`** lists open popups (read-only): `handle`, `title`, `text`, `buttons`, `screenshot`,
  `caused_by_op`, `kind` (`info`, `question`, `destructive`; advisory). Look at the screenshot when
  unsure. Call it when a call timed out or came back busy.
- **`ae_dialog_respond { handle, button, reason, check?, allow_destructive?, user_instruction? }`.**
  `reason` is always required: say why you answer and why that button.
  - `caused_by_op` null (the popup is not from your own running call): refused (`refused_not_caused_by_our_op`)
    unless `user_instruction` quotes the user's words.
  - A destructive button (Save, Don't Save, Replace, Delete, Overwrite, Discard, Remove, Revert) needs
    both `allow_destructive: true` and a `user_instruction` quoting the user (`refused_destructive_button`).
    OK or Yes on a popup whose text is about replacing, overwriting, deleting or losing something needs
    the same (`refused_destructive_dialog`).
  - On a popup AE paints itself, only Cancel, No or Close (sent as Escape) and the default OK, Yes or
    Continue (sent as Enter) can be pressed. Other buttons return `button_not_default` or
    `button_not_answerable`: ask the user to click them. `dialog_changed` and `dialog_gone` mean read again.
  - If `closed` is false, nothing else is tried; ask the user.
  - Every answer is logged. Tell the user what you dismissed and what it said.

## 7. Asking the user

- `ae_plan` says up front which choices are the user's. Ask when a choice changes the look, the timing
  or the files (which variant, which easing, where to save), not for routine ones.
- `ae_ask_user { question, options (2 to 8, each id and label), kind?, multi_select?, allow_other?,
  context?, wait_seconds? }` asks in the Chroma AE MCP panel and waits (default 120 s, at most 600). Show
  rather than describe: give each option an `image_path` (a PNG or JPEG from `ae_snapshot_frame`), or
  `kind: "ease"` with a `curve` per option. Results: `answered`, `dismissed`, or `waiting` with an
  `ask_id`. For `waiting`, call again with `{ ask_id }` to keep waiting; the question stays in the panel.
  If dismissed, go on with a sensible default and say which. Ask one thing at a time.
- If the client declared the `elicitation` capability at `initialize` (MCP revisions up to 2025-06-18),
  a plain single choice with no pictures is asked in the client's own prompt (`via: "elicitation"`).
  A client on MCP 2026-07-28 is never asked in its own prompt (that revision has no server-to-client
  requests), and ease curves, several answers and pictures are always asked in the panel. Do not
  assume the user sees it in the chat: say in the chat that you have asked in the After Effects panel.

## 8. Long renders

- **Do not block on a render.** Both render tools return at once with a job id. Poll the status tool;
  `wait_seconds` (0 to 30) waits for a change, so one call replaces several polls. The status tools never
  touch AE.
- **Prefer `ae_aerender_start`** (a separate background process; AE stays free). It needs a saved,
  non-dirty project, so ask the user to save first. One aerender job runs at a time and a new one starts
  at least 20 s after the last. Follow it with `ae_aerender_status { wait_seconds }`.
- **`ae_render_queue_render`** is AE's own render. Tell the user first: AE is locked for the whole render,
  the user cannot work in it and cannot reach Stop (measured). It is for when aerender cannot be used, or
  for a project that is unsaved or has unsaved changes (it renders it as it is now); on a dirty project
  ask the user to save first all the same, because the render cannot be stopped. Keep these renders short. While it runs, every tool that needs AE is refused
  at once with `kind: "queued"`. `ae_render_queue_render_status`, `ae_dialogs`, `ae_dialog_respond` and
  `ae_status` still answer. If the lock does not clear after AE stops rendering, restarting AE clears it,
  or the user presses "Clear render lock" in the panel. Never ask the user to press Render themselves.
  Media Encoder only with `engine: "media_encoder"` and `user_confirmed: true`, after asking.
- **An existing output file** is refused unless `overwrite: true`. After Effects then asks to overwrite,
  and answering OK is destructive: it needs the user's instruction.
- **Check the output** with `ae_verify_render` on one real file or frame once the job ends.
- **The AE 26.3 render hang** (`render_hang_env_light`). On AE 26.3, an Advanced 3D comp whose environment
  light takes its image from a layer, with another 3D layer, never finishes rendering. `ae_snapshot_frame`
  and the frame tools built on it refuse it before anything renders, and `ae_plan` lists it as a hazard.
  Tell the user: to render a frame, clear that light's Source (Light Options) or switch the light off for
  the check. The comp was not changed; do not change it for them. If a frame was never written
  (`frame_not_written`), frame renders are refused (`frame_render_pending`) until it appears or AE is
  restarted: tell the user to save (`ae_save`) and restart After Effects.

## 9. Saving

Save only when the user asks, or when a tool needs a saved project and you have asked them. A save
overwrites their file, and it changes what the next checkpoint captures.

- `ae_save { expect, backup?, save_as?, increment? }`. By default it first copies the file on disk to
  `<projectdir>/_mcp_backups/<name>_<stamp>.aep`. `save_as: { path, overwrite? }` is the only way to
  save an untitled project; it points the open project at the new file and leaves the old file and its
  checkpoints where they were. `increment: true` saves as the next free `_vNNN` and never overwrites.
- Never call `project.save()` in a script (the safety lint refuses it), and do not save to "make a
  checkpoint". Use `ae_checkpoint_create`.

## Short rules

1. Look, then write. Name the target in `expect`.
2. One write at a time; wait for it.
3. Give every write an `idempotency_key`.
4. On `unknown`, a timeout or a quarantine: read, never resend.
5. On busy, queued or Stop: tell the user, wait, do not loop.
6. On a popup: read it, tell the user what it said, answer only under the dialog rules.
7. Tell the user what you changed in a line. Mention the checkpoint when it matters.
