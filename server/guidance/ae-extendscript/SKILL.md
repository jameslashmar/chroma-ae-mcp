---
name: ae-extendscript
description: "How to write ExtendScript that the chroma-ae MCP will accept and run safely in After Effects: code for ae_run_jsx and for saved skills run by ae_skill_run. Covers ES3 syntax limits (no let, const, arrow functions, template strings, class, for...of, chained ternaries; no native JSON), how the code is wrapped and what it returns, the mutates and expect parameters, undo groups, read-back after a write, stale frames from saveFrameToPng, app.executeCommand, timeouts, the safety lint (what it refuses and which tool to use instead) and when to use a dedicated tool instead. Load before calling ae_run_jsx or ae_skill_save, when a script is refused as not ES3 or by the safety lint, when ExtendScript misbehaves silently, or when asked to script After Effects, run JSX or automate something no dedicated tool covers."
metadata:
  version: "1.0.0"
---

# ExtendScript for ae_run_jsx

`ae_run_jsx` runs your code inside After Effects. Use it only when no dedicated tool does the job.
The same rules apply to the steps of a saved skill (`ae_skill_save`, `ae_skill_run`): they get the
same ES3 check and the same safety lint. Each step is also a function body. It sees `args` (the run's
arguments), `prev` (what the previous step returned) and `results`; all steps run in one evalScript,
so a writing skill is one undo step. Write steps that take what varies from `args`.

## Find a dedicated tool first

A dedicated tool validates its input, takes a checkpoint, reads the result back and returns a
receipt. Your script gets the same checkpoint and receipt when `mutates: true`, but nothing checks
what the code does.

- The server lists 34 everyday tools by default (the core toolset) plus `ae_search_tools`,
  `ae_get_tool_schema` and `ae_invoke_tool`. The rest (about 150 more) are reached through those.
- `ae_search_tools { query }` finds the rest (keywords, or `pattern` for a name fragment such as
  `^ae_track`). `ae_get_tool_schema { name }` gives the full schema. `ae_invoke_tool { name, arguments }`
  runs any tool; put its arguments under `arguments`.
- Search and schema calls never touch After Effects, so they answer even while AE is busy.
- HTTP clients can ask for every tool in the list with the header `X-Chroma-Toolset: full`. The
  stdio relay does the same with `CHROMA_AE_MCP_TOOLSET=full`. Core is the default for everyone.
- Core tools you will want before reaching for a script: `ae_status`, `ae_get_project`, `ae_get_comp`,
  `ae_comp_tree`, `ae_find_layers`, `ae_get_layer_props` (`meta: true` shows what a property accepts),
  `ae_get_keyframes`, `ae_set_property`, `ae_batch_set`, `ae_set_text`, `ae_create_layer`,
  `ae_create_comp`, `ae_layer_ops` (parent, reorder, duplicate, delete, trim, rename), `ae_add_effect`,
  `ae_set_effect`, `ae_import_footage`, `ae_save`, `ae_snapshot_frame`.
- Check `ae_skill_list` (reached through `ae_search_tools`) too: the user may already have a saved
  skill for the job.

## The tool

`ae_run_jsx { code, mutates, label, expect? }`. It also takes `idempotency_key`, as every write tool does
(a resend with the same key and arguments returns the first answer instead of running again).

| Field | Rule |
|---|---|
| `code` | The body of a function. Write `return <value>` to send a result. Do not write `function () {}` around it. |
| `mutates` | Required, no default. `true` if the script changes anything in the project. |
| `label` | Required. Names the undo step in AE and the entry in the panel log. |
| `expect` | Required when `mutates` is true: `{ project_path, comp_id? }`. Copy `project_path` exactly from `ae_status` (it has a marker in place of a path for a project never saved; pass that unchanged). If AE has something else open the call is refused with `kind: "guard"` and nothing runs. |

The server wraps `code` as `(function(){ <code> \n})()` evaluated in the panel's scope, so a
`return` works and line numbers in errors match your `code`. Variables you declare with `var` stay
inside; an undeclared name becomes a global and leaks into the next call. Always declare with `var`.

## Return values

There is no native `JSON` in ExtendScript, so do not call `JSON.stringify`. Return plain data and the
host converts it:

- Numbers, strings, booleans, arrays and plain objects (`{ a: 1 }`) come back as they are.
- An After Effects object (a layer, a property, a comp) comes back as a short tag such as
  `[Layer "Title" #12]`, not its contents. Copy out the fields you need.
- No `return`, or `return null`: the result is `{ returned: null, note: ... }`. That is not a failure.
  Anything the script changed is applied. Read state back; do not run it again.
- Output is bounded: lists at 500 entries (the result then says `truncated: true`), strings at 20,000
  characters. Return less.
- If you need a string of JSON, `__chromaAe.stringify(value)` exists in the host (it is the panel's
  own serialiser). Prefer returning the object.
- Read-only result: `{ op_id, result }`. Mutating result: `{ op_id, applied: true, result, checkpoint,
  receipt, user_changed? }`. Keep the `op_id`: `ae_skill_save { from_op_ids }` can turn a script that
  worked into a reusable skill (only if the user asks).

## ES3 only

ExtendScript is ECMAScript 3. The server checks the syntax it can see before After Effects is called
and refuses the call, with the line number, for `let`, `const`, `class`, arrow functions, template
strings, `for...of` and chained ternaries. Nothing runs. The other rules below are not checked: break
them and the script fails inside After Effects, or quietly does the wrong thing.

- Use `var` and `function`. No `let`, `const`, `class`, arrow functions (`=>`), template strings
  (backticks) or `for (x of y)`.
- No `forEach`, `map`, `filter`, `reduce` or `Array.prototype.indexOf`. The host does not polyfill
  them (`core.jsx` has none). Write a `for` loop with an index. (`String.prototype.indexOf` is ES3
  and fine.)
- **No chained ternaries.** `a ? b : c ? d : e` parses as `(a ? b : c) ? d : e`, so the logic is
  silently wrong. The server refuses it. Use `if / else`.
- Do not use ES3 reserved words (`default`, `delete`, `class`, `enum`, `export` and the like) as
  variable names or unquoted object keys. Quote the key: `{ "default": 1 }`.
- Precaution, not measured: keep the code ASCII (use `\u00e9`-style escapes in strings).
- `property(name)` returns `null` for a missing property rather than throwing. Test for `null`.
- Do not hold a `Property` across `addProperty`, `remove()` or `moveTo`. References to siblings go
  stale ("Object is invalid"). Look the property up again by index or match name after each of those.
- Effect parameters: address by match name. Section headers share names with parameters, so
  `property("Transform")` on an effect can return the header, not a value.
- A 2D layer still has three-dimensional Position, Scale and Anchor Point. Setting Scale to
  `[100, 75]` reads back as `[100, 75, 100]`. Compare only the dimensions you set.
- Do not run long synchronous loops. They freeze After Effects' UI. The default wait for one call is
  120 seconds, and `ae_run_jsx` has no parameter to extend it.

## Undo, read-back and receipts

- **One undo group per call, opened and closed by the server** (`withUndo`). Do not call
  `app.beginUndoGroup` or `app.endUndoGroup` yourself. A group begun in one call and ended in another
  is discarded by AE. One Ctrl+Z in AE removes the whole call.
- **Do not verify in the same script that wrote.** A read in the same evalScript as the write returns
  stale cached values. With `mutates: true` the server reads before and after in separate calls and
  returns `receipt` (what differs). For your own checks, make a second `ae_run_jsx` call with
  `mutates: false`, or use `ae_get_layer_props`.
- **Before a mutating call**, with automatic checkpoints on (the default, for project files up to
  250 MB; `ae_auto_checkpoint` changes it), the server copies the saved `.aep` to
  `<projectdir>/_mcp_checkpoints/` (the last save, not unsaved work:
  `checkpoint.unsaved_changes_not_included` says so). `checkpoint` in the result says whether it was
  made or skipped, and why.
- A script that throws part-way has already run its earlier statements inside the undo group. A
  mutating failure normally reports `outcome: "unknown"`; read the state, then decide. Do not resend.
- Not everything has an undo step: saves, project open and close, renders and font replacement do not.

## Things that do not work through CEP

- `app.executeCommand` does nothing for most commands, silently. Use the DOM: `comp.duplicate()`,
  `layer.duplicate()`, `layer.remove()`. (Window-menu commands were measured to toggle panels on
  AE 26.0, but they toggle, so check the state first. Do not rely on it for anything else.)
- `saveFrameToPng` writes asynchronously and can report success with a cached frame from an earlier
  render. Do not call it in `ae_run_jsx` and read the file at once. Use `ae_snapshot_frame`: the server
  waits for the PNG to be non-empty and stable, checks its modified time is newer than the request,
  retries a stale one once with a +0.001 s nudge, and reports `stale_frame` if still stale. If you must
  render in your own code, check the file is non-empty and newer than your request and retry once.
- Custom-data effect parameters (such as Colorama's Output Cycle) cannot be read or set by script.

## Never abort, never loop

- Do not give up on a slow `ae_run_jsx` and send it again. The server never aborts an evalScript,
  because that wedges the ExtendScript bridge until AE restarts. Calls queue and wait.
- If the 120 s limit passes, the call returns `kind: "timeout"`. For a mutating call: `outcome:
  "unknown"`, the op is quarantined, and every other write is refused until you inspect the state with
  read tools and call `ae_acknowledge { op_id, note }`. The script may still be running in AE.
- If AE is busy (a popup, someone else's script, a render) a call is refused at once with
  `kind: "queued"` and `actual.busy`, before anything is sent. Read the popups with `ae_dialogs`,
  call `ae_status` (it answers at once), and wait about 30 s. Do not retry in a loop.
- Calls wait their turn in one queue (reads and writes alike) for up to 600 s, then are dropped with
  `kind: "queued"`: nothing ran.

## The safety lint

Before ES3 is checked, a static lint reads the code (with comments, strings and regex literals blanked,
so `"alert"` in a string does not trigger it). A hit refuses the whole call, nothing runs, and the
message names the line, the member and the tool to use instead.

| Refused | Use instead |
|---|---|
| `system.callSystem`, `File.execute`, sockets, `.queueInAME` | nothing: no outside programs |
| `$.evalFile`, `#include`, `//@include` | `ae_skill_run` (a saved skill's steps) |
| `$.sleep` | nothing: it blocks the bridge |
| `alert`, `confirm`, `prompt`, `Window.alert` / `confirm` / `prompt`, `File.openDialog`, `saveDialog`, `Folder.selectDialog`, `.openDlg`, `.saveDlg`, `.selectDlg`, `.saveWithDialog`, `.importFileWithDialog` | `ae_ask_user` (questions), `ae_import_footage` (import) |
| `ScriptUI`, `new Window` | nothing: no windows inside After Effects |
| `app.beginSuppressDialogs` | `ae_dialogs`. Popups are read and answered, never hidden. |
| `app.quit`, `app.restart`, `app.scheduleTask`, `app.watchFolder`, `app.exitAfterLaunchAndEval`, `deletePref` | nothing |
| `app.newProject`, `app.open`, `app.openFast`, `project.close` | `ae_project_session` |
| `project.save()` (also via a variable holding `app.project`) | `ae_save` (`save_as: { path }` for another file) |
| `renderQueue.render`, `pauseRendering`, `stopRendering`, `.onStatusChanged` | `ae_render_queue_render` or `ae_aerender_start` |
| `app.purge` | `ae_memory_purge` |
| `File` or `Folder` `remove`, `rename`, `copy`, `create`, `write`, `writeln`, or `open` for writing (also `item.file.remove()`) | nothing: tools write their own files |
| Team Project methods | nothing |

- With `mutates: false` it also refuses writes: `setValue`, `setValueAtTime`, `addProperty`, `addKey`,
  `removeKey`, `remove`, `duplicate`, `moveTo`, `layers.add`, `items.add`, `addSolid`, `addText`,
  `addComp`, `applyPreset`, `replaceSource`, `importFile` and similar. Set `mutates: true` and `expect`.
- `File.open` with a literal `"r"` mode (or no argument) is allowed, for reading. A mode that is not a
  string literal is refused because it cannot be checked.
- **It is a guard rail, not a sandbox.** `eval()` of a built string, `obj["callSystem"]`, aliasing a
  method (`var f = system.callSystem`) and files reached through a chain it cannot follow all get past
  it. Do not try. You remain responsible for what the code does, and the user's rules (no outside
  programs, no files written, no dialogs, no suppressed popups) apply whether or not the lint sees it.
- Do not edit the code to dodge a refusal. If the lint names a tool, use the tool. If it says "nothing",
  tell the user that this MCP does not do it.

## Examples

A read. It changes nothing, so `mutates` is false and `expect` is not needed.

```
ae_run_jsx {
  "label": "Count layers per comp",
  "mutates": false,
  "code": "var out = [];\nfor (var i = 1; i <= app.project.numItems; i++) {\n  var it = app.project.item(i);\n  if (it instanceof CompItem) out.push({ id: it.id, name: it.name, layers: it.numLayers });\n}\nreturn out;"
}
```

A guarded write. `project_path` comes from `ae_status`; `comp_id` makes the receipt cover that comp.

```
ae_run_jsx {
  "label": "Dim background layers to 40%",
  "mutates": true,
  "expect": { "project_path": "D:/jobs/promo/promo.aep", "comp_id": 7 },
  "idempotency_key": "dim-bg-comp7-v1",
  "code": "var comp = app.project.itemByID(7);\nif (!comp || !(comp instanceof CompItem)) { throw new Error('comp 7 not found'); }\nvar changed = 0;\nfor (var i = 1; i <= comp.numLayers; i++) {\n  var layer = comp.layer(i);\n  if (layer.name.indexOf('BG') === 0) {\n    layer.property('Transform').property('Opacity').setValue(40);\n    changed++;\n  }\n}\nreturn { changed: changed };"
}
```

Then, in a separate call, read back what you care about (`ae_get_layer_props`, or a second
`ae_run_jsx` with `mutates: false`). The `receipt` in the write result already lists what differs.

## Checklist before sending

1. Is there a dedicated tool? (`ae_search_tools`.)
2. `var` and `function` only, loops not iterators, `if / else` not chained ternaries.
3. `return` the data you need, as plain objects.
4. `mutates: true` plus `expect` if anything changes; a `label` the user will recognise in Edit > Undo.
5. No undo group, no dialog, no file, no save, no render call in the code.
6. One short call. Verify in a second call. Never resend after a timeout or an `unknown` outcome.
