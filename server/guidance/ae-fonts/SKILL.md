---
name: ae-fonts
description: "Find, check and replace fonts in After Effects with the chroma-ae MCP (ae_fonts), and deal with the font warnings. Load for: missing font, font substitution, substituted font, replace font, swap a font project-wide, which fonts does this project use, is this font installed, does the font have the glyphs (Turkish, Cyrillic, Arabic), Unknown BIB Error, cannot access font, ATM Parse Error, CoolType, Adobe Fonts not syncing, duplicate or damaged fonts, a popup that blocks scripts after a font change, ae_busy with a font popup."
metadata:
  version: "1.0.0"
---

# Fonts in After Effects

Everything here is done with the `ae_fonts` tool, plus `ae_dialogs` and `ae_dialog_respond` for the
font warnings. Fonts are a project read first, a write last: find out what the project uses, check
what is installed, then change.

## Reaching the tools

`ae_dialogs` and `ae_dialog_respond` are core tools: always listed. `ae_fonts` is **not** core. It sits
in the `text` group, so on the default (core) toolset reach it through the three meta-tools:

- `ae_search_tools { query: "fonts" }` (or `group: "text"`) to find it.
- `ae_get_tool_schema { name: "ae_fonts" }` for the full schema and safety text. Read it before first use.
- `ae_invoke_tool { name: "ae_fonts", arguments: { ... } }` to call it. Everything below goes under `arguments`.

If the full list is loaded (HTTP header `X-Chroma-Toolset: full`, or `CHROMA_AE_MCP_TOOLSET=full` for
the relay) call `ae_fonts` directly. `ae_search_tools` and `ae_get_tool_schema` never touch After
Effects, so they work even while AE is blocked by a popup. `ae_invoke_tool` does not: it is refused
while AE is rendering and answers "busy" while a popup holds AE.

Other tools used here: core `ae_status`, `ae_get_project`, `ae_save`, `ae_set_text`, `ae_find_layers`;
reached the same way as `ae_fonts`: `ae_auto_checkpoint`, `ae_checkpoint_revert` (group `safety`),
`ae_brief` (group `review`), `ae_collect_relink` (group `delivery`).

## ae_fonts actions

`action` is one of `in_use` (the default), `search`, `check`, `replace`, `check_files`. All except a
real `replace` are read-only. Needs AE 24 or later (`app.fonts`); `replace` needs 24.5; glyph checks
need 25.1. On an older AE the result says so (`available: false` with a `reason`) instead of failing.

### in_use: what the project uses

Parameters: `comp_id` (only that comp's text layers; default the whole project), `missing_only`
(true: list only fonts known to be missing or substituted).

Result: `fonts[]`, one per PostScript name, each with `font` (the PostScript name), `family`, `style`,
`location`, `missing` (true, false, or null when AE could not say), `uses` and `layers[]` (comp_id,
comp, layer_index, layer, and `key` for a keyframe of animated source text). Also `missing[]`,
`missing_known` (false when any font's state is unknown), `text_layers`, `partial`, `truncated` and
`skipped_layers` (text layers that could not be fully read, each counted once).

Check `missing_known` before saying "no fonts are missing". With `missing_only`, fonts whose state is
unknown are left out and counted in `unknown_state`, with a `note`: they may still be missing.

### search: what is installed

Parameters: `query` (matches PostScript, family, style or full name, or their native names; case,
spaces and dashes ignored), `family` (contains), `style` (contains, such as "bold"), `writing_script`
(roman, cyrillic, greek, arabic, hebrew, japanese, chinese_simplified, ...), `variable_only`,
`adobe_only`, `page` (from 1), `page_size` (default 25, at most 100).

Result: `fonts[]` with names, location, Adobe Fonts flag and variable axes; `total_matches`,
`has_more`, `scanned`, `scan_truncated`, `font_ids_session_only: true` (a `fontID` is valid for this
AE session only; never store it). The server walks the whole font list in short steps, up to a
minute. If `scan_truncated` is true a font that is not listed may still be installed: narrow the
search, or confirm one name with `check`. Do not conclude "not installed" from a truncated scan.

`writing_script` says what the font supports in general. Whether it has the letters of a given
string is a glyph question: use `check` with `text`.

### check: does this font exist, is it substituted, does it cover this text

Parameters: `fonts` (required, 1 to 50; each a PostScript name string such as `"Arial-BoldMT"`, or
`{ family, style }`), `text` (the real string to be shown, up to 20000 characters).

Result: `checked[]` per font with `exists`, `is_substitute`, `duplicates`, `candidates` (near matches
for a font that does not exist), `other_fonts_with_same_dict` where AE gives it, `variable` axes for a
variable font and, with `text`, `glyphs` (`supported`, `missing` characters, `suggested_default`:
AE's default font for the script of what is missing). Also `project_missing_or_substituted` (AE's own
list) and a `problems` count: fonts that do not exist, are substituted, or lack glyphs.

Always pass the real text when the font is for a language with special letters (for example a
Turkish caption). A font can exist and still draw boxes for some characters.

### replace: swap one font for another, project-wide

Parameters: `from` and `to` (both required; PostScript name or `{ family, style }`), `dry_run`
(default **true**), `no_font_locking` (default false), `expect` (required when `dry_run` is false:
`{ project_path, comp_id? }`, with `project_path` copied exactly from `ae_status`: the open .aep's
absolute path, or its marker for a project never saved).

`from` may be a font that is missing: the project's own used-font list is searched for it, not the
installed list. `to` must be installed and must not itself be substituted (`font_not_found` or
`font_substituted` otherwise).

Dry run (the default) changes nothing. It returns `from_used`, `affected_layers`, `uses`, `layers`
(where the old font is used), `glyphs` (layers whose text the new font cannot draw, with the missing
characters) and `notes`. If `from_used` is false there is nothing to replace.

Real run (`dry_run: false`, with `expect`):
1. It is **not undoable**: Ctrl+Z does not restore it. The server makes a checkpoint first and
   refuses (`error: "checkpoint_required"`) if none can be made, or if the project has unsaved
   changes, because a checkpoint copies the saved .aep. Run `ae_save`, and turn automatic
   checkpoints on with `ae_auto_checkpoint`, then try again.
2. It calls AE's `Project.replaceFont`, then reads the project's used fonts back and compares: the
   old font must be gone, the new one present and not substituted, and every place that used the old
   font must now use the new one. A failed check comes back as a mismatch on the result.
3. To undo, restore from the checkpoint with `ae_checkpoint_revert` (this loses edits made since).

`no_font_locking: true` stops AE locking glyphs, so missing glyphs can no longer be detected; leave
it off unless the user asks. In text with mixed fonts, only the ranges that used the old font change.
The check runs on the layer's whole text, so a mixed-font layer can list characters the replaced
range does not contain.

### check_files: are the font files themselves sound

No parameters. The host lists every installed font with its file path; the server then checks each
file on disk (about 2 s for 800 fonts). Result: `fonts`, `files`, `adobe_fonts`, `problem_fonts`,
`problem_counts`, `problems[]` (names, `location`, `problem`, `detail`; at most 200), `without_file`,
`scan_truncated`, `seconds` and a `note` with the fix steps.

`problem` is one of `no_location`, `missing` (file deleted, moved, or on a drive not connected),
`not_a_file`, `empty` (0 bytes), `unreadable`, `not_a_font` (a .ttf, .otf, .ttc or .otc file whose
first bytes are not a font header; not tested for Adobe Fonts files). Fonts with no file at all are
listed under `without_file` and are normal: named instances of a variable font and Windows bitmap
.fon fonts. They are not problems.

## Order of work

1. `in_use` (add `comp_id` to narrow it). Note `missing`, `missing_known`, `skipped_layers`.
2. `check` the fonts the brief or the user wants (`ae_brief` holds the brief's fonts), with `text`
   when the copy has special characters.
3. `search` for an installed stand-in when a font is missing: same family first, then by `style`,
   then by `writing_script`. Use `adobe_only` to see which fonts are Adobe Fonts.
4. `replace` with `dry_run` true. Read `affected_layers` and `glyphs`. Show the user a font that
   lacks glyphs for their text before going on.
5. `ae_save`, then `replace` with `dry_run: false` and `expect`.
6. Read back in a separate call: `in_use` again (or `ae_find_layers` and a snapshot for a visual
   check). Do not trust the write's own result as the only evidence.
7. `check_files` only when the BIB warnings appear (below), or before a delivery on a new machine.

Setting fonts on new text: `ae_set_text` (and caption tools) look the font up first on AE 24+ and
refuse an unknown or substituted font with near matches. Do not pass `allow_substitute: true` just to
get past that refusal: it writes a name AE will then replace with a fallback.

## How AE substitutes

When a project asks for a font that is not installed, AE keeps the font's name in the text but draws
with a fallback. `in_use` shows it as `missing: true`. A substituted `from` font can still be
replaced, because `replace` finds it by what the project uses. Match fonts by PostScript name
(`Arial-BoldMT`), not by display name: family and style names differ by language and foundry, and
`{ family, style }` is matched with case, spaces and dashes ignored, which can match more than one
file. If `check` reports `duplicates` above 0, two installed fonts answer to the same name: say so to
the user before choosing.

## Unknown BIB Error. cannot access font / ATM Parse Error

AE can open a popup, "Unknown BIB Error. cannot access font", or an "ATM Parse Error". They come from
CoolType, Adobe's font engine, and appear:
- at the first full font load in a session (the first time something reads the whole font list,
  for example a font search or a font scan), and
- again after any font is installed, removed or changed while AE is open.

The popup **names no font**. Known causes, none of which this server can see directly:
- the same font installed twice with different files (for example a per-user and a system copy);
- a font Windows cannot tell from its siblings: same family, weight and italic flags;
- a second copy of a font AE ships itself, such as Adobe Clean or Adobe Clean UX, installed by a
  font manager;
- damaged font files;
- Adobe Fonts activated while Creative Cloud is not running.

### What the server does with the popup

The popup blocks scripts: until it is answered, AE-touching tools wait, or fail with "After Effects
is busy: a popup is open ..." and tell you to read `ae_dialogs`. The panel's watcher also reads new
popups. A one-button OK popup raised by one of our own operations is pressed at once and reported on
the next tool result under `popups`; anything else is put to the user in the panel (and in the
client too, for a client on an older MCP revision that declared elicitation). Popups are never
suppressed.

What you do:
1. Do not retry in a loop. Call `ae_status` (it answers at once) and `ae_dialogs` (read-only).
2. If the popup was caused by your own operation (`caused_by_op`), answer OK with
   `ae_dialog_respond` using the handle from `ae_dialogs`. List it first; it is re-read before the
   key is pressed. Otherwise ask the user.
3. Tell the user what it said. It will come back, because the cause is still there.
4. Run `ae_fonts` action `check_files`. If AE shows the warning again while it runs, it is caused by
   that call (`caused_by_op` is set): the watcher usually presses OK itself; if it is still open,
   answer OK with `ae_dialog_respond` as in step 2.

### Diagnosis with what the tools can see

`check_files` finds **file** problems: missing, empty, unreadable or non-font files. It cannot see
duplicate installs, sibling fonts with identical family, weight and italic flags, a second copy of
an Adobe-bundled font, damage inside an otherwise valid file, or Adobe Fonts sync state. So:
- `problem_fonts` above 0: report each font by `postscript` and `location`, with its `problem` and
  the fix in `note`.
- `problem_fonts` 0: say that no file is broken (it does not clear the fonts), and move to what only
  the person can check. `note` says so too. Use `search` with `family` and `check` (`duplicates`,
  `other_fonts_with_same_dict`) to list candidates: two entries with the same family and style, or
  `location` in two folders. Names starting "Adobe Clean" in a user font folder are suspect.
- If `adobe_fonts` is above 0 and the warning appears at AE start, ask whether Creative Cloud was
  running.

### What needs the person

You cannot install or remove fonts, empty font caches, or restart AE; `ae_run_jsx` is linted against
file deletes and quitting. Ask the user to:
- remove or reinstall the fonts you listed (Windows: Settings, Personalization, Fonts; macOS: Font
  Book), and remove the duplicate or the second copy of an Adobe font;
- for an Adobe Fonts font, switch it off and on again in the Creative Cloud app, with Creative Cloud
  running;
- with AE closed, delete Adobe's font cache files (`AdobeFnt*.lst`; Windows: AE 2026 keeps its own
  under `%LOCALAPPDATA%\Temp\Adobe\After Effects\26.3\Typesupport` (the folder is named after the
  version), other Adobe apps use
  `%LOCALAPPDATA%\Adobe\TypeSupport` and the CT Font Cache folders under `%APPDATA%\Adobe`); AE
  rebuilds them on start. A stale cache is the least likely cause: try it after the font fixes;
- **restart AE** after any font change. Fonts changed while AE is open raise the warning again, and
  AE's list may be stale. After the restart, read again with `in_use` and `check`.

Save the project before asking for a restart (`ae_save`).

## Rules of thumb

- Never call a font "missing" from `search` alone, or from `in_use` while `missing_known` is false.
- Never run a real `replace` without a dry run first, a saved project and a checkpoint.
- Do not answer a popup you did not cause, or any popup whose OK talks of replacing, losing or
  erasing, without the user. `ae_dialog_respond` refuses it without `allow_destructive` and a
  `user_instruction`.
- Tell the user which fonts changed, how many layers, and what the glyph check said.
