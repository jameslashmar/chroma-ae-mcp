# chroma-ae-mcp

An MCP server that lets Claude Code drive **Adobe After Effects 2026** (AE 26.x, CEP 12) safely, alongside a person who is editing live. The MCP runs **inside After Effects**. It starts with AE, so there is no separate server to install or run.

This is an internal Chroma tool, not a consumer product.

> **Status: v0.2.0, released 2026-10-27** (signed ZXP on the [v0.2.0 release](https://github.com/jameslashmar/chroma-ae-mcp/releases/tag/v0.2.0)).
> - 34 tools, all live-tested on AE 26.0 (Windows).
> - The QA harness passes VoxMark scenarios 1–3.
> - CI (GitHub Actions) runs the build, 74 unit tests, the ExtendScript lint, and the in-panel MCP end to end on AE's own Node (17.7.2).
> - macOS should work, but it is untested, and reading popups is Windows-only for now.

---

## Install (users)

1. **Install the ZXP.** Download `chroma-ae-mcp-<version>.zxp` from the release and install it with the [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/) (or Anastasiy's). The certificate is self-signed ("Chroma AE MCP"), so expect a one-time warning.
2. **Start After Effects.** The MCP service starts by itself, invisibly, about 30 s after launch.
3. **Open Window > Extensions > Chroma AE MCP.** The status panel should show **READY**.
4. Click **Copy setup command**, paste it into a terminal and run it once. It looks like this:
   ```
   claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:7790/mcp --header "Authorization: Bearer <token>"
   ```
5. Restart Claude Code (or run `/mcp`), and the `ae_*` tools appear.

The token belongs to this machine and survives restarts. **Regenerate token** in the panel replaces it; after that, paste the setup command again.

No Node, npm or git is needed. The MCP runs on the Node that is built into AE's CEP.

## Develop (Chroma)

```powershell
cd server; npm install; npm run build; npm test; npm run bundle   # bundle -> panel/client/mcp-bundle.cjs
node scripts/lint-jsx.mjs                                         # ES3 + no chained ternaries in panel/host
pwsh scripts/install-dev.ps1                                      # junction panel/ into CEP extensions, PlayerDebugMode=1
node qa/smoke-mcp.mjs                                             # live: every tool against the running AE (about a minute)
```

- Restart AE after any manifest change.
- For code changes, reload the service: its CEP debugger is at `http://localhost:8097`, the panel's at `8096`.
- `npm run bundle` must be committed: CI checks that the bundle is up to date.
- **Never install the ZXP on a machine that has the dev junction.** An installer could delete through it into the repo. Run `install-dev.ps1 -Uninstall` first.

**Releasing:**
1. Bump `VERSION`.
2. Run `op-sa op run --env-file scripts/release.env -- pwsh -NoProfile -File scripts/package.ps1`. It stages, stamps the version, signs with ZXPSignCmd and verifies. The certificate passphrase is in 1Password: Release Signing / "Chroma AE MCP ZXP cert".
3. Tag `vX.Y.Z` on the build commit, then create the GitHub release with the `.zxp`.

---

## How it works

```
Claude Code ──HTTP /mcp (Bearer)──► london.chroma.aemcp.service   (hidden CEP extension, starts with AE)
                                      ├─ MCP endpoint (stateless JSON-RPC, no SDK: AE's Node 17 is too old for it)
                                      ├─ single-writer queue · guard · quarantine · receipts
                                      ├─ Node side: PNG decode, aerender jobs, UI Automation (popups, screenshots)
                                      └─ evalScript ──► host/core.jsx + host/ext/*.jsx (ExtendScript)
                                    london.chroma.aemcp.panel     (Window > Extensions: status, log, setup command)
```

**Why a thin guarded listener?** AE's ExtendScript DOM is complete, so `ae_run_jsx` can do almost anything. The typed tools exist where they add something `ae_run_jsx` cannot:
- verification (read-back, stale-frame checks, pixel checks);
- safety (guard, checkpoints, undo hygiene);
- a known AE trap, encoded once;
- large bounded reads.

## Safety model

- **Target guard.** Every write names the `project_path` (and `comp_id`) it expects. If AE has something else open, the write is refused before anything changes (`kind: "guard"`). A guard failure means stop and re-read the state, not retry.
- **One undo step per write.** The undo group begins and ends inside one evalScript, so one Ctrl+Z backs out a whole tool call.
- **Automatic checkpoints.** Before every write, the saved `.aep` is copied to `<projectdir>/_mcp_checkpoints/` (`..._auto-<tool>.aep`), so a write can be undone across sessions with `ae_checkpoint_revert`.
  - The copy is the last save: AE can't write its unsaved state to another file without retargeting the project. When AE has unsaved changes, the write's `checkpoint` says so.
  - Writes between two saves share one copy. Unsaved projects and projects over the size limit (250 MB by default) are skipped.
  - `ae_auto_checkpoint` turns it off or changes the limit.
- **Receipts.** Writes return a before/after comparison, read back in a *separate* evalScript, because AE returns stale values when a read follows a write in the same script. For a full picture, `ae_comp_fingerprint` and `ae_comp_diff` show every changed property and keyframe.
- **Quarantine.** A write that times out has an unknown outcome. It is quarantined, and further writes are blocked until someone inspects the state and calls `ae_acknowledge`. Nothing is retried automatically.
- **Never kills AE mid-script.** Aborting an evalScript wedges the ExtendScript bridge, so calls queue and wait.
- **Read tools change nothing,** not even a comp's resolution: that would land on the user's undo stack (measured).
- **Popups are never suppressed** (Jay's rule).
  - `ae_dialogs` reads AE's modal popups (title, text, buttons, screenshot) from outside AE's scripting thread.
  - A timeout names any popup that is blocking AE.
  - `ae_dialog_respond` answers only popups our own operation caused, and refuses Save, Don't Save, Replace, Delete or Discard without an explicit instruction from the user. Every answer is logged.
- **Locked-down bridge.**
  - It binds to localhost only.
  - Every request needs the Bearer token, which is stored in a folder only the current user can read.
  - Any request with an `Origin` header (from a browser) is rejected.
  - The `Host` header is checked strictly.

---

## Tools (38)

| Group | Tools |
|---|---|
| Status & control | `ae_status`, `ae_quarantine_status`, `ae_acknowledge` |
| Read | `ae_get_project`, `ae_get_comp`, `ae_get_layer_props`, `ae_get_layer_full`, `ae_find_layers`, `ae_list_effects`, `ae_validate_expressions` |
| Script | `ae_run_jsx` (read, or guarded write with a receipt) |
| Write | `ae_set_property` (value / keyframes / expression), `ae_set_keyframe_ease`, `ae_set_text`, `ae_import_footage`, `ae_replace_footage` |
| Receipts & safety | `ae_comp_fingerprint`, `ae_comp_diff`, `ae_checkpoint_create`, `ae_checkpoint_list`, `ae_checkpoint_revert`, `ae_auto_checkpoint` (settings for the copy taken before every write), `ae_save` (copies the .aep first; never save-as) |
| Frames | `ae_snapshot_frame` (AE renders at full resolution and the server shrinks the PNG to `scale` or `max_size`; waits for the PNG, which AE writes asynchronously), `ae_compare_frames` (pixel diff; flags blank, black or transparent frames) |
| Motion | `ae_contact_sheet` (up to 24 frames tiled into one labelled PNG), `ae_motion_graph` (value and speed graph of one property, with the easing per keyframe pair and any overshoot), `ae_motion_review` (reviews a comp's animation like an animator would: linear moves, dead starts and stops, speed jolts, overshoot, keys between frames; most findings come with a ready `ae_set_keyframe_ease` easy-ease fix) |
| Render | `ae_render_queue_add`, `ae_render_queue_status`, `ae_aerender_start`, `ae_aerender_status`, `ae_aerender_cancel` (background; success is judged from the log as well as the exit code) |
| Popups | `ae_dialogs`, `ae_dialog_respond` |
| UI | `ae_list_panels`, `ae_open_panel`, `ae_ui_screenshot` |

Each tool's schema and description, as the agent sees them, live in `server/src/tools/`.

**Panels.**
- CEP extensions open directly.
- AE's native Window-menu panels open through `app.executeCommand`, which does work through CEP (measured). Those commands **toggle**, though, so `ae_open_panel` refuses a native panel unless `allow_toggle` is set after checking with `ae_ui_screenshot`.

---

## QA harness

`qa/` runs a product's real ExtendScript in a real AE against throwaway projects. It is used for **VoxMark** and **Gulp**.

```
node qa/runner.js qa/scenarios/voxmark      # report: qa/out/report.md + junit.xml
```

- It refuses to start unless AE has an empty unsaved project open, or a QA project (marked with a `__chroma_qa__` folder, or saved under `/_work/qa`). It never touches real work.
- It loads product JSX the way the product does: raw source through evalScript, `hostscript.jsx` first.
- Assertions read AE state in separate calls.
- Plan and the next scenarios: `docs/QA-HARNESS.md`.

## Troubleshooting

- **Tools fail with `unreachable`:**
  - Is AE running? Is the service up? The status panel shows READY, and `curl -H "Authorization: Bearer <token>" http://127.0.0.1:7790/health` answers.
  - The service starts about 30 s after AE launches.
- **401 errors:** the token was regenerated. Paste the panel's setup command again.
- **Port 7790 is busy:** the service retries every 5 s and never starts a second server. Check that an old AE instance isn't still running.
- **A call times out:** read the message. It names any popup blocking AE. Answer the popup in AE, or with `ae_dialog_respond` under the rules above, then check the state and `ae_acknowledge` the op.
- **Windows Firewall prompt when rendering:** `aerender` starts a background AE. Renders don't need network access, so cancelling the prompt is fine.
- **The ZXP installer says it can't parse the package:** `ExtensionManifest Version` must be the manifest *schema* version (7.0), not the CEP version (12.0).
- **Blank panel or JavaScript errors:** open `http://localhost:8097` (service) or `8096` (panel) in Chrome or Edge.

## Roadmap

Priorities and reasons are in `docs/FEATURES.md`. The items marked "Atom" come from the review in `docs/ATOM-REVIEW.md`.

- [x] **P1: automatic checkpoints around every write** (Atom). Done: the saved .aep is copied before each write, with `ae_auto_checkpoint` to turn it off or cap the size, and `ae_checkpoint_revert` opens a copy without overwriting anything. There is no "after" copy: the file on disk only changes when the user saves.
- [ ] **P2: AE skills bundle** (Atom). `SKILL.md` plus numbered `1.jsx`, `2.jsx`, per project or global, with `ae_skill_run` and `ae_skill_save` (capture a working `ae_run_jsx`). For house rigs, lower thirds and kinetic type.
- [ ] **P2: one-click registration** (Atom). The panel runs `claude mcp add` itself, with toggles for Codex and Cursor.
- [ ] **P2: asset staging plus auto-import** (Atom). Generated assets (Flora, Higgsfield, ElevenLabs) land in a known folder and are imported into an `_Assets` bin.
- [ ] **P2: social reframe** to 16:9, 1:1 and 9:16, re-anchoring controllers and applying safe areas (Atom).
- [ ] **P2: data-driven builds from CSV/JSON**, for charts and localisation (Atom).
- [ ] **P3: diagnostics bundle**: logs, quarantine state, AE version and popups in one file (Atom).
- [ ] **QA:** VoxMark scenarios 4–5 (they need generated WAV fixtures), then Gulp scenarios 1–5. Gulp 5 measures whether `app.executeCommand` works from CEP for AEGP commands.
- [ ] **macOS popup reading** for `ae_dialogs`, through AppleScript System Events (needs accessibility permission). Windows-only today.
- [ ] **A self-hosted CI runner** on a machine with AE, so the QA scenarios run on every push.

## Docs

- `SPEC.md`: the original design.
- `docs/V02-PANEL-MCP.md`: the MCP inside the panel.
- `docs/FEATURES.md`: the full feature list, the gaps, and what to borrow.
- `docs/QA-HARNESS.md`: the QA harness plan.
- `docs/BUILDERS.md`: the rules for adding tool groups. These include measured AE 26 behaviour; read them before writing code.

## Credits

Ideas and small pieces are borrowed (MIT) from [Engine-Room-Games/after-effects-mcp](https://github.com/Engine-Room-Games/after-effects-mcp) and [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp). See `ATTRIBUTION.md`.
